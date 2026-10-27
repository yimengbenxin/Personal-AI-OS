import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingFixture} from './meeting-fixture.ts';
import {canonical,sha256,type ProcessedEvent} from '../src/contracts.ts';
import {succeeded,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {ReceiptLedger} from '../src/capability/ledger.ts';
import {carryMeetingReceipts} from '../src/meeting/history.ts';
import {ActivityProjection} from '../src/activity.ts';
import {recordFacts} from '../src/capability/renderer.ts';
import {checkReport} from '../src/capability/checker.ts';

test('video fixture: three page edits wait together, one grant applies them and a later cover edit, four verified rows',async t=>{
  const lines=[
    [2,'三十万杯太虚了。换成每家店每天要卖多少杯，门店一看就懂。','预计 30 万杯','目标按每家店每天销量列示；待补门店数和营业天数'],
    [4,'外卖别等到四月，跟门店同一天上。新品头两周最要紧。','门店 3/15，外卖 4/1','外卖与门店同一天上新'],
    [5,'达人四十万拆开写：头部几个人，腰部几个人，各花多少。','达人 40 万元','达人预算40万元：头部与腰部分别列人数和费用，金额待核对'],
  ] as const;
  let proposal:any;const f=await meetingFixture(t,{word:lines[0][1],ports:{vision:async()=>JSON.stringify(proposal)}}),ids:string[]=[];
  let base='';
  for(const [page,spoken,before,after] of lines){
    f.snapshot.slide_id=`slide:${page}`;f.snapshot.slide_number=page;
    f.snapshot.elements[0]={...f.snapshot.elements[0]!,element_id:`text:${page}:1`,text:before,text_sha256:sha256(before)};
    if(page!==2)await f.observations.observe({principal_id:'owner',device_id:'glasses:demo',raw_ref:`l5:words:${page}`,archive_revision:'rev:demo',segment_id:`segment:${page}`,processed_event_id:`processed:${page}`,
      time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:f.now(),end_ms:f.now()+1},content:{audio_observations:[{segments:[{speaker:'speaker:meeting-other',text:spoken}]}]}} as unknown as ProcessedEvent);
    const word=(await f.observations.words('owner',f.workspace.scope_session_id)).find(word=>word.text===spoken)!;
    const read=await f.call('read_deck',{});base=read.structuredContent.content.find(c=>c.key==='snapshot_ref')!.text;
    proposal={state:'matched',slide_id:f.snapshot.slide_id,element_id:f.snapshot.elements[0]!.element_id,slide_bbox:f.snapshot.elements[0]!.bbox,intent:'agreed_text',after_text:after};
    const located=await f.call('locate_region',{utterance_id:word.utterance_id,snapshot_ref:base,frame_refs:[f.frame_ref]});
    ids.push(JSON.parse(located.structuredContent.content.find(c=>c.key==='suggestion')!.text).id);
  }
  const plan=JSON.parse((await f.call('plan_text',{suggestion_ids:ids,base_snapshot_ref:base})).structuredContent.content.find(c=>c.key==='text_plan')!.text);
  assert.deepEqual(plan.edits.map((edit:any)=>edit.slide_number),[2,4,5]);
  const args={plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'video:first-three'};
  assert.equal((await f.call('apply_text',args)).structuredContent.status.state,'waiting');assert.equal(f.writes(),0);
  await f.approve();const first=await f.call('apply_text',args);assert.equal(first.structuredContent.status.state,'succeeded');assert.equal(f.writes(),1);
  // The owner turns to page six; the subsequent cover reference never changes that selection.
  f.snapshot.slide_id='slide:6';f.snapshot.slide_number=6;f.snapshot.deck_revision=sha256('demo-after-three');
  const cover={...f.snapshot.elements[0]!,element_id:'text:1:1',text:'山茶乌龙新品上市计划',text_sha256:sha256('山茶乌龙新品上市计划')};
  const invoke=f.ports.invoke;
  f.ports.invoke=async(binding,action,input,signal)=>action==='presentation_snapshot'?{...to_mcp_result(succeeded({content:[
    {key:'slide_snapshot',text:canonical(f.snapshot),provenance:'observed'},
    {key:'deck_outline',text:canonical({version:1,target:f.target,deck_revision:f.snapshot.deck_revision,captured_at:f.snapshot.captured_at,source:'document_tree',slides:[{slide_id:'slide:1',slide_number:1,elements:[cover]}]}),provenance:'observed'}]})),content:[{type:'image',mimeType:'image/jpeg',data:f.image.toString('base64')}]} as any:invoke(binding,action,input,signal);
  await f.observations.observe({principal_id:'owner',device_id:'glasses:demo',raw_ref:'l5:words:cover',archive_revision:'rev:demo',segment_id:'segment:cover',processed_event_id:'processed:cover',
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:f.now(),end_ms:f.now()+1},content:{audio_observations:[{segments:[{speaker:'speaker:meeting-other',text:'封面标题太长，就叫“山茶乌龙，三月上新”。'}]}]}} as unknown as ProcessedEvent);
  const context={run_id:'run:cover',session_id:'session:cover',tool_call_id:'call:cover'};
  const call=(tool:any,input:object)=>f.service.call('owner',context,tool,{target_id:f.target.target_id,context,...input});
  const read=await call('read_deck',{}),ref=read.structuredContent.content.find(c=>c.key==='snapshot_ref')!.text;
  const word=(await f.observations.words('owner',f.workspace.scope_session_id)).find(word=>word.text.includes('封面'))!;
  proposal={state:'matched',slide_id:'slide:1',element_id:cover.element_id,slide_bbox:cover.bbox,intent:'agreed_text',after_text:'山茶乌龙，三月上新'};
  const located=await call('locate_region',{utterance_id:word.utterance_id,snapshot_ref:ref,frame_refs:[f.frame_ref]});
  const suggestion=JSON.parse(located.structuredContent.content.find(c=>c.key==='suggestion')!.text);
  const extra=JSON.parse((await call('plan_text',{suggestion_ids:[suggestion.id],base_snapshot_ref:ref})).structuredContent.content.find(c=>c.key==='text_plan')!.text);
  const fourth=await call('apply_text',{plan_id:extra.plan_id,plan_sha256:extra.plan_sha256,idempotency_key:'video:cover'});
  assert.equal(fourth.structuredContent.status.state,'succeeded');assert.equal(f.writes(),2);assert.equal(f.snapshot.slide_number,6);assert.equal((await f.storage.list('scope-grants')).length,1);
  const ledger=new ReceiptLedger(f.storage);
  await ledger.admit({principal_id:'owner',run_id:f.context.run_id},{task_id:'first',tool_call_id:'first',tool_name:'any',args:{}},first.structuredContent);
  await ledger.admit({principal_id:'owner',run_id:context.run_id},{task_id:'fourth',tool_call_id:'fourth',tool_name:'any',args:{}},fourth.structuredContent);
  await carryMeetingReceipts(f.storage,ledger,'owner',f.workspace.scope_session_id,context.run_id);
  const rows=await ledger.current({principal_id:'owner',run_id:context.run_id}),activity=new ActivityProjection('owner',context.session_id,'processed',()=>{},f.now);t.after(()=>activity.close());
  activity.receipts(rows);assert.deepEqual(activity.card!.progress,{version:1,value:4,total:4});
  const facts=recordFacts(rows,context.run_id),checked=checkReport('都改好了，四处。',rows.map(row=>row.receipt),'',facts,'voice',facts,{max_characters:48});
  assert.ok(!checked.removed.some(row=>row.reasons.includes('unsupported_number')));assert.ok([...checked.text].length<=48);
});
