import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {check, ContractError, digest, id, sha256} from '../contracts.ts';
import {UnifiedIngress} from '../ingress.ts';
import type {RawArchive} from '../archive.ts';
import type {StoragePort} from '../storage.ts';
import type {L3Service} from './l3.ts';
import {commandDigest, type AssertionInput, type EvidenceRef, type L3Command} from './contracts.ts';
import {CORE_PROFILE_FILES as FILES, CORE_PROFILE_SEPARATOR as SEPARATOR, nativeEntries, entryDigests,
  readCoreProfileBaseline, type CoreProfileFile as File} from './core-profile-state.ts';

const PURPOSE = 'core_profile';
type Entry = {file: File; ordinal: number; text: string};
export type CoreProfileMemory = Pick<L3Service, 'commit' | 'query' | 'inspect'>;
export interface CoreProfileMigration {
  principal_id: string; profile_home: string;
  files: {file: File; source_sha256: string; entries: number; source_bytes: number; entry_sha256: string[]; imported: number}[];
  assertions: string[];
}
const migrationKey = (home: string, baseline?: string) => digest({profile_home: home, ...(baseline ? {baseline} : {})});
export async function coreProfileMigration(storage: StoragePort, home: string, baseline?: string): Promise<CoreProfileMigration> {
  return JSON.parse(new TextDecoder().decode(await storage.read('core-profile-migrations', migrationKey(home, baseline)))) as CoreProfileMigration;
}

/** Only content-free evidence crosses the release/log boundary, including a partially durable import. */
export class CoreProfileMigrationError extends ContractError {
  readonly evidence: {files: CoreProfileMigration['files']; assertions: string[]; attempted_assertions: string[]; checkpoint_written: boolean;
    source_preimage_sha256?: string};
  constructor(code: string, evidence: CoreProfileMigrationError['evidence'], status = 500) {super(code, status); this.evidence = evidence;}
}

const projections = new Map<string, Promise<void>>();
export function projectCoreProfile(l3: CoreProfileMemory, principal: string, home: string, writer?: {uid: number; gid: number}) {
  const result = (projections.get(home) ?? Promise.resolve()).then(() => buildCoreProfile(l3, principal, home, writer));
  const settled = result.then(() => {}, () => {});
  projections.set(home, settled);
  void settled.then(() => {
    if (projections.get(home) === settled) projections.delete(home);
  });
  return result;
}

/** L3 is the authority. These files contain only its current, applicable core-profile entries. */
async function buildCoreProfile(l3: CoreProfileMemory, principal: string, home: string, writer?: {uid: number; gid: number}) {
  const entries: (Entry & {id: string})[] = [];
  let cursor: string | undefined;
  do {
    const page = await l3.query({authenticated: true, principal_id: principal}, undefined, 'active',
      {scope: {purpose: PURPOSE}, limit: 100, ...(cursor ? {cursor} : {})});
    for (const a of page.assertions) {
      if (a.applicability_status !== 'applicable' || a.predicate !== 'core_profile.entry') continue;
      const value = a.value as Entry;
      check(FILES.includes(value.file) && Number.isSafeInteger(value.ordinal) && typeof value.text === 'string', 'CORE_PROFILE_ENTRY_INVALID');
      entries.push({...value, id: a.assertion_id});
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  entries.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const views = Object.fromEntries(FILES.map(file => [file, entries.filter(e => e.file === file).map(e => e.text).join(SEPARATOR)])) as Record<File, string>;
  await fs.mkdir(join(home, 'memories'), {recursive: true});
  for (const file of FILES) {
    const path = join(home, 'memories', file), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, views[file], {mode: 0o444, flag: 'wx'});
      if (writer) await fs.chown(temporary, writer.uid, writer.gid);
      await fs.rename(temporary, path);
    } finally {await fs.rm(temporary, {force: true});}
  }
  return {views, entries: entries.length, assertion_ids: entries.map(e => e.id)};
}

