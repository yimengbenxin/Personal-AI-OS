import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun,type ErrandResult} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority,errandDeliveryFacts} from '../src/output.ts';
import {EVENT_SCHEMA,sha256,digest,ContractError,DeliveryStageError} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
async function fixture(t:TestContext,mode:'text'|'none'|'admitted'='text',routeSelfcheckResult?: (result:ErrandResult)=>Promise<boolean>) {
 const root=await fs.mkdtemp(join(tmpdir(),'paios-errand-delivery-')),storage=new PosixStorage(root);
 let creates=0,historyReads=0;
 const runs=new Map<string,NativeRun>(),bound=Promise.withResolvers<void>(),secondBound=Promise.withResolvers<void>(),inputs:string[]=[];
 const native={routeSelfcheckResult,create:async(body:{input:string;session_id?:string})=>{inputs.push(body.input);const run:NativeRun={run_id:'run-'+ ++creates,session_id:body.session_id??'session',conversation_session_id:body.session_id??'session',status:'running',output:'The errand finished.'};runs.set(run.run_id,run);return {...run};},
 status:async(id:string)=>{bound.resolve();if(id==='run-2')secondBound.resolve();return {...runs.get(id)!};},cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'}),sessions:async()=>[],messages:async()=>{historyReads++;return [];}};
 const devices=[{principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('fixture')}];
 devices.push({...devices[0]!,principal_id:'other-owner',device_id:'foreign-phone',token_sha256:sha256('foreign-fixture')});
 const errors:unknown[]=[],admission=new RunAdmission(storage,native,policy),output=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})});
 const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output,devices,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:e=>errors.push(e)}});
 t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 const source=await runtime.authenticate('fixture');
 const result:ErrandResult={principal_id:'owner',job_id:'job-0123456789ab',task:'Read the requested page',success:true,answer:'Finished',finished_at:new Date().toISOString()};
 const raw=(value:ErrandResult)=>({schema_version:EVENT_SCHEMA,event_id:`errand:${value.job_id}`,device_id:'phone',device_type:'phone' as const,captured_at:value.finished_at,source:{channel:'text'},media_type:'app_event' as const,mime:'application/json',representation:'uploaded_original' as const,payload:Buffer.from(JSON.stringify({kind:'errand_result',...value}))});
 const submit=(value=result,session='session')=>runtime.submitErrand(raw(value),source,session);
 const finish=async(d:string,runId='run-1',outreach=true,session='session')=>{await bound.promise;
 if(mode!=='admitted')await runtime.tool('paios_open_reply',{context:{run_id:runId,session_id:session,tool_call_id:'open'},args:{reply_mode:mode}});
 else {const wire=JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8')) as NativeRun;
   const text='这次任务没有完成。已读到页面上的部分内容，其余结果尚未核实。';
   Object.assign(runs.get(runId)!,{output:text,native_final_response:{...wire.native_final_response!,run_id:runId,session_id:session,sha256:sha256(text)}});}
 const done=Promise.withResolvers<Awaited<ReturnType<PersonalAIOSRuntime['result']>>>();
 await runtime.subscribeResult(source,session,d,async value=>{done.resolve(value);},error=>done.reject(error),outreach?{outreach:'errand'}:{});
 runs.get(runId)!.status='completed';return done.promise;};
 const watch=(deliver:(result:ErrandResult)=>Promise<boolean>,reply:(...args:any[])=>Promise<boolean|'pending'>)=>runtime.watchCare(source,async()=>true,undefined,undefined,undefined,{deliver,progress:async()=>true,reply});
 return {runtime,storage,admission,output,source,result,submit,finish,watch,errors,inputs,ready:bound.promise,secondBound:secondBound.promise,counts:()=>({creates,historyReads})};
}
test('failed errand with partial findings delivers its durable final text without a model OPEN call',async t=>{
 const f=await fixture(t,'admitted'),result={...f.result,success:false,terminal_reason:'failed' as const,
   answer:'Synthetic executor asset error',partial_findings:{verified:[],not_verified:['remaining task'],last_screen_text:'Synthetic page content',truncated:false}};
 const first=await f.submit(result),value=await f.finish(first.processed_event.processed_event_id);
 assert.equal(value.result.reply_phase,'sealed');assert.equal(value.result.reply_mode,'text');
 assert.ok(value.result.reply_text.includes('没有完成'));assert.ok(value.result.output_plan.length);
 assert.ok(value.result.warnings.includes('FINAL_BUFFER_DURABLE_ASSISTANT_BOUNDARY'));
 assert.equal(value.result.warnings.includes('OPEN_REQUIRED'),false);
 let published=0;await f.watch(async()=>false,async()=>{published++;return true;});
 assert.equal(await f.runtime.errandReply('owner',value,error=>f.errors.push(error),{first:true}),'pending');
 assert.equal(published,1);
 const chunk=value.chunks.at(-1)!;
 await f.runtime.acknowledge(f.source,'session',first.processed_event.processed_event_id,{output_id:chunk.output_id,reply_id:chunk.reply_id,
   reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,
   highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:new Date().toISOString()});
 assert.equal(await f.runtime.errandReply('owner',value,error=>f.errors.push(error),{first:true}),true);
 assert.equal(published,1);assert.deepEqual(f.errors,[]);
});
test('a timed-out phone result carries found and missing facts into the reporting run once',async t=>{
 const f=await fixture(t),partial_findings={verified:['示例店甲：68–98 元'],not_verified:['[pending] 配送费未读到'],
   last_screen_text:'示例店乙，距离 2 公里',truncated:false};
 const result={...f.result,success:false,terminal_reason:'timed_out' as const,partial_findings,
   answer:'【部分结果】已核实：示例店甲 68–98 元。配送费未核实。'};
 const first=await f.submit(result);await f.finish(first.processed_event.processed_event_id);
 const input=JSON.parse(f.inputs[0]!);
 assert.deepEqual(input.content.app_event.partial_findings,partial_findings);
 assert.equal(input.content.app_event.success,false);assert.equal(input.content.app_event.answer,result.answer);
 assert.deepEqual((first.processed_event.content.app_event as {partial_findings:unknown}).partial_findings,partial_findings);
 await f.submit(result);assert.equal(f.inputs.length,1,'the partial result must not dispatch another phone job or reporting run');
 await f.submit({...f.result,job_id:'partial-context'},'session-b');await f.secondBound;
 const context=await f.runtime.errandReportContext({run_id:'run-2',session_id:'session-b'},[result.job_id]);
 assert.deepEqual(context.prior_reports[0]!.source_event,first.processed_event.content.app_event,
   'the report retains the exact source event, including partial findings, independently of generated prose');
});
for(const reason of [undefined,'failed','cancelled_by_user','timed_out','completed'] as const)
test(`errand replay keeps one admission and never rereads history: ${reason??'legacy'}`,async t=>{
 const f=await fixture(t),result={...f.result,success:reason===undefined||reason==='completed',...(reason?{terminal_reason:reason,origin_processed_event_id:'d:origin'}:{})};
 if(reason)await f.storage.publish('errand-origins',digest({principal_id:'owner',job_id:result.job_id}),Buffer.from(JSON.stringify({origin_processed_event_id:'d:origin'})));
 const first=await f.submit(result),value=await f.finish(first.processed_event.processed_event_id),before=f.counts();
 for(let n=0;n<8;n++)assert.equal((await f.submit(result)).processed_event.processed_event_id,first.processed_event.processed_event_id);
 assert.equal(f.counts().creates,1);assert.equal(f.counts().historyReads,before.historyReads,'delivery replay must not rebuild an admitted native input');
 let calls=0;await f.watch(async()=>false,async()=>{calls++;return true;});
 assert.equal(await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),'pending');
 assert.equal(await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),'pending');
 assert.equal(calls,2,'unacknowledged OUT remains replayable');
 const chunk=value.chunks.at(-1)!;
 await f.runtime.acknowledge(f.source,'session',first.processed_event.processed_event_id,{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,
  target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:new Date().toISOString()});
 assert.equal(await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),true);
 assert.equal(calls,2,'durable ACK stops publication');assert.deepEqual(f.errors,[]);
});
test('errand terminal delivery errors propagate instead of appearing unavailable',async t=>{
 const f=await fixture(t),failure=new ContractError('FORMAL_TEXT_OUTPUT_INVALID');await f.watch(async()=>{throw failure;},async()=>true);
 await assert.rejects(f.runtime.deliverErrand(f.result,e=>f.errors.push(e)),error=>error===failure);
});
test('errand report publication errors propagate from selected terminal',async t=>{
 const f=await fixture(t),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id),failure=new ContractError('FORMAL_TEXT_OUTPUT_INVALID');
 await f.watch(async()=>false,async()=>{throw failure;});await assert.rejects(f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),error=>error===failure);
});
test('finished errand without report fails before terminal publication',async t=>{
 const f=await fixture(t,'none'),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id);let calls=0;
 await f.watch(async()=>false,async()=>{calls++;return true;});
 await assert.rejects(f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),/ERRAND_REPORT_NOT_DELIVERED/);assert.equal(calls,0);
});
test('asynchronous outreach failure is surfaced on the next spool sweep',async t=>{
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 const failure=new ContractError('FORMAL_TEXT_OUTPUT_INVALID');
 await f.runtime.subscribeResult(f.source,'session',first.processed_event.processed_event_id,async()=>{throw failure;},e=>f.errors.push(e),{outreach:'errand'});
 assert.deepEqual(f.errors,[failure]);
 await assert.rejects(f.runtime.deliverErrand(f.result,()=>{}),error=>error===failure);
});
test('delivery failure enters the original main-agent session once with source references',async t=>{
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 await f.watch(async()=>false,async()=>true);
 const failedAt=new Date().toISOString();
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,'ERRAND_REPORT_NOT_DELIVERED',failedAt),true);
 const before=f.counts().historyReads;
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,'ERRAND_REPORT_NOT_DELIVERED',failedAt),true);
 assert.equal(f.counts().historyReads,before);
 const records=await f.storage.list('processed-events'),events=await Promise.all(records.map(async key=>JSON.parse(Buffer.from(await f.storage.read('processed-events',key)).toString())));
 const failures=events.filter(d=>d.content.app_event.kind==='errand_delivery_failed');assert.equal(failures.length,1);
 assert.deepEqual(failures[0].content.app_event,{kind:'errand_delivery_failed',status:'failed',job_id:f.result.job_id,error_code:'ERRAND_REPORT_NOT_DELIVERED',
   principal_id:'owner',title:f.result.task,task:f.result.task,terminal_reason:'failed',execution:{success:true,terminal_reason:null},task_retry_allowed:false,delivery:{scope:'owner_report',status:'unknown',stage:null,reason:null,body_complete:false},evidence_ref:{tool:'phone_status',job_id:f.result.job_id},
   result_processed_event_id:first.processed_event.processed_event_id,result_raw_ref:first.processed_event.raw_ref});
 assert.equal((await f.admission.readOnly('owner','session',failures[0].processed_event_id))?.session_id,'session');
 assert.equal(failures[0].origin,'device_observation');assert.equal(failures[0].captured_at,failedAt);
});
test('a rejected errand subscription retires its cached error and stays closed by the durable failure observation',async t=>{
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 await f.watch(async()=>false,async()=>true);
 const failure=new ContractError('ERRAND_REPORT_NOT_DELIVERED',409);
 await f.runtime.subscribeResult(f.source,'session',first.processed_event.processed_event_id,async()=>{throw failure;},error=>f.errors.push(error),{outreach:'errand'});
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,failure.code,new Date().toISOString()),true);
 const reports=(f.runtime as unknown as {errandReports:Map<string,unknown>}).errandReports;
 assert.equal(reports.has(f.result.job_id),false,'durable failure admission retires the transient error reference');
 let calls=0;
 await assert.rejects(f.runtime.subscribeResult(f.source,'session',first.processed_event.processed_event_id,async()=>{calls++;},error=>f.errors.push(error),{outreach:'errand'}),error=>error instanceof ContractError&&error.code===failure.code);
 await assert.rejects(f.runtime.deliverErrand(f.result,()=>{}),error=>error instanceof ContractError&&error.code===failure.code);
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,failure.code,new Date().toISOString()),true);
 assert.equal(reports.has(f.result.job_id),false,'replayed failure admission also retires the cache');
 assert.equal(calls,0);assert.deepEqual(f.errors,[failure]);
});
test('delivery failure without an authenticated source remains pending',async t=>{
 const f=await fixture(t);assert.equal(await f.runtime.errandDeliveryFailed(f.result,'FORMAL_TEXT_OUTPUT_INVALID',new Date().toISOString()),false);
 assert.equal(f.counts().creates,0);
});
test('recipient reconnect ends its old stream without failing the pending errand',async t=>{
 const f=await fixture(t),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id);
 await f.watch(async()=>false,async()=>{throw new Error('old stream must stop');});
 assert.equal(await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:false,to:{}}),false);
 assert.equal(await f.runtime.deliverErrand(f.result,e=>f.errors.push(e)),false);assert.deepEqual(f.errors,[]);
});

