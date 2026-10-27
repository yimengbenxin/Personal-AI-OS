import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ReadableStream,type ReadableStreamDefaultController} from 'node:stream/web';
import {RoomEvent,TrackKind,TrackSource,dispose} from '@livekit/rtc-node';
import {createFormalPcmIngress,type PcmFrame,type PcmArchiveSnapshot,type VoiceWindowPurpose} from '../src/personal-aios-formal-pcm.ts';
import {AudioConsumption} from '../../../services/personal-aios-integration/src/media/audio-consumption.ts';
import type {ArchivedEvent,RawEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {StreamArchive} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {MediaService} from '../../../services/personal-aios-integration/src/media/service.ts';
import {MediaProcessor} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {PersonalAIOSRuntime,RunAdmission} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import {sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {StoragePort} from '../../../services/personal-aios-integration/src/storage.ts';
import {MemoryStorage} from '../../../services/personal-aios-integration/tests/memory-storage-fixture.ts';
after(()=>dispose());
async function fixture(t:test.TestContext,real:false|true|'posix'=false){
  const records=new Map<string,Uint8Array>();
  const storage={publish:async(ns:string,key:string,bytes:Uint8Array)=>{const id=ns+':'+key;if(!records.has(id))records.set(id,bytes.slice());return records.get(id)!;},
    read:async(ns:string,key:string)=>{const bytes=records.get(ns+':'+key);if(!bytes)throw Object.assign(new Error('missing'),{code:'ENOENT'});return bytes;}} as StoragePort;
  const routes=new AudioConsumption(storage,65536),errors:unknown[]=[],events:ArchivedEvent[]=[];
  const binding={continuityId:'continuity',connectionEpoch:'1',userId:'owner',deviceId:'phone'};
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc',consent_ref:'consent',route_version:'route',submission:'observation'};
  const track={sid:'microphone'},publication={track,kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE};
  const peer={identity:'terminal',trackPublications:new Map([['mic',publication]])};
  const room=Object.assign(new EventEmitter(),{isConnected:true,remoteParticipants:new Map([['terminal',peer]])});
  let controller!:ReadableStreamDefaultController<PcmFrame>,hold:Promise<void>|undefined;
  let tapped=Promise.withResolvers<void>();
  let appended=Promise.withResolvers<void>();
  let archived:Promise<PcmArchiveSnapshot|undefined>|undefined;
  const maps=new Map<string,TrackChunk>();
  let runtime:PersonalAIOSRuntime|undefined,runtimeStorage:StoragePort|undefined,backlogged=0,finalized=0;
  let finalization=Promise.withResolvers<void>();
  if(real){
    const directory=real==='posix'?await mkdtemp(join(tmpdir(),'paios-pcm-history-')):undefined;
    const storage:StoragePort=directory?new PosixStorage(directory):new MemoryStorage();
    runtimeStorage=storage;
    const budget={max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20};
    const archive=new RawArchive(storage,10000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
    const processor=new MediaProcessor(storage,new Map(),{policy_version:'test',max_inflight:1,max_input_bytes:10000,timeout_ms:1000,allow_external:false,allow_replay:true,allow_partial:true});
    const media=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[],vad:{candidates:async()=>[]},
      align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:1000,fixtureOnly:true});
    const native={create:async()=>{throw new Error('cancelled audio must not create a run');},status:async()=>{throw new Error('unexpected run');},cancel:async()=>{throw new Error('unexpected run');}};
    const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'test'});
    runtime=new PersonalAIOSRuntime({storage,archive,media,admission,native,output:new OutputAuthority(storage),
      devices:[{...source,device_type:'phone',route_version:'route',output_modes:['text'],token_sha256:sha256('token')}],
      skill:'test',max_read_bytes:10000,audio_route:async(_source,event)=>ingress.route(event)});
    t.after(async()=>{await runtime!.close();await processor.close();if(directory)await rm(directory,{recursive:true,force:true});});
  }
  const ingress:ReturnType<typeof createFormalPcmIngress>=createFormalPcmIngress({participant:{roomPort:room} as never,
    authority:{credentialForBootstrap:()=>({}),authenticate:async()=>source,capture:async()=>({binding,trusted:source})} as never,
    runtime:{authenticate:async()=>runtime?runtime.authenticate('token'):source,existingArchive:()=>runtime?runtime.existingArchive():({prepareCapture:async()=>{}}),
      archivedAudioRoute:(event:ArchivedEvent)=>runtime?runtime.archivedAudioRoute(event):routes.existingRoute(event),
      appendMedia:async(raw:RawEvent,_source:unknown,chunk:TrackChunk,_signal:unknown,lifecycle:{onDurable():void;beforeConsume:Promise<unknown>;consume?:boolean})=>{
        if(runtime){
          const work=runtime.appendMedia(raw,await runtime.authenticate('token'),chunk,undefined,{...lifecycle,onDurable:()=>{lifecycle.onDurable();appended.resolve();},beforeConsume:Promise.all([lifecycle.beforeConsume,hold])});
          const result=await work;events.push(result.event);maps.set(result.event.event_id,chunk);if(lifecycle.consume===false)backlogged++;return result;
        }
        const event={...raw,principal_id:'owner',consent_ref:'consent',raw_ref:'l5:'+raw.event_id,archive_revision:'revision',
          archive_status:'durable',origin:'device_observation',user_identity:'unknown'} as ArchivedEvent;
        maps.set(event.event_id,chunk);events.push(event);lifecycle.onDurable();appended.resolve();
        if(hold)await hold;
        const requested=await ingress.route(event);await routes.select(event,requested?.consumer==='voice'?'finite':'continuous',requested);
        return {event};
      }} as never,
    clock:{capture:async()=>({metadata:{captured_at:'2030-01-01T00:00:00.000Z'},capture_timing:{basis_ref:'controlled-clock',quality:'synthetic',uncertainty_ms:0}}),
      archivedReceiptClockMaps:async(_principal:string,event:ArchivedEvent)=>{const chunk=maps.get(event.event_id)!;return [{modality:'audio',track_id:'microphone',stream_epoch:chunk.stream_epoch,
        source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:0,drift_ppm:0,uncertainty_ms:0,basis_ref:'test'}];}} as never,
    ...(real?{finishArchived:async(snapshot:PcmArchiveSnapshot,endedBy?:string)=>{await runtime!.finalizeMediaSession(snapshot.event,snapshot.chunk,endedBy);finalized++;finalization.resolve();finalization=Promise.withResolvers();}}:{}),
    budget:{max_frame_samples:1600,max_pending_frames:real?1:10,max_pending_bytes:32000,max_samples:16000},input_contract:'interval_v2',
    streamFactory:()=>new ReadableStream<PcmFrame>({start:value=>{controller=value;}}),onError:error=>errors.push(error)});
  ingress.tap((_pcm,archive)=>{archived=archive;tapped.resolve();});
  const input={bearer:{deviceId:'phone'},currentBinding:{credentialIdentity:'terminal',connectionEpoch:'1'},enabledMedia:{audio:true}};
  t.after(()=>ingress.close());
  return {ingress,events,errors,routes,room,runtime,runtimeStorage,backlogged:()=>backlogged,finalized:()=>finalized,whenFinalized:()=>finalization.promise,connect:()=>ingress.onBootstrapConnected(input as never),hold:(wait?:Promise<void>)=>{hold=wait;},
    frame:async()=>{tapped=Promise.withResolvers();appended=Promise.withResolvers();controller.enqueue({data:new Int16Array([1]),sampleRate:16000,channels:1,samplesPerChannel:1});await tapped.promise;if(real){await appended.promise;}return {archived:archived!,appended:appended.promise};}};
}

