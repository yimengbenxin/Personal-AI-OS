import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import AjvModule from 'ajv/dist/2020.js';
import Ajv7Module from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {createTSMcpHost} from '../src/capability/ts/host.ts';
import {failure, type ResultAdapter} from '../../../../../capability/packages/ts-host/result.ts';
import {resultFacts} from '../../../../../capability/sdk/ts/result-values.ts';
import {admitReceipt} from '../src/capability/receipt.ts';
import {PersonalAIOSRuntime, RunAdmission, type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA, sha256, ContractError} from '../src/contracts.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {policy} from './sealed-replay-check.ts';
import {packageNames, packagesRoot, manifest, cases, catalogStub, gatewayContextStub} from './ts-packages-fixture.ts';

const allSchemas = () => enabledToolSchemas({memory: true, actions: true, ambient: true, visual: true, voiceprint: true,
  health: true, contacts: true, places: true, movement: true, desktop_queue: true, model_settings: true});
const catalog = catalogStub(), now = '2026-10-24T12:00:00.000Z';
const contracts = new URL('../../../../../capability/contracts/', import.meta.url);
const ajv = new AjvModule.default({strict: true});
ajv.addFormat('date-time', value => Number.isFinite(Date.parse(value)));
const validator = (file: string) => ajv.compile(JSON.parse(readFileSync(new URL(file, contracts), 'utf8')));
const pluginValid = validator('upstream/plugin-1.0.0.schema.json'), manifestValid = validator('manifest.v1.schema.json');
const receiptValid = validator('receipt.v1.schema.json');

test('one manifest entry per TS tool, excluding payment, with one shared HTTP host and no new effect parameter', () => {
  const names = [...catalog.values()].map(tool => tool.name);
  assert.equal(names.length, 31); assert.equal(new Set(names).size, 31);
  assert.deepEqual([...names].sort(), allSchemas().map(tool => tool.name).filter(name => !['paios_payment', 'paios_glasses_pay'].includes(name)).sort());
  assert.ok([...catalog.values()].every(tool => tool.server === 'platform_ts'));
  for (const schema of allSchemas()) assert.equal('effect' in schema.parameters.properties, false);
});

