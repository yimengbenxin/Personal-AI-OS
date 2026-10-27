// Voiceprint authority end to end through the actual Processor, archive, Runtime and Admission: who may write memory, what
// run scope Hermes is asked to enforce, which D fields can carry identity, and the "确认是我" re-admission.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, rename } from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createServer} from 'node:net';
import {HermesClient} from '../src/hermes-client.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAIOSRuntime, RunAdmission, type NativeClient } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { digest, EVENT_SCHEMA, guestKey, principalAttribution, runScope, sha256, validateProcessed, voiceEvidence, type ProcessedEvent, type RawEvent,
  type TimeRange, type TrustedContext } from '../src/contracts.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { StreamArchive, type TrackChunk } from '../src/stream-archive.ts';
import { MediaProcessor, type Capability, type WorkerPort, type WorkerRequest } from '../src/media/processing.ts';
import { MediaService } from '../src/media/service.ts';
import { selectedAudioTimeline } from '../src/media/sample-timeline.ts';
import { finalizeSampleTranscription, sampleInput, type SampleAudioResult } from '../src/media/sample-results.ts';
import { VoiceConfirmations, type CapabilityUpgradeRequest } from '../src/voiceprint/confirmation.ts';
import {OwnerOverride,createOwnerOverrideSecret} from '../src/owner-override.ts';
import { HealthStore } from '../src/health/store.ts';
import { ContactsStore } from '../src/contacts/store.ts';
import { CareAuthority } from '../src/care/authority.ts';
import { DatabaseSync } from 'node:sqlite';
import { alignSegment, type ClockMap } from '../src/media/align.ts';
import type { AudioConsumption } from '../src/media/audio-consumption.ts';
import {PHONE_CAPABILITIES,GLASSES_CAPABILITIES,StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {fileURLToPath} from 'node:url';

const trusted: TrustedContext = {principal_id: 'owner', device_id: 'glasses', device_type: 'glasses', consent_ref: 'fixture',
  channel: 'fixture', submission: 'observation'};
const location = {latitude: 31.23, longitude: 121.47, accuracy_m: 20, observed_at: '2026-10-01T00:00:00.000Z', datum: 'wgs84' as const};
const SAMPLES = 19200, pcm = Buffer.alloc(SAMPLES * 2);
for (let n = 0; n < SAMPLES; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 10) * 12000), n * 2);
const raw: RawEvent = {schema_version: EVENT_SCHEMA, event_id: 'stream', device_id: 'glasses', device_type: 'glasses',
  captured_at: '2026-10-01T00:00:00.000Z', source: {channel: 'fixture', location}, media_type: 'livekit_tracks', mime: 'audio/pcm',
  representation: 'received_decoded_sample', payload: pcm};
const chunk: TrackChunk = {track_id: 'mic', stream_epoch: 'epoch', seq: 0, modality: 'audio', format: 'pcm_s16le:16000:1',
  source_range: {kind: 'interval', timebase_id: 'capture', stream_epoch: 'epoch', start_ms: 0, end_ms: 1200}};
const maps: ClockMap[] = [{modality: 'audio', track_id: 'mic', stream_epoch: 'epoch', source_timebase_id: 'capture',
  target_timebase_id: 'common', offset_ms: 0, drift_ppm: 0, uncertainty_ms: 1, basis_ref: 'clock:fixture-unverified'}];
const window: TimeRange = {kind: 'interval', timebase_id: 'common', start_ms: 0, end_ms: 1200};
const voiceprint: Capability = {id: 'local-sherpa-audio', version: 'fixture', modalities: ['audio'], formats: ['pcm_s16le:16000:1'],
  joint_av: false, healthy: true, permitted: true, max_duration_ms: 5000, execution: 'local', evidence: 'real_verified',
  speaker_identity: 'local_voiceprint'};
type Segment = SampleAudioResult['segments'][number];
function result(request: WorkerRequest, segments: Segment[], capability = voiceprint): SampleAudioResult {
  return {schema: 'paios.media.audio-sample-result.v1', kind: 'transcription', ...sampleInput(selectedAudioTimeline(request)[0]!),
    model: {id: capability.id, version: capability.version, device: 'cpu'}, raw_text: '依米，帮我叫车回家', segments};
}
const whole = (speaker?: string, speaker_score?: number): Segment[] => [{start_sample: 0, end_sample_exclusive: SAMPLES, text: '依米，帮我叫车回家',
  ...(speaker ? {speaker} : {}), ...(speaker_score !== undefined ? {speaker_score} : {})}];

async function approvalFixture(t:test.TestContext,timeout=8,scheduled=false,controlledClock=false) {
  let fixtureRuntime:PersonalAIOSRuntime|undefined;
  const directory=await realpath(await mkdtemp(join(tmpdir(),'paios-native-approval-'))),home=join(directory,'native');await mkdir(home);
  const source=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT ?? '/opt/personal-aios-runtime/hermes-agent';
  const python=process.env.PAIOS_HERMES_PYTHON ?? '/opt/personal-aios-runtime/hermes-agent/.venv/bin/python';
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const key='isolated-approval-fixture-key',settings=join(directory,'settings.json');
  const approvalClock=join(directory,'approval-clock');
  if(controlledClock)await writeFile(approvalClock,String(Date.now()));
  await writeFile(settings,JSON.stringify({key,port,...(controlledClock?{approval_clock:approvalClock}:{})}));
  await writeFile(join(home,'config.yaml'),`approvals:\n  timeout: ${timeout}\n  mode: manual\npersonal_aios:\n  grantable_toolsets: [desktop, terminal, file]\n`);
  const child=spawn(python,[fileURLToPath(new URL('./native-run-fixture.py',import.meta.url)),home,'--approval-http',settings],{
    cwd:source,env:{...process.env,PYTHONPATH:source,PAIOS_NATIVE_CONTRACT_SOURCE_ROOT:source,HERMES_HOME:home,
      HERMES_EXEC_ASK:'1',PYTHONDONTWRITEBYTECODE:'1',TMPDIR:directory,API_SERVER_HOST:'127.0.0.1',API_SERVER_PORT:String(port)},
    stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',d=>{log+=String(d);});child.stderr.on('data',d=>{log+=String(d);});
  t.after(async()=>{try{await fixtureRuntime?.close();}finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    await rm(directory,{recursive:true,force:true});}});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log)),30000);
    child.stdout.on('data',()=>{if(log.includes('"ready": true')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Native fixture exited ${code}: ${log}`));});});
  const native=new HermesClient(`http://127.0.0.1:${port}`,key,10000,1048576,home),storage=new PosixStorage(join(directory,'central'));
  const archive=new RawArchive(storage,8192),admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,
    max_event_age_ms:100000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'native-approval'});
  const notices:string[]=[],devices=['owner','foreign'].map(principal_id=>({principal_id,device_id:`${principal_id}-phone`,device_type:'phone' as const,
    channel:'fixture',consent_ref:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256(principal_id)}));
  if(scheduled)devices.push({...devices[0]!,channel:'background_scheduled',token_sha256:sha256('scheduled-owner')});
  const sourceAuthority=Object.assign(new StaticFixtureDeviceAuthority(devices),{
    scheduled:async()=>sourceAuthority.authenticate('scheduled-owner')
  });
  const runtime=fixtureRuntime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),sourceAuthority,
    skill:'isolated model approval decision',max_read_bytes:8192,notify:async({body})=>{notices.push(body);}});
  const phone=await runtime.authenticate('owner'),foreign=await runtime.authenticate('foreign');
  const wait=async<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>=>{const deadline=performance.now()+20000;
    for(;;){const value=await read();if(done(value))return value;assert.ok(performance.now()<deadline,`native approval did not settle: ${log}`);
      await new Promise(resolve=>setTimeout(resolve,20));}};
  let sequence=0;
  const submit=async(question:string)=>{const session=`approval-${++sequence}`;
    await runtime.submit({schema_version:EVENT_SCHEMA,event_id:`event-${sequence}`,device_id:phone.device_id,device_type:'phone',
      captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from(JSON.stringify({question}))},phone,session,true);return session;};
  const pending=()=>wait(()=>runtime.voiceConfirmations(phone),rows=>rows.some(row=>row.kind==='native_approval'));
  const run=async(session:string)=>{const binding=await wait(async()=>{
    for(const key of await storage.list('run-bindings')){const binding=JSON.parse(Buffer.from(await storage.read('run-bindings',key)).toString());
      if(binding.session_id===session)return binding as {run_id:string};}return undefined;},value=>value!==undefined);
    return native.status(binding!.run_id,{conversation_session_id:session});};
  const expireApproval=async()=>{
    // The native waiter must have captured its deadline before either clock advances.
    await wait(async()=>log,value=>value.includes('"approval_wait_observed": true'));
    const elapsed=timeout*1000;
    await writeFile(approvalClock+'.next',String(Date.now()+elapsed));await rename(approvalClock+'.next',approvalClock);
    t.mock.timers.tick(elapsed);
  };
  return {runtime,native,admission,storage,phone,foreign,notices,submit,pending,wait,run,expireApproval,log:()=>log};
}

