import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256,digest} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {encodeEmbedding,type RegistryDoc} from '../src/voiceprint/registry.ts';
import type {ComparisonManifest} from '../tools/voiceprint-model-comparison.ts';
import type {OfflineModelManifest} from '../tools/voiceprint-offline-models.ts';

export const axis=(score=1,dim=32)=>Float32Array.from({length:dim},(_,i)=>i===0?score:i===1?Math.sqrt(1-score**2):0);
export async function offlineFixture(root:string){
  const directory=join(root,'models'),store=join(root,'store');await mkdir(directory,{recursive:true});
  const ids=['current','eres2netv2','eres2netv2-w24s4ep4','cam-plus-plus'];
  const models:OfflineModelManifest={schema:'voiceprint-offline-models/v1',models:[]};
  for(const id of ids){const bytes=Buffer.from('synthetic-pin-'+id);
    await writeFile(join(directory,id+'.fixture'),bytes);
    models.models.push({id,role:id==='current'?'current':'candidate',runtime:'synthetic',file:id+'.fixture',sha256:sha256(bytes)});}
  await writeFile(join(directory,'models.json'),JSON.stringify(models));
  const model={id:'current',sha256:models.models[0]!.sha256,dim:32},at='2026-10-21T00:00:00.000Z';
  const set={model,samples:Array.from({length:20},(_,i)=>({embedding:encodeEmbedding(axis()),speech_ms:2000,
    added_at:new Date(Date.parse(at)+i*2000).toISOString()})),centroid:encodeEmbedding(axis()),verified_threshold:.68,
    consistency:{min:1,mean:1},enrolled_at:at,updated_at:at};
  const registry:RegistryDoc={schema:'paios.voiceprint.registry.v2',revision:1,next_number:1,owner_sets:[{...set,channel:'file'}],
    call_owner:{...structuredClone(set),channel:'call',source_sets:'fixture',provenance:'biometric_confirmed'},clusters:[],assistant:[]};
  const storage=new PosixStorage(store),key=digest('paios.voiceprint.registry.v1');
  try{await storage.replace('voiceprints',key,Buffer.from(JSON.stringify(registry)));}finally{await storage.close();}
  const scores=[[.9,.7,.66,.64,.61,.66,.1],[.93,.8,.72,.67,.5,.55,.05],[.95,.9,.85,.8,.7,.62,.1],[.8,.67,.66,.4,.6,.64,.2]];
  const manifest:ComparisonManifest={schema:'voiceprint-model-comparison/v1',evidence:'synthetic',samples:[]};
  for(let i=0;i<5;i++)manifest.samples.push({id:'ref-'+i,call_id:'fixture-call',at_ms:i*2000,channel:'call',role:'reference',label:'owner',verification:{kind:'face_id'},
    synthetic:Object.fromEntries(ids.map((id,k)=>[id,Array.from(axis(1,k?24:32))]))});
  for(let i=0;i<7;i++)manifest.samples.push({id:'window-'+i,call_id:'fixture-call',at_ms:20000+i*2000,channel:'call',role:'window',
    label:i<4?'owner':(['guest','rejected','echo'] as const)[i-4]!,...(i<4?{verification:{kind:'in_call_anchor' as const,verified_utterance:'ref-0'}}:{}),
    synthetic:Object.fromEntries(ids.map((id,k)=>[id,Array.from(axis(scores[k]![i]!,k?24:32))]))});
  const windows=join(root,'windows.json'),file=join(root,'registry.json');
  await writeFile(windows,JSON.stringify(manifest));await writeFile(file,JSON.stringify(registry));
  return {models,registry,manifest,directory,store,file,windows,path:join(store,'voiceprints',key)};
}
