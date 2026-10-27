import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeEmbedding} from '../src/voiceprint/registry.ts';

const model={id:'adaptive-replay-synthetic',sha256:'a'.repeat(64),dim:32};
const vector=(score=1)=>Float32Array.from({length:32},(_,i)=>i===0?score:i===1?Math.sqrt(1-score*score):0);
function fixture(last=1){
  const samples=Array.from({length:20},(_,i)=>({embedding:encodeEmbedding(vector(i===19?last:1)),speech_ms:2000,
    added_at:new Date(Date.UTC(2026,9,21,0,0,i*2)).toISOString()}));
  return {schema:'paios.voiceprint.registry.v2',revision:1,next_number:2,owner_sets:[{channel:'file',model,samples,
    centroid:encodeEmbedding(vector()),enrolled_at:samples[0]!.added_at,updated_at:samples.at(-1)!.added_at,consistency:{min:1,mean:1}}],
    clusters:[{cluster_id:'1',model_sha256:model.sha256,centroid:encodeEmbedding(vector(.61)),count:1,speech_ms:2000,created_at:samples[0]!.added_at,last_seen:samples[0]!.added_at}],assistant:[]};
}

test('read-only adaptive replay orders samples, reports only aggregates and passes a supported zero-added-reject gate',async()=>{
  const {evaluateAdaptiveRegistry}=await import('../tools/voiceprint-adaptive-replay.ts');
  const doc=fixture(),before=JSON.stringify(doc);doc.owner_sets[0]!.samples.reverse();
  const reversed=JSON.stringify(doc),result=await evaluateAdaptiveRegistry(doc as any);
  assert.equal(JSON.stringify(doc),reversed,'no in-memory mutation either');
  assert.equal(result.gate,'pass');assert.equal(result.added_false_rejects,0);
  const file=result.channels.file!;assert.equal(file.confirmed_samples,20);assert.equal(file.current_threshold,.65);
  assert.equal(file.stored_threshold,null);assert.equal(file.replayed_threshold,.68);assert.equal(file.final_threshold,.68);
  assert.equal(file.trajectory[0]!.threshold,.65);assert.ok(file.unlabelled_cluster_margin!>.03);
  const output=JSON.stringify(result);for(const forbidden of ['embedding','transcript','centroid','cluster_id'])assert.equal(output.includes(forbidden),false);
  assert.ok(before.length>output.length);
});

test('the zero-added-false-reject gate fails when a later genuine sample passes .65 but fails the raised line',async()=>{
  const {evaluateAdaptiveRegistry}=await import('../tools/voiceprint-adaptive-replay.ts');
  const result=await evaluateAdaptiveRegistry(fixture(.66) as any);
  assert.equal(result.gate,'fail');assert.equal(result.added_false_rejects,1);
  assert.equal(result.channels.file!.baseline_rejected,0);assert.equal(result.channels.file!.candidate_rejected,1);
});

test('an empty registry cannot satisfy the real-owner release gate',async()=>{
  const {evaluateAdaptiveRegistry}=await import('../tools/voiceprint-adaptive-replay.ts');
  const doc=fixture();doc.owner_sets=[];
  assert.equal((await evaluateAdaptiveRegistry(doc as any)).gate,'insufficient_data');
});

test('a persisted watermark above the replay projection cannot silently pass the gate',async()=>{
  const {evaluateAdaptiveRegistry}=await import('../tools/voiceprint-adaptive-replay.ts');
  const doc=fixture(.72);Object.assign(doc.owner_sets[0]!,{verified_threshold:.75});
  const result=await evaluateAdaptiveRegistry(doc as any);
  assert.equal(result.added_false_rejects,0);assert.equal(result.current_line_added_false_rejects,1);
  assert.equal(result.gate,'fail');assert.equal(result.channels.file!.final_threshold,.75);
});

test('only independently labelled negative examples contribute to the impostor margin',async()=>{
  const {evaluateAdaptiveRegistry}=await import('../tools/voiceprint-adaptive-replay.ts');
  const sample={channel:'file',model_sha256:model.sha256,label:'guest' as const,embedding:encodeEmbedding(vector(.61))};
  assert.equal((await evaluateAdaptiveRegistry(fixture() as any)).channels.file!.impostor_margin,null);
  const result=await evaluateAdaptiveRegistry(fixture() as any,{impostors:[sample]});
  assert.equal(result.channels.file!.labelled_impostors,1);assert.equal(result.channels.file!.impostor_margin,.07);
  await assert.rejects(evaluateAdaptiveRegistry(fixture() as any,{impostors:[{...sample,model_sha256:'b'.repeat(64)}]}),/OFFLINE_IMPOSTOR_LABEL_INVALID/);
});
