import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {migrateNativeMemory, projectCoreProfile, refreshCoreProfile, CoreProfileMigrationError, type CoreProfileMemory} from '../src/memory/core-profile.ts';
import {projectNativeMemoryForRollback as projectRollback} from '../src/memory/core-profile-rollback.ts';
import {readCoreProfileBaseline} from '../src/memory/core-profile-state.ts';
import {validateCommand, type L3Assertion, type L3Receipt} from '../src/memory/contracts.ts';
import {digest, EVENT_SCHEMA} from '../src/contracts.ts';

const projectNativeMemoryForRollback = (input: Omit<Parameters<typeof projectRollback>[0], 'state_owner'>) =>
  projectRollback({...input, state_owner: {uid: process.getuid!(), gid: process.getgid!()}});

function memory() {
  const rows = new Map<string, L3Assertion>(), receipts = new Map<string, L3Receipt>();
  const l3: CoreProfileMemory = {
    commit: async (c, context) => {
      validateCommand(c, context.principal_id);
      assert.ok(await context.authorize(c));
      for (const ref of c.evidence_refs) assert.ok(await context.evidenceAvailable(ref));
      if (receipts.has(c.command_id)) return receipts.get(c.command_id)!;
      rows.set(c.assertion.assertion_id, {...c.assertion, version: 1, previous_version: null,
        created_at: '2026-10-24T00:00:00Z', authorizing_context_ref: context.context_ref});
      const receipt: L3Receipt = {receipt_ref: 'l3:owner:' + c.command_id, command_id: c.command_id,
        payload_sha256: c.payload_sha256, status: 'committed', assertion_id: c.assertion.assertion_id, version: 1,
        previous_version: null, authority_watermark: String(rows.size), committed_at: '2026-10-24T00:00:00Z', invalidated: []};
      receipts.set(c.command_id, receipt); return receipt;
    },
    inspect: async (context, id) => ({status: 'found', assertion: rows.get(id)!, provenance_status: 'complete',
      unknown_conditions: [], current_version: {operation: 'create', receipt: receipts.get(id)!}, invalidation_causes: []}),
    query: async context => ({assertions: [...rows.values()].filter(a => a.scope.principal_id === context.principal_id && a.status === 'active'),
      next_cursor: null, truncated: false}),
  };
  return {l3, rows};
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'core-profile-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'profile'); await mkdir(join(home, 'memories'), {recursive: true});
  const storage = new PosixStorage(join(root, 'platform'));
  return {home, storage, archive: new RawArchive(storage, 65536)};
}

