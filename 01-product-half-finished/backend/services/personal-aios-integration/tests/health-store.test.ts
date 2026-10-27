import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HealthStore,type HealthBatch} from '../src/health/store.ts';
import {metricByKey} from '../src/health/metrics.ts';
import {boundary,dayWindow} from '../src/health/calendar.ts';
import {openOwnerDatabase} from '../src/owner-db.ts';
import {aggregateNumber} from '../src/health/summary.ts';
import {queryHealth,recentHealthLine} from '../src/health/query.ts';
const NOW=Date.parse('2026-10-09T12:00:00Z'),id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const steps=metricByKey('steps')!,sleep=metricByKey('sleep')!;
const batch=(control='page',samples:HealthBatch['samples']=[],extra:Partial<HealthBatch>={}):HealthBatch=>
  ({control_id:control,metric:'stepCount',unit:'count',tz:'UTC',sources:['phone'],samples,deleted:[],...extra});
const point=(n=1,v=100):HealthBatch['samples'][number]=>({id:id(n),s:NOW-3600000,e:NOW-3600000,src:0,v});
async function open(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'paios-health-')),dir=join(root,'health'),store=HealthStore.open(dir,()=>NOW);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return {root,dir,store};
}
test('durable replay, conflict, deletion tombstone and restart',async t=>{
  const {dir,store}=await open(t),page=batch('one',[point()]);
  assert.deepEqual(store.ingest('owner','phone',page),{stored:1,deleted:0});
  assert.deepEqual(store.ingest('owner','phone',page),{stored:1,deleted:0});
  assert.throws(()=>store.ingest('owner','phone',batch('one',[point(1,999)])),/HEALTH_BATCH_CONFLICT/);
  assert.equal(store.days('owner',steps,'2026-10-09','2026-10-09')[0]!.summary.total,100);
  const deletion=batch('remove',[],{deleted:[id(1)]});
  assert.deepEqual(store.ingest('owner','phone',deletion),{stored:0,deleted:1});
  assert.deepEqual(store.ingest('owner','phone',deletion),{stored:0,deleted:1});
  store.close();const reopened=HealthStore.open(dir,()=>NOW+1);t.after(()=>reopened.close());
  assert.deepEqual(reopened.ingest('owner','phone',page),{stored:1,deleted:0});
  assert.deepEqual(reopened.ingest('owner','phone',batch('late',[point()])),{stored:0,deleted:0});
  assert.equal(reopened.days('owner',steps,'2026-10-09','2026-10-09').length,0);
  assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,'health.sqlite'))).mode&0o777,0o600);
});
test('principal-scoped UUIDs and tombstones; principal/device-scoped page IDs',async t=>{
  const {store}=await open(t);
  store.ingest('alice','phone',batch('same',[point(1,11)]));
  store.ingest('bob','phone',batch('same',[point(1,22)]));
  store.ingest('alice','watch',batch('same',[point(2,33)]));
  store.ingest('alice','phone',batch('del',[],{deleted:[id(1),id(3)]}));
  store.ingest('bob','phone',batch('late',[point(3,44)]));
  assert.equal(store.days('alice',steps,'2026-10-09','2026-10-09')[0]!.summary.total,33);
  assert.equal(store.days('bob',steps,'2026-10-09','2026-10-09')[0]!.summary.total,66);
  assert.equal(store.samples('alice',steps,NOW-86400000,NOW,100).rows.length,1);
  assert.equal(store.samples('bob',steps,NOW-86400000,NOW,100).rows.length,2);
  assert.equal(store.status('nobody').synced_ms,undefined);
  const source='😀'.repeat(160);
  store.ingest('unicode','phone',batch('unicode',[point()],{sources:[source]}));
  assert.equal(store.samples('unicode',steps,NOW-86400000,NOW,1).rows[0]!.source,source);
});
test('metric mutation rolls back full page; input caps and representable outliers',async t=>{
  const {store}=await open(t);store.ingest('owner','phone',batch('one',[point()]));
  assert.throws(()=>store.ingest('owner','phone',batch('conflict',[point(2,300),point(1,300)],{metric:'heartRate',unit:'count/min'})),/HEALTH_SAMPLE_METRIC_CONFLICT/);
  assert.equal(store.days('owner',metricByKey('heart_rate')!,'2026-10-09','2026-10-09').length,0);
  assert.throws(()=>store.ingest('owner','phone',batch('wrong-delete',[],{metric:'heartRate',unit:'count/min',deleted:[id(1)]})),/HEALTH_SAMPLE_METRIC_CONFLICT/);
  assert.equal(store.samples('owner',steps,NOW-7200000,NOW,10).rows.length,1);
  store.ingest('owner','phone',batch('old',[{...point(3,300),s:0,e:0}],{metric:'heartRate',unit:'count/min'}));
  assert.equal(store.days('owner',metricByKey('heart_rate')!,'1970-01-01','1970-01-01')[0]!.summary.last,300);
  for(const p of [batch('cap',Array.from({length:65},(_,n)=>point(n))),batch('cap',[],{deleted:Array.from({length:129},(_,n)=>id(n))}),
    batch('cap',[],{sources:Array(17).fill('source')}),batch('bad',[{...point(),v:NaN}]),batch('bad',[{...point(),src:1}])])
    assert.throws(()=>store.ingest('owner','phone',p),/HEALTH_(BATCH|SAMPLE)_INVALID/);
});
test('sleep overlap union, local reporting-day clipping and DST',async t=>{
  const {store}=await open(t),s=Date.parse('2026-10-08T22:00:00Z'),e=Date.parse('2026-10-09T06:00:00Z');
  store.ingest('owner','phone',batch('sleep',[
    {id:id(1),s,e,src:0,c:1},{id:id(2),s,e,src:1,c:3},{id:id(3),s:s+3600000,e:s+7200000,src:1,c:4},
  ],{metric:'sleepAnalysis',unit:'category-code',sources:['phone','watch']}));
  const summary=store.days('owner',sleep,'2026-10-09','2026-10-09')[0]!.summary;
  assert.equal(summary.asleep_min,480);assert.equal(summary.stage_overlap_min,60);assert.equal(summary.approximation,'overlapping_sleep_categories');
  store.ingest('owner','phone',batch('cross',[{id:id(4),s:Date.parse('2026-10-09T17:00Z'),e:Date.parse('2026-10-09T19:00Z'),src:0,c:1}],{metric:'sleepAnalysis',unit:'category-code'}));
  assert.equal(store.days('owner',sleep,'2026-10-10','2026-10-10')[0]!.summary.asleep_min,60);
  assert.equal(store.days('owner',sleep,'2026-10-09','2026-10-09')[0]!.summary.asleep_min,540);
  const dstStart=boundary('2026-03-07','America/Los_Angeles',18),dstEnd=boundary('2026-03-08','America/Los_Angeles',18);
  assert.equal(dstEnd-dstStart,23*3600000);
  store.ingest('dst','phone',batch('dst',[{id:id(5),s:dstStart,e:dstEnd,src:0,c:1}],{metric:'sleepAnalysis',unit:'category-code',tz:'America/Los_Angeles'}));
  assert.equal(store.days('dst',sleep,'2026-03-08','2026-03-08')[0]!.summary.asleep_min,1380);
  assert.equal(boundary('2026-11-01','America/Los_Angeles',18)-boundary('2026-10-31','America/Los_Angeles',18),25*3600000);
});
test('fractional offsets: Lord Howe half-hour DST days and Kathmandu local midnight',()=>{
  const utc=(iso:string)=>Date.parse(iso),hours=([from,until]:[number,number])=>(until-from)/3600000;
  // Lord Howe: +10:30 standard, +11:00 daylight; clocks move by 30 minutes at 02:00 local.
  // 2026-10-04 starts daylight time: 23.5 hours from 00:00 +10:30 to 00:00 +11:00.
  assert.deepEqual(dayWindow('2026-10-04','Australia/Lord_Howe'),[utc('2026-10-03T13:30:00Z'),utc('2026-10-04T13:00:00Z')]);
  assert.equal(hours(dayWindow('2026-10-04','Australia/Lord_Howe')),23.5);
  // 2026-04-05 ends daylight time: 24.5 hours from 00:00 +11:00 to 00:00 +10:30.
  assert.deepEqual(dayWindow('2026-04-05','Australia/Lord_Howe'),[utc('2026-04-04T13:00:00Z'),utc('2026-04-05T13:30:00Z')]);
  assert.equal(hours(dayWindow('2026-04-05','Australia/Lord_Howe')),24.5);
  // The sleep reporting day spans the same transition from 18:00 to 18:00 local.
  assert.deepEqual(dayWindow('2026-10-04','Australia/Lord_Howe',true),[utc('2026-10-03T07:30:00Z'),utc('2026-10-04T07:00:00Z')]);
  assert.deepEqual(dayWindow('2026-04-05','Australia/Lord_Howe',true),[utc('2026-04-04T07:00:00Z'),utc('2026-04-05T07:30:00Z')]);
  // Kathmandu: fixed +05:45, so local midnight falls at 18:15 UTC on the previous day.
  assert.equal(boundary('2026-10-09','Asia/Kathmandu'),utc('2026-10-08T18:15:00Z'));
  assert.deepEqual(dayWindow('2026-10-09','Asia/Kathmandu'),[utc('2026-10-08T18:15:00Z'),utc('2026-10-09T18:15:00Z')]);
  assert.deepEqual(dayWindow('2026-10-09','Asia/Kathmandu',true),[utc('2026-10-08T12:15:00Z'),utc('2026-10-09T12:15:00Z')]);
});
test('cumulative source approximation and interval allocation are explicit',async t=>{
  const {store}=await open(t),s=Date.parse('2026-10-08T23:00Z'),e=Date.parse('2026-10-09T01:00Z');
  store.ingest('owner','phone',batch('multi',[{id:id(1),s,e,v:100,src:0},{id:id(2),s,e,v:80,src:1}],{sources:['phone','watch']}));
  for(const day of store.days('owner',steps,'2026-10-08','2026-10-09')){
    assert.equal(day.summary.total,50);assert.equal(day.summary.approximation,'multiple_sources_not_healthkit_merged');
    assert.equal(day.summary.boundary_allocation,'approximate_uniform_over_interval');
  }
});
test('bounded half-open queries, canonical aggregation field, sync zone and compact context',async t=>{
  const {store}=await open(t);
  store.ingest('owner','phone',batch('points',[point(1,11),point(2,22)]));
  assert.equal(store.samples('owner',steps,NOW-3600000,NOW,1).truncated,true);
  assert.equal(store.samples('owner',steps,NOW-7200000,NOW-3600000,100).rows.length,0);
  assert.throws(()=>store.samples('owner',steps,NOW-3600000,NOW,101),/HEALTH_QUERY_RANGE_INVALID/);
  assert.throws(()=>store.days('owner',steps,'2026-02-30','2026-10-09'),/HEALTH_QUERY_RANGE_INVALID/);
  assert.throws(()=>queryHealth(store,'owner',{metric:'steps',granularity:'sample'}),/HEALTH_QUERY_INVALID/);
  assert.throws(()=>queryHealth(store,'owner',{metric:'steps',from:'2026-10-09T10:00:00'}),/HEALTH_QUERY_INVALID/);
  const out=queryHealth(store,'owner',{metric:'steps',from:'2026-10-09',until:'2026-10-10',aggregation:'sample',limit:1},NOW);
  assert.ok('aggregation' in out&&'truncated' in out);assert.equal(out.aggregation,'sample');assert.equal(out.truncated,true);
  assert.equal(recentHealthLine(store,'owner',NOW),undefined);
  store.ingest('owner','phone',batch('resting',[point(3,80)],{metric:'restingHeartRate',unit:'count/min'}));
  const line=recentHealthLine(store,'owner',NOW)!;assert.match(line,/静息心率80/);assert.doesNotMatch(line,/步/);
  store.ingest('owner','phone',batch('zone',[],{tz:'Asia/Shanghai'}));assert.equal(store.status('owner').tz,'Asia/Shanghai');
});
test('private database refuses symlink directory and path traversal filename',async t=>{
  const {root}=await open(t),link=join(root,'linked');await symlink(join(root,'health'),link);
  assert.throws(()=>HealthStore.open(link),/HEALTH_STORE_PATH_UNSAFE/);
  assert.throws(()=>openOwnerDatabase(join(root,'health'),'../outside.sqlite','','test','HEALTH_STORE'),/HEALTH_STORE_PATH_UNSAFE/);
});

