import {DEFAULT_TIME_ZONE} from './deployment-time.ts';
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {inTransaction} from './owner-db.ts';
import {canonical} from './contracts.ts';
import type {ModelProvider} from './model-settings-contract.ts';

export type CacheWriteBilling='input'|'separate';
export const MODEL_COST_ESTIMATE_NOTE='按配置标准价估算，不含时段折扣，不是账单。';
const deepseekInputBilling=new Set(['deepseek-flash','deepseek-v4.1-flash','deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp','deepseek-v4-pro','deepseek-chat','deepseek-reasoner']);
const goInputBilling=new Set([...deepseekInputBilling,'glm-5.3-flash','glm-5.3','glm-5.2','kimi-k2.7-code','kimi-k2.6',
  'longcat-2.0','longcat-2.5-preview-free','step-5-preview','mimo-v2.6-flash','mimo-v2.6-pro','mimo-v2.5','mimo-v2.5-pro',
  'minimax-m3.1-flash','minimax-m3','minimax-m2.7','muse-spark-1.3-contributor','muse-spark-1.2-contributor',
  'hy4-preview','hy3','grok-4.7','gemini-4-argon']);
/** Billing defaults, not model routing. Unknown providers/models require reported writes or an explicit price policy.
 * https://api-docs.deepseek.com/quick_start/pricing/ (input cache hit/miss; no separate write charge)
 * https://opencode.ai/docs/go/ (only models whose Cached Write column is "-")
 * https://cloud-rd.siliconflow.cn/pricing (GLM-5.3-Flash: input/cache-hit/output; no separate write charge) */
export function defaultCacheWriteBilling(provider:Pick<ModelProvider,'base_url'|'wire_protocol'>,model:string):CacheWriteBilling {
  if(provider.wire_protocol==='local_onnx')return 'separate';
  const host=new URL(provider.base_url).hostname;
  if((host==='api.deepseek.com'||host==='amr-link.open-design.ai')&&deepseekInputBilling.has(model)||
      host==='opencode.ai'&&goInputBilling.has(model)||
      host==='api.siliconflow.cn'&&model==='zai-org/GLM-5.3-Flash')return 'input';
  return 'separate';
}

export interface UsageAttempt {
  attempt_id:string;request_id:string;environment:string;owner:string;provider_id:string;model_id:string;
  role:string;revision:string;owner_chat:boolean;captured_at:string;status:'started'|'completed'|'failed'|'cancelled';
  input_tokens:number|null;output_tokens:number|null;
  cost:{kind:'known'|'estimated'|'unknown';amount:number|null;currency:string};
  fallback_reason?:string;
  cache_read_tokens?:number|null;cache_write_tokens?:number|null;reasoning_tokens?:number|null;
  credential_version?:number;price_version?:string;account_ref?:string;
  original_usage?:Record<string,number>;source_context?:ModelUsageSource;
}
export type ModelUsageSource={kind:'capture';raw_ref:string;archive_revision:string;principal_id:string;device_id:string}
  |{kind:'call';raw_ref:string;archive_revision:string;principal_id:string;device_id:string;call_id:string;continuity:string}
  |{kind:'run';run_id:string;session_id:string;principal_id:string;processed_event_id:string}
  |{kind:'settings_probe';draft_id:string;change_sha256:string;principal_id:string;device_id:string};
