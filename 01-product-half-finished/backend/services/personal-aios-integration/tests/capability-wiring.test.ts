import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PersonalAIOSRuntime,RunAdmission,sourceClient,nativeSubmission,type NativeClient,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {OutputAuthority} from '../src/output.ts';
import {RawArchive} from '../src/archive.ts';
import {sha256,canonical,digest,ownerActionGrant,type ProcessedEvent} from '../src/contracts.ts';
import {nativeApprovalId,VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import {StaticFixtureDeviceAuthority,PHONE_CAPABILITIES,MAC_CAPABILITIES} from '../src/source-authority.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {packageCatalog,mcpIdentity} from '../src/capability/packages.ts';
import {CapabilityGateway,toolEffect} from '../src/capability/gateway.ts';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {packageNames,cases} from './ts-packages-fixture.ts';
import {recordFacts,receiptFacts,renderFacts} from '../src/capability/renderer.ts';
import {checkReport} from '../src/capability/checker.ts';
import {readPackage} from '../src/capability/registry/registry.ts';
import {OfflineRegistrationRunner} from '../src/capability/registry/runner.ts';
import {EnabledPackages} from '../src/capability/registry/selection.ts';
import type {PackageContext} from '../src/capability/registry/interfaces.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {paymentFixture,signed} from './payment-fixture.ts';
import {receipt,succeeded,effect,to_mcp_result,value} from '../../../../../capability/sdk/ts/receipt.ts';
import {fileURLToPath} from 'node:url';
import {migrateSendConsents} from '../src/capability/send-consent-migration.ts';
import {directory,records,recordScope} from './send-consent-fixture.ts';
import {SEND_CONSENTS} from '../src/capability/send-identity.ts';

async function until<T>(read:()=>T|Promise<T>,done:(row:T)=>boolean):Promise<T>{
  const deadline=Date.now()+5000;
  for(;;){const row=await read();if(done(row))return row;assert.ok(Date.now()<deadline,'gateway lifecycle did not settle');await new Promise(r=>setTimeout(r,5));}
}
async function fixture(t:test.TestContext,packages:string[],payment?:PaymentAuthority){
  const folder=await mkdtemp(join(tmpdir(),'cap-wiring-')),storage=new PosixStorage(join(folder,'data'));
  const runs=new Map<string,NativeRun>(),inputs:unknown[]=[],executed:any[]=[];
  const fake:NativeClient={create:async body=>{
    const run={run_id:`run-${runs.size}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running' as const};
    runs.set(run.run_id,run);inputs.push(body);return run;
  },status:async run=>runs.get(run)!,cancel:async run=>({...runs.get(run)!,status:'cancelled'})};
  const native=sourceClient(fake);
  native.capability=async(op,body:any)=>{
    if(op==='prepare')return {args:body.args,consent:{target:body.args.target??(String(body.tool_name).includes('wechat-mac')?'wechat:name:fixture':body.args.recipient),
      message_kind:body.args.task_type==='send_file'?'file':body.args.action==='react'?'react':body.args.action==='unreact'?'unreact':'text',
      task_type:`send_message:${String(body.args.target??'email:').split(':')[0]}:${body.args.action??'send'}`}};
    assert.equal(op,'execute');executed.push(structuredClone(body));
    return to_mcp_result(succeeded({effects:[effect(body.consent.effect,body.consent.target,'fixture','service_ack','isolated fake')] }));
  };
  const phone={principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,
    channel:'chat',consent_ref:'fixture',token_sha256:sha256('device'),route_version:'route',output_modes:['text']};
  const mac={...phone,device_id:'mac',device_type:'mac' as const,capabilities:MAC_CAPABILITIES,token_sha256:sha256('mac')};
  const authority=Object.assign(new StaticFixtureDeviceAuthority([phone,mac,{...phone,channel:'background_scheduled',token_sha256:sha256('scheduled')}]),{
    scheduled:async()=>authority.authenticate('scheduled')});
  const admission=new RunAdmission(storage,native,{max_pending_events:12,max_pending_bytes:1048576,max_event_age_ms:60000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'wiring'});
  const runtime=new PersonalAIOSRuntime({storage,native,admission,output:new OutputAuthority(storage),archive:new RawArchive(storage,1048576),
    sourceAuthority:authority,skill:'fixture',max_read_bytes:1048576,...(payment?{payment,payment_devices:async()=>[phone,mac]}:{})});
  runtime.capabilityGateway.tools.clear();for(const [id,tool] of packageCatalog({enabled:packages,gateway:packages}))runtime.capabilityGateway.tools.set(id,tool);
  const server=createPersonalAIOSServer(runtime,{internal_token:'synthetic-internal-token-abcdefghijklmnop',max_request_bytes:4<<20,
    request_timeout_ms:10000,capability_ready:runtime.wireCapabilities({enabled:packages,gateway:packages})});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await server.closeAndDrain();await runtime.close();await rm(folder,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const source=await runtime.authenticate('device');let sequence=0;
  async function bind(context:{run:string;session:string}){
    await admission.observeHook({hook:'pre_llm_call',payload:{session_id:context.session,turn_id:`turn-${context.run}`,task_id:'trusted-child',
      user_message:nativeSubmission(native,context.run).input}});
  }
  async function owner(session='session'){
    const result=await runtime.submit({schema_version:'paios.event.v1',event_id:`owner-${++sequence}`,device_id:source.device_id,
      device_type:source.device_type,captured_at:new Date().toISOString(),source:{channel:'chat'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('按我的要求办理')},source,session,true);
    const bound=await until(()=>admission.getAsync('owner',session,result.processed_event.processed_event_id),row=>!!row?.run_id);
    await bind({session,run:bound!.run_id!});
    return {run:bound!.run_id!,session,processed:result.processed_event.processed_event_id};
  }
  async function rpc(operation:string,body:unknown){
    const response=await fetch(base+'/internal/hermes/gateway/'+operation,{method:'POST',headers:{
      Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop','Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result as any;
  }
  const envelope=(context:{run:string;session:string},tool:string,args:object,call=`call-${++sequence}`)=>({api_request_id:`opaque-attempt-${call}`,
    session_id:context.session,task_id:'trusted-child',tool_call_id:call,turn_id:`turn-${context.run}`,tool_name:tool,args,middleware_trace:[]});
  return {runtime,storage,owner,bind,rpc,envelope,runs,inputs,executed,source,base,native,folder,admission,authority};
}

test('declared MCP identities match the exact composed native sanitizer and length limit',()=>{
  const pairs=[['yimi_shared','wechat-mac__wechat_send_text'],['yimi_shared','12345678_very-long-package-name__'+'word-'.repeat(12)],
    ['phone','phone_task'],['server-中文','emoji-😀']];
  const native=spawnSync(process.env.PAIOS_HERMES_PYTHON!,['-c',
    'import json,sys;from tools.mcp_tool_schema import mcp_prefixed_tool_name;print(json.dumps([mcp_prefixed_tool_name(*pair) for pair in json.load(sys.stdin)]))'],
    {input:JSON.stringify(pairs),encoding:'utf8',env:{...process.env,PYTHONPATH:process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT}});
  assert.equal(native.status,0,native.stderr);assert.deepEqual(pairs.map(pair=>mcpIdentity(pair[0]!,pair[1]!)),JSON.parse(native.stdout));
});

test('HTTP gateway overwrites all phone identity and job fields and preserves scope-only reads and workspace stops',async t=>{
  const f=await fixture(t,['phone']),context=await f.owner();
  for(const [name,args] of [['phone_task',{task_type:'read_app',goal:'read',owner_requested:false}],['phone_cancel',{}],['phone_start',{}]] as const){
    const input=f.envelope(context,'mcp__phone__'+name,{...args,principal_id:'attacker',job_id:'foreign',origin_processed_event_id:'foreign',
      context:{run_id:'foreign'},self_check_of:'forged'});
    const result=await f.rpc('decide',input);assert.equal(result.action,'modify');assert.equal(result.args.principal_id,'owner');
    if(name!=='phone_cancel'){assert.notEqual(result.args.job_id,'foreign');assert.equal(result.args.context.run_id,context.run);}
  }
  const result=await f.rpc('decide',f.envelope(context,'mcp__phone__phone_save_apps',{apps:['fixture'],owner_requested:false}));
  assert.equal(result.action,'block');assert.equal(JSON.parse(result.message).structuredContent.status.state,'waiting');
});

test('HTTP reconciliation injects the original operation identity and requires an explicit choice when ambiguous',async t=>{
  const f=await fixture(t,['wechat-mac','mijia']),bound=await f.owner();
  for(const [send,read,args,target]of [
    ['wechat_send_text','wechat_read_recent',{recipient:'wechat:fixture',command:'fixture'},'wechat:fixture'],
    ['control_device','read_device',{device:'lamp',service:'light',property:'on',value:true},'mijia:1']
  ] as const){
    const identity=(name:string)=>[...f.runtime.capabilityGateway.tools].find(([,tool])=>tool.name===name)![0];
    const original=f.envelope(bound,identity(send),args),id=digest(['owner',bound.run,original.task_id,original.tool_call_id]);
    const {middleware_trace:_,...wire}=original;
    const telemetry={status:'success',duration_ms:1,error_type:null,error_message:null};
    await f.rpc('receipt',{...wire,...telemetry,result:to_mcp_result(receipt('unknown',{
      effects:[effect(send==='control_device'?'physical':'send',target,'fixture','unknown','',id)],
      next:{retry:'after_check',check_with:read}}))});
    const input=f.envelope(bound,identity(read),send==='control_device'?{device:'lamp'}:{recipient:'wechat:fixture'});
    const checked=await f.rpc('decide',input);assert.equal(checked.action,'modify');assert.equal(checked.args.check_for,id);
    const later=f.envelope(bound,identity(send),{...args,fixture:'another'}),laterId=digest(['owner',bound.run,later.task_id,later.tool_call_id]);
    const {middleware_trace:__,...laterWire}=later;
    await f.rpc('receipt',{...laterWire,...telemetry,result:to_mcp_result(receipt('unknown',{
      effects:[effect(send==='control_device'?'physical':'send',target,'fixture','unknown','',laterId)],next:{retry:'after_check',check_with:read}}))});
    const ambiguous=await f.rpc('decide',input);assert.equal(ambiguous.args.check_for,'');
    const explicit=await f.rpc('decide',{...input,args:{...input.args,check_for:id}});
    assert.ok(['allow','modify'].includes(explicit.action));assert.equal(explicit.args?.check_for??id,id);
    await assert.rejects(f.runtime.capabilityCall('decide',{...input,args:{...input.args,check_for:'foreign'}}),/CAPABILITY_CHECK_BINDING_REQUIRED/);
  }
});

test('real HTTP confirmation executes the frozen send once after parent completion, carries the same ledger facts and remembers only person plus kind',async t=>{
  const f=await fixture(t,['messaging']),first=await f.owner();
  const call=f.envelope(first,'send_message',{action:'send',target:'email:fixture@example.com',message:'original',owner_requested:true,idempotency_key:'forged'});
  const result=await f.rpc('decide',call);assert.equal(result.action,'block');assert.equal(f.executed.length,0);
  const [card]=await f.runtime.voiceConfirmations(f.source);assert.ok(card);
  const read=await f.rpc('decide',f.envelope(first,'mcp__yimi_shared__messaging__send_message',{action:'list'}));
  assert.equal(read.action,'modify');
  await f.runtime.tool('paios_open_reply',{context:{run_id:first.run,session_id:first.session,tool_call_id:'finish'},args:{reply_mode:'none'}});
  f.runs.get(first.run)!.status='completed';
  await until(async()=>(await f.admission.getAsync('owner',first.session,first.processed))?.state,s=>s==='completed');
  await f.runtime.confirmVoice(f.source,{confirmation_id:card!.confirmation_id,choice:'approve'});
  await until(()=>f.executed.length,n=>n===1);await until(()=>f.runs.size,n=>n===2);
  await f.runtime.confirmVoice(f.source,{confirmation_id:card!.confirmation_id,choice:'approve'});
  assert.equal(f.executed[0].args.message,'original');assert.notEqual(f.executed[0].args.idempotency_key,'forged');
  const original={principal_id:'owner',run_id:first.run},rows=await f.runtime.capabilityGateway.ledger.records(original);
  assert.deepEqual(rows.map(row=>row.receipt.status.state),['waiting','succeeded']);
  const current=await f.runtime.capabilityGateway.ledger.current(original);assert.equal(current.length,1);
  const followup=await until(()=>f.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:'run-1'}),rows=>rows.length>0);
  assert.deepEqual(recordFacts(followup,'run-1'),recordFacts(current,first.run));
  const again=await f.owner('next');
  const repeated=await f.rpc('decide',f.envelope(again,'mcp__yimi_shared__messaging__send_message',{action:'send',target:'email:fixture@example.com',message:'second',owner_requested:true}));
  assert.equal(repeated.action,'modify');
  const changed=await f.rpc('decide',f.envelope(again,'send_message',{action:'react',target:'email:fixture@example.com',owner_requested:true}));
  assert.equal(changed.action,'block');assert.equal(JSON.parse(changed.message).structuredContent.status.state,'waiting');
  assert.equal(f.executed.length,1);
});

test('RQ-103 real gateway + native WeChat preparation reuse migrated grants and ignore forged effect metadata',async t=>{
  const f=await fixture(t,['wechat-mac']),native=f.native.capability.bind(f.native);
  f.native.capability=async(operation,body:any)=>{
    if(operation!=='prepare')return native(operation,body);
    const prepared=spawnSync(process.env.PAIOS_HERMES_PYTHON!,['-c',
      "import sys,json,importlib;from gateway import channel_directory;body=json.load(sys.stdin);channel_directory.load_directory=lambda:body['directory'];server=importlib.import_module('capability.packages.wechat-mac.server.server');print(json.dumps(server.prepare_call(body['name'],body['args'])))"],
      {input:JSON.stringify({directory,name:body.tool_name.split('__').at(-1),args:body.args}),encoding:'utf8',
        env:{...process.env,PYTHONPATH:resolve(import.meta.dirname,'../../../../..')+':'+process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT}});
    assert.equal(prepared.status,0,prepared.stderr);return JSON.parse(prepared.stdout);
  };
  for(const record of records){const scoped={...record,principal_id:'owner',confirmed_by:'owner'};
    await f.storage.publish('effect-consents',digest(recordScope(scoped)),Buffer.from(canonical(scoped)));}
  assert.equal((await migrateSendConsents(f.storage,'owner',directory)).migrated,2);
  const bound=await f.owner();
  for(const tool of ['wechat_send_text','wechat_reply','wechat_send_file']){
    const decision=await f.rpc('decide',f.envelope(bound,'mcp__wechat-mac__'+tool,{recipient:'wechat:测试联系人',
      command:'fixture-'+tool,owner_requested:true,task_type:'an-invented-new-release-task',effect:{recipient:'wechat:另一个人',task_type:'different'}}));
    assert.equal(decision.action,'modify');assert.equal(decision.args.recipient,'wechat:name:测试联系人');
    assert.equal(decision.args.task_type,undefined);assert.equal(decision.args.effect,undefined);
  }
  assert.equal((await f.runtime.voiceConfirmations(f.source)).length,0);
  for(const tool of f.runtime.capabilityGateway.tools.values())tool.version_digest='f'.repeat(64);
  const upgraded=await f.rpc('decide',f.envelope(bound,'mcp__wechat-mac__wechat_send_text',{
    recipient:'wechat:测试·联系人',command:'release-upgrade',owner_requested:true}));
  assert.equal(upgraded.action,'modify');
  const stranger=await f.rpc('decide',f.envelope(bound,'mcp__wechat-mac__wechat_send_text',{
    recipient:'wechat:另一个人',command:'new-person',owner_requested:true}));
  assert.equal(stranger.action,'block');assert.equal((await f.runtime.voiceConfirmations(f.source)).length,1);
  const raw=await f.runtime.effectConsent({run_id:bound.run,session_id:bound.session,tool_call_id:'forged-stable-key'},
    {kind:'send',recipient:'wechat:name:测试联系人',task_type:'message.text',requested:true});
  assert.equal(raw.status,'confirmation_required');assert.equal(f.executed.length,0);
});

test('assembly restores an approved frozen call that calls its own HTTP ports during recovery',async t=>{
  const f=await fixture(t,['messaging']),bound=await f.owner();
  await f.rpc('decide',f.envelope(bound,'send_message',{
    action:'send',target:'email:fixture@example.com',message:'recover',owner_requested:true}));
  const [card]=await f.runtime.voiceConfirmations(f.source);assert.ok(card);
  await f.runtime.tool('paios_open_reply',{context:{run_id:bound.run,session_id:bound.session,tool_call_id:'finish'},args:{reply_mode:'none'}});
  f.runs.get(bound.run)!.status='completed';
  await until(async()=>(await f.admission.getAsync('owner',bound.session,bound.processed))?.state,state=>state==='completed');
  const cards=new VoiceConfirmations(f.storage);
  await cards.decide(card.confirmation_id,f.source,'approve');cards.close();await f.runtime.close();
  const execute=f.native.capability.bind(f.native);
  f.native.capability=async(operation,body)=>{
    if(operation==='execute'){
      const address=restored.server.address();assert.ok(address&&typeof address!=='string');
      const response=await fetch(`http://127.0.0.1:${address.port}/internal/hermes/gateway/catalog`,{
        headers:{Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop'},signal:AbortSignal.timeout(2000)});
      assert.equal(response.status,200);
    }
    return execute(operation,body);
  };
  const restored=createPersonalAIOSAssembly({storage:f.storage,native:f.native,sourceAuthority:f.authority,
    admission:{max_pending_events:12,max_pending_bytes:1048576,max_event_age_ms:60000,poll_interval_ms:5,
      native_idempotency_retention_ms:86400000,policy_version:'wiring'},skill:'fixture',max_event_bytes:1048576,max_read_bytes:1048576,
    http:{internal_token:'synthetic-internal-token-abcdefghijklmnop',max_request_bytes:4<<20,request_timeout_ms:10000}});
  try{
    await new Promise<void>(resolve=>restored.server.listen(0,'127.0.0.1',resolve));
    const rows=await until(()=>restored.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:bound.run}),
      rows=>rows.some(row=>row.phase==='result'));
    assert.equal(rows[0]!.receipt.status.state,'succeeded');assert.equal(f.executed.length,1);
  }finally{await restored.close();}
});

