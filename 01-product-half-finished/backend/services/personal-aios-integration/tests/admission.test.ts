import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { PosixStorage } from '../src/storage.ts';
import { RunAdmission, type AdmissionPolicy } from './native-source-fixture.ts';
import { ContractError, EVENT_SCHEMA, canonical, digest, type ProcessedEvent } from '../src/contracts.ts';
import { HermesClient, NativeNotAcceptedError, type NativeClient, type NativeRun } from './native-source-fixture.ts';
import {NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';

const policy: AdmissionPolicy = {max_pending_events: 4, max_pending_bytes: 100000, max_event_age_ms: 10000,
  poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'test'};
class FakeNative implements NativeClient {
  readonly runs = new Map<string, NativeRun>();
  creates = 0;
  logicalRuns = 0;
  lost = false;
  busy = 0;
  async create(body: {input: string; instructions: string; session_id: string}, key: string): Promise<NativeRun> {
    this.creates++;
    const previous = this.runs.get(key);
    if (previous) return {...previous, replayed: true};
    if (this.busy-- > 0) throw new NativeNotAcceptedError('gateway_draining');
    const run: NativeRun = {run_id: `run-${++this.logicalRuns}`, session_id: body.session_id, conversation_session_id: body.session_id, status: 'running'};
    this.runs.set(key, run);
    if (this.lost) { this.lost = false; throw new Error('RESPONSE_LOST'); }
    return {...run};
  }
  async status(runId: string): Promise<NativeRun> {
    const run = [...this.runs.values()].find(r => r.run_id === runId);
    assert.ok(run); return {...run};
  }
  async cancel(runId: string): Promise<NativeRun> { return {...await this.status(runId), status: 'running'}; }
  finish(runId: string, status = 'completed'): void {
    const run = [...this.runs.values()].find(r => r.run_id === runId); assert.ok(run); run.status = status;
  }
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2000; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('condition did not settle');
}
async function fixture(t: test.TestContext, override: Partial<AdmissionPolicy> = {}) {
  const path = await fs.mkdtemp(join(tmpdir(), 'paios-admission-'));
  const storage = new PosixStorage(path);
  const native = new FakeNative();
  const instances: RunAdmission[] = [];
  let beforeRemove: (() => Promise<void>) | undefined;
  const admission = () => {
    const instance = new RunAdmission(storage, native, {...policy, ...override}); instances.push(instance); return instance;
  };
  t.after(async () => { await Promise.all(instances.map(instance => instance.close()));
    try {await beforeRemove?.();} finally {await fs.rm(path, {recursive: true, force: true});} });
  const ingress = new UnifiedIngress(new RawArchive(storage, 10000, () => '2026-10-01T00:00:00.000Z'));
  const d = async (eventId: string): Promise<ProcessedEvent> => ingress.accept({schema_version: EVENT_SCHEMA,
    event_id: eventId, device_id: 'mac', device_type: 'mac', captured_at: '2026-10-01T00:00:00.000Z',
    source: {channel: 'text'}, media_type: 'text', mime: 'text/plain;charset=utf-8', representation: 'uploaded_original',
    payload: Buffer.from(eventId)}, {principal_id: 'owner', device_id: 'mac', device_type: 'mac',
    consent_ref: 'consent', channel: 'text', submission: 'explicit_text'});
  return {path, storage, native, admission, d, track: (instance: RunAdmission) => {instances.push(instance); return instance;},
    beforeCleanup: (hook: () => Promise<void>) => {assert.equal(beforeRemove,undefined);beforeRemove=hook;}};
}

test('unsupported D classification is rejected before admission or native execution', async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d('classification');
  const invalid = [
    {intent_class: 'explicit_task_request'}, {intent_class: null},
    {origin: 'recognized_owner'}, {origin: false},
    {reply_hint: 'speak_now'}, {reply_hint: []},
  ];
  for (const fields of invalid) {
    await assert.rejects(a.admit({...d, ...fields} as unknown as ProcessedEvent, 'session', 'skill'),
      /D_INVALID_CLASSIFICATION/);
  }
  assert.equal(f.native.creates, 0);
  assert.deepEqual(await f.storage.list('admissions'), []);
  assert.deepEqual(await f.storage.list('admission-inputs'), []);
});

test('running is emitted once across polls and snapshots retain their transition binding',async t=>{
  const f=await fixture(t),a=f.admission(),d=await f.d('transition');
  const snapshots:{state:string;run_id?:string}[]=[],release=Promise.withResolvers<void>();let polls=0;
  const status=f.native.status.bind(f.native);f.native.status=async run=>{polls++;return status(run);};
  a.setStateOwner(async entry=>{if(entry.record.state==='accepted')await release.promise;snapshots.push({...entry.record});});
  try {
    await a.admit(d,'session','skill');await until(()=>polls>=3);
    assert.deepEqual(snapshots.map(s=>s.state),['running']);
    f.native.finish('run-1');await until(()=>snapshots.some(s=>s.state==='completed'));
  } finally {release.resolve();await a.close();}
  assert.equal(snapshots.filter(s=>s.state==='running').length,1);
  assert.equal(snapshots.find(s=>s.state==='accepted')?.run_id,'run-1');
});

test('only scheduled and place background admissions select the native background budget', async t => {
  const f = await fixture(t), a = f.admission(), create = f.native.create.bind(f.native);
  const bodies: {turn_budget?: string; input: string}[] = [];
  f.native.create = async (body, key) => {bodies.push(body); return create(body, key);};
  for (const channel of ['text', 'background_scheduled', 'background_place', 'continuous_audio']) {
    const d = await f.d(channel);
    await a.admit({...d, source: {...d.source, channel}}, `session-${channel}`, 'skill');
  }
  await until(() => bodies.length === 4);
  assert.deepEqual(bodies.map(body => [JSON.parse(body.input).source.channel, body.turn_budget]),
    [['text', undefined], ['background_scheduled', 'background'], ['background_place', 'background'], ['continuous_audio', undefined]]);
});

test('voice handoff carries the model authored thinking toggle independently for each request', async t => {
  const f = await fixture(t), a = f.admission(), create = f.native.create.bind(f.native);
  const bodies: {model_options?: {reasoning: {enabled: boolean}}; input: string}[] = [];
  f.native.create = async (body, key) => {bodies.push(body); return create(body, key);};
  for (const thinking of ['enabled', 'disabled']) {
    const d = await f.d(`handoff-${thinking}`);
    await a.admit({...d, content: {...d.content, app_event: {handoff: {
      difficulty: 'model assessment', intent: 'owner request', thinking}}}}, `session-${thinking}`, 'skill');
  }
  await until(() => bodies.length === 2);
  assert.deepEqual(bodies.map(body => body.model_options),
    [{reasoning: {enabled: true}}, {reasoning: {enabled: false}}]);
  assert.deepEqual(bodies.map(body => JSON.parse(body.input).content.app_event.handoff.thinking), ['enabled', 'disabled']);
});

