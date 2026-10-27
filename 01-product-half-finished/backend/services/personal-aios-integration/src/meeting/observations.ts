import {canonical,check,digest,type ProcessedEvent,type TimeRange} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {ScopeGrants} from '../capability/consent/scope-decision.ts';
import type {ScopeEndReason} from '../../../../../../capability/contracts/scope-grant.ts';
import {meetingWords} from './speakers.ts';

export interface MeetingSource {id:string;principal_id:string;target_id:string;target_device_id:string;glasses_device_id:string;started_at:string;ended_at?:string}
export interface MeetingWord {utterance_id:string;scope_session_id:string;speaker:'other';text:string;start_ms:number;end_ms:number;raw_ref:string;archive_revision:string;segment_id:string}
export interface MeetingFrame {frame_ref:string;scope_session_id:string;raw_ref:string;archive_revision:string;captured_at:string}
/** Meeting purpose and liveness live in the existing platform, using the existing storage and consent authorities. */
export class MeetingObservations {
  private readonly rows=new Map<string,MeetingSource>();private loaded:Promise<void>|undefined;
  private readonly devices=new Map<string,{connected:boolean;at:number}>();private readonly aborts=new Map<string,AbortController>();
  private onEnd:((row:MeetingSource)=>Promise<void>)|undefined;
  setEndListener(listener:(row:MeetingSource)=>Promise<void>){this.onEnd=listener;}
  private readonly refreshed=new Map<string,number>();
  readonly storage:StoragePort;readonly scopes:ScopeGrants;readonly now:()=>number;
  constructor(storage:StoragePort,scopes:ScopeGrants,now:()=>number=Date.now){this.storage=storage;this.scopes=scopes;this.now=now;}
  private key(principal:string,device:string){return digest([principal,device]);}
  private load(){return this.loaded??=this.storage.list('meeting-sources').then(async keys=>{
    for(const key of keys){const row=JSON.parse(Buffer.from(await this.storage.read('meeting-sources',key)).toString()) as MeetingSource;this.rows.set(row.id,row);}
  });}
  private async save(row:MeetingSource){check(this.storage.replace,'MEETING_STORAGE_REQUIRED');
    await this.storage.replace('meeting-sources',digest([row.principal_id,row.id]),Buffer.from(canonical(row)));this.rows.set(row.id,row);}
  /** Only authenticated transport/capture owners call these methods. Client timestamps never establish freshness. */
  evidence(principal:string,device:string){this.devices.set(this.key(principal,device),{connected:true,at:this.now()});}
  disconnected(principal:string,device:string){this.devices.set(this.key(principal,device),{connected:false,at:this.now()});
    for(const row of this.rows.values())if(row.principal_id===principal&&[row.target_device_id,row.glasses_device_id].includes(device))this.aborts.get(row.id)?.abort();}
  private fresh(row:MeetingSource){return [row.target_device_id,row.glasses_device_id].every(device=>{
    const state=this.devices.get(this.key(row.principal_id,device));return state?.connected&&this.now()-state.at>=0&&this.now()-state.at<=30000;});}
  async open(input:{id:string;principal_id:string;target_id:string;target_device_id:string;glasses_device_id:string}) {
    await this.load();const row:MeetingSource={id:input.id,principal_id:input.principal_id,target_id:input.target_id,target_device_id:input.target_device_id,glasses_device_id:input.glasses_device_id,started_at:new Date(this.now()).toISOString()};
    check(this.fresh(row),'MEETING_CONNECTION_REQUIRED',409);
    for(const prior of this.rows.values())if(prior.principal_id===row.principal_id&&!prior.ended_at&&prior.id!==row.id)
      await this.end(prior.principal_id,prior.id,'target_changed');
    const session=await this.scopes.sessions.open({id:input.id,principal_id:input.principal_id,target_id:input.target_id,target_device_id:input.target_device_id,allowed_operation_kinds:['document.text.update']});
    check(session.state==='active','MEETING_SESSION_ENDED',409);
    const prior=this.rows.get(row.id);if(prior){check(canonical({...prior,started_at:row.started_at})===canonical(row),'MEETING_SOURCE_CONFLICT',409);return prior;}
    await this.save(row);return row;
  }
  signal(id:string){let abort=this.aborts.get(id);if(!abort){abort=new AbortController();this.aborts.set(id,abort);}return abort.signal;}
  async guard(principal:string,id:string){
    await this.load();const row=this.rows.get(id);check(row?.principal_id===principal,'MEETING_SESSION_NOT_FOUND',404);
    const session=await this.scopes.sessions.current(principal,id);if(session?.state!=='active'||row.ended_at)this.aborts.get(id)?.abort();
    check(session?.state==='active'&&!row.ended_at,'MEETING_SESSION_ENDED',409);
    const live=this.fresh(row);
    if(!live||session.disconnected_at||!this.scopes.sessions.connected(session)||(this.now()-(this.refreshed.get(id)??0)>=20000)){
      if(!live)this.aborts.get(id)?.abort();
      const current=await this.scopes.sessions.connection(principal,id,live,row);this.refreshed.set(id,this.now());
      check(current.state==='active','MEETING_SESSION_ENDED',409);
      if(live&&this.aborts.get(id)?.signal.aborted)this.aborts.set(id,new AbortController());
    }
    check(live,'MEETING_CONNECTION_REQUIRED',409);return row;
  }
  freshUntil(id:string){const row=this.rows.get(id);check(row,'MEETING_SESSION_NOT_FOUND',404);return Math.min(...[row.target_device_id,row.glasses_device_id].map(device=>(this.devices.get(this.key(row.principal_id,device))?.at??0)+30000));}
  async bindRun(principal:string,id:string,context:{run_id:string;session_id:string}){await this.guard(principal,id);return this.scopes.sessions.bindRun(context,principal,id);}
  async sweep(){await this.load();for(const row of this.rows.values())if(!row.ended_at){
    try{await this.guard(row.principal_id,row.id);}catch(error){if(!['MEETING_CONNECTION_REQUIRED','MEETING_SESSION_ENDED'].includes((error as {code:string}).code))throw error;
      const session=await this.scopes.sessions.current(row.principal_id,row.id);if(session?.state==='ended')await this.end(row.principal_id,row.id,session.end_reason!);}
  }}
  async end(principal:string,id:string,reason:ScopeEndReason='explicit'){
    await this.load();const row=this.rows.get(id);check(row?.principal_id===principal,'MEETING_SESSION_NOT_FOUND',404);
    this.aborts.get(id)?.abort();const ended=await this.scopes.sessions.end(principal,id,reason);
    if(!row.ended_at){await this.onEnd?.(row);await this.save({...row,ended_at:ended.ended_at!});}
  }
  async endDevice(principal:string,device:string,reason:ScopeEndReason){await this.load();
    for(const row of this.rows.values())if(row.principal_id===principal&&!row.ended_at&&[row.glasses_device_id,row.target_device_id].includes(device))await this.end(principal,row.id,reason);}
  async purpose(principal:string,device:string,range:TimeRange){await this.load();
    const active=[...this.rows.values()].find(row=>row.principal_id===principal&&row.glasses_device_id===device&&!row.ended_at);
    if(active)return active;
    if(range.kind!=='interval'||range.timebase_id!=='utc_epoch_ms')return;
    return [...this.rows.values()].find(row=>row.principal_id===principal&&row.glasses_device_id===device&&
      range.start_ms>=Date.parse(row.started_at)&&range.start_ms<Date.parse(row.ended_at??'9999-01-01T00:00:00Z'));
  }
  async analysisPurpose(principal:string,device:string,range:TimeRange):Promise<'meeting'|'meeting_paused'|undefined>{
    const row=await this.purpose(principal,device,range);if(!row)return;
    try{await this.guard(principal,row.id);return 'meeting';}catch(error){
      if(['MEETING_CONNECTION_REQUIRED','MEETING_SESSION_ENDED'].includes((error as {code:string}).code))return 'meeting_paused';throw error;
    }
  }
  async observe(d:ProcessedEvent){
    const row=await this.purpose(d.principal_id,d.device_id,d.time_range);if(!row)return false;
    // Even stale/ended meeting media may never fall through into ambient emotion/person journaling.
    try{await this.guard(row.principal_id,row.id);}catch(error){if(['MEETING_CONNECTION_REQUIRED','MEETING_SESSION_ENDED'].includes((error as {code:string}).code))return true;throw error;}
    const observations=d.content.audio_observations as unknown as {segments?:{speaker?:string;text?:string;source_parts?:{clipped_scope_range?:TimeRange}[]}[]}[]|undefined;
    for(const [index,segment] of (observations??[]).flatMap(o=>o.segments??[]).entries()){
      if(segment.speaker!=='speaker:meeting-other'||!segment.text)continue;const text=meetingWords(segment.text);if(!text)continue;
      const parts=segment.source_parts?.flatMap(p=>p.clipped_scope_range?.kind==='interval'?[p.clipped_scope_range]:[])??[];
      check(d.time_range.kind==='interval','MEETING_CLOCK_REQUIRED');
      const word:MeetingWord={utterance_id:`utterance:${digest([d.processed_event_id,index])}`,scope_session_id:row.id,speaker:'other',text,
        start_ms:parts[0]?.start_ms??d.time_range.start_ms,end_ms:parts.at(-1)?.end_ms??d.time_range.end_ms,
        raw_ref:d.raw_ref,archive_revision:d.archive_revision,segment_id:d.segment_id!};
      await this.storage.publish('meeting-words',digest([row.principal_id,word.utterance_id]),Buffer.from(canonical(word)));
    }return true;
  }
  async words(principal:string,id:string){await this.load();check(this.rows.get(id)?.principal_id===principal,'MEETING_SESSION_NOT_FOUND',404);
    const rows:MeetingWord[]=[];for(const key of await this.storage.list('meeting-words')){const word=JSON.parse(Buffer.from(await this.storage.read('meeting-words',key)).toString());
      if(word.scope_session_id===id&&key===digest([principal,word.utterance_id]))rows.push(word);}return rows.sort((a,b)=>a.start_ms-b.start_ms);}
  async frames(principal:string,id:string){await this.load();check(this.rows.get(id)?.principal_id===principal,'MEETING_SESSION_NOT_FOUND',404);
    const rows:MeetingFrame[]=[];for(const key of await this.storage.list('meeting-frames')){const frame=JSON.parse(Buffer.from(await this.storage.read('meeting-frames',key)).toString());if(frame.scope_session_id===id&&key===digest([principal,frame.frame_ref]))rows.push(frame);}return rows.sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at));}
  async frame(principal:string,device:string,captured_at:string,raw_ref:string,archive_revision:string){
    const at=Date.parse(captured_at),row=await this.purpose(principal,device,{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:at,end_ms:at+1});if(!row)return false;
    const frame:MeetingFrame={scope_session_id:row.id,frame_ref:`meeting-frame:${digest([principal,raw_ref,archive_revision])}`,raw_ref,archive_revision,captured_at};
    await this.storage.publish('meeting-frames',digest([principal,frame.frame_ref]),Buffer.from(canonical(frame)));return true;
  }
  close(){for(const abort of this.aborts.values())abort.abort();}
}