/** Offline release operation: old native writers must be drained before this runs. */
export async function migrateNativeMemory(options: {
  principal_id: string; profile_home: string; source_profile_home?: string; empty_source_only?: boolean; storage: StoragePort; archive: RawArchive; l3: CoreProfileMemory;
}) {
  const {principal_id: principal, profile_home: home, storage, archive, l3} = options;
  const sourceHome = options.source_profile_home ?? home;
  const migrated: CoreProfileMigration = {principal_id: principal, profile_home: home, files: [], assertions: []};
  const attempted: string[] = [];
  let checkpointWritten = false;
  let sourcePreimage: string | undefined;
  try {
    id(principal);
    const baseline = await readCoreProfileBaseline(home);
    if (baseline) check(baseline.principal_id === principal, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
    let existing: CoreProfileMigration | undefined;
    try {existing = await coreProfileMigration(storage, home, baseline?.id);}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (existing) {
      check(existing.principal_id === principal, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
      Object.assign(migrated, existing);
      checkpointWritten = true;
      return {...existing, ...await projectCoreProfile(l3, principal, home), replayed: true};
    }
    const snapshots = await Promise.all(FILES.map(async file => {
      const path = join(sourceHome, 'memories', file);
      try {return {file, bytes: await fs.readFile(path), captured_at: (await fs.stat(path)).mtime.toISOString()};}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return {file, bytes: Buffer.alloc(0), captured_at: '1970-01-01T00:00:00.000Z'};}
    }));
    if (options.empty_source_only) check(snapshots.every(s => !s.bytes.toString('utf8').trim()), 'CORE_PROFILE_MIGRATION_REQUIRED', 503);
    const sourceSet = {principal_id: principal, files: snapshots.map(({file, bytes}) => ({file, source_sha256: sha256(bytes)}))};
    const sourceSlot = await storage.publish('core-profile-imports', migrationKey(home, baseline?.id), Buffer.from(JSON.stringify(sourceSet)));
    sourcePreimage = sha256(sourceSlot);
    const boundSource = JSON.parse(new TextDecoder().decode(sourceSlot));
    check(boundSource.principal_id === principal, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
    check(digest(boundSource) === digest(sourceSet), 'CORE_PROFILE_MIGRATION_SOURCE_CHANGED', 409);
    for (const {file, bytes, captured_at} of snapshots) {
      const source = sha256(bytes), entries = nativeEntries(bytes);
      const known = new Set(baseline?.known_entry_sha256[file] ?? []);
      const added = entries.map((text, ordinal) => ({text, ordinal})).filter(entry => !known.has(sha256(entry.text)));
      migrated.files.push({file, source_sha256: source, entries: entries.length, source_bytes: bytes.length,
        entry_sha256: entryDigests(bytes), imported: added.length});
      if (!bytes.length) continue;
      const identity = {home, file, source, ...(baseline ? {baseline: baseline.id} : {})};
      const sourceMetadata = await storage.publish('core-profile-sources', digest(identity), Buffer.from(JSON.stringify({captured_at})));
      const snapshot = JSON.parse(new TextDecoder().decode(sourceMetadata)) as {captured_at: string};
      const event = await new UnifiedIngress(archive).accept({schema_version: 'paios.event.v1',
        event_id: `core-profile-${digest(identity)}`, device_id: 'core-profile-migration', device_type: 'mac',
        captured_at: snapshot.captured_at, source: {channel: 'core_profile_migration'}, media_type: 'text', mime: 'text/plain;charset=utf-8',
        representation: 'uploaded_original', payload: bytes}, {principal_id: principal, device_id: 'core-profile-migration',
        device_type: 'mac', channel: 'core_profile_migration', consent_ref: 'native-memory-migration', submission: 'explicit_text'});
      check(sha256(await archive.read(event.raw_ref, principal, event.archive_revision)) === source, 'CORE_PROFILE_L5_READBACK_FAILED');
      const evidence: EvidenceRef = {event_id: event.event_id, processed_event_id: event.processed_event_id,
        raw_ref: event.raw_ref, archive_revision: event.archive_revision};
      for (const {ordinal, text} of added) {
        const assertion_id = `core-profile-${digest({...identity, ordinal})}`;
        const assertion: AssertionInput = {assertion_id, kind: 'fact', subject_ref: {type: 'known_person', id: principal},
          predicate: 'core_profile.entry', value: {file, ordinal, text},
          scope: {principal_id: principal, purpose: PURPOSE, situation: 'persistent', role: 'owner', evaluation_frame: 'source_record'},
          evidence_refs: [evidence], evidence_status: 'source_record', unknown_conditions: [], conflicts: [],
          status: 'active', applicability_status: 'applicable', relation_to_peers: 'independent', typed_scores: {}, depends_on: []};
        const payload = {command_id: assertion_id, operation: 'create' as const, expected_version: 0, assertion, evidence_refs: [evidence]};
        const command: L3Command = {...payload, payload_sha256: commandDigest(payload)};
        attempted.push(assertion_id);
        await l3.commit(command, {authenticated: true, principal_id: principal, run_id: 'core-profile-migration',
          context_ref: 'native-memory-migration', authorize: async c => c.payload_sha256 === command.payload_sha256,
          // The cited revision's pinned proof, never the current head: a stream head moves past every earlier revision.
          evidenceAvailable: async ref => {await archive.readRecord(ref.raw_ref, principal, ref.archive_revision, {proof_only: true}); return true;}});
        const stored = await l3.inspect({authenticated: true, principal_id: principal}, assertion_id);
        check(stored.status === 'found' && digest(stored.assertion.value) === digest(assertion.value), 'CORE_PROFILE_MIGRATION_READBACK_FAILED');
        migrated.assertions.push(assertion_id);
      }
    }
    // Never replace a source that changed while its entries were being imported.
    for (const snapshot of snapshots) {
      let current: Buffer;
      try {current = await fs.readFile(join(sourceHome, 'memories', snapshot.file));}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current = Buffer.alloc(0);}
      check(sha256(current) === sha256(snapshot.bytes), 'CORE_PROFILE_MIGRATION_SOURCE_CHANGED', 409);
    }
    const winner = await storage.publish('core-profile-migrations', migrationKey(home, baseline?.id), Buffer.from(JSON.stringify(migrated)));
    check(digest(JSON.parse(new TextDecoder().decode(winner))) === digest(migrated), 'CORE_PROFILE_MIGRATION_CHECKPOINT_CONFLICT', 409);
    checkpointWritten = true;
    const result = await projectCoreProfile(l3, principal, home);
    check(migrated.assertions.every(id => result.assertion_ids.includes(id)), 'CORE_PROFILE_MIGRATION_COVERAGE_MISMATCH');
    return {...migrated, ...result, replayed: false};
  } catch (error) {
    const code = error instanceof ContractError ? error.code : (error as NodeJS.ErrnoException).code ?? 'CORE_PROFILE_MIGRATION_FAILED';
    throw new CoreProfileMigrationError(code, {files: migrated.files, assertions: migrated.assertions,
      attempted_assertions: attempted, checkpoint_written: checkpointWritten,
      ...(sourcePreimage ? {source_preimage_sha256: sourcePreimage} : {})}, error instanceof ContractError ? error.status : 500);
  }
}

/** A fresh installation may initialize an empty profile; legacy facts require the offline migration. */
export async function refreshCoreProfile(options: Parameters<typeof migrateNativeMemory>[0]) {
  let migration: CoreProfileMigration;
  try {migration = await coreProfileMigration(options.storage, options.profile_home);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return migrateNativeMemory({...options, empty_source_only: true});
  }
  check(migration.principal_id === options.principal_id, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
  return projectCoreProfile(options.l3, options.principal_id, options.profile_home);
}