test('I18 REVIEW: owner-created scheduled runtime denies the real native approval waiter without a phone card',{timeout:30000},async t=>{
  const f=await approvalFixture(t,60,true),views:unknown[][]=[];
  const ownerSession=await f.submit('Set up the recurring owner task'),[setupApproval]=await f.pending();
  const ownerRun=await f.run(ownerSession);
  const ownerEntry=f.admission.find(ownerRun.run_id,ownerSession);assert.ok(ownerEntry);
  const origin_processed_event_id=ownerEntry.d.processed_event_id;
  await f.runtime.confirmVoice(f.phone,{confirmation_id:setupApproval!.confirmation_id,choice:'deny'});
  await f.wait(()=>f.run(ownerSession),run=>run.status==='completed');
  const existingConfirmations=await f.storage.list('voice-confirmations');f.notices.length=0;
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{views.push(rows);},error=>assert.fail(String(error))));
  const started=Date.now(),task=await f.runtime.scheduledTask({principal_id:'owner',device_id:f.phone.device_id,
    job_id:'scheduled-approval',occurrence_id:'once',captured_at:new Date().toISOString(),
    origin_processed_event_id,prompt:JSON.stringify({question:'Synthetic scheduled first trash consent'}),skills:['desktop-assistant']});
  const {principal_id,session_id,processed_event_id}=task.admission;
  const done=await f.wait(()=>f.run(session_id),run=>run.status==='completed');
  assert.ok(Date.now()-started<20000,'scheduled approval must finish before its 60-second timeout');
  assert.deepEqual(done.granted_toolsets?.slice().sort(),['desktop','file','terminal']);
  assert.deepEqual(done.approval_results?.map(row=>[row.choice,row.reason]),[['deny','resolved']]);
  assert.deepEqual(JSON.parse(done.output!),{approved:false,simulated_effect:false});
  await f.wait(()=>f.admission.readOnly(principal_id,session_id,processed_event_id),record=>record?.state==='completed');
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.ok(views.every(rows=>rows.length===0));assert.deepEqual(f.notices,[]);
  assert.deepEqual(await f.storage.list('voice-confirmations'),existingConfirmations);
});

test('real native approval reaches owner phone and background notice; approve resumes the same run and the next action asks again', {timeout:60000},async t=>{
  const f=await approvalFixture(t),views:unknown[][]=[];
  const stop=await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{views.push(rows);},error=>assert.fail(String(error)));t.after(stop);
  const question='要把这条消息发给妈妈吗？',session=await f.submit(question);
  const [pending]=await f.pending();
  assert.equal(pending!.text,question);assert.equal(pending!.kind,'native_approval');
  const contexts=await Promise.all((['owner','guest','owner_uncertain','pending',undefined] as const).map(scope=>
    f.runtime.callContext(f.phone,session,undefined,undefined,undefined,scope)));
  assert.deepEqual(contexts.map(context=>context.includes(pending!.text!)),[true,false,false,false,false]);
  await f.wait(async()=>f.notices,rows=>rows.some(text=>text.includes(question)));
  t.after(await f.runtime.watchCare(f.phone,async()=>true));
  await f.wait(async()=>views,rows=>rows.some(row=>row.some(item=>(item as {text?:string}).text?.includes(question))));
  assert.deepEqual(await f.runtime.voiceConfirmations(f.foreign),[]);
  await assert.rejects(f.runtime.confirmVoice(f.foreign,{confirmation_id:pending!.confirmation_id,choice:'approve'}),/SCOPE_DENIED/);
  const before=await f.run(session);assert.equal(before.status,'waiting_for_approval');
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,choice:'approve'});
  assert.ok('approval' in confirmed && 'confirmed_at' in confirmed.approval && typeof confirmed.approval.confirmed_at==='string');
  assert.deepEqual(confirmed,{approval:{confirmation_id:pending!.confirmation_id,choice:'approve',
    confirmed_by:'owner',surface:{device_id:'owner-phone',device_type:'phone'},confirmed_at:confirmed.approval.confirmed_at}});
  assert.ok(Number.isFinite(Date.parse(confirmed.approval.confirmed_at)));
  const done=await f.wait(()=>f.run(session),run=>run.status==='completed');assert.equal(done.run_id,before.run_id);
  assert.deepEqual(JSON.parse(done.output!),{approved:true,simulated_effect:true});
  assert.deepEqual(done.approval_results?.map(row=>[row.question,row.choice,row.reason]),[[pending!.text,'once','resolved']]);
  await f.wait(()=>f.runtime.voiceConfirmations(f.phone),rows=>rows.length===0);
  assert.equal((await f.storage.list('voice-confirmations')).length,1);
  assert.equal((await f.storage.list('voice-confirmation-decisions')).length,1);
  const second=await f.submit('再发一次给妈妈可以吗？'),[renew]=await f.pending();
  assert.notEqual(renew!.confirmation_id,pending!.confirmation_id);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:renew!.confirmation_id,choice:'deny'});
  assert.equal((await f.wait(()=>f.run(second),run=>run.status==='completed')).approval_results?.at(-1)?.choice,'deny');
  for(const restricted of [{run_scope:'guest' as const,guest_key:'speaker:3:fixture'},{care_decision:true as const}]){
    const session=`restricted-${'run_scope' in restricted?'guest':'care'}`;
    const accepted=await f.native.create({input:JSON.stringify({question:'不能向客人索取主人授权'}),
      instructions:'controlled turn',session_id:session,...restricted},session);
    const result=await f.wait(()=>f.native.status(accepted.run_id,{conversation_session_id:session}),run=>run.status==='completed');
    assert.equal(result.output,'scope denied');assert.equal(result.approval,undefined);
    assert.equal(result.approval_results?.length??0,0);
  }
});

for(const choice of ['deny','timeout'] as const)test(`real native ${choice} settles and each simulated action requires a fresh answer`,{timeout:60000},async t=>{
  if(choice==='timeout')t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=await approvalFixture(t,choice==='timeout'?2:8,false,choice==='timeout'),session=await f.submit('这次模拟操作可以吗？'),[pending]=await f.pending();
  if(choice==='deny')await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,choice:'deny'});
  else await f.expireApproval();
  const done=await f.wait(()=>f.run(session),run=>run.status==='completed');
  assert.equal(done.approval_results?.at(-1)?.reason,choice==='deny'?'resolved':'timeout');
  assert.equal(done.approval_results?.at(-1)?.choice,'deny');
  assert.deepEqual(JSON.parse(done.output!),{approved:false,simulated_effect:false});
  await f.wait(()=>f.runtime.voiceConfirmations(f.phone),rows=>rows.length===0);
  await f.wait(()=>f.storage.list('voice-confirmation-decisions'),keys=>keys.includes(pending!.confirmation_id));
  const decision=JSON.parse(Buffer.from(await f.storage.read('voice-confirmation-decisions',pending!.confirmation_id)).toString());
  assert.deepEqual([decision.source,decision.choice,decision.reason],['native','deny',choice==='deny'?'resolved':'timeout']);
  const observed:string[]=[],stop=await f.runtime.watchCare(f.phone,async()=>true,undefined,async text=>{observed.push(text);return true;},()=>true);t.after(stop);
  const second=await f.submit('再次模拟操作可以吗？'),[again]=await f.pending();
  assert.notEqual(again!.confirmation_id,pending!.confirmation_id);
  await f.wait(async()=>observed,rows=>rows.some(text=>text.includes('再次模拟操作可以吗？')));
  await f.runtime.confirmVoice(f.phone,{confirmation_id:again!.confirmation_id,choice:'approve'});
  assert.equal((await f.wait(()=>f.run(second),run=>run.status==='completed')).approval_results?.at(-1)?.choice,'once');
  await f.wait(()=>f.runtime.voiceConfirmations(f.phone),rows=>rows.length===0);
  const third=await f.submit('第三次模拟操作可以吗？'),[fresh]=await f.pending();
  assert.notEqual(fresh!.confirmation_id,again!.confirmation_id);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:fresh!.confirmation_id,choice:'deny'});
  assert.equal((await f.wait(()=>f.run(third),run=>run.status==='completed')).approval_results?.at(-1)?.choice,'deny');
});

