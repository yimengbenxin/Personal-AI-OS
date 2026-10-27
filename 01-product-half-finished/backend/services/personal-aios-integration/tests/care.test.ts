// Deterministic fall safety with fake host ports and timers; no messages are sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CareAuthority,type CarePorts} from '../src/care/authority.ts';
import {ContactsStore} from '../src/contacts/store.ts';
import {HealthStore,type HealthBatch} from '../src/health/store.ts';
import {DeviceLocations} from '../src/location.ts';
import type {ProcessedEvent} from '../src/contracts.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';

const T=Date.parse('2026-10-09T06:00:00.000Z');
const phone={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture'} as RegisteredDevice;
const fix={latitude:30.27,longitude:120.15,accuracy_m:12,observed_at:new Date(T).toISOString(),datum:'wgs84' as const,place:'西湖边'};
const fall=(id:string,e=T-5000,v=1):HealthBatch=>({control_id:`page-${id}`,metric:'numberOfTimesFallen',unit:'count',tz:'Asia/Shanghai',sources:['Watch'],
  samples:[{id:`00000000-0000-4000-8000-${id.padStart(12,'0')}`,s:e-1000,e,src:0,v}],deleted:[]});
/** Ds as admission hands them over: typed text, a call turn, verified/uncertain/guest voice, an errand's end, a care run. */
const d=(content:ProcessedEvent['content'],extra:Partial<ProcessedEvent>={})=>({principal_id:'owner',device_id:'phone',processed_event_id:`d:${Math.random()}`,
  captured_at:new Date(T).toISOString(),time_range:{kind:'instant',timebase_id:'utc_unix_ms',at_ms:T},origin:'device_observation',media_type:'app_event',user_identity:'unknown',segment_basis:null,processing:{path_id:'direct_app'},speakers:[],content,...extra}) as unknown as ProcessedEvent;
const typed=(text:string)=>d({text},{origin:'explicit_user_prompt',media_type:'text',user_identity:'owner'});
const callTurn=(user:string)=>d({app_event:{kind:'voice_turn',speaker:'owner',user,assistant:'',call_id:'c',turn:0,interrupted:false}},{user_identity:'owner'});
const voice=(voiceprint:string)=>d({transcript:'我没事'},{media_type:'audio',segment_basis:'speech_candidate',processing:{path_id:'local'} as never,
  user_identity:voiceprint==='owner'?'owner':'unknown',speakers:[{identity_scope:'local_voiceprint',voiceprint,score:0.8,speech_ms:1500,segments:1}]});
const errand=(task:string,success:boolean)=>d({app_event:{kind:'errand_result',task,success,answer:'',job_id:'job-1',finished_at:''}});
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};

const timed=new WeakSet<test.TestContext>();
async function setup(t:test.TestContext,time_zone='Asia/Taipei') {
  const directory=await mkdtemp(join(tmpdir(),'paios-care-'));
  const contacts=ContactsStore.open(join(directory,'contacts')),health=HealthStore.open(join(directory,'health'));
  contacts.ingest('owner','phone',{control_id:'cards',deleted:[],contacts:[{id:'a',name:'张丽',phones:[{number:'021-5555 1234',label:'_$!<Home>!$_'},
    {number:'139 0000 0001',label:'_$!<Mobile>!$_'}],relations:[]},{id:'b',name:'王强',phones:[],relations:[]}]});
  if(!timed.has(t)){timed.add(t);t.mock.timers.enable({apis:['setTimeout']});}
  const h={contacts,clock:T,memory:['称呼：示例用户','紧急联系人：妈妈 138-0000-0000\n紧急联系人：张丽（姐姐）'],care:undefined as unknown as CareAuthority,
    reachedAt:[] as (number|undefined)[],reached:[] as {id:string;text:string}[],sms:[] as {id:string;to:string;text:string}[],
    send:async(message:{id:string;to:string;text:string})=>{h.sms.push(message);},
    deliver:async()=>{},request:async()=>{},locations:undefined as unknown as DeviceLocations,
    sync(batch:HealthBatch) {health.ingest('owner','phone',batch);h.care.synced(phone,'session',batch.metric,health.records('owner',batch.metric,batch.samples.map(s=>s.id)));},
    open() {
      h.care=CareAuthority.open(join(directory,'care'),()=>h.clock,time_zone);
      const ports:CarePorts={contacts,locate:async(principal,device,refresh)=>{
        if(refresh&&!h.locations.fresh(principal,device))await h.request();
        return {current:h.locations.fresh(principal,device),last_known:h.locations.lastKnown(principal,device)};
      },memory:async()=>h.memory,sms:message=>h.send(message),
        reach:async(_principal,_device,id,text,at_ms)=>{await h.deliver();h.reached.push({id,text});h.reachedAt.push(at_ms);}};
      h.care.attach(ports);return h.care;
    },
    async advance(ms:number){h.clock+=ms;t.mock.timers.tick(ms);await settle();},
  };
  h.locations=new DeviceLocations(()=>h.clock);h.locations.observe('owner','phone',fix);h.open();
  t.after(async()=>{h.care.close();contacts.close();health.close();await rm(directory,{recursive:true,force:true});});
  return h;
}

