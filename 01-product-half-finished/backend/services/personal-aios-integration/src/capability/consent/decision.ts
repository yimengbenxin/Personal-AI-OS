import {ContractError} from '../../contracts.ts';
import type {ToolCall} from '../../runtime.ts';
import type {OwnerConfirmation} from '../../hermes-client.ts';
import type {EffectKind} from '../../../../../../../capability/sdk/ts/receipt.ts';
import type {ScopeCall} from '../../../../../../../capability/contracts/scope-grant.ts';
import type {ScopeConsentPort} from './scope-decision.ts';

/** gateway-api.v1 Decision; consent does not own the gateway or its catalog. */
export type Decision = {action:'allow'} | {action:'modify';args:Record<string,unknown>} |
  {action:'block';message:string} | {action:'approve';message:string;rule_key:string};
export interface ConsentApproval {request_id:string;confirmation:OwnerConfirmation}
export interface ConsentCall {
  context:ToolCall['context']; effect:EffectKind; target:string; task_type:string;
  owner_requested:boolean; summary?:string; ride_ok?:boolean;
  /** Resolved by the admission/catalog authorities, never by tool arguments. */
  scope_allowed:boolean; consent_required:boolean;
  invocation?:'interactive'|'background'|'cron';
  /** Manifest operation and platform-bound scope, never copied from model arguments. */
  operation_kind?:string; scope?:ScopeCall;
  preview_items?:string[];work_items?:import('../../../../../../../capability/contracts/work-items.ts').WorkItem[];
}
export interface ConsentPorts {
  effectConsent(context:ToolCall['context'],effect:Record<string,unknown>,approved?:boolean,
    rideOk?:boolean,requestId?:string,confirmation?:OwnerConfirmation,forceOnce?:boolean):Promise<{
      status:string;scope?:Record<string,unknown>;approval?:unknown;
    }>;
  /** Existing payment flow AND the executor's live cashier check; no remembered permission. */
  spend(call:ConsentCall,approval?:ConsentApproval):Promise<Decision>;
  /** Existing exact-candidate release authority; ordinary packages retain their current pipeline. */
  selfChange(call:ConsentCall,approval?:ConsentApproval):Promise<Decision>;
  scopes?:ScopeConsentPort;
}
const legacy = {observe:'read',owner_data:'file_edit',send:'send',account:'login',delete:'delete',physical:'external'} as const;
const confirmationLabel = {observe:'读取',owner_data:'修改资料',send:'发送内容',account:'账号操作',
  delete:'删除',physical:'现实操作',workspace:'工作区操作',spend:'付款',self_change:'系统变更'};

/** Only changes the trigger of the existing gates. Ungated families remain explicitly ungated. */
export async function decideConsent(ports:ConsentPorts,call:ConsentCall,
  approval?:ConsentApproval):Promise<Decision> {
  if(!call.scope_allowed)return {action:'block',message:'CAPABILITY_SCOPE_DENIED'};
  if(call.scope&&!ports.scopes)return {action:'block',message:'SCOPE_AUTHORITY_REQUIRED'};
  try {
    if(call.effect==='spend')return await ports.spend(call,approval);
    if(call.effect==='self_change')return await ports.selfChange(call,approval);
    const scope=await ports.scopes?.check(call);
    if(scope?.allowed)return {action:'allow'};
    if((!call.consent_required&&!scope?.force_once)||call.effect==='workspace')return {action:'allow'};
    const effect={kind:legacy[call.effect],task_type:call.task_type,requested:call.owner_requested,
      ...(call.effect==='send'?{recipient:call.target}:{}),...(call.summary?{summary:call.summary}:{})};
    const result=await ports.effectConsent(call.context,effect,!!approval,call.ride_ok===true,
      approval?.request_id,approval?.confirmation,scope?.force_once);
    if(result.status==='allowed'){
      if(approval)await ports.scopes?.approve(call,approval);
      return {action:'allow'};
    }
    if(result.status==='confirmation_required'&&call.invocation==='cron')return {action:'block',message:'EFFECT_CONFIRMATION_REQUIRES_OWNER_PHONE'};
    if(result.status==='confirmation_required')return {action:'approve',
      message:`请确认：${confirmationLabel[call.effect]}；对象：${call.target}${call.summary?'；内容预览：'+call.summary:''}`+
        (call.scope?.request?`；本次会话仅允许：${call.scope.request.allowed_operation_kinds.join('、')}；仅此文件和电脑；会话结束即失效，最迟 ${call.scope.request.expires_at}。发送、删除、付款、账号和系统变更仍须各自授权。`:''),
      rule_key:JSON.stringify(result.scope)};
    return {action:'block',message:'EFFECT_CONSENT_NOT_GRANTED'};
  } catch(error) {
    return {action:'block',message:error instanceof ContractError?error.code:'EFFECT_CONSENT_UNAVAILABLE'};
  }
}