test('lost response survives restart; another D waits; explicit reconciliation reuses exact native identity', async t => {
  const f = await fixture(t); const first = await f.d('first'); const second = await f.d('second');
  let a = f.admission(); f.native.lost = true;
  const accepted = await a.admit(first, 'session', 'fixed skill');
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'reconcile_required');
  await a.close(); a = f.admission();
  await a.admit(second, 'session', 'fixed skill');
  assert.equal(f.native.logicalRuns, 1);
  assert.equal((await a.getAsync('owner', 'session', first.processed_event_id))?.state, 'reconcile_required');
  assert.equal(f.native.creates, 1);
  await a.reconcile('owner', 'session', first.processed_event_id);
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'running');
  const restored = a.get('owner', 'session', first.processed_event_id)!;
  assert.equal(restored.idempotency_key, accepted.idempotency_key); assert.equal(f.native.logicalRuns, 1);
  assert.equal(a.find(restored.run_id!, 'session')?.d.processed_event_id, first.processed_event_id);
  f.native.finish(restored.run_id!);
  await until(() => f.native.logicalRuns === 2);
  assert.equal((await a.getAsync('owner', 'session', first.processed_event_id))?.state, 'completed');
  assert.equal(a.get('owner', 'session', first.processed_event_id), undefined);
});

test('same D concurrent admission and conflicting payload produce exactly one logical native run', async t => {
  const f = await fixture(t); const d = await f.d('same'); const a = f.admission();
  const records = await Promise.all(Array.from({length: 10}, () => a.admit(d, 'session', 'skill')));
  assert.equal(new Set(records.map(r => r.idempotency_key)).size, 1);
  await until(() => f.native.logicalRuns === 1); assert.equal(f.native.creates, 1);
  await assert.rejects(a.admit({...d, content: {text: 'changed'}}, 'session', 'skill'), /D_ID_PAYLOAD_CONFLICT/);
  await assert.rejects(a.admit(d, 'different-session', 'skill'), /D_SESSION_CONFLICT/);
});

test('a redeployed fixed skill resumes the durable D admission; another payload or an unproven D still conflicts', async t => {
  const f = await fixture(t); const d = await f.d('redeployed'); let a = f.admission();
  // The runtime publishes the first-writer D before admitting it.
  await f.storage.publish('processed-events', digest({principal_id: d.principal_id, processed_event_id: d.processed_event_id}), Buffer.from(canonical(d)));
  const first = await a.admit(d, 'session', 'skill v1');
  await until(() => f.native.logicalRuns === 1); f.native.finish('run-1');
  await until(async () => (await a.getAsync('owner', 'session', d.processed_event_id))?.state === 'completed');
  await a.close(); a = f.admission();
  const replay = await a.admit(d, 'session', 'skill v2');
  assert.deepEqual([replay.idempotency_key, replay.state, replay.run_id, f.native.creates], [first.idempotency_key, 'completed', 'run-1', 1]);
  await assert.rejects(a.admit({...d, content: {text: 'changed'}}, 'session', 'skill v2'), /D_ID_PAYLOAD_CONFLICT/);
  const unproven = await f.d('unproven'); await a.admit(unproven, 'session', 'skill v2');
  await assert.rejects(a.admit(unproven, 'session', 'skill v3'), /D_ID_PAYLOAD_CONFLICT/);
});

test('concurrent capacity check cannot cross await boundary; active runs consume bounded capacity', async t => {
  const f = await fixture(t, {max_pending_events: 1}); const a = f.admission();
  const results = await Promise.allSettled([a.admit(await f.d('one'), 's1', 'skill'),
    a.admit(await f.d('two'), 's2', 'skill')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await until(() => f.native.logicalRuns === 1); assert.equal(f.native.logicalRuns, 1);
});

test('repeated explicit 503 stays retryable and same D re-submission pumps without creating duplicate runs', async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d('busy'); f.native.busy = 2;
  await a.admit(d, 'session', 'skill');
  await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'retryable');
  await a.admit(d, 'session', 'skill');
  await until(() => f.native.creates === 2 && a.get('owner', 'session', d.processed_event_id)?.state === 'retryable');
  await a.admit(d, 'session', 'skill');
  await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'running');
  assert.equal(f.native.creates, 3); assert.equal(f.native.logicalRuns, 1);
});

test('cancel request keeps session barrier until authoritative terminal status; failed native is durable', async t => {
  const f = await fixture(t); const a = f.admission(); const first = await f.d('cancel'); const second = await f.d('later');
  await a.admit(first, 'session', 'skill');
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'running');
  await a.admit(second, 'session', 'skill'); await a.cancel('owner', 'session', first.processed_event_id);
  assert.equal(f.native.logicalRuns, 1);
  f.native.finish(a.get('owner', 'session', first.processed_event_id)!.run_id!, 'interrupted');
  await until(() => f.native.logicalRuns === 2);
  assert.equal((await a.getAsync('owner', 'session', first.processed_event_id))?.state, 'cancelled');
  await until(() => a.get('owner', 'session', second.processed_event_id)?.state === 'running');
  f.native.finish(a.get('owner', 'session', second.processed_event_id)!.run_id!, 'failed');
  await until(async () => (await a.getAsync('owner', 'session', second.processed_event_id))?.state === 'failed');
});

test('unknown attempt beyond native retention cannot issue another create or release barrier', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, {native_idempotency_retention_ms: 1}); let a = f.admission();
  const first = await f.d('expired-key'); const next = await f.d('next'); f.native.lost = true;
  await a.admit(first, 'session', 'skill');
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'reconcile_required');
  now += 2;
  await a.close(); a = f.admission();
  await a.admit(next, 'session', 'skill'); await a.reconcile('owner', 'session', first.processed_event_id);
  await until(() => a.get('owner', 'session', first.processed_event_id)?.retry_reason === 'uncertain_retention_expired');
  assert.equal(f.native.creates, 1); assert.equal(f.native.logicalRuns, 1);
  assert.equal((await a.getAsync('owner', 'session', first.processed_event_id))?.state, 'reconcile_required');
  assert.equal(a.get('owner', 'session', next.processed_event_id)?.state, 'pending');
});

test('recovery capacity rejects explicitly rather than dropping prior unresolved session barriers', async t => {
  const f = await fixture(t); const a = f.admission(); const first = await f.d('old-one'); const second = await f.d('old-two');
  await a.admit(first, 's1', 'skill'); await a.admit(second, 's2', 'skill');
  await until(() => f.native.logicalRuns === 2); await a.close();
  const smaller = f.track(new RunAdmission(f.storage, f.native, {...policy, max_pending_events: 1})); t.after(() => smaller.close());
  await assert.rejects(smaller.admit(await f.d('new'), 's3', 'skill'), /ADMISSION_RECOVERY_CAPACITY_EXCEEDED/);
  assert.equal(f.native.logicalRuns, 2);
});

test('durable payload fingerprint is checked during restore', async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d('integrity');
  await a.admit(d, 'session', 'skill'); await until(() => f.native.logicalRuns === 1); await a.close();
  const key = digest({principal_id: 'owner', session_id: 'session', processed_event_id: d.processed_event_id});
  const saved = JSON.parse(await fs.readFile(join(f.path, 'admission-inputs', key), 'utf8'));
  saved.d.content.text = 'tampered'; await fs.writeFile(join(f.path, 'admission-inputs', key), JSON.stringify(saved));
  const next = f.admission();
  await assert.rejects(next.getAsync('owner', 'session', d.processed_event_id), /ADMISSION_RECORD_INTEGRITY_FAILURE/);
});

