import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {ContractError, type RawEvent} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import type {SpeechEngine} from '../src/voiceprint/contracts.ts';
import {SPEAKER_WINDOW_SAMPLES} from '../src/voiceprint/contracts.ts';
import type {UtteranceRef} from '../src/payment/contracts.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {VoiceprintPaymentVerifier} from '../src/voiceprint/payment-verify.ts';
import {controlledDetector} from './speech-fixture.ts';

// A13 coverage is limited to I5's speaker-evidence and same-terminal clauses.
// These scorer tests do not establish locks, freshness, limits, grant authority, replay prevention or I8/I16.
const AT = '2026-10-15T08:00:00.000Z', T0 = Date.parse(AT);
const MODEL = {id: 'payment-fixture', sha256: 'e'.repeat(64), dim: 16};
const vector = (slot: number) => Float32Array.from({length: MODEL.dim}, (_, i) => Number(i === slot));
const pcm = (marker: number, ms: number) => {
  const out = Buffer.alloc(ms * 32);
  for (let n = 0; n < out.length; n += 2) out.writeInt16LE(marker, n);
  return out;
};
async function fixture(t: test.TestContext, registryOptions: ConstructorParameters<typeof VoiceprintRegistry>[2] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'paios-payment-voice-'));
  const storage = new PosixStorage(root), registry = new VoiceprintRegistry(storage, MODEL, registryOptions);
  const budget = {max_chunk_bytes: 512000, max_total_bytes: 2048000, max_chunks: 128, max_revisions: 128, max_seq: 128};
  const archive = new RawArchive(storage, budget.max_chunk_bytes, () => AT, budget), streams = new StreamArchive(storage, budget);
  t.after(async () => {await archive.close(); await registry.close(); await storage.close(); await rm(root, {recursive: true, force: true});});
  await registry.enrollOwner({speaker_model: MODEL, channel: 'glasses', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(0), speech_ms: 2000})), at: AT});
  const embedded: Float32Array[] = [];
  const engine: SpeechEngine = {speaker_model: MODEL, asr_model: {id: 'unused', sha256: 'f'.repeat(64)},
    transcribe: async () => {throw new Error('payment must not transcribe again');}, close: async () => {},
    embed: async samples => {
      embedded.push(samples.slice()); const out = new Float32Array(MODEL.dim);
      for (const value of samples) {
        const marker = Math.round(value * 32768);
        if (marker === 4000) {out[0]! += 0.55; out[3]! += Math.sqrt(1 - 0.55 ** 2);}
        else if (marker !== 5000 && marker !== 0) out[marker / 1000 - 1]! += 1;
      }
      return out;
    }};
  const reads: Parameters<RawArchive['readRecord']>[] = [], located: string[] = [];
  const port = {readRecord: async (...args: Parameters<RawArchive['readRecord']>) => {reads.push(args); return archive.readRecord(...args);},
    locate: async (ref: string, principal: string) => {located.push(ref); return archive.locate(ref, principal);}};
  const options = {archive: port, registry, engine: async () => engine, detector: controlledDetector(), carrier_ms: 1500, max_read_bytes: 512000,
    clock_map: async (_principal: string, _u: import('../src/voiceprint/payment-verify.ts').VoiceprintAudioRef, record: Awaited<ReturnType<RawArchive['readRecord']>> & {kind: 'stream'}) => {
      const first = record.manifest.chunks[0]!;
      return {modality: 'audio' as const, track_id: first.track_id, stream_epoch: first.stream_epoch,
        source_timebase_id: first.source_range.timebase_id, target_timebase_id: 'utc_epoch_ms', offset_ms: T0,
        drift_ppm: 0, uncertainty_ms: 0, basis_ref: 'fixture-server-clock'};
    }};
  let serial = 0;
  const record = async (bytes: Buffer, device_id = 'glasses', device_type: 'glasses'|'phone' = 'glasses'): Promise<UtteranceRef> => {
    const epoch = `utterance-${serial++}`;
    const raw: RawEvent = {schema_version: 'paios.event.v1', event_id: epoch, device_id, device_type, captured_at: AT,
      source: {channel: 'fixture'}, media_type: 'audio', mime: 'audio/pcm', representation: 'received_decoded_sample', payload: bytes};
    // Complete original chunks deliberately straddle the utterance's requested span.
    let last: Awaited<ReturnType<StreamArchive['append']>>|undefined;
    for (let at = 0, seq = 0; at < bytes.length; at += 32768, seq++) {
      const part = bytes.subarray(at, at + 32768);
      last = await streams.append({...raw, payload: part}, {principal_id: 'owner', device_id, device_type,
        channel: 'fixture', consent_ref: 'fixture', submission: 'observation'}, AT,
      {track_id: 'mic', stream_epoch: epoch, seq, modality: 'audio', format: 'pcm_s16le:16000:1',
        source_range: {kind: 'interval', timebase_id: 'samples', stream_epoch: epoch, start_ms: at / 32, end_ms: (at + part.length) / 32}});
    }
    return {device_id, device_type, raw_ref: last!.event.raw_ref, archive_revision: last!.event.archive_revision,
      start_ms: T0, end_ms: T0 + bytes.length / 32, captured_at: AT};
  };
  return {storage, registry, options, verifier: new VoiceprintPaymentVerifier(options), record, embedded, reads, located};
}

