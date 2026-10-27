import {readFileSync} from 'node:fs';
const nativeVersionFixtures=JSON.parse(readFileSync(new URL('./fixtures/native-final-response/native-run-version-fixtures.json',import.meta.url),'utf8'));
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256} from '../src/contracts.ts';
test('native CLI controlled text result/ACK and original App observation complete before normal SIGTERM lock cleanup',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'paios-close-cli-'));let completed=false,creates=0,modelInput='',grants:string[]=[];
  const native=createServer(async(request,response)=>{
    if(request.url==='/health/detailed'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({platform:'hermes-agent',readiness:{checks:{session_store:{status:'ok'},model:{status:'ok'}}}}));return;}
    if(request.method==='GET'&&/^\/v1\/runs\/[^/]+\/events$/u.test(request.url??'')){response.writeHead(200,{'Content-Type':'text/event-stream'});response.end();return;}
    if(request.method==='GET'&&request.url?.startsWith('/api/sessions')){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[]}));return;}
    if(request.method==='POST'&&request.url==='/v1/runs'){creates++;let body='';for await(const chunk of request)body+=chunk;const accepted=JSON.parse(body);modelInput=accepted.input;grants=accepted.grant_toolsets;}
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({...nativeVersionFixtures.cli[completed?'completed':'running'],granted_toolsets:grants}));
  });await new Promise<void>(resolve=>native.listen(0,'127.0.0.1',resolve));const na=native.address();assert.ok(na&&typeof na!=='string');
  const reserve=createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const address=reserve.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const token='synthetic-source-cli-device-token',internal='synthetic-source-cli-internal-key';await fs.writeFile(join(dir,'key'),internal,{mode:0o600});await fs.writeFile(join(dir,'skill'),'controlled skill');
  const config={mode:'isolated_fixture',port:address.port,storage_root:join(dir,'storage'),lock_file:join(dir,'owner.lock'),hermes_base_url:`http://127.0.0.1:${na.port}`,
    hermes_key_file:join(dir,'key'),internal_key_file:join(dir,'key'),skill_file:join(dir,'skill'),native_request_timeout_ms:5000,http_request_timeout_ms:5000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'cli-close'},
    devices:[{principal_id:'owner',device_id:'mac',device_type:'mac',channel:'fixture',consent_ref:'fixture',token_sha256:sha256(token),route_version:'route',output_modes:['text']}]};await fs.writeFile(join(dir,'config.json'),JSON.stringify(config));
  const child=spawn(process.execPath,['src/main.ts','--config',join(dir,'config.json')],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']});const exited=Promise.withResolvers<number|null>(),ready=Promise.withResolvers<void>();let output='';
  child.on('close',code=>exited.resolve(code));child.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('personal-aios-integration'))ready.resolve();});child.stderr!.on('data',chunk=>{output+=chunk;});
  t.after(async()=>{if(child.exitCode===null)child.kill('SIGKILL');await exited.promise;native.closeAllConnections();await new Promise<void>(resolve=>native.close(()=>resolve()));await fs.rm(dir,{recursive:true,force:true});});
  await Promise.race([ready.promise,exited.promise.then(()=>{throw new Error(output);})]);const base=`http://127.0.0.1:${address.port}`;
  async function call(path:string,body?:unknown,key=token){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};}
  const sent=await call('/v1/prompts',{session_id:'session',event_id:'text-normal',captured_at:'2026-10-03T00:00:00.000Z',text:'original controlled text'});assert.equal(sent.status,202);const d=sent.body.processed_event;
  let bound=false;for(let i=0;i<200;i++){const event=await call(`/v1/events/${d.processed_event_id}?session_id=session`);if(event.body.admission.run_id){bound=true;break;}await delay(10);}assert.equal(bound,true);assert.equal(creates,1);assert.equal(JSON.parse(modelInput).processed_event_id,d.processed_event_id);
  const context={schema:'hermes.run.v2',profile_home:join(dir,'native-profile'),run_id:'controlled-run',session_id:'session',tool_call_id:'controlled-open'};assert.equal((await call('/internal/hermes/tools/paios_open_reply',{context,args:{reply_mode:'text',target_aliases:['source'],output_modes:['text']}},internal)).status,200);completed=true;
  const path=`/v1/events/${d.processed_event_id}/result?session_id=session`;let result:any;
  for(let i=0;i<200;i++){const response=await call(path);if(response.body.result?.reply_text==='controlled final reply'){result=response.body;break;}await delay(10);}assert.ok(result,output);assert.equal(result.result.run_status,'completed');const chunk=result.chunks[0];assert.ok(chunk);
  const ack=await call(path.replace('/result?','/ack?'),{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered',observed_at:'2026-10-03T00:00:01.000Z'});assert.equal(ack.status,200);assert.equal((await call(path)).body.result.delivery_status,'rendered');
  const original='{\n "application": "fixture", "value": 2\n}\n';const app=await call('/v1/observations',{session_id:'session',event_id:'app-normal',captured_at:'2026-10-03T00:00:00.000Z',app_event_json:original});assert.equal(app.status,202);assert.equal(app.body.processed_event.processing.path_id,'direct_app');assert.equal(app.body.processed_event.user_identity,'unknown');
  assert.equal(child.exitCode,null);child.kill('SIGTERM');assert.equal(await exited.promise,0,output);await assert.rejects(fs.readFile(config.lock_file),{code:'ENOENT'});
});