test('terminal records are read on demand rather than accumulating in the live cache', async t => {
  const f = await fixture(t, {max_pending_events: 1}); const a = f.admission();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = await f.d(`terminal-${i}`); ids.push(d.processed_event_id);
    await a.admit(d, 'session', 'skill');
    await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'running');
    const runId = a.get('owner', 'session', d.processed_event_id)!.run_id!;
    f.native.finish(runId, i === 0 ? 'expired' : 'completed');
    await until(() => a.get('owner', 'session', d.processed_event_id) === undefined);
    assert.equal(a.find(runId, 'session'), undefined);
  }
  assert.deepEqual(await f.storage.list('admission-inputs'), []);
  assert.equal((await a.getAsync('owner', 'session', ids[0]!))?.state, 'expired');
  assert.equal((await a.getAsync('owner', 'session', ids[7]!))?.state, 'completed');
  const restarted = f.admission();
  assert.equal((await restarted.getAsync('owner', 'session', ids[7]!))?.state, 'completed');
});

test('pending D that aged behind a session barrier expires without issuing a native run', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, {max_event_age_ms: 200}); const a = f.admission();
  const first = await f.d('running-first'); const pending = await f.d('aged-pending');
  const states: string[] = [];a.setStateOwner(async entry=>{if(entry.d.processed_event_id===pending.processed_event_id)states.push(entry.record.state);});
  await a.admit(first, 'session', 'skill');
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'running');
  const admitted = await a.admit(pending, 'session', 'skill');
  assert.equal(admitted.deadline_ms - admitted.created_at_ms, 200);
  assert.equal(a.get('owner', 'session', pending.processed_event_id)?.state, 'pending');
  now += 220;
  f.native.finish(a.get('owner', 'session', first.processed_event_id)!.run_id!);
  await until(async () => (await a.getAsync('owner', 'session', pending.processed_event_id))?.state === 'expired');
  assert.equal(f.native.logicalRuns, 1);
  await until(()=>states.includes('expired'));
  const expired=await a.readOnly('owner','session',pending.processed_event_id);
  assert.equal(expired?.run_id,undefined);assert.equal(expired?.retry_reason,'deadline_exhausted');
});

test('a finished errand waiting behind its origin run longer than the request age still reaches the main agent', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, {max_event_age_ms: 200}); const a = f.admission();
  const origin = await f.d('compound-request');
  const errand = await new UnifiedIngress(new RawArchive(f.storage, 10000, () => '2026-10-01T00:00:00.000Z')).accept({schema_version: EVENT_SCHEMA,
    event_id: 'errand:job-b2d392414a03', device_id: 'mac', device_type: 'mac', captured_at: '2026-10-01T00:00:00.000Z',
    source: {channel: 'text'}, media_type: 'app_event', mime: 'application/json', representation: 'uploaded_original',
    payload: Buffer.from(JSON.stringify({kind: 'errand_result', job_id: 'job-b2d392414a03', task: '查香辣蟹', success: false,
      answer: 'APP_LOGIN_REQUIRED: 千问', finished_at: '2026-10-01T00:00:00.000Z'}))},
    {principal_id: 'owner', device_id: 'mac', device_type: 'mac', consent_ref: 'consent', channel: 'text', submission: 'errand_result'});
  await a.admit(origin, 'session', 'skill');
  await until(() => a.get('owner', 'session', origin.processed_event_id)?.state === 'running');
  const admitted = await a.admit(errand, 'session', 'skill');
  assert.equal(admitted.deadline_ms - admitted.created_at_ms, policy.native_idempotency_retention_ms);
  // Regression: the origin run kept the conversation 11 minutes after the errand finished (request age 10 minutes).
  now += 11 * 60_000;
  f.native.finish(a.get('owner', 'session', origin.processed_event_id)!.run_id!);
  await until(() => !!a.get('owner', 'session', errand.processed_event_id)?.run_id);
  assert.equal(f.native.logicalRuns, 2);
  assert.equal(a.get('owner', 'session', errand.processed_event_id)?.state, 'running');
});

function fence() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {entered: entered.promise, release: () => release.resolve(),
    block: async () => {entered.resolve(); await release.promise;}};
}

test('owner call work remains pending until terminal output delivery finishes', {timeout: 10000}, async t => {
  const f = await fixture(t), a = f.admission(), source = await f.d('call-output-delivery');
  const d: ProcessedEvent = {...source, media_type: 'app_event', origin: 'device_observation',
    processing: {...source.processing, path_id: 'direct_app'},
    content: {app_event: {kind: 'voice_turn', call_id: 'call-delivery', turn: 7, speaker: 'owner'}}};
  const output = fence(), running = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
  a.setTerminalOwner(async () => output.block());
  a.setStateOwner(async entry => {if (entry.record.state === 'running') running.resolve();});
  try {
    a.setWorkOwner(principal => {
      assert.equal(principal, 'owner');
      if (a.work(principal, true).length === 0) drained.resolve();
    });
    await a.admit(d, 'session', 'skill');
    await running.promise;
    f.native.finish(a.get('owner', 'session', d.processed_event_id)!.run_id!);
    await output.entered;
    assert.deepEqual(a.work('owner'), [], 'the UI projection excludes terminal execution');
    assert.deepEqual(a.work('owner', true), [{processed_event_id: d.processed_event_id,
      session_id: 'session', call_id: 'call-delivery', turn: 7, background: false}]);
    output.release();
    await drained.promise;
    assert.deepEqual(a.work('owner', true), [], 'delivery completion notifies the work owner after removal');
  } finally {output.release(); await a.close();}
});

for (const namespace of ['admissions', 'run-attempts', 'run-bindings', 'run-terminals']) {
  test(`close joins actual ${namespace} publication and restart preserves one logical run`, async t => {
    const f = await fixture(t); const d = await f.d(`closing-${namespace}`); const a = f.admission();
    const gate = fence(); const original = f.storage.publish.bind(f.storage);
    f.storage.publish = async (space, key, bytes) => {
      if (space === namespace) await gate.block();
      return original(space, key, bytes);
    };
    if (namespace === 'run-terminals') {
      const create = f.native.create.bind(f.native);
      f.native.create = async (...args) => {const run = await create(...args); f.native.finish(run.run_id); return run;};
    }
    const request = a.admit(d, 'session', 'skill');
    try {
      await gate.entered;
      let settled = false; const closing = a.close();
      assert.equal(a.close(), closing);
      void closing.then(() => {settled = true;});
      await Promise.resolve();
      assert.equal(settled, false, 'close must wait on blocked durable publication');
      await assert.rejects(a.admit(d, 'session', 'skill'), /ADMISSION_CLOSED/);
      await assert.rejects(a.reconcile('owner', 'session', d.processed_event_id), /ADMISSION_CLOSED/);
      gate.release(); await request; await closing;
      assert.equal(settled, true);
      if (namespace === 'admissions' || namespace === 'run-attempts') assert.equal(f.native.creates, 0);
      const recovered = f.admission();
      await recovered.admit(d, 'session', 'skill');
      if (namespace === 'run-attempts') await recovered.reconcile('owner', 'session', d.processed_event_id);
      await until(() => f.native.logicalRuns === 1);
      if (namespace === 'run-terminals') assert.equal((await recovered.getAsync('owner', 'session', d.processed_event_id))?.state, 'completed');
      assert.equal(f.native.logicalRuns, 1);
      await recovered.close();
      // POSIX cleanup is performed immediately after awaited close, without a timing allowance.
      await fs.rm(f.path, {recursive: true, force: true});
    } finally {gate.release();}
  });
}

