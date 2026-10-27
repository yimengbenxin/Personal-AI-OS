import AjvModule from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {canonical, check, digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {unknown} from '../../../../../../capability/sdk/ts/receipt.ts';
import {ReceiptLedger, type RunBinding, type ReceiptRecord} from './ledger.ts';
import {packageCatalog, type PackageTool} from './packages.ts';
import {recordFacts, renderFacts} from './renderer.ts';

const contract = JSON.parse(readFileSync(new URL('../../../../../../capability/contracts/gateway-api.v1.json', import.meta.url), 'utf8'));
const ajv = new AjvModule.default({strict: false});
const validators = Object.fromEntries(['decide', 'receipt', 'observe'].map((operation, index) => [operation,
  ajv.compile({components: contract.components, $ref: '#/components/schemas/' + ['PreToolCall', 'TransformToolResult', 'PostToolCall'][index]})]));
export interface GatewayCall {
  tool_name: string; args: Record<string, unknown>; task_id: string; session_id: string;
  tool_call_id: string; turn_id: string; api_request_id: string|null; middleware_trace?: object[];
  result?: unknown; status?: string; duration_ms?: number; error_type?: string|null; error_message?: string|null;
  prepared?:{target?:string;task_type?:string;summary?:string;preview_items?:string[];work_items?:import('../../../../../../capability/contracts/work-items.ts').WorkItem[]};
}
export interface GatewayBinding extends RunBinding {session_id?:string; scope: string; invocation: 'interactive'|'background'|'cron'}
export type GatewayDecision = {action: 'allow'} | {action: 'modify'; args: Record<string, unknown>} |
  {action: 'block'; message: string} | {action: 'approve'; message: string; rule_key: string};
/** The platform's single consent authority, bound at composition; the gateway passes the manifest's class and target. */
export type GatewayConsent = (binding: GatewayBinding, call: GatewayCall, tool: PackageTool, effect: string, target: string) => Promise<GatewayDecision>;
const selected = (args: Record<string, unknown>, path: string|undefined): unknown =>
  path?.slice(2).split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>|undefined)?.[key], args);
