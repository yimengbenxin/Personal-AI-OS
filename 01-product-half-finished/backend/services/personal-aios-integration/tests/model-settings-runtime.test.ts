import {ModelUsage} from '../src/model-usage.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,sourceClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {PHONE_CAPABILITIES,StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {EVENT_SCHEMA,sha256,ContractError} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';
import {keyPair,signed} from './payment-fixture.ts';
async function fixture(t:TestContext,activationHook?:(group:'brain'|'build',revision:number,authority:ModelSettingsAuthority)=>Promise<void>){
  const home=await mkdtemp(join(tmpdir(),'model-runtime-')),storage=new PosixStorage(home),observed=Promise.withResolvers<void>();
  const native=sourceClient({create:async()=>({run_id:'run',session_id:'session',conversation_session_id:'session',status:'running'}),
    status:async()=>{observed.resolve();return {run_id:'run',session_id:'session',conversation_session_id:'session',status:'running'};},
    cancel:async()=>({run_id:'run',session_id:'session',conversation_session_id:'session',status:'cancelled'})});
  const payment=PaymentAuthority.open(join(home,'payment')),user=keyPair();
  payment.store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run('phone','user','owner',user.public_x963_b64,Date.now());
  let busy=false,broken=false,activations=0,usage:ModelUsage|undefined;
  const authority=ModelSettingsAuthority.open(join(home,'models'),{environment_id:'test',master_key:Buffer.alloc(32,7),activate:async(group,revision,owner)=>{
    activations++;if(busy)throw Object.assign(Error('busy'),{code:'MODEL_SETTINGS_BUSY'});if(broken)throw Error('ACTIVATE_FAILED');
    await activationHook?.(group,revision,owner);},
    onAction:draft=>{if(draft.action==='resume')usage!.resume('test','owner');
      if(draft.action==='pause')usage!.setPausePolicy('test','owner',draft.payload.pause_on_limit===true,draft.payload.owner_reserve_cny as number|undefined);}});
  const providers=[{id:'custom',display_name:'Custom',wire_protocol:'chat_completions' as const,base_url:'https://example.test/v1',credential_ref:'custom'}];
  const roles=[{id:'main',profile:'owner',provider_ref:'custom',model_id:'old',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle' as const}];
  authority.bootstrap({providers,roles},{custom:'fixture-fake-key-1234'});
  const devices=[{principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('fixture')}];
  const sourceAuthority=new StaticFixtureDeviceAuthority(devices);let revoked=false;
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'test',max_read_bytes:8192,payment,payment_devices:async()=>devices.map(({token_sha256,...device})=>device),
    sourceAuthority:{authenticate:credential=>sourceAuthority.authenticate(credential),revalidate:async source=>{
      if(revoked)throw new ContractError('PAIRED_DEVICE_REVOKED',403);return sourceAuthority.revalidate(source);}}});
  runtime.installModelSettings(authority);const source=await runtime.authenticate('fixture');
  t.after(async()=>{await runtime.close();authority.close();await rm(home,{recursive:true,force:true});});
  const admit=async()=>{await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'input',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('请修改我的主模型')},source,'session',true);await observed.promise;};
  const execute=async(draft:ReturnType<ModelSettingsAuthority['draft']>)=>{const {nonce}=await payment.keys.challenge(source,'model_settings');
    return runtime.modelSettingsControl(source,{operation:`model_settings_${draft.action}`,request:{draft_id:draft.draft_id},...signed(user,{purpose:'model_settings',device_id:source.device_id,nonce,
      ...Object.fromEntries(['action','draft_id','expected_revision','change_sha256','expires_at_ms','principal_id'].map(key=>[key,draft[key as keyof typeof draft]]))})});};
  usage=new ModelUsage(authority.db,{notify:async()=>{},resumeWork:()=>runtime.resumeModelUsageWork()});
  return {runtime,authority,source,roles,admit,execute,usage,activations:()=>activations,revoke:()=>{revoked=true;},busy:(value:boolean)=>{busy=value;},broken:()=>{broken=true;}};
}
test('signed budget settings and resume remain independent of an unavailable brain with pending activation',async t=>{
 const f=await fixture(t);f.runtime.installModelUsage(f.usage,'test');f.broken();
 const route=f.authority.draft(f.source,{expected_revision:1,roles:[{...f.roles[0]!,model_id:'broken'}]});
 f.authority.commitDraft(f.source,route.draft_id,'pending');
 const pause=f.authority.draft(f.source,{action:'pause',expected_revision:2,pause_on_limit:true,owner_reserve_cny:1});
 const page=await f.runtime.modelSettingsControl(f.source,{operation:'model_settings_read',request:{draft_id:pause.draft_id}}) as {draft:{payload:{pause_on_limit:boolean}}};
 assert.equal(page.draft.payload.pause_on_limit,true);await f.execute(pause);
 assert.equal(f.usage.summary('test','owner').pause_on_limit,true);assert.equal(f.usage.admission('test','owner',false).allowed,true);
 await f.usage.record({attempt_id:'limit',request_id:'limit',environment:'test',owner:'owner',provider_id:'custom',model_id:'old',role:'brain',revision:'1',owner_chat:false,
  captured_at:new Date().toISOString(),status:'completed',input_tokens:1,output_tokens:1,cost:{kind:'known',amount:11,currency:'CNY'}});
 assert.equal(f.usage.admission('test','owner',false).allowed,false);
 const resume=f.authority.draft(f.source,{action:'resume',expected_revision:3});await f.execute(resume);
 assert.equal(f.usage.admission('test','owner',false).allowed,true);assert.equal(f.usage.summary('test','owner').pause_on_limit,true);
 assert.equal(f.activations(),0);assert.equal(f.authority.read().groups.brain.effective,1);
 const off=f.authority.draft(f.source,{action:'pause',expected_revision:4,pause_on_limit:false});await f.execute(off);
 assert.equal(f.usage.summary('test','owner').pause_on_limit,false);assert.equal(f.activations(),0);
});
test('runtime signed commit activates only through native idle gate; retry and failure preserve true effective revision',async t=>{
  const f=await fixture(t);f.busy(true);
  const draft=f.authority.draft(f.source,{expected_revision:1,providers:[],roles:[{...f.roles[0]!,model_id:'new'}],change_summary:'new model'});
  const saved=await f.execute(draft) as {groups:{brain:{status:string;effective:number}}};
  assert.equal(saved.groups.brain.status,'pending');assert.equal(saved.groups.brain.effective,1);
  f.busy(false);await f.runtime.applyModelSettings();assert.equal(f.authority.read().groups.brain.effective,2);
  f.broken();const next=f.authority.draft(f.source,{expected_revision:2,providers:[],roles:[{...f.roles[0]!,model_id:'broken'}],change_summary:'broken'});
  const failed=await f.execute(next) as {groups:{brain:{status:string;effective:number}}};assert.equal(failed.groups.brain.status,'failed');assert.equal(failed.groups.brain.effective,2);
});
test('runtime metadata watch is bounded and detaches on close',async t=>{
  const f=await fixture(t),first=Promise.withResolvers<void>(),views:Record<string,unknown>[]=[];
  await f.runtime.modelSettingsWatch(f.source,async state=>{views.push(state);first.resolve();});await first.promise;
  assert.deepEqual(Object.keys(views[0]!).sort(),['desired','environment_id','groups']);await f.runtime.close();
  f.authority.draft(f.source,{expected_revision:1,providers:[],roles:[],change_summary:'unchanged'});assert.equal(views.length,1);
});
test('active owner chat tools expose redacted pages and frozen signed UI draft, never keys or an applied mutation',async t=>{
  const f=await fixture(t);await f.admit();const context={run_id:'run',session_id:'session',tool_call_id:'settings'};
  const read=await f.runtime.tool('paios_model_settings_read',{context,args:{}}) as Record<string,unknown>;
  assert.equal(read.settings_entry,'模型与密钥');assert.ok(!JSON.stringify(read).includes('fixture-fake-key'));
  const draft=await f.runtime.tool('paios_model_settings_draft',{context,args:{expected_revision:1,providers:[],roles:[{...f.roles[0]!,model_id:'draft-model'}],change_summary:'change'}}) as {status:string;draft:{draft_id:string}};
  assert.equal(draft.status,'awaiting_owner_signature');assert.ok(draft.draft.draft_id);assert.equal(f.authority.read().desired,1);
  await assert.rejects(f.runtime.tool('paios_model_settings_draft',{context,args:{expected_revision:1,providers:[],roles:[],change_summary:'bad',key:'forbidden'}}),/UNKNOWN_TOOL_ARGUMENT/);
  await assert.rejects(f.runtime.tool('paios_model_settings_draft',{context,args:{action:'authorize_mac',expected_revision:1,device_id:'mac',public_x963_b64:'bad'}}),/UNKNOWN_TOOL_ARGUMENT/);
  assert.equal((await f.runtime.tool('paios_model_settings_read',{context:{...context,run_id:'unbound'},args:{}}) as {error_code:string}).error_code,'RUN_BINDING_PENDING');
});

