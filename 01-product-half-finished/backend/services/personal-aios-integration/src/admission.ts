import {ownerActionGrant, isBuildTask, canonical, ContractError, check, digest, guestKey, id, principalAttribution, runScope, validateProcessed, type ProcessedEvent, type OwnerOriginResolver } from './contracts.ts';
import type { StoragePort } from './storage.ts';
import {emitRuntimeEvent} from './self-events.ts';
import type {VoiceConfirmation} from './voiceprint/confirmation.ts';
import { HermesClient, NATIVE_TERMINAL_STATUSES, NativeNotAcceptedError, type NativeClient, type NativeRun, type NativeRunEvent } from './hermes-client.ts';
import {errandExecutionFacts,errandReportRequired} from './output.ts';
import {AdmissionHooks,type PublicCall} from './admission-hooks.ts';

export type AdmissionState = 'pending' | 'submitting' | 'accepted' | 'running' | 'reconcile_required' |
  'retryable' | 'completed' | 'cancelled' | 'expired' | 'failed';
export const NATIVE_STREAM_RECONNECT_MIN_MS = 1000;
export interface AdmissionPolicy {
  max_pending_events: number; max_pending_bytes: number; max_event_age_ms: number;
  native_retry?: {max_attempts: number; initial_backoff_ms: number; max_backoff_ms: number};
  poll_interval_ms: number; native_idempotency_retention_ms: number; policy_version: string;
}
export interface Admission {
  principal_id: string; session_id: string; processed_event_id: string; payload_sha256: string;
  attempt_count?: number; retry_reason?: string; next_attempt_at_ms?: number;
  arrival_seq: number; run_order?: number; state: AdmissionState; idempotency_key: string; run_id?: string;
  created_at_ms: number; deadline_ms: number; policy_version: string; cancel_requested_at_ms?: number; conversation_released?:true;
}
export interface AdmissionEntry {record: Admission; d: ProcessedEvent; skill: string; bytes: number; voice_confirmation?: VoiceConfirmationFact|null|undefined}
// cancelled: durable admission terminal. cancel_requested: durable intent; native stop/reconciliation decides.
export interface CancelReceipt {status: 'cancelled' | 'cancel_requested' | 'already_terminal'; run_id: string | null; state: AdmissionState}
export interface AmendmentReceipt {amendment_id:string;run_id:string;processed_event_id:string;status:'delivered';delivered_to:'delegate'|'parent_replan';delegate_task_ids?:string[]}
interface PendingInput {d: ProcessedEvent; skill: string; voice_confirmation?: VoiceConfirmationFact|null}
interface Attempt {at_ms: number; idempotency_key: string; prior_uncertain?: boolean}
interface Rejection {at_ms: number; code: 'gateway_draining' | 'rate_limit_exceeded'; retry_after_ms: number; next_at_ms: number}
const unsentReasons = ['deadline_exhausted', 'retention_exhausted', 'cancelled_before_send'] as const;
interface LocalUnsent {at_ms: number; local_unsent_reason: typeof unsentReasons[number]}
interface Progress extends Attempt {count: number; first_at_ms: number; uncertain: boolean; rejection?: Rejection; unsent?: LocalUnsent}
interface Binding {run_id: string; session_id: string; run_order?: number}
interface Terminal {status: 'completed' | 'cancelled' | 'expired' | 'failed'; run_id: string | null; admission_reason?: string; native?: NativeRun}
const terminal = new Set(['completed', 'cancelled', 'expired', 'failed']);

/** A confirmation carries its original D evidence, never the uncertain native transcript. Restricted scopes omit location. */
type VoiceConfirmationFact = Pick<VoiceConfirmation,'confirmation_id'|'expires_at_ms'>;
export async function nativeRunInput(d: ProcessedEvent, storage: StoragePort, confirmation: VoiceConfirmationFact|null = null): Promise<{input: string; run_scope?: 'owner_uncertain' | 'guest' | 'build'; guest_key?: string}> {
  if(isBuildTask(d)) {
    const task=d.content.app_event as {kind?:unknown;input?:unknown;build_origin?:unknown};
    check(task?.kind==='build_task'&&typeof task.input==='string','BUILD_INPUT_REQUIRED');
    return {input:canonical({kind:'build_task',input:task.input,build_origin:task.build_origin}),run_scope:'build'};
  }
  if(errandReportRequired(d)) {
    const app=d.content.app_event as unknown as Partial<Pick<import('./runtime.ts').ErrandResult,'success'|'terminal_reason'>>;
    d={...d,content:{...d.content,app_event:{...app,...errandExecutionFacts(app)}}};
  }
  const scope = runScope(d);
  if (scope === 'owner') {
    if (principalAttribution(d) !== 'owner_confirmation') {
      const files = (d.content.attachments ?? []).map(file => {
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const power = file.size ? Math.min(Math.floor(Math.log(file.size) / Math.log(1024)), units.length - 1) : 0;
        const size = `${Number((file.size / 1024 ** power).toFixed(1))} ${units[power]}`;
        return `（用户在电脑上直接给你的文件：${file.name}，${file.kind}，${size}，路径 ${file.path}。这是他授权你处理的，可以直接用电脑工具处理。）`;
      });
      return {input: [canonical(d), ...files].join('\n')};
    }
    const app = d.content.app_event as {confirms_processed_event_id: string};
    const original = JSON.parse(new TextDecoder().decode(await storage.read('processed-events',
      digest({principal_id: d.principal_id, processed_event_id: app.confirms_processed_event_id})))) as ProcessedEvent;
    validateProcessed(original);
    check(original.principal_id === d.principal_id && original.processed_event_id === app.confirms_processed_event_id &&
      runScope(original) === 'owner_uncertain', 'VOICE_CONFIRMATION_SCOPE_DENIED', 403);
    return {input: canonical({...d, content: {...d.content, app_event: {...app, confirmed_request: original}}})};
  }
  const {location: _location, ...source} = d.source;
  return {input: canonical({...d, source, voice_confirmation: scope === 'owner_uncertain' ? confirmation : null}), run_scope: scope, ...(scope === 'guest' ? {guest_key: guestKey(d)} : {})};
}
/** Care has its own native transcript; the conversational session remains its delivery/context binding. */
const careDecision = (d: ProcessedEvent): boolean =>
  d.media_type === 'app_event' && (d.content.app_event as {kind?: unknown} | undefined)?.kind === 'proactive_care';
