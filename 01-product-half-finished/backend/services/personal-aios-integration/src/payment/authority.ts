import {DEFAULT_TIME_ZONE} from '../deployment-time.ts';
import {randomUUID} from 'node:crypto';
import {canonical,check,ContractError,id,inactiveSource,principalAttribution,utc,sha256,type ProcessedEvent} from '../contracts.ts';
import {hasTerminalCapability,type RegisteredDevice} from '../source-authority.ts';
import {TerminalCards,type TerminalWearSession} from '../terminal-cards.ts';
import {PaymentStore,payeeKey} from './store.ts';
import {parsePaymentConfig,effectiveLimits,localDayBounds} from './config.ts';
import {decideAuto,decideCard,decideSettings,decideVoice,decideVoiceResult,type Decision,type DecisionFacts,type VoiceFacts} from './decide.ts';
import {PaymentKeys,paymentNonce,type VerifiedStatement,type ChallengePurpose} from './keys.ts';
import {PaymentLeases,type GrantKind} from './leases.ts';
import {TERMINAL_STATES,type Payment,type PaymentConfig,type PaymentGrant,type PaymentIntent,type Initiating,type PaymentPorts,
  type Checkpoint,type PaymentProjection,type PaymentVoiceVerifier,type UtteranceRef,type VoiceVerdict,type SignedInput,type SettingsChange} from './contracts.ts';
import {cardProjection,noticeProjection,recordProjection,recordsProjection,settingsProjection} from './projection.ts';
import {PAYMENT_LIVE_LIMIT} from './wire-budget.ts';
import {DEVICE_CLOCK_LEAD_MS} from '../../../realtime-core/src/types.ts';

const APPS=['千问','淘宝','美团','饿了么','滴滴','高德','支付宝','微信'];
const beforeTap=(p:Payment)=>!TERMINAL_STATES.includes(p.state)&&p.state!=='paying';
const safeCode=(e:unknown)=>e instanceof ContractError?e.code:'PAYMENT_INTERNAL_ERROR';
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&Array.from(v).length<=max;
const fen=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=100000000;
const screen=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const unavailable=(u:UtteranceRef):VoiceVerdict=>({verdict:'unavailable',reason:'engine_unavailable',initiating:{score:null,speech_ms:0},channel:u.device_type==='glasses'?'glasses':'phone_app',speaker_model:'unavailable'});
type Request=Pick<PaymentIntent,'principal_id'|'run_id'|'tool_call_id'|'session_id'|'processed_event_id'|'initiating'|'initiating_text'|'purpose'|'app'|'budget_fen'>;
type OpenOptions={time_zone?:string;config?:PaymentConfig;now?:()=>number;verifier?:PaymentVoiceVerifier;terminals?:TerminalCards;owner_override_active?:()=>Promise<boolean>};
type OwnerEnrollment=Awaited<ReturnType<PaymentPorts['owner']>>;
export interface PaymentInputBinding {connection:object|undefined;wear:TerminalWearSession|undefined}
type PaymentWatcher={source:RegisteredDevice;deliver:(p:PaymentProjection)=>Promise<void>;session_id?:string|undefined;
  dirty:boolean;ownerEvidence:boolean;flight?:Promise<void>|undefined;retry_at?:number|undefined};