test('payment reconciliation delivery failure retains private output without payment authority',async t=>{
 const f=await fixture(t),result={...f.result,payment_intent:'pi-reconciliation',payment_reconciliation:{of_job:'job-a1b2c3d4e5f6',intent_id:'pi-original',state:'unknown' as const}};
 const first=await f.submit(result),original=await f.finish(first.processed_event.processed_event_id);assert.equal(original.result.private,'payment');
 await f.watch(async()=>false,async()=>true);
 assert.equal(await f.runtime.errandDeliveryFailed(result,'FORMAL_TEXT_OUTPUT_INVALID',new Date().toISOString()),true);
 const events=await Promise.all((await f.storage.list('processed-events')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('processed-events',key)).toString())));
 const failure=events.find(d=>d.content.app_event.kind==='errand_delivery_failed');
 await f.secondBound;
 const reply=await f.finish(failure.processed_event_id,'run-2',false);assert.equal(reply.result.private,'payment');
 assert.equal((await f.runtime.result(f.source,'session',failure.processed_event_id,{text_replay:'sealed'})).result.private,'payment');
 assert.deepEqual(failure.content.app_event.payment_reconciliation,result.payment_reconciliation);assert.equal(failure.content.app_event.payment_intent,result.payment_intent);
});

const failureEvents=async(f:Awaited<ReturnType<typeof fixture>>)=>(await Promise.all((await f.storage.list('processed-events')).map(async key=>
 JSON.parse(Buffer.from(await f.storage.read('processed-events',key)).toString())))).filter(d=>d.content.app_event.kind==='errand_delivery_failed');