async function fixture(t: test.TestContext, segments: Segment[] | (() => WorkerPort), options: {time_zone?:string;directed?: boolean; override?:boolean; capability?: Capability; ttl_ms?: number; finish?: boolean; owner_data?: boolean; care?: boolean;realtime_busy?:()=>boolean;capability_grants?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['capability_grants']} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paios-voiceprint-authority-'));
  const storage = new PosixStorage(directory);
  const ownerOverride=new OwnerOverride({storage,secret_root:directory,ttl_s:0});t.after(()=>ownerOverride.close());
  if(options.override){await writeFile(join(directory,'owner-override.json'),JSON.stringify(await createOwnerOverrideSecret('fixture override')),{mode:0o600});await ownerOverride.enable('phone','fixture override');}
  const budget = {max_chunk_bytes: 50000, max_total_bytes: 200000, max_chunks: 20, max_revisions: 20, max_seq: 20};
  const archive = new RawArchive(storage, 50000, undefined, budget), streamArchive = new StreamArchive(storage, budget);
  const capability = options.capability ?? voiceprint;
  const worker: WorkerPort = typeof segments === 'function' ? segments() : {analyze: async request => result(request, segments, capability)};
  const processor = new MediaProcessor(storage, new Map([[capability.id, worker]]), {policy_version: 'voiceprint-fixture', max_inflight: 2,
    max_input_bytes: 200000, timeout_ms: 2000, allow_external: false, allow_replay: true, allow_partial: true});
  const service = new MediaService({storage, archive, streamArchive, processor, capabilities: async () => [capability],
    vad: {candidates: async () => [{start_ms: 0, end_ms: 1200, semantic_status: 'open', basis: 'controlled'}]},
    align: {max_chunks: 20, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 2}, max_segments: 4, max_window_ms: 5000, fixtureOnly: true});
  const bodies: {input: string; session_id: string;  run_scope?: string; guest_key?: string}[] = [];
  const native: NativeClient = {create: async (body, key) => {bodies.push(structuredClone(body)); return {run_id: `run-${sha256(key).slice(0, 12)}`,
    session_id: body.session_id, conversation_session_id: body.session_id, status: 'running'};},
    status: async id => ({run_id: id, session_id: 'session', conversation_session_id: 'session', status: options.finish ? 'completed' : 'running'}),
    cancel: async id => ({run_id: id, session_id: 'session', conversation_session_id: 'session', status: 'cancelled'})};
  const admission = new RunAdmission(storage, native, {max_pending_events: 8, max_pending_bytes: 1000000, max_event_age_ms: 100000,
    poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'controlled'});
  const device = (principal_id: string, device_id: string, device_type: 'glasses' | 'phone', token: string) =>
    ({principal_id, device_id, device_type, capabilities:device_type==='phone'?PHONE_CAPABILITIES:[...GLASSES_CAPABILITIES.filter(c=>c!=='wear_state'),'location' as const], consent_ref: 'fixture', channel: 'fixture', route_version: 'route', output_modes: ['text'], token_sha256: sha256(token)});
  const health = options.owner_data ? HealthStore.open(join(directory, 'health')) : undefined;
  const contacts = options.owner_data ? ContactsStore.open(join(directory, 'contacts')) : undefined;
  const notices: string[] = [], care = options.care ? CareAuthority.open(join(directory, 'care')) : undefined;
  const runtime = new PersonalAIOSRuntime({...(options.time_zone?{time_zone:options.time_zone}:{}),storage, archive, admission, native, output: new OutputAuthority(storage), media: service,owner_override:ownerOverride,
    ...(options.realtime_busy?{realtime_busy:options.realtime_busy}:{}),
    ...(options.capability_grants?{capability_grants:options.capability_grants}:{}),
    ...(health ? {health} : {}), ...(contacts ? {contacts} : {}), ...(care ? {care, notify: async ({body}: {body: string}) => {notices.push(body);}} : {}),
    devices: [device('owner', 'glasses', 'glasses', 'glasses-token'), device('owner', 'phone', 'phone', 'phone-token'),
      device('stranger', 'their-phone', 'phone', 'stranger-token'),
      ...(options.capability_grants?[false,true].map(unlock=>({...device('owner',unlock?'trusted-mac':'mac','phone',unlock?'trusted-mac-token':'mac-token'),
        device_type:'mac' as const,capabilities:unlock?['chat_ui','owner_unlock'] as const:['chat_ui'] as const})):[])],
    skill: 'controlled', max_read_bytes: 1000000, ...(options.ttl_ms ? {voice_confirmation: {ttl_ms: options.ttl_ms}} : {}),
    audio_route: async () => ({consumer: 'media', source_scope: 'continuity', capture_span: 'span', purpose_evidence_ref: 'evidence'})});
  t.after(async () => {await runtime.close(); await processor.close(); health?.close(); contacts?.close(); await rm(directory, {recursive: true, force: true});});
  const glasses = await runtime.authenticate('glasses-token'), phone = await runtime.authenticate('phone-token');
  const stranger = await runtime.authenticate('stranger-token');
  const heard = async () => {
    const archived = await runtime.appendMedia(options.care ? {...raw,captured_at:new Date().toISOString()} : raw, glasses, chunk);
    if(options.directed){
      t.after(await runtime.watchAmbientTurns(glasses,'session',()=>{}));
      const record=await archive.readRecord(archived.event.raw_ref,glasses.principal_id,archived.event.archive_revision,{maxReadBytes:50000});
      assert.equal(record.kind,'stream');if(record.kind!=='stream')throw new Error('stream fixture required');
      const aligned=await alignSegment(archived.event,record.manifest,window,'wake_turn',maps,storage,
        {max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2});
      const request=await processor.prepareRequest(aligned.segment,aligned.views);
      const owner=(runtime as unknown as {audioConsumers:AudioConsumption}).audioConsumers;
      await owner.select(archived.event,'finite',{consumer:'media',source_scope:'continuity',capture_span:'span',purpose_evidence_ref:'evidence'});
      const observed=await owner.consume(archived.event,request,'finite',async accept=>({status:'processed',
        processed_events:[await processor.process(aligned.segment,aligned.views,[capability],1,null,undefined,accept)],
        warnings:[],archive_revision:archived.event.archive_revision}),value=>value.processed_events,'media','wake_turn');
      const directed=await processor.request(observed.processed_events[0]!,{kind:'ambient_wake',text:'依米，帮我叫车回家',heard_at:raw.captured_at});
      const event=await (runtime as unknown as {admitProcessed(d:ProcessedEvent,source:typeof glasses,session:string):ReturnType<PersonalAIOSRuntime['submit']>}).admitProcessed(directed,glasses,'session');
      return {processed_events:[directed],events:[event]};
    }
    return runtime.processMedia(glasses, 'session', 'op', {raw_ref: archived.event.raw_ref, archive_revision: archived.event.archive_revision,
      time_range: window, clock_maps: maps});
  };
  const until = async (count: number) => {for (let i = 0; i < 400 && bodies.length < count; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(bodies.length, count);};
  return {directory, storage, archive, runtime, processor, admission, glasses, phone, stranger, bodies, heard, until, notices};
}

test('owner-verified speech is the principal\'s own request: attributable, owner scope, memory writes allowed', async t => {
  const f = await fixture(t, [{...whole('owner', 0.82)[0]!, end_sample_exclusive: 9600}, {start_sample: 9600, end_sample_exclusive: SAMPLES, speaker: 'owner', speaker_score: 0.71}]);
  const {processed_events: [d], events: [event]} = await f.heard();
  assert.deepEqual(d!.speakers, [{identity_scope: 'local_voiceprint', voiceprint: 'owner', score: 0.71, speech_ms: 1200, segments: 2}]);
  assert.deepEqual([d!.user_identity, principalAttribution(d!), runScope(d!)], ['owner', 'owner_voice', 'owner']);
  assert.equal(await f.archive.validateEvidence(d!), true);
  assert.equal(event!.voice_confirmation, undefined);
  await f.until(1);
  assert.equal(Object.hasOwn(f.bodies[0]!,'memory_write'),false); assert.equal(f.bodies[0]!.run_scope, undefined);
  assert.deepEqual(JSON.parse(f.bodies[0]!.input).source.location, location);
});

test('uncertain owner: chat-only owner_uncertain scope without location, a pending "确认是我" on a paired display terminal', async t => {
  const f = await fixture(t, whole('owner_uncertain', 0.52), {directed:true});
  const stopPhone=await f.runtime.watchCare(f.phone,async()=>true),stopGlasses=await f.runtime.watchCare(f.glasses,async()=>true);
  t.after(()=>{stopPhone();stopGlasses();});await f.runtime.ownerInput(f.phone);
  const {processed_events: [d], events: [event]} = await f.heard();
  assert.deepEqual([d!.user_identity, principalAttribution(d!), runScope(d!)], ['unknown', null, 'owner_uncertain']);
  assert.equal(f.runtime.activeTerminal(f.phone),true,'uncertain glasses speech cannot move owner outreach');
  assert.equal(f.runtime.activeTerminal(f.glasses),false);
  await f.until(1);
  assert.deepEqual([Object.hasOwn(f.bodies[0]!,'memory_write'), f.bodies[0]!.run_scope, f.bodies[0]!.guest_key], [false, 'owner_uncertain', undefined]);
  assert.equal(JSON.parse(f.bodies[0]!.input).source.location, undefined);
  assert.ok(event!.voice_confirmation);
  assert.deepEqual(JSON.parse(f.bodies[0]!.input).voice_confirmation,event!.voice_confirmation);
  const pending = await f.runtime.voiceConfirmations(f.phone);
  assert.deepEqual(pending.map(p => [p.confirmation_id, p.processed_event_id, p.session_id]),
    [[event!.voice_confirmation!.confirmation_id, d!.processed_event_id, 'session']]);
  await assert.rejects(f.runtime.voiceConfirmations(f.glasses),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  assert.deepEqual(await f.runtime.voiceConfirmations(f.stranger), []);
});

test('unaddressed ambient speech never opens identity cards for uncertain, unknown or guest speakers',async t=>{
  for(const speaker of ['owner_uncertain',undefined,'speaker:3']){
    const f=await fixture(t,whole(speaker,speaker?0.52:undefined));
    const {processed_events:[d],events:[event]}=await f.heard();await f.until(1);
    assert.equal(d!.segment_basis,'speech_candidate');
    assert.equal(d!.content.wake_request,undefined);
    assert.equal(event!.voice_confirmation,undefined);
    assert.equal(JSON.parse(f.bodies[0]!.input).voice_confirmation,null);
    assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
    assert.deepEqual(await f.storage.list('voice-confirmations'),[]);
  }
});

test('confirmation guidance carries no card when publication fails or the card expires before native admission',async t=>{
  for(const mode of ['failed','expired'] as const){
    const f=await fixture(t,whole('owner_uncertain',0.52),{directed:true,ttl_ms:mode==='expired'?20:120000});
    const publish=f.storage.publish.bind(f.storage);
    f.storage.publish=async(namespace,key,bytes)=>{
      if(mode==='failed'&&namespace==='voice-confirmations')throw Object.assign(new Error('fixture confirmation unavailable'),{code:'EIO'});
      return publish(namespace,key,bytes);
    };
    if(mode==='expired'){
      const admit=f.admission.admit.bind(f.admission);
      t.mock.method(f.admission,'admit',async(...args:Parameters<typeof admit>)=>{
        await new Promise(resolve=>setTimeout(resolve,40));return admit(...args);
      });
    }
    await f.heard();await f.until(1);
    assert.equal(f.bodies[0]!.run_scope,'owner_uncertain');
    assert.equal(JSON.parse(f.bodies[0]!.input).voice_confirmation,null,mode);
    assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  }
});

test('another voice, unattributed speech and model-local labels are guests in an isolated per-speaker session', async t => {
  for (const [segments, label] of [[whole('speaker:3', 0.9), 'speaker:3'], [whole(), 'unknown'],
    [[...whole('owner', 0.9).map(s => ({...s, end_sample_exclusive: 16000})), {start_sample: 16000, end_sample_exclusive: SAMPLES, speaker: 'speaker:4'}], null]] as const) {
    const f = await fixture(t, [...segments]);
    const {processed_events: [d]} = await f.heard();
    await f.until(1);
    if (label === null) {
      // Owner speech mixed with another voice: who asked is not certain, so sensitive tools wait for the phone.
      assert.equal(runScope(d!), 'owner_uncertain'); assert.equal(f.bodies[0]!.run_scope, 'owner_uncertain'); continue;
    }
    assert.deepEqual([d!.user_identity, principalAttribution(d!), runScope(d!)], ['unknown', null, 'guest']);
    assert.deepEqual([Object.hasOwn(f.bodies[0]!,'memory_write'), f.bodies[0]!.run_scope], [false, 'guest']);
    assert.equal(JSON.parse(f.bodies[0]!.input).voice_confirmation,null);
    assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
    assert.equal(f.bodies[0]!.guest_key, guestKey(d!)); assert.match(f.bodies[0]!.guest_key!, new RegExp(`^${label}:\\d{4}-\\d{2}-\\d{2}$`, 'u'));
  }
  // The pre-voiceprint path (no speaker_identity capability) keeps model-local labels: 'owner' there names nobody.
  const {speaker_identity: _flag, ...unflagged} = voiceprint;
  const moss = await fixture(t, whole('owner', 0.99), {capability: {...unflagged, id: 'local-moss-audio'}});
  const {processed_events: [d]} = await moss.heard();
  assert.deepEqual(d!.speakers, [{model_local_label: 'owner', user_identity: 'unknown', identity_scope: 'model_local'}]);
  assert.equal(runScope(d!), 'guest');
});

test('依米\'s own voice heard back is never the owner: alone it is assistant speech in guest scope, beside the owner it is doubt', async t => {
  const alone = await fixture(t, whole('assistant', 0.8));
  const {processed_events: [d]} = await alone.heard();
  assert.deepEqual(d!.speakers, [{identity_scope: 'local_voiceprint', voiceprint: 'assistant', score: 0.8, speech_ms: 1200, segments: 1}]);
  assert.deepEqual([voiceEvidence(d!), d!.user_identity, principalAttribution(d!), runScope(d!)], ['assistant', 'unknown', null, 'guest']);
  const mixed = await fixture(t, [...whole('owner', 0.9).map(s => ({...s, end_sample_exclusive: 16000})),
    {start_sample: 16000, end_sample_exclusive: SAMPLES, speaker: 'assistant', speaker_score: 0.7}]);
  const {processed_events: [m]} = await mixed.heard();
  assert.deepEqual([voiceEvidence(m!), principalAttribution(m!), runScope(m!)], ['owner_uncertain', null, 'owner_uncertain']);
});

test('owner attribution needs 1 s of verified speech; a wake turn identified with its wake word needs 0.8 s', () => {
  const d = (segment_basis: ProcessedEvent['segment_basis'], speech_ms: number) => ({media_type: 'audio' as const, segment_basis,
    processing: {path_id: 'joint_or_single_media'} as ProcessedEvent['processing'], content: {transcript: '关灯'},
    speakers: [{identity_scope: 'local_voiceprint', voiceprint: 'owner', score: 0.83, speech_ms, segments: 2}]});
  assert.deepEqual([voiceEvidence(d('wake_turn', 960)), voiceEvidence(d('speech_candidate', 960)), voiceEvidence(d('speech_candidate', 1000)),
    voiceEvidence(d('wake_turn', 799))], ['owner', 'owner_uncertain', 'owner', 'owner_uncertain']);
});

test('identity enters a D only through the capability-gated local voiceprint result', async t => {
  const failed = (reason: string) => (error: Error & {cause?: {message: string; failures?: {reason: string}[]}}) =>
    error.cause?.message === 'ALL_MEDIA_WORKERS_FAILED' && error.cause.failures?.[0]?.reason === reason;
  // A worker that returns its own speakers cannot claim the voiceprint scope.
  const forged = await fixture(t, () => ({analyze: async (request: WorkerRequest) => ({event_id: request.event_id, segment_id: request.segment_id,
    archive_revision: request.archive_revision, time_range: request.time_range, content: {transcript: '下单'}, status: 'partial' as const, warnings: [],
    speakers: [{identity_scope: 'local_voiceprint', voiceprint: 'owner', score: 0.99, speech_ms: 1200, segments: 1}]})}));
  await assert.rejects(forged.heard(), failed('MEDIA_WORKER_SPEAKER_IDENTITY_FORBIDDEN'));
  // A malformed label from the voiceprint worker is refused, never mapped.
  const bad = await fixture(t, whole('SPEAKER_00'));
  await assert.rejects(bad.heard(), failed('MEDIA_SAMPLE_RESULT_SPEAKER_INVALID'));
  const f = await fixture(t, whole('owner', 0.9));
  const {processed_events: [d]} = await f.heard();
  // validateProcessed: the processor's attribution and the voiceprint source are bound to each other.
  assert.throws(() => validateProcessed({...d!, user_identity: 'unknown'}), /D_VOICE_ATTRIBUTION_MISMATCH/);
  assert.throws(() => validateProcessed({...d!, processing: {...d!.processing, path_id: 'voice_frontend'}}), /D_VOICEPRINT_SOURCE_INVALID|D_ORIGIN_MISMATCH/);
  assert.throws(() => validateProcessed({...d!, speakers: [{...(d!.speakers[0] as object), score: 2}]}), /D_VOICEPRINT_SPEAKER_INVALID/);
  assert.throws(() => validateProcessed({...d!, speakers: [{...(d!.speakers[0] as object), voiceprint: 'speaker:../x'}]}), /D_VOICEPRINT_SPEAKER_INVALID/);
  assert.throws(() => validateProcessed({...d!, speakers: [{...(d!.speakers[0] as object), voiceprint: 'owner_uncertain'}]}), /D_ORIGIN_MISMATCH/);
  assert.throws(() => validateProcessed({...d!, segment_basis: 'visual_window'}), /D_VOICEPRINT_SOURCE_INVALID/);
  // A typed or app D has no speakers at all; a client cannot present a voice confirmation through observations.
  const ingress = new UnifiedIngress(f.archive);
  const appRaw = (kind: string): RawEvent => ({schema_version: EVENT_SCHEMA, event_id: `app-${kind}`, device_id: 'glasses', device_type: 'glasses',
    captured_at: '2026-10-01T00:00:00.000Z', source: {channel: 'fixture'}, media_type: 'app_event', mime: 'application/json',
    representation: 'uploaded_original', payload: Buffer.from(JSON.stringify({kind}))});
  await assert.rejects(ingress.accept(appRaw('voice_confirmation'), trusted), /VOICE_CONFIRMATION_PAYLOAD_INVALID/);
  await assert.rejects(ingress.accept(appRaw('note'), {...trusted, submission: 'owner_confirmation'}), /VOICE_CONFIRMATION_PAYLOAD_INVALID/);
  const app = await ingress.accept(appRaw('note'), trusted);
  assert.throws(() => validateProcessed({...app, speakers: d!.speakers}), /D_TEXT_CONTRACT_MISMATCH/);
});

test('non-owner sample results stay model-local even when a speaker_identity flag is set on an external capability', async t => {
  let captured: WorkerRequest | undefined;
  const probe = await fixture(t, () => ({analyze: async (request: WorkerRequest) => {captured = structuredClone(request); return result(request, whole('owner', 0.9));}}));
  await probe.heard();
  const external = finalizeSampleTranscription(result(captured!, whole('owner', 0.9)), captured!, {...voiceprint, execution: 'external'});
  assert.deepEqual(external.speakers, [{model_local_label: 'owner', user_identity: 'unknown', identity_scope: 'model_local'}]);
});

test('rollback context preserves the full voiceprint-attributed owner transcript beyond 4000 characters',async t=>{
  const words='换回原来的。'.repeat(700);
  const f=await fixture(t,()=>({analyze:async request=>({...result(request,whole('owner',0.9).map(segment=>({...segment,text:words}))),raw_text:words})}));
  const accepted=await f.heard(),d=accepted.processed_events[0]!;await f.until(1);
  assert.equal(principalAttribution(d),'owner_voice');assert.equal(d.content.transcript,words);
  let run:string|undefined;
  for(let i=0;i<400&&!(run=f.admission.get('owner','session',d.processed_event_id)?.run_id);i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(run);
  const context=await f.runtime.scheduleContext({run_id:run,session_id:'session',tool_call_id:'rollback-voice'});
  assert.deepEqual(Buffer.from(context.owner_request_text!),Buffer.from(words));
});

test('a guest run gets reply routing only; the owner keeps every host tool', async t => {
  for (const [segments, allowed] of [[whole('speaker:7', 0.9), false], [whole('owner_uncertain', 0.5), false], [whole('owner', 0.9), true]] as const) {
    const f = await fixture(t, [...segments]);
    await f.runtime.configureTimeline({directory:join(f.directory,'timeline')});
    await f.heard(); await f.until(1);
    const entry = [...(f.admission as unknown as {entries: Map<string, {record: {run_id?: string}}>}).entries.values()][0]!;
    for (let i = 0; i < 400 && !entry.record.run_id; i++) await new Promise(r => setTimeout(r, 5));
    const call = {context: {run_id: entry.record.run_id!, session_id: 'session', tool_call_id: 'tc-1'}, args: {}};
    if (allowed) assert.equal((await f.runtime.tool('paios_l5_locate', call) as {status: string}).status, 'located');
    else await assert.rejects(f.runtime.tool('paios_l5_locate', call), /RUN_SCOPE_TOOL_DENIED/);
    if(!allowed)await assert.rejects(f.runtime.tool('paios_desktop_queue',{...call,args:{action:'add',task:'forbidden'}}),/DESKTOP_QUEUE_OWNER_REQUIRED/);
    const opened = await f.runtime.tool('paios_open_reply', {...call, args: {reply_mode: 'text', target_aliases: ['source'], output_modes: ['text']}});
    assert.notEqual((opened as {error_code?: string}).error_code, 'RUN_SCOPE_TOOL_DENIED');
  }
});

test('health ingress keeps its page snapshot and receipt pending until realtime becomes idle',async t=>{
  let busy=true;
  const f=await fixture(t,whole('owner',0.9),{owner_data:true,realtime_busy:()=>busy});
  const batch={control_id:'deferred-health',metric:'restingHeartRate',unit:'count/min',tz:'UTC',sources:['Watch'],
    samples:[{id:'00000000-0000-4000-8000-000000000001',s:Date.now()-1000,e:Date.now()-500,src:0,v:61}],deleted:[]};
  let acknowledged=false;
  const receipt=f.runtime.ingestHealth(f.phone,batch,'session').then(value=>{acknowledged=true;return value;});
  batch.samples[0]!.v=99;
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(acknowledged,false);assert.ok(!(await f.runtime.callContext(f.phone,'session')).includes('61'));
  busy=false;assert.deepEqual(await receipt,{stored:1,deleted:0});
  assert.ok((await f.runtime.callContext(f.phone,'session')).includes('61'));
});

test('positive Watch fall bypasses a busy bulk page, commits before ACK and arms the existing care deadline',async t=>{
  let busy=true;
  const f=await fixture(t,whole('owner',0.9),{owner_data:true,care:true,realtime_busy:()=>busy});
  const now=Date.now(),sample={id:'00000000-0000-4000-8000-000000000001',s:now-1000,e:now-500,src:0,v:61};
  const bulk={control_id:'bulk-before-fall',metric:'restingHeartRate',unit:'count/min',tz:'UTC',sources:['Watch'],samples:[sample],deleted:[]};
  let bulkAck=false;const pending=f.runtime.ingestHealth(f.phone,bulk,'session').then(()=>{bulkAck=true;});
  try{
    const page={...bulk,control_id:'urgent-fall',metric:'numberOfTimesFallen',unit:'count',samples:[{...sample,id:'00000000-0000-4000-8000-00000000000f',v:1}]};
    assert.deepEqual(await f.runtime.ingestHealth(f.phone,page,'session'),{stored:1,deleted:0});
    const health=new DatabaseSync(join(f.directory,'health','health.sqlite'),{readOnly:true});
    try{assert.equal((health.prepare('SELECT value FROM samples WHERE metric=?').get('numberOfTimesFallen') as {value:number}).value,1);}finally{health.close();}
    for(let i=0;i<200&&!f.notices.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.match(f.notices[0]!,/手表说你可能摔倒了/);
    const care=new DatabaseSync(join(f.directory,'care','care.sqlite'),{readOnly:true});
    try{const event=care.prepare('SELECT state,due_ms FROM escalations').get() as {state:string;due_ms:number};
      assert.equal(event.state,'armed');assert.ok(event.due_ms>=now+60_000&&event.due_ms<=Date.now()+60_000);
    }finally{care.close();}
    assert.equal(bulkAck,false);
  }finally{busy=false;await pending;}
  assert.equal(bulkAck,true);assert.equal(f.bodies.length,0,'fall safety is deterministic; it starts no separate model care run');
});

test('health and contacts ingress bind the paired principal and only owner runs may query them', async t => {
  for (const speaker of ['owner', 'owner_uncertain', 'speaker:7']) {
    const f = await fixture(t, whole(speaker, speaker === 'owner_uncertain' ? 0.5 : 0.9), {owner_data: true,time_zone:'America/Los_Angeles'});
    const batch = {control_id: 'health-page', metric: 'restingHeartRate', unit: 'count/min', tz: 'UTC', sources: ['Watch'],
      samples: [{id: '00000000-0000-4000-8000-000000000001', s: Date.now() - 1000, e: Date.now() - 500, src: 0, v: 61}], deleted: []};
    assert.deepEqual(await f.runtime.ingestHealth(f.phone, batch, 'session'), {stored: 1, deleted: 0});
    assert.deepEqual(await f.runtime.ingestHealth(f.phone, batch, 'session'), {stored: 1, deleted: 0});
    await assert.rejects(f.runtime.ingestHealth(f.glasses, batch, 'session'), /HEALTH_DEVICE_REQUIRED/);
    await assert.rejects(f.runtime.ingestHealth({...f.phone, principal_id: 'stranger'}, batch, 'session'), /DEVICE_REGISTRY_BINDING_REQUIRED/);
    assert.ok((await f.runtime.callContext(f.phone, 'session')).includes('61'));
    assert.ok(!(await f.runtime.callContext(f.stranger, 'other-session')).includes('【身体】'));
    const cards = {control_id: 'contacts-page', contacts: [{id: 'card-1', name: '妈妈', phones: [{number: '5550100', label: '手机'}], relations: []}], deleted: []};
    assert.deepEqual(await f.runtime.ingestContacts(f.phone, cards), {stored: 1, deleted: 0});
    assert.deepEqual(await f.runtime.ingestContacts(f.phone, cards), {stored: 1, deleted: 0});
    await assert.rejects(f.runtime.ingestContacts(f.glasses, cards), /CONTACTS_DEVICE_REQUIRED/);
    await assert.rejects(f.runtime.ingestContacts({...f.phone, principal_id: 'stranger'}, cards), /DEVICE_REGISTRY_BINDING_REQUIRED/);
    await f.heard(); await f.until(1);
    const entry = [...(f.admission as unknown as {entries: Map<string, {record: {run_id?: string}}>}).entries.values()][0]!;
    for (let i = 0; i < 400 && !entry.record.run_id; i++) await new Promise(r => setTimeout(r, 5));
    const call = {context: {run_id: entry.record.run_id!, session_id: 'session', tool_call_id: 'health-query'}, args: {metric: 'resting_heart_rate'}};
    if (speaker === 'owner') {
      const result=await f.runtime.tool('paios_health_query', call);
      assert.match(JSON.stringify(result), /61/);assert.equal((result as {tz:string}).tz,'America/Los_Angeles');
    }
    else await assert.rejects(f.runtime.tool('paios_health_query', call), /RUN_SCOPE_TOOL_DENIED/);
    const search = {...call, args: {relation: '妈妈'}};
    if (speaker === 'owner') {
      const result=await f.runtime.tool('paios_contacts_search', search);
      assert.match(JSON.stringify(result), /5550100/);
      assert.equal((result as {sync_completeness:string}).sync_completeness,'unknown');
    }
    else await assert.rejects(f.runtime.tool('paios_contacts_search', search), /RUN_SCOPE_TOOL_DENIED/);
  }
});

test('a Watch fall is a timeline observation with no proactive run; only the owner stands down the safety check-in', async t => {
  const fall = {control_id: 'fall-page', metric: 'numberOfTimesFallen', unit: 'count', tz: 'UTC', sources: ['Watch'],
    samples: [{id: '00000000-0000-4000-8000-00000000000f', s: Date.now() - 1500, e: Date.now() - 500, src: 0, v: 1}], deleted: []};
  for (const [speaker, stands] of [['speaker:3', false], ['owner_uncertain', false], ['owner', true], ['chat', true], ['button', true]] as const) {
    const f = await fixture(t, whole(speaker === 'chat' || speaker === 'button' ? 'owner' : speaker, speaker === 'owner_uncertain' ? 0.5 : 0.9),
      {owner_data: true, care: true});
    await f.runtime.configureTimeline({directory:join(f.directory,'timeline')});
    const shown: [string, string][] = [];
    if (speaker === 'chat') await f.runtime.watchCare(f.phone, async (id, text) => {shown.push([id, text]); return true;});
    await f.runtime.ingestHealth(f.phone, fall, 'session');await f.until(0);
    const care_id=`care:${digest(['owner',`fall:${fall.samples[0]!.id}`]).slice(0,24)}`;
    const observations=f.runtime.timeline!.observations('owner');
    assert.equal(observations.length,1);assert.match(observations[0]!.text,/手表检测到可能摔倒/u);
    // The check-in: in the chat while the phone shows it, else a phone notice.
    for (let i = 0; i < 200 && !shown.length && !f.notices.length; i++) await new Promise(r => setTimeout(r, 5));
    if (speaker === 'chat') assert.deepEqual([shown.map(s => s[0]), f.notices], [[`${care_id}:checkin`], []]);
    else assert.match(f.notices[0]!, /^你还好吗？手表说你可能摔倒了/u);
    if (speaker === 'chat') await f.runtime.submit({schema_version: EVENT_SCHEMA, event_id: 'reply', device_id: 'phone', device_type: 'phone',
      captured_at: new Date().toISOString(), source: {channel: 'fixture'}, media_type: 'text', mime: 'text/plain;charset=utf-8',
      representation: 'uploaded_original', payload: Buffer.from('没事，滑了一下')}, f.phone, 'session', true);
    else if (speaker === 'button') {await f.runtime.careSafe(f.phone);}
    else await f.heard();
    const db = new DatabaseSync(join(f.directory, 'care', 'care.sqlite'), {readOnly: true});
    assert.equal((db.prepare('SELECT state FROM escalations').get() as {state: string}).state, stands ? 'cancelled' : 'armed', speaker);
    db.close();
  }
});

test('archived call observations never reopen identity cards; the live call owns confirmation',async t=>{
  const f=await fixture(t,whole('owner_uncertain',.5),{finish:true});
  const submit=(speaker:string)=>f.runtime.submitCallTurn({schema_version:EVENT_SCHEMA,event_id:`call-${speaker.replace(':','-')}`,
    device_id:f.phone.device_id,device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'fixture'},
    media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify({kind:'voice_turn',call_id:'synthetic-call',turn:1,user:'synthetic request',assistant:'',speaker,route:'front_only'}))},f.phone,`call-${speaker}`);
  const uncertain=await submit('owner_uncertain');
  assert.equal(runScope(uncertain.processed_event),'owner_uncertain');
  assert.equal('voice_confirmation' in uncertain?uncertain.voice_confirmation:undefined,undefined);
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  for(const speaker of ['unknown','speaker:7']){
    const observed=await submit(speaker);
    assert.equal(runScope(observed.processed_event),'guest');assert.equal('voice_confirmation' in observed?observed.voice_confirmation:undefined,undefined);
  }
});

test('"确认是我": paired phone re-admits the uncertain request once as an owner-attributed confirmation', async t => {
  const f = await fixture(t, whole('owner_uncertain', 0.5), {directed:true,finish: true});
  await f.runtime.configureTimeline({directory:join(f.directory,'timeline')});
  const {processed_events: [d], events: [event]} = await f.heard();
  await f.until(1);
  assert.deepEqual(f.runtime.timeline!.page('owner').items,[],'unconfirmed voice is isolated');
  const confirmation_id = event!.voice_confirmation!.confirmation_id;
  await assert.rejects(f.runtime.confirmVoice(f.stranger, {confirmation_id,auth:'face_id'}), /VOICE_CONFIRMATION_SCOPE_DENIED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone, {confirmation_id: 'f'.repeat(64),auth:'face_id'}), /VOICE_CONFIRMATION_NOT_FOUND/);
  await assert.rejects(f.runtime.confirmVoice(f.glasses,{confirmation_id}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id}),/VOICE_CONFIRMATION_APP_UPDATE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id,auth:'touch_id'}),/VOICE_CONFIRMATION_BIOMETRIC_INVALID/);
  assert.equal((await f.runtime.voiceConfirmations(f.phone)).length,1,'refused biometric markers leave the card pending');
  const confirmed = await f.runtime.confirmVoice(f.phone, {confirmation_id,auth:'face_id'});
  const c = confirmed.processed_event as ProcessedEvent;
  const projected=f.runtime.timeline!.page('owner').items.filter(item=>item.kind==='owner');
  assert.equal(projected.length,1);assert.equal(projected[0]!.text,'依米，帮我叫车回家');
  assert.equal(projected[0]!.item_id,`me-ambient-${d!.processed_event_id}`);
  assert.deepEqual([c.device_id, c.media_type, c.user_identity, principalAttribution(c), runScope(c)],
    ['phone', 'app_event', 'owner', 'owner_confirmation', 'owner']);
  assert.deepEqual(c.content.app_event, {kind: 'voice_confirmation', confirmation_id, confirms_processed_event_id: d!.processed_event_id,
    request_text: '依米，帮我叫车回家', confirmed_at: (c.content.app_event as {confirmed_at: string}).confirmed_at});
  assert.deepEqual(c.source.location, location);
  assert.equal(confirmed.admission.session_id, 'session');
  // Exactly once: the same tap again replays the same D and admission, and never creates a second native run.
  await assert.rejects(f.runtime.confirmVoice(f.glasses,{confirmation_id}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  const again = await f.runtime.confirmVoice(f.phone, {confirmation_id,auth:'face_id'});
  assert.equal((again.processed_event as ProcessedEvent).processed_event_id, c.processed_event_id);
  await f.until(2);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(f.bodies.length, 2);
  assert.deepEqual([Object.hasOwn(f.bodies[1]!,'memory_write'), f.bodies[1]!.run_scope, f.bodies[1]!.session_id], [false, undefined, 'session']);
  const input = JSON.parse(f.bodies[1]!.input) as ProcessedEvent;
  assert.deepEqual(input.content.app_event, {...c.content.app_event as object, confirmed_request: d});
  assert.equal(await f.archive.validateEvidence((input.content.app_event as {confirmed_request: ProcessedEvent}).confirmed_request), true);
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone), []);
  // A guest D never had a confirmation to give.
  const guest = await fixture(t, whole('speaker:2', 0.9));
  const {events: [guestEvent]} = await guest.heard();
  assert.equal(guestEvent!.voice_confirmation, undefined);
});

