// Retained confirmed-sample replay; this is not independent held-out performance evidence.
import {check} from '../src/contracts.ts';
import {advanceVerifiedThreshold,voiceprintPolicy,migrateRegistry,channelVerifiedLine,decodeEmbedding,
  type VoiceprintPolicyOptions,type RegistryDoc,type RegistryDocV1,type OwnerSetDoc,type LearnedSetDoc} from '../src/voiceprint/registry.ts';

type Part={vector:Float32Array;weight:number};
export interface LabelledImpostor {channel:string;model_sha256:string;label:'guest'|'rejected'|'echo';embedding:string}
type ChannelResult={confirmed_samples:number;scored_samples:number;baseline_rejected:number;candidate_rejected:number;
  added_false_rejects:number;current_line_added_false_rejects:number;projected_line_added_false_rejects:number;
  current_threshold:number;final_threshold:number;replayed_threshold:number;stored_threshold:number|null;
  impostor_margin:number|null;labelled_impostors:number;unlabelled_cluster_margin:number|null;
  trajectory:{samples:number;threshold_before:number;threshold:number}[]};
const round=(v:number)=>Math.round(v*10000)/10000;
function unit(v:Float32Array){const length=Math.hypot(...v);check(length>0,'VOICEPRINT_EMBEDDING_INVALID');return Float32Array.from(v,n=>n/length);}
const dot=(a:Float32Array,b:Float32Array)=>a.reduce((n,v,i)=>n+v*b[i]!,0);
function mean(parts:Part[]){const sum=new Float32Array(parts[0]!.vector.length);
  for(const p of parts)for(let i=0;i<sum.length;i++)sum[i]!+=p.vector[i]!*p.weight;
  return unit(sum);}