test('a finished job report cannot open silent; the same run then reports it',async t=>{
 const f=await fixture(t),first=await f.submit();await f.ready;
 assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:{run_id:'run-1',session_id:'session',tool_call_id:'silent'},args:{reply_mode:'none'}}),
   {status:'rejected',error_code:'ERRAND_REPORT_REQUIRED'});
 const value=await f.finish(first.processed_event.processed_event_id);
 assert.equal(value.result.reply_phase,'sealed');assert.equal(value.result.reply_mode,'text');assert.equal(value.result.reply_text,'The errand finished.');
 let calls=0;await f.watch(async()=>false,async()=>{calls++;return true;});
 assert.equal(await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}),'pending');
 assert.equal(calls,1);assert.deepEqual(await failureEvents(f),[]);assert.deepEqual(f.errors,[]);
});
test('a marked self-check result without an active owner must report to the owner',async t=>{
 const f=await fixture(t),result={...f.result,self_check_of:'job-original:0'};
 let first:Awaited<ReturnType<typeof f.submit>>|undefined;
 await f.watch(async value=>{first=await f.submit(value);return true;},async()=>true);
 assert.equal(await f.runtime.deliverErrand(result,e=>f.errors.push(e)),'pending');await f.ready;
 assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:{run_id:'run-1',session_id:'session',tool_call_id:'silent'},args:{reply_mode:'none'}}),
   {status:'rejected',error_code:'ERRAND_REPORT_REQUIRED'});
 const value=await f.finish(first!.processed_event.processed_event_id);
 assert.equal(value.result.reply_mode,'text');assert.equal(f.counts().creates,1);assert.deepEqual(f.errors,[]);
});
test('a failed report run names its stage and reason, and the failure observation carries them',async t=>{
 const f=await fixture(t,'none'),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id);
 assert.equal(value.result.reply_phase,'failed');
 let calls=0;await f.watch(async()=>false,async()=>{calls++;return true;});
 const error=await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}).then(()=>assert.fail('must reject'),error=>error);
 assert.ok(error instanceof DeliveryStageError);assert.equal(error.code,'ERRAND_REPORT_NOT_DELIVERED');assert.equal(error.stage,'report_run');
 assert.deepEqual(JSON.parse(error.reason),{run_id:'run-1',result_status:'failed',reply_phase:'failed',reply_mode:'none',warnings:value.result.warnings,
   missing_report_requirements:['nonempty_reply_text','reply_mode','output_plan'],recipient_selection:'not_started',recipient_selection_after_report_guard:true});
 assert.equal(calls,0);
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,error.code,new Date().toISOString(),{stage:error.stage,reason:error.reason}),true);
 const [failure]=await failureEvents(f);
 assert.equal(failure.content.app_event.stage,'report_run');assert.equal(failure.content.app_event.reason,error.reason);
 assert.equal(failure.content.app_event.error_code,'ERRAND_REPORT_NOT_DELIVERED');
});

