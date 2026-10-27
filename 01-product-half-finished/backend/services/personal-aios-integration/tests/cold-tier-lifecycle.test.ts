import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {sha256,type ArchivedEvent,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {webdav} from './stream-materialized-fixture.ts';

const hour=3600000;
const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'upload',consent_ref:'fixture',submission:'observation'};
function file(payload:Uint8Array,event_id:string):RawEvent{return {schema_version:'paios.event.v1',event_id,device_id:'phone',device_type:'phone',
  captured_at:new Date().toISOString(),source:{channel:'upload'},media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload};}

test('local cold lifecycle copies within 60s, retains 48h, freshly verifies eviction and restores exact bytes',{timeout:60000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'l5-lifecycle-')),dav=await webdav(t,root),stores:PosixStorage[]=[],archives:RawArchive[]=[];
  t.after(async()=>{for(const archive of archives)await archive.close();for(const store of stores)await store.close();await fs.rm(root,{recursive:true,force:true});});
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config}),archive=new RawArchive(storage,2*1024*1024);
  stores.push(storage);archives.push(archive);const alerts:string[]=[];archive.setAlert(async reason=>{alerts.push(reason);});
  const original=randomBytes(128*1024),event=await archive.archive(file(original,'lifecycle'),trusted),started=performance.now();
  const moved=await archive.moveCold();
  assert.ok(performance.now()-started<60000);assert.ok(moved.segments>0);
  assert.ok((await storage.cold!.locations()).some(r=>r.namespace==='objects'&&r.key===event.payload_sha256));
  const records=await storage.cold!.locations(),now=Date.now();
  for(const record of records){const age=new Date(now-47*hour);await fs.utimes(join(storage.root,record.namespace,record.key),age,age);}
  await archive.moveCold(2,now);
  for(const record of records)assert.equal(await storage.hotSize(record.namespace,record.key),record.size);
  for(const record of records){const age=new Date(now-49*hour);await fs.utimes(join(storage.root,record.namespace,record.key),age,age);}
  dav.state.corrupt=true;
  await assert.rejects(archive.moveCold(2,now),/L5_COLD_VERIFICATION_FAILED/);
  for(const record of records)assert.equal(await storage.hotSize(record.namespace,record.key),record.size);
  dav.state.corrupt=false;
  // A bounded sweep can resume at its next cursor; the following tick revisits the failed pack.
  for(let tick=0;tick<3&&(await storage.listHot('objects')).length;tick++)await archive.moveCold(2,now);
  assert.deepEqual(await storage.listHot('objects'),[]);assert.deepEqual(await storage.listHot('manifests'),[]);
  await archive.close();await storage.close();
  const restarted=new PosixStorage(storage.root,{cold:dav.config}),reader=new RawArchive(restarted,2*1024*1024);
  stores.push(restarted);archives.push(reader);
  assert.deepEqual(Buffer.from(await reader.read(event.raw_ref,'owner',event.archive_revision)),original);
  assert.ok(alerts.includes('L5_COLD_VERIFICATION_FAILED'));
  assert.deepEqual(await restarted.listHot('objects'),[],'a cold read does not silently rehydrate the hot tier');
});