test('a confirmation expires after its TTL and a decision belongs to the device that made it', async t => {
  const expired = await fixture(t, whole('owner_uncertain', 0.5), {directed:true,ttl_ms: 1});
  const {events: [event]} = await expired.heard();
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(expired.runtime.confirmVoice(expired.phone, {confirmation_id: event!.voice_confirmation!.confirmation_id,auth:'face_id'}), /VOICE_CONFIRMATION_EXPIRED/);
  let now = 1000;
  const directory = await mkdtemp(join(tmpdir(), 'paios-voice-confirmations-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const confirmations = new VoiceConfirmations(new PosixStorage(directory), {ttl_ms: 500, max_pending: 2, now: () => now});
  const d = (id: string) => ({principal_id: 'owner', processed_event_id: id, device_id: 'glasses'}) as ProcessedEvent;
  const first = await confirmations.open(d('d1'), 'session');
  assert.equal(first.expires_at_ms, 1500);
  assert.deepEqual((await confirmations.open(d('d1'), 'session')).created_at_ms, 1000);
  await assert.rejects(confirmations.open(d('d1'), 'other-session'), /VOICE_CONFIRMATION_CONFLICT/);
  await confirmations.open(d('d2'), 'session-2'); await confirmations.open(d('d3'), 'session-3');
  assert.equal(confirmations.list('owner').length, 2);
  now = 1200;
  const decided = await confirmations.decide(first.confirmation_id, {principal_id: 'owner', device_id: 'phone'});
  assert.equal(decided.decision.confirmed_at, new Date(1200).toISOString());
  now = 9000;
  // After expiry a recorded decision still replays to its device, never to another.
  assert.deepEqual((await confirmations.decide(first.confirmation_id, {principal_id: 'owner', device_id: 'phone'})).decision, decided.decision);
  await assert.rejects(confirmations.decide(first.confirmation_id, {principal_id: 'owner', device_id: 'phone-2'}), /VOICE_CONFIRMATION_ALREADY_DECIDED/);
  assert.deepEqual(confirmations.list('owner'), []);
});

test('the paired phone watches its "确认是我" prompts: pushed when opened, gone when confirmed or expired, never polled', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const f = await fixture(t, whole('owner_uncertain', 0.5), {directed:true,finish: true, ttl_ms: 5000});
  const seen: {confirmation_id: string; event_id: string; text?: string; expires_in_ms: number}[][] = [], strangers: unknown[][] = [];
  const errors: unknown[] = [], failed=Promise.withResolvers<never>();
  const initial=Promise.withResolvers<void>(),opened=Promise.withResolvers<void>(),confirmedGone=Promise.withResolvers<void>();
  const strangerInitial=Promise.withResolvers<void>();
  const wait=(publication:Promise<void>)=>Promise.race([publication,failed.promise]);
  const onError=(error:unknown)=>{errors.push(error);failed.reject(error);};

  await f.runtime.watchCare(f.phone,async()=>true);
  const stop = await f.runtime.watchVoiceConfirmations(f.phone, async pending => {
    seen.push(pending);
    if(seen.length===1)initial.resolve();else if(pending.length)opened.resolve();else if(seen.some(view=>view.length))confirmedGone.resolve();
  }, onError);
  await f.runtime.watchVoiceConfirmations(f.stranger, async pending => {strangers.push(pending);strangerInitial.resolve();}, onError);
  await wait(initial.promise);await wait(strangerInitial.promise);assert.deepEqual(seen.at(-1), []);
  const {events: [event]} = await f.heard();
  const id = event!.voice_confirmation!.confirmation_id;
  await wait(opened.promise);
  const [prompt] = seen.at(-1)!;
  assert.deepEqual([prompt!.confirmation_id, prompt!.event_id, prompt!.text], [id, `voice-confirm:${id}`, '依米，帮我叫车回家']);
  assert.ok(prompt!.expires_in_ms > 0 && prompt!.expires_in_ms <= 5000);
  // The confirmation D is the event the phone follows: its id is the prompt's event_id.
  const confirmed = await f.runtime.confirmVoice(f.phone, {confirmation_id: id,auth:'face_id'});
  assert.equal((confirmed.processed_event as ProcessedEvent).event_id, prompt!.event_id);
  await wait(confirmedGone.promise);assert.deepEqual(seen.at(-1), []);
  // A second prompt that nobody answers disappears on its own when the TTL ends.
  const second = await fixture(t, whole('owner_uncertain', 0.5), {directed:true,ttl_ms: 150});
  const views: unknown[][] = [];
  const secondInitial=Promise.withResolvers<void>(),secondOpened=Promise.withResolvers<void>(),expired=Promise.withResolvers<void>();
  await second.runtime.watchCare(second.phone,async()=>true);
  const unwatch = await second.runtime.watchVoiceConfirmations(second.phone, async pending => {
    views.push(pending);
    if(views.length===1)secondInitial.resolve();else if(pending.length)secondOpened.resolve();else if(views.some(view=>view.length))expired.resolve();
  }, onError);
  await wait(secondInitial.promise);assert.deepEqual(views.at(-1),[]);
  await second.heard();await wait(secondOpened.promise);
  assert.ok(views.some(view=>view.length===1));
  // The authority schedules expiry at expires_at_ms plus 5ms.
  t.mock.timers.tick(150+5);
  await wait(expired.promise);
  assert.deepEqual(views.at(-1),[]);
  unwatch(); stop();
  assert.ok(strangers.every(view => view.length === 0), 'another principal never sees the owner\'s prompts');
  assert.deepEqual(errors, []);
});

test('owner override admits directed short and other-speaker requests without changing captured evidence',async t=>{
  for(const segments of [whole('owner',.9),whole('owner_uncertain',.52),[{...whole('owner',.9)[0]!,end_sample_exclusive:3200}],whole('speaker:7',.93)]){
    const f=await fixture(t,segments,{directed:true,override:true});
    const heard=await f.heard(),original=heard.processed_events[0]!,accepted=heard.events[0]!.processed_event;
    assert.equal(principalAttribution(accepted),'owner_override');assert.equal(runScope(accepted),'owner');
    assert.deepEqual(accepted.speakers,original.speakers);assert.equal(accepted.user_identity,original.user_identity);
    assert.equal(voiceEvidence(accepted),voiceEvidence(original));assert.equal(await f.archive.validateEvidence(accepted),true);
    assert.notEqual(accepted.processed_event_id,original.processed_event_id);assert.equal(heard.events[0]!.voice_confirmation,undefined);
    assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);await f.until(1);assert.equal(Object.hasOwn(f.bodies[0]!,'memory_write'),false);
  }
});
test('owner override never turns 依米\'s own voice heard back into the owner',async t=>{
  const f=await fixture(t,whole('assistant',.8),{directed:true,override:true});
  const heard=await f.heard(),accepted=heard.events[0]!.processed_event;
  assert.equal(voiceEvidence(accepted),'assistant');assert.notEqual(principalAttribution(accepted),'owner_override');
  // Without the override a directed clip in 依米's voice stays uncertain (the phone asks); the override must not lift it.
  assert.equal(accepted.content.owner_override,undefined);assert.notEqual(runScope(accepted),'owner');
});
test('owner override leaves ambient observations and disabled directed identity unchanged',async t=>{
  const ambient=await fixture(t,whole('speaker:7',.9),{override:true});const a=await ambient.heard();
  assert.equal(runScope(a.processed_events[0]!),'guest');assert.equal(a.events[0]!.processed_event.content.owner_override,undefined);
  const directed=await fixture(t,whole('owner_uncertain',.52),{directed:true});const d=await directed.heard();
  assert.equal(runScope(d.events[0]!.processed_event),'owner_uncertain');assert.ok(d.events[0]!.voice_confirmation);
});


