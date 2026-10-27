import {receipt, effect, unknown_fact, type Receipt, type State, type Next, type EffectKind,
  type Value} from '../../sdk/ts/receipt.ts';
import {resultFacts} from '../../sdk/ts/result-values.ts';

export interface ToolPolicy {
  effect?: EffectKind; effect_by_arg?: Record<string, Record<string, EffectKind>>;
  target?: string; task_type?: string; retry?: Next['retry']; check_with?: string;
}
export interface ResultInput {
  name: string; args: Record<string, unknown>; result: unknown; policy: ToolPolicy; now: string;
}
export type ResultAdapter = (input: ResultInput) => Receipt;
export const object = (raw: unknown): Record<string, any> => raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
export function path(raw: unknown, selector: string): any {
  return selector.replace(/^\$\./u, '').split('.').reduce((held, key) => object(held)[key], raw);
}
export function effectClass(input: ResultInput): EffectKind | undefined {
  const policy = input.policy;
  if (policy.effect) return policy.effect;
  const [selector, branches] = Object.entries(policy.effect_by_arg!)[0]!;
  return branches[String(path(input.args, selector))];
}
/** Preserve the full business result; scalar facts additionally carry units and their observation clock. */
export function resultValues(input: ResultInput): Value[] {
  return resultFacts(input.result,input.now,`platform:${input.name}`).values;
}
export function result(input: ResultInput, state: State, options: {
  reason?: string; next?: Partial<Next>; mutated?: boolean; evidence?: string; ref?: string | null;
  unknowns?: {about: string; why: string}[];
} = {}): Receipt {
  const kind = effectClass(input);
  const target = input.policy.target && path(input.args, input.policy.target);
  const facts=resultFacts(input.result,input.now,`platform:${input.name}`);
  return receipt(state, {
    status: {ended_at: input.now, ...(options.reason ? {reason_code: options.reason} : {})},
    effects: options.mutated && kind && kind !== 'observe' ? [effect(kind,
      typeof target === 'string' ? target : input.name, input.policy.task_type ?? input.name,
      'service_ack', options.evidence ?? JSON.stringify(input.result), options.ref ?? null)] : [],
    values: facts.values, content: [{key: `platform:${input.name}`, text: JSON.stringify(input.result), provenance: 'observed'}],
    unknowns: [...facts.unknowns,...(options.unknowns??[])], next: {retry: state === 'unknown' ? 'after_check' : input.policy.retry ?? 'forbidden',
      waiting_on: 'none', ...(state === 'unknown' ? {check_with: input.policy.check_with ?? input.name} : {}), ...options.next},
  });
}
export function unmapped(input: ResultInput): Receipt {
  return result(input, 'unknown', {reason: 'CAPABILITY_RESULT_UNMAPPED',
    unknowns: [unknown_fact('执行结果', '现有结果未提供可判定的状态')]});
}
export function failure(input: ResultInput, error: unknown): Receipt {
  const row = object(error), code = String(row.code ?? row.error_code ?? row.error ??
    (row.status === 'unavailable' ? 'PLATFORM_TOOL_UNAVAILABLE' : row.status === 'rejected' ? 'PLATFORM_TOOL_DENIED' :
      row.status === 'failed' ? 'PLATFORM_TOOL_FAILED' : 'PLATFORM_TOOL_ERROR'));
  const httpStatus = typeof row.status === 'number' ? row.status : row.http_status;
  // A refused read has no uncertain effect; a write may have failed after changing state.
  const refused = effectClass(input) === 'observe' && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
  const uncertain = !refused && (/timeout|timed_?out|disconn|not_connected|not_received|econn|enet|ehost|enotfound|epipe|socket|premature_close|network|abort|transport|reconcile_required/iu.test(code) ||
    code === 'PLATFORM_TOOL_ERROR' || [408, 500, 502, 504].includes(httpStatus));
  return result(input, uncertain ? 'unknown' : 'failed', {reason: code,
    ...(uncertain ? {unknowns: [unknown_fact('执行结果', '中断不证明操作失败，须先核查')]} : {})});
}
/** Shared result states, before a family's shape-specific interpretation. No success default. */
export function common(input: ResultInput): Receipt | undefined {
  const row = object(input.result), status = row.status;
  if (['failed', 'rejected', 'unavailable'].includes(status) && !row.pending) return failure(input, row);
  if (status === 'reconcile_required' || status === 'unknown') return result(input, 'unknown', {
    reason: row.error_code ?? status, unknowns: [unknown_fact('执行结果', '需查询原操作的状态')]});
  if (['pending_approval', 'awaiting_owner_signature', 'key_required'].includes(status) || row.pending && row.error_code === 'CAMERA_APP_INACTIVE')
    return result(input, 'waiting', {reason: row.error_code ?? status, next: {retry: 'forbidden', waiting_on: 'owner',
      needs_confirmation: String(row.proposal_ref ?? object(row.draft).draft_id ?? row.error_code ?? status)}});
  if (row.error_code) return failure(input, row);
  return undefined;
}
