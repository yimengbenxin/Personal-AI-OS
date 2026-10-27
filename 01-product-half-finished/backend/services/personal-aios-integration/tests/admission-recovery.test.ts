import {NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {sourceClient} from './native-source-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunAdmission,type AdmissionPolicy} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {EVENT_SCHEMA,type ProcessedEvent} from '../src/contracts.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {NativeNotAcceptedError,type NativeClient,type NativeRun} from './native-source-fixture.ts';
const policy:AdmissionPolicy={max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:2000,
 poll_interval_ms:5,native_idempotency_retention_ms:2000,policy_version:'controlled-recovery',
 native_retry:{max_attempts:4,initial_backoff_ms:10,max_backoff_ms:20}};
async function until(fn:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('recovery did not settle');}
function logicalBackoff(t:test.TestContext){
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 return (a:RunAdmission)=>{(a as unknown as {pause(ms:number|Promise<void>):Promise<void>}).pause=async ms=>{
  if(typeof ms==='number')now+=ms;else await ms;
 };};
}
async function fixture(t:test.TestContext,configured=true){
 const path=await fs.mkdtemp(join(tmpdir(),'admission-recovery-'));const storage=new PosixStorage(path);
 const runs=new Map<string,NativeRun>();const calls:{key:string;body:string}[]=[];let loss=true,disconnected=false,refusals=0,statusFailures=0;
 const native:NativeClient={create:async(body,key)=>{calls.push({key,body:JSON.stringify(body)});if(disconnected)throw Error('OFFLINE');
  if(refusals-->0)throw new NativeNotAcceptedError(refusals%2?'gateway_draining':'rate_limit_exceeded',10);
  const old=runs.get(key);if(old)return {...old,replayed:true};const run={granted_toolsets:body.grant_toolsets??[],run_id:`r${runs.size+1}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
  runs.set(key,run);if(loss){loss=false;throw Error('CREATE_RESPONSE_LOST');}return {...run};},
 status:async(id)=>{if(statusFailures-->0)throw Error('STATUS_RESPONSE_LOST');const run=[...runs.values()].find(r=>r.run_id===id);assert.ok(run);return {...run};},cancel:async()=>{throw Error('not invoked');}};
 const cleanup:Array<()=>Promise<void>>=[];const instances:RunAdmission[]=[];const settings={...policy};if(!configured)delete settings.native_retry;
 const admission=(override:Partial<AdmissionPolicy>={})=>{const a=new RunAdmission(storage,native,{...settings,...override});instances.push(a);return a;};
 t.after(async()=>{for(const close of cleanup)await close();await Promise.all(instances.map(a=>a.close()));await fs.rm(path,{recursive:true,force:true});});
 const ingress=new UnifiedIngress(new RawArchive(storage,10000));
 const d=async(event_id:string)=>ingress.accept({schema_version:EVENT_SCHEMA,event_id,device_id:'mac',device_type:'mac',captured_at:'2026-10-04T00:00:00.000Z',source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(event_id)},
 {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'consent',channel:'text',submission:'explicit_text'});
 return {cleanup,path,storage,native,settings,admission,d,runs,calls,set:(v:{loss?:boolean;disconnected?:boolean;refusals?:number;statusFailures?:number})=>{if(v.loss!==undefined)loss=v.loss;if(v.disconnected!==undefined)disconnected=v.disconnected;if(v.refusals!==undefined)refusals=v.refusals;if(v.statusFailures!==undefined)statusFailures=v.statusFailures;}};
}
test('lost create and status responses recover automatically; next D waits for actual terminal',async t=>{
 const control=logicalBackoff(t),f=await fixture(t);f.set({statusFailures:2});const a=f.admission(),first=await f.d('first'),next=await f.d('next');control(a);
 await a.admit(first,'session','skill');await a.admit(next,'session','skill');
 await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');assert.equal(f.runs.size,1);
 assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls[0],f.calls[1]);await a.admit(first,'session','skill');assert.equal(f.runs.size,1);
 [...f.runs.values()][0]!.status='completed';await until(()=>f.runs.size===2);assert.equal(f.calls.length,3);
});
test('native lane waits for the durable output decision before starting the next D',async t=>{
 const f=await fixture(t);f.set({loss:false});const a=f.admission(),first=await f.d('output-owner'),next=await f.d('output-next');
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();f.cleanup.push(async()=>release.resolve());
 a.setTerminalOwner(async()=>{entered.resolve();await release.promise;});await a.admit(first,'session','skill');await a.admit(next,'session','skill');
 await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');[...f.runs.values()][0]!.status='completed';await entered.promise;
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.runs.size,1);release.resolve();await until(()=>f.runs.size===2);assert.equal(f.calls.length,2);
});
test('configured cold owner recovery needs no new D and preserves original key after disconnect',async t=>{
 const f=await fixture(t,false),first=await f.d('cold');let a=f.admission();await a.admit(first,'session','skill');
 await until(()=>a.get('owner','session',first.processed_event_id)?.state==='reconcile_required');await a.close();
 a=f.admission({native_retry:policy.native_retry!});await a.recover();
 await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');assert.equal(f.runs.size,1);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('unconfigured unknown is explicitly recoverable by same D without new key',async t=>{
 const f=await fixture(t,false),first=await f.d('duplicate');const a=f.admission();
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const read=f.storage.read.bind(f.storage);let held=false;
 f.storage.read=async(...args)=>{if(args[0]==='run-attempts'&&!held&&a.get('owner','session',first.processed_event_id)?.state==='reconcile_required'){held=true;entered.resolve();await release.promise;}return read(...args);};
 f.cleanup.push(async()=>release.resolve());await a.admit(first,'session','skill');await entered.promise;
 assert.equal(a.get('owner','session',first.processed_event_id)?.state,'reconcile_required');await a.admit(first,'session','skill');release.resolve();
 await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');assert.equal(f.runs.size,1);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('explicit 429/503 recover under original bounded policy, no business duplication',async t=>{
 const control=logicalBackoff(t),f=await fixture(t);f.set({loss:false,refusals:2});const a=f.admission(),first=await f.d('refusals');control(a);
 const running=Promise.withResolvers<void>();a.setStateOwner(async entry=>{if(entry.record.state==='running')running.resolve();});
 await a.admit(first,'session','skill');await running.promise;assert.equal(f.calls.length,3);assert.equal(f.runs.size,1);
 assert.deepEqual(f.calls[0],f.calls[1]);assert.deepEqual(f.calls[1],f.calls[2]);
});
test('persistent uncertainty respects configured attempts and never releases next D',async t=>{
 const control=logicalBackoff(t),f=await fixture(t);f.set({disconnected:true});const a=f.admission(),first=await f.d('offline'),next=await f.d('waiting');control(a);
 const exhausted=Promise.withResolvers<void>(),running=Promise.withResolvers<void>();a.setStateOwner(async entry=>{
  if(entry.d.processed_event_id!==first.processed_event_id)return;
  if(entry.record.state==='reconcile_required'&&entry.record.attempt_count===4)exhausted.resolve();
  if(entry.record.state==='running')running.resolve();
 });
 await a.admit(first,'session','skill');await a.admit(next,'session','skill');await exhausted.promise;
 assert.equal(f.calls.length,4);assert.equal(a.get('owner','session',first.processed_event_id)?.state,'reconcile_required');assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');assert.equal(f.runs.size,0);
 f.set({disconnected:false,loss:false});await a.reconcile('owner','session',first.processed_event_id);
 await running.promise;assert.equal(f.runs.size,1);
});

test('configured shared assembly listening lifecycle restores a run without new ingress',async t=>{
 const f=await fixture(t,false),first=await f.d('assembly');const old=f.admission();await old.admit(first,'session','skill');
 await until(()=>old.get('owner','session',first.processed_event_id)?.state==='reconcile_required');await old.close();
 const assembly=createPersonalAIOSAssembly({storage:f.storage,native:sourceClient(f.native),admission:{...f.settings,native_retry:policy.native_retry!},skill:'skill',max_event_bytes:10000,max_read_bytes:10000,
  devices:[],http:{internal_token:'x'.repeat(32),max_request_bytes:10000,request_timeout_ms:1000}});
 f.cleanup.push(()=>assembly.close());assert.equal(f.calls.length,1,'construction stays passive');
 await new Promise<void>(resolve=>assembly.server.listen(0,'127.0.0.1',resolve));await until(()=>f.calls.length===2);assert.equal(f.runs.size,1);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('real fresh Node process recovers Posix journal via original HermesClient without duplicate action',async t=>{
 const f=await fixture(t,false),first=await f.d('process');const old=f.admission();await old.admit(first,'session','skill');
 await until(()=>old.get('owner','session',first.processed_event_id)?.state==='reconcile_required');await old.close();
 let posts=0;let seenKey='';let seenBody='';const run=[...f.runs.values()][0]!;
 const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
  if(req.method==='POST'){posts++;seenKey=String(req.headers['idempotency-key']);seenBody=Buffer.concat(chunks).toString();}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...run,schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/isolated/native-fixture',status:'completed',replayed:true}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const source=new URL('../src/',import.meta.url).href;
 const code=`const {RunAdmission}=await import(${JSON.stringify(source+'admission.ts')});const {PosixStorage}=await import(${JSON.stringify(source+'storage.ts')});const {HermesClient}=await import(${JSON.stringify(source+'hermes-client.ts')});
 const a=new RunAdmission(new PosixStorage(${JSON.stringify(f.path)}),new HermesClient(${JSON.stringify('http://127.0.0.1:'+address.port)},'fixture-token-abcdefghijklmnop',1000,8192),${JSON.stringify({...f.settings,native_retry:policy.native_retry})});
 await a.recover();let record;for(let i=0;i<100;i++){record=await a.readOnly('owner','session',${JSON.stringify(first.processed_event_id)});if(record?.state==='completed')break;await new Promise(r=>setTimeout(r,5));}await a.close();console.log(JSON.stringify({pid:process.pid,record}));if(record?.state!=='completed')process.exitCode=1;`;
 const result=await new Promise<{code:number|null;out:string;err:string}>(resolve=>{const child=spawn(process.execPath,['--input-type=module','-e',code]);let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('close',code=>resolve({code,out,err}));});
 assert.equal(result.code,0,result.err);assert.notEqual(JSON.parse(result.out).pid,process.pid);assert.equal(posts,1);assert.equal(f.runs.size,1);
 assert.equal(seenKey,f.calls[0]!.key);assert.deepEqual(JSON.parse(seenBody),JSON.parse(f.calls[0]!.body));
});

for(const mode of ['read-failure','close-during-success','close-during-failure'] as const)
test(`shared recovery shutdown joins both owners once: ${mode}`,async t=>{
 const f=await fixture(t,false);const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const list=f.storage.list.bind(f.storage);f.storage.list=async(...args)=>{entered.resolve();await release.promise;if(mode!=='close-during-success')throw Error('CONTROLLED_RECOVERY_READ_FAILURE');return list(...args);};
 const a=createPersonalAIOSAssembly({storage:f.storage,native:sourceClient(f.native),admission:f.settings,skill:'skill',max_event_bytes:10000,max_read_bytes:10000,
  devices:[],http:{internal_token:'x'.repeat(32),max_request_bytes:10000,request_timeout_ms:1000}});
 let joins=0,httpJoins=0;const original=a.runtime.close.bind(a.runtime),http=a.server.closeAndDrain.bind(a.server);
 const ownerEntered=Promise.withResolvers<void>(),ownerRelease=Promise.withResolvers<void>();
 f.cleanup.push(async()=>{release.resolve();ownerRelease.resolve();await a.close();});
 a.runtime.close=async()=>{joins++;ownerEntered.resolve();await ownerRelease.promise;await original();};
 a.server.closeAndDrain=async()=>{httpJoins++;await http();};
 const unhandled:unknown[]=[];const observe=(error:unknown)=>unhandled.push(error);process.on('unhandledRejection',observe);
 t.after(()=>process.removeListener('unhandledRejection',observe));
 await new Promise<void>(resolve=>a.server.listen(0,'127.0.0.1',resolve));await entered.promise;
 let stopping:Promise<void>|undefined;
 if(mode!=='read-failure'){stopping=a.close();assert.equal(a.close(),stopping);await ownerEntered.promise;}
 release.resolve();
 if(mode==='read-failure'){
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(a.server.listening,true,'recovery failure is not shutdown');
  stopping=a.close();
 }
 await ownerEntered.promise;
 stopping??=a.close();assert.equal(a.close(),stopping);let settled=false;void stopping.then(()=>settled=true,()=>settled=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'pending runtime owner must be joined');
 ownerRelease.resolve();await stopping;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(joins,1);assert.equal(httpJoins,1);assert.equal(a.server.listening,false);assert.equal(a.close(),stopping);assert.deepEqual(unhandled,[]);assert.equal(f.calls.length,0);
});

test('unconfigured unknown startup never POSTs; original explicit reconciliation preserves same key and barrier',async t=>{
 const f=await fixture(t,false),first=await f.d('no-policy-start'),next=await f.d('no-policy-next');const old=f.admission();
 await old.admit(first,'session','skill');await until(()=>old.get('owner','session',first.processed_event_id)?.state==='reconcile_required');await old.close();
 const a=f.admission();await a.recover();await a.admit(next,'session','skill');await new Promise(r=>setTimeout(r,300));
 assert.equal(f.calls.length,1,'startup recovery cannot invent a retry policy');assert.equal(f.runs.size,1);
 assert.equal(a.get('owner','session',first.processed_event_id)?.state,'reconcile_required');assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
 await a.reconcile('owner','session',first.processed_event_id);await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.runs.size,1);assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
});
test('configured unknown startup cannot exceed durable retry budget; explicit same-D remains recoverable',async t=>{
 // This test isolates the durable attempt cap; filesystem contention must not turn it into a two-second expiry test.
 const bounds={max_event_age_ms:60000,native_idempotency_retention_ms:60000};
 const f=await fixture(t);f.set({disconnected:true});const first=await f.d('exhausted-start'),next=await f.d('exhausted-next');const old=f.admission(bounds);
 await old.admit(first,'session','skill');await until(()=>f.calls.length===policy.native_retry!.max_attempts);await old.close();
 const a=f.admission(bounds);await a.recover();await a.admit(next,'session','skill');await new Promise(r=>setTimeout(r,300));
 assert.equal(f.calls.length,policy.native_retry!.max_attempts,'restart cannot reset durable automatic budget');assert.equal(f.runs.size,0);
 assert.equal(a.get('owner','session',first.processed_event_id)?.state,'reconcile_required');assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
 f.set({disconnected:false,loss:false});await a.admit(first,'session','skill');await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');
 assert.equal(f.calls.length,policy.native_retry!.max_attempts+1,'new explicit owner request is serialized');assert.equal(f.runs.size,1);
 assert.deepEqual(f.calls[0],f.calls.at(-1));assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
});

test('acceptance-unknown recovery freezes the original confirmation fact under the same native idempotency key',async t=>{
 const control=logicalBackoff(t),f=await fixture(t,false),base=await f.d('frozen-voice-confirmation');
 const first:ProcessedEvent={...base,origin:'device_observation',user_identity:'unknown',media_type:'app_event',mime:'application/json',
  content:{app_event:{kind:'voice_turn',speaker:'owner_uncertain',user:'帮我查询日程'}},processing:{...base.processing,path_id:'direct_app'}};
 const fact={confirmation_id:'a'.repeat(64),expires_at_ms:Date.now()+60000};
 const old=f.admission();control(old);old.setVoiceConfirmation(()=>fact);
 const admitted=await old.admit(first,'session','skill');
 await until(()=>old.get('owner','session',first.processed_event_id)?.state==='reconcile_required');await old.close();
 assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(JSON.parse(f.calls[0]!.body).input).voice_confirmation,fact);
 let liveReads=0;const restarted=f.admission({native_retry:policy.native_retry!});
 control(restarted);const running=Promise.withResolvers<void>();restarted.setStateOwner(async entry=>{if(entry.record.state==='running')running.resolve();});
 restarted.setVoiceConfirmation(()=>{liveReads++;return null;});
 await restarted.recover();await running.promise;
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0],'the same key must carry byte-identical native input after the card disappears');
 assert.equal(f.runs.size,1);assert.equal(restarted.get('owner','session',first.processed_event_id)?.idempotency_key,admitted.idempotency_key);
 assert.equal(liveReads,0,'recovery reads its durable native input instead of the current pending card');
 const saved=JSON.parse(Buffer.from(await f.storage.read('admission-inputs',admitted.idempotency_key.slice('paios:'.length))).toString());
 assert.deepEqual(saved.voice_confirmation,fact);
});

test('recovery close after native stop never attaches another event stream',async t=>{
 const f=await fixture(t);f.set({loss:false});
 const bounds={max_event_age_ms:60000,native_idempotency_retention_ms:60000};
 const observed=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const reopened=Promise.withResolvers<string>();let closing:Promise<void>|undefined;
 const status=f.native.status.bind(f.native);
 f.native.status=async runId=>{if(closing)reopened.resolve('reopened');const run=await status(runId);observed.resolve();return run;};
 f.native.cancel=async()=>{entered.resolve();await release.promise;return {...[...f.runs.values()][0]!};};
 f.cleanup.push(async()=>{release.resolve();for(const run of f.runs.values())run.status='cancelled';if(closing)await closing;});
 const first=await f.d('close-after-recovered-stop'),old=f.admission(bounds);
 const admitted=await old.admit(first,'session','skill');await observed.promise;await old.close();
 await f.storage.publish('run-cancel-intents',admitted.idempotency_key.slice('paios:'.length),Buffer.from(JSON.stringify({at_ms:Date.now()})));
 const restarted=f.admission(bounds);await restarted.recover();await entered.promise;
 closing=restarted.close();release.resolve();
 assert.equal(await Promise.race([closing.then(()=>'closed'),reopened.promise]),'closed');
 await closing;
});
