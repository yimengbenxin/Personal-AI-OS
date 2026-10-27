import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,ContractError,digest,sha256,principalAttribution,runScope,type MediaSegment,type RawEvent} from '../src/contracts.ts';
import {DEFAULT_PAYMENT_CONFIG} from '../src/payment/config.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';
import {selectPcmView} from '../src/media/sample-timeline.ts';
import {MediaProcessor} from '../src/media/processing.ts';
import {sherpaAudioCapability} from '../src/media/sherpa-audio-worker.ts';
import {controlledEngine,transcriptionResult} from './speech-fixture.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import type {Initiating,PaymentPorts} from '../src/payment/contracts.ts';
import {StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {paymentFixture,keyPair,signed} from './payment-fixture.ts';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {isSealedRegistry} from '../src/voiceprint/cipher.ts';
import {parseErrandResult,errandNotice} from '../../../phase0/gateway/src/errand-spool.ts';
import type {ErrandResult} from '../src/runtime.ts';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';

async function fixture(t:test.TestContext,realPayment=false,enabled=true,pollInterval=realPayment?5:10000,withEnrollment=false,voiceModelCurrent?:()=>boolean){
  const directory=await mkdtemp(join(tmpdir(),'payment-runtime-')),storage=new PosixStorage(directory);
  let count=0,ports:PaymentPorts|undefined,lease=true,terminalChanges=0,authorityInputs=0,authorityWatches=0;
  const rejections:{source:unknown;error:unknown}[]=[];
  const requests:{input:Record<string,unknown>;eligible:boolean}[]=[];
  const nativeInputs:Parameters<NativeClient['create']>[0][]=[];
  const completed=new Map<string,string>(),events=new Map<string,string>(),privacy=new Set<string>(),detached=new Set<string>();
  const native:NativeClient={create:async body=>{nativeInputs.push(body);return {run_id:`run-${++count}`,session_id:`native-${count}`,conversation_session_id:'session',status:'running'};},
    status:async run_id=>({run_id,session_id:`native-${run_id.slice(4)}`,conversation_session_id:'session',status:completed.has(run_id)?'completed':'running',...(detached.has(run_id)?{turn_exit_reason:'delegation_waiting'}:{}),...(completed.has(run_id)?{output:completed.get(run_id)!}:{})}),cancel:async()=>{throw Error('not used');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:10,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:pollInterval,native_idempotency_retention_ms:10000,policy_version:'payment-test'});
  const mockPayment={recordReplySource:(_p:string,session:string)=>{privacy.add(session);},replyPrivacy:(_p:string,session:string)=>privacy.has(session)?{private:'payment'}:{},paymentErrand:()=>false,config:{...DEFAULT_PAYMENT_CONFIG,enabled},setTerminals:()=>{},attach:(value:PaymentPorts)=>{ports=value;},close:()=>{},
    initiating:async(source:{device_id:string;device_type:string},d:{captured_at:string}):Promise<Initiating>=>({kind:'text',...source,captured_at_ms:Date.parse(d.captured_at),lease_at_capture:lease}),
    request:async(input:Record<string,unknown>,eligible:boolean)=>{requests.push({input,eligible});return eligible?{status:'accepted',intent_id:'pi-test'}:{status:'rejected',error_code:'PAYMENT_SOURCE_NOT_OWNER'};},
    sourceRejected:(source:unknown,error:unknown)=>{rejections.push({source,error});},
    input:async(source:Parameters<PaymentPorts['revalidate']>[0])=>{authorityInputs++;await ports!.revalidate(source);return undefined;},
    watch:async(source:Parameters<PaymentPorts['revalidate']>[0])=>{authorityWatches++;await ports!.revalidate(source);return ()=>{};},
    terminalChanged:async()=>{terminalChanges++;},enrolmentAllowed:async()=>false,detach:async()=>{throw Error('PAYMENT_DETACH_FAILED');},
    source:(_run:string,intent:string)=>intent==='pi-test'} as unknown as PaymentAuthority;
  const payment=realPayment?PaymentAuthority.open(join(directory,'payments'),{config:{...DEFAULT_PAYMENT_CONFIG,enabled,executor_key_file:'/fixture/executor.key'}}):mockPayment;
  const device={principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'fixture',consent_ref:'c',route_version:'r',output_modes:['text'],token_sha256:sha256('phone-token')};
  let paired:Parameters<PaymentPorts['revalidate']>[0][]=[device,{...device,device_id:'glasses',device_type:'glasses',capabilities:['display','microphone','wear_state']}];
  const rejectedSources=new WeakSet<object>(),registry=new StaticFixtureDeviceAuthority([device,{...device,device_id:'glasses',device_type:'glasses',capabilities:['display','microphone','wear_state'],token_sha256:sha256('glasses-token')}]);
  const speech=withEnrollment?controlledEngine():undefined,voiceprint=speech?new VoiceprintRegistry(storage,{...speech.speaker_model,dim:16}):undefined;
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,10000),admission,native,output:new OutputAuthority(storage),
    ...(voiceModelCurrent?{voice_model_current:voiceModelCurrent}:{}),
    ...(voiceprint?{voiceprint}:{}),...(speech?{speech:async()=>speech}:{}),
    payment_devices:async principal=>paired.filter(d=>d.principal_id===principal),
    sourceAuthority:{authenticate:c=>registry.authenticate(c),revalidate:async s=>{if(rejectedSources.has(s))throw new ContractError('SOURCE_BINDING_INACTIVE',403);return registry.revalidate(s);}},skill:'test',max_read_bytes:10000,payment});
  const source=await runtime.authenticate('phone-token');
  t.after(async()=>{await runtime.close();await voiceprint?.close();await rm(directory,{recursive:true,force:true});});
  async function submit(event_id:string,prompt:boolean,app?:object,call=false){
    const raw:RawEvent={schema_version:'paios.event.v1',event_id,device_id:source.device_id,device_type:'phone',captured_at:new Date().toISOString(),
      source:{channel:'fixture'},media_type:prompt?'text':'app_event',mime:prompt?'text/plain;charset=utf-8':'application/json',representation:'uploaded_original',
      payload:Buffer.from(prompt?'帮我买午饭':JSON.stringify(app??{kind:'payment_update',event:'card_opened'}))};
    const accepted=await (call?runtime.submitCallTurn(raw,source,'session'):runtime.submit(raw,source,'session',prompt));
    assert.ok(accepted.admission);
    let record=accepted.admission;
    for(let n=0;!record.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));record=(await runtime.event(source,'session',accepted.processed_event.processed_event_id)).admission;}
    assert.ok(record.run_id);events.set(record.run_id,accepted.processed_event.processed_event_id);return record.run_id;
  }
  return {runtime,payment,storage,directory,nativeInputs,detach:(run:string)=>detached.add(run),settle:(run:string)=>runtime.reconcile(source,'session',events.get(run)!),complete:(run:string,text:string)=>completed.set(run,text),result:(run:string,sealed=false)=>runtime.result(source,'session',events.get(run)!,sealed?{text_replay:'sealed'}:{}),requests,source,submit,rejections,setPaired:(devices:typeof paired)=>{paired=devices;},rejectHandle:(s:object)=>rejectedSources.add(s),authorityCalls:()=>({input:authorityInputs,watch:authorityWatches}),terminalChanges:()=>terminalChanges,ports:()=>ports!,relock:()=>{lease=false;}};
}
const args={action:'request',purpose:'午饭',app:'千问',budget_yuan:16.6};
test('payment owner facts reject model retirement while channel readiness is in flight',async t=>{
  let current=true;
  const f=await fixture(t,false,true,10000,true,()=>current),registry=f.runtime.voiceprintRegistry();
  await registry.enrollOwner({speaker_model:registry.model,channel:'phone_app',mode:'replace',
    samples:Array.from({length:5},()=>({embedding:Float32Array.from({length:registry.model.dim},(_,i)=>Number(i===0)),speech_ms:2000}))});
  assert.deepEqual(await f.ports().owner('owner'),{live:true,phone_app:true,glasses:false});
  let release!:()=>void,entered!:()=>void;
  const began=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  const ready=registry.paymentReady.bind(registry);
  t.mock.method(registry,'paymentReady',async(channel?:Parameters<typeof ready>[0])=>{
    if(channel==='phone_app'){entered();await pending;}return ready(channel);
  });
  const checking=f.ports().owner('owner');await began;current=false;release();
  assert.deepEqual(await checking,{live:false,phone_app:false,glasses:false});
});