test('exact child kill during PUT leaves no published cold location; restart retries the same pack and preserves hot bytes',{timeout:30000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'l5-interrupted-')),hot=join(root,'hot'),remote=join(root,'cold');
  await fs.mkdir(remote);const password_file=join(root,'password');await fs.writeFile(password_file,'fixture');
  const uploadStarted=Promise.withResolvers<void>();let stalled=true,partial=0;
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Basic ${Buffer.from('fixture:fixture').toString('base64')}`){res.writeHead(401).end();return;}
    const ref=(req.url??'').slice(1);if(!/^[a-f0-9]{64}\.l5pack$/u.test(ref)){res.writeHead(400).end();return;}
    const path=join(remote,ref);
    try{
      if(req.method==='PUT'){
        if(stalled){req.once('data',part=>{partial=part.length;req.pause();uploadStarted.resolve();});return;}
        const parts:Buffer[]=[];for await(const part of req)parts.push(part);
        await fs.writeFile(path,Buffer.concat(parts));res.writeHead(201).end();return;
      }
      const bytes=await fs.readFile(path),range=/^bytes=(\d+)-(\d+)$/u.exec(req.headers.range??'');
      if(range){const start=Number(range[1]),end=Number(range[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}).end(bytes.subarray(start,end+1));}
      else res.writeHead(200).end(bytes);
    }catch(error){res.writeHead((error as NodeJS.ErrnoException).code==='ENOENT'?404:500).end();}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const config={url:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,username:'fixture',password_file};
  const storage=new PosixStorage(hot,{cold:config}),archive=new RawArchive(storage,2*1024*1024),original=randomBytes(1024*1024);
  const event=await archive.archive(file(original,'interrupted'),trusted);await archive.close();await storage.close();
  const script=`import {RawArchive} from ${JSON.stringify(new URL('../src/archive.ts',import.meta.url).href)};
