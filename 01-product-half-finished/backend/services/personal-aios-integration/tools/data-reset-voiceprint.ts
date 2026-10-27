/** Release-only JSON-stdin worker. Reuses the registry envelope; never enrolls, scores or verifies. */
import {readFile,open,rename,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadRegistryCipher,isSealedRegistry} from '../src/voiceprint/cipher.ts';
import {openReadOnlySnapshot} from '../src/owner-db.ts';
import {migrateRegistry} from '../src/voiceprint/registry.ts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One partition serves inspection, the fresh projection and merge-restore. */
function partition(doc:any,override:boolean){
  if(override){
    if(typeof doc.enabled!=='boolean'||!Array.isArray(doc.failures))throw Error();
    return {keep:{enabled:doc.enabled,expires_at:doc.expires_at,enabled_by_device:doc.enabled_by_device},
      clear:{failures:doc.failures},empty:{failures:[]},counts:{failures:doc.failures.length,settings:3}};
  }
  if(!['paios.voiceprint.registry.v1','paios.voiceprint.registry.v2'].includes(doc.schema))throw Error();
  const owner=doc.schema.endsWith('.v1')?{owner:doc.owner}:{owner_sets:doc.owner_sets};
  if(doc.schema.endsWith('.v2')&&!Array.isArray(doc.owner_sets))throw Error();
  const keep={...owner,face_recognition:doc.face_recognition,recognition_hints:doc.recognition_hints,verified_lines:doc.verified_lines};
  const clear={...doc};for(const key of [...Object.keys(keep),'schema','revision'])delete clear[key];
  return {keep,clear,empty:{next_number:1,clusters:[],assistant:[]},counts:{
    owner_sets:doc.schema.endsWith('.v1')?(doc.owner?1:0):doc.owner_sets.length,
    clusters:(doc.clusters??[]).length,face_people:(doc.face_people??[]).length,
    learned_owner:Object.keys(doc.learned_owner??{}).length,conversation_owner:(doc.conversation_owner??[]).length,
    call_owner:doc.call_owner?1:0,assistant:(doc.assistant??[]).length}};
}
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
let merging=false,override=false;
try {
  let input='';for await(const part of process.stdin)input+=part;
  const request=JSON.parse(input) as {path:string;key_file:string;apply?:boolean;override?:boolean;sqlite?:boolean;scratch_directory?:string;keep_from?:string};
  merging=!!request.keep_from;override=!!request.override;
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
  const original=await readFile(request.path);
  const liveBytes=request.apply&&request.keep_from?await readFile(request.keep_from):original;
  const cipher=isSealedRegistry(original)||isSealedRegistry(liveBytes)?await loadRegistryCipher(request.key_file):undefined;
  const decode=(bytes:Uint8Array)=>JSON.parse(Buffer.from(isSealedRegistry(bytes)?cipher!.open(bytes):bytes).toString());
  const doc=decode(original);
  let parts=partition(doc,override);
  if(request.apply){
    const live=liveBytes===original?doc:decode(liveBytes);
    partition(live,override);
    // Cross-version restore uses the live producer's one migration contract.
    const migrating=merging&&!override&&live.schema!==doc.schema;
    const cutDoc=migrating?migrateRegistry(doc):doc;
    const liveDoc=migrating?migrateRegistry(live):live;
    if(liveDoc.schema!==cutDoc.schema)throw Error();
    parts=partition(cutDoc,override);
    const kept=partition(liveDoc,override).keep;
    const next={...(!override?{schema:cutDoc.schema,revision:Math.max(doc.revision,live.revision)+1}:{}),
      ...(merging?parts.clear:parts.empty),...kept};
    const body=Buffer.from(JSON.stringify(next));
    await install(request.path,cipher?cipher.seal(body):body);
  }
  const {owner,owner_sets,...settings}=parts.keep as any;
  process.stdout.write(JSON.stringify({counts:parts.counts,...(!override?{metadata:{schema:doc.schema,revision:doc.revision,
    owner_sha256:hash(migrateRegistry(doc).owner_sets)},
    owner_sha256:hash('owner' in parts.keep?owner:owner_sets)}:{}),
    settings_sha256:hash(settings),clear_sha256:hash(parts.clear)})+'\n');
} catch {
  process.stdout.write(JSON.stringify({error:merging?'RESET_ROLLBACK_MIXED_UNMERGEABLE_'+(override?'OVERRIDE':'VOICEPRINT'):'RESET_VOICEPRINT_FAILED'})+'\n');
  process.exitCode=1;
}