for (const name of packageNames) {
  test(`${name}: fixed schemas, HTTP declaration, skill and real adapter exist`, async () => {
    const plugin = manifest(name), extension = plugin.extensions['ai.yimi.capability'];
    assert.equal(pluginValid(plugin), true, ajv.errorsText(pluginValid.errors));
    assert.equal(manifestValid(extension), true, ajv.errorsText(manifestValid.errors));
    assert.equal(extension.runtime.host, 'shared'); assert.equal(extension.runtime.lazy, true);
    assert.equal(extension.runtime.idle_timeout_seconds, 900);
    const mcp = JSON.parse(readFileSync(new URL(`${name}/mcp.json`, packagesRoot), 'utf8'));
    assert.equal(mcp.mcpServers.platform_ts.url, 'http://127.0.0.1:18661/internal/capability/mcp');
    assert.match(readFileSync(new URL(`${name}/skills/${name}/SKILL.md`, packagesRoot), 'utf8'), /description:/u);
    const {mapResult} = await import(new URL(`${name}/server/index.ts`, packagesRoot).href);
    assert.equal(typeof mapResult, 'function');
  });
  for (const sample of cases(name)) test(`${name}: contract ${sample.id}`, async () => {
    const {mapResult}: {mapResult: ResultAdapter} = await import(new URL(`${name}/server/index.ts`, packagesRoot).href);
    const policy = catalog.get(`mcp__platform_ts__${sample.tool}`)!;
    const input = {name: sample.tool, args: sample.args, result: sample.raw, policy, now};
    const receipt = mapResult(input);
    assert.equal(receipt.status.state, sample.expected.state);
    assert.equal(receiptValid(receipt), true, ajv.errorsText(receiptValid.errors));
    assert.deepEqual(admitReceipt(receipt), receipt, 'package must already honor receipt invariants');
    assert.deepEqual(JSON.parse(receipt.content[0]!.text), sample.raw, 'business data must remain lossless');
    assert.notEqual(receipt.status.state, 'rejected');
    if (['waiting', 'unknown', 'failed'].includes(receipt.status.state)) {
      if (sample.tool === 'paios_l3_commit' || sample.tool === 'paios_model_settings_draft') assert.deepEqual(receipt.effects, []);
    }
    if (receipt.status.state === 'unknown') {
      assert.equal(receipt.next.retry, 'after_check'); assert.equal(receipt.next.check_with, policy.check_with);
    }
    const host = createTSMcpHost({toolSchemas: allSchemas, tool: async () => sample.raw}, () => catalog, 262144);
    const call = gatewayContextStub({run_id: 'run', session_id: 'session', tool_call_id: 'call'}, sample.args);
    const wire = new Ajv7Module.default({strict: false, validateFormats: false}).compile(host.tools().find(tool => tool.name === sample.tool)!.inputSchema);
    assert.equal(wire(call), true, JSON.stringify(wire.errors));
    const actual = await host.callTool(sample.tool, call);
    assert.equal(actual.structuredContent.status.state, sample.expected.state, actual.content[0]!.text);
    assert.equal(actual.content.length, 1);
    assert.equal(receiptValid(actual.structuredContent), true, ajv.errorsText(receiptValid.errors));
  });
  test(`${name}: fake runs over actual stdio MCP and shares the real adapter`, async () => {
    const transport = new StdioClientTransport({command: process.execPath, args: [fileURLToPath(new URL('./ts-fake-server.ts',import.meta.url)),fileURLToPath(new URL(`${name}/`,packagesRoot))],
      env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)), stderr: 'pipe'});
    let stderr = ''; transport.stderr?.on('data', bytes => {stderr += String(bytes);});
    const client = new Client({name: 'ts-contract-test', version: '1'});
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), Object.keys(manifest(name).extensions['ai.yimi.capability'].tools).sort());
      for (const sample of cases(name)) {
        const reply = await client.callTool({name: sample.tool, arguments: sample.args});
        assert.equal(reply.isError, undefined, JSON.stringify(reply));
        assert.equal((reply.structuredContent as any).status.state, sample.expected.state);
        assert.equal(receiptValid(reply.structuredContent), true);
      }
    } finally {await client.close();}
    assert.doesNotMatch(stderr, /Traceback|Error:/u);
  });
}

test('unknown shapes, package refusals, disconnects and timeouts never become successful or gateway rejections', async () => {
  for (const tool of catalog.values()) {
    const {mapResult}: {mapResult: ResultAdapter} = await import(new URL(`${tool.package}/server/index.ts`, packagesRoot).href);
    const input = {name: tool.name, args: {}, result: {}, policy: tool, now};
    if (tool.name !== 'paios_avatar') assert.equal(mapResult(input).status.state, 'unknown', tool.name);
    const denied = mapResult({...input, result: {status: 'rejected', error_code: 'RUN_SCOPE_TOOL_DENIED'}});
    assert.equal(denied.status.state, 'failed'); assert.deepEqual(denied.effects, []);
    for (const code of ['TERMINAL_TOOL_TIMEOUT', 'ECONNRESET', 'TRANSPORT_DISCONNECTED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET']) {
      const uncertain = mapResult({...input, result: {status: 'failed', error_code: code}});
      assert.equal(uncertain.status.state, 'unknown', tool.name); assert.equal(uncertain.next.retry, 'after_check');
      assert.ok(uncertain.next.check_with); assert.deepEqual(uncertain.effects, []);
    }
    assert.equal(failure(input, new ContractError('UPSTREAM_TIMEOUT', 504)).status.state, 'unknown');
    assert.equal(failure(input, {status: 'failed', http_status: 504, error_code: 'UPSTREAM_ERROR'}).status.state, 'unknown');
  }
});

