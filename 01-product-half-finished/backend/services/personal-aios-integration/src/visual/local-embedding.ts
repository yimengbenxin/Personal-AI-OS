import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {check,ContractError,digest} from '../contracts.ts';
import {recoveringEngine} from '../voiceprint/engine.ts';
import {VISUAL_IMAGE_BYTES} from './image.ts';
import type {EmbeddingProvider,EmbeddingSpace} from './embedding-spaces.ts';
export interface LocalEmbeddingConfiguration {
  runtime:'transformers-clip-cpu';python:string;model_directory:string;
  artifacts:{path:string;sha256:string}[];dimensions:number;space_id:string;threads:number;timeout_ms:number;
}
/** Supplied interpreter needs existing torch, transformers, Pillow and safetensors. Never provisions them. */
export function validateLocalEmbeddingConfiguration(value:unknown):LocalEmbeddingConfiguration {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value),'LOCAL_EMBEDDING_CONFIG');
  const config=value as LocalEmbeddingConfiguration;
  check(Object.keys(config).every(key=>['runtime','python','model_directory','artifacts','dimensions','space_id','threads','timeout_ms'].includes(key))&&config.runtime==='transformers-clip-cpu'&&typeof config.python==='string'&&isAbsolute(config.python)&&typeof config.model_directory==='string'&&isAbsolute(config.model_directory)&&
    typeof config.space_id==='string'&&config.space_id.length>0&&Number.isSafeInteger(config.dimensions)&&config.dimensions>0&&config.dimensions<=4096&&
    Number.isSafeInteger(config.threads)&&config.threads>=1&&config.threads<=16&&Number.isSafeInteger(config.timeout_ms)&&config.timeout_ms>=100&&config.timeout_ms<=300000,'LOCAL_EMBEDDING_CONFIG');
  check(Array.isArray(config.artifacts)&&config.artifacts.length>0&&config.artifacts.length<=256&&config.artifacts.every(item=>item!==null&&typeof item==='object'&&typeof item.path==='string'&&item.path.length>0&&!isAbsolute(item.path)&&!item.path.split(/[\\/]/u).some(part=>part==='..'||part==='.'||part==='')&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/u.test(item.sha256))&&new Set(config.artifacts.map(item=>item.path)).size===config.artifacts.length,'LOCAL_EMBEDDING_ARTIFACT_CONFIG');
  return config;
}
export function localEmbeddingSpace(config:LocalEmbeddingConfiguration):EmbeddingSpace {
  return {id:`local:${digest({runtime:config.runtime,artifacts:config.artifacts.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),dimensions:config.dimensions,space_id:config.space_id})}`,dimensions:config.dimensions};
}
export async function openLocalEmbedding(value:LocalEmbeddingConfiguration):Promise<EmbeddingProvider&{close():Promise<void>}> {
  const config=structuredClone(validateLocalEmbeddingConfiguration(value)),space=localEmbeddingSpace(config);
  const engines=recoveringEngine(()=>openLocalEmbeddingProcess(config));
  try{await engines.current();}catch(error){await engines.close();throw error;}
  let closed=false;const current=async()=>{
    check(!closed,'LOCAL_EMBEDDING_CLOSED',503);
    try{return await engines.current();}catch(error){
      if(error instanceof ContractError&&error.code==='SPEECH_ENGINE_RECOVERING')throw new ContractError('LOCAL_EMBEDDING_RECOVERING',503);throw error;
    }
  };
  return {embeddingSpace:space,embedImage:async(bytes,signal)=>(await current()).embedImage(bytes,signal),
    embedQuery:async text=>(await current()).embedQuery(text),close:()=>{closed=true;return engines.close();}};
}
async function openLocalEmbeddingProcess(config:LocalEmbeddingConfiguration):Promise<EmbeddingProvider&{readonly failed:boolean;close():Promise<void>}> {
  const child=spawn(config.python,[fileURLToPath(new URL('./local-embedding.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  const exited=Promise.withResolvers<void>(),ready=Promise.withResolvers<void>();
  let pending:ReturnType<typeof Promise.withResolvers<number[]>>|undefined,failure:Error|undefined,closed=false,buffer='';
  const fail=(error:Error)=>{failure??=error;ready.reject(error);pending?.reject(error);pending=undefined;child.kill('SIGKILL');};
  child.once('error',error=>fail(error));
  child.once('close',()=>{exited.resolve();if(!closed)fail(new ContractError('LOCAL_EMBEDDING_EXITED',503));});
  child.stderr.resume();child.stdin.on('error',error=>fail(error));
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;if(buffer.length>1024*1024)return fail(new ContractError('LOCAL_EMBEDDING_PROTOCOL',502));
    for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try {
        const reply=JSON.parse(line);
        if(reply.error)return fail(new ContractError(typeof reply.error==='string'&&/^LOCAL_EMBEDDING_[A-Z_]+$/u.test(reply.error)?reply.error:'LOCAL_EMBEDDING_RUNTIME_FAILED',503));
        if(reply.ready===true){ready.resolve();continue;}
        check(pending&&Array.isArray(reply.vector)&&reply.vector.length===config.dimensions&&reply.vector.every(Number.isFinite)&&reply.vector.some((n:number)=>n!==0),'LOCAL_EMBEDDING_PROTOCOL',502);
        const result=pending;pending=undefined;result.resolve(reply.vector);
      }catch(error){fail(error as Error);}
    }
  });
  const close=async()=>{if(!closed){closed=true;pending?.reject(new ContractError('LOCAL_EMBEDDING_CLOSED',503));child.kill('SIGKILL');}await exited.promise;};
  const startup=setTimeout(()=>fail(new ContractError('LOCAL_EMBEDDING_LOAD_TIMEOUT',503)),config.timeout_ms);
  child.stdin.write(JSON.stringify(config)+'\n');
  try{await ready.promise;}catch(error){await close();throw error;}finally{clearTimeout(startup);}
  async function call(op:'image'|'query',value:string,signal?:AbortSignal):Promise<number[]> {
    check(!failure&&!closed,'LOCAL_EMBEDDING_CLOSED',503);check(!pending,'LOCAL_EMBEDDING_BUSY',503);signal?.throwIfAborted();
    const result=Promise.withResolvers<number[]>();pending=result;
    const abort=()=>fail(new ContractError('LOCAL_EMBEDDING_CANCELLED',409));signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>fail(new ContractError('LOCAL_EMBEDDING_TIMEOUT',503)),config.timeout_ms);
    try{child.stdin.write(JSON.stringify({op,value})+'\n');return await result.promise;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {embeddingSpace:localEmbeddingSpace(config),get failed(){return Boolean(failure);},
    embedImage:async(bytes,signal)=>{check(bytes.length>0&&bytes.length<=VISUAL_IMAGE_BYTES,'LOCAL_EMBEDDING_IMAGE_TOO_LARGE',413);return call('image',bytes.toString('base64'),signal);},
    embedQuery:async text=>{check(typeof text==='string'&&text.length>0&&text.length<=200,'LOCAL_EMBEDDING_QUERY_INVALID');return call('query',text);},close};
}
