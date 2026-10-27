import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {EVENT_SCHEMA,ContractError,digest,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {loadRegistryCipher} from '../src/voiceprint/cipher.ts';
import {memoryOverlay,replayCall,listCallStreams} from '../tools/call-voiceprint-replay.ts';
import {createSourceMediaClock} from '../../../phase0/gateway/src/source-media-clock.ts';
import {pcmEventId} from '../../../phase0/gateway/src/personal-aios-formal-pcm.ts';
import type {SourceMediaCaptureBinding} from '../../../phase0/gateway/src/source-media-permission.ts';
import {fileURLToPath} from 'node:url';
const at='2026-10-17T00:00:00.000Z',model={id:'fixture',sha256:'a'.repeat(64),dim:32};
const vector=(x:number,y:number,z=0,w=0)=>Float32Array.from({length:32},(_,i)=>[x,y,z,w][i]??0);
const owner=vector(1,0),guest=vector(0,0,0,1),tv=vector(.42,Math.sqrt(1-.42*.42)),reply=vector(0.5,Math.sqrt(0.75));
const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'livekit',consent_ref:'consent',submission:'observation'};
const budget={max_chunk_bytes:8192,max_total_bytes:200000,max_chunks:100,max_revisions:100,max_seq:100};
async function fixture(t:test.TestContext,skip=-1){
  const root=await fs.mkdtemp(join(tmpdir(),'call-replay-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),writer=new RawArchive(storage,200000,()=>at,budget);
  const key=join(root,'key');await fs.writeFile(key,Buffer.alloc(32,7).toString('base64'));
  const cipher=await loadRegistryCipher(key),registry=new VoiceprintRegistry(storage,model,{cipher});
  await registry.enrollOwner({speaker_model:model,channel:'phone_app',mode:'replace',at,
    samples:Array.from({length:5},()=>({embedding:owner,speech_ms:2000}))});
  await registry.identify(guest,{speech_ms:2500,observed_at:at,mode:'observe'});await registry.close();
  const binding={userId:'owner',deviceId:'phone',continuityId:'fixture'} as SourceMediaCaptureBinding;
  const clock=createSourceMediaClock(storage,{evidence:'synthetic',resolve:async(_binding,c)=>({modality:c.modality,track_id:c.track_id,
    stream_epoch:c.stream_epoch,source_timebase_id:c.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:Date.parse(at),
    drift_ppm:1000,uncertainty_ms:1,basis_ref:'fixture'})});
  let saved:Awaited<ReturnType<typeof writer.streams.append>>|undefined;
  for(let seq=0;seq<17;seq++){if(seq===skip)continue;
    const payload=Buffer.alloc(8192);for(let n=0;n<4096;n++)payload.writeInt16LE(Math.round(Math.sin((n+seq*4096)/15)*12000),n*2);
    const chunk={track_id:'microphone',stream_epoch:'epoch1',seq,modality:'audio' as const,format:'pcm_s16le:16000:1',
      source_range:{kind:'interval' as const,timebase_id:'call-samples',stream_epoch:'epoch1',start_ms:seq*256,end_ms:(seq+1)*256}};
    const timing=await clock.capture(binding,chunk);
    const raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:pcmEventId(binding.continuityId,chunk.stream_epoch),device_id:'phone',device_type:'phone',
      ...timing.metadata,source:{channel:'livekit',capture_timing:timing.capture_timing},media_type:'audio',mime:'audio/pcm',
      representation:'received_decoded_sample',payload};
    saved=await writer.streams.append(raw,trusted,at,chunk);
  }
  const original={read:storage.read.bind(storage)},archive=new RawArchive(memoryOverlay(original),200000,()=>at,budget);
  const baseline=new VoiceprintRegistry(memoryOverlay(original),model,{cipher,call_learning:false});
  const candidate=new VoiceprintRegistry(memoryOverlay(original),model,{cipher,call_learning:true});
  for(let i=0;i<5;i++){const z=(i-2)*0.02,seed=vector(0.7,Math.sqrt(0.51-z*z),z);
    await candidate.identify(seed,{speech_ms:1200,observed_at:new Date(Date.parse(at)+(i-5)*1200).toISOString(),mode:'call'});}
  t.after(async()=>{await baseline.close();await candidate.close();await writer.close();await storage.close();});
  return {root,storage,archive,baseline,candidate,selection:{principal:'owner',raw_ref:saved!.event.raw_ref,track:'microphone',epoch:'epoch1',start_ms:0,end_ms:4352,
    revision:saved!.event.archive_revision}};
}
async function snapshot(root:string):Promise<unknown>{
  const rows:unknown[]=[];
  for(const dir of await fs.readdir(root,{withFileTypes:true})){
    if(dir.isDirectory())for(const file of await fs.readdir(join(root,dir.name))){const path=join(root,dir.name,file),stat=await fs.stat(path);
      rows.push([dir.name,file,stat.size,stat.mtimeMs,(await fs.readFile(path)).toString('base64')]);}
    else rows.push([dir.name,(await fs.readFile(join(root,dir.name))).toString('base64')]);
  }return rows;
}
const controlled=()=>{let at=0,embedded=0,closed=false;const vector=()=>at<=22528?reply:at<=45056?tv:guest;return {
  openCallVad:async()=>({write:async(pcm:Float32Array)=>{at+=pcm.length;
    return at===512?[{at,start:0}]:at===22528?[{at,end:20480}]:at===25088?[{at,start:24576}]:at===45056?[{at,end:43008}]:at===47616?[{at,start:47104}]:at===67584?[{at,end:65536}]:[];},
    close:async()=>{closed=true;}}),
  embedCall:async(pcm:Float32Array)=>{assert.ok(pcm.length<=19200);assert.ok(pcm.some(x=>x!==0));embedded++;return vector();},
  embed:async(pcm:Float32Array)=>{assert.ok(pcm.length<=160000);assert.ok(pcm.some(x=>x!==0));embedded++;return vector();},
  stats:()=>({embedded,closed})};};
test('actual L5 replay emits only acoustic diagnostics; learning stays in memory and source bytes remain unchanged',async t=>{
  const f=await fixture(t),before=await snapshot(f.root),engine=controlled(),rows:unknown[]=[];
  const observed:string[]=[],identify=f.candidate.identify.bind(f.candidate);
  f.candidate.identify=async(e,input)=>{observed.push(input.observed_at);return identify(e,input);};
  await replayCall(f.selection,{...f,engine,emit:row=>rows.push(row)});
  assert.ok(new Set(observed).size>2,'each replay update uses its mapped window end, not the event anchor');
  assert.equal(observed.at(-1),'2026-10-17T00:00:04.100Z');
  const output=rows.map(row=>JSON.stringify(row)).join('\n');
  assert.ok(engine.stats().embedded>2);assert.equal(engine.stats().closed,true);
  assert.doesNotMatch(output,/transcript|text|asr|raw_ref|principal|embedding|phone\//i);
  const decoded=rows as {event:string;speech_ms:number;window_ms:number;baseline:{channels_after:Record<string,number>};candidate:{channels_after:Record<string,number>}}[];
  assert.equal(decoded.filter(r=>r.event==='utterance').length,3);
  assert.ok(decoded.some(r=>r.event==='verify'));assert.ok(decoded.every(r=>r.window_ms<=1200));
  assert.ok((decoded as any[]).some(r=>r.candidate.window_ms>1200));
  assert.ok((decoded as any[]).every(r=>r.candidate.window_ms===r.speech_ms));
  assert.ok(decoded.every(r=>r.baseline.channels_after.call===undefined));
  assert.ok(decoded.some(r=>r.candidate.channels_after.call!>0.9));
  const finals=rows.filter(row=>(row as {event:string}).event==='utterance') as any[];
  assert.equal(finals[0].baseline.verdict,'uncertain');assert.equal(finals[0].candidate.verdict,'owner');
  assert.equal(finals[0].candidate.call_only,true);assert.equal(finals[1].candidate.utterance_verdict,'blocked');
  assert.equal(finals[2].candidate.verdict,'guest');
  assert.equal(finals[1].candidate.channels_after.phone_app,.42);assert.ok(finals[1].candidate.channels_after.call>.9);
  for(const row of finals)console.log(JSON.stringify(row));
  assert.deepEqual(await snapshot(f.root),before);
  console.log(JSON.stringify({events:rows.length,utterances:3,max_window_ms:Math.max(...decoded.map(r=>r.window_ms)),original_unchanged:true}));
});
test('candidate replay admits a verified whole utterance after an unknown prefix',async t=>{
  const f=await fixture(t),rows:any[]=[];
  f.candidate.identify=async(_embedding,input)=>input.speech_ms<1200?
    {kind:'unknown',reason:'unmatched'}:{kind:'owner',band:'verified',score:.9};
  await replayCall(f.selection,{...f,engine:controlled(),emit:r=>rows.push(r)});
  assert.ok(rows.some(r=>r.event==='verify'&&r.candidate.verdict==='unknown'));
  const final=rows.find(r=>r.event==='utterance');
  assert.equal(final.candidate.verdict,'owner');assert.equal(final.candidate.utterance_verdict,'owner');
});
test('missing sequence or wrong epoch fails before embedding and never concatenates archived gaps',async t=>{
  const f=await fixture(t,3),engine=controlled(),rows:unknown[]=[];
  await assert.rejects(replayCall(f.selection,{...f,engine,emit:r=>rows.push(r)}),/REPLAY_GAP/);
  await assert.rejects(replayCall({...f.selection,epoch:'epoch2'},{...f,engine,emit:r=>rows.push(r)}),/REPLAY_READ_BUDGET/);
  assert.equal(engine.stats().embedded,0);assert.deepEqual(rows,[]);
});
test('sub-200ms detector end stays undecided without invoking speaker embeddings',async t=>{
  const f=await fixture(t);let at=0;const rows:any[]=[];
  const engine={openCallVad:async()=>({write:async(pcm:Float32Array)=>{at+=pcm.length;
    return at===512?[{at,start:0}]:at===3072?[{at,end:1024}]:[];},close:async()=>{}}),
    embedCall:async()=>{assert.fail('short call window must not embed');return owner;},
    embed:async()=>{assert.fail('short utterance must not embed');return owner;}};
  await replayCall(f.selection,{...f,engine,emit:row=>rows.push(row)});
  assert.equal(rows.length,2);assert.equal(rows[0].speech_ms,64);assert.equal(rows[0].baseline.verdict,'undecided');
});
test('known short-input embedding failure is visible and keeps the utterance blocked after recovery',async t=>{
  const f=await fixture(t),base=controlled(),rows:any[]=[];let first=true;
  const engine={...base,embedCall:async()=>{throw new ContractError('SPEECH_INPUT_TOO_SHORT',422);},
    embed:async(pcm:Float32Array)=>{if(first){first=false;throw new ContractError('SPEECH_INPUT_TOO_SHORT',422);}return base.embed(pcm);}};
  await replayCall(f.selection,{...f,engine,emit:r=>rows.push(r)});
  assert.equal(rows[0].candidate.reason,'SPEECH_INPUT_TOO_SHORT');assert.equal(rows[0].candidate.score,null);
  const final=rows.find(r=>r.event==='utterance');assert.equal(final.candidate.verdict,'owner');
  assert.equal(final.candidate.utterance_verdict,'blocked');assert.equal(final.baseline.utterance_verdict,'blocked');
});

test('listing verifies admitted metadata and wall clock without reading audio, transcript or registry; range and CLI work',async t=>{
  const f=await fixture(t);
  // Publication can crash after a journal object, before its committed revision alias exists.
  const orphan=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',f.selection.revision)).toString());
  orphan.event.event_id='never-committed';orphan.raw_ref=`l5:${digest({principal_id:'owner',event_id:orphan.event.event_id})}`;
  await f.storage.publish('stream-revisions',digest(orphan),Buffer.from(JSON.stringify(orphan)));
  const before=await snapshot(f.root),rows:any[]=[];
  const storage={list:f.storage.list.bind(f.storage),read:async(n:string,k:string)=>{
    assert.notEqual(n,'objects','listing must not read audio or app-event payloads');assert.notEqual(n,'voiceprints');return f.storage.read(n,k);}};
  const archive=new RawArchive(memoryOverlay(storage),200000,()=>at,budget);
  const since='2026-10-16T23:59:59.000Z',until='2026-10-17T00:00:05.000Z';
  await listCallStreams(since,until,{storage,archive,emit:r=>rows.push(r)});
  assert.deepEqual(rows,[{principal:'owner',raw_ref:f.selection.raw_ref,revision:f.selection.revision,track:'microphone',epoch:'epoch1',
    device_type:'phone',wall_start:at,wall_end:'2026-10-17T00:00:04.356Z',start_ms:0,end_ms:4352}]);
  console.log(JSON.stringify({event:'listing_fixture',...rows[0]}));
  const none:unknown[]=[];await listCallStreams(until,'2026-10-17T00:01:00Z',{storage,archive,emit:r=>none.push(r)});
  assert.deepEqual(none,[]);await assert.rejects(listCallStreams('bad',until,{storage,archive,emit:()=>assert.fail()}),/REPLAY_RANGE_INVALID/);
  assert.deepEqual(await snapshot(f.root),before);
  const config=join(f.root,'list-config.json');await fs.writeFile(config,JSON.stringify({storage_root:f.root,max_event_bytes:200000,pcm:{media:{stream_budget:budget}}}));
  // No speaker configuration/key is needed in listing mode; invoke the actual CLI in a separate process.
  // The production container mounts SHM read-only too; a writable SHM permits SQLite to update read marks.
  await fs.chmod(join(f.root,'session-records.sqlite-shm'),0o440);
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/call-voiceprint-replay.ts',import.meta.url)),
    '--list','--config',config,'--since',since,'--until',until]);
  assert.deepEqual(JSON.parse(result.stdout),rows[0]);assert.doesNotMatch(result.stdout,/transcript|speech|payload|embedding/iu);
  const originalRead=storage.read;storage.read=async(n,k)=>{
    const bytes=await originalRead(n,k);if(n!=='source-clock-bases')return bytes;
    const forged=JSON.parse(Buffer.from(bytes).toString());forged.map.offset_ms+=1000;return Buffer.from(JSON.stringify(forged));};
  await assert.rejects(listCallStreams(since,until,{storage,archive,emit:()=>assert.fail('unverified clock')}),/MEDIA_CLOCK_BASIS_DENIED/);
});