test('units, provenance and observation time preserve exact sensor and computed numbers', async () => {
  const host = createTSMcpHost({toolSchemas: allSchemas, tool: async name => cases(name === 'paios_senses' ? 'ts-location' : 'ts-health').find(row => row.tool === name)!.raw}, () => catalog, 262144);
  const context = {_context: {run_id: 'run', session_id: 'session', tool_call_id: 'call'}};
  const hr = await host.callTool('paios_senses', {...context, sense: 'heart_rate'});
  assert.deepEqual(hr.structuredContent.values.find(value => value.key === 'value'), {key: 'value', value: 72, unit: 'count/min', provenance: 'observed', source: 'HealthKit', as_of: now});
  const query = await host.callTool('paios_health_query', {...context, metric: 'heart_rate', aggregation: 'sample'});
  const details=JSON.parse(query.structuredContent.content[0]!.text);
  assert.equal(query.structuredContent.values.find(value=>value.key==='samples')!.value,details.samples.length);
  const sample = resultFacts(details,now,'fixture',false).values.find(value => value.key === 'samples[0].value')!;
  assert.equal(sample.unit, 'count/min'); assert.equal(sample.source, 'HealthKit');
  assert.equal(sample.as_of, new Date(1792843200000).toISOString());
  const overview = createTSMcpHost({toolSchemas: allSchemas, tool: async () => cases('ts-health').find(row => row.id === 'overview-computed-trend')!.raw}, () => catalog, 262144);
  const facts = (await overview.callTool('paios_health_query', {...context, metric: 'overview'})).structuredContent.values;
  for (const field of ['avg_7d', 'delta_from_7d_avg', 'observed_days'])
    assert.equal(facts.find(value => value.key === `resting_heart_rate.${field}`)!.provenance, 'computed');
  assert.equal(facts.find(value => value.key === 'resting_heart_rate.avg_7d')!.unit, 'count/min');
  assert.equal(facts.find(value => value.key === 'resting_heart_rate.latest')!.provenance, 'observed');
});

test('wire context and arguments are validated before runtime; gateway context replaces forged model keys', async () => {
  const called: unknown[] = [];
  const host = createTSMcpHost({toolSchemas: allSchemas, tool: async (_, call) => {called.push(call); return {items: []};}}, () => catalog, 262144);
  const args = {action: 'list', _context: {run_id: 'forged'}};
  const denied = await host.callTool('paios_desktop_queue', args);
  assert.equal(denied.structuredContent.status.reason_code, 'TOOL_CONTEXT_REQUIRED'); assert.deepEqual(called, []);
  const trusted = {run_id: 'bound', session_id: 'session', tool_call_id: 'call'};
  const ok = await host.callTool('paios_desktop_queue', gatewayContextStub(trusted, args));
  assert.equal(ok.structuredContent.status.state, 'succeeded');
  assert.deepEqual(called, [{context: trusted, args: {action: 'list'}}]);
  const bad = await host.callTool('paios_desktop_queue', gatewayContextStub(trusted, {action: 'list', effect: 'observe'}));
  assert.equal(bad.structuredContent.status.reason_code, 'CAPABILITY_TOOL_ARGUMENT_INVALID'); assert.equal(called.length, 1);
});

test('model usage keeps currency, token units, estimate provenance and unknown costs', async () => {
  const host = createTSMcpHost({toolSchemas: allSchemas, tool: async () => ({revision: 1, usage: {known_cny: 0.123456,
    subscription_remaining: '套餐余量未知'}, attempts: [{attempt_id: 'estimated', captured_at: now, input_tokens: 17,
    cost: {kind: 'estimated', currency: 'CNY', amount: 0.012345}}, {attempt_id: 'unknown', cost: {kind: 'unknown', currency: 'CNY', amount: null}}]})}, () => catalog, 262144);
  const {structuredContent: body} = await host.callTool('paios_model_settings_read', gatewayContextStub({run_id: 'run', session_id: 'session', tool_call_id: 'call'}, {}));
  assert.equal(body.values.find(row => row.key === 'usage.known_cny')!.unit, 'CNY');
  assert.equal(body.values.find(row=>row.key==='attempts')!.value,2);
  const details=resultFacts(JSON.parse(body.content[0]!.text),now,'fixture',false).values;
  const cost = details.find(row => row.key === 'attempts[0].cost.amount')!;
  assert.equal(cost.unit, 'CNY'); assert.equal(cost.value, 0.012345); assert.equal(cost.provenance, 'computed'); assert.equal(cost.as_of, now);
  assert.equal(details.find(row => row.key === 'attempts[0].input_tokens')!.unit, 'token');
  assert.deepEqual(body.unknowns.map(row => row.about), ['attempts','套餐余量', '费用:unknown']);
});

