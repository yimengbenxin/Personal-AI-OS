import assert from 'node:assert/strict';
import type test from 'node:test';
import {existsSync,promises as fs} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContractError,digest,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {MediaProcessor} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import {SherpaSileroStreamFactory,type SpeechVad} from '../src/media/silero-stream.ts';
import {LOCAL_SHERPA_TURN,SherpaAudioWorker,sherpaAudioCapability,type LocalAudioEngine} from '../src/media/sherpa-audio-worker.ts';
import type {SoundEvent,SpeechEmotion,SpeakerIdentifier} from '../src/voiceprint/contracts.ts';
import type {LocalSpeechConfig,LocalSpeechEngine,VadEvent} from '../src/voiceprint/engine.ts';
import type {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {OutputAuthority} from '../src/output.ts';
import type {TrackChunk} from '../src/stream-archive.ts';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {AmbientJournal,type AmbientPolicy} from '../src/ambient/journal.ts';
import type {WorkerRequest} from '../src/media/processing.ts';
import {sampleInput,type SampleAudioResult} from '../src/media/sample-results.ts';
import {selectedAudioTimeline} from '../src/media/sample-timeline.ts';

/** Marker protocol, no model: a 512-sample frame is speech iff its first sample is nonzero. Never establishes VAD quality. */
export function controlledVad(hooks:{write?:()=>Promise<void>}={}):SpeechVad&{opened:number;closed:number} {
  const vad={opened:0,closed:0,vad_model:{id:'controlled-vad',version:'fixture',device:'cpu',native_metadata:{onnx_sha256:digest('controlled-vad')}},
    async openVad(signal:AbortSignal) {
      if(signal.aborted)throw new ContractError('SPEECH_CANCELLED',409);
      vad.opened++;let tail=0,speech=false;
      return {write:async(samples:Float32Array)=>{
        await hooks.write?.();const events:VadEvent[]=[];
        for(let at=0;at<samples.length;at+=512){const voiced=samples[at]!==0;
          if(voiced&&!speech)events.push({at:tail+512,start:tail});if(!voiced&&speech)events.push({at:tail+512,end:tail});speech=voiced;tail+=512;}
        return events;
      },close:async()=>{vad.closed++;}};
    }};
  return vad;
}
export function controlledDetector(hooks:{write?:()=>Promise<void>}={}) {
  const vad=controlledVad(hooks);return Object.assign(new SherpaSileroStreamFactory(async()=>vad),{vad});
}
/** Marker engine: an utterance's text and one-hot embedding name its marker amplitude; under 0.1 s embeds as too short.
 *  `wake`: amplitudes the controlled keyword spotter hears as 依米 (and whose text then starts with "一米，"); `wakeAlone`:
 *  amplitudes it hears as 依米 said alone (text "意味？"). The spotter reports its hit when the stream finishes. */
export function controlledEngine(options:{wake?:number[];wakeAlone?:number[];lang?:string}={}):LocalAudioEngine&{calls:string[]} {
  const vad=controlledVad(),calls:string[]=[];
  const level=(samples:Float32Array)=>Math.round((samples.find(x=>x!==0)??0)*32768);
  const spotted=[...options.wake??[],...options.wakeAlone??[]];
  const keywords=spotted.length?{open:async(signal:AbortSignal)=>{
    if(signal.aborted)throw new ContractError('SPEECH_CANCELLED',409);
    let fed=0,heard=false;calls.push('kws_open');
    return {write:async(samples:Float32Array)=>{fed+=samples.length;heard||=spotted.includes(level(samples));return [];},
      finish:async()=>heard?[{keyword:'依米',at_sample:fed}]:[],close:async()=>{}};
  }}:undefined;
  return {vad_model:vad.vad_model,openVad:signal=>vad.openVad(signal),calls,version:'controlled-engine',available:()=>true,
    asr_model:{id:'controlled-asr',sha256:digest('controlled-asr')},speaker_model:{id:'controlled-speaker',sha256:digest('controlled-speaker'),dim:4},
    ...(keywords?{keywords}:{}),
    transcribe:async samples=>{calls.push(`transcribe:${samples.length}`);const n=level(samples);
      return {text:!n?'':options.wakeAlone?.includes(n)?'意味？':options.wake?.includes(n)?`一米，utterance ${n}`:`utterance ${n}`,
        ...(options.lang&&n?{lang:options.lang}:{})};},
    embed:async samples=>{calls.push(`embed:${samples.length}`);if(samples.length<1600)throw new ContractError('SPEECH_INPUT_TOO_SHORT');
      const vector=new Float32Array(4);vector[level(samples)%4]=1;return vector;},
    close:async()=>{}};
}
/** Config-shape only: absolute paths that are never loaded. */
export function fakeSpeechConfig(root='/nonexistent-paios-speech-models'):LocalSpeechConfig {
  const file=(name:string)=>({path:join(root,name),sha256:digest(name)});
  return {num_threads:1,timeout_ms:1000,vad:{model:file('vad.onnx')},asr:{model:file('asr.onnx'),tokens:file('tokens.txt')},
    speaker:{model:file('speaker.onnx')}};
}

const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'fixture',submission:'observation'};
/** One PCM window through the real MediaService and processor into the local transcription consumer. The whole window
 *  is one candidate, so the consumer itself must split utterances. Times map onto utc_epoch_ms from `base`. `carrier`: the
 *  window is a follow-up turn opening with the replied request's speech (the processor passes it from the turn segment). */