test('runtime approved-model hook clears trust and cascades persisted payment owners',async t=>{
  const f=await fixture(t,true,true,10000,true,()=>false),registry=f.runtime.voiceprintRegistry();
  const clear=t.mock.method(registry,'clearTrustWindows');
  for(const principal of ['owner','disconnected-owner'])f.payment.store.setPolicy({...f.payment.store.policy(principal),voice_enabled:true,auto_enabled:true});
  await f.runtime.invalidatePaymentVoice();
  assert.equal(clear.mock.callCount(),1);
  for(const principal of ['owner','disconnected-owner']){
    assert.equal(f.payment.store.policy(principal).voice_enabled,false);
    assert.equal(f.payment.store.policy(principal).auto_enabled,false);
  }
});

test('detached task payment checkpoint pushes an owner confirmation card during a newer owner turn',async t=>{
  const f=await fixture(t,true),frames:Record<string,unknown>[]=[],run=await f.submit('detached-payment',true);
  f.detach(run);await f.settle(run);
  const newer=await f.submit('newer-owner-turn',true);
  t.after(await f.runtime.watchPayments(f.source,async frame=>{frames.push(frame);},'session'));
  const request=await f.runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'purchase'},args}) as {status:string;intent_id:string};
  assert.equal(request.status,'accepted');
  const card=await f.payment.checkpoint({intent_id:request.intent_id,job_id:'isolated-payment',seq:1,app:'千问',checkout:'cashier',
    amount_fen:1660,payee:'午饭店',items:['午饭'],screen_sha256:'a'.repeat(64),read_at:new Date().toISOString()});
  assert.equal(f.payment.store.getPayment(String(card.payment_id))!.state,'awaiting_owner');
  assert.ok(frames.some(frame=>frame.operation==='payment_cards'&&(frame.cards as {payment_id:string}[]).some(c=>c.payment_id===card.payment_id)));
  assert.equal(f.payment.store.getGrant(String(card.payment_id)),undefined,'every payment still requires this request owner decision');
  assert.notEqual(run,newer);assert.equal(f.nativeInputs.length,2);
});

test('disabled payment does not enter its evidence path or block ordinary native requests',async t=>{
  const f=await fixture(t,false,false);
  t.mock.method(f.payment,'initiating',async()=>{throw Error('disabled payment evidence must not run');});
  const run=await f.submit('ordinary-disabled-payment',true);
  assert.deepEqual(await f.runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'purchase'},args}),
    {status:'rejected',error_code:'PAYMENT_DISABLED'});
  assert.equal(f.requests.length,0);
  await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
  f.complete(run,'照常回复');assert.equal((await f.result(run)).result.reply_text,'照常回复');
});
test('request uses the admitted D capture and fen budget; model cannot supply initiating evidence',async t=>{
  const f=await fixture(t),run=await f.submit('owner-request',true);f.relock();
  const call={context:{run_id:run,session_id:'session',tool_call_id:'purchase'},args};
  assert.deepEqual(await f.runtime.tool('paios_payment',call),{status:'accepted',intent_id:'pi-test'});
  assert.equal(f.requests[0]!.eligible,true);assert.equal(f.requests[0]!.input.budget_fen,1660);
  assert.equal((f.requests[0]!.input.initiating as Initiating).lease_at_capture,true);
  await assert.rejects(f.runtime.tool('paios_payment',{...call,args:{...args,initiating:{lease_at_capture:true}}}),/UNKNOWN_TOOL_ARGUMENT/);
  assert.equal(f.runtime.paymentSource(run,'pi-test').allowed,true);
  assert.equal(f.runtime.paymentSource(run,'pi-foreign').allowed,false);
});
test('observation run cannot create an intent; payment inventory contains paired descriptors',async t=>{
  const f=await fixture(t),run=await f.submit('payment-observation',false);
  assert.deepEqual(await f.runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'purchase'},args}),
    {status:'rejected',error_code:'PAYMENT_SOURCE_NOT_OWNER'});
  assert.equal(f.requests[0]!.eligible,false);assert.equal((await f.ports().devices('owner'))[0]!.device_id,'phone');
});
test('payment tool is always exposed and schema rejects model-supplied security fields',()=>{
  const tool=enabledToolSchemas({memory:false}).find(t=>t.name==='paios_payment');assert.ok(tool);
  assert.equal(tool.parameters.additionalProperties,false);assert.equal('grant_id' in tool.parameters.properties,false);
  assert.equal('initiating' in tool.parameters.properties,false);
});

