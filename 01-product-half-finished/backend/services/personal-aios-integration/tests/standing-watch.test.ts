import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {Timeline} from '../src/timeline.ts';
import {StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {sha256} from '../src/contracts.ts';
import {sourceClient} from './native-source-fixture.ts';

const repo=fileURLToPath(new URL('../../../../../',import.meta.url)),fork=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;
const python=process.env.PAIOS_NATIVE_TEST_PYTHON??(fork&&join(fork,'.venv/bin/python'));
let root:string,proof:any;
const nativeAvailable=!!fork&&!!python&&existsSync(python);
before(async()=>{
  if(!nativeAvailable)return;
  root=await mkdtemp(join(tmpdir(),'standing-watch-'));
  const {stdout}=await promisify(execFile)(python!,[join(repo,'tests/hermes/standing_watch_fixture.py'),join(root,'native')],{
    env:{...process.env,PYTHONPATH:`${join(repo,'integrations/hermes')}:${fork}`,PYTHONDONTWRITEBYTECODE:'1',HERMES_DISABLE_LAZY_INSTALLS:'1'},timeout:20000,maxBuffer:262144});
  const line=stdout.split('\n').find(line=>line.startsWith('WATCH_RESULT='));assert.ok(line,stdout);
  proof=JSON.parse(line.slice('WATCH_RESULT='.length));
  assert.equal(proof.query_calls,7);assert.equal(proof.tasks.length,8);assert.equal(proof.restarted,true);
  assert.deepEqual(proof.deliveries[0],proof.deliveries[1]);assert.equal(proof.state.delivered_sequence,2);
},{timeout:20000});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});});
for(const staging of [false,true])test(`standing watch cron/tool transcript reaches timeline and ${staging?'staging sink':'notification'} once across ACK loss and restart`,
  {skip:!nativeAvailable?'native patched source and venv required':false,timeout:30000},async t=>{
  const caseRoot=join(root,staging?'staging':'notification');
  const storage=new PosixStorage(join(caseRoot,'storage')),notifications:unknown[]=[],runs:any[]=[];
  const nativeRuns=new Map<string,any>(),running=Promise.withResolvers<void>();
  const native=sourceClient({create:async body=>{runs.push(body);const run={run_id:`run-${runs.length}`,session_id:body.session_id,
    conversation_session_id:body.session_id,status:'running'};nativeRuns.set(run.run_id,run);return run;},
    status:async (id:string)=>{running.resolve();return nativeRuns.get(id);},cancel:async (id:string)=>({...nativeRuns.get(id),status:'cancelled'})});
  const authority=Object.assign(new StaticFixtureDeviceAuthority([{principal_id:'owner',device_id:'phone',device_type:'phone',
    channel:'background_scheduled',consent_ref:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256('fixture')}]),{
    scheduled:async()=>authority.authenticate('fixture')});
  let admission!:RunAdmission;
  const open=()=>{
    admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:86400000,
      poll_interval_ms:1000,native_idempotency_retention_ms:86400000,policy_version:'watch-fixture'});
    const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),native,admission,
      output:new OutputAuthority(storage),sourceAuthority:authority,skill:'fixture',max_read_bytes:8192,
      notify:async notice=>{assert.equal(staging,false,'staging must use its sink');notifications.push(notice);},
      ...(staging?{staging_outreach:async notice=>{notifications.push({title:'依米',body:notice.text});}}:{})});
    runtime.timeline=new Timeline({directory:join(caseRoot,'timeline')},storage,async()=>undefined,admission);
    return runtime;
  };
  let runtime=open();t.after(async()=>{await runtime.close();});
  const admitted=await runtime.scheduledTask(proof.tasks[0]);
  assert.equal((admitted.processed_event.content.app_event as {kind:string}).kind,'scheduled_task');
  const session=admitted.admission.session_id,did=admitted.processed_event.processed_event_id;
  await running.promise;const binding=admission.get('owner',session,did)!;
  const context=await runtime.scheduleContext({run_id:binding.run_id!,session_id:session,tool_call_id:'watch-context'});
  assert.equal(context.scheduled_job_id,proof.tasks[0].job_id);
  assert.equal(context.scheduled_occurrence_id,proof.tasks[0].occurrence_id);
  assert.equal(context.scheduled_captured_at,proof.tasks[0].captured_at);
  const value=proof.deliveries[0];
  await Promise.all([runtime.scheduledDelivery(value),runtime.scheduledDelivery(value)]);
  assert.deepEqual(notifications,[{title:'依米',body:'包裹到了'}]);
  assert.deepEqual(runtime.timeline!.page('owner').items.map(item=>({id:item.item_id,text:item.text})),[{id:`her-${value.id}`,text:'包裹到了'}]);
  await runtime.close();runtime=open();
  await runtime.scheduledDelivery(proof.deliveries[1]);
  assert.equal(notifications.length,1);assert.equal(runtime.timeline!.page('owner').items.length,1);
  await assert.rejects(runtime.scheduledDelivery({...value,text:'different observation'}),/SCHEDULE_DELIVERY_CONFLICT/);
  const second=proof.deliveries[2];assert.notEqual(second.id,value.id);
  await Promise.all([runtime.scheduledDelivery(second),runtime.scheduledDelivery(second)]);
  assert.equal(notifications.length,2);assert.equal(runtime.timeline!.page('owner').items.length,2);
  await runtime.close();runtime=open();
  await runtime.scheduledDelivery(second);
  assert.equal(notifications.length,2);assert.equal(runtime.timeline!.page('owner').items.length,2);
  t.diagnostic(JSON.stringify({nativeCronFires:8,queryCalls:7,arrivalNotifications:2,timelineItems:2,restarted:true}));
});
