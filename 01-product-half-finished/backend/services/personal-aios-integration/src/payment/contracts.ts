import type {RegisteredDevice} from '../source-authority.ts';

export interface UtteranceRef {
  device_id: string;
  device_type: 'phone'|'glasses';
  raw_ref: string;
  archive_revision?: string;
  start_ms: number;
  end_ms: number;
  captured_at: string;
  processed_event_id?: string;
  transcript?: string;
}

export type VoiceVerdictKind = 'pass'|'uncertain'|'fail'|'insufficient'|'unavailable';
export interface VoiceVerdict {
  verdict: VoiceVerdictKind;
  reason?: 'too_short'|'no_speech'|'low_quality'|'other_speaker'|'assistant_voice'|'not_enrolled'|'audio_missing'|'engine_unavailable'|'different_terminal';
  initiating: {score: number|null; speech_ms: number};
  pay?: {score: number|null; speech_ms: number};
  combined?: {score: number|null; speech_ms: number};
  channel: 'phone_app'|'glasses'; speaker_model: string;
}
export interface PaymentVoiceVerifier {
  /** Pass requires enrolled-only verification of pinned audio via the shared identity authority in verify mode.
   *  Learned call samples and call_only identity results cannot produce pass, for either utterance or their carrier. */
  verifyInitiating(principal: string, initiating: UtteranceRef, signal?: AbortSignal): Promise<VoiceVerdict>;
  verifyPay(principal: string, initiating: UtteranceRef, pay: UtteranceRef, signal?: AbortSignal): Promise<VoiceVerdict>;
}
export interface Initiating {
  kind:'voice'|'text'|'confirmation'|'other_voice';device_id:string;device_type:string;captured_at_ms:number;
  utterance?:UtteranceRef;lease_at_capture:boolean;verdict?:VoiceVerdict;
}
export const PAYMENT_STATES=['awaiting_owner','auto_pending','verifying','granted','paying','paid','outcome_unknown','cancelled','expired','superseded','failed'] as const;
export type PaymentState=typeof PAYMENT_STATES[number];
export const TERMINAL_STATES:readonly PaymentState[]=['paid','outcome_unknown','cancelled','expired','superseded','failed'];
export type PaymentMethod='card'|'voice'|'auto';
export type OrderCancel='pending'|'done'|'failed'|'not_attempted'|'not_needed';
export const CARD_REASONS=['INITIATING_NOT_VOICE','INITIATING_NOT_OWNER_VERIFIED','DIFFERENT_TERMINAL','TERMINAL_LOCKED','REQUEST_STALE',
  'OVER_AUTO_LIMIT','OVER_AUTO_DAY_LIMIT','OVER_VOICE_LIMIT','OVER_BUDGET','NEW_PAYEE','PAYEE_UNREADABLE','SAME_PAYEE_RECENT','AUTO_PAUSED',
  'VOICE_NOT_RECOGNIZED','VOICE_INSUFFICIENT','VOICE_ATTEMPTS_EXHAUSTED','VOICE_UNAVAILABLE','VOICE_DISABLED','AUTO_DISABLED','LOCKS_NOT_ENABLED','AMOUNT_CHANGED','AUTO_INTERRUPTED'] as const;
