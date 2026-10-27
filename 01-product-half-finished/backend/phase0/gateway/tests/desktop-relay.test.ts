import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Room,RoomEvent} from '@livekit/rtc-node';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
const {StreamableHTTPClientTransport}=createRequire(import.meta.url)('@modelcontextprotocol/sdk/client/streamableHttp.js') as {StreamableHTTPClientTransport:new(url:URL,options:{requestInit:{headers:Record<string,string>}})=>Transport};
import {CallToolRequestSchema,ListToolsRequestSchema,ElicitRequestSchema,LATEST_PROTOCOL_VERSION,type JSONRPCMessage,type CallToolRequest,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {createDesktopRelay,desktopConfiguration,DESKTOP_MCP_TOPIC} from '../src/desktop-relay.ts';
import {createDesktopFiles,DESKTOP_FILE_TOPIC} from '../src/desktop-files.ts';
import {MAC_CAPABILITIES,PHONE_CAPABILITIES,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {createPersonalAIOSServer} from '../../../services/personal-aios-integration/src/server.ts';
import {PersonalAIOSRuntime,RunAdmission,HermesClient,type NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import {EVENT_SCHEMA,type RawEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {RealtimeBootstrapConnectedInput} from '../src/realtime-public-control-runtime.ts';
import type {WireAttachment} from '../src/personal-aios-terminal-wire.ts';
import {createDesktopSimulator} from '../tools/mac-product-sim-client.ts';
import {presentationTools,textPlanHash} from '../src/presentation-validate.ts';
import {succeeded,to_mcp_result,accepted} from '../../../../../capability/sdk/ts/receipt.ts';
const manifest=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/desktop-tools.v1.json',import.meta.url),'utf8'));
const ok={content:[{type:'text' as const,text:'ok'}]},token='desktop-relay-internal-test-token',at='2026-10-14T00:00:00.000Z';
const errorCode=(result:unknown)=>(result as {structuredContent?:{error?:{code?:string}}}).structuredContent?.error?.code;
const settle=async()=>{for(let n=0;n<20;n++)await new Promise<void>(resolve=>setImmediate(resolve));};
async function eventually(check:()=>boolean){for(let n=0;n<400;n++){if(check())return;await new Promise<void>(resolve=>setTimeout(resolve,5));}assert.fail('desktop condition did not arrive');}
type MacHandler=(request:CallToolRequest,extra:{requestId:string|number;signal:AbortSignal},server:Server)=>Promise<CallToolResult>;
async function fixture(t:test.TestContext,settings:{time_zone?:string;analyzeVision?:HermesClient['analyzeVision'];owner?:boolean;onManifest?:()=>void;runtime?:Pick<PersonalAIOSRuntime,'terminals'|'desktopReady'|'time_zone'>;mismatch?:boolean;config?:unknown;capability?:boolean;handler?:MacHandler;prepareDownload?:Awaited<ReturnType<typeof createDesktopFiles>>['prepareDownload']}={}) {
  const root=await fs.mkdtemp(join(tmpdir(),'desktop-relay-')),errors:unknown[]=[],clients:Client[]=[],stops:(()=>void)[]=[],macServers:Server[]=[];
  const rows=['phone','mac','mac-two'].map(id=>({device_id:id,user_id:'owner',device_class:id==='phone'?'iphone':'mac',status:'active',paired_at:at,label:id,
    recipient_public_key:'pk',device_credential_ref:{},media:['data'],governance:{terminal_capabilities:id==='phone'?PHONE_CAPABILITIES:MAC_CAPABILITIES}}));
  const source=(id:string):RegisteredDevice=>({principal_id:'owner',device_id:id,device_type:id==='phone'?'phone':'mac',capabilities:id==='phone'?PHONE_CAPABILITIES:MAC_CAPABILITIES,
    channel:'rtc_typed_text',route_version:'route',output_modes:['text'],consent_ref:'consent'});
  const pool={query:async(sql:string,args:unknown[]=[])=>{if(sql.startsWith('WITH revoked AS')){const row=rows.find(row=>row.device_id===args[0]&&row.user_id===args[1]);if(row)row.status='revoked';return {rows:row?[row]:[]};}
    assert.match(sql,/FROM paired_devices WHERE status = 'active'/);return {rows:rows.filter(row=>row.status==='active')};}};
  const desktopInitialized=Promise.withResolvers<void>();
  const config=desktopConfiguration(settings.config??{})!,runtime=settings.runtime??{time_zone:settings.time_zone??'Asia/Taipei',terminals:()=>[source('mac'),source('mac-two')],desktopReady:async()=>{desktopInitialized.resolve();}},http={internal_token:token,max_request_bytes:1048576,request_timeout_ms:10000,resource_snapshot:()=>({turn:{fixture:'desktop-owner'}})};
  if(settings.owner)await fs.mkdir(join(root,'central'));
  const owner=settings.owner?await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central:{
    storage:new PosixStorage(join(root,'central')),native:new HermesClient('http://127.0.0.1:1',token,10000,1048576),
    admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'desktop-fixture'},
    skill:'desktop-fixture',max_event_bytes:8192,max_read_bytes:8192,http},
    t03:{ownerContext:{resolve:async()=>assert.fail('MCP initialize must not resolve a terminal source')}} as never,
    readCurrentBinding:async()=>undefined,deviceId:'phone',participant:{roomPort:new Room()} as never,onError:error=>errors.push(error)}):undefined;
  const files=await createDesktopFiles({...config.files,inbox:join(root,'inbox'),workshop:join(root,'workshop'),onError:error=>errors.push(error)});
  // Register the real relay after the owner has built its HTTP server, with isolated transfer directories.
  const relay=(await createDesktopRelay({config:settings.config??{},...(settings.capability?{capabilityCatalog:new Set(['mcp__desktop__list_allowed_directories'])}:{}),analyzeVision:settings.analyzeVision??(async()=>assert.fail('Unexpected vision call')),runtime,sources:{revalidate:async device=>{if(rows.find(row=>row.device_id===device.device_id)?.status!=='active')throw Object.assign(new Error('PAIRED_DEVICE_REVOKED'),{status:403});return device;}},pool:pool as never,http,onError:error=>errors.push(error),files:settings.prepareDownload?{...files,prepareDownload:settings.prepareDownload}:files}))!;
  const listener=owner?.assembly.server??createPersonalAIOSServer(runtime as never,http);await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const address=listener.address();assert.ok(address&&typeof address!=='string');const url=new URL(`http://127.0.0.1:${address.port}/internal/desktop/mcp`);
  const connect=async()=>{const client=new Client({name:'hermes-fixture',version:'1'},{capabilities:{elicitation:{form:{}}}}),transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${token}`}}});
    clients.push(client);client.onerror=error=>errors.push(error);await client.connect(transport);return {client,transport};};
  t.after(async()=>{for(const client of clients)await client.close();for(const stop of stops)stop();for(const server of macServers)await server.close();await relay.close();if(owner)await owner.bridge.close!();else await listener.closeAndDrain();await fs.rm(root,{recursive:true,force:true});});
  const {client,transport}=await connect();let streamNo=0;
  const attachMac=async(id='mac',handler:MacHandler=settings.handler??(async()=>ok),mismatch=settings.mismatch??false,presentation=false)=>{
    const room=new Room() as any,messages:JSONRPCMessage[]=[],calls:{request:CallToolRequest;id:string|number;signal:AbortSignal}[]=[],frames:unknown[]=[];
    let current=true,listed=false,disconnects=0;room.disconnect=async()=>{disconnects++;};const ready=Promise.withResolvers<void>(),unwatch=relay.watch(()=>{if(listed)ready.resolve();});
    const receive=(message:JSONRPCMessage,identity=`credential-${id}`,declared?:number)=>{const bytes=Buffer.from(JSON.stringify(message)),streamId=`${id}-${++streamNo}`;
      room.handleStreamHeader({streamId,topic:DESKTOP_MCP_TOPIC,mimeType:'application/json',totalLength:BigInt(declared??bytes.length),timestamp:0n,attributes:{v:'1'},contentHeader:{case:'byteHeader',value:{name:'frame'}}},identity);
      if(declared===undefined){room.handleStreamChunk({streamId,content:bytes,chunkIndex:0n});room.handleStreamTrailer({streamId});}return streamId;};
    const macTransport:Transport={start:async()=>{},close:async()=>{},send:async message=>{if('id' in message&&'result' in message&&Array.isArray(message.result.tools))listed=true;receive(message);if('id' in message&&'result' in message&&Array.isArray(message.result.tools))settings.onManifest?.();}};
    const server=new Server({name:'fake-mac',version:'1'},{capabilities:{tools:{listChanged:false}}});macServers.push(server);
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:mismatch?manifest.tools.map((tool:any,index:number)=>index===0?{...tool,description:'wrong version'}:tool):presentation?[...manifest.tools,...presentationTools]:manifest.tools}));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{calls.push({request,id:extra.requestId,signal:extra.signal});return handler(request,extra,server);});
    await server.connect(macTransport);
    // Fixture models departure dropping undelivered streams; this is not an SDK close guarantee.
    room.localParticipant={streamBytes:async(options:unknown)=>{frames.push(options);const chunks:Buffer[]=[];return {write:async(bytes:Uint8Array)=>{chunks.push(Buffer.from(bytes));},close:async()=>{if(disconnects)return;const message=JSON.parse(Buffer.concat(chunks).toString('utf8'));messages.push(message);macTransport.onmessage?.(message);}};}};
    const ctx:WireAttachment={device:source(id),room,identity:`credential-${id}`,current:()=>current,leave:()=>room.disconnect(),publish:async()=>{}};
    const detach=relay.extensions.map(extension=>extension.attach?.(ctx)),stop=()=>{current=false;for(const fn of detach)fn?.();unwatch();};stops.push(stop);
    await ready.promise;unwatch();return {room,server,messages,calls,frames,receive,ctx,stop,get disconnects(){return disconnects;},setCurrent:(value:boolean)=>{current=value;}};
  };
  const attachSimulator=async()=>{
    const gateway=new Room() as any,mac=new Room() as any,events:any[]=[];
    const pipe=(room:any,identity:string)=>({streamBytes:async(options:any)=>{
      const streamId=`fixture-${++streamNo}`;room.handleStreamHeader({streamId,topic:options.topic,mimeType:options.mimeType,totalLength:BigInt(options.totalSize),timestamp:0n,attributes:options.attributes,contentHeader:{case:'byteHeader',value:{name:'fixture'}}},identity);
      let index=0n;return {write:async(bytes:Uint8Array)=>{assert.ok(bytes.length<=65536);room.handleStreamChunk({streamId,content:bytes,chunkIndex:index++});},close:async()=>{room.handleStreamTrailer({streamId});}};
    }});
    gateway.localParticipant=pipe(mac,'gateway');mac.localParticipant=pipe(gateway,'credential-mac');
    const host=await createDesktopSimulator(root,mac,'gateway',event=>events.push(event));
    const detach=relay.extensions.map(extension=>extension.attach?.({device:source('mac'),room:gateway,identity:'credential-mac',current:()=>true,leave:async()=>{},publish:async()=>{}}));
    stops.push(()=>{for(const fn of detach)fn?.();});t.after(()=>host.close());
    await desktopInitialized.promise;return {host,events,root};
  };
  const raw=(body:unknown,headers:Record<string,string>={},method='POST',signal?:AbortSignal)=>fetch(url,{method,headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
  return {relay,client,transport,url,connect,attachMac,attachSimulator,source,rows,errors,raw};
}

// Exercise the production owner path: the first terminal owns the relay; a later Mac shares it.
async function assembledMac(t:test.TestContext,paused=false) {
  const root=await fs.mkdtemp(join(tmpdir(),'desktop-assembly-')),errors:unknown[]=[],gateway=new Room() as any,mac=new Room() as any;
  const transitions:any[]=[],stderr=process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr,'write',(chunk:any,...args:any[])=>{
    try{const row=JSON.parse(String(chunk));if(row.route==='desktop_peer')transitions.push(row);}catch{}
    return stderr(chunk,...args);
  });
  const formal:any[]=[],requests:any[]=[],readiness:boolean[]=[],owners:Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>[]=[];
  const config=desktopConfiguration({})!,files=await createDesktopFiles({...config.files,inbox:join(root,'in'),workshop:join(root,'out'),onError:error=>errors.push(error)});
  const rows=['phone','mac'].map(id=>({device_id:id,user_id:'owner',device_class:id==='phone'?'iphone':'mac',status:'active',paired_at:at,label:id,
    recipient_public_key:'pk',device_credential_ref:{},media:['data'],governance:{terminal_capabilities:id==='phone'?PHONE_CAPABILITIES:MAC_CAPABILITIES}}));
  let stream=0;
  const pipe=(room:any,identity:string)=>({streamBytes:async(options:any)=>{
    const streamId=`assembly-${++stream}`;
    room.handleStreamHeader({streamId,topic:options.topic,mimeType:options.mimeType,totalLength:BigInt(options.totalSize),timestamp:0n,attributes:options.attributes,contentHeader:{case:'byteHeader',value:{name:'frame'}}},identity);
    let index=0n;return {write:async(bytes:Uint8Array)=>room.handleStreamChunk({streamId,content:bytes,chunkIndex:index++}),close:async()=>room.handleStreamTrailer({streamId})};
  }});
  const send=async(message:JSONRPCMessage)=>{
    const bytes=Buffer.from(JSON.stringify(message)),writer=await mac.localParticipant.streamBytes({topic:DESKTOP_MCP_TOPIC,mimeType:'application/json',totalSize:bytes.length,attributes:{v:'1'}});
    await writer.write(bytes);await writer.close();
  };
  // ToolHost.swift accepts initialize/tools/list directly and ignores notifications/initialized.
  mac.registerByteStreamHandler(DESKTOP_MCP_TOPIC,(reader:any)=>{void(async()=>{
    const chunks:Buffer[]=[];for await(const chunk of reader)chunks.push(Buffer.from(chunk));
    const message=JSON.parse(Buffer.concat(chunks).toString());requests.push(message);
    if(message.method==='notifications/paios/ready'){readiness.push(message.params.ready);await send({jsonrpc:'2.0',method:'notifications/paios/state',params:{paused}});return;}
    if(message.id===undefined)return;
    let result:object;
    if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'paios-desktop',version:'1'}};
    else if(message.method==='tools/list')result={tools:manifest.tools};
    else if(message.method==='tools/call')result={content:[{type:'text',text:'[]'}],structuredContent:{directories:[]}};
    else throw new Error('Unexpected Mac request '+message.method);
    await send({jsonrpc:'2.0',id:message.id,result});
  })().catch(error=>errors.push(error));});
  gateway.localParticipant={...pipe(mac,'gateway'),sendText:async(text:string)=>{
    const message=JSON.parse(text);formal.push(message);
    // Desktop.start originally sent its persisted pause on active(true), before extension attach.
    if(message.operation==='ready')await send({jsonrpc:'2.0',method:'notifications/paios/state',params:{paused}});
  },publishData:async(bytes:Uint8Array)=>formal.push(JSON.parse(Buffer.from(bytes).toString()))};
  mac.localParticipant=pipe(gateway,'credential-mac');
  Object.defineProperty(gateway,'isConnected',{value:true});
  Object.defineProperty(gateway,'remoteParticipants',{value:new Map([['credential-mac',{identity:'credential-mac',trackPublications:new Map()}]])});
  let relay:Awaited<ReturnType<typeof createDesktopRelay>>;
  const central={storage:new PosixStorage(root),native:new HermesClient('http://127.0.0.1:1',token,10000,1048576),
    admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'desktop-assembly'},
    skill:'desktop-assembly',max_event_bytes:8192,max_read_bytes:8192,http:{internal_token:token,max_request_bytes:1048576,request_timeout_ms:10000}};
  const create=async(id:string)=>{
    const sessionRef={ref_type:'realtime_session',ref_id:`session-${id}`},leaseRef={ref_type:'device_lease',ref_id:`lease-${id}`},principal={opaque_ref:'owner'};
    const projection={userId:'owner',deviceId:id,deviceType:id==='mac'?'mac':'phone',capabilities:id==='mac'?['display','microphone','notifications','chat_ui','desktop_tools']:PHONE_CAPABILITIES,principal,
      policyDecisionRef:'policy',allowedMediaCapabilities:['data'],governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent'}]}};
    const current={session:{realtimeSessionRef:sessionRef,userId:'owner',continuityId:id,state:'active',continuityState:'active',connectionEpoch:'1',continuityExpiresAt:'2027-01-01T00:00:00Z',activeDeviceId:id,activeDeviceLeaseRef:leaseRef,
      binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:id,deviceId:id,connectionEpoch:'1'}},
      lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:id,userId:'owner',deviceId:id,state:'active',expiresAt:'2027-01-01T00:00:00Z',leaseVersion:'1',fencingToken:'1',purpose:'typed-submit',capabilities:['data'],policyDecisionRef:'policy'}};
    const owner=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central,deviceId:id,
      ...(owners[0]?{sharedExecution:{...owners[0].sharedExecution,desktop:relay}}:{}),
      desktopPool:{query:async()=>({rows})} as never,
      participant:{roomPort:id==='mac'?gateway:new Room(),disconnect:async()=>{}} as never,
      t03:{readCurrentAuthority:()=>projection,ownerContext:{resolve:async()=>({userId:'owner',deviceId:id,purpose:'typed-submit',capabilities:['data'],occurredAt:at})},formalWatchPrimaryAuthority:{resolve:async()=>({...projection,principalRef:principal})}} as never,
      readCurrentBinding:async()=>current as never,onError:error=>errors.push(error)});
    owners.push(owner);
    return {owner,input:{request:{request_id:`bootstrap-${id}`},bearer:{principal,deviceId:id},governance:{accepted:true},authority:{gateway:{identity:'gateway',roomName:'room'}},
      currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:id,connectionEpoch:'1',credentialRoom:'room',credentialIdentity:`credential-${id}`},enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput};
  };
  t.after(async()=>{for(const owner of owners.toReversed())await owner.bridge.close!();await relay?.close();await fs.rm(root,{recursive:true,force:true});});
  const phone=await create('phone');
  relay=await createDesktopRelay({config:{},files,runtime:phone.owner.assembly.runtime,sources:phone.owner.sharedExecution.sources,pool:{query:async()=>({rows})} as never,http:central.http,onError:error=>errors.push(error)});
  const desktop=await create('mac');
  assert.equal(desktop.owner.assembly,phone.owner.assembly);assert.equal(desktop.owner.sharedExecution.desktop,relay);
  const listener=phone.owner.assembly.server;await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const address=listener.address();assert.ok(address&&typeof address!=='string');const url=new URL(`http://127.0.0.1:${address.port}/internal/desktop/mcp`);
  const client=new Client({name:'assembled-hermes',version:'1'}),transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${token}`}}});
  t.after(()=>client.close());await client.connect(transport);
  await desktop.owner.bridge.onBootstrapConnected!(desktop.input);
  return {client,requests,formal,readiness,errors,desktop,url,gateway,transitions,stopMacConsumer:()=>mac.unregisterByteStreamHandler(DESKTOP_MCP_TOPIC)};
}

test('production owner assembly attaches a shared Mac, initializes its Swift-shaped host and forwards a desktop call',{timeout:10000},async t=>{
  const f=await assembledMac(t);await eventually(()=>f.requests.some(message=>message.method==='tools/list'));await settle();
  assert.ok(f.formal.some(message=>message.operation==='ready'));
  assert.ok(f.formal.some(message=>message.operation==='terminals'&&message.terminals.some((row:any)=>row.device_id==='mac'&&row.connected)));
  assert.deepEqual((await f.client.listTools()).tools.map(tool=>tool.name),manifest.tools.map((tool:any)=>tool.name));
  assert.deepEqual((await f.client.callTool({name:'list_allowed_directories',arguments:{}})).structuredContent,{directories:[]});
  assert.deepEqual(f.transitions.map(row=>row.transition),['attached','ready']);
  const firstPeer=f.transitions[0].peer_id;
  f.gateway.emit(RoomEvent.ParticipantDisconnected,{identity:'credential-mac'});
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
  f.gateway.emit(RoomEvent.ParticipantConnected,{identity:'credential-mac'});
  await eventually(()=>f.transitions.filter(row=>row.transition==='ready').length===2);await settle();
  assert.deepEqual((await f.client.callTool({name:'list_allowed_directories',arguments:{}})).structuredContent,{directories:[]});
  assert.equal(f.requests.filter(message=>message.method==='initialize').length,2);
  assert.deepEqual(f.transitions.map(row=>row.transition),['attached','ready','stopped','attached','ready']);
  assert.equal(f.transitions[2].reason,'detached');assert.notEqual(f.transitions[3].peer_id,firstPeer);
  assert.deepEqual(f.errors,[]);
});

test('lost Mac MCP consumer leaves formal chat ready but shared owner desktop offline after rejoin',{timeout:10000},async t=>{
  const f=await assembledMac(t);await eventually(()=>f.readiness.length===1);await settle();
  const formalReady=f.formal.filter(message=>message.operation==='ready').length,received=f.requests.length,sent:JSONRPCMessage[]=[];
  f.stopMacConsumer();
  const streamBytes=f.gateway.localParticipant.streamBytes;
  f.gateway.localParticipant.streamBytes=async(options:any)=>{
    const writer=await streamBytes(options);return {...writer,write:async(bytes:Uint8Array)=>{
      if(options.topic===DESKTOP_MCP_TOPIC)sent.push(JSON.parse(Buffer.from(bytes).toString()));await writer.write(bytes);
    }};
  };
  f.gateway.emit(RoomEvent.ParticipantDisconnected,{identity:'credential-mac'});
  f.gateway.emit(RoomEvent.ParticipantConnected,{identity:'credential-mac'});
  await eventually(()=>sent.some(message=>'method' in message&&message.method==='initialize'));await settle();
  assert.equal(f.formal.filter(message=>message.operation==='ready').length,formalReady+1);
  assert.deepEqual(f.transitions.map(row=>row.transition),['attached','ready','stopped','attached']);
  assert.equal(f.requests.length,received,'terminated Mac consumer receives no new initialize or tools/list');
  assert.equal(sent.some(message=>'method' in message&&message.method==='tools/list'),false);
  assert.deepEqual(f.readiness,[true],'the new relay peer never becomes ready');
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
  assert.deepEqual(f.errors,[]);
});

test('production Mac pause survives state sent on formal ready before desktop handler attachment',{timeout:10000},async t=>{
  const f=await assembledMac(t,true);await eventually(()=>f.requests.some(message=>message.method==='tools/list'));await settle();
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_PAUSED');
  assert.deepEqual(f.readiness,[true],'desktop readiness must follow the validated manifest');
  assert.equal(f.requests.filter(message=>message.method==='tools/call').length,0);assert.deepEqual(f.errors,[]);
});

test('synthetic per-file grant traverses real HTTP relay and bounded file receiver; denied calls send no bytes',{timeout:10000},async t=>{
  const f=await fixture(t),sim=await f.attachSimulator(),path=join(sim.root,'attached.txt'),bytes=Buffer.from('合成验收 42\n'.repeat(10000));await fs.writeFile(path,bytes);
  const call=(name:string,file=path)=>f.client.callTool({name,arguments:{path:file}});
  assert.equal(errorCode(await call('read_text_file')),'GUARD_PATH_NOT_AUTHORIZED');
  const {attachment}=await sim.host.grant(path,'drag');
  const text=await call('read_text_file');assert.deepEqual(text.content,[{type:'text',text:bytes.toString()}]);
  const uploaded=await call('upload_to_workshop'),receipt=uploaded.structuredContent as any;
  assert.equal(receipt.size,bytes.length);assert.ok(receipt.workshop_path.startsWith('/owner/in/dt-'));
  assert.deepEqual(await fs.readFile(join(sim.root,'inbox',receipt.transfer_id,'attached.txt')),bytes);
  assert.ok(sim.events.some(event=>event.step==='desktop_tool'&&event.tool==='read_text_file'&&event.outcome==='ok'));
  sim.host.revoke(attachment.grant_id);assert.equal(errorCode(await call('extract_text')),'GUARD_PATH_NOT_AUTHORIZED');
  assert.equal(errorCode(await call('upload_to_workshop')),'GUARD_PATH_NOT_AUTHORIZED');
  assert.deepEqual((await fs.readdir(join(sim.root,'inbox'))).filter(name=>name.startsWith('dt-')),[receipt.transfer_id]);
  assert.deepEqual(f.errors,[]);
});

test('desktop package receipts wrap the real HTTP relay without changing the Mac wire',{timeout:10000},async t=>{
  const f=await fixture(t,{capability:true,handler:async()=>({content:[{type:'text',text:'正文'}],structuredContent:{text:'正文'}})}),mac=await f.attachMac();
  const listed=await f.client.listTools();
  assert.equal((listed.tools[0]!.inputSchema.properties!.owner_requested as any).type,'boolean');
  const result=await f.client.callTool({name:'read_text_file',arguments:{path:'/granted/report.txt',owner_requested:true}});
  assert.equal((result.structuredContent as any).status.state,'succeeded');
  assert.equal((result.structuredContent as any).content[0].text,'正文');
  assert.equal((result.content as unknown[]).length,1);
  assert.deepEqual(mac.calls[0]!.request.params.arguments,{path:'/granted/report.txt'});
  mac.stop();
  const offline=await f.client.callTool({name:'read_text_file',arguments:{path:'/granted/report.txt'}});
  assert.equal((offline.structuredContent as any).status.reason_code,'DESKTOP_OFFLINE');
});

test('desktop package keeps per-file revocation and verified transfer receipts in the original authority',{timeout:10000},async t=>{
  const f=await fixture(t,{capability:true}),sim=await f.attachSimulator(),path=join(sim.root,'package.txt');await fs.writeFile(path,'synthetic');
  const denied=await f.client.callTool({name:'read_text_file',arguments:{path}});
  assert.equal((denied.structuredContent as any).status.reason_code,'GUARD_PATH_NOT_AUTHORIZED');
  const {attachment}=await sim.host.grant(path,'drag');
  const uploaded=await f.client.callTool({name:'upload_to_workshop',arguments:{path,owner_requested:true}}),body=uploaded.structuredContent as any;
  assert.equal(body.status.state,'succeeded');assert.equal(body.effects[0].verification,'service_ack');
  const size=body.values.find((item:any)=>item.key==='size');assert.equal(size.value,9);assert.equal(size.unit,'B');
  const transfer=body.values.find((item:any)=>item.key==='transfer_id').value;
  assert.equal((await fs.readFile(join(sim.root,'inbox',transfer,'package.txt'))).toString(),'synthetic');
  sim.host.revoke(attachment.grant_id);
  const revoked=await f.client.callTool({name:'upload_to_workshop',arguments:{path}});
  assert.equal((revoked.structuredContent as any).status.reason_code,'GUARD_PATH_NOT_AUTHORIZED');
  assert.deepEqual(f.errors,[]);
});

test('desktop package preserves first-trash refusal and timeout uncertainty',{timeout:10000},async t=>{
  let calls=0;
  const f=await fixture(t,{capability:true,handler:async()=>({isError:true,content:[],structuredContent:{error:{code:++calls===1?'GUARD_CONSENT_DENIED':'DESKTOP_TIMEOUT'}}})});
  await f.attachMac();
  const denied=await f.client.callTool({name:'trash',arguments:{paths:['/granted/report.txt']}}),timeout=await f.client.callTool({name:'write_file',arguments:{path:'/granted/report.txt',content:'test'}});
  assert.equal((denied.structuredContent as any).status.state,'failed');assert.deepEqual((denied.structuredContent as any).effects,[]);
  assert.equal((timeout.structuredContent as any).status.state,'unknown');
  assert.equal((timeout.structuredContent as any).next.retry,'after_check');
  assert.equal((timeout.structuredContent as any).next.check_with,'read_text_file');
});

test('desktop config remains opt-in; I3 execution owner HTTP sees late relay initialize/list and enforces bearer, method, sessions and batches',{timeout:10000},async t=>{
  assert.equal(desktopConfiguration(undefined),undefined);assert.equal(await createDesktopRelay({config:{enabled:false}} as never),undefined);
  const f=await fixture(t,{owner:true,config:{relay:{max_sessions:1}}});assert.equal(f.client.getServerVersion()?.name,'paios-desktop');assert.equal(f.client.getServerCapabilities()?.tools?.listChanged,false);
  const resources=await fetch(new URL('/internal/resources',f.url),{headers:{authorization:`Bearer ${token}`}});
  assert.equal(resources.status,200);const snapshot=await resources.json() as any;
  assert.deepEqual(snapshot.turn,{fixture:'desktop-owner'});assert.deepEqual(snapshot.terminals.map((row:any)=>row.device_id),['phone']);
  assert.deepEqual((await f.client.listTools()).tools.map(tool=>tool.name),manifest.tools.map((tool:any)=>tool.name));
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
  const missing=await fetch(f.url,{method:'POST'});assert.equal(missing.status,401);
  assert.equal((await f.raw({}, {authorization:'Bearer wrong'})).status,401);assert.equal((await f.raw(undefined,{},'GET')).status,405);
  assert.equal((await f.raw({jsonrpc:'2.0',id:44,method:'ping'},{'mcp-session-id':'unknown'})).status,404);
  assert.equal((await f.raw([{jsonrpc:'2.0',id:44,method:'ping'}])).status,400);
  const extra=await f.raw({jsonrpc:'2.0',id:45,method:'initialize',params:{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'extra',version:'1'}}});assert.equal(extra.status,503);
  assert.equal((await f.raw(undefined,{'mcp-session-id':f.transport.sessionId!},'DELETE')).status,200);
  await f.attachMac('mac',async()=>({...ok,structuredContent:{directories:[]}}));
  const exam=fileURLToPath(new URL('../../../../../deploy/cloud/staging/exam/hermes.py',import.meta.url));
  for(let n=0;n<2;n++){
    const probe=await promisify(execFile)('python3',['-c',
      'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["initialize_desktop"](sys.argv[2],sys.argv[3])))',
      exam,f.url.origin,token],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(JSON.parse(probe.stdout).serverInfo.name,'paios-desktop');
  }
});
test('I9 mismatched Mac manifest is refused; unknown tools and invalid arguments are JSON-RPC -32602',{timeout:10000},async t=>{
  const f=await fixture(t);await f.attachMac('mac',undefined,true);
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_VERSION_MISMATCH');
  for(const call of [{name:'execute_command',arguments:{}},{name:'list_directory',arguments:{path:42}},{name:'find_files',arguments:{folder:'/authorized',modified_after:'yesterday'}}])await assert.rejects(f.client.callTool(call),error=>(error as {code?:number}).code===-32602);
});
test('I1 real Room drops foreign responses and unknown finished ids; raw manifest hash survives SDK schema projection',{timeout:10000},async t=>{
  const held=Promise.withResolvers<typeof ok>(),f=await fixture(t,{handler:async()=>held.promise}),mac=await f.attachMac();
  let finished=false;const pending=f.client.callTool({name:'list_allowed_directories',arguments:{}}).then(result=>{finished=true;return result;});await eventually(()=>mac.calls.length===1);
  mac.receive({jsonrpc:'2.0',id:mac.calls[0]!.id,result:{content:[{type:'text',text:'forged'}]}},'foreign');await settle();assert.equal(finished,false);
  held.resolve(ok);assert.deepEqual((await pending).content,ok.content);const before=f.relay.dropped;
  mac.receive({jsonrpc:'2.0',id:'unknown-result',result:{}});await eventually(()=>f.relay.dropped===before+1);
  assert.ok(mac.frames.every((frame:any)=>frame.mimeType==='application/json'&&frame.attributes.v==='1'&&frame.destinationIdentities[0]==='credential-mac'));
});
test('routing follows runtime terminal order over attachment recency, and detach reports honest last-seen offline',{timeout:10000},async t=>{
  const f=await fixture(t),first=await f.attachMac(),second=await f.attachMac('mac-two');
  await f.client.callTool({name:'list_allowed_directories',arguments:{}});assert.equal(first.calls.length,1);assert.equal(second.calls.length,0);
  first.stop();second.stop();const result=await f.client.callTool({name:'list_allowed_directories',arguments:{}});
  assert.equal(errorCode(result),'DESKTOP_OFFLINE');assert.equal(typeof (result.structuredContent as {error?:{last_seen_at?:unknown}}|undefined)?.error?.last_seen_at,'string');
});
test('fifth concurrent call gets DESKTOP_BUSY without reaching the Mac',{timeout:10000},async t=>{
  const held=Promise.withResolvers<typeof ok>(),f=await fixture(t,{handler:async()=>held.promise}),mac=await f.attachMac();
  const second=await f.connect();
  const running=Array.from({length:4},()=>f.client.callTool({name:'list_allowed_directories',arguments:{}}));await eventually(()=>mac.calls.length===4);
  assert.equal(errorCode(await second.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_BUSY');assert.equal(mac.calls.length,4);
  held.resolve(ok);for(const result of await Promise.all(running))assert.deepEqual(result.content,ok.content);
});
test('manifest deadline cancels the exact Mac request and returns DESKTOP_TIMEOUT',{timeout:10000},async t=>{
  const arrived=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>(),f=await fixture(t,{handler:async(_request,extra)=>{arrived.resolve();await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>{cancelled.resolve();resolve();},{once:true}));return ok;}}),mac=await f.attachMac();
  t.mock.timers.enable({apis:['setTimeout']});const result=f.client.callTool({name:'list_allowed_directories',arguments:{}});await arrived.promise;t.mock.timers.tick(10000);
  assert.equal(errorCode(await result),'DESKTOP_TIMEOUT');await cancelled.promise;t.mock.timers.reset();
  assert.ok(mac.messages.some((message:any)=>message.method==='notifications/cancelled'&&message.params.requestId===mac.calls[0]!.id));
});
test('HTTP request abort propagates notifications/cancelled without a Hermes cancellation notification',{timeout:10000},async t=>{
  const arrived=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>(),f=await fixture(t,{handler:async(_request,extra)=>{arrived.resolve();await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>{cancelled.resolve();resolve();},{once:true}));return ok;}}),mac=await f.attachMac(),abort=new AbortController();
  const response=f.raw({jsonrpc:'2.0',id:'http-abort',method:'tools/call',params:{name:'list_allowed_directories',arguments:{}}},{'mcp-session-id':f.transport.sessionId!},'POST',abort.signal).catch(error=>error);
  await arrived.promise;abort.abort();await response;await cancelled.promise;
  assert.ok(mac.messages.some((message:any)=>message.method==='notifications/cancelled'&&message.params.requestId===mac.calls[0]!.id));
});
test('elicitation traverses both MCP SDK sessions using the actual related Mac request id',{timeout:10000},async t=>{
  const f=await fixture(t,{handler:async(_request,extra,server)=>{const answer=await server.elicitInput({mode:'form',message:'允许移到废纸篓？',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':extra.requestId}});assert.equal(answer.action,'accept');return ok;}});
  const requests:unknown[]=[];f.client.setRequestHandler(ElicitRequestSchema,async request=>{requests.push(request);return {action:'accept',content:{}};});
  await f.attachMac();assert.deepEqual((await f.client.callTool({name:'trash',arguments:{paths:['/authorized/synthetic.txt']}})).content,ok.content);assert.equal(requests.length,1);
});
test('I4 terminal revoke cancels in-flight calls as REVOKED and subsequent calls become OFFLINE',{timeout:10000},async t=>{
  const arrived=Promise.withResolvers<void>(),f=await fixture(t,{handler:async(_request,extra)=>{arrived.resolve();await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>resolve(),{once:true}));return ok;}});await f.attachMac();
  const pending=f.client.callTool({name:'list_allowed_directories',arguments:{}});await arrived.promise;const receipts:unknown[]=[];
  await f.relay.extensions[0]!.handle('terminal_revoke',{operation:'terminal_revoke',control_id:'revoke-mac',device_id:'mac'},f.source('phone'),async body=>{receipts.push(body);});
  assert.equal(errorCode(await pending),'DESKTOP_REVOKED');assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
  assert.ok(receipts.some((body:any)=>body.operation==='terminal_receipt'&&body.ok===true));
});
test('I13 pause cancels active calls and blocks reads; resume restores the existing connection',{timeout:10000},async t=>{
  let block=true;const arrived=Promise.withResolvers<void>(),f=await fixture(t,{handler:async(_request,extra)=>{if(block){block=false;arrived.resolve();await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>resolve(),{once:true}));}return ok;}}),mac=await f.attachMac();
  const pending=f.client.callTool({name:'list_allowed_directories',arguments:{}});await arrived.promise;
  await f.relay.pause('owner','mac',true);assert.equal(errorCode(await pending),'DESKTOP_PAUSED');assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_PAUSED');
  await f.relay.pause('owner','mac',false);assert.equal(f.relay.paused('mac'),false);assert.deepEqual((await f.client.callTool({name:'list_allowed_directories',arguments:{}})).content,ok.content);assert.equal(mac.calls.length,2);
  assert.ok(mac.messages.some((message:any)=>message.method==='notifications/paios/pause'&&message.params.paused===false));
});

for(const declared of [1048577,5242880])test(`frame cap rejects ${declared}-byte Mac headers before aggregate budget`,{timeout:10000},async t=>{
  const f=await fixture(t,{handler:async(_request,extra)=>{await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>resolve(),{once:true}));return ok;}}),mac=await f.attachMac();
  if(declared===1048577){
    const response=await f.raw({jsonrpc:'2.0',id:'large-http',method:'tools/call',params:{name:'write_file',arguments:{path:'/authorized/test',content:'x'.repeat(1048576)}}},{'mcp-session-id':f.transport.sessionId!});
    assert.equal(response.status,413);assert.equal(mac.calls.length,0);
  }
  const pending=f.client.callTool({name:'list_allowed_directories',arguments:{}});await eventually(()=>mac.calls.length===1);
  mac.receive({jsonrpc:'2.0',id:mac.calls[0]!.id,result:ok},undefined,declared);
  assert.equal(errorCode(await pending),'DESKTOP_FRAME_TOO_LARGE');
  assert.equal(f.errors.some((error:any)=>error.code==='DESKTOP_INBOUND_BUDGET'),false);
  await eventually(()=>mac.disconnects===1);
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
});
test('idle sessions expire with 404 and release their bounded session slot',{timeout:10000},async t=>{
  const f=await fixture(t,{config:{relay:{max_sessions:1,session_idle_s:1}}}),old=f.transport.sessionId!;
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(1001);
  assert.equal((await f.raw({jsonrpc:'2.0',id:'old-ping',method:'ping'},{'mcp-session-id':old})).status,404);
  const next=await f.connect();assert.notEqual(next.transport.sessionId,old);assert.deepEqual(await next.client.ping(),{});
  t.mock.timers.reset();
});
test('deleting a Hermes session cancels its exact Mac request and makes the session unknown',{timeout:10000},async t=>{
  const f=await fixture(t,{handler:async(_request,extra)=>{await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>resolve(),{once:true}));return ok;}}),mac=await f.attachMac();
  const abort=new AbortController(),pending=f.client.callTool({name:'list_allowed_directories',arguments:{}},undefined,{signal:abort.signal}).catch(error=>error);await eventually(()=>mac.calls.length===1);
  const session=f.transport.sessionId!;assert.equal((await f.raw(undefined,{'mcp-session-id':session},'DELETE')).status,200);
  await eventually(()=>mac.calls[0]!.signal.aborted);abort.abort();await pending;
  assert.equal((await f.raw({jsonrpc:'2.0',id:'deleted-ping',method:'ping'},{'mcp-session-id':session})).status,404);
});
test('I8 declined elicitation returns unchanged through both MCP sessions and performs no trash',{timeout:10000},async t=>{
  let trashed=false;const denied={isError:true,content:[{type:'text' as const,text:'GUARD_CONSENT_DENIED：主人没有同意'}],structuredContent:{error:{code:'GUARD_CONSENT_DENIED',retryable:false}}};
  const f=await fixture(t,{handler:async(_request,extra,server)=>{const answer=await server.elicitInput({mode:'form',message:'允许移到废纸篓？',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':extra.requestId}});if(answer.action==='accept'){trashed=true;return ok;}assert.equal(answer.action,'decline');return denied;}});
  f.client.setRequestHandler(ElicitRequestSchema,async()=>({action:'decline'}));await f.attachMac();
  assert.deepEqual(await f.client.callTool({name:'trash',arguments:{paths:['/authorized/synthetic.txt']}}),denied);assert.equal(trashed,false);
});
test('I11 upload result is held until its matching file completes and retains its in-flight budget',{timeout:10000},async t=>{
  const transfer={transfer_id:'dt-00000000-0000-7000-8000-000000000001',size:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'};
  const f=await fixture(t,{config:{relay:{max_inflight_per_device:1}},handler:async()=>({...ok,structuredContent:transfer})}),mac=await f.attachMac();
  let finished=false;const pending=f.client.callTool({name:'upload_to_workshop',arguments:{path:'/authorized/synthetic.txt'}}).then(result=>{finished=true;return result;});
  await eventually(()=>mac.calls.length===1);await settle();assert.equal(finished,false);
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_BUSY');assert.equal(mac.calls.length,1);
  const streamId='integrated-upload';mac.room.handleStreamHeader({streamId,topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',totalLength:3n,timestamp:0n,
    attributes:{v:'1',dir:'up',transfer:transfer.transfer_id,name:'synthetic.txt',size:'3',sha256:transfer.sha256,request:String(mac.calls[0]!.id)},contentHeader:{case:'byteHeader',value:{name:'synthetic.txt'}}},'credential-mac');
  mac.room.handleStreamChunk({streamId,content:Buffer.from('abc'),chunkIndex:0n});mac.room.handleStreamTrailer({streamId});
  assert.deepEqual((await pending).structuredContent,{...transfer,workshop_path:`/owner/in/${transfer.transfer_id}/synthetic.txt`});
  await f.client.callTool({name:'list_allowed_directories',arguments:{}});assert.equal(mac.calls.length,2);
});

test('I19 REVIEW: cancellation before a blocked tools/call frame is delivered must prevent later execution',{timeout:10000},async t=>{
  let effects=0;
  const f=await fixture(t,{handler:async()=>{effects++;return ok;}}),mac=await f.attachMac();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  t.after(()=>release.resolve());
  const original=mac.room.localParticipant.streamBytes;
  mac.room.localParticipant.streamBytes=async(options:any)=>{
    const writer=await original(options);
    return {...writer,write:async(bytes:Uint8Array)=>{
      const message=JSON.parse(Buffer.from(bytes).toString());
      if(message.method==='tools/call'){entered.resolve();await release.promise;}
      await writer.write(bytes);
    }};
  };
  const abort=new AbortController();
  const response=f.raw({jsonrpc:'2.0',id:'blocked-write',method:'tools/call',params:{name:'write_file',arguments:{path:'/authorized/synthetic.txt',content:'synthetic'}}},{'mcp-session-id':f.transport.sessionId!},'POST',abort.signal).then(reply=>reply.text()).catch(()=>{});
  await entered.promise;abort.abort();await response;
  await eventually(()=>mac.disconnects===1);
  release.resolve();await settle();
  t.diagnostic(JSON.stringify({order:mac.messages.filter((message:any)=>message.method==='tools/call'||message.method==='notifications/cancelled').map((message:any)=>message.method),effects}));
  assert.equal(effects,0,'a frame cancelled before delivery still executed a write');
});

test('REVIEW: sessions reusing an HTTP request id keep responses isolated when Mac replies in reverse order',{timeout:10000},async t=>{
  const a=Promise.withResolvers<CallToolResult>(),b=Promise.withResolvers<CallToolResult>();
  const f=await fixture(t,{handler:async request=>request.params.arguments?.path==='/authorized/a'?a.promise:b.promise}),mac=await f.attachMac(),second=await f.connect();
  const request=(sid:string,path:string)=>f.raw({jsonrpc:'2.0',id:71,method:'tools/call',params:{name:'read_text_file',arguments:{path}}},{'mcp-session-id':sid}).then(reply=>reply.text());
  const one=request(f.transport.sessionId!,'/authorized/a'),two=request((second.transport as any).sessionId,'/authorized/b');
  await eventually(()=>mac.calls.length===2);
  b.resolve({content:[{type:'text',text:'session-b'}]});a.resolve({content:[{type:'text',text:'session-a'}]});
  const result=await Promise.all([one,two]);
  assert.match(result[0]!,/session-a/);assert.doesNotMatch(result[0]!,/session-b/);
  assert.match(result[1]!,/session-b/);assert.doesNotMatch(result[1]!,/session-a/);
  assert.notEqual(mac.calls[0]!.id,mac.calls[1]!.id);
});

test('REVIEW: elicitation without a live related call cannot obtain phone approval',{timeout:10000},async t=>{
  const f=await fixture(t),mac=await f.attachMac();let approvals=0;
  f.client.setRequestHandler(ElicitRequestSchema,async()=>{approvals++;return {action:'accept',content:{}};});
  await assert.rejects(mac.server.elicitInput({mode:'form',message:'synthetic request',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':99999}}),error=>(error as {code?:number}).code===-32602);
  assert.equal(approvals,0);
});

test('REVIEW: crafted transfer injection and foreign desktop capabilities are rejected',{timeout:10000},async t=>{
  const f=await fixture(t),mac=await f.attachMac();
  await assert.rejects(f.client.callTool({name:'save_from_workshop',arguments:{workshop_path:'/workshop/desktop-out/file',_transfer:{size:0}}}),error=>(error as {code?:number}).code===-32602);
  for(const type of ['phone','glasses']){
    const ctx={...mac.ctx,device:{...mac.ctx.device,device_id:'crafted-'+type,device_type:type,capabilities:['desktop_tools']}} as WireAttachment;
    assert.throws(()=>f.relay.extensions[1]!.attach!(ctx),/TERMINAL_CAPABILITY_DENIED/);
  }
  assert.equal(mac.calls.length,0);
});

test('REVIEW: fresh revalidation rejects a revoked attached credential before forwarding',{timeout:10000},async t=>{
  const f=await fixture(t),mac=await f.attachMac();
  f.rows.find(row=>row.device_id==='mac')!.status='revoked';
  const result=await f.client.callTool({name:'list_allowed_directories',arguments:{}});
  assert.equal(errorCode(result),'DESKTOP_REVOKED');assert.equal(mac.calls.length,0);assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
});

test('REVIEW: consent timeout aborts the Mac call without executing the action',{timeout:10000},async t=>{
  const asked=Promise.withResolvers<void>();let effects=0;
  const f=await fixture(t,{handler:async(_request,extra,server)=>{
    const answer=await server.elicitInput({mode:'form',message:'Synthetic first consent',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':extra.requestId}},{signal:extra.signal,timeout:330000});
    if(answer.action==='accept')effects++;return ok;
  }}),mac=await f.attachMac();
  f.client.setRequestHandler(ElicitRequestSchema,async(_request,extra)=>{
    asked.resolve();await new Promise<void>(resolve=>extra.signal.addEventListener('abort',()=>resolve(),{once:true}));return {action:'decline'};
  });
  t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());
  const result=f.client.callTool({name:'trash',arguments:{paths:['/authorized/synthetic.txt']}},undefined,{timeout:330000});
  await asked.promise;await settle();t.mock.timers.tick(300000);
  assert.equal(errorCode(await result),'DESKTOP_TIMEOUT');await settle();
  assert.equal(effects,0);assert.ok(mac.calls[0]!.signal.aborted);
  t.mock.timers.reset();
});

test('I20 reserves slots before consumption and detaches persistent excess',{timeout:10000},async t=>{
  const f=await fixture(t),mac=await f.attachMac();await settle();
  const partial=()=>mac.receive({jsonrpc:'2.0',method:'notifications/test'},undefined,1000);
  for(let n=0;n<8;n++)partial();assert.equal(mac.room.byteStreamControllers.size,8);
  partial();await settle();assert.equal(mac.room.byteStreamControllers.size,8);assert.equal(mac.disconnects,0);
  assert.ok(f.errors.some((error:any)=>error.code==='DESKTOP_INBOUND_BUDGET'));
  partial();partial();await eventually(()=>mac.disconnects===1);assert.equal(mac.room.byteStreamControllers.size,0);
  assert.equal(errorCode(await f.client.callTool({name:'list_allowed_directories',arguments:{}})),'DESKTOP_OFFLINE');
});
test('I20 reserves frame bytes before reading and releases completed reservations',{timeout:10000},async t=>{
  const f=await fixture(t,{config:{relay:{max_inbound_frame_bytes:1048576}}}),mac=await f.attachMac();await settle();
  const message={jsonrpc:'2.0' as const,method:'notifications/test',params:{padding:'x'.repeat(600000)}},bytes=Buffer.from(JSON.stringify(message));
  const first=mac.receive(message,undefined,bytes.length);mac.receive(message,undefined,bytes.length);await settle();assert.equal(mac.room.byteStreamControllers.size,1);assert.equal(mac.disconnects,0);
  mac.room.handleStreamChunk({streamId:first,content:bytes,chunkIndex:0n});mac.room.handleStreamTrailer({streamId:first});await settle();
  const before=f.errors.length;mac.receive(message,undefined,bytes.length);await settle();assert.equal(mac.room.byteStreamControllers.size,1);assert.equal(f.errors.length,before);
});
test('stalled frame writer times out and never completes late',{timeout:10000},async t=>{
  let effects=0;const f=await fixture(t,{config:{relay:{write_timeout_ms:25}},handler:async()=>{effects++;return ok;}}),mac=await f.attachMac();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();t.after(()=>release.resolve());const original=mac.room.localParticipant.streamBytes;
  mac.room.localParticipant.streamBytes=async(options:any)=>{const writer=await original(options);return {...writer,write:async(bytes:Uint8Array)=>{entered.resolve();await release.promise;await writer.write(bytes);}};};
  const pending=f.client.callTool({name:'write_file',arguments:{path:'/authorized/test',content:'test'}});await entered.promise;
  assert.equal(errorCode(await pending),'DESKTOP_TIMEOUT');await eventually(()=>mac.disconnects>=1);release.resolve();await settle();assert.equal(effects,0);assert.equal(mac.messages.filter((message:any)=>message.method==='tools/call').length,0);
});
for(const mode of ['cancel','stall'])test(`file writer ${mode} never closes or writes a second chunk; response waits for delivery`,{timeout:10000},async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let writes=0,closes=0,finished=false;
  const f=await fixture(t,{config:{relay:{write_timeout_ms:mode==='stall'?25:10000}},prepareDownload:async()=>({transfer:{transfer_id:'dt-00000000-0000-7000-8000-000000000001',size:2,sha256:'0'.repeat(64)},name:'test',attributes:request=>({v:'1',dir:'down',transfer:'dt-00000000-0000-7000-8000-000000000001',name:'test',size:'2',sha256:'0'.repeat(64),request}),send:async write=>{await write(Buffer.from('a'));await write(Buffer.from('b'));},close:async()=>{}})}),mac=await f.attachMac();
  t.after(()=>release.resolve());const original=mac.room.localParticipant.streamBytes;
  mac.room.localParticipant.streamBytes=async(options:any)=>options.topic===DESKTOP_FILE_TOPIC?{write:async()=>{writes++;entered.resolve();await release.promise;},close:async()=>{closes++;}}:original(options);
  // Keep the pending-response assertion independent of host load and advance only the actual writer deadline.
  if(mode==='stall')t.mock.timers.enable({apis:['setTimeout']});
  const abort=new AbortController(),pending=f.client.callTool({name:'save_from_workshop',arguments:{workshop_path:'/owner/out/'+'a'.repeat(32)+'/test'}},undefined,{signal:abort.signal}).then(result=>{finished=true;return result;}).catch(error=>error);
  await entered.promise;await settle();assert.equal(finished,false);if(mode==='cancel')abort.abort();else t.mock.timers.tick(25);
  const result=await pending;if(mode==='stall'){assert.equal(errorCode(result),'DESKTOP_TIMEOUT');t.mock.timers.reset();}await eventually(()=>mac.disconnects>=1);release.resolve();await settle();assert.equal(writes,1);assert.equal(closes,0);
});


test('I20 foreign header burst never reserves the attached Mac budget or causes its detach',{timeout:10000},async t=>{
  const f=await fixture(t),mac=await f.attachMac();await settle();
  for(let n=0;n<16;n++)mac.receive({jsonrpc:'2.0',method:'notifications/test'},'foreign',1048576);
  for(let n=0;n<3;n++)mac.receive({jsonrpc:'2.0',id:'unknown-'+n,result:{}});
  await settle();assert.equal(mac.disconnects,0);assert.equal(mac.room.byteStreamControllers.size,0);
  assert.equal(f.errors.some((error:any)=>error.code==='DESKTOP_INBOUND_BUDGET'),false);
  assert.deepEqual((await f.client.callTool({name:'list_allowed_directories',arguments:{}})).content,ok.content);
});
for(const mode of ['cancel','deadline'])test(`blocked stream open ${mode} retires connection before late writer arrives`,{timeout:10000},async t=>{
  let effects=0;const f=await fixture(t,{config:{relay:{write_timeout_ms:mode==='deadline'?25:10000}},handler:async()=>{effects++;return ok;}}),mac=await f.attachMac();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();t.after(()=>release.resolve());const original=mac.room.localParticipant.streamBytes;let gated=false;
  mac.room.localParticipant.streamBytes=async(options:any)=>{if(!gated){gated=true;entered.resolve();await release.promise;}return original(options);};
  const abort=new AbortController(),pending=f.client.callTool({name:'write_file',arguments:{path:'/authorized/test',content:'test'}},undefined,{signal:abort.signal}).catch(error=>error);
  await entered.promise;if(mode==='cancel')abort.abort();const result=await pending;
  if(mode==='deadline')assert.equal(errorCode(result),'DESKTOP_TIMEOUT');await eventually(()=>mac.disconnects===1);
  release.resolve();await settle();assert.equal(effects,0);assert.equal(mac.messages.some((message:any)=>message.method==='tools/call'),false);
});
test('fixture departure drops a delayed close after call cancellation; no SDK delivery guarantee asserted',{timeout:10000},async t=>{
  let effects=0;const f=await fixture(t,{handler:async()=>{effects++;return ok;}}),mac=await f.attachMac();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();t.after(()=>release.resolve());const original=mac.room.localParticipant.streamBytes;
  mac.room.localParticipant.streamBytes=async(options:any)=>{const writer=await original(options);let request=false;return {
    write:async(bytes:Uint8Array)=>{request=JSON.parse(Buffer.from(bytes).toString()).method==='tools/call';await writer.write(bytes);},
    close:async()=>{if(request){entered.resolve();await release.promise;}await writer.close();}};};
  const abort=new AbortController(),pending=f.client.callTool({name:'write_file',arguments:{path:'/authorized/test',content:'test'}},undefined,{signal:abort.signal}).catch(error=>error);
  await entered.promise;abort.abort();await pending;await eventually(()=>mac.disconnects===1);release.resolve();await settle();
  assert.equal(effects,0);assert.equal(mac.messages.some((message:any)=>message.method==='tools/call'),false);
});


test('A4.9 refuses non-trash Mac elicitation before reaching the approval consumer',{timeout:10000},async t=>{
  const f=await fixture(t,{handler:async(_request,extra,server)=>{
    await assert.rejects(server.elicitInput({mode:'form',message:'Confirm write',requestedSchema:{type:'object',properties:{}},_meta:{'paios/relatedRequestId':extra.requestId}}),error=>(error as {code?:number}).code===-32602);return ok;
  }});let approvals=0;f.client.setRequestHandler(ElicitRequestSchema,async()=>{approvals++;return {action:'accept'};});
  await f.attachMac();assert.deepEqual((await f.client.callTool({name:'write_file',arguments:{path:'/authorized/synthetic.txt',content:'synthetic'}})).content,ok.content);assert.equal(approvals,0);
});

test('A4.5 manifest-ready attach and reconnect admit one durable queued run through the real runtime',{timeout:10000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'desktop-ready-runtime-')),storage=new PosixStorage(root),created:any[]=[],runs=new Map<string,NativeRun>();
  const native={create:async(body:{session_id:string;input:string})=>{created.push(JSON.parse(body.input));const run={run_id:`run-${created.length}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async(id:string)=>runs.get(id)!,cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'relay-ready'});
  let f!:Awaited<ReturnType<typeof fixture>>;
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),skill:'fixed',max_read_bytes:8192,
    sourceAuthority:{authenticate:async credential=>f.source(String(credential)),revalidate:async source=>{assert.equal(f.rows.find(row=>row.device_id===source.device_id)?.status,'active');return source;}}});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  f=await fixture(t,{runtime});t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const phone=await runtime.authenticate('phone'),raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:'owner-queue-request',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'rtc_typed_text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('整理电脑发票')};
  const accepted=await runtime.submit(raw,phone,'queue-owner-session',true);await eventually(()=>!!admission.get('owner','queue-owner-session',accepted.processed_event.processed_event_id)?.run_id);
  const entry=admission.get('owner','queue-owner-session',accepted.processed_event.processed_event_id)!;
  const row=await runtime.tool('paios_desktop_queue',{context:{run_id:entry.run_id!,session_id:'queue-owner-session',tool_call_id:'queue-add'},args:{action:'add',task:'整理电脑发票'}}) as {queue_id:string};
  await f.attachMac('mac',undefined,true);await settle();assert.equal(created.length,1,'manifest mismatch must not drain queued work');
  const first=await f.attachMac();await eventually(()=>created.length===2);assert.equal(created[1].content.app_event.queue_id,row.queue_id);assert.equal(created[1].device_id,'mac');
  first.stop();await f.attachMac();await settle();assert.equal(created.length,2,'reconnect must reuse durable admission');assert.deepEqual(f.errors,[]);
});