test('a fall is checked on at once; without a response for 60 s every emergency contact is texted once', async t => {
  const h=await setup(t);
  h.sync({...fall('9'),metric:'stepCount',unit:'count'});
  h.sync(fall('2',T-5000,0));h.sync(fall('3',T-16*60_000));
  await settle();assert.equal(h.reached.length,0,'no fall, or a fall from the backlog');
  h.sync(fall('1'));h.sync(fall('1'));await settle();
  const care_id=h.reached[0]!.id.replace(/:checkin$/u,''),checkin='示例用户，你还好吗？手表说你可能摔倒了。没事就回我一句；1分钟没有回应，我会通知你的紧急联系人。';
  assert.deepEqual(h.reached,[{id:`${care_id}:checkin`,text:checkin}]);
  h.care.respond('owner',T-6000,'刚才');await h.advance(59_999);
  assert.equal(h.sms.length,0,'speech before the fall is no response; the timer has not run out');
  await h.advance(1);
  const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(T-5000);
  const text=`【依米紧急提醒】我是示例用户的AI助理依米。示例用户的手表在${stamp}检测到可能摔倒，已60秒无回应，可能受伤或失去意识。当前位置（台湾时间2026/10/9 14:00:00）：西湖边，`+
    'https://uri.amap.com/marker?position=120.15,30.27&coordinate=wgs84（误差约12米）。请尽快联系示例用户。';
  assert.deepEqual(h.sms.map(m=>[m.to,m.text]),[['13800000000',text],['13900000001',text]],'the entry\'s number; else the named card\'s mobile');
  assert.equal(new Set(h.sms.map(m=>m.id)).size,2);
  h.care.respond('owner',h.clock,'我没事');await h.advance(120_000);
  h.care.close();h.open();await h.advance(120_000);
  assert.equal(h.sms.length,2,'fired once: no response, timer or restart sends it again');
  assert.equal(h.reached.length,1,'contacts were texted: the owner is not told again');
  assert.ok(h.care.recent('owner').some(line=>/摔倒后60秒无回应：已短信通知紧急联系人妈妈、张丽$/u.test(line)));
});

test('lost or expired location reaches care only as last-known with its sensor time',async t=>{
  for(const lost of [true,false]){
    const h=await setup(t);
    if(lost)h.locations.observe('owner','phone',null);else h.clock+=16*60_000;
    h.sync(fall('1',h.clock));await settle();await h.advance(60_000);
    for(const text of h.sms.map(m=>m.text)){
      assert.match(text,/最后已知位置（台湾时间2026\/10\/9 14:00:00）：西湖边/u);
      assert.doesNotMatch(text,/当前位置/u);
    }
  }
});

test('an unavailable owner check-in still escalates an unanswered fall to emergency contacts',async t=>{
  const h=await setup(t),errors:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>errors.push(args));
  h.deliver=async()=>{throw new Error('CARE_OUTREACH_UNAVAILABLE');};
  h.sync(fall('1'));await settle();
  assert.equal(h.reached.length,0);assert.ok(errors.some(args=>args[0]==='CARE_OUTREACH_FAILED'));
  assert.ok(h.care.recent('owner').some(line=>line.includes('关心未送达：')));
  await h.advance(60_000);
  assert.equal(h.sms.length,2);assert.equal(new Set(h.sms.map(message=>message.id)).size,2);
});

test('emergency uses the requested fresh fix; an answer during the one-shot prevents SMS',async t=>{
  const h=await setup(t);h.sync(fall('1'));await settle();h.locations.observe('owner','phone',null);
  h.request=async()=>{h.locations.observe('owner','phone',{...fix,longitude:121.5,place:'台北车站',observed_at:new Date(h.clock).toISOString()});};
  await h.advance(60_000);assert.equal(h.sms.length,2);
  assert.match(h.sms[0]!.text,/当前位置（台湾时间2026\/10\/9 14:01:00）：台北车站/u);
  assert.match(h.sms[0]!.text,/position=121.5,30.27/u);
  const g=await setup(t);g.sync(fall('2'));await settle();g.locations.observe('owner','phone',null);
  const pending=Promise.withResolvers<void>();g.request=()=>pending.promise;
  await g.advance(60_000);g.care.respond('owner',g.clock,'没事');pending.resolve();await settle();
  assert.equal(g.sms.length,0);
});