test('one PCM owner accepts more than 4096 committed and cancelled unique voice windows',async t=>{
  const f=await fixture(t);await f.connect();
  for(let n=0;n<4100;n++){
    const purpose:VoiceWindowPurpose=n%2?'voiceprint':'request',operation='commit-'+n;
    await f.ingress.voice.open(operation,purpose);await (await f.frame()).archived;
    const committed=await f.ingress.voice.commit(operation,purpose);
    assert.equal(committed.event_id,f.events.at(-1)!.event_id);
    await f.ingress.voice.open('cancel-'+n,purpose);assert.equal(f.ingress.voice.cancel('cancel-'+n),true);
  }
  await f.connect();await f.ingress.voice.open('after-bootstrap');assert.equal(f.ingress.voice.cancel('after-bootstrap'),true);
  for(const event of [f.events[0]!,f.events[1]!,f.events.at(-1)!])
    assert.equal((await f.ingress.route(event))!.consumer,event===f.events[0]?'voice':'audit_only');
  assert.deepEqual(f.errors,[]);
});

test('cancelled publication keeps its original purpose through reconnect and delayed archive',async t=>{
  const f=await fixture(t);await f.connect();
  for(const purpose of ['request','voiceprint'] as const){
    const gate=Promise.withResolvers<void>();f.hold(gate.promise);
    await f.ingress.voice.open(purpose,purpose);const publication=await f.frame();
    await publication.appended;
    assert.equal(f.ingress.voice.cancel(purpose),true);
    await assert.rejects(f.ingress.voice.commit(purpose,purpose),/VOICE_WINDOW_REQUIRED/);
    for(let n=0;n<4100;n++){await f.ingress.voice.open('empty-'+purpose+n);f.ingress.voice.cancel('empty-'+purpose+n);}
    f.hold();gate.resolve();await publication.archived;
    const event=f.events.at(-1)!;assert.equal((await f.ingress.route(event))!.consumer,purpose==='request'?'voice':'audit_only');
  }
  f.room.emit(RoomEvent.Reconnecting);f.room.emit(RoomEvent.Reconnected);await f.connect();
  assert.equal((await f.ingress.route(f.events[0]!))!.consumer,'voice');
  assert.equal((await f.ingress.route(f.events[1]!))!.consumer,'audit_only');
  assert.deepEqual(f.errors,[]);
});


