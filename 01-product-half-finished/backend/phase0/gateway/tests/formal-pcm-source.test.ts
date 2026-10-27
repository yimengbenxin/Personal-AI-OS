import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {RunAdmission} from '../../../services/personal-aios-integration/src/admission.ts';
import assert from 'node:assert/strict';
import test, {after,type TestContext} from 'node:test';
import {promises as fs} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {ReadableStream, type ReadableStreamDefaultController} from 'node:stream/web';
import {AudioSource,LocalAudioTrack,DataPacketKind,RoomEvent,TrackKind,TrackSource,VideoBufferType,VideoFrame,dispose,type VideoFrameEvent} from '@livekit/rtc-node';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {AvatarProfileService} from '../src/avatar-profile.ts';
import {PHONE_CAPABILITIES,MAC_CAPABILITIES} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {FormalPcmResources} from '../src/persistent-public-execution-owner.ts';
import {FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import type {PcmFrame,PcmArchiveSnapshot} from '../src/personal-aios-formal-pcm.ts';
import {mappedRange} from '../../../services/personal-aios-integration/src/media/align.ts';
import {LiveKitCloudParticipant,type LiveKitCloudParticipantPort} from '../src/livekit-cloud-participant.ts';
import {createVoiceCallSession,FIRST_AUDIO_CONFIRM_MS} from '../src/voice-call-session.ts';
import {CALL_PCM_LIMITS} from '../src/call-playout.ts';
import {createViduLiveJournal} from '../src/vidu-live-journal.ts';
import {createCallCamera} from '../src/personal-aios-call-camera.ts';
import {createCallVideoEncoder,callVideoResourcesSnapshot} from '../src/call-video-encoder.ts';
import type {RealtimeBootstrapConnectedInput} from '../src/realtime-public-control-runtime.ts';
import {createDeviceLease} from '../../../services/realtime-core/src/device-lease-state-machine.ts';
import type {RealtimeCurrentBindingProjection} from '../../../services/realtime-core/src/types.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {canonical,sha256,digest,bindRaw,ContractError,type RawEvent,type ProcessedEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {NativeClient,NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type {Capability,WorkerPort,WorkerRequest} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {controlledDetector,fakeSpeechConfig,testJournal,realModelsPresent,realSpeechConfig} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import type {MediaReplayConfiguration} from '../../../services/personal-aios-integration/src/media/configuration.ts';
import {AmbientJournal} from '../../../services/personal-aios-integration/src/ambient/journal.ts';
import {LocalSpeechEngine} from '../../../services/personal-aios-integration/src/voiceprint/engine.ts';
import {parseMediaReplayConfiguration} from '../../../services/personal-aios-integration/src/media/setup.ts';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createQwenVoiceResources} from '../../../services/personal-aios-integration/src/voice/qwen-resources.mjs';
import {createFormalVoiceAuthority} from '../../../services/personal-aios-integration/src/voice/formal-authority.ts';
import {createReceiptClockProvider} from '../src/source-media-receipt-clock.ts';
import {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import {RealtimePublicControlController} from '../src/realtime-public-control-controller.ts';
import {CareAuthority} from '../../../services/personal-aios-integration/src/care/authority.ts';
import {inspectWav,wavSamples} from '../../../services/personal-aios-integration/src/tts.ts';
import {RealtimePublicControlRuntime} from '../src/realtime-public-control-runtime.ts';
import {createRuntimeCredentialFenceAdmission} from '../src/realtime-public-control-pg-composition.ts';
import {SourceMediaAdmissionError} from '../src/source-media-admission.ts';
import {createCredentialFencePgFixture} from './credential-fence-pg-fixture.ts';
import {RuntimeEventStore,installRuntimeEventStore} from '../../../services/personal-aios-integration/src/self-events.ts';
after(()=>dispose());

// Session/signing/RTC ports are controlled; refresh admission and the production execution owner are real.
async function shutdownRuntime(f:Awaited<ReturnType<typeof fixture>>, fence:Awaited<ReturnType<typeof createCredentialFencePgFixture>>['fence'],
  refreshGate?:()=>Promise<void>) {
  const binding=f.input.currentBinding,governance=f.input.governance,expires=new Date(f.base+600000).toISOString();
  const tuple={realtime_session_ref:binding.realtimeSessionRef,device_lease_ref:binding.deviceLeaseRef,
    continuity_id:binding.continuityId,connection_epoch:binding.connectionEpoch,transport_aliases:['shutdown-room']};
  const start={kind:'explicit_user_start',device_id:'phone',modalities:['data','audio'],started_at:new Date(f.base).toISOString()};
  const grants={room:'room',roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:true,canPublishSources:['microphone'] as const};
  const grant={enabled:true,device_id:'phone',device_lease_ref:tuple.device_lease_ref,start_binding:start,expires_at:expires};
  const authority={...tuple,server_url:'wss://project.livekit.cloud',credential_expires_at:expires,
    continuity_expires_at:new Date(f.base+1800000).toISOString(),credential_generation:'1',terminal_room_name:'room',terminal_identity:'terminal',
    terminal_grants:grants,media_grants:{data:grant,audio:grant,video:{enabled:false}},governance,
    gateway:{roomName:'room',identity:'gateway',grants:{...grants,canPublish:false,canPublishSources:[]}}};
  const participant={...f.options.participant,connect:async()=>{},snapshot:()=>({connected:f.room.isConnected}),
    setReconnectAdmissionGuard:()=>{},close:async()=>{await f.options.participant.disconnect();}};
  const unused=async():Promise<never>=>{throw new Error('UNUSED_SHUTDOWN_TEST_PORT');};
  const runtime=new RealtimePublicControlRuntime({governance:{evaluate:async()=>({accepted:true,refs:governance})},
    sessions:{bootstrap:async()=>authority,refresh:async()=>{await refreshGate?.();return {...tuple,credential_expires_at:expires,
      credential_generation:'1',credential_input:{room:'room',identity:'terminal',ttlSeconds:600,grants},governance};},
      endContinuity:async({request}:{request:Record<string,unknown>})=>{f.session.state='ended';f.session.continuityState='ended';f.session.binding.state='closed';
        return {...request,status:'success'};}},
    mediaStop:{claim:unused,unpublishAllTracks:unused,disconnectParticipant:unused,complete:unused},
    e2ee:{issue:async()=>({envelope:{realtime_session_ref:tuple.realtime_session_ref,continuity_id:tuple.continuity_id,governance,
      key_envelope_ref:{alias_type:'key_envelope',issuer:'local_gateway',value:'shutdown-key'},key_index:0,key_generation:'1',expires_at:expires,
      scope:{device_id:'phone',distribution_mode:'application_controlled_envelope',channels:['audio','data']}},
      roomOptions:{encryption:{}},release:()=>{}})},e2eeCiphertext:{resolve:unused},deviceCredential:{resolve:async()=>({test:'paired-device'})},
    tokenSigner:{assertProjectUrl:()=>{},sign:async()=> 'offline-test-token',close:()=>{}},participant,
    bootstrapConnected:f.owner.bridge,credentialFenceAdmission:createRuntimeCredentialFenceAdmission(fence),now:()=>f.base} as never);
  await runtime.bootstrap({operation:'bootstrap',bootstrap_mode:'initial',device_id:'phone',request_id:'shutdown-bind',
    requested_media:{data:true,audio:true,video:false},start,governance},f.input.bearer);
  return {runtime,refresh:()=>runtime.refresh({...tuple,operation:'connected_credential_refresh',request_id:'shutdown-refresh',governance},f.input.bearer),
    end:()=>runtime.endContinuity({...tuple,operation:'end_continuity',request_id:'shutdown-end',governance},f.input.bearer)};
}

for(const batched of [false,true])for(const ended of [true,false])test(`PG shutdown drains refused appendMedia ${batched?'batch':'frame'} after refresh and media_stop, end-continuity=${ended}`,
  {skip:!process.env.DEVICE_RECEIPTS_PG_URL},async t=>{
  const f=await fixture(t,{budget:batched?{archive_batch:batchBudget}:{}}),binding=f.session.binding;
  const pg=await createCredentialFencePgFixture(t,{realtimeSessionRef:binding.realtimeSessionRef as never,
    deviceLeaseRef:binding.deviceLeaseRef,continuityId:binding.continuityId,connectionEpoch:binding.connectionEpoch,credentialGeneration:'1'});
  await f.create({credentialFence:pg.fence,retainAssembly:true});
  const control=await shutdownRuntime(f,pg.fence);t.after(()=>control.runtime.close());
  f.subscribe();f.feed();const archived=await latest(f);const before=await committedCount(f.storage);
  assert.equal((await control.refresh()).status,'credential_refreshed');assert.deepEqual(await pg.rows(),[]);
  let rejected:unknown;
  const append=f.owner.assembly.runtime.appendMedia.bind(f.owner.assembly.runtime);
  const appendBatch=f.owner.assembly.runtime.appendMediaBatch.bind(f.owner.assembly.runtime);
  t.mock.method(f.owner.assembly.runtime,'appendMedia',async(...args:Parameters<typeof append>)=>{
    try{return await append(...args);}catch(error){rejected=error;throw error;}
  });
  t.mock.method(f.owner.assembly.runtime,'appendMediaBatch',async(...args:Parameters<typeof appendBatch>)=>{
    try{return await appendBatch(...args);}catch(error){rejected=error;throw error;}
  });
  await pg.stop({beforeDisconnect:async()=>{
    assert.equal((await pg.rows())[0].effect_state,'in_flight');
    f.feed();await eventually(()=>rejected!==undefined&&f.cancelSettled);f.disconnect();
  }});
  assert.ok(rejected instanceof SourceMediaAdmissionError);assert.equal(rejected.code,'CREDENTIAL_FENCE_ACTIVE');
  assert.equal(rejected.teardown,'requested');assert.ok(f.errors.includes(rejected),'append rejection remains observable');
  assert.equal(await committedCount(f.storage),before,'denied bytes never enter the archive');
  if(ended)await control.end();
  // Fence state has no idle expiry; advance the capture owner's clock six minutes.
  f.advance(360000);
  const rows=await pg.rows();assert.equal(rows[0].effect_state,'committed');
  try{await control.runtime.close();await f.owner.bridge.close!();}catch(error){console.dir(error,{depth:7});throw error;}
  finally{assert.deepEqual(await pg.rows(),rows);console.log(JSON.stringify({shutdown_fence:ended?'ended':'stopped',effect_state:rows[0].effect_state,operation:batched?'appendMediaBatch':'appendMedia',teardown:rejected.teardown}));}
  await f.owner.assembly.close();assert.deepEqual(await pg.rows(),rows,'shutdown does not remove the durable Stop fence');
  const event=await f.owner.assembly.runtime.existingArchive().locate(archived.event.raw_ref,'owner');
  assert.equal((await f.owner.assembly.runtime.existingArchive().readRecord(event.raw_ref,'owner',event.archive_revision)).total_bytes,640);
});

test('PG shutdown after completed refresh with the client still connected',{skip:!process.env.DEVICE_RECEIPTS_PG_URL},async t=>{
  const f=await fixture(t),binding=f.session.binding;
  const pg=await createCredentialFencePgFixture(t,{realtimeSessionRef:binding.realtimeSessionRef as never,
    deviceLeaseRef:binding.deviceLeaseRef,continuityId:binding.continuityId,connectionEpoch:binding.connectionEpoch,credentialGeneration:'1'});
  await f.create({credentialFence:pg.fence,retainAssembly:true});const control=await shutdownRuntime(f,pg.fence);
  t.after(()=>control.runtime.close());f.subscribe();f.feed();await latest(f);
  assert.equal((await control.refresh()).status,'credential_refreshed');assert.equal(f.room.isConnected,true);
  await control.runtime.close();await f.owner.assembly.close();assert.deepEqual(await pg.rows(),[]);assert.deepEqual(f.errors,[]);
});

test('PG shutdown during an in-flight credential refresh without end-continuity',{skip:!process.env.DEVICE_RECEIPTS_PG_URL},async t=>{
  const f=await fixture(t),binding=f.session.binding,entered=latch(),release=latch();t.after(()=>release.release());
  const pg=await createCredentialFencePgFixture(t,{realtimeSessionRef:binding.realtimeSessionRef as never,
    deviceLeaseRef:binding.deviceLeaseRef,continuityId:binding.continuityId,connectionEpoch:binding.connectionEpoch,credentialGeneration:'1'});
  await f.create({credentialFence:pg.fence,retainAssembly:true});
  const control=await shutdownRuntime(f,pg.fence,async()=>{entered.release();await release.promise;});
  t.after(()=>control.runtime.close());f.subscribe();f.feed();await latest(f);
  const refreshing=control.refresh();const rejected=assert.rejects(refreshing,/REALTIME_REFRESH_BINDING_UNKNOWN/);
  await entered.promise;await control.runtime.close();release.release();await rejected;
  await f.owner.assembly.close();assert.deepEqual(await pg.rows(),[]);
});

test('shutdown still rejects an actual PCM reader teardown failure',async t=>{
  const cancel=Promise.withResolvers<void>(),f=await fixture(t,{cancelWait:cancel.promise});await connect(f);f.feed();await latest(f);
  const closing=Promise.resolve(f.owner.bridge.close!());cancel.reject(new Error('reader cancel failed'));
  await assert.rejects(closing,error=>{
    assert.ok(error instanceof AggregateError);assert.ok(error.errors.some((cause:Error)=>cause.message==='FORMAL_PCM_SOURCE_STOP_FAILED'));return true;
  });
});

test('shutdown still rejects failed admission teardown and preserves real archive failure',async t=>{
  const cancel=Promise.withResolvers<void>(),f=await fixture(t,{cancelWait:cancel.promise});await connect(f);f.feed();await latest(f);
  f.block();f.feed();await eventually(()=>f.cancels===1);cancel.reject(new Error('reader cancel failed'));
  await eventually(()=>f.errors.some(error=>error instanceof SourceMediaAdmissionError&&error.teardown==='failed'));
  await assert.rejects(Promise.resolve(f.owner.bridge.close!()),/PERSISTENT_PUBLIC_EXECUTION_CLEANUP_FAILED/);
  const archived=await fixture(t);await connect(archived);archived.feed();const prefix=await latest(archived);
  t.mock.method(archived.owner.assembly.runtime.existingArchive(),'admitStream',async()=>{throw Object.assign(new Error('archive I/O failed'),{code:'EIO'});});
  archived.feed();await eventually(()=>archived.errors.length>0);
  await assert.rejects(Promise.resolve(archived.owner.bridge.close!()),/PERSISTENT_PUBLIC_EXECUTION_CLEANUP_FAILED/);
  const record=await archived.owner.assembly.runtime.existingArchive().readRecord(prefix.event.raw_ref,'owner',prefix.event.archive_revision);
  assert.equal(record.total_bytes,640,'archive failure preserves the already committed prefix');
});
// Scripted DashScope socket (ws ABI): one completed transcription after an input commit. Not a real cloud call.
class ScriptedQwenSocket extends EventEmitter {
  static OPEN=1;static appended:string[]=[];static sockets:ScriptedQwenSocket[]=[];readyState=1;bufferedAmount=0;sent:Record<string,any>[]=[];
  constructor(){super();ScriptedQwenSocket.sockets.push(this);queueMicrotask(()=>{this.emit('open');this.incoming({type:'session.created'});});}
  incoming(event:unknown){this.emit('message',Buffer.from(JSON.stringify(event)));}
  send(wire:string){const event=JSON.parse(wire);this.sent.push(event);
    if(event.type==='session.update')queueMicrotask(()=>this.incoming({type:'session.updated'}));
    if(event.type==='input_audio_buffer.append')ScriptedQwenSocket.appended.push(event.audio);
    if(event.type==='input_audio_buffer.commit')setTimeout(()=>this.incoming({type:'conversation.item.input_audio_transcription.completed',
      item_id:'item:window',transcript:'帮我记下明天早上八点骑行。'}),5);}
  close(){this.readyState=3;queueMicrotask(()=>this.emit('close'));}terminate(){this.close();}
}

const sessionTemplate={ref_type:'RealtimeSession',ref_id:'01900000-0000-7000-8000-000000000001',object_version:'1',canonical_payload_sha256:'a'.repeat(64)} as const;
const leaseTemplate={...sessionTemplate,ref_type:'DeviceLease',ref_id:'01900000-0000-7000-8000-000000000002'} as const;
const principal={opaque:'controlled-principal'};
const packet={requested_media:{data:true,audio:true,video:false},start:{modalities:['data','audio']}};
const capability:Capability={id:'controlled-pcm',version:'source-fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],
  joint_av:false,healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'deterministic_replay'};
function waveform(variant=0,count=320):PcmFrame {
  const data=new Int16Array(count);
  for(let n=0;n<count;n++)data[n]=Math.round(Math.sin(n/(variant+7))*12000)+(variant?17:0);
  return {data,sampleRate:16000,channels:1,samplesPerChannel:count};
}
function pcmBytes(frame:PcmFrame) {
  const bytes=Buffer.alloc(frame.data.length*2);
  for(let n=0;n<frame.data.length;n++)bytes.writeInt16LE(frame.data[n]!,n*2);
  return bytes;
}
async function committedCount(storage:PosixStorage){
 let count=0;for(const key of await storage.list('stream-revisions')){const m=JSON.parse(Buffer.from(await storage.read('stream-revisions',key)).toString());if(key===digest([m.raw_ref,m.revision]))count++;}return count;
}
async function sessionEnd(storage:PosixStorage,rawRef:string){
 return JSON.parse(Buffer.from(await storage.read('session-ends',rawRef.slice(3))).toString());
}
async function assertSessionEnded(storage:PosixStorage,rawRef:string,endedBy:string){
 const end=await sessionEnd(storage,rawRef);assert.equal(end.raw_ref,rawRef);assert.equal(end.ended_by,endedBy);
 assert.equal(await storage.readFinal(rawRef),null,'capture end records intent before maintenance folds the session');
}
// One current registrar: TrackSubscribed, TrackUnsubscribed, Reconnecting, Reconnected, Disconnected.
const REGISTRAR_LISTENERS=5;
const ioTimeout=setTimeout; // Keep loopback IO polling live when a rejoin test advances the server timer.
async function eventually(predicate:()=>boolean|Promise<boolean>) {
  for(let n=0;n<2000;n++){if(await predicate())return;await new Promise(resolve=>ioTimeout(resolve,5));}
  throw new Error('CONTROLLED_SOURCE_TEST_TIMEOUT');
}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

// Continuous D are ambient speech: journaled, never a run (wake turns are covered by the integration's ambient-lane tests).
async function fixture(t:TestContext, overrides:{camera?:boolean;sdk?:boolean;budget?:Partial<FormalPcmResources['budget']>;clockMissing?:boolean;cancelWait?:Promise<void>;continuous?:boolean;span?:boolean;interval?:boolean;voice?:boolean;receiptClock?:boolean;voiceprint?:boolean;directoryRoot?:string;terminal?:{deviceId:string;deviceType:'phone'|'glasses'|'mac';capabilities?:readonly import('../../../services/personal-aios-integration/src/source-authority.ts').TerminalCapability[]}}={}) {
  const deviceId = overrides.terminal?.deviceId ?? 'phone', deviceType = overrides.terminal?.deviceType ?? 'phone';
  const continuityId = deviceId==='phone'?'continuity':`continuity:${deviceId}`, identity = deviceId==='phone'?'terminal':`terminal:${deviceId}`;
  const sessionRef = {...sessionTemplate,ref_id:deviceId==='phone'?sessionTemplate.ref_id:'01900000-0000-7000-8000-000000000003'};
  const leaseRef = {...leaseTemplate,ref_id:deviceId==='phone'?leaseTemplate.ref_id:'01900000-0000-7000-8000-000000000004'};
  const directory=await fs.mkdtemp(join(overrides.directoryRoot??tmpdir(),'paios-formal-pcm-'));
  const storage=new PosixStorage(join(directory,'data'));
  const base=Date.now();let now=base,blocked=false,locked=false,cancels=0,legacy=0,sourceReads=0,clockReads=0;
  let mutate:undefined|(()=>void),modelWait:Promise<void>|undefined,sourceWait:Promise<void>|undefined,clockWait:Promise<void>|undefined;
  let cancelSettled=false,streams=0,disconnects=0;
  const contexts:{generation:string;locked:boolean}[]=[],errors:unknown[]=[],requests:WorkerRequest[]=[],nativeInputs:ProcessedEvent[]=[],admissions:unknown[]=[],raws:RawEvent[]=[],published:unknown[]=[];
  const runs=new Map<string,NativeRun>(),journal=overrides.continuous?(overrides.directoryRoot?AmbientJournal.open(join(directory,'ambient-journal')):await testJournal(t)):undefined;
  const policy='controlled-policy';
  let lease=createDeviceLease({deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId,userId:'owner',
    deviceId,issuedAt:new Date(base).toISOString() as never,policy:{allowed:true,capabilities:overrides.camera?['data','audio','video']:['data','audio'],
      purpose:'assistant',leaseExpiresAt:new Date(base+1800000).toISOString() as never,revocable:true,policyDecisionRef:policy}});
  const session={realtimeSessionRef:sessionRef,userId:'owner',continuityId,state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:new Date(base+1800000).toISOString(),activeDeviceId:deviceId,activeDeviceLeaseRef:leaseRef,
    revision:'1',binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId,deviceId,connectionEpoch:'1'}};
  const input={request:{request_id:'controlled-bootstrap'},bearer:{principal,deviceId},governance:{controlled:true},
    authority:{gateway:{identity:'controlled-gateway',roomName:'room'},credential_expires_at:new Date(base+60000).toISOString()},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId,connectionEpoch:'1',credentialIdentity:identity,credentialRoom:'room'},
    enabledMedia:{data:true,audio:true,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const t03={ownerContext:{resolve:async()=>({userId:'owner',deviceId,purpose:'assistant',capabilities:overrides.camera?['data','audio','video']:['data','audio'],occurredAt:new Date(now).toISOString()})},
    formalWatchPrimaryAuthority:{resolve:async()=>({userId:'owner',deviceId,principalRef:principal,policyDecisionRef:policy})},
    readCurrentAuthority:()=>({deviceType,capabilities:overrides.terminal?.capabilities ?? (deviceType==='phone'?PHONE_CAPABILITIES:['display','speaker','microphone','continuous_audio'] as const),userId:'owner',deviceId,principal,policyDecisionRef:policy,allowedMediaCapabilities:overrides.camera?['data','audio','video']:['data','audio'],
      governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'controlled-consent'}]}})};
  const listeners=new Map<string,Set<(...args:readonly unknown[])=>void>>();
  const emit=(event:string,...args:unknown[])=>{for(const listener of [...listeners.get(event)??[]])listener(...args);};
  const track=Object.freeze({controlled:'microphone'}),publication={kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE,sid:'controlled-mic',track};
  const remoteParticipants=new Map<string, {identity:string;trackPublications:Map<string,typeof publication>}>();
  const addExisting=(remoteIdentity=identity)=>{const peer={identity:remoteIdentity,trackPublications:new Map([[publication.sid,publication]])};remoteParticipants.set(remoteIdentity,peer);emit(RoomEvent.ParticipantConnected,peer);};
  const room={isConnected:true,remoteParticipants,on:(event:string,listener:(...args:readonly unknown[])=>void)=>{
    const group=listeners.get(event)??new Set();group.add(listener);listeners.set(event,group);},
    off:(event:string,listener:(...args:readonly unknown[])=>void)=>{listeners.get(event)?.delete(listener);},
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{published.push(JSON.parse(Buffer.from(bytes).toString()));}},connect:async()=>{assert(overrides.sdk,'REAL_ROOM_CONNECT_FORBIDDEN');},disconnect:async()=>{assert(overrides.sdk,'BORROWED_ROOM_DISCONNECT_FORBIDDEN');room.isConnected=false;emit(RoomEvent.Disconnected);}};
  const participant=overrides.sdk?new LiveKitCloudParticipant(room as never):{roomPort:room,disconnect:async()=>{disconnects++;room.isConnected=false;emit(RoomEvent.Disconnected);}} as unknown as LiveKitCloudParticipantPort;
  let controller:ReadableStreamDefaultController<PcmFrame>,streaming=false;
  const streamFactory=()=>{streams++;return new ReadableStream<PcmFrame>({start:value=>{controller=value;streaming=true;},
    cancel:async()=>{streaming=false;cancels++;if(overrides.cancelWait)await overrides.cancelWait;cancelSettled=true;}});};
  const native:NativeClient={create:async body=>{
    nativeInputs.push(JSON.parse(body.input) as ProcessedEvent);
    const run={run_id:'controlled-native-'+nativeInputs.length,session_id:body.session_id,conversation_session_id:body.session_id,status:'running' as const};
    runs.set(run.run_id,run);return run;
  },status:async id=>({...runs.get(id)!}),cancel:async id=>{const run=runs.get(id)!;run.status='cancelled';return {...run};}};
  const worker:WorkerPort={analyze:async request=>{
    assert.equal(locked,false,'model must not hold capture fence');requests.push(structuredClone(request));
    if(modelWait)await modelWait;
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{transcript:'CONTROLLED SOURCE, NOT REAL ASR',audio_observations:['controlled PCM source']},speakers:[],
      warnings:['CONTROLLED_WORKER_NOT_REAL_MODEL'],status:'partial'};
  }};
  const configuration:MediaReplayConfiguration={fixture_only:true,
    stream_budget:{max_chunk_bytes:4096,max_total_bytes:32768,max_chunks:16,max_revisions:16,max_seq:16},
    alignment:{max_chunks:16,max_visual_refs:4,max_frame_gap_ms:100,max_uncertainty_ms:2},
    processing:{policy_version:'controlled-formal-pcm',max_inflight:2,max_input_bytes:32768,timeout_ms:10000,
      allow_external:false,allow_replay:true,allow_partial:true},max_segments:2,max_window_ms:10000,
    audio:{provider:'local_sherpa',config:fakeSpeechConfig(join(directory,'never-loaded'))}};
  const pcm:FormalPcmResources={...(overrides.interval?{input_contract:'interval_v2' as const}:{}),configuration,producer:{device_type:deviceType,channel:'rtc_pcm_and_text'},
    budget:{max_frame_samples:1024,max_pending_frames:4,max_pending_bytes:8192,max_samples:4096,...overrides.budget},streamFactory,
    ports:{workers:new Map([[capability.id,worker]]),capabilities:async()=>[capability],vad:{candidates:async request=>{
      assert.equal(locked,false);assert.equal(request.time_range.kind,'interval');
      const range=request.time_range as {start_ms:number;end_ms:number};
      return [{start_ms:range.start_ms,end_ms:range.end_ms,semantic_status:'open',basis:'controlled-not-silero'}];
    }}},...overrides.clockMissing?{}:{clock:{evidence:'synthetic',resolve:async(_binding,chunk)=>{clockReads++;if(clockWait)await clockWait;return {modality:chunk.modality,
      track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,
      target_timebase_id:'utc_epoch_ms',offset_ms:base+1,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-clock-not-hardware'};}}}};
  // Production voice config: alignment tolerance must cover the receipt clock's declared uncertainty.
  if(overrides.receiptClock){pcm.clock=createReceiptClockProvider({uncertainty_ms:500,now:()=>now});configuration.alignment.max_uncertainty_ms=1000;}
  if(overrides.span){
    pcm.span={span_id:'controlled-formal-span',modalities:['audio','visual'],anchor_range:{kind:'instant',timebase_id:'source-origin',stream_epoch:'span-origin',at_ms:50}};
    pcm.clock!.resolveSpan=async()=>({modality:'audio',track_id:'span-origin',stream_epoch:'span-origin',source_timebase_id:'source-origin',
      target_timebase_id:'utc_epoch_ms',offset_ms:base-50,drift_ppm:0,uncertainty_ms:1,basis_ref:'CONTROLLED_INDEPENDENT_SPAN_CLOCK'});
  }
  if(overrides.continuous){
    // Controlled marker detector in place of the speech engine's Silero; markers are not speech.
    pcm.continuous={budget:{max_streams:2,max_pending_chunks:8,max_pending_candidates:8,max_chunk_bytes:4096,block_samples:160000,overlap_samples:8000}};pcm.ports!.detector=controlledDetector();
  }
  const options={executionOwner:'hermes_text' as const,pcm,t03:t03 as never,readCurrentBindingInAdmission:async()=>({session,lease} as unknown as RealtimeCurrentBindingProjection),readCurrentBinding:async()=>{
    sourceReads++;if(sourceWait)await sourceWait;return {session,lease} as unknown as RealtimeCurrentBindingProjection;},deviceId,
    participant,now:()=>now,
    credentialFence:{verify:async()=>({active:blocked}),withAdmission:async(_tuple:unknown,consume:()=>Promise<unknown>)=>{
      const tuple=_tuple as {credentialGeneration:string};contexts.push({generation:tuple.credentialGeneration,locked});
      if(blocked)throw new Error('CREDENTIAL_FENCE_ACTIVE');
      mutate?.();locked=true;try{return await (consume as (client?:unknown)=>Promise<unknown>)(overrides.voice?{controlled:'admission-client'}:undefined);}finally{locked=false;}
    }} as never,
    central:{storage,native:sourceClient(native),admission:{max_pending_events:16,max_pending_bytes:65536,max_event_age_ms:60000,poll_interval_ms:5,
      native_idempotency_retention_ms:60000,policy_version:'controlled-source-admission'},skill:'controlled-source-no-model',
      max_event_bytes:4096,max_read_bytes:32768,http:{internal_token:'controlled-source-token-no-secret',max_request_bytes:65536,request_timeout_ms:10000},
      ...(journal?{ambient_journal:journal}:{}),
      ...(overrides.voiceprint?{voiceprint:new VoiceprintRegistry(storage,{id:'speaker',sha256:digest('speaker.onnx'),dim:192})}:{}),
      ...(overrides.voice?{voice:createQwenVoiceResources({configuration:{usable:true,provider:'dashscope',model:'qwen3.8-omni-flash-realtime',
        region:'cn-beijing',endpoint:'wss://scripted.invalid/api-ws/v1/realtime',voice:'Tina',instructions:'只产候选。',apiKey:'scripted-offline-only',
        WebSocket:ScriptedQwenSocket},...createFormalVoiceAuthority(storage),onError:(error:unknown)=>{errors.push(error);}})}:{})},
    onError:(error:unknown)=>{errors.push(error);}};
  let owner:Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>|undefined;
  t.after(async()=>{
    await Promise.resolve(owner?.bridge.close?.()).catch(()=>{});
    if(overrides.sdk)await participant.close();
    if(process.env.FORMAL_PCM_EVIDENCE_ROOT){await fs.mkdir(process.env.FORMAL_PCM_EVIDENCE_ROOT,{recursive:true});
      await fs.writeFile(join(directory,'source-result.json'),JSON.stringify({case:t.name,sourceReads,contexts,errors:errors.map(String),
        requests,nativeInputs,nativeRuns:[...runs.values()],admissions,raws,published,cancels,cancelSettled,streams,legacy,scope:'controlled-source-fake-model-native-synthetic-clock'},null,2));
      await fs.cp(directory,join(process.env.FORMAL_PCM_EVIDENCE_ROOT,basename(directory)),{recursive:true});}
    if(overrides.directoryRoot)journal?.close();
    await fs.rm(directory,{recursive:true,force:true});
  });
  const create=async(extra:Partial<Parameters<typeof createPersistentPublicExecutionOwner>[0]>={})=>{owner=await createPersistentPublicExecutionOwner({...options,...extra});
    if(owner.executionOwner==='hermes_text'){const append=owner.assembly.runtime.appendMedia.bind(owner.assembly.runtime);
      owner.assembly.runtime.appendMedia=async(raw,source,chunk,publicationWaitSignal,lifecycle)=>{raws.push(structuredClone(raw));return append(raw,source,chunk,publicationWaitSignal,lifecycle);};
      const batch=owner.assembly.runtime.appendMediaBatch.bind(owner.assembly.runtime);owner.assembly.runtime.appendMediaBatch=async(inputs,limit,publicationWaitSignal,lifecycle)=>{raws.push(...inputs.map(x=>structuredClone(x.raw)));return batch(inputs,limit,publicationWaitSignal,lifecycle);};}
    return owner;};
  // The continuous lane's analysed D (its journal entries name them).
  const ambient=async()=>Promise.all((await storage.list('processed-media')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-media',key)).toString()) as ProcessedEvent));
  return {storage,input,session,room,pcm,options,errors,requests,nativeInputs,runs,contexts,create,raws,published,admissions,base,track,publication,addExisting,journal,ambient,
    get owner(){assert.ok(owner?.executionOwner==='hermes_text');return owner;},
    get disconnects(){return disconnects;},get cancelSettled(){return cancelSettled;},get streams(){return streams;},get sourceReads(){return sourceReads;},get clockReads(){return clockReads;},get locked(){return locked;},get cancels(){return cancels;},get legacy(){return legacy;},
    feed:(frame=waveform())=>controller!.enqueue(frame),
    end:()=>controller!.close(),
    subscribe:(remoteIdentity=identity)=>{addExisting(remoteIdentity);emit(RoomEvent.TrackSubscribed,track,publication,{identity:remoteIdentity});},
    unsubscribe:(selected:unknown)=>emit(RoomEvent.TrackUnsubscribed,selected,publication,{identity}),
    hostConnect:async()=>{room.isConnected=true;addExisting();if(overrides.sdk)await participant.connect({projectUrl:'wss://project.livekit.cloud',roomName:'room',identity:'gateway',token:'controlled-sdk-token',
      grants:{room:'room',roomJoin:true,canPublish:false,canSubscribe:true,canPublishData:true,canPublishSources:[]},binding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId,connectionEpoch:'1',transportAliases:['controlled-room']},roomOptions:{encryption:{keyProviderOptions:{sharedKey:new Uint8Array(32)}}}});},
    sdkFrame:(frame=waveform())=>{if(streaming)controller.enqueue(frame);},
    listenerCount:()=>[...listeners.values()].reduce((sum,group)=>sum+group.size,0),
    oldSubscribed:()=>[...listeners.get(RoomEvent.TrackSubscribed)??[]][0],
    sendText:(body:unknown)=>{if(!remoteParticipants.has(identity)){const peer={identity,trackPublications:new Map<string,typeof publication>()};remoteParticipants.set(identity,peer);emit(RoomEvent.ParticipantConnected,peer);}
      emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);},
    disconnect:()=>emit(RoomEvent.Disconnected),
    remoteDisconnect:(remoteIdentity=identity)=>{remoteParticipants.delete(remoteIdentity);emit(RoomEvent.ParticipantDisconnected,{identity:remoteIdentity});},
    reconnecting:()=>emit(RoomEvent.Reconnecting),reconnected:()=>emit(RoomEvent.Reconnected),
    block:()=>{blocked=true;},renew:()=>{now=base+120000;lease={...lease,leaseVersion:'2' as never,expiresAt:new Date(base+2400000).toISOString() as never};},
    revokeAudio:()=>{lease={...lease,capabilities:['data']};},
    mutate:()=>{mutate=()=>{lease={...lease,leaseVersion:'2' as never};};},
    holdModel:(wait:Promise<void>)=>{modelWait=wait;},holdSource:(wait?:Promise<void>)=>{sourceWait=wait;},holdClock:(wait?:Promise<void>)=>{clockWait=wait;},
    expire:()=>{now=base+1800001;},advance:(ms:number)=>{now+=ms;},
  };
}
// No network or physical microphone: real pinned speech models with the existing synthetic room/source/native ports.
// Run this case alone in a fresh Node process to measure process-cold startup (OS file caches can remain warm).
test('continuous speech is ready before the first bootstrap hook and is reused on reconnect',
  {skip:!realModelsPresent},async t=>{
    const f=await fixture(t,{continuous:true,directoryRoot:tmpdir()});
    delete f.pcm.ports;
    (f.pcm.configuration as MediaReplayConfiguration).audio!.config=structuredClone(realSpeechConfig);
    f.pcm.continuous={budget:{max_streams:1,max_pending_chunks:8,max_pending_candidates:8,
      max_chunk_bytes:4096,block_samples:160000,overlap_samples:8000}};
    const open=LocalSpeechEngine.open.bind(LocalSpeechEngine);
    let speech_load_ms=0;
    const loads=t.mock.method(LocalSpeechEngine,'open',async(...args:Parameters<typeof LocalSpeechEngine.open>)=>{
      const started=performance.now();const engine=await open(...args);speech_load_ms=performance.now()-started;return engine;});
    const started=performance.now();await f.create();const startup_ms=performance.now()-started;
    assert.equal(loads.mock.callCount(),1);
    const engine=await f.owner.media!.speech!();assert.equal(engine.available(),true);
    f.addExisting();
    const first=performance.now();await f.owner.bridge.onBootstrapConnected!(f.input);
    const first_bootstrap_hook_ms=performance.now()-first;
    assert.equal(f.streams,1);const first_source_reads=f.sourceReads;assert.ok(first_source_reads>0);
    const reconnect=performance.now();await f.owner.bridge.onBootstrapConnected!(f.input);
    const reconnect_hook_ms=performance.now()-reconnect;
    assert.equal(await f.owner.media!.speech!(),engine);assert.equal(loads.mock.callCount(),1);
    assert.equal(f.streams,1);assert.ok(f.sourceReads>first_source_reads);assert.deepEqual(f.errors,[]);
    process.stdout.write(JSON.stringify({cold_pcm_composition:{startup_ms,speech_load_ms,first_bootstrap_hook_ms,reconnect_hook_ms,
      speech_loads:loads.mock.callCount(),first_source_reads,total_source_reads:f.sourceReads,scope:'real-models-synthetic-room-source-native-no-http-pg-livekit-network'}})+'\n');
});

async function connect(f:Awaited<ReturnType<typeof fixture>>) {
  await f.create();f.owner.bridge.assertBootstrapRequest!(packet);await f.owner.bridge.onBootstrapConnected!(f.input);f.subscribe();
}
test('owner camera acquisition admits audio+video+data even when the call model is disabled',async t=>{
  for(const voice of [false,true]){const f=await fixture(t,{voice});await f.create();
    assert.doesNotThrow(()=>f.owner.bridge.assertBootstrapRequest!({requested_media:{data:true,audio:true,video:true},start:{modalities:['data','audio','video']}}));}
});
test('bootstrap media admission follows each requested consumer and its exact start modalities',async t=>{
  const f=await fixture(t,{camera:true});await f.create();
  for(const audio of [false,true])for(const video of [false,true]){
    const request={requested_media:{data:true,audio,video},start:{modalities:['data',...(audio?['audio']:[]),...(video?['video']:[])]}};
    assert.doesNotThrow(()=>f.owner.bridge.assertBootstrapRequest!(request));
    assert.throws(()=>f.owner.bridge.assertBootstrapRequest!({...request,start:{modalities:[...request.start.modalities,'audio']}}),{code:'HERMES_PCM_DATA_AUDIO_REQUIRED',status:422});
  }
  assert.throws(()=>f.owner.bridge.assertBootstrapRequest!({requested_media:{data:false,audio:false,video:true},start:{modalities:['video']}}),{status:422});
});
test('validated phone capture prepares one restricted silent call front and disabled capture closes it',async t=>{
  for(const continuous of [false,true]){
    const before=ScriptedQwenSocket.sockets.length;
    const f=await fixture(t,{voice:true,continuous});await f.create();
    assert.equal(ScriptedQwenSocket.sockets.length,before,'construction opens no provider transport');
    f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
    await eventually(()=>ScriptedQwenSocket.sockets.length===before+1);
    const socket=ScriptedQwenSocket.sockets.at(-1)!;
    await eventually(()=>socket.sent.some(event=>event.type==='session.update'));
    assert.match(socket.sent.find(event=>event.type==='session.update')!.session.instructions,/身份还没有获得主人权限/);
    f.feed(waveform());await latest(f);
    assert.equal(socket.sent.some(event=>event.type==='input_audio_buffer.append'||event.type==='response.create'||event.type==='conversation.item.create'),false);
    await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:false}});
    assert.equal(socket.readyState,3);await f.owner.bridge.close?.();assert.deepEqual(f.errors,[]);
  }
});
async function latest(f:Awaited<ReturnType<typeof fixture>>,seq=0) {
  await eventually(()=>f.owner.pcmIngress?.snapshot().latest?.chunk.seq===seq);
  return f.owner.pcmIngress!.snapshot().latest!;
}
async function request(f:Awaited<ReturnType<typeof fixture>>,snapshot:Awaited<ReturnType<typeof latest>>) {
  const source=await f.owner.authority.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  const capture=await f.owner.authority.capture(f.owner.authority.credentialForBootstrap(f.input));
  const map=await f.owner.clock!.read(capture.binding,snapshot.chunk);assert.ok(map);
  assert.equal(snapshot.chunk.source_range.kind,'interval');
  const range=snapshot.chunk.source_range as {start_ms:number;end_ms:number};
  return {source,request:{raw_ref:snapshot.event.raw_ref,archive_revision:snapshot.event.archive_revision,
    time_range:{kind:'interval' as const,timebase_id:'utc_epoch_ms',start_ms:map.offset_ms+range.start_ms,end_ms:map.offset_ms+range.end_ms},clock_maps:[map]}};
}
test('same public owner: normal and unseen PCM preserve bytes and reach central selected views, D and fake native admission',async t=>{
  const f=await fixture(t);await connect(f);assert.equal(f.legacy,0);
  for(let variant=0;variant<2;variant++){
    const frame=waveform(variant);const bytes=pcmBytes(frame);f.feed(frame);const snapshot=await latest(f,variant);
    const record=await f.owner.media!.archive.readRecord(snapshot.event.raw_ref,'owner',snapshot.event.archive_revision);
    assert.equal(record.kind,'stream');if(record.kind!=='stream')assert.fail();
    assert.ok(Buffer.from(record.chunks[variant]!.bytes).equals(bytes));assert.equal(record.chunks[variant]!.chunk.object_hash,sha256(bytes));
    const input=await request(f,snapshot);
    const result=await f.owner.assembly.runtime.processMedia(input.source,'continuity','op-'+variant,input.request);
    const d=result.processed_events[0]!;assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');
    assert.equal(d.continuation_hint,'open');assert.equal(d.quality.status,'partial');assert.equal(d.coverage.status,'partial');
    assert.ok(d.quality.warnings.includes('SYNTHETIC_FIXTURE_CLOCK_MAPS_NOT_HARDWARE_CALIBRATION'));
    assert.ok(d.quality.warnings.includes('SOURCE_PCM_SAMPLE_ORDINAL_NOT_HARDWARE_CONTINUITY'));
    assert.equal(d.captured_at,new Date(f.base+1).toISOString());
    assert.equal(d.source.capture_timing!.quality,'synthetic');assert.equal(d.source.capture_timing!.uncertainty_ms,1);
    assert.equal(d.source.capture_timing!.basis_ref,snapshot.event.source.capture_timing!.basis_ref);
    assert.equal(f.raws[variant]!.time_range!.kind,'interval');
    assert.equal((f.raws[variant]!.time_range as {start_ms:number}).start_ms,f.base+1+variant*20);
    assert.equal(await f.owner.media!.archive.validateEvidence(d),true);
    assert.equal(f.requests[variant]!.input_contract,'paios.media.selected-pcm.v1');
    assert.ok(Buffer.from(f.requests[variant]!.views[0]!.bytes).equals(bytes));
    await eventually(async()=>{const admitted=await f.owner.assembly.runtime.event(input.source,'continuity',d.processed_event_id);
      if(admitted.admission.run_id){f.admissions.push(admitted.admission);return true;}return false;});
    assert.equal(f.nativeInputs.length,variant+1);
    assert.equal(f.nativeInputs[variant]!.processed_event_id,d.processed_event_id);
    // Complete only the controlled first native run so the existing one-session admission can accept the next D.
    if(variant===0)await f.owner.assembly.runtime.cancelRun(input.source,'continuity',d.processed_event_id);
  }
});
test('slow controlled analysis does not hold the capture fence or block the second frame durable append',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);f.feed();const first=await latest(f),input=await request(f,first);
  f.holdModel(gate.promise);
  const processing=f.owner.assembly.runtime.processMedia(input.source,'continuity','slow',input.request);
  await eventually(()=>f.requests.length===1);assert.equal(f.locked,false);
  f.feed(waveform(3));const second=await latest(f,1);assert.notEqual(second.event.archive_revision,first.event.archive_revision);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.nativeInputs.length,0);
  gate.release();const result=await processing;assert.equal(result.processed_events[0]!.archive_revision,first.event.archive_revision);
  await eventually(()=>f.nativeInputs.length===1);
});
test('same tuple renewed lease crosses first transport expiry, retains provenance and canonical route/output projection',async t=>{
  const f=await fixture(t);await connect(f);f.feed();await latest(f);
  f.renew();f.feed(waveform(2));await latest(f,1);
  assert.equal(f.errors.length,0);assert.equal(f.disconnects,0);assert.equal(f.contexts.at(-1)!.generation,'2');
  const capture=await f.owner.pcmIngress!.capture();assert.ok('route_version' in capture.trusted);assert.ok('output_modes' in capture.trusted);
  assert.equal(capture.binding.continuityId,'continuity');assert.equal(f.legacy,0);
});
test('capture modality denial invokes source cancellation while archived processing uses active identity without a fresh audio grant',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  f.revokeAudio();f.feed(waveform(4));await eventually(()=>f.errors.length===1 && f.cancels===1);
  assert.match(String(f.errors[0]),/MEDIA_MODALITY_NOT_AUTHORIZED/);
  const result=await f.owner.assembly.runtime.processMedia(input.source,'continuity','archived-after-modality-denial',input.request);
  assert.equal(result.processed_events.length,1);assert.equal(result.archive_revision,archived.event.archive_revision);
});
test('maintenance folds a cancelled open route before archived reprocessing stats it',{timeout:10000},async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  const key=digest([archived.event.principal_id,archived.event.device_id,archived.event.raw_ref]);
  const target=join(await fs.realpath(f.storage.root),'audio-consumer-routes',key),open=fs.open,folded=latch();
  const complete=f.storage.completeFinal.bind(f.storage);let held=false,links:number|undefined;
  t.mock.method(f.storage,'completeFinal',async(rawRef:string)=>{await complete(rawRef);if(rawRef===archived.event.raw_ref)folded.release();});
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);
    if(args[0]===target&&!held){held=true;const stat=handle.stat.bind(handle);
      handle.stat=(async()=>{
        f.revokeAudio();f.feed(waveform(4));
        await eventually(async()=>(await f.storage.list('session-ends')).includes(archived.event.raw_ref.slice(3)));
        await assertSessionEnded(f.storage,archived.event.raw_ref,'source_exhausted');
        await f.owner.assembly.runtime.existingArchive().maintenance(1,Date.now(),{budget_ms:5000});
        await folded.promise;
        await assert.rejects(fs.lstat(target),{code:'ENOENT'});
        const result=await stat();links=result.nlink;return result;
      }) as typeof handle.stat;
    }
    return handle;
  });
  const result=await f.owner.assembly.runtime.processMedia(input.source,'continuity','archived-during-cancellation',input.request);
  assert.equal(links,0);assert.equal(f.cancels,1);
  assert.match(String(f.errors[0]),/MEDIA_MODALITY_NOT_AUTHORIZED/);
  assert.equal((await f.storage.readFinal(archived.event.raw_ref))?.ended_by,'source_exhausted');
  assert.equal(result.processed_events.length,1);assert.equal(result.archive_revision,archived.event.archive_revision);
  assert.deepEqual(await f.storage.listHot('audio-consumer-routes'),[]);
});
test('Stop fence and under-fence lease-generation mutation deny fresh publication and cancel the owned reader',async t=>{
  for(const mode of ['stop','generation']){
    const f=await fixture(t);await connect(f);if(mode==='stop')f.block();else f.mutate();
    f.feed();await eventually(()=>f.errors.length===1 && f.cancels===1);
    assert.match(String(f.errors[0]),mode==='stop'?/CREDENTIAL_FENCE_ACTIVE/:/MEDIA_PERMISSION_CHANGED/);
    assert.deepEqual(await f.storage.list('stream-revisions'),[]);assert.equal(f.nativeInputs.length,0);
  }
});
test('new canonical epoch denies stale host provenance and does not bypass runtime identity revalidation',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  f.session.connectionEpoch='2';f.feed();await eventually(()=>f.errors.length===1 && f.cancels===1);
  assert.equal(f.disconnects,1);assert.equal(f.room.isConnected,false);
  assert.match(String(f.errors[0]),/SOURCE_OWNER_BINDING_DENIED/);
  await assert.rejects(f.owner.assembly.runtime.processMedia(input.source,'continuity','stale-epoch',input.request),/SOURCE_OWNER_BINDING_DENIED/);
});
test('same clock basis authorizes archived maps and rejects coefficient, basis and event scope rewriting',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  for(const map of [{...input.request.clock_maps[0]!,offset_ms:input.request.clock_maps[0]!.offset_ms+1},
    {...input.request.clock_maps[0]!,basis_ref:'client-supplied-map'},
    {...input.request.clock_maps[0]!,stream_epoch:'forged-epoch'}]){
    await assert.rejects(f.owner.assembly.runtime.processMedia(input.source,'continuity','clock-mutation',{...input.request,clock_maps:[map]}),/MEDIA_CLOCK_BASIS/);
  }
  assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
  await assert.rejects(f.owner.clock!.authorizeClockMaps('owner',input.request.clock_maps,{...archived.event,event_id:'forged-event'}),/MEDIA_CLOCK_BASIS_DENIED/);
});
test('missing real clock provider fails before legacy or native/worker calls; synthetic cannot claim production configuration',async t=>{
  const f=await fixture(t,{clockMissing:true});await assert.rejects(f.create(),/MEDIA_SOURCE_CLOCK_AUTHORITY_NOT_CONFIGURED/);
  assert.equal(f.legacy,0);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
  const configured=await fixture(t);(configured.pcm.configuration as MediaReplayConfiguration).fixture_only=false;
  await assert.rejects(configured.create(),/SYNTHETIC_SOURCE_REQUIRES_FIXTURE_CONFIGURATION/);
  assert.throws(()=>parseMediaReplayConfiguration({...configured.pcm.configuration as object,fixture_only:false}),/PRODUCTION_MEDIA_AUTHORITY_NOT_CONFIGURED/);
});
test('frame budget stops capture; the per-event sample budget rolls a long capture over to a new archived event',async t=>{
  const invalid=await fixture(t);await connect(invalid);invalid.feed(waveform(0,1025));
  await eventually(()=>invalid.errors.length===1 && invalid.cancels===1);assert.match(String(invalid.errors[0]),/FORMAL_PCM_FRAME_INVALID/);
  assert.deepEqual(await invalid.storage.list('stream-revisions'),[]);
  const limited=await fixture(t,{budget:{max_samples:320}});await connect(limited);limited.feed();const first=await latest(limited);
  limited.feed(waveform(2));await eventually(async()=>(await latest(limited)).event.event_id!==first.event.event_id);
  const second=await latest(limited);
  assert.equal(limited.errors.length,0);assert.equal(limited.cancels,0);
  assert.notEqual(second.chunk.stream_epoch,first.chunk.stream_epoch);assert.equal(second.chunk.seq,0);
});
for(const bound of ['frames','bytes'] as const)test(`ambient ${bound} backlog counts omitted samples, live taps still hear them, and recovers without detaching`,async t=>{
  const f=await fixture(t,{continuous:true,budget:{max_samples:32768,max_pending_frames:bound==='frames'?1:4,max_pending_bytes:bound==='bytes'?2048:8192}}),gate=latch(),entered=latch();
  const publish=f.storage.publishIngress.bind(f.storage);t.after(()=>gate.release());
  f.storage.publishIngress=async(...args)=>{entered.release();await gate.promise;return publish(...args);};
  await connect(f);const heard:(Promise<unknown>|undefined)[]=[];f.owner.pcmIngress!.tap((_pcm,archive)=>{heard.push(archive);});
  const frame=waveform(1,bound==='bytes'?1024:320);f.feed(frame);await entered.promise;
  f.feed(frame);await eventually(()=>f.owner.pcmIngress!.snapshot().dropped_frames===1);
  // The archive drops its copy of the second frame; the live call still hears it, without an archive reference.
  assert.equal(heard.length,2);assert.ok(heard[0]);assert.equal(heard[1],undefined);assert.equal(f.cancels,0);
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_samples,frame.samplesPerChannel);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,1);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,frame.data.byteLength);
  gate.release();const first=await latest(f);
  assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(first.event,first.chunk,4096)).bytes),pcmBytes(frame));
  assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
  f.feed(frame);await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.chunk.seq===1);
  const recovered=f.owner.pcmIngress!.snapshot().latest!.chunk.source_range;assert.equal(recovered.kind==='interval'&&recovered.start_ms,2*frame.samplesPerChannel/16);
  assert.equal(f.errors.length,1);assert.equal(f.cancels,0);
  assert.equal(f.owner.pcmIngress!.snapshot().latest!.processing_admission?.status,'queued');
  const epochs=await Promise.all((await f.storage.list('media-detection-epochs')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('media-detection-epochs',key)).toString())));
  assert.equal(epochs.length,2);assert.ok(epochs.some(epoch=>epoch.reset_reason==='explicit_gap_or_restart'));
});
for(const batched of [false,true])test(`live call ${batched?'batch':'frame'} archive keeps its references when ambient capacity is full`,async t=>{
  const f=await fixture(t,{continuous:true,interval:batched,budget:{max_samples:32768,max_pending_frames:1,max_pending_bytes:2048,
    ...(batched?{archive_batch:{max_frames:1,max_bytes:2048,max_delay_ms:10}}:{})}}),gate=latch(),entered=latch();t.after(()=>gate.release());
  const publish=f.storage.publishIngress.bind(f.storage);let block=true;
  f.storage.publishIngress=async(...args)=>{if(block){block=false;entered.release();await gate.promise;}return publish(...args);};
  await connect(f);
  const runtime=f.owner.assembly.runtime;
  const heard:(Promise<any>|undefined)[]=[];f.owner.pcmIngress!.tap((_pcm,archive)=>{heard.push(archive);});
  f.feed(waveform());await entered.promise;
  const opening=f.owner.pcmIngress!.finishSession('call_start','priority-call');
  f.feed(waveform(1));await eventually(()=>heard.length===2);
  f.feed(waveform(2));await new Promise(setImmediate);
  assert.equal(heard.length,2,'the existing durable acknowledgement bounds the live reader');
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,2,'ambient and live reservations share the existing owner');
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);assert.ok(heard.every(Boolean));
  gate.release();await eventually(()=>heard.length===3);
  const saved=await Promise.all(heard);await opening;
  assert.ok(saved.every(Boolean));
  for(let n=1;n<3;n++)assert.deepEqual(Buffer.from((await runtime.existingArchive().readExactChunk(saved[n].event,saved[n].chunk,4096)).bytes),pcmBytes(waveform(n)));
  await f.owner.pcmIngress!.finishSession();f.feed(waveform(3));await eventually(()=>heard.length===4);assert.ok(await heard[3]);
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  await f.owner.bridge.close!();assert.ok(f.errors.every(error=>String(error).includes('FORMAL_PCM_PROCESSING_BACKLOG')));
});
test('a voice window retains its accepted archive tail under bounded acquisition',async t=>{
  const f=await fixture(t,{budget:{max_pending_frames:1}}),gate=latch(),entered=latch();t.after(()=>gate.release());
  const publish=f.storage.publishIngress.bind(f.storage);
  f.storage.publishIngress=async(...args)=>{entered.release();await gate.promise;return publish(...args);};
  await connect(f);
  const realtimeBusy=()=>[...f.owner.sharedExecution.terminals.values()].some(terminal=>terminal.realtimeBusy());
  assert.equal(realtimeBusy(),false);
  await f.owner.pcmIngress!.voice.open('press');
  assert.equal(f.owner.pcmIngress!.snapshot().voice_active,true);assert.equal(realtimeBusy(),true);
  f.feed(waveform(2));await entered.promise;
  assert.equal(f.cancels,0);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,1);
  gate.release();await latest(f);
  const result=await f.owner.pcmIngress!.voice.commit('press');assert.ok(result.event_id);assert.deepEqual(f.errors,[]);
  assert.equal(f.owner.pcmIngress!.snapshot().voice_active,false);assert.equal(realtimeBusy(),false);
  await f.owner.pcmIngress!.voice.open('cancelled');assert.equal(realtimeBusy(),true);
  assert.equal(f.owner.pcmIngress!.voice.cancel('cancelled'),true);assert.equal(realtimeBusy(),false);
  await f.owner.pcmIngress!.voice.open('closing');assert.equal(realtimeBusy(),true);
  await f.owner.pcmIngress!.stop();assert.equal(f.owner.pcmIngress!.snapshot().voice_active,false);assert.equal(realtimeBusy(),false);
  await f.owner.bridge.close!();assert.equal(f.owner.pcmIngress!.snapshot().voice_active,false);assert.equal(realtimeBusy(),false);
});
test('a live call waits for the prior voice reservation before accepting its first frame',async t=>{
  const f=await fixture(t,{budget:{max_pending_frames:1}}),gate=latch(),entered=latch();t.after(()=>gate.release());
  const publish=f.storage.publishIngress.bind(f.storage);let block=true;
  f.storage.publishIngress=async(...args)=>{if(block){block=false;entered.release();await gate.promise;}return publish(...args);};
  await connect(f);const heard:(Promise<any>|undefined)[]=[];f.owner.pcmIngress!.tap((_pcm,archive)=>{heard.push(archive);});
  await f.owner.pcmIngress!.voice.open('prior-press');f.feed(waveform());await entered.promise;
  assert.equal(f.owner.pcmIngress!.voice.cancel('prior-press'),true);
  const opening=f.owner.pcmIngress!.finishSession('call_start','after-press');f.feed(waveform(1));await new Promise(setImmediate);
  assert.equal(heard.length,1);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,1);assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  gate.release();await eventually(()=>heard.length===2);const [,saved]=await Promise.all(heard);await opening;
  assert.ok(saved);assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(saved.event,saved.chunk,4096)).bytes),pcmBytes(waveform(1)));
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  await f.owner.pcmIngress!.finishSession();await f.owner.bridge.close!();assert.ok(f.errors.every(error=>String(error).includes('FORMAL_PCM_PROCESSING_BACKLOG')));
});
test('a press waiting for its microphone opens at the reader attach, so its first frame is never filed as ambient',async t=>{
  const f=await fixture(t);await f.create();f.owner.bridge.assertBootstrapRequest!(packet);await f.owner.bridge.onBootstrapConnected!(f.input);
  const opening=f.owner.pcmIngress!.voice.open('press');
  f.subscribe();await new Promise(resolve=>setImmediate(resolve));f.feed(waveform(2));await opening;await latest(f);
  const result=await f.owner.pcmIngress!.voice.commit('press');
  assert.ok(f.raws.length>0&&f.raws.every(raw=>raw.event_id===result.event_id),'every captured frame belongs to the press window');
  assert.deepEqual(f.errors,[]);
});
test('close cancels borrowed reader and joins actual pending durable append after committed admission releases the source fence',async t=>{
  const f=await fixture(t),gate=latch(),entered=latch();const publish=f.storage.publish.bind(f.storage);
  f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='objects'){entered.release();await gate.promise;}return publish(namespace,key,bytes);};
  await connect(f);f.feed();await entered.promise;let closed=false;
  const closing=Promise.resolve(f.owner.bridge.close!()).then(()=>{closed=true;});await eventually(()=>f.cancels===1);
  assert.equal(closed,false);assert.equal(f.locked,false);gate.release();await closing;
  assert.equal(closed,true);assert.equal(f.locked,false);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
});
test('disconnect ends observed-sample epoch; rebind resets ordinal under a distinct event/epoch, without claiming physical gap length',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const first=await latest(f);f.disconnect();await eventually(()=>f.cancels===1);
  await f.owner.bridge.onBootstrapConnected!(f.input);f.subscribe();f.feed(waveform(5));const second=await latest(f);
  assert.equal(second.chunk.seq,0);assert.notEqual(second.chunk.stream_epoch,first.chunk.stream_epoch);
  assert.notEqual(second.event.event_id,first.event.event_id);assert.equal(second.chunk.source_range.kind,'interval');
  assert.equal((second.chunk.source_range as {start_ms:number}).start_ms,0);
});
test('an SDK reconnect pauses the reader and resumes the same subscribed microphone on a fresh epoch, without a new TrackSubscribed',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const first=await latest(f);const listeners=f.listenerCount();
  f.reconnecting();await eventually(()=>f.cancels===1);
  assert.equal(f.listenerCount(),listeners,'a transient reconnect keeps the registration');
  f.reconnected();await eventually(()=>f.streams===2);f.feed(waveform(5));
  await eventually(()=>f.owner.pcmIngress?.snapshot().latest?.chunk.stream_epoch!==first.chunk.stream_epoch);
  const second=f.owner.pcmIngress!.snapshot().latest!;
  assert.equal(second.chunk.seq,0);assert.notEqual(second.event.event_id,first.event.event_id,'resumed capture is its own archived stream');
  f.reconnected();await eventually(()=>f.cancels===2);await eventually(()=>f.streams===3);assert.equal(f.errors.length,0,'never two readers at once');
});
test('active call receives no resumed SDK microphone or camera before reconnect admission succeeds',async t=>{
  for(const outcome of ['resolve','reject'] as const){
    const f=await fixture(t,{sdk:true});await f.hostConnect();await f.create();await f.owner.bridge.onBootstrapConnected!(f.input);
    const participant=f.options.participant as LiveKitCloudParticipant,gate=Promise.withResolvers<void>(),entered=latch();
    participant.setReconnectAdmissionGuard(async()=>{entered.release();await gate.promise;});
    const audio:string[]=[],images:string[]=[];
    const call=createVoiceCallSession({room:()=>participant.roomPort as never,greeting:{enabled:false},
      createFront:()=>({connect:async()=>{},appendAudio:bytes=>{audio.push(bytes);},appendImage:jpeg=>{images.push(jpeg);},
        respond:async()=>{},context:async()=>{},close:()=>{}}),
      createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>f.errors.push(error)});
    const untap=f.owner.pcmIngress!.tap(call.pushPcm);
    let video:ReadableStreamDefaultController<VideoFrameEvent>|undefined,videoActive=false;
    const camera=createCallCamera({participant,sink:()=>call.active()?call.pushImage:undefined,onError:error=>f.errors.push(error),
      streamFactory:()=>new ReadableStream<VideoFrameEvent>({start:c=>{video=c;videoActive=true;},cancel:()=>{videoActive=false;}}),
      project:async frame=>({frame,grid:new Uint8Array(32*18).fill(60)}),encode:async()=> 'sdk-camera'});
    const cameraTrack={sid:'sdk-camera'},cameraPublication={kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:cameraTrack};
    participant.roomPort.remoteParticipants!.get('terminal')!.trackPublications.set('sdk-camera',cameraPublication as never);
    const videoFrame=()=>{if(video&&videoActive)video.enqueue({frame:new VideoFrame(new Uint8Array(64*36*3/2).fill(60),64,36,VideoBufferType.I420),rotation:0,timestampUs:0n});};
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    try{
      await call.open('sdk-readmit');await camera.onBootstrapConnected({...f.input,enabledMedia:{data:true,audio:true,video:true}});
      await tick();f.sdkFrame();videoFrame();await eventually(()=>audio.length===1&&images.length===1);await latest(f);
      f.reconnecting();await f.owner.pcmIngress!.drain();await tick();f.reconnected();await entered.promise;await tick();await tick();
      f.subscribe();participant.roomPort.remoteParticipants!.get('terminal')!.trackPublications.set('sdk-camera',cameraPublication as never);
      f.sdkFrame(waveform(5));videoFrame();await tick();await tick();
      assert.equal(audio.length,1,'SDK microphone cannot reach an existing provider while admission is pending');
      assert.equal(images.length,1,'SDK camera cannot reach an existing provider while admission is pending');
      call.pushPcm(waveform(6).data);call.pushImage('direct-camera');
      assert.equal(audio.length,1,'room-only call borrows the same admission latch');assert.equal(images.length,1);
      await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
      if(outcome==='resolve'){
        gate.resolve();await eventually(()=>participant.snapshot().transportState==='reconnected');await tick();await tick();
        f.sdkFrame(waveform(7));videoFrame();await eventually(()=>audio.length===2&&images.length===2);
        assert.equal(audio[1],pcmBytes(waveform(7)).toString('base64'),'pending frames are dropped rather than replayed');
        await participant.withEncryptionKey(async()=>{});
      }else{
        gate.reject(new Error('CREDENTIAL_FENCE_ACTIVE'));await eventually(()=>!participant.snapshot().connected);
        call.pushPcm(waveform(8).data);call.pushImage('rejected-camera');await tick();
        assert.equal(audio.length,1);assert.equal(images.length,1);await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
      }
      assert.deepEqual(f.errors,[]);
    }finally{gate.resolve();untap();await camera.close();await call.closeAll();}
  }
});
test('a republished microphone (unsubscribe then subscribe) is read again',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const first=await latest(f);
  f.unsubscribe(f.track);await eventually(()=>f.cancels===1);
  f.subscribe();await eventually(()=>f.streams===2);f.feed(waveform(5));
  await eventually(()=>f.owner.pcmIngress?.snapshot().latest?.chunk.stream_epoch!==first.chunk.stream_epoch);
  assert.equal(f.owner.pcmIngress!.snapshot().latest!.chunk.seq,0);
});
test('connect can already contain the subscribed microphone; the one current-track registrar deduplicates events and ignores unrelated unsubscribe',async t=>{
  const f=await fixture(t);await f.create();await f.hostConnect();
  await f.owner.bridge.onBootstrapConnected!(f.input);assert.equal(f.streams,1);
  f.subscribe();assert.equal(f.streams,1);f.unsubscribe({controlled:'unrelated-camera'});
  assert.equal(f.cancels,0);f.feed();const archived=await latest(f);
  const input=await request(f,archived);await f.owner.assembly.runtime.processMedia(input.source,'continuity','already-connected',input.request);
  await eventually(()=>f.nativeInputs.length===1);f.unsubscribe(f.track);await eventually(()=>f.cancels===1);
});
test('failed frame guard and append IO retain the original error while only close joins delayed reader cancel',async t=>{
  for(const reason of ['guard','append'])for(const action of ['close','setup']){
    const gate=latch(),f=await fixture(t,{cancelWait:gate.promise});
    try {
      await connect(f);
      if(reason==='append'){const publish=f.storage.publish.bind(f.storage);
        f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='objects')throw new Error('CONTROLLED_APPEND_IO');return publish(namespace,key,bytes);};}
      f.feed(reason==='guard'?waveform(0,1025):waveform());
      await eventually(()=>f.errors.length===1 && f.cancels===1);assert.equal(f.cancelSettled,false);
      assert.match(String(f.errors[0]),reason==='guard'?/FORMAL_PCM_FRAME_INVALID/:/CONTROLLED_APPEND_IO/);
      let completed=false;
      const work=Promise.resolve(action==='close'?f.owner.bridge.close!():f.owner.bridge.onBootstrapConnected!(f.input))
        .then(()=>{completed=true;},error=>{completed=true;assert.equal(action,'close');assert(error instanceof AggregateError);assert.ok(error.errors.includes(f.errors[0]));});
      if(action==='setup')await eventually(()=>completed);else await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(completed,action==='setup');assert.equal(f.cancelSettled,false);
      gate.release();await work;assert.equal(completed,true);assert.equal(f.cancelSettled,true);
      assert.equal(f.errors.length,1);assert.equal(f.nativeInputs.length,0);
      assert.deepEqual(await f.storage.list('stream-revisions'),[]);
    } finally {gate.release();}
  }
});
test('owned PCM bytes are copied before asynchronous source reads; close joins those reads and cannot append through a stale handler',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);const frame=waveform(9),bytes=pcmBytes(frame);
  const reads=f.sourceReads;f.holdSource(gate.promise);f.feed(frame);
  await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===1 && f.sourceReads>reads);
  frame.data.fill(0);gate.release();f.holdSource();const archived=await latest(f);
  const record=await f.owner.media!.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')assert.fail();assert.ok(Buffer.from(record.chunks[0]!.bytes).equals(bytes));
  const next=latch(),old=f.oldSubscribed()!;f.holdSource(next.promise);const before=f.sourceReads;f.feed(waveform(2));
  await eventually(()=>f.sourceReads>before);let closed=false;
  const closing=Promise.resolve(f.owner.bridge.close!()).then(()=>{closed=true;});
  await eventually(()=>f.cancels===1);assert.equal(closed,false);next.release();await closing;
  assert.equal(f.raws.length,2);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
  old(f.track,f.publication,{identity:'terminal'});f.subscribe();assert.equal(f.streams,1);assert.equal(f.listenerCount(),0);
  const readable=await f.owner.media!.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision);
  assert.equal(readable.kind,'stream');assert.equal(await committedCount(f.storage),2);
});
test('expired active identity stops new capture and archived runtime processing while the scoped L5 original remains readable',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  const old=f.oldSubscribed()!;f.expire();f.feed();await eventually(()=>f.errors.length===1 && f.cancels===1);
  assert.equal(f.disconnects,1);assert.equal(f.room.isConnected,false,'expired PCM cannot leave the terminal listening in a connected room');
  assert.match(String(f.errors[0]),/SOURCE_BINDING_INACTIVE/);
  await assert.rejects(f.owner.assembly.runtime.processMedia(input.source,'continuity','expired',input.request),/SOURCE_BINDING_INACTIVE/);
  old(f.track,f.publication,{identity:'terminal'});f.subscribe();assert.equal(f.streams,1);
  assert.equal(f.raws.length,1);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
  assert.equal((await f.owner.media!.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision)).kind,'stream');
});
test('source capture timing is kept in A/B/D, malformed metadata is denied, and a later clock change cannot rewrite an event span origin',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const archived=await latest(f);
  const source=await f.owner.authority.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  const capture=await f.owner.pcmIngress!.capture(),raw=f.raws[0]!;
  for(const mutation of [
    {...raw,captured_at:new Date(f.base+100).toISOString()},
    {...raw,source:{...raw.source,capture_timing:{...raw.source.capture_timing!,uncertainty_ms:2}}},
    {...raw,source:{...raw.source,capture_timing:{...raw.source.capture_timing!,quality:'estimated' as const}}},
    {...raw,time_range:{kind:'interval' as const,timebase_id:'utc_epoch_ms',start_ms:f.base+9,end_ms:f.base+29}},
  ])await assert.rejects(f.owner.assembly.runtime.appendMedia(mutation,source,archived.chunk),/MEDIA_CAPTURE_TIMING_MISMATCH/);
  for(const timing of [null,{...raw.source.capture_timing!,uncertainty_ms:-1},{...raw.source.capture_timing!,quality:'receipt-time'}])
    assert.throws(()=>bindRaw({...raw,source:{...raw.source,capture_timing:timing}} as never,capture.trusted,new Date(f.base+50).toISOString()),/INVALID_CAPTURE_TIMING/);
  const resolve=f.pcm.clock!.resolve;
  f.pcm.clock!.resolve=async(binding,chunk)=>({...(await resolve(binding,chunk))!,offset_ms:f.base+2});
  f.feed();await eventually(()=>f.errors.length===1 && f.cancels===1);
  assert.match(String(f.errors[0]),/STREAM_IDENTITY_CONFLICT/);
  const record=await f.owner.media!.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision);
  assert.equal(record.event.captured_at,new Date(f.base+1).toISOString());assert.equal(await committedCount(f.storage),1);
});
test('missing per-capture UTC quarantines originals; known UTC outside grant rejects with cancellation',async t=>{
  for(const reason of ['missing','grant-range']){
    const f=await fixture(t);const resolve=f.pcm.clock!.resolve;
    f.pcm.clock!.resolve=reason==='missing'?async()=>undefined:async(binding,chunk)=>({...(await resolve(binding,chunk))!,offset_ms:f.base+1800000});
    await connect(f);f.feed();
    if(reason==='missing') {
      await eventually(()=>!!f.owner.pcmIngress!.snapshot().latest_quarantine);
      const q=f.owner.pcmIngress!.snapshot().latest_quarantine!;
      assert.equal(q.event.captured_at,null);assert.equal(q.authorization.historical_capture_range,'unverified');
      assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
      assert.equal(f.errors.length,0);assert.equal(f.requests.length,0);
    } else {
      await eventually(()=>f.errors.length===1 && f.cancels===1);
      assert.match(String(f.errors[0]),/MEDIA_SOURCE_RANGE_NOT_AUTHORIZED/);
      assert.deepEqual(await f.storage.list('objects'),[]);
    }
    assert.deepEqual(await f.storage.list('stream-revisions'),[]);assert.equal(f.nativeInputs.length,0);
  }
});
test('close cancels controlled analysis and waits its actual worker settlement; the archived prefix remains readable and no D is admitted',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  f.holdModel(gate.promise);
  const processing=f.owner.assembly.runtime.processMedia(input.source,'continuity','close-slow-model',input.request).then(
    ()=>assert.fail('CANCELLED_MODEL_MUST_NOT_ADMIT_D'),error=>{assert.match(String(error),/MEDIA_CANCELLED/);});
  try {
    await eventually(()=>f.requests.length===1);let closed=false;
    const closing=Promise.resolve(f.owner.bridge.close!()).then(()=>{closed=true;});await eventually(()=>f.cancels===1);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);assert.equal(f.nativeInputs.length,0);
    gate.release();await processing;await closing;assert.equal(closed,true);assert.equal(f.nativeInputs.length,0);
    assert.deepEqual(await f.storage.list('processed-media'),[]);
    assert.equal((await f.owner.media!.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision)).kind,'stream');
  } finally {gate.release();}
});
test('explicit PCM selection preserves the same formal text path and refuses runtime legacy+PCM before legacy allocations',async t=>{
  const f=await fixture(t);
  await assert.rejects(createPersistentPublicExecutionOwner({...f.options,executionOwner:'legacy'} as never),/PUBLIC_EXECUTION_OWNER_INVALID/);
  assert.equal(f.legacy,0);await connect(f);
  f.sendText({operation:'submit',event_id:'controlled-text',captured_at:new Date(f.base).toISOString(),text:'preserved formal source text'});
  await eventually(()=>f.nativeInputs.length===1 && f.published.some(packet=>{const row=packet as {operation?:string;event_id?:string};return row.operation==='accepted'&&row.event_id==='controlled-text';}));
  assert.equal(f.nativeInputs[0]!.origin,'explicit_user_prompt');assert.equal(f.nativeInputs[0]!.content.text,'preserved formal source text');
  assert.equal(f.requests.length,0);assert.equal(f.legacy,0);assert.equal(f.streams,1);assert.equal(f.errors.length,0);
});