export async function transcribeWindow(t:test.TestContext,pcm:Buffer,engine:LocalAudioEngine,speakers?:SpeakerIdentifier,base=1_760_000_000_000,
  mode:'utterance'|'turn'='utterance',carrier?:WorkerRequest['speaker_carrier'],purpose?:'meeting'|'meeting_paused') {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-sherpa-window-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const storage=new PosixStorage(directory),budget={max_chunk_bytes:400000,max_total_bytes:400000,max_chunks:4,max_revisions:4,max_seq:4};
  const archive=new RawArchive(storage,400000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  const detector=new SherpaSileroStreamFactory(async()=>engine);
  const sherpa=new SherpaAudioWorker(async()=>engine,detector,speakers,mode),capability=sherpaAudioCapability(engine,speakers!==undefined,mode);
  const worker=carrier?{effects:'pure_analysis' as const,analyze:(request:WorkerRequest,signal:AbortSignal)=>sherpa.analyze({...request,speaker_carrier:carrier},signal)}:sherpa;
  const processor=new MediaProcessor(storage,new Map([[capability.id,worker]]),{policy_version:'sherpa-fixture',max_inflight:1,
    max_input_bytes:400000,timeout_ms:30000,allow_external:false,allow_replay:false,allow_partial:true});
  if(purpose)processor.setSpeechPurpose(async()=>purpose);
  const service=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[capability],fixtureOnly:true,
    vad:{candidates:async request=>{const r=request.time_range as {start_ms:number;end_ms:number};
      return [{start_ms:r.start_ms,end_ms:r.end_ms,semantic_status:'open',basis:'controlled-whole-window'}];}},
    align:{max_chunks:4,max_visual_refs:1,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:10000});
  t.after(()=>service.close());
  const raw:RawEvent={schema_version:'paios.event.v1',event_id:'window',device_id:'glasses',device_type:'glasses',captured_at:'2026-10-09T00:00:00.000Z',
    source:{channel:'fixture'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm};
  const end=pcm.length/32,archived=await service.append(raw,trusted,{track_id:'mic',stream_epoch:'e',seq:0,modality:'audio',
    format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'e',start_ms:0,end_ms:end}});
  const result=await service.process('owner',{raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:base,end_ms:base+end},clock_maps:[{modality:'audio',track_id:'mic',
      stream_epoch:'e',source_timebase_id:'samples',target_timebase_id:'utc_epoch_ms',offset_ms:base,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]});
  assert.equal(result.processed_events.length,1);
  const d=result.processed_events[0]!,observation=(d.content.audio_observations as unknown[])[0] as {segments:{start_sample:number;
    end_sample_exclusive:number;text:string;speaker?:string}[];model:{id:string;version:string;dtype:string;native_metadata:Record<string,unknown>}};
  return {d,observation};
}

