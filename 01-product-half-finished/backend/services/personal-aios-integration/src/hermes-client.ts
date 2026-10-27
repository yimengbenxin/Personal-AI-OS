import Ajv2020Module from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import { check, ContractError, sha256, principalAttribution, type ProcessedEvent } from './contracts.ts';
import type {StructuredVisionRequest} from './visual/models.ts';

export type ModelSourceContext = {kind:'call';principal_id:string;device_id:string;call_id:string;continuity:string;raw_ref:string;archive_revision:string}|
  {kind:'capture';raw_ref:string;archive_revision:string;principal_id:string;device_id:string};
export type ModelExecutionContext = {run_id:string;session_id:string}|ModelSourceContext;

export interface NativeRun {
  run_id: string; session_id?: string; conversation_session_id?: string; status: string; output?: string; replayed?: boolean; turn_exit_reason?: string;
  schema?: 'hermes.run.v2'; shape_sha256?: string; profile_home?: string;
  granted_toolsets?: string[]; updated_at?:number; seq?:number; activity_events?:NativeRunEvent[];
  run_scope?: 'owner' | 'owner_uncertain' | 'guest' | 'build';
  approval?: NativeApproval; approval_results?: NativeApprovalResult[];
  native_final_response?: NativeFinalResponse | null; native_final_response_error?: unknown;
}
export interface NativeApproval {request_id:string;question:string;expires_at_ms:number}
export interface OwnerConfirmation {confirmation_id:string;confirmed_by:string;surface:{device_id:string;device_type:string};confirmed_at:string}
export interface NativeApprovalResult extends NativeApproval {confirmation?:OwnerConfirmation;choice:'once'|'deny';reason:'resolved'|'timeout'|'interrupted'|'session_closed'|'notify_failed'}
export interface NativeFinalResponse {
  schema: 'hermes.final-response.v1'; run_id: string; session_id: string; turn_id: string;
  message_id: number; sha256: string; phase: 'final_buffer'; after_tool_call_id: string | null; after_tool_name: string | null;
  last_tool_message_id: number | null; previous_message_id: number | null; previous_message_role: string | null;
}
// One source-pinned primitive contract. Compile once; business qualification remains native.
const shapeBytes=readFileSync(new URL('./native-run.shape.schema.json',import.meta.url));
export const NATIVE_RUN_SHAPE_SHA256='b725baece0ba60cdcf1789b5964224e94a08768c3cd252ed30a12a517ebda210';
check(sha256(shapeBytes)===NATIVE_RUN_SHAPE_SHA256,'NATIVE_RUN_SCHEMA_PIN_MISMATCH');
const shape=JSON.parse(shapeBytes.toString('utf8'));
export const NATIVE_RUN_SCOPE_TOOLS: Readonly<Record<'care' | 'guest' | 'owner_uncertain' | 'build', readonly string[]>> =
  Object.freeze(Object.fromEntries(Object.entries(shape['x-paios-run-scope-tools']).map(([scope, names]) =>
    [scope, Object.freeze(names as string[])]))) as Readonly<Record<'care' | 'guest' | 'owner_uncertain' | 'build', readonly string[]>>;
