import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { ContractError, DeliveryStageError, digest } from '../../../services/personal-aios-integration/src/contracts.ts';
import { createErrandSpool, errandNotice, parseErrandResult, type ErrandProgress, type ErrandResult } from '../src/errand-spool.ts';

function spoolFixture(dir:string,onError:(error:unknown)=>void,options:Parameters<typeof createErrandSpool>[2]={}) {
  let deliver:(r:ErrandResult)=>Promise<boolean>=async()=>false,progress:((r:ErrandProgress[])=>Promise<boolean>)|undefined;
  const spool=createErrandSpool(dir,onError,{...options,deliver:r=>deliver(r),progress:async (_principal,r)=>{await progress?.(r);}});
  return {...spool,attach:(target:typeof deliver,onProgress?:typeof progress)=>{deliver=target;progress=onProgress;return()=>{deliver=async()=>false;progress=undefined;};}};
}

const result = (job_id: string): ErrandResult => ({principal_id:'owner',job_id, task: '帮我点一杯香柠养乐多', app: '千问', success: true,
  answer: '已下单，实付 16.6 元', finished_at: '2026-10-08T10:00:00.000Z'});

test('failed phone cards retain their source evidence through one durable delivery; owner cancellation is not a failure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const delivered:ErrandResult[]=[];
  const spool=createErrandSpool(dir,error=>{throw error;},{deliver:async value=>{delivered.push(value);return true;}});
  t.after(()=>spool.close());
  for(const [index,terminal_reason] of ['timed_out','failed','error','interrupted','cancelled_by_user'].entries()){
    const job_id=`job-${index.toString().padStart(12,'0')}`,raw={...result(job_id),success:false,terminal_reason,answer:'【部分结果】示例店甲参考价 68–98 元；配送费未核实。',
      partial_findings:{verified:['示例店甲：68–98 元'],not_verified:['[pending] 配送费未读到'],last_screen_text:'示例店乙，距离 2 公里',truncated:false},
      title:'查千问香辣蟹价格',evidence_ref:{tool:'phone_status',job_id},...(index===3?{self_check_of:'job-original-failure'}:{})};
    const parsed=parseErrandResult(raw);
    assert.deepEqual(parsed,raw);
    await writeFile(join(dir,`${job_id}.done.json`),JSON.stringify(raw));
    await Promise.all([spool.sweep(),spool.sweep()]);await spool.sweep();
  }
  assert.equal(delivered.length,5);
  assert.equal(delivered.filter(row=>['timed_out','failed','error','interrupted'].includes(row.terminal_reason!)).length,4);
  assert.equal(new Set(delivered.map(row=>row.job_id)).size,5);
  const raw={...result('job-0123456789ab'),title:'查价格',evidence_ref:{tool:'phone_status',job_id:'job-0123456789ab'}};
  for(const evidence_ref of [null,{tool:'exec',job_id:raw.job_id},{tool:'phone_status',job_id:'job-other-owner'},
    {...raw.evidence_ref,path:'/private/screen.txt'}])assert.throws(()=>parseErrandResult({...raw,evidence_ref}),/ERRAND_RESULT_INVALID/);
  assert.throws(()=>parseErrandResult({...raw,self_check_of:'../failure'}),/ERRAND_RESULT_INVALID/);
});

test('partial findings reject malformed or oversized executor evidence without accepting unknown claims',()=>{
  const partial_findings={verified:['示例店甲：68–98 元'],not_verified:['[pending] 配送费未核实'],last_screen_text:'示例店乙',truncated:false};
  const raw={...result('job-0123456789ab'),success:false,terminal_reason:'timed_out',partial_findings};
  for(const invalid of [null,[],{...partial_findings,verified:'invented'}, {...partial_findings,verified:[12]},
    {...partial_findings,last_screen_text:'字'.repeat(4001)}, {...partial_findings,not_verified:['字'.repeat(6001)]},
    {...partial_findings,verified:Array(33).fill('claim')}, {...partial_findings,truncated:'false'},
    {...partial_findings,guessed:'unknown field'}])assert.throws(()=>parseErrandResult({...raw,partial_findings:invalid}),/ERRAND_RESULT_INVALID/);
  assert.throws(()=>parseErrandResult({...raw,success:true}),/ERRAND_RESULT_INVALID/);
});

test('a report failure survives restart, reaches the main agent once and never retries the failed delivery',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-delivery-failed-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const job=result('job-000000000001'),errors:unknown[]=[],failures:unknown[]=[],notices:unknown[]=[];let attempts=0;
  const options={deliver:async()=>{attempts++;throw new ContractError('FORMAL_TEXT_OUTPUT_INVALID',400);},
    failed:async(...failure:unknown[])=>{failures.push(failure);return true;},notify:async(notice:{title:string;body:string})=>{notices.push(notice);}};
  const first=createErrandSpool(dir,error=>errors.push(error),options);
  await writeFile(join(dir,`${job.job_id}.done.json`),JSON.stringify(job));await first.sweep();await first.close();
  assert.equal(attempts,1);
  const saved=JSON.parse(await readFile(join(dir,`${job.job_id}.delivery-failed.json`),'utf8'));
  assert.deepEqual(parseErrandResult(saved),job);
  assert.equal(saved.delivery_failure.error_code,'FORMAL_TEXT_OUTPUT_INVALID');
  const next=createErrandSpool(dir,error=>errors.push(error),options);t.after(()=>next.close());
  await next.sweep();await next.sweep();
  assert.equal(attempts,1);assert.deepEqual(failures,[[job,'FORMAL_TEXT_OUTPUT_INVALID',saved.delivery_failure.failed_at,undefined]]);
  assert.equal(notices.length,1);assert.deepEqual(await readdir(dir),[`${job.job_id}.invalid.json`]);
  assert.deepEqual(errors.map(error=>(error as ContractError).code),['FORMAL_TEXT_OUTPUT_INVALID']);
});

