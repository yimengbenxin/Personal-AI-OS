import {materialized,webdav} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {EVENT_SCHEMA,digest,sha256,check} from '../src/contracts.ts';
import {RawArchive} from '../src/archive.ts';
import type {RawEvent,TrustedContext} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import type {StoragePort} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import type {TrackChunk} from '../src/stream-archive.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'consent',channel:'livekit',submission:'observation'};
const budget={max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:100};
const raw=(payload=Buffer.from([1,2])):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:'stream',device_id:'glasses',
  device_type:'glasses',captured_at:at,source:{channel:'livekit'},media_type:'livekit_tracks',mime:'audio/pcm',
  representation:'received_decoded_sample',payload});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'epoch1',seq,modality:'audio',format:'pcm_s16le:1000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch1',start_ms:seq*100,end_ms:(seq+1)*100}});
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'paios-stream-'));t.after(()=>fs.rm(root,{force:true,recursive:true}));
  const storage=new PosixStorage(root);return {root,storage,archive:new StreamArchive(storage,budget)};}
test('S1 stable stream identity, chunk dedup, exact conflict, late revision and gaps across restart',async t=>{
  const {storage,archive}=await fixture(t);
  const first=await archive.append(raw(),trusted,at,chunk(0));
  const gap=await archive.append(raw(),trusted,at,chunk(2));
  assert.equal(first.event.raw_ref,gap.event.raw_ref);assert.deepEqual((await materialized(archive,gap)).extents[0]!.missing_seqs,[1]);
  assert.deepEqual((await materialized(archive,gap)).extents[0]!.gaps,[{kind:'interval',timebase_id:'samples',stream_epoch:'epoch1',start_ms:100,end_ms:200}]);
  const restarted=new StreamArchive(storage,budget);
  const late=await restarted.append(raw(),trusted,at,chunk(1));assert.equal((await materialized(archive,late)).revision,3);
  assert.deepEqual((await materialized(archive,late)).extents[0]!.gaps,[]);assert.deepEqual(await restarted.revision(first.event.raw_ref,1),(await materialized(archive,first)));
  const duplicate=await restarted.append(raw(),trusted,'2026-10-01T01:00:00.000Z',chunk(1));assert.deepEqual(duplicate,late);
  await assert.rejects(restarted.append(raw(Buffer.from([4,5])),trusted,at,chunk(1)),/CHUNK_IDENTITY_CONFLICT/);
});
test('independent archive instances compete without losing either chunk',async t=>{
  const {storage,archive}=await fixture(t),other=new StreamArchive(storage,budget);
  const results=await Promise.all([archive.append(raw(),trusted,at,chunk(0)),other.append(raw(),trusted,at,chunk(1))]);
  const head=await archive.head(results[0]!.event.raw_ref);assert.equal(head!.chunks.length,2);assert.equal(head!.revision,2);
});
test('independent Node processes append concurrent revisions and restart finds both durable chunks',async t=>{
  const {root,archive}=await fixture(t);
  const execute=(seq:number)=>new Promise<string>((resolve,reject)=>{
    const code=`import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts',import.meta.url).href)};
import {StreamArchive} from ${JSON.stringify(new URL('../src/stream-archive.ts',import.meta.url).href)};
const a=new StreamArchive(new PosixStorage(${JSON.stringify(root)}),${JSON.stringify(budget)});
const r=await a.append({...${JSON.stringify({...raw(),payload:null})},payload:Buffer.from([1,2])},${JSON.stringify(trusted)},${JSON.stringify(at)},${JSON.stringify(chunk(seq))});
process.stdout.write(r.event.raw_ref);`;
    const child=spawn(process.execPath,['--input-type=module','-e',code]);let out='',errors='';
    child.stdout.on('data',b=>out+=String(b));child.stderr.on('data',b=>errors+=String(b));child.on('error',reject);
    child.on('exit',status=>status===0?resolve(out):reject(new Error(errors)));
  });
  const refs=await Promise.all([execute(0),execute(1)]);assert.equal(refs[0],refs[1]);
  const head=await archive.head(refs[0]!);assert.equal(head!.chunks.length,2);assert.equal(head!.extents[0]!.durable_until_ms,200);
});
test('L5 full disk/revision failure preserves prior durable extent and retry recovers orphan object',async t=>{
  const {storage,archive}=await fixture(t);const first=await archive.append(raw(),trusted,at,chunk(0));
  let fail=true;const fault:StoragePort={removePending:k=>storage.removePending(k),list:n=>storage.list(n),read:(n,k)=>storage.read(n,k),publish:(n,k,b)=>{
    if(n==='stream-revisions'&&k===digest([first.event.raw_ref,2])&&fail){fail=false;throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}return storage.publish(n,k,b);}};
  const failing=new StreamArchive(fault,budget);
  await assert.rejects(failing.append(raw(Buffer.from([8,9])),trusted,at,chunk(1)),/ENOSPC/);
  assert.deepEqual(await archive.head(first.event.raw_ref),(await materialized(archive,first)));
  assert.equal((await materialized(failing,await failing.append(raw(Buffer.from([8,9])),trusted,at,chunk(1)))).revision,2);
});
test('representation/timebase changes require new epoch; device and resource boundaries fail explicitly',async t=>{
  const {archive,storage}=await fixture(t);await archive.append(raw(),trusted,at,chunk(0));
  await assert.rejects(archive.append({...raw(),representation:'received_encoded_track'},trusted,at,chunk(1)),/TRACK_DESCRIPTOR_CHANGED_WITHOUT_EPOCH/);
  await assert.rejects(archive.append({...raw(),device_id:'other'},trusted,at,chunk(1)),/DEVICE_BINDING_MISMATCH/);
  await assert.rejects(new StreamArchive(storage,{...budget,max_total_bytes:2}).append(raw(),trusted,at,chunk(1)),/STREAM_BUDGET_EXCEEDED/);
  const next={...chunk(0),stream_epoch:'epoch2',source_range:{...chunk(0).source_range,stream_epoch:'epoch2'}};
  assert.equal((await materialized(archive,await archive.append(raw(),trusted,at,next))).extents.length,2);
});