test('all eight legacy entries survive L5/L3 migration and the read-only view, including multiline text and duplicate facts', async t => {
  const f = await fixture(t), {l3, rows} = memory();
  const notes = ['偏好甲', '有单位的事实：21.75 °C', '多行内容\n第二行', '事实乙', '事实丙', '重复事实'];
  const profile = ['称呼：测试主人', '重复事实'];
  for (const [file, entries] of [['MEMORY.md', notes], ['USER.md', profile]] as const)
    await writeFile(join(f.home, 'memories', file), entries.join('\n§\n'));
  const viewHome = f.home + '-view';
  t.after(() => rm(viewHome, {recursive:true,force:true}));
  const input = {source_profile_home:f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  const result = await migrateNativeMemory(input);
  assert.equal(result.entries, 8); assert.equal(rows.size, 8);
  assert.deepEqual(result.files.map(f => f.entries), [6, 2]);
  for (const [file, entries] of [['MEMORY.md', notes], ['USER.md', profile]] as const) {
    assert.equal(await readFile(join(viewHome, 'memories', file), 'utf8'), entries.join('\n§\n'));
    assert.equal((await stat(join(viewHome, 'memories', file))).mode & 0o777, 0o444);
  }
  assert.equal((await migrateNativeMemory(input)).replayed, true); assert.equal(rows.size, 8);
  await assert.rejects(migrateNativeMemory({...input, principal_id: 'foreign'}), /CORE_PROFILE_PRINCIPAL_MISMATCH/);
  const entry = [...rows.values()].find(a => (a.value as {text:string}).text === notes[0])!;
  entry.value = {...entry.value as object, text: '已纠正的偏好'};
  const removed = [...rows.values()].find(a => (a.value as {text:string}).text === notes[1])!;
  removed.status = 'deleted';
  const current = await projectCoreProfile(l3, 'owner', viewHome);
  assert.match(current.views['MEMORY.md'], /已纠正的偏好/);
  assert.doesNotMatch(current.views['MEMORY.md'], /21.75/);
  assert.equal(current.entries, 7);
  assert.equal(await readFile(join(f.home,'memories','MEMORY.md'),'utf8'),notes.join('\n§\n'),'the rollback source stays intact');
});

test('a concurrent legacy edit stops cutover after durable import and leaves source bytes intact', async t => {
  const f = await fixture(t), {l3} = memory(), path = join(f.home, 'memories', 'MEMORY.md');
  await writeFile(path, 'original');
  const commit = l3.commit.bind(l3);
  l3.commit = async (...args) => {const receipt = await commit(...args); await writeFile(path, 'concurrent'); return receipt;};
  await assert.rejects(migrateNativeMemory({principal_id: 'owner', profile_home: f.home, storage: f.storage, archive: f.archive, l3}),
    /CORE_PROFILE_MIGRATION_SOURCE_CHANGED/);
  assert.equal(await readFile(path, 'utf8'), 'concurrent');
  await assert.rejects(f.storage.read('core-profile-migrations', digest({profile_home:f.home})), {code:'ENOENT'});
});

test('the evidence check handed to L3 verifies the cited revision, not a live stream head that moved past it', async t => {
  const f = await fixture(t), {l3} = memory();
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), '事实');
  const trusted = {principal_id: 'owner', device_id: 'phone', device_type: 'phone' as const, consent_ref: 'consent', channel: 'fixture', submission: 'observation' as const};
  const raw = {schema_version: EVENT_SCHEMA, event_id: 'call-microphone-lane', device_id: 'phone', device_type: 'phone' as const, captured_at: '2026-10-24T00:00:00.000Z',
    source: {channel: 'fixture'}, media_type: 'audio' as const, mime: 'audio/pcm', representation: 'received_decoded_sample' as const, payload: Buffer.alloc(320)};
  const chunk = (seq: number) => ({track_id: 'microphone', stream_epoch: 'lane', seq, modality: 'audio' as const, format: 'pcm_s16le:16000:1',
    source_range: {kind: 'interval' as const, timebase_id: 'received-pcm:lane', stream_epoch: 'lane', start_ms: seq * 10, end_ms: (seq + 1) * 10}});
  const cited = (await (await f.archive.admitStream(raw, trusted, chunk(0))).commit).event;
  await (await f.archive.admitStream(raw, trusted, chunk(1))).commit;
  const commit = l3.commit.bind(l3), seen: boolean[] = [];
  l3.commit = async (c, context) => {
    seen.push(await context.evidenceAvailable({event_id: cited.event_id, processed_event_id: 'call-turn', raw_ref: cited.raw_ref, archive_revision: cited.archive_revision}));
    return commit(c, context);
  };
  await migrateNativeMemory({principal_id: 'owner', profile_home: f.home, storage: f.storage, archive: f.archive, l3});
  assert.deepEqual(seen, [true]);
});

test('fresh profiles initialize once from an empty source, while existing native facts require offline migration', async t => {
  const f = await fixture(t), {l3, rows} = memory(), viewHome = f.home + '-view';
  t.after(() => rm(viewHome, {recursive:true,force:true}));
  await mkdir(viewHome);
  const input = {source_profile_home:f.home,principal_id:'owner',profile_home:viewHome,storage:f.storage,archive:f.archive,l3};
  await writeFile(join(f.home,'memories','MEMORY.md'),'legacy fact');
  await assert.rejects(refreshCoreProfile(input), {code: 'CORE_PROFILE_MIGRATION_REQUIRED', status: 503});
  await assert.rejects(f.storage.read('core-profile-migrations',digest({profile_home:viewHome})),{code:'ENOENT'});
  assert.equal(rows.size,0);
  await rm(join(f.home,'memories','MEMORY.md'));
  assert.equal((await refreshCoreProfile(input)).entries,0);
  assert.equal(await readFile(join(viewHome,'memories','MEMORY.md'),'utf8'),'');
  await refreshCoreProfile(input);
  await assert.rejects(refreshCoreProfile({...input,principal_id:'foreign'}),/CORE_PROFILE_PRINCIPAL_MISMATCH/);
});

