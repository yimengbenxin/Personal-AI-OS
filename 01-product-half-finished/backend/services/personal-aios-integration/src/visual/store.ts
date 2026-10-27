import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,unlink,open,lstat,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {getLoadablePath} from 'sqlite-vec';
import {canonical,check,ContractError,digest,type ArchivedEvent} from '../contracts.ts';
import type {RawArchive} from '../archive.ts';
import {openOwnerDatabase,inTransaction} from '../owner-db.ts';
import {hasTerminalCapability,type RegisteredDevice} from '../source-authority.ts';
import type {VoiceprintRegistry} from '../voiceprint/registry.ts';
import {prepareVisualImage,VISUAL_IMAGE_BYTES,type FaceEngine} from './image.ts';
import {VisualEmbeddingSpaces,type EmbeddingSpace,type EmbeddingProvider,type EmbeddingCandidate} from './embedding-spaces.ts';

export const VISUAL_INGEST_LIMITS=Object.freeze({active_jobs:1,image_bytes:VISUAL_IMAGE_BYTES});

export const CAMERA_TRIGGERS = ['interval','scene_change','user_request','head_dwell'] as const;
export type CameraTrigger = typeof CAMERA_TRIGGERS[number];
export interface CameraFrame {
  frame_id:string; captured_at:string; image:Buffer;
  trigger:CameraTrigger; worn:boolean; private_paused:boolean;
}
export interface CameraCapturePolicy {
  enabled:boolean; interval_ms:number; triggers:CameraTrigger[]; private_paused:boolean;
}
export const DEFAULT_CAMERA_CAPTURE_POLICY: Readonly<CameraCapturePolicy> = Object.freeze({enabled:true,interval_ms:30000,
  triggers:Object.freeze([...CAMERA_TRIGGERS]) as unknown as CameraTrigger[],private_paused:false});
/** The capture authority owns durable capture permission. Devices report wear/privacy on every frame;
 * absent wear never means worn. This gate runs before any image archive, analysis or model dispatch. */
export class CameraCapturePolicies {
  private readonly flights=new Map<string,Promise<unknown>>();private readonly active=new Map<string,Set<AbortController>>();
  private readonly records=new Map<string,Promise<CameraCapturePolicy>>();private readonly lastCapture=new Map<string,number>();
  private readonly leases=new Map<string,{purpose:string;until:number;interval:number}>();
  private readonly statuses=new Map<string,{principal_id:string;device_id:string;device_type:RegisteredDevice['device_type'];status:'available'|'paused'|'unavailable'|'error';error:string|null}>();
  private readonly storage:import('../storage.ts').StoragePort; private readonly now:()=>number;
  constructor(storage:import('../storage.ts').StoragePort,now:()=>number=Date.now) {this.storage=storage;this.now=now;}
  private key(source:Pick<RegisteredDevice,'principal_id'|'device_id'>):string {
    return digest({principal_id:source.principal_id,device_id:source.device_id});
  }
  private async serial<T>(key:string,consume:()=>Promise<T>):Promise<T> {
    const next=(this.flights.get(key)??Promise.resolve()).catch(()=>{}).then(consume);
    this.flights.set(key,next);
    try{return await next;}finally{if(this.flights.get(key)===next)this.flights.delete(key);}
  }
  private record(key:string):Promise<CameraCapturePolicy> {
    let record=this.records.get(key);
    if(!record){record=this.storage.read('camera-capture-policy',key).then(bytes=>{
      return JSON.parse(Buffer.from(bytes).toString('utf8')).policy;})
      .catch(error=>{if(error.code!=='ENOENT')throw error;return {...DEFAULT_CAMERA_CAPTURE_POLICY,triggers:[...CAMERA_TRIGGERS]};});this.records.set(key,record);}
    return record;
  }
  private async save(key:string,policy:CameraCapturePolicy):Promise<void> {
    check(this.storage.replace,'CAMERA_CAPTURE_STORAGE_REQUIRED',503);
    await this.storage.replace('camera-capture-policy',key,Buffer.from(canonical({policy})));
    this.records.set(key,Promise.resolve(policy));
  }
  async policyForConnect(source:RegisteredDevice):Promise<CameraCapturePolicy> {
    const key=this.key(source),policy=await this.record(key),lease=this.leases.get(key);
    if(!lease)return policy;if(this.now()>=lease.until||!policy.enabled||policy.private_paused){this.leases.delete(key);return policy;}
    return {...policy,interval_ms:Math.min(policy.interval_ms,lease.interval)};
  }
  lease(source:RegisteredDevice,purpose:string,until:number,interval=1000){check(Number.isFinite(until)&&interval>=1000,'CAMERA_LEASE_INVALID');this.leases.set(this.key(source),{purpose,until,interval});}
  releaseLease(source:Pick<RegisteredDevice,'principal_id'|'device_id'>,purpose:string){if(this.leases.get(this.key(source))?.purpose===purpose)this.leases.delete(this.key(source));}
  reportStatus(source:RegisteredDevice,status:'available'|'paused'|'unavailable'|'error',error:string|null):void {
    this.statuses.set(this.key(source),{principal_id:source.principal_id,device_id:source.device_id,device_type:source.device_type,status,error});
  }
  statusesFor(principal:string) {
    return [...this.statuses.values()].filter(value=>value.principal_id===principal).map(({principal_id,...value})=>value);
  }
  async set(source:RegisteredDevice,patch:Partial<CameraCapturePolicy>):Promise<CameraCapturePolicy> {
    const key=this.key(source);
    if(patch.private_paused===true||patch.enabled===false){this.leases.delete(key);this.pause(source);}
    return this.serial(key,async()=>{
      const policy={...await this.record(key),...patch};
      await this.save(key,policy);return policy;
    });
  }
  pause(source:RegisteredDevice,reason=new ContractError('CAMERA_CAPTURE_PAUSED',403)):void {
    for(const controller of this.active.get(this.key(source))??[])controller.abort(reason);
  }
  async admit<T>(source:RegisteredDevice,frame:CameraFrame,consume:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const key=this.key(source),controller=new AbortController();
    const needsWear=hasTerminalCapability(source,'wear_state'),stopped=frame.private_paused||needsWear&&!frame.worn;
    if(stopped)this.pause(source,new ContractError(frame.private_paused?'CAMERA_CAPTURE_PAUSED':'CAMERA_NOT_WORN',403));
    else {const controllers=this.active.get(key)??new Set<AbortController>();controllers.add(controller);this.active.set(key,controllers);}
    try {
      await this.serial(key,async()=>{
        const policy=await this.policyForConnect(source);
        check(policy.enabled && !policy.private_paused && frame.private_paused===false,'CAMERA_CAPTURE_PAUSED',403);
        check(!needsWear||frame.worn===true,'CAMERA_NOT_WORN',403);
        check(policy.triggers.includes(frame.trigger),'CAMERA_TRIGGER_DENIED',403);
        const at=this.now(),minimum=frame.trigger==='user_request'?0:frame.trigger==='interval'?policy.interval_ms:5000;
        check(!this.lastCapture.has(key)||at-this.lastCapture.get(key)!>=minimum,'CAMERA_CAPTURE_INTERVAL',429);
        this.lastCapture.set(key,at);
      });
      controller.signal.throwIfAborted();const result=await consume(controller.signal);controller.signal.throwIfAborted();return result;
    } finally {const controllers=this.active.get(key);controllers?.delete(controller);if(!controllers?.size)this.active.delete(key);}
  }

}

