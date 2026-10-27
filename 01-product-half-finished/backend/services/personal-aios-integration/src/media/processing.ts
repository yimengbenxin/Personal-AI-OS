import type {SpeechPurpose} from './speech-purpose.ts';
import {publishRawRecord} from '../stream-archive.ts';
import type {VoiceprintChannel} from '../voiceprint/contracts.ts';
import {canonical, check, checkLocation, ContractError, digest, directedVoice, principalAttribution, sha256, utc, validateProcessed, voiceEvidence} from '../contracts.ts';
import type {CaptureLocation, Json, MediaSegment, ProcessedEvent, TimeRange, AudioReuseEvidence} from '../contracts.ts';
import type {MediaView} from './align.ts';
import type {StoragePort} from '../storage.ts';
import {selectPcmView, selectedAudioTimeline} from './sample-timeline.ts';
import {finalizeSampleTranscription} from './sample-results.ts';
import type {SampleAudioResult} from './sample-results.ts';

export interface Capability {
  id: string; version: string; modalities: ('audio'|'visual')[]; formats: string[];
  joint_av: boolean; healthy: boolean; permitted: boolean; max_duration_ms: number;
  execution: 'local'|'external'; evidence: 'real_verified'|'deterministic_replay'|'unverified';
  /** Set only on the local worker whose segment speakers are the voiceprint registry's labels (local-sherpa-audio). */
  speaker_identity?: 'local_voiceprint';
}
export interface PcmSelection {
  view_ref: string;
  track_id: string;
  stream_epoch: string;
  seq: number;
  source_range: TimeRange;
  mapped_range: TimeRange;
  selected_source_range: TimeRange;
  sample_rate: number;
  first_sample: number;
  end_sample_exclusive: number;
  source_samples: number;
  selected_sha256: string;
  rounding: 'sample_starts_in_half_open_window_ceil_epsilon_snap';
}
export interface WorkerRequest {
  input_contract: 'paios.media.full-chunks.v1' | 'paios.media.selected-pcm.v1';
  speech_purpose?:'meeting'|'meeting_paused';
  identity_channel?: VoiceprintChannel;
  principal_id?: string; device_id?: string; call_id?: string;
  coverage: MediaSegment['coverage'];
  event_id:string;segment_id:string;archive_revision:string;time_range:TimeRange;
  views:{modality:'audio'|'visual';format:string;ref:string;time_range:TimeRange;bytes:Uint8Array;pcm_selection?:PcmSelection}[];
  /** A follow-up turn's carrier (MediaSegment.speaker_carrier). */
  speaker_carrier?:{end_ms:number;request_start_ms:number};
  sound_only?:true;
}
export interface WorkerResult {
  event_id:string;segment_id:string;archive_revision:string;time_range:TimeRange;
  content:ProcessedEvent['content'];speakers:Json[];warnings:string[];status:'complete'|'partial';
}
/** Trusted resource declares analysis has no externally committed effects; never operation JSON. */
export class MediaCancelledWithoutEffectError extends ContractError {
  constructor(){super('MEDIA_CANCELLED_WITHOUT_EFFECT',409);}
}
export interface WorkerPort {effects?:'pure_analysis';analyze(request:WorkerRequest,signal:AbortSignal):Promise<WorkerResult | SampleAudioResult>}
type SelectedMetadata=Omit<WorkerRequest['views'][number],'bytes'>;
export interface MediaInputRecord {
  segment_sha256:string;view_sha256:string;
  policy:{version:string;allow_external:boolean;allow_replay:boolean;allow_partial:boolean};revision:number;replaces:string|null;
  input_contract?:WorkerRequest['input_contract'];selected_input_sha256?:string;selected_views?:SelectedMetadata[];
  fingerprint:string;models:{id:string;version:string;evidence:string}[];reused_audio?:AudioReuseEvidence;
}
function audioIdentity(views:SelectedMetadata[]) {
  return views.filter(view=>view.modality==='audio').map(view=>{
    const p=view.pcm_selection;check(p,'MEDIA_REUSE_SELECTED_PCM_REQUIRED',409);
    return {track_id:p.track_id,stream_epoch:p.stream_epoch,source_range:p.selected_source_range,
      sample_rate:p.sample_rate,selected_sha256:p.selected_sha256,seq:p.seq,mapped_range:p.mapped_range,
      selected_time_range:view.time_range,first_sample:p.first_sample,end_sample_exclusive:p.end_sample_exclusive,source_samples:p.source_samples};
  }).sort((a,b)=>canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0);
}
export async function verifySelectedAudio(storage:StoragePort,scope:Pick<ProcessedEvent,'time_range'>,selected:SelectedMetadata[],views:MediaView[],viewRef:string) {
  const actual=await Promise.all(views.filter(view=>view.chunk.modality==='audio').map(async view=>{
    const bytes=await storage.read('objects',view.chunk.object_hash);
    const {bytes:_,...metadata}=selectPcmView(view,bytes,scope.time_range,viewRef);return metadata;
  }));
  check(canonical(audioIdentity(actual))===canonical(audioIdentity(selected)),'MEDIA_AUDIO_REUSE_RAW_MISMATCH',409);
}
export function audioContent(d:ProcessedEvent):ProcessedEvent['content'] {
  return {...(d.content.transcript!==undefined?{transcript:d.content.transcript}:{}),
    ...(d.content.audio_observations!==undefined?{audio_observations:d.content.audio_observations}:{})};
}
/** Source evidence reader shared by the sole writer and its archive/admission consumers. */
export async function readReusedAudio(storage:StoragePort,evidence:AudioReuseEvidence,current:Pick<ProcessedEvent,'raw_ref'|'event_id'|'principal_id'|'device_id'|'segment_id'|'time_range'>,
  selected:SelectedMetadata[]):Promise<ProcessedEvent> {
  check(evidence.schema==='paios.media.audio-reuse.v1'&&Number.isSafeInteger(evidence.revision)&&evidence.revision>0,'MEDIA_AUDIO_REUSE_INVALID',409);
  const key=digest([evidence.raw_ref,evidence.segment_id,evidence.revision]);
  const d=JSON.parse(Buffer.from(await storage.read('processed-media',key)).toString()) as ProcessedEvent;
  const input=JSON.parse(Buffer.from(await storage.read('processed-media-inputs',key)).toString()) as MediaInputRecord;
  validateProcessed(d);
  const frontend=['voice_frontend','voice_frontend_local_voiceprint'].includes(d.processing.path_id)&&d.intent_class==='explicit_request';
  check(d.processed_event_id===evidence.processed_event_id&&digest(d)===evidence.processed_sha256&&digest(input)===evidence.input_sha256&&
    d.raw_ref===current.raw_ref&&d.event_id===current.event_id&&d.principal_id===current.principal_id&&d.device_id===current.device_id&&
    d.segment_id===current.segment_id&&canonical(d.time_range)===canonical(current.time_range)&&
    (d.segment_basis==='speech_candidate'||d.segment_basis==='wake_turn')&&
    (d.intent_class==='observation'||frontend)&&(d.user_identity==='unknown'||principalAttribution(d)==='owner_voice')&&!d.processing.reused_audio,'MEDIA_AUDIO_REUSE_SCOPE',409);
  // Frontend finals bind selected views directly; their legacy records have no selected_input_sha256 or model list.
  check(input.input_contract==='paios.media.selected-pcm.v1'&&input.selected_views&&
    (frontend||input.selected_input_sha256===digest({input_contract:input.input_contract,views:input.selected_views}))&&
    audioIdentity(input.selected_views).length>0&&canonical(audioIdentity(input.selected_views))===canonical(audioIdentity(selected)),
    'MEDIA_AUDIO_REUSE_INPUT_MISMATCH',409);
  check(!input.selected_views!.some(view=>view.modality==='visual')||input.models.length===1&&d.speakers.length===0,
    'MEDIA_AUDIO_REUSE_AMBIGUOUS_OUTPUT',409);
  if(!frontend)check(canonical(input.models)===canonical(d.processing.models),'MEDIA_AUDIO_REUSE_MODELS_MISMATCH',409);
  const refs=d.continuation?.basis_refs.filter(ref=>/^l5-view:[a-f0-9]{64}$/u.test(ref))??[];
  check(refs.length===1,'MEDIA_AUDIO_REUSE_VIEW_REQUIRED',409);
  const view=JSON.parse(Buffer.from(await storage.read('media-views',refs[0]!.slice(8))).toString()) as {raw_ref:string;archive_revision:string;window:TimeRange;views:MediaView[]};
  check(digest(view)===refs[0]!.slice(8)&&view.raw_ref===d.raw_ref&&view.archive_revision===d.archive_revision&&
    canonical(view.window)===canonical(d.time_range),'MEDIA_AUDIO_REUSE_VIEW_MISMATCH',409);
  await verifySelectedAudio(storage,d,input.selected_views!,view.views,refs[0]!);
  check(d.content.transcript!==undefined||d.content.audio_observations!==undefined,'MEDIA_AUDIO_REUSE_RESULT_REQUIRED',409);
  return d;
}
export type CapabilitySource = (request: WorkerRequest) => Promise<Capability[]>;
export type VoiceIdentityAnalysis=(request:WorkerRequest,signal:AbortSignal)=>Promise<{result:SampleAudioResult;capability:Capability}>;
export interface ProcessingConfig {
  policy_version:string;max_inflight:number;max_input_bytes:number;timeout_ms:number;
  allow_external:boolean;allow_replay:boolean;allow_partial:boolean;
}
export function selectCapabilities(segment:MediaSegment,views:MediaView[],capabilities:Capability[],config:ProcessingConfig):Capability[] {
  const required=[...new Set(views.map(v=>v.chunk.modality))];
  check(required.length>0,'MEDIA_INPUT_EMPTY');
  const duration=segment.time_range.kind==='interval'?segment.time_range.end_ms-segment.time_range.start_ms:0;
  const compatible=(c:Capability, modalities:('audio'|'visual')[])=>c.healthy&&c.permitted&&
    (c.execution==='local'||config.allow_external)&&
    (c.evidence==='real_verified'||(c.evidence==='deterministic_replay'&&config.allow_replay))&&
    c.max_duration_ms>=duration&&modalities.every(m=>c.modalities.includes(m))&&
    views.filter(v=>modalities.includes(v.chunk.modality)).every(v=>c.formats.includes(v.chunk.format));
  const joint=capabilities.find(c=>compatible(c,required)&&(required.length===1||c.joint_av));
  if(joint)return [joint];
  const workers=required.map(m=>capabilities.find(c=>compatible(c,[m])));
  check(config.allow_partial ? workers.some(Boolean) : workers.every(Boolean),'NO_COMPLIANT_MEDIA_CAPABILITY',503);
  return workers.filter((worker):worker is Capability=>worker!==undefined);
}