const M=process.env.PAIOS_MODEL_ROOT?join(process.env.PAIOS_MODEL_ROOT,'sherpa'):'/opt/personal-aios-runtime/models/sherpa',SV=`${M}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`,
  KD=`${M}/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`;
/** The deployed model set and its pins (the same block mac-product.json carries). */
export const realSpeechConfig:LocalSpeechConfig={num_threads:1,timeout_ms:30000,
  vad:{model:{path:`${M}/silero_vad.onnx`,sha256:'9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'}},
  asr:{model:{path:`${SV}/model.int8.onnx`,sha256:'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'},
    tokens:{path:`${SV}/tokens.txt`,sha256:'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'}},
  tagging:{model:{path:`${M}/sherpa-onnx-zipformer-audio-tagging-2024-04-09/model.int8.onnx`,sha256:'cd07a1f1758e48e15415771dfc729107cc163e2423452d8ab463f2378e79a9bd'},
    labels:{path:`${M}/sherpa-onnx-zipformer-audio-tagging-2024-04-09/class_labels_indices.csv`,sha256:'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429'}},
  speaker:{model:{path:`${M}/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`,sha256:'bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239'}},
  kws:{encoder:{path:`${KD}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,sha256:'dd784973fc9d2fabb3b800d6dcd20fc3b0ca84f8e2415afe54b032878e447f4d'},
    decoder:{path:`${KD}/decoder-epoch-12-avg-2-chunk-16-left-64.onnx`,sha256:'fb581d6734511676e246e0dff2fea01b31b0913176cb3ca64576dbab0a177774'},
    joiner:{path:`${KD}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,sha256:'f79760052b87239e325f0567c752ad3130b30d92effb847d4307743c20c59a24'},
    tokens:{path:`${KD}/tokens.txt`,sha256:'72316508d9119696145abc6f1f8cdc46287535c34e5ce7e595f845cb1499cf2e'},
    keywords:[{label:'依米',tokens:'y ī m ǐ'}],score:2.0,threshold:0.15}};
const k=realSpeechConfig.kws!;
export const realModelsPresent=[realSpeechConfig.vad.model,realSpeechConfig.asr.model,realSpeechConfig.asr.tokens,realSpeechConfig.speaker.model,
  k.encoder,k.decoder,k.joiner,k.tokens,realSpeechConfig.tagging!.model,realSpeechConfig.tagging!.labels].every(file=>existsSync(file.path));
export const VOICE_A='Tingting',VOICE_B='Eddy (中文（中国大陆）)';
const voices=(()=>{try {return existsSync('/usr/bin/afconvert')?execFileSync('/usr/bin/say',['-v','?'],{encoding:'utf8'}):'';} catch {return '';}})();
export const sayPresent=[VOICE_A,VOICE_B].every(voice=>voices.split('\n').some(line=>line.startsWith(voice+' ')));
/** macOS `say` → mono PCM16LE bytes at `rate` (16 kHz, or 24 kHz as the system TTS output). `say` straight to WAV writes
 *  empty files, so it goes through AIFF. Callers run it serially. */