/** The class a manifest declares for this call: fixed per tool, or selected by one argument. */
export function toolEffect(tool: PackageTool, args: Record<string, unknown>): string|undefined {
  if (tool.effect) return tool.effect;
  const [path, classes] = Object.entries(tool.effect_by_arg!)[0]!;
  return classes[String(selected(args, path))];
}
export function structuredResult(raw: unknown): unknown {
  if (typeof raw === 'string') {try {raw = JSON.parse(raw);} catch {return null;}}
  if (raw && typeof raw === 'object') {
    const result = raw as Record<string, unknown>;
    return result.structuredContent ?? result.structured_content ?? (result.receipt === 1 ? result :
      (Array.isArray(result.content)?result.content.filter(block=>block?.type==='text')
        .map(block=>structuredResult(block.text)).find(Boolean):null)??
      (result.result === undefined ? null : structuredResult(result.result)));
  }
  return null;
}
/** Authenticated hook trust boundary. Admission remains the sole principal, scope and run authority. */
export class CapabilityGateway {
  readonly ledger: ReceiptLedger;
  readonly tools: Map<string, PackageTool>;
  private readonly consent: GatewayConsent;
  constructor(storage: StoragePort, consent: GatewayConsent, tools: Map<string, PackageTool> = packageCatalog()) {
    this.ledger = new ReceiptLedger(storage);this.tools=tools;this.consent=consent;
  }
  validate(operation: string, body: unknown): asserts body is GatewayCall {
    check(validators[operation]?.(body), 'CAPABILITY_GATEWAY_REQUEST_INVALID');
  }
  resolve(name:string):{identity:string;tool:PackageTool}|undefined {
    const direct=this.tools.get(name);
    if(direct)return {identity:name,tool:direct};
    for(const [identity,tool] of this.tools)if(tool.aliases?.includes(name))return {identity,tool};
  }
  catalog() {return {tools: [...new Set([...this.tools].flatMap(([name,tool])=>[name,...tool.aliases??[]]))]};}
  invocation(call:GatewayCall,tool:PackageTool){
    const args={...call.args};
    for(const key of [...tool.context_inject??[],'owner_requested'])delete args[key];
    return digest([this.resolve(call.tool_name)?.identity??call.tool_name,args]);
  }
  private operationId(binding:RunBinding,row:ReceiptRecord){
    return digest([binding.principal_id,row.origin_run??binding.run_id,row.task_id,row.tool_call_id]);
  }
  /** A declared check may name an original operation; an unambiguous pending operation needs no model guess. */
  async checkFor(binding:GatewayBinding,call:GatewayCall):Promise<string>{
    const {tool}=this.resolve(call.tool_name)!;
    const candidates=(await this.ledger.current(binding)).filter(row=>{
      const original=this.resolve(row.tool)?.tool;
      return original?.package===tool.package&&row.receipt.effects.some(effect=>effect.kind!=='observe')&&
        row.receipt.next.retry==='after_check'&&row.receipt.next.check_with===tool.name;
    });
    const requested=call.args.check_for;
    const original=requested?candidates.find(row=>this.operationId(binding,row)===requested):candidates.length===1?candidates[0]:undefined;
    check(!requested||original,'CAPABILITY_CHECK_BINDING_REQUIRED',403);
    return original?this.operationId(binding,original):'';
  }
  async decide(binding: GatewayBinding, call: GatewayCall): Promise<GatewayDecision> {
    const tool = this.resolve(call.tool_name)?.tool;
    if (!tool) return {action: 'allow'};
    if (!tool.scopes.includes(binding.scope)||tool.principal_id&&tool.principal_id!==binding.principal_id) return {action: 'block', message: '当前运行范围不能使用这项能力。'};
    const effect = toolEffect(tool, call.args);
    if (!effect) return {action: 'block', message: 'CAPABILITY_EFFECT_UNRESOLVED'};
    const rows=await this.ledger.records(binding),current=await this.ledger.current(binding);
    const latest=(row:ReceiptRecord)=>current.find(candidate=>row.receipt.job?
      candidate.receipt.job?.id===row.receipt.job.id:(candidate.call_id??candidate.id)===(row.call_id??row.id))??row;
    const prior = rows.find(record => record.invocation === this.invocation(call,tool) &&
      latest(record).receipt.status.state === 'succeeded' && latest(record).receipt.next.retry === 'forbidden' &&
      latest(record).receipt.effects.some(effect => effect.kind !== 'observe'));
    if (prior) return {action: 'block', message: '这项操作已经成功，无需重复执行。'};
    const uncertain=rows.findLast(record=>record.invocation===this.invocation(call,tool)&&latest(record).receipt.next.retry==='after_check');
    if(uncertain&&effect!=='observe'){
      const outcome=latest(uncertain),checker=[...this.tools.values()].find(candidate=>candidate.package===tool.package&&candidate.name===outcome.receipt.next.check_with);
      const explicit=checker?.context_inject?.includes('check_for'),expected=explicit?this.operationId(binding,uncertain):outcome.receipt.job?.id??
        (tool.context_inject?.includes('idempotency_key')?digest([binding.principal_id,uncertain.origin_run??binding.run_id,
          uncertain.task_id,uncertain.tool_call_id]):uncertain.target);
      const checks=rows.slice(rows.findIndex(row=>row.id===outcome.id)+1).filter(record=>{
        const checked=this.resolve(record.tool)?.tool;
        return checked?.package===tool.package&&checked.name===outcome.receipt.next.check_with&&
          record.receipt.status.state==='succeeded'&&expected!==undefined&&record.check_for===expected;
      });
      const targets=outcome.receipt.effects.filter(effect=>effect.kind!=='observe').map(effect=>effect.target);
      const reconciled=explicit?targets.length>0&&targets.every(target=>checks.some(record=>record.receipt.effects.some(proof=>
        proof.kind==='observe'&&proof.target===target&&proof.ref===expected&&['verified','service_ack'].includes(proof.verification)))):checks.length>0;
      if(!reconciled)
        return {action:'block',message:'需要先核查结果，再决定是否重试。'};
    }
    if (effect === 'observe' || effect === 'workspace') return {action: 'allow'};
    const target = selected(call.args, tool.target);
    return this.consent(binding, call, tool, effect, typeof target === 'string' && target ? target : tool.name);
  }
  async receipt(binding: GatewayBinding, call: GatewayCall) {
    const pending=(await this.ledger.current(binding)).find(row=>row.call_id===digest([call.task_id,call.tool_call_id])&&row.phase);
    if(pending){
      check(pending.tool===(this.resolve(call.tool_name)?.identity??call.tool_name),'CAPABILITY_RECEIPT_REPLAY_CONFLICT',409);
      return this.view(binding,pending);
    }
    const resolved=this.resolve(call.tool_name);check(resolved, 'CAPABILITY_TOOL_NOT_ENABLED', 404);
    const {tool,identity}=resolved;
    check(tool.scopes.includes(binding.scope), 'CAPABILITY_SCOPE_DENIED', 403);
    check(!tool.principal_id||tool.principal_id===binding.principal_id,'CAPABILITY_SCOPE_DENIED',403);
    const raw = structuredResult(call.result) ?? unknown({status: {reason_code: 'CAPABILITY_RESULT_UNAVAILABLE'},
      unknowns: [{about: '执行结果', why: '未取得有效回执'}]});
    const target=selected(call.args,tool.target),checkFor=call.args.check_for??call.args.job_id??call.args.idempotency_key??target;
    const record = await this.ledger.admit(binding, {...call,tool_name:identity,package:tool.package,
      ...(typeof target==='string'?{target}:{}),
      ...(toolEffect(tool,call.args)==='observe'&&typeof checkFor==='string'?{check_for:checkFor}:{}),
      ...(tool.version_digest?{version_digest:tool.version_digest}:{}),invocation:this.invocation(call,tool)}, raw);
    return this.view(binding,record);
  }
  private async view(binding:GatewayBinding,record:ReceiptRecord){
    const facts = await this.ledger.novel(binding.principal_id, recordFacts([record],binding.run_id));
    return {model_view: renderFacts(facts, 'text') + '\n' + canonical(record.receipt)};
  }
  async observe(binding: GatewayBinding, call: GatewayCall) {
    check(this.resolve(call.tool_name), 'CAPABILITY_TOOL_NOT_ENABLED', 404);
    await this.ledger.observe(binding, digest([call.task_id, call.tool_call_id]),
      {task_id: call.task_id, tool_call_id: call.tool_call_id, status: call.status, duration_ms: call.duration_ms,
        error_type: call.error_type, error_message: call.error_message});
  }
}
/** Pending work first; uncertain outcomes outrank failures, then mixed terminal outcomes are partial. */
export function aggregateReceipts(records: Pick<ReceiptRecord, 'receipt'>[]): 'running'|'waiting'|'unknown'|'partial'|'failed'|'cancelled'|'succeeded' {
  const states = records.map(record => record.receipt.status.state);
  if (states.some(state => state === 'running' || state === 'accepted')) return 'running';
  if (states.includes('waiting')) return 'waiting';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('partial') || new Set(states.map(state => state === 'rejected' ? 'failed' : state)).size > 1) return 'partial';
  if (states.some(state => state === 'failed' || state === 'rejected')) return 'failed';
  if (states.includes('cancelled')) return 'cancelled';
  return 'succeeded';
}