const ajv=new Ajv2020Module.default({strict:true,allErrors:false});
ajv.addKeyword('x-paios-run-scope-tools');
ajv.addSchema(shape);
const runShape=ajv.getSchema(shape.$id+'#/$defs/run')!;
const proofShape=ajv.getSchema(shape.$id+'#/$defs/proof')!;
export interface NativeConsumerScope {conversation_session_id: string; profile_home?: string}
export interface NativeRunEvent {
  event:string;run_id:string;timestamp:number;seq?:number;run?:NativeRun;activity_events?:NativeRunEvent[];
  text?:string;subagent_id?:string;child_session_id?:string;goal?:string;status?:string;error?:boolean;
  tool_call_id?:string;public_intent?:string;progress?:number;total?:number;
  exit_reason?:string;outcome?:'succeeded'|'partial'|'failed'|'cancelled';outcome_reason?:string;
}
function validateNativeEvent(event:NativeRunEvent,runId:string,maximumBytes:number):void {
  check(event!==null&&typeof event==='object'&&event.run_id===runId&&typeof event.event==='string'&&typeof event.timestamp==='number'&&Number.isFinite(event.timestamp),'HERMES_PROGRESS_BINDING_INVALID',502);
  if(event.event.startsWith('tool.')){
    check(typeof event.tool_call_id==='string'&&event.tool_call_id.length>0,'HERMES_TOOL_BINDING_INVALID',502);
    if(event.event==='tool.started'&&event.public_intent!==undefined)check(typeof event.public_intent==='string','HERMES_PUBLIC_INTENT_INVALID',502);
  }
  if(event.event==='tool.progress'||event.event==='subagent.progress'&&(event.progress!==undefined||event.total!==undefined))
    check(typeof event.progress==='number'&&Number.isFinite(event.progress)&&event.progress>=0&&
      (event.total===undefined||typeof event.total==='number'&&Number.isFinite(event.total)&&event.total>=0),'HERMES_TOOL_PROGRESS_INVALID',502);
  if(event.event==='message.interim'){
    check(typeof event.text==='string' && event.text.length<=maximumBytes,'HERMES_PROGRESS_TEXT_INVALID',502);
  }
  if(event.event.startsWith('subagent.'))check(typeof event.subagent_id==='string'&&
    (event.event!=='subagent.start'||typeof event.goal==='string')&&
    (event.event!=='subagent.complete'||['completed','failed','error','timeout','interrupted'].includes(event.status!)),
    'HERMES_SUBAGENT_EVENT_INVALID',502);
  if(event.outcome!==undefined)check(event.event==='subagent.complete'&&['succeeded','partial','failed','cancelled'].includes(event.outcome)&&
    typeof event.outcome_reason==='string'&&(['partial','failed'].includes(event.outcome)?event.outcome_reason.trim().length>0:true),
    'HERMES_SUBAGENT_OUTCOME_INVALID',502);
}
export function decodeNativeRun(value: unknown, profile?: string, expectedRun?: string, expectedConversation?: string): NativeRun {
  check(runShape(value),'HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID',502);
  const native=structuredClone(value) as NativeRun;
  check(native.shape_sha256===NATIVE_RUN_SHAPE_SHA256 && (profile===undefined || native.profile_home===profile),
    'HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID',502);
  check(expectedRun===undefined || native.run_id===expectedRun,'HERMES_NATIVE_RUN_BINDING_INVALID',502);
  check(expectedConversation===undefined || nativeConversationSession(native)===expectedConversation,'NATIVE_CONVERSATION_SCOPE_MISMATCH',502);
  if ('native_final_response_error' in native && (typeof native.native_final_response_error!=='string' || !native.native_final_response_error))
    native.native_final_response_error='NATIVE_FINAL_RESPONSE_BINDING_MISMATCH';
  if (native.native_final_response!==undefined && native.native_final_response!==null && !native.native_final_response_error) {
    const proof=native.native_final_response;
    if (!proofShape(proof) || proof.run_id!==native.run_id || proof.session_id!==native.session_id ||
        typeof native.output!=='string' || proof.sha256!==sha256(native.output))
      native.native_final_response_error='NATIVE_FINAL_RESPONSE_BINDING_MISMATCH';
  }
  for(const event of native.activity_events??[])validateNativeEvent(event,native.run_id,Number.MAX_SAFE_INTEGER);
  return native;
}
// The original Client is the qualification owner; inject raw fetch responses below it.
export type NativeClient = HermesClient;
export interface Reminder {id:string;text:string;fire_at:string}
export interface CallIntent {stop:boolean;guests:'allow'|'revoke'|'unchanged';directed?:boolean;hangup?:boolean}
export class NativeNotAcceptedError extends ContractError {
  readonly nativeCode: 'gateway_draining' | 'rate_limit_exceeded';
  readonly retryAfterMs: number;
  constructor(code: 'gateway_draining' | 'rate_limit_exceeded', retryAfterMs = 0) {
    super(`HERMES_NOT_ACCEPTED_${code}`, code === 'gateway_draining' ? 503 : 429);
    check(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 2147483647, 'INVALID_RETRY_AFTER');
    this.nativeCode = code; this.retryAfterMs = retryAfterMs;
  }
}
// An explicit native run field is required; legacy transcript IDs cannot grant a scope.
/** Native statuses that end a run. Admission and output both read this one set, so every run admission finishes is sealable. */
export const NATIVE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed','failed','cancelled','canceled','interrupted','expired']);
export function nativeConversationSession(native: NativeRun): string {
  check(typeof native.conversation_session_id === 'string' && native.conversation_session_id.length > 0 &&
    native.conversation_session_id.length <= 512, 'NATIVE_CONVERSATION_SCOPE_UNAVAILABLE', 502);
  check(typeof native.session_id === 'string' && native.session_id.length > 0 && native.session_id.length <= 512,
    'NATIVE_TRANSCRIPT_IDENTITY_UNAVAILABLE', 502);
  return native.conversation_session_id;
}
const HISTORY_READ_BYTES = 2 * 1024 * 1024;
// HTTP conversion only. Logical identities, admission and side effects belong to their authorities.
export class HermesClient {
  get hookProfile():string {return this.profile??'default';}
  private readonly baseUrl: string; private readonly token: string; private readonly timeoutMs: number; private readonly profile: string | undefined; private readonly maximumBytes: number; private readonly fetcher: typeof fetch;
  constructor(baseUrl: string, token: string, timeoutMs: number, maximumBytes: number, profile?: string, fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname), 'HERMES_LOOPBACK_REQUIRED');
    check(token.length >= 24 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
      Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'INVALID_HERMES_CONFIG');
    this.profile = profile; this.maximumBytes = maximumBytes; this.fetcher=fetcher;
    this.baseUrl = baseUrl.replace(/\/$/u, ''); this.token = token; this.timeoutMs = timeoutMs;
  }
  /** Authenticated package host operations use the same native transports, including live channel adapters. */
  async capability(operation:string,body:unknown):Promise<any>{
    const response=await this.fetcher(`${this.baseUrl}/v1/paios/capability/${operation}`,{method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),
      signal:AbortSignal.timeout(this.timeoutMs)});
    const result=await this.responseJSON(response,Math.max(this.maximumBytes,4<<20),'HERMES_CAPABILITY');
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);return result;
  }
  async analyzeVision(bytes: Buffer, prompt: string | StructuredVisionRequest, signal?: AbortSignal, context?:ModelExecutionContext): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/v1/paios/vision`, {
      method: 'POST', redirect: 'error',
      headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({image_url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        ...(typeof prompt==='string'?{prompt}:prompt),...(context?('kind' in context?{source_context:context}:{_model_context:context}):{})}),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)])
    });
    const text = await this.responseText(response, this.maximumBytes, 'HERMES_VISION');
    check(response.ok, `HERMES_HTTP_${response.status}`, response.status);
    return text;
  }
  async classifyCall(text:string,signal?:AbortSignal,context?:ModelExecutionContext):Promise<CallIntent> {
    check(typeof text==='string' && text.length>=1 && text.length<=4000,'INVALID_CALL_INTENT_REQUEST');
    const response=await this.fetcher(`${this.baseUrl}/v1/paios/call-intent`,{method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({text,...(context?('kind' in context?{source_context:context}:{_model_context:context}):{})}),
      signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(Math.min(this.timeoutMs,3000))])});
    const payload=await this.responseJSON(response,this.maximumBytes,'HERMES_CALL_INTENT');
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(payload!==null && typeof payload==='object' && !Array.isArray(payload) &&
      Object.keys(payload).length===4 && 'directed' in payload && typeof payload.directed==='boolean' &&
      'hangup' in payload && typeof payload.hangup==='boolean' && (!payload.hangup||payload.directed) && 'stop' in payload && typeof payload.stop==='boolean' &&
      'guests' in payload && ['allow','revoke','unchanged'].includes(payload.guests as string),'HERMES_CALL_INTENT_INVALID',502);
    return payload as CallIntent;
  }
  async routeSelfcheckResult(result:import('./runtime.ts').ErrandResult):Promise<boolean> {
    const response=await this.fetcher(`${this.baseUrl}/v1/paios/selfcheck-result`,{method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({result}),
      signal:AbortSignal.timeout(this.timeoutMs)});
    const payload=await this.responseJSON(response,this.maximumBytes,'HERMES_SELFCHECK_RESULT') as {absorbed?:unknown};
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(typeof payload.absorbed==='boolean','HERMES_SELFCHECK_RESULT_INVALID',502);
    return payload.absorbed;
  }
  async mirrorCallTurn(d:ProcessedEvent,session:string,signal?:AbortSignal):Promise<string> {
    const turn=d.content.app_event as {kind?:unknown;user?:unknown;assistant?:unknown};
    check(principalAttribution(d)==='owner_call_turn' && turn?.kind==='voice_turn' && typeof turn.user==='string' &&
      typeof turn.assistant==='string','INVALID_FRONT_TURN');
    const response=await this.fetcher(`${this.baseUrl}/v1/paios/front-turn`,{method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({session_id:session,processed_event_id:d.processed_event_id,input:JSON.stringify(d),captured_at:d.captured_at}),
      signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.timeoutMs)])});
    const payload=await this.responseJSON(response,this.maximumBytes,'HERMES_FRONT_TURN') as {processed_event_id?:unknown;session_id?:unknown};
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(payload.processed_event_id===d.processed_event_id && typeof payload.session_id==='string' && payload.session_id.length>0,
      'HERMES_FRONT_TURN_BINDING_INVALID',502);
    return payload.session_id;
  }
  async searchCall(query:string,signal?:AbortSignal):Promise<unknown> {
    check(typeof query==='string' && query.trim().length>=1 && query.length<=4000,'INVALID_FRONT_SEARCH_REQUEST');
    const response=await this.fetcher(`${this.baseUrl}/v1/paios/front-search`,{method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({query}),
      signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(this.timeoutMs)])});
    const payload=await this.responseJSON(response,this.maximumBytes,'HERMES_FRONT_SEARCH');
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    return payload;
  }
  async progress(runId:string,onText:(text:string)=>void,signal?:AbortSignal):Promise<void> {
    return this.events(runId,event=>{if(event.event==='message.interim'&&event.text?.trim())onText(event.text);},signal);
  }
  async events(runId:string,onEvent:(event:NativeRunEvent)=>void|Promise<void>,signal?:AbortSignal,afterSeq=0,scope?:NativeConsumerScope):Promise<void> {
    let lastSeq=afterSeq;
    const response=await this.fetcher(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?after_seq=${afterSeq}`,{
      headers:{Authorization:`Bearer ${this.token}`},redirect:'error',
      ...(signal?{signal}:{})});
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(response.headers.get('content-type')?.split(';')[0]==='text/event-stream' && response.body,
      'HERMES_PROGRESS_STREAM_REQUIRED',502);
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='';
    const consume=async(frame:string):Promise<boolean>=>{
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return false;
      const event=JSON.parse(data) as NativeRunEvent;
      check(event.run_id===runId && typeof event.event==='string','HERMES_PROGRESS_BINDING_INVALID',502);
      if(scope){
        check(Number.isSafeInteger(event.seq)&&event.seq!>=0,'HERMES_PROGRESS_SEQUENCE_INVALID',502);
        if(event.event==='run.snapshot')check(event.seq!>=lastSeq,'HERMES_PROGRESS_SEQUENCE_INVALID',502);
        else {if(event.seq!<=lastSeq)return false;check(event.seq===lastSeq+1,'HERMES_PROGRESS_SEQUENCE_GAP',502);}
        lastSeq=event.seq!;
      }
      if(event.event==='run.snapshot'||event.event==='run.updated')
        event.run=decodeNativeRun(event.run,scope?.profile_home??this.profile,runId,scope?.conversation_session_id);
      if(event.event==='run.snapshot'){
        check(Array.isArray(event.activity_events),'HERMES_ACTIVITY_SNAPSHOT_INVALID',502);
        for(const current of event.activity_events!)validateNativeEvent(current,runId,this.maximumBytes);
      }
      validateNativeEvent(event,runId,this.maximumBytes);
      await onEvent(event);
      return event.run ? NATIVE_TERMINAL_STATUSES.has(event.run.status) : event.event.startsWith('run.') && NATIVE_TERMINAL_STATUSES.has(event.event.slice(4));
    };
    try {
      while(true){
        const part=await reader.read();pending=(pending+decoder.decode(part.value,{stream:!part.done})).replace(/\r\n/gu,'\n');
        let end:number;
        while((end=pending.indexOf('\n\n'))>=0){
          const frame=pending.slice(0,end);pending=pending.slice(end+2);
          check(Buffer.byteLength(frame)<=this.maximumBytes,'HERMES_PROGRESS_TOO_LARGE',502);
          if(await consume(frame))return;
        }
        check(Buffer.byteLength(pending)<=this.maximumBytes,'HERMES_PROGRESS_TOO_LARGE',502);
        if(part.done){check(!pending.trim() || pending.trim().startsWith(':'),'HERMES_PROGRESS_TRUNCATED',502);return;}
      }
    } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  }
  // One byte-counted body reader, independent of Content-Length.
  private async responseText(response: Response, maximumBytes: number, scope = 'HERMES_RESPONSE'): Promise<string> {
    check(response.body, `${scope}_BODY_REQUIRED`, response.ok ? 502 : response.status);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ContractError(`${scope}_TOO_LARGE`, response.ok ? 502 : response.status);
        }
        chunks.push(part.value);
      }
    } finally {reader.releaseLock();}
    try {return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));}
    catch {throw new ContractError(response.ok ? 'HERMES_INVALID_RESPONSE' : `HERMES_HTTP_${response.status}`,
      response.ok ? 502 : response.status);}
  }
  private async responseJSON(response: Response, maximumBytes: number, scope = 'HERMES_RESPONSE'): Promise<unknown> {
    const text = await this.responseText(response, maximumBytes, scope);
    try {return JSON.parse(text);}
    catch {throw new ContractError(response.ok ? 'HERMES_INVALID_RESPONSE' : `HERMES_HTTP_${response.status}`,
      response.ok ? 502 : response.status);}
  }
  private async request(path: string, method = 'GET', body?: unknown, key?: string, signal?: AbortSignal, expectedRun?: string, scope?: NativeConsumerScope): Promise<NativeRun> {
    check(this.profile===undefined || scope?.profile_home===undefined || this.profile===scope.profile_home, 'NATIVE_MEMORY_CONFIG_INVALID');
    const headers: Record<string,string> = {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Hermes-Run-Contract':'hermes.run.v2'};
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const response = await this.fetcher(`${this.baseUrl}${path}`, {method, headers, redirect: 'error',
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
    const payload = await this.responseJSON(response, this.maximumBytes);
    if (!response.ok) {
      // Only these fixed-native pre-run refusals prove this transport was not accepted.
      if (path === '/v1/runs' && method === 'POST' &&
          response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json') {
        const code = payload && typeof payload === 'object' && 'error' in payload &&
          payload.error && typeof payload.error === 'object' && 'code' in payload.error ? payload.error.code : undefined;
        if ((response.status === 503 && code === 'gateway_draining') ||
            (response.status === 429 && code === 'rate_limit_exceeded')) {
          const retry = response.headers.get('retry-after');
          const ms = retry === null ? 0 : /^\d+$/u.test(retry) ? Number(retry) * 1000 : NaN;
          check(Number.isSafeInteger(ms) && ms >= 0 && ms <= 2147483647, 'HERMES_INVALID_RETRY_AFTER', response.status);
          throw new NativeNotAcceptedError(code, ms);
        }
      }
      throw new ContractError(`HERMES_HTTP_${response.status}`, response.status);
    }
    return decodeNativeRun(payload, scope?.profile_home ?? this.profile, expectedRun, scope?.conversation_session_id);
  }
  // One authenticated transport/configured-runtime probe; this does not execute a model or certify its output.
  async ready(maximumBytes: number): Promise<boolean> {
    check(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'INVALID_READINESS_BUDGET');
    const response = await this.fetcher(`${this.baseUrl}/health/detailed`, {headers: {Authorization: `Bearer ${this.token}`},
      redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs)});
    const payload = await this.responseJSON(response, maximumBytes, 'HERMES_READINESS') as {platform?: unknown; readiness?: {checks?: {
      session_store?: {status?: unknown}; model?: {status?: unknown};
    }}};
    check(response.ok, `HERMES_HTTP_${response.status}`, response.status);
    return payload.platform === 'hermes-agent' && payload.readiness?.checks?.session_store?.status === 'ok' &&
      payload.readiness.checks.model?.status === 'ok';
  }
  /** A restricted run_scope must come back acknowledged: an accepted run that ignored it is stopped, never trusted. */
  async create(body: {input: string; instructions: string; session_id: string;
    grant_toolsets?: string[]; run_scope?: 'owner_uncertain' | 'guest' | 'build'; guest_key?: string; care_decision?: true; turn_budget?: 'background';
    model_options?: {reasoning: {enabled: boolean}}}, key: string, signal?: AbortSignal): Promise<NativeRun> {
    const run = await this.request('/v1/runs', 'POST', body, key, signal, undefined, {conversation_session_id: body.session_id});
    if (body.run_scope !== undefined && run.run_scope !== body.run_scope ||
        body.care_decision && run.session_id === body.session_id ||
        body.grant_toolsets !== undefined && JSON.stringify(run.granted_toolsets?.slice().sort()) !== JSON.stringify(body.grant_toolsets.slice().sort())) {
      await this.cancel(run.run_id, {conversation_session_id: body.session_id}).catch(() => undefined);
      throw new ContractError('HERMES_RUN_SCOPE_NOT_ENFORCED', 502);
    }
    return run;
  }
  status(runId: string, scope?: NativeConsumerScope): Promise<NativeRun> { return this.request(`/v1/runs/${encodeURIComponent(runId)}`, 'GET', undefined, undefined, undefined, runId, scope); }
  async steer(runId:string,text:string,amendmentId:string,scope:NativeConsumerScope):Promise<{delivered_to:'delegate'|'parent_replan';delegate_task_ids?:string[]}> {
    await this.status(runId,scope);
    const response=await this.fetcher(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/steer`,{
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({text,amendment_id:amendmentId}),signal:AbortSignal.timeout(this.timeoutMs)});
    const value=await this.responseJSON(response,this.maximumBytes) as {object?:unknown;run_id?:unknown;amendment_id?:unknown;
      accepted?:unknown;delivered_to?:unknown;delegate_task_ids?:unknown};
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(value.object==='hermes.run.steer'&&value.run_id===runId&&value.amendment_id===amendmentId&&value.accepted===true&&
      ['delegate','parent_replan'].includes(String(value.delivered_to))&&
      (value.delegate_task_ids===undefined||Array.isArray(value.delegate_task_ids)&&value.delegate_task_ids.every(id=>typeof id==='string')),
      'NATIVE_AMENDMENT_RECEIPT_INVALID',502);
    return {delivered_to:value.delivered_to as 'delegate'|'parent_replan',...(value.delegate_task_ids?{delegate_task_ids:value.delegate_task_ids as string[]}:{})};
  }
  cancel(runId: string, scope?: NativeConsumerScope): Promise<NativeRun> { return this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, 'POST', {}, undefined, undefined, runId, scope); }
  async approve(runId:string,requestId:string,choice:'once'|'deny',scope:NativeConsumerScope,confirmation?:Omit<OwnerConfirmation,'confirmed_at'>):Promise<OwnerConfirmation|undefined> {
    // Check the current native binding before answering; the producer owns the winning answer and timeout.
    const run=await this.status(runId,scope);
    check(run.approval?.request_id===requestId,'NATIVE_APPROVAL_NOT_PENDING',409);
    const response=await this.fetcher(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`,{
      method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},redirect:'error',
      body:JSON.stringify({request_id:requestId,choice,...(confirmation?{confirmation}:{})}),signal:AbortSignal.timeout(this.timeoutMs)});
    const result=await this.responseJSON(response,this.maximumBytes) as {object?:unknown;run_id?:unknown;request_id?:unknown;choice?:unknown;confirmation?:OwnerConfirmation};
    check(response.ok,`HERMES_HTTP_${response.status}`,response.status);
    check(result.object==='hermes.run.approval_response'&&result.run_id===runId&&result.request_id===requestId&&result.choice===choice,
      'NATIVE_APPROVAL_RESPONSE_INVALID',502);
    if(confirmation)check(result.confirmation?.confirmation_id===confirmation.confirmation_id&&
      result.confirmation.confirmed_by===confirmation.confirmed_by&&
      result.confirmation.surface?.device_id===confirmation.surface.device_id&&
      result.confirmation.surface.device_type===confirmation.surface.device_type&&
      typeof result.confirmation.confirmed_at==='string'&&Number.isFinite(Date.parse(result.confirmation.confirmed_at)),
      'NATIVE_APPROVAL_RESPONSE_INVALID',502);
    return result.confirmation;
  }
  async reminders(principal:string,signal?:AbortSignal):Promise<Reminder[]> {
    const page=await this.read(`/personal-aios/reminders?principal_id=${encodeURIComponent(principal)}`,signal) as {reminders?:unknown};
    check(Array.isArray(page.reminders)&&page.reminders.every(r=>r&&typeof r.id==='string'&&typeof r.text==='string'&&
      typeof r.fire_at==='string'&&Number.isFinite(Date.parse(r.fire_at))),'HERMES_REMINDERS_INVALID',502);
    return page.reminders;
  }
  /** L4 reads for cross-terminal context projections: the native session store's most recently active sessions,
   *  and one session's latest messages. Read-only; their own byte budget (messages carry tool results). */
  async sessions(limit: number, signal?: AbortSignal): Promise<{id: string}[]> {
    const page = await this.read(`/api/sessions?limit=${Math.max(1, Math.min(50, Math.trunc(limit)))}`, signal) as {data?: unknown};
    check(Array.isArray(page?.data), 'HERMES_INVALID_RESPONSE', 502);
    return (page.data as {id?: unknown;_lineage_root_id?:unknown}[]).filter(s => typeof s?.id === 'string')
      .map(s => ({id: typeof s._lineage_root_id==='string'?s._lineage_root_id:s.id as string}));
  }
  async session(sessionId:string):Promise<{id:string;ended_at:number|null;end_reason:string|null}> {
    const page=await this.read(`/v1/paios/sessions/${encodeURIComponent(sessionId)}/state`) as {session?:{id:string;ended_at:number|null;end_reason:string|null}};
    check(typeof page.session?.id==='string'&&(page.session.ended_at===null||typeof page.session.ended_at==='number'&&Number.isFinite(page.session.ended_at)),
      'HERMES_SESSION_STATE_INVALID',502);
    return page.session;
  }
  async messages(sessionId: string, limit: number, signal?: AbortSignal, offset = 0): Promise<{role: string; content?: unknown; timestamp?: unknown; tool_calls?: unknown; tool_name?: unknown; tool_call_id?: unknown; finish_reason?: unknown}[]> {
    const page = await this.read(`/api/sessions/${encodeURIComponent(sessionId)}/messages?order=latest&limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}${offset ? `&offset=${Math.trunc(offset)}` : ''}`, signal) as {data?: unknown};
    check(Array.isArray(page?.data), 'HERMES_INVALID_RESPONSE', 502);
    return (page.data as {role?: unknown}[]).filter(m => typeof m?.role === 'string') as {role: string}[];
  }
  private async read(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {headers: {Authorization: `Bearer ${this.token}`}, redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)])});
    const payload = await this.responseJSON(response, HISTORY_READ_BYTES, 'HERMES_HISTORY');
    check(response.ok, `HERMES_HTTP_${response.status}`, response.status);
    return payload;
  }
}
