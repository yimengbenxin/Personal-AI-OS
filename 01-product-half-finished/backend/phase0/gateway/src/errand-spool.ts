import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractError, DeliveryStageError, digest, utc, isIdentifier, id as identifier } from '../../../services/personal-aios-integration/src/contracts.ts';
import spoolContract from '../../../../../integrations/contracts/errand-spool.v1.json' with {type:'json'};
import type { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import type { Notify } from './bark-notifier.ts';

import type {ErrandResult,ErrandProgress} from '../../../services/personal-aios-integration/src/runtime.ts';
export type {ErrandResult,ErrandProgress} from '../../../services/personal-aios-integration/src/runtime.ts';
const TERMINAL_REASONS = spoolContract.terminal_reasons;
const {pending, notified, delivered, quarantined, delivery_failed} = spoolContract.states;
const suffix = (state: string) => `.${state}.json`;

const JOB = /^[a-z0-9][a-z0-9-]{7,63}$/;
const RUNNING_JOB = /^job-[0-9a-f]{12}$/;
const PAYMENT_INTENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;

/** The executor may run without a named app; it writes "app": null (Python None), which means "no app" here. */
export function parseErrandProgress(value: unknown): ErrandProgress & {principal_id:string} {
  const raw = value as Record<string, unknown> | null;
  const r = (raw && typeof raw === 'object' && raw.app === null ? {...raw, app: ''} : raw) as Partial<ErrandProgress> | null;
  const count = (n: unknown, min: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= 1000;
  if (!r || typeof r !== 'object' || typeof r.job_id !== 'string' || !RUNNING_JOB.test(r.job_id) ||
      typeof r.title !== 'string' || !r.title || [...r.title].length > 40 || typeof r.app !== 'string' || [...r.app].length > 32 ||
      !['waiting', 'running', 'stopping'].includes(r.state as string) || typeof r.started_at !== 'string' ||
      !count(r.step, 0) || !count(r.max_steps, 1)) throw new Error('ERRAND_PROGRESS_INVALID');
  const principal_id = (raw as Record<string,unknown>).principal_id; identifier(principal_id);
  utc(r.started_at);
  return {principal_id:principal_id as string,job_id: r.job_id, title: r.title, app: r.app, state: r.state!, started_at: r.started_at, step: r.step!, max_steps: r.max_steps!,
    ...(r.capability_receipt!==undefined?{capability_receipt:r.capability_receipt}:{})};
}

export function parseErrandResult(value: unknown): ErrandResult {
  const raw = value as Record<string, unknown> | null;
  const r = (raw && typeof raw === 'object' && raw.app === null ? {...raw, app: undefined} : raw) as Partial<ErrandResult> | null;
  const reconciliation = r?.payment_reconciliation;
  const findings = r?.partial_findings;
  if (findings !== undefined && (r?.success !== false || !findings || typeof findings !== 'object' || Array.isArray(findings) ||
      Object.keys(findings).length !== 4 || !Object.keys(findings).every(key=>['verified','not_verified','last_screen_text','truncated'].includes(key)) ||
      ![findings.verified,findings.not_verified].every(items=>Array.isArray(items)&&items.length<=32&&items.every(item=>typeof item==='string')) ||
      [...findings.verified,...findings.not_verified].reduce((size,item)=>size+[...item].length,0)>6000 ||
      typeof findings.last_screen_text !== 'string' || [...findings.last_screen_text].length>4000 ||
      typeof findings.truncated !== 'boolean')) throw new Error('ERRAND_RESULT_INVALID');
  if (reconciliation !== undefined && (!reconciliation || typeof reconciliation !== 'object' || Array.isArray(reconciliation) ||
      Object.keys(reconciliation).length !== 3 || !Object.keys(reconciliation).every(key => ['of_job', 'intent_id', 'state'].includes(key)) ||
      typeof reconciliation.of_job !== 'string' || !JOB.test(reconciliation.of_job) ||
      typeof reconciliation.intent_id !== 'string' || !PAYMENT_INTENT.test(reconciliation.intent_id) ||
      typeof reconciliation.state !== 'string' || !['paid', 'unpaid', 'unknown'].includes(reconciliation.state))) throw new Error('ERRAND_RESULT_INVALID');
  if (!r || typeof r !== 'object' || typeof r.job_id !== 'string' || !JOB.test(r.job_id) || typeof r.task !== 'string' ||
      r.task.length > 4000 || typeof r.success !== 'boolean' || typeof r.answer !== 'string' || r.answer.length > 8000 ||
      typeof r.finished_at !== 'string' || (r.app !== undefined && typeof r.app !== 'string') ||
      (r.tier !== undefined && typeof r.tier !== 'string') ||
      (r.title !== undefined && (typeof r.title !== 'string' || !r.title || [...r.title].length > 40)) ||
      (r.self_check_of !== undefined && !isIdentifier(r.self_check_of)) ||
      (r.evidence_ref !== undefined && (!r.evidence_ref || typeof r.evidence_ref !== 'object' ||
        Object.keys(r.evidence_ref).length !== 2 || r.evidence_ref.tool !== 'phone_status' || r.evidence_ref.job_id !== r.job_id)) ||
      (r.payment_intent !== undefined && (typeof r.payment_intent !== 'string' || !PAYMENT_INTENT.test(r.payment_intent))) ||
      (r.terminal_reason !== undefined && !TERMINAL_REASONS.includes(r.terminal_reason)) ||
      (r.retryable !== undefined && typeof r.retryable !== 'boolean')) throw new Error('ERRAND_RESULT_INVALID');
  const principal_id = (raw as Record<string,unknown>).principal_id; identifier(principal_id);
  if (r.origin_processed_event_id !== undefined) identifier(r.origin_processed_event_id);
  utc(r.finished_at);
  return {principal_id:principal_id as string,job_id: r.job_id, task: r.task, success: r.success, answer: r.answer, finished_at: r.finished_at,
    ...(r.capability_receipt!==undefined?{capability_receipt:r.capability_receipt}:{}),
    ...(findings !== undefined ? {partial_findings:{...findings,verified:[...findings.verified],not_verified:[...findings.not_verified]}} : {}),
    ...(r.app ? {app: r.app} : {}), ...(r.tier ? {tier: r.tier} : {}),
    ...(r.title !== undefined ? {title:r.title} : {}),
    ...(r.evidence_ref !== undefined ? {evidence_ref:{...r.evidence_ref}} : {}),
    ...(r.self_check_of !== undefined ? {self_check_of:r.self_check_of} : {}),
    ...(r.origin_processed_event_id !== undefined ? {origin_processed_event_id:r.origin_processed_event_id} : {}),
    ...(r.payment_intent ? {payment_intent:r.payment_intent} : {}),
    ...(reconciliation ? {payment_reconciliation: {...reconciliation}} : {}),
    ...(r.terminal_reason ? {terminal_reason: r.terminal_reason} : {}), ...(r.retryable !== undefined ? {retryable: r.retryable} : {})};
}

/** The phone notice for a finished errand while no app connection can take it (raw executor result; the main
 *  agent's own report follows once the app connects). */
export function errandNotice(result: ErrandResult) {
  const payment=result.payment_intent !== undefined || result.payment_reconciliation !== undefined ||
    ['【已付款】','【付款结果不明】','【可能已付款】'].some(prefix=>result.answer.startsWith(prefix));
  const title = result.answer.startsWith('【已付款】') ? '依米：已付款' :
    result.answer.startsWith('【付款结果不明】') ? '依米：付款结果不明，请核对' : result.answer.startsWith('【可能已付款】') ? '依米：可能已付款，请核对订单' : result.success ? '依米：办好了' : '依米：没办成';
  return {title, body: payment ? '解锁依米查看金额和收款方。' : result.answer.slice(0, 300)};
}

/** Finished errands arrive as `<job>.done.json` files the executor writes atomically into an owner-only directory.
 *  Each is handed once to the connection that is attached when it is found (or the next one to attach) and renamed
 *  `.delivered.json` only after its report was delivered; subscription acceptance leaves it replayable.
 *  With no connection to take it, the user is notified once (`.notified.json`) and the main agent still gets it on
 *  the next connection. Report failures keep their cause until the main agent accepts a failure observation, then
 *  are quarantined. A malformed record is quarantined without guessing its owner. */
export function createErrandSpool(dir: string, onError: (error: unknown) => void,
  options: {originStorage?:Pick<PosixStorage,'hotKeys'|'read'>;intervalMs?: number; notify?: Notify;deliver?:(result:ErrandResult)=>Promise<boolean|'pending'|'absorbed'>;
    failed?:(result:ErrandResult,error_code:string,failed_at:string,cause?:{stage:string;reason:string})=>Promise<boolean>;progress?:(principal:string,running:ErrandProgress[])=>Promise<void>} = {}) {
  // One callback in flight plus one replaceable snapshot per principal. Never retain a chain of sweeps.
  const publications = new Map<string,{busy:boolean;latest?:ErrandProgress[];work?:Promise<void>}>();
  let principals = new Set<string>(), closed = false;
  const publish = (principal:string, running:ErrandProgress[]) => {
    if(closed || !options.progress)return;
    let state=publications.get(principal);
    if(!state){state={busy:false};publications.set(principal,state);}
    state.latest=running;
    if(state.busy)return;
    state.busy=true;
    const drain=async()=>{
      let sending:ErrandProgress[]|undefined;
      try {while(!closed&&state.latest){sending=state.latest;delete state.latest;await options.progress!(principal,sending);}}
      catch(error){if(sending)state.latest??=sending;onError(error);}
      finally{state.busy=false;if(!state.latest)publications.delete(principal);}
    };
    state.work=drain();
  };
  let sweeping: Promise<void> | undefined, rescan = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let notifyAfter = 0; // a failed push (Bark not set up, offline) is retried a minute later, not every sweep
  let failureAfter = 0;
  // A caller may arrive after the active readdir. Coalesce its request into one fresh scan,
  // keeping delivery serial and making the returned promise cover that caller's snapshot.
  const sweep = (): Promise<void> => {
    rescan = true;
    return sweeping ??= (async () => {
      try {do {rescan = false;await scan();} while (rescan);}
      finally {sweeping = undefined;}
    })();
  };
  const scan = async (): Promise<void> => {
    try {
      const all = await readdir(dir).catch(() => [] as string[]);
      await report(all);
      const names = all.filter(name => [pending,notified,delivered,delivery_failed].some(state=>name.endsWith(suffix(state)))).sort();
      const reportFailures=Date.now()>=failureAfter;
      for (const name of names) {

        const path = join(dir, name);
        const state = suffix([pending,notified,delivered,delivery_failed].find(state=>name.endsWith(suffix(state)))!);
        const quarantine=async(error:unknown)=>{
          onError(error);
          if(state===suffix(delivered))await link(path,`${path}.quarantine-source`).catch(error=>{if(error.code!=='EEXIST')throw error;});
          await rename(path,path.slice(0,-state.length)+suffix(quarantined));
        };
        let raw:Record<string,unknown>,result:ErrandResult;
        try {raw=JSON.parse(await readFile(path,'utf8'));}
        catch(error){await quarantine(error);continue;}
        if(raw && raw.principal_id === undefined && raw.job_id === name.slice(0,-state.length) && options.originStorage) {
          const owners = new Set<string>();
          try {
            for await(const key of options.originStorage.hotKeys('errand-origins')) {
              const binding=JSON.parse(Buffer.from(await options.originStorage.read('errand-origins',key)).toString('utf8'));
              if(binding.job_id!==raw.job_id)continue;
              identifier(binding.principal_id);identifier(binding.origin_processed_event_id);
              if(key!==digest({principal_id:binding.principal_id,job_id:binding.job_id}))throw new Error('ERRAND_ORIGIN_BINDING_INVALID');
              owners.add(binding.principal_id);
            }
          }catch(error){onError(error);continue;}
          if(owners.size===1) {
            const recovered={...raw,principal_id:[...owners][0]};
            try {parseErrandResult(recovered);}catch(error){await quarantine(error);continue;}
            // Keep the exact preimage and its source name. Repeating after a crash preserves the original link.
            await link(path,`${path}.principal-recovery`).catch(error=>{if(error.code!=='EEXIST')throw error;});
            const temporary=`${path}.${randomUUID()}.tmp`;
            await writeFile(temporary,JSON.stringify(recovered),{mode:0o600});
            await rename(temporary,path);
            raw=recovered;
          }
        }
        let failure:{error_code:string;failed_at:string;stage?:string;reason?:string}|undefined;
        try {
          result=parseErrandResult(raw);
          failure=raw.delivery_failure as typeof failure;
          if(state===suffix(delivery_failed)||failure!==undefined){
            if(!failure||typeof failure.error_code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(failure.error_code)||
              (failure.stage!==undefined||failure.reason!==undefined)&&!(typeof failure.stage==='string'&&/^[a-z_]{1,32}$/.test(failure.stage)&&
                typeof failure.reason==='string'&&failure.reason.length>0&&failure.reason.length<=1000))throw new Error('ERRAND_FAILURE_INVALID');
            utc(failure.failed_at);
          }
        } catch(error){await quarantine(error);continue;}
        if(state===suffix(delivered))continue;
        if(failure){
          if(!reportFailures||!options.failed)continue;
          try {
            if(!await options.failed(result,failure.error_code,failure.failed_at,failure.stage===undefined?undefined:{stage:failure.stage,reason:failure.reason!})){failureAfter=Date.now()+60_000;continue;}
            // The main agent owns recovery. The phone receives no executor answer or payment details in this notice.
            await rename(path,path.slice(0,-state.length)+suffix(quarantined));
            await options.notify?.({title:'依米：办事结果未送达',body:`结果已保留，已通知主代理核查。错误：${failure.error_code}`});
          }catch(error){failureAfter=Date.now()+60_000;onError(error);}
          continue;
        }
        try {
          const delivery=await options.deliver?.(result);
          if (delivery==='absorbed') {
            // The self-check that owns this result reports it; record that no separate report was due.
            const temporary=`${path}.${randomUUID()}.tmp`;
            await writeFile(temporary,JSON.stringify({...raw,report_absorbed:true}),{mode:0o600});
            await rename(temporary,path);
          }
          if (delivery===true||delivery==='absorbed') {
            await rename(path, path.slice(0, -state.length) + suffix(delivered));
            continue;
          }
          if(delivery==='pending')continue;
        } catch (error) {
          onError(error);
          const delivery_failure={error_code:error instanceof ContractError?error.code:'ERRAND_REPORT_NOT_DELIVERED',failed_at:new Date().toISOString(),
            ...(error instanceof DeliveryStageError?{stage:error.stage,reason:error.reason}:{})};
          const temporary=`${path}.${randomUUID()}.tmp`;
          await writeFile(temporary,JSON.stringify({...raw,delivery_failure}),{mode:0o600});
          // Persist before changing the suffix. A crash between renames still cannot reoffer the failed report.
          await rename(temporary,path);
          await rename(path,path.slice(0,-state.length)+suffix(delivery_failed));
          continue;
        }
        if (state === suffix(notified) || !options.notify || Date.now() < notifyAfter) continue;
        try {
          await options.notify(errandNotice(result));
          await rename(path, path.slice(0, -state.length) + suffix(notified));
        } catch (error) {
          notifyAfter = Date.now() + 60_000;
          onError(error);
        }
      }
    } catch (error) {
      onError(error);
    }
  };
  // Running errands, oldest first; pushed when the set changes and to every newly attached connection (a snapshot,
  // so a reconnect never shows stale progress). A marker that is mid-rewrite or malformed is skipped this sweep.
  const report = async (names: string[]) => {
    const grouped = new Map<string,ErrandProgress[]>();
    for (const name of names.filter(name => name.endsWith('.running.json')).sort()) {
      try {
        const {principal_id,...progress}=parseErrandProgress(JSON.parse(await readFile(join(dir, name), 'utf8')));
        const running=grouped.get(principal_id)??[];running.push(progress);grouped.set(principal_id,running);
      } catch { /* incomplete or unowned markers never reach a terminal */ }
    }
    for(const principal of new Set([...principals,...grouped.keys(),...publications.keys()])) {
      const running=grouped.get(principal)??[];
      running.sort((a,b)=>a.started_at.localeCompare(b.started_at));publish(principal,running);
    }
    principals=new Set(grouped.keys());
  };
  return {
    async cancel(job_id: string): Promise<boolean> {
      if (!RUNNING_JOB.test(job_id) || !(await readdir(dir).catch(() => [] as string[])).includes(`${job_id}.running.json`)) return false;
      await writeFile(join(dir, `${job_id}.cancel`), JSON.stringify({job_id, requested_at: new Date().toISOString()}), {mode: 0o600});
      void sweep();
      return true;
    },
    /** An errand the executor runs without the main agent: one SMS (a fall alert), written atomically as `<job>.request.json`.
     *  The job id derives from `id`; the executor starts each job id once, so a repeated request never texts twice. */
    async sms({principal_id,id, to, text}: {principal_id:string;id: string; to: string; text: string}): Promise<void> {
      identifier(principal_id);
      if (!id || !/^\+?[0-9]{7,15}$/.test(to) || !text || text.length > 2000 || text.includes('\0')) throw new Error('SMS_REQUEST_INVALID');
      const job_id = `job-${digest([principal_id,id]).slice(0, 12)}`, path = join(dir, `${job_id}.request.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const deadline = Date.now() + 120_000;
      await writeFile(temporary, JSON.stringify({principal_id,job_id, title: `紧急短信：${to}`.slice(0, 40),
        kind: 'sms', to, text, deadline_ms: deadline}), {mode: 0o600});
      try {await link(temporary, path);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
      finally {await unlink(temporary);} // a replay cannot renew an undiscovered request's deadline
      // Dispatch is not send success. Results may already have been renamed by the delivery sweep.
      while (Date.now() < deadline) {
        for (const state of [pending, notified, delivered, delivery_failed, quarantined]) {
          let raw: string;
          try {raw = await readFile(join(dir, `${job_id}.${state}.json`), 'utf8');}
          catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
          const result = parseErrandResult(JSON.parse(raw));
          if (result.principal_id!==principal_id || result.job_id !== job_id || result.task !== text || result.tier !== 'deterministic' ||
              !result.success || result.terminal_reason !== 'completed') throw new Error(`SMS_NOT_VERIFIED: ${result.answer}`);
          return;
        }
        await delay(200);
      }
      throw new Error('SMS_SEND_STATE_UNKNOWN: timed out waiting for verified result; do not resend');
    },
    async start(): Promise<void> {
      await mkdir(dir, {recursive: true, mode: 0o700});
      await sweep();
      timer = setInterval(() => void sweep(), options.intervalMs ?? 2000);
      timer.unref?.();
    },
    async close(): Promise<void> {
      closed=true;publications.clear();
      if (timer) clearInterval(timer);

      await sweeping;
    },
    sweep,
    async refresh():Promise<void> {
      await sweep();await Promise.all([...publications.values()].map(state=>state.work));
      if([...publications.values()].some(state=>state.busy||state.latest))
        throw new ContractError('ERRAND_PROGRESS_PUBLICATION_PENDING',503);
    },
  };
}
