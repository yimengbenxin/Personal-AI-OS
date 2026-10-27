import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createDesktopSimulator} from '../tools/mac-product-sim-client.ts';

async function fixture(t:test.TestContext,options:{folders?:string[];now?:()=>number;productFolders?:boolean}={}){
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'desktop-sim-'))),handlers=new Map<string,Function>(),controllers=new Map(),uploads:any[]=[],events:any[]=[],messages:any[]=[],outbound:any[]=[],elicitationStarted=Promise.withResolvers<void>();
  let action:'accept'|'decline'='accept',elicited:any,closed=false,hold:Promise<void>|undefined;
  const client=new Client({name:'sim-test-relay',version:'1'},{capabilities:{elicitation:{form:{}}}});
  const transport:any={start:async()=>{},close:async()=>{},send:async(message:any)=>{
    messages.push(message);incoming('paios.desktop.mcp.v1',Buffer.from(JSON.stringify(message)),{v:'1'});
  }};
  function incoming(topic:string,bytes:Buffer,attributes:Record<string,string>,mimeType='application/json'){
    const streamId=randomUUID();let controller!:ReadableStreamDefaultController<{content:Uint8Array}>;
    const stream=new ReadableStream<{content:Uint8Array}>({start(value){controller=value;}});
    controllers.set(streamId,{header:{totalLength:BigInt(bytes.length)},controller});
    handlers.get(topic)!({info:{streamId,totalSize:bytes.length,attributes,mimeType},reader:stream},{identity:'gateway'});
    queueMicrotask(()=>{controller.enqueue({content:bytes});controller.close();});
  }
  const room={byteStreamControllers:controllers,registerByteStreamHandler:(topic:string,handler:Function)=>handlers.set(topic,handler),unregisterByteStreamHandler:(topic:string)=>handlers.delete(topic),
    localParticipant:{streamBytes:async(options:any)=>{const chunks:Buffer[]=[];return {write:async(bytes:Uint8Array)=>{assert.ok(bytes.length<=65536);chunks.push(Buffer.from(bytes));},close:async()=>{
      const bytes=Buffer.concat(chunks);assert.equal(bytes.length,options.totalSize);assert.deepEqual(options.destinationIdentities,['gateway']);
      if(options.topic==='paios.desktop.mcp.v1'){const message=JSON.parse(bytes.toString());outbound.push(message);transport.onmessage?.(message);}else uploads.push({options,bytes});}};}}};
  const host=await createDesktopSimulator(root,room as never,'gateway',event=>events.push(event),{...options,...(options.productFolders?{}:{folders:options.folders??[root]})});
  client.setRequestHandler(ElicitRequestSchema,async request=>{elicited=request.params;elicitationStarted.resolve();if(hold)await hold;return {action,...(action==='accept'?{content:{}}:{})};});
  await client.connect(transport);
  t.after(async()=>{if(!closed){await client.close();await host.close();closed=true;}await fs.rm(root,{recursive:true,force:true});});
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args}) as Promise<any>;
  const text=(result:any)=>result.content[0].text as string;
  return {root,host,client,call,text,uploads,events,messages,outbound,elicitationStarted:elicitationStarted.promise,incoming,setAction:(value:typeof action)=>{action=value;},holdConsent:(value:Promise<void>)=>{hold=value;},get elicited(){return elicited;}};
}