test('materialized journal proof is immutable; cloned or forged proofs still validate every delta',async t=>{
  const {archive}=await fixture(t),{streamManifestRevision}=await import('../src/stream-archive.ts');
  const first=await archive.append(raw(),trusted,at,chunk(0));
  const m=(await archive.head(first.event.raw_ref))!;
  assert.equal(streamManifestRevision(m),first.event.archive_revision);
  assert.throws(()=>{m.journal![0]!.chunk.seq=99;},TypeError);
  assert.throws(()=>{m.chunks.push(m.chunks[0]!);},TypeError);
  assert.throws(()=>{m.extents[0]!.durable_ranges=[];},TypeError);
  const copied=structuredClone(m);assert.equal(streamManifestRevision(copied),first.event.archive_revision);
  copied.journal![0]!.total_bytes++;
  assert.throws(()=>streamManifestRevision(copied),/STREAM_REVISION_INTEGRITY/);
  await archive.append(raw(),trusted,at,chunk(1));
  assert.equal(m.revision,1);assert.equal(m.chunks.length,1);
  assert.equal(streamManifestRevision(m),first.event.archive_revision);
});

test('L5 packed hot/cold preserves mic, reply, full frame, upload and old revision across restart',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-')),hot=join(root,'hot'),remote=await webdav(t,root);
  const storage=new PosixStorage(hot,{cold:remote.config}),coldBudget={...budget,max_chunk_bytes:8192},archive=new RawArchive(storage,65536,()=>at,coldBudget),stream=new StreamArchive(storage,coldBudget);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const microphone=Buffer.alloc(3200);for(let i=0;i<1600;i++)microphone.writeInt16LE(Math.round(Math.sin(i/9)*9000),i*2);
  const mic=await stream.append(raw(microphone),trusted,at,{...chunk(0),format:'pcm_s16le:16000:1'});
  const reply=Buffer.alloc(4800);for(let i=0;i<2400;i++)reply.writeInt16LE(Math.round(Math.sin(i/12)*7000),i*2);
  const played=await stream.append(raw(reply),trusted,at,{...chunk(0),track_id:'assistant_reply',stream_epoch:'reply',format:'pcm_s16le:24000:1',
    source_range:{...chunk(0).source_range,stream_epoch:'reply'}});
  const frame=Buffer.from(Array.from({length:24},(_,n)=>n)),camera=await stream.append({...raw(frame),mime:'application/x-livekit-video-buffer'},trusted,at,
    {track_id:'call_camera',stream_epoch:'camera',seq:0,modality:'visual',format:'livekit_decoded:0:4:4:rotation:1',source_range:{kind:'instant',timebase_id:'camera',stream_epoch:'camera',at_ms:70}});
  const file=await archive.archive({...raw(Buffer.from('owner file bytes')),event_id:'file',media_type:'file',mime:'application/pdf',representation:'uploaded_original'},trusted);
  const {captured_at:_time,...unknown}=raw(microphone),quarantined=[];
  for(let seq=0;seq<2;seq++)quarantined.push(await archive.archiveUnknownClock({...unknown,event_id:'unknown-mic',captured_at:null,capture_clock_status:'unknown'},trusted,
    {...chunk(seq),format:'pcm_s16le:16000:1'},{receipt:'fixture'}));
  const moves=storage.moveCold.bind(storage);let groupedUnknown=false;
  storage.moveCold=records=>{if(records.filter(r=>r.namespace==='quarantine-manifests').length===2)groupedUnknown=true;return moves(records);};
  const final=await archive.finalizeSession(mic.event.raw_ref,'call_hangup');
  assert.ok(final);
  const receipt=await archive.moveCold(2);assert.ok(receipt.segments>=1&&receipt.segments<=2);assert.ok(receipt.cold_bytes<receipt.hot_bytes);
  assert.ok((await fs.readdir(join(hot,'objects'))).length>0,'verified young copies retain hot bytes');
  await assert.rejects(archive.moveCold(0),/INVALID_HOT_DAYS/);
  const fileKey=sha256(Buffer.from('owner file bytes')),oldTime=new Date(Date.now()-3*86400000);
  await fs.utimes(join(hot,'objects',fileKey),oldTime,oldTime);
  const reused=await archive.archive({...raw(Buffer.from('owner file bytes')),event_id:'file-reused',media_type:'file',mime:'application/pdf',representation:'uploaded_original'},trusted);
  await archive.moveCold(2,Date.now()+47*3600000);
  assert.deepEqual(await fs.readFile(join(hot,'objects',fileKey)),Buffer.from('owner file bytes'),'new dedup reuse refreshes the 48h hot deadline');
  await archive.moveCold(2,Date.now()+5*86400000);
  assert.equal(groupedUnknown,true,'quarantine metadata also tiers without resolving or reclassifying its capture clock');
  assert.deepEqual(await fs.readdir(join(hot,'objects')),[]);
  assert.equal(await storage.cold!.contains('objects',final.object_hash),true);
  await storage.close();const reopened=new PosixStorage(hot,{cold:remote.config}),reader=new RawArchive(reopened,65536,()=>at,coldBudget);
  t.after(()=>reopened.close());
  const record=await reader.readRecord(camera.event.raw_ref,'owner',camera.event.archive_revision);assert.equal(record.kind,'stream');
  if(record.kind!=='stream')throw new Error('stream required');assert.deepEqual(record.chunks.map(r=>Buffer.from(r.bytes)),[microphone,reply,frame]);
  const old=await reader.readRecord(mic.event.raw_ref,'owner',mic.event.archive_revision);assert.equal(old.kind,'stream');if(old.kind==='stream')assert.equal(old.chunks.length,1);
  assert.deepEqual(await reader.read(file.raw_ref,'owner',file.archive_revision),Buffer.from('owner file bytes'));
  assert.deepEqual(await reader.read(reused.raw_ref,'owner',reused.archive_revision),Buffer.from('owner file bytes'));
  for(const q of quarantined)assert.deepEqual((await reader.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,microphone);
  const copy=await reopened.read('objects',sha256(microphone));copy[0]=copy[0]!^255;
  assert.deepEqual(Buffer.from(await reopened.read('objects',sha256(microphone))),microphone,'cold readers cannot mutate cached originals');
  await assert.rejects(new StreamArchive(reopened,coldBudget).append(raw(Buffer.alloc(3200,1)),trusted,at,{...chunk(1),format:'pcm_s16le:16000:1'}),/STREAM_ALREADY_FINAL/);
  const later=await new StreamArchive(reopened,coldBudget).append({...raw(Buffer.alloc(3200,1)),event_id:'next-session'},trusted,at,{...chunk(0),format:'pcm_s16le:16000:1'});
  assert.notEqual(later.event.raw_ref,played.event.raw_ref);assert.equal((await reader.locate(later.event.raw_ref,'owner')).bytes,3200);
});