for(const published of [false,true])test(`delivery diagnosis keeps successful execution separate from ${published?'published body without ACK':'known report failure'}`,async t=>{
 const f=await fixture(t),result={...f.result,terminal_reason:'completed' as const},first=await f.submit(result),value=await f.finish(first.processed_event.processed_event_id);
 await f.watch(async()=>false,async()=>true);
 if(published)await f.runtime.errandTextSent(f.source,'session',first.processed_event.processed_event_id,value.chunks.at(-1)!);
 const cause=published?undefined:{stage:'report_run',reason:'no final report'};
 await f.runtime.errandDeliveryFailed(result,'FORMAL_TEXT_CONNECTION_CHANGED',new Date().toISOString(),cause);
 const [event]=await failureEvents(f),app=event.content.app_event;
 assert.deepEqual(app.execution,{success:true,terminal_reason:'completed'});assert.equal(app.task_retry_allowed,false);
 assert.equal(app.delivery.status,published?'body_sent_without_ack':'not_delivered');
 assert.equal(app.delivery.scope,'owner_report');
 if(published){assert.equal(app.delivery.published_text_through_seq,1);assert.equal(app.delivery.rendered_text_through_seq,0);}
 else {assert.equal(app.delivery.stage,'report_run');assert.equal(app.delivery.reason,'no final report');assert.equal(app.delivery.report_guard,undefined);}
});