test('I5 speaker-evidence clause: owner check uses voiced carrier, pinned L5 ranges and verify-only registry', async t => {
  const f = await fixture(t);
  const initiating = await f.record(Buffer.concat([pcm(0, 320), pcm(1000, 1600), pcm(0, 320), pcm(1000, 1600), pcm(0, 320)]));
  const pay = await f.record(Buffer.concat([pcm(0, 128), pcm(1000, 640), pcm(0, 128)]));
  const key = (await f.storage.list('voiceprints'))[0]!, before = await f.storage.read('voiceprints', key);
  const result = await f.verifier.verifyPay('owner', initiating, pay);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.initiating, {score: 1, speech_ms: 3200});
  assert.deepEqual(result.pay, {score: null, speech_ms: 640});
  assert.deepEqual(result.combined, {score: 1, speech_ms: 2140});
  assert.deepEqual(f.embedded.map(s => s.length), [25600, 25600, 10240, 34240]);
  assert.ok(f.embedded.every(s => s.every(value => value === 1000 / 32768)), 'silence never lends speech duration');
  assert.equal(result.channel, 'glasses'); assert.equal(result.speaker_model, MODEL.id);
  assert.equal(f.reads.length, 4);
  assert.deepEqual(f.located, [], 'a supplied revision never invokes locate');
  for (const args of f.reads) {
    assert.equal(args[1], 'owner'); assert.equal(args[3]!.maxReadBytes, f.options.max_read_bytes);
    assert.equal(args[2], args[0] === initiating.raw_ref ? initiating.archive_revision : pay.archive_revision);
  }
  assert.deepEqual(f.reads[1]![3]!.track_ids, ['mic']);
  assert.deepEqual(await f.storage.read('voiceprints', key), before, 'no centroid or registry mutation');
  assert.equal(JSON.stringify(result).includes('embedding'), false, 'verdict carries scores, never embeddings or PCM');
  assert.equal((await f.verifier.verifyInitiating('owner', initiating)).verdict, 'pass');
});

test('payment voice confirmation becomes stricter with its enrolled channel verified line',async t=>{
  const f=await fixture(t),engine=await f.options.engine(),probe=vector(0);
  probe[0]=.66;probe[3]=Math.sqrt(1-.66**2);
  const verifier=new VoiceprintPaymentVerifier({...f.options,engine:async()=>({...engine,embed:async()=>probe})});
  const initiating=await f.record(pcm(1000,2400)),pay=await f.record(pcm(1000,640));
  assert.equal((await verifier.verifyPay('owner',initiating,pay)).verdict,'pass');
  await f.registry.enrollOwner({speaker_model:MODEL,channel:'glasses',mode:'add',
    samples:Array.from({length:15},()=>({embedding:vector(0),speech_ms:2000})),at:AT});
  assert.equal((await verifier.verifyPay('owner',initiating,pay)).verdict,'uncertain');
});

