import {check} from '../contracts.ts';
import {speakerWindows,speechQuality,type SpeechEngine,type SpeakerIdentifier,type IdentifyInput,type SpeakerIdentity} from '../voiceprint/contracts.ts';

const label=(identity:SpeakerIdentity)=>identity.kind==='assistant'?'assistant':identity.kind==='owner'?
  identity.band==='verified'&&!identity.call_only&&!identity.trust_window?'owner':undefined:
  identity.kind==='speaker'||identity.kind==='unknown'&&identity.reason==='unmatched'?'speaker:meeting-other':undefined;
/** S13's existing windows and registry. Anonymous verification only; no guest clusters/embeddings are retained. */
export async function meetingSpeaker(engine:Pick<SpeechEngine,'speaker_model'|'embed'>,registry:SpeakerIdentifier,
  speech:Float32Array,input:Pick<IdentifyInput,'principal_id'|'device_id'|'observed_at'|'evidence_start_at'>,signal:AbortSignal) {
  check(engine.speaker_model.sha256===registry.model.sha256&&engine.speaker_model.dim===registry.model.dim,'VOICEPRINT_SPEAKER_MODEL_MISMATCH',503);
  const results:{label:string;score:number}[]=[];
  for(const part of speakerWindows(speech)){
    signal.throwIfAborted();let embedding:Float32Array;
    try{embedding=await engine.embed(part,signal);}catch(error){if((error as {code?:string}).code==='SPEECH_INPUT_TOO_SHORT')return;throw error;}
    const identity=await registry.identify(embedding,{...input,signal,speech_ms:part.length/16,quality:speechQuality(part),
      mode:'verify',learning:false,channel:'glasses'});
    const name=label(identity);if(!name)return;
    results.push({label:name,score:'score' in identity?identity.score:0});
  }
  if(!results.length||results.some(result=>result.label!==results[0]!.label))return;
  return {label:results[0]!.label,score:Math.min(...results.map(result=>result.score))};
}

/** Native SenseVoice tags are never interpreted as meeting attributes. Spoken words remain literal. */
export const meetingWords=(text:string)=>text.replace(/<\|[^|]*\|>/gu,'').trim().slice(0,4000);