test('any owner response stands the escalation down; guests and an unconfirmed voice do not', async t => {
  const cancels:[string,(h:Awaited<ReturnType<typeof setup>>)=>void][]=[
    ['chat reply',h=>h.care.admitted(typed('没事，滑了一下'))],
    ['call reply',h=>h.care.admitted(callTurn('我没事'))],
    ['owner-verified speech on the device',h=>h.care.respond('owner',h.clock)],
    ['owner-verified voice turn',h=>h.care.admitted(voice('owner'))],
    ['later owner segment in an older capture',h=>h.care.admitted({...voice('owner'),captured_at:new Date(T-60_000).toISOString(),
      time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:h.clock-1000,end_ms:h.clock}})],
    ['explicit 我没事',h=>h.care.respond('owner',h.clock,'我没事')]];
  for(const [name,respond] of cancels) {
    const h=await setup(t);
    h.sync(fall('1'));await settle();
    await h.advance(30_000);respond(h);await h.advance(60_000);
    assert.equal(h.sms.length,0,name);
  }
  const inflight=await setup(t),delivery=Promise.withResolvers<void>();inflight.deliver=()=>delivery.promise;
  inflight.sync(fall('10'));await settle();inflight.care.admitted(typed('没事，扶着了'));delivery.resolve();await settle();
  assert.ok(inflight.care.recent('owner').some(line=>line.endsWith('主人：没事，扶着了')),'an answer during the first safety check-in is retained');
  await inflight.advance(60_000);assert.equal(inflight.sms.length,0);
  const h=await setup(t);
  h.sync(fall('1'));await settle();
  h.care.admitted(voice('speaker:3'));h.care.admitted(voice('owner_uncertain'));h.care.admitted(errand('x',true));
  h.care.admitted(d({app_event:{kind:'voice_turn',user:'',assistant:'我在呢，你还好吗？',call_id:'c',turn:0,interrupted:false}},{user_identity:'owner'}));
  h.care.respond('stranger',h.clock,'我没事');
  await h.advance(60_000);assert.equal(h.sms.length,2,'assistant-only call greetings are not owner responses');
});

test('delayed falls reconcile later verified responses across restart; a subsequent unanswered fall still escalates',async t=>{
  for(const answer of [typed('我没事'),callTurn('我没事'),voice('owner')]){
    const h=await setup(t);h.care.admitted(answer);
    h.care.respond('owner',T-6000,'更早的话');h.care.close();h.open();
    h.sync(fall('1'));h.sync(fall('1'));await settle();await h.advance(60_000);
    assert.equal(h.reached.length+h.sms.length,0,'answered fall causes no check-in, run or alert');
    h.sync(fall('2',h.clock));await settle();await h.advance(60_000);
    assert.equal(h.sms.length,2,'the saved response precedes this new fall and cannot suppress its emergency');
  }
});

test('unverified, foreign or pre-fall responses cannot suppress delayed fall escalation',async t=>{
  const h=await setup(t);
  h.care.admitted(voice('speaker:3'));h.care.admitted(voice('owner_uncertain'));
  h.care.respond('stranger',T,'我没事');h.care.respond('owner',T-6000,'刚才');
  h.sync(fall('1'));await settle();await h.advance(60_000);
  assert.equal(h.sms.length,2);
});

test('fall SMS resolves only the current contact snapshot; true homonyms stay unreachable',async t=>{
  const h=await setup(t);h.memory=['紧急联系人：张丽'];
  const replacement={id:'new',name:'张丽',phones:[{number:'13900000002',label:'手机'}],relations:[]};
  h.contacts.ingest('owner','replacement',{control_id:'new-cards',contacts:[replacement],deleted:[]});
  h.sync(fall('1'));await settle();await h.advance(60_000);
  assert.deepEqual(h.sms.map(m=>m.to),['13900000002']);
  h.contacts.ingest('owner','replacement',{control_id:'homonym',contacts:[{...replacement,id:'other',phones:[{number:'13900000003',label:'手机'}]}],deleted:[]});
  h.sync(fall('2',h.clock));await settle();await h.advance(60_000);
  assert.equal(h.sms.length,1,'no arbitrary selection between two current cards');
  assert.match(h.reached.at(-1)!.text,/未确认给紧急联系人张丽发出短信/u);
});

