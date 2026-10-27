import {ContractError,check,canonical,sha256,digest} from '../../../../../capability/contracts/json.ts';
export {ContractError,check,canonical,sha256,digest} from '../../../../../capability/contracts/json.ts';
import type { TerminalCapability } from './source-authority.ts';
import {validateVoiceprintSpeakers,voiceEvidence,principalAttribution} from './owner-authority.ts';
export {voiceEvidence,directedVoice,runScope,guestKey,principalAttribution,isBuildTask,ownerActionGrant} from './owner-authority.ts';
export type {VoiceprintSpeaker,RunScope,PrincipalAttribution,OwnerOriginResolver} from './owner-authority.ts';

export const EVENT_SCHEMA = 'paios.event.v1' as const;
export type DeviceType = 'glasses' | 'phone' | 'watch' | 'mac';
export type MediaType = 'text' | 'app_event' | 'audio' | 'visual' | 'file' | 'muxed_av' | 'livekit_tracks';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A delivery that failed at a known stage; the stage and reason travel with its durable failure record. */
export class DeliveryStageError extends ContractError {
  readonly stage: string; readonly reason: string;
  constructor(code: string, status: number, stage: string, reason: string) { super(code, status); this.stage = stage; this.reason = reason; }
}
/** The one identifier rule: public tool schemas declare this pattern and every server boundary enforces it. */
export const IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$';
const identifierRule = new RegExp(IDENTIFIER_PATTERN, 'u');
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierRule.test(value);
}
export function id(value: unknown): asserts value is string {
  check(isIdentifier(value), 'INVALID_ID');
}
/** The terminal's session ended or its pairing was revoked: it cannot be reached or authorize until it reconnects. */
export const inactiveSource=(e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&typeof e.code==='string'&&
  ['SOURCE_BINDING_INACTIVE','SOURCE_CURRENT_BINDING_REQUIRED','PAIRED_DEVICE_REVOKED'].includes(e.code);
export function utc(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'INVALID_CAPTURED_AT');
}
export type TimeRange =
  | {kind: 'instant'; timebase_id: string; at_ms: number; stream_epoch?: string}
  | {kind: 'interval'; timebase_id: string; start_ms: number; end_ms: number; stream_epoch?: string};