for(const active of [false,true])test(`selfcheck owner active=${active} routes result before a separate report admission`,async t=>{
 const routed:ErrandResult[]=[],f=await fixture(t,'text',async result=>{routed.push(result);return active;}),result={...f.result,self_check_of:'job-original:0'};
 let deliveries=0;await f.watch(async value=>{deliveries++;await f.submit(value);return true;},async()=>true);
 assert.equal(await f.runtime.deliverErrand(result,e=>f.errors.push(e)),active?'absorbed':'pending');
 if(!active)await f.ready;
 assert.deepEqual(routed,[result]);assert.equal(deliveries,active?0:1);assert.equal(f.counts().creates,active?0:1);
 assert.deepEqual(f.errors,[]);
});

test('failure replay preserves the first delivery snapshot after a late rendered ACK',async t=>{
 const f=await fixture(t),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id),chunk=value.chunks.at(-1)!;
 await f.watch(async()=>false,async()=>true);await f.runtime.errandTextSent(f.source,'session',first.processed_event.processed_event_id,chunk);
 const at=new Date().toISOString();await f.runtime.errandDeliveryFailed(f.result,'FORMAL_TEXT_CONNECTION_CHANGED',at);
 await f.runtime.acknowledge(f.source,'session',first.processed_event.processed_event_id,{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,
  target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:new Date().toISOString()});
 assert.equal(await f.runtime.errandDeliveryFailed(f.result,'FORMAL_TEXT_CONNECTION_CHANGED',at),true);
 assert.equal((await failureEvents(f))[0].content.app_event.delivery.status,'body_sent_without_ack');
});