test('a main-agent failure notice waits a minute after an error without reoffering the original result',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-failure-notice-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=Date.now(),attempts=0,reports=0;t.mock.method(Date,'now',()=>now);
  const spool=createErrandSpool(dir,()=>{},{deliver:async()=>{attempts++;throw new ContractError('RUN_NOT_ACCEPTED',409);},
    failed:async()=>{reports++;if(reports===1)throw new Error('MAIN_AGENT_OFFLINE');return true;}});t.after(()=>spool.close());
  const job=result('job-000000000002');await writeFile(join(dir,`${job.job_id}.done.json`),JSON.stringify(job));
  await spool.sweep();await spool.sweep();await spool.sweep();assert.equal(reports,1);assert.equal(attempts,1);
  now+=60_001;await spool.sweep();assert.equal(reports,2);assert.equal(attempts,1);
  assert.deepEqual(await readdir(dir),[`${job.job_id}.invalid.json`]);
});

test('historical delivered records are validated without replay and unknown identities are quarantined intact',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const errors:unknown[]=[],calls:string[]=[];
  const spool=createErrandSpool(dir,e=>errors.push(e),{deliver:async()=>{calls.push('deliver');return true;},notify:async()=>{calls.push('notify');}});
  t.after(()=>spool.close());
  const {principal_id,...unowned}=result('job-111111111111'),bytes=JSON.stringify(unowned,null,2);
  await writeFile(join(dir,`${unowned.job_id}.delivered.json`),bytes);
  const owned=result('job-222222222222');
  await writeFile(join(dir,`${owned.job_id}.delivered.json`),JSON.stringify(owned));
  await spool.sweep();await spool.sweep();
  assert.equal(await readFile(join(dir,`${unowned.job_id}.invalid.json`),'utf8'),bytes);
  assert.equal(await readFile(join(dir,`${unowned.job_id}.delivered.json.quarantine-source`),'utf8'),bytes);
  assert.deepEqual(parseErrandResult(JSON.parse(await readFile(join(dir,`${owned.job_id}.delivered.json`),'utf8'))),owned);
  assert.deepEqual(calls,[]);assert.equal(errors.length,1);
});

test('historical principal recovery uses only exact protected job bindings and preserves the original bytes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-recover-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new PosixStorage(join(dir,'protected'));t.after(()=>storage.close());
  const binding={job_id:'job-333333333333',principal_id:'historical-owner',origin_processed_event_id:'pe-history'};
  await storage.publish('errand-origins',digest({principal_id:binding.principal_id,job_id:binding.job_id}),Buffer.from(JSON.stringify(binding)));
  const {principal_id,...raw}=result(binding.job_id),bytes=JSON.stringify(raw,null,2),path=join(dir,`${raw.job_id}.delivered.json`);
  await writeFile(path,bytes);
  const spool=createErrandSpool(dir,e=>{throw e;},{originStorage:storage,deliver:async()=>{throw Error('must not replay');}});
  t.after(()=>spool.close());await spool.sweep();
  const recovered=parseErrandResult(JSON.parse(await readFile(path,'utf8')));
  assert.equal(recovered.principal_id,binding.principal_id);
  assert.equal(await readFile(`${path}.principal-recovery`,'utf8'),bytes);
});

test('trusted historical recovery preserves the failed delivery and reports it once without executor replay',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-recovered-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new PosixStorage(join(dir,'protected'));t.after(()=>storage.close());
  const binding={job_id:'job-666666666666',principal_id:'historical-owner',origin_processed_event_id:'pe-history'};
  await storage.publish('errand-origins',digest({principal_id:binding.principal_id,job_id:binding.job_id}),Buffer.from(JSON.stringify(binding)));
  const {principal_id,...unowned}=result(binding.job_id),delivery_failure={error_code:'FORMAL_TEXT_OUTPUT_INVALID',failed_at:unowned.finished_at};
  const bytes=JSON.stringify({...unowned,delivery_failure},null,2),path=join(dir,`${binding.job_id}.delivery-failed.json`);
  await writeFile(path,bytes);
  const failures:unknown[]=[],notices:unknown[]=[];
  const spool=createErrandSpool(dir,error=>{throw error;},{originStorage:storage,
    deliver:async()=>{assert.fail('failed deliveries must never replay');},
    failed:async(...args)=>{failures.push(args);return true;},notify:async notice=>{notices.push(notice);}});
  t.after(()=>spool.close());await spool.start();await spool.sweep();await spool.sweep();
  assert.equal(await readFile(`${path}.principal-recovery`,'utf8'),bytes);
  const saved=JSON.parse(await readFile(join(dir,`${binding.job_id}.invalid.json`),'utf8'));
  assert.equal(saved.principal_id,binding.principal_id);assert.deepEqual(saved.delivery_failure,delivery_failure);
  assert.deepEqual(failures,[[parseErrandResult(saved),delivery_failure.error_code,delivery_failure.failed_at,undefined]]);
  assert.equal(notices.length,1);
});

