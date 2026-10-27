import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createSelfSurface} from '../src/self-mcp.ts';
import {errandOutcomes} from '../src/self-errands.ts';
import {createPersonalAIOSServer} from '../../../services/personal-aios-integration/src/server.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {ContractError,sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import {createPersonalAIOSAssembly} from '../../../services/personal-aios-integration/src/assembly.ts';
import {sourceClient,type NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {fileURLToPath} from 'node:url';
import {PersonalityZone} from '../../../services/personal-aios-integration/src/personality/zone.ts';

const token='self-mcp-synthetic-internal-token',binding={run_id:'owner-run',session_id:'session',tool_call_id:'call'};
test('self MCP authenticates each call, validates windows, and keeps status and originals private',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-mcp-')),errors:unknown[]=[];
  await mkdir(join(directory,'spool'));
  const self=await createSelfSurface({storage:new PosixStorage(directory),errand_spool:join(directory,'spool'),policy_version:'fixture',onError:e=>errors.push(e)});
  const zone=new PersonalityZone(new PosixStorage(directory));
  await zone.call('owner',{action:'apply',expected_version:0,content:'表达：先说结论'},'change');
  const runtime={scheduleContext:async(context:typeof binding)=>{
    if(context.run_id!=='owner-run')throw new ContractError('SCHEDULE_OWNER_REQUIRED',403);
    return {principal_id:'owner',allow_owner_mutation:true};}};
  const server=createPersonalAIOSServer(runtime as never,{internal_token:token,max_request_bytes:16384,request_timeout_ms:5000,self});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=new URL(`http://127.0.0.1:${address.port}/internal/self/mcp`),client=new Client({name:'self-fixture',version:'1'});
  t.after(async()=>{await client.close();await server.closeAndDrain();await rm(directory,{recursive:true,force:true});});
  self.store.write({voice_call_stage:'turn_speaker',channel:'phone',verdict:'owner',score:.91,at:Date.now(),transcript:'never return me'});
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}) as Parameters<Client['connect']>[0]);
  const listed=(await client.listTools()).tools;assert.deepEqual(listed.map(t=>t.name),['runtime_query','runtime_status']);
  // A failed errand report's log row carries channel=unknown; the contract must not let it read as a routing failure.
  const channel=(listed[0]!.inputSchema.properties as Record<string,{description:string}>).channel!.description;
  assert.match(channel,/unknown means the event recorded no input-device metadata/);assert.match(channel,/never names an output, recipient or delivery route/);
  const result=await client.callTool({name:'runtime_query',arguments:{_context:binding}});
  assert.equal(result.isError,undefined);assert.equal((result.structuredContent as any).speakers.phone.scores.mean,.91);
  assert.ok(!JSON.stringify(result).includes('never return me'));
  const events=await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'events',limit:1}});
  assert.equal(events.isError,undefined);assert.equal((events.structuredContent as any).records.length,1);
  assert.ok(!JSON.stringify(events).includes('never return me'));
  const logAt=Date.now();self.store.write({central_text_failed:'PHONE_TIMEOUT',at:logAt,log_schema:'paios.runtime.log.v1',service:'gateway',logger:'paios.runtime',level:'ERROR',message:'waiting for model token=synthetic-secret'});
  const filtered=await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'gateway_logs',service:'gateway',level:'WARNING',text:'waiting',since:logAt,until:logAt,limit:1}});
  assert.equal((filtered.structuredContent as any).records[0].message,'waiting for model token=[redacted]');
  const excluded=await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'gateway_logs',service:'hermes'}});
  assert.equal((excluded.structuredContent as any).records.length,0);

  for(const args of [{source:'host_files'},{source:'events',limit:101},{source:'hermes_agent'}])
    assert.equal((await client.callTool({name:'runtime_query',arguments:{_context:binding,...args}})).isError,true);
  const logs=await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'hermes_agent',_local:{source:'hermes_agent',lines:['safe fixture']}}});
  assert.equal(logs.isError,undefined);assert.deepEqual((logs.structuredContent as any).hermes.lines,['safe fixture']);
  assert.equal((await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'hermes_agent',_local:{lines:['safe'.repeat(5000)]}}})).isError,undefined);

  for(const run_id of ['guest-run','stranger-run']){
    const denied=await client.callTool({name:'runtime_query',arguments:{_context:{...binding,run_id}}});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/SCHEDULE_OWNER_REQUIRED/);}
  assert.equal((await client.callTool({name:'runtime_query',arguments:{}})).isError,true);
  assert.equal((await client.callTool({name:'runtime_query',arguments:{_context:binding,since:100,until:1}})).isError,true);
  assert.equal((await client.callTool({name:'runtime_status',arguments:{_context:binding,_l4:{sessions:3,complete:false},_identity:{hermes_version:'fixture',provider:null,model:null}}})).isError,undefined);
  const status=(await client.callTool({name:'runtime_status',arguments:{_context:binding,_l4:{sessions:3,complete:false},_identity:{hermes_version:'fixture',provider:null,model:null}}})).structuredContent as any;
  assert.equal(status.personality_zone.read_only,true);assert.equal(status.personality_zone.content,'表达：先说结论');
  const page=(await client.callTool({name:'runtime_query',arguments:{_context:binding,source:'personality',offset:1,limit:1}})).structuredContent as any;
  assert.deepEqual(page.history.map((row:any)=>row.version),[0]);assert.equal(page.read_only,true);
  const denied=await client.callTool({name:'runtime_query',arguments:{_context:{...binding,run_id:'guest'},source:'personality'}});
  assert.equal(denied.isError,true);assert.doesNotMatch(JSON.stringify(denied),/先说结论/);
  assert.equal((await zone.read('owner')).current,1);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer guest'}})).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).status,405);
  const unowned=join(directory,'spool','job-111111111111.delivered.json');
  await writeFile(unowned,JSON.stringify({job_id:'job-111111111111',task:'history',success:true,answer:'old',finished_at:new Date(0).toISOString()}));
  const invalid=await client.callTool({name:'runtime_query',arguments:{_context:binding,since:100,until:200}});
  assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/INVALID_ID/);
  assert.equal(invalid.structuredContent,undefined);assert.ok(!JSON.stringify(invalid).includes('"success":0'));
  assert.deepEqual(errors,[]);
});

