import {check,digest} from './contracts.ts';
import type {ModelSettingsAuthority} from './model-settings.ts';
import {type LocalModelEntry} from './model-settings-local-catalog.ts';
import {openLocalEmbedding,localEmbeddingSpace} from './visual/local-embedding.ts';
import {readEmbeddingSpace,type EmbeddingProvider} from './visual/embedding-spaces.ts';
import {DashScopeEmbedding,type EmbeddingConfiguration} from './visual/models.ts';
import type {VisualMemory} from './visual/store.ts';

/** Uses durable active-space metadata to recover a switch interrupted before the settings ACK. */
export async function openModelSettingsEmbedding(authority:ModelSettingsAuthority,directory:string,
  legacy:EmbeddingConfiguration&{region:string;apiKey:string},openLocal:typeof openLocalEmbedding=openLocalEmbedding) {
  const baseline:LocalModelEntry={id:'startup-embedding',display_name:'启动配置 Embedding',kind:'embedding',legacy:true,
    config:{model:legacy.model,endpoint:legacy.endpoint,dimensions:1024,space_id:`legacy:${digest({model:legacy.model,endpoint:legacy.endpoint,dimensions:1024})}`}};
  authority.registerLocalBaseline(baseline);
  const space=(entry:Extract<LocalModelEntry,{kind:'embedding'}>)=>'legacy' in entry?{id:entry.config.space_id,dimensions:entry.config.dimensions}:localEmbeddingSpace(entry.config);
  const pin=readEmbeddingSpace(directory),candidates=authority.localCandidates('embedding');
  const startup=pin?candidates.find(value=>value.entry.kind==='embedding'&&space(value.entry).id===pin.id&&space(value.entry).dimensions===pin.dimensions):
    candidates.find(value=>value.generation===0);
  check(startup,'LOCAL_EMBEDDING_ACTIVE_PIN_UNKNOWN',503);
  const open=async(entry:LocalModelEntry):Promise<EmbeddingProvider>=>{
    check(entry.kind==='embedding','LOCAL_EMBEDDING_KIND_MISMATCH');
    if(!('legacy' in entry))return openLocal(entry.config);
    check(entry.config.model===legacy.model&&entry.config.endpoint===legacy.endpoint,'LOCAL_EMBEDDING_LEGACY_CONFIG_CHANGED',503);
    const provider=new DashScopeEmbedding(legacy);
    return {embeddingSpace:{id:entry.config.space_id,dimensions:entry.config.dimensions},
      embedImage:(bytes,signal)=>provider.embedImage(bytes,signal),embedQuery:text=>provider.embedQuery(text)};
  };
  const provider=await open(startup.entry),stop=new AbortController();
  let unwatch:(()=>void)|undefined,work:Promise<unknown>|undefined,attempted:number|undefined,owned=false,running=false;
  return {provider,attach(store:VisualMemory){
    owned=true;
    const apply=()=>{
      const desired=authority.localSelection('embedding');if(running||!desired||desired.generation===attempted||stop.signal.aborted)return;
      attempted=desired.generation;running=true;
      work=authority.activateLocal('embedding',async(selection,context)=>{
        const signal=AbortSignal.any([context.signal,stop.signal]);signal.throwIfAborted();
        const active=store.embeddingSpaceInfo()?.active;
        check(selection.entry.kind==='embedding','LOCAL_EMBEDDING_KIND_MISMATCH');
        if(active?.space.id===space(selection.entry).id&&active.space.dimensions===space(selection.entry).dimensions){
          signal.throwIfAborted();context.commit(()=>{});return;
        }
        const candidateProvider=await open(selection.entry);let transferred=false;
        try{
          const candidate=await store.prepareEmbeddingSpace(candidateProvider,signal,context.progress);transferred=true;
          signal.throwIfAborted();check(context.current(),'LOCAL_EMBEDDING_SUPERSEDED',409);
          context.commit(()=>store.activateEmbeddingSpace(candidate));
        }finally{if(!transferred)await candidateProvider.close?.();}
      }).catch(error=>console.error('LOCAL_EMBEDDING_ACTIVATION_FAILED',error)).finally(()=>{running=false;apply();});
    };
    unwatch=authority.watch(apply);apply();
  },async close(){unwatch?.();stop.abort(Error('LOCAL_EMBEDDING_SHUTDOWN'));await work;if(!owned)await provider.close?.();}};
}