// Bounded front-processing, no Agent, scheduler, reply writer, memory writer, or acquisition loop.
export class MediaProcessor {
  private speechPurpose:SpeechPurpose|undefined;
  setSpeechPurpose(purpose:SpeechPurpose){this.speechPurpose=purpose;}
  private inflight=0;
  private closing:Promise<void>|undefined;
  private readonly processOperations=new Set<Promise<unknown>>();
  private readonly workerOperations=new Map<Promise<unknown>,AbortController>();
  private readonly executing=new Set<string>();
  private readonly now:()=>string;
  readonly storage:StoragePort;readonly workers:Map<string,WorkerPort>;readonly config:ProcessingConfig;
  constructor(storage:StoragePort,workers:Map<string,WorkerPort>,config:ProcessingConfig,now=()=>new Date().toISOString()) {
    this.storage=storage;this.workers=workers;this.config=config;this.now=now;
    check([config.max_inflight,config.max_input_bytes,config.timeout_ms].every(n=>Number.isSafeInteger(n)&&n>0)&&
      config.policy_version.length>0,'INVALID_PROCESSING_CONFIG');
  }
  close():Promise<void> {
    if(this.closing)return this.closing;
    for(const abort of this.workerOperations.values())abort.abort();
    this.closing=(async()=>{
      while(this.workerOperations.size||this.processOperations.size)
        await Promise.allSettled([...this.workerOperations.keys(),...this.processOperations]);
    })();
    return this.closing;
  }
  async prepareRequest(segment:MediaSegment,views:MediaView[]):Promise<WorkerRequest> {
    check(views.reduce((sum,v)=>sum+v.chunk.bytes,0)<=this.config.max_input_bytes,'MODEL_INPUT_BUDGET_EXCEEDED',413);
    const derived=segment.continuation.basis_refs.filter(ref=>ref.startsWith('l5-derived:'));
    check(segment.media_type==='muxed_av'||segment.media_type==='audio'&&segment.mime==='audio/mp4'?derived.length===1:derived.length===0,'MEDIA_DERIVATION_REF_INVALID');
    const viewData={raw_ref:segment.raw_ref,archive_revision:segment.archive_revision,window:segment.time_range,views,
      ...(derived.length?{derivation_ref:derived[0]}:{})};
    const viewHash=digest(viewData);
    check(segment.continuation.basis_refs.includes(`l5-view:${viewHash}`)&&
      (segment.audio_ref===null||segment.audio_ref===`l5-view:${viewHash}`)&&
      digest(segment.visual_refs)===digest(views.filter(v=>v.chunk.modality==='visual').map(v=>v.ref)), 'MEDIA_INPUT_SCOPE_MISMATCH');
    const sealed=await this.storage.read('media-views',viewHash);
    check(new TextDecoder().decode(sealed)===canonical(viewData),'MEDIA_INPUT_SCOPE_MISMATCH');
    const requestViews:WorkerRequest['views']=[];
    for (const view of views) {
      const bytes=await this.storage.read('objects',view.chunk.object_hash);
      check(bytes.length===view.chunk.bytes&&sha256(bytes)===view.chunk.object_hash,'MEDIA_OBJECT_INTEGRITY',500);
      if(view.chunk.format==='png')check(bytes.length>=24&&Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'MEDIA_PNG_FORMAT_MISMATCH');
      if(view.chunk.modality==='audio'){
        requestViews.push(selectPcmView(view, bytes, segment.time_range, `l5-view:${viewHash}`));
        continue;
      }
      requestViews.push({modality:view.chunk.modality,format:view.chunk.format,ref:view.ref,time_range:view.mapped_range,bytes});
    }
    const base={event_id:segment.event_id,segment_id:segment.segment_id,archive_revision:segment.archive_revision,time_range:segment.time_range};
    const purpose=await this.speechPurpose?.({principal_id:segment.principal_id,device_id:segment.device_id,time_range:segment.time_range});
    return {...base,...(purpose?{speech_purpose:purpose}:{}), input_contract: 'paios.media.selected-pcm.v1', principal_id:segment.principal_id,device_id:segment.device_id,
      ...(segment.device_type === 'phone' ? {identity_channel: 'phone_app' as const} :
        segment.device_type === 'glasses' || segment.device_type === 'mac' ? {identity_channel: segment.device_type} : {}),
      coverage: structuredClone(segment.coverage), ...(segment.speaker_carrier?{speaker_carrier:{...segment.speaker_carrier}}:{}),
      ...(segment.continuation.basis_refs.includes('source:ambient_non_speech')?{sound_only:true as const}:{}),views:requestViews};
  }
  process(segment:MediaSegment,views:MediaView[],capabilities:Capability[]|CapabilitySource,
    revision=1,replaces:string|null=null,externalSignal?:AbortSignal,beforeAnalyze?:()=>Promise<void>,reusedAudio?:ProcessedEvent):Promise<ProcessedEvent> {
    if(this.closing)return Promise.reject(new ContractError('MEDIA_PROCESSOR_CLOSED',503));
    const work=this.processOwned(segment,views,capabilities,revision,replaces,externalSignal,beforeAnalyze,reusedAudio);
    this.processOperations.add(work);
    void work.then(()=>this.processOperations.delete(work),()=>this.processOperations.delete(work));
    return work;
  }
  private async processOwned(segment:MediaSegment,views:MediaView[],capabilities:Capability[]|CapabilitySource,
    revision:number,replaces:string|null,externalSignal?:AbortSignal,beforeAnalyze?:()=>Promise<void>,reusedAudio?:ProcessedEvent):Promise<ProcessedEvent> {
    check(!this.closing,'MEDIA_PROCESSOR_CLOSED',503);
    check(!externalSignal?.aborted,'MEDIA_CANCELLED',409);
    check(Number.isSafeInteger(revision)&&revision>0&&(revision===1?replaces===null:typeof replaces==='string'),'MEDIA_REVISION_INVALID');
    const revisionKey=(n:number)=>digest([segment.raw_ref,segment.segment_id,n]);
    const key=revisionKey(revision);
    const prepared=await this.prepareRequest(segment,views);
    const {views:requestViews,...base}=prepared;
    const selectedViews = requestViews.map(({bytes, ...view}) => view);
    const selectedInputHash = digest({input_contract: prepared.input_contract, views: selectedViews});
    const policy={version:this.config.policy_version,allow_external:this.config.allow_external,
      allow_replay:this.config.allow_replay,allow_partial:this.config.allow_partial,...(prepared.speech_purpose?{speech_purpose:prepared.speech_purpose}:{})};
    let reuse:AudioReuseEvidence|undefined,reused:ProcessedEvent|undefined;
    if(reusedAudio){
      const oldKey=digest([reusedAudio.raw_ref,reusedAudio.segment_id,reusedAudio.revision]);
      const oldInput=JSON.parse(Buffer.from(await this.storage.read('processed-media-inputs',oldKey)).toString()) as MediaInputRecord;
      reuse={schema:'paios.media.audio-reuse.v1',raw_ref:reusedAudio.raw_ref,segment_id:reusedAudio.segment_id!,revision:reusedAudio.revision,
        processed_event_id:reusedAudio.processed_event_id,processed_sha256:digest(reusedAudio),input_sha256:digest(oldInput)};
      reused=await readReusedAudio(this.storage,reuse,segment,selectedViews);
      check(revision>1&&views.some(view=>view.chunk.modality==='visual'),'MEDIA_AV_REVISION_REQUIRED',409);
    }
    const input={...(reuse?{reused_audio:reuse}:{}),segment_sha256:digest(segment),view_sha256:digest({raw_ref:segment.raw_ref,
      archive_revision:segment.archive_revision,window:segment.time_range,views}),policy,revision,replaces};
    const fingerprint=digest(input);
    const read=async<T>(namespace:string):Promise<T|undefined>=>{
      try{return JSON.parse(new TextDecoder().decode(await this.storage.read(namespace,key))) as T;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    };
    const recorded=await read<MediaInputRecord>('processed-media-inputs');
    const cached=await read<ProcessedEvent>('processed-media');
    if(recorded)check(recorded.fingerprint===fingerprint&&digest({segment_sha256:recorded.segment_sha256,
      view_sha256:recorded.view_sha256,policy:recorded.policy,revision:recorded.revision,replaces:recorded.replaces,
      ...(recorded.reused_audio?{reused_audio:recorded.reused_audio}:{})})===fingerprint,
      'MEDIA_INPUT_REVISION_CONFLICT',409);
    const replay=(d:ProcessedEvent,record:MediaInputRecord|undefined):ProcessedEvent=>{
      check(record,'MEDIA_LEGACY_INPUT_RECORD_REQUIRED',409);
      check(record.fingerprint===fingerprint,'MEDIA_INPUT_REVISION_CONFLICT',409);validateProcessed(d);
      check(d.archive_revision===segment.archive_revision&&d.segment_id===segment.segment_id&&
        d.revision===revision&&d.replaces_processed_event_id===replaces&&
        d.processing.policy_version===this.config.policy_version,'MEDIA_D_RECORD_CONFLICT',409);
      return d;
    };
    if(cached)return replay(cached,recorded);
    if(recorded)check(recorded.input_contract === prepared.input_contract &&
      recorded.selected_input_sha256 === selectedInputHash &&
      digest({input_contract: recorded.input_contract, views: recorded.selected_views}) === selectedInputHash,
      'MEDIA_INPUT_CONTRACT_REVISION_REQUIRED',409);
    check(!this.executing.has(key)&&this.inflight<this.config.max_inflight,'MEDIA_BUSY',429);
    if(revision>1){
      const previous=JSON.parse(new TextDecoder().decode(await this.storage.read('processed-media',revisionKey(revision-1)))) as ProcessedEvent;
      validateProcessed(previous);check(previous.processed_event_id===replaces,'MEDIA_REPLACES_MISMATCH',409);
    }
    // The source-sealed request is the only input to provider availability. A callback
    // receives its own copy and cannot change selected bytes or the eventual consumer.
    const available=typeof capabilities==='function'?await capabilities(structuredClone(prepared)):capabilities;
    const meeting=prepared.speech_purpose!==undefined;
    const analyzedViews=meeting?views.filter(view=>view.chunk.modality==='audio'):reuse?views.filter(view=>view.chunk.modality==='visual'):views;
    const selected=selectCapabilities(segment,analyzedViews,meeting?available.filter(c=>c.id==='local-sherpa-audio'):available,this.config);
    check(this.inflight+selected.length<=this.config.max_inflight,'MEDIA_BUSY',429);
    check(selected.every(c=>this.workers.has(c.id)),'MEDIA_WORKER_NOT_CONNECTED',503);
    const models=selected.map(c=>({id:c.id,version:c.version,evidence:c.evidence}));
    if(recorded)check(canonical(recorded.models)===canonical(models),'MEDIA_MODEL_REVISION_REQUIRED',409);
    // Claim before awaited publication; keep the slot until both publication and real worker operations settle.
    check(!this.executing.has(key),'MEDIA_BUSY',429);this.executing.add(key);
    let live=0,finished=false;
    const release=()=>{if(finished&&live===0)this.executing.delete(key);};
    try {
      const appeared=await read<ProcessedEvent>('processed-media');
      if(appeared)return replay(appeared,await read<MediaInputRecord>('processed-media-inputs'));
      const bytes=await publishRawRecord(this.storage,segment.raw_ref,'processed-media-inputs',key,new TextEncoder().encode(canonical({...input,input_contract:prepared.input_contract,
        selected_input_sha256:selectedInputHash,selected_views:selectedViews,fingerprint,models})));
      const inputWinner=JSON.parse(new TextDecoder().decode(bytes)) as MediaInputRecord;
      check(inputWinner.input_contract===prepared.input_contract&&inputWinner.selected_input_sha256===selectedInputHash&&inputWinner.fingerprint===fingerprint&&canonical(inputWinner.models)===canonical(models),'MEDIA_INPUT_REVISION_CONFLICT',409);
      // Source admission precedes every provider and its timeout. A denied claim is not a model failure.
      await beforeAnalyze?.();
      check(!this.closing,'MEDIA_PROCESSOR_CLOSED',503);
      check(!externalSignal?.aborted,'MEDIA_CANCELLED',409);
      check(this.inflight+selected.length<=this.config.max_inflight,'MEDIA_BUSY',429);this.inflight+=selected.length;
    const results=await Promise.all(selected.map(async capability=>{
      const abort=new AbortController();
      const cancel=()=>abort.abort();externalSignal?.addEventListener('abort',cancel,{once:true});
      if(externalSignal?.aborted)abort.abort();
      let timer:ReturnType<typeof setTimeout>|undefined;let joined=false;
      live++;
      const workerRequest: WorkerRequest = structuredClone({...base,
        views: requestViews.filter(view => (!reuse||view.modality==='visual')&&capability.modalities.includes(view.modality))});
      const operation=Promise.resolve().then(async()=>{check(!abort.signal.aborted,'MEDIA_CANCELLED',409);return this.workers.get(capability.id)!.analyze(structuredClone(workerRequest),abort.signal);})
        .finally(()=>{joined=true;this.workerOperations.delete(operation);this.inflight--;live--;release();});
      this.workerOperations.set(operation,abort);
      try {
        const returned=await Promise.race([operation,new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>{abort.abort();reject(new Error('MEDIA_WORKER_TIMEOUT'));},this.config.timeout_ms);
        })]);
        const result = 'schema' in returned ?
          finalizeSampleTranscription(returned, workerRequest, capability) : returned;
        // Voiceprint identities come only through the capability-gated sample result, never a worker's own speakers.
        if(!('schema' in returned))check(!returned.speakers.some(speaker=>speaker!==null&&typeof speaker==='object'&&!Array.isArray(speaker)&&
          speaker.identity_scope==='local_voiceprint'),'MEDIA_WORKER_SPEAKER_IDENTITY_FORBIDDEN',502);
        check(digest([result.event_id,result.segment_id,result.archive_revision,result.time_range])===
          digest([base.event_id,base.segment_id,base.archive_revision,base.time_range]),'MEDIA_WORKER_SCOPE_MISMATCH',502);
        if(reuse)check(result.content.transcript===undefined&&result.content.audio_observations===undefined&&result.speakers.length===0,'MEDIA_REUSE_FRESH_AUDIO_FORBIDDEN',502);
        check(Object.keys(result.content).every(k=>k==='transcript'||k==='audio_observations'||k==='visual_observations'),'MEDIA_WORKER_CONTENT_INVALID',502);
        check(capability.modalities.includes('audio')||(result.content.transcript===undefined&&result.content.audio_observations===undefined&&result.speakers.length===0),'MEDIA_WORKER_MODALITY_MISMATCH',502);
        check(capability.modalities.includes('visual')||result.content.visual_observations===undefined,'MEDIA_WORKER_MODALITY_MISMATCH',502);
        return {capability,result,error:null,joined};
      } catch(e){return {capability,result:null,error:e instanceof Error?e.message:'MEDIA_WORKER_FAILED',joined};}
      finally{if(timer)clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);}
    }));
    if(externalSignal?.aborted&&results.every(r=>r.joined&&r.capability.execution==='local'&&
      this.workers.get(r.capability.id)!.effects==='pure_analysis'))throw new MediaCancelledWithoutEffectError();
    check(!externalSignal?.aborted,'MEDIA_CANCELLED',409);
    if(!results.some(r=>r.result!==null))throw Object.assign(new ContractError('ALL_MEDIA_WORKERS_FAILED',503),
      {failures:results.map(r=>({worker_id:r.capability.id,reason:r.error}))});
    const uncovered=[...new Set(views.map(view=>view.chunk.modality))].filter(modality=>!(reuse&&modality==='audio')&&!selected.some(c=>c.modalities.includes(modality)));
    const warnings=[...(reused?.quality.warnings.map(warning=>`REUSED_AUDIO_PRIOR:${warning}`)??[]),...(reuse?['CACHED_AUDIO_RESULT_REUSED']:[]),...results.flatMap(r=>r.result?r.result.warnings:[`${r.capability.id}:${r.error!}`]),
      ...uncovered.map(modality=>`MEDIA_MODALITY_UNAVAILABLE:${modality}`)];
    for (const view of requestViews) {
      const original = view.pcm_selection?.mapped_range, actual = view.time_range, scope = segment.time_range;
      if (original?.kind === 'interval' && actual.kind === 'interval' && scope.kind === 'interval' &&
        (actual.start_ms !== Math.max(original.start_ms, scope.start_ms) ||
          actual.end_ms !== Math.min(original.end_ms, scope.end_ms)))
        warnings.push(`PCM_SAMPLE_BOUNDARY_QUANTIZED:${view.ref}`);
    }
    if(segment.continuation.basis_refs.includes('clock:synthetic_fixture_unverified'))
      warnings.push('SYNTHETIC_FIXTURE_CLOCK_MAPS_NOT_HARDWARE_CALIBRATION');
    warnings.push(...segment.continuation.basis_refs.filter(ref=>ref.startsWith('source:')).map(ref=>ref.slice(7)));
    const complete=(!reused||reused.quality.status==='complete')&&uncovered.length===0&&segment.coverage.status==='complete'&&results.every(r=>r.result?.status==='complete'&&r.capability.evidence==='real_verified');
    if(results.some(r=>r.capability.evidence==='deterministic_replay'))warnings.push('DETERMINISTIC_FEATURE_REPLAY_NOT_REAL_MODEL_ACCEPTANCE');
    check(complete||this.config.allow_partial,'MEDIA_PARTIAL_NOT_ACCEPTED',503);
    const content:ProcessedEvent['content']=reused?structuredClone(audioContent(reused)):{},speakers:Json[]=reused?structuredClone(reused.speakers):[];
    for(const {result} of results)if(result){
      for(const field of ['transcript','audio_observations','visual_observations'] as const)if(result.content[field]!==undefined){
        check(content[field]===undefined,'MEDIA_WORKER_OUTPUT_CONFLICT',502);content[field]=result.content[field];}
      speakers.push(...result.speakers);
    }
    const {audio_ref:_audio,visual_refs:_visual,speaker_carrier:_carrier,...common}=segment;
    const completedAt=this.now();utc(completedAt);
    const output:ProcessedEvent={...common,processed_event_id:`processed:${digest([base,revision,replaces,content,selected,...(reuse?[reuse]:[])])}`,
      revision,replaces_processed_event_id:replaces,content,speakers,intent_class:'observation',reply_hint:'policy',
      processing:{...(reuse?{reused_audio:reuse}:{}),path_id:reuse?'cached_audio_visual_revision':selected.length===1?'joint_or_single_media':'local_split_media',
        models:[...(reused?.processing.models??[]),...selected.map(c=>({id:c.id,version:c.version,evidence:c.evidence}))],policy_version:this.config.policy_version,
        archive_revision:segment.archive_revision,completed_at:completedAt},quality:{status:complete?'complete':'partial',warnings}};
    if(replaces&&output.continuation){output.continuation={...output.continuation,relation:'revises',previous_processed_event_ids:[replaces]};}
    // Owner-verified speech is attributed here, where the D is built; contracts own the rule.
    if(voiceEvidence(output)==='owner')output.user_identity=output.principal_id;
    return this.publishFinalized(output,externalSignal);
    } finally {finished=true;release();}
  }
  async finalizeVoice(segment:MediaSegment, request:WorkerRequest, text:string, candidateRef:string, requestRef:string, model:string,signal:AbortSignal,identity?:VoiceIdentityAnalysis):Promise<ProcessedEvent> {
    check(!this.closing,'MEDIA_PROCESSOR_CLOSED',503);
    check(!signal.aborted,'MEDIA_CANCELLED',409);
    const {audio_ref:_audio,visual_refs:_visual,...common}=segment;
    const completedAt=this.now();utc(completedAt);
    const output:ProcessedEvent={...common,
      processed_event_id:`processed:${digest([segment.raw_ref,segment.segment_id,'voice.final.v1'])}`,
      revision:1,replaces_processed_event_id:null,
      continuation_hint:'explicit_end',continuation:{...segment.continuation,semantic_status:'explicit_end',
        basis_refs:[...segment.continuation.basis_refs,candidateRef,requestRef]},
      content:{transcript:{text,candidate_ref:candidateRef,request_evidence_ref:requestRef}},speakers:[],
      intent_class:'explicit_request',reply_hint:'respond',
      processing:{path_id:'voice_frontend',models:[{id:model,evidence:'unverified'}],
        policy_version:'voice.final.v1',archive_revision:segment.archive_revision,completed_at:completedAt},
      quality:{status:'partial',warnings:['PROVIDER_AND_SPEAKER_NOT_REAL_VERIFIED']}};
    const key=digest([segment.raw_ref,segment.segment_id,1]);
    const {views,...metadata}=request;
    const input={...metadata,selected_views:views.map(({bytes,...view})=>view),candidate_ref:candidateRef,request_evidence_ref:requestRef};
    const saved=await publishRawRecord(this.storage,segment.raw_ref,'processed-media-inputs',key,Buffer.from(canonical(input)));
    check(Buffer.from(saved).toString()===canonical(input),'VOICE_FINAL_INPUT_CONFLICT',409);
    check(!signal.aborted,'MEDIA_CANCELLED',409);
    // Immutable v1 finals, including legacy unscored finals, replay unchanged after an upgrade/restart.
    let cached:ProcessedEvent|undefined;
    try {cached=JSON.parse(Buffer.from(await this.storage.read('processed-media',key)).toString()) as ProcessedEvent;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(cached){
      validateProcessed(cached);
      check(cached.processed_event_id===output.processed_event_id&&cached.principal_id===segment.principal_id&&cached.raw_ref===segment.raw_ref&&
        cached.segment_id===segment.segment_id&&cached.archive_revision===segment.archive_revision&&
        cached.revision===1&&canonical(cached.content.transcript)===canonical(output.content.transcript),'VOICE_FINAL_INPUT_CONFLICT',409);
      check(!signal.aborted,'MEDIA_CANCELLED',409);return cached;
    }
    if(identity){
      const {result,capability}=await identity(request,signal);
      check(capability.execution==='local'&&capability.speaker_identity==='local_voiceprint','VOICE_IDENTITY_CAPABILITY_REQUIRED',502);
      const evidence=finalizeSampleTranscription(result,request,capability);
      output.speakers=evidence.speakers;
      output.content.audio_observations=(evidence.content.audio_observations as Json[]).map(observation=>
        ({...(observation as Record<string,Json>),observation_kind:'sample_voice_identity'}));
      output.processing.path_id='voice_frontend_local_voiceprint';
      output.processing.models.push({id:capability.id,version:capability.version,evidence:capability.evidence});
      output.quality.warnings=['VOICE_PROVIDER_UNVERIFIED','SAMPLE_ANNOTATION_COVERAGE_UNVERIFIED'];
      if(voiceEvidence(output)==='owner')output.user_identity=output.principal_id;
    }
    return this.publishFinalized(output,signal);
  }
  /** A wake turn D (segment basis `wake_turn`) as its request revision: the cached audio analysis is reused unchanged
   *  (transcript, observations and speakers, so attribution and run scope stay the original's) and the turn's framing is
   *  added as `content.wake_request`; `location`, the device's fresh fix when the host locates the turn, as `source.location`
   *  (a captured stream carries none). The first framing published for a segment is the request; repeats replay it. */
  async request(original:ProcessedEvent,framing:Json,signal?:AbortSignal,location?:CaptureLocation):Promise<ProcessedEvent> {
    check(!this.closing,'MEDIA_PROCESSOR_CLOSED',503);check(!signal?.aborted,'MEDIA_CANCELLED',409);
    validateProcessed(original);
    check(original.revision===1&&original.segment_basis==='wake_turn'&&original.intent_class==='observation'&&
      !original.processing.reused_audio&&voiceEvidence(original)!==null,'MEDIA_REQUEST_SOURCE_INVALID',409);
    const read=async<T>(namespace:string,key:string):Promise<T|undefined>=>{
      try{return JSON.parse(Buffer.from(await this.storage.read(namespace,key)).toString()) as T;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    };
    const sourceKey=digest([original.raw_ref,original.segment_id,1]),key=digest([original.raw_ref,original.segment_id,2]);
    const stored=await read<ProcessedEvent>('processed-media',sourceKey),input=await read<MediaInputRecord>('processed-media-inputs',sourceKey);
    check(stored&&digest(stored)===digest(original)&&input?.selected_views&&input.input_contract==='paios.media.selected-pcm.v1','MEDIA_REQUEST_SOURCE_INVALID',409);
    const reuse:AudioReuseEvidence={schema:'paios.media.audio-reuse.v1',raw_ref:original.raw_ref,segment_id:original.segment_id!,revision:1,
      processed_event_id:original.processed_event_id,processed_sha256:digest(original),input_sha256:digest(input)};
    const replay=(d:ProcessedEvent)=>{validateProcessed(d);check(canonical(d.processing.reused_audio)===canonical(reuse)&&
      d.processing.path_id==='ambient_wake_request'&&d.replaces_processed_event_id===original.processed_event_id,'MEDIA_REQUEST_REVISION_CONFLICT',409);return d;};
    const cached=await read<ProcessedEvent>('processed-media',key);
    if(cached)return replay(cached);
    const base={reused_audio:reuse,segment_sha256:input.segment_sha256,view_sha256:input.view_sha256,policy:input.policy,revision:2,replaces:original.processed_event_id};
    const record={...base,input_contract:input.input_contract,selected_input_sha256:input.selected_input_sha256,selected_views:input.selected_views,
      fingerprint:digest(base),models:input.models};
    const saved=await publishRawRecord(this.storage,original.raw_ref,'processed-media-inputs',key,Buffer.from(canonical(record)));
    check(Buffer.from(saved).toString()===canonical(record),'MEDIA_REQUEST_REVISION_CONFLICT',409);
    const completedAt=this.now();utc(completedAt);
    if(location)checkLocation(location);
    const output:ProcessedEvent={...structuredClone(original),...(location?{source:{...structuredClone(original.source),location:structuredClone(location)}}:{}),
      processed_event_id:`processed:${digest([original.processed_event_id,'ambient_wake_request.v1',framing,...(location?[location]:[])])}`,
      revision:2,replaces_processed_event_id:original.processed_event_id,content:{...structuredClone(original.content),wake_request:framing},
      continuation:{...original.continuation!,relation:'revises',previous_processed_event_ids:[original.processed_event_id]},
      intent_class:'explicit_request',reply_hint:'respond',
      processing:{...structuredClone(original.processing),reused_audio:reuse,path_id:'ambient_wake_request',completed_at:completedAt}};
    return replay(await this.publishFinalized(output,signal));
  }
  /** A server owner setting changes request authority, while its captured audio and speaker evidence stay intact. */
  async overrideRequest(original:ProcessedEvent):Promise<ProcessedEvent> {
    validateProcessed(original);
    check(directedVoice(original)&&original.content.owner_override===undefined,'MEDIA_REQUEST_SOURCE_INVALID',409);
    const sourceKey=digest([original.raw_ref,original.segment_id,original.revision]);
    const stored=JSON.parse(Buffer.from(await this.storage.read('processed-media',sourceKey)).toString()) as ProcessedEvent;
    check(digest(stored)===digest(original),'MEDIA_REQUEST_SOURCE_INVALID',409);
    const input=JSON.parse(Buffer.from(await this.storage.read('processed-media-inputs',sourceKey)).toString()) as MediaInputRecord;
    const reused_audio=original.processing.reused_audio??{schema:'paios.media.audio-reuse.v1' as const,raw_ref:original.raw_ref,
      segment_id:original.segment_id!,revision:original.revision,processed_event_id:original.processed_event_id,
      processed_sha256:digest(original),input_sha256:digest(input)};
    check(input.selected_views,'MEDIA_AUDIO_REUSE_INPUT_MISMATCH',409);
    await readReusedAudio(this.storage,reused_audio,original,input.selected_views);
    const revision=original.revision+1,key=digest([original.raw_ref,original.segment_id,revision]);
    const record={...input,reused_audio,revision,replaces:original.processed_event_id,
      selected_input_sha256:digest({input_contract:input.input_contract,views:input.selected_views})};
    const saved=await publishRawRecord(this.storage,original.raw_ref,'processed-media-inputs',key,Buffer.from(canonical(record)));
    check(Buffer.from(saved).toString()===canonical(record),'MEDIA_REQUEST_REVISION_CONFLICT',409);
    return this.publishFinalized({...structuredClone(original),revision,replaces_processed_event_id:original.processed_event_id,
      processed_event_id:`processed:${digest([original.processed_event_id,'owner_override'])}`,
      content:{...original.content,owner_override:{authority:'owner_override',source_processed_event_id:original.processed_event_id}},
      continuation:{...original.continuation!,relation:'revises',previous_processed_event_ids:[original.processed_event_id]},
      processing:{...original.processing,reused_audio}});
  }
  private async publishFinalized(output:ProcessedEvent,signal?:AbortSignal):Promise<ProcessedEvent> {
    check(!signal?.aborted,'MEDIA_CANCELLED',409);
    validateProcessed(output);
    const stored=await publishRawRecord(this.storage,output.raw_ref,'processed-media',digest([output.raw_ref,output.segment_id,output.revision]),new TextEncoder().encode(canonical(output)));
    check(!signal?.aborted,'MEDIA_CANCELLED',409);
    const winner=JSON.parse(new TextDecoder().decode(stored)) as ProcessedEvent;validateProcessed(winner);
    const fixed=(e:ProcessedEvent)=>({...e,processing:{...e.processing,completed_at:''}});
    check(digest(fixed(winner))===digest(fixed(output)),'MEDIA_D_REVISION_CONFLICT',409);return winner;
  }

}

// Real byte analysis for deterministic local replay. Produces signal/frame metadata,
// explicitly no invented transcript, visual semantics, identity, or model capability.
export class FeatureReplayWorker implements WorkerPort {
  async analyze(request:WorkerRequest,signal:AbortSignal):Promise<WorkerResult> {
    check(!signal.aborted,'MEDIA_CANCELLED');
    const audio=request.views.filter(v=>v.modality==='audio'),visual=request.views.filter(v=>v.modality==='visual');
    const observations=visual.map(v=>({ref:v.ref,sha256:sha256(v.bytes),time_range:v.time_range,
      observation_kind:'encoded_frame_metadata_only',bytes:v.bytes.length}));
    let samples=0,energy=0;
    const timeline = selectedAudioTimeline(request);
    for (const v of timeline.flatMap(group => group.views)) {
      const data=new DataView(v.bytes.buffer,v.bytes.byteOffset,v.bytes.length);
      for(let n=0;n<v.bytes.length/2;n++){const value=data.getInt16(n*2,true)/32768;energy+=value*value;samples++;}
    }
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,
      time_range:request.time_range,content:visual.length?{visual_observations:observations as unknown as Json}:{},speakers:[],
      warnings:[...(audio.length?[`PCM_FEATURES:samples=${samples}:rms=${samples?Math.sqrt(energy/samples):0}`,'TRANSCRIPT_UNAVAILABLE']:[]),
        ...(visual.length?['VISUAL_SEMANTIC_ANALYSIS_UNAVAILABLE']:[])],status:'partial'};
  }
}
