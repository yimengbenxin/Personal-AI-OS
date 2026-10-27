import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {ContractError} from '../src/contracts.ts';
import {voiceprintPolicy} from '../src/voiceprint/registry.ts';
import {loadRegistryCipher} from '../src/voiceprint/cipher.ts';
import {compareSpeakerModels} from '../tools/voiceprint-model-comparison.ts';
import {pinnedModels} from '../tools/voiceprint-offline-models.ts';
import {offlineFixture,axis} from './voiceprint-offline-fixture.ts';
const cli=resolve(import.meta.dirname,'../tools/voiceprint-evaluate.ts');
async function fixture(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'voiceprint-offline-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,...await offlineFixture(root)};}
async function command(argv:string[]){return new Promise<{code:number|null;out:string;err:string}>(done=>{
  const p=spawn(process.execPath,[cli,...argv],{stdio:['ignore','pipe','pipe']});let out='',err='';
  p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('close',code=>done({code,out,err}));});}
const evaluate=(f:Awaited<ReturnType<typeof fixture>>)=>compareSpeakerModels(f.manifest,
  {base:f.root,directory:f.directory,models:f.models,registry:f.registry,policy:voiceprintPolicy()});

test('same labelled windows compare four independently pinned model spaces at both operating points',async t=>{
  const f=await fixture(t),result=await evaluate(f),rows=result.models.map(m=>m.channels.call!);
  assert.equal(result.models.length,4);assert.equal(result.production_model_changed,false);
  assert.deepEqual(rows.map(r=>[r.at_channel_line.recall,r.at_channel_line.false_accept_rate,r.at_065.recall,r.at_065.false_accept_rate]),
    [[.5,0,.75,.333333],[.75,0,1,0],[1,.333333,1,.333333],[.25,0,.75,0]]);
  assert.ok(rows.every(r=>r.verified_line===.68&&r.per_window_ms.n===7&&r.per_window_ms.p95!>=0));
  assert.equal(rows[0]!.at_065.by_non_owner_label.rejected!.false_accept_rate,1);
  const output=JSON.stringify(result);for(const forbidden of ['ref-0','window-0','fixture-call','synthetic-pin','synthetic"'])
    assert.equal(output.includes(forbidden),forbidden==='synthetic"','only the evidence type, never fixture details');
});

test('CLI reads the store or sealed export without mutation and writes exactly one aggregate JSON/Markdown pair',async t=>{
  const f=await fixture(t),before=await readFile(f.path),listing=await readdir(f.store,{recursive:true});
  const run=await command(['--mode','adaptive','--registry-store',f.store,'--output-prefix',join(f.root,'adaptive')]);
  assert.equal(run.code,0,run.err);const adaptive=JSON.parse(await readFile(join(f.root,'adaptive.json'),'utf8'));
  assert.equal(adaptive.gate,'pass');assert.equal(adaptive.added_false_rejects,0);assert.equal(adaptive.channels.call.final_threshold,.68);
  const key=join(f.root,'fixture-key');await writeFile(key,Buffer.alloc(32,7).toString('base64'));
  const cipher=await loadRegistryCipher(key);await writeFile(f.file,cipher.seal(before));
  const compared=await command(['--mode','compare','--registry-file',f.file,'--key-file',key,'--models-dir',f.directory,
    '--windows',f.windows,'--output-prefix',join(f.root,'compare')]);assert.equal(compared.code,0,compared.err);
  const summary=await readFile(join(f.root,'compare.md'),'utf8'),result=await readFile(join(f.root,'compare.json'),'utf8');
  assert.match(summary,/cam-plus-plus/);for(const forbidden of ['window-','ref-','fixture-call','centroid','embedding":','wav":'])assert.ok(!result.includes(forbidden));
  assert.deepEqual(await readFile(f.path),before);assert.deepEqual(await readdir(f.store,{recursive:true}),listing);
  assert.deepEqual(JSON.parse(compared.out),{mode:'compare',written:2});
  const overlap=await command(['--mode','adaptive','--registry-store',f.store,'--output-prefix',join(f.store,'bad')]);
  assert.equal(overlap.code,2);assert.match(overlap.err,/OFFLINE_OUTPUT_OVERLAPS_INPUT/);
});

test('CLI rejects modified pins and rejects labels inferred only from the model being evaluated',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'current.fixture'),'tampered');
  await assert.rejects(pinnedModels(f.directory),/SPEECH_MODEL_PIN_MISMATCH/);
  const sample=f.manifest.samples.find(s=>s.role==='window'&&s.label==='owner')!;delete sample.verification;
  await assert.rejects(evaluate(f),/OFFLINE_INDEPENDENT_LABEL_REQUIRED/);
});

