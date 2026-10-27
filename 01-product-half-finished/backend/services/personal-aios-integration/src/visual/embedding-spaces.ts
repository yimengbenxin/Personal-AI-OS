import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {check} from '../contracts.ts';
import {inTransaction,openReadOnlySnapshot} from '../owner-db.ts';

/** Identity includes the caller's pinned model, endpoint and preprocessing contract. */
export interface EmbeddingSpace {id:string;dimensions:number}
export interface EmbeddingProvider {
  embeddingSpace:EmbeddingSpace;
  embedImage(bytes:Buffer,signal?:AbortSignal):Promise<number[]>;
  embedQuery(text:string):Promise<number[]>;
  close?():Promise<void>;
}
export interface EmbeddingCandidate {generation:string;space:EmbeddingSpace}
type Generation=EmbeddingCandidate&{state:'building'|'verified';sources:string};
/** Snapshot only existing metadata; never opens the owner database for writing. */
export function readEmbeddingSpace(directory:string):EmbeddingSpace|undefined {
  const path=join(directory,'visual.sqlite');if(!existsSync(path))return undefined;
  const snapshot=openReadOnlySnapshot(path);
  try {
    const active=snapshot.db.prepare("SELECT value FROM meta WHERE key='embedding_active'").get();if(!active)return undefined;
    const row=snapshot.db.prepare('SELECT document FROM embedding_generations WHERE generation=?').get(active.value!);
    check(row,'VISUAL_EMBEDDING_METADATA_INVALID',503);const value=JSON.parse(String(row.document));
    check(value.state==='verified'&&value.space&&typeof value.space.id==='string'&&Number.isSafeInteger(value.space.dimensions),'VISUAL_EMBEDDING_METADATA_INVALID',503);
    return {id:value.space.id,dimensions:value.space.dimensions};
  }finally{snapshot.close();}
}
export class VisualEmbeddingSpaces {
  private provider:EmbeddingProvider;
  private readonly db:DatabaseSync;
  private building=false;
  private candidate:string|undefined;
  private readonly readers=new Map<string,number>();
  private readonly providers=new Map<string,EmbeddingProvider>();
  private readonly owned=new Set<EmbeddingProvider>();private readonly retired=new WeakSet<EmbeddingProvider>();
  private readonly closing=new Set<Promise<void>>();private readonly closeErrors:unknown[]=[];private shutdown:Promise<void>|undefined;
  constructor(db:DatabaseSync,provider:EmbeddingProvider) {
    this.db=db;this.provider=provider;this.validate(provider.embeddingSpace);
    db.exec('CREATE TABLE IF NOT EXISTS embedding_generations(generation TEXT PRIMARY KEY,document TEXT NOT NULL) STRICT');
    const active=this.current();
    if(active){check(this.same(active.space,provider.embeddingSpace),'VISUAL_EMBEDDING_SPACE_MISMATCH',503);}
    else {
      check(provider.embeddingSpace.dimensions===1024,'VISUAL_LEGACY_EMBEDDING_DIMENSIONS',503);
      const initial:Generation={generation:'vectors',space:{...provider.embeddingSpace},state:'verified',sources:this.sources()};
      inTransaction(db,()=>{this.verify(initial);this.save(initial);this.set('embedding_active','vectors');});
    }
    this.providers.set(this.current()!.generation,provider);this.owned.add(provider);
    // An unfinished build never becomes active after a process restart.
    for(const generation of this.all().filter(value=>value.state==='building')) {
      db.exec(`DROP TABLE IF EXISTS ${this.table(generation.generation)}`);
      db.prepare('DELETE FROM embedding_generations WHERE generation=?').run(generation.generation);
    }
    this.prune();
  }
  private validate(space:EmbeddingSpace) {
    check(space&&typeof space.id==='string'&&space.id.trim().length>0&&Number.isSafeInteger(space.dimensions)&&space.dimensions>0&&space.dimensions<=65536,'VISUAL_EMBEDDING_SPACE_INVALID');
  }
  private same(a:EmbeddingSpace,b:EmbeddingSpace){return a.id===b.id&&a.dimensions===b.dimensions;}
  private table(name:string){check(name==='vectors'||/^vectors_[a-f0-9]{32}$/u.test(name),'VISUAL_EMBEDDING_GENERATION_INVALID');return name;}
  private get(key:string){return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value as string|undefined;}
  private set(key:string,value:string){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  private load(name:string):Generation|undefined {
    const row=this.db.prepare('SELECT document FROM embedding_generations WHERE generation=?').get(name);
    return row?JSON.parse(String(row.document)):undefined;
  }
  private all():Generation[]{return this.db.prepare('SELECT document FROM embedding_generations').all().map(row=>JSON.parse(String(row.document)));}
  private save(value:Generation){this.db.prepare('INSERT INTO embedding_generations VALUES(?,?) ON CONFLICT(generation) DO UPDATE SET document=excluded.document').run(value.generation,JSON.stringify(value));}
  private current(){
    const name=this.get('embedding_active');if(!name)return undefined;const value=this.load(name);
    check(value&&value.state==='verified','VISUAL_EMBEDDING_METADATA_INVALID',503);return value;
  }
  private sources(){return JSON.stringify(this.rows().map(row=>[row.id,row.frame_key]));}
  private rows(){return this.db.prepare("SELECT id,frame_key,principal_id,captured_ms FROM frames WHERE state='ready' ORDER BY id").all() as {id:number;frame_key:string;principal_id:string;captured_ms:number}[];}
  snapshot(){
    check(!this.shutdown,'VISUAL_EMBEDDING_CLOSED',503);const generation=this.current()!.generation;this.readers.set(generation,(this.readers.get(generation)??0)+1);let released=false;
    return {generation,provider:this.provider,release:()=>{if(!released){released=true;const remaining=this.readers.get(generation)!-1;
      if(remaining)this.readers.set(generation,remaining);else this.readers.delete(generation);this.prune();}}};
  }
  private prune(){
    if(!this.db.isOpen)return;
    const keep=new Set([this.get('embedding_active'),this.get('embedding_previous'),this.candidate,...this.readers.keys()]);
    for(const value of this.all())if(value.state!=='building'&&!keep.has(value.generation)){
      this.db.exec(`DROP TABLE IF EXISTS ${this.table(value.generation)}`);this.db.prepare('DELETE FROM embedding_generations WHERE generation=?').run(value.generation);this.providers.delete(value.generation);
    }
    const retained=new Set(this.providers.values());for(const provider of this.owned)if(!retained.has(provider))this.retire(provider);
  }
  private retire(provider:EmbeddingProvider){
    if(this.retired.has(provider))return;this.retired.add(provider);this.owned.delete(provider);
    const pending=Promise.resolve().then(()=>provider.close?.()).catch(error=>{this.closeErrors.push(error);}).finally(()=>this.closing.delete(pending));
    this.closing.add(pending);
  }
  close(){return this.shutdown??=(async()=>{
    for(const provider of this.owned)this.retire(provider);await Promise.all(this.closing);
    if(this.closeErrors.length)throw new AggregateError(this.closeErrors,'VISUAL_EMBEDDING_PROVIDER_CLOSE_FAILED');
  })();}
  info(){
    const active=this.current()!,name=this.get('embedding_previous'),previous=name?this.load(name):undefined;
    return {active:{generation:active.generation,space:active.space},previous:previous?{generation:previous.generation,space:previous.space}:undefined};
  }
  vector(values:number[],space:EmbeddingSpace){
    check(Array.isArray(values)&&values.length===space.dimensions&&values.every(Number.isFinite)&&values.some(value=>value!==0),'VISUAL_EMBEDDING_VECTOR_INVALID',502);
    const vector=new Float32Array(values);
    check(vector.every(Number.isFinite)&&vector.some(value=>value!==0),'VISUAL_EMBEDDING_VECTOR_INVALID',502);return vector;
  }
  async prepare(provider:EmbeddingProvider,image:(principal:string,key:string)=>Promise<Buffer>,signal?:AbortSignal,onProgress?:(value:{done:number;total:number})=>void):Promise<EmbeddingCandidate> {
    check(!this.shutdown&&!this.retired.has(provider),'VISUAL_EMBEDDING_CLOSED',503);check(!this.building,'VISUAL_EMBEDDING_BUILD_BUSY',409);this.validate(provider.embeddingSpace);this.building=true;
    const rows=this.rows(),generation=`vectors_${randomUUID().replaceAll('-','')}`;
    const candidate:Generation={generation,space:{...provider.embeddingSpace},state:'building',sources:JSON.stringify(rows.map(row=>[row.id,row.frame_key]))};
    try {
      signal?.throwIfAborted();this.candidate=generation;this.prune();
      inTransaction(this.db,()=>{this.db.exec(`CREATE VIRTUAL TABLE ${generation} USING vec0(embedding float[${candidate.space.dimensions}] distance_metric=cosine,principal_id text partition key,captured_ms integer)`);this.save(candidate);});
      onProgress?.({done:0,total:rows.length});let done=0;
      for(const row of rows){
        signal?.throwIfAborted();const bytes=await image(row.principal_id,row.frame_key);signal?.throwIfAborted();
        const vector=this.vector(await provider.embedImage(bytes,signal),candidate.space);signal?.throwIfAborted();
        this.db.prepare(`INSERT INTO ${generation}(rowid,embedding,principal_id,captured_ms) VALUES(?,?,?,?)`).run(BigInt(row.id),vector,row.principal_id,BigInt(row.captured_ms));
        onProgress?.({done:++done,total:rows.length});
      }
      signal?.throwIfAborted();this.verify(candidate);candidate.state='verified';this.save(candidate);this.providers.set(generation,provider);this.owned.add(provider);
      return {generation,space:{...candidate.space}};
    }catch(error){
      this.db.exec(`DROP TABLE IF EXISTS ${generation}`);this.db.prepare('DELETE FROM embedding_generations WHERE generation=?').run(generation);throw error;
    }finally{this.building=false;}
  }
  private verify(candidate:Generation){
    check(candidate.sources===this.sources(),'VISUAL_EMBEDDING_SOURCE_CHANGED',409);
    const indexed=this.db.prepare(`SELECT rowid,principal_id,captured_ms FROM ${this.table(candidate.generation)} ORDER BY rowid`).all();
    check(JSON.stringify(indexed.map(row=>[row.rowid,row.principal_id,row.captured_ms]))===JSON.stringify(this.rows().map(row=>[row.id,row.principal_id,row.captured_ms])),'VISUAL_EMBEDDING_INDEX_INCOMPLETE',409);
  }
  activate(candidate:EmbeddingCandidate){
    const value=this.load(this.table(candidate.generation));
    check(value&&value.state==='verified'&&this.same(value.space,candidate.space),'VISUAL_EMBEDDING_CANDIDATE_INVALID',409);
    if(this.current()!.generation===candidate.generation)return;
    const provider=this.providers.get(candidate.generation);check(provider,'VISUAL_EMBEDDING_PROVIDER_REQUIRED',503);
    inTransaction(this.db,()=>{this.verify(value);this.set('embedding_previous',this.current()!.generation);this.set('embedding_active',candidate.generation);});
    this.provider=provider;this.candidate=undefined;this.prune();
  }
  async preparePrevious(provider:EmbeddingProvider,image:(principal:string,key:string)=>Promise<Buffer>,signal?:AbortSignal){
    const previous=this.info().previous;check(previous&&this.same(previous.space,provider.embeddingSpace),'VISUAL_EMBEDDING_PREVIOUS_MISMATCH',409);
    return this.prepare(provider,image,signal);
  }
  assertCurrent(generation:string){check(generation===this.current()!.generation,'VISUAL_EMBEDDING_SPACE_CHANGED',409);}
  deleteRow(id:number){for(const generation of this.all())this.db.prepare(`DELETE FROM ${this.table(generation.generation)} WHERE rowid=?`).run(BigInt(id));}
}
