import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeCredentialFence, credentialFenceLockKey } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { RealtimeSessionService } from '../../../services/realtime-core/src/realtime-session-service.ts';
import { applyMediaStop } from '../../../services/realtime-core/src/media-stop-service.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import { createSourceMediaPermission } from '../src/source-media-permission.ts';
import { createSourceMediaAdmission } from '../src/source-media-admission.ts';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { RawArchive } from '../../../services/personal-aios-integration/src/archive.ts';
import { StreamArchive, type TrackChunk } from '../../../services/personal-aios-integration/src/stream-archive.ts';
import { MediaService } from '../../../services/personal-aios-integration/src/media/service.ts';
import { MediaProcessor } from '../../../services/personal-aios-integration/src/media/processing.ts';
import { digest, sha256, type RawEvent, type TrustedContext } from '../../../services/personal-aios-integration/src/contracts.ts';
import {fileURLToPath} from 'node:url';
const poolFor = (url: string) => {
  const value = new URL(url);
  const pool = createPostgresPool({ host: value.hostname, port: Number(value.port), database: value.pathname.slice(1),
    user: decodeURIComponent(value.username), password: decodeURIComponent(value.password), max: 4 });
  const startup=value.searchParams.get('options'),schema=startup?.match(/^-c search_path=(paios_fixture_[a-f0-9]+)$/)?.[1];
  if(schema){pool.options.options=startup!;pool.options.application_name='media-fixture-'+schema;
    // The existing migrations and fence name public explicitly; bind those SQL names to this fixture's schema.
    pool.on('connect',client=>{const query=client.query.bind(client);
      client.query=((sql,...args)=>query(typeof sql==='string'?sql.replaceAll('public.',schema+'.').replaceAll("'public'","'"+schema+"'"):sql,...args)) as typeof client.query;});}
  return pool;
};
const database = process.env.PAIOS_MEDIA_TEST_DATABASE_URL??process.env.PAIOS_L3_TEST_DATABASE_URL;
const schemaFixture=process.env.PAIOS_MEDIA_TEST_DATABASE_URL===undefined;
const at = (minute: number) => new Date(Date.parse('2030-01-01T00:00:00.000Z') + minute * 60_000).toISOString();
const ref = (type: 'RealtimeSession' | 'DeviceLease', id: string) => ({ ref_type: type, ref_id: id, object_version: '1', canonical_payload_sha256: 'a'.repeat(64) });
const session = ref('RealtimeSession', '01900000-0000-7000-8000-000000000001');
const lease = ref('DeviceLease', '01900000-0000-7000-8000-000000000002');
const owner = '01900000-0000-7000-8000-000000000003';
const device = '01900000-0000-7000-8000-000000000004';
const continuity = '01900000-0000-7000-8000-000000000005';
const binding = { realtimeSessionRef: session, deviceLeaseRef: lease, continuityId: continuity,
  connectionEpoch: '1', userId: owner, deviceId: device, purpose: 'assistant' };
function connect(url: string) {
  const pool = poolFor(url);
  const repository = createRealtimeAuthorityRepository(pool);
  const fence = createRealtimeCredentialFence(pool);
  const equality = createProductionStructuralEquality();
  const permission = createSourceMediaPermission({
    readCurrentBinding: (lookup) => repository.transaction('media.read', (tx) => tx.readCurrentBinding(lookup)),
    readCurrentBindingInAdmission:(client,lookup)=>repository.readCurrentBindingInTransaction(client,lookup),
    equality, credentialFence: fence, now: () => at(11) });
  return { pool, repository, fence, equality, permission };
}