test('no emergency contact, or none reachable: recorded and the owner\'s phone is told', async t => {
  const h=await setup(t);h.memory=['称呼：示例用户'];
  h.sync(fall('1'));await settle();await h.advance(60_000);
  assert.equal(h.sms.length,0);
  assert.equal(h.reached[1]!.text,'示例用户，你摔倒后1分钟没有回应，没有找到紧急联系人，没能通知任何人。你还好吗？');
  const g=await setup(t);g.memory=['紧急联系人：王强','紧急联系人：老李 13800000000'];
  g.send=async()=>{throw new Error('SPOOL_DOWN');};
  t.mock.method(console,'error',()=>{});
  g.sync(fall('1'));await settle();await g.advance(60_000);
  assert.equal(g.reached[1]!.text,'你摔倒后1分钟没有回应，未确认给紧急联系人王强、老李发出短信。你还好吗？','王强 has no number; the SMS to 老李 was not verified');
  assert.match(g.reached[0]!.text,/^你还好吗？/u,'no 称呼 in memory');
});

test('a restart mid-timer resumes the remaining time, fires at once when overdue, and resends an interrupted alert under the same ids', async t => {
  const h=await setup(t);
  h.sync(fall('1'));await settle();
  await h.advance(30_000);h.care.close();h.clock+=20_000;h.open();
  await h.advance(9_999);assert.equal(h.sms.length,0);
  await h.advance(1);assert.equal(h.sms.length,2,'60 s after the fall was armed');
  const late=await setup(t);
  late.sync(fall('1'));await settle();
  late.care.close();late.clock+=5*60_000;late.open();await late.advance(0);
  assert.equal(late.sms.length,2,'overdue on restart: fires at once');
  const cut=await setup(t),first:string[]=[];
  cut.send=async message=>{first.push(message.id);await new Promise(()=>{});};
  t.mock.method(console,'error',()=>{});
  cut.sync(fall('1'));await settle();await cut.advance(60_000);
  assert.equal(first.length,2,'each contact is in flight independently');
  cut.care.close();cut.send=async message=>{cut.sms.push(message);};cut.open();await cut.advance(0);
  assert.deepEqual([cut.sms.length,cut.sms[0]!.id],[2,first[0]],'resent under the same errand ids');
});

test('non-fall health observations and historical falls never start outreach or escalation, including after restart',async t=>{
  const h=await setup(t);
  h.sync(fall('99',T-15*60_000-1));
  for(const [i,metric] of ['stepCount','highHeartRateEvent','lowHeartRateEvent','irregularHeartRhythmEvent'].entries()){
    const batch=fall(String(i+1));h.sync(metric==='stepCount'?{...batch,metric}:{...batch,metric,unit:'category-code',samples:batch.samples.map(({v,...sample})=>({...sample,c:0}))});
  }
  await settle();await h.advance(60_000);h.care.close();h.open();await h.advance(60_000);
  assert.deepEqual([h.reached,h.sms,h.care.recent('owner')],[[],[],[]]);
});

test('deleted health samples never arm fall escalation on a fresh upload or replay',async t=>{
  const h=await setup(t),first=fall('1'),second=fall('2');
  h.sync({...first,control_id:'delete-first',samples:[],deleted:[first.samples[0]!.id]});
  h.sync(first);h.sync(first);
  h.sync({...second,deleted:[second.samples[0]!.id]});await settle();
  await h.advance(60_000);h.care.close();h.open();await h.advance(60_000);
  assert.equal(h.reached.length+h.sms.length,0);
});

test('a delayed owner message captured before the fall does not cancel its emergency alert',async t=>{
  const h=await setup(t);h.sync(fall('1'));await settle();
  h.care.admitted({...typed('我没事'),captured_at:new Date(T-6000).toISOString(),time_range:{kind:'instant',timebase_id:'utc_unix_ms',at_ms:T-6000}});
  await h.advance(60_000);assert.equal(h.sms.length,2);
});

test('fall outreach preserves durable event time through escalation and restart',async t=>{
  const h=await setup(t);h.memory=[];h.sync(fall('97'));await settle();
  assert.deepEqual(h.reachedAt,[T-5000]);
  h.care.close();h.clock+=5*60_000;h.open();await h.advance(0);
  assert.deepEqual(h.reachedAt,[T-5000,T-5000],'overdue check-in and alert share the durable fall event time');
});

for(const [zone,name,locationTime,fallTime] of [
  ['America/Los_Angeles','洛杉矶时间','2026/10/8 23:00:00','22:59:55'],
  ['UTC','GMT+0','2026/10/9 06:00:00','05:59:55'],
] as const)test(`deployment ${zone} controls the fall SMS event and location clocks`,async t=>{
  const h=await setup(t,zone);h.sync(fall('1'));await settle();await h.advance(60_000);
  assert.equal(h.sms.length,2);
  for(const {text} of h.sms){
    assert.ok(text.includes(`当前位置（${name}${locationTime}）`),text);
    assert.ok(text.includes(fallTime),text);assert.ok(!text.includes('台湾时间'),text);
  }
});