test('conflicting protected job owners remain unknown and protected storage failures do not quarantine history',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-ambiguous-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new PosixStorage(join(dir,'protected'));t.after(()=>storage.close());
  const {principal_id,...raw}=result('job-444444444444'),path=join(dir,`${raw.job_id}.delivered.json`),bytes=JSON.stringify(raw);
  for(const principal_id of ['owner-one','owner-two']){
    const binding={job_id:raw.job_id,principal_id,origin_processed_event_id:'pe-history'};
    await storage.publish('errand-origins',digest({principal_id,job_id:raw.job_id}),Buffer.from(JSON.stringify(binding)));
  }
  const valid=result('job-555555555555'),delivered:string[]=[];
  await writeFile(join(dir,`${valid.job_id}.done.json`),JSON.stringify(valid));
  await writeFile(path,bytes);const errors:unknown[]=[];
  const broken=createErrandSpool(dir,e=>errors.push(e),{
    originStorage:{async *hotKeys(){throw Error('storage offline');},read:storage.read.bind(storage)},
    deliver:async result=>{delivered.push(result.job_id);return true;}});
  await broken.sweep();await broken.close();assert.equal(await readFile(path,'utf8'),bytes);
  assert.deepEqual(delivered,[valid.job_id]);
  const spool=createErrandSpool(dir,e=>errors.push(e),{originStorage:storage});t.after(()=>spool.close());await spool.sweep();
  assert.equal(await readFile(join(dir,`${raw.job_id}.invalid.json`),'utf8'),bytes);assert.equal(errors.length,2);
});

test('terminal refresh waits for the existing errand progress publication',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-refresh-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let refreshed=false;
  const spool=createErrandSpool(dir,error=>{throw error;},{progress:async(principal,jobs)=>{
    assert.equal(principal,'owner');assert.equal(jobs.length,9);assert.equal(jobs[0]!.title,'打开云手机');entered.resolve();await release.promise;
  }});t.after(()=>spool.close());
  for(let n=0;n<9;n++){
    const job_id=`job-${n.toString().padStart(12,'0')}`;
    await writeFile(join(dir,`${job_id}.running.json`),JSON.stringify({principal_id:'owner',job_id,
      title:'打开云手机',app:null,state:'running',started_at:'2026-10-19T16:28:00.000Z',step:0,max_steps:1}));
  }
  const work=spool.refresh().then(()=>{refreshed=true;});await entered.promise;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshed,false);
  release.resolve();await work;assert.equal(refreshed,true);
});

test('origin wire retains request lineage through spool delivery and rejects invalid identifiers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-origin-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const raw = {...result('job-0123456789ab'), origin_processed_event_id: 'pe-owner-request'};
  assert.deepEqual(parseErrandResult(raw), raw);
  for (const origin_processed_event_id of ['', null, 'bad origin', '../request', 'a'.repeat(201)]) {
    assert.throws(() => parseErrandResult({...raw, origin_processed_event_id}));
  }
  const delivered: ErrandResult[] = [];
  const spool = createErrandSpool(dir, error => {throw error;}, {deliver: async value => {delivered.push(value);return true;}});
  t.after(() => spool.close());
  await writeFile(join(dir, `${raw.job_id}.done.json`), JSON.stringify(raw));
  await spool.sweep();
  assert.deepEqual(delivered, [raw]);
  assert.deepEqual(await readdir(dir), [`${raw.job_id}.delivered.json`]);
});

// Reconciliation fixture with the trusted executor fixture principal.
const reconciliationResult: ErrandResult = {"principal_id":"owner","job_id":"job-0123456789ab","task":"从当前页面继续：只读核对订单","success":true,"answer":"【付款核对】未付款","finished_at":"2026-10-16T06:00:00.000Z","app":"千问","payment_reconciliation":{"of_job":"job-a1b2c3d4e5f6","intent_id":"pi-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","state":"unpaid"}};

test('reconciliation wire keeps the exact shared fixture and every scalar outcome without adding an intent', () => {
  assert.deepEqual(parseErrandResult(JSON.parse(JSON.stringify(reconciliationResult))), reconciliationResult);
  for (const state of ['paid', 'unpaid', 'unknown'] as const) {
    const raw = {...reconciliationResult, payment_reconciliation: {...reconciliationResult.payment_reconciliation!, state}};
    const parsed = parseErrandResult(raw);
    assert.deepEqual(parsed, raw);
    assert.equal('payment_intent' in parsed, false);
  }
  const ordinary = result('job-00000001');
  assert.deepEqual(parseErrandResult(ordinary), ordinary);
  assert.equal('payment_reconciliation' in parseErrandResult(ordinary), false);
  for (const finished_at of ['2026-10-16T06:00:00Z', '2026-02-30T06:00:00.000Z', '2026-10-16T25:00:00.000Z', '2026-10-16T06:00:00+00:00']) {
    assert.throws(() => parseErrandResult({...reconciliationResult, finished_at}), /INVALID_CAPTURED_AT/);
  }
});

