// Local, held-out evaluation. Default writes only ephemeral registries; no production registry is loaded.
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {check,digest} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry,type SpeakerModel,type OwnerChannel} from '../src/voiceprint/registry.ts';
import {embedSpeech,speechQuality,type SpeechEngine,type VoiceprintChannel} from '../src/voiceprint/contracts.ts';
import {LocalSpeechEngine,parseLocalSpeechConfig} from '../src/voiceprint/engine.ts';
import type {VoiceprintScoring} from '../src/voiceprint/scoring.ts';
export interface EvaluationSample {
  id:string;channel:VoiceprintChannel;role:'enroll'|'probe'|'cohort';label:'owner'|'tv'|'other';
  speech_ms:number;quality?:number;wav?:string;embedding?:number[];
}
export interface EvaluationManifest {
  schema:'voiceprint-evaluation/v1';evidence:'human_recorded'|'tts'|'synthetic';speaker_model?:SpeakerModel;
  samples:EvaluationSample[];
  normalized_thresholds?:{verified:number;uncertain:number};normalized_calibration?:VoiceprintScoring['calibration'];
}
type EmbeddingEngine=Pick<SpeechEngine,'embed'>;
type Prepared={sample:EvaluationSample;baseline:Float32Array;multiwindow:Float32Array;canonical:Float32Array;quality:number};
const channels:readonly VoiceprintChannel[]=['file','phone_app','call','video','ambient','glasses','journal','mac'];
const enrollmentChannels:readonly VoiceprintChannel[]=['file','phone_app','glasses','mac'];
const strategies=['baseline','multiwindow','quality_weighting','as_norm','channel_calibration'] as const;
const rate=(numerator:number,denominator:number)=>denominator?numerator/denominator:null;
/** Counts use verified owner admission; uncertainty is separately reported for every labeled group. */
export function channelMetrics(rows:{channel:VoiceprintChannel;label:EvaluationSample['label'];verdict:string}[]){
  return Object.fromEntries([...new Set(rows.map(r=>r.channel))].sort().map(channel=>{
    const channelRows=rows.filter(r=>r.channel===channel),groups=Object.fromEntries(['owner','tv','other'].map(label=>{
      const samples=channelRows.filter(r=>r.label===label),accepted=samples.filter(r=>r.verdict==='verified').length;
      return [label,{n:samples.length,verified:accepted,uncertain:samples.filter(r=>r.verdict==='uncertain').length,
        [label==='owner'?'recall':'false_accept_rate']:rate(accepted,samples.length)}];}));
    return [channel,{...groups,uncertain_rate:rate(channelRows.filter(r=>r.verdict==='uncertain').length,channelRows.length)}];}));
}
// Frozen pre-change inference comparator; production consumers must use embedSpeech instead.
async function legacyEmbedding(engine:EmbeddingEngine,pcm:Float32Array){
  const windows=Math.ceil(pcm.length/160000);if(windows<=1)return engine.embed(pcm);
  const size=Math.ceil(pcm.length/windows);let sum:Float32Array|undefined;
  for(let at=0;at<pcm.length;at+=size){const part=pcm.subarray(at,at+size),e=await engine.embed(part);
    const norm=Math.sqrt(e.reduce((n,v)=>n+v*v,0));sum??=new Float32Array(e.length);
    for(let i=0;i<e.length;i++)sum[i]!+=e[i]!*part.length/pcm.length/norm;}
  return sum!;
}
export async function evaluateVoiceprints(manifest:EvaluationManifest,ports:{base:string;engine?:EmbeddingEngine;model?:SpeakerModel}){
  check(manifest.schema==='voiceprint-evaluation/v1'&&['human_recorded','tts','synthetic'].includes(manifest.evidence)&&
    Array.isArray(manifest.samples)&&manifest.samples.length>0,'EVALUATION_MANIFEST_INVALID');
  const ids=new Set<string>(),audioPaths=new Set<string>();
  for(const s of manifest.samples){check(typeof s.id==='string'&&s.id.length>0&&!ids.has(s.id)&&channels.includes(s.channel)&&
    ['enroll','probe','cohort'].includes(s.role)&&['owner','tv','other'].includes(s.label)&&Number.isFinite(s.speech_ms)&&s.speech_ms>0&&
    (s.quality===undefined||Number.isFinite(s.quality)&&s.quality>0&&s.quality<=1)&&
    (s.role!=='enroll'||s.label==='owner'&&enrollmentChannels.includes(s.channel))&&(s.role!=='cohort'||s.label!=='owner')&&Boolean(s.wav)!==Boolean(s.embedding),
    'EVALUATION_SAMPLE_INVALID');ids.add(s.id);
    if(s.wav){const path=resolve(ports.base,s.wav);check(!audioPaths.has(path),'EVALUATION_AUDIO_SPLIT_OVERLAP');audioPaths.add(path);}}
  check(manifest.samples.some(s=>s.role==='enroll')&&manifest.samples.some(s=>s.role==='probe'),'EVALUATION_SPLIT_REQUIRED');
  const model=ports.model??manifest.speaker_model;check(model,'EVALUATION_MODEL_REQUIRED');
  const prepared:Prepared[]=[];
  for(const sample of manifest.samples){
    if(sample.embedding){check(manifest.evidence==='synthetic'&&sample.embedding.length===model.dim&&sample.embedding.every(Number.isFinite),
      'EVALUATION_SYNTHETIC_ONLY');const e=Float32Array.from(sample.embedding);prepared.push({sample,baseline:e,multiwindow:e,canonical:e,quality:sample.quality??1});continue;}
    check(ports.engine,'EVALUATION_ENGINE_REQUIRED');
    const sherpa=createRequire(import.meta.url)('sherpa-onnx-node') as {readWave(p:string):{sampleRate:number;samples:Float32Array}};
    const wave=sherpa.readWave(resolve(ports.base,sample.wav!));
    // Manifests provide VAD-trimmed, mono 16 kHz utterances; no guessed speech duration or resampling.
    check(wave.sampleRate===16000&&wave.samples.length>=sample.speech_ms*16,'EVALUATION_AUDIO_INVALID');
    const pcm=wave.samples,baseline=sample.channel==='call'?await ports.engine.embed(pcm.subarray(Math.max(0,pcm.length-19200))):await legacyEmbedding(ports.engine,pcm);
    const multiwindow=await embedSpeech(ports.engine,pcm,undefined,{quality_weighting:false});
    const canonical=await embedSpeech(ports.engine,pcm);prepared.push({sample,baseline,multiwindow,canonical,quality:sample.quality??speechQuality(pcm)});
  }
  const root=await mkdtemp(join(tmpdir(),'voiceprint-evaluate-')),results:Record<string,unknown>={};
  try{for(const strategy of strategies){
    const cohort=prepared.filter(p=>p.sample.role==='cohort').map(p=>p.canonical),normalized=strategy==='as_norm'||strategy==='channel_calibration';
    if(normalized&&(!manifest.normalized_thresholds||cohort.length<2)){
      results[strategy]={status:'not_run',reason:'independent cohort and frozen normalized thresholds required'};continue;}
    if(strategy==='channel_calibration'&&!manifest.normalized_calibration){
      results[strategy]={status:'not_run',reason:'frozen per-channel normalized calibration required'};continue;}
    const calibration=normalized?Object.fromEntries(channels.map(c=>[c,manifest.normalized_thresholds!])):undefined;
    const scoring:VoiceprintScoring=normalized?{cohort,calibration:{...calibration,...(strategy==='channel_calibration'?manifest.normalized_calibration:{})}}:{};
    const registry=new VoiceprintRegistry(new PosixStorage(join(root,strategy)),model,{call_learning:false,scoring});
    const pick=(p:Prepared)=>strategy==='baseline'?p.baseline:strategy==='multiwindow'?p.multiwindow:p.canonical;
    try{
      for(const channel of [...new Set(prepared.filter(p=>p.sample.role==='enroll').map(p=>p.sample.channel))]){
        const samples=prepared.filter(p=>p.sample.role==='enroll'&&p.sample.channel===channel).map(p=>({embedding:p.canonical,speech_ms:p.sample.speech_ms,
          ...(['quality_weighting','as_norm','channel_calibration'].includes(strategy)?{quality:p.quality}:{})}));
        await registry.enrollOwner({speaker_model:model,channel:channel as OwnerChannel,mode:'replace',samples,at:'2026-10-17T00:00:00.000Z'});
      }
      const rows=[];
      for(const p of prepared.filter(p=>p.sample.role==='probe')){
        const identity=await registry.identify(pick(p),{mode:'verify',channel:p.sample.channel,speech_ms:p.sample.speech_ms,observed_at:'2026-10-17T00:00:00.000Z'});
        rows.push({id:p.sample.id,channel:p.sample.channel,label:p.sample.label,verdict:identity.kind==='owner'?identity.band:identity.kind});
      }
      results[strategy]={status:'completed',channels:channelMetrics(rows),probes:rows};
    }finally{await registry.close();}
  }}finally{await rm(root,{recursive:true,force:true});}
  return {schema:'voiceprint-evaluation-result/v1',at:new Date().toISOString(),evidence:manifest.evidence,
    performance_claim:manifest.evidence==='human_recorded'?'held_out_fixture_only':'none_contract_or_synthesized_audio_only',
    speaker_model:model,enrollment:'fixed_canonical_embeddings_quality_weights_from_quality_weighting_ablation',baseline:'call_tail_1200ms_other_channels_legacy_10s_windows',sample_counts:{enroll:prepared.filter(p=>p.sample.role==='enroll').length,probe:prepared.filter(p=>p.sample.role==='probe').length,
      cohort:prepared.filter(p=>p.sample.role==='cohort').length},results};
}
export async function main(argv:string[]){
  if(argv.includes('--mode')||argv.includes('--registry-store')||argv.includes('--registry-file')){
    await (await import('./voiceprint-offline.ts')).main(argv);return;
  }
  const args=new Map<string,string>();check(argv.length%2===0,'EVALUATION_ARGUMENTS_INVALID');
  for(let i=0;i<argv.length;i+=2){check(['--manifest','--config','--output','--record-result'].includes(argv[i]!)&&!args.has(argv[i]!),
    'EVALUATION_ARGUMENTS_INVALID');args.set(argv[i]!,argv[i+1]!);}
  check(args.has('--manifest'),'EVALUATION_ARGUMENTS_INVALID');
  const path=resolve(args.get('--manifest')!),manifest=JSON.parse(await readFile(path,'utf8')) as EvaluationManifest;
  let engine:LocalSpeechEngine|undefined,resources:Record<string,unknown>|undefined;
  try{
    // Native cost of the configured speaker model on this manifest: one model per run, same PCM and labels across runs.
    const cpu=process.cpuUsage(),started=performance.now(),rss=process.memoryUsage.rss(),latencies:number[]=[];let audio_ms=0,timed:EmbeddingEngine|undefined;
    if(args.has('--config')){const config=JSON.parse(await readFile(args.get('--config')!,'utf8'));
      const {kws:_k,tagging:_t,...speech}=parseLocalSpeechConfig(config.pcm.media.audio.config);
      const opened=await LocalSpeechEngine.open({...speech,num_threads:1});engine=opened;
      resources={num_threads:1,load_ms:performance.now()-started,load_rss_delta_bytes:process.memoryUsage.rss()-rss};
      timed={embed:async pcm=>{const at=performance.now(),e=await opened.embed(pcm);latencies.push(performance.now()-at);audio_ms+=pcm.length/16;return e;}};}
    const result=await evaluateVoiceprints(manifest,{base:dirname(path),...(engine?{engine:timed,model:engine.speaker_model}:{})});
    if(resources){const used=process.cpuUsage(cpu),sorted=latencies.sort((a,b)=>a-b),at=(q:number)=>sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]??null;
      const inference_ms=sorted.reduce((n,v)=>n+v,0);
      Object.assign(resources,{embed_calls:sorted.length,embedded_audio_ms:audio_ms,embed_p50_ms:at(.5),embed_p95_ms:at(.95),embed_p99_ms:at(.99),
        rtf:audio_ms?inference_ms/audio_ms:null,cpu_user_ms:used.user/1000,cpu_system_ms:used.system/1000,
        cpu_ms_per_audio_s:audio_ms?(used.user+used.system)/audio_ms:null,max_rss_bytes:process.resourceUsage().maxRSS*1024,wall_ms:performance.now()-started});}
    const bytes=Buffer.from(JSON.stringify(resources?{...result,resources}:result,null,2)+'\n');
    if(args.has('--output'))await writeFile(args.get('--output')!,bytes,{flag:'wx'});
    if(args.has('--record-result')){const storage=new PosixStorage(args.get('--record-result')!);
      try{await storage.replace('voiceprint-evaluations',digest('last'),bytes);}finally{await storage.close();}}
    process.stdout.write(bytes);
  }finally{await engine?.close();}
}
if(import.meta.main)await main(process.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=2;});
