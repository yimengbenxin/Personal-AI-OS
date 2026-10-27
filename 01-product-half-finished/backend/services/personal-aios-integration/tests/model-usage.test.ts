import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ModelUsage,defaultCacheWriteBilling,MODEL_COST_ESTIMATE_NOTE,type UsageAttempt,type BudgetNotice} from '../src/model-usage.ts';

const base:UsageAttempt={attempt_id:'try-1',request_id:'request-1',environment:'staging',owner:'owner',
  provider_id:'fake-opencode',model_id:'fake-model',role:'main',revision:'r1',owner_chat:false,
  captured_at:'2026-10-23T15:59:00.000Z',status:'failed',input_tokens:null,output_tokens:null,
  cost:{kind:'unknown',amount:null,currency:'CNY'}};
function setup(){let time=Date.parse(base.captured_at);const notices:BudgetNotice[]=[];let resumed=0;
  const db=new DatabaseSync(':memory:');const usage=new ModelUsage(db,{now:()=>time,
    notify:async value=>{notices.push(value);},resumeWork:()=>{resumed++;}});
  return {usage,db,notices,advance:(ms:number)=>{time+=ms;},resumed:()=>resumed};}

test('every retry/fallback is distinct; duplicates are idempotent; unknown remains unknown',async()=>{
  const {usage,db}=setup();await usage.record(base);await usage.record(base);
  await usage.record({...base,attempt_id:'try-2',provider_id:'fake-official',status:'completed',cost:{kind:'known',amount:3,currency:'CNY'}});
  const day=usage.summary('staging','owner');assert.equal(day.attempts,2);assert.equal(day.unknown_attempts,1);
  assert.equal(day.known_cny,3);assert.equal(day.estimated_cny,0);assert.equal(day.subscription_remaining,'套餐余量未知');
  assert.equal(day.estimate_note,MODEL_COST_ESTIMATE_NOTE);
  assert.deepEqual(usage.recentAttempts('staging','owner').map(a=>a.attempt_id),['try-2','try-1']);
  await assert.rejects(usage.record({...base,model_id:'changed'}),/USAGE_ATTEMPT_CONFLICT/);db.close();
});

test('Shanghai day, known and estimated wording, stable notice identity and remind-only default',async()=>{
  const {usage,db,notices,advance}=setup();await usage.record({...base,cost:{kind:'known',amount:10,currency:'CNY'}});
  assert.equal(notices.length,0);await usage.record({...base,attempt_id:'try-2',cost:{kind:'estimated',amount:0.5,currency:'CNY'}});
  const first=notices[0];assert.ok(first);assert.match(first.text,/估算/);assert.equal(usage.admission('staging','owner',false).allowed,true);
  assert.ok(first.text.includes(MODEL_COST_ESTIMATE_NOTE));
  await usage.record({...base,attempt_id:'try-3',cost:{kind:'known',amount:0.1,currency:'CNY'}});
  assert.match(notices.at(-1)!.text,/已知消费/);assert.notEqual(first.id,notices.at(-1)!.id);
  advance(60000);assert.equal(usage.summary('staging','owner').local_date,'2026-10-24');
  assert.equal(usage.summary('staging','owner').attempts,0);db.close();
});