test('capability-upgrade uses owner unlock cards and durably retries approved grants without native admission',async t=>{
  let attempts=0;const grants:CapabilityUpgradeRequest[]=[];
  const f=await fixture(t,whole('owner',.9),{capability_grants:{approve:async request=>{
    attempts++;if(attempts===1)throw new Error('grant unavailable');grants.push(request);
  }}});
  const request:CapabilityUpgradeRequest={principal_id:'owner',device_id:'mac',capabilities:['chat_ui'],grant_ref:{version:'old'}};
  await f.runtime.requestCapabilityUpgrade(request,'允许 Mac 使用聊天界面？');
  const [card]=await f.runtime.voiceConfirmations(f.phone);assert.equal(card?.kind,'native_approval');assert.ok(card);
  const mac=await f.runtime.authenticate('mac-token'),trustedMac=await f.runtime.authenticate('trusted-mac-token');
  await assert.rejects(f.runtime.confirmVoice(mac,{confirmation_id:card.confirmation_id,choice:'approve'}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.glasses,{confirmation_id:card.confirmation_id,choice:'approve'}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.stranger,{confirmation_id:card.confirmation_id,choice:'approve'}),/VOICE_CONFIRMATION_SCOPE_DENIED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:card.confirmation_id}),/NATIVE_APPROVAL_CHOICE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:card.confirmation_id,choice:'approve'}),/grant unavailable/);
  assert.equal((await f.runtime.voiceConfirmations(f.phone)).length,1);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:card.confirmation_id,choice:'deny'}),/VOICE_CONFIRMATION_ALREADY_DECIDED/);
  await f.runtime.requestCapabilityUpgrade(request,'允许 Mac 使用聊天界面？');
  assert.deepEqual(grants,[request]);assert.equal((await f.runtime.voiceConfirmations(f.phone)).length,0);assert.equal(f.bodies.length,0);
  const second={...request,grant_ref:{version:'second'}};await f.runtime.requestCapabilityUpgrade(second,'允许？');
  const [next]=await f.runtime.voiceConfirmations(trustedMac);assert.ok(next);
  await f.runtime.confirmVoice(trustedMac,{confirmation_id:next.confirmation_id,choice:'approve'});
  assert.deepEqual(grants,[request,second]);
});

