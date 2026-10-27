import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateVoiceprints,type EvaluationManifest} from '../tools/voiceprint-evaluate.ts';
import {PosixStorage} from '../src/storage.ts';
import {digest} from '../src/contracts.ts';
import {fileURLToPath} from 'node:url';
const fixture=new URL('./fixtures/voiceprint-evaluation-synthetic.json',import.meta.url);
const manifest=async()=>JSON.parse(await readFile(fixture,'utf8')) as EvaluationManifest;
test('synthetic harness compares all ablations and channel denominators without claiming acoustic performance',async()=>{
  const result=await evaluateVoiceprints(await manifest(),{base:'.'});
  assert.equal(result.performance_claim,'none_contract_or_synthesized_audio_only');
  assert.equal(result.sample_counts.probe,32);
  for(const name of ['baseline','multiwindow','quality_weighting','as_norm','channel_calibration']){
    const strategy=result.results[name] as any;assert.equal(strategy.status,'completed');
    assert.deepEqual(Object.keys(strategy.channels),['ambient','call','file','glasses','journal','mac','phone_app','video']);
  }
  const channel=(result.results.baseline as any).channels.file;
  assert.equal(channel.owner.recall,.5);assert.equal(channel.tv.false_accept_rate,0);
  assert.equal(channel.other.false_accept_rate,0);assert.equal(channel.uncertain_rate,.25);
});
test('missing independent cohorts skips normalization; duplicate trial identities fail instead of leaking split',async()=>{
  const input=await manifest();input.samples=input.samples.filter(s=>s.role!=='cohort');
  const result=await evaluateVoiceprints(input,{base:'.'});
  assert.equal((result.results.as_norm as any).status,'not_run');
  input.samples.push(input.samples[0]!);
  await assert.rejects(evaluateVoiceprints(input,{base:'.'}),/EVALUATION_SAMPLE_INVALID/);
});
test('CLI records its result only to the explicitly selected local storage root',async t=>{
  const root=await mkdtemp(join(tmpdir(),'voiceprint-evaluation-result-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const output=join(root,'result.json');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const cli=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/voiceprint-evaluate.ts',import.meta.url)),
    '--manifest',fixture.pathname,'--output',output,'--record-result',join(root,'store')]);
  assert.equal(JSON.parse(cli.stdout).schema,'voiceprint-evaluation-result/v1');
  const storage=new PosixStorage(join(root,'store'));
  try{assert.deepEqual(JSON.parse(Buffer.from(await storage.read('voiceprint-evaluations',digest('last'))).toString()),JSON.parse(await readFile(output,'utf8')));}
  finally{await storage.close();}
});

test('quality ablation weights enrollment samples and derived channels cannot enroll',async()=>{
  const input=await manifest(),enroll=input.samples.filter(s=>s.role==='enroll');
  enroll[4]!.embedding=[.7,Math.sqrt(.51),...Array(30).fill(0)];enroll[4]!.quality=.01;
  input.samples=[...enroll,{id:'held-out-tv',channel:'ambient',role:'probe',label:'tv',speech_ms:2000,
    embedding:[.6,.8,...Array(30).fill(0)]}];
  const result=await evaluateVoiceprints(input,{base:'.'});
  assert.equal((result.results.baseline as any).probes[0].verdict,'verified');
  assert.equal((result.results.quality_weighting as any).probes[0].verdict,'uncertain');
  enroll[0]!.channel='call';
  await assert.rejects(evaluateVoiceprints(input,{base:'.'}),/EVALUATION_SAMPLE_INVALID/);
});
