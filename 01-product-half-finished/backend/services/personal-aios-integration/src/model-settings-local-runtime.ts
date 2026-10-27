import {check} from './contracts.ts';
import type {ModelSettingsAuthority} from './model-settings.ts';
import {localSpeakerIdentity,verifyLocalModel,type LocalModelEntry,type LocalModelSelection} from './model-settings-local-catalog.ts';
import {LocalSpeechEngine,CALL_INTERRUPT_KEYWORDS,type LocalSpeechConfig} from './voiceprint/engine.ts';
import type {SpeakerModel} from './voiceprint/registry.ts';

/** Startup-only binding. Desired changes never replace a running speech engine or registry. */
export function localSpeechRuntime(authority:ModelSettingsAuthority,speaker:LocalModelSelection|undefined,openEngine:typeof LocalSpeechEngine.open=LocalSpeechEngine.open) {
  return {async prepare(incoming:LocalSpeechConfig) {
    const config=structuredClone(incoming),selections:LocalModelSelection[]=[];
    const baselines:LocalModelEntry[]=[
      {id:'startup-asr',display_name:'启动配置 ASR',kind:'asr',config:config.asr},
      {id:'startup-vad',display_name:'启动配置 VAD',kind:'vad',config:config.vad},
      ...(config.kws?[{id:'startup-wakeword',display_name:'启动配置唤醒词',kind:'wakeword' as const,config:{...config.kws,call_keywords:config.kws.call_keywords??structuredClone([...CALL_INTERRUPT_KEYWORDS])}}]:[])];
    for(const baseline of baselines)authority.registerLocalBaseline(baseline);
    for(const kind of ['asr','vad','wakeword'] as const){
      const selected=authority.localSelection(kind);if(!selected)continue;
      await verifyLocalModel(selected.entry);selections.push(selected);
      const entry=selected.entry;
      if(entry.kind==='asr')config.asr=entry.config;
      if(entry.kind==='vad')config.vad=entry.config;
      if(entry.kind==='wakeword')config.kws=entry.config;
    }
    if(speaker){check(speaker.entry.kind==='voiceprint','LOCAL_SPEAKER_KIND_MISMATCH');
      await verifyLocalModel(speaker.entry);config.speaker={model:speaker.entry.config.model};selections.push(speaker);}
    let acknowledged=false;
    return async()=>{
      const engine=await openEngine(config);
      try{
        if(speaker){const expected=localSpeakerIdentity(speaker.entry as Extract<LocalModelEntry,{kind:'voiceprint'}>);
          check(sameSpeaker(expected,engine.speaker_model),'VOICEPRINT_ENGINE_MODEL_MISMATCH',503);}
        const signal=new AbortController().signal;
        for(const selected of selections){
          if(selected.generation===0)continue;
          if(selected.entry.kind==='asr')await engine.transcribe(new Float32Array(16000),signal);
          if(selected.entry.kind==='vad'){
            const ambient=await engine.openVad(signal);await ambient.close();
            const call=await engine.openCallVad(signal);await call.close();
          }
          if(selected.entry.kind==='wakeword'){
            check(engine.keywords,'LOCAL_MODEL_WAKE_ENGINE_UNAVAILABLE',503);
            const ambient=await engine.keywords.open(signal);await ambient.close();
            const call=await engine.openCallKeywords(signal);await call.close();
          }
        }
        if(!acknowledged){
          for(const selected of selections){
            check(authority.localSelection(selected.entry.kind)?.generation===selected.generation,'LOCAL_MODEL_STARTUP_SUPERSEDED',409);
            const state=await authority.activateLocal(selected.entry.kind,async(current,context)=>{
              check(current.generation===selected.generation,'LOCAL_MODEL_STARTUP_SUPERSEDED',409);context.commit(()=>{});
            });
            check(state.effective.generation===selected.generation,'LOCAL_MODEL_STARTUP_ACK_FAILED',503);
          }
          acknowledged=true;
        }
        return engine;
      }catch(error){await engine.close();throw error;}
    };
  }};
}
export const sameSpeaker=(a:SpeakerModel,b:SpeakerModel)=>a.id===b.id&&a.sha256===b.sha256&&a.dim===b.dim;