test('capability-upgrade denial and first winner persist across confirmation reconstruction, undecided TTL renews',async t=>{
  const f=await fixture(t,whole('owner',.9));let now=1000;
  const request:CapabilityUpgradeRequest={principal_id:'owner',device_id:'mac',capabilities:['chat_ui'],grant_ref:{version:'old'}};
  const confirmations=new VoiceConfirmations(f.storage,{ttl_ms:100,now:()=>now});t.after(()=>confirmations.close());
  const first=await confirmations.openCapabilityUpgrade(request,'允许？');assert.ok(first);
  const restored=new VoiceConfirmations(f.storage,{ttl_ms:100,now:()=>now});t.after(()=>restored.close());
  assert.equal((await restored.openCapabilityUpgrade(request,'允许？'))?.record.confirmation_id,first.record.confirmation_id);
  await restored.decide(first.record.confirmation_id,{principal_id:'owner',device_id:'phone'},'deny');
  await assert.rejects(restored.decide(first.record.confirmation_id,{principal_id:'owner',device_id:'mac'},'approve'),/VOICE_CONFIRMATION_ALREADY_DECIDED/);
  assert.equal(await confirmations.openCapabilityUpgrade(request,'允许？'),undefined);
  now=1100;assert.equal(await restored.openCapabilityUpgrade(request,'允许？'),undefined,'denial never renews');
  const changed={...request,grant_ref:{version:'new'}};const newer=await restored.openCapabilityUpgrade(changed,'允许？');assert.ok(newer);
  assert.notEqual(newer.record.confirmation_id,first.record.confirmation_id);
  now=1200;const renewed=await restored.openCapabilityUpgrade(changed,'允许？');assert.ok(renewed);
  assert.equal(renewed.record.confirmation_id,newer.record.confirmation_id);assert.equal(renewed.record.expires_at_ms,1300);
  assert.equal(restored.list('owner').length,1);
  const restarted=new VoiceConfirmations(f.storage,{ttl_ms:100,now:()=>now});t.after(()=>restarted.close());
  assert.equal((await restarted.openCapabilityUpgrade(changed,'允许？'))?.record.expires_at_ms,1300);
  const approvedRequest={...request,grant_ref:{version:'approved'}},approved=await restarted.openCapabilityUpgrade(approvedRequest,'允许？');assert.ok(approved);
  await restarted.decide(approved.record.confirmation_id,{principal_id:'owner',device_id:'phone'},'approve');
  now=1400;const replay=await confirmations.openCapabilityUpgrade(approvedRequest,'允许？');
  assert.equal(replay?.approved,true,'durable approval can reapply a grant after restart and prompt expiry');
  assert.equal(replay?.opened,false);assert.equal(confirmations.list('owner').length,0);
});


