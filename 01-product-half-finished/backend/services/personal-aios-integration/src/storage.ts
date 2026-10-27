import { constants, promises as fs, type StatsFs } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import { check, sha256 } from './contracts.ts';
import {ColdStorage,type ColdRecord,type ColdConfig} from './cold-storage.ts';
import {SessionRecords,type FinalSession,type SessionRecordRef,type CallAudioTrack} from './session-records.ts';

export interface StoragePort {
  publishObjectStream?(chunks:AsyncIterable<Uint8Array>,beforePublish?:(key:string)=>Promise<void>):Promise<{object_hash:string;bytes:number}>;
  readObjectRange?(key:string,offset:number,bytes:number):AsyncIterable<Uint8Array>;
  removeSessions?(rawRefs:string[]):Promise<void>;
  bindCallTrack?(rawRef:string,group:CallAudioTrack):Promise<void>;
  callTrack?(rawRef:string):Promise<CallAudioTrack|null>;
  callTracks?(callId:string,principalId:string):Promise<{raw_ref:string;track:CallAudioTrack['track'];finalized:boolean}[]>;
  publishFinal?(record:FinalSession):Promise<FinalSession>;
  readFinal?(rawRef:string):Promise<FinalSession|null>;
  trackSessionRecords?(rawRef:string,records:SessionRecordRef[]):Promise<void>;
  sessionRecords?(rawRef:string,publicationOrder?:boolean):Promise<SessionRecordRef[]>;
  sessionRecordCount?(rawRef:string):Promise<number>;
  activeSessionRefs?():Promise<string[]>;
  hasLiveSessionOwner?(record:SessionRecordRef):Promise<boolean>;
  hasSessionRecord?(record:SessionRecordRef):Promise<boolean>;
  pendingFinals?():Promise<string[]>;
  resumeFinalCleanup?(rawRef:string):Promise<void>;
  completeFinal?(rawRef:string):Promise<void>;
  prepareCapture?():Promise<void>;
  setAlert?(listener:(error:unknown)=>void):void;
  setReservePolicy?(work:(bytes:number)=>Promise<void>):void;
  publishIngressMeta?(namespace:string,key:string,bytes:Uint8Array):Promise<Uint8Array>;
  publishIngress?(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array,beforeWrite?:()=>Promise<void>):Promise<void>;
  publishIngressBatch?(records:{key:string;metadata:Uint8Array;hash:string;payload:Uint8Array;beforeWrite:()=>Promise<void>}[]):Promise<void>;
  removeIngress?(key:string):Promise<void>;
  withOriginalWrite?<T>(work:()=>Promise<T>):Promise<T>;
  publishRestored?(namespace:string,key:string,bytes:Uint8Array):Promise<Uint8Array>;
  publish(namespace: string, key: string, bytes: Uint8Array): Promise<Uint8Array>;
  publishAliased?(namespace:string,key:string,alias:string,bytes:Uint8Array):Promise<Uint8Array>;
  publishMany?(namespace:string,records:{key:string;bytes:Uint8Array}[]):Promise<void>;
  stageAlias?(namespace:string,key:string,alias:string):Promise<{winner:Uint8Array}>;
  flushNamespace?(namespace:string):Promise<void>;
  /** Atomic owner-only replacement for mutable registry documents and deletion intents, never original L5 data. */
  replace?(namespace:string,key:string,bytes:Uint8Array):Promise<void>;
  read(namespace: string, key: string): Promise<Uint8Array>;
  list(namespace: string, max_keys?: number): Promise<string[]>;
  removePending(key: string): Promise<void>;
  listHot?(namespace:string):Promise<string[]>;
  hotKeys?(namespace:string,max_keys?:number):AsyncIterable<string>;
  modifiedAt?(namespace:string,key:string):Promise<number>;
  objectSize?(namespace:string,key:string):Promise<number>;
  /** Compare verified metadata with the current original without a cold HTTP read. */
  matchesMetadata?(namespace:string,key:string,bytes:Uint8Array):Promise<boolean>;
  hotSize?(namespace:string,key:string):Promise<number>;
  moveCold?(records:ColdRecord[],beforeUpload?:(bytes:number)=>void,uploadChunk?:(bytes:number)=>Promise<void>):Promise<{pack:string;bytes:number}>;
  removeOriginals?(records:Pick<ColdRecord,'namespace'|'key'>[]):Promise<void>;
}
// POSIX boundary only: no event classification, run ownership, retention or memory decisions.
export class PosixStorage implements StoragePort {
  readonly root: string;
  readonly cold:ColdStorage|undefined;
  private readonly sessions:SessionRecords;
  private readonly minFree:number;
  private readonly minFreeInodes:number;
  private alert:(error:unknown)=>void;
  private reservePolicy:((bytes:number)=>Promise<void>)|undefined;
  private reserveWork:Promise<void>|undefined;
  private readonly originalContext=new AsyncLocalStorage<boolean>();
  private ingressReserve:Promise<void>|undefined;
  private reserveClaims:Promise<unknown>=Promise.resolve();
  private readonly reserveWarnings=new Map<string,number>();
  get reserveBytes(){return this.minFree;}
  setAlert(listener:(error:unknown)=>void){this.alert=listener;}
  setReservePolicy(work:(bytes:number)=>Promise<void>){this.reservePolicy=work;}
  private originalWork:Promise<unknown>=Promise.resolve();
  withOriginalWrite<T>(work:()=>Promise<T>):Promise<T>{const result=this.originalWork.then(()=>this.originalContext.run(true,work));this.originalWork=result.catch(()=>undefined);return result;}
  private canonicalRoot: string | undefined;
  private readonly readOnly:boolean;
  constructor(root: string,options:{read_only?:boolean;cold?:ColdConfig;min_free_bytes?:number;min_free_inodes?:number;onAlert?:(error:unknown)=>void}={}) {
    this.readOnly=options.read_only??false;
    this.root = resolve(root);this.minFree=options.min_free_bytes??64*1024*1024;
    this.minFreeInodes=options.min_free_inodes??10000;
    check(Number.isSafeInteger(this.minFree)&&this.minFree>0,'INVALID_DISK_RESERVE');
    check(Number.isSafeInteger(this.minFreeInodes)&&this.minFreeInodes>0,'INVALID_INODE_RESERVE');
    this.alert=options.onAlert??(error=>console.error('L5_STORAGE_ALERT',error instanceof Error?error.message:String(error)));
    this.cold=options.cold?new ColdStorage(this.root,options.cold,300000,this.readOnly):undefined;
    this.sessions=new SessionRecords(this.root,async create=>{
      if(create){await this.directory('session-finals');return;}
      // The session index lives in the root itself; a read creates nothing and needs only a real root directory.
      const stat=await fs.lstat(this.root);check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_ROOT');
    },this.readOnly);
  }
  removeSessions(rawRefs:string[]){return this.sessions.remove(rawRefs);}
  bindCallTrack(rawRef:string,group:CallAudioTrack){return this.sessions.bindCallTrack(rawRef,group);}
  callTrack(rawRef:string){return this.sessions.callTrack(rawRef);}
  callTracks(callId:string,principalId:string){return this.sessions.callTracks(callId,principalId);}
  publishFinal(record:FinalSession){return this.sessions.publishFinal(record);}
  readFinal(rawRef:string){return this.sessions.readFinal(rawRef);}
  trackSessionRecords(rawRef:string,records:SessionRecordRef[]){return this.sessions.trackSessionRecords(rawRef,records);}
  sessionRecords(rawRef:string,publicationOrder=false){return this.sessions.sessionRecords(rawRef,publicationOrder);}
  sessionRecordCount(rawRef:string){return this.sessions.sessionRecordCount(rawRef);}
  activeSessionRefs(){return this.sessions.activeSessionRefs();}
  hasLiveSessionOwner(record:SessionRecordRef){return this.sessions.hasLiveSessionOwner(record);}
  hasSessionRecord(record:SessionRecordRef){return this.sessions.hasSessionRecord(record);}
  pendingFinals(){return this.sessions.pendingFinals();}
  resumeFinalCleanup(rawRef:string){return this.sessions.resumeFinalCleanup(rawRef);}
  completeFinal(rawRef:string){return this.sessions.completeFinal(rawRef);}
  private reportReserve(error:unknown){
    const reason=error instanceof Error?error.message:String(error),window=Math.floor(Date.now()/(60*60*1000));
    if(this.reserveWarnings.get(reason)===window)return;
    this.reserveWarnings.set(reason,window);this.alert(error);
  }
  private reserveReasons(bytes:number,stat:StatsFs){
    const reasons:string[]=[];
    if(stat.bavail*stat.bsize<this.minFree+bytes)reasons.push('L5_DISK_RESERVE_EMERGENCY');
    if(stat.ffree<this.minFreeInodes)reasons.push('L5_INODE_RESERVE_EMERGENCY');
    return reasons;
  }
  async reserveFits(bytes:number){return this.reserveReasons(bytes,await fs.statfs(this.root)).length===0;}
  private async reportPressure(bytes:number,error?:unknown){
    const reasons=this.reserveReasons(bytes,await fs.statfs(this.root));
    for(const reason of reasons)this.reportReserve(new Error(reason));
    // A real allocation failure can precede the next filesystem free-space update.
    if(!reasons.length&&error)this.reportReserve(new Error('L5_DISK_RESERVE_EMERGENCY',{cause:error}));
  }
  private reclaim(bytes:number){
    if(!this.reserveWork&&this.reservePolicy){
      const work=this.originalContext.exit(()=>this.reservePolicy!(bytes));
      this.reserveWork=work.catch(error=>{this.reportReserve(error);}).finally(()=>{this.reserveWork=undefined;});
    }
    // Remote verification must never be awaited by an original publication holding the fence.
    return this.originalContext.getStore()?Promise.resolve():this.reserveWork??Promise.resolve();
  }
  async monitorReserve(){
    if(await this.reserveFits(0))return true;
    await this.reportPressure(0);await this.reclaim(0);return this.reserveFits(0);
  }
  async reserve(bytes:number){
    if(await this.reserveFits(bytes))return;
    await this.reportPressure(bytes);
    await this.reclaim(bytes);
    if(await this.reserveFits(bytes))return;
    const reasons=this.reserveReasons(bytes,await fs.statfs(this.root));
    const reason=reasons[0]==='L5_INODE_RESERVE_EMERGENCY'?'L5_INODE_RESERVE_EXHAUSTED':'L5_DISK_RESERVE_EXHAUSTED';
    throw Object.assign(new Error(`${reason}: raw input is not durable`),{code:'ENOSPC'});
  }
  async moveCold(records:ColdRecord[],beforeUpload?:(bytes:number)=>void,uploadChunk?:(bytes:number)=>Promise<void>){check(this.cold,'COLD_STORAGE_NOT_CONFIGURED',503);
    // Pack payloads stay in memory and HTTP; SQLite reports its actual local allocation failure.
    return this.cold.move(records,beforeUpload,uploadChunk);}
  /** Startup only: the caller holds the product process lock before opening any storage owners. */
  async recoverPending():Promise<void>{
    await this.directory('objects');
    const temporary=/^\.pending-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
    for await(const entry of await fs.opendir(this.root)){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      if(entry.name==='.snapshots'){
        const parent=join(this.root,entry.name);let changed=false;
        for await(const snapshot of await fs.opendir(parent)){
          if(!/^\.pending-[a-f0-9]{64}$/u.test(snapshot.name)||!snapshot.isDirectory()||snapshot.isSymbolicLink())continue;
          // rm unlinks entries without following symlinks. Published snapshots and their dependency pins stay intact.
          await fs.rm(join(parent,snapshot.name),{recursive:true});changed=true;
        }
        if(changed)await this.syncDirectory(parent);
      }else if(/^[a-z][a-z0-9-]{0,40}$/u.test(entry.name)){
        const directory=await this.directory(entry.name,false);let changed=false;
        for await(const object of await fs.opendir(directory)){
          if(!temporary.test(object.name)||!object.isFile()||object.isSymbolicLink())continue;
          // A published object or snapshot may share this inode; unlink only the unpublished name.
          await fs.unlink(join(directory,object.name));changed=true;
        }
        if(changed)await this.syncDirectory(directory);
      }
    }
  }
  async close(){await this.reserveWork;await this.cold?.close();await this.sessions.close();}
  async removeOriginals(records:Pick<ColdRecord,'namespace'|'key'>[]){
    const changed=new Set<string>();
    try{
    for(const record of records){const directory=await this.directory(record.namespace),path=this.filename(directory,record.key);
      try{const stat=await fs.lstat(path);check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');await fs.unlink(path);changed.add(directory);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    }finally{for(const directory of changed)await this.syncDirectory(directory);}
  }
  async objectSize(namespace:string,key:string):Promise<number>{
    try{return await this.hotSize(namespace,key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const folded=await this.sessions.read(namespace,key);
    if(folded)return folded instanceof Uint8Array?folded.length:folded.bytes;
    const location=(await this.cold?.locations([{namespace,key}]))?.[0];
    if(location)return location.size;
    throw Object.assign(new Error('storage object absent'),{code:'ENOENT'});
  }
  async matchesMetadata(namespace:string,key:string,bytes:Uint8Array):Promise<boolean>{
    check(namespace!=='objects','METADATA_RECORD_REQUIRED');
    try{return Buffer.from(await this.readHot(namespace,key)).equals(bytes);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const folded=await this.sessions.read(namespace,key);
    if(folded){check(folded instanceof Uint8Array,'METADATA_RECORD_REQUIRED');return Buffer.from(folded).equals(bytes);}
    const location=(await this.cold?.locations([{namespace,key}]))?.[0];
    return !!location&&location.size===bytes.length&&location.hash===sha256(bytes);
  }
  async hotSize(namespace:string,key:string){if(namespace==='session-finals'){const detail=await this.sessions.details(key);if(detail)return detail.size;}
    const stat=await fs.lstat(this.filename(await this.directory(namespace,false),key));
    check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');return stat.size;}
  async modifiedAt(namespace:string,key:string){if(namespace==='session-finals'){const detail=await this.sessions.details(key);if(detail)return detail.modified;}
    return (await fs.lstat(this.filename(await this.directory(namespace,false),key))).mtimeMs;}
  private async directory(namespace: string, create = true): Promise<string> {
    check(!create||!this.readOnly,'STORAGE_READ_ONLY');
    check(/^[a-z][a-z0-9-]{0,40}$/u.test(namespace), 'INVALID_STORAGE_NAMESPACE');
    if (create) await fs.mkdir(this.root, {recursive: true, mode: 0o700});
    const rootStat = await fs.lstat(this.root);
    check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'UNSAFE_STORAGE_ROOT');
    // macOS resolves /var and /tmp through OS-owned aliases. Pin the actual root;
    // continue rejecting links at the configured root and inside its namespaces.
    const canonicalRoot = await fs.realpath(this.root);
    check(this.canonicalRoot === undefined || this.canonicalRoot === canonicalRoot, 'STORAGE_ROOT_CHANGED');
    this.canonicalRoot = canonicalRoot;
    const path = join(canonicalRoot, namespace);
    if (create) await fs.mkdir(path, {recursive: true, mode: 0o700});
    const stat = await fs.lstat(path);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_STORAGE_NAMESPACE');
    return path;
  }
  private filename(directory: string, key: string): string {
    check(/^[a-f0-9]{64}$/u.test(key), 'INVALID_STORAGE_KEY');
    return join(directory, key);
  }
  protected async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async read(namespace:string,key:string):Promise<Uint8Array>{
    try{return await this.readHot(namespace,key);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      const folded=await this.readFolded(namespace,key);if(folded)return folded;
      if(!this.cold)throw error;return this.cold.read(namespace,key);}
  }
  private async readFolded(namespace:string,key:string):Promise<Uint8Array|null>{
    const folded=await this.sessions.read(namespace,key);if(!folded||folded instanceof Uint8Array)return folded;
    const bytes=Buffer.allocUnsafe(folded.bytes);let offset=0;
      for await(const block of this.readObjectRange(folded.object_hash,folded.offset,folded.bytes)){
        check(offset+block.length<=bytes.length,'FINAL_OBJECT_INTEGRITY',500);bytes.set(block,offset);offset+=block.length;
      }
      check(offset===bytes.length,'FINAL_OBJECT_INTEGRITY',500);
    check(sha256(bytes)===key,'FINAL_OBJECT_INTEGRITY',500);return bytes;
  }
  /** Stream one immutable object to disk; only its digest and length survive publication. */
  async publishObjectStream(chunks:AsyncIterable<Uint8Array>,beforePublish?:(key:string)=>Promise<void>):Promise<{object_hash:string;bytes:number}>{
    const directory=await this.directory('objects'),temporary=join(directory,`.pending-${randomUUID()}`);
    const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    const hash=createHash('sha256');let bytes=0;
    try{
      const command=process.platform==='linux'?'ionice':'nice',priority=process.platform==='linux'?['-c','3','nice','-n','15']:['-n','15'];
      const child=spawn(command,[...priority,'cat'],{stdio:['pipe',handle.fd,'pipe']});let errors='';
      child.stderr.on('data',block=>{errors+=String(block).slice(0,4096-errors.length);});
      const completed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{
        if(code===0)resolve();else reject(new Error(`SESSION_AUDIO_WRITE_FAILED: ${code}: ${errors}`));});});
      const storage=this;
      async function* blocks(){for await(const chunk of chunks){await storage.reserve(chunk.length);hash.update(chunk);bytes+=chunk.length;yield chunk;}}
      try{await Promise.all([pipeline(Readable.from(blocks()),child.stdin),completed]);
        await handle.sync();}finally{await handle.close();}
      const object_hash=hash.digest('hex'),target=this.filename(directory,object_hash);
      return await this.withOriginalWrite(async()=>{
        await beforePublish?.(object_hash);
        try{await fs.link(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        await this.refreshOriginal(target);await this.syncDirectory(directory);return {object_hash,bytes};
      });
    }finally{await fs.unlink(temporary);}
  }
  /** Hot ranges stream; cold objects materialize through the existing bounded, verified cold reader. */
  async *readObjectRange(key:string,offset:number,bytes:number):AsyncGenerator<Uint8Array>{
    check(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(bytes)&&bytes>=0,'INVALID_OBJECT_RANGE');
    let handle:Awaited<ReturnType<typeof fs.open>>;
    try{handle=await fs.open(this.filename(await this.directory('objects',false),key),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      const folded=await this.sessions.read('objects',key);
      if(folded&&!(folded instanceof Uint8Array)){
        check(offset+bytes<=folded.bytes,'FINAL_OBJECT_INTEGRITY',500);
        yield* this.readObjectRange(folded.object_hash,folded.offset+offset,bytes);return;
      }
      if(!this.cold)throw error;
      const whole=await this.cold.read('objects',key);if(!whole)throw error;
      check(offset+bytes<=whole.length,'FINAL_OBJECT_INTEGRITY',500);
      for(let p=offset;p<offset+bytes;p+=65536)yield whole.subarray(p,Math.min(p+65536,offset+bytes));return;}
    try{const stat=await handle.stat();check(stat.isFile()&&offset+bytes<=stat.size,'FINAL_OBJECT_INTEGRITY',500);
      let position=offset;while(position<offset+bytes){const buffer=Buffer.allocUnsafe(Math.min(65536,offset+bytes-position));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,position);check(bytesRead>0,'FINAL_OBJECT_INTEGRITY',500);
        position+=bytesRead;yield buffer.subarray(0,bytesRead);}
    }finally{await handle.close();}
  }
  async readHot(namespace:string,key:string):Promise<Uint8Array>{
    const path=this.filename(await this.directory(namespace, false),key);
    const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await handle.stat();check(stat.isFile(),'UNSAFE_STORAGE_OBJECT');return await handle.readFile();}
    finally{await handle.close();}
  }
  /** Bounded parallel reads reuse one namespace validation; absent names may have joined a session fold. */
  async readHotMany(records:{namespace:string;key:string}[]):Promise<(Uint8Array|null)[]>{
    const directories=new Map<string,string>();
    for(const {namespace} of records)if(!directories.has(namespace))directories.set(namespace,await this.directory(namespace,false));
    return Promise.all(records.map(async record=>{
      let handle:Awaited<ReturnType<typeof fs.open>>;
      try{handle=await fs.open(this.filename(directories.get(record.namespace)!,record.key),constants.O_RDONLY|constants.O_NOFOLLOW);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
      try{const stat=await handle.stat();check(stat.isFile()&&stat.size<=64*1024*1024,'COLD_SEGMENT_LIMIT');return await handle.readFile();}
      finally{await handle.close();}
    }));
  }
  /** Physical files only: session SQLite payloads are accounted by their own authority. */
  async *hotEntries(namespace:string):AsyncGenerator<{key:string;size:number;modified:number}>{
    let directory:string;
    try{directory=await this.directory(namespace,false);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    for await(const entry of await fs.opendir(directory,{bufferSize:256})){
      if(entry.name.startsWith('.pending-'))continue;
      check(/^[a-f0-9]{64}$/u.test(entry.name)&&entry.isFile()&&!entry.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');
      try{const stat=await fs.lstat(this.filename(directory,entry.name));check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');
        yield {key:entry.name,size:stat.size,modified:stat.mtimeMs};
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
  async *hotKeys(namespace: string, max_keys?: number): AsyncGenerator<string> {
    check(max_keys===undefined || Number.isSafeInteger(max_keys) && max_keys>0,'INVALID_STORAGE_READ_BUDGET');
    let directory:string;
    try{directory=await this.directory(namespace,false);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    const entries = await fs.opendir(directory,{bufferSize:Math.min(max_keys??32,32)});
    let visited=0;const seen=namespace==='session-finals'?new Set<string>():undefined;
    // Async directory iteration closes its FD on completion and on thrown budget errors.
    for await (const entry of entries) {
      check(max_keys===undefined || ++visited<=max_keys,'STORAGE_READ_BUDGET_EXCEEDED',413);
      if (entry.name.startsWith('.pending-')) continue;
      check(/^[a-f0-9]{64}$/u.test(entry.name) && entry.isFile() && !entry.isSymbolicLink(),
        'UNSAFE_STORAGE_OBJECT');
      seen?.add(entry.name);yield entry.name;
    }
    if(namespace==='session-finals')for await(const key of this.sessions.finalKeys())if(!seen!.has(key)){
      check(max_keys===undefined||++visited<=max_keys,'STORAGE_READ_BUDGET_EXCEEDED',413);yield key;}
  }
  async listHot(namespace: string, max_keys?: number): Promise<string[]> {
    const keys:string[]=[];for await(const key of this.hotKeys(namespace,max_keys))keys.push(key);
    return keys.sort();
  }
  async list(namespace:string,max_keys?:number):Promise<string[]>{
    const keys=[...new Set([...await this.listHot(namespace,max_keys),...await this.sessions.keys(namespace,max_keys),...await this.cold?.keys(namespace)??[]])].sort();
    check(max_keys===undefined||keys.length<=max_keys,'STORAGE_READ_BUDGET_EXCEEDED',413);return keys;
  }
  async removePending(key: string): Promise<void> {
    // Temporary admission recovery payloads only. Original L5 objects/manifests are never deleted here.
    const directory = await this.directory('admission-inputs');
    const path = this.filename(directory, key);
    try {
      const stat = await fs.lstat(path);
      check(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_STORAGE_OBJECT');
      await fs.unlink(path); await this.syncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async publishRestored(namespace:string,key:string,bytes:Uint8Array){return this.publishLocal(namespace,key,bytes,false,true,true);}
  async publish(namespace:string,key:string,bytes:Uint8Array){return this.publishLocal(namespace,key,bytes);}
  private async refreshOriginal(target:string){
    const winner=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await winner.stat();check(stat.isFile()&&stat.nlink>=1,'UNSAFE_STORAGE_OBJECT');
      await winner.utimes(new Date(),new Date());await winner.sync();}finally{await winner.close();}
  }
  private async publishLocal(namespace: string, key: string, bytes: Uint8Array, ingress=false, notify=true, restore=false, syncDirectory=true): Promise<Uint8Array> {
    const directory = await this.directory(namespace);
    const target = this.filename(directory, key);
    let existing: Awaited<ReturnType<typeof fs.open>> | undefined;
    try { existing = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      let unlinked=false;
      try {
        const stat = await existing.stat();
        unlinked=stat.nlink===0;
        check(stat.isFile() && (unlinked || stat.nlink >= 1), 'UNSAFE_STORAGE_OBJECT');
        if(!unlinked){
          if(namespace==='objects')await existing.utimes(new Date(),new Date());
          await existing.sync();
        }
      } finally { await existing.close(); }
      if(!unlinked){
        if(syncDirectory)await this.syncDirectory(directory);
        // Preserve the named winner read: a deleted target must not return old FD bytes.
        return await this.read(namespace,key);
      }
      // Session folding can retire this hot name after open. Resolve the normal absent path once.
    }
    if(!restore&&namespace!=='objects'){const folded=await this.readFolded(namespace,key);if(folded)return folded;}
    if(!restore&&namespace!=='objects'&&await this.cold?.contains(namespace,key))return this.cold!.read(namespace,key);
    const temporary = join(directory, `.pending-${randomUUID()}`);
    if(ingress)await this.claimIngressReserve(bytes.length,notify,namespace==='owner-deletions');else await this.reserve(bytes.length);
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      // The winner is immutable. Return it so the domain can compare request fingerprints.
      if(namespace==='objects')await this.refreshOriginal(target);
      if(syncDirectory)await this.syncDirectory(directory);
      return await this.read(namespace,key);
    } finally { await fs.unlink(temporary); }
  }
  /** One immutable record and its first-winner slot share one directory durability fence. */
  async publishAliased(namespace:string,key:string,alias:string,bytes:Uint8Array):Promise<Uint8Array>{
    check(key!==alias&&sha256(bytes)===key,'INVALID_STORAGE_ALIAS');
    const directory=await this.directory(namespace),target=this.filename(directory,key),slot=this.filename(directory,alias);
    const foldedAlias=await this.readFolded(namespace,alias);if(foldedAlias)return foldedAlias;
    const foldedKey=await this.readFolded(namespace,key);if(foldedKey)return this.publish(namespace,alias,foldedKey);
    if(await this.cold?.contains(namespace,alias))return this.read(namespace,alias);
    await this.reserve(bytes.length);
    const temporary=join(directory,`.pending-${randomUUID()}`);
    const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      try{await fs.link(temporary,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      check(sha256(await this.read(namespace,key))===key,'STORAGE_ALIAS_INTEGRITY',500);
      try{await fs.link(target,slot);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      // Both names are in this directory. fsync covers commit and slot before any B is returned.
      await this.syncDirectory(directory);return await this.read(namespace,alias);
    }finally{await fs.unlink(temporary);}
  }
  /** All record files are individually synced. One directory fence commits their names. */
  async publishMany(namespace:string,records:{key:string;bytes:Uint8Array}[]):Promise<void>{
    check(records.length>0&&records.length<=64,'STORAGE_BATCH_BUDGET');
    const directory=await this.directory(namespace);
    for(let offset=0;offset<records.length;offset+=8){
      const existing=new Set<string>();
      const folded=new Set<string>();
      for(const record of namespace==='objects'?[]:records.slice(offset,offset+8)){const bytes=await this.readFolded(namespace,record.key);
        if(bytes){check(sha256(bytes)===record.key,'STORAGE_BATCH_INTEGRITY',500);folded.add(record.key);}}
      for(const record of records.slice(offset,offset+8))try{const stat=await fs.lstat(this.filename(directory,record.key));
        check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');existing.add(record.key);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await this.reserve(records.slice(offset,offset+8).reduce((n,r)=>n+(existing.has(r.key)||folded.has(r.key)?0:r.bytes.length),0));
      const outcomes=await Promise.allSettled(records.slice(offset,offset+8).map(async record=>{
        check(sha256(record.bytes)===record.key,'STORAGE_BATCH_INTEGRITY');
        if(folded.has(record.key))return;
        const target=this.filename(directory,record.key),temporary=join(directory,`.pending-${randomUUID()}`);
        if(existing.has(record.key)){
          check(sha256(await this.read(namespace,record.key))===record.key,'STORAGE_BATCH_INTEGRITY',500);
          if(namespace==='objects')await this.refreshOriginal(target);return;
        }
        const h=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{
          try{await h.writeFile(record.bytes);await h.sync();}finally{await h.close();}
          try{await fs.link(temporary,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
          check(sha256(await this.read(namespace,record.key))===record.key,'STORAGE_BATCH_INTEGRITY',500);
          if(namespace==='objects')await this.refreshOriginal(target);
        }finally{await fs.unlink(temporary);}
      }));
      const failure=outcomes.find(x=>x.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    }
    await this.syncDirectory(directory);
  }
  /** Deliberately staged. Callers must flushNamespace before returning any durable receipt. */
  async stageAlias(namespace:string,key:string,alias:string):Promise<{winner:Uint8Array}>{
    const directory=await this.directory(namespace),target=this.filename(directory,key),slot=this.filename(directory,alias);
    check(key!==alias&&sha256(await this.read(namespace,key))===key,'STORAGE_ALIAS_INTEGRITY',500);
    const foldedAlias=await this.readFolded(namespace,alias);if(foldedAlias)return {winner:foldedAlias};
    const foldedKey=await this.readFolded(namespace,key);if(foldedKey)return {winner:await this.publish(namespace,alias,foldedKey)};
    if(await this.cold?.contains(namespace,alias))return {winner:await this.read(namespace,alias)};
    if(await this.cold?.contains(namespace,key))return {winner:await this.publish(namespace,alias,await this.read(namespace,key))};
    try{await fs.link(target,slot);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    return {winner:await this.read(namespace,alias)};
  }
  async flushNamespace(namespace:string):Promise<void>{await this.syncDirectory(await this.directory(namespace));}
  /** A synced 0600 temporary renamed over the key: readers see the old or the new document, never a torn one. */
  async replace(namespace:string,key:string,bytes:Uint8Array):Promise<void>{
    const directory=await this.directory(namespace),target=this.filename(directory,key),temporary=join(directory,`.pending-${randomUUID()}`);
    await this.reserve(bytes.length);
    const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,target);await this.syncDirectory(directory);
    }finally{await fs.unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
  }
  prepareCapture(){return this.withOriginalWrite(async()=>{await this.directory('raw-ingress');await this.reserve(4096*5);
    for(const namespace of ['objects','source-clock-bases','archive-alerts','archive-alert-deliveries'])await this.directory(namespace);
    await this.prepareIngressReserve();await this.refillIngressReserve(true);});}
  // A physically allocated emergency pool, consumed only by durable producer admission.
  private async prepareIngressReserve(){
    if(!this.ingressReserve)this.ingressReserve=(async()=>{
      await this.directory('raw-ingress');const path=join(this.root,'.raw-ingress-reserve');
      let handle;try{handle=await fs.open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const existing=await fs.lstat(path);check(existing.isFile()&&!existing.isSymbolicLink()&&existing.size<=64*1024*1024&&existing.blocks*512>=existing.size,'UNSAFE_STORAGE_RESERVE');return;}
      try{await this.reserve(64*1024*1024);await this.refillIngressReserve(true);}
      catch(error){await fs.unlink(path);throw error;}
      finally{await handle.close();}await this.syncDirectory(this.root);
    })().catch(error=>{this.ingressReserve=undefined;throw error;});
    await this.ingressReserve;
  }
  private async refillIngressReserve(required=false){
    const work=async()=>{
      const handle=await fs.open(join(this.root,'.raw-ingress-reserve'),constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);
      try{const current=await handle.stat(),needed=64*1024*1024-current.size;
        check(current.isFile()&&needed>=0&&current.blocks*512>=current.size,'UNSAFE_STORAGE_RESERVE');
        if(!needed)return;
        if(!await this.reserveFits(needed)){
          if(required)throw Object.assign(new Error('L5_CAPTURE_PREPARATION_PAUSED: reserve cannot be replenished'),{code:'ENOSPC'});return;}
        const block=Buffer.alloc(1024*1024);
        for(let remaining=needed;remaining>0;remaining-=block.length)await handle.writeFile(block.subarray(0,Math.min(remaining,block.length)));
        await handle.sync();
      }finally{await handle.close();}
    };
    const result=this.reserveClaims.then(work);this.reserveClaims=result.catch(()=>{});
    try{await result;}catch(error){this.reportReserve(error);if(required)throw error;}
  }
  private async claimIngressReserve(bytes:number,notify=true,cleanup=false){
    // Owner cleanup must stay writable below the capture floor to reclaim explicitly selected originals.
    const fits=async()=>{if(!cleanup)return this.reserveFits(bytes);
      const stat=await fs.statfs(this.root);return stat.bavail*stat.bsize>=bytes;};
    if(await fits())return;
    if(notify){await this.reportPressure(bytes);
      await this.reclaim(bytes);}
    if(cleanup)await this.prepareIngressReserve();
    const work=async()=>{
      if(await fits())return;
      const handle=await fs.open(join(this.root,'.raw-ingress-reserve'),constants.O_RDWR|constants.O_NOFOLLOW);
      try{const current=await handle.stat(),claim=Math.ceil((bytes+4096)/4096)*4096;
        check(current.isFile()&&!current.isSymbolicLink(),'UNSAFE_STORAGE_RESERVE');
        if(current.size<claim)throw Object.assign(new Error('L5_RAW_INGRESS_PAUSED: emergency reserve exhausted'),{code:'ENOSPC'});
        await handle.truncate(current.size-claim);await handle.sync();
      }finally{await handle.close();}
    };
    const claimed=this.reserveClaims.then(work);this.reserveClaims=claimed.catch(()=>{});
    try{await claimed;}catch(error){if(notify)this.reportReserve(error);throw error;}
  }
  async publishIngressMeta(namespace:string,key:string,bytes:Uint8Array){
    check(['archive-alerts','archive-alert-deliveries','source-clock-bases','owner-deletions'].includes(namespace)&&(namespace==='owner-deletions'||bytes.length<=1024*1024),'INVALID_INGRESS_METADATA_NAMESPACE');
    if(namespace!=='owner-deletions')await this.prepareIngressReserve();return this.publishLocal(namespace,key,bytes,true,false);
  }
  async publishIngress(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array,beforeWrite?:()=>Promise<void>){
    try{await this.withOriginalWrite(()=>this.publishIngressOwned(key,metadata,hash,payload,beforeWrite));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOSPC'){await this.reportPressure(payload.length+metadata.length,error);
      await this.reclaim(payload.length+metadata.length);}throw error;}
  }
  async publishIngressBatch(records:{key:string;metadata:Uint8Array;hash:string;payload:Uint8Array;beforeWrite:()=>Promise<void>}[]){
    try{await this.withOriginalWrite(async()=>{
      await this.prepareIngressReserve();for(const record of records)await record.beforeWrite();
      const write=async(namespace:string)=>{
        for(let offset=0;offset<records.length;offset+=8){
          const results=await Promise.allSettled(records.slice(offset,offset+8).map(async record=>{
            const bytes=namespace==='objects'?record.payload:record.metadata,key=namespace==='objects'?record.hash:record.key;
            check(sha256(bytes)===key,'RAW_INGRESS_PAYLOAD_INTEGRITY');
            const stored=await this.publishLocal(namespace,key,bytes,true,true,false,false);
            check(Buffer.from(stored).equals(Buffer.from(bytes)),'RAW_INGRESS_METADATA_CONFLICT',409);
          }));
          const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
        }
        await this.flushNamespace(namespace);
      };
      await write('objects');await write('raw-ingress');
    });}catch(error){if((error as NodeJS.ErrnoException).code==='ENOSPC'){
      const bytes=records.reduce((n,x)=>n+x.payload.length+x.metadata.length,0);
      await this.reportPressure(bytes,error);await this.reclaim(bytes);}throw error;}
  }
  private async publishIngressOwned(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array,beforeWrite?:()=>Promise<void>){
    await this.prepareIngressReserve();await beforeWrite?.();
    check(sha256(payload)===hash,'RAW_INGRESS_PAYLOAD_INTEGRITY');
    check(sha256(await this.publishLocal('objects',hash,payload,true))===hash,'RAW_INGRESS_PAYLOAD_INTEGRITY',500);
    const stored=await this.publishLocal('raw-ingress',key,metadata,true);
    check(Buffer.from(stored).equals(Buffer.from(metadata)),'RAW_INGRESS_METADATA_CONFLICT',409);
  }
  async removeIngress(key:string){return this.withOriginalWrite(()=>this.removeIngressOwned(key));}
  private async removeIngressOwned(key:string){
    const directory=await this.directory('raw-ingress');
    try{await fs.unlink(this.filename(directory,key));await this.syncDirectory(directory);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await this.refillIngressReserve();
  }
  async putObject(bytes: Uint8Array): Promise<string> {
    const hash = sha256(bytes);
    const stored = await this.publish('objects', hash, bytes);
    check(sha256(stored) === hash, 'STORAGE_INTEGRITY_FAILURE', 500);
    return hash;
  }
}
