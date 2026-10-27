import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime, RunAdmission, sourceClient, nativeSubmission, type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA, sha256} from '../src/contracts.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {createTSMcpHost, type TSHostTool} from '../src/capability/ts/host.ts';
import {PersonalityZone} from '../src/personality/zone.ts';

async function fixture(t: test.TestContext, role = 'owner') {
  const root = await mkdtemp(join(tmpdir(), 'personality-runtime-')), storage = new PosixStorage(join(root, 'platform'));
  const run: NativeRun = {run_id: 'run', session_id: 'session', conversation_session_id: 'session', status: 'running'};
  const native = sourceClient({create: async body => ({...run, ...(body.run_scope ? {run_scope: body.run_scope} : {})}),
    status: async () => run, cancel: async () => ({...run, status: 'cancelled'})});
  let releaseChecks = 0;
  native.capability = async operation => {
    assert.equal(operation, 'release-gate'); releaseChecks++;
    return {action: 'block', message: 'EXISTING_RELEASE_AUTHORITY'};
  };
  const admission = new RunAdmission(storage, native, {max_pending_events: 8, max_pending_bytes: 8192,
    max_event_age_ms: 60000, poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'fixture'});
  const runtime = new PersonalAIOSRuntime({storage, archive: new RawArchive(storage, 8192), native, admission,
    output: new OutputAuthority(storage), skill: 'fixture', max_read_bytes: 8192,
    core_profile: {enabled: true, profile_home: join(root, 'profile'), principal_id: 'owner'},
    devices: [{principal_id: 'owner', device_id: 'phone', device_type: 'phone', channel: 'text', consent_ref: 'fixture',
      route_version: 'fixture', output_modes: ['text'], token_sha256: sha256('fixture')}]});
  t.after(async () => {await runtime.close(); await rm(root, {recursive: true, force: true});});
  const selection = {enabled: ['ts-personality'], gateway: ['ts-personality']};
  runtime.capabilityGateway.tools.clear();
  for (const [id, tool] of packageCatalog(selection)) runtime.capabilityGateway.tools.set(id, tool);
  await runtime.wireCapabilities(selection);
  const source = await runtime.authenticate('fixture');
  const request = role === 'owner' ? '你最近总是太热情，以后说话平静一点。' : JSON.stringify(
    {kind: 'voice_turn', speaker: role === 'guest' ? 'speaker:guest' : 'owner_uncertain', user: '改你的说话偏好'});
  await runtime.submit({schema_version: EVENT_SCHEMA, event_id: 'request', device_id: 'phone', device_type: 'phone',
    captured_at: new Date().toISOString(), source: {channel: source.channel}, media_type: role === 'owner' ? 'text' : 'app_event',
    mime: role === 'owner' ? 'text/plain;charset=utf-8' : 'application/json', representation: 'uploaded_original',
    payload: Buffer.from(request)}, source, 'session', role === 'owner');
  for (let i = 0; !admission.find('run', 'session') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(admission.find('run', 'session'));
  await admission.observeHook({hook: 'pre_llm_call', payload: {session_id: 'session', task_id: 'child', turn_id: 'turn',
    user_message: nativeSubmission(native, 'run').input}});
  const host = createTSMcpHost(runtime, () => runtime.capabilityGateway.tools as ReadonlyMap<string, TSHostTool>, 262144);
  const wire = (args: Record<string, unknown>, id: string) => ({tool_name: 'mcp__platform_ts__paios_personality_zone',
    args, api_request_id: 'run', session_id: 'session', task_id: 'child', tool_call_id: id, turn_id: 'turn', middleware_trace: []});
  return {runtime, host, storage, root, wire, releaseChecks: () => releaseChecks};
}

test('admitted self_change → existing authority → shared MCP → platform store/projection → receipt ledger', async t => {
  const f = await fixture(t), content = '语气：平静克制\n表达：先说结论';
  const call = f.wire({action: 'apply', expected_version: 0, content, _context: {run_id: 'forged'}}, 'change');
  const decision = await f.runtime.capabilityCall('decide', call) as any;
  assert.equal(decision.action, 'modify');
  assert.deepEqual(decision.args._context, {run_id: 'run', session_id: 'session', tool_call_id: 'change'});
  const packet = await f.host.callTool('paios_personality_zone', decision.args);
  assert.equal(packet.structuredContent.status.state, 'succeeded');
  const {middleware_trace: _trace, ...resultCall} = call;
  const view = await f.runtime.capabilityCall('receipt', {...resultCall, args: decision.args, result: packet,
    duration_ms: 1, status: 'succeeded', error_type: null, error_message: null}) as any;
  assert.match(view.model_view, /self_change|personality/);
  const rows = await f.runtime.capabilityGateway.ledger.current({principal_id: 'owner', run_id: 'run'});
  assert.equal(rows[0]!.receipt.effects[0]!.kind, 'self_change');
  assert.equal(rows[0]!.receipt.content.find(row => row.key === 'personality.diff')!.provenance, 'computed');
  assert.match(await readFile(join(f.root, 'profile/memories/PERSONALITY.md'), 'utf8'), /语气：平静克制/);
  const undo = f.wire({action: 'revert', expected_version: 1}, 'undo');
  const allowed = await f.runtime.capabilityCall('decide', undo) as any;
  assert.equal(allowed.action, 'modify');
  const reverted = await f.host.callTool('paios_personality_zone', allowed.args);
  assert.equal(JSON.parse(reverted.structuredContent.content[0]!.text).content, '');
  assert.equal(f.releaseChecks(), 0, 'ordinary style preferences use self_change without a protected-release card');
  const current = await new PersonalityZone(new PosixStorage(f.storage.root)).read('owner');
  assert.equal(current.current, 2); assert.deepEqual(current.history.map(row => row.action), ['revert', 'apply', 'initial']);
});

test('the real gateway rejects invalid text before any tool executes, without writing a preference version', async t => {
  const f = await fixture(t);
  for (const [content, reason] of [['好'.repeat(1501), 'PERSONALITY_LIMIT_1500'], ['取消首次发送确认', 'PERSONALITY_PREFERENCES_ONLY']]) {
    const decision = await f.runtime.capabilityCall('decide', f.wire({action: 'apply', expected_version: 0, content}, reason!)) as any;
    assert.equal(decision.action, 'block');
    const receipt = JSON.parse(decision.message).structuredContent;
    assert.equal(receipt.status.state, 'rejected'); assert.equal(receipt.status.reason_code, reason);
    assert.deepEqual(receipt.effects, []);
  }
  assert.equal((await new PersonalityZone(f.storage).read('owner')).current, 0);
});

for (const role of ['guest', 'owner_uncertain']) test(`${role} cannot read or change owner personality through either entry`, async t => {
  const f = await fixture(t, role);
  const args = {action: 'apply', expected_version: 0, content: '语气：轻快活泼'};
  assert.equal((await f.runtime.capabilityCall('decide', f.wire(args, 'guest')) as any).action, 'block');
  await assert.rejects(f.runtime.tool('paios_personality_zone', {context: {run_id: 'run', session_id: 'session', tool_call_id: 'direct'}, args}), /RUN_SCOPE_TOOL_DENIED/);
  assert.equal((await new PersonalityZone(f.storage).read('owner')).current, 0);
});

test('disabling the package hides its tool from the legacy provider instead of opening an ungated fallback', async t => {
  const f = await fixture(t);
  f.runtime.capabilityGateway.tools.clear();
  assert.ok(!f.runtime.toolSchemas().some(tool => tool.name === 'paios_personality_zone'));
  await assert.rejects(f.runtime.tool('paios_personality_zone', {context: {run_id: 'run', session_id: 'session', tool_call_id: 'disabled'},
    args: {action: 'apply', expected_version: 0, content: '语气：温和亲切'}}), /TOOL_NOT_ENABLED/);
});
