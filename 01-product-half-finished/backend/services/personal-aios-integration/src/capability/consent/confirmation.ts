import {randomUUID} from 'node:crypto';
import {canonical,check,digest,ContractError} from '../../contracts.ts';
import type {StoragePort} from '../../storage.ts';
import type {OwnerConfirmation} from '../../hermes-client.ts';
import type {ToolCall} from '../../runtime.ts';
import {VoiceConfirmations,nativeApprovalId,type VoiceConfirmation,type VoiceConfirmationDecision} from '../../voiceprint/confirmation.ts';
import {decideConsent,type ConsentApproval,type ConsentPorts,type Decision} from './decision.ts';
import {scopeConfirmation} from './scope-view.ts';
import type {FrozenCall} from './call.ts';
import {waiting,cancelled,unknown,value,to_mcp_result,type Receipt} from '../../../../../../../capability/sdk/ts/receipt.ts';

/** Implemented by the existing gateway/transport. No second ledger, dispatcher or renderer lives here. */
export interface ConfirmationPorts {
  gates(call:FrozenCall,approved:boolean):ConsentPorts;
  execute(call:FrozenCall):Promise<Receipt>;
  /** The ledger keeps one current phase per call; replaying a phase is idempotent. */
  receipt(call:FrozenCall,body:Receipt,phase:'waiting'|'result'):Promise<void>;
  /** Must admit a new run, idempotent by eventId, with the receipt attached to that run's tree. */
  followUp(call:FrozenCall,body:Receipt,eventId:string):Promise<void>;
  error(error:unknown):void;
}
export interface ProtectedAuthorities {
  spend(call:FrozenCall,approval?:ConsentApproval):Promise<Decision>;
  selfChange(call:FrozenCall,approval?:ConsentApproval):Promise<Decision>;
}
interface Notification {state:'pending'|'admitted'|'undeliverable';reason?:string}

