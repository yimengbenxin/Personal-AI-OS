/** Synthetic production-format settings/registry seed. No provider, external tool or network call. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {loadRegistryCipher} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/cipher.ts';
import {VoiceprintRegistry} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {ModelSettingsAuthority} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings.ts';
import {writeModelSettingsProjection} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-projection.ts';

let input='';for await(const part of process.stdin)input+=part;
const {getLoadablePath}=createRequire(new URL('../../01-product-half-finished/backend/services/personal-aios-integration/package.json',import.meta.url))('sqlite-vec');
const {roots,verify}=JSON.parse(input),model={id:'fixture-synthetic',sha256:'a'.repeat(64),dim:16};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const key=join(roots.secrets,'voiceprint.key'),cipher=await loadRegistryCipher(key);
if(!verify){
  const values=new Float32Array(16);values[0]=1;const vector=Buffer.from(values.buffer).toString('base64');
  const set={channel:'phone_app',model,samples:Array.from({length:5},()=>({embedding:vector,speech_ms:2500,added_at:'2026-10-25T00:00:00Z'})),
    centroid:vector,enrolled_at:'2026-10-25T00:00:00Z',updated_at:'2026-10-25T00:00:00Z',consistency:{min:1,mean:1}};
  const doc={schema:'paios.voiceprint.registry.v2',revision:9,next_number:3,owner_sets:[set],
    clusters:[{cluster_id:'1',model_sha256:model.sha256,centroid:vector,count:2,speech_ms:5000,created_at:'2026-10-25T00:00:00Z',last_seen:'2026-10-25T00:00:00Z',display_name:'synthetic guest'}],
    assistant:[{voice:'system_tts',model_sha256:model.sha256,centroid:vector,count:1,speech_ms:2000,created_at:'2026-10-25T00:00:00Z',last_seen:'2026-10-25T00:00:00Z'}],
    learned_owner:{ambient:{...set,channel:'ambient',source_sets:'synthetic'}},conversation_owner:[set],
    call_owner:{...set,channel:'call',source_sets:'synthetic'},face_recognition:true,recognition_hints:false,
    verified_lines:[{model,channel:'phone_app',threshold:0.73}],
    face_people:[{cluster_id:'2',count:0,display_name:'synthetic guest face',face_samples:[]}]};
  const directory=join(roots.owner,'central-storage','voiceprints');await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,hash(JSON.stringify('paios.voiceprint.registry.v1'))),cipher.seal(Buffer.from(JSON.stringify(doc))),{mode:0o600});
  const authority=ModelSettingsAuthority.open(roots.models,{environment_id:'fixture-synthetic',master_key_file:join(roots.secrets,'model-settings-master.key'),
    activate:async()=>{},probeUsage:()=>{throw Error('no provider');}});
  authority.vault.save(authority.vault.seal('role-brain','synthetic-credential-never-print'));
  writeModelSettingsProjection(authority,roots.projections,'owner',0,'brain',true);
  writeModelSettingsProjection(authority,roots.projections,'workshop',0,'build',true);
  authority.close();
  const visual=join(roots.owner,'central-storage','visual-memory');await mkdir(visual,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(visual,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  const source=await readFile(new URL('../../01-product-half-finished/backend/services/personal-aios-integration/src/visual/store.ts',import.meta.url),'utf8');
  db.exec(source.split('const DDL=\x60')[1]!.split('\x60;')[0]!);
  const image=new Float32Array(1024);image[0]=1;
  db.prepare('INSERT INTO vectors(embedding,principal_id,captured_ms) VALUES(?,?,?)').run(Buffer.from(image.buffer),'owner',1n);
  db.close();
}
const storage=new PosixStorage(join(roots.owner,'central-storage'));
const registry=new VoiceprintRegistry(storage,model,{cipher});
const status=await registry.owner();
if(!status.enrolled||status.samples!==5)throw Error('owner enrollment lost');
await registry.close();await storage.close();
process.stdout.write('{"owner_enrolled":true,"samples":5}\n');
