import test from 'node:test';
import {AsyncLocalStorage,createHook} from 'node:async_hooks';
import {PaymentAuthority} from '../../../services/personal-aios-integration/src/payment/authority.ts';
import {DEFAULT_PAYMENT_CONFIG} from '../../../services/personal-aios-integration/src/payment/config.ts';
import {parseErrandResult} from '../src/errand-spool.ts';
import {paymentWire} from '../src/personal-aios-payment-wire.ts';
import {createSourceMediaPermission} from '../src/source-media-permission.ts';
import {createOwnerOverrideWire} from '../src/owner-override-wire.ts';
import {OwnerOverride,createOwnerOverrideSecret} from '../../../services/personal-aios-integration/src/owner-override.ts';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataPacketKind, RoomEvent, Room } from '@livekit/rtc-node';
const REALTIME_ASSISTANT_MAX_PACKET_BYTES = 12288;
import { bindRawSource, canonical, ContractError, digest, EVENT_SCHEMA, type ProcessedEvent, type RawEvent } from '../../../services/personal-aios-integration/src/contracts.ts';
import type {Movement,Navigation} from '../../../services/personal-aios-integration/src/movement.ts';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { inspectWav } from '../../../services/personal-aios-integration/src/tts.ts';
import {AmbientJournal} from '../../../services/personal-aios-integration/src/ambient/journal.ts';
import {VoiceConfirmations} from '../../../services/personal-aios-integration/src/voiceprint/confirmation.ts';
import {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import {controlledVad,transcriptionResult} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import { DeviceLocations } from '../../../services/personal-aios-integration/src/location.ts';
import { HealthStore, type HealthBatch } from '../../../services/personal-aios-integration/src/health/store.ts';
import { metricByWire } from '../../../services/personal-aios-integration/src/health/metrics.ts';
import { ContactsStore, type ContactsBatch } from '../../../services/personal-aios-integration/src/contacts/store.ts';
import {MediaProcessor} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {MediaService} from '../../../services/personal-aios-integration/src/media/service.ts';
import {StreamArchive} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import { RawArchive } from '../../../services/personal-aios-integration/src/archive.ts';
import { RunAdmission } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import { OutputAuthority } from '../../../services/personal-aios-integration/src/output.ts';
import {MAC_CAPABILITIES,PHONE_CAPABILITIES,GLASSES_CAPABILITIES,WATCH_CAPABILITIES,sourceSnapshot,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import { OutputTargetAuthority } from '../../../services/personal-aios-integration/src/routing.ts';
import { PersonalAIOSRuntime,sourceClient,type VoiceResultOrigin } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { NativeClient, NativeRun } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import { FormalSourceAuthority, FormalTerminalSources } from '../src/personal-aios-formal-source.ts';
import {createVoiceCallSession} from '../src/voice-call-session.ts';
import {createErrandSpool} from '../src/errand-spool.ts';
import {createBarkNotifier} from '../src/bark-notifier.ts';
import { createFormalTextIngress, createFormalWireAjv, FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC,FORMAL_TEXT_ENVELOPE_SCHEMA } from '../src/personal-aios-formal-text.ts';
import {REALTIME_READINESS_DEADLINE_MS} from '../src/realtime-readiness.ts';
const inertMacSource={principal_id:'actual-owner',device_id:'mac',device_type:'mac',capabilities:[],
  channel:'rtc_typed_text',consent_ref:'submit-consent',route_version:'route-1',output_modes:['text']};
const now='2026-10-01T00:00:00.000Z', future='2026-10-01T01:00:00.000Z';
function callRuntime(runtime:PersonalAIOSRuntime):PersonalAIOSRuntime {
  return Object.assign(runtime,{captureCall:async(source:RegisteredDevice,session:string,call_id:string)=>({source,
    locate:()=>runtime.locate(source),turn:(raw:RawEvent)=>runtime.submitCallTurn(raw,source,session),
    close:(closed:Omit<Parameters<PersonalAIOSRuntime['closeCall']>[2],'call_id'>)=>runtime.closeCall(source,session,{...closed,call_id})})});
}
function observeCallTurns(t:test.TestContext,runtime:PersonalAIOSRuntime,seen:(value:Awaited<ReturnType<PersonalAIOSRuntime['submitCallTurn']>>)=>void) {
  const capture=runtime.captureCall.bind(runtime);
  t.mock.method(runtime,'captureCall',async(...args:Parameters<PersonalAIOSRuntime['captureCall']>)=>{
    const call=await capture(...args);return {...call,turn:async(raw:RawEvent)=>{const value=await call.turn(raw);seen(value);return value;}};
  });
}


test('formal registry pins every wire extension sibling without operation collisions',async()=>{
  const {createHash}=await import('node:crypto');
  const contracts=new URL('../../../../../integrations/contracts/',import.meta.url);
  const bytes=await fs.readFile(new URL('formal-message.v1.json',contracts)),wire=JSON.parse(bytes.toString());
  assert.deepEqual(wire.extensions.map((entry:any)=>entry.contract),['payment-message.v1.json','terminal-message.v1.json',
    'owner-override-message.v1.json','call-avatar.v1.json','appearance-message.v1.json','model-settings.v1.json']);
  const app=new URL('../../../../../01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/',import.meta.url);
  assert.deepEqual(await fs.readFile(new URL('formal-message.v1.json',app)),bytes);
  const groups={inputs:new Set(Object.keys(wire.inputs)),outputs:new Set(Object.keys(wire.outputs))},ajv=createFormalWireAjv();
  for(const entry of wire.extensions){
    const source=await fs.readFile(new URL(entry.contract,contracts)),extension=JSON.parse(source.toString());
    assert.equal(createHash('sha256').update(source).digest('hex'),entry.sha256);
    assert.equal(extension.version,entry.version);
    assert.deepEqual(await fs.readFile(new URL(entry.contract,app)),source);
    for(const group of ['inputs','outputs'] as const)for(const [operation,definition] of Object.entries<any>(extension[group])){
      assert.equal(groups[group].has(operation),false,`${group}.${operation}`);groups[group].add(operation);
      // The gateway and the staging sim client compile every registered extension with this one strict validator.
      ajv.compile({$defs:extension.$defs,...(group==='inputs'?definition.definition:definition)});
    }
  }
});

test('formal video requests and ARTC credentials preserve their public wire types',async()=>{
  const {Ajv}=await import('ajv'),wire=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const input=ajv.compile({$defs:wire.$defs,...wire.inputs.call_open.definition}),state=ajv.compile(wire.outputs.call_state);
  assert.equal(input({operation:'call_open',call_id:'video',video:true}),false);
  assert.ok(input({operation:'call_open',call_id:'video',video:true,video_revision:0}));
  const command=ajv.compile(wire.inputs.call_video.definition);
  assert.ok(command({operation:'call_video',call_id:'video',video:false,video_revision:2}));
  assert.equal(command({operation:'call_video',call_id:'video',video:false}),false);
  for(const video_revision of [-1,0.5,9007199254740992,'2']){
    assert.equal(command({operation:'call_video',call_id:'video',video:false,video_revision}),false);
    assert.equal(input({operation:'call_open',call_id:'video',video:true,video_revision}),false);
  }
  for(const video of [false,'true'])assert.equal(input({operation:'call_open',call_id:'video',video}),false);
  const media={provider:'artc',app_id:'app',channel_id:'channel',user_id:'user',token:'rtc-token',token_expire_at:'2000000000'};
  const envelope={schema_version:wire.schema,operation:'call_state',session_id:'session',call_id:'video',state:'connecting',media,video_revision:0};
  assert.ok(state(envelope));
  assert.equal(state({...envelope,video_revision:undefined}),false);
  assert.equal(state({...envelope,media:undefined,video:false,video_revision:undefined}),false);
  for(const invalid of [{provider:'agora'},{token:undefined},{token_expire_at:2000000000},{api_key:'forbidden'}])assert.equal(state({...envelope,media:{...media,...invalid}}),false);
  for(const reason of ['force_hangup','max_duration','disconnected','ws_closed','network'])assert.ok(state({...envelope,state:'closed',reason}));
  assert.ok(state({...envelope,rejoin_deadline:future}));assert.equal(state({...envelope,rejoin_deadline:123}),false);
  const card=ajv.compile({$defs:wire.$defs,...wire.outputs.display_card}),caption={schema_version:wire.schema,operation:'display_card',session_id:'session',
    card_id:'caption',title:'依米',lines:['回来了'],priority:'normal',lifetime_ms:8000};
  for(const role of ['user','assistant','main_agent'])assert.ok(card({...caption,caption:{role,turn:0}}));
  for(const invalid of [null,{role:'owner',turn:1},{role:'user',turn:-1},{role:'user',turn:0.5},{role:'user',turn:'1'},{role:'user',turn:1,extra:true}])
    assert.equal(card({...caption,caption:invalid}),false);
});
const sessionRef={ref_type:'realtime_session',ref_id:'source-session'}, leaseRef={ref_type:'device_lease',ref_id:'source-lease'};
function fixture(watch=false,sourceIDs={primary:'mac',watch:'watch-source',client:'watch-client'},outputModes=['text'],terminal?:{type:'glasses'|'phone'|'mac'|'watch';registry:FormalTerminalSources},voicePermission=false,continuityId='continuity') {
  const input={request:{request_id:'bootstrap'},bearer:{principal:{opaque_ref:'not-user-id'},deviceId:sourceIDs.primary},governance:{accepted:true},authority:{gateway:{identity:'controlled-source-gateway',roomName:'room'}},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId,connectionEpoch:'1',credentialRoom:'room',credentialIdentity:'terminal'},
    enabledMedia:{data:true,audio:voicePermission,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const current={session:{realtimeSessionRef:sessionRef,userId:'actual-owner',continuityId,state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:future,activeDeviceId:sourceIDs.primary,activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId,deviceId:sourceIDs.primary,connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId,userId:'actual-owner',deviceId:sourceIDs.primary,state:'active',
      expiresAt:future,leaseVersion:'1',fencingToken:'1',purpose:'typed-submit',capabilities:voicePermission?['data','audio']:['data']}} as unknown as RealtimeCurrentBindingProjection;
  const snapshot:any={binding:current,formalWatchPairState:{pairVersion:'1',status:'active',requiresRebind:false},
    formalWatchBinding:{kind:'t02.apple.watch-binding.v1',pairVersion:'1',userId:'actual-owner',status:'active',
      iphone:{deviceId:sourceIDs.primary,deviceLeaseRef:leaseRef},watch:{deviceId:sourceIDs.watch,clientInstanceId:sourceIDs.client},
      realtimeSessionRef:sessionRef,expiresAt:future,canonicalPayloadSha256:'b'.repeat(64)}};
  let route='route-1',fail=false;
  const authority=new FormalSourceAuthority({...(terminal?{credentialRegistry:terminal.registry}:{}),ownerContext:{resolve:async({bearer})=>{
    assert.deepEqual(bearer.principal,{opaque_ref:'not-user-id'});return {userId:'actual-owner',deviceId:sourceIDs.primary,purpose:'typed-submit',capabilities:voicePermission?['data','audio']:['data'],occurredAt:now as never};}},
    readCurrentBinding:async lookup=>{assert.deepEqual(lookup,{realtimeSessionRef:sessionRef});if(fail)throw new Error('CURRENT_AUTH_UNAVAILABLE');return current;},
    ...(watch||voicePermission?{runControlPermission:createSourceMediaPermission({readCurrentBinding:async()=>current,readCurrentBindingInAdmission:async()=>current,
      equality:{key:value=>canonical(value),same:(a,b)=>canonical(a)===canonical(b)},now:()=>now,
      credentialFence:{verify:async()=>({active:false}),withAdmission:async(_tuple,consume)=>consume({} as never)}}),readCurrentBindingInAdmission:async()=>current}:{}),...(watch?{watchSnapshot:{snapshotIsolation:'REPEATABLE READ' as const,readOnly:true as const,readCurrentBindingSnapshot:async()=>snapshot,readCurrentBindingSnapshotInAdmission:async()=>snapshot},readCurrentBindingInAdmission:async()=>current}:{}),
    sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>Date.parse(now),resolveSource:async()=>({device_type:terminal?.type??(watch?'phone' as const:'mac' as const),channel:'rtc_typed_text',capabilities:(watch||terminal?.type==='phone')?PHONE_CAPABILITIES:terminal?.type==='glasses'?GLASSES_CAPABILITIES:terminal?.type==='watch'?WATCH_CAPABILITIES:MAC_CAPABILITIES,consent_ref:'submit-consent',route_version:route,output_modes:outputModes})});
  return {input,current,authority,snapshot,setSessionState:(value:RealtimeCurrentBindingProjection['session']['state'])=>{(current.session as {state:typeof value}).state=value;},setRoute:(value:string)=>{route=value;},setFail:()=>{fail=true;}};
}
async function eventually(predicate:()=>boolean|Promise<boolean>,timeout=10000){for(let i=0;i<timeout/5;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('TEST_TIMEOUT');}
test('actual owner and source provenance; same epoch renewal refreshes route, new epoch denied',async()=>{
  const f=fixture();await assert.rejects(f.authority.authenticate({...f.input.bearer,authenticated:true}),/HOST_CREDENTIAL_REQUIRED/);
  const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));assert.equal(source.principal_id,'actual-owner');
  assert.equal('token_sha256' in source,false);await assert.rejects(f.authority.revalidate({...source}),/PROVENANCE_REQUIRED/);
  assert.throws(()=>{source.principal_id='forged';},TypeError);f.setRoute('route-2');(f.current.lease as {leaseVersion:string}).leaseVersion='2';
  assert.equal((await f.authority.revalidate(source)).route_version,'route-2');(f.current.session as {connectionEpoch:string}).connectionEpoch='2';
  await assert.rejects(f.authority.revalidate(source),/OWNER_BINDING_DENIED/);
});
test('wrong owner/device, mutated host context and current-auth failure denied',async()=>{
  for(const mutation of ['user','device','host','failure']){const f=fixture(),source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
    if(mutation==='user')(f.current.session as {userId:string}).userId='forged';if(mutation==='device')(f.current.lease as {deviceId:string}).deviceId='forged';
    if(mutation==='host')f.input.currentBinding.connectionEpoch='forged';if(mutation==='failure')f.setFail();
    await assert.rejects(f.authority.revalidate(source),mutation==='host'?/CONTEXT_MUTATED/:mutation==='failure'?/CURRENT_AUTH_UNAVAILABLE/:/OWNER_BINDING_DENIED/);}
});
test('connected text -> real POSIX L5/D/route -> one synthetic native run/sealed OUT; publish is delivery unknown',async t=>{
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'baseline-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const attachment={grant_id:'file-grant',path:'/Users/owner/账单.pdf',name:'账单.pdf',size:1258291,kind:'pdf' as const};
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),routes=new OutputTargetAuthority(storage);let creates=0;const runs=new Map<string,NativeRun>();
  const native:NativeClient={create:async body=>{const [json, ...fileLines]=body.input.split('\n'),d=JSON.parse(json!) as ProcessedEvent;
    assert.deepEqual(d.content.attachments,[attachment]);assert.deepEqual(fileLines,['（用户在电脑上直接给你的文件：账单.pdf，pdf，1.2 MB，路径 /Users/owner/账单.pdf。这是他授权你处理的，可以直接用电脑工具处理。）']);
    assert.equal((await routes.read(d)).route_version,'route-1');
    creates++;const run={run_id:'native-'+creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async run=>({...runs.get(run)!}),cancel:async run=>({...runs.get(run)!})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'formal-test'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
  const listeners=new Map<string,(...args:readonly unknown[])=>void>(),publications:{body:any;options:any}[]=[],errors:unknown[]=[];
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:readonly unknown[])=>void)=>{listeners.set(event,fn);},off:(event:string)=>{listeners.delete(event);},
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array,options:unknown)=>{const body=JSON.parse(Buffer.from(bytes).toString('utf8'));if(body.operation!=='rejected')publications.push({body,options});}}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);const send=(body:unknown,identity='terminal')=>listeners.get(RoomEvent.DataReceived)?.(Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const body={operation:'submit',event_id:'formal-event',captured_at:now,text:'用户原文  \nexact original',attachments:[attachment]};send(body,'forged');assert.equal(publications.length,0);
  send({...body,principal_id:'forged'});await eventually(()=>errors.length===1);assert.equal(creates,0);send(body);await eventually(()=>publications.length===1);
  assert.equal('processed_event' in publications[0]!.body,false);
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  const d=(await runtime.event(source,'continuity',publications[0]!.body.processed_event_id)).processed_event;assert.equal(d.origin,'explicit_user_prompt');assert.equal(d.user_identity,'actual-owner');assert.equal(d.source.channel,'rtc_typed_text');assert.deepEqual(d.content.attachments,[attachment]);assert.equal('attachments' in d,false);
  const record=await archive.readRecord(d.raw_ref,d.principal_id,d.archive_revision,{maxReadBytes:8192});assert.equal(record.kind,'original');
  assert.equal(Buffer.from((record as {bytes:Uint8Array}).bytes).toString('utf8'),body.text);
  await eventually(async()=>Boolean((await runtime.event(source,'continuity',d.processed_event_id)).admission.run_id));
  assert.equal(creates,1);f.setRoute('route-2');const duplicateStart=publications.length;send(body);await eventually(()=>publications.length>duplicateStart);assert.equal(publications[1]!.body.processed_event_id,d.processed_event_id);assert.equal(creates,1);assert.equal((await routes.read(d)).route_version,'route-1');
  await runtime.tool('paios_open_reply',{context:{run_id:'native-1',session_id:'continuity',tool_call_id:'reply'},args:{reply_mode:'text'}});runs.get('native-1')!.status='completed';const unicode='🔬中文'.repeat(24000);runs.get('native-1')!.output=unicode;
  send({operation:'result',processed_event_id:d.processed_event_id});await eventually(()=>publications.length>3 && publications.at(-1)!.body.chunk?.final===true);const result=publications.find(packet=>packet.body.operation==='result_header')!.body;
  assert.equal(result.operation,'result_header');assert.equal('reply_text' in result,false);assert.equal(result.delivery_status,'unknown');
  const packets=publications.filter(packet=>packet.body.operation==='text_chunk');assert.equal(result.pending_text_chunk_count,packets.length);
  assert.equal(packets.map(packet=>packet.body.chunk.text).join(''),unicode);
  for(const packet of publications)assert.ok(Buffer.byteLength(JSON.stringify(packet.body))<=REALTIME_ASSISTANT_MAX_PACKET_BYTES);
  for(const [index,packet] of packets.entries()){assert.equal(packet.body.operation,'text_chunk');assert.equal(packet.body.chunk.seq,index+1);
    assert.equal(packet.body.chunk.reply_id,result.reply_id);assert.equal(packet.body.chunk.reply_epoch,result.reply_epoch);
    assert.equal(packet.body.chunk.route_version,'route-1');assert.equal(packet.body.chunk.output_id,packets[0]!.body.chunk.output_id);}assert.deepEqual(publications.find(packet=>packet.body.operation==='result_header')!.options,{reliable:true,destination_identities:['terminal'],topic:FORMAL_TEXT_OUTPUT_TOPIC});
  const ack={output_id:packets[0]!.body.chunk.output_id,reply_id:result.reply_id,reply_epoch:result.reply_epoch,target_device_id:'mac',route_version:'route-1',
    highest_contiguous_seq:packets.length,status:'rendered',observed_at:now};
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,route_version:'forged'}});await eventually(()=>errors.length===2);assert.match(String(errors[1]),/BINDING_MISMATCH/);
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,reply_epoch:ack.reply_epoch+1}});await eventually(()=>errors.length===3);assert.match(String(errors[2]),/OLD_EPOCH/);
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,status:'played'}});await eventually(()=>errors.length===4);assert.match(String(errors[3]),/CHANNEL_UNSUPPORTED/);
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,output_id:'voice:unimplemented',status:'accepted'}});await eventually(()=>errors.length===5);assert.match(String(errors[4]),/CHANNEL_UNSUPPORTED/);
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,status:'accepted'}});await eventually(()=>publications.at(-1)!.body.operation==='ack_receipt');
  assert.equal(publications.at(-1)!.body.receipt.status,'accepted');assert.equal((await runtime.result(source,'continuity',d.processed_event_id)).result.delivery_status,'accepted');
  const replayRequest={operation:'result',processed_event_id:d.processed_event_id,text_replay:'sealed'};
  const replay=async()=>{const start=publications.length;send(replayRequest);await eventually(()=>publications.length===start+1+packets.length);
    return {request:replayRequest,header:publications[start]!.body,text_chunks:publications.slice(start+1).map(packet=>packet.body)};};
  const initialReplay=await replay();assert.deepEqual(initialReplay.text_chunks,packets.map(packet=>packet.body));
  send({operation:'ack',processed_event_id:d.processed_event_id,ack:{...ack,highest_contiguous_seq:35}});
  await eventually(()=>publications.at(-1)!.body.receipt?.highest_contiguous_seq===35);
  const partialReplay=await replay();assert.equal(partialReplay.header.rendered_text_through_seq,35);
  assert.equal(partialReplay.header.pending_text_chunk_count,packets.length-35);assert.deepEqual(partialReplay.text_chunks,initialReplay.text_chunks);
  send({operation:'ack',processed_event_id:d.processed_event_id,ack});await eventually(()=>publications.at(-1)!.body.receipt?.highest_contiguous_seq===packets.length && publications.at(-1)!.body.receipt?.status==='rendered');const receiptEnvelope=publications.at(-1)!.body,receipt=receiptEnvelope.receipt;
  assert.equal(receipt.status,'rendered');assert.equal(receipt.output_id,ack.output_id);assert.match(receipt.receipt_ref,/^out-ack:/);
  let count=publications.length;send({operation:'ack',processed_event_id:d.processed_event_id,ack});await eventually(()=>publications.length===count+1);assert.deepEqual(publications.at(-1)!.body.receipt,receipt);
  count=publications.length;send({operation:'result',processed_event_id:d.processed_event_id});await eventually(()=>publications.length===count+1);assert.equal(publications.at(-1)!.body.operation,'result_header');
  assert.equal(publications.at(-1)!.body.delivery_status,'rendered');assert.equal(publications.at(-1)!.body.pending_text_chunk_count,0);assert.equal(creates,1);
  const pendingHeader=publications.at(-1)!.body,fullReplay=await replay();assert.equal(fullReplay.header.rendered_text_through_seq,packets.length);
  assert.equal(fullReplay.header.pending_text_chunk_count,0);assert.deepEqual(fullReplay.text_chunks,initialReplay.text_chunks);assert.equal(creates,1);
  if(process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT) await fs.writeFile(process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT,JSON.stringify({
    schema:'paios.central.text-fixture.v1',evidence:'real POSIX OUT with controlled source/synthetic native/SDK; not real device ACK',
    trusted_binding:{session_id:f.input.currentBinding.continuityId,device_id:'mac',connection_epoch:f.input.currentBinding.connectionEpoch,
      expected_gateway_identity:f.input.authority.gateway.identity,evidence:'controlled host/SDK fixture; not observed actual connected gateway identity'},
    input_topic:FORMAL_TEXT_INPUT_TOPIC,output_topic:FORMAL_TEXT_OUTPUT_TOPIC,packet_budget:REALTIME_ASSISTANT_MAX_PACKET_BYTES,
    input_submit:body,accepted:publications[0]!.body,input_result:replayRequest,
    result_header:initialReplay.header,text_chunks:initialReplay.text_chunks,pending_header:result,fully_rendered_pending_header:pendingHeader,
    partial_rendered_replay:partialReplay,full_rendered_replay:fullReplay,input_ack:{operation:'ack',processed_event_id:d.processed_event_id,ack},
    ack_receipt:receiptEnvelope,after_ack_header:fullReplay.header,
  },null,2)+'\n');
  const published=publications.length;f.setFail();send({operation:'ack',processed_event_id:d.processed_event_id,ack});await eventually(()=>errors.length===6);
  assert.equal(publications.length,published);assert.equal(creates,1);assert.match(String(errors[5]),/CURRENT_AUTH_UNAVAILABLE/);
  await bridge.close();assert.equal(listeners.size,0);
});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function testRoom() {
  const callbacks=new Map<string,Set<(...args:readonly unknown[])=>void>>(),published:unknown[]=[];
  return {isConnected:true,published,callbacks,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,callback:(...args:readonly unknown[])=>void)=>{
    if(!callbacks.has(event))callbacks.set(event,new Set());callbacks.get(event)!.add(callback);},
    off:(event:string,callback:(...args:readonly unknown[])=>void)=>{callbacks.get(event)?.delete(callback);},
    emit:(event:string,...args:readonly unknown[])=>{for(const callback of [...callbacks.get(event)??[]])callback(...args);},
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{published.push(JSON.parse(Buffer.from(bytes).toString('utf8')));}}};
}
test('activity cards bind the receiving session and preserve task identity across replay without reply ACK or speech',async t=>{
  const {createTimelineWire}=await import('../src/personal-aios-terminal-wire.ts');
  const {fixtures}=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/activity-update.fixtures.json',import.meta.url),'utf8'));
  const initial=[fixtures.single_running,fixtures.parallel_six],errors:unknown[]=[],terminals:any[]=[];
  let speech=0,notices=0;
  for(const type of ['mac','glasses'] as const){
    const f=fixture(),room=testRoom();room.remoteParticipants.clear();
    const received=(body:any)=>({...body,session_id:f.input.currentBinding.continuityId});
    assert.ok(initial.every(body=>body.session_id!==f.input.currentBinding.continuityId));
    const device={...inertMacSource,device_type:type,capabilities:type==='mac'?MAC_CAPABILITIES:GLASSES_CAPABILITIES};
    let delivery!:(body:any)=>Promise<void>,replays=0,stopped=0;
    const runtime={authenticate:async()=>device,cameraReady:async()=>{},movementReady:async()=>{},paymentDetach:async()=>{},
      watchPayments:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},watchVoiceConfirmations:async()=>()=>{},
      timeline:{fanout:(source:any)=>source.device_type==='mac',head:()=>0,page:()=>({head_seq:0,has_more:false,items:[]}),watch:()=>()=>{}},
      watchActivity:async(_source:unknown,deliver:(body:any)=>Promise<void>)=>{delivery=deliver;for(const body of initial)await deliver(body);return()=>{stopped++;};},
      replayActivity:async(_source:unknown,deliver:(body:any)=>Promise<void>)=>{replays++;for(const body of initial)await deliver(body);}
    } as unknown as PersonalAIOSRuntime;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime,authority:f.authority,
      extensions:[createTimelineWire(runtime,error=>errors.push(error))],max_packet_bytes:12288,onError:error=>errors.push(error),
      notify:async()=>{notices++;},voice_call:{open:async()=>{},close:async()=>{},respond:async()=>{speech++;return false;},attach:()=>()=>{}}});
    t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
    const peer={identity:'terminal',trackPublications:new Map()};room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
    const packets=()=>room.published.filter((body:any)=>body.operation==='activity_update');
    await eventually(()=>{assert.deepEqual(errors,[]);return packets().length===2;});
    assert.deepEqual(packets(),initial.map(received));
    room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);
    room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
    await eventually(()=>packets().length===4);assert.equal(replays,1);
    assert.deepEqual(packets().slice(2),packets().slice(0,2));
    if(type==='mac'){
      room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'timeline_sync',request_id:'activity-resync'})),peer,DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
      await eventually(()=>packets().length===6);assert.equal(replays,2);
      assert.deepEqual(packets().slice(4),packets().slice(0,2));
      room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);
      await delivery(fixtures.succeeded);await delivery(fixtures.single_running);
      room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
      await eventually(()=>packets().length>=8&&replays===3);
      assert.deepEqual(packets().slice(6).find((body:any)=>body.card.id===fixtures.succeeded.card.id),received(fixtures.succeeded));
    }
    const update={...fixtures.succeeded};await delivery(update);await eventually(()=>packets().at(-1)?.card.revision===update.card.revision);
    assert.deepEqual(packets().at(-1),received(update));
    terminals.push(packets().slice(0,2));await bridge.close();assert.equal(stopped,1);
  }
  assert.deepEqual(terminals[0],terminals[1]);assert.equal(speech,0);assert.equal(notices,0);assert.deepEqual(errors,[]);
});
test('C5.7 I1 formal extensions use authenticated senders, validated envelopes and connection-owned attachment lifetimes',async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],owners:string[]=[],attached:string[]=[],retired:string[]=[];
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:(credential:unknown)=>f.authority.authenticate(credential),cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime;
  const extension:import('../src/personal-aios-terminal-wire.ts').WireExtension={
    inputs:{desktop_pause:{definition:{type:'object',properties:{operation:{const:'desktop_pause'},paused:{type:'boolean'}},required:['operation','paused'],additionalProperties:false},error:'FORMAL_CONTROL_ARGUMENT_INVALID'}},
    outputs:{terminal_receipt:{type:'object',properties:{schema_version:{const:'paios.central.text-envelope.v1'},session_id:{type:'string'},operation:{const:'terminal_receipt'},ok:{type:'boolean'}},required:['schema_version','session_id','operation','ok'],additionalProperties:false}},
    handle:async(_op,_body,source,publish)=>{owners.push(source.principal_id);await publish({operation:'terminal_receipt',ok:true});},
    attach:ctx=>{attached.push(ctx.identity);return()=>{retired.push(ctx.identity);};}
  };
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    extensions:[extension],max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);assert.deepEqual(attached,['terminal']);
  const send=(body:unknown,identity='terminal')=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'desktop_pause',paused:true},'foreign');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(owners,[]);
  send({operation:'desktop_pause',paused:'yes'});await eventually(()=>errors.length===1);assert.match(String(errors[0]),/FORMAL_CONTROL_ARGUMENT_INVALID/);assert.deepEqual(owners,[]);
  send({operation:'desktop_pause',paused:true});await eventually(()=>room.published.some((p:any)=>p.operation==='terminal_receipt'));
  assert.deepEqual(owners,['actual-owner']);assert.deepEqual(room.published.at(-1),{operation:'terminal_receipt',ok:true,session_id:'continuity',schema_version:'paios.central.text-envelope.v1'});
  await bridge.onBootstrapConnected(f.input);assert.deepEqual(attached,['terminal','terminal']);assert.deepEqual(retired,['terminal']);
  await bridge.close();assert.deepEqual(retired,['terminal','terminal']);
});
test('formal ready holds setup output, flushes in order, fences senders and runs once per generation',async t=>{
  const f=fixture(),room=testRoom(),packets:any[]=[],opened:string[]=[],errors:unknown[]=[],reminder=deferred<void>();
  let historyEpoch:string|undefined;
  let progress:((list:unknown[])=>Promise<boolean>)|undefined;
  room.remoteParticipants.clear();room.localParticipant.publishData=async bytes=>{packets.push(JSON.parse(Buffer.from(bytes).toString()));};
  room.localParticipant.sendText=async(text:string)=>{packets.push(JSON.parse(text));};
  const phone={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},watchVoiceConfirmations:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    watchReminders:async(_s:unknown,deliver:(list:unknown[])=>Promise<void>)=>{await deliver([]);reminder.resolve();return()=>{};},
    historyEpoch:async()=>historyEpoch,cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_s:unknown,_show:unknown,_speak:unknown,_observe:unknown,_live:unknown,errands:{progress:(list:unknown[])=>Promise<boolean>})=>{
      progress=errands.progress;await reminder.promise;await progress([]);return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:{cancel:async()=>false},
    voice_call:{open:async id=>{opened.push(id);},close:async()=>{},respond:async()=>false,attach:()=>()=>{}},onError:error=>errors.push(error)});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  const bytes=Buffer.from(JSON.stringify({operation:'call_open',call_id:'first-tap'}));
  room.emit(RoomEvent.DataReceived,bytes,undefined,DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  room.emit(RoomEvent.DataReceived,bytes,{identity:'forged'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  room.emit(RoomEvent.ParticipantConnected,{identity:'forged'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(packets.length,0);assert.equal(opened.length,0);
  const peer={identity:'terminal',trackPublications:new Map()};room.remoteParticipants.set('terminal',peer);
  room.emit(RoomEvent.ParticipantConnected,peer);await eventually(()=>packets.some(packet=>packet.operation==='ready'));
  assert.deepEqual(packets.map(packet=>packet.operation),['reminders_sync','errand_progress','ready']);
  assert.deepEqual(packets.at(-1),{schema_version:'paios.central.text-envelope.v1',operation:'ready',session_id:'continuity'});
  room.emit(RoomEvent.ParticipantConnected,peer);room.emit(RoomEvent.DataReceived,bytes,peer,DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>opened.length===1);assert.deepEqual(opened,['first-tap']);
  historyEpoch='a'.repeat(32);
  room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);
  const held=progress!([]);await new Promise(resolve=>setImmediate(resolve));assert.equal(packets.length,3);
  room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
  await held;await eventually(()=>packets.filter(packet=>packet.operation==='ready').length===2);
  assert.deepEqual(packets.slice(3).map(packet=>packet.operation),['errand_progress','ready']);
  assert.equal(packets.at(-1).history_epoch,historyEpoch,'reset generation travels only on authenticated ready');
  historyEpoch='b'.repeat(32);
  await bridge.onBootstrapConnected(f.input);assert.equal(packets.filter(packet=>packet.operation==='ready').length,3);
  assert.equal(packets.at(-1).history_epoch,historyEpoch,'rollback publishes another generation');
  assert.deepEqual(errors,[]);
  room.remoteParticipants.clear();await bridge.onBootstrapConnected(f.input);await bridge.close();
  assert.equal(packets.filter(packet=>packet.operation==='ready').length,3,'retiring an unknown peer flushes no output');
});

test('peer loss releases bootstrap while a stuck SDK publication redelivers setup before the replacement ready',async t=>{
  const f=fixture(),room=testRoom(),entered=deferred<void>(),oldCallback=deferred<void>(),errors:unknown[]=[],packets:string[]=[];
  let first=true,watchers=0,rejoins=0;
  room.localParticipant.publishData=async bytes=>{if(first){first=false;entered.resolve();await oldCallback.promise;return;}packets.push(JSON.parse(Buffer.from(bytes).toString()).operation);};
  room.localParticipant.sendText=async()=>{packets.push('ready');};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({device_type:'mac',capabilities:MAC_CAPABILITIES}),
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_source:unknown,show:(id:string,text:string)=>Promise<unknown>)=>{watchers++;await show('first','one');await show('second','two');return()=>{};},
    watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime,authority:f.authority,
    voice_call:{open:async()=>{},close:async()=>{},respond:async()=>false,rejoin:async()=>{rejoins++;},attach:()=>()=>{}},
    max_packet_bytes:12288,onError:error=>errors.push(error)});
  t.after(()=>{oldCallback.resolve();return bridge.close();});
  const setup=bridge.onBootstrapConnected(f.input);await entered.promise;
  const peer=room.remoteParticipants.get('terminal')!;room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);
  await setup;assert.deepEqual(packets,[],'a departed recipient cannot publish readiness');
  room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
  await eventually(()=>rejoins===1);assert.deepEqual(packets,['ambient_reply','ambient_reply','ready']);assert.equal(watchers,1);
  await bridge.close();oldCallback.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(packets,['ambient_reply','ambient_reply','ready'],'late native completion cannot publish or commit a newer generation');assert.deepEqual(errors,[]);
});

test('peer loss retires a stuck ready send or late rejoin authorization without affecting its replacement',async t=>{
  for(const phase of ['send','rejoin-auth']){
  const f=fixture(),room=testRoom(),entered=deferred<void>(),oldCallback=deferred<void>(),errors:unknown[]=[];let sends=0,rejoins=0,auths=0;
  room.localParticipant.sendText=async()=>{if(++sends===1&&phase==='send'){entered.resolve();await oldCallback.promise;}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(++auths===3&&phase==='rejoin-auth'){entered.resolve();await oldCallback.promise;}return {device_type:'mac'};},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime,
    authority:f.authority,voice_call:{open:async()=>{},close:async()=>{},respond:async()=>false,rejoin:async()=>{rejoins++;},attach:()=>()=>{}},
    max_packet_bytes:12288,onError:error=>errors.push(error)});
  t.after(()=>{oldCallback.resolve();return bridge.close();});
  const setup=bridge.onBootstrapConnected(f.input);await entered.promise;
  const peer=room.remoteParticipants.get('terminal')!;room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);await setup;
  assert.equal(rejoins,0);room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
  await eventually(()=>rejoins===1);oldCallback.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(sends,2);assert.equal(rejoins,1);assert.deepEqual(errors,[]);
  await bridge.close();
  }
});

test('a terminal joining or rejoining later than the publication deadline keeps its room and receives the queued snapshot',async t=>{
  // A fresh terminal may join its room more than 5 s after bootstrap. The confirmations snapshot
  // queued at prepare timed out waiting for the device (TERMINAL_PUBLICATION_TIMEOUT) and the gateway left the room.
  t.mock.timers.enable({apis:['setTimeout']});
  const {createTimelineWire}=await import('../src/personal-aios-terminal-wire.ts');
  const f=fixture(),room=testRoom(),errors:unknown[]=[],sent:string[]=[];let disconnects=0,deliver:((pending:unknown[])=>Promise<void>)|undefined;
  room.remoteParticipants.clear();Object.assign(room,{disconnect:async()=>{disconnects++;}});
  room.localParticipant.publishData=async bytes=>{sent.push(JSON.parse(Buffer.from(bytes).toString()).operation);};
  room.localParticipant.sendText=async(text:string)=>{sent.push(JSON.parse(text).operation);};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:(credential:unknown)=>f.authority.authenticate(credential),cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    timeline:{fanout:()=>true,head:()=>0,page:()=>({head_seq:0,has_more:false,items:[]}),watch:()=>()=>{}},
    watchVoiceConfirmations:async(_source:unknown,publish:(pending:unknown[])=>Promise<void>)=>{deliver=publish;await publish([]);return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{disconnects++;}} as never,runtime,authority:f.authority,
    extensions:[createTimelineWire(runtime,error=>errors.push(error))],max_packet_bytes:12288,onError:error=>errors.push(error)});
  t.after(()=>bridge.close());
  const settle=async()=>{for(let n=0;n<20;n++)await new Promise(resolve=>setImmediate(resolve));};
  await bridge.onBootstrapConnected(f.input);await settle();assert.ok(deliver);
  t.mock.timers.tick(5001);await settle();
  assert.deepEqual(errors,[]);assert.equal(disconnects,0,'waiting for the device to join is not a stuck transport');assert.deepEqual(sent,[]);
  const peer={identity:'terminal',trackPublications:new Map()};room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
  await settle();assert.deepEqual(sent.sort(),['confirmations','ready']);
  room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);await deliver!([]);await settle();
  t.mock.timers.tick(5001);await settle();
  assert.deepEqual(errors,[]);assert.equal(disconnects,0,'a device recovering its transport keeps the room');assert.equal(sent.length,2);
  room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);await settle();
  assert.deepEqual(sent.slice(2).sort(),['confirmations','ready']);assert.deepEqual(errors,[]);
});

test('a publication stuck in authorization or the SDK past 5 s keeps the room, logs one stall line, and the newest state follows',async t=>{
  // Bounded timeline publications may exceed the 5 s deadline while media still flows to the iPhone and
  // Mac's rooms itself, ending a live video call while media still flowed. Slowness is not liveness; the SDK's room events are.
  const {createTimelineWire}=await import('../src/personal-aios-terminal-wire.ts');
  for(const step of ['authorize','sdk']){
  t.mock.timers.reset();t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-17T13:03:50.145Z')});
  const f=fixture(),room=testRoom(),errors:unknown[]=[],sent:{operation:string;items?:{confirmation_id:string}[]}[]=[],lines:Record<string,unknown>[]=[],gate=deferred<void>();
  let disconnects=0,stall=false,watching=false,attempts=0,deliver:((pending:unknown[])=>Promise<void>)|undefined;
  // Counts attempts entering the stuck step after the stall begins; only the first one is held.
  const hold=async()=>{if(!watching)return;attempts++;if(stall){stall=false;await gate.promise;}};
  Object.assign(room,{disconnect:async()=>{disconnects++;}});
  room.localParticipant.publishData=async bytes=>{const body=JSON.parse(Buffer.from(bytes).toString());if(body.operation==='confirmations'&&step==='sdk')await hold();sent.push(body);};
  room.localParticipant.sendText=async(text:string)=>{sent.push(JSON.parse(text));};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async(credential:unknown)=>{if(step==='authorize')await hold();return f.authority.authenticate(credential);},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    timeline:{fanout:()=>true,head:()=>0,page:()=>({head_seq:0,has_more:false,items:[]}),watch:()=>()=>{}},
    watchVoiceConfirmations:async(_source:unknown,publish:(pending:unknown[])=>Promise<void>)=>{deliver=publish;await publish([]);return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{disconnects++;}} as never,runtime,authority:f.authority,
    extensions:[createTimelineWire(runtime,error=>errors.push(error))],max_packet_bytes:12288,onError:error=>errors.push(error)});
  const write=process.stderr.write;process.stderr.write=((chunk:string)=>{try{const line=JSON.parse(String(chunk));if(line.terminal_publication_slow)lines.push(line);}catch{}return true;}) as typeof write;
  try {
  const settle=async()=>{for(let n=0;n<20;n++)await new Promise(resolve=>setImmediate(resolve));};
  await bridge.onBootstrapConnected(f.input);await settle();assert.deepEqual(sent.map(body=>body.operation).sort(),['confirmations','ready']);
  const row=(id:string)=>({confirmation_id:id.repeat(64),kind:'voice',expires_in_ms:60000,text:'确认是我'});
  watching=stall=true;await deliver!([row('a')]);await settle();assert.equal(attempts,1);
  await deliver!([row('b')]);await settle();
  t.mock.timers.tick(5001);await settle();
  assert.equal(disconnects,0,`a publication stuck in ${step} must not make the gateway leave a live room`);assert.deepEqual(errors,[]);
  assert.equal(lines.length,1);assert.deepEqual({...lines[0],at:0,bytes:0},{terminal_publication_slow:'confirmations',device:'mac',bytes:0,step,elapsed_ms:5001,at:0});
  if(step==='sdk')assert.ok((lines[0]!.bytes as number)>200);
  t.mock.timers.tick(60000);await settle();assert.equal(attempts,1,'one attempt in flight; none piles up behind it');
  assert.equal(disconnects,0);assert.equal(lines.length,1,'one line per stall');
  gate.resolve();await settle();
  const confirmations=sent.filter(body=>body.operation==='confirmations');
  assert.equal(confirmations.at(-1)!.items![0]!.confirmation_id,'b'.repeat(64),'the newest state follows the settled attempt');
  assert.equal(disconnects,0);assert.deepEqual(errors,[]);assert.equal(lines.length,1);
  } finally {process.stderr.write=write;gate.resolve();await bridge.close();}
  }
});

test('a terminal publication slower than 1 s logs its slowest step once it settles; a fast one logs nothing',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-17T13:03:50.000Z')});
  const f=fixture(),room=testRoom(),lines:Record<string,unknown>[]=[],gate=deferred<void>();let slow=false;
  room.localParticipant.publishData=async bytes=>{if(slow&&JSON.parse(Buffer.from(bytes).toString()).operation==='rejected')await gate.promise;};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:(credential:unknown)=>f.authority.authenticate(credential),cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime,authority:f.authority,max_packet_bytes:12288,onError:()=>{}});
  const write=process.stderr.write;process.stderr.write=((chunk:string)=>{try{const line=JSON.parse(String(chunk));if(line.terminal_publication_slow)lines.push(line);}catch{}return true;}) as typeof write;
  try {
    const settle=async()=>{for(let n=0;n<20;n++)await new Promise(resolve=>setImmediate(resolve));};
    await bridge.onBootstrapConnected(f.input);await settle();assert.equal(lines.length,0,'fast publications log nothing');
    slow=true;
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'no_such_operation'})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await settle();t.mock.timers.tick(2400);gate.resolve();await settle();
    assert.equal(lines.length,1);assert.equal(lines[0]!.terminal_publication_slow,'rejected');assert.equal(lines[0]!.step,'sdk');
    assert.equal(lines[0]!.elapsed_ms,2400);assert.equal(lines[0]!.device,'mac');assert.ok((lines[0]!.bytes as number)>0);
    t.mock.timers.tick(10000);await settle();assert.equal(lines.length,1);
  } finally {process.stderr.write=write;await bridge.close();}
});

test('bootstrap waits for a replacement already present when its original ready flight retires',async t=>{
  const f=fixture(),room=testRoom(),oldEntered=deferred<void>(),newEntered=deferred<void>(),oldSend=deferred<void>(),newSend=deferred<void>();let sends=0,settled=false;
  room.localParticipant.sendText=async()=>{if(++sends===1){oldEntered.resolve();await oldSend.promise;}else{newEntered.resolve();await newSend.promise;}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({device_type:'mac'}),cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime,
    authority:f.authority,max_packet_bytes:12288,onError:error=>assert.fail(String(error))});
  t.after(()=>{oldSend.resolve();newSend.resolve();return bridge.close();});
  const setup=bridge.onBootstrapConnected(f.input).then(()=>{settled=true;});await oldEntered.promise;
  const peer=room.remoteParticipants.get('terminal')!;room.emit(RoomEvent.ParticipantDisconnected,peer);room.emit(RoomEvent.ParticipantConnected,peer);
  await newEntered.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  newSend.resolve();await setup;assert.equal(sends,2);oldSend.resolve();
});

test('the gateway readiness deadline cancels an unresolved initial source authentication',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),room=testRoom(),authentication=deferred<object>(),errors:unknown[]=[];
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:()=>authentication.promise} as unknown as PersonalAIOSRuntime,authority:f.authority,max_packet_bytes:12288,onError:error=>errors.push(error)});
  const setup=bridge.onBootstrapConnected(f.input),rejected=assert.rejects(setup,(error:unknown)=>error instanceof ContractError&&error.code==='REALTIME_READINESS_DEADLINE');
  t.mock.timers.tick(REALTIME_READINESS_DEADLINE_MS);await rejected;
  let closed=false;const closing=bridge.close().then(()=>{closed=true;});await new Promise(setImmediate);assert.equal(closed,false,'close joins admitted source work after the HTTP wait has ended');
  authentication.resolve({});await closing;assert.equal(room.callbacks.size,0);assert.deepEqual(errors,[]);
});
async function movementFixture(t:import('node:test').TestContext,navigation?:Navigation,movement:Pick<ConstructorParameters<typeof Movement>[0],'ride_hr_alert_bpm'|'hrProfile'>={},
  hooks:{create?:()=>Promise<void>;publish?:(packet:any,respond:(body:unknown)=>void)=>Promise<void>;source?:'glasses'}={}) {
  const root=await fs.mkdtemp(join(tmpdir(),'formal-movement-')),sources=new FormalTerminalSources(),storage=new PosixStorage(root);
  let clock=Date.parse(now);const events:any[]=[],spoken:string[]=[],streams:{options:any;bytes:Buffer[]}[]=[],errors:unknown[]=[];
  const nativeRuns=new Map<string,NativeRun>(),nativeKeys=new Map<string,string>();
  const native:NativeClient={create:async(body,key)=>{
      await hooks.create?.();const previous=nativeKeys.get(key);if(previous)return {...nativeRuns.get(previous)!};
      const run={run_id:nativeRuns.size?`movement-followup-${nativeRuns.size}`:'movement-owner',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
      nativeRuns.set(run.run_id,run);nativeKeys.set(key,run.run_id);return {...run};
    },status:async runId=>({...nativeRuns.get(runId)!}),cancel:async runId=>{
      const run=nativeRuns.get(runId)!;run.status='cancelled';return {...run};
    }};
  const admission=new RunAdmission(storage,native,{max_pending_events:16,max_pending_bytes:1e6,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'movement'});
  const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  const tts={synthesize:async(text:string)=>{spoken.push(text);return inspectWav(wav);}};
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,20000),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:20000,
    locations:new DeviceLocations(()=>clock),movement:{now:()=>clock,...movement},...(navigation?{navigation}:{}),
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts})});
  const pendingMoves=new Set<Promise<unknown>>(),move=runtime.move.bind(runtime);
  runtime.move=(...args)=>{
    const work=move(...args);pendingMoves.add(work);
    void work.then(()=>pendingMoves.delete(work),()=>pendingMoves.delete(work));
    return work;
  };
  const waitForMovement=async(kind:string,nav_id:string)=>{
    await eventually(()=>events.some(event=>event.kind===kind&&event.nav_id===nav_id));
    while(pendingMoves.size)await Promise.all([...pendingMoves]);
  };
  const submit=runtime.submit.bind(runtime);runtime.submit=async(...args)=>{if(args[0].media_type==='app_event')events.push(JSON.parse(Buffer.from(args[0].payload).toString('utf8')));return submit(...args);};
  const connect=async(type:'phone'|'glasses',device:string=type,inCall:boolean|(()=>Promise<void>)=false,worn=true)=>{
    const f=fixture(false,{primary:device,watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type,registry:sources},!!inCall,type==='phone'?'continuity':`${device}-continuity`);
    const room=testRoom() as ReturnType<typeof testRoom>&{localParticipant:Record<string,unknown>};
    room.localParticipant.streamBytes=async(options:any)=>{const stream={options,bytes:[] as Buffer[]};streams.push(stream);return {write:async(bytes:Uint8Array)=>{stream.bytes.push(Buffer.from(bytes));},close:async()=>{}};};
    if(hooks.publish){const publish=room.localParticipant.publishData as (bytes:Uint8Array)=>Promise<void>;
      room.localParticipant.publishData=async(bytes:Uint8Array)=>{await hooks.publish!(JSON.parse(Buffer.from(bytes).toString('utf8')),body=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC));await publish(bytes);};}
    room.localParticipant.sendText=async(text:string)=>{
      const body=JSON.parse(text);room.published.push(body);
      await hooks.publish?.(body,value=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(value)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC));
    };
    let call=inCall?'busy-call':undefined;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:12288,voice_transport:'wav_byte_stream_v1',onError:error=>errors.push(error),
      ...(inCall?{voice_call:{open:async()=>{},close:async()=>{if(typeof inCall==='function')await inCall();call=undefined;},respond:async()=>false,pending:()=>call,attach:()=>()=>{}}}:{})});
    await bridge.onBootstrapConnected(f.input);t.after(()=>bridge.close());
    const send=(body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    const out=(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[];
    if(type==='glasses'&&worn){send({operation:'wear_state',control_id:'wear',worn:true});await eventually(()=>out('wear_state_ack').length===1);}
    return {send,out,bridge,room,source:await runtime.authenticate(f.authority.credentialForBootstrap(f.input))};
  };
  const phone=await connect('phone'),glasses=await connect('glasses');
  // Start each movement scenario after the idle bootstrap/wear replay has completed.
  phone.room.published.length=0;glasses.room.published.length=0;
  const requester=hooks.source==='glasses'?glasses:phone,session=hooks.source==='glasses'?'glasses-continuity':'continuity';
  if(hooks.source==='glasses'){
    await runtime.submit({schema_version:'paios.event.v1',event_id:'movement-request',captured_at:now,device_id:'glasses',device_type:'glasses',
      source:{channel:glasses.source.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
      payload:Buffer.from(JSON.stringify({kind:'movement_request',text:'导航去公司'}))},glasses.source,session,false);
    await eventually(()=>!!admission.find('movement-owner',session));
  }else{requester.send({operation:'submit',event_id:'movement-request',captured_at:now,text:'开始骑行，导航去公司'});await eventually(()=>requester.out('accepted').some(p=>p.admission.run_id));}
  const tool=(name:string,args:Record<string,unknown>)=>runtime.tool(name,{context:{run_id:'movement-owner',session_id:session,tool_call_id:crypto.randomUUID()},args}) as Promise<any>;
  t.after(async()=>{await phone.bridge.close();await glasses.bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const frame=(seq:number,extra:Record<string,unknown>)=>({operation:'move_frame',seq,at:new Date(clock).toISOString(),position:{lat:31,lng:121,accuracy_m:5,at:new Date(clock).toISOString()},...extra});
  return {phone,glasses,connect,events,spoken,streams,errors,tool,frame,tts,waitForMovement,advance:(ms:number)=>{clock+=ms;},at:()=>new Date(clock).toISOString()};
}
const rideId='00000000-0000-4000-8000-000000000001',navId='00000000-0000-4000-8000-000000000002';
const rideMetrics={speed_kmh:18,avg_kmh:16,max_kmh:25,distance_m:100,moving_s:20,elapsed_s:30};
const navigationFixture=():Navigation=>({search:async()=>[{name:'公司',address:'滨河路',lat:31.01,lng:121.01}],plan:async(_origin,destination,mode)=>({mode,destination,total_m:1500,total_s:600,
  steps:[{index:0,maneuver:'right',instruction:'前面右转，进滨河路',road:'滨河路',distance_m:500,duration_s:200,polyline:[{lat:30.999,lng:120.999},{lat:31,lng:121}],maneuver_location:{lat:31,lng:121}},
    {index:1,maneuver:'left',instruction:'前面左转',distance_m:1000,duration_s:400,polyline:[{lat:31,lng:121},{lat:31.01,lng:121.01}],maneuver_location:{lat:31.01,lng:121.01}}]})});
for(const scenario of ['navigating','riding','idle'] as const)test(`glasses bootstrap replays ${scenario} without a new frame or wear message`,async t=>{
  const m=await movementFixture(t,navigationFixture());
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const projected=m.glasses.out('move_hud').at(-1).nav;
  const nav={nav_id:route.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  m.phone.send(m.frame(23,{ride_id:rideId,ride:rideMetrics,nav_id:route.nav_id,nav}));
  await eventually(()=>m.glasses.out('move_hud').some(packet=>packet.seq===23));
  const previous=m.glasses.out('move_hud').at(-1);
  await m.glasses.bridge.close();
  if(scenario!=='riding')await m.tool('paios_ride',{action:'stop'});
  if(scenario!=='navigating')await m.tool('paios_navigate',{action:'stop'});
  const start=performance.now(),reconnected=await m.connect('glasses','glasses',false,false);
  await eventually(()=>reconnected.out('move_hud').length===1,3000);
  const elapsed=performance.now()-start,hud=reconnected.out('move_hud')[0];
  assert.ok(elapsed<3000,`bootstrap delivery took ${elapsed} ms`);
  assert.equal(hud.seq,23);assert.equal(hud.kind,scenario==='riding'?'ride':'walk_nav');
  assert.equal(reconnected.out('wear_state_ack').length,0);
  assert.equal(reconnected.out('nav_route').length,scenario==='navigating'?1:0);
  if(scenario==='navigating'){
    assert.equal(hud.nav.nav_id,route.nav_id);assert.deepEqual(hud.nav,projected);
    assert.equal(reconnected.out('nav_route')[0].overview.show,false);
  }else assert.equal(hud.nav,undefined);
  if(scenario==='riding')assert.equal(hud.ride.speed_kmh,rideMetrics.speed_kmh);else assert.equal(hud.ride,undefined);
  t.diagnostic(`bootstrap ${scenario}: ${elapsed.toFixed(1)} ms; no subsequent movement input`);
  if(process.env.MOVEMENT_BOOTSTRAP_FIXTURE_DIR)await fs.writeFile(join(process.env.MOVEMENT_BOOTSTRAP_FIXTURE_DIR,`${scenario}.json`),
    JSON.stringify({server_now:m.at(),previous,packets:reconnected.room.published.filter((packet:any)=>['nav_route','move_hud'].includes(packet.operation))},null,2)+'\n');
  assert.deepEqual(m.errors,[]);
});
test('an admission change during an outstanding state publication is published after it, never dropped',{timeout:15000},async t=>{
  // The durable running transition lands while the second unresolved accepted packet is still being published.
  const native=deferred<void>();let unresolved=0;
  const m=await movementFixture(t,undefined,{},{create:()=>native.promise,publish:async packet=>{
    if(packet.operation==='accepted'&&!packet.admission.run_id&&++unresolved===2){native.resolve();await new Promise(resolve=>setTimeout(resolve,200));}}});
  await eventually(()=>m.phone.out('accepted').at(-1)?.admission.state==='running');
  const accepted=m.phone.out('accepted');
  assert.ok(accepted.filter(p=>!p.admission.run_id).length>=2);
  assert.equal(accepted.at(-1).admission.state,'running');assert.equal(accepted.at(-1).admission.run_id,'movement-owner');
});
test('glasses pay awaits every terminal hangup, fails closed on hangup failure, and returns without payment details',{timeout:15000},async t=>{
  const m=await movementFixture(t),gate=deferred<void>(),entered=deferred<void>(),closed:string[]=[];
  const phone=await m.connect('phone','call-phone',async()=>{entered.resolve();await gate.promise;closed.push('phone');});
  const callGlasses=await m.connect('glasses','call-glasses',async()=>{closed.push('glasses');});
  const opening=m.tool('paios_glasses_pay',{});await entered.promise;assert.equal(m.glasses.out('pay_open').length,0);
  gate.resolve();assert.deepEqual(await opening,{status:'opened'});assert.deepEqual(closed.sort(),['glasses','phone']);
  assert.equal(m.glasses.out('pay_open').length,1);
  const at=m.at();m.glasses.send({operation:'pay_closed',at,outcome:'returned'});await eventually(()=>m.events.some(e=>e.kind==='pay_closed'));
  assert.deepEqual(m.events.find(e=>e.kind==='pay_closed'),{kind:'pay_closed',at,outcome:'returned'});
  m.glasses.send({operation:'pay_closed',at,outcome:'paid',amount:10});phone.send({operation:'pay_closed',at,outcome:'returned'});
  await eventually(()=>m.glasses.out('rejected').some(p=>p.error_code==='FORMAL_PAY_CLOSED_INPUT_INVALID')&&phone.out('rejected').some(p=>p.error_code==='GLASSES_DEVICE_REQUIRED'));
  const failing=await m.connect('phone','failure-phone',async()=>{throw new Error('controlled hangup failure');});
  assert.deepEqual(await m.tool('paios_glasses_pay',{}),{status:'failed',error_code:'GLASSES_PAY_FAILED'});assert.equal(m.glasses.out('pay_open').length,1);
  await failing.bridge.close();await m.glasses.bridge.close();await callGlasses.bridge.close();
  const onlyGlasses=await m.connect('glasses','not-worn');onlyGlasses.send({operation:'wear_state',control_id:'off',worn:false});await eventually(()=>onlyGlasses.out('wear_state_ack').length===2);
  assert.deepEqual(await m.tool('paios_glasses_pay',{}),{status:'failed',error_code:'GLASSES_NOT_CONNECTED'});
  await onlyGlasses.bridge.close();assert.deepEqual(await m.tool('paios_glasses_pay',{}),{status:'failed',error_code:'GLASSES_NOT_CONNECTED'});
});
test('frames without GPS preserve fresh HR and elapsed time and navigation uses the last good location',async t=>{
  const port=navigationFixture(),origins:unknown[]=[],plan=port.plan;port.plan=async(...args)=>{origins.push(args[0]);return plan(...args);};
  const m=await movementFixture(t,port,{hrProfile:async()=>({max_hr_bpm:200})});
  const {speed_kmh,...metrics}=rideMetrics;
  m.phone.send({operation:'move_frame',seq:1,at:m.at(),ride_id:rideId,ride:{...metrics,hr_bpm:120}});
  await eventually(()=>m.glasses.out('move_hud').length===1);assert.equal(m.glasses.out('move_hud')[0].ride.hr_zone,2);
  assert.equal('speed_kmh' in m.glasses.out('move_hud')[0].ride,false);
  m.advance(1000);m.phone.send(m.frame(2,{ride_id:rideId,ride:rideMetrics}));await eventually(()=>m.glasses.out('move_hud').length===2);
  m.advance(110000);m.phone.send({operation:'move_frame',seq:3,at:m.at(),ride_id:rideId,ride:{...metrics,elapsed_s:340,hr_bpm:180}});
  await eventually(()=>m.glasses.out('move_hud').length===3);assert.equal(m.glasses.out('move_hud').at(-1).ride.elapsed_s,340);
  assert.equal(m.glasses.out('move_hud').at(-1).ride.hr_zone,5);assert.equal(m.glasses.out('move_hud').at(-1).ride.hr_alert,false);
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'});assert.deepEqual(origins,[{lat:31,lng:121}]);
  assert.equal(m.phone.out('location_request').length,0);
  m.advance(1000);m.phone.send({operation:'move_frame',seq:4,at:m.at(),nav_id:route.nav_id});
  await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).at===m.at());assert.equal(m.phone.out('rejected').length,0);
  m.advance(1000);m.phone.send({operation:'move_frame',seq:5,at:m.at(),ride_id:rideId,ride:{...metrics,hr_bpm:200}});
  await eventually(()=>m.glasses.out('move_hud').at(-1)?.ride?.hr_alert&&m.events.some(e=>e.kind==='ride_hr_alert'),5000);
});
test('navigation route-too-long provider errors reach Hermes without sending a rejected packet',async t=>{
  const port=navigationFixture();port.plan=async()=>{throw new ContractError('NAVIGATION_ROUTE_TOO_LONG',413);};
  const m=await movementFixture(t,port);m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  assert.deepEqual(await m.tool('paios_navigate',{destination:'公司',mode:'walking'}),{status:'failed',error_code:'NAVIGATION_ROUTE_TOO_LONG',last_fix_age_ms:0,freshness_bound_ms:120000});
  assert.equal(m.phone.out('nav_route').length,0);
});
test('movement relays only fresh frames at 1 Hz, selects HUD kind, and stores ride summaries through Hermes',async t=>{
  const m=await movementFixture(t,navigationFixture()),g2=await m.connect('glasses','glasses-2');
  m.glasses.room.published.length=0;g2.room.published.length=0;
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'started',at:m.at(),started_by:'watch'});await eventually(()=>m.events.length===1);
  m.phone.send(m.frame(1,{ride_id:rideId,ride:rideMetrics}));await eventually(()=>m.glasses.out('move_hud').length===1&&g2.out('move_hud').length===1);
  assert.equal(m.glasses.out('move_hud')[0].kind,'ride');assert.equal('hr_bpm' in m.glasses.out('move_hud')[0].ride,false);
  m.advance(500);m.phone.send(m.frame(2,{ride_id:rideId,ride:{...rideMetrics,distance_m:200}}));await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).metrics.distance_m===200);
  assert.equal(m.glasses.out('move_hud').length,1);
  m.advance(500);m.phone.send(m.frame(3,{ride_id:rideId,ride:{...rideMetrics,distance_m:300}}));await eventually(()=>m.glasses.out('move_hud').length===2);
  m.advance(6000);m.phone.send({...m.frame(4,{ride_id:rideId,ride:{...rideMetrics,distance_m:400}}),at:now});await new Promise(r=>setTimeout(r,30));
  assert.equal(m.glasses.out('move_hud').length,2);assert.equal((await m.tool('paios_ride',{action:'status'})).metrics.distance_m,300);
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'}),progress={nav_id:route.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  m.phone.send(m.frame(4,{ride_id:rideId,ride:rideMetrics,nav_id:route.nav_id,nav:progress}));await eventually(()=>m.glasses.out('move_hud').at(-1)?.kind==='ride_nav');
  const summary={started_at:now,ended_at:m.at(),distance_m:300,moving_s:20,elapsed_s:30,avg_kmh:16,max_kmh:25};
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'ended',at:m.at(),started_by:'phone',summary});await eventually(()=>m.events.length===2&&m.glasses.out('ride_summary').length===1);
  assert.deepEqual(m.events.map(e=>e.kind),['ride_start','ride_end']);assert.deepEqual(m.events[1].summary,summary);
  await m.tool('paios_navigate',{action:'stop'});const walk=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  m.advance(1000);m.phone.send(m.frame(5,{nav_id:walk.nav_id,nav:{...progress,nav_id:walk.nav_id}}));await eventually(()=>m.glasses.out('move_hud').at(-1)?.kind==='walk_nav');
  assert.equal(m.events.length,2);assert.equal(m.errors.length,0);
});
test('ride telemetry and summaries recover without a remembered start; late start cannot reopen an ended ride',async t=>{
  const m=await movementFixture(t);m.phone.send(m.frame(1,{ride_id:rideId,ride:rideMetrics}));await eventually(()=>m.glasses.out('move_hud').length===1);
  assert.equal((await m.tool('paios_ride',{action:'status'})).metrics.distance_m,100);assert.equal(m.events.length,0);
  const summary={started_at:now,ended_at:m.at(),distance_m:100,moving_s:20,elapsed_s:30,avg_kmh:16,max_kmh:25};
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'ended',at:m.at(),started_by:'phone',summary});await eventually(()=>m.events.length===1&&m.glasses.out('ride_summary').length===1);
  assert.deepEqual(m.events[0].summary,summary);
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'started',at:new Date(Date.parse(now)-1000).toISOString(),started_by:'watch'});
  await eventually(()=>m.events.length===2);assert.equal((await m.tool('paios_ride',{action:'status'})).ride.state,'ended');assert.equal(m.errors.length,0);
  const publish=m.glasses.room.localParticipant.publishData;m.glasses.room.localParticipant.publishData=async bytes=>{
    if(JSON.parse(Buffer.from(bytes).toString('utf8')).operation==='ride_summary')throw new Error('controlled glasses transport failure');return publish(bytes);};
  m.phone.send({operation:'ride_state',ride_id:navId,state:'ended',at:m.at(),started_by:'phone',summary});
  await eventually(()=>m.phone.out('rejected').length===1&&m.events.some(e=>e.kind==='ride_end'&&e.ride_id===navId));
  assert.deepEqual(m.events.find(e=>e.ride_id===navId).summary,summary);
});
test('a forgotten navigation plan reports its gap while preserving ride safety and phone stop delivery',async t=>{
  const m=await movementFixture(t),nav={nav_id:navId,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  m.phone.send(m.frame(1,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178},nav_id:navId,nav}));
  await eventually(()=>m.phone.out('rejected').some(p=>p.error_code==='NAVIGATION_PROGRESS_CONFLICT')&&m.events.some(e=>e.kind==='ride_hr_alert'),5000);
  assert.equal(m.glasses.out('move_hud')[0].ride.hr_alert,true);assert.equal(m.glasses.out('move_hud')[0].kind,'ride');
  m.advance(1000);m.phone.send(m.frame(2,{nav_id:navId,nav}));await eventually(()=>m.phone.out('rejected').filter(p=>p.error_code==='NAVIGATION_PROGRESS_CONFLICT').length===2);
  assert.equal(m.glasses.out('move_hud').length,1);m.glasses.send({operation:'nav_control',action:'stop'});
  await eventually(()=>m.phone.out('nav_control').length===1);assert.equal(m.phone.out('nav_control')[0].nav_id,navId);
  m.advance(1000);m.phone.send(m.frame(3,{nav_id:navId,nav}));await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).at===m.at());
  assert.equal(m.glasses.out('move_hud').length,2);
});
test('HR alert is once per 3 minutes per ride and uses receipted formal reply voice outside calls',async t=>{
  const m=await movementFixture(t);m.phone.send({operation:'ride_state',ride_id:rideId,state:'started',at:m.at(),started_by:'phone'});await eventually(()=>m.events.length===1);
  m.phone.send(m.frame(1,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178}}));await eventually(()=>m.streams.length===1&&m.events.length===2,5000);
  const text='心率 178 了，慢一点，喝口水。';assert.equal(m.glasses.out('move_say')[0].text,text);assert.equal(m.glasses.out('move_say')[0].kind,'hr_alert');
  assert.deepEqual(m.spoken,[text]);assert.equal(m.glasses.out('move_hud')[0].ride.hr_alert,true);assert.equal(m.events[1].kind,'ride_hr_alert');assert.equal(m.events[1].hr_bpm,178);
  const envelope=JSON.parse(m.streams[0]!.options.attributes.out),chunk=envelope.chunk;
  assert.equal(envelope.operation,'voice_chunk');assert.equal(chunk.target_device_id,'glasses');assert.equal(m.streams[0]!.options.topic,'paios.central.voice.v1');
  m.glasses.send({operation:'ack',processed_event_id:envelope.processed_event_id,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:1,status:'played',observed_at:m.at()}});
  await eventually(()=>m.glasses.out('ack_receipt').length===1);const headers=m.glasses.out('result_header').length;
  m.glasses.send({operation:'result',processed_event_id:envelope.processed_event_id});await eventually(()=>m.glasses.out('result_header').length>headers);
  assert.equal(m.glasses.out('result_header').at(-1).delivery_status,'played');assert.equal(m.streams.length,1);
  m.advance(179999);m.phone.send(m.frame(2,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178}}));await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).at===m.at());assert.equal(m.glasses.out('move_say').length,1);
  m.advance(1);m.phone.send(m.frame(3,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178}}));await eventually(()=>m.streams.length===2&&m.events.length===3,5000);
  assert.equal(m.glasses.out('move_say').length,2);assert.deepEqual(m.events.map(e=>e.kind),['ride_start','ride_hr_alert','ride_hr_alert']);assert.equal(m.errors.length,0);
});
test('a failed fixed prompt uses the existing explicit voice retry and playback cancellation without a Hermes run',async t=>{
  const m=await movementFixture(t,navigationFixture()),synthesize=m.tts.synthesize;let calls=0;
  m.tts.synthesize=async text=>{if(++calls===1)throw new Error('controlled synthesis failure');return synthesize(text);};
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'started',at:m.at(),started_by:'phone'});await eventually(()=>m.events.length===1);
  m.phone.send(m.frame(1,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178}}));await eventually(()=>m.glasses.out('result_header').some(h=>h.voice_status==='failed'),5000);
  const header=m.glasses.out('result_header').at(-1);assert.equal(header.run_status,'not_applicable');
  m.glasses.send({operation:'retry_voice',control_id:'retry-prompt',processed_event_id:header.processed_event_id});await eventually(()=>m.streams.length===1,5000);
  assert.equal(calls,2);assert.equal(m.events.length,2);
  m.glasses.send({operation:'cancel_playback',control_id:'cancel-prompt',processed_event_id:header.processed_event_id,reply_epoch:header.reply_epoch});
  await eventually(()=>m.glasses.out('control_receipt').some(r=>r.requested_operation==='cancel_playback'));
  const before=m.glasses.out('result_header').length;m.glasses.send({operation:'result',processed_event_id:header.processed_event_id});
  await eventually(()=>m.glasses.out('result_header').length>before);assert.equal(m.glasses.out('result_header').at(-1).reply_phase,'interrupted');assert.equal(m.streams.length,1);
  const busy=await m.connect('glasses','busy-glasses',true),healthy=await m.connect('glasses','healthy-glasses');
  m.advance(180000);m.phone.send(m.frame(2,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178}}));
  await eventually(()=>healthy.out('result_header').some(h=>h.voice_status==='ready')&&m.phone.out('rejected').some(p=>p.error_code==='FORMAL_VOICE_IN_CALL')&&
    m.streams.some(s=>JSON.parse(s.options.attributes.out).chunk.target_device_id==='healthy-glasses'),5000);
  assert.equal(busy.out('result_header').length,0);
  assert.equal(m.events.filter(e=>e.kind==='ride_hr_alert').length,2);
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'});
  m.phone.send({operation:'nav_state',nav_id:route.nav_id,state:'off_route',at:m.at()});
  await eventually(()=>m.phone.out('nav_route').length===2,5000);assert.equal(m.phone.out('nav_route').at(-1).revision,2);
});
test('navigation segment beyond canonical route is rejected before HUD while riding HR safety stays live',async t=>{
  const m=await movementFixture(t,navigationFixture());
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling',lat:31.01,lng:121.01});
  const nav={nav_id:route.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:Number.MAX_SAFE_INTEGER,segment_fraction:0.25};
  m.phone.send(m.frame(1,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178},nav_id:route.nav_id,nav}));
  await eventually(()=>m.phone.out('rejected').some(p=>p.error_code==='NAVIGATION_PROGRESS_CONFLICT')&&m.events.some(e=>e.kind==='ride_hr_alert'),5000);
  const hud=m.glasses.out('move_hud').find(packet=>packet.seq===1);assert.equal(hud.kind,'ride');assert.equal(hud.ride.hr_alert,true);assert.equal(hud.nav,undefined);
  m.advance(1000);m.phone.send(m.frame(2,{nav_id:route.nav_id,nav:{...nav,route_segment_index:0}}));
  await eventually(()=>m.glasses.out('move_hud').at(-1)?.kind==='walk_nav');
  assert.equal(m.glasses.out('move_hud').at(-1).nav.route_segment_index,0);
});
test('navigation map wire preserves route, projected GPS lineage and active revision across glasses reconnect',async t=>{
  const m=await movementFixture(t,navigationFixture());
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const started=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  await eventually(()=>m.glasses.out('nav_route').length===1);
  const phone=m.phone.out('nav_route')[0],route=m.glasses.out('nav_route')[0];
  assert.equal(route.coordinate_system,'wgs84');assert.deepEqual(route.steps,phone.steps);
  assert.deepEqual(route.steps[0].maneuver_location,{lat:31,lng:121});
  const sampled=new Date(Date.parse(m.at())-1000).toISOString(),position={lat:31,lng:121,accuracy_m:5,course_deg:25,at:sampled};
  const nav={nav_id:started.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  m.phone.send(m.frame(23,{nav_id:started.nav_id,position,nav}));await eventually(()=>m.glasses.out('move_hud').some(packet=>packet.seq===23));
  const hud=m.glasses.out('move_hud').find(packet=>packet.seq===23);assert.equal(hud.seq,23);assert.equal(hud.coordinate_system,'wgs84');
  assert.deepEqual(hud.position,position);assert.deepEqual(hud.nav,{...nav,maneuver_location:route.steps[0].maneuver_location});
  m.phone.send({operation:'nav_state',nav_id:started.nav_id,state:'off_route',at:m.at(),position:{lat:31.001,lng:121.001}});
  await eventually(()=>m.glasses.out('nav_route').at(-1)?.revision===2);
  await m.glasses.bridge.close();const reconnected=await m.connect('glasses');t.after(()=>reconnected.bridge.close());
  await eventually(()=>reconnected.out('nav_route').some(packet=>packet.revision===2));
  const replay=reconnected.out('nav_route').at(-1);assert.equal(replay.nav_id,started.nav_id);assert.equal(replay.coordinate_system,'wgs84');
  assert.deepEqual(replay.steps,m.phone.out('nav_route').at(-1).steps);assert.equal(m.errors.length,0);
});
test('navigation switch tool publishes the chosen provider route and a versioned overview without planning again',async t=>{
  const port=navigationFixture(),plan=port.plan;let requests=0;
  port.plan=async(...args)=>{
    requests++;const route=await plan(...args);
    return {...route,alternative:{total_m:1800,total_s:720,steps:route.steps.map(step=>({...step,
      polyline:step.polyline.map(point=>({...point,lng:point.lng+0.001})),maneuver_location:{...step.maneuver_location,lng:step.maneuver_location.lng+0.001}}))}};
  };
  const m=await movementFixture(t,port);
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const started=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const first=m.glasses.out('nav_route').at(-1);
  assert.equal(first.overview.version,1);assert.equal(first.overview.selected,0);assert.equal(first.overview.show,true);
  assert.equal(first.overview.alternatives.length,1);
  const switched=await m.tool('paios_navigate',{action:'switch'});
  assert.equal(switched.status,'switched');assert.equal(switched.nav_id,started.nav_id);assert.equal(switched.revision,2);assert.equal(requests,1);
  const active=m.glasses.out('nav_route').at(-1);
  assert.equal(active.total_m,1800);assert.equal(active.overview.selected,1);assert.equal(active.overview.show,true);
  assert.deepEqual(active.steps,m.phone.out('nav_route').at(-1).steps);
  assert.deepEqual(active.overview.alternatives[0].polyline,first.steps.flatMap((step:any)=>step.polyline));
  assert.equal((await m.tool('paios_ride',{action:'status'})).navigation.revision,2);
  const back=await m.tool('paios_navigate',{action:'switch'});
  assert.equal(back.revision,3);assert.deepEqual(m.glasses.out('nav_route').at(-1).steps,first.steps);
  assert.equal(m.errors.length,0);
});
test('navigation tool refreshes phone location, searches near it, prompts once per crossing and replans by revision',async t=>{
  const port=navigationFixture(),searched:any[]=[],plans:any[]=[];const search=port.search,plan=port.plan;
  port.search=async(query,near)=>{searched.push({query,near});return search(query,near);};port.plan=async(...args)=>{plans.push(args);return plan(...args);};
  const m=await movementFixture(t,port),publish=m.phone.room.localParticipant.publishData as (bytes:Uint8Array)=>Promise<void>;
  m.phone.room.localParticipant.publishData=async(bytes:Uint8Array)=>{await publish(bytes);const body=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(body.operation==='location_request')m.phone.send({operation:'location_update',request_id:body.request_id,location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});};
  const result=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'});assert.deepEqual(searched,[{query:'公司',near:{lat:31,lng:121}}]);
  assert.equal(result.destination,'公司');assert.equal(result.distance_m,1500);assert.equal(result.eta_s,600);assert.equal(m.phone.out('location_request').length,1);
  const progress={nav_id:result.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:250,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  let seq=0;for(const distance of [250,200,199,90,50,49,300,40]){
    m.advance(1000);m.phone.send(m.frame(++seq,{nav_id:result.nav_id,nav:{...progress,distance_to_maneuver_m:distance}}));
    await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).at===m.at());
  }
  await eventually(()=>m.streams.length===2,5000);assert.deepEqual(m.glasses.out('move_say').map(p=>p.text),['前面右转，进滨河路','前面右转，进滨河路']);
  for(const distance of [199,49]){m.advance(1000);m.phone.send(m.frame(++seq,{nav_id:result.nav_id,nav:{...progress,step_index:1,maneuver:'left',route_segment_index:2,distance_to_maneuver_m:distance}}));await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).at===m.at());}
  await eventually(()=>m.streams.length===4,5000);m.phone.send({operation:'nav_state',nav_id:result.nav_id,state:'off_route',at:m.at(),position:{lat:31.001,lng:121.001}});
  await eventually(()=>m.phone.out('nav_route').length===2&&m.glasses.out('move_say').length===5);assert.equal(m.phone.out('nav_route')[1].revision,2);assert.equal(m.phone.out('nav_route')[1].nav_id,result.nav_id);
  assert.deepEqual(plans[1][0],{lat:31.001,lng:121.001});assert.equal(m.glasses.out('move_say').at(-1).text,'走过了，正在重新规划');
  m.phone.send({operation:'nav_state',nav_id:result.nav_id,state:'arrived',at:m.at()});await eventually(async()=>!(await m.tool('paios_ride',{action:'status'})).navigation);
  const next=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});assert.equal(searched.length,1);
  m.glasses.send({operation:'nav_control',action:'stop'});await eventually(()=>m.phone.out('nav_control').length===1);
  assert.equal(m.phone.out('nav_control')[0].nav_id,next.nav_id);assert.equal((await m.tool('paios_ride',{action:'status'})).navigation,undefined);
  m.phone.send({operation:'nav_state',nav_id:next.nav_id,state:'cancelled',at:m.at()});await m.waitForMovement('nav_cancelled',next.nav_id);
  assert.equal(m.phone.out('rejected').length,0);
  const pending=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});await m.phone.bridge.close();
  assert.deepEqual(await m.tool('paios_navigate',{action:'stop'}),{status:'stopped',phone_status:'PHONE_NOT_CONNECTED'});
  const reconnected=await m.connect('phone');await m.tool('paios_navigate',{action:'stop'});
  assert.equal(reconnected.out('nav_control')[0].nav_id,pending.nav_id);
  assert.equal(m.errors.length,0);
});
test('navigation stop invalidates pending place search and route planning',async t=>{
  const port=navigationFixture(),search=deferred<Awaited<ReturnType<Navigation['search']>>>(),entered=deferred<void>();
  port.search=async()=>{entered.resolve();return search.promise;};const m=await movementFixture(t,port);
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  const searching=m.tool('paios_navigate',{destination:'公司',mode:'walking'});await entered.promise;await m.tool('paios_navigate',{action:'stop'});
  search.resolve([{name:'公司',lat:31.01,lng:121.01}]);assert.equal((await searching).error_code,'NAVIGATION_SESSION_CHANGED');assert.equal(m.phone.out('nav_route').length,0);
  const planned=deferred<Awaited<ReturnType<Navigation['plan']>>>(),planningEntered=deferred<void>(),plan=navigationFixture().plan;
  port.plan=async()=>{planningEntered.resolve();return planned.promise;};
  const planning=m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});await planningEntered.promise;
  await m.tool('paios_navigate',{action:'stop'});
  planned.resolve(await plan({lat:31,lng:121},{name:'公司',lat:31.01,lng:121.01},'walking'));
  assert.equal((await planning).error_code,'NAVIGATION_SESSION_CHANGED');assert.equal(m.phone.out('nav_route').length,0);
  port.plan=plan;const old=await m.tool('paios_navigate',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const nextSearch=deferred<Awaited<ReturnType<Navigation['search']>>>(),nextEntered=deferred<void>();port.search=async()=>{nextEntered.resolve();return nextSearch.promise;};
  const next=m.tool('paios_navigate',{destination:'下一站',mode:'walking'});await nextEntered.promise;
  m.phone.send({operation:'nav_state',nav_id:old.nav_id,state:'arrived',at:m.at()});await eventually(async()=>!(await m.tool('paios_ride',{action:'status'})).navigation);
  nextSearch.resolve([{name:'下一站',lat:31.02,lng:121.02}]);assert.equal((await next).destination,'下一站');assert.equal(m.phone.out('nav_route').length,2);
  const active=m.phone.out('nav_route').at(-1);port.search=async()=>{throw new Error('controlled search failure');};
  assert.equal((await m.tool('paios_navigate',{destination:'缺失地点',mode:'walking'})).error_code,'NAVIGATION_PROVIDER_FAILED');
  m.phone.send({operation:'nav_state',nav_id:active.nav_id,state:'off_route',at:m.at(),position:{lat:31,lng:121}});
  await eventually(()=>m.phone.out('nav_route').length===3);assert.equal(m.phone.out('nav_route').at(-1).revision,active.revision+1);
});
test('a route revision in flight cannot suppress riding HR safety',async t=>{
  const port=navigationFixture(),plan=port.plan,replanned=deferred<Awaited<ReturnType<Navigation['plan']>>>(),entered=deferred<void>();let calls=0;
  port.plan=async(...args)=>{if(++calls===2){entered.resolve();return replanned.promise;}return plan(...args);};const m=await movementFixture(t,port);
  m.phone.send({operation:'ride_state',ride_id:rideId,state:'started',at:m.at(),started_by:'phone'});await eventually(()=>m.events.length===1);
  m.phone.send(m.frame(1,{ride_id:rideId,ride:rideMetrics}));await eventually(()=>m.glasses.out('move_hud').length===1);
  const route=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'}),progress={nav_id:route.nav_id,revision:1,step_index:0,maneuver:'right',distance_to_maneuver_m:300,remaining_m:1000,remaining_s:400,route_segment_index:0,segment_fraction:0.25};
  m.phone.send({operation:'nav_state',nav_id:route.nav_id,state:'off_route',at:m.at()});await entered.promise;
  m.advance(1000);m.phone.send(m.frame(2,{ride_id:rideId,ride:{...rideMetrics,hr_bpm:178},nav_id:route.nav_id,nav:progress}));
  await eventually(()=>m.glasses.out('move_hud').at(-1)?.ride?.hr_alert===true&&m.events.some(e=>e.kind==='ride_hr_alert'));
  assert.equal(m.glasses.out('move_hud').at(-1).kind,'ride');assert.equal(m.errors.length,0);
  replanned.resolve(await plan({lat:31,lng:121},{name:'公司',lat:31.01,lng:121.01},'bicycling'));await eventually(()=>m.phone.out('nav_route').length===2);
});
test('movement rejects wrong terminals, malformed phone metrics, missing phones and unconfigured navigation',async t=>{
  const m=await movementFixture(t),wrong=[{operation:'ride_state',ride_id:rideId,state:'started',at:m.at(),started_by:'phone'},
    m.frame(1,{ride_id:rideId,ride:rideMetrics}),{operation:'nav_state',nav_id:navId,state:'cancelled',at:m.at()}];
  for(const body of wrong)m.glasses.send(body);m.phone.send({operation:'ride_control',action:'start'});m.phone.send({operation:'nav_control',action:'stop'});
  await eventually(()=>m.errors.length===5);assert.ok([...m.glasses.out('rejected'),...m.phone.out('rejected')].every(p=>p.error_code==='MOVEMENT_DEVICE_REQUIRED'));
  for(const invalid of [{hr_zone:4},{hr_bpm:261},{cadence_source:'invented'}])m.phone.send(m.frame(1,{ride_id:rideId,ride:{...rideMetrics,...invalid}}));
  await eventually(()=>m.phone.out('rejected').length===5);assert.ok(m.phone.out('rejected').slice(-3).every(p=>p.error_code==='FORMAL_MOVE_FRAME_INPUT_INVALID'));
  assert.equal((await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'})).error_code,'NAVIGATION_NOT_CONFIGURED');
  await m.tool('paios_ride',{action:'start'});assert.deepEqual(m.phone.out('ride_control').at(-1).requested_by,'voice');
  m.glasses.send({operation:'ride_control',action:'stop'});await eventually(()=>m.phone.out('ride_control').length===2);assert.equal(m.phone.out('ride_control').at(-1).requested_by,'glasses');
  await m.phone.bridge.close();m.glasses.send({operation:'ride_control',action:'start'});m.glasses.send({operation:'nav_control',action:'stop'});
  await eventually(async()=>(await m.tool('paios_ride',{action:'status'})).ride_mode===false);
  assert.equal(m.glasses.out('rejected').length,3);assert.equal(m.events.length,0);
  assert.equal(m.glasses.out('move_hud').at(-1).kind,'walk_nav');
});
test('slow old auth cannot attach after new bootstrap; late old disconnect cannot detach current room',async()=>{
  const f=fixture(),old=testRoom(),next=testRoom(),auth=deferred<void>();let calls=0;
  const participant={roomPort:old},runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(++calls===1)await auth.promise;return {};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:participant as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:()=>{}});
  const pending=assert.rejects(bridge.onBootstrapConnected(f.input),/FORMAL_TEXT_CONNECTION_CHANGED/);participant.roomPort=next;await bridge.onBootstrapConnected(f.input);await pending;auth.resolve();
  assert.equal(old.callbacks.get(RoomEvent.DataReceived)?.size??0,0);assert.equal(next.callbacks.get(RoomEvent.DataReceived)?.size,1);
  // Capture an already attached old listener, then deliver its delayed disconnected callback after replacement.
  participant.roomPort=old;await bridge.onBootstrapConnected(f.input);const late=[...old.callbacks.get(RoomEvent.Disconnected)!][0]!;
  participant.roomPort=next;await bridge.onBootstrapConnected(f.input);late();assert.equal(next.callbacks.get(RoomEvent.DataReceived)?.size,1);
  await bridge.close();assert.equal(next.callbacks.get(RoomEvent.DataReceived)?.size,0);
});
test('close-before-auth completion invalidates pending bootstrap',async()=>{
  const f=fixture(),room=testRoom(),auth=deferred<void>();
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{await auth.promise;return {};}} as unknown as PersonalAIOSRuntime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:()=>{}});
  const pending=assert.rejects(bridge.onBootstrapConnected(f.input),/FORMAL_TEXT_CONNECTION_CHANGED/),closing=bridge.close();
  await pending;auth.resolve();await closing;
  assert.equal(room.callbacks.get(RoomEvent.DataReceived)?.size??0,0);assert.equal(room.published.length,0);
});
test('old submitted D completion cannot publish after bootstrap replacement or rerun Agent',async()=>{
  const f=fixture(),old=testRoom(),next=testRoom(),submitted=deferred<any>(),errors:unknown[]=[];let submissions=0;
  const participant={roomPort:old},source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchVoiceConfirmations:async()=>()=>{},watchAmbientTurns:async()=>()=>{},subscribeResult:async()=>()=>{},authenticate:async()=>source,locate:async()=>undefined,submit:async()=>{submissions++;return submitted.promise;}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:participant as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);old.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'old',captured_at:now,text:'original'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>submissions===1);
  participant.roomPort=next;await bridge.onBootstrapConnected(f.input);submitted.resolve({processed_event:{event_id:'old',processed_event_id:'D-old'},
    admission:{state:'accepted',run_id:'original-run',idempotency_key:'original-key'}});await eventually(()=>errors.length===1);
  assert.match(String(errors[0]),/CONNECTION_CHANGED/);assert.equal(old.published.length,0);assert.equal(next.published.length,0);assert.equal(submissions,1);await bridge.close();
});
for(const stage of ['presence','queue','authorize','sdk'] as const)test(`movement and location publication bound total ${stage} wait and retire expired work`,async t=>{
  const f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:new FormalTerminalSources()}),room=testRoom();
  const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input)),blocked=deferred<void>(),entered=deferred<void>(),errors:unknown[]=[];
  let stalled=false,controls!: {move:(body:Record<string,unknown>)=>Promise<void>;locate:()=>Promise<void>};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},cameraReady:async()=>{},movementReady:async()=>{},
    watchCare:async(...args:any[])=>{controls=args[7];return()=>{};},watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    authenticate:async()=>{if(stalled&&stage==='authorize'){entered.resolve();await blocked.promise;}return source;}} as unknown as PersonalAIOSRuntime;
  const publish=room.localParticipant.publishData;
  room.localParticipant.publishData=async bytes=>{if(stalled&&stage==='sdk'){entered.resolve();await blocked.promise;}await publish(bytes);};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:12288,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);stalled=true;
  if(stage==='presence'||stage==='queue')room.emit(RoomEvent.Reconnecting);
  t.mock.timers.enable({apis:['setTimeout']});
  const move=controls.move({operation:'ride_control',action:'start',requested_by:'voice'});
  const failed=assert.rejects(move,(error:unknown)=>error instanceof ContractError&&error.code==='PHONE_NOT_CONNECTED');
  const queued=stage==='queue'?controls.locate():undefined;
  if(stage==='authorize'||stage==='sdk')await entered.promise;
  await new Promise(setImmediate);t.mock.timers.tick(4000);await failed;
  const location=queued??controls.locate();await new Promise(setImmediate);t.mock.timers.tick(queued?7000:11_000);await location;
  // The SDK cannot recall a packet already submitted. Authorization/presence must never submit it after expiry.
  stalled=false;blocked.resolve();if(stage==='presence'||stage==='queue')room.emit(RoomEvent.Reconnected);
  await new Promise(setImmediate);await new Promise(setImmediate);
  const sent=room.published as {operation:string}[];
  assert.equal(sent.filter(body=>body.operation==='ride_control').length,stage==='sdk'?1:0);
  assert.equal(sent.filter(body=>body.operation==='location_request').length,stage==='sdk'?1:0);
  assert.deepEqual(errors,[]);
});

test('an attached connection that is not the active terminal still carries a finished errand to the main agent',async ()=>{
  const f=fixture(false,{primary:'mac',watch:'watch-source',client:'watch-client'},['text'],{type:'mac',registry:new FormalTerminalSources()}),room=testRoom(),errors:unknown[]=[],submitted:any[]=[];
  const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
  let errands:{deliver:(result:any)=>Promise<boolean>}|undefined;
  // The phone is active while the Mac that originated the request stays attached.
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>false,cameraReady:async()=>{},movementReady:async()=>{},
    watchCare:async(...args:any[])=>{errands=args[5];return()=>{};},watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},authenticate:async()=>source,
    submitErrand:async(raw:any)=>{submitted.push(raw);return {processed_event:{processed_event_id:'D-errand'},admission:{session_id:'continuity',state:'pending'}};},
    subscribeResult:async(...args:any[])=>{if(expired)args[4](new ContractError('RUN_NOT_ACCEPTED',409));return()=>{};}} as unknown as PersonalAIOSRuntime;
  let expired=false;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:{} as never,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);
  await eventually(()=>!!errands);
  const result={principal_id:'actual-owner',job_id:'job-b2d392414a03',task:'查香辣蟹',success:false,answer:'APP_LOGIN_REQUIRED: 千问',finished_at:now};
  assert.equal(await errands!.deliver(result),true);
  assert.deepEqual(submitted.map(raw=>[raw.event_id,JSON.parse(raw.payload.toString()).kind]),[['errand:job-b2d392414a03','errand_result']]);
  assert.deepEqual(errors,[]);
  // Its D ended without a run: a definitive rejection reaches the spool as a throw (logged there once), not a silent false.
  expired=true;
  await assert.rejects(errands!.deliver(result),/RUN_NOT_ACCEPTED/);
  assert.deepEqual(errors,[]);
  await bridge.close();
});

test('a formal errand subscription surfaces a concrete report failure to its spool caller',async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[];let deliver!:(result:any)=>Promise<boolean>;
  const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
  const failure=new ContractError('FORMAL_TEXT_OUTPUT_INVALID',400);
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>source,
    cameraReady:async()=>{},movementReady:async()=>{},watchAmbientTurns:async()=>()=>{},
    watchCare:async(...args:any[])=>{deliver=args[5].deliver;return()=>{};},
    submitErrand:async()=>({processed_event:{processed_event_id:'D-errand'},admission:{session_id:'continuity'}}),
    subscribeResult:async(...args:any[])=>{args[4](failure);return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:{cancel:async()=>false},onError:error=>errors.push(error)});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  await assert.rejects(deliver({principal_id:'actual-owner',job_id:'job-000000000003',task:'只读查看',success:true,answer:'已查看',finished_at:now}),error=>error===failure);
  assert.deepEqual(errors,[],'the spool logs and persists the cause once');
});

test('phone location rides on submitted events while fresh; loss and bounded one-shot use the same authority',async t=>{
  const f=fixture(false,{primary:'phone',watch:'watch-source',client:'watch-client'},['text'],{type:'phone',registry:new FormalTerminalSources()}),room=testRoom(),raws:any[]=[],errors:unknown[]=[],places=new DeviceLocations(()=>Date.now());
  const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
  // The runtime's per-device authority (runtime.locate), as the formal connection reads and feeds it.
  let refresh:(()=>Promise<void>)|undefined;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(...args:any[])=>{refresh=args[7].locate;return()=>{};},watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},subscribeResult:async()=>()=>{},authenticate:async()=>source,submit:async(raw:any)=>{raws.push(raw);
    return {processed_event:{event_id:raw.event_id,processed_event_id:'D-'+raw.event_id},admission:{state:'accepted',run_id:'run',idempotency_key:'key-'+raw.event_id}};},
    locate:async(device:any,sent?:any,_follow?:boolean,reason?:string,cachedAge?:number|null)=>{if(sent!==undefined)places.observe(device.principal_id,device.device_id,sent,reason,cachedAge);return places.fresh(device.principal_id,device.device_id);}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const location={latitude:31.239700,longitude:121.49980,accuracy_m:35,observed_at:new Date().toISOString(),datum:'wgs84',place:'上海市陆家嘴（公开地标）'};
  send({operation:'submit',event_id:'with-fix',captured_at:now,text:'帮我点杯奶茶',location});await eventually(()=>raws.length===1);
  assert.deepEqual(raws[0].source.location,location);
  send({operation:'submit',event_id:'reuse-fix',captured_at:now,text:'少糖少冰'});await eventually(()=>raws.length===2);
  assert.deepEqual(raws[1].source.location,location);
  send({operation:'submit',event_id:'bad-fix',captured_at:now,text:'x',location:{...location,latitude:91}});await eventually(()=>errors.length===1);
  assert.equal(raws.length,2);assert.match(String(errors[0]),/FORMAL_TEXT_SUBMIT_INVALID/);
  // 随身模式 location updates feed the same authority: the newest fix wins, a stale one is never used, a bad one is refused.
  const moved={...location,latitude:30.25,observed_at:new Date().toISOString(),place:'杭州市西湖区'};
  send({operation:'location_update',location:moved});
  await eventually(async()=>(await runtime.locate(source))?.latitude===30.25);
  send({operation:'submit',event_id:'after-update',captured_at:now,text:'附近有什么好吃的'});await eventually(()=>raws.length===3);
  assert.deepEqual(raws[2].source.location,moved);
  send({operation:'location_update',location:{...location,latitude:-91}});await eventually(()=>errors.length===2&&room.published.filter((packet:any)=>packet.operation==='rejected').length===2);
  assert.match(String(errors[1]),/FORMAL_LOCATION_INPUT_INVALID/);
  assert.deepEqual(room.published.filter((packet:any)=>packet.operation==='rejected').map((packet:any)=>packet.request_operation),['submit','location_update']);
  assert.throws(()=>bindRawSource({schema_version:'paios.event.v1',event_id:'e',device_id:source.device_id,device_type:source.device_type,
    source:{channel:source.channel,location:{...location,datum:'gcj02'}} as never,media_type:'text',mime:'text/plain',representation:'uploaded_original',
    payload:Buffer.from('x')},{...source,submission:'explicit_text'},now),/INVALID_CAPTURE_LOCATION/);
  send({operation:'location_update',location:null});
  await eventually(async()=>(await runtime.locate(source))===undefined);
  send({operation:'location_update',location:moved}); // a delayed heartbeat cannot revive the lost provider
  send({operation:'submit',event_id:'lost-fix',captured_at:now,text:'我现在在哪'});await eventually(()=>raws.length===4);
  assert.equal(raws[3].source.location,undefined);
  assert.deepEqual(places.lastKnown(source.principal_id,source.device_id),moved);
  // A lost fix keeps the phone's own reason; only the wire's reason values are accepted.
  send({operation:'location_update',location:null,unavailable_reason:'permission_denied'});
  await eventually(()=>places.unavailableReason(source.principal_id,source.device_id)==='permission_denied');
  send({operation:'location_update',location:null,unavailable_reason:'bogus'});await eventually(()=>errors.length===3);
  assert.match(String(errors[2]),/FORMAL_LOCATION_INPUT_INVALID/);
  assert.equal(places.unavailableReason(source.principal_id,source.device_id),'permission_denied');
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()+1000});
  const requested=refresh!();await new Promise(setImmediate);
  const packet=room.published.at(-1) as any;assert.equal(packet.operation,'location_request');
  const fresh={...moved,observed_at:new Date().toISOString()};
  send({operation:'location_update',request_id:packet.request_id,location:fresh});await requested;
  assert.deepEqual(await runtime.locate(source),fresh);
  const unavailable=refresh!();await new Promise(setImmediate);
  const missing=room.published.at(-1) as any;
  send({operation:'location_update',request_id:missing.request_id,location:null,unavailable_reason:'reduced_accuracy',cached_fix_age_ms:0});await unavailable;
  assert.equal(places.unavailableReason(source.principal_id,source.device_id),'reduced_accuracy');
  assert.equal(places.age(source.principal_id,source.device_id),0);
  let finished=false;const timed=refresh!().then(()=>{finished=true;});await new Promise(setImmediate);
  t.mock.timers.tick(10_000);await new Promise(setImmediate);assert.equal(finished,false,'the phone has time to publish its timeout reason');
  t.mock.timers.tick(1_000);await timed;
  const disconnected=refresh!();await new Promise(setImmediate);
  await bridge.close();
  await disconnected;
});
test('oversize result header fails before SDK publish without fabricating a truncated RESULT',async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],refs=Array.from({length:100},(_,i)=>`l3:${i}:`+'a'.repeat(500));
  const result={event_id:'event',processed_event_id:'D',session_id:'continuity',run_id:'run',reply_id:null,reply_epoch:1,reply_mode:'none',
    reply_phase:'sealed',run_status:'completed',reply_status:'none',result_status:'completed',delivery_status:'unknown',output_plan:[],
    receipt_refs:refs,receipt_sources:[],receipt_status:'complete',receipt_error:null,voice_status:'none',voice_error:null,consumed_revision:1,result_revision:1};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,result:async(_source:unknown,_session:unknown,_d:unknown,options:any)=>({result,chunks:[],voice_chunks:[],pending_voice_chunk_count:0,text_replay:options?.text_replay??'pending',text_chunk_count:0,pending_text_chunk_count:0,rendered_text_through_seq:0})} as unknown as PersonalAIOSRuntime,
    authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'result',processed_event_id:'D'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>errors.length===1);
  assert.match(String(errors[0]),/OUTPUT_PACKET_TOO_LARGE/);assert.equal(room.published.length,1);assert.equal((room.published[0] as any).operation,'rejected');assert.equal((room.published[0] as any).error_code,'FORMAL_TEXT_OUTPUT_PACKET_TOO_LARGE');assert.equal(result.receipt_refs.length,100);assert.equal(result.reply_mode,'none');await bridge.close();
});
for(const failed of [false,true])test(`${failed?'turn-limit notice':'none'} emits honest header and zero text/voice transport packets`,async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[];
  const result={event_id:'event',processed_event_id:'D',session_id:'continuity',run_id:'run',reply_id:null,reply_epoch:1,reply_mode:'none',
    reply_phase:'sealed',run_status:'completed',reply_status:'none',result_status:'completed',delivery_status:'unknown',output_plan:[],
    receipt_refs:[],receipt_sources:[],receipt_status:'complete',receipt_error:null,voice_status:'none',voice_error:null,consumed_revision:1,result_revision:1};
  if(failed)Object.assign(result,{reply_phase:'failed',run_status:'failed',reply_status:'failed',result_status:'failed',failure_notice:'依米这次用完了步骤，还没来得及给出完整回复。'});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,result:async(_source:unknown,_session:unknown,_d:unknown,options:any)=>({result,chunks:[],voice_chunks:[],pending_voice_chunk_count:0,text_replay:options?.text_replay??'pending',text_chunk_count:0,pending_text_chunk_count:0,rendered_text_through_seq:0})} as unknown as PersonalAIOSRuntime,
    authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'result',processed_event_id:'D',text_replay:'sealed'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>room.published.length===1);
  const header=room.published[0] as any;assert.equal(header.operation,'result_header');assert.equal(header.reply_mode,'none');
  assert.equal(header.pending_text_chunk_count,0);assert.equal(header.pending_voice_chunk_count,0);assert.equal(header.voice_transport,'not_supported');
  assert.equal('reply_text' in header,false);assert.equal(errors.length,0);
  if(failed)assert.equal(header.failure_notice,(result as typeof result & {failure_notice:string}).failure_notice);
  if(!failed&&process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT){const path=process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT;
    const fixture=JSON.parse(await fs.readFile(path,'utf8'));fixture.none_header=header;fixture.none_sealed_replay={request:{operation:'result',processed_event_id:'D',text_replay:'sealed'},header,text_chunks:[],evidence:'transport stub only; durable none independently tested'};fixture.none_evidence='transport unit stub, no durable OUT none claim';
    await fs.writeFile(path,JSON.stringify(fixture,null,2)+'\n');}await bridge.close();
});
test('a spoken reply from a real 24 kHz WAV (not a whole number of ms) streams as one voice_chunk the contract accepts',async()=>{
  for(const phase of ['normal','opening','write','close']){
  // A fractional-millisecond voice duration must remain valid after the header (duration_ms 3208.33).
  const f=fixture(),room=testRoom() as ReturnType<typeof testRoom>&{localParticipant:Record<string,unknown>},errors:unknown[]=[],streams:any[]=[];
  const entered=deferred<void>(),late=deferred<void>();let readies=0;
  room.localParticipant.sendText=async()=>{readies++;if(readies===2)assert.ok(streams.at(-1).closed,'the replacement READY follows the complete voice output unit');};
  room.localParticipant.streamBytes=async(options:any)=>{const first=streams.length===0,stream={options,bytes:[] as Buffer[],closed:false,closes:0};streams.push(stream);
    const hold=async(boundary:string)=>{if(first&&phase===boundary){entered.resolve();await late.promise;}};await hold('opening');
    return {write:async(bytes:Uint8Array)=>{await hold('write');stream.bytes.push(Buffer.from(bytes));},close:async()=>{stream.closes++;await hold('close');stream.closed=true;}};};
  const samples=77_000,data=samples*2,wav=Buffer.alloc(44+data);
  wav.write('RIFF',0,'ascii');wav.writeUInt32LE(36+data,4);wav.write('WAVE',8,'ascii');wav.write('fmt ',12,'ascii');wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write('data',36,'ascii');wav.writeUInt32LE(data,40);
  const audio=inspectWav(wav);
  const result={event_id:'event',processed_event_id:'D',session_id:'continuity',run_id:'run',reply_id:'reply',reply_epoch:1,reply_mode:'voice',
    reply_phase:'sealed',run_status:'completed',reply_status:'complete',result_status:'completed',delivery_status:'unknown',output_plan:[],
    receipt_refs:[],receipt_sources:[],receipt_status:'complete',receipt_error:null,voice_status:'ready',voice_error:null,consumed_revision:1,result_revision:1};
  const chunk={output_id:'voice:out',reply_id:'reply',reply_epoch:1,target_device_id:'mac',route_version:'route-1',seq:1,codec:audio.codec,
    sample_rate:audio.sample_rate,channels:audio.channels,audio:{ref:'audio:a',sha256:audio.sha256,mime:audio.mime,bytes:audio.bytes.length,
      duration_ms:audio.duration_ms},text_range:{start:0,end:12},final:true as const};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,voice_transport:'wav_byte_stream_v1',
    runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,audio:async()=>audio,result:async()=>({result,chunks:[],voice_chunks:[chunk],pending_voice_chunk_count:1,text_replay:'pending',
      text_chunk_count:0,pending_text_chunk_count:0,rendered_text_through_seq:0})} as unknown as PersonalAIOSRuntime,
    authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'result',processed_event_id:'D'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  if(phase!=='normal'){
    await entered.promise;const peer=room.remoteParticipants.get('terminal')!;
    room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
    await eventually(()=>readies===2);assert.equal(streams.length,2);late.resolve();await eventually(()=>streams[0].closed);
    assert.equal(streams[0].closes,1,'an acquired or late writer is retired exactly once');
  }else await eventually(()=>streams.some(stream=>stream.closed)||errors.length>0);
  assert.deepEqual(errors,[]);assert.equal(audio.duration_ms,3208);
  assert.deepEqual(room.published.map((packet:any)=>packet.operation),Array(phase==='normal'?1:2).fill('result_header'));
  const envelope=JSON.parse(streams.at(-1)!.options.attributes.out);assert.equal(envelope.operation,'voice_chunk');assert.equal(envelope.chunk.audio.duration_ms,3208);
  assert.deepEqual(Buffer.concat(streams.at(-1)!.bytes),wav);await bridge.close();
  }
});
test('close joins dispatched auth/storage/result/ACK handler gates and refuses all future bootstrap',async()=>{
  for(const phase of ['auth','storage','result','ack']) {
    const f=fixture(),room=testRoom(),entered=deferred<void>(),release=deferred<void>(),exited=deferred<void>(),errors:unknown[]=[];
    let armed=false,operations=0;
    const operation=async()=>{operations++;entered.resolve();await release.promise;exited.resolve();return {};};
    const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},subscribeResult:async()=>()=>{},locate:async()=>undefined,authenticate:async()=>{if(phase==='auth' && armed){entered.resolve();await release.promise;exited.resolve();}return inertMacSource;},
      submit:async()=>{await operation();return {processed_event:{event_id:'original',processed_event_id:'D-original'},admission:{state:'accepted',run_id:'run-original',idempotency_key:'key-original'}};},
      result:async()=>{await operation();return {result:{},chunks:[],voice_chunks:[]};},acknowledge:operation} as unknown as PersonalAIOSRuntime;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
    await bridge.onBootstrapConnected(f.input);armed=true;const body=phase==='ack'?{operation:'ack',processed_event_id:'D-original',ack:{output_id:'output:original',reply_id:'reply-original',reply_epoch:1,target_device_id:'mac',route_version:'route-1',highest_contiguous_seq:1,status:'rendered',observed_at:now}}:
      phase==='result'?{operation:'result',processed_event_id:'D-original'}:{operation:'submit',event_id:'original',captured_at:now,text:'original'};
    const captured=[...room.callbacks.get(RoomEvent.DataReceived)!][0]!;
    captured(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await entered.promise;
    const closing=bridge.close();assert.equal(bridge.close(),closing);let drained=false;void closing.then(()=>{drained=true;});
    await Promise.resolve();assert.equal(drained,false);assert.equal(room.callbacks.get(RoomEvent.DataReceived)?.size,0);
    await assert.rejects(bridge.onBootstrapConnected(f.input),/INGRESS_CLOSED/);
    captured(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    release.resolve();await exited.promise;await closing;assert.equal(drained,true);assert.equal(room.published.length,0);
    assert.equal(operations,phase==='auth'?0:1);assert.equal(errors.length,1);assert.match(String(errors[0]),/CONNECTION_CHANGED/);
  }
});
test('close waits actual POSIX archive and OUT ACK journal writes before host may release storage',async t=>{
  for(const phase of ['objects','output-journal']) {
    const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-formal-drain-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const disk=new PosixStorage(root),entered=deferred<void>(),release=deferred<void>(),nativeCreated=deferred<void>(),nativeObserved=deferred<void>();let armed=phase==='objects';
    const storage={read:disk.read.bind(disk),list:disk.list.bind(disk),removePending:disk.removePending.bind(disk),
      publish:async(namespace:string,key:string,bytes:Uint8Array)=>{if(armed && namespace===phase){armed=false;entered.resolve();await release.promise;}return disk.publish(namespace,key,bytes);}};
    const run:NativeRun={run_id:'drain-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'};
    const native:NativeClient={create:async()=>{nativeCreated.resolve();return run;},status:async()=>{nativeObserved.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
    const archive=new RawArchive(storage,8192),admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
      poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'drain-test'});
    const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),
      sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
    const room=testRoom(),errors:unknown[]=[],bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
    await bridge.onBootstrapConnected(f.input);let body:unknown={operation:'submit',event_id:'drain',captured_at:now,text:'actual gated original'};
    let dId:string|undefined,ack:any;
    if(phase==='output-journal') {
      const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
      const submitted=await runtime.submit({schema_version:'paios.event.v1',event_id:'drain',device_id:'mac',device_type:'mac',captured_at:now,
        source:{channel:'rtc_typed_text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('actual ACK input')},source,'continuity',true);
      dId=submitted.processed_event.processed_event_id;await nativeCreated.promise;await nativeObserved.promise;
      await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'drain-reply'},args:{reply_mode:'text'}});
      run.status='completed';run.output='actual sealed OUT';const reply=await runtime.result(source,'continuity',dId),chunk=reply.chunks[0]!;
      ack={output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:'mac',route_version:chunk.route_version,
        highest_contiguous_seq:1,status:'rendered',observed_at:now};armed=true;body={operation:'ack',processed_event_id:dId,ack};
    }
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await entered.promise;
    const closing=bridge.close();let drained=false;void closing.then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    release.resolve();await closing;assert.equal(drained,true);assert.equal(room.published.length,0);assert.match(String(errors[0]),/CONNECTION_CHANGED/);
    if(phase==='objects')assert.equal((await disk.list('objects')).length,1);
    else {const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
      assert.equal((await runtime.result(source,'continuity',dId!)).result.delivery_status,'rendered');
      const replay=await runtime.acknowledge(source,'continuity',dId!,ack);assert.match(replay.receipt_ref,/^out-ack:/);}
  }
});

test('runtime close joins detached subscriber storage reads while leaving blocked transport unjoined',async t=>{
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-subscriber-drain-')),disk=new PosixStorage(root);
  const gates:{release:()=>void}[]=[],available: (()=>void)[]=[],releases:(()=>void)[]=[];let armed=false;
  const storage={publish:disk.publish.bind(disk),list:disk.list.bind(disk),removePending:disk.removePending.bind(disk),
    read:async(namespace:string,key:string)=>{
      if(armed && namespace==='session-owners'){
        const release=deferred<void>();releases.push(release.resolve);gates.push({release:release.resolve});
        available.shift()?.();await release.promise;
      }
      return disk.read(namespace,key);
    }};
  const next=async()=>{if(!gates.length)await new Promise<void>(resolve=>available.push(resolve));return gates.shift()!;};
  const run:NativeRun={run_id:'subscriber-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'};
  const native:NativeClient={create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'subscriber-drain'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});
  t.after(async()=>{armed=false;for(const release of releases)release();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  const submitted=await runtime.submit({schema_version:'paios.event.v1',event_id:'subscriber-drain',device_id:'mac',device_type:'mac',captured_at:now,
    source:{channel:'rtc_typed_text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('subscriber original')},source,'continuity',true);
  await eventually(()=>Boolean(admission.get('actual-owner','continuity',submitted.processed_event.processed_event_id)?.run_id));
  const transportEntered=deferred<void>();
  await runtime.subscribeResult(source,'continuity',submitted.processed_event.processed_event_id,async()=>{},()=>{},
    {on_admission:async()=>{transportEntered.resolve();await new Promise<void>(()=>{});}});await transportEntered.promise;
  armed=true;const held: Awaited<ReturnType<typeof next>>[]=[],subscribing:Promise<unknown>[]=[];
  for(let i=0;i<2;i++){
    subscribing.push(runtime.subscribeResult(source,'continuity',submitted.processed_event.processed_event_id,async()=>{},()=>{},
      {on_admission:async()=>new Promise<void>(()=>{})}));
    // Initial lookup finishes; publication revalidation and result inspection remain owned independently.
    (await next()).release();(await next()).release();held.push(await next());
  }
  let closed=false;const closing=runtime.close().then(()=>{closed=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);
  armed=false;for(const gate of held)gate.release();await closing;assert.equal(closed,true);
  await Promise.all(subscribing);
});

test('formal foreground queue admits once, restarts in order and automatically publishes each reply',async t=>{
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-formal-queue-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),runs=new Map<string,NativeRun>(),keys=new Map<string,string>();
  const created:string[]=[],errors:unknown[]=[];
  const native:NativeClient={create:async(body,key)=>{
    const previous=keys.get(key);if(previous)return {...runs.get(previous)!};
    const d=JSON.parse(body.input),run:NativeRun={run_id:`queue-${created.length+1}`,session_id:body.session_id,
      conversation_session_id:body.session_id,status:'running',output:`reply ${d.event_id}`};
    created.push(d.event_id);runs.set(run.run_id,run);keys.set(key,run.run_id);return {...run};
  },status:async run=>({...runs.get(run)!}),cancel:async run=>({...runs.get(run)!})};
  const boot=async()=>{
    const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
      poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'queue-test'});
    const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,
      output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,
      skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
    const room=testRoom(),bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
    t.after(async()=>{await bridge.close();await runtime.close();});await admission.recover();await bridge.onBootstrapConnected(f.input);
    const send=(event_id:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id,captured_at:now,text:event_id})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    const packets=()=>room.published as any[];
    const read=(processed_event_id:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'result',processed_event_id})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    return {admission,runtime,bridge,send,read,packets};
  };
  let live=await boot();live.send('first');await eventually(()=>live.packets().some(p=>p.admission?.state==='running'));
  const first=live.packets().find(p=>p.event_id==='first');
  live.send('second');await eventually(()=>live.packets().some(p=>p.event_id==='second'&&p.admission?.state==='pending'));
  const second=live.packets().find(p=>p.event_id==='second');
  live.send('second');await eventually(()=>live.packets().filter(p=>p.event_id==='second').length>=2);
  assert.equal(created.length,1);assert.equal((await storage.list('admissions')).length,2);
  await live.bridge.close();await live.runtime.close();
  assert.ok(errors.every(error=>error instanceof ContractError&&error.code==='FORMAL_TEXT_CONNECTION_CHANGED'));errors.length=0;
  live=await boot();
  // Existing result recovery reattaches without re-submitting or minting a second admission.
  live.read(first.processed_event_id);live.read(second.processed_event_id);await eventually(()=>live.packets().some(p=>p.event_id==='second'));
  assert.equal(live.packets().find(p=>p.event_id==='second').processed_event_id,second.processed_event_id);
  live.send('third');await eventually(()=>live.packets().some(p=>p.event_id==='third'&&p.admission?.state==='pending'));
  assert.deepEqual(created,['first']);
  await live.runtime.tool('paios_open_reply',{context:{run_id:'queue-1',session_id:'continuity',tool_call_id:'first-open'},args:{reply_mode:'text'}});
  runs.get('queue-1')!.status='completed';
  await eventually(()=>live.packets().some(p=>p.operation==='text_chunk'&&p.chunk.text==='reply first'));
  await eventually(()=>live.packets().some(p=>p.event_id==='second'&&p.admission?.state==='running'));
  const started=live.packets().find(p=>p.event_id==='second'&&p.admission?.state==='accepted');
  assert.equal(started.admission.idempotency_key,second.admission.idempotency_key);
  assert.ok(started.admission.run_order>0);assert.deepEqual(created,['first','second']);
  await live.runtime.tool('paios_open_reply',{context:{run_id:'queue-2',session_id:'continuity',tool_call_id:'second-open'},args:{reply_mode:'text'}});
  runs.get('queue-2')!.status='completed';
  await eventually(()=>live.packets().some(p=>p.operation==='text_chunk'&&p.chunk.text==='reply second'));
  await eventually(()=>live.packets().some(p=>p.event_id==='third'&&p.admission?.state==='running'));
  await live.runtime.tool('paios_open_reply',{context:{run_id:'queue-3',session_id:'continuity',tool_call_id:'third-open'},args:{reply_mode:'text'}});
  runs.get('queue-3')!.status='completed';
  await eventually(()=>live.packets().some(p=>p.operation==='text_chunk'&&p.chunk.text==='reply third'));
  assert.deepEqual(created,['first','second','third']);assert.equal((await storage.list('admissions')).length,3);
  assert.deepEqual(errors,[]);
});

test('native terminal automatically seals and publishes after accepted with no result command; real failures/none stay honest',async t=>{
  const automaticFixture:any={schema:'paios.central.automatic-text-fixture.v1',evidence:'actual POSIX OUT/control host/synthetic native/SDK packets; not live model/device',automatic_completion:{}};
  for(const mode of ['text','none','failed','receipt-failure','instant','fast','payment-disabled']) {
    const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-auto-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const storage=new PosixStorage(root),observed=deferred<void>(),finalStored=deferred<void>(),run:NativeRun={run_id:'auto-run',session_id:'continuity',conversation_session_id:'continuity',status:mode==='instant'?'completed':'running',output:'automatic 🔬文字'};let creates=0;
    const nativeGate=deferred<void>();let pending=0;
    const native:NativeClient={create:async()=>{creates++;if(mode!=='instant')await nativeGate.promise;return {...run};},status:async()=>{
      if(mode==='fast'){await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'fast-open'},args:{reply_mode:'text'}});run.status='completed';}
      observed.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
    const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'automatic'});
    if(['instant','fast'].includes(mode)){const persist=storage.publish.bind(storage);storage.publish=async(namespace,key,bytes)=>{const saved=await persist(namespace,key,bytes);if(namespace==='output-journal' && JSON.parse(Buffer.from(bytes).toString('utf8')).result)finalStored.resolve();return saved;};}
    // The second pending packet comes from the installed result subscription. Only then admit the native run,
    // so this lifecycle assertion observes its transitions instead of racing the initial snapshot.
    const room=testRoom();{const publish=room.localParticipant.publishData;room.localParticipant.publishData=async(bytes:Uint8Array)=>{const p=JSON.parse(Buffer.from(bytes).toString('utf8'));
      if(p.operation==='accepted'&&(mode==='instant'||!p.admission.run_id&&++pending===2)){nativeGate.resolve();if(['instant','fast'].includes(mode))await finalStored.promise;}return publish(bytes);};}
    const errors:unknown[]=[],runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,
      output:new OutputAuthority(storage,{listRunReceipts:async()=>mode==='receipt-failure'?{sources:[{source:'l3',status:'failed',error:'SOURCE_UNAVAILABLE',receipts:[]}]}:{sources:[]}}),
      sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
    t.after(async()=>{await bridge.close();await runtime.close();});await bridge.onBootstrapConnected(f.input);
    const submit={operation:'submit',event_id:'auto-'+mode,captured_at:now,text:'original automatic source'};
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(submit)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await eventually(()=>room.published.length>=1);await observed.promise;const accepted=room.published[0] as any;
    assert.equal(accepted.operation,'accepted');
    if(mode==='payment-disabled')assert.deepEqual(await runtime.tool('paios_payment',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'pay'},args:{action:'request',purpose:'午饭',app:'千问',budget_yuan:16.6}}),{status:'rejected',error_code:'PAYMENT_DISABLED'});
    if(!['instant','fast'].includes(mode)) {
      await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:mode==='none'?'none':'text'}});
      run.status=mode==='failed'?'failed':'completed';
    }
    await eventually(()=>room.published.some((packet:any)=>packet.operation==='result_header'));
    const header=room.published.find((packet:any)=>packet.operation==='result_header') as any;
    if(mode!=='instant'){
      const states=(room.published.slice(0,room.published.indexOf(header)) as any[]).filter(p=>p.operation==='accepted'&&p.admission.run_id);
      assert.deepEqual(states.map(p=>p.admission.state),['accepted','running',mode==='failed'?'failed':'completed']);
      assert.ok(states.every(p=>p.admission.run_id===run.run_id&&p.admission.run_order===states[0].admission.run_order));
    }
    assert.equal(header.processed_event_id,accepted.processed_event_id);assert.equal(header.text_replay,'pending');assert.equal(header.delivery_status,'unknown');
    if(['text','receipt-failure','instant','fast','payment-disabled'].includes(mode))await eventually(()=>room.published.some((packet:any)=>packet.chunk?.final));
    const chunks=room.published.filter((packet:any)=>packet.operation==='text_chunk') as any[];
    if(['text','receipt-failure','instant','fast','payment-disabled'].includes(mode)){assert.equal(chunks.map(packet=>packet.chunk.text).join(''),run.output);}
    else {assert.equal(chunks.length,0);assert.equal(header.reply_mode,mode==='none'?'none':mode==='failed'?'text':'none');}
    if(mode==='failed')assert.equal(header.result_status,'failed');
    if(mode==='instant'){assert.equal(header.result_status,'completed');assert.equal(header.reply_phase,'sealed');assert.equal(header.reply_mode,'text');}
    if(mode==='receipt-failure'){assert.equal(header.receipt_status,'unknown');assert.equal(header.result_status,'failed');}
    assert.equal(errors.length,0);assert.equal(creates,1);
    automaticFixture.trusted_binding={session_id:'continuity',device_id:'mac',connection_epoch:'1',expected_gateway_identity:f.input.authority.gateway.identity,evidence:'controlled host fixture'};
    automaticFixture.automatic_completion[mode.replaceAll('-','_')]={input_submit:submit,accepted,admissions:room.published.filter((p:any)=>p.operation==='accepted'),header,text_chunks:chunks};
    if(mode==='text'){const start=room.published.length;room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(submit)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
      await eventually(()=>room.published.length>=start+2);assert.equal((room.published[start] as any).operation,'accepted');assert.equal((room.published[start+1] as any).processed_event_id,accepted.processed_event_id);assert.equal(creates,1);}
  }
  if(process.env.PAIOS_AUTOMATIC_ENVELOPE_FIXTURE_OUT)await fs.writeFile(process.env.PAIOS_AUTOMATIC_ENVELOPE_FIXTURE_OUT,JSON.stringify(automaticFixture,null,2)+'\n');
});
test('automatic output is fenced on replacement/close and publish failure never reruns native or alters durable OUT',async t=>{
  for(const mode of ['replace','close','publish-failure','auth-failure']) {
    const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-auto-fence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const storage=new PosixStorage(root),entered=deferred<void>(),release=deferred<void>(),observed=deferred<void>(),finished=deferred<void>(),disconnected=deferred<void>();let creates=0;
    const run:NativeRun={run_id:'fenced-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'durable despite transport'};
    const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>{observed.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
    const out=new OutputAuthority(storage,{listRunReceipts:async()=>{entered.resolve();await release.promise;return {sources:[]};}});
    const errors:unknown[]=[],runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'fence'}),native,output:out,
      sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
    const old=testRoom(),next=testRoom(),participant={roomPort:old,disconnect:async()=>{disconnected.resolve();}};
    if(mode==='publish-failure')old.localParticipant.publishData=async(bytes:Uint8Array)=>{const packet=JSON.parse(Buffer.from(bytes).toString('utf8'));if(packet.operation==='result_header'){finished.resolve();throw new Error('SDK_FAILED');}old.published.push(packet);};
    const bridge=createFormalTextIngress({participant:participant as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);finished.resolve();}});
    await bridge.onBootstrapConnected(f.input);old.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'fence',captured_at:now,text:'original'})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await eventually(()=>old.published.some((p:any)=>p.operation==='accepted'&&p.event_id==='fence'));await observed.promise;const accepted=old.published.find((p:any)=>p.operation==='accepted'&&p.event_id==='fence') as any;
    const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
    await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text'}});run.status='completed';await entered.promise;
    if(mode==='replace'){participant.roomPort=next;await bridge.onBootstrapConnected(f.input);}
    if(mode==='close')await bridge.close();if(mode==='auth-failure')f.setFail();release.resolve();
    if(mode==='publish-failure')await finished.promise;
    if(mode==='auth-failure'){await disconnected.promise;await assert.rejects(runtime.authenticate(f.authority.credentialForBootstrap(f.input)),/CURRENT_AUTH_UNAVAILABLE/);}
    // Runtime close drains the actual OUT work; listener fencing does not destroy its durable result.
    await runtime.close();assert.equal(creates,1);const outputPackets=()=>old.published.filter((packet:any)=>packet.operation!=='accepted');if(mode==='publish-failure'){await eventually(()=>outputPackets().length===1);assert.equal((outputPackets()[0] as any).operation,'rejected');}else assert.equal(outputPackets().length,0);assert.equal(next.published.length,0);
    const d=JSON.parse(Buffer.from(await storage.read('processed-events', (await import('../../../services/personal-aios-integration/src/contracts.ts')).digest({principal_id:source.principal_id,processed_event_id:accepted.processed_event_id}))).toString('utf8'));
    const durable=await out.readSealedText({principal_id:source.principal_id,session_id:'continuity',run_id:run.run_id,tool_call_id:'final-buffer',d,target:{device_id:'mac',device_type:'mac',route_version:'route-1',output_modes:['text']}});
    assert.equal(durable.result.delivery_status,'unknown');assert.equal(durable.chunks.map(chunk=>chunk.text).join(''),run.output);
    if(mode==='publish-failure')assert.match(String(errors[0]),/SDK_FAILED/);else if(mode==='auth-failure')assert.ok(errors.every(error=>/CURRENT_AUTH_UNAVAILABLE|FORMAL_TEXT_CONNECTION_CHANGED/.test(String(error))));else assert.equal(errors.length,0);
    await bridge.close();
  }
});

test('actual sealed text cancellation keeps original plan/count/watermark but sends no chunks and rejects late ACK',async t=>{
  const exported:any={schema:'paios.central.cancelled-text-fixture.v1',evidence:'actual POSIX sealed OUT followed by owner cancel; controlled source/native/SDK, no model/device',cancelled:{}};
  for(const extent of ['partial','full']) {
    const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-cancelled-'));
    const storage=new PosixStorage(root),observed=deferred<void>(),run:NativeRun={run_id:'cancel-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'🔬中文 immutable cancel text'};
    const native:NativeClient={create:async()=>({...run}),status:async()=>{observed.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
    const out=new OutputAuthority(storage,{chunkChars:3,listRunReceipts:async()=>({sources:[]})}),runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),
      admission:new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'cancel'}),native,output:out,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});
    const room=testRoom(),errors:unknown[]=[],bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
    t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});await bridge.onBootstrapConnected(f.input);
    const send=(body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    const input={operation:'submit',event_id:'cancel-'+extent,captured_at:now,text:'immutable original'};send(input);await eventually(()=>room.published.some((p:any)=>p.operation==='accepted'&&p.event_id===input.event_id));await observed.promise;
    const accepted=room.published.find((p:any)=>p.operation==='accepted'&&p.event_id===input.event_id) as any,source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
    const d=(await runtime.event(source,'continuity',accepted.processed_event_id)).processed_event;
    await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text'}});run.status='completed';
    const request={operation:'result',processed_event_id:d.processed_event_id};send(request);await eventually(()=>room.published.some((packet:any)=>packet.chunk?.final));
    const sealedHeader=room.published.find((packet:any)=>packet.operation==='result_header') as any,originalChunks=room.published.filter((packet:any)=>packet.operation==='text_chunk') as any[],first=originalChunks[0]!.chunk,total=originalChunks.length;
    const ack={output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:first.target_device_id,route_version:first.route_version,
      highest_contiguous_seq:extent==='partial'?2:total,status:'rendered' as const,observed_at:now};
    const ackReceipt=await runtime.acknowledge(source,'continuity',d.processed_event_id,ack);
    const context={principal_id:d.principal_id,run_id:run.run_id,session_id:'continuity',tool_call_id:'final-buffer',d,target:{device_id:'mac',device_type:'mac' as const,route_version:'route-1',output_modes:['text']}};
    const cancellation=await out.cancel(context,first.reply_epoch),finalized=await out.readFinalized(context);
    assert.equal(finalized.result.reply_phase,'interrupted');assert.deepEqual(finalized.chunks,[]);assert.equal(finalized.text_chunk_count,total);
    const offset=room.published.length;send(request);await eventually(()=>room.published.length===offset+1);const header=room.published[offset] as any;
    assert.equal(header.reply_phase,'interrupted');assert.equal(header.reply_status,'partial');assert.equal(header.result_status,'interrupted');
    assert.equal(header.text_chunk_count,total);assert.equal(header.rendered_text_through_seq,ack.highest_contiguous_seq);
    assert.equal(header.pending_text_chunk_count,total-ack.highest_contiguous_seq);assert.deepEqual(header.output_plan,sealedHeader.output_plan);assert.ok(header.output_plan.length>0);
    assert.equal(header.reply_id,sealedHeader.reply_id);assert.equal(header.reply_epoch,sealedHeader.reply_epoch);
    await assert.rejects(runtime.result(source,'continuity',d.processed_event_id,{text_replay:'sealed'}),/SEALED_TEXT_OLD_EPOCH/);
    await assert.rejects(runtime.acknowledge(source,'continuity',d.processed_event_id,{...ack,highest_contiguous_seq:total}),/OUTPUT_ACK_OLD_EPOCH/);
    assert.equal(errors.length,0);exported.trusted_binding={session_id:'continuity',device_id:'mac',connection_epoch:'1',expected_gateway_identity:f.input.authority.gateway.identity,evidence:'controlled host fixture'};
    exported.cancelled[extent]={input_submit:input,accepted,sealed_header:sealedHeader,original_text_chunks:originalChunks,input_ack:ack,ack_receipt:ackReceipt,cancellation,
      request,header,text_chunks:[],late_chunk:originalChunks.at(-1),evidence:{read_finalized_chunks:finalized.chunks.length,sealed_replay_error:'SEALED_TEXT_OLD_EPOCH',late_ack_error:'OUTPUT_ACK_OLD_EPOCH'}};
  }
  if(process.env.PAIOS_CANCELLED_ENVELOPE_FIXTURE_OUT)await fs.writeFile(process.env.PAIOS_CANCELLED_ENVELOPE_FIXTURE_OUT,JSON.stringify(exported,null,2)+'\n');
});

function workout(){return {schema_version:'phase0-demo/0.4',event_type:'paios.phase0.demo.workout.metric',event_id:'01900000-0000-7000-8000-000000000011',
  session_id:'room',trace_id:'01900000-0000-7000-8000-000000000012',occurred_at:now,expires_at:future,
  origin:{device_id:'watch-source',device_class:'apple_watch',client_instance_id:'watch-client',relay:{device_id:'mac',device_class:'iphone',transport:'watch_connectivity'}},
  connection:{id:'connection-1',epoch:0,state:'connected'},sequence:{stream_id:'workout-1',number:1},idempotency_key:'workout-1-1',
  payload:{workout_id:'workout-1',workout_kind:'cycling',observed_at:now,metrics:[{name:'heart_rate',value:72,unit:'bpm'}]}};}
test('retired workout topic cannot admit a per-metric Hermes event',async()=>{
  const f=fixture(),room=testRoom();let calls=0;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>{calls++;return {};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:()=>{}});
  await bridge.onBootstrapConnected(f.input);
  const initial=calls;room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(workout())),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,'paios.phase0.demo.event');
  assert.equal(calls,initial);assert.deepEqual(room.published,[]);await bridge.close();
});
test('persistent execution factory ignores legacy watch ingress and admits ordinary phone text',async t=>{
  const {createPersistentPublicExecutionOwner}=await import('../src/persistent-public-execution-owner.ts');
  const {sourceClient}=await import('../../../services/personal-aios-integration/tests/native-source-fixture.ts');
  const nativeBytes=await fs.readFile(process.env.PAIOS_WATCH_NATIVE_CODEC_FIXTURE ?? new URL('./fixtures/watch-native-codec.synthetic.json',import.meta.url));
  const nativeEvent=JSON.parse(nativeBytes.toString('utf8'));
  const sourceIDs={primary:nativeEvent.origin.relay.device_id,watch:nativeEvent.origin.device_id,client:nativeEvent.origin.client_instance_id};
  const f=fixture(true,sourceIDs);(f.current.lease as any).policyDecisionRef='policy-1';
  const root=await fs.mkdtemp(join(tmpdir(),'factory-test-'));
  let creates=0,snapshotReads=0,fenceInspections=0;const published:any[]=[],errors:unknown[]=[];
  const native=sourceClient({create:async body=>{creates++;const d=JSON.parse(body.input);assert.equal(d.device_type,'phone');assert.equal(d.user_identity,'actual-owner');
    return {run_id:'factory-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};},status:async()=>({run_id:'factory-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'}),
    cancel:async()=>({run_id:'factory-run',session_id:'continuity',conversation_session_id:'continuity',status:'cancelled'})});
  const callbacks=new Map<string,(...args:any[])=>void>();const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(name:string,fn:(...args:any[])=>void)=>callbacks.set(name,fn),off:(name:string)=>callbacks.delete(name),
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>published.push(JSON.parse(Buffer.from(bytes).toString('utf8')))}};
  const currentAuthority={userId:'actual-owner',deviceId:sourceIDs.primary,principal:{opaque_ref:'not-user-id'},policyDecisionRef:'policy-1',
    allowedMediaCapabilities:['data'],governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent-1'}]}};
  const selected=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',deviceId:sourceIDs.primary,now:()=>Date.parse(now),participant:{roomPort:room,disconnect:async()=>{}} as never,
    readCurrentBinding:async()=>f.current,readCurrentBindingInAdmission:async(client)=>{assert.equal((client as any).controlled,true);return f.current;},
    watchSnapshot:{snapshotIsolation:'REPEATABLE READ',readOnly:true,readCurrentBindingSnapshot:async()=>{snapshotReads++;return f.snapshot;},
      readCurrentBindingSnapshotInAdmission:async client=>{assert.equal((client as any).controlled,true);fenceInspections++;return f.snapshot;}},
    credentialFence:{verify:async()=>({active:false}),withAdmission:async(_tuple,consume)=>consume({controlled:true} as never)},
    t03:{ownerContext:{resolve:async()=>({userId:'actual-owner',deviceId:sourceIDs.primary,purpose:'typed-submit',capabilities:['data'],occurredAt:now})},
      formalWatchPrimaryAuthority:{resolve:async()=>({...currentAuthority,principalRef:currentAuthority.principal})},readCurrentAuthority:()=>currentAuthority} as never,
    central:{storage:new PosixStorage(root),native,skill:'fixed',max_event_bytes:20000,max_read_bytes:20000,
      admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'factory-watch'},
      http:{internal_token:'isolated-source-only-abcdefghijklmnop',max_request_bytes:20000,request_timeout_ms:1000}},
    onError:error=>errors.push(error)});
  t.after(async()=>{await selected.bridge.close!();await fs.rm(root,{recursive:true,force:true});});assert.equal(selected.executionOwner,'hermes_text');assert.equal(selected.assembly.server.listening,false);
  await selected.bridge.onBootstrapConnected!(f.input);callbacks.get(RoomEvent.DataReceived)!(nativeBytes,{identity:'terminal'},DataPacketKind.KIND_RELIABLE,'paios.phase0.demo.event');
  assert.equal(creates,0);assert.equal(snapshotReads,0);assert.equal(fenceInspections,0);
  callbacks.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify({operation:'submit',event_id:'same-session-text',captured_at:now,text:'同时提交的原文字'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>published.some(packet=>packet.event_id==='same-session-text'&&packet.admission.run_id));assert.equal(creates,1);assert.deepEqual(errors,[]);
});

test('standard native codec preserves frozen legacy semantic envelope and original v0.4 consumer schema',async()=>{
  const {default:AjvModule}=await import('ajv/dist/2020.js');const {default:FormatsModule}=await import('ajv-formats');
  const Ajv=AjvModule.default;const addFormats=FormatsModule.default;const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);
  const schema=JSON.parse(await fs.readFile(new URL('../../contracts/demo_v0_4/session-event.schema.json',import.meta.url),'utf8'));
  const validate=ajv.compile(schema);
  const corpus=JSON.parse(await fs.readFile(process.env.PAIOS_WATCH_LEGACY_CODEC_FIXTURE ?? new URL('./fixtures/watch-native-legacy-corpus.synthetic.json',import.meta.url),'utf8')) as {current:string;frozen:string}[];
  assert.equal(corpus.length,5);assert.ok(corpus.some(item=>item.current!==item.frozen));
  for(const item of corpus){const current=JSON.parse(item.current),frozen=JSON.parse(item.frozen);
    assert.equal(canonical(current),canonical(frozen));assert.ok(validate(current),JSON.stringify(validate.errors));}
});

test('archived Watch run controls retain source fences and terminal barriers',async t=>{
  const bytes=await fs.readFile(process.env.PAIOS_WATCH_NATIVE_CODEC_FIXTURE ?? new URL('./fixtures/watch-native-codec.synthetic.json',import.meta.url));
  const original=JSON.parse(bytes.toString('utf8')),f=fixture(true,{primary:original.origin.relay.device_id,watch:original.origin.device_id,client:original.origin.client_instance_id});
  const root=await fs.mkdtemp(join(tmpdir(),'watch-control-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),runs=new Map<string,NativeRun>();let creates=0,cancels=0;
  const native:NativeClient={create:async body=>{const d=JSON.parse(body.input) as ProcessedEvent;assert.equal(d.user_identity,'unknown');assert.equal(Object.hasOwn(body,'memory_write'),false);
    const run={run_id:'controlled-watch-'+ ++creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return {...run};},
    status:async id=>({...runs.get(id)!}),cancel:async id=>{cancels++;runs.get(id)!.status='cancelled';return {...runs.get(id)!};}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'explicit-control'});
  // Archived source fixture; live Watch credentials and the room relay are retired.
  const watch=sourceSnapshot({principal_id:'actual-owner',device_id:original.origin.device_id,device_type:'watch',capabilities:WATCH_CAPABILITIES,channel:'watch_connectivity',
    relay_device_id:original.origin.relay.device_id,consent_ref:'submit-consent',output_target:{device_id:original.origin.relay.device_id,device_type:'phone'},output_modes:['text'],
    route_version:`route:watch:${digest({primary:'route-1',device:original.origin.device_id,client:original.origin.client_instance_id,pair:'1'})}`});
  const sourceAuthority={authenticate:f.authority.authenticate.bind(f.authority),revalidate:async(source:typeof watch)=>source===watch?watch:f.authority.revalidate(source),
    verifyRunController:f.authority.verifyRunController.bind(f.authority),verifyOutputRecipient:f.authority.verifyOutputRecipient.bind(f.authority)};
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,20000),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority,skill:'fixed',max_read_bytes:20000,automatic_output:{onError:()=>{}}});t.after(()=>runtime.close());
  const room=testRoom(),errors:unknown[]=[];
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);
  const seed=async(event:typeof original)=>{const accepted=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:`watch:${digest({device_id:watch.device_id,idempotency_key:event.idempotency_key})}`,captured_at:now,device_id:watch.device_id,device_type:'watch',source:{channel:watch.channel,relay_device_id:watch.relay_device_id!},media_type:'app_event',mime:'application/json',representation:'uploaded_original',payload:Buffer.from(JSON.stringify(event))},watch,'continuity',false);return {...accepted.processed_event,admission:accepted.admission};};
  const accepted=await seed(original),dId=accepted.processed_event_id;
  await eventually(async()=>typeof(await runtime.event(watch,'continuity',dId)).admission.run_id==='string');accepted.admission=(await runtime.event(watch,'continuity',dId)).admission;
  const phone=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  const d=(await runtime.event(watch,'continuity',dId)).processed_event;
  assert.equal(d.event_id,'watch:'+ (await import('../../../services/personal-aios-integration/src/contracts.ts')).digest({device_id:original.origin.device_id,idempotency_key:original.idempotency_key}));
  await assert.rejects(runtime.event(phone,'continuity',dId),/D_DEVICE_SCOPE_DENIED/);
  await assert.rejects(runtime.cancelRun(phone,'continuity',dId),/D_DEVICE_SCOPE_DENIED/);
  await assert.rejects(runtime.cancelRunControl({...phone},'continuity',dId),/PROVENANCE_REQUIRED/);
  f.snapshot.formalWatchPairState.pairVersion='2';f.snapshot.formalWatchBinding.pairVersion='2';
  await assert.rejects(runtime.cancelRunControl(phone,'continuity',dId),/CONTROL_BINDING_CHANGED/);assert.equal(cancels,0);
  f.snapshot.formalWatchPairState.pairVersion='1';f.snapshot.formalWatchBinding.pairVersion='1';f.setSessionState('terminal');
  await assert.rejects(runtime.cancelRunControl(phone,'continuity',dId),/BINDING_INACTIVE/);assert.equal(cancels,0);f.setSessionState('active');
  (f.current.lease as {leaseVersion:string;expiresAt:string}).leaseVersion='2';(f.current.lease as {expiresAt:string}).expiresAt='2026-10-01T02:00:00.000Z';
  f.snapshot.formalWatchBinding.expiresAt='2026-10-01T02:00:00.000Z';
  const entered=deferred<void>(),release=deferred<void>();let held=true;
  const subscribing=runtime.subscribeResult(phone,'continuity',dId,async()=>{},()=>{}, {on_admission:async()=>{if(held){entered.resolve();await release.promise;}}});
  await entered.promise;
  const input=process.env.PAIOS_NATIVE_CONTROL_FRAME?JSON.parse(await fs.readFile(process.env.PAIOS_NATIVE_CONTROL_FRAME,'utf8')):
    {operation:'cancel_run',processed_event_id:dId,control_id:'explicit-phone-control'};
  assert.equal(input.operation,'cancel_run');assert.equal(input.processed_event_id,dId);
  const send=(identity:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(input)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send('forged');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(cancels,0);send('terminal');
  await eventually(()=>cancels===1);await eventually(async()=> (await admission.readOnly('actual-owner','continuity',dId))?.state==='cancelled');
  await eventually(()=>room.published.some((packet:any)=>packet.operation==='control_receipt'));
  // A suspended admission transport cannot hold native terminal, OUT seal, or the next logical run.
  const second={...original,event_id:'01900000-0000-7000-8000-000000000080',idempotency_key:original.idempotency_key+':next'};
  const secondAccepted=await seed(second);await eventually(()=>creates===2);
  const sealed=await runtime.result(phone,'continuity',dId);assert.equal(sealed.result.run_status,'cancelled');
  const closeHeld=deferred<void>();
  await runtime.subscribeResult(phone,'continuity',secondAccepted.processed_event_id,async()=>{},()=>{}, {on_admission:async()=>{closeHeld.resolve();await new Promise<void>(()=>{});}});
  await closeHeld.promise;
  let closed=false;const closing=runtime.close().then(()=>{closed=true;});await eventually(()=>closed);await closing;
  // Neither blocked callback was released to make close pass. Its delivery is unconfirmed.
  held=false;release.resolve();await subscribing;
  assert.ok(room.published.some((packet:any)=>packet.operation==='control_receipt'&&packet.receipt.status==='cancel_requested'&&packet.receipt.run_id===accepted.admission.run_id));
  if(process.env.PAIOS_WATCH_CONTROL_FIXTURE) await fs.writeFile(process.env.PAIOS_WATCH_CONTROL_FIXTURE,JSON.stringify({
    schema:'synthetic.watch-run-control.fixture.v1',evidence:'controlled native ports; actual source producer/Room/ING/admission contracts; no hardware/model',
    trusted_binding:{session_id:'continuity',device_id:original.origin.relay.device_id,connection_epoch:'1',expected_gateway_identity:'controlled-source-gateway'},wire:original,
    accepted:room.published.filter((packet:any)=>packet.operation==='accepted'&&packet.event_id===d.event_id),control_input:input},null,2));
});

test('formal Room permanent held admission publication cannot hold native/OUT/next D or bridge close',async t=>{
  const f=fixture(true),root=await fs.mkdtemp(join(tmpdir(),'watch-held-room-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),runs=new Map<string,NativeRun>();let creates=0;
  const native:NativeClient={create:async body=>{const run={run_id:'held-room-'+ ++creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return {...run};},
    status:async id=>({...runs.get(id)!}),cancel:async id=>{runs.get(id)!.status='cancelled';return {...runs.get(id)!};}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'held-room'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,20000),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:20000,automatic_output:{onError:()=>{}}});t.after(()=>runtime.close());
  const room=testRoom(),entered=deferred<void>();let permanentlyHeld=false;
  room.localParticipant.publishData=async(bytes:Uint8Array)=>{
    const packet=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(packet.operation==='accepted'&&packet.admission.run_id&&!permanentlyHeld){permanentlyHeld=true;entered.resolve();await new Promise<void>(()=>{});return;}
    room.published.push(packet);
  };
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:()=>{}});
  await bridge.onBootstrapConnected(f.input);
  const send=(value:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(value)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'submit',event_id:'first-submit',captured_at:now,text:'骑行前的问题'});await entered.promise;
  const accepted=room.published.find((packet:any)=>packet.operation==='accepted') as any;
  const phone=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  await runtime.cancelRunControl(phone,'continuity',accepted.processed_event_id);
  await eventually(async()=>(await runtime.result(phone,'continuity',accepted.processed_event_id)).result.run_status==='cancelled');
  assert.equal(room.published.some((packet:any)=>packet.operation==='result_header'),false,'formal result waits for ordered state delivery');
  send({operation:'submit',event_id:'next-submit',captured_at:now,text:'下一个问题'});await eventually(()=>creates===2);
  let closed=false;const closing=(async()=>{await bridge.close();await runtime.close();closed=true;})();await eventually(()=>closed);await closing;
  assert.equal(permanentlyHeld,true);
  assert.equal(room.published.some((packet:any)=>packet.operation==='accepted'&&packet.admission.run_id==='held-room-1'),false,'Unsettled RTC publication is not delivered acceptance');
});

test('shared submit owner releases only new 429 capacity; same logical admission and uncertain accepted send remain owned',async t=>{
  const f=fixture(true),root=await fs.mkdtemp(join(tmpdir(),'watch-capacity-owner-'));
  const storage=new PosixStorage(root),runs=new Map<string,NativeRun>();let creates=0;
  const native:NativeClient={create:async body=>{const run={run_id:'capacity-'+ ++creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return {...run};},
    status:async id=>({...runs.get(id)!}),cancel:async id=>{runs.get(id)!.status='cancelled';return {...runs.get(id)!};}};
  const admission=new RunAdmission(storage,native,{max_pending_events:1,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'capacity-owner'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,20000),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:20000,automatic_output:{onError:()=>{}}});
  const room=testRoom(),errors:unknown[]=[];let failAccepted=true;
  room.localParticipant.publishData=async(bytes:Uint8Array)=>{const packet=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(packet.operation==='accepted'&&failAccepted){failAccepted=false;throw new Error('accepted-send-unknown');}room.published.push(packet);};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:error=>errors.push(error)});t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);
  const send=(value:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(value)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'submit',event_id:'first-submit',captured_at:now,text:'骑行前的问题'});await eventually(()=>creates===1&&errors.length===1);
  assert.equal(room.published.some((p:any)=>p.operation==='rejected'),false,'accepted send failure is not unaccepted');
  send({operation:'submit',event_id:'first-submit',captured_at:now,text:'骑行前的问题'});await eventually(()=>room.published.some((p:any)=>p.operation==='accepted'&&p.admission.run_id));
  assert.equal(creates,1,'same event uses prior record despite full capacity');
  const originalSubmit=runtime.submit.bind(runtime);
  runtime.submit=async()=>{throw new (await import('../../../services/personal-aios-integration/src/contracts.ts')).ContractError('ADMISSION_CAPACITY_EXCEEDED',503);};
  const second={operation:'submit',event_id:'second-submit',captured_at:now,text:'下一个问题'};
  send(second);await eventually(()=>errors.length===2);
  assert.equal(room.published.some((p:any)=>p.operation==='rejected'),false,'503 recovery uncertainty does not release a registered source');
  runtime.submit=originalSubmit;send(second);await eventually(()=>room.published.some((p:any)=>p.operation==='rejected'));
  const rejected=room.published.find((p:any)=>p.operation==='rejected') as any;
  assert.equal(rejected.error_code,'ADMISSION_CAPACITY_EXCEEDED');assert.equal(rejected.event_id,'second-submit');
  assert.equal(creates,1,'other current run remains owned');
  const accepted=room.published.find((p:any)=>p.operation==='accepted'&&p.admission.run_id) as any;
  const phone=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));await runtime.cancelRunControl(phone,'continuity',accepted.processed_event_id);
  await eventually(()=>room.published.some((p:any)=>p.operation==='result_header'&&p.run_status==='cancelled'));
  send(second);await eventually(()=>creates===2);
});
test('voiceprint enrollment: archived-only windows on the one PCM reader, measured and enrolled centrally; shapes per contract',async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],windows:string[]=[],calls:string[]=[];let measured=0;
  const phone={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};
  const sample='vps-0f8fad5b-d9cb-469f-a165-70867728950e',owner={enrolled:false,reenrollment_required:false,samples:0,speaker_model:null,enrolled_at:null,updated_at:null,consistency:null};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,formalVoice:async(_s:unknown,modality:string,consume:()=>Promise<unknown>)=>{calls.push(modality);return consume();},
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    voiceprintSample:async(source:unknown,window:{raw_ref:string;archive_revision:string})=>{assert.equal(source,phone);assert.deepEqual(window,{raw_ref:'l5:'+'a'.repeat(64),archive_revision:'b'.repeat(64)});
      return ++measured===2?{sample_id:null,speech_ms:600,quality:'too_short'}:{sample_id:sample,speech_ms:120000,quality:'ok',samples:[{sample_id:sample,speech_ms:3000,weight:1},{sample_id:sample.slice(0,-1)+'f',speech_ms:3000,weight:.8}]};},
    voiceprintEnroll:async(_s:unknown,ids:string[])=>ids.length===5?{status:'enrolled',owner:{...owner,enrolled:true,samples:5,updated_at:now,consistency:{min:0.81,mean:0.9}}}:
      {status:'inconsistent',owner,samples:ids.map((sample_id,n)=>({sample_id,consistency:n===5?0.3:0.8,ok:n!==5}))},
    voiceTrustDevices:async()=>({voice_devices:[{device_id:'mac',device_type:'phone'}],active_voice_device_id:'mac'}),
    voiceprintForget:async()=>owner,voiceprintOwner:async()=>{throw Object.assign(new Error('x'),{});}} as unknown as PersonalAIOSRuntime;
  const capture={open:async(operation:string,purpose?:string)=>{windows.push(`open:${operation}:${purpose}`);},
    commit:async(operation:string,purpose?:string)=>{windows.push(`commit:${operation}:${purpose}`);if(operation==='vp-3')throw new (await import('../../../services/personal-aios-integration/src/contracts.ts')).ContractError('FORMAL_PCM_VOICE_WINDOW_EMPTY',409);
      return {event_id:'pcm:w',request:{raw_ref:'l5:'+'a'.repeat(64),archive_revision:'b'.repeat(64)} as never};},
    cancel:(operation:string)=>{windows.push(`cancel:${operation}`);return true;}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_capture:capture,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);
  const send=(body:object,identity='terminal')=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const out=(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[];
  send({operation:'voiceprint_open',operation_id:'vp-1'},'someone-else');await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(windows,[],'only the bound phone identity speaks on this channel');
  send({operation:'voiceprint_open',operation_id:'vp-1'});await eventually(()=>out('voiceprint_sample').length===1);
  assert.deepEqual(out('voiceprint_sample')[0],{schema_version:'paios.central.text-envelope.v1',operation:'voiceprint_sample',session_id:'continuity',operation_id:'vp-1',status:'recording'});
  send({operation:'voiceprint_commit',operation_id:'vp-1'});await eventually(()=>out('voiceprint_sample').length===2);
  assert.deepEqual(out('voiceprint_sample')[1],{schema_version:'paios.central.text-envelope.v1',operation:'voiceprint_sample',session_id:'continuity',operation_id:'vp-1',
    status:'measured',sample_id:sample,speech_ms:120000,quality:'ok',samples:[{sample_id:sample,speech_ms:3000,weight:1},{sample_id:sample.slice(0,-1)+'f',speech_ms:3000,weight:.8}]});
  assert.deepEqual(windows,['open:vp-1:voiceprint','commit:vp-1:voiceprint'],'enrollment windows are voiceprint windows, never requests');
  send({operation:'voiceprint_commit',operation_id:'vp-2'});await eventually(()=>out('voiceprint_sample').length===3);
  assert.deepEqual([out('voiceprint_sample')[2].quality,out('voiceprint_sample')[2].sample_id],['too_short',undefined]);
  send({operation:'voiceprint_commit',operation_id:'vp-3'});await eventually(()=>out('voiceprint_sample').length===4);
  assert.deepEqual([out('voiceprint_sample')[3].status,out('voiceprint_sample')[3].error_code],['failed','FORMAL_PCM_VOICE_WINDOW_EMPTY']);
  send({operation:'voiceprint_cancel',operation_id:'vp-4'});await eventually(()=>out('voiceprint_sample').length===5);
  assert.equal(out('voiceprint_sample')[4].status,'cancelled');assert.equal(windows.at(-1),'cancel:vp-4');
  send({operation:'voiceprint_enroll',control_id:'c-1',sample_ids:Array(6).fill(0).map((_,n)=>sample.slice(0,-1)+n)});await eventually(()=>out('voiceprint_owner').length===1);
  assert.deepEqual(out('voiceprint_owner')[0].enrollment.samples.map((s:any)=>s.ok),[true,true,true,true,true,false]);
  assert.deepEqual(out('voiceprint_owner')[0].owner,{enrolled:false,reenrollment_required:false,samples:0});
  send({operation:'voiceprint_enroll',control_id:'c-2',sample_ids:Array(5).fill(0).map((_,n)=>sample.slice(0,-1)+n)});await eventually(()=>out('voiceprint_owner').length===2);
  assert.deepEqual(out('voiceprint_owner')[1],{schema_version:'paios.central.text-envelope.v1',operation:'voiceprint_owner',session_id:'continuity',control_id:'c-2',
    owner:{enrolled:true,reenrollment_required:false,samples:5,updated_at:now,consistency_min:0.81},enrollment:{status:'enrolled'},
    voice_devices:[{device_id:'mac',device_type:'phone'}],active_voice_device_id:'mac'});
  send({operation:'voiceprint_forget',control_id:'c-3'});await eventually(()=>out('voiceprint_owner').length===3);
  assert.equal(out('voiceprint_owner')[2].owner.enrolled,false);
  // Malformed sample ids never reach the runtime; a failing read is a rejection naming its control.
  send({operation:'voiceprint_enroll',control_id:'c-4',sample_ids:['../x']});send({operation:'voiceprint_read',control_id:'c-5'});
  await eventually(()=>out('rejected').length===2);
  assert.deepEqual(out('rejected').map(r=>[r.request_operation,r.control_id,r.error_code]).sort(),
    [['voiceprint_enroll','c-4','FORMAL_VOICEPRINT_INPUT_INVALID'],['voiceprint_read','c-5','FORMAL_TEXT_REQUEST_FAILED']]);
  assert.ok(calls.includes('audio')&&calls.includes('data'),'windows act on audio, enrollment on data, under the source permission');
  await bridge.close();
});
test('"确认是我": pending prompts are pushed to the paired phone and a tap confirms; only owner_unlock devices watch; other sessions are not followed',async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],confirmed:string[]=[],auths:(string|undefined)[]=[],followed:string[]=[],unwatched:string[]=[];
  let deliver:((pending:any[])=>Promise<void>)|undefined,device='phone',macUnlock=false;
  const id='c'.repeat(64),other='d'.repeat(64),native='f'.repeat(64),question='可以把这份报告发给小林吗？';
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:device,channel:'rtc_typed_text',...(device==='mac'&&macUnlock?{capabilities:['display','chat_ui','owner_unlock']}:{})}),
    formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async(_s:unknown,target:(pending:any[])=>Promise<void>)=>{deliver=target;return()=>{unwatched.push('confirmations');};},
    watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{unwatched.push('turns');},
    subscribeResult:async(_s:unknown,_session:unknown,d:string)=>{followed.push(d);return()=>{};},
    openVoiceTrustWindow:async(_s:unknown,session:string,sourceDeviceId:string,controlId:string)=>{
      assert.equal(session,'continuity');assert.equal(sourceDeviceId,'glasses');assert.equal(controlId,'train-glasses');return {confirmation_id:'a'.repeat(64)};},
    confirmVoice:async(_s:unknown,request:{confirmation_id:string;choice?:'approve'|'deny';auth?:string})=>{confirmed.push(request.confirmation_id);auths.push(request.auth);
      if(request.confirmation_id==='a'.repeat(64))return {approval:{confirmation_id:request.confirmation_id,choice:request.choice??'approve'}};
      // The integration runtime returns the native approval with its owner provenance (runtime.ts confirmVoice); only the wire fields may be published.
      if(request.confirmation_id===native)return {approval:{confirmation_id:native,choice:request.choice!,confirmed_by:'owner',
        surface:{device_id:'owner-phone',device_type:'phone'},confirmed_at:'2026-10-23T16:02:45.300Z'}};
      if(request.confirmation_id==='e'.repeat(64))throw new (await import('../../../services/personal-aios-integration/src/contracts.ts')).ContractError('VOICE_CONFIRMATION_EXPIRED',410);
      return {processed_event:{device_id:'mac',event_id:`voice-confirm:${request.confirmation_id}`,processed_event_id:'D-confirm-'+request.confirmation_id.slice(0,4)},
        admission:{state:'accepted',run_id:'run',idempotency_key:'key',session_id:request.confirmation_id===other?'glasses-session':'continuity'}};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);
  await eventually(()=>deliver!==undefined);
  await deliver!([{confirmation_id:id,event_id:`voice-confirm:${id}`,session_id:'continuity',processed_event_id:'D-1',expires_in_ms:118000,text:'依米，帮我叫车回家'}]);
  const pushed=(room.published as any[]).filter(p=>p.operation==='voice_confirmations');
  assert.deepEqual(pushed[0],{schema_version:'paios.central.text-envelope.v1',operation:'voice_confirmations',session_id:'continuity',
    confirmations:[{confirmation_id:id,event_id:`voice-confirm:${id}`,expires_in_ms:118000,text:'依米，帮我叫车回家'}]});
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'voice_confirm',confirmation_id:id,auth:'face_id'});await eventually(()=>followed.length===1);
  assert.equal(auths[0],'face_id','biometric marker reaches the confirmation authority');
  assert.deepEqual((room.published as any[]).find(p=>p.operation==='voice_confirmation_decided'),
    {schema_version:'paios.central.text-envelope.v1',operation:'voice_confirmation_decided',session_id:'continuity',confirmation_id:id,choice:'approve'});
  const accepted=(room.published as any[]).find(p=>p.operation==='accepted');
  assert.deepEqual([accepted.event_id,accepted.session_id,followed[0]],[`voice-confirm:${id}`,'continuity','D-confirm-cccc'],'the confirmed request is followed like a submission');
  send({operation:'voice_confirm',confirmation_id:other,auth:'face_id'});await eventually(()=>confirmed.length===2);await new Promise(r=>setTimeout(r,20));
  assert.equal(followed.length,1,'a request from another session is not followed on this one');
  assert.ok((room.published as any[]).some(p=>p.operation==='voice_confirmation_decided'&&p.confirmation_id===other),
    'the confirming terminal gets an explicit result even when the request belongs to another session');
  await deliver!([{confirmation_id:native,event_id:`approval:${native}`,expires_in_ms:60000,kind:'native_approval',text:question}]);
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='voice_confirmations').at(-1).confirmations,
    [{confirmation_id:native,event_id:`approval:${native}`,expires_in_ms:60000,kind:'native_approval',text:question}]);
  const scope_confirmation={grant_request:{scope_session_id:'scope:demo',target_id:'deck:demo',target_device_id:'mac',
    expires_at:new Date(Date.now()+7200000).toISOString(),allowed_operation_kinds:['document.text.update']},
    preview_items:['第 2 页：30 万杯 → 50 万杯']};
  await deliver!([{confirmation_id:native,event_id:`approval:${native}`,expires_in_ms:60000,kind:'native_approval',text:question,scope_confirmation}]);
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='voice_confirmations').at(-1).confirmations[0].scope_confirmation,scope_confirmation);
  for(const choice of ['approve','deny']) {
    send({operation:'voice_confirm',confirmation_id:native,choice});
    await eventually(()=>(room.published as any[]).filter(p=>p.operation==='voice_confirmation_decided').some(p=>p.confirmation_id===native&&p.choice===choice));
    assert.deepEqual((room.published as any[]).filter(p=>p.operation==='voice_confirmation_decided').at(-1),
      {schema_version:'paios.central.text-envelope.v1',operation:'voice_confirmation_decided',session_id:'continuity',confirmation_id:native,choice});
  }
  assert.equal(followed.length,1,'native decisions resume the original run without a new admission subscription');
  send({operation:'voice_trust_window_open',control_id:'train-glasses',source_device_id:'glasses'});
  await eventually(()=>(room.published as any[]).some(p=>p.operation==='voice_trust_window_opened'));
  assert.deepEqual((room.published as any[]).find(p=>p.operation==='voice_trust_window_opened'),
    {schema_version:'paios.central.text-envelope.v1',operation:'voice_trust_window_opened',session_id:'continuity',control_id:'train-glasses',confirmation_id:'a'.repeat(64)});
  await deliver!([{confirmation_id:'a'.repeat(64),event_id:'voice-confirm:'+ 'a'.repeat(64),expires_in_ms:60000,purpose:'trust_window',
    source_device_id:'glasses',source_device_type:'glasses',text:'接下来 1 分钟是我在说'}]);
  assert.equal((room.published as any[]).filter(p=>p.operation==='voice_confirmations').at(-1).confirmations[0].purpose,'trust_window');
  send({operation:'voice_confirm',confirmation_id:'a'.repeat(64),auth:'face_id'});
  await eventually(()=>(room.published as any[]).some(p=>p.operation==='voice_confirmation_decided'&&p.confirmation_id==='a'.repeat(64)));
  assert.equal(followed.length,1,'manual training grants its device without creating a conversational turn');

  send({operation:'voice_confirm',confirmation_id:'e'.repeat(64),auth:'face_id'});send({operation:'voice_confirm',confirmation_id:'not-hex'});
  send({operation:'voice_confirm',confirmation_id:native,choice:'always'});
  await eventually(()=>(room.published as any[]).filter(p=>p.operation==='rejected').length===3);
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='rejected').map(p=>[p.request_operation,p.error_code]).sort(),
    [['voice_confirm','FORMAL_VOICE_CONFIRM_INPUT_INVALID'],['voice_confirm','FORMAL_VOICE_CONFIRM_INPUT_INVALID'],['voice_confirm','VOICE_CONFIRMATION_EXPIRED']]);
  await deliver!([]);
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='voice_confirmations').at(-1).confirmations,[],'a decided or expired prompt leaves the phone');
  await bridge.close();await eventually(()=>unwatched.length===2);
  // A Mac without owner_unlock is not a confirmation terminal.
  device='mac';deliver=undefined;const mac=createFormalTextIngress({participant:{roomPort:testRoom()} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await mac.onBootstrapConnected(f.input);await new Promise(r=>setTimeout(r,20));assert.equal(deliver,undefined);await mac.close();
  macUnlock=true;const unlockedRoom=testRoom();
  const unlocked=createFormalTextIngress({participant:{roomPort:unlockedRoom} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>{errors.push(error);}});
  await unlocked.onBootstrapConnected(f.input);await eventually(()=>deliver!==undefined);
  await deliver!([{confirmation_id:id,event_id:`voice-confirm:${id}`,expires_in_ms:60000,text:'确认这条定向语音'}]);
  assert.equal((unlockedRoom.published as any[]).find(p=>p.operation==='voice_confirmations').confirmations[0].confirmation_id,id);
  await unlocked.close();
  assert.equal(errors.length,3,'the refused taps are reported, nothing else');
});
test('an ambient result is shown once while idle, retained during a call, and notified when the app is gone',async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],notices:unknown[]=[],spoken:string[]=[];
  const replies:((value:any)=>Promise<void>)[]=[];let seen:((d:any)=>void)|undefined;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async(_s:unknown,session:string,target:(d:any)=>void)=>{assert.equal(session,'continuity');seen=target;return()=>{seen=undefined;};},
    subscribeResult:async(_s:unknown,_session:unknown,_d:unknown,next:any)=>{replies.push(next);return()=>{};}} as unknown as PersonalAIOSRuntime;
  let live=false;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,notify:async notice=>{notices.push(notice);},
    voice_call:{open:async()=>{},close:async()=>{},pending:()=>live?'live':undefined,respond:async text=>{if(live)spoken.push(text);return live;},attach:()=>()=>{}},onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);await eventually(()=>seen!==undefined);
  const turn={processed_event_id:'processed:turn-1',content:{wake_request:{kind:'ambient_wake',text:'明天早上八点提醒我开会'}}};
  seen!(turn);seen!(turn);await eventually(()=>replies.length===1);await new Promise(r=>setTimeout(r,20));
  assert.equal(replies.length,1,'one projection per turn D, however often it is admitted');
  await replies[0]!({result:{},chunks:[{text:'好的，明早八点',final:false},{text:'提醒你开会。',final:true}]});
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='ambient_reply'),[{schema_version:'paios.central.text-envelope.v1',operation:'ambient_reply',
    session_id:'continuity',processed_event_id:'processed:turn-1',heard:'明天早上八点提醒我开会',text:'好的，明早八点提醒你开会。'}]);
  live=true;seen!({...turn,processed_event_id:'processed:turn-2'});await eventually(()=>replies.length===2);
  const deferredReply=replies[1]!({result:{},chunks:[{text:'现在 12 度。',final:true}]});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(spoken,[],'the call owns the conversation');
  assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,1);
  assert.deepEqual(notices,[],'ambient cannot interrupt through another channel');
  live=false;await deferredReply;
  assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply'&&p.text==='现在 12 度。').length,1,'call end delivers the retained reply once');
  seen!({...turn,processed_event_id:'processed:turn-3'});await eventually(()=>replies.length===3);
  seen!({...turn,processed_event_id:'processed:payment-turn'});await eventually(()=>replies.length===4);
  await bridge.close();await replies[2]!({result:{},chunks:[{text:'已经帮你记下了。',final:true}]});
  await replies[3]!({result:{private:'payment'},chunks:[{text:'一点点 ¥16.60 已处理',final:true}]});
  assert.deepEqual(notices,[{title:'依米',body:'已经帮你记下了。'},{title:'依米',body:'依米：付款结果已更新，解锁依米查看。'}]);assert.deepEqual(errors,[]);
});
test('ambient publication rechecks shared call ownership after awaiting authorization',async()=>{
  const f=fixture(),room=testRoom(),entered=deferred<void>(),release=deferred<void>();
  let busy=false,hold=false,show!: (id:string,text:string)=>Promise<unknown>;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(hold){entered.resolve();await release.promise;}return {principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};},
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,
    watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_source:unknown,callback:typeof show)=>{show=callback;return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,realtime_busy:()=>busy,onError:()=>{}});
  try{
    await bridge.onBootstrapConnected(f.input);hold=true;
    const publication=show('water','喝水');await entered.promise;busy=true;release.resolve();
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0);
    busy=false;assert.equal(await publication,'pending');
    assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply'&&p.text==='喝水').length,1);
  }finally{release.resolve();await bridge.close();}
});
test('care suggestion and errand phone record retain one publication during a call, rejoin and abort on close',async()=>{
  const f=fixture(),room=testRoom();let busy=false,readyCount=0;
  room.localParticipant.sendText=async()=>{readyCount++;};
  let show!:(id:string,text:string)=>Promise<unknown>,record!:(value:any,recordOnly:boolean,delivery:{first:boolean})=>Promise<unknown>;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,
    watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_source:unknown,callback:typeof show,_speak:unknown,_context:unknown,_live:unknown,errands:any)=>{show=callback;record=errands.reply;return()=>{};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,realtime_busy:()=>busy,errands:{cancel:async()=>false},onError:()=>{}});
  try{
    await bridge.onBootstrapConnected(f.input);busy=true;
    const suggestion=show('care:suggestion','喝点水吧'),value={result:{processed_event_id:'errand:record',reply_epoch:1,reply_text:'办好了'}};
    const first=record(value,true,{first:true}),repeat=record(value,true,{first:true});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0);
    assert.equal(await show('care:fall:checkin','你还好吗'),'pending','fall checkin remains immediate during a call');
    const peer=room.remoteParticipants.get('terminal')!;
    room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);
    room.remoteParticipants.set('terminal',peer);room.emit(RoomEvent.ParticipantConnected,peer);
    await eventually(()=>readyCount===2);
    assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0,'rejoin remains ready without waiting for call end');
    busy=false;assert.deepEqual(await Promise.all([suggestion,first,repeat]),['pending','pending','pending']);
    assert.deepEqual((room.published as any[]).filter(p=>p.operation==='ambient_reply').map(p=>p.text).sort(),['办好了','喝点水吧']);
    busy=true;const closing=show('care:later','休息一下'),rejected=assert.rejects(closing,/FORMAL_TEXT_CONNECTION_CHANGED/);
    await new Promise(resolve=>setTimeout(resolve,10));await bridge.close();await rejected;
    assert.equal((room.published as any[]).some(p=>p.text==='休息一下'),false);
  }finally{await bridge.close();}
});

test('call_open: the front opens with the owner context the runtime projects for this phone, session and fix; without one it still opens',async()=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],opened:unknown[][]=[],asked:unknown[][]=[];
  const phone={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};
  let fail=false,newest:unknown;
  // The runtime's one per-device fix store: a sent fix becomes the newest; without one the newest fresh fix is reused.
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,locate:async(_s:unknown,sent?:unknown)=>(newest=sent??newest),formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    callContext:async(source:unknown,session:string,fix:unknown)=>{asked.push([source,session,fix]);if(fail)throw new Error('memory down');return '【关于主人】\n- 主人叫示例用户';}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_call:{open:async(id,extra)=>{
      const context=typeof extra?.context==='function'?await extra.context():extra?.context;
      opened.push([id,context?{context}:{}]);},close:async()=>{},
      respond:async()=>false,attach:()=>()=>{}},onError:error=>{errors.push(error);}});
  await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const location={latitude:31.2397,longitude:121.4998,accuracy_m:20,observed_at:new Date().toISOString(),datum:'wgs84',place:'上海市陆家嘴（公开地标）'};
  send({operation:'call_open',call_id:'call-1',location});await eventually(()=>opened.length===1);
  assert.deepEqual(asked,[[phone,'continuity',location]]);
  const projectedFix=asked[0]![2] as {latitude:number;longitude:number;place:string};
  assert.deepEqual([projectedFix.latitude,projectedFix.longitude,projectedFix.place],
    [31.2397,121.4998,'上海市陆家嘴（公开地标）'],'the call context receives the public landmark coordinate and matching label');
  assert.deepEqual(opened[0],['call-1',{context:'【关于主人】\n- 主人叫示例用户'}]);
  fail=true;send({operation:'call_open',call_id:'call-2'});await eventually(()=>opened.length===2);
  assert.deepEqual(asked[1],[phone,'continuity',location],'a call without its own fix reuses the fresh one');
  assert.deepEqual(opened[1],['call-2',{}],'the call opens without context when the projection fails');
  assert.equal(errors.length,1);
  await bridge.close();
});
test('call capture readiness blocks live and a failed first capture can reopen the same call without poisoned observations',async t=>{
  const f=fixture(),room=testRoom(),capture=Promise.withResolvers<void>(),errors:unknown[]=[],closed:string[]=[],turns:string[]=[];
  const failure=new Error('CALL_CAPTURE_SOURCE_UNAVAILABLE'),source={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text',capabilities:['owner_unlock']};
  let captures=0,fronts=0,sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>source,locate:async()=>undefined,
    cameraReady:async()=>{},movementReady:async()=>{},terminalChanged:()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},
    watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    submitCallTurn:async(raw:RawEvent)=>{turns.push(raw.event_id);return {processed_event:{processed_event_id:'captured-turn'},admission:null};},
    closeCall:async(_source:unknown,_session:unknown,closure:{call_id:string})=>{closed.push(closure.call_id);}} as unknown as PersonalAIOSRuntime);
  const ready=runtime.captureCall.bind(runtime);
  t.mock.method(runtime,'captureCall',async(...args:Parameters<PersonalAIOSRuntime['captureCall']>)=>{if(++captures===1){await capture.promise;throw failure;}return ready(...args);});
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createFront:()=>{fronts++;return {connect:async()=>{},close:()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{}};},
    createPlayout:()=>({open:async()=>{},close:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{}}),
    onState:(...args)=>sink?.state(...args),onSealed:(...args)=>sink?.sealed?.(...args),onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{...call,attach:value=>{sink=value;return()=>{sink=undefined;};}}});
  try{
    await bridge.onBootstrapConnected(f.input);
    const opening=call.open('capture-retry',{source:source as never,continuity:'continuity'});
    const settled=Promise.allSettled([opening]);await eventually(()=>captures===1);await new Promise(setImmediate);
    const premature=call.active();capture.resolve();const [result]=await settled;
    assert.equal(premature,undefined,'a source capture pending at opening cannot become live');assert.equal(result!.status,'rejected');
    if(result!.status==='rejected')assert.equal(result.reason,failure);
    assert.equal(fronts,0,'source rejection precedes provider allocation');assert.deepEqual(turns,[]);assert.deepEqual(closed,[]);
    await call.open('capture-retry',{source:source as never,continuity:'continuity'});assert.equal(captures,2);assert.equal(call.active(),'capture-retry');
    await sink!.turn({call_id:'capture-retry',turn:0,user:'controlled recovered turn',assistant:'',interrupted:false,speaker:'owner',route:'front_only'});
    await call.close('capture-retry','button');await call.closeAll();
    assert.equal(turns.length,1);assert.deepEqual(closed,['capture-retry']);assert.ok(errors.every(error=>error===failure));
  }finally{capture.resolve();await Promise.allSettled([call.closeAll(),bridge.close()]);}
});

test('call_open failures settle the requested call once with a safe terminal state',async()=>{
  for(const stage of ['permission','owner','open','emitted','closed-emitted','unsafe-emitted'] as const){
    const f=fixture(),room=testRoom(),errors:unknown[]=[];
    let sink:Parameters<NonNullable<Parameters<typeof createFormalTextIngress>[0]['voice_call']>['attach']>[0]|undefined;
    const failure=new Error('private provider credential must not escape');
    const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),cameraReady:async()=>{},movementReady:async()=>{},
      formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>{if(stage==='permission')throw new ContractError('MEDIA_CAPTURE_NOT_CONNECTED',403);return consume();},
      ownerInput:async()=>{if(stage==='owner')throw failure;},
      watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{
        open:async id=>{if(stage==='closed-emitted')await sink?.state(id,'closed',{reason:'error'});
          if(stage==='unsafe-emitted')await sink?.state(id,'failed',{error_code:failure.message});
          if(stage==='emitted'||stage==='closed-emitted')await sink?.state(id,'failed',{error_code:'VOICE_CALL_OPEN_FAILED'});throw failure;},
        close:async()=>{},respond:async()=>false,attach:value=>{sink=value;return()=>{};}}});
    try{
      await bridge.onBootstrapConnected(f.input);
      room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_open',call_id:`failed-${stage}`})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
      await eventually(()=>errors.length>0);await new Promise(setImmediate);
      const terminal=(room.published as any[]).filter(p=>p.operation==='call_state'&&p.call_id===`failed-${stage}`&&p.state==='failed');
      assert.equal(terminal.length,1,`${stage}: ${errors.map(error=>error instanceof Error?error.stack:String(error))}`);
      assert.equal(terminal[0].reason,'error');
      assert.equal(terminal[0].error_code,stage==='permission'?'MEDIA_CAPTURE_NOT_CONNECTED':'VOICE_CALL_OPEN_FAILED');
      assert.equal((room.published as any[]).some(p=>p.operation==='rejected'),false,stage);
      assert.equal(JSON.stringify(room.published).includes(failure.message),false);
    }finally{await bridge.close();}
  }
});
test('a second authenticated owner call replaces the first and aborts its pending context',async()=>{
  const f=fixture(),room=testRoom(),firstContext=Promise.withResolvers<string>(),errors:unknown[]=[];
  let inputs=0,contexts=0;const contextSignals:AbortSignal[]=[];
  let sink:Parameters<NonNullable<Parameters<typeof createFormalTextIngress>[0]['voice_call']>['attach']>[0]|undefined;
  const call=createVoiceCallSession({room:()=>({}),createFront:()=>({connect:async()=>{},close:()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{}}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    onState:(...args)=>sink?.state(...args),onSealed:(...args)=>sink?.sealed?.(...args),onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),cameraReady:async()=>{},movementReady:async()=>{},
    locate:async()=>undefined,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    ownerInput:async()=>{inputs++;},closeCall:async()=>{},
    callContext:async(_source:unknown,_session:string,_fix:unknown,_turn:unknown,signal:AbortSignal)=>{contextSignals.push(signal);return ++contexts===1?firstContext.promise:'第二次通话的上下文';},
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_call:{...call,attach:value=>{sink=value;return()=>{sink=undefined;};}},onError:error=>errors.push(error)});
  const send=(operation:string,call_id:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation,call_id})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const failures=(id:string)=>(room.published as any[]).filter(p=>p.operation==='call_state'&&p.call_id===id&&p.state==='failed');
  try{
    await bridge.onBootstrapConnected(f.input);send('call_open','first-owner');await eventually(()=>contexts===1);
    assert.equal(call.pending(),'first-owner');send('call_open','second-owner');
    await eventually(()=>call.active()==='second-owner');
    assert.equal(inputs,2);assert.equal(contexts,2);
    assert.equal(contextSignals[0].aborted,true);assert.equal(contextSignals[1].aborted,false);
    const states=(room.published as any[]).filter(p=>p.operation==='call_state').map(p=>`${p.call_id}:${p.state}`);
    assert.ok(states.includes('first-owner:closing'));assert.ok(states.includes('first-owner:closed'));
    assert.ok(states.indexOf('first-owner:closed')<states.indexOf('second-owner:live'));
    assert.ok(failures('first-owner').length<=1);assert.equal(failures('second-owner').length,0);
    assert.ok(errors.every(error=>error instanceof ContractError&&error.code==='VOICE_CALL_SUPERSEDED'));
  }finally{firstContext.resolve('旧通话的上下文');await call.closeAll();await bridge.close();}
});
for(const outcome of ['replace','reject'] as const)test(`manual dial replacement ${outcome}: concurrent requests and old close failures settle once`,async()=>{
    const f=fixture(),room=testRoom(),firstContext=Promise.withResolvers<string>(),retired=Promise.withResolvers<void>(),errors:unknown[]=[];
    const retirementError=new Error('private retirement provider detail'),entered:string[]=[];let inputs=0,contexts=0,closing=0;
    let sink:Parameters<NonNullable<Parameters<typeof createFormalTextIngress>[0]['voice_call']>['attach']>[0]|undefined;
    const call=createVoiceCallSession({room:()=>({}),createFront:()=>({connect:async()=>{},close:()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{}}),
      createPlayout:(_room,id)=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{if(id==='first-owner'){closing++;await retired.promise;}}}),
      onState:(...args)=>sink?.state(...args),onSealed:(...args)=>sink?.sealed?.(...args),onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
    const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),cameraReady:async()=>{},movementReady:async()=>{},
      locate:async()=>undefined,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
      ownerInput:async()=>{inputs++;},closeCall:async()=>{},callContext:async()=>++contexts===1?firstContext.promise:'最新通话的上下文',
      watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}} as unknown as PersonalAIOSRuntime);
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_call:{...call,open:async(...args)=>{entered.push(args[0]);return call.open(...args);},attach:value=>{sink=value;return()=>{sink=undefined;};}},onError:error=>errors.push(error)});
    const send=(call_id:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_open',call_id})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    const failures=(id:string)=>(room.published as any[]).filter(p=>p.operation==='call_state'&&p.call_id===id&&p.state==='failed');
    try{
      await bridge.onBootstrapConnected(f.input);send('first-owner');await eventually(()=>contexts===1);
      send('second-owner');await eventually(()=>closing===1);
      send('third-owner');await eventually(()=>entered.includes('third-owner'));
      if(outcome==='replace'){
        retired.resolve();
        await eventually(()=>call.active()==='third-owner'&&failures('second-owner').length===1);
        assert.equal(failures('second-owner')[0].error_code,'VOICE_CALL_SUPERSEDED');
        assert.equal(contexts,2);assert.equal(failures('third-owner').length,0);
        assert.equal((room.published as any[]).some(p=>p.operation==='call_state'&&p.call_id==='second-owner'&&p.state==='opening'),false);
      }else{
        retired.reject(retirementError);await eventually(()=>failures('second-owner').length===1&&failures('third-owner').length===1);
        assert.equal(failures('second-owner')[0].error_code,'VOICE_CALL_SUPERSEDED');
        assert.equal(failures('third-owner')[0].error_code,'VOICE_CALL_OPEN_FAILED');
        assert.equal(failures('third-owner')[0].reason,'error');
        assert.equal(call.pending(),undefined);assert.equal(contexts,1);assert.equal(inputs,3);
        assert.equal(JSON.stringify(room.published).includes(retirementError.message),false);
        const states=(room.published as any[]).filter(p=>p.operation==='call_state').map(p=>`${p.call_id}:${p.state}`);
        assert.ok(states.includes('first-owner:closed'));
        assert.ok(states.indexOf('first-owner:closed')<states.indexOf('third-owner:failed'));
      }
      await new Promise(setImmediate);assert.equal(failures('second-owner').length,1);
      assert.equal(failures('second-owner')[0].reason,'error');assert.ok(failures('first-owner').length<=1);assert.equal(closing,1);
    }finally{retired.resolve();firstContext.resolve('旧通话的上下文');await call.closeAll();await bridge.close();}
});
test('manual call reserves before context projection; hangup cancels while transport loss preserves its owner',async()=>{
  for(const action of ['hangup','disconnect'] as const){
    const f=fixture(),room=testRoom(),context=Promise.withResolvers<string>(),errors:unknown[]=[],states:string[]=[];
    let reads=0,fronts=0;const outputRoom={};
    const call=createVoiceCallSession({room:()=>outputRoom,createFront:()=>{fronts++;return {connect:async()=>{},close:()=>{},
      appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{}};},
      createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      onState:(_id,state)=>states.push(state),onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
    const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>({principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'}),
      locate:async()=>undefined,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
      watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
      callContext:async()=>{reads++;return context.promise;}} as unknown as PersonalAIOSRuntime;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_call:{...call,attach:()=>()=>{}},onError:error=>errors.push(error)});
    await bridge.onBootstrapConnected(f.input);
    const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    send({operation:'call_open',call_id:'deferred-owner'});
    await eventually(()=>reads===1);assert.equal(call.pending(),'deferred-owner');assert.equal(fronts,0);
    if(action==='hangup')send({operation:'call_close',call_id:'deferred-owner'});else room.emit(RoomEvent.Disconnected);
    if(action==='hangup'){
      await eventually(()=>call.pending()===undefined);context.resolve('PRIVATE_OWNER_CONTEXT');await eventually(()=>errors.length>0);
      assert.equal(fronts,0);assert.equal(states.includes('live'),false);
    }else{
      await new Promise(setImmediate);assert.equal(call.pending(),'deferred-owner');context.resolve('PRIVATE_OWNER_CONTEXT');
      room.emit(RoomEvent.Reconnected);await eventually(()=>states.includes('live'));
      assert.equal(call.pending(),'deferred-owner');assert.equal(fronts,1,'the reserved call continues without another call_open');
    }
    await bridge.close();await call.closeAll();
  }
});

const healthID='0f8fad5b-d9cb-469f-a165-70867728950e';
const healthPage=()=>({operation:'health_batch',control_id:'health-page-1',metric:'stepCount',unit:'count',tz:'UTC',sources:['watch'],
  samples:[{id:healthID,s:Date.parse(now),e:Date.parse(now)+60000,src:0,v:123}],deleted:[]});
async function healthBridge(phone=true,ingest?: (source:any,batch:HealthBatch)=>unknown, extra:object={}) {
  const f=fixture(phone),room=testRoom(),errors:unknown[]=[],received:{source:any;batch:HealthBatch}[]=[];
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:(credential:unknown)=>f.authority.authenticate(credential),watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    ...extra,ingestHealth:async(source:any,batch:HealthBatch)=>{received.push({source,batch});return ingest?await ingest(source,batch):{stored:batch.samples.length,deleted:batch.deleted.length};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
  await bridge.onBootstrapConnected(f.input);
  return {...f,room,errors,received,bridge,send:(body:unknown,identity='terminal')=>room.emit(RoomEvent.DataReceived,
    Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC),
    out:(operation:string)=>(room.published as any[]).filter(p=>p.operation===operation)};
}
test('health formal route authenticates each page and binds principal to the paired phone',async t=>{
  const f=await healthBridge();t.after(()=>f.bridge.close());
  f.send(healthPage(),'wrong-participant');await new Promise(r=>setTimeout(r,15));assert.equal(f.received.length,0);
  f.send(healthPage());await eventually(()=>f.out('health_ack').length===1);
  assert.deepEqual(f.out('health_ack')[0],{operation:'health_ack',schema_version:'paios.central.text-envelope.v1',session_id:'continuity',
    control_id:'health-page-1',stored:1,deleted:0});
  assert.equal(f.received[0]!.source.principal_id,'actual-owner');assert.equal(f.received[0]!.source.device_type,'phone');
  assert.equal('principal_id' in f.received[0]!.batch,false);
  f.send({...healthPage(),principal_id:'forged'});await eventually(()=>f.out('rejected').length===1);
  assert.equal(f.out('rejected')[0].error_code,'HEALTH_BATCH_INVALID');assert.equal(f.received.length,1);
  (f.current.session as {userId:string}).userId='another-owner';f.send(healthPage());await eventually(()=>f.errors.some(error=>/OWNER_BINDING_DENIED/.test(String(error))));
  assert.equal(f.out('rejected').length,1,'revoked owner receives no packet');assert.equal(f.received.length,1);
  (f.current.session as {userId:string}).userId='actual-owner';await f.bridge.onBootstrapConnected(f.input);
  (f.current.lease as {deviceId:string}).deviceId='another-phone';const errorsBefore=f.errors.length;
  f.send(healthPage());await eventually(()=>f.errors.slice(errorsBefore).some(error=>/OWNER_BINDING_DENIED/.test(String(error))));
  assert.equal(f.out('rejected').length,1);assert.equal(f.received.length,1);
  const mac=await healthBridge(false);t.after(()=>mac.bridge.close());mac.send(healthPage());await eventually(()=>mac.out('rejected').length===1);
  assert.equal(mac.out('rejected')[0].error_code,'HEALTH_DEVICE_REQUIRED');assert.equal(mac.received.length,0);
});
test('health formal contract rejects malformed values, variants and page bounds before ingest',async t=>{
  const f=await healthBridge();t.after(()=>f.bridge.close());const page=healthPage(),sample=page.samples[0]!;
  const invalid=[{...page,samples:Array(65).fill(sample)},{...page,deleted:Array(129).fill(healthID)},
    {...page,sources:Array(17).fill('watch')},{...page,sources:['a'.repeat(161)]},{...page,sources:['']},
    {...page,samples:[{...sample,id:healthID.toUpperCase()}]},{...page,deleted:['../sample']},
    {...page,samples:[{...sample,s:1.2}]},{...page,samples:[{...sample,e:Number.MAX_SAFE_INTEGER+1}]},
    {...page,samples:[{...sample,src:-1}]},{...page,samples:[{...sample,src:16}]},
    {...page,samples:[{...sample,v:'123'}]},{...page,samples:[{...sample,v:null}]},
    {...page,samples:[{...sample,c:3}]},{...page,samples:[{id:healthID,s:sample.s,e:sample.e,src:0}]},
    {...page,samples:[{id:healthID,s:sample.s,e:sample.e,src:0,c:6}]},
    {...page,samples:[{id:healthID,s:sample.s,e:sample.e,src:0,w:{type:37,dur:-1}}]},
    {...page,samples:[{id:healthID,s:sample.s,e:sample.e,src:0,w:{type:37,dur:60,kcal:-1}}]},
    {...page,samples:[{id:healthID,s:sample.s,e:sample.e,src:0,w:{type:37,dur:60,unexpected:1}}]}];
  for(const body of invalid){const rejected=f.out('rejected').length;f.send(body);await eventually(()=>f.out('rejected').length>rejected);
    assert.equal(f.out('rejected').at(-1).error_code,'HEALTH_BATCH_INVALID');}
  assert.equal(f.received.length,0);
  // Shape accepts the platform's category and workout variants; metric-specific semantics belong to HEALTH.
  for(const body of [{...page,metric:'sleepAnalysis',unit:'category-code',samples:[{id:healthID,s:sample.s,e:sample.e,src:0,c:3}]},
    {...page,metric:'workout',unit:'workout',samples:[{id:healthID,s:sample.s,e:sample.e,src:0,w:{type:37,dur:60,kcal:20,dist:200}}]},
    {...page,samples:[],sources:[],deleted:[healthID]}]){
    const acknowledged=f.out('health_ack').length;f.send(body);await eventually(()=>f.out('health_ack').length>acknowledged);
  }
  assert.equal(f.received.length,3);
});
test('health formal ACK follows durable ingest; lost ACK and reconnect retry preserve the page receipt',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'formal-health-')),store=HealthStore.open(root,()=>Date.parse(now)+3600000);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const ingest=(source:any,batch:HealthBatch)=>store.ingest(source.principal_id,source.device_id,batch);
  const f=await healthBridge(true,ingest);t.after(()=>f.bridge.close());let lost=true;
  const publish=f.room.localParticipant.publishData;
  f.room.localParticipant.publishData=async(bytes:Uint8Array)=>{const packet=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(packet.operation==='health_ack'&&lost){lost=false;throw new Error('lost health ACK');}await publish(bytes);};
  f.send(healthPage());await eventually(()=>f.errors.length===1);
  assert.equal(f.out('health_ack').length,0);assert.equal(store.days('actual-owner',metricByWire('stepCount')!,'2026-10-01','2026-10-01','UTC')[0]!.samples,1);
  await f.bridge.close();const retry=await healthBridge(true,ingest);t.after(()=>retry.bridge.close());retry.send(healthPage());
  await eventually(()=>retry.out('health_ack').length===1);assert.deepEqual(retry.out('health_ack')[0],{operation:'health_ack',
    schema_version:'paios.central.text-envelope.v1',session_id:'continuity',control_id:'health-page-1',stored:1,deleted:0});
  assert.equal(store.days('actual-owner',metricByWire('stepCount')!,'2026-10-01','2026-10-01','UTC')[0]!.samples,1);
  retry.send({...healthPage(),control_id:'health-delete-1',samples:[],deleted:[healthID]});await eventually(()=>retry.out('health_ack').length===2);
  assert.equal(retry.out('health_ack')[1].deleted,1);
  assert.deepEqual(store.days('actual-owner',metricByWire('stepCount')!,'2026-10-01','2026-10-01','UTC'),[]);
  // Deleted samples stay deleted even if an older page is delivered after reconnect.
  retry.send({...healthPage(),control_id:'health-late-page'});await eventually(()=>retry.out('health_ack').length===3);
  assert.equal(retry.out('health_ack')[2].stored,0);
});
test('health formal route waits for async ingest and returns semantic failures without ACK',async t=>{
  const gate=deferred<void>();let fail=false;
  const f=await healthBridge(true,async()=>{await gate.promise;if(fail)throw new Error('private failure');return {stored:1,deleted:0};});
  t.after(()=>f.bridge.close());f.send(healthPage());await eventually(()=>f.received.length===1);
  assert.equal(f.out('health_ack').length,0);gate.resolve();await eventually(()=>f.out('health_ack').length===1);
  fail=true;f.send({...healthPage(),control_id:'failed-page'});await eventually(()=>f.out('rejected').length===1);
  assert.equal(f.out('health_ack').length,1);assert.equal(f.out('rejected')[0].error_code,'FORMAL_TEXT_REQUEST_FAILED');
  assert.equal(JSON.stringify(f.out('rejected')).includes('private failure'),false);
});

const contactsPage=()=>({operation:'contacts_batch',control_id:'contacts-page-1',contacts:[{id:'opaque:card/1',name:'Synthetic card',
  phones:[{number:'+1 (000) 123-4567',label:'mobile'}],relations:[{label:'mother',name:'Named person'}]}],deleted:[]});
async function contactsBridge(phone=true,ingest?: (source:any,batch:ContactsBatch)=>unknown) {
  const f=fixture(phone),room=testRoom(),errors:unknown[]=[],received:{source:any;batch:ContactsBatch}[]=[];
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:(credential:unknown)=>f.authority.authenticate(credential),watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    ingestContacts:async(source:any,batch:ContactsBatch)=>{received.push({source,batch});return ingest?await ingest(source,batch):{stored:batch.contacts.length,deleted:batch.deleted.length};}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
  await bridge.onBootstrapConnected(f.input);
  return {...f,room,errors,received,bridge,send:(body:unknown,identity='terminal')=>room.emit(RoomEvent.DataReceived,
    Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC),
    out:(operation:string)=>(room.published as any[]).filter(p=>p.operation===operation)};
}
test('contacts formal route authenticates each page and preserves raw directed card relationships',async t=>{
  const f=await contactsBridge();t.after(()=>f.bridge.close());
  f.send(contactsPage(),'wrong-participant');await new Promise(r=>setTimeout(r,15));assert.equal(f.received.length,0);
  f.send(contactsPage());await eventually(()=>f.out('contacts_ack').length===1);
  assert.deepEqual(f.out('contacts_ack')[0],{operation:'contacts_ack',schema_version:'paios.central.text-envelope.v1',session_id:'continuity',
    control_id:'contacts-page-1',stored:1,deleted:0});
  assert.equal(f.received[0]!.source.principal_id,'actual-owner');assert.equal(f.received[0]!.source.device_type,'phone');
  const {operation,...expected}=contactsPage();assert.deepEqual(f.received[0]!.batch,expected,'gateway adds no owner relationship or normalized phone');
  f.send({...contactsPage(),principal_id:'forged'});await eventually(()=>f.out('rejected').length===1);
  assert.equal(f.out('rejected')[0].error_code,'CONTACTS_BATCH_INVALID');assert.equal(f.received.length,1);
  (f.current.session as {userId:string}).userId='another-owner';f.send(contactsPage());await eventually(()=>f.errors.some(error=>/OWNER_BINDING_DENIED/.test(String(error))));
  assert.equal(f.out('rejected').length,1,'revoked owner receives no packet');assert.equal(f.received.length,1);
  (f.current.session as {userId:string}).userId='actual-owner';await f.bridge.onBootstrapConnected(f.input);
  (f.current.lease as {deviceId:string}).deviceId='another-phone';const errorsBefore=f.errors.length;
  f.send(contactsPage());await eventually(()=>f.errors.slice(errorsBefore).some(error=>/OWNER_BINDING_DENIED/.test(String(error))));assert.equal(f.out('rejected').length,1);assert.equal(f.received.length,1);
  const mac=await contactsBridge(false);t.after(()=>mac.bridge.close());mac.send(contactsPage());await eventually(()=>mac.out('rejected').length===1);
  assert.equal(mac.out('rejected')[0].error_code,'CONTACTS_DEVICE_REQUIRED');assert.equal(mac.received.length,0);
});
test('contacts formal contract bounds closed card shapes and uses the sole formal packet limit',async t=>{
  const f=await contactsBridge();t.after(()=>f.bridge.close());const page=contactsPage(),card=page.contacts[0]!;
  const invalid=[{...page,contacts:Array(17).fill(card)},{...page,deleted:Array(129).fill('id')},
    {...page,contacts:[{...card,id:''}]},{...page,contacts:[{...card,id:'x'.repeat(257)}]},
    {...page,contacts:[{...card,name:'x'.repeat(161)}]},{...page,deleted:['x'.repeat(257)]},
    {...page,contacts:[{...card,phones:Array(17).fill(card.phones[0])}]},
    {...page,contacts:[{...card,relations:Array(17).fill(card.relations[0])}]},
    {...page,contacts:[{...card,phones:[{number:'',label:''}]}]},
    {...page,contacts:[{...card,phones:[{number:'0'.repeat(81),label:''}]}]},
    {...page,contacts:[{...card,phones:[{number:'0',label:'x'.repeat(81)}]}]},
    {...page,contacts:[{...card,relations:[{label:'',name:'person'}]}]},
    {...page,contacts:[{...card,relations:[{label:'friend',name:''}]}]},
    {...page,contacts:[{...card,relations:[{label:'x'.repeat(81),name:'person'}]}]},
    {...page,contacts:[{...card,relations:[{label:'friend',name:'x'.repeat(161)}]}]},
    {...page,contacts:[{...card,owner_relation:'mother'}]},
    {...page,contacts:[{...card,phones:[{number:'0',label:'mobile',emergency:true}]}]},
    {...page,contacts:[{...card,relations:[{label:'friend',name:'person',owner_id:'forged'}]}]}];
  for(const body of invalid){const rejected=f.out('rejected').length;f.send(body);await eventually(()=>f.out('rejected').length>rejected);
    assert.equal(f.out('rejected').at(-1).error_code,'CONTACTS_BATCH_INVALID');}
  assert.equal(f.received.length,0);
  f.send({...page,contacts:[{...card,name:'',phones:[{number:'0',label:''}],relations:[]}]});await eventually(()=>f.out('contacts_ack').length===1);
  // A schema-valid dense page can exceed the transport byte budget. No second CONTACTS byte limit exists.
  const dense={...page,contacts:[{...card,relations:Array(16).fill({label:'r'.repeat(80),name:'n'.repeat(160)})},
    {...card,id:'second',relations:Array(16).fill({label:'r'.repeat(80),name:'n'.repeat(160)})}]};
  assert.ok(Buffer.byteLength(JSON.stringify(dense))>8192);f.send(dense);await eventually(()=>f.out('rejected').length===invalid.length+1);
  assert.equal(f.out('rejected').at(-1).error_code,'FORMAL_TEXT_PACKET_TOO_LARGE');assert.equal(f.received.length,1);
});
test('contacts formal durable ACK replay, update, delete and atomic conflict use isolated SQLite',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'formal-contacts-')),store=ContactsStore.open(root,()=>Date.parse(now));
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const f=await contactsBridge(true,(source,batch)=>store.ingest(source.principal_id,source.device_id,batch));t.after(()=>f.bridge.close());
  let lost=true;const publish=f.room.localParticipant.publishData;
  f.room.localParticipant.publishData=async(bytes:Uint8Array)=>{const p=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(p.operation==='contacts_ack'&&lost){lost=false;throw new Error('lost contacts ACK');}await publish(bytes);};
  f.send(contactsPage());await eventually(()=>f.errors.length===1);assert.equal(f.out('contacts_ack').length,0);
  assert.equal(store.search('actual-owner',{name:'Synthetic card'}).contacts.length,1);
  f.send(contactsPage());await eventually(()=>f.out('contacts_ack').length===1);
  assert.deepEqual(f.out('contacts_ack')[0],{operation:'contacts_ack',schema_version:'paios.central.text-envelope.v1',session_id:'continuity',control_id:'contacts-page-1',stored:1,deleted:0});
  const changed={...contactsPage(),contacts:[{...contactsPage().contacts[0]!,name:'Changed card'}]};
  f.send(changed);await eventually(()=>f.out('rejected').length===2);
  assert.equal(f.out('rejected').at(-1).error_code,'CONTACTS_BATCH_CONFLICT');
  assert.equal(store.search('actual-owner',{name:'Changed card'}).contacts.length,0);
  f.send({...changed,control_id:'contacts-update-1'});await eventually(()=>f.out('contacts_ack').length===2);
  assert.equal(store.search('actual-owner',{name:'Changed card'}).contacts.length,1);
  const deletion={...contactsPage(),control_id:'contacts-delete-1',contacts:[],deleted:['opaque:card/1']};
  f.send(deletion);await eventually(()=>f.out('contacts_ack').length===3);assert.equal(f.out('contacts_ack')[2].deleted,1);
  f.send(deletion);await eventually(()=>f.out('contacts_ack').length===4);assert.equal(f.out('contacts_ack')[3].deleted,1);
  f.send({...deletion,control_id:'contacts-delete-2'});await eventually(()=>f.out('contacts_ack').length===5);assert.equal(f.out('contacts_ack')[4].deleted,0);
  assert.equal(store.search('actual-owner',{name:'Changed card'}).contacts.length,0);
  f.send({...contactsPage(),control_id:'duplicate-cards',contacts:Array(2).fill(contactsPage().contacts[0])});await eventually(()=>f.out('rejected').length===3);
  assert.equal(f.out('rejected').at(-1).error_code,'CONTACTS_BATCH_INVALID');
  assert.equal(store.search('actual-owner',{name:'Synthetic card'}).contacts.length,0,'malformed page leaves no partial write');
});
test('contacts formal ACK waits for async durable ingest and omits raw failure details',async t=>{
  const gate=deferred<void>();let fail=false;
  const f=await contactsBridge(true,async()=>{await gate.promise;if(fail)throw new Error('private contacts failure');return {stored:1,deleted:0};});
  t.after(()=>f.bridge.close());f.send(contactsPage());await eventually(()=>f.received.length===1);
  assert.equal(f.out('contacts_ack').length,0);gate.resolve();await eventually(()=>f.out('contacts_ack').length===1);
  fail=true;f.send({...contactsPage(),control_id:'contacts-failed'});await eventually(()=>f.out('rejected').length===1);
  assert.equal(f.out('contacts_ack').length,1);assert.equal(f.out('rejected')[0].error_code,'FORMAL_TEXT_REQUEST_FAILED');
  assert.equal(JSON.stringify(f.out('rejected')).includes('private contacts failure'),false);
});

test('voice settings, ambient handoff, current confirmation facts and playback retirement cross the pinned formal contract',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'wake-front-fact-'));let clock=Date.now();
  const confirmations=new VoiceConfirmations(new PosixStorage(directory),{ttl_ms:1000,now:()=>clock});
  t.after(async()=>{confirmations.close();await fs.rm(directory,{recursive:true,force:true});});
  const f=fixture(),room=testRoom(),errors:unknown[]=[],opened:{id:string;extra:any}[]=[],careWords:string[]=[];
  let handlers:any,seen:((d:ProcessedEvent)=>void)|undefined,show:((id:string,text:string)=>Promise<boolean>)|undefined,speak:((text:string,origin?:VoiceResultOrigin)=>Promise<boolean>)|undefined,contextReads=0;const contextScopes:unknown[]=[],scopes:unknown[]=[],spoken:unknown[]= [];
  let wake:((value:any)=>Promise<boolean>)|undefined,sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined,current:string|undefined,failOpen=false;
  const phone={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,locate:async()=>undefined,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    watchPayments:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_d:unknown,fn:any,voice:any)=>{show=fn;speak=voice;return()=>{};},watchAmbientTurns:async(_d:unknown,_s:string,fn:any)=>{seen=fn;return()=>{};},
    voiceConfirmationFact:(d:ProcessedEvent)=>PersonalAIOSRuntime.prototype.voiceConfirmationFact.call({confirmations} as unknown as PersonalAIOSRuntime,d),replyPrivacy:async()=>({}),callTranscript:async(_d:unknown,text:string,interrupted:boolean)=>{careWords.push(`${interrupted}:${text}`);},callContext:async(...args:unknown[])=>{contextReads++;contextScopes.push(args[5]);return 'owner context';},subscribeResult:async(_d:unknown,_s:string,_id:string,fn:any)=>{await fn({result:{},chunks:[{text:'scoped answer',final:true}]});return()=>{};},
    watchAmbientVoice:async(_d:unknown,_s:string,fn:any,options:any)=>{wake=fn;handlers=options;return()=>{wake=undefined;};}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_call:{open:async(id,extra)=>{if(current&&extra?.intent==='automatic')throw new ContractError('VOICE_CALL_BUSY',409);if(failOpen)throw new Error('care greeting failed');current=id;await sink?.state(id,'opening',{mode:extra?.mode??'manual'});
      if(typeof extra?.context==='function')await extra.context();opened.push({id,extra});},
      close:async()=>{current=undefined;},pending:()=>current,respond:async(text,target,care)=>{spoken.push({text,target,...(care?{care}: {})});return !target||target.call_id===current;},
      identify:async(id,scope,context)=>{scopes.push({id,scope,...(scope==='owner'?{context:await context?.()}: {})});return true;},attach:value=>{sink=value;return()=>{sink=undefined;};}},
    onError:error=>errors.push(error)});
  await bridge.onBootstrapConnected(f.input);await eventually(()=>!!wake);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  for(const ms of [180000,600000,1800000,0]){send({operation:'call_open',call_id:`call-${ms}`,silence_timeout_ms:ms});
    await eventually(()=>opened.at(-1)?.id===`call-${ms}`);assert.equal(opened.at(-1)!.extra.silence_timeout_ms,ms);}
  send({operation:'call_open',call_id:'invalid',silence_timeout_ms:1000});await eventually(()=>errors.length===1);
  assert.equal(opened.length,4,'invalid timeout is refused before call authority');
  current=undefined;
  const input={id:'verified-wake',text:'几点了',start_ms:100,end_ms:1200,heard_at:new Date(100).toISOString()};
  assert.equal(await wake!(input),true);assert.equal(opened.at(-1)!.id,'ambient-verified-wake');
  assert.deepEqual(opened.at(-1)!.extra,{intent:'automatic',mode:'ambient',wake_word:true,source:phone,continuity:'continuity',heard_start_ms:100});
  assert.equal(contextReads,4,'ambient opening never reads owner context');
  assert.equal(handlers.active(input.id),true);
  const d={processed_event_id:'voice-request',principal_id:'actual-owner',user_identity:'actual-owner',origin:'explicit_user_prompt',media_type:'text',
    speakers:[],processing:{path_id:'direct_text',models:[],policy_version:'wake-front-fact',archive_revision:'controlled-archive',completed_at:now},content:{wake_request:{voice_session_id:input.id,voice_turn:0,text:'几点了',context:{entries:[{speaker:'主人',text:'PRIVATE_JOURNAL'}]}}}} as unknown as ProcessedEvent;
  assert.equal(await handlers.identified(input.id,d,'owner'),true);assert.equal(contextReads,5);
  assert.deepEqual(scopes,[{id:'ambient-verified-wake',scope:'owner',context:'owner context\n唤醒前听到的对话：\n主人: PRIVATE_JOURNAL'}]);
  seen!(d);await eventually(()=>(room.published as any[]).some(p=>p.operation==='call_transcript'&&p.role==='main_agent'));
  assert.equal(spoken.length,0,'result projection cannot independently deliver speech');
  assert.equal(await speak!('scoped answer',{device_id:phone.device_id,call_id:'ambient-verified-wake',identity:'owner',turn:0}),true);
  assert.deepEqual(spoken,[{text:'scoped answer',target:{call_id:'ambient-verified-wake',identity:'owner',turn:0}}]);
  assert.equal((room.published as any[]).find(p=>p.operation==='call_transcript'&&p.role==='user')?.text,'几点了');
  assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0);
  seen!({...d,processed_event_id:'confirmation',content:{app_event:{voice_session_id:input.id,voice_turn:1,ambient_context:{entries:[]}}}});
  await eventually(()=>(room.published as any[]).filter(p=>p.operation==='call_transcript'&&p.role==='main_agent').length===2);
  assert.equal(spoken.length,1,'a second projected result still leaves delivery to the completion owner');
  assert.deepEqual((room.published as any[]).filter(p=>p.operation==='call_transcript'&&p.role==='main_agent').map(p=>p.turn),[0,1]);
  for(const [offset,state] of ['open','absent','expired'].entries()){
    const turn=offset+2,request={...d,processed_event_id:`wake-${state}`,device_id:phone.device_id,device_type:'phone',origin:'device_observation',
      user_identity:'unknown',media_type:'audio',segment_basis:'wake_turn',processing:{...d.processing,path_id:'local_split_media'},
      content:{wake_request:{voice_session_id:input.id,voice_turn:turn,text:'帮我查日程'}}} as ProcessedEvent;
    const record=state==='absent'?undefined:await confirmations.open(request,'continuity');
    if(state==='expired')clock+=1001;
    const before:number=spoken.length;
    seen!(request);await eventually(()=>(room.published as any[]).some(p=>p.operation==='call_transcript'&&p.role==='main_agent'&&p.turn===turn));
    assert.equal(spoken.length,before,'ambient result projection cannot create a second speech delivery');
    assert.equal(await speak!('scoped answer',{device_id:phone.device_id,voice_session_id:input.id,identity:'owner_uncertain',turn,
      voice_confirmation:runtime.voiceConfirmationFact(request)}),true);
    assert.equal(spoken.length,before+1,'the durable completion owner sends the result once');
    const delivered=spoken.at(-1) as {text:string;target:{identity:string}};
    assert.deepEqual(JSON.parse(delivered.text),{text:'scoped answer',voice_confirmation:state==='open'?
      {confirmation_id:record!.confirmation_id,expires_at_ms:record!.expires_at_ms}:null});
    assert.equal(delivered.target.identity,'owner_uncertain');
    const transcript=(room.published as any[]).find(p=>p.operation==='call_transcript'&&p.role==='main_agent'&&p.turn===turn);
    assert.equal(transcript.text,'scoped answer','the published transcript keeps the exact original text');
    assert.equal(transcript.text.includes('voice_confirmation'),false,'the fact is model input, not spoken transcript');
  }

  seen!({...d,processed_event_id:'guest-delivery',origin:'device_observation',user_identity:'unknown',media_type:'app_event',
    content:{app_event:{kind:'voice_turn',speaker:'speaker:1',voice_session_id:input.id,voice_turn:5,text:'公开问题'}}} as ProcessedEvent);
  await eventually(()=>(room.published as any[]).some(p=>p.operation==='call_transcript'&&p.role==='main_agent'&&p.turn===5));
  assert.equal(spoken.length,4,'guest transcript projection also cannot speak independently');
  assert.equal(await speak!('scoped answer',{device_id:phone.device_id,voice_session_id:input.id,identity:'guest',turn:5}),true);
  assert.deepEqual(spoken.at(-1),{text:'scoped answer',target:{call_id:'ambient-verified-wake',identity:'guest',turn:5}},'guest completion delivery retains its original plain text');
  assert.equal(await wake!({...input,id:'duplicate'}),true);assert.equal(opened.length,5,'existing voice session owns subsequent wake');
  assert.equal(await wake!({...input,id:'care',say:'示例用户，你还好吗？'}),false,'a live call: 依米\'s own opening line is not said');
  sink!.state(current!,'live',{mode:'ambient'});sink!.playbackReset!(current!,'TR_old');
  await eventually(()=>(room.published as any[]).some(p=>p.operation==='call_playback_reset'));
  assert.deepEqual((room.published as any[]).find(p=>p.operation==='call_playback_reset'),{
    schema_version:'paios.central.text-envelope.v1',operation:'call_playback_reset',session_id:'continuity',call_id:current,track_sid:'TR_old'});
  assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0);
  // Proactive care: the spoken check-in also has a distinct phone control card.
  current=undefined;assert.equal(await wake!({...input,id:'care',say:'示例用户，你还好吗？'}),true);
  const careOpening=opened.at(-1)!;assert.equal(careOpening.id,'ambient-care');assert.equal(careOpening.extra.say,'示例用户，你还好吗？');
  assert.equal(await careOpening.extra.context(),'owner context','proactive opening uses the existing context path');
  assert.equal(contextScopes.at(-1),undefined,'pre-identity care cannot read owner pending approvals');
  sink!.transcript('ambient-care',0,'assistant','嗓子还难受吗？',true,'owner');sink!.transcript('guest',0,'assistant','访客的话',false,'guest');
  assert.deepEqual(careWords,[],'transcripts no longer feed an independent care history');
  await eventually(()=>(room.published as any[]).some(p=>p.operation==='call_transcript'&&p.text==='嗓子还难受吗？'&&p.interrupted===true));
  assert.equal(await show!('care:abc:checkin','示例用户，你还好吗？'),'pending');
  assert.deepEqual((room.published as any[]).find(p=>p.operation==='care_checkin'),{schema_version:'paios.central.text-envelope.v1',
    operation:'care_checkin',session_id:'continuity',care_id:'care:abc:checkin',text:'示例用户，你还好吗？'});
  assert.equal((room.published as any[]).filter(p=>p.operation==='ambient_reply').length,0);
  assert.equal(await speak!('先喝口温水吧'),true);
  assert.deepEqual(spoken.at(-1),{text:'先喝口温水吧',target:undefined,care:true},'care uses the existing live voice rather than a chat reply');
  assert.equal(await speak!('old completion',{device_id:phone.device_id,call_id:'old-call',identity:'owner',turn:1}),false);
  assert.deepEqual(spoken.at(-1),{text:'old completion',target:{call_id:'old-call',identity:'owner',turn:1}});
  assert.equal(await speak!('guest completion',{device_id:phone.device_id,call_id:current!,identity:'guest',turn:2}),true);
  assert.deepEqual(spoken.at(-1),{text:'guest completion',target:{call_id:current,identity:'guest',turn:2}});
  const beforeMismatch=spoken.length;assert.equal(await speak!('wrong device',{device_id:'other',identity:'owner',...(current===undefined?{}:{call_id:current})}),false);assert.equal(spoken.length,beforeMismatch);
  current=undefined;failOpen=true;
  await assert.rejects(wake!({...input,id:'failed-care',say:'你还好吗？'}),/care greeting failed/u,'failed speech propagates instead of authorizing text fallback');
  assert.equal(await wake!({...input,id:'failed-neutral'}),true,'neutral wake retains its partial opening ownership');
  const publish=room.localParticipant.publishData;
  room.localParticipant.publishData=async()=>{throw new Error('STATE_SEND_FAILED');};
  await assert.rejects(Promise.resolve(sink!.state('ambient-care','live',{mode:'ambient',rejoin_deadline:future})),/STATE_SEND_FAILED/u,
    'failed deadline publication must reach the server lease owner');room.localParticipant.publishData=publish;
  await bridge.close();await eventually(()=>wake===undefined);
  assert.equal(await speak!('先喝口温水吧'),false,'a retired connection cannot send care into its old call');
  assert.equal(await show!('care:abc:alert','你还好吗？'),false,'a closed connection cannot show it: the runtime notifies the phone instead');
});

test('reminder snapshots and fire-time text use the authenticated phone channel without packet truncation',async t=>{
  let sync:((list:any[])=>Promise<void>)|undefined,show:((id:string,text:string,reminder?:string)=>Promise<boolean>)|undefined;
  const f=await healthBridge(true,undefined,{watchReminders:async(_device:unknown,fn:typeof sync)=>{sync=fn;return ()=>{};},
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_device:unknown,fn:typeof show)=>{show=fn;return ()=>{};}});t.after(()=>f.bridge.close());
  const reminders=[{id:'water',text:'喝水'.repeat(1000),fire_at:new Date(Date.now()+120000).toISOString()},
    {id:'next',text:'走动一下',fire_at:new Date(Date.now()+240000).toISOString()}];
  await sync!(reminders);const pages=f.out('reminders_sync');
  assert.deepEqual(pages.flatMap((p:any)=>p.reminders),reminders);
  assert.deepEqual(pages.map((p:any)=>[p.part,p.final]),[[0,false],[1,true]]);assert.equal(pages[0].sync_id,pages[1].sync_id);
  await sync!([]);assert.deepEqual(f.out('reminders_sync').at(-1).reminders,[]);
  await show!('water','喝水','water');assert.equal(f.out('ambient_reply').at(-1).reminder_id,'water');
  (f.current.session as {userId:string}).userId='another-owner';const count=f.out('reminders_sync').length;
  await assert.rejects(sync!(reminders));assert.equal(f.out('reminders_sync').length,count,'stale binding receives no owner reminders');
});
test('care formal card and safe action bind to authenticated paired phone and ACK the authority outcome',async t=>{
  const calls:any[]=[],gate=deferred<void>();let show:(id:string,text:string)=>Promise<boolean>;
  const f=await healthBridge(true,undefined,{watchReminders:async()=>()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_device:unknown,watcher:typeof show)=>{show=watcher;return ()=>{};},
    careSafe:async(source:unknown)=>{calls.push(source);await gate.promise;return {cancelled:1};}});t.after(()=>f.bridge.close());
  await show!('care:fall:checkin','你还好吗？');assert.equal(f.out('care_checkin')[0].care_id,'care:fall:checkin');
  f.send({operation:'care_safe',control_id:'safe-1'},'wrong-participant');
  f.send({operation:'care_safe',control_id:'forged',principal_id:'another'});await eventually(()=>f.out('rejected').length===1);
  assert.equal(calls.length,0);f.send({operation:'care_safe',control_id:'safe-1'});await eventually(()=>calls.length===1);
  assert.equal(calls[0].principal_id,'actual-owner');assert.equal(calls[0].device_type,'phone');assert.equal(f.out('care_safe_ack').length,0);
  gate.resolve();await eventually(()=>f.out('care_safe_ack').length===1);
  assert.deepEqual(f.out('care_safe_ack')[0],{operation:'care_safe_ack',schema_version:'paios.central.text-envelope.v1',session_id:'continuity',control_id:'safe-1',cancelled:1});
  f.setSessionState('closed' as never);f.send({operation:'care_safe',control_id:'stale'});await eventually(()=>f.errors.some(error=>/BINDING_INACTIVE/.test(String(error))));assert.equal(f.out('rejected').length,1);assert.equal(calls.length,1);
  const mac=await healthBridge(false,undefined,{careSafe:async()=>{throw new (await import('../../../services/personal-aios-integration/src/contracts.ts')).ContractError('CARE_DEVICE_REQUIRED',403);}});t.after(()=>mac.bridge.close());
  mac.send({operation:'care_safe',control_id:'mac-safe'});await eventually(()=>mac.out('rejected').length===1);
  assert.equal(mac.out('rejected')[0].error_code,'CARE_DEVICE_REQUIRED');assert.equal(mac.out('care_safe_ack').length,0);
});


for(const notifier of ['missing','ENOENT'] as const)
test(`published care and reminders survive ${notifier} notification escalation without retry`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'formal-outreach-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources});
  const storage=new PosixStorage(root),errors:unknown[]=[],warnings:string[]=[];let notifications=0;
  const failure=Object.assign(new Error('ENOENT secret-device-key /private/secret-device-file'),{code:'ENOENT'});
  t.mock.method(console,'warn',(warning:string)=>warnings.push(warning));
  const native:NativeClient={create:async()=>{throw Error('outreach must not create a native run');},status:async()=>{throw Error('unused');},cancel:async()=>{throw Error('unused');},reminders:async()=>[]};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'outreach'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),...(notifier==='ENOENT'?{notify:async()=>{notifications++;throw failure;}}:{})});t.after(()=>runtime.close());
  const room=testRoom(),bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);await eventually(()=>(room.published as any[]).some(p=>p.operation==='reminders_sync'));
  for(const id of ['care:fall:checkin','reminder:water'])await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'phone',id,text:id,...(id.startsWith('reminder')?{reminder_id:'water'}:{})});
  assert.deepEqual((room.published as any[]).filter(p=>['care_checkin','ambient_reply'].includes(p.operation)).map(p=>p.text),['care:fall:checkin','reminder:water']);
  assert.deepEqual(warnings.map(w=>JSON.parse(w)),[0,1].map(()=>({event:'care_outreach_degraded',reason:notifier==='ENOENT'?'notification_failed':'notification_unavailable'})));
  assert.equal(notifications,notifier==='ENOENT'?2:0);assert.deepEqual(errors,[]);
  await bridge.close();const published=room.published.length;
  await assert.rejects(runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'phone',id:'unreachable',text:'no terminal'}),notifier==='ENOENT'?failure:{code:'CARE_OUTREACH_UNAVAILABLE',status:503});
  assert.equal(warnings.length,2,'true unreachability still throws');assert.equal(room.published.length,published);
});

test('two formal terminals share the owner: ranked outreach, source-bound replies, phone-only data and alarms',async t=>{
  const sources=new FormalTerminalSources(),phone=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'phone',registry:sources}),
    glasses=fixture(false,{primary:'glasses',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'glasses',registry:sources},false,'glasses-continuity');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-terminals-'));
  let release=deferred<void>();const cleanup:(()=>void|Promise<void>)[]=[];
  // Work still settling after close can write into the directory while it is removed; rm retries ENOTEMPTY instead of failing teardown.
  t.after(async()=>{release.resolve();for(const close of cleanup.reverse())await close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),runs=new Map<string,NativeRun>();let creates=0;
  const native:NativeClient={create:async body=>{const run={run_id:`run-${++creates}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
    runs.set(run.run_id,run);return run;},status:async id=>({...runs.get(id)!}),cancel:async id=>({...runs.get(id)!}),
    reminders:async()=>[{id:'water',text:'喝水',fire_at:new Date(Date.now()+60000).toISOString()}]};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'terminals'});
  const health=HealthStore.open(join(root,'health')),contacts=ContactsStore.open(join(root,'contacts'));cleanup.push(()=>{health.close();contacts.close();});
  const errors:unknown[]=[],spoken:string[]=[],notified:string[]=[],streams:{device:string;options:any;bytes:Buffer[]}[]=[],careFlags:(boolean|undefined)[]=[];let sharedCallBusy=false;
  const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  const {VisualMemory}=await import('../../../services/personal-aios-integration/src/visual/store.ts');
  const visual=await VisualMemory.open(join(root,'visual'),{embedImage:async()=>{throw new Error('no image work for policy');},
    embedQuery:async()=>{throw new Error('no query work for policy');},describe:async()=>{throw new Error('no model work for policy');}});cleanup.push(()=>visual.close());
  const payment=PaymentAuthority.open(join(root,'payment'),{config:{...DEFAULT_PAYMENT_CONFIG,enabled:true,executor_key_file:'/fixture/executor.key'}});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,payment,payment_devices:async()=>[],output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){yield inspectWav(wav);await release.promise;yield inspectWav(wav);}}}),
    sourceAuthority:sources,health,contacts,visual_memory:visual,skill:'fixed',max_read_bytes:8192,notify:async notice=>{notified.push(notice.body);},automatic_output:{onError:error=>errors.push(error)}});cleanup.push(()=>runtime.close());
  const watchCare=runtime.watchCare.bind(runtime);let hint:((card:import('../../../services/personal-aios-integration/src/terminal-cards.ts').TerminalPersonHint)=>Promise<void>)|undefined;
  runtime.watchCare=async(...args:Parameters<PersonalAIOSRuntime['watchCare']>)=>{if(args[0].device_id==='glasses')hint=args[7]?.deliver;return watchCare(...args);};
  // This fixture drives every spool sweep explicitly; keep the production timer outside its test clock.
  const spoolDir=join(root,'errands'),spool=createErrandSpool(spoolDir,error=>errors.push(error),{intervalMs:60_000,deliver:r=>runtime.deliverErrand(r,error=>errors.push(error)),progress:(principal,r)=>runtime.errandProgress(principal,r,error=>errors.push(error))});
  await spool.start();cleanup.push(()=>spool.close());
  const spoolFile=async(name:string,value:unknown)=>{const path=join(spoolDir,name);
    await fs.writeFile(path+'.tmp',JSON.stringify(value));await fs.rename(path+'.tmp',path);};
  const connect=async(f:typeof phone)=>{
    const room=testRoom() as ReturnType<typeof testRoom>&{localParticipant:Record<string,unknown>};
    room.localParticipant.streamBytes=async(options:any)=>{const stream={device:f.input.bearer.deviceId,options,bytes:[] as Buffer[]};streams.push(stream);return {write:async(bytes:Uint8Array)=>{stream.bytes.push(Buffer.from(bytes));},close:async()=>{}};};let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,realtime_busy:()=>sharedCallBusy,voice_transport:'wav_byte_stream_v1',errands:spool,onError:error=>errors.push(error),voice_call:{open:async()=>{},close:async()=>{},
        respond:async(text,_target,care)=>{if(!live)return false;spoken.push(`${f.input.bearer.deviceId}:${text}`);careFlags.push(care);return true;},attach:value=>{sink=value;return()=>{sink=undefined;};}}});
    let live=false;await bridge.onBootstrapConnected(f.input);cleanup.push(()=>bridge.close());
    return {room,reconnect:()=>bridge.onBootstrapConnected(f.input),disconnect:async()=>{await bridge.close();f.setSessionState('terminal');},send:(body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC),
      out:(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[],call:(active:boolean)=>{live=active;sink!.state('call',active?'live':'closed',{mode:'manual'});}};
  };
  const p=await connect(phone),g=await connect(glasses);await eventually(()=>p.out('reminders_sync').length===1);
  assert.equal(g.out('reminders_sync').length,0);
  const ps=await runtime.authenticate(phone.authority.credentialForBootstrap(phone.input)),gs=await runtime.authenticate(glasses.authority.credentialForBootstrap(glasses.input));
  await runtime.ownerInput(gs);
  await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'glasses',id:'unknown-wear',text:'unknown wear goes to phone'});
  assert.equal(p.out('ambient_reply').at(-1).text,'unknown wear goes to phone');assert.equal(g.out('display_card').length,0);
  g.send({operation:'wear_state',control_id:'initial-wear',worn:true});await eventually(()=>g.out('wear_state_ack').length===1);
  const phoneBefore=p.out('ambient_reply').length;
  for(const id of ['care:fall:checkin','care:cough:outreach','reminder:water'])await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'phone',id,text:id,...(id.startsWith('reminder')?{reminder_id:'water'}:{})});
  assert.equal(g.out('display_card').length,3);assert.deepEqual(g.out('display_card').flatMap(x=>x.lines),['care:fall:checkin','care:cough:outreach','reminder:water']);
  assert.equal(g.out('display_card')[0].actions[0].command.operation,'care_safe');
  assert.equal(g.out('care_checkin').length+g.out('ambient_reply').length,0);
  assert.equal(p.out('care_checkin').length+p.out('ambient_reply').length,phoneBefore+3);
  assert.deepEqual(p.out('care_checkin').map(x=>x.care_id),['care:fall:checkin']);
  assert.deepEqual(p.out('ambient_reply').slice(phoneBefore).map(x=>x.processed_event_id),['care:cough:outreach','reminder:water']);
  assert.deepEqual(notified,['unknown wear goes to phone','care:fall:checkin','care:cough:outreach','reminder:water'],'unreceipted display publication must retain external notification fallback');
  p.call(true);await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'glasses',id:'live',text:'live takes priority'});
  assert.deepEqual(spoken,['phone:live takes priority']);assert.equal(notified.length,4);assert.equal(g.out('display_card').length,3);p.call(false);
  // Plain glasses text cannot authenticate its wearer. Phone requests keep their phone reply route.
  g.send({operation:'submit',event_id:'glasses-request',captured_at:now,text:'眼镜的问题'});await eventually(()=>g.out('rejected').some(x=>x.error_code==='TEXT_INPUT_DEVICE_REQUIRED'));
  p.send({operation:'submit',event_id:'phone-request',captured_at:now,text:'手机的问题'});await eventually(()=>p.out('accepted').some(x=>x.admission.run_id==='run-1'));assert.equal(creates,1);await runtime.ownerInput(gs);
  await eventually(()=>g.out('camera_policy').length>0);
  assert.equal(g.out('camera_policy').at(-1).policy.enabled,true);
  const beforeHint=g.out('display_card').length,spokenBeforeHint=spoken.length,phoneBeforeHint=p.room.published.length;
  await hint!({person_ref:'speaker:known-person',name:'老王'});
  assert.equal(g.out('display_card').length,beforeHint+1);assert.deepEqual(g.out('display_card').at(-1),{schema_version:'paios.central.text-envelope.v1',
    operation:'display_card',session_id:'glasses-continuity',card_id:'person:speaker:known-person',title:'认人',lines:['老王'],priority:'normal',lifetime_ms:10000});
  assert.equal(spoken.length,spokenBeforeHint);assert.equal(p.room.published.length,phoneBeforeHint);
  const context={run_id:'run-1',session_id:'continuity',tool_call_id:'capture-policy'};
  assert.equal(p.out('camera_policy').length,0);
  const captureBefore=g.out('camera_policy').length;
  await runtime.tool('paios_visual_capture_policy',{context,args:{interval_ms:60000,private_paused:true}});
  assert.equal(g.out('camera_policy').length,captureBefore+1);assert.equal(g.out('camera_policy').at(-1).policy.private_paused,true);
  assert.equal(g.out('camera_policy').at(-1).policy.interval_ms,60000);assert.equal(p.out('camera_policy').length,0);
  await runtime.tool('paios_visual_capture_policy',{context:{...context,tool_call_id:'resume-capture'},args:{enabled:true,private_paused:false}});
  assert.equal(g.out('camera_policy').at(-1).policy.private_paused,false);
  g.send({operation:'camera_frame',frame:{frame_id:'private-pause',captured_at:now,mime_type:'image/jpeg',image_base64:'/9j/2Q==',
    width:1,height:1,trigger:'user_request',worn:true,private_paused:true}});
  await eventually(()=>g.out('rejected').some(x=>x.error_code==='FORMAL_TEXT_RESULT_INVALID'));
  assert.equal((await visual.recall('actual-owner',{})).frames.length,0);
  const card=await runtime.tool('paios_terminal_question',{context:{...context,tool_call_id:'hud'},args:{options:[{id:'yes',label:'是',lines:[]},{id:'no',label:'不是',lines:[]}]}}) as {card_id:string};
  assert.equal(g.out('display_card').at(-1).card_id,card.card_id);assert.equal(p.out('gesture_card').length,0);
  assert.deepEqual(g.out('display_card').at(-1).actions.map((a:any)=>a.command),['yes','no'].map(answer=>({operation:'card_answer',card_id:card.card_id,kind:'tap',answer})));
  const gestureEvent=`answer:${digest([gs.device_id,card.card_id])}`;
  g.send({operation:'card_answer',card_id:card.card_id,kind:'tap',answer:'yes'});
  await eventually(()=>g.out('accepted').some(x=>x.event_id===gestureEvent));
  const gesture=g.out('accepted').find(x=>x.event_id===gestureEvent);
  const {processed_event:gestureD}=await runtime.event(gs,'glasses-continuity',gesture.processed_event_id);
  assert.equal(gestureD.media_type,'app_event');assert.equal(gestureD.origin,'device_observation');
  assert.deepEqual(gestureD.content.app_event,{kind:'glasses_gesture',text:'是',card_id:card.card_id,answer:'yes',input_kind:'tap'});
  assert.equal(runtime.paymentSource('run-1').allowed,false); // A8.3 requires an open payment intent.
  await runtime.ownerInput(ps);await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'glasses',id:'active-phone',text:'phone active'});
  assert.equal(p.out('ambient_reply').at(-1).text,'phone active');
  const accepted=p.out('accepted').find(x=>x.admission.run_id==='run-1');await runtime.tool('paios_open_reply',{context:{run_id:'run-1',session_id:'continuity',tool_call_id:'reply'},args:{reply_mode:'text'}});
  Object.assign(runs.get('run-1')!,{status:'completed',output:'只回答手机'});p.send({operation:'result',processed_event_id:accepted.processed_event_id});await eventually(()=>p.out('text_chunk').some(x=>x.chunk.final));
  assert.equal(p.out('text_chunk')[0].chunk.target_device_id,'phone');assert.equal(g.out('text_chunk').length,0);
  await eventually(()=>g.out('accepted').some(x=>x.event_id===gestureEvent&&x.admission.run_id==='run-2'));
  assert.equal(runtime.paymentSource('run-2').allowed,false);Object.assign(runs.get('run-2')!,{status:'completed',output:''});
  await runtime.result(gs,'glasses-continuity',gestureD.processed_event_id);
  g.send(healthPage());g.send(contactsPage());
  await eventually(()=>g.out('rejected').length===4);
  assert.deepEqual(g.out('rejected').map(x=>x.error_code).sort(),['CONTACTS_DEVICE_REQUIRED','FORMAL_TEXT_RESULT_INVALID','HEALTH_DEVICE_REQUIRED','TEXT_INPUT_DEVICE_REQUIRED']);
  p.send(healthPage());await eventually(()=>p.out('health_ack').length===1);
  const running={principal_id:'actual-owner',job_id:'job-0123456789ab',title:'点奶茶',app:'千问',state:'running',started_at:now,step:1,max_steps:20};
  await spoolFile(`${running.job_id}.running.json`,running);await spool.sweep();
  await eventually(()=>p.out('errand_progress').at(-1)?.errands[0]?.job_id===running.job_id);
  assert.equal(p.out('errand_progress').at(-1).errands[0].job_id,running.job_id);
  await runtime.ownerInput(gs);await spool.sweep();await eventually(()=>g.out('display_card').at(-1)?.actions?.some((a:any)=>a.command.job_id===running.job_id));assert.ok(g.out('display_card').at(-1).actions.some((a:any)=>a.command.job_id===running.job_id));
  assert.equal(g.out('display_card').at(-1).title,'点奶茶');
  const phoneProgress=p.out('errand_progress').length,newRunning={...running,job_id:'job-0123456789af'};
  await spoolFile(`${newRunning.job_id}.running.json`,newRunning);await spool.sweep();await eventually(()=>g.out('display_card').at(-1)?.actions?.length===2);
  assert.equal(p.out('errand_progress').length,phoneProgress);assert.equal(g.out('display_card').at(-1).actions.length,2);
  await p.reconnect();await spool.sweep();await eventually(()=>p.out('errand_progress').at(-1)?.errands.length===0);assert.deepEqual(p.out('errand_progress').at(-1).errands,[]);
  await fs.rm(join(spoolDir,`${newRunning.job_id}.running.json`));
  await fs.rm(join(spoolDir,`${running.job_id}.running.json`));await spool.sweep();await eventually(()=>(g.out('display_card').at(-1)?.actions??[]).length===0);
  assert.deepEqual(p.out('errand_progress').at(-1).errands,[]);assert.deepEqual(g.out('display_card').at(-1).actions??[],[]);
  await spoolFile(`${running.job_id}.running.json`,running);
  p.send({operation:'errand_cancel',job_id:running.job_id});await eventually(async()=>{try{await fs.stat(join(spoolDir,`${running.job_id}.cancel`));return true;}catch{return false;}});
  const result={principal_id:'actual-owner',job_id:running.job_id,task:'点奶茶',success:true,answer:'已办好',finished_at:now};
  await spoolFile(`${result.job_id}.done.json`,result);await spool.sweep();
  await eventually(async()=>{await spool.sweep();const failure=errors.find(error=>!/DEVICE_REQUIRED|FORMAL_TEXT_RESULT_INVALID/.test(String(error)));if(failure)throw failure;return creates===3;});const errandRun=runs.get('run-3')!;
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'run-3',session_id:'glasses-continuity',tool_call_id:'errand-reply'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');
  assert.deepEqual(JSON.parse(await fs.readFile(join(spoolDir,`${result.job_id}.done.json`),'utf8')),result);
  await assert.rejects(fs.stat(join(spoolDir,`${result.job_id}.delivered.json`)),{code:'ENOENT'});
  // A retry after an accepted handoff uses the first archive and admission, never a second job run.
  await runtime.ownerInput(ps);await spoolFile(`${result.job_id}.done.json`,result);await spool.sweep();assert.equal(creates,3);
  const errandSource=await runtime.submitErrand({schema_version:'paios.event.v1',event_id:`errand:${result.job_id}`,captured_at:now,
    device_id:ps.device_id,device_type:ps.device_type,source:{channel:ps.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify({kind:'errand_result',...result}))},ps,'continuity');
  assert.equal(errandSource.processed_event.device_id,'glasses');
  Object.assign(errandRun,{status:'completed',output:'奶茶办好了'});
  await eventually(()=>{const failure=errors.find(error=>!/DEVICE_REQUIRED|FORMAL_TEXT_RESULT_INVALID/.test(String(error)));if(failure)throw failure;return p.out('text_chunk').some(x=>x.chunk.text==='奶茶办好了');});
  assert.equal(p.out('text_chunk').filter(x=>x.chunk.text==='奶茶办好了').length,1);
  await eventually(()=>streams.length===1);assert.equal(streams[0]!.device,'phone');assert.deepEqual(Buffer.concat(streams[0]!.bytes),wav);
  const chunk=JSON.parse(streams[0]!.options.attributes.out).chunk;
  assert.equal(chunk.final,false);assert.equal(p.out('result_header').at(-1).voice_status,'pending');
  await spool.sweep();assert.ok((await fs.readdir(spoolDir)).includes(`${result.job_id}.done.json`),'pending voice is not a delivered report');
  // The ready header follows a durable output checkpoint; allow the full-suite disk load.
  await runtime.ownerInput(gs);release.resolve();await eventually(()=>p.out('result_header').at(-1).voice_status==='ready'&&streams.length===2,10000);
  assert.deepEqual(streams.map(stream=>[stream.device,JSON.parse(stream.options.attributes.out).chunk.seq]),[['phone',1],['phone',2]]);
  assert.equal(p.out('text_chunk').filter(x=>x.chunk.text==='奶茶办好了').length,1);assert.equal(g.out('ambient_reply').filter(x=>x.text==='奶茶办好了').length,0);
  await spool.sweep();assert.ok((await fs.readdir(spoolDir)).includes(`${result.job_id}.done.json`),'settled synthesis is not a delivery receipt');
  const textPacket=p.out('text_chunk').find(x=>x.chunk.text==='奶茶办好了').chunk;
  p.send({operation:'ack',processed_event_id:errandSource.processed_event.processed_event_id,ack:{output_id:textPacket.output_id,reply_id:textPacket.reply_id,reply_epoch:textPacket.reply_epoch,target_device_id:'phone',route_version:textPacket.route_version,highest_contiguous_seq:1,status:'rendered',observed_at:now}});
  p.send({operation:'ack',processed_event_id:errandSource.processed_event.processed_event_id,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:'phone',route_version:chunk.route_version,highest_contiguous_seq:2,status:'played',observed_at:now}});
  await eventually(()=>p.out('ack_receipt').length===2);assert.equal(p.out('ack_receipt')[0].receipt.target_device_id,'phone');
  await spool.sweep();assert.deepEqual(JSON.parse(await fs.readFile(join(spoolDir,`${result.job_id}.delivered.json`),'utf8')),result);
  release=deferred<void>();p.call(true);const second={...result,job_id:'job-0123456789ac'};await spoolFile(`${second.job_id}.done.json`,second);await spool.sweep();await eventually(()=>creates===4);
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'run-4',session_id:'continuity',tool_call_id:'live-errand'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');Object.assign(runs.get('run-4')!,{status:'completed',output:'通话中的办事结果'});
  await eventually(()=>p.out('text_chunk').some(x=>x.chunk.text==='通话中的办事结果')&&streams.length===3);
  assert.equal(streams.length,3);assert.equal(spoken.includes('phone:通话中的办事结果'),false,'live call completion cannot replace receipted OUT playback');p.call(false);release.resolve();
  await eventually(()=>p.out('result_header').at(-1).voice_status==='ready'&&streams.length===4,10000);assert.equal(streams.length,4);
  await runtime.ownerInput(ps);const third={...result,job_id:'job-0123456789ad'};
  await spoolFile(`${third.job_id}.done.json`,third);await spool.sweep();await eventually(()=>creates===5);
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'run-5',session_id:'continuity',tool_call_id:'transport-errand'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');
  await g.disconnect();const display=fixture(false,{primary:'glasses',watch:'watch',client:'watch-client'},['text'],{type:'glasses',registry:sources},false,'display-continuity'),hud=await connect(display);
  await runtime.ownerInput(await runtime.authenticate(display.authority.credentialForBootstrap(display.input)));
  Object.assign(runs.get('run-5')!,{status:'completed',output:'声音结果仍送到可播放的终端'});
  await eventually(()=>streams.length===6);assert.deepEqual(streams.slice(4).map(stream=>stream.device),['phone','phone']);assert.equal(hud.out('text_chunk').length,0);
  assert.equal(p.out('text_chunk').filter(x=>x.chunk.text==='声音结果仍送到可播放的终端').length,1);
  assert.equal(g.out('ambient_reply').filter(x=>x.text==='奶茶办好了').length,0);
  assert.equal(errors.filter(error=>!/DEVICE_REQUIRED|FORMAL_TEXT_RESULT_INVALID/.test(String(error))).length,0);
  await eventually(()=>p.out('result_header').some(x=>x.run_id==='run-5'&&x.voice_status==='ready'));
  await hud.disconnect();glasses.setSessionState('active');const resumed=await connect(glasses);resumed.send({operation:'wear_state',control_id:'resumed-wear',worn:true});await eventually(()=>resumed.out('wear_state_ack').length===1);await runtime.ownerInput(gs);release=deferred<void>();
  const requested=await payment.request({principal_id:'actual-owner',run_id:'payment-origin-run',tool_call_id:'purchase',session_id:'payment-origin-conversation',processed_event_id:'payment-origin-d',initiating:{kind:'text',device_id:'phone',device_type:'phone',captured_at_ms:Date.now(),lease_at_capture:false},initiating_text:'买奶茶',purpose:'奶茶',app:'千问',budget_fen:1660},true);
  const fourth={...result,job_id:'job-0123456789ae',answer:'【已付款】 一点点 ¥16.60'};
  await payment.checkpoint({intent_id:String(requested.intent_id),job_id:fourth.job_id,seq:1,app:'千问',checkout:'cashier',amount_fen:1660,payee:'一点点',items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:now});
  await eventually(()=>creates===6);
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'run-6',session_id:'payment-origin-conversation',tool_call_id:'payment-update-reply'},args:{reply_mode:'none'}}) as {status:string}).status==='silent');
  const update=admission.find('run-6','payment-origin-conversation')!;
  Object.assign(runs.get('run-6')!,{status:'completed',output:''});
  assert.equal((await runtime.result(ps,'payment-origin-conversation',update.d.processed_event_id)).result.private,'payment');
  assert.equal(parseErrandResult({...fourth,payment_intent:requested.intent_id}).payment_intent,requested.intent_id);
  sharedCallBusy=true;await spoolFile(`${fourth.job_id}.done.json`,fourth);await spool.sweep();await eventually(()=>creates===7);
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'run-7',session_id:'glasses-continuity',tool_call_id:'glasses-stream'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');Object.assign(runs.get('run-7')!,{status:'completed',output:'眼镜上的办事结果'});
  await eventually(()=>streams.length===7);assert.equal(streams[6]!.device,'glasses');
  assert.equal(p.out('ambient_reply').filter(x=>x.text==='眼镜上的办事结果').length,0,'the phone record waits while formal OUT reaches the selected glasses');
  sharedCallBusy=false;await eventually(()=>p.out('ambient_reply').some(x=>x.text==='眼镜上的办事结果'));
  assert.equal(p.out('ambient_reply').filter(x=>x.text==='眼镜上的办事结果').length,1,'phone chat keeps one record without playback');
  assert.equal(p.out('ambient_reply').find(x=>x.text==='眼镜上的办事结果').private,'payment');
  assert.equal(resumed.out('display_card').filter(x=>x.delivery).at(-1).private,'payment');
  assert.equal(resumed.out('result_header').at(-1).private,'payment');
  assert.equal(JSON.parse(streams[6]!.options.attributes.out).private,'payment');
  assert.equal(p.out('ambient_reply').find(x=>x.text==='奶茶办好了')?.private,undefined,'nonpayment errands stay unchanged');
  const glassChunk=JSON.parse(streams[6]!.options.attributes.out).chunk,glassEvent=resumed.out('display_card').filter(p=>p.delivery).at(-1).delivery.processed_event_id;
  await runtime.errandReply('actual-owner',await runtime.result(gs,'glasses-continuity',glassEvent),error=>errors.push(error),{first:true});
  assert.equal(p.out('ambient_reply').filter(x=>x.text==='眼镜上的办事结果').length,1,'a repeated report handoff does not duplicate the phone record');
  resumed.send({operation:'ack',processed_event_id:glassEvent,ack:{output_id:glassChunk.output_id,reply_id:glassChunk.reply_id,reply_epoch:glassChunk.reply_epoch,target_device_id:'glasses',route_version:glassChunk.route_version,highest_contiguous_seq:1,status:'played',observed_at:now}});
  await eventually(()=>resumed.out('ack_receipt').length===1);assert.equal(resumed.out('ack_receipt')[0].receipt.target_device_id,'glasses');
  const observed=await runtime.submit({schema_version:'paios.event.v1',event_id:'camera-observation',captured_at:now,device_id:'phone',device_type:'phone',source:{channel:ps.channel},
    media_type:'app_event',mime:'application/json',representation:'uploaded_original',payload:Buffer.from('{"kind":"ambient_observation"}')},ps,'continuity',false);
  await eventually(async()=>Boolean((await runtime.event(ps,'continuity',observed.processed_event.processed_event_id)).admission.run_id));
  const observedRun=(await runtime.event(ps,'continuity',observed.processed_event.processed_event_id)).admission.run_id!;
  assert.deepEqual(runtime.paymentSource(observedRun),{allowed:false,ride_allowed:false});
  for(const args of [{enabled:1},{private_paused:0},{interval_ms:'5000'},{triggers:['fake']}])await assert.rejects(runtime.tool('paios_visual_capture_policy',
    {context:{run_id:observedRun,session_id:'continuity',tool_call_id:'invalid-capture'},args}),/CAMERA_CAPTURE_POLICY_INVALID/);
  for(const args of [{enabled:true},{private_paused:false}])await assert.rejects(runtime.tool('paios_visual_capture_policy',
    {context:{run_id:observedRun,session_id:'continuity',tool_call_id:'observation-capture'},args}),/OWNER_REQUEST_REQUIRED/);
  await runtime.tool('paios_open_reply',{context:{run_id:observedRun,session_id:'continuity',tool_call_id:'finish-observation'},args:{reply_mode:'none'}});
  Object.assign(runs.get(observedRun)!,{status:'completed',output:''});await runtime.result(ps,'continuity',observed.processed_event.processed_event_id);
  await runtime.ownerInput(ps);glasses.setSessionState('terminal');release.resolve();
  await eventually(()=>errors.some(error=>/SOURCE_BINDING_INACTIVE/.test(String(error))));await runtime.close();
  assert.equal(streams.length,7,'the revoked recipient gets no later chunk and the stream is not sent to another terminal');
  assert.equal(p.out('ambient_reply').filter(x=>x.text==='眼镜上的办事结果').length,1);
});
for(const after of ['ended','replaced','publication-retry','post-publication-client-death'] as const)
test(`an errand survives subscription-before-report restart into a changed fixed skill; ${after==='publication-retry'?'publication failure stops report retries':`${after} call uses normal output`}`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'formal-errand-recovery-')),cleanup:(()=>unknown|Promise<unknown>)[]=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();await fs.rm(root,{recursive:true,force:true});});
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'phone',registry:sources});
  const storage=new PosixStorage(root),errors:unknown[]=[],spoken:string[]=[];let creates=0,notifications=0;
  cleanup.push(()=>storage.close());
  const retiredConnectionErrors:ContractError[]=[];let oldConnectionClosing=false;
  const notifyFailure=Object.assign(new Error('notification device file absent'),{code:'ENOENT'});
  const run:NativeRun={run_id:'errand-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'已办好的报告'};
  const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  // A deploy restarts the runtime with its new SKILL.md: the spool retries the job admitted under the old one.
  const make=(skill='fixed')=>{
    const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-recovery'});
    const archive=new RawArchive(storage,8192),runtime=new PersonalAIOSRuntime({storage,archive,admission,native,sourceAuthority:sources,skill,max_read_bytes:8192,
      output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async()=>inspectWav(wav)}}),automatic_output:{onError:error=>errors.push(error)}});
    const spool=createErrandSpool(join(root,'errands'),error=>{if(error!==notifyFailure)errors.push(error);},{deliver:r=>runtime.deliverErrand(r,error=>errors.push(error)),
      ...(after==='post-publication-client-death'?{notify:async()=>{notifications++;throw notifyFailure;}}:{})});cleanup.push(async()=>{await spool.close();await runtime.close();await archive.close();});return {admission,runtime,spool};
  };
  const first=make(),oldRoom=testRoom(),old=createFormalTextIngress({participant:{roomPort:oldRoom,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime:first.runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:first.spool,onError:error=>{
      if(after==='post-publication-client-death'&&oldConnectionClosing&&error instanceof ContractError&&error.code==='ERRAND_REPORT_NOT_DELIVERED'&&error.status===503)
        retiredConnectionErrors.push(error);
      else errors.push(error);
    }});cleanup.push(()=>old.close());
  await first.spool.start();await old.onBootstrapConnected(f.input);
  const job={principal_id:'actual-owner',job_id:'job-0123456789ab',task:'点奶茶',success:true,answer:'已办好',finished_at:now},done=join(root,'errands',`${job.job_id}.done.json`);
  await fs.writeFile(done,JSON.stringify(job));await first.spool.sweep();await eventually(()=>creates===1);
  await eventually(async()=>(await first.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');
  assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.done.json`));
  if(after==='post-publication-client-death'){
    run.status='completed';await eventually(()=>(oldRoom.published as any[]).some(p=>p.operation==='result_header'&&p.voice_status==='ready'));
    await first.spool.sweep();assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.done.json`),'SDK success before rendered/played ACK must retain the spool duty');
    assert.equal(notifications,0,'pending publication does not invoke the broken notifier');
  }
  // A published header is not a callback-completion barrier. Retirement can remove the
  // terminal before the old voice-settlement callback reports explicit nondelivery.
  oldConnectionClosing=true;await first.spool.close();await old.close();await first.runtime.close();
  if(retiredConnectionErrors.length)t.diagnostic(`old ingress retirement: ${retiredConnectionErrors.length} ERRAND_REPORT_NOT_DELIVERED 503`);
  const next=make('fixed, redeployed'),current=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'phone',registry:sources},false,'new-continuity'),room=testRoom();
  const streams:Buffer[][]=[];Object.assign(room.localParticipant,{streamBytes:async()=>{const bytes:Buffer[]=[];streams.push(bytes);return {write:async(b:Uint8Array)=>{bytes.push(Buffer.from(b));},close:async()=>{}};}});
  let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const call=createVoiceCallSession({room:()=>({}),onState:(...args)=>sink?.state(...args),onTranscript:(...args)=>sink?.transcript(...args),onTurn:turn=>sink?.turn(turn),onError:error=>errors.push(error),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async text=>{spoken.push(text);return {completed:true};},context:async()=>{},close:()=>{}}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}})});cleanup.push(()=>call.closeAll());
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime:next.runtime,authority:current.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_transport:'wav_byte_stream_v1',errands:next.spool,onError:error=>errors.push(error),voice_call:{...call,attach:value=>{sink=value;return()=>{sink=undefined;};}}});cleanup.push(()=>bridge.close());
  await next.spool.start();if(after==='post-publication-client-death')await next.spool.sweep();
  await bridge.onBootstrapConnected(current.input);await call.open('call-A');
  let switched=false,dropped=false;const publish=room.localParticipant.publishData;
  room.localParticipant.publishData=async bytes=>{
    const packet=JSON.parse(Buffer.from(bytes).toString('utf8'));
    if(!switched&&packet.operation==='accepted'){switched=true;await call.close('call-A','button');if(after!=='ended')await call.open('call-B');}
    if(after==='publication-retry'&&!dropped&&packet.operation==='text_chunk'){dropped=true;throw new Error('SDK_REPLAY_NEEDED');}
    await publish(bytes);
  };
  run.status='completed';await next.admission.recover();await next.spool.sweep();
  if(after==='publication-retry'){
    await eventually(()=>errors.some(error=>String(error).includes('SDK_REPLAY_NEEDED')));await next.spool.sweep();
    assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.delivery-failed.json`));
    const sent=room.published.length;await next.spool.sweep();await next.spool.sweep();
    assert.equal(room.published.length,sent,'a concrete publication failure waits for main-agent recovery');assert.equal(creates,1);
    return;
  }
  const unexpected=()=>errors.find(error=>after!=='publication-retry'||!/SDK_REPLAY_NEEDED|ERRAND_REPORT_NOT_DELIVERED/.test(String(error)));
  await eventually(async()=>{await next.spool.sweep();const failure=unexpected();if(failure)throw failure;return (room.published as any[]).some(p=>p.operation==='text_chunk')&&streams.length>0;});
  assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.done.json`));
  const packet=(room.published as any[]).find(p=>p.operation==='text_chunk'),header=(room.published as any[]).find(p=>p.operation==='result_header');
  if(after==='post-publication-client-death'){
    const sent=room.published.length,notified=notifications;await next.spool.sweep();await next.spool.sweep();
    assert.equal(room.published.length,sent,'unreceipted sweeps do not re-publish a successful errand transfer');assert.equal(streams.length,1);
    assert.equal(notified,1,'the disconnected spool tried the broken notifier once');assert.equal(notifications,notified);
  }
  const ack=(chunk:any,status:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'ack',processed_event_id:header.processed_event_id,
    ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,
      highest_contiguous_seq:chunk.seq,status,observed_at:now}})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  ack(packet.chunk,'accepted');await eventually(()=>(room.published as any[]).some(p=>p.operation==='ack_receipt'));await next.spool.sweep();
  assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.done.json`),'accepted is not rendered');
  ack(packet.chunk,'rendered');
  const source=await next.runtime.authenticate(current.authority.credentialForBootstrap(current.input));
  const value=await next.runtime.result(source,'new-continuity',header.processed_event_id);ack(value.voice_chunks.at(-1),'played');
  await eventually(()=>(room.published as any[]).filter(p=>p.operation==='ack_receipt').length===3);
  if(after==='post-publication-client-death'){
    await next.spool.close();await bridge.close();await next.runtime.close();
    const restarted=make('fixed, redeployed'),coldRoom=testRoom(),cold=createFormalTextIngress({participant:{roomPort:coldRoom} as unknown as LiveKitCloudParticipantPort,
      runtime:restarted.runtime,authority:current.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:restarted.spool,onError:error=>errors.push(error)});t.after(()=>cold.close());
    await restarted.spool.start();await cold.onBootstrapConnected(current.input);await restarted.spool.sweep();
    assert.ok((await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.delivered.json`),'persisted ACK survives restart before spool retirement');
    assert.equal((coldRoom.published as any[]).filter(p=>p.operation==='text_chunk').length,0);
  }
  await eventually(async()=>{await next.spool.sweep();const failure=unexpected();if(failure)throw failure;return (await fs.readdir(join(root,'errands'))).includes(`${job.job_id}.delivered.json`);});
  const sent=room.published.length;await next.spool.sweep();assert.equal(room.published.length,sent,'settled duty is not replayed');
  assert.equal(switched,true);assert.equal(creates,1);assert.deepEqual(spoken,[]);assert.deepEqual(Buffer.concat(streams.flat()),wav);
  const text=room.published.filter((p:any)=>p.operation==='text_chunk') as any[];assert.ok(text.every(p=>p.chunk.text==='已办好的报告'&&p.session_id==='new-continuity'));assert.equal(errors.length,after==='publication-retry'?2:0);
});

test('an errand report follows its recipient device to a new-route reconnect: once, never to the stale connection or another device',async t=>{
  const sources=new FormalTerminalSources(),phone=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'phone',registry:sources}),
    glasses=fixture(false,{primary:'glasses',watch:'watch',client:'watch-client'},['text','voice','text_and_voice'],{type:'glasses',registry:sources},false,'glasses-continuity');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-errand-route-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),errors:unknown[]=[],streams:{room:unknown;chunk:any}[]=[],release=deferred<void>();t.after(()=>release.resolve());let creates=0;
  const run:NativeRun={run_id:'errand-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'奶茶办好了'};
  const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
    admission:new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-route'}),
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){yield inspectWav(wav);await release.promise;yield inspectWav(wav);}}}),
    automatic_output:{onError:error=>errors.push(error)}});t.after(()=>runtime.close());
  const spoolDir=join(root,'errands'),spool=createErrandSpool(spoolDir,error=>errors.push(error),{deliver:r=>runtime.deliverErrand(r,error=>errors.push(error))});await spool.start();t.after(()=>spool.close());
  const connect=async(f:typeof phone)=>{
    const room=testRoom() as ReturnType<typeof testRoom>&{localParticipant:Record<string,unknown>};
    room.localParticipant.streamBytes=async(options:any)=>{streams.push({room,chunk:JSON.parse(options.attributes.out).chunk});return {write:async()=>{},close:async()=>{}};};
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_transport:'wav_byte_stream_v1',errands:spool,onError:error=>errors.push(error)});
    t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
    const send=(body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    return {room,send,voice:()=>streams.filter(s=>s.room===room).map(s=>s.chunk),out:(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[],
      ack:(d:string,chunk:any,status:string)=>send({operation:'ack',processed_event_id:d,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,
        target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status,observed_at:now}})};
  };
  const stale=await connect(phone),g=await connect(glasses);
  g.send({operation:'wear_state',control_id:'worn',worn:true});await eventually(()=>g.out('wear_state_ack').length===1);
  await runtime.ownerInput(await runtime.authenticate(phone.authority.credentialForBootstrap(phone.input)));
  const job={principal_id:'actual-owner',job_id:'job-0123456789ab',task:'点奶茶',success:true,answer:'已办好',finished_at:now};
  await fs.writeFile(join(spoolDir,`${job.job_id}.done.json`),JSON.stringify(job));await spool.sweep();await eventually(()=>creates===1);
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text_and_voice'}}) as {status:string}).status==='opened');
  run.status='completed';await eventually(()=>stale.out('text_chunk').length===1&&stale.voice().length===1);
  // The phone plays the first chunk on its old connection, then reconnects with a new route while the second is synthesized.
  const d=stale.out('accepted')[0].processed_event_id;stale.ack(d,stale.voice()[0],'played');await eventually(()=>stale.out('ack_receipt').length===1);
  phone.setRoute('route-2');const fresh=await connect(phone);
  // Its repeated ACK binds to the stamped route there, and its receipt shows the new connection is registered.
  fresh.ack(d,stale.voice()[0],'played');await eventually(()=>fresh.out('ack_receipt').length===1);
  const staleSeen=stale.room.published.length;release.resolve();
  await eventually(async()=>{await spool.sweep();const failure=errors.find(error=>(error as ContractError).code!=='ERRAND_RECIPIENT_CONNECTION_CHANGED');if(failure)throw failure;
    return fresh.out('text_chunk').length===1&&fresh.voice().length===1;});
  const text=fresh.out('text_chunk')[0].chunk,voice=fresh.voice()[0];
  assert.deepEqual(fresh.room.published.filter((p:any)=>p.processed_event_id===d&&p.operation!=='ack_receipt').map((p:any)=>p.operation).slice(0,3),['accepted','result_header','text_chunk']);
  assert.deepEqual([text.text,text.target_device_id,text.route_version,voice.route_version],['奶茶办好了','phone','route-1','route-1'],'chunks keep the route stamped at selection');
  fresh.ack(d,{...voice,route_version:'route-2'},'played');await eventually(()=>fresh.out('rejected').length===1);
  const acknowledged=Promise.withResolvers<void>(),acknowledge=runtime.acknowledge.bind(runtime);let completions=0;
  t.mock.method(runtime,'acknowledge',async(...args:Parameters<typeof acknowledge>)=>{
    try{const receipt=await acknowledge(...args);if(++completions===2)acknowledged.resolve();return receipt;}
    catch(error){acknowledged.reject(error);throw error;}
  });
  fresh.ack(d,text,'rendered');fresh.ack(d,voice,'played');await acknowledged.promise;
  await eventually(()=>fresh.out('ack_receipt').length===3);
  await spool.sweep();assert.ok((await fs.readdir(spoolDir)).includes(`${job.job_id}.delivered.json`));
  const sent=fresh.room.published.length;await spool.sweep();assert.equal(fresh.room.published.length,sent,'a delivered report is not replayed');
  assert.deepEqual(streams.map(s=>[s.room===stale.room?'stale':s.room===fresh.room?'fresh':'glasses',s.chunk.seq]),[['stale',1],['fresh',2]],'each chunk plays once; the played one is not replayed');
  assert.equal(stale.room.published.length,staleSeen,'the stale connection gets no late packet');
  assert.equal(JSON.stringify(g.room.published).includes(d),false,'the second device never receives the report');
  assert.equal(creates,1);assert.deepEqual(errors.map(error=>(error as ContractError).code),['OUTPUT_ACK_BINDING_MISMATCH']);
});

test('pinned camera SDK without a visual index rejects foreign streams, reserves count and bytes, times out and releases on disconnect',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-camera-stream-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sources=new FormalTerminalSources(),storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
  const native:NativeClient={create:async()=>{throw new Error('camera is an observation, not a native run');},
    status:async()=>{throw new Error('unused');},cancel:async()=>{throw new Error('unused');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'camera-test'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),
    sourceAuthority:sources,skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
  const received:any[]=[],publications:any[]=[],errors:unknown[]=[],progress:string[]=[];
  runtime.ingestVisualFrame=async(source,frame,session)=>{received.push({source,frame,session});return {frame_id:frame.frame_id,status:'stored'} as never;};
  const peers:{f:ReturnType<typeof fixture>;room:any;bridge:ReturnType<typeof createFormalTextIngress>}[]=[];
  for(let n=0;n<5;n++){
    const f=fixture(false,{primary:`camera-${n}`,watch:'watch',client:'watch-client'},['text'],{type:'glasses',registry:sources},false,`camera-session-${n}`),room=new Room() as any;
    Object.defineProperty(room,'isConnected',{value:true});room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});room.localParticipant={trackPublications:new Map(),sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{publications.push(JSON.parse(Buffer.from(bytes).toString('utf8')));}};
    const register=room.registerByteStreamHandler.bind(room);
    room.registerByteStreamHandler=(topic:string,handler:any)=>register(topic,(reader:any,sender:any)=>{reader.onProgress=()=>progress.push(reader.info.streamId);handler(reader,sender);});
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{room.cleanupOnDisconnect();}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
    await bridge.onBootstrapConnected(f.input);peers.push({f,room,bridge});
  }
  const frame={frame_id:'camera-one',captured_at:now,trigger:'scene_change',worn:true,private_paused:false};
  const bytes=Buffer.alloc(24000,1);bytes[0]=255;bytes[1]=216;bytes[23998]=255;bytes[23999]=217;
  const start=(peer:typeof peers[number],streamId:string,totalLength=bytes.length,metadata:unknown=frame,identity='terminal')=>peer.room.handleStreamHeader({
    streamId,topic:'paios.assistant.camera.v1',mimeType:'image/jpeg',totalLength:BigInt(totalLength),timestamp:0n,attributes:{frame:JSON.stringify(metadata)},contentHeader:{case:'byteHeader',value:{name:'frame.jpg'}}},identity);
  const chunk=(peer:typeof peers[number],streamId:string,content=bytes)=>peer.room.handleStreamChunk({streamId,content,chunkIndex:0n});
  const finish=(peer:typeof peers[number],streamId:string)=>peer.room.handleStreamTrailer({streamId});
  const settle=async()=>{for(let n=0;n<20;n++)await new Promise<void>(resolve=>setImmediate(resolve));};
  const p=peers[0]!;
  start(p,'foreign',bytes.length,frame,'foreign');chunk(p,'foreign');await settle();
  assert.equal(progress.includes('foreign'),false,'foreign streams are refused, not drained without a trailer');assert.equal(received.length,0);
  assert.equal(runtime.toolSchemas().some(tool=>tool.name==='paios_visual_recall'),false);
  start(p,'invalid',bytes.length,{...frame,image_base64:'/9j/2Q=='});start(p,'oversize',3000001);await settle();
  assert.ok(errors.some(error=>/FORMAL_CAMERA_FRAME_INVALID/.test(String(error))));assert.ok(errors.some(error=>/FORMAL_CAMERA_STREAM_SIZE_INVALID/.test(String(error))));
  assert.ok(publications.filter(packet=>packet.operation==='rejected').every(packet=>!('frame_id' in packet)),
    'invalid envelopes and headers cannot claim a camera frame');
  start(p,'valid');chunk(p,'valid');finish(p,'valid');await settle();
  assert.equal(received.length,1);assert.equal(received[0].source.principal_id,'actual-owner');assert.equal(received[0].session,'camera-session-0');assert.deepEqual(received[0].frame.image,bytes);
  assert.ok(publications.some(packet=>packet.operation==='camera_ack'));
  start(p,'queue-overflow',1000);chunk(p,'queue-overflow',Buffer.alloc(1001));await settle();
  assert.doesNotThrow(()=>{chunk(p,'queue-overflow');finish(p,'queue-overflow');});
  assert.equal(received.length,1,'the pinned SDK queue cannot retain bytes beyond the reservation');
  assert.ok(publications.some(packet=>packet.operation==='rejected'&&packet.frame_id===frame.frame_id),
    'a validated envelope retains its frame identity on a stream failure');
  const ingest=runtime.ingestVisualFrame,oldFailure=deferred<void>(),newFailure=deferred<void>();
  runtime.ingestVisualFrame=async(_source,frame)=>{received.push(frame);await (frame.frame_id==='old-frame'?oldFailure:newFailure).promise;throw new ContractError('CAMERA_CAPTURE_FAILED');};
  start(p,'old-frame',bytes.length,{...frame,frame_id:'old-frame'});chunk(p,'old-frame');finish(p,'old-frame');await settle();
  start(p,'new-frame',bytes.length,{...frame,frame_id:'new-frame'});chunk(p,'new-frame');finish(p,'new-frame');await settle();
  oldFailure.resolve();await settle();newFailure.resolve();await settle();
  assert.deepEqual(publications.filter(packet=>packet.operation==='rejected'&&['old-frame','new-frame'].includes(packet.frame_id)).map(packet=>packet.frame_id),['old-frame','new-frame']);
  runtime.ingestVisualFrame=ingest;received.splice(1);
  const authenticate=runtime.authenticate.bind(runtime);
  let authGate:ReturnType<typeof deferred<void>>|undefined,denyAuth=false,authEntered=0;
  t.after(()=>authGate?.resolve());
  t.mock.method(runtime,'authenticate',async(...args:Parameters<typeof authenticate>)=>{
    if(authGate){authEntered++;await authGate.promise;if(denyAuth)throw new ContractError('CAMERA_TEST_AUTH_DENIED',403);}
    return authenticate(...args);
  });
  for(const budget of ['device-count','device-bytes','global-count','global-bytes'] as const){
    authGate=deferred<void>();authEntered=0;
    if(budget==='device-bytes')start(p,'pending-big',3000000);
    else if(budget==='device-count'){start(p,'pending-one');start(p,'pending-two');}
    else for(const [n,peer] of peers.slice(0,4).entries())
      for(let k=0;k<(budget==='global-count'?2:1);k++)start(peer,`pending-${n}-${k}`,budget==='global-count'?bytes.length:3000000);
    const rejectedPeer=budget.startsWith('device')?p:peers[4]!;
    const admitted=budget==='device-count'?2:budget==='device-bytes'?1:budget==='global-count'?8:4;
    try {
      start(rejectedPeer,'pending-excess',budget==='global-count'?bytes.length:3000000);
      assert.equal(rejectedPeer.room.byteStreamControllers.has('pending-excess'),false,
        `${budget}: excess SDK streams must be removed before pre-auth chunks can queue`);
      assert.equal(authEntered,admitted,`${budget}: excess streams never enter async authentication`);
      // Publication authenticates independently after the synchronous stream rejection.
      chunk(rejectedPeer,'pending-excess');finish(rejectedPeer,'pending-excess');await settle();
      assert.ok(errors.some(error=>/FORMAL_CAMERA_CAPACITY/.test(String(error))));
    } finally {
      // Cancel while authentication is pending; its later completion must not regain a reservation.
      for(const peer of peers)peer.room.cleanupOnDisconnect();await settle();
      const gate=authGate;authGate=undefined;gate.resolve();await settle();errors.length=0;
    }
    for(const peer of peers)await peer.bridge.onBootstrapConnected(peer.f.input);
  }
  authGate=deferred<void>();denyAuth=true;start(p,'pending-denied',3000000);await settle();
  const deniedGate=authGate;authGate=undefined;deniedGate.resolve();await settle();denyAuth=false;
  // Shared auth rejection can retire other peers while their publications are pending.
  for(const peer of peers)await peer.bridge.onBootstrapConnected(peer.f.input);errors.length=0;
  errors.length=0;t.mock.timers.enable({apis:['setTimeout']});authGate=deferred<void>();
  start(p,'big',3000000);start(p,'device-bytes',3000000);start(p,'small');start(p,'device-count');await settle();
  assert.equal(errors.filter(error=>/FORMAL_CAMERA_CAPACITY/.test(String(error))).length,2);
  assert.doesNotThrow(()=>{chunk(p,'device-bytes');finish(p,'device-bytes');},'SDK state must be removed before later chunks/trailer');
  t.mock.timers.tick(5000);await settle();assert.equal(errors.filter(error=>/FORMAL_CAMERA_STREAM_INACTIVE/.test(String(error))).length,2);
  const timedOutGate=authGate;authGate=undefined;timedOutGate.resolve();await settle();
  start(p,'slow',3000000);await settle();
  for(let n=0;n<7;n++){t.mock.timers.tick(4000);chunk(p,'slow',Buffer.from([1]));await settle();}
  t.mock.timers.tick(2000);await settle();assert.ok(errors.some(error=>/FORMAL_CAMERA_STREAM_DEADLINE/.test(String(error))));
  assert.doesNotThrow(()=>chunk(p,'slow'));
  errors.length=0;
  for(const [n,peer] of peers.slice(0,4).entries())for(let k=0;k<2;k++)start(peer,`count-${n}-${k}`);
  for(let n=0;n<20;n++)start(peers[4]!,`excess-count-${n}`);await settle();
  assert.equal(errors.filter(error=>/FORMAL_CAMERA_CAPACITY/.test(String(error))).length,20,'global count bounds many half-finished streams');
  for(const peer of peers){await peer.bridge.onBootstrapConnected(peer.f.input);}await settle();errors.length=0;
  for(const [n,peer] of peers.slice(0,4).entries())start(peer,`bytes-${n}`,3000000);
  start(peers[4]!,'excess-bytes',3000000);await settle();assert.equal(errors.filter(error=>/FORMAL_CAMERA_CAPACITY/.test(String(error))).length,1,'global byte reservation is independent of count');
  for(const peer of peers)peer.room.cleanupOnDisconnect();await settle();
  for(const peer of peers)await peer.bridge.close();t.mock.timers.reset();
  const fresh=fixture(false,{primary:'camera-fresh',watch:'watch',client:'watch-client'},['text'],{type:'glasses',registry:sources}),room=new Room() as any;
  Object.defineProperty(room,'isConnected',{value:true});room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});room.localParticipant={trackPublications:new Map(),sendText:async(_text:string)=>{},publishData:async()=>{}};
  const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:fresh.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());await bridge.onBootstrapConnected(fresh.input);
  const peer={f:fresh,room,bridge};start(peer,'after-disconnect');chunk(peer,'after-disconnect');finish(peer,'after-disconnect');await settle();
  assert.equal(received.length,2,'disconnect releases all reservations for a new authenticated connection');
});

for(const cameraDevice of ['glasses','phone'] as const)test(`${cameraDevice} photo tool emits camera_capture_once through formal wire and requested SDK upload fulfills archive observation`,async t=>{
  const sources=new FormalTerminalSources(),glasses=fixture(false,{primary:'photo-glasses',watch:'watch',client:'client'},['text'],{type:cameraDevice,registry:sources},false,'camera-photo'),
    phone=fixture(false,{primary:'photo-phone',watch:'watch',client:'client'},['text'],{type:cameraDevice==='phone'?'mac':'phone',registry:sources},false,'owner-photo');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-photo-tool-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),run={run_id:'photo-run',session_id:'owner-photo',conversation_session_id:'owner-photo',status:'running'};
  const native:NativeClient={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'photo-wire'});
  const runtime=new PersonalAIOSRuntime({storage,archive,native,admission,output:new OutputAuthority(storage),sourceAuthority:sources,skill:'fixture',max_read_bytes:8192});t.after(()=>runtime.close());
  const room=new Room() as any,packets:any[]=[],errors:unknown[]=[];
  Object.defineProperty(room,'isConnected',{value:true});room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});
  room.localParticipant={trackPublications:new Map(),sendText:async(value:string)=>{packets.push(JSON.parse(value));},publishData:async(bytes:Uint8Array)=>{packets.push(JSON.parse(Buffer.from(bytes).toString()));}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>room.cleanupOnDisconnect()} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:glasses.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  const phoneRoom=testRoom(),phoneBridge=createFormalTextIngress({participant:{roomPort:phoneRoom} as unknown as LiveKitCloudParticipantPort,runtime,authority:phone.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>phoneBridge.close());
  let cameraReady=false;
  if(cameraDevice==='phone')t.mock.method(runtime,'cameraReady',async()=>{assert.ok(packets.some(p=>p.operation==='ready'));cameraReady=true;});
  await bridge.onBootstrapConnected(glasses.input);await phoneBridge.onBootstrapConnected(phone.input);
  if(cameraDevice==='phone')await eventually(()=>cameraReady);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  if(cameraDevice==='glasses'){send({operation:'wear_state',control_id:'photo-wear',worn:true});await eventually(()=>packets.some(p=>p.operation==='wear_state_ack'));}
  phoneRoom.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'photo-owner',captured_at:now,text:'拍张眼前照片'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>!!admission.find('photo-run'));
  const tool=()=>runtime.tool('paios_senses',{context:{run_id:'photo-run',session_id:'owner-photo',tool_call_id:'photo'},args:{sense:cameraDevice==='phone'?'phone_camera':'glasses_photo'}});
  let settled=false;const pending=tool().then(value=>{settled=true;return value;});
  await eventually(()=>packets.some(p=>p.operation==='camera_capture_once'));
  const command=packets.find(p=>p.operation==='camera_capture_once');assert.equal(command.schema_version,'paios.central.text-envelope.v1');assert.equal(command.session_id,'camera-photo');
  assert.equal(command.camera,cameraDevice==='phone'?'back':undefined);
  if(cameraDevice==='phone')assert.ok(command.expires_at_ms>Date.now()&&command.expires_at_ms<=Date.now()+20000);
  const bytes=Buffer.from('/9j/2Q==','base64');
  const upload=(frame_id:string,streamId:string)=>{
    const frame={frame_id,captured_at:new Date().toISOString(),trigger:'user_request',worn:true,private_paused:false};
    room.handleStreamHeader({streamId,topic:'paios.assistant.camera.v1',mimeType:'image/jpeg',totalLength:BigInt(bytes.length),timestamp:0n,
      attributes:{frame:JSON.stringify(frame)},contentHeader:{case:'byteHeader',value:{name:'frame.jpg'}}},'terminal');
    room.handleStreamChunk({streamId,content:bytes,chunkIndex:0n});room.handleStreamTrailer({streamId});
  };
  if(cameraDevice==='glasses'){upload('unrelated-photo','unrelated-stream');await eventually(()=>packets.some(p=>p.operation==='camera_ack'&&p.frame_id==='unrelated-photo'));assert.equal(settled,false);}
  upload(command.frame_id,'requested-stream');const observed=await pending as {status:string;frame_id:string;raw_ref:string;archive_revision:string};
  assert.equal(observed.status,'observed');assert.equal(observed.frame_id,command.frame_id);
  assert.deepEqual(await archive.read(observed.raw_ref,'actual-owner',observed.archive_revision),bytes);
  send({operation:'camera_private_pause',control_id:'photo-private',private_paused:true});
  await eventually(()=>packets.some(p=>p.operation==='camera_policy'&&p.control_id==='photo-private'));
  assert.deepEqual(await tool(),{status:'unavailable',error_code:'CAMERA_CAPTURE_PAUSED'});
  assert.equal(packets.filter(p=>p.operation==='camera_capture_once').length,1);assert.deepEqual(errors,[]);
});

test('photo failure wire settles only the authenticated requested frame',async t=>{
  const sources=new FormalTerminalSources(),glasses=fixture(false,{primary:'photo-glasses',watch:'watch',client:'client'},['text'],{type:'glasses',registry:sources},false,'camera-photo'),
    phone=fixture(false,{primary:'photo-phone',watch:'watch',client:'client'},['text'],{type:'phone',registry:sources},false,'owner-photo');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-photo-tool-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),run={run_id:'photo-run',session_id:'owner-photo',conversation_session_id:'owner-photo',status:'running'};
  const native:NativeClient={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'photo-wire'});
  const runtime=new PersonalAIOSRuntime({storage,archive,native,admission,output:new OutputAuthority(storage),sourceAuthority:sources,skill:'fixture',max_read_bytes:8192});t.after(()=>runtime.close());
  const room=new Room() as any,packets:any[]=[],errors:unknown[]=[];
  Object.defineProperty(room,'isConnected',{value:true});room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});
  room.localParticipant={trackPublications:new Map(),sendText:async()=>{},publishData:async(bytes:Uint8Array)=>{packets.push(JSON.parse(Buffer.from(bytes).toString()));}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>room.cleanupOnDisconnect()} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:glasses.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  const phoneRoom=testRoom(),phoneBridge=createFormalTextIngress({participant:{roomPort:phoneRoom} as unknown as LiveKitCloudParticipantPort,runtime,authority:phone.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>phoneBridge.close());
  await bridge.onBootstrapConnected(glasses.input);await phoneBridge.onBootstrapConnected(phone.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'wear_state',control_id:'photo-wear',worn:true});await eventually(()=>packets.some(p=>p.operation==='wear_state_ack'));
  phoneRoom.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'photo-owner',captured_at:now,text:'拍张眼前照片'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>!!admission.find('photo-run'));
  const tool=()=>runtime.tool('paios_senses',{context:{run_id:'photo-run',session_id:'owner-photo',tool_call_id:'photo'},args:{sense:'glasses_photo'}});
  let outcome:unknown,settled=false;
  const begin=()=>{settled=false;outcome=undefined;return tool().then(value=>{outcome=value;settled=true;},error=>{outcome=error;settled=true;});};
  const pending=begin();await eventually(()=>packets.some(p=>p.operation==='camera_capture_once'));
  const command=packets.find(p=>p.operation==='camera_capture_once');
  send({operation:'camera_capture_failed',frame_id:command.frame_id,error_code:'unapproved'});
  await eventually(()=>errors.length>0);assert.equal(settled,false);
  const before=errors.length;
  phoneRoom.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'camera_capture_failed',frame_id:command.frame_id,error_code:'CAMERA_CAPTURE_FAILED'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await new Promise(r=>setTimeout(r,20));assert.equal(errors.length,before);assert.equal(settled,false,'another device cannot end this photo request');
  send({operation:'camera_capture_failed',frame_id:'00000000-0000-4000-8000-000000000000',error_code:'CAMERA_CAPTURE_CANCELLED'});
  send({operation:'camera_capture_failed',frame_id:command.frame_id,error_code:'CAMERA_CAPTURE_UNAVAILABLE'});
  await eventually(()=>settled);await pending;assert.match(String(outcome),/CAMERA_CAPTURE_UNAVAILABLE/);
 });

test('authenticated incomplete photo upload settles its requested tool',async t=>{
  const sources=new FormalTerminalSources(),glasses=fixture(false,{primary:'photo-glasses',watch:'watch',client:'client'},['text'],{type:'glasses',registry:sources},false,'camera-photo'),
    phone=fixture(false,{primary:'photo-phone',watch:'watch',client:'client'},['text'],{type:'phone',registry:sources},false,'owner-photo');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-photo-tool-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),run={run_id:'photo-run',session_id:'owner-photo',conversation_session_id:'owner-photo',status:'running'};
  const native:NativeClient={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'photo-wire'});
  const runtime=new PersonalAIOSRuntime({storage,archive,native,admission,output:new OutputAuthority(storage),sourceAuthority:sources,skill:'fixture',max_read_bytes:8192});t.after(()=>runtime.close());
  const room=new Room() as any,packets:any[]=[],errors:unknown[]=[];
  Object.defineProperty(room,'isConnected',{value:true});room.remoteParticipants.set('terminal',{identity:'terminal',trackPublications:new Map()});
  room.localParticipant={trackPublications:new Map(),sendText:async()=>{},publishData:async(bytes:Uint8Array)=>{packets.push(JSON.parse(Buffer.from(bytes).toString()));}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>room.cleanupOnDisconnect()} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:glasses.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  const phoneRoom=testRoom(),phoneBridge=createFormalTextIngress({participant:{roomPort:phoneRoom} as unknown as LiveKitCloudParticipantPort,runtime,authority:phone.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>phoneBridge.close());
  await bridge.onBootstrapConnected(glasses.input);await phoneBridge.onBootstrapConnected(phone.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'wear_state',control_id:'photo-wear',worn:true});await eventually(()=>packets.some(p=>p.operation==='wear_state_ack'));
  phoneRoom.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'photo-owner',captured_at:now,text:'拍张眼前照片'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>!!admission.find('photo-run'));
  const tool=()=>runtime.tool('paios_senses',{context:{run_id:'photo-run',session_id:'owner-photo',tool_call_id:'photo'},args:{sense:'glasses_photo'}});
  let outcome:unknown,settled=false;
  const begin=()=>{outcome=undefined;settled=false;return tool().then(value=>{outcome=value;settled=true;},error=>{outcome=error;settled=true;});};
  const pending=begin();
  await eventually(()=>packets.some(p=>p.operation==='camera_capture_once'));
  const command=packets.find(p=>p.operation==='camera_capture_once'),streamId='known-failed-photo';
  room.handleStreamHeader({streamId,topic:'paios.assistant.camera.v1',mimeType:'image/jpeg',totalLength:4n,timestamp:0n,
    attributes:{frame:JSON.stringify({frame_id:command.frame_id,captured_at:new Date().toISOString(),trigger:'user_request',worn:true,private_paused:false})},
    contentHeader:{case:'byteHeader',value:{name:'frame.jpg'}}},'terminal');
  room.handleStreamChunk({streamId,content:Buffer.from([1]),chunkIndex:0n});room.handleStreamTrailer({streamId});
  await eventually(()=>settled);await pending;assert.match(String(outcome),/FORMAL_CAMERA_STREAM_INCOMPLETE/);
  const capacity=begin();await eventually(()=>packets.filter(p=>p.operation==='camera_capture_once').length===2);
  const next=packets.filter(p=>p.operation==='camera_capture_once')[1];
  const hold=(stream:string,frame:string)=>room.handleStreamHeader({streamId:stream,topic:'paios.assistant.camera.v1',mimeType:'image/jpeg',
    totalLength:2000001n,timestamp:0n,attributes:{frame:JSON.stringify({frame_id:frame,captured_at:new Date().toISOString(),
      trigger:'user_request',worn:true,private_paused:false})},contentHeader:{case:'byteHeader',value:{name:'frame.jpg'}}},'terminal');
  hold('held-photo','unrelated-held-photo');hold('capacity-probe','unrelated-probe-photo');
  await eventually(()=>errors.some(error=>error instanceof ContractError&&error.code==='FORMAL_CAMERA_CAPACITY'));
  assert.equal(settled,false,'unrelated failed frames cannot end the request');
  hold('requested-capacity-photo',next.frame_id);
  await eventually(()=>settled);await capacity;assert.match(String(outcome),/FORMAL_CAMERA_CAPACITY/);
});

// Real transport composition: pairing locates the glasses; it never authenticates the speaker.
test('glasses privacy round trip persists; camera reports stay quiet and enrich tool reads/failures; sealed cards retain OUT delivery identity',async t=>{
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'glasses',watch:'watch',client:'client'},['text'],{type:'glasses',registry:sources});
  const root=await fs.mkdtemp(join(tmpdir(),'glasses-contracts-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),nativeRun={run_id:'card-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:''};
  const native:NativeClient={create:async()=>({...nativeRun}),status:async()=>({...nativeRun}),cancel:async()=>({...nativeRun})};
  const {VisualMemory,CameraCapturePolicies}=await import('../../../services/personal-aios-integration/src/visual/store.ts');
  const visual=await VisualMemory.open(join(root,'visual'),{embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>{throw new Error('embedding unavailable');},
    describe:async()=>({caption:'remembered board',ocr:''})});t.after(()=>visual.close());
  const outreach:string[]=[];
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),native,output,
    admission:new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'glasses-contracts'}),
    sourceAuthority:sources,visual_memory:visual,notify:async()=>{outreach.push('notify');},skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
  const room=testRoom(),errors:unknown[]=[];let live=true;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{open:async()=>{outreach.push('open');},close:async()=>{},respond:async()=>{outreach.push('speak');return false;},
      context:async()=>{outreach.push('observe');return live;},attach:()=>()=>{}}});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC),
    out=(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[];
  send({operation:'wear_state',control_id:'wear',worn:true});await eventually(()=>out('wear_state_ack').length===1);
  send({operation:'camera_private_pause',control_id:'private-pause',private_paused:true});
  await eventually(()=>out('camera_policy').some(p=>p.control_id==='private-pause'));
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  assert.equal(out('camera_policy').find(p=>p.control_id==='private-pause').policy.private_paused,true);
  assert.equal((await new CameraCapturePolicies(storage).policyForConnect(source)).private_paused,true);
  await bridge.onBootstrapConnected(f.input);assert.equal(out('camera_policy').at(-1).policy.private_paused,true);
  send({operation:'wear_state',control_id:'rewear',worn:true});await eventually(()=>out('wear_state_ack').length===2);
  send({operation:'camera_private_pause',control_id:'private-resume',private_paused:false});
  await eventually(()=>out('camera_policy').some(p=>p.control_id==='private-resume'));
  assert.equal((await new CameraCapturePolicies(storage).policyForConnect(source)).private_paused,false);
  const accepted=await runtime.submit({schema_version:'paios.event.v1',event_id:'reply-event',captured_at:now,device_id:'glasses',device_type:'glasses',
    source:{channel:source.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',payload:Buffer.from('{"kind":"device_status"}')},source,'continuity',false);
  await eventually(async()=>Boolean((await runtime.event(source,'continuity',accepted.processed_event.processed_event_id)).admission.run_id));
  const context={run_id:'card-run',session_id:'continuity',tool_call_id:'camera-read'},
    readCamera=()=>runtime.tool('paios_visual_capture_policy',{context,args:{}}) as Promise<{camera_statuses:{device_id:string;status:string;error:string|null}[]}>;
  const before=out('camera_policy').length;
  for(const bad of [{operation:'camera_private_pause',control_id:'bad',private_paused:'false'},
    {operation:'camera_status',control_id:'bad',status:'error',error:null},
    {operation:'camera_status',control_id:'bad',status:'available',error:'not recovered'}])send(bad);
  await eventually(()=>out('rejected').length===3);assert.equal(errors.length,3);assert.equal(out('camera_policy').length,before);
  const published=room.published.length;
  if(process.env.PAIOS_CAMERA_REPORTS){
    const reports=JSON.parse(await fs.readFile(process.env.PAIOS_CAMERA_REPORTS,'utf8')) as {entry:string;phase:string;payload:{status:string;error:string|null}}[];
    assert.equal(reports.length,84);
    assert.deepEqual([...new Set(reports.map(report=>report.entry))].sort(),['connection_ready','state_change']);
    const cameraStatus=runtime.cameraStatus.bind(runtime);let acceptedReports=0;
    runtime.cameraStatus=async(...args)=>{await cameraStatus(...args);acceptedReports++;};
    try{
      for(const [index,report] of reports.entries()){
        send(report.payload);
        await eventually(()=>acceptedReports===index+1);
        const latest=(await readCamera()).camera_statuses[0];
        assert.equal(latest?.status,report.payload.status,`${report.entry}/${report.phase}`);
        assert.equal(latest?.error,report.payload.error,`${report.entry}/${report.phase}`);
      }
      assert.equal(out('rejected').length,3);assert.equal(errors.length,3);
    }finally{runtime.cameraStatus=cameraStatus;}
  }
  for(const report of [{status:'available',error:null},{status:'paused',error:null},{status:'unavailable',error:null},{status:'error',error:'CameraAccessException'}]){
    send({operation:'camera_status',control_id:`quiet-${report.status}`,...report});
    await eventually(async()=>{const reports=(await readCamera()).camera_statuses;return reports[0]?.status===report.status&&reports[0]?.error===report.error;});
  }
  assert.equal(room.published.length,published);assert.deepEqual(outreach,[]);
  live=false;send({operation:'wear_state',control_id:'off',worn:false});await eventually(()=>out('wear_state_ack').length===3);
  const offPublications=room.published.length;
  send({operation:'camera_status',control_id:'off-paused',status:'paused',error:null});
  await eventually(async()=>(await readCamera()).camera_statuses[0]?.status==='paused');
  assert.equal(room.published.length,offPublications);assert.deepEqual(outreach,[]);
  const image=await fs.readFile(new URL('../../../services/personal-aios-integration/tests/fixtures/continuous-coverage-rgba2x1.png',import.meta.url));
  const {trusted}=await f.authority.capture(f.authority.credentialForBootstrap(f.input));
  const archived=await runtime.existingArchive().archive({schema_version:'paios.event.v1',event_id:'old-view',captured_at:now,
    device_id:source.device_id,device_type:'glasses',source:{channel:source.channel},media_type:'visual',mime:'image/png',
    representation:'uploaded_original',payload:image},trusted);
  await visual.ingest(source.principal_id,source.device_id,{frame_id:'old-view',captured_at:now,image,trigger:'user_request',worn:true,private_paused:false},undefined,undefined,archived);
  send({operation:'camera_status',control_id:'off-error',status:'error',error:'CameraAccessException'});
  await eventually(async()=>(await readCamera()).camera_statuses[0]?.status==='error');
  const reports=[{device_id:'glasses',device_type:'glasses',status:'error',error:'CameraAccessException'}];
  const policy=await runtime.tool('paios_visual_capture_policy',{context,args:{interval_ms:60000}}) as any;
  assert.deepEqual(policy.camera_statuses,reports);assert.equal(policy.interval_ms,60000);
  const recalled=await runtime.tool('paios_visual_recall',{context,args:{}}) as any;
  assert.equal(recalled.frames[0].caption,'remembered board');assert.deepEqual(recalled.camera_statuses,reports);
  for(const [name,args,error_code,http_status] of [
    ['paios_visual_recall',{query:'board'},'INTERNAL_ERROR',500],
    ['paios_visual_analyze',{frame_id:'missing',question:'what is here?'},'VISUAL_FRAME_NOT_FOUND',404]] as const){
    assert.deepEqual(await runtime.tool(name,{context,args}),{status:'failed',error_code,http_status,camera_statuses:reports});
  }
  assert.deepEqual(outreach,[]);
  await runtime.tool('paios_open_reply',{context,args:{reply_mode:'text'}});
  nativeRun.status='completed';nativeRun.output='画'.repeat(2050);
  send({operation:'result',processed_event_id:accepted.processed_event.processed_event_id});
  await eventually(()=>out('display_card').filter(p=>p.delivery).length===3);
  const cards=out('display_card').filter(p=>p.delivery);assert.equal(cards.map(p=>p.lines.join('')).join(''),nativeRun.output);
  assert.equal(new Set(cards.map(p=>p.card_id)).size,3);assert.equal(out('text_chunk').length,0);
  assert.ok(cards.every(p=>Buffer.byteLength(JSON.stringify(p))<=REALTIME_ASSISTANT_MAX_PACKET_BYTES));
  const result=await runtime.result(source,'continuity',accepted.processed_event.processed_event_id),last=cards.at(-1).delivery;
  assert.equal(result.pending_text_chunk_count,3);
  const ack={...Object.fromEntries(['output_id','reply_id','reply_epoch','target_device_id','route_version'].map(key=>[key,last[key]])),
    highest_contiguous_seq:last.seq,status:'rendered',observed_at:now};
  assert.deepEqual(last,{processed_event_id:result.result.processed_event_id,...Object.fromEntries(
    ['output_id','reply_id','reply_epoch','target_device_id','route_version','seq','final'].map(key=>[key,(result.chunks.at(-1) as any)[key]]))});
  send({operation:'ack',processed_event_id:last.processed_event_id,ack});await eventually(()=>out('ack_receipt').length===1);
  assert.equal((await runtime.result(source,'continuity',last.processed_event_id)).pending_text_chunk_count,0);
  f.setSessionState('terminal');send({operation:'camera_private_pause',control_id:'revoked',private_paused:true});
  await eventually(()=>errors.length===4);assert.equal(out('camera_policy').length,before+1);
});

async function neutralDialHarness(t:import('node:test').TestContext,hooks:{room?:()=>boolean;connect?:(id:string)=>Promise<void>;close?:(id:string)=>Promise<void>}={}){
  const sources=new FormalTerminalSources(),root=await fs.mkdtemp(join(tmpdir(),'formal-neutral-dial-'));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),journal=AmbientJournal.open(join(root,'journal'));
  const native:NativeClient={create:async()=>{throw new Error('unverified dial cannot dispatch');},status:async()=>{throw new Error('no run');},cancel:async()=>{throw new Error('no run');},reminders:async()=>[]};
  const admission=new RunAdmission(storage,native,{max_pending_events:2,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'neutral-dial'});
  const model={id:'fixture-speaker',sha256:'e'.repeat(64),dim:16},registry=new VoiceprintRegistry(storage,model),vad=controlledVad();
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,sourceAuthority:sources,output:new OutputAuthority(storage),skill:'fixed',max_read_bytes:8192,ambient_journal:journal,voiceprint:registry,
    speech:async()=>({...vad,speaker_model:model,asr_model:{id:'unused',sha256:'f'.repeat(64)},transcribe:async()=>({text:''}),embed:async()=>new Float32Array(16),close:async()=>{}})});
  const errors:unknown[]=[],ownerInputs:string[]=[],contexts:string[]=[],lateClosed:string[]=[],settled:string[]=[],created:{id:string;instructions:string}[]=[],entered:{id:string;extra:any}[]=[],sinks=new Set<import('../src/personal-aios-formal-text.ts').CallSink>(),waiters=new Set<()=>void>();
  const changed=()=>{for(const check of waiters)check();},report=(error:unknown)=>{errors.push(error);changed();};
  const dispatch=new AsyncLocalStorage<{promise?:Promise<void>}>();
  const hook=createHook({init:(_id,type,_trigger,resource)=>{
    const request=dispatch.getStore();if(type==='PROMISE'&&request&&!request.promise)request.promise=resource as Promise<void>;
  }}).enable();
  const wait=async(predicate:()=>boolean)=>{
    t.signal.throwIfAborted();if(predicate())return;
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{waiters.delete(check);t.signal.removeEventListener('abort',abort);};
      const check=()=>{if(predicate()){cleanup();resolve();}},abort=()=>{cleanup();reject(t.signal.reason);};
      waiters.add(check);t.signal.addEventListener('abort',abort,{once:true});check();
    });
  };
  const owner=runtime.ownerInput.bind(runtime),context=runtime.callContext.bind(runtime);
  runtime.ownerInput=async source=>{ownerInputs.push(source.device_id);changed();return owner(source);};
  runtime.callContext=async(...args)=>{contexts.push(args[0].device_id);changed();return context(...args);};
  const call=createVoiceCallSession({room:()=>hooks.room?.()===false?undefined:{},vision:false,expressive:false,onError:report,
    onState:(...args)=>Promise.all([...sinks].map(sink=>sink.state(...args))).then(changed),onTranscript:()=>{},onTurn:()=>{},
    createPlayout:(_room,id)=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{const closing=hooks.close?.(id);changed();await closing;changed();}}),
    createFront:options=>{const id=call.pending()!;let closed=false;created.push({id,instructions:options.instructions});changed();return {connect:async()=>{const pending=hooks.connect?.(id);changed();await pending;if(closed&&options.onClose){options.onClose();lateClosed.push(id);}changed();},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{closed=true;}};}});
  const sites: {bridge:ReturnType<typeof createFormalTextIngress>}[]=[];
  t.after(async()=>{hook.disable();dispatch.disable();await call.closeAll();for(const site of sites)await site.bridge.close();await runtime.close();journal.close();registry.close();await fs.rm(root,{recursive:true,force:true});});
  const add=async(type:'glasses'|'phone'|'mac',options:{identity?:boolean}={})=>{
    const f=fixture(false,{primary:type,watch:'watch',client:'watch-client'},['text'],{type,registry:sources},true,`${type}-dial-session`),room=testRoom();
    const publish=room.localParticipant.publishData,sendText=room.localParticipant.sendText;
    room.localParticipant.publishData=async(...args)=>{await publish(...args);changed();};
    room.localParticipant.sendText=async(...args)=>{await sendText(...args);changed();};
    const wire={...call,open:async(id:string,extra?:Parameters<typeof call.open>[1])=>{entered.push({id,extra});changed();try{return await call.open(id,extra);}finally{settled.push(id);changed();}},attach:(sink:import('../src/personal-aios-formal-text.ts').CallSink)=>{sinks.add(sink);return()=>{sinks.delete(sink);};}};
    if(options.identity===false)Reflect.deleteProperty(wire,'identify');
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:report,voice_call:wire});
    sites.push({bridge});await bridge.onBootstrapConnected(f.input);
    // The first Promise belongs to the dispatched handler, which awaits its typed failure publication too.
    const send=(operation:string,call_id:string,extra:Record<string,unknown>={})=>{
      const request:{promise?:Promise<void>}={};dispatch.run(request,()=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation,call_id,...extra})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC));
      assert.ok(request.promise,'formal input starts its handler');return request.promise;
    };
    if(type==='glasses'){room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'wear_state',control_id:'neutral-wear',worn:true})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await wait(()=>room.published.some((p:any)=>p.operation==='wear_state_ack'));}
    const source=await f.authority.authenticate(f.authority.credentialForBootstrap(f.input));
    const live=(id:string)=>call.active()===id&&settled.includes(id)&&room.published.some((p:any)=>p.operation==='call_state'&&p.call_id===id&&p.state==='live');
    const dial=async(id:string)=>{await send('call_open',id);assert.equal(call.active(),id);await wait(()=>live(id));};
    return {source,send,dial,live,states:()=>room.published.filter((p:any)=>p.operation==='call_state') as any[],failures:(id:string)=>room.published.filter((p:any)=>p.operation==='call_state'&&p.call_id===id&&p.state==='failed') as any[],published:room.published};
  };
  const neutral=(id:string)=>{assert.equal(entered.find(item=>item.id===id)?.extra.mode,'ambient');assert.match(created.find(item=>item.id===id)!.instructions,/正在确认声音/);assert.doesNotMatch(created.find(item=>item.id===id)!.instructions,/关于主人/);};
  return {runtime,call,add,neutral,wait,errors,ownerInputs,contexts,lateClosed,settled,created,entered};
}
test('N13 call state explains the old phone dial timeout and matching clients close without the rejoin lease',{timeout:15000},async t=>{
  // This is the exact call_state schema shipped in the owner's 10-19 client, which rejects unknown properties.
  const legacy=createFormalWireAjv().compile(JSON.parse(await fs.readFile(new URL('fixtures/call-state-92cb51e76.json',import.meta.url),'utf8')));
  const h=await neutralDialHarness(t),site=await h.add('phone');
  await site.dial('legacy-phone');
  const live=site.states().find(p=>p.state==='live');
  const contract=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const current=createFormalWireAjv().compile(contract.outputs.call_state);
  assert.ok(live);assert.equal(legacy(live),false);
  assert.ok(legacy.errors?.some(error=>error.keyword==='additionalProperties'&&error.params.additionalProperty==='conversation_mode'));
  const {conversation_mode,...legacyState}=live;assert.equal(conversation_mode,'chat');assert.ok(legacy(legacyState));
  for(const state of site.states())assert.ok(current(state),JSON.stringify(current.errors));
  assert.equal(h.call.conversationMode('legacy-phone'),'chat','the default call still uses Chat mode internally');
  assert.equal(h.call.rejoinWindowS,120,'only transport loss opens the existing two-minute rejoin window');
  const started=Date.now();await site.send('call_close','legacy-phone',{reason:'button'});
  assert.equal(h.call.pending(),undefined);
  const elapsed=Date.now()-started;t.diagnostic(JSON.stringify({hangup_ms:elapsed,rejoin_window_s:h.call.rejoinWindowS}));
  assert.ok(elapsed<5000,'the authenticated hang-up closes within seconds, without the 120 s peer-loss lease');
  assert.deepEqual(site.states().slice(-2).map(p=>p.state),['closing','closed']);
  assert.ok(site.states().slice(-2).every(p=>current(p)),JSON.stringify(current.errors));
  assert.deepEqual(h.errors,[]);
});
for(const terminal of ['glasses','mac'] as const)test(`neutral ${terminal} explicit dial replaces its live call through real runtime`,{timeout:5000},async t=>{
  const h=await neutralDialHarness(t),site=await h.add(terminal);
  await site.dial('neutral-first');await site.dial('neutral-second');
  assert.ok(site.states().some(p=>p.call_id==='neutral-first'&&p.state==='closed'));h.neutral('neutral-second');
  assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);assert.equal(site.failures('neutral-second').length,0);
});
test('neutral glasses immediate redial while closing admits only the newest explicit dial',{timeout:5000},async t=>{
  const retired=Promise.withResolvers<void>();let closing=0;
  const h=await neutralDialHarness(t,{close:async id=>{if(id==='neutral-first'){closing++;await retired.promise;}}}),site=await h.add('glasses');
  let closingRequest:Promise<void>|undefined,second:Promise<void>|undefined,third:Promise<void>|undefined;
  try{
    await site.dial('neutral-first');closingRequest=site.send('call_close','neutral-first');await h.wait(()=>closing===1);
    second=site.send('call_open','neutral-second');await h.wait(()=>h.entered.some(p=>p.id==='neutral-second'));
    third=site.send('call_open','neutral-third');await h.wait(()=>h.entered.some(p=>p.id==='neutral-third'));retired.resolve();
    await Promise.all([closingRequest,second,third]);assert.equal(h.call.active(),'neutral-third');await h.wait(()=>site.live('neutral-third'));
    assert.equal(site.failures('neutral-second').length,1);
    assert.equal(site.failures('neutral-second')[0].error_code,'VOICE_CALL_SUPERSEDED');assert.equal(site.failures('neutral-second')[0].reason,'error');
    assert.equal(h.created.some(p=>p.id==='neutral-second'),false);h.neutral('neutral-third');
    const states=site.states().map(p=>`${p.call_id}:${p.state}`);assert.ok(states.indexOf('neutral-first:closed')>=0);assert.ok(states.indexOf('neutral-first:closed')<states.indexOf('neutral-third:live'));
    assert.equal(site.failures('neutral-third').length,0);assert.ok(site.failures('neutral-first').length<=1);assert.equal(closing,1);assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);
  }finally{retired.resolve();await Promise.all([closingRequest,second,third]);}
});
test('neutral glasses two quick opening dials cancel the first and keep the newest neutral',{timeout:5000},async t=>{
  const connecting=Promise.withResolvers<void>();let firstConnected=false;
  const h=await neutralDialHarness(t,{connect:async id=>{if(id==='neutral-first'){firstConnected=true;await connecting.promise;}}}),site=await h.add('glasses');
  let first:Promise<void>|undefined;
  try{
    first=site.send('call_open','neutral-first');await h.wait(()=>firstConnected);
    await site.dial('neutral-second');await first;assert.equal(site.failures('neutral-first').length,1);
    assert.equal(site.failures('neutral-first')[0].error_code,'VOICE_CALL_SUPERSEDED');h.neutral('neutral-second');
    connecting.resolve();await h.wait(()=>h.lateClosed.includes('neutral-first'));assert.equal(h.call.active(),'neutral-second');
    assert.equal(site.states().some(p=>p.call_id==='neutral-first'&&p.state==='live'),false);assert.equal(site.failures('neutral-second').length,0);assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);
  }finally{connecting.resolve();await first;}
});
test('neutral glasses replacement close failure reports one safe failed after old closed',{timeout:5000},async t=>{
  const failure=new Error('private neutral retirement detail'),retired=Promise.withResolvers<void>();let closing=0;
  const h=await neutralDialHarness(t,{close:async id=>{if(id==='neutral-first'){closing++;await retired.promise;}}}),site=await h.add('glasses');
  let second:Promise<void>|undefined;
  try{
    await site.dial('neutral-first');second=site.send('call_open','neutral-second');await h.wait(()=>closing===1);retired.reject(failure);
    await second;assert.equal(site.failures('neutral-second').length,1);
    assert.equal(site.failures('neutral-second')[0].error_code,'VOICE_CALL_OPEN_FAILED');assert.equal(site.failures('neutral-second')[0].reason,'error');
    const states=site.states().map(p=>`${p.call_id}:${p.state}`);assert.ok(states.indexOf('neutral-first:closed')>=0);assert.ok(states.indexOf('neutral-first:closed')<states.indexOf('neutral-second:failed'));
    assert.equal(h.call.pending(),undefined);assert.equal(JSON.stringify(site.published).includes(failure.message),false);assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);
  }finally{retired.resolve();await second;}
});
test('phone owner to glasses explicit dial replaces the call without transferring owner context',{timeout:5000},async t=>{
  const h=await neutralDialHarness(t),phone=await h.add('phone'),glasses=await h.add('glasses');
  await phone.dial('phone-owner');const contexts=h.contexts.length;
  await glasses.dial('glasses-neutral');h.neutral('glasses-neutral');
  assert.ok(phone.states().some(p=>p.call_id==='phone-owner'&&p.state==='closed'));assert.deepEqual(h.ownerInputs,['phone']);assert.equal(h.contexts.length,contexts);assert.equal(glasses.failures('glasses-neutral').length,0);
});
test('neutral glasses automatic wake and care stay quiet during an explicit live dial',{timeout:5000},async t=>{
  const h=await neutralDialHarness(t),site=await h.add('glasses');await site.dial('neutral-live');
  const created=h.created.length,at=Date.now();
  for(const say of [undefined,'关心一句'])await h.runtime.openAmbientVoice(site.source,'glasses-dial-session',{id:say?'automatic-care':'automatic-wake',text:'',heard_at:new Date(at).toISOString(),start_ms:at,end_ms:at,...(say?{say}:{})});
  assert.equal(h.call.active(),'neutral-live');assert.equal(h.created.length,created);h.neutral('neutral-live');assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);
});
for(const terminal of ['phone','glasses'] as const)test(`${terminal} wire wake_word stays quiet while an explicit call is live`,{timeout:5000},async t=>{
  const h=await neutralDialHarness(t),site=await h.add(terminal);await site.dial('explicit-live');
  const created=h.created.length,contexts=h.contexts.length;await site.send('call_open','automatic-wire',{wake_word:true});
  assert.ok(h.errors.some(error=>error instanceof ContractError&&error.code==='VOICE_CALL_BUSY'));
  assert.equal(h.call.active(),'explicit-live');assert.equal(h.created.length,created);assert.equal(h.contexts.length,contexts);
  assert.equal(site.states().some(p=>p.call_id==='automatic-wire'),false);assert.equal(site.states().some(p=>p.call_id==='explicit-live'&&p.state==='closed'),false);
  if(terminal==='glasses'){h.neutral('explicit-live');assert.deepEqual(h.ownerInputs,[]);}
});
for(const code of ['VOICE_CALL_ROOM_REQUIRED','AMBIENT_VOICE_IDENTITY_REQUIRED'] as const)test(`neutral glasses call_open reports one exact ${code} failure`,{timeout:5000},async t=>{
  const h=await neutralDialHarness(t,{room:()=>code!=='VOICE_CALL_ROOM_REQUIRED'}),site=await h.add('glasses',{identity:code!=='AMBIENT_VOICE_IDENTITY_REQUIRED'});
  await site.send('call_open','neutral-failed');
  assert.equal(site.failures('neutral-failed').length,1);assert.equal(site.failures('neutral-failed')[0].error_code,code);assert.equal(site.failures('neutral-failed')[0].reason,'error');
  assert.equal(h.call.pending(),undefined);assert.equal(h.created.length,0);assert.deepEqual(h.ownerInputs,[]);assert.deepEqual(h.contexts,[]);
});

test('manual glasses call uses the neutral ambient binding; only the phone can confirm or enroll',async t=>{
  const sources=new FormalTerminalSources(),phone=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources}),
    glasses=fixture(false,{primary:'glasses',watch:'watch',client:'watch-client'},['text'],{type:'glasses',registry:sources},true);
  const root=await fs.mkdtemp(join(tmpdir(),'formal-owner-trust-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),journal=AmbientJournal.open(join(root,'journal'));t.after(()=>journal.close());
  const native:NativeClient={create:async()=>{throw new Error('no unverified owner run');},status:async()=>{throw new Error('no run');},cancel:async()=>{throw new Error('no run');},reminders:async()=>[]};
  const admission=new RunAdmission(storage,native,{max_pending_events:2,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'trust'});
  const model={id:'fixture-speaker',sha256:'e'.repeat(64),dim:16},registry=new VoiceprintRegistry(storage,model),vad=controlledVad();t.after(()=>registry.close());
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,sourceAuthority:sources,output:new OutputAuthority(storage),skill:'fixed',max_read_bytes:8192,ambient_journal:journal,voiceprint:registry,
    speech:async()=>({...vad,speaker_model:model,asr_model:{id:'unused',sha256:'f'.repeat(64)},transcribe:async()=>({text:''}),embed:async()=>new Float32Array(16),close:async()=>{}})});t.after(()=>runtime.close());
  const ps=await phone.authority.authenticate(phone.authority.credentialForBootstrap(phone.input)),gs=await glasses.authority.authenticate(glasses.authority.credentialForBootstrap(glasses.input));
  await assert.rejects(runtime.confirmVoice(gs,{confirmation_id:'a'.repeat(64)}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await assert.rejects(runtime.voiceprintOwner(gs),/VOICEPRINT_DEVICE_REQUIRED/);
  await assert.rejects(runtime.voiceprintEnroll(gs,[]),/VOICEPRINT_DEVICE_REQUIRED/);
  await assert.rejects(runtime.voiceprintForget(gs),/VOICEPRINT_DEVICE_REQUIRED/);
  await assert.rejects(runtime.confirmVoice(ps,{confirmation_id:'a'.repeat(64)}),/VOICE_CONFIRMATION_NOT_FOUND/);
  assert.equal((await runtime.voiceprintOwner(ps)).enrolled,false);
  const room=testRoom(),instructions:string[]=[],errors:unknown[]=[];let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined,captures=0;
  const call=createVoiceCallSession({room:()=>room as never,vision:false,expressive:false,onError:error=>errors.push(error),
    onState:(...args)=>sink?.state(...args),onTranscript:(...args)=>sink?.transcript(...args),onTurn:value=>sink?.turn(value),
    createPlayout:()=>({open:async()=>{},push:()=>{},clear:()=>{},drain:async()=>{},close:async()=>{}} as never),
    createFront:options=>{instructions.push(options.instructions);return {connect:async()=>{},sendAudio:()=>{},sendImage:()=>{},respond:async()=>{},close:async()=>{},setInstructions:async()=>{}} as never;}});t.after(()=>call.closeAll());
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:glasses.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{...call,attach:value=>{sink=value;return()=>{sink=undefined;};}},
    voice_capture:{open:async()=>{captures++;},commit:async()=>{throw new Error('unused');},cancel:()=>false}});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(glasses.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'wear_state',control_id:'call-wear',worn:true});await eventually(()=>room.published.some((p:any)=>p.operation==='wear_state_ack'));
  send({operation:'call_open',call_id:'glasses-button'});await eventually(()=>instructions.length===1);
  assert.equal(call.pending(),'glasses-button');assert.match(instructions[0]!,/正在确认声音/);assert.doesNotMatch(instructions[0]!,/关于主人/);
  send({operation:'voiceprint_open',operation_id:'glasses-enroll'});await eventually(()=>room.published.some((p:any)=>p.operation==='rejected'));
  assert.equal(captures,0);assert.equal((room.published.find((p:any)=>p.operation==='rejected') as any).error_code,'VOICEPRINT_DEVICE_REQUIRED');
  assert.equal(errors.filter(error=>!/VOICEPRINT_DEVICE_REQUIRED/.test(String(error))).length,0);
});

test('opted-in Mac owner unlock retains the neutral manual-call boundary',async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],neutral:unknown[]=[],video:unknown[]=[],opened:unknown[]=[];
  const source={principal_id:'actual-owner',device_id:'mac',device_type:'mac',channel:'rtc_typed_text',capabilities:[...MAC_CAPABILITIES,'owner_unlock']};
  let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined,ownsLive:()=>boolean=()=>false,ownerInputs=0,contextReads=0,confirmationWatchers=0;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>source,formalVoice:async(_s:unknown,_m:string,consume:()=>Promise<unknown>)=>consume(),
    terminalChanged:()=>{},ownerInput:async()=>{ownerInputs++;},activeTerminal:()=>true,
    watchVoiceConfirmations:async()=>{confirmationWatchers++;return()=>{};},watchAmbientTurns:async()=>()=>{},
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async(_s:unknown,_show:unknown,_speak:unknown,_context:unknown,isOwner:()=>boolean)=>{ownsLive=isOwner;return()=>{};},
    openAmbientVoice:async(_s:unknown,_session:string,wake:unknown)=>{neutral.push(wake);return false;},
    callContext:async()=>{contextReads++;return 'PRIVATE_OWNER_CONTEXT';}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{open:async(...args)=>{opened.push(args);},close:async()=>{},respond:async()=>false,identify:async()=>true,
      videoCommand:(...args)=>{video.push(args);},attach:value=>{sink=value;return()=>{sink=undefined;};}}});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);
  room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_open',call_id:'mac-neutral',video:true,video_revision:1})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>errors.length===1);
  assert.match(String(errors[0]),/AMBIENT_VOICE_OPEN_FAILED/);assert.equal(neutral.length,1);
  assert.equal((neutral[0] as {id:string}).id,'manual-mac-neutral');
  assert.equal(ownerInputs,0);assert.equal(contextReads,0);assert.deepEqual(opened,[]);assert.deepEqual(video,[]);
  await sink!.state('mac-neutral','opening',{mode:'manual'});
  assert.equal(ownsLive(),false,'opening a retained Mac call context does not grant owner identity');
  await sink!.state('mac-neutral','live',{mode:'manual'});
  assert.equal(ownsLive(),false,'the manual state callback does not turn Mac owner_unlock into owner call identity');
  assert.equal(confirmationWatchers,1,'Mac owner_unlock still subscribes to identity confirmation cards');
});

// Model output is synthetic; archive, processor identity proof, card authority and call binding are real.
test('worn glasses questions retain their initiating session; only current-wear verified voice grants owner gesture scope',async t=>{
  const sources=new FormalTerminalSources(),phone=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources}),
    glasses=fixture(false,{primary:'glasses',watch:'watch',client:'watch-client'},['text'],{type:'glasses',registry:sources},true,'glasses-session');
  const root=await fs.mkdtemp(join(tmpdir(),'formal-cards-proof-')),cleanup:(()=>unknown|Promise<unknown>)[]=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();await fs.rm(root,{recursive:true,force:true});});
  const storage=new PosixStorage(root),budget={max_chunk_bytes:50000,max_total_bytes:300000,max_chunks:20,max_revisions:20,max_seq:20},
    archive=new RawArchive(storage,50000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  cleanup.push(()=>storage.close(),()=>archive.close());
  const capability={id:'local-sherpa-audio',version:'fixture',modalities:['audio' as const],formats:['pcm_s16le:16000:1'],joint_av:false,
    healthy:true,permitted:true,max_duration_ms:5000,execution:'local' as const,evidence:'real_verified' as const,speaker_identity:'local_voiceprint' as const};
  const processor=new MediaProcessor(storage,new Map([[capability.id,{analyze:async request=>transcriptionResult(request,capability,'主人声音',{speaker:'owner'})}]]),
    {policy_version:'card-proof',max_inflight:1,max_input_bytes:200000,timeout_ms:2000,allow_external:false,allow_replay:false,allow_partial:true});
  const media=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[capability],fixtureOnly:true,
    vad:{candidates:async request=>{const range=request.time_range as {start_ms:number;end_ms:number};return [{start_ms:range.start_ms,end_ms:range.end_ms,semantic_status:'open',basis:'controlled'}];}},
    align:{max_chunks:20,max_visual_refs:1,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:5000});
  const runs=new Map<string,NativeRun>(),bodies:any[]=[],notices:string[]=[];
  const native:NativeClient={create:async body=>{bodies.push(body);const run={run_id:`card-run-${bodies.length}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},
    status:async id=>({...runs.get(id)!}),cancel:async id=>({...runs.get(id)!}),reminders:async()=>[]};
  const admission=new RunAdmission(storage,native,{max_pending_events:16,max_pending_bytes:1000000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'cards'});
  const journal=AmbientJournal.open(join(root,'journal')),model={id:'fixture-speaker',sha256:'e'.repeat(64),dim:16},registry=new VoiceprintRegistry(storage,model),vad=controlledVad();
  cleanup.push(async()=>{journal.close();await registry.close();});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,media,sourceAuthority:sources,ambient_journal:journal,voiceprint:registry,
    speech:async()=>({...vad,speaker_model:model,asr_model:{id:'unused',sha256:'f'.repeat(64)},transcribe:async()=>({text:''}),embed:async()=>new Float32Array(16),close:async()=>{}}),output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),
    skill:'fixed',max_read_bytes:50000,notify:async notice=>{notices.push(notice.body);},audio_route:async(source,event)=>({consumer:'media',source_scope:source.device_id,capture_span:event.raw_ref,purpose_evidence_ref:event.consent_ref})});
  cleanup.push(async()=>{await runtime.close();await processor.close();});
  const errors:unknown[]=[],instructions:string[]=[],room=testRoom();let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const call=createVoiceCallSession({room:()=>room as never,vision:false,expressive:false,onError:error=>errors.push(error),onState:(...args)=>sink?.state(...args),
    onTranscript:(...args)=>sink?.transcript(...args),onTurn:value=>sink?.turn(value),
    createPlayout:()=>({open:async()=>{},push:()=>{},clear:()=>{},drain:async()=>{},close:async()=>{}} as never),
    createFront:options=>{instructions.push(options.instructions);return {connect:async()=>{},sendAudio:()=>{},sendImage:()=>{},respond:async()=>{},close:async()=>{},setInstructions:async()=>{}} as never;}});
  cleanup.push(()=>call.closeAll());
  const spoolDir=join(root,'errands'),spool=createErrandSpool(spoolDir,error=>errors.push(error),{deliver:r=>runtime.deliverErrand(r,error=>errors.push(error))});await spool.start();cleanup.push(()=>spool.close());
  const job='job-0123456789ab';await fs.writeFile(join(spoolDir,`${job}.running.json`),JSON.stringify({principal_id:'actual-owner',job_id:job,title:'点奶茶',app:'千问',state:'running',started_at:now,step:1,max_steps:20}));
  const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:glasses.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:spool,onError:error=>errors.push(error),voice_call:{...call,attach:value=>{sink=value;return()=>{sink=undefined;};}}});cleanup.push(()=>bridge.close());
  const phoneRoom=testRoom(),phoneBridge=createFormalTextIngress({participant:{roomPort:phoneRoom} as unknown as LiveKitCloudParticipantPort,runtime,authority:phone.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});cleanup.push(()=>phoneBridge.close());
  await phoneBridge.onBootstrapConnected(phone.input);await bridge.onBootstrapConnected(glasses.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC),
    out=(operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[];
  const ps=await runtime.authenticate(phone.authority.credentialForBootstrap(phone.input)),gs=await runtime.authenticate(glasses.authority.credentialForBootstrap(glasses.input));
  const request=await runtime.submit({schema_version:'paios.event.v1',event_id:'phone-question',captured_at:now,device_id:'phone',device_type:'phone',source:{channel:ps.channel},
    media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('继续问我')},ps,'continuity',true);
  await eventually(()=>bodies.length===1);let context={run_id:'card-run-1',session_id:'continuity',tool_call_id:'question'};
  await eventually(async()=>(await runtime.tool('paios_open_reply',{context,args:{reply_mode:'text'}}) as any).status==='opened');
  assert.deepEqual(runtime.paymentSource('card-run-1'),{allowed:false,ride_allowed:true});
  let control=0;const wear=async(worn:boolean)=>{const control_id=`wear-${++control}`;send({operation:'wear_state',control_id,worn});await eventually(()=>out('wear_state_ack').some(p=>p.control_id===control_id));return out('wear_state_ack').at(-1);};
  await wear(true);await runtime.ownerInput(gs);
  send({operation:'errand_cancel',job_id:job});await eventually(()=>out('rejected').some(p=>p.error_code==='TERMINAL_OWNER_VOICE_REQUIRED'));
  await assert.rejects(fs.stat(join(spoolDir,`${job}.cancel`)),{code:'ENOENT'});
  let caller=0;
  const prepare=async()=>{if(runs.get(context.run_id)!.status==='running')return;
    const accepted=await runtime.submit({schema_version:'paios.event.v1',event_id:`phone-question-${++caller}`,captured_at:now,device_id:'phone',device_type:'phone',source:{channel:ps.channel},
      media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('继续问我')},ps,'continuity',true);
    await eventually(()=>bodies.some(b=>JSON.parse(b.input).processed_event_id===accepted.processed_event.processed_event_id));
    context={...context,run_id:[...runs.keys()].at(-1)!};await eventually(async()=>(await runtime.tool('paios_open_reply',{context,args:{reply_mode:'text'}}) as any).status==='opened');
    await runtime.ownerInput(gs);
  };
  const finishCaller=async()=>{Object.assign(runs.get(context.run_id)!,{status:'completed',output:''});await eventually(()=>!admission.find(context.run_id));};
  const question=async(intent?:'ride')=>{await prepare();const card=await runtime.tool('paios_terminal_question',{context:{...context,tool_call_id:`question-${out('display_card').length}`},
    args:{question:intent?'叫车回家？':'要继续吗？',options:[{id:'yes',label:'继续',lines:[]},{id:'no',label:'停止',lines:[]}],...(intent?{intent}:{})}}) as {card_id:string};await finishCaller();return card;};
  const answer=async(kind:'nod'|'shake'|'tap',value:'yes'|'no',intent?:'ride')=>{const phoneCardsBefore=phoneRoom.published.filter((p:any)=>p.operation==='gesture_card').length,card=await question(intent),before=out('accepted').length;
    assert.equal(out('display_card').at(-1).card_id,card.card_id);assert.deepEqual(out('display_card').at(-1).lines,[intent?'叫车回家？':'要继续吗？']);
    assert.equal(phoneRoom.published.filter((p:any)=>p.operation==='gesture_card').length,phoneCardsBefore);
    send({operation:'card_answer',card_id:card.card_id,kind,answer:value});await eventually(()=>out('accepted').length>before);
    const accepted=out('accepted').at(-1);await eventually(()=>out('accepted').some(a=>a.processed_event_id===accepted.processed_event_id&&a.admission.run_id));
    const current=out('accepted').find(a=>a.processed_event_id===accepted.processed_event_id&&a.admission.run_id),run=current.admission.run_id;
    const event=(await runtime.event(gs,'continuity',current.processed_event_id)).processed_event;
    assert.equal((event.content.app_event as {text:string}).text,value==='yes'?'继续':'停止');assert.equal(runs.get(run)!.session_id,'continuity');
    return {event,run,accepted:current};};
  const guest=await answer('nod','yes');assert.equal(runtime.paymentSource(guest.run).allowed,false);assert.equal(runtime.paymentSource(guest.run).ride_allowed,false);assert.equal(bodies.find(b=>JSON.parse(b.input).processed_event_id===guest.event.processed_event_id).run_scope,'guest');
  await assert.rejects(runtime.tool('paios_terminal_question',{context:{...context,run_id:guest.run},args:{options:[{id:'yes',label:'是',lines:[]},{id:'no',label:'否',lines:[]}]}}),/RUN_SCOPE_TOOL_DENIED/);
  Object.assign(runs.get(guest.run)!,{status:'completed',output:''});await runtime.result(gs,'continuity',guest.event.processed_event_id);
  let seq=0;const hear=async(start:number)=>{const event_id=`voice-${++seq}`,pcm=Buffer.alloc(38400,1),epoch=`audio-${seq}`;
    const archived=await runtime.appendMedia({schema_version:'paios.event.v1',event_id,captured_at:new Date(start).toISOString(),device_id:'glasses',device_type:'glasses',source:{channel:gs.channel},
      media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm},gs,{track_id:'mic',stream_epoch:epoch,seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'capture',stream_epoch:epoch,start_ms:0,end_ms:1200}});
    const result=await runtime.processMedia(gs,'glasses-session',event_id,{raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
      time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:start,end_ms:start+1200},clock_maps:[{modality:'audio',track_id:'mic',stream_epoch:epoch,source_timebase_id:'capture',target_timebase_id:'utc_epoch_ms',offset_ms:start,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]});
    for(const e of result.events){await eventually(async()=>Boolean((await runtime.event(gs,'glasses-session',e.processed_event.processed_event_id)).admission.run_id));
      const event=await runtime.event(gs,'glasses-session',e.processed_event.processed_event_id),run=runs.get(event.admission.run_id!)!;
      Object.assign(run,{status:'completed',output:''});await runtime.result(gs,'glasses-session',e.processed_event.processed_event_id);}
  };
  const oldWear=Date.now();await hear(oldWear);assert.equal((await wear(true)).owner_verified,true);
  send({operation:'errand_cancel',job_id:job});await eventually(async()=>{try{await fs.stat(join(spoolDir,`${job}.cancel`));return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}});
  const trusted=await answer('nod','yes','ride');assert.equal(bodies.find(b=>JSON.parse(b.input).processed_event_id===trusted.event.processed_event_id).run_scope,undefined);
  assert.equal(runtime.paymentSource(trusted.run).allowed,false);assert.equal(runtime.paymentSource(trusted.run).ride_allowed,true);assert.equal(Object.hasOwn(bodies.find(b=>JSON.parse(b.input).processed_event_id===trusted.event.processed_event_id),'memory_write'),false);
  await assert.rejects(runtime.tool('paios_action_request',{context:{...context,run_id:trusted.run},args:{}}),/GESTURE_PROTECTED_ACTION_DENIED/);
  await assert.rejects(runtime.confirmVoice(gs,{confirmation_id:'a'.repeat(64)}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await runtime.tool('paios_open_reply',{context:{...context,run_id:trusted.run},args:{reply_mode:'text'}});Object.assign(runs.get(trusted.run)!,{status:'completed',output:'继续后的回答'});
  send({operation:'result',processed_event_id:trusted.event.processed_event_id});await eventually(()=>out('display_card').some(p=>p.lines[0]==='继续后的回答'));
  assert.equal(out('display_card').find(p=>p.lines[0]==='继续后的回答').delivery.target_device_id,'glasses');
  assert.equal(phoneRoom.published.filter((p:any)=>p.operation==='text_chunk').length,0);
  const finishAnswer=async(value:Awaited<ReturnType<typeof answer>>)=>{Object.assign(runs.get(value.run)!,{status:'completed',output:''});await runtime.result(gs,'continuity',value.event.processed_event_id);};
  const rideTap=await answer('tap','yes','ride');assert.deepEqual(runtime.paymentSource(rideTap.run),{allowed:false,ride_allowed:true});await finishAnswer(rideTap);
  const ordinary=await answer('tap','yes');assert.equal(runtime.paymentSource(ordinary.run).ride_allowed,false);await finishAnswer(ordinary);
  await prepare();const choices=[{id:'shop-a',label:'甲店',lines:['实付 ¥20']},{id:'shop-b',label:'乙店',lines:['实付 ¥18'],recommended:true},{id:'shop-c',label:'丙店',lines:['20分钟送达']}];
  const choice=await runtime.tool('paios_terminal_question',{context,args:{question:'选哪家？',options:choices}}) as {card_id:string};
  assert.deepEqual(out('display_card').at(-1).actions.map((a:any)=>[a.id,a.lines]),[['shop-b',['实付 ¥18']],['shop-a',['实付 ¥20']],['shop-c',['20分钟送达']]]);
  await finishCaller();send({operation:'card_answer',card_id:choice.card_id,kind:'tap',answer:'shop-c'});
  await eventually(()=>out('accepted').some(p=>p.event_id===`answer:${digest([gs.device_id,choice.card_id])}`&&p.admission.run_id));
  const picked=out('accepted').find(p=>p.event_id===`answer:${digest([gs.device_id,choice.card_id])}`&&p.admission.run_id),pickedRun=picked.admission.run_id;
  const pickedEvent=(await runtime.event(gs,'continuity',picked.processed_event_id)).processed_event;
  assert.equal((pickedEvent.content.app_event as {text:string}).text,'就选第3项：丙店');
  assert.deepEqual(runtime.paymentSource(pickedRun),{allowed:false,ride_allowed:false});
  assert.equal(Object.hasOwn(bodies.find(b=>JSON.parse(b.input).processed_event_id===picked.processed_event_id),'memory_write'),false);
  await assert.rejects(runtime.tool('paios_l3_commit',{context:{...context,run_id:pickedRun},args:{}}),/GESTURE_PROTECTED_ACTION_DENIED/);
  Object.assign(runs.get(pickedRun)!,{status:'completed',output:''});await runtime.result(gs,'continuity',picked.processed_event_id);
  const noRide=await answer('shake','no','ride');assert.equal(runtime.paymentSource(noRide.run).ride_allowed,false);await finishAnswer(noRide);
  assert.equal((await wear(false)).owner_verified,false);await runtime.ownerInput(gs);await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'actual-owner',device_id:'glasses',id:'off-head',text:'摘下后给手机'});
  assert.equal((phoneRoom.published as any[]).find(p=>p.text==='摘下后给手机').operation,'ambient_reply');
  assert.deepEqual(notices,['摘下后给手机']);
  await prepare();await runtime.ownerInput(ps);
  const phoneChoice=await runtime.tool('paios_terminal_question',{context,args:{question:'选哪家？',options:choices}}) as {card_id:string};
  const phoneCard=(phoneRoom.published as any[]).filter(p=>p.operation==='gesture_card').at(-1);
  assert.equal(phoneCard.card_id,phoneChoice.card_id);assert.deepEqual(phoneCard.options,choices);
  await finishCaller();const selection='就选第2项：乙店（仅选择，不授权付款、身份或记忆写入）';
  phoneRoom.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'submit',event_id:'phone-shop-choice',captured_at:now,text:selection})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>bodies.some(b=>JSON.parse(b.input).content.text===selection));
  const phoneRun=[...runs.values()].at(-1)!;Object.assign(phoneRun,{status:'completed',output:''});
  await eventually(()=>!admission.find(phoneRun.run_id));
  await wear(true);await hear(oldWear);assert.equal((await wear(true)).owner_verified,false,'late prior-wear owner audio cannot restore trust');
  await runtime.ownerInput(gs);const reset=await answer('shake','no');assert.equal(bodies.find(b=>JSON.parse(b.input).processed_event_id===reset.event.processed_event_id).run_scope,'guest');
  Object.assign(runs.get(reset.run)!,{status:'completed',output:''});await runtime.result(gs,'continuity',reset.event.processed_event_id);
  const journalBefore=journal.search({principal_id:'actual-owner',limit:50}).entries.length;
  await prepare();await runtime.ownerInput(gs);const offer=await runtime.tool('paios_call_offer',{context,args:{text:'聊一下吗？'}}) as {offer_id:string;call_id:string};
  assert.deepEqual(out('display_card').at(-1).actions.map((a:any)=>a.command),['accept','decline'].map(answer=>({operation:'call_offer_answer',offer_id:offer.offer_id,answer})));
  send({operation:'call_offer_answer',offer_id:offer.offer_id,answer:'accept'});await eventually(()=>instructions.length===1);
  assert.equal(call.pending(),offer.call_id);assert.match(instructions[0]!,/正在确认声音/);assert.doesNotMatch(instructions[0]!,/关于主人/);
  await assert.rejects(runtime.tool('paios_call_offer',{context,args:{text:'再聊一下？'}}),/CALL_ALREADY_LIVE/);
  sink!.transcript(offer.call_id,0,'assistant','聊一下',false,'pending');await eventually(()=>out('display_card').some(p=>p.lines.includes('聊一下')));
  assert.equal(out('call_transcript').length,0);assert.equal(out('display_card').filter(p=>p.lines.includes('聊一下')).length,1);
  assert.deepEqual(out('display_card').find(p=>p.lines.includes('聊一下')).caption,{role:'assistant',turn:0});
  assert.equal(journal.search({principal_id:'actual-owner',limit:50}).entries.length,journalBefore);
  await wear(false);assert.equal(call.pending(),undefined);await wear(true);
  await finishCaller();await prepare();const expired=await runtime.tool('paios_call_offer',{context,args:{text:'稍后聊吗？'}}) as {offer_id:string};
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(30001);
  send({operation:'call_offer_answer',offer_id:expired.offer_id,answer:'accept'});await eventually(()=>out('rejected').some(p=>p.error_code==='GLASSES_GESTURE_CARD_EXPIRED'));t.mock.timers.reset();
  assert.equal(instructions.length,1);assert.deepEqual(errors.filter(e=>!/CARD_EXPIRED|TERMINAL_OWNER_VOICE_REQUIRED/.test(String(e))),[]);
  assert.equal(out('gesture_card').length+out('call_offer').length+out('call_transcript').length,0);
  assert.equal(request.processed_event.device_id,'phone');
});


test('payment attach snapshots, control receipts and safe failures use the formal envelope and detach lifecycle',async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],requests:Record<string,unknown>[]=[],lifecycle:string[]=[];
  const phone={principal_id:'actual-owner',device_id:'mac',device_type:'phone',channel:'rtc_typed_text'};
  let deliver:((value:Record<string,unknown>)=>Promise<void>)|undefined,detachError=false;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,terminalChanged:()=>{},ownerInput:async()=>{},watchReminders:async()=>()=>{},
    cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{},watchVoiceConfirmations:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    watchPayments:async(_source:unknown,callback:typeof deliver)=>{deliver=callback;
      for(const operation of ['payment_cards','payment_settings','payment_approvals']){
        const {schema_version,session_id,...projection}=paymentWire.examples[operation]![0]!;await callback!(projection);
      }
      return()=>{lifecycle.push('unwatch');};},paymentDetach:async()=>{lifecycle.push('detach');if(detachError)throw new ContractError('PAYMENT_DETACH_FAILED',503);},
    paymentInput:async(_source:unknown,body:Record<string,unknown>)=>{requests.push(body);
      if(body.control_id==='safe-error')throw new ContractError('PAYMENT_TERMINAL_LOCKED',403);
      if(body.control_id==='missing')throw Object.assign(new ContractError('PAYMENT_PREREQUISITE_MISSING',409),{missing:['VOICEPRINT','private-value','VOICEPRINT',7]});
      if(body.control_id==='unsafe-error')throw new ContractError('secret: invalid exception text',500);
      return undefined;}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e)});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  const out=(op:string)=>(room.published as any[]).filter(value=>value.operation===op);
  assert.deepEqual((room.published as any[]).map(value=>value.operation),['payment_cards','payment_settings','payment_approvals']);
  for(const value of room.published as any[]){assert.equal(value.session_id,'continuity');assert.equal(value.schema_version,'paios.central.text-envelope.v1');}
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'payment_dispute',control_id:'success',payment_id:paymentWire.examples.payment_dispute![0]!.payment_id});
  await eventually(()=>out('payment_receipt').length===1);assert.equal(out('payment_receipt')[0].ok,true);
  const signed=paymentWire.examples.payment_decide!.find(value=>value.signature_b64)!;
  send({...signed,control_id:'invalid',signature_b64:'%%%'});
  send({...signed,control_id:'extra',grant_id:'never-authorized'});
  send({...signed,control_id:'safe-error'});send({...signed,control_id:'unsafe-error'});send({...signed,control_id:'missing'});
  await eventually(()=>out('payment_receipt').length===6);
  assert.deepEqual(out('payment_receipt').map(value=>[value.control_id,value.error_code]).sort(),[
    ['extra','FORMAL_PAYMENT_INPUT_INVALID'],['invalid','FORMAL_PAYMENT_INPUT_INVALID'],['missing','PAYMENT_PREREQUISITE_MISSING'],['safe-error','PAYMENT_TERMINAL_LOCKED'],
    ['success',undefined],['unsafe-error','FORMAL_TEXT_REQUEST_FAILED']]);
  assert.deepEqual(out('payment_receipt').find(value=>value.control_id==='missing').missing,['VOICEPRINT']);
  assert.equal(requests.length,4,'invalid wire bodies never reach payment authority');assert.equal(out('rejected').length,0);
  room.emit(RoomEvent.ParticipantDisconnected,{identity:'terminal'});
  assert.deepEqual(lifecycle,['detach'],'phone presence backgrounds when the peer leaves, before room teardown');
  detachError=true;const before=room.published.length;await bridge.close();await deliver!({operation:'payment_cards',cards:[]});
  assert.equal(room.published.length,before);assert.deepEqual(lifecycle,['detach','detach','unwatch']);
  assert.equal((errors.at(-1) as ContractError).code,'PAYMENT_DETACH_FAILED','async detach errors reach the ingress error owner');
});

test('payment enrolment grant opens existing glasses voiceprint operations and never permits forgetting',async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],windows:string[]=[];let granted=true;
  const glasses={principal_id:'actual-owner',device_id:'glasses',device_type:'glasses',channel:'rtc_typed_text'};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>glasses,terminalChanged:()=>{},watchPayments:async()=>()=>{},paymentDetach:async()=>{},
    paymentEnrolmentAllowed:async()=>granted,formalVoice:async(_s:unknown,_m:unknown,consume:()=>Promise<unknown>)=>consume(),
    voiceprintOwner:async()=>({enrolled:false,reenrollment_required:false,samples:0}),voiceprintForget:async()=>{throw Error('forget must not reach registry');}} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,
    voice_capture:{open:async id=>{windows.push(id);},cancel:()=>true,commit:async()=>{throw Error('unused');}},onError:e=>errors.push(e)});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const out=(op:string)=>(room.published as any[]).filter(value=>value.operation===op);
  send({operation:'voiceprint_open',operation_id:'enrol-1'});await eventually(()=>out('voiceprint_sample').length===1);
  assert.deepEqual(windows,['enrol-1']);send({operation:'voiceprint_read',control_id:'read'});await eventually(()=>out('voiceprint_owner').length===1);
  send({operation:'voiceprint_forget',control_id:'forget'});await eventually(()=>out('rejected').length===1);
  granted=false;send({operation:'voiceprint_open',operation_id:'expired'});await eventually(()=>out('rejected').length===2);
  assert.deepEqual(out('rejected').map(value=>value.error_code),['VOICEPRINT_DEVICE_REQUIRED','VOICEPRINT_DEVICE_REQUIRED']);
  assert.deepEqual(windows,['enrol-1']);
});


test('payment auth failure forwards the captured device and original error before observer detach',async t=>{
  for(const code of ['PAIRED_DEVICE_REVOKED','FORMAL_SESSION_EXPIRED']){
    const f=fixture(),room=testRoom(),errors:unknown[]=[],lifecycle:string[]=[];
    const device={principal_id:'actual-owner',device_id:'phone',device_type:'phone',channel:'rtc_typed_text'};
    let failure:ContractError|undefined;
    const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(failure)throw failure;return device;},terminalChanged:()=>{},
      watchReminders:async()=>()=>{lifecycle.push('reminders-detached');},cameraReady:async()=>{},movementReady:async()=>{},watchCare:async()=>()=>{lifecycle.push('care-detached');},
      watchVoiceConfirmations:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
      watchPayments:async()=>()=>{lifecycle.push('payments-detached');},paymentDetach:async()=>{lifecycle.push('payment-detach');},
      paymentSourceRejected:(source:unknown,error:unknown)=>{assert.equal(source,device);assert.equal(error,failure);lifecycle.push('source-rejected');},
      paymentInput:async()=>{throw Error('rejected authentication must never reach payment input');}} as unknown as PersonalAIOSRuntime;
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{lifecycle.push('transport-disconnect');}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
    t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
    failure=new ContractError(code,403);
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'payment_dispute',control_id:'denied',payment_id:paymentWire.examples.payment_dispute![0]!.payment_id})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await eventually(()=>errors.includes(failure));await bridge.close();
    assert.equal(lifecycle[0],'source-rejected');
    for(const step of ['payment-detach','payments-detached','reminders-detached','care-detached','transport-disconnect'])assert.ok(lifecycle.includes(step),step);
    assert.equal(errors[0],failure,'auth failure stays observable as the original error');
    assert.equal((room.published as any[]).some(value=>value.operation==='payment_receipt'),false,'rejected authentication cannot publish a receipt');
    assert.equal([...room.callbacks.values()].reduce((n,callbacks)=>n+callbacks.size,0),0);
  }
});

test('formal file submissions preserve byte-identical client contract and reject malformed shapes',async()=>{
  const server=new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url);
  const client=new URL('../../../../apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/formal-message.v1.json',import.meta.url);
  const glasses=new URL('../../../../glasses-android/app/src/test/resources/formal-message.v1.json',import.meta.url);
  assert.deepEqual(await fs.readFile(server),await fs.readFile(client));assert.deepEqual(await fs.readFile(server),await fs.readFile(glasses));
  const wire=JSON.parse(await fs.readFile(server,'utf8')),{Ajv}=await import('ajv');
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const accepts=ajv.compile({$defs:wire.$defs,...wire.inputs.submit.definition});
  const file={grant_id:'grant',path:'/Users/owner/a.pdf',name:'a.pdf',size:0,kind:'pdf'};
  const body={operation:'submit',event_id:'files',captured_at:now,text:'',attachments:[file]};
  assert.ok(accepts(body));assert.ok(accepts({...body,text:'请处理',attachments:Array.from({length:10},()=>file)}));
  for(const attachments of [[],Array.from({length:11},()=>file),[{...file,grant_id:'bad id'}],[{...file,path:'relative'}],
    [{...file,path:'/nul\u0000'}],[{...file,path:'/'+ 'a'.repeat(1024)}],[{...file,name:'a'.repeat(256)}],
    [{...file,size:-1}],[{...file,size:0.5}],[{...file,kind:'folder'}],[{...file,extra:true}]])assert.equal(accepts({...body,attachments}),false);
  assert.equal(accepts({...body,attachments:undefined}),false);
});

for(const detached of [false,true])for(const missing of [false,true])test(`a normal owner reply waiting for audio provenance persists only its original manual mirror row${detached?' after ingress detach':''}, missing=${missing}`,async t=>{
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources});
  const root=await fs.mkdtemp(join(tmpdir(),'call-mirror-origin-')),storage=new PosixStorage(root);
  const native:NativeClient={create:async body=>({run_id:'mirror-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'}),
    status:async()=>({run_id:'mirror-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'}),cancel:async()=>({run_id:'mirror-run',session_id:'continuity',conversation_session_id:'continuity',status:'cancelled'}),reminders:async()=>[]};
  t.mock.method(sourceClient(native),'mirrorCallTurn',async(_d:ProcessedEvent,session:string)=>session);
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),
    admission:new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'mirror-origin'})});
  const closures:Parameters<PersonalAIOSRuntime['closeCall']>[2][]=[],capture=runtime.captureCall.bind(runtime);
  t.mock.method(runtime,'captureCall',async(...args:Parameters<PersonalAIOSRuntime['captureCall']>)=>{
    const call=await capture(...args);return {...call,close:async(closed:Omit<Parameters<PersonalAIOSRuntime['closeCall']>[2],'call_id'>)=>{closures.push({...closed,call_id:args[2]});return call.close(closed);}};
  });
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const room=testRoom(),errors:unknown[]=[];let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined,detachedSinks=0;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{open:async()=>{},close:async()=>true,
      respond:async()=>false,attach:value=>{sink=value;return()=>{detachedSinks++;};}}});t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);await sink!.state('call','opening',{mode:'manual'});await sink!.state('call','live',{mode:'manual'});
  const audio=Promise.withResolvers<void>();
  sink!.transcript('call',0,'assistant','已记下',false,'owner',true);
  const turn={call_id:'call',turn:0,user:'帮我记下这件事',assistant:'已记下',interrupted:false,speaker:'owner',route:'front_only' as const};
  const mirror=missing?sink!.turn(turn,audio.promise.then(()=>({status:'rejected' as const,reason:new Error('CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE')}))):audio.promise.then(()=>sink!.turn(turn));
  await new Promise(r=>setImmediate(r));assert.deepEqual(runtime.timeline!.page('actual-owner').items,[]);
  let detachedClose:Promise<void>|undefined;
  if(detached){await eventually(()=>room.published.some((p:any)=>p.operation==='call_transcript'));detachedClose=bridge.close();assert.equal(detachedSinks,0,'original call observation sink survives presentation detach');
    await sink!.state('new-call','opening',{mode:'manual'});await sink!.turn({call_id:'new-call',turn:0,user:'must ignore',assistant:'',interrupted:false});}
  const publications=room.published.length;
  audio.resolve();await mirror;await detachedClose;
  const stored=await Promise.all((await storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-events',key)).toString())));
  assert.deepEqual(stored[0].content.audio_observations[0].audio_gap,missing?{reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'}:undefined);
  assert.deepEqual(runtime.timeline!.page('actual-owner').items.map(item=>item.text),['帮我记下这件事','已记下']);
  if(detached)await sink!.turn({call_id:'call',turn:1,user:'访客最后半句话',assistant:'不能当作主人的答复',interrupted:true,speaker:'unknown',route:'front_only'});
  await sink!.sealed!('call','button',detached?1:0);
  await sink!.sealed!('call','button',detached?1:0);assert.equal(closures.length,1);
  assert.equal(closures[0]!.processed_event_ids.length,detached?2:1);assert.equal('user' in closures[0]!,false,'close observation carries original D references, never replayed task text');
  if(detached){assert.ok(runtime.timeline!.observations('actual-owner').some(item=>item.text==='未确认说话人：访客最后半句话'));
    const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input)),stored=await runtime.event(source,'continuity',closures[0]!.processed_event_ids[1]!);
    await runtime.timeline!.input(stored.processed_event,'continuity');
    await runtime.timeline!.input({...stored.processed_event,event_id:'unsourced-call',processed_event_id:'d:unsourced-call',
      content:{...stored.processed_event.content,audio_observations:[]}},'continuity');}
  assert.deepEqual(runtime.timeline!.page('actual-owner').items.map(item=>item.text),['帮我记下这件事','已记下']);
  assert.equal(runtime.timeline!.observations('actual-owner').length,detached?1:0);
  if(detached){assert.equal(detachedSinks,1,'last original seal releases the retained sink');assert.equal(room.published.length,publications,'detached observations never publish to the old client');}
  assert.deepEqual(errors,[]);
});

for(const pressure of ['missing','invalid','overload'] as const)test(`PCM ${pressure} pressure bounds retained tasks and preserves the close barrier`,async()=>{
  const room=testRoom(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),errors:unknown[]=[],order:string[]=[];
  const source={principal_id:`pcm-pressure-${pressure}`,device_id:'phone',device_type:'phone',capabilities:[]};
  let held=false,current:string|undefined='wake',sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},
    authenticate:async()=>{if(held){entered.resolve();await gate.promise;}return source;},terminalChanged:()=>{},
    watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},
    formalVoice:async(_s:unknown,_m:unknown,consume:()=>Promise<unknown>)=>consume(),closeCall:async()=>{}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:{credentialForBootstrap:()=>({})} as never,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{open:async()=>{},close:async()=>{if(!current)return false;current=undefined;order.push('close');return true;},pending:()=>current,
      respond:async()=>false,pcm:async(_id,frame)=>{order.push(`pcm:${frame.seq}`);},attach:value=>{sink=value;return()=>{};}}});
  const frame=(seq:number)=>({schema_version:FORMAL_TEXT_ENVELOPE_SCHEMA,operation:'call_pcm',session_id:'continuity',call_id:'wake',
    seq,captured_at_ms:1000+seq*100,sample_rate:16000,pcm_s16le_base64:Buffer.alloc(3200).toString('base64')});
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const allocation=new AsyncLocalStorage<{promises:number}>(),hook=createHook({init:(_id,type)=>{const counter=allocation.getStore();if(type==='PROMISE'&&counter)counter.promises++;}});
  try{
    await bridge.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'continuity'}} as unknown as RealtimeBootstrapConnectedInput);
    await sink!.state('wake','opening',{mode:'manual'});held=true;send(frame(0));await entered.promise;
    for(let seq=1;seq<=256;seq++)send(pressure==='missing'?{operation:'call_pcm'}:pressure==='invalid'?{...frame(seq),pcm_s16le_base64:'?'}:frame(seq));
    const tail={promises:0};hook.enable();
    allocation.run(tail,()=>{for(let seq=257;seq<1280;seq++)send(pressure==='missing'?{operation:'call_pcm'}:pressure==='invalid'?{...frame(seq),pcm_s16le_base64:'?'}:frame(seq));});
    hook.disable();
    assert.equal(tail.promises,0,'continued overload cannot allocate retained Promise work');
    send({operation:'call_close',call_id:'wake'});gate.resolve();await eventually(()=>current===undefined);await bridge.close();
    assert.equal(order.at(-1),'close');assert.equal(order.filter(value=>value==='close').length,1);
    assert.deepEqual(order.filter(value=>value.startsWith('pcm:')),pressure==='overload'?Array.from({length:50},(_,seq)=>`pcm:${seq}`):['pcm:0']);
    if(pressure==='overload')assert.equal(room.published.filter((packet:any)=>packet.operation==='rejected'&&packet.error_code==='VOICE_CALL_PCM_CAPACITY').length,1);
  }finally{hook.disable();gate.resolve();await bridge.close();}
});

test('reliable wake PCM authenticates in receive order, bounds five seconds, and closes after queued frames',async()=>{
  const room=testRoom(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),errors:unknown[]=[],order:string[]=[],frames:unknown[]=[],failures:string[]=[];
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc_typed_text',capabilities:['microphone','speaker','owner_unlock']};
  let held=false,auths=0,current:string|undefined='wake',sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>{if(held){auths++;entered.resolve();await gate.promise;}return source;},terminalChanged:()=>{},
    watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},formalVoice:async(_s:unknown,_m:unknown,consume:()=>Promise<unknown>)=>consume(),closeCall:async()=>{}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:{credentialForBootstrap:()=>({})} as never,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{open:async()=>{},close:async(id,_reason,code)=>{if(current!==id)return false;if(code)failures.push(code);order.push('close');current=undefined;return true;},pending:()=>current,respond:async()=>false,
      pcm:async(_id,frame)=>{frames.push(frame);order.push(`pcm:${frame.seq}`);},attach:value=>{sink=value;return()=>{};}}});
  const input={enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'continuity'}} as unknown as RealtimeBootstrapConnectedInput;
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const frame=(seq:number,call_id='wake')=>({schema_version:FORMAL_TEXT_ENVELOPE_SCHEMA,operation:'call_pcm',session_id:'continuity',call_id,
    seq,captured_at_ms:1000+seq*100,sample_rate:16000,pcm_s16le_base64:Buffer.alloc(3200).toString('base64')});
  try{
    await bridge.onBootstrapConnected(input);await sink!.state('wake','opening',{mode:'manual'});held=true;
    send(frame(0));send(frame(1));await entered.promise;await new Promise(setImmediate);
    assert.equal(auths,1,'parallel reliable callbacks cannot start later frame authorization');assert.deepEqual(order,[]);
    for(let seq=2;seq<51;seq++)send(frame(seq));send({operation:'call_close',call_id:'wake'});
    gate.resolve();await eventually(()=>order.at(-1)==='close'&&errors.some(e=>String(e).includes('VOICE_CALL_PCM_CAPACITY')));
    assert.deepEqual(order,[...Array.from({length:50},(_,n)=>`pcm:${n}`),'close']);
    assert.deepEqual(failures,['VOICE_CALL_PCM_CAPACITY'],'receive pressure retires the exact call through its failure state');
    const {schema_version:_schema,operation:_operation,session_id:_session,call_id:_id,...first}=frame(0);
    assert.deepEqual(frames[0],first,'the earliest captured frame reaches the one PCM callback unchanged');
    send(frame(51));await eventually(()=>errors.some(e=>String(e).includes('VOICE_CALL_NOT_ACTIVE')));
    assert.equal(order.length,51,'a closed call cannot accept another frame');
    await sink!.sealed!('wake','button',-1);
  }finally{gate.resolve();await bridge.close();}
});

for(const explicit of [true,false])for(const missing of [false,true])for(const observer of ['ready','blocked','failed'])test(`handoff admission precedes unresolved turn audio and archives once: explicit=${explicit}, missing=${missing}, observer=${observer}`,async t=>{
  const room=testRoom(),audio=Promise.withResolvers<PromiseSettledResult<NonNullable<import('../src/voice-call-session.ts').CallTurn['audio']>>>(),observing=Promise.withResolvers<void>();
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:[]},order:string[]=[],payloads:any[]=[],errors:unknown[]=[];
  let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  let clock=100000;const metrics:any[]=[],write=process.stderr.write.bind(process.stderr);
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(process.stderr,'write',(chunk:string)=>{if(chunk.startsWith('{"voice_call_stage"'))metrics.push(JSON.parse(chunk));return write(chunk);});
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},movementReady:async()=>{},authenticate:async()=>{clock+=11;return source;},locate:async()=>{clock+=13;return undefined;},terminalChanged:()=>{},
    watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},
    submitCallTurn:async(raw:any)=>{clock+=17;const turn=JSON.parse(raw.payload.toString());payloads.push({...turn,event_id:raw.event_id});order.push(turn.phase);
      return {processed_event:{processed_event_id:`d:${turn.phase}`},admission:turn.phase==='complete'?null:{run_id:'run'}};},
    subscribeResult:async(_s:unknown,_session:unknown,_id:unknown,_next:unknown,_error:unknown,options:any)=>{
      clock+=19;order.push('run_id');await options.on_admission({admission:{run_id:'run'}});
      if(observer==='blocked')await observing.promise;if(observer==='failed')throw new Error('OBSERVER_SETUP_FAILED');return()=>{};},
    watchCallProgress:async()=>{},closeCall:async()=>{}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:{credentialForBootstrap:()=>({})} as never,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{open:async()=>{},close:async()=>true,respond:async()=>false,attach:value=>{sink=value;return()=>{};}}});
  try{
    await bridge.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'continuity'}} as unknown as RealtimeBootstrapConnectedInput);
    await sink!.state('call','opening',{mode:'manual'});
    const turn={call_id:'call',turn:0,user:'我有几条提醒',assistant:'',interrupted:false,speaker:'owner',route:'handoff' as const,
      handoff:{difficulty:'读取记录',intent:'我有几条提醒',thinking:'disabled' as const}};
    let completed:Promise<void>;
    if(explicit){const pending=sink!.turn({...turn,phase:'handoff'});completed=Promise.resolve(sink!.turn({...turn,assistant:'等一下。',phase:'complete'},audio.promise));await pending;}
    else completed=Promise.resolve(sink!.turn(turn,audio.promise));
    await eventually(()=>order.includes('run_id'));assert.deepEqual(order,['handoff','run_id']);
    const recorded=metrics.find(row=>row.voice_call_stage==='turn_recorded'),observed=metrics.find(row=>row.voice_call_stage==='handoff_observed');
    assert.deepEqual([recorded.authenticate_ms,recorded.placed_ms,recorded.submit_ms,observed.observer_ms],[0,13,17,49]);
    order.push('audio_resolved');const archived={raw_ref:'l5:audio',archive_revision:'revision',start_ms:1000,end_ms:2000};
    audio.resolve(missing?{status:'rejected',reason:new Error('CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE')}:{status:'fulfilled',value:archived});await completed;
    assert.deepEqual(order,['handoff','run_id','audio_resolved','complete']);
    assert.equal(payloads.length,2);assert.equal(payloads[0].audio,undefined);assert.deepEqual(payloads[1].audio,missing?undefined:archived);
    assert.deepEqual(payloads[1].audio_gap,missing?{reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'}:undefined);
    assert.equal(metrics.filter(row=>row.voice_call_stage==='turn_audio_unavailable').length,missing?1:0);
    assert.equal(payloads[1].handoff_event_id,payloads[0].event_id);
    if(observer==='failed')await eventually(()=>errors.length===1);
    assert.deepEqual(errors.map(String),observer==='failed'?['Error: OBSERVER_SETUP_FAILED']:[]);
    await sink!.sealed!('call','button',0);
  }finally{observing.resolve();audio.resolve({status:'rejected',reason:new Error('cleanup')});await bridge.close();}
});

test('a failed mirror rejects the retained source seal and still releases its detached observation sink',async()=>{
  const room=testRoom(),failed=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),closures:unknown[]=[];
  let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined,detached=0;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>({principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:[]}),locate:async()=>undefined,
    terminalChanged:()=>{},watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},submitCallTurn:async()=>{entered.resolve();await failed.promise;},
    closeCall:async(_d:unknown,_s:unknown,closed:unknown)=>{closures.push(closed);}} as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:{credentialForBootstrap:()=>({})} as never,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:()=>{},
    voice_call:{open:async()=>{},close:async()=>true,respond:async()=>false,attach:value=>{sink=value;return()=>{detached++;};}}});
  try{
    await bridge.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'continuity'}} as unknown as RealtimeBootstrapConnectedInput);
    await sink!.state('call','opening',{mode:'manual'});
    const mirror=Promise.resolve(sink!.turn({call_id:'call',turn:0,user:'保留这句话',assistant:'',interrupted:true,speaker:'owner',route:'handoff'}));
    const rejected=assert.rejects(mirror,/MIRROR_WRITE_FAILED/);await entered.promise;
    const sealing=Promise.resolve(sink!.sealed!('call','button',0)),sealRejected=assert.rejects(sealing,/MIRROR_WRITE_FAILED/);
    const closing=bridge.close();assert.equal(detached,0);failed.reject(new Error('MIRROR_WRITE_FAILED'));
    await Promise.all([rejected,sealRejected,closing]);assert.equal(detached,1);assert.equal(closures.length,1);
    await sink!.sealed!('call','button',0);assert.equal(closures.length,1,'repeated seal cannot process context twice');
  }finally{failed.resolve();await bridge.close();}
});

test('same-continuity rejoin transfers future turns once while pending audio retains its opening provenance',async()=>{
  for(const sameContinuity of [true,false]){
    const room=testRoom(),old={principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:[]},fresh={...old};
    const audio=Promise.withResolvers<PromiseSettledResult<NonNullable<import('../src/voice-call-session.ts').CallTurn['audio']>>>();
    let retired=false,submitted=0,closed=0,pcm=0,sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
    const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async(credential:{epoch:number})=>{if(credential.epoch===0&&retired)throw new Error('SOURCE_BINDING_INACTIVE');return credential.epoch===0?old:fresh;},
      terminalChanged:()=>{},locate:async()=>undefined,watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},
      submitCallTurn:async(_raw:unknown,source:unknown)=>{assert.equal(source,old);submitted++;return {processed_event:{processed_event_id:'new-D'},admission:null};},
      closeCall:async(source:unknown)=>{assert.equal(source,old);closed++;}} as unknown as PersonalAIOSRuntime);
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      authority:{credentialForBootstrap:(input:RealtimeBootstrapConnectedInput)=>({epoch:Number(input.currentBinding.connectionEpoch)})} as never,
      runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:()=>{},voice_call:{pending:()=> 'call',open:async()=>{},close:async()=>true,respond:async()=>false,pcm:async()=>{pcm++;},attach:value=>{sink=value;return()=>{};}}});
    const input=(epoch:number,continuityId:string)=>({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId,connectionEpoch:String(epoch)}} as unknown as RealtimeBootstrapConnectedInput);
    const turn=(n:number)=>({call_id:'call',turn:n,user:'源录音',assistant:'',interrupted:true,speaker:'owner' as const,route:'front_only' as const});
    try{
      await bridge.onBootstrapConnected(input(0,'continuity'));const original=sink!;await original.state('call','opening',{mode:'manual'});
      const pending=Promise.resolve(original.turn(turn(0),audio.promise));retired=true;
      await bridge.onBootstrapConnected(input(1,sameContinuity?'continuity':'other-continuity'));const resumed=sink!;
      if(sameContinuity){room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({schema_version:FORMAL_TEXT_ENVELOPE_SCHEMA,
        operation:'call_pcm',session_id:'continuity',call_id:'call',seq:0,captured_at_ms:1000,sample_rate:16000,pcm_s16le_base64:Buffer.alloc(3200).toString('base64')})),
        {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>pcm===1);}
      await resumed.state('call','live',{mode:'manual'});
      if(sameContinuity){await Promise.all([original.turn(turn(1)),resumed.turn(turn(1))]);assert.equal(submitted,1,'only the authenticated new sink owns future turns');}
      else {await resumed.turn(turn(1));assert.equal(submitted,0,'another continuity cannot take the call');}
      const seal=Promise.resolve(original.sealed!('call','button',1));
      const resumedSeal=Promise.resolve(resumed.sealed!('call','button',1));
      audio.resolve({status:'fulfilled',value:{raw_ref:'raw',archive_revision:'revision',start_ms:1,end_ms:2}});
      await Promise.all([pending,seal,resumedSeal]);assert.equal(closed,1);
      assert.equal(submitted,sameContinuity?2:1,'old audio remains attributed to its opening call even across another continuity');
      await original.sealed!('call','button',1);await resumed.sealed!('call','button',1);assert.equal(closed,1);
    }finally{audio.resolve({status:'rejected',reason:new Error('SOURCE_BINDING_INACTIVE')});await bridge.close();}
  }
});

test('authenticated current-call PCM failure emits failed once and closes; foreign and unauthorized packets cannot close it',async()=>{
  const room=testRoom(),errors:unknown[]=[],states:string[]=[],seals:string[]=[];let authorized=true,closed=0,appended=0,sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>{if(!authorized)throw new Error('AUTH_DENIED');return {principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:[]};},
    terminalChanged:()=>{},watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},
    closeCall:async(_source:unknown,_session:string,meta:{reason:string})=>{seals.push(meta.reason);}} as unknown as PersonalAIOSRuntime);
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{closed++;}}),
    onState:async(id,state,extra)=>{states.push(state);await sink?.state(id,state,extra);},onTranscript:()=>{},onTurn:()=>{},
    onSealed:async(id,reason,turn)=>{await sink?.sealed?.(id,reason,turn);},onError:error=>errors.push(error)});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:{credentialForBootstrap:()=>({})} as never,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{...call,pcm:async()=>{appended++;throw new ContractError('WAKE_PCM_SEQUENCE_INVALID',409);},attach:value=>{sink=value;return()=>{};}}});
  const input={enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'continuity'}} as unknown as RealtimeBootstrapConnectedInput;
  const frame={schema_version:FORMAL_TEXT_ENVELOPE_SCHEMA,operation:'call_pcm',session_id:'continuity',call_id:'wake',seq:7,captured_at_ms:1000,sample_rate:16000,pcm_s16le_base64:'AAA='};
  const send=(body:object,identity='terminal')=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  try{
    await bridge.onBootstrapConnected(input);await call.open('wake',{wake_word:true});
    send({...frame,call_id:'foreign'});await eventually(()=>errors.some(e=>String(e).includes('VOICE_CALL_NOT_ACTIVE')));
    send({...frame,session_id:'foreign'});await eventually(()=>errors.some(e=>String(e).includes('CALL_PCM_SESSION_MISMATCH')));
    send(frame,'intruder');await new Promise(setImmediate);assert.equal(call.active(),'wake');assert.equal(closed,0);
    send(frame);send({...frame,seq:8});await eventually(()=>call.pending()===undefined);await call.closeAll();
    assert.equal(appended,1);assert.equal(closed,1);assert.deepEqual(states,['opening','live','failed','closing','closed']);
    const failures=room.published.filter((p:any)=>p.operation==='call_state'&&p.state==='failed') as {error_code:string;reason:string}[];
    assert.equal(failures.length,1);assert.equal(failures[0]!.error_code,'WAKE_PCM_SEQUENCE_INVALID');assert.equal(failures[0]!.reason,'error');
    assert.deepEqual(seals,['false_wake'],'an unconfirmed failed wake records metadata only');
    assert.ok(room.published.some((p:any)=>p.operation==='call_state'&&p.state==='closed'&&p.reason==='error'));
    assert.deepEqual(room.published.filter((p:any)=>p.operation==='call_state'&&['failed','closing','closed'].includes(p.state)).map((p:any)=>p.state),['failed','closing','closed']);
    assert.ok(room.published.some((p:any)=>p.operation==='rejected'&&p.request_operation==='call_pcm'&&p.error_code==='WAKE_PCM_SEQUENCE_INVALID'));
    await call.open('unrelated');authorized=false;send({...frame,call_id:'unrelated'});
    await eventually(()=>errors.some(e=>String(e).includes('AUTH_DENIED')));await new Promise(setImmediate);
    assert.equal(call.active(),'unrelated');assert.equal(closed,1,'failed authentication cannot retire another live call');
  }finally{authorized=true;await call.closeAll();await bridge.close();}
});

for(const [rejoinFirst,notifier,terminal] of [[true,'working','phone'],[false,'working','phone'],[true,'missing','glasses'],[true,'empty','glasses'],[true,'failed','glasses']] as const)
test(`a sealed call delivers its pending result ${rejoinFirst?'after authenticated rejoin':'offline before rejoin'} while old capture stays revoked: ${terminal}/${notifier}`,async t=>{
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:terminal,watch:'watch',client:'watch-client'},['text'],{type:terminal,registry:sources});
  const root=await fs.mkdtemp(join(tmpdir(),'call-result-rejoin-')),storage=new PosixStorage(root),errors:unknown[]=[],notifications:string[]=[];
  await fs.writeFile(join(root,'bark-device'),'');
  let pushAttempts=0;
  const bark=createBarkNotifier(join(root,'bark-device'),join(root,'unused-key'),async()=>{throw Error('must not push');});
  const notify=async(notice:{title:string;body:string})=>{
    pushAttempts++;
    if(notifier==='empty')return bark(notice);
    if(notifier==='failed')throw new TypeError('Invalid URL');
    notifications.push(notice.body);
  };
  const run:NativeRun={run_id:'late-call-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'旧通话任务完成'};
  const contextRun:NativeRun={...run,run_id:'call-close-context',output:''};let creates=0;
  const native:NativeClient={create:async()=>({...(creates++?contextRun:run)}),status:async id=>({...(id===run.run_id?run:contextRun)}),cancel:async id=>({...(id===run.run_id?run:contextRun),status:'cancelled'})};
  t.mock.method(sourceClient(native),'progress',async()=>{});
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'late-call-result'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,16384),native,sourceAuthority:sources,skill:'fixed',max_read_bytes:16384,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),...(notifier==='missing'?{}:{notify}),
    automatic_output:{onError:error=>errors.push(error)},admission});
  let dId='';observeCallTurns(t,runtime,accepted=>{if(accepted.admission)dId=accepted.processed_event.processed_event_id;});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const room=testRoom();let sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{open:async()=>{},close:async()=>true,
      pending:()=>undefined,respond:async()=>false,attach:value=>{sink=value;return()=>{};}}});
  t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);const original=sink!;await original.state('call','opening',{mode:'manual'});await original.state('call','live',{mode:'manual'});
  const credential=f.authority.credentialForBootstrap(f.input),oldSource=await runtime.authenticate(credential);
  await original.turn({call_id:'call',turn:0,user:'帮我处理这件事',assistant:'',interrupted:false,speaker:'owner',route:'handoff',handoff:{difficulty:'需要调用工具',intent:'处理这件事',thinking:'enabled'}});
  assert.ok(dId);await eventually(()=>Boolean(admission.get('actual-owner','continuity',dId)?.run_id));
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text'}});
  await original.state('call','closed',{reason:'button'});await original.sealed!('call','button',0);
  const current=f.current as unknown as {session:{connectionEpoch:string;binding:{connectionEpoch:string}}};current.session.connectionEpoch='2';current.session.binding.connectionEpoch='2';
  const fresh={...f.input,currentBinding:{...f.input.currentBinding,connectionEpoch:'2'}};
  if(rejoinFirst)await bridge.onBootstrapConnected(fresh);
  if(terminal==='glasses'){
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'wear_state',control_id:'call-result-worn',worn:true})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await eventually(()=>(room.published as any[]).some(p=>p.operation==='wear_state_ack'));
  }
  await assert.rejects(f.authority.revalidate(oldSource),/SOURCE_OWNER_BINDING_DENIED/);
  await assert.rejects(f.authority.capture(credential),/SOURCE_OWNER_BINDING_DENIED/);
  run.status='completed';
  const replies=()=>(room.published as any[]).filter(p=>terminal==='glasses'?p.operation==='display_card'&&p.lines?.includes(run.output):p.operation==='ambient_reply'&&p.processed_event_id===dId);
  await eventually(()=>rejoinFirst?replies().length===1:notifications.length===1);
  await eventually(()=>admission.find(run.run_id,'continuity')===undefined);
  assert.deepEqual(notifications,rejoinFirst?[]:[run.output]);
  assert.equal(pushAttempts,rejoinFirst?0:1);
  assert.equal(runtime.timeline!.page('actual-owner').items.filter(item=>item.text===run.output).length,1);
  await eventually(()=>errors.some(error=>String(error).includes('SOURCE_OWNER_BINDING_DENIED')));
  if(!rejoinFirst)await bridge.onBootstrapConnected(fresh);
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(fresh));
  await runtime.persistCallResult(source,'continuity',dId);await runtime.persistCallResult(source,'continuity',dId);
  assert.equal(replies().length,rejoinFirst?1:0,'replay never republishes accepted text');
  assert.equal(pushAttempts,rejoinFirst?0:1,'replay never retries a completed delivery');
  const rows=await Promise.all((await storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await storage.read('output-journal',key)).toString())));
  assert.deepEqual(rows.filter(row=>row.callDelivery).map(row=>row.callDelivery.via),[rejoinFirst?'text':'text_notification']);
  assert.ok(errors.every(error=>String(error).includes('SOURCE_OWNER_BINDING_DENIED')));
});

for(const delayed of [false,true])test(`ordinary enrollment exit needs no grant and stays after its request: delayed=${delayed}`,async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],order:string[]=[];
  const source={principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'rtc_typed_text',capabilities:GLASSES_CAPABILITIES};
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let pending=false;
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>source,cameraReady:async()=>{},movementReady:async()=>{},
    watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},watchAmbientTurns:async()=>()=>{},watchCare:async()=>()=>{},paymentDetach:async()=>{},terminalChanged:()=>{},
    paymentInputBinding:()=>({}),formalVoice:async(_s:unknown,_m:unknown,consume:()=>Promise<unknown>)=>consume(),
    paymentInput:async()=>{entered.resolve();if(delayed)await release.promise;pending=true;order.push('request');},
    voiceEnrollmentControl:async(_s:unknown,action:string)=>{
      if(action==='status')throw new ContractError('VOICEPRINT_DEVICE_REQUIRED',403);
      assert.equal(action,'discard');pending=false;order.push('discard');
      return {available:true,session_id:null,call_id:null,phase:'idle',recorded_ms:0,clean_speech_ms:0,target_speech_ms:30000,
        issue:null,can_use:false,source_device:null,updated_at:null,owner:{enrolled:false,reenrollment_required:false,samples:0}};
    }} as unknown as PersonalAIOSRuntime;
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:f.authority,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'voiceprint_enrol_request',control_id:'request',purpose:'conversation'});await entered.promise;
  if(!delayed)await eventually(()=>pending);
  send({operation:'voice_enrollment_control',control_id:'exit',action:'discard'});
  await new Promise(setImmediate);release.resolve();
  await eventually(()=>room.published.some((p:any)=>p.control_id==='exit'));
  assert.deepEqual(errors,[]);assert.deepEqual(order,['request','discard']);assert.equal(pending,false);
  assert.ok(room.published.some((p:any)=>p.operation==='voice_enrollment_state'&&p.control_id==='exit'));
});

test('conversation enrollment uses archived call turns and check drains the final turn before assessment',{timeout:5000},async t=>{
  const f=fixture(),room=testRoom(),errors:unknown[]=[],order:string[]=[],received:unknown[]=[];
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc_typed_text',capabilities:['microphone','speaker','owner_unlock']};
  const owner={enrolled:false,reenrollment_required:false,samples:0};
  let state={available:true,session_id:'ven-draft',call_id:'call-one',phase:'collecting',recorded_ms:0,clean_speech_ms:0,target_speech_ms:30000,
    issue:null,can_use:false,source_device:{device_id:'phone',device_type:'phone'},updated_at:now,owner};
  let sink:import('../src/personal-aios-formal-text.ts').CallSink,current:string|undefined,tail:Promise<void>|undefined;
  const runtime=callRuntime({watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},authenticate:async()=>source,terminalChanged:()=>{},watchPayments:async()=>()=>{},watchReminders:async()=>()=>{},
    paymentDetach:async()=>{},watchAmbientTurns:async()=>()=>{},locate:async()=>undefined,ownerInput:async()=>{},
    formalVoice:async(_s:unknown,_m:unknown,consume:()=>Promise<unknown>)=>consume(),closeCall:async()=>{order.push('sealed');},
    voiceEnrollmentCall:async(_s:unknown,id:string,call:string)=>{if(id!=='ven-draft'||call!==state.call_id)throw new ContractError('VOICE_ENROLLMENT_SESSION_NOT_FOUND',404);return '录入模式：每次问一个生活问题，顺着回答追问。';},
    voiceEnrollmentControl:async(_s:unknown,action:string,_id?:string,call?:string)=>{
      order.push(action);if(action==='start'||action==='resume')state={...state,phase:'collecting',call_id:call!,can_use:false,clean_speech_ms:action==='start'?0:state.clean_speech_ms};
      if(action==='pause'&&state.phase==='collecting')state={...state,phase:'paused'};
      if(action==='pause'&&state.phase==='discarded')throw new ContractError('VOICEPRINT_DEVICE_REQUIRED',403);
      if(action==='discard')state={...state,phase:'discarded',can_use:false,clean_speech_ms:0};
      if(action==='check')state={...state,phase:'checked',can_use:true};return state;
    },
    voiceEnrollmentTurn:async(_s:unknown,id:string,call:string,turn:number,audio:unknown)=>{
      received.push({id,call,turn,audio});order.push('collect');state={...state,clean_speech_ms:state.clean_speech_ms+16000,
        phase:call==='call-one'?'checked':'collecting',can_use:call==='call-one'};return state;
    },submitCallTurn:async()=>{throw Error('enrollment must not admit executable call turns');},
  } as unknown as PersonalAIOSRuntime);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    authority:f.authority,runtime,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e),
    voice_call:{pending:()=>current,respond:async()=>false,attach:value=>{sink=value;return()=>{};},
      open:async(call,extra)=>{current=call;assert.match(extra!.enrollment_instructions!,/每次问一个生活问题/);await sink.state(call,'opening',{mode:'manual'});},
      close:async(call)=>{if(current!==call)return false;current=undefined;
        await tail;await sink.sealed?.(call,'button',0);return true;}}});
  t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
  const send=(body:object)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const out=()=>room.published.filter((p:any)=>p.operation==='voice_enrollment_state') as any[];
  send({operation:'voice_enrollment_control',control_id:'start',action:'start',call_id:'call-one'});await eventually(()=>out().length===1);
  send({operation:'call_open',call_id:'call-one',enrollment_session_id:'ven-old'});await eventually(()=>errors.length===1);
  assert.match(String(errors.pop()),/VOICE_ENROLLMENT_SESSION_NOT_FOUND/);assert.equal(current,undefined,'a stale enrollment session cannot open a call');
  send({operation:'call_open',call_id:'call-one',enrollment_session_id:'ven-draft'});await eventually(()=>current==='call-one');
  const audio={raw_ref:'raw:call',archive_revision:'revision',start_ms:1000,end_ms:17000};
  tail=Promise.resolve(sink!.turn({call_id:'call-one',turn:0,user:'今天走了一条新的路',assistant:'路上有什么新发现？',interrupted:false,speaker:'unknown'},Promise.resolve({status:'fulfilled',value:audio})));await tail;
  await eventually(()=>order.includes('sealed'));assert.equal(current,undefined,'target completion closes the existing call');
  assert.deepEqual(received,[{id:'ven-draft',call:'call-one',turn:0,audio}]);
  assert.equal(out().at(-1).enrollment.phase,'checked');assert.equal(out().at(-1).enrollment.can_use,true);
  assert.equal(order.includes('commit'),false,'target success still requires explicit commit');
  send({operation:'voice_enrollment_control',control_id:'restart',action:'start',call_id:'call-two'});
  await eventually(()=>out().some(p=>p.control_id==='restart'));
  send({operation:'call_open',call_id:'call-two',enrollment_session_id:'ven-draft'});await eventually(()=>current==='call-two');
  send({operation:'voice_enrollment_control',control_id:'stale',action:'check',enrollment_session_id:'ven-old'});
  await eventually(()=>errors.length===1);assert.equal(current,'call-two','stale drafts cannot close the current call');
  assert.match(String(errors.pop()),/VOICE_ENROLLMENT_SESSION_NOT_FOUND/);
  const archived=Promise.withResolvers<PromiseSettledResult<typeof audio>>();
  tail=Promise.resolve(sink!.turn({call_id:'call-two',turn:0,user:'后来坐下喝了一杯茶',assistant:'',interrupted:true},archived.promise));
  send({operation:'voice_enrollment_control',control_id:'check',action:'check',enrollment_session_id:'ven-draft'});
  await eventually(()=>current===undefined);assert.equal(order.includes('check'),false,'assessment waits for the final archived turn');
  archived.resolve({status:'fulfilled',value:audio});await tail;await eventually(()=>out().some(p=>p.control_id==='check'));
  assert.equal(received.length,2);assert.equal(out().at(-1).enrollment.clean_speech_ms,16000);
  assert.equal(out().at(-1).enrollment.phase,'checked');assert.deepEqual(errors,[]);
  send({operation:'voice_enrollment_control',control_id:'last-start',action:'start',call_id:'call-three'});
  await eventually(()=>out().some(p=>p.control_id==='last-start'));
  send({operation:'call_open',call_id:'call-three',enrollment_session_id:'ven-draft'});await eventually(()=>current==='call-three');
  send({operation:'voice_enrollment_control',control_id:'leave',action:'discard',enrollment_session_id:'ven-draft',call_id:'call-three'});
  await eventually(()=>out().some(p=>p.control_id==='leave')||errors.length>0);
  assert.deepEqual(errors,[]);assert.equal(current,undefined);
  assert.deepEqual(order.slice(-3),['pause','sealed','discard'],'the final call is sealed before its grant is cancelled');
  assert.equal(out().at(-1).enrollment.phase,'discarded');
});

test('full enrollment preview fits the existing reliable packet budget with maximum wire IDs',async()=>{
  const {Ajv}=await import('ajv'),wire=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',()=>true);
  const validate=ajv.compile({$defs:wire.$defs,...wire.outputs.voice_enrollment_state});
  const maxId='a'.repeat(200),enrollment={available:true,session_id:maxId,call_id:maxId,phase:'checked',recorded_ms:600000,
    clean_speech_ms:600000,target_speech_ms:150000,issue:null,can_use:true,
    source_device:{device_id:maxId,device_type:'phone'},updated_at:now,
    owner:{enrolled:true,reenrollment_required:false,samples:1000,updated_at:now,consistency_min:-1},preview_audio_base64:'A'.repeat(10728)};
  const packet={schema_version:wire.schema,operation:'voice_enrollment_state',session_id:maxId,control_id:maxId,enrollment};
  assert.ok(validate(packet),JSON.stringify(validate.errors));
  assert.ok(Buffer.byteLength(JSON.stringify(packet))<=Math.min(wire.output_limit,REALTIME_ASSISTANT_MAX_PACKET_BYTES));
  assert.equal(validate({...packet,enrollment:{...enrollment,preview_audio_base64:'A'.repeat(10729)}}),false);
});

test('owner override formal control path authenticates, validates, broadcasts and returns typed failures without a native run',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'override-wire-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const f=fixture(),storage=new PosixStorage(root),room=testRoom(),errors:unknown[]=[];
  const passphrase='synthetic-control-phrase';
  await fs.writeFile(join(root,'owner-override.json'),JSON.stringify(await createOwnerOverrideSecret(passphrase)),{mode:0o600});
  const override=new OwnerOverride({storage,secret_root:root,ttl_s:60,now:()=>Date.parse(now)});t.after(()=>override.close());
  const native:NativeClient={create:async()=>{throw new Error('control must never enter native');},
    status:async()=>{throw new Error('no run');},cancel:async()=>{throw new Error('no run');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'override-wire'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,
    skill:'fixed',max_read_bytes:8192,owner_override:override});t.after(()=>runtime.close());
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,extensions:[createOwnerOverrideWire(runtime,error=>errors.push(error))],
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});t.after(()=>bridge.close());
  await bridge.onBootstrapConnected(f.input);
  const send=(body:unknown,identity='terminal')=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const receipt=(control:string)=>room.published.find((p:any)=>p.operation==='owner_override_status'&&p.control_id===control) as any;
  await eventually(()=>room.published.some((p:any)=>p.operation==='owner_override_status'&&!p.control_id));
  send({operation:'owner_override_enable',control_id:'foreign',passphrase},'foreign');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(await override.active(),false);
  send({operation:'owner_override_enable',control_id:'bad-shape',passphrase,extra:true});
  await eventually(()=>errors.length===1);assert.match(String(errors[0]),/OWNER_OVERRIDE_INPUT_INVALID/);
  send({operation:'owner_override_enable',control_id:'wrong',passphrase:'wrong'});
  await eventually(()=>!!receipt('wrong'));assert.equal(receipt('wrong').error_code,'OWNER_OVERRIDE_INVALID_PASSPHRASE');
  assert.equal(receipt('wrong').owner_override.enabled,false);
  send({operation:'owner_override_enable',control_id:'enable',passphrase});
  await eventually(()=>!!receipt('enable'));assert.equal(receipt('enable').owner_override.enabled,true);
  assert.equal(receipt('enable').owner_override.remaining_s,60);
  await eventually(()=>room.published.some((p:any)=>p.operation==='owner_override_status'&&!p.control_id&&p.owner_override.enabled));
  send({operation:'owner_override_status',control_id:'status'});
  await eventually(()=>!!receipt('status'));assert.equal(receipt('status').owner_override.enabled,true);
  send({operation:'owner_override_disable',control_id:'off'});
  await eventually(()=>!!receipt('off'));assert.equal(receipt('off').owner_override.enabled,false);
  assert.equal(JSON.stringify(room.published).includes(passphrase),false);
  assert.equal(JSON.stringify(errors).includes(passphrase),false);
});

test('glasses-origin navigation uses a fresh background fix and sends its route on capable phone reconnect',async t=>{
  const m=await movementFixture(t,navigationFixture(),{},{source:'glasses'});
  m.phone.send({operation:'location_update',location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
  await new Promise(resolve=>setImmediate(resolve));await m.phone.bridge.close();
  const result=await m.tool('paios_navigate',{destination:'公司',mode:'bicycling'});
  assert.equal(result.phone_status,'PHONE_NOT_CONNECTED');assert.equal(result.destination,'公司');
  assert.equal(result.origin.freshness_bound_ms,120000);assert.equal(result.origin.age_ms,0);
  assert.equal(m.glasses.out('rejected').length,0);assert.equal(m.glasses.out('nav_route').length,1);
  const phone=await m.connect('phone');await eventually(()=>phone.out('nav_route').length===1);
  assert.equal(phone.out('nav_route')[0].destination.name,'公司');assert.equal(m.errors.length,0);
});

test('uncached pending glasses navigation waits for phone ready then requests and receives a fresh location',async t=>{
  let ready=false,requests=0;const sequence:string[]=[];
  const port=navigationFixture(),m=await movementFixture(t,port,{},{source:'glasses',publish:async(packet,respond)=>{
    if(packet.operation==='ready')ready=true;
    if(packet.operation==='location_request'){
      assert.equal(ready,true);requests++;sequence.push('location_request');
      respond({operation:'location_update',request_id:packet.request_id,location:{latitude:31,longitude:121,accuracy_m:5,datum:'wgs84',observed_at:m.at()}});
    }
    if(packet.operation==='nav_route')sequence.push('nav_route');
  }});
  await m.phone.bridge.close();ready=false;
  assert.equal((await m.tool('paios_navigate',{destination:'公司',mode:'walking'})).error_code,'PHONE_NOT_CONNECTED');
  const phone=await m.connect('phone');await eventually(()=>phone.out('nav_route').length===1);
  assert.equal(phone.out('ready').length,1);assert.equal(requests,1);assert.deepEqual(sequence,['location_request','nav_route','nav_route']);
  phone.send({operation:'location_update',location:null});await new Promise(setImmediate);m.advance(1);
  await phone.bridge.close();port.plan=async()=>{throw new Error('provider unavailable');};
  assert.equal((await m.tool('paios_navigate',{destination:'学校',mode:'walking'})).error_code,'PHONE_NOT_CONNECTED');
  const recovered=await m.connect('phone');await eventually(()=>m.glasses.out('rejected').some(body=>body.error_code==='NAVIGATION_PROVIDER_FAILED'));
  assert.equal(recovered.out('ready').length,1);
  m.glasses.send({operation:'ride_control',action:'start'});await eventually(()=>recovered.out('ride_control').length===1);
  assert.equal(m.errors.length,0);
});

function thinkingControlRuntime(storage:PosixStorage,authority:FormalSourceAuthority) {
  const native:NativeClient={create:async()=>{throw Error('UNUSED');},status:async()=>{throw Error('UNUSED');},cancel:async()=>{throw Error('UNUSED');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'thinking-control'});
  return new PersonalAIOSRuntime({storage,native,admission,archive:new RawArchive(storage,8192),sourceAuthority:authority,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'fixed',max_read_bytes:8192});
}

for(const fail of [false,true])test(`thinking mode ingress waits for acknowledged update and durable preference: ${fail?'failure':'success'}`,{timeout:5000},async t=>{
  const f=fixture(false,undefined,['text'],undefined,true),root=await fs.mkdtemp(join(tmpdir(),'mode-control-'));
  const storage=new PosixStorage(root),errors:unknown[]=[],entered=deferred<void>(),updated=deferred<void>(),persisted=deferred<void>(),persistEntered=deferred<void>();
  const runtime=thinkingControlRuntime(storage,f.authority);
  const remember=runtime.rememberCallConversationMode.bind(runtime);let mode:'chat'|'thinking'='chat',writes=0;
  t.mock.method(runtime,'rememberCallConversationMode',async(source:Parameters<PersonalAIOSRuntime['rememberCallConversationMode']>[0],requested:'chat'|'thinking')=>{writes++;persistEntered.resolve();await persisted.promise;await remember(source,requested);});
  const room=testRoom(),bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e),voice_call:{open:async()=>{},close:async()=>true,respond:async()=>false,
      attach:()=>()=>{},conversationMode:()=>mode,setConversationMode:async(_id,next,control)=>{assert.equal(control?.id,'mode');await control!.authorize();entered.resolve();await updated.promise;
        if(fail)throw new ContractError('VOICE_SESSION_UPDATE_FAILED',503);mode=next;await control!.confirmed();}}});
  t.after(async()=>{updated.resolve();persisted.resolve();await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  const send=(body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send({operation:'call_set_conversation_mode',call_id:'call',control_id:'mode',conversation_mode:'thinking'});await entered.promise;
  assert.equal(room.published.some((p:any)=>p.operation==='control_receipt'),false);assert.equal(await runtime.callConversationMode(source),'chat');
  updated.resolve();
  if(fail){
    await eventually(()=>room.published.some((p:any)=>p.operation==='rejected'));
    assert.equal(mode,'chat');assert.equal(writes,0);assert.equal(await runtime.callConversationMode(source),'chat');
    assert.equal(room.published.some((p:any)=>p.operation==='control_receipt'),false);
    assert.equal((room.published.at(-1) as any).error_code,'VOICE_SESSION_UPDATE_FAILED');assert.equal(errors.length,1);
  }else{
    await persistEntered.promise;assert.equal(mode,'thinking');assert.equal(room.published.some((p:any)=>p.operation==='control_receipt'),false);
    persisted.resolve();await eventually(()=>room.published.some((p:any)=>p.operation==='control_receipt'));
    assert.equal(await runtime.callConversationMode(source),'thinking');assert.equal(writes,1);
    assert.deepEqual((room.published.at(-1) as any).receipt,{conversation_mode:'thinking'});assert.deepEqual(errors,[]);
  }
});

test('thinking mode control retries reuse their receipt and successive mode requests remain ordered',{timeout:5000},async t=>{
  const f=fixture(false,undefined,['text'],undefined,true),root=await fs.mkdtemp(join(tmpdir(),'mode-order-')),storage=new PosixStorage(root);
  const entered=deferred<void>(),release=deferred<void>(),errors:unknown[]=[],updates:string[]=[];
  const runtime=thinkingControlRuntime(storage,f.authority);
  const room=testRoom(),call=createVoiceCallSession({thinking_mode:{enabled:true,reader_instructions:'只读原文',status_text:{greeting:'思考模式',waiting:'正在想',slow:'仍在想',failed:'主脑没连上',interrupted:'朗读已停',readout_mismatch:'请以文字为准'}},room:()=>room as never,onError:e=>errors.push(e),onState:()=>{},onTranscript:()=>{},onTurn:()=>{},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},clear:()=>{},drain:async()=>{},close:async()=>{}} as never),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
      setInstructions:async(_text:string,options?:{conversation_mode?:string})=>{updates.push(options?.conversation_mode??'unknown');if(updates.length===1){entered.resolve();await release.promise;}}})});
  await call.open('call');
  const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e),voice_call:{...call,attach:()=>()=>{}}});
  t.after(async()=>{release.resolve();await call.closeAll();await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});await bridge.onBootstrapConnected(f.input);
  const send=(control_id:string,conversation_mode:string)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_set_conversation_mode',call_id:'call',control_id,conversation_mode})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  send('first','thinking');await entered.promise;send('first','thinking');send('second','chat');
  await new Promise(setImmediate);assert.deepEqual(updates,['thinking']);assert.equal(room.published.some((p:any)=>p.operation==='control_receipt'),false);
  release.resolve();await eventually(()=>errors.length>0||room.published.filter((p:any)=>p.operation==='control_receipt').length===3);
  assert.deepEqual(errors,[]);
  const receipts=(room.published as any[]).filter(p=>p.operation==='control_receipt');
  assert.deepEqual(updates,['thinking','chat']);assert.deepEqual(receipts.map(p=>p.control_id),['first','first','second']);
  assert.deepEqual(receipts[0],receipts[1]);const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  assert.equal(await runtime.callConversationMode(source),'chat');assert.deepEqual(errors,[]);
});

test('thinking mode: a silent brain turn (reply_mode none) ends the call thinking status like a spoken reply',{timeout:5000},async t=>{
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'thinking-silent-')),storage=new PosixStorage(root),errors:unknown[]=[];
  const run:NativeRun={run_id:'silent-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:''};
  const native:NativeClient={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>{throw Error('BRAIN_MUST_NOT_BE_CANCELLED');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'thinking-silent'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,16384),admission,native,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:16384,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:e=>errors.push(e)}});
  let dId='',sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;const statuses:string[]=[],settled=deferred<string>();
  observeCallTurns(t,runtime,accepted=>{if(accepted.admission)dId=accepted.processed_event.processed_event_id;});
  const room=testRoom(),bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e),voice_call:{pending:()=> 'call',open:async()=>{},close:async()=>true,
      conversationMode:()=> 'thinking',thinkingStatus:async(_call,status)=>{statuses.push(status);},thinkingSettled:async(call_id,id)=>{assert.equal(call_id,'call');settled.resolve(id);},
      attach:value=>{sink=value;return()=>{};},respond:async()=>{throw Error('a silent turn has nothing to read');}}});
  t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});await bridge.onBootstrapConnected(f.input);
  await sink!.state('call','opening',{mode:'manual',conversation_mode:'thinking'});await sink!.state('call','live',{mode:'manual',conversation_mode:'thinking'});
  await sink!.turn({call_id:'call',turn:0,user:'等下我们去哪吃',assistant:'',interrupted:false,speaker:'owner',route:'handoff'});
  await eventually(()=>Boolean(dId&&admission.get('actual-owner','continuity',dId)?.run_id));
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'silent'},args:{reply_mode:'none'}});
  run.status='completed';
  assert.equal(await settled.promise,dId,'the final empty result settles this turn at the status owner');
  assert.deepEqual(statuses,['waiting'],'no failure or retry status for a deliberate silence');
  assert.equal(room.published.some((p:any)=>p.operation==='call_transcript'&&p.role==='main_agent'),false);
  assert.deepEqual(errors,[]);
});
for(const delivery of ['spoken','interrupted','uncertain','silent'] as const)test(`thinking mode completion publishes sealed brain text before readout: ${delivery}`,{timeout:5000},async t=>{
  const silent=delivery==='silent',spoken=delivery!=='interrupted',speaker=delivery==='uncertain'?'owner_uncertain':'owner';
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'thinking-completion-')),storage=new PosixStorage(root),errors:unknown[]=[];
  const run:NativeRun={run_id:'thinking-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'第一句保留原文。第二句完整写完。'};
  const native:NativeClient={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>{throw Error('BRAIN_MUST_NOT_BE_CANCELLED');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'thinking-text-first'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,16384),admission,native,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:16384,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:e=>errors.push(e)}});
  await runtime.configureTimeline({directory:join(root,'timeline')});let dId='',sink:import('../src/personal-aios-formal-text.ts').CallSink|undefined;
  observeCallTurns(t,runtime,accepted=>{if(accepted.admission)dId=accepted.processed_event.processed_event_id;});
  const room=testRoom(),reads:{text:string;target:unknown}[]=[],responded=deferred<void>(),settledIds:string[]=[];
  const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:e=>errors.push(e),voice_call:{pending:()=> 'call',open:async()=>{},close:async()=>true,
      conversationMode:()=> 'thinking',thinkingStatus:async()=>{},thinkingSettled:async(_call,id)=>{settledIds.push(id);},attach:value=>{sink=value;return()=>{};},respond:async(text,target)=>{
        const chunks=(room.published as any[]).filter(p=>p.operation==='text_chunk'&&p.processed_event_id===dId);
        assert.equal(chunks.map(p=>p.chunk.text).join(''),run.output,'authoritative full text reaches chat before voice starts');
        assert.equal(chunks.at(-1)?.chunk.final,true);assert.equal(target?.message_id,dId);assert.equal(text,run.output,'only visible brain text is spoken; confirmation metadata remains on its existing channel');assert.equal(target?.identity,speaker);
        reads.push({text,target});responded.resolve();return spoken;}}});
  t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});await bridge.onBootstrapConnected(f.input);
  await sink!.state('call','opening',{mode:'manual',conversation_mode:'thinking'});await sink!.state('call','live',{mode:'manual',conversation_mode:'thinking'});
  // A verified owner's handoff is admitted before its audio; the later completion only adds evidence (admission null).
  await sink!.turn({call_id:'call',turn:0,user:'请把答案保留完整',assistant:'',interrupted:!spoken,speaker,route:'handoff'});
  await eventually(()=>Boolean(dId&&admission.get('actual-owner','continuity',dId)?.run_id));
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'open'},args:{reply_mode:silent?'none':'text'}});
  run.status='completed';if(!silent)await responded.promise;await eventually(()=>admission.find(run.run_id,'continuity')===undefined);
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input)),value=await runtime.result(source,'continuity',dId,{text_replay:'sealed'});
  if(silent){
    assert.equal(value.result.reply_mode,'none');assert.equal(value.result.reply_text,'');assert.deepEqual(reads,[]);
    assert.equal(room.published.some((p:any)=>p.operation==='call_transcript'&&p.role==='main_agent'),false);
    assert.deepEqual(errors,[]);return;
  }
  assert.equal(value.result.reply_phase,'sealed');assert.equal(value.result.reply_text,run.output);assert.equal(reads.length,1);
  await eventually(()=>settledIds.length===1);assert.deepEqual(settledIds,[dId],'a read-out answer ends the turn status once, like a silent one');
  if(!spoken){
    await eventually(()=>runtime.timeline!.page('actual-owner').items.filter(item=>item.text===run.output).length===1);
    assert.equal(room.published.some((p:any)=>p.operation==='ambient_reply'&&p.processed_event_id===dId),false);
    const rows=await Promise.all((await storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await storage.read('output-journal',key)).toString())));
    assert.deepEqual(rows.filter(row=>row.callDelivery).map(row=>row.callDelivery.via),['text']);
  }
  assert.deepEqual(errors,[]);
});

// Synthetic values retain the executor field shapes; production owner data stays outside the repository.
for(const terminal of ['phone','mac','glasses','watch'] as const){
  test(`errand report wire: ${terminal} rejects an empty ambient body at /text minLength`,async()=>{
    const wire=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
    const validate=createFormalWireAjv().compile({$defs:wire.$defs,...wire.outputs.ambient_reply});
    const body={schema_version:wire.schema,operation:'ambient_reply',session_id:'session',processed_event_id:'errand:job-000000000001',heard:'',text:''};
    assert.equal(validate(body),false);
    assert.deepEqual(validate.errors?.map(({instancePath,keyword})=>({instancePath,keyword})),[{instancePath:'/text',keyword:'minLength'}]);
    assert.equal(validate({...body,text:'已核实结果'}),true);
  });
  for(const reason of ['lifecycle','failed','cancelled_by_user','timed_out','completed'] as const)
  test(`executor ${reason} result reaches ${terminal} once through real wire validation and rendered ACK`,async t=>{
    const root=await fs.mkdtemp(join(tmpdir(),'errand-shape-wire-')),sources=new FormalTerminalSources();
    const f=fixture(false,{primary:terminal,watch:'watch-source',client:'watch-client'},['text'],{type:terminal,registry:sources});
    const storage=new PosixStorage(root),errors:unknown[]=[];let creates=0;
    const run:NativeRun={run_id:'report-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'已核实这次办事的实际结果。'};
    const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
    const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-wire'});
    const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
      output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
    const dir=join(root,'errands'),spool=createErrandSpool(dir,error=>errors.push(error),{deliver:result=>runtime.deliverErrand(result,error=>errors.push(error)),
      failed:(result,code,at)=>runtime.errandDeliveryFailed(result,code,at)}),room=testRoom();
    const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:spool,onError:error=>errors.push(error)});
    t.after(async()=>{await spool.close();await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
    await spool.start();await bridge.onBootstrapConnected(f.input);
    if(terminal==='glasses'){
      room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'wear_state',control_id:'report-wear',worn:true})),
        {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
      await eventually(()=>room.published.some((body:any)=>body.operation==='wear_state_ack'));
    }
    const job_id='job-000000000001',origin_processed_event_id='d:request';
    const raw={principal_id:'actual-owner',job_id,task:'只读查看当前页面',app:reason==='lifecycle'?null:'测试应用',
      tier:reason==='lifecycle'?'lifecycle':reason==='completed'?'fast':'thorough',payment_owner:null,phone_started_at:now,started_at:now,
      ...(reason==='lifecycle'?{}:{payment_page_left:false,origin_processed_event_id}),success:['lifecycle','completed'].includes(reason),
      answer:reason==='lifecycle'?'执行手机已关闭':reason==='completed'?'已查看页面':'本次未完成',finished_at:now,
      ...(['failed','cancelled_by_user'].includes(reason)?{status:'error',error_code:'APP_LOGIN_REQUIRED',login_app:'测试应用'}:{}),
      terminal_reason:reason==='lifecycle'?'completed':reason,retryable:reason==='timed_out'};
    if(reason!=='lifecycle')await storage.publish('errand-origins',digest({principal_id:raw.principal_id,job_id}),Buffer.from(JSON.stringify({origin_processed_event_id})));
    await fs.writeFile(join(dir,`${job_id}.done.json`),JSON.stringify(raw));await spool.sweep();await eventually(()=>creates===1);
    await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'report'},args:{reply_mode:'text'}}) as {status:string}).status==='opened');
    run.status='completed';
    const packet=()=>room.published.find((body:any)=>body.operation==='text_chunk'||body.operation==='display_card'&&body.delivery) as any;
    await eventually(()=>!!packet());await spool.sweep();await spool.sweep();
    assert.equal(room.published.filter((body:any)=>body.operation==='text_chunk'||body.operation==='display_card'&&body.delivery).length,1);
    const wire=JSON.parse(await fs.readFile(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8')),ajv=createFormalWireAjv();
    for(const body of room.published as any[]){const validate=ajv.compile({$defs:wire.$defs,...wire.outputs[body.operation]});assert.equal(validate(body),true,JSON.stringify(validate.errors));}
    const body=packet(),chunk=body.chunk??body.delivery,dId=body.processed_event_id??chunk.processed_event_id;
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'ack',processed_event_id:dId,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,
      reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:now}})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    await eventually(async()=>{await spool.sweep();return (await fs.readdir(dir)).includes(`${job_id}.delivered.json`);});
    assert.equal(creates,1);assert.deepEqual(errors,[]);
  });
}

test('an empty errand rejection retires the report while a completion sweep is resubscribing',{timeout:20000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const root=await fs.mkdtemp(join(tmpdir(),'errand-rejected-replay-')),sources=new FormalTerminalSources(),storage=new PosixStorage(root),errors:unknown[]=[];
  const f=fixture(false,{primary:'phone',watch:'watch-source',client:'watch-client'},['text'],{type:'phone',registry:sources}),room=testRoom();
  const runs=new Map<string,NativeRun>();let creates=0;
  const native:NativeClient={create:async()=>{const run:NativeRun={run_id:`report-${++creates}`,session_id:'continuity',conversation_session_id:'continuity',status:'running',output:'The requested page was checked.'};runs.set(run.run_id,run);return {...run};},
    status:async id=>({...runs.get(id)!}),cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-rejected-replay'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
  const dir=join(root,'errands'),failed:unknown[][]=[],spool=createErrandSpool(dir,error=>errors.push(error),{deliver:result=>runtime.deliverErrand(result,error=>errors.push(error)),
    failed:async(...args)=>{failed.push(args);return runtime.errandDeliveryFailed(...args);}});
  runtime.setErrandRefresh(spool.refresh);
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:spool,onError:error=>errors.push(error)});
  t.after(async()=>{resume.resolve();await spool.close();await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const job={principal_id:'actual-owner',job_id:'job-000000000025',task:'Read the requested page',success:true,answer:'Checked',finished_at:now};
  const entered=deferred<void>(),rejected=deferred<void>(),resume=deferred<void>();
  const submit=runtime.submitErrand.bind(runtime);let holdReplay=false,original:ProcessedEvent|undefined;
  t.mock.method(runtime,'submitErrand',async(...args:Parameters<typeof submit>)=>{
    const accepted=await submit(...args);if(args[0].event_id===`errand:${job.job_id}`)original??=accepted.processed_event;
    if(holdReplay&&args[0].event_id===`errand:${job.job_id}`){holdReplay=false;entered.resolve();await resume.promise;}
    return accepted;
  });
  const reply=runtime.errandReply.bind(runtime),entries:{at_ms:number;first:boolean;run_id:string|undefined}[]=[];
  t.mock.method(runtime,'errandReply',async(principal,value,onError,delivery)=>{
    entries.push({at_ms:Date.now(),first:delivery.first,run_id:value.result.run_id});
    try{return await reply(principal,entries.length===1?{...value,result:{...value.result,reply_text:''}}:value,onError,delivery);}
    catch(error){rejected.resolve();throw error;}
  });
  await spool.start();await bridge.onBootstrapConnected(f.input);
  await fs.writeFile(join(dir,`${job.job_id}.done.json`),JSON.stringify(job));await spool.sweep();await eventually(()=>!!admission.find('report-1','continuity'));
  await runtime.tool('paios_open_reply',{context:{run_id:'report-1',session_id:'continuity',tool_call_id:'open'},args:{reply_mode:'text'}});
  // A sweep passed deliverErrand's failure check before the old subscription rejected the sealed report.
  holdReplay=true;const sweep=spool.sweep();await entered.promise;runs.get('report-1')!.status='completed';
  await rejected.promise;t.mock.timers.setTime(entries[0]!.at_ms+25);resume.resolve();await sweep;
  await spool.sweep();await spool.sweep();await spool.sweep();
  const invalid=JSON.parse(await fs.readFile(join(dir,`${job.job_id}.invalid.json`),'utf8'));
  const originalWire=()=>room.published.filter((packet:any)=>packet.event_id===`errand:${job.job_id}`||packet.processed_event_id===original!.processed_event_id||packet.chunk?.event_id===`errand:${job.job_id}`);
  t.diagnostic(JSON.stringify({entries,wire:originalWire().map((packet:any)=>packet.operation),failure_observations:failed.length}));
  assert.equal(invalid.delivery_failure.error_code,'ERRAND_REPORT_NOT_DELIVERED');assert.equal(failed.length,1);
  const events=await Promise.all((await storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-events',key)).toString())));
  assert.equal(events.filter(d=>d.content.app_event.kind==='errand_delivery_failed'&&d.content.app_event.job_id===job.job_id).length,1);
  assert.equal(entries.length,1,'the resubscribing sweep must receive the rejection before entering errandReply again');
  assert.deepEqual(originalWire(),[],'the rejected report has no wire header, text or ambient record');
  const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  await assert.rejects(runtime.subscribeResult(source,'continuity',original!.processed_event_id,async value=>{
    await runtime.errandReply(source.principal_id,value,error=>errors.push(error),{first:true});
  },error=>errors.push(error),{outreach:'errand'}),/ERRAND_REPORT_NOT_DELIVERED/);
  assert.equal(entries.length,1,'retirement must retain the rejection for a late subscriber');assert.deepEqual(originalWire(),[]);
  await eventually(()=>creates===2);assert.equal(creates,2,'one report run and one failure observation run');
});

test('a sealed silent errand stops before producing an empty phone ambient record',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'errand-empty-phone-')),sources=new FormalTerminalSources(),storage=new PosixStorage(root),errors:unknown[]=[];
  const mac=fixture(false,{primary:'mac',watch:'watch-source',client:'watch-client'},['text'],{type:'mac',registry:sources});
  const phone=fixture(false,{primary:'phone',watch:'watch-source',client:'watch-client'},['text'],{type:'phone',registry:sources});
  let creates=0;const run:NativeRun={run_id:'silent-run',session_id:'continuity',conversation_session_id:'continuity',status:'running',output:''};
  const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-empty'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
  const dir=join(root,'errands'),spool=createErrandSpool(dir,error=>errors.push(error),{deliver:result=>runtime.deliverErrand(result,error=>errors.push(error))}),rooms=[testRoom(),testRoom()],bridges:ReturnType<typeof createFormalTextIngress>[]=[];
  t.after(async()=>{await spool.close();for(const bridge of bridges)await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await spool.start();
  for(const [index,f] of [mac,phone].entries()){
    const bridge=createFormalTextIngress({participant:{roomPort:rooms[index]!,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
      runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:spool,onError:error=>errors.push(error)});
    bridges.push(bridge);await bridge.onBootstrapConnected(f.input);
  }
  await runtime.ownerInput(await runtime.authenticate(mac.authority.credentialForBootstrap(mac.input)));
  const job={principal_id:'actual-owner',job_id:'job-000000000002',task:'只读查看',success:true,answer:'已查看',finished_at:now};
  await fs.writeFile(join(dir,`${job.job_id}.done.json`),JSON.stringify(job));await spool.sweep();await eventually(()=>creates===1);
  await eventually(()=>!!admission.find(run.run_id,'continuity'));
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'silent'},args:{reply_mode:'none'}});
  run.status='completed';
  await eventually(async()=>{
    const invalid=errors.find(error=>error instanceof ContractError&&error.code==='FORMAL_TEXT_OUTPUT_INVALID');if(invalid)throw invalid;
    await spool.sweep();return (await fs.readdir(dir)).includes(`${job.job_id}.delivery-failed.json`);
  },2000);
  const failure=JSON.parse(await fs.readFile(join(dir,`${job.job_id}.delivery-failed.json`),'utf8')).delivery_failure;
  assert.equal(failure.error_code,'ERRAND_REPORT_NOT_DELIVERED');assert.equal(failure.stage,'report_run');
  const reason=JSON.parse(failure.reason);
  assert.ok(reason.warnings.includes('ERRAND_REPORT_REQUIRED'));
  assert.deepEqual(reason.missing_report_requirements,['nonempty_reply_text','reply_mode','output_plan']);
  assert.equal(reason.recipient_selection,'not_started');
  assert.equal(reason.recipient_selection_after_report_guard,true);
  assert.equal(creates,1);
  assert.ok(!errors.some(error=>error instanceof ContractError&&error.code==='FORMAL_TEXT_OUTPUT_INVALID'));
  assert.equal(rooms[1]!.published.filter((body:any)=>body.operation==='ambient_reply').length,0);
});

// Regression: the report run declares no outcome for an ordinary successful send.
for(const replay of ['ordinary','ordinary_disconnected','self_check_of'] as const)
test(`round-3 errand replay (${replay}): one owner report or an absorbed self-check result, never a delivery failure`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'errand-round3-')),sources=new FormalTerminalSources(),storage=new PosixStorage(root),errors:unknown[]=[];
  const f=fixture(false,{primary:'phone',watch:'watch-source',client:'watch-client'},['text'],{type:'phone',registry:sources}),room=testRoom();
  const ordinary=replay!=='self_check_of';
  const run:NativeRun={run_id:'run_c835b54268f647ddafe5d01f91cd094c',session_id:'continuity',conversation_session_id:'continuity',status:'running',
    output:ordinary?'这单已在 fixture 里发送完成，结果是「模拟继续办理完成。」。':''};
  if(replay==='ordinary_disconnected'){const publish=room.localParticipant.publishData;room.localParticipant.publishData=async bytes=>{
    await publish(bytes);const body=JSON.parse(Buffer.from(bytes).toString());
    if(body.operation==='text_chunk'||body.operation==='display_card'&&body.delivery){const peer=room.remoteParticipants.get('terminal')!;
      room.remoteParticipants.clear();room.emit(RoomEvent.ParticipantDisconnected,peer);}
  };}
  let creates=0;
  const native:NativeClient={routeSelfcheckResult:async()=>replay==='self_check_of',create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'errand-round3'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
  let textSent=0;const markTextSent=runtime.errandTextSent.bind(runtime);
  t.mock.method(runtime,'errandTextSent',async(...args)=>{await markTextSent(...args);textSent++;});
  const failed:unknown[][]=[],dir=join(root,'errands'),spool=createErrandSpool(dir,error=>errors.push(error),{deliver:result=>runtime.deliverErrand(result,error=>errors.push(error)),
    failed:async(...args)=>{failed.push(args);return runtime.errandDeliveryFailed(...args);}});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,errands:spool,onError:error=>errors.push(error)});
  t.after(async()=>{await spool.close();await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await spool.start();await bridge.onBootstrapConnected(f.input);
  const job_id=ordinary?'job-63e081726062':'job-237480ca39ea',origin_processed_event_id='d:request';
  await storage.publish('errand-origins',digest({principal_id:'actual-owner',job_id}),Buffer.from(JSON.stringify({origin_processed_event_id})));
  await fs.writeFile(join(dir,`${job_id}.done.json`),JSON.stringify({principal_id:'actual-owner',job_id,origin_processed_event_id,app:'千问',tier:'fast',
    task:'在 fixture 微信中给联系人 wechat:fixture 发送文本消息：fixture-reuse',title:'在 fixture 微信中给联系人 wechat:fixture',success:true,
    answer:'模拟继续办理完成。',finished_at:now,terminal_reason:'completed',retryable:false,evidence_ref:{tool:'phone_status',job_id},
    ...(replay==='self_check_of'?{self_check_of:'job-63e081726062:0'}:{})}));
  await spool.sweep();
  if(ordinary){
    await eventually(()=>!!admission.find(run.run_id,'continuity'));
    const open=(id:string,reply_mode:string)=>runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:id},args:{reply_mode}});
    assert.deepEqual(await open('silent','none'),{status:'rejected',error_code:'ERRAND_REPORT_REQUIRED'});
    assert.deepEqual(await open('report','text'),{status:'opened',error_code:null});
    run.status='completed';
  }
  const reports=()=>room.published.filter((body:any)=>body.operation==='text_chunk'||body.operation==='display_card'&&body.delivery) as any[];
  if(replay==='ordinary_disconnected'){
    await eventually(()=>textSent===1);
    const entries=await Promise.all((await storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await storage.read('output-journal',key)).toString())));
    assert.equal(entries.filter(entry=>entry.textPublished?.seq===1).length,1,'successful SDK publication persists even when its peer aborts before return');
    assert.equal(reports().length,1);return;
  }
  if(ordinary){
    await eventually(()=>reports().length>0);await spool.sweep();await spool.sweep();
    const [body]=reports(),chunk=body.chunk??body.delivery;
    room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'ack',processed_event_id:body.processed_event_id??chunk.processed_event_id,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,
      reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:now}})),
      {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  }
  await eventually(async()=>{await spool.sweep();return (await fs.readdir(dir)).includes(`${job_id}.delivered.json`);});
  await spool.sweep();await spool.sweep();
  assert.equal(reports().length,ordinary?1:0,'exactly one owner report for an ordinary job; none for an absorbed self-check result');
  assert.equal(JSON.parse(await fs.readFile(join(dir,`${job_id}.delivered.json`),'utf8')).report_absorbed,ordinary?undefined:true);
  const events=await Promise.all((await storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-events',key)).toString())));
  assert.deepEqual(events.filter(d=>d.content.app_event?.kind==='errand_delivery_failed'),[]);assert.deepEqual(failed,[]);
  assert.equal(creates,ordinary?1:0,'an active self-check absorbs before owner report admission');
  assert.equal(textSent,ordinary?1:0,'only published errand chunks enter OUT publication evidence');assert.deepEqual(errors,[]);
});

test('relaunch rejects an inactive source while fresh bootstrap replays its durable result without another native run',async t=>{
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'formal-relaunch-')),storage=new PosixStorage(root);
  const errors:unknown[]=[],rooms=[testRoom(),testRoom()];let creates=0;
  const run:NativeRun={run_id:'relaunch-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'};
  const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>({...run})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'relaunch'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:f.authority,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'fixed',max_read_bytes:8192,
    automatic_output:{onError:error=>errors.push(error)}});
  const participant={roomPort:rooms[0]!,disconnect:async()=>{}},bridge=createFormalTextIngress({participant:participant as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
  t.after(async()=>{await bridge.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const send=(room:ReturnType<typeof testRoom>,body:unknown)=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const out=(room:ReturnType<typeof testRoom>,operation:string)=>room.published.filter((p:any)=>p.operation===operation) as any[];
  await bridge.onBootstrapConnected(f.input);
  send(rooms[0]!,{operation:'submit',event_id:'before-relaunch',captured_at:now,text:'controlled request'});
  await eventually(()=>out(rooms[0]!,'accepted').some(p=>p.admission.run_id===run.run_id));
  const dID=out(rooms[0]!,'accepted')[0]!.processed_event_id;
  const original=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'reply'},args:{reply_mode:'text'}});
  f.setSessionState('terminal');
  await assert.rejects(runtime.authenticate(f.authority.credentialForBootstrap(f.input)),/SOURCE_BINDING_INACTIVE/);
  await assert.rejects(runtime.result(original,'continuity',dID),/SOURCE_BINDING_INACTIVE/);
  send(rooms[0]!,{operation:'result',processed_event_id:dID});
  await eventually(()=>errors.some(error=>String(error).includes('SOURCE_BINDING_INACTIVE')));
  rooms[0]!.emit(RoomEvent.Disconnected);
  Object.assign(run,{status:'completed',output:'controlled retained result'});
  f.setSessionState('active');f.setRoute('route-2');
  participant.roomPort=rooms[1]!;await bridge.onBootstrapConnected(f.input);
  const retiredPackets=rooms[0]!.published.length;
  send(rooms[1]!,{operation:'result',processed_event_id:dID,text_replay:'sealed'});
  await eventually(()=>out(rooms[1]!,'text_chunk').some(p=>p.chunk.final));
  assert.equal(out(rooms[1]!,'text_chunk').map(p=>p.chunk.text).join(''),'controlled retained result');
  assert.equal(out(rooms[1]!,'result_header')[0]!.processed_event_id,dID);
  assert.equal(rooms[0]!.published.length,retiredPackets,'the retired transport gets no replay');
  assert.equal(creates,1,'binding churn does not lose or repeat the admitted work');
});

test('phone call utterances retain issued provenance through payment facts and durable observation admission',{timeout:30000},async t=>{
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources},true);
  const root=await fs.mkdtemp(join(tmpdir(),'call-issued-source-')),storage=new PosixStorage(root),archive=new RawArchive(storage,16384),errors:unknown[]=[];
  const runs=new Map<string,NativeRun>();let created=0,observed=0,transcribed=0;
  const native:NativeClient={create:async body=>{const run={run_id:`call-run-${++created}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'completed',output:''};runs.set(run.run_id,run);return run;},
    status:async id=>runs.get(id)!,cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
  const payment=PaymentAuthority.open(join(root,'payment'),{config:{...DEFAULT_PAYMENT_CONFIG,enabled:true,executor_key_file:'/fixture/executor.key'}});
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:200000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'call-provenance'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,payment,payment_devices:async()=>[],sourceAuthority:sources,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'fixed',max_read_bytes:16384});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const room=testRoom(),sinks=new Set<import('../src/personal-aios-formal-text.ts').CallSink>(),vad=controlledVad(),asset={path:'/synthetic',sha256:'0'.repeat(64)};
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},vision:false,expressive:false,
    turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'fixture',voice:'fixture'}},score:async()=>1,thinking:new Int16Array(480)},
    openVad:signal=>vad.openVad(signal),identifySpeech:async()=>({verdict:'unknown'}),transcribeSpeech:async()=>`controlled utterance ${++transcribed}`,
    classifySpeech:async()=>({stop:false,guests:'unchanged'}),
    createPlayout:()=>({open:async()=>{},playedSamples:()=>0,push:()=>{},interrupt:()=>{},clear:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:async(...args)=>{await Promise.all([...sinks].map(sink=>sink.state(...args)));},onTranscript:(...args)=>{for(const sink of sinks)sink.transcript(...args);},
    onTurn:async(...args)=>{try{await Promise.all([...sinks].map(sink=>sink.turn(...args)));}finally{observed++;}},
    onSealed:async(...args)=>{await Promise.all([...sinks].map(sink=>sink.sealed?.(...args)));},onError:error=>errors.push(error)});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),voice_call:{...call,attach:sink=>{sinks.add(sink);return()=>{sinks.delete(sink);};}}});
  t.after(async()=>{await Promise.allSettled([call.closeAll(),bridge.close()]);await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);
  room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_open',call_id:'issued-source'})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>call.active()==='issued-source');
  for(let utterance=1;utterance<=3;utterance++){
    call.pushPcm(new Int16Array(512));await new Promise(setImmediate);
    for(let frame=0;frame<36;frame++){call.pushPcm(new Int16Array(512).fill(1000));await new Promise(setImmediate);}
    call.pushPcm(new Int16Array(512));await eventually(()=>observed===utterance);
  }
  const events=await Promise.all((await storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-events',key)).toString())));
  const turns=events.filter(d=>d.content.app_event?.kind==='voice_turn');
  await eventually(()=>created===3||errors.length>0);
  t.diagnostic(JSON.stringify({utterances:observed,processed_turns:turns.length,native_runs:created,errors:errors.map(e=>({code:(e as ContractError).code,frames:(e as Error).stack?.split('\n').slice(1,6)}))}));
  assert.deepEqual(errors,[]);
  assert.equal(turns.length,3);assert.equal(created,3);
  for(const turn of turns){assert.equal(turn.content.audio_observations[0].speaker_ref,'unknown');assert.equal(turn.content.audio_observations[0].instruction_eligible,false);assert.ok(await admission.readOnly(turn.principal_id,'continuity',turn.processed_event_id));
    assert.ok(await archive.read(turn.raw_ref,turn.principal_id,turn.archive_revision));}
  assert.equal(runtime.timeline!.observations('actual-owner').length,3);
  await call.close('issued-source','button');await call.closeAll();
  assert.deepEqual(errors,[]);
});

for(const tail of [false,true])test(`server call seal preserves its ${tail?'pending spoken turn and ':''}close observation after the opening source binding becomes inactive`,{timeout:15000},async t=>{
  const sources=new FormalTerminalSources(),f=fixture(false,{primary:'phone',watch:'watch',client:'watch-client'},['text'],{type:'phone',registry:sources},true);
  const root=await fs.mkdtemp(join(tmpdir(),'formal-inactive-call-seal-')),storage=new PosixStorage(root),errors:unknown[]=[];
  const native:NativeClient={create:async body=>({run_id:'closed-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'completed',output:''}),
    status:async()=>({run_id:'closed-run',session_id:'continuity',conversation_session_id:'continuity',status:'completed',output:''}),cancel:async()=>{throw new Error('unused');}};
  let mirrored=0;t.mock.method(sourceClient(native),'mirrorCallTurn',async(_d:ProcessedEvent,session:string)=>{mirrored++;return session;});
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:100000,policy_version:'inactive-call-seal'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,sourceAuthority:sources,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'fixed',max_read_bytes:8192});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const sinks=new Set<import('../src/personal-aios-formal-text.ts').CallSink>(),room=testRoom();
  const call=createVoiceCallSession({room:()=>({}),vision:false,expressive:false,onError:error=>errors.push(error),
    onState:async(...args)=>{await Promise.all([...sinks].map(sink=>sink.state(...args)));},onTranscript:()=>{},
    onTurn:async(...args)=>{await Promise.all([...sinks].map(sink=>sink.turn(...args)));},
    onSealed:async(...args)=>{await Promise.all([...sinks].map(sink=>sink.sealed?.(...args)));},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{}})});
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as unknown as LiveKitCloudParticipantPort,
    runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error),
    voice_call:{...call,attach:sink=>{sinks.add(sink);return()=>{sinks.delete(sink);};}}});
  t.after(async()=>{await Promise.allSettled([call.closeAll(),bridge.close()]);await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await bridge.onBootstrapConnected(f.input);
  room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'call_open',call_id:'inactive-seal'})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>call.active()==='inactive-seal'&&room.published.some((p:any)=>p.operation==='call_state'&&p.state==='live'));
  const audio=Promise.withResolvers<PromiseSettledResult<NonNullable<import('../src/voice-call-session.ts').CallTurn['audio']>>>();
  const pending=Promise.allSettled(tail?[...sinks].map(sink=>sink.turn({call_id:'inactive-seal',turn:0,user:'controlled spoken turn',
    assistant:'controlled spoken answer',interrupted:false,speaker:'owner',route:'front_only'},audio.promise)):[]);
  f.setSessionState('terminal');
  await assert.rejects(runtime.authenticate(f.authority.credentialForBootstrap(f.input)),/SOURCE_BINDING_INACTIVE/);
  audio.resolve({status:'rejected',reason:new Error('CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE')});await pending;
  await Promise.allSettled([call.close('inactive-seal','disconnected')]);
  await Promise.allSettled([call.closeAll()]);
  const events=await Promise.all((await storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-events',key)).toString())));
  const turns=events.filter(d=>d.content.app_event?.kind==='voice_turn');
  assert.equal(turns.length,tail?1:0,'already spoken text survives the delayed audio finalization');
  assert.equal(mirrored,tail?1:0);
  if(tail)assert.deepEqual(runtime.timeline!.page('actual-owner').items.map(item=>item.text),['controlled spoken turn','controlled spoken answer']);
  const closed=events.filter(d=>d.content.app_event?.kind==='call_closed');
  assert.equal(closed.length,1,'server-owned call close must outlive transport authorization');
  assert.equal(closed[0].content.app_event.call_id,'inactive-seal');
  assert.equal(closed[0].content.app_event.reason,'disconnected');
  assert.deepEqual(closed[0].content.app_event.processed_event_ids,turns.map(d=>d.processed_event_id));
});
