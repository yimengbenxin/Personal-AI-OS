import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import type {TrustedContext} from '../src/contracts.ts';
import {webdav} from './stream-materialized-fixture.ts';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';

const MiB=1024*1024,namespace='objects';
const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'upload',consent_ref:'fixture',submission:'observation'};
test('tier upload rate is a positive integer in kbps, validated before resources open',async()=>{
  const cold={url:'http://cold-webdav:5244/dav',username:'fixture',password_file:'/unused/password'};
  for(const max_upload_kbps of [0,-1,1.5,'2000',null,Infinity])
    await assert.rejects(provisionCentralResources({port:0,archive_tiering:{cold,max_upload_kbps}} as unknown as CentralProvisionConfiguration),/INVALID_ARCHIVE_TIERING/);
  for(const archive_tiering of [{cold},{cold,max_upload_kbps:2000}])
    await assert.rejects(provisionCentralResources({port:0,archive_tiering} as CentralProvisionConfiguration),/INVALID_SERVICE_PORT/);
  await assert.rejects(provisionCentralResources({port:0,archive_tiering:{cold,paused:'true'}} as unknown as CentralProvisionConfiguration),/INVALID_ARCHIVE_TIERING/);
  await assert.rejects(provisionCentralResources({port:0,archive_tiering:{cold,paused:true}} as CentralProvisionConfiguration),/INVALID_SERVICE_PORT/);
});
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'l5-pacing-')),dav=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config}),archive=new RawArchive(storage,8*MiB);
  const notices:string[]=[];archive.setAlert(async reason=>{notices.push(reason);});
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const publish=async(n:number,size:number)=>{const bytes=randomBytes(size);
    const event=await archive.archive({schema_version:'paios.event.v1',event_id:`file-${n}`,device_id:'phone',device_type:'phone',
      captured_at:new Date().toISOString(),source:{channel:'upload'},media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload:bytes},trusted);
    return {key:event.payload_sha256,bytes,event};};
  return {dav,storage,archive,notices,publish};
}

test('busy defers uploads but still verifies and evicts old hot copies; idle resumes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {storage,archive,publish}=await fixture(t),old=await publish(1,1024);
  await archive.moveCold();const age=new Date(Date.now()-49*3600000);
  await fs.utimes(join(storage.root,namespace,old.key),age,age);
  const fresh=await publish(2,1024);let busy=true;
  const policy={busy:()=>busy,max_upload_kbps:2000};
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
  await assert.rejects(storage.readHot(namespace,old.key),{code:'ENOENT'});
  assert.deepEqual(await storage.read(namespace,old.key),old.bytes);
  assert.equal(await storage.cold!.contains(namespace,fresh.key),false);
  busy=false;assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,1);
  assert.deepEqual(await storage.cold!.read(namespace,fresh.key),fresh.bytes);
});

test('the upload stream respects decimal kbps within a pack, rather than delaying only the next pack',async t=>{
  const {storage,archive,publish}=await fixture(t);
  await publish(1,128*1024);await publish(2,128*1024);await publish(3,1);
  const batches:number[]=[],move=storage.moveCold.bind(storage);
  t.mock.method(storage,'moveCold',async(...args:Parameters<PosixStorage['moveCold']>)=>{
    batches.push(args[0].reduce((sum,r)=>sum+r.bytes.length,0));return move(...args);
  });
  const policy={max_upload_kbps:2000},started=performance.now(),first=await archive.moveCold(2,Date.now(),policy);
  assert.equal(first.segments,1);assert.equal(batches.length,1);assert.ok(batches[0]!>=256*1024&&batches[0]!<=16*MiB);
  assert.ok(performance.now()-started>=first.cold_bytes*8/2000,'even the first PUT must obey the bandwidth cap');
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
});

test('a call starting mid-PUT stops the stream and idle retries without evicting the unverified original',async t=>{
  const {dav,storage,archive,notices,publish}=await fixture(t),record=await publish(1,512*1024);
  let busy=false;dav.state.onUpload=()=>{busy=true;};
  const policy={busy:()=>busy,max_upload_kbps:2000},started=performance.now();
  assert.equal((await archive.moveCold(1,Date.now()+49*3600000,policy)).segments,0);
  assert.ok(performance.now()-started<1000,'a call must not wait for the rest of a large pack');
  assert.ok(dav.state.uploaded>0&&dav.state.uploaded<=32*1024,'only the in-flight transport chunk may follow the busy signal');
  assert.equal(await storage.cold!.contains(namespace,record.key),false);
  assert.deepEqual(await storage.readHot(namespace,record.key),record.bytes);assert.deepEqual(notices,[]);
  busy=false;dav.state.onUpload=undefined;
  assert.equal((await archive.moveCold(1,Date.now(),policy)).segments,1);
  assert.deepEqual(await storage.cold!.read(namespace,record.key),record.bytes);
});

test('owner deletion retires a deferred pack before idle resumes',async t=>{
  const {dav,storage,archive,publish}=await fixture(t),record=await publish(1,256*1024);
  let busy=false;dav.state.onUpload=()=>{busy=true;};
  assert.equal((await archive.moveCold(1,Date.now(),{busy:()=>busy,max_upload_kbps:2000})).segments,0);
  await archive.delete(record.event.raw_ref,'owner');busy=false;dav.state.onUpload=undefined;
  assert.equal((await archive.moveCold()).segments,0);
  assert.deepEqual(await storage.cold!.locations(),[]);
  await assert.rejects(storage.read('objects',record.key),{code:'ENOENT'});
});

test('a call beginning during packing blocks PUT without a failure alert or a lost candidate',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {dav,storage,archive,notices,publish}=await fixture(t),record=await publish(1,1024);
  let busy=false,interrupt=true;const read=fs.readFile.bind(fs);
  t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{
    const value=await read(...args);if(args[0]===dav.config.password_file&&interrupt){busy=true;interrupt=false;}return value;
  });
  const policy={busy:()=>busy,max_upload_kbps:2000};
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
  assert.deepEqual(await fs.readdir(dav.directory),[]);assert.deepEqual(notices,[]);
  assert.equal(await storage.cold!.contains(namespace,record.key),false);
  busy=false;assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,1);
  assert.deepEqual(await storage.cold!.read(namespace,record.key),record.bytes);
});