test('cold transfer corruption and HTTP outage retain exact hot bytes without a durable cold index',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-corrupt-')),hot=join(root,'hot'),remote=await webdav(t,root);const storage=new PosixStorage(hot,{cold:remote.config}),payload=Buffer.from('irreplaceable frame'),key=sha256(payload);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});await storage.publish('objects',key,payload);
  remote.state.corrupt=true;
  await assert.rejects(storage.moveCold([{namespace:'objects',key,bytes:payload}]),/COLD_COPY_INTEGRITY/);
  assert.deepEqual(await fs.readFile(join(hot,'objects',key)),payload);assert.equal(await storage.cold!.contains('objects',key),false);
  remote.state.corrupt=false;remote.state.unavailable=true;
  await assert.rejects(storage.moveCold([{namespace:'objects',key,bytes:payload}]),/COLD_HTTP_FAILED/);
  assert.deepEqual(await fs.readFile(join(hot,'objects',key)),payload);
  const archive=new RawArchive(storage,65536,()=>at,budget);t.after(()=>archive.close());
  await archive.archive({...raw(payload),event_id:'outage-frame',media_type:'visual',mime:'image/jpeg'},trusted);
  for(let n=0;n<2200;n++){const proof=Buffer.from(`proof-${n}`);await storage.publish('audio-consumer-results',sha256(proof),proof);}
  let visited=0;const hotSize=storage.hotSize.bind(storage);
  storage.hotSize=async(namespace,key)=>{if(namespace==='audio-consumer-results')visited++;return hotSize(namespace,key);};
  await assert.rejects(archive.moveCold(),/COLD_HTTP_FAILED/);assert.equal(visited,0,'unfinalized processing proofs are never selected for cold upload');
  assert.equal((await storage.listHot('audio-consumer-results')).length,2200);assert.deepEqual(await fs.readFile(join(hot,'objects',key)),payload);
});

test('disk reserve evicts only verified copies before explicit ENOSPC, and corrupt cold reads fail after restart',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-pressure-')),hot=join(root,'hot'),remote=await webdav(t,root);const storage=new PosixStorage(hot,{cold:remote.config}),payload=Buffer.from('verified original'),key=sha256(payload);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});await storage.publish('objects',key,payload);
  const moved=await storage.moveCold([{namespace:'objects',key,bytes:payload}]);await fs.writeFile(join(hot,'objects',key),payload);
  const bad=Buffer.from('corrupt cold candidate'),badKey=sha256(bad);await storage.publish('objects',badKey,bad);
  const failed=await storage.moveCold([{namespace:'objects',key:badKey,bytes:bad}]);await fs.writeFile(join(remote.directory,`${failed.pack}.l5pack`),'corrupt');
  const alerts:unknown[]=[],pressure=new PosixStorage(hot,{cold:remote.config,min_free_bytes:Number.MAX_SAFE_INTEGER,onAlert:e=>alerts.push(e)});t.after(()=>pressure.close());const owner=new RawArchive(pressure,65536,()=>at,budget);owner.setAlert(async reason=>{alerts.push(reason);});
  const packs=pressure.cold!.packs.bind(pressure.cold);pressure.cold!.packs=async mode=>(await packs(mode)).sort((a,b)=>Number(b.key===failed.pack)-Number(a.key===failed.pack));
  await assert.rejects(pressure.publish('objects',sha256('new'),Buffer.from('new')),error=>(error as NodeJS.ErrnoException).code==='ENOSPC');
  await owner.close();assert.ok(alerts.includes('L5_COLD_VERIFICATION_FAILED'));
  assert.deepEqual(await fs.readFile(join(hot,'objects',badKey)),bad);assert.deepEqual(await fs.readFile(join(hot,'objects',key)),payload);assert.deepEqual(await pressure.read('objects',key),payload);
  await pressure.close();await fs.unlink(join(hot,'objects',key));await fs.writeFile(join(remote.directory,`${moved.pack}.l5pack`),'corrupt');const restarted=new PosixStorage(hot,{cold:remote.config});t.after(()=>restarted.close());
  await assert.rejects(restarted.read('objects',key),/COLD_RANGE_TRUNCATED/);
});

test('owner deletion after tiering is idempotent, revokes replay and preserves shared originals and other cold records',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-delete-')),hot=join(root,'hot'),remote=await webdav(t,root);const storage=new PosixStorage(hot,{cold:remote.config}),archive=new RawArchive(storage,65536,()=>at,budget);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});const input={...raw(Buffer.from('shared original')),event_id:'photo',media_type:'visual' as const,mime:'image/jpeg',representation:'uploaded_original' as const};
  const first=await archive.archive(input,trusted),shared=await archive.archive(input,{...trusted,principal_id:'other-owner'});
  const retained=await archive.archive({...input,event_id:'different',payload:Buffer.from('other original')},trusted);
  await archive.moveCold(2,Date.now()+5*86400000);await assert.rejects(archive.delete(first.raw_ref,'other-owner'),/RAW_ACCESS_DENIED/);
  assert.equal((await archive.delete(first.raw_ref,'owner')).status,'deleted');assert.equal((await archive.delete(first.raw_ref,'owner')).status,'deleted');
  await assert.rejects(archive.read(first.raw_ref,'owner',first.archive_revision),/RAW_DELETED/);await assert.rejects(archive.archive(input,trusted),/RAW_DELETED/);
  assert.deepEqual(await archive.read(shared.raw_ref,'other-owner',shared.archive_revision),input.payload);
  assert.deepEqual(await archive.read(retained.raw_ref,'owner',retained.archive_revision),Buffer.from('other original'));
});

