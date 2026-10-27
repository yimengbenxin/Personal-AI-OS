import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {getLoadablePath} from 'sqlite-vec';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VisualEmbeddingSpaces,readEmbeddingSpace,type EmbeddingProvider} from '../src/visual/embedding-spaces.ts';
import {VisualMemory} from '../src/visual/store.ts';
const provider=(id:string,dimensions=1024):EmbeddingProvider=>({embeddingSpace:{id,dimensions},
  embedImage:async()=>Array.from({length:dimensions},(_,i)=>Number(i===0)),
  embedQuery:async()=>Array.from({length:dimensions},(_,i)=>Number(i===0))});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
function database(){
  const db=new DatabaseSync(':memory:',{allowExtension:true});db.loadExtension(getLoadablePath());db.enableLoadExtension(false);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE frames(id INTEGER PRIMARY KEY,frame_key TEXT,principal_id TEXT,captured_ms INTEGER,state TEXT);
    CREATE VIRTUAL TABLE vectors USING vec0(embedding float[1024] distance_metric=cosine,principal_id text partition key,captured_ms integer)`);
  return db;
}
function frame(db:DatabaseSync,id:number){
  db.prepare("INSERT INTO frames VALUES(?,?,?,?,'ready')").run(id,`frame:${id}`,'owner',id);
  db.prepare('INSERT INTO vectors(rowid,embedding,principal_id,captured_ms) VALUES(?,?,?,?)').run(BigInt(id),new Float32Array([1,...Array(1023).fill(0)]),'owner',BigInt(id));
}
const bytes=async()=>Buffer.from('synthetic thumbnail');

test('native generation builds beside active vectors, verifies, activates idempotently, and rebuilds prior space',async()=>{
  const db=database();try {
    frame(db,1);const old=provider('fixture:old'),next=provider('fixture:new',3),spaces=new VisualEmbeddingSpaces(db,old);
    const gate=deferred(),started=deferred(),building=spaces.prepare({...next,embedImage:async()=>{started.resolve();await gate.promise;return [1,0,0];}},bytes);
    await started.promise;assert.equal(spaces.snapshot().provider,old);assert.equal(spaces.info().active.generation,'vectors');
    await assert.rejects(spaces.prepare(next,bytes),/VISUAL_EMBEDDING_BUILD_BUSY/u);gate.resolve();
    const candidate=await building;spaces.activate(candidate);spaces.activate(candidate);
    assert.equal(spaces.info().active.space.id,'fixture:new');assert.equal(spaces.info().previous!.space.id,'fixture:old');
    frame(db,2);
    const reverted=await spaces.preparePrevious(old,bytes);spaces.activate(reverted);
    assert.equal(spaces.info().active.space.id,'fixture:old');
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${reverted.generation}`).get()!.n),2);
    spaces.deleteRow(1);assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${candidate.generation}`).get()!.n),0);
  }finally{db.close();}
});

test('failed vectors and source mutations never activate a partial or stale generation',async()=>{
  const db=database();try {
    frame(db,1);const spaces=new VisualEmbeddingSpaces(db,provider('fixture:old'));
    for(const vector of [[1,0],[NaN,0,0],[0,0,0],[Number.MAX_VALUE,0,0]]){
      await assert.rejects(spaces.prepare({...provider('fixture:new',3),embedImage:async()=>vector},bytes),/VISUAL_EMBEDDING_VECTOR_INVALID/u);
      assert.equal(spaces.info().active.generation,'vectors');
    }
    await assert.rejects(spaces.prepare({...provider('fixture:new',3),embedImage:async()=>{throw new Error('fixture inference failed');}},bytes),/fixture inference failed/u);
    const gate=deferred(),started=deferred(),build=spaces.prepare({...provider('fixture:new',3),embedImage:async()=>{started.resolve();await gate.promise;return [1,0,0];}},bytes);
    await started.promise;frame(db,2);gate.resolve();await assert.rejects(build,/VISUAL_EMBEDDING_SOURCE_CHANGED/u);
    const candidate=await spaces.prepare(provider('fixture:new',3),bytes);frame(db,3);
    assert.throws(()=>spaces.activate(candidate),/VISUAL_EMBEDDING_SOURCE_CHANGED/u);
    assert.equal(spaces.info().active.generation,'vectors');
    assert.throws(()=>spaces.activate({...candidate,space:{id:'wrong pin',dimensions:3}}),/VISUAL_EMBEDDING_CANDIDATE_INVALID/u);
  }finally{db.close();}
});

test('deletion during build invalidates candidate and retained generations lose deleted evidence',async()=>{
  const db=database();try {
    frame(db,1);const spaces=new VisualEmbeddingSpaces(db,provider('fixture:old'));
    const active=await spaces.prepare(provider('fixture:new',3),bytes);spaces.activate(active);
    const started=deferred(),gate=deferred(),pending=spaces.prepare({...provider('fixture:third',4),embedImage:async()=>{started.resolve();await gate.promise;return [1,0,0,0];}},bytes);
    await started.promise;spaces.deleteRow(1);db.prepare('DELETE FROM frames WHERE id=1').run();gate.resolve();
    await assert.rejects(pending,/VISUAL_EMBEDDING_SOURCE_CHANGED/u);
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${active.generation}`).get()!.n),0);
    assert.equal(spaces.info().active.space.id,'fixture:new');
  }finally{db.close();}
});

