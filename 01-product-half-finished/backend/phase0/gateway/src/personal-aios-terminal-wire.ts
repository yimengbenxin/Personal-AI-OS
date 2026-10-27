import type {AnySchema,ValidateFunction} from 'ajv';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RoomEvent} from '@livekit/rtc-node';
import {check,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {hasTerminalCapability,type RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {readActivePairedDevices,PairedDeviceAuthorityError} from './paired-device-authority.ts';
import {revokePairedDevice} from './paired-device-registration.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import {coalescedPublication} from '../../../services/personal-aios-integration/src/publication.ts';
import type {TimelinePage} from '../../../services/personal-aios-integration/src/timeline.ts';
import type {ActivityCard} from '../../../services/personal-aios-integration/src/activity.ts';
import type {LiveKitCloudRoomPort} from './livekit-cloud-participant.ts';

export type WireBody=Record<string,unknown>&{operation:string};
export type WirePublish=(body:WireBody)=>Promise<void>;
/** `ready` settles once the device is present to receive (its first join, or its return after a transport loss).
 *  `leave` retires this connection through the gateway participant that owns the room (never the raw SDK Room). */
export interface WireAttachment {device:RegisteredDevice;room:LiveKitCloudRoomPort;identity:string;current:()=>boolean;leave:()=>Promise<void>;publish:(body:WireBody,signal?:AbortSignal)=>Promise<void>;ready?:(signal:AbortSignal)=>Promise<void>}
type WireInputs=Record<string,{definition:AnySchema;error:string}>;
type WireHandler=(op:string,body:Record<string,unknown>,source:RegisteredDevice,publish:WirePublish)=>Promise<void>;
export interface WireExtension {inputs:WireInputs;outputs:Record<string,AnySchema>;handle:WireHandler;attach?:(ctx:WireAttachment)=>()=>void;prepare?:(ctx:WireAttachment)=>()=>void;publish?:(body:WireBody,source:RegisteredDevice)=>boolean}

/** Each ingress owns its merged validators; registering a feature cannot widen another ingress. */
export function createWireExtensions(extensions:readonly WireExtension[],base:{schema:string;inputs:WireInputs;outputs:Record<string,AnySchema>},compile:(schema:AnySchema)=>ValidateFunction) {
  const inputs=new Map<string,{owner:WireExtension;validate:ValidateFunction;error:string}>(),outputs=new Map<string,ValidateFunction>();
  for(const extension of extensions){
    for(const [op,input] of Object.entries(extension.inputs)){
      check(!Object.hasOwn(base.inputs,op)&&!inputs.has(op),'FORMAL_EXTENSION_OPERATION_CONFLICT');
      inputs.set(op,{owner:extension,validate:compile(input.definition),error:input.error});
    }
    for(const [op,schema] of Object.entries(extension.outputs)){
      check(!Object.hasOwn(base.outputs,op)&&!outputs.has(op),'FORMAL_EXTENSION_OPERATION_CONFLICT');outputs.set(op,compile(schema));
    }
  }
  return {
    publish:async(body:WireBody,source:RegisteredDevice,fallback:WirePublish)=>{if(!extensions.some(extension=>extension.publish?.(body,source)))await fallback(body);},
    has:(op:unknown)=>typeof op==='string'&&inputs.has(op),
    handle:async(body:WireBody,source:RegisteredDevice,publish:WirePublish)=>{
      const input=inputs.get(body.operation)!;check(input.validate(body),input.error);await input.owner.handle(body.operation,body,source,publish);
    },
    output:<T extends Record<string,unknown>>(body:WireBody,fallback:(op:string,body:Record<string,unknown>)=>T)=>{
      const validate=outputs.get(body.operation);if(!validate)return fallback(body.operation,body);
      const value={...body,schema_version:base.schema};check(validate(value),'FORMAL_TEXT_OUTPUT_INVALID');return value;
    },
    prepare:(ctx:WireAttachment)=>{const stops=extensions.map(extension=>extension.prepare?.(ctx));return()=>{for(const stop of stops)stop?.();};},
    attach:(ctx:WireAttachment)=>{const stops=extensions.map(extension=>extension.attach?.(ctx));return()=>{for(const stop of stops)stop?.();};}
  };
}

const registry=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8')).extensions as {contract:string;version:number;sha256:string}[];
const registration=registry.find(entry=>entry.contract==='terminal-message.v1.json');
check(registration?.version===4,'TERMINAL_MESSAGE_REGISTRATION_REQUIRED');
const bytes=readFileSync(new URL('../../../../../integrations/contracts/terminal-message.v1.json',import.meta.url));
check(createHash('sha256').update(bytes).digest('hex')===registration.sha256,'TERMINAL_MESSAGE_CONTRACT_CHANGED');
const contract=JSON.parse(bytes.toString('utf8')) as {version:number;$defs:Record<string,AnySchema>;inputs:WireInputs;outputs:Record<string,AnySchema>};
check(contract.version===4,'TERMINAL_MESSAGE_CONTRACT_VERSION');
const definition=(schema:AnySchema)=>({$defs:contract.$defs,...schema as object});
const inputs=Object.fromEntries(Object.entries(contract.inputs).map(([op,input])=>[op,{...input,definition:definition(input.definition)}]));
const outputs=Object.fromEntries(Object.entries(contract.outputs).map(([op,schema])=>[op,definition(schema)]));
export interface DesktopTerminalControls {
  paused(deviceId:string):boolean|undefined;
  pause(principal:string,deviceId:string,paused:boolean):Promise<void>;
  watch(changed:(principal:string)=>void):()=>void;
  revoked(principal:string,deviceId:string):void;
}
export function createTerminalWire(options:{pool:Parameters<typeof readActivePairedDevices>[0];relay:DesktopTerminalControls;onError:(error:unknown)=>void}) {
  const connections=new Map<string,{ctx:WireAttachment;detach:()=>void}>(),lastSeen=new Map<string,string>();let closed=false;
  const changed=async(principal:string)=>{
    if(closed)return;
    const rows=(await readActivePairedDevices(options.pool)).filter(row=>row.userId===principal);
    await Promise.all([...connections.values()].filter(({ctx})=>ctx.device.principal_id===principal&&ctx.current()&&hasTerminalCapability(ctx.device,'chat_ui')).map(({ctx})=>{
      const selected=rows.filter(row=>row.deviceId===ctx.device.device_id).concat(rows.filter(row=>row.deviceId!==ctx.device.device_id)).slice(0,16);
      return ctx.publish({operation:'terminals',terminals:selected.map(row=>{
        const connection=connections.get(row.deviceId),seen=lastSeen.get(row.deviceId),paused=options.relay.paused(row.deviceId);
        return {device_id:row.deviceId,device_class:row.deviceType==='phone'?'iphone':row.deviceType,...(row.label?{label:row.label}:{}),
          paired_at:row.pairedAt,connected:connection?.ctx.current()===true,self:row.deviceId===ctx.device.device_id,...(seen?{last_seen_at:seen}:{}),
          ...(row.deviceType==='mac'&&paused!==undefined?{paused}:{})};
      })});
    }));
  };
  const notify=(principal:string)=>{void changed(principal).catch(options.onError);};
  const unwatch=options.relay.watch(notify);
  const extension:WireExtension={inputs:{terminal_revoke:inputs.terminal_revoke!,desktop_pause:inputs.desktop_pause!},
    outputs:{terminals:outputs.terminals!,terminal_receipt:outputs.terminal_receipt!},
    handle:async(op,body,source,publish)=>{
      try {
        const mac=source.device_type==='mac',phone=source.device_type==='phone'&&hasTerminalCapability(source,'owner_unlock');
        check(phone||mac,'TERMINAL_REVOKE_DENIED',403);
        const rows=(await readActivePairedDevices(options.pool)).filter(row=>row.userId===source.principal_id);
        if(op==='terminal_revoke'){
          check(!phone||body.device_id!==source.device_id,'TERMINAL_REVOKE_SELF_PHONE',409);
          check(!mac||body.device_id===source.device_id,'TERMINAL_REVOKE_DENIED',403);
          check(rows.some(row=>row.deviceId===body.device_id),'PAIRED_DEVICE_REQUIRED',404);
          await revokePairedDevice({pool:options.pool,deviceId:body.device_id as string,ownerUserId:source.principal_id});
          options.relay.revoked(source.principal_id,body.device_id as string);
        } else {
          check(!mac||body.device_id===source.device_id,'TERMINAL_REVOKE_DENIED',403);
          const targets=rows.filter(row=>row.deviceType==='mac'&&(body.device_id===undefined||row.deviceId===body.device_id));
          check(body.device_id===undefined||targets.length===1,'PAIRED_DEVICE_REQUIRED',404);
          await Promise.all(targets.map(row=>options.relay.pause(source.principal_id,row.deviceId,body.paused as boolean)));
        }
      } catch(error){
        if(!(error instanceof ContractError||error instanceof PairedDeviceAuthorityError))throw error;
        await publish({operation:'terminal_receipt',control_id:body.control_id,ok:false,error_code:error.code});return;
      }
      await publish({operation:'terminal_receipt',control_id:body.control_id,ok:true});await changed(source.principal_id);
    },
    attach:ctx=>{
      check(!closed,'TERMINAL_WIRE_CLOSED',503);
      const principal=ctx.device.principal_id,device=ctx.device.device_id;
      const left=(peer:unknown)=>{if((peer as {identity?:string})?.identity===ctx.identity){lastSeen.set(device,new Date().toISOString());notify(principal);}};
      const entry={ctx,detach:()=>{
        ctx.room.off?.(RoomEvent.ParticipantDisconnected,left);
        if(connections.get(device)!==entry)return;connections.delete(device);lastSeen.set(device,new Date().toISOString());notify(principal);
      }};
      connections.set(device,entry);ctx.room.on?.(RoomEvent.ParticipantDisconnected,left);notify(principal);return entry.detach;
    }
  };
  return {extension,changed,seen:(deviceId:string)=>lastSeen.get(deviceId),
    close:()=>{closed=true;unwatch();for(const entry of connections.values())entry.detach();}};
}

// Reserve the longest legal session; ingress supplies the actual session and schema after this boundary.
const fits=(body:WireBody)=>Buffer.byteLength(JSON.stringify({...body,schema_version:'paios.central.text-envelope.v1',session_id:'s'.repeat(200)}))<=12288;
function prefix(length:number,accept:(length:number)=>boolean):number {
  let low=0,high=length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(accept(mid))low=mid;else high=mid-1;}
  return low;
}
type TimelineFrame={body:WireBody;end?:'item'|'page'};
function* timelineFrames(page:TimelinePage,request_id?:unknown,pageMarkers=false):Generator<TimelineFrame> {
  const request=request_id===undefined?{}:{request_id};
  if(page.reset){yield {body:{operation:'timeline_reset',head_seq:page.head_seq,...request},end:'page'};return;}
  const envelope={operation:'timeline_items',head_seq:page.head_seq,has_more:page.has_more,...request};
  const boundary=(end?:string)=>pageMarkers?{page_end:end==='page'}:{};
  const entries=[...page.items,...page.removals??[]].sort((a,b)=>a.seq-b.seq);
  if(!entries.length)yield {body:{...envelope,...boundary('page'),items:[]},end:'page'};
  for(let index=0;index<entries.length;index++){
    const item=entries[index]!,end=index===entries.length-1?'page':'item';
    if('removed_seqs' in item){yield {body:{operation:'timeline_removed',head_seq:page.head_seq,has_more:page.has_more,...request,...boundary(end),...item},end};continue;}
    if(fits({...envelope,...boundary(end),items:[item]})){yield {body:{...envelope,...boundary(end),items:[item]},end};continue;}
    const characters=Array.from(item.text),ends:number[]=[];let offset=0;
    while(offset<characters.length){
      const count=prefix(characters.length-offset,n=>fits({...envelope,...boundary(),items:[{...item,text:characters.slice(offset,offset+n).join(''),part:characters.length,parts:characters.length}]}));
      check(count>0,'FORMAL_TEXT_OUTPUT_PACKET_TOO_LARGE',413);offset+=count;ends.push(offset);
    }
    for(let n=0;n<ends.length;n++)yield {body:{...envelope,...boundary(n===ends.length-1?end:undefined),items:[{...item,text:characters.slice(n?ends[n-1]:0,ends[n]).join(''),part:n+1,parts:ends.length}]},...(n===ends.length-1?{end}:{})};
  }
}
export function createTimelineWire(runtime:PersonalAIOSRuntime,onError:(error:unknown)=>void):WireExtension {
  type Sync={body:Record<string,unknown>;frames?:Iterator<TimelineFrame>;resolve:()=>void;reject:(error:unknown)=>void};
  const owners=new Map<string,{sync:(body:Record<string,unknown>)=>Promise<void>;snapshot:(body:WireBody)=>void;stop:()=>void}>();
  const key=(source:RegisteredDevice)=>JSON.stringify([source.principal_id,source.device_id]);
  return {inputs:{timeline_sync:inputs.timeline_sync!},outputs:Object.fromEntries(['timeline_items','timeline_removed','timeline_reset','timeline_resync','confirmations'].map(op=>[op,outputs[op]!])),
    handle:async(_op,body,source)=>{
      check(hasTerminalCapability(source,'chat_ui'),'TIMELINE_DEVICE_REQUIRED',403);check(runtime.timeline,'TIMELINE_DISABLED',503);
      const owner=owners.get(key(source));check(owner,'TIMELINE_ATTACHMENT_REQUIRED',409);await owner.sync(body);
      await runtime.replayActivity(source,async snapshot=>owner.snapshot({...snapshot}));
    },
    publish:(body,source)=>{
      const owner=owners.get(key(source));if(!owner||!['voice_confirmations','errand_progress','activity_update'].includes(body.operation))return false;
      owner.snapshot(body);return true;
    },
    prepare:ctx=>{
      const timeline=runtime.timeline;if(!timeline?.fanout(ctx.device))return()=>{};
      const id=key(ctx.device);owners.get(id)?.stop();
      let stopped=false,cursor=timeline.head(ctx.device.principal_id),dirty=false,resync=false,request:Sync|undefined,turn=0;
      const snapshots=new Map<string,WireBody>(),stops:(()=>void)[]=[];let active:{frames:Iterator<TimelineFrame>;finish:()=>void;retry:()=>void}|undefined;
      const send:WirePublish=async body=>{check(!stopped&&ctx.current(),'TIMELINE_ATTACHMENT_CLOSED',409);await ctx.publish(body,pump.signal);};
      const retrySnapshot=(key:string,body:WireBody)=>{
        if(snapshots.has(key))return;
        if(body.operation==='activity_update'){
          const later=[...snapshots];snapshots.clear();snapshots.set(key,body);
          for(const [pending,frame] of later)snapshots.set(pending,frame);
        }else snapshots.set(key,body);
      };
      // A failed frame never leaves the room (the SDK's room events own liveness): its whole item is served again from the start.
      const pump=coalescedPublication(async signal=>{
        // Rotate snapshot/sync/resync/live at item boundaries: at most three other items per pending class.
        for(let checked=0;!active&&checked<4;checked++){
          const selected=turn;turn=(turn+1)%4;
          if(selected===0&&snapshots.size){const [op,body]=snapshots.entries().next().value!;snapshots.delete(op);active={frames:[{body,end:'page' as const}][Symbol.iterator](),finish:()=>{},retry:()=>retrySnapshot(op,body)};}
          else if(selected===1&&request){
            const pending=request,body=pending.body;
            pending.frames??=timelineFrames(timeline.page(ctx.device.principal_id,{...(body.after_seq===undefined?{}:{after_seq:body.after_seq as number}),...(body.before_seq===undefined?{}:{before_seq:body.before_seq as number}),...(body.limit===undefined?{}:{limit:body.limit as number})}),body.request_id,body.page_markers===true);
            active={frames:pending.frames,finish:()=>{pending.resolve();request=undefined;},retry:()=>{delete pending.frames;}};
          }else if(selected===2&&resync){resync=false;active={frames:[{body:{operation:'timeline_resync',head_seq:timeline.head(ctx.device.principal_id)},end:'page' as const}][Symbol.iterator](),finish:()=>{},retry:()=>{resync=true;}};}
          else if(selected===3&&dirty){
            dirty=false;const page=timeline.page(ctx.device.principal_id,{after_seq:cursor,limit:1});
            active={frames:timelineFrames(page),finish:()=>{cursor=page.reset?page.head_seq:Math.max(cursor,...page.items.map(item=>item.seq),...page.removals?.map(item=>item.seq)??[]);dirty=dirty||page.has_more;},retry:()=>{dirty=true;}};
          }
        }
        if(active){
          const current=active,next=current.frames.next();
          if(!next.done){
            try {await send(next.value.body);}catch(error){if(!signal.aborted){current.frames.return?.();active=undefined;current.retry();}throw error;}
            if(signal.aborted)return;}
          if(next.done||next.value.end){active=undefined;if(next.done||next.value.end==='page'){current.frames.return?.();current.finish();}}
        }
        if(!signal.aborted&&(active||snapshots.size||request||resync||dirty))pump.push();
      },onError,undefined,ctx.ready);
      const owner={
        sync:(body:Record<string,unknown>)=>{
          if(request){resync=true;pump.push();return Promise.reject(new ContractError('TIMELINE_SYNC_BUSY',429));}
          return new Promise<void>((resolve,reject)=>{request={body,resolve,reject};pump.push();});
        },
        snapshot:(body:WireBody)=>{
          if(stopped)return;if(!fits(body)){onError(new ContractError('FORMAL_TEXT_OUTPUT_PACKET_TOO_LARGE',413));return;}
          const activity=body.operation==='activity_update'?body.card as ActivityCard:undefined;
          const key=activity?`${body.operation}:${activity.id}`:body.operation;
          const previous=snapshots.get(key);
          if(activity&&previous&&activity.revision<=(previous.card as ActivityCard).revision)return;
          if(activity)snapshots.delete(key);
          snapshots.set(key,body);pump.push();
        },
        stop:()=>{if(stopped)return;stopped=true;pump.stop();request?.reject(new ContractError('TIMELINE_ATTACHMENT_CLOSED',409));request?.frames?.return?.();request=undefined;active?.frames.return?.();active=undefined;snapshots.clear();for(const stop of stops)stop();if(owners.get(id)===owner)owners.delete(id);}
      };
      owners.set(id,owner);stops.push(timeline.watch(ctx.device.principal_id,()=>{dirty=true;pump.push();}));
      if(hasTerminalCapability(ctx.device,'chat_ui')&&!hasTerminalCapability(ctx.device,'owner_unlock')){
        void runtime.watchVoiceConfirmations(ctx.device,async pending=>{
          const rows=pending.slice(-16).map(row=>({confirmation_id:row.confirmation_id,kind:row.kind??'voice',expires_in_ms:row.expires_in_ms,answer_on:'phone',...(row.text?{text:Array.from(row.text).slice(0,200).join('')}:{})}));
          const items=(length:number)=>rows.map(row=>({...row,...(row.text?{text:Array.from(row.text).slice(0,length).join('')}:{})}));
          owner.snapshot({operation:'confirmations',items:items(prefix(200,n=>fits({operation:'confirmations',items:items(n)})))});
        },onError,true).then(stop=>{if(stopped)stop();else stops.push(stop);},onError);
      }
      return owner.stop;
    }};
}

/** Opt-in projection of the existing admission and live-front authorities. Legacy terminals receive no new packet. */
export function createTurnWorkWire(runtime:PersonalAIOSRuntime,onError:(error:unknown)=>void):WireExtension {
  const owners=new Map<string,{sync:(request_id:unknown)=>Promise<void>;stop:()=>void}>();
  const key=(source:RegisteredDevice)=>JSON.stringify([source.principal_id,source.device_id]);
  return {inputs:{turns_sync:inputs.turns_sync!},outputs:{turns_state:outputs.turns_state!},
    handle:async(_op,body,source)=>{
      check(hasTerminalCapability(source,'display'),'TURN_WORK_DEVICE_REQUIRED',403);
      const owner=owners.get(key(source));check(owner,'TURN_WORK_ATTACHMENT_REQUIRED',409);await owner.sync(body.request_id);
    },
    prepare:ctx=>{
      if(!hasTerminalCapability(ctx.device,'display'))return()=>{};
      const id=key(ctx.device);owners.get(id)?.stop();
      let stopped=false,enabled=false,request_id:unknown,unsubscribe:(()=>void)|undefined;
      const pump=coalescedPublication(async()=>{
        if(!enabled||stopped||!ctx.current())return;
        const request=request_id;
        await ctx.publish({operation:'turns_state',...runtime.turnWork(ctx.device.principal_id),...(request===undefined?{}:{request_id:request})},pump.signal);
        if(request_id===request)request_id=undefined;
      },onError,undefined,ctx.ready);
      const owner={sync:async(request:unknown)=>{
        request_id=request;if(!enabled){enabled=true;
          const stop=await runtime.watchTurnWork(ctx.device,()=>pump.push());if(stopped)stop();else unsubscribe=stop;
        }else pump.push();
      },stop:()=>{if(stopped)return;stopped=true;pump.stop();unsubscribe?.();if(owners.get(id)===owner)owners.delete(id);}};
      owners.set(id,owner);return owner.stop;
    }};
}
