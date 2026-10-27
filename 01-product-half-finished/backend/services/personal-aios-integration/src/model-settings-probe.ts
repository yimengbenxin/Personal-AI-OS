import {randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {check} from './contracts.ts';
import {validateModelUrl,type ModelProvider,type ModelParameters} from './model-settings-contract.ts';

interface ProbeInput {provider:ModelProvider;model_id:string;parameters:ModelParameters;key:string;allow_private_hosts?:readonly string[];trace_id?:string}
const safeCodes=new Set(['invalid_api_key','insufficient_balance','model_not_found','rate_limit_exceeded','authentication_error']);
export async function validateModelDestination(provider:ModelProvider,allow_private_hosts?:readonly string[]):Promise<void>{
  validateModelUrl(provider.base_url,allow_private_hosts);
  const host=new URL(provider.base_url).hostname;
  if(!allow_private_hosts?.includes(host)){
    const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});
    for(const {address} of addresses)validateModelUrl(`https://${isIP(address)===6?`[${address}]`:address}`);
  }
}
/** One bounded inference request. There is no model list shortcut and no fallback. */
export async function probeModelConnection(input:ProbeInput){
  const {provider,key}=input;await validateModelDestination(provider,input.allow_private_hosts);
  check(provider.wire_protocol!=='local_onnx','MODEL_SETTINGS_PROBE_PROTOCOL_UNSUPPORTED');
  const trace_id=input.trace_id??randomUUID(),started=performance.now(),headers:Record<string,string>={'Content-Type':'application/json'};
  let suffix:string,body:Record<string,unknown>;
  if(provider.wire_protocol==='anthropic_messages'){
    suffix='/messages';headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';
    body={model:input.model_id,max_tokens:16,messages:[{role:'user',content:'Reply OK.'}]};
  }else{
    headers.Authorization=`Bearer ${key}`;
    if(provider.wire_protocol==='codex_responses'){suffix='/responses';body={model:input.model_id,input:'Reply OK.',max_output_tokens:16,tools:[],store:false};}
    else {suffix='/chat/completions';body={model:input.model_id,messages:[{role:'user',content:'Reply OK.'}],max_tokens:16,stream:false,
      ...(input.parameters.thinking?{thinking:{type:'disabled'}}:{})};}
  }
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10_000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,responseComplete=false;
  let status:'passed'|'failed'='failed',http_status:number|null=null,safe_error:string|null=null,actual_model:string|null=null,usage:Record<string,number>|null=null;
  try{
    const response=await fetch(provider.base_url.replace(/\/$/u,'')+suffix,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
    http_status=response.status;
    reader=response.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
    if(reader)for(;;){const value=await reader.read();if(value.done){responseComplete=true;break;}length+=value.value.length;check(length<=262144,'MODEL_SETTINGS_PROBE_RESPONSE_LIMIT',502);chunks.push(value.value);}
    else responseComplete=true;
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {model?:unknown;usage?:Record<string,unknown>;error?:{code?:unknown}};
    if(response.ok){
      check(typeof result.model==='string'&&result.model.length<=200,'MODEL_SETTINGS_PROBE_RESPONSE_INVALID',502);actual_model=result.model;
      const raw=result.usage??{},details=raw.prompt_tokens_details as Record<string,unknown>|undefined;
      usage=Object.fromEntries(Object.entries({...raw,cached_tokens:details?.cached_tokens??raw.cached_tokens??raw.prompt_cache_hit_tokens}).filter((entry):entry is [string,number]=>
        ['prompt_tokens','completion_tokens','input_tokens','output_tokens','total_tokens','cached_tokens','cache_read_input_tokens',
          'cache_creation_input_tokens'].includes(entry[0])&&typeof entry[1]==='number'&&Number.isSafeInteger(entry[1])&&entry[1]>=0));status='passed';
    }else safe_error=typeof result.error?.code==='string'&&safeCodes.has(result.error.code)?result.error.code:'MODEL_SETTINGS_PROVIDER_REJECTED';
  }catch(error){safe_error=controller.signal.aborted?'MODEL_SETTINGS_PROBE_TIMEOUT':'MODEL_SETTINGS_PROBE_FAILED';}
  finally{
    try{
      // Cancellation can reject or remain pending. It must not delay transport abort or replace the probe result.
      if(reader&&!responseComplete)void reader.cancel().catch(()=>{});
    }finally{
      try{reader?.releaseLock();}
      finally{if(!responseComplete)controller.abort();clearTimeout(timeout);}
    }
  }
  return {status,http_status,safe_error,trace_id,actual_model,latency_ms:Math.round(performance.now()-started),usage,max_output_tokens:16,fallback_activated:false};
}
