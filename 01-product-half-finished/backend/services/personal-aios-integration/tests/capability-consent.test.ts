import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {effectConsent,confirmFrozenEffect} from '../src/effect-consent.ts';
import {PosixStorage} from '../src/storage.ts';
import {ContractError,type ProcessedEvent} from '../src/contracts.ts';
import {VoiceConfirmations,nativeApprovalId} from '../src/voiceprint/confirmation.ts';
import {decideConsent,type ConsentCall,type ConsentPorts} from '../src/capability/consent/decision.ts';
import {CapabilityConfirmations,type ConfirmationPorts} from '../src/capability/consent/confirmation.ts';
import type {FrozenCall} from '../src/capability/consent/call.ts';
import type {AdmissionEntry} from '../src/admission.ts';
import {succeeded,type EffectKind,type Receipt} from '../../../../../capability/sdk/ts/receipt.ts';

const root=resolve(import.meta.dirname,'../../../../..');
// The oracle imports the composed native under test, never whatever Hermes the interpreter happens to have installed.
const nativeEnv={...process.env,PYTHONPATH:process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT};
function entry(scope='owner',principal='owner'):AdmissionEntry {
  const d={principal_id:principal,device_id:'phone',device_type:'phone',processed_event_id:'d:request',
    origin:'explicit_user_prompt',media_type:'text',user_identity:principal,content:{text:'发消息'},
    processing:{path_id:'text'},source:{channel:'chat'},speakers:[]} as unknown as ProcessedEvent;
  if(scope==='background'||scope==='cron'||scope==='background_unattributed')Object.assign(d,{origin:'device_observation',media_type:'app_event',
    content:{app_event:{kind:'scheduled_task',origin_processed_event_id:'d:original'}},source:{channel:'background_scheduled'}});
  if(scope==='owner_observation')Object.assign(d,{origin:'device_observation',media_type:'app_event',user_identity:'unknown',
    content:{app_event:{kind:'health_update'}}});
  if(scope==='care')Object.assign(d,{origin:'device_observation',media_type:'app_event',content:{app_event:{kind:'proactive_care'}}});
  return {d,skill:'fixture',bytes:0,record:{principal_id:principal,session_id:'session',run_id:'run',processed_event_id:d.processed_event_id,
    payload_sha256:'0'.repeat(64),arrival_seq:1,state:'running',idempotency_key:'run-key',created_at_ms:Date.now(),deadline_ms:Date.now()+60000,policy_version:'fixture'}};
}
async function fixture(t:test.TestContext,scope='owner',principal='owner'){
  const dir=await mkdtemp(join(tmpdir(),'cap-consent-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new PosixStorage(dir),bound=entry(scope,principal),original=entry('owner',principal).d;
  original.processed_event_id='d:original';
  const context={run_id:'run',session_id:'session',tool_call_id:'call'};
  const ports={admission:{find:()=>bound},storage,ownerOrigin:async()=>scope==='background_unattributed'?undefined:original,paymentSource:()=>({ride_allowed:false})};
  const consent:ConsentCall={context,effect:'send',target:'email:fixture@example.com',task_type:'send_message:email:send',
    owner_requested:true,scope_allowed:true,consent_required:true};
  const frozen:FrozenCall={tool_name:'send_message',task_id:'native-child',args:{target:consent.target,message:'原来的正文'},
    idempotency_key:'frozen-key',consent,admission:bound,check_with:'message_status'};
  const gates:ConsentPorts={effectConsent:(...args)=>effectConsent(ports,...args),
    spend:async()=>({action:'block',message:'CASHIER_REQUIRED'}),selfChange:async()=>({action:'block',message:'RELEASE_REQUIRED'})};
  return {storage,bound,ports,context,consent,frozen,gates};
}

test('generated legacy effects.py + effectConsent table is 100% equivalent across tools and admission scopes',async t=>{
  const python=process.env.PAIOS_HERMES_PYTHON!,script=join(root,'tests/hermes/capability_consent_table.py');
  const scopeRun=spawnSync(python,[script,'scopes'],{encoding:'utf8',env:nativeEnv});assert.equal(scopeRun.status,0,scopeRun.stderr);
  const scopes=JSON.parse(scopeRun.stdout) as {tool:string;scope:string;allowed:boolean}[];
  const classes=JSON.parse(await readFile(join(root,'capability/contracts/effect-classes.v1.json'),'utf8')).classes;
  const cases:Record<string,unknown>[]=[],actual:string[]=[];
  for(const row of scopes)for(const effect of ['observe','owner_data','send','account','delete','physical'] as EffectKind[])
    for(const requested of [true,false])for(const remembered of [true,false]){
      if(row.tool==='send_message'&&effect!=='send')continue;
      const f=await fixture(t,row.scope,`owner-${cases.length}`),kind=classes[effect].legacy_effect_kind;
      const value={kind,task_type:row.tool==='send_message'?'send_message:email:send':'fixture',requested,
        ...(effect==='send'?{recipient:'email:fixture@example.com'}:{})};
      let legacy:Awaited<ReturnType<typeof effectConsent>>|undefined,error:string|undefined;
      try{
        if(remembered){const requestId='previous';await effectConsent(f.ports,f.context,value,true,false,requestId,{
          confirmation_id:nativeApprovalId(f.bound.d.principal_id,'run',requestId),confirmed_by:f.bound.d.principal_id,
          surface:{device_id:'phone',device_type:'phone'},confirmed_at:new Date().toISOString()});}
        legacy=await effectConsent(f.ports,f.context,value);
      }catch(e){error=(e as ContractError).code;}
      actual.push((await decideConsent(f.gates,{...f.consent,effect,task_type:value.task_type,owner_requested:requested,
        scope_allowed:row.allowed,invocation:row.scope==='cron'?'cron':'interactive'})).action);
      cases.push({tool:row.tool,scope:row.scope,scope_allowed:row.allowed,effect:value,legacy,error,context:f.context});
    }
  const oracle=spawnSync(python,[script,'decisions'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:4<<20,env:nativeEnv});
  assert.equal(oracle.status,0,oracle.stderr);
  assert.deepEqual(actual,JSON.parse(oracle.stdout));assert.equal(cases.length,684);
  if(process.env.CAPABILITY_EQUIVALENCE_OUT)await writeFile(process.env.CAPABILITY_EQUIVALENCE_OUT,
    JSON.stringify({cases:cases.map((row,index)=>({...row,legacy_action:JSON.parse(oracle.stdout)[index],new_action:actual[index]})),equivalent:cases.length,total:cases.length},null,2));
});

test('manifest exemptions and protected authorities remain separate from effect consent',async t=>{
  const f=await fixture(t);
  for(const effect of ['owner_data','account','delete','physical','observe'] as const){
    assert.equal((await decideConsent(f.gates,{...f.consent,effect,owner_requested:true})).action,'allow');
    assert.equal((await decideConsent(f.gates,{...f.consent,effect,owner_requested:false})).action,'approve');
  }
  assert.equal((await decideConsent(f.gates,{...f.consent,effect:'physical',consent_required:false})).action,'allow');
  assert.equal((await decideConsent(f.gates,{...f.consent,effect:'spend'})).action,'block');
  assert.equal((await decideConsent(f.gates,{...f.consent,effect:'self_change'})).action,'block');
  assert.equal((await decideConsent({...f.gates,effectConsent:async()=>{throw Error('private secret');}},f.consent)).action,'block');
});

test('protected decisions receive the exact confirmation on every call and never use the ordinary consent store',async t=>{
  const f=await fixture(t),seen:unknown[]=[];
  const confirmation={request_id:'exact-candidate',confirmation:{confirmation_id:'card',confirmed_by:'owner',
    surface:{device_id:'phone',device_type:'phone'},confirmed_at:new Date().toISOString()}};
  const gates:ConsentPorts={...f.gates,effectConsent:async()=>{assert.fail('ordinary consent cannot authorize payment or release');},
    spend:async(call,approval)=>{seen.push([call.effect,approval]);return {action:'block',message:'LIVE_CASHIER_REQUIRED'};},
    selfChange:async(call,approval)=>{seen.push([call.effect,approval]);return {action:'block',message:'EXACT_RELEASE_AUTHORITY_REQUIRED'};}};
  for(const effect of ['spend','self_change'] as const)for(let i=0;i<2;i++){
    assert.equal((await decideConsent(gates,{...f.consent,effect,consent_required:false},confirmation)).action,'block');
  }
  assert.equal(seen.length,4);assert.deepEqual(seen[0],['spend',confirmation]);
  assert.deepEqual(seen[2],['self_change',confirmation]);
});

async function deferred(t:test.TestContext,options:{ttl?:number;now?:()=>number;execute?:(call:FrozenCall)=>Promise<Receipt>}={}){
  const f=await fixture(t),cards=new VoiceConfirmations(f.storage,{ttl_ms:options.ttl??60000,now:options.now??Date.now});
  const receipts:Receipt[]=[],executed:FrozenCall[]=[],followups=new Map<string,Receipt>(),errors:unknown[]=[];
  const phases:string[]=[];
  const ports:ConfirmationPorts={gates:(call,approved)=>({...f.gates,effectConsent:(context,effect,_approved,rideOk,requestId,confirmation)=>approved?
      confirmFrozenEffect(f.ports,call.admission,context,effect,rideOk===true,requestId!,confirmation!):effectConsent(f.ports,context,effect)}),
    execute:async call=>{executed.push(structuredClone(call));return options.execute?options.execute(call):succeeded();},
    receipt:async(_,body,phase)=>{receipts.push(body);phases.push(phase);},followUp:async(_,body,id)=>{followups.set(id,body);},error:e=>errors.push(e)};
  const service=new CapabilityConfirmations(f.storage,cards,ports);t.after(async()=>{await service.close();cards.close();});
  const card=async()=>{const [value]=cards.list('owner');assert.ok(value);return value;};
  return {...f,cards,service,ports,receipts,executed,followups,errors,card,phases};
}

test('closing waits for an approved frozen execution and its durable receipt and follow-up',async t=>{
  const entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
  const f=await deferred(t,{execute:async()=>{entered.resolve();await resume.promise;return succeeded();}});
  await f.service.decide(f.frozen);const card=await f.card();
  await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  await entered.promise;let closed=false;
  const closing=Promise.resolve(f.service.close()).then(()=>{closed=true;});
  try {await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);}
  finally {resume.resolve();await f.service.settle(card);}
  await closing;assert.equal(f.executed.length,1);
  assert.equal(f.receipts.at(-1)!.status.state,'succeeded');assert.equal(f.followups.size,1);
  assert.deepEqual(f.errors,[]);
});

test('a waiting owner confirmation does not block later tools in the same batch; approved call is frozen and runs once after the original run ends',async t=>{
  const f=await deferred(t),completed:string[]=[];
  const [waiting,other]=await Promise.all([f.service.decide(f.frozen),Promise.resolve().then(()=>{completed.push('independent');return 42;})]);
  assert.equal(waiting.action,'block');assert.equal(other,42);assert.deepEqual(completed,['independent']);
  assert.equal(f.receipts[0]!.status.state,'waiting');assert.equal(f.executed.length,0);
  const native=spawnSync(process.env.PAIOS_HERMES_PYTHON!,[join(root,'tests/hermes/capability_consent_table.py'),'batch'],
    {input:JSON.stringify(waiting),encoding:'utf8',env:nativeEnv});
  assert.equal(native.status,0,native.stderr);
  const batch=JSON.parse(native.stdout);assert.equal(batch.second.completed,true);
  assert.equal(JSON.parse(batch.first.error).structuredContent.status.state,'waiting');
  const card=await f.card();f.frozen.args.message='试图改正文';f.bound.record.state='completed';
  await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  const body=await f.service.settle(card);assert.equal(body.status.state,'succeeded');
  assert.deepEqual(f.phases,['waiting','result']);
  assert.equal(f.executed[0]!.args.message,'原来的正文');assert.equal(f.executed[0]!.idempotency_key,'frozen-key');
  await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  await f.service.settle(card);assert.equal(f.executed.length,1);assert.equal(f.followups.size,1);
  assert.deepEqual(f.errors,[]);
});

for(const verdict of ['deny','expired'] as const)test(`${verdict} yields a cancelled receipt, a new follow-up and no execution`,async t=>{
  let at=Date.now();
  const f=await deferred(t,{ttl:verdict==='expired'?25:60000,now:()=>at});await f.service.decide(f.frozen);const card=await f.card();
  if(verdict==='deny')await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'deny');
  else at+=40;
  const result=await f.service.settle(card);assert.equal(result.status.state,'cancelled');
  assert.equal(result.status.reason_code,verdict==='deny'?'confirmation_denied':'confirmation_expired');
  assert.equal(f.executed.length,0);assert.equal(f.followups.size,1);
});

