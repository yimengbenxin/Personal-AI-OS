import type {WorkerRequest} from './processing.ts';
import type {LocalAudioEngine} from './sherpa-audio-worker.ts';
import type {SpeakerIdentifier} from '../voiceprint/contracts.ts';
import {check} from '../contracts.ts';
import {meetingSpeaker,meetingWords} from '../meeting/speakers.ts';

/** Purpose is injected by the media owner, never decoded from device/model arguments. */
export type SpeechPurpose=(request:Pick<WorkerRequest,'principal_id'|'device_id'|'time_range'>)=>Promise<'meeting'|'meeting_paused'|undefined>;
export async function meetingUtterance(engine:LocalAudioEngine,registry:SpeakerIdentifier|undefined,speech:Float32Array,
  request:WorkerRequest,signal:AbortSignal){
  if(!registry||!speech.length)return {text:''};
  const observed_at=new Date(request.time_range.kind==='interval'?request.time_range.end_ms:Date.now()).toISOString();
  const speaker=await meetingSpeaker(engine,registry,speech,{...(request.principal_id?{principal_id:request.principal_id}:{}),...(request.device_id?{device_id:request.device_id}:{}),observed_at},signal);
  if(speaker?.label!=='speaker:meeting-other')return {text:'',...(speaker?{speaker:speaker.label,speaker_score:speaker.score}:{})};
  check(engine.transcribeWords,'MEETING_TEXT_ONLY_ASR_REQUIRED',503);
  const text=meetingWords(await engine.transcribeWords(speech,signal));
  return {text,speaker:speaker.label,speaker_score:speaker.score};
}
