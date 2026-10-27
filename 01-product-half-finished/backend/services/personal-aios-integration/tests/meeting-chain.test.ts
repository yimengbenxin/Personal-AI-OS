import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingFixture} from './meeting-fixture.ts';
import {canonical,sha256} from '../src/contracts.ts';
import {validatePresentationOutline} from '../src/presentation-validate.ts';
import {admitReceipt} from '../src/capability/receipt.ts';
import {projectWorkItems} from '../src/capability/work-items.ts';
import {recordFacts} from '../src/capability/renderer.ts';
import {succeeded,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {textHasQuantityBasis} from '../src/meeting/text-basis.ts';
import {checkReport} from '../src/capability/checker.ts';

test('a spoken cover reference edits the native cover while the shared window stays on page six',async t=>{
  let visions=0,frames=0;
  const f=await meetingFixture(t,{word:'封面标题改成“三月上新”',ports:{vision:async(_image,prompt)=>{
    visions++;assert.match(prompt.prompt,/document_tree/);assert.match(prompt.prompt,/三月上新/);
    return JSON.stringify({state:'matched',slide_id:'slide:1',element_id:'text:1:1',slide_bbox:[.2,.3,.7,.5],intent:'agreed_text',after_text:'三月上新'});
  },frame:async()=>{frames++;throw Error('explicit page reference must not examine anyone');}}});
  f.snapshot.slide_id='slide:6';f.snapshot.slide_number=6;f.snapshot.mode='slideshow';f.snapshot.page_source='slideshow_state';f.snapshot.cross_check='matched';
  const element={...f.snapshot.elements[0]!,element_id:'text:1:1',text:'山茶乌龙',text_sha256:sha256('山茶乌龙')};
  const outline={version:1,target:f.target,deck_revision:f.snapshot.deck_revision,captured_at:f.snapshot.captured_at,source:'document_tree',
    slides:[{slide_id:'slide:1',slide_number:1,elements:[element]},{slide_id:'slide:6',slide_number:6,elements:f.snapshot.elements}]};
  validatePresentationOutline(outline);
  const invoke=f.ports.invoke;f.ports.invoke=async(binding,action,args,signal)=>action==='presentation_snapshot'?
    {...to_mcp_result(succeeded({content:[{key:'slide_snapshot',text:canonical(f.snapshot),provenance:'observed'},
      {key:'deck_outline',text:canonical(outline),provenance:'observed'}]})),content:[{type:'image',mimeType:'image/jpeg',data:f.image.toString('base64')}]} as any:invoke(binding,action,args,signal);
  const plan=await f.plan();assert.equal(plan.edits[0]!.slide_id,'slide:1');assert.equal(plan.edits[0]!.before_text_sha256,element.text_sha256);
  assert.equal(f.snapshot.slide_number,6);assert.equal(frames,0);assert.equal(visions,1);
  assert.equal((await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'cover'})).structuredContent.status.state,'waiting');
  assert.equal(f.writes(),0);await f.approve();
  const receipt=admitReceipt((await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'cover'})).structuredContent);
  assert.equal(receipt.status.state,'succeeded');assert.equal(receipt.job!.id,'cover');assert.equal(f.writes(),1);
  const records=[{id:'cover',receipt}];assert.equal(projectWorkItems(records)[0]!.slide_number,1);
  assert.ok(recordFacts(records as any,'run').some(fact=>fact.kind==='progress'&&fact.quantities?.some(q=>q.value===1)));
});

test('an absent native cover outline stays unknown and never falls back to current slide pointing',async t=>{
  let visions=0;const f=await meetingFixture(t,{word:'封面标题改成“三月上新”',ports:{vision:async()=>{visions++;throw Error('not grounded');}}});
  const read=await f.call('read_deck',{}),word=(await f.observations.words('owner',f.workspace.scope_session_id))[0]!;
  const result=await f.call('locate_region',{utterance_id:word.utterance_id,snapshot_ref:read.structuredContent.content.find(c=>c.key==='snapshot_ref')!.text,frame_refs:[f.frame_ref]});
  assert.equal(result.structuredContent.status.state,'unknown');assert.equal(visions,0);assert.equal(f.writes(),0);
});