test('video replay uses its own adaptive channel and rejects unsupported selections',async t=>{
  const f=await fixture(t),engine={...controlled(),embed:async()=>vector(.8,.6)},rows:any[]=[];
  const before=await f.candidate.status() as {learned_samples:Record<string,number>};
  await replayCall({...f.selection,channel:'video'},{...f,engine,emit:r=>rows.push(r)});
  const after=await f.candidate.status() as {learned_samples:Record<string,number>};
  assert.ok(after.learned_samples.video!>0);assert.equal(after.learned_samples.call,before.learned_samples.call);
  assert.ok(rows.every(r=>r.channel==='video'));
  assert.ok(rows.some(r=>r.candidate.channels_before.video!==undefined),'the selected video set is visible in channel scores');
  await assert.rejects(replayCall({...f.selection,channel:'ambient' as 'call'},{...f,engine,emit:()=>assert.fail()}),/REPLAY_CHANNEL_INVALID/);
});

test('registry CLI reports per-set numerical facts without opening speech models or changing registry bytes',async t=>{
  const f=await fixture(t),modelFile=join(f.root,'fixture.onnx'),config=join(f.root,'registry-config.json');
  await fs.writeFile(modelFile,'synthetic model identity; never loaded for inference');
  await fs.writeFile(config,JSON.stringify({storage_root:f.root,max_event_bytes:200000,pcm:{media:{stream_budget:budget}},
    voiceprint:{speaker_model:{file:modelFile,dim:32},encryption_key_file:join(f.root,'key')}}));
  const before=await snapshot(f.root),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/call-voiceprint-replay.ts',import.meta.url)),
    '--registry','--config',config]);
  const facts=JSON.parse(stdout);
  assert.equal(facts.sets[0].channel,'phone_app');assert.equal(facts.sets[0].samples,5);
  assert.equal(facts.sets[0].verified_threshold,.65);
  assert.equal(facts.sets[0].model.sha256,model.sha256);assert.equal(facts.sets[0].stale_model,true);
  assert.equal(typeof facts.sets[0].centroid_age_ms,'number');
  assert.doesNotMatch(stdout,/embedding|source_device|principal|transcript|payload|"centroid"/iu);
  assert.deepEqual(await snapshot(f.root),before);
});
