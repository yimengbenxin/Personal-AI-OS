import type {StoragePort} from '../src/storage.ts';
import {digest,type ArchivedEvent} from '../src/contracts.ts';
import {StreamArchive,streamManifestRevision} from '../src/stream-archive.ts';
// Consumer tests explicitly ask the real source owner for a pinned full proof.
// The compact append receipt is never wrapped or changed.
export async function materialized(source:StoragePort|StreamArchive,receipt:{event:ArchivedEvent}){
 const owner=source instanceof StreamArchive?source:new StreamArchive(source,{max_chunk_bytes:10485760,max_total_bytes:10485760,max_chunks:4096,max_revisions:4096,max_seq:65536});
 const head=await owner.head(receipt.event.raw_ref);
 for(let n=head?.revision??0;n>0;n--){const manifest=await owner.revision(receipt.event.raw_ref,n);if(streamManifestRevision(manifest)===receipt.event.archive_revision)return manifest;}
 throw new Error('FIXTURE_PINNED_REVISION_NOT_FOUND');
}

export async function committedCount(storage:StoragePort){
 let count=0;for(const key of await storage.list('stream-revisions')){const m=JSON.parse(Buffer.from(await storage.read('stream-revisions',key)).toString());if(key===digest([m.raw_ref,m.revision]))count++;}return count;
}

// Explicit HTTP boundary backed by an isolated local directory for cold lifecycle fixtures.
export async function webdav(t:import('node:test').TestContext,root:string){
 const {createServer}=await import('node:http'),{promises:fs}=await import('node:fs'),{join}=await import('node:path');
 const directory=join(root,'cold'),password_file=join(root,'webdav-password'),state={corrupt:false,unavailable:false,reads:0,
   uploaded:0,onUpload:undefined as (()=>void)|undefined};
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(password_file,'fixture-password');
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`){res.writeHead(401).end();return;}
  if(state.unavailable){res.writeHead(503).end();return;}
  const ref=(req.url??'').slice(1);if(!/^[a-f0-9]{64}\.l5pack$/u.test(ref)){res.writeHead(400).end();return;}
  const path=join(directory,ref);
  try{
   if(req.method==='PUT'){const parts:Buffer[]=[];for await(const part of req){parts.push(part);state.uploaded+=part.length;state.onUpload?.();}
     await fs.writeFile(path,Buffer.concat(parts));res.writeHead(201).end();return;}
   if(req.method==='DELETE'){await fs.unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});res.writeHead(204).end();return;}
   state.reads++;let bytes=await fs.readFile(path);if(state.corrupt){bytes=Buffer.from(bytes);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;}
   const range=/^bytes=(\d+)-(\d+)$/u.exec(req.headers.range??'');
   if(range){const start=Number(range[1]),end=Number(range[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}).end(bytes.subarray(start,end+1));}
   else res.writeHead(200).end(bytes);
  }catch(error){res.writeHead((error as NodeJS.ErrnoException).code==='ENOENT'?404:500).end();}
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
 return {directory,state,config:{url:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,username:'fixture',password_file}};
}
