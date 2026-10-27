import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeFixture} from './scope-grant-fixture.ts';
import {ScopeGrants} from '../src/capability/consent/scope-decision.ts';
import {decideConsent} from '../src/capability/consent/decision.ts';
import {SCOPE_SESSION_CAP_MS} from '../../../../../capability/contracts/scope-grant.ts';
import {scopeConfirmation} from '../src/capability/consent/scope-view.ts';

test('first confirmation is mandatory even when owner requested; one grant survives restart and covers later text',async t=>{
  const f=await scopeFixture(t);assert.equal((await decideConsent(f.gates,f.call)).action,'approve');
  assert.deepEqual(await f.authority.store.grant({...f.input,scope_session_id:f.input.id}),undefined);
  assert.equal((await decideConsent(f.gates,f.call,f.approval)).action,'allow');
  const stored=await f.authority.store.grant({...f.input,scope_session_id:f.input.id});assert.equal(stored!.confirmation_id,f.approval.confirmation.confirmation_id);
  const restored=new ScopeGrants(f.storage,async()=> 'owner',f.now),next={...f.call,context:{...f.context,tool_call_id:'later'},owner_requested:false};
  assert.equal((await decideConsent({...f.gates,scopes:restored},next)).action,'block');
  await restored.sessions.connection('owner',f.input.id,true,f.input);
  assert.equal((await decideConsent({...f.gates,scopes:restored,effectConsent:async()=>assert.fail('grant should suffice')},next)).action,'allow');
  const {request:_,...scope}=f.call.scope!;
  const prompt=await decideConsent(f.gates,{...f.call,context:{...f.context,tool_call_id:'other'},target:'deck:other',scope:{...scope,target_id:'deck:other'}});
  assert.equal(prompt.action,'approve');
});

test('scope prompt includes target, operation list, expiry and protected baselines',async t=>{
  const f=await scopeFixture(t),result=await decideConsent(f.gates,f.call);assert.equal(result.action,'approve');
  if(result.action!=='approve')return;
  for(const value of ['deck:demo','document.text.update',f.call.scope!.request!.expires_at,'会话结束','发送','删除','付款'])assert.ok(result.message.includes(value));
});

test('scope panel projection preserves frozen range and previews without exposing admission or tool arguments',async t=>{
  const f=await scopeFixture(t),call={...f.call,preview_items:['第 2 页：30 万杯 → 50 万杯']};
  const view=scopeConfirmation(call)!;
  assert.deepEqual(view,{grant_request:f.call.scope!.request,preview_items:call.preview_items});
  call.preview_items[0]='changed';assert.equal(view.preview_items[0],'第 2 页：30 万杯 → 50 万杯');
  assert.deepEqual(Object.keys(view).sort(),['grant_request','preview_items']);
  assert.throws(()=>scopeConfirmation({...f.call,preview_items:['']}),/SCOPE_PREVIEW_INVALID/);
  const {scope:_,...unbound}=f.call;assert.equal(scopeConfirmation(unbound),undefined);
});

test('device, run, owner, operation and frozen request tampering cannot reuse or mint a grant',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
  for(const change of [
    (c:any)=>{c.scope.target_device_id='mac:other';},(c:any)=>{c.scope.scope_session_id='other';},
    (c:any)=>{c.context.session_id='other';},(c:any)=>{c.scope.operation_kind='delete';},
    (c:any)=>{c.scope.request.expires_at='2099-01-01T00:00:00Z';},(c:any)=>{c.scope.request.allowed_operation_kinds.push('delete');},
  ]){const call=structuredClone(f.call);change(call);assert.equal((await decideConsent(f.gates,call)).action,'block');}
  f.principal('intruder');assert.equal((await decideConsent(f.gates,f.call)).action,'block');
  await assert.rejects(f.authority.prepare(f.context,'deck:demo','document.text.update','owner_data'),/PRINCIPAL_MISMATCH/);
});

test('permission is refused while disconnected; reconnect before 60s restores it, exactly 60s ends permanently',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
  await f.authority.sessions.connection('owner',f.input.id,false,f.input);f.advance(59000);
  assert.equal((await decideConsent(f.gates,f.call)).action,'block');
  await f.authority.sessions.connection('owner',f.input.id,true,f.input);
  assert.equal((await decideConsent(f.gates,f.call)).action,'allow');
  await f.authority.sessions.connection('owner',f.input.id,false,f.input);f.advance(30000);
  await f.authority.sessions.connection('owner',f.input.id,false,f.input);f.advance(30000);
  const restored=new ScopeGrants(f.storage,async()=> 'owner',f.now);
  assert.equal((await restored.sessions.current('owner',f.input.id))!.end_reason,'disconnected');
  await restored.sessions.connection('owner',f.input.id,true,f.input);
  assert.equal((await decideConsent({...f.gates,scopes:restored},f.call)).action,'block');
});

