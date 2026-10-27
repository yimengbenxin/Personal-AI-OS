import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import {ContractError} from '../src/contracts.ts';
import {Movement,type RideMetrics,type MoveFrame} from '../src/movement.ts';
const ride_id='d88bfcfe-2150-4bd1-8249-91db18c8cceb';
const metrics:RideMetrics={avg_kmh:15,max_kmh:20,distance_m:200,moving_s:40,elapsed_s:45};
function fixture(max?:number,configuredMax?:number) {
  let now=Date.parse('2026-10-16T00:00:00.000Z');
  const sent:{terminal:string;body:Record<string,unknown>}[]=[],spoken:string[]=[],events:Record<string,unknown>[]=[];
  const movement=new Movement({now:()=>now,...(max?{hrProfile:async()=>({max_hr_bpm:max})}:{}),...(configuredMax?{ride_hr_alert_bpm:configuredMax}:{}),
    send:async(_principal,terminal,body)=>{sent.push({terminal,body});},
    event:async(_principal,_id,_at,body)=>{events.push(body);},say:async(_principal,text)=>{spoken.push(text);},
    position:async()=>({lat:0,lng:0})});
  const at=()=>new Date(now).toISOString();
  const frame=(seq:number,hr_bpm?:number):MoveFrame=>({ride_id,seq,at:at(),ride:{...metrics,...(hr_bpm!==undefined?{hr_bpm}:{})}});
  const feedback=()=>sent.filter(s=>s.terminal==='phone').map(s=>s.body);
  return {movement,sent,spoken,events,at,frame,feedback,advance:(ms:number)=>{now+=ms;}};
}
test('phone receives the movement owner zone, source limit and exact alert text; alert cooldown stays single-owned',async()=>{
  const f=fixture(160);
  await f.movement.frame('owner',f.frame(1,170));
  const feedback=f.feedback()[0]!;
  assert.deepEqual(feedback,{operation:'ride_feedback',ride_id,at:f.at(),hr_zone:5,text:'心率 170 了，慢一点，喝口水。',max_hr_bpm:160});
  const hud=f.sent.find(s=>s.terminal==='glasses')!.body.ride as Record<string,unknown>;
  assert.equal(hud.hr_zone,feedback.hr_zone);assert.equal(hud.hr_alert,true);assert.equal(f.spoken[0],feedback.text);
  f.advance(1000);await f.movement.frame('owner',f.frame(2,170));
  assert.equal(f.feedback().length,2);assert.equal(f.spoken.length,1);assert.equal(f.events.length,1);
  f.advance(1000);await f.movement.frame('owner',f.frame(3,100));
  assert.equal(f.feedback().at(-1)!.hr_zone,2);assert.equal(f.feedback().at(-1)!.text,null);
});
test('fractional profile and configured limits round once at the decision producer',async()=>{
  for(const f of [fixture(160.6),fixture(undefined,160.6)]){
    await f.movement.frame('owner',f.frame(1,112.5));
    assert.equal(f.feedback()[0]!.max_hr_bpm,161);assert.equal(f.feedback()[0]!.hr_zone,2);
    f.advance(1000);await f.movement.frame('owner',f.frame(2,160.8));
    assert.equal(f.feedback().at(-1)!.text,null);assert.equal(f.spoken.length,0);
    f.advance(1000);await f.movement.frame('owner',f.frame(3,161));
    assert.equal(f.feedback().at(-1)!.max_hr_bpm,161);assert.equal(f.spoken.length,1);
  }
});
test('unknown heart rate and ride end clear projection; stale/duplicate frames cannot restore it',async()=>{
  const f=fixture();await f.movement.frame('owner',f.frame(1,180));
  assert.equal(f.feedback()[0]!.max_hr_bpm,175);
  f.advance(1000);await f.movement.frame('owner',f.frame(2));
  assert.deepEqual(f.feedback().at(-1),{operation:'ride_feedback',ride_id,at:f.at(),hr_zone:null,text:null,max_hr_bpm:null});
  const late=f.frame(3,180);f.advance(6000);await f.movement.frame('owner',late);assert.equal(f.feedback().length,2);
  await f.movement.rideState('owner',{ride_id,state:'ended',at:f.at(),started_by:'watch'});
  assert.equal(f.feedback().at(-1)!.max_hr_bpm,null);const count=f.feedback().length;
  await f.movement.frame('owner',f.frame(4,180));assert.equal(f.feedback().length,count);
});
test('formal ride_feedback output accepts source nullability and rejects unknown or invalid data',()=>{
  const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',value=>typeof value==='string'&&Number.isFinite(Date.parse(value)));ajv.addFormat('uuid',/^[0-9a-f-]{36}$/);
  const valid=ajv.compile(contract.outputs.ride_feedback);
  const body={schema_version:contract.schema,session_id:'session',operation:'ride_feedback',ride_id,at:'2026-10-16T00:00:00.000Z',hr_zone:null,text:null,max_hr_bpm:null};
  assert.equal(valid(body),true);assert.equal(valid({...body,hr_zone:5,text:'慢一点',max_hr_bpm:160}),true);
  for(const change of [{hr_zone:6},{max_hr_bpm:0},{max_hr_bpm:160.6},{text:''},{untrusted:true}])assert.equal(valid({...body,...change}),false);
});

