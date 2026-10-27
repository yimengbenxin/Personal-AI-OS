// Run in the Node 24 gateway image with the data volume mounted :ro and `nice -n 10 node ...`.
import {readFile} from 'node:fs/promises';
import {getPriority,setPriority} from 'node:os';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage,type StoragePort} from '../src/storage.ts';
import {check,ContractError,type ArchivedEvent} from '../src/contracts.ts';
import type {StreamManifest} from '../src/stream-archive.ts';
import {mappedRange} from '../src/media/align.ts';
import {createSourceMediaClock} from '../../../phase0/gateway/src/source-media-clock.ts';
import {LocalSpeechEngine,parseLocalSpeechConfig,type SpeechVadStream} from '../src/voiceprint/engine.ts';
import {VoiceprintRegistry,configuredScoring,speakerModelIdentity,type SpeakerModel} from '../src/voiceprint/registry.ts';
import {loadRegistryCipher} from '../src/voiceprint/cipher.ts';
import {embedSpeech,type SpeakerIdentifier,type SpeakerIdentity} from '../src/voiceprint/contracts.ts';
export interface ReplaySelection {principal:string;raw_ref:string;track:string;epoch:string;start_ms:number;end_ms:number;revision?:string;channel?:'call'|'video'}
type Diagnostic=SpeakerIdentifier&{scoreChannels(e:Float32Array,channel?:'call'|'video'):Promise<Record<string,number>>};
type Engine={openCallVad(signal:AbortSignal):Promise<SpeechVadStream>;embedCall(pcm:Float32Array):Promise<Float32Array>;embed(pcm:Float32Array):Promise<Float32Array>};
/** Registry changes, including decrypt/migration and call learning, never reach the original storage. */
export function memoryOverlay(original:Pick<StoragePort,'read'>):StoragePort {
  const values=new Map<string,Uint8Array>(),key=(n:string,k:string)=>`${n}:${k}`;
  const denied=async():Promise<never>=>{throw new Error('REPLAY_WRITE_FORBIDDEN');};
  return {read:async(n,k)=>values.get(key(n,k))?.slice()??original.read(n,k),
    replace:async(n,k,b)=>{check(n==='voiceprints','REPLAY_WRITE_FORBIDDEN');values.set(key(n,k),b.slice());},
    publish:denied,list:denied,removePending:denied};
}
const verdict=(s:SpeakerIdentity)=>s.kind==='owner'?(s.band==='verified'?'owner':'uncertain'):s.kind==='speaker'?'guest':s.kind;
const summary=(s:SpeakerIdentity)=>({verdict:verdict(s),score:'score'in s?s.score:null,
  ...(s.kind==='unknown'?{reason:s.reason}:{}),...('call_only'in s?{call_only:true}:{})});