const measurementFields=new Set(['status','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','cost','original_usage','fallback_reason','price_version']);
const attemptScope=(attempt:UsageAttempt)=>canonical(Object.fromEntries(Object.entries(attempt).filter(([field])=>!measurementFields.has(field))));
export interface ModelPriceFact {
  environment:string;provider_id:string;model_id:string;currency:string;price_version:string;source:string;updated_at:string;
  input_per_million:number;output_per_million:number;cache_read_per_million:number|null;cache_write_per_million:number|null;
  input_tokens_include_cache:boolean;
  cache_write_billing?:CacheWriteBilling;
}
export interface BudgetNotice {
  principal_id:string;id:string;text:string;captured_at:string;
  system_event:{type:'budget_alert';environment:string;local_date:string;threshold_version:1;
    alert_kind:'known'|'estimated';known_cny:number;estimated_cny:number;unknown_attempts:number;threshold_cny:10};
}
export interface ModelWireAttempt extends Omit<UsageAttempt,'owner'|'owner_chat'|'revision'> {
  revision:number;profile:string;run_id:string;session_id:string;base_url:string;
}
interface Policy {enabled:number;paused_at:string|null;resumed_day:string|null;reserve_start_seq:number;reserve_micros:number}
const micro=(amount:number)=>Math.round(amount*1_000_000);

