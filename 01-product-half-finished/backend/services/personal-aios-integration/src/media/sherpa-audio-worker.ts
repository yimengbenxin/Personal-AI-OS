import {meetingUtterance} from './speech-purpose.ts';
import {check,ContractError} from '../contracts.ts';
import {embedSpeech,speechQuality,speakerLabel,TURN_WINDOW_MAX_MS,wakeCarriesRequest,type KeywordSpotterFactory,type SpeakerIdentifier,type SpeechEngine} from '../voiceprint/contracts.ts';
import type {Capability,WorkerPort,WorkerRequest} from './processing.ts';
import type {SampleAudioResult} from './sample-results.ts';
import {projectSampleInterval,selectedAudioTimeline,type SelectedAudioGroup} from './sample-timeline.ts';
import {finiteVadSelection} from './continuous-source.ts';
import type {SpeechVad,VadStreamFactory} from './silero-stream.ts';

export const LOCAL_SHERPA_AUDIO='local-sherpa-audio',LOCAL_SHERPA_TURN='local-sherpa-turn';
/** The engine surface this consumer needs (LocalSpeechEngine, or a controlled one in tests). */
export interface LocalAudioEngine extends SpeechEngine,SpeechVad {readonly version:string;readonly keywords?:KeywordSpotterFactory|undefined;available():boolean}
type Span={start_sample:number;end_sample_exclusive:number};
interface Analysis {engine:LocalAudioEngine;group:SelectedAudioGroup;request:WorkerRequest;samples:Float32Array;signal:AbortSignal;stages:Record<string,number>}
async function timed<T>(c:Analysis,stage:string,operation:()=>Promise<T>):Promise<T> {
  const start=performance.now();try{return await operation();}finally{c.stages[stage]=(c.stages[stage]??0)+Math.round(performance.now()-start);}
}
/** `utterance`: ambient windows (≤10 s), one speaker label per utterance. `turn`: a wake turn (≤20 s, from its wake word
 *  when the lane could include it) or a follow-up (≤60 s, from the replied request's speech), one speaker identity over the
 *  turn, so a short fragment never counts as another voice. */
export type SherpaMode='utterance'|'turn';
const BUDGET={utterance:160000,turn:TURN_WINDOW_MAX_MS*16};
// The spotter is fed 100 ms at a time; it reports a keyword about 0.3–0.4 s after the keyword ends (measured on
// synthesized speech: cutting at the hit lost the request's first syllables, 0.3–0.4 s earlier kept them).
const KWS_CHUNK=1600,KWS_LATENCY=5600;
// A request with less speech than this is identified together with its wake word to improve short-utterance evidence.
// Longer requests stay request-only evidence. A follow-up's carrier is at most this much of the replied
// request's most recent speech: enough to embed with a short answer, not so much that it outweighs the answer's voice.
const COMBINE_BELOW=24000;
/** The group's sample at a UTC instant: linear within each selected view's mapped range, clamped to the group. */
function sampleAt(group:SelectedAudioGroup,ms:number):number {
  const piece=group.pieces.find(p=>ms<(p.view.time_range as {end_ms:number}).end_ms)??group.pieces.at(-1)!;
  const range=piece.view.time_range as {start_ms:number;end_ms:number};
  const at=piece.start_sample+(ms-range.start_ms)*(piece.end_sample_exclusive-piece.start_sample)/(range.end_ms-range.start_ms);
  return Math.max(0,Math.min(group.total_samples,Math.round(at)));
}
const clip=(spans:Span[],from:number,to:number):Span[]=>spans.flatMap(span=>{
  const start=Math.max(span.start_sample,from),end=Math.min(span.end_sample_exclusive,to);return end>start?[{start_sample:start,end_sample_exclusive:end}]:[];});
const length=(spans:Span[])=>spans.reduce((n,span)=>n+span.end_sample_exclusive-span.start_sample,0);
/** How a turn opened: identity-only spans before the request (`lead`) and the text-less segments they become when they are
 *  evidence; the request's spans (transcribed) and its voiced speech. */
interface Opening {lead:Span[];leadSegments:SampleAudioResult['segments'];requests:Span[];spoken:Span[];evidence:'wake_and_request'|'carrier_and_request'}

