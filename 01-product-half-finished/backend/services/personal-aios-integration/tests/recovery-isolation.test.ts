import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RunAdmission,sourceClient} from './native-source-fixture.ts';
import {canonical,digest} from '../src/contracts.ts';
import {CapabilityConfirmations} from '../src/capability/consent/confirmation.ts';
import {VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import type {FrozenCall} from '../src/capability/consent/call.ts';
import {succeeded} from '../../../../../capability/sdk/ts/receipt.ts';

async function until(read:()=>boolean){for(let i=0;i<200;i++){if(read())return;await new Promise(r=>setTimeout(r,10));}assert.fail('record did not recover');}
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'recovery-isolation-')),storage=new PosixStorage(root);
  const cleanup:(()=>Promise<void>)[]=[];
  t.after(async()=>{for(const close of cleanup)await close();await storage.close();await rm(root,{recursive:true,force:true});});
  const save=(ns:string,key:string,value:unknown)=>storage.publish(ns,key,Buffer.from(canonical(value)));
  const ingress=new UnifiedIngress(new RawArchive(storage,65536));
  const seed=async(name:string)=>{
    const d=await ingress.accept({schema_version:'paios.event.v1',event_id:name,device_id:'phone',device_type:'phone',
      captured_at:new Date().toISOString(),source:{channel:'chat'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('Synthetic')},
      {principal_id:'owner',device_id:'phone',device_type:'phone',channel:'chat',consent_ref:'fixture',submission:'explicit_text'});
    const key=digest({principal_id:'owner',session_id:name,processed_event_id:d.processed_event_id});
    const record={principal_id:'owner',session_id:name,processed_event_id:d.processed_event_id,
      payload_sha256:digest({d,session_id:name,skill_sha256:digest('fixture')}),arrival_seq:1,state:'pending' as const,
      idempotency_key:`paios:${key}`,created_at_ms:Date.now(),deadline_ms:Date.now()+60000,policy_version:'isolation'};
    await save('admissions',key,record);await save('admission-inputs',key,{d,skill:'fixture'});
    await save('d-session-bindings',digest({principal_id:'owner',processed_event_id:d.processed_event_id}),{session_id:name});
    return {key,d,record,skill:'fixture',bytes:0};
  };
  return {storage,save,seed,cleanup};
}
for(const failure of ['record-read','run-owner'] as const)test(`admission recovery isolates ${failure}, retries it and preserves other session bindings`,async t=>{
  const f=await fixture(t),first=await f.seed('first'),second=await f.seed('second');
  const existing={run_id:'existing',session_id:'first',conversation_session_id:'first',status:'running'};
  if(failure==='run-owner')await f.save('run-bindings',first.key,{run_id:'existing',session_id:'first',run_order:1});
  const runs=new Map<string,any>(),creates:string[]=[];let failing=true,owners=0;
  const native=sourceClient({create:async(body,key)=>{assert.ok(!runs.has(key));creates.push(body.session_id);
    const run={run_id:`new-${runs.size}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(key,run);return run;},
    status:async id=>id==='existing'?existing:[...runs.values()].find(run=>run.run_id===id),cancel:async()=>{throw Error('unused');}});
  const a=new RunAdmission(f.storage,native,{max_pending_events:2,max_pending_bytes:65536,max_event_age_ms:60000,
    native_idempotency_retention_ms:60000,poll_interval_ms:50,policy_version:'isolation'});
  f.cleanup.push(()=>a.close());
  t.mock.method(f.storage,'list',async(ns:string)=>ns==='admissions'?[first.key,second.key]:[]);
  const read=f.storage.read.bind(f.storage);
  t.mock.method(f.storage,'read',async(ns:string,key:string)=>{
    if(failure==='record-read'&&ns==='admission-inputs'&&key===first.key&&failing)throw Error('TRANSIENT_RECORD_READ');
    return read(ns,key);
  });
  a.setRunOwner(async entry=>{if(entry.record.session_id==='first'){owners++;if(failure==='run-owner'&&failing)throw Error('fetch failed');}});
  await a.recover().catch(()=>{});
  await until(()=>!!a.get('owner','second',second.d.processed_event_id)?.run_id);
  assert.equal(a.get('owner','second',second.d.processed_event_id)?.run_id,[...runs.values()].find(run=>run.session_id==='second').run_id);
  failing=false;await a.recover();
  await until(()=>failure==='run-owner'?owners>=2:!!a.get('owner','first',first.d.processed_event_id)?.run_id);
  await a.recover();await new Promise(r=>setTimeout(r,30));
  assert.equal(creates.filter(session=>session==='second').length,1);
  assert.equal(creates.filter(session=>session==='first').length,failure==='run-owner'?0:1);
  assert.equal(a.get('owner','first',first.d.processed_event_id)?.run_id,failure==='run-owner'?'existing':
    [...runs.values()].find(run=>run.session_id==='first').run_id);
});

test('consent recovery keeps a failed notification, continues siblings, and never replays saved or claimed effects',async t=>{
  const f=await fixture(t),cards=new VoiceConfirmations(f.storage),errors:unknown[]=[],delivered:string[]=[];
  let failing=true,executions=0;
  const keys:string[]=[];
  for(const name of ['first','second','claimed']){
    const admission=await f.seed(name);
    const call:FrozenCall={tool_name:'send_message',task_id:name,args:{target:'fixture@example.invalid'},idempotency_key:name,check_with:'status',
      admission:{...admission,record:{...admission.record,state:'completed',run_id:'run-'+name}},
      consent:{context:{run_id:'run-'+name,session_id:name,tool_call_id:name},effect:'send',target:'email:fixture@example.invalid',
        task_type:'send',owner_requested:true,scope_allowed:true,consent_required:true}};
    const card=await cards.openCall(call,name,'Synthetic');keys.push(card.confirmation_id);
    await cards.decide(card.confirmation_id,{principal_id:'owner',device_id:'phone',device_type:'phone'},'approve');
    await f.save('capability-call-executions',card.confirmation_id,{token:'previous-dispatch'});
    if(name!=='claimed')await f.save('capability-call-results',card.confirmation_id,succeeded());
  }
  const list=f.storage.list.bind(f.storage);
  t.mock.method(f.storage,'list',async(ns:string)=>ns==='voice-confirmations'?keys:list(ns));
  const service=new CapabilityConfirmations(f.storage,cards,{
    gates:()=>({effectConsent:async()=>({status:'confirmation_required',scope:{}}),spend:async()=>({action:'block',message:'unused'}),
      selfChange:async()=>({action:'block',message:'unused'})}),
    execute:async()=>{executions++;return succeeded();},receipt:async()=>{},
    followUp:async call=>{if(call.task_id==='first'&&failing)throw Error('fetch failed');delivered.push(call.task_id);},
    error:error=>errors.push(error)
  });
  f.cleanup.push(async()=>{await service.close();cards.close();});
  await service.recover();assert.deepEqual(delivered,['second','claimed']);assert.equal(errors.length,1);assert.equal(executions,0);
  assert.deepEqual(JSON.parse(Buffer.from(await f.storage.read('capability-call-notifications',keys[0]!)).toString()),{state:'pending'});
  const claimed=JSON.parse(Buffer.from(await f.storage.read('capability-call-results',keys[2]!)).toString());
  assert.equal(claimed.status.state,'unknown');assert.equal(claimed.status.reason_code,'EXECUTION_RECOVERY_CHECK_REQUIRED');
  failing=false;await service.recover();await service.recover();
  assert.deepEqual(delivered,['second','claimed','first']);assert.equal(executions,0);
});

for(const stop of [false,true])test(`terminal recovery waits for readiness and shutdown releases the wait: close=${stop}`,async t=>{
  const f=await fixture(t),entry=await f.seed('terminal');let observed=0,finalized=0;
  await f.save('run-bindings',entry.key,{run_id:'completed-run',session_id:'terminal'});
  await f.save('run-terminals',entry.key,{status:'completed',run_id:'completed-run'});
  const native=sourceClient({create:async()=>{throw Error('must not replay');},
    status:async()=>{observed++;return {run_id:'completed-run',session_id:'terminal',status:'completed'};},
    cancel:async()=>{throw Error('unused');}});
  const a=new RunAdmission(f.storage,native,{max_pending_events:2,max_pending_bytes:65536,max_event_age_ms:60000,
    native_idempotency_retention_ms:60000,poll_interval_ms:50,policy_version:'readiness'});
  f.cleanup.push(()=>a.close());a.setNativeReady(false);
  a.setRunOwner(async()=>{await native.status('completed-run');});
  a.setTerminalOwner(async()=>{finalized++;});
  const recovering=a.recover();await new Promise(r=>setTimeout(r,30));assert.equal(observed,0);assert.equal(finalized,0);
  if(stop)await a.close();else a.setNativeReady(true);
  await recovering;assert.equal(observed,stop?0:1);assert.equal(finalized,stop?0:1);
});
