import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';

const model={id:'fixture',sha256:'c'.repeat(64),dim:32},at='2026-10-18T00:00:00.000Z';
const vector=(x:number)=>Float32Array.from({length:32},(_,i)=>i===0?x:i===1?Math.sqrt(1-x*x):0);
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'voiceprint-diagnostics-')),storage=new PosixStorage(root),registry=new VoiceprintRegistry(storage,model);
  t.after(async()=>{await registry.close();await storage.close();await rm(root,{recursive:true,force:true});});
  await registry.enrollOwner({speaker_model:model,channel:'file',mode:'replace',at,
    samples:Array.from({length:5},()=>({embedding:vector(1),speech_ms:2000}))});
  return {root,registry};
}

test('channel diagnostics include the conversation centroid that actually verifies a call',async t=>{
  const {registry}=await fixture(t);
  await registry.enrollOwner({speaker_model:model,channel:'phone_app',mode:'replace',purpose:'conversation',at,
    samples:Array.from({length:5},()=>({embedding:vector(.5),speech_ms:2000}))});
  const query=vector(.5),identity=await registry.identify(query,{mode:'call',speech_ms:1856,observed_at:at,learning:false});
  assert.deepEqual(identity,{kind:'owner',band:'verified',score:1});
  assert.deepEqual(await registry.scoreChannels(query),{file:.5,'conversation:phone_app':1});
  assert.equal((await registry.identify(query,{mode:'payment',speech_ms:1856,observed_at:at}) as {band?:string}).band,'uncertain');
});

test('channel diagnostics select video learning independently of call learning',async t=>{
  const {registry}=await fixture(t);
  for(let n=0;n<5;n++)await registry.identify(vector(.7+n*.001),{channel:'video',mode:'call',speech_ms:2000,
    observed_at:new Date(Date.parse(at)+n*2000).toISOString()});
  const scores=await registry.scoreChannels(vector(.5),'video');
  assert.ok(scores.video!>.9);
  assert.equal(scores.call,undefined);
  assert.equal((await registry.scoreChannels(vector(.5))).video,undefined);
});

test('registry facts expose counts, centroid ages and each model without biometric vectors or writes',async t=>{
  const {root,registry}=await fixture(t),path=join(root,'voiceprints',digest('paios.voiceprint.registry.v1'));
  const before=await readFile(path),facts=await registry.diagnostics(Date.parse(at)+60000);
  assert.equal(facts.revision,1);
  assert.equal(facts.min_identify_ms,1000);
  assert.deepEqual(facts.thresholds,{owner_verified:.65,owner_uncertain:.45,cluster:.65,enroll_consistency:.6,assistant:.5,
    call_anchor:.65,trusted_centroid:.65,enroll_match:.65});
  assert.deepEqual(facts.sets,[{kind:'enrolled',channel:'file',samples:5,verified_threshold:.65,speech_ms:10000,enrolled_age_ms:60000,
    centroid_age_ms:60000,model,stale_model:false,source_sets_current:null}]);
  assert.doesNotMatch(JSON.stringify(facts),/embedding|"centroid"|source_device|"source_sets"/u);
  assert.deepEqual(await readFile(path),before);
  const short=await registry.identify(vector(1),{mode:'call',speech_ms:999,observed_at:at,learning:false});
  assert.deepEqual(short,{kind:'unknown',reason:'too_short'});
  const unmatched=await registry.identify(vector(.3),{mode:'call',speech_ms:1856,observed_at:at,learning:false});
  assert.deepEqual(unmatched,{kind:'unknown',reason:'unmatched'});
  assert.equal((await registry.scoreChannels(vector(.3))).file,.3,'unknown can have a computed score below .45');
});