test('A4.5 revalidates source after manifest handshake before notifying runtime',{timeout:10000},async t=>{
  let f!:Awaited<ReturnType<typeof fixture>>,ready=0;
  f=await fixture(t,{runtime:{time_zone:'UTC',terminals:()=>[],desktopReady:async()=>{ready++;}},onManifest:()=>{f.rows.find(row=>row.device_id==='mac')!.status='revoked';}});
  await f.attachMac();await settle();assert.equal(ready,0);assert.ok(f.errors.some(error=>(error as Error).message==='PAIRED_DEVICE_REVOKED'));
});


test('window capture sends JPEG only to existing structured vision and returns no image to Hermes',{timeout:10000},async t=>{
  const image=Buffer.from('synthetic JPEG'),metadata={window_id:42,title:'Shared document',width:800,height:600};
  let analyzed=0;
  const f=await fixture(t,{handler:async()=>({content:[{type:'image',mimeType:'image/jpeg',data:image.toString('base64')}],structuredContent:metadata}),
    analyzeVision:async(bytes,request,signal)=>{analyzed++;assert.deepEqual(bytes,image);assert.ok(signal);assert.equal(signal.aborted,false);
      assert.equal(typeof request,'object');assert.equal((request as {prompt:string}).prompt,'What does the chart show?');
      assert.deepEqual((request as {response_schema:unknown}).response_schema,{type:'object',properties:{description:{type:'string'}},required:['description'],additionalProperties:false});
      return JSON.stringify({description:'Sales increased.'});}});
  const mac=await f.attachMac();
  const result=await f.client.callTool({name:'window_capture',arguments:{question:'What does the chart show?'}});
  assert.equal(analyzed,1);assert.equal(result.isError,undefined);
  assert.deepEqual(result.content,[{type:'text',text:'{"description":"Sales increased."}'}]);
  assert.deepEqual(result.structuredContent,metadata);assert.equal(JSON.stringify(result).includes(image.toString('base64')),false);
  assert.equal(mac.calls[0]!.request.params.name,'window_capture');
});

