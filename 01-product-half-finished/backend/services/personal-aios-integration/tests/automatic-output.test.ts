import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { inspectWav } from '../src/tts.ts';
import { EVENT_SCHEMA,sha256 } from '../src/contracts.ts';
import { policy } from './sealed-replay-check.ts';
import type { NativeRun } from './native-source-fixture.ts';
const now='2026-10-01T00:00:00.000Z';
test('retired native run keeps its subscription while the explicit OUT finalizer is blocked before sealing',{timeout:10000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-retired-before-seal-')),storage=new PosixStorage(root);
  const bound=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),delivered=Promise.withResolvers<void>();
  const run:NativeRun={run_id:'retired',session_id:'session',conversation_session_id:'session',status:'running',output:'original final reply'};
  const native={create:async()=>({...run}),status:async()=>{bound.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
  const bytes=Buffer.alloc(524);bytes.write('RIFF');bytes.writeUInt32LE(516,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);
  bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(480,40);
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>{entered.resolve();await release.promise;return {sources:[]};},
    tts:{synthesize:async()=>inspectWav(bytes)}}),admission=new RunAdmission(storage,native,policy);
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'c',route_version:'r',output_modes:['text','voice'],token_sha256:sha256('fixture')}];
  // Explicit result finalization is supported without the optional automatic terminal owner.
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output,devices,skill:'fixed',max_read_bytes:8192});
  let sealing:Promise<unknown>|undefined;const errors:unknown[]=[],received:string[]=[];
  t.after(async()=>{release.resolve();await sealing;await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const source=await runtime.authenticate('fixture'),{processed_event:d}=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'retired',
    device_id:'mac',device_type:'mac',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('request')},source,'session',true);
  await bound.promise;
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'open'},args:{reply_mode:'text_and_voice'}});
  run.status='completed';
  for(let n=0;n<1000&&admission.find(run.run_id,'session');n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(admission.find(run.run_id,'session'),undefined);
  assert.equal((await admission.readOnly('owner','session',d.processed_event_id))?.state,'completed');
  sealing=runtime.result(source,'session',d.processed_event_id);await entered.promise;
  await runtime.subscribeResult(source,'session',d.processed_event_id,async value=>{
    received.push(value.chunks.map(chunk=>chunk.text).join(''));delivered.resolve();
  },error=>errors.push(error));
  assert.deepEqual(errors,[]);assert.deepEqual(received,[]);
  release.resolve();await sealing;await delivered.promise;
  assert.deepEqual(received,[run.output]);assert.deepEqual(errors,[]);
});
for(const kind of ['chat','errand','payment-disabled','publication-failure','close','result-hold'] as const)
test(`bound admission snapshots precede fast formal result despite held transport: ${kind}`,{timeout:15000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-admission-order-'));
  const storage=new PosixStorage(root),created=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const resultRelease=Promise.withResolvers<void>();
  const persist=storage.publish.bind(storage);storage.publish=async(namespace,key,bytes)=>{if(namespace==='run-attempts')await created.promise;return persist(namespace,key,bytes);};
  let creates=0,polls=0,runtime:PersonalAIOSRuntime;
  const run:NativeRun={run_id:'fast',session_id:'session',conversation_session_id:'session',status:'running',output:'finished'};
  const native={create:async()=>{if(++creates===1)await created.promise;return {...run,run_id:creates===1?'fast':'next'};},
    status:async(runId:string)=>{
      if(runId==='next')return {...run,run_id:runId};
      polls++;
      if(polls===1){
        if(kind==='payment-disabled')assert.deepEqual(await runtime.tool('paios_payment',{context:{run_id:runId,session_id:'session',tool_call_id:'pay'},
          args:{action:'request',purpose:'午饭',app:'千问',budget_yuan:16.6}}),{status:'rejected',error_code:'PAYMENT_DISABLED'});
        await runtime.tool('paios_open_reply',{context:{run_id:runId,session_id:'session',tool_call_id:'open'},args:{reply_mode:'text'}});
      }
      return {...run,status:'completed'};
    },cancel:async()=>({...run,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'c',route_version:'r',output_modes:['text'],token_sha256:sha256('fixture')}];
  const errors:unknown[]=[],admission=new RunAdmission(storage,native,{...policy,max_pending_events:1});
  runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,devices,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:e=>errors.push(e)}});
  t.after(async()=>{created.resolve();release.resolve();resultRelease.resolve();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const source=await runtime.authenticate('fixture'),raw={schema_version:EVENT_SCHEMA,event_id:'first',device_id:'mac',device_type:'mac' as const,captured_at:now,
    source:{channel:'text'},media_type:kind==='errand'?'app_event' as const:'text' as const,mime:kind==='errand'?'application/json':'text/plain;charset=utf-8',representation:'uploaded_original' as const,
    payload:Buffer.from(kind==='errand'?JSON.stringify({kind:'errand_result',job_id:'job-0123456789ab',status:'completed',answer:'办好了'}):'request')};
  const first=kind==='errand'?await runtime.submitErrand(raw,source,'session'):await runtime.submit(raw,source,'session',true);
  const packets:{state:string;run_id?:string|undefined;run_order?:number|undefined}[]=[],done=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  const subscribing=runtime.subscribeResult(source,'session',first.processed_event.processed_event_id,async value=>{
    packets.push({state:'result',run_id:value.admission.run_id,run_order:value.admission.run_order});done.resolve();
    if(kind==='result-hold')await resultRelease.promise;
  },e=>{errors.push(e);done.resolve();},{on_admission:async value=>{
    if(value.admission.state==='pending'){created.resolve();entered.resolve();await release.promise;}
    if(kind==='publication-failure'&&value.admission.state==='running')throw new Error('STATE_SEND_FAILED');
    packets.push({...value.admission});
  }});
  await entered.promise;
  // Completion, sealing and the next native run proceed while pending publication is held.
  for(let n=0;n<1000&&!((await admission.readOnly('owner','session',first.processed_event.processed_event_id))?.state==='completed'&&!admission.find('fast','session'));n++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await admission.readOnly('owner','session',first.processed_event.processed_event_id))?.state,'completed');
  assert.equal(admission.find('fast','session'),undefined);assert.equal(packets.length,0);
  await runtime.submit({...raw,event_id:'second',media_type:'text',mime:'text/plain;charset=utf-8',payload:Buffer.from('next')},source,'session',true);
  for(let n=0;n<1000&&creates<2;n++)await new Promise(r=>setTimeout(r,5));assert.equal(creates,2);
  if(kind==='close'){await runtime.close();await subscribing;assert.equal(packets.length,0);assert.deepEqual(errors,[]);return;}
  release.resolve();await done.promise;
  if(kind==='result-hold'){
    const closing=runtime.close(),closed=await Promise.race([closing.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1000))]);
    resultRelease.resolve();await subscribing;await closing;assert.equal(closed,true,'runtime close must not join blocked result transport');
  }else await subscribing;
  if(kind==='publication-failure'){assert.deepEqual(packets.map(p=>p.state),['pending','accepted']);assert.match(String(errors[0]),/STATE_SEND_FAILED/);assert.equal(errors.length,1);return;}
  assert.deepEqual(packets.map(p=>p.state),['pending','accepted','running','completed','result']);
  assert.deepEqual(packets.slice(1).map(p=>p.run_id),['fast','fast','fast','fast']);
  assert.ok(packets[1]!.run_order);assert.ok(packets.slice(1).every(p=>p.run_order===packets[1]!.run_order));
  assert.equal(polls,2,'one fixture snapshot sample plus one terminal authoritative GET');assert.deepEqual(errors,[]);
  if(process.env.PAIOS_ADMISSION_PUBLICATION_RECEIPTS)await fs.appendFile(process.env.PAIOS_ADMISSION_PUBLICATION_RECEIPTS,JSON.stringify({kind,evidence:'local POSIX admission/OUT and native protocol fixture; no staging/device',packets,polls,creates})+'\n');
});
test('terminal persists/releases native barrier before slow OUT TTS; output close joins actual hook without native rerun',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-auto-barrier-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),ttsEntered=Promise.withResolvers<void>(),ttsRelease=Promise.withResolvers<void>(),secondCreated=Promise.withResolvers<void>(),firstObserved=Promise.withResolvers<void>();
  let creates=0,ttsCalls=0,synthesisSignal:AbortSignal|undefined;const runs=new Map<string,NativeRun>();
  const native={create:async()=>{const run={run_id:'run-'+ ++creates,session_id:'session',conversation_session_id:'session',status:'running',output:'one final text'};runs.set(run.run_id,run);if(creates===2)secondCreated.resolve();return {...run};},
    status:async(run:string)=>{firstObserved.resolve();return {...runs.get(run)!};},cancel:async(run:string)=>({...runs.get(run)!,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text','voice','text_and_voice'],token_sha256:sha256('fixture')}];
  const errors:unknown[]=[],out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async(_text,_id,signal)=>{synthesisSignal=signal;ttsCalls++;ttsEntered.resolve();await ttsRelease.promise;throw new Error('controlled synthesis failure');}}});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,output:out,devices,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
  const source=await runtime.authenticate('fixture'),submit=async(event:string)=>runtime.submit({schema_version:EVENT_SCHEMA,event_id:event,device_id:'mac',device_type:'mac',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(event)},source,'session',true);
  try {
    const first=await submit('one');await firstObserved.promise;
    await runtime.tool('paios_open_reply',{context:{run_id:'run-1',session_id:'session',tool_call_id:'open'},args:{reply_mode:'text_and_voice'}});
    await submit('two');assert.equal(creates,1);runs.get('run-1')!.status='completed';await ttsEntered.promise;await secondCreated.promise;
    assert.equal(creates,2);const ended=await runtime.event(source,'session',first.processed_event.processed_event_id);assert.equal(ended.admission.state,'completed');
    const closing=runtime.close();let drained=false;void closing.then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    assert.equal(synthesisSignal?.aborted,true);
    ttsRelease.resolve();await closing;assert.equal(drained,true);assert.equal(ttsCalls,1);assert.equal(creates,2);assert.equal(errors.length,0);
    const ctx={principal_id:'owner',session_id:'session',run_id:'run-1',tool_call_id:'final-buffer',d:first.processed_event,target:{device_id:'mac',device_type:'mac' as const,route_version:'route',output_modes:devices[0]!.output_modes}};
    const durable=await out.readSealedText(ctx);assert.equal(durable.result.voice_status,'failed');assert.equal(durable.result.delivery_status,'unknown');assert.equal(durable.chunks.map(chunk=>chunk.text).join(''),'one final text');
  } finally {ttsRelease.resolve();await runtime.close();}
});
for(const fault of ['terminal-publication','sealing','after-sealing'] as const)
test(`terminal-before-seal recovery automatically reports without native retention or another action: ${fault}`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-auto-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),persist=storage.publish.bind(storage),failed=Promise.withResolvers<void>();let reject=true,creates=0;
  storage.publish=async(namespace,key,bytes)=>{if(reject && (fault==='terminal-publication'?namespace==='run-terminals':namespace==='output-journal' && JSON.parse(Buffer.from(bytes).toString('utf8')).result)){
    if(fault!=='sealing')await persist(namespace,key,bytes);failed.resolve();throw new Error('TERMINAL_HANDOFF_FAILED');}return persist(namespace,key,bytes);};
  const bound=Promise.withResolvers<void>(),run:NativeRun={run_id:'instant',session_id:'session',conversation_session_id:'session',status:'running',output:'actual terminal'};
  const native={create:async()=>{creates++;return {...run};},status:async()=>{bound.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('fixture')}];
  const errors:unknown[]=[],admission=new RunAdmission(storage,native,{...policy,max_pending_events:1}),runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),devices,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
  t.after(()=>runtime.close());await runtime.configureTimeline({directory:join(root,'timeline')});
  const source=await runtime.authenticate('fixture'),{processed_event:d}=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'instant',device_id:'mac',device_type:'mac',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('original')},source,'session',true);
  await bound.promise;await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'open'},args:{reply_mode:'text'}});
  run.status='completed';await failed.promise;
  assert.equal(runtime.timeline!.page('owner').items.filter(item=>item.kind==='yimi').length,0);
  await runtime.close();reject=false;
  native.status=async()=>{throw new Error('NATIVE_RETENTION_EXPIRED');};
  const recovered=new RunAdmission(storage,native,policy),next=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:recovered,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),devices,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});t.after(()=>next.close());
  await next.configureTimeline({directory:join(root,'timeline')});await recovered.recover();
  assert.deepEqual(next.timeline!.page('owner').items.filter(item=>item.kind==='yimi').map(item=>item.text),['actual terminal'],
    'startup recovery projects the retained output obligation before any client result read');
  let reports=0;
  await next.subscribeResult(await next.authenticate('fixture'),'session',d.processed_event_id,async value=>{
    reports++;assert.equal(value.admission.state,'completed');assert.equal(value.result.result_status,'completed');assert.equal(value.chunks.map(c=>c.text).join(''),'actual terminal');
  },error=>{throw error;});
  assert.equal(reports,1);assert.equal(creates,1);assert.equal(errors.length,fault==='terminal-publication'?0:1);
  assert.equal(next.timeline!.page('owner').items.filter(item=>item.kind==='yimi').length,1);
});
test('formal result subscription emits first playable WAV while synthesis is pending, with no duplicate sequences',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'paios-auto-stream-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new PosixStorage(root),release=Promise.withResolvers<void>(),first=Promise.withResolvers<void>(),complete=Promise.withResolvers<void>(),bound=Promise.withResolvers<void>();
 const run:NativeRun={run_id:'streamed',session_id:'session',conversation_session_id:'session',status:'running',output:'stream this reply'};
 const native={create:async()=>({...run}),status:async()=>{bound.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
 const devices=[{principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['voice'],token_sha256:sha256('fixture')}];
 const {inspectWav}=await import('../src/tts.ts');const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);
 const errors:unknown[]=[],out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){yield inspectWav(b);await release.promise;yield inspectWav(b);}}});
 const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,{...policy,max_pending_events:1}),native,output:out,devices,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:e=>errors.push(e)}});
 t.after(async()=>{release.resolve();await runtime.close();});const source=await runtime.authenticate('fixture');
 const {processed_event:d}=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'stream',device_id:'phone',device_type:'phone',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('request')},source,'session',true);
 await bound.promise;assert.deepEqual(await runtime.tool('paios_open_reply',{context:{run_id:'streamed',session_id:'session',tool_call_id:'open'},args:{reply_mode:'voice'}}),{status:'opened',error_code:null});
 const observed:number[]=[];
 await runtime.subscribeResult(source,'session',d.processed_event_id,async value=>{
   for(const chunk of value.voice_chunks){observed.push(chunk.seq);assert.equal((await runtime.audio(source,'session',d.processed_event_id,chunk.audio.ref)).sha256,chunk.audio.sha256);}
   if(observed.length===1 && value.result.voice_status==='pending')first.resolve();
   if(value.result.voice_status==='ready')complete.resolve();
 },e=>{errors.push(e);first.reject(e);complete.reject(e);},{voice_settlement:true});
 run.status='completed';await first.promise;assert.deepEqual(observed,[1]);
 const stop=await runtime.subscribeResult(source,'session',d.processed_event_id,async()=>{},e=>errors.push(e),{voice_settlement:true});
 await assert.rejects(runtime.subscribeResult(source,'session',d.processed_event_id,async()=>{},e=>errors.push(e),{voice_settlement:true}),/AUTOMATIC_OUTPUT_SUBSCRIPTION_BUDGET/);
 stop();const replacement=await runtime.subscribeResult(source,'session',d.processed_event_id,async()=>{},e=>errors.push(e),{voice_settlement:true});replacement();
 release.resolve();await complete.promise;assert.deepEqual(observed,[1,2]);assert.deepEqual(errors,[]);
});