test('a resolved false glasses enrolment grant cannot bypass the capability gate; detach failures remain observable',async t=>{
  const f=await fixture(t),glasses=await f.runtime.authenticate('glasses-token');
  await assert.rejects(f.runtime.voiceprintOwner(glasses),/VOICEPRINT_DEVICE_REQUIRED/);
  const stop=await f.runtime.watchCare(glasses,async()=>false,undefined,undefined,undefined,undefined,undefined,{session:'session',deliver:async()=>{}});
  await f.runtime.wearState(glasses,false);assert.equal(f.terminalChanges(),1);stop();
  await assert.rejects(f.runtime.paymentDetach(f.source),/PAYMENT_DETACH_FAILED/);
});

test('glasses ordinary voice supplement passes the device gate only with its own phone-approved grant',async t=>{
  const f=await fixture(t),glasses=await f.runtime.authenticate('glasses-token'),payment=(f.runtime as unknown as {payment:{enrolmentAllowed:(s:unknown,kind?:string)=>Promise<boolean>}}).payment;
  await assert.rejects(f.runtime.voiceEnrollmentControl(glasses,'status'),/VOICEPRINT_DEVICE_REQUIRED/);
  payment.enrolmentAllowed=async(_s,kind='voiceprint_enrol')=>kind==='voiceprint_enrol';
  await assert.rejects(f.runtime.voiceEnrollmentControl(glasses,'status'),/VOICEPRINT_DEVICE_REQUIRED/,'the payment sentence grant does not open ordinary enrollment');
  payment.enrolmentAllowed=async(_s,kind)=>kind==='voice_enrollment';
  await assert.rejects(f.runtime.voiceEnrollmentControl(glasses,'status'),/VOICE_ENROLLMENT_UNAVAILABLE/,'past the device gate');
});

test('leaving ordinary glasses enrollment cancels the phone card before Face ID and returning requires a fresh approval',async t=>{
  const f=await fixture(t,true,true,10000,true),glasses=await f.runtime.authenticate('glasses-token');
  t.after(await f.runtime.watchCare(glasses,async()=>false,undefined,undefined,undefined,undefined,undefined,{session:'session',deliver:async()=>{}}));
  await f.runtime.wearState(glasses,true,0);
  const dev=keyPair(),user=keyPair();
  for(const [key,role] of [[dev,'device'],[user,'user']] as const){
    const {nonce}=await f.payment.keys.challenge(f.source,'keys_register');
    const statement={purpose:'keys_register',role,device_id:f.source.device_id,nonce,key_sha256:sha256(Buffer.from(key.public_x963_b64,'base64'))};
    await f.payment.keys.register(f.source,{role,public_x963_b64:key.public_x963_b64,...signed(key,statement),
      ...(role==='user'?{device_signature_b64:signed(dev,statement).signature_b64}:{})});
  }
  const frames:Record<string,unknown>[]=[],shown=Promise.withResolvers<void>(),removed=Promise.withResolvers<void>();let oldId:string|undefined;
  t.after(await f.runtime.watchPayments(f.source,async frame=>{
    frames.push(frame);
    if(frame.operation==='payment_approvals'&&(frame.approvals as unknown[]).length)shown.resolve();
    if(oldId&&frame.operation==='payment_approvals'&&!(frame.approvals as {approval_id:string}[]).some(a=>a.approval_id===oldId))removed.resolve();
  }));
  const request=()=>f.runtime.paymentInput(glasses,{operation:'voiceprint_enrol_request',purpose:'conversation'});
  await request();
  const old=(await f.payment.leases.approvals(f.source))[0]!;oldId=String(old.approval_id);await shown.promise;
  const approve={operation:'payment_approval_decide',approval_id:oldId,decision:'approve',...signed(user,{purpose:'approval',device_id:f.source.device_id,
    nonce:old.nonce,approval_id:oldId,kind:'voice_enrollment',target_device_id:glasses.device_id,decision:'approve'})};
  let exitError:unknown;
  try{await f.runtime.voiceEnrollmentControl(glasses,'discard');}catch(error){exitError=error;}
  await assert.rejects(f.runtime.paymentInput(f.source,approve),{message:'APPROVAL_NOT_FOUND',status:404});
  assert.ifError(exitError);await removed.promise;
  assert.ok(frames.some(frame=>frame.operation==='payment_approvals'&&(frame.approvals as {approval_id:string}[]).some(a=>a.approval_id===oldId)));
  assert.equal(await f.payment.enrolmentAllowed(glasses,'voice_enrollment'),false);
  await request();const fresh=(await f.payment.leases.approvals(f.source))[0]!;
  assert.notEqual(fresh.approval_id,oldId);assert.notEqual(fresh.nonce,old.nonce);
  await assert.rejects(f.runtime.paymentInput(f.source,{...approve,approval_id:fresh.approval_id}),/PAYMENT_SIGNATURE_INVALID/);
  await f.runtime.paymentInput(f.source,{operation:'payment_approval_decide',approval_id:fresh.approval_id,decision:'approve',...signed(user,{
    purpose:'approval',device_id:f.source.device_id,nonce:fresh.nonce,approval_id:fresh.approval_id,kind:'voice_enrollment',target_device_id:glasses.device_id,decision:'approve'})});
  assert.equal(await f.payment.enrolmentAllowed(glasses,'voice_enrollment'),true);
  await f.runtime.voiceEnrollmentControl(glasses,'discard');
  assert.equal(await f.payment.enrolmentAllowed(glasses,'voice_enrollment'),false,'an approval that won the race leaves no dangling grant');
});