test('owner deletion fences quarantine publication, and legacy stream reads honor pending deletion',async t=>{
  const {root,storage,archive:stream}=await fixture(t),archive=new RawArchive(storage,65536,()=>at,budget),payload=Buffer.from('shared original');
  const original=await archive.archive({...raw(payload),event_id:'photo',media_type:'visual',mime:'image/jpeg'},trusted);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),publish=storage.publish.bind(storage);
  storage.publish=async(namespace,key,bytes)=>{if(namespace==='quarantine-manifests'){entered.resolve();await release.promise;}return publish(namespace,key,bytes);};
  const {captured_at:_captured,...unknown}=raw(payload),quarantine=archive.archiveUnknownClock({...unknown,event_id:'unknown',media_type:'visual',mime:'image/jpeg',captured_at:null,capture_clock_status:'unknown'},trusted,
    {track_id:'camera',stream_epoch:'unknown',seq:0,modality:'visual',format:'jpeg',source_range:{kind:'instant',timebase_id:'device',stream_epoch:'unknown',at_ms:1}},{receipt:'fixture'});
  await entered.promise;let deleted=false;const deleting=archive.delete(original.raw_ref,'owner').then(()=>{deleted=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(deleted,false);
  release.resolve();const kept=await quarantine;await deleting;assert.deepEqual((await archive.readUnknownClock(kept.quarantine_ref,'owner',kept.archive_revision)).bytes,payload);
  const first=await stream.append(raw(Buffer.alloc(200)),trusted,at,chunk(0)),manifest=await stream.head(first.event.raw_ref);assert.ok(manifest);
  const legacy={schema:'paios.stream.v1',raw_ref:manifest.raw_ref,revision:1,parent:null,event:manifest.event,chunks:manifest.chunks,extents:manifest.extents};
  await fs.writeFile(join(root,'stream-revisions',digest([first.event.raw_ref,1])),JSON.stringify(legacy));
  await storage.publish('owner-deletions',first.event.raw_ref.slice(3),Buffer.from(JSON.stringify({principal_id:'owner',objects:[sha256(new Uint8Array(200))]})));
  const event={...first.event,archive_revision:digest(legacy)};
  await assert.rejects(archive.readStreamHeader(event),/RAW_DELETED/);await assert.rejects(archive.readExactChunk(event,chunk(0),4096),/RAW_DELETED/);
  await assert.rejects(stream.revision(event.raw_ref,1),/RAW_DELETED/);
});

test('pressure rechecks cached cold copies and deletion retry cleans zero-location transfer copies',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-cold-orphan-')),hot=join(root,'hot'),remote=await webdav(t,root);
  const storage=new PosixStorage(hot,{cold:remote.config}),archive=new RawArchive(storage,65536,()=>at,budget),payload=Buffer.from('last hot copy'),key=sha256(payload);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const event=await archive.archive({...raw(payload),event_id:'orphan-photo',media_type:'visual',mime:'image/jpeg'},trusted);
  const moved=await storage.moveCold([{namespace:'objects',key,bytes:payload}]),packPath=join(remote.directory,`${moved.pack}.l5pack`),saved=await fs.readFile(packPath);
  await storage.cold!.read('objects',key);await fs.writeFile(packPath,'corrupt');
  await assert.rejects(storage.cold!.verifiedRecords([{namespace:'objects',key}]),/COLD_COPY_INTEGRITY/);
  assert.deepEqual(await fs.readFile(join(hot,'objects',key)),payload);await fs.writeFile(packPath,saved);
  const db=new DatabaseSync(join(hot,'cold.sqlite')),orphan=sha256('aborted cold upload');
  db.prepare('INSERT INTO packs(key,size) VALUES(?,?)').run(orphan,0);await fs.writeFile(join(remote.directory,`${orphan}.l5pack`),payload);
  db.prepare('INSERT INTO packs(key,size) VALUES(?,?)').run(sha256('already unlinked'),0);db.close();
  const remove=storage.cold!.removePack.bind(storage.cold);let interrupted=true;
  storage.cold!.removePack=async pack=>{if(interrupted&&pack===moved.pack){interrupted=false;throw new Error('interrupted unlink');}await remove(pack);};
  await assert.rejects(archive.deleteMany([event.raw_ref],'owner'),/interrupted unlink/);
  assert.equal((await storage.cold!.locations([{namespace:'objects',key}])).length,0,'retry cannot rely on already-forgotten locations');
  await archive.deleteMany([event.raw_ref],'owner');assert.deepEqual(await fs.readdir(remote.directory),[]);
  const check=new DatabaseSync(join(hot,'cold.sqlite'));assert.equal(check.prepare('SELECT COUNT(*) AS n FROM packs').get()!.n,0);check.close();
});