test('overlapping projections cannot restore a forgotten core-profile entry', async t => {
  const f = await fixture(t), {l3, rows} = memory();
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), 'fact to forget');
  await migrateNativeMemory({principal_id:'owner', profile_home:f.home, storage:f.storage, archive:f.archive, l3});
  const query = l3.query.bind(l3);
  let reads = 0, entered!: () => void, release!: () => void;
  const firstRead = new Promise<void>(resolve => {entered = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  l3.query = async (...args) => {
    const snapshot = structuredClone(await query(...args));
    if (++reads === 1) {entered(); await blocked;}
    return snapshot;
  };
  const stale = projectCoreProfile(l3, 'owner', f.home);
  await firstRead;
  for (const row of rows.values()) row.status = 'deleted';
  const current = projectCoreProfile(l3, 'owner', f.home);
  // Let the second request reach its first read if no publication is in progress.
  await new Promise<void>(resolve => setImmediate(resolve));
  const overlappingSnapshots = reads > 1;
  release();
  await Promise.all([stale, current]);
  assert.equal(overlappingSnapshots, false, 'a later refresh must not publish ahead of an older snapshot');
  assert.equal(await readFile(join(f.home, 'memories', 'MEMORY.md'), 'utf8'), '');
});

test('rollback backs up both preimages and metadata, carries current facts, and re-upgrade imports only new digests', async t => {
  const f = await fixture(t), {l3, rows} = memory(), viewHome = join(f.home, 'derived');
  const original = 'fictional preference\n§\nfictional fact to forget';
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), original);
  await writeFile(join(f.home, 'memories', 'USER.md'), 'fictional profile');
  await chmod(join(f.home, 'memories', 'MEMORY.md'), 0o640);
  await chmod(join(f.home, 'memories', 'USER.md'), 0o600);
  const input = {source_profile_home: f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  const imported = await migrateNativeMemory(input);
  const corrected = rows.get(imported.assertions[0]!)!, forgotten = rows.get(imported.assertions[1]!)!;
  corrected.value = {...corrected.value as object, text: 'current fictional preference'};
  forgotten.status = 'deleted';
  const before = await Promise.all(['MEMORY.md', 'USER.md'].map(file => stat(join(f.home, 'memories', file))));
  const rollback = await projectNativeMemoryForRollback(input);
  assert.equal(rollback.status, 'projected');
  assert.equal(await readFile(join(f.home, 'memories', 'MEMORY.md'), 'utf8'), 'current fictional preference');
  const backup = join(viewHome, 'rollback-backups', rollback.backup_id!);
  assert.equal(await readFile(join(backup, 'MEMORY.md'), 'utf8'), original);
  assert.equal(await readFile(join(backup, 'USER.md'), 'utf8'), 'fictional profile');
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  for (const [index, file] of ['MEMORY.md', 'USER.md'].entries()) {
    const actual = await stat(join(f.home, 'memories', file));
    assert.deepEqual([actual.uid, actual.gid, actual.mode], [before[index]!.uid, before[index]!.gid, before[index]!.mode]);
    assert.equal(manifest.files_before[index].mode, before[index]!.mode & 0o7777);
  }
  for (const path of [join(viewHome, 'rollback-baseline.json'), join(backup, 'manifest.json')]) {
    const actual = await stat(path);
    assert.deepEqual([actual.uid, actual.gid, actual.mode & 0o777], [process.getuid!(), process.getgid!(), 0o600]);
  }
  assert.equal((await stat(backup)).mode & 0o777, 0o700);
  const baseline = await readCoreProfileBaseline(viewHome);
  assert.equal(baseline?.id, rollback.backup_id);
  // A stale old writer can repeat an original fact; its digest must never recreate a forgotten assertion.
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), 'current fictional preference\n§\nfictional fact to forget\n§\nnew fictional fact');
  const upgraded = await migrateNativeMemory(input);
  assert.equal(upgraded.assertions.length, 1);
  assert.equal(upgraded.files[0]!.imported, 1);
  assert.equal(rows.size, 4);
  assert.equal(upgraded.views['MEMORY.md'], 'current fictional preference\n§\nnew fictional fact');
  assert.equal((await migrateNativeMemory(input)).replayed, true);
  assert.equal(rows.size, 4);
  rows.get(upgraded.assertions[0]!)!.status = 'deleted';
  await projectNativeMemoryForRollback(input);
  await writeFile(join(f.home, 'memories', 'USER.md'), 'fictional profile\n§\nanother fictional fact');
  const again = await migrateNativeMemory(input);
  assert.equal(again.assertions.length, 1);
  assert.equal(again.views['MEMORY.md'], 'current fictional preference');
});