for (const boundary of ['create', 'status'] as const) {
  test(`close joins in-flight native ${boundary} without cancelling or starting another native request`, async t => {
    const f = await fixture(t); const a = f.admission(); const d = await f.d(`native-close-${boundary}`);
    const gate = fence(); let statuses = 0; let cancels = 0;
    const create = f.native.create.bind(f.native); const status = f.native.status.bind(f.native);
    f.native.create = async (...args) => {const run = await create(...args); if (boundary === 'create') await gate.block(); return run;};
    f.native.status = async (...args) => {statuses++; if (boundary === 'status') await gate.block(); return status(...args);};
    f.native.cancel = async run => {cancels++; return status(run);};
    await a.admit(d, 'session', 'skill');
    try {
      await gate.entered;
      let settled = false; const closing = a.close(); void closing.then(() => {settled = true;});
      await Promise.resolve(); assert.equal(settled, false);
      gate.release(); await closing;
      assert.equal(cancels, 0); assert.equal(statuses, boundary === 'status' ? 1 : 0);
      const key = digest({principal_id: 'owner', session_id: 'session', processed_event_id: d.processed_event_id});
      const binding = JSON.parse(await fs.readFile(join(f.path, 'run-bindings', key), 'utf8'));
      assert.equal(binding.run_id, 'run-1');
      const recovered = f.admission(); await recovered.admit(d, 'session', 'skill');
      await until(() => recovered.get('owner', 'session', d.processed_event_id)?.state === 'running');
      assert.equal(f.native.logicalRuns, 1); assert.equal(f.native.creates, 1);
    } finally {gate.release();}
  });
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
const retry = {max_attempts: 3, initial_backoff_ms: 10, max_backoff_ms: 30};
async function httpFixture(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void, maximumBytes = 8192) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  return new HermesClient(`http://127.0.0.1:${(server.address() as {port: number}).port}`, 'x'.repeat(24), 3000, maximumBytes);
}
function refusal(res: ServerResponse, code = 'gateway_draining', status = 503, retryAfter = '0') {
  res.writeHead(status, {'Content-Type': 'application/json', 'Retry-After': retryAfter});
  res.end(JSON.stringify({error: {message: 'native refusal', type: 'server_error', code}}));
}
async function preserve(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const root = process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
  if (!root) return;
  assert.ok(isAbsolute(root), 'PAIOS_ADMISSION_EVIDENCE_ROOT must be an explicit absolute private directory');
  const dest = join(root, name);
  await fs.mkdir(dest, {recursive: true, mode: 0o700}); await fs.cp(f.path, dest, {recursive: true});
}

test('actual HTTP JSON errors distinguish native refusal, generic JSON, HTML, provider error and malformed JSON', async t => {
  let kind = 0;
  const client = await httpFixture(t, (_req, res) => {
    if (kind === 0) return refusal(res, 'gateway_draining', 503, '1');
    if (kind === 1) return refusal(res, 'rate_limit_exceeded', 429, '1');
    if (kind === 2) return refusal(res, 'provider_error');
    res.writeHead(503, {'Content-Type': kind === 3 ? 'text/html' : 'application/json'});res.end('<html>unknown</html>');
  });
  for (kind = 0; kind < 5; kind++) await assert.rejects(client.create({input: 'D', instructions: 'skill', session_id: 's'}, 'key'),
    e => kind < 2 ? e instanceof NativeNotAcceptedError && e.retryAfterMs === 1000 :
      e instanceof ContractError && !(e instanceof NativeNotAcceptedError));
});

test('HTTP BUSY then success preserves exact D body/key, duplicate submits do not bypass backoff, receipts persist on POSIX', async t => {
  const f = await fixture(t); const d = await f.d('http-busy'); let creates = 0; const seen: {key: string; body: string}[] = [];
  const client = await httpFixture(t, (req,res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));req.on('end', () => {
        seen.push({key: req.headers['idempotency-key'] as string, body: Buffer.concat(chunks).toString()});
        if (++creates < 3) return refusal(res, creates === 1 ? 'gateway_draining' : 'rate_limit_exceeded', creates === 1 ? 503 : 429);
        res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/isolated/native-fixture',granted_toolsets:['desktop','terminal','file'],run_id:'http-run',session_id:'transcript',conversation_session_id:'session',status:'running'}));
      });
    } else {res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/isolated/native-fixture',granted_toolsets:['desktop','terminal','file'],run_id:'http-run',session_id:'transcript',conversation_session_id:'session',status:'running'}));}
  });
  const a = f.track(new RunAdmission(f.storage, client, {...policy,native_retry:retry})); t.after(() => a.close());
  await a.admit(d,'session','skill');
  await until(() => a.get('owner','session',d.processed_event_id)?.state === 'retryable');
  await Promise.all(Array.from({length:20}, () => a.admit(d,'session','skill')));
  await until(() => a.get('owner','session',d.processed_event_id)?.state === 'running');
  assert.equal(creates,3);assert.equal(new Set(seen.map(x=>x.key)).size,1);assert.equal(new Set(seen.map(x=>x.body)).size,1);
  assert.equal((await f.storage.list('run-attempts')).length,3);assert.equal((await f.storage.list('run-attempt-results')).length,2);
  await a.close(); await preserve(f,'http-busy-success');
});

for (const constraint of ['attempts','deadline','retention'] as const) test(`known rejection bounded by ${constraint}; durable reason survives restart`, async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const settings = constraint === 'deadline' ? {max_event_age_ms:300} : constraint === 'retention' ? {native_idempotency_retention_ms:300} : {};
  const f = await fixture(t,{...settings,native_retry:{...retry,initial_backoff_ms:500,max_backoff_ms:500,max_attempts:1}});
  // Deadline/retention use a higher count so the time budget is the first exhausted constraint.
  const p = {...policy,...settings,native_retry:{...retry,initial_backoff_ms:500,max_backoff_ms:500,max_attempts: constraint==='attempts'?1:3}};
  const d=await f.d(`bound-${constraint}`); f.native.busy=100;
  let a=f.track(new RunAdmission(f.storage,f.native,p)); t.after(()=>a.close());
  (a as unknown as {pause(ms:number):Promise<void>}).pause=async ms=>{now+=ms;};
  await a.admit(d,'session','skill');
  const reason=constraint==='attempts'?'attempts_exhausted':constraint==='deadline'?'deadline_exhausted':'retention_exhausted';
  await until(async()=> (await a.getAsync('owner','session',d.processed_event_id))?.retry_reason===reason);
  assert.equal(f.native.creates,1);await a.close();await preserve(f,`bound-${constraint}`);
  a=f.track(new RunAdmission(f.storage,f.native,p));await a.getAsync('owner','session',d.processed_event_id);
  await until(async()=> (await a.getAsync('owner','session',d.processed_event_id))?.retry_reason===reason);
  await a.reconcile('owner','session',d.processed_event_id);assert.equal(f.native.creates,1);
});

