import {watchPresentationContext} from './presentation-context.ts';
import {readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CallToolRequestSchema,ElicitRequestSchema,ListToolsRequestSchema,JSONRPCMessageSchema,McpError,ErrorCode,isInitializeRequest,type JSONRPCMessage,type RequestId,type CallToolRequest,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {RoomEvent} from '@livekit/rtc-node';
import {check,ContractError,digest} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {HermesClient} from '../../../services/personal-aios-integration/src/hermes-client.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import {hasTerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {FormalTerminalSources} from './personal-aios-formal-source.ts';
import {readActivePairedDevices} from './paired-device-authority.ts';
import {createTerminalWire,type WireExtension,type WireAttachment} from './personal-aios-terminal-wire.ts';
import {createDesktopFiles,DESKTOP_FILE_TOPIC,type DesktopTransfer} from './desktop-files.ts';
import {consumeBoundedByteStream} from './sdk-room.ts';
import {desktopPackage,type PackageCatalogPort} from '../../../../../capability/packages/desktop/server/package.ts';
import {presentationSchema,presentationTools,validatePresentationInput,type DesktopTargetBinding} from './presentation-validate.ts';
import type {PresentationAction,PresentationInputs} from '../../../../../capability/contracts/presentation.ts';
import {presentationResult} from './presentation-relay.ts';

// SDK 1.25.3 expects this fetch alias; Node exposes RequestInit but omits the alias.
declare global {type HeadersInit=NonNullable<RequestInit['headers']>}
export const DESKTOP_MCP_TOPIC='paios.desktop.mcp.v1';
const defaults={enabled:true,relay:{max_frame_bytes:1048576,max_inflight_per_device:4,max_sessions:8,session_idle_s:3600,write_timeout_ms:10000,max_inbound_streams:8,max_inbound_frame_bytes:4194304},
  files:{enabled:true,upload_enabled:true,max_file_bytes:26214400,daily_upload_bytes:209715200,inbox_total_bytes:268435456,out_total_bytes:268435456,snapshot_total_bytes:268435456,inbox_ttl_s:7200,save_max_file_bytes:52428800,keep_workshop_copies:false},queue:{max_pending:8,default_ttl_min:720,max_ttl_min:1440}};
export type DesktopConfig=typeof defaults;
export function desktopConfiguration(value:unknown):DesktopConfig|undefined {
  if(value===undefined)return undefined;check(value&&typeof value==='object'&&!Array.isArray(value),'DESKTOP_CONFIGURATION_INVALID');
  const input=value as Record<string,unknown>;check(Object.keys(input).every(key=>Object.hasOwn(defaults,key)),'DESKTOP_CONFIGURATION_INVALID');
  const config=structuredClone(defaults);if(input.enabled!==undefined){check(typeof input.enabled==='boolean','DESKTOP_CONFIGURATION_INVALID');config.enabled=input.enabled;}
  for(const group of ['relay','files','queue'] as const)if(input[group]!==undefined){const fields=input[group];check(fields&&typeof fields==='object'&&!Array.isArray(fields),'DESKTOP_CONFIGURATION_INVALID');
    for(const [key,field] of Object.entries(fields)){const model=(defaults[group] as Record<string,unknown>)[key];check(model!==undefined&&typeof field===typeof model&&(typeof field!=='number'||Number.isSafeInteger(field)&&field>0),'DESKTOP_CONFIGURATION_INVALID');Object.assign(config[group],{[key]:field});}}
  check(config.relay.max_frame_bytes<=1048576&&config.relay.max_inflight_per_device<=4&&config.relay.max_sessions<=8,'DESKTOP_CONFIGURATION_INVALID');return config;
}
const bytes=readFileSync(new URL('../../../../../integrations/contracts/desktop-tools.v1.json',import.meta.url));
check(createHash('sha256').update(bytes).digest('hex')==='1e11cfdba142bee678fddb82a4ad8484f8274be408ef8221ed44ef35e9434d68','DESKTOP_TOOLS_CONTRACT_CHANGED');
const manifest=JSON.parse(bytes.toString('utf8')),ajv=new Ajv({strict:true});addFormats.default(ajv,['date-time']);
const tools=new Map<string,{tool:any;validate:ReturnType<Ajv['compile']>}>(manifest.tools.map((tool:any)=>[tool.name,{tool,validate:ajv.compile(tool.inputSchema)}]));
ajv.addSchema(presentationSchema);for(const tool of presentationTools)tools.set(tool.name,{tool,validate:ajv.compile(tool.inputSchema)});
const presentationHash=digest([...manifest.tools,...presentationTools]),presentationNames=new Set<string>(presentationTools.map((tool:any)=>tool.name));
const toolsHash=digest(manifest.tools),messages:Record<string,string>={DESKTOP_CAPTURE_INVALID:'电脑返回的窗口截图无效',DESKTOP_VISION_FAILED:'暂时无法分析共享窗口，请稍后再试',DESKTOP_OFFLINE:'电脑现在不在线',DESKTOP_VERSION_MISMATCH:'电脑上的依米需要更新',DESKTOP_BUSY:'电脑正在处理其他操作，稍后再试',DESKTOP_TIMEOUT:'电脑没有及时回应，结果未知',DESKTOP_CANCELLED:'操作已取消',DESKTOP_REVOKED:'这台电脑已解除配对',DESKTOP_FRAME_TOO_LARGE:'结果太大',DESKTOP_PAUSED:'主人暂停了依米操作电脑',TRANSFER_DISABLED:'传输被关闭',TRANSFER_TOO_LARGE:'文件太大',TRANSFER_QUOTA:'今日额度用完',TRANSFER_INTEGRITY:'校验失败',WORKSHOP_PATH_INVALID:'工坊路径无效',WORKSHOP_UNAVAILABLE:'工坊不可用',WORKSHOP_FILE_UNREADABLE:'工坊文件不可读，请以0644权限重新保存'};
type Files=Awaited<ReturnType<typeof createDesktopFiles>>;
type Call={key:string;tool:string;id:RequestId;server:Server|undefined;abort:AbortController;timer?:ReturnType<typeof setTimeout>;input:number;output:number;delivery?:Promise<void>;upload?:ReturnType<ReturnType<Files['attach']>['expectUpload']>;download?:Awaited<ReturnType<Files['prepareDownload']>>};
type Peer={ctx:WireAttachment;client:Client;active:boolean;paused:boolean;state:'initializing'|'ready'|'version_mismatch';listHash?:string;ids:Map<RequestId,{method:string;call?:Call}>;calls:Set<Call>;file:ReturnType<Files['attach']>;stop:(code:string,reason:string)=>void;setPaused:(paused:boolean)=>void};
export async function createDesktopRelay(options:{config:unknown;analyzeVision:HermesClient['analyzeVision'];runtime:Pick<PersonalAIOSRuntime,'terminals'|'desktopReady'|'time_zone'>&Partial<Pick<PersonalAIOSRuntime,'meetingDesktopContext'|'meetingDesktopDisconnected'>>;sources:Pick<FormalTerminalSources,'revalidate'>;pool:Parameters<typeof readActivePairedDevices>[0];http:Parameters<typeof import('../../../services/personal-aios-integration/src/server.ts').createPersonalAIOSServer>[1];onError:(error:unknown)=>void;files?:Files;capabilityCatalog?:PackageCatalogPort}) {
  const config=desktopConfiguration(options.config);if(!config?.enabled)return undefined;
  const capability=desktopPackage(options.capabilityCatalog);
  const files=options.files??await createDesktopFiles({...config.files,inbox:'/var/lib/paios/desktop-in',workshop:'/var/lib/paios/desktop-out',onError:options.onError});
  const peers=new Map<string,Peer>(),calls=new Map<string,Call>(),watchers=new Set<(principal:string)=>void>(),sessions=new Map<string,{server:Server;transport:WebStandardStreamableHTTPServerTransport;calls:Map<RequestId,Call>;at:number}>();let dropped=0;
  const changed=(principal:string)=>{for(const watcher of watchers)watcher(principal);};
  const arm=(call:Call,ms:number)=>{clearTimeout(call.timer);call.timer=setTimeout(()=>call.abort.abort(new ContractError('DESKTOP_TIMEOUT',504)),ms).unref();};
  const controls={paused:(device:string)=>peers.get(device)?.paused,pause:async(principal:string,device:string,paused:boolean)=>{const peer=peers.get(device);check(peer,'DESKTOP_OFFLINE',409);check(peer.ctx.device.principal_id===principal,'TERMINAL_REVOKE_DENIED',403);peer.setPaused(paused);await peer.client.notification({method:'notifications/paios/pause',params:{paused}});},revoked:(principal:string,device:string)=>{const peer=peers.get(device);if(peer?.ctx.device.principal_id===principal)peer.stop('DESKTOP_REVOKED','revoked');},watch:(fn:(principal:string)=>void)=>{watchers.add(fn);return()=>{watchers.delete(fn);};}};
  const wire=createTerminalWire({pool:options.pool,relay:controls,onError:options.onError});
  function attach(ctx:WireAttachment):()=>void {
    if(!hasTerminalCapability(ctx.device,'desktop_tools'))return()=>{};
    check(ctx.device.device_type==='mac','TERMINAL_CAPABILITY_DENIED',403);peers.get(ctx.device.device_id)?.stop('DESKTOP_TIMEOUT','replaced');
    const client=new Client({name:'paios-desktop-relay',version:'1'},{capabilities:{elicitation:{form:{}}}}),readers=new Set<ReturnType<typeof consumeBoundedByteStream>>(),responses=new Map<RequestId,Call>();
    let stopPresentation=()=>{};
    const peerId=randomUUID(),transition=(state:string,code?:string,reason?:string)=>process.stderr.write(JSON.stringify({route:'desktop_peer',transition:state,peer_id:peerId,device_id:ctx.device.device_id,identity:ctx.identity,topic:DESKTOP_MCP_TOPIC,...(code?{code,reason}:{}),at:Date.now()})+'\n');
    const current=()=>peer.active&&ctx.current(),authorize=()=>options.sources.revalidate(ctx.device);
    const file=files.attach({principal:ctx.device.principal_id,deviceType:'mac',capabilities:ctx.device.capabilities!,identity:ctx.identity,current,authorize,room:ctx.room as never});
    const peer:Peer={ctx,client,file,active:true,paused:false,state:'initializing',ids:new Map(),calls:new Set(),stop:(code,reason)=>{retire(code,reason);void client.close().catch(options.onError);},
      setPaused:paused=>{peer.paused=paused;if(paused){for(const call of peer.calls)call.abort.abort(new ContractError('DESKTOP_PAUSED',409));void options.runtime.meetingDesktopDisconnected?.(ctx.device,'DESKTOP_PAUSED').catch(options.onError);}changed(ctx.device.principal_id);}};
    const left=(remote:unknown)=>{if((remote as {identity?:string})?.identity===ctx.identity)peer.stop('DESKTOP_TIMEOUT','participant_disconnected');};
    const retire=(code:string,reason:string)=>{if(!peer.active)return;peer.active=false;stopPresentation();void options.runtime.meetingDesktopDisconnected?.(ctx.device,code).catch(options.onError);transition('stopped',code,reason);for(const call of peer.calls)call.abort.abort(new ContractError(code,409));
      responses.clear();for(const reader of readers)reader.cancel();ctx.room.unregisterByteStreamHandler!(DESKTOP_MCP_TOPIC);file.close();ctx.room.off?.(RoomEvent.ParticipantDisconnected,left);
      if(peers.get(ctx.device.device_id)===peer)peers.delete(ctx.device.device_id);changed(ctx.device.principal_id);};
    let disconnected=false;
    const disconnect=()=>{if(!disconnected){disconnected=true;void ctx.leave().catch(options.onError);}};
    // rtc-node 0.13.32 still has no public writer.abort(); disconnect without a trailer on failed sends.
    const writeStream=async(topic:string,size:number,attributes:Record<string,string>,produce:(write:(bytes:Uint8Array)=>Promise<void>)=>Promise<void>,call?:Call,allowRetired=false)=>{
      call?.abort.signal.throwIfAborted();
      const abort=new AbortController(),fail=(reason:unknown)=>abort.abort(reason),cancel=()=>fail(call!.abort.signal.reason);
      const timer=setTimeout(()=>fail(new ContractError('DESKTOP_TIMEOUT',504)),config!.relay.write_timeout_ms).unref();
      call?.abort.signal.addEventListener('abort',cancel,{once:true});
      const interrupted=new Promise<never>((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}));
      const step=async<T>(operation:()=>Promise<T>)=>{
        abort.signal.throwIfAborted();
        check(current()||allowRetired,'DESKTOP_TIMEOUT',409);
        const result=await Promise.race([operation(),interrupted]);
        abort.signal.throwIfAborted();
        check(current()||allowRetired,'DESKTOP_TIMEOUT',409);
        return result;
      };
      try{
        const writer=await step(()=>ctx.room.localParticipant!.streamBytes!({topic,mimeType:topic===DESKTOP_MCP_TOPIC?'application/json':'application/octet-stream',totalSize:size,attributes,destinationIdentities:[ctx.identity]}));
        await step(()=>produce(bytes=>step(()=>writer.write(bytes))));
        await step(()=>writer.close());
      }catch(error){
        call?.abort.abort(error);
        peer.stop('DESKTOP_TIMEOUT','write_failed');
        disconnect();
        throw error;
      }finally{
        clearTimeout(timer);
        call?.abort.signal.removeEventListener('abort',cancel);
      }
    };
    const transport:Transport={start:async()=>{},close:async()=>{retire('DESKTOP_TIMEOUT','transport_closed');transport.onclose?.();},send:async(message,extra)=>{
      const call=(extra?.relatedRequestId===undefined?undefined:calls.get(String(extra.relatedRequestId)))??('id' in message?responses.get(message.id!):undefined),request='method' in message&&message.method==='tools/call';
      const delivery=(async()=>{if('id' in message&&message.id!==undefined&&'method' in message){const id=message.id;peer.ids.set(id,{method:message.method,...(call?{call}:{})});if(call?.download)message={...message,params:{...message.params,arguments:{...(message.params?.arguments as object),_transfer:call.download.transfer}}};
        if(call&&request&&message.params?.name==='upload_to_workshop')call.upload=file.expectUpload(String(id),call.abort.signal);}
      const frame=Buffer.from(JSON.stringify(message));check(frame.length<=config!.relay.max_frame_bytes,'DESKTOP_FRAME_TOO_LARGE',413);if(call)call.output+=frame.length;
      await writeStream(DESKTOP_MCP_TOPIC,frame.length,{v:'1'},async write=>{for(let offset=0;offset<frame.length;offset+=65536)await write(frame.subarray(offset,offset+65536));},'method' in message&&message.method==='notifications/cancelled'?undefined:call,'method' in message&&message.method==='notifications/cancelled');
      if(request&&call?.download&&'id' in message){const download=call.download;await writeStream(DESKTOP_FILE_TOPIC,download.transfer.size,download.attributes(String(message.id)),write=>download.send(write,call.abort.signal),call);}
      })();if(request&&call)call.delivery=delivery;try{await delivery;}finally{if('id' in message)responses.delete(message.id!);}
    }};
    client.fallbackNotificationHandler=async notification=>{if(notification.method!=='notifications/paios/state'){dropped++;return;}check(typeof notification.params?.paused==='boolean'&&Object.keys(notification.params).length===1,'DESKTOP_STATE_INVALID');peer.setPaused(notification.params.paused);};
    client.setRequestHandler(ElicitRequestSchema,async request=>{const related=request.params._meta?.['paios/relatedRequestId'];
      const call=(typeof related==='string'||typeof related==='number')?peer.ids.get(related)?.call:undefined;
      if(!call?.server||call.tool!=='trash'||call.abort.signal.aborted||!current())throw new McpError(ErrorCode.InvalidParams,'Only a live trash call may request consent');arm(call,300000);
      return call.server.elicitInput(request.params,{relatedRequestId:call.id,signal:call.abort.signal,timeout:300000});});
    let inboundBytes=0,excess=0;
    ctx.room.registerByteStreamHandler!(DESKTOP_MCP_TOPIC,(reader,sender)=>{
      const valid=current()&&sender.identity===ctx.identity,chunks:Buffer[]=[],reserved=Number.isSafeInteger(reader.info.totalSize)&&reader.info.totalSize!>=0?Math.min(reader.info.totalSize!,config!.relay.max_frame_bytes):config!.relay.max_frame_bytes;
      const overBudget=valid&&(readers.size>=config!.relay.max_inbound_streams||inboundBytes+reserved>config!.relay.max_inbound_frame_bytes);
      if(!valid||overBudget){
        if(overBudget)options.onError(new ContractError('DESKTOP_INBOUND_BUDGET',429));
        void consumeBoundedByteStream({room:ctx.room,reader,maxBytes:0,current:()=>false,authorize,write:()=>{},error:()=>new ContractError('DESKTOP_INBOUND_BUDGET',429)}).done.catch(()=>{});
        if(overBudget&&++excess>=3){peer.stop('DESKTOP_TIMEOUT','inbound_budget');disconnect();}return;
      }
      inboundBytes+=reserved;
      const bounded=consumeBoundedByteStream({room:ctx.room,reader,maxBytes:config!.relay.max_frame_bytes,current:()=>valid&&current(),authorize:async()=>{
        check(reader.info.mimeType==='application/json'&&reader.info.attributes?.v==='1','DESKTOP_FRAME_INVALID');await authorize();},
        error:kind=>new ContractError(kind==='size'?'DESKTOP_FRAME_TOO_LARGE':kind==='cancelled'?'DESKTOP_CANCELLED':'DESKTOP_TIMEOUT',409),write:chunk=>{chunks.push(Buffer.from(chunk));}});
      readers.add(bounded);void bounded.done.then(()=>{if(!current())return;const frame=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(frame);check(!text.startsWith('\ufeff'),'DESKTOP_FRAME_INVALID');const message=JSONRPCMessageSchema.parse(JSON.parse(text));
        if(!('method' in message)){const pending=message.id===undefined?undefined:peer.ids.get(message.id);if(!pending){dropped++;return;}if(pending.method==='tools/list'&&'result' in message)peer.listHash=digest(message.result.tools);if(pending.call)pending.call.input+=frame.length;peer.ids.delete(message.id!);}
        if('method' in message&&message.method==='elicitation/create'&&'id' in message){const related=message.params?._meta as Record<string,unknown>|undefined,call=peer.ids.get(related?.['paios/relatedRequestId'] as RequestId)?.call;if(call)responses.set(message.id!,call);}
        transport.onmessage?.(message);
      }).catch(error=>{if(!valid||!peer.active)return;for(const call of peer.calls)call.abort.abort(error instanceof ContractError?error:new McpError(ErrorCode.InvalidRequest,'Invalid desktop frame'));options.onError(error instanceof ContractError?error:new Error('Invalid desktop frame'));peer.stop('DESKTOP_TIMEOUT','invalid_frame');disconnect();}).finally(()=>{readers.delete(bounded);inboundBytes-=reserved;});
    });
    peers.set(ctx.device.device_id,peer);ctx.room.on?.(RoomEvent.ParticipantDisconnected,left);transition('attached');
    void (async()=>{
      await client.connect(transport,{timeout:30000});const listing=await client.listTools(undefined,{timeout:30000});if(!current())return;
      if(peer.listHash!==toolsHash&&peer.listHash!==presentationHash){peer.state='version_mismatch';transition(peer.state);changed(ctx.device.principal_id);return;}
      const source=await authorize();if(!current())return;
      peer.state='ready';transition(peer.state);changed(ctx.device.principal_id);
      await client.notification({method:'notifications/paios/ready',params:{ready:true}});
      if(current())await options.runtime.desktopReady(source);
    })().catch(error=>{if(peer.active){options.onError(error);peer.stop('DESKTOP_TIMEOUT','initialization_failed');disconnect();}});
    return()=>peer.stop('DESKTOP_TIMEOUT','detached');
  }
  async function callTool(session:{server:Server|undefined;calls:Map<RequestId,Call>},request:CallToolRequest,extra:{requestId:RequestId;signal:AbortSignal},binding?:DesktopTargetBinding) {
    const found=tools.get(request.params.name);if(!found||!found.validate(request.params.arguments??{}))throw new McpError(ErrorCode.InvalidParams,'Invalid desktop tool or arguments');
    if(presentationNames.has(found.tool.name)&&!binding)throw new McpError(ErrorCode.InvalidParams,'Presentation calls require platform target binding');
    const start=Date.now(),call:Call={key:randomUUID(),tool:found.tool.name,id:extra.requestId,server:session.server,abort:new AbortController(),input:0,output:0};let peer:Peer|undefined,outcome='error',errorCode:string|undefined,lastSeen:string|undefined;
    const cancelled=()=>call.abort.abort(new ContractError('DESKTOP_CANCELLED',409));extra.signal.addEventListener('abort',cancelled,{once:true});if(extra.signal.aborted)cancelled();session.calls.set(call.id,call);calls.set(call.key,call);arm(call,found.tool['x-paios'].timeout_ms);
    try{const rows=await readActivePairedDevices(options.pool),principal=binding?.principal_id??rows[0]?.userId,candidates=[...peers.values()].filter(peer=>peer.ctx.device.principal_id===principal&&peer.active&&peer.ctx.current()&&(!binding||peer.ctx.device.device_id===binding.target_device_id)),ready=candidates.filter(peer=>peer.state==='ready');
      if(binding)check(rows.some(row=>row.userId===principal&&row.deviceId===binding.target_device_id&&row.deviceType==='mac'),'DESKTOP_REVOKED',403);
      const seen=rows.filter(row=>row.userId===principal&&row.deviceType==='mac').map(row=>wire.seen(row.deviceId)).filter((at):at is string=>at!==undefined).sort();lastSeen=seen.at(-1);
      peer=binding?ready.find(peer=>peer.ctx.device.device_id===binding.target_device_id):options.runtime.terminals(principal??'').map(source=>ready.find(peer=>peer.ctx.device.device_id===source.device_id)).find(Boolean)??ready.at(-1);
      check(peer,candidates.some(peer=>peer.state==='version_mismatch')?'DESKTOP_VERSION_MISMATCH':'DESKTOP_OFFLINE',409);
      if(presentationNames.has(found.tool.name))check(peer.listHash===presentationHash,'DESKTOP_VERSION_MISMATCH',409);
      check(!peer.paused,'DESKTOP_PAUSED',409);check(peer.calls.size<config!.relay.max_inflight_per_device,'DESKTOP_BUSY',429);peer.calls.add(call);
      try{const source=await options.sources.revalidate(peer.ctx.device);check(source.principal_id===principal&&source.device_id===peer.ctx.device.device_id&&source.device_type==='mac'&&hasTerminalCapability(source,'desktop_tools'),'DESKTOP_REVOKED',403);}
      catch(error){if((error as {status?:number}).status===403||(error as {status?:number}).status===401){peer.stop('DESKTOP_REVOKED','authorization_failed');throw new ContractError('DESKTOP_REVOKED',403);}throw error;}
      check(peer.active&&peer.ctx.current(),'DESKTOP_REVOKED',403);check(!peer.paused,'DESKTOP_PAUSED',409);
      if(request.params.name==='upload_to_workshop')check(config!.files.enabled&&config!.files.upload_enabled,'TRANSFER_DISABLED',403);
      if(request.params.name==='save_from_workshop')call.download=await files.prepareDownload(request.params.arguments!.workshop_path as string);
      call.abort.signal.throwIfAborted();let result=await peer.client.callTool(request.params,undefined,{signal:call.abort.signal,timeout:330000,relatedRequestId:call.key});await call.delivery;call.abort.signal.throwIfAborted();
      if(request.params.name==='window_capture'&&!result.isError){
        const content=result.content as {type:string;mimeType?:string;data?:string}[];
        check(content.length===1&&content[0]!.type==='image'&&content[0]!.mimeType==='image/jpeg'&&typeof content[0]!.data==='string','DESKTOP_CAPTURE_INVALID',502);
        const analysis=await options.analyzeVision(Buffer.from(content[0]!.data!,'base64'),{prompt:request.params.arguments!.question as string,
          response_schema:{type:'object',properties:{description:{type:'string'}},required:['description'],additionalProperties:false}},call.abort.signal).catch(()=>{call.abort.signal.throwIfAborted();throw new ContractError('DESKTOP_VISION_FAILED',502);});
        call.abort.signal.throwIfAborted();
        const metadata=result.structuredContent as Record<string,unknown>;
        result={content:[{type:'text',text:analysis}],structuredContent:{window_id:metadata.window_id,title:metadata.title,width:metadata.width,height:metadata.height}};
      }
      if(call.upload&&!result.isError){check(result.structuredContent,'TRANSFER_INTEGRITY');const receipt=await call.upload(result.structuredContent as unknown as DesktopTransfer);delete call.upload;result={...result,structuredContent:receipt as unknown as Record<string,unknown>,content:[{type:'text',text:JSON.stringify(receipt)}]};}
      if(result.isError){const code=((result.structuredContent as Record<string,unknown>|undefined)?.error as {code?:unknown})?.code;errorCode=typeof code==='string'&&/^[A-Z_]{1,80}$/.test(code)?code:undefined;}else outcome='ok';return result;
    }catch(error){const failure=call.abort.signal.aborted?call.abort.signal.reason:error;if(!(failure instanceof ContractError))throw failure;
      errorCode=failure.code;outcome=errorCode==='DESKTOP_TIMEOUT'?'timeout':['DESKTOP_CANCELLED','DESKTOP_PAUSED','DESKTOP_REVOKED'].includes(errorCode)?'cancelled':'error';
      const errorBody={code:errorCode,retryable:['DESKTOP_BUSY','DESKTOP_TIMEOUT','DESKTOP_OFFLINE'].includes(errorCode),...(errorCode==='DESKTOP_OFFLINE'&&lastSeen?{last_seen_at:lastSeen}:{})};
      const last=errorCode==='DESKTOP_OFFLINE'&&lastSeen?`（最后在线 ${new Intl.DateTimeFormat('zh-TW',{timeZone:options.runtime.time_zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(lastSeen))}）`:'';
      return {isError:true,content:[{type:'text' as const,text:found.tool.name==='window_capture'?`${messages[errorCode]}${last}`:`${errorCode}：${messages[errorCode]}${last}`}],structuredContent:{error:errorBody}};
    }finally{clearTimeout(call.timer);extra.signal.removeEventListener('abort',cancelled);session.calls.delete(call.id);calls.delete(call.key);peer?.calls.delete(call);if(call.upload)call.abort.abort(new ContractError('DESKTOP_CANCELLED',409));for(const [id,pending] of peer?.ids??[])if(pending.call===call)peer!.ids.delete(id);await call.download?.close();
      process.stderr.write(JSON.stringify({route:'desktop',tool:found.tool.name,device_id:peer?.ctx.device.device_id??null,outcome,...(errorCode?{error_code:errorCode}:{}),ms:Date.now()-start,bytes_in:call.input,bytes_out:call.output})+'\n');}
  }
  const expire=()=>{for(const [id,session] of sessions)if(Date.now()-session.at>=config!.relay.session_idle_s*1000){sessions.delete(id);for(const call of session.calls.values())call.abort.abort(new ContractError('DESKTOP_CANCELLED',409));void session.server.close().catch(options.onError);}};
  const timer=setInterval(expire,Math.min(60000,config.relay.session_idle_s*1000)).unref();
  const handler:NonNullable<typeof options.http.desktop>=async(request,response)=>{
    const reject=(status:number,code:number,message:string,id:unknown=null)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id,error:{code,message}}));};
    if(!['POST','DELETE'].includes(request.method??'')){reject(405,ErrorCode.InvalidRequest,'Method not allowed');return;}expire();
    let body:any;if(request.method==='POST'){const chunks:Buffer[]=[];let size=0;try{for await(const chunk of request){size+=chunk.length;if(size>config!.relay.max_frame_bytes){reject(413,ErrorCode.InvalidRequest,'Desktop request too large');return;}chunks.push(chunk);}body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{reject(400,ErrorCode.ParseError,'Invalid JSON');return;}if(Array.isArray(body)){reject(400,ErrorCode.InvalidRequest,'Batches not supported');return;}}
    const id=request.headers['mcp-session-id'];let session=typeof id==='string'?sessions.get(id):undefined;
    if(!session){if(id!==undefined||!isInitializeRequest(body)){reject(404,ErrorCode.InvalidRequest,'Unknown desktop session',body?.id);return;}if(sessions.size>=config!.relay.max_sessions){reject(503,ErrorCode.InternalError,'DESKTOP_BUSY',(body as {id?:RequestId}).id);return;}
      const sid=randomUUID(),server=new Server({name:'paios-desktop',version:'1'},{capabilities:{tools:{listChanged:false}},instructions:'电脑上的文件操作先阅读「电脑助手」技能。'}),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>sid});
      session={server,transport,calls:new Map(),at:Date.now()};sessions.set(sid,session);const owner=session;
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:capability.tools(manifest.tools)}));
      server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        const args=capability.arguments(request.params.arguments??{}),wire={...request,params:{...request.params,arguments:args}};
        let result:CallToolResult;
        try{result=await callTool(owner,wire,extra) as CallToolResult;}
        catch(error){if(!capability.enabled()||error instanceof McpError&&error.code===ErrorCode.InvalidParams)throw error;
          result={isError:true,content:[],structuredContent:{error:{code:'DESKTOP_TRANSPORT_UNKNOWN'}}};}
        return capability.result(request.params.name,args,result);
      });
      server.onclose=()=>{sessions.delete(sid);for(const call of owner.calls.values())call.abort.abort(new ContractError('DESKTOP_CANCELLED',409));};await server.connect(transport);
    }
    session.at=Date.now();const owner=session;response.once('close',()=>{if(!response.writableEnded)owner.calls.get(body?.id)?.abort.abort(new ContractError('DESKTOP_CANCELLED',409));});
    // Use the SDK's Web transport directly: its Node wrapper's 1.25.3 declarations violate exact optional types.
    const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(value!==undefined&&key!=='content-length')headers.set(key,Array.isArray(value)?value.join(','):value);
    const reply=await session.transport.handleRequest(new Request('http://localhost/internal/desktop/mcp',{method:request.method!,headers}),{parsedBody:body});const responseHeaders:Record<string,string>={};reply.headers.forEach((value,key)=>responseHeaders[key]=value);response.writeHead(reply.status,responseHeaders);
    if(reply.body)await pipeline(Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]),response);else response.end();
  };
  options.http.desktop=handler;
  /** Only platform composition holds this port. Model-visible desktop tools remain unchanged. */
  const invokePresentation=async<A extends PresentationAction>(binding:DesktopTargetBinding,action:A,args:PresentationInputs[A],signal:AbortSignal=new AbortController().signal)=>{
    const target=structuredClone(binding),input=structuredClone(args);validatePresentationInput(action,input,target);
    const result=await callTool({server:undefined,calls:new Map()},{method:'tools/call',params:{name:action,arguments:input}},
      {requestId:randomUUID(),signal},target) as CallToolResult;
    return presentationResult(action,input,result);
  };
  const extension:WireExtension={inputs:{},outputs:{},handle:async()=>{},attach};
  return {handler,invokePresentation,extensions:[wire.extension,extension],...controls,changed:wire.changed,get dropped(){return dropped;},
    close:async()=>{clearInterval(timer);wire.close();for(const peer of [...peers.values()])peer.stop('DESKTOP_TIMEOUT','relay_closed');await Promise.all([...sessions.values()].map(session=>session.server.close()));await files.close();if(options.http.desktop===handler)delete options.http.desktop;}};
}