test('a failed import reports durable assertions without memory text, skips rollback without a checkpoint, and resumes', async t => {
  const f = await fixture(t), {l3, rows} = memory(), viewHome = join(f.home, 'derived');
  const original = 'fictional first secret\n§\nfictional second secret';
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), original);
  const input = {source_profile_home: f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  const commit = l3.commit;
  l3.commit = async (...args) => {if (rows.size === 1) throw new Error(original); return commit(...args);};
  await assert.rejects(migrateNativeMemory(input), (error: unknown) => {
    assert.ok(error instanceof CoreProfileMigrationError);
    assert.equal(error.evidence.assertions.length, 1);
    assert.equal(error.evidence.attempted_assertions.length, 2);
    assert.equal(error.evidence.checkpoint_written, false);
    assert.ok(!JSON.stringify(error).includes('fictional'));
    return true;
  });
  assert.deepEqual(await projectNativeMemoryForRollback(input), {status: 'skipped', reason: 'no_checkpoint'});
  assert.equal(await readFile(join(f.home, 'memories', 'MEMORY.md'), 'utf8'), original);
  l3.commit = commit;
  const resumed = await migrateNativeMemory(input);
  assert.equal(resumed.assertions.length, 2);
  assert.equal(rows.size, 2);
});

test('rollback refuses before changing either file when the second preimage cannot be backed up', async t => {
  const f = await fixture(t), {l3} = memory(), viewHome = join(f.home, 'derived');
  await writeFile(join(f.home, 'memories', 'MEMORY.md'), 'fictional source');
  const input = {source_profile_home: f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  await migrateNativeMemory(input);
  await mkdir(join(f.home, 'memories', 'USER.md'));
  await assert.rejects(projectNativeMemoryForRollback(input), {code: 'EISDIR'});
  assert.equal(await readFile(join(f.home, 'memories', 'MEMORY.md'), 'utf8'), 'fictional source');
  assert.equal(await readCoreProfileBaseline(viewHome), undefined);
});

test('a partial re-upgrade cannot project away native facts that have not reached L3 yet', async t => {
  const f = await fixture(t), {l3, rows} = memory(), viewHome = join(f.home, 'derived');
  const path = join(f.home, 'memories', 'MEMORY.md');
  await writeFile(path, 'fictional initial');
  const input = {source_profile_home: f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  await migrateNativeMemory(input);
  await projectNativeMemoryForRollback(input);
  const original = 'fictional initial\n§\nfictional new one\n§\nfictional new two';
  await writeFile(path, original);
  const commit = l3.commit;
  l3.commit = async (...args) => {if (rows.size === 2) throw new Error('fictional failure'); return commit(...args);};
  await assert.rejects(migrateNativeMemory(input), CoreProfileMigrationError);
  const baseline = await readCoreProfileBaseline(viewHome);
  const rollback = await projectNativeMemoryForRollback(input);
  assert.equal(rollback.status, 'preserved');
  assert.equal(rollback.reason, 'upgrade_not_checkpointed');
  assert.equal(rollback.baseline_id, baseline!.id);
  assert.deepEqual(await readCoreProfileBaseline(viewHome), baseline);
  assert.equal(await readFile(path, 'utf8'), original);
  l3.commit = commit;
  await migrateNativeMemory(input);
  assert.equal(rows.size, 3);
  await projectNativeMemoryForRollback(input);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('retrying a partial initial import refuses changed native bytes before adding another assertion', async t => {
  const f = await fixture(t), {l3, rows} = memory(), viewHome = join(f.home, 'derived');
  const path = join(f.home, 'memories', 'MEMORY.md'), original = 'fictional one\n§\nfictional two';
  await writeFile(path, original);
  const input = {source_profile_home: f.home, principal_id: 'owner', profile_home: viewHome, storage: f.storage, archive: f.archive, l3};
  const commit = l3.commit;
  l3.commit = async (...args) => {if (rows.size === 1) throw new Error('fictional failure'); return commit(...args);};
  await assert.rejects(migrateNativeMemory(input), CoreProfileMigrationError);
  l3.commit = commit;
  await writeFile(path, original + '\n§\nfictional later edit');
  await assert.rejects(migrateNativeMemory(input), /CORE_PROFILE_MIGRATION_SOURCE_CHANGED/);
  assert.equal(rows.size, 1);
  assert.equal(await readFile(path, 'utf8'), original + '\n§\nfictional later edit');
  await writeFile(path, original);
  await migrateNativeMemory(input);
  assert.equal(rows.size, 2);
});


test('failure while reading the rollback baseline reports an empty partial import and retains its filesystem code', async t => {
  const f = await fixture(t), {l3} = memory();
  await mkdir(join(f.home, 'rollback-baseline.json'));
  await assert.rejects(migrateNativeMemory({principal_id: 'owner', profile_home: f.home,
    storage: f.storage, archive: f.archive, l3}), (error: unknown) => {
    assert.ok(error instanceof CoreProfileMigrationError);
    assert.equal(error.code, 'EISDIR');
    assert.deepEqual(error.evidence, {files: [], assertions: [], attempted_assertions: [], checkpoint_written: false});
    return true;
  });
});
