// Worker thread owning the sherpa-onnx models. Native calls are synchronous; the host sends one request at a time.
import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {HEALTH_SOUNDS,NATIVE_WINDOW_SAMPLES,senseVoiceTranscript} from './contracts.ts';
import type {ThreadConfig,ThreadReply,ThreadRequest,VadEvent} from './engine.ts';

interface Wave {sampleRate:number;samples:Float32Array}
interface NativeStream {acceptWaveform(wave:Wave):void;inputFinished():void}
interface NativeVad {acceptWaveform(samples:Float32Array):void;isDetected():boolean;isEmpty():boolean;front(external:boolean):{start:number;samples:Float32Array};pop():void;reset():void}
interface Sherpa {
  version:string;
  Vad:new(config:object,bufferSeconds:number)=>NativeVad;
  OfflineRecognizer:new(config:object)=>{createStream():NativeStream;decode(stream:NativeStream):void;getResult(stream:NativeStream):{text:string;lang?:string;event?:string;emotion?:string}};
  SpeakerEmbeddingExtractor:new(config:object)=>{dim:number;createStream():NativeStream;isReady(stream:NativeStream):boolean;compute(stream:NativeStream,external:boolean):Float32Array};
  KeywordSpotter:new(config:object)=>{createStream():NativeStream;isReady(stream:NativeStream):boolean;decode(stream:NativeStream):void;getResult(stream:NativeStream):{keyword:string};reset(stream:NativeStream):void};
  AudioTagging:new(config:object)=>{createStream():NativeStream;compute(stream:NativeStream,topK:number):{name:string;prob:number}[]};
}
class Refusal extends Error {readonly code:string;readonly status:number;constructor(code:string,status=400){super(code);this.code=code;this.status=status;}}
const need:(ok:unknown,code:string,status?:number)=>asserts ok=(ok,code,status=400)=>{if(!ok)throw new Refusal(code,status);};
const port=parentPort!,config=workerData as ThreadConfig,sherpa=createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa;
const rate=16000,window=512,feat={sampleRate:rate,featureDim:80};
// sherpa 1.13.8 forwards these CPU session settings to ORT; no provider/model/precision change.
const provider=`cpu:${fileURLToPath(new URL('./cpu.conf',import.meta.url))}`;
// sherpa VoiceActivityDetector: a segment starts 2 windows + min speech before the detection frame, never before the
// buffer head, which trails the tail by that much in silence and sits at the previous segment end after one.
const lookback=2*window+Math.trunc(rate*config.vad.min_speech_ms/1000);
const newVad=()=>new sherpa.Vad({sileroVad:{model:config.vad.model,threshold:config.vad.threshold,windowSize:window,
  minSpeechDuration:config.vad.min_speech_ms/1000,minSilenceDuration:config.vad.min_silence_ms/1000,maxSpeechDuration:config.vad.max_speech_ms/1000},
  sampleRate:rate,numThreads:1,provider,debug:0},60);
