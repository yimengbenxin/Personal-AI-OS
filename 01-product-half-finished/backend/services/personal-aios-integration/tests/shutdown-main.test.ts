import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {sha256} from '../src/contracts.ts';

test('actual process shutdown aborts in-flight create; durable unknown acceptance blocks same session after restart',async t=>{
  const folder=await fs.mkdtemp(join(tmpdir(),'paios-shutdown-main-'));
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),disconnected=Promise.withResolvers<void>();let creates=0,statuses=0;
  const native=createServer(async(request,response)=>{
    if(request.url==='/health/detailed'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({platform:'hermes-agent',readiness:{checks:{session_store:{status:'ok'},model:{status:'ok'}}}}));return;}
    if(request.method==='GET'&&request.url?.startsWith('/api/sessions')){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[]}));return;}
    if(request.method==='POST'&&request.url==='/v1/runs') {
      creates++;response.once('close',()=>disconnected.resolve());for await(const _chunk of request){}entered.resolve();await release.promise;
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({run_id:'native-one',session_id:'session',conversation_session_id:'session',status:'running'}));
    } else {statuses++;response.writeHead(500);response.end();}
  });
  await new Promise<void>(resolve=>native.listen(0,'127.0.0.1',resolve));
  const address=native.address();assert.ok(address&&typeof address!=='string');
  const reserve=createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const productAddress=reserve.address();assert.ok(productAddress&&typeof productAddress!=='string');
  await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const token='synthetic-source-shutdown-fixture',key='synthetic-native-shutdown-fixture';
  await fs.writeFile(join(folder,'key'),key,{mode:0o600});await fs.writeFile(join(folder,'skill'),'fixed skill');
  const config={mode:'isolated_fixture',storage_root:join(folder,'storage'),lock_file:join(folder,'owner.lock'),port:productAddress.port,
    hermes_base_url:`http://127.0.0.1:${address.port}`,hermes_key_file:join(folder,'key'),internal_key_file:join(folder,'key'),skill_file:join(folder,'skill'),
    native_request_timeout_ms:10000,http_request_timeout_ms:10000,max_request_bytes:10000,max_event_bytes:10000,max_read_bytes:10000,
    admission:{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:10000,native_idempotency_retention_ms:86400000,policy_version:'shutdown'},
    devices:[{principal_id:'owner',device_id:'mac',device_type:'mac',channel:'fixture',consent_ref:'fixture',token_sha256:sha256(token),route_version:'1',output_modes:['text']}]};
  await fs.writeFile(join(folder,'config.json'),JSON.stringify(config));
  const processes: {child: ReturnType<typeof spawn>; exited: Promise<number|null>}[]=[];
  function start() {
    const child=spawn(process.execPath,['src/main.ts','--config',join(folder,'config.json')],
      {cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']});
    const exited=Promise.withResolvers<number|null>(),ready=Promise.withResolvers<void>();let output='';
    child.on('close',code=>exited.resolve(code));
    child.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('personal-aios-integration'))ready.resolve();});
    child.stderr!.on('data',chunk=>{output+=chunk;});
    processes.push({child,exited:exited.promise});
    return {child,exited:exited.promise,ready:Promise.race([ready.promise,exited.promise.then(()=>{throw new Error(output);})]),output:()=>output};
  }
  t.after(async()=>{release.resolve();for(const {child,exited} of processes) {
      if(child.exitCode===null)child.kill('SIGKILL');await exited;
    }
    native.closeAllConnections();await new Promise<void>(resolve=>native.close(()=>resolve()));
    await fs.rm(folder,{recursive:true,force:true});});
  const first=start();await first.ready;
  const url=`http://127.0.0.1:${productAddress.port}`;
  const response=await fetch(`${url}/v1/prompts`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({session_id:'session',event_id:'shutdown',captured_at:'2026-10-01T00:00:00.000Z',text:'fixture'})});
  assert.equal(response.status,202);const accepted=await response.json() as {processed_event:{processed_event_id:string};admission:{idempotency_key:string}};await entered.promise;
  const owner=JSON.parse(await fs.readFile(config.lock_file,'utf8'));
  assert.equal(owner.pid,first.child.pid);assert.equal(first.child.exitCode,null);
  first.child.kill('SIGTERM');
  // The native stub keeps its response pending; only real transport abort can close it.
  await disconnected.promise;assert.equal(await first.exited,0,first.output());
  await assert.rejects(fs.readFile(config.lock_file),{code:'ENOENT'});
  const attempts=await fs.readdir(join(config.storage_root,'run-attempts'));
  assert.equal(attempts.length,1);
  const attempt=JSON.parse(await fs.readFile(join(config.storage_root,'run-attempts',attempts[0]!), 'utf8'));
  assert.equal(attempt.idempotency_key,accepted.admission.idempotency_key);
  const bindings=await fs.readdir(join(config.storage_root,'run-bindings')).catch(error=>{
    assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');return [];});
  assert.deepEqual(bindings,[]);assert.equal(creates,1);assert.equal(statuses,0);
  const second=start();await second.ready;
  const dId=accepted.processed_event.processed_event_id;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const restored=await fetch(`${url}/v1/events/${dId}?session_id=session`,{headers});assert.equal(restored.status,200);
  const known=await restored.json() as {admission:{state:string;idempotency_key:string}};
  assert.equal(known.admission.state,'reconcile_required');assert.equal(known.admission.idempotency_key,attempt.idempotency_key);
  const next=await fetch(`${url}/v1/prompts`,{method:'POST',headers,
    body:JSON.stringify({session_id:'session',event_id:'shutdown-next',captured_at:'2026-10-01T00:00:00.000Z',text:'next fixture'})});
  assert.equal(next.status,202);const queued=await next.json() as {admission:{state:string};processed_event:{processed_event_id:string}};
  assert.equal(queued.admission.state,'pending');
  const inspect=await fetch(`${url}/v1/events/${queued.processed_event.processed_event_id}?session_id=session`,{headers});
  assert.equal(inspect.status,200);assert.equal((await inspect.json() as {admission:{state:string}}).admission.state,'pending');
  assert.equal(creates,1);assert.equal(statuses,0);assert.deepEqual(await fs.readdir(join(config.storage_root,'run-bindings')).catch(error=>{
    assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');return [];}),[]);
  const restartedOwner=JSON.parse(await fs.readFile(config.lock_file,'utf8'));assert.equal(restartedOwner.pid,second.child.pid);
  second.child.kill('SIGTERM');assert.equal(await second.exited,0,second.output());
  await assert.rejects(fs.readFile(config.lock_file),{code:'ENOENT'});assert.equal(creates,1);assert.equal(statuses,0);
  const evidence=process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
  if(evidence) {assert.ok(isAbsolute(evidence));await fs.mkdir(evidence,{recursive:true,mode:0o700});
    await fs.cp(folder,join(evidence,'shutdown-main-aborted-restart'),{recursive:true});}
});
for(const failure of ['readiness','setup','exited','evidence'] as const)
test(`dev voice runner reaps Hermes before reporting failure: ${failure}`,async t=>{
 const folder=await fs.mkdtemp(join(tmpdir(),'paios-dev-voice-')),pidFile=join(folder,'pid'),reaped=join(folder,'reaped'),loader=join(folder,'loader.cjs');
 let childPid:number|undefined;
 t.after(async()=>{await fs.chmod(folder,0o700);if(childPid!==undefined){try{process.kill(childPid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}await fs.rm(folder,{recursive:true,force:true});});
 await fs.writeFile(loader,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
 process.on('exit',()=>fs.writeFileSync(${JSON.stringify(reaped)},'joined'));process.on('SIGTERM',()=>process.exit(0));
 console.error('FIXTURE_HERMES_STARTED:'+process.pid);
 ${failure==='readiness'?'':"console.error('Hermes native API ready');"}
 ${failure==='exited'?'process.exit(7);':'setInterval(()=>{},1000);'}`);
 const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
 await fs.writeFile(join(folder,'audio.wav'),wav);await fs.writeFile(join(folder,'key'),'synthetic-dev-key');
 await fs.writeFile(join(folder,'local-e2e.json'),JSON.stringify({audio_file:join(folder,'audio.wav'),central:{hermes_key_file:join(folder,'key'),skill_file:join(folder,'missing-skill')},hermes:{python:process.execPath,root:folder,home:folder,port:1,provider_key_file:join(folder,'key'),provider_key_env:'FIXTURE_KEY',loader}}));
 const preload=failure==='readiness'?`
 const cp=(await import('node:child_process')).default,spawn=cp.spawn,timeout=globalThis.setTimeout;
 let expire;
 cp.spawn=(...args)=>{
  const child=spawn(...args);
  if(args[1]?.[0]===${JSON.stringify(loader)}){
   globalThis.setTimeout=(fn,ms,...args)=>{
    const timer=timeout(fn,ms,...args);
    if(ms===60000){expire=()=>{clearTimeout(timer);fn(...args);};globalThis.setTimeout=timeout;}
    return timer;
   };
   let output='';child.stderr.on('data',data=>{
   output+=data;if(output.includes('FIXTURE_HERMES_STARTED:')&&expire){const fire=expire;expire=undefined;queueMicrotask(fire);}
  });}
  return child;
 };
 (await import('node:module')).syncBuiltinESMExports();`:
 failure==='evidence'?"const fs=(await import('node:fs/promises')).default;fs.writeFile=async()=>{throw Error('EVIDENCE_DISK_FAILED');};(await import('node:module')).syncBuiltinESMExports();":'';
 const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'tools/local-voice-e2e.ts',folder,'--fake-asr','hello'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']});
 let output='',deadline:ReturnType<typeof setTimeout>|undefined;
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>{
  output+=data;const started=/FIXTURE_HERMES_STARTED:(\d+)/u.exec(output);
  if(started&&deadline===undefined){childPid=Number(started[1]);deadline=setTimeout(()=>child.kill('SIGTERM'),5000);}
 });
 const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{clearTimeout(deadline);resolve(code);});});
 t.after(async()=>{clearTimeout(deadline);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 const code=await exited;
 assert.equal(code,1,output);childPid=Number(await fs.readFile(pidFile,'utf8'));assert.equal(await fs.readFile(reaped,'utf8'),'joined');
 assert.throws(()=>process.kill(childPid!,0),{code:'ESRCH'});
 if(failure!=='evidence')assert.ok((await fs.readdir(folder)).some(name=>name.startsWith('evidence-')));
});