test('a native absorption receipt remains authoritative after the self-check has ended',async t=>{
 let active=true,absorbed=false;
 const f=await fixture(t,'text',async()=>{if(active)absorbed=true;return absorbed;}),result={...f.result,self_check_of:'job-original:0'};
 let deliveries=0;await f.watch(async()=>{deliveries++;return true;},async()=>true);
 assert.equal(await f.runtime.deliverErrand(result,e=>f.errors.push(e)),'absorbed');
 active=false;
 assert.equal(await f.runtime.deliverErrand(result,e=>f.errors.push(e)),'absorbed');
 assert.equal(deliveries,0);assert.equal(f.counts().creates,0);assert.deepEqual(f.errors,[]);
});

for(const published of [0,1,2])test(`delivery body completeness requires every chunk: ${published}/2`,()=>{
 const facts=errandDeliveryFacts({success:true,terminal_reason:'completed'},undefined,{text_chunk_count:2,pending_text_chunk_count:2,
   rendered_text_through_seq:0,accepted_text_through_seq:0,published_text_through_seq:published});
 assert.equal(facts.delivery.body_complete,published===2);
 assert.equal(facts.delivery.status,published>0?'body_sent_without_ack':'unknown');
});


test('errand reports cross native conversations through sealed OUT, with publication and ACK kept separate',async t=>{
 const f=await fixture(t),timeline:string[]=[];f.output.setTimeline((_ctx,result)=>timeline.push(result.delivery_status));
 const first=await f.submit(),sealed=await f.finish(first.processed_event.processed_event_id);
 assert.ok(timeline.includes('unknown'),'sealing still publishes the original timeline event');
 const next=await f.submit({...f.result,job_id:'job-second'},'session-b');await f.secondBound;
 const context={run_id:'run-2',session_id:'session-b'},historyReads=f.counts().historyReads;
 const read=()=>f.runtime.errandReportContext(context,[f.result.job_id,'job-second','job-absent']);
 const before=timeline.length,initial=await read(),report=initial.prior_reports[0]!;
 assert.equal(timeline.length,before,'report-context reads must not publish timeline events');
 assert.deepEqual(report.source,{session_id:'session',run_id:'run-1',processed_event_id:first.processed_event.processed_event_id});
 assert.deepEqual(report.source_event,first.processed_event.content.app_event);
 assert.equal(report.job_id,f.result.job_id);assert.equal(report.reply_text,sealed.result.reply_text);
 assert.equal(report.status,'sealed');assert.equal(report.generated,true);
 assert.equal(report.publication!.published_text_through_seq,0);assert.equal(report.delivery_status,'unknown');
 assert.equal(initial.prior_reports[1]!.status,'unsealed');assert.equal(initial.prior_reports[1]!.reply_text,null);
 assert.equal(initial.prior_reports[1]!.generated,null,'an unsealed OUT cannot rule out a generated draft');
 assert.equal(initial.prior_reports[2]!.status,'missing');assert.equal(initial.prior_reports[2]!.reply_text,null);
 const chunk=sealed.chunks.at(-1)!;
 await f.runtime.errandTextSent(f.source,'session',first.processed_event.processed_event_id,chunk);
 const published=(await read()).prior_reports[0]!;
 assert.equal(published.publication!.published_text_through_seq,chunk.seq);assert.equal(published.delivery_status,'unknown');
 await f.runtime.acknowledge(f.source,'session',first.processed_event.processed_event_id,{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,
  target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:new Date().toISOString()});
 assert.equal(timeline.at(-1),'rendered','ACK still updates the original timeline');
 const afterAck=timeline.length,rendered=(await read()).prior_reports[0]!;assert.equal(rendered.delivery_status,'rendered');assert.equal(rendered.reply_text,report.reply_text);
 assert.equal(timeline.length,afterAck);
 await assert.rejects(f.runtime.errandReportContext({...context,session_id:'foreign'},[f.result.job_id]),/ERRAND_REPORT_RUN_BINDING_REQUIRED/);
 await assert.rejects(f.runtime.errandReportContext(context,Array(17).fill(f.result.job_id)),/ERRAND_REPORT_JOB_IDS_INVALID/);
 assert.equal(next.admission.session_id,'session-b');assert.equal(f.counts().historyReads,historyReads);
});


