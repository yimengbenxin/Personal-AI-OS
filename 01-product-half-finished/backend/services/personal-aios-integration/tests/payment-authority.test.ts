import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {paymentFixture,phone,glasses,passing,signed} from './payment-fixture.ts';
import {handlePaymentExecutor} from '../src/payment/executor-api.ts';
import {PAYMENT_STATES,TERMINAL_STATES} from '../src/payment/contracts.ts';
import {PAYMENT_LIVE_LIMIT} from '../src/payment/wire-budget.ts';
type Fixture=Awaited<ReturnType<typeof paymentFixture>>;
const state=(f:Fixture,id:string)=>f.authority.store.getPayment(id)!.state;
async function cancel(f:Fixture,id:string){const receipt=await f.authority.input(phone,{operation:'payment_decide',control_id:`cancel-${id}`,payment_id:id,decision:'cancel'});assert.ok(receipt);return receipt;}
async function ready(t:test.TestContext,auto=false){const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,auto);return f;}

test('speaker model retirement clears cached voice approval and pending auto payment while signed card still pays',async t=>{
  const f=await ready(t,true),c=await f.open({initiating:f.initiating('voice')});
  assert.equal(state(f,c.payment_id),'auto_pending');
  assert.equal(f.authority.store.getIntent(c.intent_id)!.initiating.verdict?.verdict,'pass');
  const dormant={...f.authority.store.policy('owner'),principal_id:'disconnected-owner'};
  f.authority.store.setPolicy(dormant);
  await f.authority.cascadeVoice('VOICEPRINT_MODEL_CHANGED');
  assert.equal(state(f,c.payment_id),'awaiting_owner');
  assert.equal(f.authority.store.getIntent(c.intent_id)!.initiating.verdict,undefined);
  assert.equal(f.authority.store.policy('owner').voice_enabled,false);
  assert.equal(f.authority.store.policy('disconnected-owner').voice_enabled,false);
  await f.advance(f.config.auto.undo_s*1000+1);
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  await f.pay(c.payment_id);
  assert.equal(f.authority.store.getGrant(c.payment_id)!.method,'card');
});

test('retired initiating verification cannot refill the cleared cache after model approval',async t=>{
  const f=await ready(t);let finish!:(value:typeof passing)=>void;
  f.deferInitiating(new Promise(resolve=>{finish=resolve;}));
  const c=await f.open({initiating:f.initiating('voice')});
  await f.authority.cascadeVoice('VOICEPRINT_MODEL_CHANGED');
  finish(passing);await new Promise(setImmediate);
  assert.equal(f.authority.store.getIntent(c.intent_id)!.initiating.verdict,undefined);
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
});

for(const lock of ['missing','disabled'] as const)test(`strict card admission: ${lock} phone lock cannot authorize a signed payment`,async t=>{
  const f=await paymentFixture(t,{},false);
  if(lock==='disabled'){
    await f.settings({kind:'phone_lock',enabled:true});await f.unlock();
    await f.settings({kind:'phone_lock',enabled:false});
  }
  const c=await f.open();
  await assert.rejects(f.pay(c.payment_id),{code:'PAYMENT_TERMINAL_LOCKED',status:403});
  assert.equal(state(f,c.payment_id),'awaiting_owner');
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  assert.equal(f.authority.store.events(c.payment_id).filter(e=>e.kind==='grant_issued').length,0);
});
test('strict card admission: enabled phone lock needs a live lease; phone payment needs no glasses wear or lock',async t=>{
  const f=await paymentFixture(t,{},false);await f.settings({kind:'phone_lock',enabled:true});
  f.terminals.wear(glasses,false,1);const c=await f.open();
  await assert.rejects(f.pay(c.payment_id),{code:'PAYMENT_TERMINAL_LOCKED',status:403});
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  await f.unlock();await f.pay(c.payment_id);
  assert.equal(state(f,c.payment_id),'granted');
  assert.equal(f.authority.store.getGrant(c.payment_id)!.method,'card');
  await f.authority.input(phone,{operation:'phone_presence',state:'locked'});
  await f.pay(c.payment_id);
  assert.equal(f.authority.store.events(c.payment_id).filter(e=>e.kind==='grant_issued').length,1,'a decided replay acknowledges the original grant without reauthorizing');
});
test('strict settings admission: device signatures cannot change limits; expired user challenge and stale-policy replay cannot mutate policy',async t=>{
  const f=await paymentFixture(t),change={kind:'limits' as const,auto_order_fen:2500};
  const policy=f.authority.store.policy('owner'),policy_version=policy.version;
  const {nonce}=await f.authority.keys.challenge(phone,'settings');
  const statement={purpose:'settings',device_id:'phone',nonce,policy_version,change};
  const submit=(signature:ReturnType<typeof signed>)=>f.authority.input(phone,{operation:'payment_settings_set',policy_version,change,...signature});
  await assert.rejects(submit(signed(f.dev,statement)),{code:'PAYMENT_SIGNATURE_INVALID',status:403});
  assert.deepEqual(f.authority.store.policy('owner'),policy);
  const authorized=signed(f.user,statement);await submit(authorized);
  assert.equal(f.authority.store.policy('owner').limits.auto_order_fen,2500);
  const updated=f.authority.store.policy('owner');
  await assert.rejects(submit(authorized),{code:'PAYMENT_POLICY_VERSION_STALE',status:409});
  const freshNonce=(await f.authority.keys.challenge(phone,'settings')).nonce;
  const expired=signed(f.user,{...statement,nonce:freshNonce,policy_version:updated.version});
  await f.advance(f.config.challenge_ttl_s*1000);
  await assert.rejects(f.authority.input(phone,{operation:'payment_settings_set',policy_version:updated.version,change,...expired}),{code:'PAYMENT_SIGNATURE_INVALID',status:403});
  assert.deepEqual(f.authority.store.policy('owner'),updated);
});