test('errand counts use retained terminal facts, deduplicate jobs and filter principal and time',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-errands-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const result={job_id:'job-111111111111',principal_id:'owner',task:'private task',answer:'private answer',success:true,finished_at:new Date(1000).toISOString()};
  for(const state of ['done','delivered'])await writeFile(join(directory,`${result.job_id}.${state}.json`),JSON.stringify(result));
  await writeFile(join(directory,'job-222222222222.done.json'),JSON.stringify({...result,job_id:'job-222222222222',principal_id:'other'}));
  await writeFile(join(directory,'job-333333333333.done.json'),JSON.stringify({...result,job_id:'job-333333333333',success:false,task:'私'.repeat(4000),answer:'密'.repeat(8000)}));
  for(const state of ['delivery-failed','invalid'])await writeFile(join(directory,`job-444444444444.${state}.json`),JSON.stringify({...result,job_id:'job-444444444444',delivery_failure:{error_code:'FORMAL_TEXT_OUTPUT_INVALID',failed_at:result.finished_at}}));
  await writeFile(join(directory,'job-555555555555.invalid.json'),'{');
  const summary=await errandOutcomes(directory,'owner',0,2000);assert.equal(summary.success,2);assert.equal(summary.failed,1);assert.equal(summary.complete,false);assert.equal(summary.unknown,1);assert.equal(summary.status,'incomplete');
  assert.ok(!JSON.stringify(summary).includes('private'));assert.equal((await errandOutcomes(directory,'owner',2000,3000)).success,0);
  assert.equal((await errandOutcomes(directory,'owner',0,2000,()=>true)).status,'deferred_live_call');
});

