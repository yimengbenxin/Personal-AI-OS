import { ContractError, check, digest, canonical, id, utc, validateProcessed, type AgentResult, type DeviceType, type Json, type ProcessedEvent } from './contracts.ts';
import type { StoragePort } from './storage.ts';
import { randomUUID } from 'node:crypto';
import { coalesceTts, inspectWav, type TtsAudio, type TtsPort } from './tts.ts';
import { NATIVE_TERMINAL_STATUSES, nativeConversationSession, type NativeFinalResponse, type NativeRun } from './hermes-client.ts';
import type {CapabilityGateway} from './capability/gateway.ts';
import {checkReport, factCarried, type CheckDecision} from './capability/checker.ts';
import {recordFacts} from './capability/renderer.ts';

export interface OutputContext {
  /** Host delivery intent; does not change the immutable route or durable journal binding. */
  delivery?:'text_notification';
  speech_role?:'call';
  report_budget?:import('./capability/renderer.ts').ReportBudget;
  principal_id: string; run_id: string; session_id: string; tool_call_id: string; d: ProcessedEvent;
  target: {device_id: string; device_type: DeviceType; route_version: string; output_modes: string[]};
}
/** Results that reach report admission require an owner report. Active self-check owners absorb their results before admission. */
export function errandReportRequired(d: ProcessedEvent): boolean {
  const app = d.content.app_event as {kind?: unknown} | undefined;
  return d.origin === 'device_observation' && app?.kind === 'errand_result';
}
/** Successful execution is final even when its owner report still needs delivery. */
export function errandExecutionFacts(result:Partial<Pick<import('./runtime.ts').ErrandResult,'success'|'terminal_reason'>>) {
  return {execution:{success:result.success??null,terminal_reason:result.terminal_reason??null},...(result.success===true?{task_retry_allowed:false}:{})};
}
/** Delivery diagnosis preserves executor facts and only calls a body published when OUT recorded the send. */
export function errandDeliveryFacts(result:Pick<import('./runtime.ts').ErrandResult,'success'|'terminal_reason'>,
  cause?:{stage:string;reason:string},publication?:TextDeliverySnapshot&{published_text_through_seq:number;accepted_text_through_seq:number}) {
  const report_guard=cause?.stage==='report_run'&&cause.reason.startsWith('{')?JSON.parse(cause.reason):undefined;
  return {...errandExecutionFacts(result),
    delivery:{scope:'owner_report',status:publication&&publication.published_text_through_seq>Math.max(publication.rendered_text_through_seq,publication.accepted_text_through_seq)?'body_sent_without_ack':cause?.stage==='report_run'?'not_delivered':'unknown',
      body_complete:!!publication&&publication.text_chunk_count>0&&publication.published_text_through_seq>=publication.text_chunk_count,
      stage:cause?.stage??null,reason:cause?.reason??null,...(report_guard?{report_guard}:{}),
      ...(publication&&publication.published_text_through_seq>0?publication:{})}};
}
export interface OpenReplyRequest {
  reply_mode: AgentResult['reply_mode']; target_aliases?: string[]; output_modes?: string[];
  receipt_refs?: string[]; evidence_refs?: string[]; continuity_ref?: string;
}
export interface ServiceReceipt {receipt_ref: string; status: string; kind: 'l3' | 'action' | 'l2'; summary: Json}
export interface ReceiptSourceStatus {
  source: ServiceReceipt['kind']; status: 'complete' | 'partial' | 'failed' | 'not_configured'; error: string | null;
}
export type ReceiptSourceRead =
  | (ReceiptSourceStatus & {status: 'complete'; error: null; receipts: ServiceReceipt[]})
  | (ReceiptSourceStatus & {status: 'partial'; error: string; receipts: ServiceReceipt[]})
  | (ReceiptSourceStatus & {status: 'failed'; error: string; receipts: []})
  | (ReceiptSourceStatus & {status: 'not_configured'; error: null; receipts: []});
export interface RunReceiptRead {sources: ReceiptSourceRead[]}
export interface OutputConfig {
  capability?: CapabilityGateway;
  tts?: TtsPort; maxAudioBytes?: number;
  maxEpochs?: number; maxTextBytes?: number; chunkChars?: number; maxJournalEntries?: number;
  listRunReceipts?: (context: OutputContext) => Promise<RunReceiptRead>;
  resolveReceipt?: (ref: string, context: OutputContext) => Promise<ServiceReceipt | null>;
  authorizeEvidence?: (ref: string, context: OutputContext) => Promise<boolean>;
}
export interface OpenReplyReceipt {
  receipt_ref: string; status: 'opened' | 'silent' | 'rejected' | 'failed'; reply_id: string | null;
  reply_epoch: number; route_version: string; authorized_targets: string[]; error_code: string | null;
  phase: 'final_buffer'; receipt_refs: string[]; reply_mode?: AgentResult['reply_mode'];
}
export interface TextChunk {
  output_id: string; reply_id: string; reply_epoch: number; message_ref: string; run_id: string;
  event_id: string; target_device_id: string; route_version: string; seq: number; text: string; final: boolean;
}
export interface VoiceChunk {
  output_id: string; reply_id: string; reply_epoch: number; target_device_id: string; route_version: string;
  seq: number; codec: 'pcm_s16le'; sample_rate: number; channels: number;
  audio: {ref: string; sha256: string; mime: 'audio/wav'; bytes: number; duration_ms: number};
  text_range: {start: number; end: number}; final: boolean;
}
export interface TextDeliverySnapshot {text_chunk_count: number; pending_text_chunk_count: number; rendered_text_through_seq: number}
export interface OutputResult extends AgentResult {failure_notice?: string; native_final_response?: NativeFinalResponse & {reply_epoch: number};receipt_sources: ReceiptSourceStatus[]; receipt_status: 'complete' | 'partial' | 'unknown'; receipt_error: string | null; receipt_refs: string[]; voice_status: 'none' | 'pending' | 'ready' | 'failed' | 'reconcile_required'; voice_error: string | null}
interface ReceiptSnapshot {sources?: ReceiptSourceStatus[]; services: ServiceReceipt[]; status: 'complete' | 'partial' | 'unknown'; error: string | null}
interface VoiceAttempt {attempt: number; owner: string; status: 'claimed' | 'ready' | 'failed'; audio_ref: string; error: string | null; chunk?: VoiceChunk; chunks?: VoiceChunk[]}
export interface OutputAck {
  output_id: string; reply_id: string; reply_epoch: number; target_device_id: string; route_version: string;
  highest_contiguous_seq: number; status: 'accepted' | 'rendered' | 'played'; observed_at: string;
}
export interface OutputAckReceipt extends OutputAck {receipt_ref: string}
export interface OutputCancelReceipt {receipt_ref: string; reply_epoch: number; status: 'interrupted'}
interface Entry {
  operation: string; fingerprint: string; binding: string;
  textPublished?: {reply_epoch:number;seq:number};
  callDelivery?:{reply_epoch:number;accepted_at:string;via:'voice'|'text_notification'|'text'};
  delivery?: {reply_epoch:number; target:OutputContext['target']};
  open?: OpenReplyReceipt; services?: ServiceReceipt[]; evidence?: string[];
  admissionDefault?: true;
  voiceChunk?: VoiceChunk; voice?: VoiceAttempt; voiceRefusal?: {reply_epoch: number; error: string}; voiceAdmission?: {queued_at_ms: number}; receipts?: ReceiptSnapshot;
  nativeFinalResponse?: NativeFinalResponse & {reply_epoch: number};
  nativeBoundaryEvidence?: NativeFinalResponse;
  result?: AgentResult; chunks?: TextChunk[]; nativeFingerprint?: string; ack?: OutputAckReceipt; cancel?: OutputCancelReceipt;
  capabilityCheck?: CheckDecision & {voice_text: string; chunks: TextChunk[]};
}
// Owners of voice generations running in this process (registered with the in-memory job). The output journal stays the
// only claim record; storage has a single process owner (main lock), so a claim whose owner is not live here was left
// by a crashed or settled generation. Remote synthesis may already have incurred cost; takeover requires explicit retry.
const liveVoiceOwners = new Set<string>();
interface State {capabilityCheck?: Entry['capabilityCheck']; delivery?: Entry['delivery']; entries: Entry[]; active?: Entry; sealed?: Entry; cancelled: number[]; accepted: number; rendered: number; voiceAccepted: number; played: number; voice?: VoiceAttempt; voiceRefusal?: Entry['voiceRefusal']; receipts?: ReceiptSnapshot; receiptRevision?: number}

