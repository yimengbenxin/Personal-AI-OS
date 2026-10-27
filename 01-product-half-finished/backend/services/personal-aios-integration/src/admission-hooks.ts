import AjvModule from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {canonical, check, digest, sha256} from './contracts.ts';
import type {StoragePort} from './storage.ts';

const schema=JSON.parse(readFileSync(new URL('../../../../../capability/contracts/hermes-hook-input.v1.schema.json',import.meta.url),'utf8'));
const valid=new AjvModule.default({strict:false}).compile(schema);
const namespace='admission-hooks';
type Fields=Record<string,any>;
interface Row {kind:string;profile:string;owner?:string;owners?:string[];session?:string;task?:string;turn?:string;child?:string;input?:string}
export interface PublicCall {session_id:string;task_id:string;turn_id:string}
/** Durable correlation evidence owned by RunAdmission; principal/scope/run are never copied here. */
export class AdmissionHooks {
  private rows=new Map<string,Row>();
  private ready:Promise<void>|undefined;
  private mutation:Promise<unknown>=Promise.resolve();
  private readonly storage:StoragePort;
  private readonly profile:string;
  constructor(storage:StoragePort,profile:string) {this.storage=storage;this.profile=profile;}
  private own<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.mutation.then(async()=>{await this.load();return work();});
    this.mutation=result.catch(()=>undefined);return result;
  }
  private load(){return this.ready??= (async()=>{
    for(const key of await this.storage.list(namespace)){
      const row=JSON.parse(new TextDecoder().decode(await this.storage.read(namespace,key))) as Row;
      if(row.profile===this.profile)this.rows.set(key,row);
    }
  })();}
  private async put(kind:string,id:unknown,fields:Omit<Row,'kind'|'profile'>){
    const key=digest([this.profile,kind,id]),row={kind,profile:this.profile,...fields};
    const held=this.rows.get(key)??JSON.parse(new TextDecoder().decode(await this.storage.publish(namespace,key,Buffer.from(canonical(row))))) as Row;
    check(canonical(held)===canonical(row),'CAPABILITY_HOOK_BINDING_CONFLICT',409);
    this.rows.set(key,held);return held;
  }
  private all(kind:string){return [...this.rows.values()].filter(row=>row.kind===kind);}
  reserve(owner:string,session:string,input:string){return this.own(async()=>{
    await this.put('reservation',owner,{owner,session,input:sha256(input)});
  });}
  accepted(owner:string,session:string){return this.own(async()=>{
    const reservation=this.all('reservation').find(row=>row.owner===owner);
    if(reservation?.session!==session)await this.put('accepted',[owner,session],{owner,session});
    for(const evidence of this.all('evidence'))if(evidence.input===reservation?.input&&!this.turn(evidence.turn!,evidence.task))await this.root(evidence);
  });}
  private turn(turn:string,task?:string){
    const candidates=this.all('turn').filter(row=>row.turn===turn&&(!task||row.task===task));
    check(candidates.length<=1,'CAPABILITY_HOOK_AMBIGUOUS',403);return candidates[0];
  }
  private session(row:Row,session:string){
    return row.session===session||this.all('alias').some(alias=>alias.turn===row.turn&&alias.task===row.task&&alias.session===session)||
      this.all('reservation').some(reservation=>reservation.owner===row.owner&&reservation.session===session);
  }
  private async root(evidence:Row){
    const candidates=this.all('reservation').filter(row=>evidence.owners?.includes(row.owner!)&&row.input===evidence.input&&
      (row.session===evidence.session||this.all('accepted').some(accepted=>accepted.owner===row.owner&&accepted.session===evidence.session)||
        this.all('alias').some(alias=>alias.owner===row.owner&&alias.session===evidence.session)));
    if(candidates.length!==1)return undefined;
    return this.put('turn',[evidence.turn,evidence.task],{owner:candidates[0]!.owner!,
      session:evidence.session!,turn:evidence.turn!,task:evidence.task!});
  }
  private stopped(row:Row){return this.all('end').some(end=>end.turn===row.turn&&end.task===row.task)||
    Boolean(row.child&&this.all('stop').some(stop=>stop.child===row.child));}
  resolve(call:PublicCall,execution=false){return this.own(async()=>{
    const row=call.turn_id&&call.task_id?this.turn(call.turn_id,call.task_id):undefined;
    check(row&&this.session(row,call.session_id),'CAPABILITY_RUN_BINDING_REQUIRED',403);
    check(!execution||!this.stopped(row),'CAPABILITY_HOOK_TURN_ENDED',409);return row.owner!;
  });}
  event(body:unknown):Promise<string|undefined>{return this.own(async()=>{
    check(valid(body),'CAPABILITY_HOOK_INPUT_INVALID');
    const {hook,payload:p}=body as {hook:string;payload:Fields};
    if(hook==='pre_llm_call'||hook==='pre_api_request'){
      check(p.turn_id&&p.task_id&&p.session_id,'CAPABILITY_HOOK_IDS_REQUIRED',403);
      const known=this.turn(p.turn_id,p.task_id);
      if(known){
        check(!this.stopped(known),'CAPABILITY_HOOK_TURN_ENDED',409);
        check(this.session(known,p.session_id)||hook==='pre_api_request','CAPABILITY_HOOK_SESSION_MISMATCH',403);
        await this.put('alias',[p.turn_id,p.task_id,p.session_id],{owner:known.owner!,turn:p.turn_id,task:p.task_id,session:p.session_id});
        return known.owner;
      }
      const children=this.all('child').filter(row=>row.child===p.task_id&&row.session===p.session_id);
      check(children.length<=1,'CAPABILITY_HOOK_AMBIGUOUS',403);
      if(children.length){
        const child=children[0]!;check(!this.all('stop').some(row=>row.child===child.child),'CAPABILITY_HOOK_TURN_ENDED',409);
        return (await this.put('turn',[p.turn_id,p.task_id],{owner:child.owner!,child:child.child!,
          session:p.session_id,turn:p.turn_id,task:p.task_id})).owner;
      }
      const history=(p.conversation_history??[]).filter((row:Fields)=>row.role==='user');
      const current=typeof p.user_message==='string'&&this.all('reservation').some(row=>row.input===sha256(p.user_message));
      const source=current?p.user_message:history.length?history.at(-1).content:p.user_message;
      check(typeof source==='string','CAPABILITY_HOOK_INPUT_REQUIRED',403);
      const input=sha256(source),owners=this.all('reservation').filter(row=>row.input===input).map(row=>row.owner!);
      if(!owners.length)return undefined;
      const evidence=await this.put('evidence',[p.turn_id,p.task_id],{session:p.session_id,task:p.task_id,turn:p.turn_id,input,owners});
      return (await this.root(evidence))?.owner;
    }
    if(hook==='subagent_start'){
      const parent=this.turn(p.parent_turn_id,p.parent_subagent_id||undefined);
      check(parent&&!this.stopped(parent)&&p.parent_session_id&&p.child_session_id&&p.child_subagent_id,
        'CAPABILITY_PARENT_BINDING_REQUIRED',403);
      await this.put('alias',[parent.turn,parent.task,p.parent_session_id],{owner:parent.owner!,turn:parent.turn!,task:parent.task!,session:p.parent_session_id});
      return (await this.put('child',p.child_subagent_id,{owner:parent.owner!,session:p.child_session_id,child:p.child_subagent_id})).owner;
    }
    if(hook==='subagent_stop'){
      const children=this.all('child').filter(row=>(!p.child_subagent_id||row.child===p.child_subagent_id)&&
        (row.session===p.child_session_id||this.all('turn').some(turn=>turn.child===row.child&&this.session(turn,p.child_session_id))));
      check(children.length===1,'CAPABILITY_CHILD_BINDING_REQUIRED',403);
      const child=children[0]!;
      if(p.parent_turn_id){const parent=this.turn(p.parent_turn_id,p.parent_subagent_id||undefined);
        check(parent?.owner===child.owner,'CAPABILITY_PARENT_BINDING_REQUIRED',403);}
      await this.put('stop',child.child,{owner:child.owner!,child:child.child!});return child.owner;
    }
    if(hook==='on_session_end'){
      const row=this.turn(p.turn_id,p.task_id);
      if(row&&p.session_id){
        await this.put('alias',[row.turn,row.task,p.session_id],{owner:row.owner!,turn:row.turn!,task:row.task!,session:p.session_id});
        await this.put('end',[row.turn,row.task],{owner:row.owner!,turn:row.turn!,task:row.task!});
      }
      return row?.owner;
    }
    if(['on_session_reset','on_session_delete','on_session_finalize'].includes(hook)){
      for(const row of this.all('turn'))if(this.session(row,p.old_session_id||p.session_id))
        await this.put('end',[row.turn,row.task],{owner:row.owner!,turn:row.turn!,task:row.task!});
    }
    return undefined;
  });}
}