test('millisecond captured_at quantization keeps its uncertainty in the same synthetic source basis',async t=>{
  const f=await fixture(t),resolve=f.pcm.clock!.resolve;
  f.pcm.clock!.resolve=async(binding,chunk)=>({... (await resolve(binding,chunk))!,offset_ms:f.base+1.25,uncertainty_ms:1});
  await connect(f);f.feed();const archived=await latest(f),input=await request(f,archived);
  assert.equal(archived.event.captured_at,new Date(f.base+1).toISOString());
  assert.equal(archived.event.source.capture_timing!.uncertainty_ms,1.25);
  const result=await f.owner.assembly.runtime.processMedia(input.source,'continuity','fractional-source-clock',input.request);
  assert.equal(result.processed_events[0]!.source.capture_timing!.uncertainty_ms,1.25);
  assert.equal(result.processed_events[0]!.quality.status,'partial');
});
test('close invalidates an asynchronous PCM source bootstrap before it can attach late SDK listeners',async t=>{
  const f=await fixture(t),gate=latch();await f.create();const reads=f.sourceReads;f.holdSource(gate.promise);
  const setup=f.owner.pcmIngress!.onBootstrapConnected(f.input);await eventually(()=>f.sourceReads>reads);
  let closed=false;const closing=Promise.resolve(f.owner.bridge.close!()).then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);gate.release();await setup;await closing;
  f.subscribe();assert.equal(f.listenerCount(),0);assert.equal(f.streams,0);assert.equal(f.raws.length,0);
});
test('a replacement PCM bootstrap keeps one current registrar when an older source lookup completes late',async t=>{
  const f=await fixture(t),gate=latch();await f.create();f.addExisting();f.holdSource(gate.promise);const reads=f.sourceReads;
  const old=f.owner.pcmIngress!.onBootstrapConnected(f.input);
  try{
    await eventually(()=>f.sourceReads>reads);
    f.holdSource();await f.owner.pcmIngress!.onBootstrapConnected(f.input);assert.equal(f.streams,1);
    gate.release();await old;f.subscribe();assert.equal(f.streams,1);f.feed();await latest(f);
    assert.equal(f.errors.length,0);assert.equal(f.raws.length,1);assert.equal(f.listenerCount(),REGISTRAR_LISTENERS);
  }finally{gate.release();await old;}
});