for(const backend of ['memory','posix'] as const)test(backend==='memory'
  ?'real runtime retires over 4096 nonempty cancelled windows whose every frame skips processing'
  :'POSIX runtime retains cancelled request and voiceprint originals and session ends',{timeout:120000},async t=>{
  // All 4100 identities exercise the real owners in memory; both purposes also cross the POSIX boundary.
  const count=backend==='memory'?4100:2;
  const gate=Promise.withResolvers<void>();t.after(()=>gate.resolve());
  const f=await fixture(t,backend==='posix'?'posix':true);await f.connect();
  f.hold(gate.promise);
  // One archived ambient append owns the processing quota while voice appends keep archiving.
  const ambient=await f.frame();
  for(let n=0;n<count;n++){
    const purpose:VoiceWindowPurpose=n%2?'voiceprint':'request',operation='backlogged-'+n;
    await f.ingress.voice.open(operation,purpose);const snapshot=await (await f.frame()).archived;assert.ok(snapshot);
    assert.equal(snapshot.processing_admission?.error_code,'FORMAL_PCM_PROCESSING_BACKLOG');
    const finalized=f.whenFinalized();
    assert.equal(f.ingress.voice.cancel(operation),true);
    assert.equal((await f.runtime!.archivedAudioRoute(snapshot.event))?.consumer,purpose==='request'?'voice':'audit_only');
    // Let this lane's exhaustion finish; the older ambient append remains blocked.
    await finalized;
    assert.equal(f.finalized(),n+1);
    const archive=f.runtime!.existingArchive();
    assert.deepEqual(Buffer.from((await archive.readExactChunk(snapshot.event,snapshot.chunk,2)).bytes),Buffer.from([1,0]));
    const end=JSON.parse(Buffer.from(await f.runtimeStorage!.read('session-ends',snapshot.event.raw_ref.slice(3))).toString());
    assert.equal(end.ended_by,'voice_cancel');
  }
  assert.equal(f.backlogged(),count);f.hold();gate.resolve();await ambient.archived;
  f.room.emit(RoomEvent.Reconnecting);f.room.emit(RoomEvent.Reconnected);await f.connect();
  await f.ingress.voice.open('after-backlog');f.ingress.voice.cancel('after-backlog');
  for(const event of [f.events[0]!,f.events[1]!,f.events[count-1]!])
    assert.equal((await f.ingress.route(event))?.consumer,(await f.runtime!.archivedAudioRoute(event))?.consumer);
  assert.ok(f.errors.every(error=>String(error).includes('FORMAL_PCM_PROCESSING_BACKLOG')));
});
