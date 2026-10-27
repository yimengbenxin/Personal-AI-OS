import {projectWorkItems} from './capability/work-items.ts';
import {digest} from './contracts.ts';
import {safe} from './timeline.ts';
import type {NativeRunEvent} from './hermes-client.ts';
import type {ErrandProgress,ErrandResult} from './runtime.ts';
import {activityTitle} from './activity-title.ts';
import {aggregateReceipts} from './capability/gateway.ts';
import {activitySentence} from './capability/renderer.ts';
import type {ReceiptRecord} from './capability/ledger.ts';

export type ItemState='running'|'succeeded'|'failed'|'partial'|'cancelled'|'unknown'|'waiting';
export interface ActivityProgress {version:1;value:number;total:number}
export interface ActivityItem {
  id:string;kind:'subagent'|'errand'|'task';state:ItemState;summary:string;step_summary?:string;progress?:ActivityProgress;
  started_at:string;elapsed_ms:number;completed_at?:string;failure_reason?:string;
}
export interface ActivityCard {
  id:string;revision:number;state:ItemState|'partial';summary:string;step_summary?:string;progress?:ActivityProgress;
  summary_source:'agent_intent'|'subagent_goal'|'tool_status'|'generic';started_at:string;observed_at:string;
  last_progress_at:string;elapsed_ms:number;completed_at?:string;counts:Record<'total'|'running'|'succeeded'|'failed'|'cancelled',number>&{partial?:number;unknown?:number;waiting?:number};
  items:ActivityItem[];omitted_items:number;failure_reason?:string;
}
export interface ActivityUpdate {operation:'activity_update';session_id:string;processed_event_id:string;card:ActivityCard}
export interface ActivitySaved {packet:ActivityUpdate;items:ActivityItem[];final?:string;final_at_ms?:number}
const publicLine=(text:string,limit:number)=>{
  const line=text.split(/[\r\n]/u)[0]!.trim();
  return safe(line)&&!/[\/\\`*\[\]<>]/u.test(line)?activityTitle(line,limit):'';
};
const failure=(status:string)=>['timeout','timed_out','expired'].includes(status)?'超时，结果未知':'这件事未办成';
/** Display projection only. Admission settles the run; the errand authority settles its jobs. */
export class ActivityProjection {
  card:ActivityCard|undefined;
  readonly items=new Map<string,ActivityItem>();
  readonly principal:string;readonly session:string;readonly processed:string;
  private readonly publish:(packet:ActivityUpdate)=>void;private readonly now:()=>number;
  private final:string|undefined;private finalAt:number|undefined;private intent='';
  private readonly tools=new Map<string,{intent:string;progress?:ActivityProgress}>();private activeTool:string|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined;private lastSent=0;
  private receiptRecords:ReceiptRecord[]=[];
  constructor(principal:string,session:string,processed:string,
    publish:(packet:ActivityUpdate)=>void,now:()=>number=Date.now,saved?:ActivitySaved){
    this.principal=principal;this.session=session;this.processed=processed;this.publish=publish;this.now=now;
    if(saved){this.card=saved.packet.card;this.final=saved.final;this.finalAt=saved.final_at_ms;
      for(const item of saved.items)this.items.set(item.id,item);
      if(this.card.summary_source==='agent_intent')this.intent=this.card.summary;}
  }
  private itemId(kind:string,source:string){return `i:${digest([this.principal,this.session,this.processed,kind,source])}`;}
  event(event:NativeRunEvent):void {
    if(this.card?.completed_at&&!this.receiptRecords.length&&!(event.event==='subagent.complete'&&
      this.subagentState(event.subagent_id!)==='unknown'))return;
    if(event.event==='run.snapshot'){
      const progressAt=this.card?.last_progress_at;
      for(const [key,item] of this.items)if(item.kind!=='errand')this.items.delete(key);
      this.intent='';this.tools.clear();this.activeTool=undefined;
      for(const current of event.activity_events??[])this.event(current);
      if(this.card){
        const latest=Math.max(...(progressAt?[Date.parse(progressAt)]:[]),...(event.activity_events??[]).map(current=>current.timestamp*1000),
          ...[...this.items.values()].filter(item=>item.kind==='errand').map(item=>Date.parse(item.completed_at??item.started_at)));
        this.changed(new Date(this.now()).toISOString(),false,Number.isFinite(latest)?new Date(latest).toISOString():this.card.last_progress_at);
      }
      return;
    }
    if(!['tool.started','tool.completed','tool.progress','subagent.start','subagent.complete','subagent.progress'].includes(event.event))return;
    const at=new Date(event.timestamp*1000).toISOString(),started=!this.card&&['tool.started','subagent.start'].includes(event.event);
    if(event.event==='tool.started'&&event.tool_call_id){
      const tool={intent:publicLine(event.public_intent??'',48)};
      this.tools.set(event.tool_call_id,tool);this.activeTool=event.tool_call_id;this.intent=tool.intent;
    }
    if(event.event==='tool.progress'&&event.tool_call_id){
      const tool=this.tools.get(event.tool_call_id);
      if(tool){
        if(event.progress!==undefined&&event.total!==undefined&&event.total>0)tool.progress={version:1,value:event.progress,total:event.total};
        else delete tool.progress;
        this.activeTool=event.tool_call_id;this.intent=tool.intent;}
    }
    if(event.event==='tool.completed'&&event.tool_call_id){
      this.tools.delete(event.tool_call_id);
      if(this.activeTool===event.tool_call_id){this.activeTool=[...this.tools.keys()].at(-1);this.intent=this.tools.get(this.activeTool!)?.intent??this.intent;}
    }
    if(started)this.card={id:`a:${digest([this.principal,this.session,this.processed])}`,revision:0,state:'running',
      summary:'正在处理这件事',summary_source:'generic',started_at:at,observed_at:at,last_progress_at:at,elapsed_ms:0,
      counts:{total:1,running:1,succeeded:0,failed:0,cancelled:0},items:[],omitted_items:0};
    if(!this.card)return;
    if(event.event.startsWith('subagent.')){
      const key=this.itemId('subagent',event.subagent_id!);
      if(event.event==='subagent.start')this.items.set(key,{id:key,kind:'subagent',state:'running',
        summary:publicLine(event.goal!,48)||'正在处理这件事',started_at:at,elapsed_ms:0});
      else if(event.event==='subagent.progress'){
        const item=this.items.get(key);
        if(item?.state==='running'){
          if(event.progress!==undefined&&event.total!==undefined&&event.total>0)item.progress={version:1,value:event.progress,total:event.total};
          else delete item.progress;
        }
      }
      else if(event.event==='subagent.complete'&&this.items.has(key))this.complete(this.items.get(key)!,
        event.outcome??(event.status==='completed'?'partial':event.status==='interrupted'?'cancelled':'failed'),
        at,event.exit_reason??event.status!,event.outcome_reason??(event.status==='completed'?
          event.exit_reason==='max_iterations'?'达到工具调用上限，任务未完成':'子任务已结束，完成情况待核对':undefined));
    }
    this.changed(at,started);
  }
  errand(job:ErrandProgress|ErrandResult):void {
    if(!this.card||this.card.completed_at)return;
    const key=this.itemId('errand',job.job_id),at=new Date(this.now()).toISOString();
    if(!('finished_at' in job)){
      const item=this.items.get(key)??{id:key,kind:'errand' as const,state:'running' as const,
        summary:publicLine(job.title,48)||'正在处理这件事',started_at:job.started_at,elapsed_ms:0};
      if(item.state!=='running')return;
      const summary=publicLine(job.title,48)||'正在处理这件事';
      const step=`${summary} · ${job.state==='waiting'?'等待处理':job.state==='stopping'?'正在停止':'正在处理'}`;
      if(item.step_summary===step&&item.summary===summary)return;item.summary=summary;item.step_summary=step;
      this.items.set(key,item);
    }else{
      const item=this.items.get(key)??{id:key,kind:'errand' as const,state:'running' as const,
        summary:publicLine(job.title??'',48)||'正在处理这件事',started_at:job.finished_at,elapsed_ms:0};
      if(item.state!=='running')return;this.items.set(key,item);
      this.complete(item,job.success?'succeeded':job.terminal_reason==='cancelled_by_user'?'cancelled':job.partial_findings?'partial':'failed',
        job.finished_at,job.terminal_reason??'failed');
    }
    this.changed(at,false);
  }
  settle(status:string,atMs=this.now()):void {
    if(this.card?.completed_at&&!this.receiptRecords.length)return;this.final=status;this.finalAt=atMs;
    if(this.card){
      const at=new Date(atMs).toISOString();
      for(const item of this.items.values())if(status!=='completed'&&item.kind!=='errand'&&item.state==='running')
        this.complete(item,['cancelled','canceled','interrupted'].includes(status)?'cancelled':'failed',at,status);
      this.changed(new Date(this.now()).toISOString(),false);
    }
  }
  subagentState(id:string):ItemState|undefined {return this.items.get(this.itemId('subagent',id))?.state;}
  get hasRunningSubagents():boolean {return [...this.items.values()].some(item=>item.kind==='subagent'&&item.state==='running');}
  childEnded(id:string,atMs:number):void {
    if(this.subagentState(id)!=='running')return;
    this.complete(this.items.get(this.itemId('subagent',id))!,'unknown',new Date(atMs).toISOString(),'ended');
    this.changed(new Date(this.now()).toISOString(),true);
  }
  receipts(records:ReceiptRecord[]):void {
    if(!records.length)return;
    this.receiptRecords=records;
    const at=new Date(this.now()).toISOString(),rows=projectWorkItems(records);
    for(const row of rows){const key=this.itemId('task',row.id),prior=this.items.get(key);
      const state=row.state==='accepted'?'running':row.state;
      const item:ActivityItem=prior??{id:key,kind:'task',state,summary:publicLine(row.label,48)||'正在处理这件事',started_at:at,elapsed_ms:0};
      item.state=state;if(['running','waiting'].includes(state))delete item.completed_at;else item.completed_at??=at;
      this.items.set(key,item);}
    if(!this.card&&rows.length)this.card={id:`a:${digest([this.principal,this.session,this.processed])}`,revision:0,state:'running',
      summary:'正在处理这件事',summary_source:'tool_status',started_at:at,observed_at:at,last_progress_at:at,elapsed_ms:0,
      counts:{total:rows.length,running:0,succeeded:0,failed:0,cancelled:0},items:[],omitted_items:0};
    if(this.card)this.changed(at,true);
  }
  private complete(item:ActivityItem,state:ItemState,at:string,status:string,reason?:string):void {
    item.state=state;if(['running','waiting'].includes(state))delete item.completed_at;else item.completed_at=at;delete item.step_summary;delete item.progress;
    if(state==='failed'||state==='partial')item.failure_reason=publicLine(reason??'',96)||failure(status);
  }
  private changed(at:string,immediate:boolean,progressAt=at):void {
    const card=this.card!,items=[...this.items.values()],counts:ActivityCard['counts']={total:items.length||1,running:0,succeeded:0,failed:0,cancelled:0};
    for(const item of items){
      const own=item.kind==='subagent'?this.receiptRecords.filter(record=>this.itemId('subagent',record.task_id)===item.id):[];
      if(own.length){
        item.state=aggregateReceipts(own);item.summary=activitySentence(own.map(record=>record.receipt),item.state);
        if(['failed','partial'].includes(item.state))item.failure_reason=failure(item.state);else delete item.failure_reason;
        delete item.progress;delete item.step_summary;
        if(['running','waiting'].includes(item.state))delete item.completed_at;else item.completed_at??=at;
      }
      if(['partial','unknown','waiting'].includes(item.state))counts[item.state]=(counts[item.state]??0)+1;else counts[item.state]++;
      item.elapsed_ms=Math.max(0,Date.parse(item.completed_at??at)-Date.parse(item.started_at));}
    if(!items.length)counts[this.receiptRecords.length?aggregateReceipts(this.receiptRecords):this.final?(this.final==='completed'?'succeeded':['cancelled','canceled','interrupted'].includes(this.final)?'cancelled':'failed'):'running']=1;
    const terminal=!!this.final&&!counts.running&&!counts.waiting;
    card.state=!terminal?'running':counts.unknown?'unknown':counts.partial?'partial':counts.failed?(counts.failed===counts.total?'failed':'partial'):counts.cancelled?(counts.cancelled===counts.total?'cancelled':'partial'):'succeeded';
    if(terminal){card.completed_at=new Date(Math.max(this.finalAt??Date.parse(at),...items.map(item=>Date.parse(item.completed_at!)))).toISOString();immediate=true;}
    card.observed_at=at;card.last_progress_at=progressAt;card.elapsed_ms=Math.max(0,Date.parse(card.completed_at??at)-Date.parse(card.started_at));
    card.revision=Math.max(this.now(),card.revision+1);card.counts=counts;card.items=items.slice(0,8);card.omitted_items=Math.max(0,items.length-8);
    const delegates=items.filter(item=>item.kind==='subagent');
    card.summary=this.intent||(delegates.length?`${delegates.length} 件事一起办`:items[0]?.summary)||'正在处理这件事';
    card.summary_source=this.intent?'agent_intent':delegates.length?'subagent_goal':items.length?'tool_status':'generic';
    if(this.receiptRecords.length){
      card.state=aggregateReceipts(this.receiptRecords);
      card.summary=activitySentence(this.receiptRecords.map(record=>record.receipt),card.state);card.summary_source='tool_status';
      if(['running','waiting'].includes(card.state))delete card.completed_at;
      else card.completed_at??=at;
    }
    const tool=!this.final?this.tools.get(this.activeTool!):undefined;
    const running=items.find(item=>item.state==='running'&&item.progress)??items.find(item=>item.state==='running'&&item.step_summary);
    const progress=!this.receiptRecords.length&&!terminal?(tool?.progress??running?.progress):undefined;
    const step=this.receiptRecords.length||tool?.progress?undefined:running?.step_summary;
    if(progress){
      card.progress=progress;card.summary=tool?.progress?(tool.intent||'正在处理这件事'):running!.summary;
      card.summary_source=tool?.progress?(tool.intent?'agent_intent':'generic'):running!.kind==='subagent'?'subagent_goal':'tool_status';
    }else delete card.progress;
    if(step)card.step_summary=step;else delete card.step_summary;
    const work=projectWorkItems(this.receiptRecords);
    if(work.length)card.progress={version:1,value:work.filter(item=>item.state==='succeeded').length,total:work.length};
    if(['failed','partial'].includes(card.state))card.failure_reason=items.find(item=>item.failure_reason)?.failure_reason??failure(this.final!);else delete card.failure_reason;
    if(immediate)this.flush();else if(!this.timer)this.timer=setTimeout(()=>this.flush(),Math.max(0,500-(this.now()-this.lastSent)));
  }
  snapshot():ActivitySaved|undefined {return this.card?{packet:{operation:'activity_update',session_id:this.session,processed_event_id:this.processed,card:structuredClone(this.card)},
    items:structuredClone([...this.items.values()]),...(this.final?{final:this.final}:{}),...(this.finalAt!==undefined?{final_at_ms:this.finalAt}:{})}:undefined;}
  private flush():void {clearTimeout(this.timer);this.timer=undefined;this.lastSent=this.now();this.publish(this.snapshot()!.packet);}
  close():void {if(this.timer)this.flush();}
}
