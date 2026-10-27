import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {PosixStorage} from '../src/storage.ts';
import {ScopeGrants} from '../src/capability/consent/scope-decision.ts';
import {effectConsent} from '../src/effect-consent.ts';
import {nativeApprovalId} from '../src/voiceprint/confirmation.ts';
import type {ConsentCall,ConsentPorts} from '../src/capability/consent/decision.ts';
import type {AdmissionEntry} from '../src/admission.ts';

export async function scopeFixture(t:TestContext,kinds=['document.text.update']) {
  const dir=await mkdtemp(join(tmpdir(),'scope-grant-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const storage=new PosixStorage(dir);let time=Date.parse('2026-10-26T00:00:00Z'),principal='owner';
  const now=()=>time,authority=new ScopeGrants(storage,async()=>principal,now);
  const context={run_id:'run',session_id:'conversation',tool_call_id:'call'};
  const input={id:'scope:demo',principal_id:'owner',target_id:'deck:demo',target_device_id:'mac:demo',allowed_operation_kinds:kinds};
  await authority.sessions.open(input);await authority.sessions.bindRun(context,'owner',input.id);
  const bound={d:{principal_id:'owner',device_id:'phone',device_type:'phone',processed_event_id:'d:request',origin:'explicit_user_prompt',
    media_type:'text',user_identity:'owner',content:{text:'演示改稿'},processing:{path_id:'text'},source:{channel:'chat'},speakers:[]},
    record:{run_id:context.run_id,session_id:context.session_id,state:'running'}} as unknown as AdmissionEntry;
  const effectPorts={admission:{find:()=>bound},storage,ownerOrigin:async()=>undefined,paymentSource:()=>({ride_allowed:false})};
  const gates:ConsentPorts={scopes:authority,effectConsent:(...args)=>effectConsent(effectPorts,...args),
    spend:async()=>({action:'block',message:'LIVE_CASHIER_REQUIRED'}),selfChange:async()=>({action:'block',message:'EXACT_RELEASE_REQUIRED'})};
  const call:ConsentCall={context,effect:'owner_data',target:input.target_id,task_type:kinds[0]!,operation_kind:kinds[0]!,
    owner_requested:true,scope_allowed:true,consent_required:true,
    scope:(await authority.prepare(context,input.target_id,kinds[0]!,'owner_data'))!};
  const approval={request_id:'request',confirmation:{confirmation_id:nativeApprovalId('owner',context.run_id,'request'),confirmed_by:'owner',
    surface:{device_id:'mac:demo',device_type:'mac'},confirmed_at:new Date(now()).toISOString()}};
  return {storage,authority,gates,call,approval,input,context,effectPorts,bound,now,
    advance:(ms:number)=>{time+=ms;},principal:(value:string)=>{principal=value;}};
}