async function runtimeFixture(t: test.TestContext, scope = 'owner') {
  const folder = await mkdtemp(join(tmpdir(), 'ts-packages-')), storage = new PosixStorage(folder);
  const accepted = Promise.withResolvers<void>();
  const run: NativeRun = {run_id: 'run', session_id: scope === 'care' ? 'paios-care-run' : 'session',
    conversation_session_id: 'session', status: 'running'};
  const native = {create: async (body: {run_scope?: 'owner_uncertain' | 'guest' | 'build'}) => {
    if (body.run_scope) Object.assign(run, {run_scope: body.run_scope, session_id: `isolated-${scope}`});
    accepted.resolve(); return run;}, status: async () => run, cancel: async () => ({...run, status: 'cancelled'})};
  const admission = new RunAdmission(storage, native, policy);
  const runtime = new PersonalAIOSRuntime({storage, archive: new RawArchive(storage, 8192), admission, native,
    output: new OutputAuthority(storage), devices: [{principal_id: 'owner', device_id: 'phone', device_type: 'phone', channel: scope === 'cron' ? 'background_scheduled' : 'text',
      consent_ref: 'fixture', route_version: 'fixture', output_modes: ['text'], token_sha256: sha256('fixture')}], skill: 'fixture', max_read_bytes: 8192});
  t.after(async () => {await runtime.close(); await rm(folder, {recursive: true, force: true});});
  const source = await runtime.authenticate('fixture');
  const app = scope === 'care' ? {kind: 'proactive_care', care_id: 'care', signal: {type: 'sound', summary: 'fixture'}, recent: []} :
    ['guest', 'owner_uncertain'].includes(scope) ? {kind: 'voice_turn', speaker: scope === 'guest' ? 'speaker:guest' : 'owner_uncertain', user: '读取记录'} :
      {kind: scope === 'cron' ? 'scheduled_task' : 'source_observation', prompt: '读取记录'};
  await runtime.submit({schema_version: EVENT_SCHEMA, event_id: 'request', device_id: 'phone', device_type: 'phone',
    captured_at: new Date().toISOString(), source: {channel: source.channel}, media_type: scope === 'owner' ? 'text' : 'app_event',
    mime: scope === 'owner' ? 'text/plain;charset=utf-8' : 'application/json', representation: 'uploaded_original',
    payload: Buffer.from(scope === 'owner' ? '读取我的记录' : JSON.stringify(app))}, source, 'session', scope === 'owner');
  await accepted.promise;
  // The source callback resolves before admission finishes recording its native binding.
  for (let n = 0; !admission.find('run', 'session') && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(admission.find('run', 'session'));
  return {runtime, admission};
}

for (const scope of ['owner', 'guest', 'owner_uncertain', 'care', 'background', 'cron']) test(`all 31 tools: actual runtime admission equivalence in ${scope}`, async t => {
  const {runtime} = await runtimeFixture(t, scope);
  const host = createTSMcpHost({toolSchemas: allSchemas, tool: runtime.tool.bind(runtime)}, () => catalog, 262144);
  let count = 0;
  const decisions: object[] = [];
  for (const tool of catalog.values()) {
    const sample = cases(tool.package).find(row => row.tool === tool.name)!;
    const context = {run_id: 'run', session_id: 'session', tool_call_id: `equivalence-${++count}`};
    let legacy: any, error: any;
    try {legacy = await runtime.tool(tool.name, {context, args: structuredClone(sample.args)});} catch (caught) {error = caught;}
    const packet = await host.callTool(tool.name, gatewayContextStub(context, structuredClone(sample.args)));
    const receipt = packet.structuredContent;
    if (error || legacy?.error_code) assert.equal(receipt.status.reason_code, error?.code ?? legacy.error_code ?? 'PLATFORM_TOOL_ERROR', tool.name);
    else assert.deepEqual(JSON.parse(receipt.content[0]!.text), legacy, tool.name);
    decisions.push({tool: tool.name, legacy: error?.code ?? legacy?.error_code ?? 'returned', receipt: receipt.status.state,
      reason: receipt.status.reason_code ?? null});
    assert.equal(receiptValid(receipt), true, `${tool.name}: ${ajv.errorsText(receiptValid.errors)}`);
  }
  assert.equal(count, 31);
  if (['guest', 'owner_uncertain', 'care'].includes(scope)) assert.ok(decisions.some(row =>
    (row as {legacy: string}).legacy === 'RUN_SCOPE_TOOL_DENIED'), 'the intended admission scope must reach its real gate');
  t.diagnostic(JSON.stringify({scope, decisions}));
});

test('real HTTP MCP shares runtime, preserves the central contract, rolls back by family, and requires internal auth', async t => {
  const {runtime} = await runtimeFixture(t);
  let current = catalogStub(['ts-memory', 'ts-delivery']);
  const server = createPersonalAIOSServer(runtime, {internal_token: 'fixture-internal-key-abcdefghijklmn', max_request_bytes: 262144,
    request_timeout_ms: 10000, capability_catalog: () => current});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAndDrain());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/internal/capability/mcp`, {method: 'POST', body: '{}'})).status, 401);
  const headers = {Authorization: 'Bearer fixture-internal-key-abcdefghijklmn'};
  const legacy = await (await fetch(`${base}/internal/hermes/tool-contracts`, {headers})).json() as any[];
  assert.equal(legacy.some(tool => tool.name === 'paios_l5_read'), true);
  const client = new Client({name: 'ts-http-test', version: '1'});
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/internal/capability/mcp`), {requestInit: {headers}});
  await client.connect(transport as Parameters<Client['connect']>[0]);
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'paios_l5_read')); assert.equal(tools.some(tool => tool.name === 'paios_payment'), false);
    for (const [name, args] of [['paios_l5_read', {}], ['paios_open_reply', {reply_mode: 'text'}]] as const) {
      const reply = await client.callTool({name, arguments: gatewayContextStub({run_id: 'run', session_id: 'session', tool_call_id: name}, args)});
      assert.equal((reply.structuredContent as any).status.state, 'succeeded', JSON.stringify(reply));
    }
    if (process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT) {
      const probe = new URL('../../../../../tests/hermes/ts_packages_probe.py', import.meta.url);
      const child = spawn(process.env.PAIOS_HERMES_PYTHON!, [fileURLToPath(probe), `${base}/internal/capability/mcp`, 'run', 'session'], {
        env: {...process.env, HERMES_SOURCE: process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT, TS_PROBE_INTERNAL_KEY: 'fixture-internal-key-abcdefghijklmn'},
        stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => {stdout += String(bytes);}); child.stderr.on('data', bytes => {stderr += String(bytes);});
      const code = await new Promise<number | null>((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
      assert.equal(code, 0, stderr || stdout);
      assert.equal(JSON.parse(stdout).trusted_context_overrode_model, true);
    }
    current = catalogStub(['ts-delivery']);
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'paios_l5_read'), false);
    const restored = await (await fetch(`${base}/internal/hermes/tool-contracts`, {headers})).json() as any[];
    assert.equal(restored.some(tool => tool.name === 'paios_l5_read'), true);
  } finally {await client.close();}
});

test('each transport and result adapter stays within the 200-line responsibility limit', () => {
  const directory = new URL('../src/capability/ts/', import.meta.url);
  for (const file of readdirSync(directory)) assert.ok(readFileSync(new URL(file, directory), 'utf8').split('\n').length <= 200, file);
});