// NEW business owner: phase, durable replay and delivery evidence. Native messages/history remain Hermes-owned.
export class OutputAuthority {
  private readonly storage: StoragePort;
  private readonly config: OutputConfig;
  private capability: CapabilityGateway | undefined;
  setCapabilityGateway(gateway: CapabilityGateway): void {check(!this.capability, 'CAPABILITY_GATEWAY_OWNER_CONFLICT'); this.capability = gateway;}
  private timeline:((ctx:OutputContext,result:AgentResult)=>void)|undefined;
  setTimeline(publish:(ctx:OutputContext,result:AgentResult)=>void):void {check(!this.timeline,'TIMELINE_OWNER_CONFLICT');this.timeline=publish;}
  private readonly synthesis = new Map<string, {task: Promise<void>; admitted: Promise<void>; abort: AbortController; dequeue: (release?: boolean) => void; settled: boolean; owner: string}>();
  private closing?: Promise<void>;
  private activeVoice = 0;
  private readonly voiceQueue: Array<() => void> = [];
  private voiceBudget = 32;
  private readonly reservations = new Map<string, {voice: number; subscription: number}>();
  private reservedCount = 0;
  private retainedBytes = 0;
  private voiceOwner?: (ctx: OutputContext, failure?: unknown) => Promise<void>;
  setVoiceOwner(owner: (ctx: OutputContext, failure?: unknown) => Promise<void>, budget?: number): void {
    check(!this.voiceOwner, 'OUTPUT_VOICE_OWNER_CONFLICT');
    check(budget === undefined || Number.isSafeInteger(budget) && budget > 0, 'INVALID_OUTPUT_CONFIG');
    this.voiceOwner = owner; if (budget !== undefined) this.voiceBudget = budget;
  }
  reserve(d: ProcessedEvent, bytes: number, kind: 'voice' | 'subscription'): () => void {
    const key = digest({principal: d.principal_id, d: d.processed_event_id}), current = this.reservations.get(key) ?? {voice: 0, subscription: 0};
    // A reply and its first listener share one slot. Further listeners each consume a slot; all retained data is charged.
    const count = Math.max(current.voice, current.subscription), next = {...current, [kind]: current[kind] + 1};
    check(this.reservedCount + Math.max(next.voice, next.subscription) - count <= 2 * this.voiceBudget &&
      this.retainedBytes + bytes <= this.voiceBudget * (this.config.maxTextBytes ?? 262144),
      kind === 'voice' ? 'OUTPUT_VOICE_CAPACITY_NOT_STARTED' : 'AUTOMATIC_OUTPUT_SUBSCRIPTION_BUDGET', 429);
    this.reservations.set(key, next);this.reservedCount += Math.max(next.voice, next.subscription) - count;this.retainedBytes += bytes;
    let held = true;
    return () => {
      if (!held) return; held = false;
      const value = this.reservations.get(key)!, before = Math.max(value.voice, value.subscription);value[kind]--;
      this.reservedCount += Math.max(value.voice, value.subscription) - before;this.retainedBytes -= bytes;
      if (!value.voice && !value.subscription) this.reservations.delete(key);
    };
  }
  get maxTextBytes():number {return this.config.maxTextBytes??262144;}
  constructor(storage: StoragePort, config: OutputConfig = {}) {
    this.storage = storage; this.config = config;
    this.capability = config.capability;
    for (const n of [config.maxEpochs ?? 8, config.maxTextBytes ?? 262144,
      config.chunkChars ?? 1024, config.maxAudioBytes ?? 33554432, config.maxJournalEntries ?? 1024]) check(Number.isSafeInteger(n) && n > 0, 'INVALID_OUTPUT_CONFIG');
  }
  private binding(ctx: OutputContext): string {
    id(ctx.principal_id); id(ctx.run_id); id(ctx.session_id); id(ctx.tool_call_id);
    id(ctx.target.device_id); id(ctx.target.route_version); validateProcessed(ctx.d);
    check(ctx.principal_id === ctx.d.principal_id, 'OUTPUT_PRINCIPAL_MISMATCH', 403);
    check(['glasses','phone','watch','mac'].includes(ctx.target.device_type), 'INVALID_OUTPUT_TARGET');
    return digest({principal_id: ctx.principal_id, run_id: ctx.run_id, session_id: ctx.session_id,
      d: ctx.d, target: ctx.target});
  }
  private scope(ctx: OutputContext): string {return digest({principal_id: ctx.principal_id, run_id: ctx.run_id});}
  private async state(ctx: OutputContext): Promise<State> {
    const binding = this.binding(ctx);
    const state: State = {entries: [], cancelled: [], accepted: 0, rendered: 0, voiceAccepted: 0, played: 0};
    for (let seq = 0; seq < (this.config.maxJournalEntries ?? 1024); seq++) {
      let bytes: Uint8Array;
      try {bytes = await this.storage.read('output-journal', digest({scope: this.scope(ctx), seq}));}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error;}
      const entry = JSON.parse(Buffer.from(bytes).toString('utf8')) as Entry;
      check(entry.binding === binding, 'OUTPUT_CONTEXT_CONFLICT', 409);
      state.entries.push(entry);
      if (entry.delivery) state.delivery = entry.delivery;
      if (entry.open) {state.active = entry; state.accepted = 0; state.rendered = 0; state.voiceAccepted = 0; state.played = 0; delete state.voice; delete state.voiceRefusal;}
      if (entry.result) state.sealed = entry;
      if (entry.capabilityCheck) state.capabilityCheck = entry.capabilityCheck;
      if (entry.voice) {state.voice = {...entry.voice, chunks: entry.voice.chunks ?? (entry.voice.chunk ? [entry.voice.chunk] : state.voice?.attempt === entry.voice.attempt ? state.voice.chunks ?? [] : [])}; delete state.voiceRefusal;}
      if (entry.voiceChunk) state.voice!.chunks!.push(entry.voiceChunk);
      if (entry.voiceRefusal) state.voiceRefusal = entry.voiceRefusal;
      if (entry.receipts) {state.receipts = entry.receipts; state.receiptRevision = (state.receiptRevision ?? 0) + 1;}
      if (entry.cancel) state.cancelled.push(entry.cancel.reply_epoch);
      if (entry.ack) {
        const voice = entry.ack.output_id.startsWith('voice:');
        if (entry.ack.status === 'played') state.played = Math.max(state.played, entry.ack.highest_contiguous_seq);
        else if (entry.ack.status === 'rendered') state.rendered = Math.max(state.rendered, entry.ack.highest_contiguous_seq);
        else if (voice) state.voiceAccepted = Math.max(state.voiceAccepted, entry.ack.highest_contiguous_seq);
        else state.accepted = Math.max(state.accepted, entry.ack.highest_contiguous_seq);
      }
    }
    return state;
  }
  private async transact(ctx: OutputContext, operation: string, fingerprintSource: string | ((state: State) => string),
    build: (state: State) => Promise<Entry>): Promise<Entry> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = await this.state(ctx);
      const fingerprint = typeof fingerprintSource === 'function' ? fingerprintSource(state) : fingerprintSource;
      const replay = state.entries.find(e => e.operation === operation);
      if (replay) {check(replay.fingerprint === fingerprint, 'OUTPUT_REPLAY_CONFLICT', 409); return replay;}
      // A failed generation and an interruption must remain recordable at the journal boundary.
      const reserve = operation.startsWith('voice-finish:') ? 1 : operation.startsWith('cancel:') ? 0 : 2;
      check(state.entries.length < (this.config.maxJournalEntries ?? 1024) - reserve, 'OUTPUT_JOURNAL_FULL', 429);
      const entry = {...await build(state), operation, fingerprint, binding: this.binding(ctx)};
      const bytes = Buffer.from(canonical(entry));
      const stored = await this.storage.publish('output-journal', digest({scope: this.scope(ctx), seq: state.entries.length}), bytes);
      if (Buffer.from(stored).equals(bytes)) return entry;
    }
    throw new Error('OUTPUT_CONTENTION_LIMIT');
  }
  // Errand completion selects its outreach recipient once, independently of the immutable input route.
  async selectErrandRecipient(ctx:OutputContext,target:OutputContext['target']):Promise<OutputContext['target']> {
    check(ctx.d.origin==='device_observation' && (ctx.d.content.app_event as {kind?:string}|undefined)?.kind==='errand_result',
      'OUTPUT_ERRAND_REQUIRED',403);
    const current=await this.state(ctx);
    if(current.delivery)return structuredClone(current.delivery.target);
    target=structuredClone(target);id(target.device_id);id(target.route_version);
    check(['glasses','phone','watch','mac'].includes(target.device_type) && Array.isArray(target.output_modes) &&
      target.output_modes.every(mode=>['text','voice','text_and_voice'].includes(mode)), 'INVALID_OUTPUT_TARGET');
    const entry=await this.transact(ctx,'errand-recipient',digest(target),async state=>{
      const result=state.sealed?.result;
      check(result,'SEALED_TEXT_NOT_AVAILABLE',409);
      check(!state.entries.some(entry=>entry.ack),'OUTPUT_DELIVERY_ALREADY_STARTED',409);
      const modes=result.reply_mode==='none'?[]:result.reply_mode==='text_and_voice'?['text','voice']:[result.reply_mode];
      check(modes.every(mode=>target.output_modes.includes(mode)),
        'OUTPUT_MODE_DENIED',403);
      return {operation:'',fingerprint:'',binding:'',delivery:{reply_epoch:result.reply_epoch,target}};
    });
    return structuredClone(entry.delivery!.target);
  }
  /** Tool call ids of the opened, uncancelled reply phases of a run that is not sealed yet, oldest first. */
  async openedReplies(ctx:OutputContext):Promise<string[]> {
    const state=await this.state(ctx);
    return state.sealed?[]:state.entries.filter(entry=>!entry.admissionDefault&&entry.open?.status==='opened'&&!state.cancelled.includes(entry.open.reply_epoch))
      .map(entry=>entry.operation.slice('open:'.length));
  }
  async deliveryTarget(ctx:OutputContext):Promise<OutputContext['target']> {
    const state=await this.state(ctx);return structuredClone(state.delivery?.target ?? ctx.target);
  }
  private deliveryChunk<T extends TextChunk|VoiceChunk>(state:State,chunk:T):T {
    const delivery=state.delivery;
    return delivery?.reply_epoch===chunk.reply_epoch ? {...chunk,target_device_id:delivery.target.device_id,
      route_version:delivery.target.route_version} : chunk;
  }
  private textChunksIn(state:State):TextChunk[] {
    return (state.capabilityCheck?.chunks ?? state.sealed?.chunks ?? []).map(chunk=>this.deliveryChunk(state,chunk));
  }
  async open(ctx: OutputContext, args: OpenReplyRequest): Promise<OpenReplyReceipt> {
    return (await this.declare(ctx,args))!;
  }
  /** Admission owns delivery for authenticated prompts and required outcome reports; models may replace it. */
  async openAdmittedPrompt(ctx:OutputContext,mode?:'text_and_voice'):Promise<void> {
    await this.declare({...ctx,tool_call_id:'admission-default'},
      {reply_mode:mode??(ctx.target.output_modes.includes('text')?'text':'voice')},true);
  }
  private async declare(ctx:OutputContext,args:OpenReplyRequest,admissionDefault=false):Promise<OpenReplyReceipt|undefined> {
    check(args && typeof args === 'object' && !Array.isArray(args) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(args)), 'INVALID_OPEN_REPLY');
    args = {...args};
    for (const field of ['target_aliases', 'output_modes', 'receipt_refs', 'evidence_refs'] as const) {
      const values = args[field];
      check(values === undefined || Array.isArray(values) && values.length <= 64 &&
        values.every(value => typeof value === 'string' && value.length <= 512), 'INVALID_OPEN_REPLY');
      if (values !== undefined) args[field] = [...values];
    }
    const entry = await this.transact(ctx, admissionDefault?'admission-open':`open:${ctx.tool_call_id}`, digest(args), async state => {
      // Restoring an admitted run never replaces a model declaration or a sealed result.
      if(admissionDefault&&(state.active||state.sealed))return {operation:'',fingerprint:'',binding:''};
      check(!state.sealed, 'OUTPUT_ALREADY_SEALED', 409);
      // The admission default is replaced by the first model phase before any text is sealed.
      const epochs=state.entries.flatMap(e=>e.open&&!e.admissionDefault?[e.open.reply_epoch]:[]);
      const epoch = Math.max(0,...epochs,...state.cancelled) + 1;
      check(epoch <= (this.config.maxEpochs ?? 8), 'OUTPUT_EPOCH_LIMIT', 429);
      const refs = args.receipt_refs ?? [];
      const evidence = args.evidence_refs ?? [];
      const services: ServiceReceipt[] = [];
      let error: string | null = null;
      const allowedKeys = ['reply_mode','target_aliases','output_modes','receipt_refs','evidence_refs','continuity_ref'];
      if (Object.keys(args).some(key => !allowedKeys.includes(key))) error = 'OUTPUT_ARGUMENT_UNSUPPORTED';
      if (!['none','text','voice','text_and_voice'].includes(args.reply_mode)) error = 'INVALID_REPLY_MODE';
      if ((args.target_aliases ?? ['source']).some(alias => alias !== 'source')) error = 'OUTPUT_TARGET_DENIED';
      const requestedModes = args.reply_mode === 'none' ? [] : args.reply_mode === 'text_and_voice' ? ['text','voice'] : [args.reply_mode];
      // The host may select notification text without rewriting the captured route or old journal binding.
      const availableModes=ctx.delivery==='text_notification'?['text']:ctx.target.output_modes;
      const replyMode = requestedModes.includes('voice') && !availableModes.includes('voice') &&
        availableModes.includes('text') ? 'text' : args.reply_mode;
      const expectedModes = replyMode === 'none' ? [] : replyMode === 'text_and_voice' ? ['text','voice'] : [replyMode];
      const modes = args.output_modes ?? requestedModes;
      if (expectedModes.some(mode => !availableModes.includes(mode)) ||
        canonical([...modes].sort()) !== canonical([...requestedModes].sort())) error = 'OUTPUT_MODE_DENIED';
      if (args.reply_mode !== 'none' && args.target_aliases?.length === 0) error = 'OUTPUT_TARGET_DENIED';
      if (args.reply_mode === 'none' && errandReportRequired(ctx.d)) error = 'ERRAND_REPORT_REQUIRED';
      if ((replyMode === 'voice' || replyMode === 'text_and_voice') && !this.config.tts) error = 'TTS_NOT_CONFIGURED';
      for (const ref of refs) {
        let receipt: ServiceReceipt | null | undefined;
        try {receipt = await this.config.resolveReceipt?.(ref, ctx);}
        catch {error = 'OUTPUT_RECEIPT_SERVICE_UNAVAILABLE';}
        if (!receipt || receipt.receipt_ref !== ref) error = 'OUTPUT_RECEIPT_UNVERIFIED';
        else services.push(receipt);
      }
      for (const ref of evidence) {
        if (ref === ctx.d.raw_ref) continue;
        let authorized = false;
        try {authorized = await this.config.authorizeEvidence?.(ref, ctx) ?? false;} catch { /* fail closed */ }
        if (!authorized) error = 'OUTPUT_EVIDENCE_DENIED';
      }
      if (args.continuity_ref && args.continuity_ref !== ctx.d.continuation?.continuity_ref) error = 'OUTPUT_CONTINUITY_DENIED';
      const replyId = args.reply_mode === 'none' || error ? null : `reply:${digest({scope: this.scope(ctx), epoch})}`;
      const receipt: OpenReplyReceipt = {receipt_ref: `out:${digest({scope: this.scope(ctx), tool: ctx.tool_call_id})}`,
        status: error ? (error === 'TTS_NOT_CONFIGURED' ? 'failed' : 'rejected') : args.reply_mode === 'none' ? 'silent' : 'opened',
        reply_id: replyId, reply_epoch: epoch, route_version: ctx.target.route_version,
        authorized_targets: error || args.reply_mode === 'none' ? [] : [ctx.target.device_id],
        error_code: error, phase: 'final_buffer', reply_mode: replyMode, receipt_refs: services.map(r => r.receipt_ref)};
      return {operation: '', fingerprint: '', binding: '', open: receipt, services, evidence: error ? [] : evidence,
        ...(admissionDefault?{admissionDefault:true as const}:{})};
    });
    return entry.open!;
  }
  // Model-facing OPEN view. The full receipt remains in the authoritative journal.
  async openForModel(ctx: OutputContext, args: OpenReplyRequest): Promise<Pick<OpenReplyReceipt, 'status' | 'error_code'>> {
    const receipt = await this.open(ctx, args);
    return {status: receipt.status, error_code: receipt.error_code};
  }
  private native(ctx: OutputContext, native: NativeRun): void {
    check(native.run_id === ctx.run_id && nativeConversationSession(native) === ctx.session_id, 'OUTPUT_NATIVE_BINDING_MISMATCH', 403);
    check(NATIVE_TERMINAL_STATUSES.has(native.status), 'OUTPUT_NATIVE_NOT_TERMINAL', 409);
  }
  private allChunks(ctx: OutputContext, result: AgentResult, proof?: NativeFinalResponse): TextChunk[] {
    if (!result.reply_id || result.reply_status !== 'complete' || !['text','text_and_voice'].includes(result.reply_mode)) return [];
    const text = Array.from(result.reply_text);
    const size = this.config.chunkChars ?? 1024;
    const chunks: TextChunk[] = [];
    for (let start = 0; start < text.length; start += size) chunks.push({
      output_id: `output:${digest({reply_id: result.reply_id})}`, reply_id: result.reply_id,
      reply_epoch: result.reply_epoch, message_ref: proof ? `native-message:${proof.session_id}:${proof.message_id}` : `native-final:${ctx.run_id}`, run_id: ctx.run_id,
      event_id: ctx.d.event_id, target_device_id: ctx.target.device_id, route_version: ctx.target.route_version,
      seq: chunks.length + 1, text: text.slice(start, start + size).join(''), final: start + size >= text.length});
    return chunks;
  }
  private async refreshReceipts(ctx: OutputContext): Promise<ReceiptSnapshot> {
    const initial = await this.state(ctx);
    const known = new Map<string, ServiceReceipt>();
    for (const entry of initial.entries) for (const receipt of entry.services ?? []) known.set(receipt.receipt_ref, receipt);
    for (const receipt of initial.receipts?.services ?? []) known.set(receipt.receipt_ref, receipt);
    let error: string | null = null;
    let complete = false;
    const sources: ReceiptSourceStatus[] = [];
    // Validate each independent authority before merging it, so one unavailable/invalid source
    // cannot discard another source's actual facts.
    const validateReceipts = (actual: ServiceReceipt[], kind: ServiceReceipt['kind']) => {
      check(Array.isArray(actual) && actual.length <= 1024, 'RUN_RECEIPTS_INVALID');
      const authority = new Map<string, ServiceReceipt>();
      for (const receipt of actual) {
        check(receipt && typeof receipt.receipt_ref === 'string' && receipt.receipt_ref.length > 0 &&
          receipt.receipt_ref.length <= 512 && ['l3','action','l2'].includes(receipt.kind) &&
          receipt.kind === kind && typeof receipt.status === 'string' &&
          receipt.status.length > 0, 'RUN_RECEIPTS_INVALID');
        canonical(receipt.summary);
        const prior = authority.get(receipt.receipt_ref);
        check(!prior || digest(prior) === digest(receipt), 'RUN_RECEIPTS_CONFLICT');
        authority.set(receipt.receipt_ref, receipt);
      }
      return authority;
    };
    if (!this.config.listRunReceipts) error = 'RUN_RECEIPTS_SOURCE_NOT_CONFIGURED';
    else {
      try {
        const actual = await this.config.listRunReceipts(ctx);
        check(actual && Array.isArray(actual.sources) && actual.sources.length <= 3, 'RUN_RECEIPTS_INVALID');
        const seen = new Set<string>();
        const current = new Map<string, ServiceReceipt>();
        for (const source of actual.sources) {
          check(source && ['l3','action','l2'].includes(source.source) && !seen.has(source.source), 'RUN_RECEIPTS_INVALID');
          seen.add(source.source);
          try {
            check(['complete','partial','failed','not_configured'].includes(source.status), 'RUN_RECEIPTS_INVALID');
            check(source.status === 'failed' || source.status === 'partial' ? typeof source.error === 'string' && source.error.length > 0 &&
              source.error.length <= 128 : source.error === null, 'RUN_RECEIPTS_INVALID');
            check(source.status === 'complete' || source.status === 'partial' || Array.isArray(source.receipts) && source.receipts.length === 0,
              'RUN_RECEIPTS_INVALID');
            if (source.status === 'complete' || source.status === 'partial') {
              const valid = validateReceipts(source.receipts, source.source);
              for (const receipt of valid.values()) {
                const prior = current.get(receipt.receipt_ref);
                check(!prior || digest(prior) === digest(receipt), 'RUN_RECEIPTS_CONFLICT');
              }
              for (const receipt of valid.values()) {
                current.set(receipt.receipt_ref, receipt); known.set(receipt.receipt_ref, receipt);
              }
            }
            sources.push({source: source.source, status: source.status, error: source.error});
          } catch (failure) {
            sources.push({source: source.source, status: 'failed',
              error: failure instanceof ContractError ? failure.code : 'RUN_RECEIPTS_INVALID'});
          }
        }
        error = sources.find(source => source.status === 'failed' || source.status === 'partial')?.error ?? null;
        complete = error === null && sources.some(source => source.status === 'complete');
        if (!complete && !error) error = 'RUN_RECEIPTS_SOURCE_NOT_CONFIGURED';
      } catch (failure) {error = failure instanceof ContractError ? failure.code : 'RUN_RECEIPTS_UNAVAILABLE';}
    }
    const snapshot: ReceiptSnapshot = {sources, services: [...known.values()].sort((a,b) => a.receipt_ref.localeCompare(b.receipt_ref)),
      status: complete ? 'complete' : known.size || sources.some(source => source.status === 'complete') ? 'partial' : 'unknown', error};
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = await this.state(ctx);
      const retained = new Map<string, ServiceReceipt>();
      for (const entry of state.entries) for (const receipt of entry.services ?? []) retained.set(receipt.receipt_ref, receipt);
      for (const receipt of state.receipts?.services ?? []) retained.set(receipt.receipt_ref, receipt);
      for (const receipt of snapshot.services) retained.set(receipt.receipt_ref, receipt);
      snapshot.services = [...retained.values()].sort((a,b) => a.receipt_ref.localeCompare(b.receipt_ref));
      if (!complete && retained.size) snapshot.status = 'partial';
      const fingerprint = digest(snapshot);
      if (state.receipts && digest(state.receipts) === fingerprint) return state.receipts;
      check(state.entries.length < (this.config.maxJournalEntries ?? 1024) - 2, 'OUTPUT_JOURNAL_FULL', 429);
      const entry: Entry = {operation: `receipts:${state.entries.length}`, fingerprint, binding: this.binding(ctx), receipts: snapshot};
      const bytes = Buffer.from(canonical(entry));
      const stored = await this.storage.publish('output-journal', digest({scope: this.scope(ctx), seq: state.entries.length}), bytes);
      if (Buffer.from(stored).equals(bytes)) return snapshot;
    }
    throw new Error('OUTPUT_CONTENTION_LIMIT');
  }
  // Fixed ride/navigation plumbing owns these words. prompt:* identifies OUT, never a native run.
  async sealFixedPrompt(ctx:OutputContext,text:string):Promise<OutputResult> {
    this.binding(ctx);
    const app=ctx.d.content.app_event;
    check(ctx.d.origin==='device_observation' && ctx.d.media_type==='app_event' && app &&
      typeof app==='object' && !Array.isArray(app) && app.kind==='move_say' &&
      (app.prompt_kind==='nav_prompt' || app.prompt_kind==='hr_alert') && app.text===text,
      'OUTPUT_FIXED_PROMPT_SOURCE_DENIED',403);
    check(ctx.target.device_type==='glasses' && ctx.run_id===`prompt:${digest({principal_id:ctx.principal_id,processed_event_id:ctx.d.processed_event_id})}`,
      'OUTPUT_FIXED_PROMPT_BINDING_DENIED',403);
    check(typeof text==='string' && text.trim().length>0 && Buffer.byteLength(text)<=(this.config.maxTextBytes ?? 262144),
      'OUTPUT_FIXED_PROMPT_TEXT_INVALID');
    if(!(await this.state(ctx)).sealed)await this.open(ctx,{reply_mode:'voice'});
    const entry=await this.transact(ctx,'seal-fixed-prompt',digest({text}),async state=>{
      check(!state.sealed,'OUTPUT_ALREADY_SEALED',409);
      const open=state.active?.open;
      const cancelled=!!open && state.cancelled.includes(open.reply_epoch),success=open?.status==='opened' && !cancelled;
      const result:AgentResult={schema_version:'paios.result.v1',processed_event_id:ctx.d.processed_event_id,
        event_id:ctx.d.event_id,session_id:ctx.session_id,run_id:ctx.run_id,consumed_revision:ctx.d.revision,result_revision:1,
        reply_id:open?.reply_id ?? null,reply_epoch:open?.reply_epoch ?? 0,
        reply_phase:cancelled?'interrupted':success?'sealed':'failed',reply_mode:success?'voice':'none',reply_text:success?text:'',
        output_plan:success?[{target_device_id:ctx.target.device_id,device_type:ctx.target.device_type,
          output_modes:['voice'],route_version:ctx.target.route_version}]:[],
        l3_updates:[],actions:[],l2_updates:[],evidence_refs:[ctx.d.raw_ref],warnings:open?.error_code?[open.error_code]:[],
        run_status:'not_applicable',reply_status:cancelled?'partial':success?'complete':'failed',delivery_status:'unknown',
        result_status:cancelled?'interrupted':success?'completed':'failed'};
      return {operation:'',fingerprint:'',binding:'',result,chunks:[],receipts:{sources:[],services:[],status:'complete',error:null}};
    });
    const state=await this.state(ctx),result=entry.result!;
    if(!this.closing && !state.cancelled.includes(result.reply_epoch) && result.result_status==='completed' &&
      !state.voiceRefusal && !['ready','failed'].includes(state.voice?.status ?? ''))await this.requestVoice(ctx,result);
    return (await this.readFinalized(ctx)).result;
  }
  async seal(ctx: OutputContext, native: NativeRun): Promise<OutputResult> {
    this.native(ctx, native);
    const receipts = await this.refreshReceipts(ctx);
    const nativeFingerprint = (state: State) => {
      const sealed = state.entries.find(entry => entry.operation === 'seal');
      const priorProof = sealed?.nativeBoundaryEvidence;
      return digest({status: native.status, output: native.output ?? null, turn_exit_reason: native.turn_exit_reason ?? null,
        ...(state.active?.open?.status === 'silent' ? {} : {proof: native.native_final_response ?? priorProof ?? null,
          proof_error: (priorProof || (native.native_final_response_error ? undefined : native.native_final_response ?? undefined)) ? null : native.native_final_response_error ?? null})});
    };
    const entry = await this.transact(ctx, 'seal', nativeFingerprint, async state => {
      const active = state.active;
      const open = active?.open;
      const silent = open?.status === 'silent';
      const validText = typeof native.output === 'string' && native.output.trim().length > 0 &&
        Buffer.byteLength(native.output) <= (this.config.maxTextBytes ?? 262144);
      const suppliedProof = !silent && ('native_final_response' in native || 'native_final_response_error' in native);
      const proof = silent ? undefined : (native.native_final_response_error ? undefined : native.native_final_response ?? undefined);
      const proofMismatch = suppliedProof && !proof;
      const phaseExpired = !state.entries.some(entry=>entry.operation==='admission-open') && open?.status === 'opened' && proof !== undefined &&
        (proof.after_tool_name !== 'paios_open_reply' || active?.operation !== `open:${proof.after_tool_call_id}` ||
          proof.previous_message_role !== 'tool' || proof.previous_message_id !== proof.last_tool_message_id);
      const cancelled = phaseExpired || !!open && state.cancelled.includes(open.reply_epoch);
      const interrupted = cancelled || ['cancelled','canceled','interrupted'].includes(native.status);
      const turnLimited = native.status === 'failed' && /^max_iterations_reached\(\d+\/\d+\)$/u.test(native.turn_exit_reason ?? '');
      const success = !cancelled && (native.status === 'completed' && silent ||
        (native.status === 'completed' || turnLimited && !!proof) && !proofMismatch && open?.status === 'opened' && validText);
      const services = receipts.services;
      const warnings = [proof ? 'FINAL_BUFFER_DURABLE_ASSISTANT_BOUNDARY' : 'FINAL_BUFFER_NO_VERIFIED_MESSAGE_BOUNDARY'];
      if (turnLimited) warnings.push('NATIVE_TURN_LIMIT_REACHED');
      if (proofMismatch) warnings.push('NATIVE_FINAL_RESPONSE_BINDING_MISMATCH');
      if (phaseExpired) warnings.push('OPEN_PHASE_INVALIDATED_BY_NATIVE_BOUNDARY');
      if (!open) warnings.push('OPEN_REQUIRED');
      if (open?.error_code) warnings.push(open.error_code);
      if (open?.status === 'opened' && !validText) warnings.push('NATIVE_FINAL_TEXT_MISSING_OR_OVERSIZE');
      const result: AgentResult = {schema_version: 'paios.result.v1', processed_event_id: ctx.d.processed_event_id,
        event_id: ctx.d.event_id, session_id: ctx.session_id, run_id: ctx.run_id, consumed_revision: ctx.d.revision,
        result_revision: 1, reply_id: open?.reply_id ?? null, reply_epoch: open?.reply_epoch ?? 0,
        reply_phase: interrupted ? 'interrupted' : success ? 'sealed' : 'failed',
        reply_mode: silent ? 'none' : open?.status === 'opened' ? open.reply_mode ?? 'text' : 'none',
        reply_text: success && !silent ? native.output! : '',
        output_plan: success && !silent ? [{target_device_id: ctx.target.device_id, device_type: ctx.target.device_type,
          output_modes: open?.reply_mode === 'voice' ? ['voice'] : open?.reply_mode === 'text_and_voice' ? ['text','voice'] : ['text'], route_version: ctx.target.route_version}] : [],
        l3_updates: services.filter(r => r.kind === 'l3').map(r => r.summary),
        actions: services.filter(r => r.kind === 'action').map(r => r.summary),
        l2_updates: services.filter(r => r.kind === 'l2').map(r => r.summary), evidence_refs: active?.evidence ?? [], warnings,
        run_status: native.status, reply_status: interrupted ? 'partial' : success ? silent ? 'none' : 'complete' : 'failed',
        delivery_status: 'unknown', result_status: interrupted ? 'interrupted' : success ? 'completed' : 'failed'};
      return {operation: '', fingerprint: '', binding: '', result, chunks: this.allChunks(ctx, result, proof), nativeFingerprint: nativeFingerprint(state),
        ...(proof ? {nativeBoundaryEvidence: proof} : {}),
        ...(proof && success ? {nativeFinalResponse: {...proof, reply_epoch: open!.reply_epoch}} : {})};
    });
    await this.checkCapability(ctx, entry);
    let state = await this.state(ctx);
    if (!this.closing && !state.cancelled.includes(entry.result!.reply_epoch) && entry.result!.result_status === 'completed' &&
      ['voice','text_and_voice'].includes(entry.result!.reply_mode) && !state.voiceRefusal && !['ready','failed'].includes(state.voice?.status ?? '')) {
      await this.requestVoice(ctx, {...entry.result!, reply_text: state.capabilityCheck?.voice_text ?? entry.result!.reply_text});
      state = await this.state(ctx);
    }
    const result=this.resultProjection(ctx,entry,state,receipts);
    this.timeline?.(ctx,result);
    return result;
  }
  private resultProjection(ctx: OutputContext, entry: Entry, state: State, receipts: ReceiptSnapshot): OutputResult {
    const result: OutputResult = {...entry.result!, ...(entry.nativeFinalResponse ? {native_final_response: structuredClone(entry.nativeFinalResponse)} : {}), receipt_sources: receipts.sources ?? [], receipt_status: receipts.status, receipt_error: receipts.error,
      receipt_refs: receipts.services.map(r => r.receipt_ref), voice_status: 'none', voice_error: null, warnings: [...entry.result!.warnings],
      result_revision: state.receiptRevision ?? 1,
      l3_updates: receipts.services.filter(r => r.kind === 'l3').map(r => r.summary),
      actions: receipts.services.filter(r => r.kind === 'action').map(r => r.summary),
      l2_updates: receipts.services.filter(r => r.kind === 'l2').map(r => r.summary)};
    if (result.warnings.includes('NATIVE_TURN_LIMIT_REACHED') && result.reply_phase !== 'sealed' && !state.cancelled.includes(result.reply_epoch)) {
      result.failure_notice = '依米这次用完了步骤，还没来得及给出完整回复。';
      const actions = receipts.services.filter(r => r.kind === 'action');
      if (actions.length) result.failure_notice += `动作收据：${actions.filter(r => r.status === 'committed').length} 项已完成，` +
        `${actions.filter(r => r.status === 'pending_approval').length} 项待你确认，${actions.filter(r => r.status === 'reconcile_required').length} 项结果待核对。`;
    }
    if (state.delivery?.reply_epoch===result.reply_epoch) result.output_plan=result.output_plan.map(plan=>({...plan as {[key:string]:Json},
      target_device_id:state.delivery!.target.device_id,device_type:state.delivery!.target.device_type,
      route_version:state.delivery!.target.route_version}));
    if (receipts.error) {
      result.warnings.push(receipts.error);
      if (receipts.error !== 'RUN_RECEIPTS_SOURCE_NOT_CONFIGURED' && result.result_status === 'completed') result.result_status = 'failed';
    }
    if (state.capabilityCheck) result.reply_text = state.capabilityCheck.text;
    const count = this.textChunksIn(state).length;
    const wantsVoice = ['voice','text_and_voice'].includes(result.reply_mode);
    if (wantsVoice) {
      const pending = this.synthesis.get(`${this.scope(ctx)}:${result.reply_epoch}`);
      result.voice_status = pending && !pending.settled ? 'pending' : state.voiceRefusal?.reply_epoch === result.reply_epoch ? 'failed' : state.voice?.status === 'ready' ? 'ready' : state.voice?.status === 'failed' ? 'failed' : 'reconcile_required';
      result.voice_error = result.voice_status === 'pending' ? null : state.voiceRefusal?.reply_epoch === result.reply_epoch ? state.voiceRefusal.error : state.voice?.error ?? (state.voice?.status === 'ready' ? null : 'TTS_RECONCILE_REQUIRED');
      if (entry.result!.result_status !== 'completed') {result.voice_status = 'failed'; result.voice_error = 'NATIVE_FINAL_NOT_AVAILABLE';}
      if (result.voice_error) result.warnings.push(result.voice_error);
    }
    if (state.cancelled.includes(result.reply_epoch)) {result.reply_phase = 'interrupted'; result.reply_status = 'partial'; result.result_status = 'interrupted';}
    const textDone = count === 0 || state.rendered >= count;
    const voiceDone = !wantsVoice || state.voice?.status === 'ready' && state.played >= this.voiceChunksIn(state).length;
    result.delivery_status = wantsVoice && voiceDone && textDone ? 'played' : !wantsVoice && count > 0 && textDone ? 'rendered' :
      state.rendered > 0 || state.played > 0 ? 'partial' : state.accepted > 0 || state.voiceAccepted > 0 ? 'accepted' : 'unknown';
    return result;
  }
  private textSnapshot(state: State): TextDeliverySnapshot {
    const count=this.textChunksIn(state).length;
    return {text_chunk_count:count,pending_text_chunk_count:Math.max(0,count-state.rendered),rendered_text_through_seq:state.rendered};
  }
  async textDelivery(ctx: OutputContext): Promise<TextDeliverySnapshot> {return this.textSnapshot(await this.state(ctx));}
  async textPublished(ctx:OutputContext,chunk:TextChunk):Promise<void> {
    await this.transact(ctx,`text-published:${chunk.reply_epoch}:${chunk.seq}`,digest(chunk),async state=>{
      check(this.textChunksIn(state).some(value=>value.reply_epoch===chunk.reply_epoch&&value.seq===chunk.seq&&value.output_id===chunk.output_id),
        'OUTPUT_CHUNK_NOT_FOUND',409);
      return {operation:'',fingerprint:'',binding:'',textPublished:{reply_epoch:chunk.reply_epoch,seq:chunk.seq}};
    });
  }
  async textPublication(ctx:OutputContext) {
    const state=await this.state(ctx),epoch=state.sealed?.result?.reply_epoch;
    return {...this.textSnapshot(state),accepted_text_through_seq:state.accepted,published_text_through_seq:Math.max(0,...state.entries.flatMap(entry=>entry.textPublished&&entry.textPublished.reply_epoch===epoch?[entry.textPublished.seq]:[]))};
  }
  // Read only: receipt coverage is the last journal snapshot, not a new authority lookup.
  async readSealedText(ctx: OutputContext) {return this.readFinalText(ctx,true);}
  async readFinalized(ctx: OutputContext) {return this.readFinalText(ctx,false);}
  async inspectFinalized(ctx: OutputContext) {return this.readFinalSnapshot(ctx,false);}
  private async readFinalText(ctx:OutputContext,replay:boolean) {
    const value=await this.readFinalSnapshot(ctx,replay);
    this.timeline?.(ctx,value.result);
    return value;
  }
  private async readFinalSnapshot(ctx:OutputContext,replay:boolean) {
    const initial=await this.state(ctx);
    if(initial.sealed?.operation==='seal')await this.checkCapability(ctx,initial.sealed);
    const state=await this.state(ctx),entry=state.sealed;
    check(entry?.result && entry.chunks && state.receipts, 'SEALED_TEXT_NOT_AVAILABLE', 409);
    if(replay) check(state.active?.open?.reply_epoch === entry.result.reply_epoch && !state.cancelled.includes(entry.result.reply_epoch),
      'SEALED_TEXT_OLD_EPOCH', 409);
    if(replay) check(entry.result.reply_phase === 'sealed', 'SEALED_TEXT_NOT_AVAILABLE', 409);
    const voice_chunks=!state.cancelled.includes(entry.result.reply_epoch)?this.voiceChunksIn(state).filter(chunk=>chunk.seq>state.played):[];
    const result=this.resultProjection(ctx,entry,state,state.receipts);
    return {result,chunks:state.cancelled.includes(entry.result.reply_epoch) ? [] : this.textChunksIn(state),
      voice_chunks,pending_voice_chunk_count:voice_chunks.length,
      text_replay:replay ? 'sealed' as const : 'pending' as const,...this.textSnapshot(state)};
  }
  async chunks(ctx: OutputContext, native: NativeRun): Promise<TextChunk[]> {
    const result = await this.seal(ctx, native);
    const state = await this.state(ctx);
    if (state.cancelled.includes(result.reply_epoch)) return [];
    return this.textChunksIn(state).filter(chunk => chunk.seq > state.rendered);
  }
  async callResultDelivered(ctx:OutputContext):Promise<boolean> {
    const state=await this.state(ctx),epoch=state.sealed?.result?.reply_epoch;
    return epoch!==undefined&&state.entries.some(entry=>entry.callDelivery?.reply_epoch===epoch);
  }
  /** Accepted delivery for this sealed epoch; text publication is not a render or read ACK. */
  async recordCallResultDelivery(ctx:OutputContext,via:'voice'|'text_notification'|'text'):Promise<void> {
    await this.transact(ctx,'call-result-delivered',state=>digest({epoch:state.sealed?.result?.reply_epoch,via}),async state=>{
      check(state.sealed?.result,'SEALED_TEXT_NOT_AVAILABLE',409);
      return {operation:'',fingerprint:'',binding:'',callDelivery:{reply_epoch:state.sealed.result.reply_epoch,accepted_at:new Date().toISOString(),via}};
    });
  }
  async ack(ctx: OutputContext, input: unknown): Promise<OutputAckReceipt> {
    check(input && typeof input === 'object' && !Array.isArray(input) &&
      Object.getPrototypeOf(input) === Object.prototype, 'OUTPUT_ACK_INVALID');
    // Retain original JSON metadata/digest for exact retry; snapshot before any await.
    const request = JSON.parse(canonical(input)) as OutputAck;
    for (const key of ['output_id','reply_id','target_device_id','route_version'] as const) id(request[key]);
    check(Number.isSafeInteger(request.reply_epoch) && request.reply_epoch > 0, 'OUTPUT_ACK_INVALID');
    check(Number.isSafeInteger(request.highest_contiguous_seq) && request.highest_contiguous_seq > 0,
      'OUTPUT_ACK_SEQUENCE_INVALID');
    utc(request.observed_at);
    check(['accepted','rendered','played'].includes(request.status), 'OUTPUT_ACK_STATUS_INVALID');
    const entry = await this.transact(ctx, `ack:${digest(request)}`, digest(request), async state => {
      const result = state.sealed?.result;
      check(result && state.active?.open?.reply_epoch === request.reply_epoch && !state.cancelled.includes(request.reply_epoch), 'OUTPUT_ACK_OLD_EPOCH', 409);
      const isVoice = request.output_id.startsWith('voice:');
      check(isVoice ? request.status !== 'rendered' : request.status !== 'played', 'OUTPUT_ACK_CHANNEL_MISMATCH');
      const chunks = isVoice ? this.voiceChunksIn(state) : this.textChunksIn(state);
      const first = chunks[0];
      check(first && request.output_id === first.output_id && request.reply_id === first.reply_id &&
        request.reply_epoch === first.reply_epoch && request.target_device_id === first.target_device_id &&
        request.route_version === first.route_version, 'OUTPUT_ACK_BINDING_MISMATCH', 403);
      check(Number.isSafeInteger(request.highest_contiguous_seq) && request.highest_contiguous_seq > 0 &&
        request.highest_contiguous_seq <= chunks.length, 'OUTPUT_ACK_SEQUENCE_INVALID');
      check(request.highest_contiguous_seq >= (request.status === 'rendered' ? state.rendered : request.status === 'played' ? state.played : isVoice ? state.voiceAccepted : state.accepted), 'OUTPUT_ACK_REGRESSION', 409);
      return {operation: '', fingerprint: '', binding: '', ack: {...request, receipt_ref: `out-ack:${digest(request)}`}};
    });
    // Even duplicate ACKs cannot reopen a cancelled epoch.
    const state = await this.state(ctx);
    check(!state.cancelled.includes(request.reply_epoch), 'OUTPUT_ACK_OLD_EPOCH', 409);
    if(this.capability && state.capabilityCheck && request.status!=='accepted') {
      const isVoice=request.status==='played', chunks=isVoice?this.voiceChunksIn(state):this.textChunksIn(state);
      const carried=isVoice ? (request.highest_contiguous_seq===chunks.length ? state.capabilityCheck.voice_text : '') :
        this.textChunksIn(state).filter(chunk=>chunk.seq<=request.highest_contiguous_seq).map(chunk=>chunk.text).join('');
      const facts=state.capabilityCheck.facts.filter(fact=>factCarried(fact,carried,isVoice?'voice':'text',state.capabilityCheck!.facts)).map(fact=>fact.id);
      await this.capability.ledger.delivered(ctx.principal_id,facts,entry.ack!.receipt_ref);
    }
    if(state.sealed?.result&&state.receipts)this.timeline?.(ctx,this.resultProjection(ctx,state.sealed,state,state.receipts));
    return entry.ack!;
  }
  private async checkCapability(ctx: OutputContext, sealed: Entry): Promise<void> {
    if (!this.capability || sealed.result?.reply_phase!=='sealed' || sealed.result.reply_mode==='none') return;
    const current=await this.state(ctx);
    if (current.capabilityCheck) return;
    const records=await this.capability.ledger.current(ctx);
    if (!records.length) return;
    const receipts=records.map(record=>record.receipt);
    const allFacts=recordFacts(records,ctx.run_id),facts=await this.capability.ledger.novel(ctx.principal_id,allFacts);
    await this.transact(ctx,`capability-check:${sealed.result.reply_epoch}`,digest(sealed.result.reply_text),async()=>{
      const checked=checkReport(sealed.result!.reply_text,receipts,ctx.d.content.text??'',facts,'text',allFacts,ctx.report_budget);
      const voice=checkReport(sealed.result!.reply_text,receipts,ctx.d.content.text??'',facts,'voice',allFacts,ctx.report_budget);
      const chunks=this.allChunks(ctx,{...sealed.result!,reply_text:checked.text}).map(chunk=>({...chunk,
        message_ref:`capability-report:${ctx.run_id}:${sealed.result!.reply_epoch}`}));
      return {operation:'',fingerprint:'',binding:'',capabilityCheck:{...checked,
        facts:[...new Map([...checked.facts,...voice.facts].map(fact=>[fact.id,fact])).values()],
        voice_text:voice.text,chunks}};
    });
  }
  private async requestVoice(ctx: OutputContext, result: AgentResult, retry = false): Promise<void> {
    try {await this.ensureVoice(ctx, result, retry);}
    catch (error) {
      if (!(error instanceof ContractError) || error.code !== 'OUTPUT_VOICE_CAPACITY_NOT_STARTED') throw error;
      await this.refuseVoice(ctx, result, error.code);
    }
  }
  private async refuseVoice(ctx: OutputContext, result: AgentResult, error: string): Promise<void> {
    const state = await this.state(ctx), attempt = (state.voice?.attempt ?? 0) + 1;
    await this.transact(ctx, `voice-refusal:${attempt}:${error}`, digest({epoch: result.reply_epoch, error}), async () => ({
      operation: '', fingerprint: '', binding: '', voiceRefusal: {reply_epoch: result.reply_epoch, error}}));
  }
  private voiceChunksIn(state: State): VoiceChunk[] {return (state.voice?.chunks ?? (state.voice?.chunk ? [state.voice.chunk] : [])).map((chunk,index,list)=>this.deliveryChunk(state,state.voice?.status === 'ready' ? {...chunk,final:index === list.length-1} : chunk));}
  private ensureVoice(ctx: OutputContext, result: AgentResult, retry = false): Promise<void> | undefined {
    if (!result.reply_id || !this.config.tts) return;
    const key = `${this.scope(ctx)}:${result.reply_epoch}`;
    const running = this.synthesis.get(key);
    if (running) return running.admitted;
    check(!this.closing, 'OUTPUT_CLOSED', 503);
    const release = this.reserve(ctx.d, Buffer.byteLength(canonical({ctx, result})), 'voice');
    const abort = new AbortController(), owner = randomUUID();
    const slot = Promise.withResolvers<boolean>();let waiting = this.activeVoice >= this.voiceBudget, expired = false, deadline = 0, reconciling = false;
    let timer: NodeJS.Timeout | undefined;
    const wake = () => {waiting = false;clearTimeout(timer);this.activeVoice++;slot.resolve(true);};
    const dequeue = (releaseNow = false) => {
      if (!waiting) return;waiting = false;clearTimeout(timer);
      this.voiceQueue.splice(this.voiceQueue.indexOf(wake), 1);if (releaseNow) release();slot.resolve(false);
    };
    if (waiting) this.voiceQueue.push(wake);else wake();
    // Register before the first await. Close owns generation and its completion notification.
    const job = {abort, dequeue, settled: false, owner, admitted: Promise.resolve(), task: Promise.resolve()};
    liveVoiceOwners.add(owner);
    job.admitted = (async () => {
      const state = await this.state(ctx), attempt = state.voice ? state.voice.attempt + (retry ? 1 : 0) : 1;
      const entry = await this.transact(ctx, `voice-admission:${attempt}${retry ? ':retry:' + state.entries.length : ''}`, digest({epoch: result.reply_epoch, text: result.reply_text}), async current => {
        check(!current.cancelled.includes(result.reply_epoch), 'OUTPUT_VOICE_CANCELLED', 409);
        return {operation: '', fingerprint: '', binding: '', voiceAdmission: {queued_at_ms: Date.now()}};
      });
      deadline = entry.voiceAdmission!.queued_at_ms + 60000;reconciling = Boolean(state.voice && !retry);
      if (waiting) timer = setTimeout(() => {expired = true;dequeue();}, Math.max(0, deadline - Date.now()));
    })();
    void job.admitted.catch(() => dequeue());
    job.task = Promise.resolve().then(async () => {
      const acquired = await slot.promise;
      try {
        await job.admitted;
        // A prior claim may already be billed. Expiring its read leaves that claim for reconciliation.
        if (expired || !reconciling && !abort.signal.aborted && Date.now() >= deadline) {
          if (!reconciling) await this.refuseVoice(ctx, result, 'OUTPUT_VOICE_WAIT_EXPIRED_NOT_STARTED');
        } else if (!reconciling && abort.signal.aborted && this.closing) await this.refuseVoice(ctx, result, 'OUTPUT_VOICE_CLOSED_NOT_STARTED');
        else if (acquired && !abort.signal.aborted) await this.generateVoice(ctx, result, retry, abort.signal, owner);
      } finally {dequeue();if (acquired) {this.activeVoice--;this.voiceQueue.shift()?.();}}
    })
      .then(async () => {job.settled = true; await this.voiceOwner?.(ctx);}, async error => {
        job.settled = true; await this.voiceOwner?.(ctx, error); throw error;
      }).finally(() => {release();liveVoiceOwners.delete(owner); if (this.synthesis.get(key) === job) this.synthesis.delete(key);});
    this.synthesis.set(key, job);
    // A result read must not await TTS. The owner receives errors; join still observes rejection.
    void job.task.catch(() => undefined);
    return job.admitted;
  }
  private claimVoice(ctx: OutputContext, result: AgentResult, attempt: number, owner: string, stale?: VoiceAttempt): Promise<Entry> {
    const audioRef = `audio:${digest({scope: this.scope(ctx), epoch: result.reply_epoch, attempt})}`;
    return this.transact(ctx, `voice-claim:${attempt}`, digest({attempt, text: result.reply_text}), async current => {
      check(!current.cancelled.includes(result.reply_epoch), 'OUTPUT_VOICE_CANCELLED', 409);
      // A takeover replaces only the exact abandoned claim it observed.
      if (stale) check(current.voice?.status === 'claimed' && current.voice.attempt === stale.attempt &&
        current.voice.owner === stale.owner, 'OUTPUT_VOICE_CLAIM_CHANGED', 409);
      return {operation: '', fingerprint: '', binding: '', voice: {attempt, owner, status: 'claimed', audio_ref: audioRef, error: null}};
    });
  }
  private async generateVoice(ctx: OutputContext, result: AgentResult, retry: boolean, signal: AbortSignal, owner: string): Promise<void> {
    const state = await this.state(ctx);
    if (state.cancelled.includes(result.reply_epoch) || state.voice?.status === 'ready') return;
    if (state.voice?.status === 'failed' && !retry) return;
    let claim = await this.claimVoice(ctx, result, state.voice ? state.voice.attempt + (retry && state.voice.status === 'failed' ? 1 : 0) : 1, owner);
    let audio: TtsAudio | undefined;
    // Generation dedupe: an artifact already published under the claimed audioKey is adopted, never regenerated.
    try {if (!this.config.tts!.stream) audio = inspectWav(await this.storage.read('derived-audio', claim.voice!.audio_ref.slice('audio:'.length)));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (!audio && claim.voice!.owner !== owner) {
      if (liveVoiceOwners.has(claim.voice!.owner)) return; // A live generation in this process keeps its claim.
      // Remote synthesis may have been charged. Only an explicit retry authorizes another provider request.
      if (!retry) return;
      check(this.voiceChunksIn(state).length === 0, 'OUTPUT_VOICE_PARTIAL_RETRY_UNSAFE', 409);
      claim = await this.claimVoice(ctx, result, claim.voice!.attempt + 1, owner, claim.voice);
      if (claim.voice!.owner !== owner) return;
    }
    const {attempt, audio_ref: audioRef} = claim.voice!, audioKey = audioRef.slice('audio:'.length);
    // Fence: only the current claim's owner may settle it; a superseded owner cannot overwrite a takeover.
    const fence = (current: State) => check(current.voice?.attempt === attempt && current.voice.owner === claim.voice!.owner,
      'OUTPUT_VOICE_CLAIM_SUPERSEDED', 409);
    let bytes = 0;
    const publishChunk = async (generated: TtsAudio, seq: number, final: boolean) => {
      signal.throwIfAborted();
      const parsed = inspectWav(generated.bytes); bytes += parsed.bytes.length;
      check(parsed.sha256 === generated.sha256 && bytes <= (this.config.maxAudioBytes ?? 33554432), 'OUTPUT_AUDIO_INVALID');
      const ref = seq === 1 ? audioRef : `audio:${digest({audioRef, seq})}`;
      const persisted = inspectWav(await this.storage.publish('derived-audio', ref.slice('audio:'.length), parsed.bytes));
      const chunk: VoiceChunk = {output_id: `voice:${digest({reply_id: result.reply_id})}`, reply_id: result.reply_id!,
        reply_epoch: result.reply_epoch, target_device_id: ctx.target.device_id, route_version: ctx.target.route_version,
        seq, codec: persisted.codec, sample_rate: persisted.sample_rate, channels: persisted.channels,
        audio: {ref, sha256: persisted.sha256, mime: persisted.mime, bytes: persisted.bytes.length, duration_ms: persisted.duration_ms},
        text_range: {start: 0, end: Array.from(result.reply_text).length}, final};
      await this.transact(ctx, `voice-chunk:${attempt}:${seq}`, digest(chunk), async current => {
        check(!current.cancelled.includes(result.reply_epoch) && current.active?.open?.reply_epoch === result.reply_epoch, 'OUTPUT_VOICE_CANCELLED', 409);
        fence(current);
        return {operation: '', fingerprint: '', binding: '', ...(seq === 1 ? {voice: {...claim.voice!, chunk}} : {voiceChunk: chunk})};
      });
      if (this.config.tts!.stream) await this.voiceOwner?.(ctx);
    };
    const tts=ctx.speech_role==='call'?this.config.tts?.forCall?.():this.config.tts;check(tts,'TTS_CALL_VOICE_UNAVAILABLE',503);
    const source = audio ? (async function* () {yield audio!;})() : tts.stream
      ? tts.stream!(result.reply_text, audioKey, signal)
      : (async function* (tts: TtsPort) {yield await tts.synthesize(result.reply_text, audioKey, signal);})(tts);
    const iterator = (tts.stream && !audio ? coalesceTts(source) : source)[Symbol.asyncIterator]();
    let seq = 0;
    const fail = (error: unknown) => this.transact(ctx, `voice-finish:${attempt}`, digest({attempt, status: 'failed'}), async current => {
      fence(current);
      return {operation: '', fingerprint: '', binding: '', voice: {...claim.voice!, status: 'failed', chunks: this.voiceChunksIn(current),
        error: signal.aborted ? 'TTS_SYNTHESIS_CANCELLED' : error instanceof ContractError ? error.code : 'TTS_SYNTHESIS_FAILED'}};
    });
    try {
      while (true) {
        let next: IteratorResult<TtsAudio>;
        try {signal.throwIfAborted(); next = await iterator.next(); signal.throwIfAborted();}
        catch (error) {await fail(error);return;}
        if (next.done) break;
        try {await publishChunk(next.value, ++seq, !this.config.tts!.stream || Boolean(audio));}
        catch (error) {
          const current = await this.state(ctx);
          // A first publication failure leaves the paid claim unknown. Persist partial audio without authorizing resynthesis.
          if (this.voiceChunksIn(current).length && !current.cancelled.includes(result.reply_epoch)) await fail(error);
          throw error;
        }
      }
      check(seq > 0, 'OUTPUT_AUDIO_INVALID');
      await this.transact(ctx, `voice-finish:${attempt}`, digest({attempt, status: 'ready'}), async current => {
        check(!current.cancelled.includes(result.reply_epoch) && current.active?.open?.reply_epoch === result.reply_epoch, 'OUTPUT_VOICE_CANCELLED', 409);
        fence(current);
        return {operation: '', fingerprint: '', binding: '', voice: {...claim.voice!, status: 'ready', error: null, chunks: this.voiceChunksIn(current).map((chunk,index,list)=>({...chunk,final:index===list.length-1}))}};
      });
    } finally {await iterator.return?.();}
  }

  async voiceChunks(ctx: OutputContext, native: NativeRun): Promise<VoiceChunk[]> {
    const result = await this.seal(ctx, native);
    const state = await this.state(ctx);
    return state.cancelled.includes(result.reply_epoch) ? [] : this.voiceChunksIn(state).filter(chunk=>chunk.seq>state.played);
  }
  async getAudio(ctx: OutputContext, ref: string): Promise<TtsAudio> {
    const state = await this.state(ctx);
    const chunk = this.voiceChunksIn(state).find(chunk=>chunk.audio.ref === ref);
    check(chunk &&
      state.active?.open && !state.cancelled.includes(state.active.open.reply_epoch), 'OUTPUT_AUDIO_ACCESS_DENIED', 403);
    const audio = inspectWav(await this.storage.read('derived-audio', ref.slice('audio:'.length)));
    check(audio.sha256 === chunk.audio.sha256, 'OUTPUT_AUDIO_INTEGRITY_FAILURE', 500);
    return audio;
  }
  async retryVoice(ctx: OutputContext, native?: NativeRun): Promise<OutputResult> {
    // A claim is recoverable when its owner is not live in this process (abandoned) or is this instance's own running
    // generation (joined); another live generation's claim never is. A read may adopt persisted legacy audio;
    // only this explicit request can authorize another remote generation.
    const recoverable = (state: State) => state.voice?.status === 'claimed' && (!liveVoiceOwners.has(state.voice.owner) ||
      [...this.synthesis.values()].some(job => job.owner === state.voice!.owner));
    const priorState = await this.state(ctx);
    check(this.voiceChunksIn(priorState).length === 0 || priorState.voice?.status === 'ready' || liveVoiceOwners.has(priorState.voice!.owner), 'OUTPUT_VOICE_PARTIAL_RETRY_UNSAFE', 409);
    const prior = recoverable(priorState);
    if(native)await this.seal(ctx,native);
    else await this.sealFixedPrompt(ctx,(ctx.d.content.app_event as {text:string}).text);
    const key = `${this.scope(ctx)}:${priorState.sealed?.result?.reply_epoch}`;
    if (prior && !liveVoiceOwners.has(priorState.voice!.owner)) await this.synthesis.get(key)?.task;
    const state = await this.state(ctx);
    check(state.sealed?.result && !state.cancelled.includes(state.sealed.result.reply_epoch) &&
      (prior || recoverable(state) || state.voice?.status === 'failed' || state.voiceRefusal?.reply_epoch === state.sealed.result.reply_epoch), 'OUTPUT_VOICE_RETRY_NOT_SAFE', 409);
    if (!this.synthesis.has(key)) await this.requestVoice(ctx, {...state.sealed.result,
      reply_text:state.capabilityCheck?.voice_text??state.sealed.result.reply_text}, true);
    await this.synthesis.get(key)?.task;
    return native?this.seal(ctx,native):(await this.readFinalized(ctx)).result;
  }
  async cancel(ctx: OutputContext, epoch: number): Promise<OutputCancelReceipt> {
    const entry = await this.transact(ctx, `cancel:${epoch}`, digest({epoch}), async state => {
      check(state.active?.open?.reply_epoch === epoch, 'OUTPUT_CANCEL_OLD_EPOCH', 409);
      return {operation: '', fingerprint: '', binding: '', cancel: {receipt_ref: `out-cancel:${digest({scope: this.scope(ctx), epoch})}`, reply_epoch: epoch, status: 'interrupted'}};
    });
    const job = this.synthesis.get(`${this.scope(ctx)}:${epoch}`);job?.abort.abort();job?.dequeue(true);
    await this.voiceOwner?.(ctx);
    return entry.cancel!;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    for (const job of this.synthesis.values()) {job.abort.abort();job.dequeue();}
    this.closing = Promise.allSettled([...this.synthesis.values()].map(job => job.task)).then(() => {});
    return this.closing;
  }
}