test('all eight TS packages share the actual HTTP catalog and trusted context injection',async t=>{
  const names=['ts-delivery','ts-erasure','ts-health','ts-location','ts-memory','ts-model-settings','ts-personal','ts-schedule'];
  const f=await fixture(t,names),context=await f.owner();let total=0;
  for(const [identity,tool] of f.runtime.capabilityGateway.tools){
    const branch=tool.effect_by_arg&&Object.values(tool.effect_by_arg)[0];
    const key=branch&&Object.entries(branch).find(([,effect])=>effect==='observe')?.[0];
    const path=tool.effect_by_arg&&Object.keys(tool.effect_by_arg)[0]!.slice(2);
    const result=await f.rpc('decide',f.envelope(context,identity,{...(path&&key?{[path]:key}:{}),owner_requested:true,
      _context:{run_id:'forged',session_id:'forged',tool_call_id:'forged'}}));
    assert.equal(result.action,'modify',identity);assert.equal(result.args._context.run_id,context.run);total++;
  }
  assert.equal(total,30);
  const catalog=await fetch(f.base+'/internal/hermes/gateway/catalog',{headers:{Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop'}}).then(r=>r.json()) as any;
  assert.ok(catalog.tools.includes('paios_health_query'));
});

test('withdrawing a waiting tool cannot lose its frozen package identity or uncertain result',async t=>{
  const f=await fixture(t,['messaging']),bound=await f.owner();
  const decision=await f.rpc('decide',f.envelope(bound,'send_message',{
    action:'send',target:'email:fixture@example.com',message:'frozen',owner_requested:true}));
  assert.equal(decision.action,'block');const [card]=await f.runtime.voiceConfirmations(f.source);assert.ok(card);
  f.runtime.capabilityGateway.tools.clear();
  f.native.capability=async()=>{throw Error('frozen transport version withdrawn');};
  await f.runtime.confirmVoice(f.source,{confirmation_id:card!.confirmation_id,choice:'approve'});
  const rows=await until(()=>f.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:bound.run}),
    rows=>rows.some(row=>row.phase==='result'));
  assert.equal(rows[0]!.package,'messaging');assert.equal(rows[0]!.receipt.status.state,'unknown');
  assert.equal(rows[0]!.receipt.next.retry,'after_check');assert.equal(f.executed.length,0);
});

test('typed renderer progress, partial unknowns and identifier values survive the single checker without exempting model prose',()=>{
  const cases=[receipt('running',{status:{progress:{done:2,total:5,unit:'份'}}}),
    receipt('partial',{unknowns:[{about:'其余任务',why:'结果未知'}]}),succeeded({values:[value('订单号','123456789','none','observed','screen','2026-10-25T00:00:00Z')]})];
  for(const body of cases){const facts=receiptFacts([body]),text=renderFacts(facts,'text');
    assert.equal(checkReport(text,[body],'',facts).removed.length,0,text);}
  const body=cases[2]!,facts=receiptFacts([body]);assert.ok(checkReport('金额是123456789元。',[body],'',facts).removed.length);
});

test('native multimodal results keep their structured receipt in the real HTTP ledger',async t=>{
  const f=await fixture(t,['owner-mac']),bound=await f.owner();
  const call=f.envelope(bound,'mcp__owner_mac__computer_use',{action:'capture'});
  const decision=await f.rpc('decide',call),{middleware_trace:_trace,...wire}=call;
  const result={_multimodal:true,text_summary:'not a public receipt source',
    content:[{type:'text',text:JSON.stringify({result:'succeeded\nMEDIA:/fixture.png',structuredContent:succeeded()})},
      {type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]};
  const view=await f.rpc('receipt',{...wire,args:decision.args,result,status:'success',duration_ms:1,error_type:null,error_message:null});
  assert.match(view.model_view,/"state":"succeeded"/);
  assert.equal((await f.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:bound.run}))[0]!.receipt.status.state,'succeeded');
});