test('reconciliation wire rejects malformed lineage, extra or missing keys and non-scalar states', () => {
  const valid = reconciliationResult.payment_reconciliation!;
  const invalid: unknown[] = [null, [], 'paid', 1, true, {}, {...valid, extra: 'private'},
    {intent_id: valid.intent_id, state: valid.state}, {of_job: valid.of_job, state: valid.state},
    {of_job: valid.of_job, intent_id: valid.intent_id}];
  for (const of_job of ['', '../job-0123456789ab', 'JOB-0123456789ab', 'a'.repeat(65), null, [], {}]) invalid.push({...valid, of_job});
  for (const intent_id of ['', 'pi invalid', 'a'.repeat(201), null, [], {}]) invalid.push({...valid, intent_id});
  for (const state of ['pending', '', ['paid'], {state: 'paid'}, null, true, 0]) invalid.push({...valid, state});
  for (const payment_reconciliation of invalid) {
    assert.throws(() => parseErrandResult({...reconciliationResult, payment_reconciliation}), /ERRAND_RESULT_INVALID/);
  }
  const boundary = {...valid, of_job: 'a'.repeat(64), intent_id: 'a'.repeat(200)};
  assert.deepEqual(parseErrandResult({...reconciliationResult, payment_reconciliation: boundary}).payment_reconciliation, boundary);
});

test('offline payment notices redact typed lineage or existing prefixes independently of answer wording', () => {
  const body = '解锁依米查看金额和收款方。';
  const plain = {...result('job-00000001'), answer: '订单 order-A 实付 16.6 元，一点点 南门店，奶茶'};
  assert.equal(errandNotice({...plain, payment_intent: 'pi-original'}).body, body);
  assert.equal(errandNotice({...plain, payment_reconciliation: reconciliationResult.payment_reconciliation!}).body, body);
  assert.equal(errandNotice(reconciliationResult).body, body);
  for (const prefix of ['【已付款】', '【付款结果不明】', '【可能已付款】']) {
    assert.equal(errandNotice({...plain, answer: prefix + plain.answer}).body, body);
  }
  assert.equal(errandNotice(plain).body, plain.answer, 'ordinary errands keep their notice');
});

for (const terminal_reason of ['completed', 'failed', 'cancelled_by_user', 'timed_out', 'interrupted'] as const) {
  test(`reconciliation ${terminal_reason} spool notifies privately once and retains lineage for later delivery`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'errand-reconciliation-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const errors: unknown[] = [], notices: {title: string; body: string}[] = [], delivered: ErrandResult[] = [];
    const raw: ErrandResult = {...reconciliationResult, terminal_reason, success: terminal_reason === 'completed', retryable: false,
      answer: 'order-A amount_fen:1660 一点点 南门店 奶茶'};
    const spool = spoolFixture(dir, error => errors.push(error), {notify: async notice => {notices.push(notice);}});
    t.after(() => spool.close());
    await writeFile(join(dir, `${raw.job_id}.done.json`), JSON.stringify(raw));
    await spool.sweep(); await spool.sweep();
    assert.deepEqual(notices, [{title: raw.success ? '依米：办好了' : '依米：没办成', body: '解锁依米查看金额和收款方。'}]);
    assert.deepEqual(await readdir(dir), [`${raw.job_id}.notified.json`]);
    spool.attach(async value => {delivered.push(value); return true;});
    await spool.sweep(); await spool.sweep();
    assert.deepEqual(delivered, [{...raw, finished_at: '2026-10-16T06:00:00.000Z'}]);
    assert.deepEqual(await readdir(dir), [`${raw.job_id}.delivered.json`]);
    assert.equal(notices.length, 1);
    assert.deepEqual(errors, []);
  });
}

test('subscription acceptance keeps the report replayable without an offline notification',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-pending-'));t.after(()=>rm(dir,{recursive:true,force:true}));let delivered:boolean|'pending'='pending',notices=0;
  const spool=createErrandSpool(dir,error=>{throw error;},{deliver:async()=>delivered,notify:async()=>{notices++;}});t.after(()=>spool.close());
  const job=result('job-00000000');await writeFile(join(dir,`${job.job_id}.done.json`),JSON.stringify(job));
  await spool.sweep();
  assert.deepEqual(await readdir(dir),[`${job.job_id}.done.json`]);assert.equal(notices,0);
  delivered=true;await spool.sweep();assert.deepEqual(await readdir(dir),[`${job.job_id}.delivered.json`]);
});

