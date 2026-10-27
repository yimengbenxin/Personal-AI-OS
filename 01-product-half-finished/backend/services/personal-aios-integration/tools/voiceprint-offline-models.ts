// Local files only. Reuse the production speaker worker, without opening ASR, VAD or a service.
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {check} from '../src/contracts.ts';
import {verifyModelFile,VAD_POLICY} from '../src/voiceprint/engine.ts';
import {SpeechWorker} from '../src/voiceprint/worker.ts';
import type {SpeakerModel} from '../src/voiceprint/registry.ts';

export interface OfflineModel {
  id:string;role:'current'|'candidate';runtime:'sherpa'|'synthetic';file:string;sha256:string;
}
export interface OfflineModelManifest {schema:'voiceprint-offline-models/v1';models:OfflineModel[]}
export interface OfflineEmbedder {model:SpeakerModel;embed(pcm:Float32Array):Promise<Float32Array>;close():Promise<void>}
/** A relative pin cannot silently resolve to a remote or an unrelated model outside the supplied directory. */
export async function localModelPath(directory:string,file:string):Promise<string> {
  check(typeof file==='string'&&!isAbsolute(file),'OFFLINE_MODEL_PATH_INVALID');
  const root=await realpath(directory),path=await realpath(resolve(root,file)),rel=relative(root,path);
  check(rel!==''&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel),'OFFLINE_MODEL_PATH_INVALID');
  return path;
}
export async function pinnedModels(directory:string):Promise<OfflineModelManifest> {
  const manifest=JSON.parse(await readFile(resolve(directory,'models.json'),'utf8')) as OfflineModelManifest;
  check(manifest?.schema==='voiceprint-offline-models/v1'&&Array.isArray(manifest.models)&&manifest.models.length>=2&&
    manifest.models.filter(m=>m.role==='current').length===1&&new Set(manifest.models.map(m=>m.id)).size===manifest.models.length,
    'OFFLINE_MODEL_MANIFEST_INVALID');
  for(const m of manifest.models){
    check(/^[a-zA-Z0-9_.-]{1,100}$/.test(m.id)&&['current','candidate'].includes(m.role)&&
      ['sherpa','synthetic'].includes(m.runtime)&&/^[a-f0-9]{64}$/.test(m.sha256),'OFFLINE_MODEL_MANIFEST_INVALID');
    await verifyModelFile({path:await localModelPath(directory,m.file),sha256:m.sha256});
  }
  return manifest;
}
export async function openOfflineModel(spec:OfflineModel,directory:string):Promise<OfflineEmbedder> {
  check(spec.runtime==='sherpa','OFFLINE_NATIVE_MODEL_REQUIRED');
  const path=await localModelPath(directory,spec.file);
  // The caller validates every pin before any inference. No download, model substitution or precision change.
  const loaded=await SpeechWorker.open(new URL('../src/voiceprint/engine-thread.ts',import.meta.url),{
    num_threads:1,max_streams:1,speaker_only:true,speaker:{model:path},
    vad:{model:'',...VAD_POLICY},asr:{model:'',tokens:'',language:'zh'},
  },600000,1);
  return {model:{id:spec.id,sha256:spec.sha256,dim:loaded.dim},
    embed:pcm=>loaded.worker.call<Float32Array>({op:'embed',samples:pcm}),close:()=>loaded.worker.close()};
}