test('report-context HTTP requires internal authentication and propagates source storage failures',async t=>{
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 const server=createPersonalAIOSServer(f.runtime,{internal_token:'report-context-internal-fixture',max_request_bytes:8192,request_timeout_ms:1000});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.closeAndDrain());
 const address=server.address();assert.ok(address&&typeof address!=='string');
 await f.submit({...f.result,job_id:'http-context'},'session-b');await f.secondBound;
 const body={context:{run_id:'run-2',session_id:'session-b'},job_ids:[f.result.job_id]};
 const request=(token:string,value:unknown=body)=>fetch(`http://127.0.0.1:${address.port}/internal/hermes/errand-report-context`,{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await request('fixture')).status,401);
 const response=await request('report-context-internal-fixture');assert.equal(response.status,200);
 const payload=await response.json() as Awaited<ReturnType<PersonalAIOSRuntime['errandReportContext']>>;
 assert.equal(payload.prior_reports[0]!.reply_text,'The errand finished.');
 assert.equal((await request('report-context-internal-fixture',{...body,job_ids:['x'.repeat(129)]})).status,400);
 const nativeRoot=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;
 await t.test('actual provider HTTP bridges conversation A OUT into conversation B native completion',{skip:!nativeRoot},async()=>{
   const key=join(f.storage.root,'report-provider.key');await fs.writeFile(key,'report-context-internal-fixture');
   const script=`import json,sys
from types import SimpleNamespace
from agent.memory_manager import MemoryManager
from gateway.session_context import set_session_vars,clear_session_vars
from gateway.platforms.api_run_delegation import RunDelegation
from integrations.hermes.personal_aios import PersonalAIOSProvider
provider=PersonalAIOSProvider.__new__(PersonalAIOSProvider)
provider.base_url,provider.key_file,provider.timeout=sys.argv[1],sys.argv[2],5
manager=MemoryManager.__new__(MemoryManager);manager._providers=[provider]
agent=SimpleNamespace(session_id='transcript-b',_paios_tool_conversation='session-b',_paios_principal_id='owner',_memory_manager=manager,_interrupt_requested=False)
bridge=RunDelegation(agent,lambda _:None)
bridge.results.put({'delegation_id':'fixture-child','goal':'Report result','status':'completed','task_records':[{'tool_call_id':'fixture-phone-status','tool':'phone_status','request':{'job_id':sys.argv[3]},'result':{'job_id':sys.argv[3]}}]})
token=set_session_vars(platform='api_server',session_id='transcript-b',session_key='run-2')
try:
 bridge.resume({'messages':[]},lambda text,history: print(text.split('\\n',1)[1]) or {'messages':history})
finally: clear_session_vars(token)
`;
   const {stdout}=await promisify(execFile)(process.env.PAIOS_HERMES_PYTHON??'/opt/personal-aios-runtime/hermes-agent/.venv/bin/python',
     ['-c',script,`http://127.0.0.1:${address.port}`,key,f.result.job_id],{
       cwd:fileURLToPath(new URL('../../../../../',import.meta.url)),env:{...process.env,PYTHONPATH:nativeRoot!},timeout:15000});
   const completion=JSON.parse(stdout);assert.deepEqual(completion.prior_reports,payload.prior_reports);
 });
 const read=f.storage.read.bind(f.storage),failure=Object.assign(new Error('fixture unavailable'),{code:'EIO'});
 t.mock.method(f.storage,'read',async(namespace:string,key:string)=>{if(namespace==='d-session-bindings')throw failure;return read(namespace,key);});
 await assert.rejects(f.runtime.errandReportContext(body.context,body.job_ids),error=>error===failure);
});


