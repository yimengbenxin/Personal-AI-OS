import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputTargetAuthority} from '../src/routing.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {StaticFixtureDeviceAuthority,PHONE_CAPABILITIES} from '../src/source-authority.ts';
import {VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import {canonical,digest,sha256} from '../src/contracts.ts';
import type {Admission} from '../src/admission.ts';
import type {FrozenCall} from '../src/capability/consent/call.ts';
import {succeeded,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';

const realTimeout=globalThis.setTimeout;
const sleep=(ms:number)=>new Promise<void>(resolve=>realTimeout(resolve,ms));
async function until(read:()=>boolean|Promise<boolean>,timeout=10000){
  const end=Date.now()+timeout;
  while(!await read()){assert.ok(Date.now()<end,'recovery did not settle');await sleep(10);}
}
test('release order: central is healthy before Hermes, then pending admission and consent recover once across restart',
 {timeout:90000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'startup-recovery-')),storage=new PosixStorage(root);
  const save=(ns:string,key:string,value:unknown)=>storage.publish(ns,key,Buffer.from(canonical(value)));
  const phone={principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,
    channel:'chat',consent_ref:'fixture',token_sha256:sha256('device'),route_version:'r1',output_modes:['text']};
  const sources=Object.assign(new StaticFixtureDeviceAuthority([phone,{...phone,channel:'background_scheduled',token_sha256:sha256('scheduled')}]),
    {scheduled:async()=>sources.authenticate('scheduled')});
  const ingress=new UnifiedIngress(new RawArchive(storage,65536)),routes=new OutputTargetAuthority(storage);
  const seed=async(event:string,session:string)=>{
    const d=await ingress.accept({schema_version:'paios.event.v1',event_id:event,device_id:phone.device_id,device_type:phone.device_type,
      captured_at:new Date().toISOString(),source:{channel:'chat'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('Synthetic never sent to a person')},
      {...phone,submission:'explicit_text'});
    await routes.capture(d,phone);await save('processed-events',digest({principal_id:'owner',processed_event_id:d.processed_event_id}),d);
    const key=digest({principal_id:'owner',session_id:session,processed_event_id:d.processed_event_id});
    const record:Admission={principal_id:'owner',session_id:session,processed_event_id:d.processed_event_id,
      payload_sha256:digest({d,session_id:session,skill_sha256:digest('fixture')}),arrival_seq:1,state:'pending',
      idempotency_key:`paios:${key}`,created_at_ms:Date.now(),deadline_ms:Date.now()+600000,policy_version:'startup'};
    return {key,d,record,skill:'fixture',bytes:0};
  };
  const pending=await seed('pending-admission','session-pending');
  await save('d-session-bindings',digest({principal_id:'owner',processed_event_id:pending.d.processed_event_id}),{session_id:pending.record.session_id});
  await save('admission-inputs',pending.key,{d:pending.d,skill:'fixture'});await save('admissions',pending.key,pending.record);
  const original=await seed('consent-original','session-consent');
  const call:FrozenCall={tool_name:'mcp__messaging__send_message',task_id:'synthetic-task',package:'messaging',invocation:'interactive',
    args:{target:'fixture@example.invalid',message:'Synthetic'},idempotency_key:'synthetic-effect',check_with:'message_status',
    admission:{...original,record:{...original.record,run_id:'original-run',state:'completed'}},
    consent:{context:{run_id:'original-run',session_id:'session-consent',tool_call_id:'synthetic-call'},
      effect:'send',target:'email:fixture@example.invalid',task_type:'send_message:email:send',owner_requested:true,
      scope_allowed:true,consent_required:true}};
  const cards=new VoiceConfirmations(storage),card=await cards.openCall(call,'synthetic-request','Synthetic confirmation');
  await cards.decide(card.confirmation_id,phone,'approve');cards.close();
  let effects=0,earlyRequests=0,probes=0;
  const runs=new Map<string,any>();
  const hermes=createServer((req,res)=>{
    const parts:Buffer[]=[];req.on('data',chunk=>parts.push(chunk));req.on('end',()=>{
      const path=new URL(req.url!,'http://fixture').pathname;
      const json=(body:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
      if(path==='/health/detailed')return json({platform:'hermes-agent',readiness:{checks:{session_store:{status:'ok'},model:{status:'ok'}}}});
      if(path==='/v1/paios/capability/execute'){effects++;return json(to_mcp_result(succeeded()));}
      if(path==='/api/sessions'||path.endsWith('/messages'))return json({data:[]});
      if(path.endsWith('/events')){res.setHeader('Content-Type','text/event-stream');res.end();return;}
      if(path==='/v1/runs'){
        const key=String(req.headers['idempotency-key']),body=JSON.parse(Buffer.concat(parts).toString());
        assert.ok(!runs.has(key),'a recovered admission must not be submitted twice');
        const run={schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',
          run_id:`synthetic-${runs.size}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running',
          granted_toolsets:body.grant_toolsets??[]};runs.set(key,run);return json(run);
      }
      return json([...runs.values()].find(run=>path.endsWith('/'+run.run_id)));
    });
  });
  await new Promise<void>(resolve=>hermes.listen(0,'127.0.0.1',resolve));
  const address=hermes.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>((resolve,reject)=>hermes.close(error=>error?reject(error):resolve()));
  const native=new HermesClient(`http://127.0.0.1:${address.port}`,'synthetic-native-key-abcdefghijklmnop',1000,65536,undefined,
    async(input,init)=>{if(String(input).endsWith('/health/detailed'))probes++;else if(!hermes.listening)earlyRequests++;return fetch(input,init);});
  const assemblies:ReturnType<typeof createPersonalAIOSAssembly>[]=[];
  const make=()=>{
    const a=createPersonalAIOSAssembly({storage,native,sourceAuthority:sources,skill:'fixture',max_event_bytes:65536,max_read_bytes:65536,
      session_folding:false,archive_tiering:{hot_days:2},
      admission:{max_pending_events:8,max_pending_bytes:1048576,max_event_age_ms:600000,poll_interval_ms:50,
        native_idempotency_retention_ms:600000,policy_version:'startup'},
      http:{internal_token:'synthetic-internal-key-abcdefghijklmnop',max_request_bytes:65536,request_timeout_ms:1000}});
    assemblies.push(a);return a;
  };
  t.after(async()=>{for(const a of assemblies)await a.close();hermes.closeAllConnections();
    if(hermes.listening)await new Promise<void>(resolve=>hermes.close(()=>resolve()));await storage.close();await rm(root,{recursive:true,force:true});});
  const errors:unknown[]=[];t.mock.method(console,'error',(...args:unknown[])=>errors.push(args));
  const a=make();await new Promise<void>(resolve=>a.server.listen(0,'127.0.0.1',resolve));
  const central=a.server.address();assert.ok(central&&typeof central!=='string');
  await sleep(150);
  assert.equal(a.server.listening,true,'recovery must never close central when Hermes is down');
  assert.equal((await fetch(`http://127.0.0.1:${central.port}/health`)).status,200);
  assert.equal(earlyRequests,0,'recovery must wait for the native readiness signal');assert.equal(probes,1);
  await new Promise<void>(resolve=>hermes.listen(address.port,'127.0.0.1',resolve));
  await until(async()=>runs.size===2&&(await storage.list('capability-call-notifications')).length===1,75000);
  const notification=()=>storage.read('capability-call-notifications',card.confirmation_id).then(bytes=>JSON.parse(Buffer.from(bytes).toString()));
  await until(async()=>(await notification()).state==='admitted');
  await until(async()=>(await storage.list('run-bindings')).length===2);assert.equal(effects,1);
  await a.close();const restarted=make();await new Promise<void>(resolve=>restarted.server.listen(0,'127.0.0.1',resolve));
  await until(()=>probes>=3);await sleep(100);
  assert.equal(restarted.server.listening,true);assert.equal(runs.size,2);assert.equal(effects,1);
  assert.equal(errors.some(error=>String(error).includes('RECOVERY_CLOSE_FAILED')),false);
});

for(const busy of [false,true])test(`health remains available during pending/rejected wiring: busy=${busy}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'startup-health-')),storage=new PosixStorage(root);
  const a=createPersonalAIOSAssembly({storage,realtime_busy:()=>busy,native:new HermesClient('http://127.0.0.1:1','synthetic-native-key-abcdefghijklmnop',100,8192),
    admission:{max_pending_events:1,max_pending_bytes:8192,max_event_age_ms:1000,poll_interval_ms:50,native_idempotency_retention_ms:1000,policy_version:'health'},
    skill:'fixture',max_event_bytes:8192,max_read_bytes:8192,http:{internal_token:'synthetic-internal-key-abcdefghijklmnop',max_request_bytes:8192,request_timeout_ms:1000}});
  const wiring=Promise.withResolvers<void>();t.mock.method(a.runtime,'wireCapabilities',()=>wiring.promise);
  t.mock.method(console,'error',()=>{});
  t.after(async()=>{wiring.resolve();await a.close();await storage.close();await rm(root,{recursive:true,force:true});});
  await new Promise<void>(resolve=>a.server.listen(0,'127.0.0.1',resolve));const address=a.server.address();assert.ok(address&&typeof address!=='string');
  const health=()=>fetch(`http://127.0.0.1:${address.port}/health`,{signal:AbortSignal.timeout(1000)});
  assert.equal((await health()).status,200);wiring.reject(Error('synthetic wiring failure'));
  await new Promise(r=>setImmediate(r));assert.equal((await health()).status,200);assert.equal(a.server.listening,true);
});
