import {canonical,check,digest} from '../../contracts.ts';
import type {StoragePort} from '../../storage.ts';
import type {ScopeGrant,ScopeRunBinding,ScopeSession} from '../../../../../../../capability/contracts/scope-grant.ts';

/** Consent's existing StoragePort owns these records; this is not another database or ledger. */
export class ScopeStore {
  private readonly flights=new Map<string,Promise<unknown>>();
  private readonly storage:StoragePort;
  constructor(storage:StoragePort) {this.storage=storage;}
  async serial<T>(key:string,work:()=>Promise<T>):Promise<T> {
    const next=(this.flights.get(key)??Promise.resolve()).catch(()=>{}).then(work);
    this.flights.set(key,next);
    try{return await next;}finally{if(this.flights.get(key)===next)this.flights.delete(key);}
  }
  async read<T>(namespace:string,key:string):Promise<T|undefined> {
    try{return JSON.parse(Buffer.from(await this.storage.read(namespace,key)).toString());}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return;}
  }
  private async publish<T>(namespace:string,key:string,value:T):Promise<T> {
    return JSON.parse(Buffer.from(await this.storage.publish(namespace,key,Buffer.from(canonical(value)))).toString());
  }
  session(principal:string,id:string){return this.read<ScopeSession>('scope-sessions',digest([principal,id]));}
  async open(session:ScopeSession) {
    const saved=await this.publish('scope-sessions',digest([session.principal_id,session.id]),session);
    check(canonical(saved)===canonical(session),'SCOPE_SESSION_CONFLICT',409);return saved;
  }
  async replace(session:ScopeSession) {
    check(this.storage.replace,'SCOPE_SESSION_STORAGE_UNAVAILABLE',503);
    await this.storage.replace('scope-sessions',digest([session.principal_id,session.id]),Buffer.from(canonical(session)));
  }
  binding(context:{run_id:string;session_id:string}) {
    return this.read<ScopeRunBinding>('scope-run-bindings',digest([context.run_id,context.session_id]));
  }
  async bind(binding:ScopeRunBinding) {
    const saved=await this.publish('scope-run-bindings',digest([binding.run_id,binding.session_id]),binding);
    check(canonical(saved)===canonical(binding),'SCOPE_RUN_BINDING_CONFLICT',409);return saved;
  }
  private grantKey(grant:{principal_id:string;scope_session_id:string;target_id:string}) {
    return digest([grant.principal_id,grant.scope_session_id,grant.target_id]);
  }
  grant(key:Parameters<ScopeStore['grantKey']>[0]) {return this.read<ScopeGrant>('scope-grants',this.grantKey(key));}
  async saveGrant(grant:ScopeGrant) {
    const saved=await this.publish('scope-grants',this.grantKey(grant),grant);
    check(canonical(saved)===canonical(grant),'SCOPE_GRANT_CONFLICT',409);return saved;
  }
}