export async function synthesize(dir:string,voice:string,text:string,rate=16000):Promise<Buffer> {
  const base=join(dir,digest([voice,text,rate]).slice(0,16));
  // macOS speech synthesis can wedge when several processes call `say` at once: fail the test instead of hanging the run.
  execFileSync('/usr/bin/say',['-v',voice,'-o',`${base}.aiff`,text],{timeout:120000});
  execFileSync('/usr/bin/afconvert',['-f','WAVE','-d',`LEI16@${rate}`,'-c','1',`${base}.aiff`,`${base}.wav`],{timeout:60000});
  return wavData(await fs.readFile(`${base}.wav`));
}
/** The PCM of a WAV file's data chunk. */
export function wavData(wav:Buffer):Buffer {
  for(let at=12;at+8<=wav.length;at+=8+wav.readUInt32LE(at+4)+(wav.readUInt32LE(at+4)&1))
    if(wav.toString('ascii',at,at+4)==='data')return wav.subarray(at+8,at+8+wav.readUInt32LE(at+4));
  throw new Error('WAV_DATA_MISSING');
}
/** 16 kHz mono PCM16LE as a WAV file. */
export function wavFile(pcm:Buffer):Buffer {
  const head=Buffer.alloc(44);head.write('RIFF',0);head.writeUInt32LE(36+pcm.length,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);
  head.writeUInt16LE(1,20);head.writeUInt16LE(1,22);head.writeUInt32LE(16000,24);head.writeUInt32LE(32000,28);head.writeUInt16LE(2,32);
  head.writeUInt16LE(16,34);head.write('data',36);head.writeUInt32LE(pcm.length,40);
  return Buffer.concat([head,pcm]);
}
export const silence=(seconds:number)=>Buffer.alloc(Math.round(seconds*16000)*2);
export function floats(pcm:Buffer):Float32Array {const out=new Float32Array(pcm.length/2);for(let n=0;n<out.length;n++)out[n]=pcm.readInt16LE(n*2)/32768;return out;}

/** An owner-only ambient journal in its own temporary directory; closed after the test (after hooks registered before it). */
export async function testJournal(t:test.TestContext,policy:Partial<AmbientPolicy>={}):Promise<AmbientJournal> {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-ambient-'));
  const journal=AmbientJournal.open(join(directory,'ambient-journal'),policy);
  t.after(async()=>{journal.close();await fs.rm(directory,{recursive:true,force:true});});
  return journal;
}
/** A local transcription result whose one utterance spans the selected audio; `wake`: the spotter's 依米 hit ending at
 *  that fraction of the utterance. */
export function transcriptionResult(request:WorkerRequest,model:{id:string;version:string},text:string,
  annotation:{wake?:number;speaker?:string;speaker_score?:number;event?:SoundEvent;emotion?:SpeechEmotion}={}):SampleAudioResult {
  const group=selectedAudioTimeline(request)[0]!;
  return {schema:'paios.media.audio-sample-result.v1',kind:'transcription',...sampleInput(group),model:{...model,device:'cpu'},raw_text:text,
    segments:[{start_sample:0,end_sample_exclusive:group.total_samples,text,
      ...(annotation.wake!==undefined?{wake:{keyword:'依米',end_sample:Math.round(group.total_samples*annotation.wake)}}:{}),
      ...(annotation.speaker?{speaker:annotation.speaker,speaker_score:annotation.speaker_score??0.9}:{}),...(annotation.event?{event:annotation.event}:{}),
      ...(annotation.emotion?{emotion:annotation.emotion}:{})}]};
}

/** A synthesized conversation (16 kHz PCM, UTC from `t0`) through the real interval_v2 ambient lane: the glasses' 100 ms frames
 *  archived in batches through the runtime, Silero candidates, local-sherpa-audio (text, wake word, voiceprint), the journal,
 *  and wake turns (local-sherpa-turn) admitted to a fake Hermes that records each run. Waits for `runs` runs. With
 *  `replies`, the conversation comes in phases: each phase but the last ends in one turn whose run answers with the next
 *  reply, sealed by automatic output and delivered to the glasses before the next phase is heard (the wall clock follows
 *  the audio appended, as if it streamed in real time). */
