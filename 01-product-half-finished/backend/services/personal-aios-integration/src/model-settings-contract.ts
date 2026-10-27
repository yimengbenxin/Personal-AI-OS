import {check,canonical} from './contracts.ts';
import {isIP} from 'node:net';

export type ModelProtocol='chat_completions'|'codex_responses'|'anthropic_messages'|'local_onnx';
/** Native task identities, without provider or model defaults. Absent roles are disabled by the producer. */
export const auxiliaryModelRoles=['vision','compression','skills_hub','approval','review','mcp','title_generation',
  'memory_query_rewrite','tts_audio_tags','triage_specifier','kanban_decomposer','profile_describer','goal_judge',
  'curator','monitor','background_review','moa_reference','moa_aggregator'] as const;
export interface ModelProvider {
  id:string;display_name:string;wire_protocol:ModelProtocol;base_url:string;credential_ref:string|null;
  region?:string;catalog_capability?:'models'|'unavailable';usage_capability?:'balance'|'subscription'|'unknown';
  session_affinity?:string;
}
export interface ModelParameters {
  thinking?:{enabled:boolean;budget?:number};max_output_tokens?:number;temperature?:number;
  context_limit?:number;reasoning_effort?:string;
}
export interface ModelRoute {provider_ref:string;model_id:string;parameters:ModelParameters}
export interface ModelRole {
  id:string;profile:string;provider_ref?:string;model_id?:string;parameters:ModelParameters;
  ordered_fallbacks:ModelRoute[];inherit_from?:string;disabled?:boolean;read_only?:boolean;
  activation_boundary:'brain_idle'|'build_idle'|'read_only';
}
export interface ModelSnapshot {providers:ModelProvider[];roles:ModelRole[]}
export type SettingsAction='commit'|'undo'|'authorize_mac'|'set_key'|'pause'|'resume'|'switch_local';
export interface SettingsDraftRequest extends Partial<ModelSnapshot> {
  action?:Exclude<SettingsAction,'set_key'>;expected_revision:number;change_summary?:string;
  revision?:number;device_id?:string;public_x963_b64?:string;pause_on_limit?:boolean;owner_reserve_cny?:number;
  local_kind?:import('./model-settings-local-catalog.ts').LocalModelKind;local_target?:string;
}
export interface ModelResolution {
  environment_id:string;profile:string;role:string;revision:number;disabled:boolean;
  provider?:ModelProvider;model_id?:string;parameters:ModelParameters;credential_version?:number;
  credential_handle?:string;ordered_fallbacks:Array<ModelRoute&{provider:ModelProvider;credential_version?:number;credential_handle?:string}>;
}
export const modelRoleKey=(role:Pick<ModelRole,'profile'|'id'>)=>`${role.profile}/${role.id}`;
const identifier=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value);
const exact=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
export function validateModelUrl(value:string,allowPrivate:readonly string[]=[]):void {
  check(URL.canParse(value),'MODEL_SETTINGS_URL_INVALID');const url=new URL(value);
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search,'MODEL_SETTINGS_URL_INVALID');
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/gu,'');
  const privateHost=host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host==='metadata.google.internal'||
    isIP(host)===4&&/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u.test(host)||
    isIP(host)===6&&(/^(::|fc|fd|fe[89ab])/u.test(host));
  check(allowPrivate.includes(host)||!privateHost,
    'MODEL_SETTINGS_URL_PRIVATE');
}
function parameters(value:ModelParameters):void {
  check(value!==null&&typeof value==='object'&&exact(value,['thinking','max_output_tokens','temperature','context_limit','reasoning_effort']),'MODEL_SETTINGS_PARAMETERS_INVALID');
  for(const field of ['max_output_tokens','context_limit'] as const)check(value[field]===undefined||Number.isSafeInteger(value[field])&&value[field]!>0,'MODEL_SETTINGS_PARAMETERS_INVALID');
  check(value.temperature===undefined||typeof value.temperature==='number'&&Number.isFinite(value.temperature)&&value.temperature>=0&&value.temperature<=2,'MODEL_SETTINGS_PARAMETERS_INVALID');
  if(value.thinking)check(exact(value.thinking,['enabled','budget'])&&typeof value.thinking.enabled==='boolean'&&
    (value.thinking.budget===undefined||Number.isSafeInteger(value.thinking.budget)&&value.thinking.budget>0),'MODEL_SETTINGS_PARAMETERS_INVALID');
  check(value.reasoning_effort===undefined||['none','minimal','low','medium','high','xhigh'].includes(value.reasoning_effort),'MODEL_SETTINGS_PARAMETERS_INVALID');
}
/** The external snapshot is complete. Resolution never guesses a missing provider or model. */
export function validateModelSnapshot(snapshot:ModelSnapshot,allowPrivate:readonly string[]=[]):void {
  check(Array.isArray(snapshot.providers)&&Array.isArray(snapshot.roles)&&snapshot.providers.length<=100&&snapshot.roles.length<=200,'MODEL_SETTINGS_SNAPSHOT_INVALID');
  const providers=new Map<string,ModelProvider>();
  for(const provider of snapshot.providers){
    check(exact(provider,['id','display_name','wire_protocol','base_url','credential_ref','region','catalog_capability','usage_capability','session_affinity'])&&
      identifier(provider.id)&&typeof provider.display_name==='string'&&provider.display_name.length>0&&provider.display_name.length<=120&&
      ['chat_completions','codex_responses','anthropic_messages','local_onnx'].includes(provider.wire_protocol)&&
      (provider.credential_ref===null||identifier(provider.credential_ref))&&!providers.has(provider.id),'MODEL_SETTINGS_PROVIDER_INVALID');
    if(provider.wire_protocol!=='local_onnx')validateModelUrl(provider.base_url,allowPrivate);
    check(provider.session_affinity===undefined||/^[a-z0-9-]{1,64}$/u.test(provider.session_affinity),'MODEL_SETTINGS_PROVIDER_INVALID');
    providers.set(provider.id,provider);
  }
  const roles=new Map<string,ModelRole>();
  const route=(value:ModelRoute)=>{check(identifier(value.provider_ref)&&providers.has(value.provider_ref)&&typeof value.model_id==='string'&&value.model_id.length>0&&value.model_id.length<=200,'MODEL_SETTINGS_ROUTE_INVALID');parameters(value.parameters);};
  for(const role of snapshot.roles){
    check(exact(role,['id','profile','provider_ref','model_id','parameters','ordered_fallbacks','inherit_from','disabled','read_only','activation_boundary'])&&identifier(role.id)&&identifier(role.profile)&&
      ['brain_idle','build_idle','read_only'].includes(role.activation_boundary)&&!roles.has(modelRoleKey(role)),'MODEL_SETTINGS_ROLE_INVALID');
    parameters(role.parameters);check(Array.isArray(role.ordered_fallbacks)&&role.ordered_fallbacks.length<=8,'MODEL_SETTINGS_FALLBACK_INVALID');
    role.ordered_fallbacks.forEach(route);
    if(!role.disabled&&!role.inherit_from)route(role as ModelRoute);
    check(!role.inherit_from||!role.provider_ref&&!role.model_id,'MODEL_SETTINGS_INHERITANCE_INVALID');roles.set(modelRoleKey(role),role);
  }
  for(const role of roles.values()){
    const seen=new Set<string>();let current:ModelRole|undefined=role;
    while(current){const key=modelRoleKey(current);check(!seen.has(key),'MODEL_SETTINGS_INHERITANCE_CYCLE');seen.add(key);
      if(!current.inherit_from)break;current=roles.get(`${role.profile}/${current.inherit_from}`);check(current,'MODEL_SETTINGS_INHERITANCE_MISSING');}
  }
}
export function immutableReadOnly(previous:ModelSnapshot,next:ModelSnapshot):void {
  for(const role of previous.roles.filter(role=>role.read_only||role.activation_boundary==='read_only')){
    const found=next.roles.find(value=>modelRoleKey(value)===modelRoleKey(role));
    check(found&&canonical(found)===canonical(role),'MODEL_SETTINGS_ROLE_READ_ONLY',403);
    for(const ref of [role.provider_ref,...role.ordered_fallbacks.map(route=>route.provider_ref)].filter(Boolean))
      check(canonical(next.providers.find(p=>p.id===ref))===canonical(previous.providers.find(p=>p.id===ref)),'MODEL_SETTINGS_ROLE_READ_ONLY',403);
  }
}