test('watch source revocation is revalidated, surfaced and detached before another publication',async t=>{
  const f=await fixture(t),first=Promise.withResolvers<void>(),rejected=Promise.withResolvers<void>();let views=0,errors=0;
  t.mock.method(process.stderr,'write',(text:unknown)=>{const event=JSON.parse(String(text));
    assert.equal(event.kind,'model_settings_watch');assert.equal(event.code,'PAIRED_DEVICE_REVOKED');errors++;rejected.resolve();return true;});
  await f.runtime.modelSettingsWatch(f.source,async()=>{views++;first.resolve();});await first.promise;f.revoke();
  const draft=f.authority.draft(f.source,{expected_revision:1,providers:[],roles:[],change_summary:'invalidate'});
  f.authority.commitDraft(f.source,draft.draft_id,'nonce');await rejected.promise;
  await f.runtime.applyModelSettings();await new Promise<void>(done=>setImmediate(done));assert.equal(views,1);assert.equal(errors,1);
});


test('formal model settings read exposes only authenticated owner spend through the shared bounded projection',async t=>{
  const f=await fixture(t),now=Date.parse('2026-10-24T08:00:00Z');
  const usage=new ModelUsage(f.authority.db,{now:()=>now,notify:async()=>{}});
  f.runtime.installModelUsage(usage,f.authority.environment_id);
  const attempt={request_id:'logical',environment:f.authority.environment_id,provider_id:'custom',model_id:'old',role:'brain',revision:'1',
    owner_chat:true,captured_at:new Date(now).toISOString(),status:'completed' as const,input_tokens:10,output_tokens:2,
    cost:{kind:'known' as const,amount:3.25,currency:'CNY'}};
  await usage.record({...attempt,attempt_id:'own-spend',owner:'owner'});
  await usage.record({...attempt,attempt_id:'other-spend',owner:'other-owner',cost:{...attempt.cost,amount:90}});
  const read=await f.runtime.modelSettingsControl(f.source,{operation:'model_settings_read'}) as {usage:ReturnType<ModelUsage['summary']>};
  assert.equal(read.usage.owner,'owner');assert.equal(read.usage.known_cny,3.25);assert.equal(read.usage.attempts,1);
  assert.equal(read.usage.subscription_remaining,'套餐余量未知');assert.ok(Buffer.byteLength(JSON.stringify(read))<=8000);
  assert.ok(!JSON.stringify(read).includes('other-owner'));assert.ok(!('attempts' in read));
  await f.admit();
  const tool=await f.runtime.tool('paios_model_settings_read',{context:{run_id:'run',session_id:'session',tool_call_id:'usage-read'},args:{}}) as {usage:unknown};
  assert.deepEqual(tool.usage,read.usage);
});


