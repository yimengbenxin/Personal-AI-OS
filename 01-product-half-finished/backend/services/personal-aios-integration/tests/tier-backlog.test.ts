import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawArchive,TIER_NAMESPACES} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {sha256} from '../src/contracts.ts';
import {webdav} from './stream-materialized-fixture.ts';

async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'tier-backlog-')),dav=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config}),archive=new RawArchive(storage,1024*1024),notices:string[]=[];
  archive.setSessionFolding(false);archive.setAlert(async reason=>{notices.push(reason);});
  t.mock.method(console,'info',()=>{});
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const put=async(namespace:string,text:string,at:number)=>{
    const bytes=Buffer.from(text),key=sha256(bytes);await storage.publish(namespace,key,bytes);
    await fs.utimes(join(storage.root,namespace,key),new Date(at),new Date(at));return {namespace,key,bytes};
  };
  return {storage,archive,dav,notices,put};
}

test('backlog counts physical bytes and oldest hot name, including unresolved leaves and live-owned records',async t=>{
  const f=await fixture(t),now=Date.now(),old=now-3*86400000;
  const a=await f.put('media-source-progress','fictional progress',old),b=await f.put('audio-consumer-results','fictional result',old+1000);
  const live=await f.put('objects','live original',old+2000),fresh=await f.put('media-views','recent view',now);
  await f.storage.trackSessionRecords(`l5:${sha256('active session')}`,[live]);
  const mutable=await f.put('care','local mutable registry',old-1000);
  f.dav.state.corrupt=true;await assert.rejects(f.archive.maintenance(1,now),/COLD_COPY_INTEGRITY/);
  const backlog=f.archive.packingSnapshot().tiering.backlog;
  assert.equal(backlog.complete,true);assert.equal(backlog.hot_records,4);
  assert.equal(backlog.hot_bytes,a.bytes.length+b.bytes.length+live.bytes.length+fresh.bytes.length);
  assert.equal(backlog.old_records,3);assert.equal(backlog.old_bytes,a.bytes.length+b.bytes.length+live.bytes.length);
  assert.deepEqual(backlog.oldest_hot_record,{namespace:a.namespace,key:a.key,modified_at:new Date(old).toISOString()});
  for(const r of [a,b,live,fresh])assert.deepEqual(await f.storage.readHot(r.namespace,r.key),r.bytes);
  assert.deepEqual(await f.storage.cold!.locations(),[],'unverified PUT cannot publish an eviction receipt');
  f.dav.state.corrupt=false;await f.archive.maintenance(1,now);
  for(const r of [a,b]){await assert.rejects(f.storage.readHot(r.namespace,r.key),{code:'ENOENT'});assert.deepEqual(await f.storage.read(r.namespace,r.key),r.bytes);}
  assert.deepEqual(await f.storage.readHot(live.namespace,live.key),live.bytes);
  assert.deepEqual(await f.storage.readHot(mutable.namespace,mutable.key),mutable.bytes);
  assert.ok(f.notices.includes('L5_TIERING_BACKLOG'));
  await f.archive.maintenance(1,now);
  assert.equal(f.archive.packingSnapshot().tiering.backlog.old_records,1,'only the live-owned original remains overdue');
});

test('all immutable archive namespaces can evacuate without a session fold; paused maintenance preserves cold reads',async t=>{
  const f=await fixture(t),old=Date.now()-2*86400000,records=[];
  for(const namespace of TIER_NAMESPACES)records.push(await f.put(namespace,namespace==='stream-revisions'?
    JSON.stringify({schema:'paios.stream.delta.v2',raw_ref:`l5:${sha256('ended fixture')}`,
      chunk:{object_hash:sha256('unowned fictional original'),format:'jpeg',received_at:new Date(old).toISOString()}}):`fictional ${namespace}`,old));
  await f.archive.maintenance(1,Date.now(),{paused:true});
  assert.equal(f.archive.packingSnapshot().tiering.paused,true);assert.deepEqual(await f.storage.cold!.locations(),[]);
  await f.archive.maintenance(1);
  for(const r of records){await assert.rejects(f.storage.readHot(r.namespace,r.key),{code:'ENOENT'});assert.deepEqual(await f.storage.read(r.namespace,r.key),r.bytes);}
  const more=await f.put('objects','another original',old);await f.archive.maintenance(1,Date.now(),{paused:true});
  assert.deepEqual(await f.storage.read('objects',records[0]!.key),records[0]!.bytes);
  assert.deepEqual(await f.storage.readHot(more.namespace,more.key),more.bytes);
  assert.equal(await f.storage.cold!.contains(more.namespace,more.key),false);
});

test('cold-only history does not delay eviction of a current overdue hot record',async t=>{
  const f=await fixture(t),old=Date.now()-2*86400000;
  for(let n=0;n<25;n++){const r=await f.put('objects',`historical original ${n}`,old);await f.storage.moveCold([r]);}
  const packs=await f.storage.cold!.packs(true),last=(await f.storage.cold!.locations(undefined,packs.at(-1)!.key))[0]!;
  for(const pack of packs.slice(0,-1))await f.storage.removeOriginals(await f.storage.cold!.locations(undefined,pack.key));
  const reads=f.dav.state.reads;
  await f.archive.maintenance(1,Date.now(),{budget_ms:5000});
  await assert.rejects(f.storage.readHot('objects',last.key),{code:'ENOENT'});
  assert.equal(f.dav.state.reads-reads,1,'only the pack owning the hot record needs remote verification');
  assert.equal(await f.storage.cold!.contains('objects',last.key),true);
});

test('emergency reclaim continues past a pending pack whose original is still live',async t=>{
  const f=await fixture(t),now=Date.now(),old=await f.put('objects','previously verified original',now);
  await f.storage.moveCold([old]);
  const live=await f.put('objects','live source',now);let busy=false;
  const move=f.storage.moveCold.bind(f.storage);
  t.mock.method(f.storage,'moveCold',async(...args:Parameters<PosixStorage['moveCold']>)=>{
    const receipt=await move(...args);busy=true;return receipt;
  });
  await f.archive.maintenance(1,now,{busy:()=>busy});
  await f.storage.trackSessionRecords(`l5:${sha256('still active')}`,[live]);
  await fs.utimes(join(f.storage.root,'objects',old.key),new Date(now-2*86400000),new Date(now-2*86400000));
  const stat=await fs.statfs(f.storage.root);let available=f.storage.reserveBytes-1;
  t.mock.method(fs,'statfs',async()=>({...stat,bsize:1,bavail:available}));
  const remove=f.storage.removeOriginals.bind(f.storage);
  t.mock.method(f.storage,'removeOriginals',async(records:Parameters<PosixStorage['removeOriginals']>[0])=>{await remove(records);if(records.some(r=>r.key===old.key))available+=old.bytes.length;});
  assert.equal(await f.storage.monitorReserve(),true);
  await assert.rejects(f.storage.readHot('objects',old.key),{code:'ENOENT'});
  assert.deepEqual(await f.storage.readHot('objects',live.key),live.bytes);
});
