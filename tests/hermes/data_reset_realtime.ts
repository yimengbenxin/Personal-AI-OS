/** Real T11B repository operations over the isolated PostgreSQL fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresPool } from '../../01-product-half-finished/backend/services/platform-data/src/postgres-pool.ts';
import { createProductionRealtimeIdentityPort } from '../../01-product-half-finished/backend/services/platform-data/src/realtime-identity-issuer.ts';
import { createRealtimeAuthorityRepository } from '../../01-product-half-finished/backend/services/platform-data/src/realtime-authority-repository.ts';

const [mode, configuration, continuity = '201'] = process.argv.slice(2);
const pool = createPostgresPool(JSON.parse(configuration!));
const repository = createRealtimeAuthorityRepository(pool);
const uid = (n: number) => '00000000-0000-7000-8000-' + String(n).padStart(12, '0');
const now = '2026-10-25T00:00:00.000Z';
const expires = '2099-01-01T00:00:00.000Z';
const identity = createProductionRealtimeIdentityPort({clock:{now:() => now as any}});
const ref = (kind: 'RealtimeSession' | 'DeviceLease', n: number) => {
  const payload = JSON.stringify({object_version:'1',ref_id:uid(n),ref_type:kind});
  const value = {ref_type:kind,ref_id:uid(n),object_version:'1',canonical_payload_sha256:
    createHash('sha256').update(`paios.t02.${kind}.repository-ref.v1\n${payload}`).digest('hex')};
  identity.assertRepositoryIssuedRef(value,kind);
  return value;
};
const session = (n: number, lease: number, device: number, c: number, epoch = '1') => {
  const realtimeSessionRef = ref('RealtimeSession', n), activeDeviceLeaseRef = ref('DeviceLease', lease);
  return {realtimeSessionRef, activeDeviceLeaseRef, activeDeviceId: uid(device), userId: uid(2), continuityId: uid(c),
    state: 'active', continuityState: 'active', connectionEpoch: epoch, revision: '1',
    continuityExpiresAt: expires, lastAcceptedUserActivityAt: now,
    binding: {realtimeSessionRef, deviceLeaseRef: activeDeviceLeaseRef, deviceId: uid(device), continuityId: uid(c),
      connectionEpoch: epoch, state: 'connected', provider: 'reset-fixture', transportSessionAlias: 'session-'+n,
      roomAlias: 'room-'+n, deviceAlias: 'device-'+device}};
};
const lease = (n: number, s: number, device: number, c: number) => ({deviceLeaseRef: ref('DeviceLease', n),
  realtimeSessionRef: ref('RealtimeSession', s), deviceId: uid(device), userId: uid(2), continuityId: uid(c),
  state: 'active', capabilities: ['audio'], purpose: 'assistant', policyDecisionRef: {synthetic: true},
  revocable: true, leaseVersion: '1', fencingToken: '1', issuedAt: now, expiresAt: expires});

try {
  if (mode === 'probe-invalid') {
    const failures = [];
    for (const id of [101, 501]) {
      const rows = await pool.query('SELECT realtime_session_ref, session_ref_id FROM realtime_sessions WHERE session_ref_id::text LIKE $1', ['%'+String(id).padStart(12,'0')]);
      if (!rows.rows[0]) continue;
      const badRef = {...ref('RealtimeSession', id), ref_id: rows.rows[0].session_ref_id};
      for (const [operation, invoke] of [
        ['readSession', (tx: any) => tx.readSession(badRef)],
        ['writeSession', (tx: any) => tx.writeSession({record: {...session(id,301,401,201), realtimeSessionRef: rows.rows[0].realtime_session_ref}})],
      ] as const) {
        await assert.rejects(repository.transaction('reset.probe', invoke), (error: Error) => {
          failures.push({id, operation, error: error.message}); return true;
        });
      }
    }
    assert(failures.length >= 2);
    console.log(JSON.stringify(failures));
  } else if (mode === 'triggers') {
    const listener = await pool.connect(), writer = await pool.connect();
    const notifications: any[] = [];
    listener.on('notification', message => notifications.push(JSON.parse(message.payload!)));
    await listener.query('LISTEN paios_accepted_activity_v1');
    const prototype = (await writer.query('SELECT row_to_json(t) AS row FROM outbox_events t LIMIT 1')).rows[0].row;
    try {
      for (const [index, role] of ['origin','replica'].entries()) {
        const enabled = continuity === 'A' || continuity === 'O' && role === 'origin' || continuity === 'R' && role === 'replica';
        await writer.query('SET session_replication_role = ' + role);
        const eventId = uid(950+index);
        const row = {...prototype,event_id:eventId,idempotency_key:'trigger-'+role,payload:{...prototype.payload,activityId:'trigger-'+role},
          accepted_activity_cursor:enabled ? null : 900+index};
        const inserted = await writer.query('INSERT INTO outbox_events SELECT (jsonb_populate_record(NULL::outbox_events,$1::jsonb)).* RETURNING accepted_activity_cursor',[JSON.stringify(row)]);
        assert(inserted.rows[0].accepted_activity_cursor);
        await new Promise(resolve => setTimeout(resolve,80));
        assert.equal(notifications.some(event => event.event_id === eventId), enabled);
        if (enabled) await assert.rejects(writer.query('INSERT INTO outbox_events SELECT (jsonb_populate_record(NULL::outbox_events,$1::jsonb)).*',
          [JSON.stringify({...row,event_id:uid(960+index),idempotency_key:'explicit-'+role,accepted_activity_cursor:999})]),
          /PAIOS_ACCEPTED_ACTIVITY_CURSOR_MUST_BE_DATABASE_ALLOCATED/);
      }
    } finally { await writer.query('SET session_replication_role=origin'); writer.release(); listener.release(); }
  } else if (mode === 'seed') {
    await repository.transaction('reset.seed', async tx => {
      await tx.writeSession({record: session(101,301,401,201) as any});
      await tx.writeSession({record: session(102,303,404,202) as any});
      for (const [n,s,d,c] of [[301,101,401,201],[302,101,403,201],[303,102,404,202]]) {
        await tx.writeLease({record: lease(n,s,d,c) as any});
      }
      for (const record of [session(101,301,401,201),session(102,303,404,202)]) {
        await tx.writeBinding({expectedConnectionEpoch:'1',binding:record.binding as any});
      }
    });
  } else if (mode === 'rebind') {
    const c = Number(continuity);
    await repository.transaction('reset.reconnect', async tx => {
      const old = await tx.readSession(ref('RealtimeSession',101)); assert(old);
      await tx.writeSession({expectedRevision: old.revision,
        record: {...old, state: 'terminal', revision: String(BigInt(old.revision)+1n), binding: {...old.binding,state:'released'}}});
      for (const n of [301,302]) {
        const oldLease = await tx.readLease(ref('DeviceLease',n)); assert(oldLease);
        await tx.writeLease({expectedLeaseVersion: oldLease.leaseVersion, record: {...oldLease,state:'released',
          leaseVersion:String(BigInt(oldLease.leaseVersion)+1n),fencingToken:String(BigInt(oldLease.fencingToken)+1n)}});
      }
      await tx.writeSession({record: session(501,601,401,c,'2') as any});
      await tx.writeLease({record: lease(601,501,401,c) as any});
      await tx.writeLease({record: lease(602,501,403,c) as any});
      await tx.writeBinding({expectedConnectionEpoch:'2',binding: session(501,601,401,c,'2').binding as any});
    });
  } else if (mode === 'use') {
    await repository.transaction('reset.restored.use', async tx => {
      const current = await tx.readSession(ref('RealtimeSession',501)); assert(current);
      assert.equal(current.state,'active'); assert.equal(current.connectionEpoch,'2');
      for (const n of [601,602]) { const row = await tx.readLease(ref('DeviceLease',n)); assert(row); assert.equal(row.state,'active'); }
      await tx.writeBinding({expectedConnectionEpoch:current.connectionEpoch,binding:current.binding});
      await tx.writeSession({expectedRevision:current.revision,record:{...current,revision:String(BigInt(current.revision)+1n)}});
      const renewed = await tx.readSession(current.realtimeSessionRef); assert(renewed);
      assert.equal(BigInt(renewed.revision),BigInt(current.revision)+1n);
    });
  } else throw new Error('unknown realtime fixture mode');
  if (mode !== 'probe-invalid') console.log(JSON.stringify({mode,repository:true}));
} finally { await pool.end(); }
