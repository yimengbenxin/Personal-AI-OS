import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeFixture} from './scope-grant-fixture.ts';
import {decideConsent,type ConsentCall} from '../src/capability/consent/decision.ts';
import {effectConsent} from '../src/effect-consent.ts';
import {nativeApprovalId} from '../src/voiceprint/confirmation.ts';

test('full protected matrix: grant never releases send/delete/payment/account/self-change (or physical)',async t=>{
  const f=await scopeFixture(t,['document.text.update','document.other']);
  await decideConsent(f.gates,f.call,f.approval);
  let cases=0;
  for(const effect of ['send','delete','spend','account','self_change','physical'] as const)
    for(const requested of [true,false])for(const required of [true,false])for(const remembered of [true,false])
      for(const matchingKind of [true,false]){
        const context={...f.context,tool_call_id:`protected:${cases++}`},operation_kind=matchingKind?'document.text.update':'not.allowed';
        const call:ConsentCall={...f.call,context,effect,task_type:`protected.case.${cases}`,owner_requested:requested,consent_required:required,operation_kind,
          scope:{scope_session_id:f.input.id,target_id:f.input.target_id,target_device_id:f.input.target_device_id,operation_kind}};
        if(remembered&&effect==='send'){
          const prior={...context,tool_call_id:'older-send'},request='remember-send';
          await effectConsent(f.effectPorts,prior,{kind:'send',recipient:call.target,task_type:call.task_type,requested:true},true,false,request,
            {...f.approval.confirmation,confirmation_id:nativeApprovalId('owner',prior.run_id,request)});
        }
        const result=await decideConsent(f.gates,call);
        assert.equal(result.action,['spend','self_change'].includes(effect)?'block':'approve',JSON.stringify({effect,requested,required,remembered,matchingKind}));
      }
  assert.equal(cases,96);assert.equal((await f.storage.list('scope-grants')).length,1);
});

test('an out-of-scope write asks once, never widens grant, and unbound requests retain their baseline',async t=>{
  const f=await scopeFixture(t);await decideConsent(f.gates,f.call,f.approval);
  const operation_kind='document.image.update',call={...f.call,context:{...f.context,tool_call_id:'image'},operation_kind,
    scope:{scope_session_id:f.input.id,target_id:f.input.target_id,target_device_id:f.input.target_device_id,operation_kind}};
  assert.equal((await decideConsent(f.gates,call)).action,'approve');
  const request_id='image-confirmation',approval={request_id,confirmation:{...f.approval.confirmation,
    confirmation_id:nativeApprovalId('owner',f.context.run_id,request_id)}};
  assert.equal((await decideConsent(f.gates,call,approval)).action,'allow');
  assert.equal((await decideConsent(f.gates,{...call,context:{...call.context,tool_call_id:'next-image'}})).action,'approve');
  const grant=await f.authority.store.grant({...f.input,scope_session_id:f.input.id});
  assert.deepEqual(grant!.allowed_operation_kinds,['document.text.update']);
  const {scope:_,...unbound}=f.call;
  assert.equal((await decideConsent(f.gates,unbound)).action,'allow');
  assert.equal((await decideConsent(f.gates,{...unbound,owner_requested:false,context:{...f.context,tool_call_id:'unbound'}})).action,'approve');
  assert.equal((await decideConsent(f.gates,{...f.call,scope_allowed:false})).action,'block');
  const {scopes:__scope,...unwired}=f.gates;
  assert.deepEqual(await decideConsent(unwired,f.call),{action:'block',message:'SCOPE_AUTHORITY_REQUIRED'});
});