const continuousMarker=(samples:number,speech:boolean):PcmFrame=>({data:new Int16Array(samples).fill(speech?1:0),sampleRate:16000,channels:1,samplesPerChannel:samples});
test('continuous formal factory uses current source/clock then automatic C D into the journal without blocking durable capture',async t=>{
  const f=await fixture(t,{continuous:true}),gate=latch();await connect(f);f.holdModel(gate.promise);
  f.feed(continuousMarker(1024,true));await latest(f,0);f.feed(continuousMarker(512,false));const pinned=await latest(f,1);
  await eventually(()=>f.requests.length===1);assert.equal(f.locked,false);assert.equal(f.nativeInputs.length,0);
  const {vad}=f.pcm.ports!.detector as ReturnType<typeof controlledDetector>;assert.equal(vad.opened,1);assert.equal(vad.closed,0);
  f.renew();f.feed(continuousMarker(1024,true));const later=await latest(f,2);
  assert.notEqual(later.event.archive_revision,pinned.event.archive_revision);assert.equal(f.nativeInputs.length,0);
  gate.release();await f.owner.assembly.runtime.continuousMedia().drain();
  const [d]=await f.ambient();assert.equal(d!.archive_revision,pinned.event.archive_revision);assert.equal(d!.origin,'device_observation');assert.equal(d!.user_identity,'unknown');
  assert.equal(d!.continuation!.semantic_status,'open');assert.equal(d!.coverage.status,'partial');assert.equal(f.clockReads,3);
  // Ambient speech goes to the journal under the authenticated source device; no run, no output target.
  const [entry]=f.journal!.search({principal_id:'owner',limit:5}).entries;
  assert.deepEqual([entry!.processed_event_id,entry!.device_id,entry!.text],[d!.processed_event_id,'phone','CONTROLLED SOURCE, NOT REAL ASR']);
  assert.equal(f.nativeInputs.length,0);assert.equal((await f.storage.list('output-targets')).length,0);assert.equal(f.errors.length,0);assert.equal(f.legacy,0);
});
test('continuous formal candidate and D keep archived sealed basis when future provider calibration changes',async t=>{
  const f=await fixture(t,{continuous:true}),gate=latch();await connect(f);f.holdModel(gate.promise);
  f.feed(continuousMarker(1024,true));await latest(f,0);f.feed(continuousMarker(512,false));const pinned=await latest(f,1);
  await eventually(()=>f.requests.length===1);const resolve=f.pcm.clock!.resolve;
  f.pcm.clock!.resolve=async(binding,chunk)=>({... (await resolve(binding,chunk))!,offset_ms:f.base+2});
  gate.release();await f.owner.assembly.runtime.continuousMedia().drain();
  assert.equal(f.nativeInputs.length,0);assert.deepEqual(f.errors,[]);
  const keys=await f.storage.list('media-continuous-candidates');assert.equal(keys.length,1);
  const candidate=JSON.parse(Buffer.from(await f.storage.read('media-continuous-candidates',keys[0]!)).toString());
  assert.equal(candidate.event.archive_revision,pinned.event.archive_revision);assert.equal(candidate.context.clock_maps[0].offset_ms,f.base+1);
  assert.equal((await f.storage.list('processed-media')).length,1);assert.equal((await f.storage.list('media-continuous-attempts')).length,0);assert.equal((await f.storage.list('media-continuous-admitted')).length,1);
});

for(const batched of [false,true])test(`continuous ${batched?'interval':'frame'} capacity rejection declares a gap after the ordered receipt and capture recovers`,async t=>{
  const model=latch(),receipt=latch();t.after(()=>{model.release();receipt.release();});
  const f=await fixture(t,{continuous:true,interval:batched,budget:{max_samples:32768,
    ...(batched?{archive_batch:{max_frames:1,max_bytes:4096,max_delay_ms:10}}:{})}});
  f.pcm.continuous!.budget.max_pending_candidates=1;f.pcm.continuous!.budget.max_pending_chunks=1;
  await connect(f);f.holdModel(model.promise);
  const runtime=f.owner.assembly.runtime as any,method=batched?'consumeArchivedInterval':'consumeArchived',consume=runtime[method].bind(runtime);
  let rejected=false;
  runtime[method]=async(...args:any[])=>{
    const result=await consume(...args),chunk=batched?args[2][0]:args[2],value=batched?result[0]:result;
    if(chunk.seq===4){assert.equal(value.processing_admission?.error_code,'CONTINUOUS_CHUNK_BACKLOG');rejected=true;await receipt.promise;}
    return result;
  };
  for(let n=0;n<4;n++){
    f.feed(continuousMarker(512,n%2===0));await latest(f,n);
    if(n===1)await eventually(()=>f.requests.length===1);
    if(n===2)await eventually(()=>runtime.continuousMedia().snapshot().pending_chunks===0);
  }
  await eventually(()=>runtime.continuousMedia().snapshot().pending_chunks===1);
  f.feed(continuousMarker(512,true));await eventually(()=>rejected);
  // Archive the next frame before the previous rejection reaches the capture owner.
  f.feed(continuousMarker(512,false));await eventually(()=>f.raws.length===6&&f.owner.pcmIngress!.snapshot().pending_frames===0);
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);assert.equal(f.cancels,0);
  model.release();await runtime.continuousMedia().drain();receipt.release();
  const recovered=await latest(f,5);assert.equal(recovered.processing_admission?.status,'queued');
  for(let n=6;n<8;n++){f.feed(continuousMarker(512,n%2===0));await latest(f,n);}
  await runtime.continuousMedia().drain();
  const epochs=await Promise.all((await f.storage.list('media-detection-epochs')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('media-detection-epochs',key)).toString())));
  assert.equal(epochs.length,2);assert.ok(epochs.some(epoch=>epoch.seq===5&&epoch.reset_reason==='explicit_gap_or_restart'));
  assert.equal((await f.storage.list('media-continuous-admitted')).length,3);
  assert.ok(f.errors.some(error=>(error as any).continuous_pcm_admission==='recovered'));
  assert.ok(!f.errors.some(error=>/CONTINUOUS_CANDIDATE_BACKLOG|CONTINUOUS_SEQUENCE_GAP_OR_REORDER|CONTINUOUS_DETECTION_FAILED/.test(String(error))));
  assert.equal(f.raws.length,8);assert.equal(f.cancels,0);
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();assert.equal(await committedCount(f.storage),8);
});
test('continuous detector cancel does not cancel formal PCM reader; later chunk is durable with explicit processing receipt',async t=>{
  const f=await fixture(t,{continuous:true});await connect(f);f.feed(continuousMarker(512,false));const first=await latest(f,0);
  await f.owner.assembly.runtime.continuousMedia().drain();
  const {digest}=await import('../../../services/personal-aios-integration/src/contracts.ts');
  const key=digest([first.event.raw_ref,first.chunk.track_id,first.chunk.stream_epoch]);await f.owner.assembly.runtime.continuousMedia().cancelDetection(key);
  f.feed(continuousMarker(512,false));const next=await latest(f,1);assert.equal(f.cancels,0);assert.equal(f.raws.length,2);
  assert(f.errors.some(e=>/CONTINUOUS_DETECTION_CANCELLED/.test(String(e))));assert.notEqual(first.event.archive_revision,next.event.archive_revision);assert.equal(next.processing_admission?.status,'failed');assert(next.processing_receipt_ref);
  f.end();await assert.rejects(f.owner.pcmIngress!.close(),/CONTINUOUS_DETECTION_CANCELLED/);
  await assertSessionEnded(f.storage,next.event.raw_ref,'source_exhausted');
  await f.owner.assembly.runtime.existingArchive().maintenance(1,Date.now(),{budget_ms:5000});
  assert.equal((await f.storage.readFinal(next.event.raw_ref))?.bytes,2048,'maintenance folds ended raw input despite detector cancellation');
});


test('formal PCM EOF finalizes open input exhaustion after durable tail without inferred silence',async t=>{
  const f=await fixture(t,{continuous:true});await connect(f);f.feed(continuousMarker(1024,true));await latest(f,0);
  f.feed(continuousMarker(112,true));await latest(f,1);f.end();await f.owner.pcmIngress!.close();
  await f.owner.assembly.runtime.continuousMedia().drain();
  const keys=await f.storage.list('media-detection-finished');assert.equal(keys.length,1);
  const finished=JSON.parse(Buffer.from(await f.storage.read('media-detection-finished',keys[0]!)).toString());
  assert.equal(finished.acoustic_end_asserted,false);assert.equal(finished.semantic_status,'open');
  assert.equal(finished.terminal.processed_samples,1024);assert.equal(finished.terminal.uninferred_samples,112);
  const candidates=await f.storage.list('media-continuous-candidates');assert.equal(candidates.length,1);
  const c=JSON.parse(Buffer.from(await f.storage.read('media-continuous-candidates',candidates[0]!)).toString());
  assert.equal(c.reason,'input_exhausted');assert.equal(c.semantic_status,'open');assert.equal(c.end_sample_exclusive,1024);
  const [exhausted]=await f.ambient();assert.equal(exhausted!.coverage.status,'partial');assert.equal(f.nativeInputs.length,0);
  assert.equal(f.raws.length,2);assert.equal(f.requests.length,1);
});
test('continuous rollover finishes each ended span: a long capture never exhausts the stream budget or source handles',async t=>{
  // max_streams is 2: without finishing rolled-over spans the third span's detection is refused (CONTINUOUS_STREAM_BACKLOG).
  const f=await fixture(t,{continuous:true,budget:{max_samples:512}});await connect(f);
  for(let span=0;span<5;span++){
    f.feed(continuousMarker(512,false));await eventually(()=>f.raws.length===span+1);
    await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.event.event_id===f.raws[span]!.event_id);
  }
  await eventually(async()=>(await f.storage.list('media-detection-finished')).length===4);
  assert.deepEqual(f.errors.map(String),[]);
  assert.equal(new Set(f.raws.map(raw=>raw.event_id)).size,5,'five archived spans');
  f.end();await f.owner.pcmIngress!.drain();await f.owner.pcmIngress!.close();await f.owner.assembly.runtime.continuousMedia().drain();
  assert.equal((await f.storage.list('media-detection-finished')).length,5,'the last span ends at input exhaustion, each exactly once');
  assert.deepEqual(f.errors.map(String),[]);
});
test('formal PCM disconnect finishes retained input range once without native cancellation',async t=>{
  const f=await fixture(t,{continuous:true});await connect(f);f.feed(continuousMarker(1024,true));await latest(f);
  f.disconnect();await f.owner.pcmIngress!.close();await f.owner.assembly.runtime.continuousMedia().drain();
  assert.equal((await f.storage.list('media-detection-finished')).length,1);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,1);
  assert.equal(f.cancels,1);assert.equal(f.raws.length,1);
  const [d]=await f.ambient();assert.equal(d!.continuation!.semantic_status,'open');assert.equal(f.nativeInputs.length,0);
});
test('formal PCM uninferred EOF tail stays archived without invented speech or model analysis',async t=>{
  const f=await fixture(t,{continuous:true});await connect(f);f.feed(continuousMarker(112,true));await latest(f);
  f.end();await f.owner.pcmIngress!.drain();await f.owner.pcmIngress!.close();await f.owner.assembly.runtime.continuousMedia().drain();
  const keys=await f.storage.list('media-detection-finished');assert.equal(keys.length,1);
  const finished=JSON.parse(Buffer.from(await f.storage.read('media-detection-finished',keys[0]!)).toString());
  assert.equal(finished.terminal.processed_samples,0);assert.equal(finished.terminal.uninferred_samples,112);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,0);assert.equal(f.raws.length,1);
  assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
});
test('formal PCM EOF on disabled continuous path adds no detector or automatic analysis',async t=>{
  const f=await fixture(t);await connect(f);f.feed();const snapshot=await latest(f);f.end();await f.owner.pcmIngress!.close();
  await assertSessionEnded(f.storage,snapshot.event.raw_ref,'source_exhausted');
  await f.owner.assembly.runtime.existingArchive().maintenance(1,Date.now(),{budget_ms:5000});
  const final=await f.storage.readFinal(snapshot.event.raw_ref);assert.equal(final?.bytes,640);assert.equal(final?.ended_by,'source_exhausted');
  assert.equal((await f.storage.list('media-detection-finished')).length,0);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
});
test('whole runtime close finishes acquisition and retains an open acoustic tail',async t=>{
  const f=await fixture(t,{continuous:true});await connect(f);f.feed(continuousMarker(1024,true));await latest(f);
  await f.owner.bridge.close!();const keys=await f.storage.list('media-detection-finished');assert.equal(keys.length,1);
  const finished=JSON.parse(Buffer.from(await f.storage.read('media-detection-finished',keys[0]!)).toString());
  assert.equal(finished.acoustic_end_asserted,false);assert.equal(finished.semantic_status,'open');
  assert.equal(f.nativeInputs.length,0);assert.equal(f.raws.length,1);
});
test('voice commit, voice cancel and hangup durably end their capture while the microphone keeps running',async t=>{
  const f=await fixture(t);await connect(f);
  await f.owner.pcmIngress!.voice.open('committed');f.feed(waveform(1));const committed=await latest(f);
  await f.owner.pcmIngress!.voice.commit('committed');await assertSessionEnded(f.storage,committed.event.raw_ref,'voice_commit');
  await f.owner.pcmIngress!.voice.open('cancelled');f.feed(waveform(2));
  await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.event.event_id!==committed.event.event_id);const cancelled=f.owner.pcmIngress!.snapshot().latest!;
  assert.equal(f.owner.pcmIngress!.voice.cancel('cancelled'),true);
  await eventually(async()=>(await f.storage.list('session-ends')).includes(cancelled.event.raw_ref.slice(3)));await assertSessionEnded(f.storage,cancelled.event.raw_ref,'voice_cancel');
  f.feed(waveform(3));await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.event.event_id!==cancelled.event.event_id);const call=f.owner.pcmIngress!.snapshot().latest!;
  await f.owner.pcmIngress!.finishSession();await assertSessionEnded(f.storage,call.event.raw_ref,'call_hangup');
  f.feed(waveform(4));await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.event.event_id!==call.event.event_id);
  assert.equal(f.cancels,0);assert.equal(f.streams,1);assert.deepEqual(f.errors,[]);
  f.end();await f.owner.pcmIngress!.close();assert.equal((await f.storage.list('session-ends')).length,4);
  assert.equal((await f.storage.list('session-finals')).length,0);
  await f.owner.assembly.runtime.existingArchive().maintenance(1,Date.now(),{budget_ms:5000});
  assert.equal((await f.storage.list('session-finals')).length,4);
});
test('explicit formal PCM span uses sealed owner anchor and retained per-track proof without changing default v1 callers',async t=>{
  const f=await fixture(t,{span:true});await connect(f);f.feed();const first=await latest(f);
  assert.equal(first.event.media_type,'livekit_tracks');assert(first.event.event_id.startsWith('span:'));
  assert.equal(first.event.captured_at,new Date(f.base).toISOString());assert(first.chunk.clock_basis_ref);
  const record=await f.owner.media!.archive.readRecord(first.event.raw_ref,'owner',first.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')assert.fail();
  const maps=await f.owner.clock!.archivedClockMaps(first.event,record.manifest);
  assert.equal(maps[0]!.offset_ms,f.base+1);assert.equal(first.event.time_range.kind,'instant');
  assert.equal(record.manifest.chunks[0]!.clock_basis_ref,first.chunk.clock_basis_ref);
  f.feed(waveform(2));const second=await latest(f,1);assert.equal(first.event.raw_ref,second.event.raw_ref);
  assert.equal(second.event.source.capture_timing!.basis_ref,first.event.source.capture_timing!.basis_ref);assert.equal(f.errors.length,0);
});

test('explicit span continuous context uses pinned sealed clocks through actual PCM source composition and existing C D',async t=>{
  const f=await fixture(t,{span:true,continuous:true});await connect(f);
  f.feed(continuousMarker(1024,true));await latest(f,0);f.feed(continuousMarker(512,false));const pinned=await latest(f,1);
  await f.owner.assembly.runtime.continuousMedia().drain();const [spanned]=await f.ambient();
  assert.equal(spanned!.archive_revision,pinned.event.archive_revision);assert.equal(spanned!.media_type,'livekit_tracks');
  assert.equal(spanned!.captured_at,new Date(f.base).toISOString());assert.equal(f.errors.length,0);assert.equal(f.nativeInputs.length,0);
  await f.owner.bridge.onBootstrapConnected!(f.input);f.feed(continuousMarker(512,false));const next=await latest(f,2);
  assert.equal(next.event.raw_ref,pinned.event.raw_ref);assert.equal(next.chunk.stream_epoch,pinned.chunk.stream_epoch);
  await f.owner.assembly.runtime.continuousMedia().drain();assert.equal(f.errors.length,0);
});


test('r2 Close during deferred span resolution joins setup and cannot attach late PCM SDK listeners',async t=>{
  const f=await fixture(t,{span:true}),gate=latch();await f.create();f.addExisting();
  const resolve=f.pcm.clock!.resolveSpan!;let entered=false;
  f.pcm.clock!.resolveSpan=async(...args)=>{entered=true;await gate.promise;return resolve(...args);};
  const setup=f.owner.pcmIngress!.onBootstrapConnected(f.input);await eventually(()=>entered);
  let closed=false;const closing=f.owner.pcmIngress!.close().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false);
  gate.release();await setup;await closing;
  assert.equal(closed,true);assert.equal(f.listenerCount(),0);assert.equal(f.streams,0);assert.equal(f.raws.length,0);
  assert.equal(await committedCount(f.storage),0);f.subscribe();assert.equal(f.streams,0);
});
test('r2 Stop during deferred span resolution invalidates setup before listener attachment',async t=>{
  const f=await fixture(t,{span:true}),gate=latch(),entered=latch();await f.create();f.addExisting();
  const resolve=f.pcm.clock!.resolveSpan!;
  f.pcm.clock!.resolveSpan=async(...args)=>{entered.release();await gate.promise;return resolve(...args);};
  const setup=f.owner.pcmIngress!.onBootstrapConnected(f.input);await entered.promise;
  await f.owner.pcmIngress!.stop();gate.release();await setup;
  assert.equal(f.listenerCount(),0);assert.equal(f.streams,0);assert.equal(f.raws.length,0);
  f.subscribe();assert.equal(f.streams,0);assert.equal(await committedCount(f.storage),0);
});
test('r2 newer bootstrap retains one current registrar when older deferred span resolves late',async t=>{
  const f=await fixture(t,{span:true}),gate=latch();await f.create();f.addExisting();
  const resolve=f.pcm.clock!.resolveSpan!;let calls=0;
  f.pcm.clock!.resolveSpan=async(...args)=>{calls++;if(calls===1)await gate.promise;return resolve(...args);};
  const old=f.owner.pcmIngress!.onBootstrapConnected(f.input);await eventually(()=>calls===1);
  await f.owner.pcmIngress!.onBootstrapConnected(f.input);assert.equal(calls,2);assert.equal(f.streams,1);assert.equal(f.listenerCount(),REGISTRAR_LISTENERS);
  gate.release();await old;f.subscribe();assert.equal(f.streams,1);assert.equal(f.listenerCount(),REGISTRAR_LISTENERS);
  f.feed();await latest(f);assert.equal(f.raws.length,1);assert.equal(f.errors.length,0);
});
test('explicit unavailable independent span preserves quarantined PCM without claiming UTC or MEDIA',async t=>{
  const f=await fixture(t,{span:true});await f.create();f.addExisting();
  f.pcm.clock!.resolveSpan=async()=>undefined;
  await f.owner.pcmIngress!.onBootstrapConnected(f.input);
  assert.ok(f.listenerCount()>0);assert.equal(f.streams,1);f.subscribe();assert.equal(f.streams,1);f.feed();
  await eventually(()=>!!f.owner.pcmIngress!.snapshot().latest_quarantine);
  const q=f.owner.pcmIngress!.snapshot().latest_quarantine!;
  assert.equal(q.event.captured_at,null);assert.equal(q.event.media_type,'livekit_tracks');
  assert.equal(q.authorization.historical_capture_range,'unverified');
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
  assert.equal(f.raws.length,0);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
  assert.equal(await committedCount(f.storage),0);
});
test('received PCM remains durable after Close or Stop during deferred source map',async t=>{
  for(const action of ['close','stop'] as const){
    const f=await fixture(t,{span:true}),gate=latch();await connect(f);
    const resolve=f.pcm.clock!.resolve;let entered=false;
    f.pcm.clock!.resolve=async(...args)=>{entered=true;await gate.promise;return resolve(...args);};
    f.feed();await eventually(()=>entered);let settled=false;
    const ending=f.owner.pcmIngress![action]().then(()=>{settled=true;});
    await eventually(()=>f.cancels===1);if(action==='close')assert.equal(settled,false);
    gate.release();await ending;await f.owner.pcmIngress!.close();
    assert.equal(f.raws.length,1);await eventually(async()=>await committedCount(f.storage)===1);
    assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.errors.length,0);
  }
});

const batchBudget={max_delay_ms:200,max_frames:4,max_bytes:8192};
test('configured formal batch EOF drains a short batch through fresh fence into one joined chunk that preserves each PCM frame',async t=>{
 const f=await fixture(t,{budget:{archive_batch:batchBudget}});await connect(f);let publications=0,admissions=0;const publish=f.storage.publishAliased.bind(f.storage);
 f.storage.publishAliased=async(...args)=>{assert.equal(f.locked,false,'frames publish after committed capture admission releases the fence');if(args[0]==='stream-revisions')publications++;return publish(...args);};
 const ingress=f.storage.publishIngressBatch.bind(f.storage);f.storage.publishIngressBatch=async(records)=>{assert.equal(f.locked,false,'durable admission IO follows permission fence commit');admissions+=records.length;return ingress(records);};
 // One joined original takes the single-record durable admission; the fence rule is the same.
 const single=f.storage.publishIngress.bind(f.storage);f.storage.publishIngress=async(...args)=>{assert.equal(f.locked,false,'durable admission IO follows permission fence commit');admissions++;return single(...args);};
 const frames=[waveform(1),waveform(2),waveform(3)];for(const frame of frames)f.feed(frame);f.end();await f.owner.pcmIngress!.drain();
 const last=await latest(f,0);assert.equal(admissions,1);assert.equal(publications,1);assert.equal(await committedCount(f.storage),1);assert.equal(last.event.bytes,1920);
 const source=await f.owner.assembly.runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));
 const archive=new RawArchive(f.storage,4096,undefined,parseMediaReplayConfiguration(f.pcm.configuration,true).stream_budget);const record=await archive.readRecord(last.event.raw_ref,source.principal_id,last.event.archive_revision);assert.equal(record.kind,'stream');if(record.kind==='stream')assert.deepEqual(record.chunks.map(x=>Buffer.from(x.bytes)),[Buffer.concat(frames.map(pcmBytes))]);
 assert.deepEqual(f.errors,[]);assert.equal(f.locked,false);
});
// One archived chunk per contiguous batch run (file-count fix): the joined original must replay the same PCM bytes on the same
// source and mapped axes as the per-frame chunks it replaces, and every 100 ms frame a tap saw must resolve to its own samples.
test('joined batch chunk replays the same PCM bytes and time axes as separate per-frame chunks; taps keep per-frame references',async t=>{
 const run=async(joined:boolean)=>{
  const f=await fixture(t,{receiptClock:true,budget:{archive_batch:batchBudget}});
  // Separate = the pre-fix producer: an archive budget of one frame leaves nothing to join.
  if(!joined)(f.pcm.configuration as MediaReplayConfiguration).stream_budget.max_chunk_bytes=640;
  await connect(f);const heard:{pcm:Int16Array;archive?:Promise<PcmArchiveSnapshot|undefined>}[]=[];f.owner.pcmIngress!.tap((pcm,archive)=>{heard.push({pcm:pcm.slice(),...(archive?{archive}:{})});});
  const frames=[waveform(1),waveform(2),waveform(3)];for(const frame of frames)f.feed(frame);f.end();await f.owner.pcmIngress!.drain();
  const last=await latest(f,joined?0:2),source=await f.owner.assembly.runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  const {binding}=await f.owner.authority.capture(f.owner.authority.credentialForBootstrap(f.input));
  const maps=await f.owner.clock!.archivedReceiptClockMaps('owner',last.event,binding);assert.equal(maps.length,1);
  const record=await new RawArchive(f.storage,4096,undefined,parseMediaReplayConfiguration(f.pcm.configuration,true).stream_budget).readRecord(last.event.raw_ref,source.principal_id,last.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')throw new Error('stream');
  assert.equal(record.chunks.length,joined?1:3);assert.deepEqual(record.chunks.map(x=>x.chunk.seq),joined?[0]:[0,1,2]);
  const ranges=record.chunks.map(x=>x.chunk.source_range as {start_ms:number;end_ms:number;timebase_id:string});
  const mapped=record.chunks.map(x=>mappedRange(x.chunk.source_range,maps[0]!) as {start_ms:number;end_ms:number});
  // Sample accounting: each tap frame resolves inside its archived chunk exactly as call references slice it.
  const references=await Promise.all(heard.map(async h=>{const saved=(await h.archive)!;const chunk=record.chunks.find(x=>x.chunk.seq===saved.chunk.seq)!;
    const from=(saved.sample_offset??0)*2;return Buffer.from(chunk.bytes).subarray(from,from+h.pcm.length*2);}));
  assert.deepEqual(references,frames.map(pcmBytes));
  // The stream event is the first chunk's capture; its time range must be the mapped range of that chunk.
  assert.deepEqual(last.event.time_range,{...mapped[0],kind:'interval',timebase_id:'utc_epoch_ms'});
  return {bytes:Buffer.concat(record.chunks.map(x=>Buffer.from(x.bytes))),source:{start:ranges[0]!.start_ms,end:ranges.at(-1)!.end_ms,contiguous:ranges.every((r,n)=>!n||r.start_ms===ranges[n-1]!.end_ms)},
    mapped:{start:mapped[0]!.start_ms-maps[0]!.offset_ms,end:mapped.at(-1)!.end_ms-maps[0]!.offset_ms},total:last.event.bytes,captured:Date.parse(last.event.captured_at)-maps[0]!.offset_ms,
    commitment:record.total_bytes,errors:f.errors};
 };
 const joined=await run(true),separate=await run(false);
 assert.deepEqual(joined.bytes,separate.bytes);assert.deepEqual(joined.bytes,Buffer.concat([waveform(1),waveform(2),waveform(3)].map(pcmBytes)));
 assert.deepEqual(joined.source,{start:0,end:60,contiguous:true});assert.deepEqual(joined.source,separate.source);
 assert.deepEqual(joined.mapped,separate.mapped);assert.equal(joined.captured,separate.captured);
 assert.equal(joined.total,1920);assert.equal(joined.commitment,separate.commitment);assert.deepEqual(joined.errors,[]);assert.deepEqual(separate.errors,[]);
});
// Crash/restart at the joined-original boundary: what reached raw-ingress is the joined original, and a new process recovers it.
for(const partial of [false,true])test(`joined batch ${partial?'partly published (first run committed, second pending)':'crashed before its journal delta'} is recovered whole by a restarted archive`,async t=>{
 const f=await fixture(t,{budget:{archive_batch:batchBudget}});
 // partial: an archive budget of two frames splits the three-frame batch into two joined runs [2 frames][1 frame].
 if(partial)(f.pcm.configuration as MediaReplayConfiguration).stream_budget.max_chunk_bytes=1280;
 const publish=f.storage.publishAliased.bind(f.storage);let deltas=0;
 f.storage.publishAliased=async(...args)=>{if(args[0]==='stream-revisions'&&++deltas>(partial?1:0))throw Object.assign(new Error('CRASH_BEFORE_DELTA'),{code:'EIO'});return publish(...args);};
 await connect(f);const frames=[waveform(1),waveform(2),waveform(3)];for(const frame of frames)f.feed(frame);
 await eventually(async()=>(await f.storage.list('raw-ingress')).length===(partial?1:1)&&deltas>(partial?1:0));
 assert.equal(await committedCount(f.storage),partial?1:0);
 await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.close();await f.owner.bridge.close!();
 assert.equal((await f.storage.list('session-ends')).length,1,'durable unpublished input retains its acquisition end intent');
 // The process is gone; a fresh storage and archive on the same root recover the durable joined originals.
 const storage=new PosixStorage(f.storage.root),budget=parseMediaReplayConfiguration(f.pcm.configuration,true).stream_budget,archive=new RawArchive(storage,4096,undefined,budget);
 t.after(()=>archive.close());await archive.recover();
 await eventually(async()=>(await storage.list('raw-ingress')).length===0);assert.equal(await committedCount(storage),partial?2:1);
 let head:{raw_ref:string;revision:number}|undefined;
 for(const key of await storage.list('stream-revisions')){const m=JSON.parse(Buffer.from(await storage.read('stream-revisions',key)).toString());if(key===digest(m)&&(!head||m.revision>head.revision))head=m;}
 const record=await archive.readRecord(head!.raw_ref,'owner',digest(head));assert.equal(record.kind,'stream');if(record.kind!=='stream')return;
 assert.deepEqual(record.chunks.map(x=>x.chunk.seq),partial?[0,1]:[0]);assert.deepEqual(record.chunks.map(x=>x.bytes.length),partial?[1280,640]:[1920]);
 assert.deepEqual(Buffer.concat(record.chunks.map(x=>Buffer.from(x.bytes))),Buffer.concat(frames.map(pcmBytes)));
 await assertSessionEnded(storage,head!.raw_ref,'source_exhausted');
 await archive.maintenance(1,Date.now(),{budget_ms:5000});
 assert.equal((await storage.pendingFinals()).length,0);assert.equal((await storage.readFinal(head!.raw_ref))?.bytes,1920);
 const ranges=record.chunks.map(x=>x.chunk.source_range as {start_ms:number;end_ms:number});assert.deepEqual(ranges.map(r=>[r.start_ms,r.end_ms]),partial?[[0,40],[40,60]]:[[0,60]]);
});
test('shutdown seals the complete recovered session after a published batch and a durable pending batch',async t=>{
 const f=await fixture(t,{budget:{archive_batch:{...batchBudget,max_frames:3}}});await connect(f);
 const frames=[waveform(1),waveform(2),waveform(3)];for(const frame of frames)f.feed(frame);const first=await latest(f,0);
 const publish=f.storage.publishAliased.bind(f.storage);let refused=0;
 f.storage.publishAliased=async(...args)=>{if(args[0]==='stream-revisions'){refused++;throw Object.assign(new Error('PENDING_AFTER_PREFIX'),{code:'EIO'});}return publish(...args);};
 for(const frame of frames)f.feed(frame);await eventually(async()=>refused>0&&(await f.storage.list('raw-ingress')).length===1);
 await f.owner.bridge.close!();assert.equal(await f.storage.readFinal(first.event.raw_ref),null);
 const storage=new PosixStorage(f.storage.root),archive=new RawArchive(storage,4096,undefined,parseMediaReplayConfiguration(f.pcm.configuration,true).stream_budget);
 t.after(()=>archive.close());await archive.recover();await eventually(async()=>(await storage.list('raw-ingress')).length===0);
 await assertSessionEnded(storage,first.event.raw_ref,'source_exhausted');
 await archive.maintenance(1,Date.now(),{budget_ms:5000});assert.equal((await storage.pendingFinals()).length,0);
 const final=await storage.readFinal(first.event.raw_ref);assert.equal(final?.bytes,3840);assert.equal((await storage.list('raw-ingress')).length,0);
 const event=await archive.locate(first.event.raw_ref,'owner'),record=await archive.readRecord(event.raw_ref,'owner',event.archive_revision);
 assert.equal(record.kind,'stream');if(record.kind==='stream')assert.deepEqual(Buffer.concat(record.chunks.map(chunk=>Buffer.from(chunk.bytes))),Buffer.concat([...frames,...frames].map(pcmBytes)));
});

for(const {preparing,hangingUp,historyStalled} of [
 ...[false,true].flatMap(preparing=>[false,true].map(hangingUp=>({preparing,hangingUp,historyStalled:false}))),
 {preparing:true,hangingUp:false,historyStalled:true},
])test(`shutdown seals ${hangingUp?'closing':'active'} call before detaching ${preparing?'received undurable':'durable'} PCM publication${historyStalled?' with disconnected room and stalled native history':''}`,async t=>{
 const f=await fixture(t,{voice:true,budget:{max_samples:32768,max_pending_frames:16,max_pending_bytes:32768,
   archive_batch:{...batchBudget,max_frames:3}}});
 const publication=latch();t.after(()=>publication.release());let writes=0;
 t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({
   write:async(samples:Float32Array)=>++writes===1?[{start:0,at:samples.length}]:[],close:async()=>{}}),
   transcribe:async()=>({text:'shutdown unfinished speech'}),close:async()=>{}} as unknown as LocalSpeechEngine));
 Object.assign(f.room.localParticipant,{publishTrack:async()=>({sid:'shutdown-speaking',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
 const transportText=t.mock.method(f.room.localParticipant,'sendText');
 const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
   classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},close:()=>{},
     context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
 await f.create({retainAssembly:!preparing,central:{...f.options.central,voice}});
 t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'shutdown conversation');
 await f.owner.bridge.onBootstrapConnected!(f.input);f.subscribe();
 await eventually(()=>transportText.mock.calls.some(call=>JSON.parse(call.arguments[0]).operation==='ready'));
 f.sendText({operation:'call_open',call_id:'shutdown-speaking'});
 await eventually(()=>f.published.some((p:any)=>p.call_id==='shutdown-speaking'&&p.state==='live'));
 const frames=Array.from({length:6},()=>continuousMarker(512,true));
 for(const frame of frames.slice(0,3))f.feed(frame);const first=await latest(f,0);await eventually(()=>writes>0);
 const publish=f.storage.publishAliased.bind(f.storage);let publishing=false;
 t.mock.method(f.storage,'publishAliased',async(...args:Parameters<typeof publish>)=>{
   if(args[0]==='stream-revisions'){publishing=true;await publication.promise;}return publish(...args);
 });
 if(preparing)f.holdClock(publication.promise);
 for(const frame of frames.slice(3))f.feed(frame);
 await eventually(async()=>preparing?f.owner.pcmIngress!.snapshot().pending_frames===3:publishing&&(await f.storage.list('raw-ingress')).length===1);
 if(hangingUp){f.sendText({operation:'call_close',call_id:'shutdown-speaking'});
   await eventually(()=>f.published.some((p:any)=>p.call_id==='shutdown-speaking'&&p.state==='closing'));}
 let historyReads=0;
 if(historyStalled){
   const stalled=async(_value:unknown,_limitOrSignal?:number|AbortSignal,signal?:AbortSignal)=>{
     historyReads++;const abort=signal??_limitOrSignal as AbortSignal;
     await new Promise<never>((_resolve,reject)=>{if(abort.aborted)reject(abort.reason);else abort.addEventListener('abort',()=>reject(abort.reason),{once:true});});
     return [];
   };
   t.mock.method(f.options.central.native,'sessions',stalled);
   t.mock.method(f.options.central.native,'messages',stalled);
 }
 // This is delayed healthy I/O. Shutdown must preserve the final turn's references while it completes.
 const close=()=>Promise.resolve(f.owner.bridge.close!()).then(()=>undefined,error=>error);
 const closing=preparing?new Promise<unknown>(resolve=>{
   const shutdown=()=>{void (async()=>{if(historyStalled)await f.options.participant.disconnect();return close();})().then(resolve);};process.once('SIGTERM',shutdown);
   t.after(()=>process.off('SIGTERM',shutdown));process.kill(process.pid,'SIGTERM');
 }):close();
 await eventually(()=>f.cancelSettled);publication.release();
 assert.equal(await closing,undefined,'call close must not reject CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE');
 if(historyStalled)assert.equal(historyReads,0,'lifecycle sealing does not wait for native history');
 await f.owner.assembly.close();
 for(const error of f.errors)assert.equal((error as {code?:string}).code,'FORMAL_TEXT_CONNECTION_CHANGED');
 assert.equal((await f.storage.list('raw-ingress')).length,0);
 const archive=f.owner.assembly.runtime.existingArchive(),event=await archive.locate(first.event.raw_ref,'owner');
 const record=await archive.readRecord(event.raw_ref,'owner',event.archive_revision);assert.equal(record.kind,'stream');
 if(record.kind==='stream')assert.deepEqual(Buffer.concat(record.chunks.map(chunk=>Buffer.from(chunk.bytes))),Buffer.concat(frames.map(pcmBytes)));
 const processed=await Promise.all((await f.storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('processed-events',key)).toString())));
 const turn=processed.find(d=>d.content.app_event?.kind==='voice_turn'),closed=processed.find(d=>d.content.app_event?.kind==='call_closed');
 assert.equal(turn?.content.app_event.user,'shutdown unfinished speech');assert.ok(turn.content.app_event.audio);
 assert.equal(turn.content.app_event.audio.raw_ref,first.event.raw_ref);
 assert.equal(turn.content.app_event.audio.end_ms-turn.content.app_event.audio.start_ms,frames.length*512/16);
 assert.ok(closed?.content.app_event.processed_event_ids.includes(turn.processed_event_id));
 if(historyStalled){
   const inputs=await Promise.all((await f.storage.list('admission-inputs')).map(async key=>({key,input:JSON.parse(Buffer.from(await f.storage.read('admission-inputs',key)).toString())})));
   const retained=inputs.find(({input})=>input.d.processed_event_id===closed.processed_event_id);assert.ok(retained);
   assert.equal(retained.input.skill,f.options.central.skill);
   const saved=JSON.parse(Buffer.from(await f.storage.read('admissions',retained.key)).toString());assert.equal(saved.state,'pending');
   const restarted=new RunAdmission(new PosixStorage(f.storage.root),f.options.central.native,f.options.central.admission);
   t.after(()=>restarted.close());await restarted.recover();
   const recovered=restarted.get('owner',saved.session_id,closed.processed_event_id);
   assert.equal(recovered?.state,'pending');assert.equal(recovered?.idempotency_key,saved.idempotency_key);
   const originalInputs=f.nativeInputs.filter(input=>input.processed_event_id!==closed.processed_event_id).length;
   for(const run of f.runs.values())run.status='completed';
   await eventually(()=>f.nativeInputs.some(input=>input.processed_event_id===closed.processed_event_id));
   assert.equal(f.nativeInputs.filter(input=>input.processed_event_id===closed.processed_event_id).length,1);
   assert.equal(f.nativeInputs.filter(input=>input.processed_event_id!==closed.processed_event_id).length,originalInputs);
   assert.equal(restarted.get('owner',saved.session_id,closed.processed_event_id)?.idempotency_key,saved.idempotency_key);
   await restarted.close();assert.equal(historyReads,0);
 }
});

