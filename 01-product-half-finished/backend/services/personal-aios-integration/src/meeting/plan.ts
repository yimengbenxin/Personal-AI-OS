import {canonical,check,digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {TextPlan} from '../../../../../../capability/contracts/presentation.ts';
import {textPlanHash,validateTextPlan} from '../presentation-validate.ts';
import type {MeetingWorkspace,SnapshotRecord,PageRecord} from './ports.ts';

export interface MeetingSuggestion {
  id:string;scope_session_id:string;utterance_id:string;snapshot_ref?:string;page_ref?:string;slide_id:string;element_id:string;
  agreement:'agreed';op:'replace_text'|'append_paragraph';after_text:string;basis_refs:string[];
}
export async function readMeeting<T>(storage:StoragePort,space:string,principal:string,id:string):Promise<T>{
  try{return JSON.parse(Buffer.from(await storage.read(space,digest([principal,id]))).toString()) as T;}
  catch(error){if((error as {code?:string}).code==='ENOENT')throw Object.assign(Error('MEETING_REFERENCE_NOT_FOUND'),{code:'MEETING_REFERENCE_NOT_FOUND'});throw error;}
}
export async function publishMeeting<T>(storage:StoragePort,space:string,principal:string,id:string,value:T):Promise<T>{
  const saved=JSON.parse(Buffer.from(await storage.publish(space,digest([principal,id]),Buffer.from(canonical(value)))).toString()) as T;
  check(canonical(saved)===canonical(value),'MEETING_IMMUTABLE_CONFLICT',409);return saved;
}
/** Pure text only, using each suggestion's original page and before-image, never the latest page. */
export async function meetingPlan(storage:StoragePort,workspace:MeetingWorkspace,ids:string[],baseRef:string):Promise<TextPlan>{
  const base=await readMeeting<SnapshotRecord>(storage,'meeting-snapshots',workspace.principal_id,baseRef);
  check(base.scope_session_id===workspace.scope_session_id,'MEETING_SNAPSHOT_SCOPE_MISMATCH',403);
  const edits=[] as TextPlan['edits'],previews:string[]=[];
  for(const id of ids){
    const suggestion=await readMeeting<MeetingSuggestion>(storage,'meeting-suggestions',workspace.principal_id,id);
    const source=suggestion.page_ref?
      await readMeeting<PageRecord>(storage,'meeting-pages',workspace.principal_id,suggestion.page_ref):
      await readMeeting<SnapshotRecord>(storage,'meeting-snapshots',workspace.principal_id,suggestion.snapshot_ref!);
    const page='page' in source?source.page:source.snapshot;
    check(suggestion.scope_session_id===workspace.scope_session_id&&source.scope_session_id===workspace.scope_session_id&&
      canonical(page.target)===canonical(workspace.target)&&page.deck_revision===base.snapshot.deck_revision&&
      suggestion.agreement==='agreed','MEETING_SUGGESTION_SCOPE_MISMATCH',409);
    const element=page.elements.find(item=>item.element_id===suggestion.element_id);
    check(element&&suggestion.slide_id===page.slide_id,'MEETING_ELEMENT_NOT_FOUND');
    check(suggestion.op==='replace_text'||suggestion.op==='append_paragraph'&&suggestion.after_text.startsWith(element.text+'\n')&&
      suggestion.after_text.slice(element.text.length).trim().length>0,'MEETING_TEXT_OPERATION_INVALID');
    edits.push({work_item_id:`item:${digest([workspace.scope_session_id,id])}`,slide_id:page.slide_id,slide_number:page.slide_number,
      element_id:element.element_id,op:suggestion.op,before_text_sha256:element.text_sha256,after_text:suggestion.after_text,basis_refs:suggestion.basis_refs});
    previews.push(`第 ${page.slide_number} 页：${suggestion.after_text}`.slice(0,240));
  }
  const body={version:1 as const,plan_id:`plan:${digest([workspace.scope_session_id,baseRef,ids])}`,revision:1,target:workspace.target,
    scope_session_id:workspace.scope_session_id,base_deck_revision:base.snapshot.deck_revision,workflow:'local_review_then_project' as const,edits,preview_items:previews};
  const plan={...body,plan_sha256:textPlanHash(body)};validateTextPlan(plan);
  return publishMeeting(storage,'meeting-plans',workspace.principal_id,plan.plan_id,plan);
}