test('window capture failure is not sent to vision and malformed success cannot reach Hermes as an image',{timeout:10000},async t=>{
  let calls=0;
  const f=await fixture(t,{handler:async()=>++calls===1?{isError:true,content:[{type:'text',text:'Sharing stopped'}]}:{content:[]}});
  await f.attachMac();
  const failed=await f.client.callTool({name:'window_capture',arguments:{question:'Read'}});assert.equal(failed.isError,true);
  const invalid=await f.client.callTool({name:'window_capture',arguments:{question:'Read'}});
  assert.equal(errorCode(invalid),'DESKTOP_CAPTURE_INVALID');assert.deepEqual(invalid.content,[{type:'text',text:'电脑返回的窗口截图无效'}]);
});

test('window capture cancellation aborts vision after the Mac image has arrived',{timeout:10000},async t=>{
  const entered=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>();
  const f=await fixture(t,{handler:async()=>({content:[{type:'image',mimeType:'image/jpeg',data:'anBlZw=='}],structuredContent:{window_id:1,title:'Shared',width:10,height:10}}),
    analyzeVision:async(_bytes,_request,signal)=>{entered.resolve();return await new Promise<string>((_resolve,reject)=>signal!.addEventListener('abort',()=>{cancelled.resolve();reject(signal!.reason);},{once:true}));}});
  await f.attachMac();const abort=new AbortController();
  const pending=f.client.callTool({name:'window_capture',arguments:{question:'Read'}},undefined,{signal:abort.signal}).catch(error=>error);
  await entered.promise;abort.abort();await cancelled.promise;await pending;
});


