import {canonical,check} from '../../contracts.ts';
import type {StoragePort} from '../../storage.ts';
import {nativeApprovalId} from '../../voiceprint/confirmation.ts';
import type {ConsentCall,ConsentApproval} from './decision.ts';
import {ScopeStore} from './scope-store.ts';
import {ScopeSessions} from './scope-session.ts';
import type {ScopeCall,ScopeGrant,ScopeGrantRequest} from '../../../../../../../capability/contracts/scope-grant.ts';

export interface ScopeConsentPort {
  check(call:ConsentCall):Promise<{allowed:boolean;force_once:boolean}>;
  approve(call:ConsentCall,approval:ConsentApproval):Promise<void>;
}
/** Only platform composition prepares/binds calls; tool arguments never supply scope authority. */
export class ScopeGrants implements ScopeConsentPort {
  readonly store:ScopeStore;readonly sessions:ScopeSessions;
  private readonly owner:(context:ConsentCall['context'])=>Promise<string>;private readonly now:()=>number;
  constructor(storage:StoragePort,owner:(context:ConsentCall['context'])=>Promise<string>,now:()=>number=Date.now) {
    this.owner=owner;this.now=now;
    this.store=new ScopeStore(storage);this.sessions=new ScopeSessions(this.store,now);
  }
  /** Frozen confirmations verify their original admission, even after the run has ended. */
  forOwner(owner:(context:ConsentCall['context'])=>Promise<string>):ScopeConsentPort {
    return {check:call=>this.check(call,owner),approve:(call,approval)=>this.approve(call,approval,owner)};
  }
  async prepare(context:ConsentCall['context'],target:string,operation_kind:string,effect:ConsentCall['effect']):Promise<ScopeCall|undefined> {
    const bound=await this.store.binding(context);if(!bound)return;
    check(await this.owner(context)===bound.principal_id,'SCOPE_PRINCIPAL_MISMATCH',403);
    const session=await this.sessions.current(bound.principal_id,bound.scope_session_id);
    check(session,'SCOPE_SESSION_NOT_FOUND',404);
    const request:ScopeGrantRequest={scope_session_id:session.id,target_id:session.target_id,target_device_id:session.target_device_id,
      expires_at:session.expires_at,allowed_operation_kinds:[...session.allowed_operation_kinds]};
    return {scope_session_id:session.id,target_id:target,target_device_id:bound.target_device_id,operation_kind,
      ...(effect==='owner_data'&&target===session.target_id&&session.allowed_operation_kinds.includes(operation_kind)?{request}:{})};
  }
  private async bound(call:ConsentCall,serial=true,owner=this.owner) {
    const scope=call.scope!;const principal=await owner(call.context),bound=await this.store.binding(call.context);
    check(bound&&bound.principal_id===principal&&bound.scope_session_id===scope.scope_session_id&&
      bound.target_device_id===scope.target_device_id&&scope.target_id===call.target&&scope.operation_kind===call.operation_kind,
      'SCOPE_CALL_BINDING_INVALID',403);
    const session=await this.sessions.current(principal,bound.scope_session_id,serial);
    check(session?.state==='active','SCOPE_SESSION_ENDED',409);
    check(!session.disconnected_at&&this.sessions.connected(session),'SCOPE_SESSION_DISCONNECTED',409);
    if(scope.request){
      const expected={scope_session_id:session.id,target_id:session.target_id,target_device_id:session.target_device_id,
        expires_at:session.expires_at,allowed_operation_kinds:session.allowed_operation_kinds};
      check(canonical(scope.request)===canonical(expected)&&call.target===session.target_id&&
        session.allowed_operation_kinds.includes(scope.operation_kind),'SCOPE_REQUEST_INVALID',403);
    }
    return {principal,session};
  }
  async check(call:ConsentCall,owner=this.owner) {
    if(!call.scope||call.effect==='observe'||call.effect==='workspace')return {allowed:false,force_once:false};
    return this.store.serial(call.scope.scope_session_id,async()=>{
      const {principal,session}=await this.bound(call,false,owner);
      // No class except owner_data can use a grant, even if a stored operation name matches.
      if(call.effect!=='owner_data')return {allowed:false,force_once:true};
      const grant=await this.store.grant({principal_id:principal,scope_session_id:session.id,target_id:call.target});
      const allowed=!!grant&&grant.target_device_id===call.scope!.target_device_id&&call.target===session.target_id&&
        this.now()<Date.parse(grant.expires_at)&&grant.allowed_operation_kinds.includes(call.operation_kind!);
      return {allowed,force_once:!allowed};
    });
  }
  /** Called after the existing per-invocation owner confirmation gate has accepted its receipt. */
  async approve(call:ConsentCall,approval:ConsentApproval,owner=this.owner) {
    if(!call.scope?.request||call.effect!=='owner_data')return;
    await this.store.serial(call.scope.scope_session_id,async()=>{
      const {principal,session}=await this.bound(call,false,owner);
      const confirmation=approval.confirmation;
      check(confirmation.confirmed_by===principal&&confirmation.confirmation_id===nativeApprovalId(principal,call.context.run_id,approval.request_id)&&
        typeof confirmation.surface?.device_id==='string'&&typeof confirmation.surface.device_type==='string'&&
        Number.isFinite(Date.parse(confirmation.confirmed_at))&&Date.parse(confirmation.confirmed_at)<=this.now()&&
        Date.parse(confirmation.confirmed_at)>=Date.parse(session.opened_at),'SCOPE_CONFIRMATION_INVALID',403);
      const grant:ScopeGrant={version:1,...call.scope!.request!,principal_id:principal,grant_id:confirmation.confirmation_id,
        confirmation_id:confirmation.confirmation_id,confirmed_at:confirmation.confirmed_at};
      const existing=await this.store.grant(grant);
      if(existing){check(existing.target_device_id===grant.target_device_id&&
        canonical(existing.allowed_operation_kinds)===canonical(grant.allowed_operation_kinds),'SCOPE_GRANT_CONFLICT',409);return;}
      await this.store.saveGrant(grant);
    });
  }
}
