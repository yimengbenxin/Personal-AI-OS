import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {VoiceprintEnrollment} from '../src/voiceprint/enrollment.ts';
import type {SpeechEngine} from '../src/voiceprint/contracts.ts';
import {controlledDetector} from './speech-fixture.ts';

const A = {id: 'fixture-a', sha256: 'a'.repeat(64), dim: 16};
const B = {id: 'fixture-b', sha256: 'b'.repeat(64), dim: 16};
const direction = (cosine = 1) => Float32Array.from({length: A.dim}, (_, i) => i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine ** 2) : 0);
const vector = direction();
const samples = Array.from({length: 5}, () => ({embedding: vector, speech_ms: 2000}));
const owner = {principal_id: 'owner', device_id: 'phone', device_type: 'phone'};
const input = {mode: 'payment' as const, channel: 'phone_app' as const, speech_ms: 2000, observed_at: '2026-10-25T00:00:00.000Z'};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
};
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'voiceprint-model-switch-'));
  const storage = new PosixStorage(directory), registries: VoiceprintRegistry[] = [];
  t.after(async () => {
    for (const registry of registries) await registry.close();
    await storage.close(); await rm(directory, {recursive: true, force: true});
  });
  return Object.assign((model = A, options: ConstructorParameters<typeof VoiceprintRegistry>[2] = {}) => {
    const registry = new VoiceprintRegistry(storage, model, options); registries.push(registry); return registry;
  },{storage});
}

test('restart in another model space requires fresh channel enrollment and independent calibration', async t => {
  const open = await fixture(t), a = open();
  await a.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples});
  await a.close();
  const b = open(B, {verification: {speaker_model: B, channels: {}}});
  assert.equal((await b.owner('phone_app')).reenrollment_required, true);
  assert.equal(await b.paymentReady('phone_app'), false);
  await b.enrollOwner({speaker_model: B, channel: 'phone_app', mode: 'replace', samples});
  assert.equal((await b.owner('phone_app')).enrolled, true);
  assert.equal(await b.paymentReady('phone_app'), false);
  assert.deepEqual(await b.identify(vector, input), {kind: 'unknown', reason: 'no_enrollment'});
  await b.close();
  const calibrated = open(B, {verification: {speaker_model: B, channels: {phone_app: .8}}});
  assert.equal(await calibrated.paymentReady('phone_app'), true);
  assert.equal(await calibrated.paymentReady('glasses'), false);
  const accepted = await calibrated.identify(vector, input);
  assert.equal(accepted.kind === 'owner' && accepted.band, 'verified');
  assert.throws(() => open(B, {verification: {speaker_model: A, channels: {phone_app: .8}}}), /VOICEPRINT_VERIFICATION_MODEL_INVALID/);
});

test('a model channel retains its established calibrated line across restart and replacement', async t => {
  const open = await fixture(t), high = open(A, {verification: {speaker_model: A, channels: {phone_app: .9}}});
  await high.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples});
  await high.close();
  const lower = open(A, {verification: {speaker_model: A, channels: {phone_app: .7}}});
  await lower.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples});
  const identity = await lower.identify(direction(.8), input);
  assert.equal(identity.kind === 'owner' && identity.band, 'uncertain');
  await lower.close();
  const changed = open(B, {verification: {speaker_model: B, channels: {phone_app: .7}}});
  await changed.enrollOwner({speaker_model: B, channel: 'phone_app', mode: 'replace', samples});
  const independent = await changed.identify(direction(.8), input);
  assert.equal(independent.kind === 'owner' && independent.band, 'verified');
});

test('restart A to un-enrolled B and back to A requires fresh generation enrollment without lowering its line',async t=>{
  const open=await fixture(t),a=open(A,{enrollment_generation:1,verification:{speaker_model:A,channels:{phone_app:.9}}});
  await a.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  await a.close();
  const b=open(B,{enrollment_generation:2,verification:{speaker_model:B,channels:{}}});
  assert.equal((await b.owner('phone_app')).reenrollment_required,true);
  await b.close();
  const reverted=open(A,{enrollment_generation:3,verification:{speaker_model:A,channels:{phone_app:.7}}});
  assert.equal((await reverted.owner('phone_app')).reenrollment_required,true);
  assert.equal(await reverted.paymentReady('phone_app'),false);
  assert.deepEqual(await reverted.identify(vector,input),{kind:'unknown',reason:'no_enrollment'});
  await assert.rejects(reverted.enrollOwner({speaker_model:A,channel:'phone_app',mode:'add',samples}),/VOICEPRINT_REENROLLMENT_REQUIRED/);
  await reverted.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  assert.equal(await reverted.paymentReady('phone_app'),true);
  const belowPreservedLine=await reverted.identify(direction(.8),input);
  assert.equal(belowPreservedLine.kind==='owner'&&belowPreservedLine.band,'uncertain');
  await reverted.close();
  const restarted=open(A,{enrollment_generation:3,verification:{speaker_model:A,channels:{phone_app:.7}}});
  assert.equal(await restarted.paymentReady('phone_app'),true);
});

