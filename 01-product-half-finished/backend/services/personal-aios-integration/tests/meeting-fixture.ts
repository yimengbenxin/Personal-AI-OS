import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {scopeFixture} from './scope-grant-fixture.ts';
import {canonical,digest,sha256,type ProcessedEvent} from '../src/contracts.ts';
import {MeetingObservations} from '../src/meeting/observations.ts';
import {MeetingSession} from '../src/meeting/session.ts';
import type {MeetingPorts,MeetingTool} from '../src/meeting/ports.ts';
import {nativeApprovalId} from '../src/voiceprint/confirmation.ts';
import {succeeded,unknown,effect,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import type {PresentationResult,SlideSnapshot,TextPlan} from '../../../../../capability/contracts/presentation.ts';

export async function meetingFixture(t:TestContext,options:{word?:string;ports?:Partial<MeetingPorts>}={}){
  const f=await scopeFixture(t),observations=new MeetingObservations(f.storage,f.authority,f.now);
  const snapshot=structuredClone(JSON.parse(readFileSync(new URL('../../../../../capability/packages/meeting-assistant/tests/demo.json',import.meta.url),'utf8')).snapshot) as SlideSnapshot;
  const target=snapshot.target,context={run_id:'run:meeting',session_id:'session:meeting',tool_call_id:'call:meeting'};
  const image=Buffer.from('fixture-jpeg');snapshot.image!.sha256=sha256(image);snapshot.image!.expires_at=new Date(f.now()+60000).toISOString();
  const actions:string[]=[];let writes=0,disconnect=false,aborted=false;
  let service:MeetingSession;
  const ports:MeetingPorts={invoke:async(binding,action,args,signal)=>{
    assert.equal(binding.principal_id,'owner');assert.equal(binding.target_device_id,target.target_device_id);actions.push(action);
    if(action==='presentation_snapshot')return {...to_mcp_result(succeeded({content:[{key:'slide_snapshot',text:canonical(snapshot),provenance:'observed'}]})),
      content:[{type:'image',mimeType:'image/jpeg',data:image.toString('base64')}]} as PresentationResult;
    if(action==='presentation_edit_status')return to_mcp_result(unknown({next:{retry:'after_check',check_with:'edit_status'}})) as unknown as PresentationResult;
    writes++;
    if(disconnect){observations.disconnected('owner','mac:demo');await observations.sweep();aborted=signal.aborted;throw Error('demo disconnect after native claim');}
    const {plan,idempotency_key}=args as {plan:TextPlan;idempotency_key:string};
    const at=new Date(f.now()).toISOString(),effects=plan.edits.map(edit=>effect('owner_data',target.target_id,'文字更新','verified','保存与回读',`audit:${edit.work_item_id}`));
    const items=plan.edits.map((edit,i)=>({id:edit.work_item_id,label:plan.preview_items[i]!,state:'succeeded' as const,effect_refs:[effects[i]!.ref!],slide_id:edit.slide_id,slide_number:edit.slide_number}));
    const result={version:1,operation_id:`op:${idempotency_key}`,target,plan_sha256:plan.plan_sha256,revision:1,items,
      checks:plan.edits.map((edit,i)=>({work_item_id:edit.work_item_id,before_text_sha256:edit.before_text_sha256,after_text_sha256:sha256(edit.after_text),saved_at:at,read_back_at:at,evidence_ref:effects[i]!.ref!})),
      file_sha256:'a'.repeat(64),saved_at:at,review_status:'awaiting_owner'};
    return to_mcp_result(({...succeeded({job:{id:result.operation_id,revision:1},effects,content:[{key:'edit_result',text:canonical(result),provenance:'observed'}]}),work_items:items}) as import('../../../../../capability/contracts/work-items.ts').WorkItemReceipt) as unknown as PresentationResult;
  },frame:async()=>image,contactSheet:async()=>image,vision:async()=>JSON.stringify({state:'matched',slide_id:snapshot.slide_id,
    element_id:snapshot.elements[0]!.element_id,slide_bbox:snapshot.elements[0]!.bbox,intent:'agreed_text',after_text:'60 家店'}),discuss:async()=>{},...options.ports};
  observations.evidence('owner','mac:demo');observations.evidence('owner','glasses:demo');
  service=new MeetingSession(f.storage,f.authority,observations,ports,f.now);
  const workspace=await service.select('owner','mac:demo','glasses:demo',{target,shared_window_id:42,origin_processed_event_id:'processed:file-owner',session_id:context.session_id,attachment_grant_id:'file:demo'});
  const time=f.now();await observations.observe({principal_id:'owner',device_id:'glasses:demo',raw_ref:'l5:fixture',archive_revision:'rev:fixture',segment_id:'segment:fixture',processed_event_id:'processed:other',
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:time,end_ms:time+1},content:{audio_observations:[{segments:[{speaker:'speaker:meeting-other',text:options.word??'改成60家店'}]}]}} as unknown as ProcessedEvent);
  await observations.frame('owner','glasses:demo',new Date(time).toISOString(),'l5:frame','rev:frame');
  const frame_ref=`meeting-frame:${digest(['owner','l5:frame','rev:frame'])}`;
  const call=(tool:MeetingTool,args:Record<string,unknown>)=>service.call('owner',context,tool,{target_id:target.target_id,context,...args});
  const plan=async()=>{
    const snapshotResult=await call('read_deck',{}),ref=snapshotResult.structuredContent.content.find(c=>c.key==='snapshot_ref')!.text;
    const word=(await observations.words('owner',workspace.scope_session_id))[0]!;
    const located=await call('locate_region',{utterance_id:word.utterance_id,snapshot_ref:ref,frame_refs:[frame_ref]});
    const suggestion=JSON.parse(located.structuredContent.content.find(c=>c.key==='suggestion')!.text);
    return JSON.parse((await call('plan_text',{suggestion_ids:[suggestion.id],base_snapshot_ref:ref})).structuredContent.content.find(c=>c.key==='text_plan')!.text) as TextPlan;
  };
  const approve=async()=>{
    const scope=await f.authority.prepare(context,target.target_id,'document.text.update','owner_data');assert.ok(scope);
    await f.authority.approve({context,scope,effect:'owner_data',target:target.target_id,operation_kind:'document.text.update',task_type:'document.text.update',owner_requested:true,scope_allowed:true,consent_required:true},
      {request_id:'request:meeting',confirmation:{confirmation_id:nativeApprovalId('owner',context.run_id,'request:meeting'),confirmed_by:'owner',surface:{device_id:'mac:demo',device_type:'mac'},confirmed_at:new Date(f.now()).toISOString()}});
  };
  return {...f,service,observations,workspace,target,context,snapshot,image,ports,frame_ref,call,plan,approve,actions,writes:()=>writes,aborted:()=>aborted,
    disconnectDuringWrite:()=>{disconnect=true;},reconnect:()=>{observations.evidence('owner','mac:demo');observations.evidence('owner','glasses:demo');}};
}
