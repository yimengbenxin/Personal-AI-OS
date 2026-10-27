import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {OwnerOverride,createOwnerOverrideSecret} from '../src/owner-override.ts';
import {PosixStorage} from '../src/storage.ts';
import {fileURLToPath} from 'node:url';

const PASSPHRASE='private test passphrase α';
async function fixture(t:{after:(work:()=>unknown)=>void},ttl_s=2){
  const root=await mkdtemp(join(tmpdir(),'owner-override-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'owner-override.json');
  await writeFile(path,JSON.stringify(await createOwnerOverrideSecret(PASSPHRASE)),{mode:0o600});
  const storage=new PosixStorage(join(root,'storage'),{min_free_bytes:1,min_free_inodes:1});
  let now=1_800_000_000_000;
  const authority=()=>{const a=new OwnerOverride({storage,secret_root:root,ttl_s,now:()=>now});t.after(()=>a.close());return a;};
  return {root,path,storage,authority,tick:(ms:number)=>{now+=ms;}};
}
test('durable switch survives restart, expires once, and another device can turn it off',async t=>{
  const f=await fixture(t),a=f.authority(),events:unknown[]=[];
  a.subscribe(status=>events.push(status));
  assert.deepEqual(await a.status(),{available:true,enabled:false,expires_at:null,enabled_by_device:null,remaining_s:null});
  const enabled=await a.enable('phone',PASSPHRASE);assert.equal(enabled.remaining_s,2);assert.equal(enabled.enabled_by_device,'phone');
  await a.enable('phone',PASSPHRASE);assert.equal(events.length,1);
  a.close();const b=f.authority();assert.equal(await b.active(),true);
  assert.equal((await b.disable('glasses')).enabled,false);assert.equal(await f.authority().active(),false);
  await b.enable('phone',PASSPHRASE);const changes:unknown[]=[];b.subscribe(status=>changes.push(status));
  f.tick(2000);assert.equal(await b.active(),false);assert.equal((await b.status()).expires_at,null);assert.equal(changes.length,1);
  assert.equal(await f.authority().active(),false);
});
test('concurrent failures serialize, global lockout survives restart and clears after 15 minutes',async t=>{
  const f=await fixture(t),a=f.authority();
  const results=await Promise.allSettled(Array.from({length:8},(_,i)=>a.enable(`device-${i}`,`wrong-${i}`)));
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='OWNER_OVERRIDE_INVALID_PASSPHRASE').length,5);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='OWNER_OVERRIDE_LOCKED').length,3);
  const b=f.authority();await assert.rejects(b.enable('new-device',PASSPHRASE),/OWNER_OVERRIDE_LOCKED/);
  f.tick(15*60*1000);assert.equal((await b.enable('new-device',PASSPHRASE)).enabled,true);
});
test('successful enable and disable cannot reset the rolling failure budget',async t=>{
  const f=await fixture(t),a=f.authority();
  for(let n=0;n<4;n++)await assert.rejects(a.enable('phone','wrong'),/OWNER_OVERRIDE_INVALID_PASSPHRASE/);
  await a.enable('phone',PASSPHRASE);await a.disable('mac');
  await assert.rejects(a.enable('phone','wrong'),/OWNER_OVERRIDE_INVALID_PASSPHRASE/);
  await assert.rejects(a.enable('other-phone',PASSPHRASE),/OWNER_OVERRIDE_LOCKED/);
});
test('indefinite switch and unavailable/malformed secret fail closed without exposing passphrase',async t=>{
  const f=await fixture(t,0),a=f.authority();
  const logs:string[]=[];t.mock.method(process.stderr,'write',(chunk:unknown)=>{logs.push(String(chunk));return true;});
  await assert.rejects(a.enable('phone','wrong-token'),{code:'OWNER_OVERRIDE_INVALID_PASSPHRASE',status:403});
  assert.equal((await a.enable('phone',PASSPHRASE)).expires_at,null);f.tick(100*86400000);assert.equal(await a.active(),true);
  await chmod(f.path,0o644);assert.equal((await a.status()).available,false);assert.equal(await a.active(),false);
  await chmod(f.path,0o600);await writeFile(f.path,'{}');assert.equal(await a.active(),false);
  await rm(f.path);assert.equal((await a.status()).available,false);
  await assert.rejects(a.enable('phone',PASSPHRASE),/OWNER_OVERRIDE_UNAVAILABLE/);
  assert.equal(await new OwnerOverride({storage:f.storage}).active(),false);
  const state=await f.storage.read('voiceprints',(await f.storage.list('voiceprints'))[0]!);
  assert.equal(Buffer.from(state).toString().includes(PASSPHRASE),false);
  assert.ok(logs.some(line=>line.includes('owner_override_enable')));
  assert.ok(logs.some(line=>line.includes('owner_override_failure')));
  assert.ok(logs.every(line=>!line.includes(PASSPHRASE)&&!line.includes('wrong-token')&&!line.includes('salt')&&!line.includes('hash')));
});
test('corrupt persisted state fails closed on every read and TTL uses valid safe milliseconds',async t=>{
  const f=await fixture(t),a=f.authority();await a.enable('phone',PASSPHRASE);a.close();
  const key=(await f.storage.list('voiceprints'))[0]!;
  for(const state of [{enabled:true,expires_at:null,enabled_by_device:null,failures:[]},
    {enabled:true,expires_at:'yesterday',enabled_by_device:'phone',failures:[]},
    {enabled:false,expires_at:null,enabled_by_device:null,failures:[{device:'',at:0}]}]){
    await f.storage.replace('voiceprints',key,Buffer.from(JSON.stringify(state)));const b=f.authority();
    await assert.rejects(b.active(),{code:'OWNER_OVERRIDE_INVALID_STATE',status:500});
    await assert.rejects(b.active(),{code:'OWNER_OVERRIDE_INVALID_STATE',status:500});
  }
  assert.throws(()=>new OwnerOverride({storage:f.storage,ttl_s:Number.MAX_SAFE_INTEGER}),/OWNER_OVERRIDE_INVALID_TTL/);
});
test('expiry timer notifies subscribers and close removes its timer',async t=>{
  const f=await fixture(t),a=f.authority();t.mock.timers.enable({apis:['setTimeout']});
  let notify:()=>void=()=>{};const expired=new Promise<void>(resolve=>{notify=resolve;});
  const stop=a.subscribe(status=>{if(!status.enabled)notify();});
  await a.enable('phone',PASSPHRASE);f.tick(2000);t.mock.timers.tick(2000);await expired;
  assert.equal(await a.active(),false);stop();await a.enable('phone',PASSPHRASE);a.close();
  let changed=false;a.subscribe(()=>{changed=true;});f.tick(2000);t.mock.timers.tick(2000);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(changed,false);
});
function cli(root:string,input:string,args:string[]=[]):Promise<{code:number|null;out:string;err:string}>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/provision-owner-override.ts',import.meta.url)),...args],
      {env:{...process.env,PAIOS_SECRET_ROOT:root},stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
test('provisioning accepts stdin only, writes a 0600 random-salt scrypt file, and never echoes input',async t=>{
  const f=await fixture(t),a=await cli(f.root,`${PASSPHRASE}\n`);assert.deepEqual(a,{code:0,out:'',err:''});
  assert.equal((await stat(f.path)).mode&0o777,0o600);
  const first=JSON.parse(await readFile(f.path,'utf8'));assert.equal(first.schema,'paios.owner-override.secret.v1');
  assert.equal(JSON.stringify(first).includes(PASSPHRASE),false);assert.equal((await f.authority().enable('phone',PASSPHRASE)).enabled,true);
  assert.equal((await cli(f.root,`${PASSPHRASE}\n`)).code,0);assert.notEqual(JSON.parse(await readFile(f.path,'utf8')).salt,first.salt);
  for(const [input,args] of [['',[]],['x'.repeat(1025),[]],['x'.repeat(4099),[]],[PASSPHRASE,[PASSPHRASE]]] as [string,string[]][]){
    const result=await cli(f.root,input,args);assert.equal(result.code,1);assert.equal(result.out,'');assert.equal(result.err,'OWNER_OVERRIDE_PROVISION_FAILED\n');
  }
});