/** Stored clock metadata is only a hint until the capture clock authority verifies it. */
async function archivedMaps(storage:Pick<StoragePort,'read'>,event:ArchivedEvent,manifest:StreamManifest) {
  const ref=event.source.capture_timing?.basis_ref,key=/^source-clock:([a-f0-9]{64})$/u.exec(ref??'')?.[1];
  check(key,'MEDIA_CLOCK_BASIS_REQUIRED');
  const basis=JSON.parse(Buffer.from(await storage.read('source-clock-bases',key)).toString());
  const clock=createSourceMediaClock(memoryOverlay(storage),{evidence:basis.evidence,resolve:async()=>{throw new Error('REPLAY_CAPTURE_FORBIDDEN');}});
  const maps=event.media_type==='livekit_tracks'?await clock.archivedClockMaps(event,manifest):[{...basis.map,basis_ref:ref}];
  await clock.authorizeClockMaps(event.principal_id,maps,event,manifest);return maps;
}
/** Enumerate admitted microphone candidates, not transcript-bearing call mirror payloads. */
export async function listCallStreams(since:string,until:string,ports:{storage:Pick<StoragePort,'read'|'list'>;
  archive:Pick<RawArchive,'locate'|'readRecord'>;emit:(row:unknown)=>void}) {
  const from=Date.parse(since),to=Date.parse(until);check(Number.isFinite(from)&&Number.isFinite(to)&&from<to,'REPLAY_RANGE_INVALID');
  const seen=new Set<string>();
  for(const key of await ports.storage.list('stream-revisions')){
    const hint=JSON.parse(Buffer.from(await ports.storage.read('stream-revisions',key)).toString());
    const id=JSON.stringify([hint.event.principal_id,hint.raw_ref]);if(seen.has(id))continue;seen.add(id);
    let event:ArchivedEvent;
    try{event=await ports.archive.locate(hint.raw_ref,hint.event.principal_id);}
    catch(error){if(error instanceof ContractError&&['RAW_DELETED','RAW_REF_NOT_FOUND'].includes(error.code))continue;throw error;}
    const record=await ports.archive.readRecord(event.raw_ref,event.principal_id,event.archive_revision,{proof_only:true});
    check(record.kind==='stream','REPLAY_STREAM_REQUIRED');
    const chunks=record.manifest.chunks.filter(c=>c.track_id==='microphone'&&c.modality==='audio');if(!chunks.length)continue;
    const maps=await archivedMaps(ports.storage,event,record.manifest);
    for(const map of maps.filter(m=>m.track_id==='microphone'&&m.modality==='audio')){
      const ranges=chunks.filter(c=>c.stream_epoch===map.stream_epoch).map(c=>c.source_range);
      check(ranges.length&&ranges.every(r=>r.kind==='interval'&&r.timebase_id===map.source_timebase_id),'REPLAY_TRACK_INVALID');
      const start_ms=ranges.reduce((n,r)=>Math.min(n,r.kind==='interval'?r.start_ms:NaN),Infinity),
        end_ms=ranges.reduce((n,r)=>Math.max(n,r.kind==='interval'?r.end_ms:NaN),-Infinity);
      const wall=mappedRange({kind:'interval',timebase_id:map.source_timebase_id,stream_epoch:map.stream_epoch,start_ms,end_ms},map);
      check(wall.kind==='interval'&&wall.timebase_id==='utc_epoch_ms','REPLAY_TRACK_INVALID');
      if(wall.start_ms<to&&wall.end_ms>from)ports.emit({principal:event.principal_id,raw_ref:event.raw_ref,revision:event.archive_revision,
        track:map.track_id,epoch:map.stream_epoch,device_type:event.device_type,wall_start:new Date(wall.start_ms).toISOString(),
        wall_end:new Date(wall.end_ms).toISOString(),start_ms,end_ms});
    }
  }
}
/** Only L5's verified public reads select bytes. All continuity checks finish before model work or output. */
export async function replayCall(selection:ReplaySelection,ports:{archive:Pick<RawArchive,'locate'|'readRecord'>;
  storage:Pick<StoragePort,'read'>;engine:Engine;baseline:Diagnostic;candidate:Diagnostic;emit:(row:unknown)=>void;max_bytes?:number}) {
  const s=selection,channel=s.channel??'call',limit=ports.max_bytes??64*1024*1024;
  check(channel==='call'||channel==='video','REPLAY_CHANNEL_INVALID');
  check(Number.isSafeInteger(s.start_ms)&&Number.isSafeInteger(s.end_ms)&&s.start_ms>=0&&s.end_ms>s.start_ms,'REPLAY_RANGE_INVALID');
  const event=await ports.archive.locate(s.raw_ref,s.principal),revision=s.revision??event.archive_revision;
  const record=await ports.archive.readRecord(s.raw_ref,s.principal,revision,{proof_only:true,maxReadBytes:limit});
  check(record.kind==='stream','REPLAY_STREAM_REQUIRED');
  const chunks=record.manifest.chunks.filter(c=>c.track_id===s.track&&c.stream_epoch===s.epoch&&c.source_range.kind==='interval'&&
    c.source_range.end_ms>s.start_ms&&c.source_range.start_ms<s.end_ms).sort((a,b)=>
      (a.source_range.kind==='interval'?a.source_range.start_ms:0)-(b.source_range.kind==='interval'?b.source_range.start_ms:0));
  check(chunks.length>0&&(s.end_ms-s.start_ms)*32<=limit,'REPLAY_READ_BUDGET');
  let cursor=s.start_ms,total=0,prior=chunks[0]!,timebase=prior.source_range.timebase_id;
  for(const c of chunks){const r=c.source_range;
    check(r.kind==='interval'&&r.timebase_id===timebase&&r.stream_epoch===s.epoch&&c.modality==='audio'&&
      c.format==='pcm_s16le:16000:1'&&c.representation==='received_decoded_sample','REPLAY_TRACK_INVALID');
    check(c===chunks[0]||c.seq===prior.seq+1,'REPLAY_GAP');
    check(r.start_ms<=cursor&&r.end_ms>cursor&&(c===chunks[0]||r.start_ms===cursor),'REPLAY_GAP');
    check(c.bytes===(r.end_ms-r.start_ms)*32,'REPLAY_PCM_RANGE_INVALID');
    cursor=Math.min(s.end_ms,r.end_ms);total+=c.bytes;prior=c;
  }
  check(cursor===s.end_ms&&total<=limit,'REPLAY_GAP');
  const selected=await ports.archive.readRecord(s.raw_ref,s.principal,revision,{track_ids:[s.track],
    source_range:{kind:'interval',timebase_id:timebase,stream_epoch:s.epoch,start_ms:s.start_ms,end_ms:s.end_ms},maxReadBytes:limit});
  check(selected.kind==='stream','REPLAY_STREAM_REQUIRED');
  const pcm=new Float32Array((s.end_ms-s.start_ms)*16);let offset=0;
  for(const {chunk:c,bytes} of selected.chunks.sort((a,b)=>
    (a.chunk.source_range.kind==='interval'?a.chunk.source_range.start_ms:0)-(b.chunk.source_range.kind==='interval'?b.chunk.source_range.start_ms:0))){const r=c.source_range;
    check(c.track_id===s.track&&c.stream_epoch===s.epoch&&r.kind==='interval'&&r.timebase_id===timebase,'REPLAY_TRACK_INVALID');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),from=Math.max(s.start_ms,r.start_ms),to=Math.min(s.end_ms,r.end_ms);
    for(let n=(from-r.start_ms)*16;n<(to-r.start_ms)*16;n++)pcm[offset++]=view.getInt16(n*2,true)/32768;
  }
  check(offset===pcm.length,'REPLAY_GAP');
  const maps=await archivedMaps(ports.storage,{...event,archive_revision:revision},record.manifest);
  const map=maps.find(m=>m.track_id===s.track&&m.stream_epoch===s.epoch);check(map,'REPLAY_TRACK_INVALID');
  const abort=new AbortController(),vad=await ports.engine.openCallVad(abort.signal);
  let start=-1,verified=0,utterance=0,blocked=[false,false],last:unknown;
  const checkpoint=async(end:number,reason:'verify'|'end')=>{
    if(start<0||end<=start)return;
    const from=Math.max(start,end-19200),window=pcm.subarray(from,end),window_ms=window.length/16,speech_ms=(end-start)/16;
    const wall=mappedRange({kind:'instant',timebase_id:timebase,stream_epoch:s.epoch,at_ms:s.start_ms+end/16},map);
    check(wall.kind==='instant'&&wall.timebase_id==='utc_epoch_ms','REPLAY_TRACK_INVALID');
    const compare=[];
    for(const [i,registry] of [ports.baseline,ports.candidate].entries()){
      const audio=i===0?window:pcm.subarray(start,end),duration=audio.length/16;
      let embedding:Float32Array|undefined,unavailable=false;
      if(duration>=200)try{embedding=i===0?await ports.engine.embedCall(audio):await embedSpeech(ports.engine,audio);}
      catch(error){if(!(error instanceof ContractError)||error.code!=='SPEECH_INPUT_TOO_SHORT')throw error;unavailable=true;blocked[i]=true;}
      const evidence={window_start_ms:s.start_ms+(i===0?from:start)/16,window_ms:duration,window_samples:audio.length};
      if(!embedding){compare.push({...evidence,verdict:unavailable?'unavailable':'undecided',score:null,
        ...(unavailable?{reason:'SPEECH_INPUT_TOO_SHORT'}:{}),channels_before:{},channels_after:{},utterance_verdict:blocked[i]?'blocked':'undecided'});continue;}
      const before=await registry.scoreChannels(embedding,channel),identity=await registry.identify(embedding,
        {speech_ms:duration,mode:'call',channel,observed_at:new Date(wall.at_ms).toISOString()}),after=await registry.scoreChannels(embedding,channel),v=verdict(identity);
      blocked[i] ||=v==='guest'||v==='assistant'||v==='unknown'&&duration>=1000&&(i===0||reason==='end');
      compare.push({...evidence,...summary(identity),channels_before:before,channels_after:after,utterance_verdict:blocked[i]?'blocked':v});
    }
    last={channel,utterance,start_ms:s.start_ms+start/16,end_ms:s.start_ms+end/16,window_start_ms:s.start_ms+from/16,
      window_ms,window_samples:window.length,speech_ms,baseline:compare[0],candidate:compare[1]};
    ports.emit({event:reason,...last as object});if(reason==='end')ports.emit({event:'utterance',...last as object});
  };
  try {
    for(let at=0;at+512<=pcm.length;at+=512){const tail=at+512,events=await vad.write(pcm.subarray(at,tail));
      for(const e of events){if(e.start!==undefined){start=e.start;verified=start;utterance++;blocked=[false,false];last=undefined;}
        if(e.end!==undefined){await checkpoint(e.end,'end');start=-1;}
        else {const end=e.at-2048;if(start>=0&&end-start>=6400&&end-verified>=6400){verified=end;await checkpoint(end,'verify');}}}
      const end=tail-2048;if(start>=0&&end-start>=6400&&end-verified>=6400){verified=end;await checkpoint(end,'verify');}
    }
    // A selected interval can end mid-utterance. Do not invent silence or a detector end.
    if(start>=0&&last)ports.emit({event:'utterance_open',...last as object});
  } finally {await vad.close();abort.abort();}
}
export async function main(argv:string[]) {
  setPriority(0,Math.max(getPriority(),10));
  const listing=argv.includes('--list'),inventory=argv.includes('--registry'),preserve=argv.includes('--preserve-call');
  check(!(listing&&inventory),'REPLAY_ARGUMENTS_INVALID');
  argv=argv.filter(a=>!['--list','--registry','--preserve-call'].includes(a));
  const args=new Map<string,string>();
  check(argv.length%2===0,'REPLAY_ARGUMENTS_INVALID');
  for(let n=0;n<argv.length;n+=2){check(['--config','--principal','--raw-ref','--track','--epoch','--start-ms','--end-ms','--revision','--warm-selection','--since','--until','--channel'].includes(argv[n]!)&&
    !args.has(argv[n]!), 'REPLAY_ARGUMENTS_INVALID');args.set(argv[n]!,argv[n+1]!);}
  const required=(name:string)=>{const v=args.get(name);check(v,'REPLAY_ARGUMENTS_INVALID');return v;};
  const channel=args.get('--channel')??'call';check(channel==='call'||channel==='video','REPLAY_CHANNEL_INVALID');
  const text=(await readFile(required('--config'),'utf8')).replace(/\$\{([A-Z0-9_]+)\}/gu,(_,name:string)=>{
    check(process.env[name]!==undefined,'REPLAY_ENV_MISSING');return process.env[name]!;});
  const config=JSON.parse(text);
  const original=new PosixStorage(config.storage_root,{read_only:true}),archive=new RawArchive(memoryOverlay(original),config.max_event_bytes,undefined,config.pcm.media.stream_budget);
  if(listing){try{await listCallStreams(required('--since'),required('--until'),{storage:original,archive,emit:row=>process.stdout.write(JSON.stringify(row)+'\n')});}
    finally{await original.close();}return;}
  if(inventory){
    let registry:VoiceprintRegistry|undefined;
    try{
      const print=config.voiceprint;check(print?.speaker_model&&print.encryption_key_file,'REPLAY_CONFIG_INVALID');
      const model=await speakerModelIdentity(print.speaker_model.file,print.speaker_model.dim),cipher=await loadRegistryCipher(print.encryption_key_file);
      registry=new VoiceprintRegistry(memoryOverlay(original),model,{cipher,
        policy:{...(print.thresholds?{thresholds:print.thresholds}:{})},scoring:configuredScoring(print.scoring,model)});
      process.stdout.write(JSON.stringify(await registry.diagnostics())+'\n');
    }finally{await registry?.close();await original.close();}return;
  }
  const speech=parseLocalSpeechConfig(config.pcm.media.audio.config);
  // Cold restoration is deliberately disabled: a missing hot object fails closed without writable cold metadata.
  check(config.pcm.media.audio.provider==='local_sherpa'&&config.voiceprint.encryption_key_file,'REPLAY_CONFIG_INVALID');
  const {kws:_keywords,tagging:_tagging,...acoustic}=speech;
  const engine=await LocalSpeechEngine.open({...acoustic,num_threads:1});
  let baseline:VoiceprintRegistry|undefined,candidate:VoiceprintRegistry|undefined;
  try {
    const model:SpeakerModel=engine.speaker_model;
    check(model.dim===config.voiceprint.speaker_model.dim&&speech.speaker.model.path===config.voiceprint.speaker_model.file,'REPLAY_MODEL_MISMATCH');
    const cipher=await loadRegistryCipher(config.voiceprint.encryption_key_file),options={cipher,
      scoring:configuredScoring(config.voiceprint.scoring,model),
      policy:{...(config.voiceprint.thresholds?{thresholds:config.voiceprint.thresholds}:{})},
      onError:()=>{throw new Error('REPLAY_REGISTRY_FAILED');}};
    // Both comparisons start from one immutable registry preimage, even while production flushes it.
    const reads=new Map<string,Promise<Uint8Array>>(),snapshot={read:(n:string,k:string)=>{
      const key=`${n}:${k}`;let value=reads.get(key);
      if(!value){value=original.read(n,k);reads.set(key,value);}return value.then(bytes=>bytes.slice());
    }};
    baseline=new VoiceprintRegistry(memoryOverlay(snapshot),model,{...options,call_learning:false});
    candidate=new VoiceprintRegistry(memoryOverlay(snapshot),model,{...options,call_learning:true});
    // Production diagnosis preserves learned evidence; the experiment's default resets the derived call set in memory.
    if(!preserve)await candidate.forgetOwner('call');
    if(args.has('--warm-selection')){
      const warm=JSON.parse(await readFile(required('--warm-selection'),'utf8'));
      for(const selection of (Array.isArray(warm)?warm:[warm]))await replayCall({channel,...selection},
        {archive,storage:original,engine,baseline,candidate,emit:row=>process.stdout.write(JSON.stringify({phase:'warmup',...row as object})+'\n'),max_bytes:config.max_event_bytes});
      const status=await candidate.status() as {learned_samples:Partial<Record<'call'|'video',number>>};
      check((status.learned_samples[channel]??0)>=candidate.policy.min_enroll_samples,'REPLAY_CALL_SET_NOT_READY');
    }
    await replayCall({channel,principal:required('--principal'),raw_ref:required('--raw-ref'),track:required('--track'),epoch:required('--epoch'),
      start_ms:Number(required('--start-ms')),end_ms:Number(required('--end-ms')),...(args.has('--revision')?{revision:args.get('--revision')!}:{})},
      {archive,storage:original,engine,baseline,candidate,emit:row=>process.stdout.write(JSON.stringify(row)+'\n'),max_bytes:config.max_event_bytes});
  } finally {await Promise.all([baseline?.close(),candidate?.close(),engine.close(),original.close()]);}
}
if(import.meta.main)await main(process.argv.slice(2)).catch(error=>{
  const code=error?.code;process.stderr.write(`CALL_VOICEPRINT_REPLAY_FAILED:${typeof code==='string'&&/^[A-Z0-9_:]+$/u.test(code)?code:'UNKNOWN'}\n`);process.exitCode=2;});