test('report context resolves job identity only inside the bound run principal',async t=>{
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 const source=await f.runtime.authenticate('foreign-fixture');
 await f.runtime.submitErrand({schema_version:EVENT_SCHEMA,event_id:'errand:foreign-context',device_id:source.device_id,device_type:source.device_type,
   captured_at:new Date().toISOString(),source:{channel:source.channel},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
   payload:Buffer.from(JSON.stringify({kind:'errand_result',...f.result,principal_id:'other-owner',job_id:'foreign-context'}))},source,'foreign-session');
 await f.secondBound;
 const context=await f.runtime.errandReportContext({run_id:'run-2',session_id:'foreign-session'},[f.result.job_id]);
 assert.deepEqual(context.prior_reports,[{job_id:f.result.job_id,source:null,source_event:null,status:'missing',reply_text:null,generated:null,publication:null,delivery_status:'unknown'}]);
});


test('sealed text report with only its passed body emptied identifies only missing text',async t=>{
 const f=await fixture(t),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id);
 assert.equal(value.result.reply_phase,'sealed');assert.equal(value.result.reply_mode,'text');assert.ok(value.result.output_plan.length>0);
 value.result.reply_text='';let calls=0;await f.watch(async()=>false,async()=>{calls++;return true;});
 const error=await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}).then(()=>assert.fail('must reject'),error=>error);
 assert.ok(error instanceof DeliveryStageError);assert.equal(error.stage,'report_run');assert.equal(error.code,'ERRAND_REPORT_NOT_DELIVERED');
 assert.deepEqual(JSON.parse(error.reason),{run_id:value.result.run_id,result_status:'completed',reply_phase:'sealed',reply_mode:'text',warnings:value.result.warnings,
   missing_report_requirements:['nonempty_reply_text'],recipient_selection:'not_started',recipient_selection_after_report_guard:true});
 assert.equal(calls,0);
});

test('empty sealed report exposes its actual guard requirement as structured delivery facts',async t=>{
 const f=await fixture(t),first=await f.submit(),value=await f.finish(first.processed_event.processed_event_id);
 await f.watch(async()=>false,async()=>true);
 value.result.reply_text='';
 const error=await f.runtime.errandReply('owner',value,e=>f.errors.push(e),{first:true}).then(()=>assert.fail('must reject'),error=>error);
 assert.ok(error instanceof DeliveryStageError);
 const guard=JSON.parse(error.reason);
 assert.deepEqual(guard,{run_id:'run-1',result_status:'completed',reply_phase:'sealed',reply_mode:'text',warnings:value.result.warnings,
   missing_report_requirements:['nonempty_reply_text'],recipient_selection:'not_started',recipient_selection_after_report_guard:true});
 await f.runtime.errandDeliveryFailed(f.result,error.code,new Date().toISOString(),{stage:error.stage,reason:error.reason});
 const [failure]=await failureEvents(f),delivery=failure.content.app_event.delivery;
 assert.equal(delivery.status,'not_delivered');assert.equal(delivery.stage,'report_run');assert.equal(delivery.reason,error.reason);
 assert.equal(delivery.scope,'owner_report');
 assert.deepEqual(delivery.report_guard,guard);
 assert.deepEqual(failure.content.app_event.execution,{success:true,terminal_reason:null});
});
test('a report run whose own reply is open but unsealed reads that job as unpublished, not a server error',async t=>{
 // Regression: the report run opens its reply, then errand-report-context answers HTTP 500.
 const f=await fixture(t),first=await f.submit();await f.finish(first.processed_event.processed_event_id);
 await f.submit({...f.result,job_id:'job-second'},'session-b');await f.secondBound;
 const context={run_id:'run-2',session_id:'session-b'};
 await f.runtime.tool('paios_open_reply',{context:{...context,tool_call_id:'open'},args:{reply_mode:'text'}});
 const report=(await f.runtime.errandReportContext(context,['job-second'])).prior_reports[0]!;
 assert.equal(report.status,'unsealed');assert.equal(report.generated,null);
 assert.equal(report.publication!.published_text_through_seq,0);
});