test('I11 shipped production payment/voiceprint configuration (payments on) provisions real sealed registry with payments disabled and enabled',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'payment-provision-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const shipped=JSON.parse(await readFile(new URL('../../../../../deploy/cloud/cloud.json',import.meta.url),'utf8')) as CentralProvisionConfiguration;
  const hermesKey=join(directory,'hermes.key'),internalKey=join(directory,'internal.key'),executorKey=join(directory,'payment-executor.key'),cipherKey=join(directory,'voiceprint.key'),model=join(directory,'speaker-fixture.onnx'),skill=join(directory,'skill');
  await Promise.all([hermesKey,internalKey,executorKey].map(path=>writeFile(path,'fixture-key-material-32-characters-minimum',{mode:0o600})));
  await writeFile(cipherKey,Buffer.alloc(32,9).toString('base64')+'\n',{mode:0o600});
  await writeFile(model,'fixture model identity only; never loaded as ONNX');await writeFile(skill,'Fixture skill');
  // Select the actual central provisioning fields. Omit unrelated external voice, visual, cold storage and native-memory services.
  const config:CentralProvisionConfiguration={storage_root:join(directory,'storage'),lock_file:join(directory,'central.lock'),port:19091,
    hermes_base_url:'http://127.0.0.1:1',hermes_key_file:hermesKey,internal_key_file:internalKey,skill_file:skill,
    native_request_timeout_ms:shipped.native_request_timeout_ms,http_request_timeout_ms:shipped.http_request_timeout_ms,
    max_request_bytes:shipped.max_request_bytes,max_event_bytes:shipped.max_event_bytes,max_read_bytes:shipped.max_read_bytes,admission:shipped.admission,
    voiceprint:{...shipped.voiceprint!,speaker_model:{...shipped.voiceprint!.speaker_model,file:model},encryption_key_file:cipherKey},
    payment:{...shipped.payment as Record<string,unknown>,executor_key_file:executorKey}};
  // Production ships with real payment enabled; each payment still needs user confirmation.
  assert.equal((config.payment as {enabled:boolean}).enabled,true);assert.equal(config.voiceprint!.enrolment_sentences!.length,8);
  const {encryption_key_file:omittedKey,...unsealedVoiceprint}=config.voiceprint!;
  await assert.rejects(async()=>{
    const provision=await provisionCentralResources({...config,payment:{...config.payment as Record<string,unknown>,enabled:false},voiceprint:unsealedVoiceprint});
    await provision.release();
  },{code:'PAYMENT_VOICEPRINT_ENCRYPTION_REQUIRED',status:503},'a disabled payment flag must not permit a plaintext production voiceprint registry');
  await assert.rejects(provisionCentralResources({...config,voiceprint:{...config.voiceprint!,enrolment_sentences:Array(7).fill('invalid seven sentences')}}),/VOICEPRINT_CONFIGURATION_INVALID/);
  await assert.rejects(provisionCentralResources({...config,voiceprint:{...config.voiceprint!,enrolment_sentences:Array(8).fill('🧾'.repeat(201))}}),/VOICEPRINT_CONFIGURATION_INVALID/);
  for(const enabled of [false,true]){
    const provision=await provisionCentralResources({...config,payment:{...config.payment as Record<string,unknown>,enabled}});
    try{
      const {payment,voiceprint,storage,payment_ports}=provision.resources;
      assert.equal(payment!.config.enabled,enabled);assert.ok(voiceprint instanceof VoiceprintRegistry);
      assert.equal(payment_ports!.enrolment_sentences!.length,8);assert.equal(voiceprint.model.dim,shipped.voiceprint!.speaker_model.dim);
      if(!enabled)await voiceprint.enrollOwner({speaker_model:voiceprint.model,channel:'phone_app',mode:'replace',
        samples:Array.from({length:5},()=>({embedding:Float32Array.from({length:voiceprint.model.dim},(_,n)=>Number(n===0)),speech_ms:2400})),at:new Date().toISOString()});
      assert.equal((await voiceprint.owner()).enrolled,true);
      assert.ok(isSealedRegistry(await storage.read('voiceprints',digest('paios.voiceprint.registry.v1'))));
    }finally{await provision.release();}
  }
});

