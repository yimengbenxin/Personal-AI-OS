import type test from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type ProcessedEvent} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {effectConsent} from '../src/effect-consent.ts';
import {sendConsentStorage} from '../src/capability/send-consent-storage.ts';
import {sendIdentity} from '../src/capability/send-identity.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import type {AdmissionEntry} from '../src/admission.ts';
import {nativeApprovalId} from '../src/voiceprint/confirmation.ts';

export const directory={platforms:{wechat:[{name:'测试·联系人'},{name:'另一个人'}]}};
export const tools=packageCatalog({enabled:['wechat-mac','messaging','phone'],gateway:['wechat-mac','messaging','phone']});
export const records=JSON.parse(await readFile(new URL('./fixtures/send-consents-20261019.json',import.meta.url),'utf8'));
export const recordScope=(record:any)=>({principal_id:record.principal_id,kind:record.kind,task_type:record.task_type,recipient:record.recipient});
export async function sendFixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'send-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),context={run_id:'run',session_id:'session',tool_call_id:'call'};
  const d={principal_id:'owner-fixture',user_identity:'owner-fixture',origin:'explicit_user_prompt',
    device_type:'phone',device_id:'fixture-phone',media_type:'text',content:{text:'发送'},processing:{path_id:'text'},
    source:{channel:'chat'},speakers:[]} as unknown as ProcessedEvent;
  const entry={d,record:{run_id:'run',session_id:'session',state:'running'}} as AdmissionEntry;
  const ports={storage,admission:{find:()=>entry},ownerOrigin:async()=>undefined,paymentSource:()=>({ride_allowed:false})};
  async function seed(record:any){await storage.publish('effect-consents',digest(recordScope(record)),Buffer.from(canonical(record)));}
  const identity=(name:string,recipient='wechat:name:测试联系人',args:Record<string,unknown>={})=>sendIdentity(tools.get('mcp__wechat-mac__'+name)!,{
    tool_name:'mcp__wechat-mac__'+name,args,task_id:'task',session_id:'session',api_request_id:'run',tool_call_id:'call',turn_id:'turn',
    prepared:{target:recipient,legacy_recipients:['wechat:测试联系人','wechat:测试·联系人']}});
  async function decide(name:string,recipient?:string,approved=false,requested=true,toolCall='call'){
    const resolved=identity(name,recipient),bound={...context,tool_call_id:toolCall};
    return effectConsent({...ports,storage:sendConsentStorage(storage,resolved)},bound,
      {kind:'send',recipient:resolved.recipient,task_type:resolved.task_type,requested},approved,false,'request',{
        confirmation_id:nativeApprovalId(d.principal_id,'run','request'),confirmed_by:d.principal_id,
        surface:{device_id:'fixture-phone',device_type:'phone'},confirmed_at:'2026-10-26T00:00:00.000Z'});
  }
  return {root,storage,context,ports,entry,seed,identity,decide};
}