/** Durable frozen calls use the existing confirmation records; execution markers only prevent duplicate effects. */
export class CapabilityConfirmations {
  private readonly flights=new Map<string,Promise<Receipt>>();
  private readonly executions=new Map<string,FrozenCall>();
  private recovery:Promise<void>|undefined;
  private closed=false;
  private readonly storage:StoragePort;private readonly cards:VoiceConfirmations;private readonly ports:ConfirmationPorts;
  constructor(storage:StoragePort,cards:VoiceConfirmations,ports:ConfirmationPorts){
    this.storage=storage;this.cards=cards;this.ports=ports;
    cards.setCallExpiryHandler(record=>this.settle(record).then(()=>{},error=>ports.error(error)));
  }
  async close():Promise<void> {
    this.closed=true;
    this.cards.setCallExpiryHandler(undefined);
    await this.recovery?.catch(()=>{});
    while(this.flights.size)await Promise.allSettled([...this.flights.values()]);
  }
  private executionKey(context:ToolCall['context']):string{return digest([context.run_id,context.session_id,context.tool_call_id]);}
  /** A view of the approved execution's original admission, valid only while that exact call is executing. */
  executing(context:ToolCall['context']):FrozenCall|undefined{return this.executions.get(this.executionKey(context));}
  private async read<T>(namespace:string,key:string):Promise<T|undefined>{
    try{return JSON.parse(Buffer.from(await this.storage.read(namespace,key)).toString());}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  private async publish<T>(namespace:string,key:string,value:T):Promise<T>{
    return JSON.parse(Buffer.from(await this.storage.publish(namespace,key,Buffer.from(canonical(value)))).toString());
  }
  private identity(call:FrozenCall):string{
    const {admission,...execution}=call;
    return canonical({...execution,principal_id:admission.d.principal_id,processed_event_id:admission.d.processed_event_id});
  }
  async decide(input:FrozenCall):Promise<Decision>{
    const call=JSON.parse(JSON.stringify(input)) as FrozenCall;
    delete call.args.owner_requested;
    scopeConfirmation(call.consent);
    check(!('effect' in call.args),'EFFECT_ARGUMENT_REMOVED');
    const requestId=digest({key:call.idempotency_key,context:call.consent.context,task_id:call.task_id});
    const cardId=nativeApprovalId(
      call.admission.d.principal_id,call.consent.context.run_id,requestId);
    const prior=await this.read<VoiceConfirmation>('voice-confirmations',cardId);
    if(prior){
      check(this.identity(prior.capability_call!)===this.identity(call),'CAPABILITY_FROZEN_CALL_CONFLICT',409);
      const saved=await this.read<Receipt>('capability-call-results',cardId),body=saved??this.waiting(prior);
      await this.ports.receipt(call,body,saved?'result':'waiting');
      return {action:'block',message:JSON.stringify(to_mcp_result(body))};
    }
    const decision=await decideConsent(this.ports.gates(call,false),call.consent);
    if(decision.action!=='approve')return decision;
    const record=await this.cards.openCall(call,requestId,decision.message),body=this.waiting(record);
    await this.ports.receipt(call,body,'waiting');
    return {action:'block',message:JSON.stringify(to_mcp_result(body))};
  }
  private waiting(record:VoiceConfirmation):Receipt{
    const rows=record.capability_call?.consent.work_items;
    return {...waiting({status:{reason_code:'needs_confirmation'},next:{waiting_on:'owner',
      needs_confirmation:record.confirmation_id,until:new Date(record.expires_at_ms).toISOString()}}),
      ...(rows?{job:{id:record.capability_call!.idempotency_key,revision:1},work_items:rows.map(row=>({...row,state:'waiting' as const,effect_refs:[]}))}:{})};
  }
  async answer(id:string,device:{principal_id:string;device_id:string;device_type:string},choice:'approve'|'deny'):Promise<void>{
    const {record,decision}=await this.cards.decide(id,device,choice);
    // A scope panel's success ACK means its grant is durable, not that native editing is finished.
    if(decision.choice!=='deny'&&record.capability_call?.consent.scope?.request){
      const call=record.capability_call,authorized=await decideConsent(this.ports.gates(call,true),call.consent,
        {request_id:record.approval_request_id!,confirmation:decision.confirmation as OwnerConfirmation});
      if(authorized.action!=='allow'){
        void this.settle(record).catch(error=>this.ports.error(error));
        check(false,'SCOPE_CONFIRMATION_NOT_GRANTED',409);
      }
    }
    // Existing single-call decisions retain their immediate durable ACK.
    void this.settle(record).catch(error=>this.ports.error(error));
  }
  recover():Promise<void>{
    if(this.closed)return Promise.resolve();
    return this.recovery??=this.restore().finally(()=>{this.recovery=undefined;});
  }
  private async restore():Promise<void>{
    for(const key of await this.storage.list('voice-confirmations')){
      if(this.closed)return;
      try {
      const record=(await this.read<VoiceConfirmation>('voice-confirmations',key))!;
      if(record.kind!=='capability_call')continue;
      const notification=await this.read<Notification>('capability-call-notifications',key);
      if(notification&&notification.state!=='pending')continue;
      const decision=await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions',key);
      if(this.closed)return;
      if(decision||this.cards.callExpired(record))await this.settle(record);
      else await this.cards.openCall(record.capability_call!,record.approval_request_id!,record.text!);
      }catch(error){this.ports.error(error);}
    }
  }
  settle(record:VoiceConfirmation):Promise<Receipt>{
    const key=record.confirmation_id,existing=this.flights.get(key);
    if(existing)return existing;
    const flight=this.finish(record).finally(()=>{this.flights.delete(key);});
    this.flights.set(key,flight);return flight;
  }
  private uncertain(call:FrozenCall,reason:string):Receipt{
    return unknown({status:{reason_code:reason},unknowns:[{about:call.consent.target,why:reason}],
      values:[value('idempotency_key',call.idempotency_key,'key','observed','platform:frozen-call',new Date().toISOString())],
      next:{retry:'after_check',check_with:call.check_with,waiting_on:'none'}});
  }
  private async finish(record:VoiceConfirmation):Promise<Receipt>{
    const key=record.confirmation_id,call=record.capability_call!;
    let body=await this.read<Receipt>('capability-call-results',key);
    if(!body){
      // Once dispatch was claimed, later permission changes cannot prove that the effect did not happen.
      if(await this.read('capability-call-executions',key))body=this.uncertain(call,'EXECUTION_RECOVERY_CHECK_REQUIRED');
      else {
        const decision=await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions',key)??await this.cards.expireCall(record);
        if(decision.choice==='deny')body=cancelled({status:{reason_code:decision.reason==='timeout'?'confirmation_expired':
          decision.reason==='interrupted'?'confirmation_cancelled':'confirmation_denied'}});
        else {
          const authorized=await decideConsent(this.ports.gates(call,true),call.consent,
            {request_id:record.approval_request_id!,confirmation:decision.confirmation as OwnerConfirmation});
          if(authorized.action!=='allow')body=cancelled({status:{reason_code:'confirmation_not_granted'}});
          else {
            const token=randomUUID(),claim=await this.publish('capability-call-executions',key,{token});
            if(claim.token!==token)body=this.uncertain(call,'EXECUTION_RECOVERY_CHECK_REQUIRED');
            else {
              const executionKey=this.executionKey(call.consent.context);this.executions.set(executionKey,call);
              try{body=await this.ports.execute(structuredClone(call));}
              catch{body=this.uncertain(call,'TRANSPORT_DISCONNECTED');}
              finally{this.executions.delete(executionKey);}
            }
          }
        }
      }
      body=await this.publish('capability-call-results',key,body);
    }
    await this.ports.receipt(call,body,'result');
    const notification=await this.read<Notification>('capability-call-notifications',key);
    if(notification&&notification.state!=='pending')return body;
    const save=(value:Notification)=>this.storage.replace!('capability-call-notifications',key,Buffer.from(canonical(value)));
    await save({state:'pending'});
    try{await this.ports.followUp(call,body,`capability-result:${key}`);}
    catch(error){
      // The original source must still be authorized. Its removal ends this notification, not the effect or service.
      if(!(error instanceof ContractError)||error.status!==403)throw error;
      await save({state:'undeliverable',reason:error.code});return body;
    }
    // This acknowledges admission of the follow-up run. OUT still owns the device's rendered/played ACK.
    await save({state:'admitted'});
    return body;
  }
}
