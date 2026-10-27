import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,connect,eventually,waveform,pcmBytes,latest} from './current-unknown-harness.ts';
import {timeoutClock} from '../../../services/personal-aios-integration/tests/timeout-clock-fixture.ts';
async function isolated(f:any){await eventually(()=>!!f.owner.pcmIngress.snapshot().latest_quarantine);return f.owner.pcmIngress.snapshot().latest_quarantine;}
test('current P missing UTC PCM stores exact original under current receive permission, no VAD D Agent',async t=>{
 const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;let vad=0;f.pcm.ports!.vad!.candidates=async()=>{vad++;assert.fail();};
 await connect(f);f.feed();const q=await isolated(f),record=await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision);
 assert.deepEqual(record.bytes,pcmBytes(waveform()));assert.equal(q.event.captured_at,null);assert.equal(q.authorization.historical_capture_range,'unverified');
 assert.equal(q.chunk.source_range.timebase_id.startsWith('received-pcm:'),true);assert.equal(f.owner.pcmIngress!.snapshot().latest,undefined);
 assert.equal(vad,0);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();
 assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
});
test('current P known PCM then missing track clock preserves known original and isolates next sequence',async t=>{
 const f=await fixture(t);await connect(f);f.feed();const known=await latest(f);f.pcm.clock!.resolve=async()=>undefined;f.feed(waveform(1));const q=await isolated(f);
 assert.equal(q.chunk.seq,1);assert.equal(typeof known.event.captured_at,'string');assert.equal((await f.owner.media!.archive.readRecord(known.event.raw_ref,'owner',known.event.archive_revision)).kind,'stream');
 assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform(1)));
});
test('current P unknown span uses same event owner; missing required resolver fails exact503',async t=>{
 const f=await fixture(t,{span:true});delete f.pcm.clock!.resolveSpan;await f.create();await assert.rejects(async()=>{await f.owner.bridge.onBootstrapConnected!(f.input);},e=>(e as any).code==='MEDIA_SPAN_CLOCK_PROVIDER_REQUIRED'&&(e as any).status===503);
 const g=await fixture(t,{span:true});g.pcm.clock!.resolveSpan=async()=>undefined;await connect(g);g.feed();const q=await isolated(g);
 assert.equal(q.event.media_type,'livekit_tracks');assert.equal(q.event.event_id.startsWith('span:'),true);assert.equal(g.nativeInputs.length,0);
});
test('current P bad map and source callback EIO do not become quarantine',async t=>{
 for(const mode of ['map','io'])await t.test(mode,async t=>{
  const f=await fixture(t);const old=f.pcm.clock!.resolve;const fault=Object.assign(new Error('SOURCE_EIO'),{code:'EIO'});
  f.pcm.clock!.resolve=async(b,c)=>mode==='io'?Promise.reject(fault):{...(await old(b,c))!,target_timebase_id:'wrong'};
  await connect(f);f.feed();await eventually(()=>f.errors.length>0);assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);
  if(mode==='io')assert.equal(f.errors[0],fault);else assert.match(String(f.errors[0]),/MEDIA_SOURCE_CLOCK_SCOPE_MISMATCH/);
  await f.owner.pcmIngress!.drain();assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
 });
});
test('current P denied permission and expired identity stop unknown capture before publish',async t=>{
 for(const mode of ['deny','expire','fence'])await t.test(mode,async t=>{
  const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
  if(mode==='deny')f.revokeAudio();else if(mode==='expire')f.expire();else f.block();f.feed();await eventually(()=>f.errors.length>0);
  assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.deepEqual(await f.storage.list('objects'),[]);
 });
});
test('current P unknown PCM rolls at the event sample budget and retains both exact originals',async t=>{
 const f=await fixture(t,{budget:{max_samples:320}});f.pcm.clock!.resolve=async()=>undefined;await connect(f);f.feed();const first=await isolated(f);f.feed(waveform(1));
 await eventually(()=>f.owner.pcmIngress!.snapshot().latest_quarantine?.event.event_id!==first.event.event_id);const second=await isolated(f);
 assert.equal(second.chunk.seq,0);assert.deepEqual(f.errors,[]);assert.equal(f.cancels,0);
 assert.deepEqual((await f.owner.media!.archive.readUnknownClock(first.quarantine_ref,'owner',first.archive_revision)).bytes,pcmBytes(waveform()));
 assert.deepEqual((await f.owner.media!.archive.readUnknownClock(second.quarantine_ref,'owner',second.archive_revision)).bytes,pcmBytes(waveform(1)));
 await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
});
test('current P Stop retains received unknown-clock PCM while source preparation drains',async t=>{
 let release=()=>{};t.after(()=>release());const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 const hold=new Promise<void>(r=>release=r);f.holdSource(hold);
 try{f.feed();await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===1);await f.owner.pcmIngress!.stop();release();
  await f.owner.pcmIngress!.drain();const q=await isolated(f);
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
  assert.equal(q.event.captured_at,null);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
  assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);assert.deepEqual(f.errors,[]);
 }finally{release();}
});
test('current P receipt EIO retains admission and automatically publishes the exact first frame',async t=>{
 let failed=true;t.after(()=>{failed=false;});const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);let attempts=0;
 const clock=timeoutClock(t),published=Promise.withResolvers<void>();
 f.owner.pcmIngress!.tap((_pcm,archive)=>{assert.ok(archive);void archive.then(()=>published.resolve(),published.reject);});
 const pub=f.storage.publish.bind(f.storage);f.storage.publish=async(n,k,b)=>{
  if(n==='quarantine-manifests'){attempts++;if(failed)throw Object.assign(new Error('RECEIPT_EIO'),{code:'EIO'});}return pub(n,k,b);};
 try{
  f.feed();await clock.scheduled(1000);clock.tick(1000);
  // Join the second failed publication; keep its recovery timer stationary while inspecting retention.
  await clock.scheduled(1000);assert.equal(attempts,2);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,0);
  assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.equal((await f.storage.list('raw-ingress')).length,1);
  assert.equal((await f.storage.list('objects')).length,1);assert.equal(f.locked,false);assert.ok(f.permissionReads.includes(true));
  failed=false;clock.tick(1000);await published.promise;const q=f.owner.pcmIngress!.snapshot().latest_quarantine!;
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);assert.deepEqual(f.errors,[]);
 }finally{failed=false;}
});
test('current P source close retains durable quarantine keys without inventing a receipt',async t=>{
 let failed=true;t.after(()=>{failed=false;});const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);let attempts=0;
 const pub=f.storage.publish.bind(f.storage);f.storage.publish=async(n,k,b)=>{
  if(n==='quarantine-manifests'){attempts++;if(failed)throw Object.assign(new Error('RECEIPT_EIO'),{code:'EIO'});}return pub(n,k,b);};
 try{
  f.feed();await eventually(()=>attempts>0);assert.equal(f.locked,false);
  assert.ok(f.permissionReads.includes(true),'permission snapshot reread inside controlled admission fence');
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([f.owner.pcmIngress!.close(),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{
   failed=false;reject(new Error('source close did not detach durable publication waiter'));},1000);})]);}finally{clearTimeout(deadline);}
  const snapshot=f.owner.pcmIngress!.snapshot();assert.equal(snapshot.latest_quarantine,undefined);
  assert.equal(snapshot.pending_bytes,0);assert.equal(snapshot.pending_raw_keys.length,1);
  assert.deepEqual(await f.storage.list('raw-ingress'),snapshot.pending_raw_keys);failed=false;
  await eventually(async()=> (await f.storage.list('quarantine-manifests')).length===1);
  const [key]=await f.storage.list('quarantine-manifests');assert.ok(key);
  const q=JSON.parse(Buffer.from(await f.storage.read('quarantine-manifests',key)).toString());
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
  assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.equal(f.nativeInputs.length,0);
 }finally{failed=false;}
});
test('current P unknown ambient backlog counts omitted samples and resumes exact capture',async t=>{
 let release=()=>{};t.after(()=>release());const f=await fixture(t,{budget:{max_pending_frames:1}});f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 const held=new Promise<void>(r=>release=r);f.holdSource(held);
 try{
  f.feed();await eventually(()=>f.owner.pcmIngress!.snapshot().pending_frames===1);
  f.feed(waveform(1));await eventually(()=>f.owner.pcmIngress!.snapshot().dropped_frames===1);
  const snapshot=f.owner.pcmIngress!.snapshot();assert.equal(snapshot.pending_frames,1);assert.equal(snapshot.dropped_samples,320);
  assert.equal(f.cancels,0);assert.equal(f.errors.length,1);release();const q=await isolated(f);
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
  f.feed(waveform(2));await eventually(()=>f.owner.pcmIngress!.snapshot().latest_quarantine?.chunk.seq===1);
  const recovered=f.owner.pcmIngress!.snapshot().latest_quarantine!;
  assert(recovered.chunk.source_range.kind==='interval');
  assert.equal(recovered.chunk.source_range.start_ms,40);
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(recovered.quarantine_ref,'owner',recovered.archive_revision)).bytes,pcmBytes(waveform(2)));
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();
  assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);assert.equal(f.owner.pcmIngress!.snapshot().dropped_frames,1);
 }finally{release();}
});