const kws=config.kws;
const loaded:Record<string,{sessions:number;load_rss_delta_bytes:number;load_ms:number}>={};
// Each factory has exactly one resident session. VAD recurrent state is stream-owned by sherpa's native API.
function lazy<T>(name:string,create:()=>T):()=>T {
  let value:T|undefined;
  return ()=>{
    if(value!==undefined)return value;
    const rss=process.memoryUsage.rss(),start=performance.now();value=create();
    loaded[name]={sessions:1,load_rss_delta_bytes:process.memoryUsage.rss()-rss,load_ms:performance.now()-start};return value;
  };
}
const asr=lazy('asr',()=>{
  need(!config.call_only&&!config.speaker_only,'SPEECH_OPERATION_UNAVAILABLE',503);
  return new sherpa.OfflineRecognizer({featConfig:feat,modelConfig:{senseVoice:{model:config.asr.model,language:config.asr.language,useInverseTextNormalization:1},
    tokens:config.asr.tokens,numThreads:config.num_threads,provider,debug:0}});
});
const speaker=lazy('speaker',()=>{
  need(config.speaker_only,'SPEECH_OPERATION_UNAVAILABLE',503);
  return new sherpa.SpeakerEmbeddingExtractor({model:config.speaker.model,numThreads:config.num_threads,provider,debug:0});
});
const tagging=lazy('tagging',()=>{
  need(!config.call_only&&!config.speaker_only&&config.tagging,'SPEECH_TAGGING_NOT_CONFIGURED',503);
  return new sherpa.AudioTagging({model:{zipformer:{model:config.tagging.model},numThreads:config.num_threads,provider,debug:0},
    labels:config.tagging.labels,topK:5});
});
const spotter=lazy('kws',()=>{
  need(kws&&!config.speaker_only,'SPEECH_KWS_NOT_CONFIGURED',503);
  return new sherpa.KeywordSpotter({featConfig:feat,modelConfig:{transducer:{encoder:kws.encoder,decoder:kws.decoder,joiner:kws.joiner},
    tokens:kws.tokens,numThreads:1,provider,debug:0},maxActivePaths:4,numTrailingBlanks:1,keywordsScore:kws.score,
    keywordsThreshold:kws.threshold,keywordsBuf:kws.keywords,keywordsBufSize:Buffer.byteLength(kws.keywords)});
});
const pool:NativeVad[]=[];
const detectors=new Map<number,{vad:NativeVad;tail:number;head:number;start:number;speech:boolean}>();
const spotting=new Map<number,{stream:NativeStream;fed:number}>();
let next=1;