test('a finished errand is delivered once to the attached connection and kept while none is attached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const errors: unknown[] = [];
  const spool = spoolFixture(dir, error => errors.push(error), {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-00000001.done.json'), JSON.stringify(result('job-00000001')));
  await writeFile(join(dir, 'job-00000002.done.json'), '{"job_id": "bad"');
  await spool.sweep();
  assert.deepEqual((await readdir(dir)).sort(), ['job-00000001.done.json', 'job-00000002.invalid.json'], 'nothing attached: the result waits');

  const offline = spool.attach(async () => false);
  await spool.sweep();
  assert.ok((await readdir(dir)).includes('job-00000001.done.json'), 'a connection that is gone keeps the result');
  offline();

  const delivered: ErrandResult[] = [];
  spool.attach(async r => { delivered.push(r); return true; });
  await spool.sweep();
  assert.deepEqual(delivered.map(r => r.job_id), ['job-00000001']);
  assert.deepEqual((await readdir(dir)).sort(), ['job-00000001.delivered.json', 'job-00000002.invalid.json']);
  assert.equal(errors.length, 1, 'the unreadable result is quarantined and reported');
  await spool.sweep();
  assert.equal(delivered.length, 1, 'a delivered result is never sent again');
  await spool.close();
});

test('rejected admission and failed authentication stop delivery and each notify the main agent once',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-rejected-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const errors:unknown[]=[],calls:string[]=[];let notices=0;
  // Regression: a job's D can expire behind its origin run and must not be re-offered on every sweep.
  const spool=createErrandSpool(dir,error=>errors.push(error),{failed:async()=>true,notify:async()=>{notices++;},deliver:async job=>{calls.push(job.job_id);
    if(job.job_id==='job-b2d392414a03')throw new ContractError('RUN_NOT_ACCEPTED',409);throw new ContractError('DEVICE_AUTHENTICATION_REQUIRED',503);}});
  t.after(()=>spool.close());
  await writeFile(join(dir,'job-b2d392414a03.done.json'),JSON.stringify(result('job-b2d392414a03')));
  await writeFile(join(dir,'job-00000005.done.json'),JSON.stringify(result('job-00000005')));
  await spool.sweep();await spool.sweep();
  assert.deepEqual(calls,['job-00000005','job-b2d392414a03']);
  assert.deepEqual((await readdir(dir)).sort(),['job-00000005.invalid.json','job-b2d392414a03.invalid.json']);
  assert.deepEqual(errors.map(error=>(error as ContractError).code),['DEVICE_AUTHENTICATION_REQUIRED','RUN_NOT_ACCEPTED']);
  assert.equal(notices,2,'each failed delivery becomes visible without reoffering its result');
});

test('a sweep requested during delivery scans files added after the active snapshot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-rescan-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();t.after(()=>release.resolve());
  const seen:string[]=[],errors:unknown[]=[];
  const spool=createErrandSpool(dir,error=>errors.push(error),{deliver:async job=>{
    seen.push(job.job_id);if(job.job_id==='job-00000001'){entered.resolve();await release.promise;}return true;
  }});t.after(()=>spool.close());
  await writeFile(join(dir,'job-00000001.done.json'),JSON.stringify(result('job-00000001')));
  const active=spool.sweep();await entered.promise;
  await writeFile(join(dir,'job-00000002.done.json'),JSON.stringify(result('job-00000002')));
  const requested=spool.sweep();release.resolve();await Promise.all([active,requested]);
  assert.deepEqual(seen,['job-00000001','job-00000002']);
  assert.deepEqual((await readdir(dir)).sort(),['job-00000001.delivered.json','job-00000002.delivered.json']);
  assert.deepEqual(errors,[]);
});

test('a concrete delivery failure retains its result and cause until main-agent failure admission is available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const errors: unknown[] = [];
  const spool = spoolFixture(dir, error => errors.push(error), {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-00000003.done.json'), JSON.stringify(result('job-00000003')));
  let fail = true;
  const seen: string[] = [];
  spool.attach(async r => { seen.push(r.job_id); if (fail) throw new Error('ADMISSION_CAPACITY_EXCEEDED'); return true; });
  await spool.sweep();
  assert.ok((await readdir(dir)).includes('job-00000003.delivery-failed.json'));
  fail = false;
  await spool.sweep();
  assert.deepEqual(seen, ['job-00000003']);
  assert.deepEqual(await readdir(dir), ['job-00000003.delivery-failed.json']);
  assert.equal(JSON.parse(await readFile(join(dir,'job-00000003.delivery-failed.json'),'utf8')).delivery_failure.error_code,'ERRAND_REPORT_NOT_DELIVERED');
  await spool.close();
});

test('a disconnected terminal still permits one phone notice and later agent delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const errors: unknown[] = [], notices: unknown[] = [];
  let failing = true;
  const spool = spoolFixture(dir, error => errors.push(error), {intervalMs: 60_000,
    notify: async notice => { if (failing) throw new Error('BARK_PUSH_FAILED'); notices.push(notice); }});
  await spool.start();
  spool.attach(async()=>false);
  await writeFile(join(dir, 'job-00000004.done.json'), JSON.stringify(result('job-00000004')));
  await spool.sweep();
  assert.deepEqual(await readdir(dir), ['job-00000004.done.json'], 'a failed push keeps the result');
  failing = false;
  await spool.sweep();
  assert.equal(notices.length, 0, 'a failed push is retried a minute later, not every sweep');
  await spool.close();

  const later = spoolFixture(dir, error => errors.push(error), {intervalMs: 60_000,
    notify: async notice => { notices.push(notice); }});
  await later.start();
  await later.sweep();
  await later.sweep();
  assert.deepEqual(notices, [{title: '依米：办好了', body: '已下单，实付 16.6 元'}], 'notified once');
  assert.deepEqual(await readdir(dir), ['job-00000004.notified.json']);
  const delivered: string[] = [];
  later.attach(async r => { delivered.push(r.job_id); return true; });
  await later.sweep();
  assert.deepEqual(delivered, ['job-00000004']);
  assert.deepEqual(await readdir(dir), ['job-00000004.delivered.json']);
  assert.equal(notices.length, 1, 'delivery to the main agent does not notify again');
  await later.close();
});

const running = (job_id: string, extra: Partial<ErrandProgress> = {}): ErrandProgress => ({job_id, title: '点一杯香柠养乐多', app: '千问',
  state: 'running', started_at: '2026-10-08T10:00:00.000Z', step: 3, max_steps: 40, ...extra});