test('simulator advertises the exact manifest and performs bounded scratch file work',async t=>{
  const f=await fixture(t),manifest=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/desktop-tools.v1.json',import.meta.url),'utf8'));
  const listed=await f.client.listTools();assert.deepEqual(f.outbound.find(message=>message.result?.tools)?.result.tools,manifest.tools);assert.deepEqual(listed.tools.map(tool=>tool.name),manifest.tools.map((tool:any)=>tool.name));
  assert.equal(JSON.parse(f.text(await f.call('list_allowed_directories')))[0].path,f.root);
  const file=join(f.root,'invoice.txt'),folder=join(f.root,'sorted');
  await f.call('write_file',{path:file,content:'invoice total 42'});
  await f.call('edit_file',{path:file,edits:[{oldText:'42',newText:'43'}]});
  assert.equal(f.text(await f.call('read_text_file',{path:file})),'invoice total 43');
  assert.equal(f.text(await f.call('extract_text',{path:file,max_chars:7})),'invoice');
  assert.equal((await fs.readdir(join(f.root,'.undo'))).length,1);
  assert.equal((JSON.parse(f.text(await f.call('find_files',{folder:f.root,kinds:['text']}))) as any[]).length,1);
  assert.equal((JSON.parse(f.text(await f.call('search_files',{path:f.root,pattern:'**/*.txt'}))) as any[]).length,1);
  assert.equal((JSON.parse(f.text(await f.call('search_files',{path:f.root,pattern:join(f.root,'**/*.txt')}))) as any[]).length,1);
  assert.equal((JSON.parse(f.text(await f.call('search_files',{path:f.root,pattern:'**/*.txt',excludePatterns:['*.txt']}))) as any[]).length,0);
  assert.equal((JSON.parse(f.text(await f.call('search_files',{path:f.root,pattern:'*.txt',excludePatterns:['invoice.*']}))) as any[]).length,0);
  assert.equal(JSON.parse(f.text(await f.call('get_file_info',{path:file}))).isFile,true);
  assert.equal(JSON.parse(f.text(await f.call('list_directory',{path:f.root}))).length,1);
  assert.equal(JSON.parse(f.text(await f.call('list_directory_with_sizes',{path:f.root,sortBy:'size'})))[0].size,16);
  await f.call('create_directory',{path:folder});await f.call('move_file',{source:file,destination:join(folder,'invoice.txt')});
  assert.equal(await fs.readFile(join(folder,'invoice.txt'),'utf8'),'invoice total 43');
  for(const path of ['/etc/passwd',join(f.root,'../escape'),join(f.root,'.env')])assert.equal((await f.call('read_text_file',{path})).isError,true);
  await fs.symlink('/etc',join(f.root,'escape'));assert.equal((await f.call('read_text_file',{path:join(f.root,'escape','passwd')})).isError,true);
  assert.equal((await f.call('unknown_tool')).isError,true);
  assert.ok(f.events.every(event=>!JSON.stringify(event).includes(f.root)));
});

test('per-file drag/paste grants deny siblings, expire, revoke and retire replaced identities',async t=>{
  let now=Date.now();const f=await fixture(t,{folders:[],now:()=>now}),file=join(f.root,'invoice.txt'),sibling=join(f.root,'ungranted.txt');
  await fs.writeFile(file,'synthetic 42');await fs.writeFile(sibling,'must stay private');
  assert.equal(f.text(await f.call('read_text_file',{path:file})),'GUARD_PATH_NOT_AUTHORIZED');
  for(const via of ['drag','paste'] as const){
    const {attachment,record}=await f.host.grant(file,via,1);
    assert.deepEqual(Object.keys(attachment).sort(),['grant_id','kind','name','path','size']);assert.equal(record.via,via);assert.equal(record.id,attachment.grant_id);
    assert.equal(record.granted_at,(now-Date.UTC(2001,0,1))/1000);assert.equal(record.expires_at-record.granted_at,1);
    assert.equal(f.text(await f.call('read_text_file',{path:file})),'synthetic 42');
    assert.equal(f.text(await f.call('read_text_file',{path:sibling})),'GUARD_PATH_NOT_AUTHORIZED');
    assert.equal(f.text(await f.call('move_file',{source:file,destination:sibling})),'GUARD_PATH_NOT_AUTHORIZED');
    const upload=await f.call('upload_to_workshop',{path:file});assert.equal(upload.isError,undefined);assert.equal(f.uploads.at(-1).bytes.toString(),'synthetic 42');
    now+=1001;assert.equal(f.text(await f.call('extract_text',{path:file})),'GUARD_PATH_NOT_AUTHORIZED');
    f.host.revoke(attachment.grant_id);
  }
  const revoked=await f.host.grant(file,'paste');f.host.revoke(revoked.attachment.grant_id);
  assert.equal(f.text(await f.call('upload_to_workshop',{path:file})),'GUARD_PATH_NOT_AUTHORIZED');assert.equal(f.uploads.length,2);
  await f.host.grant(file,'drag');await fs.rename(file,file+'.old');await fs.writeFile(file,'replacement');
  assert.equal(f.text(await f.call('read_text_file',{path:file})),'GUARD_PATH_NOT_AUTHORIZED');
});

test('folder grant 文稿/依米 stays in scope and does not authorize adjacent folders or symlink escapes',async t=>{
  const f=await fixture(t,{productFolders:true}),folder=join(f.root,'文稿','依米');await fs.mkdir(folder,{recursive:true});
  const nested=join(folder,'nested');await fs.mkdir(nested);await fs.writeFile(join(nested,'ok.txt'),'folder scope');
  assert.equal(f.text(await f.call('read_text_file',{path:join(nested,'ok.txt')})),'folder scope');
  const outside=join(f.root,'文稿','private.txt');await fs.writeFile(outside,'ungranted');
  assert.equal(f.text(await f.call('read_text_file',{path:outside})),'GUARD_PATH_NOT_AUTHORIZED');
  await fs.symlink(outside,join(folder,'escape'));assert.equal(f.text(await f.call('read_text_file',{path:join(folder,'escape')})),'GUARD_PATH_NOT_AUTHORIZED');
  assert.equal(JSON.parse(f.text(await f.call('list_allowed_directories')))[0].path,folder);
});