export async function realAmbientLane(t:test.TestContext,directory:string,engine:LocalSpeechEngine,registry:VoiceprintRegistry,conversation:Buffer|Buffer[],
  t0:number,runs:number,replies:string[]=[]) {
  const storage=new PosixStorage(join(directory,'storage'));
  const budget={max_chunk_bytes:8192,max_total_bytes:2000000,max_chunks:400,max_revisions:400,max_seq:400};
  const archive=new RawArchive(storage,400000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  const detector=new SherpaSileroStreamFactory(async()=>engine),capability=sherpaAudioCapability(engine,true);
  const processor=new MediaProcessor(storage,new Map([[capability.id,new SherpaAudioWorker(async()=>engine,detector,registry)],
    [LOCAL_SHERPA_TURN,new SherpaAudioWorker(async()=>engine,detector,registry,'turn')]]),
    {policy_version:'ambient-real',max_inflight:1,max_input_bytes:400000,timeout_ms:120000,allow_external:false,allow_replay:false,allow_partial:true});
  const errors:unknown[]=[];
  const service=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[sherpaAudioCapability(engine,true)],fixtureOnly:true,
    clockEvidence:'synthetic',align:{max_chunks:400,max_visual_refs:1,max_frame_gap_ms:200,max_uncertainty_ms:2},max_segments:4,max_window_ms:20000,
    turn:{capabilities:async()=>[sherpaAudioCapability(engine,true,'turn')]},
    continuous:{detector,budget:{max_streams:2,max_pending_chunks:64,max_pending_candidates:16,max_chunk_bytes:8192,block_samples:160000,overlap_samples:8000},
      onError:error=>errors.push(error)}});
  t.after(()=>processor.close());
  const bodies:{input:string;run_scope?:string;guest_key?:string;session_id:string;run_id:string}[]=[],answered=new Map<string,string>();
  const native:NativeClient={create:async(body,key)=>{const run_id=`run-${sha256(key).slice(0,12)}`;bodies.push({...structuredClone(body),run_id});
    return {run_id,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};},
    // Without replies a run completes at once; with them it runs until answered.
    status:async id=>({run_id:id,session_id:'continuity',conversation_session_id:'continuity',status:replies.length&&!answered.has(id)?'running':'completed',
      ...(answered.has(id)?{output:answered.get(id)!}:{})}),
    cancel:async id=>({run_id:id,session_id:'continuity',conversation_session_id:'continuity',status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:4000000,max_event_age_ms:600000,poll_interval_ms:5,
    native_idempotency_retention_ms:86400000,policy_version:'controlled'});
  const journal=await testJournal(t);let fed=0;
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,media:service,skill:'controlled',
    output:new OutputAuthority(storage,replies.length?{listRunReceipts:async()=>({sources:[]})}:{}),
    ...(replies.length?{automatic_output:{onError:(error:unknown)=>errors.push(error)},ambient_clock:()=>t0+fed/16}:{}),
    max_read_bytes:400000,voiceprint:registry,ambient_journal:journal,
    devices:[{principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'fixture',route_version:'route',
      output_modes:['text'],token_sha256:sha256('glasses-token')}],
    audio_route:async(source,event)=>({consumer:'media',input_contract:'interval_v2',source_scope:source.device_id,capture_span:event.raw_ref,
      purpose_evidence_ref:event.consent_ref}),
    continuous_context:async(_source,_event,chunk)=>({session:'continuity',clock_maps:[{modality:'audio',track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,
      source_timebase_id:'pcm',target_timebase_id:'utc_epoch_ms',offset_ms:t0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]})});
  t.after(()=>runtime.close());
  const glasses=await runtime.authenticate('glasses-token'),started=performance.now();
  const waitRuns=async(count:number)=>{for(let i=0;i<2000&&bodies.length<count;i++)await new Promise(resolve=>setTimeout(resolve,10));};
  /** Opens the run's reply, completes it with `text` and waits until the glasses' session receives it. */
  const reply=async(run:{input:string;run_id:string},text:string)=>{
    for(let i=0;;i++){const opened=await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:`open-${i}`},
      args:{reply_mode:'text'}}) as {error_code?:string};if(opened.error_code!=='RUN_BINDING_PENDING')break;
      assert.ok(i<400,'run binding did not settle');await new Promise(resolve=>setTimeout(resolve,5));}
    answered.set(run.run_id,text);
    const delivered=Promise.withResolvers<void>();
    await runtime.subscribeResult(glasses,'continuity',(JSON.parse(run.input) as {processed_event_id:string}).processed_event_id,async value=>{
      if(value.chunks.some(chunk=>chunk.final))delivered.resolve();},delivered.reject);
    await delivered.promise;
  };
  // The glasses' 100 ms frames, archived in batches of 20 on the interval contract.
  const phases=Array.isArray(conversation)?conversation:[conversation];
  let last,seq=0,lastChunk:TrackChunk|undefined;
  for(const [phase,pcm] of phases.entries()){
    const frames:{raw:RawEvent;device:typeof glasses;chunk:TrackChunk}[]=[];
    for(let at=0;at<pcm.length/2;at+=1600,seq++){
      const end=Math.min(pcm.length/2,at+1600);
      frames.push({device:glasses,chunk:{track_id:'mic',stream_epoch:'day',seq,modality:'audio',format:'pcm_s16le:16000:1',
        source_range:{kind:'interval',timebase_id:'pcm',stream_epoch:'day',start_ms:(fed+at)/16,end_ms:(fed+end)/16}},
        raw:{schema_version:'paios.event.v1',event_id:'ambient-day',device_id:'glasses',device_type:'glasses',captured_at:new Date(t0).toISOString(),
          source:{channel:'fixture'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm.subarray(at*2,end*2)}});
    }
    for(let n=0;n<frames.length;n+=20){fed+=frames.slice(n,n+20).reduce((sum,f)=>sum+f.raw.payload.length/2,0);
      const archived=await runtime.appendMediaBatch(frames.slice(n,n+20),{max_chunks:20,max_bytes:65536});
      assert.ok(archived.every(a=>a.processing_admission?.status==='queued'),JSON.stringify(archived.map(a=>a.processing_admission)));last=archived.at(-1)!;
      await runtime.continuousMedia().drain();}
    lastChunk=frames.at(-1)!.chunk;
    if(phase===phases.length-1)break;
    await runtime.continuousMedia().drain();await waitRuns(phase+1);assert.equal(bodies.length,phase+1,`phase ${phase} ends in one turn`);
    await reply(bodies[phase]!,replies[phase]!);
  }
  await runtime.finishContinuousMedia(last!.event,lastChunk!);await runtime.continuousMedia().drain();
  await waitRuns(runs);
  assert.deepEqual(errors,[]);
  const seconds=(performance.now()-started)/1000,entries=journal.search({principal_id:'owner',limit:50}).entries.reverse();
  // Nothing writes after this returns, whatever order the caller's cleanup runs in.
  await runtime.close();await processor.close();
  return {storage,journal,bodies,entries,seconds};
}
import {EventEmitter} from 'node:events';
import type {QwenVoiceConfiguration} from '../src/voice/qwen-resources.mjs';