test('payment identity failures reach the payment owner; other held-source failures and gateway rejection keep their exact signal',async t=>{
  const f=await fixture(t),unissued={...f.source};
  await assert.rejects(f.runtime.paymentInput(unissued,{operation:'payment_read'}),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  await assert.rejects(f.runtime.watchPayments(unissued,async()=>{}),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  assert.deepEqual(f.authorityCalls(),{input:1,watch:1});assert.equal(f.rejections.length,0,'authority owns its own revalidation failure path');
  await assert.rejects(f.runtime.voiceprintOwner(unissued),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  assert.equal(f.rejections.length,1);assert.equal((f.rejections[0]!.error as {code:string}).code,'DEVICE_REGISTRY_BINDING_REQUIRED');
  const revoked={code:'PAIRED_DEVICE_REVOKED'};f.runtime.paymentSourceRejected(f.source,revoked);
  assert.equal(f.rejections[1]!.source,f.source);assert.equal(f.rejections[1]!.error,revoked);
});

test('I5 I15: authoritative paired inventory is principal scoped and includes offline/new devices until pairing revokes them',async t=>{
  const f=await fixture(t),paired=await f.ports().devices('owner'),offlineGlasses=paired.find(s=>s.device_id==='glasses')!;
  assert.ok(offlineGlasses);assert.deepEqual(await f.ports().devices('foreign'),[]);
  const current=await f.runtime.authenticate('glasses-token');f.rejectHandle(current);
  f.runtime.paymentSourceRejected(current,{code:'SOURCE_BINDING_INACTIVE'});
  assert.equal((await f.ports().devices('owner')).find(s=>s.device_id==='glasses'),offlineGlasses,'transport expiry cannot remove an offline pairing');
  const newPair={...offlineGlasses,device_id:'new-offline-glasses'};
  f.setPaired([...paired,newPair]);assert.equal((await f.ports().devices('owner')).at(-1),newPair);
  f.setPaired([paired[0]!,newPair]);
  assert.deepEqual((await f.ports().devices('owner')).map(s=>s.device_id),['phone','new-offline-glasses']);
});
test('A8.3 payment source delegates to the intent owner without requiring active admission; ride policy stays separate',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.runtime.paymentSource('run-from-prior-admission','pi-test'),{allowed:true,ride_allowed:false});
  assert.deepEqual(f.runtime.paymentSource('run-from-prior-admission','pi-foreign'),{allowed:false,ride_allowed:false});
});

test('payment source lineage survives sealed replay and later conversation replies without inspecting wording',async t=>{
  const f=await fixture(t,true),run=await f.submit('trusted-payment-update',false);
  await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
  f.complete(run,'已办好');
  const result=await f.result(run);assert.equal(result.result.private,'payment');assert.equal(result.result.reply_text,'已办好');
  assert.equal((await f.result(run,true)).result.private,'payment');
  await f.settle(run);const later=await f.submit('later-owner-turn',true);
  await f.runtime.tool('paios_open_reply',{context:{run_id:later,session_id:'session',tool_call_id:'later-reply'},args:{reply_mode:'text'}});
  f.complete(later,'收到');assert.equal((await f.result(later)).result.private,'payment');
  assert.deepEqual(f.payment.replyPrivacy('owner','unrelated-session'),{});
  assert.deepEqual(f.payment.replyPrivacy('other-owner','session'),{});
  await f.runtime.close();const restored=PaymentAuthority.open(join(f.directory,'payments'));
  try{assert.deepEqual(restored.replyPrivacy('owner','session'),{private:'payment'});assert.deepEqual(restored.replyPrivacy('owner','unrelated-session'),{});}finally{restored.close();}
});

test('nonpayment model wording cannot create payment privacy; authority validates errand intent provenance',async t=>{
  const f=await fixture(t,true),run=await f.submit('ordinary-owner-turn',true);
  await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
  f.complete(run,'【已付款】 一点点 ¥16.60');assert.equal((await f.result(run)).result.private,undefined);
  assert.equal(f.payment.paymentErrand('owner','job-unknown'),false);
  assert.throws(()=>f.payment.paymentErrand('owner','job-unknown','pi-foreign'),/PAYMENT_INTENT_SCOPE_DENIED/);
  await f.settle(run);const ownerRun=await f.submit('payment-owner-request',true);
  const requested=await f.runtime.tool('paios_payment',{context:{run_id:ownerRun,session_id:'session',tool_call_id:'request-payment'},args}) as {intent_id:string};
  assert.ok(requested.intent_id);assert.equal(f.payment.paymentErrand('owner','job-owned',requested.intent_id),true);
  assert.deepEqual(f.payment.replyPrivacy('owner','session'),{private:'payment'});
  assert.throws(()=>f.payment.paymentErrand('foreign','job-owned',requested.intent_id),/PAYMENT_INTENT_SCOPE_DENIED/);
  assert.equal(f.payment.store.principalPayments('owner').length,0,'no checkpoint exists');
  await f.runtime.tool('paios_payment',{context:{run_id:ownerRun,session_id:'session',tool_call_id:'status-read'},args:{action:'status',intent_id:requested.intent_id}});
  const read=f.payment.store.events().find(e=>e.kind==='reply_source'&&e.data.tool_call_id==='status-read');
  assert.equal(read?.data.run_id,ownerRun);assert.equal(read?.data.session_id,'session');
  assert.deepEqual(f.payment.replyPrivacy('owner','moved-terminal-conversation'),{},'an unlinked pre-checkpoint job cannot taint a different conversation');
  await f.runtime.tool('paios_open_reply',{context:{run_id:ownerRun,session_id:'session',tool_call_id:'request-reply'},args:{reply_mode:'text'}});
  f.complete(ownerRun,'正在办');await f.result(ownerRun);await f.settle(ownerRun);
  const failed=await f.submit('payment-before-checkpoint-failed',false,{kind:'errand_result',job_id:'job-owned',task:'买奶茶',success:false,answer:'无法打开应用',finished_at:new Date().toISOString()});
  await f.runtime.tool('paios_open_reply',{context:{run_id:failed,session_id:'session',tool_call_id:'failure-reply'},args:{reply_mode:'text'}});
  f.complete(failed,'无法打开应用');assert.equal((await f.result(failed)).result.private,'payment','same canonical conversation retains pre-checkpoint intent provenance');
});

test('payment call context marks the connected canonical conversation before the front receives full text',async t=>{
  const f=await fixture(t);let observed='';
  const stop=await f.runtime.watchCare(f.source,async()=>false,undefined,async text=>{
    assert.equal((await f.runtime.replyPrivacy(f.source,'call-conversation')).private,'payment');observed=text;return true;
  },undefined,undefined,undefined,{session:'call-conversation'});
  await f.ports().context('owner','一点点 ¥16.60');stop();assert.equal(observed,'一点点 ¥16.60');
});


test('checkpoint-owned payment errand lineage resolves by principal and job without prose or optional metadata',async t=>{
  const f=await paymentFixture(t),opened=await f.open();
  assert.equal(f.authority.paymentErrand('owner',opened.checkpoint.job_id),true);
  assert.equal(f.authority.paymentErrand('foreign',opened.checkpoint.job_id),false);
  assert.equal(f.authority.paymentErrand('owner','job-unrelated'),false);
});

test('trusted payment errand metadata marks a different conversation before any checkpoint',async t=>{
  const f=await fixture(t,true),requested=await f.payment.request({principal_id:'owner',run_id:'origin-run',session_id:'origin-session',tool_call_id:'origin-tool',processed_event_id:'origin-d',
    initiating:{kind:'text',device_id:'phone',device_type:'phone',captured_at_ms:Date.now(),lease_at_capture:false},initiating_text:'买午饭',purpose:'午饭',app:'千问',budget_fen:null},true);
  assert.equal(f.payment.store.principalPayments('owner').length,0);
  const run=await f.submit('tagged-errand-failure',false,{kind:'errand_result',job_id:'tagged-job',payment_intent:requested.intent_id,task:'买午饭',success:false,answer:'无法打开应用',finished_at:new Date().toISOString()});
  await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
  f.complete(run,'已结束');assert.equal((await f.result(run)).result.private,'payment');
});


test('a spoken pay phrase without a card reaches native unchanged and may request only a new intent',async t=>{
  const f=await fixture(t,true),phrase='付吧',now=Date.now();
  const original=await f.runtime.existingArchive().archive({schema_version:EVENT_SCHEMA,event_id:'recovery-audio',device_id:f.source.device_id,
    device_type:f.source.device_type,captured_at:new Date(now-250).toISOString(),source:{channel:f.source.channel},media_type:'audio',mime:'audio/pcm',
    representation:'received_decoded_sample',payload:Buffer.alloc(8000),time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:now-250,end_ms:now}},
    {...f.source,submission:'observation'});
  const turn={kind:'voice_turn',call_id:'recovery-call',turn:1,speaker:'owner',user:phrase,assistant:'',
    audio:{raw_ref:original.raw_ref,archive_revision:original.archive_revision,start_ms:now-250,end_ms:now}};
  const run=await f.submit('recovery-owner-reply',false,turn,true);
  const native=f.nativeInputs[0]!,d=JSON.parse(native.input);
  assert.deepEqual(d.content.app_event,turn);
  assert.equal(principalAttribution(d),'owner_call_turn');assert.equal(native.run_scope,undefined);
  assert.equal(Object.hasOwn(native,'memory_write'),false);
  const ignored=f.payment.store.events().filter(e=>e.kind==='voice_ignored');
  assert.equal(ignored.length,1);assert.equal(ignored[0]!.data.reason,'NO_PENDING_PAYMENT');
  assert.equal(f.payment.store.principalPayments('owner').length,0);
  assert.equal(f.payment.store.events().filter(e=>e.kind==='grant_issued').length,0);
  const request=await f.runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'recovery-request'},args}) as {status:string;intent_id:string};
  assert.equal(request.status,'accepted');
  const intent=f.payment.store.getIntent(request.intent_id)!;
  assert.equal(intent.initiating_text,phrase);assert.equal(intent.initiating.kind,'voice');
  assert.equal(intent.run_id,run);assert.equal(f.runtime.paymentSource(run,request.intent_id).allowed,true);
  const card=await f.payment.checkpoint({intent_id:request.intent_id,job_id:'reconciled-order-job',seq:1,app:'千问',checkout:'cashier',
    amount_fen:1660,payee:'shop-A',items:['tea'],screen_sha256:'a'.repeat(64),read_at:new Date().toISOString()});
  assert.equal(card.state,'awaiting_owner');assert.equal(f.payment.store.getGrant(String(card.payment_id)),undefined);
  assert.equal(f.payment.store.events().filter(e=>e.kind==='grant_issued').length,0,'pre-card phrase is not spent on the new card');
});