test('navigation lifecycle is persisted before acknowledgement, including duplicate cancellations',async()=>{
  const f=fixture();
  const body={operation:'nav_state' as const,nav_id:ride_id,state:'cancelled' as const,at:f.at()};
  await f.movement.navState('owner',body);
  assert.equal(f.events.length,1);assert.equal(f.events[0]!.kind,'nav_cancelled');
});

test('replayed old ride end persists history without replacing a different active ride',async()=>{
  const f=fixture();
  await f.movement.rideState('owner',{ride_id,state:'started',at:f.at(),started_by:'phone'});
  f.advance(1000);
  await f.movement.rideState('owner',{ride_id:'00000000-0000-4000-8000-000000000009',state:'ended',at:f.at(),started_by:'watch'});
  assert.equal(f.movement.status('owner').ride?.ride_id,ride_id);
  assert.equal(f.movement.status('owner').ride?.state,'started');
  assert.equal(f.events.at(-1)!.kind,'ride_end');
});

test('durably replayed off-route without a live route cannot block later ride completion',async()=>{
  const f=fixture();
  await f.movement.navState('owner',{operation:'nav_state',nav_id:ride_id,state:'off_route',at:f.at()});
  assert.equal(f.events[0]!.kind,'nav_off_route');
  await f.movement.rideState('owner',{ride_id,state:'ended',at:f.at(),started_by:'phone'});
  assert.equal(f.events.at(-1)!.kind,'ride_end');
});