test('busy confirmation and unknown native operations defer discussion; a later tick drains it once',async t=>{
  let busy=true,discussions=0;const f=await meetingFixture(t,{ports:{canDiscuss:async()=>!busy,discuss:async()=>{discussions++;}} as any});
  await f.service.discussed('owner',f.workspace.scope_session_id);assert.equal(discussions,0);
  busy=false;await Promise.all([f.service.discussed('owner',f.workspace.scope_session_id),f.service.discussed('owner',f.workspace.scope_session_id)]);
  assert.equal(discussions,1);await f.service.tick();assert.equal(discussions,1);
});

test('scope end cancels future writes, preserves status access and does not promote old page references',async t=>{
  const f=await meetingFixture(t),plan=await f.plan();await f.approve();
  await f.observations.endDevice('owner','glasses:demo','privacy_pause');
  await assert.rejects(f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'after-end'}),/SESSION_ENDED/);
  assert.equal(f.writes(),0);
});

test('late audio consumed after end or a lost aggregate does not poison the continuous consumer with a new task',async t=>{
  let tasks=0;const f=await meetingFixture(t,{ports:{discuss:async()=>{tasks++;}}});
  f.observations.disconnected('owner','mac:demo');await f.observations.sweep();
  await f.service.discussed('owner',f.workspace.scope_session_id);assert.equal(tasks,0);
  await f.observations.endDevice('owner','glasses:demo','privacy_pause');
  await f.service.discussed('owner',f.workspace.scope_session_id);assert.equal(tasks,0);
});

test('Chinese quantities need the same basis; brief output preserves unknown and does not claim undelivered details',()=>{
  assert.equal(textHasQuantityBasis('60 家店','改成六十家店'),true);
  assert.equal(textHasQuantityBasis('四十万元','预算 400000 元'),true);
  assert.equal(textHasQuantityBasis('四十万元','预算 40 万元'),true);
  assert.equal(textHasQuantityBasis('每家店每天六十杯','原来三十万杯'),false);
  const {structuredContent:receipt}=to_mcp_result(succeeded({content:[{key:'detail',text:'详情'.repeat(500),provenance:'observed'}]}));
  const records=[{id:'one',receipt}],facts=recordFacts(records as any,'run');
  const checked=checkReport('一万处都改好了。',[receipt],'',facts,'voice',facts,{max_characters:48});
  assert.ok([...checked.text].length<=48);assert.ok(checked.removed.some(row=>row.reasons.includes('unsupported_number')));
  assert.ok(checked.deferred_fact_ids.length>0);assert.ok(checked.facts.every(fact=>!checked.deferred_fact_ids.includes(fact.id)));
});

test('a late status packet cannot replace a completed audit or cause a second execution',async t=>{
  const f=await meetingFixture(t),plan=await f.plan();await f.approve();
  const invoke=f.ports.invoke,started=Promise.withResolvers<void>(),complete=Promise.withResolvers<void>(),queried=Promise.withResolvers<void>(),late=Promise.withResolvers<void>();
  f.ports.invoke=async(binding,action,args,signal)=>{
    if(action==='presentation_apply_text'){started.resolve();await complete.promise;}
    if(action==='presentation_edit_status'){queried.resolve();await late.promise;}
    return invoke(binding,action,args,signal);
  };
  const apply=f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'race'});await started.promise;
  const status=f.call('edit_status',{idempotency_key:'race'});await queried.promise;complete.resolve();
  assert.equal((await apply).structuredContent.status.state,'succeeded');late.resolve();
  assert.equal((await status).structuredContent.status.state,'succeeded');assert.equal(await f.service.execution.pending(f.workspace),undefined);assert.equal(f.writes(),1);
});

test('unknown native results cannot smuggle a verified page from a different plan into progress',async t=>{
  const f=await meetingFixture(t),plan=await f.plan();await f.approve();const invoke=f.ports.invoke;
  f.ports.invoke=async(binding,action,args,signal)=>{
    const result=await invoke(binding,action,args,signal);if(action!=='presentation_apply_text')return result;
    result.structuredContent.status.state='unknown';const row=result.structuredContent.content.find(c=>c.key==='edit_result')!;
    const audit=JSON.parse(row.text);audit.plan_sha256='0'.repeat(64);row.text=canonical(audit);return result;
  };
  const result=await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'unknown:foreign-plan'});
  const admitted=admitReceipt(result.structuredContent);assert.equal(admitted.status.state,'unknown');
  assert.equal(admitted.work_items?.some(item=>item.state==='succeeded')??false,false);
  assert.equal(f.writes(),1);assert.ok(await f.service.execution.pending(f.workspace));
});