export function validateRange(range: TimeRange): void {
  id(range.timebase_id);
  if (range.stream_epoch !== undefined) id(range.stream_epoch);
  if (range.kind === 'instant') check(Number.isFinite(range.at_ms), 'INVALID_TIME_RANGE');
  else check(range.kind === 'interval' && Number.isFinite(range.start_ms) && Number.isFinite(range.end_ms) &&
    range.end_ms > range.start_ms, 'INVALID_TIME_RANGE');
}
export interface CaptureTiming {
  basis_ref: string; quality: 'estimated' | 'synthetic'; uncertainty_ms: number;
}
/** Where the user was when the event was captured (device GPS, WGS-84); the agent uses it for addresses and pickups. */
export interface CaptureLocation {
  latitude: number; longitude: number; accuracy_m: number; observed_at: string; datum: 'wgs84'; place?: string;
}
/** A device fix as the source contract accepts it: WGS-84, in range, a UTC observation time, an optional short place. */
export function checkLocation(where: unknown): asserts where is CaptureLocation {
  const fix = where as Record<string, unknown> | null;
  const within = (value: unknown, limit: number, low = -limit) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= limit;
  check(fix && typeof fix === 'object' && !Array.isArray(fix) && Object.keys(fix).every(key => ['latitude','longitude','accuracy_m','observed_at','datum','place'].includes(key)) &&
    within(fix.latitude, 90) && within(fix.longitude, 180) && within(fix.accuracy_m, 100000, 0) && fix.datum === 'wgs84' &&
    (fix.place === undefined || typeof fix.place === 'string' && fix.place.length > 0 && fix.place.length <= 200), 'INVALID_CAPTURE_LOCATION');
  utc(fix.observed_at);
}
export interface FileAttachment {
  grant_id: string; path: string; name: string; size: number;
  kind: 'pdf' | 'image' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'archive' | 'other';
}
export function validateAttachments(value: unknown): asserts value is FileAttachment[] {
  check(Array.isArray(value) && value.length <= 10, 'INVALID_ATTACHMENTS');
  for (const file of value) {
    check(file && typeof file === 'object' && !Array.isArray(file) &&
      Object.keys(file).sort().join(',') === 'grant_id,kind,name,path,size', 'INVALID_ATTACHMENT');
    id(file.grant_id);
    check(typeof file.path === 'string' && file.path.startsWith('/') && !file.path.includes('\0') &&
      Buffer.byteLength(file.path, 'utf8') <= 1024 && typeof file.name === 'string' &&
      file.name.length > 0 && Buffer.byteLength(file.name, 'utf8') <= 255 &&
      Number.isSafeInteger(file.size) && file.size >= 0 &&
      ['pdf','image','document','spreadsheet','presentation','text','archive','other'].includes(file.kind), 'INVALID_ATTACHMENT');
  }
}
export interface RawEvent {
  schema_version: typeof EVENT_SCHEMA;
  event_id: string; device_id: string; device_type: DeviceType; captured_at: string;
  source: {channel: string; app_id?: string; relay_device_id?: string; capture_timing?: CaptureTiming; location?: CaptureLocation};
  media_type: MediaType; mime: string;
  representation: 'uploaded_original' | 'received_encoded_track' | 'received_decoded_sample' | 'encoded_video_segment';
  payload: Uint8Array; time_range?: TimeRange; attachments?: FileAttachment[];
}
export interface AudioCapture {purpose:'request'|'voiceprint';lane:'finite'|'continuous'}
// Created by the transport's authenticated device registry, never by model/media content.
export interface TrustedContext {
  principal_id: string; device_id: string; device_type: DeviceType; consent_ref: string;
  // owner_call_turn: set only by the server-side live-call mirror for a finished turn of a call on this paired device.
  // owner_confirmation: set only by the server-side "确认是我" path for an owner_uncertain voice request.
  channel: string; submission: 'explicit_text' | 'owner_call_turn' | 'owner_confirmation' | 'owner_gesture' | 'unidentified_gesture' | 'observation' | 'errand_result';
  relay_device_id?: string; capabilities?: readonly TerminalCapability[];
  /** Host acquisition intent, persisted with the admitted original; never taken from raw input. */
  audio_capture?:AudioCapture;
}
export interface BoundEvent extends Omit<RawEvent, 'payload' | 'time_range'> {
  audio_capture?:AudioCapture;
  principal_id: string; consent_ref: string; received_at: string;
  origin: 'explicit_user_prompt' | 'device_observation'; user_identity: string | 'unknown';
  time_range: TimeRange;
}
export interface ArchivedEvent extends BoundEvent {
  raw_ref: string; archive_revision: string; archive_status: 'durable'; payload_sha256: string; bytes: number;
}
export interface Continuation {
  continuity_ref?: string; previous_processed_event_ids: string[];
  relation: 'new' | 'continues' | 'revises' | 'unknown';
  semantic_status: 'open' | 'likely_complete' | 'explicit_end' | 'unknown';
  basis_refs: string[]; policy_version: string;
}
export interface MediaSegment extends ArchivedEvent {
  /** `wake_turn`: a wake turn's audio analysed afresh as one speaker turn — its own segment beside the speech candidates it
   *  spans, even over the same time range (a wake word and its request in one utterance). */
  segment_id: string; segment_basis: 'speech_candidate' | 'wake_turn' | 'visual_window' | 'still_image';
  audio_ref: string | null; visual_refs: string[];
  /** A follow-up turn whose window opens with the replied request's speech (before `end_ms`, UTC): identity evidence for a
   *  short follow-up only, never transcribed; the follow-up's own words start at `request_start_ms`; audio between is
   *  neither. Recorded in the input fingerprint; not copied into D. */
  speaker_carrier?: {end_ms: number; request_start_ms: number};
  continuation_hint: 'open' | 'likely_complete' | 'explicit_end' | 'unknown';
  continuation: Continuation;
  coverage: {status: 'complete' | 'partial'; missing_ranges: TimeRange[];
    alignment_uncertainty_ms?: number;
    missing_by_track?: {track_id: string; stream_epoch: string; ranges: TimeRange[]}[]};
}
export interface AudioReuseEvidence {
  schema:'paios.media.audio-reuse.v1';raw_ref:string;segment_id:string;revision:number;
  processed_event_id:string;processed_sha256:string;input_sha256:string;
}
export interface ProcessedEvent extends Omit<ArchivedEvent, 'attachments'> {
  processed_event_id: string; revision: number; replaces_processed_event_id: string | null;
  segment_id: string | null; segment_basis: MediaSegment['segment_basis'] | null;
  continuation_hint: MediaSegment['continuation_hint'] | 'not_applicable'; continuation: Continuation | null;
  coverage: MediaSegment['coverage']; content: {attachments?: FileAttachment[]; text?: string; app_event?: Json; transcript?: Json;
    audio_observations?: Json; visual_observations?: Json;
    /** A wake turn's request framing on the request revision of an ambient captured-speech D (see AmbientLane). */
    wake_request?: Json; owner_override?: {authority:'owner_override';source_processed_event_id:string}};
  speakers: Json[]; intent_class: 'explicit_request' | 'observation' | 'unknown';
  reply_hint: 'respond' | 'policy';
  processing: {path_id: string; models: Json[]; policy_version: string; archive_revision: string; completed_at: string; reused_audio?:AudioReuseEvidence};
  quality: {status: 'complete' | 'partial'; warnings: string[]};
}
export interface AgentResult {
  schema_version: 'paios.result.v1'; processed_event_id: string; event_id: string; session_id: string; run_id: string;
  consumed_revision: number; result_revision: number;
  reply_id: string | null; reply_epoch: number; reply_phase: 'sealed' | 'interrupted' | 'failed';
  reply_mode: 'none' | 'text' | 'voice' | 'text_and_voice'; reply_text: string;
  output_plan: Json[]; l3_updates: Json[]; actions: Json[]; l2_updates: Json[]; evidence_refs: string[]; warnings: string[];
  run_status: string; reply_status: 'none' | 'complete' | 'partial' | 'failed';
  delivery_status: 'unknown' | 'accepted' | 'rendered' | 'played' | 'partial';
  result_status: 'completed' | 'failed' | 'interrupted';
}
export function bindRawSource(event: Omit<RawEvent, 'captured_at' | 'time_range'>, trusted: TrustedContext, receivedAt: string) {
  check(event.schema_version === EVENT_SCHEMA, 'SCHEMA_VERSION_UNSUPPORTED');
  id(event.event_id); id(event.device_id); id(trusted.principal_id); id(trusted.consent_ref);
  utc(receivedAt);
  const timing = event.source.capture_timing;
  if (timing !== undefined) check(timing && typeof timing === 'object' && typeof timing.basis_ref === 'string' && timing.basis_ref.length > 0 &&
    timing.basis_ref.length <= 200 && ['estimated','synthetic'].includes(timing.quality) &&
    Number.isFinite(timing.uncertainty_ms) && timing.uncertainty_ms >= 0, 'INVALID_CAPTURE_TIMING');
  if (event.source.location !== undefined) checkLocation(event.source.location);
  check(['glasses', 'phone', 'watch', 'mac'].includes(event.device_type), 'INVALID_DEVICE_TYPE');
  check(event.device_id === trusted.device_id && event.device_type === trusted.device_type &&
    event.source.channel === trusted.channel && event.source.relay_device_id === trusted.relay_device_id,
    'DEVICE_BINDING_MISMATCH', 403);
  check(['text', 'app_event', 'audio', 'visual', 'file', 'muxed_av', 'livekit_tracks'].includes(event.media_type), 'INVALID_MEDIA_TYPE');
  if (event.attachments !== undefined) {
    check(trusted.submission === 'explicit_text' && trusted.device_type === 'mac' &&
      trusted.capabilities?.includes('desktop_tools'), 'ATTACHMENT_SOURCE_DENIED', 403);
    validateAttachments(event.attachments);
  }
  check(event.payload instanceof Uint8Array && (event.payload.length > 0 ||
    event.media_type === 'text' && Boolean(event.attachments?.length)), 'EMPTY_PAYLOAD');
  check(['uploaded_original', 'received_encoded_track', 'received_decoded_sample', 'encoded_video_segment'].includes(event.representation),
    'INVALID_REPRESENTATION');
  const explicit = trusted.submission === 'explicit_text', callTurn = trusted.submission === 'owner_call_turn';
  const confirmation = trusted.submission === 'owner_confirmation';
  const gesture = trusted.submission === 'owner_gesture' || trusted.submission === 'unidentified_gesture';
  check(!explicit || event.media_type === 'text', 'EXPLICIT_PROMPT_REQUIRES_TEXT');
  check(!callTurn || event.media_type === 'app_event', 'CALL_TURN_REQUIRES_APP_EVENT');
  check(!confirmation || event.media_type === 'app_event', 'VOICE_CONFIRMATION_REQUIRES_APP_EVENT');
  check(!gesture || event.media_type === 'app_event', 'GESTURE_REQUIRES_APP_EVENT');
  const {payload: _payload,audio_capture:_untrustedCapture, ...metadata} = event as typeof event&{audio_capture?:unknown};
  canonical(metadata);
  // The internal call producer may attribute only speech it has identified as owner speech.
  return {...metadata,...(trusted.audio_capture?{audio_capture:structuredClone(trusted.audio_capture)}:{}), principal_id: trusted.principal_id, consent_ref: trusted.consent_ref, received_at: receivedAt,
    origin: explicit ? 'explicit_user_prompt' as const : 'device_observation' as const,
    user_identity: explicit || callTurn || confirmation || trusted.submission === 'owner_gesture' ? trusted.principal_id : 'unknown'};
}
export function bindRaw(event: RawEvent, trusted: TrustedContext, receivedAt: string): BoundEvent {
  utc(event.captured_at);
  const {captured_at, time_range, ...source} = event;
  const bound = bindRawSource(source, trusted, receivedAt);
  const range: TimeRange = time_range ?? {kind:'instant',timebase_id:'utc_unix_ms',at_ms:Date.parse(captured_at)};
  validateRange(range);
  return {...bound,captured_at,time_range:range};
}
export function validateProcessed(event: ProcessedEvent): void {
  check(event.schema_version === EVENT_SCHEMA && event.archive_status === 'durable', 'D_NOT_ARCHIVED');
  check(['explicit_user_prompt', 'device_observation'].includes(event.origin) &&
    ['explicit_request', 'observation', 'unknown'].includes(event.intent_class) &&
    ['respond', 'policy'].includes(event.reply_hint), 'D_INVALID_CLASSIFICATION');
  id(event.event_id); id(event.processed_event_id); utc(event.captured_at); validateRange(event.time_range);
  check(/^l5:[a-f0-9]{64}$/u.test(event.raw_ref) && /^[a-f0-9]{64}$/u.test(event.archive_revision), 'D_INVALID_RAW_REF');
  check(Number.isSafeInteger(event.revision) && event.revision > 0, 'D_INVALID_REVISION');
  check(event.processing.archive_revision === event.archive_revision, 'D_ARCHIVE_REVISION_MISMATCH');
  if (event.media_type === 'text' || event.media_type === 'app_event') {
    check(event.segment_id === null && event.segment_basis === null && event.continuation_hint === 'not_applicable' &&
      event.continuation === null && event.speakers.length === 0 &&
      event.processing.path_id === (event.media_type === 'text' ? 'direct_text' : 'direct_app'), 'D_TEXT_CONTRACT_MISMATCH');
  } else {
    check(event.segment_id !== null && event.segment_basis !== null && event.continuation !== null &&
      event.continuation_hint === event.continuation.semantic_status, 'D_CONTINUATION_MISMATCH');
  }
  check(event.origin !== 'explicit_user_prompt' || (event.media_type === 'text' &&
    event.user_identity === event.principal_id), 'D_ORIGIN_MISMATCH');
  check(!('attachments' in event), 'D_ATTACHMENT_CONTRACT_MISMATCH');
  if (event.content.attachments !== undefined) {
    validateAttachments(event.content.attachments);
    check(event.media_type === 'text' && event.device_type === 'mac' && event.origin === 'explicit_user_prompt',
      'D_ATTACHMENT_SOURCE_DENIED');
  }
  validateVoiceprintSpeakers(event);
  check(event.user_identity === 'unknown' || principalAttribution(event) !== null, 'D_ORIGIN_MISMATCH');
  // Owner-verified speech is the principal's own request; the processor that saw it must say so, and nothing else may.
  check(voiceEvidence(event) !== 'owner' || event.user_identity === event.principal_id, 'D_VOICE_ATTRIBUTION_MISMATCH');
  canonical(event);
}