test('directed unknown and guest speech never open an identity card',async t=>{
  for(const speaker of [undefined,'speaker:3']){
    const f=await fixture(t,whole(speaker,speaker?.startsWith('speaker:') ? .9 : undefined),{directed:true});
    const {events:[event]}=await f.heard();await f.until(1);
    assert.equal(event!.voice_confirmation,undefined);
    assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
    assert.equal(JSON.parse(f.bodies[0]!.input).voice_confirmation,null);
  }
});

test('concurrent identity opens keep the latest conversation card and cannot resurrect a withdrawn card',async t=>{
  const f=await fixture(t,whole('owner_uncertain',.5));
  const confirmations=new VoiceConfirmations(f.storage);t.after(()=>confirmations.close());
  const views:string[][]=[];t.after(confirmations.watch('owner',()=>views.push(confirmations.list('owner').map(row=>row.processed_event_id))));
  const d=(n:number)=>({principal_id:'owner',device_id:'glasses',processed_event_id:`replace-${n}`}) as ProcessedEvent;
  const records=await Promise.all([1,2,3].map(n=>confirmations.open(d(n),'conversation')));
  assert.deepEqual(confirmations.list('owner').map(row=>row.processed_event_id),['replace-3']);
  assert.ok(views.every(rows=>rows.length<=1));
  await assert.rejects(confirmations.decide(records[0]!.confirmation_id,{principal_id:'owner',device_id:'phone'}),/ALREADY_DECIDED/);
  await confirmations.open(d(1),'conversation');
  assert.deepEqual(confirmations.list('owner').map(row=>row.processed_event_id),['replace-3']);
  await confirmations.open(d(4),'other-conversation');assert.equal(confirmations.list('owner').length,2);
});