export class FakeSpeechSocket extends EventEmitter {
  static OPEN = 1; readyState = 0; bufferedAmount = 0;
  constructor(..._args: unknown[]) {
    super(); queueMicrotask(() => {this.readyState = 1; this.emit('open');});
  }
  reply(event: object) {queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(event)), false));}
  audio(bytes = Buffer.alloc(200)) {queueMicrotask(() => this.emit('message', bytes, true));}
  send(body: string) {
    const event = JSON.parse(body), task_id = event.header.task_id;
    if (event.header.action === 'run-task') this.reply({header: {event: 'task-started', task_id}, payload: {}});
    if (event.header.action === 'continue-task') this.audio();
    if (event.header.action === 'finish-task') this.reply({header: {event: 'task-finished', task_id}, payload: {}});
  }
  close() {this.readyState = 3; this.emit('close');}
  terminate() {this.close();}
}
export const fakeTtsConfiguration = {model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050};
export const fakeQwenConfiguration = (WebSocket: unknown = FakeSpeechSocket): QwenVoiceConfiguration => ({
  usable: true, provider: 'dashscope', model: 'qwen3.8-omni-flash-realtime', region: 'cn-beijing',
  endpoint: 'wss://synthetic.invalid/realtime', voice: 'Tina', apiKey: 'synthetic-offline-only', instructions: 'candidate',
  call: {model: 'qwen3.8-omni-flash-realtime', voice: 'longanlingxin'}, WebSocket,
});
