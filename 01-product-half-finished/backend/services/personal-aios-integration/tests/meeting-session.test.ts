import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingFixture} from './meeting-fixture.ts';

test('a closed immutable plan waits for the real grant, then edits only the bound Mac and normalizes job.id',async t=>{
  const f=await meetingFixture(t),plan=await f.plan();
  assert.equal((await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'a'.repeat(64)})).structuredContent.status.state,'waiting');
  assert.equal(f.writes(),0);await f.approve();
  const result=await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'a'.repeat(64)});
  assert.equal(result.structuredContent.status.state,'succeeded');assert.equal(result.structuredContent.job?.id,'a'.repeat(64));assert.equal(f.writes(),1);
  await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'a'.repeat(64)});assert.equal(f.writes(),1);
  await assert.rejects(f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:'0'.repeat(64),idempotency_key:'b'.repeat(64)}),/PLAN_HASH/);
});

test('unknown operations reconcile before another read or write; a disconnect aborts the native invocation',async t=>{
  const f=await meetingFixture(t),plan=await f.plan();await f.approve();f.disconnectDuringWrite();
  const result=await f.call('apply_text',{plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'c'.repeat(64)});
  assert.equal(result.structuredContent.status.state,'unknown');assert.equal(f.aborted(),true);
  f.reconnect();const before=f.actions.length;await f.call('read_deck',{});
  assert.equal(f.actions[before],'presentation_edit_status');assert.equal(f.actions.length,before+1);assert.equal(f.writes(),1);
});

test('pointing refuses stale, cross-session, ambiguous and out-of-scope changes without inventing a suggestion',async t=>{
  const f=await meetingFixture(t);await f.plan();
  f.advance(30001);await assert.rejects(f.call('read_deck',{}),/CONNECTION_REQUIRED/);
  await assert.rejects(f.service.call('someone-else',f.context,'read_deck',{target_id:f.target.target_id,context:f.context}),/SESSION_NOT_FOUND/);
});

test('temporary camera purpose uses existing policy and restores it; privacy pause cannot be widened',async t=>{
  const {scopeFixture}=await import('./scope-grant-fixture.ts');const {CameraCapturePolicies}=await import('../src/visual/store.ts');
  const f=await scopeFixture(t),policies=new CameraCapturePolicies(f.storage,f.now),source={principal_id:'owner',device_id:'glasses:demo'} as any;
  assert.equal((await policies.policyForConnect(source)).interval_ms,30000);
  policies.lease(source,'meeting:demo',f.now()+60000);assert.equal((await policies.policyForConnect(source)).interval_ms,1000);
  policies.releaseLease(source,'meeting:demo');assert.equal((await policies.policyForConnect(source)).interval_ms,30000);
  await policies.set(source,{private_paused:true});policies.lease(source,'meeting:demo',f.now()+60000);
  assert.equal((await policies.policyForConnect(source)).private_paused,true);assert.equal((await policies.policyForConnect(source)).interval_ms,30000);
});