test('foreign devices, changed frozen arguments and a model-supplied effect cannot authorize a call',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await assert.rejects(f.service.answer(card.confirmation_id,{principal_id:'intruder',device_id:'phone',device_type:'phone'},'approve'),/SCOPE_DENIED/);
  await assert.rejects(f.service.decide({...f.frozen,args:{message:'changed'}}),/FROZEN_CALL_CONFLICT/);
  await assert.rejects(f.service.decide({...f.frozen,args:{effect:{kind:'read'}}}),/EFFECT_ARGUMENT_REMOVED/);
  assert.equal(f.executed.length,0);
});

test('restart recovers an approval and an interrupted execution becomes unknown without a second dispatch',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await f.cards.decide(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  await f.storage.publish('capability-call-executions',card.confirmation_id,Buffer.from('{"token":"interrupted"}'));
  f.service.close();const restored=new CapabilityConfirmations(f.storage,f.cards,f.ports);t.after(()=>restored.close());
  await restored.recover();assert.equal(f.executed.length,0);assert.equal(f.followups.size,1);
  const body=[...f.followups.values()][0]!;assert.equal(body.status.state,'unknown');
  assert.equal(body.next.retry,'after_check');assert.equal(body.next.check_with,'message_status');
});

test('a started execution stays uncertain when its original authorization is gone during recovery',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await f.cards.decide(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  await f.storage.publish('capability-call-executions',card.confirmation_id,Buffer.from('{"token":"interrupted"}'));
  const restored=new CapabilityConfirmations(f.storage,f.cards,{...f.ports,
    gates:()=>({...f.gates,effectConsent:async()=>{throw new ContractError('SCHEDULE_OWNER_REQUIRED',403);}}),
    followUp:async()=>{throw new ContractError('SCHEDULE_DEVICE_REQUIRED',403);}});t.after(()=>restored.close());
  await restored.recover();assert.equal(f.executed.length,0);
  const result=f.receipts.at(-1)!;assert.equal(result.status.state,'unknown');
  assert.equal(result.status.reason_code,'EXECUTION_RECOVERY_CHECK_REQUIRED');assert.equal(result.next.retry,'after_check');
});