function navigationWithNotificationFailure() {
  const failure=new Error('connection closed after durable acknowledgement'),sent:Record<string,unknown>[]=[],spoken:string[]=[];
  let acknowledgements=0;
  const movement=new Movement({position:async()=>({lat:31,lng:121}),
    navigation:{search:async()=>[],plan:async(_from,destination,mode)=>({mode,destination,total_m:100,total_s:20,
      steps:[{index:0,maneuver:'straight',instruction:'继续前行',distance_m:100,duration_s:20,polyline:[{lat:31,lng:121}],maneuver_location:{lat:31,lng:121}}]})},
    send:async(_principal,_terminal,body,current)=>{if(current?.()!==false)sent.push({terminal:_terminal,...body});},say:async(_principal,text)=>{spoken.push(text);},
    event:async(_principal,_id,_at,_body,onDurable)=>{await onDurable?.();throw failure;}});
  return {movement,failure,sent,spoken,ack:async()=>{acknowledgements++;},acknowledgements:()=>acknowledgements};
}
test('acknowledged arrival and cancellation clear navigation when subsequent notification fails',async()=>{
  for(const state of ['arrived','cancelled'] as const){
    const f=navigationWithNotificationFailure();
    await f.movement.navigate('owner',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const route=f.movement.status('owner').navigation!;
    await assert.rejects(f.movement.navState('owner',{operation:'nav_state',nav_id:route.nav_id,state,
      at:'2026-10-18T00:00:00.000Z'},f.ack),error=>error===f.failure);
    assert.equal(f.acknowledgements(),1);
    assert.equal(f.movement.status('owner').navigation,undefined);
  }
});
test('acknowledged off-route still replans when subsequent notification fails and surfaces the error',async()=>{
  const f=navigationWithNotificationFailure();
  await f.movement.navigate('owner',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const route=f.movement.status('owner').navigation!;
  await assert.rejects(f.movement.navState('owner',{operation:'nav_state',nav_id:route.nav_id,state:'off_route',
    at:'2026-10-18T00:00:00.000Z',position:{lat:31.001,lng:121.001}},f.ack),error=>error===f.failure);
  assert.equal(f.acknowledgements(),1);
  assert.equal(f.movement.status('owner').navigation?.revision,2);
  for(const terminal of ['phone','glasses'])assert.equal(f.sent.filter(body=>body.operation==='nav_route'&&body.terminal===terminal).length,2);
  assert.deepEqual(f.spoken,['走过了，正在重新规划']);
});

test('replayed off-route keeps the existing revision and prompt after a completed replan',async()=>{
  const f=navigationWithNotificationFailure();
  await f.movement.navigate('owner',{destination:'公司',mode:'walking',lat:31.01,lng:121.01});
  const route=f.movement.status('owner').navigation!;
  const body={operation:'nav_state' as const,nav_id:route.nav_id,state:'off_route' as const,
    at:'2026-10-18T00:00:00.000Z',position:{lat:31.001,lng:121.001}};
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(f.movement.navState('owner',body,f.ack),error=>error===f.failure);
  assert.equal(f.acknowledgements(),2);
  assert.equal(f.movement.status('owner').navigation?.revision,2);
  for(const terminal of ['phone','glasses'])assert.equal(f.sent.filter(value=>value.operation==='nav_route'&&value.terminal===terminal).length,2);
  assert.deepEqual(f.spoken,['走过了，正在重新规划']);
});

test('held samples retain measurement timestamps without retriggering stale heart-rate alerts',async()=>{
  const f=fixture(),sample=f.at();f.advance(6000);
  const frame=f.frame(1,180);frame.ride!.hr_sample_at=sample;frame.ride!.speed_sample_at=sample;
  await f.movement.frame('owner',frame);
  const hud=f.sent.find(s=>s.terminal==='glasses')!.body.ride as RideMetrics;
  assert.equal(hud.hr_sample_at,sample);assert.equal(hud.speed_sample_at,sample);
  assert.equal(f.spoken.length,0);assert.equal(f.events.length,0);
});
test('pending ride commands replace, expire, cancel, and fence replay at delivery',async()=>{
  let now=0,connected=false;const sent:Record<string,unknown>[]=[],gates:(()=>boolean)[]=[];
  const movement=new Movement({now:()=>now,pending_ttl_ms:50,position:async()=>({lat:0,lng:0}),event:async()=>{},say:async()=>{},
    send:async(_principal,terminal,body,current)=>{if(terminal==='glasses')return false;if(!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);sent.push(body);if(current)gates.push(current);}});
  const start=async(requested_by:'glasses'|'voice'='glasses')=>assert.equal((await movement.controlRide('owner','start',requested_by)).status,'pending');
  await start();now=10;await start();connected=true;
  await Promise.all([movement.phoneConnected('owner'),movement.phoneConnected('owner')]);assert.equal(sent.length,1);
  assert.deepEqual(sent[0],{operation:'ride_control',action:'start',requested_by:'glasses'});
  connected=false;await start();now+=50;connected=true;await movement.phoneConnected('owner');assert.equal(sent.length,1);
  connected=false;await start();assert.equal((await movement.controlRide('owner','stop','glasses')).status,'pending');
  connected=true;await movement.phoneConnected('owner');assert.equal(sent.length,2);assert.equal(sent.at(-1)!.action,'stop');
  connected=false;await start();assert.deepEqual(await movement.stopNavigation('owner'),{status:'stopped'});
  connected=true;await movement.phoneConnected('owner');assert.equal(sent.length,2);
  connected=false;await start('voice');connected=true;await movement.phoneConnected('owner');
  assert.equal(sent.length,3);assert.equal(sent.at(-1)!.requested_by,'voice');
  // A newer stop invalidates the callback retained by the transport for an older start.
  await movement.controlRide('owner','stop','glasses');assert.equal(gates.at(-2)!(),false);
});

test('glasses navigation shares the pending slot; latest destination wins and either stop cancels',async()=>{
  let now=0,connected=false;const sent:Record<string,unknown>[]=[];
  const movement=new Movement({now:()=>now,pending_ttl_ms:100,position:async()=>{if(!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);return {lat:0,lng:0};},
    navigation:{search:async name=>[{name,lat:1,lng:1}],plan:async(_origin,destination,mode)=>({mode,destination,total_m:100,total_s:60,
      steps:[{index:0,maneuver:'straight',instruction:'前行',distance_m:100,duration_s:60,polyline:[{lat:1,lng:1}],maneuver_location:{lat:1,lng:1}}]})},
    event:async()=>{},say:async()=>{},send:async(_principal,_terminal,body,current)=>{if(_terminal==='glasses')return false;if(!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);if(!current||current())sent.push(body);}});
  const navigate=(destination:string)=>assert.rejects(movement.navigate('owner',{destination,mode:'walking'},'glasses'),{code:'PHONE_NOT_CONNECTED'});
  await navigate('old');now=50;await navigate('new');now=110;connected=true;await movement.phoneConnected('owner');
  const routes=()=>sent.filter(body=>body.operation==='nav_route');
  assert.equal(routes().length,1);assert.equal((routes()[0]!.destination as {name:string}).name,'new');
  for(const stop of [()=>movement.stopNavigation('owner'),()=>movement.controlRide('owner','stop','glasses')]){
    connected=false;await navigate('cancel');await stop();
    assert.equal(movement.status('owner').navigation,undefined);
    connected=true;await movement.phoneConnected('owner');assert.equal(routes().length,1);assert.equal(sent.at(-1)!.action,'stop');
  }
  connected=false;await navigate('expired');now+=100;connected=true;await movement.phoneConnected('owner');assert.equal(routes().length,1);
});
test('phone attach racing original disconnect waits for queue admission before replay',async()=>{
  const original=Promise.withResolvers<void>();let sends=0;
  const movement=new Movement({position:async()=>({lat:0,lng:0}),event:async()=>{},say:async()=>{},
    send:async(_principal,terminal)=>{if(terminal==='glasses')return false;if(++sends===1){await original.promise;throw new ContractError('PHONE_NOT_CONNECTED',409);}}});
  const start=movement.controlRide('owner','start','glasses');
  const attach=movement.phoneConnected('owner');original.resolve();await Promise.all([start,attach]);assert.equal(sends,2);
});
test('movement contracts accept held sample timestamps and reject invalid timestamp strings',()=>{
  const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true});ajv.addFormat('paios-utc',value=>typeof value==='string'&&Number.isFinite(Date.parse(value)));ajv.addFormat('uuid',/^[0-9a-f-]{36}$/);
  const validate=ajv.compile(contract.inputs.move_frame.definition),at='2026-10-16T00:00:00.000Z';
  const body={operation:'move_frame',ride_id,seq:1,at,ride:{...metrics,speed_kmh:12,hr_bpm:100,speed_sample_at:at,hr_sample_at:at}};
  assert.equal(validate(body),true,JSON.stringify(validate.errors));
  for(const field of ['hr_sample_at','speed_sample_at'])assert.equal(validate({...body,ride:{...body.ride,[field]:'invalid'}}),false);
});

