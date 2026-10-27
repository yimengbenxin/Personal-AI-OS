import test from 'node:test';
import assert from 'node:assert/strict';
import {admitReceipt} from '../src/capability/receipt.ts';
import {projectWorkItems} from '../src/capability/work-items.ts';
import {ActivityProjection} from '../src/activity.ts';
import {succeeded,effect} from '../../../../../capability/sdk/ts/receipt.ts';
import type {WorkItemReceipt} from '../../../../../capability/contracts/work-items.ts';
import type {ReceiptRecord} from '../src/capability/ledger.ts';

const receipt=(revision=2):WorkItemReceipt=>({...succeeded({job:{id:'job:demo',revision},effects:[effect('owner_data','deck:demo','文字更新','verified','已保存并回读','audit:2')]}),
  work_items:[{id:'page:2',label:'第2页文字',state:'succeeded',slide_id:'slide:2',slide_number:2,effect_refs:['audit:2']}]});
const record=(body:WorkItemReceipt,id='record'):ReceiptRecord=>({id,tool:'arbitrary-package__tool',task_id:'task',tool_call_id:id,invocation:id,fingerprint:id,receipt:admitReceipt(body)});

test('one receipt admission checks duplicate IDs and effect_refs and refuses unverified per-page success',()=>{
  const good=admitReceipt(receipt()) as WorkItemReceipt;assert.equal(good.work_items?.[0]!.state,'succeeded');
  for(const mutate of [(body:WorkItemReceipt)=>{body.work_items![0]!.effect_refs=['missing'];},
    (body:WorkItemReceipt)=>{body.effects[0]!.verification='service_ack';},(body:WorkItemReceipt)=>{body.work_items!.push(body.work_items![0]!);}]){
    const body=receipt();mutate(body);const result=admitReceipt(body) as WorkItemReceipt;
    assert.notEqual(result.work_items?.[0]?.state,'succeeded');assert.notEqual(result.status.state,'succeeded');
  }
});

test('old revisions and later running snapshots cannot erase verified saved pages; partial pages stay explicit',()=>{
  const done=receipt(2),late=receipt(1);late.status.state='running';late.work_items![0]!.state='running';
  const regression=receipt(3);regression.status.state='running';regression.work_items![0]!.state='running';
  const partial=receipt(4);partial.status.state='partial';partial.work_items!.push({id:'page:4',label:'第4页文字',state:'unknown',slide_number:4,effect_refs:[]});
  assert.deepEqual(projectWorkItems([record(done),record(late,'late'),record(regression,'regression'),record(partial,'partial')]).map(row=>[row.id,row.state]),[['page:2','succeeded'],['page:4','unknown']]);
});

test('activity uses generic task rows and per-page verified progress, with no tool-name projection',()=>{
  const updates:any[]=[],projection=new ActivityProjection('owner','session','processed',packet=>updates.push(packet),()=>Date.parse('2026-10-26T00:00:00Z'));
  projection.receipts([record(receipt())]);
  assert.equal(projection.card?.items[0]?.kind,'task');assert.equal(projection.card?.items[0]?.summary,'第2页文字');
  assert.equal(projection.card?.items[0]?.state,'succeeded');assert.deepEqual(projection.card?.progress,{version:1,value:1,total:1});
  projection.close();assert.equal(updates.length>0,true);
});

test('the actual ledger preserves verified pages when its current projection receives only the latest job revision',async t=>{
  const {scopeFixture}=await import('./scope-grant-fixture.ts');const {ReceiptLedger}=await import('../src/capability/ledger.ts');
  const f=await scopeFixture(t),ledger=new ReceiptLedger(f.storage),binding={principal_id:'owner',run_id:'run:rows'};
  await ledger.admit(binding,{task_id:'task',tool_call_id:'first',tool_name:'any',args:{}},receipt(2));
  const late=receipt(3);late.status.state='running';late.work_items![0]!.state='running';
  await ledger.admit(binding,{task_id:'task',tool_call_id:'late',tool_name:'other',args:{}},late);
  const current=await ledger.current(binding);assert.equal(current.length,1);assert.equal(current[0]!.receipt.status.state,'unknown');
  assert.equal(projectWorkItems(current)[0]!.state,'succeeded');
});
