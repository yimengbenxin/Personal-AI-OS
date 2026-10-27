import {SpeechWorker} from './worker.ts';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,isAbsolute} from 'node:path';
import {check,ContractError,digest} from '../contracts.ts';
import type {KeywordHit,KeywordSpotterFactory,KeywordStream,SoundEvent,SpeechEngine,SpeechTranscript} from './contracts.ts';

export interface ModelFile {path:string;sha256:string}
export interface KeywordSpec {label:string;tokens:string}
/** `pcm.media.audio.config` of provider `local_sherpa`. Every model file is pinned and verified before load. */
export interface LocalSpeechConfig {
  num_threads:number;timeout_ms:number;
  vad:{model:ModelFile};asr:{model:ModelFile;tokens:ModelFile};speaker:{model:ModelFile};
  tagging?:{model:ModelFile;labels:ModelFile};
  kws?:{encoder:ModelFile;decoder:ModelFile;joiner:ModelFile;tokens:ModelFile;keywords:KeywordSpec[];call_keywords?:KeywordSpec[];score:number;threshold:number};
}
/** Detector policy owned by the engine and recorded in every VAD model descriptor. */
export const VAD_POLICY=Object.freeze({threshold:0.5,min_speech_ms:250,min_silence_ms:352,max_speech_ms:20000});
export const DEFAULT_KEYWORDS:readonly KeywordSpec[]=Object.freeze([{label:'依米',tokens:'y ī m ǐ'}]);
export const CALL_INTERRUPT_KEYWORDS:readonly KeywordSpec[]=Object.freeze([
  {label:'依米',tokens:'y ī m ǐ'},{label:'等等',tokens:'d ěng d ěng'},{label:'等一下',tokens:'d ěng y í x ià'},
  {label:'等下',tokens:'d ěng x ià'},{label:'停',tokens:'t íng'},{label:'停一下',tokens:'t íng y í x ià'},
  {label:'打住',tokens:'d ǎ zh ù'},{label:'听我说',tokens:'t īng w ǒ sh uō'},{label:'不对',tokens:'b ú d uì'},
  {label:'暂停',tokens:'z àn t íng'},{label:'先别说',tokens:'x iān b ié sh uō'},
  {label:'别说了',tokens:'b ié sh uō l e'},
]);
export const CALL_VAD_POLICY=Object.freeze({...VAD_POLICY,min_speech_ms:64,min_silence_ms:128});
const MAX_STREAMS=16;

/** Worker-thread input: paths only, the host verified their pins. */
export interface ThreadConfig {
  num_threads:number;max_streams:number;call_only?:boolean;speaker_only?:boolean;vad:{model:string;threshold:number;min_speech_ms:number;min_silence_ms:number;max_speech_ms:number};asr:{model:string;tokens:string;language:'zh'};speaker:{model:string};
  kws?:{encoder:string;decoder:string;joiner:string;tokens:string;keywords:string;score:number;threshold:number};
  tagging?:{model:string;labels:string};
}
export type SpeechCall={op:'transcribe'|'embed';samples:Float32Array;words_only?:true}|{op:'tag';samples:Float32Array}|{op:'vad_open'|'kws_open'}|{op:'vad_write';stream:number;samples:Float32Array}|
  {op:'kws_write';stream:number;samples:Float32Array;final:boolean}|{op:'vad_close'|'kws_close';stream:number};
export type ThreadRequest=SpeechCall&{id:number};
export type ThreadReply={id:number;ok:true;value:unknown}|{id:number;ok:false;code:string;status:number};
/** A frame whose detector state changed; `at` is the processed sample count after that frame. */
export interface VadEvent {at:number;start?:number;end?:number}
export interface SpeechVadStream {write(samples:Float32Array):Promise<VadEvent[]>;close():Promise<void>}

