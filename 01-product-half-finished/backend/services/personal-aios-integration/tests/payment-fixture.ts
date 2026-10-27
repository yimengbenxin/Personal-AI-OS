import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {parsePaymentConfig} from '../src/payment/config.ts';
import {TerminalCards} from '../src/terminal-cards.ts';
import {GLASSES_CAPABILITIES,type RegisteredDevice} from '../src/source-authority.ts';
import type {Checkpoint,Initiating,PaymentConfig,PaymentPorts,SettingsChange,UtteranceRef,VoiceVerdict} from '../src/payment/contracts.ts';
export const phone:RegisteredDevice={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text']};
export const glasses:RegisteredDevice={...phone,device_id:'glasses',device_type:'glasses',capabilities:GLASSES_CAPABILITIES};
export const passing:VoiceVerdict={verdict:'pass',initiating:{score:0.9,speech_ms:2000},pay:{score:0.9,speech_ms:500},combined:{score:0.9,speech_ms:2000},channel:'phone_app',speaker_model:'fake-fixture'};
export function keyPair(){const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),j=key.publicKey.export({format:'jwk'});return {...key,public_x963_b64:Buffer.concat([Buffer.from([4]),Buffer.from(j.x!,'base64url'),Buffer.from(j.y!,'base64url')]).toString('base64')};}
export function signed(key:ReturnType<typeof keyPair>,statement:object){const bytes=Buffer.from(JSON.stringify(statement));return {statement_b64:bytes.toString('base64'),signature_b64:sign('sha256',bytes,key.privateKey).toString('base64')};}
/** Isolated authority fixture. Verifier verdicts are explicit fakes; signatures and SQLite are real. */
export async function paymentFixture(t:TestContext,overrides:unknown={},phoneLock=true,time_zone='Asia/Taipei') {
  let now=Date.parse('2026-10-14T04:00:00Z'),serial=0,live=true,paired:RegisteredDevice[]=[phone,glasses];
  const directory=mkdtempSync(join(tmpdir(),'payment-authority-')),terminals=new TerminalCards(()=>now),dev=keyPair(),user=keyPair();
  const updates:{event:string;payment_id:string;extra?:Record<string,unknown>}[]=[],contexts:string[]=[],revoked=new Set<string>();
  const config=parsePaymentConfig({...overrides as Record<string,unknown>,enabled:true,executor_key_file:'/fixture/executor.key'});
  let ownerOverride=false;
  let payVerdict:VoiceVerdict=passing,initiatingVerdict:VoiceVerdict=passing,verifyPay:Promise<VoiceVerdict>|undefined,verifyInitiating:Promise<VoiceVerdict>|undefined;
  const verifierCalls={initiating:0,pay:0};
  const verifier={verifyInitiating:async()=>{verifierCalls.initiating++;return verifyInitiating??structuredClone(initiatingVerdict);},verifyPay:async()=>{verifierCalls.pay++;return verifyPay??structuredClone(payVerdict);}};
  const ports:PaymentPorts={revalidate:async source=>{if(revoked.has(source.device_id))throw Object.assign(new Error('fixture device revoked'),{code:'PAIRED_DEVICE_REVOKED'});return source;},
    devices:async principal=>principal==='owner'?paired.filter(s=>!revoked.has(s.device_id)):[],
    owner:async()=>({live,phone_app:live,glasses:live}),forget:async()=>{live=false;},
    update:async(_i,p,event,extra)=>{updates.push({event,payment_id:p.payment_id,...(extra?{extra}:{})});},context:async(_p,line)=>{contexts.push(line);},enrolment_sentences:['fixture sentence']};
  let authority=PaymentAuthority.open(directory,{config,time_zone,now:()=>now,verifier,terminals,owner_override_active:async()=>ownerOverride});authority.attach(ports);
  terminals.connect(glasses,'glasses-session');terminals.wear(glasses,true,0);
  t.after(()=>{authority.close();terminals.close();rmSync(directory,{recursive:true,force:true});});
  const register=async(key:typeof dev,role:'device'|'user')=>{
    const {nonce}=await authority.keys.challenge(phone,'keys_register'),statement={purpose:'keys_register',role,device_id:phone.device_id,nonce,key_sha256:createHash('sha256').update(Buffer.from(key.public_x963_b64,'base64')).digest('hex')};
    await authority.keys.register(phone,{role,public_x963_b64:key.public_x963_b64,...signed(key,statement),...(role==='user'?{device_signature_b64:signed(dev,statement).signature_b64}:{})});
  };
  await register(dev,'device');await register(user,'user');
  const archived=(source:RegisteredDevice):UtteranceRef=>({device_id:source.device_id,device_type:source.device_type as 'phone'|'glasses',raw_ref:`fixture-audio-${++serial}`,start_ms:now-2000,end_ms:now,captured_at:new Date(now).toISOString(),transcript:'付吧'});
  const utterance=(source:RegisteredDevice=phone):UtteranceRef=>{const start=now;now+=2000;return {...archived(source),captured_at:new Date(start).toISOString()};};
  const initiating=(kind:Initiating['kind']='voice',source:RegisteredDevice=phone):Initiating=>({kind,device_id:source.device_id,device_type:source.device_type,captured_at_ms:now,lease_at_capture:kind==='voice',...(kind==='voice'?{utterance:archived(source),verdict:structuredClone(initiatingVerdict)}:{})});
  const unlock=async()=>{const {nonce}=await authority.keys.challenge(phone,'phone_unlock');await authority.leases.unlock(phone,signed(user,{purpose:'phone_unlock',device_id:'phone',nonce}));};
  const approve=async(id:string)=>{const a=(await authority.leases.approvals(phone)).find(v=>v.approval_id===id)!;await authority.leases.decideApproval(phone,{approval_id:id,decision:'approve',...signed(user,{purpose:'approval',device_id:'phone',nonce:a.nonce,approval_id:id,kind:a.kind,target_device_id:'glasses',decision:'approve'})});};
  const locks=async()=>{
    authority.store.tx(()=>{for(const s of [phone,glasses])authority.store.setLock({device_id:s.device_id,principal_id:s.principal_id,device_type:s.device_type as 'phone'|'glasses',enabled:true,relock_s:null,updated_at_ms:now});});
    await unlock();await approve(await authority.leases.requestApproval(glasses,'glasses_unlock',undefined,0));
  };
  const policy=(voice=true,auto=false)=>authority.store.tx(()=>{const p=authority.store.policy('owner');authority.store.setPolicy({...p,voice_enabled:voice,auto_enabled:auto,updated_at_ms:now});});
  const request=async(init=initiating('text'),budget:number|null=null,eligible=true)=>authority.request({principal_id:'owner',run_id:`run-${++serial}`,tool_call_id:'tool',session_id:'session',processed_event_id:`d-${serial}`,initiating:init,initiating_text:'给我买午饭',purpose:'午饭',app:'千问',budget_fen:budget},eligible);
  const open=async(options:{initiating?:Initiating;amount?:number;payee?:string|null;budget?:number|null}={})=>{
    const requested=await request(options.initiating??initiating('text'),options.budget??null);assert.equal(requested.status,'accepted');
    const checkpoint:Checkpoint={intent_id:requested.intent_id as string,job_id:`job-${serial}`,seq:1,app:'千问',checkout:'cashier',amount_fen:options.amount??1660,payee:options.payee===undefined?'一点点 南门店':options.payee,items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:new Date(now).toISOString()};
    const response=await authority.checkpoint(checkpoint);return {intent_id:checkpoint.intent_id,payment_id:response.payment_id as string,checkpoint};
  };
  const pay=async(payment_id:string,source=phone)=>{const p=authority.store.getPayment(payment_id)!;const receipt=await authority.input(source,{operation:'payment_decide',control_id:`ctl-${++serial}`,payment_id,decision:'pay',...signed(dev,{purpose:'payment_decide',device_id:source.device_id,payment_id,decision:'pay',amount_fen:p.amount_fen,payee_key:p.payee_key,nonce:p.decision_nonce})});assert.ok(receipt);return receipt;};
  const complete=async(payment_id:string)=>{const g=authority.store.getGrant(payment_id)!;await authority.tap(payment_id,{grant_id:g.grant_id,step:1,read_amount_fen:g.amount_fen,screen_sha256:'b'.repeat(64)});await authority.result(payment_id,{grant_id:g.grant_id,outcome:'paid',signs:['支付成功'],screen_sha256:'c'.repeat(64)});};
  const known=async()=>{const card=await open();await pay(card.payment_id);await complete(card.payment_id);now+=config.auto.same_payee_window_s*1000+1;};
  const settings=async(change:SettingsChange,signInput=true)=>{const policy_version=authority.store.policy('owner').version;
    const signature=signInput?signed(user,{purpose:'settings',device_id:'phone',nonce:(await authority.keys.challenge(phone,'settings')).nonce,policy_version,change}):{};
    const receipt=await authority.input(phone,{operation:'payment_settings_set',control_id:`ctl-${++serial}`,policy_version,change,...signature});assert.ok(receipt);return receipt;};
  if(phoneLock){await settings({kind:'phone_lock',enabled:true});await unlock();}
  return {get authority(){return authority;},directory,config,terminals,updates,contexts,ports,verifierCalls,dev,user,utterance,initiating,unlock,approve,locks,policy,request,open,pay,complete,known,settings,
    get now(){return now;},advance:async(ms:number)=>{now+=ms;await authority.tick();},setNow:(value:number)=>{now=value;},
    override:(value:boolean)=>{ownerOverride=value;},
    verdict:(value:VoiceVerdict)=>{payVerdict=value;},initiatingVerdict:(value:VoiceVerdict)=>{initiatingVerdict=value;},deferVoice:(value:Promise<VoiceVerdict>|undefined)=>{verifyPay=value;},
    deferInitiating:(value:Promise<VoiceVerdict>|undefined)=>{verifyInitiating=value;},
    paired:(devices:RegisteredDevice[])=>{paired=devices;},owner:(value:boolean)=>{live=value;},revoke:(source:RegisteredDevice)=>{revoked.add(source.device_id);},
    reopen:(nextConfig:PaymentConfig=config)=>{authority.close();terminals.lock(glasses);authority=PaymentAuthority.open(directory,{config:nextConfig,time_zone,now:()=>now,verifier,terminals,owner_override_active:async()=>ownerOverride});authority.attach(ports);return authority;}};
}