test('combined TS read/write arguments are classified by the source and cannot forge the read selector',async t=>{
  const f=await fixture(t,['ts-personal']),bound=await f.owner();
  for(const [name,args,operation,action] of [
    ['paios_people',{},'read','modify'],['paios_people',{face_recognition:true,_operation:'read'},'update','block'],
    ['paios_people',{forget:'speaker:fixture',_operation:'read'},'delete','block'],
    ['paios_visual_capture_policy',{},'read','modify'],['paios_visual_capture_policy',{enabled:true,_operation:'read'},'update','block']
  ] as const){
    const result=await f.rpc('decide',f.envelope(bound,name,{...args,owner_requested:false}));
    assert.equal(result.action,action,name);if(result.args)assert.equal(result.args._operation,operation);
  }
});

test('one package monitor exception does not suppress the next package health check',async t=>{
  const f=await fixture(t,['yimi']);await f.runtime.monitorCapabilities();
  const tool=[...packageCatalog({enabled:['phone'],gateway:['phone']}).values()][0]!;
  for(const name of ['unavailable-package','healthy-package'])f.runtime.capabilityGateway.tools.set(name,
    {...tool,package:name,principal_id:'owner',version_digest:sha256(name)});
  const checked:string[]=[];t.mock.method(console,'warn',()=>{});
  t.mock.method(f.runtime.capabilityRegistry!,'monitor',async(_context:PackageContext,name:string)=>{
    checked.push(name);if(name==='unavailable-package')throw Error('fictional monitor failure');
    return {health:true,current:{total:0,failed:0,unknown:0},previous:null,rollback:null};
  });
  await f.runtime.monitorCapabilities();
  assert.deepEqual(checked,['unavailable-package','healthy-package']);
});