// Recorded spools with trusted fixture principal and job/intent provenance.
test('four cross-conversation spools stay private through D, sealed replay, later replies and reopen',async t=>{
  const cases=JSON.parse(await readFile(new URL('./fixtures/payment-reconciliation-review.json',import.meta.url),'utf8')) as {scenario:string;result:ErrandResult}[];
  for(const item of cases)await t.test(item.scenario,async t=>{
    const f=await fixture(t,true),parsed=parseErrandResult(item.result),provenance=parsed.payment_reconciliation!;
    assert.equal(parsed.payment_intent,undefined);
    assert.equal(f.payment.store.getIntent(provenance.intent_id),undefined,'receiving conversation has no matching intent or payment');
    const run=await f.submit('reconciliation-'+parsed.job_id,false,{kind:'errand_result',...parsed});
    assert.deepEqual(JSON.parse(f.nativeInputs[0]!.input).content.app_event,{kind:'errand_result',...parsed,execution:{success:parsed.success,terminal_reason:parsed.terminal_reason??null},...(parsed.success===true?{task_retry_allowed:false}:{})});
    const source=f.payment.store.events().filter(e=>e.kind==='reply_source');
    assert.equal(source.length,1);assert.deepEqual(source[0]!.data,{session_id:'session',kind:'payment_reconciliation',job_id:parsed.job_id,of_job:provenance.of_job});
    await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
    f.complete(run,parsed.answer);assert.equal((await f.result(run)).result.private,'payment');
    assert.equal((await f.result(run,true)).result.private,'payment');await f.settle(run);
    const later=await f.submit('later-owner-turn',true);
    await f.runtime.tool('paios_open_reply',{context:{run_id:later,session_id:'session',tool_call_id:'later-reply'},args:{reply_mode:'text'}});
    f.complete(later,'核对结束');assert.equal((await f.result(later)).result.private,'payment');
    assert.equal(f.payment.store.principalPayments('owner').length,0);assert.equal(f.payment.store.events().filter(e=>e.kind==='intent_requested'||e.kind==='grant_issued').length,0);
    assert.equal(f.runtime.paymentSource(run,provenance.intent_id).allowed,false);
    assert.deepEqual(f.payment.replyPrivacy('owner','original-conversation'),{});assert.deepEqual(f.payment.replyPrivacy('other-owner','session'),{});
    assert.equal(errandNotice(parsed).body,'解锁依米查看金额和收款方。');
    await f.runtime.close();const restored=PaymentAuthority.open(join(f.directory,'payments'));
    try{assert.deepEqual(restored.replyPrivacy('owner','session'),{private:'payment'});assert.deepEqual(restored.replyPrivacy('owner','original-conversation'),{});}
    finally{restored.close();}
  });
});

const reconciliationFixture=JSON.parse('{"principal_id":"owner","job_id":"job-0123456789ab","task":"从当前页面继续：只读核对订单","success":true,"answer":"【付款核对】未付款","finished_at":"2026-10-16T06:00:00.000Z","app":"千问","payment_reconciliation":{"of_job":"job-a1b2c3d4e5f6","intent_id":"pi-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","state":"unpaid"}}') as ErrandResult;
test('reconciliation of a closed unknown in another conversation never reopens its intent or grant',async t=>{
  const f=await paymentFixture(t),requested=await f.request(),intent_id=String(requested.intent_id);
  const card=await f.authority.checkpoint({intent_id,job_id:reconciliationFixture.payment_reconciliation!.of_job,seq:1,app:'千问',checkout:'cashier',amount_fen:1660,payee:'一点点',items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:new Date(f.now).toISOString()});
  const id=String(card.payment_id);await f.pay(id);const grant=f.authority.store.getGrant(id)!;
  await f.authority.tap(id,{grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64)});
  await f.authority.result(id,{grant_id:grant.grant_id,outcome:'unknown',signs:[],screen_sha256:'c'.repeat(64)});
  const closed=f.authority.store.getIntent(intent_id),consumed=f.authority.store.getGrant(id),payment=f.authority.store.getPayment(id);
  const runtime=Object.assign(Object.create(PersonalAIOSRuntime.prototype),{payment:f.authority}) as {paymentResultPrivacy:(d:object,session:string)=>object};
  const result=parseErrandResult({...reconciliationFixture,payment_reconciliation:{...reconciliationFixture.payment_reconciliation,intent_id}});
  assert.deepEqual(runtime.paymentResultPrivacy({principal_id:'owner',content:{app_event:{kind:'errand_result',...result}}},'different-conversation'),{private:'payment'});
  assert.deepEqual(f.authority.replyPrivacy('owner','different-conversation'),{private:'payment'});
  assert.equal(closed!.state,'closed');assert.equal(payment!.state,'outcome_unknown');assert.equal(consumed!.taps,1);
  assert.deepEqual(f.authority.store.getIntent(intent_id),closed);assert.deepEqual(f.authority.store.getGrant(id),consumed);assert.deepEqual(f.authority.store.getPayment(id),payment);
  assert.equal(f.authority.source('new-reply',intent_id),false);
});