test('durable ingress ACK survives failed publication and close, then recovers the same original object',async t=>{
  const {root,storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');
  const errors:unknown[]=[],payload=Buffer.from('accepted original');let attempted!:(value?:unknown)=>void;
  const firstAttempt=new Promise(resolve=>{attempted=resolve;});
  const admission=new OriginalAdmission(storage,async()=>{attempted();throw Object.assign(new Error('disk full'),{code:'ENOSPC'});},e=>errors.push(e));
  const accepted=await admission.admit({trusted:{principal_id:'owner'},event_id:'pending'},payload);
  await firstAttempt;assert.deepEqual(await storage.read('objects',sha256(payload)),payload);
  assert.deepEqual(await storage.list('raw-ingress'),[accepted.key]);
  const reserve=await fs.stat(join(root,'.raw-ingress-reserve'));
  assert.equal(reserve.size,64*1024*1024);assert.ok(reserve.blocks*512>=reserve.size,'reserve must occupy real filesystem blocks');
  await admission.close();await assert.rejects(accepted.commit,/durable input retained/);
  let recovered!:(result:unknown)=>void;const completion=new Promise(resolve=>{recovered=resolve;});
  const restarted=new OriginalAdmission(new PosixStorage(root),async(record,bytes)=>{
    assert.deepEqual(record,{trusted:{principal_id:'owner'},event_id:'pending'});assert.deepEqual(bytes,payload);return 'committed';
  });
  await restarted.recover();const same=await restarted.admit({trusted:{principal_id:'owner'},event_id:'pending'},payload);
  recovered(await same.commit);assert.equal(await completion,'committed');
  assert.deepEqual(await storage.list('raw-ingress'),[]);assert.deepEqual(await storage.list('objects'),[sha256(payload)]);
  assert.ok(errors.length>0);await restarted.close();
});
test('durable ingress surfaces deterministic callback failure once and retains accepted bytes',async t=>{
  const {storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');
  const {ContractError}=await import('../src/contracts.ts');let calls=0;
  const queue=new OriginalAdmission(storage,async()=>{calls++;throw new ContractError('EXACT_CONFLICT',409);});
  const ack=await queue.admit({event_id:'conflict'},Buffer.from('retain'));
  await assert.rejects(ack.commit,/EXACT_CONFLICT/);assert.equal(calls,1);
  const replay=await queue.admit({event_id:'conflict'},Buffer.from('retain'));
  await assert.rejects(replay.commit,/EXACT_CONFLICT/);assert.equal(calls,1);
  assert.deepEqual(await storage.list('raw-ingress'),[ack.key]);await queue.close();
});
test('RawArchive close joins a blocked owner alert after durable ACK and nonretryable publication failure',async t=>{
  const {storage}=await fixture(t),archive=new RawArchive(storage,65536,()=>at,budget);
  let entered!:()=>void,release!:()=>void,alertWritten=false;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  archive.setAlert(async()=>{entered();await gate;
    await storage.publishIngressMeta('archive-alerts',sha256('close-joined-alert'),Buffer.from('publication paused'));alertWritten=true;});
  storage.publishAliased=async()=>{throw Object.assign(new Error('publication filesystem read-only'),{code:'EROFS'});};
  const payload=Buffer.from('durably accepted before publication failure'),ack=await archive.admitStream(raw(payload),trusted,chunk(0));
  await assert.rejects(ack.commit,/publication filesystem read-only/);await started;
  assert.deepEqual(await storage.list('raw-ingress'),[ack.key]);assert.deepEqual(await storage.read('objects',sha256(payload)),payload);
  let closed=false;const closing=archive.close().then(()=>{closed=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(alertWritten,false);
  release();await closing;assert.equal(alertWritten,true);
  assert.deepEqual(await storage.read('archive-alerts',sha256('close-joined-alert')),Buffer.from('publication paused'));
});
test('producer ingress claims allocated reserve under disk pressure and pauses when exhausted',async t=>{
  const {root}=await fixture(t),alerts:unknown[]=[],storage=new PosixStorage(root,{min_free_bytes:Number.MAX_SAFE_INTEGER,onAlert:e=>alerts.push(e)});
  await new PosixStorage(root).prepareCapture();
  const payload=Buffer.from('reserve accepted'),hash=sha256(payload),metadata=Buffer.from('private metadata'),key=sha256(metadata);
  await storage.publishIngress(key,metadata,hash,payload);
  assert.deepEqual(await storage.read('objects',hash),payload);assert.deepEqual(await storage.read('raw-ingress',key),metadata);
  assert.ok((await fs.stat(join(root,'.raw-ingress-reserve'))).size<64*1024*1024);assert.ok(alerts.length>0);
  const alertCount=alerts.length,notice=Buffer.from('owner notification');
  await storage.publishIngressMeta('archive-alerts',sha256('owner-alert'),notice);
  assert.deepEqual(await storage.read('archive-alerts',sha256('owner-alert')),notice);assert.equal(alerts.length,alertCount);
  await fs.truncate(join(root,'.raw-ingress-reserve'),0);
  await assert.rejects(storage.publishIngress(sha256('next'),Buffer.from('next'),sha256('new'),Buffer.from('new')),/RAW_INGRESS_PAUSED/);
  assert.deepEqual(await storage.read('objects',hash),payload);
});

test('capture preparation preserves production free reserve before allocating the emergency pool',async t=>{
  const {root}=await fixture(t),storage=new PosixStorage(root,{min_free_bytes:Number.MAX_SAFE_INTEGER,onAlert:()=>{}});
  await assert.rejects(storage.prepareCapture(),e=>(e as NodeJS.ErrnoException).code==='ENOSPC');
  await assert.rejects(fs.stat(join(root,'.raw-ingress-reserve')),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
  await new PosixStorage(root).prepareCapture();assert.equal((await fs.stat(join(root,'.raw-ingress-reserve'))).size,64*1024*1024);
});
test('initial admission ENOSPC retains immutable producer input before ACK and resumes after space recovers',async t=>{
  const {root}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');let blocked=true,attempted!:()=>void;
  const firstFailure=new Promise<void>(resolve=>{attempted=resolve;});
  class InitiallyFull extends PosixStorage {override async publishIngress(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array){
    if(blocked){attempted();throw Object.assign(new Error('initial full'),{code:'ENOSPC'});}return super.publishIngress(key,metadata,hash,payload);
  }}
  const storage=new InitiallyFull(root),bytes=Buffer.alloc(32*1024*1024,0x42),hash=sha256(bytes),queue=new OriginalAdmission(storage,async(_record,payload)=>sha256(payload));
  let acked=false;const admission=queue.admit({event_id:'first'},Uint8Array.from(bytes)).then(ack=>{acked=true;return ack;});
  bytes.fill(0xee);await firstFailure;assert.equal(acked,false);
  const next=queue.admit({event_id:'queued'},bytes);let nextAcked=false;void next.then(()=>{nextAcked=true;});await Promise.resolve();assert.equal(nextAcked,false);
  assert.deepEqual(await storage.list('raw-ingress'),[]);blocked=false;
  const ack=await admission;assert.equal(await ack.commit,hash);assert.equal(sha256(await storage.read('objects',hash)),hash);assert.equal(await (await next).commit,sha256(bytes));await queue.close();
});
test('close releases pre-ACK backpressure explicitly without waiting for unavailable disk',async t=>{
  const {root}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');let attempted!:()=>void;
  const failure=new Promise<void>(resolve=>{attempted=resolve;});
  class Full extends PosixStorage {override async publishIngress(){attempted();throw Object.assign(new Error('full'),{code:'ENOSPC'});}}
  const queue=new OriginalAdmission(new Full(root),async()=>null),admission=queue.admit({event_id:'unacknowledged'},Buffer.from('held'));
  const rejection=assert.rejects(admission,/RAW_INGRESS_CLOSED_BEFORE_ACK/);await failure;await queue.close();await rejection;
});
test('concurrent producer and owner metadata claims consume distinct reserve bytes without policy deadlock',{timeout:5000},async t=>{
  const {root}=await fixture(t);await new PosixStorage(root).prepareCapture();
  const storage=new PosixStorage(root,{min_free_bytes:Number.MAX_SAFE_INTEGER,onAlert:()=>{}}),metadata=Buffer.alloc(32,0x11),payload=Buffer.alloc(16384,0x22);
  storage.setReservePolicy(async()=>{await storage.publishIngressMeta('archive-alerts',sha256('policy-alert'),metadata);});
  const before=(await fs.stat(join(root,'.raw-ingress-reserve'))).size;
  await Promise.all([storage.publishIngress(sha256(metadata),metadata,sha256(payload),payload),
    ...Array.from({length:20},(_,i)=>storage.publishIngressMeta('archive-alerts',sha256(`alert-${i}`),metadata))]);
  await storage.close();const after=(await fs.stat(join(root,'.raw-ingress-reserve'))).size;
  assert.equal(before-after,22*8192+20480);
  assert.deepEqual(await storage.read('objects',sha256(payload)),payload);assert.equal((await storage.list('archive-alerts')).length,21);
});

test('owner cancellation releases durable admission budget and fences queued capture before ACK',async t=>{
  const {root,storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');
  let failed!:()=>void;const firstFailure=new Promise<void>(resolve=>{failed=resolve;});
  const queue=new OriginalAdmission(storage,async(record)=>{if((record as {event_id:string}).event_id==='old'){
    failed();throw Object.assign(new Error('final full'),{code:'ENOSPC'});}return 'committed';});
  const bytes=Buffer.alloc(32*1024*1024,0x5a),old=await queue.admit({event_id:'old'},bytes);await firstFailure;
  await storage.withOriginalWrite(async()=>{await storage.removeOriginals([{namespace:'raw-ingress',key:old.key}]);queue.cancel(record=>(record as {event_id:string}).event_id==='old');});
  await assert.rejects(old.commit,/RAW_INGRESS_CANCELLED/);
  const fresh=await queue.admit({event_id:'fresh'},bytes);assert.equal(await fresh.commit,'committed');await queue.close();
  let locked!:()=>void,release!:()=>void,deleted=false;const entered=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const ownerIntent=storage.withOriginalWrite(async()=>{locked();await gate;deleted=true;});await entered;
  // Reuse the same storage fence, because independent Posix instances do not share process-local locks.
  const shared=new OriginalAdmission(storage,async()=>null,()=>{},async()=>{check(!deleted,'RAW_DELETED',410);});
  const admission=shared.admit({event_id:'queued'},Buffer.from('must not publish'));release();await ownerIntent;
  await assert.rejects(admission,/RAW_DELETED/);assert.deepEqual(await storage.list('raw-ingress'),[]);
  assert.ok(!(await storage.list('objects')).includes(sha256('must not publish')));await shared.close();
});
test('original reference deadlines are file-synced before fresh, deduplicated and batch publication ACK',async t=>{
  const {storage}=await fixture(t),open=fs.open,events:string[]=[];
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);
    if(String(args[0]).includes('/objects/')&&!String(args[0]).includes('/.pending-')){
      const utimes=handle.utimes.bind(handle),sync=handle.sync.bind(handle);
      t.mock.method(handle,'utimes',async(...times:Parameters<typeof handle.utimes>)=>{await utimes(...times);events.push('mtime');});
      t.mock.method(handle,'sync',async()=>{await sync();events.push('synced');});
    }return handle;
  });
  const first=Buffer.from('first reference'),second=Buffer.from('batch reference'),key=sha256(first);
  await storage.publish('objects',key,first);await storage.publish('objects',key,first);
  await storage.publishMany('objects',[{key,bytes:first},{key:sha256(second),bytes:second}]);
  assert.equal(events.filter(event=>event==='mtime').length,4);
  // Batch workers may interleave; every touched winner must still sync before ACK.
  assert.equal(events.filter(event=>event==='synced').length,4);
  assert.deepEqual(events.slice(0,4),['mtime','synced','mtime','synced']);
});
test('recovery skips owner-deleted enumerated ingress without consuming the next capture budget',{timeout:5000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-stream-')),{OriginalAdmission}=await import('../src/original-admission.ts');
  let entered!:()=>void,release!:()=>void,enumerate=true,deleted=false,calls=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  // Exercise recovery's byte budget with real payloads and POSIX metadata/fences, without physical reserve allocation.
  // Physical reserve and fsync are covered by 'producer ingress claims allocated reserve...' and 'original reference deadlines...'.
  class Loading extends PosixStorage {
    private objects=new Map<string,Uint8Array>();
    override async list(namespace:string,max_keys?:number){
      const keys=await super.list(namespace,max_keys);if(namespace==='raw-ingress'&&enumerate){enumerate=false;entered();await gate;}return keys;}
    override async read(namespace:string,key:string){
      if(namespace!=='objects')return super.read(namespace,key);
      const bytes=this.objects.get(key);assert.ok(bytes,'fixture object must exist');return bytes;}
    override async publishIngress(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array,beforeWrite?:()=>Promise<void>){
      await this.withOriginalWrite(async()=>{await beforeWrite?.();this.objects.set(hash,payload);await this.publish('raw-ingress',key,metadata);});}
    override async removeIngress(key:string){await this.withOriginalWrite(()=>this.removeOriginals([{namespace:'raw-ingress',key}]));}
  }
  const storage=new Loading(root),payload=Buffer.alloc(32*1024*1024,0x4b),hash=sha256(payload),keys:string[]=[];
  const queue=new OriginalAdmission(storage,async()=>{calls++;return 'committed';},()=>{},async(record)=>{
    check(!deleted||(record as {event_id:string}).event_id==='fresh','RAW_DELETED',410);
  });
  t.after(async()=>{release();await queue.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  for(const event_id of ['removed','tombstoned']){
    const descriptor=Buffer.from(JSON.stringify({schema:'paios.raw-ingress.v1',record:{event_id},object_hash:hash,bytes:payload.length}));
    const key=sha256(descriptor);keys.push(key);await storage.publishIngress(key,descriptor,hash,payload);
  }
  const recovering=queue.recover();await started;
  await storage.withOriginalWrite(async()=>{deleted=true;queue.cancel(()=>true);await storage.removeOriginals([{namespace:'raw-ingress',key:keys[0]!}]);});
  release();await recovering;assert.equal(calls,0);
  const fresh=await queue.admit({event_id:'fresh'},payload);assert.equal(await fresh.commit,'committed');
  assert.equal(calls,1);assert.deepEqual(await storage.list('raw-ingress'),[keys[1]!]);
});
test('admission close joins in-flight final publication before releasing its storage lifetime',async t=>{
  const {storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const queue=new OriginalAdmission(storage,async()=>{entered();await gate;await storage.publish('final-manifests',sha256('joined'),Buffer.from('joined'));return 'joined';});
  const ack=await queue.admit({event_id:'joining'},Buffer.from('original'));await started;
  let closed=false;const closing=queue.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release();await closing;assert.equal(await ack.commit,'joined');assert.deepEqual(await storage.list('raw-ingress'),[]);
  assert.deepEqual(await storage.read('final-manifests',sha256('joined')),Buffer.from('joined'));
});
test('same physical reserve replenishes after recovery and supports a second pressure episode',async t=>{
  const {root,storage}=await fixture(t);await storage.prepareCapture();
  const pressure=new PosixStorage(root,{min_free_bytes:Number.MAX_SAFE_INTEGER,onAlert:()=>{}}),metadata=Buffer.alloc(32,0x01);
  await pressure.publishIngress(sha256('first-pending'),metadata,sha256('first'),Buffer.from('first'));
  const pool=join(root,'.raw-ingress-reserve'),first=(await fs.stat(pool)).size;assert.ok(first<64*1024*1024);
  await storage.removeIngress(sha256('first-pending'));assert.equal((await fs.stat(pool)).size,64*1024*1024);
  await pressure.publishIngress(sha256('second-pending'),metadata,sha256('second'),Buffer.from('second'));
  assert.ok((await fs.stat(pool)).size<64*1024*1024);
  await new PosixStorage(root).prepareCapture();const restored=await fs.stat(pool);
  assert.equal(restored.size,64*1024*1024);assert.ok(restored.blocks*512>=restored.size);
  assert.deepEqual(await pressure.read('objects',sha256('first')),Buffer.from('first'));
  assert.deepEqual(await pressure.read('objects',sha256('second')),Buffer.from('second'));
});
test('admission close joins startup recovery before any recovered job can publish',async t=>{
  const {root,storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');
  const payload=Buffer.from('startup pending'),descriptor=Buffer.from(JSON.stringify({schema:'paios.raw-ingress.v1',record:{event_id:'startup'},object_hash:sha256(payload),bytes:payload.length}));
  await storage.publishIngress(sha256(descriptor),descriptor,sha256(payload),payload);
  let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  class Loading extends PosixStorage {override async list(namespace:string,max_keys?:number){if(namespace==='raw-ingress'){entered();await gate;}return super.list(namespace,max_keys);}}
  const queue=new OriginalAdmission(new Loading(root),async()=>{calls++;});const recovery=queue.recover();await started;
  let closed=false;const closing=queue.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release();await recovery;await closing;assert.equal(calls,0);assert.deepEqual(await storage.list('raw-ingress'),[sha256(descriptor)]);
});
test('a targeted publication EIO retains its original while a healthy terminal commits and recovery later succeeds',{timeout:5000},async t=>{
  const {storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');let unavailable=true,failures=0,twice!:()=>void;
  const retried=new Promise<void>(resolve=>{twice=resolve;}),notices:Promise<Uint8Array>[]=[];
  const queue=new OriginalAdmission(storage,async(record,payload)=>{
    if((record as {terminal:string}).terminal==='unavailable'&&unavailable){failures++;if(failures===2)twice();throw Object.assign(new Error('terminal-specific EIO'),{code:'EIO'});}
    return sha256(payload);
  },error=>{notices.push(storage.publishIngressMeta('archive-alerts',sha256(`notice-${notices.length}`),Buffer.from(String(error))));});t.after(()=>queue.close());
  const broken=await queue.admit({terminal:'unavailable'},Buffer.from('held-original'));
  const healthy=await queue.admit({terminal:'healthy'},Buffer.from('healthy-original'));
  assert.equal(await healthy.commit,sha256('healthy-original'));await retried;await Promise.all(notices);assert.ok(failures>=2);
  assert.equal(notices.length,1);assert.equal((await storage.list('archive-alerts')).length,1);
  assert.deepEqual(await storage.list('raw-ingress'),[broken.key]);assert.deepEqual(await storage.read('objects',sha256('held-original')),Buffer.from('held-original'));
  unavailable=false;assert.equal(await broken.commit,sha256('held-original'));assert.deepEqual(await storage.list('raw-ingress'),[]);
});
test('full admission budget holds already-played reply input without ACK until healthy publication frees space',{timeout:5000},async t=>{
  const {MemoryStorage}=await import('./memory-storage-fixture.ts'),{timeoutClock}=await import('./timeout-clock-fixture.ts');
  const storage=new MemoryStorage(),{OriginalAdmission}=await import('../src/original-admission.ts');let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const queue=new OriginalAdmission(storage,async(record,payload)=>{if((record as {kind:string}).kind==='existing'){entered();await gate;}return sha256(payload);});
  t.after(()=>release());t.after(()=>queue.close());
  const existing=await queue.admit({kind:'existing'},Buffer.alloc(60*1024*1024,0x5b));await started;
  const clock=timeoutClock(t);
  const played=Buffer.alloc(5*1024*1024,0x71),snapshot=Uint8Array.from(played),hash=sha256(snapshot);let acked=false;
  const waiting=queue.admit({kind:'played-reply'},snapshot).then(ack=>{acked=true;return ack;});played.fill(0xee);
  await clock.scheduled(1000);assert.equal(acked,false);release();await existing.commit;
  const ack=await waiting;assert.equal(await ack.commit,hash);assert.equal(sha256(await storage.read('objects',hash)),hash);await queue.close();
});
test('close rejects a capacity waiter while joining its admitted in-flight predecessor',async t=>{
  const {storage}=await fixture(t),{OriginalAdmission}=await import('../src/original-admission.ts');let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const queue=new OriginalAdmission(storage,async()=>{entered();await gate;return 'published';});
  const predecessor=await queue.admit({kind:'existing'},Buffer.alloc(60*1024*1024,0x23));await started;
  const waiting=queue.admit({kind:'played-reply'},Buffer.alloc(5*1024*1024,0x24)),rejection=assert.rejects(waiting,/RAW_INGRESS_CLOSED_BEFORE_ACK/);
  const closing=queue.close();release();await closing;await rejection;assert.equal(await predecessor.commit,'published');
});
test('capture preparation creates the fixed ingress namespaces before SDK attachment',async t=>{
  const {root,storage}=await fixture(t);await storage.prepareCapture();
  for(const namespace of ['objects','raw-ingress','source-clock-bases','archive-alerts','archive-alert-deliveries'])assert.ok((await fs.stat(join(root,namespace))).isDirectory());
});
test('actual producer ENOSPC runs verified reserve policy even when byte free-space checks are sufficient',async t=>{
  const {storage}=await fixture(t);await storage.prepareCapture();let calls=0;const failure=Object.assign(new Error('inode exhausted'),{code:'ENOSPC'});
  const alerts:unknown[]=[];storage.setAlert(error=>alerts.push(error));storage.setReservePolicy(async()=>{calls++;});
  const open=fs.open;t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{if(String(args[0]).includes('/objects/.pending-'))throw failure;return open(...args);});
  for(let i=0;i<2;i++)await assert.rejects(storage.publishIngress(sha256(`inode-${i}`),Buffer.from('meta'),sha256(`input-${i}`),Buffer.from(`input-${i}`)),e=>e===failure);
  assert.equal(calls,2);assert.equal(alerts.length,1);
});


test('emergency eviction uses pending write bytes and stops once reserve fits, preserving young copies',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-exact-deficit-')),remote=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:remote.config,min_free_bytes:1024}),archive=new RawArchive(storage,65536);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const objects=['young original one with more than thirty-seven bytes','young original two with more than thirty-seven bytes']
    .map(text=>({namespace:'objects',key:sha256(text),bytes:Buffer.from(text)}));
  const manifests=objects.map(r=>{const bytes=Buffer.from(JSON.stringify({schema_version:'paios.archive.v1',
    event:{received_at:new Date().toISOString()},payload_sha256:r.key,bytes:r.bytes.length}));
    return {namespace:'manifests',key:sha256(bytes),bytes};});
  const records=[...objects,...manifests];
  for(const r of records)await storage.publish(r.namespace,r.key,r.bytes);
  await storage.moveCold(records);
  const pending=Buffer.alloc(37,0x33),stat=await fs.statfs(storage.root);let available=1024,removed=0;
  t.mock.method(fs,'statfs',async()=>({...stat,bsize:1,bavail:available}));
  const remove=storage.removeOriginals.bind(storage);t.mock.method(storage,'removeOriginals',async(rows:Parameters<PosixStorage['removeOriginals']>[0])=>{
    await remove(rows);removed+=rows.length;
    for(const row of rows)available+=records.find(r=>r.namespace===row.namespace&&r.key===row.key)!.bytes.length;
  });
  await storage.publish('objects',sha256(pending),pending);
  assert.equal(removed,1);assert.equal((await storage.listHot('objects')).length+(await storage.listHot('manifests')).length,4);
  assert.deepEqual(await storage.readHot('objects',sha256(pending)),pending);let hot=0;
  for(const r of records)try{assert.deepEqual(await storage.readHot(r.namespace,r.key),r.bytes);hot++;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  assert.equal(hot,3,'all other objects and manifests younger than 48 hours stay hot');
});

test('HTTP cold packing has no unrelated per-record payload reserve',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-pack-reserve-')),remote=await webdav(t,root),storage=new PosixStorage(join(root,'hot'),{cold:remote.config,min_free_bytes:Number.MAX_SAFE_INTEGER});
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const records=Array.from({length:2048},(_,i)=>({namespace:'proofs',key:sha256(`tiny-${i}`),bytes:Buffer.from('x')}));
  const receipt=await storage.moveCold(records);assert.ok(receipt.bytes>0);assert.equal((await storage.cold!.locations()).length,2048);
});

test('the journal cache is bounded in entries, least recently used lanes leave first and re-verify on a later read',async t=>{
  const {storage}=await fixture(t),small={...budget,max_chunks:4,max_revisions:4};
  const archive=new StreamArchive(storage,small),cached=()=>[...((archive as unknown as {journals:Map<string,{entries:unknown[]}>}).journals).values()].reduce((n,l)=>n+l.entries.length,0);
  const lane=(id:string):RawEvent=>({...raw(),event_id:id}),refs:string[]=[];
  for(let l=0;l<6;l++)for(let seq=0;seq<4;seq++){const r=await archive.append(lane(`lane-${l}`),trusted,at,chunk(seq));if(seq===0)refs.push(r.event.raw_ref);}
  assert.equal(cached(),16,'four full lanes stay verified; older lanes are dropped');
  const lanes=(archive as unknown as {journals:Map<string,unknown>}).journals;assert.deepEqual([...lanes.keys()],refs.slice(2));
  assert.equal((await archive.head(refs[0]!))!.revision,4,'an evicted lane is re-read from storage and re-verified');
  assert.deepEqual([...lanes.keys()],[...refs.slice(3),refs[0]]);assert.equal(cached(),16);
});


test('an already-cold object reused by a live session survives normal and emergency hot eviction',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-live-cold-reuse-')),remote=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:remote.config,min_free_bytes:100,min_free_inodes:10}),archive=new RawArchive(storage,65536,()=>at,budget);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  archive.setAlert(async()=>{});
  const payload=Buffer.alloc(200,1),key=sha256(payload);
  await archive.archive({...raw(payload),event_id:'finite-original',media_type:'file',mime:'application/octet-stream',representation:'uploaded_original'},trusted);
  await archive.moveCold();assert.equal(await storage.cold!.contains('objects',key),true);
  const live=await archive.streams.append({...raw(payload),event_id:'live-reuse'},trusted,at,chunk(0));
  assert.equal(await storage.hasLiveSessionOwner({namespace:'objects',key}),true);
  const old=new Date(Date.now()-72*3600000);await fs.utimes(join(storage.root,'objects',key),old,old);
  await archive.moveCold(2,Date.now()+72*3600000);
  assert.deepEqual(Buffer.from(await storage.readHot('objects',key)),payload,'normal eviction preserves the active source');
  const stat=await fs.statfs(storage.root);
  t.mock.method(fs,'statfs',async()=>({...stat,bsize:1,bavail:99,ffree:9}));
  assert.equal(await storage.monitorReserve(),false,'pressure remains explicit when live originals cannot be evicted');
  assert.deepEqual(Buffer.from(await storage.readHot('objects',key)),payload,'emergency eviction preserves the active source');
  assert.deepEqual(Buffer.from((await archive.readExactChunk(live.event,chunk(0),payload.length)).bytes),payload);
});

test('maintenance head checkpoints do not own the live append queue or mutate its cached journal',async t=>{
  const {archive}=await fixture(t),first=await archive.append(raw(),trusted,at,chunk(0));
  const entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();let paused=false;
  const maintenance=archive.head(first.event.raw_ref,{checkpoint:async()=>{if(!paused){paused=true;entered.resolve();await resume.promise;}}});
  await entered.promise;
  try {
    const second=await archive.append(raw(),trusted,at,chunk(1));
    assert.equal((await archive.head(second.event.raw_ref))!.revision,2);
  } finally {resume.resolve();}
  assert.equal((await maintenance)!.revision,2);
  await assert.rejects(archive.head(first.event.raw_ref,{checkpoint:async()=>{throw new Error('IDLE_BUDGET_EXHAUSTED');}}),/IDLE_BUDGET_EXHAUSTED/);
  assert.equal((await archive.head(first.event.raw_ref))!.revision,2);
});