test('self outcomes expose quarantined unknowns and reject malformed retained outcomes instead of returning zero',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-unknown-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const raw={job_id:'job-111111111111',task:'history',answer:'old',success:true,finished_at:new Date(1000).toISOString()};
  await writeFile(join(directory,`${raw.job_id}.invalid.json`),JSON.stringify(raw));
  const summary=await errandOutcomes(directory,'owner',2000,3000);
  assert.equal(summary.unknown,1);assert.equal(summary.complete,false);assert.equal(summary.status,'incomplete');
  await writeFile(join(directory,`${raw.job_id}.delivered.json`),JSON.stringify(raw));
  await assert.rejects(errandOutcomes(directory,'owner',2000,3000),/INVALID_ID/);
});

test('a question traverses Hermes native tools, owner Admission, self MCP and persisted events',{timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-hermes-')),storage=new PosixStorage(join(directory,'data'));
  const accepted=Promise.withResolvers<void>(),runs=new Map<string,NativeRun>();
  const native=sourceClient({create:async body=>{const run={run_id:'run:self-owner',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);accepted.resolve();return run;},
    status:async(id:string)=>runs.get(id)!,cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})});
  const self=await createSelfSurface({storage,policy_version:'self-integration',onError:e=>{throw e;}});
  const assembly=createPersonalAIOSAssembly({storage,native,skill:'Synthetic self-data question',max_event_bytes:16384,max_read_bytes:16384,
    devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'http',consent_ref:'consent',token_sha256:sha256(token),route_version:'1',output_modes:['text']}],
    admission:{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:60000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'self-integration'},
    http:{internal_token:token,max_request_bytes:16384,request_timeout_ms:15000,self}});
  await new Promise<void>(r=>assembly.server.listen(0,'127.0.0.1',r));const address=assembly.server.address();assert.ok(address&&typeof address!=='string');
  t.after(async()=>{await assembly.close();await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${address.port}`;
  const response=await fetch(`${base}/v1/prompts`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({session_id:'self-question',event_id:'self-question',captured_at:new Date().toISOString(),text:'你最近认出我的声音准不准'})});
  assert.equal(response.status,202);await accepted.promise;
  const at=Date.now();self.store.write({voice_call_stage:'session_open',channel:'phone',at});self.store.write({voice_call_stage:'turn_commit',at});
  for(const score of [.9,.8])self.store.write({voice_call_stage:'turn_speaker',channel:'phone',verdict:'owner',score,at});
  self.store.write({voice_call_stage:'turn_speaker',channel:'phone',verdict:'uncertain',score:.4,at});await self.store.flush();
  const root=fileURLToPath(new URL('../../../../..',import.meta.url)),source=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT??'/opt/hermes-agent';
  const home=join(directory,'hermes');await mkdir(home);
  const probe=await promisify(execFile)(process.env.PAIOS_HERMES_PYTHON??join(source,'.venv/bin/python'),
    [join(root,'tests/hermes/self_mcp_probe.py'),`${base}/internal/self/mcp`,base,'run:self-owner','self-question'],
    {env:{...process.env,HERMES_HOME:home,HERMES_SOURCE:source,PYTHONPATH:source,PYTHONDONTWRITEBYTECODE:'1',PAIOS_SELF_PROBE_TOKEN:token},timeout:45000,maxBuffer:1024*1024});
  const proof=JSON.parse(probe.stdout.trim().split('\n').at(-1)!);assert.ok(proof.api_toolset_includes_self);
  assert.equal(proof.query.calls,1);assert.equal(proof.query.speakers.phone.verdicts.owner,2);assert.equal(proof.query.speakers.phone.verdicts.uncertain,1);
  assert.match(proof.answer,/相似|similarity/);assert.match(proof.answer,/准确|accuracy/);assert.equal(proof.status.l4.complete,false);
});
