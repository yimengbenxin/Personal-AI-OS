/** Opt-in end-to-end source fixture. Only native run scheduling and external device transports are synthetic. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {PersonalAIOSRuntime,RunAdmission,sourceClient,nativeSubmission,type NativeClient,type NativeRun} from '../../01-product-half-finished/backend/services/personal-aios-integration/tests/native-source-fixture.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/archive.ts';
import {OutputAuthority} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/output.ts';
import {HermesClient} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/hermes-client.ts';
import {sha256} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import {StaticFixtureDeviceAuthority,PHONE_CAPABILITIES,MAC_CAPABILITIES} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/source-authority.ts';
import {createPersonalAIOSServer} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/server.ts';
import {packageCatalog} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/packages.ts';

const [out,keyFile]=process.argv.slice(2),root=resolve('.');
await mkdir(out!,{recursive:true});
const folder=await mkdtemp(join(tmpdir(),'wiring-model-')),home=join(folder,'hermes'),storage=new PosixStorage(join(folder,'platform'));
const token='synthetic-internal-token-abcdefghijklmnop';await writeFile(join(folder,'internal.key'),token);
const families=['phone','messaging','ts-delivery','owner-mac','yimi'];
const runs=new Map<string,NativeRun>(),inputs:any[]=[],hostOperations:any[]=[];
const fake:NativeClient={create:async body=>{
  const run={run_id:`model-run-${runs.size}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running' as const};
  runs.set(run.run_id,run);inputs.push(body);return run;
},status:async id=>runs.get(id)!,cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
const native=sourceClient(fake);
const phone={principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,
  channel:'chat',consent_ref:'fixture',token_sha256:sha256('device'),route_version:'fixture',output_modes:['text']};
const authority=Object.assign(new StaticFixtureDeviceAuthority([phone,{...phone,device_id:'mac',device_type:'mac' as const,
  capabilities:MAC_CAPABILITIES,token_sha256:sha256('mac')},{...phone,channel:'background_scheduled',token_sha256:sha256('scheduled')}]),{
  scheduled:async()=>authority.authenticate('scheduled')});
const admission=new RunAdmission(storage,native,{max_pending_events:32,max_pending_bytes:1<<20,max_event_age_ms:600000,
  poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'model-wiring'});
const runtime=new PersonalAIOSRuntime({storage,native,admission,output:new OutputAuthority(storage),archive:new RawArchive(storage,1<<20),
  sourceAuthority:authority,skill:'isolated source probe',max_read_bytes:1<<20});
runtime.capabilityGateway.tools.clear();
for(const [id,tool] of packageCatalog({enabled:families,gateway:families}))runtime.capabilityGateway.tools.set(id,tool);
const server=createPersonalAIOSServer(runtime,{internal_token:token,max_request_bytes:4<<20,request_timeout_ms:1000000,
  capability_ready:runtime.wireCapabilities({enabled:families,gateway:families})});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
await writeFile(join(folder,'request.json'),JSON.stringify({root,home,out,model_key_file:keyFile,families,internal_token:token,
  integration_port:String(address.port),config:{internal_base_url:base,internal_key_file:join(folder,'internal.key')}}));
const child=spawn(process.env.PAIOS_HERMES_PYTHON!,[join(root,'tests/hermes/capability_wiring_model.py'),join(folder,'request.json')],
  {env:process.env,stdio:['pipe','pipe','pipe']});
let stderr='';child.stderr.on('data',data=>{stderr+=data;void writeFile(join(out!,'native-model.log'),stderr);});
const pending=new Map<string,ReturnType<typeof Promise.withResolvers<any>>>(),ready=Promise.withResolvers<any>();
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  if(!line.startsWith('N13:'))return;
  const result=JSON.parse(line.slice(4));if(result.ready)ready.resolve(result);else pending.get(result.name)?.resolve(result);
});
child.on('exit',code=>{
  if(code){const error=Error(`native probe exited ${code}; see native-model.log`);ready.reject(error);for(const next of pending.values())next.reject(error);}
});
const pipelineOnly=process.env.PAIOS_MODEL_PIPELINE_ONLY==='1';
const deviceOnly=process.env.PAIOS_MODEL_DEVICE_ONLY==='1';
const evidence:any[]=pipelineOnly||deviceOnly?JSON.parse(await readFile(join(out!,'model-turns.json'),'utf8'))
  .filter((row:any)=>deviceOnly?row.name.startsWith('yimi-'):!row.name.startsWith('yimi-')):[];
let sequence=0;
async function until<T>(read:()=>T|Promise<T>,done:(x:T)=>boolean,ms=10000){
  const end=Date.now()+ms;for(;;){const value=await read();if(done(value))return value;
    assert.ok(Date.now()<end,'source fixture timeout');await new Promise(r=>setTimeout(r,20));}
}
const source=await runtime.authenticate('device');
async function owner(prompt:string){
  const session=`owner-session-${++sequence}`;
  const result=await runtime.submit({schema_version:'paios.event.v1',event_id:'model-event-'+sequence,device_id:'phone',device_type:'phone',
    captured_at:new Date().toISOString(),source:{channel:'chat'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from(prompt)},source,session,true);
  const record=await until(()=>admission.getAsync('owner',session,result.processed_event.processed_event_id),x=>!!x?.run_id);
  return {run:record!.run_id!,session,processed:result.processed_event.processed_event_id};
}
async function turn(name:string,bound:{run:string;session:string},prompt:string,tools:string[],system:string,scope='owner'){
  const next=Promise.withResolvers<any>();pending.set(name,next);
  child.stdin.write(JSON.stringify({name,...bound,prompt,input:nativeSubmission(native,bound.run).input,tools,system,scope})+'\n');
  const result=await next.promise;pending.delete(name);evidence.push(result);
  await writeFile(join(out!,'model-turns.json'),JSON.stringify(evidence,null,2));
  console.log(name,JSON.stringify({calls:result.calls?.map((c:any)=>c.tool),final:result.final,error:result.error,sent:result.sent}));
  assert.ok(!result.error,result.error);assert.ok(result.calls?.length,`${name}: model did not call a tool`);return result;
}
async function finish(bound:{run:string;session:string;processed:string}){
  await runtime.tool('paios_open_reply',{context:{run_id:bound.run,session_id:bound.session,tool_call_id:'finish'},args:{reply_mode:'none'}});
  runs.get(bound.run)!.status='completed';
  await until(async()=>(await admission.getAsync('owner',bound.session,bound.processed))?.state,x=>x==='completed');
}
try{
  const started=await ready.promise;
  const client=new HermesClient(`http://127.0.0.1:${started.native_port}`,started.native_token,240000,4<<20);
  native.capability=async(operation,body)=>{hostOperations.push({operation,body});return client.capability(operation,body);};
  if(!pipelineOnly){
  const phonePrompt='在假手机准备一杯16.60元的饮料，停在收银台，不付款。';
  const phoneBound=await owner(phonePrompt);
  const phoneTurn=await turn('phone',phoneBound,phonePrompt,['mcp-phone'],
    '隔离验收，只有假设备。用户已明确要求此操作，owner_requested=true。仅用 phone_task task_type=purchase_errand 发起任务，然后用返回的 job.id 调用 phone_status 查询到终态再回答。收银台未付款就应停止；不调用付款。');
  assert.ok(phoneTurn.calls.some((c:any)=>c.tool.endsWith('__phone_task')));
  assert.ok(phoneTurn.calls.some((c:any)=>c.tool.endsWith('__phone_status')&&String(c.result).includes('未付款')&&String(c.result).includes('fake_cashier')));
  await finish(phoneBound);
  const sendPrompt='给 email:fixture@example.com 发一封测试消息，内容是“合成测试一”，这是第一次给这个人发送这种消息。';
  const sendBound=await owner(sendPrompt);
  const first=await turn('messaging-first',sendBound,sendPrompt,['mcp-yimi_shared'],
    '隔离验收。仅调用 messaging__send_message，action=send。消息目标已核实，不用再次发现联系人。owner_requested 如实为 true。若结果是 waiting，只说等待确认并结束，不重试。');
  assert.equal(first.sent,0);const cards=await runtime.voiceConfirmations(source);assert.equal(cards.length,1);
  await finish(sendBound);await runtime.confirmVoice(source,{confirmation_id:cards[0]!.confirmation_id,choice:'approve'});
  await until(async()=>{try{return JSON.parse(await readFile(join(out!,'message-executions.json'),'utf8')).length;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}},x=>x===1);
  const repeatPrompt='再给 email:fixture@example.com 发同一种测试消息，内容是“合成测试二”。';
  const repeatBound=await owner(repeatPrompt);
  const repeated=await turn('messaging-repeat',repeatBound,repeatPrompt,['mcp-yimi_shared'],
    '隔离验收。仅调用 messaging__send_message，action=send，owner_requested=true；调用后读回执并结束。');
  for(const check of repeated.calls.filter((row:any)=>row.tool.endsWith('__message_status')))assert.ok(String(check.result).includes('succeeded'));
  assert.equal(repeated.sent,2);assert.equal((await runtime.voiceConfirmations(source)).length,0);await finish(repeatBound);
  const tsBound=await owner('本轮不需要回复。');
  const ts=await turn('ts',tsBound,'调用 paios_open_reply，reply_mode=none。',['mcp-platform_ts'],
    '隔离验收。只执行用户要求的一次平台工具，然后结束；可信 _context 由网关注入，不自行填写。');
  assert.ok(ts.calls.some((c:any)=>c.tool.endsWith('__paios_open_reply')&&String(c.result).includes('succeeded')));await finish(tsBound);
  const macPrompt='请在假 Mac 上执行 pwd，查看当前目录。';
  const macBound=await owner(macPrompt);
  const mac=await turn('owner-mac',macBound,macPrompt,['mcp-owner_mac'],
    '隔离验收，无真实设备。使用 exec command=pwd，owner_requested=true。可信 context 由网关注入，省略。只调用一次再报告回执。');
  assert.ok(mac.calls.some((c:any)=>c.tool.endsWith('__exec')&&String(c.result).includes('succeeded')));await finish(macBound);
  }
  // The source scheduler issues the actual isolated build admission with this owner input as its origin.
  if(!deviceOnly){
  const buildPrompt='做一个 text-stats 能力：输入一段文本，返回字符数和行数，不访问文件、不联网。用 Python 标准库即可。';
  const buildOwner=await owner(buildPrompt);
  const build=await runtime.scheduledTask({principal_id:'owner',device_id:'phone',job_id:'capability-model-build',occurrence_id:'once',
    captured_at:new Date().toISOString(),prompt:buildPrompt,skills:[],origin_processed_event_id:buildOwner.processed,build_input_ref:buildOwner.processed});
  const buildRecord=await until(()=>admission.getAsync('owner',build.admission.session_id,build.processed_event.processed_event_id),x=>!!x?.run_id);
  const built=await turn('yimi-build',{run:buildRecord!.run_id!,session:buildRecord!.session_id},buildPrompt,['skills_hub'],
    '你是依米，当前是有真实主人来源的隔离 build 运行。先 capability_find 查复用，再 skills_hub(action=build,name=text-stats,value=完整需求) 构建标准包；它会自动登记。拿到64位 candidate_id 后 skills_hub(action=promote,value=candidate_id) 直接上线。不要调用 package_write，也不要自己写源码：远程隔离构建器使用真实模型。成功上线后结束。', 'build');
  assert.ok(built.calls.some((c:any)=>c.tool==='skills_hub'&&c.args.action==='promote'));
  assert.ok(built.dynamic.length);const connection=built.host_connection;
  const usePrompt='用刚上线的 text-stats 能力统计“你好\n世界”的字符数和行数。';
  const useBound=await owner(usePrompt);
  const used=await turn('yimi-use',useBound,usePrompt,['mcp-yimi_shared'],
    '隔离验收。只调用 text-stats 包提供的新工具，传入实际文本“你好\n世界”，读回执并报告数字。不要使用 messaging 工具。');
  assert.equal(used.host_connection,connection);assert.ok(used.calls.some((c:any)=>String(c.result).includes('succeeded')));await finish(useBound);
  const rollbackBound=await owner('改回去');
  const rolled=await turn('yimi-rollback',rollbackBound,'改回去',['skills_hub'],
    '主人要撤销最近上线的能力包。调用 skills_hub(action=revert,value="")，不要产品发布回滚；然后 skills_hub(action=status,value="") 核实。');
  assert.equal(rolled.host_connection,connection);assert.equal(rolled.dynamic.length,0);
  assert.equal((await runtime.capabilityRegistry!.status({principal_id:'owner',run_id:rollbackBound.run,scope:'owner'})).enabled
    .filter(version=>version.manifest.extensions['ai.yimi.capability'].maintainer==='yimi').length,0);
  }
  const facts:any[]=[];
  for(const run of runs.keys())facts.push({run,records:await runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:run})});
  await writeFile(join(out!,'model-ledger.json'),JSON.stringify(facts,null,2));
  await writeFile(join(out!,'model-summary.json'),JSON.stringify({model:'deepseek-v4.1-flash',provider:'Open Design Go',
    gateway:'actual HTTP source',native:'exact composed source',first_send:{before:0,approved:1,repeat:2,pending_after_repeat:0},
    dynamic_connection_unchanged:true,after_rollback:[],seams:['native run scheduler transport','fake device transports',
      'external builder task-budget service','loopback TLS Workshop transport executing the source isolated runner'],
    vision:'not_run_text_only_provider',families:evidence.map(row=>row.name)},null,2));
}finally{
  child.stdin.write(JSON.stringify({action:'close'})+'\n');child.stdin.end();
  if(child.exitCode===null)await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,10000))]);
  if(child.exitCode===null)child.kill('SIGTERM');
  await writeFile(join(out!,'native-model.log'),stderr);
  await writeFile(join(out!,'model-host-operations.json'),JSON.stringify(hostOperations,null,2));
  await server.closeAndDrain();await runtime.close();await rm(folder,{recursive:true,force:true});
}