test('shutdown retains glasses ambient PCM with phone and Mac text connections on one assembly',async t=>{
 const glasses=await fixture(t,{continuous:true,interval:true,budget:{archive_batch:batchBudget},terminal:{deviceId:'glasses',deviceType:'glasses'}});
 const phone=await fixture(t),mac=await fixture(t,{terminal:{deviceId:'mac',deviceType:'mac',capabilities:MAC_CAPABILITIES}});
 const first=await glasses.create({retainAssembly:true});
 for(const f of [phone,mac])await f.create({central:glasses.options.central,sharedExecution:first.sharedExecution});
 for(const f of [glasses,phone,mac])await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:f===glasses,video:false}});
 const publish=glasses.storage.publishAliased.bind(glasses.storage);let refused=0;
 t.mock.method(glasses.storage,'publishAliased',async(...args:Parameters<typeof publish>)=>{
   if(args[0]==='stream-revisions'){refused++;throw Object.assign(new Error('PENDING_AMBIENT'),{code:'EIO'});}return publish(...args);
 });
 glasses.subscribe();const frame=continuousMarker(512,true);glasses.feed(frame);
 await eventually(async()=>refused>0&&(await glasses.storage.list('raw-ingress')).length===1);
 await Promise.all([glasses,phone,mac].map(f=>f.owner.bridge.close!()));await first.assembly.close();
 const keys=first.pcmIngress!.snapshot().pending_raw_keys;assert.equal(keys.length,1);
 const pending=JSON.parse(Buffer.from(await glasses.storage.read('raw-ingress',keys[0]!)).toString());
 assert.equal(pending.record.trusted.device_id,'glasses');assert.deepEqual(Buffer.from(await glasses.storage.read('objects',pending.object_hash)),pcmBytes(frame));
 const storage=new PosixStorage(glasses.storage.root),archive=new RawArchive(storage,4096,undefined,parseMediaReplayConfiguration(glasses.pcm.configuration,true).stream_budget);
 t.after(()=>archive.close());await archive.recover();
 const rawRef=`l5:${digest({event_id:glasses.raws[0]!.event_id,principal_id:'owner',device_id:'glasses'})}`;
 await eventually(async()=>(await storage.list('raw-ingress')).length===0);
 await assertSessionEnded(storage,rawRef,'source_exhausted');
 await archive.maintenance(1,Date.now(),{budget_ms:5000});assert.equal((await storage.pendingFinals()).length,0);
 assert.equal((await storage.list('raw-ingress')).length,0);assert.equal(await committedCount(storage),1);
 assert.equal((await storage.readFinal(rawRef))?.bytes,frame.data.byteLength);
});
// File-count measurement (opt-in, deterministic): N minutes of 100 ms ambient frames on the production interval_v2 path, five frames
// per batch (500 ms in real time), alternating 2 s marker speech / 1 s silence. `joined:false` is the pre-fix producer (a 4096-byte
// continuous chunk budget fits one frame). Reports names, inodes and 4 KiB-block bytes per namespace, scaled to one hour.
if(process.env.FORMAL_FILE_COUNT_BENCH)for(const joined of [false,true])test(`file-count bench: ${joined?'joined':'per-frame'} ambient archive`,{timeout:1800000},async t=>{
 const minutes=Number(process.env.FORMAL_FILE_COUNT_MINUTES??'2'),frames=minutes*600;
 const f=await fixture(t,{continuous:true,interval:true,budget:{max_frame_samples:1600,max_pending_frames:64,max_pending_bytes:262144,max_samples:9600000,
  archive_batch:{max_delay_ms:500,max_frames:5,max_bytes:65536}}});
 const cfg=f.pcm.configuration as MediaReplayConfiguration;
 cfg.stream_budget={max_chunk_bytes:16777216,max_total_bytes:268435456,max_chunks:6000,max_revisions:6000,max_seq:6000};
 cfg.alignment.max_chunks=6000;cfg.processing.max_input_bytes=1048576;cfg.max_window_ms=60000;
 Object.assign(f.pcm.continuous!.budget,{max_pending_chunks:64,max_pending_candidates:32,max_chunk_bytes:joined?65536:4096});
 await connect(f);const started=performance.now();
 const waitBench=async(predicate:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+60000;
  while(!await predicate()){assert(Date.now()<deadline,'FILE_COUNT_BENCH_PUBLICATION_TIMEOUT');await new Promise(resolve=>ioTimeout(resolve,25));}
 };
 const physical=async()=>{
  const spaces:Record<string,{names:number;inodes:number;block_bytes:number}>={},seen=new Set<number>();
  for(const name of await fs.readdir(f.storage.root)){
   const full=join(f.storage.root,name),stat=await fs.lstat(full),group=name==='.raw-ingress-reserve'?'fixed_reserve':stat.isDirectory()?name:'store';
   const row=spaces[group]??={names:0,inodes:0,block_bytes:0};
   for(const file of stat.isDirectory()?(await fs.readdir(full)).map(key=>join(full,key)):[full]){
    const s=await fs.lstat(file);row.names++;if(seen.has(s.ino))continue;seen.add(s.ino);row.inodes++;row.block_bytes+=s.blocks*512;
   }
  }
  const sum=(rows:typeof spaces)=>Object.values(rows).reduce((a,r)=>({names:a.names+r.names,inodes:a.inodes+r.inodes,block_bytes:a.block_bytes+r.block_bytes}),{names:0,inodes:0,block_bytes:0});
  const {fixed_reserve,...data}=spaces;
  return {spaces,total:sum(spaces),data:sum(data),fixed_reserve:fixed_reserve??{names:0,inodes:0,block_bytes:0}};
 };
 for(let n=0;n<frames;n+=5){
  // Unique PCM per frame (real audio never dedups); sample 1 is never on the marker detector's 512-sample grid.
  for(let k=n;k<n+5;k++){const frame=continuousMarker(1600,k%30<20);frame.data[1]=k+2;f.feed(frame);}
  await waitBench(()=>{const s=f.owner.pcmIngress!.snapshot();return f.raws.length>=(n+5)/(joined?5:1)&&s.pending_frames===0&&s.processing_pending_frames===0;});
 }
 const live=await physical();
 f.end();await f.owner.pcmIngress!.drain();await f.owner.assembly.runtime.continuousMedia().drain();
 await waitBench(async()=>(await f.storage.list('raw-ingress')).length===0);
 const archive=f.owner.assembly.runtime.existingArchive();
 await waitBench(async()=>{await archive.maintenance(1,Date.now(),{budget_ms:5000});return archive.maintenanceSnapshot().phase==='idle';});
 const {spaces,total,data,fixed_reserve}=await physical(),hour=60/minutes;
 const scaled=Object.fromEntries(Object.entries(spaces).filter(([name,r])=>name!=='fixed_reserve'&&r.names).sort((a,b)=>b[1].inodes-a[1].inodes).map(([k,r])=>[k,{names_per_hour:Math.round(r.names*hour),inodes_per_hour:Math.round(r.inodes*hour),mib_per_hour:+(r.block_bytes*hour/1048576).toFixed(1)}]));
 const finals=await Promise.all((await f.storage.list('session-finals')).map(key=>f.storage.readFinal(`l5:${key}`)));
 assert.equal(finals.reduce((sum,record)=>sum+(record?.bytes??0),0),frames*3200);assert.deepEqual(f.errors,[]);
 await fs.appendFile(process.env.FORMAL_FILE_COUNT_BENCH!,JSON.stringify({joined,minutes,frames,elapsed_ms:Math.round(performance.now()-started),live_before_end:live,finalized:total,data,fixed_reserve,final_session_count:finals.length,candidates:(await f.storage.list('media-continuous-candidates')).length,
  per_hour:{names:Math.round(data.names*hour),inodes:Math.round(data.inodes*hour),mib:+(data.block_bytes*hour/1048576).toFixed(1)},namespaces:scaled,errors:f.errors.map(String).slice(0,5)})+'\n');
});
test('configured formal batch timer flushes without awaiting a next SDK frame or holding permission',async t=>{
 const f=await fixture(t,{budget:{archive_batch:{...batchBudget,max_delay_ms:20}}});await connect(f);f.feed(waveform(1));
 await latest(f);assert.equal(await committedCount(f.storage),1);assert.equal(f.locked,false);assert.deepEqual(f.errors,[]);
});
test('Stop drains received batch frames during clock preparation and releases payloads',async t=>{
 const f=await fixture(t,{budget:{archive_batch:{...batchBudget,max_delay_ms:500}}});await connect(f);const clock=latch();f.holdClock(clock.promise);f.feed(waveform(1));
 await eventually(()=>f.clockReads>=1);await f.owner.pcmIngress!.stop();clock.release();await f.owner.pcmIngress!.drain();
 const saved=f.owner.pcmIngress!.snapshot().latest!;assert.ok(saved);assert.equal(await committedCount(f.storage),1);
 assert.deepEqual(Buffer.from((await f.owner.media!.archive.readExactChunk(saved.event,saved.chunk,4096)).bytes),pcmBytes(waveform(1)));
 assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.locked,false);
});
test('batch source permission stays fresh at flush; revoked microphone cannot publish buffered audio',async t=>{
 const f=await fixture(t,{budget:{archive_batch:{...batchBudget,max_delay_ms:20}}});await connect(f);f.feed(waveform(1));await eventually(()=>f.clockReads>=1);f.revokeAudio();
 await eventually(()=>f.errors.length>0);await f.owner.pcmIngress!.drain();assert.equal(await committedCount(f.storage),0);assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
});

test('configured formal batch reaches original continuous C D and the journal after the permission fence is released',async t=>{
 const f=await fixture(t,{continuous:true,budget:{archive_batch:batchBudget}});await connect(f);
 for(let n=0;n<3;n++)f.feed(waveform(n+1,512));f.end();await f.owner.pcmIngress!.drain();await f.owner.assembly.runtime.continuousMedia().drain();
 const last=await latest(f,0);assert.equal(last.event.bytes,3072);assert.equal(await committedCount(f.storage),1);
 assert.equal((await f.storage.list('media-source-progress')).length,1);assert.equal((await f.storage.list('media-postarchive-admissions')).length,1);
 assert.equal((await f.storage.list('media-continuous-candidates')).length,1);assert.equal((await f.storage.list('processed-media')).length,1);
 assert.equal(f.journal!.search({principal_id:'owner',limit:5}).entries.length,1);assert.equal(f.nativeInputs.length,0);assert.equal(f.requests.length,1);assert.equal(f.locked,false);assert.deepEqual(f.errors,[]);
});

if(process.env.FORMAL_BATCH_BENCH)for(const size of [10,25])for(const count of [50,250])test(`synthetic full collector benchmark ${size*20}ms ${count} frames`,{timeout:60000},async t=>{
 const f=await fixture(t,{continuous:true,interval:process.env.FORMAL_INTERVAL_BENCH==='1',span:process.env.FORMAL_BATCH_SPAN==='1',budget:{max_pending_frames:64,max_pending_bytes:40960,max_samples:80000,archive_batch:{max_delay_ms:size*20,max_frames:size,max_bytes:640*size}}});
 const cfg=f.pcm.configuration as MediaReplayConfiguration;cfg.stream_budget={max_chunk_bytes:4096,max_total_bytes:160000,max_chunks:256,max_revisions:256,max_seq:256};
 cfg.processing.max_input_bytes=160000;cfg.alignment.max_chunks=256;
 f.pcm.continuous!.budget.max_pending_chunks=64;
 await connect(f);let maxPending=0,maxBytes=0;const start=performance.now();
 const timings:Record<string,{count:number;total_ms:number;max_ms:number}>={};
 const measure=(target:object,name:string)=>{const owner=target as Record<string,any>,run=owner[name].bind(target);
  owner[name]=async(...args:unknown[])=>{const at=performance.now();try{return await run(...args);}finally{const ms=performance.now()-at;
   const m=timings[name]??={count:0,total_ms:0,max_ms:0};m.count++;m.total_ms+=ms;m.max_ms=Math.max(m.max_ms,ms);}};};
 measure(f.owner.assembly.runtime,'authenticate');measure(f.owner.assembly.runtime,'appendMediaBatch');
 measure(f.owner.assembly.runtime.continuousMedia(),'acceptInterval');measure(f.storage,'publishMany');measure(f.storage,'flushNamespace');measure(f.storage,'syncDirectory');
 t.after(async()=>{await fs.appendFile(process.env.FORMAL_BATCH_BENCH!+'.diagnostics',JSON.stringify({size,count,errors:f.errors.map(String),requests:f.requests.length,native:f.nativeInputs.length,snapshot:f.owner.pcmIngress!.snapshot()})+'\n');});
 const wait=async(predicate:()=>boolean)=>{for(let n=0;n<2400;n++){const snapshot=f.owner.pcmIngress!.snapshot();maxPending=Math.max(maxPending,snapshot.pending_frames);maxBytes=Math.max(maxBytes,snapshot.pending_bytes);assert(snapshot.pending_frames<=64&&snapshot.pending_bytes<=40960);if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('FULL_COLLECTOR_12S_WAIT_TIMEOUT');};
 for(let n=0;n<count;n+=size){for(let k=n;k<Math.min(n+size,count);k++)f.feed(waveform(1));
  await wait(()=>f.owner.pcmIngress!.snapshot().latest?.chunk.seq===Math.min(n+size,count)-1);const s=f.owner.pcmIngress!.snapshot();maxPending=Math.max(maxPending,s.pending_frames);maxBytes=Math.max(maxBytes,s.pending_bytes);}
 f.end();await f.owner.pcmIngress!.drain();await f.owner.assembly.runtime.continuousMedia().drain();
 const elapsed=performance.now()-start,last=await latest(f,count-1);assert.equal(last.event.bytes,count*640);assert.equal(await committedCount(f.storage),count);
 let intervalCount=count;
 if(process.env.FORMAL_INTERVAL_BENCH==='1'){
  const intervals=await Promise.all((await f.storage.list('media-postarchive-admissions')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('media-postarchive-admissions',key)).toString())));
  intervalCount=intervals.length;assert(intervalCount>=Math.ceil(count/size)&&intervalCount<=count);assert.equal(intervals.reduce((n,r)=>n+r.frames.length,0),count);assert(intervals.every(r=>r.schema==='paios.media.postarchive-admission.interval.v2'&&r.frames.every((x:any)=>x.processing_admission.status==='queued')));
  for(let seq=0;seq<count;seq++){const key=digest([digest([last.event.raw_ref,last.chunk.track_id,last.chunk.stream_epoch]),seq]);
    const checkpoint=JSON.parse(Buffer.from(await f.storage.read('media-source-progress',key)).toString());assert(checkpoint.frames.some((x:any)=>x.seq===seq));}
 }else{assert.equal((await f.storage.list('media-source-progress')).length,count);assert.equal((await f.storage.list('media-postarchive-admissions')).length,count);}
 assert.equal(f.requests.length,1);assert.equal(f.nativeInputs.length,0);assert.equal(f.locked,false);assert.deepEqual(f.errors,[]);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
 let files=0,logical=0,unique=0;const inodes=new Set<number>();const walk=async(path:string)=>{for(const name of await fs.readdir(path)){const full=join(path,name),st=await fs.lstat(full);if(st.isDirectory())await walk(full);else{files++;logical+=st.size;if(!inodes.has(st.ino)){inodes.add(st.ino);unique+=st.size;}}}};
 await walk(f.storage.root);assert(logical<=10*1024*1024);
 const proofStart=performance.now(),record=await new RawArchive(f.storage,4096,undefined,cfg.stream_budget).readRecord(last.event.raw_ref,'owner',last.event.archive_revision,{maxReadBytes:160000});assert.equal(record.kind,'stream');
 const rawBytes=Buffer.concat(record.kind==='stream'?record.chunks.map(x=>Buffer.from(x.bytes)):[]),expected=Buffer.concat(Array.from({length:count},()=>pcmBytes(waveform(1))));assert.equal(sha256(rawBytes),sha256(expected));
 const workerBytes=Buffer.concat(f.requests[0]!.views.filter(x=>x.modality==='audio').map(x=>Buffer.from(x.bytes)));assert.equal(sha256(workerBytes),sha256(expected.subarray(0,workerBytes.length)));assert(workerBytes.length<=rawBytes.length);
 const rawProof={raw_byte_sha256:sha256(rawBytes),raw_bytes:rawBytes.length,worker_selected_byte_sha256:sha256(workerBytes),worker_selected_bytes:workerBytes.length,archived_uninferred_tail_bytes:rawBytes.length-workerBytes.length,proof_ms:performance.now()-proofStart,metadata_commitment:last.event.payload_sha256,metadata_commitment_is_byte_sha:false};
 const row={...rawProof,source_reads:f.sourceReads,timings,media_type:process.env.FORMAL_BATCH_SPAN==='1'?'livekit_tracks':'audio',scope:'synthetic-full-collector-fake-SDK-worker-VAD-native-clock-not-device',batch_max_delay_ms:size*20,batch_max_frames:size,frames:count,audio_ms:count*20,elapsed_ms:elapsed,files,logical_bytes:logical,unique_inode_bytes:unique,max_pending_observed:maxPending,max_pending_bytes_observed:maxBytes,b_count:count,media_count:intervalCount,input_contract:process.env.FORMAL_INTERVAL_BENCH==='1'?'interval_v2':'frame_v1',c_count:1,d_count:1,native_count:1};
 await fs.appendFile(process.env.FORMAL_BATCH_BENCH!,JSON.stringify(row)+'\n');
});

test('Stop after fresh batch admission retains all durable frames through producer close and publication',async t=>{
 const f=await fixture(t,{budget:{archive_batch:{...batchBudget,max_frames:3}}}),entered=latch(),release=latch(),publish=f.storage.publishAliased.bind(f.storage);
 let publishing=false,blocked=true;f.storage.publishAliased=async(...args)=>{if(args[0]==='stream-revisions'){publishing=true;entered.release();if(blocked)throw Object.assign(new Error('BATCH_METADATA_EIO'),{code:'EIO'});}return publish(...args);};
 try{await connect(f);for(let n=0;n<3;n++)f.feed(waveform(n+1));await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===3);await eventually(()=>publishing);assert.equal(f.locked,false);assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);
 // The three frames are one joined original: one durable ingress record, one retained key, one committed chunk.
 await eventually(async()=>(await f.storage.list('raw-ingress')).length===1);await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.close();assert.equal(f.owner.pcmIngress!.snapshot().pending_raw_keys.length,1);blocked=false;release.release();
 await eventually(async()=>await committedCount(f.storage)===1);await f.owner.bridge.close!();
 assert.equal(await committedCount(f.storage),1);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.locked,false);
 }finally{blocked=false;release.release();}
});
test('configured AV span batch uses original verified header reader and reaches C D and the journal with retained per-track clock proofs',async t=>{
 const f=await fixture(t,{span:true,continuous:true,budget:{archive_batch:batchBudget}});await connect(f);
 for(let n=0;n<3;n++)f.feed(waveform(n+1,512));f.end();await f.owner.pcmIngress!.drain();await f.owner.assembly.runtime.continuousMedia().drain();
 assert.equal(await committedCount(f.storage),1);assert.equal(f.requests.length,1);assert.equal((await f.ambient())[0]!.media_type,'livekit_tracks');assert.equal(f.nativeInputs.length,0);assert.equal(f.locked,false);assert.deepEqual(f.errors,[]);
});
for(const span of [false,true])test(`sealed ${span?'AV':'audio'} stream header maps later chunks without provider reload and rejects changed anchor, binding or stored clock proof`,async t=>{
 const f=await fixture(t,{span});await connect(f);f.feed(waveform(1));await latest(f,0);f.feed(waveform(2));const last=await latest(f,1);
 const {binding}=await f.owner.authority.capture(f.owner.authority.credentialForBootstrap(f.input)),resolves=f.clockReads;
 const maps=await f.owner.clock!.archivedReceiptClockMaps('owner',last.event,binding);assert.equal(maps.length,1);assert.equal(f.clockReads,resolves);
 const range=last.chunk.source_range;assert.equal(range.kind,'interval');if(range.kind==='interval')assert.equal(maps[0]!.offset_ms+range.start_ms,f.base+21);
 await assert.rejects(f.owner.clock!.archivedReceiptClockMaps('wrong',last.event,binding),/MEDIA_CLOCK_BASIS_DENIED/);
 await assert.rejects(f.owner.clock!.archivedReceiptClockMaps('owner',last.event,{...binding,connectionEpoch:'changed'}),/MEDIA_CLOCK_BASIS_DENIED/);
 await assert.rejects(f.owner.clock!.archivedReceiptClockMaps('owner',{...last.event,time_range:{kind:'instant',timebase_id:'utc_epoch_ms',at_ms:f.base+999}},binding),/STREAM_REVISION_INTEGRITY/);
 const key=last.event.source.capture_timing!.basis_ref.replace('source-clock:',''),basis=JSON.parse(Buffer.from(await f.storage.read('source-clock-bases',key)).toString());basis.map.offset_ms+=1;
 await fs.writeFile(join(f.storage.root,'source-clock-bases',key),JSON.stringify(basis));
 await assert.rejects(f.owner.clock!.archivedReceiptClockMaps('owner',last.event,binding),/MEDIA_CLOCK_BASIS_DENIED/);
});

test('interval v2 formal EOF drains a short durable batch before the one pinned C/D journaled',async t=>{
 const f=await fixture(t,{continuous:true,interval:true,budget:{archive_batch:{max_delay_ms:500,max_frames:3,max_bytes:6144}}});await connect(f);
 f.feed(waveform(1));f.feed(waveform(1));f.end();await f.owner.pcmIngress!.drain();await f.owner.assembly.runtime.continuousMedia().drain();
 assert.equal((await f.ambient()).length,1);assert.equal(await committedCount(f.storage),1);
 const keys=await f.storage.list('media-postarchive-admissions');assert.equal(keys.length,1);
 const receipt=JSON.parse(Buffer.from(await f.storage.read('media-postarchive-admissions',keys[0]!)).toString());assert.equal(receipt.schema,'paios.media.postarchive-admission.interval.v2');
 assert.deepEqual(receipt.frames.map((x:any)=>x.seq),[0]);assert(receipt.frames.every((x:any)=>x.processing_admission.status==='queued'));
 assert.equal(f.nativeInputs.length,0);assert.equal(f.requests.length,1);assert.deepEqual(f.errors,[]);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
});
test('interval v2 Stop drains received audio through archive and MEDIA and releases owned PCM',async t=>{
 const f=await fixture(t,{continuous:true,interval:true,budget:{archive_batch:{max_delay_ms:500,max_frames:3,max_bytes:6144}}});await connect(f);const clock=latch();f.holdClock(clock.promise);
 f.feed(waveform(1));await eventually(()=>f.clockReads===1);await f.owner.pcmIngress!.stop();clock.release();await f.owner.pcmIngress!.drain();
 assert.equal(await committedCount(f.storage),1);assert.equal((await f.storage.list('media-postarchive-admissions')).length,1);assert.equal(f.nativeInputs.length,0);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
});
test('interval v2 fresh permission failure tears down capture without append self-join',async t=>{
 const f=await fixture(t,{continuous:true,interval:true,budget:{archive_batch:{max_delay_ms:20,max_frames:3,max_bytes:6144}}});await connect(f);
 f.feed(waveform(1));await eventually(()=>f.clockReads===1);f.revokeAudio();await f.owner.pcmIngress!.drain();
 assert.equal(await committedCount(f.storage),0);assert.equal((await f.storage.list('media-postarchive-admissions')).length,0);assert.equal(f.nativeInputs.length,0);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);assert(f.errors.length>0);
});

for(const shortBatch of [false,true])test(`interval v2 Stop retains the received ${shortBatch?'short timer and preparing tail':'full'} batch through producer close`,async t=>{
 const f=await fixture(t,{continuous:true,interval:true,budget:{archive_batch:{...batchBudget,max_delay_ms:shortBatch?20:1000,max_frames:3}}});
 const entered=latch(),release=latch(),clockRelease=latch(),publish=f.storage.publishAliased.bind(f.storage);
 const published:any[]=[];
 if(shortBatch){const resolve=f.pcm.clock!.resolve;let calls=0;f.pcm.clock!.resolve=async(...args)=>{if(++calls===2)await clockRelease.promise;return resolve(...args);};}
 let publishing=false,blocked=true;f.storage.publishAliased=async(...args)=>{if(args[0]==='stream-revisions'){publishing=true;entered.release();if(blocked)throw Object.assign(new Error('BATCH_METADATA_EIO'),{code:'EIO'});}const result=await publish(...args);if(args[0]==='stream-revisions')published.push(JSON.parse(Buffer.from(result).toString()));return result;};
 try{await connect(f);for(let n=0;n<(shortBatch?2:3);n++)f.feed(waveform(1));await eventually(()=>publishing);
 // A full batch is one joined original; the short timer batch holds the one frame before the held clock read.
 const frames=shortBatch?2:3;assert.equal(f.raws.length,1);assert.equal(f.locked,false);assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);
 await eventually(async()=>(await f.storage.list('raw-ingress')).length===1);await f.owner.pcmIngress!.stop();clockRelease.release();await f.owner.pcmIngress!.close();
 const admitted=shortBatch?2:1;
 assert.equal(f.owner.pcmIngress!.snapshot().pending_raw_keys.length,admitted);blocked=false;release.release();
 await eventually(async()=>await committedCount(f.storage)===admitted);await f.owner.bridge.close!();
 assert.equal(await committedCount(f.storage),admitted);assert.equal(f.raws.length,admitted);
 assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);const last=published.at(-1);assert.ok(last);
 const record=await new RawArchive(f.storage,4096,undefined,(f.pcm.configuration as MediaReplayConfiguration).stream_budget).readRecord(last.raw_ref,'owner',digest(last),{maxReadBytes:8192});
 assert.equal(record.kind,'stream');if(record.kind==='stream'){assert.equal(record.chunks.length,admitted);assert.equal(sha256(Buffer.concat(record.chunks.map(x=>Buffer.from(x.bytes)))),sha256(Buffer.concat(Array.from({length:frames},()=>pcmBytes(waveform(1))))));}
 assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);assert.equal(f.locked,false);assert.equal(f.owner.assembly.runtime.continuousMedia().snapshot().pending_chunks,0);
 // Capture durability is joined. Runtime shutdown separately cancels unfinished model work.
 for(const error of f.errors){assert(error instanceof Error);assert(['MEDIA_CANCELLED','CONTINUOUS_CANCELLED','CONTINUOUS_PROCESS_CANCELLED'].includes(error.message),error.stack);}
 }finally{blocked=false;release.release();clockRelease.release();}
});

for(const mode of ['frame_v1','interval_v2','shared Mac'] as const)test(`PCM slot regression: two voice windows between ambient lanes (${mode})`,{timeout:30000},async t=>{
  const interval=mode==='interval_v2',shared=mode==='shared Mac';
  const f=await fixture(t,{voice:true,continuous:!shared,receiptClock:true,interval,
    ...(interval?{budget:{archive_batch:batchBudget}}:{}),
    ...(shared?{terminal:{deviceId:'mac',deviceType:'mac',capabilities:MAC_CAPABILITIES}}:{})});
  let primary:Awaited<ReturnType<typeof f.create>>|undefined;
  if(shared){const phone=await fixture(t,{voice:true,continuous:true,receiptClock:true});primary=await phone.create({retainAssembly:true});
    await f.create({central:phone.options.central,sharedExecution:primary.sharedExecution});
    await f.owner.bridge.onBootstrapConnected!(f.input);f.subscribe();
    t.after(async()=>{await f.owner.bridge.close!();await primary!.bridge.close!();await primary!.assembly.close();});
  }else await connect(f);
  const continuous=f.owner.assembly.runtime.continuousMedia();
  const feedArchived=async(frame:PcmFrame)=>{
    const done=Promise.withResolvers<PcmArchiveSnapshot|undefined>();
    const untap=f.owner.pcmIngress!.tap((_pcm,archive)=>{
      assert.ok(archive,'the controlled frame must be admitted');void archive.then(done.resolve,done.reject);
    });
    try{f.feed(frame);const saved=await done.promise;assert.ok(saved);return saved;}finally{untap();}
  };
  const endedSlots:number[]=[];
  let previous:string|undefined;
  for(let n=0;n<3;n++){
    const ambient=await feedArchived(waveform(n));assert.notEqual(ambient.event.event_id,previous);previous=ambient.event.event_id;
    assert.equal(ambient.processing_admission?.status,'queued',`ambient ${n} must be admitted`);
    if(n===2)break;
    const operation=`slot-window-${n}`;
    const statuses=()=>f.published.filter((p:any)=>p.operation==='voice_status'&&p.operation_id===operation) as any[];
    if(shared){f.sendText({operation:'voice_open',operation_id:operation});await eventually(()=>statuses().some(p=>p.source_status==='recording'));}
    else await f.owner.pcmIngress!.voice.open(operation);
    const voice=await feedArchived(waveform(n+4));assert.notEqual(voice.event.event_id,previous);previous=voice.event.event_id;
    if(shared){
      const appended=ScriptedQwenSocket.appended.length;
      f.sendText({operation:'voice_commit',operation_id:operation});await eventually(()=>statuses().some(p=>p.source_status==='pending'));
      await eventually(()=>ScriptedQwenSocket.appended.length>appended);
      let candidate:any;
      await eventually(async()=>{f.sendText({operation:'voice_candidates',operation_id:operation});await new Promise(r=>setTimeout(r,20));
        candidate=statuses().filter(p=>p.source_status==='candidates').flatMap(p=>p.candidates).find((c:any)=>c.kind==='transcript');return !!candidate;});
      f.sendText({operation:'voice_send',operation_id:operation,candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,
        window_ref:candidate.window_ref,selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256});
      await eventually(()=>f.published.some((p:any)=>p.operation==='accepted'&&p.event_id===previous));
    }else await f.owner.pcmIngress!.voice.commit(operation);
    await continuous.drain();endedSlots.push(continuous.snapshot().streams);
  }
  if(shared)await f.owner.bridge.close!();
  else {f.end();await f.owner.pcmIngress!.drain();}
  await continuous.drain();
  assert.equal(continuous.snapshot().streams,0);assert.equal(f.streams,1);assert.deepEqual(f.errors,[]);
  assert.ok(endedSlots.every(size=>size<=1),JSON.stringify(endedSlots));
  assert.equal((f.owner.assembly.runtime as unknown as {mediaSources:Map<string,unknown>}).mediaSources.size,0);
});

