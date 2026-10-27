import {accessSync,constants,readFileSync,statSync} from 'node:fs';
import {basename,isAbsolute,join} from 'node:path';
import {canonical,check,digest} from './contracts.ts';
import {type LocalSpeechConfig,type ModelFile,verifyModelFile,CALL_INTERRUPT_KEYWORDS,parseKeywordSpecs} from './voiceprint/engine.ts';
import type {VoiceprintScoringConfig,VoiceprintThresholds} from './voiceprint/registry.ts';
import {validateLocalEmbeddingConfiguration,type LocalEmbeddingConfiguration} from './visual/local-embedding.ts';

export const localModelKinds=['asr','vad','voiceprint','wakeword','face','embedding'] as const;
export type LocalModelKind=typeof localModelKinds[number];
type Common={id:string;display_name:string};
export type LocalModelEntry=Common&(
  {kind:'asr';config:LocalSpeechConfig['asr']}|
  {kind:'vad';config:LocalSpeechConfig['vad']}|
  {kind:'wakeword';config:NonNullable<LocalSpeechConfig['kws']>}|
  {kind:'voiceprint';config:{model:ModelFile;dim:number;thresholds?:Partial<VoiceprintThresholds>;
    scoring?:VoiceprintScoringConfig;verified_channels?:Partial<Record<'phone_app'|'glasses'|'mac'|'file',number>>}}|
  {kind:'face';config:{model:ModelFile}}|
  {kind:'embedding';config:LocalEmbeddingConfiguration}|
  {kind:'embedding';legacy:true;config:{model:string;endpoint:string;space_id:string;dimensions:number}}
);
export interface LocalModelCatalog {catalog_id:string;models:LocalModelEntry[]}
export interface LocalModelSelection {generation:number;entry:LocalModelEntry}
const object=(value:unknown,fields:string[],required=fields):Record<string,unknown>=>{
  check(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key))&&required.every(key=>Object.hasOwn(value,key)),'LOCAL_MODEL_CATALOG_INVALID');
  return value as Record<string,unknown>;
};
function file(value:unknown):ModelFile {
  const f=object(value,['path','sha256']);check(typeof f.path==='string'&&isAbsolute(f.path)&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/u.test(f.sha256),'LOCAL_MODEL_CATALOG_INVALID');
  return f as unknown as ModelFile;
}
export function parseLocalModelCatalog(value:unknown):LocalModelCatalog {
  const catalog=object(value,['catalog_id','models']);
  check(typeof catalog.catalog_id==='string'&&/^[A-Za-z0-9_.-]{1,128}$/u.test(catalog.catalog_id)&&Array.isArray(catalog.models)&&catalog.models.length<=100,'LOCAL_MODEL_CATALOG_INVALID');
  const ids=new Set<string>();
  for(const value of catalog.models){
    const entry=object(value,['id','display_name','kind','config']);
    check(typeof entry.id==='string'&&/^[A-Za-z0-9_.-]{1,128}$/u.test(entry.id)&&!['previous','effective'].includes(entry.id)&&!ids.has(entry.id)&&typeof entry.display_name==='string'&&entry.display_name.length>0&&entry.display_name.length<=120&&localModelKinds.includes(entry.kind as LocalModelKind),'LOCAL_MODEL_CATALOG_INVALID');
    ids.add(entry.id);const kind=entry.kind;
    if(kind==='embedding'){validateLocalEmbeddingConfiguration(entry.config);continue;}
    const keys=kind==='asr'?['model','tokens']:kind==='wakeword'?['encoder','decoder','joiner','tokens','keywords','call_keywords','score','threshold']:
      kind==='voiceprint'?['model','dim','thresholds','scoring','verified_channels']:['model'];
    const c=object(entry.config,keys,kind==='voiceprint'?['model','dim','thresholds']:keys);
    for(const name of kind==='asr'?['model','tokens']:kind==='wakeword'?['encoder','decoder','joiner','tokens']:['model'])file(c[name]);
    if(kind==='voiceprint'){
      check(Number.isSafeInteger(c.dim)&&Number(c.dim)>=16&&Number(c.dim)<=4096,'LOCAL_MODEL_CATALOG_INVALID');
      const t=object(c.thresholds,['owner_verified','owner_uncertain','cluster','enroll_consistency','assistant']);
      check(Object.values(t).every(n=>typeof n==='number'&&n>0&&n<1)&&Number(t.owner_uncertain)<=Number(t.owner_verified),'LOCAL_MODEL_CATALOG_INVALID');
      if(c.verified_channels!==undefined){const lines=object(c.verified_channels,['phone_app','glasses','mac','file'],[]);
        check(Object.values(lines).every(n=>typeof n==='number'&&n>=Number(t.owner_verified)&&n<1),'LOCAL_MODEL_CATALOG_INVALID');}
    }
    if(kind==='wakeword'){
      parseKeywordSpecs(c.keywords,'LOCAL_MODEL_CATALOG_INVALID');parseKeywordSpecs(c.call_keywords,'LOCAL_MODEL_CATALOG_INVALID');
      check(typeof c.score==='number'&&c.score>0&&c.score<=10&&typeof c.threshold==='number'&&c.threshold>0&&c.threshold<1,'LOCAL_MODEL_CATALOG_INVALID');
    }
  }
  return structuredClone(catalog) as unknown as LocalModelCatalog;
}
export const loadLocalModelCatalog=(path:string)=>parseLocalModelCatalog(JSON.parse(readFileSync(path,'utf8')));
export const localModelPin=(entry:LocalModelEntry)=>digest(entry);
export function localModelFiles(entry:LocalModelEntry):ModelFile[] {
  if(entry.kind==='embedding')return 'legacy' in entry?[]:entry.config.artifacts.map(f=>({...f,path:join(entry.config.model_directory,f.path)}));
  const c=entry.config;
  return entry.kind==='wakeword'?[entry.config.encoder,entry.config.decoder,entry.config.joiner,entry.config.tokens]:entry.kind==='asr'?[entry.config.model,entry.config.tokens]:[(c as {model:ModelFile}).model];
}
export function localModelInstalled(entry:LocalModelEntry):boolean {
  try {for(const f of localModelFiles(entry)){accessSync(f.path,constants.R_OK);if(!statSync(f.path).isFile())return false;}
    if(entry.kind==='embedding'&&!('legacy' in entry))accessSync(entry.config.python,constants.X_OK);
    return true;
  }catch(error){if(['ENOENT','ENOTDIR','EACCES'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}
}
export async function verifyLocalModel(entry:LocalModelEntry):Promise<void> {
  check(localModelInstalled(entry),'LOCAL_MODEL_NOT_INSTALLED',409);for(const artifact of localModelFiles(entry))await verifyModelFile(artifact);
}
export function localSpeakerIdentity(entry:Extract<LocalModelEntry,{kind:'voiceprint'}>) {
  return {id:basename(entry.config.model.path).replace(/\.onnx$/u,''),sha256:entry.config.model.sha256,dim:entry.config.dim};
}
/** New wake models retain the owner's approved words. Tokenization belongs to the new complete package. */
export function validateLocalSwitch(previous:LocalModelEntry,next:LocalModelEntry):void {
  check(previous.kind===next.kind,'LOCAL_MODEL_KIND_MISMATCH');check(next.kind!=='face','LOCAL_MODEL_FACE_ENROLLMENT_REQUIRED',409);
  check(localModelInstalled(next),'LOCAL_MODEL_NOT_INSTALLED',409);
  if(previous.kind==='wakeword'&&next.kind==='wakeword'){
    check(next.config.call_keywords,'LOCAL_MODEL_CALL_KEYWORDS_REQUIRED',409);
    for(const [before,after] of [[previous.config.keywords,next.config.keywords],[previous.config.call_keywords??CALL_INTERRUPT_KEYWORDS,next.config.call_keywords]] as const)
      check(canonical(before.map(k=>k.label).toSorted())===canonical(after.map(k=>k.label).toSorted()),'LOCAL_MODEL_WAKE_WORD_CHANGED',409);
  }
}