test('dense aggregates fail explicitly; retained rows remain available as bounded raw samples',async t=>{
  const {dir,store}=await open(t),db=new DatabaseSync(join(dir,'health.sqlite'));t.after(()=>db.close());
  db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20001) "+
    "INSERT INTO samples SELECT 'owner',printf('%08x-0000-0000-0000-000000000000',x),'phone','stepCount',?,?,1,NULL,NULL,'phone','UTC',? FROM n")
    .run(NOW-1000,NOW-1000,NOW);
  assert.throws(()=>store.days('owner',steps,'2026-10-09','2026-10-09'),/HEALTH_QUERY_TOO_DENSE/);
  assert.equal(store.samples('owner',steps,NOW-2000,NOW,1).truncated,true);
});

test('extreme finite values remain stored; average is finite and overflowing total fails explicitly',async t=>{
  const {store}=await open(t);
  store.ingest('owner','phone',batch('extreme',[point(1,Number.MAX_VALUE),point(2,Number.MAX_VALUE)]));
  assert.throws(()=>store.days('owner',steps,'2026-10-09','2026-10-09'),/HEALTH_AGGREGATE_NOT_FINITE/);
  assert.equal(store.samples('owner',steps,NOW-7200000,NOW,10).rows[0]!.value,Number.MAX_VALUE);
  store.ingest('owner','phone',batch('heart-extreme',[point(3,Number.MAX_VALUE),point(4,Number.MAX_VALUE)],{metric:'heartRate',unit:'count/min'}));
  assert.equal(store.days('owner',metricByKey('heart_rate')!,'2026-10-09','2026-10-09')[0]!.summary.avg,Number.MAX_VALUE);
  assert.equal(aggregateNumber([Number.MAX_VALUE,-Number.MAX_VALUE]),0);
});