test('pending default is 120 seconds and invalid TTL configuration is rejected',async()=>{
  let now=0,connected=false,sent=0;
  const ports={now:()=>now,position:async()=>({lat:0,lng:0}),event:async()=>{},say:async()=>{},send:async(_principal:string,terminal:'phone'|'glasses')=>{if(terminal==='glasses')return false;if(!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);sent++;}};
  const movement=new Movement(ports);
  assert.equal((await movement.controlRide('owner','start','glasses')).status,'pending');
  now=119999;connected=true;await movement.phoneConnected('owner');assert.equal(sent,1);
  connected=false;assert.equal((await movement.controlRide('owner','start','glasses')).status,'pending');
  now+=120000;connected=true;await movement.phoneConnected('owner');assert.equal(sent,1);
  for(const pending_ttl_ms of [0,-1,1.5])assert.throws(()=>new Movement({...ports,pending_ttl_ms}),{code:'MOVEMENT_PENDING_TTL_INVALID'});
});
test('replayed navigation expires during slow planning before any route publication',async()=>{
  let now=0,connected=false,published=0;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const movement=new Movement({now:()=>now,pending_ttl_ms:100,
    position:async()=>{if(!connected)throw new ContractError('PHONE_NOT_CONNECTED',409);return {lat:0,lng:0};},
    navigation:{search:async name=>[{name,lat:1,lng:1}],plan:async(_origin,destination,mode)=>{
      entered.resolve();await release.promise;return {mode,destination,total_m:1,total_s:1,steps:[{index:0,maneuver:'arrive',instruction:'到达',distance_m:1,duration_s:1,polyline:[{lat:1,lng:1}],maneuver_location:{lat:1,lng:1}}]};}},
    send:async(_principal,_terminal,_body,current)=>{if(!current||current())published++;},event:async()=>{},say:async()=>{}});
  await assert.rejects(movement.navigate('owner',{destination:'公司',mode:'walking'},'glasses'),{code:'PHONE_NOT_CONNECTED'});
  connected=true;const attach=movement.phoneConnected('owner');await entered.promise;now=100;release.resolve();await attach;
  assert.equal(published,0);assert.equal(movement.status('owner').navigation,undefined);
});


