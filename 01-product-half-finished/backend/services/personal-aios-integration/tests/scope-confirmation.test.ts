import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeFixture} from './scope-grant-fixture.ts';
import {CapabilityConfirmations} from '../src/capability/consent/confirmation.ts';
import type {FrozenCall} from '../src/capability/consent/call.ts';
import {VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import {confirmFrozenEffect,effectConsent} from '../src/effect-consent.ts';
import {decideConsent} from '../src/capability/consent/decision.ts';
import {succeeded} from '../../../../../capability/sdk/ts/receipt.ts';

async function deferred(t:test.TestContext) {
  const f=await scopeFixture(t),cards=new VoiceConfirmations(f.storage,{ttl_ms:60000,now:f.now});
  const started=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();let executed=0;
  const frozen:FrozenCall={tool_name:'mcp__meeting_assistant__apply_text',task_id:'demo-task',args:{target_id:'deck:demo',plan_id:'plan:demo',
    plan_sha256:'a'.repeat(64)},idempotency_key:'key:demo',admission:f.bound,consent:f.call,check_with:'edit_status'};
  const ports={gates:(call:FrozenCall,approved:boolean)=>({...f.gates,
    scopes:f.authority.forOwner(async()=> 'owner'),
    effectConsent:(context:any,effect:any,_approved?:boolean,rideOk?:boolean,requestId?:string,confirmation?:any,forceOnce?:boolean)=>approved?
      confirmFrozenEffect(f.effectPorts,call.admission,context,effect,rideOk===true,requestId!,confirmation!,forceOnce):
      effectConsent(f.effectPorts,context,effect,false,false,'',undefined,forceOnce)}),
    execute:async()=>{executed++;started.resolve();await resume.promise;return succeeded();},
    receipt:async()=>{},followUp:async()=>{},error:()=>{}};
  const service=new CapabilityConfirmations(f.storage,cards,ports);
  t.after(async()=>{resume.resolve();await service.close();cards.close();});
  await service.decide(frozen);const card=cards.list('owner')[0]!;
  return {...f,service,cards,card,frozen,started,resume,executed:()=>executed};
}

test('panel success ACK waits for durable grant but not for Keynote editing',async t=>{
  const f=await deferred(t);assert.equal(f.executed(),0);assert.equal((await f.storage.list('scope-grants')).length,0);
  await f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve');
  assert.equal((await f.storage.list('scope-grants')).length,1);
  await f.started.promise;assert.equal(f.executed(),1);
  f.resume.resolve();await f.service.settle(f.card);
  await f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve');
  await f.service.settle(f.card);assert.equal(f.executed(),1);
});

test('cancel and late approve do not create a grant or edit a file',async t=>{
  const f=await deferred(t);await f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'deny');
  assert.equal((await f.service.settle(f.card)).status.state,'cancelled');
  await assert.rejects(f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve'),/ALREADY_DECIDED/);
  assert.equal(f.executed(),0);assert.equal((await f.storage.list('scope-grants')).length,0);
});

test('expired scope rejects panel success even if the confirmation card is still live',async t=>{
  const f=await deferred(t);await f.authority.sessions.end('owner',f.input.id,'privacy_pause');
  await assert.rejects(f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve'),/SCOPE_CONFIRMATION_NOT_GRANTED/);
  assert.equal((await f.service.settle(f.card)).status.state,'cancelled');assert.equal(f.executed(),0);
  assert.equal((await f.storage.list('scope-grants')).length,0);
});

test('scope storage failure cannot acknowledge success or dispatch; saved result remains cancelled',async t=>{
  const f=await deferred(t),publish=f.storage.publish.bind(f.storage);let offline=true;
  t.mock.method(f.storage,'publish',async(namespace:string,key:string,bytes:Uint8Array)=>{
    if(namespace==='scope-grants'&&offline)throw Error('fixture disk unavailable');return publish(namespace,key,bytes);
  });
  await assert.rejects(f.service.answer(f.card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve'),/SCOPE_CONFIRMATION_NOT_GRANTED/);
  assert.equal(f.executed(),0);await f.service.settle(f.card);
  // A failed authorization is terminal for this frozen call. A fresh call must ask again.
  offline=false;assert.equal((await f.service.settle(f.card)).status.state,'cancelled');
  assert.equal((await f.storage.list('scope-grants')).length,0);assert.equal(f.executed(),0);
});

test('an attempted edit stays unknown after scope ends; recovery must query instead of claiming cancellation',async t=>{
  const f=await deferred(t),{decision}=await f.cards.decide(f.card.confirmation_id,
    {principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve');
  assert.equal((await decideConsent(f.gates,f.call,{request_id:f.card.approval_request_id!,confirmation:decision.confirmation!})).action,'allow');
  await f.storage.publish('capability-call-executions',f.card.confirmation_id,Buffer.from('{"token":"interrupted"}'));
  await f.authority.sessions.end('owner',f.input.id);
  const result=await f.service.settle(f.card);assert.equal(result.status.state,'unknown');
  assert.equal(result.values.find(row=>row.key==='idempotency_key')?.value,f.frozen.idempotency_key);
  assert.equal(result.next.check_with,'edit_status');assert.equal(result.next.retry,'after_check');assert.equal(f.executed(),0);
});
