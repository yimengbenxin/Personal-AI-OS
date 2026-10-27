import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry, readPackage} from '../src/capability/registry/registry.ts';
import {OfflineRegistrationRunner} from '../src/capability/registry/runner.ts';
import {inspectPackage} from '../src/capability/registry/checks.ts';
import {capabilityRegistryRoute} from '../src/capability/registry/api.ts';
import type {EnabledPackageAuthority, PackageVersion, PackageFiles, PackageContext} from '../src/capability/registry/interfaces.ts';

const template = fileURLToPath(new URL('../../../../../capability/templates/yimi-capability-template', import.meta.url));
const context = {principal_id: 'owner', run_id: 'run', scope: 'build'};
const python = process.env.PAIOS_HERMES_PYTHON ?? 'python3';
function changeManifest(files: PackageFiles, mutate: (m: any) => void) {
  const manifest = JSON.parse(files['plugin.json']!); mutate(manifest); files['plugin.json'] = JSON.stringify(manifest);
}
const extension = (m: any) => m.extensions['ai.yimi.capability'];

/** Only the P1 seam is stubbed. Registration executes real code in kernel namespaces. */
class Authority implements EnabledPackageAuthority {
  current = new Map<string, PackageVersion>(); notifications: unknown[] = []; fail = false;
  available: PackageVersion[] = [];
  async installed() {return [...this.current.values(), ...this.available];}
  async enabled() {return [...this.current.values()];}
  async replace(_: PackageContext, {name, expected, next}: {name: string; expected: string | null; next: PackageVersion | null}) {
    assert.equal(this.current.get(name)?.digest ?? null, expected);
    if (this.fail) throw new Error('host_load_failed');
    if (next) this.current.set(name, next); else this.current.delete(name);
    this.notifications.push({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
  }
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'registry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const authority = new Authority(), calls: string[] = [];
  const outcomes = new Map<string, {total: number; failed: number; unknown: number}>();
  const runner = new OfflineRegistrationRunner(python);
  let healthy: boolean | Error = true;
  const registry = new CapabilityRegistry(root, authority, {check: dir => runner.check(dir), health: async () => {
    if (healthy instanceof Error) throw healthy; return healthy;
  }},
    {outcomes: async (_principal, _name, digest) => outcomes.get(digest) ?? {total: 0, failed: 0, unknown: 0}},
    {hub: async query => {calls.push('hub'); return {query};}, mcp: async query => {calls.push('mcp'); return {query};}});
  return {root, authority, registry, runner, calls, outcomes, unhealthy: () => {healthy = false;},
    unavailable: () => {healthy = new Error('fictional network timeout');}, files: await readPackage(template)};
}

test('a health transport exception is unavailable, while a definitive failed health still rolls back',async t=>{
  const {registry,authority,files,unavailable,unhealthy}=await fixture(t);
  t.mock.method(console,'warn',()=>{});
  const checked=await registry.check(context,files);await registry.publish(context,checked.candidate_id);
  unavailable();const result=await registry.monitor(context,'yimi-capability-template');
  assert.equal(result.health,null);assert.equal(result.rollback,null);
  assert.equal(authority.current.get('yimi-capability-template')!.digest,checked.digest);
  unhealthy();assert.equal((await registry.monitor(context,'yimi-capability-template')).rollback?.reason,'health_failed');
  assert.equal(authority.current.size,0);
});

test('template passes both implementations; direct publish, restart recovery, latest rollback removes initial package', async t => {
  const {registry, authority, files, root, runner} = await fixture(t);
  const checked = await registry.check(context, files);
  assert.equal(checked.evidence.cases.length, 2);
  const published = await registry.publish(context, checked.candidate_id);
  assert.equal(published.changed, true);
  assert.equal((await registry.publish(context, checked.candidate_id)).changed, false);
  assert.equal(authority.notifications.length, 1);
  const recovered = new CapabilityRegistry(root, authority, runner,
    {outcomes: async () => ({total: 0, failed: 0, unknown: 0})}, {hub: async () => [], mcp: async () => []});
  assert.equal((await recovered.status(context)).enabled.length, 1);
  await recovered.rollback(context);
  assert.equal(authority.current.size, 0);
  assert.equal(authority.notifications.length, 2);
});

for (const [label, mutate] of [
  ['missing effect', (f: PackageFiles) => changeManifest(f, m => {delete extension(m).tools.sample.effect;})],
  ['secret value', (f: PackageFiles) => {f['server/credentials.py'] = 'api_key = "sk-synthetic-private-fixture-value"';}],
  ['yimi spend', (f: PackageFiles) => changeManifest(f, m => {extension(m).tools.sample.effect = 'spend';})],
  ['yimi self_change', (f: PackageFiles) => changeManifest(f, m => {extension(m).tools.sample.effect = 'self_change';})],
  ['conditional spend', (f: PackageFiles) => changeManifest(f, m => {extension(m).tools.sample = {effect_by_arg: {'$.mode': {read: 'observe', pay: 'spend'}}};})],
] as const) {
  test('rejects ' + label + ' before executing package code', async t => {
    const {files, registry, authority} = await fixture(t); mutate(files);
    await assert.rejects(registry.check(context, files)); assert.equal(authority.current.size, 0);
  });
}
for (const [label, code, error] of [
  ['invalid receipt', "return {'content': [{'type':'text','text':'ok'}], 'structuredContent': {'success': True}}", /contract_receipt_invalid/],
  ['invalid MCP result', 'return 1', /mcp_tool_result_invalid/],
  ['observe writes', "open('/work/changed', 'w').write('mutation')", /contract_observe_write/],
  ['observe child process writes', "\n    import subprocess\n    subprocess.run([sys.executable, '-c', \"open('/work/child-write', 'w').write('mutation')\"], check=True)", /contract_observe_write/],
  ['observe openat2 creates an empty file', "\n    import ctypes, os\n    class How(ctypes.Structure):\n        _fields_ = [('flags', ctypes.c_ulonglong), ('mode', ctypes.c_ulonglong), ('resolve', ctypes.c_ulonglong)]\n    how = How(65, 420, 0)\n    number = ctypes.CDLL('libseccomp.so.2').seccomp_syscall_resolve_name(b'openat2')\n    fd = ctypes.CDLL(None).syscall(number, ctypes.c_long(-100), ctypes.c_char_p(b'/work/empty-created'), ctypes.byref(how), 24)\n    assert fd >= 0\n    os.close(fd)", /contract_observe_write/],
  ['observe attempts package write', "\n    try: open('/package/server/server.py', 'w').write('mutation')\n    except OSError: pass", /contract_observe_write/],
  ['off-allowlist egress', "\n    import socket\n    s = socket.socket()\n    try: s.connect(('203.0.113.9', 443))\n    except OSError: pass\n    s.close()", /contract_egress_violation/],
] as const) {
  test('kernel-monitored registration rejects ' + label, async t => {
    const {files, registry, authority} = await fixture(t);
    files['server/server.py'] = files['server/server.py']!.replace("    if name != 'sample':", '    ' + code + "\n    if name != 'sample':");
    // Invalid receipts must reach receipt validation instead of an expected-value mismatch.
    if (label === 'invalid receipt') {
      files['tests/contract.yaml'] = 'version: 1\ncases:\n  - tool: sample\n    args: {}\n    expect: {}\n';
      files['scripts/test.py'] = "import runpy\nassert callable(runpy.run_path('/package/server/server.py')['call'])\n";
    }
    if (label === 'off-allowlist egress') files['scripts/test.py'] = "import runpy\nassert callable(runpy.run_path('/package/server/server.py')['call'])\n";
    await assert.rejects(registry.check(context, files), error); assert.equal(authority.current.size, 0);
  });
}

test('find order and admitted scope; dispatch does not trust wire context', async t => {
  const {registry, calls, files, authority, root} = await fixture(t);
  authority.available.push({name: 'installed-but-disabled', version: '1.0.0', root, digest: 'a'.repeat(64),
    manifest: JSON.parse(files['plugin.json']!)});
  const results = await registry.find(context, 'batch sample PDFs');
  assert.equal((results.results[0]!.matches as unknown[]).length, 1);
  assert.equal((await authority.enabled()).length, 0);
  assert.deepEqual(results.results.map(row => row.source), ['installed', 'hermes_hub', 'official_mcp']);
  assert.deepEqual(calls, ['hub', 'mcp']);
  for (const scope of ['guest', 'owner_uncertain', 'care', 'background', 'cron']) {
    await assert.rejects(registry.check({...context, scope}, files), /scope_denied/);
  }
  await assert.rejects(capabilityRegistryRoute(registry, {...context, scope: 'guest'}, 'find',
    {query: 'sample', context}), /scope_denied/);
});

test('changed candidates, reused versions, foreign principals and authority CAS cannot ship', async t => {
  const {registry, files, authority} = await fixture(t);
  const first = await registry.check(context, files);
  await assert.rejects(registry.publish({...context, principal_id: 'other'}, first.candidate_id), /principal_mismatch/);
  await registry.publish(context, first.candidate_id);
  const next = {...files, 'server/extra.py': '# new source\n'};
  await assert.rejects(registry.check(context, next), /version_reused/);
  changeManifest(next, m => {m.version = '0.2.0';});
  const checked = await registry.check(context, next);
  authority.fail = true;
  await assert.rejects(registry.publish(context, checked.candidate_id), /host_load_failed/);
  assert.equal((await registry.status(context)).enabled[0]?.version, '0.1.0');
  authority.fail = false;
  await writeFile(join((await registry.status(context)).enabled[0]!.root, 'server/extra.py'), 'tampered');
  // The checked next version remains immutable; its own digest is rechecked immediately before replace.
  const nextRoot = join((await registry.status(context)).enabled[0]!.root, '..', checked.digest, 'server/extra.py');
  await writeFile(nextRoot, 'tampered');
  await assert.rejects(registry.publish(context, checked.candidate_id), /checked_package_changed/);
});

test('previous version restored on clear ledger regression and on failed health; sparse data does not roll back', async t => {
  const {registry, files, outcomes, unhealthy} = await fixture(t);
  const first = await registry.check(context, files); await registry.publish(context, first.candidate_id);
  const next = {...files}; changeManifest(next, m => {m.version = '0.2.0';});
  const second = await registry.check(context, next); await registry.publish(context, second.candidate_id);
  outcomes.set(first.digest, {total: 100, failed: 1, unknown: 1});
  outcomes.set(second.digest, {total: 2, failed: 1, unknown: 1});
  assert.equal((await registry.monitor(context, 'yimi-capability-template')).rollback, null);
  outcomes.set(second.digest, {total: 100, failed: 45, unknown: 20});
  assert.equal((await registry.monitor(context, 'yimi-capability-template')).rollback?.reason, 'outcome_regression');
  assert.equal((await registry.status(context)).enabled[0]?.digest, first.digest);
  const third = {...files}; changeManifest(third, m => {m.version = '0.3.0';});
  await registry.publish(context, (await registry.check(context, third)).candidate_id);
  unhealthy();
  assert.equal((await registry.monitor(context, 'yimi-capability-template')).rollback?.reason, 'health_failed');
  assert.equal((await registry.status(context)).enabled[0]?.digest, first.digest);
});

test('path traversal, oversized adapters and embedded credential URLs fail at the upload boundary', async t => {
  const {files} = await fixture(t);
  assert.throws(() => inspectPackage({...files, '../outside': 'bad'}), /path_invalid/);
  assert.throws(() => inspectPackage({...files, 'plugin.yaml': 'name: escape\n'}), /portable_package_only/);
  assert.throws(() => inspectPackage({...files, 'server/creds': 'https://account:private@api.example.com'}), /secret_value/);
  assert.throws(() => inspectPackage({...files, 'server/server.py': '# adapter\n'.repeat(201)}), /adapter_budget/);
  const split = {...files, 'server/conversion.py': '# related conversion\n'.repeat(180)};
  changeManifest(split, m => {extension(m).provenance.adapter_modules.push('server/conversion.py');});
  assert.throws(() => inspectPackage(split), /adapter_budget_exceeded:combined_conversion_modules/);
});

test('the alternative TypeScript server imports the SDK and passes the same contracts', async t => {
  const {files, registry} = await fixture(t);
  files['mcp.json'] = JSON.stringify({$schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {capability: {type: 'stdio', command: 'node', args: ['server/server.ts']}}});
  changeManifest(files, m => {extension(m).provenance.adapter_modules = ['server/server.ts'];});
  const checked = await registry.check(context, files);
  assert.equal(checked.evidence.cases.length, 2);
});

test('a missing result index is a failed assertion and cannot match an expected null', async t => {
  const {files, registry} = await fixture(t);
  files['tests/contract.yaml'] = files['tests/contract.yaml']!.replace('values.0.value: 1', 'values.99.value: null');
  await assert.rejects(registry.check(context, files), /actual=missing/);
});

test('retrying the same owner rollback call cannot undo a second package', async t => {
  const {registry, files, authority} = await fixture(t);
  await registry.publish(context, (await registry.check(context, files)).candidate_id);
  const other = {...files}; changeManifest(other, m => {m.name = 'second-package';});
  await registry.publish(context, (await registry.check(context, other)).candidate_id);
  const call = {...context, tool_call_id: 'frozen-owner-undo'};
  const first = await registry.rollback(call);
  assert.equal(first.name, 'second-package');
  assert.deepEqual(await registry.rollback(call), first);
  assert.equal(authority.current.size, 1);
  await registry.rollback({...call, run_id: 'next-owner-run'});
  assert.equal(authority.current.size, 0);
});

test('publishing one package retains the other package current, previous and unpublished draft', async t => {
  const {registry, files} = await fixture(t);
  const checked = async (name: string, version: string) => {
    const source = {...files}; changeManifest(source, m => {m.name = name; m.version = version;});
    return registry.check(context, source);
  };
  const first = await checked('first-package', '1.0.0'); await registry.publish(context, first.candidate_id);
  const previous = await checked('second-package', '1.0.0'); await registry.publish(context, previous.candidate_id);
  const current = await checked('second-package', '2.0.0'); await registry.publish(context, current.candidate_id);
  const draft = await checked('second-package', '3.0.0');
  const update = await checked('first-package', '2.0.0'); await registry.publish(context, update.candidate_id);
  const second = (await registry.status(context, 'second-package')).enabled[0]!;
  assert.equal(inspectPackage(await readPackage(second.root)).digest, current.digest);
  await registry.rollback(context, 'second-package');
  assert.equal(inspectPackage(await readPackage((await registry.status(context, 'second-package')).enabled[0]!.root)).digest, previous.digest);
  assert.equal((await registry.checked(context, draft.candidate_id)).success, true);
});

test('failed rollback intents stay frozen after a different owner call completes that rollback', async t => {
  const {registry, files, authority} = await fixture(t);
  await registry.publish(context, (await registry.check(context, files)).candidate_id);
  const other = {...files}; changeManifest(other, m => {m.name = 'second-package';});
  await registry.publish(context, (await registry.check(context, other)).candidate_id);
  const first = {...context, tool_call_id: 'first-undo'};
  authority.fail = true;
  await assert.rejects(registry.rollback(first), /host_load_failed/);
  authority.fail = false;
  const completed = await registry.rollback({...context, tool_call_id: 'second-undo'});
  assert.deepEqual(await registry.rollback(first), completed);
  assert.equal(authority.current.size, 1);
});

test('registration waits for initialize before sending later MCP requests', async t => {
  const {files, registry} = await fixture(t);
  files['server/server.py'] = files['server/server.py']!.replace('def serve():',
    "def wire_lines():\n    import os\n    line = b''\n    while byte := os.read(0, 1):\n        line += byte\n        if byte == b'\\n':\n            yield line.decode()\n            line = b''\n\n\ndef serve():")
    .replace('for line in sys.stdin:', 'for line in wire_lines():')
    .replace("if method == 'initialize':", "if method == 'initialize':\n            import select\n            assert not select.select([0], [], [], .03)[0], 'client did not wait for initialize'");
  assert.equal((await registry.check(context, files)).success, true);
});
