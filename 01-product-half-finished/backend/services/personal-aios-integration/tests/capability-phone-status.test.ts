import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityGateway} from '../src/capability/gateway.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {PosixStorage} from '../src/storage.ts';

test('real phone query receipts carry no invented execution identity and repeated queries stay callable', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const folder = await mkdtemp(join(tmpdir(), 'phone-status-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const gateway = new CapabilityGateway(new PosixStorage(folder), async () => ({action: 'allow'}),
    packageCatalog({enabled: ['phone'], gateway: ['phone']}));
  const result = spawnSync(process.env.PAIOS_EXECUTOR_PYTHON ?? 'python3', ['-c', `
import asyncio,json,sys
from unittest.mock import AsyncMock,patch
sys.path.insert(0,sys.argv[1])
from capability.packages.phone.server import host
async def main():
    results=[]
    for jobs in ([], [{'job_id':'job-0123456789ab','success':False},{'job_id':'job-ffffffffffff','state':'running'}]):
        with patch.object(host.payment,'unresolved',return_value=None),patch.object(host.executor,'phone_status',AsyncMock(return_value={'jobs':jobs})):
            results.append((await host.phone_status('owner')).structuredContent)
    print(json.dumps(results))
asyncio.run(main())
`, root], {encoding: 'utf8', env: process.env});
  assert.equal(result.status, 0, result.stderr);
  const binding = {principal_id: 'owner', run_id: 'status', scope: 'owner', invocation: 'interactive' as const};
  let serial = 0;
  for (const receipt of JSON.parse(result.stdout)) {
    assert.equal(receipt.status.state, 'succeeded');
    assert.equal(receipt.job, undefined);
    for (let attempt = 0; attempt < 2; attempt++) {
      const call = {tool_name: 'mcp__phone__phone_status', args: {}, task_id: 'child', session_id: 'session',
        tool_call_id: String(++serial), turn_id: 'turn', api_request_id: 'status'};
      assert.deepEqual(await gateway.decide(binding, call), {action: 'allow'});
      await gateway.receipt(binding, {...call, result: {structuredContent: receipt}});
    }
  }
  assert.ok((await gateway.ledger.current(binding)).every(row => row.receipt.job === undefined));
});

test('the phone manifest separates snapshot reads from bound reconciliation jobs', () => {
  const tools = packageCatalog({enabled: ['phone'], gateway: ['phone']});
  const query = tools.get('mcp__phone__phone_status')!;
  const check = tools.get('mcp__phone__phone_check')!;
  assert.equal(query.check_with, query.name);
  assert.deepEqual(query.context_inject, ['principal_id', 'context']);
  assert.equal(check.effect, 'observe');
  assert.equal(check.target, '$.job_id');
  assert.ok(check.context_inject!.includes('check_job_id'));
  assert.ok(!check.context_inject!.includes('job_id'));
});

test('a completed original-order check resolves to a real job and unlocks the existing generic retry gate', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const result = spawnSync(process.env.PAIOS_EXECUTOR_PYTHON ?? 'python3', ['-c', `
import asyncio,json,sys,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from capability.packages.phone.server import host,receipts
async def read(executor,task):
    return {'success':True,'payment_observation':{'state':'unpaid'},'answer':'synthetic read'}
async def main():
    with tempfile.TemporaryDirectory() as folder,patch.object(host.executor,'SPOOL',folder),patch.object(host.executor,'_jobs',{}),patch.object(host.payment,'check_order',side_effect=read):
        original,checked='job-0123456789ab','job-ffffffffffff'
        record={'job_id':original,'principal_id':'owner','app':'千问','task':'synthetic order','payment_intent':'pi-fixture',
          'phone_started_at':'2026-10-24T01:00:00Z','payment_outcome':'unknown','finished_at':'2026-10-24T01:00:01.000Z','success':False,'answer':'unknown'}
        Path(folder,original+'.delivered.json').write_text(json.dumps(record))
        before=receipts.project(record,job_id=original,revision=1)
        first=(await host.phone_check('owner',original,check_job_id=checked,origin_processed_event_id='d:trusted')).structuredContent
        await host.executor._jobs[checked]['task']
        status=(await host.phone_status('owner',checked)).structuredContent
        again=(await host.phone_check('owner',original)).structuredContent
        print(json.dumps([before,first,status,again]))
asyncio.run(main())
`, root], {encoding: 'utf8', env: process.env});
  assert.equal(result.status, 0, result.stderr);
  const [before, first, status, again] = JSON.parse(result.stdout);
  assert.equal(again.status.state, 'succeeded');
  assert.equal(again.job.id, first.job.id);
  const folder = await mkdtemp(join(tmpdir(), 'phone-check-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const gateway = new CapabilityGateway(new PosixStorage(folder), async () => ({action: 'allow'}),
    packageCatalog({enabled: ['phone'], gateway: ['phone']}));
  const binding = {principal_id: 'owner', run_id: 'check', scope: 'owner', invocation: 'interactive' as const};
  let serial = 0;
  const call = (tool: string, args: Record<string, unknown>) => ({tool_name: 'mcp__phone__' + tool, args,
    task_id: 'child', session_id: 'session', tool_call_id: String(++serial), turn_id: 'turn', api_request_id: 'check'});
  const operation = () => call('phone_task', {goal: 'synthetic order', task_type: 'purchase_errand'});
  await gateway.receipt(binding, {...operation(), result: {structuredContent: before}});
  assert.equal((await gateway.decide(binding, operation())).action, 'block');
  await gateway.receipt(binding, {...call('phone_check', {job_id: before.job.id}), result: {structuredContent: first}});
  await gateway.receipt(binding, {...call('phone_status', {job_id: first.job.id}), result: {structuredContent: status}});
  assert.equal((await gateway.decide(binding, operation())).action, 'block');
  await gateway.receipt(binding, {...call('phone_check', {job_id: before.job.id}), result: {structuredContent: again}});
  assert.equal((await gateway.decide(binding, operation())).action, 'allow');
  assert.ok((await gateway.ledger.records(binding)).some(row => row.check_for === before.job.id && row.receipt.job?.id === first.job.id));
});