for (const stage of ['initiating', 'combined'] as const) test(`payment rejects learned call-only identity at ${stage} verification`, async t => {
  const f = await fixture(t), identify = f.registry.identify.bind(f.registry);
  let calls = 0;
  t.mock.method(f.registry, 'identify', async (...args: Parameters<typeof identify>) => {
    calls++;
    return calls === (stage === 'initiating' ? 1 : 2)
      ? {kind: 'owner' as const, band: 'verified' as const, score: 1, call_only: true as const}
      : identify(...args);
  });
  const result = await f.verifier.verifyPay('owner', await f.record(pcm(1000, 2400)), await f.record(pcm(1000, 640)));
  assert.equal(result.verdict, 'uncertain');
  assert.equal(calls, stage === 'initiating' ? 1 : 2);
});

test('I5 speaker-evidence clause: another or uncertain initiating speaker cannot borrow an owner pay sentence', async t => {
  const f = await fixture(t), pay = await f.record(pcm(1000, 640));
  await f.registry.identify(vector(1), {mode: 'observe', speech_ms: 3000, observed_at: AT});
  for (const [marker, verdict, reason] of [[2000, 'fail', 'other_speaker'], [4000, 'uncertain', undefined],
    [5000, 'insufficient', 'low_quality']] as const) {
    const result = await f.verifier.verifyPay('owner', await f.record(pcm(marker, 2400)), pay);
    assert.equal(result.verdict, verdict); assert.equal(result.reason, reason); assert.equal(result.pay, undefined);
    if (result.initiating.score !== null) assert.equal(result.initiating.score, Math.round(result.initiating.score * 100) / 100);
  }
});

test('I5 speaker-evidence clause: short pay must reach the registry uncertain band', async t => {
  const f = await fixture(t), initiating = await f.record(pcm(1000, 2400));
  const stranger = await f.record(pcm(2000, 640));
  assert.equal((await f.verifier.verifyPay('owner', initiating, stranger)).verdict, 'uncertain');
  for (const [bytes, reason] of [[pcm(1000, 300), 'too_short'], [pcm(0, 640), 'no_speech']] as const) {
    const result = await f.verifier.verifyPay('owner', initiating, await f.record(bytes));
    assert.equal(result.verdict, 'insufficient'); assert.equal(result.reason, reason); assert.equal(result.combined, undefined);
  }
  const short = await f.verifier.verifyInitiating('owner', await f.record(pcm(1000, 300)));
  assert.equal(short.verdict, 'insufficient'); assert.equal(short.reason, 'too_short');
});

test('I5 speaker-evidence clause: assistant and combined non-owner speech fail without creating profiles', async t => {
  const f = await fixture(t);
  await f.registry.observeAssistant({voice: 'fixture_tts', embedding: vector(2), speech_ms: 2400, at: AT});
  await f.registry.identify(vector(1), {mode: 'observe', speech_ms: 3000, observed_at: AT});
  const initiating = await f.record(pcm(1000, 2400));
  const assistant = await f.verifier.verifyInitiating('owner', await f.record(pcm(3000, 2400)));
  assert.deepEqual([assistant.verdict, assistant.reason], ['fail', 'assistant_voice']);
  const other = await f.verifier.verifyPay('owner', initiating, await f.record(pcm(2000, 4000)));
  assert.deepEqual([other.verdict, other.reason], ['fail', 'other_speaker']);
  assert.equal((await f.registry.clusters()).length, 1);
});