import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts',import.meta.url).href)};
const store=new PosixStorage(${JSON.stringify(hot)},{cold:${JSON.stringify(config)}});
const archive=new RawArchive(store,2097152);await archive.moveCold();await archive.close();await store.close();`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',data=>{errors+=String(data);});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await fs.rm(root,{recursive:true,force:true});});
  const exited=once(child,'close');
  await Promise.race([uploadStarted.promise,exited.then(()=>{throw new Error(`child ended before PUT: ${errors}`);})]);
  assert.ok(partial>0);assert.ok(child.pid);child.kill('SIGKILL');
  assert.deepEqual(await exited,[null,'SIGKILL']);server.closeAllConnections();stalled=false;
  const reopened=new PosixStorage(hot,{cold:config}),retry=new RawArchive(reopened,2*1024*1024);
  t.after(async()=>{await retry.close();await reopened.close();});
  assert.deepEqual(await reopened.cold!.locations(),[]);
  const pending=await reopened.cold!.packs();assert.equal(pending.length,1);
  assert.deepEqual(Buffer.from(await reopened.readHot('objects',sha256(original))),original);
  await retry.moveCold();
  assert.deepEqual((await reopened.cold!.packs()).map(p=>p.key),pending.map(p=>p.key),'retry uses the interrupted content-addressed pack');
  assert.ok((await reopened.cold!.locations()).length>=2);
  assert.deepEqual(Buffer.from(await retry.read(event.raw_ref,'owner',event.archive_revision)),original);
  assert.deepEqual(Buffer.from(await reopened.readHot('objects',sha256(original))),original);
});

test('forced bytes and inode pressure reaches archive notices before verified emergency eviction',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'l5-pressure-lifecycle-')),dav=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config,min_free_bytes:100,min_free_inodes:10}),archive=new RawArchive(storage,4096);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const bytes=Buffer.from('hot-window original'),event=await archive.archive(file(bytes,'pressure'),trusted);
  await archive.moveCold();const notices:string[]=[];
  archive.setAlert(async reason=>{notices.push(reason);
    if(reason==='L5_HOT_WINDOW_EMERGENCY')assert.deepEqual(Buffer.from(await storage.readHot('objects',event.payload_sha256)),bytes);
  });
  const stat=await fs.statfs(storage.root);let pressured=true;
  t.mock.method(fs,'statfs',async()=>({...stat,bsize:1,bavail:pressured?99:1000,ffree:pressured?9:100}));
  const remove=storage.removeOriginals.bind(storage);
  t.mock.method(storage,'removeOriginals',async(records:Parameters<PosixStorage['removeOriginals']>[0])=>{await remove(records);if(records.some(r=>r.namespace==='objects'))pressured=false;});
  assert.equal(await storage.monitorReserve(),true);
  await archive.close();
  assert.ok(notices.includes('L5_DISK_RESERVE_EMERGENCY'));
  assert.ok(notices.includes('L5_INODE_RESERVE_EMERGENCY'));
  assert.ok(notices.includes('L5_HOT_WINDOW_EMERGENCY'));
  assert.deepEqual(await storage.listHot('objects'),[]);
  assert.deepEqual(Buffer.from(await archive.read(event.raw_ref,'owner',event.archive_revision)),bytes);
});

test('bounded backlog ticks resume across archive restart without stranding original references',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'l5-backlog-')),dav=await webdav(t,root),stores:PosixStorage[]=[],archives:RawArchive[]=[];
  t.after(async()=>{for(const archive of archives)await archive.close();for(const store of stores)await store.close();await fs.rm(root,{recursive:true,force:true});});
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config}),archive=new RawArchive(storage,10*1024*1024);
  stores.push(storage);archives.push(archive);const events:ArchivedEvent[]=[];
  for(let n=0;n<3;n++)events.push(await archive.archive(file(Buffer.alloc(9*1024*1024,n+1),`backlog-${n}`),trusted));
  let busy=false;const move=storage.moveCold.bind(storage);
  storage.moveCold=async(...args)=>{const receipt=await move(...args);busy=true;return receipt;};
  const first=await archive.moveCold(2,Date.now(),{busy:()=>busy});assert.equal(first.segments,1);assert.ok(first.hot_bytes<=16*1024*1024);
  assert.ok((await storage.cold!.locations()).filter(r=>r.namespace==='objects').length<3,'one tick must leave backlog for a later tick');
  // Old metadata may leave hot storage in the same bounded tick; its original must already be durable in cold.
  await archive.close();await storage.close();
  const reopened=new PosixStorage(storage.root,{cold:dav.config}),reader=new RawArchive(reopened,10*1024*1024);
  stores.push(reopened);archives.push(reader);const future=Date.now()+49*hour;
  for(let tick=0;tick<6&&(await reopened.listHot('objects')).length;tick++)await reader.moveCold(2,future);
  assert.deepEqual(await reopened.listHot('objects'),[]);
  for(let n=0;n<events.length;n++){
    const event=events[n]!;assert.deepEqual(Buffer.from(await reader.read(event.raw_ref,'owner',event.archive_revision)),Buffer.alloc(9*1024*1024,n+1));
  }
});

test('emergency sweep advances past cold-only packs instead of revisiting its first page forever',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'l5-emergency-cursor-')),dav=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config,min_free_bytes:100,min_free_inodes:10}),archive=new RawArchive(storage,4096);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  archive.setAlert(async()=>{});
  for(let n=0;n<10;n++){
    const bytes=Buffer.from(`cursor-original-${n}`),record={namespace:'objects',key:sha256(bytes),bytes};
    await storage.publish(record.namespace,record.key,bytes);await storage.moveCold([record]);
  }
  const packs=await storage.cold!.packs(true),last=(await storage.cold!.locations(undefined,packs.at(-1)!.key))[0]!;
  for(const pack of packs.slice(0,-1))await storage.removeOriginals(await storage.cold!.locations(undefined,pack.key));
  const stat=await fs.statfs(storage.root);let available=99;
  t.mock.method(fs,'statfs',async()=>({...stat,bsize:1,bavail:available,ffree:100}));
  const remove=storage.removeOriginals.bind(storage);
  t.mock.method(storage,'removeOriginals',async(records:Parameters<PosixStorage['removeOriginals']>[0])=>{await remove(records);available=1000;});
  assert.equal(await storage.monitorReserve(),false,'the first bounded page has no hot copies to reclaim');
  assert.equal(await storage.monitorReserve(),true,'the next call must reach later packs');
  await assert.rejects(storage.readHot(last.namespace,last.key),{code:'ENOENT'});
  assert.equal(sha256(await storage.read(last.namespace,last.key)),last.hash);
});