test('a successful empty query cannot reconcile an unresolved execution', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const result = spawnSync(process.env.PAIOS_EXECUTOR_PYTHON ?? 'python3', ['-c', `
import asyncio,json,sys,tempfile
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from capability.packages.phone.server import host,receipts
async def main():
    with tempfile.TemporaryDirectory() as folder,patch.object(host.executor,'SPOOL',folder),patch.object(host.executor,'_jobs',{}),patch.object(host.executor,'PHONE_PROVIDER','fake'):
        original=receipts.project({'success':False,'terminal_reason':'interrupted'},job_id='job-0123456789ab',revision=1)
        query=(await host.phone_status('owner')).structuredContent
        missing=(await host.phone_status('owner','job-0123456789ab')).structuredContent
        checked=(await host.phone_check('owner','job-0123456789ab')).structuredContent
        print(json.dumps([original,query,missing,checked]))
asyncio.run(main())
`, root], {encoding: 'utf8', env: process.env});
  assert.equal(result.status, 0, result.stderr);
  const [original, query, missing, checked] = JSON.parse(result.stdout);
  assert.equal(query.status.state, 'succeeded');assert.equal(query.job, undefined);
  const folder = await mkdtemp(join(tmpdir(), 'phone-query-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const gateway = new CapabilityGateway(new PosixStorage(folder), async () => ({action: 'allow'}),
    packageCatalog({enabled: ['phone'], gateway: ['phone']}));
  const binding = {principal_id: 'owner', run_id: 'query', scope: 'owner', invocation: 'interactive' as const};
  let serial = 0;
  const call = (tool: string, args: Record<string, unknown>) => ({tool_name: 'mcp__phone__' + tool, args,
    task_id: 'child', session_id: 'session', tool_call_id: String(++serial), turn_id: 'turn', api_request_id: 'query'});
  const operation = () => call('phone_task', {goal: 'synthetic order', task_type: 'purchase_errand'});
  for (const checkWith of ['phone_status', 'phone_check']) {
    const run = {...binding, run_id: checkWith};
    const before = structuredClone(original);before.next.check_with = checkWith;
    await gateway.receipt(run, {...operation(), result: {structuredContent: before}});
    await gateway.receipt(run, {...call('phone_status', {}), result: {structuredContent: query}});
    assert.equal((await gateway.decide(run, operation())).action, 'block');
    await gateway.receipt(run, {...call('phone_status', {job_id: original.job.id}), result: {structuredContent: missing}});
    assert.equal((await gateway.decide(run, operation())).action, 'block');
    await gateway.receipt(run, {...call('phone_check', {job_id: original.job.id}), result: {structuredContent: checked}});
    assert.equal((await gateway.decide(run, operation())).action, 'block');
  }
  assert.equal(missing.status.state, 'unknown');assert.equal(missing.job, undefined);
  assert.equal(missing.next.retry, 'allowed');
  assert.equal(checked.status.state, 'unknown');assert.equal(checked.job, undefined);
});