for(const mode of ['commit','changed-snapshot']) test(`current P ${mode} failure never consumes quarantine publication`,async t=>{
 const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 const fault=new Error('CONTROLLED_COMMIT_FAILURE');if(mode==='commit')f.failFenceCommit(fault);else f.mutate();
 let publishes=0;const pub=f.storage.publish.bind(f.storage);f.storage.publish=async(n,k,b)=>{
  if(['objects','quarantine-manifests','raw-ingress'].includes(n)){publishes++;assert.equal(f.locked,false);}return pub(n,k,b);};
 f.feed();await eventually(()=>f.errors.length>0);await f.owner.pcmIngress!.drain();
 assert.ok(f.permissionReads.includes(true));if(mode==='commit')assert.equal(f.errors[0],fault);else assert.match(String(f.errors[0]),/MEDIA_PERMISSION_CHANGED/);
 assert.equal(publishes,0);assert.deepEqual(await f.storage.list('objects'),[]);assert.deepEqual(await f.storage.list('quarantine-manifests'),[]);assert.deepEqual(await f.storage.list('raw-ingress'),[]);
 assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
 assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);assert.equal(f.locked,false);
});

test('older quarantine receipt retry cannot replace the latest captured frame',async t=>{
 const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 let failed=true;t.after(()=>{failed=false;});const publish=f.storage.publish.bind(f.storage);
 t.mock.method(f.storage,'publish',async(n:string,k:string,b:Uint8Array)=>{
  if(n==='quarantine-manifests'&&JSON.parse(Buffer.from(b).toString()).chunk.seq===0&&failed)
   throw Object.assign(new Error('FIRST_RECEIPT_EIO'),{code:'EIO'});
  return publish(n,k,b);
 });
 try{
  f.feed();await eventually(async()=>(await f.storage.list('raw-ingress')).length===1&&f.owner.pcmIngress!.snapshot().pending_frames===0);
  f.feed(waveform(1));await eventually(()=>f.owner.pcmIngress!.snapshot().latest_quarantine?.chunk.seq===1);
  failed=false;await eventually(async()=>(await f.storage.list('raw-ingress')).length===0);
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();
  assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine!.chunk.seq,1);
  const records=await Promise.all((await f.storage.list('quarantine-manifests')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('quarantine-manifests',key)).toString())));
  assert.equal(records.length,2);
  for(const record of records)assert.deepEqual((await f.owner.media!.archive.readUnknownClock(record.quarantine_ref,'owner',record.archive_revision)).bytes,pcmBytes(waveform(record.chunk.seq)));
 }finally{failed=false;}
});
