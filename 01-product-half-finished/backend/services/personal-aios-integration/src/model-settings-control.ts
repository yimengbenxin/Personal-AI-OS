import {createHash} from 'node:crypto';
import {canonical,check} from './contracts.ts';
import type {RegisteredDevice} from './source-authority.ts';
import type {PaymentKeys} from './payment/keys.ts';
import type {SignedInput} from './payment/contracts.ts';
import type {SettingsDraftRequest} from './model-settings-contract.ts';
import {modelSettingsPage,modelSettingsState,type ModelSettingsPageRequest,type ModelSettingsUsageSummary} from './model-settings-view.ts';
import type {ModelSettingsAuthority} from './model-settings.ts';
interface ControlOptions {
  authority:ModelSettingsAuthority;keys:PaymentKeys;
  revalidate:(source:RegisteredDevice)=>Promise<RegisteredDevice>;
  devices:(principal:string)=>Promise<RegisteredDevice[]>;
  usage?:(source:RegisteredDevice)=>ModelSettingsUsageSummary|null;
}
const fingerprint=(input:SignedInput)=>createHash('sha256').update(canonical({statement_b64:input.statement_b64,signature_b64:input.signature_b64})).digest('hex');
/** Maps formal controls to the existing settings and device-key authorities. */
export class ModelSettingsControl {
  private readonly options:ControlOptions;
  constructor(options:ControlOptions) {this.options=options;}
  async dispatch(source:RegisteredDevice,body:Record<string,unknown>):Promise<unknown> {
    source=await this.options.revalidate(source);
    check(source.device_type==='phone'||source.device_type==='mac','MODEL_SETTINGS_TERMINAL_NOT_ALLOWED',403);
    const {authority,keys}=this.options,operation=String(body.operation);
    if(operation==='model_settings_read')return modelSettingsPage(authority,source,body.request as ModelSettingsPageRequest|undefined,this.options.usage?.(source)??null);
    if(operation==='model_settings_watch')return modelSettingsState(authority);
    if(operation==='model_settings_key_challenge')return keys.challenge(source,'model_settings_publish_key');
    if(operation==='model_settings_publish_key'){
      await keys.publishModelSettings(source,{...body.request as {public_x963_b64:string},statement_b64:body.statement_b64 as string,signature_b64:body.signature_b64 as string});
      return {device_id:source.device_id,purpose:'model_settings',key_sha256:createHash('sha256').update(Buffer.from((body.request as {public_x963_b64:string}).public_x963_b64,'base64')).digest('hex')};
    }
    if(operation==='model_settings_pending_macs'){
      check(source.device_type==='phone','PAYMENT_SETTINGS_DEVICE_REQUIRED',403);await keys.assertModelSettings(source);
      const devices=(await this.options.devices(source.principal_id)).filter(device=>device.principal_id===source.principal_id&&device.device_type==='mac');
      const pending=devices.flatMap(device=>{
        const key=keys.pendingModelSettings(device),active=keys.registered(device,'model_settings');
        if(active&&(!key||active.public_x963_b64===key.public_x963_b64))return [];
        return [{device_id:device.device_id,purpose:'model_settings',public_x963_b64:key?.public_x963_b64??null,
          key_sha256:key?createHash('sha256').update(Buffer.from(key.public_x963_b64,'base64')).digest('hex'):null}];
      }).sort((a,b)=>a.device_id.localeCompare(b.device_id));
      const offset=(body.request as {offset?:number}|undefined)?.offset??0;
      check(Number.isSafeInteger(offset)&&offset>=0&&offset<=pending.length,'MODEL_SETTINGS_PAGE_INVALID');
      return {items:pending.slice(offset,offset+8),next_offset:offset+8<pending.length?offset+8:null};
    }
    await keys.assertModelSettings(source);
    if(operation==='model_settings_challenge')return keys.challenge(source,'model_settings');
    if(operation==='model_settings_local_catalog')return authority.localCatalog(body.request as {offset?:number}|undefined);
    const request=body.request as Record<string,unknown>;
    if(operation==='model_settings_draft'){
      if(request.action==='authorize_mac'){
        check(source.device_type==='phone','PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
        const target=(await this.options.devices(source.principal_id)).find(device=>device.device_id===request.device_id&&device.principal_id===source.principal_id&&device.device_type==='mac');
        check(target,'MODEL_SETTINGS_MAC_TARGET_INVALID',403);
        check(keys.pendingModelSettings(target)?.public_x963_b64===request.public_x963_b64,'MODEL_SETTINGS_MAC_KEY_CHANGED',409);
      }
      return authority.draft(source,request as unknown as SettingsDraftRequest);
    }
    if(operation==='model_settings_catalog')return authority.catalog(source,request as {draft_id:string;provider_ref:string;offset?:number});
    if(operation==='model_settings_test')return authority.testConnection(source,request as {draft_id:string;profile:string;role:string});
    if(operation==='model_settings_set_key'&&request.key!==undefined)
      return authority.keyDraft(source,request as {expected_revision:number;credential_ref:string;key:string});
    check(['commit','undo','authorize_mac','set_key','pause','resume','switch_local'].some(action=>operation===`model_settings_${action}`),'MODEL_SETTINGS_OPERATION_INVALID');
    const input:SignedInput={statement_b64:body.statement_b64 as string,signature_b64:body.signature_b64 as string};
    check(typeof input.statement_b64==='string'&&typeof input.signature_b64==='string','PAYMENT_SIGNATURE_REQUIRED',403);
    let statement:Record<string,unknown>;
    try {statement=JSON.parse(Buffer.from(input.statement_b64,'base64').toString('utf8'));}
    catch {check(false,'PAYMENT_SIGNATURE_INVALID',403);}
    check(statement!==null&&typeof statement==='object'&&!Array.isArray(statement)&&typeof statement.nonce==='string','PAYMENT_SIGNATURE_INVALID',403);
    check(operation===`model_settings_${statement.action}`,'MODEL_SETTINGS_ACTION_MISMATCH');
    const draftId=request.draft_id as string,nonce=statement.nonce as string,signatureFingerprint=fingerprint(input);
    const cached=authority.cached(source,draftId,nonce,signatureFingerprint);
    if(cached){
      if(statement.action==='authorize_mac'){
        const draft=authority.getDraft(source,draftId),target=(await this.options.devices(source.principal_id)).find(device=>device.device_id===draft.payload.device_id);
        check(target,'MODEL_SETTINGS_MAC_TARGET_INVALID',403);
        const currentApproval=()=>{
          const approval=authority.latestMacAuthorization(source.principal_id,target.device_id);
          check(approval?.revision===cached.desired&&approval.public_x963_b64===draft.payload.public_x963_b64,
            'MODEL_SETTINGS_MAC_AUTHORIZATION_SUPERSEDED',409);
        };
        currentApproval();
        if(keys.registered(target,'model_settings')?.public_x963_b64!==draft.payload.public_x963_b64){
          const expected=Object.fromEntries(['action','draft_id','expected_revision','change_sha256','expires_at_ms','principal_id'].map(field=>[field,statement[field]]));
          const verified=await keys.verify(source,'model_settings',input,expected,nonce);
          await keys.registerModelSettings(source,target,draft.payload.public_x963_b64 as string,verified,undefined,currentApproval);
        }
      }
      return modelSettingsState(authority);
    }
    const draft=authority.getDraft(source,draftId);
    check(operation===`model_settings_${draft.action}`,'MODEL_SETTINGS_ACTION_MISMATCH');
    const expected={action:draft.action,draft_id:draft.draft_id,expected_revision:draft.expected_revision,
      change_sha256:draft.change_sha256,expires_at_ms:draft.expires_at_ms,principal_id:draft.principal_id};
    const verified=await keys.verify(source,'model_settings',input,expected);
    if(draft.action==='authorize_mac'){
      const target=(await this.options.devices(source.principal_id)).find(device=>device.device_id===draft.payload.device_id);
      check(target,'MODEL_SETTINGS_MAC_TARGET_INVALID',403);
      await keys.registerModelSettings(source,target,draft.payload.public_x963_b64 as string,verified,
        ()=>authority.commitDraft(source,draftId,nonce,signatureFingerprint));
      return modelSettingsState(authority);
    }
    verified.commit(()=>authority.commitDraft(source,draftId,nonce,signatureFingerprint));return modelSettingsState(authority);
  }
}
