import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Timeline} from '../src/timeline.ts';
import {PosixStorage} from '../src/storage.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RawArchive} from '../src/archive.ts';
import {MAC_CAPABILITIES,type RegisteredDevice} from '../src/source-authority.ts';
import {digest,type ProcessedEvent} from '../src/contracts.ts';

async function fixture(t:test.TestContext,queue:Record<string,number>={}){
  const root=await mkdtemp(join(tmpdir(),'queue-retention-')),directory=join(root,'timeline'),storage=new PosixStorage(root);
  let now=Date.now();const options={directory,now:()=>now,replay_window_ms:1000,queue:{terminal_ttl_ms:2000,max_terminal:3,max_terminal_bytes:10000,...queue}};
  const store=new Timeline(options,storage,async()=>{},{readOnly:async()=>undefined});
  const stores=[store];
  t.after(async()=>{for(const current of stores)await current.close();await storage.close();await rm(root,{recursive:true,force:true});});
  const read=()=>{const db=new DatabaseSync(join(directory,'timeline.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM desktop_queue ORDER BY created_at_ms,rowid').all();}finally{db.close();}};
  const identity=(n:number)=>({run_id:'native',session_id:'owner-session',tool_call_id:`call-${n}`,source_at_ms:now});
  const add=(n:number)=>store.queue('owner','origin',{action:'add',task:`private task ${n}`},identity(n)) as {queue_id:string};
  const cancel=(id:string)=>store.queue('owner','origin',{action:'cancel',queue_id:id});
  return {root,directory,storage,store,options,read,identity,add,cancel,track:(current:Timeline)=>{stores.push(current);return current;},closeInitial:async()=>{await store.close();stores.splice(stores.indexOf(store),1);},advance:(ms:number)=>{now+=ms;}};
}

test('terminal queue TTL removes rows; replay keys and the source-time rejection boundary survive restart',async t=>{
  const f=await fixture(t),args={action:'add',task:'private task 1'},identity=f.identity(1),row=f.add(1);
  assert.equal(Object.hasOwn(row,'task_digest'),false);assert.equal(Object.hasOwn(row,'terminal_at_ms'),false);
  f.cancel(row.queue_id);assert.ok(!JSON.stringify(f.read()).includes('private task 1'),'terminal plaintext is redacted');
  assert.equal((f.store.queue('owner','origin',args,identity) as {queue_id:string}).queue_id,row.queue_id);
  f.advance(2001);f.store.purge();assert.equal(f.read().length,0);
  await f.closeInitial();
  const reopened=f.track(new Timeline(f.options,f.storage,async()=>{},{readOnly:async()=>undefined}));
  assert.throws(()=>reopened.queue('owner','origin',args,identity),/DESKTOP_QUEUE_REPLAY_EXPIRED/);
  assert.ok(reopened.queue('owner','origin',{action:'add',task:'fresh'},f.identity(2)));
});

for(const quota of [{max_terminal:3,max_terminal_bytes:10000},{max_terminal:20,max_terminal_bytes:180}])test(`terminal count/UTF-8-byte quota retains compact idempotency receipts: ${JSON.stringify(quota)}`,async t=>{
  const f=await fixture(t,quota),first=f.add(0),identity=f.identity(0);f.cancel(first.queue_id);
  for(let n=1;n<12;n++){const row=f.add(n);f.cancel(row.queue_id);}
  const rows=f.read();assert.ok(rows.length<=quota.max_terminal);
  const bytes=rows.reduce((sum,row)=>sum+Buffer.byteLength(String(row.task))+Buffer.byteLength(String(row.task_digest??'')),0);
  assert.ok(bytes<=quota.max_terminal_bytes);assert.ok(!JSON.stringify(rows).includes('private task'));
  if(quota.max_terminal_bytes===180)assert.throws(()=>f.store.queue('owner','origin',{action:'add',task:'界'.repeat(70)},f.identity(100)),/DESKTOP_QUEUE_HISTORY_FULL/);
  const replay=f.store.queue('owner','origin',{action:'add',task:'private task 0'},identity);
  assert.deepEqual(replay,{...first,state:'cancelled'});
  assert.throws(()=>f.store.queue('owner','origin',{action:'add',task:'changed'},identity),/DESKTOP_QUEUE_TOOL_CALL_CONFLICT/);
});