test('navigation route versions precede HUD, reconnect replays current route and GPS timestamps survive forwarding',async()=>{
  const now=Date.parse('2026-10-18T12:00:00.000Z'),sent:{terminal:string;body:Record<string,unknown>}[]=[];
  const maneuver_location={lat:31.001,lng:121.001};
  const movement=new Movement({now:()=>now,position:async()=>({lat:31,lng:121}),event:async()=>{},say:async()=>{},
    navigation:{search:async name=>[{name,...maneuver_location}],plan:async(_origin,destination,mode)=>({mode,destination,total_m:100,total_s:60,
      steps:[{index:0,maneuver:'right',instruction:'右转',distance_m:100,duration_s:60,polyline:[{lat:31,lng:121},maneuver_location],maneuver_location}]})},
    send:async(_principal,terminal,body,current)=>{if(!current||current())sent.push({terminal,body});}});
  const result=await movement.navigate('owner',{destination:'公司',mode:'walking'}) as {nav_id:string};
  assert.deepEqual(sent.filter(s=>s.body.operation==='nav_route').map(s=>[s.terminal,s.body.operation]),[['phone','nav_route'],['glasses','nav_route']]);
  assert.deepEqual(sent[0]!.body,sent[1]!.body);assert.equal(sent[1]!.body.coordinate_system,'wgs84');
  const sampled=new Date(now-1000).toISOString(),position={lat:31,lng:121,accuracy_m:5,course_deg:25,at:sampled};
  const nav={nav_id:result.nav_id,revision:1,step_index:0,maneuver:'right' as const,distance_to_maneuver_m:20,remaining_m:20,remaining_s:12,route_segment_index:0,segment_fraction:0.8};
  await movement.frame('owner',{nav_id:result.nav_id,seq:42,at:new Date(now).toISOString(),position,nav});
  const hud=sent.at(-1)!.body;assert.equal(hud.operation,'move_hud');assert.equal(hud.seq,42);assert.deepEqual(hud.position,position);
  assert.deepEqual(hud.nav,{...nav,maneuver_location});
  await movement.navState('owner',{operation:'nav_state',nav_id:result.nav_id,state:'off_route',at:new Date(now).toISOString(),position});
  assert.equal(sent.at(-1)!.terminal,'glasses');assert.equal(sent.at(-1)!.body.revision,2);
  await movement.glassesConnected('owner');assert.equal(sent.findLast(s=>s.terminal==='glasses'&&s.body.operation==='nav_route')!.body.revision,2);
  assert.equal(sent.at(-1)!.body.operation,'move_hud');
  await movement.stopNavigation('owner');const count=sent.length;await movement.glassesConnected('owner');assert.equal(sent.length,count+1);
  const idle=sent.at(-1)!;assert.equal(idle.terminal,'glasses');assert.equal(idle.body.operation,'move_hud');
  assert.equal(idle.body.kind,'walk_nav');assert.equal(idle.body.nav,undefined);assert.equal(idle.body.ride,undefined);
});