test('restart checks active pin and discards interrupted native generation without changing active',async()=>{
  const db=database();try {
    frame(db,1);const old=provider('fixture:old'),next=provider('fixture:new',3),spaces=new VisualEmbeddingSpaces(db,old);
    const candidate=await spaces.prepare(next,bytes);spaces.activate(candidate);
    assert.throws(()=>new VisualEmbeddingSpaces(db,old),/VISUAL_EMBEDDING_SPACE_MISMATCH/u);
    const generation='vectors_'+ 'a'.repeat(32);
    db.exec(`CREATE VIRTUAL TABLE ${generation} USING vec0(embedding float[3])`);
    db.prepare('INSERT INTO embedding_generations VALUES(?,?)').run(generation,JSON.stringify({generation,space:next.embeddingSpace,state:'building',sources:'[]'}));
    const reopened=new VisualEmbeddingSpaces(db,next);
    assert.equal(reopened.info().active.generation,candidate.generation);
    reopened.activate(candidate);
    assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(generation),undefined);
    const fresh=database();try{assert.throws(()=>new VisualEmbeddingSpaces(fresh,provider('wrong initial width',3)),/VISUAL_LEGACY_EMBEDDING_DIMENSIONS/u);}finally{fresh.close();}
  }finally{db.close();}
});

test('VisualMemory read retains provider and native table across embedding await; restart demands active pin',async t=>{
  const root=await mkdtemp(join(tmpdir(),'embedding-snapshot-'));
  const entered=deferred(),gate=deferred(),old={...provider('fixture:old'),embedQuery:async()=>{entered.resolve();await gate.promise;return [1,...Array(1023).fill(0)]}},next=provider('fixture:new',3);
  const describe=async()=>({caption:'',ocr:''});let store=await VisualMemory.open(root,{...old,describe});
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  const pending=store.recall('owner',{query:'synthetic'});await entered.promise;
  const candidate=await store.prepareEmbeddingSpace(next);await store.activateEmbeddingSpace(candidate);gate.resolve();
  assert.deepEqual((await pending).frames,[]);
  assert.deepEqual((await store.recall('owner',{query:'synthetic'})).frames,[]);
  await store.close();
  assert.deepEqual(readEmbeddingSpace(root),next.embeddingSpace);
  await assert.rejects(VisualMemory.open(root,{...old,describe}),/VISUAL_EMBEDDING_SPACE_MISMATCH/u);
  await assert.rejects(VisualMemory.open(root,{embedImage:old.embedImage,embedQuery:old.embedQuery,describe}),/VISUAL_EMBEDDING_SPACE_REQUIRED/u);
  store=await VisualMemory.open(root,{...next,describe});
  assert.equal(store.embeddingSpaceInfo()!.active.space.id,next.embeddingSpace.id);
});


test('generation cleanup retains active, previous, and leased reads, then removes obsolete native tables',async()=>{
  const db=database();try {
    const spaces=new VisualEmbeddingSpaces(db,provider('fixture:initial')),lease=spaces.snapshot();
    const second=await spaces.prepare(provider('fixture:second',3),bytes);spaces.activate(second);
    const third=await spaces.prepare(provider('fixture:third',4),bytes);spaces.activate(third);
    const table=(name:string)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    assert.ok(table('vectors'),'suspended initial read still owns its table');
    assert.ok(table(second.generation),'previous verified generation stays available');
    lease.release();assert.equal(table('vectors'),undefined);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM embedding_generations').get()!.n),2);
    const fourth=await spaces.prepare(provider('fixture:fourth',5),bytes);spaces.activate(fourth);
    assert.equal(table(second.generation),undefined);assert.ok(table(third.generation));assert.ok(table(fourth.generation));
  }finally{db.close();}
});

test('provider ownership closes shared generations once, leaves failed preparation caller-owned, and surfaces close errors',async()=>{
  const db=database();try {
    let closes=0;const shared={...provider('fixture:shared'),close:async()=>{closes++;}};
    const spaces=new VisualEmbeddingSpaces(db,shared);
    const candidate=await spaces.prepare(shared,bytes);spaces.activate(candidate);
    let failedClosed=0;
    frame(db,1);
    await assert.rejects(spaces.prepare({...provider('fixture:failed',3),embedImage:async()=>{throw new Error('fixture prepare failure');},close:async()=>{failedClosed++;}},bytes),/fixture prepare failure/u);
    await spaces.close();await spaces.close();assert.equal(closes,1);assert.equal(failedClosed,0);
  }finally{db.close();}
  const broken=database();try {
    const spaces=new VisualEmbeddingSpaces(broken,{...provider('fixture:broken'),close:async()=>{throw new Error('fixture close failure');}});
    await assert.rejects(spaces.close(),/VISUAL_EMBEDDING_PROVIDER_CLOSE_FAILED/u);
  }finally{broken.close();}
});