export interface VisualModels {
  embeddingSpace?:EmbeddingSpace;
  embedImage(bytes:Buffer,signal?:AbortSignal):Promise<number[]>;embedQuery(text:string):Promise<number[]>;
  describe(bytes:Buffer,signal?:AbortSignal,context?:import('../hermes-client.ts').ModelSourceContext):Promise<{caption:string;ocr:string}>;
}
export interface ColdVisualPort {
  download(reference:string):Promise<Uint8Array>;
  delete(reference:string):Promise<void>;
}
export interface VisualRetention {retention_days:number;max_bytes:number}
type FrameRow={id:number;principal_id:string;device_id:string;frame_id:string;captured_ms:number;original:string;thumbnail:string;frame_key:string;cold_ref:string|null;cold_confirmed:number;
  raw_ref:string|null;archive_revision:string|null;signature:Uint8Array;caption:string;ocr:string;place:string|null;keyframe:number;bytes:number;state:string;owner_delete:number};
const DDL=`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS frames(id INTEGER PRIMARY KEY,principal_id TEXT NOT NULL,device_id TEXT NOT NULL,frame_id TEXT NOT NULL,
  captured_ms INTEGER NOT NULL,original TEXT NOT NULL,thumbnail TEXT NOT NULL,signature BLOB NOT NULL,caption TEXT NOT NULL DEFAULT '',
  ocr TEXT NOT NULL DEFAULT '',place TEXT,keyframe INTEGER NOT NULL,bytes INTEGER NOT NULL,state TEXT NOT NULL,
  frame_key TEXT NOT NULL UNIQUE,cold_ref TEXT,cold_confirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(principal_id,device_id,frame_id)) STRICT;
CREATE INDEX IF NOT EXISTS frames_time ON frames(principal_id,captured_ms);
CREATE TABLE IF NOT EXISTS frame_people(frame_key TEXT NOT NULL REFERENCES frames(frame_key) ON DELETE CASCADE,
  person_id TEXT NOT NULL,PRIMARY KEY(frame_key,person_id)) STRICT;
CREATE INDEX IF NOT EXISTS frame_people_person ON frame_people(person_id,frame_key);
CREATE VIRTUAL TABLE IF NOT EXISTS frame_text USING fts5(caption,ocr,content='frames',content_rowid='id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS frame_update AFTER UPDATE OF caption,ocr,state ON frames BEGIN
  INSERT INTO frame_text(frame_text,rowid,caption,ocr) SELECT 'delete',old.id,old.caption,old.ocr WHERE old.state='ready';
  INSERT INTO frame_text(rowid,caption,ocr) SELECT new.id,new.caption,new.ocr WHERE new.state='ready';END;
CREATE TRIGGER IF NOT EXISTS frame_delete AFTER DELETE ON frames WHEN old.state='ready' BEGIN
  INSERT INTO frame_text(frame_text,rowid,caption,ocr) VALUES('delete',old.id,old.caption,old.ocr);END;
CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(embedding float[1024] distance_metric=cosine,principal_id text partition key,captured_ms integer);
-- owner_delete: 0 admitted, 1 cleanup pending, 2 durable completed revocation.
CREATE TABLE IF NOT EXISTS capture_refs(raw_ref TEXT PRIMARY KEY,archive_revision TEXT NOT NULL,principal_id TEXT NOT NULL,
  captured_ms INTEGER NOT NULL,owner_delete INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS cold_deletes(reference TEXT PRIMARY KEY) STRICT;`;
