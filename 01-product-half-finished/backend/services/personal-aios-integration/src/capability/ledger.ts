import {mergeWorkItemRevision} from './work-items.ts';
import type {WorkItemReceipt} from '../../../../../../capability/contracts/work-items.ts';
import {canonical, check, digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {admitReceipt} from './receipt.ts';
import type {Receipt} from '../../../../../../capability/sdk/ts/receipt.ts';

export interface RunBinding {principal_id: string; run_id: string}
export interface ReceiptRecord {
  id: string; task_id: string; tool_call_id: string; tool: string; invocation: string;
  fingerprint: string; receipt: WorkItemReceipt;
  call_id?:string; phase?:'waiting'|'result'; origin_run?:string;
  package?:string; version_digest?:string;
  target?:string;check_for?:string;
}
interface RunLedger {receipts: ReceiptRecord[]; observations: Record<string, unknown>;principal_id?:string}
export interface Fact {
  id: string; kind: string; text: string; voice: string;
  labels?: string[]; state?: Receipt['status']['state']; value?: Receipt['values'][number];
  summary?:boolean; quantities?:{value:number;unit:string}[];
}
const namespace = 'capability-ledger';
/** One durable store. Per-run snapshots record returns; per-principal delivery sets record told facts. */
export class ReceiptLedger {
  private writes = new Map<string, Promise<unknown>>();
  private storage: StoragePort;
  constructor(storage: StoragePort) {this.storage = storage;}
  private runKey(binding: RunBinding) {return digest({kind: 'run', principal_id:binding.principal_id, run_id:binding.run_id});}
  private async read<T>(key: string, empty: T): Promise<T> {
    try {return JSON.parse(Buffer.from(await this.storage.read(namespace, key)).toString());}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error;}
  }
  private async write<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work); this.writes.set(key, next);
    try {return await next;} finally {if (this.writes.get(key) === next) this.writes.delete(key);}
  }
  async records(binding: RunBinding): Promise<ReceiptRecord[]> {
    return (await this.read<RunLedger>(this.runKey(binding), {receipts: [], observations: {}})).receipts;
  }
  async current(binding:RunBinding):Promise<ReceiptRecord[]>{
    const rows=await this.records(binding);
    const latest=new Map<string,ReceiptRecord>();
    for(const row of rows){
      const key=row.receipt.job?`job:${row.receipt.job.id}`:row.call_id??row.id,prior=latest.get(key);
      if(prior?.receipt.job&&row.receipt.job&&prior.receipt.job.revision>row.receipt.job.revision)continue;
      if(prior?.phase==='result'&&row.phase==='waiting')continue;
      latest.set(key,row);
    }
    return [...latest.values()];
  }
  async admit(binding: RunBinding, call: {task_id: string; tool_call_id: string; tool_name: string; args: object;
    phase?:'waiting'|'result';package?:string;version_digest?:string;invocation?:string;target?:string;check_for?:string}, raw: unknown): Promise<ReceiptRecord> {
    const key = this.runKey(binding), fingerprint = digest(raw);
    return this.write(key, async () => {
      const run = await this.read<RunLedger>(key, {receipts: [], observations: {}});
      const logicalId=digest([call.task_id,call.tool_call_id]);
      const callId = call.phase?digest([logicalId,call.phase]):logicalId;
      const prior = run.receipts.find(record => record.id === callId);
      if (prior) {check(prior.fingerprint === fingerprint, 'CAPABILITY_RECEIPT_REPLAY_CONFLICT', 409); return prior;}
      const record:ReceiptRecord = {id: callId, task_id: call.task_id, tool_call_id: call.tool_call_id,
        tool: call.tool_name, invocation: call.invocation??digest([call.tool_name, call.args]), fingerprint, receipt: mergeWorkItemRevision(admitReceipt(raw),run.receipts),
        call_id:logicalId,origin_run:binding.run_id,...(call.phase?{phase:call.phase}:{}),
        ...(call.package?{package:call.package}:{}),...(call.version_digest?{version_digest:call.version_digest}:{})};
      if(call.target)record.target=call.target;
      if(call.check_for)record.check_for=call.check_for;
      run.receipts.push(record);
      run.principal_id=binding.principal_id;
      await this.storage.replace!(namespace, key, Buffer.from(canonical(run)));
      return record;
    });
  }
  /** Carry admitted identities, including their original fact scope, through the same ledger. */
  async carry(binding:RunBinding,records:ReceiptRecord[]):Promise<void>{
    const key=this.runKey(binding);
    await this.write(key,async()=>{
      const run=await this.read<RunLedger>(key,{receipts:[],observations:{}});
      run.principal_id=binding.principal_id;
      for(const record of records)if(!run.receipts.some(row=>row.id===record.id))run.receipts.push(record);
      await this.storage.replace!(namespace,key,Buffer.from(canonical(run)));
    });
  }
  async outcomes(principal:string,name:string,version:string){
    const records=new Map<string,ReceiptRecord>();
    for(const key of await this.storage.list(namespace)){
      const run=await this.read<Partial<RunLedger>&{principal_id?:string}>(key,{});
      if(run.principal_id!==principal)continue;
      for(const row of run.receipts??[])if(row.package===name&&row.version_digest===version)records.set(row.call_id??row.id,row);
    }
    const rows=[...records.values()].filter(row=>!['accepted','running','waiting'].includes(row.receipt.status.state));
    return {total:rows.length,failed:rows.filter(row=>['failed','rejected'].includes(row.receipt.status.state)).length,
      unknown:rows.filter(row=>row.receipt.status.state==='unknown').length};
  }
  async referenced(principal:string,ref:string):Promise<ReceiptRecord[]>{
    for(const key of await this.storage.list(namespace)){
      const run=await this.read<Partial<RunLedger>>(key,{});
      if(run.principal_id===principal){const row=run.receipts?.find(record=>record.id===ref);if(row)return [row];}
    }
    return [];
  }
  async observe(binding: RunBinding, callId: string, value: unknown): Promise<void> {
    const key = this.runKey(binding);
    await this.write(key, async () => {
      const run = await this.read<RunLedger>(key, {receipts: [], observations: {}});
      run.observations[callId] = value;
      await this.storage.replace!(namespace, key, Buffer.from(canonical(run)));
    });
  }
  /** Freeze a source event's timestamp beside the admitted job, before the existing scheduler consumes it. */
  async source<T>(binding:RunBinding,id:string,value:T):Promise<T>{
    const key=this.runKey(binding);
    return this.write(key,async()=>{
      const run=await this.read<RunLedger>(key,{receipts:[],observations:{}});
      run.observations[id]??=value;
      await this.storage.replace!(namespace,key,Buffer.from(canonical(run)));
      return run.observations[id] as T;
    });
  }
  async novel(principal: string, facts: Fact[]): Promise<Fact[]> {
    const told = await this.read<Record<string, string>>(digest({kind: 'told', principal}), {});
    return facts.filter(fact => !told[fact.id]);
  }
  /** Called only after OUT validates a device rendered/played ACK for the carrying reply. */
  async delivered(principal: string, facts: string[], acknowledgement: string): Promise<void> {
    const key = digest({kind: 'told', principal});
    await this.write(key, async () => {
      const told = await this.read<Record<string, string>>(key, {});
      for (const fact of facts) told[fact] ??= acknowledgement;
      await this.storage.replace!(namespace, key, Buffer.from(canonical(told)));
    });
  }
}
