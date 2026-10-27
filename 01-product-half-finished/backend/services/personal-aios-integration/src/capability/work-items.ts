import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import type {WorkItem,WorkItemReceipt} from '../../../../../../capability/contracts/work-items.ts';
import type {ReceiptRecord} from './ledger.ts';

const schema=JSON.parse(readFileSync(new URL('../../../../../../capability/contracts/work-items.v1.schema.json',import.meta.url),'utf8'));
const valid=new Ajv({strict:true}).compile<WorkItem[]>(schema);
const terminal=(state:string)=>['succeeded','failed','cancelled'].includes(state);
/** Called exactly with receipt admission. Projection consumes qualified fields, never tool-name rules. */
export function qualifyWorkItems(body:WorkItemReceipt):WorkItemReceipt {
  if(body.work_items===undefined)return body;
  const invalid=()=>{delete body.work_items;body.status.state='unknown';body.status.reason_code='CAPABILITY_WORK_ITEMS_INVALID';
    body.unknowns.push({about:'work_items',why:'Work item schema or unique identity is invalid.'});return body;};
  if(!valid(body.work_items)||new Set(body.work_items.map(row=>row.id)).size!==body.work_items.length)return invalid();
  const effects=new Map(body.effects.flatMap(effect=>effect.ref?[[effect.ref,effect] as const]:[]));
  for(const item of body.work_items){
    const evidence=item.effect_refs.map(ref=>effects.get(ref));
    if(evidence.some(effect=>!effect)||item.state==='succeeded'&&(!evidence.length||evidence.some(effect=>effect?.verification!=='verified'))){
      item.state='unknown';body.unknowns.push({about:item.id,why:'Saved completion requires this item’s verified effect references.'});
    }
  }
  if(body.status.state==='succeeded'&&body.work_items.some(item=>item.state==='unknown'))body.status.state=body.work_items.some(item=>item.state==='succeeded')?'partial':'unknown';
  if(['partial','unknown'].includes(body.status.state))body.next.retry='after_check';return body;
}

/** Revision is per original job. Saved terminal evidence remains true when late/progress-only packets arrive. */
export function projectWorkItems(records:Pick<ReceiptRecord,'receipt'|'id'|'call_id'>[]):WorkItem[]{
  const jobs=new Map<string,Map<string,{item:WorkItem;revision:number}>>();
  for(const record of records){
    const body=record.receipt as WorkItemReceipt;if(!body.work_items)continue;
    const job=body.job?.id??record.call_id??record.id,revision=body.job?.revision??1,items=jobs.get(job)??new Map();jobs.set(job,items);
    for(const item of body.work_items){const prior=items.get(item.id);
      if(prior&&(revision<prior.revision||terminal(prior.item.state)))continue;
      items.set(item.id,{item:structuredClone(item),revision});}
  }
  const items=new Map<string,WorkItem>();
  for(const job of jobs.values())for(const {item} of job.values()){
    const prior=items.get(item.id);if(!prior||!terminal(prior.state))items.set(item.id,item);
  }
  return [...items.values()];
}

/** The existing ledger applies revision/state rules with its original history before persisting a new receipt. */
export function mergeWorkItemRevision(next:WorkItemReceipt,records:Pick<ReceiptRecord,'receipt'|'id'|'call_id'>[]):WorkItemReceipt{
  if(!next.job)return next;
  const own=records.filter(record=>record.receipt.job?.id===next.job!.id);
  const previous=projectWorkItems(own);if(!previous.length)return next;
  const items=new Map((next.work_items??[]).map(item=>[item.id,item]));let regression=false;
  for(const old of previous){const item=items.get(old.id);
    if(!item)items.set(old.id,old);
    else if(terminal(old.state)&&item.state!==old.state){items.set(old.id,old);regression=true;}
    else if(item.label!==old.label||item.slide_id!==old.slide_id||item.slide_number!==old.slide_number){items.set(old.id,{...old,state:'unknown'});regression=true;}
  }
  next.work_items=[...items.values()];
  if(regression){next.status.state='unknown';next.status.reason_code='CAPABILITY_WORK_ITEM_STATE_CONFLICT';next.next.retry='after_check';
    next.unknowns.push({about:'work_items',why:'A later packet cannot undo an already verified terminal step.'});}
  return next;
}
