/** Release-only JSON-stdin worker. Reuses the registry envelope; never enrolls, scores or verifies. */
import {readFile,open,rename,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadRegistryCipher,isSealedRegistry} from '../src/voiceprint/cipher.ts';
import {openReadOnlySnapshot} from '../src/owner-db.ts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function install(path:string,body:Uint8Array){
  const info=await stat(path),target=path+'.reset-'+randomUUID(),file=await open(target,'wx',info.mode&0o777);
  try{
    await file.writeFile(body);await file.chmod(info.mode&0o777);
    if(process.getuid?.()===0)await file.chown(info.uid,info.gid);
    await file.sync();
  }finally{await file.close();}
  await rename(target,path);
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
try {
  let input='';for await(const part of process.stdin)input+=part;
  const request=JSON.parse(input) as {path:string;key_file:string;apply?:boolean;override?:boolean;sqlite?:boolean;scratch_directory?:string};
  if(request.sqlite){
    if(request.scratch_directory)process.env.TMPDIR=request.scratch_directory;
    const snapshot=openReadOnlySnapshot(request.path,true),db=snapshot.db;
    try {
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE sql LIKE '%USING vec0%'").get()){
        const {getLoadablePath}=await import('sqlite-vec');db.enableLoadExtension(true);db.loadExtension(getLoadablePath());db.enableLoadExtension(false);
      }
      if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))throw Error();
      const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[])
        .map(({name})=>({table:name,clear_rows:Number(db.prepare('SELECT count(*) n FROM "'+name.replaceAll('"','""')+'"').get()!.n),keep_rows:0,keep_sha256:null}));
      process.stdout.write(JSON.stringify({tables})+'\n');
    } finally {snapshot.close();}
    process.exit(0);
  }
  if(request.override){
    const doc=JSON.parse((await readFile(request.path)).toString());
    if(typeof doc.enabled!=='boolean'||!Array.isArray(doc.failures))throw Error();
    const settings={enabled:doc.enabled,expires_at:doc.expires_at,enabled_by_device:doc.enabled_by_device};
    if(request.apply)await install(request.path,Buffer.from(JSON.stringify({...settings,failures:[]})));
    process.stdout.write(JSON.stringify({counts:{failures:doc.failures.length,settings:3},settings_sha256:hash(settings)})+'\n');
    process.exit(0);
  }
  const original=await readFile(request.path),sealed=isSealedRegistry(original);
  const cipher=sealed?await loadRegistryCipher(request.key_file):undefined;
  const doc=JSON.parse(Buffer.from(cipher?cipher.open(original):original).toString());
  if(!['paios.voiceprint.registry.v1','paios.voiceprint.registry.v2'].includes(doc.schema))throw Error();
  const owner=doc.schema.endsWith('.v1')?doc.owner:doc.owner_sets;
  if(doc.schema.endsWith('.v2')&&!Array.isArray(owner))throw Error();
  const settings={face_recognition:doc.face_recognition,recognition_hints:doc.recognition_hints,verified_lines:doc.verified_lines};
  const counts={owner_sets:Array.isArray(owner)?owner.length:owner?1:0,
    clusters:(doc.clusters??[]).length,face_people:(doc.face_people??[]).length,
    learned_owner:Object.keys(doc.learned_owner??{}).length,conversation_owner:(doc.conversation_owner??[]).length,
    call_owner:doc.call_owner?1:0,assistant:(doc.assistant??[]).length};
  if(request.apply){
    const next={schema:doc.schema,revision:doc.revision+1,next_number:1,
      ...(doc.schema.endsWith('.v1')?{owner}:{owner_sets:owner}),...settings,clusters:[],assistant:[]};
    const body=Buffer.from(JSON.stringify(next));
    await install(request.path,cipher?cipher.seal(body):body);
  }
  process.stdout.write(JSON.stringify({counts,owner_sha256:hash(owner),settings_sha256:hash(settings)})+'\n');
} catch {
  process.stdout.write('{"error":"RESET_VOICEPRINT_FAILED"}\n');process.exitCode=1;
}
