import {check} from './contracts.ts';
import type {ModelUsage} from './model-usage.ts';
import type {RegisteredDevice} from './source-authority.ts';
import type {ModelSettingsAuthority} from './model-settings.ts';
export type ModelSettingsUsageSummary=ReturnType<ModelUsage['summary']>;
export interface ModelSettingsPageRequest {revision?:number;offset?:number;draft_id?:string}
export function modelSettingsState(authority:ModelSettingsAuthority) {
  const {environment_id,desired,groups,local_models}=authority.read();return {environment_id,desired,groups,...(local_models?{local_models}:{})};
}
/** Pages one immutable revision or frozen draft; no key ciphertext enters the view. */
export function modelSettingsPage(authority:ModelSettingsAuthority,source:RegisteredDevice,request:ModelSettingsPageRequest={},usage:ModelSettingsUsageSummary|null=null) {
  check(!(request.revision!==undefined&&request.draft_id!==undefined),'MODEL_SETTINGS_PAGE_INVALID');
  const current=authority.read(),draft=request.draft_id?authority.getDraft(source,request.draft_id):undefined;
  const value=draft??authority.readRevision(request.revision??current.desired);
  const currentVersions=authority.readRevision(current.desired).versions;
  const credentials=Object.entries(value.versions).map(([credential_ref,version])=>({credential_ref,version,
    ...(currentVersions[credential_ref]===version?current.credentials[credential_ref]:
      {configured:false,last4:null,updated_at:null,test_status:'key_reentry_required'})}));
  const rows=[...value.snapshot.providers.map(value=>({kind:'provider' as const,value})),
    ...value.snapshot.roles.map(value=>({kind:'role' as const,value})),...credentials.map(value=>({kind:'credential' as const,value}))];
  const offset=request.offset??0;check(Number.isSafeInteger(offset)&&offset>=0&&offset<=rows.length,'MODEL_SETTINGS_PAGE_INVALID');
  const result={environment_id:current.environment_id,revision:value.revision,desired:current.desired,groups:current.groups,usage,...(current.local_models?{local_models:current.local_models}:{}),
    ...(draft?{draft:{draft_id:draft.draft_id,action:draft.action,
      payload:Object.fromEntries(Object.entries(draft.payload).filter(([field])=>!['providers','roles','change_summary','local_entry','local_pin','local_catalog_id'].includes(field)))}}:{}),
    items:[] as typeof rows,next_offset:null as number|null};
  for(let index=offset;index<rows.length&&result.items.length<8;index++){
    const next={...result,items:[...result.items,rows[index]!],next_offset:index+1<rows.length?index+1:null};
    if(Buffer.byteLength(JSON.stringify(next))>8000){check(result.items.length>0,'MODEL_SETTINGS_ROW_TOO_LARGE',413);break;}
    result.items=next.items;result.next_offset=next.next_offset;
  }
  return result;
}