test('all six authenticated registry RPCs use admission, the enabled CAS and real ledger version outcomes',async t=>{
  const f=await fixture(t,['yimi']),bound=await f.owner();
  const context={run_id:bound.run,session_id:bound.session,tool_call_id:'registry',principal_id:'spoofed'};
  const files=await readPackage(fileURLToPath(new URL('../../../../../capability/templates/yimi-capability-template',import.meta.url)));
  const declared=JSON.parse(files['plugin.json']!),mcp=JSON.parse(files['mcp.json']!);
  const original=declared.extensions['ai.yimi.capability'].runtime.server;
  declared.extensions['ai.yimi.capability'].runtime.server='platform_ts';files['plugin.json']=JSON.stringify(declared);
  mcp.mcpServers.platform_ts=mcp.mcpServers[original];delete mcp.mcpServers[original];files['mcp.json']=JSON.stringify(mcp);
  const directory=join(f.folder,'worker');await mkdir(directory);
  for(const [name,text] of Object.entries(files)){const path=join(directory,name);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text);}
  const runner=new OfflineRegistrationRunner(process.env.PAIOS_HERMES_PYTHON!);let healthy=true,activated=0,prepared=0;
  f.native.capability=async(op,body:any)=>{
    if(op==='registration-check')return runner.check(directory);
    if(op==='discovery')return [];
    if(op==='package-prepare'){prepared++;return {tools:[]};}
    if(op==='package-activate'){
      activated++;assert.equal(body.principal_id,'owner');
      if(body.next&&body.expected===null)assert.deepEqual(JSON.parse(Buffer.from(await f.storage.read('capability-packages',
        (await import('../src/contracts.ts')).digest('owner'))).toString()).versions,[],'first activation has a durable empty preimage');
      return {active:true};
    }
    if(op==='package-health')return {healthy};
    if(op==='prepare')return {args:body.args};
    throw Error(op);
  };
  const denied=await fetch(f.base+'/internal/hermes/gateway/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({context})});
  assert.equal(denied.status,401);
  assert.equal((await f.rpc('find',{context,query:'sample'})).results.length,3);
  const checked=await f.rpc('check',{context,files});assert.equal(checked.evidence.cases.length,2);
  const published=await f.rpc('publish',{context,candidate_id:checked.candidate_id});assert.equal(published.changed,true);
  const identity=[...f.runtime.capabilityGateway.tools.keys()][0]!;
  assert.ok(identity.startsWith('mcp__yimi_shared__'));assert.equal(activated,1);
  const cold=new CapabilityGateway(f.storage,async()=>({action:'allow'}),new Map());
  await new EnabledPackages(f.storage,cold,f.native).recover();
  assert.equal(prepared,2,'a fresh native home preloads the committed version before activation');assert.ok(cold.tools.has(identity));
  const call=f.envelope(bound,identity,{});
  assert.equal((await f.rpc('decide',call)).action,'allow');
  const {middleware_trace:_trace,...wire}=call;
  await f.rpc('receipt',{...wire,result:to_mcp_result(succeeded()),status:'success',duration_ms:1,error_type:null,error_message:null});
  assert.deepEqual(await f.runtime.capabilityGateway.ledger.outcomes('owner',published.version.name,published.version.digest),{total:1,failed:0,unknown:0});
  assert.equal((await f.rpc('status',{context})).enabled.length,1);
  assert.equal((await f.rpc('monitor',{context,name:published.version.name})).health,true);
  async function outcomes(state:'succeeded'|'failed',prefix:string){
    for(let i=0;i<20;i++){
      const active=[...f.runtime.capabilityGateway.tools.keys()][0]!;
      const wire=f.envelope(bound,active,{},`${prefix}-${i}`),{middleware_trace:_trace,...envelope}=wire;
      await f.rpc('receipt',{...envelope,result:to_mcp_result(receipt(state)),status:'success',duration_ms:1,error_type:null,error_message:null});
    }
  }
  await outcomes('succeeded','healthy');
  const next={...files},manifest=JSON.parse(next['plugin.json']!);manifest.version='0.1.1';next['plugin.json']=JSON.stringify(manifest);
  const update=await f.rpc('check',{context,files:next});await f.rpc('publish',{context,candidate_id:update.candidate_id});
  const latestIdentity=[...f.runtime.capabilityGateway.tools.keys()][0]!;
  assert.notEqual(latestIdentity,identity,'each immutable version has a distinct execution identity');
  await outcomes('failed','regression');
  const regression=await f.rpc('monitor',{context,name:published.version.name});assert.equal(regression.rollback.reason,'outcome_regression');
  assert.equal(f.runtime.capabilityGateway.tools.get(identity)!.version_digest,published.version.digest);
  const removed=await f.rpc('rollback',{context});assert.equal(f.runtime.capabilityGateway.tools.size,0);
  assert.equal(removed.outcome,'removed_package');
  if(process.env.PAIOS_WIRING_EVIDENCE)await writeFile(join(process.env.PAIOS_WIRING_EVIDENCE,'registry-rollback-result.json'),JSON.stringify(removed,null,2));
  await f.rpc('publish',{context,candidate_id:checked.candidate_id});healthy=false;
  const monitored=await f.rpc('monitor',{context,name:published.version.name});assert.ok(monitored.rollback);
  assert.equal(f.runtime.capabilityGateway.tools.size,0);
});