test('A watermark survives actual B enrollment replacing A templates before returning to A',async t=>{
  const open=await fixture(t),a=open(A,{enrollment_generation:1,verification:{speaker_model:A,channels:{phone_app:.9}}});
  await a.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  await a.close();
  const b=open(B,{enrollment_generation:2,verification:{speaker_model:B,channels:{phone_app:.7}}});
  await b.enrollOwner({speaker_model:B,channel:'phone_app',mode:'replace',samples});
  const independent=await b.identify(direction(.8),input);
  assert.equal(independent.kind==='owner'&&independent.band,'verified','B must not inherit A .9 line');
  await b.close();
  const returned=open(A,{enrollment_generation:3,verification:{speaker_model:A,channels:{phone_app:.7}}});
  assert.equal((await returned.owner('phone_app')).reenrollment_required,true);
  assert.equal(await returned.paymentReady('phone_app'),false,'old generation never authorizes payment');
  await returned.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  const protectedLine=await returned.identify(direction(.8),input);
  assert.equal(protectedLine.kind==='owner'&&protectedLine.band,'uncertain','A retains .9 after B actually replaced its templates');
  await returned.close();
  const restarted=open(A,{enrollment_generation:3,verification:{speaker_model:A,channels:{phone_app:.7}}});
  const persisted=await restarted.identify(direction(.8),input);
  assert.equal(persisted.kind==='owner'&&persisted.band,'uncertain','retained A watermark survives restart');
});

for(const selected of [A,B])test(`prior effective policy archives legacy undefined A line before ${selected.id} replaces its templates`,async t=>{
  const open=await fixture(t),a=open(A,{policy:{thresholds:{owner_verified:.9}}});
  await a.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});await a.close();
  const [key]=await open.storage.list('voiceprints');
  const legacy=JSON.parse(Buffer.from(await open.storage.read('voiceprints',key!)).toString());
  delete legacy.owner_sets[0].verified_threshold;delete legacy.verified_lines;
  await open.storage.replace('voiceprints',key!,Buffer.from(JSON.stringify(legacy)));
  const b=open(selected,{enrollment_generation:2,verification:{speaker_model:selected,channels:{phone_app:.7}},
    prior_model_thresholds:[{speaker_model:A,owner_verified:.85},{speaker_model:A,owner_verified:.9}]});
  await b.enrollOwner({speaker_model:selected,channel:'phone_app',mode:'replace',samples});
  const independent=await b.identify(direction(.8),input);
  assert.equal(independent.kind==='owner'&&independent.band,selected===A?'uncertain':'verified');await b.close();
  const returned=open(A,{enrollment_generation:3,verification:{speaker_model:A,channels:{phone_app:.7}}});
  await returned.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  const retained=await returned.identify(direction(.8),input);
  assert.equal(retained.kind==='owner'&&retained.band,'uncertain','maximum exact-model prior pin survives template replacement');
});

test('startup consumes prior legacy A watermark before its pin retires without B enrollment',async t=>{
  const open=await fixture(t),a=open(A,{policy:{thresholds:{owner_verified:.9}}});
  await a.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});await a.close();
  const [key]=await open.storage.list('voiceprints');
  const legacy=JSON.parse(Buffer.from(await open.storage.read('voiceprints',key!)).toString());
  delete legacy.owner_sets[0].verified_threshold;delete legacy.verified_lines;
  await open.storage.replace('voiceprints',key!,Buffer.from(JSON.stringify(legacy)));
  const b=open(B,{enrollment_generation:2,verification:{speaker_model:B,channels:{}},
    prior_model_thresholds:[{speaker_model:A,owner_verified:.9}]});
  assert.equal((await b.owner('phone_app')).reenrollment_required,true);
  assert.equal(await b.paymentReady('phone_app'),false);await b.close();
  const C={id:'fixture-c',sha256:'c'.repeat(64),dim:A.dim};
  const c=open(C,{enrollment_generation:3,verification:{speaker_model:C,channels:{phone_app:.7}}});
  await c.enrollOwner({speaker_model:C,channel:'phone_app',mode:'replace',samples});await c.close();
  const returned=open(A,{enrollment_generation:4,verification:{speaker_model:A,channels:{phone_app:.7}}});
  await returned.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  const retained=await returned.identify(direction(.8),input);
  assert.equal(retained.kind==='owner'&&retained.band,'uncertain','B startup durably consumes prior A .9 before that authoritative pin retires');
});

test('legacy startup watermark migration writes once and unchanged reopen stays read-only',async t=>{
  const open=await fixture(t),a=open(A,{policy:{thresholds:{owner_verified:.9}}});
  await a.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});await a.close();
  const [key]=await open.storage.list('voiceprints');
  const legacy=JSON.parse(Buffer.from(await open.storage.read('voiceprints',key!)).toString());
  delete legacy.owner_sets[0].verified_threshold;delete legacy.verified_lines;
  await open.storage.replace('voiceprints',key!,Buffer.from(JSON.stringify(legacy)));
  const writes=t.mock.method(open.storage,'replace');
  const options={enrollment_generation:2,verification:{speaker_model:B,channels:{}},
    prior_model_thresholds:[{speaker_model:A,owner_verified:.9}]};
  const b=open(B,options);await b.owner('phone_app');
  assert.equal(writes.mock.callCount(),1,'startup durably archives legacy prior line without enrollment');
  await b.paymentReady('phone_app');await b.owner();await b.close();
  const reopened=open(B,options);await reopened.owner();await reopened.close();
  assert.equal(writes.mock.callCount(),1,'same-model unchanged reopen does not rewrite migrated metadata');
});