export async function evaluateAdaptiveRegistry(input:RegistryDoc|RegistryDocV1,options:{policy?:VoiceprintPolicyOptions;impostors?:LabelledImpostor[]}={}){
  check(input&&['paios.voiceprint.registry.v1','paios.voiceprint.registry.v2'].includes(input.schema),'VOICEPRINT_REGISTRY_CORRUPT');
  const doc=migrateRegistry(input),policy=voiceprintPolicy(options.policy),base=policy.thresholds.owner_verified;
  check(Array.isArray(doc.owner_sets)&&Array.isArray(doc.clusters),'VOICEPRINT_REGISTRY_CORRUPT');
  const sets:{set:OwnerSetDoc|LearnedSetDoc;weighted:boolean;parts:Part[];threshold:number;min:number}[]=[
    ...doc.owner_sets.map(set=>({set,weighted:true})),...(doc.conversation_owner??[]).map(set=>({set,weighted:true})),
    ...Object.values(doc.learned_owner??{}).map(set=>({set:set!,weighted:false})),
    ...(doc.call_owner?[{set:doc.call_owner,weighted:false}]:[]),
  ].map(s=>({...s,parts:[],threshold:base,min:1}));
  const channels:Partial<Record<string,ChannelResult>>={};
  for(const {set} of sets){
    check(set&&['file','phone_app','glasses','mac','call','video','ambient','journal'].includes(set.channel)&&Array.isArray(set.samples)&&set.model&&Number.isSafeInteger(set.model.dim)&&
      set.model.dim>0&&set.model.dim<=16384,'VOICEPRINT_REGISTRY_CORRUPT');
    check(set.verified_threshold===undefined||Number.isFinite(set.verified_threshold)&&set.verified_threshold>=.65&&set.verified_threshold<1,
      'VOICEPRINT_REGISTRY_CORRUPT');
    const row=channels[set.channel]??={confirmed_samples:0,scored_samples:0,baseline_rejected:0,candidate_rejected:0,
      added_false_rejects:0,current_line_added_false_rejects:0,projected_line_added_false_rejects:0,current_threshold:base,
      final_threshold:base,replayed_threshold:base,stored_threshold:null,
      impostor_margin:null,labelled_impostors:0,unlabelled_cluster_margin:null,trajectory:[]};
    if(set.verified_threshold!==undefined)row.stored_threshold=Math.max(row.stored_threshold??base,set.verified_threshold);
  }
  const events=sets.flatMap(state=>state.set.samples.map(sample=>({state,sample,time:Date.parse(sample.added_at)})))
    .sort((a,b)=>a.time-b.time);
  for(const sample of options.impostors??[])check(['guest','rejected','echo'].includes(sample.label)&&
    sets.some(s=>s.set.samples.length>0&&s.set.channel===sample.channel&&s.set.model.sha256===sample.model_sha256),'OFFLINE_IMPOSTOR_LABEL_INVALID');
  for(const {state,sample,time} of events){
    check(Number.isFinite(time)&&Number.isFinite(sample.speech_ms)&&sample.speech_ms>0&&
      (sample.quality===undefined||Number.isFinite(sample.quality)&&sample.quality>0&&sample.quality<=1),'VOICEPRINT_REGISTRY_CORRUPT');
    const row=channels[state.set.channel]!,vector=unit(decodeEmbedding(sample.embedding,state.set.model.dim));
    const line=Math.max(base,...sets.filter(s=>s.set.channel===state.set.channel).map(s=>s.threshold));
    const score=state.parts.length?dot(vector,mean(state.parts)):null;
    row.confirmed_samples++;
    if(score!==null){row.scored_samples++;if(score<.65)row.baseline_rejected++;
      if(score<line)row.candidate_rejected++;if(score>=.65&&score<line)row.added_false_rejects++;}
    state.parts.push({vector,weight:state.weighted?sample.speech_ms*(sample.quality??1):1});
    state.min=state.parts.length<2?1:Math.min(...state.parts.map((p,i)=>round(dot(p.vector,mean(state.parts.filter((_,j)=>i!==j))))));
    const sameChannel=sets.filter(s=>s.set.channel===state.set.channel);
    const next=advanceVerifiedThreshold(line,{samples:state.parts.length,min:Math.min(...sameChannel.map(s=>s.min))},policy);
    for(const s of sameChannel)s.threshold=next;
    row.trajectory.push({samples:row.confirmed_samples,threshold_before:round(line),
      threshold:round(Math.max(...sets.filter(s=>s.set.channel===state.set.channel).map(s=>s.threshold)))});
  }
  for(const [channel,row] of Object.entries(channels)){
    if(!row)continue;
    const current=sets.filter(s=>s.set.channel===channel);
    row.replayed_threshold=round(Math.max(base,...current.map(s=>s.threshold)));
    row.current_threshold=channelVerifiedLine(doc,channel as OwnerSetDoc['channel'],policy);
    row.final_threshold=Math.max(row.replayed_threshold,row.current_threshold);
    for(const s of current)if(s.parts.length>1)for(let i=0;i<s.parts.length;i++){
      const score=dot(s.parts[i]!.vector,mean(s.parts.filter((_,j)=>i!==j)));
      if(score>=.65&&score<row.current_threshold)row.current_line_added_false_rejects++;
      if(score>=.65&&score<row.final_threshold)row.projected_line_added_false_rejects++;
    }
    const scores=current.filter(s=>s.parts.length).flatMap(s=>doc.clusters.filter(c=>c.count>0&&c.model_sha256===s.set.model.sha256)
      .map(c=>dot(mean(s.parts),unit(decodeEmbedding(c.centroid,s.set.model.dim)))));
    row.unlabelled_cluster_margin=scores.length?round(row.final_threshold-Math.max(...scores)):null;
    const negatives=(options.impostors??[]).filter(s=>s.channel===channel).map(sample=>Math.max(...current
      .filter(s=>s.parts.length&&s.set.model.sha256===sample.model_sha256)
      .map(s=>dot(mean(s.parts),unit(decodeEmbedding(sample.embedding,s.set.model.dim))))));
    row.labelled_impostors=negatives.length;row.impostor_margin=negatives.length?round(row.final_threshold-Math.max(...negatives)):null;
  }
  const rows=Object.values(channels).filter((r):r is ChannelResult=>!!r),scored=rows.reduce((n,r)=>n+r.scored_samples,0);
  const added=rows.reduce((n,r)=>n+r.added_false_rejects,0);
  const currentAdded=rows.reduce((n,r)=>n+r.current_line_added_false_rejects,0);
  const projectedAdded=rows.reduce((n,r)=>n+r.projected_line_added_false_rejects,0);
  return {schema:'voiceprint-adaptive-replay/v1',gate:scored===0?'insufficient_data':added||projectedAdded?'fail':'pass',
    added_false_rejects:added,current_line_added_false_rejects:currentAdded,projected_line_added_false_rejects:projectedAdded,
    scored_samples:scored,performance_claim:'none_retained_confirmed_samples_only',
    cluster_margin_evidence:'unlabelled_clusters_are_not_verified_impostors',historical_state_missing:true,history_scope:'retained_samples_only_rotation_and_reenrollment_history_unavailable',channels};
}