test('running errands reach the attached connection as snapshots: on attach, on change, and empty once done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-0000000000b2.running.json'), JSON.stringify({principal_id:'owner',...running('job-0000000000b2', {started_at: '2026-10-08T10:05:00.000Z'})}));
  await writeFile(join(dir, 'job-0000000000a1.running.json'), JSON.stringify({principal_id:'owner',...running('job-0000000000a1')}));
  await writeFile(join(dir, 'job-0000000000c3.running.json'), '{"job_id": "job-0000000000c3"');
  const seen: ErrandProgress[][] = [];
  spool.attach(async () => true, async list => {seen.push(list); return true;});
  await spool.sweep();
  assert.deepEqual(seen.at(-1)!.map(e => e.job_id), ['job-0000000000a1', 'job-0000000000b2'], 'oldest first; a half-written marker is skipped');
  await spool.sweep();
  assert.equal(seen.length, 2, 'the runtime receives the snapshot each sweep and owns per-terminal delivery');
  await writeFile(join(dir, 'job-0000000000a1.running.json'), JSON.stringify({principal_id:'owner',...running('job-0000000000a1', {step: 4})}));
  await spool.sweep();
  assert.equal(seen.at(-1)![0]!.step, 4);
  await rm(join(dir, 'job-0000000000a1.running.json')); await rm(join(dir, 'job-0000000000b2.running.json'));
  await spool.sweep();
  assert.deepEqual(seen.at(-1), []);
  const again: ErrandProgress[][] = [];
  spool.attach(async () => true, async list => {again.push(list); return true;});
  await spool.sweep();
  assert.deepEqual(again, [], 'runtime owns empty initialization after all principal jobs have cleared');
  await spool.close();
});

test('cancel leaves a marker for the executor only for an errand that is running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-0000000000a1.running.json'), JSON.stringify({principal_id:'owner',...running('job-0000000000a1')}));
  assert.equal(await spool.cancel('job-0000000000a1'), true);
  assert.equal(JSON.parse(await readFile(join(dir, 'job-0000000000a1.cancel'), 'utf8')).job_id, 'job-0000000000a1');
  assert.equal(await spool.cancel('job-0000000000ff'), false, 'not running');
  assert.equal(await spool.cancel('../../etc/passwd'), false, 'not a job id');
  assert.deepEqual((await readdir(dir)).sort(), ['job-0000000000a1.cancel', 'job-0000000000a1.running.json']);
  await spool.close();
});

test('a progress snapshot that failed to reach the app is sent again on the next sweep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const errors: unknown[] = [];
  const spool = spoolFixture(dir, error => errors.push(error), {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-0000000000a1.running.json'), JSON.stringify({principal_id:'owner',...running('job-0000000000a1')}));
  let attempts = 0;
  spool.attach(async () => true, async () => { attempts++; if (attempts === 1) throw new Error('publish failed'); return true; });
  await assert.rejects(spool.refresh(),/ERRAND_PROGRESS_PUBLICATION_PENDING/);
  await spool.refresh();
  assert.equal(attempts, 2, 'same snapshot, but the first delivery failed');
  await spool.sweep();
  assert.equal(attempts, 3, 'the runtime owns change suppression');
  assert.equal(errors.length, 1);
  await spool.close();
});

test('one result whose delivery throws does not hold back the others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-00000001.done.json'), JSON.stringify(result('job-00000001')));
  await writeFile(join(dir, 'job-00000002.done.json'), JSON.stringify(result('job-00000002')));
  const delivered: string[] = [];
  spool.attach(async r => { if (r.job_id === 'job-00000001') throw new Error('EVENT_ID_PAYLOAD_CONFLICT'); delivered.push(r.job_id); return true; });
  await spool.sweep();
  assert.deepEqual(delivered, ['job-00000002']);
  assert.deepEqual((await readdir(dir)).sort(), ['job-00000001.delivery-failed.json', 'job-00000002.delivered.json']);
  await spool.close();
});

test('an errand run without a named app (executor writes "app": null) still shows progress and reports its result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  await spool.start();
  // The exact shapes the Python executor writes (json.dumps of None is null).
  await writeFile(join(dir, 'job-0000000000c3.running.json'), JSON.stringify({principal_id:'owner',job_id: 'job-0000000000c3', task: '从当前页面继续', title: '从当前页面继续',
    app: null, tier: 'fast', state: 'running', started_at: '2026-10-08T10:00:00.000Z', step: 2, max_steps: 40}));
  await writeFile(join(dir, 'job-0000000000c4.done.json'), JSON.stringify({principal_id:'owner',job_id: 'job-0000000000c4', task: '从当前页面继续', app: null,
    tier: 'fast', success: true, answer: '办好了', finished_at: '2026-10-08T10:05:00.000Z'}));
  const seen: ErrandProgress[][] = [], delivered: ErrandResult[] = [];
  spool.attach(async r => { delivered.push(r); return true; }, async list => { seen.push(list); return true; });
  await spool.sweep();
  assert.equal(seen.at(-1)![0]!.app, '');
  assert.equal(delivered[0]!.job_id, 'job-0000000000c4');
  assert.equal('app' in delivered[0]!, false);
  await spool.close();
});