test('generic uncertainty stays blocked; lost acceptance recovers under configured same-key budget', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  for (const mode of ['generic','lost']) {
    const f=await fixture(t,{native_retry:retry});const a=f.admission();const d=await f.d(mode);const next=await f.d(`${mode}-next`);
    const retryWake=fence(),settled=Promise.withResolvers<void>();let first=true;
    // Storage latency must not consume the retry/deadline budget; only the owner's requested backoff advances time.
    (a as unknown as {pause(ms:number|Promise<void>):Promise<void>}).pause=async ms=>{
      if(first){first=false;await retryWake.block();}if(typeof ms==='number')now+=ms;else await ms;
    };
    a.setStateOwner(async entry=>{
      if(entry.d.processed_event_id===d.processed_event_id&&(mode==='lost'?entry.record.state==='running':
        entry.record.state==='reconcile_required'&&entry.record.attempt_count===retry.max_attempts))settled.resolve();
    });
    if(mode==='lost')f.native.lost=true;else f.native.create=async()=>{f.native.creates++;throw new ContractError('HERMES_HTTP_503',503);};
    try{
      await a.admit(d,'session','skill');await retryWake.entered;
      assert.equal(a.get('owner','session',d.processed_event_id)?.state,'reconcile_required');
      await a.admit(next,'session','skill');retryWake.release();
      await settled.promise;
      assert.equal(f.native.creates,mode==='lost'?2:retry.max_attempts);assert.equal(f.native.logicalRuns,mode==='lost'?1:0);
      assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
    }finally{retryWake.release();await a.close();}
    await preserve(f,mode);
  }
});

test('earlier unknown acceptance remains unknown after draining refusal on reconciliation, deadline and restart', async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=await fixture(t,{native_retry:retry,max_event_age_ms:300});let a=f.admission();const d=await f.d('unknown-then-draining');const next=await f.d('blocked-next');
  const retryWake=fence();let firstPause=true;
  (a as unknown as {pause(ms:number):Promise<void>}).pause=async(ms)=>{if(firstPause){firstPause=false;await retryWake.block();}clock+=ms;};
  try {
    f.native.lost=true;await a.admit(d,'session','skill');await retryWake.entered;
    assert.equal(a.get('owner','session',d.processed_event_id)?.state,'reconcile_required');
    assert.equal(f.native.creates,1);assert.equal(f.native.logicalRuns,1);
    f.native.create=async()=>{f.native.creates++;throw new NativeNotAcceptedError('gateway_draining');};
    await a.reconcile('owner','session',d.processed_event_id);retryWake.release();
    await until(()=>a.get('owner','session',d.processed_event_id)?.retry_reason==='prior_acceptance_unknown');
    clock+=350;await a.close();await preserve(f,'prior-unknown-draining');a=f.admission();
    await a.admit(next,'session','skill');assert.equal((await a.getAsync('owner','session',d.processed_event_id))?.state,'reconcile_required');
    assert.ok(f.native.creates<=retry.max_attempts+1,'explicit reconciliation may add one serialized same-key replay; the deadline may stop retries earlier');assert.equal(f.native.logicalRuns,1);assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
  } finally {retryWake.release();await a.close();}
});

test('close immediately wakes Retry-After sleep; restart uses last complete refusal receipt', async t=>{
  const f=await fixture(t);const d=await f.d('sleep-close');const client=await httpFixture(t,(_req,res)=>refusal(res,'gateway_draining',503,'1'));
  const p={...policy,native_retry:retry};let a=f.track(new RunAdmission(f.storage,client,p));t.after(()=>a.close());await a.admit(d,'session','skill');
  await until(()=>a.get('owner','session',d.processed_event_id)?.state==='retryable');const began=Date.now();await a.close();assert.ok(Date.now()-began<300);
  await preserve(f,'close-retry-sleep');const native=new FakeNative();a=f.track(new RunAdmission(f.storage,native,p));await a.getAsync('owner','session',d.processed_event_id);
  await new Promise(r=>setTimeout(r,30));assert.equal(native.creates,0);await until(()=>native.creates===1);assert.equal(native.logicalRuns,1);
});

test('close aborts actual in-flight HTTP create, joins request, persists unknown and leaves no retry timer', async t=>{
  const f=await fixture(t);let received=false;let disconnected=false;
  const client=await httpFixture(t,(req,_res)=>{received=true;req.socket.on('close',()=>{disconnected=true;});});
  const d=await f.d('abort-http');const a=f.track(new RunAdmission(f.storage,client,{...policy,native_retry:retry}));await a.admit(d,'session','skill');
  await until(()=>received);const began=Date.now();await a.close();assert.ok(Date.now()-began<300);await until(()=>disconnected);
  const restarted=f.track(new RunAdmission(f.storage,new FakeNative(),{...policy,native_retry:retry}));t.after(()=>restarted.close());
  assert.equal((await restarted.getAsync('owner','session',d.processed_event_id))?.state,'reconcile_required');
  await preserve(f,'close-aborted-http');
});

test('strict retry config rejects invalid and freezes caller mutations',async t=>{
  const f=await fixture(t);for(const native_retry of [null,{}, {max_attempts:0,initial_backoff_ms:1,max_backoff_ms:1},
    {max_attempts:1,initial_backoff_ms:2,max_backoff_ms:1},{...retry,extra:1}])
    assert.throws(()=>f.track(new RunAdmission(f.storage,f.native,{...policy,native_retry} as AdmissionPolicy)));
  const supplied={...policy,native_retry:{...retry,max_attempts:1}};const a=f.track(new RunAdmission(f.storage,f.native,supplied));t.after(()=>a.close());
  supplied.native_retry.max_attempts=10;f.native.busy=100;const d=await f.d('frozen-policy');await a.admit(d,'session','skill');
  await until(async()=> (await a.getAsync('owner','session',d.processed_event_id))?.retry_reason==='attempts_exhausted');assert.equal(f.native.creates,1);
});

for(const boundary of ['run-attempt-results','second-attempt'] as const) test(`crash at ${boundary} preserves completed refusals and incomplete transport uncertainty`,async t=>{
  const f=await fixture(t,{native_retry:retry});const d=await f.d(`crash-${boundary}`);let a=f.admission();f.native.busy=10;
  const original=f.storage.publish.bind(f.storage);let attempts=0;let crashed=false;
  f.storage.publish=async(space,key,bytes)=>{
    if(space==='run-attempts')attempts++;
    if(!crashed && ((boundary==='run-attempt-results' && space==='run-attempt-results') ||
      (boundary==='second-attempt' && space==='run-attempts' && attempts===2))) {
      crashed=true;
      if(boundary==='second-attempt')await original(space,key,bytes);
      throw new Error('CRASH_INJECTION');
    }
    return original(space,key,bytes);
  };
  await a.admit(d,'session','skill');await until(()=>crashed && a.get('owner','session',d.processed_event_id)?.state==='reconcile_required');
  await a.close();f.storage.publish=original;await preserve(f,`crash-${boundary}`);a=f.admission();
  assert.equal((await a.getAsync('owner','session',d.processed_event_id))?.state,'reconcile_required');
  await until(()=>f.native.creates===(boundary==='second-attempt'?2:3));await new Promise(r=>setTimeout(r,40));
  assert.equal(f.native.creates,boundary==='second-attempt'?2:3);assert.equal(f.native.logicalRuns,0);
  const saved=await f.storage.list('run-attempts');assert.equal(saved.length,3);
  assert.equal((await a.readOnly('owner','session',d.processed_event_id))?.state,'reconcile_required');
});