test('a transport timeout never becomes failed or authorizes a blind retry',async t=>{
  const f=await deferred(t,{execute:async()=>{throw new Error('timeout secret');}});
  await f.service.decide(f.frozen);const card=await f.card();
  await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  const result=await f.service.settle(card);assert.equal(result.status.state,'unknown');assert.equal(result.next.retry,'after_check');
  assert.ok(!JSON.stringify(result).includes('secret'));assert.equal(f.executed.length,1);
});

test('cancelling an outstanding call withdraws the card and a late approval cannot dispatch it',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await f.cards.cancelCalls('owner',f.bound.d.processed_event_id);
  assert.equal((await f.service.settle(card)).status.reason_code,'confirmation_cancelled');
  await assert.rejects(f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve'),/ALREADY_DECIDED/);
  assert.equal(f.executed.length,0);assert.equal(f.cards.list('owner').length,0);
});

test('delivery recovery replays the result to a new run without executing again',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await f.cards.decide(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  const failing=new CapabilityConfirmations(f.storage,f.cards,{...f.ports,followUp:async()=>{throw Error('offline');}});
  await assert.rejects(failing.settle(card),/offline/);failing.close();
  assert.equal(f.executed.length,1);
  const restored=new CapabilityConfirmations(f.storage,f.cards,f.ports);t.after(()=>restored.close());
  await restored.recover();assert.equal(f.executed.length,1);assert.equal(f.followups.size,1);
  let repeated=0;
  const again=new CapabilityConfirmations(f.storage,f.cards,{...f.ports,followUp:async()=>{repeated++;}});t.after(()=>again.close());
  await again.recover();assert.equal(repeated,0);assert.equal(f.executed.length,1);
  assert.deepEqual(JSON.parse(Buffer.from(await f.storage.read('capability-call-notifications',card.confirmation_id)).toString()),{state:'admitted'});
});

