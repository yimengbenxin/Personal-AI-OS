import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import { ConnectionQuality, DataPacketKind, RoomEvent } from '@livekit/rtc-node';
import { consumeBoundedByteStream } from './sdk-room.ts';
import {REALTIME_READINESS_DEADLINE_MS,settleWithSignal,withinRealtimeReadiness} from './realtime-readiness.ts';
import {createWireExtensions,type WireExtension,type WireBody} from './personal-aios-terminal-wire.ts';
import { check, ContractError, digest, id, utc, runScope, EVENT_SCHEMA, type CaptureLocation, type ProcessedEvent, type RawEvent } from '../../../services/personal-aios-integration/src/contracts.ts';
import {hasFirstPersonCamera,hasTerminalCapability,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {terminalDisplayCard,type TerminalQuestion,type TerminalCallOffer,type TerminalPersonHint} from '../../../services/personal-aios-integration/src/terminal-cards.ts';
import type { OutputAck } from '../../../services/personal-aios-integration/src/output.ts';
import {emitRuntimeEvent} from '../../../services/personal-aios-integration/src/self-events.ts';
import type { PersonalAIOSRuntime } from '../../../services/personal-aios-integration/src/runtime.ts';
import type { LiveKitCloudParticipantPort, LiveKitCloudRoomPort } from './livekit-cloud-participant.ts';
import type { RealtimeBootstrapConnectedInput, RealtimeCentralTextTransportDescriptor } from './realtime-public-control-runtime.ts';
import type { FormalSourceAuthority } from './personal-aios-formal-source.ts';
import type { CallReason, CallTurn, CallOpenOptions, CallStateExtra, CallIdentity } from './voice-call-session.ts';
import type { ErrandProgress, ErrandResult } from './errand-spool.ts';
import type {ActivityUpdate} from '../../../services/personal-aios-integration/src/activity.ts';
import type { Notify } from './bark-notifier.ts';
import type { VoiceWindowPurpose } from './personal-aios-formal-pcm.ts';
import type { OwnerStatus } from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import type { HealthBatch } from '../../../services/personal-aios-integration/src/health/store.ts';
import type { ContactsBatch } from '../../../services/personal-aios-integration/src/contacts/store.ts';
import {mergeModelSettingsWire,isModelSettingsInput,dispatchModelSettings} from './personal-aios-model-settings-wire.ts';
import {activityWire} from './activity-wire.ts';
import {mergePaymentWire,isPaymentInput,dispatchPayment} from './personal-aios-payment-wire.ts';
import type {MoveInput} from '../../../services/personal-aios-integration/src/movement.ts';
export interface CallSink {state(call_id: string, state: string, extra?: CallStateExtra): void|Promise<void>;
  transcript(call_id: string, turn: number, role: 'user' | 'assistant' | 'main_agent', text: string, interrupted?: boolean, identity?:CallIdentity,expects_mirror?:boolean): void; turn(turn: CallTurn, audio?:Promise<PromiseSettledResult<NonNullable<CallTurn['audio']>>>): void|Promise<void>;sealed?(call_id:string,reason:CallReason,final_turn:number):void|Promise<void>; playbackReset?(call_id:string,track_sid?:string,target?:'avatar'):void}
// One pinned source contract supplies both producer projection and terminal validation.
interface FormalMessageContract {
  version: number; schema: string; input_topic: RealtimeCentralTextTransportDescriptor['inputTopic']; output_topic: RealtimeCentralTextTransportDescriptor['outputTopic'];
  input_limit: number; output_limit: number; controls: string[]; camera_topic?:string; voice_topic: string; voice_transport: string;
  $defs: Record<string, AnySchema>;
  inputs: Record<string, {definition: AnySchema; error: string}>;
  outputs: Record<string, {properties: Record<string, AnySchema>} & AnySchema>;
}
const contractBytes = readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json', import.meta.url));
check(createHash('sha256').update(contractBytes).digest('hex') === '9dc8b39792e2fc11371df23b2aaf9be7c3d0bb38315023045bc33e4826c605c0', 'FORMAL_MESSAGE_CONTRACT_CHANGED');
const wire = JSON.parse(contractBytes.toString('utf8')) as FormalMessageContract;
check(wire.version === 1, 'FORMAL_MESSAGE_CONTRACT_VERSION');
const movementInputs = new Set(['ride_state','move_frame','nav_state','ride_control','nav_control']);
mergePaymentWire(wire);
mergeModelSettingsWire(wire);
export const FORMAL_TEXT_INPUT_TOPIC = wire.input_topic;
export const FORMAL_TEXT_OUTPUT_TOPIC = wire.output_topic;
export const FORMAL_TEXT_ENVELOPE_SCHEMA = wire.schema;
export const FORMAL_CAMERA_TOPIC = wire.camera_topic;
export const FORMAL_VOICE_TOPIC = wire.voice_topic;
export const FORMAL_VOICE_TRANSPORT = wire.voice_transport;
export type FormalTextOutputEnvelope = Record<string, unknown>;
/** The one validator setup for the formal wire and every registered extension; the staging sim client reuses it. */
export function createFormalWireAjv(): Ajv {
  const ajv = new Ajv({strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false});
  addFormats.default(ajv,['date-time','uuid','uri']);
  ajv.addFormat('paios-utc', {type: 'string', validate: value => {try {utc(value); return true;} catch {return false;}}});
  return ajv;
}
const ajv = createFormalWireAjv();
const compile = (definition: AnySchema) => ajv.compile({$defs: wire.$defs, ...(definition as object)});
const inputValidators: Record<string, ValidateFunction> = Object.fromEntries(Object.entries(wire.inputs).map(([name, input]) => [name, compile(input.definition)]));
const cameraMetadataValidator = compile({$ref:'#/$defs/camera_frame'});
const outputValidators: Record<string, ValidateFunction> = Object.fromEntries(Object.entries(wire.outputs).map(([name, output]) => [name, compile(output)]));
// Shared by every room/ingress, including overlapping connections for one authenticated device.
const cameraReservations=new Map<string,{streams:number;bytes:number}>();let cameraStreams=0,cameraBytes=0;
// Shared by overlapping ingresses, not reset by reconnect. Close/cancel cannot borrow ordinary capacity.
const ingressReservations=new Map<string,{count:number;bytes:number;controls:number;controlBytes:number}>();
const ingressTotal={count:0,bytes:0,controls:0,controlBytes:0};
const packetWork=new AsyncLocalStorage<{active:boolean}>();
const reservedControls=new Set(['call_close','voice_close','voiceprint_cancel','errand_cancel','cancel_run','cancel_playback']);
function reservePacket(key:string,bytes:number,control:boolean,pcm=false):(()=>void)|undefined {
  const terminal=ingressReservations.get(key)??{count:0,bytes:0,controls:0,controlBytes:0};
  const count=control?'controls':'count',size=control?'controlBytes':'bytes';
  // The PCM class holds the existing fifty 100 ms frames and its failure receipt; all classes share totals.
  if(terminal[count]>=(control?4:pcm?64:32)||ingressTotal[count]>=(control?16:128)||
    terminal[size]+bytes>(control?8192:pcm?256*1024:128*1024)||ingressTotal[size]+bytes>(control?64*1024:512*1024))return;
  terminal[count]++;terminal[size]+=bytes;ingressTotal[count]++;ingressTotal[size]+=bytes;
  ingressReservations.set(key,terminal);
  return ()=>{terminal[count]--;terminal[size]-=bytes;ingressTotal[count]--;ingressTotal[size]-=bytes;
    if(!terminal.count&&!terminal.controls)ingressReservations.delete(key);};
}
/** Text the bounded output packet can carry: whole characters, never a split surrogate pair. */
const clip = (text: string, limit: number) => Array.from(text).slice(0, limit).join('');
// This marker comes from runtime source lineage, never assistant wording.
const replyPrivacy=(result:object):{private?:'payment'}=>'private' in result&&result.private==='payment'?{private:'payment'}:{};
const replyNotice=(result:object,text:string)=>({title:'依米',body:replyPrivacy(result).private?'依米：付款结果已更新，解锁依米查看。':text});
/** The owner profile as the phone shows it (no embeddings, no model internals). */
const ownerWire = (status: OwnerStatus) => ({enrolled: status.enrolled, reenrollment_required: status.reenrollment_required, samples: status.samples,
  ...(status.updated_at ? {updated_at: status.updated_at} : {}), ...(status.consistency ? {consistency_min: status.consistency.min} : {})});
const safeFailureCode = (code: unknown, fallback: string) => typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(code)?code:fallback;
const safeCode = (error: unknown, fallback: string) => safeFailureCode(error instanceof ContractError?error.code:undefined,fallback);
function output(operation: string, source: Record<string, unknown>): FormalTextOutputEnvelope {
  const definition = wire.outputs[operation];
  check(Object.hasOwn(wire.outputs, operation) && definition, 'FORMAL_TEXT_OUTPUT_OPERATION_INVALID');
  // Receipts/chunks are already source DTOs. Only the bounded header omits the full result body/effects.
  const body = operation === 'result_header'
    ? {schema_version: wire.schema, ...Object.fromEntries(Object.keys(definition.properties).filter(key => key !== 'schema_version').map(key => [key, source[key]]))}
    : {...source,...(Object.hasOwn(definition.properties,'schema_version')?{schema_version:wire.schema}:{})};
  check(outputValidators[operation]!(body), 'FORMAL_TEXT_OUTPUT_INVALID');
  return body;
}
// Framing only: ING owns D, admission owns native run, OUT owns result and delivery truth.
export function createFormalTextIngress(options: {participant: LiveKitCloudParticipantPort; runtime: PersonalAIOSRuntime; extensions?:readonly WireExtension[];
  authority: FormalSourceAuthority; max_packet_bytes: number; voice_transport?: 'wav_byte_stream_v1';
  realtime_busy?:()=>boolean;
  /** Server-side button windows on the one PCM reader; the device never supplies raw refs, ranges or clocks. */
  voice_capture?: {open(operation: string, purpose?: VoiceWindowPurpose): void | Promise<void>;
    commit(operation: string, purpose?: VoiceWindowPurpose): Promise<{event_id: string; request: Parameters<PersonalAIOSRuntime['processVoice']>[3]}>; cancel(operation: string): boolean};
  /** Live limited-F call owner; this ingress only frames its state/transcripts and mirrors finished turns to the main agent. */
  voice_call?: {open(call_id: string, extra?: CallOpenOptions): Promise<string|void>; close(call_id: string, reason: CallReason,error_code?:string): Promise<boolean|void>;
    pcm?(call_id:string,frame:{seq:number;captured_at_ms:number;sample_rate:16000;pcm_s16le_base64:string}):Promise<void>;
    videoCommand?(call_id:string,command:{video:boolean;revision:number;opening?:true}|null):void;
    setVideo?(call_id:string,enabled:boolean,revision?:number):Promise<void>;
    avatarCommand?(call_id:string,command:{avatar:boolean;revision:number;opening?:true}|null):void;
    setAvatar?(call_id:string,enabled:boolean,revision?:number):Promise<void>;
    conversationMode?(call_id:string):'chat'|'thinking'|undefined;
    setConversationMode?(call_id:string,mode:'chat'|'thinking',control?:{id:string;authorize:()=>Promise<void>;confirmed:()=>Promise<void>}):Promise<void>;
    thinkingStatus?(call_id:string,status:'waiting'|'slow'|'failed'|'interrupted',processed_event_id?:string):Promise<void>;
    thinkingSettled?(call_id:string,processed_event_id:string):Promise<void>;
    context?(text:string):Promise<boolean>;
    request?(text:string,target:{call_id:string;identity:Exclude<CallIdentity,'pending'>;audio?:NonNullable<CallTurn['audio']>}):Promise<boolean>;
    respond(text: string,target?:{call_id:string;identity:Exclude<CallIdentity,'pending'>;turn?:number;progress?:boolean;signal?:AbortSignal;message_id?:string},care?:boolean): Promise<boolean>;
    identify?(call_id:string,identity:CallIdentity,context?:()=>Promise<string>,authority?:{owner_override:true}):Promise<boolean>; pending?():string|undefined;
    trustCall?(scope:{principal_id:string;device_id:string},confirmed_at?:string):string|undefined;
    peerLost?(source:RegisteredDevice,continuity:string):void;rejoin?(source:RegisteredDevice,continuity:string):Promise<void>;
    isVideo?():boolean; attach(sink: CallSink): () => void};
  /** Background errands (phone executor): finished ones are submitted by the attached connection as an observation D;
   *  running ones are shown as a live feed (errand_progress) and can be stopped from the app (errand_cancel). */
  errands?: {
    cancel(job_id: string): Promise<boolean>};
  /** Reaches the user's phone when a main-agent reply can be neither spoken nor shown (hung up, app gone). */
  notify?: Notify;
  onError: (error: unknown) => void}) {
  check(Number.isSafeInteger(options.max_packet_bytes) && options.max_packet_bytes > 0, 'FORMAL_TEXT_PACKET_BUDGET_REQUIRED');
  const realtimeBusy=options.realtime_busy??(()=>options.voice_call?.pending?.()!==undefined);
  const extensions=createWireExtensions(options.extensions??[],wire,compile);
  const reference=(value:unknown):string|null=>{try{id(value);return value as string;}catch{return null;}};
  // Operational trace for the data channel, like the HTTP route log: identifiers only, never payloads.
  const opName=(value:unknown)=>typeof value==='string'&&/^[a-z_]{1,40}$/.test(value)?value:'invalid';
  const trace=(line:Record<string,unknown>)=>{try{process.stderr.write(`${JSON.stringify({...line,at:Date.now()})}\n`);}catch{}};
  const pending = new Set<Promise<unknown>>(); let closed = false; let closeFlight: Promise<void> | undefined;
  type CallContext={call_id:string;owner:number;pending:Set<Promise<unknown>>;refs:Set<string>;turn:number;identity:CallIdentity;
    source:RegisteredDevice;session:string;capture:ReturnType<PersonalAIOSRuntime['captureCall']>;enrollment?:string|undefined;sealDone?:PromiseWithResolvers<void>;sealing?:Promise<void>};
  const retainedCalls=new Set<CallContext>();
  const enrollmentCalls=new Map<string,string>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  let generation = 0; let currentRoom: LiveKitCloudRoomPort | undefined; let detach: (() => void) | undefined;
  let connection:AbortController|undefined;
  const changed=()=>new ContractError('FORMAL_TEXT_CONNECTION_CHANGED',409);
  const invalidate = () => {generation++;connection?.abort(changed()); detach?.(); detach=undefined; currentRoom=undefined;};
  const setup = async (input: RealtimeBootstrapConnectedInput) => {
    check(!closed, 'FORMAL_TEXT_INGRESS_CLOSED', 503);
    invalidate(); const expectedGeneration = generation;
    const localConnection=connection=new AbortController(),connectionSignal=localConnection.signal;
    let setupSignal=input.readinessSignal;
    if (!input.enabledMedia.data) return;
    const room = options.participant.roomPort;
    check(room?.on && room.localParticipant?.publishData && room.localParticipant.sendText && room.isConnected !== false, 'FORMAL_TEXT_ROOM_REQUIRED', 503);
    currentRoom = room;
    const current = () => !closed && generation === expectedGeneration && currentRoom === room && options.participant.roomPort === room;
    const credential = options.authority.credentialForBootstrap(input);
    const device = await settleWithSignal(()=>track(options.runtime.authenticate(credential)),connectionSignal);
    if (!current()) return;
    const identity = input.currentBinding.credentialIdentity; const session = input.currentBinding.continuityId;
    check(typeof identity === 'string' && typeof session === 'string', 'FORMAL_TEXT_BINDING_REQUIRED');
    // Rejoin renews lifecycle metadata. Server-owned finalization retains the call's opening provenance.
    for(const context of retainedCalls)if(context.session===session&&context.source.principal_id===device.principal_id&&
      context.source.device_id===device.device_id&&context.source.device_type===device.device_type)context.source=device;
    let attached = true,detachExtensions:(()=>void)|undefined;
    const makePeer=()=>{const cancel=new AbortController();return {...Promise.withResolvers<void>(),cancel,signal:AbortSignal.any([connectionSignal,cancel.signal])};};
    let peerKnown=false,peer=makePeer(),flushing=true,publishing:Promise<unknown>=Promise.resolve();
    const outputFlights=new Map<Promise<unknown>,boolean>();
    const subscriptions=new Map<string,()=>void>();
    // Connection-local send cursors suppress duplicate playback while awaiting OUT ACK; cold connections replay.
    const sentErrands=new Map<string,{epoch:number;text:number;voice:number;header?:Buffer;record?:boolean;recordFlight?:Promise<void>}>();
    // The device's latest fix lives in the runtime's one per-device authority (fed by submit, call_open and location_update;
    // read for every event this connection captures, and by the wake turns heard on the device).
    const placed = async (source: Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>, sent?: unknown) => {
      const location = await options.runtime.locate(source, sent as CaptureLocation | null | undefined);
      return location ? {location} : {};
    };
    async function authorized(){
      let source;
      try {source=await track(options.runtime.authenticate(credential));}
      catch(error){
        options.runtime.paymentSourceRejected?.(device,error);
        if(current()){invalidate();attached=false;await options.participant.disconnect();}throw error;
      }
      check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);return source;
    }
    const enqueue=<T>(send:()=>Promise<T>,ambient=false)=>{
      // A deferred ambient projection cannot hold ready/call-state publication behind the live call.
      const sending=flushing&&!ambient?publishing.then(send):send();outputFlights.set(sending,ambient);
      void sending.then(()=>outputFlights.delete(sending),()=>outputFlights.delete(sending));
      if(flushing&&!ambient)publishing=sending.then(()=>{},()=>{});return sending;
    };
    // The existing output queue retains unACKed work; only an attempt belongs to a peer.
    const deliver=async<T>(send:(target:typeof peer)=>Promise<T>,recipient?:typeof peer,waiting?:()=>void,signal?:AbortSignal):Promise<T>=>{
      const ownsPacket=packetWork.getStore()?.active===true;
      for(;;){signal?.throwIfAborted();waiting?.();const recipientPeer=recipient??peer;
        const target=signal?{...recipientPeer,signal:AbortSignal.any([signal,recipientPeer.signal])}:recipientPeer;
        let sending:Promise<T>|undefined;
        try {
          try {return await settleWithSignal(async()=>{await target.promise;target.signal.throwIfAborted();return sending=send(target);},target.signal);}
          // Cancellation retires the peer, not the SDK work. Settle it before releasing or retrying admission.
          finally {if(ownsPacket&&sending)await sending;}
        }
        catch(error){
          if(!recipient&&error instanceof ContractError&&error.code==='FORMAL_TEXT_CONNECTION_CHANGED'&&attached&&current()&&recipientPeer!==peer&&!signal?.aborted)continue;
          throw error;
        }
      }
    };
    // A bounded publication waits here, outside its deadline, for the device to join or to return after a transport loss.
    const present=async(signal:AbortSignal)=>{
      for(;;){const target=peer;
        try {return await settleWithSignal(()=>target.promise,AbortSignal.any([signal,target.signal]));}
        catch(error){if(!signal.aborted&&target!==peer&&attached&&current())continue;throw error;}
      }
    };
    // One line per terminal publication slower than 1 s: identifiers, size and timings only, never payload text. It names the
    // step it waited in (presence, authorize or sdk): the current one once it has waited 5 s, else the longest when it settles.
    const timed=(body:Record<string,unknown>)=>{
      const started=Date.now(),spent=new Map<string,number>();let step='presence',since=started,bytes:number|undefined,logged=false;
      const enter=(next:string)=>{const now=Date.now();spent.set(step,(spent.get(step)??0)+now-since);step=next;since=now;};
      const log=(waiting?:string)=>{if(logged)return;logged=true;enter(step);
        trace({terminal_publication_slow:opName(body.operation),device:device.device_id.slice(0,8),bytes:bytes??Buffer.byteLength(JSON.stringify(body)),
          step:waiting??[...spent].reduce((a,b)=>b[1]>a[1]?b:a)[0],elapsed_ms:Date.now()-started});};
      const timer=setTimeout(()=>log(step),5000);timer.unref();
      return {enter,size:(n:number)=>{bytes=n;},done:()=>{clearTimeout(timer);if(Date.now()-started>1000)log();}};
    };
    const publish = (body: Record<string,unknown> & {operation:string},sent?:{header?:Buffer},valid?:()=>boolean,sequence=true,recipient?:typeof peer,signal?:AbortSignal,onPublished?:()=>Promise<void>) => {
      const destination=recipient??(body.operation==='ready'?peer:undefined),timing=timed(body);
      const send=()=>deliver(async target=>{
      check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);
      // The publication retains its own work; a call only delays the ambient projection, never consumes it.
      let source:Awaited<ReturnType<typeof authorized>>;
      for(;;){
        if(body.operation==='ambient_reply')while(realtimeBusy()){
          timing.enter('call');
          try{await delay(50,undefined,{signal:target.signal});}catch(error){target.signal.throwIfAborted();throw error;}
          check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);
        }
        timing.enter('authorize');source=await authorized();target.signal.throwIfAborted();
        if(body.operation!=='ambient_reply'||!realtimeBusy())break;
      }
      const framed=extensions.output({...activityWire(body),session_id:session},output),card=terminalDisplayCard(source,framed as typeof body);
      const bytes = Buffer.from(JSON.stringify(card?output(card.operation,{...card,...replyPrivacy(body)}):framed));
      check(bytes.byteLength <= Math.min(options.max_packet_bytes,wire.output_limit), 'FORMAL_TEXT_OUTPUT_PACKET_TOO_LARGE', 413);
      timing.size(bytes.byteLength);if(sent?.header?.equals(bytes))return;
      check(!valid||valid(),'NAVIGATION_SESSION_CHANGED',409);
      check(attached && current(), 'FORMAL_TEXT_CONNECTION_CHANGED', 409);
      if(body.operation==='ready')check(peer===destination,'FORMAL_TEXT_CONNECTION_CHANGED',409);
      timing.enter('sdk');
      // Swift reads user packets' deprecated inner sender, which Rust leaves empty; streams carry the server-stamped sender.
      if(body.operation==='ready')await room.localParticipant!.sendText!(bytes.toString('utf8'),{destinationIdentities:[identity],topic:FORMAL_TEXT_OUTPUT_TOPIC});
      else await room.localParticipant!.publishData!(bytes, {reliable:true,destination_identities:[identity],topic:FORMAL_TEXT_OUTPUT_TOPIC});
      if(onPublished)await onPublished();
      target.signal.throwIfAborted();
      if(sent)sent.header=bytes;
      trace({formal_text_out:opName(body.operation),...(typeof body.source_status==='string'?{source_status:opName(body.source_status)}:{}),
        ...(typeof body.error_code==='string'?{safeErrorCode:body.error_code}:{})});
      // SDK publication records a send only; rendered/played delivery still requires an ACK.
      },destination,()=>timing.enter('presence'),signal);
      const run=()=>sequence?enqueue(send,body.operation==='ambient_reply'):send();
      const settled=signal?settleWithSignal(run,signal):run();void settled.then(timing.done,timing.done);return settled;
    };
    // Feature publication owns its own bounded queue, including before the peer becomes ready.
    const leave=async()=>{if(current()){invalidate();await options.participant.disconnect();}};
    const stopPublication=extensions.prepare({device,room,identity,current:()=>attached&&current(),leave,ready:present,publish:(body,signal)=>publish({session_id:session,...body},undefined,undefined,false,undefined,signal)});
    let locationRequest:{id:string;promise:Promise<void>;finish:()=>void}|undefined;
    const requestLocation=async()=>{
      if(locationRequest)return locationRequest.promise;
      const id=crypto.randomUUID(),{promise,resolve}=Promise.withResolvers<void>(),cancel=new AbortController();
      // The phone owns a 10 s sensor wait; leave another second for its correlated result.
      const finish=()=>{clearTimeout(timer);cancel.abort();if(locationRequest?.id===id)locationRequest=undefined;resolve();},timer=setTimeout(finish,11_000);
      locationRequest={id,promise,finish};
      void publish({operation:'location_request',session_id:session,request_id:id},undefined,undefined,true,undefined,cancel.signal)
        .catch(error=>{if(cancel.signal.aborted)return;finish();options.onError(error);});
      await promise;
    };
    const publishResult=(value:Awaited<ReturnType<PersonalAIOSRuntime['fixedResult']>>,outreach?:'errand')=>enqueue(()=>deliver(async target=>{
      const {result:r,chunks,voice_chunks,text_replay,text_chunk_count,pending_text_chunk_count,rendered_text_through_seq,pending_voice_chunk_count}=value;
      const previous=sentErrands.get(r.processed_event_id),sent=outreach?(previous?.epoch===r.reply_epoch?previous:{epoch:r.reply_epoch,text:0,voice:0}):undefined;
      if(sent)sentErrands.set(r.processed_event_id,sent);
      await publish({operation:'result_header',...r,text_replay,text_chunk_count,pending_text_chunk_count,
        rendered_text_through_seq,pending_voice_chunk_count,voice_transport:options.voice_transport ?? 'not_supported'},sent,undefined,false,target);
      for (const chunk of chunks) {
        if(sent&&chunk.seq<=sent.text)continue;
        await publish({operation:'text_chunk',session_id:r.session_id,processed_event_id:r.processed_event_id,...replyPrivacy(r),chunk},undefined,undefined,false,target,undefined,
          sent?async()=>{await options.runtime.errandTextSent(device,r.session_id,r.processed_event_id,chunk);sent.text=chunk.seq;}:undefined);
        target.signal.throwIfAborted();
      }
      if (options.voice_transport && ['voice','text_and_voice'].includes(r.reply_mode)) for (const chunk of voice_chunks) {
        if(sent&&chunk.seq<=sent.voice)continue;
        check(options.voice_transport === wire.voice_transport && room.localParticipant?.streamBytes,
          'FORMAL_VOICE_TRANSPORT_UNAVAILABLE', 503);
        const source = await authorized();target.signal.throwIfAborted();
        // Cancelling the RTC attempt does not release ownership of storage work already admitted.
        const audio = await track(options.runtime.audio(source,session,r.processed_event_id,chunk.audio.ref,outreach));target.signal.throwIfAborted();
        const envelope = output('voice_chunk',{operation:'voice_chunk',session_id:r.session_id,event_id:r.event_id,processed_event_id:r.processed_event_id,...replyPrivacy(r),chunk});
        const metadata = JSON.stringify(envelope);
        check(Buffer.byteLength(metadata) <= Math.min(options.max_packet_bytes,wire.output_limit), 'FORMAL_TEXT_OUTPUT_PACKET_TOO_LARGE',413);
        check(attached && current(), 'FORMAL_TEXT_CONNECTION_CHANGED',409);
        const opening=room.localParticipant!.streamBytes!({topic:wire.voice_topic,attributes:{out:metadata},
          destinationIdentities:[identity],mimeType:chunk.audio.mime,totalSize:chunk.audio.bytes});
        // rtc-node has no public writer.abort. Close even a late writer, outside the readiness wait.
        let acquired:Awaited<typeof opening>|undefined,closing:Promise<void>|undefined;
        const retire=()=>closing??=acquired!.close();
        void opening.then(writer=>{acquired=writer;if(target.signal.aborted)void retire().catch(options.onError);},()=>{});
        try {const writer = await settleWithSignal(()=>opening,target.signal);
        for (let offset=0;offset<audio.bytes.length;offset+=256000) {
          check(attached && current(), 'FORMAL_TEXT_CONNECTION_CHANGED',409);
          await authorized();
          // An admitted transfer may finish after OUT cancellation; the terminal closes its epoch first.
          await settleWithSignal(()=>writer.write(audio.bytes.subarray(offset,offset+256000)),target.signal);
        }
        } finally { if(acquired){if(target.signal.aborted)void retire().catch(options.onError);else await settleWithSignal(retire,target.signal);} }
        target.signal.throwIfAborted();
        if(sent)sent.voice=chunk.seq;
      }
    }));
    const publishAdmission=async(accepted:{processed_event:Pick<ProcessedEvent,'event_id'|'processed_event_id'>;admission:Awaited<ReturnType<PersonalAIOSRuntime['submit']>>['admission']})=>{
      const {processed_event:d,admission}=accepted;
      await publish({operation:'accepted',event_id:d.event_id,processed_event_id:d.processed_event_id,session_id:session,
        admission:{...(admission.run_order !== undefined ? {run_order:admission.run_order} : {}),state:admission.state,run_id:admission.run_id ?? null,idempotency_key:admission.idempotency_key}});
    };
    const failedCalls=new Set<string>();
    const failCallOpen=async(error:unknown,request:Record<string,unknown>)=>{
      const call_id=request.operation==='call_open'?reference(request.call_id):null;
      if(call_id){
        if(attached&&current()&&!failedCalls.has(call_id)){
          failedCalls.add(call_id);
          await publish({operation:'call_state',session_id:session,call_id,state:'failed',reason:'error',
            error_code:safeCode(error,'VOICE_CALL_OPEN_FAILED')});
        }
        return true;
      }
      return false;
    };
    const reject = async (error:unknown, request:Record<string,unknown>, cameraFrameId?:string) => {
      options.onError(error);
      if(await failCallOpen(error,request))return;
      if(attached&&current()&&isModelSettingsInput(request.operation)&&reference(request.control_id)){
        await publish({operation:'model_settings_receipt',session_id:session,control_id:request.control_id,ok:false,
          error_code:safeCode(error,'MODEL_SETTINGS_REQUEST_FAILED')});return;
      }
      // Every valid payment control gets its typed receipt, including validation failures.
      if(attached&&current()&&isPaymentInput(request.operation)&&reference(request.control_id)){
        const raw=error instanceof ContractError&&error.code==='PAYMENT_PREREQUISITE_MISSING'?(error as ContractError&{missing?:unknown}).missing:undefined;
        const allowed=(wire.$defs.prerequisite as {enum:string[]}).enum;
        const missing=Array.isArray(raw)?[...new Set(raw.filter((code):code is string=>typeof code==='string'&&allowed.includes(code)))]:[];
        await publish({operation:'payment_receipt',session_id:session,control_id:request.control_id,ok:false,
          error_code:safeCode(error,'FORMAL_TEXT_REQUEST_FAILED'),...(missing.length?{missing}:{})});return;
      }
      // Never send raw exception messages or wire-supplied authorization to the terminal.
      if (attached && current()) await publish({operation:'rejected',session_id:session,
        request_operation:reference(request.operation)??'invalid',
        control_id:reference(request.control_id),
        event_id:reference(request.event_id),
        processed_event_id:reference(request.processed_event_id),
        ...(cameraFrameId?{frame_id:cameraFrameId}:{}),
        error_code:safeCode(error,'FORMAL_TEXT_REQUEST_FAILED')});
    };
    const follow=async(source:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>,d:{event_id?:string;processed_event_id:string},conversation=session)=>{
        if (!subscriptions.has(d.processed_event_id)) {
          let delivered=false;
          subscriptions.set(d.processed_event_id,()=>{});
          try {
          const unsubscribe=await options.runtime.subscribeResult(source,conversation,d.processed_event_id,value=>track((async()=>{
            delivered=value.result.voice_status !== 'pending' || value.result.reply_phase === 'interrupted';
            if(delivered) subscriptions.delete(d.processed_event_id);
            await publishResult({...value,result:{...value.result,session_id:session}});
          })()),error=>{
            delivered=true;
            subscriptions.delete(d.processed_event_id);
            track(reject(error,{operation:'submit',event_id:d.event_id,processed_event_id:d.processed_event_id}).catch(options.onError));
          },{voice_settlement:true,on_admission:publishAdmission});
          if (delivered || !current()) unsubscribe();
          else subscriptions.set(d.processed_event_id,unsubscribe);
          } catch(error){subscriptions.delete(d.processed_event_id);throw error;}
        }
    };
    const followPrompt=async(d:ProcessedEvent)=>{
      let settled=false;subscriptions.set(d.processed_event_id,()=>{});
      const stop=await options.runtime.subscribeFixedPrompt(await authorized(),session,d.processed_event_id,value=>track((async()=>{
        settled=value.result.voice_status!=='pending'||value.result.reply_phase==='interrupted';if(settled)subscriptions.delete(d.processed_event_id);
        await publishResult(value);
      })()),options.onError);
      if(settled||!current())stop();else subscriptions.set(d.processed_event_id,stop);
    };
    // Admission ownership survives an uncertain receipt publication.
    const submitAndFollow = async(event_id:string,delivery:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>,
      submit:()=>ReturnType<PersonalAIOSRuntime['submit']>) => {
      let accepted:Awaited<ReturnType<PersonalAIOSRuntime['submit']>>;
      try { accepted=await submit(); }
      catch(error) {
        if(error instanceof ContractError && error.code==='ADMISSION_CAPACITY_EXCEEDED' && error.status===429) {
          await reject(error,{operation:'submit',event_id});return;
        }
        if(error instanceof ContractError&&error.code==='ADMISSION_CAPACITY_EXCEEDED'&&error.status===503){options.onError(error);return;}
        throw error; // An uncertain write or existing logical run is never declared unaccepted.
      }
      await publishAdmission(accepted).catch(options.onError);
      await follow(delivery,accepted.processed_event,accepted.admission.session_id);
    };
    // Every finished call turn is one observation D (reply_hint policy): the main agent decides whether to add anything.
    const calls=new Map<string,CallContext>();
    const retainedCall=(id:string)=>[...retainedCalls].find(context=>context.call_id===id&&context.session===session&&
      context.source.principal_id===device.principal_id&&context.source.device_id===device.device_id&&context.source.device_type===device.device_type);
    const knownCall=(id:string)=>calls.get(id)??retainedCall(id);
    const ownCall=(context:CallContext,work:Promise<unknown>)=>{context.pending.add(work);
      void work.then(()=>context.pending.delete(work),()=>context.pending.delete(work));return work;};
    const callProgress=new Map<AbortController,string>();
    const mirror = async (t: CallTurn, context:CallContext, retry?:Awaited<ReturnType<PersonalAIOSRuntime['retryCallTurn']>>) => {
      const started=Date.now();
      const captured=await context.capture,source=captured.source;
      const authenticated=Date.now(),fix=await captured.locate(),location=fix?{location:fix}:{},located=Date.now();
      const event_id=`voice-turn:${digest([session,t.call_id,t.turn])}`;
      const raw: RawEvent = {schema_version:EVENT_SCHEMA,event_id:t.phase==='handoff'?`${event_id}:handoff`:event_id,captured_at:t.audio?new Date(t.audio.start_ms).toISOString():new Date().toISOString(),
        device_id:source.device_id,device_type:source.device_type,source:{channel:source.channel,
          ...(source.relay_device_id ? {relay_device_id:source.relay_device_id} : {}),...location},media_type:'app_event',
        mime:'application/json',representation:'uploaded_original',payload:Buffer.from(JSON.stringify({kind:'voice_turn',...t,
          ...(t.phase==='complete'?{handoff_event_id:`${event_id}:handoff`}:{})}))};
      // The call owns this delivery lane: a main-agent reply is spoken by the live front and shown as a main_agent line.
      // The call source attributes its own finished turn to the paired device's principal (memory subject / native write).
      const {processed_event:d,admission}=retry??await captured.turn(raw);
      context.refs.add(d.processed_event_id);
      emitRuntimeEvent({voice_call_stage:'turn_recorded',call_id:t.call_id,turn:t.turn,
        processed_event_id:d.processed_event_id,path:t.route??'handoff',handoff:t.handoff??null,phase:t.phase??'complete',
        authenticate_ms:authenticated-started,placed_ms:located-authenticated,submit_ms:Date.now()-located,at:Date.now()});
      if(!admission||!(attached&&current()))return;
      void track((async()=>{
        const progress=new AbortController();let progressStarted=false;
        callProgress.set(progress,t.call_id);
        const stopProgress=()=>{progress.abort();callProgress.delete(progress);};
        let unsubscribe:(()=>void)|undefined,settled=false;
        unsubscribe=await options.runtime.subscribeResult(device,session,d.processed_event_id,async value=>{
          const text=value.chunks.map(chunk=>chunk.text).join('').trim();
          if(settled)return;
          if(value.result.reply_phase==='failed'){settled=true;stopProgress();unsubscribe?.();await options.voice_call?.thinkingStatus?.(t.call_id,'failed',d.processed_event_id);return;}
          // The runtime delivers each result once, finalized; a silent reply (reply_mode none) has no chunks at all.
          settled=true;stopProgress();unsubscribe?.();
          // A final result ends the turn's thinking status whether it is read out or silent.
          await options.voice_call?.thinkingSettled?.(t.call_id,d.processed_event_id);
          if(!text||!value.chunks.some(chunk=>chunk.final))return;
          // The completion owner delivers speech or offline text. This subscription only projects the result.
          if(attached&&current())await publish({operation:'call_transcript',session_id:session,call_id:t.call_id,turn:t.turn,role:'main_agent',
            text:text.slice(0,4000),final:true,...replyPrivacy(value.result)});
        },error=>{stopProgress();options.onError(error);track(options.voice_call?.thinkingStatus?.(t.call_id,'failed',d.processed_event_id)??Promise.resolve());},{on_admission:async({admission})=>{
          if(t.route!=='handoff'||progressStarted||!admission.run_id)return;
          progressStarted=true;
          emitRuntimeEvent({voice_call_stage:'handoff_observed',call_id:t.call_id,turn:t.turn,
            processed_event_id:d.processed_event_id,run_id:admission.run_id,handoff:t.handoff,observer_ms:Date.now()-started,at:Date.now()});
          if(settled)return;
          if(options.voice_call?.conversationMode?.(t.call_id)==='thinking'){await options.voice_call.thinkingStatus?.(t.call_id,'waiting',d.processed_event_id);return;}
          track(options.runtime.watchCallProgress(device,session,d.processed_event_id,text=>{
            if(progress.signal.aborted||!(attached&&current()))return;
            track(options.voice_call!.respond(text,{call_id:t.call_id,identity:runScope(d),turn:t.turn,progress:true,signal:progress.signal}).catch(options.onError));
          },progress.signal).catch(error=>{if(!progress.signal.aborted)options.onError(error);}).finally(stopProgress));
        }}).catch(error=>{stopProgress();throw error;});
        if(settled)unsubscribe();
      })()).catch(options.onError);
    };
    const publishEnrollment=async(enrollment:Awaited<ReturnType<PersonalAIOSRuntime['voiceEnrollmentControl']>>,control_id?:unknown)=>{
      if(attached&&current())await publish({operation:'voice_enrollment_state',session_id:session,...(control_id===undefined?{}:{control_id}),
        enrollment:{...enrollment,owner:ownerWire(enrollment.owner)}});
    };
    const wakeOpenings=new Set<string>();
    const voiceCallId=(id:string)=>id.startsWith('manual-')?id.slice(7):`ambient-${id}`;
    let liveCall=false,liveCallId:string|undefined,callIdentity:CallIdentity='pending';
    let detachCall:(()=>void)|undefined;
    const releaseCallSink=()=>{if(!attached&&!calls.size){detachCall?.();detachCall=undefined;}};
    detachCall=options.voice_call?.attach({
      state:async(call_id,state,extra)=>{
        if(!attached&&!calls.has(call_id))return;
        if(state==='failed'&&failedCalls.has(call_id))return;
        if(state==='failed')failedCalls.add(call_id);
        if(state==='opening'&&attached&&current()&&!calls.has(call_id)){
          const context:CallContext={call_id,owner:expectedGeneration,pending:new Set(),refs:new Set(),turn:-1,source:device,session,capture:track(options.runtime.captureCall(device,session,call_id)),
            identity:extra?.mode==='manual'&&device.device_type==='phone'&&hasTerminalCapability(device,'owner_unlock')?'owner':'pending',enrollment:enrollmentCalls.get(call_id)};
          if(context.enrollment){context.sealDone=Promise.withResolvers<void>();void context.sealDone.promise.catch(()=>{});}
          calls.set(call_id,context);retainedCalls.add(context);
          try{await context.capture;}catch(error){
            if(calls.get(call_id)===context)calls.delete(call_id);retainedCalls.delete(context);
            context.sealDone?.reject(error);releaseCallSink();throw error;}}
        if((state==='connecting'||state==='live')&&attached&&current()&&!calls.has(call_id)&&options.voice_call?.pending?.()===call_id){
          const context=retainedCall(call_id);if(context&&!context.sealing){context.owner=expectedGeneration;calls.set(call_id,context);}}
        if(['closing','closed','failed'].includes(state))for(const [abort,id] of callProgress)if(id===call_id){abort.abort();callProgress.delete(abort);}if(liveCallId!==call_id){liveCallId=call_id;callIdentity=extra?.mode==='manual'&&device.device_type==='phone'&&hasTerminalCapability(device,'owner_unlock')?'owner':'pending';}liveCall=state==='live';options.runtime.terminalChanged(device);if(attached&&current()){
        const {avatar:_avatar,avatar_revision:_avatarRevision,media,...baseExtra}=extra??{};
        const sending=publish({operation:'call_state',session_id:session,call_id,state,...baseExtra,...(state==='failed'?{reason:baseExtra.reason??'error',error_code:safeFailureCode(baseExtra.error_code,'VOICE_CALL_OPEN_FAILED')}:{}),...(_avatar===undefined&&media?{media}:{})});return track(sending.catch(error=>{options.onError(error);throw error;}));}},
      sealed:(call_id,reason,final_turn)=>{const context=calls.get(call_id);if(!context)return;
        context.sealing??=track((async()=>{try{
          const settled=await Promise.allSettled([...context.pending]);
          if(context.enrollment)settled.push(...await Promise.allSettled([options.runtime.voiceEnrollmentControl(context.source,'pause',context.enrollment,call_id).then(publishEnrollment)]));
          await (await context.capture).close({reason,final_turn,
            processed_event_ids:reason==='false_wake'?[]:[...context.refs],closed_at:new Date().toISOString()});
          const failed=settled.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
        }finally{retainedCalls.delete(context);enrollmentCalls.delete(call_id);}})());
        void context.sealing.then(()=>context.sealDone?.resolve(),error=>context.sealDone?.reject(error));
        return context.sealing.finally(()=>{if(calls.get(call_id)===context)calls.delete(call_id);releaseCallSink();});},
      transcript:(call_id,turn,role,text,interrupted,identity)=>{const context=calls.get(call_id);if(context)context.turn=Math.max(context.turn,turn);if(attached&&current()){
        track((async()=>{const privacy=role==='assistant'?await options.runtime.replyPrivacy(device,session):{};
          await publish({operation:'call_transcript',session_id:session,call_id,turn,role,text:text.slice(0,4000),final:true,...privacy,...(interrupted?{interrupted}:{})});})().catch(options.onError));}},
      turn:async(t,audio)=>{const context=calls.get(t.call_id);if(!context||context.owner!==expectedGeneration)return;
        context.turn=Math.max(context.turn,t.turn);
        const requested=t.phase==='complete'?[...context.pending]:[];
        let pause=false;
        try{await ownCall(context,track((async()=>{
          await Promise.all(requested);
          if(t.route==='handoff'&&t.speaker==='owner'&&t.phase!=='complete'&&!context.enrollment){
            await mirror(t.phase==='handoff'?t:{...t,assistant:'',phase:'handoff'},context);
            if(t.phase==='handoff')return;
            t={...t,phase:'complete'};
          }
          const archived=await audio;
          if(context.enrollment&&t.user.trim()){
            if(archived?.status==='rejected')throw archived.reason;
            const sample=archived?.status==='fulfilled'?archived.value:t.audio;
            check(sample,'VOICE_ENROLLMENT_TURN_AUDIO_REQUIRED',422);
            const enrollment=await options.runtime.voiceEnrollmentTurn(context.source,context.enrollment,t.call_id,t.turn,sample);
            pause=enrollment.phase==='paused'||enrollment.phase==='checked';await publishEnrollment(enrollment);
          }
          if(!context.enrollment){
            if(archived?.status==='rejected'){
              t={...t,audio_gap:{reason:archived.reason instanceof Error?archived.reason.message:String(archived.reason)}};
              emitRuntimeEvent({voice_call_stage:'turn_audio_unavailable',call_id:t.call_id,turn:t.turn,...t.audio_gap,at:Date.now()});
            }
            await mirror(archived?.status==='fulfilled'?{...t,audio:archived.value}:t,context);
          }})()));
        }finally{if(pause)void track(Promise.resolve().then(()=>options.voice_call!.close(t.call_id,'button'))).catch(options.onError);}},
      playbackReset:(call_id,track_sid,target)=>{if(attached&&current())track(publish({operation:'call_playback_reset',session_id:session,call_id,...(target?{target}:{track_sid})}).catch(options.onError));},
    });
    // The main agent only takes requests and dispatches them; a finished errand comes back as one observation D
    // (kind errand_result, event id = job id) that it reports. The reply shows like any result, and while a call is
    // live 依米 also says it. Any attached connection carries it (the runtime offers it in terminal rank order).
    // Returns false when this connection is gone so the spool keeps the result; throws RUN_NOT_ACCEPTED when it is rejected for good.
    const errand = async (result: ErrandResult): Promise<boolean> => {
      if (!attached || !current()) return false;
      const source = await authorized();
      // Byte-stable per job: a retry after a partial failure is the same event (the archive replays it, no conflict).
      const raw: RawEvent = {schema_version:EVENT_SCHEMA,event_id:`errand:${result.job_id}`,captured_at:result.finished_at,
        device_id:source.device_id,device_type:source.device_type,source:{channel:source.channel,
          ...(source.relay_device_id ? {relay_device_id:source.relay_device_id} : {})},media_type:'app_event',
        mime:'application/json',representation:'uploaded_original',payload:Buffer.from(JSON.stringify({kind:'errand_result',...result}))};
      const accepted = await options.runtime.submitErrand(raw,source,session);
      let unsubscribe:(()=>void)|undefined,settled=false,handed=true,rejected:unknown;const delivery={first:true};
      unsubscribe=await options.runtime.subscribeResult(source,accepted.admission.session_id,accepted.processed_event.processed_event_id,async value=>{
        if(settled||!['sealed','failed','interrupted'].includes(value.result.reply_phase))return;
        const reached=await options.runtime.errandReply(source.principal_id,value,options.onError,delivery);
        if(!reached){handed=false;settled=true;unsubscribe?.();return;}
        delivery.first=false;
        if(reached===true)sentErrands.delete(value.result.processed_event_id);
        settled=value.result.voice_status!=='pending'||value.result.reply_phase==='interrupted';if(settled)unsubscribe?.();
      },error=>{handed=false;rejected=error;},{outreach:'errand',voice_settlement:true});
      // Concrete subscription failures reach the spool; a missing terminal remains replayable.
      if(rejected)throw rejected;
      if(settled)unsubscribe();return handed;
    };
    // Ambient D owns admission and identity. A voice-owned result goes to that call and scope; other results stay text.
    const replied=new Set<string>();
    const ambientReply=async(d:ProcessedEvent)=>{
      if(replied.has(d.processed_event_id))return;
      replied.add(d.processed_event_id);if(replied.size>64)replied.delete(replied.values().next().value!);
      const wake=(d.content.wake_request??d.content.app_event) as {text?:unknown;voice_session_id?:string;voice_turn?:number}|undefined,heard=typeof wake?.text==='string'?wake.text:'';
      const source=await authorized();
      const context=wake?.voice_session_id?knownCall(voiceCallId(wake.voice_session_id)):undefined;
      context?.refs.add(d.processed_event_id);
      if(wake?.voice_session_id)check(Number.isSafeInteger(wake.voice_turn),'AMBIENT_VOICE_TURN_REQUIRED',500);
      if(wake?.voice_session_id&&heard&&attached&&current())await publish({operation:'call_transcript',session_id:session,
        call_id:voiceCallId(wake.voice_session_id),turn:wake.voice_turn,role:'user',text:clip(heard,4000),final:true});
      let unsubscribe:(()=>void)|undefined,settled=false;
      unsubscribe=await options.runtime.subscribeResult(source,session,d.processed_event_id,async value=>{
        const text=value.chunks.map(chunk=>chunk.text).join('').trim();
        if(settled)return;
        if(value.result.reply_phase==='failed'){settled=true;unsubscribe?.();if(wake?.voice_session_id)await options.voice_call?.thinkingStatus?.(voiceCallId(wake.voice_session_id),'failed',d.processed_event_id);return;}
        settled=true;unsubscribe?.();
        if(wake?.voice_session_id)await options.voice_call?.thinkingSettled?.(voiceCallId(wake.voice_session_id),d.processed_event_id);
        if(!text||!value.chunks.some(chunk=>chunk.final))return;
        if(wake?.voice_session_id){
          const call_id=voiceCallId(wake.voice_session_id);
          if(attached&&current())await publish({operation:'call_transcript',session_id:session,call_id,turn:wake.voice_turn,role:'main_agent',text:clip(text,4000),final:true,...replyPrivacy(value.result)});
          return;
        }
        if(attached&&current())await publish({operation:'ambient_reply',session_id:session,processed_event_id:d.processed_event_id,heard:clip(heard,500),text:clip(text,2000),...replyPrivacy(value.result)});
        else await options.notify?.(replyNotice(value.result,text)).catch(options.onError);
      },options.onError);
      if(settled)unsubscribe();
    };
    // iOS alone owns local alarm sync. Every display terminal can receive the owner's live outreach.
    let modelSettingsUnwatch:(()=>void)|undefined,modelSettingsWatchGeneration=0;
    const watchers:Promise<()=>void>[]=[];let shown='',careReady:Promise<()=>void>|undefined,turnsReady:Promise<()=>void>|undefined,ambientReady:Promise<()=>void>|undefined;
    const activityEnabled=hasTerminalCapability(device,'chat_ui')||hasTerminalCapability(device,'display');
    const deliverActivity=async(body:ActivityUpdate)=>{if(attached&&current())await extensions.publish({...body},device,publish);};
    if(activityEnabled)watchers.push(options.runtime.watchActivity(device,deliverActivity,options.onError,present));
    if(device.device_type==='phone'||device.device_type==='glasses')watchers.push(options.runtime.watchPayments(device,async projection=>{
      if(attached&&current())await track(publish({...projection,operation:projection.operation as string,session_id:session}));
    },session));
    if(device.device_type==='phone'){
      watchers.push(options.runtime.watchReminders(device,async reminders=>{
        if(!(attached&&current()))return;
        const source=await authorized();
        check(source.principal_id===device.principal_id&&source.device_id===device.device_id,'REMINDER_RECIPIENT_CHANGED',403);
        const sync_id=crypto.randomUUID(),pages=reminders.length?reminders.map(r=>[r]):[[]];
        for(const [part,page] of pages.entries()) {
          if(!(attached&&current()))return;
          await track(publish({operation:'reminders_sync',session_id:session,sync_id,part,final:part===pages.length-1,reminders:page}));
        }
      },options.onError));
    }
    if(hasTerminalCapability(device,'display')){
      // Care takes the live voice first; chat carries a fall's response control or outreach without voice.
      watchers.push(careReady=options.runtime.watchCare(device,async(id,text,reminder_id,privacy)=>{
        if(!(attached&&current()))return false;
        await track(publish(id.endsWith(':checkin')?{operation:'care_checkin',session_id:session,care_id:id,text:clip(text,2000)}:
          {operation:'ambient_reply',session_id:session,processed_event_id:id,heard:'',text:clip(text,2000),...privacy,...(reminder_id?{reminder_id}:{})}));return 'pending';},
        async(text,origin,messageId)=>{if(!(attached&&current()))return false;await authorized();
          if(origin){if(origin.device_id!==device.device_id)return false;
            const call_id=origin.call_id??(origin.voice_session_id?voiceCallId(origin.voice_session_id):undefined);
            const thinking=!!call_id&&!!origin.message_id&&options.voice_call?.conversationMode?.(call_id)==='thinking';
            if(thinking)await publishResult(await options.runtime.result(await authorized(),session,origin.message_id!,{text_replay:'sealed'}));
            const speech=call_id&&origin.identity?options.voice_call?.respond(!thinking&&origin.identity==='owner_uncertain'?JSON.stringify({text,voice_confirmation:origin.voice_confirmation??null}):text,
              {call_id,identity:origin.identity,...(origin.message_id?{message_id:origin.message_id}:{}),...(origin.turn===undefined?{}:{turn:origin.turn})})??Promise.resolve(false):Promise.resolve(false);
            const spoken=await(thinking?speech.catch(async error=>{options.onError(error);await options.voice_call?.thinkingStatus?.(call_id!,'failed',origin.message_id);return false;}):speech);
            return thinking&&!spoken?'text':spoken;}
          return await options.voice_call?.respond(text,messageId&&liveCallId?{call_id:liveCallId,identity:'owner',message_id:messageId}:undefined,true)??false;},
        async text=>{if(!(attached&&current()))return false;await authorized();return await options.voice_call?.context?.(text)??false;},()=>attached&&current()&&liveCall&&callIdentity==='owner',
        options.errands?{deliver:errand,ready:present,progress:async running=>{
          if(!(attached&&current()))return false;
          await extensions.publish({operation:'errand_progress',session_id:session,errands:running},device,publish);return true;
        },reply:async(value,recordOnly,delivery)=>{
          if(!(attached&&current()))return false;
          const previous=sentErrands.get(value.result.processed_event_id);
          if(recordOnly){
            const sent:NonNullable<ReturnType<typeof sentErrands.get>>=previous?.epoch===value.result.reply_epoch?previous:{epoch:value.result.reply_epoch,text:0,voice:0,record:false};
            sentErrands.set(value.result.processed_event_id,sent);
            if(!sent.record){
              sent.recordFlight??=publish({operation:'ambient_reply',session_id:session,processed_event_id:value.result.processed_event_id,heard:'',text:clip(value.result.reply_text,2000),...replyPrivacy(value.result)})
                .then(()=>{sent.record=true;}).finally(()=>{delete sent.recordFlight;});
              await sent.recordFlight;
            }
            return 'pending';
          }
          await authorized();
          if(delivery.first&&!(previous?.epoch===value.result.reply_epoch&&previous.header)){
            if(value.result.reply_mode==='voice'&&!realtimeBusy())await publish({operation:'ambient_reply',session_id:session,processed_event_id:value.result.processed_event_id,heard:'',text:clip(value.result.reply_text,2000),...replyPrivacy(value.result)});
            await publishAdmission({processed_event:value.result,admission:value.admission});
          }
          value={...value,result:{...value.result,session_id:session}};
          // Errands use receipted OUT audio even during a call; front completion is not an OUT playback ACK.
          await publishResult(value,'errand');
          return 'pending';
        }}:undefined,leave,
        {session,reply:async value=>{if(!(attached&&current()))return;await authorized();
          await publish({operation:'ambient_reply',session_id:session,processed_event_id:value.result.processed_event_id,heard:'',text:clip(value.result.reply_text,2000)});
          await publishResult({...value,result:{...value.result,session_id:session}});},...(hasTerminalCapability(device,'location')?{locate:requestLocation}:{}),
          move:async(body,current)=>{
            const cancel=new AbortController(),timer=setTimeout(()=>cancel.abort(new ContractError(device.device_type==='phone'?'PHONE_NOT_CONNECTED':'GLASSES_NOT_CONNECTED',409)),REALTIME_READINESS_DEADLINE_MS);
            try {await track(publish({...body,operation:body.operation as string,session_id:session},undefined,current,true,undefined,cancel.signal));}
            finally {clearTimeout(timer);}
          },
          inCall:()=>liveCall||!!options.voice_call?.pending?.(),
          ...(options.voice_call?{hangup:async()=>{
            const call_id=options.voice_call!.pending?.()??(liveCall?liveCallId:undefined);
            if(call_id)await options.runtime.formalVoice(await authorized(),'audio',()=>options.voice_call!.close(call_id,'button'));
          }}:{}),
          ...(options.voice_transport?{prompt:followPrompt}:{}),
          event:async accepted=>{await publishAdmission(accepted);await follow(await authorized(),accepted.processed_event,accepted.admission.session_id);},
          deliver:async (card:TerminalQuestion|TerminalCallOffer|TerminalPersonHint)=>{
          await track(publish('person_ref' in card?{operation:'display_card',session_id:session,card_id:`person:${card.person_ref}`,title:'认人',
            lines:[card.name],priority:'normal',lifetime_ms:10000}:{operation:'card_id' in card?'gesture_card':'call_offer',session_id:session,...card}));},
          ...((hasFirstPersonCamera(device)||device.device_type==='phone'&&hasTerminalCapability(device,'camera'))?{captureOnce:async(frame_id:string,camera?:'back'|'front',expires_at_ms?:number)=>{await track(publish({operation:'camera_capture_once',session_id:session,frame_id,...(camera?{camera,expires_at_ms}:{})}));}}:{}),
          ...(hasFirstPersonCamera(device)?{capture:async (policy:import('../../../services/personal-aios-integration/src/visual/store.ts').CameraCapturePolicy)=>{await track(publish({operation:'camera_policy',session_id:session,control_id:'camera-policy-sync',policy}));}}:{})}));
      if(hasTerminalCapability(device,'owner_unlock'))watchers.push(options.runtime.watchVoiceConfirmations(device,async pending=>{
        const confirmations=pending.slice(-16).map(({confirmation_id,event_id,expires_in_ms,text,kind,purpose,source_device_id,source_device_type,scope_confirmation})=>({confirmation_id,event_id,expires_in_ms,
          ...(kind?{kind}:{}),...(purpose?{purpose}:{}),...(source_device_id?{source_device_id}:{}),...(source_device_type?{source_device_type}:{}),...(scope_confirmation?{scope_confirmation}:{}),...(text?{text}:{})}));
        const ids=JSON.stringify(confirmations);
        if(ids===shown||!(attached&&current()))return;
        shown=ids;await track(extensions.publish({operation:'voice_confirmations',session_id:session,confirmations},device,publish));
      },options.onError,false,present));
      watchers.push(turnsReady=options.runtime.watchAmbientTurns(device,session,d=>{track(ambientReply(d).catch(options.onError));}));
      if(hasTerminalCapability(device,'microphone')&&options.voice_call?.identify&&options.runtime.watchAmbientVoice)watchers.push(ambientReady=options.runtime.watchAmbientVoice(device,session,async wake=>{
        if(!(attached&&current()))return false;
        if(wake.intent!=='dial'&&!hasTerminalCapability(device,'continuous_audio'))return false;
        // Paired transport permits a neutral voice session. Local audio identity controls its privileges later.
        return options.voice_call!.open(voiceCallId(wake.id),{intent:wake.intent??'automatic',mode:'ambient',wake_word:!wake.say&&(wake.intent!=='dial'||wakeOpenings.has(voiceCallId(wake.id))),source:device,continuity:session,heard_start_ms:wake.start_ms,...(wake.conversation_mode?{conversation_mode:wake.conversation_mode}:{}),...(wake.say?{say:wake.say,...(wake.say_message_id?{say_message_id:wake.say_message_id}:{}),
          ...(device.device_type==='phone'&&hasTerminalCapability(device,'owner_unlock')?{context:async()=>options.runtime.callContext(device,session,await options.runtime.locate(device))}:{})}:{})})
          .then(words=>words??true,error=>{if(wake.intent==='dial')throw error;options.onError(error);
            if(error instanceof ContractError&&error.code==='VOICE_CALL_BUSY')return !wake.say;
            if(wake.say)throw error;return true;});
      },{active:id=>attached&&current()&&options.voice_call!.pending?.()===voiceCallId(id),
        request:async(id,d,identity)=>{
          if(!(attached&&current()))return false;
          await authorized();
          const text=(d.content.wake_request as {text:string}).text;
          const range=d.time_range,audio=range.kind==='interval'&&range.timebase_id==='utc_epoch_ms'?
            {raw_ref:d.raw_ref,archive_revision:d.archive_revision,start_ms:range.start_ms,end_ms:range.end_ms}:undefined;
          return await options.voice_call!.request?.(text,{call_id:voiceCallId(id),identity,...(audio?{audio}:{})})??false;
        },
        identified:async(id,d,identity,authority)=>{
          if(!(attached&&current()))return false;
          const identified=await options.voice_call!.identify?.(voiceCallId(id),identity,async()=>{
            const source=await authorized(),fix=await options.runtime.locate(source);
            const context=await options.runtime.callContext(source,session,fix,undefined,undefined,runScope(d)).catch(error=>{options.onError(error);return '';});
            const framing=(d.content.wake_request??d.content.app_event) as {context?:{entries:{speaker:string;text:string}[]};ambient_context?:{entries:{speaker:string;text:string}[]}}|undefined;
            const ambient=(framing?.context??framing?.ambient_context)?.entries.map(e=>`${e.speaker}: ${e.text}`).join('\n')??'';
            return [context,ambient&&`唤醒前听到的对话：\n${ambient}`].filter(Boolean).join('\n');
          },authority)??false;
          if(identified){callIdentity=identity;const context=calls.get(voiceCallId(id));if(context)context.identity=identity;options.runtime.terminalChanged(device);}return identified;
        }}));
    }
    for(const watcher of watchers)watcher.catch(options.onError);
    const unwatch=()=>{modelSettingsWatchGeneration++;modelSettingsUnwatch?.();modelSettingsUnwatch=undefined;for(const abort of callProgress.keys())abort.abort();callProgress.clear();for(const watcher of watchers)track(watcher.then(stop=>stop(),()=>{}));};
    // "她了解你" → 录入我的声音: each sentence is a button window on the one PCM reader (archived only, never a request and
    // never a second upload path), measured centrally; the registry judges the set on commit.
    const voiceprint=async(body:Record<string,unknown>,source:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>)=>{
      const op=String(body.operation);
      check(hasTerminalCapability(source,'owner_unlock')||(op!=='voiceprint_forget'&&(source.device_type==='mac'||await options.runtime.paymentEnrolmentAllowed(source))),
        'VOICEPRINT_DEVICE_REQUIRED',403);
      if(op==='voiceprint_open'||op==='voiceprint_commit'||op==='voiceprint_cancel'){
        const operation=body.operation_id as string;
        const sample=(status:string,extra:Record<string,unknown>={})=>publish({operation:'voiceprint_sample',session_id:session,operation_id:operation,status,...extra});
        try {
          check(options.voice_capture,'FORMAL_VOICE_CAPTURE_NOT_CONFIGURED',503);
          if(op==='voiceprint_cancel'){options.voice_capture!.cancel(operation);await sample('cancelled');return;}
          if(op==='voiceprint_open'){
            await options.runtime.formalVoice(source,'audio',async()=>{await options.voice_capture!.open(operation,'voiceprint');});
            await sample('recording');return;
          }
          const window=await options.runtime.formalVoice(source,'audio',()=>options.voice_capture!.commit(operation,'voiceprint'));
          const measured=await options.runtime.voiceprintSample(source,{raw_ref:window.request.raw_ref,archive_revision:window.request.archive_revision});
          await sample('measured',{...(measured.sample_id?{sample_id:measured.sample_id}:{}),speech_ms:measured.speech_ms,quality:measured.quality,...(measured.samples?{samples:measured.samples}:{})});
        } catch(error) {options.onError(error);await sample('failed',{error_code:safeCode(error,'VOICEPRINT_SAMPLE_FAILED')});}
        return;
      }
      const {enrolled,owner}=await options.runtime.formalVoice(source,'data',async()=>{
        const enrolled=op==='voiceprint_enroll'?await options.runtime.voiceprintEnroll(source,body.sample_ids as string[]):undefined;
        return {enrolled,owner:enrolled?enrolled.owner:op==='voiceprint_forget'?await options.runtime.voiceprintForget(source):await options.runtime.voiceprintOwner(source)};
      });
      await publish({operation:'voiceprint_owner',session_id:session,control_id:body.control_id,owner:ownerWire(owner),
        ...(hasTerminalCapability(source,'owner_unlock')?await options.runtime.voiceTrustDevices(source):{}),
        ...(enrolled?{enrollment:{status:enrolled.status,...(enrolled.samples?{samples:enrolled.samples}:{})}}:{})});
    };
    const openCall=async(source:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>,call_id:string,location?:unknown,silence_timeout_ms?:number,video?:true,video_revision=0,wake_word=false,enrollment_session_id?:string,conversation_mode?:'chat'|'thinking')=>{
      const enrollment_instructions=enrollment_session_id?await options.runtime.voiceEnrollmentCall(source,enrollment_session_id,call_id):undefined;
      if(enrollment_session_id)enrollmentCalls.set(call_id,enrollment_session_id);
      try{check(options.voice_call,'VOICE_CALL_NOT_CONFIGURED',503);await options.runtime.formalVoice(source,'audio',async()=>{
        if(!enrollment_session_id&&(source.device_type!=='phone'||!hasTerminalCapability(source,'owner_unlock'))){
          await ambientReady;check(options.voice_call!.identify,'AMBIENT_VOICE_IDENTITY_REQUIRED',503);
          const at=Date.now();if(wake_word)wakeOpenings.add(call_id);
          try{const opened=await options.runtime.openAmbientVoice(source,session,{id:`manual-${call_id}`,
            intent:wake_word?'automatic':'dial',...(conversation_mode?{conversation_mode}:{}),text:'',heard_at:new Date(at).toISOString(),start_ms:at,end_ms:at});
            if(!wake_word)check(opened,'AMBIENT_VOICE_OPEN_FAILED',409);}finally{wakeOpenings.delete(call_id);}return;
        }
        if(!enrollment_session_id)await options.runtime.ownerInput(source);callIdentity='owner';
        check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);
        await options.voice_call!.open(call_id,{...(enrollment_instructions?{enrollment_instructions}:{}),context:async(signal:AbortSignal)=>{
          if(enrollment_session_id)return undefined;
          const fix=(await placed(source,location)).location;
          const context=await options.runtime.callContext(source,session,fix,undefined,signal,'owner').catch(error=>{options.onError(error);return undefined;});
          check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);return context;
        },intent:wake_word?'automatic':'dial',video_revision,wake_word,source,continuity:session,...(conversation_mode?{conversation_mode}:{}),...(silence_timeout_ms!==undefined?{silence_timeout_ms}:{}),...(video?{video}:{})});
      });}catch(error){
        if(wake_word&&error instanceof ContractError&&error.code==='VOICE_CALL_BUSY'){options.onError(error);return;}
        if(enrollment_session_id){enrollmentCalls.delete(call_id);
          await publishEnrollment(await options.runtime.voiceEnrollmentControl(source,'pause',enrollment_session_id,call_id));}
        throw error;
      }
    };
    const rejectPcm=async(error:unknown,request:Record<string,unknown>,id?:string)=>{
      const close=id&&attached&&current()&&knownCall(id)&&options.voice_call?.pending?.()===id?
        Promise.resolve().then(()=>options.voice_call!.close(id,'error',safeCode(error,'WAKE_PCM_FAILED'))):undefined;
      const settled=await Promise.allSettled([close,reject(error,request)]);
      const failed=settled.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    };
    const handle = async (payload: Uint8Array) => {
      let request: Record<string,unknown> = {},pcmCurrent:string|undefined;
      try {
      check(payload.byteLength <= wire.input_limit, 'FORMAL_TEXT_PACKET_TOO_LARGE', 413);
      const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload));
      check(value && typeof value === 'object' && !Array.isArray(value), 'FORMAL_TEXT_PACKET_INVALID');
      const body = value as Record<string,unknown>; request=body; trace({formal_text_in:opName(body.operation)});
      check(attached && current(), 'FORMAL_TEXT_CONNECTION_CHANGED', 409);
      if(extensions.has(body.operation)){await extensions.handle(body as WireBody,await authorized(),body=>publish({session_id:session,...body}));return;}
      const input=wire.inputs[String(body.operation)];
      check(Object.hasOwn(wire.inputs,String(body.operation)) && input,'FORMAL_TEXT_RESULT_INVALID');
      check(inputValidators[String(body.operation)]!(body), input.error);
      if(body.operation==='call_set_conversation_mode'){
        check(options.voice_call?.setConversationMode,'VOICE_CALL_NOT_CONFIGURED',503);
        const id=body.call_id as string,mode=body.conversation_mode as 'chat'|'thinking';
        await options.voice_call.setConversationMode(id,mode,{id:body.control_id as string,
          authorize:async()=>{const owner=await options.runtime.ownerControl(await authorized());await options.runtime.formalVoice(owner,'audio',()=>options.runtime.ownerInput(owner));},
          confirmed:async()=>{await options.runtime.rememberCallConversationMode(await authorized(),mode);}});
        await publish({operation:'control_receipt',session_id:session,call_id:id,control_id:body.control_id,
          requested_operation:'call_set_conversation_mode',receipt:{conversation_mode:mode}});return;
      }
      // Record ordered intent before any asynchronous authorization, so a delayed ON cannot overtake OFF.
      if(device.device_type==='phone'&&hasTerminalCapability(device,'owner_unlock')){
        if(body.operation==='call_open'||body.operation==='call_video')options.voice_call?.videoCommand?.(body.call_id as string,
          {video:body.video===true,revision:(body.video_revision as number|undefined)??0,...(body.operation==='call_open'?{opening:true}:{})});
        else if(body.operation==='call_close')options.voice_call?.videoCommand?.(body.call_id as string,null);
      }
      const paymentBinding=isPaymentInput(body.operation)&&device.device_type==='glasses'?options.runtime.paymentInputBinding(device):undefined;
      await Promise.all([careReady,turnsReady]);
      check(attached&&current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);
      if(body.operation==='wear_state'){
        const closing=body.worn===false?options.voice_call?.pending?.():undefined;
        const state=await options.runtime.wearState(device,body.worn as boolean,body.lock_cycle as number|undefined);
        if(closing)await options.voice_call!.close(closing,'button');
        await publish({operation:'wear_state_ack',session_id:session,control_id:body.control_id,...state});return;
      }
      const source=await authorized();
      if(isModelSettingsInput(body.operation)){
        const receipt=await dispatchModelSettings(options.runtime,source,body);
        if(body.operation==='model_settings_watch'){
          const watchGeneration=++modelSettingsWatchGeneration;modelSettingsUnwatch?.();modelSettingsUnwatch=undefined;
          const stop=await options.runtime.modelSettingsWatch(source,state=>publish({operation:'model_settings_state',session_id:session,state}));
          if(attached&&current()&&watchGeneration===modelSettingsWatchGeneration)modelSettingsUnwatch=stop;else stop();
        }
        await publish({...receipt,operation:receipt.operation as string,session_id:session});return;
      }
      if(isPaymentInput(body.operation)){
        const projection=await dispatchPayment(options.runtime,source,body,session,paymentBinding);
        if(projection)await publish({...projection,operation:projection.operation as string,session_id:session});return;
      }
      if(body.operation==='pay_closed'){
        check(source.device_type==='glasses','GLASSES_DEVICE_REQUIRED',403);
        const raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:`pay-closed:${digest([source.device_id,body.at])}`,captured_at:body.at as string,
          device_id:source.device_id,device_type:'glasses',source:{channel:source.channel},media_type:'app_event',mime:'application/json',
          representation:'uploaded_original',payload:Buffer.from(JSON.stringify({kind:'pay_closed',at:body.at,outcome:body.outcome}))};
        await submitAndFollow(raw.event_id,source,()=>options.runtime.submit(raw,source,session,false));return;
      }
      if(movementInputs.has(String(body.operation))){
        if(body.operation==='move_frame')check((body.ride===undefined)===(body.ride_id===undefined)&&
          (body.nav===undefined||(body.nav as {nav_id:string}).nav_id===body.nav_id),'FORMAL_MOVE_FRAME_INPUT_INVALID');
        await options.runtime.move(source,body as unknown as MoveInput,body.lifecycle_id?async()=>{
          await publish({operation:'move_ack',session_id:session,lifecycle_id:body.lifecycle_id});
        }:undefined);
        return;
      }
      if(body.operation==='camera_capture_failed'){
        await options.runtime.cameraCaptureFailed(source,body.frame_id as string,new ContractError(body.error_code as string,409));return;
      }
      if(body.operation==='camera_private_pause'){
        const policy=await options.runtime.setCameraPrivatePause(source,body.private_paused as boolean);
        await publish({operation:'camera_policy',session_id:session,control_id:body.control_id,policy});return;
      }
      if(body.operation==='camera_status'){
        await options.runtime.cameraStatus(source,body.status as 'available'|'paused'|'unavailable'|'error',body.error as string|null);return;
      }
      if(body.operation==='call_offer_answer'){
        const offer=await options.runtime.answerCallOffer(source,body.offer_id as string,body.answer as 'accept'|'decline');
        if(offer)await openCall(source,offer.call_id);return;
      }
      if(body.operation==='card_answer'){
        const meta={event_id:`answer:${digest([source.device_id,body.card_id])}`,captured_at:new Date().toISOString()};
        await submitAndFollow(meta.event_id,source,()=>options.runtime.submitGlassesGesture(meta,source,
          {card_id:body.card_id as string,kind:body.kind as 'nod'|'shake'|'tap',answer:body.answer as 'yes'|'no'}));return;
      }
      if(body.operation==='health_batch'){
        check(hasTerminalCapability(source,'health'),'HEALTH_DEVICE_REQUIRED',403);
        const {operation,...batch}=body;
        const receipt=await options.runtime.ingestHealth(source,batch as unknown as HealthBatch,session);
        await publish({operation:'health_ack',session_id:session,control_id:body.control_id,...receipt});
        return;
      }
      if(body.operation==='contacts_batch'){
        check(hasTerminalCapability(source,'contacts'),'CONTACTS_DEVICE_REQUIRED',403);
        const {operation,...batch}=body;
        const receipt=await options.runtime.ingestContacts(source,batch as unknown as ContactsBatch);
        await publish({operation:'contacts_ack',session_id:session,control_id:body.control_id,...receipt});
        return;
      }
      if(body.operation==='care_safe'){
        check(hasTerminalCapability(source,'display'),'CARE_DEVICE_REQUIRED',403);
        const outcome=await options.runtime.careSafe(source);
        await publish({operation:'care_safe_ack',session_id:session,control_id:body.control_id,...outcome});return;
      }
      if(body.operation==='voice_trust_window_open'){
        const record=await options.runtime.openVoiceTrustWindow(source,session,body.source_device_id as string,body.control_id as string);
        await publish({operation:'voice_trust_window_opened',session_id:session,control_id:body.control_id,confirmation_id:record.confirmation_id});return;
      }
      if(body.operation==='voice_confirm'){
        const accepted=await options.runtime.formalVoice(source,'data',()=>options.runtime.confirmVoice(source,{confirmation_id:body.confirmation_id as string,
          ...(body.choice?{choice:body.choice as 'approve'|'deny'}:{}),...(body.auth!==undefined?{auth:body.auth as string}:{})},options.voice_call?.trustCall));
        // The runtime's approval also carries owner provenance for native records; the wire message is exactly its schema.
        if('approval' in accepted){await publish({operation:'voice_confirmation_decided',session_id:session,
          confirmation_id:accepted.approval.confirmation_id,choice:accepted.approval.choice});return;}
        await publish({operation:'voice_confirmation_decided',session_id:session,confirmation_id:body.confirmation_id,choice:'approve'});
        // The confirmation D runs in the uncertain request's session; this connection follows it there when that is its own.
        if(accepted.admission.session_id===session&&accepted.processed_event.device_id===source.device_id){await publishAdmission(accepted);await follow(source,accepted.processed_event);}
        return;
      }
      if(body.operation==='voice_enrollment_control'){
        const action=body.action as Parameters<PersonalAIOSRuntime['voiceEnrollmentControl']>[1];
        const control=()=>options.runtime.formalVoice(source,'data',()=>options.runtime.voiceEnrollmentControl(source,action,
          body.enrollment_session_id as string|undefined,body.call_id as string|undefined));
        let enrollment:Awaited<ReturnType<PersonalAIOSRuntime['voiceEnrollmentControl']>>|undefined;
        try{
          if(['start','resume','pause','stop','check','preview','commit','discard'].includes(action)&&
            (action!=='discard'||body.enrollment_session_id)){
            const active=await options.runtime.voiceEnrollmentControl(source,'status',body.enrollment_session_id as string|undefined);
            if(action!=='start'){
              check(!body.enrollment_session_id||active.session_id===body.enrollment_session_id,'VOICE_ENROLLMENT_SESSION_NOT_FOUND',404);
              if(action==='resume')check(active.phase==='paused','VOICE_ENROLLMENT_PHASE_INVALID',409);
              else check(!body.call_id||active.call_id===body.call_id,'VOICE_ENROLLMENT_CALL_REQUIRED',409);
            }
            const context=active.call_id?knownCall(active.call_id):undefined;
            if(context?.enrollment===active.session_id){
              await options.voice_call?.close(context.call_id,'button');await context.sealDone?.promise;
            }
          }
        }finally{if(action==='discard')enrollment=await control();}
        enrollment??=await control();
        await publishEnrollment(enrollment,body.control_id);return;
      }
      if(String(body.operation).startsWith('voiceprint_')){await voiceprint(body,source);return;}
      if(String(body.operation).startsWith('voice_')) {
        const operation=body.operation_id as string;
        const status=async(source_status:string,candidates?:unknown[],failure_code?:string,event_id?:string)=>{
          const body={schema_version:wire.schema,operation:'voice_status',session_id:session,operation_id:operation,
            source_status,...(candidates ? {candidates} : {}),...(failure_code ? {error_code:failure_code} : {}),...(event_id ? {event_id} : {})};
          const error_code=candidates && candidates.length>128?'VOICE_CANDIDATE_COUNT_TOO_LARGE':
            Buffer.byteLength(JSON.stringify(body))>Math.min(options.max_packet_bytes,wire.output_limit)?'VOICE_CANDIDATE_PACKET_TOO_LARGE':failure_code;
          await publish(error_code?{operation:'voice_status',session_id:session,operation_id:operation,source_status:'unknown',error_code}:body);
        };
        // A voice request answers on its own operation, which every installed app correlates; `rejected` has no operation_id.
        try {
        if(body.operation==='voice_open') {
          check(options.voice_capture,'FORMAL_VOICE_CAPTURE_NOT_CONFIGURED',503);
          await options.runtime.formalVoice(source,'audio',async()=>{await options.voice_capture!.open(operation);});
          await status('recording');return;
        }
        if(body.operation==='voice_process'||body.operation==='voice_commit') {
          check(body.operation==='voice_process'||options.voice_capture,'FORMAL_VOICE_CAPTURE_NOT_CONFIGURED',503);
          const failed=async(error:unknown)=>{
            options.onError(error);
            await status('unknown',undefined,safeCode(error,'VOICE_PROCESS_FAILED'));
          };
          let window:Awaited<ReturnType<NonNullable<typeof options.voice_capture>['commit']>>|undefined;
          if(body.operation==='voice_commit'){
            try{window=await options.runtime.formalVoice(source,'audio',()=>options.voice_capture!.commit(operation));}
            catch(error){await failed(error);return;}
          }
          const request=window?.request??body.request as Parameters<PersonalAIOSRuntime['processVoice']>[3];
          const processing=track(options.runtime.formalVoice(source,'audio',async()=>options.runtime.processVoice(source,session,operation,request))
            .then(async result=>{for(const accepted of result.events){await publishAdmission(accepted);await follow(source,accepted.processed_event);}})
            .catch(failed).catch(options.onError));
          try {await status('pending',undefined,undefined,window?.event_id);}
          finally {await processing;}return;
        }
        await options.runtime.formalVoice(source,'data',async()=>{
          if(body.operation==='voice_candidates')await status('candidates',await options.runtime.formalVoiceCandidates(source,session,operation));
          else if(body.operation==='voice_send') {
            const result=await options.runtime.confirmFormalVoice(source,session,operation,{
              candidate_ref:body.candidate_ref as string,candidate_revision:body.candidate_revision as string,
              window_ref:body.window_ref as string,selected_input_sha256:body.selected_input_sha256 as string,
              transcript_sha256:body.transcript_sha256 as string});
            await status(result.status==='finalized'?'confirmation_recorded':'unknown');
            if('events' in result)for(const accepted of result.events){await publishAdmission(accepted);await follow(source,accepted.processed_event);}
          } else if(body.operation==='voice_close'){
            const capture=options.voice_capture?.cancel(operation)??false;
            const result=await options.runtime.cancelMedia(source,operation);
            await status(capture&&result.processing_status==='unknown'?'cancel_requested':result.processing_status);
          }
          else check(false,'FORMAL_VOICE_OPERATION_INVALID');
        });
        } catch(error){options.onError(error);await status('unknown',undefined,safeCode(error,'FORMAL_TEXT_REQUEST_FAILED'));}
        return;
      }
      // 随身模式: the phone's fixes while it listens in a pocket (a wake turn heard on it is located by the newest).
      if(body.operation==='location_update'){
        await options.runtime.locate(source,body.location as CaptureLocation|null,true,body.unavailable_reason as string|undefined,body.cached_fix_age_ms as number|null|undefined);
        if(body.request_id===locationRequest?.id)locationRequest?.finish();
        return;
      }
      if(body.operation==='call_pcm'){
        const id=body.call_id as string;
        check(body.session_id===session,'CALL_PCM_SESSION_MISMATCH',409);
        check(knownCall(id)&&options.voice_call?.pending?.()===id,'VOICE_CALL_NOT_ACTIVE',409);pcmCurrent=id;
        const pcm=options.voice_call?.pcm;check(pcm,'VOICE_CALL_PCM_NOT_CONFIGURED',503);
        await pcm(id,{seq:body.seq as number,captured_at_ms:body.captured_at_ms as number,
          sample_rate:body.sample_rate as 16000,pcm_s16le_base64:body.pcm_s16le_base64 as string});return;
      }
      if(body.operation==='call_open'||body.operation==='call_close'){
        if(body.operation==='call_open')await openCall(source,body.call_id as string,body.location,body.silence_timeout_ms as number|undefined,body.video as true|undefined,body.video_revision as number|undefined,body.wake_word===true,body.enrollment_session_id as string|undefined,body.conversation_mode as 'chat'|'thinking'|undefined);
        else {
          check(options.voice_call,'VOICE_CALL_NOT_CONFIGURED',503);
          const reason=(body.reason as CallReason|undefined)??'button';
          const closed=await options.runtime.formalVoice(source,'audio',()=>options.voice_call!.close(body.call_id as string,reason));
          // No such call here (already ended, or this gateway restarted): the call is closed. Answer the requester so a
          // client's retained hang-up intent settles; lastState replay alone misses restarts and other devices' calls.
          if(closed===false)await publish({operation:'call_state',session_id:session,call_id:body.call_id,state:'closed',reason});
        }
        return;
      }
      if(body.operation==='call_retry'){
        const id=body.call_id as string,context=knownCall(id);
        check(context&&options.voice_call?.conversationMode?.(id)==='thinking','VOICE_CALL_NOT_ACTIVE',409);
        const accepted=await options.runtime.retryCallTurn(source,session,body.processed_event_id as string,body.control_id as string,id);
        await mirror(accepted.processed_event.content.app_event as unknown as CallTurn,context,accepted);
        await publish({operation:'control_receipt',session_id:session,call_id:id,processed_event_id:body.processed_event_id,
          control_id:body.control_id,requested_operation:'call_retry',receipt:{...accepted.admission,processed_event_id:accepted.processed_event.processed_event_id}});return;
      }
      if(body.operation==='call_video'){
        check(options.voice_call?.setVideo,'VIDU_COMPONENT_REQUIRED',409);
        await options.runtime.formalVoice(source,'audio',async()=>{await options.runtime.ownerInput(source);
          await options.voice_call!.setVideo!(body.call_id as string,body.video as boolean,body.video_revision as number);});return;
      }
      if(body.operation==='errand_cancel'){
        await options.runtime.ownerControl(source);
        check(options.errands,'ERRAND_NOT_CONFIGURED',503);
        check(await options.errands!.cancel(body.job_id as string),'ERRAND_NOT_RUNNING',404);return;
      }
      if(body.operation==='memory_proposals'){
        const proposals=await options.runtime.memoryProposals(source,session,body.processed_event_id as string);
        await publish({operation:'memory_proposals',session_id:session,control_id:body.control_id,processed_event_id:body.processed_event_id,proposals});return;
      }
      if(body.operation==='memory_decide'){
        const outcome=await options.runtime.decideMemory(source,session,body.processed_event_id as string,{
          command_id:body.command_id as string,payload_sha256:body.payload_sha256 as string,
          decision:body.decision as 'approve'|'reject',control_id:body.control_id as string});
        await publish({operation:'memory_decision',session_id:session,control_id:body.control_id,outcome});
        if('accepted' in outcome){await publishAdmission(outcome.accepted);await follow(source,outcome.accepted.processed_event);}return;
      }
      if (wire.controls.includes(String(body.operation))) {
        const operation=String(body.operation);
        const dId=body.processed_event_id as string;
        if(operation==='retry_voice') {
          check(options.voice_transport, 'FORMAL_TEXT_ACK_CHANNEL_UNSUPPORTED');
          const result=await options.runtime.retryVoice(source,session,dId);
          await publish({operation:'control_receipt',session_id:session,processed_event_id:dId,control_id:body.control_id,requested_operation:operation,
            receipt:{voice_status:result.voice_status,voice_error:result.voice_error,reply_epoch:result.reply_epoch}});
          await publishResult(dId.startsWith('prompt:')?await options.runtime.fixedResult(source,session,dId):await options.runtime.result(source,session,dId));return;
        }
        const receipt=operation==='cancel_run'?await options.runtime.cancelRunControl(source,session,dId):
          operation==='reconcile'?await options.runtime.reconcile(source,session,dId):
          await options.runtime.cancelPlayback(source,session,dId,body.reply_epoch as number);
        await publish({operation:'control_receipt',session_id:session,processed_event_id:dId,control_id:body.control_id as string,requested_operation:operation,receipt});return;
      }
      if (body.operation === 'submit') {
        const raw: RawEvent = {schema_version:EVENT_SCHEMA,event_id:body.event_id as string,captured_at:body.captured_at as string,
          device_id:source.device_id,device_type:source.device_type,source:{channel:source.channel,
            ...(source.relay_device_id ? {relay_device_id:source.relay_device_id} : {}),...await placed(source,body.location)},media_type:'text',
          mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(body.text as string),
          ...(body.attachments === undefined ? {} : {attachments:body.attachments as NonNullable<RawEvent['attachments']>})};
        await submitAndFollow(raw.event_id,source,()=>options.runtime.submit(raw,source,session,true));
        return;
      }
      if (body.operation === 'ack') {
        const ack = body.ack as OutputAck;
        check(options.voice_transport || !ack.output_id.startsWith('voice:') && ack.status !== 'played',
          'FORMAL_TEXT_ACK_CHANNEL_UNSUPPORTED');
        const receipt = await options.runtime.acknowledge(source,session,body.processed_event_id as string,ack);
        await publish({operation:'ack_receipt',session_id:session,processed_event_id:body.processed_event_id,receipt}); return;
      }
      try {
        const resultValue = String(body.processed_event_id).startsWith('prompt:')?await options.runtime.fixedResult(source,session,body.processed_event_id as string,body.text_replay==='sealed'?{text_replay:'sealed'}:{}):
          await options.runtime.result(source,session,body.processed_event_id as string,body.text_replay === 'sealed' ? {text_replay:'sealed'} : {});
        await publishResult(resultValue);
      } catch(error) {
        // Reconnect reads reattach to the durable admission; the result owner publishes when its turn finishes.
        if(!(error instanceof ContractError)||!['RUN_NOT_ACCEPTED','OUTPUT_NATIVE_NOT_TERMINAL','SEALED_TEXT_NOT_AVAILABLE'].includes(error.code)||
          String(body.processed_event_id).startsWith('prompt:'))throw error;
        await follow(source,{processed_event_id:body.processed_event_id as string});
      }
      } catch(error) {if(pcmCurrent)await rejectPcm(error,request,pcmCurrent);else await reject(error,request);}

    };
    // Only microphone intake and its close barrier share this lane. Reserve on receipt, before async authentication.
    let audioInput=Promise.resolve(),enrollmentInput=Promise.resolve(),audioQueuedBytes=0,pcmRejection=false;
    const listener = (...args: readonly unknown[]) => {
      const [payload, participant, kind, topic] = args;
      if (topic === FORMAL_TEXT_INPUT_TOPIC) {
        const dropped = !attached || !current() ? 'connection_changed' : !(payload instanceof Uint8Array) ? 'payload_type' :
          kind !== DataPacketKind.KIND_RELIABLE ? 'not_reliable' : (participant as {identity?:unknown}|undefined)?.identity !== identity ? 'sender_identity' : undefined;
        if (dropped) trace({formal_text_dropped:dropped});
      }
      if (!attached || !current() || !(payload instanceof Uint8Array) || kind !== DataPacketKind.KIND_RELIABLE || topic !== FORMAL_TEXT_INPUT_TOPIC ||
        !participant || typeof participant !== 'object' || (participant as {identity?:unknown}).identity !== identity) return;
      let operation:unknown,pcmBytes=0,pcmFault:Record<string,unknown>|undefined,control=false,enrollmentControl=false;
      if(payload.byteLength<=wire.input_limit)try{const body=JSON.parse(new TextDecoder().decode(payload));operation=body?.operation;
        control=typeof operation==='string'&&reservedControls.has(operation)&&inputValidators[operation]!(body);
        enrollmentControl=operation==='voice_enrollment_control'||operation==='voiceprint_enrol_request'&&body.purpose==='conversation';
        if(operation==='call_pcm'&&typeof body.pcm_s16le_base64==='string'){
          const text=body.pcm_s16le_base64;pcmBytes=Math.ceil(text.length*3/4)-(text.endsWith('==')?2:text.endsWith('=')?1:0);
          const candidate={operation,call_id:body.call_id,session_id:body.session_id};
          if(inputValidators.call_pcm!(body))pcmFault=candidate;}
      }catch{} // The ordinary parser below reports malformed input.
      const release=reservePacket(digest([device.principal_id,device.device_id]),payload.byteLength,control,operation==='call_pcm');
      if(!release){
        // Do not start another authentication or SDK publication to report overload. No durable acceptance occurred.
        options.onError(new ContractError('FORMAL_TEXT_CAPACITY',429));return;
      }
      const consume=(action=()=>handle(payload))=>{
        const ownership={active:true};
        return packetWork.run(ownership,action).finally(()=>{ownership.active=false;release();});
      };
      if(operation==='call_pcm'&&audioQueuedBytes+pcmBytes>16000*2*5){
        if(pcmRejection){release();return;}pcmRejection=true;
        const request=pcmFault??{operation},failure=new ContractError('VOICE_CALL_PCM_CAPACITY',429);
        const work=audioInput.then(()=>consume(async()=>{await authorized();await rejectPcm(failure,request,
          request.session_id===session&&typeof request.call_id==='string'?request.call_id:undefined);})).finally(()=>{pcmRejection=false;});
        audioInput=work.catch(options.onError);track(audioInput);return;}
      if(operation==='call_pcm'||operation==='call_close'){
        audioQueuedBytes+=pcmBytes;
        const work=audioInput.then(()=>consume()).finally(()=>{audioQueuedBytes-=pcmBytes;});
        audioInput=work.catch(options.onError);track(audioInput);
      }else if(enrollmentControl){
        // Preserve request/exit/re-entry order while the authority awaits source validation.
        const work=enrollmentInput.then(consume);enrollmentInput=work.catch(options.onError);track(enrollmentInput);
      }else track(consume().catch(options.onError));
    };
    const cameraReaders=new Set<()=>void>();
    if(wire.camera_topic && room.registerByteStreamHandler && room.unregisterByteStreamHandler) {
      room.registerByteStreamHandler(wire.camera_topic,(reader,sender)=>{
        const key=digest([device.principal_id,device.device_id]);
        let frameId:string|undefined;
        let held:{streams:number;bytes:number}|undefined,frame:Record<string,unknown>,bytes:Buffer,size=0,source:RegisteredDevice|undefined;
        const foreign=!attached||!current()||sender.identity!==identity;
        const bounded=consumeBoundedByteStream({room,reader,maxBytes:3000000,current:()=>!foreign&&attached&&current(),
          error:kind=>kind==='cancelled'?new ContractError('FORMAL_TEXT_CONNECTION_CHANGED',409):
            kind==='size'?new ContractError('FORMAL_CAMERA_STREAM_SIZE_INVALID',413):
            kind==='incomplete'?new ContractError('FORMAL_CAMERA_STREAM_INCOMPLETE',409):
            new ContractError(kind==='inactive'?'FORMAL_CAMERA_STREAM_INACTIVE':'FORMAL_CAMERA_STREAM_DEADLINE',408),
          // Reserve synchronously: the SDK can queue chunks while authentication is pending.
          authorize:signal=>{
            check(hasFirstPersonCamera(device)||device.device_type==='phone'&&hasTerminalCapability(device,'camera'),'CAMERA_DEVICE_REQUIRED',403);
            check(reader.info.mimeType==='image/jpeg' && reader.info.totalSize!==undefined && reader.info.totalSize>0 &&
              reader.info.totalSize<=3000000,'FORMAL_CAMERA_STREAM_SIZE_INVALID',413);
            const metadata=reader.info.attributes?.frame;
            check(typeof metadata==='string' && Buffer.byteLength(metadata)<=2048,'FORMAL_CAMERA_METADATA_INVALID');
            frame=JSON.parse(metadata) as Record<string,unknown>;
            check(cameraMetadataValidator(frame),'FORMAL_CAMERA_FRAME_INVALID');
            frameId=frame.frame_id as string;
            const quota=cameraReservations.get(key)??{streams:0,bytes:0},total=reader.info.totalSize!;
            check(quota.streams<2&&quota.bytes+total<=4000000&&cameraStreams<8&&cameraBytes+total<=12000000,'FORMAL_CAMERA_CAPACITY',429);
            held=quota;held.streams++;held.bytes+=total;cameraReservations.set(key,held);cameraStreams++;cameraBytes+=total;
            return authorized().then(authenticated=>{
              signal.throwIfAborted();source=authenticated;bytes=Buffer.alloc(total);return source;
            });
          },
          write:content=>{bytes.set(content,size);size+=content.byteLength;}});
        if(foreign){track(bounded.done.catch(error=>{if(!(error instanceof ContractError&&error.code==='FORMAL_TEXT_CONNECTION_CHANGED'))options.onError(error);}));return;}
        cameraReaders.add(bounded.cancel);
        const consume=async()=>{
          try {
            const source=await bounded.done;
            check(attached && current(),'FORMAL_TEXT_CONNECTION_CHANGED',409);
            const receipt=await options.runtime.ingestVisualFrame(source,{...frame!,image:bytes!} as
              unknown as import('../../../services/personal-aios-integration/src/visual/store.ts').CameraFrame,session);
            await publish({operation:'camera_ack',session_id:session,frame_id:receipt.frame_id,status:receipt.status});
          } finally {
            cameraReaders.delete(bounded.cancel);
            if(held){held.streams--;held.bytes-=reader.info.totalSize!;cameraStreams--;cameraBytes-=reader.info.totalSize!;if(!held.streams)cameraReservations.delete(key);}
          }
        };
        track(consume().catch(async error=>{
          const failedSource=source??(error instanceof ContractError&&error.code==='FORMAL_CAMERA_CAPACITY'?device:undefined);
          if(failedSource&&frame?.trigger==='user_request')await options.runtime.cameraCaptureFailed(failedSource,frame.frame_id as string,error);
          await reject(error,{operation:'camera_frame'},frameId);
        }).catch(options.onError));
      });
    }
    const off = (event: string, callback: (...args: readonly unknown[]) => void) => {
      if (room.off) room.off(event,callback); else room.removeListener?.(event,callback);
    };
    const detachRoom = () => {
      if(!attached)return;
      attached=false;stopPublication();detachExtensions?.();
      localConnection.abort(changed());
      if(device.device_type==='phone'||device.device_type==='glasses')track(options.runtime.paymentDetach(device).catch(options.onError));
      peer.resolve();locationRequest?.finish();for(const stop of cameraReaders)stop();if(wire.camera_topic && room.unregisterByteStreamHandler)room.unregisterByteStreamHandler(wire.camera_topic); releaseCallSink(); unwatch();
      for(const unsubscribe of subscriptions.values())unsubscribe();
      subscriptions.clear();
      off(RoomEvent.DataReceived,listener);off(RoomEvent.Disconnected,disconnected);off(RoomEvent.ParticipantConnected,connected);off(RoomEvent.ParticipantDisconnected,peerLeft);
      off(RoomEvent.Reconnecting,lost);off(RoomEvent.Reconnected,reconnected);off(RoomEvent.ConnectionQualityChanged,qualityChanged);
    };
    const lost=()=>{
      if(!attached||!current())return;
      options.voice_call?.peerLost?.(device,session);mediaOff();
      if(peerKnown){const previous=peer;peerKnown=false;peer=makePeer();
        flushing=true;publishing=Promise.allSettled([...outputFlights].filter(([,ambient])=>!ambient).map(([flight])=>flight));
        for(const sent of sentErrands.values()){sent.text=0;sent.voice=0;delete sent.header;delete sent.record;}
        previous.cancel.abort(changed());detachExtensions?.();detachExtensions=undefined;}
      if(device.device_type==='phone'||device.device_type==='glasses')track(options.runtime.paymentDetach(device).catch(options.onError));
    };
    const disconnected = () => {if(options.voice_call?.pending?.()||liveCallId)lost();
      else{detachRoom();if(current()){generation++;currentRoom=undefined;detach=undefined;}}};
    // Transport recovery keeps the logical voice call. Stop paid video before waiting for final peer departure;
    // repeat the same idempotent state acknowledgement after recovery if the phone's off request/ACK was lost.
    const mediaOff=()=>{const id=options.voice_call?.pending?.();if(!attached||!current()||!id)return;
      if(options.voice_call?.setAvatar)track(options.voice_call.setAvatar(id,false).catch(options.onError));
      if(options.voice_call?.setVideo)track(options.voice_call.setVideo(id,false).catch(options.onError));};
    const qualityChanged=(quality:unknown,remote:unknown)=>{if((remote as {identity?:string})?.identity!==identity)return;
      if(quality===ConnectionQuality.QUALITY_LOST)lost();else connected(remote);};
    const peerLeft=(remote:unknown)=>{
      if((remote as {identity?:string})?.identity!==identity)return;
      lost();
    };
    let activityReady=false;
    const ready=(recipient:typeof peer)=>withinRealtimeReadiness(async signal=>{
      const readySignal=AbortSignal.any([signal,recipient.signal]);
      await settleWithSignal(async()=>{await Promise.all(watchers);await publishing;},readySignal);
      if(!attached||!current()||peer!==recipient)return;
      if(activityEnabled&&activityReady)await settleWithSignal(()=>options.runtime.replayActivity(device,deliverActivity),readySignal);
      activityReady=true;
      const historyEpoch=await options.runtime.historyEpoch?.();
      await settleWithSignal(()=>publish({operation:'ready',session_id:session,...(historyEpoch?{history_epoch:historyEpoch}:{})}),readySignal);
      if(device.device_type==='phone'&&hasTerminalCapability(device,'camera'))void track(options.runtime.cameraReady(device)).catch(options.onError);
      if(device.device_type==='phone'||device.device_type==='glasses')void track(options.runtime.movementReady(device)).catch(options.onError);
      // Readiness belongs to the transport; a call replay/publication error remains with the call owner.
      await settleWithSignal(async()=>{const source=await authorized();readySignal.throwIfAborted();await options.voice_call?.rejoin?.(source,session).catch(options.onError);},readySignal);
      if(attached&&current()&&peer===recipient){detachExtensions?.();detachExtensions=extensions.attach({device,room,identity,current:()=>attached&&current()&&peerKnown,leave,ready:present,publish:body=>publish({session_id:session,...body})});}
      if(peer===recipient)flushing=false;
    },setupSignal);
    let readyFlight:Promise<void>|undefined;
    const connected=(remote:unknown)=>{
      if(!attached||!current()||(remote as {identity?:string})?.identity!==identity||peerKnown)return;
      peerKnown=true;peer.resolve();const recipient=peer;
      readyFlight=ready(recipient).catch(async error=>{
        if(error instanceof ContractError&&error.code==='FORMAL_TEXT_CONNECTION_CHANGED'&&(!current()||peer!==recipient))return;
        if(current()&&peer===recipient){disconnected();void options.participant.disconnect().catch(options.onError);}throw error;
      });
      track(readyFlight.catch(options.onError));
    };
    const reconnected=()=>{for(const remote of room.remoteParticipants?.values()??[])connected(remote);};
    detach = detachRoom;
    room.on(RoomEvent.DataReceived,listener);room.on(RoomEvent.Disconnected,disconnected);room.on(RoomEvent.ParticipantConnected,connected);
    room.on(RoomEvent.ParticipantDisconnected,peerLeft);
    room.on(RoomEvent.Reconnecting,lost);room.on(RoomEvent.Reconnected,reconnected);room.on(RoomEvent.ConnectionQualityChanged,qualityChanged);
    for(const remote of room.remoteParticipants?.values()??[])connected(remote);
    try {while(peerKnown){const flight=readyFlight;await flight;if(flight===readyFlight)break;}}finally {setupSignal=undefined;}
  };
  const close = (): Promise<void> => {
    if (closeFlight) return closeFlight;
    closed=true; invalidate();
    // Original RealtimePublicControlRuntime closes its participant before this owned hook.
    closeFlight=(async()=>{while(pending.size)await Promise.allSettled([...pending]);})(); return closeFlight;
  };
  // Retire old control callbacks before the host waits for replacement raw consumers to become ready.
  return {beginBootstrap:invalidate,onBootstrapConnected: (input: RealtimeBootstrapConnectedInput) => {
    const expected=generation+1;
    return track(withinRealtimeReadiness(signal=>setup({...input,readinessSignal:signal}),input.readinessSignal).catch(error=>{
      if(generation===expected)invalidate();throw error;
    }));
  },close};
}