test('queue-source handoff pins plaintext, then compact admitted authorization survives TTL and quota pressure',async t=>{
  const f=await fixture(t,{max_terminal:2}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  await f.closeInitial();
  const source={principal_id:'owner',device_id:'mac',device_type:'mac',capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text']} as RegisteredDevice;
  const ingress=new UnifiedIngress(new RawArchive(f.storage,8192));let d!:ProcessedEvent;
  const store=f.track(new Timeline(f.options,f.storage,async(raw,current,session)=>{
    d=await ingress.accept(raw,{...current,submission:'observation'});await store.input(d,session);
    entered.resolve();await release.promise;
  },{readOnly:async()=>undefined}));
  const queued=store.queue('owner','origin',{action:'add',task:'protected task'},f.identity(1)) as {queue_id:string};
  const ready=store.ready(source,async()=>source);await entered.promise;
  try{
    f.advance(10000);store.purge();assert.equal(f.read()[0]!.task,'protected task');assert.equal(store.queueOrigin(d),'origin');
  }finally{release.resolve();}
  await ready;store.purge();
  assert.equal(f.read()[0]!.task_digest,digest('protected task'));assert.notEqual(f.read()[0]!.task,'protected task');
  assert.equal(store.queueOrigin(d),'origin');assert.equal(store.queueOrigin({...d,content:{...d.content,app_event:{...(d.content.app_event as object),task:'forged'}}}),undefined);
  assert.equal(store.queueOrigin({...d,content:{...d.content,app_event:{...(d.content.app_event as object),task:undefined}}}),undefined);
  f.advance(10000);store.purge();assert.equal(store.queueOrigin(d),'origin','future continuations still resolve their admitted authorization source');
  const second=store.queue('owner','origin',{action:'add',task:'second source'},f.identity(2)) as {queue_id:string};
  await store.ready(source,async()=>source);
  assert.throws(()=>store.queue('owner','origin',{action:'add',task:'over quota'},f.identity(3)),/DESKTOP_QUEUE_HISTORY_FULL/);
  assert.ok(f.read().some(row=>row.queue_id===queued.queue_id));assert.ok(f.read().some(row=>row.queue_id===second.queue_id));
});

test('legacy queue schema upgrades without losing pending plaintext or admitted authorization',async t=>{
  const f=await fixture(t),pending=f.add(1),admitted=f.add(2);await f.closeInitial();
  const db=new DatabaseSync(join(f.directory,'timeline.sqlite'));
  db.prepare("UPDATE desktop_queue SET state='admitted',admitted_device_id='mac' WHERE queue_id=?").run(admitted.queue_id);
  const columns=(db.prepare('PRAGMA table_info(desktop_queue)').all() as {name:string}[]).map(row=>row.name);
  for(const field of ['task_digest','terminal_at_ms'])if(columns.includes(field))db.exec(`ALTER TABLE desktop_queue DROP COLUMN ${field}`);
  db.close();
  const reopened=f.track(new Timeline(f.options,f.storage,async()=>{},{readOnly:async()=>undefined}));
  const rows=f.read();assert.equal(rows.find(row=>row.queue_id===pending.queue_id)!.task,'private task 1');
  assert.equal(rows.find(row=>row.queue_id===admitted.queue_id)!.task_digest,digest('private task 2'));
  const d={principal_id:'owner',device_id:'mac',event_id:admitted.queue_id,content:{app_event:{queue_id:admitted.queue_id,task:'private task 2',origin_processed_event_id:'origin'}}} as ProcessedEvent;
  assert.equal(reopened.queueOrigin(d),'origin');
});
