import {canonical,check,id} from '../../contracts.ts';
import {ScopeStore} from './scope-store.ts';
import {SCOPE_SESSION_CAP_MS,SCOPE_DISCONNECT_MS,type ScopeSession,type ScopeEndReason,type ScopeTarget} from '../../../../../../../capability/contracts/scope-grant.ts';

export class ScopeSessions {
  readonly store:ScopeStore;private readonly now:()=>number;
  private readonly live=new Set<string>();private readonly pendingEnd=new Map<string,ScopeSession>();
  constructor(store:ScopeStore,now:()=>number=Date.now) {this.store=store;this.now=now;}
  private key(principal:string,sessionId:string){return canonical([principal,sessionId]);}
  connected(session:ScopeSession){return this.live.has(this.key(session.principal_id,session.id));}
  async open(input:ScopeTarget&{id:string;principal_id:string;allowed_operation_kinds:string[]}):Promise<ScopeSession> {
    [input.id,input.principal_id,input.target_id,input.target_device_id].forEach(id);
    check(input.allowed_operation_kinds.length>0&&input.allowed_operation_kinds.length<=32&&
      new Set(input.allowed_operation_kinds).size===input.allowed_operation_kinds.length&&
      input.allowed_operation_kinds.every(kind=>typeof kind==='string'&&/^[a-z][a-z0-9_.:-]{0,99}$/u.test(kind)),
      'SCOPE_OPERATION_KINDS_INVALID');
    return this.store.serial(input.id,async()=>{
      const prior=await this.store.session(input.principal_id,input.id);
      if(prior){
        check(prior.target_id===input.target_id&&prior.target_device_id===input.target_device_id&&
          canonical(prior.allowed_operation_kinds)===canonical(input.allowed_operation_kinds),'SCOPE_SESSION_CONFLICT',409);
        return (await this.current(input.principal_id,input.id,false))!;
      }
      const at=this.now(),opened_at=new Date(at).toISOString();
      const saved=await this.store.open({...input,version:1,revision:1,state:'active',opened_at,last_seen_at:opened_at,
        expires_at:new Date(at+SCOPE_SESSION_CAP_MS).toISOString()});
      this.live.add(this.key(input.principal_id,input.id));return saved;
    });
  }
  /** Every dispatch checks deadlines, including after a restart; timers are not permission. */
  async current(principal:string,sessionId:string,serial=true):Promise<ScopeSession|undefined> {
    const read=async()=>{
      const key=this.key(principal,sessionId),ending=this.pendingEnd.get(key);
      if(ending){await this.store.replace(ending);this.pendingEnd.delete(key);return ending;}
      const session=await this.store.session(principal,sessionId);if(!session||session.state==='ended')return session;
      const reason=this.now()>=Date.parse(session.expires_at)?'expired':session.disconnected_at&&
        this.now()-Date.parse(session.disconnected_at)>=SCOPE_DISCONNECT_MS||!session.disconnected_at&&!this.connected(session)&&
        this.now()-Date.parse(session.last_seen_at??session.opened_at)>=SCOPE_DISCONNECT_MS?'disconnected':undefined;
      if(reason)return this.finish(session,reason);return session;
    };
    return serial?this.store.serial(sessionId,read):read();
  }
  private async finish(session:ScopeSession,reason:ScopeEndReason) {
    const next:ScopeSession={...session,revision:session.revision+1,state:'ended',ended_at:new Date(this.now()).toISOString(),end_reason:reason};
    const key=this.key(session.principal_id,session.id);this.live.delete(key);this.pendingEnd.set(key,next);
    await this.store.replace(next);this.pendingEnd.delete(key);return next;
  }
  async end(principal:string,sessionId:string,reason:ScopeEndReason='explicit') {
    check(['explicit','expired','disconnected','companion_off','privacy_pause','target_changed','device_paused','pairing_revoked'].includes(reason),'SCOPE_END_REASON_INVALID');
    return this.store.serial(sessionId,async()=>{
      const session=await this.current(principal,sessionId,false);check(session,'SCOPE_SESSION_NOT_FOUND',404);
      return session.state==='ended'?session:this.finish(session,reason);
    });
  }
  async connection(principal:string,sessionId:string,connected:boolean,target:ScopeTarget) {
    return this.store.serial(sessionId,async()=>{
      const session=await this.current(principal,sessionId,false);check(session,'SCOPE_SESSION_NOT_FOUND',404);
      if(session.state==='ended')return session;
      if(session.target_id!==target.target_id||session.target_device_id!==target.target_device_id)return this.finish(session,'target_changed');
      const next={...session,revision:session.revision+1};
      const key=this.key(principal,sessionId);
      if(connected){delete next.disconnected_at;next.last_seen_at=new Date(this.now()).toISOString();}
      else {this.live.delete(key);if(!next.disconnected_at)next.disconnected_at=new Date(this.now()).toISOString();}
      await this.store.replace(next);if(connected)this.live.add(key);return next;
    });
  }
  async bindRun(context:{run_id:string;session_id:string},principal:string,sessionId:string) {
    [context.run_id,context.session_id,principal,sessionId].forEach(id);
    return this.store.serial(sessionId,async()=>{
      const session=await this.current(principal,sessionId,false);check(session?.state==='active'&&!session.disconnected_at&&this.connected(session),'SCOPE_SESSION_NOT_ACTIVE',409);
      return this.store.bind({...context,principal_id:principal,scope_session_id:sessionId,target_id:session.target_id,target_device_id:session.target_device_id});
    });
  }
}