for(const reason of ['SCHEDULE_DEVICE_REQUIRED','SCHEDULE_OWNER_REQUIRED','SOURCE_T03_CONSENT_REQUIRED'])
test(`notification authorization ${reason} is terminal per record and later recovery continues`,async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const first=await f.card();
  await f.cards.decide(first.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'deny');
  const next={...f.frozen,idempotency_key:'second',consent:{...f.consent,context:{...f.context,tool_call_id:'second'}}};
  await f.service.decide(next);const second=f.cards.list('owner').find(row=>row.confirmation_id!==first.confirmation_id)!;
  await f.cards.decide(second.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'deny');
  let notifications=0;
  const restored=new CapabilityConfirmations(f.storage,f.cards,{...f.ports,followUp:async(call,body,id)=>{
    notifications++;
    if(call.idempotency_key==='frozen-key')throw new ContractError(reason,403);
    await f.ports.followUp(call,body,id);
  }});t.after(()=>restored.close());
  await restored.recover();await restored.recover();
  assert.equal(notifications,2);assert.equal(f.followups.size,1);assert.equal(f.executed.length,0);
  assert.deepEqual(JSON.parse(Buffer.from(await f.storage.read('capability-call-notifications',first.confirmation_id)).toString()),
    {state:'undeliverable',reason});
});

test('a decide retry replays the frozen result after the originating admission changes state',async t=>{
  const f=await deferred(t);await f.service.decide(f.frozen);const card=await f.card();
  await f.service.answer(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
  await f.service.settle(card);f.frozen.admission.record.state='completed';f.frozen.admission.record.conversation_released=true;
  const retry=await f.service.decide(f.frozen);assert.equal(retry.action,'block');
  assert.equal(JSON.parse((retry as {message:string}).message).structuredContent.status.state,'succeeded');
  assert.equal(f.executed.length,1);
});