test('human windows reject reference/test overlap and synthetic embeddings; model load failures do not produce fake metrics',async t=>{
  const f=await fixture(t);f.manifest.evidence='human_recorded';
  await assert.rejects(evaluate(f),/OFFLINE_WINDOWS_INVALID/);
  const human=structuredClone(f.manifest),wav=Buffer.alloc(44+32000*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=0;i<32000;i++)wav.writeInt16LE(Math.round(Math.sin(i/13)*2000),44+i*2);
  await writeFile(join(f.root,'call.wav'),wav);
  for(const s of human.samples){delete s.synthetic;s.wav='call.wav';s.start_sample=s.role==='reference'?0:8000;s.end_sample=s.start_sample+16000;}
  await assert.rejects(compareSpeakerModels(human,{base:f.root,directory:f.directory,models:f.models,
    registry:f.registry,policy:voiceprintPolicy()}),/OFFLINE_REFERENCE_TEST_OVERLAP/);
  f.manifest.evidence='synthetic';f.models.models[0]!.runtime='sherpa';
  const result=await compareSpeakerModels(f.manifest,{base:f.root,directory:f.directory,models:f.models,
    registry:f.registry,policy:voiceprintPolicy(),open:async()=>{throw new Error('load fixture');}});
  assert.equal(result.complete,false);assert.equal(result.models[0]!.status,'failed');
  assert.deepEqual(result.models[0]!.channels,{});assert.equal(result.models[1]!.status,'completed');
});

test('anchor labels require a prior verified utterance in the same call, including recorded registry verification',async t=>{
  const f=await fixture(t),sample=f.manifest.samples.find(s=>s.role==='window'&&s.label==='owner')!;
  sample.verification={kind:'in_call_anchor',verified_utterance:'recorded'};
  f.manifest.verified_utterances=[{id:'recorded',call_id:'fixture-call',at_ms:19000,source:'registry_verified'}];
  assert.equal((await evaluate(f)).complete,true);
  f.manifest.verified_utterances[0]!.at_ms=25000;
  await assert.rejects(evaluate(f),/OFFLINE_INDEPENDENT_LABEL_REQUIRED/);
  f.manifest.verified_utterances[0]!.at_ms=19000;f.manifest.verified_utterances[0]!.call_id='other-call';
  await assert.rejects(evaluate(f),/OFFLINE_INDEPENDENT_LABEL_REQUIRED/);
});

test('current model identity must be bound to the registry snapshot',async t=>{
  const f=await fixture(t);f.models.models[0]!.sha256='f'.repeat(64);
  await assert.rejects(evaluate(f),/OFFLINE_CURRENT_MODEL_MISMATCH/);
});

test('an unscorable owner window is counted and cannot silently improve reported recall',async t=>{
  const f=await fixture(t);f.models.models[0]!.runtime='sherpa';let calls=0,closed=false;
  const result=await compareSpeakerModels(f.manifest,{base:f.root,directory:f.directory,models:f.models,
    registry:f.registry,policy:voiceprintPolicy(),open:async()=>({model:f.registry.owner_sets[0]!.model,
      embed:async()=>{if(++calls===6)throw new ContractError('SPEECH_INPUT_TOO_SHORT');return axis();},close:async()=>{closed=true;}})});
  const current=result.models[0]!,channel=current.channels.call!;
  assert.equal(current.status,'incomplete');assert.equal(result.complete,false);assert.equal(closed,true);
  assert.equal(channel.at_channel_line.unscorable_owner,1);assert.equal(channel.at_channel_line.recall,null);
  assert.equal(channel.at_065.recall,null);assert.equal(current.errors.SPEECH_INPUT_TOO_SHORT,1);
  assert.equal(result.models[1]!.status,'completed');
});
