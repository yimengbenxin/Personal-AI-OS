import {fileURLToPath} from 'node:url';
import {canonical,check,type ProcessedEvent} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {RawArchive} from '../archive.ts';
import type {ScopeGrants} from '../capability/consent/scope-decision.ts';
import type {RegisteredDevice} from '../source-authority.ts';
import type {CameraCapturePolicies,CameraCapturePolicy} from '../visual/store.ts';
import type {MeetingObservations} from './observations.ts';
import type {MeetingContext,MeetingPorts,MeetingSelection,MeetingWorkspace} from './ports.ts';
import {meetingSelection} from './selection.ts';
import {MeetingSession} from './session.ts';
import {meetingContactSheet} from './contact-sheet.ts';

export interface MeetingHost {
  storage:StoragePort;archive:RawArchive;scopes:ScopeGrants;observations:MeetingObservations;capturePolicies:CameraCapturePolicies;
  connected(principal:string):Promise<RegisteredDevice[]>;
  ownerFile(source:RegisteredDevice,selection:MeetingSelection):Promise<ProcessedEvent>;
  authorize(context:MeetingContext):Promise<string>;
  capture(source:RegisteredDevice,policy:CameraCapturePolicy):Promise<void>;
  vision:MeetingPorts['vision'];discuss:NonNullable<MeetingPorts['discuss']>;
  canDiscuss?:MeetingPorts['canDiscuss'];
  processed(principal:string,id:string):Promise<ProcessedEvent>;
  cancel(principal:string,scope:string):Promise<void>;
}
/** Composition for the existing platform and relay. No alternate owner/consent/model authority. */
export class MeetingRuntime {
  readonly session:MeetingSession;private readonly host:MeetingHost;
  private relay:MeetingPorts['invoke']|undefined;private readonly shown=new Map<string,string>();
  constructor(host:MeetingHost){
    this.host=host;
    this.session=new MeetingSession(host.storage,host.scopes,host.observations,{
      invoke:(...args)=>{check(this.relay,'MEETING_MAC_RELAY_UNAVAILABLE',503);return this.relay(...args);},
      vision:host.vision,contactSheet:meetingContactSheet,discuss:host.discuss,...(host.canDiscuss?{canDiscuss:host.canDiscuss}:{}),
      frame:async(principal,frame,signal)=>{signal.throwIfAborted();const workspace=await this.session.workspaceById(principal,frame.scope_session_id);
        const original=await host.archive.locate(frame.raw_ref,principal);
        check(original.device_id===workspace.glasses_device_id&&original.media_type==='visual'&&original.mime==='image/jpeg','MEETING_FRAME_SOURCE_INVALID',403);
        check(Math.abs(Date.parse(original.received_at)-Date.parse(frame.captured_at))<=500,'MEETING_FRAME_CLOCK_UNCERTAIN',409);
        return Buffer.from(await host.archive.read(frame.raw_ref,principal,frame.archive_revision));},
      capture:(workspace,active)=>this.capture(workspace,active)});
    host.observations.setEndListener(async row=>{host.capturePolicies.releaseLease({principal_id:row.principal_id,device_id:row.glasses_device_id},row.id);await host.cancel(row.principal_id,row.id);
      const source=(await host.connected(row.principal_id)).find(source=>source.device_id===row.glasses_device_id);
      if(source){const policy=await host.capturePolicies.policyForConnect(source);await host.capture(source,policy);this.shown.set(canonical([source.principal_id,source.device_id]),canonical(policy));}});
  }
  async outputWorkspace(d:ProcessedEvent):Promise<MeetingWorkspace|undefined>{
    const seen=new Set<string>();while(!seen.has(d.processed_event_id)){seen.add(d.processed_event_id);
      if(d.source.channel!=='background_scheduled')return;const app=d.content.app_event as {kind?:string;job_id?:string;origin_processed_event_id?:string}|undefined;
      if(app?.kind==='scheduled_task'&&app.job_id?.startsWith('meeting:')){
        const workspace=await this.session.workspaceById(d.principal_id,app.job_id);return workspace.origin_processed_event_id===app.origin_processed_event_id?workspace:undefined;
      }
      if(app?.kind!=='capability_result'||!app.origin_processed_event_id)return;d=await this.host.processed(d.principal_id,app.origin_processed_event_id);
    }
  }
  attach(relay:MeetingPorts['invoke']){this.relay=relay;}
  private async capture(workspace:MeetingWorkspace,active:boolean){
    if(!active)this.host.capturePolicies.releaseLease({principal_id:workspace.principal_id,device_id:workspace.glasses_device_id},workspace.scope_session_id);
    const source=(await this.host.connected(workspace.principal_id)).find(source=>source.device_id===workspace.glasses_device_id);
    if(!source)return;
    const session=await this.host.scopes.sessions.current(workspace.principal_id,workspace.scope_session_id);
    if(active&&session?.state==='active')this.host.capturePolicies.lease(source,workspace.scope_session_id,Date.parse(session.expires_at));
    else this.host.capturePolicies.releaseLease(source,workspace.scope_session_id);
    const policy=await this.host.capturePolicies.policyForConnect(source),signature=canonical(policy),key=canonical([source.principal_id,source.device_id]);
    if(this.shown.get(key)!==signature){await this.host.capture(source,policy);this.shown.set(key,signature);}
  }
  async selected(source:RegisteredDevice,input:unknown){
    meetingSelection(input);
    if(input===null){await this.host.observations.endDevice(source.principal_id,source.device_id,'explicit');return;}
    const original=await this.host.ownerFile(source,input);
    const attachment=original.content.attachments?.find(file=>file.grant_id===input.attachment_grant_id);
    check(attachment?.kind==='presentation'&&fileURLToPath(input.target.file_url)===attachment.path,'MEETING_FILE_GRANT_MISMATCH',403);
    check(input.target.target_device_id===source.device_id,'MEETING_TARGET_MISMATCH',403);
    const glasses=(await this.host.connected(source.principal_id)).filter(source=>source.device_type==='glasses');
    check(glasses.length===1,'MEETING_GLASSES_REQUIRED',409);
    this.host.observations.evidence(source.principal_id,source.device_id);
    const workspace=await this.session.select(source.principal_id,source.device_id,glasses[0]!.device_id,input);
    await this.capture(workspace,true);
  }
  async disconnected(source:RegisteredDevice,reason:string){
    this.host.observations.disconnected(source.principal_id,source.device_id);
    if(reason==='DESKTOP_REVOKED'||reason==='DESKTOP_PAUSED')await this.host.observations.endDevice(source.principal_id,source.device_id,reason==='DESKTOP_REVOKED'?'pairing_revoked':'device_paused');
    else await this.host.observations.sweep();
  }
  async call(body:unknown){
    check(body!==null&&typeof body==='object'&&!Array.isArray(body),'MEETING_INPUT_INVALID');
    const input=body as {method:string;tool:any;args:Record<string,unknown>};
    check(Object.keys(input).sort().join(',')==='args,method,tool'&&['prepare','invoke'].includes(input.method)&&input.args&&typeof input.args==='object','MEETING_INPUT_INVALID');
    const context=input.args.context as MeetingContext;check(context&&Object.keys(context).sort().join(',')==='run_id,session_id,tool_call_id','MEETING_CONTEXT_REQUIRED');
    const principal=await this.host.authorize(context);
    return input.method==='prepare'?this.session.prepare(principal,context,input.tool,input.args):this.session.call(principal,context,input.tool,input.args);
  }
}
