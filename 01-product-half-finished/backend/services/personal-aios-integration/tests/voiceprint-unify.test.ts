import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredScoring,VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {PosixStorage} from '../src/storage.ts';
import {embedSpeech,speakerWindows,type VoiceprintChannel} from '../src/voiceprint/contracts.ts';
import {normalizedScore} from '../src/voiceprint/scoring.ts';
const model={id:'fixture',sha256:'c'.repeat(64),dim:32};
const axis=(x:number,seed=0)=>{const e=new Float32Array(32);e[0]=x;e[1]=Math.sqrt(1-x*x);e[2+seed%30]=seed*.0001;return e;};
const at=(n:number)=>new Date(Date.UTC(2026,9,17)+n).toISOString();
async function setup(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'voiceprint-unify-')),storage=new PosixStorage(root);
  const registry=new VoiceprintRegistry(storage,model);
  t.after(async()=>{await registry.close();await rm(root,{recursive:true,force:true});});
  await registry.enrollOwner({speaker_model:model,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:axis(1),speech_ms:2000}))});
  return {registry,storage};
}
test('each channel learns only independent non-overlapping enrolled matches and payment cannot use learned evidence',async t=>{
  const {registry}=await setup(t);
  for(const channel of ['call','phone_app','video','ambient','glasses','journal','mac'] as VoiceprintChannel[]){
    for(let n=0;n<5;n++)await registry.identify(axis(.68,n+1),{channel,mode:'observe',speech_ms:1500,observed_at:at(n*1500)});
    const learned=await registry.identify(axis(.5),{channel,mode:'verify',speech_ms:1500,observed_at:at(9000)});
    assert.equal(learned.kind==='owner'&&learned.band,'verified',channel);
    assert.equal(learned.kind==='owner'&&learned.call_only,true,channel);
    assert.equal((await registry.identify(axis(.5),{channel,mode:'payment',speech_ms:1500,observed_at:at(10000)}) as {band?:string}).band,'uncertain');
    // A derived verdict cannot feed itself back into the enrolled set or authorize a guest.
    for(let n=0;n<5;n++)await registry.identify(axis(.5,n+10),{channel,mode:'observe',speech_ms:1500,observed_at:at(12000+n*1500)});
  }
  for(const channel of ['call','phone_app','video','ambient','glasses','journal','mac'] as VoiceprintChannel[])
    assert.deepEqual(await registry.identify(axis(1),{channel,mode:'verify',speech_ms:999,observed_at:at(20000)}),{kind:'unknown',reason:'too_short'});
  const status=await registry.status() as {learned_samples:Record<string,number>};
  assert.deepEqual(Object.values(status.learned_samples),Array(7).fill(5));
  assert.equal((await registry.owner('file')).samples,5);
  await registry.forgetOwner();
  assert.deepEqual((await registry.status() as {learned_samples:object}).learned_samples,{});
});
test('uncertain short requests cannot train a verified carrier and overlapping prefixes do not fill profiles',async t=>{
  const {registry}=await setup(t);
  await registry.identify(axis(.68,20),{learning:false,channel:'mac',mode:'observe',speech_ms:1500,observed_at:at(0)});
  for(let n=0;n<5;n++)await registry.identify(axis(.68,n+1),{mode:'verify',channel:'glasses',speech_ms:1500,observed_at:at(n*1500),
    request:{embedding:axis(.5),speech_ms:500}});
  assert.deepEqual((await registry.status() as {learned_samples:object}).learned_samples,{});
  for(let n=0;n<5;n++)await registry.identify(axis(.68,n+1),{mode:'observe',channel:'glasses',speech_ms:1500,observed_at:at(n*400)});
  assert.equal((await registry.status() as {learned_samples:Record<string,number>}).learned_samples.glasses,2);
});
test('channel calibration and AS-norm are explicit, payment retains raw enrolled thresholds',async t=>{
  const {storage}=await setup(t);
  const registry=new VoiceprintRegistry(storage,model,{scoring:{calibration:{call:{verified:.5,uncertain:.4}}}});
  t.after(()=>registry.close());
  assert.equal((await registry.identify(axis(.55),{mode:'call',channel:'call',speech_ms:2000,observed_at:at(0)}) as {band?:string}).band,'uncertain');
  assert.equal((await registry.identify(axis(.55),{mode:'payment',channel:'call',speech_ms:2000,observed_at:at(0)}) as {band?:string}).band,'uncertain');
  assert.deepEqual((await registry.status() as {learned_samples:object}).learned_samples,{},'calibrated-only matches are not independent learning evidence');
  assert.throws(()=>configuredScoring({cohort:{model_sha256:'d'.repeat(64),embeddings_base64:[]}},model),/VOICEPRINT_COHORT_MODEL_MISMATCH/);
  const cohort=[axis(.1),axis(.3),axis(-.2)];
  assert.ok(Number.isFinite(normalizedScore(axis(.7),axis(1),cohort)));
  assert.equal(normalizedScore(axis(.7),axis(1),cohort),normalizedScore(axis(1),axis(.7),cohort));
});

test('gapped combined turns cannot reuse an already learned speech span',async t=>{
  const {registry}=await setup(t);
  await registry.identify(axis(.68,1),{channel:'glasses',mode:'observe',speech_ms:1000,evidence_start_at:at(0),observed_at:at(1000)});
  await registry.identify(axis(.68,2),{channel:'glasses',mode:'verify',speech_ms:2000,evidence_start_at:at(0),observed_at:at(3000)});
  assert.equal((await registry.status() as {learned_samples:Record<string,number>}).learned_samples.glasses,1);
});

test('long enrollment and a complete utterance use the same duration-weighted window aggregation',async t=>{
  const {registry}=await setup(t),speech=new Float32Array(13*16000);speech.fill(.1,0,9*16000);speech.fill(.2,9*16000);
  const engine={embed:async(part:Float32Array)=>axis(part[0]!<.15?1:.7)};
  const samples=[];
  for(const window of speakerWindows(speech))samples.push({embedding:await engine.embed(window),speech_ms:window.length/16,quality:1});
  await registry.enrollOwner({speaker_model:model,channel:'file',mode:'replace',samples});
  const identity=await registry.identify(await embedSpeech(engine,speech),{mode:'payment',speech_ms:13000,observed_at:at(0)});
  assert.deepEqual(identity,{kind:'owner',band:'verified',score:1});
});