test('window capture reports vision failure in Chinese without publishing provider details',{timeout:10000},async t=>{
  const f=await fixture(t,{handler:async()=>({content:[{type:'image',mimeType:'image/jpeg',data:'anBlZw=='}],structuredContent:{window_id:1,title:'Shared',width:10,height:10}}),
    analyzeVision:async()=>{throw new Error('Unknown(secret)');}});
  await f.attachMac();
  const result=await f.client.callTool({name:'window_capture',arguments:{question:'Read'}});
  assert.equal(result.isError,true);assert.equal(errorCode(result),'DESKTOP_VISION_FAILED');
  assert.deepEqual(result.content,[{type:'text',text:'暂时无法分析共享窗口，请稍后再试'}]);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

for(const [zone,clock] of [['America/Los_Angeles','17:30'],['UTC','00:30'],['Asia/Taipei','08:30']] as const)
test(`desktop last-online text follows deployment ${zone}`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-10T00:30:00Z')});
  const f=await fixture(t,{time_zone:zone}),mac=await f.attachMac();mac.stop();
  const result=await f.client.callTool({name:'list_allowed_directories',arguments:{}});
  assert.equal(errorCode(result),'DESKTOP_OFFLINE');
  assert.ok(JSON.stringify(result.content).includes(`最后在线 ${clock}`),JSON.stringify(result));
});

function presentationFixture(device='mac-two') {
  const demo=JSON.parse(readFileSync(new URL('../../../../../capability/packages/meeting-assistant/tests/demo.json',import.meta.url),'utf8'));
  const target={...demo.plan.target,target_device_id:device};demo.plan.target=target;demo.plan.plan_sha256=textPlanHash(demo.plan);
  const binding={principal_id:'owner',target_device_id:device},plan=demo.plan;
  const apply={target,plan,idempotency_key:'demo-call',execution:{...binding,target_id:target.target_id,grant_id:'grant:demo',
    confirmation_id:'confirmation:demo',scope_session_id:plan.scope_session_id,operation_kind:'document.text.update' as const,
    valid_until:new Date(Date.now()+60000).toISOString(),plan_sha256:plan.plan_sha256}};
  const handler:MacHandler=async request=>{
    if(request.params.name==='presentation_snapshot')return to_mcp_result(succeeded({content:[{key:'slide_snapshot',provenance:'observed',
      text:JSON.stringify({...demo.snapshot,target,image:null})}]})) as unknown as CallToolResult;
    const state={version:1,operation_id:'op:demo',target,plan_sha256:plan.plan_sha256,revision:1,
      items:[{id:plan.edits[0].work_item_id,label:'第 2 页',state:'accepted',effect_refs:[]}],checks:[],review_status:'awaiting_owner'};
    return to_mcp_result(accepted({content:[{key:'edit_result',text:JSON.stringify(state),provenance:'observed'}]})) as unknown as CallToolResult;
  };
  return {target,binding,apply,handler};
}

test('presentation port routes all three actions to exact paired Mac and stays absent from public catalog',{timeout:10000},async t=>{
  const f=await fixture(t),p=presentationFixture();
  const active=await f.attachMac(),target=await f.attachMac('mac-two',p.handler,false,true);
  for(const [name,args] of [['presentation_snapshot',{target:p.target,shared_window_id:null}],
    ['presentation_apply_text',p.apply],['presentation_edit_status',{target:p.target,operation_id:'op:demo'}]] as const){
    const result=await f.relay.invokePresentation(p.binding,name,args as any);
    assert.equal((result.structuredContent as any).receipt,1);assert.notEqual((result.structuredContent as any).status.state,'unknown');
  }
  assert.equal(active.calls.length,0);assert.deepEqual(target.calls.map(row=>row.request.params.name),presentationTools.map((tool:any)=>tool.name));
  const listed=await f.client.listTools();assert.equal(listed.tools.some(tool=>tool.name.startsWith('presentation_')),false);
  await assert.rejects(f.client.callTool({name:'presentation_apply_text',arguments:p.apply}),/platform target binding/);
  assert.equal(target.calls.length,3);assert.deepEqual(f.errors,[]);
});

test('bound presentation never falls back for offline, wrong principal, old version, paused or revoked Mac',{timeout:10000},async t=>{
  const f=await fixture(t),p=presentationFixture(),active=await f.attachMac();
  const snapshot=()=>f.relay.invokePresentation(p.binding,'presentation_snapshot',{target:p.target,shared_window_id:null});
  assert.equal((await snapshot()).structuredContent!.status && ((await snapshot()).structuredContent as any).status.reason_code,'DESKTOP_OFFLINE');
  const wrong=await f.relay.invokePresentation({...p.binding,principal_id:'intruder'},'presentation_snapshot',{target:p.target,shared_window_id:null});
  assert.equal((wrong.structuredContent as any).status.reason_code,'DESKTOP_REVOKED');
  const old=await f.attachMac('mac-two');assert.equal(((await snapshot()).structuredContent as any).status.reason_code,'DESKTOP_VERSION_MISMATCH');
  assert.equal(old.calls.length,0);old.stop();
  const target=await f.attachMac('mac-two',p.handler,false,true);
  await f.relay.pause('owner','mac-two',true);assert.equal(((await snapshot()).structuredContent as any).status.reason_code,'DESKTOP_PAUSED');
  await f.relay.pause('owner','mac-two',false);f.rows.find(row=>row.device_id==='mac-two')!.status='revoked';
  assert.equal(((await snapshot()).structuredContent as any).status.reason_code,'DESKTOP_REVOKED');
  assert.equal(active.calls.length,0);assert.equal(target.calls.length,0);assert.deepEqual(f.errors,[]);
});

test('invalid execution binding and cancelled requests deliver zero bytes to either Mac',{timeout:10000},async t=>{
  const f=await fixture(t),p=presentationFixture(),active=await f.attachMac(),target=await f.attachMac('mac-two',p.handler,false,true);
  await assert.rejects(f.relay.invokePresentation({...p.binding,target_device_id:'mac'},'presentation_apply_text',p.apply),/DEVICE_MISMATCH/);
  const abort=new AbortController();abort.abort();const result=await f.relay.invokePresentation(p.binding,'presentation_apply_text',p.apply,abort.signal);
  assert.equal((result.structuredContent as any).status.reason_code,'DESKTOP_CANCELLED');
  assert.equal(active.calls.length,0);assert.equal(target.calls.length,0);assert.deepEqual(f.errors,[]);
});
