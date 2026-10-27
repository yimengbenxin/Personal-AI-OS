import {check} from '../contracts.ts';
import type {Limits, PaymentConfig, PaymentPolicy} from './contracts.ts';
import {PAYMENT_MAX_RELOCK_CHOICES} from './wire-budget.ts';

export const DEFAULT_PAYMENT_CONFIG:PaymentConfig={
  enabled:false,staging:false,card_ttl_s:300,intent_ttl_s:1800,grant_ttl_s:60,result_timeout_s:120,
  max_recards_per_intent:2,request_freshness_s:600,challenge_ttl_s:120,cards:{recent_s:600},card:{max_amount_fen:null},
  voice:{max_order_fen:20000,max_attempts_per_card:2,pay_phrases:['付吧'],carrier_ms:1500,require_same_terminal:true},
  auto:{max_order_fen:5000,max_day_fen:15000,undo_s:5,same_payee_window_s:1800},anomaly:{max_per_day:2},
  limits:{max_settable_fen:100000},
  locks:{require_glasses_lock:true,phone_relock_s:60,phone_relock_choices_s:[0,60,300,900],phone_lease_max_s:43200,
    glasses_lease_max_s:43200,glasses_unlock_request_ttl_s:120,glasses_wear_poll_ms:2000},
  enrolment:{request_ttl_s:120,grant_ttl_s:600},notify:{push:false},
};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
/** Provisioning accepts only the frozen A11 keys; partial nested sections inherit their defaults. */
export function parsePaymentConfig(input:unknown={}):PaymentConfig {
  const merge=(base:Record<string,unknown>,value:unknown,path:string):Record<string,unknown>=>{
    check(object(value),'PAYMENT_CONFIG_INVALID');
    const result=structuredClone(base);
    for(const [key,v] of Object.entries(value)){
      check(Object.hasOwn(base,key)||(path==='payment'&&key==='executor_key_file'),'PAYMENT_CONFIG_UNKNOWN_KEY');
      const expected=base[key];
      if(object(expected))result[key]=merge(expected,v,`${path}.${key}`);
      else {
        const name=`${path}.${key}`;
        if(key==='executor_key_file')check(typeof v==='string'&&v.length>0,'PAYMENT_CONFIG_INVALID');
        else if(expected===null)check(v===null||(Number.isSafeInteger(v)&&Number(v)>0),'PAYMENT_CONFIG_INVALID');
        else if(typeof expected==='boolean')check(typeof v==='boolean','PAYMENT_CONFIG_INVALID');
        else if(typeof expected==='number')check(Number.isSafeInteger(v)&&Number(v)>=(['max_recards_per_intent','phone_relock_s','undo_s'].includes(key)?0:1),'PAYMENT_CONFIG_INVALID');
        else if(typeof expected==='string')check(typeof v==='string'&&v.length>0,'PAYMENT_CONFIG_INVALID');
        else if(Array.isArray(expected)){
          check(Array.isArray(v)&&v.length>0,'PAYMENT_CONFIG_INVALID');
          check(name.endsWith('pay_phrases')?v.every(x=>typeof x==='string'&&x.trim().length>0):v.every(x=>Number.isSafeInteger(x)&&Number(x)>=0),'PAYMENT_CONFIG_INVALID');
        }
        result[key]=v;
      }
    }
    return result;
  };
  const config=merge(DEFAULT_PAYMENT_CONFIG as unknown as Record<string,unknown>,input,'payment') as unknown as PaymentConfig;
  check(config.locks.phone_relock_choices_s.length<=PAYMENT_MAX_RELOCK_CHOICES&&config.locks.phone_relock_choices_s.includes(config.locks.phone_relock_s),'PAYMENT_CONFIG_INVALID');
  check(config.card_ttl_s<=300&&config.grant_ttl_s<=60&&config.request_freshness_s<=600&&config.locks.glasses_lease_max_s<=43200,'PAYMENT_CONFIG_INVALID');
  check(!config.enabled||Boolean(config.executor_key_file),'PAYMENT_CONFIG_EXECUTOR_KEY_REQUIRED');
  return config;
}
export function effectiveLimits(policy:PaymentPolicy,config:PaymentConfig):Limits {
  return {auto_order_fen:policy.limits.auto_order_fen??config.auto.max_order_fen,
    auto_day_fen:policy.limits.auto_day_fen??config.auto.max_day_fen,
    voice_order_fen:policy.limits.voice_order_fen??config.voice.max_order_fen};
}
/** Calendar-day accounting uses real local midnights, including 23/25-hour DST days. */
export function localDayBounds(now:number,timeZone:string):{start:number;end:number} {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const day=(t:number)=>formatter.format(t);
  const current=day(now);
  const boundary=(low:number,high:number,left:boolean)=>{
    while(high-low>1){const mid=Math.floor((low+high)/2);if((day(mid)===current)===left)high=mid;else low=mid;}
    return high;
  };
  return {start:boundary(now-48*3600000,now,true),end:boundary(now,now+48*3600000,false)};
}
export const nextLocalMidnight=(now:number,timeZone:string):number=>localDayBounds(now,timeZone).end;