/** Attempt facts and budget decisions share the model settings authority's database. */
export class ModelUsage {
  private readonly db:DatabaseSync;
  private readonly now:()=>number;
  private readonly notify:(notice:BudgetNotice)=>Promise<void>;
  private readonly resumeWork:()=>void;
  private readonly day:(at:number)=>string;
  constructor(db:DatabaseSync,options:{time_zone?:string;now?:()=>number;notify:(notice:BudgetNotice)=>Promise<void>;resumeWork?:()=>void}) {
    const clock=new Intl.DateTimeFormat('en-CA',{timeZone:options.time_zone??DEFAULT_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
    this.day=at=>clock.format(at);
    this.db=db;this.now=options.now??Date.now;this.notify=options.notify;this.resumeWork=options.resumeWork??(()=>{});
    db.exec(`CREATE TABLE IF NOT EXISTS model_usage_attempts (
      environment TEXT NOT NULL,owner TEXT NOT NULL,attempt_id TEXT NOT NULL,local_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,owner_chat INTEGER NOT NULL,cost_kind TEXT NOT NULL,currency TEXT NOT NULL,
      amount_micros INTEGER,body TEXT NOT NULL,source_body TEXT NOT NULL,PRIMARY KEY(environment,owner,attempt_id));
      CREATE TABLE IF NOT EXISTS model_usage_policy (
      environment TEXT NOT NULL,owner TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
      paused_at TEXT,resumed_day TEXT,reserve_start_seq INTEGER NOT NULL DEFAULT 0,
      reserve_micros INTEGER NOT NULL DEFAULT 1000000 CHECK(reserve_micros>=1000000),PRIMARY KEY(environment,owner));
      CREATE TABLE IF NOT EXISTS model_budget_facts (
      environment TEXT NOT NULL,owner TEXT NOT NULL,local_date TEXT NOT NULL,alert_kind TEXT NOT NULL,
      body TEXT NOT NULL,PRIMARY KEY(environment,owner,local_date,alert_kind));
      CREATE TABLE IF NOT EXISTS model_usage_prices (
      environment TEXT NOT NULL,provider_id TEXT NOT NULL,model_id TEXT NOT NULL,currency TEXT NOT NULL,
      price_version TEXT NOT NULL,updated_at TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(environment,provider_id,model_id,currency,price_version));`);
    if(!(db.prepare('PRAGMA table_info(model_usage_attempts)').all() as {name:string}[]).some(column=>column.name==='source_body'))
      inTransaction(db,()=>{db.exec('ALTER TABLE model_usage_attempts ADD COLUMN source_body TEXT;UPDATE model_usage_attempts SET source_body=body');});
    if(!(db.prepare('PRAGMA table_info(model_usage_policy)').all() as {name:string}[]).some(column=>column.name==='reserve_micros'))
      db.exec('ALTER TABLE model_usage_policy ADD COLUMN reserve_micros INTEGER NOT NULL DEFAULT 1000000 CHECK(reserve_micros>=1000000)');
  }
  setPrices(prices:ModelPriceFact[]):void {
    if(!Array.isArray(prices))throw Error('USAGE_PRICE_INVALID');
    inTransaction(this.db,()=>{for(const price of prices){
      if(!price||['environment','provider_id','model_id','currency','price_version','source'].some(field=>typeof price[field as keyof ModelPriceFact]!=='string'||!price[field as keyof ModelPriceFact])||
        !Number.isFinite(Date.parse(price.updated_at))||new Date(price.updated_at).toISOString()!==price.updated_at||typeof price.input_tokens_include_cache!=='boolean'||
        price.cache_write_billing!==undefined&&!['input','separate'].includes(price.cache_write_billing))throw Error('USAGE_PRICE_INVALID');
      for(const field of ['input_per_million','output_per_million','cache_read_per_million','cache_write_per_million'] as const)
        if((price[field]===null?field==='input_per_million'||field==='output_per_million':typeof price[field]!=='number'||!Number.isFinite(price[field])||price[field]!<0))throw Error('USAGE_PRICE_INVALID');
      const scope=[price.environment,price.provider_id,price.model_id,price.currency,price.price_version],body=canonical(price);
      const old=this.db.prepare('SELECT body FROM model_usage_prices WHERE environment=? AND provider_id=? AND model_id=? AND currency=? AND price_version=?').get(...scope) as {body:string}|undefined;
      if(old&&old.body!==body)throw Error('USAGE_PRICE_VERSION_CONFLICT');
      if(!old)this.db.prepare('INSERT INTO model_usage_prices VALUES(?,?,?,?,?,?,?)').run(...scope,price.updated_at,body);
    }});
  }
  private price(attempt:UsageAttempt,version?:string):ModelPriceFact|undefined {
    const row=this.db.prepare("SELECT body FROM model_usage_prices WHERE environment=? AND provider_id=? AND model_id=? AND currency='CNY'"+
      (version===undefined?' ORDER BY updated_at DESC,rowid DESC LIMIT 1':' AND price_version=?'))
      .get(attempt.environment,attempt.provider_id,attempt.model_id,...(version===undefined?[]:[version])) as {body:string}|undefined;
    return row?JSON.parse(row.body) as ModelPriceFact:undefined;
  }
  private priced(attempt:UsageAttempt,version:string|null|undefined,billing:CacheWriteBilling):UsageAttempt {
    if(attempt.cost.kind!=='unknown'||attempt.cost.currency!=='CNY'||attempt.input_tokens===null||attempt.output_tokens===null||
      attempt.cache_read_tokens==null||version===null)return attempt;
    const price=this.price(attempt,version);
    if(!price)return attempt;
    const read=attempt.cache_read_tokens,write=attempt.cache_write_tokens??((price.cache_write_billing??billing)==='input'?0:null);
    if(write===null)return attempt;
    if(read>0&&price.cache_read_per_million===null||write>0&&price.cache_write_per_million===null)return attempt;
    const input=attempt.input_tokens-(price.input_tokens_include_cache?read+write:0);if(input<0)return attempt;
    const amount=(input*price.input_per_million+attempt.output_tokens*price.output_per_million+
      read*(price.cache_read_per_million??0)+write*(price.cache_write_per_million??0))/1_000_000;
    if(!Number.isSafeInteger(micro(amount)))throw Error('USAGE_COST_INVALID');
    return {...attempt,cache_write_tokens:write,price_version:price.price_version,cost:{kind:'estimated',amount:micro(amount)/1_000_000,currency:'CNY'}};
  }
  async record(attempt:UsageAttempt,billing:CacheWriteBilling='separate'):Promise<void> {
    const {cost}=attempt;
    if(!Number.isFinite(Date.parse(attempt.captured_at))||!attempt.attempt_id||!attempt.environment||!attempt.owner)
      throw Error('USAGE_ATTEMPT_INVALID');
    if(!['known','estimated','unknown'].includes(cost.kind)||!cost.currency||
      (cost.kind==='unknown'?cost.amount!==null:typeof cost.amount!=='number'||!Number.isFinite(cost.amount)||cost.amount<0||!Number.isSafeInteger(micro(cost.amount))))
      throw Error('USAGE_COST_INVALID');
    for(const tokens of [attempt.input_tokens,attempt.output_tokens,attempt.cache_read_tokens??null,attempt.cache_write_tokens??null,attempt.reasoning_tokens??null])
      if(tokens!==null&&(!Number.isSafeInteger(tokens)||tokens<0))throw Error('USAGE_TOKENS_INVALID');
    if(!['started','completed','failed','cancelled'].includes(attempt.status)||attempt.status==='started'&&(!attempt.source_context||attempt.input_tokens!==null||attempt.output_tokens!==null||cost.kind!=='unknown'))throw Error('USAGE_ATTEMPT_INVALID');
    const sourceBody=canonical(attempt),existing=this.db.prepare('SELECT body,source_body FROM model_usage_attempts WHERE environment=? AND owner=? AND attempt_id=?')
      .get(attempt.environment,attempt.owner,attempt.attempt_id) as {body:string;source_body:string}|undefined;
    if(existing&&existing.source_body!==sourceBody){
      const saved=JSON.parse(existing.body) as UsageAttempt;
      if(!attempt.source_context||attemptScope(saved)!==attemptScope(attempt))throw Error('USAGE_ATTEMPT_CONFLICT');
      if(attempt.status!=='started'){
        if(saved.status!=='started')throw Error('USAGE_ATTEMPT_CONFLICT');
        const fact=this.priced(attempt,saved.price_version??null,billing);
        this.db.prepare('UPDATE model_usage_attempts SET cost_kind=?,currency=?,amount_micros=?,body=?,source_body=? WHERE environment=? AND owner=? AND attempt_id=?')
          .run(fact.cost.kind,fact.cost.currency,fact.cost.amount===null?null:micro(fact.cost.amount),canonical(fact),sourceBody,fact.environment,fact.owner,fact.attempt_id);
      }
    }
    if(!existing){
      if(attempt.source_context&&attempt.status!=='started')throw Error('USAGE_STARTED_REQUIRED');
      const price=attempt.status==='started'?this.price(attempt):undefined;
      const fact=attempt.status==='started'?{...attempt,...(price?{price_version:price.price_version}:{})}:this.priced(attempt,undefined,billing);
      this.db.prepare('INSERT INTO model_usage_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(fact.environment,fact.owner,
        fact.attempt_id,this.day(Date.parse(fact.captured_at)),fact.captured_at,Number(fact.owner_chat),fact.cost.kind,fact.cost.currency,
        fact.cost.amount===null?null:micro(fact.cost.amount),canonical(fact),sourceBody);
    }
    if(attempt.status!=='started')await this.checkBudget(attempt.environment,attempt.owner);
  }
  sourceAttempt(environment:string,owner:string,id:string):UsageAttempt|undefined {
    const row=this.db.prepare('SELECT body FROM model_usage_attempts WHERE environment=? AND owner=? AND attempt_id=?').get(environment,owner,id) as {body:string}|undefined;
    return row?JSON.parse(row.body) as UsageAttempt:undefined;
  }
  summary(environment:string,owner:string) {
    const local_date=this.day(this.now());
    const totals=this.db.prepare(`SELECT COUNT(*) attempts,
      COALESCE(SUM(CASE WHEN cost_kind='known' AND currency='CNY' THEN amount_micros ELSE 0 END),0) known,
      COALESCE(SUM(CASE WHEN cost_kind='estimated' AND currency='CNY' THEN amount_micros ELSE 0 END),0) estimated,
      COALESCE(SUM(CASE WHEN cost_kind='unknown' THEN 1 ELSE 0 END),0) unknown_attempts,
      COALESCE(SUM(CASE WHEN currency!='CNY' THEN 1 ELSE 0 END),0) foreign_currency_attempts
      FROM model_usage_attempts WHERE environment=? AND owner=? AND local_date=?`).get(environment,owner,local_date) as
      {attempts:number;known:number;estimated:number;unknown_attempts:number;foreign_currency_attempts:number};
    const policy=this.policy(environment,owner);
    return {environment,owner,local_date,attempts:totals.attempts,known_cny:totals.known/1_000_000,
      estimated_cny:totals.estimated/1_000_000,estimate_note:MODEL_COST_ESTIMATE_NOTE,unknown_attempts:totals.unknown_attempts,
      foreign_currency_attempts:totals.foreign_currency_attempts,subscription_remaining:'套餐余量未知',threshold_cny:10,
      pause_on_limit:!!policy.enabled,paused:!!policy.paused_at,
      owner_reserve_cny:policy.reserve_micros/1_000_000,resumed_local_date:policy.resumed_day};
  }
  recentAttempts(environment:string,owner:string):UsageAttempt[] {
    return (this.db.prepare('SELECT body FROM model_usage_attempts WHERE environment=? AND owner=? ORDER BY rowid DESC LIMIT 20')
      .all(environment,owner) as {body:string}[]).map(row=>JSON.parse(row.body) as UsageAttempt);
  }
  async recover(environment:string):Promise<void> {
    const owners=this.db.prepare('SELECT DISTINCT owner FROM model_usage_attempts WHERE environment=?').all(environment) as {owner:string}[];
    for(const {owner} of owners)await this.checkBudget(environment,owner);
  }
  private policy(environment:string,owner:string):Policy {
    const policy=this.db.prepare('SELECT enabled,paused_at,resumed_day,reserve_start_seq,reserve_micros FROM model_usage_policy WHERE environment=? AND owner=?')
      .get(environment,owner) as unknown as Policy??{enabled:0,paused_at:null,resumed_day:null,reserve_start_seq:0,reserve_micros:1_000_000};
    if(policy.paused_at&&this.day(Date.parse(policy.paused_at))!==this.day(this.now())){
      this.db.prepare('UPDATE model_usage_policy SET paused_at=NULL WHERE environment=? AND owner=?').run(environment,owner);
      policy.paused_at=null;this.resumeWork();
    }
    return policy;
  }
  setPausePolicy(environment:string,owner:string,enabled:boolean,reserve=this.policy(environment,owner).reserve_micros/1_000_000):void {
    if(!Number.isFinite(reserve)||reserve<1||!Number.isSafeInteger(micro(reserve)))throw Error('MODEL_SETTINGS_RESERVE_INVALID');
    this.db.prepare(`INSERT INTO model_usage_policy(environment,owner,enabled,reserve_micros) VALUES (?,?,?,?)
      ON CONFLICT(environment,owner) DO UPDATE SET enabled=excluded.enabled,reserve_micros=excluded.reserve_micros`).run(environment,owner,Number(enabled),micro(reserve));
    if(!enabled){
      this.db.prepare('UPDATE model_usage_policy SET paused_at=NULL WHERE environment=? AND owner=?').run(environment,owner);this.resumeWork();
    }else if(this.policy(environment,owner).resumed_day!==this.day(this.now())&&this.summary(environment,owner).known_cny>10)this.pause(environment,owner);
  }
  pause(environment:string,owner:string):void {
    const {seq}=this.db.prepare('SELECT COALESCE(MAX(rowid),0) seq FROM model_usage_attempts').get() as {seq:number};
    this.db.prepare(`INSERT INTO model_usage_policy(environment,owner,enabled,paused_at,reserve_start_seq) VALUES (?,?,1,?,?)
      ON CONFLICT(environment,owner) DO UPDATE SET enabled=1,
      reserve_start_seq=CASE WHEN paused_at IS NULL THEN excluded.reserve_start_seq ELSE reserve_start_seq END,
      paused_at=COALESCE(paused_at,excluded.paused_at)`)
      .run(environment,owner,new Date(this.now()).toISOString(),seq);
  }
  resume(environment:string,owner:string):void {
    this.db.prepare(`INSERT INTO model_usage_policy(environment,owner,resumed_day) VALUES (?,?,?)
      ON CONFLICT(environment,owner) DO UPDATE SET paused_at=NULL,resumed_day=excluded.resumed_day`)
      .run(environment,owner,this.day(this.now()));
    this.resumeWork();
  }
  admission(environment:string,owner:string,ownerChat:boolean):{allowed:boolean;reserve_remaining_cny:number;reason?:'budget_paused'|'owner_reserve_exhausted'} {
    const policy=this.policy(environment,owner);
    if(!policy.paused_at)return {allowed:true,reserve_remaining_cny:policy.reserve_micros/1_000_000};
    const {spent}=this.db.prepare(`SELECT COALESCE(SUM(amount_micros),0) spent FROM model_usage_attempts
      WHERE environment=? AND owner=? AND local_date=? AND owner_chat=1 AND rowid>?
      AND currency='CNY' AND cost_kind!='unknown'`).get(environment,owner,this.day(this.now()),policy.reserve_start_seq) as {spent:number};
    const remaining=Math.max(0,(policy.reserve_micros-spent)/1_000_000);
    return {allowed:ownerChat&&remaining>0,reserve_remaining_cny:remaining,
      ...(!ownerChat?{reason:'budget_paused' as const}:remaining===0?{reason:'owner_reserve_exhausted' as const}:{})};
  }
  async checkBudget(environment:string,owner:string):Promise<void> {
    const facts=this.summary(environment,owner),policy=this.policy(environment,owner);
    const kind=facts.known_cny>10?'known':facts.known_cny+facts.estimated_cny>10?'estimated':undefined;
    if(!kind)return;
    if(policy.enabled&&facts.known_cny>10&&policy.resumed_day!==facts.local_date)this.pause(environment,owner);
    const existing=this.db.prepare('SELECT body FROM model_budget_facts WHERE environment=? AND owner=? AND local_date=? AND alert_kind=?')
      .get(environment,owner,facts.local_date,kind) as {body:string}|undefined;
    let notice:BudgetNotice;
    if(existing)notice=JSON.parse(existing.body) as BudgetNotice;
    else {
      const scope=createHash('sha256').update(JSON.stringify([environment,owner])).digest('hex').slice(0,32);
      notice={principal_id:owner,id:`budget:${scope}:${facts.local_date}:1:${kind}`,captured_at:new Date(this.now()).toISOString(),
        text:kind==='known'?`今天已知消费 ${facts.known_cny.toFixed(2)} 元，超过你设的 10 元。`:
          `今天模型消费估算 ${(facts.known_cny+facts.estimated_cny).toFixed(2)} 元（其中已知 ${facts.known_cny.toFixed(2)} 元），超过你设的 10 元。`,
        system_event:{type:'budget_alert',environment,local_date:facts.local_date,threshold_version:1,alert_kind:kind,
          known_cny:facts.known_cny,estimated_cny:facts.estimated_cny,unknown_attempts:facts.unknown_attempts,threshold_cny:10}};
      notice.text+=' OpenCode 套餐余量未知。';
      if(kind==='estimated')notice.text+=' '+MODEL_COST_ESTIMATE_NOTE;
      if(facts.unknown_attempts)notice.text+=` 另有 ${facts.unknown_attempts} 次调用费用未知。`;
      this.db.prepare('INSERT INTO model_budget_facts VALUES (?,?,?,?,?)').run(environment,owner,facts.local_date,kind,JSON.stringify(notice));
    }
    // Existing system_event delivery owns outbox/retry and deduplicates this stable fact identity.
    await this.notify(notice);
  }
}