test('how an errand ended reaches the main agent; an unknown ending is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  await spool.start();
  await writeFile(join(dir, 'job-0000000000d1.done.json'), JSON.stringify({...result('job-0000000000d1'), success: false,
    answer: '已按用户要求停止', terminal_reason: 'cancelled_by_user', retryable: false}));
  await writeFile(join(dir, 'job-0000000000d2.done.json'), JSON.stringify({...result('job-0000000000d2'), terminal_reason: 'whatever'}));
  const delivered: ErrandResult[] = [];
  spool.attach(async r => { delivered.push(r); return true; });
  await spool.sweep();
  assert.deepEqual(delivered.map(r => [r.job_id, r.terminal_reason, r.retryable]), [['job-0000000000d1', 'cancelled_by_user', false]]);
  assert.ok((await readdir(dir)).includes('job-0000000000d2.invalid.json'));
  await spool.close();
});

test('an SMS errand is one atomic owner-only request file whose job id derives from the request id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-'));
  const spool = spoolFixture(dir, () => undefined, {intervalMs: 60_000});
  const message = {principal_id:'owner',id: 'alert-1', to: '13800000000', text: '【依米紧急提醒】…'};
  const sending = spool.sms(message);
  let names: string[] = [];
  while (!(names = await readdir(dir)).some(name => name.endsWith('.request.json'))) await new Promise(resolve => setTimeout(resolve, 5));
  const requestName = names.find(name => name.endsWith('.request.json'))!;
  await writeFile(join(dir, requestName.replace('.request.json', '.delivered.json')), JSON.stringify({
    ...result(requestName.slice(0, 16)), task: message.text, tier: 'deterministic', terminal_reason: 'completed'}));
  await sending;await spool.sms(message);
  const [name, ...rest] = (await readdir(dir)).filter(name => name.endsWith('.request.json'));
  assert.match(name!, /^job-[0-9a-f]{12}\.request\.json$/u);assert.deepEqual(rest, [], 'the same id is the same job');
  const request = JSON.parse(await readFile(join(dir, name!), 'utf8'));
  assert.deepEqual([request.job_id, request.title], [name!.slice(0, 16), '紧急短信：13800000000']);
  assert.deepEqual([request.kind, request.to, request.text, request.goal], ['sms', message.to, message.text, undefined]);
  await assert.rejects(spool.sms({...message, to: '138; reboot'}), /SMS_REQUEST_INVALID/);
  assert.equal((await stat(join(dir, name!))).mode & 0o777, 0o600);
  await writeFile(join(dir, requestName.replace('.request.json', '.delivered.json')), JSON.stringify({
    ...result(requestName.slice(0, 16)), success: false, task: message.text, tier: 'deterministic', terminal_reason: 'interrupted', retryable: false}));
  await assert.rejects(spool.sms(message), /SMS_NOT_VERIFIED/);
  await rm(dir, {recursive: true, force: true});
});

test('the persisted SMS deadline is also the gateway result-wait deadline', async t => {
  const dir=await mkdtemp(join(tmpdir(),'errand-sms-deadline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  t.mock.timers.enable({apis:['Date'],now:1_000_000});
  const spool=createErrandSpool(dir,error=>{throw error;});let finished=false;
  const sending=assert.rejects(spool.sms({principal_id:'owner',id:'alert-expiry',to:'13800000000',text:'紧急提醒'}),/SMS_SEND_STATE_UNKNOWN/).then(()=>{finished=true;});
  let name:string|undefined;
  while(!(name=(await readdir(dir)).find(name=>name.endsWith('.request.json'))))await new Promise(resolve=>setTimeout(resolve,5));
  const request=JSON.parse(await readFile(join(dir,name),'utf8'));
  assert.equal(request.deadline_ms,1_120_000);
  t.mock.timers.setTime(request.deadline_ms-1);
  await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(finished,false,'the gateway still awaits a result before the persisted deadline');
  t.mock.timers.setTime(request.deadline_ms);
  await sending;
  const replay=assert.rejects(spool.sms({principal_id:'owner',id:'alert-expiry',to:'13800000000',text:'紧急提醒'}),/SMS_SEND_STATE_UNKNOWN/);
  t.mock.timers.setTime(request.deadline_ms+120_000);
  await replay;
  assert.equal(JSON.parse(await readFile(join(dir,name),'utf8')).deadline_ms,request.deadline_ms,'a replay cannot revive an expired request');
});

test('owned snapshots stay separate and stalled progress retains only the latest while done delivery and close finish',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-owned-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
  const seen:{principal:string;running:ErrandProgress[]}[]=[],delivered:ErrandResult[]=[],errors:unknown[]=[];
  const spool=createErrandSpool(dir,error=>errors.push(error),{
    progress:async(principal,running)=>{seen.push({principal,running});if(principal==='owner-a'&&seen.filter(s=>s.principal===principal).length===1)await stalled;},
    deliver:async result=>{delivered.push(result);return true;}});
  const a='job-0000000000a1',b='job-0000000000b2';
  await writeFile(join(dir,`${b}.running.json`),JSON.stringify({principal_id:'owner-b',...running(b)}));
  for(let step=1;step<=30;step++){
    await writeFile(join(dir,`${a}.running.json`),JSON.stringify({principal_id:'owner-a',...running(a,{step})}));
    await spool.sweep();
  }
  await writeFile(join(dir,'job-00000001.done.json'),JSON.stringify({...result('job-00000001'),principal_id:'owner-b'}));
  await spool.sweep();
  assert.equal(seen.filter(s=>s.principal==='owner-a').length,1,'one callback in flight, no promise backlog');
  assert.ok(seen.filter(s=>s.principal==='owner-b').every(s=>s.running.every(job=>job.job_id===b)));
  assert.equal(delivered[0]?.principal_id,'owner-b');
  assert.ok((await readdir(dir)).includes('job-00000001.delivered.json'));
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(seen.filter(s=>s.principal==='owner-a').map(s=>s.running[0]?.step),[1,30]);
  await rm(join(dir,`${a}.running.json`));await spool.sweep();
  assert.deepEqual(seen.filter(s=>s.principal==='owner-a').at(-1)?.running,[]);
  await spool.close();assert.deepEqual(errors,[]);
});

test('unowned executor output is never assigned to the attached principal',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-unowned-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const seen:unknown[]=[],errors:unknown[]=[];
  const spool=createErrandSpool(dir,error=>errors.push(error),{progress:async(...args)=>{seen.push(args);},deliver:async result=>{seen.push(result);return true;}});
  await writeFile(join(dir,'job-0000000000a1.running.json'),JSON.stringify(running('job-0000000000a1')));
  const {principal_id,...unowned}=result('job-00000001');
  await writeFile(join(dir,'job-00000001.done.json'),JSON.stringify(unowned));await spool.sweep();await spool.close();
  assert.deepEqual(seen,[]);assert.equal(errors.length,1);assert.ok((await readdir(dir)).includes('job-00000001.invalid.json'));
});

