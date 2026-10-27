import assert from 'node:assert/strict';
import test from 'node:test';
import {stat} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {speakerModelIdentity} from '../src/voiceprint/registry.ts';
import {verifyModelFile} from '../src/voiceprint/engine.ts';
import {openOfflineModel} from '../tools/voiceprint-offline-models.ts';

test('offline adapter uses the existing pinned CPU speaker worker on generated PCM only',async t=>{
  const path=join(process.env.PAIOS_MODEL_ROOT??'/unavailable','sherpa/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx');
  if(!await stat(path).catch(()=>undefined)){t.skip('existing runner speaker fixture unavailable');return;}
  const model=await speakerModelIdentity(path,192);await verifyModelFile({path,sha256:model.sha256});
  const engine=await openOfflineModel({id:model.id,role:'current',runtime:'sherpa',file:basename(path),sha256:model.sha256},dirname(path));
  try{
    const pcm=Float32Array.from({length:16000},(_,i)=>.1*Math.sin(2*Math.PI*220*i/16000));
    const vector=await engine.embed(pcm);
    assert.equal(engine.model.dim,192);assert.equal(vector.length,192);assert.ok(vector.every(Number.isFinite));
    assert.ok(vector.some(v=>v!==0));assert.equal(pcm.length,16000);
  }finally{await engine.close();}
});
