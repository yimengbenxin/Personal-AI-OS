/** Real producer + worker envelope transition; synthetic key exists only in process memory. */
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const keyPath='synthetic-memory-only-voice-key';
function injectKey(encoded:string){
  const readFile=fs.readFile;
  fs.readFile=((path:unknown,...args:unknown[])=>path===keyPath?Promise.resolve(encoded):
    Reflect.apply(readFile,fs,[path,...args])) as typeof fs.readFile;
  syncBuiltinESMExports();
}

if(process.env.N15_SYNTHETIC_VOICE_KEY){
  // This module is also the worker preload. No key file is opened or created.
  injectKey(process.env.N15_SYNTHETIC_VOICE_KEY);
}else{
  injectKey(randomBytes(32).toString('base64'));
  const {loadRegistryCipher,isSealedRegistry}=await import('../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/cipher.ts');
  const {VoiceprintRegistry}=await import('../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts');
  const {PosixStorage}=await import('../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts');
  const cipher=await loadRegistryCipher(keyPath),base=process.argv[2]!,cut=join(base,'cut');
  const model={id:'synthetic',sha256:'a'.repeat(64),dim:16};
  const doc={schema:'paios.voiceprint.registry.v2',revision:9,next_number:1,owner_sets:[],clusters:[],assistant:[],recognition_hints:true};
  const storage=new PosixStorage(join(base,'central'));
  const registryKey=createHash('sha256').update(JSON.stringify('paios.voiceprint.registry.v1')).digest('hex');
  const live=join(base,'central/voiceprints',registryKey);
  await storage.replace('voiceprints',registryKey,Buffer.from(JSON.stringify(doc)));
  await fs.writeFile(cut,JSON.stringify(doc));
  const registry=new VoiceprintRegistry(storage,model,{cipher});
  const embedding=new Float32Array(16);embedding[0]=1;
  await registry.observeAssistant({voice:'system_tts',embedding,speech_ms:2500,at:'2026-10-27T00:00:00.000Z'});
  await registry.close();await storage.close();
  const produced=await fs.readFile(live);
  const encoded=await fs.readFile(keyPath,'utf8');
  const worker=new URL('../../01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts',import.meta.url);
  const missing=process.argv[3]==='missing';
  const result=spawnSync(process.execPath,[...(missing?[]:['--import',import.meta.url]),worker.pathname],{
    input:JSON.stringify({path:cut,keep_from:live,apply:true,key_file:missing?join(base,'absent-key'):keyPath}),
    env:{...process.env,...(missing?{}:{N15_SYNTHETIC_VOICE_KEY:encoded})},encoding:'utf8'});
  const restored=await fs.readFile(cut);
  console.log(JSON.stringify({producer_sealed:isSealedRegistry(produced),producer_revision:JSON.parse(Buffer.from(cipher.open(produced)).toString()).revision,
    worker_exit:result.status,result:JSON.parse(result.stdout),restored_sealed:isSealedRegistry(restored),
    restored:JSON.parse(Buffer.from(isSealedRegistry(restored)?cipher.open(restored):restored).toString())}));
}