test('session pending fairness and causal predecessor ordering preserve original arrival sequence',async t=>{
  const f=await fixture(t);const a=f.admission();const first=await f.d('fair-first');
  await a.admit(first,'session','skill');await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');
  const observation={...await f.d('fair-observation'),origin:'device_observation' as const,user_identity:'unknown'};
  const prompt=await f.d('fair-prompt');const obsRecord=await a.admit(observation,'session','skill');const promptRecord=await a.admit(prompt,'session','skill');
  assert.ok(obsRecord.arrival_seq<promptRecord.arrival_seq);
  f.native.finish(a.get('owner','session',first.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',prompt.processed_event_id)?.state==='running');
  assert.equal(a.get('owner','session',observation.processed_event_id)?.state,'pending');
  assert.equal(a.get('owner','session',prompt.processed_event_id)?.arrival_seq,promptRecord.arrival_seq);
  f.native.finish(a.get('owner','session',prompt.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',observation.processed_event_id)?.state==='running');
});

for(const mode of ['generic-json','html','disconnect'] as const) test(`actual HTTP ${mode} keeps uncertainty barrier while replaying original configured key`,async t=>{
  const f=await fixture(t);let calls=0;const client=await httpFixture(t,(req,res)=>{
    calls++;if(mode==='disconnect'){req.socket.destroy();return;}
    if(mode==='generic-json'){refusal(res,'provider_error');return;}
    res.writeHead(503,{'Content-Type':'text/html'});res.end('<html>unavailable</html>');
  });
  const a=f.track(new RunAdmission(f.storage,client,{...policy,native_retry:retry}));
  const d=await f.d(`http-${mode}`);const next=await f.d(`http-${mode}-next`);await a.admit(d,'session','skill');
  await until(()=>a.get('owner','session',d.processed_event_id)?.state==='reconcile_required');
  await a.admit(next,'session','skill');await until(()=>calls===retry.max_attempts);await new Promise(r=>setTimeout(r,40));assert.equal(calls,retry.max_attempts);
  assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');await a.close();await preserve(f,`http-${mode}`);
});

test('causal replacement waits for its earlier observation even when explicit prompt category is preferred',async t=>{
  const f=await fixture(t);const a=f.admission();const first=await f.d('causal-first');await a.admit(first,'session','skill');
  await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');
  const observation={...await f.d('causal-observation'),origin:'device_observation' as const,user_identity:'unknown'};
  const prompt={...await f.d('causal-replacement'),replaces_processed_event_id:observation.processed_event_id};
  await a.admit(observation,'session','skill');await a.admit(prompt,'session','skill');
  f.native.finish(a.get('owner','session',first.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',observation.processed_event_id)?.state==='running');
  assert.equal(a.get('owner','session',prompt.processed_event_id)?.state,'pending');
  f.native.finish(a.get('owner','session',observation.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',prompt.processed_event_id)?.state==='running');
});

for(const limit of ['attempts','retention'] as const)test(`known unaccepted ${limit} exhaustion terminates admission with null run and releases next D`, {timeout:15000}, async t=>{
 const f=await fixture(t);f.native.busy=1;const p={...policy,native_retry:{...retry,max_attempts:limit==='attempts'?1:3,initial_backoff_ms:500,max_backoff_ms:500},
   native_idempotency_retention_ms:limit==='retention'?300:86400000};
 const a=f.track(new RunAdmission(f.storage,f.native,p));const d=await f.d(`release-${limit}`);const next=await f.d(`release-${limit}-next`);
 const key=digest({principal_id:'owner',session_id:'session',processed_event_id:d.processed_event_id});
 const nextKey=digest({principal_id:'owner',session_id:'session',processed_event_id:next.processed_event_id});
 const nextRequest=Promise.withResolvers<{key:string;input:string;run:NativeRun}>();
 const nextBinding=Promise.withResolvers<{run_id:string;session_id:string}>();
 const delay=Number(process.env.PAIOS_ADMISSION_RELEASE_PUBLICATION_DELAY_MS ?? 0);
 assert.ok(Number.isSafeInteger(delay) && delay>=0 && delay<=5000,'invalid fixture publication delay');
 const create=f.native.create.bind(f.native),publish=f.storage.publish.bind(f.storage);
 let stage='registered',terminalDelayed=false;
 f.native.create=async(body,key)=>{
   const run=await create(body,key);
   if(key===`paios:${nextKey}`)nextRequest.resolve({key,input:body.input,run});
   return run;
 };
 f.storage.publish=async(namespace,objectKey,bytes)=>{
   if(namespace==='run-terminals' && objectKey===key && delay>0 && !terminalDelayed) {
     terminalDelayed=true;await new Promise(resolve=>setTimeout(resolve,delay));
   }
   const saved=await publish(namespace,objectKey,bytes);
   // Observe the real publication only after the immutable POSIX file and directory sync finish.
   if(namespace==='run-bindings' && objectKey===nextKey)nextBinding.resolve(JSON.parse(Buffer.from(saved).toString()));
   return saved;
 };
 let failure: Record<string,unknown> | undefined;
 const snapshot=(error:unknown)=>({stage,limit,delay,creates:f.native.creates,logicalRuns:f.native.logicalRuns,
   first:a.get('owner','session',d.processed_event_id),next:a.get('owner','session',next.processed_event_id),
   error:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error)});
 // Fixture owner joins work, then preserves failed facts, and only then removes its private storage.
 f.beforeCleanup(async()=>{
   if(!failure)return;
   await preserve(f,`release-${limit}-failed`);
   const root=process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
   if(root)await fs.writeFile(join(root,`release-${limit}-failed`,'failure.json'),JSON.stringify(failure,null,2));
 });
 const watchdog=()=>{const error=new Error('release test watchdog expired before durable next binding');
   failure=snapshot(error);nextBinding.reject(error);};
 t.signal.addEventListener('abort',watchdog,{once:true});
 try {
   await a.admit(d,'session','skill');await a.admit(next,'session','skill');stage='waiting-next-binding';
   const [created,binding]=await Promise.all([nextRequest.promise,nextBinding.promise]);stage='durable-next-binding';
   assert.equal(created.key,`paios:${nextKey}`);assert.equal(JSON.parse(created.input).processed_event_id,next.processed_event_id);
   assert.equal(binding.run_id,created.run.run_id);assert.equal(binding.session_id,'session');
   const ended=await a.getAsync('owner','session',d.processed_event_id);assert.equal(ended?.state,limit==='attempts'?'failed':'expired');
   assert.equal(ended?.run_id,undefined);assert.equal(ended?.retry_reason,`${limit}_exhausted`);assert.equal(f.native.creates,2);
   assert.equal(f.native.logicalRuns,1);
   const receipt=JSON.parse(await fs.readFile(join(f.path,'run-terminals',key),'utf8'));assert.equal(receipt.run_id,null);
   if(delay>0)assert.equal(terminalDelayed,true);
   await a.close();await preserve(f,`release-${limit}`);stage='restoring';
   const restored=f.track(new RunAdmission(f.storage,f.native,p));assert.equal((await restored.getAsync('owner','session',d.processed_event_id))?.state,ended?.state);
   const nextRecord=await restored.readOnly('owner','session',next.processed_event_id);assert.equal(nextRecord?.state,'accepted');
   assert.equal(nextRecord?.run_id,binding.run_id);assert.equal(f.native.creates,2);
 } catch(error) {
   failure=snapshot(error);t.diagnostic(JSON.stringify(failure));throw error;
 } finally {t.signal.removeEventListener('abort',watchdog);}
});

for (const boundary of ['deadline','retention','backoff'] as const) test(`retry eligibility rechecks deterministic early ${boundary} wake against durable receipt`, {timeout:10000}, async t=>{
 const f=await fixture(t);const realNow=Date.now.bind(Date);let clock=realNow();t.mock.method(Date,'now',()=>clock);
 const p={...policy,max_event_age_ms:boundary==='deadline'?300:8000,native_idempotency_retention_ms:boundary==='retention'?300:3000,
   native_retry:{max_attempts:3,initial_backoff_ms:boundary==='backoff'?1000:500,max_backoff_ms:1000}};
 const a=f.track(new RunAdmission(f.storage,f.native,p));const calls:{at_ms:number;wall_at_ms:number;key:string}[]=[];
 const create=f.native.create.bind(f.native);f.native.create=async(body,key)=>{calls.push({at_ms:clock,wall_at_ms:realNow(),key});return create(body,key);};
 const wakes:number[]=[];
 (a as unknown as {pause(ms:number):Promise<void>}).pause=async(ms)=>{clock+=wakes.length===0?Math.max(0,ms-1):ms;wakes.push(clock);};
 const settled=Promise.withResolvers<void>(),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(space,key,bytes)=>{const saved=await publish(space,key,bytes);if(space===(boundary==='backoff'?'run-bindings':'run-terminals'))settled.resolve();return saved;};
 const abort=()=>settled.reject(new Error('eligibility watchdog'));t.signal.addEventListener('abort',abort,{once:true});t.after(()=>t.signal.removeEventListener('abort',abort));
 f.beforeCleanup(async()=>{await preserve(f,`early-${boundary}`);const root=process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
   if(root)await fs.writeFile(join(root,`early-${boundary}`,'timestamps.json'),JSON.stringify({clock,wakes,calls},null,2));});
 f.native.busy=boundary==='backoff'?1:100;const d=await f.d(`early-${boundary}`);await a.admit(d,'session','skill');await settled.promise;
 const record=await a.readOnly('owner','session',d.processed_event_id);const key=digest({principal_id:'owner',session_id:'session',processed_event_id:d.processed_event_id});
 const rejection=JSON.parse(await fs.readFile(join(f.path,'run-attempt-results',key),'utf8'));
 assert.ok(wakes.length>=2,'early wake must not authorize a second create');
 if(boundary==='backoff') {assert.equal(calls.length,2);assert.ok(calls[1]!.at_ms>=rejection.next_at_ms);}
 else {assert.equal(calls.length,1);assert.equal(record?.state,'expired');assert.equal(record?.retry_reason,`${boundary}_exhausted`);}
 await a.close();
});

for(const boundary of ['first-deadline','known-retention','prior-unknown-deadline','unsent-terminal-crash','unsent-receipt-crash'] as const)
test(`slow durable preparation ${boundary} records local unsent without fabricating native refusal`,{timeout:10000},async t=>{
 const f=await fixture(t);const realNow=Date.now.bind(Date);let clock=realNow();t.mock.method(Date,'now',()=>clock);
 const p={...policy,max_event_age_ms:1000,native_idempotency_retention_ms:boundary==='known-retention'?300:10000,
   native_retry:{max_attempts:3,initial_backoff_ms:10,max_backoff_ms:10}};
 let a=f.track(new RunAdmission(f.storage,f.native,p));const d=await f.d(`slow-${boundary}`),next=await f.d(`slow-${boundary}-next`);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const publish=f.storage.publish.bind(f.storage);
 const crash=boundary.includes('crash');let prepares=0,crashed=false;const calls:{at_ms:number;wall_at_ms:number}[]=[];
 const create=f.native.create.bind(f.native);f.native.create=async(...args)=>{calls.push({at_ms:clock,wall_at_ms:realNow()});return create(...args);};
 (a as unknown as {pause(ms:number):Promise<void>}).pause=async(ms)=>{clock+=ms;};
 const second=boundary==='known-retention'||boundary==='prior-unknown-deadline';
 f.storage.publish=async(space,key,bytes)=>{
   if(space==='run-attempts') {const saved=await publish(space,key,bytes);if(++prepares===(second?2:1)){entered.resolve();await release.promise;}return saved;}
   if(crash&&!crashed&&space===(boundary==='unsent-terminal-crash'?'run-terminals':'run-attempt-results')) {crashed=true;throw new Error('CONTROLLED_UNSENT_PUBLICATION_CRASH');}
   return publish(space,key,bytes);
 };
 const done=Promise.withResolvers<void>();const ownerPublish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(...args)=>{try {const saved=await ownerPublish(...args);if(args[0]==='run-terminals')done.resolve();return saved;}catch(error){done.resolve();throw error;}};
 const abort=()=>{release.resolve();done.reject(new Error('slow preparation watchdog'));};t.signal.addEventListener('abort',abort,{once:true});t.after(()=>t.signal.removeEventListener('abort',abort));
 f.beforeCleanup(async()=>{release.resolve();await preserve(f,`slow-${boundary}`);const root=process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
   if(root)await fs.writeFile(join(root,`slow-${boundary}`,'timestamps.json'),JSON.stringify({clock,calls,prepares,crashed},null,2));});
 if(boundary==='known-retention')f.native.busy=1;
 if(boundary==='prior-unknown-deadline')f.native.lost=true;
 const initial=await a.admit(d,'session','skill');
 if(boundary==='prior-unknown-deadline') {await until(()=>a.get('owner','session',d.processed_event_id)?.state==='reconcile_required');await a.reconcile('owner','session',d.processed_event_id);}
 await entered.promise;clock=boundary==='known-retention'?initial.created_at_ms+301:initial.deadline_ms+1;release.resolve();
 if(boundary==='prior-unknown-deadline')await until(()=>['prior_acceptance_unknown','uncertain_deadline_exhausted'].includes(a.get('owner','session',d.processed_event_id)?.retry_reason??''));else await done.promise;
 await a.close();f.storage.publish=publish;
 assert.equal(calls.length,second?1:0,'a prepared marker crossing the boundary must not send');
 const results=await f.storage.list('run-attempt-results');const raw=await Promise.all(results.map(async key=>JSON.parse(new TextDecoder().decode(await f.storage.read('run-attempt-results',key)))));
 const unsent=raw.find(result=>'local_unsent_reason' in result);
 if(boundary==='unsent-receipt-crash')assert.equal(unsent,undefined);
 else {assert.equal(unsent?.local_unsent_reason,boundary==='known-retention'?'retention_exhausted':'deadline_exhausted');assert.equal(unsent?.code,undefined);assert.equal(unsent?.retry_after_ms,undefined);}
 const restoredTerminal=Promise.withResolvers<void>();
 if(boundary==='unsent-terminal-crash')f.storage.publish=async(...args)=>{const saved=await publish(...args);if(args[0]==='run-terminals')restoredTerminal.resolve();return saved;};
 a=f.track(new RunAdmission(f.storage,f.native,p));const restored=await a.getAsync('owner','session',d.processed_event_id);
 if(boundary==='unsent-terminal-crash')await restoredTerminal.promise;
 if(boundary==='prior-unknown-deadline'||boundary==='unsent-receipt-crash') {
   assert.equal(restored?.state,'reconcile_required');await a.admit(next,'session','skill');assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');assert.equal(calls.length,second?1:0);
 } else {const terminal=await a.readOnly('owner','session',d.processed_event_id);assert.equal(terminal?.state,'expired');assert.equal(terminal?.run_id,undefined);}
 await a.close();
});

test('disabled automatic retry manual reconciliation obeys actual HTTP Retry-After durable eligibility after restart',{timeout:10000},async t=>{
 const f=await fixture(t);const realNow=Date.now.bind(Date);let clock=realNow();t.mock.method(Date,'now',()=>clock);
 let posts=0;const requests:{at_ms:number;wall_at_ms:number;key:string}[]=[];
 const client=await httpFixture(t,(req,res)=>{
   if(req.method==='POST'&&++posts===1)return refusal(res,'gateway_draining',503,'1');
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/isolated/native-fixture',granted_toolsets:['desktop','terminal','file'],run_id:'manual-run',session_id:'transcript',conversation_session_id:'session',status:'running'}));
 });
 const native:NativeClient={create:async(body,key,signal)=>{requests.push({at_ms:clock,wall_at_ms:realNow(),key});return client.create(body,key,signal);},
   status:run=>client.status(run),cancel:run=>client.cancel(run)};
 const rejected=Promise.withResolvers<void>(),bound=Promise.withResolvers<void>();const publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(...args)=>{const saved=await publish(...args);if(args[0]==='run-attempt-results')rejected.resolve();if(args[0]==='run-bindings')bound.resolve();return saved;};
 const abort=()=>{rejected.reject(new Error('manual HTTP refusal watchdog'));bound.reject(new Error('manual HTTP binding watchdog'));};
 t.signal.addEventListener('abort',abort,{once:true});t.after(()=>t.signal.removeEventListener('abort',abort));
 const wakes:number[]=[];
 f.beforeCleanup(async()=>{await preserve(f,'disabled-manual-http');const root=process.env.PAIOS_ADMISSION_EVIDENCE_ROOT;
   if(root)await fs.writeFile(join(root,'disabled-manual-http','timestamps.json'),JSON.stringify({clock,wakes,requests,posts},null,2));});
 let a=f.track(new RunAdmission(f.storage,native,policy));const d=await f.d('manual-http-hint');await a.admit(d,'session','skill');await rejected.promise;await a.close();
 const key=digest({principal_id:'owner',session_id:'session',processed_event_id:d.processed_event_id});
 const receipt=JSON.parse(await fs.readFile(join(f.path,'run-attempt-results',key),'utf8'));assert.equal(receipt.retry_after_ms,1000);
 a=f.track(new RunAdmission(f.storage,native,policy));assert.equal((await a.getAsync('owner','session',d.processed_event_id))?.state,'retryable');
 assert.equal(requests.length,1,'disabled policy must not automatically retry restored refusal');
 (a as unknown as {pause(ms:number):Promise<void>}).pause=async(ms)=>{clock+=wakes.length===0?Math.max(0,ms-1):ms;wakes.push(clock);};
 await a.reconcile('owner','session',d.processed_event_id);await bound.promise;
 assert.ok(wakes.length>=2);assert.equal(posts,2);assert.equal(requests.length,2);assert.equal(requests[0]!.key,requests[1]!.key);
 assert.ok(requests[1]!.at_ms>=receipt.next_at_ms,'manual create cannot precede real native Retry-After eligibility');
 assert.equal((await a.readOnly('owner','session',d.processed_event_id))?.run_id,'manual-run');await a.close();
});

for (const shape of ['oversize-known-refusal','malformed-known-refusal'] as const)
test(`actual HTTP ${shape} stays unknown and cannot bypass the original session barrier`, async t => {
  const f=await fixture(t);const d=await f.d(shape),next=await f.d(`${shape}-next`);let creates=0;
  const client=await httpFixture(t,(req,res)=>{
    creates++;req.resume();res.writeHead(503,{'Content-Type':'application/json'});
    if(shape==='oversize-known-refusal'){res.write(JSON.stringify({error:{code:'gateway_draining'}}));res.end(' '.repeat(128));}
    else res.end('{"error":{"code":"gateway_draining"}');
  },64);
  const a=f.track(new RunAdmission(f.storage,client,policy));await a.admit(d,'session','skill');
  await until(()=>a.get('owner','session',d.processed_event_id)?.state==='reconcile_required');
  await a.admit(next,'session','skill');await a.close();
  assert.equal(creates,1);assert.equal(a.get('owner','session',d.processed_event_id)?.run_id,undefined);
  assert.equal(a.get('owner','session',next.processed_event_id)?.state,'pending');
  const attempts=await f.storage.list('run-attempts');assert.equal(attempts.length,1);
  const attempt=JSON.parse(Buffer.from(await f.storage.read('run-attempts',attempts[0]!)).toString());
  assert.equal(attempt.idempotency_key,a.get('owner','session',d.processed_event_id)?.idempotency_key);
  assert.equal((await f.storage.list('run-attempt-results')).length,0);
  const reopened=f.track(new RunAdmission(f.storage,client,policy));
  const restored=await reopened.getAsync('owner','session',d.processed_event_id);
  assert.equal(restored?.state,'reconcile_required');assert.equal(restored?.retry_reason,'acceptance_unknown');
  assert.equal(creates,1);await reopened.close();
});

test('native binding order follows original explicit priority, survives lost response/restart and excludes legacy order',async t=>{
  const f=await fixture(t);let a=f.admission();const first=await f.d('order-first');
  await a.admit(first,'session','skill');await until(()=>a.get('owner','session',first.processed_event_id)?.state==='running');
  const observation={...await f.d('order-observation'),origin:'device_observation' as const,user_identity:'unknown'};
  const explicit=await f.d('order-explicit');const earlier=await a.admit(observation,'session','skill');const later=await a.admit(explicit,'session','skill');
  assert.ok(earlier.arrival_seq<later.arrival_seq);
  f.native.finish(a.get('owner','session',first.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',explicit.processed_event_id)?.state==='running');
  const explicitOrder=a.get('owner','session',explicit.processed_event_id)!.run_order!;
  assert.equal(a.get('owner','session',observation.processed_event_id)?.state,'pending');
  f.native.finish(a.get('owner','session',explicit.processed_event_id)!.run_id!);
  await until(()=>a.get('owner','session',observation.processed_event_id)?.state==='running');
  const observationOrder=a.get('owner','session',observation.processed_event_id)!.run_order!;
  assert.ok(observationOrder>explicitOrder,'binding order must differ from arrival priority');
  await a.close();a=f.admission();await a.recover();
  assert.equal((await a.getAsync('owner','session',observation.processed_event_id))?.run_order,observationOrder);
  f.native.finish(a.get('owner','session',observation.processed_event_id)!.run_id!);
  await until(async()=> (await a.readOnly('owner','session',observation.processed_event_id))?.state==='completed');
  await a.close();a=f.admission();f.native.lost=true;const lost=await f.d('order-lost');await a.admit(lost,'session','skill');
  await until(()=>a.get('owner','session',lost.processed_event_id)?.state==='reconcile_required');await a.close();a=f.admission();
  await a.recover();await a.reconcile('owner','session',lost.processed_event_id);
  await until(()=>a.get('owner','session',lost.processed_event_id)?.state==='running');
  const recoveredOrder=a.get('owner','session',lost.processed_event_id)!.run_order!;assert.ok(recoveredOrder>observationOrder);
  await a.reconcile('owner','session',lost.processed_event_id);assert.equal(a.get('owner','session',lost.processed_event_id)?.run_order,recoveredOrder);
  await a.close();const key=digest({principal_id:'owner',session_id:'session',processed_event_id:lost.processed_event_id});
  const legacy=JSON.parse(await fs.readFile(join(f.path,'run-bindings',key),'utf8'));delete legacy.run_order;
  await fs.writeFile(join(f.path,'run-bindings',key),JSON.stringify(legacy));a=f.admission();await a.recover();
  assert.equal(a.get('owner','session',lost.processed_event_id)?.run_order,undefined,'legacy binding cannot claim a guessed order');
});
