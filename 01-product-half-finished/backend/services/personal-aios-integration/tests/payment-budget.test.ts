import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentFixture} from './payment-fixture.ts';
import {localDayBounds} from '../src/payment/config.ts';

// These tests call only the isolated SQLite authority. No executor or device input is dispatched.
test('I-02: a pre-midnight card reserves the grant day; unknown survives restart and blocks the fourth ¥50',async t=>{
  const f=await paymentFixture(t);await f.known();
  const midnight=Date.parse('2026-10-14T16:00:00Z');
  f.setNow(midnight-2000);await f.locks();f.policy(true,true);
  const first=await f.open({initiating:f.initiating(),amount:5000});
  await f.advance(5000);
  const grant=f.authority.store.getGrant(first.payment_id)!;
  assert.equal(grant.issued_at_ms,midnight+3000);
  assert.ok(f.authority.store.getPayment(first.payment_id)!.created_at_ms<midnight);
  await f.authority.tap(first.payment_id,{grant_id:grant.grant_id,step:1,read_amount_fen:5000,screen_sha256:'b'.repeat(64)});
  await f.authority.result(first.payment_id,{grant_id:grant.grant_id,outcome:'unknown',signs:[],screen_sha256:'c'.repeat(64)});
  f.reopen();assert.equal(f.authority.store.autoUsed('owner',midnight,midnight+86400000),5000);
  for(let n=2;n<=4;n++){
    await f.advance(f.config.auto.same_payee_window_s*1000+1);await f.locks();
    const card=await f.open({initiating:f.initiating(),amount:5000});await f.advance(5000);
    if(n<4){assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'granted');await f.complete(card.payment_id);}
    else {assert.equal(f.authority.store.getPayment(card.payment_id)!.reason,'OVER_AUTO_DAY_LIMIT');assert.equal(f.authority.store.getGrant(card.payment_id),undefined);}
  }
  assert.equal(f.authority.store.autoUsed('owner',midnight,midnight+86400000),15000);
  assert.equal(f.authority.store.autoUsed('owner',midnight-86400000,midnight),0);
});

test('I-02: two prechecked cards atomically reserve the same remaining daily budget once',async t=>{
  const f=await paymentFixture(t);await f.known();
  const familiar=await f.open({payee:'第二家店'});await f.pay(familiar.payment_id);await f.complete(familiar.payment_id);
  await f.advance(f.config.auto.same_payee_window_s*1000+1);await f.locks();f.policy(true,true);
  const policy=f.authority.store.policy('owner');f.authority.store.setPolicy({...policy,limits:{auto_day_fen:5000}});
  const cards=await Promise.all(['一点点 南门店','第二家店'].map(payee=>f.open({payee,amount:5000,initiating:f.initiating()})));
  assert.ok(cards.every(c=>f.authority.store.getPayment(c.payment_id)!.state==='auto_pending'));
  await f.advance(5000);
  assert.equal(cards.filter(c=>f.authority.store.getGrant(c.payment_id)).length,1);
  assert.equal(cards.filter(c=>f.authority.store.getPayment(c.payment_id)!.reason==='OVER_AUTO_DAY_LIMIT').length,1);
});

for(const [zone,instant,hours] of [
  ['Asia/Taipei','2026-10-14T12:00:00Z',24],
  ['UTC','2026-10-14T12:00:00Z',24],
  ['America/Los_Angeles','2026-03-08T15:00:00Z',23],
  ['America/Los_Angeles','2026-11-01T15:00:00Z',25],
] as const)test(`I-02: ${zone} ${hours}h day expires unused auto grant at midnight without moving its reservation`,async t=>{
  const f=await paymentFixture(t,{},true,zone);f.setNow(Date.parse(instant)-3600000);await f.unlock();await f.known();
  const day=localDayBounds(Date.parse(instant),zone);assert.equal(day.end-day.start,hours*3600000);
  f.setNow(day.end-6000);await f.locks();f.policy(true,true);
  const card=await f.open({initiating:f.initiating(),amount:5000});await f.advance(5000);
  const grant=f.authority.store.getGrant(card.payment_id)!;assert.equal(grant.expires_at_ms,day.end);
  assert.equal(f.authority.store.autoUsed('owner',day.start,day.end),5000);
  f.setNow(day.end);
  await assert.rejects(f.authority.tap(card.payment_id,{grant_id:grant.grant_id,step:1,read_amount_fen:5000,screen_sha256:'b'.repeat(64)}),/PAYMENT_GRANT_EXPIRED/);
  assert.equal(f.authority.store.getGrant(card.payment_id)!.taps,0);
  await f.authority.tick();assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'expired');
  assert.equal(f.authority.store.autoUsed('owner',day.start,day.end),0);
  assert.equal(f.authority.store.autoUsed('owner',day.end,day.end+86400000),0);
});

test('I-02: a debit admitted before midnight keeps its grant day after a late unknown result and replay',async t=>{
  const f=await paymentFixture(t);await f.known();const midnight=Date.parse('2026-10-14T16:00:00Z');
  f.setNow(midnight-6000);await f.locks();f.policy(true,true);
  const card=await f.open({initiating:f.initiating(),amount:5000});await f.advance(5000);
  const grant=f.authority.store.getGrant(card.payment_id)!;
  const tap={grant_id:grant.grant_id,step:1,read_amount_fen:5000,screen_sha256:'b'.repeat(64)};
  await f.authority.tap(card.payment_id,tap);f.setNow(midnight+1000);
  const result={grant_id:grant.grant_id,outcome:'unknown',signs:[],screen_sha256:'c'.repeat(64)};
  await f.authority.result(card.payment_id,result);f.reopen();
  await f.authority.tap(card.payment_id,tap);await f.authority.result(card.payment_id,result);
  assert.equal(f.authority.store.autoUsed('owner',midnight-86400000,midnight),5000);
  assert.equal(f.authority.store.autoUsed('owner',midnight,midnight+86400000),0);
  assert.equal(f.authority.store.events(card.payment_id).filter(e=>e.kind==='tap_started').length,1);
});
