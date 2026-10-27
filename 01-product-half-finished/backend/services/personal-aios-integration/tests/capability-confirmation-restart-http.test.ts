import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PosixStorage} from '../src/storage.ts';
import {VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import {CapabilityConfirmations} from '../src/capability/consent/confirmation.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {HermesClient} from '../src/hermes-client.ts';
import {succeeded} from '../../../../../capability/sdk/ts/receipt.ts';
import {FormalTerminalSources} from '../../../phase0/gateway/src/personal-aios-formal-source.ts';
const work=await mkdtemp(join(tmpdir(),'confirmation-restart-'));
await writeFile(join(work,'config.json'),JSON.stringify({capability_packages:{enabled:['messaging'],gateway:['messaging']}}));
process.env.PAIOS_PRODUCT_CONFIG=join(work,'config.json');
test.after(()=>rm(work,{recursive:true,force:true}));
const policy={max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:50,native_idempotency_retention_ms:100000,policy_version:'k6-isolated'};

async function isolated(t:any){
 const root=await mkdtemp(join(work,'k6-'));
 await mkdir(join(root,'storage'));
 const storage=new PosixStorage(join(root,'storage'));
 return {root,storage};
}
async function seed(f:any,verdict:'approve'|'deny'){
 const d={principal_id:'synthetic-owner',device_id:'revoked-phone',device_type:'phone',processed_event_id:'d:request',
  origin:'explicit_user_prompt',media_type:'text',user_identity:'synthetic-owner',received_at:new Date().toISOString(),
  content:{text:'Synthetic consent history'},processing:{path_id:'text'},source:{channel:'chat'},speakers:[]};
 const context={run_id:'run-synthetic',session_id:'session-synthetic',tool_call_id:'call-synthetic'};
 const admission={d,skill:'fixture',bytes:0,record:{principal_id:d.principal_id,session_id:context.session_id,run_id:context.run_id,processed_event_id:d.processed_event_id,
  payload_sha256:'0'.repeat(64),arrival_seq:1,state:'completed',idempotency_key:'run-key',created_at_ms:Date.now(),deadline_ms:Date.now()+60000,policy_version:'fixture'}};
 const frozen={tool_name:'mcp__messaging__send_message',task_id:'native-child',package:'messaging',invocation:'interactive',
  args:{action:'send',target:'fixture@example.invalid',message:'Synthetic never transmitted'},idempotency_key:'frozen-key',admission,check_with:'message_status',
  consent:{context,effect:'send',target:'email:fixture@example.invalid',task_type:'send_message:email:send',owner_requested:true,scope_allowed:true,consent_required:true}};
 const cards=new VoiceConfirmations(f.storage,{ttl_ms:60000});
 let executions=0,delivered=0;
 const service=new CapabilityConfirmations(f.storage,cards,{
  gates:(_call:any,approved:boolean)=>({effectConsent:async()=>({status:approved?'allowed':'confirmation_required',scope:{test:true}}),
   spend:async()=>({action:'block',message:'not used'}),selfChange:async()=>({action:'block',message:'not used'})}),
  execute:async()=>{executions++;return succeeded();},receipt:async()=>{},followUp:async()=>{delivered++;},error:(error:any)=>{throw error;}
 });
 await service.decide(frozen);const card=cards.list(d.principal_id)[0];assert.ok(card);
 await cards.decide(card.confirmation_id,{principal_id:d.principal_id,device_id:d.device_id,device_type:d.device_type},verdict);
 const result=await service.settle(card);
 assert.equal(result.status.state,verdict==='approve'?'succeeded':'cancelled');assert.equal(delivered,1);assert.equal(executions,verdict==='approve'?1:0);
 await service.close();cards.close();
 // Remove the new delivery marker to exercise completed history written before it existed.
 await f.storage.removeOriginals([{namespace:'capability-call-notifications',key:card.confirmation_id}]);
 return {card,executions};
}
function assembly(storage:any){
 const nativeCalls:any[]=[];
 const native=new HermesClient('http://127.0.0.1:1','synthetic-in-memory-fixture-key',10000,65536,undefined,async(input:any)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/health/detailed')return Response.json({platform:'hermes-agent',readiness:{checks:{session_store:{status:'ok'},model:{status:'ok'}}}});
  nativeCalls.push(path);
  if(path.startsWith('/api/sessions'))return Response.json({data:[]});
  throw new Error('UNEXPECTED_NATIVE_NETWORK_ATTEMPT:'+path);
 });
 // A revoked device is absent from the startup inventory. Use the actual gateway authority unchanged.
 const sources=new FormalTerminalSources();
 const value=createPersonalAIOSAssembly({storage,native,admission:policy,skill:'synthetic fixed skill',max_event_bytes:65536,max_read_bytes:65536,
  sourceAuthority:sources,session_folding:false,archive_tiering:{hot_days:2},
  http:{internal_token:'synthetic-in-memory-internal-key',max_request_bytes:65536,request_timeout_ms:5000}});
 return {value,nativeCalls};
}
async function listen(server:any){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
test('control: actual integration HTTP server without historical confirmations stays healthy',{timeout:20000},async t=>{
 const f=await isolated(t),{value,nativeCalls}=assembly(f.storage);
 t.after(async()=>{await value.close();await f.storage.close();await rm(f.root,{recursive:true,force:true});});
 const port=await listen(value.server);const response=await fetch(`http://127.0.0.1:${port}/health`);
 assert.equal(response.status,200);assert.equal((await response.json()).service,'personal-aios-integration');
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(value.server.listening,true);
 assert.equal(nativeCalls.length,0);
});
for(const verdict of ['approve','deny'] as const)test(`completed ${verdict} history with an unpaired device keeps the actual Integration HTTP service healthy`,{timeout:20000},async t=>{
 const f=await isolated(t),{card}=await seed(f,verdict);
 const errors:string[]=[];t.mock.method(console,'error',(...args:any[])=>{errors.push(args.map(String).join(' '));});
 const {value,nativeCalls}=assembly(f.storage);
 t.after(async()=>{await value.close();await f.storage.close();await rm(f.root,{recursive:true,force:true});});
 const port=await listen(value.server);
 // Recovery is asynchronous after listen; wait for its durable terminal notification marker.
 let delivery:any;
 for(let i=0;i<100;i++){
  try{delivery=JSON.parse(Buffer.from(await f.storage.read('capability-call-notifications',card.confirmation_id)).toString());}
  catch(error:any){if(error.code!=='ENOENT')throw error;}
  if(delivery?.state==='undeliverable'||!value.server.listening)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(value.server.listening,true,'a revoked historical source must not close the service');
 const response=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(response.status,200);
 assert.deepEqual(delivery,{state:'undeliverable',reason:'SCHEDULE_DEVICE_REQUIRED'});
 assert.equal(errors.some(error=>error.includes('ADMISSION_RECOVERY_FAILED')),false);
 assert.equal(nativeCalls.length,0,'recovery must not invoke a model or replay the effect');
});