/** One payment authority: SQLite owns state, decide.ts alone authorizes, and one timer owns every deadline. */
export class PaymentAuthority {
  readonly store:PaymentStore;readonly config:PaymentConfig;readonly keys:PaymentKeys;leases:PaymentLeases;
  private readonly time_zone:string;
  private terminals:TerminalCards;private readonly now:()=>number;private verifier:PaymentVoiceVerifier|undefined;
  private readonly ownerOverrideActive:()=>Promise<boolean>;
  private ports:PaymentPorts|undefined;private timer:ReturnType<typeof setTimeout>|undefined;private closed=false;
  private readonly sources=new Map<string,RegisteredDevice>();
  private readonly watchers=new Set<PaymentWatcher>();
  private readonly polls=new Map<string,Set<()=>void>>();private readonly payWindows=new Map<string,()=>void>();
  private readonly utterances=new Map<string,number>();private readonly verifying=new Map<string,AbortController>();
  private flushing:Promise<void>|undefined;private ticking:Promise<void>|undefined;private checking=false;private readonly changes=new Set<string>();
  private constructor(store:PaymentStore,options:OpenOptions){
    this.time_zone=options.time_zone??DEFAULT_TIME_ZONE;
    this.store=store;this.config=parsePaymentConfig(options.config);this.now=options.now??Date.now;this.verifier=options.verifier;
    this.ownerOverrideActive=options.owner_override_active??(async()=>false);
    this.terminals=options.terminals??new TerminalCards(this.now);
    this.keys=new PaymentKeys({store,challenge_ttl_s:this.config.challenge_ttl_s,revalidate:s=>this.active(s),now:this.now});
    this.leases=this.makeLeases();this.recover();
  }
  static open(directory:string,options:OpenOptions={}):PaymentAuthority{return new PaymentAuthority(PaymentStore.open(directory),options);}
  private makeLeases():PaymentLeases{return new PaymentLeases({store:this.store,keys:this.keys,terminals:this.terminals,config:this.config,
    revalidate:s=>this.active(s),lock:s=>this.store.locks(s.principal_id).find(l=>l.device_id===s.device_id),now:this.now});}
  bindVerifier(verifier:PaymentVoiceVerifier):void {check(!this.ports&&!this.verifier&&!this.closed,'PAYMENT_ALREADY_ATTACHED',409);this.verifier=verifier;}
  setTerminals(terminals:TerminalCards):void {check(!this.ports,'PAYMENT_ALREADY_ATTACHED',409);this.terminals=terminals;this.leases=this.makeLeases();}
  attach(ports:PaymentPorts):void {check(!this.ports&&!this.closed,'PAYMENT_ALREADY_ATTACHED',409);this.ports=ports;this.arm();
    void this.flushUpdates().catch(e=>console.error('PAYMENT_UPDATE_FAILED',safeCode(e)));}
  close():void {this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    for(const cancel of this.payWindows.values())cancel();this.payWindows.clear();for(const v of this.verifying.values())v.abort();this.verifying.clear();
    for(const callbacks of this.polls.values())for(const wake of callbacks)wake();this.polls.clear();this.leases.clear();this.keys.clear();this.watchers.clear();this.store.close();}
  private remember(s:RegisteredDevice):void {this.sources.set(JSON.stringify([s.principal_id,s.device_id]),s);}
  private async active(s:RegisteredDevice):Promise<RegisteredDevice>{
    check(this.ports&&!this.closed,'PAYMENT_AUTHORITY_UNAVAILABLE',503);
    try{const current=await this.ports.revalidate(s);this.remember(current);return current;}
    catch(error){this.sourceRejected(s,error);throw error;}
  }
  /** Transport expiry ends ephemeral authorization. Only the pairing authority can revoke durable keys. */
  sourceRejected(s:RegisteredDevice,error:unknown):void{
    if(this.closed||!inactiveSource(error))return;
    const revoked=typeof error==='object'&&error!==null&&'code' in error&&error.code==='PAIRED_DEVICE_REVOKED';
    if(revoked)this.store.tx(()=>{
      const rows=this.store.db.prepare('SELECT role,public_x963_b64 FROM device_keys WHERE device_id=? AND principal_id=? AND revoked_at_ms IS NULL').all(s.device_id,s.principal_id) as {role:string;public_x963_b64:string}[];
      this.store.db.prepare('UPDATE device_keys SET revoked_at_ms=? WHERE device_id=? AND principal_id=? AND revoked_at_ms IS NULL').run(this.now(),s.device_id,s.principal_id);
      this.store.db.prepare('DELETE FROM locks WHERE device_id=? AND principal_id=?').run(s.device_id,s.principal_id);
      for(const row of rows)this.audit(s.principal_id,'keys_revoked',{device_id:s.device_id,role:row.role,key_sha256:sha256(Buffer.from(row.public_x963_b64,'base64'))},undefined,'system',s.device_id);
      this.cascadeTx(s.principal_id,'device_revoked');
    });
    this.leases.clear(s,revoked?'revoked':'source_inactive');this.keys.clear(s);this.sources.delete(JSON.stringify([s.principal_id,s.device_id]));
    for(const watcher of this.watchers)if(watcher.source.principal_id===s.principal_id&&watcher.source.device_id===s.device_id)this.watchers.delete(watcher);
    const window=s.principal_id+'\n'+s.device_id;this.payWindows.get(window)?.();this.payWindows.delete(window);
    this.arm();
    if(revoked)void this.after(s.principal_id).catch(e=>console.error('PAYMENT_REVOCATION_UPDATE_FAILED',safeCode(e)));
  }
  private audit(principal:string,kind:string,data:Record<string,unknown>,p?:Payment,actor='authority',device?:string,intent?:string):void{
    this.store.event({at_ms:this.now(),principal_id:principal,kind,data,actor,...(p?{payment_id:p.payment_id,intent_id:p.intent_id}:intent?{intent_id:intent}:{}),...(device?{device_id:device}:{})});
  }
  private update(p:Payment,patch:Partial<Payment>):Payment{
    this.store.updatePayment(p.payment_id,{...patch,version:p.version+1});return this.store.getPayment(p.payment_id)!;
  }
  private terminal(p:Payment,state:Payment['state'],reason:string|null,cancel:Payment['order_cancel']):Payment{
    const done=this.update(p,{state,reason,order_cancel:cancel,finished_at_ms:this.now(),auto_at_ms:null});
    this.audit(p.principal_id,'card_closed',{state,...(reason?{reason}:{})},done);this.enqueueContext(done);
    if(state!=='superseded')this.store.updateIntent(p.intent_id,{state:'closed',closed_reason:reason??state});return done;
  }
  private recover():void{
    const environment=this.store.db.prepare("SELECT value FROM meta WHERE key='environment'").get() as {value:string}|undefined;
    const quarantine=this.config.staging&&environment?.value!=='staging';
    this.store.tx(()=>{
      for(const row of this.store.db.prepare("SELECT intent_id FROM intents WHERE state<>'closed'").all() as {intent_id:string}[]){
        const i=this.store.getIntent(row.intent_id)!;
        if(quarantine)this.store.updateIntent(i.intent_id,{state:'closed',closed_reason:'STAGING_SNAPSHOT'});
        else if(i.state==='open'&&i.expires_at_ms<=this.now())this.store.updateIntent(i.intent_id,{state:'closed',closed_reason:'expired'});
        for(const p of this.store.payments(i.intent_id))if(!TERMINAL_STATES.includes(p.state)){
          if(quarantine)this.terminal(p,'failed','STAGING_SNAPSHOT','not_attempted');
          else if(p.state==='auto_pending'){const next=this.update(p,{state:'awaiting_owner',auto_at_ms:null,reason:'AUTO_INTERRUPTED'});this.audit(i.principal_id,'auto_reverted',{reason:'AUTO_INTERRUPTED'},next);}
          else if(p.state==='verifying'){const next=this.update(p,{state:'awaiting_owner'});this.audit(i.principal_id,'decision_rejected',{decision:'pay',method:'voice',device_id:i.initiating.device_id,error_code:'VOICE_INTERRUPTED'},next);}
        }
      }
      // Staging snapshots must never replay production notices or update outbox work.
      if(quarantine)this.store.db.prepare("DELETE FROM meta WHERE key LIKE 'payment-update:%' OR key LIKE 'payment-context:%'").run();
      this.store.db.prepare("INSERT INTO meta(key,value) VALUES('environment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.config.staging?'staging':'production');
    });
  }
  private lockFacts(principal:string,devices:RegisteredDevice[]):{locks_ok:boolean;phone_lock:boolean}{
    const locks=this.store.locks(principal),phone_lock=locks.some(l=>l.device_type==='phone'&&l.enabled),glasses=devices.filter(d=>d.principal_id===principal&&d.device_type==='glasses');
    return {phone_lock,locks_ok:phone_lock&&(glasses.some(d=>locks.some(l=>l.device_id===d.device_id&&l.device_type==='glasses'&&l.enabled))||!glasses.length&&!this.config.locks.require_glasses_lock)};
  }
  private async ownerCurrent(principal:string):Promise<OwnerEnrollment>{
    const owner=await this.ports!.owner(principal);if(!owner.live)await this.cascade(principal,'voiceprint_unavailable');
    return owner;
  }
  private enrolled(owner:OwnerEnrollment,...terminals:string[]):boolean{
    return owner.live&&terminals.every(type=>type==='phone'?owner.phone_app:type==='glasses'&&owner.glasses);
  }
  private async lease(device:string,principal:string):Promise<boolean>{
    const source=this.sources.get(JSON.stringify([principal,device]));if(!source)return false;
    try{return await this.leases.valid(source);}
    catch(error){
      // An absent terminal cannot authorize voice/auto, but it must not prevent an owner card from opening.
      if(inactiveSource(error))return false;
      throw error;
    }
  }
  private leaseNow(device:string,principal:string):boolean{
    const source=this.sources.get(JSON.stringify([principal,device]));return !!source&&this.leases.validNow(source);
  }
  private facts(p:Payment,i:PaymentIntent,lease_now:boolean,devices:RegisteredDevice[]):DecisionFacts{
    const policy=this.store.policy(p.principal_id);return {principal_id:p.principal_id,now:this.now(),payment:p,intent:i,policy,config:this.config,
      ...this.lockFacts(p.principal_id,devices),lease_now,known_payee:this.store.knownPayee(p.principal_id,p.payee_key),limits:effectiveLimits(policy,this.config)};
  }
  private requireDecision(d:Decision):void{if(d.kind==='reject'){const error=new ContractError(d.code,d.status);if(d.missing)Object.assign(error,{missing:d.missing});throw error;}}
  async initiating(source:RegisteredDevice,d:ProcessedEvent):Promise<Initiating>{
    await this.active(source);const c=d.content as Record<string,unknown>,app=c.app_event as Record<string,unknown>|undefined;
    const kind=principalAttribution(d),voice=(d.processing as {path_id?:string}).path_id==='voice_frontend'||['speech_candidate','wake_turn'].includes(String((d.processing as Record<string,unknown>).segment_basis));
    const result:Initiating={kind:kind==='owner_confirmation'?'confirmation':kind==='explicit_text'?'text':'other_voice',device_id:source.device_id,device_type:source.device_type,captured_at_ms:Date.parse(d.captured_at),lease_at_capture:false};
    const call=app?.kind==='voice_turn'?app.audio as {raw_ref:string;archive_revision?:string;start_ms:number;end_ms:number}|undefined:undefined;
    const range=d.time_range;
    if((source.device_type==='phone'||source.device_type==='glasses')&&(voice||kind==='owner_voice'||call)){
      let span:Pick<UtteranceRef,'raw_ref'|'archive_revision'|'start_ms'|'end_ms'>|undefined;
      if(app?.kind==='voice_turn')span=call?(call.raw_ref===d.raw_ref?{...call,archive_revision:d.archive_revision}:call.archive_revision?call:undefined):undefined;
      else if(range.kind==='interval'&&range.timebase_id==='utc_epoch_ms')span={raw_ref:d.raw_ref,archive_revision:d.archive_revision,start_ms:range.start_ms,end_ms:range.end_ms};
      if(span){result.kind='voice';result.utterance={device_id:source.device_id,device_type:source.device_type,...span,captured_at:d.captured_at,processed_event_id:d.processed_event_id};
        const transcript=String(c.transcript??(c.wake_request as {text?:unknown}|undefined)?.text??app?.user??'');if(transcript)result.utterance.transcript=transcript;
        result.lease_at_capture=await this.leases.valid(source,result.captured_at_ms);}
    }
    return result;
  }
  async request(input:Request,eligible:boolean):Promise<Record<string,unknown>>{
    const reject=(code:string)=>{this.store.tx(()=>this.audit(input.principal_id,'intent_refused',{run_id:input.run_id,processed_event_id:input.processed_event_id,initiating_kind:input.initiating.kind,purpose:input.purpose,app:input.app,...(input.budget_fen!==null?{budget_fen:input.budget_fen}:{}),error_code:code},undefined,'model'));return {status:'rejected',error_code:code};};
    if(!this.config.enabled)return reject('PAYMENT_DISABLED');if(!eligible)return reject('PAYMENT_SOURCE_NOT_OWNER');
    id(input.run_id);id(input.tool_call_id);id(input.session_id);id(input.processed_event_id);id(input.principal_id);
    check(text(input.purpose,80),'PAYMENT_SOURCE_NOT_OWNER',400);
    if(!APPS.includes(input.app))return reject('PAYMENT_APP_INVALID');if(input.budget_fen!==null&&!fen(input.budget_fen))return reject('PAYMENT_BUDGET_INVALID');
    const old=this.store.db.prepare('SELECT intent_id FROM intents WHERE run_id=? AND tool_call_id=?').get(input.run_id,input.tool_call_id) as {intent_id:string}|undefined;
    let intent:PaymentIntent;
    if(old){intent=this.store.getIntent(old.intent_id)!;check(intent.principal_id===input.principal_id,'PAYMENT_INTENT_SCOPE_DENIED',403);}
    else{
      intent={...input,intent_id:`pi-${randomUUID()}`,created_at_ms:this.now(),expires_at_ms:this.now()+this.config.intent_ttl_s*1000,state:'open',closed_reason:null};
      this.store.tx(()=>{this.store.insertIntent(intent);this.audit(intent.principal_id,'intent_requested',{run_id:intent.run_id,processed_event_id:intent.processed_event_id,initiating_kind:intent.initiating.kind,initiating_device_type:intent.initiating.device_type,purpose:intent.purpose,app:intent.app,...(intent.budget_fen!==null?{budget_fen:intent.budget_fen}:{})},undefined,'model',undefined,intent.intent_id);});
      this.verifyInitiatingIntent(intent);
    }
    this.arm();const policy=this.store.policy(input.principal_id),eligibleVoice=input.initiating.kind==='voice'&&this.lockFacts(input.principal_id,await this.ports!.devices(input.principal_id)).locks_ok&&this.enrolled(await this.ports!.owner(input.principal_id),input.initiating.device_type),override=await this.ownerOverrideActive();
    return {status:'accepted',intent_id:intent.intent_id,expires_at:new Date(intent.expires_at_ms).toISOString(),hint:{voice:eligibleVoice&&policy.voice_enabled&&!override,auto:eligibleVoice&&policy.auto_enabled&&!override}};
  }
  /** Complete the source evidence of an existing call request; this changes no payment decision or state. */
  async refreshCallInitiating(principal:string,processedEventId:string,initiating:Initiating):Promise<void>{
    if(initiating.kind!=='voice')return;
    const intents=this.store.db.prepare("SELECT intent_id FROM intents WHERE principal_id=? AND processed_event_id=? AND state<>'closed'")
      .all(principal,processedEventId) as {intent_id:string}[];
    for(const {intent_id} of intents){
      const intent=this.store.getIntent(intent_id)!;
      check(intent.initiating.device_id===initiating.device_id&&intent.initiating.device_type===initiating.device_type,'PAYMENT_SOURCE_CONFLICT',409);
      if(intent.initiating.kind==='voice')continue;
      this.store.tx(()=>this.store.updateIntent(intent_id,{initiating}));
      this.verifyInitiatingIntent({...intent,initiating});
    }
  }
  private verifyInitiatingIntent(intent:PaymentIntent):void{
    if(intent.initiating.kind!=='voice'||!intent.initiating.utterance)return;
    const utterance=intent.initiating.utterance;
    const policyVersion=this.store.policy(intent.principal_id).version;
    void (this.verifier?this.verifier.verifyInitiating(intent.principal_id,utterance):Promise.resolve(unavailable(utterance))).then(verdict=>{
      if(this.closed||this.store.policy(intent.principal_id).version!==policyVersion)return;const latest=this.store.getIntent(intent.intent_id)!;
      this.store.tx(()=>this.store.updateIntent(intent.intent_id,{initiating:{...latest.initiating,verdict}}));
    }).catch(e=>console.error('PAYMENT_INITIATING_VERIFIER_FAILED',safeCode(e)));
  }
  /** Payment facts stay in the authority; replies retain only their trusted source lineage. */
  paymentErrand(principal:string,jobId:string,intentId?:string):boolean {
    if(intentId){const intent=this.store.getIntent(intentId);check(intent&&intent.principal_id===principal,'PAYMENT_INTENT_SCOPE_DENIED',403);return true;}
    return !!this.store.db.prepare('SELECT 1 FROM payments WHERE principal_id=? AND job_id=? LIMIT 1').get(principal,jobId);
  }
  recordReplySource(principal:string,session:string,source:{kind:string;run_id?:string;tool_call_id?:string;intent_id?:string;job_id?:string;of_job?:string}):void {
    id(principal);id(session);
    // The conversation retains prior source context. One durable lineage event per source identity suffices.
    const data={session_id:session,...source};
    if(!this.store.db.prepare("SELECT 1 FROM events WHERE principal_id=? AND kind='reply_source' AND data=? LIMIT 1").get(principal,canonical(data)))
      this.audit(principal,'reply_source',data);
  }
  replyPrivacy(principal:string,session:string,runId?:string):{private?:'payment'} {
    const known=this.store.db.prepare("SELECT 1 FROM events WHERE principal_id=? AND kind='reply_source' AND (json_extract(data,'$.session_id')=? OR (? IS NOT NULL AND json_extract(data,'$.run_id')=?)) LIMIT 1").get(principal,session,runId??null,runId??null);
    const initiating=this.store.db.prepare('SELECT 1 FROM intents WHERE principal_id=? AND (session_id=? OR run_id=?) LIMIT 1').get(principal,session,runId??null);
    return known||initiating?{private:'payment'}:{};
  }
  source(runId:string,intentId?:string):boolean{if(!intentId||!this.config.enabled)return false;const i=this.store.getIntent(intentId);return !!i&&i.run_id===runId&&i.state==='open'&&i.expires_at_ms>this.now();}
  status(principal:string,intentId:string):Record<string,unknown>{const i=this.store.getIntent(intentId);check(i,'PAYMENT_INTENT_NOT_FOUND',404);check(i.principal_id===principal,'PAYMENT_INTENT_SCOPE_DENIED',403);
    return {intent:{state:i.state,expires_at:new Date(i.expires_at_ms).toISOString()},payments:this.store.payments(intentId).map(p=>({payment_id:p.payment_id,state:p.state,amount_yuan:p.amount_fen/100,...(p.payee?{payee:p.payee}:{}),...(p.method?{method:p.method}:{}),...(p.order_cancel?{order_cancel:p.order_cancel}:{}),...(p.reason?{reason:p.reason}:{})}))};}
  async cancel(principal:string,intentId:string):Promise<Record<string,unknown>>{
    const i=this.store.getIntent(intentId);check(i,'PAYMENT_INTENT_NOT_FOUND',404);check(i.principal_id===principal,'PAYMENT_INTENT_SCOPE_DENIED',403);
    const p=this.store.payments(intentId).find(p=>!TERMINAL_STATES.includes(p.state));if(!p)return {status:i.state==='closed'?'already_finished':'not_pending'};
    if(p.state==='paying')return {status:'already_paying',payment_id:p.payment_id};
    this.store.tx(()=>this.terminal(p,'cancelled',null,'pending'));await this.after(p.principal_id,false);return {status:'cancelled',payment_id:p.payment_id};
  }
  private validateCheckpoint(c:Checkpoint):void{
    check(c&&Object.keys(c).every(k=>['intent_id','job_id','seq','app','checkout','amount_fen','payee','items','delivery','screen_sha256','read_at'].includes(k)),'PAYMENT_AMOUNT_INVALID');
    id(c.intent_id);id(c.job_id);check(Number.isSafeInteger(c.seq)&&c.seq>=1&&fen(c.amount_fen),'PAYMENT_AMOUNT_INVALID');
    check(APPS.includes(c.app)&&(c.checkout==='order_card'||c.checkout==='cashier')&&screen(c.screen_sha256),'PAYMENT_AMOUNT_INVALID');
    check(Array.isArray(c.items)&&c.items.length<=5&&c.items.every(x=>text(x,80))&&(c.payee==null||text(c.payee,200))&&(c.delivery==null||text(c.delivery,200)),'PAYMENT_AMOUNT_INVALID');utc(c.read_at);
  }
  private createPayment(c:Checkpoint,i:PaymentIntent,supersedes:string|null=null):Payment{
    const p:Payment={payment_id:`pay-${randomUUID()}`,intent_id:i.intent_id,principal_id:i.principal_id,job_id:c.job_id,seq:c.seq,supersedes,app:c.app,checkout:c.checkout,
      amount_fen:c.amount_fen,payee:c.payee??null,payee_key:payeeKey(i.principal_id,c.app,c.payee??null),items:c.items,delivery:c.delivery??null,screen_sha256:c.screen_sha256,
      state:'awaiting_owner',version:1,decision_nonce:paymentNonce(),created_at_ms:this.now(),expires_at_ms:this.now()+this.config.card_ttl_s*1000,auto_at_ms:null,
      voice_attempts:0,method:null,decided_by_device:null,decision:null,reason:null,notice:null,next_payment_id:null,order_cancel:null,finished_at_ms:null};
    this.store.insertPayment(p);this.store.updateIntent(i.intent_id,{state:'bound'});
    this.audit(i.principal_id,'card_opened',{job_id:p.job_id,seq:p.seq,checkout:p.checkout,amount_fen:p.amount_fen,...(p.payee?{payee:p.payee,payee_key:p.payee_key}:{}),items:p.items,screen_sha256:p.screen_sha256,expires_at_ms:p.expires_at_ms,...(supersedes?{supersedes}:{})},p,'executor');return p;
  }
  private replay(key:string,body:unknown):Record<string,unknown>|undefined{
    const row=this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;
    if(!row)return;const old=JSON.parse(row.value) as {body:string;result:Record<string,unknown>};check(old.body===canonical(body),key.startsWith('checkpoint:')?'PAYMENT_CHECKPOINT_CONFLICT':'PAYMENT_ALREADY_DECIDED',409);return old.result;
  }
  private saveReplay(key:string,body:unknown,result:Record<string,unknown>):void{this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key,canonical({body:canonical(body),result}));}
  private autoFacts(p:Payment,lease_now:boolean,stage:'initial'|'grant',devices:RegisteredDevice[],enrolled:boolean,now=this.now()){
    const i=this.store.getIntent(p.intent_id)!,day=localDayBounds(now,this.time_zone);
    return {...this.facts(p,i,lease_now,devices),now,stage,enrolled,auto_used_today:this.store.autoUsed(p.principal_id,day.start,day.end),recent_same_payee:this.store.recentSamePayee(p.principal_id,p.payee_key,p.payment_id,now-this.config.auto.same_payee_window_s*1000)};
  }
  private scheduleAuto(p:Payment,lease_now:boolean,devices:RegisteredDevice[],enrolled:boolean):Payment{
    const f=this.autoFacts(p,lease_now,'initial',devices,enrolled),d=decideAuto(f);
    this.audit(p.principal_id,'methods_evaluated',{auto:{result:d.kind,...(d.kind==='card_only'?{reason:d.reason}:{})},voice_eligible_terminals:[],known_payee:f.known_payee,auto_used_today_fen:f.auto_used_today},p);
    if(d.kind==='auto_pending'){
      const next=this.update(p,{state:'auto_pending',auto_at_ms:this.now()+this.config.auto.undo_s*1000,reason:null});
      this.audit(p.principal_id,'auto_scheduled',{auto_at_ms:next.auto_at_ms},next);return next;
    }
    return d.kind==='card_only'?this.update(p,{reason:d.reason}):p;
  }
  async checkpoint(c:Checkpoint):Promise<Record<string,unknown>>{
    check(this.config.enabled,'PAYMENT_DISABLED',503);this.validateCheckpoint(c);
    const key=`checkpoint:${c.intent_id}:${c.job_id}:${c.seq}`,replay=this.replay(key,c);if(replay)return replay;
    const i=this.store.getIntent(c.intent_id);check(i,'PAYMENT_INTENT_NOT_FOUND',404);check(i.expires_at_ms>this.now(),'PAYMENT_INTENT_EXPIRED',410);
    check(i.state!=='closed','PAYMENT_INTENT_CLOSED',409);check(i.app===c.app,'PAYMENT_APP_INVALID',400);
    await this.lease(i.initiating.device_id,i.principal_id);
    const devices=await this.ports!.devices(i.principal_id);
    const owner=await this.ownerCurrent(i.principal_id),override=await this.ownerOverrideActive();
    const response=this.store.tx(()=>{
      const previous=this.replay(key,c);if(previous)return previous;
      const intent=this.store.getIntent(c.intent_id)!;check(intent.state!=='closed','PAYMENT_INTENT_CLOSED',409);check(intent.expires_at_ms>this.now(),'PAYMENT_INTENT_EXPIRED',410);
      check(!this.store.payments(i.intent_id).some(p=>!TERMINAL_STATES.includes(p.state)),'PAYMENT_CHECKPOINT_ACTIVE',409);
      check(this.store.principalPayments(intent.principal_id).filter(p=>!TERMINAL_STATES.includes(p.state)).length<PAYMENT_LIVE_LIMIT,'PAYMENT_CHECKPOINT_ACTIVE',409);
      check(!this.store.payments(i.intent_id).some(p=>p.state==='paid')&&this.store.payments(i.intent_id).length<1+this.config.max_recards_per_intent,'PAYMENT_INTENT_CLOSED',409);
      let p=this.createPayment(c,intent);if(!override)p=this.scheduleAuto(p,this.leaseNow(i.initiating.device_id,i.principal_id),devices,this.enrolled(owner,intent.initiating.device_type));
      this.enqueue(p,'card_opened');if(p.state==='auto_pending')this.enqueue(p,'auto_pending');
      const result={payment_id:p.payment_id,state:p.state,expires_at_ms:p.expires_at_ms,server_now_ms:this.now()};this.saveReplay(key,c,result);return result;
    });await this.after(i.principal_id);return response;
  }
  private grant(p:Payment,d:Extract<Decision,{kind:'grant'}>,issuedAt=this.now()):Payment{
    check(this.config.enabled,'PAYMENT_DISABLED',503);check(!this.store.getGrant(p.payment_id),'PAYMENT_ALREADY_DECIDED',409);
    check(!this.store.payments(p.intent_id).some(x=>x.state==='paid'),'PAYMENT_INTENT_CLOSED',409);
    // An auto grant cannot start a debit on a different budget day. Uncertain results retain the issue day.
    const expiresAt=issuedAt+this.config.grant_ttl_s*1000;
    const grant:PaymentGrant={grant_id:`grant-${randomUUID()}`,payment_id:p.payment_id,amount_fen:p.amount_fen,payee_key:p.payee_key,method:d.method,device_id:d.device_id,
      issued_at_ms:issuedAt,expires_at_ms:d.method==='auto'?Math.min(expiresAt,localDayBounds(issuedAt,this.time_zone).end):expiresAt,taps:0,first_tap_at_ms:null};
    this.store.insertGrant(grant);const next=this.update(p,{state:'granted',method:d.method,decided_by_device:d.device_id,decision:'pay',auto_at_ms:null,reason:null});
    this.audit(p.principal_id,'grant_issued',{grant_id:grant.grant_id,method:grant.method,device_id:d.device_id,amount_fen:grant.amount_fen,expires_at_ms:grant.expires_at_ms},next);this.enqueueContext(next);return next;
  }
  private view(id:string):Record<string,unknown>{const p=this.store.getPayment(id);check(p,'PAYMENT_NOT_FOUND',404);
    const g=this.store.getGrant(id);return {payment_id:id,state:p.state,version:p.version,expires_at_ms:p.expires_at_ms,server_now_ms:this.now(),
      ...(p.method?{method:p.method}:{}),
      ...(p.state==='granted'&&g&&g.expires_at_ms>this.now()&&g.taps===0?{grant:{grant_id:g.grant_id,amount_fen:g.amount_fen,...(g.payee_key?{payee_key:g.payee_key}:{}),expires_at_ms:g.expires_at_ms,max_taps:2}}:{}),
      ...(p.next_payment_id?{next_payment_id:p.next_payment_id}:{}),...(p.reason?{reason:p.reason}:{})};}
  async poll(id:string,wait_ms=0,after_version=0):Promise<Record<string,unknown>>{
    this.expireDue();void this.tick().catch(e=>console.error('PAYMENT_TIMER_FAILED',safeCode(e)));const p=this.store.getPayment(id);check(p,'PAYMENT_NOT_FOUND',404);
    if(wait_ms>0&&p.version<=after_version&&!TERMINAL_STATES.includes(p.state)&&!this.closed)await new Promise<void>(resolve=>{
      const callbacks=this.polls.get(id)??new Set<()=>void>();this.polls.set(id,callbacks);
      const done=()=>{clearTimeout(timer);callbacks.delete(done);if(!callbacks.size)this.polls.delete(id);resolve();};
      const timer=setTimeout(done,wait_ms);callbacks.add(done);
    });check(!this.closed,'PAYMENT_AUTHORITY_UNAVAILABLE',503);return this.view(id);
  }
  private mustPayment(id:string):Payment {const p=this.store.getPayment(id);check(p,'PAYMENT_NOT_FOUND',404);return p;}
  async amountChanged(id:string,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const key=`amount-change:${id}`,old=this.replay(key,b);if(old){if(old.state==='failed')throw new ContractError('PAYMENT_RECARD_LIMIT',409);return old;}
    check(fen(b.read_amount_fen)&&screen(b.screen_sha256)&&Array.isArray(b.items)&&b.items.length<=5&&b.items.every(x=>text(x,80))&&(b.payee==null||text(b.payee,200)),'PAYMENT_AMOUNT_INVALID');
    const p=this.mustPayment(id);check(['awaiting_owner','granted'].includes(p.state),'PAYMENT_NOT_PENDING',409);
    if(p.state==='granted')check(b.grant_id===this.store.getGrant(id)?.grant_id,'PAYMENT_GRANT_INVALID',409);
    const result=this.store.tx(()=>{
      const current=this.mustPayment(id);check(['awaiting_owner','granted'].includes(current.state),'PAYMENT_NOT_PENDING',409);
      const i=this.store.getIntent(p.intent_id)!,left=this.store.payments(i.intent_id).length<1+this.config.max_recards_per_intent;
      if(!left){this.terminal(current,'failed','AMOUNT_UNSTABLE','pending');this.audit(p.principal_id,'amount_changed',{old_amount_fen:p.amount_fen,read_amount_fen:b.read_amount_fen},p,'executor');this.anomaly(p);const failed={state:'failed'};this.saveReplay(key,b,failed);return failed;}
      const c:Checkpoint={intent_id:i.intent_id,job_id:p.job_id,seq:Math.max(...this.store.payments(i.intent_id).map(p=>p.seq))+1,app:p.app,checkout:p.checkout,
        amount_fen:b.read_amount_fen as number,payee:b.payee as string|null|undefined??null,items:b.items as string[],delivery:p.delivery,screen_sha256:b.screen_sha256 as string,read_at:new Date(this.now()).toISOString()};
      let next=this.createPayment(c,i,id);next=this.update(next,{reason:'AMOUNT_CHANGED',notice:{reason:'AMOUNT_CHANGED',amount_fen:c.amount_fen,previous_amount_fen:p.amount_fen}});
      this.terminal(current,'superseded','AMOUNT_CHANGED',null);this.store.updatePayment(id,{next_payment_id:next.payment_id});
      this.audit(p.principal_id,'amount_changed',{old_amount_fen:p.amount_fen,read_amount_fen:c.amount_fen,next_payment_id:next.payment_id},p,'executor');this.anomaly(next);
      this.enqueue(next,'card_reopened',{previous_amount_fen:p.amount_fen});const result={state:'superseded',next:{payment_id:next.payment_id,expires_at_ms:next.expires_at_ms}};this.saveReplay(key,b,result);return result;
    });await this.after(p.principal_id);if(result.state==='failed')throw new ContractError('PAYMENT_RECARD_LIMIT',409);return result;
  }
  private liveGrant(p:Payment,b:Record<string,unknown>):PaymentGrant{
    const g=this.store.getGrant(p.payment_id);check(g&&g.grant_id===b.grant_id,'PAYMENT_GRANT_INVALID',409);return g;
  }
  private tapBinding(value:unknown,p:Payment,g:PaymentGrant,complete=false):Record<string,unknown>{
    const code='PAYMENT_NON_DEBIT_REQUIRED';
    check(value&&typeof value==='object'&&!Array.isArray(value),code,409);
    const b=value as Record<string,unknown>,nullable=(v:unknown)=>v==null||text(v,200);
    check(Object.keys(b).every(k=>['order_id','order_namespace','payee','amount_fen','item_identity'].includes(k))&&
      nullable(b.order_id)&&nullable(b.order_namespace)&&nullable(b.payee)&&fen(b.amount_fen)&&
      Array.isArray(b.item_identity)&&b.item_identity.length<=5&&b.item_identity.every((pair:unknown)=>
        Array.isArray(pair)&&pair.length===2&&text(pair[0],80)&&text(pair[1],200))&&
      new Set(b.item_identity.map((pair:string[])=>pair[0])).size===b.item_identity.length,code,409);
    if(complete)check(text(b.order_id,200)&&text(b.order_namespace,200)&&text(b.payee,200)&&b.item_identity.length>0,code,409);
    check(b.amount_fen===g.amount_fen&&(b.payee??null)===p.payee,'PAYMENT_ORDER_MISMATCH',409);return b;
  }
  private admitNonDebit(id:string,b:Record<string,unknown>,p:Payment,g:PaymentGrant):void{
    const code='PAYMENT_NON_DEBIT_REQUIRED',row=this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(`tap:${id}:1`) as {value:string}|undefined;
    check(Object.keys(b).every(k=>['grant_id','step','read_amount_fen','screen_sha256','order_binding','non_debit'].includes(k)),code,409);
    check(row,code,409);const first=JSON.parse(JSON.parse(row.value).body) as Record<string,unknown>;
    const original=this.tapBinding(first.order_binding,p,g,true),current=this.tapBinding(b.order_binding,p,g,true);
    check(canonical(original)===canonical(current),'PAYMENT_ORDER_MISMATCH',409);
    const proof=b.non_debit as Record<string,unknown>|undefined;
    check(proof&&typeof proof==='object'&&!Array.isArray(proof)&&
      Object.keys(proof).every(k=>['state','scope','transition','signs','read_at'].includes(k))&&
      typeof proof.state==='string'&&['unpaid','pre_order'].includes(proof.state)&&typeof proof.scope==='string'&&proof.scope==='current_order'&&
      typeof proof.transition==='string'&&['order_card_to_cashier','pre_order_to_unpaid'].includes(proof.transition)&&
      Array.isArray(proof.signs)&&proof.signs.length>0&&proof.signs.length<=16&&proof.signs.every(s=>text(s,200))&&
      typeof proof.read_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.read_at)&&
      Number.isFinite(Date.parse(proof.read_at))&&new Date(proof.read_at).toISOString()===proof.read_at,code,409);
    check(proof.transition!=='pre_order_to_unpaid'||proof.state==='unpaid',code,409);
    const readAt=Date.parse(proof.read_at);
    check(g.first_tap_at_ms!==null&&readAt>=g.first_tap_at_ms&&readAt>=g.issued_at_ms&&readAt<g.expires_at_ms&&readAt<=this.now()+DEVICE_CLOCK_LEAD_MS,code,409);
  }
  async tap(id:string,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const grant=this.store.getGrant(id);
    if(grant&&grant.method!=='card')check(!await this.ownerOverrideActive(),'PAYMENT_OWNER_OVERRIDE_ACTIVE',403);
    check(b.step===1||b.step===2,'PAYMENT_TAP_LIMIT',409);check(fen(b.read_amount_fen)&&screen(b.screen_sha256),'PAYMENT_AMOUNT_INVALID');
    const key=`tap:${id}:${b.step}`,old=this.replay(key,b);if(old)return old;
    const p=this.mustPayment(id);const expired=this.store.tx(()=>{
      const p=this.mustPayment(id),g=this.liveGrant(p,b);
      if(p.state==='granted'&&p.expires_at_ms<=this.now()){this.terminal(p,'expired','EXPIRED','pending');return true;}
      check(g.expires_at_ms>this.now(),'PAYMENT_GRANT_EXPIRED',409);
      check(b.read_amount_fen===g.amount_fen,'PAYMENT_AMOUNT_MISMATCH',409);
      check((p.state==='granted'&&b.step===1||p.state==='paying'&&b.step===2)&&b.step===g.taps+1,'PAYMENT_TAP_LIMIT',409);
      if(b.step===2)this.admitNonDebit(id,b,p,g);else if(b.order_binding!==undefined)this.tapBinding(b.order_binding,p,g);
      this.store.updateGrant(id,{taps:b.step,first_tap_at_ms:g.first_tap_at_ms??this.now()});this.update(p,{state:'paying'});
      this.audit(p.principal_id,'tap_started',{grant_id:g.grant_id,step:b.step,read_amount_fen:b.read_amount_fen,screen_sha256:b.screen_sha256},p,'executor');this.saveReplay(key,b,{ok:true,...(b.step===2?{non_debit_admitted:true}:{})});return false;
    });await this.after(p.principal_id);if(expired)throw new ContractError('PAYMENT_GRANT_EXPIRED',409);return {ok:true,...(b.step===2?{non_debit_admitted:true}:{})};
  }
  async result(id:string,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const key=`result:${id}`,old=this.replay(key,b);if(old)return old;
    check(typeof b.outcome==='string'&&['paid','not_paid','unknown'].includes(b.outcome)&&Array.isArray(b.signs)&&b.signs.length<=16&&b.signs.every(x=>text(x,200))&&screen(b.screen_sha256)&&(b.reason===undefined||text(b.reason,80)),'PAYMENT_AMOUNT_INVALID');
    const p=this.mustPayment(id);const response=this.store.tx(()=>{
      const p=this.mustPayment(id),g=this.liveGrant(p,b);check(p.state==='paying','PAYMENT_NOT_PENDING',409);
      let state:Payment['state'];
      if(b.outcome==='paid'){check(!this.store.payments(p.intent_id).some(x=>x.payment_id!==id&&x.state==='paid'),'PAYMENT_INTENT_CLOSED',409);state='paid';}
      else state=b.outcome==='unknown'?'outcome_unknown':'failed';
      const reason=b.reason as string|undefined,cancel=state==='failed'?(reason==='VERIFICATION_REQUIRED'?'not_needed':'pending'):null;
      this.update(p,{state,reason:reason??null,order_cancel:cancel,finished_at_ms:this.now()});this.store.updateIntent(p.intent_id,{state:'closed',closed_reason:state});
      this.enqueueContext(this.mustPayment(id));this.audit(p.principal_id,'result_reported',{grant_id:g.grant_id,outcome:b.outcome,...(reason?{reason}:{}),signs:b.signs},p,'executor');const result={state};this.saveReplay(key,b,result);return result;
    });await this.after(p.principal_id);return response;
  }
  async abort(id:string,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const key=`abort:${id}`,old=this.replay(key,b);if(old)return old;
    check(typeof b.reason==='string'&&['VERIFICATION_REQUIRED','SCREEN_UNREADABLE','PAY_BUTTON_NOT_FOUND','EXECUTOR_LOST','AMOUNT_UNSTABLE','JOB_CANCELLED','PAYMENT_DISABLED'].includes(b.reason),'PAYMENT_AMOUNT_INVALID');
    const p=this.mustPayment(id);const result=this.store.tx(()=>{
      const p=this.mustPayment(id);check(beforeTap(p),'PAYMENT_ALREADY_PAYING',409);if(b.grant_id!==undefined)this.liveGrant(p,b);
      this.terminal(p,'failed',String(b.reason),b.reason==='VERIFICATION_REQUIRED'?'not_needed':b.reason==='EXECUTOR_LOST'?'not_attempted':'pending');
      if(b.reason==='EXECUTOR_LOST')this.enqueue(this.mustPayment(id),'closed');const result={state:'failed'};this.saveReplay(key,b,result);return result;
    });await this.after(p.principal_id);return result;
  }
  async orderCancel(id:string,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const key=`order-cancel:${id}`,old=this.replay(key,b);if(old)return old;
    check(typeof b.outcome==='string'&&['done','failed','not_attempted'].includes(b.outcome)&&(b.detail===undefined||text(b.detail,200)),'PAYMENT_AMOUNT_INVALID');const p=this.mustPayment(id);
    this.store.tx(()=>{check(p.order_cancel==='pending'||p.order_cancel==='not_attempted','PAYMENT_NOT_PENDING',409);
      this.update(p,{order_cancel:b.outcome as Payment['order_cancel']});this.audit(p.principal_id,'order_cancel_result',{outcome:b.outcome,...(b.detail?{detail:b.detail}:{})},p,'executor');this.saveReplay(key,b,{ok:true});});await this.after(p.principal_id);return {ok:true};
  }
  async verifyMacPairing(source:RegisteredDevice,input:SignedInput,nonce:string,keyDigest:string):Promise<void>{
    await this.keys.verify(source,'mac_pairing',input,{public_key_sha256:keyDigest},nonce);
  }
  inputBinding(source:RegisteredDevice):PaymentInputBinding {
    return {connection:this.terminals.connectionIdentity(source),wear:source.device_type==='glasses'?this.terminals.wearSession(source):undefined};
  }
  async input(source:RegisteredDevice,b:Record<string,unknown>,session_id?:string,origin=this.inputBinding(source)):Promise<PaymentProjection|undefined>{
    await this.active(source);const operation=String(b.operation),phone=source.device_type==='phone'&&hasTerminalCapability(source,'owner_unlock');
    const glasses=source.device_type==='glasses'&&hasTerminalCapability(source,'wear_state');
    const fromGlasses=['glasses_unlock_request','glasses_lock','voiceprint_enrol_request'].includes(operation);
    check(fromGlasses?glasses:phone,'PAYMENT_TERMINAL_NOT_ALLOWED',403);
    if(fromGlasses)check(origin.connection===this.terminals.connectionIdentity(source),'APPROVAL_WEAR_CHANGED',409);
    let result:Record<string,unknown>={};
    if(operation==='payment_decide'){if(b.decision!=='cancel')await this.ownerCurrent(source.principal_id);result=await this.cardDecision(source,b);}
    else if(operation==='payment_challenge_get')return {operation:'payment_challenge',request_id:b.request_id,purpose:b.purpose,...await this.keys.challenge(source,b.purpose as ChallengePurpose)};
    else if(operation==='payment_keys_register')await this.keys.register(source,b as unknown as Parameters<PaymentKeys['register']>[1]);
    else if(operation==='phone_unlock')await this.leases.unlock(source,b as SignedInput);
    else if(operation==='phone_presence'){await this.leases.presence(source,b.state as 'foreground'|'background'|'locked');}
    else if(operation==='payment_settings_get')return {operation:'payment_settings',request_id:b.request_id,...await this.settings(source)};
    else if(operation==='payment_settings_set')await this.changeSettings(source,b);
    else if(operation==='payment_approval_decide')await this.leases.decideApproval(source,b as unknown as Parameters<PaymentLeases['decideApproval']>[1]);
    else if(operation==='glasses_unlock_request'||operation==='voiceprint_enrol_request')await this.leases.requestApproval(source,operation==='glasses_unlock_request'?'glasses_unlock':b.purpose==='conversation'?'voice_enrollment':'voiceprint_enrol',undefined,b.lock_cycle as number|undefined,origin.wear??null);
    else if(operation==='glasses_lock')this.leases.lock(source,String(b.reason));
    else if(operation==='payment_records_get')return {operation:'payment_records',request_id:b.request_id,...recordsProjection(this.store,source.principal_id,b.before as string|undefined,b.limit as number|undefined,{session_id,request_id:b.request_id as string})};
    else if(operation==='payment_record_get')return {operation:'payment_record',request_id:b.request_id,...recordProjection(this.store,source.principal_id,String(b.payment_id),{session_id,request_id:b.request_id as string},b.before_seq as number|undefined)};
    else if(operation==='payment_dispute'){
      const p=this.mustPayment(String(b.payment_id));check(p.principal_id===source.principal_id,'PAYMENT_NOT_FOUND',404);
      this.store.tx(()=>{this.audit(source.principal_id,'dispute',{payment_id:p.payment_id},p,'owner_phone',source.device_id);this.cascadeTx(source.principal_id,'dispute');});
    }else if(operation==='voiceprint_channel_forget'){
      const signed=await this.keys.verify(source,'voiceprint_forget',b as SignedInput,{channel:'glasses'});
      signed.commit(()=>{});await this.ports!.forget(source.principal_id,'glasses');await this.ownerCurrent(source.principal_id);
    }else throw new ContractError('FORMAL_PAYMENT_INPUT_INVALID');
    const lowerRisk=operation==='payment_dispute'||operation==='payment_decide'&&b.decision==='cancel'||operation==='payment_settings_set'&&['voice','auto'].includes(String((b.change as SettingsChange)?.kind))&&!(b.change as {enabled:boolean}).enabled;
    await this.after(source.principal_id,!lowerRisk);
    if(typeof b.control_id==='string')return {operation:'payment_receipt',control_id:b.control_id,ok:true,...result};
  }
  private async cardDecision(s:RegisteredDevice,b:Record<string,unknown>):Promise<Record<string,unknown>>{
    const p=this.mustPayment(String(b.payment_id));check(p.principal_id===s.principal_id,'PAYMENT_NOT_FOUND',404);
    if(b.decision==='cancel'){
      if(p.decision==='cancel'&&p.decided_by_device===s.device_id)return {payment_id:p.payment_id,state:p.state};
      check(p.state!=='paying','PAYMENT_ALREADY_PAYING',409);check(beforeTap(p),'PAYMENT_NOT_PENDING',409);
      return this.store.tx(()=>{const current=this.mustPayment(p.payment_id);check(beforeTap(current),'PAYMENT_NOT_PENDING',409);
        const done=this.terminal(current,'cancelled',null,'pending');this.store.updatePayment(p.payment_id,{decision:'cancel',decided_by_device:s.device_id});
        this.audit(s.principal_id,'decision_received',{decision:'cancel',method:'card',device_id:s.device_id},done,'owner_phone',s.device_id);
        const result={payment_id:p.payment_id,state:done.state};this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`decision:${p.payment_id}`,canonical(result));return result;});
    }
    if(p.decision!==null){
      check(p.decided_by_device===s.device_id&&p.decision===b.decision,'PAYMENT_ALREADY_DECIDED',409);
      const row=this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(`decision:${p.payment_id}`) as {value:string}|undefined;
      return row?JSON.parse(row.value):{payment_id:p.payment_id,state:p.state};
    }
    const i=this.store.getIntent(p.intent_id)!;
    let signed:VerifiedStatement|undefined;
    try{signed=await this.keys.verify(s,'payment_decide',b as SignedInput,{payment_id:p.payment_id,decision:'pay',amount_fen:p.amount_fen,payee_key:p.payee_key},p.decision_nonce);}catch(error){if(!(error instanceof ContractError))throw error;}
    await this.leases.valid(s);const devices=await this.ports!.devices(s.principal_id);
    const d=this.store.tx(()=>{
      const current=this.mustPayment(p.payment_id),f=this.facts(current,i,this.leases.validNow(s),devices),decision=decideCard({...f,actor:{device_id:s.device_id,device_type:s.device_type,owner_unlock:hasTerminalCapability(s,'owner_unlock'),active:true},
        key_known:!!this.keys.registered(s,'device'),signature_valid:!!signed,statement_matches:!!signed,actor_lock_enabled:!!this.store.locks(s.principal_id).find(l=>l.device_id===s.device_id)?.enabled});
      if(decision.kind==='reject'){this.audit(s.principal_id,'decision_rejected',{decision:'pay',method:'card',device_id:s.device_id,error_code:decision.code},current,'owner_phone',s.device_id);return decision;}
      if(decision.kind==='grant')signed!.commit(()=>{
        const next=this.grant(current,decision);this.audit(s.principal_id,'decision_received',{decision:'pay',method:'card',device_id:s.device_id},next,'owner_phone',s.device_id);
        this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`decision:${p.payment_id}`,canonical({payment_id:p.payment_id,state:next.state}));
      });return decision;
    });
    // Pure rule order determines the public error; rejected crypto details never cross the boundary.
    this.requireDecision(d);return {payment_id:p.payment_id,state:this.mustPayment(p.payment_id).state};
  }
  private cascadeTx(principal:string,cause:string):void{
    const policy=this.store.policy(principal),turned_off=[...(policy.voice_enabled?['voice']:[]),...(policy.auto_enabled?['auto']:[])];if(!turned_off.length)return;
    this.store.setPolicy({...policy,voice_enabled:false,auto_enabled:false,version:policy.version+1,updated_at_ms:this.now()});
    this.audit(principal,'cascade',{cause,turned_off});
  }
  async cascade(principal:string,cause:string):Promise<void>{this.store.tx(()=>this.cascadeTx(principal,cause));await this.after(principal);}
  /** Retire model-dependent evidence for every persisted owner, including disconnected devices. Card decisions survive. */
  async cascadeVoice(cause:string):Promise<void>{
    const principals = this.store.db.prepare('SELECT principal_id FROM policy UNION SELECT principal_id FROM intents WHERE state<>\'closed\'')
      .all() as {principal_id:string}[];
    this.store.tx(()=>{
      for(const {principal_id} of principals){
        const policy=this.store.policy(principal_id);
        if(!policy.voice_enabled&&!policy.auto_enabled)this.store.setPolicy({...policy,version:policy.version+1,updated_at_ms:this.now()});
        for(const row of this.store.db.prepare("SELECT intent_id FROM intents WHERE principal_id=? AND state<>'closed'").all(principal_id) as {intent_id:string}[]){
          const intent=this.store.getIntent(row.intent_id)!;
          if(intent.initiating.verdict){const {verdict:_retired,...initiating}=intent.initiating;this.store.updateIntent(intent.intent_id,{initiating});}
          for(const payment of this.store.payments(intent.intent_id))if(payment.state==='auto_pending'||payment.state==='verifying'){
            const next=this.update(payment,{state:'awaiting_owner',auto_at_ms:null,reason:'VOICE_UNAVAILABLE'});
            this.audit(principal_id,'voice_retired',{cause},next);
          }
        }
      }
    });
    const results=await Promise.allSettled(principals.map(({principal_id})=>this.cascade(principal_id,cause)));
    this.afterErrors(results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason));
  }
  private async changeSettings(s:RegisteredDevice,b:Record<string,unknown>):Promise<void>{
    const c=b.change as SettingsChange,policy=this.store.policy(s.principal_id);
    const enabling=(c.kind==='voice'||c.kind==='auto')&&c.enabled;
    const owner=enabling?await this.ports!.owner(s.principal_id):undefined;
    const devices=enabling?await this.ports!.devices(s.principal_id):[];
    const needsSignature=!((c.kind==='voice'||c.kind==='auto')&&!c.enabled);let signed:VerifiedStatement|undefined;
    if(needsSignature&&b.statement_b64&&b.signature_b64){
      try{signed=await this.keys.verify(s,'settings',b as SignedInput,{policy_version:b.policy_version,change:c});}
      catch(error){if(!(error instanceof ContractError))throw error;}
    }
    const f={actor:{device_id:s.device_id,device_type:s.device_type,owner_unlock:hasTerminalCapability(s,'owner_unlock'),active:true},policy,config:this.config,change:c,
      policy_version:b.policy_version as number,signature_present:!!(b.statement_b64&&b.signature_b64),signature_valid:!!signed,live_owner:owner?.live??false,
      ...this.lockFacts(s.principal_id,devices),device_keys:!!this.keys.registered(s,'device')&&!!this.keys.registered(s,'user')};
    const decision=decideSettings(f);this.requireDecision(decision);check(decision.kind==='allow','PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
    if(c.kind==='glasses_lock'){
      const target=(await this.ports!.devices(s.principal_id)).find(d=>d.principal_id===s.principal_id&&d.device_id===c.device_id&&d.device_type==='glasses');check(target,'PAYMENT_TERMINAL_NOT_ALLOWED',403);
    }
    const apply=()=>this.store.tx(()=>{
      const before=this.store.policy(s.principal_id);check(before.version===b.policy_version,'PAYMENT_POLICY_VERSION_STALE',409);
      const next={...before,version:before.version+1,updated_at_ms:this.now()};
      if(c.kind==='voice'){next.voice_enabled=c.enabled;if(!c.enabled)next.auto_enabled=false;}
      else if(c.kind==='auto'){next.auto_enabled=c.enabled;if(c.enabled)next.paused_until_ms=null;}
      else if(c.kind==='limits'){const {kind:_,...limits}=c;next.limits={...next.limits,...limits};}
      else{
        const device_id=c.kind==='glasses_lock'?c.device_id:s.device_id,old=this.store.locks(s.principal_id).find(l=>l.device_id===device_id);
        const lock={device_id,principal_id:s.principal_id,device_type:c.kind==='glasses_lock'?'glasses' as const:'phone' as const,enabled:c.kind==='relock'?old?.enabled??false:c.enabled,
          relock_s:c.kind==='relock'||c.kind==='phone_lock'?c.relock_s??old?.relock_s??this.config.locks.phone_relock_s:null,updated_at_ms:this.now()};
        this.store.setLock(lock);this.audit(s.principal_id,'lock_changed',{device_id,device_type:lock.device_type,enabled:lock.enabled,...(lock.relock_s!==null?{relock_s:lock.relock_s}:{})},undefined,'owner_phone',s.device_id);
        if(!lock.enabled){next.voice_enabled=false;next.auto_enabled=false;}
      }
      const cascaded=[...(before.voice_enabled&&!next.voice_enabled&&c.kind!=='voice'?['voice']:[]),...(before.auto_enabled&&!next.auto_enabled&&c.kind!=='auto'?['auto']:[])];
      if(cascaded.length)this.audit(s.principal_id,'cascade',{cause:c.kind==='voice'?'voice_disabled':'lock_disabled',turned_off:cascaded});
      this.store.setPolicy(next);this.audit(s.principal_id,'policy_changed',{before,after:next,change_kind:c.kind,signed:needsSignature},undefined,'owner_phone',s.device_id);
    });if(signed)signed.commit(apply);else apply();
    if((c.kind==='phone_lock'||c.kind==='glasses_lock')&&!c.enabled){const target=this.sources.get(JSON.stringify([s.principal_id,c.kind==='phone_lock'?s.device_id:c.device_id]));if(target)this.leases.lock(target,'disabled');}
  }
  private anomaly(p:Payment):void{
    const day=localDayBounds(this.now(),this.time_zone),policy=this.store.policy(p.principal_id);
    if(this.store.anomalyCount(p.principal_id,day.start,day.end)>=this.config.anomaly.max_per_day&&policy.paused_until_ms!==day.end){
      this.store.setPolicy({...policy,paused_until_ms:day.end,version:policy.version+1,updated_at_ms:this.now()});this.audit(p.principal_id,'auto_paused',{until_ms:day.end},p);this.enqueue(p,'auto_paused');
    }
  }
  async observePayUtterance(principal:string,u:UtteranceRef):Promise<void>{
    if(await this.ownerOverrideActive())return;
    const key=`${u.device_id}:${u.start_ms}`;for(const [k,until] of this.utterances)if(until<this.now())this.utterances.delete(k);
    if(this.utterances.has(key))return;this.utterances.set(key,this.now()+3000);
    const p=this.store.principalPayments(principal).find(p=>p.state==='awaiting_owner'&&p.expires_at_ms>this.now());
    if(!p){this.store.tx(()=>this.audit(principal,'voice_ignored',{device_id:u.device_id,reason:'NO_PENDING_PAYMENT'}));return;}
    const source=this.sources.get(JSON.stringify([principal,u.device_id])),leased=source?await this.leases.valid(source):false;
    const captured=source?await this.leases.valid(source,Date.parse(u.captured_at)):false;
    const devices=await this.ports!.devices(principal);
    const owner=await this.ownerCurrent(principal);
    const i=this.store.getIntent(p.intent_id)!,f:VoiceFacts={...this.facts(this.mustPayment(p.payment_id),i,leased,devices),utterance:u,active:!!source,lease_at_capture:captured,enrolled:this.enrolled(owner,i.initiating.device_type,u.device_type)};
    const replayKey=`pay-utterance:${sha256(canonical([principal,u.device_id,u.start_ms]))}`;
    const decision=this.store.tx(()=>{
      const current=this.mustPayment(p.payment_id),d:Decision=this.replay(replayKey,{})?{kind:'ignore',reason:'UTTERANCE_REPLAY'}:decideVoice({...f,payment:current,now:this.now()});
      if(d.kind==='verify'){
        this.saveReplay(replayKey,{}, {payment_id:current.payment_id});
        const next=this.update(current,{state:'verifying'});this.audit(principal,'decision_received',{decision:'pay',method:'voice',device_id:u.device_id},next,u.device_type==='glasses'?'owner_glasses':'owner_phone',u.device_id);
      }
      else if(d.kind==='card_only'){this.update(current,{reason:d.reason});this.enqueue(this.mustPayment(p.payment_id),'voice_result',{reason:d.reason,tries_left:this.config.voice.max_attempts_per_card-current.voice_attempts});}
      else if(d.kind==='ignore')this.audit(principal,'voice_ignored',{device_id:u.device_id,reason:d.reason},current);
      return d;
    });if(decision.kind!=='verify'){await this.after(principal);return;}
    const abort=new AbortController();this.verifying.set(p.payment_id,abort);
    // The phrase is already consumed durably. Delivery cannot postpone or prevent its one verification.
    void this.after(principal).catch(e=>console.error('PAYMENT_VOICE_UPDATE_FAILED',safeCode(e)));
    let verdict:VoiceVerdict;
    try{verdict=this.verifier?await this.verifier.verifyPay(principal,i.initiating.utterance!,u,abort.signal):unavailable(u);}
    catch(error){if(abort.signal.aborted)return;console.error('PAYMENT_VOICE_VERIFIER_FAILED',safeCode(error));verdict=unavailable(u);}
    finally{if(this.verifying.get(p.payment_id)===abort)this.verifying.delete(p.payment_id);}
    if(this.closed)return;
    let grantDevices:RegisteredDevice[],grantOwner:OwnerEnrollment;
    try{if(source)await this.leases.valid(source);grantDevices=await this.ports!.devices(principal);grantOwner=await this.ownerCurrent(principal);}
    catch(error){
      if(!this.closed){this.store.tx(()=>{const current=this.mustPayment(p.payment_id);if(current.state!=='verifying')return;
        const reason=source&&!this.leases.validNow(source)?'TERMINAL_LOCKED':'VOICE_UNAVAILABLE';
        const next=this.update(current,{state:'awaiting_owner',reason});this.audit(principal,'decision_rejected',{decision:'pay',method:'voice',device_id:u.device_id,error_code:reason},next);
        this.enqueue(next,'voice_result',{reason,tries_left:this.config.voice.max_attempts_per_card-current.voice_attempts});
      });void this.after(principal).catch(e=>console.error('PAYMENT_VOICE_UPDATE_FAILED',safeCode(e)));}
      throw error;
    }
    if(await this.ownerOverrideActive())verdict=unavailable(u);
    this.store.tx(()=>{
      const current=this.mustPayment(p.payment_id),intent=this.store.getIntent(i.intent_id)!,d=decideVoiceResult({...this.facts(current,intent,this.leaseNow(u.device_id,principal),grantDevices),utterance:u,active:!!source,lease_at_capture:captured,enrolled:this.enrolled(grantOwner,intent.initiating.device_type,u.device_type)},verdict);
      if(d.kind==='drop')return;
      const attempt_id=`attempt-${randomUUID()}`,counted=verdict.verdict!=='unavailable',attempts=current.voice_attempts+Number(counted);
      const rounded=(x:number|null|undefined)=>x==null?null:Math.round(x*100)/100;
      this.store.db.prepare('INSERT INTO voice_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attempt_id,current.payment_id,u.device_id,this.now(),verdict.verdict,verdict.reason??null,
        rounded(verdict.initiating.score),rounded(verdict.pay?.score),rounded(verdict.combined?.score),verdict.initiating.speech_ms,verdict.pay?.speech_ms??null,verdict.channel,canonical(i.initiating.utterance),canonical(u));
      let next=this.update(current,{voice_attempts:attempts});
      this.audit(principal,'voice_attempt',{attempt_id,device_id:u.device_id,verdict:verdict.verdict,...(verdict.reason?{reason:verdict.reason}:{}),tries_left:this.config.voice.max_attempts_per_card-attempts},next);
      if(verdict.verdict==='fail'||verdict.verdict==='uncertain')this.anomaly(next);
      if(d.kind==='grant'){
        // A policy/registry cascade while verification was in flight cannot be bypassed by an old verdict.
        if(!this.store.policy(principal).voice_enabled||!this.lockFacts(principal,grantDevices).locks_ok)next=this.update(next,{state:'awaiting_owner',reason:'VOICE_DISABLED'});
        else next=this.grant(next,d);
      }else if(d.kind==='card_only')next=this.update(next,{state:'awaiting_owner',reason:d.reason});
      this.enqueue(next,'voice_result',{voice_verdict:verdict.verdict,tries_left:this.config.voice.max_attempts_per_card-attempts,...(next.reason?{reason:next.reason}:{})});
    });await this.after(principal);
  }
  private enqueueContext(p:Payment,event:string=p.state):void{
    const amount=String(p.amount_fen/100),line=event==='voice_result'?`声音核对结果：${p.reason??p.state}`:
      p.state==='granted'?'付款授权已通过，正在付款':p.state==='paid'?'已收到付款成功回执':p.state==='outcome_unknown'?'付款结果不明，不要再付一次':
      TERMINAL_STATES.includes(p.state)?`付款卡已结束：${p.state}${p.reason?'，'+p.reason:''}`:`付款卡已出：${p.payee??'收款方未读到'} ${amount} 元，请他点屏幕上的付款`;
    this.store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run(`payment-context:${p.payment_id}:${p.version}:${event}`,canonical({principal:p.principal_id,text:line+'。没有付款成功回执前不要说已付款。'}));
  }
  private enqueue(p:Payment,event:string,extra:Record<string,unknown>={}):void{
    if(event==='card_opened'||event==='card_reopened'||event==='voice_result')this.enqueueContext(p,event);
    const key=`payment-update:${p.payment_id}:${p.version}:${event}`;
    this.store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run(key,canonical({intent:this.store.getIntent(p.intent_id),payment:p,event,extra}));
  }
  private flushUpdates(ownerEvidence=true):Promise<void>{
    return this.flushing??=this.flushOwned(ownerEvidence).finally(()=>{this.flushing=undefined;});
  }
  private async flushOwned(ownerEvidence:boolean):Promise<void>{
    if(!this.ports||this.closed)return;
    while(!this.closed){
    const rows=this.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'payment-update:%' OR key LIKE 'payment-context:%' ORDER BY rowid").all() as {key:string;value:string}[];if(!rows.length)return;
    for(const row of rows){
      if(this.closed)return;
      if(row.key.startsWith('payment-context:')){const c=JSON.parse(row.value) as {principal:string;text:string};await this.ports.context(c.principal,c.text);if(!this.closed)this.store.db.prepare('DELETE FROM meta WHERE key=?').run(row.key);continue;}
      const v=JSON.parse(row.value) as {intent:PaymentIntent;payment:Payment;event:string;extra:Record<string,unknown>};
      const methods=await this.methods(v.payment,ownerEvidence);
      await this.ports.update(v.intent,v.payment,v.event,{methods:{voice:methods.voice.available,auto:methods.auto.available},...v.extra});if(!this.closed)this.store.db.prepare('DELETE FROM meta WHERE key=?').run(row.key);
    }
    }
  }
  private used(principal:string):number{const day=localDayBounds(this.now(),this.time_zone);return this.store.autoUsed(principal,day.start,day.end);}
  private async methods(p:Payment,ownerEvidence=true):Promise<import('./projection.ts').Methods>{
    if(await this.ownerOverrideActive())return {voice:{available:false,reason:'VOICE_UNAVAILABLE',tries_left:Math.max(0,this.config.voice.max_attempts_per_card-p.voice_attempts)},auto:{available:false,reason:'VOICE_UNAVAILABLE'}};
    const i=this.store.getIntent(p.intent_id)!,leased=await this.lease(i.initiating.device_id,p.principal_id),utterance=i.initiating.utterance;
    const devices=await this.ports!.devices(p.principal_id),enrolled=ownerEvidence&&i.initiating.kind==='voice'&&!TERMINAL_STATES.includes(p.state)&&this.enrolled(await this.ports!.owner(p.principal_id),i.initiating.device_type),facts=this.facts({...p,state:'awaiting_owner'},i,leased,devices);
    // Availability evaluates a new phrase, rather than reusing the initiating clip as a payment phrase.
    const v=utterance?decideVoice({...facts,utterance:{...utterance,start_ms:this.now(),end_ms:this.now()+1,captured_at:new Date(this.now()).toISOString()},active:leased,lease_at_capture:leased,enrolled}):{kind:'card_only' as const,reason:'INITIATING_NOT_VOICE' as const};
    const auto=decideAuto(this.autoFacts(p,leased,'initial',devices,enrolled));
    return {voice:{available:v.kind==='verify',...(v.kind==='card_only'?{reason:v.reason}:{}),tries_left:Math.max(0,this.config.voice.max_attempts_per_card-p.voice_attempts)},
      auto:{available:auto.kind==='auto_pending',...(auto.kind==='card_only'?{reason:auto.reason}:{})}};
  }
  private async settings(s:RegisteredDevice):Promise<Record<string,unknown>>{
    const owner=await this.ports!.owner(s.principal_id),policy=this.store.policy(s.principal_id),locks=this.store.locks(s.principal_id),phone=locks.find(l=>l.device_id===s.device_id);
    const devices=await this.ports!.devices(s.principal_id),glasses=devices.find(d=>d.principal_id===s.principal_id&&d.device_type==='glasses');
    const glassLock=glasses?locks.find(l=>l.device_id===glasses.device_id&&l.device_type==='glasses'):undefined;
    const devKey=this.keys.registered(s,'device'),userKey=this.keys.registered(s,'user');const missing:string[]=[];
    if(!owner.live)missing.push('VOICEPRINT');if(!phone?.enabled)missing.push('PHONE_LOCK');
    if(!this.lockFacts(s.principal_id,devices).locks_ok&&phone?.enabled)missing.push('GLASSES_LOCK');if(!devKey||!userKey)missing.push('DEVICE_KEYS');
    return settingsProjection({policy,config:this.config,limits:effectiveLimits(policy,this.config),used:this.used(s.principal_id),phone:{enabled:phone?.enabled??false,unlocked:await this.leases.valid(s),relock_s:phone?.relock_s??this.config.locks.phone_relock_s},
      glasses:{paired:!!glasses,...(glasses?{device_id:glasses.device_id}:{}),enabled:glassLock?.enabled??false,unlocked:glasses?await this.lease(glasses.device_id,s.principal_id):false,worn:glasses?this.terminals.available(glasses):false},owner:{phone_app:owner.phone_app,glasses:owner.glasses},
      keys:{device:!!devKey,user:!!userKey,...(devKey?{registered_at:new Date(devKey.created_at_ms).toISOString()}:{})},missing});
  }
  private async snapshots(s:RegisteredDevice,ownerEvidence=true,session_id?:string):Promise<PaymentProjection[]>{
    await this.active(s);const all=this.store.principalPayments(s.principal_id),active=all.filter(p=>!TERMINAL_STATES.includes(p.state));
    if(s.device_type==='phone'&&hasTerminalCapability(s,'owner_unlock')){
      check(active.length<=PAYMENT_LIVE_LIMIT,'PAYMENT_CHECKPOINT_ACTIVE',409);
      const cards=all.filter(p=>!TERMINAL_STATES.includes(p.state)||p.finished_at_ms!==null&&p.finished_at_ms>=this.now()-this.config.cards.recent_s*1000)
        .sort((a,b)=>Number(TERMINAL_STATES.includes(a.state))-Number(TERMINAL_STATES.includes(b.state))).slice(0,PAYMENT_LIVE_LIMIT);
      const projected=await Promise.all(cards.map(async p=>cardProjection(this.store,p,this.now(),await this.methods(p,ownerEvidence),this.used(s.principal_id))));
      const approvals=await this.leases.approvals(s);
      return [{operation:'payment_cards',complete:true,cards:projected},
        ...(ownerEvidence?[{operation:'payment_settings',...await this.settings(s)}]:[]),
        {operation:'payment_approvals',complete:true,approvals}];
    }
    if(s.device_type==='glasses'&&hasTerminalCapability(s,'wear_state')){
      const enabled=!!this.store.locks(s.principal_id).find(l=>l.device_id===s.device_id)?.enabled,leased=await this.leases.valid(s),worn=this.terminals.available(s),p=active[0];
      const enrolment=await this.leases.enrolment(s),conversation=await this.leases.enrolment(s,false,'voice_enrollment'),methods=p?await this.methods(p,ownerEvidence):undefined;
      if(p&&methods&&this.config.voice.require_same_terminal&&this.store.getIntent(p.intent_id)!.initiating.device_id!==s.device_id)methods.voice={...methods.voice,available:false,reason:'DIFFERENT_TERMINAL'};
      return [{operation:'payment_notice',notice:noticeProjection(p,this.now(),enabled&&!leased,methods)},
        {operation:'payment_lock_state',lock_enabled:enabled,locked:enabled&&!leased,...(!enabled?{reason:'disabled'}:!worn?{reason:'not_worn'}:!leased?{reason:'awaiting_phone'}:{}),wear_poll_ms:this.config.locks.glasses_wear_poll_ms,...(this.terminals.lease(s)?{lock_cycle:this.terminals.lease(s)!.lock_cycle}:{}),
          enrolment:enrolment?{granted:true,expires_in_ms:Math.max(0,enrolment.expires_at_ms-this.now()),sentences:this.ports!.enrolment_sentences}:{granted:false},
          voice_enrollment:conversation?{granted:true,expires_in_ms:Math.max(0,conversation.expires_at_ms-this.now())}:{granted:false}}];
    }
    return [];
  }
  async watch(source:RegisteredDevice,deliver:(p:PaymentProjection)=>Promise<void>,session_id?:string):Promise<()=>void>{
    await this.active(source);const watcher:PaymentWatcher={source,deliver,session_id,dirty:true,ownerEvidence:true};this.watchers.add(watcher);
    try{watcher.flight=this.deliverSnapshots(watcher);await watcher.flight;await this.windows(source.principal_id);}
    catch(error){this.watchers.delete(watcher);throw error;}
    finally{watcher.flight=undefined;if(this.watchers.has(watcher)&&watcher.dirty)this.notify(watcher,watcher.ownerEvidence);this.arm();}
    void this.flushUpdates().catch(e=>console.error('PAYMENT_UPDATE_FAILED',safeCode(e)));
    return ()=>{this.watchers.delete(watcher);};
  }
  private async deliverSnapshots(watcher:PaymentWatcher):Promise<void>{
    while(watcher.dirty&&this.watchers.has(watcher)&&!this.closed){
      watcher.dirty=false;
      const projections=await this.snapshots(watcher.source,watcher.ownerEvidence,watcher.session_id);
      for(const projection of projections){
        if(!this.watchers.has(watcher)||this.closed)return;
        if(watcher.dirty)break; // Rebuild, rather than finish a snapshot superseded while awaiting delivery.
        await watcher.deliver(projection);
      }
    }
  }
  /** One in-flight snapshot and one latest refresh per subscriber; the authority timer owns retry cadence. */
  private notify(watcher:PaymentWatcher,ownerEvidence:boolean):void{
    watcher.dirty=true;watcher.ownerEvidence=ownerEvidence;
    if(watcher.flight||watcher.retry_at!==undefined&&watcher.retry_at>this.now())return;
    watcher.retry_at=undefined;
    watcher.flight=this.deliverSnapshots(watcher).catch(error=>{
      if(!this.watchers.has(watcher)||this.closed)return;
      if(inactiveSource(error))this.watchers.delete(watcher);
      else{watcher.retry_at=this.now()+1000;console.error('PAYMENT_SNAPSHOT_FAILED',safeCode(error));}
    }).finally(()=>{
      watcher.flight=undefined;
      if(this.watchers.has(watcher)&&!this.closed&&watcher.dirty&&watcher.retry_at===undefined)this.notify(watcher,watcher.ownerEvidence);
      this.arm();
    });
  }
  async terminalChanged(source:RegisteredDevice):Promise<void>{await this.active(source);await this.after(source.principal_id);}
  async detach(source:RegisteredDevice):Promise<void>{await this.leases.detach(source);await this.after(source.principal_id);}
  async enrolmentAllowed(source:RegisteredDevice,kind:GrantKind='voiceprint_enrol'):Promise<boolean>{return !!await this.leases.enrolment(source,true,kind);}
  async consumeEnrolment(source:RegisteredDevice,status='enrolled',kind:GrantKind='voiceprint_enrol'):Promise<void>{await this.leases.consumeEnrolment(source,status,kind);await this.after(source.principal_id);}
  async cancelApproval(source:RegisteredDevice,kind:GrantKind):Promise<void>{await this.leases.cancelApproval(source,kind);await this.after(source.principal_id);}
  private async windows(principal:string):Promise<void>{
    for(const [key,close] of this.payWindows)if(key.startsWith(principal+'\n')){close();this.payWindows.delete(key);}
    if(!this.ports?.openPayWindow||await this.ownerOverrideActive())return;
    const p=this.store.principalPayments(principal).find(p=>p.state==='awaiting_owner'&&p.expires_at_ms>this.now());if(!p||!this.store.policy(principal).voice_enabled)return;
    const devices=await this.ports.devices(principal);if(!this.lockFacts(principal,devices).locks_ok)return;
    for(const device of devices){if(device.principal_id!==principal)continue;const s=this.sources.get(JSON.stringify([principal,device.device_id]));if(!s||!['phone','glasses'].includes(s.device_type)||!await this.leases.valid(s))continue;
      if(this.mustPayment(p.payment_id).state!=='awaiting_owner')return;
      const key=principal+'\n'+s.device_id;
      this.payWindows.set(key,this.ports.openPayWindow({principal_id:principal,device_id:s.device_id,until_ms:p.expires_at_ms,phrases:this.config.voice.pay_phrases},u=>{
        void this.observePayUtterance(principal,u).catch(e=>console.error('PAYMENT_PAY_WINDOW_FAILED',safeCode(e)));
      }));
    }
  }
  private afterErrors(errors:unknown[]):void{if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'PAYMENT_DELIVERY_FAILED');}
  private async after(principal:string,ownerEvidence=true):Promise<void>{
    if(this.closed)return;this.arm();const errors:unknown[]=[];
    for(const [id,wake] of this.polls)if(this.store.getPayment(id)?.principal_id===principal)for(const callback of [...wake])callback();
    for(const [id,abort] of this.verifying)if(this.store.getPayment(id)?.state!=='verifying'){abort.abort();this.verifying.delete(id);}
    for(const watcher of this.watchers)if(watcher.source.principal_id===principal)this.notify(watcher,ownerEvidence);
    try{await this.flushUpdates(ownerEvidence);}catch(error){errors.push(error);}
    try{await this.windows(principal);}catch(error){errors.push(error);}
    this.arm();this.afterErrors(errors);
  }
  private arm():void{
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(this.closed||!this.ports)return;const due:number[]=[];
    for(const row of this.store.db.prepare("SELECT intent_id FROM intents WHERE state<>'closed'").all() as {intent_id:string}[]){const i=this.store.getIntent(row.intent_id)!;
      if(i.state==='open')due.push(i.expires_at_ms);
      for(const p of this.store.payments(i.intent_id))if(!TERMINAL_STATES.includes(p.state)){
        if(p.state==='paying'){const g=this.store.getGrant(p.payment_id)!;if(g.first_tap_at_ms!==null)due.push(g.first_tap_at_ms+this.config.result_timeout_s*1000);}
        else{due.push(p.expires_at_ms);if(p.state==='auto_pending'&&p.auto_at_ms!==null&&(!this.checking||p.auto_at_ms>this.now()))due.push(p.auto_at_ms);if(p.state==='granted')due.push(this.store.getGrant(p.payment_id)!.expires_at_ms);}
      }
    }
    for(const row of this.store.db.prepare("SELECT expires_at_ms FROM payments WHERE order_cancel='pending'").all() as {expires_at_ms:number}[])due.push(row.expires_at_ms+5000);
    const leaseDue=this.leases.nextDeadline();if(leaseDue!==undefined)due.push(leaseDue);
    for(const watcher of this.watchers)if(watcher.retry_at!==undefined&&!watcher.flight)due.push(watcher.retry_at);
    for(const s of this.sources.values())if(s.device_type==='glasses'){const lease=this.terminals.lease(s);if(lease)due.push(lease.max_until);}
    if(due.length){this.timer=setTimeout(()=>{this.timer=undefined;void this.tick().catch(e=>console.error('PAYMENT_TIMER_FAILED',safeCode(e)));},Math.max(0,Math.min(2147483647,Math.min(...due)-this.now())));this.timer.unref();}
  }
  /** Hard deadlines do not await identity, voice, or delivery. They run even during an outstanding auto evaluation. */
  private expireDue():void{
    if(this.closed||!this.ports)return;this.leases.sweep();
    this.store.tx(()=>{
      const rows=this.store.db.prepare("SELECT payment_id FROM payments WHERE state NOT IN ('paid','outcome_unknown','cancelled','expired','superseded','failed')").all() as {payment_id:string}[];
      for(const row of rows){const p=this.mustPayment(row.payment_id),g=this.store.getGrant(p.payment_id);
        if(p.state==='paying'){
          if(g?.first_tap_at_ms!==null&&g?.first_tap_at_ms!==undefined&&this.now()>=g.first_tap_at_ms+this.config.result_timeout_s*1000){this.update(p,{state:'outcome_unknown',finished_at_ms:this.now()});this.store.updateIntent(p.intent_id,{state:'closed',closed_reason:'outcome_unknown'});this.enqueueContext(this.mustPayment(p.payment_id));this.audit(p.principal_id,'result_reported',{grant_id:g.grant_id,outcome:'unknown',reason:'RESULT_TIMEOUT',signs:[]},p);this.changes.add(p.principal_id);}
        }else if(!this.config.enabled){this.terminal(p,'failed','PAYMENT_DISABLED','pending');this.changes.add(p.principal_id);}
        else if(p.expires_at_ms<=this.now()||p.state==='granted'&&g&&g.expires_at_ms<=this.now()){
          const reason=p.state==='granted'&&g&&g.expires_at_ms<=this.now()?'GRANT_UNUSED':'EXPIRED';this.terminal(p,'expired',reason,'pending');this.changes.add(p.principal_id);
          if(reason==='GRANT_UNUSED'&&g)this.audit(p.principal_id,'grant_expired',{grant_id:g.grant_id,method:g.method,device_id:g.device_id,amount_fen:g.amount_fen,expires_at_ms:g.expires_at_ms},p);
        }
      }
      for(const row of this.store.db.prepare("SELECT intent_id FROM intents WHERE state='open' AND expires_at_ms<=?").all(this.now()) as {intent_id:string}[])this.store.updateIntent(row.intent_id,{state:'closed',closed_reason:'expired'});
      for(const row of this.store.db.prepare("SELECT payment_id FROM payments WHERE order_cancel='pending' AND expires_at_ms+5000<=?").all(this.now()) as {payment_id:string}[]){
        const p=this.mustPayment(row.payment_id),done=this.update(p,{order_cancel:'not_attempted'});this.audit(p.principal_id,'order_cancel_result',{outcome:'not_attempted',detail:'EXECUTOR_LOST'},done);
        this.enqueue(done,'closed',{reason:'EXECUTOR_LOST'});this.changes.add(p.principal_id);
      }
    });
    for(const [id,wake] of this.polls)if(this.changes.has(this.store.getPayment(id)!.principal_id))for(const callback of [...wake])callback();
  }
  tick():Promise<void>{
    this.expireDue();if(this.ticking){this.arm();return this.ticking;}
    this.checking=true;this.arm();return this.ticking=this.tickOwned().finally(()=>{this.checking=false;this.ticking=undefined;this.arm();});
  }
  private async tickOwned():Promise<void>{
    if(this.closed||!this.ports)return;const errors:unknown[]=[];
    const rows=this.store.db.prepare("SELECT payment_id FROM payments WHERE state='auto_pending' AND auto_at_ms<=? ORDER BY auto_at_ms").all(this.now()) as {payment_id:string}[];
    for(const row of rows){let p=this.mustPayment(row.payment_id);
      try{
        const i=this.store.getIntent(p.intent_id)!;await this.lease(i.initiating.device_id,p.principal_id);
        const devices=await this.ports.devices(p.principal_id),owner=await this.ownerCurrent(p.principal_id),override=await this.ownerOverrideActive();if(this.closed)return;
        this.expireDue();this.store.tx(()=>{p=this.mustPayment(p.payment_id);if(p.state!=='auto_pending')return;const now=this.now(),d:Decision=override?{kind:'card_only',reason:'VOICE_UNAVAILABLE'}:decideAuto(this.autoFacts(p,this.leaseNow(i.initiating.device_id,p.principal_id),'grant',devices,this.enrolled(owner,i.initiating.device_type),now));
          if(d.kind==='grant')this.grant(p,d,now);else if(d.kind==='card_only'){const next=this.update(p,{state:'awaiting_owner',auto_at_ms:null,reason:d.reason});this.audit(p.principal_id,'auto_reverted',{reason:d.reason},next);}
        });
      }catch(error){
        if(this.closed)return;errors.push(error);
        this.store.tx(()=>{p=this.mustPayment(p.payment_id);if(p.state==='auto_pending'){const next=this.update(p,{state:'awaiting_owner',auto_at_ms:null,reason:'VOICE_UNAVAILABLE'});this.audit(p.principal_id,'auto_reverted',{reason:'VOICE_UNAVAILABLE'},next);}});
      }
      this.changes.add(p.principal_id);
    }
    for(const watcher of this.watchers)this.changes.add(watcher.source.principal_id);
    const changed=[...this.changes];this.changes.clear();
    for(const principal of changed){try{await this.after(principal);}catch(error){errors.push(error);}}
    this.afterErrors(errors);
  }
}
