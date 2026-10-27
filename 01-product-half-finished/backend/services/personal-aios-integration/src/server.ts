import {handlePaymentExecutor} from './payment/executor-api.ts';
import {handleModelSettingsHttp} from './model-settings-http.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {HttpBodyBudget,readBody} from './http-body.ts';
import { check, ContractError, EVENT_SCHEMA, type RawEvent, type Json } from './contracts.ts';
import { PersonalAIOSRuntime, type RegisteredDevice, type ToolCall } from './runtime.ts';
import type { Scope } from './memory/contracts.ts';
import type {TrackChunk} from './stream-archive.ts';
import type {MediaProcessRequest} from './media/service.ts';
import {decodeEmbedding, VoiceprintEnrollmentError, type OwnerChannel, type VoiceprintRegistry} from './voiceprint/registry.ts';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {getHeapStatistics} from 'node:v8';
import {speechResourcesSnapshot} from './voiceprint/engine.ts';
import {emitRuntimeEvent} from './self-events.ts';
import {createTSMcpHost, type CapabilityToolCatalog} from './capability/ts/host.ts';

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(body));
}
async function json(request: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  let wire:Buffer|undefined=await readBody(request,maximum),text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(wire);}catch{throw new ContractError('INVALID_REQUEST_JSON');}
  wire=undefined;let body:unknown;
  try {body=JSON.parse(text);}catch{throw new ContractError('INVALID_REQUEST_JSON');}
  check(body && typeof body === 'object' && !Array.isArray(body), 'REQUEST_OBJECT_REQUIRED');
  return body as Record<string, unknown>;
}
function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  check(typeof header === 'string' && header.startsWith('Bearer '), 'AUTHENTICATION_REQUIRED', 401);
  return header.slice(7);
}
// Internal enrollment/naming framing; the registry owns every rule. Enrollment without a channel is the CLI's WAV files.
async function voiceprintRoute(registry: VoiceprintRegistry, method: string | undefined, path: string, body: () => Promise<Record<string, unknown>>) {
  if (method === 'GET' && path === '/status') return registry.status();
  if (method === 'GET' && path === '') return {speaker_model: registry.model, thresholds: registry.policy.thresholds,
    owner: await registry.owner(), clusters: await registry.clusters(), assistant: await registry.assistantVoices()};
  if (path === '/owner' && method === 'DELETE') return registry.forgetOwner();
  if (path === '/owner' && method === 'POST') {
    const value = await body(), samples = value.samples;
    check(Array.isArray(samples) && samples.length > 0 && samples.length <= registry.policy.max_owner_samples &&
      samples.every(sample => sample && typeof sample === 'object' && typeof sample.speech_ms === 'number'), 'VOICEPRINT_ENROLLMENT_INVALID');
    return registry.enrollOwner({speaker_model: value.speaker_model as VoiceprintRegistry['model'], channel: (value.channel ?? 'file') as OwnerChannel,
      mode: value.mode as 'replace' | 'add',
      samples: samples.map(sample => ({embedding: decodeEmbedding(sample.embedding_base64, registry.model.dim), speech_ms: sample.speech_ms as number, ...(sample.quality === undefined ? {} : {quality: sample.quality as number})}))});
  }
  const cluster = /^\/clusters\/([^/]+)(?:\/(rename|merge))?$/u.exec(path);
  check(cluster, 'ROUTE_NOT_FOUND', 404);
  const clusterId = decodeURIComponent(cluster[1]!);
  if (method === 'DELETE' && !cluster[2]) return registry.forgetCluster(clusterId);
  check(method === 'POST' && cluster[2], 'METHOD_NOT_ALLOWED', 405);
  const value = await body();
  if (cluster[2] === 'rename') return registry.renameCluster(clusterId, value as {display_name?: string | null; known_person_id?: string | null});
  check(Object.keys(value).join(',') === 'from' && typeof value.from === 'string', 'VOICEPRINT_MERGE_INVALID');
  return registry.mergeClusters(clusterId, value.from);
}
function source(device: RegisteredDevice): RawEvent['source'] {
  return {channel: device.channel, ...(device.relay_device_id ? {relay_device_id: device.relay_device_id} : {})};
}
function rawFrom(body: Record<string, unknown>, device: RegisteredDevice, prompt: boolean): RawEvent {
  check(typeof body.event_id === 'string' && typeof body.captured_at === 'string', 'EVENT_METADATA_REQUIRED');
  const text = body.text;
  check(!prompt || typeof text === 'string', 'PROMPT_TEXT_REQUIRED');
  const appEvent = body.app_event as Json | undefined;
  const originalJson = body.app_event_json;
  check(originalJson === undefined || typeof originalJson === 'string', 'APP_ORIGINAL_JSON_REQUIRED');
  check(typeof text === 'string' || appEvent !== undefined || typeof originalJson === 'string', 'EVENT_PAYLOAD_REQUIRED');
  check([typeof text === 'string', appEvent !== undefined, typeof originalJson === 'string'].filter(Boolean).length === 1,
    'ONE_EVENT_PAYLOAD_REQUIRED');
  const isText = typeof text === 'string';
  return {schema_version: EVENT_SCHEMA, event_id: body.event_id, device_id: device.device_id,
    device_type: device.device_type, captured_at: body.captured_at, source: source(device),
    media_type: isText ? 'text' : 'app_event', mime: isText ? 'text/plain;charset=utf-8' : 'application/json',
    representation: appEvent !== undefined ? 'received_decoded_sample' : 'uploaded_original',
    payload: Buffer.from(isText ? text : typeof originalJson === 'string' ? originalJson : JSON.stringify(appEvent))};
}
function mediaRaw(body: Record<string, unknown>, device: RegisteredDevice): RawEvent {
  check(typeof body.event_id === 'string' && typeof body.captured_at === 'string' &&
    typeof body.payload_base64 === 'string' && typeof body.mime === 'string', 'MEDIA_PAYLOAD_REQUIRED');
  check(['audio','visual','file','livekit_tracks','muxed_av'].includes(String(body.media_type)) &&
    ['received_decoded_sample','uploaded_original'].includes(String(body.representation)), 'MEDIA_METADATA_REQUIRED');
  const payload = Buffer.from(body.payload_base64, 'base64');
  check(payload.length > 0 && payload.toString('base64') === body.payload_base64, 'INVALID_BASE64');
  delete body.payload_base64;
  return {schema_version: EVENT_SCHEMA, event_id: body.event_id, captured_at: body.captured_at,
    device_id: device.device_id, device_type: device.device_type, source: source(device),
    media_type: body.media_type as RawEvent['media_type'], mime: body.mime,
    representation: body.representation as RawEvent['representation'], payload};
}
// Only HTTP framing and authenticated route selection. Business ownership lives in runtime/ING/MEM/HBR/OUT.
export function createPersonalAIOSServer(runtime: PersonalAIOSRuntime, options: {
  internal_token: string; payment_key?:string; model_settings_key?:string; max_request_bytes: number; request_timeout_ms: number;
  model_route?: {provider: string; model: string; base_url: string};
  capability_catalog?: CapabilityToolCatalog;
  capability_ready?:Promise<void>;
  desktop?:(request:IncomingMessage,response:ServerResponse)=>Promise<void>;
  ownerMac?:(runtime:PersonalAIOSRuntime,input:Record<string,unknown>)=>Promise<unknown>;
  self?:{handle:(runtime:PersonalAIOSRuntime,request:IncomingMessage,response:ServerResponse)=>Promise<void>;close:()=>Promise<void>};
  resource_snapshot?:()=>{encoder_backlog?:number;call_video?:unknown;turn?:unknown;terminals?:unknown;visual?:unknown};
}) {
  check(options.internal_token.length >= 24 && options.max_request_bytes > 0 && options.request_timeout_ms > 0,
    'INVALID_SERVER_CONFIG');
  check(options.payment_key===undefined||options.payment_key!==options.internal_token,'PAYMENT_EXECUTOR_KEY_NOT_SEPARATE');
  check(options.model_settings_key===undefined||options.model_settings_key!==options.internal_token&&options.model_settings_key!==options.payment_key,'MODEL_SETTINGS_SERVICE_KEY_NOT_SEPARATE');
  const active = new Set<Promise<void>>();
  const tsPackages = createTSMcpHost(runtime, options.capability_catalog ?? (() => runtime.capabilityGateway.tools as ReturnType<CapabilityToolCatalog>), options.max_request_bytes);
  let originalUpload=false;
  const bodyBudget=new HttpBodyBudget(Math.max(options.max_request_bytes,64*1024*1024));
  const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
  let closing: Promise<void> | undefined;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let releaseBody:(()=>void)|undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Bootstrap health is the listening contract; neither wiring nor recovery gates it.
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, {service: 'personal-aios-integration', schema_version: EVENT_SCHEMA,
          reply_phase_mode: 'final_buffer', real_model_configured: options.model_route !== undefined,
          configured_model_route: options.model_route ?? null,
          verification_note: 'Configuration is not runtime acceptance; consult run evidence.'}); return;
      }
      await options.capability_ready;
      if(['POST','PUT','PATCH'].includes(request.method??''))releaseBody=bodyBudget.acquire(request,
        request.method==='PUT'&&url.pathname.startsWith('/v1/archive/backups/')?64*1024*1024:
          /^\/internal\/hermes\/gateway\/(find|check|publish|rollback|status|monitor)$/u.test(url.pathname)?4<<20:
          url.pathname==='/internal/self/mcp'?262144:options.max_request_bytes);
      if(url.pathname.startsWith('/internal/model-settings/')){
        await handleModelSettingsHttp(request,response,runtime,options.model_settings_key??'',options.max_request_bytes);return;
      }
      if(runtime.paymentAuthority&&await handlePaymentExecutor(request,response,runtime.paymentAuthority,options.payment_key,options.max_request_bytes))return;
      if(url.pathname==='/internal/capability/mcp'){
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        await tsPackages.handle(request,response);return;
      }
      if(url.pathname==='/internal/desktop/mcp'&&options.desktop){check(request.headers.authorization===`Bearer ${options.internal_token}`,'INTERNAL_AUTHENTICATION_REQUIRED',401);await options.desktop(request,response);return;}
      if(url.pathname==='/internal/self/mcp'&&options.self){check(request.headers.authorization===`Bearer ${options.internal_token}`,'INTERNAL_AUTHENTICATION_REQUIRED',401);await options.self.handle(runtime,request,response);return;}
      if(url.pathname==='/internal/owner-mac/resolve'&&options.ownerMac){
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        send(response,200,await options.ownerMac(runtime,await json(request,8192)));return;
      }
      if(request.method==='GET'&&url.pathname==='/internal/resources'){
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const packing=runtime.existingArchive().packingSnapshot(),extra=options.resource_snapshot?.()??{};
        emitRuntimeEvent({kind:'resource_snapshot',at:Date.now(),encoder_backlog:extra.encoder_backlog??0,gateway_packing_backlog:packing?packing.active+packing.queued:0});
        send(response,200,{schema:'paios.gateway.resources.v1',pid:process.pid,memory:process.memoryUsage(),v8:getHeapStatistics(),
          speech:speechResourcesSnapshot(),ingress:bodyBudget.snapshot(),packing,...extra,
          encoder_backlog:extra.encoder_backlog??null,gateway_packing_backlog:packing?packing.active+packing.queued:0,
          gateway_event_loop_delay:{unit:'milliseconds',samples:loopDelay.count,
            mean:loopDelay.count?loopDelay.mean/1e6:null,p99:loopDelay.count?loopDelay.percentile(99)/1e6:null,
            max:loopDelay.count?loopDelay.max/1e6:null}});return;
      }
      if(url.pathname==='/v1/archive/alerts'||url.pathname==='/v1/archive/snapshots'||url.pathname.startsWith('/v1/archive/snapshots/')||url.pathname.startsWith('/v1/archive/backups/')){
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);const archive=runtime.existingArchive();
        if(url.pathname==='/v1/archive/alerts'){check(request.method==='POST','METHOD_NOT_ALLOWED',405);
          await runtime.archiveAlert('L5_BACKUP_DISK_RESERVE_EXHAUSTED');send(response,200,{status:'alerted'});return;}
        if(url.pathname==='/v1/archive/snapshots'){check(request.method==='POST','METHOD_NOT_ALLOWED',405);send(response,201,await archive.snapshot(true));return;}
        const snapshot=/^\/v1\/archive\/snapshots\/([a-f0-9]{64})$/u.exec(url.pathname);
        if(snapshot){check(request.method==='DELETE','METHOD_NOT_ALLOWED',405);
          const retain=url.searchParams.get('retain_dependencies');check(retain===null||retain==='true','ARCHIVE_SNAPSHOT_INVALID');
          await archive.releaseSnapshot(snapshot[1]!,retain==='true');send(response,200,{status:'released'});return;}
        const name=decodeURIComponent(url.pathname.slice('/v1/archive/backups/'.length));
        if(request.method==='PUT'){check(!originalUpload,'ORIGINAL_UPLOAD_BUSY',429);originalUpload=true;
          try{const bytes=await readBody(request,64*1024*1024);
            send(response,201,await archive.uploadBackup(name,bytes));return;}finally{originalUpload=false;}}
        check(request.method==='GET','METHOD_NOT_ALLOWED',405);const data=await archive.downloadBackup(name);
        response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-store'});response.end(data);return;
      }
      if(url.pathname==='/internal/meeting/call'){
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        send(response,200,await runtime.meetingCall(await json(request,options.max_request_bytes)));return;
      }
      if (url.pathname.startsWith('/internal/hermes/gateway/')) {
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const operation=url.pathname.slice('/internal/hermes/gateway/'.length);
        if(operation==='catalog') {
          check(request.method==='GET','METHOD_NOT_ALLOWED',405);
          send(response,200,runtime.capabilityGateway.catalog());return;
        }
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);
        if(operation==='lifecycle'){
          send(response,200,await runtime.capabilityHook(await json(request,options.max_request_bytes)));return;
        }
        if(['find','check','publish','rollback','status','monitor'].includes(operation)){
          send(response,200,await runtime.capabilityRegistryCall(operation as Parameters<PersonalAIOSRuntime['capabilityRegistryCall']>[0],await json(request,4<<20)));return;
        }
        check(operation==='decide'||operation==='receipt'||operation==='observe','ROUTE_NOT_FOUND',404);
        const result=await runtime.capabilityCall(operation,await json(request,options.max_request_bytes));
        if(operation==='observe'){response.writeHead(204);response.end();}else send(response,200,result);
        return;
      }
      if (url.pathname === '/internal/hermes/tool-contracts') {
        check(request.method === 'GET', 'METHOD_NOT_ALLOWED', 405);
        check(bearer(request) === options.internal_token, 'INTERNAL_AUTHENTICATION_REQUIRED', 401);
        send(response, 200, runtime.toolSchemas()); return;
      }
      if (url.pathname.startsWith('/internal/hermes/tools/')) {
        check(request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
        check(bearer(request) === options.internal_token, 'INTERNAL_AUTHENTICATION_REQUIRED', 401);
        const body = await json(request, options.max_request_bytes);
        check(body.context && body.args && typeof body.context === 'object' && typeof body.args === 'object',
          'TOOL_CONTEXT_REQUIRED');
        const result = await runtime.tool(decodeURIComponent(url.pathname.slice('/internal/hermes/tools/'.length)),
          body as unknown as ToolCall);
        send(response, 200, result); return;
      }
      if(url.pathname==='/internal/hermes/effect-consent'){
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const body=await json(request,options.max_request_bytes);
        check(body.context&&body.effect&&typeof body.context==='object'&&typeof body.effect==='object','EFFECT_CLASSIFICATION_REQUIRED');
        send(response,200,await runtime.effectConsent(body.context as ToolCall['context'],body.effect as Record<string,unknown>,body.approved===true,body.ride_ok===true,
          typeof body.approval_request_id==='string'?body.approval_request_id:'',body.confirmation as import('./hermes-client.ts').OwnerConfirmation|undefined));return;
      }
      if(url.pathname==='/internal/hermes/payment-source'){
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const body=await json(request,options.max_request_bytes);check(typeof body.run_id==='string','RUN_BINDING_REQUIRED');
        send(response,200,runtime.paymentSource(body.run_id,typeof body.intent_id==='string'?body.intent_id:undefined));return;
      }
      if(url.pathname==='/internal/hermes/errand-report-context') {
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const body=await json(request,options.max_request_bytes);
        check(body.context&&typeof body.context==='object'&&!Array.isArray(body.context),'TOOL_CONTEXT_REQUIRED');
        send(response,200,await runtime.receiptErrandReportContext(body.context as {run_id:string;session_id:string},body.job_ids));return;
      }
      if(['/internal/hermes/phone-task-context','/internal/hermes/schedule-context','/internal/hermes/reminders-changed','/internal/hermes/scheduled-delivery','/internal/hermes/scheduled-task'].includes(url.pathname)) {
        check(request.method==='POST','METHOD_NOT_ALLOWED',405);
        check(bearer(request)===options.internal_token,'INTERNAL_AUTHENTICATION_REQUIRED',401);
        const body=await json(request,options.max_request_bytes);
        if(url.pathname.endsWith('/schedule-context')||url.pathname.endsWith('/phone-task-context')) {
          check(body.context&&typeof body.context==='object','TOOL_CONTEXT_REQUIRED');
          send(response,200,await (url.pathname.endsWith('/phone-task-context')?runtime.phoneTaskContext(body.context as ToolCall['context']):runtime.scheduleContext(body.context as ToolCall['context'])));
        } else if(url.pathname.endsWith('/reminders-changed')) {
          check(typeof body.principal_id==='string','PRINCIPAL_REQUIRED');await runtime.remindersChanged(body.principal_id);
          send(response,200,{status:'synced'});
        } else if(url.pathname.endsWith('/scheduled-task')) {
          send(response,200,{status:'admitted',...await runtime.scheduledTask(body as Parameters<PersonalAIOSRuntime['scheduledTask']>[0])});
        } else {
          await runtime.scheduledDelivery(body as Parameters<PersonalAIOSRuntime['scheduledDelivery']>[0]);
          send(response,200,{status:'delivered',...(body.system_event!==undefined?{system_event_id:body.id}:{})});
        }
        return;
      }
      if (url.pathname === '/internal/voiceprint' || url.pathname.startsWith('/internal/voiceprint/')) {
        check(bearer(request) === options.internal_token, 'INTERNAL_AUTHENTICATION_REQUIRED', 401);
        send(response, 200, await voiceprintRoute(runtime.voiceprintRegistry(), request.method, url.pathname.slice('/internal/voiceprint'.length),
          () => json(request, options.max_request_bytes))); return;
      }
      const device = await runtime.authenticate(bearer(request));
      if (request.method === 'GET' && url.pathname === '/v1/voice/confirmations') {
        send(response, 200, {confirmations: await runtime.voiceConfirmations(device)}); return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/voice/confirm') {
        const body = await json(request, options.max_request_bytes);
        check(Object.keys(body).every(key=>['confirmation_id','choice','auth'].includes(key))&&typeof body.confirmation_id==='string'&&
          (body.choice===undefined||body.choice==='approve'||body.choice==='deny')&&
          (body.auth===undefined||body.auth==='face_id'||body.auth==='touch_id'),'VOICE_CONFIRMATION_REQUIRED');
        send(response, 202, await runtime.confirmVoice(device, {confirmation_id:body.confirmation_id,...(body.choice?{choice:body.choice}:{}),...(body.auth!==undefined?{auth:body.auth}:{})})); return;
      }
      if(request.method==='POST'&&url.pathname==='/v1/originals') {
        check(!originalUpload,'ORIGINAL_UPLOAD_BUSY',429);originalUpload=true;
        try{const body=await json(request,options.max_request_bytes);
          send(response,201,await runtime.archiveUpload(mediaRaw(body,device),device));return;}
        finally{originalUpload=false;}
      }
      if (request.method === 'POST' && url.pathname === '/v1/media/chunks') {
        const body = await json(request, options.max_request_bytes);
        check(body.track && typeof body.track === 'object', 'TRACK_REQUIRED');
        send(response, 202, await runtime.appendMedia(mediaRaw(body, device), device, body.track as TrackChunk)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/media/process') {
        const body = await json(request, options.max_request_bytes);
        check(typeof body.session_id === 'string' && typeof body.operation_id === 'string' &&
          body.analysis && typeof body.analysis === 'object', 'MEDIA_ANALYSIS_REQUIRED');
        send(response, 202, await runtime.processMedia(device, body.session_id, body.operation_id,
          body.analysis as MediaProcessRequest)); return;
      }
      const mediaCancel = /^\/v1\/media\/processes\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (request.method === 'POST' && mediaCancel) {
        send(response, 202, await runtime.cancelMedia(device, decodeURIComponent(mediaCancel[1]!))); return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/confirm') {
        const body = await json(request, options.max_request_bytes);
        check(typeof body.action_id === 'string' && typeof body.payload_sha256 === 'string', 'ACTION_CONFIRMATION_REQUIRED');
        send(response, 200, await runtime.confirmAction(device, {action_id: body.action_id, payload_sha256: body.payload_sha256})); return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/memory/confirm') {
        const body = await json(request, options.max_request_bytes);
        check(typeof body.command_id === 'string' && typeof body.payload_sha256 === 'string' &&
          body.scope && typeof body.scope === 'object', 'MEMORY_CONFIRMATION_REQUIRED');
        send(response, 200, await runtime.confirmMemory(device, {command_id: body.command_id,
          payload_sha256: body.payload_sha256, ...(body.proposal_ref===undefined?{}:{proposal_ref:body.proposal_ref as string})}, body.scope as Scope)); return;
      }
      if (request.method === 'POST' && ['/v1/prompts', '/v1/observations'].includes(url.pathname)) {
        const body = await json(request, options.max_request_bytes);
        check(typeof body.session_id === 'string', 'SESSION_ID_REQUIRED');
        send(response, 202, await runtime.submit(rawFrom(body, device, url.pathname === '/v1/prompts'),
          device, body.session_id, url.pathname === '/v1/prompts')); return;
      }
      const match = /^\/v1\/events\/([^/]+)(?:\/(result|ack|cancel|cancel-playback|reconcile|audio|retry-voice))?$/u.exec(url.pathname);
      check(match, 'ROUTE_NOT_FOUND', 404);
      const dId = decodeURIComponent(match[1]!); const session = url.searchParams.get('session_id');
      check(session, 'SESSION_ID_REQUIRED');
      if (request.method === 'GET' && !match[2]) send(response, 200, await runtime.event(device, session, dId));
      else if (request.method === 'GET' && match[2] === 'result') {
        const replay=url.searchParams.get('text_replay');check(replay === null || replay === 'sealed','TEXT_REPLAY_MODE_INVALID');
        send(response, 200, await runtime.result(device, session, dId,replay === 'sealed' ? {text_replay:'sealed'} : {}));
      }
      else if (request.method === 'POST' && match[2] === 'cancel') send(response, 202, await runtime.cancelRun(device, session, dId));
      else if (request.method === 'POST' && match[2] === 'cancel-playback') {
        const body = await json(request, options.max_request_bytes);
        check(Object.keys(body).length === 1 && typeof body.reply_epoch === 'number', 'OUTPUT_CANCEL_REQUEST_INVALID');
        send(response, 200, await runtime.cancelPlayback(device, session, dId, body.reply_epoch));
      }
      else if (request.method === 'POST' && match[2] === 'reconcile') send(response, 202, await runtime.reconcile(device, session, dId));
      else if (request.method === 'POST' && match[2] === 'ack') send(response, 200, await runtime.acknowledge(device,
        session, dId, await json(request, options.max_request_bytes)));
      else if (request.method === 'POST' && match[2] === 'retry-voice') send(response, 200, await runtime.retryVoice(device, session, dId));
      else if (request.method === 'GET' && match[2] === 'audio') {
        const ref = url.searchParams.get('audio_ref'); check(ref, 'AUDIO_REF_REQUIRED');
        const audio = await runtime.audio(device, session, dId, ref);
        response.writeHead(200, {'Content-Type': audio.mime, 'Content-Length': audio.bytes.length,
          'Cache-Control': 'no-store', 'X-Audio-SHA256': audio.sha256}); response.end(audio.bytes);
      }
      else throw new ContractError('METHOD_NOT_ALLOWED', 405);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if(!request.complete){request.pause();response.setHeader('Connection','close');}
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      send(response, error instanceof ContractError ? error.status : missing ? 404 : 500,
        {error_code: error instanceof ContractError ? error.code : missing ? 'OBJECT_NOT_FOUND' : 'INTERNAL_ERROR',
          ...(error instanceof VoiceprintEnrollmentError ? {sample_consistency: error.sample_consistency} : {})});
    }finally{releaseBody?.();}
  };
  const server = createServer((request, response) => {
    if (closing) {send(response, 503, {error_code: 'RUNTIME_CLOSED'}); return;}
    const work = handle(request, response);
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
  });
  server.once('close',()=>loopDelay.disable());
  server.requestTimeout = options.request_timeout_ms;
  return Object.assign(server, {bodyBudgetSnapshot:()=>bodyBudget.snapshot(),closeAndDrain(): Promise<void> {
    if (closing) return closing;
    // Socket closure alone does not join an async route's database/storage work.
    closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const stopped = new Promise<void>((resolve, reject) => server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
      try { server.closeAllConnections(); } catch (error) { errors.push(error); }
      try { await stopped; } catch (error) { errors.push(error); }
      while (active.size) await Promise.allSettled([...active]);
      try {await options.self?.close();} catch(error) {errors.push(error);}
      try {await tsPackages.close();} catch(error) {errors.push(error);}
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'SERVER_CLOSE_FAILED');
    });
    return closing;
  }});
}
