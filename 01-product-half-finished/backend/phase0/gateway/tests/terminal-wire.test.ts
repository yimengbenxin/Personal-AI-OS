import {readFileSync} from 'node:fs';
import {createCallAvatarWire} from '../src/call-avatar-wire.ts';
import {utc} from '../../../services/personal-aios-integration/src/contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import {RoomEvent} from '@livekit/rtc-node';
import {MAC_CAPABILITIES,PHONE_CAPABILITIES,GLASSES_CAPABILITIES,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {createTerminalWire,createTimelineWire,createTurnWorkWire,createWireExtensions,type WireBody,type WireExtension} from '../src/personal-aios-terminal-wire.ts';

const schema='paios.central.text-envelope.v1',at='2026-10-14T00:00:00.000Z';
function registry(extensions:readonly WireExtension[]){
  const ajv=new Ajv({strict:true});addFormatsModule.default(ajv);ajv.addFormat('paios-utc',value=>{try{utc(value);return true;}catch{return false;}});
  return createWireExtensions(extensions,{schema,inputs:{},outputs:{}},value=>ajv.compile(value));
}
function fixture(){
  const devices=[['phone','iphone','owner','手机'],['mac','mac','owner','我的电脑'],['mac-two','mac','owner','第二台电脑'],['glasses','glasses','owner',null],['foreign','mac','other','别人的电脑']].map(([id,deviceClass,owner,label])=>({
    device_id:id!,device_class:deviceClass!,user_id:owner!,label,status:'active',paired_at:at,recipient_public_key:'pk',device_credential_ref:{},media:['data'],
    governance:{terminal_capabilities:deviceClass==='iphone'?PHONE_CAPABILITIES:deviceClass==='mac'?MAC_CAPABILITIES:GLASSES_CAPABILITIES}}));
  const notifications:string[]=[],pauses:unknown[][]=[],errors:unknown[]=[],states=new Map<string,boolean>(),watchers=new Set<(principal:string)=>void>();
  const query=async(sql:string,args:unknown[]=[])=>{
    if(sql.startsWith('WITH revoked AS')){
      assert.match(sql,/pg_notify\('paired_device_revoked', device_id\)/);
      const found=devices.find(row=>row.device_id===args[0]&&row.user_id===args[1]);
      if(!found)return {rows:[]};found.status='revoked';notifications.push(found.device_id);return {rows:[found]};
    }
    assert.match(sql,/FROM paired_devices WHERE status = 'active'/);
    return {rows:devices.filter(row=>row.status==='active')};
  };
  const wire=createTerminalWire({pool:{query} as never,onError:error=>errors.push(error),relay:{paused:id=>states.get(id),revoked:()=>{},
    pause:async(principal,id,paused)=>{pauses.push([principal,id,paused]);states.set(id,paused);for(const changed of watchers)changed(principal);},
    watch:changed=>{watchers.add(changed);return()=>{watchers.delete(changed);};}}});
  const api=registry([wire.extension]),source=(id:string):RegisteredDevice=>{
    const row=devices.find(row=>row.device_id===id)!;
    return {principal_id:row.user_id,device_id:id,device_type:row.device_class==='iphone'?'phone':row.device_class,
      capabilities:row.governance.terminal_capabilities,channel:'rtc_typed_text',route_version:'route',output_modes:['text'],consent_ref:'consent'} as RegisteredDevice;
  };
  const run=async(id:string,body:WireBody)=>{const packets:WireBody[]=[];
    await api.handle(body,source(id),async packet=>{packets.push(api.output({...packet,session_id:'session'},()=>assert.fail('extension output fell through')));});return packets;};
  return {wire,api,source,devices,notifications,pauses,states,errors,run};
}

test('I4 terminal revoke preserves phone self boundary, Mac self-only control and owner isolation',async t=>{
  const f=fixture();t.after(()=>f.wire.close());
  const revoke=(sender:string,target:string)=>f.run(sender,{operation:'terminal_revoke',control_id:'revoke',device_id:target});
  for(const [sender,target,code] of [['phone','phone','TERMINAL_REVOKE_SELF_PHONE'],['mac','mac-two','TERMINAL_REVOKE_DENIED'],['phone','foreign','PAIRED_DEVICE_REQUIRED'],['phone','missing','PAIRED_DEVICE_REQUIRED'],['glasses','mac','TERMINAL_REVOKE_DENIED']]){
    assert.deepEqual(await revoke(sender!,target!),[{schema_version:schema,session_id:'session',operation:'terminal_receipt',control_id:'revoke',ok:false,error_code:code}]);
  }
  assert.deepEqual(f.notifications,[]);
  assert.equal((await revoke('phone','mac-two'))[0]!.ok,true);assert.deepEqual(f.notifications,['mac-two']);
  assert.equal((await revoke('mac','mac'))[0]!.ok,true);assert.deepEqual(f.notifications,['mac-two','mac']);
  assert.equal((await revoke('phone','mac-two'))[0]!.error_code,'PAIRED_DEVICE_REQUIRED');
  assert.equal(f.devices.find(row=>row.device_id==='phone')!.status,'active');
  assert.equal(f.devices.find(row=>row.device_id==='foreign')!.status,'active');
});

test('desktop pause forwards phone all/specific and Mac self requests, with explicit control receipts',async t=>{
  const f=fixture();t.after(()=>f.wire.close());
  const pause=(sender:string,target?:string,paused=true)=>f.run(sender,{operation:'desktop_pause',control_id:'pause',paused,...(target?{device_id:target}:{})});
  assert.equal((await pause('phone'))[0]!.ok,true);
  assert.deepEqual(f.pauses,[['owner','mac',true],['owner','mac-two',true]]);
  assert.equal((await pause('phone','mac-two',false))[0]!.ok,true);
  assert.equal((await pause('mac','mac',false))[0]!.ok,true);
  const before=f.pauses.length;
  for(const [sender,target,code] of [['mac',undefined,'TERMINAL_REVOKE_DENIED'],['mac','mac-two','TERMINAL_REVOKE_DENIED'],['phone','foreign','PAIRED_DEVICE_REQUIRED'],['phone','phone','PAIRED_DEVICE_REQUIRED']])assert.equal((await pause(sender!,target))[0]!.error_code,code);
  assert.equal(f.pauses.length,before);
  assert.deepEqual(f.pauses.slice(2),[['owner','mac-two',false],['owner','mac',false]]);
  await assert.rejects(f.run('phone',{operation:'desktop_pause',control_id:'invalid',paused:'yes'}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
});

test('terminal attach publishes owner labels, self, connected and pause state; detach retires its connection',async t=>{
  const f=fixture();t.after(()=>f.wire.close());f.states.set('mac',true);
  const phonePackets:WireBody[]=[],macPackets:WireBody[]=[],phoneRoom=new EventEmitter(),macRoom=new EventEmitter();let macCurrent=true;
  const attach=(id:string,room:EventEmitter,packets:WireBody[],current=()=>true)=>f.api.attach({device:f.source(id),room:room as never,identity:id,current,leave:async()=>{},
    publish:async body=>{packets.push(f.api.output({...body,session_id:'session'},()=>assert.fail()));}});
  const stopPhone=attach('phone',phoneRoom,phonePackets),stopMac=attach('mac',macRoom,macPackets,()=>macCurrent);
  await f.wire.changed('owner');
  const list=phonePackets.at(-1)!.terminals as Record<string,unknown>[];
  assert.equal(list[0]!.device_id,'phone');assert.equal(list[0]!.self,true);
  assert.deepEqual(list.find(row=>row.device_id==='mac'),{device_id:'mac',device_class:'mac',label:'我的电脑',paired_at:at,connected:true,self:false,paused:true});
  assert.equal(list.find(row=>row.device_id==='mac-two')!.connected,false);
  assert.equal(list.some(row=>row.device_id==='foreign'),false);
  assert.equal((macPackets.at(-1)!.terminals as Record<string,unknown>[])[0]!.self,true);
  assert.equal(Object.hasOwn(list[0]!,'paused'),false);
  macCurrent=false;macRoom.emit(RoomEvent.ParticipantDisconnected,{identity:'mac'});stopMac();await f.wire.changed('owner');
  const left=(phonePackets.at(-1)!.terminals as Record<string,unknown>[]).find(row=>row.device_id==='mac')!;
  assert.equal(left.connected,false);assert.equal(typeof left.last_seen_at,'string');assert.equal(f.wire.seen('mac'),left.last_seen_at);
  stopPhone();assert.equal(phoneRoom.listenerCount(RoomEvent.ParticipantDisconnected),0);assert.equal(macRoom.listenerCount(RoomEvent.ParticipantDisconnected),0);
  assert.deepEqual(f.errors,[]);
});

test('generic extension registry keeps validators per ingress and formats control outputs',async t=>{
  const f=fixture();t.after(()=>f.wire.close());const empty=registry([]);
  assert.equal(f.api.has('terminal_revoke'),true);assert.equal(empty.has('terminal_revoke'),false);
  assert.throws(()=>registry([f.wire.extension,f.wire.extension]),/FORMAL_EXTENSION_OPERATION_CONFLICT/);
  await assert.rejects(f.run('phone',{operation:'terminal_revoke',control_id:'bad',device_id:'mac',extra:true}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
  assert.throws(()=>f.api.output({operation:'terminal_receipt',session_id:'session',control_id:'bad',ok:'yes'},()=>assert.fail()),/FORMAL_TEXT_OUTPUT_INVALID/);
  const fallback={operation:'base',unchanged:true};assert.equal(empty.output(fallback,()=>fallback),fallback);
  assert.equal(f.api.has('timeline_sync'),false);
  assert.deepEqual(Object.keys(f.wire.extension.inputs).sort(),['desktop_pause','terminal_revoke']);
});

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){const until=Date.now()+3000;while(!done()){assert.ok(Date.now()<until,'publication did not settle');await tick();}}
async function timelineFixture(t:test.TestContext,options:Record<string,unknown>={}){
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const {Timeline}=await import('../../../services/personal-aios-integration/src/timeline.ts'),{PosixStorage}=await import('../../../services/personal-aios-integration/src/storage.ts');
  const root=await mkdtemp(join(tmpdir(),'paios-wire-')),controls=fixture(),errors:unknown[]=[],confirmationDevices:string[]=[],connections:(()=>void)[]=[];
  const timeline=new Timeline({directory:join(root,'timeline'),...options},new PosixStorage(root),async()=>{}, {readOnly:async()=>undefined});
  let closed=false;const closeTimeline=async()=>{if(!closed){closed=true;await timeline.close();}};
  let confirmations:((pending:any[])=>Promise<void>)|undefined,resolveStop:(stop:()=>void)=>void=()=>{},stopped=0,reads=0;
  const page=timeline.page.bind(timeline);timeline.page=(...args)=>{reads++;return page(...args);};
  const runtime={timeline,watchActivity:async()=>()=>{},replayActivity:async()=>{},watchVoiceConfirmations:async(source:RegisteredDevice,deliver:(pending:any[])=>Promise<void>,_error:unknown,readOnly:boolean)=>{
    assert.equal(readOnly,true);confirmationDevices.push(source.device_id);confirmations=deliver;
    return await new Promise<()=>void>(resolve=>{resolveStop=resolve;});
  }} as unknown as Parameters<typeof createTimelineWire>[0];
  const extension=createTimelineWire(runtime,error=>errors.push(error)),api=registry([extension]);
  const attach=(id:string,send?:(body:WireBody)=>Promise<void>)=>{
    const packets:WireBody[]=[],source=controls.source(id);let disconnected=0;
    const stop=extension.prepare!({device:source,room:{} as never,identity:id,current:()=>true,leave:async()=>{disconnected++;},publish:async body=>{
      const packet=api.output({...body,session_id:'s'.repeat(200)},()=>body);assert.ok(Buffer.byteLength(JSON.stringify(packet))<=12288);packets.push(packet);await send?.(body);
    }});connections.push(stop);
    return {packets,stop,disconnected:()=>disconnected,sync:(body:Record<string,unknown>={})=>api.handle({operation:'timeline_sync',request_id:'catchup',...body},source,async()=>assert.fail('sync bypassed attachment owner'))};
  };
  t.after(async()=>{for(const stop of connections)stop();controls.wire.close();await closeTimeline();await rm(root,{recursive:true,force:true});});
  const append=(n:number,text='short',principal='owner')=>timeline.append({principal_id:principal,item_id:`her-${n}`,kind:'yimi',via:'text',text,at_ms:Date.now()});
  return {...controls,api,extension,timeline,closeTimeline,errors,confirmationDevices,attach,append,reads:()=>reads,
    confirmations:async(pending:any[])=>{assert.ok(confirmations);await confirmations(pending);},finishWatch:()=>resolveStop(()=>{stopped++;}),stopped:()=>stopped};
}

test('timeline sync uses its attached owner and validated cursors; terminals without chat_ui are refused',async t=>{
  const f=await timelineFixture(t);for(let n=1;n<=7;n++)f.append(n);const mac=f.attach('mac');
  for(const request of [{},{after_seq:2},{before_seq:7,limit:2}]){
    const before=mac.packets.length;await mac.sync(request);
    assert.equal(mac.packets[before]!.request_id,'catchup');assert.equal(mac.packets[before]!.head_seq,7);
  }
  assert.deepEqual((mac.packets.at(-1)!.items as any[]).map(item=>item.seq),[6]);
  await assert.rejects(mac.sync({after_seq:1,before_seq:2}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
  await assert.rejects(f.api.handle({operation:'timeline_sync',request_id:'denied'},f.source('glasses'),async()=>{}),/TIMELINE_DEVICE_REQUIRED/);
  await assert.rejects(f.api.handle({operation:'timeline_sync',request_id:'unattached'},f.source('phone'),async()=>{}),/TIMELINE_ATTACHMENT_REQUIRED/);
});

test('timeline fanout isolates owners/classes; Unicode and escaped fragments fit the byte cap and reassemble',async t=>{
  const f=await timelineFixture(t),phone=f.attach('phone'),mac=f.attach('mac'),glasses=f.attach('glasses'),foreign=f.attach('foreign');
  const text=('😀汉\u0000\n"\\').repeat(4000);f.append(1,text);
  await until(()=>mac.packets.flatMap(packet=>packet.items as any[]).at(-1)?.part===mac.packets.flatMap(packet=>packet.items as any[]).at(-1)?.parts&&mac.packets.length>1);
  assert.equal(glasses.packets.length,0);assert.equal(foreign.packets.length,0);assert.deepEqual(phone.packets,mac.packets);
  const pieces=mac.packets.flatMap(packet=>packet.items as any[]);
  assert.equal(pieces.map(piece=>piece.text).join(''),text);assert.deepEqual(pieces.map(piece=>piece.part),pieces.map((_,n)=>n+1));
  assert.ok(pieces.every(piece=>piece.parts===pieces.length&&piece.seq===1&&piece.item_id==='her-1'));
  mac.stop();const before=mac.packets.length;f.append(2);await tick();assert.equal(mac.packets.length,before);
});

test('I12 read-only confirmations retain sixteen IDs within the byte cap and stop after an async attach race',async t=>{
  const f=await timelineFixture(t),phone=f.attach('phone'),mac=f.attach('mac'),glasses=f.attach('glasses');
  assert.deepEqual(f.confirmationDevices,['mac']);assert.deepEqual(Object.keys(f.extension.inputs),['timeline_sync']);
  assert.equal(f.api.has('confirmation_deny'),false);
  const pending=Array.from({length:16},(_,n)=>({confirmation_id:n.toString(16).padStart(64,'a'),kind:n%2?'native_approval':undefined,text:'\u0000'.repeat(200),expires_in_ms:120000}));
  await f.confirmations(pending);await until(()=>mac.packets.length===1);const packet=mac.packets[0]!;
  assert.equal(packet.operation,'confirmations');assert.deepEqual((packet.items as any[]).map(row=>row.confirmation_id),pending.map(row=>row.confirmation_id));
  assert.ok((packet.items as any[]).every(row=>row.answer_on==='phone'&&['voice','native_approval'].includes(row.kind)&&Array.from(row.text).length<=200));
  assert.equal(phone.packets.length,0);assert.equal(glasses.packets.length,0);
  mac.stop();f.finishWatch();await tick();assert.equal(f.stopped(),1);await f.confirmations([]);await tick();assert.equal(mac.packets.length,1);assert.deepEqual(f.errors,[]);
});

test('400-page stalled transport holds one read, signals reset after retention, and shutdown does not wait',async t=>{
  const f=await timelineFixture(t,{max_items:2}),gate=Promise.withResolvers<void>(),phone=f.attach('phone',async()=>gate.promise);
  f.append(1);await until(()=>phone.packets.length===1);const reads=f.reads();
  for(let n=2;n<=400;n++)f.append(n,'x'.repeat(1000));f.timeline.purge();
  assert.equal(f.timeline.page('owner').items.length,2);assert.equal(f.reads(),reads+1,'dirty notifications retain no pages or read-ahead');
  gate.resolve();await until(()=>phone.packets.some(packet=>packet.operation==='timeline_reset'));
  assert.ok(phone.packets.length<=3,'discarded history is represented by reset, not a 400-page send chain');
  const blocked=Promise.withResolvers<void>(),mac=f.attach('mac',async()=>blocked.promise);f.append(401);await until(()=>mac.packets.length===1);
  const closed=await Promise.race([f.closeTimeline().then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))]);
  assert.equal(closed,true);mac.stop();phone.stop();blocked.resolve();
});

test('split catch-up fragments stay consecutive while live data and simultaneous sync requests arrive',async t=>{
  const f=await timelineFixture(t),gate=Promise.withResolvers<void>();f.append(1,'x'.repeat(40000));
  let first=true;const phone=f.attach('phone',async()=>{if(first){first=false;await gate.promise;}});
  const sync=phone.sync();await until(()=>phone.packets.length===1);f.append(2,'live');
  await assert.rejects(phone.sync({after_seq:0}),/TIMELINE_SYNC_BUSY/);assert.equal(phone.packets.length,1);
  gate.resolve();await sync;await until(()=>phone.packets.some(packet=>(packet.items as any[]|undefined)?.some(row=>row.seq===2)));
  const rows=phone.packets.flatMap(packet=>packet.items as any[]??[]),split=rows.filter(row=>row.seq===1);
  assert.deepEqual(rows.slice(0,split.length),split);assert.equal(rows.at(-1)!.seq,2);
  assert.equal(split.map(row=>row.text).join(''),'x'.repeat(40000));assert.ok(phone.packets.some(packet=>packet.operation==='timeline_resync'));
});

test('purge emits timeline_removed live and on catch-up; expired tombstones return timeline_reset',async t=>{
  let now=Date.now();const f=await timelineFixture(t,{now:()=>now,retention_days:1}),phone=f.attach('phone');
  f.append(1);await until(()=>phone.packets.length===1);const cursor=f.timeline.head('owner');
  now+=2*86400_000;f.timeline.purge();await until(()=>phone.packets.some(packet=>packet.operation==='timeline_removed'));
  const removal=phone.packets.find(packet=>packet.operation==='timeline_removed')!;assert.deepEqual(removal.removed_seqs,[1]);
  const mac=f.attach('mac');await mac.sync({after_seq:cursor});assert.equal(mac.packets[0]!.operation,'timeline_removed');assert.deepEqual(mac.packets[0]!.removed_seqs,[1]);
  const markedStart=mac.packets.length;await mac.sync({after_seq:cursor,page_markers:true});
  assert.equal(mac.packets[markedStart]!.page_end,true,'removal-only pages expose the same boundary');
  now+=2*86400_000;f.timeline.purge();await mac.sync({after_seq:cursor});assert.equal(mac.packets.at(-1)!.operation,'timeline_reset');
  await mac.sync({before_seq:cursor});assert.equal(mac.packets.at(-1)!.operation,'timeline_reset');
});

test('confirmation and progress snapshots share the attachment send owner and coalesce while blocked',async t=>{
  const f=await timelineFixture(t),gate=Promise.withResolvers<void>(),mac=f.attach('mac',async body=>{if(body.operation==='confirmations'&&(body.items as any[]).length===0)await gate.promise;});
  await f.confirmations([]);await until(()=>mac.packets.length===1);
  for(let n=1;n<=400;n++){
    await f.api.publish({operation:'errand_progress',errands:[{job_id:`job-${n}`}]},f.source('mac'),async()=>assert.fail('progress bypassed owner'));
    await f.confirmations([{confirmation_id:'a'.repeat(64),expires_in_ms:n,text:`state ${n}`}]);
  }
  assert.equal(mac.packets.length,1);gate.resolve();await until(()=>mac.packets.length===3);
  assert.equal((mac.packets.find(packet=>packet.operation==='errand_progress')!.errands as any[])[0].job_id,'job-400');
  assert.equal((mac.packets.at(-1)!.items as any[])[0].text,'state 400');
});

test('finite replenished progress interleaves an accepted sync before the next snapshot',async t=>{
  const f=await timelineFixture(t),gate=Promise.withResolvers<void>();f.append(1);
  let progress=0;
  const publish=()=>f.extension.publish!({operation:'errand_progress',errands:[{job_id:`job-${progress}`} ]},f.source('phone'));
  const phone=f.attach('phone',async body=>{
    if(body.operation!=='errand_progress')return;
    if(++progress===1)await gate.promise;
    if(progress<30)publish();
  });
  publish();await until(()=>phone.packets.length===1);const sync=phone.sync();gate.resolve();await sync;
  await until(()=>phone.packets.length===31);
  assert.equal(phone.packets.findIndex(body=>body.operation==='timeline_items'),1);
  assert.equal(progress,30);assert.deepEqual(f.errors,[]);
});

test('healthy three-second sends serve sync within four items despite two-second progress updates',async t=>{
  const f=await timelineFixture(t);f.append(1);
  const gates:ReturnType<typeof Promise.withResolvers<void>>[]=[];
  t.mock.timers.enable({apis:['setTimeout']});
  const phone=f.attach('phone',async()=>{const gate=Promise.withResolvers<void>();gates.push(gate);await gate.promise;});
  const progress=(n:number)=>f.extension.publish!({operation:'errand_progress',errands:[{job_id:`job-${n}`}]},f.source('phone'));
  progress(0);await until(()=>gates.length===1);let elapsed=0,syncedAt=0;
  const result=phone.sync().then(()=>{syncedAt=elapsed;},error=>error);
  for(let n=0;n<12;n++){
    t.mock.timers.tick(2000);elapsed+=2000;progress(n+1);
    t.mock.timers.tick(1000);elapsed+=1000;gates[n]!.resolve();await until(()=>gates.length===n+2);
    if(n===3)assert.ok(syncedAt>0&&syncedAt<=12000,'pending sync exceeded four healthy logical-item sends');
  }
  assert.equal(await result,undefined);assert.equal(syncedAt,6000);
  assert.equal(phone.packets.filter(body=>body.operation==='errand_progress').length,12);
  assert.equal(phone.disconnected(),0);assert.deepEqual(f.errors,[]);phone.stop();gates.at(-1)!.resolve();
});

test('all four publication classes rotate between logical items while split fragments stay consecutive',async t=>{
  const f=await timelineFixture(t),gate=Promise.withResolvers<void>();f.append(1,'x'.repeat(40000));f.append(2);f.append(3);
  let first=true;const phone=f.attach('phone',async()=>{if(first){first=false;await gate.promise;}});
  const sync=phone.sync();await until(()=>phone.packets.length===1);const reads=f.reads();f.append(4,'live');
  for(let n=1;n<=400;n++)f.extension.publish!({operation:'errand_progress',errands:[{job_id:`job-${n}`}]},f.source('phone'));
  await assert.rejects(phone.sync(),/TIMELINE_SYNC_BUSY/);assert.equal(phone.packets.length,1);
  gate.resolve();await sync;const parts=(phone.packets[0]!.items as any[])[0].parts;
  assert.ok(parts>1);assert.ok(phone.packets.slice(0,parts).every(body=>(body.items as any[])[0].seq===1));
  assert.deepEqual(phone.packets.slice(0,parts).flatMap(body=>body.items as any[]).map(row=>row.part),Array.from({length:parts},(_,n)=>n+1));
  assert.deepEqual(phone.packets.slice(parts).map(body=>[body.operation,(body.items as any[]|undefined)?.[0]?.seq]),[
    ['timeline_resync',undefined],['timeline_items',4],['errand_progress',undefined],['timeline_items',2],['timeline_items',3]
  ]);
  assert.equal((phone.packets[parts+2]!.errands as any[])[0].job_id,'job-400');
  assert.equal(f.reads(),reads+1,'sync continuation retains one page while the live cursor reads once');assert.deepEqual(f.errors,[]);
});


test('a sync send stuck past the deadline keeps the room, starts no second send, and the newest state follows when it settles',async t=>{
  // Regression: a 5 s publication deadline made the gateway leave a live call's rooms. Slowness is not liveness.
  const f=await timelineFixture(t);f.append(1);const gate=Promise.withResolvers<void>();let calls=0;
  const phone=f.attach('phone',async()=>{if(++calls===1)await gate.promise;});
  t.mock.timers.enable({apis:['setTimeout']});
  const synced=phone.sync();await until(()=>phone.packets.length===1);
  t.mock.timers.tick(60000);await tick();f.append(2);f.extension.publish!({operation:'errand_progress',errands:[{job_id:'job-1'}]},f.source('phone'));
  f.extension.publish!({operation:'errand_progress',errands:[{job_id:'job-2'}]},f.source('phone'));t.mock.timers.tick(60000);await tick();
  assert.equal(calls,1,'one attempt in flight: an RTC send cannot be cancelled, so none piles up');
  assert.equal(phone.disconnected(),0);assert.deepEqual(f.errors,[]);
  gate.resolve();await synced;await until(()=>phone.packets.length===3);
  assert.deepEqual(phone.packets.map(body=>[body.operation,(body.items as any[]|undefined)?.[0]?.seq??(body.errands as any[]|undefined)?.[0]?.job_id]),
    [['timeline_items',1],['timeline_items',2],['errand_progress','job-2']]);
  assert.equal(phone.disconnected(),0);assert.deepEqual(f.errors,[]);
});

test('a failed frame is reported, keeps the room, and its whole item is served again after a bounded backoff',async t=>{
  const f=await timelineFixture(t);f.append(1,'x'.repeat(40000));const failures=[2,3,4,5,6,7,8];let calls=0;
  t.mock.timers.enable({apis:['setTimeout']});
  const phone=f.attach('phone',async()=>{if(failures.includes(++calls))throw new Error('SDK_PUBLISH_FAILED');});
  const synced=phone.sync().then(()=>'synced');await until(()=>calls===2);
  const parts=(phone.packets[0]!.items as any[])[0].parts;assert.ok(parts>2);
  // Backoff doubles from 250 ms and is capped at the five-second retry bound; no retry starts before its delay.
  for(const delay of [250,500,1000,2000,4000,5000,5000]){
    const before=calls;t.mock.timers.tick(delay-1);await tick();assert.equal(calls,before);t.mock.timers.tick(1);await until(()=>calls>before);
  }
  assert.equal(await synced,'synced');assert.equal(f.errors.length,7);assert.ok(f.errors.every(error=>/SDK_PUBLISH_FAILED/.test(String(error))));
  const last=phone.packets.slice(-parts).flatMap(body=>body.items as any[]);
  assert.deepEqual(last.map(row=>[row.seq,row.part]),Array.from({length:parts},(_,n)=>[1,n+1]),'the retried item restarts at its first fragment');
  assert.equal(phone.disconnected(),0);
});

test('a long healthy split response receives a fresh deadline per frame',async t=>{
  const f=await timelineFixture(t);f.append(1,'x'.repeat(60000));const gates:ReturnType<typeof Promise.withResolvers<void>>[]=[];
  t.mock.timers.enable({apis:['setTimeout']});const phone=f.attach('phone',async()=>{const gate=Promise.withResolvers<void>();gates.push(gate);await gate.promise;});
  const result=phone.sync().then(()=>undefined,error=>error);await until(()=>gates.length===1);
  const parts=(phone.packets[0]!.items as any[])[0].parts;assert.ok(parts>5);
  for(let n=0;n<parts;n++){await until(()=>gates.length===n+1);t.mock.timers.tick(4000);gates[n]!.resolve();await tick();}
  assert.equal(await result,undefined);assert.equal(phone.disconnected(),0);assert.deepEqual(f.errors,[]);
});


test('eight producer-bounded escaped progress jobs fit the longest legal wire envelope',async()=>{
  const {parseErrandProgress}=await import('../src/errand-spool.ts');
  const rows=Array.from({length:8},(_,n)=>{const {principal_id,...job}=parseErrandProgress({principal_id:'owner',job_id:`job-${n.toString(16).padStart(12,'0')}`,title:'\u0000'.repeat(40),app:'\u0000'.repeat(32),state:'running',started_at:at,step:1000,max_steps:1000});return job;});
  const bytes=Buffer.byteLength(JSON.stringify({schema_version:schema,operation:'errand_progress',session_id:'s'.repeat(200),errands:rows}));
  assert.ok(bytes<=12288);assert.equal(rows.length,8);assert.ok(rows.every(job=>!Object.hasOwn(job,'principal_id')));
});


test('A6.4 maximum UTF-8 attachment names share the existing split budget and consecutive fragments',async t=>{
  const f=await timelineFixture(t),attachments=Array.from({length:10},(_,n)=>({name:'汉'.repeat(84)+String(n)+'ab',kind:'document' as const,size:Number.MAX_SAFE_INTEGER}));
  assert.ok(attachments.every(file=>Buffer.byteLength(file.name)===255));
  const text=('😀汉\\\"\\n').repeat(5000);
  f.timeline.append({principal_id:'owner',item_id:'attached-owner',kind:'owner',via:'text',text,at_ms:Date.now(),attachments});
  const gate=Promise.withResolvers<void>();let first=true;
  const phone=f.attach('phone',async()=>{if(first){first=false;await gate.promise;}}),sync=phone.sync();
  await until(()=>phone.packets.length===1);f.append(2,'next item');gate.resolve();await sync;
  await until(()=>phone.packets.some(packet=>(packet.items as any[]|undefined)?.some(row=>row.seq===2)));
  const rows=phone.packets.flatMap(packet=>packet.items as any[]??[]),pieces=rows.filter(row=>row.seq===1);
  assert.ok(pieces.length>1);assert.deepEqual(rows.slice(0,pieces.length),pieces);assert.equal(rows.at(-1)!.seq,2);
  assert.equal(pieces.map(piece=>piece.text).join(''),text);
  assert.deepEqual(pieces.map(piece=>piece.part),pieces.map((_,n)=>n+1));
  assert.ok(pieces.every(piece=>piece.parts===pieces.length));
  for(const piece of pieces)assert.deepEqual(piece.attachments,attachments);
  assert.deepEqual(f.errors,[]);
});

test('A6.4 timeline wire enforces exact metadata shape and attachment bounds',async t=>{
  const f=await timelineFixture(t),file={name:'汉'.repeat(85),kind:'pdf',size:0};
  const body=(attachments:unknown)=>({operation:'timeline_items',session_id:'session',head_seq:1,has_more:false,items:[{seq:1,item_id:'me-1',kind:'owner',via:'text',text:'',at,attachments}]});
  const output=(attachments:unknown)=>f.api.output(body(attachments),()=>assert.fail('schema bypassed'));
  assert.doesNotThrow(()=>output(Array.from({length:10},()=>file)));
  for(const attachments of [Array.from({length:11},()=>file),[{...file,name:'a'.repeat(256)}],[{...file,size:-1}],[{...file,size:0.5}],[{...file,kind:'folder'}],[{...file,path:'/private/file'}],[{...file,grant_id:'grant-1'}]])
    assert.throws(()=>output(attachments),/FORMAL_TEXT_OUTPUT_INVALID/);
});

test('avatar extension authorizes phone, Mac and glasses through the existing formal voice path',async()=>{
  for(const [device_type,capabilities] of [['phone',PHONE_CAPABILITIES],['mac',MAC_CAPABILITIES],['glasses',GLASSES_CAPABILITIES]] as const){
    const source={principal_id:'owner',device_id:device_type,device_type,channel:'livekit',capabilities,route_version:'v1',output_modes:['text']} as RegisteredDevice;
    const events:string[]=[],published:WireBody[]=[];let sink:Parameters<NonNullable<Parameters<typeof createCallAvatarWire>[1]['attach']>>[0]|undefined;
    const extension=createCallAvatarWire({formalVoice:async(device:RegisteredDevice,modality:string,consume:()=>Promise<void>)=>{
      assert.equal(device,source);assert.equal(modality,'audio');events.push('authorized');await consume();},ownerInput:async()=>{events.push('owner-input');}} as never,
      {open:async()=>{},close:async()=>{},respond:async()=>false,avatarCommand:()=>{events.push('intent');},setAvatar:async()=>{events.push('toggle');},attach:value=>{sink=value;return()=>{};}},error=>{throw error;});
    const api=registry([extension]);await api.handle({operation:'call_avatar',call_id:'call',avatar:true,avatar_revision:1},source,async()=>{});
    assert.deepEqual(events,['intent','authorized','owner-input','toggle']);
    const stop=extension.prepare!({device:source,room:{} as never,identity:'terminal',current:()=>true,leave:async()=>{},publish:async body=>{
      api.output({...body,session_id:'session'},()=>{throw new Error('wrong base validator');});published.push(body);}});
    await sink!.state('call','opening',{mode:'manual',avatar:false,avatar_revision:0});
    await sink!.state('call','live',{mode:'ambient',avatar:false,avatar_revision:0});assert.equal(published.length,0,'legacy clients receive no unlisted default-OFF output');
    await assert.rejects(api.handle({operation:'call_avatar',call_id:'call',avatar:true,avatar_revision:0},source,async()=>{}),/FORMAL_CALL_AVATAR_INVALID/);
    await sink!.state('call','closed',{mode:'ambient',avatar:false,avatar_revision:7});
    assert.deepEqual(published.map(body=>[body.operation,body.avatar,body.avatar_revision]),[['call_avatar_state',false,7]]);stop();
  }
});

test('configured call-avatar quote requires exact consent before intent or provider activation',async()=>{
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'livekit',capabilities:PHONE_CAPABILITIES,route_version:'v1',output_modes:['text']} as RegisteredDevice;
  const quote={quote_id:'call-price-v1',price_text:'供应商实际通话报价',scope_text:'仅本通电话显示数字人'};
  const events:string[]=[];
  const extension=createCallAvatarWire({formalVoice:async(_device:RegisteredDevice,_modality:string,consume:()=>Promise<void>)=>{
    events.push('authorized');await consume();},ownerInput:async()=>{events.push('owner-input');}} as never,
    {open:async()=>{},close:async()=>{},respond:async()=>false,avatarCommand:()=>{events.push('intent');},
      setAvatar:async(_id,enabled)=>{events.push(enabled?'on':'off');},attach:()=>()=>{}},error=>{throw error;},quote);
  const api=registry([extension]);
  const body={operation:'call_avatar',call_id:'call',avatar:true,avatar_revision:1};
  for(const confirmed_quote of [undefined,{...quote,quote_id:'old'},{...quote,price_text:'旧报价'},{...quote,scope_text:'旧范围'}]){
    await assert.rejects(api.handle({...body,...(confirmed_quote?{confirmed_quote}:{})},source,async()=>{}),/CALL_AVATAR_QUOTE_CHANGED/);
    assert.deepEqual(events,[],'unconfirmed or changed quote cannot publish intent or activate the provider');
  }
  await assert.rejects(api.handle({...body,confirmed_quote:{...quote}},{...source,device_type:'mac',capabilities:MAC_CAPABILITIES},async()=>{}),/CALL_AVATAR_PHONE_CONFIRMATION_REQUIRED/);
  assert.deepEqual(events,[],'a valid quote cannot authorize a Mac paid confirmation');
  await api.handle({...body,confirmed_quote:{...quote}},source,async()=>{});
  assert.deepEqual(events,['intent','authorized','owner-input','on']);
  events.length=0;
  await api.handle({...body,avatar:false,avatar_revision:2},source,async()=>{});
  assert.deepEqual(events,['intent','authorized','owner-input','off'],'turning an avatar off requires no paid consent');
});

test('turn work is explicit opt-in on the formal channel and retains owner isolation across reconnect',async t=>{
  const controls=fixture(),watchers=new Map<string,()=>void>(),errors:unknown[]=[],state={foreground_replies:[{call_id:'call',turn:2}],background_work_count:1};
  let stopped=0;
  const runtime={turnWork:(principal:string)=>principal==='owner'?state:{foreground_replies:[],background_work_count:0},
    watchTurnWork:async(source:RegisteredDevice,changed:()=>void)=>{watchers.set(source.device_id,changed);changed();return()=>{stopped++;watchers.delete(source.device_id);};}};
  const extension=createTurnWorkWire(runtime as never,error=>errors.push(error)),api=registry([extension]);
  const packets:WireBody[]=[],source=controls.source('phone');
  const attach=()=>extension.prepare!({device:source,room:{} as never,identity:'phone',current:()=>true,leave:async()=>{},publish:async body=>{packets.push(api.output({...body,session_id:'session'},()=>assert.fail('not an extension output')));}});
  let stop=attach();t.after(()=>{stop();controls.wire.close();});await tick();
  assert.equal(packets.length,0,'legacy clients never opt in and receive no new packet');
  await api.handle({operation:'turns_sync',request_id:'first'},source,async()=>assert.fail('bypassed attachment'));await until(()=>packets.length===1);
  assert.deepEqual(packets[0],{schema_version:schema,session_id:'session',operation:'turns_state',request_id:'first',...state});
  state.foreground_replies=[];state.background_work_count=0;watchers.get('phone')!();await until(()=>packets.length===2);
  assert.equal(packets[1]!.request_id,undefined);assert.equal(packets[1]!.background_work_count,0);
  stop();assert.equal(stopped,1);stop=attach();await tick();assert.equal(packets.length,2,'new connection must opt in again');
  await assert.rejects(api.handle({operation:'turns_sync',request_id:'foreign'},controls.source('foreign'),async()=>{}),/TURN_WORK_ATTACHMENT_REQUIRED/);
  await assert.rejects(api.handle({operation:'turns_sync',request_id:'bad',extra:true},source,async()=>{}),/FORMAL_CONTROL_ARGUMENT_INVALID/);
  assert.deepEqual(errors,[]);
});

test('opted-in history pages mark only their last frame, including split rows and an empty page',async t=>{
  const f=await timelineFixture(t);
  f.append(1);f.append(2,'汉😀'.repeat(10000));f.append(3);
  const phone=f.attach('phone');
  await phone.sync({limit:2,page_markers:true});
  const frames=phone.packets.filter(body=>body.request_id==='catchup');
  assert.ok(frames.length>2);
  assert.ok(frames.slice(0,-1).every(body=>body.page_end===false));
  assert.equal(frames.at(-1)!.page_end,true);
  assert.equal(frames.at(-1)!.has_more,true);
  assert.deepEqual([...new Set(frames.flatMap(body=>(body.items as any[]).map(row=>row.seq)))],[2,3]);
  const start=phone.packets.length;
  await phone.sync({after_seq:3,limit:30,page_markers:true});
  assert.deepEqual(phone.packets[start]!.items,[]);
  assert.equal(phone.packets[start]!.page_end,true);
  const legacy=f.attach('mac');await legacy.sync({limit:1});
  assert.ok(legacy.packets.every(body=>!Object.hasOwn(body,'page_end')));
});

const activitySnapshot=(id:string,revision:number):WireBody=>{
  const body=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/activity-update.fixtures.json',import.meta.url),'utf8')).fixtures.single_running;
  body.processed_event_id=`processed-${id}`;body.card.id=`a:${id}`;body.card.revision=revision;return body;
};

test('HUD activity snapshots preserve publication order through timeline coalescing',async t=>{
  const f=await timelineFixture(t,{fanout_classes:['glasses']}),gate=Promise.withResolvers<void>();
  const glasses=f.attach('glasses',async body=>{if(body.operation==='errand_progress')await gate.promise;});
  const publish=(body:WireBody)=>f.api.publish(body,f.source('glasses'),async()=>assert.fail('activity bypassed attachment'));
  try{
    await publish({operation:'errand_progress',errands:[]});await until(()=>glasses.packets.length===1);
    for(const body of [activitySnapshot('a',1),activitySnapshot('b',2),activitySnapshot('a',3)])await publish(body);
  }finally{gate.resolve();}
  await until(()=>glasses.packets.length===3);
  assert.deepEqual(glasses.packets.slice(1).map(body=>(body.card as {revision:number}).revision),[2,3]);
  assert.deepEqual(f.errors,[]);
});

test('HUD activity retry stays before newer snapshots after a failed send',async t=>{
  const f=await timelineFixture(t,{fanout_classes:['glasses']}),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let failed=false;
  const glasses=f.attach('glasses',async body=>{
    if((body.card as {revision:number}).revision===1&&!failed){entered.resolve();await gate.promise;failed=true;throw Error('SDK_PUBLISH_FAILED');}
  });
  const publish=(body:WireBody)=>f.api.publish(body,f.source('glasses'),async()=>assert.fail('activity bypassed attachment'));
  try{
    await publish(activitySnapshot('a',1));await entered.promise;
    await publish(activitySnapshot('b',2));await publish(activitySnapshot('c',3));
  }finally{gate.resolve();}
  await until(()=>glasses.packets.length===4);
  assert.deepEqual(glasses.packets.slice(1).map(body=>(body.card as {revision:number}).revision),[1,2,3]);
  assert.equal(f.errors.length,1);assert.match(String(f.errors[0]),/SDK_PUBLISH_FAILED/);
});
