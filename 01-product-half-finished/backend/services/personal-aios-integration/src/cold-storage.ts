import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {configureSqlite,openReadOnlySnapshot} from './owner-db.ts';
import {gzip,gunzip,createGzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {spawn} from 'node:child_process';
import {canonical,check,sha256} from './contracts.ts';

export interface ColdConfig {url:string;username:string;password_file:string}
export interface ColdRecord {namespace:string;key:string;bytes:Uint8Array;format?:string}
interface Item {namespace:string;key:string;hash:string;size:number;offset:number;block:number}
interface Block {codec:'gzip'|'flac';format?:string;offset:number;size:number;decoded:number;hash?:string}
interface Pack {schema:'paios.cold.v1';items:Item[];blocks:Block[]}
export interface ColdLocation {namespace:string;key:string;pack:string;size:number;hash:string}
const DECODE=64*1024*1024,WIRE=80*1024*1024,HEADER=1024*1024,compress=promisify(gzip),expand=promisify(gunzip);
// Transport, lossless codec and derived locations only. RawArchive owns lifecycle decisions.
export class ColdStorage {
  private db:DatabaseSync|undefined;private opening:Promise<void>|undefined;
  private tail:Promise<unknown>=Promise.resolve();private queued=0;private running=0;private inputBytes=0;
  snapshot(){return {active:this.running,queued:this.queued-this.running,max_jobs:8,input_bytes:this.inputBytes,
    max_input_bytes:DECODE,max_wire_bytes:WIRE,max_decoded_bytes:DECODE,cache_bytes:[...this.cache.values()].reduce((n,b)=>n+b.length,0)};}
  private flights=new Map<string,Promise<unknown>>();private cache=new Map<string,Buffer>();
  private readonly readOnly:boolean;
  private closeSnapshot:(()=>void)|undefined;
  private hotRoot:string;private config:ColdConfig;private deadline:number;
  constructor(hotRoot:string,config:ColdConfig,deadline=300000,readOnly=false){
    this.readOnly=readOnly;this.config=config;this.deadline=deadline;
    this.hotRoot=resolve(hotRoot);const url=new URL(config.url);
    check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'COLD_URL_INVALID');
  }
  private async index(){
    if(this.readOnly){
      if(this.db)return this.db;
      const path=join(this.hotRoot,'cold.sqlite');
      try{const stat=await fs.lstat(path);check(stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');const snapshot=openReadOnlySnapshot(path);this.db=snapshot.db;this.closeSnapshot=snapshot.close;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        this.db=new DatabaseSync(':memory:');this.db.exec('CREATE TABLE locations(namespace TEXT,key TEXT,pack TEXT,size INTEGER,hash TEXT); CREATE TABLE packs(key TEXT,size INTEGER)');}
      return this.db;
    }
    if(this.db)return this.db;
    await (this.opening??=fs.mkdir(this.hotRoot,{recursive:true,mode:0o700}).then(async()=>{
      const stat=await fs.lstat(this.hotRoot);check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_STORAGE_ROOT');
      try{const s=await fs.lstat(join(this.hotRoot,'cold.sqlite'));check(s.isFile()&&!s.isSymbolicLink(),'UNSAFE_STORAGE_OBJECT');}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const db=new DatabaseSync(join(this.hotRoot,'cold.sqlite'));
      try{configureSqlite(db);
        db.exec('CREATE TABLE IF NOT EXISTS locations(namespace TEXT NOT NULL,key TEXT NOT NULL,pack TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(namespace,key)); CREATE INDEX IF NOT EXISTS locations_pack ON locations(pack); CREATE TABLE IF NOT EXISTS packs(key TEXT PRIMARY KEY,size INTEGER NOT NULL);');
        await fs.chmod(join(this.hotRoot,'cold.sqlite'),0o600);this.db=db;
      }catch(error){db.close();throw error;}
    }).finally(()=>{this.opening=undefined;}));return this.db!;
  }
  private job<T>(task:()=>Promise<T>):Promise<T>{
    check(this.queued<8,'COLD_BUDGET_BUSY',503);this.queued++;
    const work=this.tail.then(async()=>{this.running++;try{return await task();}finally{this.running--;}});this.tail=work.catch(()=>{});
    return work.finally(()=>{this.queued--;});
  }
  private shared<T>(key:string,task:()=>Promise<T>):Promise<T>{
    const existing=this.flights.get(key);if(existing)return existing as Promise<T>;
    const work=this.job(task).finally(()=>{this.flights.delete(key);});this.flights.set(key,work);return work;
  }
  private async http(ref:string,method='GET',body?:Uint8Array,range?:[number,number],bound=WIRE,expected?:number,destination?:Buffer,beforeUpload?:(bytes:number)=>void,uploadChunk?:(bytes:number)=>Promise<void>){
    check((method==='MKCOL'&&ref==='backups')||/^(?:[a-f0-9]{64}\.l5pack|backups\/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}|originals\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_-]+\.jpg)$/u.test(ref),'COLD_REFERENCE_INVALID');
    const password=(await fs.readFile(this.config.password_file,'utf8')).trimEnd();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.deadline);
    try{
      let offset=0,uploadError:unknown;
      const upload=body?new ReadableStream<Uint8Array>({async pull(stream){
        if(offset===body.byteLength){stream.close();return;}
        const end=Math.min(offset+16*1024,body.byteLength);
        try{await uploadChunk?.(end-offset);stream.enqueue(body.subarray(offset,end));offset=end;}
        catch(error){uploadError=error;stream.error(error);}
      }},{highWaterMark:0}):undefined;
      if(body)beforeUpload?.(body.byteLength);
      const response=await fetch(`${this.config.url.replace(/\/$/u,'')}/${ref}`,{method,redirect:'error',signal:controller.signal,
        headers:{Authorization:`Basic ${Buffer.from(`${this.config.username}:${password}`).toString('base64')}`,
          ...(range?{Range:`bytes=${range[0]}-${range[1]}`}:{ }),...(body?{'Content-Length':String(body.byteLength)}:{})},
        ...(upload?{body:upload,duplex:'half' as const}:{})}).catch(error=>{throw uploadError??error;});
      check(method==='MKCOL'?[201,405].includes(response.status):response.ok||(method==='DELETE'&&response.status===404),'COLD_HTTP_FAILED',503);
      if(range)check(response.status===206&&response.headers.get('content-range')?.startsWith(`bytes ${range[0]}-${range[1]}/`),'COLD_RANGE_INVALID',502);
      const length=expected??(range?range[1]-range[0]+1:undefined);
      check(length===undefined||Number.isSafeInteger(length)&&length>=0&&length<=bound,'COLD_RESPONSE_LIMIT',502);
      const target=destination??(length===undefined?undefined:Buffer.allocUnsafe(length));
      const parts:Buffer[]=[];let size=0;
      for await(const part of response.body??[]){size+=part.length;check(size<=bound,'COLD_RESPONSE_LIMIT',502);
        check(length===undefined||size<=length,range?'COLD_RESPONSE_LIMIT':'COLD_COPY_INTEGRITY',range?502:500);
        if(target)target.set(part,size-part.length);else parts.push(Buffer.from(part.buffer,part.byteOffset,part.byteLength));}
      check(length===undefined||size===length,range?'COLD_RANGE_TRUNCATED':'COLD_COPY_INTEGRITY',range?502:500);const bytes=target??Buffer.concat(parts);parts.length=0;return bytes;
    }finally{controller.abort();clearTimeout(timer);}
  }
  private async codec(data:Uint8Array|Uint8Array[],format:string,decode=false,bound=WIRE):Promise<Buffer>{
    const pcm=/^pcm_s16le:(\d+):([12])$/u.exec(format);check(pcm,'COLD_PCM_FORMAT');
    return new Promise((done,fail)=>{
      const args=decode?['-i','pipe:0','-c:a','pcm_s16le','-f','s16le','pipe:1']:
        ['-f','s16le','-ar',pcm[1]!,'-ac',pcm[2]!,'-i','pipe:0','-c:a','flac','-threads','1','-metadata_header_padding','0','-f','flac','pipe:1'];
      const command=process.platform==='linux'?'ionice':'nice',priority=process.platform==='linux'?['-c','3','nice','-n','15']:['-n','15'];
      const child=spawn(command,[...priority,'ffmpeg','-v','error','-threads','1',...args],{stdio:['pipe','pipe','pipe']}),parts:Buffer[]=[],decoded=decode?Buffer.allocUnsafe(bound):undefined;let size=0,errors='';
      const pipeClosed=new AbortController();let failure:Error|undefined,inputFinished=false;
      const stop=(error:Error)=>{failure??=error;child.kill('SIGKILL');},timer=setTimeout(()=>stop(new Error('COLD_CODEC_TIMEOUT')),30000);
      child.stdout.on('data',part=>{size+=part.length;if(size>bound)stop(new Error('COLD_CODEC_OUTPUT_LIMIT'));else if(decoded)part.copy(decoded,size-part.length);else parts.push(part);});
      child.stderr.on('data',part=>{errors=(errors+String(part)).slice(-4096);});child.on('error',stop);child.stdin.on('error',stop);
      child.on('close',code=>{
        clearTimeout(timer);pipeClosed.abort();
        if(!inputFinished)failure??=new Error('COLD_CODEC_INPUT_CLOSED');
        const bytes=!failure&&code===0?(decoded?.subarray(0,size)??Buffer.concat(parts)):undefined;parts.length=0;
        bytes?done(bytes):fail(failure??new Error(`COLD_FLAC_FAILED: ${errors}`));
      });
      void (async()=>{try{
        for(const part of Array.isArray(data)?data:[data])if(!child.stdin.write(part))await once(child.stdin,'drain',{signal:pipeClosed.signal});
        child.stdin.end();inputFinished=true;
      }catch(error){if(!pipeClosed.signal.aborted)stop(error as Error);}})();
    });
  }
  private async header(key:string,size:number,data?:Buffer){
    check(/^[a-f0-9]{64}$/u.test(key)&&size<=WIRE,'COLD_PACK_FORMAT',500);
    const prefix=data?.subarray(0,8)??await this.http(`${key}.l5pack`,'GET',undefined,[0,7],8);
    check(prefix.toString('utf8',0,4)==='L5P1','COLD_PACK_FORMAT',500);const end=8+prefix.readUInt32BE(4);
    check(end<=size&&end<=HEADER,'COLD_HEADER_LIMIT',500);
    const bytes=data?.subarray(8,end)??await this.http(`${key}.l5pack`,'GET',undefined,[8,end-1],HEADER);
    const pack=JSON.parse((await expand(bytes,{maxOutputLength:HEADER})).toString()) as Pack;
    check(pack.schema==='paios.cold.v1'&&Array.isArray(pack.items)&&Array.isArray(pack.blocks),'COLD_PACK_FORMAT',500);
    check(pack.blocks.reduce((sum,b)=>sum+b.decoded,0)<=DECODE,'COLD_DECODE_LIMIT',500);
    for(const b of pack.blocks)check(['gzip','flac'].includes(b.codec)&&Number.isSafeInteger(b.offset)&&b.offset>=0&&Number.isSafeInteger(b.size)&&b.size>0&&end+b.offset+b.size<=size&&Number.isSafeInteger(b.decoded)&&b.decoded>=0,'COLD_BLOCK_INVALID',500);
    for(const i of pack.items)check(/^[a-z][a-z0-9-]{0,40}$/u.test(i.namespace)&&/^[a-f0-9]{64}$/u.test(i.key)&&pack.blocks[i.block]&&Number.isSafeInteger(i.offset)&&i.offset>=0&&Number.isSafeInteger(i.size)&&i.size>=0&&i.offset+i.size<=pack.blocks[i.block]!.decoded&&/^[a-f0-9]{64}$/u.test(i.hash),'COLD_ITEM_INVALID',500);
    return {pack,end};
  }
  private async block(key:string,pack:Pack,end:number,n:number,data?:Buffer){
    const b=pack.blocks[n]!,ref=`${key}:${n}`,cached=!data&&this.cache.get(ref);if(cached)return cached;
    const encoded=data?.subarray(end+b.offset,end+b.offset+b.size)??await this.http(`${key}.l5pack`,'GET',undefined,[end+b.offset,end+b.offset+b.size-1],b.size);
    check(!b.hash||sha256(encoded)===b.hash,'COLD_BLOCK_INTEGRITY',500);
    const decoded=b.codec==='flac'?await this.codec(encoded,b.format!,true,b.decoded):await expand(encoded,{maxOutputLength:b.decoded});
    check(decoded.length===b.decoded,'COLD_PACK_INTEGRITY',500);
    for(const i of pack.items.filter(i=>i.block===n))check(sha256(decoded.subarray(i.offset,i.offset+i.size))===i.hash&&(i.namespace!=='objects'||i.key===i.hash),'COLD_OBJECT_INTEGRITY',500);
    if(!data){this.cache.clear();this.cache.set(ref,decoded);}return decoded;
  }
  async locations(selection?:Pick<ColdRecord,'namespace'|'key'>[],pack?:string){
    const db=await this.index(),query='SELECT namespace,key,pack,size,hash FROM locations';
    if(selection){const find=db.prepare(query+' WHERE namespace=? AND key=?'+(pack?' AND pack=?':''));return selection.map(r=>find.get(...(pack?[r.namespace,r.key,pack]:[r.namespace,r.key]))).filter(Boolean) as unknown as ColdLocation[];}
    return db.prepare(query+(pack?' WHERE pack=?':'')).all(...(pack?[pack]:[])) as unknown as ColdLocation[];
  }
  async packs(referenced:boolean|'unreferenced'=false,after='',limit=Number.MAX_SAFE_INTEGER){return (await this.index()).prepare('SELECT key,size FROM packs WHERE key>?'+(referenced?' AND key '+(referenced==='unreferenced'?'NOT ':'')+'IN (SELECT pack FROM locations)':'')+' ORDER BY key LIMIT ?').all(after,limit) as unknown as {key:string;size:number}[];}
  async keys(namespace:string){return (await this.index()).prepare('SELECT key FROM locations WHERE namespace=? ORDER BY key').all(namespace).map(r=>String(r.key));}
  async contains(namespace:string,key:string){return (await this.locations([{namespace,key}])).length>0;}
  async read(namespace:string,key:string):Promise<Uint8Array>{
    const loc=(await this.locations([{namespace,key}]))[0];if(!loc)throw Object.assign(new Error('cold object absent'),{code:'ENOENT'});
    const size=Number((await this.index()).prepare('SELECT size FROM packs WHERE key=?').get(loc.pack)!.size);
    const {pack,end}=await this.shared(`${loc.pack}:header`,()=>this.header(loc.pack,size));
    const item=pack.items.find(i=>i.namespace===namespace&&i.key===key);check(item,'COLD_LOCATION_INVALID',500);
    const bytes=(await this.shared(`${loc.pack}:${item.block}`,()=>this.block(loc.pack,pack,end,item.block))).subarray(item.offset,item.offset+item.size);
    check(bytes.length===loc.size&&sha256(bytes)===loc.hash,'COLD_OBJECT_INTEGRITY',500);return Buffer.from(bytes);
  }
  private async unpack(data:Buffer,key:string,size:number):Promise<ColdRecord[]>{
    check(data.length===size&&sha256(data)===key,'COLD_COPY_INTEGRITY',500);
    const {pack,end}=await this.header(key,size,data),blocks:Buffer[]=[];
    for(let n=0;n<pack.blocks.length;n++)blocks.push(await this.block(key,pack,end,n,data));
    return pack.items.map(i=>({namespace:i.namespace,key:i.key,bytes:blocks[i.block]!.subarray(i.offset,i.offset+i.size),...(pack.blocks[i.block]!.format?{format:pack.blocks[i.block]!.format!}:{})}));
  }
  async records(key:string):Promise<ColdRecord[]>{
    const size=Number((await this.index()).prepare('SELECT size FROM packs WHERE key=?').get(key)!.size);
    return this.shared(`${key}:verified`,async()=>this.unpack(await this.http(`${key}.l5pack`,'GET',undefined,undefined,WIRE,size),key,size));
  }
  async verifiedRecords(selection?:Pick<ColdRecord,'namespace'|'key'>[]){
    const rows=await this.locations(selection);for(const key of new Set(rows.map(r=>r.pack)))await this.records(key);return rows;
  }
  async move(records:ColdRecord[],beforeUpload?:(bytes:number)=>void,uploadChunk?:(bytes:number)=>Promise<void>):Promise<{pack:string;bytes:number}>{check(this.queued===0,'COLD_BUDGET_BUSY',503);return this.job(async()=>{
    this.cache.clear();this.inputBytes=records.reduce((n,r)=>n+r.bytes.length,0);try{
    check(records.length>0&&records.reduce((sum,r)=>sum+r.bytes.length,0)<=DECODE,'COLD_SEGMENT_LIMIT');
    const groups=new Map<string,ColdRecord[]>();for(const r of records){
      check(/^[a-z][a-z0-9-]{0,40}$/u.test(r.namespace)&&/^[a-f0-9]{64}$/u.test(r.key),'INVALID_COLD_RECORD');
      const format=r.format?.startsWith('pcm_s16le:')?r.format:`gzip:${r.namespace==='objects'?'original':'metadata'}`;const group=groups.get(format)??[];group.push(r);groups.set(format,group);}
    const items:Item[]=[],blocks:Block[]=[],encoded:Buffer[]=[];let offset=0;
    for(const [groupKey,group] of groups){const format=groupKey.startsWith('gzip:')?'gzip':groupKey,data=group.map(r=>r.bytes),decoded=data.reduce((n,b)=>n+b.length,0);let inner=0;
      for(const r of group){const hash=sha256(r.bytes);check(r.namespace!=='objects'||hash===r.key,'COLD_ORIGINAL_INTEGRITY',500);items.push({namespace:r.namespace,key:r.key,hash,size:r.bytes.length,offset:inner,block:blocks.length});inner+=r.bytes.length;}
      let bytes:Buffer;
      if(format==='gzip'){const zipper=Readable.from(data).pipe(createGzip({level:1})),parts:Buffer[]=[];let size=0;
        for await(const part of zipper){size+=part.length;check(size<=WIRE,'COLD_SEGMENT_LIMIT');parts.push(part);}bytes=Buffer.concat(parts,size);
      }else bytes=await this.codec(data,format);
      blocks.push({codec:format==='gzip'?'gzip':'flac',...(format==='gzip'?{}:{format}),offset,size:bytes.length,decoded,hash:sha256(bytes)});encoded.push(bytes);offset+=bytes.length;}
    const metadata=Buffer.from(canonical({schema:'paios.cold.v1',items,blocks}));check(metadata.length<=HEADER,'COLD_HEADER_LIMIT');
    const header=await compress(metadata),prefix=Buffer.alloc(8);prefix.write('L5P1');prefix.writeUInt32BE(header.length,4);
    check(header.length+8<=HEADER&&header.length+8+offset<=WIRE,'COLD_SEGMENT_LIMIT');
    const data=Buffer.concat([prefix,header,...encoded]);encoded.length=0;const key=sha256(data),size=data.length;
    const db=await this.index();db.prepare('INSERT OR IGNORE INTO packs(key,size) VALUES(?,?)').run(key,size);
    await this.http(`${key}.l5pack`,'PUT',data,undefined,HEADER,undefined,undefined,beforeUpload,uploadChunk);
    const copied=await this.http(`${key}.l5pack`,'GET',undefined,undefined,WIRE,size,data);check(sha256(copied)===key,'COLD_COPY_INTEGRITY',500);
    const parsed=await this.header(key,size,copied);for(let n=0;n<blocks.length;n++)await this.block(key,parsed.pack,parsed.end,n,copied);
    db.exec('BEGIN IMMEDIATE');try{
      const insert=db.prepare('INSERT INTO locations(namespace,key,pack,size,hash) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET pack=excluded.pack,size=excluded.size,hash=excluded.hash');
      for(const i of items)insert.run(i.namespace,i.key,key,i.size,i.hash);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}return {pack:key,bytes:size};
    }finally{this.inputBytes=0;}
  });}
  async forget(records:Pick<ColdRecord,'namespace'|'key'>[],pack?:string){const db=await this.index();db.exec('BEGIN IMMEDIATE');try{
    for(const r of records)db.prepare('DELETE FROM locations WHERE namespace=? AND key=? AND (? IS NULL OR pack=?)').run(r.namespace,r.key,pack??null,pack??null);
    db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
  async removePack(key:string){await this.job(async()=>{const db=await this.index();check(!db.prepare('SELECT 1 FROM locations WHERE pack=?').get(key),'COLD_PACK_REFERENCED');
    await this.http(`${key}.l5pack`,'DELETE',undefined,undefined,HEADER);db.prepare('DELETE FROM packs WHERE key=?').run(key);this.cache.clear();});}
  async upload(ref:string,bytes:Uint8Array):Promise<{size:number;hash:string}>{
    check(bytes.length<=DECODE&&this.queued===0,'COLD_BUDGET_BUSY',503);return this.job(async()=>{
      if(ref.startsWith('backups/'))await this.http('backups','MKCOL',undefined,undefined,HEADER);
      const hash=sha256(bytes);await this.http(ref,'PUT',bytes,undefined,HEADER);const copied=await this.http(ref,'GET',undefined,undefined,DECODE);
      check(copied.length===bytes.length&&sha256(copied)===hash,'COLD_COPY_INTEGRITY',500);return {size:bytes.length,hash};
    });
  }
  async download(ref:string){return this.shared(`legacy:${ref}`,()=>this.http(ref,'GET',undefined,undefined,DECODE));}
  async delete(ref:string){await this.job(()=>this.http(ref,'DELETE',undefined,undefined,HEADER));}
  async close(){await this.tail;if(this.opening)await this.opening;if(this.closeSnapshot){this.closeSnapshot();this.closeSnapshot=undefined;}else if(this.db?.isOpen)this.db.close();}
}