test('a tap arriving after the withdrawal snapshot cannot approve the old identity card',async t=>{
  const f=await fixture(t,whole('owner_uncertain',.5));
  const confirmations=new VoiceConfirmations(f.storage);t.after(()=>confirmations.close());
  const d=(n:number)=>({principal_id:'owner',device_id:'glasses',processed_event_id:`late-tap-${n}`}) as ProcessedEvent;
  const old=await confirmations.open(d(1),'conversation');let lateTap:Promise<boolean>|undefined;
  t.after(confirmations.watch('owner',()=>{
    if(!lateTap&&!confirmations.list('owner').some(row=>row.confirmation_id===old.confirmation_id))
      lateTap=confirmations.decide(old.confirmation_id,{principal_id:'owner',device_id:'phone'}).then(()=>true,()=>false);
  }));
  const publish=f.storage.publish.bind(f.storage);
  f.storage.publish=async(namespace,key,bytes)=>{
    // Let the stale device tap finish if the removal was already published before its denial was durable.
    if(namespace==='voice-confirmation-decisions'&&JSON.parse(Buffer.from(bytes).toString()).choice==='deny'&&lateTap)await lateTap;
    return publish(namespace,key,bytes);
  };
  await confirmations.open(d(2),'conversation');assert.equal(await lateTap,false);
  assert.deepEqual(confirmations.list('owner').map(row=>row.processed_event_id),['late-tap-2']);
});


test('owner override input publication settles before exact owner deletion returns',async t=>{
  const f=await fixture(t,whole('owner_uncertain',.52),{directed:true});
  const original=(await f.heard()).processed_events[0]!;
  const key=digest([original.raw_ref,original.segment_id,original.revision+1]);
  const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  f.storage.publish=async(namespace,recordKey,bytes)=>{
    if(namespace==='processed-media-inputs'&&recordKey===key){entered.resolve();await release.promise;}
    return publish(namespace,recordKey,bytes);
  };
  t.after(()=>release.resolve());
  const override=f.processor.overrideRequest(original).catch(error=>error);
  await entered.promise;
  const deletion=f.archive.delete(original.raw_ref,original.principal_id);
  // The publication owns the same fence as deletion. Baseline deletion can finish while it is held here.
  await Promise.race([deletion,new Promise(resolve=>setTimeout(resolve,1000).unref())]);
  release.resolve();await Promise.all([override,deletion]);
  await assert.rejects(f.storage.read('processed-media-inputs',key),{code:'ENOENT'});
  assert.ok(!(await f.storage.list('processed-media')).includes(digest([original.raw_ref,original.segment_id,original.revision+1])));
});