for(const reason of ['explicit','companion_off','privacy_pause','pairing_revoked','device_paused'] as const)
  test(`${reason} expires the grant without reopening on duplicate open`,async t=>{
    const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
    await f.authority.sessions.end('owner',f.input.id,reason);
    assert.equal((await f.authority.sessions.open(f.input)).state,'ended');
    assert.equal((await decideConsent(f.gates,f.call)).action,'block');
  });

test('two-hour cap is absolute and target changes end the session',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
  f.advance(SCOPE_SESSION_CAP_MS-1);assert.equal((await decideConsent(f.gates,f.call)).action,'allow');
  f.advance(1);assert.equal((await decideConsent(f.gates,f.call)).action,'block');
  assert.equal((await f.authority.sessions.current('owner',f.input.id))!.end_reason,'expired');
  const other=await scopeFixture(t);await other.authority.sessions.connection('owner',other.input.id,true,{...other.input,target_id:'deck:new'});
  assert.equal((await other.authority.sessions.current('owner',other.input.id))!.end_reason,'target_changed');
});

test('concurrent identical confirmations publish one immutable grant; altered confirmation cannot mint',async t=>{
  const f=await scopeFixture(t);
  await Promise.all(Array.from({length:8},()=>decideConsent(f.gates,f.call,f.approval)));
  assert.equal((await f.storage.list('scope-grants')).length,1);
  const other=await scopeFixture(t);
  for(const change of [(a:any)=>{a.confirmation.confirmed_by='intruder';},(a:any)=>{a.confirmation.confirmation_id='forged';},
    (a:any)=>{a.confirmation.confirmed_at='2099-01-01T00:00:00Z';}]){
    const approval=structuredClone(other.approval);change(approval);
    assert.equal((await decideConsent(other.gates,other.call,approval)).action,'block');
    assert.equal((await other.storage.list('scope-grants')).length,0);
  }
});

test('run binding is immutable and sessions cannot widen their operation list',async t=>{
  const f=await scopeFixture(t);await f.authority.sessions.open({...f.input,id:'scope:other'});
  await assert.rejects(f.authority.sessions.bindRun(f.context,'owner','scope:other'),/BINDING_CONFLICT/);
  await assert.rejects(f.authority.sessions.open({...f.input,allowed_operation_kinds:['document.text.update','delete']}),/SESSION_CONFLICT/);
});

test('cold recovery requires fresh same-target continuity and ends after an unproved 60-second gap',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);f.advance(59000);
  const quick=new ScopeGrants(f.storage,async()=> 'owner',f.now);
  assert.equal((await decideConsent({...f.gates,scopes:quick},f.call)).action,'block');
  await quick.sessions.connection('owner',f.input.id,true,f.input);
  assert.equal((await decideConsent({...f.gates,scopes:quick},f.call)).action,'allow');
  f.advance(60000);const late=new ScopeGrants(f.storage,async()=> 'owner',f.now);
  assert.equal((await late.sessions.connection('owner',f.input.id,true,f.input)).end_reason,'disconnected');
  assert.equal((await decideConsent({...f.gates,scopes:late},f.call)).action,'block');
});

test('failed end persistence blocks permission immediately and flushes the end after storage recovers',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
  const replace=f.storage.replace.bind(f.storage);let broken=true;
  t.mock.method(f.storage,'replace',async(...args:Parameters<typeof replace>)=>{if(broken)throw Error('fixture disk failure');await replace(...args);});
  await assert.rejects(f.authority.sessions.end('owner',f.input.id),/disk failure/);
  assert.equal((await decideConsent(f.gates,f.call)).action,'block');
  await assert.rejects(f.authority.sessions.connection('owner',f.input.id,true,f.input),/disk failure/);
  broken=false;assert.equal((await f.authority.sessions.current('owner',f.input.id))!.state,'ended');
  assert.equal((await decideConsent(f.gates,f.call)).action,'block');
});

test('a recorded short disconnect resumes during a long meeting, even after a restart',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);f.advance(3600000);
  await f.authority.sessions.connection('owner',f.input.id,false,f.input);f.advance(59000);
  const restored=new ScopeGrants(f.storage,async()=> 'owner',f.now);
  assert.equal((await restored.sessions.connection('owner',f.input.id,true,f.input)).state,'active');
  assert.equal((await decideConsent({...f.gates,scopes:restored},f.call)).action,'allow');
});