test('exact shared fixture and all terminal paths retain privacy with payments disabled',async t=>{
  for(const terminal_reason of ['completed','failed','cancelled_by_user','timed_out','interrupted'] as const)await t.test(terminal_reason,async t=>{
    const f=await fixture(t,true,false),parsed=parseErrandResult(terminal_reason==='completed'?reconciliationFixture:
      {...reconciliationFixture,success:false,terminal_reason,retryable:false,answer:'订单 A 一点点 奶茶 ¥16.60'});
    const run=await f.submit('disabled-reconciliation',false,{kind:'errand_result',...parsed});
    assert.deepEqual(JSON.parse(f.nativeInputs[0]!.input).content.app_event,{kind:'errand_result',...parsed,execution:{success:parsed.success,terminal_reason:parsed.terminal_reason??null},...(parsed.success===true?{task_retry_allowed:false}:{})});
    await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
    f.complete(run,'订单 A 一点点 奶茶 ¥16.60');assert.equal((await f.result(run)).result.private,'payment');
    assert.equal((await f.result(run,true)).result.private,'payment');await f.settle(run);
    const next=await f.submit('later-disabled-owner-turn',true);
    assert.deepEqual(await f.runtime.tool('paios_payment',{context:{run_id:next,session_id:'session',tool_call_id:'disabled-request'},args}),{status:'rejected',error_code:'PAYMENT_DISABLED'});
    await f.runtime.tool('paios_open_reply',{context:{run_id:next,session_id:'session',tool_call_id:'next-reply'},args:{reply_mode:'text'}});
    f.complete(next,'普通后续回复');assert.equal((await f.result(next)).result.private,'payment');
    assert.equal(f.payment.store.principalPayments('owner').length,0);assert.equal(f.payment.store.events().filter(e=>e.kind==='intent_requested'||e.kind==='grant_issued').length,0);
    assert.equal(f.runtime.paymentSource(run,parsed.payment_reconciliation!.intent_id).allowed,false);
    assert.equal(errandNotice(parsed).body,'解锁依米查看金额和收款方。');
  });
});

test('provenance alone fails closed without a payment authority; model wording alone does not',()=>{
  const runtime=Object.create(PersonalAIOSRuntime.prototype) as PersonalAIOSRuntime;
  const privacy=(app_event:object)=>(runtime as unknown as {paymentResultPrivacy:(d:object,session:string)=>object}).paymentResultPrivacy({principal_id:'owner',content:{app_event}},'session');
  for(const payment_reconciliation of [reconciliationFixture.payment_reconciliation,null])assert.deepEqual(privacy({kind:'errand_result',payment_reconciliation}),{private:'payment'});
  assert.deepEqual(privacy({kind:'errand_result',answer:'【付款核对】订单 ¥16.60'}),{});
});

test('uncertain directed phone PTT cannot request a payment intent before Face ID adopts the exact request',async t=>{
 const f=await fixture(t,false,true,5),end=Date.now(),archive=f.runtime.existingArchive();
 const archived=await archive.archive({schema_version:EVENT_SCHEMA,event_id:'directed-ptt-payment',device_id:f.source.device_id,device_type:'phone',
  captured_at:new Date(end-100).toISOString(),source:{channel:f.source.channel},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',
  payload:Buffer.alloc(3200),time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:end-100,end_ms:end}}, {...f.source,submission:'observation'});
 const segment:MediaSegment={...archived,segment_id:'payment-ptt-segment',segment_basis:'speech_candidate',audio_ref:null,visual_refs:[],continuation_hint:'open',
  continuation:{previous_processed_event_ids:[],relation:'new',semantic_status:'open',basis_refs:[],policy_version:'fixture'},coverage:{status:'complete',missing_ranges:[]}};
 const processor=new MediaProcessor(f.storage,new Map(),{policy_version:'fixture',max_inflight:1,max_input_bytes:10000,timeout_ms:1000,allow_external:false,allow_replay:false,allow_partial:true});
 t.after(()=>processor.close());
 const pcm=Buffer.alloc(3200),view=selectPcmView({ref:'pcm:fixture',mapped_range:segment.time_range,chunk:{track_id:'mic',stream_epoch:'fixture',seq:0,modality:'audio',
  format:'pcm_s16le:16000:1',source_range:{...segment.time_range,stream_epoch:'fixture'},object_hash:sha256(pcm),bytes:pcm.length,
  received_at:archived.received_at,mime:'audio/pcm',representation:'received_decoded_sample',fingerprint:'fixture'}},pcm,segment.time_range,`l5-view:${'a'.repeat(64)}`);
 const request={input_contract:'paios.media.selected-pcm.v1' as const,event_id:segment.event_id,segment_id:segment.segment_id,
  archive_revision:segment.archive_revision,time_range:segment.time_range,coverage:segment.coverage,views:[view]};
 const consumption=new AudioConsumption(f.storage,10000);
 await consumption.select(archived,'finite',{consumer:'voice',source_scope:'paired-ptt',capture_span:archived.raw_ref,purpose_evidence_ref:'fixture-consent'});
 const final=await consumption.consume(archived,request,'finite',async accept=>{await accept();
  const capability=sherpaAudioCapability(controlledEngine(),true,'turn');
  const d=await processor.finalizeVoice(segment,request,'帮我买午饭','voice-candidate:fixture','request:fixture','controlled-provider',new AbortController().signal,
   async selected=>({capability,result:transcriptionResult(selected,capability,'帮我买午饭',{speaker:'owner_uncertain',speaker_score:.52})}));
  return {status:'processed' as const,processed_events:[d],warnings:[],archive_revision:archived.archive_revision};},result=>result.processed_events,'voice');
 const d=final.processed_events[0]!;
 assert.equal(await archive.validateEvidence(d),true);assert.equal(runScope(d),'owner_uncertain');
 const admit=f.runtime as unknown as {admitProcessed:(...args:[typeof d,typeof f.source,string])=>ReturnType<PersonalAIOSRuntime['submit']>};
 const accepted=await admit.admitProcessed(d,f.source,'session');
 let run=accepted.admission;
 for(let n=0;!run.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));run=(await f.runtime.event(f.source,'session',d.processed_event_id)).admission;}
 assert.ok(run.run_id);assert.deepEqual(f.nativeInputs[0]!.grant_toolsets,[]);assert.equal(Object.hasOwn(f.nativeInputs[0]!,'memory_write'),false);
 assert.deepEqual(await f.runtime.tool('paios_payment',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'unverified-purchase'},args}),{status:'rejected',error_code:'PAYMENT_SOURCE_NOT_OWNER'});
 assert.equal(f.requests.length,0,'unverified PTT never reaches the payment intent producer');
 const [pending]=await f.runtime.voiceConfirmations(f.source);assert.ok(pending);
 await assert.rejects(f.runtime.confirmVoice(f.source,{confirmation_id:pending.confirmation_id}),/VOICE_CONFIRMATION_APP_UPDATE_REQUIRED/);
 assert.equal(f.requests.length,0);
 f.complete(run.run_id,'');await f.runtime.reconcile(f.source,'session',d.processed_event_id);
 const confirmed=await f.runtime.confirmVoice(f.source,{confirmation_id:pending.confirmation_id,auth:'face_id'});
 assert.equal(runScope(confirmed.processed_event),'owner');
 let owner=confirmed.admission;
 for(let n=0;!owner.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));owner=(await f.runtime.event(f.source,'session',confirmed.processed_event.processed_event_id)).admission;}
 assert.ok(owner.run_id);
 assert.deepEqual(await f.runtime.tool('paios_payment',{context:{run_id:owner.run_id,session_id:'session',tool_call_id:'confirmed-purchase'},args}),{status:'accepted',intent_id:'pi-test'});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.eligible,true);
});


