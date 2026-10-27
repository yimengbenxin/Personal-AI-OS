import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { PosixStorage } from '../src/storage.ts';
import { EVENT_SCHEMA, principalAttribution, validateProcessed, type ArchivedEvent, type ProcessedEvent, type RawEvent, type TrustedContext } from '../src/contracts.ts';
import { RunAdmission, type AdmissionPolicy, type NativeRun } from './native-source-fixture.ts';
import { MemoryToolAuthority, type TrustedMemoryContext } from '../src/memory/tools.ts';
import type { AssertionInput, L3Command } from '../src/memory/contracts.ts';
import {DatabaseSync} from 'node:sqlite';
import {sha256} from '../src/contracts.ts';
import {migrateLegacyOriginals,readTurnCorpus,readTurnAudio} from '../tools/turn-eval.ts';
import {acquireProcessLock} from '../src/process-lock.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const device = {principal_id: 'owner', device_id: 'phone', device_type: 'phone' as const, consent_ref: 'consent', channel: 'formal'};
const policy: AdmissionPolicy = {max_pending_events: 4, max_pending_bytes: 100000, max_event_age_ms: 10000,
  poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'test'};
function raw(event_id: string, media_type: 'text' | 'app_event', payload: unknown): RawEvent {
  return {schema_version: EVENT_SCHEMA, event_id, captured_at: '2026-10-08T00:00:00.000Z', device_id: 'phone', device_type: 'phone',
    source: {channel: 'formal'}, media_type, mime: media_type === 'text' ? 'text/plain;charset=utf-8' : 'application/json',
    representation: 'uploaded_original', payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))};
}
async function setup(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'paios-call-turn-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const storage = new PosixStorage(root), archive = new RawArchive(storage, 100000);
  const ingress = new UnifiedIngress(archive);
  const accept = (event: RawEvent, submission: TrustedContext['submission']) => ingress.accept(event, {...device, submission});
  return {storage, archive, accept};
}
const turn = {kind: 'voice_turn', call_id: 'call-1', turn: 3, speaker:'owner', user: '记住我喜欢少糖的奶茶', assistant: '好的'};

test('the internal call source attributes identified owner speech; the same external parse grants no identity', async t => {
  const {accept} = await setup(t);
  const call = await accept(raw('voice-turn:1', 'app_event', turn), 'owner_call_turn');
  assert.deepEqual([call.origin, call.user_identity, call.intent_class, call.reply_hint], ['device_observation', 'owner', 'observation', 'policy']);
  assert.equal(principalAttribution(call), 'owner_call_turn');
  const typed = await accept(raw('typed-1', 'text', '记住我喜欢少糖'), 'explicit_text');
  assert.equal(principalAttribution(typed), 'explicit_text');
  // The same bytes through an ordinary app_event submission remain an unattributed observation.
  const observed = await accept(raw('app-1', 'app_event', turn), 'observation');
  assert.deepEqual([observed.user_identity, principalAttribution(observed)], ['unknown', null]);
  await assert.rejects(accept(raw('voice-turn:2', 'text', 'spoken'), 'owner_call_turn'), /CALL_TURN_REQUIRES_APP_EVENT/);
  await assert.rejects(accept(raw('voice-turn:3', 'app_event', {kind: 'memory_decision'}), 'owner_call_turn'), /CALL_TURN_PAYLOAD_INVALID/);
  await assert.rejects(accept(raw('voice-turn:unidentified','app_event',{...turn,speaker:'unknown'}),'owner_call_turn'),/CALL_TURN_PAYLOAD_INVALID/);
  // A D cannot carry principal attribution in any other form (the archived manifest binds the one it was given).
  assert.doesNotThrow(() => validateProcessed(call));
  assert.throws(() => validateProcessed({...typed, origin: 'device_observation', intent_class: 'observation'}), /D_ORIGIN_MISMATCH/);
  assert.throws(() => validateProcessed({...call, user_identity: 'someone-else'}), /D_ORIGIN_MISMATCH/);
});