test('I5 speaker-evidence clause: different terminal and unavailable evidence never pass', async t => {
  const f = await fixture(t), initiating = await f.record(pcm(1000, 2400));
  const different = await f.verifier.verifyPay('owner', initiating, await f.record(pcm(1000, 640), 'phone', 'phone'));
  assert.deepEqual([different.verdict, different.reason], ['unavailable', 'different_terminal']);
  for (const [principal, u] of [['owner', {...initiating, raw_ref: `l5:${'f'.repeat(64)}`}], ['stranger', initiating],
    ['owner', {...initiating, device_id: 'forged'}], ['owner', {...initiating, end_ms: initiating.end_ms + 100}]] as const) {
    const result = await f.verifier.verifyInitiating(principal, u);
    assert.deepEqual([result.verdict, result.reason], ['unavailable', 'audio_missing']);
  }
  const unavailable = new VoiceprintPaymentVerifier({...f.options, engine: async () => {throw new ContractError('SPEECH_ENGINE_UNAVAILABLE', 503);}});
  assert.equal((await unavailable.verifyInitiating('owner', initiating)).reason, 'engine_unavailable');
  const stale = new VoiceprintRegistry(f.storage, {...MODEL, sha256: 'd'.repeat(64)});
  const noLiveSet = new VoiceprintPaymentVerifier({...f.options, registry: stale});
  assert.equal((await noLiveSet.verifyInitiating('owner', initiating)).reason, 'not_enrolled'); await stale.close();
  await f.registry.forgetOwner();
  assert.equal((await f.verifier.verifyInitiating('owner', initiating)).reason, 'not_enrolled');
});

test('A6 archived selection: UTC subspan is cut before VAD; an absent revision uses explicit locate', async t => {
  const f = await fixture(t);
  const full = await f.record(Buffer.concat([pcm(2000, 1024), pcm(1000, 2048), pcm(2000, 1024)]));
  const {archive_revision: _revision, ...withoutRevision} = full;
  const result = await f.verifier.verifyInitiating('owner', {...withoutRevision, start_ms: T0 + 1024, end_ms: T0 + 3072});
  assert.deepEqual([result.verdict, result.initiating.speech_ms], ['pass', 2048]);
  assert.deepEqual(f.located, [full.raw_ref]);
  const controller = new AbortController(); controller.abort(new Error('owner cancelled'));
  await assert.rejects(f.verifier.verifyInitiating('owner', full, controller.signal), /owner cancelled/);
});

test('A6 archived selection: fractional UTC endpoints and synthetic drift retain the source sample span', async t => {
  const f = await fixture(t), u = await f.record(pcm(1000, 3200));
  const offset = T0 + 0.25, scale = 1.001;
  const verifier = new VoiceprintPaymentVerifier({...f.options, clock_map: async (...args) =>
    ({...await f.options.clock_map(...args), offset_ms: offset, drift_ppm: 1000})});
  const result = await verifier.verifyInitiating('owner', {...u, start_ms: offset, end_ms: offset + 3200 * scale});
  assert.deepEqual([result.verdict, result.initiating.speech_ms], ['pass', 3200]);
});

test('A6 cancellation: abort during VAD yields no completed verdict', async t => {
  const f = await fixture(t), u = await f.record(pcm(1000, 2400)), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const verifier = new VoiceprintPaymentVerifier({...f.options,
    detector: controlledDetector({write: async () => {entered.resolve(); await release.promise;}})});
  const controller = new AbortController(), result = verifier.verifyInitiating('owner', u, controller.signal);
  await entered.promise; controller.abort(new Error('owner cancelled')); release.resolve();
  await assert.rejects(result, /owner cancelled/);
});

test('A6 cancellation: abort during engine or clock setup starts no later PCM read', async t => {
  for (const stage of ['engine', 'clock'] as const) {
    const f = await fixture(t), u = await f.record(pcm(1000, 2400)), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const options = {...f.options};
    if (stage === 'engine') options.engine = async () => {entered.resolve(); await release.promise; return f.options.engine();};
    else options.clock_map = async (...args) => {entered.resolve(); await release.promise; return f.options.clock_map(...args);};
    const controller = new AbortController(), result = new VoiceprintPaymentVerifier(options).verifyInitiating('owner', u, controller.signal);
    await entered.promise; controller.abort(new Error('owner cancelled')); release.resolve();
    await assert.rejects(result, /owner cancelled/);
    assert.equal(f.reads.filter(args => !args[3]!.proof_only).length, 0, stage);
  }
});