const executionLane = (entry: AdmissionEntry): string => careDecision(entry.d) ? entry.record.idempotency_key : entry.record.session_id;
// Product authority for D acceptance. Hermes remains the sole executor and session scheduler.
export class RunAdmission {
  private readonly entries = new Map<string, AdmissionEntry>();
  private readonly sessions = new Map<string, string>();
  private readonly executing = new Map<string, Promise<void>>();
  private readonly reentries = new Set<string>();
  // Process-local control inputs for D with a durable cancel intent (cleared at terminal).
  private readonly explicitReplays = new Set<string>();
  private readonly stopsSent = new Set<string>();
  private ownerOrigin:OwnerOriginResolver|undefined;
  setOwnerOrigin(resolve:OwnerOriginResolver):void {check(!this.ownerOrigin,'OWNER_ORIGIN_CONFLICT');this.ownerOrigin=resolve;}
  private voiceConfirmation:((d:ProcessedEvent)=>VoiceConfirmationFact|null)|undefined;
  setVoiceConfirmation(resolve:(d:ProcessedEvent)=>VoiceConfirmationFact|null):void {
    check(!this.voiceConfirmation,'VOICE_CONFIRMATION_RESOLVER_CONFLICT');this.voiceConfirmation=resolve;
  }
  private arrival = 0;
  private closed = false;
  private nativeReady = true;
  private nativeGate:Promise<void> = Promise.resolve();
  private releaseNative:()=>void = ()=>{};
  /** The listening assembly supplies Hermes readiness on its existing maintenance lifecycle. */
  setNativeReady(ready:boolean):void {
    if(this.nativeReady===ready)return;
    this.nativeReady=ready;
    if(ready)this.releaseNative();
    else this.nativeGate=new Promise<void>(resolve=>{this.releaseNative=resolve;});
  }
  private closing: Promise<void> | undefined;
  private readonly owned = new Set<Promise<unknown>>();
  private readonly createAbort = new AbortController();
  private readonly pollWakeups = new Set<() => void>();
  private readonly eventStreams=new Map<string,{abort:AbortController;work:Promise<void>}>();
  private readonly eventPublications=new Map<string,Promise<void>>();
  async drainEvents(run:string):Promise<void> {
    await this.eventStreams.get(run)?.work;this.eventStreams.delete(run);await this.eventPublications.get(run);
  }
  private eventOwner:((entry:AdmissionEntry,event:NativeRunEvent)=>void|Promise<void>)|undefined;
  private eventError:((error:unknown)=>void)|undefined;
  private eventEnd:((entry:AdmissionEntry)=>void)|undefined;
  setEventOwner(owner:(entry:AdmissionEntry,event:NativeRunEvent)=>void|Promise<void>,onError:(error:unknown)=>void,onEnd:(entry:AdmissionEntry)=>void):void {
    this.eventOwner=owner;this.eventError=onError;this.eventEnd=onEnd;
  }
  private emitEvent(entry:AdmissionEntry,event?:NativeRunEvent):void {
    const run=entry.record.run_id!,snapshot=structuredClone(entry),fact=event?structuredClone(event):undefined;
    // Preserve observer order without making presentation a dependency of native progress or terminal delivery.
    const work=(this.eventPublications.get(run)??Promise.resolve()).then(()=>fact?
      this.eventOwner?.(snapshot,fact):this.eventEnd?.(snapshot)).catch(error=>this.eventError?.(error));
    this.eventPublications.set(run,work);this.owned.add(work);
    void work.then(()=>{this.owned.delete(work);if(this.eventPublications.get(run)===work)this.eventPublications.delete(run);});
  }
  private ready: Promise<void> | undefined;
  private readonly restored = new Set<string>();
  private runOwner: ((entry: AdmissionEntry) => Promise<void>) | undefined;
  private catalogGrants:(d:ProcessedEvent)=>string[]=()=>[];
  setCatalogGrants(provider:(d:ProcessedEvent)=>string[]):void{this.catalogGrants=provider;}
  setRunOwner(owner: (entry: AdmissionEntry) => Promise<void>): void {
    check(!this.runOwner, 'ADMISSION_RUN_OWNER_CONFLICT'); this.runOwner=owner;
  }
  private terminalOwner: ((entry: AdmissionEntry, native: NativeRun | undefined) => Promise<void>) | undefined;
  private terminalRetryReady: ((entry:AdmissionEntry,error:unknown)=>Promise<void>|undefined) | undefined;
  setTerminalOwner(owner: (entry: AdmissionEntry, native: NativeRun | undefined) => Promise<void>,
    retryReady?: (entry:AdmissionEntry,error:unknown)=>Promise<void>|undefined): void {
    check(!this.terminalOwner, 'ADMISSION_TERMINAL_OWNER_CONFLICT'); this.terminalOwner=owner;
    this.terminalRetryReady=retryReady;
  }
  private stateOwner: ((entry:AdmissionEntry,native?:NativeRun)=>Promise<void>)|undefined;
  private workOwner:((principal:string)=>void)|undefined;
  private paidAdmission:((entry:AdmissionEntry)=>boolean)|undefined;
  setPaidAdmission(owner:(entry:AdmissionEntry)=>boolean):void {this.paidAdmission=owner;}
  resumePaidWork():void {
    for(const session of new Set([...this.entries.values()].map(entry=>entry.record.session_id)))this.pump(session);
  }
  setWorkOwner(owner:(principal:string)=>void):void {this.workOwner=owner;}
  setStateOwner(owner:(entry:AdmissionEntry,native?:NativeRun)=>Promise<void>):void {
    check(!this.stateOwner,'ADMISSION_STATE_OWNER_CONFLICT');this.stateOwner=owner;
  }
  private emitState(entry:AdmissionEntry,native?:NativeRun):Promise<void> {
    // Existing owned/drain boundary joins publication; native progress never awaits transport.
    const snapshot=structuredClone(entry),observation=native?structuredClone(native):undefined;
    const work=Promise.resolve().then(()=>{this.workOwner?.(entry.d.principal_id);return this.stateOwner?.(snapshot,observation);}).catch(error=>this.eventError?.(error));
    this.owned.add(work);void work.then(()=>this.owned.delete(work));
    return work;
  }
  /** Read projection of this admission owner; detached runs retain their original call identity. */
  work(principal:string,includeDelivery=false):{processed_event_id:string;session_id:string;call_id?:string;turn?:number;background:boolean}[] {
    return [...this.entries.values()].filter(({d,record})=>d.principal_id===principal&&runScope(d)==='owner'&&(includeDelivery||!terminal.has(record.state))).map(({d,record})=>{
      const app=d.content.app_event as {kind?:string;call_id?:string;turn?:number;voice_session_id?:string;voice_turn?:number}|undefined;
      const wake=(d.content.wake_request??app) as {voice_session_id?:string;voice_turn?:number}|undefined;
      const voice=wake?.voice_session_id,call_id=app?.kind==='voice_turn'?app.call_id:voice?(voice.startsWith('manual-')?voice.slice(7):`ambient-${voice}`):undefined;
      const turn=app?.kind==='voice_turn'?app.turn:wake?.voice_turn;
      return {processed_event_id:d.processed_event_id,session_id:record.session_id,...(call_id?{call_id,...(turn===undefined?{}:{turn})}:{}),background:record.conversation_released===true};
    });
  }
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly storage: StoragePort;
  private readonly native: NativeClient;
  private readonly policy: AdmissionPolicy;
  private readonly hooks:AdmissionHooks;
  private async hookEntry(key:string):Promise<AdmissionEntry|undefined>{
    const active=this.entries.get(key);if(active)return structuredClone(active);
    const record=await this.loadRecord(key),input=await this.read<PendingInput>('admission-inputs',key);
    return record&&input?{record,d:input.d,skill:input.skill,bytes:Buffer.byteLength(canonical(input))}:undefined;
  }
  async observeHook(body:unknown):Promise<Admission|undefined>{
    await this.initialize();const key=await this.hooks.event(body);
    return key?structuredClone(this.entries.get(key)?.record??await this.loadRecord(key)):undefined;
  }
  async hookBinding(call:PublicCall,execution=false):Promise<AdmissionEntry>{
    await this.initialize();const entry=await this.hookEntry(await this.hooks.resolve(call,execution));
    check(entry?.record.run_id,'CAPABILITY_RUN_BINDING_REQUIRED',403);return entry;
  }
  constructor(storage: StoragePort, native: NativeClient, policy: AdmissionPolicy) {
    check(native instanceof HermesClient, 'NATIVE_CLIENT_AUTHORITY_REQUIRED');
    this.storage = storage; this.native = native; this.policy = Object.freeze({...policy, ...(policy.native_retry ? {native_retry: Object.freeze({...policy.native_retry})} : {})});
    this.hooks=new AdmissionHooks(storage,native.hookProfile);
    for (const [key, value] of Object.entries(policy)) {
      if (key !== 'policy_version' && key !== 'native_retry') check(Number.isSafeInteger(value) && (value as number) > 0, 'INVALID_ADMISSION_BUDGET');
    }
    check(typeof policy.policy_version === 'string' && policy.policy_version.length > 0, 'INVALID_ADMISSION_POLICY');
    if (policy.native_retry !== undefined) {
      const retry = this.policy.native_retry!;
      check(retry && Object.keys(retry).length === 3 && ['max_attempts', 'initial_backoff_ms', 'max_backoff_ms']
        .every(key => Number.isSafeInteger(retry[key as keyof typeof retry]) && retry[key as keyof typeof retry] > 0) &&
        retry.max_backoff_ms >= retry.initial_backoff_ms && retry.max_backoff_ms <= 2147483647,
        'INVALID_NATIVE_RETRY_POLICY');
    }
  }
  get outputBudget():number {return this.policy.max_pending_events;}
  get replayWindowMs():number {return Math.max(this.policy.native_idempotency_retention_ms,this.policy.max_event_age_ms);}
  private key(principal: string, session: string, processedId: string): string {
    return digest({principal_id: principal, session_id: session, processed_event_id: processedId});
  }
  private hash(d: ProcessedEvent, session: string, skill: string): string {
    return digest({d, session_id: session, skill_sha256: digest(skill)});
  }
  private async read<T>(namespace: string, key: string): Promise<T | undefined> {
    try { return JSON.parse(new TextDecoder().decode(await this.storage.read(namespace, key))) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async publish<T>(namespace: string, key: string, value: T): Promise<T> {
    const saved = JSON.parse(new TextDecoder().decode(await this.storage.publish(namespace, key,
      Buffer.from(canonical(value))))) as T;
    check(canonical(saved) === canonical(value), 'ADMISSION_IMMUTABLE_CONFLICT', 409);
    return saved;
  }
  private async loadRecord(key: string): Promise<Admission | undefined> {
    const saved = await this.read<Admission>('admissions', key);
    if (!saved) return undefined;
    id(saved.principal_id); id(saved.session_id); id(saved.processed_event_id);
    check(this.key(saved.principal_id, saved.session_id, saved.processed_event_id) === key &&
      /^[a-f0-9]{64}$/u.test(saved.payload_sha256) && saved.idempotency_key === `paios:${key}` &&
      saved.state === 'pending' && Number.isSafeInteger(saved.arrival_seq) &&
      Number.isSafeInteger(saved.created_at_ms) && Number.isSafeInteger(saved.deadline_ms) &&
      saved.deadline_ms >= saved.created_at_ms, 'ADMISSION_RECORD_INTEGRITY_FAILURE', 503);
    const assigned = await this.read<{session_id: string}>('d-session-bindings',
      digest({principal_id: saved.principal_id, processed_event_id: saved.processed_event_id}));
    check(assigned?.session_id === saved.session_id, 'ADMISSION_SESSION_ASSIGNMENT_CONFLICT', 503);
    const record = {...saved};
    const detached=await this.read<{run_id:string}>('run-conversation-releases',key);
    const intent = await this.read<unknown>('run-cancel-intents', key);
    if (intent !== undefined) record.cancel_requested_at_ms = this.intentAt(intent);
    const binding = await this.read<Binding>('run-bindings', key);
    if(detached){check(binding?.run_id===detached.run_id,'ADMISSION_RELEASE_BINDING_CONFLICT',503);record.conversation_released=true;}
    if (binding) {
      check(typeof binding.run_id === 'string' && binding.session_id === record.session_id,
        'NATIVE_RUN_BINDING_CONFLICT', 503);
      if (binding.run_order !== undefined) check(Number.isSafeInteger(binding.run_order) && binding.run_order > 0,
        'NATIVE_RUN_BINDING_CONFLICT', 503);
      if (binding.run_order !== undefined) record.run_order = binding.run_order;
      record.run_id = binding.run_id;
      record.state = 'accepted';
    }
    const ended = await this.read<Terminal>('run-terminals', key);
    if (ended) {
      check(terminal.has(ended.status) && ended.run_id === (binding?.run_id ?? null), 'ADMISSION_TERMINAL_CONFLICT', 503);
      record.state = ended.status;
      if (ended.admission_reason) record.retry_reason = ended.admission_reason;
    } else if (!binding) {
      const progress = await this.readAttempt(key, record);
      if (progress) {
        record.attempt_count = progress.count - (progress.unsent ? 1 : 0);
        record.state = progress.uncertain ? 'reconcile_required' : 'retryable';
        record.retry_reason = progress.uncertain ? 'acceptance_unknown' : progress.unsent?.local_unsent_reason ?? 'native_not_accepted';
        if (!progress.uncertain && progress.rejection) record.next_attempt_at_ms = progress.rejection.next_at_ms;
      }
    }
    return record;
  }
  private intentAt(intent: unknown): number {
    const at = (intent as {at_ms?: unknown} | null)?.at_ms;
    check(Object.keys(intent ?? {}).length === 1 && Number.isSafeInteger(at), 'ADMISSION_CANCEL_INTENT_CONFLICT', 503);
    return at as number;
  }
  private async loadEntry(key: string, record: Admission): Promise<AdmissionEntry> {
    const input = await this.read<PendingInput>('admission-inputs', key);
    check(input?.d && typeof input.skill === 'string', 'ADMISSION_RECOVERY_DATA_MISSING', 503);
    const {d, skill} = input;
    validateProcessed(d);
    check(d.principal_id === record.principal_id && d.processed_event_id === record.processed_event_id &&
      record.payload_sha256 === this.hash(d, record.session_id, skill), 'ADMISSION_RECORD_INTEGRITY_FAILURE', 503);
    const entry={record, d, skill, voice_confirmation:input.voice_confirmation, bytes: Buffer.byteLength(canonical(input))};
    return entry;
  }
  private attemptKey(key: string, count: number): string {
    return count === 1 ? key : digest({admission: key, attempt_seq: count});
  }
  private async readAttempt(key: string, record: Admission): Promise<Progress | undefined> {
    let last: Progress | undefined; let uncertain = false;
    for (let count = 1; ; count++) {
      const attemptKey = this.attemptKey(key, count);
      const attempt = await this.read<Attempt>('run-attempts', attemptKey);
      if (!attempt) return last;
      check(Number.isSafeInteger(attempt.at_ms) && attempt.at_ms >= (last?.at_ms ?? record.created_at_ms) &&
        attempt.idempotency_key === record.idempotency_key &&
        (count === 1 || attempt.prior_uncertain === uncertain), 'ADMISSION_ATTEMPT_CONFLICT', 503);
      const result = await this.read<Rejection | LocalUnsent>('run-attempt-results', attemptKey);
      const rejection = result && 'code' in result ? result as Rejection : undefined;
      const unsent = result && 'local_unsent_reason' in result ? result as LocalUnsent : undefined;
      if (result) check(Number.isSafeInteger(result.at_ms) && result.at_ms >= attempt.at_ms &&
        Boolean(rejection) !== Boolean(unsent), 'ADMISSION_ATTEMPT_RESULT_CONFLICT', 503);
      if (unsent) check(Object.keys(unsent).length === 2 &&
        unsentReasons.includes(unsent.local_unsent_reason) &&
        (unsent.local_unsent_reason !== 'cancelled_before_send' || record.cancel_requested_at_ms !== undefined),
        'ADMISSION_UNSENT_CONFLICT', 503);
      if (rejection) check(Number.isSafeInteger(rejection.at_ms) && rejection.at_ms >= attempt.at_ms &&
        ['gateway_draining', 'rate_limit_exceeded'].includes(rejection.code) &&
        Number.isSafeInteger(rejection.retry_after_ms) && rejection.retry_after_ms >= 0 &&
        Number.isSafeInteger(rejection.next_at_ms) && rejection.next_at_ms >= rejection.at_ms,
        'ADMISSION_REJECTION_CONFLICT', 503);
      uncertain ||= !result;
      last = {...attempt, count, first_at_ms: last?.first_at_ms ?? attempt.at_ms, uncertain, ...(rejection ? {rejection} : {}), ...(unsent ? {unsent} : {})};
    }
  }
  private async pause(until: number|Promise<void>): Promise<void> {
    if (this.closed) return;
    await new Promise<void>(resolve => {
      const wake = () => {clearTimeout(timer); this.pollWakeups.delete(wake); resolve();};
      let timer:ReturnType<typeof setTimeout>|undefined;this.pollWakeups.add(wake);
      if(typeof until==='number')timer=setTimeout(wake,Math.min(until,2147483647));
      else void until.then(wake);
    });
  }
  // Called by the owning server listen lifecycle. Inspection remains passive.
  recover(): Promise<void> {return this.own(async()=>{try{await this.initialize();}finally{await this.resume();}});}
  private initialize(): Promise<void> {
    this.ready ??= this.restore().catch(error=>{this.ready=undefined;throw error;});
    return this.ready;
  }
  private async restore(): Promise<void> {
    const errors:unknown[]=[];
    // Scan every durable identity before admitting another D; never truncate unresolved barriers.
    for (const key of await this.storage.list('admissions')) {
      if(this.closed)return;
      if(this.restored.has(key))continue;
      try {
      const record = await this.loadRecord(key);
      check(record, 'ADMISSION_RECOVERY_DATA_MISSING', 503);
      this.arrival = Math.max(this.arrival, record.arrival_seq, record.run_order ?? 0);
      if (terminal.has(record.state)) {
        if (await this.read<PendingInput>('admission-inputs',key)) {
          const ended=await this.read<Terminal>('run-terminals',key);
          const entry=await this.loadEntry(key,record);
          await this.nativeGate;
          if(this.closed)return;
          if(record.run_id)await this.runOwner?.(entry);
          await this.finalize(key,entry,ended?.native);
        }
        this.restored.add(key);
        continue;
      }
      const entry = await this.loadEntry(key, record);
      this.reserve(entry.bytes, 503);
      if (!record.conversation_released&&(['reconcile_required', 'retryable'].includes(entry.record.state) || entry.record.run_id)) {
        const owner = this.sessions.get(executionLane(entry));
        check(owner === undefined || owner === key, 'ADMISSION_MULTIPLE_SESSION_BARRIERS', 503);
        this.sessions.set(executionLane(entry), key);
      }
      this.entries.set(key, entry);this.restored.add(key);
      }catch(error){errors.push(error);}
    }
    await this.resume();
    // Ingress still fails closed until all durable barriers are known; healthy records can recover independently.
    if(errors.length===1)throw errors[0];
    if(errors.length>1)throw new AggregateError(errors,'ADMISSION_RECOVERY_INCOMPLETE');
    this.restored.clear();
  }
  private async resume():Promise<void> {
    for (const [key, entry] of this.entries) {
      if(this.executing.has(key))continue;
      // Bound D re-issue native stop from their poll loop; durable-unsent D finish cancelled locally.
      if (entry.record.run_id) this.start(key, entry);
      // A failed terminal write keeps it start-guarded; a repeated cancel or restart finishes it.
      else if (this.unsentCancel(entry)) await this.cancelUnsent(key, entry).catch(() => undefined);
      else if (this.policy.native_retry && (entry.record.state === 'retryable' ||
          entry.record.state === 'reconcile_required' &&
          (entry.record.attempt_count ?? 0) < this.policy.native_retry.max_attempts)) this.start(key, entry);
      else if (entry.record.state === 'pending') this.pump(entry.record.session_id);
    }
  }
  private reserve(bytes: number, status = 429): void {
    check(this.entries.size < this.policy.max_pending_events &&
      [...this.entries.values()].reduce((n, entry) => n + entry.bytes, 0) + bytes <= this.policy.max_pending_bytes,
      status === 503 ? 'ADMISSION_RECOVERY_CAPACITY_EXCEEDED' : 'ADMISSION_CAPACITY_EXCEEDED', status);
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private own<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ContractError('ADMISSION_CLOSED', 503));
    const work = operation();
    this.owned.add(work);
    void work.then(() => this.owned.delete(work), () => this.owned.delete(work));
    return work;
  }
  admit(d: ProcessedEvent, sessionId: string, skill: string): Promise<Admission> {
    return this.own(() => this.admitOwned(d, sessionId, skill));
  }
  private async admitOwned(d: ProcessedEvent, sessionId: string, skill: string): Promise<Admission> {
    check(!this.closed, 'ADMISSION_CLOSED', 503); validateProcessed(d); id(sessionId);
    check(skill.length > 0, 'FIXED_SKILL_EMPTY', 500);
    await this.initialize();
    return this.serialized(async () => {
      check(!this.closed, 'ADMISSION_CLOSED', 503);
      const key = this.key(d.principal_id, sessionId, d.processed_event_id);
      const hash = this.hash(d, sessionId, skill);
      const previous = this.entries.get(key);
      const previousRecord = previous?.record ?? await this.loadRecord(key);
      if (previousRecord) {
        // The first admission keeps the skill it was admitted with. A replay under a redeployed skill fingerprints differently,
        // so it must carry the durable D itself (processed-events, first writer); any other payload still conflicts.
        check(previousRecord.payload_sha256 === hash || canonical(await this.read<ProcessedEvent>('processed-events',
          digest({principal_id: d.principal_id, processed_event_id: d.processed_event_id})) ?? null) === canonical(d), 'D_ID_PAYLOAD_CONFLICT', 409);
        if (previous && ['retryable', 'reconcile_required'].includes(previous.record.state)) this.start(key, previous);
        return {...previousRecord};
      }
      // First native input survives lost acceptance, pending-card expiry and a restart unchanged.
      const pending:PendingInput = await this.read<PendingInput>('admission-inputs',key) ?? {d,skill,
        ...(runScope(d)==='owner_uncertain'?{voice_confirmation:structuredClone(this.voiceConfirmation?.(d)??null)}:{})};
      check(canonical({d:pending.d,skill:pending.skill})===canonical({d,skill}),'ADMISSION_IMMUTABLE_CONFLICT',409);
      const bytes = Buffer.byteLength(canonical(pending));
      const assigned = await this.read<{session_id: string}>('d-session-bindings',
        digest({principal_id: d.principal_id, processed_event_id: d.processed_event_id}));
      check(assigned === undefined || assigned.session_id === sessionId, 'D_SESSION_CONFLICT', 409);
      this.reserve(bytes);
      const assignment = await this.storage.publish('d-session-bindings',
        digest({principal_id: d.principal_id, processed_event_id: d.processed_event_id}),
        Buffer.from(canonical({session_id: sessionId})));
      check(JSON.parse(new TextDecoder().decode(assignment)).session_id === sessionId, 'D_SESSION_CONFLICT', 409);
      const now = Date.now();
      // Age bounds requests. A finished errand is a fact the main agent still has to learn after its conversation's
      // current run ends, however long that run takes; only the native replay window bounds it.
      const errandResult = d.origin === 'device_observation' && (d.content.app_event as {kind?: unknown} | undefined)?.kind === 'errand_result';
      const record: Admission = {principal_id: d.principal_id, session_id: sessionId,
        processed_event_id: d.processed_event_id, payload_sha256: hash, arrival_seq: ++this.arrival,
        state: 'pending', idempotency_key: `paios:${key}`, created_at_ms: now,
        deadline_ms: now + (errandResult ? this.policy.native_idempotency_retention_ms : this.policy.max_event_age_ms), policy_version: this.policy.policy_version};
      await this.publish('admission-inputs', key, pending);
      await this.publish('admissions', key, record);
      const entry:AdmissionEntry = {record,d:pending.d,skill:pending.skill,voice_confirmation:pending.voice_confirmation,bytes};
      this.entries.set(key, entry);
      if(this.sessions.has(executionLane(entry)))this.callStage(entry,'brain_session_wait');
      this.pump(sessionId);
      return {...record};
    });
  }
  private callStage(entry:AdmissionEntry,stage:string,native?:NativeRun):void {
    const turn=entry.d.content.app_event as {kind?:string;call_id?:string;turn?:number;route?:string;handoff?:unknown}|undefined;
    if(turn?.kind==='voice_turn')emitRuntimeEvent({call_stage:stage,
      ...(stage==='brain_native_accepted'&&turn.route==='handoff'?{voice_call_stage:'handoff_dispatched',handoff:turn.handoff}:{}),
      call_id:turn.call_id,turn:turn.turn,
      processed_event_id:entry.d.processed_event_id,session_id:entry.record.session_id,run_id:native?.run_id,
      native_status:native?.status,admission_elapsed_ms:Date.now()-entry.record.created_at_ms,at:Date.now()});
  }
  private pump(session: string): void {
    if (this.closed) return;
    const candidates = [...this.entries.entries()].filter(([, entry]) => entry.record.session_id === session &&
      ['pending', 'retryable'].includes(entry.record.state) && !this.unsentCancel(entry) && !this.sessions.has(executionLane(entry)));
    candidates.sort((a, b) => Number(b[1].d.origin === 'explicit_user_prompt') -
      Number(a[1].d.origin === 'explicit_user_prompt') || a[1].record.arrival_seq - b[1].record.arrival_seq);
    for (const [key, entry] of candidates) if (!this.sessions.has(executionLane(entry)) &&
      (!entry.d.replaces_processed_event_id || ![...this.entries.values()].some(p => p.d.processed_event_id === entry.d.replaces_processed_event_id)))
      this.start(key, entry);
  }
  // A provably unsent D with a cancel intent is finished by its cancel owner and never started.
  private unsentCancel(entry: AdmissionEntry): boolean {
    return entry.record.cancel_requested_at_ms !== undefined && !entry.record.run_id &&
      ['pending', 'retryable'].includes(entry.record.state);
  }
  private start(key: string, entry: AdmissionEntry): void {
    if (this.closed || !this.nativeReady || !this.executing.has(key) && this.unsentCancel(entry)) return;
    if (this.executing.has(key)) {
      if (['retryable', 'reconcile_required'].includes(entry.record.state)) this.reentries.add(key);
      return;
    }
    if(!entry.record.run_id&&['pending','retryable'].includes(entry.record.state)&&this.paidAdmission&&!this.paidAdmission(entry))return;
    const owner = entry.record.conversation_released?undefined:this.sessions.get(executionLane(entry));
    if (owner !== undefined && owner !== key) return;
    if(!entry.record.conversation_released)this.sessions.set(executionLane(entry), key);
    const work = this.execute(key, entry).catch(async () => {
      if (!terminal.has(entry.record.state)) {entry.record.state = 'reconcile_required';this.emitState(entry);}
    }).finally(async () => {
      this.emitState(entry);
      this.executing.delete(key);
      if (this.reentries.delete(key) && ['retryable', 'reconcile_required'].includes(entry.record.state)) this.start(key, entry);
      if (!this.sessions.has(executionLane(entry)) && entry.record.state !== 'retryable') this.pump(entry.record.session_id);
    });
    this.executing.set(key, work);
    this.owned.add(work);
    void work.then(() => this.owned.delete(work));
  }
  private async execute(key: string, entry: AdmissionEntry): Promise<void> {
    const {record, d, skill} = entry;
    if(record.run_id)await this.runOwner?.(entry);
    if (!record.run_id) {
      const input = await nativeRunInput(d, this.storage, entry.voice_confirmation ?? null);
      // Hermes has no non-creating lookup by Idempotency-Key: a replay of a never-accepted D would start
      // a cancelled request. With a cancel intent only one explicit reconcile authorizes one same-key replay.
      let explicit = this.explicitReplays.delete(key);
      let progress = await this.readAttempt(key, record);
      let native: NativeRun;
      while (true) {
        record.attempt_count = (progress?.count ?? 0) - (progress?.unsent ? 1 : 0);
        if (record.cancel_requested_at_ms !== undefined && !progress?.uncertain) {await this.cancelUnsent(key, entry); return;}
        if (record.cancel_requested_at_ms !== undefined && !explicit) {
          record.state = 'reconcile_required'; record.retry_reason ??= 'acceptance_unknown'; return;
        }
        // Earlier unknown acceptance is never cleared by a later pre-handler draining refusal.
        if (progress?.uncertain && Date.now() - progress.first_at_ms >= this.policy.native_idempotency_retention_ms) {
          record.state = 'reconcile_required'; record.retry_reason = 'uncertain_retention_expired'; return;
        }
        if (progress?.unsent && !progress.uncertain) {
          record.retry_reason = progress.unsent.local_unsent_reason;
          await this.finish(key, entry, record.retry_reason === 'cancelled_before_send' ? 'cancelled' : 'expired'); return;
        }
        if (progress?.uncertain && Date.now() >= record.deadline_ms) {
          record.state = 'reconcile_required'; record.retry_reason = 'uncertain_deadline_exhausted'; return;
        }
        if (!progress?.uncertain && Date.now() >= record.deadline_ms) {
          record.retry_reason = 'deadline_exhausted'; await this.finish(key, entry, 'expired'); return;
        }
        const retry = this.policy.native_retry;
        if (progress?.uncertain && (retry || progress.rejection)) {
          const backoff = retry ? Math.min(retry.max_backoff_ms,
            retry.initial_backoff_ms * 2 ** Math.min(progress.count - 1, 30)) : 0;
          const next = Math.max(progress.at_ms + backoff, progress.rejection?.next_at_ms ?? 0);
          await this.pause(Math.min(Math.max(0, next - Date.now()), Math.max(0, record.deadline_ms - Date.now()),
            Math.max(0, progress.first_at_ms + this.policy.native_idempotency_retention_ms - Date.now())));
          if (this.closed) return;
          if (Date.now() < next || Date.now() >= record.deadline_ms ||
              Date.now() >= progress.first_at_ms + this.policy.native_idempotency_retention_ms) continue;
        }
        if (progress && !progress.uncertain) {
          record.state = 'retryable'; record.next_attempt_at_ms = progress.rejection!.next_at_ms;
          if (Date.now() - progress.first_at_ms >= this.policy.native_idempotency_retention_ms ||
              (retry && progress.count >= retry.max_attempts)) {
            record.retry_reason = retry && progress.count >= retry.max_attempts ? 'attempts_exhausted' : 'retention_exhausted';
            await this.finish(key, entry, record.retry_reason === 'attempts_exhausted' ? 'failed' : 'expired');
            return;
          }
          record.retry_reason = 'native_not_accepted';
          await this.pause(Math.min(Math.max(0, progress.rejection!.next_at_ms - Date.now()),
            Math.max(0, record.deadline_ms - Date.now()),
            Math.max(0, progress.first_at_ms + this.policy.native_idempotency_retention_ms - Date.now())));
          if (this.closed) return;
          const wokeAt = Date.now();
          if (wokeAt < progress.rejection!.next_at_ms || wokeAt >= record.deadline_ms ||
              wokeAt >= progress.first_at_ms + this.policy.native_idempotency_retention_ms) continue;
        }
        // Resolve producer-owned authorization before recording a native attempt. A preparation failure
        // has not reached native and must not consume retries or imply unknown acceptance.
        const handoff = (d.content.app_event as {handoff?: {thinking?: unknown}} | undefined)?.handoff;
        if (handoff !== undefined) check(handoff.thinking === 'enabled' || handoff.thinking === 'disabled', 'INVALID_HANDOFF_THINKING');
        const body = {...input, grant_toolsets: [...new Set([...await ownerActionGrant(d, this.ownerOrigin),...this.catalogGrants(d)])], instructions: skill, session_id: record.session_id,
          ...(['background_scheduled', 'background_place'].includes(d.source.channel) ? {turn_budget: 'background' as const} : {}),
          ...(handoff ? {model_options: {reasoning: {enabled: handoff.thinking === 'enabled'}}} : {}),
          ...(careDecision(d) ? {care_decision: true as const, model_options: {reasoning: {enabled: false as const}}} : {})};
        const count = (progress?.count ?? 0) + 1;
        await this.hooks.reserve(key,body.session_id,body.input);
        const attemptKey = this.attemptKey(key, count);
        await this.publish('run-attempts', attemptKey, {at_ms: Date.now(), idempotency_key: record.idempotency_key,
          ...(count > 1 ? {prior_uncertain: progress!.uncertain} : {})});
        record.attempt_count = count;
        if (this.closed) {record.state = 'reconcile_required'; record.retry_reason = 'acceptance_unknown'; return;}
        // Preparation can cross an eligibility boundary during real filesystem sync; it is not a send.
        // The cancel intent is read synchronously with the send decision: no await separates them.
        const preparedAt = Date.now();
        const unsentReason = record.cancel_requested_at_ms !== undefined && !(progress?.uncertain && explicit) ? 'cancelled_before_send' :
          preparedAt >= record.deadline_ms ? 'deadline_exhausted' :
          progress && preparedAt >= progress.first_at_ms + this.policy.native_idempotency_retention_ms ? 'retention_exhausted' : undefined;
        if (unsentReason) {
          await this.publish('run-attempt-results', attemptKey, {at_ms: preparedAt, local_unsent_reason: unsentReason});
          record.attempt_count = count - 1;
          record.retry_reason = progress?.uncertain ? 'prior_acceptance_unknown' : unsentReason;
          if (progress?.uncertain) record.state = 'reconcile_required';
          else await this.finish(key, entry, unsentReason === 'cancelled_before_send' ? 'cancelled' : 'expired');
          return;
        }
        record.state = 'submitting'; delete record.next_attempt_at_ms; delete record.retry_reason; explicit = false;
        try {
          // Native memory writes are permitted only for a D attributable to its principal; a restricted run scope
          // (uncertain owner voice, guest) is enforced by the native producer and acknowledged on acceptance.
          this.callStage(entry,'brain_native_submit');
          native = await this.native.create(body, record.idempotency_key, this.createAbort.signal);
          this.callStage(entry,'brain_native_accepted',native);
          break;
        } catch (error) {
          if (!(error instanceof NativeNotAcceptedError)) {
            record.state = 'reconcile_required'; record.retry_reason = 'acceptance_unknown';
            progress = await this.readAttempt(key, record);
            if (!retry || count >= retry.max_attempts || this.closed) return;
            continue;
          }
          const now = Date.now();
          const backoff = retry ? Math.min(retry.max_backoff_ms,
            retry.initial_backoff_ms * 2 ** Math.min(count - 1, 30)) : 0;
          await this.publish('run-attempt-results', attemptKey, {at_ms: now, code: error.nativeCode,
            retry_after_ms: error.retryAfterMs, next_at_ms: now + Math.max(backoff, error.retryAfterMs)});
          progress = await this.readAttempt(key, record);
          record.state = progress!.uncertain ? 'reconcile_required' : 'retryable';
          record.retry_reason = progress!.uncertain ? 'prior_acceptance_unknown' : 'native_not_accepted';
          record.next_attempt_at_ms = progress!.rejection!.next_at_ms;
          // A definitive refusal leaves the D unaccepted; the loop head applies an intent that arrived in flight.
          if (record.cancel_requested_at_ms !== undefined) continue;
          if (!retry || this.closed || progress!.uncertain && count >= retry.max_attempts) return;
        }
      }
      // The existing sequence authority orders committed native bindings, not queue priority.
      const existing = await this.read<Binding>('run-bindings', key);
      check(!existing || existing.run_id === native.run_id && existing.session_id === record.session_id,
        'NATIVE_RUN_BINDING_CONFLICT', 503);
      const bound = existing ?? await this.publish('run-bindings', key,
        {run_id: native.run_id, session_id: record.session_id, run_order: ++this.arrival});
      if (bound.run_order !== undefined) record.run_order = bound.run_order;
      await this.hooks.accepted(key,native.session_id);
      record.run_id = bound.run_id; record.state = 'accepted';
      await this.runOwner?.(entry);
      this.emitState(entry);
      if(!NATIVE_TERMINAL_STATUSES.has(native.status)) {
        record.state='running';this.emitState(entry);
      }
    }
    let approvalState=canonical([null,[],null]),seq=0;
    const applyRun=async(native:NativeRun,fromStream=false)=>{
      // Native final-response and memory receipts are enriched by its authoritative GET.
      if(fromStream&&NATIVE_TERMINAL_STATUSES.has(native.status))
        native=await this.native.status(record.run_id!,{conversation_session_id:record.session_id});
      const released=native.turn_exit_reason==='delegation_waiting'&&!record.conversation_released;
      if(released){
        await this.publish('run-conversation-releases',key,{run_id:record.run_id});record.conversation_released=true;
        if(this.sessions.get(executionLane(entry))===key)this.sessions.delete(executionLane(entry));this.pump(record.session_id);
      }
      const next=canonical([native.approval??null,native.approval_results??[],native.turn_exit_reason==='delegation_waiting'?native.output??null:null]);
      if(next!==approvalState||released){this.emitState(entry,native);approvalState=next;}
      if(NATIVE_TERMINAL_STATUSES.has(native.status)){
        await this.finish(key,entry,['interrupted','canceled'].includes(native.status)?'cancelled':native.status as Terminal['status'],native);
      }else if(record.state!=='running'){record.state='running';this.emitState(entry);}
    };
    while(!this.closed&&!terminal.has(record.state)){
      if(record.cancel_requested_at_ms!==undefined&&!this.stopsSent.has(key))await this.stop(key,record);
      if(this.closed)break;
      const abort=new AbortController();
      const stream=this.native.events(record.run_id!,async event=>{
        seq=event.seq!;
        if(event.run)await applyRun(event.run,true);
        this.emitEvent(entry,event);
      },abort.signal,seq,{conversation_session_id:record.session_id});
      this.eventStreams.set(record.run_id!,{abort,work:stream});
      try {await stream;} catch(error){if(!this.closed&&!abort.signal.aborted)this.eventError?.(error);}
      this.eventStreams.delete(record.run_id!);
      if(this.closed||terminal.has(record.state))break;
      // EOF is a transport observation. Only the same native authority can settle the run.
      record.state='reconcile_required';this.emitState(entry);
      try {
        const recovered=await this.native.status(record.run_id!,{conversation_session_id:record.session_id});
        await applyRun(recovered);
        if(recovered.activity_events)this.emitEvent(entry,{event:'run.snapshot',run_id:record.run_id!,timestamp:Date.now()/1000,run:recovered,activity_events:recovered.activity_events});
      }
      catch(error){if(!this.closed)this.eventError?.(error);}
      if(!this.closed&&!terminal.has(record.state))await this.pause(Math.max(NATIVE_STREAM_RECONNECT_MIN_MS,this.policy.poll_interval_ms));
    }
    if(terminal.has(record.state))this.emitEvent(entry);
  }

  private async finish(key: string, entry: AdmissionEntry, status: Terminal['status'], native?:NativeRun): Promise<void> {
    await this.publish('run-terminals', key, {status, run_id: entry.record.run_id ?? null,
      ...(entry.record.retry_reason ? {admission_reason: entry.record.retry_reason} : {}),...(native?{native}:{})});
    entry.record.state = status;
    this.emitState(entry,native);
    await this.finalize(key,entry,native);
    this.entries.delete(key); this.explicitReplays.delete(key); this.stopsSent.delete(key);
    this.workOwner?.(entry.d.principal_id);
    if (this.sessions.get(executionLane(entry)) === key) this.sessions.delete(executionLane(entry));
    this.pump(entry.record.session_id);
  }
  private finalize(key:string,entry:AdmissionEntry,native?:NativeRun):Promise<void> {
    // The retained admission input is the durable output obligation; terminal recovery never executes it.
    const first=Promise.withResolvers<void>();
    const output=(async()=>{
      for(let attempt=0;;attempt++){
        let ready:Promise<void>|undefined;
        try {
          await this.nativeGate;
          if(this.closed)return;
          await this.terminalOwner?.(structuredClone(entry),native?structuredClone(native):undefined);
          await this.storage.removePending(key);
          return;
        } catch(error) {
          if(this.closed)return;
          ready=this.terminalRetryReady?.(entry,error);
        } finally {first.resolve();}
        // Delivery recovery keeps the same retained input, but releases native execution after the first attempt.
        await this.pause(ready??Math.min(30000,Math.max(NATIVE_STREAM_RECONNECT_MIN_MS,this.policy.poll_interval_ms)*2**Math.min(attempt,5)));
        if(this.closed)return;
      }
    })();
    this.owned.add(output);void output.then(()=>this.owned.delete(output));return first.promise;
  }
  private async cancelUnsent(key: string, entry: AdmissionEntry): Promise<void> {
    entry.record.retry_reason = 'cancelled_before_send'; delete entry.record.next_attempt_at_ms;
    await this.finish(key, entry, 'cancelled');
  }
  private async stop(key: string, record: Admission): Promise<void> {
    this.stopsSent.add(key);
    // A failed stop remains durable and is retried when the native stream reconnects.
    try { await this.native.cancel(record.run_id!, {conversation_session_id: record.session_id}); }
    catch { this.stopsSent.delete(key); }
  }
  find(runId: string, sessionId?: string): AdmissionEntry | undefined {
    const entry = [...this.entries.values()].find(e => e.record.run_id === runId && (sessionId===undefined||e.record.session_id === sessionId));
    return entry ? structuredClone(entry) : undefined;
  }
  modelUsageSource(runId:string,sessionId:string):AdmissionEntry|undefined {
    const bound=runId?this.find(runId,sessionId):undefined;if(bound)return bound;
    const pending=[...this.entries.values()].filter(entry=>entry.record.session_id===sessionId&&
      !entry.record.run_id&&entry.record.state==='submitting');
    return pending.length===1?structuredClone(pending[0]):undefined;
  }
  taskTargets(principal:string) {
    return [...this.entries.values()].filter(e=>e.record.principal_id===principal&&
      e.record.run_id&&!terminal.has(e.record.state)).map(e=>({run_id:e.record.run_id!,session_id:e.record.session_id,processed_event_id:e.record.processed_event_id,
      state:e.record.state,request:e.d.content}));
  }
  async pendingAmendments(principal:string) {
    const pending:{amendment_id:string;run_id:string;session_id:string;processed_event_id:string;text:string}[]=[];
    for(const key of await this.storage.list('run-amendment-intents')){
      const intent=await this.read<{amendment_id:string;principal_id:string;session_id:string;run_id:string;processed_event_id:string;text:string}>('run-amendment-intents',key);
      if(intent?.principal_id===principal&&!await this.read('run-amendment-receipts',key))
        pending.push({amendment_id:intent.amendment_id,run_id:intent.run_id,session_id:intent.session_id,processed_event_id:intent.processed_event_id,text:intent.text});
    }
    return pending;
  }
  async reconcileAmendment(principal:string,_session:string,amendmentId:string):Promise<AmendmentReceipt> {
    const intent=await this.read<{principal_id:string;session_id:string;processed_event_id:string;run_id:string;text:string}>('run-amendment-intents',amendmentId);
    check(intent&&intent.principal_id===principal,'AMENDMENT_NOT_FOUND',404);
    const source=await this.read<ProcessedEvent>('processed-events',digest({principal_id:principal,processed_event_id:intent.processed_event_id}));
    check(source,'AMENDMENT_SOURCE_NOT_FOUND',404);validateProcessed(source);
    return this.amend(source,intent.session_id,intent.run_id,intent.text);
  }
  amend(source:ProcessedEvent,session:string,runId:string,text:string):Promise<AmendmentReceipt> {
    return this.own(async()=>{
      await this.initialize();
      return this.serialized(async()=>{
        check(!this.closed,'ADMISSION_CLOSED',503);
        id(runId);check(typeof text==='string'&&text.length>0&&text.length<=32000,'AMENDMENT_INPUT_INVALID');
        check((await ownerActionGrant(source,this.ownerOrigin)).length>0,'AMENDMENT_OWNER_REQUIRED',403);
        const amendmentId=digest({principal_id:source.principal_id,processed_event_id:source.processed_event_id,run_id:runId});
        const pending=await this.read<{session_id:string;target_session_id:string}>('run-amendment-intents',amendmentId);
        const target=this.find(runId);
        check(!target||target.d.principal_id===source.principal_id,'AMENDMENT_TARGET_NOT_RUNNING',409);
        const targetSession=pending?.target_session_id??target?.record.session_id;
        check(targetSession,'AMENDMENT_TARGET_NOT_RUNNING',409);
        const intent={amendment_id:amendmentId,principal_id:source.principal_id,session_id:pending?.session_id??session,target_session_id:targetSession,run_id:runId,
          processed_event_id:source.processed_event_id,text};
        const prior=await this.read<AmendmentReceipt>('run-amendment-receipts',amendmentId);
        if(prior){await this.publish('run-amendment-intents',amendmentId,intent);return prior;}
        check(pending||target&&target.d.principal_id===source.principal_id&&!terminal.has(target.record.state),'AMENDMENT_TARGET_NOT_RUNNING',409);
        check(target?.record.processed_event_id!==source.processed_event_id,'AMENDMENT_SELF_TARGET',409);
        // Preserve exact owner bytes before transport. Native deduplicates this stable amendment id on retries.
        await this.publish('run-amendment-intents',amendmentId,intent);
        const delivered=await this.native.steer(runId,text,amendmentId,{conversation_session_id:targetSession});
        return this.publish('run-amendment-receipts',amendmentId,{amendment_id:amendmentId,run_id:runId,
          processed_event_id:source.processed_event_id,status:'delivered' as const,...delivered});
      });
    });
  }
  get(principal: string, session: string, dId: string): Admission | undefined {
    const entry = this.entries.get(this.key(principal, session, dId));
    return entry ? {...entry.record} : undefined;
  }
  // Explicit inspection does not restore queues, schedule native status, or mutate pending storage.
  readOnly(principal: string, session: string, dId: string): Promise<Admission | undefined> {
    return this.own(() => this.loadRecord(this.key(principal,session,dId)));
  }
  readTerminal(principal:string,session:string,dId:string):Promise<NativeRun|undefined> {
    return this.own(async()=>(await this.read<Terminal>('run-terminals',this.key(principal,session,dId)))?.native);
  }
  getAsync(principal: string, session: string, dId: string): Promise<Admission | undefined> {
    return this.own(() => this.getAsyncOwned(principal, session, dId));
  }
  private async getAsyncOwned(principal: string, session: string, dId: string): Promise<Admission | undefined> {
    await this.initialize();
    const key = this.key(principal, session, dId);
    const record = this.entries.get(key)?.record ?? await this.loadRecord(key);
    return record ? {...record} : undefined;
  }
  reconcile(principal: string, session: string, dId: string): Promise<Admission> {
    return this.own(() => this.reconcileOwned(principal, session, dId));
  }
  private async reconcileOwned(principal: string, session: string, dId: string): Promise<Admission> {
    await this.initialize();
    const key = this.key(principal, session, dId);
    const entry = this.entries.get(key);
    if (!entry) {
      const record = await this.loadRecord(key);
      check(record, 'ADMISSION_NOT_FOUND', 404);
      return {...record};
    }
    if (entry.record.cancel_requested_at_ms !== undefined && !entry.record.run_id) this.explicitReplays.add(key);
    this.start(key, entry);
    return {...entry.record};
  }
  cancel(principal: string, session: string, dId: string): Promise<CancelReceipt> {
    return this.own(() => this.cancelOwned(principal, session, dId));
  }
  private receipt(record: Admission): CancelReceipt {
    return {status: record.state === 'cancelled' ? 'cancelled' : terminal.has(record.state) ? 'already_terminal' : 'cancel_requested',
      run_id: record.run_id ?? null, state: record.state};
  }
  private async cancelOwned(principal: string, session: string, dId: string): Promise<CancelReceipt> {
    await this.initialize();
    const key = this.key(principal, session, dId);
    return this.serialized(async () => {
      check(!this.closed, 'ADMISSION_CLOSED', 503);
      const entry = this.entries.get(key);
      if (!entry || terminal.has(entry.record.state)) {
        const record = entry?.record ?? await this.loadRecord(key);
        check(record, 'ADMISSION_NOT_FOUND', 404);
        return this.receipt(record);
      }
      const {record} = entry;
      if (record.cancel_requested_at_ms === undefined) {
        // First durable intent wins; a failed write changes nothing and the D stays runnable.
        const saved = await this.storage.publish('run-cancel-intents', key, Buffer.from(canonical({at_ms: Date.now()})));
        record.cancel_requested_at_ms = this.intentAt(JSON.parse(new TextDecoder().decode(saved)));
      }
      // Decided synchronously against execute()'s synchronous send decision.
      if (terminal.has(record.state)) return this.receipt(record);
      if (record.run_id) {
        // A stop response alone does not release the barrier; status must confirm terminal.
        await this.stop(key, record);
        if(!this.stopsSent.has(key))this.eventStreams.get(record.run_id)?.abort.abort();
        return this.receipt(record);
      }
      const work = this.executing.get(key);
      if (this.unsentCancel(entry) && !work) await this.cancelUnsent(key, entry);
      else if (work) {
        for (const wake of this.pollWakeups) wake();
        // Before its send decision, execute observes the intent and settles without a native request.
        if (this.unsentCancel(entry)) await work;
      }
      return this.receipt(record);
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.releaseNative(); this.createAbort.abort();
    for(const stream of this.eventStreams.values())stream.abort.abort();
    for (const wake of this.pollWakeups) wake();
    // Already owned requests/storage finish; accepted native runs continue remotely.
    this.closing = (async () => {
      while (this.owned.size) await Promise.allSettled([...this.owned]);
    })();
    return this.closing;
  }
}