test('owner live-card cap is atomic, counts paying, and complete snapshots retain every live ID',async t=>{
  const f=await paymentFixture(t);await f.locks();
  const cards=[];for(let n=0;n<PAYMENT_LIVE_LIMIT;n++)cards.push(await f.open());
  const first=cards[0]!;await f.pay(first.payment_id);
  await f.authority.tap(first.payment_id,{grant_id:f.authority.store.getGrant(first.payment_id)!.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64)});
  assert.equal(state(f,first.payment_id),'paying');
  const blocked=await f.request(),before=f.authority.store.events().length;
  await assert.rejects(f.authority.checkpoint({...first.checkpoint,intent_id:String(blocked.intent_id),job_id:'blocked-job'}),{code:'PAYMENT_CHECKPOINT_ACTIVE',status:409});
  assert.equal(f.authority.store.events().filter(e=>e.kind==='card_opened').length,PAYMENT_LIVE_LIMIT);
  assert.equal(f.authority.store.events().length,before,'refused admission changes no payment audit or live ID');
  assert.equal((await f.authority.checkpoint(first.checkpoint)).payment_id,first.payment_id,'an existing checkpoint replay needs no new slot');
  const frames:Record<string,unknown>[]=[];const stop=await f.authority.watch(phone,async frame=>{frames.push(frame);});stop();
  const snapshot=frames.find(frame=>frame.operation==='payment_cards')!;
  assert.equal(snapshot.complete,true);assert.deepEqual((snapshot.cards as {payment_id:string}[]).map(c=>c.payment_id).sort(),cards.map(c=>c.payment_id).sort());
  assert.equal(frames.find(frame=>frame.operation==='payment_approvals')!.complete,true);
  await f.authority.cancel('owner',cards.at(-1)!.intent_id);
  const requested=await Promise.all([f.request(),f.request()]);
  const raced=await Promise.allSettled(requested.map((r,n)=>f.authority.checkpoint({...first.checkpoint,intent_id:String(r.intent_id),job_id:`cap-race-${n}`})));
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
  assert.deepEqual(raced.filter(r=>r.status==='rejected').map(r=>({code:r.reason.code,status:r.reason.status})),[{code:'PAYMENT_CHECKPOINT_ACTIVE',status:409}]);
  const admitted=raced.find(r=>r.status==='fulfilled')! as PromiseFulfilledResult<Record<string,unknown>>;
  const changed=await f.authority.amountChanged(String(admitted.value.payment_id),{read_amount_fen:1700,payee:'一点点 南门店',items:['奶茶'],screen_sha256:'c'.repeat(64)});
  assert.ok(changed.next,'a superseding recard replaces its existing slot at capacity');
  assert.equal(f.authority.store.principalPayments('owner').filter(p=>!TERMINAL_STATES.includes(p.state)).length,PAYMENT_LIVE_LIMIT);
  const other=await f.authority.request({principal_id:'other-owner',run_id:'other-run',tool_call_id:'other-tool',session_id:'other-session',processed_event_id:'other-d',
    initiating:{...f.initiating('text'),device_id:'other-phone'},initiating_text:'买午饭',purpose:'午饭',app:'千问',budget_fen:null},true);
  assert.ok((await f.authority.checkpoint({...first.checkpoint,intent_id:String(other.intent_id),job_id:'other-job'})).payment_id,'another owner has independent capacity');
});

