/** Platform consent data. Never accepted as tool/model-supplied authority. */
export const SCOPE_SESSION_CAP_MS = 2 * 60 * 60 * 1000;
export const SCOPE_DISCONNECT_MS = 60 * 1000;
export interface ScopeTarget {target_id:string;target_device_id:string}
export type ScopeEndReason = 'explicit'|'expired'|'disconnected'|'companion_off'|'privacy_pause'|
  'target_changed'|'device_paused'|'pairing_revoked';
export interface ScopeSession extends ScopeTarget {
  version:1;id:string;principal_id:string;revision:number;state:'active'|'ended';
  opened_at:string;expires_at:string;last_seen_at:string;allowed_operation_kinds:string[];
  disconnected_at?:string;ended_at?:string;end_reason?:ScopeEndReason;
}
export interface ScopeGrantRequest extends ScopeTarget {
  scope_session_id:string;expires_at:string;allowed_operation_kinds:string[];
}
export interface ScopeGrant extends ScopeGrantRequest {
  version:1;grant_id:string;principal_id:string;confirmation_id:string;confirmed_at:string;
}
export interface ScopeRunBinding extends ScopeTarget {
  principal_id:string;run_id:string;session_id:string;scope_session_id:string;
}
export interface ScopeCall extends ScopeTarget {
  scope_session_id:string;operation_kind:string;request?:ScopeGrantRequest;
}
/** Additive owner-unlock confirmation projection; never sends frozen admission or execution authority. */
export interface ScopeConfirmationView {grant_request:ScopeGrantRequest;preview_items:string[]}
/** Issued only after live platform consent; a fixed Mac helper never accepts arbitrary scripts. */
export interface ScopeExecution extends ScopeTarget {
  principal_id:string;grant_id:string;confirmation_id:string;scope_session_id:string;
  operation_kind:'document.text.update';valid_until:string;plan_sha256:string;
}