test('Apple cardiac event categories retain raw evidence, count records and enforce category semantics',async t=>{
  const {store}=await open(t);
  for(const [n,key] of ['high_heart_rate_event','low_heart_rate_event','irregular_heart_rhythm_event'].entries()){
    const spec=metricByKey(key)!;assert.equal(spec.kind,'event');
    const page=batch(`event-${n}`,[{id:id(n+1),s:NOW-1000,e:NOW,src:0,c:0}],{metric:spec.wire,unit:'category-code'});
    assert.deepEqual(store.ingest('owner','phone',page),{stored:1,deleted:0});
    assert.equal(store.days('owner',spec,'2026-10-09','2026-10-09')[0]!.summary.count,1);
    const result=queryHealth(store,'owner',{metric:key,aggregation:'sample',from:'2026-10-09',until:'2026-10-10'}) as any;
    assert.equal(result.samples[0].category,0);assert.equal(result.samples[0].event,spec.wire);
    assert.throws(()=>store.ingest('owner','phone',{...page,control_id:`bad-${n}`,samples:[{...page.samples[0]!,c:1}]}),/HEALTH_SAMPLE_INVALID/);
    assert.throws(()=>store.ingest('owner','phone',{...page,control_id:`numeric-${n}`,samples:[{id:id(n+10),s:NOW,e:NOW,src:0,v:0}]}),/HEALTH_SAMPLE_INVALID/);
    assert.equal(store.days('other',spec,'2026-10-09','2026-10-09').length,0);
    store.ingest('owner','phone',{...page,control_id:`delete-${n}`,samples:[],deleted:[id(n+1)]});
    assert.equal(store.days('owner',spec,'2026-10-09','2026-10-09').length,0);
  }
});