export type CardReason=typeof CARD_REASONS[number];
export interface PaymentConfig {
  enabled:boolean;staging:boolean;card_ttl_s:number;intent_ttl_s:number;grant_ttl_s:number;result_timeout_s:number;
  max_recards_per_intent:number;request_freshness_s:number;challenge_ttl_s:number;cards:{recent_s:number};card:{max_amount_fen:number|null};
  voice:{max_order_fen:number;max_attempts_per_card:number;pay_phrases:string[];carrier_ms:number;require_same_terminal:boolean};
  auto:{max_order_fen:number;max_day_fen:number;undo_s:number;same_payee_window_s:number};anomaly:{max_per_day:number};
  limits:{max_settable_fen:number};
  locks:{require_glasses_lock:boolean;phone_relock_s:number;phone_relock_choices_s:number[];phone_lease_max_s:number;glasses_lease_max_s:number;glasses_unlock_request_ttl_s:number;glasses_wear_poll_ms:number};
  enrolment:{request_ttl_s:number;grant_ttl_s:number};executor_key_file?:string;notify:{push:boolean};
}
export interface Limits {auto_order_fen:number;auto_day_fen:number;voice_order_fen:number}
export interface PaymentPolicy {
  principal_id:string;version:number;voice_enabled:boolean;auto_enabled:boolean;limits:Partial<Limits>;paused_until_ms:number|null;updated_at_ms:number;
}
export interface LockRow {device_id:string;principal_id:string;device_type:'phone'|'glasses';enabled:boolean;relock_s:number|null;updated_at_ms:number}
export interface DeviceKey {device_id:string;role:'device'|'user'|'model_settings'|'model_settings_pending';principal_id:string;public_x963_b64:string;created_at_ms:number;revoked_at_ms:number|null}
export interface PaymentIntent {
  intent_id:string;principal_id:string;run_id:string;tool_call_id:string;session_id:string;processed_event_id:string;
  initiating:Initiating;initiating_text:string|null;purpose:string;app:string;budget_fen:number|null;
  created_at_ms:number;expires_at_ms:number;state:'open'|'bound'|'closed';closed_reason:string|null;
}
export interface Payment {
  payment_id:string;intent_id:string;principal_id:string;job_id:string;seq:number;supersedes:string|null;app:string;checkout:'order_card'|'cashier';
  amount_fen:number;payee:string|null;payee_key:string|null;items:string[];delivery:string|null;screen_sha256:string;
  state:PaymentState;version:number;decision_nonce:string;created_at_ms:number;expires_at_ms:number;auto_at_ms:number|null;
  voice_attempts:number;method:PaymentMethod|null;decided_by_device:string|null;decision:'pay'|'cancel'|null;reason:string|null;notice:Record<string,unknown>|null;
  next_payment_id:string|null;order_cancel:OrderCancel|null;finished_at_ms:number|null;
}
export interface PaymentGrant {
  grant_id:string;payment_id:string;amount_fen:number;payee_key:string|null;method:PaymentMethod;device_id:string;
  issued_at_ms:number;expires_at_ms:number;taps:number;first_tap_at_ms:number|null;
}
export interface AuditEvent {
  seq:number;at_ms:number;principal_id:string;kind:string;intent_id:string|null;payment_id:string|null;actor:string;device_id:string|null;
  data:Record<string,unknown>;prev_hash:string;hash:string;
}
export interface Checkpoint {
  intent_id:string;job_id:string;seq:number;app:string;checkout:'order_card'|'cashier';amount_fen:number;payee?:string|null;
  items:string[];delivery?:string|null;screen_sha256:string;read_at:string;
}
export interface SignedInput {statement_b64?:string;signature_b64?:string}
export type SettingsChange={kind:'voice'|'auto';enabled:boolean}|{kind:'limits';auto_order_fen?:number;auto_day_fen?:number;voice_order_fen?:number}
  |{kind:'phone_lock';enabled:boolean;relock_s?:number}|{kind:'relock';relock_s:number}|{kind:'glasses_lock';device_id:string;enabled:boolean};
export type PaymentProjection=Record<string,unknown>&{operation:string};
export interface PaymentPorts {
  revalidate(source:RegisteredDevice):Promise<RegisteredDevice>;
  /** Fresh paired inventory, including offline devices. Descriptors are not authenticated session handles. */
  devices(principal:string):Promise<RegisteredDevice[]>;
  owner(principal:string):Promise<{live:boolean;phone_app:boolean;glasses:boolean}>;
  forget(principal:string,channel:'glasses'):Promise<void>;
  update(intent:PaymentIntent,payment:Payment,event:string,extra?:Record<string,unknown>):Promise<void>;
  context(principal:string,text:string):Promise<void>;
  openPayWindow?(input:{principal_id:string;device_id:string;until_ms:number;phrases:string[]},heard:(u:UtteranceRef&{text:string;speaker:string|null})=>void):()=>void;
  enrolment_sentences:string[];
}