test('explicit pause preserves forced owner reserve, survives restart and deterministic resume continues work',async()=>{
  const {usage,db,resumed}=setup();usage.setPausePolicy('staging','owner',true);
  await usage.record({...base,owner_chat:true,cost:{kind:'known',amount:10.1,currency:'CNY'}});
  assert.equal(usage.admission('staging','owner',false).allowed,false);
  assert.equal(usage.admission('staging','owner',true).reserve_remaining_cny,1);
  await usage.record({...base,attempt_id:'owner-1',owner_chat:true,cost:{kind:'known',amount:1,currency:'CNY'}});
  assert.equal(usage.admission('staging','owner',true).allowed,false);
  const recovered=new ModelUsage(db,{now:()=>Date.parse(base.captured_at),notify:async()=>{},resumeWork:()=>{}});
  assert.equal(recovered.admission('staging','owner',false).allowed,false);
  usage.resume('staging','owner');assert.equal(resumed(),1);assert.equal(usage.admission('staging','owner',false).allowed,true);
  await usage.record({...base,attempt_id:'later',cost:{kind:'known',amount:1,currency:'CNY'}});
  assert.equal(usage.admission('staging','owner',false).allowed,true);db.close();
});
test('pause_on_limit defaults off, estimated reminders do not pause, opt-in evaluates known spend and opt-out drains queued work',async()=>{
 const {usage,db,notices,resumed}=setup();assert.equal(usage.summary('staging','owner').pause_on_limit,false);
 usage.setPausePolicy('staging','owner',true);
 await usage.record({...base,cost:{kind:'estimated',amount:11,currency:'CNY'}});
 assert.equal(notices.length,1);assert.equal(usage.admission('staging','owner',false).allowed,true);
 usage.setPausePolicy('staging','owner',false);
 await usage.record({...base,attempt_id:'known',cost:{kind:'known',amount:11,currency:'CNY'}});
 assert.equal(usage.admission('staging','owner',false).allowed,true);
 usage.setPausePolicy('staging','owner',true);assert.equal(usage.admission('staging','owner',false).allowed,false);
 usage.setPausePolicy('staging','owner',false);assert.equal(usage.admission('staging','owner',false).allowed,true);assert.equal(resumed(),2);
 assert.equal(notices.at(-1)!.system_event.alert_kind,'known');db.close();
});
test('reserve floor is enforced; resume exempts only the current local day and a new day gets a fresh reserve',async()=>{
 const {usage,db,advance}=setup();
 assert.throws(()=>usage.setPausePolicy('staging','owner',true,0),/MODEL_SETTINGS_RESERVE_INVALID/);
 assert.throws(()=>usage.setPausePolicy('staging','owner',true,0.99),/MODEL_SETTINGS_RESERVE_INVALID/);
 usage.setPausePolicy('staging','owner',true,2);await usage.record({...base,cost:{kind:'known',amount:11,currency:'CNY'}});
 assert.equal(usage.admission('staging','owner',true).reserve_remaining_cny,2);
 usage.resume('staging','owner');advance(60000);
 assert.equal(usage.summary('staging','owner').paused,false);
 await usage.record({...base,attempt_id:'new-day',captured_at:'2026-10-23T16:00:00.000Z',cost:{kind:'known',amount:11,currency:'CNY'}});
 assert.equal(usage.admission('staging','owner',false).allowed,false);
 assert.equal(usage.admission('staging','owner',true).reserve_remaining_cny,2);
 advance(86400000);assert.equal(usage.admission('staging','owner',false).allowed,true);db.close();
});
test('existing budget policy migrates the reserve floor while preserving signed opt-in and daily resume',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE model_usage_policy(environment TEXT NOT NULL,owner TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,paused_at TEXT,resumed_day TEXT,reserve_start_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(environment,owner));
  INSERT INTO model_usage_policy VALUES('staging','owner',1,NULL,'2026-10-23',7);`);
 const usage=new ModelUsage(db,{now:()=>Date.parse(base.captured_at),notify:async()=>{}}),policy=usage.summary('staging','owner');
 assert.equal(policy.pause_on_limit,true);assert.equal(policy.owner_reserve_cny,1);assert.equal(policy.resumed_local_date,'2026-10-23');
 assert.throws(()=>db.prepare('UPDATE model_usage_policy SET reserve_micros=0').run(),/CHECK/);db.close();
});

test('delivery failure surfaces; durable threshold fact replays with exact bytes through existing delivery dedup',async()=>{
  const db=new DatabaseSync(':memory:');const notices:BudgetNotice[]=[];
  const usage=new ModelUsage(db,{now:()=>Date.parse(base.captured_at),notify:async n=>{notices.push(n);throw Error('offline');}});
  const attempt={...base,cost:{kind:'known' as const,amount:11,currency:'CNY'}};
  await assert.rejects(usage.record(attempt),/offline/);
  const recovered=new ModelUsage(db,{now:()=>Date.parse(base.captured_at),notify:async n=>{assert.deepEqual(n,notices[0]);}});
  await recovered.recover('staging');db.close();
});

test('foreign money stays foreign, negative/invalid amounts rejected, environment isolated',async()=>{
  const {usage,db,notices}=setup();await usage.record({...base,cost:{kind:'known',amount:50,currency:'USD'}});
  assert.equal(usage.summary('staging','owner').known_cny,0);assert.equal(notices.length,0);
  assert.equal(usage.summary('production','owner').attempts,0);
  await assert.rejects(usage.record({...base,attempt_id:'bad',cost:{kind:'known',amount:-1,currency:'CNY'}}),/USAGE_COST_INVALID/);db.close();
});
const price={environment:'staging',provider_id:'fake-opencode',model_id:'fake-model',currency:'CNY',price_version:'synthetic-v1',
  source:'Synthetic acceptance rate, not a vendor price',updated_at:'2026-10-23T00:00:00.000Z',input_per_million:2,output_per_million:2,
  cache_read_per_million:0.2,cache_write_per_million:0.4,input_tokens_include_cache:true};
test('documented provider billing prices legacy rows without fabricating cache-write measurements',async()=>{
 const {usage,db}=setup();
 const production={...base,status:'completed' as const,model_id:'deepseek-flash',input_tokens:29960,output_tokens:210,cache_read_tokens:8704};
 const legacy={...price,model_id:production.model_id,input_per_million:2,output_per_million:8,cache_read_per_million:0.04,cache_write_per_million:0};
 usage.setPrices([legacy]);
 const stored=db.prepare('SELECT body FROM model_usage_prices').get()!.body;
 const billing=defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url:'https://api.deepseek.com/v1'},production.model_id);
 await usage.record(production,billing);
 assert.deepEqual(usage.recentAttempts('staging','owner')[0]!.cost,{kind:'estimated',amount:0.044540,currency:'CNY'});
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cache_write_tokens,0);
 assert.equal(db.prepare('SELECT body FROM model_usage_prices').get()!.body,stored);
 await usage.record(production,billing);assert.equal(usage.summary('staging','owner').attempts,1);
 for(const [base_url,model_id] of [['https://opencode.ai/zen/go/v1','deepseek-v4.1-flash'],
   ['https://amr-link.open-design.ai/v1','deepseek-v4.1-flash'],['https://opencode.ai/zen/go/v1','glm-5.3-flash']] as const){
   const configured={...legacy,model_id};usage.setPrices([configured]);
   await usage.record({...production,attempt_id:base_url+model_id,model_id},defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url},model_id));
   assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.amount,0.044540);
 }
 const unknown=defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url:'https://other.invalid/v1'},production.model_id);
 await usage.record({...production,attempt_id:'unknown'},unknown);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');
 assert.equal(defaultCacheWriteBilling({wire_protocol:'anthropic_messages',base_url:'https://opencode.ai/zen/go/v1'},'qwen3.7-plus'),'separate');
 usage.setPrices([{...legacy,price_version:'reported',updated_at:'2026-10-24T00:00:00.000Z',cache_write_billing:'separate',cache_write_per_million:4}]);
 await usage.record({...production,attempt_id:'missing-writes'},billing);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');
 await usage.record({...production,attempt_id:'reported-writes',cache_write_tokens:100},billing);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.amount,0.044740);
 usage.setPrices([{...legacy,price_version:'declared',updated_at:'2026-10-25T00:00:00.000Z',cache_write_billing:'input'}]);
 await usage.record({...production,attempt_id:'explicit-policy'},unknown);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.amount,0.044540);
 assert.throws(()=>usage.setPrices([{...legacy,cache_write_billing:'guess' as never}]),/USAGE_PRICE_INVALID/);
 db.close();
});
test('configured vision and executor identities use documented billing without a cache-write counter',async()=>{
 const {usage,db}=setup();
 const routes=[
  ['siliconflow-paios','zai-org/GLM-5.3-Flash','https://api.siliconflow.cn/v1','auxiliary.vision',0.8,2.8,0.23],
  ['executor-siliconflow','zai-org/GLM-5.3-Flash','https://api.siliconflow.cn/v1','executor.thorough',0.8,2.8,0.23],
  ['deepseek-paios','deepseek-flash','https://api.deepseek.com','brain',2,8,0.04],
  ['executor-deepseek','deepseek-flash','https://api.deepseek.com','executor.fast.executor',2,8,0.04],
 ] as const;
 for(const [provider_id,model_id,base_url,role,input,output,cache] of routes){
  const configured={...price,environment:'production',provider_id,model_id,price_version:'official-standard-2026-10-24',
   updated_at:'2026-10-24T00:00:00.000Z',
   source:'Official standard billing regression fixture; token counts are synthetic',input_per_million:input,
   output_per_million:output,cache_read_per_million:cache,cache_write_per_million:null};
  usage.setPrices([configured]);
  const attempt={...base,environment:'production',provider_id,model_id,role,attempt_id:provider_id,status:'completed' as const,
   captured_at:'2026-10-25T08:58:15.000Z',
   input_tokens:1000,output_tokens:200,cache_read_tokens:64};
  await usage.record(attempt,defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url},model_id));
  const saved=usage.sourceAttempt('production','owner',provider_id)!;
  assert.equal(saved.price_version,configured.price_version,provider_id);
  assert.deepEqual(saved.cost,{kind:'estimated',amount:Math.round((936*input+200*output+64*cache))/1e6,currency:'CNY'},provider_id);
  assert.equal(saved.cache_write_tokens,0);
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM model_usage_prices WHERE provider_id=?').get(provider_id)!.body as string),configured);
  await usage.record({...attempt,attempt_id:provider_id+'-missing-read',cache_read_tokens:null},
   defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url},model_id));
  assert.equal(usage.sourceAttempt('production','owner',provider_id+'-missing-read')!.cost.kind,'unknown');
 }
 assert.equal(defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url:'https://api.siliconflow.cn/v1'},'unpublished/model'),'separate');
 assert.equal(defaultCacheWriteBilling({wire_protocol:'chat_completions',base_url:'https://other.invalid/v1'},'zai-org/GLM-5.3-Flash'),'separate');
 db.close();
});
test('explicit versioned CNY price estimates complete native usage and uses existing estimated reminder',async()=>{
 const {usage,db,notices}=setup();usage.setPrices([price]);
 const wire={...base,status:'completed' as const,input_tokens:10000000,output_tokens:1000000,cache_read_tokens:2000000,cache_write_tokens:1000000};
 await usage.record(wire);assert.equal(usage.summary('staging','owner').estimated_cny,16.8);assert.equal(notices[0]!.system_event.alert_kind,'estimated');
 assert.match(notices[0]!.text,/估算/);assert.equal(usage.recentAttempts('staging','owner')[0]!.price_version,'synthetic-v1');
 usage.setPrices([{...price,price_version:'synthetic-v2',updated_at:'2026-10-24T00:00:00.000Z',input_per_million:4}]);
 await usage.record(wire);assert.equal(usage.summary('staging','owner').estimated_cny,16.8);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.price_version,'synthetic-v1');
 await usage.record({...wire,attempt_id:'second'});assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.amount,30.8);
 assert.throws(()=>usage.setPrices([{...price,input_per_million:3}]),/USAGE_PRICE_VERSION_CONFLICT/);db.close();
});
test('no explicit price, missing usage or chargeable cache rate stays unknown; input cache accounting is explicit',async()=>{
 const {usage,db}=setup(),complete={...base,input_tokens:100,output_tokens:10,cache_read_tokens:20,cache_write_tokens:5};
 await usage.record(complete);assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');
 usage.setPrices([{...price,cache_read_per_million:null}]);await usage.record({...complete,attempt_id:'missing-rate'});
 assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');
 usage.setPrices([{...price,price_version:'exclusive',updated_at:'2026-10-24T00:00:00.000Z',input_tokens_include_cache:false}]);
 await usage.record({...complete,attempt_id:'exclusive'});assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.amount,0.000226);
 await usage.record(complete);assert.equal(usage.recentAttempts('staging','owner').find(item=>item.attempt_id===base.attempt_id)!.cost.kind,'unknown');
 await usage.record({...complete,attempt_id:'missing-input',input_tokens:null});assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');
 await usage.record({...complete,attempt_id:'missing-cache',cache_read_tokens:null});assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');db.close();
});
test('source-body migration preserves replay and never retrospectively prices old unknown attempts',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE model_usage_attempts(environment TEXT,owner TEXT,attempt_id TEXT,local_date TEXT,
 captured_at TEXT,owner_chat INTEGER,cost_kind TEXT,currency TEXT,amount_micros INTEGER,body TEXT,PRIMARY KEY(environment,owner,attempt_id));`);
 const {canonical}=await import('../src/contracts.ts');
 db.prepare('INSERT INTO model_usage_attempts VALUES(?,?,?,?,?,?,?,?,?,?)').run(base.environment,base.owner,base.attempt_id,'2026-10-23',base.captured_at,0,'unknown','CNY',null,canonical(base));
 const usage=new ModelUsage(db,{now:()=>Date.parse(base.captured_at),notify:async()=>{}});usage.setPrices([price]);await usage.record(base);
 assert.equal(usage.summary('staging','owner').unknown_attempts,1);assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');db.close();
});
test('nonrun auxiliary started pins price before inference; terminal finalizes same row and exact replays stay idempotent',async()=>{
 const {usage,db,notices}=setup();usage.setPrices([price]);
 const source_context={kind:'capture',raw_ref:`l5:${'a'.repeat(64)}`,archive_revision:'b'.repeat(64),principal_id:'owner',device_id:'phone'};
 const started={...base,status:'started',source_context} as unknown as UsageAttempt;
 await usage.record(started);assert.equal(usage.summary('staging','owner').unknown_attempts,1);
 assert.equal(usage.recentAttempts('staging','owner')[0]!.price_version,'synthetic-v1');
 usage.setPrices([{...price,price_version:'synthetic-v2',updated_at:'2026-10-24T00:00:00.000Z',input_per_million:4}]);
 const terminal={...started,status:'completed',input_tokens:10000000,output_tokens:1000000,cache_read_tokens:2000000,cache_write_tokens:1000000} as UsageAttempt;
 await usage.record(terminal);await usage.record(terminal);await usage.record(started);
 assert.equal(usage.summary('staging','owner').attempts,1);assert.equal(usage.summary('staging','owner').estimated_cny,16.8);
 assert.equal(notices.at(-1)!.system_event.alert_kind,'estimated');
 await assert.rejects(usage.record({...terminal,source_context:{...source_context,device_id:'forged'}} as unknown as UsageAttempt),/USAGE_ATTEMPT_CONFLICT/);db.close();
});
test('nonrun terminal without a persisted start refuses; a start without price never reprices at finish',async()=>{
 const {usage,db}=setup(),source_context={kind:'capture',raw_ref:`l5:${'a'.repeat(64)}`,archive_revision:'b'.repeat(64),principal_id:'owner',device_id:'phone'};
 const started={...base,status:'started',source_context} as unknown as UsageAttempt;
 const terminal={...started,status:'completed',input_tokens:100,output_tokens:10,cache_read_tokens:0,cache_write_tokens:0} as UsageAttempt;
 await assert.rejects(usage.record(terminal),/USAGE_STARTED_REQUIRED/);await usage.record(started);usage.setPrices([price]);
 await usage.record(terminal);assert.equal(usage.recentAttempts('staging','owner')[0]!.cost.kind,'unknown');db.close();
});

for(const [zone,date] of [['America/Los_Angeles','2026-10-09'],['UTC','2026-10-10']] as const)
test(`model usage groups budget facts by deployment ${zone}`,async()=>{
  const db=new DatabaseSync(':memory:'),now=Date.parse('2026-10-10T00:30:00Z');
  try{
    const usage=new ModelUsage(db,{time_zone:zone,now:()=>now,notify:async()=>{}});
    await usage.record({...base,captured_at:new Date(now).toISOString()});
    assert.equal(usage.summary('staging','owner').local_date,date);
    assert.equal(usage.summary('staging','owner').attempts,1);
  }finally{db.close();}
});
