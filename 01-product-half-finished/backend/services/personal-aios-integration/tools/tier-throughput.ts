// Local, fictional data only. Run through the test wrapper; no production configuration is read.
import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const [source,rootArg,mode='run',secondsArg='180']=process.argv.slice(2),root=resolve(rootArg!);
const {PosixStorage}=await import(pathToFileURL(join(resolve(source!),'src/storage.ts')).href);
const {RawArchive}=await import(pathToFileURL(join(resolve(source!),'src/archive.ts')).href);
const {digest,sha256,canonical}=await import(pathToFileURL(join(resolve(source!),'src/contracts.ts')).href);
const shapes=[['stream-revisions',923392,1706843620],['media-source-progress',484647,1061294020],
  ['audio-consumer-results',445062,285114176],['objects',426449,2421731055],
  ['media-postarchive-admissions',117259,242316367],['media-vad-selections',21017,773383403],
  ['processed-media-inputs',21162,496939692],['processed-media',21155,347134885],['media-views',21084,334596729]] as const;
const hot=join(root,'hot'),remote=join(root,'webdav'),password_file=join(root,'fictional-password');
const rate=250000,latency=200,stats={put:0,get:0,uploaded:0,downloaded:0,request_ms:0};
await fs.mkdir(remote,{recursive:true});await fs.writeFile(password_file,'fictional-only');
const server=createServer(async(req,res)=>{
  const started=performance.now();
  if(req.headers.authorization!==`Basic ${Buffer.from('fixture:fictional-only').toString('base64')}`){res.writeHead(401).end();return;}
  const name=(req.url??'').slice(1);if(!/^[a-f0-9]{64}\.l5pack$/u.test(name)){res.writeHead(400).end();return;}
  try{
    await sleep(latency);
    if(req.method==='PUT'){
      const parts:Buffer[]=[];let size=0;const uploadStart=performance.now();
      for await(const part of req){parts.push(part);size+=part.length;await sleep(Math.max(0,size/rate*1000-(performance.now()-uploadStart)));}
      await fs.writeFile(join(remote,name),Buffer.concat(parts));stats.put++;stats.uploaded+=size;res.writeHead(201).end();
    }else if(req.method==='DELETE'){await fs.rm(join(remote,name),{force:true});res.writeHead(204).end();}
    else{
      stats.get++;const bytes=await fs.readFile(join(remote,name)),range=/^bytes=(\d+)-(\d+)$/u.exec(req.headers.range??'');
      const data=range?bytes.subarray(Number(range[1]),Number(range[2])+1):bytes;stats.downloaded+=data.length;
      res.writeHead(range?206:200,range?{'Content-Range':`bytes ${range[1]}-${range[2]}/${bytes.length}`}:{ });res.end(data);
    }
  }catch(error){res.writeHead((error as NodeJS.ErrnoException).code==='ENOENT'?404:500).end();}
  finally{stats.request_ms+=performance.now()-started;}
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const config={url:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,username:'fixture',password_file};
const storage=new PosixStorage(hot,{cold:config}),archive=new RawArchive(storage,64*1024*1024);
const age=new Date('2026-10-06T00:00:00Z'),sessions=Array.from({length:64},(_,n)=>`l5:${digest(['fictional-session',n])}`);
let stopIngest=false,producer:Promise<void>|undefined;const ingest={records:0,bytes:0};
try{
  if(mode==='seed'){
    const total=shapes.reduce((n,s)=>n+s[1],0),refs=sessions.map(()=>[] as {namespace:string;key:string}[]),objects=sessions.map(()=>[] as {key:string;format:string}[]);
    const distribution=[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,2,6];let files=0,bytes=0;const counts:Record<string,unknown>={};
    const empty=Buffer.alloc(0),emptyHash=sha256(empty);await fs.mkdir(join(hot,'objects'),{recursive:true});await fs.writeFile(join(hot,'objects',emptyHash),empty);
    for(const [namespace,population,payload] of shapes){
      const count=Math.ceil(200000*population/total),mean=payload/population;let written=0,logical=0;
      await fs.mkdir(join(hot,namespace),{recursive:true});
      for(let n=0;n<count;n++){
        const owner=n%64,ref=sessions[owner],size=Math.round(mean*distribution[Math.floor(n/64)%10]!);
        let value:any={raw_ref:ref,fixture_id:n};
        if(namespace==='stream-revisions')value={schema:'paios.stream.delta.v2',raw_ref:ref,revision:Math.floor(n/128)+1,
          chunk:{object_hash:emptyHash,format:'jpeg',received_at:age.toISOString()},fixture_id:Math.floor(n/128)};
        if(namespace==='media-vad-selections')value={input:{raw_ref:ref},fixture_id:n};
        if(namespace==='media-postarchive-admissions')value={...value,schema:'paios.media.postarchive-admission.interval.v2'};
        if(namespace.startsWith('processed-media'))value={raw_ref:ref,segment_id:`fictional-${Math.floor(n/64)}`,revision:1};
        const padding=Math.max(0,size-Buffer.byteLength(JSON.stringify(value))-13);
        value.padding=randomBytes(Math.ceil(padding*0.75)).toString('base64').slice(0,padding);
        let data=namespace==='objects'?randomBytes(size):Buffer.from(canonical(value));
        // Real journal records have both a content name and a sequence alias.
        if(namespace==='stream-revisions'&&Math.floor(n/64)%2===1){
          const alias=digest([ref,value.revision]);data=await fs.readFile(join(hot,namespace,alias));
        }
        let key=namespace==='objects'?sha256(data):namespace==='stream-revisions'&&Math.floor(n/64)%2===0?digest([ref,value.revision]):
          namespace.startsWith('processed-media')?digest([ref,value.segment_id,1]):sha256(data);
        await fs.writeFile(join(hot,namespace,key),data);await fs.utimes(join(hot,namespace,key),age,age);
        // Half the old result leaves have no producer ownership edge, just like unresolved legacy leaves.
        if(namespace!=='audio-consumer-results'||n%2===0)refs[owner]!.push({namespace,key});
        if(namespace==='objects')objects[owner]!.push({key,format:'jpeg'});
        written++;logical+=data.length;
      }
      files+=written;bytes+=logical;counts[namespace]={files:written,bytes:logical};console.log(JSON.stringify({seed:namespace,...counts[namespace] as object}));
    }
    for(let n=0;n<sessions.length;n++){
      await storage.trackSessionRecords(sessions[n],refs[n]);
      await storage.publishFinal({schema:'paios.session.final.v1',raw_ref:sessions[n],object_hash:emptyHash,bytes:0,records:[],objects:[],retained_objects:objects[n],ended_by:'fixture_end'});
      await storage.completeFinal(sessions[n]);
    }
    await fs.writeFile(join(root,'shape.json'),JSON.stringify({files,bytes,counts},null,2));
    console.log(JSON.stringify({seeded:files,bytes}));
  }else{
    const initial=await storage.cold.locations(),initialBytes=initial.reduce((n:any,r:any)=>n+r.size,0);
    if(mode.startsWith('drain'))for(const pack of await storage.cold.packs(true))await storage.cold.records(pack.key);
    const timings:Record<string,{calls:number;ms:number}>={};
    for(const name of ['read','readHotMany','hotSize','modifiedAt','hasLiveSessionOwner','moveCold','removeOriginals'].filter(name=>typeof storage[name]==='function')){
      const original=storage[name].bind(storage),timing=timings[name]={calls:0,ms:0};
      storage[name]=async(...args:unknown[])=>{const start=performance.now();timing.calls++;try{return await original(...args);}finally{timing.ms+=performance.now()-start;}};
    }
    const notices:string[]=[];archive.setAlert(async(reason:string)=>{notices.push(reason);});
    const started=performance.now(),duration=Number(secondsArg)*1000,ticks:unknown[]=[];
    if(mode==='drain-ingest'){
      producer=(async()=>{while(!stopIngest){const began=performance.now(),base=ingest.records;
        await Promise.all(Array.from({length:24},async(_,n)=>{
          const namespace=n%6===0?'objects':'media-source-progress',bytes=namespace==='objects'?randomBytes(6000):
            Buffer.from(JSON.stringify({schema:'fictional.ingest',n:base+n,at:new Date().toISOString(),padding:randomBytes(1700).toString('base64')}));
          await storage.publish(namespace,sha256(bytes),bytes);ingest.records++;ingest.bytes+=bytes.length;
        }));await sleep(Math.max(0,1000-(performance.now()-began)));
      }})();void producer.catch(()=>{});
    }
    let busy=false;const busyFrom=mode==='busy'?15000:Infinity,busyUntil=mode==='busy'?45000:Infinity;
    const policy={max_upload_kbps:2000,busy:()=>{const elapsed=performance.now()-started;return busy||(elapsed>=busyFrom&&elapsed<busyUntil);}};
    let nextTick=started;
    while(nextTick<started+duration){
      const wait=nextTick-performance.now();if(wait>0)await sleep(wait);
      const tickStart=performance.now();await archive.maintenance(1,Date.now(),policy);
      const locations=await storage.cold.locations(),elapsed=performance.now()-tickStart;
      const tick={elapsed_ms:elapsed,records:locations.length,bytes:locations.reduce((n:any,r:any)=>n+r.size,0),ingest:{...ingest},folding:archive.maintenanceSnapshot()};
      ticks.push(tick);console.log(JSON.stringify(tick));
      const backlog=archive.packingSnapshot().tiering?.backlog;
      if(mode.startsWith('drain')&&backlog?.complete&&backlog.old_records===0)break;
      nextTick=Math.max(nextTick+60000,performance.now());
    }
    const elapsed=performance.now()-started,locations=await storage.cold.locations();
    const result={mode,elapsed_ms:elapsed,shape:JSON.parse(await fs.readFile(join(root,'shape.json'),'utf8')),ticks,timings,http:stats,notices,ingest,
      initial_records:initial.length,initial_bytes:initialBytes,
      verified_records:locations.length,verified_bytes:locations.reduce((n:any,r:any)=>n+r.size,0),
      records_per_day:(locations.length-initial.length)/elapsed*86400000,bytes_per_day:(locations.reduce((n:any,r:any)=>n+r.size,0)-initialBytes)/elapsed*86400000,packing:archive.packingSnapshot()};
    await fs.writeFile(join(root,`result-${mode}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}finally{stopIngest=true;await producer;await archive.close();await storage.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