test('spool close does not join stalled progress delivery',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-close-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const gate=Promise.withResolvers<void>();let started=false;
  const spool=createErrandSpool(dir,error=>{throw error;},{progress:async()=>{started=true;await gate.promise;}});
  await writeFile(join(dir,'job-0000000000a1.running.json'),JSON.stringify({principal_id:'owner',...running('job-0000000000a1')}));
  await spool.sweep();assert.equal(started,true);
  await spool.close();gate.resolve();
});

test('a failed final empty snapshot remains retryable after the principal has no running files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'errand-empty-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const snapshots:ErrandProgress[][]=[],errors:unknown[]=[];let fail=true;
  const spool=createErrandSpool(dir,error=>errors.push(error),{progress:async(_principal,running)=>{
    snapshots.push(running);if(!running.length&&fail){fail=false;throw Error('snapshot scheduling failed');}
  }});
  const marker=join(dir,'job-0000000000a1.running.json');await writeFile(marker,JSON.stringify({principal_id:'owner',...running('job-0000000000a1')}));
  await spool.sweep();await rm(marker);await spool.sweep();await spool.sweep();await spool.close();
  assert.deepEqual(snapshots.map(snapshot=>snapshot.length),[1,0,0]);assert.equal(errors.length,1);
});

test('a report-stage failure keeps its stage and reason through the failure admission; an absorbed report is recorded as absorbed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'errand-spool-stage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const errors: unknown[] = [], failed: unknown[][] = [], notices: unknown[] = [];
  const reason='report run run-1 ended failed (reply_phase=failed, reply_mode=none, warnings=ERRAND_REPORT_REQUIRED) before recipient selection';
  const spool = createErrandSpool(dir, error => errors.push(error), {intervalMs: 60_000, notify: async notice => {notices.push(notice);},
    deliver: async r => {if (r.job_id === 'job-00000005') throw new DeliveryStageError('ERRAND_REPORT_NOT_DELIVERED', 409, 'report_run', reason); return 'absorbed';},
    failed: async (...args) => {failed.push(args); return true;}});
  t.after(()=>spool.close());
  await writeFile(join(dir, 'job-00000005.done.json'), JSON.stringify(result('job-00000005')));
  await writeFile(join(dir, 'job-00000006.done.json'), JSON.stringify({...result('job-00000006'), self_check_of: 'job-00000005:0'}));
  await spool.sweep();
  const failure = JSON.parse(await readFile(join(dir, 'job-00000005.delivery-failed.json'), 'utf8')).delivery_failure;
  assert.deepEqual({...failure, failed_at: undefined}, {error_code: 'ERRAND_REPORT_NOT_DELIVERED', failed_at: undefined, stage: 'report_run', reason});
  const absorbed = JSON.parse(await readFile(join(dir, 'job-00000006.delivered.json'), 'utf8'));
  assert.equal(absorbed.report_absorbed, true);assert.equal(absorbed.delivery_failure, undefined);
  await spool.sweep();
  assert.equal(failed.length, 1);assert.equal(failed[0]![1], 'ERRAND_REPORT_NOT_DELIVERED');assert.deepEqual(failed[0]![3], {stage: 'report_run', reason});
  assert.deepEqual((await readdir(dir)).sort(), ['job-00000005.invalid.json', 'job-00000006.delivered.json']);
  assert.equal(notices.length, 1, 'only the real failure notifies');assert.equal(errors.length, 1);
  await writeFile(join(dir, 'job-00000007.delivery-failed.json'), JSON.stringify({...result('job-00000007'),
    delivery_failure: {error_code: 'ERRAND_REPORT_NOT_DELIVERED', failed_at: '2026-10-08T10:00:00.000Z', stage: 'report_run'}}));
  await spool.sweep();
  assert.ok((await readdir(dir)).includes('job-00000007.invalid.json'), 'a stage without its reason is not a valid failure record');
  assert.equal(failed.length, 1);
});