for(const mode of ['frame','batched','interval'] as const)test(`formal voice window${mode==='frame'?'':mode==='batched'?' (batched archive)':' beside the interval_v2 ambient lane'}: server cuts the one PCM reader into a voice span; device sends only open/commit/candidates/send`,async t=>{
  const interval=mode==='interval';
  const f=await fixture(t,{voice:true,receiptClock:true,...(mode!=='frame'?{budget:{archive_batch:batchBudget}}:{}),...(interval?{continuous:true,interval:true}:{})});
  await connect(f);ScriptedQwenSocket.appended.length=0;
  const ambient=waveform(0);f.feed(ambient);const first=await latest(f,0);
  // One composition: the ambient lane is continuous MEDIA on interval_v2, the voice window keeps the voice consumer.
  if(interval){assert.equal(first.processing_admission?.status,'queued');
    const receipt=JSON.parse(Buffer.from(await f.storage.read('media-postarchive-admissions',first.processing_receipt_ref!.slice('media-postarchive:'.length))).toString());
    assert.equal(receipt.schema,'paios.media.postarchive-admission.interval.v2');}
  const statuses=()=>f.published.filter((p:any)=>p.operation==='voice_status'&&p.operation_id==='window-1') as any[];
  f.sendText({operation:'voice_open',operation_id:'window-1'});
  await eventually(()=>statuses().some(p=>p.source_status==='recording'));
  const spoken=[waveform(1),waveform(2)];for(const frame of spoken)f.feed(frame);
  await eventually(()=>f.raws.filter(raw=>raw.event_id!==first.event.event_id).length===2);
  const voiceEventId=f.raws.at(-1)!.event_id;assert.notEqual(voiceEventId,first.event.event_id);
  if(interval){const spokenFrame=await latest(f,1);assert.equal(spokenFrame.event.event_id,voiceEventId);
    assert.deepEqual(spokenFrame.processing_admission,{status:'awaiting_window',consumer:'voice'});}
  f.sendText({operation:'voice_commit',operation_id:'window-1'});
  await eventually(()=>statuses().some(p=>p.source_status==='pending'));
  // The commit receipt names the window's event: the device follows the confirmed turn by this event_id.
  assert.equal(statuses().find(p=>p.source_status==='pending')!.event_id,voiceEventId);
  await eventually(()=>ScriptedQwenSocket.appended.length>0);
  // Exactly the voice span's bytes reach the frontend; ambient capture is excluded.
  assert.ok(Buffer.concat(ScriptedQwenSocket.appended.map(a=>Buffer.from(a,'base64'))).equals(Buffer.concat(spoken.map(pcmBytes))));
  let candidate:any;
  await eventually(async()=>{f.sendText({operation:'voice_candidates',operation_id:'window-1'});await new Promise(r=>setTimeout(r,20));
    candidate=statuses().filter(p=>p.source_status==='candidates').flatMap(p=>p.candidates).find((c:any)=>c.kind==='transcript');return !!candidate;});
  assert.equal(candidate.transcript,'帮我记下明天早上八点骑行。');assert.equal(candidate.authorization,'unknown');assert.equal(f.nativeInputs.length,0);
  f.sendText({operation:'voice_send',operation_id:'window-1',candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,
    window_ref:candidate.window_ref,selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:'0'.repeat(64)});
  // Voice errors answer on the operation's own voice_status (the contract every installed app already parses).
  await eventually(()=>statuses().some(p=>p.source_status==='unknown'&&p.error_code==='VOICE_EXACT_CONFIRMATION_REQUIRED'));
  assert.equal(f.published.some((p:any)=>p.operation==='rejected'&&p.request_operation==='voice_send'),false);
  assert.match(String(f.errors.pop()),/VOICE_EXACT_CONFIRMATION_REQUIRED/);
  assert.equal(f.nativeInputs.length,0);
  f.sendText({operation:'voice_send',operation_id:'window-1',candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,
    window_ref:candidate.window_ref,selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256});
  await eventually(()=>statuses().some(p=>p.source_status==='confirmation_recorded'));
  await eventually(()=>f.nativeInputs.some(d=>d.event_id===voiceEventId));
  const d=f.nativeInputs.find(d=>d.event_id===voiceEventId)!;assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');
  assert.equal(d.processing.path_id,'voice_frontend');
  if(interval){f.feed(waveform(3));const after=await latest(f,0);assert.notEqual(after.event.event_id,voiceEventId);
    assert.notEqual(after.event.event_id,first.event.event_id);assert.equal(after.processing_admission?.status,'queued');
    // Ambient speech without a wake word is journaled; the only run is the push-to-talk voice D.
    await f.owner.assembly.runtime.continuousMedia().drain();assert.ok(f.nativeInputs.every(d=>d.event_id===voiceEventId));}
  await eventually(()=>f.published.some((p:any)=>p.operation==='accepted'&&p.event_id===voiceEventId&&p.processed_event_id===d.processed_event_id));
  const acceptedCount=f.published.filter((p:any)=>p.operation==='accepted'&&p.event_id===voiceEventId).length;
  f.sendText({operation:'voice_send',operation_id:'window-1',candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,
    window_ref:candidate.window_ref,selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256});
  await eventually(()=>f.published.filter((p:any)=>p.operation==='accepted'&&p.event_id===voiceEventId).length>acceptedCount);
  assert.equal(f.nativeInputs.filter(d=>d.event_id===voiceEventId).length,1);
  // A send that was never recorded, for a window that no longer exists, is a definite rejection.
  f.sendText({operation:'voice_send',operation_id:'window-gone',candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,
    window_ref:candidate.window_ref,selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256});
  await eventually(()=>f.published.some((p:any)=>p.operation==='voice_status'&&p.operation_id==='window-gone'&&p.error_code==='VOICE_WINDOW_CLOSED'));
  assert.match(String(f.errors.pop()),/VOICE_WINDOW_CLOSED/);
  assert.equal(d.intent_class,'explicit_request');assert.match(JSON.stringify(d.content),/明天早上八点骑行/);
  assert.equal(d.source.capture_timing!.quality,'estimated');assert.equal(d.source.capture_timing!.uncertainty_ms,500);
  const receipts=await Promise.all((await f.storage.list('voice-confirmations')).map(async key=>
    JSON.parse(Buffer.from(await f.storage.read('voice-confirmations',key)).toString())));
  assert.ok(receipts.every(receipt=>receipt.schema==='paios.voice-confirmation.v1'));
  // Both existing authorities share this schema: exact-text adoption is distinct from speaker identity confirmation.
  const semantic=receipts.filter(receipt=>receipt.source==='formal_voice_send');assert.equal(semantic.length,1);
  assert.deepEqual(semantic[0],{schema:'paios.voice-confirmation.v1',source:'formal_voice_send',principal_id:d.principal_id,
    device_id:d.device_id,session_id:'continuity',operation_id:'window-1',candidate_ref:candidate.candidate_ref,
    candidate_revision:candidate.candidate_revision,window_ref:candidate.window_ref,
    selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256});
  const identity=receipts.filter(receipt=>receipt.confirmation_id!==undefined);
  assert.deepEqual(identity,[],'a PTT transcript without owner-like voiceprint evidence never opens an identity card');
  assert.equal(receipts.length,semantic.length);
  assert.ok(f.published.filter((packet:any)=>packet.operation==='voice_confirmations').every((packet:any)=>packet.confirmations.length===0));
  assert.deepEqual(f.errors,[]);
});
test('formal voice window: commit without open, empty window, and close without commit never create a voice D',async t=>{
  const f=await fixture(t,{voice:true,receiptClock:true});await connect(f);
  f.feed(waveform(0));await latest(f,0);
  const statuses=(op:string)=>f.published.filter((p:any)=>p.operation==='voice_status'&&p.operation_id===op) as any[];
  f.sendText({operation:'voice_commit',operation_id:'never-opened'});
  await eventually(()=>statuses('never-opened').some(p=>p.error_code==='FORMAL_PCM_VOICE_WINDOW_REQUIRED'));
  f.sendText({operation:'voice_open',operation_id:'empty'});await eventually(()=>statuses('empty').some(p=>p.source_status==='recording'));
  f.sendText({operation:'voice_commit',operation_id:'empty'});
  await eventually(()=>statuses('empty').some(p=>p.error_code==='FORMAL_PCM_VOICE_WINDOW_EMPTY'));
  f.sendText({operation:'voice_open',operation_id:'abandoned'});await eventually(()=>statuses('abandoned').some(p=>p.source_status==='recording'));
  f.feed(waveform(1));await eventually(()=>f.raws.length===2);
  f.sendText({operation:'voice_close',operation_id:'abandoned'});
  await eventually(()=>statuses('abandoned').some(p=>p.source_status==='cancel_requested'));
  f.feed(waveform(2));await eventually(()=>f.raws.length===3);
  assert.notEqual(f.raws[2]!.event_id,f.raws[1]!.event_id);assert.equal(f.nativeInputs.length,0);
});
test('voiceprint window beside the interval_v2 ambient lane: archived only (never the voice frontend, never a request), read back by enrollment',async t=>{
  const f=await fixture(t,{voice:true,receiptClock:true,voiceprint:true,budget:{archive_batch:batchBudget},continuous:true,interval:true});
  await connect(f);ScriptedQwenSocket.appended.length=0;
  f.feed(waveform(0));await latest(f,0);
  const samples=(op:string)=>f.published.filter((p:any)=>p.operation==='voiceprint_sample'&&p.operation_id===op) as any[];
  f.sendText({operation:'voiceprint_open',operation_id:'sentence-1'});await eventually(()=>samples('sentence-1').some(p=>p.status==='recording'));
  f.feed(waveform(1));f.feed(waveform(2));
  const spokenFrame=await latest(f,1);assert.deepEqual(spokenFrame.processing_admission,{status:'skipped',consumer:'audit_only'});
  // A request commit cannot take an enrollment window; the window stays open for its own commit.
  f.sendText({operation:'voice_commit',operation_id:'sentence-1'});
  await eventually(()=>f.published.some((p:any)=>p.operation==='voice_status'&&p.operation_id==='sentence-1'&&p.error_code==='FORMAL_PCM_VOICE_WINDOW_REQUIRED'));
  f.sendText({operation:'voiceprint_commit',operation_id:'sentence-1'});
  await eventually(()=>samples('sentence-1').some(p=>p.status!=='recording'));
  // The enrollment read the archived window and reached the engine (here unloadable fake models, so it fails closed).
  const done=samples('sentence-1').at(-1);assert.equal(done.status,'failed');assert.match(done.error_code,/^SPEECH_MODEL_(UNAVAILABLE|PIN_MISMATCH)$/u);
  assert.equal(ScriptedQwenSocket.appended.length,0,'the voice frontend never heard the enrollment sentence');
  assert.equal(f.nativeInputs.length,0,'an enrollment sentence never runs');
  f.feed(waveform(3));const after=await latest(f,0);assert.equal(after.processing_admission?.status,'queued','capture returns to the ambient lane');
});

test('phone and glasses have separate PCM collectors over one central assembly and media owner',async t=>{
  const phone = await fixture(t), glasses = await fixture(t,{terminal:{deviceId:'glasses',deviceType:'glasses'}});
  const first = await phone.create({retainAssembly:true});
  const second = await glasses.create({central:phone.options.central,sharedExecution:first.sharedExecution});
  try {
  assert.equal(first.assembly,second.assembly); assert.equal(first.media,second.media);
  assert.notEqual(first.pcmIngress,second.pcmIngress);
  await first.bridge.onBootstrapConnected!(phone.input);await second.bridge.onBootstrapConnected!(glasses.input);
  phone.subscribe();glasses.subscribe();phone.feed();glasses.feed(waveform(1));
  await eventually(async()=>await committedCount(phone.storage)>=2);
  const phoneSource=await first.assembly.runtime.authenticate(first.authority.credentialForBootstrap(phone.input));
  const glassSource=await first.assembly.runtime.authenticate(second.authority.credentialForBootstrap(glasses.input));
  assert.equal(phoneSource.device_id,'phone');assert.equal(glassSource.device_id,'glasses');assert.equal(glassSource.device_type,'glasses');
  assert.notEqual(phoneSource.route_version,glassSource.route_version);
  phone.feed(waveform(2));glasses.feed(waveform(3));
  await eventually(async()=>await committedCount(phone.storage)>=4);
  await assert.rejects(first.assembly.runtime.authenticate({}),/SOURCE_HOST_CREDENTIAL_REQUIRED/);
  } finally {await second.bridge.close?.();await first.bridge.close?.();await first.assembly.close();}
});

test('closing one producer detaches durable failed-publication waits while the shared terminal stays healthy',{timeout:10000},async t=>{
  const phone=await fixture(t),glasses=await fixture(t,{terminal:{deviceId:'glasses',deviceType:'glasses'}});
  const first=await phone.create({retainAssembly:true}),second=await glasses.create({central:phone.options.central,sharedExecution:first.sharedExecution});
  const payload=pcmBytes(waveform()),hash=sha256(payload),publish=phone.storage.publish.bind(phone.storage);let failed=true,attempts=0,forcedRelease=false;
  const cleanup=setTimeout(()=>{forcedRelease=true;failed=false;},9000);t.after(()=>{failed=false;clearTimeout(cleanup);});
  t.mock.method(phone.storage,'publish',async(...args:Parameters<typeof phone.storage.publish>)=>{
    if(args[0]==='objects'&&args[1]===hash){attempts++;if(failed)throw Object.assign(new Error('phone publication unavailable'),{code:'EIO'});}return publish(...args);
  });
  try{
    await first.bridge.onBootstrapConnected!(phone.input);await second.bridge.onBootstrapConnected!(glasses.input);phone.subscribe();glasses.subscribe();
    phone.feed();await eventually(()=>attempts>0);assert.equal((await phone.storage.list('raw-ingress')).length,1);
    await first.bridge.close!();assert.equal(forcedRelease,false,'close must detach durable waits before fault cleanup');
    assert.equal(first.pcmIngress!.snapshot().pending_frames,0);assert.equal(first.pcmIngress!.snapshot().latest,undefined);
    const keys=first.pcmIngress!.snapshot().pending_raw_keys;assert.equal(keys.length,1);
    const pending=JSON.parse(Buffer.from(await phone.storage.read('raw-ingress',keys[0]!)).toString());
    assert.equal(pending.record.trusted.device_id,'phone');assert.deepEqual(Buffer.from(await phone.storage.read('objects',pending.object_hash)),payload);
    glasses.feed(waveform(1));const healthy=await latest(glasses);
    assert.deepEqual(Buffer.from((await first.assembly.runtime.existingArchive().readExactChunk(healthy.event,healthy.chunk,4096)).bytes),pcmBytes(waveform(1)));
    assert.equal((await phone.storage.list('raw-ingress')).length,1,'other terminal publication cannot retire the retained phone original');assert.deepEqual(glasses.errors,[]);
    failed=false;await eventually(async()=>await committedCount(phone.storage)===2&&(await phone.storage.list('raw-ingress')).length===0);
    assert.equal((await phone.storage.list('raw-ingress')).length,0,'shared authority publishes the retained job after recovery without reopening its producer');
  }finally{failed=false;clearTimeout(cleanup);await second.bridge.close?.();await first.bridge.close?.();await first.assembly.close();}
});

test('microphone-only glasses archive PCM without opening a speaker call front',async t=>{
  const before=ScriptedQwenSocket.sockets.length;
  const f=await fixture(t,{voice:true,terminal:{deviceId:'glasses',deviceType:'glasses',capabilities:['display','microphone']}});
  await f.create();f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  f.feed(waveform());await latest(f);
  assert.equal(ScriptedQwenSocket.sockets.length,before);
  f.sendText({operation:'call_open',call_id:'call-microphone-only'});
  await eventually(()=>f.published.some(packet=>(packet as {error_code?:string}).error_code==='VOICE_CALL_NOT_CONFIGURED'));
  assert.equal(ScriptedQwenSocket.sockets.length,before);
});

test('live phone non-speech candidates retain exact L5 PCM and settle call-owned without ambient analysis',async t=>{
  const f=await fixture(t,{voice:true,continuous:true,budget:{max_samples:32768}});
  const events=new RuntimeEventStore({directory:join(f.storage.root,'runtime-events')});
  const detachEvents=installRuntimeEventStore(events);t.after(async()=>{detachEvents();await events.close();});
  const detector=f.pcm.ports!.detector as ReturnType<typeof controlledDetector>;
  Object.assign(detector.vad.vad_model.native_metadata,{sound_window_samples:512});
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'ambient-priority-track',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true})})};
  await f.create({central:{...f.options.central,voice}});f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  const state=(value:string)=>f.published.some((p:any)=>p.operation==='call_state'&&p.call_id==='ambient-priority'&&p.state===value);
  f.sendText({operation:'call_open',call_id:'ambient-priority'});await eventually(()=>state('live'));
  const runtime=f.owner.assembly.runtime,continuous=runtime.continuousMedia();
  const frames=Array.from({length:3},()=>continuousMarker(512,false));
  for(let n=0;n<frames.length;n++){
    f.feed(frames[n]!);const archived=await latest(f,n);
    const original=await runtime.existingArchive().readExactChunk(archived.event,archived.chunk,4096);
    assert.deepEqual(Buffer.from(original.bytes),pcmBytes(frames[n]!));
  }
  await continuous.drain();
  const candidates=await Promise.all((await f.storage.list('media-continuous-candidates')).map(async key=>
    JSON.parse(Buffer.from(await f.storage.read('media-continuous-candidates',key)).toString())));
  assert.equal(candidates.length,3);assert.ok(candidates.every(candidate=>candidate.reason==='non_speech'));
  const dispositions=await Promise.all((await f.storage.list('media-continuous-dispositions')).map(async key=>
    JSON.parse(Buffer.from(await f.storage.read('media-continuous-dispositions',key)).toString())));
  assert.equal(dispositions.length,3);assert.ok(dispositions.every(value=>value.state==='call_owned'&&value.raw_status==='durable'));
  assert.equal(continuous.snapshot().pending_candidates,0);
  assert.deepEqual(f.requests,[]);assert.deepEqual(f.nativeInputs,[]);
  assert.equal((await events.read()).filter(event=>event.ambient_stage==='candidate_ready').length,0,
    'call-owned candidates are durable dispositions, not ambient work ready for analysis');
  f.sendText({operation:'call_close',call_id:'ambient-priority'});await eventually(()=>state('closed'));
  await continuous.drain();
  assert.deepEqual(f.requests,[]);assert.deepEqual(f.nativeInputs,[]);assert.deepEqual(f.errors,[]);
});

test('a closing call releases realtime priority so deferred capture can finalize and the next call opens',async t=>{
  const f=await fixture(t,{voice:true,continuous:true,budget:{max_samples:32768}});
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'close-track',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true})})};
  const resolve=f.pcm.clock!.resolve;
  // This delayed capture precedes the call window, so the call cannot claim it as already heard.
  f.pcm.clock!.resolve=async(...args)=>({...await resolve(...args),offset_ms:f.base-60000});
  await f.create({central:{...f.options.central,voice}});f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  const state=(id:string,value:string)=>f.published.some((p:any)=>p.operation==='call_state'&&p.call_id===id&&p.state===value);
  f.sendText({operation:'call_open',call_id:'deferred-close'});await eventually(()=>state('deferred-close','live'));
  f.feed(continuousMarker(1024,true));await latest(f,0);f.feed(continuousMarker(512,false));await latest(f,1);
  const continuous=f.owner.assembly.runtime.continuousMedia();
  await eventually(()=>continuous.snapshot().pending_candidates===1);assert.equal(f.requests.length,0);
  f.sendText({operation:'call_close',call_id:'deferred-close'});
  try{
    await eventually(()=>state('deferred-close','closed'));
    // Closed seals capture; semantic admission has its own completion.
    await continuous.drain();
  }finally{continuous.cancelProcessing();}
  assert.equal(continuous.snapshot().pending_candidates,0);assert.equal(f.requests.length,1);
  f.sendText({operation:'call_open',call_id:'after-deferred-close'});await eventually(()=>state('after-deferred-close','live'));
  f.sendText({operation:'call_close',call_id:'after-deferred-close'});await eventually(()=>state('after-deferred-close','closed'));
  assert.deepEqual(f.errors,[]);
});

test('persistent execution keeps sound observations in context, outside chat, without care runs during or after a call',async t=>{
  const f=await fixture(t,{voice:true}),care=CareAuthority.open(join(f.storage.root,'care'));
  t.after(()=>{care.close();dispose();});
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  const contexts:string[]=[],instructions:string[]=[],spoken:string[]=[],notices:unknown[]=[];
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'care-track',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,
    createFront:(options:{instructions:string})=>{instructions.push(options.instructions);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},
      context:async(text:string)=>{contexts.push(text);},respond:async(text:string)=>{spoken.push(text);return {completed:true};}};}};
  await f.create({central:{...f.options.central,care,voice},notify:async notice=>{notices.push(notice);}});
  const runtime=f.owner.assembly.runtime;
  await runtime.configureTimeline({directory:join(f.storage.root,'timeline')});
  await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'live-care'});
  await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='live'));
  const source=await runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  runtime.timeline!.heard(source,[{burst_id:'live-care',device_id:source.device_id,speaker:'owner',event:'cough',start_ms:f.base,end_ms:f.base,count:1}]);
  assert.equal(f.nativeInputs.length,0);assert.equal(contexts.length,0);
  assert.ok(runtime.timeline!.observations(source.principal_id).some(item=>item.text.includes('cough')));
  assert.equal(runtime.timeline!.page(source.principal_id).items.some(item=>item.text.includes('cough')),false);
  f.sendText({operation:'call_close',call_id:'live-care'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='live-care'&&p.state==='closed'));
  await runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  f.sendText({operation:'call_open',call_id:'resumed-care'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='resumed-care'&&p.state==='live'));
  assert.equal(f.nativeInputs.length,0,'ending the call or reconnecting cannot schedule care');
  assert.ok(instructions.some(text=>text.includes('声音分类候选：cough')));
  assert.deepEqual(spoken,[]);assert.deepEqual(notices,[]);
  assert.equal(f.published.some((p:any)=>['ambient_reply','care_checkin'].includes(p.operation)),false);
  assert.deepEqual(f.errors,[]);
});

// Real loopback HTTP and WS transport, with scripted Vidu signals; no provider API or physical media.
async function fakeVidu(t:TestContext,notReady=false){
  const {WebSocket,WebSocketServer}=createRequire(new URL('../../../services/qwen-embedded/server/src/voice/node-websocket.mjs',import.meta.url))('ws');
  const creates:any[]=[],controls:any[]=[],pcm:Buffer[]=[],billing:string[]=[],live=Promise.withResolvers<void>();let socket:any,rejectWs=false;
  const media={provider:'artc' as const,app_id:'test-app',channel_id:'test-channel',user_id:'test-user',token:'short-lived-fixture-token',token_expire_at:'2000000000'};
  const server=createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Token offline-vidu-key');
    let body='';for await(const chunk of request)body+=chunk;
    response.setHeader('Content-Type','application/json');
    if(request.method==='POST'&&request.url==='/live/s_avatar/component'){creates.push(JSON.parse(body));response.end(JSON.stringify({live:{id:`live-${creates.length}`},managed_rtc:media}));}
    else{assert.match(request.url!,/^\/live\/v1\/lives\/live-\d+$/);billing.push(request.url!);response.end(JSON.stringify({live:{status:'ended',billed_seconds:3,credits_cost:4.5}}));}
  });
  const ws=new WebSocketServer({server,verifyClient:()=>!rejectWs});
  ws.on('connection',(connected:any,request:any)=>{
    assert.equal(request.headers.authorization,'Token offline-vidu-key');socket=connected;let init=0;
    connected.on('message',(raw:Buffer,binary:boolean)=>{if(binary){pcm.push(Buffer.from(raw));return;}const frame=JSON.parse(String(raw));controls.push(frame);
      if(frame.type===1){const ready=!notReady||++init>1;connected.send(JSON.stringify({type:2,payload:{conn_init_ack:{success:ready,error_code:ready?'':'NOT_READY'}}}));if(ready)live.resolve();}
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const retrieval=new Map();
  t.after(async()=>{for(const client of ws.clients)client.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {creates,controls,pcm,billing,media,live:live.promise,retrieval,send:(type:number,payload:object)=>socket.send(JSON.stringify({type,payload})),
    terminate:()=>socket.terminate(),rejectWs:()=>{rejectWs=true;},resources:{configuration:{provider:'vidu_component' as const,api_key_file:'/unused-fixture-key',avatar_id:'precreated-avatar',
      base_url:'https://renderer.invalid',component_model:'renderer-model',action_library_id:'gestures'},apiKey:'offline-vidu-key',
      fetch:((input,init)=>fetch(String(input).replace('https://renderer.invalid',origin),init)) as typeof fetch,
      connect:(url:string,headers:object)=>new WebSocket(url.replace('wss://renderer.invalid',origin.replace('http:','ws:')),{headers})}};
}

test('component acquisition leaves voice live and retires a late renderer after owner hangup',async t=>{
  const responseGate=latch(),accepted=latch();t.after(()=>responseGate.release());
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),spoken:number[]=[],retired:string[]=[];let front:any;
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:''}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{spoken.push(...frame.data);});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'pending-renderer-phone',waitForSubscription:async()=>{}}),unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:(callbacks:any)=>{front=callbacks;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'},
    fetch:async(input,init)=>{const response=await v.resources.fetch(input,init);if(init?.method!=='POST')return response;const body=await response.text();accepted.release();await responseGate.promise;return new Response(body,{status:response.status});}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'pending-renderer',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='pending-renderer'&&p.state==='live'));assert.equal(v.creates.length,0,'camera-enabled call does not acquire a paid avatar');f.sendText({operation:'call_avatar',call_id:'pending-renderer',avatar_revision:1,avatar:true});await accepted.promise;
  assert.ok(f.published.some((p:any)=>p.call_id==='pending-renderer'&&p.operation==='call_state'&&p.state==='live'));
  assert.equal(v.creates.length,1,'provider accepted the renderer before its response is released');
  front.onEvent({type:'response.created',response:{id:'pending-renderer-reply'}});
  front.onEvent({type:'response.audio.delta',response_id:'pending-renderer-reply',delta:Buffer.from(new Int16Array(480).fill(61).buffer).toString('base64')});
  front.onEvent({type:'response.done',response:{id:'pending-renderer-reply',status:'completed'}});
  await eventually(()=>spoken.length===480);assert.ok(spoken.every(sample=>sample===61));assert.deepEqual(v.pcm,[]);
  assert.equal(f.published.some((p:any)=>['closed','failed'].includes(p.state)),false,'renderer acquisition does not end the logical call');
  f.sendText({operation:'call_close',call_id:'pending-renderer'});await eventually(()=>retired.length===1&&f.published.some((p:any)=>p.call_id==='pending-renderer'&&p.state==='closing'));
  assert.deepEqual(retired,['pending-renderer-phone'],'owner hangup releases phone output before the POST response');
  responseGate.release();await eventually(()=>v.billing.length===1&&f.published.some((p:any)=>p.call_id==='pending-renderer'&&p.state==='closed'));
  assert.deepEqual(v.pcm,[]);assert.equal(f.published.some((p:any)=>p.avatar===true),false,'late renderer cannot publish media after hangup');
  assert.equal(v.billing[0],'/live/v1/lives/live-1');assert.deepEqual(f.errors,[]);
});

test('component cleanup reaches terminal billing while fallback notification is blocked',{timeout:10000},async t=>{
  const notification=latch(),blocked=latch();t.after(()=>notification.release());
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),spoken:number[]=[];let front:any,billed=false,notified=false;
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:''}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{spoken.push(...frame.data);});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'fallback-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:(callbacks:any)=>{front=callbacks;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'},
    fetch:async(input,init)=>{const response=await v.resources.fetch(input,init);if((init?.method??'GET')==='GET')billed=(await response.clone().json() as {live:{status:string}}).live.status==='ended';return response;}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'blocked-fallback'});await eventually(()=>f.published.some((p:any)=>p.call_id==='blocked-fallback'&&p.state==='live'));
  const port=f.options.participant.roomPort!.localParticipant!,send=port.publishData!.bind(port);
  Object.assign(port,{publishData:async(...args:Parameters<typeof send>)=>{
    const body=JSON.parse(Buffer.from(args[0]).toString());if(body.operation==='call_avatar_state'&&body.media)throw Error('MEDIA_NOTIFICATION_FAILED');
    if(body.operation==='call_avatar_state'&&body.error_code==='VIDU_COMPONENT_CREATE_FAILED'){blocked.release();await notification.promise;notified=true;}return send(...args);
  }});
  f.sendText({operation:'call_avatar',call_id:'blocked-fallback',avatar_revision:1,avatar:true});await blocked.promise;
  await eventually(()=>billed);assert.equal(v.billing.length,1);assert.equal(notified,false,'terminal billing does not wait for the fallback notification');
  front.onEvent({type:'response.created',response:{id:'after-fallback'}});
  front.onEvent({type:'response.audio.delta',response_id:'after-fallback',delta:Buffer.from(new Int16Array(480).fill(67).buffer).toString('base64')});
  front.onEvent({type:'response.done',response:{id:'after-fallback',status:'completed'}});
  await eventually(()=>spoken.length===480);assert.ok(spoken.every(sample=>sample===67));assert.deepEqual(v.pcm,[]);
  assert.equal(f.published.some((p:any)=>['closed','failed'].includes(p.state)),false,'blocked video notification leaves the logical voice call live');
  notification.release();await eventually(()=>notified);f.sendText({operation:'call_close',call_id:'blocked-fallback'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='blocked-fallback'&&p.state==='closed'));
  assert.ok(f.errors.some(error=>String(error).includes('MEDIA_NOTIFICATION_FAILED')));
});

test('component video retains one voice call across renderer failure, background and owner video enable',{timeout:10000},async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),fronts:any[]=[],spoken:number[]=[],published:string[]=[],retired:string[]=[];
  let phoneDrain:Promise<void>|undefined;const subscribed=Promise.withResolvers<void>();
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{spoken.push(...frame.data);});
  t.mock.method(AudioSource.prototype,'waitForPlayout',async()=>{await phoneDrain;});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>{const sid=`phone-${published.length}`;published.push(sid);return {sid,waitForSubscription:()=>subscribed.promise};},unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:(callbacks:any)=>{const current={...callbacks,updates:[] as string[],toolUpdates:[] as any[][],discarded:[] as string[]};fronts.push(current);
      return Object.freeze({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),
        setInstructions:async(text:string,options?:{tools?:unknown[]})=>{current.updates.push(text);if(options?.tools)current.toolUpdates.push(options.tools);},discardReply:(id:string)=>current.discarded.push(id)});}};
  let rejectCreate=true,failBinaryAfter=0;
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'},
    connect:(url,headers)=>{const client=v.resources.connect(url,headers),send=client.send.bind(client);
      client.send=(wire:string|Buffer)=>{if(Buffer.isBuffer(wire)&&failBinaryAfter&&--failBinaryAfter===0)throw new Error('BINARY_SEND_FAILED');send(wire);};return client;},
    fetch:(input,init)=>{if(rejectCreate&&init?.method==='POST'){rejectCreate=false;return Promise.resolve(new Response('{}',{status:503}));}return v.resources.fetch(input,init);}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'shared owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'component-call',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='component-call'&&p.state==='live'));assert.equal(v.creates.length,0,'camera-enabled call does not acquire a paid avatar');f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:1,avatar:true});await eventually(()=>f.published.some((p:any)=>p.state==='live'));
  await eventually(()=>f.published.some((p:any)=>p.avatar===false&&p.error_code==='VIDU_COMPONENT_CREATE_FAILED'));
  assert.equal(fronts.length,1);assert.equal(published.length,1);assert.deepEqual(spoken,[]);assert.equal(v.retrieval.size,0);subscribed.resolve();
  const front=fronts[0];assert.match(front.updates.at(-1),/数字人未打开/);assert.deepEqual(front.tools,[]);assert.deepEqual(front.toolUpdates.at(-1)?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn']);
  assert.ok(f.published.some((p:any)=>p.state==='live'&&p.avatar===false&&p.error_code==='VIDU_COMPONENT_CREATE_FAILED'));
  assert.equal(v.creates.length,0);assert.equal(f.published.some((p:any)=>['closed','failed'].includes(p.state)),false);
  f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:2,avatar:true});await eventually(()=>front.onTool('avatar_gesture',{action:'rest'}).sent);
  await eventually(()=>front.updates.at(-1)?.includes('数字人已打开'));assert.deepEqual(front.toolUpdates.at(-1)?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn','avatar_gesture']);
  front.onEvent({type:'response.created',response:{id:'gesture'}});assert.deepEqual(front.onTool('avatar_gesture',{action:'wave'}),{sent:true});
  front.onEvent({type:'response.done',response:{id:'gesture',output:[{type:'function_call'}],status:'completed'}});
  const reply=(id:string,value:number,samples=480)=>{front.onEvent({type:'response.created',response:{id}});front.onEvent({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(samples).fill(value).buffer).toString('base64')});
    front.onEvent({type:'response.done',response:{id,status:'completed'}});};
  reply('first',42,960);await eventually(()=>v.pcm.length>=1);assert.deepEqual(spoken,[]);assert.equal(front.discarded.includes('gesture'),false);
  f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:3,avatar:false});await eventually(()=>v.billing.length===1);
  await eventually(()=>spoken.length===960);assert.ok(spoken.every(v=>v===42),'sent-but-unheard and unsent reply PCM reach voice before newer audio');
  await eventually(()=>front.updates.at(-1)?.includes('数字人未打开'));
  const firstVideoFrames=v.pcm.length;
  await eventually(()=>front.updates.at(-1)?.includes('数字人未打开'));
  assert.equal(fronts.length,1);assert.equal(published.length,1);assert.deepEqual(retired,[]);assert.match(front.updates.at(-1),/数字人未打开/);
  assert.ok(f.published.some((p:any)=>p.call_id==='component-call'&&p.state==='live'&&p.avatar===false));
  assert.ok(f.published.some((p:any)=>p.operation==='call_playback_reset'&&p.target==='avatar'&&!p.track_sid));
  const draining=Promise.withResolvers<void>();phoneDrain=draining.promise;
  reply('voice',73);await eventually(()=>spoken.length===1440);assert.ok(spoken.slice(960).every(v=>v===73));assert.equal(v.pcm.length,firstVideoFrames);assert.equal(v.creates.length,1,'voice output cannot reopen backgrounded video');
  f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:4,avatar:true});await new Promise(setImmediate);
  assert.equal(v.creates.length,1,'existing direct voice finishes before another paid renderer opens');assert.match(front.updates.at(-1),/数字人未打开/);assert.deepEqual(front.toolUpdates.at(-1)?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn']);draining.resolve();await eventually(()=>v.creates.length===2);
  await eventually(()=>f.published.filter((p:any)=>p.media?.audio_input==='gateway').length===2);await eventually(()=>front.onTool('avatar_gesture',{action:'rest'}).sent);
  reply('video-again',91);await eventually(()=>v.pcm.length===firstVideoFrames+1);
  assert.equal(fronts.length,1);assert.equal(published.length,1);assert.equal(spoken.length,1440);assert.equal(f.published.some((p:any)=>p.state==='closed'),false);
  v.send(6,{hangup:{hangup_reason:'force_hangup'}});await eventually(()=>v.billing.length===2);
  await eventually(()=>front.updates.at(-1)?.includes('数字人未打开'));
  await eventually(()=>f.published.some((p:any)=>p.state==='live'&&p.avatar===false&&p.error_code==='VIDU_COMPONENT_ENDED'));
  assert.equal(f.published.some((p:any)=>p.state==='closed'),false);assert.equal(fronts.length,1);
  await eventually(()=>spoken.length===1920);assert.ok(spoken.slice(1440).every(v=>v===91));
  reply('voice-after-provider-end',97);await eventually(()=>spoken.length===2400);assert.ok(spoken.slice(1920).every(v=>v===97));assert.equal(v.creates.length,2);
  f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:5,avatar:true});await eventually(()=>v.creates.length===3);
  await eventually(()=>front.onTool('avatar_gesture',{action:'rest'}).sent);reply('reconnect-tail',99,960);await eventually(()=>v.pcm.length>firstVideoFrames+1);
  const port=f.options.participant.roomPort!.localParticipant!,send=port.publishData!.bind(port),offBefore=f.published.filter((p:any)=>p.operation==='call_avatar_state'&&p.avatar===false).length;
  let loseOff=true;
  Object.assign(port,{publishData:async(...[bytes,options]:Parameters<typeof send>)=>{const body=JSON.parse(Buffer.from(bytes).toString());if(loseOff&&body.operation==='call_avatar_state'&&body.avatar===false){loseOff=false;throw new Error('OFF_ACK_PUBLICATION_FAILED');}return send(bytes,options);}});
  f.reconnecting();await eventually(()=>v.billing.length===3);await eventually(()=>spoken.length===3360);
  assert.ok(spoken.slice(2400).every(v=>v===99));assert.equal(fronts.length,1);assert.deepEqual(retired,[]);
  assert.equal(f.published.filter((p:any)=>p.operation==='call_avatar_state'&&p.avatar===false).length,offBefore,'lost video-off ACK is not treated as delivered');
  f.reconnected();await eventually(()=>f.published.filter((p:any)=>p.operation==='call_avatar_state'&&p.avatar===false).length>offBefore);
  assert.equal(f.published.some((p:any)=>p.state==='closed'),false,'recoverable upstream loss preserves the same call');
  f.sendText({operation:'call_avatar',call_id:'component-call',avatar_revision:6,avatar:true});await eventually(()=>v.creates.length===4);
  await eventually(()=>front.onTool('avatar_gesture',{action:'rest'}).sent);const framesBeforeFailure=v.pcm.length;
  failBinaryAfter=2;reply('binary-send-tail',101,960);await eventually(()=>f.errors.some(error=>String(error).includes('VIDU_COMPONENT_PLAYOUT_FAILED')));
  reply('voice-after-binary-failure',103);await eventually(()=>spoken.length===4800&&v.billing.length===4);
  assert.equal(v.pcm.length,framesBeforeFailure+1,'one sent frame and one unsent frame share the failed renderer tail');
  assert.ok(spoken.slice(3360,4320).every(v=>v===101));assert.ok(spoken.slice(4320).every(v=>v===103),'renderer tail precedes newer phone audio');
  assert.equal(fronts.length,1);assert.equal(f.published.some((p:any)=>p.state==='closed'),false);
  f.remoteDisconnect();await new Promise(setImmediate);assert.ok(v.controls.some(p=>p.type===7));assert.equal(v.controls.filter(p=>p.type===5).length,4);
  assert.deepEqual(retired,[],'peer departure preserves the phone track during the server rejoin window');assert.ok(f.errors.some(error=>String(error).includes('VIDU_COMPONENT_CREATE_FAILED')));
  assert.ok(f.errors.some(error=>String(error).includes('OFF_ACK_PUBLICATION_FAILED')));
});


