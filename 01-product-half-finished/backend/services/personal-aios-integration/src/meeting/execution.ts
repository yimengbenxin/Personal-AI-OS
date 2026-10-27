import {canonical,check,digest,sha256} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {ScopeGrants} from '../capability/consent/scope-decision.ts';
import type {MeetingObservations} from './observations.ts';
import type {MeetingContext,MeetingPorts,MeetingWorkspace} from './ports.ts';
import {readMeeting} from './plan.ts';
import {validateMacEditResult,validateTextPlan} from '../presentation-validate.ts';
import type {MacEditResult,PresentationResult,TextPlan} from '../../../../../../capability/contracts/presentation.ts';
import {unknown,waiting,to_mcp_result} from '../../../../../../capability/sdk/ts/receipt.ts';

interface Operation {key:string;principal_id:string;scope_session_id:string;target_id:string;plan:TextPlan;state:'pending'|'settled';result?:PresentationResult}
export class MeetingExecution {
  private readonly flights=new Map<string,Promise<unknown>>();
  readonly storage:StoragePort;readonly scopes:ScopeGrants;readonly observations:MeetingObservations;readonly ports:MeetingPorts;readonly now:()=>number;
  constructor(storage:StoragePort,scopes:ScopeGrants,observations:MeetingObservations,ports:MeetingPorts,now=Date.now){this.storage=storage;this.scopes=scopes;this.observations=observations;this.ports=ports;this.now=now;}
  private async serial<T>(key:string,run:()=>Promise<T>){const flight=(this.flights.get(key)??Promise.resolve()).catch(()=>{}).then(run);this.flights.set(key,flight);try{return await flight;}finally{if(this.flights.get(key)===flight)this.flights.delete(key);}}
  private async read(principal:string,key:string){return this.scopes.store.read<Operation>('meeting-operations',digest([principal,key]));}
  private async save(operation:Operation){return this.scopes.store.serial(`meeting-operation:${operation.principal_id}:${operation.key}`,async()=>{
    const prior=await this.read(operation.principal_id,operation.key);
    if(prior?.state==='settled'&&prior.result&&(prior.result.structuredContent.job?.revision??1)>=(operation.result?.structuredContent.job?.revision??1))return prior;
    check(this.storage.replace,'MEETING_STORAGE_REQUIRED');await this.storage.replace('meeting-operations',digest([operation.principal_id,operation.key]),Buffer.from(canonical(operation)));return operation;
  });}
  async pending(workspace:MeetingWorkspace){
    for(const key of await this.storage.list('meeting-operations')){const operation=JSON.parse(Buffer.from(await this.storage.read('meeting-operations',key)).toString()) as Operation;
      if(operation.principal_id===workspace.principal_id&&operation.target_id===workspace.target.target_id&&operation.state==='pending')return operation;}
  }
  private uncertain(operation:Operation,code:string):PresentationResult{return to_mcp_result(unknown({job:{id:operation.key,revision:operation.result?.structuredContent.job?.revision??1},
    status:{reason_code:code},values:[{key:'idempotency_key',value:operation.key,unit:'key',provenance:'observed',source:'platform:meeting-operation',as_of:new Date(this.now()).toISOString()}],
    unknowns:[{about:operation.target_id,why:code}],next:{retry:'after_check',check_with:'edit_status'}})) as unknown as PresentationResult;}
  private qualify(operation:Operation,result:PresentationResult):PresentationResult{
    const body=structuredClone(result),receipt=body.structuredContent;
    if(['succeeded','partial','accepted','running'].includes(receipt.status.state)||receipt.effects.length||receipt.work_items?.length||receipt.content.some(row=>row.key==='edit_result')){
      const audit=JSON.parse(receipt.content.find(row=>row.key==='edit_result')!.text) as MacEditResult;validateMacEditResult(audit);
      check(audit.operation_id===`op:${operation.key}`&&audit.plan_sha256===operation.plan.plan_sha256&&
        canonical(audit.target)===canonical(operation.plan.target),'MEETING_AUDIT_BINDING_INVALID');
      for(const item of audit.items){const edit=operation.plan.edits.find(row=>row.work_item_id===item.id);check(edit,'MEETING_AUDIT_ITEM_INVALID');
        if(item.state==='succeeded'){const proof=audit.checks.find(row=>row.work_item_id===item.id);
          check(proof?.before_text_sha256===edit.before_text_sha256&&proof.after_text_sha256===sha256(edit.after_text),'MEETING_AUDIT_READBACK_MISMATCH');}}
    }
    receipt.job={id:operation.key,revision:receipt.job?.revision??1};return body;
  }
  async status(workspace:MeetingWorkspace,key:string){
    const operation=await this.read(workspace.principal_id,key);check(operation&&operation.target_id===workspace.target.target_id,'MEETING_OPERATION_NOT_FOUND',404);
    return this.serial(`${workspace.principal_id}:${key}`,async()=>{
      let result:PresentationResult;
      try{result=this.qualify(operation,await this.ports.invoke({principal_id:workspace.principal_id,target_device_id:operation.plan.target.target_device_id},
        'presentation_edit_status',{target:operation.plan.target,operation_id:`op:${key}`},new AbortController().signal));}
      catch{result=this.uncertain(operation,'MEETING_STATUS_UNKNOWN');}
      return (await this.save({...operation,result,state:['succeeded','failed','cancelled'].includes(result.structuredContent.status.state)?'settled':'pending'})).result!;
    });
  }
  async apply(workspace:MeetingWorkspace,context:MeetingContext,planId:string,hash:string,key:string){
    return this.serial(`${workspace.principal_id}:apply`,async()=>{
      const plan=await readMeeting<TextPlan>(this.storage,'meeting-plans',workspace.principal_id,planId);validateTextPlan(plan);
      check(plan.plan_sha256===hash,'MEETING_PLAN_HASH_MISMATCH',409);
      check(plan.scope_session_id===workspace.scope_session_id&&canonical(plan.target)===canonical(workspace.target),'MEETING_PLAN_SCOPE_MISMATCH',403);
      const prior=await this.read(workspace.principal_id,key);
      if(prior){check(prior.plan.plan_sha256===hash,'MEETING_IDEMPOTENCY_CONFLICT',409);return prior.state==='pending'?this.status(workspace,key):prior.result!;}
      const pending=await this.pending(workspace);if(pending)return this.status(workspace,pending.key);
      await this.observations.guard(workspace.principal_id,workspace.scope_session_id);
      const scope=await this.scopes.prepare(context,workspace.target.target_id,'document.text.update','owner_data');
      check(scope,'MEETING_SCOPE_REQUIRED',403);
      const allowed=await this.scopes.check({context,scope,effect:'owner_data',target:workspace.target.target_id,operation_kind:'document.text.update',
        task_type:'document.text.update',owner_requested:false,scope_allowed:true,consent_required:true,invocation:'background'});
      if(!allowed.allowed)return to_mcp_result(waiting({status:{reason_code:'MEETING_SCOPE_CONFIRMATION_REQUIRED'},next:{waiting_on:'owner'}})) as unknown as PresentationResult;
      const grant=await this.scopes.store.grant({principal_id:workspace.principal_id,scope_session_id:workspace.scope_session_id,target_id:workspace.target.target_id});
      check(grant,'MEETING_GRANT_REQUIRED',403);
      const operation:Operation={key,principal_id:workspace.principal_id,scope_session_id:workspace.scope_session_id,target_id:workspace.target.target_id,plan,state:'pending'};
      const claim=JSON.parse(Buffer.from(await this.storage.publish('meeting-operations',digest([workspace.principal_id,key]),Buffer.from(canonical(operation)))).toString()) as Operation;
      check(canonical(claim)===canonical(operation),'MEETING_IDEMPOTENCY_CONFLICT',409);
      let result:PresentationResult;
      try{
        await this.observations.guard(workspace.principal_id,workspace.scope_session_id);
        const signal=this.observations.signal(workspace.scope_session_id);signal.throwIfAborted();
        result=this.qualify(operation,await this.ports.invoke({principal_id:workspace.principal_id,target_device_id:grant.target_device_id},'presentation_apply_text',{
          target:workspace.target,plan,idempotency_key:key,execution:{principal_id:workspace.principal_id,grant_id:grant.grant_id,confirmation_id:grant.confirmation_id,
            scope_session_id:workspace.scope_session_id,target_id:grant.target_id,target_device_id:grant.target_device_id,operation_kind:'document.text.update',
            valid_until:new Date(Math.min(Date.parse(grant.expires_at),this.observations.freshUntil(workspace.scope_session_id))).toISOString(),plan_sha256:hash}},signal));
      }catch{result=this.uncertain(operation,'MEETING_EXECUTION_UNKNOWN');}
      return (await this.save({...operation,result,state:['succeeded','failed','cancelled'].includes(result.structuredContent.status.state)?'settled':'pending'})).result!;
    });
  }
}