async function tableScopes(t:test.TestContext,packages:string[]){
  const f=await fixture(t,packages);await f.runtime.configureTimeline({directory:join(f.folder,'timeline')});
  const owner=await f.owner();let serial=0;
  const find=f.admission.find.bind(f.admission),identities=new Map<string,ProcessedEvent>();
  f.admission.find=(run,session)=>{const entry=find(run,session);if(entry&&identities.has(run))entry.d=structuredClone(identities.get(run)!);return entry;};
  const binding=f.admission.hookBinding.bind(f.admission);
  f.admission.hookBinding=async(call,execution)=>{const entry=await binding(call,execution);
    if(identities.has(entry.record.run_id!))entry.d=structuredClone(identities.get(entry.record.run_id!)!);return entry;};
  const scopes=new Map<string,typeof owner>([['owner',owner]]);
  for(const scope of ['owner_observation','guest','care','owner_uncertain','background','background_unattributed','cron','cron_unbound','build']){
    const session='table-'+scope;
    let accepted:any;
    if(scope==='background'){
      const before=new Set(f.runs.keys());
      await f.runtime.tool('paios_desktop_queue',{context:{run_id:owner.run,session_id:owner.session,tool_call_id:'queue-origin'},args:{action:'add',task:'Table fake'}});
      await f.runtime.desktopReady(await f.runtime.authenticate('mac'));
      const entry=await until(()=>[...f.runs.keys()].filter(run=>!before.has(run)).map(run=>f.admission.find(run)).find(Boolean),Boolean);
      accepted={processed_event:entry!.d,admission:entry!.record};
    }else if(['background_unattributed','cron','cron_unbound','build'].includes(scope)){
      accepted=await f.runtime.scheduledTask({principal_id:'owner',device_id:'phone',job_id:'table-'+scope,occurrence_id:'once',
        captured_at:new Date().toISOString(),prompt:'Table source',skills:[],
        ...(['background','cron'].includes(scope)?{origin_processed_event_id:owner.processed}:{}),
        ...(scope==='build'?{build_input_ref:owner.processed}:{})});
    }else{
      accepted=await f.runtime.submit({schema_version:'paios.event.v1',event_id:'observed-'+ ++serial,device_id:'phone',device_type:'phone',
        captured_at:new Date().toISOString(),source:{channel:'chat'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
        payload:Buffer.from(JSON.stringify({kind:'health_update'}))},f.source,session,false);
    }
    const actualSession=accepted.admission?.session_id??session;
    const record=await until(()=>f.admission.getAsync('owner',actualSession,accepted.processed_event.processed_event_id),row=>!!row?.run_id);
    const entry=f.admission.find(record!.run_id!,actualSession)!;
    // The source admission is real. The restricted-role rows replay its saved identity facts at this seam.
    if(scope==='guest'||scope==='owner_uncertain')entry.d.content.app_event={kind:'voice_turn',speaker:scope==='guest'?'speaker:guest':'owner_uncertain'};
    if(scope==='care')entry.d.content.app_event={kind:'proactive_care'};
    identities.set(record!.run_id!,entry.d);
    await f.bind({run:record!.run_id!,session:actualSession});
    scopes.set(scope,{run:record!.run_id!,session:actualSession,processed:entry.d.processed_event_id});
  }
  return {...f,scopes};
}
const legacyKinds={observe:'read',owner_data:'file_edit',send:'send',account:'login',delete:'delete',physical:'external'} as const;
function disposition(result:any){
  if(result.action==='modify')return 'allow';
  if(result.action==='block'){
    try{if(JSON.parse(result.message).structuredContent.status.state==='waiting')return 'approve';}catch{}
  }
  return result.action;
}

test('P3 684-cell legacy gate table replays through the HTTP gateway; only scope-only observe cells change',async t=>{
  const f=await tableScopes(t,['phone']);
  const root=fileURLToPath(new URL('../../../../../',import.meta.url));
  const env={...process.env,PYTHONPATH:process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT};
  const oracle=(mode:string,input?:unknown)=>{
    const result=spawnSync(process.env.PAIOS_HERMES_PYTHON!,[join(root,'tests/hermes/capability_consent_table.py'),mode],{
      env,encoding:'utf8',input:input?JSON.stringify(input):undefined,maxBuffer:8<<20});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const scopes=oracle('scopes') as {tool:string;scope:string;allowed:boolean}[];
  const cases:any[]=[];
  for(const row of scopes)for(const [effect,kind] of Object.entries(legacyKinds))for(const requested of [true,false])for(const remembered of [true,false]){
    if(row.tool==='send_message'&&effect!=='send')continue;
    const bound=f.scopes.get(row.scope)!,tool_call_id='table-'+cases.length,context={run_id:bound.run,session_id:bound.session,tool_call_id};
    const task_type=row.tool==='send_message'?'send_message:email:send':'fixture';
    const target=`email:fixture-${cases.length}@example.com`;
    const legacyEffect={kind,task_type,requested,...(effect==='send'?{recipient:target}:{})};
    let legacy:unknown,error:string|undefined;
    try{
      if(remembered){const id='remembered';await f.runtime.effectConsent(context,legacyEffect,true,false,id,{
        confirmation_id:nativeApprovalId('owner',bound.run,id),confirmed_by:'owner',surface:{device_id:'phone',device_type:'phone'},confirmed_at:new Date().toISOString()});
        // The equivalence table compares the trigger, using a grant in each implementation's own key schema.
        if(effect==='send'){
          const scope={principal_id:'owner',kind,task_type: 'message.text',recipient:target,...(!requested?{run_id:bound.run,tool_call_id}:{})};
          await f.storage.publish(SEND_CONSENTS,digest(scope),Buffer.from(canonical({...scope,confirmation_id:nativeApprovalId('owner',bound.run,id),
            confirmed_by:'owner',confirmed_at:new Date().toISOString()})));
        }}
      legacy=await f.runtime.effectConsent(context,legacyEffect);
    }catch(caught){error=(caught as {code:string}).code;}
    const identity='mcp__table__'+row.tool;
    f.runtime.capabilityGateway.tools.set(identity,{package:'table',server:'table',name:row.tool,scopes:['owner'],
      effect,target:'$.recipient',task_type,retry:'forbidden',...(effect==='send'?{send_consent:{recipient:'channel' as const,kind:'message.text'}}:{})});
    const wire=await f.rpc('decide',f.envelope(bound,identity,{owner_requested:requested,recipient:target},tool_call_id));
    const actual=disposition(wire);
    cases.push({...row,effect:legacyEffect,manifest_effect:effect,scope_allowed:row.allowed,context,legacy,error,actual,wire,remembered});
  }
  const expected=oracle('decisions',cases);
  const changed=cases.filter((row,i)=>row.actual!==expected[i]);
  for(const row of changed){assert.equal(row.manifest_effect,'observe',JSON.stringify(row));assert.equal(row.actual,'allow');}
  assert.equal(cases.length,684);
  if(process.env.PAIOS_WIRING_EVIDENCE)await writeFile(join(process.env.PAIOS_WIRING_EVIDENCE,'p3-gateway-equivalence.json'),
    JSON.stringify({total:684,unchanged:684-changed.length,owner_decided:changed.length,cases:cases.map((row,i)=>({...row,legacy_action:expected[i]}))},null,2));
  assert.equal(changed.length,33);
});

test('P2 203-cell table uses the real gateway and declares every owner-decided read/lifecycle/data-gate difference',async t=>{
  const f=await tableScopes(t,['phone']);let count=0;const cells:any[]=[];
  const taskTypes={read:'read',read_app:'read',purchase_errand:'external',ride_request:'external',send_message:'send',
    wechat_message:'send',send_file:'send',login:'login',file_edit:'file_edit',delete:'delete',pay_order:'external'};
  for(const scope of ['owner','guest','care','background','cron','background_unattributed','cron_unbound']){
    const bound=f.scopes.get(scope)!,entry=f.admission.find(bound.run,bound.session)!;
    for(const [type,kind] of Object.entries(taskTypes))for(const requested of [true,false]){
      const call=f.envelope(bound,'mcp__phone__phone_task',{task_type:type,goal:'Table fake',recipient:`fixture:${count}`,owner_requested:requested},'p2-'+count++);
      let legacy='block';
      try{const result=await f.runtime.effectConsent({run_id:bound.run,session_id:bound.session,tool_call_id:call.tool_call_id},
        {kind,task_type:type,requested,...(kind==='send'?{recipient:(call.args as any).recipient}:{})});
        legacy=result.status==='allowed'?'allow':scope==='cron'||scope==='background_unattributed'||scope==='cron_unbound'?'block':'approve';}catch{}
      // A valid payment source is a separate protected-authority fixture, never an ordinary remembered consent.
      if(type==='pay_order'){
        f.runtime.paymentSource=()=>({allowed:true,ride_allowed:false});
        (call.args as any).payment_intent='pi-synthetic';
      }
      const wire=await f.rpc('decide',call),actual=disposition(wire);
      cells.push({scope,tool:'phone_task',task_type:type,requested,legacy,actual,wire});
      if(actual!==legacy)assert.ok(['read','read_app','pay_order'].includes(type),JSON.stringify(cells.at(-1)));
    }
    for(const [identity,tool] of f.runtime.capabilityGateway.tools){
      if(tool.name==='phone_task')continue;
      const granted=(await ownerActionGrant(entry.d,async()=>['background','cron'].includes(scope)?
        f.admission.find(f.scopes.get('owner')!.run)!.d:undefined)).length>0;
      const legacy=granted?'allow':'block',call=f.envelope(bound,identity,{owner_requested:true,apps:['fixture']},'p2-'+count++);
      const actual=disposition(await f.rpc('decide',call));cells.push({scope,tool:tool.name,legacy,actual});
      if(actual!==legacy)assert.ok(['observe','workspace'].includes(tool.effect!),JSON.stringify(cells.at(-1)));
    }
  }
  const original=cells.filter(row=>row.tool!=='phone_check'),checks=cells.filter(row=>row.tool==='phone_check');
  assert.equal(original.length,203);assert.equal(checks.length,7);assert.equal(count,210);
  for(const row of checks)assert.equal(row.actual,original.find(cell=>cell.tool==='phone_status'&&cell.scope===row.scope)!.actual);
  if(process.env.PAIOS_WIRING_EVIDENCE)await writeFile(join(process.env.PAIOS_WIRING_EVIDENCE,'p2-gateway-equivalence.json'),
    JSON.stringify({total:210,p2_cells:203,check_cells:7,owner_decided:cells.filter(row=>row.actual!==row.legacy).length,cells},null,2));
});

test('TS 180-cell source table crosses the HTTP gateway and shared HTTP MCP before the original runtime',async t=>{
  // The new personality tool has no legacy predecessor; its self_change door is covered in personality-runtime.test.ts.
  const f=await tableScopes(t,packageNames.filter(name=>name!=='ts-personality')),schemas=enabledToolSchemas({memory:true,actions:true,ambient:true,visual:true,
    voiceprint:true,health:true,contacts:true,places:true,movement:true,desktop_queue:true,model_settings:true});
  f.runtime.toolSchemas=()=>schemas;
  const catalog=new Map(f.runtime.capabilityGateway.tools),cells:any[]=[];
  const client=new Client({name:'gateway-equivalence',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/internal/capability/mcp'),{requestInit:{headers:{
    Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop'}}}) as Parameters<Client['connect']>[0]);
  try{
    for(const [scope,sourceScope] of [['owner','owner'],['guest','guest'],['owner_uncertain','owner_uncertain'],['care','care'],
      ['background','background_unattributed'],['cron','cron_unbound']] as const){
      const bound=f.scopes.get(sourceScope)!;
      for(const [identity,tool] of catalog){
        const args=structuredClone(cases(tool.package).find(row=>row.tool===tool.name)!.args),id='ts-table-'+cells.length;
        const context={run_id:bound.run,session_id:bound.session,tool_call_id:id};
        let legacy:any,error:string|undefined;
        f.runtime.capabilityGateway.tools.clear();
        try{legacy=await f.runtime.tool(tool.name,{context,args});}catch(caught){error=(caught as any).code;}
        finally{for(const [name,row] of catalog)f.runtime.capabilityGateway.tools.set(name,row);}
        const decision=await f.rpc('decide',f.envelope(bound,identity,{...args,owner_requested:true},id));
        let actual:any,reason:string|undefined;
        if(['allow','modify'].includes(decision.action)){
          const result=await client.callTool({name:tool.name,arguments:decision.args??args}) as any;
          const body=result.structuredContent;
          reason=body.status.reason_code;
          actual=body.content.length?JSON.parse(body.content[0].text):undefined;
          const wire=f.envelope(bound,identity,decision.args??args,id),{middleware_trace:_trace,...envelope}=wire;
          await f.rpc('receipt',{...envelope,result,status:'success',duration_ms:1,error_type:null,error_message:null});
          if(!error&&!legacy?.error_code)assert.deepEqual(actual,legacy,`${scope}:${tool.name}`);
          else if(reason!==(error??legacy.error_code)){
            assert.equal(toolEffect(tool,decision.args??args),'observe',`${scope}:${tool.name}`);
            assert.ok(['OWNER_REQUEST_REQUIRED','AMENDMENT_OWNER_REQUIRED','DESKTOP_QUEUE_OWNER_REQUIRED',
              'MODEL_SETTINGS_OWNER_REQUEST_REQUIRED'].includes(error??legacy.error_code),`${scope}:${tool.name}`);
          }
        }else assert.ok(error||legacy?.error_code,`${scope}:${tool.name}: new denial of an old successful call`);
        cells.push({scope,tool:tool.name,args,legacy:error??legacy?.error_code??'returned',gate:disposition(decision),
          result:reason??'returned'});
      }
    }
  }finally{await client.close();}
  assert.equal(cells.length,180);
  if(process.env.PAIOS_WIRING_EVIDENCE)await writeFile(join(process.env.PAIOS_WIRING_EVIDENCE,'ts-gateway-equivalence.json'),JSON.stringify({total:180,cells},null,2));
});

test('Mac 126-cell source gate table crosses the HTTP gateway and changes only scope-only reads',async t=>{
  const f=await tableScopes(t,['desktop','owner-mac']),cells:any[]=[];
  for(const family of ['desktop','owner-mac']){
    const fixtures=JSON.parse(await (await import('node:fs/promises')).readFile(new URL(
      `../../../../../capability/packages/${family}/tests/contract.yaml`,import.meta.url),'utf8')).cases;
    for(const [scope,sourceScope] of [['owner','owner'],...family==='desktop'?[['owner-ungranted','owner_observation']]:[],
      ['guest','guest'],['care','care'],['background','background_unattributed'],['cron','cron']] as [string,string][]){
      const bound=f.scopes.get(sourceScope)!,entry=f.admission.find(bound.run,bound.session)!;
      const legacy=(await ownerActionGrant(entry.d,async()=>scope==='cron'?f.admission.find(f.scopes.get('owner')!.run)!.d:undefined)).length?'allow':'block';
      for(const [identity,tool] of f.runtime.capabilityGateway.tools){
        if(tool.package!==family)continue;
        const args={...fixtures.find((row:any)=>row.tool===tool.name).args,owner_requested:true};
        const decision=await f.rpc('decide',f.envelope(bound,identity,args,'mac-table-'+cells.length));
        const actual=disposition(decision),effect=toolEffect(tool,args);
        if(actual!==legacy){assert.equal(effect,'observe');assert.equal(actual,'allow');assert.ok(['owner-ungranted','background'].includes(scope));}
        cells.push({family,tool:tool.name,scope,effect,legacy,actual,owner_decided:actual!==legacy});
      }
    }
  }
  assert.equal(cells.length,126);assert.equal(cells.filter(row=>row.owner_decided).length,21);
  if(process.env.PAIOS_WIRING_EVIDENCE)await writeFile(join(process.env.PAIOS_WIRING_EVIDENCE,'mac-gateway-equivalence.json'),
    JSON.stringify({total:126,owner_decided:21,cells},null,2));
});

test('phone terminal revisions prevent duplicate effects even when the latest snapshot belongs to the status tool',async t=>{
  const f=await fixture(t,['phone']),bound=await f.owner();
  const args={task_type:'purchase_errand',goal:'prepare synthetic order',owner_requested:true};
  const call=f.envelope(bound,'mcp__phone__phone_task',args),decision=await f.rpc('decide',call);
  const job=decision.args.job_id;
  const {middleware_trace:_trace,...wire}=call;
  await f.rpc('receipt',{...wire,args:decision.args,result:to_mcp_result(receipt('accepted',{job:{id:job,revision:1}})),
    duration_ms:1,status:'success',error_type:null,error_message:null});
  await f.runtime.deliverErrand({principal_id:'owner',job_id:job,task:'synthetic',success:true,answer:'fake',finished_at:new Date().toISOString(),
    capability_receipt:succeeded({job:{id:job,revision:2},effects:[effect('physical','fixture','prepare','verified','same order reread')]})},()=>{});
  const repeated=await f.rpc('decide',f.envelope(bound,'mcp__phone__phone_task',args));
  assert.equal(repeated.action,'block');assert.match(repeated.message,/已经成功/);
  const current=await f.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:bound.run});
  assert.equal(current.length,1);assert.equal(current[0]!.receipt.job!.revision,2);
});

test('a failed phone receipt creates one source-bound read-only self-check and reuses the same ledger facts',async t=>{
  const f=await fixture(t,['phone']),owner=await f.owner();
  const first=f.envelope(owner,'mcp__phone__phone_task',{task_type:'read_app',goal:'synthetic read'});
  const issued=await f.rpc('decide',first),job=issued.args.job_id;
  await f.runtime.tool('paios_open_reply',{context:{run_id:owner.run,session_id:owner.session,tool_call_id:'finish'},args:{reply_mode:'none'}});
  f.runs.get(owner.run)!.status='completed';
  await until(async()=>(await f.admission.getAsync('owner',owner.session,owner.processed))?.state,state=>state==='completed');
  const failed=receipt('failed',{job:{id:job,revision:2},next:{retry:'after_check',check_with:'phone_status'}});
  const result={principal_id:'owner',job_id:job,title:'synthetic read',task:'synthetic read',success:false,answer:'fake failure',
    terminal_reason:'failed' as const,finished_at:new Date().toISOString(),capability_receipt:failed};
  await f.runtime.deliverErrand(result,()=>{});await f.runtime.deliverErrand(result,()=>{});
  await until(()=>f.runs.size,n=>n===2);
  const self=[...f.runs.keys()].map(run=>f.admission.find(run)).find(entry=>(entry?.d.content.app_event as {kind?:string}|undefined)?.kind==='task_failure')!;
  assert.ok(self);const context={run:self.record.run_id!,session:self.record.session_id};
  await f.bind(context);
  const checked=await f.rpc('decide',f.envelope(context,'mcp__phone__phone_task',{
    task_type:'read_app',goal:'read the original task',owner_requested:false,self_check_of:'forged'}));
  assert.equal(checked.action,'modify');assert.equal(checked.args.self_check_of,job+':0');
  const mutation=await f.rpc('decide',f.envelope(context,'mcp__phone__phone_task',{task_type:'purchase_errand',
    goal:'retry the old effect',owner_requested:true}));assert.equal(mutation.action,'block');
  const pending=await f.runtime.receiptErrandReportContext({run_id:context.run,session_id:context.session},[job]) as any;
  assert.deepEqual(pending.receipt_facts.fact_ids,recordFacts(await f.runtime.capabilityGateway.ledger.current({principal_id:'owner',run_id:owner.run}),owner.run).map(row=>row.id));
  await f.runtime.deliverErrand({...result,job_id:checked.args.job_id,self_check_of:job+':0',
    capability_receipt:receipt('failed',{job:{id:checked.args.job_id,revision:2}})},()=>{});
  assert.equal(f.runs.size,2);
});

test('an after_check receipt requires a successful check of that same target before a retry',async t=>{
  const f=await fixture(t,['owner-mac']),bound=await f.owner();
  async function returned(name:string,args:object,result:ReturnType<typeof receipt>){
    const call=f.envelope(bound,'mcp__owner_mac__'+name,args),decision=await f.rpc('decide',call);
    assert.equal(decision.action,'modify');const {middleware_trace:_trace,...wire}=call;
    await f.rpc('receipt',{...wire,args:decision.args,result:to_mcp_result(result),duration_ms:1,status:'success',error_type:null,error_message:null});
  }
  const args={path:'/fixture/a',content:'data',owner_requested:true};
  await returned('write',args,receipt('unknown',{next:{retry:'after_check',check_with:'read'}}));
  const retry=()=>f.rpc('decide',f.envelope(bound,'mcp__owner_mac__write',args));
  assert.equal((await retry()).action,'block');
  await returned('read',{path:'/fixture/b'},succeeded());assert.equal((await retry()).action,'block');
  await returned('read',{path:'/fixture/a'},succeeded());assert.equal((await retry()).action,'modify');
});

test('HTTP spend uses the actual payment authority, requires a new signed decision for every cashier and never remembers consent',async t=>{
  const payments=await paymentFixture(t);payments.setNow(Date.now());await payments.unlock();
  const paymentAuthority=PaymentAuthority.open(payments.directory,{config:payments.config,now:()=>payments.now});
  const f=await fixture(t,['phone'],paymentAuthority),bound=await f.owner();
  async function requestPayment(id:string){
    return await f.runtime.tool('paios_payment',{context:{run_id:bound.run,session_id:bound.session,tool_call_id:id},
      args:{action:'request',purpose:'synthetic tea',app:'千问',budget_yuan:16.6}}) as {intent_id:string;status:string};
  }
  const first=await requestPayment('payment-one');assert.equal(first.status,'accepted');
  const wire=(intent?:string)=>f.envelope(bound,'mcp__phone__phone_task',{task_type:'pay_order',goal:'synthetic cashier',
    app:'千问',owner_requested:true,...(intent?{payment_intent:intent}:{})});
  assert.equal((await f.rpc('decide',wire())).action,'block');
  assert.equal((await f.rpc('decide',wire(first.intent_id))).action,'modify');
  const denied=await fetch(f.base+'/internal/hermes/gateway/decide',{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop'},body:JSON.stringify(wire('pi-foreign'))});
  assert.equal(denied.status,403);
  async function cashier(intent_id:string,job_id:string){
    const result=await payments.authority.checkpoint({intent_id,job_id,seq:1,app:'千问',checkout:'cashier',amount_fen:1660,
      payee:'synthetic shop',items:['tea'],screen_sha256:'a'.repeat(64),read_at:new Date(payments.now).toISOString()});
    return String(result.payment_id);
  }
  const id=await cashier(first.intent_id,'job-payment-one'),payment=payments.authority.store.getPayment(id)!;
  assert.equal(payment.state,'awaiting_owner');assert.equal(payments.authority.store.getGrant(id),undefined);
  await payments.authority.input(f.source,{operation:'payment_decide',control_id:'signed-one',payment_id:id,decision:'pay',
    ...signed(payments.dev,{purpose:'payment_decide',device_id:'phone',payment_id:id,decision:'pay',amount_fen:payment.amount_fen,
      payee_key:payment.payee_key,nonce:payment.decision_nonce})});
  const grant=payments.authority.store.getGrant(id)!;assert.ok(grant);
  await assert.rejects(payments.authority.tap(id,{grant_id:grant.grant_id,step:1,read_amount_fen:1661,
    screen_sha256:'b'.repeat(64)}),/PAYMENT_AMOUNT_MISMATCH/);
  await payments.complete(id);
  const closed=await fetch(f.base+'/internal/hermes/gateway/decide',{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:'Bearer synthetic-internal-token-abcdefghijklmnop'},body:JSON.stringify(wire(first.intent_id))});
  assert.equal(closed.status,403,'a completed payment intent cannot authorize another operation');
  const next=await requestPayment('payment-two'),second=await cashier(next.intent_id,'job-payment-two');
  assert.notEqual(next.intent_id,first.intent_id);assert.equal(payments.authority.store.getPayment(second)!.state,'awaiting_owner');
  assert.equal(payments.authority.store.getGrant(second),undefined);
  assert.equal((await f.runtime.voiceConfirmations(f.source)).length,0,'ordinary effect cards never stand in for payment');
  assert.deepEqual(await f.storage.list('effect-consents'),[]);
});