test('call appearance is pinned before the first avatar enable and a new call gets the changed profile',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t);let active='appearance-at-open',reads=0;
  const avatar=new AvatarProfileService({looks:[],store:{
    read:async principal=>({principal_id:principal,version:1,active:null,active_avatar_id:active,requested_command:null}),
    outstanding:async()=>[],transact:async()=>{throw Error('unexpected appearance mutation');}}});
  t.after(()=>avatar.close());
  const activeAvatarId=avatar.activeAvatarId.bind(avatar);t.mock.method(avatar,'activeAvatarId',async (principal:string)=>{reads++;return activeAvatarId(principal);});
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'appearance-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
  await f.create({avatar,videoCall:v.resources,central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'appearance-first'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-first'&&p.state==='live'));
  assert.equal(reads,1,'a voice call pins its appearance before any paid renderer request');
  assert.equal(v.creates.length,0);
  active='appearance-for-next-call';
  f.sendText({operation:'call_avatar',call_id:'appearance-first',avatar_revision:1,avatar:true});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-first'&&p.avatar===true));
  assert.equal(v.creates[0].avatar_id,'appearance-at-open');assert.equal(reads,1);
  f.sendText({operation:'call_close',call_id:'appearance-first'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-first'&&p.state==='closed'));
  f.sendText({operation:'call_open',call_id:'appearance-second'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-second'&&p.state==='live'));
  f.sendText({operation:'call_avatar',call_id:'appearance-second',avatar_revision:1,avatar:true});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-second'&&p.avatar===true));
  assert.equal(v.creates[1].avatar_id,'appearance-for-next-call');assert.equal(reads,2);
  f.sendText({operation:'call_close',call_id:'appearance-second'});
  await eventually(()=>f.published.some((p:any)=>p.call_id==='appearance-second'&&p.state==='closed'));
  assert.deepEqual(f.errors,[]);
});

test('latest owner video revision survives an older authorized ON and duplicate commands',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t);
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'revision-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'}},central:{...f.options.central,voice}});
  const runtime=f.owner.assembly.runtime;t.mock.method(runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  const states=()=>f.published.filter((p:any)=>p.operation==='call_avatar_state'&&p.call_id==='ordered') as any[];
  f.sendText({operation:'call_open',call_id:'ordered'});await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.call_id==='ordered'&&p.state==='live'));assert.deepEqual(states(),[],'default OFF does not send unknown outputs to legacy clients');
  const entered=latch(),release=latch(),ownerInput=runtime.ownerInput.bind(runtime);let held=false,settled=false;
  t.after(()=>release.release());t.mock.method(runtime,'ownerInput',async(...args:Parameters<typeof runtime.ownerInput>)=>{
    if(!held){held=true;entered.release();await release.promise;try{return await ownerInput(...args);}finally{settled=true;}}return ownerInput(...args);
  });
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:1,avatar:true});await entered.promise;
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:2,avatar:false});await eventually(()=>states().some(p=>p.avatar_revision===2&&p.avatar===false));
  const acknowledged=states().length;release.release();await eventually(()=>settled);await new Promise(setImmediate);
  assert.equal(v.creates.length,0);assert.equal(states().slice(acknowledged).some(p=>p.avatar===true),false);assert.equal(states().at(-1).avatar_revision,2);
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:2,avatar:false});await eventually(()=>states().length>acknowledged);
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:3,avatar:true});await eventually(()=>states().some(p=>p.avatar_revision===3&&p.avatar===true));
  assert.equal(v.creates.length,1,'the latest owner can still enable video after the rejected stale ON');
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:3,avatar:true});await new Promise(setImmediate);assert.equal(v.creates.length,1,'same revision is idempotent');
  f.reconnecting();await eventually(()=>v.billing.length===1);f.reconnected();await eventually(()=>states().some(p=>p.avatar_revision===3&&p.avatar===false));
  assert.equal(states().at(-1).avatar_revision,3,'system recovery does not consume the owner revision');
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:4,avatar:true});await eventually(()=>states().some(p=>p.avatar_revision===4&&p.avatar===true));
  assert.equal(v.creates.length,2);
  const port=f.options.participant.roomPort!.localParticipant!,send=port.publishData!.bind(port);let rejectOff=true;
  Object.assign(port,{publishData:async(...args:Parameters<typeof send>)=>{
    const body=JSON.parse(Buffer.from(args[0]).toString());if(rejectOff&&body.operation==='call_avatar_state'&&body.call_id==='ordered'&&body.avatar_revision===5&&body.avatar===false){rejectOff=false;throw Error('CONNECTED_OFF_ACK_FAILED');}return send(...args);
  }});
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:5,avatar:false});
  await eventually(()=>v.billing.length===2&&f.errors.some(error=>String(error).includes('CONNECTED_OFF_ACK_FAILED')));
  assert.equal(states().some(p=>p.avatar_revision===5&&p.avatar===false),false,'failed publication does not deliver the OFF acknowledgement');
  f.sendText({operation:'call_avatar',call_id:'ordered',avatar_revision:5,avatar:false});
  await eventually(()=>states().some(p=>p.avatar_revision===5&&p.avatar===false));
  assert.equal(v.creates.length,2);assert.equal(v.billing.length,2);assert.equal(states().at(-1).state,'live','matching OFF retry succeeds on the same connected call');
  f.sendText({operation:'call_close',call_id:'ordered'});await eventually(()=>states().some(p=>p.state==='closed'));
  assert.ok(f.errors.length>0);assert.ok(f.errors.every(error=>String(error).includes('CONNECTED_OFF_ACK_FAILED')));
});

test('avatar instruction refresh failure after held creation reconciles the same revision without a second paid live',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),entered=latch(),release=latch(),tools:unknown[][]=[];
  let failRefresh=false; t.after(()=>release.release());
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'instruction-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1,collect:()=>{}} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),
      setInstructions:async(_text:string,options?:{tools?:unknown[]})=>{if(failRefresh){failRefresh=false;throw Error('AVATAR_INSTRUCTION_UPDATE_FAILED');}tools.push(options?.tools??[]);}})};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'},
    fetch:async(input,init)=>{if(init&&'method' in init&&init.method==='POST'){entered.release();await release.promise;}return v.resources.fetch(input,init);}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  const states=()=>f.published.filter((p:any)=>p.operation==='call_avatar_state'&&p.call_id==='instruction-retry') as any[];
  f.sendText({operation:'call_open',call_id:'instruction-retry'});await eventually(()=>f.published.some((p:any)=>p.call_id==='instruction-retry'&&p.state==='live'));
  failRefresh=true;const before=tools.length;
  f.sendText({operation:'call_avatar',call_id:'instruction-retry',avatar_revision:1,avatar:true});await entered.promise;await new Promise(setImmediate);
  assert.equal(f.errors.length,0);assert.equal(tools.length,before,'no stale OFF refresh or early failure while paid creation is held');
  release.release();await eventually(()=>f.errors.some(error=>String(error).includes('AVATAR_INSTRUCTION_UPDATE_FAILED')));
  assert.equal(v.creates.length,1);assert.equal(tools.length,before,'the failed final update does not apply tools');
  f.sendText({operation:'call_avatar',call_id:'instruction-retry',avatar_revision:1,avatar:true});
  const gesture=()=>(tools.at(-1) as {name:string}[]|undefined)?.some(tool=>tool.name==='avatar_gesture')===true;
  await eventually(gesture);assert.equal(v.creates.length,1,'explicit same-revision retry reuses the live renderer');
  f.sendText({operation:'call_avatar',call_id:'instruction-retry',avatar_revision:2,avatar:true});
  await eventually(()=>states().some(p=>p.avatar_revision===2&&p.avatar===true));assert.equal(v.creates.length,1);
  v.send(6,{});
  await eventually(()=>v.billing.length===1&&states().some(p=>p.avatar_revision===2&&p.avatar===false));
  f.sendText({operation:'call_avatar',call_id:'instruction-retry',avatar_revision:3,avatar:false});
  await eventually(()=>states().some(p=>p.avatar_revision===3&&p.avatar===false));
  assert.equal(gesture(),false);f.sendText({operation:'call_close',call_id:'instruction-retry'});await eventually(()=>states().some(p=>p.state==='closed'));
  assert.equal(v.creates.length,1);assert.equal(v.billing.length,1);
});

test('stale video provider fails composition and absent video stays voice across background/reconnect',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t);
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'rollback-voice',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true})})};
  await assert.rejects(f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_realtime'} as never},central:{...f.options.central,voice}}),/PRODUCT_VIDEO_PROVIDER_UNSUPPORTED/);
  await f.create({central:{...f.options.central,voice}});t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');
  await f.owner.bridge.onBootstrapConnected!(f.input);f.sendText({operation:'call_open',call_id:'rollback',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='rollback'&&p.state==='live'));assert.equal(v.creates.length,0,'camera-enabled call does not acquire a paid avatar');f.sendText({operation:'call_avatar',call_id:'rollback',avatar_revision:1,avatar:true});
  await eventually(()=>f.published.some((p:any)=>p.state==='live'));assert.equal(v.creates.length,0);assert.equal(f.published.some((p:any)=>p.media),false);
  assert.ok(f.published.some((p:any)=>p.state==='live'&&p.video===true&&p.video_revision===0));
  f.sendText({operation:'call_avatar',call_id:'rollback',avatar_revision:2,avatar:false});f.reconnecting();f.reconnected();await new Promise(setImmediate);
  assert.equal(v.creates.length,0);assert.equal(f.published.some((p:any)=>p.state==='closed'),false);
  assert.ok(f.published.some((p:any)=>p.call_id==='rollback'&&p.state==='live'&&p.avatar===false));
  f.sendText({operation:'call_avatar',call_id:'rollback',avatar_revision:3,avatar:true});await eventually(()=>f.published.some((p:any)=>p.avatar_revision===3&&p.avatar===false&&p.error_code==='AVATAR_CALL_DISABLED'));
  assert.equal(v.creates.length,0);f.sendText({operation:'call_close',call_id:'rollback'});await eventually(()=>f.published.some((p:any)=>p.state==='closed'));
  assert.deepEqual(f.errors,[]);
});

test('component cleanup failure still releases phone output and publishes the owner hangup',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),retired:string[]=[];
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'cleanup-phone',waitForSubscription:async()=>{}}),unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'},
    connect:(url,headers)=>{const socket=v.resources.connect(url,headers),send=socket.send.bind(socket);socket.send=(data:string|Buffer)=>{if(typeof data==='string'&&JSON.parse(data).type===7)throw Error('CONTROL_SEND_FAILED');send(data);};return socket;}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  const realtimeBusy=()=>[...f.owner.sharedExecution.terminals.values()].some(terminal=>terminal.realtimeBusy());
  assert.equal(realtimeBusy(),false);
  f.sendText({operation:'call_open',call_id:'cleanup',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='cleanup'&&p.state==='live'));assert.equal(v.creates.length,0,'camera-enabled call does not acquire a paid avatar');f.sendText({operation:'call_avatar',call_id:'cleanup',avatar_revision:1,avatar:true});await eventually(()=>f.published.some((p:any)=>p.state==='live')&&f.published.some((p:any)=>p.media?.audio_input==='gateway'));
  assert.equal(realtimeBusy(),true);
  f.sendText({operation:'call_close',call_id:'cleanup'});await eventually(()=>f.published.some((p:any)=>p.state==='closed'));
  assert.equal(realtimeBusy(),false);
  assert.deepEqual(retired,['cleanup-phone']);assert.equal(v.billing.length,1);assert.ok(v.controls.some(p=>p.type===5));
  assert.ok(f.errors.some(error=>String(error).includes('CLEANUP_FAILED')));
});

test('component route offsets protect a partly heard reply through background voice handoff',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),spoken:number[]=[],diagnostics:any[]=[],drain=Promise.withResolvers<void>();let front:any,hold=false;
  t.mock.method(process.stderr,'write',((chunk:any)=>{for(const line of String(chunk).split('\n'))try{const value=JSON.parse(line);if(value.voice_call_stage==='protected_prefix_played')diagnostics.push(value);}catch{}return true;}) as never);
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:'你'.repeat(150)}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{spoken.push(...frame.data);});
  t.mock.method(AudioSource.prototype,'waitForPlayout',async()=>{if(hold)await drain.promise;});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'offset-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:(callbacks:any)=>{front=callbacks;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'}},central:{...f.options.central,voice}});
  const runtime=f.owner.assembly.runtime,admit=runtime.admitMedia.bind(runtime),archived:Promise<{bytes:Buffer;timebase:string;epoch:string}>[]=[];let admittedSamples=0;
  const rawArchive=new RawArchive(f.storage,4096,undefined,parseMediaReplayConfiguration(f.pcm.configuration,true).stream_budget);
  t.mock.method(runtime,'admitMedia',async(...args:Parameters<typeof runtime.admitMedia>)=>{
    const pending=admit(...args);if(args[2].track_id==='assistant_reply'){admittedSamples+=args[0].payload.length/2;archived.push(pending.then(async admitted=>{
      const published=await admitted.commit;return {bytes:Buffer.from((await rawArchive.readExactChunk(published.event,args[2],4096)).bytes),timebase:args[2].source_range.timebase_id,epoch:args[2].stream_epoch};
    }));}return pending;
  });
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  t.after(()=>drain.resolve());f.sendText({operation:'call_open',call_id:'offset',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='offset'&&p.state==='live'));assert.equal(v.creates.length,0,'camera-enabled call does not acquire a paid avatar');f.sendText({operation:'call_avatar',call_id:'offset',avatar_revision:1,avatar:true});await eventually(()=>f.published.some((p:any)=>p.avatar===true&&p.media));
  front.onEvent({type:'response.created',response:{id:'offset-reply'}});
  front.onEvent({type:'response.audio_transcript.delta',response_id:'offset-reply',delta:'你'.repeat(150)});
  front.onEvent({type:'response.audio.delta',response_id:'offset-reply',delta:Buffer.from(new Int16Array(28800).fill(57).buffer).toString('base64')});
  front.onEvent({type:'response.done',response:{id:'offset-reply',status:'completed'}});
  await new Promise(resolve=>setTimeout(resolve,2600));assert.equal(diagnostics.length,0,'sent PCM is not already played');
  hold=true;f.sendText({operation:'call_avatar',call_id:'offset',avatar_revision:2,avatar:false});await eventually(()=>diagnostics.length===1);
  assert.equal(diagnostics[0]!.played_samples,28800,'renderer estimate plus phone route offset reaches the original reply position');
  assert.ok(spoken.length>0&&spoken.length<28800,'only the inferred unheard tail is transferred');assert.ok(spoken.every(v=>v===57));
  assert.equal(f.published.some((p:any)=>p.operation==='call_transcript'&&p.role==='assistant'),false,'old renderer drain cannot finish before voice tail drains');
  drain.resolve();f.sendText({operation:'call_close',call_id:'offset'});await eventually(()=>f.published.some((p:any)=>p.state==='closed'));
  await eventually(()=>admittedSamples===28800);const records=await Promise.all(archived);await f.owner.bridge.close?.();const estimated=records.filter(r=>r.timebase.startsWith('render-estimate-pcm:')),heard=records.filter(r=>r.timebase.startsWith('played-pcm:'));
  assert.ok(estimated.length>0&&heard.length>0,'archive preserves renderer estimates separately from phone playout');
  assert.equal(estimated.reduce((n,r)=>n+r.bytes.length/2,0)+spoken.length,28800,'renderer prefix and transferred suffix cover the original reply exactly once');
  assert.deepEqual(Buffer.concat(heard.map(r=>r.bytes)),Buffer.from(new Int16Array(spoken).buffer),'only the consuming phone route archives the transferred suffix');
  assert.deepEqual(Buffer.concat(records.map(r=>r.bytes)),Buffer.from(new Int16Array(28800).fill(57).buffer));
  assert.equal(new Set(estimated.map(r=>r.epoch)).size+new Set(heard.map(r=>r.epoch)).size,new Set(records.map(r=>r.epoch)).size,'position transition starts a distinct archive epoch');
  assert.deepEqual(f.errors,[]);
});

test('capture reserve prepares before attaching the microphone reader',async t=>{
  const f=await fixture(t);await f.create();f.addExisting();const entered=latch(),release=latch();t.after(()=>release.release());
  const archive=f.owner.assembly.runtime.existingArchive(),prepare=archive.prepareCapture.bind(archive);
  t.mock.method(archive,'prepareCapture',async()=>{entered.release();await release.promise;await prepare();});
  const connecting=f.owner.bridge.onBootstrapConnected!(f.input);await entered.promise;
  assert.equal(f.streams,0,'SDK acquisition cannot precede durable capture reserve preparation');
  release.release();await connecting;assert.equal(f.streams,1);f.feed();await latest(f);assert.deepEqual(f.errors,[]);
});

test('unavailable capture reserve pauses microphone attachment and reaches the owner app',async t=>{
  const f=await fixture(t);await f.create();f.addExisting();
  t.mock.method(f.owner.assembly.runtime.existingArchive(),'prepareCapture',async()=>{throw Object.assign(new Error('disk full before capture'),{code:'ENOSPC'});});
  await f.owner.bridge.onBootstrapConnected!(f.input);
  assert.equal(f.streams,0);assert.equal(f.owner.pcmIngress!.snapshot().paused_reason,'capture_storage_unavailable');
  assert.ok(f.errors.some(error=>(error as NodeJS.ErrnoException).code==='ENOSPC'));
  assert.ok(f.published.some((packet:any)=>packet.operation==='ambient_reply'),'actual app route delivers the capture pause notice');
});

test('failed initial clock-basis storage quarantines exact microphone bytes without guessed UTC',async t=>{
  const f=await fixture(t);await connect(f);let unavailable=true;
  const persist=f.storage.publishIngressMeta.bind(f.storage);
  t.mock.method(f.storage,'publishIngressMeta',async(...args:Parameters<typeof f.storage.publishIngressMeta>)=>{
    if(args[0]==='source-clock-bases'&&unavailable)throw Object.assign(new Error('clock basis disk full'),{code:'ENOSPC'});return persist(...args);
  });
  const heard:Int16Array[]=[];f.owner.pcmIngress!.tap(pcm=>{heard.push(pcm.slice());});f.feed(waveform());
  await eventually(()=>!!f.owner.pcmIngress!.snapshot().latest_quarantine);const q=f.owner.pcmIngress!.snapshot().latest_quarantine!;
  assert.equal(q.event.capture_clock_status,'unknown');assert.equal(q.event.captured_at,null);assert.equal(Object.hasOwn(q.event,'time_range'),false);
  assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes),pcmBytes(waveform()));
  assert.equal(heard.length,1);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(await committedCount(f.storage),0);
  unavailable=false;f.feed(waveform(1));await latest(f,1);assert.equal(heard.length,2);assert.equal(await committedCount(f.storage),1);
  assert.ok(f.errors.some(error=>String(error).includes('MEDIA_CLOCK_BASIS_STORAGE_UNAVAILABLE')));
});

test('disk-full microphone publication retains the failed first frame and acknowledges it after storage recovery',async t=>{
  const f=await fixture(t);await f.create();f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  const heard:Int16Array[]=[];f.owner.pcmIngress!.tap(pcm=>{heard.push(pcm.slice());});
  const publish=f.storage.publish.bind(f.storage);let failed=true,attempts=0;
  t.mock.method(f.storage,'publish',async(...args:Parameters<typeof f.storage.publish>)=>{
    if(args[0]==='objects'){attempts++;if(failed)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}
    return publish(...args);
  });
  f.feed(waveform());await eventually(()=>attempts>0);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
  assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);assert.equal(heard.length,1,'live microphone tap does not wait for disk recovery');
  assert.equal((await f.storage.list('raw-ingress')).length,1,'failed publication retains a durable source-authorized original');
  failed=false;await latest(f,0);const first=f.owner.pcmIngress!.snapshot().latest!;
  assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(first.event,first.chunk,4096)).bytes),pcmBytes(waveform()));
  assert.ok(attempts>=2,'failed first publication is retried rather than skipped');
  f.feed(waveform(1));await latest(f,1);assert.equal(heard.length,2);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);await f.owner.bridge.close?.();
});

function syntheticCameraEncoder(at:number):NonNullable<FormalPcmResources['cameraEncoderFactory']>{
  return (trackId,archive)=>({write:async(event)=>{
    const stamp=Number(event.timestampUs),bytes=Buffer.from([0,0,0,1,0x65,stamp]);
    await archive({bytes,mime:'video/h264',trackId,startedAt:at+stamp,endedAt:at+stamp+1,width:1280,height:720,
      sourceWidth:event.frame.width,sourceHeight:event.frame.height,rotation:event.rotation,frameCount:1,
      sourceFrames:[{timestampUs:String(event.timestampUs),receivedAt:at+stamp}]});
  },finish:async()=>{}});
}

// Synthetic admission isolates owner-wide flow control; durable byte continuity is covered above with RawArchive.
for(const phase of ['admission pressure','admission failure','late old admission failure','publication delay'])test(`reply archive ${phase} never pauses conversation and resets for the next call`,async t=>{
  const rejectAdmission=phase.includes('failure');
  const gate=latch();t.after(()=>gate.release());const f=await fixture(t,{voice:true}),fronts:any[]=[];
  let captured=0,admitted=0,completed=0,wrongSamples=false,fail=rejectAdmission;
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:''}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{captured+=frame.data.length;wrongSamples ||= frame.data.some((sample:number)=>sample!==71);});
  t.mock.method(AudioSource.prototype,'waitForPlayout',async()=>{});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:`pressure-${fronts.length}`,waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:(callbacks:any)=>{const front={...callbacks,paused:false,pressure:[] as boolean[]};fronts.push(front);
    return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),setOutputPaused:(paused:boolean)=>{front.paused=paused;front.pressure.push(paused);}};}};
  await f.create({central:{...f.options.central,voice}});const runtime=f.owner.assembly.runtime;
  t.mock.method(runtime,'callContext',async()=> 'owner context');t.mock.method(runtime,'archiveAlert',async()=>{});
  t.mock.method(runtime.existingArchive(),'endSession',async()=>null);
  t.mock.method(f.owner.clock!,'capture',async()=>({metadata:{captured_at:new Date(f.base).toISOString(),time_range:{kind:'instant',timebase_id:'utc_epoch_ms',at_ms:f.base}},capture_timing:{basis_ref:'synthetic-flow-only',quality:'synthetic',uncertainty_ms:0}} as never));
  t.mock.method(runtime,'admitMedia',async(...[raw,_source,chunk]:Parameters<typeof runtime.admitMedia>)=>{
    assert.equal(chunk.track_id,'assistant_reply');const samples=raw.payload.byteLength/2;admitted+=samples;
    if(phase==='publication delay')return {key:`synthetic-publication-${admitted}`,commit:gate.promise.then(()=>{completed+=samples;return {event:{raw_ref:`l5:${digest(['synthetic-publication',raw.event_id])}`}};})} as never;
    const fails=fail;await gate.promise;if(fails)throw new Error('SYNTHETIC_ARCHIVE_ADMISSION_FAILED');completed+=samples;return {key:`synthetic-pressure-${completed}`,commit:Promise.resolve({event:{raw_ref:`l5:${digest(['synthetic-pressure',raw.event_id])}`}})} as never;
  });
  f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  const live=(id:string)=>f.published.some((p:any)=>p.call_id===id&&p.state==='live');
  const produce=(front:any,id:string,samples:number)=>{if(front.paused)return false;front.onEvent({type:'response.created',response:{id}});
    front.onEvent({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(samples).fill(71).buffer).toString('base64')});
    front.onEvent({type:'response.done',response:{id,status:'completed'}});return true;};
  f.sendText({operation:'call_open',call_id:'pressure-first'});await eventually(()=>live('pressure-first'));const first=fronts.at(-1);
  assert.equal(produce(first,'fills-archive',CALL_PCM_LIMITS.max_samples),true);
  await eventually(()=>admitted===CALL_PCM_LIMITS.max_samples&&!first.paused);assert.equal(captured,CALL_PCM_LIMITS.max_samples);assert.equal(completed,0);
  assert.equal(produce(first,'during-pressure',480),true);await eventually(()=>captured===CALL_PCM_LIMITS.max_samples+480);
  assert.equal(first.paused,false,'archive pressure cannot pause the Qwen receive socket');
  if(phase==='late old admission failure'){
    await eventually(()=>admitted===captured);
    f.sendText({operation:'call_close',call_id:'pressure-first'});await eventually(()=>f.published.some((p:any)=>p.call_id==='pressure-first'&&p.state==='closed'));
    fail=false;
    f.sendText({operation:'call_open',call_id:'pressure-next'});await eventually(()=>live('pressure-next'));const next=fronts.at(-1);
    assert.equal(produce(next,'new-before-old-failure',480),true);await eventually(()=>captured===CALL_PCM_LIMITS.max_samples+960);
    gate.release();await eventually(()=>completed===480&&f.errors.some(error=>String(error).includes('CALL_ARCHIVE_COVERAGE_INCOMPLETE')));
    assert.equal(next.paused,false);assert.equal(f.published.some((p:any)=>p.call_id==='pressure-next'&&p.error_code==='CALL_ARCHIVE_COVERAGE_INCOMPLETE'),false);
    assert.equal(produce(next,'new-after-old-failure',480),true);await eventually(()=>completed===960);
    f.sendText({operation:'call_close',call_id:'pressure-next'});await eventually(()=>f.published.some((p:any)=>p.call_id==='pressure-next'&&p.state==='closed'));
    return;
  }
  gate.release();
  if(rejectAdmission){
    await eventually(()=>f.published.some((p:any)=>p.call_id==='pressure-first'&&p.error_code==='CALL_ARCHIVE_COVERAGE_INCOMPLETE'));
    const before=admitted;assert.equal(produce(first,'after-archive-failure',480),true);
    await eventually(()=>captured===CALL_PCM_LIMITS.max_samples+960);assert.equal(admitted,before,'failed call stops archive projections without retrying each reply');
    assert.equal(first.paused,false);assert.equal(f.published.some((p:any)=>p.call_id==='pressure-first'&&p.state==='closed'),false);
  }else await eventually(()=>completed===CALL_PCM_LIMITS.max_samples+480);
  f.sendText({operation:'call_close',call_id:'pressure-first'});await eventually(()=>f.published.some((p:any)=>p.call_id==='pressure-first'&&p.state==='closed'));
  fail=false;
  f.sendText({operation:'call_open',call_id:'pressure-next'});await eventually(()=>live('pressure-next'));const next=fronts.at(-1);
  assert.notEqual(next,first);assert.equal(next.paused,false,'new call does not inherit a failure latch');
  const expected=completed+480;assert.equal(produce(next,'after-recovery',480),true);await eventually(()=>completed===expected);
  assert.equal(wrongSamples,false);
  if(rejectAdmission)assert.ok(f.errors.some(error=>String(error).includes('CALL_ARCHIVE_COVERAGE_INCOMPLETE')));
  else{assert.equal(admitted,captured);assert.deepEqual(f.errors,[]);}
  f.sendText({operation:'call_close',call_id:'pressure-next'});await eventually(()=>f.published.some((p:any)=>p.call_id==='pressure-next'&&p.state==='closed'));
});

test('reply archive terminal publication failure retains durable bytes and stops only that call projection',async t=>{
  const f=await fixture(t,{voice:true,receiptClock:true}),fronts:any[]=[];let played=0,refused=true;
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:''}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{played+=frame.data.length;});
  t.mock.method(AudioSource.prototype,'waitForPlayout',async()=>{});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'publication-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:(callbacks:any)=>{const front={...callbacks,paused:false};fronts.push(front);
    return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),setOutputPaused:(paused:boolean)=>{front.paused=paused;}};}};
  await f.create({central:{...f.options.central,voice}});const runtime=f.owner.assembly.runtime;
  t.mock.method(runtime,'callContext',async()=> 'owner context');t.mock.method(runtime,'archiveAlert',async()=>{});
  const publish=f.storage.publishAliased.bind(f.storage);
  t.mock.method(f.storage,'publishAliased',async(...args:Parameters<typeof f.storage.publishAliased>)=>{
    if(args[0]==='stream-revisions'&&refused)throw Object.assign(new Error('reply metadata permission refused'),{code:'EACCES'});return publish(...args);
  });
  // Complete the terminal handshake before testing a reply's archive publication failure.
  f.addExisting();
  await f.owner.bridge.onBootstrapConnected!(f.input);
  const snapshot=()=>((f.owner.sharedExecution.terminals.get('phone')!.resourceSnapshot!() as any).call.archive);
  const live=(id:string)=>f.published.some((p:any)=>p.call_id===id&&p.state==='live');
  const produce=(id:string)=>{const front=fronts.at(-1);assert.equal(front.paused,false);
    front.onEvent({type:'response.created',response:{id}});front.onEvent({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(480).fill(71).buffer).toString('base64')});
    front.onEvent({type:'response.done',response:{id,status:'completed'}});};
  f.sendText({operation:'call_open',call_id:'publication-first'});await eventually(()=>live('publication-first'));produce('durable-original');
  await eventually(()=>f.published.some((p:any)=>p.call_id==='publication-first'&&p.error_code==='CALL_ARCHIVE_COVERAGE_INCOMPLETE'));
  assert.equal(snapshot().unaccepted_bytes,0,'failed journal publication does not unaccept its durable original');
  assert.equal(await committedCount(f.storage),0);const [key]=await f.storage.list('raw-ingress');assert.ok(key);
  const pending=JSON.parse(Buffer.from(await f.storage.read('raw-ingress',key)).toString());
  const original=Buffer.from(new Int16Array(480).fill(71).buffer);
  assert.deepEqual(Buffer.from(await f.storage.read('objects',pending.object_hash)),original);
  produce('foreground-after-publication-failure');await eventually(()=>played===960);
  assert.equal(snapshot().unaccepted_bytes,960);assert.deepEqual(await f.storage.list('raw-ingress'),[key]);
  assert.equal(fronts.at(-1).paused,false);assert.equal(f.published.some((p:any)=>p.call_id==='publication-first'&&p.state==='closed'),false);
  f.sendText({operation:'call_close',call_id:'publication-first'});await eventually(()=>f.published.some((p:any)=>p.call_id==='publication-first'&&p.state==='closed'));
  refused=false;f.sendText({operation:'call_open',call_id:'publication-next'});await eventually(()=>live('publication-next'));produce('healthy-next-call');
  await eventually(async()=>await committedCount(f.storage)===1);assert.equal(snapshot().coverage_incomplete,false);assert.equal(snapshot().unaccepted_bytes,0);
  // Journal visibility precedes OriginalAdmission's successful ingress cleanup.
  await eventually(async()=>{const retained=await f.storage.list('raw-ingress');return retained.length===1&&retained[0]===key;});
  assert.deepEqual(await f.storage.list('raw-ingress'),[key]);assert.deepEqual(Buffer.from(await f.storage.read('objects',pending.object_hash)),original);
  f.sendText({operation:'call_close',call_id:'publication-next'});await eventually(()=>f.published.some((p:any)=>p.call_id==='publication-next'&&p.state==='closed'));
});