function record(value:unknown,allowed:string[],required=allowed):Record<string,unknown> {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))&&
    required.every(key=>Object.hasOwn(value,key)),'SPEECH_CONFIG_INVALID');
  return value as Record<string,unknown>;
}
function file(value:unknown):ModelFile {
  const f=record(value,['path','sha256']);
  check(typeof f.path==='string'&&isAbsolute(f.path)&&f.path.length<=4096&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/u.test(f.sha256),
    'SPEECH_CONFIG_INVALID');
  return {path:f.path,sha256:f.sha256};
}
export function parseKeywordSpecs(value:unknown,error='SPEECH_CONFIG_INVALID'):KeywordSpec[] {
  check(Array.isArray(value)&&value.length>0&&value.length<=32,error);
  return value.map(entry=>{
    check(entry!==null&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).sort().join(',')==='label,tokens',error);
    check(typeof entry.label==='string'&&/^[^\s@:#]{1,32}$/u.test(entry.label)&&typeof entry.tokens==='string'&&
      /^[^\s@:#](?:[^\n@:#]{0,254}[^\s@:#])?$/u.test(entry.tokens),error);
    return {label:entry.label,tokens:entry.tokens};
  });
}
export function parseLocalSpeechConfig(value:unknown):LocalSpeechConfig {
  const c=record(value,['num_threads','timeout_ms','vad','asr','speaker','kws','tagging'],['num_threads','timeout_ms','vad','asr','speaker']);
  const threads=c.num_threads,timeout=c.timeout_ms;
  check(Number.isSafeInteger(threads)&&Number(threads)>=1&&Number(threads)<=4&&Number.isSafeInteger(timeout)&&Number(timeout)>0&&
    Number(timeout)<=600000,'SPEECH_CONFIG_INVALID');
  const vad=record(c.vad,['model']),asr=record(c.asr,['model','tokens']),speaker=record(c.speaker,['model']);
  const parsed:LocalSpeechConfig={num_threads:Number(threads),timeout_ms:Number(timeout),vad:{model:file(vad.model)},
    asr:{model:file(asr.model),tokens:file(asr.tokens)},speaker:{model:file(speaker.model)}};
  if(c.tagging!==undefined){const tagging=record(c.tagging,['model','labels']);parsed.tagging={model:file(tagging.model),labels:file(tagging.labels)};}
  if(c.kws===undefined)return parsed;
  const k=record(c.kws,['encoder','decoder','joiner','tokens','keywords','call_keywords','score','threshold'],['encoder','decoder','joiner','tokens']);
  // Keyword score and threshold default to the calibrated pair; both remain configurable.
  const keywords=k.keywords??DEFAULT_KEYWORDS,score=k.score??2.0,threshold=k.threshold??0.15;
  check(typeof score==='number'&&Number.isFinite(score)&&score>0&&
    score<=10&&typeof threshold==='number'&&threshold>0&&threshold<1,'SPEECH_CONFIG_INVALID');
  parsed.kws={encoder:file(k.encoder),decoder:file(k.decoder),joiner:file(k.joiner),tokens:file(k.tokens),score,threshold,
    keywords:parseKeywordSpecs(keywords),...(k.call_keywords===undefined?{}:{call_keywords:parseKeywordSpecs(k.call_keywords)})};
  return parsed;
}
export async function verifyModelFile(model:ModelFile):Promise<void> {
  const hash=createHash('sha256');
  try {for await (const chunk of createReadStream(model.path,{highWaterMark:1<<20}))hash.update(chunk as Buffer);}
  catch(error) {
    if(['ENOENT','EISDIR','EACCES','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw new ContractError('SPEECH_MODEL_UNAVAILABLE',503);
    throw error;
  }
  check(hash.digest('hex')===model.sha256,'SPEECH_MODEL_PIN_MISMATCH',503);
}

const engines=new Set<LocalSpeechEngine>();
export const speechResourcesSnapshot=()=>[...engines].map(engine=>engine.resourceSnapshot());
/** One speech authority. Ambient and call detectors have separate latency lanes. A single speaker worker serves both
 *  without waiting for ASR. Native sessions are loaded on use, except speaker metadata needed by the identity contract. */
export class LocalSpeechEngine implements SpeechEngine {
  readonly asr_model:{id:string;sha256:string};
  readonly speaker_model:{id:string;sha256:string;dim:number};
  readonly tagging_model:{id:string;sha256:string;labels_sha256:string}|undefined;
  readonly vad_model:{id:string;version:string;device:string;native_metadata:{onnx_sha256:string}&Record<string,string|number>};
  /** Runtime and pinned-model identity of transcription output. */
  readonly version:string;
  readonly keywords:KeywordSpotterFactory|undefined;
  private readonly worker:SpeechWorker;
  private readonly speakerWorker:SpeechWorker;
  private readonly callWorker:ReturnType<typeof recoveringEngine<SpeechWorker>>;
  private callLane:SpeechWorker|undefined;
  private closing:Promise<void>|undefined;

  /** `thread` replaces the native module with a controlled one (tests); pins are verified either way. */
  static async open(config:LocalSpeechConfig,options:{thread?:URL}={}):Promise<LocalSpeechEngine> {
    const k=config.kws,t=config.tagging;
    for(const model of [config.vad.model,config.asr.model,config.asr.tokens,config.speaker.model,...(k?[k.encoder,k.decoder,k.joiner,k.tokens]:[]),...(t?[t.model,t.labels]:[])])
      await verifyModelFile(model);
    const workerData:ThreadConfig={num_threads:config.num_threads,max_streams:MAX_STREAMS,vad:{model:config.vad.model.path,...VAD_POLICY},
      asr:{model:config.asr.model.path,tokens:config.asr.tokens.path,language:'zh'},speaker:{model:config.speaker.model.path},
      ...(t?{tagging:{model:t.model.path,labels:t.labels.path}}:{}),
      ...(k?{kws:{encoder:k.encoder.path,decoder:k.decoder.path,joiner:k.joiner.path,tokens:k.tokens.path,score:k.score,
        threshold:k.threshold,keywords:k.keywords.map(w=>`${w.tokens} @${w.label}\n`).join('')}}:{})};
    const thread=options.thread??new URL('./engine-thread.ts',import.meta.url);
    const speaker=await SpeechWorker.open(thread,{...workerData,speaker_only:true},config.timeout_ms);
    try {
      const ready=await SpeechWorker.open(thread,workerData,config.timeout_ms);
      return new LocalSpeechEngine(config,{...ready,dim:speaker.dim},speaker.worker,thread,workerData);
    } catch(error) {await speaker.worker.close();throw error;}
  }
  private constructor(config:LocalSpeechConfig,ready:{worker:SpeechWorker;version:string;dim:number},speaker:SpeechWorker,thread:URL,workerData:ThreadConfig) {
    this.worker=ready.worker;
    this.speakerWorker=speaker;engines.add(this);
    this.callWorker=recoveringEngine(async()=>{
      const loaded=await SpeechWorker.open(thread,{...workerData,call_only:true,num_threads:1,max_streams:4,
        ...(workerData.kws?{kws:{...workerData.kws,keywords:(config.kws?.call_keywords??CALL_INTERRUPT_KEYWORDS).map(w=>`${w.tokens} @${w.label}\n`).join('')}}:{}),
        vad:{model:workerData.vad.model,...CALL_VAD_POLICY}},config.timeout_ms,4);
      return this.callLane=loaded.worker;
    });
    this.asr_model={id:'sense-voice',sha256:config.asr.model.sha256};
    this.speaker_model={id:basename(config.speaker.model.path).replace(/\.onnx$/u,''),sha256:config.speaker.model.sha256,dim:ready.dim};
    this.tagging_model=config.tagging?{id:'zipformer-audioset',sha256:config.tagging.model.sha256,labels_sha256:config.tagging.labels.sha256}:undefined;
    this.vad_model={id:'silero-vad',version:`sherpa-onnx@${ready.version}`,device:'cpu',
      native_metadata:{onnx_sha256:config.vad.model.sha256,...VAD_POLICY,...(config.tagging?{sound_window_samples:48000,lookback_samples:1024+16*VAD_POLICY.min_speech_ms}:{})}};
    this.version=`sherpa-onnx@${ready.version}+${digest(['care-audio-annotations-v2',VAD_POLICY,workerData.asr.language,config.asr.model.sha256,config.asr.tokens.sha256,
      config.vad.model.sha256,config.speaker.model.sha256,this.tagging_model??null]).slice(0,16)}`;
    this.keywords=config.kws?{open:signal=>this.openKeywords(signal)}:undefined;
  }
  get failed():boolean {return this.worker.failed||this.speakerWorker.failed;}
  /** Current capacity observation; admission still races on the queue bound. */
  available():boolean {return !this.closing&&this.worker.available()&&this.speakerWorker.available();}
  idle():boolean {return !this.closing&&this.worker.idle()&&this.speakerWorker.idle();}
  resourceSnapshot() {return {ambient:this.worker.snapshot(),speaker:this.speakerWorker.snapshot(),call:this.callLane?.snapshot()??null};}
  transcribe(samples:Float32Array,signal?:AbortSignal):Promise<SpeechTranscript> {return this.worker.call({op:'transcribe',samples},signal);}
  async transcribeWords(samples:Float32Array,signal?:AbortSignal):Promise<string> {return (await this.worker.call({op:'transcribe',samples,words_only:true},signal) as {text:string}).text;}
  tag(samples:Float32Array,signal?:AbortSignal):Promise<SoundEvent|undefined> {return this.worker.call({op:'tag',samples},signal);}
  async embed(samples:Float32Array,signal?:AbortSignal):Promise<Float32Array> {
    this.worker.ensureOpen();
    return this.embedOn(this.speakerWorker,samples,signal);
  }
  /** One speaker session for both lanes; it never waits for ambient ASR. */
  async embedCall(samples:Float32Array,signal?:AbortSignal):Promise<Float32Array> {
    check(!this.closing,'SPEECH_ENGINE_CLOSED',503);
    check(!signal?.aborted,'SPEECH_CANCELLED',409);
    return this.embedOn(this.speakerWorker,samples,signal);
  }
  private async embedOn(worker:SpeechWorker,samples:Float32Array,signal?:AbortSignal):Promise<Float32Array> {
    const vector=await worker.call<Float32Array>({op:'embed',samples},signal);
    check(vector instanceof Float32Array&&vector.length===this.speaker_model.dim,'SPEECH_EMBEDDING_INVALID',502);
    return vector;
  }
  /** Whole 512-sample frames, 16 kHz mono. Ambient detector policy stays unchanged. */
  openVad(signal:AbortSignal):Promise<SpeechVadStream> {return this.openVadOn(this.worker,signal);}
  /** Dedicated call lane. It never waits for ambient ASR or embeddings. */
  async openCallVad(signal:AbortSignal):Promise<SpeechVadStream> {
    check(!this.closing,'SPEECH_ENGINE_CLOSED',503);
    check(!signal.aborted,'SPEECH_CANCELLED',409);
    return this.openVadOn(await this.callWorker.current(),signal,true);
  }
  private async openVadOn(worker:SpeechWorker,signal:AbortSignal,call=false):Promise<SpeechVadStream> {
    const id=await worker.call<number>({op:'vad_open'},signal),own=new AbortController();let closing:Promise<void>|undefined,pending=false;
    const close=()=>closing??=(own.abort(),signal.removeEventListener('abort',abort),
      worker.closeStream({op:'vad_close',stream:id}));
    // Abort observes cleanup; explicit close() still returns the same failure.
    const abort=()=>{void close().catch(()=>undefined);};signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){await close();throw new ContractError('SPEECH_CANCELLED',409);}
    return {write:samples=>{
      if(own.signal.aborted)return Promise.reject(new ContractError('SPEECH_STREAM_CLOSED',409));
      if(call&&(!(samples instanceof Float32Array)||!samples.length||samples.length%512!==0||samples.length>2048||samples.some(x=>!Number.isFinite(x))))
        return Promise.reject(new ContractError('SPEECH_INPUT_INVALID',400));
      if(call&&pending)return Promise.reject(new ContractError('SPEECH_ENGINE_BUSY',503));
      pending=true;return worker.call<VadEvent[]>({op:'vad_write',stream:id,samples},own.signal).finally(()=>{pending=false;});
    },close};
  }
  async openCallKeywords(signal:AbortSignal):Promise<KeywordStream> {
    check(!this.closing,'SPEECH_ENGINE_CLOSED',503);
    check(!signal.aborted,'SPEECH_CANCELLED',409);
    return this.openKeywords(signal,await this.callWorker.current());
  }
  private async openKeywords(signal:AbortSignal,worker=this.worker):Promise<KeywordStream> {
    const stream=await worker.call<number>({op:'kws_open'},signal),own=new AbortController();
    let closing:Promise<void>|undefined,ended=false;
    const close=()=>closing??=(own.abort(),signal.removeEventListener('abort',abort),
      worker.closeStream({op:'kws_close',stream}));
    // Abort observes cleanup; explicit close() still returns the same failure.
    const abort=()=>{void close().catch(()=>undefined);};signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){await close();throw new ContractError('SPEECH_CANCELLED',409);}
    const write=(samples:Float32Array,final:boolean)=>{
      if(ended||own.signal.aborted)return Promise.reject(new ContractError('SPEECH_STREAM_CLOSED',409));
      ended=final;return worker.call<KeywordHit[]>({op:'kws_write',stream,samples,final},own.signal);
    };
    return {write:samples=>write(samples,false),finish:async()=>{try {return await write(new Float32Array(0),true);} finally {await close();}},close};
  }
  close():Promise<void> {
    return this.closing??=Promise.allSettled([this.callWorker.close(),this.worker.close(),this.speakerWorker.close()])
      .then(results=>{const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
        if(errors.length)throw new AggregateError(errors,'SPEECH_ENGINE_CLOSE_FAILED');
      }).finally(()=>{engines.delete(this);});
  }

}

/** Owner of one engine slot: the first use opens it; a failed load or a failed engine (native timeout, thread exit) is
 *  replaced by a fresh open on a later use, at most once per cooldown so a crashing model cannot spin. Streams opened
 *  on the failed engine stay failed; their owners restart them. */
export function recoveringEngine<E extends {readonly failed:boolean;close():Promise<void>}>(open:()=>Promise<E>,cooldown_ms=30_000,now=Date.now) {
  let engine:Promise<E>|undefined,opened=0,closed=false;
  const current=async():Promise<E>=>{
    check(!closed,'LOCAL_AUDIO_CLOSED',503);
    const pending=engine,settled=pending&&(await Promise.allSettled([pending]))[0]!;
    if(engine!==pending)return current(); // a concurrent caller already replaced it
    if(settled?.status==='fulfilled'&&!settled.value.failed)return settled.value;
    // Within the cooldown a failed load keeps answering with its own cause (pin mismatch, missing model).
    if(settled&&now()-opened<cooldown_ms){if(settled.status==='rejected')return pending!;throw new ContractError('SPEECH_ENGINE_RECOVERING',503);}
    check(!closed,'LOCAL_AUDIO_CLOSED',503);
    opened=now();
    return engine=(async()=>{
      if(settled?.status==='fulfilled')await settled.value.close();
      check(!closed,'LOCAL_AUDIO_CLOSED',503);
      return open();
    })();
  };
  return {current,async close(){closed=true;const settled=engine&&(await Promise.allSettled([engine]))[0]!;
    if(settled?.status==='fulfilled')await settled.value.close();}};
}