test('attributed turns never request a native memory writer', async t => {
  const {storage, accept} = await setup(t);
  const bodies: {session: string; memory_write: boolean}[] = [];
  const native = {
    async create(body: {session_id: string}): Promise<NativeRun> {
      bodies.push({session: body.session_id, memory_write: Object.hasOwn(body,'memory_write')});
      return {run_id: `run-${bodies.length}`, session_id: body.session_id, conversation_session_id: body.session_id, status: 'completed'};
    },
    async status(runId: string): Promise<NativeRun> { return {run_id: runId, session_id: `s${runId.slice(4)}`, conversation_session_id: `s${runId.slice(4)}`, status: 'completed'}; },
    async cancel(runId: string): Promise<NativeRun> { return this.status(runId); },
  };
  const admission = new RunAdmission(storage, native, policy);
  await admission.recover();
  await admission.admit(await accept(raw('voice-turn:a', 'app_event', turn), 'owner_call_turn'), 's1', 'skill');
  await admission.admit(await accept(raw('typed-a', 'text', '记住'), 'explicit_text'), 's2', 'skill');
  await admission.admit(await accept(raw('app-a', 'app_event', turn), 'observation'), 's3', 'skill');
  for (let i = 0; i < 400 && bodies.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  // Join owned admission work before the temporary storage root is removed.
  await admission.close();
  assert.deepEqual(Object.fromEntries(bodies.map(b => [b.session, b.memory_write])), {s1: false, s2: false, s3: false});
});

test('L3 subject port: an owner call turn may name the principal as known_person; an unattributed observation may not', async t => {
  const {storage, archive, accept} = await setup(t);
  const commits: L3Command[] = [];
  const l3 = {receipt: async () => undefined, commit: async (command: L3Command, trusted: {context_ref: string}) => {
    commits.push(command);
    return {receipt_ref: `l3:owner:${command.command_id}`, command_id: command.command_id, payload_sha256: command.payload_sha256,
      status: 'committed', assertion_id: command.assertion.assertion_id, version: 1, previous_version: null,
      authority_watermark: '1', committed_at: '2026-10-08T00:00:00.000Z', invalidated: [], context_ref: trusted.context_ref};
  }};
  const processed = new Map<string, ProcessedEvent>();
  const tools = new MemoryToolAuthority({l3: l3 as never, archive, storage,
    lookupProcessed: async (_principal, dId) => processed.get(dId)});
  async function attempt(d: ProcessedEvent, id: string) {
    processed.set(d.processed_event_id, d);
    const ref = {event_id: d.event_id, processed_event_id: d.processed_event_id, raw_ref: d.raw_ref, archive_revision: d.archive_revision, time_range: d.time_range};
    const assertion: AssertionInput = {assertion_id: id, kind: 'preference', subject_ref: {type: 'known_person', id: 'owner'},
      predicate: 'likes', value: 'less sugar milk tea', scope: {principal_id: 'owner', purpose: 'errands', situation: 'ordering', role: 'customer', evaluation_frame: 'preference'},
      evidence_refs: [ref], evidence_status: 'available', unknown_conditions: [], conflicts: [], status: 'candidate',
      applicability_status: 'applicable', relation_to_peers: 'independent', typed_scores: {}, depends_on: []};
    const context: TrustedMemoryContext = {principal_id: 'owner', run_id: `run-${id}`, session_id: 'call-session', tool_call_id: 'tc-1', d};
    return tools.commit(context, {command_id: `cmd-${id}`, operation: 'create', expected_version: 0, assertion, evidence_refs: [ref]});
  }
  const receipt = await attempt(await accept(raw('voice-turn:m', 'app_event', turn), 'owner_call_turn'), 'tea-call') as unknown as {status: string; context_ref: string};
  assert.equal(receipt.status, 'committed'); assert.match(receipt.context_ref, /^tool:/); assert.equal(commits.length, 1);
  await assert.rejects(attempt(await accept(raw('app-m', 'app_event', turn), 'observation'), 'tea-observed'), /MEM_SUBJECT_UNRESOLVED/);
  assert.equal(commits.length, 1);
  assert.equal(((await attempt(await accept(raw('typed-m', 'text', '记住我喜欢少糖'), 'explicit_text'), 'tea-typed')) as {status: string}).status, 'committed');
});

test('explicit legacy import resumes without a new call or enabled collection and retains unresolved originals',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-legacy-'));
  let storage=new PosixStorage(join(root,'central-storage')),archive=new RawArchive(storage,100000);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const wave=Buffer.alloc(52);wave.write('RIFF');wave.writeUInt32LE(44,4);wave.write('WAVE',8);wave.write('fmt ',12);wave.writeUInt32LE(16,16);
  wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
  wave.write('data',36);wave.writeUInt32LE(8,40);for(let n=0;n<4;n++)wave.writeInt16LE(n*700-1000,44+n*2);
  const name='1700000000000-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',wavePath=`state/call-turns/${name}.wav`,photoPath='central-storage/visual-memory/frames/photo.jpg',photo=Buffer.from('exact retained photo bytes');
  await fs.mkdir(join(root,'state/call-turns'),{recursive:true});await fs.mkdir(join(root,'central-storage/visual-memory/frames'),{recursive:true});
  const thumbPath='central-storage/visual-memory/frames/photo-thumb.jpg',independentPath='central-storage/visual-memory/frames/z-independent.jpg',
    unresolvedPath='central-storage/visual-memory/frames/unresolved.jpg',pendingPath='central-storage/visual-memory/frames/deleted-pending.jpg',
    deletedPath='central-storage/visual-memory/frames/deleted-completed.jpg',pending=Buffer.from('pending owner deletion'),deleted=Buffer.from('completed owner deletion'),thumb=Buffer.from('derived thumbnail'),independent=Buffer.from('independent original'),unresolved=Buffer.from('unresolved');
  await fs.writeFile(join(root,wavePath),wave);await fs.writeFile(join(root,photoPath),photo);
  for(const [path,bytes] of [[thumbPath,thumb],[independentPath,independent],[unresolvedPath,unresolved],[pendingPath,pending],[deletedPath,deleted]] as const)await fs.writeFile(join(root,path),bytes);
  await fs.writeFile(join(root,`state/call-turns/${name}.json`),JSON.stringify({schema:'paios.call-turn.v1',at:'2023-11-14T22:13:20.000Z',label:'finished',probability:.8}));
  const catalog=join(root,'central-storage/visual-memory/visual.sqlite'),db=new DatabaseSync(catalog);
  db.exec("CREATE TABLE frames(id INTEGER PRIMARY KEY,principal_id TEXT,original TEXT,thumbnail TEXT,state TEXT,captured_ms INTEGER,owner_delete INTEGER);INSERT INTO frames VALUES(1,'owner','frames/photo.jpg','frames/photo-thumb.jpg','ready',1791936000000,0),(2,'owner','frames/deleted-pending.jpg','','deleting',1791936000000,1),(3,'owner','frames/deleted-completed.jpg','','deleting',1791936000000,2)");db.close();
  const entries=[{path:wavePath,payload:wave,media_type:'audio',mime:'audio/wav'},{path:photoPath,payload:photo,media_type:'visual',mime:'image/jpeg'},
    {path:thumbPath,payload:thumb,media_type:'visual',mime:'image/jpeg'},{path:independentPath,payload:independent,media_type:'visual',mime:'image/jpeg'},
    {path:unresolvedPath,payload:unresolved,media_type:'visual',mime:'image/jpeg'},
    {path:pendingPath,payload:pending,media_type:'visual',mime:'image/jpeg'},{path:deletedPath,payload:deleted,media_type:'visual',mime:'image/jpeg'}].map((value,index)=>{
    const {payload:_payload,...metadata}=raw(`legacy-${index}`,'text','');
    return {path:value.path,sha256:sha256(value.payload),evidence_ref:'established-fixture-provenance',trusted:{...device,submission:'observation'},
      raw:{...metadata,media_type:value.media_type,mime:value.mime}};
  });
  const manifest=join(root,'provenance.json'),report=join(root,'report.json');
  entries[4]!.sha256='0'.repeat(64);
  await fs.writeFile(manifest,JSON.stringify({schema:'paios.legacy-original-provenance.v1',entries}));
  let firstEvents:unknown;
  for(let n=0;n<2;n++){
    const result=await migrateLegacyOriginals(root,archive,manifest,report);
    assert.equal(result.resolved,3);assert.equal(result.unresolved,3);assert.equal(result.derived,1);
    assert.equal(result.rows.find(row=>row.path===thumbPath)?.status,'derived_retained');
    assert.equal(result.rows.find(row=>row.path===thumbPath)?.event,undefined);
    assert.equal(result.rows.find(row=>row.path===unresolvedPath)?.reason,'LEGACY_PROVENANCE_BINDING_INVALID');
    for(const [path,bytes,reason] of [[pendingPath,pending,'pending'],[deletedPath,deleted,'completed']] as const){
      const row=result.rows.find(row=>row.path===path)!;assert.equal(row.status,'unresolved');assert.equal(row.event,undefined);
      assert.equal(row.reason,`legacy_catalogue_owner_deletion_${reason}`);
      await assert.rejects(storage.read('objects',sha256(bytes)),{code:'ENOENT'});
    }
    const imported=result.rows.find(row=>row.path===independentPath)!.event as ArchivedEvent;
    assert.deepEqual(Buffer.from(await archive.read(imported.raw_ref,imported.principal_id,imported.archive_revision)),independent);
    assert.equal(imported.captured_at,entries[3]!.raw.captured_at);assert.equal(imported.principal_id,device.principal_id);
    const events=result.rows.filter(row=>row.status==='verified').map(row=>row.event);
    if(n===0)firstEvents=events;else assert.deepEqual(events,firstEvents);
    assert.deepEqual(JSON.parse(await fs.readFile(report,'utf8')).rows,result.rows);
    await archive.close();await storage.close();storage=new PosixStorage(join(root,'central-storage'));archive=new RawArchive(storage,100000);
  }
  entries[4]!.sha256=sha256(unresolved);await fs.writeFile(manifest,JSON.stringify({schema:'paios.legacy-original-provenance.v1',entries}));
  const resumed=await migrateLegacyOriginals(root,archive,manifest,report);assert.equal(resumed.resolved,4);assert.equal(resumed.unresolved,2);
  for(const [path,bytes] of [[thumbPath,thumb],[independentPath,independent],[unresolvedPath,unresolved],[pendingPath,pending],[deletedPath,deleted]] as const)assert.deepEqual(await fs.readFile(join(root,path)),bytes);
  assert.deepEqual(await fs.readFile(join(root,wavePath)),wave);assert.deepEqual(await fs.readFile(join(root,photoPath)),photo);
  const corpus=await readTurnCorpus(join(root,'state/call-turns'));assert.equal(corpus.length,1);
  assert.deepEqual([...await readTurnAudio(corpus[0]!,archive)],Array.from({length:4},(_,n)=>(n*700-1000)/32768));
  const reopened=new DatabaseSync(catalog),frame=reopened.prepare('SELECT original,raw_ref,payload_sha256 FROM frames').get()!;
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM frames').get()!.n,3,'independent originals do not fabricate catalogue rows');reopened.close();
  assert.equal(frame.original,'frames/photo.jpg');assert.match(String(frame.raw_ref),/^l5:/);assert.equal(frame.payload_sha256,sha256(photo));
  const lock_file=join(root,'central.lock'),configuration=join(root,'private-config.json'),release=await acquireProcessLock(lock_file);
  await fs.writeFile(configuration,JSON.stringify({storage_root:storage.root,max_event_bytes:100000,lock_file}));
  try{await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/turn-eval.ts',import.meta.url)),'--migrate-legacy',root,
    '--config',configuration,'--provenance',manifest,'--output',report]),/PERSONAL_AIOS_ALREADY_RUNNING/);}finally{await release();}
});
