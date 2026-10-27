import {canonical,check,digest,sha256} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {ScopeGrants} from '../capability/consent/scope-decision.ts';
import type {MeetingObservations,MeetingFrame} from './observations.ts';
import {MeetingExecution} from './execution.ts';
import {validateMeetingCall,type MeetingContext,type MeetingPorts,type MeetingSelection,type MeetingTool,type MeetingWorkspace,type SnapshotRecord} from './ports.ts';
import {meetingPlan,publishMeeting,readMeeting} from './plan.ts';
import {locateMeetingRegion} from './pointing.ts';
import {meetingPages} from './pages.ts';
import {validatePresentationInput,validateSlideSnapshot} from '../presentation-validate.ts';
import type {PresentationResult,TextPlan} from '../../../../../../capability/contracts/presentation.ts';
import {succeeded,to_mcp_result} from '../../../../../../capability/sdk/ts/receipt.ts';

export class MeetingSession {
  readonly execution:MeetingExecution;readonly observations:MeetingObservations;
  private readonly storage:StoragePort;private readonly ports:MeetingPorts;private readonly now:()=>number;
  private ticking:Promise<void>|undefined;private closed=false;
  private readonly discussing=new Map<string,Promise<void>>();
  private readonly images=new Map<string,{principal:string;bytes:Buffer;expires:number}>();
  constructor(storage:StoragePort,scopes:ScopeGrants,observations:MeetingObservations,ports:MeetingPorts,now=Date.now){
    this.storage=storage;this.observations=observations;this.ports=ports;this.now=now;this.execution=new MeetingExecution(storage,scopes,observations,ports,now);
  }
  async select(principal:string,device:string,glasses:string,selection:MeetingSelection){
    validatePresentationInput('presentation_snapshot',{target:selection.target,shared_window_id:selection.shared_window_id},{principal_id:principal,target_device_id:device},this.now());
    const scope_session_id=`meeting:${digest([principal,selection.target.target_id,selection.origin_processed_event_id])}`;
    await this.observations.open({id:scope_session_id,principal_id:principal,target_id:selection.target.target_id,target_device_id:device,glasses_device_id:glasses});
    const workspace:MeetingWorkspace={...structuredClone(selection),principal_id:principal,scope_session_id,glasses_device_id:glasses};
    const prior=await this.observations.scopes.store.read<MeetingWorkspace>('meeting-workspaces',digest([principal,scope_session_id]));
    if(prior){check(canonical({...prior,shared_window_id:workspace.shared_window_id})===canonical(workspace),'MEETING_SELECTION_CONFLICT',409);check(this.storage.replace,'MEETING_STORAGE_REQUIRED');
      await this.storage.replace('meeting-workspaces',digest([principal,scope_session_id]),Buffer.from(canonical(workspace)));}
    else await publishMeeting(this.storage,'meeting-workspaces',principal,scope_session_id,workspace);
    check(this.storage.replace,'MEETING_STORAGE_REQUIRED');await this.storage.replace('meeting-targets',digest([principal,workspace.target.target_id]),Buffer.from(canonical({scope_session_id})));return workspace;
  }
  async workspace(principal:string,target:string){
    const pointer=await this.observations.scopes.store.read<{scope_session_id:string}>('meeting-targets',digest([principal,target]));
    check(pointer,'MEETING_SESSION_NOT_FOUND',404);return this.workspaceById(principal,pointer.scope_session_id);
  }
  async workspaceById(principal:string,id:string){return readMeeting<MeetingWorkspace>(this.storage,'meeting-workspaces',principal,id);}
  async bind(principal:string,workspace:MeetingWorkspace,context:MeetingContext){
    const existing=await this.observations.scopes.store.binding(context);
    if(existing){check(existing.principal_id===principal&&existing.scope_session_id===workspace.scope_session_id,'MEETING_RUN_SCOPE_MISMATCH',403);return;}
    await this.observations.bindRun(principal,workspace.scope_session_id,context);
  }
  async prepare(principal:string,context:MeetingContext,tool:MeetingTool,args:Record<string,unknown>){
    validateMeetingCall(tool,args);const workspace=await this.workspace(principal,String(args.target_id));
    const pending=await this.execution.pending(workspace);if(pending){const checked=await this.execution.status(workspace,pending.key);
      check(['succeeded','failed','cancelled'].includes(checked.structuredContent.status.state),'MEETING_RECONCILE_REQUIRED',409);}
    if(tool!=='edit_status')await this.bind(principal,workspace,context);
    if(tool!=='apply_text')return {args};
    const plan=await readMeeting<TextPlan>(this.storage,'meeting-plans',principal,String(args.plan_id));
    check(plan.scope_session_id===workspace.scope_session_id&&plan.plan_sha256===args.plan_sha256,'MEETING_PLAN_HASH_MISMATCH',409);
    return {args,consent:{target:workspace.target.target_id,task_type:'document.text.update',summary:`修改 ${workspace.target.display_name} 的文字`,preview_items:plan.preview_items,work_items:plan.edits.map((edit,index)=>({id:edit.work_item_id,label:plan.preview_items[index]!,state:'waiting' as const,effect_refs:[],slide_id:edit.slide_id,slide_number:edit.slide_number}))}};
  }
  async call(principal:string,context:MeetingContext,tool:MeetingTool,args:Record<string,unknown>):Promise<PresentationResult>{
    validateMeetingCall(tool,args);check(canonical(args.context)===canonical(context),'MEETING_CONTEXT_MISMATCH',403);
    const workspace=await this.workspace(principal,String(args.target_id));
    if(tool==='edit_status')return this.execution.status(workspace,String(args.idempotency_key??String(args.operation_id).slice(3)));
    const pending=await this.execution.pending(workspace);if(pending)return this.execution.status(workspace,pending.key);
    await this.observations.guard(principal,workspace.scope_session_id);await this.bind(principal,workspace,context);
    if(tool==='read_deck'){
      const result=await this.ports.invoke({principal_id:principal,target_device_id:workspace.target.target_device_id},'presentation_snapshot',
        {target:workspace.target,shared_window_id:workspace.shared_window_id},this.observations.signal(workspace.scope_session_id));
      if(result.structuredContent.status.state!=='succeeded')return result;
      const snapshot=JSON.parse(result.structuredContent.content.find(row=>row.key==='slide_snapshot')!.text);validateSlideSnapshot(snapshot);
      check(canonical(snapshot.target)===canonical(workspace.target),'MEETING_TARGET_MISMATCH',403);
      const ref=`snapshot:${digest([workspace.scope_session_id,snapshot])}`;
      await publishMeeting(this.storage,'meeting-snapshots',principal,ref,{ref,principal_id:principal,scope_session_id:workspace.scope_session_id,snapshot});
      const pages=await meetingPages(this.storage,workspace,{ref,principal_id:principal,scope_session_id:workspace.scope_session_id,snapshot},result);
      if(snapshot.image){const image=result.content.find(block=>block.type==='image');check(image?.type==='image'&&sha256(Buffer.from(image.data,'base64'))===snapshot.image.sha256,'MEETING_IMAGE_MISMATCH');
        for(const [key,row] of this.images)if(this.now()>=row.expires)this.images.delete(key);
        this.images.set(snapshot.image.image_ref,{principal,bytes:Buffer.from(image.data,'base64'),expires:Date.parse(snapshot.image.expires_at)});}
      return {...result,structuredContent:{...result.structuredContent,content:[...result.structuredContent.content,
        {key:'snapshot_ref',text:ref,provenance:'observed'},
        {key:'meeting_words',text:canonical(await this.observations.words(principal,workspace.scope_session_id)),provenance:'observed'},
        {key:'meeting_frames',text:canonical((await this.observations.frames(principal,workspace.scope_session_id)).filter(frame=>this.now()-Date.parse(frame.captured_at)<=30000)),provenance:'observed'},
        {key:'meeting_pages',text:canonical(pages.map(row=>({page_ref:row.ref,slide_id:row.page.slide_id,slide_number:row.page.slide_number,source:row.page.source}))),provenance:'observed'},
        {key:'meeting_snapshots',text:canonical(await this.recentSnapshots(workspace)),provenance:'observed'}]}};
    }
    if(tool==='locate_region'){
      const word=(await this.observations.words(principal,workspace.scope_session_id)).find(row=>row.utterance_id===args.utterance_id);check(word,'MEETING_UTTERANCE_NOT_FOUND',404);
      const record=await readMeeting<SnapshotRecord>(this.storage,'meeting-snapshots',principal,String(args.snapshot_ref));
      const frames=await Promise.all((args.frame_refs as string[]).map(ref=>readMeeting<MeetingFrame>(this.storage,'meeting-frames',principal,ref)));
      const image=record.snapshot.image&&this.images.get(record.snapshot.image.image_ref);check(image&&image.principal===principal&&this.now()<image.expires,'MEETING_IMAGE_EXPIRED',409);
      return locateMeetingRegion(this.storage,this.ports,workspace,context,word,record,frames,image.bytes,this.observations.signal(workspace.scope_session_id),this.now());
    }
    if(tool==='plan_text'){
      const plan=await meetingPlan(this.storage,workspace,args.suggestion_ids as string[],String(args.base_snapshot_ref));
      return to_mcp_result(succeeded({content:[{key:'text_plan',text:canonical(plan),provenance:'inferred'}]})) as unknown as PresentationResult;
    }
    return this.execution.apply(workspace,context,String(args.plan_id),String(args.plan_sha256),String(args.idempotency_key));
  }
  private async recentSnapshots(workspace:MeetingWorkspace){const rows:SnapshotRecord[]=[];for(const key of await this.storage.list('meeting-snapshots')){
    const row=JSON.parse(Buffer.from(await this.storage.read('meeting-snapshots',key)).toString()) as SnapshotRecord;
    if(row.principal_id===workspace.principal_id&&row.scope_session_id===workspace.scope_session_id&&this.now()-Date.parse(row.snapshot.captured_at)<=30000)rows.push(row);}
    return rows.map(row=>({snapshot_ref:row.ref,captured_at:row.snapshot.captured_at,slide_id:row.snapshot.slide_id,slide_number:row.snapshot.slide_number}));}
  tick():Promise<void>{if(this.closed)return Promise.resolve();return this.ticking??=this.poll().finally(()=>{this.ticking=undefined;});}
  async close(){this.closed=true;this.images.clear();await this.ticking;}
  private async poll(){for(const key of await this.storage.list('meeting-workspaces')){
    const workspace=JSON.parse(Buffer.from(await this.storage.read('meeting-workspaces',key)).toString()) as MeetingWorkspace;
    try{await this.observations.guard(workspace.principal_id,workspace.scope_session_id);}catch(error){
      await this.ports.capture?.(workspace,false);if(!['MEETING_CONNECTION_REQUIRED','MEETING_SESSION_ENDED'].includes((error as {code:string}).code))throw error;continue;}
    await this.ports.capture?.(workspace,true);
    const pending=await this.execution.pending(workspace);if(pending){await this.execution.status(workspace,pending.key);continue;}
    const result=await this.ports.invoke({principal_id:workspace.principal_id,target_device_id:workspace.target.target_device_id},'presentation_snapshot',
      {target:workspace.target,shared_window_id:workspace.shared_window_id},this.observations.signal(workspace.scope_session_id));
    if(result.structuredContent.status.state!=='succeeded')continue;
    const snapshot=JSON.parse(result.structuredContent.content.find(row=>row.key==='slide_snapshot')!.text);validateSlideSnapshot(snapshot);
    check(canonical(snapshot.target)===canonical(workspace.target),'MEETING_TARGET_MISMATCH',403);
    const ref=`snapshot:${digest([workspace.scope_session_id,snapshot])}`;await publishMeeting(this.storage,'meeting-snapshots',workspace.principal_id,ref,{ref,principal_id:workspace.principal_id,scope_session_id:workspace.scope_session_id,snapshot});
    await meetingPages(this.storage,workspace,{ref,principal_id:workspace.principal_id,scope_session_id:workspace.scope_session_id,snapshot},result);
    if(snapshot.image){const image=result.content.find(block=>block.type==='image');if(image?.type==='image'&&sha256(Buffer.from(image.data,'base64'))===snapshot.image.sha256){
      for(const [key,row] of this.images)if(this.now()>=row.expires)this.images.delete(key);
      this.images.set(snapshot.image.image_ref,{principal:workspace.principal_id,bytes:Buffer.from(image.data,'base64'),expires:Date.parse(snapshot.image.expires_at)});}}
    await this.discussed(workspace.principal_id,workspace.scope_session_id);
  }}
  async discussed(principal:string,id:string):Promise<void>{
    const prior=this.discussing.get(id);if(prior)return prior;
    const next=this.discuss(principal,id).finally(()=>{this.discussing.delete(id);});this.discussing.set(id,next);return next;
  }
  private async discuss(principal:string,id:string){const workspace=await this.workspaceById(principal,id);
    // Late meeting audio is consumed privately even after end; it must not fail the continuous audio consumer.
    try{await this.observations.guard(principal,id);}catch(error){
      if(['MEETING_CONNECTION_REQUIRED','MEETING_SESSION_ENDED'].includes((error as {code:string}).code))return;throw error;}
    if(await this.execution.pending(workspace))return;
    for(const word of await this.observations.words(principal,id)){
      const key=digest([principal,word.utterance_id]);if(await this.observations.scopes.store.read('meeting-discussed',key))continue;
      if(this.ports.canDiscuss&&!await this.ports.canDiscuss(workspace))return;
      check(this.ports.discuss,'MEETING_TASK_INPUT_UNAVAILABLE',503);await this.ports.discuss(workspace,word);await this.storage.publish('meeting-discussed',key,Buffer.from(canonical({utterance_id:word.utterance_id})));
    }
  }
}
