import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTextPlan,validatePresentationInput,validateSlideSnapshot,validateMacEditResult,textPlanHash,presentationSchema,presentationTools} from '../src/presentation-validate.ts';
import type {TextPlan,SlideSnapshot,MacEditResult} from '../../../../../capability/contracts/presentation.ts';
import {sha256} from '../src/contracts.ts';

const root=new URL('../../../../../',import.meta.url);
const demo=JSON.parse(readFileSync(new URL('capability/packages/meeting-assistant/tests/demo.json',root),'utf8')) as {plan:TextPlan;snapshot:SlideSnapshot};
const binding={principal_id:'owner:demo',target_device_id:'mac:demo'};
const at=Date.parse('2026-10-26T00:00:00Z');
function apply(){return {target:structuredClone(demo.plan.target),plan:structuredClone(demo.plan),idempotency_key:'call:demo',
  execution:{...binding,target_id:'deck:demo',grant_id:'grant:demo',confirmation_id:'confirmation:demo',scope_session_id:'scope:demo',
    operation_kind:'document.text.update',valid_until:'2026-10-26T00:01:00Z',plan_sha256:demo.plan.plan_sha256}};}

test('frozen Keynote fixture, hashes and native tool schema references agree',()=>{
  validateTextPlan(demo.plan);validateSlideSnapshot(demo.snapshot);
  validatePresentationInput('presentation_apply_text',apply(),binding,at);
  assert.equal(textPlanHash(demo.plan),demo.plan.plan_sha256);
  assert.deepEqual(presentationTools.map((tool:any)=>tool.name),['presentation_snapshot','presentation_apply_text','presentation_edit_status']);
  for(const [index,tool] of presentationTools.entries())assert.deepEqual(tool.inputSchema,
    {type:'object',$ref:`urn:paios:presentation:1#/$defs/${['snapshot_input','apply_input','status_input'][index]}`});
  const work=JSON.parse(readFileSync(new URL('capability/contracts/work-items.v1.schema.json',root),'utf8'));
  assert.deepEqual(work.items,presentationSchema.$defs.work_item);
});

test('closed plan rejects structural edits, arbitrary scripts, online files and changed content',()=>{
  for(const change of [
    (p:any)=>{p.edits[0].op='delete_slide';},(p:any)=>{p.edits[0].script='activate';},
    (p:any)=>{p.target.file_url='https://docs.example/demo.key';},(p:any)=>{p.target.app_bundle_id='com.kingsoft.wpsoffice.mac';},
    (p:any)=>{p.edits.push({...p.edits[0]});p.preview_items.push('duplicate');},
    (p:any)=>{p.preview_items=[];},
  ]){const plan=structuredClone(demo.plan);change(plan);plan.plan_sha256=textPlanHash(plan);assert.throws(()=>validateTextPlan(plan));}
  const changed=structuredClone(demo.plan);changed.edits[0]!.after_text='unconfirmed';assert.throws(()=>validateTextPlan(changed),/HASH_MISMATCH/);
});

test('relay input binds exact device, document, plan, session, principal and expiry',()=>{
  for(const change of [
    (v:any)=>{v.target.target_device_id='mac:other';},(v:any)=>{v.target.document_id='other';},
    (v:any)=>{v.execution.target_id='other';},(v:any)=>{v.execution.target_device_id='mac:other';},
    (v:any)=>{v.execution.principal_id='intruder';},(v:any)=>{v.execution.scope_session_id='other';},
    (v:any)=>{v.execution.plan_sha256='0'.repeat(64);},(v:any)=>{v.execution.valid_until='2026-10-25T23:59:59Z';},
    (v:any)=>{v.execution.script='ignored?';},
  ]){const value=apply();change(value);assert.throws(()=>validatePresentationInput('presentation_apply_text',value,binding,at));}
  assert.throws(()=>validatePresentationInput('presentation_apply_text',apply(),binding,at+60000),/EXPIRED/);
  validatePresentationInput('presentation_snapshot',{target:demo.plan.target,shared_window_id:null},binding,at);
  validatePresentationInput('presentation_edit_status',{target:demo.plan.target,operation_id:'op:demo'},binding,at);
});

test('slideshow cannot claim selection as current page; image and element evidence must match',()=>{
  for(const change of [
    (v:SlideSnapshot)=>{v.mode='slideshow';},(v:SlideSnapshot)=>{v.image!.target_device_id='other';},
    (v:SlideSnapshot)=>{v.elements[0]!.bbox=[0.8,0.3,0.2,0.5];},(v:SlideSnapshot)=>{v.elements[0]!.text='changed';},
  ]){const snapshot=structuredClone(demo.snapshot);change(snapshot);assert.throws(()=>validateSlideSnapshot(snapshot));}
  const show=structuredClone(demo.snapshot);show.mode='slideshow';show.page_source='slideshow_state';show.cross_check='matched';validateSlideSnapshot(show);
});

test('native success requires saved file and per-item read-back evidence, still awaiting owner review',()=>{
  const ref='proof:demo',edit=demo.plan.edits[0]!;
  const result:MacEditResult={version:1,operation_id:'op:demo',target:demo.plan.target,plan_sha256:demo.plan.plan_sha256,revision:1,
    items:[{id:edit.work_item_id,label:'第 2 页',state:'succeeded',effect_refs:[ref]}],
    checks:[{work_item_id:edit.work_item_id,before_text_sha256:edit.before_text_sha256,after_text_sha256:sha256(edit.after_text),
      saved_at:'2026-10-26T00:00:00Z',read_back_at:'2026-10-26T00:00:01Z',evidence_ref:ref}],
    file_sha256:sha256('demo-file'),saved_at:'2026-10-26T00:00:00Z',review_status:'awaiting_owner'};
  validateMacEditResult(result);
  for(const change of [(v:any)=>{v.checks=[];},(v:any)=>{delete v.file_sha256;},(v:any)=>{v.items[0].effect_refs=[];},
    (v:any)=>{v.checks[0].read_back_at='2026-10-25T23:59:00Z';}]){
    const value=structuredClone(result);change(value);assert.throws(()=>validateMacEditResult(value),/READ_BACK_REQUIRED/);
  }
});