test('S1 I1 I2 I3 I8: card happy path, immutable authorized amount, checkpoint and decision replays',async t=>{
  const f=await paymentFixture(t),request=await f.request();
  const checkpoint={intent_id:String(request.intent_id),job_id:'happy-job',seq:1,app:'千问',checkout:'order_card' as const,
    amount_fen:1660,payee:'一点点 南门店',items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:new Date(f.now).toISOString()};
  const opened=await f.authority.checkpoint(checkpoint),c={payment_id:String(opened.payment_id),intent_id:checkpoint.intent_id,checkpoint};
  assert.equal(state(f,c.payment_id),'awaiting_owner');
  assert.equal((await f.authority.poll(c.payment_id)).method,undefined);
  assert.deepEqual(await f.authority.checkpoint(c.checkpoint),await f.authority.checkpoint(c.checkpoint));
  await assert.rejects(f.authority.checkpoint({...c.checkpoint,amount_fen:1661}),/PAYMENT_CHECKPOINT_CONFLICT/);
  const before=f.authority.store.getPayment(c.payment_id)!.version,wake=f.authority.poll(c.payment_id,25000,before);
  assert.equal((await f.pay(c.payment_id)).ok,true);const polled=await wake;assert.equal(polled.state,'granted');assert.equal(polled.method,'card');
  const grant=f.authority.store.getGrant(c.payment_id)!;assert.equal(grant.amount_fen,1660);
  assert.equal((await f.pay(c.payment_id)).ok,true);assert.equal(f.authority.store.getGrant(c.payment_id)!.grant_id,grant.grant_id);
  for(const step of [1,2]){
    await assert.rejects(f.authority.tap(c.payment_id,{grant_id:grant.grant_id,step,read_amount_fen:1661,screen_sha256:'d'.repeat(64)}),/PAYMENT_AMOUNT_MISMATCH/);
    const tap={grant_id:grant.grant_id,step,read_amount_fen:1660,screen_sha256:'d'.repeat(64),
      order_binding:{order_id:'order-A',order_namespace:'com.aliyun.tongyi',payee:c.checkpoint.payee,amount_fen:1660,item_identity:[['sku','tea'],['quantity','1']]},
      ...(step===2?{non_debit:{state:'unpaid',scope:'current_order',transition:'order_card_to_cashier',signs:['支付状态：未支付'],read_at:new Date(f.now).toISOString()}}:{})};
    await f.authority.tap(c.payment_id,tap);await f.authority.tap(c.payment_id,tap);
  }
  await f.authority.result(c.payment_id,{grant_id:grant.grant_id,outcome:'paid',signs:['支付成功'],screen_sha256:'e'.repeat(64)});
  assert.equal(state(f,c.payment_id),'paid');assert.equal(f.authority.store.getIntent(c.intent_id)!.state,'closed');
  assert.equal((await f.authority.poll(c.payment_id)).method,'card');
  assert.equal(f.authority.store.events(c.payment_id).filter(e=>e.kind==='grant_issued').length,1);
  assert.ok(!JSON.stringify(f.updates).includes(grant.grant_id));
});
test('S2 S3 I7 I10: unsigned cancellation and expiry preserve explicit order cleanup',async t=>{
  const f=await paymentFixture(t),cancelled=await f.open();assert.equal((await cancel(f,cancelled.payment_id)).ok,true);
  assert.equal(state(f,cancelled.payment_id),'cancelled');assert.equal(f.authority.store.getPayment(cancelled.payment_id)!.order_cancel,'pending');
  await f.authority.orderCancel(cancelled.payment_id,{outcome:'done',detail:'订单已取消'});
  assert.equal(f.authority.store.getPayment(cancelled.payment_id)!.order_cancel,'done');
  const granted=await f.open();await f.pay(granted.payment_id);assert.equal((await cancel(f,granted.payment_id)).ok,true);
  assert.equal(state(f,granted.payment_id),'cancelled');assert.equal((await f.authority.poll(granted.payment_id)).grant,undefined);
  const model=await f.open();assert.equal((await f.authority.cancel('owner',model.intent_id)).status,'cancelled');
  const expired=await f.open();await f.advance(f.config.card_ttl_s*1000);assert.equal(state(f,expired.payment_id),'expired');
  assert.equal(f.authority.store.getGrant(expired.payment_id),undefined);
});
test('S4 I2 I3: changed amount supersedes old card and recard cap stops unstable checkout',async t=>{
  const f=await paymentFixture(t),c=await f.open();await f.pay(c.payment_id);let id=c.payment_id;
  for(let n=0;n<f.config.max_recards_per_intent;n++){
    const response=await f.authority.amountChanged(id,{...(f.authority.store.getGrant(id)?{grant_id:f.authority.store.getGrant(id)!.grant_id}:{}),read_amount_fen:1700+n,payee:'一点点 南门店',items:['奶茶'],screen_sha256:'b'.repeat(64)});
    assert.equal(state(f,id),'superseded');id=(response.next as {payment_id:string}).payment_id;assert.equal(state(f,id),'awaiting_owner');
  }
  await assert.rejects(f.authority.amountChanged(id,{read_amount_fen:1800,payee:'一点点 南门店',items:['奶茶'],screen_sha256:'c'.repeat(64)}),/PAYMENT_RECARD_LIMIT/);
  assert.equal(state(f,id),'failed');assert.equal(f.authority.store.getPayment(id)!.reason,'AMOUNT_UNSTABLE');
  assert.equal(f.authority.store.payments(c.intent_id).length,1+f.config.max_recards_per_intent);
});
test('S5 S6 I5: glasses voice verdict grants; two failed attempts pause auto without granting',async t=>{
  const f=await ready(t),c=await f.open({initiating:f.initiating('voice',glasses)});
  await f.authority.observePayUtterance('owner',f.utterance(glasses));assert.equal(state(f,c.payment_id),'granted');
  assert.equal((await f.authority.poll(c.payment_id)).method,'voice');
  assert.equal(f.authority.store.getGrant(c.payment_id)!.method,'voice');await f.complete(c.payment_id);
  const bad=await f.open({initiating:f.initiating('voice',glasses)});f.verdict({...passing,verdict:'fail',reason:'other_speaker'});
  for(let n=0;n<2;n++){await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance(glasses));}
  assert.equal(f.authority.store.getPayment(bad.payment_id)!.voice_attempts,2);
  assert.equal(f.authority.store.getPayment(bad.payment_id)!.reason,'VOICE_NOT_RECOGNIZED');
  assert.ok(f.authority.store.policy('owner').paused_until_ms!>f.now);assert.equal(f.authority.store.getGrant(bad.payment_id),undefined);
  await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance(glasses));
  assert.equal(f.authority.store.getPayment(bad.payment_id)!.reason,'VOICE_ATTEMPTS_EXHAUSTED');
});
test('A6 composition: D and ambient share one attempt; windows close during verification and owner forget',async t=>{
  const f=await ready(t),windows=new Map<string,Parameters<NonNullable<typeof f.ports.openPayWindow>>[1]>();
  f.ports.openPayWindow=(input,heard)=>{windows.set(input.device_id,heard);return ()=>{if(windows.get(input.device_id)===heard)windows.delete(input.device_id);};};
  const c=await f.open({initiating:f.initiating('voice')});assert.equal(windows.size,2);
  f.verdict({...passing,verdict:'uncertain'});
  const utterance=f.utterance(),heard=windows.get(phone.device_id)!;
  await f.authority.observePayUtterance('owner',utterance); // D-level producer
  heard({...utterance,text:'付吧',speaker:'owner'}); // ambient replay of that same source span
  assert.equal(f.verifierCalls.pay,1);assert.equal(f.authority.store.getPayment(c.payment_id)!.voice_attempts,1);
  assert.equal(state(f,c.payment_id),'awaiting_owner');assert.equal(windows.size,2);
  await f.advance(3001);
  let finish!:(verdict:typeof passing)=>void;
  f.deferVoice(new Promise(resolve=>{finish=resolve;}));
  const checking=f.authority.observePayUtterance('owner',f.utterance());
  await new Promise(setImmediate);
  assert.equal(state(f,c.payment_id),'verifying');assert.equal(windows.size,0);
  f.owner(false);await f.authority.cascade('owner','VOICEPRINT_FORGOTTEN');
  finish(passing);await checking;
  assert.equal(f.authority.store.policy('owner').voice_enabled,false);
  assert.equal(f.authority.store.policy('owner').auto_enabled,false);
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);assert.equal(windows.size,0);
  await cancel(f,c.payment_id);assert.equal(windows.size,0);
});
test('S7 S8 S21 I5: auto undo window grants once; cancel and taking glasses off prevent a grant',async t=>{
  const f=await ready(t,true),c=await f.open({initiating:f.initiating('voice',glasses)});assert.equal(state(f,c.payment_id),'auto_pending');
  await f.advance(f.config.auto.undo_s*1000-1);assert.equal(state(f,c.payment_id),'auto_pending');
  await f.advance(1);assert.equal(state(f,c.payment_id),'granted');assert.equal(f.authority.store.getGrant(c.payment_id)!.method,'auto');
  assert.equal((await f.authority.poll(c.payment_id)).method,'auto');await f.complete(c.payment_id);
  await f.advance(f.config.auto.same_payee_window_s*1000+1);
  const cancelled=await f.open({initiating:f.initiating('voice',glasses)});await cancel(f,cancelled.payment_id);await f.advance(f.config.auto.undo_s*1000);
  assert.equal(state(f,cancelled.payment_id),'cancelled');assert.equal(f.authority.store.getGrant(cancelled.payment_id),undefined);
  const removed=await f.open({initiating:f.initiating('voice',glasses)});f.terminals.wear(glasses,false);await f.advance(f.config.auto.undo_s*1000);
  assert.equal(state(f,removed.payment_id),'awaiting_owner');assert.equal(f.authority.store.getPayment(removed.payment_id)!.reason,'TERMINAL_LOCKED');
});
test('S9 S10 S11 S12 S20 I16: auto falls back for order/day limits, new/recent payee and typed input',async t=>{
  const f=await ready(t,true);
  for(const [options,reason] of [
    [{amount:6840},'OVER_AUTO_LIMIT'],[{payee:'新店'},'NEW_PAYEE'],[{initiating:f.initiating('text')},'INITIATING_NOT_VOICE'],
  ] as const){const c=await f.open({initiating:f.initiating(),...options});assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,reason);await cancel(f,c.payment_id);}
  const first=await f.open({initiating:f.initiating()});await f.advance(f.config.auto.undo_s*1000);await f.complete(first.payment_id);
  const second=await f.open({initiating:f.initiating()});assert.equal(f.authority.store.getPayment(second.payment_id)!.reason,'SAME_PAYEE_RECENT');await cancel(f,second.payment_id);
  await f.advance(f.config.auto.same_payee_window_s*1000+1);
  const p=f.authority.store.policy('owner');f.authority.store.setPolicy({...p,limits:{auto_day_fen:2000}});
  const day=await f.open({initiating:f.initiating()});assert.equal(f.authority.store.getPayment(day.payment_id)!.reason,'OVER_AUTO_DAY_LIMIT');
});
test('S13 S14 I4 I15: locked glasses voice and forbidden card actors never grant; owner scope rejects',async t=>{
  const f=await ready(t);f.terminals.wear(glasses,false);
  const c=await f.open({initiating:f.initiating('voice',glasses)});await f.authority.observePayUtterance('owner',f.utterance(glasses));
  assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,'TERMINAL_LOCKED');
  for(const source of [glasses,{...phone,device_id:'watch',device_type:'watch' as const},{...phone,device_id:'mac',device_type:'mac' as const}])
    await assert.rejects(f.pay(c.payment_id,source),/PAYMENT_TERMINAL_NOT_ALLOWED/);
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  const source=await f.request();const intent=f.authority.store.getIntent(source.intent_id as string)!;
  assert.equal(f.authority.source(intent.run_id,intent.intent_id),true);assert.equal(f.authority.source('another-run',intent.intent_id),false);
  const refused=await f.request(f.initiating(),null,false);assert.equal(refused.status,'rejected');assert.equal(refused.error_code,'PAYMENT_SOURCE_NOT_OWNER');
  f.revoke(phone);await assert.rejects(f.pay(c.payment_id),/fixture device revoked/);assert.equal(f.authority.keys.registered(phone,'device'),undefined);
  assert.equal(f.authority.store.locks('owner').some(l=>l.device_id==='phone'),false);assert.equal(f.authority.store.policy('owner').voice_enabled,false);
});
test('I5 I15: inactive transport clears its lease while durable pairing keys and policy survive reconnect',async t=>{
  const f=await ready(t,true),revalidate=f.ports.revalidate;
  f.ports.revalidate=async()=>{throw Object.assign(new Error('SOURCE_BINDING_INACTIVE'),{code:'SOURCE_BINDING_INACTIVE'});};
  await assert.rejects(f.authority.input(phone,{operation:'payment_settings_get'}),/SOURCE_BINDING_INACTIVE/);
  f.ports.revalidate=revalidate;
  assert.ok(f.authority.keys.registered(phone,'device'));assert.ok(f.authority.keys.registered(phone,'user'));
  assert.equal(f.authority.store.locks('owner').find(l=>l.device_id==='phone')!.enabled,true);
  assert.equal(f.authority.store.policy('owner').auto_enabled,true);assert.equal(await f.authority.leases.valid(phone),false);
  await f.unlock();assert.equal(await f.authority.leases.valid(phone),true);
  const c=await f.open();await f.pay(c.payment_id);assert.equal(state(f,c.payment_id),'granted');
});
test('I15: paired-device revocation removes durable keys and locks once even through repeated rejection paths',async t=>{
  const f=await ready(t,true);f.revoke(phone);
  await assert.rejects(f.authority.input(phone,{operation:'payment_settings_get'}),/fixture device revoked/);
  f.authority.sourceRejected(phone,Object.assign(new Error('revoked'),{code:'PAIRED_DEVICE_REVOKED'}));
  assert.equal(f.authority.keys.registered(phone,'device'),undefined);assert.equal(f.authority.keys.registered(phone,'user'),undefined);
  assert.equal(f.authority.store.locks('owner').some(l=>l.device_id==='phone'),false);
  assert.equal(f.authority.store.policy('owner').voice_enabled,false);assert.equal(f.authority.store.policy('owner').auto_enabled,false);
  const events=f.authority.store.db.prepare("SELECT data FROM events WHERE kind='keys_revoked'").all();assert.equal(events.length,2);
});
test('A8.4 I10 I15: an offline initiating terminal still gets a card and its durable update replays on attach',async t=>{
  const f=await paymentFixture(t),requested=await f.request(),revalidate=f.ports.revalidate,update=f.ports.update;
  const checkpoint={intent_id:String(requested.intent_id),job_id:'offline-job',seq:1,app:'千问',checkout:'cashier' as const,
    amount_fen:1660,payee:'一点点',items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:new Date(f.now).toISOString()};
  f.ports.revalidate=async()=>{throw Object.assign(new Error('SOURCE_BINDING_INACTIVE'),{code:'SOURCE_BINDING_INACTIVE'});};
  f.ports.update=async()=>{throw new Error('fixture update offline');};
  await assert.rejects(f.authority.checkpoint(checkpoint),/fixture update offline/);
  const replay=await f.authority.checkpoint(checkpoint),payment_id=String(replay.payment_id);
  assert.equal(replay.state,'awaiting_owner');assert.equal(f.authority.store.getGrant(payment_id),undefined);
  assert.ok(f.authority.keys.registered(phone,'device'));
  f.ports.revalidate=revalidate;f.ports.update=update;const projections:Record<string,unknown>[]=[];
  await f.authority.watch({...phone},async p=>{projections.push(p);});await new Promise(resolve=>setImmediate(resolve));
  assert.ok((projections.find(p=>p.operation==='payment_cards')!.cards as Record<string,unknown>[]).some(p=>p.payment_id===payment_id));
  assert.equal(f.updates.filter(u=>u.payment_id===payment_id&&u.event==='card_opened').length,1);
});
test('S15 I3: write-ahead tap timeout is unknown and never regranted or cancelled',async t=>{
  const f=await paymentFixture(t),c=await f.open();await f.pay(c.payment_id);const g=f.authority.store.getGrant(c.payment_id)!;
  await f.authority.tap(c.payment_id,{grant_id:g.grant_id,step:1,read_amount_fen:g.amount_fen,screen_sha256:'b'.repeat(64)});
  await assert.rejects(cancel(f,c.payment_id),/PAYMENT_ALREADY_PAYING/);await f.advance(f.config.result_timeout_s*1000);
  assert.equal(state(f,c.payment_id),'outcome_unknown');await f.pay(c.payment_id);assert.equal(state(f,c.payment_id),'outcome_unknown');
  assert.equal(f.authority.store.events(c.payment_id).filter(e=>e.kind==='grant_issued').length,1);
});
test('S16 I13 I14: restart retains card/grant/tap lifecycle, voids verification/undo, staging closes snapshot',async t=>{
  for(const target of PAYMENT_STATES)await t.test(target,async t=>{
    const f=await ready(t,true),c=await f.open({initiating:f.initiating('text')});
    f.authority.store.updatePayment(c.payment_id,{state:target,auto_at_ms:target==='auto_pending'?f.now+5000:null,finished_at_ms:TERMINAL_STATES.includes(target)?f.now:null});
    if(TERMINAL_STATES.includes(target))f.authority.store.updateIntent(c.intent_id,{state:'closed',closed_reason:target});
    if(target==='granted'||target==='paying'){
      f.authority.store.insertGrant({grant_id:`grant-${target}`,payment_id:c.payment_id,amount_fen:1660,payee_key:'fixture',method:'card',device_id:'phone',issued_at_ms:f.now,expires_at_ms:f.now+60000,taps:target==='paying'?1:0,first_tap_at_ms:target==='paying'?f.now:null});
    }
    f.reopen();await f.authority.tick();
    assert.equal(state(f,c.payment_id),target==='auto_pending'||target==='verifying'?'awaiting_owner':target);
    if(target==='auto_pending')assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,'AUTO_INTERRUPTED');
    await f.advance(60000);if(target==='granted')assert.equal(state(f,c.payment_id),'expired');
    await f.advance(60000);if(target==='paying')assert.equal(state(f,c.payment_id),'outcome_unknown');
    f.reopen({...f.config,staging:true});await f.authority.tick();
    if(TERMINAL_STATES.includes(target))assert.equal(state(f,c.payment_id),target);else assert.ok(TERMINAL_STATES.includes(state(f,c.payment_id)));
    if(target==='awaiting_owner')assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,'STAGING_SNAPSHOT');
  });
});
test('S17 I6 I7 I15: signed settings prerequisites, invalid signature, unsigned off and voiceprint cascade',async t=>{
  const f=await paymentFixture(t);f.owner(false);
  const change={kind:'auto',enabled:true},nonce=(await f.authority.keys.challenge(phone,'settings')).nonce,policy_version=f.authority.store.policy('owner').version;
  await assert.rejects(f.authority.input(phone,{operation:'payment_settings_set',control_id:'bad-signature',change,policy_version,...signed(f.dev,{purpose:'settings',device_id:'phone',nonce,change,policy_version})}),/PAYMENT_SIGNATURE_INVALID/);
  await assert.rejects(f.settings({kind:'auto',enabled:true}),/PAYMENT_PREREQUISITE_MISSING/);
  await assert.rejects(f.settings({kind:'auto',enabled:true},false),/PAYMENT_SIGNATURE_REQUIRED/);
  assert.equal((await f.settings({kind:'auto',enabled:false},false)).ok,true);
  f.owner(true);await f.locks();assert.equal((await f.settings({kind:'voice',enabled:true})).ok,true);
  assert.equal((await f.settings({kind:'auto',enabled:true})).ok,true);
  f.owner(false);await f.authority.cascade('owner','VOICEPRINT_FORGOTTEN');
  assert.equal(f.authority.store.policy('owner').voice_enabled,false);assert.equal(f.authority.store.policy('owner').auto_enabled,false);
});
test('S18: glasses enrolment is approval bound, consumed only on success and expires',async t=>{
  const f=await ready(t);assert.equal(await f.authority.enrolmentAllowed(glasses),false);
  const grant=async()=>f.approve(await f.authority.leases.requestApproval(glasses,'voiceprint_enrol'));
  await grant();assert.equal(await f.authority.enrolmentAllowed(glasses),true);
  await f.authority.leases.consumeEnrolment(glasses,'inconsistent');assert.equal(await f.authority.enrolmentAllowed(glasses),true);
  await f.authority.leases.consumeEnrolment(glasses,'enrolled');assert.equal(await f.authority.enrolmentAllowed(glasses),false);
  await grant();await f.advance(f.config.enrolment.grant_ttl_s*1000);await assert.rejects(f.authority.enrolmentAllowed(glasses),/VOICEPRINT_ENROL_GRANT_EXPIRED/);
  await f.authority.input(glasses,{operation:'voiceprint_enrol_request',control_id:'conversation-1',purpose:'conversation'});
  const [approval]=await f.authority.leases.approvals(phone);assert.equal(approval!.kind,'voice_enrollment');
  await f.approve(approval!.approval_id as string);
  assert.equal(await f.authority.enrolmentAllowed(glasses,'voice_enrollment'),true);
  await assert.rejects(f.authority.enrolmentAllowed(glasses),/VOICEPRINT_ENROL_GRANT_EXPIRED/,'the payment sentences stay ungranted');
  const lock:Record<string,unknown>[]=[];const stop=await f.authority.watch(glasses,async p=>{if(p.operation==='payment_lock_state')lock.push(p);});stop();
  assert.equal((lock.at(-1)!.voice_enrollment as {granted:boolean}).granted,true);assert.equal((lock.at(-1)!.enrolment as {granted:boolean}).granted,false);
});
test('S19 I10: verification abort never taps and leaves order for owner completion',async t=>{
  const f=await paymentFixture(t),c=await f.open();await f.pay(c.payment_id);
  await f.authority.abort(c.payment_id,{reason:'VERIFICATION_REQUIRED',grant_id:f.authority.store.getGrant(c.payment_id)!.grant_id});
  assert.equal(state(f,c.payment_id),'failed');assert.equal(f.authority.store.getPayment(c.payment_id)!.order_cancel,'not_needed');
  assert.equal(f.authority.store.getGrant(c.payment_id)!.taps,0);
});
test('S21: asynchronous voice result loses to card/cancel and grant-time relock',async t=>{
  const f=await ready(t);
  for(const winner of ['card','cancel','relock'] as const){
    const c=await f.open({initiating:f.initiating()});let resolve!:(value:typeof passing)=>void;
    f.deferVoice(new Promise(r=>{resolve=r;}));const verification=f.authority.observePayUtterance('owner',f.utterance());
    for(let n=0;n<30&&state(f,c.payment_id)!=='verifying';n++)await new Promise<void>(r=>setImmediate(r));
    assert.equal(state(f,c.payment_id),'verifying');
    if(winner==='card')await f.pay(c.payment_id);else if(winner==='cancel')await cancel(f,c.payment_id);else await f.authority.leases.presence(phone,'locked');
    resolve(passing);await verification;f.deferVoice(undefined);
    assert.equal(state(f,c.payment_id),winner==='card'?'granted':winner==='cancel'?'cancelled':'awaiting_owner');
    if(winner==='card')await f.complete(c.payment_id);
    if(winner==='relock'){assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,'TERMINAL_LOCKED');await assert.rejects(f.pay(c.payment_id),/PAYMENT_TERMINAL_LOCKED/);}
    await f.advance(3001);
  }
});
for(const path of ['card','voice','auto'] as const)test(`I5 D13: ${path} grant rechecks a lock that arrives after asynchronous lease validation`,async t=>{
  const f=await ready(t,path==='auto'),c=await f.open({initiating:f.initiating(path==='card'?'text':'voice',phone)});
  let release:(value:typeof passing)=>void=()=>{},pending:Promise<void>|undefined;
  if(path==='voice'){
    f.deferVoice(new Promise(resolve=>{release=resolve;}));pending=f.authority.observePayUtterance('owner',f.utterance(phone));
    await new Promise(resolve=>setImmediate(resolve));assert.equal(state(f,c.payment_id),'verifying');
  }
  const valid=f.authority.leases.valid.bind(f.authority.leases);let locked=false;
  f.authority.leases.valid=async(...args:Parameters<typeof valid>)=>{
    const snapshot=await valid(...args);
    if(snapshot&&!locked){locked=true;await f.authority.leases.presence(phone,'locked');}
    return snapshot;
  };
  if(path==='card')await assert.rejects(f.pay(c.payment_id),/PAYMENT_TERMINAL_LOCKED/);
  else if(path==='voice'){release(passing);await pending;}
  else await f.advance(f.config.auto.undo_s*1000);
  assert.equal(locked,true);assert.equal(state(f,c.payment_id),'awaiting_owner');assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
});
test('I5: source expiry during voice verification returns to the card and surfaces the source error',async t=>{
  const f=await ready(t),c=await f.open({initiating:f.initiating('voice',phone)});let release:(value:typeof passing)=>void=()=>{};
  f.deferVoice(new Promise(resolve=>{release=resolve;}));const pending=f.authority.observePayUtterance('owner',f.utterance(phone));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(state(f,c.payment_id),'verifying');
  f.ports.revalidate=async()=>{throw Object.assign(new Error('SOURCE_BINDING_INACTIVE'),{code:'SOURCE_BINDING_INACTIVE'});};
  release(passing);await assert.rejects(pending,/SOURCE_BINDING_INACTIVE/);
  assert.equal(state(f,c.payment_id),'awaiting_owner');assert.equal(f.authority.store.getPayment(c.payment_id)!.reason,'TERMINAL_LOCKED');
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);assert.ok(f.authority.keys.registered(phone,'device'));
});
test('executor HTTP fixture authenticates checkpoints and polls the authoritative method through paid',async t=>{
  const f=await paymentFixture(t),key='fixture-executor-secret-32-bytes-long',server=createServer((req,res)=>{void handlePaymentExecutor(req,res,f.authority,key,32768);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/internal/payment/executor/checkpoints`;
  const c=await f.open(),send=(token:string)=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(c.checkpoint)});
  const denied=await send('wrong');assert.equal(denied.status,401);assert.equal((await denied.json() as {error_code:string}).error_code,'PAYMENT_EXECUTOR_AUTH_REQUIRED');
  const accepted=await send(key);assert.equal(accepted.status,200);assert.equal((await accepted.json() as {payment_id:string}).payment_id,c.payment_id);
  const poll=async()=>{const response=await fetch(url.replace('/checkpoints',`/payments/${c.payment_id}`),{headers:{authorization:`Bearer ${key}`}});
    assert.equal(response.status,200);return await response.json() as Record<string,unknown>;};
  assert.equal((await poll()).method,undefined);
  await f.pay(c.payment_id);const granted=await poll();assert.equal(granted.state,'granted');assert.equal(granted.method,'card');assert.ok(granted.grant);
  await f.complete(c.payment_id);const paid=await poll();assert.equal(paid.state,'paid');assert.equal(paid.method,'card');assert.equal(paid.grant,undefined);
});

test('I2 I10: first tap at the card deadline expires the card even before its live grant deadline',async t=>{
  const f=await paymentFixture(t,{card_ttl_s:2}),c=await f.open(),opened=f.now;
  f.setNow(opened+1999);await f.pay(c.payment_id);const grant=f.authority.store.getGrant(c.payment_id)!;
  f.setNow(opened+2001);assert.ok(grant.expires_at_ms>f.now);
  await assert.rejects(f.authority.tap(c.payment_id,{grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'a'.repeat(64)}),/PAYMENT_GRANT_EXPIRED/);
  assert.equal(state(f,c.payment_id),'expired');assert.equal(f.authority.store.getGrant(c.payment_id)!.taps,0);
});
test('I10: failed notification cannot stop the timer from expiring the next card',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await paymentFixture(t,{card_ttl_s:1}),first=await f.open(),opened=f.now;
  f.setNow(opened+500);t.mock.timers.tick(500);const next=await f.open();let fail=false;
  await f.authority.watch(phone,async()=>{if(fail)throw Error('fixture disconnected notification');});fail=true;
  const drain=async()=>{for(let n=0;n<5;n++)await new Promise<void>(resolve=>setImmediate(resolve));};
  f.setNow(opened+1000);t.mock.timers.tick(500);await drain();
  assert.equal(state(f,first.payment_id),'expired');assert.equal(state(f,next.payment_id),'awaiting_owner');
  f.setNow(opened+1500);t.mock.timers.tick(500);await drain();assert.equal(state(f,next.payment_id),'expired');
});
test('I10: a pending owner lookup does not block another card deadline or executor poll',{timeout:2000},async t=>{
  const f=await ready(t,true),auto=await f.open({initiating:f.initiating()}),card=await f.open();
  let release!:(value:{live:boolean;phone_app:boolean;glasses:boolean})=>void;
  const started=Promise.withResolvers<void>();
  f.ports.owner=()=>new Promise(resolve=>{release=resolve;started.resolve();});f.setNow(f.now+f.config.auto.undo_s*1000);
  const checking=f.authority.tick();await started.promise;
  f.setNow(f.authority.store.getPayment(card.payment_id)!.expires_at_ms);
  try{assert.equal((await f.authority.poll(card.payment_id)).state,'expired');assert.equal(state(f,auto.payment_id),'expired');}
  finally{release({live:true,phone_app:true,glasses:true});await checking;}
});

for(const presence of ['background','locked'] as const)test(`phone ${presence} during auto undo ${presence==='locked'?'ends its lease immediately':'keeps ordinary background grace'}`,async t=>{
  const f=await ready(t,true),card=await f.open({initiating:f.initiating('voice',phone)});
  assert.equal(state(f,card.payment_id),'auto_pending');
  await f.authority.input(phone,{operation:'phone_presence',state:presence});
  assert.equal(await f.authority.leases.valid(phone),presence==='background');
  await f.advance(f.config.auto.undo_s*1000);
  assert.equal(state(f,card.payment_id),presence==='locked'?'awaiting_owner':'granted');
  if(presence==='locked'){
    assert.equal(f.authority.store.getGrant(card.payment_id),undefined);
    assert.equal(f.authority.store.getPayment(card.payment_id)!.reason,'TERMINAL_LOCKED');
    assert.ok(f.authority.store.events().some(e=>e.kind==='lease_ended'&&e.data.reason==='locked'));
  }
});

test('I7: cancel and unsigned OFF never read a failed registry, including watcher delivery',async t=>{
  const f=await ready(t,true),card=await f.open(),projections:Record<string,unknown>[]=[];
  let delivered=Promise.withResolvers<void>();
  await f.authority.watch(phone,async p=>{projections.push(p);if(p.operation==='payment_cards')delivered.resolve();});projections.length=0;delivered=Promise.withResolvers<void>();
  let ownerReads=0;const verifierBefore={...f.verifierCalls};
  f.ports.owner=async()=>{ownerReads++;throw new Error('fixture registry load failed');};
  await cancel(f,card.payment_id);assert.equal(state(f,card.payment_id),'cancelled');
  for(const kind of ['auto','voice'] as const){
    f.policy(true,true);await f.settings({kind,enabled:false},false);
    assert.equal(f.authority.store.policy('owner')[kind==='auto'?'auto_enabled':'voice_enabled'],false);
  }
  await delivered.promise;
  assert.equal(ownerReads,0);assert.deepEqual(f.verifierCalls,verifierBefore);assert.ok(projections.some(p=>p.operation==='payment_cards'));
  assert.ok(!projections.some(p=>p.operation==='payment_settings'));
  await assert.rejects(f.authority.input(phone,{operation:'payment_settings_set',policy_version:0,change:{kind:'voice',enabled:false}}),/PAYMENT_POLICY_VERSION_STALE/);
  await assert.rejects(f.settings({kind:'voice',enabled:true}),/fixture registry load failed/);assert.equal(ownerReads,1);
});
test('I5 I6: paired glasses without lock rows block voice/auto; no-glasses exception is principal scoped',async t=>{
  const f=await paymentFixture(t,{locks:{require_glasses_lock:false}});await f.known();await f.locks();
  f.authority.store.db.prepare("DELETE FROM locks WHERE device_type='glasses'").run();
  await assert.rejects(f.settings({kind:'voice',enabled:true}),e=>{assert.deepEqual((e as {missing:string[]}).missing,['GLASSES_LOCK']);return true;});
  f.policy(true,true);const blocked=await f.open({initiating:f.initiating()});
  assert.equal(state(f,blocked.payment_id),'awaiting_owner');assert.equal(f.authority.store.getPayment(blocked.payment_id)!.reason,'LOCKS_NOT_ENABLED');
  await f.authority.observePayUtterance('owner',f.utterance());assert.equal(state(f,blocked.payment_id),'awaiting_owner');
  assert.equal(f.authority.store.getPayment(blocked.payment_id)!.reason,'LOCKS_NOT_ENABLED');assert.equal(f.authority.store.getGrant(blocked.payment_id),undefined);
  await cancel(f,blocked.payment_id);f.paired([phone,{...glasses,principal_id:'foreign'}]);
  await f.settings({kind:'voice',enabled:true});await f.settings({kind:'auto',enabled:true});
  const allowed=await f.open({initiating:f.initiating()});assert.equal(state(f,allowed.payment_id),'auto_pending');
  f.paired([phone,glasses]);await f.advance(f.config.auto.undo_s*1000);
  assert.equal(state(f,allowed.payment_id),'awaiting_owner');assert.equal(f.authority.store.getPayment(allowed.payment_id)!.reason,'LOCKS_NOT_ENABLED');
});
test('I5: newly paired glasses during voice verification are re-read before grant',async t=>{
  const f=await paymentFixture(t,{locks:{require_glasses_lock:false}});await f.known();await f.locks();
  f.authority.store.db.prepare("DELETE FROM locks WHERE device_type='glasses'").run();f.paired([phone]);f.policy(true);
  const c=await f.open({initiating:f.initiating()});let release!:(v:typeof passing)=>void;
  f.deferVoice(new Promise(resolve=>{release=resolve;}));
  let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
  const unwatch=await f.authority.watch(phone,async p=>{if(p.operation==='payment_cards'&&state(f,c.payment_id)==='verifying')started();});
  const submission=f.authority.observePayUtterance('owner',f.utterance());
  try{await Promise.race([entered,submission.then(()=>{throw new Error('verification did not start');})]);f.paired([phone,glasses]);}
  finally{release(passing);await submission;unwatch();}
  assert.equal(state(f,c.payment_id),'awaiting_owner');assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
});
test('same-D revision survives; distinct call audio requires its own revision',async t=>{
  const f=await paymentFixture(t),revision='a'.repeat(64),otherRevision='b'.repeat(64);
  const d={raw_ref:'l5:'+revision,archive_revision:revision,captured_at:new Date(f.now).toISOString(),processed_event_id:'d-archive',
    content:{transcript:'给我买午饭'},processing:{path_id:'voice_frontend'},time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:f.now-2000,end_ms:f.now}} as unknown as import('../src/contracts.ts').ProcessedEvent;
  assert.equal((await f.authority.initiating(phone,d)).utterance?.archive_revision,revision);
  const call={...d,content:{app_event:{kind:'voice_turn',audio:{raw_ref:'l5:'+otherRevision,start_ms:f.now-2000,end_ms:f.now}}}} as unknown as import('../src/contracts.ts').ProcessedEvent;
  assert.equal((await f.authority.initiating(phone,call)).kind,'other_voice');
  (call.content as {app_event:{audio:{archive_revision?:string}}}).app_event.audio.archive_revision=otherRevision;
  assert.equal((await f.authority.initiating(phone,call)).utterance?.archive_revision,otherRevision);
});

test('pre-lock unlock request held at revalidation cannot create a post-lock approval',async t=>{
  const f=await paymentFixture(t);await f.locks();f.authority.leases.lock(glasses,'screen_off');
  const connection=f.terminals.connectionIdentity(glasses),revalidate=f.ports.revalidate;
  const entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();let first=true;
  f.ports.revalidate=async source=>{if(first&&source.device_id===glasses.device_id){first=false;entered.resolve();await resume.promise;}return revalidate(source);};
  const pending=f.authority.input(glasses,{operation:'glasses_unlock_request',control_id:'pre-lock',lock_cycle:0});
  try {
    await entered.promise;
    await f.authority.input(glasses,{operation:'glasses_lock',control_id:'screen-off',reason:'screen_off'});
    assert.equal(f.terminals.connectionIdentity(glasses),connection);
    assert.equal(await f.authority.leases.valid(glasses),false);
    resume.resolve();await assert.rejects(pending,/APPROVAL_WEAR_CHANGED/);
    assert.deepEqual(await f.authority.leases.approvals(phone),[]);assert.equal(f.terminals.lease(glasses),undefined);
    await f.authority.input(glasses,{operation:'glasses_unlock_request',control_id:'post-lock',lock_cycle:0});
    const [fresh]=await f.authority.leases.approvals(phone);assert.ok(fresh);
    await f.approve(fresh.approval_id as string);assert.equal(await f.authority.leases.valid(glasses),true);
  }finally{resume.resolve();await pending.catch(()=>{});f.ports.revalidate=revalidate;}
});

for(const operation of ['glasses_unlock_request','glasses_lock'] as const)test(`deferred ${operation} cannot mutate a replacement connection`,async t=>{
  const f=await paymentFixture(t);await f.locks();
  const revalidate=f.ports.revalidate;let release!:()=>void,entered!:()=>void,first=true;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),entry=new Promise<void>(resolve=>{entered=resolve;});
  f.ports.revalidate=async source=>{if(first&&source.device_id===glasses.device_id){first=false;entered();await blocked;}return revalidate(source);};
  const pending=f.authority.input(glasses,{operation,control_id:`stale-${operation}`,lock_cycle:0,reason:'screen_off'});
  try {
    await entry;
    f.terminals.connect(glasses,'replacement-session');f.terminals.wear(glasses,true,0);
    await f.approve(await f.authority.leases.requestApproval(glasses,'glasses_unlock',undefined,0));
    const lease=f.terminals.lease(glasses)!;assert.ok(lease);
    const approvals=await f.authority.leases.approvals(phone);
    release();await assert.rejects(pending,/APPROVAL_WEAR_CHANGED/);
    assert.deepEqual(f.terminals.lease(glasses),lease);
    assert.deepEqual(await f.authority.leases.approvals(phone),approvals);
  }finally{release();await pending.catch(()=>{});f.ports.revalidate=revalidate;}
});
test('a watcher of an ended terminal session is dropped quietly and never fails another terminal request',async t=>{
  const f=await paymentFixture(t),revalidate=f.ports.revalidate;let delivered=0;
  await f.authority.watch(glasses,async()=>{delivered++;},'ended-session');delivered=0;
  f.ports.revalidate=async s=>{if(s.device_id==='glasses')throw Object.assign(new Error('SOURCE_BINDING_INACTIVE'),{code:'SOURCE_BINDING_INACTIVE'});return revalidate(s);};
  await f.authority.cascade(phone.principal_id,'fixture');
  f.ports.revalidate=revalidate;await f.authority.cascade(phone.principal_id,'fixture');
  assert.equal(delivered,0,'the stale watcher was removed, not retried');
});
