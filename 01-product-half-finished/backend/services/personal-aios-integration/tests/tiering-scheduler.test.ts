import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {sha256} from '../src/contracts.ts';
import {sourceClient,type NativeClient} from './native-source-fixture.ts';

const native:NativeClient={async create(){throw new Error('not used');},async status(){throw new Error('not used');},async cancel(){throw new Error('not used');}};
const token='owner-tiering-notice';
async function fixture(t:test.TestContext,configured=false){
  const root=await fs.mkdtemp(join(tmpdir(),'paios-tier-scheduler-'));
  const owners:{assembly:ReturnType<typeof createPersonalAIOSAssembly>;storage:PosixStorage}[]=[];
  const make=()=>{
    const storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
    t.mock.method(archive,'recover',async()=>{});
    t.mock.method(archive,'maintenance',async()=>{});
    const assembly=createPersonalAIOSAssembly({storage,archive,native:sourceClient(native),skill:'tier fixture',max_event_bytes:8192,max_read_bytes:8192,
      ...(configured?{archive_tiering:{hot_days:2}}:{}),
      devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'formal',consent_ref:'owner-consent',route_version:'r1',output_modes:['text'],token_sha256:sha256(token)}],
      admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'tier-scheduler'},
      http:{internal_token:'synthetic-tier-internal-token',max_request_bytes:8192,request_timeout_ms:1000}});
    t.mock.method(assembly.runtime,'monitorCapabilities',async()=>{});
    owners.push({assembly,storage});return {assembly,storage,archive};
  };
  t.after(async()=>{for(const owner of owners){await owner.assembly.close();await owner.storage.close();}await fs.rm(root,{recursive:true,force:true});});
  return {...make(),make};
}

test('unconfigured tiering still monitors reserves every 60 seconds and raises the owner reason',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const {assembly,storage}=await fixture(t),reasons:string[]=[];let checks=0;
  t.mock.method(storage,'monitorReserve',async()=>{checks++;return true;});
  t.mock.method(assembly.runtime,'archiveAlert',async(reason:string)=>{reasons.push(reason);});
  assembly.server.emit('listening');await turn();
  assert.equal(checks,1);assert.deepEqual(reasons,['L5_TIERING_NOT_CONFIGURED']);
  t.mock.timers.tick(59000);await turn();assert.equal(checks,1);
  t.mock.timers.tick(1000);await turn();assert.equal(checks,2);
  t.mock.timers.tick(60000);await turn();assert.equal(checks,3);
  assert.deepEqual(reasons,Array(3).fill('L5_TIERING_NOT_CONFIGURED'));
});

test('configured tiering reports failures, skips overlapping ticks, and close joins stalled work',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  t.after(()=>release.resolve());
  const {assembly,storage,archive}=await fixture(t,true),reasons:string[]=[];
  let moves=0,checks=0;
  t.mock.method(console,'error',()=>{});
  t.mock.method(storage,'monitorReserve',async()=>{checks++;return true;});
  t.mock.method(assembly.runtime,'archiveAlert',async(reason:string)=>{reasons.push(reason);});
  t.mock.method(archive,'maintenance',async(days:number)=>{
    assert.equal(days,2);if(++moves===1)throw new Error('controlled cold failure');
    entered.resolve();await release.promise;return {segments:0,hot_bytes:0,cold_bytes:0};
  });
  assembly.server.emit('listening');await turn();
  assert.deepEqual(reasons,[]);
  t.mock.timers.tick(60000);await entered.promise;
  t.mock.timers.tick(120000);await turn();assert.equal(moves,2);assert.equal(checks,2);
  let closed=false;const closing=assembly.close().then(()=>{closed=true;});
  await turn();assert.equal(closed,false);release.resolve();await closing;
  t.mock.timers.tick(60000);await turn();assert.equal(moves,2);
});

test('unconfigured notice uses Chinese text and persisted six-hour receipts across restart',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:12*60*60*1000});
  const f=await fixture(t),messages:string[]=[];
  const connect=async(assembly:typeof f.assembly)=>assembly.runtime.watchCare(await assembly.runtime.authenticate(token),
    async(_id,text)=>{messages.push(text);return 'pending';});
  const stop=await connect(f.assembly);
  await f.assembly.runtime.archiveAlert('L5_TIERING_NOT_CONFIGURED');
  assert.equal(messages.length,1);assert.match(messages[0]!,/冷存储尚未配置/);assert.doesNotMatch(messages[0]!,/L5_/);
  stop();await f.assembly.close();
  t.mock.timers.tick(60*60*1000);
  const restarted=f.make(),stopAgain=await connect(restarted.assembly);
  await restarted.assembly.runtime.archiveAlert('L5_TIERING_NOT_CONFIGURED');
  assert.equal(messages.length,1);assert.equal((await restarted.storage.list('archive-alerts')).length,1);
  assert.equal((await restarted.storage.list('archive-alert-deliveries')).length,1);
  t.mock.timers.tick(5*60*60*1000);
  await restarted.assembly.runtime.archiveAlert('L5_TIERING_NOT_CONFIGURED');
  assert.equal(messages.length,2);assert.equal((await restarted.storage.list('archive-alerts')).length,2);
  assert.equal((await restarted.storage.list('archive-alert-deliveries')).length,2);stopAgain();
});

test('the same maintenance clock resumes immediately after a pack overruns its minute',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  let clock=0,moves=0;t.mock.method(performance,'now',()=>clock);
  const {assembly,storage,archive}=await fixture(t,true),release=Promise.withResolvers<void>();
  t.after(()=>release.resolve());
  t.mock.method(storage,'monitorReserve',async()=>true);
  t.mock.method(archive,'maintenance',async()=>{if(++moves===1)clock=65000;else await release.promise;});
  assembly.server.emit('listening');await turn();assert.equal(moves,1);
  t.mock.timers.tick(0);await turn();assert.equal(moves,2);
  const closing=assembly.close();release.resolve();await closing;
});

test('a throwing capability monitor cannot skip reserves or archive maintenance on successive ticks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {assembly,storage,archive}=await fixture(t,true);let probes=0,reserves=0,moves=0;
  t.mock.method(console,'error',()=>{});
  t.mock.method(assembly.runtime,'monitorCapabilities',async()=>{probes++;throw Error('fictional health timeout');});
  t.mock.method(storage,'monitorReserve',async()=>{reserves++;return true;});
  t.mock.method(archive,'maintenance',async()=>{moves++;});
  assembly.server.emit('listening');await turn();
  assert.deepEqual({probes,reserves,moves},{probes:1,reserves:1,moves:1});
  t.mock.timers.tick(60000);await turn();
  assert.deepEqual({probes,reserves,moves},{probes:2,reserves:2,moves:2});
});

test('a pending health probe does not hold the maintenance clock or overlap another probe; close joins it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const release=Promise.withResolvers<void>();t.after(()=>release.resolve());
  const {assembly,storage,archive}=await fixture(t,true);let probes=0,reserves=0,moves=0;
  t.mock.method(assembly.runtime,'monitorCapabilities',async()=>{probes++;await release.promise;});
  t.mock.method(storage,'monitorReserve',async()=>{reserves++;return true;});
  t.mock.method(archive,'maintenance',async()=>{moves++;});
  assembly.server.emit('listening');await turn();
  assert.deepEqual({probes,reserves,moves},{probes:1,reserves:1,moves:1});
  t.mock.timers.tick(60000);await turn();
  assert.deepEqual({probes,reserves,moves},{probes:1,reserves:2,moves:2});
  let closed=false;const closing=assembly.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);
  release.resolve();await closing;
});