test('A6 read budget: oversized stream without revision reads only the bounded selection', async t => {
  const f = await fixture(t), full = await f.record(Buffer.concat([pcm(1000, 1024), pcm(2000, 4096)]));
  const header = await f.options.archive.readRecord(full.raw_ref, 'owner', full.archive_revision!, {proof_only: true});
  assert.equal(header.kind, 'stream'); if (header.kind !== 'stream') return;
  const {archive_revision: _revision, ...unversioned} = full, payloadReads: number[] = [];
  const read = f.storage.read.bind(f.storage);
  t.mock.method(f.storage, 'read', async (namespace: string, key: string) => {
    const bytes = await read(namespace, key); if (namespace === 'objects') payloadReads.push(bytes.length); return bytes;
  });
  const verifier = new VoiceprintPaymentVerifier({...f.options, max_read_bytes: 32768});
  const window = {...unversioned, end_ms: T0 + 1024};
  assert.equal((await verifier.verifyInitiating('owner', window)).verdict, 'pass');
  assert.deepEqual(payloadReads, [32768], 'metadata lookup adds no payload I/O to the one overlapping chunk');
  assert.ok(header.total_bytes > 32768);
  // An unavailable chunk outside the selected span must not prevent verification.
  await unlink(join(f.storage.root, 'objects', header.manifest.chunks[1]!.object_hash)); payloadReads.length = 0;
  assert.equal((await verifier.verifyInitiating('owner', window)).verdict, 'pass');
  assert.deepEqual(payloadReads, [32768]);
});

test('A6 missing selected chunk: unavailable audio returns audio_missing before embedding', async t => {
  const f = await fixture(t), u = await f.record(pcm(1000, 2400));
  const header = await f.options.archive.readRecord(u.raw_ref, 'owner', u.archive_revision!, {proof_only: true});
  assert.equal(header.kind, 'stream'); if (header.kind !== 'stream') return;
  await unlink(join(f.storage.root, 'objects', header.manifest.chunks[0]!.object_hash));
  const result = await f.verifier.verifyInitiating('owner', u);
  assert.deepEqual([result.verdict, result.reason], ['unavailable', 'audio_missing']);
  assert.equal(f.embedded.length, 0);
});

test('I5 evidence binding: wrong speaker model or denied source clock never reaches PCM inference', async t => {
  for (const boundary of ['model', 'clock'] as const) {
    const f = await fixture(t), u = await f.record(pcm(1000, 2400));
    const options = {...f.options};
    if (boundary === 'model') options.engine = async () => ({...await f.options.engine(),
      speaker_model: {...MODEL, sha256: 'd'.repeat(64)}});
    else options.clock_map = async () => {throw new ContractError('PAYMENT_AUDIO_SOURCE_DENIED', 403);};
    const result = await new VoiceprintPaymentVerifier(options).verifyInitiating('owner', u);
    assert.deepEqual([result.verdict, result.reason], ['unavailable', boundary === 'model' ? 'engine_unavailable' : 'audio_missing']);
    assert.equal(f.reads.filter(args => !args[3]!.proof_only).length, 0, boundary);
    assert.equal(f.embedded.length, 0, boundary);
  }
});

test('A6 cancellation: a late initiating or combined owner identity cannot complete verification', async t => {
  for (const stage of ['initiating', 'combined'] as const) {
    const f = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const initiating = await f.record(pcm(1000, 2400)), pay = await f.record(pcm(1000, 640));
    const identify = f.registry.identify.bind(f.registry); let calls = 0;
    t.mock.method(f.registry, 'identify', async (...args: Parameters<typeof identify>) => {
      if (++calls === (stage === 'initiating' ? 1 : 2)) {entered.resolve(); await release.promise;}
      return identify(...args);
    });
    const controller = new AbortController(), result = f.verifier.verifyPay('owner', initiating, pay, controller.signal);
    await entered.promise; controller.abort(new Error('owner cancelled')); release.resolve();
    await assert.rejects(result, /owner cancelled/);
    assert.equal(calls, stage === 'initiating' ? 1 : 2);
    assert.equal(f.reads.length, stage === 'initiating' ? 2 : 4, 'cancelled initiating evidence never reads the pay phrase');
  }
});