test('queued formal-owner call media keeps source receipt time and durably archives microphone, actual played reply and exact compressed camera segments on independent tracks',async t=>{
  const f=await fixture(t,{voice:true,camera:true,receiptClock:true,budget:{max_pending_bytes:16384}});
  let receivedAt=f.base;const cameraClock=Promise.withResolvers<void>(),receipt=createReceiptClockProvider({uncertainty_ms:500,now:()=>receivedAt});
  f.pcm.clock={...receipt,resolve:async(binding,chunk)=>{const map=await receipt.resolve(binding,chunk);if(chunk.track_id==='call_camera')cameraClock.resolve();return map;}};
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  const played:Int16Array[]=[];t.mock.method(AudioSource.prototype,'captureFrame',async(frame:{data:Int16Array})=>{played.push(frame.data.slice());});
  // The room and played frames are controlled here; creating a native WebRTC track only probes host devices.
  t.mock.method(LocalAudioTrack,'createAudioTrack',()=>({sid:'archive-track',close:async()=>{}} as unknown as LocalAudioTrack));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'archive-track',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  let emit!:(event:Record<string,unknown>)=>void,video!:ReadableStreamDefaultController<VideoFrameEvent>;
  f.pcm.cameraEncoderFactory=syntheticCameraEncoder(f.base);
  const images:string[]=[],imageReady=Promise.withResolvers<void>();f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;}});
  const voice={...f.options.central.voice!,createFront:(callbacks:{onEvent(event:Record<string,unknown>):void})=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:(jpeg:string)=>{images.push(jpeg);imageReady.resolve();},close:()=>{},context:async()=>{},respond:async()=>({completed:true})};}};
  await f.create({central:{...f.options.central,voice},retainAssembly:true});t.after(()=>f.owner.assembly.close());f.addExisting();
  const room=f.options.participant.roomPort!,peer=room.remoteParticipants!.get('terminal')!;
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{camera:true,sid:'camera-track'}} as never);
  await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:true,video:true}});
  f.feed(waveform());await latest(f);const mic=f.owner.pcmIngress!.snapshot().latest!;
  f.sendText({operation:'call_open',call_id:'archive-call'});await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='live'));
  f.feed(waveform(6));await eventually(()=>f.owner.pcmIngress!.snapshot().latest?.event.event_id!==mic.event.event_id);const inbound=f.owner.pcmIngress!.snapshot().latest!;
  const barrier=latch(),runtime=f.owner.assembly.runtime,admit=runtime.admitMedia.bind(runtime),published=Promise.withResolvers<void>();let blocked=false,committed=0;
  t.mock.method(runtime,'admitMedia',async(...args:Parameters<typeof runtime.admitMedia>)=>{const admitted=await admit(...args);
    void admitted.commit.then(()=>{if(++committed===4)published.resolve();},published.reject);
    if(args[2].track_id!=='assistant_reply')return admitted;blocked=true;
    return {...admitted,commit:admitted.commit.then(async published=>{await barrier.promise;return published;})};});
  emit({type:'response.created',response:{id:'actual'}});
  const reply=new Int16Array(480).fill(2048);emit({type:'response.audio.delta',response_id:'actual',delta:Buffer.from(reply.buffer).toString('base64')});
  await eventually(()=>played.length===1&&blocked);
  const w=64,h=36,pixels=new Uint8Array(w*h*3/2).fill(128);pixels.fill(70,0,w*h);
  for(let frame=0;frame<3;frame++)video.enqueue({frame:new VideoFrame(pixels,w,h,VideoBufferType.I420),rotation:0,timestampUs:BigInt(frame)} as never);
  try{await cameraClock.promise;receivedAt+=5000;}finally{barrier.release();}
  await published.promise;assert.deepEqual(f.errors,[]);assert.equal(await committedCount(f.storage),6);
  // Archive and preview finish independently. Verify the image reached the live call before closing its sink.
  await imageReady.promise;f.sendText({operation:'call_close',call_id:'archive-call'});await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='closed'));await f.owner.bridge.close?.();
  const archive=f.owner.assembly.runtime.existingArchive(),tracks=new Map<string,{event:any;chunk:any;revision:number}>();
  for(const key of await f.storage.list('stream-revisions')){const record=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',key)).toString());if(key!==digest([record.raw_ref,record.revision]))continue;for(const chunk of record.chunks??[record.chunk])if(chunk&&(tracks.get(chunk.track_id)?.revision??0)<record.revision)tracks.set(chunk.track_id,{event:await archive.locate(record.raw_ref,'owner'),chunk,revision:record.revision});}
  assert.deepEqual([...tracks.keys()].sort(),['assistant_reply','call_camera','microphone']);
  assert.equal(new Set([...tracks.values()].map(x=>x.event.raw_ref)).size,3);
  assert.deepEqual(Buffer.from((await archive.readExactChunk(mic.event,mic.chunk,4096)).bytes),pcmBytes(waveform()));
  const out=tracks.get('assistant_reply')!,camera=tracks.get('call_camera')!;
  await assertSessionEnded(f.storage,mic.event.raw_ref,'call_start');
  await assertSessionEnded(f.storage,inbound.event.raw_ref,'call_hangup');
  await assertSessionEnded(f.storage,out.event.raw_ref,'call_hangup');
  assert.equal((await f.storage.list('session-finals')).length,0);
  // This test checks folded content, not the maintenance scheduler's real-time slice under shared I/O.
  const maintenanceClock=t.mock.method(performance,'now',()=>0);
  try{await archive.maintenance(1,Date.now(),{budget_ms:5000});}finally{maintenanceClock.mock.restore();}
  assert.equal((await f.storage.readFinal(mic.event.raw_ref))?.ended_by,'call_start');
  assert.equal((await f.storage.readFinal(inbound.event.raw_ref))?.ended_by,'call_hangup');
  assert.equal((await f.storage.readFinal(out.event.raw_ref))?.ended_by,'call_hangup');
  assert.equal((await f.storage.list('session-finals')).length,3,'ambient prefix, inbound call and reply keep their distinct source axes');
  const grouped=await archive.readCallTracks('archive-call','owner');
  assert.deepEqual(grouped.map(x=>x.track).sort(),['assistant_reply','microphone','pre_call_ambient']);
  assert.ok(grouped.every(x=>x.finalized));
  assert.deepEqual(new Set(grouped.map(x=>x.raw_ref)),new Set([mic.event.raw_ref,inbound.event.raw_ref,out.event.raw_ref]));
  for(const source of grouped)assert.equal((await archive.readRecord(source.raw_ref,'owner',source.event.archive_revision)).event.principal_id,'owner');
  assert.equal(Date.parse(camera.event.captured_at),f.base,'camera source clock is sealed before the blocked writer releases');assert.ok(Date.parse(out.event.captured_at)<receivedAt,'reply time also predates queue release');
  assert.equal(out.chunk.format,'pcm_s16le:24000:1');assert.deepEqual(Buffer.from((await archive.readExactChunk(out.event,out.chunk,4096)).bytes),Buffer.from(reply.buffer));
  const original=Buffer.from((await archive.readExactChunk(camera.event,camera.chunk,4096)).bytes);assert.deepEqual(original,Buffer.from([0,0,0,1,0x65,2]));assert.equal(camera.chunk.seq,2,'all three approved compressed segments survive the adaptive model gate');assert.equal(camera.chunk.format,'h264:1280:720:rotation:0');assert.equal(camera.chunk.mime,'video/h264');assert.equal(images.length,1);assert.equal(Buffer.from(images[0]!,'base64').readUInt16BE(),0xffd8);
  assert.deepEqual(f.errors,[]);
});

test('video-only capture archives compressed segments under its source credential without a microphone reader',async t=>{
  const f=await fixture(t,{camera:true,receiptClock:true});let video!:ReadableStreamDefaultController<VideoFrameEvent>;
  f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;}});f.pcm.cameraEncoderFactory=syntheticCameraEncoder(f.base);
  await f.create();f.addExisting();const peer=f.options.participant.roomPort!.remoteParticipants!.get('terminal')!;
  const published=Promise.withResolvers<void>(),runtime=f.owner.assembly.runtime,admit=runtime.admitMedia.bind(runtime);
  t.mock.method(runtime,'admitMedia',async(...args:Parameters<typeof admit>)=>{
    const admitted=await admit(...args);void admitted.commit.then(()=>published.resolve(),published.reject);return admitted;
  });
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{camera:true,sid:'video-only-track'}} as never);
  f.owner.bridge.assertBootstrapRequest!({requested_media:{data:true,audio:false,video:true},start:{modalities:['data','video']}});
  await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:true}});assert.equal(f.streams,0);
  const pixels=new Uint8Array(64*36*3/2).fill(90);video.enqueue({frame:new VideoFrame(pixels,64,36,VideoBufferType.I420),rotation:1,timestampUs:0n} as never);
  // The producer ACK precedes publication. Join the real archive commit before inspecting its records.
  await published.promise;assert.equal(await committedCount(f.storage),1);
  const rows=await Promise.all((await f.storage.list('stream-revisions')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('stream-revisions',key)).toString())));
  const record=rows.find(row=>row.chunk?.track_id==='call_camera'),archive=f.owner.assembly.runtime.existingArchive();
  const event=await archive.locate(record.raw_ref,'owner');assert.equal(record.chunk.source_video.track_id,'video-only-track');assert.equal(record.chunk.source_video.rotation,90);
  assert.deepEqual(Buffer.from((await archive.readExactChunk(event,record.chunk,4096)).bytes),Buffer.from([0,0,0,1,0x65,0]));
  assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);assert.equal(f.streams,0);assert.deepEqual(f.errors,[]);
});

test('camera producer acknowledges durable segments while public metadata is unavailable and retains them on close',async t=>{
  const f=await fixture(t,{camera:true,receiptClock:true});let video!:ReadableStreamDefaultController<VideoFrameEvent>,failed=true,attempts=0;
  f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;}});f.pcm.cameraEncoderFactory=syntheticCameraEncoder(f.base);
  await f.create({retainAssembly:true});f.addExisting();const peer=f.options.participant.roomPort!.remoteParticipants!.get('terminal')!;
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{camera:true,sid:'ack-only-camera'}} as never);
  const publish=f.storage.publishAliased.bind(f.storage),runtime=f.owner.assembly.runtime,admit=runtime.admitMedia.bind(runtime),keys:string[]=[];
  t.mock.method(f.storage,'publishAliased',async(...args:Parameters<typeof f.storage.publishAliased>)=>{if(args[0]==='stream-revisions'){attempts++;if(failed)throw Object.assign(new Error('metadata IO unavailable'),{code:'EIO'});}return publish(...args);});
  t.mock.method(runtime,'admitMedia',async(...args:Parameters<typeof runtime.admitMedia>)=>{const admitted=await admit(...args);keys.push(admitted.key);return admitted;});
  try{
    await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:true}});
    for(let stamp=0;stamp<2;stamp++)video.enqueue({frame:new VideoFrame(new Uint8Array(64*36*3/2).fill(90),64,36,VideoBufferType.I420),rotation:0,timestampUs:BigInt(stamp)} as never);
    await eventually(()=>keys.length===2&&attempts>0);assert.equal(await committedCount(f.storage),0,'ACK does not assert a published event');
    for(let n=0;n<keys.length;n++){const pending=JSON.parse(Buffer.from(await f.storage.read('raw-ingress',keys[n]!)).toString());assert.deepEqual(Buffer.from(await f.storage.read('objects',pending.object_hash)),Buffer.from([0,0,0,1,0x65,n]));}
    await f.owner.bridge.close!();assert.deepEqual(f.owner.pendingRawKeys().sort(),keys.sort());assert.equal((await f.storage.list('raw-ingress')).length,2);assert.deepEqual(f.errors,[]);
    failed=false;await eventually(async()=>await committedCount(f.storage)===2);
  }finally{failed=false;await f.owner.bridge.close?.();await f.owner.assembly.close();}
});

test('terminal camera publication failure preserves the live reader and fresh capture without losing its original',async t=>{
  const f=await fixture(t,{camera:true,receiptClock:true});let video!:ReadableStreamDefaultController<VideoFrameEvent>,refused=true,streams=0,cancels=0;
  f.pcm.cameraStreamFactory=()=>{streams++;return new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;},cancel:()=>{cancels++;}});};
  f.pcm.cameraEncoderFactory=syntheticCameraEncoder(f.base);
  await f.create({retainAssembly:true});f.addExisting();const peer=f.options.participant.roomPort!.remoteParticipants!.get('terminal')!;
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{sid:'refused-camera'}} as never);
  const publish=f.storage.publishAliased.bind(f.storage);
  t.mock.method(f.storage,'publishAliased',async(...args:Parameters<typeof f.storage.publishAliased>)=>{
    if(args[0]==='stream-revisions'&&refused)throw Object.assign(new Error('metadata permission refused'),{code:'EACCES'});return publish(...args);
  });
  const input={...f.input,enabledMedia:{data:true,audio:false,video:true}};
  const camera=()=>((f.owner.sharedExecution.terminals.get('phone')!.resourceSnapshot!() as any).call.camera);
  const feed=(stamp:number)=>video.enqueue({frame:new VideoFrame(new Uint8Array(64*36*3/2).fill(90),64,36,VideoBufferType.I420),rotation:0,timestampUs:BigInt(stamp)} as never);
  try{
    await f.owner.bridge.onBootstrapConnected!(input);feed(0);await eventually(()=>camera()?.recording_failed===true);
    assert.equal(cancels,0,'metadata failure stops recording rather than camera acquisition');assert.equal(streams,1);
    feed(99);await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(camera()?.recording_failed,true);assert.equal(cancels,0);assert.equal(await committedCount(f.storage),0);
    await f.owner.bridge.onBootstrapConnected!(input);await eventually(()=>streams===2);
    assert.equal(camera()?.recording_failed,false,'fresh capture has a new recording owner');assert.equal(cancels,1);
    assert.equal((await f.storage.list('raw-ingress')).length,1);
    refused=false;f.session.connectionEpoch='2';f.session.binding.connectionEpoch='2';
    await f.owner.bridge.onBootstrapConnected!({...input,currentBinding:{...input.currentBinding,connectionEpoch:'2'}});
    await eventually(()=>streams===3);feed(1);await eventually(async()=>await committedCount(f.storage)===1&&(await f.storage.list('raw-ingress')).length===1);
    const [key]=await f.storage.list('raw-ingress'),pending=JSON.parse(Buffer.from(await f.storage.read('raw-ingress',key!)).toString());
    assert.deepEqual(Buffer.from(await f.storage.read('objects',pending.object_hash)),Buffer.from([0,0,0,1,0x65,0]));
    await f.owner.bridge.close!();
  }finally{await Promise.resolve(f.owner.bridge.close?.()).catch(()=>{});await f.owner.assembly.close();}
});