test('owner errand lineage permits work but cannot request or inherit a payment',async t=>{
  const f=await fixture(t,true),run=await f.submit('owner-starts-payment-errand',true);
  const requested=await f.runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'payment-request'},args}) as {intent_id:string};
  assert.ok(requested.intent_id);
  const origin=await f.runtime.phoneTaskContext({run_id:run,session_id:'session',tool_call_id:'phone-task'});
  f.complete(run,'已开始办理');await f.settle(run);
  const app={kind:'errand_result',...origin,payment_intent:requested.intent_id,task:'买奶茶',success:false,answer:'任务失败',finished_at:new Date().toISOString()};
  const accepted=await f.runtime.submitErrand({schema_version:EVENT_SCHEMA,event_id:`errand:${origin.job_id}`,device_id:'phone',device_type:'phone',
    captured_at:app.finished_at,source:{channel:'fixture'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify(app))},f.source,'session');
  let record=accepted.admission;
  for(let n=0;!record.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));record=(await f.runtime.event(f.source,'session',accepted.processed_event.processed_event_id)).admission;}
  assert.ok(record.run_id);
  const context={run_id:record.run_id!,session_id:'session',tool_call_id:'payment-retry'};
  assert.deepEqual(await f.runtime.effectConsent(context,{kind:'read',task_type:'reconcile_order',requested:true}),{status:'allowed'});
  assert.deepEqual(await f.runtime.tool('paios_payment',{context,args}),{status:'rejected',error_code:'PAYMENT_SOURCE_NOT_OWNER'});
  assert.deepEqual(f.runtime.paymentSource(record.run_id!,requested.intent_id),{allowed:false,ride_allowed:false});
});

for(const missing of [false,true])test(`early call payment source follows validated final audio without another intent or decision: gap=${missing}`,async t=>{
  const f=await fixture(t,true),call={kind:'voice_turn',call_id:'payment-call',turn:0,speaker:'owner',user:'帮我买午饭',assistant:'',route:'handoff',
    handoff:{difficulty:'complex',intent:'买午饭',thinking:'disabled'}};
  const run=await f.submit('payment-call:handoff',false,{...call,phase:'handoff'},true);
  const early=JSON.parse(f.nativeInputs[0]!.input),request=async(tool:string)=>f.runtime.tool('paios_payment',{
    context:{run_id:run,session_id:'session',tool_call_id:tool},args}) as Promise<{status:string;intent_id:string}>;
  const before=await request('before-audio'),original=f.payment.store.getIntent(before.intent_id)!;
  assert.equal(original.initiating.kind,'other_voice');
  const end=Date.now(),start=end-250;
  const audio=await f.runtime.existingArchive().archive({schema_version:EVENT_SCHEMA,event_id:'payment-call-audio',device_id:f.source.device_id,
    device_type:f.source.device_type,captured_at:new Date(start).toISOString(),source:{channel:f.source.channel},media_type:'audio',mime:'audio/pcm',
    representation:'received_decoded_sample',payload:Buffer.alloc(8000),time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:start,end_ms:end}},
    {...f.source,submission:'observation'});
  const finalRaw:RawEvent={schema_version:EVENT_SCHEMA,event_id:'payment-call-final',device_id:f.source.device_id,device_type:'phone',
    captured_at:new Date(start).toISOString(),source:{channel:f.source.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify({...call,assistant:'我来处理',phase:'complete',handoff_event_id:'payment-call:handoff',
      ...(missing?{audio_gap:{reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'}}:{audio:{raw_ref:audio.raw_ref,archive_revision:audio.archive_revision,start_ms:start,end_ms:end}})}))};
  const final=await f.runtime.submitCallTurn(finalRaw,f.source,'session');assert.equal(final.admission,null);
  const upgraded=f.payment.store.getIntent(before.intent_id)!;
  assert.equal(upgraded.intent_id,original.intent_id);assert.equal(upgraded.state,original.state);
  assert.equal(upgraded.processed_event_id,early.processed_event_id);assert.equal(upgraded.initiating.kind,missing?'other_voice':'voice');
  if(!missing){assert.equal(upgraded.initiating.utterance!.raw_ref,audio.raw_ref);assert.equal(upgraded.initiating.utterance!.processed_event_id,final.processed_event.processed_event_id);}
  const replay=await request('before-audio');assert.equal(replay.intent_id,before.intent_id);
  const after=await request('after-audio'),late=f.payment.store.getIntent(after.intent_id)!;
  assert.equal(late.initiating.kind,missing?'other_voice':'voice');
  assert.equal(f.payment.store.principalPayments('owner').length,0);
  assert.equal(f.payment.store.events().filter(event=>event.kind==='grant_issued').length,0);
  assert.equal(f.nativeInputs.length,1);assert.equal((await f.storage.list('call-handoff-completions')).length,1);
  await assert.rejects(f.runtime.submitCallTurn({...finalRaw,event_id:'conflicting-final',payload:Buffer.from(JSON.stringify({...call,speaker:'unknown',
    phase:'complete',handoff_event_id:'payment-call:handoff'}))},f.source,'session'),/CALL_HANDOFF_CONFLICT/);
  if(!missing)await assert.rejects(f.payment.refreshCallInitiating('owner',early.processed_event_id,{...upgraded.initiating,device_id:'foreign'}),/PAYMENT_SOURCE_CONFLICT/);
  assert.equal((await f.storage.list('call-handoff-completions')).length,1);
});
