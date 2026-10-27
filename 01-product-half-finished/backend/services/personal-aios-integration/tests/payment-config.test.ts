import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PAYMENT_CONFIG, effectiveLimits, localDayBounds, parsePaymentConfig} from '../src/payment/config.ts';

test('payment config: frozen defaults, nested overrides and unknown keys',()=>{
  assert.deepEqual(parsePaymentConfig(),DEFAULT_PAYMENT_CONFIG);
  assert.equal(parsePaymentConfig({auto:{undo_s:3}}).auto.max_day_fen,15000);
  for(const input of [{unknown:true},{auto:{unknown:1}},{auto:{max_order_fen:1.5}},{locks:{phone_relock_s:2}},
    {enabled:true},{voice:{pay_phrases:[]}},{enabled:'true'},{card_ttl_s:301},{grant_ttl_s:61},{request_freshness_s:601},{locks:{glasses_lease_max_s:43201}},
    {locks:{phone_relock_choices_s:Array(17).fill(60)}},{day_timezone:'UTC'}])assert.throws(()=>parsePaymentConfig(input));
  assert.equal(parsePaymentConfig({enabled:true,executor_key_file:'/secret/payment.key'}).enabled,true);
  const policy={principal_id:'owner',version:1,voice_enabled:true,auto_enabled:true,limits:{auto_order_fen:4000},paused_until_ms:null,updated_at_ms:0};
  assert.deepEqual(effectiveLimits(policy,parsePaymentConfig()),{auto_order_fen:4000,auto_day_fen:15000,voice_order_fen:20000});
});
test('local payment day boundaries preserve Taiwan midnight and both DST day lengths',()=>{
  const bounds=localDayBounds(Date.parse('2026-10-14T23:00:00Z'),'Asia/Taipei');
  assert.equal(new Date(bounds.start).toISOString(),'2026-10-14T16:00:00.000Z');
  assert.equal(new Date(bounds.end).toISOString(),'2026-10-15T16:00:00.000Z');
  for(const [day,hours] of [['2026-03-08T15:00:00Z',23],['2026-11-01T15:00:00Z',25]] as const){
    const b=localDayBounds(Date.parse(day),'America/Los_Angeles');assert.equal(b.end-b.start,hours*3600000);
    assert.deepEqual(localDayBounds(b.start,'America/Los_Angeles'),b);
  }
});
