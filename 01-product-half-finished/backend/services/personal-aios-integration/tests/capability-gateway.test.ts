import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {CapabilityGateway, structuredResult, aggregateReceipts, type GatewayCall, type GatewayConsent} from '../src/capability/gateway.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {receiptFacts, recordFacts, renderFacts, activitySentence} from '../src/capability/renderer.ts';
import {checkReport, factCarried} from '../src/capability/checker.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputAuthority} from '../src/output.ts';
import {inspectWav} from '../src/tts.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {RunAdmission, PersonalAIOSRuntime, nativeSubmission, type NativeRun, type NativeClient} from './native-source-fixture.ts';
import {sha256, digest} from '../src/contracts.ts';
import {receipt, succeeded, unknown, value, effect} from '../../../../../capability/sdk/ts/receipt.ts';
import {ActivityProjection} from '../src/activity.ts';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/u,'');
const internal='synthetic-capability-internal-token', token='synthetic-capability-device-token';
const binding={principal_id:'owner',run_id:'run:fixture',scope:'owner',invocation:'interactive' as const};
// Records what the gateway hands the platform consent authority; the authority itself is tested in capability-consent.
const consented:{effect:string;target:string;task_type?:string;owner_requested:unknown}[]=[];
const consent:GatewayConsent=async(_binding,gated,tool,effect,target)=>{
  consented.push({effect,target,task_type:tool.task_type,owner_requested:gated.args.owner_requested});
  return {action:'approve',message:`请确认：${target}`,rule_key:effect};
};
const step={device:'客厅灯',service:'light',property:'on',value:true};
const call=(tool='control_device'):GatewayCall=>({tool_name:`mcp__mijia__${tool}`,args:step,task_id:'child',session_id:'session',tool_call_id:'call',turn_id:'turn',api_request_id:'run:fixture',middleware_trace:[]});
async function storageFixture(t:test.TestContext) {
  const folder=await fs.mkdtemp(join(tmpdir(),'capability-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const storage=new PosixStorage(folder),gateway=new CapabilityGateway(storage,consent,packageCatalog({enabled:['mijia'],gateway:['mijia']}));
  return {folder,storage,gateway};
}
test('owner decision table: observe tools keep the scope check alone; physical and account tools go to consent by class',async t=>{
  const {gateway}=await storageFixture(t);
  // No ungated exception remains for Mi Home control, scenes or login.
  const gated:Record<string,[string,string,string]>={control_device:['physical','客厅灯','mijia:control'],
    run_scene:['physical','到家','mijia:scene'],prepare_login:['account','prepare_login','mijia:login']};
  const args:Record<string,Record<string,unknown>>={control_device:step,run_scene:{name:'到家',steps:[step]},prepare_login:{}};
  for(const scope of ['owner','guest','owner_uncertain','care','build','other'])for(const tool of gateway.tools.keys()) {
    const name=tool.split('__').at(-1)!;consented.length=0;
    const decision=await gateway.decide({...binding,scope},{...call(),tool_name:tool,args:{...args[name],owner_requested:false}});
    const expected=scope!=='owner'?'block':gated[name]?'approve':'allow';
    assert.equal(decision.action,expected,`${scope}:${tool}`);
    assert.deepEqual(consented,expected==='approve'?[{effect:gated[name]![0],target:gated[name]![1],task_type:gated[name]![2],owner_requested:false}]:[]);
  }
});
test('admission is idempotent, isolated by principal/run, and rejects a changed replay',async t=>{
  const {gateway}=await storageFixture(t),raw=succeeded();
  const first=await gateway.receipt(binding,{...call(),result:{structuredContent:raw}});
  assert.deepEqual(await gateway.receipt(binding,{...call(),result:{structuredContent:raw}}),first);
  assert.equal((await gateway.ledger.records(binding)).length,1);
  await assert.rejects(gateway.receipt(binding,{...call(),result:{structuredContent:unknown()}}),/REPLAY_CONFLICT/u);
  assert.equal((await gateway.ledger.records({...binding,principal_id:'other'})).length,0);
  assert.equal((await gateway.ledger.records({...binding,run_id:'other'})).length,0);
});
test('duplicate successful mutations are blocked; observations remain repeatable',async t=>{
  const {gateway}=await storageFixture(t);
  const raw=succeeded({effects:[effect('physical','客厅灯','light.on','service_ack','code=0')]});
  await gateway.receipt(binding,{...call(),result:{structuredContent:raw}});
  assert.equal((await gateway.decide(binding,call())).action,'block');
  assert.equal((await gateway.decide(binding,{...call(),args:{...step,value:false}})).action,'approve');
  assert.equal((await gateway.decide(binding,call('read_device'))).action,'allow');
});
test('novelty needs delivery, survives restart and is principal scoped',async t=>{
  const {gateway,storage}=await storageFixture(t);
  const facts=receiptFacts([succeeded({values:[value('温度',26.25,'°C','observed','fixture','2026-10-24T00:00:00Z')]})]);
  assert.deepEqual(await gateway.ledger.novel('owner',facts),facts);
  await gateway.ledger.delivered('owner',[facts[0]!.id],'ack:rendered');
  const resumed=new CapabilityGateway(storage,consent,new Map());
  assert.equal((await resumed.ledger.novel('owner',facts)).length,facts.length-1);
  assert.deepEqual(await resumed.ledger.novel('other',facts),facts);
});
test('a fresh identical invocation is new while a follow-up of the delivered call is old',async t=>{
  const {gateway}=await storageFixture(t),raw=succeeded({values:[value('温度',26,'°C','observed','fixture','2026-10-24T00:00:00Z')]});
  await gateway.receipt(binding,{...call('read_device'),result:{structuredContent:raw}});
  const first=recordFacts(await gateway.ledger.records(binding),binding.run_id);
  await gateway.ledger.delivered('owner',first.map(fact=>fact.id),'ack:rendered');
  assert.equal((await gateway.ledger.novel('owner',first)).length,0);
  await gateway.receipt(binding,{...call('read_device'),tool_call_id:'fresh-call',result:{structuredContent:raw}});
  const current=recordFacts(await gateway.ledger.records(binding),binding.run_id);
  assert.equal((await gateway.ledger.novel('owner',current)).length,first.length);
});
test('voice uses the checked projection and facts become told only after played ACK',async t=>{
  const {storage,gateway}=await storageFixture(t),run='run:voice';
  await gateway.receipt({...binding,run_id:run},{...call(),result:{structuredContent:unknown()}});
  const facts=recordFacts(await gateway.ledger.records({...binding,run_id:run}),run);
  const d=await new UnifiedIngress(new RawArchive(storage,4096)).accept({schema_version:'paios.event.v1',event_id:'voice-event',
    device_id:'mac',device_type:'mac',captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'text',
    mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('刚才是什么结果？')},
    {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'fixture',submission:'explicit_text'});
  const ctx={principal_id:'owner',run_id:run,session_id:'session',tool_call_id:'voice',d,
    target:{device_id:'mac',device_type:'mac' as const,route_version:'route',output_modes:['voice']}};
  let spoken='',finish!:()=>void;const ready=new Promise<void>(resolve=>finish=resolve);
  const out=new OutputAuthority(storage,{capability:gateway,tts:{synthesize:async text=>{
    spoken=text;const wav=Buffer.alloc(244);wav.write('RIFF');wav.writeUInt32LE(236,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
    wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);
    wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(200,40);return inspectWav(wav);
  }}});
  t.after(()=>out.close());out.setVoiceOwner(async()=>{if((await out.readFinalized(ctx)).result.voice_status!=='pending')finish();});
  await out.open(ctx,{reply_mode:'voice'});
  const sealed=await out.seal(ctx,{run_id:run,session_id:'session',conversation_session_id:'session',status:'completed',output:'失败了。你可以继续休息。'});
  if(sealed.voice_status==='pending')await ready;
  assert.equal(spoken,renderFacts(facts,'voice')+'你可以继续休息。');
  const chunks=(await out.readFinalized(ctx)).voice_chunks,first=chunks[0]!;
  const ack={output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:'mac',route_version:'route',
    highest_contiguous_seq:chunks.length,observed_at:new Date().toISOString()};
  await out.ack(ctx,{...ack,status:'accepted'});assert.deepEqual(await gateway.ledger.novel('owner',facts),facts);
  await out.ack(ctx,{...ack,status:'played'});assert.equal((await gateway.ledger.novel('owner',facts)).length,0);
});
test('numeric and status checker uses compatible units, receipt effects and owner input',()=>{
  const raw=succeeded({values:[value('温度',26.25,'°C','observed','fixture','2026-10-24T00:00:00Z')]});
  const facts=receiptFacts([raw]);
  assert.equal(checkReport('温度是26.25°C。', [raw],'',facts).removed.length,0);
  assert.equal(checkReport('温度是26.3°C。', [raw],'',facts).removed[0]!.reasons[0],'unsupported_number');
  assert.equal(checkReport('温度是26.25元。', [raw],'',facts).removed.length,1);
  assert.equal(checkReport('你设定的27°C。', [raw],'帮我设置27°C',facts).removed.length,0);
  assert.equal(checkReport('已记下。', [raw],'',facts).removed[0]!.reasons.includes('effect_unproven'),true);
  const pending=receipt('accepted');
  assert.equal(checkReport('办好了。你可以继续休息。',[pending],'',receiptFacts([pending])).text.includes('你可以继续休息。'),true);
  assert.equal(checkReport('失败了。',[unknown()],'',receiptFacts([unknown()])).text.includes('失败了'),false);
});
test('delivery matches equivalent measurements and whole status phrases',()=>{
  const facts=receiptFacts([succeeded({values:[value('温度',26,'°C','observed','fixture','2026-10-24T00:00:00Z')]})]);
  const measurement=facts.find(fact=>fact.value)!;
  for(const text of ['温度26°C。','温度是二十六度。','温度26.0摄氏度。'])assert.ok(factCarried(measurement,text,'text'));
  for(const text of ['温度126°C。','温度26元。'])assert.equal(factCarried(measurement,text,'text'),false);
  assert.equal(factCarried(facts[0]!,'温度只完成了一部分。','text'),false);
});
test('aggregation is fixed across every state class and mixtures',()=>{
  for(const [states,expected] of [
    [['succeeded'],'succeeded'],[['accepted'],'running'],[['running','failed'],'running'],
    [['waiting','failed'],'waiting'],[['unknown','succeeded'],'unknown'],[['partial'],'partial'],
    [['failed','succeeded'],'partial'],[['failed','rejected'],'failed'],[['cancelled'],'cancelled'],
  ] as const)assert.equal(aggregateReceipts(states.map(state=>({receipt:receipt(state)}))),expected);
});
test('activity takes admitted state and voice facts even when native completion says failed',()=>{
  const activity=new ActivityProjection('owner','session','processed',()=>{},()=>1000);
  activity.event({run_id:'run',event:'subagent.start',timestamp:1,subagent_id:'child',goal:'读取状态'});
  const raw=unknown();
  activity.receipts([{id:'id',task_id:'child',tool_call_id:'call',tool:'opaque',invocation:'x',fingerprint:'x',receipt:raw}]);
  activity.event({run_id:'run',event:'subagent.complete',timestamp:1,subagent_id:'child',status:'failed'});
  activity.settle('failed');
  assert.equal(activity.card!.state,'unknown');
  assert.equal(activity.card!.items[0]!.state,'unknown');
  assert.equal(activity.card!.summary,activitySentence([raw],'unknown'));
  activity.event({run_id:'run',event:'run.snapshot',timestamp:2,activity_events:[
    {run_id:'run',event:'subagent.start',timestamp:1,subagent_id:'child',goal:'读取状态'},
  ]});
  assert.equal(activity.card!.items[0]!.state,'unknown');
  assert.equal(activity.card!.counts.unknown,1);
  activity.close();
});
test('generic renderer/checker/gateway contain no manifest tool or package identities; plugin is <=200 lines',()=>{
  const manifest=JSON.parse(readFileSync(join(root,'capability/packages/mijia/plugin.json'),'utf8'));
  const names=[manifest.name,...Object.keys(manifest.extensions['ai.yimi.capability'].tools)];
  for(const file of ['renderer.ts','checker.ts','gateway.ts']) {
    const source=readFileSync(new URL(`../src/capability/${file}`,import.meta.url),'utf8');
    for(const name of names)assert.ok(!source.includes(name),`${name} in ${file}`);
  }
  assert.ok(readFileSync(join(root,'integrations/hermes/yimi_gateway/__init__.py'),'utf8').split('\n').length<=200);
});

// The fixture request is the owner's own ("帮我处理家里设备"), so controls carry owner_requested=true and pass consent.
const asked={...step,owner_requested:true};
const scenarios=[
  {name:'succeeded',tool:'control_device',args:asked,state:'succeeded',bad:'还在办。重新执行一次。'},
  {name:'accepted',tool:'control_device',args:asked,state:'accepted',bad:'办好了。'},
  {name:'unknown',tool:'control_device',args:asked,state:'unknown',bad:'失败了。'},
  {name:'login_required',tool:'get_login_status',args:{},state:'waiting',bad:'已完成。'},
  {name:'failed',tool:'control_device',args:asked,state:'failed',bad:'关好了。'},
  {name:'entrance_denied',outcome:'succeeded',tool:'control_device',args:{device:'入户门锁',service:'door-lock',action:'unlock',owner_requested:true},state:'failed',bad:'打开了。'},
  {name:'scene_incomplete',outcome:'incomplete',tool:'run_scene',args:{name:'到家',steps:[step,{...step,value:false}],owner_requested:true},state:'partial',bad:'已完成。'},
  {name:'read_values',outcome:'succeeded',tool:'read_device',args:{device:'空调'},state:'succeeded',bad:'温度是31°C。已记下。'},
  {name:'native_delegated',outcome:'succeeded',tool:'read_device',args:{device:'空调'},state:'succeeded',bad:'温度是31°C。已记下。',native:true},
];
for(const scenario of scenarios)test(`fake package → plugin → authenticated gateway → ledger → final checker: ${scenario.name}`,
  {timeout:'native' in scenario?240000:30000,skip:'native' in scenario&&process.env.PAIOS_CAPABILITY_REAL_MODEL!=='1'?'opt-in real model':false},async t=>{
  const {folder,storage}=await storageFixture(t);
  const runId=`run:${scenario.name}`,session='session';
  let run:NativeRun={run_id:runId,session_id:session,conversation_session_id:session,status:'running'};
  const native:NativeClient={create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:60000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  const out=new OutputAuthority(storage),runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,65536),admission,native,output:out,
    skill:'fixture',max_read_bytes:65536,devices:[{principal_id:'owner',device_id:'mac',device_type:'mac',channel:'http',
      consent_ref:'fixture',token_sha256:sha256(token),route_version:'route',output_modes:['text']}]});
  const server=createPersonalAIOSServer(runtime,{internal_token:internal,max_request_bytes:1048576,request_timeout_ms:10000});
  t.after(async()=>{await server.closeAndDrain();await runtime.close();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const source=await runtime.authenticate(token);
  const accepted=await runtime.submit({schema_version:'paios.event.v1',event_id:'event',device_id:'mac',device_type:'mac',captured_at:new Date().toISOString(),
    source:{channel:'http'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('帮我处理家里设备')},source,session,true);
  const processed=accepted.processed_event.processed_event_id;
  for(let index=0;index<100;index++) {if((await admission.getAsync('owner',session,processed))?.run_id)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.ok(admission.find(runId,session));
  const key=join(folder,'internal.key');await fs.writeFile(key,internal,{mode:0o600});
  if('native' in scenario)assert.ok(process.env.PAIOS_CAPABILITY_TEST_KEY_FILE,'Set PAIOS_CAPABILITY_TEST_KEY_FILE to the test-model key file');
  const request=join(folder,'probe.json');await fs.writeFile(request,JSON.stringify({root,home:folder,run:runId,session,input:nativeSubmission(native,runId).input,
    outcome:scenario.outcome??scenario.name,tool:scenario.tool,args:scenario.args,
    ...('native' in scenario?{model_key_file:process.env.PAIOS_CAPABILITY_TEST_KEY_FILE}:{}),
    config:{internal_base_url:base,internal_key_file:key,capability_tools:runtime.capabilityGateway.catalog().tools}}));
  const child=spawn(process.env.PAIOS_HERMES_PYTHON!,[join(root,'tests/hermes', 'native' in scenario?'capability_native_probe.py':'capability_probe.py'),request],
    {env:{...process.env,PYTHONPATH:process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  const result=await new Promise<{receipt:ReturnType<typeof receipt>;view:string}>((resolve,reject)=>{
    let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error(errors)));
  });
  assert.equal(result.receipt.status.state,scenario.state);
  if(!('native' in scenario))assert.equal((structuredResult(result.view) as {receipt:number}).receipt,1);
  if('native' in scenario && process.env.PAIOS_CAPABILITY_PROBE_EVIDENCE)await fs.writeFile(process.env.PAIOS_CAPABILITY_PROBE_EVIDENCE,JSON.stringify(result,null,2));
  const records=await runtime.capabilityGateway.ledger.records({principal_id:'owner',run_id:runId});
  if('native' in scenario)assert.ok(records.length>=2&&records.every(record=>record.task_id!=='session'));
  else {assert.equal(records.length,1);assert.equal(records[0]!.task_id,'fixture-grandchild:'+runId);}
  const finalText=scenario.bad+'你可以继续休息。';
  run={...run,status:'completed',output:finalText,native_final_response:{schema:'hermes.final-response.v1',run_id:runId,session_id:session,
    turn_id:'turn-final',message_id:1,sha256:sha256(finalText),phase:'final_buffer',after_tool_call_id:null,after_tool_name:null,
    last_tool_message_id:null,previous_message_id:null,previous_message_role:'user'}};
  const final=await runtime.result(source,session,processed);
  assert.equal(final.result.reply_text.includes(scenario.bad),false);
  assert.ok(final.result.reply_text.includes('你可以继续休息。'));
  assert.equal(final.result.native_final_response!.sha256,sha256(finalText));
  const replay=await runtime.result(source,session,processed,{text_replay:'sealed'});
  assert.equal(replay.result.reply_text,final.result.reply_text);
  const journal=await Promise.all((await storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await storage.read('output-journal',key)).toString())));
  assert.equal(journal.find(entry=>entry.operation==='seal').result.reply_text,finalText);
  assert.equal(journal.find(entry=>entry.operation==='seal').nativeBoundaryEvidence.sha256,sha256(finalText));
  assert.equal(journal.filter(entry=>entry.capabilityCheck).length,1);
  const facts=recordFacts(records,runId);
  assert.deepEqual(await runtime.capabilityGateway.ledger.novel('owner',facts),facts);
  const chunks=final.chunks,first=chunks[0]!;
  const ctx={principal_id:'owner',run_id:runId,session_id:session,tool_call_id:'final-buffer',d:accepted.processed_event,
    target:{device_id:'mac',device_type:'mac' as const,route_version:'route',output_modes:['text']}};
  await out.ack(ctx,{output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:'mac',route_version:'route',
    highest_contiguous_seq:chunks.length,status:'accepted',observed_at:new Date().toISOString()});
  assert.deepEqual(await runtime.capabilityGateway.ledger.novel('owner',facts),facts);
  await out.ack(ctx,{output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:'mac',route_version:'route',
    highest_contiguous_seq:chunks.length,status:'rendered',observed_at:new Date().toISOString()});
  assert.equal((await runtime.capabilityGateway.ledger.novel('owner',facts)).length,0);
  const followup=checkReport(renderFacts(facts,'text')+'\n我会继续留意。',records.map(record=>record.receipt),'',[],'text',facts);
  assert.equal(followup.text,'我会继续留意。');
  assert.equal((await fetch(base+'/internal/hermes/gateway/catalog')).status,401);
});