test('I5 speaker-evidence clause: non-default verified and request thresholds come from registry policy', async t => {
  const lower = await fixture(t, {policy: {thresholds: {owner_verified: 0.7, owner_uncertain: 0.4}}});
  const initiating = await lower.verifier.verifyInitiating('owner', await lower.record(pcm(4000, 2400)));
  assert.deepEqual([initiating.verdict, initiating.initiating.score], ['uncertain', 0.55]);
  const higher = await fixture(t, {policy: {thresholds: {owner_verified: 0.9, owner_uncertain: 0.6}}});
  const result = await higher.verifier.verifyPay('owner', await higher.record(pcm(1000, 2400)), await higher.record(pcm(4000, 640)));
  assert.equal(result.verdict, 'uncertain', 'pay alone is below the configured 0.6 request floor');
  assert.ok(result.combined!.score! >= higher.registry.policy.thresholds.owner_verified, 'the combined score alone would pass');
});

for (const channel of ['call', 'glasses'] as const) for (const stage of ['initiating', 'combined'] as const)
test(`payment isolates real ${channel} learned evidence at ${stage} verification without writes`, async t => {
  const f = await fixture(t);
  for (let n = 0; n < 5; n++) {
    const embedding = new Float32Array(MODEL.dim);
    embedding[0] = .68; embedding[3] = Math.sqrt(1 - .68 ** 2); embedding[4 + n] = .001;
    const identity = await f.registry.identify(embedding, {mode: 'observe', channel, speech_ms: 1500,
      observed_at: new Date(T0 + n * 1500).toISOString()});
    assert.equal(identity.kind === 'owner' && identity.band, 'verified');
  }
  const probe = new Float32Array(MODEL.dim); probe[0] = .55; probe[3] = Math.sqrt(1 - .55 ** 2);
  const learned = await f.registry.identify(probe, {mode: 'verify', channel, speech_ms: 2400, observed_at: AT});
  assert.equal(learned.kind === 'owner' && learned.call_only, true, 'real producer promotes this enrolled-uncertain voice');
  await f.registry.flush();
  const key = (await f.storage.list('voiceprints'))[0]!, before = await f.storage.read('voiceprints', key);
  const initiating = await f.record(pcm(stage === 'initiating' ? 4000 : 1000, 2400));
  const pay = await f.record(pcm(4000, stage === 'initiating' ? 640 : 12000));
  const writes = t.mock.method(f.storage, 'replace');
  const result = await f.verifier.verifyPay('owner', initiating, pay);
  assert.equal(result.verdict, 'uncertain');
  assert.equal(Boolean(result.combined), stage === 'combined');
  if (stage === 'combined') assert.ok(result.combined!.score! < f.registry.policy.thresholds.owner_verified);
  await f.registry.flush();
  assert.equal(writes.mock.callCount(), 0, 'payment cannot schedule a derived-profile or enrollment write');
  assert.deepEqual(await f.storage.read('voiceprints', key), before);
});

test('payment ignores ordinary-channel calibration at initiating and combined verification', async t => {
  const f = await fixture(t, {scoring: {calibration: {ambient: {verified: .9, uncertain: .4}}}});
  const probe = new Float32Array(MODEL.dim); probe[0] = .7; probe[3] = Math.sqrt(1 - .7 ** 2);
  const ordinary = await f.registry.identify(probe, {mode: 'verify', speech_ms: 2400, observed_at: AT});
  assert.equal(ordinary.kind === 'owner' && ordinary.band, 'uncertain');
  const engine=await f.options.engine();
  const verifier=new VoiceprintPaymentVerifier({...f.options,engine:async()=>({...engine,embed:async()=>probe})});
  const initiating = await f.record(pcm(4000, 2400));
  assert.equal((await verifier.verifyInitiating('owner', initiating)).verdict, 'pass');
  const combined = await verifier.verifyPay('owner', await f.record(pcm(1000, 2400)), await f.record(pcm(4000, 12000)));
  assert.equal(combined.verdict, 'pass');
  assert.ok(combined.combined!.score! >= f.registry.policy.thresholds.owner_verified);
});

