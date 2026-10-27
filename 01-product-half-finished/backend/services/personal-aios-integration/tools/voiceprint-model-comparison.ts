// Same labelled, disjoint reference/test windows for every model. No registry mutation or model selection.
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {check,digest,ContractError} from '../src/contracts.ts';
import {channelVerifiedLine,registryOwnerSets,type RegistryDoc,type VoiceprintPolicy} from '../src/voiceprint/registry.ts';
import type {VoiceprintChannel} from '../src/voiceprint/contracts.ts';
import {openOfflineModel,type OfflineModelManifest,type OfflineEmbedder} from './voiceprint-offline-models.ts';

interface Window {
  id:string;channel:VoiceprintChannel;role:'reference'|'window';label:'owner'|'guest'|'rejected'|'echo';
  call_id:string;at_ms:number;verification?:{kind:'face_id'}|{kind:'in_call_anchor';verified_utterance:string};
  wav?:string;start_sample?:number;end_sample?:number;synthetic?:Record<string,number[]>;
}
export interface ComparisonManifest {schema:'voiceprint-model-comparison/v1';evidence:'human_recorded'|'synthetic';samples:Window[];
  verified_utterances?:{id:string;call_id:string;at_ms:number;source:'face_id'|'registry_verified'}[]}
const channels=['file','phone_app','glasses','mac','call','video','ambient','journal'];
const round=(n:number)=>Math.round(n*1e6)/1e6;
const rate=(n:number,d:number)=>d?round(n/d):null;
const failure=(e:unknown)=>e instanceof ContractError?e.code:'OFFLINE_MODEL_FAILED';
function unit(v:Float32Array){const norm=Math.hypot(...v);check(v.length>0&&v.every(Number.isFinite)&&norm>0,'OFFLINE_EMBEDDING_INVALID');return Float32Array.from(v,n=>n/norm);}
const dot=(a:Float32Array,b:Float32Array)=>{check(a.length===b.length,'OFFLINE_EMBEDDING_INVALID');return a.reduce((n,v,i)=>n+v*b[i]!,0);};
function centroid(vectors:Float32Array[]){return unit(Float32Array.from(vectors[0]!,(_,i)=>vectors.reduce((n,v)=>n+v[i]!,0)));}
export async function compareSpeakerModels(manifest:ComparisonManifest,ports:{base:string;directory:string;models:OfflineModelManifest;
  registry:RegistryDoc;policy:VoiceprintPolicy;open?:typeof openOfflineModel}) {
  check(manifest?.schema==='voiceprint-model-comparison/v1'&&['human_recorded','synthetic'].includes(manifest.evidence)&&
    Array.isArray(manifest.samples)&&manifest.samples.length>0,'OFFLINE_WINDOWS_INVALID');
  const samples=manifest.samples,ids=new Map(samples.map(s=>[s.id,s]));
  check(ids.size===samples.length,'OFFLINE_WINDOWS_INVALID');
  for(const s of samples){
    check(typeof s.id==='string'&&s.id.length>0&&typeof s.call_id==='string'&&s.call_id.length>0&&channels.includes(s.channel)&&
      Number.isFinite(s.at_ms)&&s.at_ms>=0&&['reference','window'].includes(s.role)&&['owner','guest','rejected','echo'].includes(s.label)&&
      (s.role!=='reference'||s.label==='owner'),'OFFLINE_WINDOWS_INVALID');
    if(s.label==='owner'){
      const v=s.verification;
      check(v&&['face_id','in_call_anchor'].includes(v.kind),'OFFLINE_INDEPENDENT_LABEL_REQUIRED');
      if(v.kind==='in_call_anchor'){
        const utterance=ids.get(v.verified_utterance),recorded=manifest.verified_utterances?.find(a=>a.id===v.verified_utterance);
        const anchor=utterance?.label==='owner'&&utterance.verification?.kind==='face_id'?utterance:
          recorded&&['face_id','registry_verified'].includes(recorded.source)?recorded:undefined;
        check(anchor&&anchor!==s&&anchor.call_id===s.call_id&&Number.isFinite(anchor.at_ms)&&anchor.at_ms<s.at_ms,
          'OFFLINE_INDEPENDENT_LABEL_REQUIRED');
      }
    }
    check(manifest.evidence==='synthetic'?!!s.synthetic&&!s.wav:typeof s.wav==='string'&&!s.synthetic&&
      Number.isSafeInteger(s.start_sample)&&Number.isSafeInteger(s.end_sample)&&s.start_sample!>=0&&s.end_sample!>s.start_sample!,
      'OFFLINE_WINDOWS_INVALID');
  }
  const references=samples.filter(s=>s.role==='reference'),windows=samples.filter(s=>s.role==='window');
  check(references.length>0&&windows.some(s=>s.label==='owner')&&windows.some(s=>s.label!=='owner')&&
    windows.every(s=>references.some(r=>r.channel===s.channel)),'OFFLINE_SPLIT_REQUIRED');
  const pcm=new Map<string,Float32Array>(),ranges:{file:string;start:number;end:number;role:string}[]=[],fingerprints=new Map<string,string>();
  if(manifest.evidence==='human_recorded')for(const s of samples){
    const file=await realpath(resolve(ports.base,s.wav!)),start=s.start_sample!,end=s.end_sample!;
    check(!ranges.some(r=>r.file===file&&r.role!==s.role&&r.start<end&&start<r.end),'OFFLINE_REFERENCE_TEST_OVERLAP');
    ranges.push({file,start,end,role:s.role});
    const sherpa=createRequire(import.meta.url)('sherpa-onnx-node') as {readWave(p:string):{sampleRate:number;samples:Float32Array}};
    const wave=sherpa.readWave(file);check(wave.sampleRate===16000&&end<=wave.samples.length,'OFFLINE_AUDIO_INVALID');
    const window=wave.samples.slice(start,end),hash=digest(Buffer.from(window.buffer).toString('base64'));
    check(!fingerprints.has(hash)||fingerprints.get(hash)===s.role,'OFFLINE_REFERENCE_TEST_OVERLAP');
    fingerprints.set(hash,s.role);pcm.set(s.id,window);
  }
  const current=ports.models.models.find(m=>m.role==='current')!;
  check(registryOwnerSets(ports.registry).some(s=>s.model.sha256===current.sha256),'OFFLINE_CURRENT_MODEL_MISMATCH');
  const results=[];
  for(const spec of ports.models.models){
    check(spec.runtime!=='synthetic'||manifest.evidence==='synthetic','OFFLINE_SYNTHETIC_ONLY');
    let engine:OfflineEmbedder|undefined;
    try{
      const started=performance.now();
      if(spec.runtime!=='synthetic')engine=await (ports.open??openOfflineModel)(spec,ports.directory);
      const load_ms=performance.now()-started;
      const embed=async(s:Window)=>unit(spec.runtime==='synthetic'?Float32Array.from(s.synthetic?.[spec.id]??[]):await engine!.embed(pcm.get(s.id)!));
      const centroids=new Map<string,Float32Array>();
      for(const channel of new Set(references.map(s=>s.channel))){
        const vectors=[];for(const s of references.filter(s=>s.channel===channel))vectors.push(await embed(s));
        centroids.set(channel,centroid(vectors));
      }
      const rows:{channel:string;label:string;score:number|null;ms:number}[]=[],errors:Record<string,number>={};
      for(const s of windows){const at=performance.now();let score:number|null=null;
        try{score=dot(await embed(s),centroids.get(s.channel)!);}catch(e){const code=failure(e);errors[code]=(errors[code]??0)+1;}
        rows.push({channel:s.channel,label:s.label,score,ms:performance.now()-at});}
      const report=Object.fromEntries([...centroids.keys()].sort().map(channel=>{
        const selected=rows.filter(r=>r.channel===channel),line=channelVerifiedLine(ports.registry,channel as VoiceprintChannel,ports.policy);
        const counts=(threshold:number)=>{
          const owner=selected.filter(r=>r.label==='owner'),other=selected.filter(r=>r.label!=='owner');
          return {owner_windows:owner.length,non_owner_windows:other.length,
            unscorable_owner:owner.filter(r=>r.score===null).length,unscorable_non_owner:other.filter(r=>r.score===null).length,
            recall:owner.some(r=>r.score===null)?null:rate(owner.filter(r=>r.score!>=threshold).length,owner.length),
            false_accept_rate:other.some(r=>r.score===null)?null:rate(other.filter(r=>r.score!>=threshold).length,other.length),
            by_non_owner_label:Object.fromEntries(['guest','rejected','echo'].map(label=>{
              const group=other.filter(r=>r.label===label);return [label,{n:group.length,false_accept_rate:group.some(r=>r.score===null)?null:rate(group.filter(r=>r.score!>=threshold).length,group.length)}];}))};
        };
        const times=selected.map(r=>r.ms).sort((a,b)=>a-b),negative=selected.filter(r=>r.label!=='owner'&&r.score!==null).map(r=>r.score!);
        return [channel,{verified_line:line,at_channel_line:counts(line),at_065:counts(.65),
          impostor_margin:negative.length&&!selected.some(r=>r.label!=='owner'&&r.score===null)?round(line-Math.max(...negative)):null,
          per_window_ms:{n:times.length,mean:times.length?round(times.reduce((n,v)=>n+v,0)/times.length):null,
            p50:times.length?round(times[Math.ceil(times.length*.5)-1]!):null,p95:times.length?round(times[Math.ceil(times.length*.95)-1]!):null}}];
      }));
      results.push({id:spec.id,role:spec.role,sha256:spec.sha256,status:Object.keys(errors).length?'incomplete':'completed',load_ms:round(load_ms),errors,channels:report});
    }catch(e){results.push({id:spec.id,role:spec.role,sha256:spec.sha256,status:'failed',load_ms:null,errors:{[failure(e)]:1},channels:{} as Record<string,never>});}
    finally{await engine?.close();}
  }
  return {schema:'voiceprint-model-comparison-result/v1',evidence:manifest.evidence,num_threads:1,models:results,
    performance_claim:manifest.evidence==='synthetic'?'none_synthetic_contract_only':'held_out_labelled_windows_only',
    scoring:'raw_cosine_same_channel_reference_mean',thresholds:'same_numeric_operating_points_not_candidate_calibration',
    timing_scope:'embedding_and_cosine_batch_1_excludes_file_io_model_load_and_reference_build',
    sample_counts:{references:references.length,windows:windows.length},production_model_changed:false,
    complete:results.every(m=>m.status==='completed')};
}