test('simulator asks correlated trash consent, preserves denied file and reports pause state',async t=>{
  const f=await fixture(t),file=join(f.root,'discard.txt');await fs.writeFile(file,'keep until approved');
  f.setAction('decline');assert.equal((await f.call('trash',{paths:[file]})).isError,true);assert.equal(await fs.readFile(file,'utf8'),'keep until approved');
  assert.ok(f.elicited._meta['paios/relatedRequestId']!==undefined);
  f.setAction('accept');assert.equal((await f.call('trash',{paths:[file]})).isError,undefined);
  assert.equal((await fs.readdir(join(f.root,'.trash'))).length,1);
  await f.client.notification({method:'notifications/paios/pause',params:{paused:true}});
  await new Promise(setImmediate);
  assert.equal(f.text(await f.call('list_allowed_directories')),'DESKTOP_PAUSED');
  await f.client.notification({method:'notifications/paios/pause',params:{paused:false}});await new Promise(setImmediate);
  assert.equal((await f.call('list_allowed_directories')).isError,undefined);
});

test('simulator transfers real bytes with request binding and validates download digest',async t=>{
  const f=await fixture(t),file=join(f.root,'upload.txt'),bytes=Buffer.from('synthetic transfer');await fs.writeFile(file,bytes);
  const result=await f.call('upload_to_workshop',{path:file}),upload=f.uploads[0],digest=createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(upload.bytes,bytes);assert.equal(upload.options.attributes.sha256,digest);assert.equal(upload.options.attributes.dir,'up');assert.equal(upload.options.totalSize,bytes.length);
  assert.equal(JSON.parse(f.text(result)).transfer_id,upload.options.attributes.transfer);assert.match(upload.options.attributes.transfer,/^dt-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const transfer_id='dt-'+randomUUID(),download=f.call('save_from_workshop',{workshop_path:'/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/result.txt',_transfer:{transfer_id,size:bytes.length,sha256:digest}});
  await new Promise(setImmediate);
  const request=f.messages.findLast(message=>message.method==='tools/call');
  f.incoming('paios.desktop.file.v1',bytes,{v:'1',transfer:transfer_id,dir:'down',name:'result.txt',size:String(bytes.length),sha256:digest,request:String(request.id)},'application/octet-stream');
  assert.equal((await download).isError,undefined);assert.deepEqual(await fs.readFile(join(f.root,'result.txt')),bytes);
});

test('simulator cancellation interrupts pending consent and preserves scratch input',async t=>{
  const f=await fixture(t),file=join(f.root,'pending.txt'),release=Promise.withResolvers<void>(),abort=new AbortController();await fs.writeFile(file,'unchanged');
  f.holdConsent(release.promise);
  const pending=f.client.callTool({name:'trash',arguments:{paths:[file]}},undefined,{signal:abort.signal});
  await f.elicitationStarted;assert.ok(f.elicited);abort.abort();await assert.rejects(pending);
  release.resolve();await new Promise(setImmediate);assert.equal(await fs.readFile(file,'utf8'),'unchanged');
});

/** A minimal uncompressed PDF whose pages each carry one Helvetica text line. */
function textPdf(lines:string[]):Buffer {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${lines.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${lines.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const [i,line] of lines.entries()){
    const stream=`BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf='%PDF-1.4\n';const offsets:number[]=[];
  for(const [i,body] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;}
  const xref=pdf.length;
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,'latin1');
}

test('simulator PDF extraction honors every selected page and omits the rest',async t=>{
  const f=await fixture(t),file=join(f.root,'three-pages.pdf');
  await fs.writeFile(file,textPdf(['ALPHA page one','BRAVO page two','CHARLIE page three']));
  const extract=async(pages?:number[])=>f.text(await f.call('extract_text',{path:file,...(pages?{pages}:{})}));
  const one='ALPHA page one\n\n\f',two='BRAVO page two\n\n\f',three='CHARLIE page three\n\n\f';
  assert.equal(await extract([1]),one);
  assert.equal(await extract([2]),two);
  assert.equal(await extract([1,3]),one+three);
  assert.equal(await extract([3,1]),three+one);
  assert.equal(await extract(),one+two+three);
  assert.equal(f.text(await f.call('extract_text',{path:file,pages:[1,3],max_chars:5})),'ALPHA');
  assert.equal(f.text(await f.call('extract_text',{path:file,pages:[1,4]})),'GUARD_TYPE_UNSUPPORTED');
});
