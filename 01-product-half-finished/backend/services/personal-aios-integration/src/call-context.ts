import {DEFAULT_TIME_ZONE} from './deployment-time.ts';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CaptureLocation } from './contracts.ts';
import {buildTimelineContext, clip, safe, type TimelineContextSources} from './timeline.ts';
export {history, clip, safe, type NativeHistoryReader} from './timeline.ts';
import type { L3Assertion } from './memory/contracts.ts';

/** What the live call's realtime front knows about its owner when the call opens: who they are, what they prefer, when and
 *  where they are, and what was said lately. A bounded, read-only projection of the authorities the main agent itself
 *  reads — platform core-profile views (USER.md profile / MEMORY.md notes in its profile home, the deployment time zone),
 *  current L3 assertions and L4 cross-terminal native session history — never a second fact store.
 *  Built fresh for every call. Owner-authorized sources: the principal's scoped L3, sessions this principal owns, and only
 *  owner-scope turns in them. */
export const CALL_CONTEXT_MAX_CHARS = 2400;
const BUDGET = {profile: 350, notes: 200, facts: 300};
const ENTRY_LIMIT = 160, LINE_LIMIT = 90;
const MEMORY_ENTRY = '\n§\n'; // the native memory store's entry delimiter
export interface CallContextSources extends TimelineContextSources {
  /** The main agent's profile home (platform-generated read-only memory files). */
  profile_home?: string;
  l3?: {query(owner: {authenticated: true; principal_id: string}, assertion_id: undefined, status: 'active',
    options: {limit: number}): Promise<{assertions: L3Assertion[]}>};
  /** Owner-principal projection from the health store; absent or unavailable data adds no claim. */
  recentHealth?(principal: string): string | undefined | Promise<string | undefined>;
  now?: () => number; timeout_ms?: number;
  signal?: AbortSignal;
  time_zone?: string;
}
const chars = (text: string) => Array.from(text);

/** Entries in order until the budget is spent (each clipped, unsafe ones dropped). */
const fit = (entries: string[], budget: number, limit = ENTRY_LIMIT) => {
  const kept: string[] = []; let used = 0;
  for (const entry of entries.map(e => clip(e, limit)).filter(e => e && safe(e))) {
    if (used + chars(entry).length + 3 > budget) break;
    kept.push(entry); used += chars(entry).length + 3;
  }
  return kept;
};
const settle = async <T>(work: () => Promise<T>, fallback: T, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([Promise.resolve().then(work), new Promise<T>(resolve => {timer = setTimeout(() => resolve(fallback), ms);})]);}
  catch {return fallback;} finally {clearTimeout(timer);}
};

export async function memoryEntries(home: string | undefined, file: 'USER.md' | 'MEMORY.md', signal?: AbortSignal): Promise<string[]> {
  if (!home) return [];
  const text = await fs.readFile(join(home, 'memories', file), {encoding:'utf8',...(signal?{signal}:{})}).catch(() => '');
  return text.slice(0, 64 * 1024).split(MEMORY_ENTRY).map(entry => entry.trim()).filter(Boolean);
}
export const fact = (a: L3Assertion, stamp: (at: string) => string = at => at) => {
  const value = typeof a.value === 'string' || typeof a.value === 'number' || typeof a.value === 'boolean' ? String(a.value) : JSON.stringify(a.value);
  const s = a.scope, time = s.valid_time ? `${stamp(s.valid_time.from)}至${s.valid_time.until ? stamp(s.valid_time.until) : '未注明结束'}` : '未注明';
  return `主体${a.subject_ref.type}:${a.subject_ref.id}；记录于${stamp(a.created_at)}；有效期${time}；用途${s.purpose}；情境${s.situation}；角色${s.role}；评估${s.evaluation_frame}；${a.predicate}：${clip(value, LINE_LIMIT)}`;
};

export async function buildCallContext(sources: CallContextSources, request: {principal_id: string; session: string; location?: CaptureLocation}) {
  const ms = sources.timeout_ms ?? 1200, now = sources.now?.() ?? Date.now();
  const zone = sources.time_zone ?? DEFAULT_TIME_ZONE;
  const [profile, notes, assertions, recent, health] = await Promise.all([
    settle(() => memoryEntries(sources.profile_home, 'USER.md', sources.signal), [], ms),
    settle(() => memoryEntries(sources.profile_home, 'MEMORY.md', sources.signal), [], ms),
    settle(async () => sources.l3 ? (await sources.l3.query({authenticated: true, principal_id: request.principal_id}, undefined, 'active',
      {limit: 40})).assertions : [], [] as L3Assertion[], ms),
    settle(() => buildTimelineContext(sources, request.principal_id, request.session), '【同一条时间线】暂不可读取，不能据此认定此前没有对话。', ms),
    settle(async () => sources.recentHealth?.(request.principal_id), undefined, ms)]);
  const recordTime=sources.time_zone?new Intl.DateTimeFormat('sv-SE',{timeZone:zone,dateStyle:'short',timeStyle:'short'}):undefined;
  const facts = fit(assertions.filter(a => a.scope.principal_id === request.principal_id && a.status === 'active' && a.applicability_status === 'applicable' &&
    ['preference', 'fact', 'plan'].includes(a.kind)).sort((a, b) => (a.kind === 'preference' ? 0 : 1) - (b.kind === 'preference' ? 0 : 1))
    .map(a => fact(a,recordTime?at=>`${recordTime.format(Date.parse(at))}（${zone}）`:undefined))
    .filter(e => chars(e).length <= BUDGET.facts), BUDGET.facts, BUDGET.facts);
  const about = [...fit(profile, BUDGET.profile).map(e => `- ${e}`), ...fit(notes, BUDGET.notes).map(e => `- ${e}`)];
  const when = new Intl.DateTimeFormat('zh-CN', {timeZone: zone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(now));
  const stamp = (at: number) => new Intl.DateTimeFormat('zh-CN', {timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'}).format(new Date(at));
  const place = request.location?.place && safe(request.location.place) ? clip(request.location.place, 60) : undefined;
  const block = [
    '【关于主人】（主助手的记忆）', ...(about.length ? about : ['- 记忆里还没有主人的名字和资料。']),
    ...(facts.length ? ['【L3断言】（仅适用于所列主体、时间和情境，不代表主人此刻的事实）', ...facts.map(e => `- ${e}`)] : []),
    `【此刻】${when}（${zone}）${place ? `；手机最后定位于${stamp(Date.parse(request.location!.observed_at))}：${place}（只对应定位时间，不能断言现在仍在这里）` : '；不知道主人现在在哪'}`,
    ...(health ? fit([health], 180, 180) : []),
    ...(recent ? [recent] : []),
  ].join('\n');
  return chars(block).slice(0, CALL_CONTEXT_MAX_CHARS).join('');
}
