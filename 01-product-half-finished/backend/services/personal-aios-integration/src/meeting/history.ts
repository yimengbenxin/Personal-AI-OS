import type {StoragePort} from '../storage.ts';
import type {ReceiptLedger,ReceiptRecord} from '../capability/ledger.ts';
import type {ScopeRunBinding} from '../../../../../../capability/contracts/scope-grant.ts';

/** Original admitted receipt identities, bounded to the same principal and ended-or-live scope. No new facts. */
export async function meetingRuns(storage:StoragePort,principal:string,scope:string){
  const rows:ScopeRunBinding[]=[];
  for(const key of await storage.list('scope-run-bindings')){
    const row=JSON.parse(Buffer.from(await storage.read('scope-run-bindings',key)).toString()) as ScopeRunBinding;
    if(row.principal_id===principal&&row.scope_session_id===scope)rows.push(row);
  }
  return rows;
}
export async function carryMeetingReceipts(storage:StoragePort,ledger:ReceiptLedger,principal:string,scope:string,run:string){
  const records=new Map<string,ReceiptRecord>();
  for(const binding of await meetingRuns(storage,principal,scope)){
    if(binding.run_id===run)continue;
    for(const row of await ledger.current(binding))records.set(row.id,row);
  }
  await ledger.carry({principal_id:principal,run_id:run},[...records.values()]);
}