test('payment uses the global best enrolled set across capture channels', async t => {
  const f = await fixture(t);
  await f.registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(1), speech_ms: 2000})), at: AT});
  const writes = t.mock.method(f.storage, 'replace');
  const glasses = await f.verifier.verifyInitiating('owner', await f.record(pcm(2000, 2400)));
  const phone = await f.verifier.verifyInitiating('owner', await f.record(pcm(1000, 2400), 'phone', 'phone'));
  assert.deepEqual([glasses.verdict, glasses.initiating.score, glasses.channel], ['pass', 1, 'glasses']);
  assert.deepEqual([phone.verdict, phone.initiating.score, phone.channel], ['pass', 1, 'phone_app']);
  await f.registry.flush();
  assert.equal(writes.mock.callCount(), 0, 'successful cross-channel payment verification is also read-only');
});

test('payment long initiating speech uses shared bounded windows without losing voiced samples', async t => {
  const f = await fixture(t), initiating = await f.record(pcm(1000, 13024)), pay = await f.record(pcm(1000, 640));
  const result = await f.verifier.verifyPay('owner', initiating, pay);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.initiating.speech_ms, 13024);
  assert.deepEqual(f.embedded.map(s => s.length), [48000, 48000, 48000, 32192, 32192, 10240, 34240]);
  assert.equal(f.embedded.slice(0, 5).reduce((n, s) => n + s.length, 0), 13024 * 16);
  assert.ok(f.embedded.every(s => s.length <= SPEAKER_WINDOW_SAMPLES));
});

test('owner override makes payment voice verification unavailable, including activation during verification', async t => {
  const f = await fixture(t), initiating = await f.record(pcm(1000, 3200)), pay = await f.record(pcm(1000, 640));
  let active = true;
  const options = {...f.options, owner_override_active: async () => active};
  const verifier = new VoiceprintPaymentVerifier(options);
  assert.equal((await verifier.verifyInitiating('owner', initiating)).verdict, 'unavailable');
  assert.equal((await verifier.verifyPay('owner', initiating, pay)).verdict, 'unavailable');
  assert.equal(f.reads.length, 0);
  active = false;
  let resume!: () => void, entered!: () => void;
  const began = new Promise<void>(r => {entered = r;});
  const pending = new Promise<void>(r => {resume = r;});
  const racing = new VoiceprintPaymentVerifier({...options, engine: async () => {
    entered(); await pending; return f.options.engine();
  }});
  const result = racing.verifyPay('owner', initiating, pay);await began;
  active = true;resume();
  assert.equal((await result).verdict, 'unavailable');
});

test('retired model activation drops in-flight payment scores', async t => {
  let active = true;
  const f = await fixture(t, {model_active: () => active});
  const initiating = await f.record(pcm(1000, 3200));
  let resume!: () => void, entered!: () => void;
  const began = new Promise<void>(resolve => {entered = resolve;});
  const pending = new Promise<void>(resolve => {resume = resolve;});
  const verifier = new VoiceprintPaymentVerifier({...f.options, engine: async () => {
    const engine = await f.options.engine();
    return {...engine, embed: async (samples, signal) => {entered(); await pending; return engine.embed(samples, signal);}};
  }});
  const result = verifier.verifyInitiating('owner', initiating);
  await began; active = false; resume();
  assert.equal((await result).verdict, 'unavailable');
  assert.equal(await f.registry.paymentReady('glasses'), false);
});