test('explicit voice forgetting clears its watermark scope while other channels retain their lines',async t=>{
  const open=await fixture(t),high=open(A,{verification:{speaker_model:A,channels:{phone_app:.9,glasses:.95}}});
  for(const channel of ['phone_app','glasses'] as const)await high.enrollOwner({speaker_model:A,channel,mode:'replace',samples});
  await high.close();
  const lower=open(A,{verification:{speaker_model:A,channels:{phone_app:.7,glasses:.7}}});
  await lower.forgetOwner('phone_app');
  await lower.enrollOwner({speaker_model:A,channel:'phone_app',mode:'replace',samples});
  const phone=await lower.identify(direction(.8),input),glasses=await lower.identify(direction(.8),{...input,channel:'glasses'});
  assert.equal(phone.kind==='owner'&&phone.band,'verified');
  assert.equal(glasses.kind==='owner'&&glasses.band,'uncertain');
  await lower.forgetOwner();
  await lower.enrollOwner({speaker_model:A,channel:'glasses',mode:'replace',samples});
  const forgotten=await lower.identify(direction(.8),{...input,channel:'glasses'});
  assert.equal(forgotten.kind==='owner'&&forgotten.band,'verified');
});

test('retiring activation rejects queued scoring and enrollment even if the same model is selected again', async t => {
  const open = await fixture(t), entered = deferred(), release = deferred();
  let generation = 1, block = false;
  const registry = open(A, {model_active: () => generation === 1, owner_override_active: async () => {
    if (block) {entered.resolve(); await release.promise;} return false;
  }});
  await registry.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples});
  block = true;
  const scoring = registry.identify(vector, input);
  await entered.promise;
  generation = 3; // A -> B -> A does not restore generation 1.
  release.resolve();
  await assert.rejects(scoring, /VOICEPRINT_MODEL_RETIRED/);
  await assert.rejects(registry.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples}), /VOICEPRINT_MODEL_RETIRED/);
  assert.throws(() => registry.confirmDeviceOwner(vector, {speaker_model: A, channel: 'call', speech_ms: 2000,
    observed_at: input.observed_at}), /VOICEPRINT_MODEL_RETIRED/);
  await assert.rejects(registry.observeAssistant({voice: 'system_tts', embedding: vector, speech_ms: 2000}), /VOICEPRINT_MODEL_RETIRED/);
  assert.equal(await registry.paymentReady('phone_app'), false);
});

test('in-flight acoustic measurement cannot produce usable enrollment evidence after activation retires', async t => {
  const open = await fixture(t), entered = deferred(), release = deferred(); let active = true;
  const registry = open(A, {model_active: () => active});
  const engine: SpeechEngine = {speaker_model: A, asr_model: A, transcribe: async () => ({text: ''}), close: async () => {},
    embed: async () => {entered.resolve(); await release.promise; return vector;}};
  const enrollment = new VoiceprintEnrollment(registry, async () => engine, controlledDetector());
  const pcm = Buffer.alloc(2 * 512 * 80);
  for (let n = 512 * 4; n < 512 * 76; n++) pcm.writeInt16LE(1000, n * 2);
  const pending = enrollment.measure(owner, pcm);
  await entered.promise; active = false; release.resolve();
  await assert.rejects(pending, /VOICEPRINT_MODEL_RETIRED/);
  await assert.rejects(enrollment.enroll(owner, ['old-sample']), /VOICEPRINT_MODEL_RETIRED/);
});

test('paired enrollment replaces a stale-model channel and never appends its old vectors', async t => {
  const open = await fixture(t), a = open();
  await a.enrollOwner({speaker_model: A, channel: 'phone_app', mode: 'replace', samples});
  await a.close();
  const b = open(B, {verification: {speaker_model: B, channels: {}}});
  const engine: SpeechEngine = {speaker_model: B, asr_model: B, transcribe: async () => ({text: ''}), close: async () => {},
    embed: async () => vector};
  const enrollment = new VoiceprintEnrollment(b, async () => engine, controlledDetector());
  const pcm = Buffer.alloc(512 * 2 * 100);
  for (let n = 512 * 4; n < 512 * 96; n++) pcm.writeInt16LE(1000, n * 2);
  const ids: string[] = [];
  for (let n = 0; n < 5; n++) {
    const measured = await enrollment.measure(owner, pcm);
    ids.push(...(measured.samples?.map(sample => sample.sample_id) ?? [measured.sample_id!]));
  }
  const outcome = await enrollment.enroll(owner, ids);
  assert.equal(outcome.status, 'enrolled');
  assert.deepEqual(outcome.owner.speaker_model, B);
  assert.equal(outcome.owner.samples, ids.length);
  assert.equal(await b.paymentReady('phone_app'), false);
});