for(const outcome of ['effective','busy','failed'] as const)test(`concurrent signed key rotations drain the newer desired once and stop on ${outcome}`,async t=>{
  const entered=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>(),committed=Promise.withResolvers<void>();
  const revisions:number[]=[];
  const f=await fixture(t,async(group,revision)=>{
    assert.equal(group,'brain');revisions.push(revision);
    if(revision===2){entered.resolve();await ack.promise;}
    if(revision===3&&outcome==='busy')throw Object.assign(Error('busy'),{code:'MODEL_SETTINGS_BUSY'});
    if(revision===3&&outcome==='failed')throw Error('ACTIVATE_FAILED');
  });
  const unwatch=f.authority.watch(()=>{if(f.authority.read().groups.brain.desired===3)committed.resolve();});
  let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined,firstSettled=false,secondSettled=false;
  try{
    const B=f.authority.keyDraft(f.source,{expected_revision:1,credential_ref:'custom',key:'signed-key-B-1234'});
    first=f.execute(B).finally(()=>{firstSettled=true;});await entered.promise;
    const C=f.authority.keyDraft(f.source,{expected_revision:2,credential_ref:'custom',key:'signed-key-C-5678'});
    second=f.execute(C).finally(()=>{secondSettled=true;});await committed.promise;
    await new Promise<void>(done=>setImmediate(done));
    assert.equal(firstSettled,false);assert.equal(secondSettled,false);
    assert.equal(f.authority.read().groups.brain.effective,1);
    const leased=f.authority.resolve('test','owner','main',2);
    assert.equal(f.authority.credential({environment_id:'test',profile:'owner',revision:2,handle:leased.credential_handle!}),'signed-key-B-1234');
    ack.resolve();await Promise.all([first,second]);
    const state=f.authority.read().groups.brain;
    assert.equal(state.desired,3);assert.equal(state.effective,outcome==='effective'?3:2);
    assert.equal(state.status,outcome==='busy'?'pending':outcome);
    assert.deepEqual(revisions,[2,3],'newer desired gets one activation attempt without manual apply');
    await new Promise<void>(done=>setImmediate(done));
    assert.deepEqual(revisions,[2,3],'busy or failed activation does not auto-retry');
  }finally{ack.resolve();unwatch();await Promise.allSettled([first,second].filter((value):value is Promise<unknown>=>!!value));}
});