export function sherpaAudioCapability(engine:Pick<LocalAudioEngine,'version'|'available'>,voiceprint=false,mode:SherpaMode='utterance'):Capability {
  // Evidence is the pinned, hash-verified model set the engine loaded; per-input quality stays unaccepted downstream.
  return {id:mode==='turn'?LOCAL_SHERPA_TURN:LOCAL_SHERPA_AUDIO,version:engine.version,modalities:['audio'],formats:['pcm_s16le:16000:1'],joint_av:false,
    healthy:engine.available(),permitted:true,max_duration_ms:BUDGET[mode]/16,execution:'local',evidence:'real_verified',
    // Speaker labels name people only when they come from the attached local voiceprint registry.
    ...(voiceprint?{speaker_identity:'local_voiceprint' as const}:{})};
}
const wide=/[　-鿿＀-￯]/u;
function joinText(parts:string[]):string {
  return parts.filter(Boolean).reduce((text,part)=>!text?part:wide.test(text.at(-1)!)&&wide.test(part[0]!)?text+part:`${text} ${part}`,'');
}

// One selected audio group. The engine's VAD splits a window holding several utterances; each gets its own text and
// language. Ambient utterances also get the wake word the engine's keyword spotter heard in them, with where it ends
// (SenseVoice misspells 依米, so the transcript cannot decide). With a voiceprint registry attached, speaker labels come
// from it. Mapping labels into D stays with the finalizer.
export class SherpaAudioWorker implements WorkerPort {
  readonly effects='pure_analysis' as const;
  private readonly engine:()=>Promise<LocalAudioEngine>;private readonly detector:VadStreamFactory;
  private readonly speakers:SpeakerIdentifier|undefined;private readonly mode:SherpaMode;
  constructor(engine:()=>Promise<LocalAudioEngine>,detector:VadStreamFactory,speakers?:SpeakerIdentifier,mode:SherpaMode='utterance') {
    this.engine=engine;this.detector=detector;this.speakers=speakers;this.mode=mode;
  }
  /** PTT keeps the provider transcript; this path only measures the same selected PCM for identity. */
  analyzeIdentity(request:WorkerRequest,signal:AbortSignal):Promise<SampleAudioResult> {return this.analyze(request,signal,true);}
  async analyze(request:WorkerRequest,signal:AbortSignal,identityOnly=false):Promise<SampleAudioResult> {
    request=structuredClone(request);check(!signal.aborted,'MEDIA_CANCELLED',409);
    const groups=selectedAudioTimeline(request);check(groups.length===1,'LOCAL_AUDIO_SINGLE_CONTINUOUS_GROUP_REQUIRED');
    const group=groups[0]!,turn=this.mode==='turn';check(group.sample_rate===16000&&group.total_samples<=BUDGET[this.mode],'LOCAL_AUDIO_BUDGET');
    const started=performance.now(),engine=await this.engine(),loaded=performance.now();
    const [detected]=await finiteVadSelection(this.detector,request,signal,BUDGET[this.mode]);
    const stages={engine_ms:Math.round(loaded-started),vad_ms:Math.round(performance.now()-loaded),asr_ms:0,kws_ms:0,identity_ms:0};
    const pcm=Buffer.concat(group.views.map(view=>Buffer.from(view.bytes))),samples=new Float32Array(group.total_samples);
    for(let n=0;n<samples.length;n++)samples[n]=pcm.readInt16LE(n*2)/32768;
    const utterances=request.sound_only?[]:detected!.segments,spans:Span[]=utterances.length>1?utterances:[{start_sample:0,end_sample_exclusive:group.total_samples}];
    const voiced:Span[]=utterances.length>1?utterances:utterances.length?[utterances[0]!]:[];
    const context={engine,group,request,samples,signal,stages};
    const analysed=identityOnly?await this.requestIdentity(context,voiced):turn?await this.turn(context,spans,voiced):{segments:await this.utterances(context,spans,voiced)};
    const {input_id,scope_sha256,pcm_sha256,sample_rate,sample_count}=detected!,segments=analysed.segments;
    return {schema:'paios.media.audio-sample-result.v1',kind:'transcription',input_id,scope_sha256,pcm_sha256,sample_rate,sample_count,
      model:{id:turn?LOCAL_SHERPA_TURN:LOCAL_SHERPA_AUDIO,version:engine.version,device:'cpu',dtype:'int8',native_metadata:{asr_sha256:engine.asr_model.sha256,
        vad_onnx_sha256:engine.vad_model.native_metadata.onnx_sha256,vad_utterances:utterances.length,speaker_scope:this.mode,
        wake_spotting:!request.speech_purpose&&!identityOnly&&engine.keywords!==undefined,...(identityOnly?{identity_only:true}:{}),analysis_total_ms:Math.round(performance.now()-started),...stages,...('evidence' in analysed?{speaker_evidence:analysed.evidence}:{}),
        ...(this.speakers?{speaker_sha256:engine.speaker_model.sha256}:{}),...(!request.speech_purpose&&engine.tagging_model?{tagging_sha256:engine.tagging_model.sha256,
          tagging_labels_sha256:engine.tagging_model.labels_sha256}:{})}},
      raw_text:joinText(segments.map(segment=>segment.text!)),segments};
  }
  private async requestIdentity(c:Analysis,voiced:Span[]):Promise<{segments:SampleAudioResult['segments'];evidence:'request'}> {
    const speaker=voiced.length&&this.speakers?await timed(c,'identity_ms',()=>this.identify(c,voiced)):undefined;
    return {segments:voiced.map(span=>({...span,text:'',...(speaker?{speaker:speaker.label,speaker_score:speaker.score,...(speaker.call_only?{call_only:true as const}:{})}:{})})),evidence:'request'};
  }
  /** Ambient: each utterance its own text, language, wake word and speaker label. */
  private async utterances(c:Analysis,spans:Span[],voiced:Span[]):Promise<SampleAudioResult['segments']> {
    const segments:SampleAudioResult['segments']=[];
    for(const [index,span] of spans.entries()) {
      check(!c.signal.aborted,'MEDIA_CANCELLED',409);
      const utterance=c.samples.subarray(span.start_sample,span.end_sample_exclusive);
      if(c.request.speech_purpose){
        if(c.request.speech_purpose==='meeting_paused'){segments.push({...span,text:''});continue;}
        const speech=voiced[index]?c.samples.subarray(voiced[index]!.start_sample,voiced[index]!.end_sample_exclusive):new Float32Array();
        segments.push({...span,...await meetingUtterance(c.engine,this.speakers,speech,c.request,c.signal)});continue;
      }
      const transcript=c.request.sound_only||!voiced[index]&&c.engine.tagging_model?{text:''}:
        await timed(c,'asr_ms',()=>c.engine.transcribe(utterance,c.signal));
      const sound=c.engine.tagging_model&&(c.request.sound_only||!voiced[index]||utterance.length<24000||!transcript.text.trim())?
        await timed(c,'tagging_ms',()=>c.engine.tag!(utterance,c.signal)):undefined;
      const {text,lang,emotion}=transcript,event=transcript.event??sound;
      const eventOnly=!!event&&!text.trim();
      const wake=!eventOnly&&c.engine.keywords?await timed(c,'kws_ms',()=>this.spot(c.engine.keywords!,utterance,c.signal)):undefined;
      const speaker=!eventOnly&&voiced[index]&&this.speakers?await timed(c,'identity_ms',()=>this.identify(c,[voiced[index]!])):undefined;
      segments.push({...span,text,...(lang?{lang}:{}),...(event?{event}:{}),...(emotion?{emotion}:{}),...(wake?{wake}:{}),...(speaker?{speaker:speaker.label,speaker_score:speaker.score,...(speaker.call_only?{call_only:true as const}:{})}:{})});
    }
    return segments;
  }
  /** A turn is one speaker, identified once: over the request's speech, or — a request too short to identify alone — over
   *  its opening (the wake word, or a follow-up's carrier) and the request together, one embedding of one turn, with the
   *  request alone checked by the registry, so an opening and a request said by different people never verify. The
   *  opening then carries the turn's label as text-less segments; otherwise it is no segment (never separate evidence).
   *  The request's text is the turn's text. */
  private async turn(c:Analysis,spans:Span[],voiced:Span[]):Promise<{segments:SampleAudioResult['segments'];evidence:'request'|Opening['evidence']}> {
    const {lead,leadSegments,requests,spoken,evidence:opened}=c.request.speaker_carrier?
      this.carried(c.request.speaker_carrier,c.group,spans,voiced):await this.woken(c,spans,voiced);
    const combined=lead.length>0&&spoken.length>0&&length(spoken)<COMBINE_BELOW;
    const evidence=combined?[...lead,...spoken]:spoken;
    const speaker=evidence.length&&this.speakers?await timed(c,'identity_ms',()=>this.identify(c,evidence,combined?spoken:undefined)):undefined;
    const label=speaker?{speaker:speaker.label,speaker_score:speaker.score,...(speaker.call_only?{call_only:true as const}:{})}:{};
    const segments:SampleAudioResult['segments']=combined?leadSegments.map(segment=>({...segment,...label})):[];
    for(const span of requests) {
      check(!c.signal.aborted,'MEDIA_CANCELLED',409);
      const {text,lang,event,emotion}=await timed(c,'asr_ms',()=>c.engine.transcribe(c.samples.subarray(span.start_sample,span.end_sample_exclusive),c.signal));
      segments.push({...span,text,...(lang?{lang}:{}),...(event?{event}:{}),...(emotion?{emotion}:{}),...label});
    }
    return {segments,evidence:combined?opened:'request'};
  }
  /** A wake turn. The spotter finds where the wake word ends in the first utterance, which carries request words only by
   *  the lane's own rule (wakeCarriesRequest on its whole text); the request is everything after the wake word. Without a
   *  wake word found, all of it is the request. */
  private async woken(c:Analysis,spans:Span[],voiced:Span[]):Promise<Opening> {
    const first=spans[0]!,opening=c.samples.subarray(first.start_sample,first.end_sample_exclusive);
    const hit=c.engine.keywords?await timed(c,'kws_ms',()=>this.spot(c.engine.keywords!,opening,c.signal)):undefined;
    let cut=hit&&(wakeCarriesRequest((await timed(c,'asr_ms',()=>c.engine.transcribe(opening,c.signal))).text,(first.end_sample_exclusive-first.start_sample-hit.end_sample)/16)?
      first.start_sample+hit.end_sample:first.end_sample_exclusive);
    const after=(span:Span):Span|undefined=>cut===undefined||span.start_sample>=cut?span:
      span.end_sample_exclusive>cut?{start_sample:cut,end_sample_exclusive:span.end_sample_exclusive}:undefined;
    let requests=spans.map(after).filter(span=>span!==undefined),spoken=voiced.map(after).filter(span=>span!==undefined);
    if(!requests.length||voiced.length&&!spoken.length){cut=undefined;requests=spans;spoken=voiced;}
    const wake=cut!==undefined&&voiced[0]&&voiced[0].start_sample<cut?
      {start_sample:voiced[0].start_sample,end_sample_exclusive:Math.min(voiced[0].end_sample_exclusive,cut)}:undefined;
    return {lead:wake?[wake]:[],leadSegments:wake?[{start_sample:first.start_sample,end_sample_exclusive:cut!,text:'',
      wake:{keyword:hit!.keyword,end_sample:cut!-first.start_sample}}]:[],requests,spoken,evidence:'wake_and_request'};
  }
  /** A follow-up: its window opens with the replied request's speech (until `end_ms`), its own words start at
   *  `request_start_ms`, and the audio between is neither (依米's reply heard back, other talk). No wake word is looked for.
   *  The carrier is the replied request's most recent voiced speech, at most COMBINE_BELOW of it. */
  private carried(carrier:{end_ms:number;request_start_ms:number},group:SelectedAudioGroup,spans:Span[],voiced:Span[]):Opening {
    const start=sampleAt(group,carrier.request_start_ms);let budget=COMBINE_BELOW;
    const lead=clip(voiced,0,Math.min(start,sampleAt(group,carrier.end_ms))).reverse().flatMap(span=>{
      const take=Math.min(budget,span.end_sample_exclusive-span.start_sample);budget-=take;
      return take>0?[{start_sample:span.end_sample_exclusive-take,end_sample_exclusive:span.end_sample_exclusive}]:[];}).reverse();
    return {lead,leadSegments:lead.map(span=>({...span,text:''})),requests:clip(spans,start,group.total_samples),
      spoken:clip(voiced,start,group.total_samples),evidence:'carrier_and_request'};
  }
  /** One keyword stream per utterance (~80 ms per 3 s): the first hit's label and where the wake word ends in the utterance. */
  private async spot(keywords:KeywordSpotterFactory,utterance:Float32Array,signal:AbortSignal):Promise<{keyword:string;end_sample:number}|undefined> {
    const stream=await keywords.open(signal),mark=(hit:{keyword:string;at_sample:number}|undefined)=>hit&&
      {keyword:hit.keyword,end_sample:Math.max(0,Math.min(utterance.length,hit.at_sample)-KWS_LATENCY)};
    try {
      for(let at=0;at<utterance.length;at+=KWS_CHUNK){check(!signal.aborted,'MEDIA_CANCELLED',409);
        const [hit]=await stream.write(utterance.subarray(at,at+KWS_CHUNK));if(hit)return mark(hit);}
      return mark((await stream.finish())[0]);
    } finally {await stream.close();}
  }
  /** One identity over the speech of `spans`; `alone`: the part of it that is a short request identified with its opening,
   *  embedded on its own too so the registry can check it (null when too short to embed). */
  private async identify({engine,group,request,samples,signal}:Analysis,spans:Span[],alone?:Span[]) {
    const model=this.speakers!.model;
    check(engine.speaker_model.sha256===model.sha256&&engine.speaker_model.dim===model.dim,'VOICEPRINT_SPEAKER_MODEL_MISMATCH',503);
    const speechOf=(parts:Span[])=>{const speech=new Float32Array(parts.reduce((n,span)=>n+span.end_sample_exclusive-span.start_sample,0));
      parts.reduce((at,span)=>{speech.set(samples.subarray(span.start_sample,span.end_sample_exclusive),at);return at+span.end_sample_exclusive-span.start_sample;},0);
      return speech;};
    const embed=async(speech:Float32Array)=>{
      try {return await embedSpeech(engine,speech,signal);}
      catch(error) {if(error instanceof ContractError&&error.code==='SPEECH_INPUT_TOO_SHORT')return null;throw error;}
    };
    const speech=speechOf(spans),embedding=await embed(speech);
    signal.throwIfAborted();
    if(!embedding)return undefined;
    const scope=request.time_range,projected=spans.flatMap(span=>projectSampleInterval(group,span.start_sample,span.end_sample_exclusive,request))
      .flatMap(part=>part.clipped_scope_range?[part.clipped_scope_range]:[]);
    const captured=scope.kind==='interval'&&scope.timebase_id==='utc_epoch_ms'&&projected.length>0;
    const end=captured?projected.at(-1)!.end_ms:Date.now();
    const start=captured?projected[0]!.start_ms:end-(spans.at(-1)!.end_sample_exclusive-spans[0]!.start_sample)/16;
    const observed_at=new Date(end).toISOString(),evidence_start_at=new Date(start).toISOString();
    // Ambient speech may grow other-person profiles; a request turn only reads them.
    const identity=await this.speakers!.identify(embedding,{speech_ms:speech.length/16,quality:speechQuality(speech),signal,...(request.principal_id?{principal_id:request.principal_id}:{}),...(request.device_id?{device_id:request.device_id}:{}),...(request.call_id?{call_id:request.call_id}:{}),observed_at,evidence_start_at,...(!captured?{learning:false as const}:{}),mode:this.mode==='turn'?'verify':'observe',channel:request.identity_channel??(this.mode==='turn'?'ambient':'journal'),
      ...(alone?{request:{embedding:await embed(speechOf(alone)),speech_ms:length(alone)/16}}:{})});
    const label=speakerLabel(identity);
    return label&&identity.kind!=='unknown'?{label,score:identity.score,...(identity.kind==='owner'&&identity.call_only?{call_only:true as const}:{})}:undefined;
  }
}