function stream<T>(streams:Map<number,T>,id:unknown):T {const found=streams.get(id as number);need(found,'SPEECH_STREAM_UNKNOWN',409);return found;}
function samples(value:unknown,frame=1):Float32Array {need(value instanceof Float32Array&&value.length%frame===0,'SPEECH_INPUT_INVALID');return value;}
function spot(state:{stream:NativeStream;fed:number}):{keyword:string;at_sample:number}[] {
  const hits=[];
  while(spotter().isReady(state.stream)) {
    spotter().decode(state.stream);const {keyword}=spotter().getResult(state.stream);
    if(keyword){hits.push({keyword,at_sample:state.fed});spotter().reset(state.stream);}
  }
  return hits;
}
const handlers:{[K in ThreadRequest['op']]:(request:Extract<ThreadRequest,{op:K}>)=>unknown}={
  tag:({samples:input})=>{
    need(samples(input).length>0,'SPEECH_INPUT_EMPTY');need(input.length<=NATIVE_WINDOW_SAMPLES,'SPEECH_INPUT_BUDGET',413);const model=tagging();
    // Very short native tagging inputs can abort ONNX Runtime (CED's convolution); a one-second floor also bounds Zipformer features.
    const padded=new Float32Array(Math.max(rate,input.length));padded.set(input);
    const s=model.createStream();s.acceptWaveform({sampleRate:rate,samples:padded});
    const best=model.compute(s,1)[0];
    // Multi-label AudioSet scores: below 0.5 the top label is a guess; speech and microphone breath can otherwise be tagged as sneezes.
    return best&&best.prob>=0.5?Object.entries(HEALTH_SOUNDS).find(([,v])=>v[0]===best.name)?.[0]:undefined;
  },
  transcribe:({samples:input,words_only})=>{
    need(samples(input).length>0,'SPEECH_INPUT_EMPTY');const model=asr();
    const s=model.createStream();s.acceptWaveform({sampleRate:rate,samples:input});model.decode(s);
    const result=model.getResult(s);
    return words_only?{text:result.text.replace(/<\|[^|]*\|>/gu,'').trim()}:senseVoiceTranscript(result);
  },
  embed:({samples:input})=>{
    need(samples(input).length>0,'SPEECH_INPUT_EMPTY');const model=speaker();
    const s=model.createStream();s.acceptWaveform({sampleRate:rate,samples:input});s.inputFinished();
    need(model.isReady(s),'SPEECH_INPUT_TOO_SHORT');
    return Float32Array.from(model.compute(s,false));
  },
  vad_open:()=>{
    need(detectors.size+spotting.size<config.max_streams,'SPEECH_STREAM_BUDGET',503);
    const id=next++;detectors.set(id,{vad:pool.pop()??newVad(),tail:0,head:0,start:-1,speech:false});return id;
  },
  vad_write:request=>{
    const state=stream(detectors,request.stream),input=samples(request.samples,window),events:VadEvent[]=[];
    for(let at=0;at<input.length;at+=window) {
      state.vad.acceptWaveform(input.subarray(at,at+window));state.tail+=window;
      const speech=state.vad.isDetected();
      if(speech&&!state.speech){state.start=Math.max(state.tail-lookback,state.head);events.push({at:state.tail,start:state.start});}
      else if(!speech&&state.speech) {
        need(!state.vad.isEmpty(),'SPEECH_VAD_SEGMENT_MISSING',500);
        const segment=state.vad.front(false);state.vad.pop();
        // The start reported at detection must be the segment the detector later closes; otherwise fail closed.
        need(segment.start===state.start,'SPEECH_VAD_START_DRIFT',500);
        state.head=segment.start+segment.samples.length;events.push({at:state.tail,end:state.head});
      } else if(!speech) state.head=Math.max(state.head,state.tail-lookback);
      need(state.vad.isEmpty(),'SPEECH_VAD_SEGMENT_UNEXPECTED',500);state.speech=speech;
    }
    return events;
  },
  vad_close:({stream:id})=>{
    const state=detectors.get(id);
    if(state){detectors.delete(id);state.vad.reset();if(pool.length<4)pool.push(state.vad);}
    return null;
  },
  kws_open:()=>{
    need(detectors.size+spotting.size<config.max_streams,'SPEECH_STREAM_BUDGET',503);
    const id=next++;spotting.set(id,{stream:spotter().createStream(),fed:0});return id;
  },
  kws_write:request=>{
    const state=stream(spotting,request.stream),input=samples(request.samples);
    if(input.length){state.stream.acceptWaveform({sampleRate:rate,samples:input});state.fed+=input.length;}
    if(request.final){state.stream.acceptWaveform({sampleRate:rate,samples:new Float32Array(rate/2)});state.stream.inputFinished();}
    return spot(state);
  },
  kws_close:({stream:id})=>{spotting.delete(id);return null;},
};
const resourceSnapshot=()=>({observed_at:Date.now(),models:loaded,vad_sessions:pool.length+detectors.size,vad_streams:detectors.size,kws_streams:spotting.size,
  limits:{shared_sessions_per_model:1,streams:config.max_streams,vad_cached:4},memory:process.memoryUsage(),num_threads:config.num_threads,
  session_options:{enableCpuMemArena:false,enableMemPattern:false}});
let reported=0;
port.on('message',(request:ThreadRequest)=>{
  let reply:ThreadReply,transfer:ArrayBuffer[]=[];
  try {
    const value=(handlers[request.op] as (request:ThreadRequest)=>unknown)(request);
    if(value instanceof Float32Array)transfer=[value.buffer as ArrayBuffer];
    reply={id:request.id,ok:true,value};
  } catch(error) {
    reply=error instanceof Refusal?{id:request.id,ok:false,code:error.code,status:error.status}:{id:request.id,ok:false,code:'SPEECH_NATIVE_FAILED',status:500};
  }
  port.postMessage(reply,transfer);
  if(performance.now()-reported>=1000){reported=performance.now();port.postMessage({resources:resourceSnapshot()});}
});
const dim=config.speaker_only?speaker().dim:1;
port.postMessage({ready:true,version:sherpa.version,dim,resources:resourceSnapshot()});
