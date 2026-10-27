import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {canonical,EVENT_SCHEMA,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import type {TrackChunk} from '../src/stream-archive.ts';
import {webdav} from './stream-materialized-fixture.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'consent',channel:'livekit',submission:'observation'};
const budget={max_chunk_bytes:3200,max_total_bytes:100000,max_chunks:64,max_revisions:64,max_seq:100};
const raw=(value:number,event_id:string):RawEvent=>({schema_version:EVENT_SCHEMA,event_id,device_id:'glasses',device_type:'glasses',captured_at:at,
  source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,value)});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}});
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'session-shared-hot-')),remote=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:remote.config}),archive=new RawArchive(storage,100000,()=>at,budget);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});return {root,remote,storage,archive};}
async function closed(f:Awaited<ReturnType<typeof fixture>>){
  const saved=[];for(let seq=0;seq<3;seq++)saved.push(await f.archive.streams.append(raw(seq+1,'closed'),trusted,at,chunk(seq)));return saved;
}
test('pre-ledger journal names remain hot through their live original-object ownership',async t=>{
  const f=await fixture(t),track=f.storage.trackSessionRecords.bind(f.storage);
  f.storage.trackSessionRecords=(ref,records)=>track(ref,records.filter(r=>r.namespace==='objects'));
  const live=await f.archive.streams.append(raw(1,'pre-ledger-live'),trusted,at,chunk(0));
  assert.equal((await f.archive.moveCold(1,Date.now()+5*86400000)).segments,0);
  assert.deepEqual(await f.storage.cold!.keys('stream-revisions'),[]);
  assert.deepEqual(Buffer.from((await f.archive.readExactChunk(live.event,chunk(0),3200)).bytes),Buffer.from(raw(1,'').payload));
});
test('final cleanup preserves hot hashes owned by a live stream or pending raw ingress across cold eviction and restart',async t=>{
  const f=await fixture(t),saved=await closed(f),live=await f.archive.streams.append(raw(1,'live'),trusted,at,chunk(0));
  const {payload,...metadata}=raw(2,'pending'),input={schema:'paios.raw-ingress.v1',record:{kind:'stream',raw:metadata,trusted,chunk:chunk(0),received_at:at},object_hash:sha256(payload),bytes:payload.length};
  const encoded=Buffer.from(canonical(input));await f.storage.publish('raw-ingress',sha256(encoded),encoded);
  const final=await f.archive.finalizeSession(saved[2]!.event.raw_ref);assert.ok(final);assert.ok(final.records.every(record=>record.namespace!=='objects'));
  for(const value of [1,2])assert.deepEqual(Buffer.from(await f.storage.readHot('objects',sha256(raw(value,'').payload))),Buffer.from(raw(value,'').payload));
  await assert.rejects(f.storage.readHot('objects',saved[2]!.chunk.object_hash),{code:'ENOENT'});
  await f.archive.moveCold(2,Date.now()+5*86400000);await assert.rejects(f.storage.readHot('objects',final.object_hash),{code:'ENOENT'});
  f.remote.state.unavailable=true;
  assert.deepEqual(Buffer.from((await f.archive.readExactChunk(live.event,chunk(0),3200)).bytes),Buffer.from(raw(1,'live').payload));
  await f.archive.close();await f.storage.close();const reopened=new PosixStorage(join(f.root,'hot'),{cold:f.remote.config});t.after(()=>reopened.close());
  assert.equal(await reopened.hasLiveSessionOwner({namespace:'objects',key:live.chunk.object_hash}),true);
  assert.deepEqual(Buffer.from(await reopened.readHot('objects',live.chunk.object_hash)),Buffer.from(raw(1,'live').payload));
  assert.deepEqual(Buffer.from(await reopened.readHot('objects',input.object_hash)),Buffer.from(payload));
  await reopened.close();
});
test('new single and batch raw reuse materializes hot bytes; admitted replay of an ended source retires its temporary raw copy',async t=>{
  const f=await fixture(t),saved=await closed(f),final=await f.archive.finalizeSession(saved[2]!.event.raw_ref);assert.ok(final);
  await f.archive.moveCold(2,Date.now()+5*86400000);await assert.rejects(f.storage.readHot('objects',final.object_hash),{code:'ENOENT'});
  f.remote.state.unavailable=true;
  const single=await f.archive.streams.append(raw(1,'new-single'),trusted,at,chunk(0));
  const batch=await f.archive.streams.appendBatch([{event:raw(2,'new-batch'),trusted,received_at:at,chunk:chunk(0)},
    {event:raw(4,'new-batch'),trusted,received_at:at,chunk:chunk(1)}],{max_chunks:2,max_bytes:6400});
  for(const [result,value] of [[single,1],[batch[0]!,2],[batch[1]!,4]] as const){const {event,chunk:stored}=result;
    assert.deepEqual(Buffer.from(await f.storage.readHot('objects',stored.object_hash)),Buffer.from(raw(value,'').payload));
    assert.ok((await f.storage.sessionRecords(event.raw_ref)).some(record=>record.namespace==='objects'&&record.key===stored.object_hash));
  }
  f.remote.state.unavailable=false;
  const admitted=await f.archive.admitStream(raw(3,'closed'),trusted,chunk(2));assert.deepEqual(await admitted.commit,saved[2]);
  await f.archive.maintenance(1,Date.parse(at)+1000);
  await assert.rejects(f.storage.readHot('objects',saved[2]!.chunk.object_hash),{code:'ENOENT'});
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);
  assert.deepEqual(Buffer.from(await f.storage.readHot('objects',single.chunk.object_hash)),Buffer.from(raw(1,'new-single').payload));
});
test('a finalized singleton shared by an open source becomes cold-eligible only after that source ends',async t=>{
  const f=await fixture(t),first=await f.archive.streams.append(raw(1,'first-singleton'),trusted,at,chunk(0));
  const final=await f.archive.finalizeSession(first.event.raw_ref);assert.ok(final);assert.equal(final.object_hash,first.chunk.object_hash);
  const live=await f.archive.streams.append(raw(1,'live-singleton'),trusted,at,chunk(0));
  assert.equal((await f.archive.moveCold(2,Date.now()+5*86400000)).segments,0);
  assert.equal(await f.storage.cold!.contains('objects',final.object_hash),false);
  assert.deepEqual(Buffer.from(await f.storage.readHot('objects',final.object_hash)),Buffer.from(raw(1,'').payload));
  await f.archive.finalizeSession(live.event.raw_ref);
  assert.ok((await f.archive.moveCold(2,Date.now()+5*86400000)).segments>0);
  assert.equal(await f.storage.cold!.contains('objects',final.object_hash),true);
});
for(const cold of [false,true])test(`deleting another original preserves a folded session's combined payload and retained video (${cold?'cold':'hot'})`,async t=>{
  const f=await fixture(t),saved=[],video=Buffer.from([12,24,36,48]);
  for(let seq=0;seq<3;seq++)saved.push(await f.archive.streams.append({...raw(seq+1,'closed'),media_type:'livekit_tracks'},trusted,at,chunk(seq)));
  const camera:TrackChunk={track_id:'camera',stream_epoch:'camera',seq:0,modality:'visual',format:'livekit_decoded:0:2:2:rotation:0',
    source_range:{kind:'instant',timebase_id:'camera',stream_epoch:'camera',at_ms:50}};
  await f.archive.streams.append({...raw(0,'closed'),media_type:'livekit_tracks',mime:'application/x-livekit-video-buffer',payload:video},trusted,at,camera);
  const final=await f.archive.finalizeSession(saved[2]!.event.raw_ref);assert.ok(final);
  const combined=Buffer.concat([1,2,3].map(value=>Buffer.from(raw(value,'').payload))),others=[];
  for(const [n,payload] of [combined,video].entries())others.push(await f.archive.archive({...raw(n,`other-${n}`),media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload},trusted));
  if(cold)await f.archive.moveCold(2,Date.now()+5*86400000);
  for(const other of others)await f.archive.delete(other.raw_ref,'owner');
  assert.deepEqual(Buffer.from(await f.storage.read('objects',final.object_hash)),combined);
  assert.deepEqual(Buffer.from(await f.storage.read('objects',sha256(video))),video);
  for(const receipt of saved)assert.deepEqual(Buffer.from((await f.archive.readExactChunk(receipt.event,chunk(receipt.chunk.seq),3200)).bytes),Buffer.from(raw(receipt.chunk.seq+1,'').payload));
});
