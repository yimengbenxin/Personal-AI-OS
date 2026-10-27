import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleModelSettingsHttp} from '../src/model-settings-http.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {ModelUsage} from '../src/model-usage.ts';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {sourceClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputAuthority} from '../src/output.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {EVENT_SCHEMA,sha256,digest,canonical} from '../src/contracts.ts';

async function responseObject(response:Response):Promise<Record<string,unknown>>{
  const value:unknown=await response.json();assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;
}

test('service HTTP separates MCP token, binds submitting admission and exact revision routes, and never accepts caller owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-usage-http-')),storage=new PosixStorage(join(root,'storage')),
    authority=ModelSettingsAuthority.open(join(root,'models'),{environment_id:'test',master_key:Buffer.alloc(32,7)});
  authority.bootstrap({providers:[{id:'fake-provider',display_name:'Fake',wire_protocol:'chat_completions',base_url:'https://models.invalid/v1',credential_ref:'fake-credential'}],
    roles:[{id:'brain',profile:'owner',provider_ref:'fake-provider',model_id:'fake-model',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'delegation',profile:'owner',inherit_from:'brain',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'auxiliary.vision',profile:'owner',inherit_from:'brain',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'call.intent',profile:'owner',inherit_from:'brain',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'cron',profile:'owner',inherit_from:'brain',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'build.workshop',profile:'builder',provider_ref:'fake-provider',model_id:'fake-model',parameters:{},ordered_fallbacks:[],activation_boundary:'build_idle'}]},
    {'fake-credential':'fake-inference-key-1234'});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const native=sourceClient({create:async body=>{
    entered.resolve();await release.promise;
    return {run_id:'native-wire-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'completed'};
  },status:async()=>({run_id:'native-wire-run',session_id:'canonical-session',conversation_session_id:'canonical-session',status:'completed'}),
    cancel:async()=>({run_id:'native-wire-run',session_id:'canonical-session',conversation_session_id:'canonical-session',status:'cancelled'})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
    native_idempotency_retention_ms:86400000,policy_version:'usage-http'}),archive=new RawArchive(storage,8192);
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),skill:'test',max_read_bytes:8192,
    payment:PaymentAuthority.open(join(root,'payments')),devices:[{principal_id:'real-owner',device_id:'phone',device_type:'phone',channel:'fixture',
      consent_ref:'consent',route_version:'r1',output_modes:['text'],token_sha256:sha256('fake-phone')}]});
  runtime.installModelSettings(authority);
  const notices:{text:string;system_event:{alert_kind:string}}[]=[];
  const usage=new ModelUsage(authority.db,{notify:async notice=>{notices.push(notice);}});runtime.installModelUsage(usage,'test');
  const latest=()=>{const attempt=usage.recentAttempts('test','real-owner')[0];assert.ok(attempt);return attempt;};
  const token='fake-service-only-token-abcdefghijklmnop',server=createServer(async(req,res)=>{
    if(!await handleModelSettingsHttp(req,res,runtime,token,16384)){res.writeHead(404);res.end();}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{release.resolve();await new Promise<void>(done=>server.close(()=>done()));await runtime.close();authority.close();await rm(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/internal/model-settings/`;
  const post=(route:string,body:unknown,key=token)=>fetch(url+route,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const credential=authority.resolve('test','owner','brain',1);
  assert.equal((await post('credential',{environment_id:'test',profile:'owner',revision:1,handle:credential.credential_handle},'fake-mcp-token-abcdefghijklmnop')).status,401);
  const key=await post('credential',{environment_id:'test',profile:'owner',revision:1,handle:credential.credential_handle});
  assert.equal((await responseObject(key)).key,'fake-inference-key-1234');assert.equal(key.headers.get('cache-control'),'no-store');
  assert.equal((await post('projection',{environment_id:'test',profile:'owner',revision:1,group:'brain'})).status,404);
  for(const changes of [{environment_id:'other'},{profile:'workshop'},{revision:2}]){
    const denied=await post('credential',{environment_id:'test',profile:'owner',revision:1,handle:credential.credential_handle,...changes});
    assert.ok(denied.status>=400);assert.ok(!(await denied.text()).includes('fake-inference-key-1234'));
  }
  const d=await new UnifiedIngress(archive).accept({schema_version:EVENT_SCHEMA,event_id:'source-event',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),
    source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('hello')},
    {principal_id:'real-owner',device_id:'phone',device_type:'phone',consent_ref:'consent',channel:'fixture',submission:'explicit_text'});
  await storage.publish('processed-events',digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id}),Buffer.from(canonical(d)));
  await admission.admit(d,'canonical-session','skill');await entered.promise;
  const attempt={attempt_id:'wire-attempt',request_id:'logical-request',environment:'test',profile:'owner',revision:1,provider_id:'fake-provider',
    model_id:'fake-model',role:'brain',base_url:'https://models.invalid/v1',run_id:'native-wire-run',session_id:'canonical-session',captured_at:new Date().toISOString(),
    status:'completed',input_tokens:11,output_tokens:2,original_usage:{prompt_tokens:11,completion_tokens:2},cost:{kind:'unknown',amount:null,currency:'CNY'}};
  assert.equal((await post('usage',attempt)).status,200);assert.equal(usage.summary('test','real-owner').attempts,1);
  assert.equal(latest().owner_chat,true);
  for(const changes of [{owner:'attacker'},{provider_id:'other'},{model_id:'other'},{base_url:'https://other.invalid'},
    {session_id:'not-admitted'},{original_usage:{prompt_tokens:'fake-inference-key-1234'}}]){
    const response=await post('usage',{...attempt,attempt_id:'rejected',...changes});assert.ok(response.status>=400);
    assert.ok(!(await response.text()).includes('fake-inference-key-1234'));
  }
  assert.equal(usage.summary('test','real-owner').attempts,1);assert.equal(usage.summary('test','attacker').attempts,0);
  usage.pause('test','real-owner');
  const context={environment:'test',profile:'owner',run_id:'native-wire-run',session_id:'canonical-session'};
  assert.equal((await responseObject(await post('admission',{...context,role:'brain'}))).allowed,true);
  for(const role of ['delegation','build']){
    const decision=await responseObject(await post('admission',{...context,role}));
    assert.equal(decision.allowed,false);assert.equal(decision.status,'paused');assert.equal(decision.settings_entry,'模型与密钥');
  }
  assert.equal((await post('usage',{...attempt,attempt_id:'existing-child-retry',role:'delegation'})).status,200);
  assert.equal(latest().owner_chat,false,'existing child retries keep running and never consume owner reserve');
  assert.equal((await post('usage',{...attempt,attempt_id:'remote-builder-wire',profile:'builder',role:'build.workshop'})).status,200);
  assert.equal(latest().owner_chat,false,'remote builder retains the same admitted owner without using the chat reserve');
  assert.equal((await responseObject(await post('admission',{...context,profile:'builder',role:'build'}))).allowed,false);
  assert.equal((await post('admission',{...context,profile:'rogue',role:'build'})).status,403);
  assert.equal((await post('usage',{...attempt,attempt_id:'rogue-builder',profile:'rogue',role:'build.workshop'})).status,403);
  usage.resume('test','real-owner');assert.equal((await responseObject(await post('admission',{...context,role:'delegation'}))).allowed,true);
  const price={environment:'test',provider_id:'fake-provider',model_id:'fake-model',currency:'CNY',price_version:'synthetic-price-v1',
    source:'Synthetic acceptance only',updated_at:'2026-10-23T00:00:00.000Z',input_per_million:2,output_per_million:2,
    cache_read_per_million:0.2,cache_write_per_million:0.4,input_tokens_include_cache:true};
  usage.setPrices([price]);
  const priced={...attempt,attempt_id:'priced-native-wire',input_tokens:10000000,output_tokens:1000000,
    original_usage:{prompt_tokens:10000000,completion_tokens:1000000,cached_tokens:2000000,cache_creation_input_tokens:1000000}};
  assert.equal((await post('usage',priced)).status,200);assert.equal(usage.summary('test','real-owner').estimated_cny,16.8);
  assert.equal(notices.at(-1)!.system_event.alert_kind,'estimated');assert.match(notices.at(-1)!.text,/估算/);
  usage.setPrices([{...price,price_version:'synthetic-price-v2',updated_at:'2026-10-24T00:00:00.000Z',input_per_million:4}]);
  assert.equal((await post('usage',priced)).status,200);assert.equal(usage.summary('test','real-owner').estimated_cny,16.8);
  assert.equal(latest().price_version,'synthetic-price-v1');
  const trusted={principal_id:'real-owner',device_id:'phone',device_type:'phone' as const,consent_ref:'consent',channel:'fixture',submission:'observation' as const};
  const capture=await archive.archive({schema_version:EVENT_SCHEMA,event_id:'visual-source',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),
    source:{channel:'fixture'},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:Buffer.from([255,216,255,217])},trusted);
  const captureSource={kind:'capture',raw_ref:capture.raw_ref,archive_revision:capture.archive_revision,principal_id:'real-owner',device_id:'phone'};
  const start={...attempt,attempt_id:'caption-attempt',request_id:'caption-request',run_id:'',session_id:capture.raw_ref,role:'auxiliary.vision',
    phase:'started',status:'started',input_tokens:null,output_tokens:null,original_usage:{},source_context:captureSource};
  assert.equal((await post('usage',start)).status,200);assert.equal(latest().status,'started');
  assert.equal(latest().owner_chat,false);
  for(const source_context of [{...captureSource,device_id:'forged'},{...captureSource,principal_id:'attacker'},{...captureSource,archive_revision:'a'.repeat(64)}]){
    assert.ok((await post('usage',{...start,attempt_id:'bad-caption',source_context})).status>=400);
  }
  assert.ok((await post('usage',{...start,attempt_id:'bad-role',role:'delegation'})).status>=400);
  const terminal={...start,phase:'terminal',status:'completed',input_tokens:100,output_tokens:10,original_usage:{prompt_tokens:100,completion_tokens:10,cached_tokens:0,cache_creation_input_tokens:0}};
  assert.equal((await post('usage',terminal)).status,200);assert.equal((await post('usage',terminal)).status,200);
  assert.equal(latest().status,'completed');
  const audio=await archive.archive({schema_version:EVENT_SCHEMA,event_id:'call-source',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'fixture'},
    media_type:'audio',mime:'audio/wav',representation:'uploaded_original',payload:Buffer.from('fixture-audio')},trusted);
  await archive.bindCallTrack(audio.raw_ref,{call_id:'call-source',principal_id:'real-owner',track:'microphone'});
  const callSource={kind:'call',raw_ref:audio.raw_ref,archive_revision:audio.archive_revision,principal_id:'real-owner',device_id:'phone',call_id:'call-source',continuity:'call-continuity'};
  assert.equal((await post('usage',{...start,attempt_id:'call-intent',request_id:'call-request',role:'call.intent',session_id:audio.raw_ref,source_context:callSource})).status,200);
  assert.equal(latest().owner_chat,true);
  assert.ok((await post('usage',{...start,attempt_id:'forged-call',role:'call.intent',session_id:audio.raw_ref,source_context:{...callSource,call_id:'other-call'}})).status>=400);
  // A live call's microphone is one PCM stream whose head advances on every append. The classifier cites the exact
  // revision of the utterance's first chunk, which later chunks (the rest of the utterance, the trailing silence) supersede.
  const pcm={schema_version:EVENT_SCHEMA,event_id:'call-microphone-lane',device_id:'phone',device_type:'phone' as const,captured_at:new Date().toISOString(),
    source:{channel:'fixture'},media_type:'audio' as const,mime:'audio/pcm',representation:'received_decoded_sample' as const,payload:Buffer.alloc(320)};
  const pcmChunk=(seq:number)=>({track_id:'microphone',stream_epoch:'call-lane',seq,modality:'audio' as const,format:'pcm_s16le:16000:1',
    source_range:{kind:'interval' as const,timebase_id:'received-pcm:call-lane',stream_epoch:'call-lane',start_ms:seq*10,end_ms:(seq+1)*10}});
  const laneRef=`l5:${digest({event_id:pcm.event_id,principal_id:'real-owner',device_id:'phone'})}`;
  await archive.bindCallTrack(laneRef,{call_id:'live-call',principal_id:'real-owner',track:'microphone'});
  const uttered=(await (await archive.admitStream(pcm,trusted,pcmChunk(0))).commit).event;
  await (await archive.admitStream(pcm,trusted,pcmChunk(1))).commit;
  const liveSource={kind:'call',raw_ref:uttered.raw_ref,archive_revision:uttered.archive_revision,principal_id:'real-owner',device_id:'phone',call_id:'live-call',continuity:'call-continuity'};
  const liveStart={...start,attempt_id:'live-call-intent',request_id:'live-call-request',role:'call.intent',session_id:laneRef,source_context:liveSource};
  const live=await post('usage',liveStart);assert.equal(live.status,200,await live.text());
  assert.equal((await post('usage',{...liveStart,phase:'terminal',status:'completed',input_tokens:5,output_tokens:1,original_usage:{prompt_tokens:5,completion_tokens:1}})).status,200);
  assert.ok((await post('usage',{...liveStart,attempt_id:'unknown-revision',source_context:{...liveSource,archive_revision:'b'.repeat(64)}})).status>=400);
  assert.ok((await post('usage',{...liveStart,attempt_id:'other-device',source_context:{...liveSource,device_id:'watch'}})).status>=400);
  release.resolve();let bound=false,lastRecord:unknown;
  for(let index=0;index<100;index++){
    const record=await admission.readOnly('real-owner','canonical-session',d.processed_event_id);
    lastRecord=record;if(record?.run_id==='native-wire-run'){bound=true;break;}await new Promise(done=>setTimeout(done,5));
  }
  assert.equal(bound,true,JSON.stringify(lastRecord));
  t.mock.method(admission,'modelUsageSource',()=>undefined); // No active entry: cron must use the persisted exact binding.
  const cronSource={kind:'run',run_id:'native-wire-run',session_id:'canonical-session',principal_id:'real-owner',processed_event_id:d.processed_event_id};
  const cronStart={...start,attempt_id:'cron-attempt',request_id:'cron-request',role:'cron',run_id:'native-wire-run',session_id:'canonical-session',source_context:cronSource};
  assert.equal((await post('usage',cronStart)).status,200);assert.equal(latest().owner_chat,false);
  assert.ok((await post('usage',{...cronStart,attempt_id:'forged-cron',source_context:{...cronSource,processed_event_id:'forged'}})).status>=400);
  const cronTerminal={...cronStart,phase:'terminal',status:'completed',input_tokens:100,output_tokens:10,original_usage:{prompt_tokens:100,completion_tokens:10,cached_tokens:0,cache_creation_input_tokens:0}};
  assert.equal((await post('usage',cronTerminal)).status,200);assert.equal((await post('usage',cronTerminal)).status,200);
  usage.pause('test','real-owner');const cronAdmission={environment:'test',profile:'owner',run_id:'native-wire-run',session_id:'canonical-session',role:'cron',source_context:cronSource};
  const cronPaused=await responseObject(await post('admission',cronAdmission));assert.equal(cronPaused.allowed,false);assert.equal(cronPaused.reserve_remaining_cny,1);
  usage.resume('test','real-owner');assert.equal((await responseObject(await post('admission',cronAdmission))).allowed,true);
});
