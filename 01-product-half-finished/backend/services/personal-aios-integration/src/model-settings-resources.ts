import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {request as httpsRequest} from 'node:https';
import {check} from './contracts.ts';
import {loadLocalModelCatalog} from './model-settings-local-catalog.ts';
import {ModelSettingsAuthority} from './model-settings.ts';
import {ModelUsage} from './model-usage.ts';
import {projectModelSettings,writeModelSettingsProjection} from './model-settings-projection.ts';
import type {PersonalAIOSRuntime} from './runtime.ts';

export interface ModelSettingsConfiguration {
  environment_id:string;master_key_file:string;service_key_file:string;projection_dir:string;import_file?:string;
  local_catalog_file?:string;build_profile?:string;build_activation_url?:string;build_ca_file?:string;
}
async function activateNative(url:string,token:string,body:object,caFile?:string):Promise<{status:number;body:{status:string;revision:number}}> {
  const bytes=JSON.stringify(body);
  if(!caFile){const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:bytes,signal:AbortSignal.timeout(30000)});
    return {status:response.status,body:await response.json() as {status:string;revision:number}};}
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method:'POST',ca:readFileSync(caFile),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}},response=>{
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4096)response.destroy(Error('MODEL_SETTINGS_ACTIVATION_RESPONSE_LIMIT'));else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString('utf8')) as {status:string;revision:number}});}catch{reject(Error('MODEL_SETTINGS_ACTIVATION_RESPONSE_INVALID'));}});
    });
    request.setTimeout(30000,()=>request.destroy(Error('MODEL_SETTINGS_ACTIVATION_TIMEOUT')));request.on('error',reject);request.end(bytes);
  });
}
/** Composition of the existing integration process, native runtime and owner data volume. */
export function openModelSettingsResources(directory:string,config:ModelSettingsConfiguration,nativeUrl:string,serviceToken:string){
  if(config.build_activation_url){const url=new URL(config.build_activation_url);check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash,'MODEL_SETTINGS_BUILD_TARGET_INVALID');}
  let usage:ModelUsage|undefined;
  const profileFor=(group:'brain'|'build')=>group==='brain'?'owner':config.build_profile??'workshop';
  const authority=ModelSettingsAuthority.open(join(directory,'model-settings'),{
    environment_id:config.environment_id,master_key_file:config.master_key_file,
    ...(config.local_catalog_file?{local_catalog:()=>loadLocalModelCatalog(config.local_catalog_file!)}:{}),
    probeUsage:()=>{check(usage,'MODEL_SETTINGS_USAGE_UNAVAILABLE',503);return usage;},
    onEffective:(group,revision,owner)=>writeModelSettingsProjection(owner,config.projection_dir,profileFor(group),revision,group,true),
    onAction:draft=>{
      if(draft.action!=='pause'&&draft.action!=='resume')return;
      check(usage,'MODEL_SETTINGS_USAGE_UNAVAILABLE',503);
      if(draft.action==='resume'){usage.resume(config.environment_id,draft.principal_id);return;}
      usage.setPausePolicy(config.environment_id,draft.principal_id,draft.payload.pause_on_limit===true,draft.payload.owner_reserve_cny as number|undefined);
    },
    activate:async(group,revision,owner)=>{
      const profile=profileFor(group),projection=projectModelSettings(owner,profile,revision,group);
      check(projection.configured||(projection.config.model as {enabled?:boolean}).enabled===false,
        'MODEL_SETTINGS_KEY_REENTRY_REQUIRED',409);
      writeModelSettingsProjection(owner,config.projection_dir,profile,revision,group,false);
      const base=group==='build'&&config.build_activation_url?config.build_activation_url:nativeUrl;
      const response=await activateNative(base.replace(/\/$/u,'')+'/api/model-settings/activate',serviceToken,{revision,projections:[projection]},group==='build'?config.build_ca_file:undefined);
      if(response.status===409)throw Object.assign(Error('MODEL_SETTINGS_BUSY'),{code:'MODEL_SETTINGS_BUSY'});
      check(response.status>=200&&response.status<300,'MODEL_SETTINGS_ACTIVATION_FAILED',502);
      const receipt=response.body;
      check(receipt.status==='effective'&&receipt.revision===revision,'MODEL_SETTINGS_ACTIVATION_FAILED',502);
    },
  });
  try{
    if(!authority.read().desired&&config.import_file)authority.bootstrap(JSON.parse(readFileSync(config.import_file,'utf8')));
    const state=authority.read();
    for(const group of ['brain','build'] as const){
      writeModelSettingsProjection(authority,config.projection_dir,profileFor(group),state.groups[group].effective,group,true);
    }
    return {authority,attach(runtime:PersonalAIOSRuntime){
      runtime.installModelSettings(authority);
      usage=new ModelUsage(authority.db,{time_zone:runtime.time_zone,notify:notice=>runtime.modelUsageNotice(notice),resumeWork:()=>queueMicrotask(()=>runtime.resumeModelUsageWork())});
      runtime.installModelUsage(usage,config.environment_id);
    },close:async()=>{await authority.stopLocalActivations();authority.close();}};
  }catch(error){authority.close();throw error;}
}