if (process.env.PAIOS_MEDIA_CHILD_URL) {
  const c = connect(process.env.PAIOS_MEDIA_CHILD_URL);
  try {
    const storage = new PosixStorage(process.env.PAIOS_MEDIA_CHILD_ARCHIVE!);
    const current = await c.repository.transaction('media-test.read',tx=>tx.readCurrentBinding({realtimeSessionRef:session}));
    const expectedTuple = {...binding,credentialGeneration:current!.lease.leaseVersion};
    const publish = storage.publish.bind(storage);
    storage.publish = async (namespace,key,bytes) => {
      const other = await c.pool.connect();
      try {
        await other.query('BEGIN');
        const lock = await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          [credentialFenceLockKey({realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:continuity,
            connectionEpoch:binding.connectionEpoch,credentialGeneration:expectedTuple.credentialGeneration})]);
        assert.equal(lock.rows[0]!.acquired,true); // Admission has committed before original-byte publication.
      } finally { await other.query('ROLLBACK');other.release(); }
      return publish(namespace,key,bytes);
    };
    const budget = { max_chunk_bytes: 10000, max_total_bytes: 100000, max_chunks: 20, max_revisions: 20, max_seq: 20 };
    const streamArchive = new StreamArchive(storage, budget);
    const archive = new RawArchive(storage, 10000, undefined, budget);
    const trusted: TrustedContext = {principal_id:owner, device_id:device, device_type:'glasses', consent_ref:'fixture',
      channel:'controlled-authenticated-rtc-fixture', submission:'observation'};
    const raw: RawEvent = {schema_version:'paios.event.v1', event_id:'controlled-pg-stream', device_id:device,
      device_type:'glasses', captured_at:at(11), source:{channel:trusted.channel}, media_type:'audio',
      mime:'audio/pcm', representation:'received_decoded_sample', payload:Buffer.alloc(3200)};
    const chunk: TrackChunk = {track_id:'mic', stream_epoch:'fixture-epoch', seq:0, modality:'audio',
      format:'pcm_s16le:16000:1', source_range:{kind:'interval', timebase_id:'fixture-source-clock',
        stream_epoch:'fixture-epoch', start_ms:0, end_ms:100}};
    const admission = createSourceMediaAdmission({ permission:c.permission,
      source:{capture:async()=>({binding:binding as never,trusted})},
      clock:{read:async()=>({modality:'audio', track_id:'mic',stream_epoch:'fixture-epoch',
        source_timebase_id:'fixture-source-clock',target_timebase_id:'utc_epoch_ms',offset_ms:Date.parse(at(11)),
        drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-fixture-not-hardware-calibration'})},
      requestTeardown:async()=>{} });
    const processor = new MediaProcessor(storage,new Map(),{policy_version:'fixture',max_inflight:1,max_input_bytes:10000,
      timeout_ms:100,allow_external:false,allow_replay:true,allow_partial:true});
    const media = new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>{throw new Error('ML forbidden');},
      align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:200,
      ...admission});
    const result = await media.append(raw,trusted,chunk);
    assert.equal((await archive.locate(result.event.raw_ref,owner)).archive_revision,result.event.archive_revision);
    const read = await archive.readRecord(result.event.raw_ref,owner,result.event.archive_revision);
    assert.equal(read.kind,'stream');
    if(read.kind==='stream') { assert.equal(sha256(read.chunks[0]!.bytes),sha256(raw.payload));
      assert.deepEqual(read.chunks[0]!.chunk.source_range,chunk.source_range); }
    assert.equal((await media.append(raw,trusted,chunk)).event.archive_revision,result.event.archive_revision);
    process.stdout.write(JSON.stringify({ status: 'accepted', until: (await c.permission.read(binding as never)).authorizedMediaUntil }));
  } catch (error) { process.stdout.write(JSON.stringify({ status: 'denied', code: (error as Error).message })); }
  finally { await c.pool.end(); }
} else test('real PG source producer and media admission survive restart; expiry, epoch, revoke deny',
  { skip: database === undefined }, async t => {
    if(schemaFixture){const local=new URL(database!);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'55439');assert.equal(local.username,'l3test');assert.equal(local.pathname,'/postgres');}
    const admin = poolFor(database!);
    const name = (schemaFixture?'paios_fixture_':'media_') + randomUUID().replaceAll('-', '');
    await admin.query((schemaFixture?'CREATE SCHEMA ':'CREATE DATABASE ') + name);
    const url = new URL(database!);if(schemaFixture)url.searchParams.set('options','-c search_path='+name);else url.pathname = '/' + name;
    const c = connect(url.href);
    const archiveDirectory = await mkdtemp(join(tmpdir(),'paios-media-pg-'));
    let now = at(0);
    const service = new RealtimeSessionService({ repository: c.repository, equality: c.equality,
      clock: { now: () => now as never }, policy: { evaluate: async () => ({ allowed: true,
        capabilities: ['audio', 'video'], purpose: 'assistant', leaseExpiresAt: at(30) as never,
        revocable: true, policyDecisionRef: 'policy' }) },
      activityAcceptance: { verify: async () => { throw new Error('unused'); } },
      transportDisconnection: { verify: async () => { throw new Error('unused'); } },
      identity: { createContinuityId: () => continuity, createSessionRef: () => session,
        createDeviceLeaseRef: () => lease, assertRepositoryIssuedRef: () => undefined,
        createTransportAlias: ({ requestId }) => 'alias-' + requestId,
        createConnectionId: ({ requestId }) => 'connection-' + requestId } });
    const child = async () => {
      const proc = spawn(process.execPath, [fileURLToPath(import.meta.url)],
        { env: { ...process.env, PAIOS_MEDIA_CHILD_URL: url.href, PAIOS_MEDIA_CHILD_ARCHIVE:archiveDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
      let result = ''; let errors = '';
      proc.stdout.on('data', (chunk) => { result += chunk; }); proc.stderr.on('data', (chunk) => { errors += chunk; });
      const status = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
      assert.equal(status, 0, errors); return JSON.parse(result);
    };
    try {
      for (const migration of ['0001_idempotency_outbox', '0002_realtime_authority', '0008_realtime_credential_fence']) {
        await c.pool.query(await readFile(new URL('../../../migrations/' + migration + '.up.sql', import.meta.url), 'utf8'));
      }
      const started = await service.bootstrap({ mode: 'initial', requestId: 'media-start', idempotencyKey: 'media-start',
        userId: owner, deviceId: device, capabilities: ['audio', 'video'], purpose: 'assistant',
        occurredAt: now as never, governance: 'policy' });
      now = at(9);
      await service.refresh({ requestId: 'media-refresh', idempotencyKey: 'media-refresh',
        binding: started.binding, occurredAt: now as never, governance: 'policy' });
      assert.deepEqual(await child(), { status: 'accepted', until: at(30) });
      assert.deepEqual(await child(), { status: 'accepted', until: at(30) }); // Fresh process reads and deduplicates actual L5 bytes.
      await assert.rejects(c.permission.withPermission({ ...binding, connectionEpoch: '2' } as never,
        'audio', async () => 'bad'), /MEDIA_CURRENT_BINDING_MISMATCH/);
      await c.pool.query('UPDATE device_leases SET expires_at=$1 WHERE lease_ref_id=$2', [at(10), lease.ref_id]);
      assert.deepEqual(await child(), { status: 'denied', code: 'LEASE_EXPIRED' });
      await c.pool.query("UPDATE device_leases SET expires_at=$1,state='revoked' WHERE lease_ref_id=$2", [at(30), lease.ref_id]);
      // T02 rejects the active-binding/revoked-lease contradiction before media admission.
      assert.deepEqual(await child(), { status: 'denied', code: 'REALTIME_AUTHORITY_CONFLICT' });
      await c.pool.query("UPDATE device_leases SET state='active' WHERE lease_ref_id=$1", [lease.ref_id]);
      const permission = await c.permission.read(binding as never);
      await c.permission.withPermission(binding as never,'audio',async lockedPermission=>{
        const other = await c.pool.connect();
        try {
          await other.query('BEGIN');
          const attempt = await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
            [credentialFenceLockKey(lockedPermission.credentialFenceTuple)]);
          assert.equal(attempt.rows[0]!.acquired,true); // Stop can proceed while previously admitted bytes finish archival.
        } finally { await other.query('ROLLBACK');other.release(); }
        const storage = new PosixStorage(archiveDirectory);
        const archive = new RawArchive(storage,10000,undefined,
          {max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20});
        const rawRef = `l5:${digest({event_id:'controlled-pg-stream',principal_id:owner,device_id:device})}`;
        const record = await archive.readRecord(rawRef,owner,(await archive.locate(rawRef,owner)).archive_revision);
        assert.equal(record.kind,'stream');
      });
      // Use the actual durable external-effect authority table as the Stop fence.
      const stopClient = await c.pool.connect();
      try {
      await stopClient.query('BEGIN');
      await c.fence.install(stopClient,permission.credentialFenceTuple);
      await stopClient.query(`INSERT INTO realtime_external_effects(effect_id,operation,request_scope,idempotency_key,
        fingerprint,fingerprint_sha256,wire_request,intent,claim_id,fencing_epoch,effect_state,stage_state,realtime_session_ref,
        device_lease_ref,continuity_id,connection_epoch,credential_generation)
        VALUES($1,'media_stop','realtime.external.media_stop','media-stop','media-stop',$2,'{}','{}',$3,1,'committed','{}',$4,$5,$6,1,$7)`,
        [randomUUID(), 'a'.repeat(64), 'claim-' + randomUUID(), session, lease, continuity, permission.credentialFenceTuple.credentialGeneration]);
      await stopClient.query('COMMIT');
      } finally { await stopClient.query('ROLLBACK');stopClient.release(); }
      assert.deepEqual(await child(), { status: 'denied', code: 'CREDENTIAL_FENCE_ACTIVE' });
      // Lost append ACK is resolved from immutable archive evidence, never reinterpreted as fresh capture.
      const storage = new PosixStorage(archiveDirectory);
      const archive = new RawArchive(storage,10000,undefined,
        {max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20});
      const rawRef = `l5:${digest({event_id:'controlled-pg-stream',principal_id:owner,device_id:device})}`;
      const located = await archive.locate(rawRef,owner);
      const stored = await archive.readRecord(rawRef,owner,located.archive_revision);
      assert.equal(stored.kind,'stream');
      if(stored.kind==='stream')assert.equal(sha256(stored.chunks[0]!.bytes),sha256(Buffer.alloc(3200)));
      await assert.rejects(archive.locate(rawRef,'different-owner'),/RAW_ACCESS_DENIED/);
      await t.test('current binding read waits for Stop and returns a coherent session and lease',async()=>{
        const written=Promise.withResolvers<void>(),commit=Promise.withResolvers<void>();
        const stopping=c.repository.transaction('media-test.stop',async tx=>{
          const current=await tx.readCurrentBinding({realtimeSessionRef:session});assert.ok(current);
          const transition=applyMediaStop({session:current.session,lease:current.lease,
            request:{operation:'media_stop',deviceId:device,expectedConnectionEpoch:'1',expectedLeaseVersion:current.lease.leaseVersion} as never,
            sameRef:(a,b)=>c.equality.same(a,b),receipt:{} as never});
          await tx.writeSession({expectedRevision:current.session.revision,record:transition.session});
          await tx.writeLease({expectedLeaseVersion:current.lease.leaseVersion,record:transition.lease});
          await tx.writeBinding({expectedConnectionEpoch:current.session.connectionEpoch,binding:transition.session.binding});
          written.resolve();await commit.promise;
        });
        await written.promise;
        const reading=c.repository.transaction('media-test.read-during-stop',tx=>tx.readCurrentBinding({realtimeSessionRef:session}))
          .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
        try{
          const deadline=Date.now()+5000;let blocked=false;
          while(Date.now()<deadline){
            const waiting=await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND datname=$2 AND wait_event_type='Lock' AND query LIKE 'SELECT s.session_ref_id%') AS blocked",
              [schemaFixture?'media-fixture-'+name:'personal-ai-os-platform-data',schemaFixture?'postgres':name]);
            if(waiting.rows[0].blocked){blocked=true;break;}
            await new Promise(resolve=>setTimeout(resolve,5));
          }
          assert.ok(blocked,'current binding read waits on the session lock held by Stop');
        }finally{commit.resolve();await stopping;}
        const raced=await reading;assert.ifError(raced.error);
        assert.equal(raced.value?.session.binding.state,'released');assert.equal(raced.value?.lease.state,'released');
      });
    } finally {
      await c.pool.end(); await admin.query((schemaFixture?'DROP SCHEMA ':'DROP DATABASE ') + name+(schemaFixture?' CASCADE':'')); await admin.end();
      await rm(archiveDirectory,{recursive:true,force:true});
    }
  });