for(const lifecycle of ['online','restart','close'] as const)
test(`unavailable automatic outreach retains one admission obligation and resumes without native rerun: ${lifecycle}`,{timeout:30000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-outreach-recovery-')),storage=new PosixStorage(root);
  const failed=Promise.withResolvers<void>(),bound=Promise.withResolvers<void>(),delivered=Promise.withResolvers<void>();
  let creates=0,attempts=0;
  const run:NativeRun={run_id:'outreach',session_id:'session',conversation_session_id:'session',status:'running',output:'fixture automatic result'};
  const native={create:async()=>{creates++;return {...run};},status:async()=>{bound.resolve();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,capabilities:['display','chat_ui'] as const,channel:'text',consent_ref:'c',route_version:'r',output_modes:['text'],token_sha256:sha256('fixture')}];
  let admission:RunAdmission;
  const errors:unknown[]=[],make=()=>new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:(admission=new RunAdmission(storage,native,policy)),native,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),devices,skill:'fixed',max_read_bytes:8192,
    automatic_output:{onError:error=>{errors.push(error);failed.resolve();}}});
  let runtime=make();t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  let outreachAttempts=0;const outreach=runtime.timeline!.outreach.bind(runtime.timeline);
  runtime.timeline!.outreach=(...args)=>{outreachAttempts++;return outreach(...args);};
  const source=await runtime.authenticate('fixture');
  const accepted=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'outreach',device_id:'mac',device_type:'mac',captured_at:now,
    source:{channel:'text'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify({kind:'scheduled_task',job_id:'fixture-job',task:'fixture task'}))},source,'session',false);
  await bound.promise;
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'open'},args:{reply_mode:'text'}});
  run.status='completed';await failed.promise;
  assert.match(String(errors[0]),/CARE_OUTREACH_UNAVAILABLE/);
  for(let n=0;n<100&&admission!.find(run.run_id,'session');n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(admission!.find(run.run_id,'session'),undefined,'pending transport recovery releases the native execution barrier');
  assert.equal((await storage.list('admission-inputs')).length,1);
  if(lifecycle==='online'){
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal(outreachAttempts,1,'offline delivery waits for a terminal instead of retrying');
    assert.equal(errors.length,1,'one log per terminal outage');
    assert.equal((await storage.list('admission-inputs')).length,1,'offline output is retained');
    run.run_id='outreach-2';run.status='running';run.output='another fixture result';
    await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'outreach-2',device_id:'mac',device_type:'mac',captured_at:now,
      source:{channel:'text'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
      payload:Buffer.from(JSON.stringify({kind:'scheduled_task',job_id:'fixture-job-2',task:'another fixture task'}))},source,'session',false);
    for(let n=0;n<100&&!admission!.find(run.run_id,'session');n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(creates,2,'offline output must release the native execution barrier');
    const opened=await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'open-2'},args:{reply_mode:'text'}});assert.equal(opened.status,'opened');
    run.status='completed';
    for(let n=0;n<1000&&outreachAttempts<2;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(outreachAttempts,2);assert.equal(errors.length,1,'other results share the same outage');
    t.mock.timers.enable({apis:['setTimeout']});
    for(let minute=0;minute<240;minute++){
      t.mock.timers.tick(60000);await new Promise(resolve=>setImmediate(resolve));
    }
    assert.equal(outreachAttempts,2,'four offline hours cause no additional attempts');
    assert.equal(errors.length,1);
    assert.equal((await storage.list('admission-inputs')).length,2,'both outputs remain durable');
  }
  if(lifecycle!=='online'){
    await runtime.close();
    if(lifecycle==='close'){
      await new Promise(resolve=>setTimeout(resolve,1100));
      assert.equal(errors.length,1,'closing cancels online recovery and retains the durable obligation');
      assert.equal((await storage.list('admission-inputs')).length,1);return;
    }
    native.status=async()=>{throw new Error('NATIVE_RETENTION_EXPIRED');};runtime=make();
    await runtime.configureTimeline({directory:join(root,'timeline')});
  }
  t.after(await runtime.watchCare(await runtime.authenticate('fixture'),async()=>{attempts++;delivered.resolve();return true;}));
  // Recovery must use the retained terminal/output, even when Hermes is no longer available.
  native.status=async()=>{throw new Error('NATIVE_RETENTION_EXPIRED');};
  if(lifecycle==='restart')await admission!.recover();
  await delivered.promise;
  if(lifecycle==='online')t.mock.timers.reset();
  for(let n=0;n<100&&(await storage.list('admission-inputs')).length;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await storage.list('admission-inputs')).length,0);
  const expected=lifecycle==='online'?2:1;
  assert.equal(creates,expected);assert.equal(attempts,expected);
  assert.equal(runtime.timeline!.page('owner').items.filter(item=>item.kind==='yimi').length,expected);
  assert.equal((await runtime.event(await runtime.authenticate('fixture'),'session',accepted.processed_event.processed_event_id)).admission.state,'completed');
});