test('glasses camera abrupt end releases dead-session tail and next HTTP bootstrap and reply work in one process',async t=>{
  const body=JSON.parse(await fs.readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/bootstrap-request.valid.json',import.meta.url),'utf8'));
  const response=JSON.parse(await fs.readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/bootstrap-response.valid.json',import.meta.url),'utf8'));
  const f=await fixture(t,{camera:true,voice:true,continuous:true,receiptClock:true,terminal:{deviceId:body.device_id,deviceType:'glasses',capabilities:['display','speaker','microphone','continuous_audio','camera']}});
  const current=await f.options.readCurrentBinding(),old=structuredClone(current),oldRef=f.session.realtimeSessionRef;
  Object.assign(old.session,{state:'ended',continuityState:'ended'});Object.assign(old.session.binding,{state:'closed'});Object.assign(old.lease,{state:'released'});
  let ended=false,video!:ReadableStreamDefaultController<VideoFrameEvent>,writes=0,discarded=0,played=0;
  const read=f.options.readCurrentBinding;
  const lookup=async(...args:unknown[])=>ended&&(args.at(-1) as {realtimeSessionRef:{ref_id:string}}).realtimeSessionRef.ref_id===oldRef.ref_id?old:read();
  t.mock.method(f.options,'readCurrentBinding',lookup);t.mock.method(f.options,'readCurrentBindingInAdmission',lookup);
  const logs:string[]=[],alerts:string[]=[],pauses:boolean[]=[],fronts:any[]=[];
  t.mock.method(console,'warn',(line:unknown)=>logs.push(String(line)));
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),transcribe:async()=>({text:''}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:any)=>{played+=frame.data.length;});t.mock.method(AudioSource.prototype,'waitForPlayout',async()=>{});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'glasses-rejoin-reply',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:(callbacks:any)=>{fronts.push(callbacks);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),setOutputPaused:(paused:boolean)=>pauses.push(paused)};}};
  f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;}});
  f.pcm.cameraEncoderFactory=(track,archive)=>{
    const encoder=syntheticCameraEncoder(f.base)(track,archive);let pending:{event:VideoFrameEvent;at:number}|undefined;
    return {write:async(event,at)=>{writes++;pending={event,at};},finish:async()=>{if(pending){await encoder.write(pending.event,pending.at);pending=undefined;}},discard:async()=>{discarded++;pending=undefined;}};
  };
  await f.create({central:{...f.options.central,voice}});f.addExisting();const room=f.options.participant.roomPort!,identity=f.input.currentBinding.credentialIdentity;
  assert.ok(typeof identity==='string');
  const track={sid:'glasses-camera'},peer=room.remoteParticipants!.get(identity)!;
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track} as never);
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'controlled rejoin context');
  const alert=f.owner.assembly.runtime.archiveAlert.bind(f.owner.assembly.runtime);
  t.mock.method(f.owner.assembly.runtime,'archiveAlert',async(...args:Parameters<typeof alert>)=>{alerts.push(args[0]);return alert(...args);});
  let input={...f.input,enabledMedia:{data:true,audio:true,video:true}},connectedBinding=input.currentBinding;
  // Session transaction/token ports are controlled; the real HTTP controller and capture/source/archive owners run.
  const controller=new RealtimePublicControlController({enabled:true,controlHost:'127.0.0.1',edge:{authorize:async()=>{}},bearer:{authorize:async()=>input.bearer},
    runtime:{bootstrap:async()=>{f.owner.bridge.assertBootstrapRequest!(body);
      // Initial bootstrap replaces the old participant binding and connects before the capture hook.
      if(connectedBinding.realtimeSessionRef.ref_id!==input.currentBinding.realtimeSessionRef.ref_id){
        await f.options.participant.disconnect();assert.equal(f.room.isConnected,false);connectedBinding=input.currentBinding;
      }
      f.room.isConnected=true;await f.owner.bridge.onBootstrapConnected!(input);return response;},
      resolveE2eeKey:async()=>{throw new Error('UNUSED');},refresh:async()=>{throw new Error('UNUSED');},stop:async()=>{throw new Error('UNUSED');},endContinuity:async()=>{throw new Error('UNUSED');},close:async()=>{}} as never});
  const server=createServer((req,res)=>{void controller.handle(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const bootstrap=()=>fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1/realtime/bootstrap`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer controlled-rejoin-capability'},body:JSON.stringify(body)});
  const frame=(stamp:number)=>video.enqueue({frame:new VideoFrame(new Uint8Array(64*36*3/2),64,36,VideoBufferType.I420),rotation:0,timestampUs:BigInt(stamp)} as never);
  const live=(id:string)=>f.published.some((row:any)=>row.call_id===id&&row.state==='live');
  assert.equal((await bootstrap()).status,200);f.sendText({operation:'call_open',call_id:'glasses-before-drop'});await eventually(()=>live('glasses-before-drop'));
  frame(0);await eventually(()=>writes===1);
  ended=true;f.unsubscribe(track);
  await eventually(()=>logs.some(line=>{const row=JSON.parse(line);return row.call_camera_capture==='released'&&row.reason==='SOURCE_BINDING_INACTIVE';}));
  assert.ok(f.errors.some(error=>error instanceof ContractError&&error.code==='SOURCE_BINDING_INACTIVE'));
  const nextRef={...oldRef,ref_id:'01900000-0000-7000-8000-000000000005'},nextLease={...f.session.activeDeviceLeaseRef,ref_id:'01900000-0000-7000-8000-000000000006'};
  Object.assign(f.session,{realtimeSessionRef:nextRef,activeDeviceLeaseRef:nextLease,connectionEpoch:'2'});
  Object.assign(f.session.binding,{realtimeSessionRef:nextRef,deviceLeaseRef:nextLease,connectionEpoch:'2'});Object.assign(current.lease,{realtimeSessionRef:nextRef,deviceLeaseRef:nextLease});
  input={...input,currentBinding:{...input.currentBinding,realtimeSessionRef:nextRef,deviceLeaseRef:nextLease,connectionEpoch:'2'}};
  const reconnect=await bootstrap();assert.equal(reconnect.status,200,await reconnect.text());
  assert.equal(f.room.isConnected,true,'new initial bootstrap has a connected participant');
  assert.equal(connectedBinding.realtimeSessionRef.ref_id,nextRef.ref_id,'the HTTP owner replaced the old source binding');
  assert.equal(discarded,1);
  assert.ok(f.errors.every(error=>error instanceof ContractError&&['SOURCE_BINDING_INACTIVE','FORMAL_TEXT_CONNECTION_CHANGED'].includes(error.code)),f.errors.map(String).join('\n'));
  assert.equal(logs.filter(line=>JSON.parse(line).call_camera_capture==='released'&&JSON.parse(line).reason==='SOURCE_BINDING_INACTIVE').length,1);
  assert.equal(alerts.filter(reason=>reason==='camera_capture_paused').length,1);assert.equal(callVideoResourcesSnapshot().queued_bytes,0);
  frame(1);await eventually(()=>writes===2);f.unsubscribe(track);await eventually(async()=>await committedCount(f.storage)===1);
  const [revision]=await f.storage.list('stream-revisions'),record=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',revision!)).toString());
  const archive=f.owner.assembly.runtime.existingArchive(),event=await archive.locate(record.raw_ref,'owner');
  assert.deepEqual(Buffer.from((await archive.readExactChunk(event,record.chunk,4096)).bytes),Buffer.from([0,0,0,1,0x65,1]));
  f.sendText({operation:'call_close',call_id:'glasses-before-drop'});await eventually(()=>f.published.some((row:any)=>row.call_id==='glasses-before-drop'&&row.state==='closed'));
  f.sendText({operation:'call_open',call_id:'glasses-after-rejoin'});await eventually(()=>live('glasses-after-rejoin'));
  const front=fronts.at(-1);front.onEvent({type:'response.created',response:{id:'after-dead-tail'}});front.onEvent({type:'response.audio.delta',response_id:'after-dead-tail',delta:Buffer.from(new Int16Array(480).fill(71).buffer).toString('base64')});front.onEvent({type:'response.done',response:{id:'after-dead-tail',status:'completed'}});
  await eventually(()=>played===480);assert.equal(pauses.includes(true),false);assert.equal(logs.some(line=>JSON.parse(line).call_archive_source==='paused'),false);
  f.sendText({operation:'call_close',call_id:'glasses-after-rejoin'});await f.owner.bridge.close!();assert.equal(discarded,1);
});

test('disabled audio bootstrap creates no microphone reader or archive and enabled audio resumes the same source',async t=>{
  const logs:string[]=[];t.mock.method(console,'info',(line:unknown)=>{logs.push(String(line));});
  const f=await fixture(t);await f.create();f.addExisting();
  await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:false}});
  assert.equal(f.streams,0);assert.equal(await committedCount(f.storage),0);assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);
  await f.owner.bridge.onBootstrapConnected!(f.input);assert.equal(f.streams,1);f.feed(waveform());await latest(f);
  assert.equal(await committedCount(f.storage),1);assert.deepEqual(f.errors,[]);
  await f.owner.bridge.close?.();const transitions=logs.map(line=>JSON.parse(line));
  assert.ok(transitions.some(row=>row.reason==='audio_disabled'));assert.ok(transitions.some(row=>row.reason==='audio_enabled'));
  assert.ok(transitions.some(row=>row.formal_pcm_source==='reader_attached'));assert.ok(transitions.some(row=>row.formal_pcm_source==='reader_detached'));
  assert.equal(logs.join('').includes('controlled-principal'),false);assert.equal(logs.join('').includes('controlled-consent'),false);
});

for(const batched of [false,true])test(`received microphone ${batched?'batch':'frame'} survives stop during clock preparation`,async t=>{
  const f=await fixture(t,{budget:{max_samples:32768,max_pending_frames:16,max_pending_bytes:32768,
    ...(batched?{archive_batch:{max_delay_ms:500,max_frames:3,max_bytes:4096}}:{})}}),clock=latch();
  t.after(()=>clock.release());await connect(f);f.holdClock(clock.promise);
  const references:Promise<PcmArchiveSnapshot|undefined>[]=[];
  f.owner.pcmIngress!.tap((_pcm,archive)=>{references.push(archive!);});
  const frames=Array.from({length:9},(_,n)=>waveform(n,512)),started=performance.now();
  for(const frame of frames)f.feed(frame);
  await eventually(()=>f.clockReads===frames.length);await f.owner.pcmIngress!.stop();clock.release();
  await f.owner.pcmIngress!.drain();const saved=await Promise.all(references);
  console.log(JSON.stringify({received_shutdown_tail:batched?'batch':'frame',received:frames.length,
    archive_references:saved.filter(Boolean).length,elapsed_ms:Math.round(performance.now()-started)}));
  assert.equal(saved.filter(Boolean).length,frames.length,'every received frame keeps its archive reference');
  const archive=f.owner.assembly.runtime.existingArchive(),last=saved.at(-1)!;
  const record=await archive.readRecord(last.event.raw_ref,'owner',last.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind==='stream')
    assert.deepEqual(Buffer.concat(record.chunks.map(x=>Buffer.from(x.bytes))),Buffer.concat(frames.map(pcmBytes)));
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.deepEqual(f.errors,[]);
});

for(const batched of [false,true])test(`prepared microphone ${batched?'batch':'frame'} drains all accepted shutdown tail and seals receipt clock before queued IO`,async t=>{
  const f=await fixture(t,{receiptClock:true,budget:{max_samples:320,...(batched?{archive_batch:{max_delay_ms:20,max_frames:2,max_bytes:4096}}:{})}}),entered=latch(),release=latch();
  let publishing=false;let receiptAt=f.base,prepared=0;f.pcm.clock=createReceiptClockProvider({uncertainty_ms:500,now:()=>receiptAt});
  if(batched){const publish=f.storage.publishAliased.bind(f.storage);f.storage.publishAliased=async(...args)=>{if(args[0]==='stream-revisions'){publishing=true;entered.release();await release.promise;}return publish(...args);};}
  else{const publish=f.storage.publish.bind(f.storage);f.storage.publish=async(...args)=>{if(args[0]==='objects'){publishing=true;entered.release();await release.promise;}return publish(...args);};}
  try{await connect(f);const capture=f.owner.clock!.capture.bind(f.owner.clock!);f.owner.clock!.capture=async(...args)=>{const result=await capture(...args);prepared++;return result;};
  const accepted:Int16Array[]=[];f.owner.pcmIngress!.tap(pcm=>{accepted.push(pcm.slice());});
  f.feed(waveform());await eventually(()=>publishing);f.feed(waveform(1));await eventually(()=>accepted.length===2&&prepared===2);
  receiptAt+=5000;await f.owner.pcmIngress!.stop();release.release();await f.owner.pcmIngress!.drain();
  assert.equal(await committedCount(f.storage),2);const last=f.owner.pcmIngress!.snapshot().latest!;
  assert.equal(Date.parse(last.event.captured_at),f.base-20,'new epoch receipt basis cannot inherit queued writer delay');
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(last.event,last.chunk,4096)).bytes),pcmBytes(waveform(1)));assert.deepEqual(f.errors,[]);
  }finally{release.release();}
});

test('microphone tap preserves source order when clock preparation completes out of order',async t=>{
  const f=await fixture(t),gate=latch();t.after(()=>gate.release());await connect(f);
  const resolve=f.pcm.clock!.resolve;let calls=0;f.pcm.clock!.resolve=async(...args)=>{if(++calls===1)await gate.promise;return resolve(...args);};
  const heard:Int16Array[]=[];f.owner.pcmIngress!.tap(pcm=>{heard.push(pcm.slice());});f.feed(waveform());f.feed(waveform(1));
  await eventually(()=>calls===2);assert.deepEqual(heard,[waveform().data,waveform(1).data],'live taps remain in SDK receipt order despite delayed archive clocks');gate.release();await latest(f,1);
  assert.deepEqual(heard,[waveform().data,waveform(1).data]);assert.deepEqual(f.errors,[]);
});

test('formal-owner reply and camera originals with unavailable capture clock remain exact in L5 quarantine without guessed UTC',async t=>{
  const f=await fixture(t,{voice:true,camera:true,receiptClock:true});
  const clock=f.pcm.clock!;f.pcm.clock={...clock,resolve:(binding,chunk)=>chunk.track_id==='microphone'?clock.resolve(binding,chunk):Promise.resolve(undefined)};
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  t.mock.method(AudioSource.prototype,'captureFrame',async()=>{});
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'unknown-clock-output',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  let emit!:(event:Record<string,unknown>)=>void,video!:ReadableStreamDefaultController<VideoFrameEvent>;
  f.pcm.cameraEncoderFactory=syntheticCameraEncoder(f.base);
  f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;}});
  const voice={...f.options.central.voice!,createFront:(callbacks:{onEvent(event:Record<string,unknown>):void})=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true})};}};
  await f.create({central:{...f.options.central,voice}});f.addExisting();
  const peer=f.options.participant.roomPort!.remoteParticipants!.get('terminal')!;peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{camera:true,sid:'camera-track'}} as never);
  const saved:import('../../../services/personal-aios-integration/src/unknown-clock.ts').QuarantinedOriginal[]=[],runtime=f.owner.assembly.runtime,quarantine=runtime.admitQuarantinedMedia.bind(runtime);
  t.mock.method(runtime,'admitQuarantinedMedia',async(...args:Parameters<typeof runtime.admitQuarantinedMedia>)=>{const admitted=await quarantine(...args);void admitted.commit.then(result=>saved.push(result));return admitted;});
  await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:true,video:true}});f.feed(waveform());await latest(f);
  f.sendText({operation:'call_open',call_id:'unknown-clock-call'});await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='live'));
  const reply=new Int16Array(480).fill(2190);emit({type:'response.created',response:{id:'clockless'}});emit({type:'response.audio.delta',response_id:'clockless',delta:Buffer.from(reply.buffer).toString('base64')});
  await eventually(()=>saved.some(row=>row.chunk.track_id==='assistant_reply'));
  const pixels=new Uint8Array(64*36*3/2).fill(93);video.enqueue({frame:new VideoFrame(pixels,64,36,VideoBufferType.I420),rotation:0,timestampUs:0n} as never);
  await eventually(()=>saved.length===2);
  for(const row of saved){assert.equal(row.archive_status,'quarantined');assert.equal(row.event.captured_at,null);assert.equal(row.event.capture_clock_status,'unknown');assert.equal(Object.hasOwn(row.event,'time_range'),false);assert.equal(row.authorization.historical_capture_range,'unverified');
    const bytes=Buffer.from((await runtime.existingArchive().readUnknownClock(row.quarantine_ref,'owner',row.archive_revision)).bytes);
    assert.deepEqual(bytes,row.chunk.track_id==='assistant_reply'?Buffer.from(reply.buffer):Buffer.from([0,0,0,1,0x65,0]));}
  assert.equal(await committedCount(f.storage),1,'only the known-clock microphone is a durable UTC stream');
  const bindings=await runtime.existingArchive().readCallBindings('unknown-clock-call','owner');
  assert.ok(bindings.some(x=>x.track==='assistant_reply'&&!x.finalized),'unverified clock retains its call identity without claiming a UTC final');
  f.sendText({operation:'call_close',call_id:'unknown-clock-call'});await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='closed'));assert.deepEqual(f.errors,[]);
});


test('peer departure retires billed video and same-device rejoin retains the voice call and formal ingress',async t=>{
  const f=await fixture(t,{voice:true,sdk:true}),v=await fakeVidu(t),retired:string[]=[],ready:string[]=[];
  let fronts=0,connects=0,frontCloses=0,contexts=0,phoneTracks=0;
  await f.hostConnect();
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{sendText:async(text:string)=>{ready.push(JSON.parse(text).operation);},
    publishTrack:async()=>({sid:`rejoin-phone-${++phoneTracks}`,waitForSubscription:async()=>{}}),unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>{fronts++;return {connect:async()=>{connects++;},appendAudio:()=>{},appendImage:()=>{},
      close:()=>{frontCloses++;},context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({videoCall:{...v.resources,configuration:{...v.resources.configuration,provider:'vidu_component',component_model:'renderer-model',action_library_id:'gestures'}},central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=>{contexts++;return 'same rejoin conversation';});
  await f.owner.bridge.onBootstrapConnected!(f.input);f.sendText({operation:'call_open',call_id:'same-rejoin-call',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='same-rejoin-call'&&p.state==='live'));f.sendText({operation:'call_avatar',call_id:'same-rejoin-call',avatar_revision:1,avatar:true});
  await eventually(()=>f.published.some((p:any)=>p.state==='live')&&f.published.some((p:any)=>p.media));
  assert.ok(f.published.some((p:any)=>p.operation==='call_avatar_state'&&p.avatar===true&&p.avatar_revision===1&&p.media),'the paid avatar is explicitly enabled before peer loss');
  assert.equal(v.creates.length,1);assert.ok((f.owner.bridge.centralTextTransport!.callRejoinWindowS??0)>0);f.remoteDisconnect();
  const retained=f.owner.bridge.callRejoinForDevice?.('phone');assert.equal(retained?.call_id,'same-rejoin-call');
  assert.ok(Date.parse(retained!.rejoin_deadline)>Date.now());
  await eventually(()=>v.billing.length===1);assert.equal(v.controls.filter(p=>p.type===5).length,1);
  assert.equal(frontCloses,0);assert.deepEqual(retired,[]);
  const before=f.published.length;f.addExisting();await eventually(()=>ready.length===2&&f.published.slice(before).some((p:any)=>p.call_id==='same-rejoin-call'&&p.state==='live'&&p.avatar===false));
  await eventually(()=>f.owner.bridge.callRejoinForDevice?.('phone')===undefined);
  assert.ok(f.published.slice(before).some((p:any)=>p.operation==='call_avatar_state'&&p.avatar===false&&p.avatar_revision===1),'rejoin replays OFF without changing the owner revision');
  assert.equal(v.creates.length,1,'rejoin never reacquires a paid avatar');
  assert.ok(f.published.slice(before).some((p:any)=>p.operation==='call_state'&&p.video===false),'owner camera follows the existing loss rule independently');
  assert.equal((f.published.filter((p:any)=>p.operation==='call_state').at(-1) as any).rejoin_deadline,undefined,'Successful rejoin closes its window without a healthy-call timer');
  f.sendText({operation:'call_video',call_id:'same-rejoin-call',video_revision:1,video:false});
  await eventually(()=>f.published.some((p:any)=>p.video_revision===1&&p.video===false));
  assert.deepEqual([fronts,connects,contexts,frontCloses],[1,1,1,0]);assert.deepEqual(retired,[]);
  assert.equal(f.published.some((p:any)=>p.state==='closed'||p.state==='failed'),false);
  f.disconnect();await f.hostConnect();await f.owner.bridge.onBootstrapConnected!(f.input);
  await eventually(()=>phoneTracks===2);assert.deepEqual([fronts,connects,contexts,frontCloses],[1,1,1,0]);
  assert.equal(f.published.filter((p:any)=>p.operation==='call_state'&&p.state==='opening').length,1,'SDK gateway reacquisition preserves the logical call even when it reuses the Room object');
});

test('peer absence expires at the announced server deadline and terminal state replays after source reattachment',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const f=await fixture(t,{voice:true}),retired:string[]=[];let frontCloses=0;
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'expiring-phone',waitForSubscription:async()=>{}}),unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>{return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{frontCloses++;},context:async()=>{},
      respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({now:()=>Date.now(),callRejoinWindowS:2,central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'same expiring conversation');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'expired-rejoin-call',video_revision:0});
  await eventually(()=>f.published.some((p:any)=>p.state==='live'));
  f.remoteDisconnect();const retained=f.owner.bridge.callRejoinForDevice?.('phone');assert.equal(retained?.call_id,'expired-rejoin-call');
  const deadline=Date.parse(retained!.rejoin_deadline);
  await new Promise(setImmediate);assert.deepEqual([frontCloses,retired.length],[0,0]);
  t.mock.timers.tick(deadline-Date.now()-1);f.disconnect();
  assert.equal(f.owner.bridge.callRejoinForDevice?.('phone')?.rejoin_deadline,retained!.rejoin_deadline);
  assert.equal(frontCloses,0,'duplicate loss never extends or shortens the issued budget');
  t.mock.timers.tick(1);await eventually(()=>frontCloses===1&&retired.length===1);
  await f.owner.bridge.onBootstrapConnected!(f.input);const before=f.published.length;f.addExisting();
  await eventually(()=>f.published.slice(before).some((p:any)=>p.operation==='call_state'&&p.call_id==='expired-rejoin-call'&&p.state==='closed'&&p.reason==='network'));
  assert.equal(f.published.filter((p:any)=>p.operation==='call_state'&&p.state==='opening').length,1,'expired rejoin never opens a second call');
});


test('repeated peer loss during held real phone rebind expires at the original announced deadline',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const f=await fixture(t,{voice:true,sdk:true});
  let frontCloses=0,tracks=0,hold=false;const gate=Promise.withResolvers<void>();let attach:Promise<void>|undefined;
  await f.hostConnect();
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>{const track=++tracks;if(hold)await gate.promise;
    return {sid:`held-rebind-phone-${track}`,waitForSubscription:async()=>{}};},unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{frontCloses++;},
    context:async()=>{},respond:async()=>({completed:true})})};
  await f.create({callRejoinWindowS:2,now:()=>Date.now(),central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'held rebind conversation');await f.owner.bridge.onBootstrapConnected!(f.input);
  f.sendText({operation:'call_open',call_id:'held-rebind-call'});await eventually(()=>f.published.some((p:any)=>p.state==='live'));
  const baseline=frontCloses;f.remoteDisconnect();
  const retained=f.owner.bridge.callRejoinForDevice?.('phone');assert.equal(retained?.call_id,'held-rebind-call');
  const deadline=Date.parse(retained!.rejoin_deadline);f.disconnect();hold=true;await f.hostConnect();
  try{
    attach=Promise.resolve(f.owner.bridge.onBootstrapConnected!(f.input));void attach.catch(()=>{});await eventually(()=>tracks===2);
    f.remoteDisconnect();assert.equal(f.owner.bridge.callRejoinForDevice?.('phone')?.rejoin_deadline,retained!.rejoin_deadline);
    gate.resolve();await new Promise(setImmediate);await new Promise(setImmediate);
    assert.equal(f.owner.bridge.callRejoinForDevice?.('phone')?.rejoin_deadline,retained!.rejoin_deadline,'Stale rebind cannot renew the absent peer lease');
    assert.equal(frontCloses,baseline);t.mock.timers.tick(deadline-Date.now()-1);await new Promise(setImmediate);assert.equal(frontCloses,baseline);
    t.mock.timers.tick(1);await eventually(()=>frontCloses===baseline+1);
    f.addExisting();await attach;await eventually(()=>f.published.some((p:any)=>p.call_id==='held-rebind-call'&&p.state==='closed'&&p.reason==='network'));
    const states=f.published.filter((p:any)=>p.operation==='call_state'&&p.call_id==='held-rebind-call') as any[];
    assert.ok(states.every(state=>state.rejoin_deadline===undefined||Date.parse(state.rejoin_deadline)<=deadline),'Stale rebind cannot announce a renewed lease after the second loss');
    assert.equal(states.filter(state=>state.state==='opening').length,1);
  }finally{hold=false;gate.resolve();f.addExisting();await attach?.catch(()=>{});}
});

test('owner shutdown verifies active component billing and fresh same-storage owner never reopens the call',async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t),retired:string[]=[];let frontCloses=0;
  const path=join(f.storage.root,'vidu-live-sessions.json'),journal=createViduLiveJournal(path);
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'restart-billing-phone',waitForSubscription:async()=>{}}),
    unpublishTrack:async(sid:string)=>{retired.push(sid);}});
  const voice={...f.options.central.voice!,frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{frontCloses++;},
      context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
  const videoCall={...v.resources,journal,configuration:{...v.resources.configuration,provider:'vidu_component' as const,component_model:'renderer-model',action_library_id:'gestures'}};
  await f.create({videoCall,central:{...f.options.central,voice}});t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'restart billing conversation');
  await f.owner.bridge.onBootstrapConnected!(f.input);f.sendText({operation:'call_open',call_id:'restart-billing-call',video_revision:0,video:true});await eventually(()=>f.published.some((p:any)=>p.call_id==='restart-billing-call'&&p.state==='live'));f.sendText({operation:'call_avatar',call_id:'restart-billing-call',avatar_revision:1,avatar:true});
  await eventually(()=>f.published.some((p:any)=>p.media?.audio_input==='gateway'));assert.equal(journal.size,1);assert.equal(v.creates.length,1);
  const beforeClose=frontCloses;await f.owner.bridge.close!();
  assert.equal(frontCloses,beforeClose+1);assert.deepEqual(retired,['restart-billing-phone']);assert.equal(v.controls.filter(p=>p.type===5).length,1);
  assert.equal(v.billing.length,1);assert.equal(journal.size,0);assert.deepEqual(JSON.parse(await fs.readFile(path,'utf8')),[]);
  const beforeRestart=f.published.length,restartedJournal=createViduLiveJournal(path);assert.equal(restartedJournal.size,0);
  await f.create({videoCall:{...videoCall,journal:restartedJournal},central:{...f.options.central,voice}});
  await f.owner.bridge.onBootstrapConnected!(f.input);f.addExisting();await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(v.creates.length,1,'Restart never recreates the retired paid renderer');assert.equal(v.billing.length,1);
  assert.equal(f.published.slice(beforeRestart).some((p:any)=>p.operation==='call_state'&&['opening','connecting','live'].includes(p.state)),false);
  assert.equal(f.published.filter((p:any)=>p.operation==='call_state'&&p.state==='opening').length,1,'Fresh owner opens no second call');
});

test('a close for a call this gateway no longer has answers closed to the requester only',async t=>{
  const f=await fixture(t,{voice:true,sdk:true});
  await f.hostConnect();
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  await f.create({});
  await f.owner.bridge.onBootstrapConnected!(f.input);
  // A retained offline hang-up from before a gateway restart (or a call already retired by expiry).
  const before=f.published.length;
  f.sendText({operation:'call_close',call_id:'forgotten-call',reason:'button'});
  await eventually(()=>f.published.slice(before).some((p:any)=>p.operation==='call_state'&&p.call_id==='forgotten-call'&&p.state==='closed'&&p.reason==='button'));
  const states=f.published.slice(before).filter((p:any)=>p.operation==='call_state');
  assert.deepEqual(states.map((p:any)=>[p.call_id,p.state]),[['forgotten-call','closed']],'Only the terminal answer; nothing opens');
  assert.deepEqual(f.errors,[]);
});

test('offline owner hangup replay after rejoin closes the original front once before resumed PCM',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const f=await fixture(t,{voice:true,sdk:true});let frontCloses=0,audio=0;
  await f.hostConnect();
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.options.participant.roomPort!.localParticipant!,{publishTrack:async()=>({sid:'offline-close-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,createFront:()=>({connect:async()=>{},appendAudio:()=>{audio++;},appendImage:()=>{},close:()=>{frontCloses++;},context:async()=>{},respond:async()=>({completed:true})})};
  await f.create({callRejoinWindowS:2,now:()=>Date.now(),central:{...f.options.central,voice}});
  t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'offline close context');
  await f.owner.bridge.onBootstrapConnected!(f.input);f.sendText({operation:'call_open',call_id:'offline-close-call'});
  await eventually(()=>f.published.some((p:any)=>p.operation==='call_state'&&p.state==='live'));
  const baseline=frontCloses;f.remoteDisconnect();assert.ok(f.owner.bridge.callRejoinForDevice?.('phone'));
  t.mock.timers.tick(500);const before=f.published.length;f.addExisting();
  await eventually(()=>f.published.slice(before).some((p:any)=>p.operation==='call_state'&&p.state==='live')&&f.owner.bridge.callRejoinForDevice?.('phone')===undefined);
  assert.equal(f.owner.bridge.callRejoinForDevice?.('phone'),undefined);
  // The client retains this original binding/id/reason through both offline hang-up taps.
  const close={operation:'call_close',call_id:'offline-close-call',reason:'button'};
  f.sendText(close);
  await eventually(()=>frontCloses===baseline+1&&f.published.some((p:any)=>p.operation==='call_state'&&p.state==='closed'&&p.reason==='button'));
  f.sendText(close);t.mock.timers.tick(10000);await new Promise(setImmediate);
  assert.equal(frontCloses,baseline+1,'Repeated close delivery is idempotent for the original front');
  const after=audio;f.feed(waveform());await new Promise(resolve=>ioTimeout(resolve,20));
  assert.equal(audio,after,'Resumed capture cannot append to the closed call');
  assert.equal(f.published.filter((p:any)=>p.operation==='call_state'&&p.state==='opening').length,1);
});

test('slow asynchronous PCM tap cannot consume durable capture capacity',async t=>{
  const f=await fixture(t,{budget:{max_pending_frames:2,max_pending_bytes:2048}}),gate=latch();
  try {
  await connect(f);f.owner.pcmIngress!.tap(()=>gate.promise);
  for(let n=0;n<6;n++){f.feed(waveform(n));await latest(f,n);}
  assert.equal(f.cancels,0);assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
  assert.ok(f.owner.pcmIngress!.snapshot().tap_pending_bytes<=2048);
  assert.equal(f.owner.pcmIngress!.snapshot().tap_pending_frames,2);
  assert.equal(f.owner.pcmIngress!.snapshot().tap_dropped_frames,4);
  } finally {gate.release();}
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();
  assert.equal(f.owner.pcmIngress!.snapshot().tap_pending_bytes,0);
});
for(const batched of [false,true])test(`durable PCM ${batched?'batch':'frame'} admission bounds blocked processing without losing originals`,async t=>{
  const f=await fixture(t,{continuous:true,interval:batched,budget:{max_samples:32768,max_pending_frames:2,...(batched?{archive_batch:{max_frames:2,max_bytes:4096,max_delay_ms:10}}:{})}}),gate=latch();t.after(()=>gate.release());
  await connect(f);
  const runtime=f.owner.assembly.runtime as any,method=batched?'consumeArchivedInterval':'consumeArchived',consume=runtime[method].bind(runtime);
  runtime[method]=async(...args:any[])=>{await gate.promise;return consume(...args);};
  for(let n=0;n<8;n++){
    f.feed(waveform(n));await eventually(()=>f.raws.length===n+1&&f.owner.pcmIngress!.snapshot().pending_frames===0);
    await eventually(async()=>await committedCount(f.storage)===n+1);
  }
  assert.equal(f.cancels,0);assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  assert.equal(f.owner.pcmIngress!.snapshot().processing_pending_frames,2);
  assert.equal(f.owner.pcmIngress!.snapshot().processing_skipped_frames,6);
  await latest(f,7);assert.equal(f.owner.pcmIngress!.snapshot().latest!.processing_admission?.status,'failed');
  const errorsBefore=f.errors.length;gate.release();await eventually(()=>f.owner.pcmIngress!.snapshot().processing_pending_frames===0);
  assert.equal(f.owner.pcmIngress!.snapshot().latest!.chunk.seq,7,'late ordered consumer cannot regress archive head');
  assert.equal(f.errors.length,errorsBefore,'old queued frames cannot report recovery beyond the newer rejected frame');
  f.feed(waveform(8));const recovered=await latest(f,8);
  assert.equal(recovered.processing_admission?.status,'queued');assert.ok(recovered.processing_receipt_ref);
  const epochs=await Promise.all((await f.storage.list('media-detection-epochs')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('media-detection-epochs',key)).toString())));
  assert.equal(epochs.length,2);assert.ok(epochs.some(epoch=>epoch.seq===8&&epoch.reset_reason==='explicit_gap_or_restart'));
  assert.equal(f.errors.length,errorsBefore+1);
  assert.equal((f.errors.at(-1) as {continuous_pcm_admission:string}).continuous_pcm_admission,'recovered');
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();
  assert.equal(await committedCount(f.storage),9);
});

// Explicit release replay: real encoder + source owners + durable ingress/journal/readback, no RTC network or model.
// ARCHIVE_COVERAGE_REPLAY=1 node --test --test-name-pattern='Archive coverage replay' tests/formal-pcm-source.test.ts
for(const [label,samples,frames] of [['speech',222546,1580],['quiet-camera',0,961]] as const)
test(`Archive coverage replay ${label}`,{skip:process.env.ARCHIVE_COVERAGE_REPLAY!=='1'},async t=>{
  const f=await fixture(t,{camera:true,receiptClock:true,budget:{max_frame_samples:1600,max_pending_frames:64,
    max_pending_bytes:64*1024*1024,max_samples:9600000,archive_batch:{max_delay_ms:500,max_frames:20,max_bytes:65536}}});
  const config=f.pcm.configuration as MediaReplayConfiguration;
  config.stream_budget={max_chunk_bytes:2*1024*1024,max_total_bytes:64*1024*1024,max_chunks:4096,max_revisions:4096,max_seq:65536};
  let video!:ReadableStreamDefaultController<VideoFrameEvent>,videoCancelled=false;
  f.pcm.cameraEncoderFactory=(track,archive)=>createCallVideoEncoder(track,archive);
  f.pcm.cameraStreamFactory=()=>new ReadableStream<VideoFrameEvent>({start:controller=>{video=controller;},cancel:()=>{videoCancelled=true;}});
  await f.create({central:{...f.options.central,max_event_bytes:2*1024*1024,max_read_bytes:64*1024*1024}});
  const pressure=process.env.ARCHIVE_COVERAGE_PRESSURE==='1';
  if(pressure){const runtime=f.owner.assembly.runtime,append=runtime.appendMediaBatch.bind(runtime);let first=true;
    t.mock.method(runtime,'appendMediaBatch',async(...args:Parameters<typeof append>)=>{
      const result=await append(...args);if(first){first=false;await new Promise(resolve=>setTimeout(resolve,8000));}return result;
    });}
  f.addExisting();const peer=f.options.participant.roomPort!.remoteParticipants!.get('terminal')!;
  peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{sid:`replay-${label}`}} as never);
  await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:true,video:true}});
  let sourcePcm=Int16Array.from({length:samples},(_,n)=>(n*17)%30000-15000);
  const speechFile=process.env.ARCHIVE_COVERAGE_PCM_FILE;
  if(samples&&speechFile){const wav=await fs.readFile(speechFile),audio=inspectWav(wav),speech=wavSamples(wav);
    assert.equal(audio.sample_rate,16000);assert.equal(audio.channels,1);sourcePcm=new Int16Array(2*(speech.length+16000));
    sourcePcm.set(speech);sourcePcm.set(speech,speech.length+16000);assert.equal(sourcePcm.length,samples);
  }
  const before=callVideoResourcesSnapshot();
  const began=performance.now();let offset=0;
  for(let n=0;n<frames;n++){
    const due=began+(pressure&&n>=300&&n<340?300:n)*1000/30;
    if(due>performance.now())await new Promise(resolve=>setTimeout(resolve,due-performance.now()));
    const audioBlock=n>=150&&n<360&&(n-150)%3===0?1:n>=450&&n<660&&(n-450)%3===0?2:0;
    if(audioBlock&&offset<samples){const data=sourcePcm.slice(offset,Math.min(offset+1600,audioBlock*samples/2));offset+=data.length;
      if(!f.cancels)f.feed({data,sampleRate:16000,channels:1,samplesPerChannel:data.length});}
    const pixels=new Uint8Array(1280*720*3/2).fill(128);pixels[0]=n%256;
    if(!videoCancelled)video.enqueue({frame:new VideoFrame(pixels,1280,720,VideoBufferType.I420),rotation:0,timestampUs:BigInt(n)*1000000n/30n} as never);
  }
  assert.equal(offset,samples);if(!f.cancels)f.end();if(!videoCancelled)video.close();await f.owner.pcmIngress!.drain();
  const deadline=Date.now()+30000;
  while(callVideoResourcesSnapshot().readers||callVideoResourcesSnapshot().encoders||(await f.storage.list('raw-ingress')).length){
    assert(Date.now()<deadline,'archive source drain exceeded 30 seconds');await new Promise(resolve=>setTimeout(resolve,20));
  }
  await f.owner.bridge.close!();
  const heads=new Map<string,any>();
  for(const key of await f.storage.list('stream-revisions')){
    const row=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',key)).toString());
    if((heads.get(row.raw_ref)?.revision??0)<row.revision)heads.set(row.raw_ref,row);
  }
  const audio:Buffer[]=[],videoBytes:Buffer[]=[];let archivedFrames=0;
  const archive=f.owner.assembly.runtime.existingArchive();
  for(const row of heads.values()){
    const event=await archive.locate(row.raw_ref,'owner');
    const record=await archive.readRecord(event.raw_ref,'owner',event.archive_revision);assert.equal(record.kind,'stream');
    if(record.kind!=='stream')continue;
    for(const {chunk,bytes} of record.chunks){
      if(chunk.track_id==='microphone')audio.push(Buffer.from(bytes));
      if(chunk.track_id==='call_camera'){archivedFrames+=chunk.source_video!.frame_count;videoBytes.push(Buffer.from(bytes));}
    }
  }
  let decoded=0;const {spawn}=await import('node:child_process');
  for(const bytes of videoBytes){
    const child=spawn('ffprobe',['-v','error','-f','h264','-count_frames','-show_entries','stream=nb_read_frames','-of','json','pipe:0']);
    let output='',error='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;});
    const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(error)));});
    child.stdin.end(bytes);await done;decoded+=Number(JSON.parse(output).streams[0].nb_read_frames);
  }
  const after=callVideoResourcesSnapshot();
  console.log(JSON.stringify({archive_replay:label,pressure,audio_input:speechFile?'Phase E speech.wav twice plus 16000 silence samples each':'deterministic sample-count fixture',sent_samples:samples,archived_samples:Buffer.concat(audio).length/2,
    sent_frames:frames,archived_frames:archivedFrames,decoded_frames:decoded,video_dropped:after.dropped_frames===undefined?'unobserved':after.dropped_frames-before.dropped_frames,
    pcm:f.owner.pcmIngress!.snapshot(),video:after,resource:process.resourceUsage(),errors:f.errors.map(String)}));
  assert.equal(Buffer.concat(audio).length,samples*2);assert(Buffer.concat(audio).equals(Buffer.from(sourcePcm.buffer)));
  assert.equal(archivedFrames,frames);assert.equal(decoded,frames);
  if(after.dropped_frames!==undefined)assert.equal(after.dropped_frames-before.dropped_frames,0);
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,0);
  assert(f.errors.every(error=>pressure&&String(error).includes('FORMAL_PCM_PROCESSING_BACKLOG')));
});


test('buffered PCM before a capture gap stays in the old detector epoch',async t=>{
  const f=await fixture(t,{continuous:true,interval:true,budget:{max_samples:32768,max_pending_frames:2,max_pending_bytes:2048,
    archive_batch:{max_frames:2,max_bytes:2048,max_delay_ms:100}}});await connect(f);
  f.feed(waveform());await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===1);
  f.feed(waveform(1,1024));await eventually(()=>f.owner.pcmIngress!.snapshot().dropped_frames===1);
  await latest(f,0);f.feed(waveform(2));const recovered=await latest(f,1);
  assert.equal(recovered.processing_admission?.status,'queued');assert.ok(recovered.processing_receipt_ref);
  const epochs=await Promise.all((await f.storage.list('media-detection-epochs')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('media-detection-epochs',key)).toString())));
  assert.equal(epochs.length,2);assert.ok(epochs.some(epoch=>epoch.seq===0&&epoch.reset_reason==='source_start'));
  assert.ok(epochs.some(epoch=>epoch.seq===1&&epoch.origin_sample===1344&&epoch.reset_reason==='explicit_gap_or_restart'));
  assert.equal(f.owner.pcmIngress!.snapshot().dropped_samples,1024);assert.equal(f.errors.length,1);
});

test('formal ready is published only after microphone and camera capture consumers are armed',async t=>{
 const f=await fixture(t,{camera:true,receiptClock:true});let cameraStreams=0;
 f.pcm.cameraStreamFactory=()=>{cameraStreams++;return new ReadableStream<VideoFrameEvent>({start:()=>{}});};
 await f.create();f.addExisting();const room=f.options.participant.roomPort!,peer=room.remoteParticipants!.get('terminal')!;
 peer.trackPublications.set('camera',{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,track:{sid:'ready-camera'}} as never);
 const local=room.localParticipant! as any,publish=local.sendText.bind(local),observed:{microphone:number;camera:number}[]=[];
 t.mock.method(local,'sendText',async(text:string,...args:unknown[])=>{
  if(JSON.parse(text).operation==='ready')observed.push({microphone:f.streams,camera:cameraStreams});
  return publish(text,...args);
 });
 await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:true,video:true}});
 assert.deepEqual(observed,[{microphone:1,camera:1}]);
});


test('PCM refresh joins durable ingress without joining the old capture model completion',{timeout:5000},async t=>{
  const f=await fixture(t,{continuous:true}),gate=latch();await connect(f);f.holdModel(gate.promise);
  f.feed(continuousMarker(1024,true));await latest(f,0);f.feed(continuousMarker(512,false));const archived=await latest(f,1);
  await eventually(()=>f.requests.length===1);
  try {
    await f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:false}});
    assert.equal(f.streams,1);assert.equal(f.nativeInputs.length,0);
    assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
    assert.ok(archived.event.raw_ref);
  }finally{gate.release();await f.owner.assembly.runtime.continuousMedia().drain();}
  assert.deepEqual(f.errors,[]);
});

test('same-binding PCM refresh reuses the reader without waiting for its pending durable ingress',async t=>{
  const f=await fixture(t),gate=latch();let entered=false,ready=false,refresh:Promise<void>|undefined;
  const publish=f.storage.publishIngress.bind(f.storage);
  t.mock.method(f.storage,'publishIngress',async(...args:Parameters<typeof publish>)=>{entered=true;await gate.promise;return publish(...args);});
  try{
    await connect(f);f.feed(waveform(7));await eventually(()=>entered);
    refresh=Promise.resolve(f.owner.bridge.onBootstrapConnected!({...f.input})).then(()=>{ready=true;});await eventually(()=>ready);
    assert.equal(f.streams,1);assert.equal(f.cancels,0);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,1);
  }finally{gate.release();await refresh;}
  const archived=await latest(f);assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(archived.event,archived.chunk,4096)).bytes),pcmBytes(waveform(7)));
});

test('repeated binding reconnects retain one terminal admission and preserve original archive replay',async t=>{
  const f=await fixture(t);await connect(f);f.feed(waveform(1));const original=await latest(f);
  const oldSource=await f.owner.pcmIngress!.source();
  for(let epoch=2;epoch<=12;epoch++){
    f.session.connectionEpoch=String(epoch);f.session.binding.connectionEpoch=String(epoch);
    await f.owner.bridge.onBootstrapConnected!({...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:String(epoch)}});
    assert.equal(f.owner.sharedExecution.admissions.size,1,'replaced routes must release their admission owner');
    const currentAdmission=[...f.owner.sharedExecution.admissions.values()][0]!;
    await assert.rejects(currentAdmission.withAppendAdmission!(f.raws[0]!,{...oldSource,submission:'observation'},original.chunk,
      async()=>assert.fail('stale route must not append through the current terminal')),/MEDIA_CAPTURE_CONTEXT_MISMATCH/);
    f.feed(waveform(epoch));const current=await latest(f);
    assert.notEqual(current.chunk.stream_epoch,original.chunk.stream_epoch);
    assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(current.event,current.chunk,4096)).bytes),pcmBytes(waveform(epoch)));
  }
  assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(original.event,original.chunk,4096)).bytes),pcmBytes(waveform(1)));
  assert.deepEqual(f.errors,[]);
  await f.owner.bridge.close!();assert.equal(f.owner.sharedExecution.admissions.size,0);
});

test('replaced admission cannot tear down a new route while old durable admission is blocked',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);f.holdClock(gate.promise);
  f.feed(waveform(1));await eventually(()=>f.clockReads===1);
  f.session.connectionEpoch='2';f.session.binding.connectionEpoch='2';
  const refreshing=f.owner.bridge.onBootstrapConnected!({...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:'2'}});
  try{
    await eventually(()=>f.cancels===1);gate.release();f.holdClock();await refreshing;
    assert.equal(f.owner.sharedExecution.admissions.size,1);assert.equal(f.disconnects,0);
    assert.ok(f.errors.some(error=>String(error).includes('SOURCE_OWNER_BINDING_DENIED')),'the original authority rejects the superseded epoch');
    f.feed(waveform(2));const fresh=await latest(f);
    assert.deepEqual(Buffer.from((await f.owner.assembly.runtime.existingArchive().readExactChunk(fresh.event,fresh.chunk,4096)).bytes),pcmBytes(waveform(2)));
    assert.equal(f.owner.pcmIngress!.snapshot().error,undefined);
  }finally{gate.release();f.holdClock();await refreshing;}
});

test('reconnect releases the old admission while durable originals wait for publication',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);let entered=false;
  const publish=f.storage.publishAliased.bind(f.storage);
  t.mock.method(f.storage,'publishAliased',async(...args:Parameters<typeof publish>)=>{
    if(args[0]==='stream-revisions'&&!entered){entered=true;await gate.promise;}return publish(...args);
  });
  f.feed(waveform(1));await eventually(()=>entered);
  let refreshing:Promise<void>|undefined;
  try{
    await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===0);
    f.session.connectionEpoch='2';f.session.binding.connectionEpoch='2';
    refreshing=Promise.resolve(f.owner.bridge.onBootstrapConnected!({...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:'2'}}));
    await eventually(()=>f.cancels===1);
    assert.equal(f.owner.sharedExecution.admissions.size,1);
  }finally{gate.release();await refreshing;}
  assert.equal(f.streams,2);
  await eventually(async()=>await committedCount(f.storage)===1);
  const archive=f.owner.assembly.runtime.existingArchive(),raw=f.raws[0]!;
  const original=await archive.locate(`l5:${digest({event_id:raw.event_id,principal_id:'owner',device_id:raw.device_id})}`,'owner');
  const record=await archive.readRecord(original.raw_ref,'owner',original.archive_revision);assert.equal(record.kind,'stream');
  if(record.kind==='stream')assert.deepEqual(Buffer.concat(record.chunks.map(chunk=>Buffer.from(chunk.bytes))),pcmBytes(waveform(1)));
  f.feed(waveform(2));await latest(f);assert.deepEqual(f.errors,[]);
});

for(const rejected of [false,true])test(`PCM readiness joins durable ingress before ${rejected?'rejected':'delayed'} native cancellation`,async t=>{
  const cancel=Promise.withResolvers<void>(),durable=latch(),f=await fixture(t,{cancelWait:cancel.promise});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  let entered=false,refreshed=false,closed=false;
  const publish=f.storage.publishIngress.bind(f.storage);
  t.mock.method(f.storage,'publishIngress',async(...args:Parameters<typeof publish>)=>{entered=true;await durable.promise;return publish(...args);});
  try{
    await connect(f);f.feed();await eventually(()=>entered);
    const refresh=Promise.resolve(f.owner.bridge.onBootstrapConnected!({...f.input,enabledMedia:{data:true,audio:false,video:false}})).then(()=>{refreshed=true;});
    await eventually(()=>f.cancels===1);await tick();assert.equal(refreshed,false,'durable input remains a readiness prerequisite');
    durable.release();await eventually(()=>refreshed);await refresh;assert.equal(f.cancelSettled,false);
    const close=Promise.resolve(f.owner.bridge.close!()).finally(()=>{closed=true;});
    const observed=rejected?assert.rejects(close,(error:AggregateError)=>error.errors.some(failure=>failure.message==='FORMAL_PCM_SOURCE_STOP_FAILED')):close;
    await tick();assert.equal(closed,false,'close owns the native cancellation obligation');
    if(rejected)cancel.reject(new TypeError('native cancellation refused'));else cancel.resolve();
    await observed;assert.equal(await committedCount(f.storage),1);
  }finally{durable.release();cancel.resolve();}
});


test('a late old PCM publication cannot overwrite a new binding capture',{timeout:5000},async t=>{
  const f=await fixture(t),gate=latch();await connect(f);
  const append=f.owner.assembly.runtime.appendMedia.bind(f.owner.assembly.runtime);
  let first=true,entered=false,returned=false;
  f.owner.assembly.runtime.appendMedia=async(...args)=>{
    const hold=first;first=false;const result=await append(...args);
    if(hold){entered=true;await gate.promise;returned=true;}return result;
  };
  f.feed(waveform(1));await eventually(()=>entered);
  f.session.connectionEpoch='2';f.session.binding.connectionEpoch='2';
  const input={...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:'2'}};
  try {
    await f.owner.bridge.onBootstrapConnected!(input);f.feed(waveform(2));const fresh=await latest(f,0);
    gate.release();await eventually(()=>returned);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.owner.pcmIngress!.snapshot().latest!.event.raw_ref,fresh.event.raw_ref);
    f.feed(waveform(3));const next=await latest(f,1);assert.equal(next.chunk.stream_epoch,fresh.chunk.stream_epoch);
    assert.equal(f.streams,2);assert.deepEqual(f.errors,[]);
  }finally{gate.release();}
});

test('old PCM rejection during the durable refresh fence cannot cancel fresh source readiness',async t=>{
  const f=await fixture(t),gate=latch();await connect(f);let first=true,entered=false;
  const append=f.owner.assembly.runtime.appendMedia.bind(f.owner.assembly.runtime);
  t.mock.method(f.owner.assembly.runtime,'appendMedia',async(...args:Parameters<typeof append>)=>{
    if(first){first=false;entered=true;await gate.promise;throw new Error('CONTROLLED_OLD_APPEND_FAILURE');}return append(...args);
  });
  try{
    f.feed();await eventually(()=>entered);f.session.connectionEpoch='2';f.session.binding.connectionEpoch='2';
    const refresh=f.owner.bridge.onBootstrapConnected!({...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:'2'}});
    await eventually(()=>f.cancels===1);gate.release();await refresh;
    assert.equal(f.disconnects,0,'superseded control callbacks cannot disconnect the replacement source');
    assert.equal(f.streams,2,'old failure cannot turn a fresh setup into an unarmed success');
    f.feed(waveform(2));await latest(f);assert.equal(f.owner.pcmIngress!.snapshot().error,undefined);
    await assert.rejects(async()=>f.owner.bridge.close!(),(error:AggregateError)=>error.errors.some(failure=>failure.message==='CONTROLLED_OLD_APPEND_FAILURE'));
  }finally{gate.release();}
});

test('wake archive gate keeps PCM volatile until accepted and discards rejected wake originals',async t=>{
  const {createFormalPcmIngress}=await import('../src/personal-aios-formal-pcm.ts');
  for(const accepted of [false,true]){
    const f=await fixture(t);await f.create();await f.owner.bridge.onBootstrapConnected!(f.input);await f.owner.pcmIngress!.close();
    const gate=Promise.withResolvers<boolean>();let heard=0,decision:Promise<boolean>|undefined=gate.promise;
    assert.ok(f.pcm.streamFactory);
    const ingress=createFormalPcmIngress({participant:f.options.participant,runtime:f.owner.assembly.runtime,
      authority:f.owner.authority,clock:f.owner.clock!,budget:f.pcm.budget,streamFactory:f.pcm.streamFactory,
      captureDecision:()=>decision,onError:error=>f.errors.push(error)});
    t.after(()=>ingress.close());ingress.tap(()=>{heard++;});
    await ingress.onBootstrapConnected(f.input);f.subscribe();f.feed();
    await eventually(()=>heard===1);await new Promise(r=>setImmediate(r));
    assert.equal(f.raws.length,0);assert.equal(f.clockReads,0);assert.equal(await committedCount(f.storage),0);
    gate.resolve(accepted);
    await eventually(()=>ingress.snapshot().pending_frames===0);
    if(accepted){assert.deepEqual(f.errors,[]);await eventually(()=>!!ingress.snapshot().latest);assert.equal(f.raws.length,1);assert.equal(f.clockReads,1);assert.ok(ingress.snapshot().latest!.event.archive_revision);}
    else{decision=undefined;f.feed();await eventually(()=>heard===2&&ingress.snapshot().pending_frames===0);
      assert.equal(f.raws.length,0);assert.equal(f.clockReads,0);assert.equal(await committedCount(f.storage),0);}
    assert.deepEqual(f.errors,[]);await ingress.close();
  }
});

test('persistent callWire opens each new call with the stored conversation mode before constructing its frontend',{timeout:5000},async t=>{
  const f=await fixture(t,{voice:true}),fronts:{conversation_mode:string;tools:unknown[];onEvent:(event:unknown)=>void}[]=[];
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.room.localParticipant,{publishTrack:async()=>({sid:'remembered-mode-track',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,thinkingMode:{enabled:true,reader_instructions:'只读原文',
    status_text:{greeting:'思考模式',waiting:'正在想',slow:'仍在想',failed:'主脑没连上',interrupted:'朗读已停',readout_mismatch:'请以文字为准'}},
    createFront:(callbacks:any)=>{fronts.push({conversation_mode:callbacks.conversation_mode,tools:callbacks.tools,onEvent:callbacks.onEvent});return {
      connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},context:async()=>{},respond:async()=>({completed:true}),setInstructions:async()=>{}};}};
  await f.create({central:{...f.options.central,voice}});t.mock.method(f.owner.assembly.runtime,'callContext',async()=> 'owner context');
  f.addExisting();await f.owner.bridge.onBootstrapConnected!(f.input);
  const runtime=f.owner.assembly.runtime,source=await runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  const archive=runtime.existingArchive(),archived:Awaited<ReturnType<typeof archive.archive>>[]=[],write=archive.archive.bind(archive);
  t.mock.method(archive,'archive',async(...args:Parameters<typeof write>)=>{const result=await write(...args);
    if(JSON.parse(Buffer.from(args[0].payload).toString()).kind==='call_readout_fidelity')archived.push(result);return result;});
  const states=(id:string,state:string)=>(f.published as any[]).filter(p=>p.operation==='call_state'&&p.call_id===id&&p.state===state);
  for(const mode of ['thinking','chat'] as const){
    await runtime.rememberCallConversationMode(source,mode);const id=`remembered-${mode}`;
    f.sendText({operation:'call_open',call_id:id});await eventually(()=>states(id,'live').length>0);
    assert.equal(fronts.at(-1)!.conversation_mode,mode);assert.equal(states(id,'live').at(-1).conversation_mode,mode);
    if(mode==='thinking'){
      assert.deepEqual(fronts.at(-1)!.tools,[]);
      const evidence={message_id:'brain-message',sentence_index:2,response_id:'readout-response',source_text:'原'.repeat(560),
        transcript_text:'实'.repeat(560)},nativeBefore=f.nativeInputs.length,statesBefore=states(id,'live').length;
      fronts.at(-1)!.onEvent({type:'thinking.readout_transcript_mismatch',readout_fidelity:evidence});
      await eventually(()=>archived.length===1);
      const receipt=archived[0]!,record=await archive.readRecord(receipt.raw_ref,source.principal_id,receipt.archive_revision);
      assert.equal(record.kind,'original');if(record.kind!=='original')throw Error('EXPECTED_ORIGINAL');
      assert.deepEqual(JSON.parse(Buffer.from(record.bytes).toString()),{kind:'call_readout_fidelity',call_id:id,...evidence});
      assert.equal(record.event.device_id,source.device_id);assert.equal(f.nativeInputs.length,nativeBefore,'diagnostic archival does not dispatch a brain request');
      assert.equal(states(id,'live').length,statesBefore,'a transcript difference is logged evidence, never a user-visible status');
    }
    f.sendText({operation:'call_close',call_id:id});await eventually(()=>states(id,'closed').length>0);
  }
  assert.deepEqual(f.errors,[]);
});

test('failed renderer retirement prevents repeated OFF and thinking-mode retries from acknowledging success',{timeout:10000},async t=>{
  const f=await fixture(t,{voice:true}),v=await fakeVidu(t);
  t.mock.method(LocalSpeechEngine,'open',async()=>({openCallVad:async()=>({write:async()=>[],close:async()=>{}}),close:async()=>{}} as unknown as LocalSpeechEngine));
  Object.assign(f.room.localParticipant,{publishTrack:async()=>({sid:'failed-retirement-phone',waitForSubscription:async()=>{}}),unpublishTrack:async()=>{}});
  const voice={...f.options.central.voice!,thinkingMode:{enabled:true,reader_instructions:'只读原文',
    status_text:{greeting:'思考模式',waiting:'正在想',slow:'仍在想',failed:'主脑没连上',interrupted:'朗读已停',readout_mismatch:'请以文字为准'}},
    frontTurns:{config:{enabled:true},thinking:new Int16Array(480),score:async()=>1} as never,
    classifyCall:async()=>({stop:false,guests:'unchanged' as const}),createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},close:()=>{},
      context:async()=>{},respond:async()=>({completed:true}),commitInput:()=>{},requestReply:async()=>({completed:true}),setInstructions:async()=>{}})};
  await f.create({videoCall:{...v.resources,connect:(url,headers)=>{const socket=v.resources.connect(url,headers),send=socket.send.bind(socket);
    socket.send=(data:string|Buffer)=>{if(typeof data==='string'&&JSON.parse(data).type===7)throw Error('CONTROL_SEND_FAILED');send(data);};return socket;}},
    central:{...f.options.central,voice}});
  const runtime=f.owner.assembly.runtime;t.mock.method(runtime,'callContext',async()=> 'owner context');await f.owner.bridge.onBootstrapConnected!(f.input);
  const packets=()=>f.published as any[];
  f.sendText({operation:'call_open',call_id:'failed-retirement'});await eventually(()=>packets().some(p=>p.call_id==='failed-retirement'&&p.state==='live'));
  f.sendText({operation:'call_avatar',call_id:'failed-retirement',avatar_revision:1,avatar:true});await eventually(()=>packets().some(p=>p.media?.audio_input==='gateway'));
  assert.equal(v.creates.length,1);
  for(const control_id of ['mode-first','mode-retry']){
    f.sendText({operation:'call_set_conversation_mode',call_id:'failed-retirement',control_id,conversation_mode:'thinking'});
    await eventually(()=>packets().some(p=>p.operation==='rejected'&&p.control_id===control_id));
    assert.equal(packets().some(p=>p.operation==='control_receipt'&&p.control_id===control_id),false);
  }
  const failures=packets().filter(p=>p.operation==='rejected'&&p.request_operation==='call_avatar').length;
  f.sendText({operation:'call_avatar',call_id:'failed-retirement',avatar_revision:2,avatar:false});
  await eventually(()=>packets().filter(p=>p.operation==='rejected'&&p.request_operation==='call_avatar').length>failures);
  f.sendText({operation:'call_set_conversation_mode',call_id:'failed-retirement',control_id:'mode-after-off',conversation_mode:'thinking'});
  await eventually(()=>packets().some(p=>p.operation==='rejected'&&p.control_id==='mode-after-off'));
  assert.equal(packets().some(p=>p.operation==='control_receipt'&&p.requested_operation==='call_set_conversation_mode'),false);
  assert.equal(packets().some(p=>p.operation==='call_state'&&p.conversation_mode==='thinking'),false);
  const source=await runtime.authenticate(f.owner.authority.credentialForBootstrap(f.input));assert.equal(await runtime.callConversationMode(source),'chat');
  assert.equal(v.creates.length,1);assert.ok(f.errors.some(error=>String(error).includes('CLEANUP_FAILED')));
  f.sendText({operation:'call_close',call_id:'failed-retirement'});await eventually(()=>packets().some(p=>p.call_id==='failed-retirement'&&p.state==='closed'));
});