const bounds=(args:{from?:unknown;until?:unknown})=>{
  const stamp=(value:unknown,otherwise:number)=>{if(value===undefined)return otherwise;
    check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)&&Number.isFinite(Date.parse(value)),'VISUAL_TIME_INVALID');
    return Date.parse(value);};
  const from=stamp(args.from,0),until=stamp(args.until,8640000000000000);
  check(from>=0&&until>from,'VISUAL_TIME_INVALID');return {from,until};
};

/** Derived visual catalogue. Original bytes and retention belong to the runtime L5 archive. */
export class VisualMemory {
  private active:Promise<unknown>=Promise.resolve();private readonly captures=new Set<{principal:string;at:number;controller:AbortController;pending?:Promise<unknown>;admission?:boolean}>();private closed=false;
  private readonly deletions=new Set<Promise<unknown>>();
  private readonly embeddingSpaces:VisualEmbeddingSpaces|undefined;
  private readonly queries=new Set<Promise<void>>();
  private indexingBytes=0;private indexing=false;private closing:Promise<void>|undefined;
  resourceSnapshot(){return {active_jobs:Number(this.indexing),input_bytes:this.indexingBytes,limits:VISUAL_INGEST_LIMITS};}
  private readonly db:DatabaseSync;readonly directory:string;private readonly models:VisualModels;private rawArchive:RawArchive|undefined;
  readonly retention:VisualRetention;private readonly people:VoiceprintRegistry|undefined;private readonly faces:FaceEngine|undefined;private readonly cold:ColdVisualPort|undefined;
  private constructor(db:DatabaseSync,directory:string,models:VisualModels,retention:VisualRetention,people?:VoiceprintRegistry,faces?:FaceEngine,cold?:ColdVisualPort){
    this.db=db;this.directory=directory;this.models=models;this.retention=retention;this.people=people;this.faces=faces;this.cold=cold;
    check(models.embeddingSpace||!db.prepare("SELECT 1 FROM meta WHERE key='embedding_active'").get(),'VISUAL_EMBEDDING_SPACE_REQUIRED',503);
    this.embeddingSpaces=models.embeddingSpace?new VisualEmbeddingSpaces(db,models as EmbeddingProvider):undefined;
  }
  static async open(directory:string,models:VisualModels,retention:Partial<VisualRetention>={},people?:VoiceprintRegistry,faces?:FaceEngine,cold?:ColdVisualPort,archive?:RawArchive) {
    const days=retention.retention_days??2,policy={retention_days:days,max_bytes:Math.ceil(days*513*1024*1024),...retention};
    check(Number.isSafeInteger(policy.retention_days)&&policy.retention_days>=1&&policy.retention_days<=365&&
      Number.isSafeInteger(policy.max_bytes)&&policy.max_bytes>=8*1024*1024,'VISUAL_RETENTION_INVALID');
    const db=openOwnerDatabase(directory,'visual.sqlite',DDL,'paios.visual-memory.v2','VISUAL',getLoadablePath());
    try {
      db.exec("PRAGMA secure_delete=ON;PRAGMA cache_size=-4096;INSERT INTO frame_text(frame_text,rank) VALUES('secure-delete',1)");
      const columns=db.prepare('PRAGMA table_info(frames)').all().map(row=>row.name);
      for(const column of ['raw_ref','archive_revision'])if(!columns.includes(column))db.exec(`ALTER TABLE frames ADD COLUMN ${column} TEXT`);
      if(!columns.includes('owner_delete'))db.exec('ALTER TABLE frames ADD COLUMN owner_delete INTEGER NOT NULL DEFAULT 0');
      const store=new VisualMemory(db,directory,models,policy,people,faces,cold);if(archive)store.bindArchive(archive);
      await mkdir(join(directory,'frames'),{recursive:true,mode:0o700});
      const path=join(directory,'frames'),stat=await lstat(path);
      check(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid?.(),'VISUAL_PATH_UNSAFE',500);await chmod(path,0o700);
      people?.setVisualMemory(store);await people?.reconcileFramePeople();
      db.exec("INSERT OR IGNORE INTO capture_refs(raw_ref,archive_revision,principal_id,captured_ms) SELECT raw_ref,archive_revision,principal_id,captured_ms FROM frames WHERE raw_ref IS NOT NULL;UPDATE frames SET state='deleting' WHERE state='indexing'");await store.finishRawDeletes();await store.run(()=>store.finishDeletes());
      const ready=db.prepare("SELECT 1 FROM frames WHERE frame_key=? AND state='ready'");await people?.pruneFaceEvidence(key=>Boolean(ready.get(key)));
      return store;
    }catch(error){people?.setVisualMemory(undefined);db.close();throw error;}
  }
  embeddingSpaceInfo(){return this.embeddingSpaces?.info();}
  prepareEmbeddingSpace(models:EmbeddingProvider,signal?:AbortSignal,onProgress?:(value:{done:number;total:number})=>void){
    return this.deleting(async()=>{check(this.embeddingSpaces,'VISUAL_EMBEDDING_SPACE_REQUIRED',503);
      return this.embeddingSpaces.prepare(models,(principal,key)=>this.imageBytes(principal,key),signal,onProgress);});
  }
  activateEmbeddingSpace(candidate:EmbeddingCandidate){
    check(!this.closed&&!this.closing,'VISUAL_CLOSED',503);check(!this.indexing,'VISUAL_EMBEDDING_INGEST_BUSY',409);
    check(this.embeddingSpaces,'VISUAL_EMBEDDING_SPACE_REQUIRED',503);this.embeddingSpaces.activate(candidate);
  }
  preparePreviousEmbeddingSpace(models:EmbeddingProvider,signal?:AbortSignal){
    return this.deleting(async()=>{check(this.embeddingSpaces,'VISUAL_EMBEDDING_SPACE_REQUIRED',503);
      return this.embeddingSpaces.preparePrevious(models,(principal,key)=>this.imageBytes(principal,key),signal);});
  }
  bindArchive(archive:RawArchive):void {
    check(!this.rawArchive||this.rawArchive===archive,'VISUAL_ARCHIVE_AUTHORITY_CONFLICT',500);this.rawArchive=archive;
  }
  /** Register before the producer's first await. Range deletion waits for its L5 cleanup. */
  captureArchive(principal:string,frame:CameraFrame,signal:AbortSignal,produce:()=>Promise<ArchivedEvent>) {
    check(!this.closed&&!this.closing,'VISUAL_CLOSED',503);
    const controller=new AbortController(),capture:{principal:string;at:number;controller:AbortController;admission:boolean;pending?:Promise<unknown>}={principal,at:Date.parse(frame.captured_at),controller,admission:true};
    const fenced=AbortSignal.any([signal,controller.signal]);this.captures.add(capture);
    const pending=(async()=>{
      const archived=await produce();
      try {
        await this.rawArchive!.locate(archived.raw_ref,principal);
        await this.run(async()=>{this.db.prepare('INSERT OR IGNORE INTO capture_refs(raw_ref,archive_revision,principal_id,captured_ms,owner_delete) VALUES(?,?,?,?,?)')
          .run(archived.raw_ref,archived.archive_revision,principal,capture.at,Number(fenced.aborted&&fenced.reason instanceof ContractError&&fenced.reason.code==='VISUAL_DELETED'));});
        fenced.throwIfAborted();
        return {archived,signal:fenced};
      }catch(error){
        if(fenced.aborted&&fenced.reason instanceof ContractError&&fenced.reason.code==='VISUAL_DELETED')await this.rawArchive!.delete(archived.raw_ref,principal);
        throw error;
      }
    })().finally(()=>this.captures.delete(capture));capture.pending=pending;return pending;
  }
  /** Links used to live only in the registry's bounded face samples; import those once, for retained frames. */
  migrateFaceLinks(people:{cluster_id:string;face_samples?:{frame_id:string}[]}[]):void {
    if(this.db.prepare("SELECT 1 FROM meta WHERE key='face_links_migrated'").get())return;
    inTransaction(this.db,()=>{
      const insert=this.db.prepare("INSERT OR IGNORE INTO frame_people SELECT f.frame_key,? FROM frames f JOIN json_each(?) j ON f.frame_key=j.value WHERE f.state='ready'");
      for(const person of people)insert.run(person.cluster_id,JSON.stringify((person.face_samples??[]).map(sample=>sample.frame_id)));
      this.db.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('face_links_migrated','1')");
    });
  }
  linkFramePeople(frame:string,people:string[]):void {
    check(this.db.prepare("SELECT 1 FROM frames WHERE frame_key=? AND state IN ('ready','indexing')").get(frame),'VISUAL_FRAME_NOT_FOUND',404);
    this.db.prepare('INSERT OR IGNORE INTO frame_people SELECT ?,value FROM json_each(?)').run(frame,JSON.stringify(people));
  }
  remapFramePeople(changes:[string,string|null][]):void {
    if(!changes.length)return;
    inTransaction(this.db,()=>{for(const [from,to] of changes){
      if(to!==null)this.db.prepare('INSERT OR IGNORE INTO frame_people SELECT frame_key,? FROM frame_people WHERE person_id=?').run(to,from);
      this.db.prepare('DELETE FROM frame_people WHERE person_id=?').run(from);
    }});
  }
  personIdsInFrames(frames?:string[]):string[] {
    const rows=frames===undefined?this.db.prepare('SELECT DISTINCT person_id FROM frame_people').all():
      this.db.prepare("SELECT DISTINCT p.person_id FROM frame_people p JOIN frames f USING(frame_key) WHERE f.state='ready' AND p.frame_key IN (SELECT value FROM json_each(?))").all(JSON.stringify(frames));
    return rows.map(row=>String(row.person_id));
  }
  framesForPeople(people:string[]):string[] {
    return this.db.prepare("SELECT DISTINCT p.frame_key FROM frame_people p JOIN frames f USING(frame_key) WHERE f.state='ready' AND p.person_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(people)).map(row=>String(row.frame_key));
  }
  hasPersonFrames(people:string[],excluding:string[]=[]):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM frame_people p JOIN frames f USING(frame_key) WHERE f.state IN ('ready','indexing') AND p.person_id IN (SELECT value FROM json_each(?)) AND p.frame_key NOT IN (SELECT value FROM json_each(?)) LIMIT 1")
      .get(JSON.stringify(people),JSON.stringify(excluding)));
  }
  deleteFrameLinks(frames:string[]):void {this.db.prepare('DELETE FROM frame_people WHERE frame_key IN (SELECT value FROM json_each(?))').run(JSON.stringify(frames));}
  private run<T>(work:()=>Promise<T>):Promise<T> {
    check(!this.closed,'VISUAL_CLOSED',503);
    const result=this.active.catch(()=>{}).then(work);this.active=result;
    return result;
  }
  async ingest(principal:string,device:string,frame:CameraFrame,place?:string,signal?:AbortSignal,archived?:ArchivedEvent) {
    check(!this.closed&&!this.closing,'VISUAL_CLOSED',503);
    check(frame.image.byteLength>0&&frame.image.byteLength<=VISUAL_INGEST_LIMITS.image_bytes,'VISUAL_IMAGE_TOO_LARGE',413);
    check(!this.indexing,'VISUAL_INGEST_BUSY',503);
    this.indexing=true;this.indexingBytes=frame.image.byteLength;
    const controller=new AbortController(),capture:{principal:string;at:number;controller:AbortController;pending?:Promise<unknown>;admission?:boolean}={principal,at:Date.parse(frame.captured_at),controller};
    signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;this.captures.add(capture);
    const pending=this.index(principal,device,frame,signal,place,archived).finally(()=>{this.captures.delete(capture);this.indexing=false;this.indexingBytes=0;});capture.pending=pending;return pending;
  }
  private async index(principal:string,device:string,frame:CameraFrame,signal:AbortSignal,place?:string,archived?:ArchivedEvent){
    let rowid:bigint|undefined,key:string|undefined;
    try {
      check(!this.closed,'VISUAL_CLOSED',503);signal.throwIfAborted();
      check(archived,'VISUAL_AUTHENTICATED_ARCHIVE_REQUIRED',403);
      check(archived.principal_id===principal&&archived.media_type==='visual','VISUAL_SOURCE_MISMATCH',403);
      await this.run(async()=>{signal.throwIfAborted();this.db.prepare('INSERT OR IGNORE INTO capture_refs(raw_ref,archive_revision,principal_id,captured_ms) VALUES(?,?,?,?)')
        .run(archived!.raw_ref,archived!.archive_revision,principal,Date.parse(frame.captured_at));
        check(this.db.prepare('SELECT 1 FROM capture_refs WHERE raw_ref=? AND owner_delete=0').get(archived!.raw_ref),'VISUAL_DELETED',409);});
      await this.rawArchive!.locate(archived.raw_ref,principal);
      const generation=this.people&&this.faces?await this.people.beginFaceFrame():null;
      const prepared=generation!==null?await this.faces!.prepare(frame.image,signal):await prepareVisualImage(frame.image,undefined,signal);
      const reservation=await this.run(async()=>{
      signal.throwIfAborted();const existing=this.db.prepare('SELECT state FROM frames WHERE principal_id=? AND device_id=? AND frame_id=?').get(principal,device,frame.frame_id);
      if(existing){check(existing.state==='ready','VISUAL_FRAME_PENDING',409);return {status:'duplicate',frame_id:frame.frame_id};}
      const at=Date.parse(frame.captured_at),{thumbnail,signature}=prepared;
      const previous=this.db.prepare("SELECT * FROM frames WHERE principal_id=? AND device_id=? AND state='ready' ORDER BY captured_ms DESC LIMIT 1").get(principal,device) as FrameRow|undefined;
      const change=previous?signature.reduce((sum,n,i)=>sum+Math.abs(n-previous.signature[i]!),0)/64:255;
      const maxChange=previous?Math.max(...signature.map((n,i)=>Math.abs(n-previous.signature[i]!))):255;
      if(frame.trigger!=='user_request'&&previous&&at>=previous.captured_ms&&at-previous.captured_ms<120000&&change<=4&&maxChange<=12)return {status:'near_duplicate',frame_id:frame.frame_id};
      const last=this.db.prepare("SELECT MAX(captured_ms) AS at FROM frames WHERE principal_id=? AND device_id=? AND keyframe=1 AND state='ready'").get(principal,device);
      const keyframe=frame.trigger!=='interval'||change>20||!last?.at||at-Number(last.at)>=120000;
      key=randomUUID();const original='',small=`frames/${key}-thumb.jpg`;
      const result=this.db.prepare("INSERT INTO frames(principal_id,device_id,frame_id,captured_ms,original,thumbnail,signature,place,keyframe,bytes,frame_key,raw_ref,archive_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'indexing')")
        .run(principal,device,frame.frame_id,at,original,small,signature,place??null,keyframe?1:0,0,key,archived!.raw_ref,archived!.archive_revision);
      rowid=BigInt(result.lastInsertRowid);
        await writeFile(join(this.directory,small),thumbnail,{mode:0o600,flag:'wx',flush:true});
        const directory=await open(join(this.directory,'frames'),'r');try{await directory.sync();}finally{await directory.close();}
      return {key,keyframe,at};});
      if('status' in reservation)return {...reservation,people:[]};
      signal.throwIfAborted();
      const space=this.embeddingSpaces?.snapshot();let values:number[];
      try{values=await (space?.provider??this.models).embedImage(prepared.thumbnail,signal);}finally{space?.release();}
      const embedding=space?this.embeddingSpaces!.vector(values,space.provider.embeddingSpace):new Float32Array(values);signal.throwIfAborted();
      const description=reservation.keyframe?await this.models.describe(frame.image,signal,{kind:'capture',raw_ref:archived.raw_ref,archive_revision:archived.archive_revision,principal_id:principal,device_id:device}):{caption:'',ocr:''};signal.throwIfAborted();
      return await this.run(async()=>{
        signal.throwIfAborted();
        check(this.db.prepare('SELECT 1 FROM capture_refs WHERE raw_ref=? AND owner_delete=0').get(archived!.raw_ref),'VISUAL_DELETED',409);
        const people=this.people&&generation!==null?await this.people.commitFaceFrame({frame_id:reservation.key,at:frame.captured_at},prepared.faces.map(face=>face.embedding),generation):[];
        signal.throwIfAborted();
        await this.rawArchive!.locate(archived!.raw_ref,principal);
        check(this.db.prepare('SELECT 1 FROM capture_refs WHERE raw_ref=? AND owner_delete=0').get(archived!.raw_ref),'VISUAL_DELETED',409);
        inTransaction(this.db,()=>{
          if(space)this.embeddingSpaces!.assertCurrent(space.generation);
          this.db.prepare(`INSERT INTO ${space?.generation??'vectors'}(rowid,embedding,principal_id,captured_ms) VALUES(?,?,?,?)`).run(rowid!,embedding,principal,BigInt(reservation.at));
          this.db.prepare("UPDATE frames SET state='ready',caption=?,ocr=? WHERE id=?").run(description.caption,description.ocr,rowid!);
        });
        return {status:'kept',frame_id:frame.frame_id,visual_frame_id:reservation.key,keyframe:reservation.keyframe,people};});
    }catch(error){if(signal.aborted&&signal.reason instanceof ContractError&&signal.reason.code==='VISUAL_DELETED'&&archived)await this.rawArchive!.delete(archived.raw_ref,principal);if(rowid!==undefined)await this.run(async()=>{this.db.prepare("UPDATE frames SET state='deleting' WHERE frame_key=?").run(key!);await this.finishDeletes();});signal.throwIfAborted();throw error;}
  }
  async recall(principal:string,args:{query?:unknown;from?:unknown;until?:unknown;limit?:unknown}) {
    check(!this.closed&&!this.closing,'VISUAL_CLOSED',503);const {from,until}=bounds(args),limit=args.limit??5;
    check(Number.isSafeInteger(limit)&&Number(limit)>=1&&Number(limit)<=50,'VISUAL_LIMIT_INVALID');
    check(args.query===undefined||typeof args.query==='string'&&args.query.trim().length>0&&args.query.length<=200,'VISUAL_QUERY_INVALID');
    const done=Promise.withResolvers<void>();this.queries.add(done.promise);let space:ReturnType<VisualEmbeddingSpaces['snapshot']>|undefined;
    try {
    const personFrames=args.query?await this.people?.frameIdsForPerson(args.query as string):undefined;space=this.embeddingSpaces?.snapshot();
    const values=args.query&&!personFrames?await (space?.provider??this.models).embedQuery(args.query as string):undefined;
    const embedding=values?(space?this.embeddingSpaces!.vector(values,space.provider.embeddingSpace):new Float32Array(values)):undefined;check(!this.closed,'VISUAL_CLOSED',503);
    const scores=new Map<number,number>(),add=(ids:number[])=>ids.forEach((id,index)=>scores.set(id,(scores.get(id)??0)+1/(60+index)));
    if(personFrames)add((this.db.prepare("SELECT id FROM frames WHERE principal_id=? AND captured_ms>=? AND captured_ms<? AND state='ready' AND frame_key IN (SELECT value FROM json_each(?)) ORDER BY captured_ms DESC LIMIT 100")
      .all(principal,from,until,JSON.stringify(personFrames)) as {id:number}[]).map(r=>r.id));
    else if(args.query){
      const text=args.query as string,terms=text.trim().split(/\s+/u),fts=terms.every(term=>Array.from(term).length>=3);
      const clause=fts?'f.id IN (SELECT rowid FROM frame_text WHERE frame_text MATCH ?)':terms.map(()=>"(f.caption||' '||f.ocr) LIKE ? ESCAPE '\\'").join(' AND ');
      const params=fts?[terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND ')]:terms.map(t=>'%'+t.replace(/[\\%_]/gu,'\\$&')+'%');
      add((this.db.prepare(`SELECT f.id FROM frames f WHERE f.principal_id=? AND f.captured_ms>=? AND f.captured_ms<? AND f.state='ready' AND ${clause} ORDER BY f.captured_ms DESC LIMIT 100`)
        .all(principal,from,until,...params) as {id:number}[]).map(r=>r.id));
      add((this.db.prepare(`SELECT rowid FROM ${space?.generation??'vectors'} WHERE embedding MATCH ? AND k=100 AND principal_id=? AND captured_ms>=? AND captured_ms<? ORDER BY distance`)
        .all(embedding!,principal,BigInt(from),BigInt(until)) as {rowid:number}[]).map(r=>r.rowid));
    }else add((this.db.prepare("SELECT id FROM frames WHERE principal_id=? AND captured_ms>=? AND captured_ms<? AND state='ready' ORDER BY captured_ms DESC LIMIT 100")
      .all(principal,from,until) as {id:number}[]).map(r=>r.id));
    const entries=[],rows=[...scores].sort((a,b)=>b[1]-a[1]).slice(0,Number(limit)).map(([id])=>this.db.prepare("SELECT * FROM frames WHERE id=? AND principal_id=? AND state='ready'").get(id,principal) as FrameRow|undefined);
    for(const row of rows)if(row){
      const people=(await this.people?.peopleInFrames([row.frame_key])??[]).map(p=>({speaker_ref:`speaker:${p.cluster_id}`,name:p.label}));
      if(row.raw_ref&&this.rawArchive)try{await this.rawArchive.locate(row.raw_ref,principal);}
      catch(error){if(error instanceof ContractError&&error.code==='RAW_DELETED')continue;throw error;}
      check(!this.closed,'VISUAL_CLOSED',503);
      if(this.db.prepare("SELECT 1 FROM frames WHERE frame_key=? AND state='ready'").get(row.frame_key))entries.push({frame_id:row.frame_key,...(row.raw_ref?{raw_ref:row.raw_ref,archive_revision:row.archive_revision}:{}),at:new Date(row.captured_ms).toISOString(),caption:row.caption,ocr:row.ocr,place:row.place,people});
    }
    return {frames:entries,truncated:scores.size>Number(limit)};
    }finally{try{space?.release();}finally{this.queries.delete(done.promise);done.resolve();}}
  }
  get faceRecognitionAvailable(){return Boolean(this.people&&this.faces);}
  async imageBytes(principal:string,frame_id:string,full=false):Promise<Buffer> {
      check(!this.closed,'VISUAL_CLOSED',503);const row=this.db.prepare("SELECT * FROM frames WHERE principal_id=? AND frame_key=? AND state='ready'").get(principal,frame_id) as FrameRow|undefined;
      check(row,'VISUAL_FRAME_NOT_FOUND',404);
      check(this.rawArchive,'VISUAL_RAW_ARCHIVE_REQUIRED',503);check(row.raw_ref,'VISUAL_LEGACY_IMPORT_REQUIRED',503);
      await this.rawArchive.locate(row.raw_ref,principal);
      const original=()=>this.rawArchive!.read(row.raw_ref!,principal,row.archive_revision!).then(bytes=>Buffer.from(bytes));
      let bytes:Buffer;
      if(full)bytes=await original();
      else try{bytes=await readFile(join(this.directory,row.thumbnail));}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        bytes=(await prepareVisualImage(await original())).thumbnail;
        await this.run(async()=>{check(this.db.prepare("SELECT 1 FROM frames WHERE frame_key=? AND state='ready'").get(row.frame_key),'VISUAL_FRAME_NOT_FOUND',404);
          await writeFile(join(this.directory,row.thumbnail),bytes,{mode:0o600,flush:true});});}
      await this.rawArchive.locate(row.raw_ref,principal);
      check(!this.closed,'VISUAL_CLOSED',503);check(this.db.prepare("SELECT 1 FROM frames WHERE frame_key=? AND state='ready'").get(row.frame_key),'VISUAL_FRAME_NOT_FOUND',404);return bytes;
  }
  private async deleting<T>(work:()=>Promise<T>):Promise<T> {
    check(!this.closed&&!this.closing,'VISUAL_CLOSED',503);
    const pending=work();this.deletions.add(pending);
    try{return await pending;}finally{this.deletions.delete(pending);}
  }
  /** Compatibility maintenance entry. Explicit import owns legacy provenance and retirement. */
  stageCold():Promise<{uploaded:number}> {return this.deleting(async()=>{
    await this.finishRawDeletes();await this.run(()=>this.finishDeletes());if(this.cold)await this.deleteCold();return {uploaded:0};
  });}
  private async deleteCold(){
    for(const row of this.db.prepare('SELECT reference FROM cold_deletes').all()){
      await this.cold!.delete(String(row.reference));
      await this.run(async()=>{this.db.prepare('DELETE FROM cold_deletes WHERE reference=?').run(row.reference!);});
    }
  }
  deleteRange(principal:string,args:{from?:unknown;until?:unknown}) {return this.deleting(async()=>{
    check(args.from!==undefined&&args.until!==undefined,'VISUAL_DELETE_RANGE_REQUIRED');const {from,until}=bounds(args);
    const captures=[...this.captures].filter(capture=>capture.principal===principal&&capture.at>=from&&capture.at<until);
    for(const capture of captures)capture.controller.abort(new ContractError('VISUAL_DELETED',409));
    await Promise.allSettled(captures.filter(capture=>capture.admission).map(capture=>capture.pending!));
    const {originals,count}=await this.run(async()=>inTransaction(this.db,()=>({
        originals:this.db.prepare('UPDATE capture_refs SET owner_delete=1 WHERE owner_delete=0 AND principal_id=? AND captured_ms>=? AND captured_ms<?').run(principal,from,until).changes,
        count:this.db.prepare("UPDATE frames SET state='deleting',owner_delete=1 WHERE principal_id=? AND captured_ms>=? AND captured_ms<?").run(principal,from,until).changes})));
    await this.finishRawDeletes();
    return this.run(async()=>{
      await this.finishDeletes();this.db.exec("INSERT INTO frame_text(frame_text) VALUES('optimize');PRAGMA wal_checkpoint(TRUNCATE)");
      const pending=Number(this.db.prepare("SELECT COUNT(*) AS n FROM frames WHERE state='deleting' AND principal_id=? AND captured_ms>=? AND captured_ms<?").get(principal,from,until)!.n);
      const rawPending=Number(this.db.prepare('SELECT COUNT(*) AS n FROM capture_refs WHERE owner_delete=1 AND principal_id=? AND captured_ms>=? AND captured_ms<?').get(principal,from,until)!.n);
      return {status:pending||rawPending?'pending':'deleted',raw_cleanup_pending:rawPending,frames:Number(count),originals:Number(originals),local_cleanup_pending:pending,remote_cleanup_pending:Number(this.db.prepare('SELECT COUNT(*) AS n FROM cold_deletes').get()!.n)};});
  });}
  /** RawArchive already owns revocation. Never call it again from its removal callback. */
  async forgetRawRefs(principal:string,refs:readonly string[]):Promise<void> {
    check(!this.closed,'VISUAL_CLOSED',503);
    const selected=JSON.stringify(refs);
    inTransaction(this.db,()=>{
      this.db.prepare('UPDATE capture_refs SET owner_delete=2 WHERE principal_id=? AND raw_ref IN (SELECT value FROM json_each(?))').run(principal,selected);
      this.db.prepare("UPDATE frames SET state='deleting',owner_delete=1 WHERE principal_id=? AND raw_ref IN (SELECT value FROM json_each(?))").run(principal,selected);
    });
    await this.run(()=>this.finishDeletes());
  }
  private async finishRawDeletes() {
    if(this.rawArchive){
      const owners=new Map<string,string[]>();
      for(const ref of this.db.prepare('SELECT raw_ref,principal_id FROM capture_refs WHERE owner_delete=1').all()){
        const principal=String(ref.principal_id),refs=owners.get(principal)??[];refs.push(String(ref.raw_ref));owners.set(principal,refs);
      }
      for(const [principal,refs] of owners){await this.rawArchive.deleteMany(refs,principal);
        // Keep the revocation after cleanup: archive admission may have finished before indexing starts.
        this.db.prepare('UPDATE capture_refs SET owner_delete=2 WHERE raw_ref IN (SELECT value FROM json_each(?))').run(JSON.stringify(refs));}
    }
  }
  private async finishDeletes() {
    const rows=this.db.prepare("SELECT * FROM frames WHERE state='deleting' AND (owner_delete=1 OR (original='' AND cold_ref IS NULL))").all() as FrameRow[];
    const available=rows.filter(row=>!row.owner_delete||!row.raw_ref||this.rawArchive);
    if(!available.length)return;
    await this.people?.deleteFrameEvidence(available.map(r=>r.frame_key));
    for(const row of available)for(const path of [row.owner_delete?row.original:'',row.thumbnail].filter(Boolean))await unlink(join(this.directory,path)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const directory=await open(join(this.directory,'frames'),'r');try{await directory.sync();}finally{await directory.close();}
    inTransaction(this.db,()=>{for(const row of available){if(row.cold_ref)this.db.prepare('INSERT OR IGNORE INTO cold_deletes(reference) VALUES(?)').run(row.cold_ref);
      if(this.embeddingSpaces)this.embeddingSpaces.deleteRow(row.id);else this.db.prepare('DELETE FROM vectors WHERE rowid=?').run(BigInt(row.id));
      this.db.prepare('DELETE FROM frames WHERE id=?').run(row.id);}});
  }
  close(){return this.closing??=(async()=>{for(const capture of this.captures)capture.controller.abort(new ContractError('VISUAL_CLOSED',503));
    await Promise.allSettled([...this.captures].map(c=>c.pending!));await Promise.allSettled([...this.deletions]);await Promise.all([...this.queries]);this.closed=true;
    try{await this.active.catch(()=>{});await this.embeddingSpaces?.close();}finally{this.people?.setVisualMemory(undefined);if(this.db.isOpen)this.db.close();}})();}
}
