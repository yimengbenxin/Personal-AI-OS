import type {RegisteredDevice} from '../source-authority.ts';
import {readFileSync} from 'node:fs';
import type {VoiceResources,VoiceRecord,VoiceFrontend,VoiceGrant,VoiceCandidate} from '../voice/contracts.ts';
import type {AudioConsumptionOwner} from './audio-consumption.ts';
import {ContinuousMediaSource,type ContinuousCandidate,type ContinuousBudget} from './continuous-source.ts';
import type {VadStreamFactory} from './silero-stream.ts';
import {TURN_WINDOW_MAX_MS} from '../voiceprint/contracts.ts';
import { canonical,digest,sha256,check,ContractError, id, validateRange,validateProcessed, type ArchivedEvent, type ProcessedEvent, type RawEvent,
  type MediaSegment, type TimeRange, type TrustedContext, type AudioCapture } from '../contracts.ts';
import { RawArchive } from '../archive.ts';
import { publishRawRecord, requireRawAvailable, StreamArchive, type TrackChunk, type StreamManifest } from '../stream-archive.ts';
import type { StoragePort } from '../storage.ts';
import { alignSegment, type AlignConfig, type ClockMap } from './align.ts';
import type {DemuxPort} from './tracks.ts';
import { MediaProcessor, type CapabilitySource, type WorkerRequest } from './processing.ts';
import {selectedAudioTimeline} from './sample-timeline.ts';
import {finalizeSampleSignals} from './sample-results.ts';
import type {SampleAudioResult, SampleVadCandidate} from './sample-results.ts';
import {legacyVadCandidate, publishVadEvidence, vadRefsForCandidate} from './vad-evidence.ts';

const watchDurationToleranceMs=JSON.parse(readFileSync(new URL('../../../../../../integrations/contracts/watch-http.v1.json',import.meta.url),'utf8'))
  .transport.utterance.max_duration_difference_ms as number;

export interface MediaVadPort {
  candidates(request: WorkerRequest, signal: AbortSignal): Promise<SampleVadCandidate[] | SampleAudioResult[]>;
}
export interface MediaProcessRequest {
  raw_ref: string; archive_revision: string; time_range: TimeRange; clock_maps: ClockMap[];
  revision?: number; replaces?: string | null; previous_processed_event_ids?: string[];
}
export interface MediaServiceConfig {
  storage: StoragePort; archive: RawArchive; streamArchive: StreamArchive; processor: MediaProcessor;
  capabilities: CapabilitySource;
  /** Identity-only local analysis of the exact PTT window; provider text stays authoritative. */
  voiceIdentity?: import('./processing.ts').VoiceIdentityAnalysis;
  demux?:DemuxPort|(()=>Promise<DemuxPort>);
  /** One local process authority shared by demux, VAD and audio consumers. */
  localExecution?: {close(): Promise<void>};
  vad?: MediaVadPort; align: AlignConfig; max_segments: number; max_window_ms: number;
  /** VAD's own protocol/deployment admission, independent of final model selection. */
  authorizeVad?(request: WorkerRequest): Promise<void>;
  fixtureOnly?: boolean;
  /** Host source evidence class, independent of whether a map has been authorized. */
  clockEvidence?: 'calibrated' | 'receipt_estimated' | 'synthetic';
  sourceWarnings?: string[];
  continuous?:{detector:VadStreamFactory;budget:ContinuousBudget;onError:(error:unknown,ref?:string)=>void};
  /** The wake-turn consumer: its capability analyses a request as one speaker turn (local-sherpa-turn). */
  turn?:{capabilities:CapabilitySource};
  /** Hold the source's existing admission fence through bounded local archive publication only. */
  withAppendAdmission?<T>(raw: RawEvent, trusted: TrustedContext, chunk: TrackChunk,
    append: () => Promise<T>): Promise<T>;
  withAppendBatchAdmission?<T>(inputs:{raw:RawEvent;chunk:TrackChunk}[],trusted:TrustedContext,append:()=>Promise<T>):Promise<T>;
  authorizeClockMaps?(principal: string, maps: ClockMap[], event: ArchivedEvent, manifest?: StreamManifest): Promise<void>;
}
export interface MediaProcessResult {
  status: 'processed' | 'no_segments'; processed_events: ProcessedEvent[]; warnings: string[]; archive_revision: string;
}

// Central B→C→D business owner. Archives continue independently of pending analysis; no Agent executor or history.
export class MediaService {
  attachSpeechPurpose(purpose:import('./speech-purpose.ts').SpeechPurpose){this.config.processor.setSpeechPurpose(purpose);}
  private readonly config: MediaServiceConfig;
  private closed = false;
  private continuous:ContinuousMediaSource|undefined;
  private audioOwner:AudioConsumptionOwner|undefined;
  attachAudioOwner(owner:AudioConsumptionOwner){check(!this.audioOwner,'AUDIO_OWNER_ALREADY_ATTACHED',409);this.audioOwner=owner;}
  private voice:VoiceResources|undefined;
  private readonly voiceWindows=new Map<string,{source:RegisteredDevice;raw_ref:string;grant:VoiceGrant;request:WorkerRequest;
    records:Map<string,VoiceRecord>;pending:Set<Promise<void>>;observedRevision:number;
    frontend:VoiceFrontend;active:boolean;inputComplete:boolean;
    finish:(value:{record:VoiceRecord;text:string;requestRef:string})=>void}>();
  attachVoice(resources:VoiceResources){check(!this.voice,'VOICE_OWNER_ALREADY_ATTACHED',409);this.voice=resources;}
  get voiceConfigured(){return this.voice?.configured===true;}
  private closing: Promise<void> | undefined;
  private readonly operations = new Map<Promise<unknown>, AbortController>();
  // Reporting only. Durable frame receipts remain the admission authority.
  private readonly continuousAdmissionReports=new Map<string,{seq:number;failure:string|undefined}>();
  constructor(config: MediaServiceConfig) {
    check([config.max_segments, config.max_window_ms].every(n => Number.isSafeInteger(n) && n > 0), 'INVALID_MEDIA_SERVICE_BUDGET');
    this.config = config;
  }
  reportContinuousError(error:unknown,ref:string){
    try {this.config.continuous?.onError(error,ref);}catch(reportingError){console.error('CONTINUOUS_ERROR_REPORT_FAILED',String(reportingError));}
  }
  private admissionReportKey(event:ArchivedEvent,chunk:TrackChunk){return digest([event.raw_ref,chunk.track_id,chunk.stream_epoch]);}
  clearContinuousAdmissionReport(event:ArchivedEvent,chunk:TrackChunk){this.continuousAdmissionReports.delete(this.admissionReportKey(event,chunk));}
  reportContinuousAdmission(event:ArchivedEvent,chunk:TrackChunk,error?:unknown){
    const key=this.admissionReportKey(event,chunk),prior=this.continuousAdmissionReports.get(key);
    if(prior&&chunk.seq<prior.seq)return;
    const code=error===undefined?undefined:(error as {code?:unknown})?.code;
    const failure=error===undefined?undefined:typeof code==='string'?code:'CONTINUOUS_ADMISSION_FAILED';
    // Retain the healthy watermark too: a late older failure cannot regress a recovered lane.
    if(!prior&&this.continuousAdmissionReports.size>=64)
      this.continuousAdmissionReports.delete(this.continuousAdmissionReports.keys().next().value!);
    this.continuousAdmissionReports.set(key,{seq:chunk.seq,failure});
    if(failure===prior?.failure)return;
    this.reportContinuousError(Object.assign(new Error(error instanceof Error?error.message:failure??'CONTINUOUS_ADMISSION_RECOVERED',{cause:error}),{
      code:failure??'CONTINUOUS_ADMISSION_RECOVERED',continuous_pcm_admission:failure?'rejected':'recovered',stream_key:key}),`continuous-admission:${key}`);
  }
  get continuousConfigured(){return this.config.continuous!==undefined;}
  /** Largest chunk an archived audio source may hand to this MEDIA: the stream budget and, when continuous, its exact-chunk read budget. */
  get archiveChunkBytes(){return Math.min(this.config.streamArchive.budget.max_chunk_bytes,this.config.continuous?.budget.max_chunk_bytes??Infinity);}
  /** The request revision of a captured-speech D carrying a wake turn (see MediaProcessor.request). */
  request(original:ProcessedEvent,framing:import('../contracts.ts').Json,signal?:AbortSignal,location?:import('../contracts.ts').CaptureLocation){
    return this.config.processor.request(original,framing,signal,location);}
  overrideRequest(original:ProcessedEvent){return this.config.processor.overrideRequest(original);}
  attachContinuous(admit:import('./continuous-source.ts').ContinuousSourceOptions['admit'],release?:(raw_ref:string)=>void,
    idle?:import('./continuous-source.ts').ContinuousSourceOptions['idle'],
    disposition?:import('./continuous-source.ts').ContinuousSourceOptions['disposition']) {
    check(this.config.continuous&&!this.continuous,'CONTINUOUS_ASSEMBLY_REQUIRED',503);
    this.continuous=new ContinuousMediaSource({...this.config.continuous,storage:this.config.storage,archive:this.config.archive,
      process:(candidate,ref,signal)=>this.admitted(operation=>this.processContinuousCandidate(candidate,ref,operation),signal),admit,
      ...(release?{release}:{}),...(idle?{idle}:{}),...(disposition?{disposition}:{})});
    return this.continuous;
  }
  /** A wake turn's audio — from its wake word (or where the request starts) through the turn's last utterance (UTC
   *  window) — cut from the ambient lane and analysed afresh by the turn consumer: text without the wake word and one
   *  speaker identity over the turn (see SherpaAudioWorker). Consumed on the continuous lane like the candidates it spans;
   *  `last` is the D of the turn's last utterance, whose pinned candidate supplies the archive revision and clock. */
  processTurn(last:ProcessedEvent,window:{start_ms:number;end_ms:number},signal:AbortSignal,carrier?:MediaSegment['speaker_carrier']):Promise<ProcessedEvent> {
    return this.admitted(operation=>this.processTurnOwned(last,window,operation,carrier),signal);
  }
  private async processTurnOwned(last:ProcessedEvent,window:{start_ms:number;end_ms:number},signal:AbortSignal,
    carrier?:MediaSegment['speaker_carrier']):Promise<ProcessedEvent> {
    check(this.config.turn&&this.config.continuous,'MEDIA_TURN_NOT_CONFIGURED',503);
    const ref=last.continuation?.basis_refs.find(r=>/^l5-continuous:[a-f0-9]{64}$/u.test(r));check(ref,'MEDIA_TURN_SOURCE_REQUIRED',409);
    const candidate=JSON.parse(Buffer.from(await this.config.storage.read('media-continuous-candidates',ref.slice(14))).toString()) as ContinuousCandidate;
    check(digest(candidate)===ref.slice(14)&&candidate.authority==='central_media_c_owner'&&candidate.event.raw_ref===last.raw_ref&&
      candidate.event.archive_revision===last.archive_revision&&candidate.time_range.kind==='interval','MEDIA_TURN_SOURCE_REQUIRED',409);
    const map=candidate.context.clock_maps.find(m=>m.modality==='audio')!,scale=1+map.drift_ppm/1e6;
    check(map.target_timebase_id===candidate.time_range.timebase_id&&Number.isFinite(window.start_ms)&&window.end_ms>window.start_ms&&
      window.end_ms<=candidate.time_range.end_ms+1&&window.end_ms-window.start_ms<=TURN_WINDOW_MAX_MS&&(carrier===undefined||
        window.start_ms<carrier.end_ms&&carrier.end_ms<=carrier.request_start_ms&&carrier.request_start_ms<window.end_ms),'MEDIA_TURN_WINDOW_INVALID',422);
    const time_range:TimeRange={kind:'interval',timebase_id:map.target_timebase_id,start_ms:window.start_ms,end_ms:Math.min(window.end_ms,candidate.time_range.end_ms)};
    const source_range:TimeRange={kind:'interval',timebase_id:map.source_timebase_id,stream_epoch:map.stream_epoch,
      start_ms:(time_range.start_ms-map.offset_ms)/scale,end_ms:(time_range.end_ms-map.offset_ms)/scale};
    const record=await this.config.archive.readRecord(candidate.event.raw_ref,candidate.event.principal_id,candidate.event.archive_revision,
      {source_range,track_ids:[candidate.track.track_id],maxReadBytes:this.config.processor.config.max_input_bytes});
    check(record.kind==='stream','MEDIA_STREAM_RECORD_REQUIRED');
    const audioMaps=candidate.context.clock_maps.filter(m=>m.modality==='audio');
    await this.config.authorizeClockMaps?.(candidate.event.principal_id,audioMaps,candidate.event,record.manifest);
    check(this.config.authorizeClockMaps||this.config.fixtureOnly,'MEDIA_CLOCK_AUTHORITY_NOT_CONFIGURED',503);
    const aligned=await alignSegment(candidate.event,record.manifest,time_range,'wake_turn',audioMaps,this.config.storage,this.config.align,[last.processed_event_id]);
    aligned.segment.continuation.basis_refs.push(ref);
    if(carrier)aligned.segment.speaker_carrier={end_ms:carrier.end_ms,request_start_ms:carrier.request_start_ms};
    if(candidate.partial||this.config.sourceWarnings?.length||this.config.clockEvidence!=='calibrated') {
      aligned.segment.coverage.status='partial';aligned.segment.continuation.basis_refs.push('source:continuous_partial_or_unverified_clock');
    }
    const prepared=await this.config.processor.prepareRequest(aligned.segment,aligned.views);
    check(this.audioOwner||this.config.fixtureOnly,'AUDIO_CONSUMER_OWNER_REQUIRED',503);
    const consume=async(accept:()=>Promise<void>=async()=>{})=>[await this.config.processor.process(aligned.segment,aligned.views,
      this.config.turn!.capabilities,1,null,signal,accept)];
    const [d]=this.audioOwner?await this.audioOwner.consume(candidate.event,prepared,'continuous',consume,result=>result,'media','wake_turn'):await consume();
    return d!;
  }
  private async processContinuousCandidate(candidate:ContinuousCandidate,ref:string,signal:AbortSignal):Promise<ProcessedEvent[]> {
    const record=await this.config.archive.readRecord(candidate.event.raw_ref,candidate.event.principal_id,candidate.event.archive_revision,
      {source_range:candidate.source_range,track_ids:[candidate.track.track_id],maxReadBytes:this.config.processor.config.max_input_bytes});
    check(record.kind==='stream','MEDIA_STREAM_RECORD_REQUIRED');
    await this.config.authorizeClockMaps?.(candidate.event.principal_id,candidate.context.clock_maps,candidate.event,record.manifest);
    check(this.config.authorizeClockMaps||this.config.fixtureOnly,'MEDIA_CLOCK_AUTHORITY_NOT_CONFIGURED',503);
    const selectionKey=ref.slice('l5-continuous:'.length);
    let predecessors:string[];
    try {predecessors=JSON.parse(Buffer.from(await this.config.storage.read('media-continuous-selection',selectionKey)).toString()).previous_processed_event_ids;}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      predecessors=[];
      for(const predecessor of candidate.predecessor_refs){
        const key=predecessor.slice('l5-continuous:'.length);
        const prior=JSON.parse(Buffer.from(await this.config.storage.read('media-continuous-candidates',key)).toString()) as ContinuousCandidate;
        const segmentId=`segment:${digest([prior.event.event_id,prior.time_range,'speech_candidate'])}`;
        try {const d=JSON.parse(Buffer.from(await this.config.storage.read('processed-media',digest([prior.event.raw_ref,segmentId,1]))).toString());
          predecessors.push(d.processed_event_id);
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      const selected=Buffer.from(canonical({candidate_ref:ref,previous_processed_event_ids:predecessors}));
      const saved=await publishRawRecord(this.config.storage,candidate.event.raw_ref,'media-continuous-selection',selectionKey,selected);
      predecessors=JSON.parse(Buffer.from(saved).toString()).previous_processed_event_ids;
    }
    const aligned=await alignSegment(candidate.event,record.manifest,candidate.time_range,'speech_candidate',
      candidate.context.clock_maps,this.config.storage,this.config.align,predecessors);
    if(candidate.reason==='non_speech')aligned.segment.continuation.basis_refs.push('source:ambient_non_speech');
    const unmapped=new Map<string,typeof record.manifest.chunks[number]>();
    for(const chunk of record.manifest.chunks.filter(chunk=>chunk.modality==='visual')) {
      if(!candidate.context.clock_maps.some(map=>map.modality==='visual'&&map.track_id===chunk.track_id&&
        map.stream_epoch===chunk.stream_epoch&&map.target_timebase_id===candidate.time_range.timebase_id))
        unmapped.set(digest([chunk.track_id,chunk.stream_epoch]),chunk);
    }
    for(const [,chunk] of [...unmapped].sort(([a],[b])=>a.localeCompare(b))) {
      aligned.segment.coverage.status='partial';
      delete aligned.segment.coverage.alignment_uncertainty_ms;
      aligned.segment.continuation.basis_refs.push(`source:CONTINUOUS_VISUAL_ALIGNMENT_UNKNOWN:${canonical({
        reason:'clock_map_missing',track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,
        source_timebase_id:chunk.source_range.timebase_id,aligned_range:'unknown'})}`);
    }
    const prepared=await this.config.processor.prepareRequest(aligned.segment,aligned.views);
    check(this.audioOwner||this.config.fixtureOnly,'AUDIO_CONSUMER_OWNER_REQUIRED',503);
    const consume=async(accept:()=>Promise<void>=async()=>{})=>{
    check(candidate.time_range.kind==='interval','CONTINUOUS_INTERVAL_REQUIRED');
    const selected=legacyVadCandidate({start_ms:candidate.time_range.start_ms,end_ms:candidate.time_range.end_ms,
      semantic_status:'open',basis:`${candidate.reason}:${ref}`,model:candidate.detection.model},prepared);
    selected.model=candidate.detection.model;
    const evidence=await publishVadEvidence(this.config.storage,aligned.segment,prepared,'legacy_candidates',[selected],signal);
    const refs=await vadRefsForCandidate(this.config.storage,aligned.segment,1,evidence);
    aligned.segment.continuation.basis_refs.push(...refs,ref);
    if(candidate.partial||this.config.sourceWarnings?.length||candidate.reason==='input_exhausted'||this.config.clockEvidence!=='calibrated') {
      aligned.segment.coverage.status='partial';aligned.segment.continuation.basis_refs.push('source:continuous_partial_or_unverified_clock');
    }
    return [await this.config.processor.process(aligned.segment,aligned.views,this.config.capabilities,1,null,signal,async()=>{
      await this.continuous!.beforeAnalysis(candidate,signal);await accept();await this.continuous!.beforeAnalysis(candidate,signal);
    })];
    };
    return this.audioOwner?this.audioOwner.consume(candidate.event,prepared,'continuous',consume,result=>result):consume();
  }
  close(): Promise<void> {
    this.continuousAdmissionReports.clear();
    if (this.closing) return this.closing;
    this.closed = true;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    for (const abort of this.operations.values()) abort.abort();
    const continuous=this.continuous?.close();
    const processing = this.config.processor.close();
    let local: Promise<void> | undefined;
    try { local = this.config.localExecution?.close(); }
    catch (error) { local = Promise.reject(error); }
    const joined = Promise.allSettled([...this.operations.keys()]);
    Promise.allSettled([continuous, processing, local, joined]).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') completion.reject(failure.reason);
      else completion.resolve();
    });
    return this.closing;
  }
  private async admitted<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    check(!this.closed, 'MEDIA_SERVICE_CLOSED', 503);
    const abort = new AbortController();
    const signal = external ? AbortSignal.any([external, abort.signal]) : abort.signal;
    const completion = Promise.withResolvers<T>();
    // Register before calling any archive, permission or worker code, including synchronous callbacks.
    this.operations.set(completion.promise, abort);
    try { completion.resolve(run(signal)); } catch (error) { completion.reject(error); }
    try { return await completion.promise; }
    finally { this.operations.delete(completion.promise); }
  }
  append(raw: RawEvent, trusted: TrustedContext, chunk: TrackChunk,publicationWaitSignal?:AbortSignal,onDurable?:()=>void,capture?:AudioCapture) {
    capture=capture&&structuredClone(capture);
    return this.admitted(signal => this.appendAdmitted(raw, trusted, chunk, signal,false,publicationWaitSignal,onDurable,capture));
  }
  appendBatch(inputs:{raw:RawEvent;chunk:TrackChunk}[],trusted:TrustedContext,limit:{max_chunks:number;max_bytes:number},publicationWaitSignal?:AbortSignal,onDurable?:()=>void,capture?:AudioCapture){
    inputs=structuredClone(inputs);trusted=structuredClone(trusted);capture=capture&&structuredClone(capture);
    return this.admitted(async signal=>{
      check(!signal.aborted,'MEDIA_CANCELLED',409);
      check(inputs.length>0&&inputs.every(x=>x.raw.media_type!=='muxed_av'&&x.chunk.format==='pcm_s16le:16000:1'&&x.chunk.modality==='audio'),'MEDIA_FORMAT_UNSUPPORTED',422);
      check(trusted.submission==='observation','MEDIA_OBSERVATION_REQUIRED',403);
      const append=async()=>{check(!signal.aborted,'MEDIA_CANCELLED',409);
        check(inputs.length<=limit.max_chunks&&inputs.reduce((n,x)=>n+x.raw.payload.length,0)<=limit.max_bytes,'STREAM_BATCH_BUDGET',413);
        return this.config.archive.admitStreamBatch(inputs,this.captureContext(trusted,capture),limit);};
      if(this.config.withAppendBatchAdmission){const admitted=await this.config.withAppendBatchAdmission(inputs,trusted,append);
        for(const input of inputs)input.raw.payload=new Uint8Array();onDurable?.();return this.config.archive.waitPublished(admitted,publicationWaitSignal);}
      check(this.config.fixtureOnly===true&&!this.config.withAppendAdmission,'MEDIA_BATCH_AUTHORITY_NOT_CONFIGURED',503);
      const archived=await this.config.streamArchive.appendBatch(inputs.map(x=>({event:x.raw,chunk:x.chunk,trusted:this.captureContext(trusted,capture),received_at:new Date().toISOString()})),limit);
      onDurable?.();return archived;
    });
  }
  get archiveBudget(){return this.config.streamArchive.budget;}
  archive(raw:RawEvent,trusted:TrustedContext,chunk:TrackChunk,publicationWaitSignal?:AbortSignal){
    return this.admitted(signal=>this.appendAdmitted(raw,trusted,chunk,signal,true,publicationWaitSignal));
  }
  private prepareAppend(raw:RawEvent,trusted:TrustedContext,chunk:TrackChunk,archiveOnly:boolean){
    check(raw.media_type !== 'muxed_av', 'MEDIA_MUXED_CONTAINER_UNSUPPORTED', 422);
    check(trusted.submission === 'observation', 'MEDIA_OBSERVATION_REQUIRED', 403);
    if(!archiveOnly)check(chunk.format === 'png' || chunk.format === 'pcm_s16le:16000:1', 'MEDIA_FORMAT_UNSUPPORTED', 422);
    check(raw.payload.length > 0 && raw.payload.length <= this.config.streamArchive.budget.max_chunk_bytes,
      'CHUNK_BUDGET_EXCEEDED', 413);
    // Snapshot before any asynchronous source lookup; published bytes must be the admitted bytes.
    return structuredClone({raw,trusted,chunk});
  }
  private captureContext(trusted:TrustedContext,capture?:AudioCapture):TrustedContext{return capture?{...trusted,audio_capture:capture}:trusted;}
  private admitSource(raw:RawEvent,trusted:TrustedContext,chunk:TrackChunk,capture?:AudioCapture){
    check(this.config.withAppendAdmission,'MEDIA_AUTHORITY_NOT_CONFIGURED',503);
    return this.config.withAppendAdmission(raw,trusted,chunk,()=>this.config.archive.admitStream(raw,this.captureContext(trusted,capture),chunk));
  }
  /** Archive-only producers acknowledge the durable ingress without waiting for journal publication. */
  admitArchive(raw:RawEvent,trusted:TrustedContext,chunk:TrackChunk){
    return this.admitted(async signal=>{check(!signal.aborted,'MEDIA_CANCELLED',409);
      ({raw,trusted,chunk}=this.prepareAppend(raw,trusted,chunk,true));return this.admitSource(raw,trusted,chunk);});
  }
  private async appendAdmitted(raw: RawEvent, trusted: TrustedContext, chunk: TrackChunk, signal: AbortSignal, archiveOnly=false,publicationWaitSignal?:AbortSignal,onDurable?:()=>void,capture?:AudioCapture) {
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    ({raw,trusted,chunk}=this.prepareAppend(raw,trusted,chunk,archiveOnly));
    // The archive authority owns publication, immutable sequence races and raw metadata binding.
    if (this.config.withAppendAdmission){const admitted=await this.admitSource(raw,trusted,chunk,capture);raw.payload=new Uint8Array();onDurable?.();return this.config.archive.waitPublished(admitted,publicationWaitSignal);}
    check(this.config.fixtureOnly === true, 'MEDIA_AUTHORITY_NOT_CONFIGURED', 503);
    const archived=await this.config.streamArchive.append(raw,this.captureContext(trusted,capture),new Date().toISOString(),chunk);
    onDurable?.();return archived;
  }
  processVoice(source:RegisteredDevice,operation:string,request:MediaProcessRequest,signal:AbortSignal,firstTranscript?: (record:VoiceRecord)=>Promise<void>):Promise<MediaProcessResult> {
    return this.admitted(async owned=>{
      check(this.voiceConfigured&&this.voice&&this.audioOwner,'VOICE_CONSUMER_NOT_CONFIGURED',503);
      check(request.time_range.kind==='interval'&&request.time_range.end_ms-request.time_range.start_ms<=(source.channel==='watch_https'?30000:this.config.max_window_ms),
        'VOICE_WINDOW_BUDGET_EXCEEDED',413);
      const record=await this.config.archive.readRecord(request.raw_ref,source.principal_id,request.archive_revision,
        {maxReadBytes:this.config.processor.config.max_input_bytes});
      check(record.event.device_id===source.device_id&&(record.kind==='stream'||source.channel==='watch_https'&&record.event.media_type==='audio'&&record.event.mime==='audio/mp4'),'VOICE_STREAM_SCOPE',403);
      const event:ArchivedEvent={...record.event,raw_ref:request.raw_ref,archive_revision:request.archive_revision,
        archive_status:'durable',payload_sha256:record.payload_sha256,bytes:record.total_bytes};
      check(event.origin==='device_observation'&&event.user_identity==='unknown','VOICE_SOURCE_ORIGIN',403);
      const derived=record.kind==='original'?(check(this.config.demux,'DEMUX_SERVICE_UNAVAILABLE',503),await this.config.archive.deriveMedia(event,typeof this.config.demux==='function'?await this.config.demux():this.config.demux,owned)):undefined;
      const manifest=record.kind==='stream'?record.manifest:derived!.manifest;
      if(derived){
        check(request.clock_maps.length===0,'WATCH_INTRINSIC_CLOCK_REQUIRED',403);
        const chunks=manifest.chunks;
        check(chunks.length>0&&chunks.every(c=>c.modality==='audio'&&c.format==='pcm_s16le:16000:1'&&c.source_range.kind==='interval'),'audio_invalid',422);
        const first=chunks[0]!,last=chunks.at(-1)!;
        check(first.source_range.kind==='interval'&&last.source_range.kind==='interval'&&request.time_range.kind==='interval','audio_invalid',422);
        const actual=last.source_range.end_ms-first.source_range.start_ms,declared=request.time_range.end_ms-request.time_range.start_ms;
        check(actual<=30000,'audio_too_long',413);check(Math.abs(actual-declared)<=watchDurationToleranceMs,'audio_invalid',422);
        request={...request,time_range:{...request.time_range,end_ms:request.time_range.start_ms+actual},clock_maps:[{modality:'audio',track_id:first.track_id,stream_epoch:first.stream_epoch,
          source_timebase_id:first.source_range.timebase_id,target_timebase_id:request.time_range.timebase_id,
          offset_ms:request.time_range.start_ms-first.source_range.start_ms,drift_ppm:0,uncertainty_ms:0,basis_ref:derived.ref}]};
      }else if(this.config.authorizeClockMaps)await this.config.authorizeClockMaps(source.principal_id,request.clock_maps,event,record.kind==='stream'?record.manifest:undefined);
      else check(this.config.fixtureOnly===true,'MEDIA_CLOCK_AUTHORITY_NOT_CONFIGURED',503);
      const {segment,views}=await alignSegment(event,manifest,request.time_range,'speech_candidate',request.clock_maps,
        this.config.storage,this.config.align,[],derived?.ref);
      const prepared=await this.config.processor.prepareRequest(segment,views);
      const groups=selectedAudioTimeline(prepared);
      check(groups.length===1&&prepared.views.every(view=>view.modality==='audio')&&prepared.coverage.status==='complete',
        'VOICE_EXACT_SINGLE_AUDIO_WINDOW_REQUIRED',409);
      const grant=await this.voice.authorizeWindow(source,event,structuredClone(request));
      for(const value of [grant.window_ref,grant.turn_id,grant.purpose_evidence_ref])id(value);
      check(!owned.aborted&&!this.closed,'MEDIA_CANCELLED',409);
      const recover=firstTranscript&&this.voice.recoverConfirmation?async()=>{
        const saved=await this.voice!.recoverConfirmation!(source,operation);if(!saved)return;
        const {record,evidenceRef}=saved,text=record.candidate.event.transcript;
        const {views,...metadata}=prepared,selection=views.map(({bytes,...view})=>view);
        check(record.raw_ref===event.raw_ref&&record.archive_revision===event.archive_revision&&record.window_ref===grant.window_ref&&
          record.turn_id===grant.turn_id&&record.selected_input_sha256===digest({metadata,selection})&&
          record.candidate.kind==='transcript'&&record.candidate.event.type==='conversation.item.input_audio_transcription.completed'&&
          typeof text==='string'&&text.trim(),'VOICE_RECOVERY_EVIDENCE_MISMATCH',403);
        const decision=await this.voice!.authorizeFinal(source,record,evidenceRef);
        check(decision.state==='confirmed_request'&&decision.semantic_status==='explicit_end'&&decision.candidate_ref===record.candidate_ref&&
          decision.source_digest===record.selected_input_sha256&&decision.transcript_sha256===sha256(text)&&decision.request_evidence_ref===evidenceRef,
          'VOICE_RECOVERY_EVIDENCE_MISMATCH',403);
        const d=await this.config.processor.finalizeVoice(segment,prepared,text,record.candidate_ref,evidenceRef,record.candidate.model,owned,this.config.voiceIdentity);
        return {status:'processed' as const,processed_events:[d],warnings:['VOICE_PROVIDER_UNVERIFIED'],archive_revision:event.archive_revision};
      }:undefined;
      return this.audioOwner.consume(event,prepared,'finite',async accept=>{
        const final=await this.runVoice(source,operation,event,prepared,grant,groups[0]!.views,owned,accept,firstTranscript);
        check(!owned.aborted&&!this.closed,'MEDIA_CANCELLED',409);
        const d=await this.config.processor.finalizeVoice(segment,prepared,final.text,final.record.candidate_ref,final.requestRef,final.record.candidate.model,owned,this.config.voiceIdentity);
        check(!owned.aborted&&!this.closed,'MEDIA_CANCELLED',409);
        return {status:'processed' as const,processed_events:[d],warnings:['VOICE_PROVIDER_UNVERIFIED'],archive_revision:event.archive_revision};
      },result=>result.processed_events,'voice',undefined,recover);
    },signal);
  }
  private async runVoice(source:RegisteredDevice,operation:string,event:ArchivedEvent,request:WorkerRequest,
    grant:VoiceGrant,views:WorkerRequest['views'],signal:AbortSignal,accept:()=>Promise<void>,firstTranscript?:(record:VoiceRecord)=>Promise<void>) {
    check(this.voice&&!this.voiceWindows.has(operation)&&this.voiceWindows.size<this.config.max_segments,'VOICE_WINDOW_BUDGET',429);
    const resources=this.voice;
    const done=Promise.withResolvers<{record:VoiceRecord;text:string;requestRef:string}>();
    // Attach rejection observation before external callbacks or cancellation can run.
    void done.promise.catch(()=>{});
    const pending=new Set<Promise<void>>(),confirming=new Set<Promise<void>>();let count=0;let selected=false;let persistence=Promise.resolve();
    let window:typeof this.voiceWindows extends Map<string,infer W>?W:never;
    const persist=(candidate:VoiceCandidate)=>{
      if(!window?.active||firstTranscript&&selected)return;
      window.observedRevision++;
      const choose=!!firstTranscript&&!selected&&candidate.kind==='transcript'&&candidate.event.type==='conversation.item.input_audio_transcription.completed';
      if(choose)selected=true;
      let savedRecord:VoiceRecord|undefined;
      const work=persistence.then(async()=>{
        check(window?.active&&!signal.aborted,'VOICE_WINDOW_CLOSED',409);
        const actual=window.frontend.identity();
        check(candidate.connectionId===actual.connectionId&&candidate.connectionEpoch===actual.connectionEpoch&&
          Number.isSafeInteger(actual.connectionEpoch)&&actual.connectionEpoch>0,'VOICE_CONNECTION_EPOCH_MISMATCH',409);
        check(++count<=this.config.max_segments*8,'VOICE_CANDIDATE_BUDGET',413);
        const {views,...metadata}=request;
        const selection=views.map(({bytes,...view})=>view);
        const selectedHash=digest({metadata,selection});
        const key=digest([event.raw_ref,event.archive_revision,grant,candidate,selectedHash]);
        const proposed:VoiceRecord={schema:'paios.voice-transcript.v1',candidate_ref:`voice-candidate:${key}`,
          raw_ref:event.raw_ref,archive_revision:event.archive_revision,principal_id:source.principal_id,device_id:source.device_id,
          window_ref:grant.window_ref,turn_id:grant.turn_id,window_range:request.time_range,
          candidate_revision:digest(candidate.event),selected_input_sha256:selectedHash,selected_views:selection as unknown as import('../contracts.ts').Json,
          candidate:structuredClone(candidate),range_association:'host_window_only',authorization:'unknown'};
        const bytes=Buffer.from(canonical(proposed));check(bytes.length<=this.config.processor.config.max_input_bytes,'VOICE_CANDIDATE_BYTES',413);
        const saved=await publishRawRecord(this.config.storage,event.raw_ref,'voice-transcripts',key,bytes);
        check(Buffer.from(saved).toString()===canonical(proposed),'VOICE_CANDIDATE_CONFLICT',409);
        if(window.active&&!signal.aborted){window.records.set(proposed.candidate_ref,proposed);savedRecord=proposed;}
      });
      persistence=work;
      pending.add(work);const confirmation=work.then(async()=>{pending.delete(work);if(choose&&savedRecord){
        const text=savedRecord.candidate.event.transcript;
        check(typeof text==='string'&&text.trim(),'not_heard',422);await firstTranscript!(savedRecord);
      }},error=>{
        pending.delete(work);done.reject(error);try{resources.onError(error);}catch{/* Reporting cannot release source work. */}
      }).catch(error=>done.reject(error));
      confirming.add(confirmation);void confirmation.finally(()=>confirming.delete(confirmation));
    };
    let frontend:VoiceFrontend;
    frontend=resources.create({onCandidate:persist,onEvent:incoming=>{
      if(!window?.active)return;
      if(incoming.type==='conversation.item.input_audio_transcription.failed'){done.reject(new ContractError('VOICE_INPUT_TRANSCRIPTION_FAILED',502));return;}
    }});
    window={source,raw_ref:event.raw_ref,grant,request,records:new Map(),pending,observedRevision:0,frontend,active:true,inputComplete:false,finish:value=>done.resolve(value)};
    this.voiceWindows.set(operation,window);
    const timer=setTimeout(()=>done.reject(firstTranscript&&!selected?new ContractError('VOICE_WINDOW_NO_SPEECH',422):new ContractError('VOICE_WINDOW_TIMEOUT',502)),this.config.processor.config.timeout_ms);
    const abort=()=>done.reject(new Error('VOICE_WINDOW_CANCELLED'));signal.addEventListener('abort',abort,{once:true});
    try {
      check(!signal.aborted,'MEDIA_CANCELLED',409);await accept();await frontend.connect();
      check(!signal.aborted&&!this.closed,'MEDIA_CANCELLED',409);
      for(const view of views)frontend.appendAudio(Buffer.from(view.bytes).toString('base64'));
      frontend.commitInput();
      window.inputComplete=true;
      return await done.promise;
    } finally {
      window.active=false;clearTimeout(timer);signal.removeEventListener('abort',abort);
      const joined=await Promise.allSettled([Promise.resolve().then(()=>frontend.close()),Promise.resolve().then(()=>frontend.join()),...pending,...confirming]);
      this.voiceWindows.delete(operation);
      const errors=joined.filter(result=>result.status==='rejected').map(result=>result.reason);
      if(errors.length)throw new AggregateError(errors,'VOICE_CLOSE_FAILED');
    }
  }
  private async voiceSnapshot(source:RegisteredDevice,operation:string) {
    const window=this.voiceWindows.get(operation);
    check(this.voice&&window?.active&&!this.closed,'VOICE_WINDOW_CLOSED',409);
    check(source.principal_id===window.source.principal_id&&source.device_id===window.source.device_id,'VOICE_WINDOW_SCOPE',403);
    await Promise.all([requireRawAvailable(this.config.storage,window.raw_ref),...window.pending]);
    const observedRevision=window.observedRevision;
    await Promise.all([...window.pending]);
    check(window.active&&!this.closed&&window.pending.size===0&&window.observedRevision===observedRevision,
      'VOICE_CANDIDATE_SNAPSHOT_CHANGED',409);
    return {window,observedRevision};
  }
  async voiceCandidates(source:RegisteredDevice,operation:string):Promise<VoiceRecord[]> {
    const {window}=await this.voiceSnapshot(source,operation);
    return [...window.records.values()].map(record=>structuredClone(record));
  }
  async finalizeVoice(source:RegisteredDevice,operation:string,candidateRef:string,evidenceRef:string,revalidate:()=>Promise<void>) {
    const {window,observedRevision}=await this.voiceSnapshot(source,operation);
    check(this.voice&&window.inputComplete,'VOICE_WINDOW_CLOSED',409);
    const record=window.records.get(candidateRef);
    check(record&&record.candidate.kind==='transcript'&&record.candidate.event.type==='conversation.item.input_audio_transcription.completed',
      'VOICE_FINAL_TRANSCRIPT_REQUIRED',409);
    const decision=await this.voice.authorizeFinal(source,structuredClone(record),evidenceRef);
    if(decision.state!=='confirmed_request'||decision.semantic_status!=='explicit_end')return {status:'not_finalized' as const,reason:'request_unconfirmed'};
    await revalidate();
    const text=record.candidate.event.transcript;
    check(typeof text==='string'&&text.trim().length>0,'VOICE_FINAL_TEXT_REQUIRED',409);
    check(window.active&&!this.closed&&window.pending.size===0&&window.observedRevision===observedRevision&&decision.candidate_ref===record.candidate_ref&&decision.window_ref===record.window_ref&&
      decision.turn_id===record.turn_id&&digest(decision.identity)===digest(window.frontend.identity())&&
      decision.identity.connectionEpoch===record.candidate.connectionEpoch&&decision.source_digest===record.selected_input_sha256&&
      decision.transcript_sha256===sha256(text)&&decision.request_evidence_ref===evidenceRef,'VOICE_FINAL_EVIDENCE_MISMATCH',403);
    check([...window.records.values()].filter(value=>value.candidate.kind==='transcript').every(value=>
      value.candidate.event.item_id===record.candidate.event.item_id&&value.candidate.event.transcript===text),
      'VOICE_MULTI_ITEM_RANGE_UNKNOWN',409);
    window.active=false;window.finish({record,text,requestRef:evidenceRef});return {status:'finalized' as const};
  }
  process(principal: string, request: MediaProcessRequest, signal = new AbortController().signal): Promise<MediaProcessResult> {
    return this.admitted(operation => this.processAdmitted(principal, structuredClone(request), operation), signal);
  }
  private async processAdmitted(principal: string, request: MediaProcessRequest, signal: AbortSignal): Promise<MediaProcessResult> {
    id(principal); validateRange(request.time_range);
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    check(request.time_range.kind !== 'interval' || request.time_range.end_ms - request.time_range.start_ms <=
      this.config.max_window_ms, 'MEDIA_WINDOW_BUDGET_EXCEEDED', 413);
    check(Array.isArray(request.clock_maps) && request.clock_maps.length > 0 && request.clock_maps.length <=
      this.config.align.max_chunks, 'CLOCK_MAP_REQUIRED');
    const previous = request.previous_processed_event_ids ?? [];
    check(previous.length <= this.config.max_segments, 'MEDIA_PREDECESSOR_BUDGET_EXCEEDED', 413);
    for (const dId of previous) id(dId);
    const record = await this.config.archive.readRecord(request.raw_ref, principal, request.archive_revision);
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    check(record.kind === 'stream'||record.event.media_type==='muxed_av', 'MEDIA_STREAM_RECORD_REQUIRED', 422);
    check(record.event.origin === 'device_observation' && record.event.user_identity === 'unknown',
      'MEDIA_OBSERVATION_REQUIRED', 403);

    const archived: ArchivedEvent = {...record.event, raw_ref: request.raw_ref,
      archive_revision: request.archive_revision, archive_status: 'durable', payload_sha256: record.payload_sha256,
      bytes: record.total_bytes};
    const derived=record.kind==='original'?
      (check(this.config.demux,'DEMUX_SERVICE_UNAVAILABLE',503),
        await this.config.archive.deriveMedia(archived,typeof this.config.demux==='function'?await this.config.demux():this.config.demux,signal)):undefined;
    const manifest=record.kind==='stream'?record.manifest:derived!.manifest;
    check(manifest.chunks.every(c => c.format === 'png' || c.format === 'pcm_s16le:16000:1'),
      'MEDIA_FORMAT_UNSUPPORTED', 422);
    const warnings: string[] = [];
    if (this.config.authorizeClockMaps) await this.config.authorizeClockMaps(principal, request.clock_maps, archived, record.kind==='stream'?record.manifest:undefined);
    else {
      check(this.config.fixtureOnly === true, 'MEDIA_CLOCK_AUTHORITY_NOT_CONFIGURED', 503);
    }
    const syntheticClock = !this.config.authorizeClockMaps || this.config.clockEvidence === 'synthetic';
    if (syntheticClock) warnings.push('SYNTHETIC_FIXTURE_CLOCK_MAPS_NOT_HARDWARE_CALIBRATION');
    warnings.push(...this.config.sourceWarnings ?? []);
    const align = async (window: TimeRange) => {
      const aligned = await alignSegment(archived, manifest, window, 'source_window',
        request.clock_maps, this.config.storage, this.config.align, previous,derived?.ref);
      if (syntheticClock) {
        aligned.segment.coverage.status = 'partial';
        aligned.segment.continuation.basis_refs.push('clock:synthetic_fixture_unverified');
      }
      if (this.config.sourceWarnings?.length) {
        aligned.segment.coverage.status = 'partial';
        aligned.segment.continuation.basis_refs.push(...this.config.sourceWarnings.map(warning=>`source:${warning}`));
      }
      return aligned;
    };
    const full = await align(request.time_range);
    // Actual source-selected views decide dependencies, including mixed archives.
    const prepared = await this.config.processor.prepareRequest(full.segment, full.views);
    check(!prepared.views.some(view=>view.modality==='audio')||this.audioOwner||this.config.fixtureOnly,'AUDIO_CONSUMER_OWNER_REQUIRED',503);
    let revisionPredecessor:ProcessedEvent|undefined;
    if((request.revision??1)>1&&prepared.views.some(view=>view.modality==='audio')){
      check(Number.isSafeInteger(request.revision)&&typeof request.replaces==='string','MEDIA_AV_REVISION_EVIDENCE_REQUIRED',409);
      try {revisionPredecessor=JSON.parse(Buffer.from(await this.config.storage.read('processed-media',
        digest([archived.raw_ref,full.segment.segment_id,request.revision!-1]))).toString()) as ProcessedEvent;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')check(false,'MEDIA_REVISION_PREDECESSOR_REQUIRED',409);throw error;}
      validateProcessed(revisionPredecessor);
      check(revisionPredecessor.processed_event_id===request.replaces,'MEDIA_REPLACES_MISMATCH',409);
    }
    const consume=async(accept:()=>Promise<void>=async()=>{}):Promise<MediaProcessResult>=>{
    let windows:TimeRange[];let vadEvidenceRef:string|undefined;
    if (prepared.views.some(view => view.modality === 'audio')) {
      check(request.time_range.kind === 'interval', 'MEDIA_AUDIO_INTERVAL_REQUIRED', 422);
      check(this.config.vad, 'MEDIA_VAD_NOT_CONFIGURED', 503);
      // Verify the full sealed multimodal view first; filtering cannot bypass source integrity checks.
      const vadRequest = structuredClone({...prepared, views: prepared.views.filter(view => view.modality === 'audio')});
      await this.config.authorizeVad?.(structuredClone(vadRequest));
      check(!signal.aborted, 'MEDIA_CANCELLED', 409);
      await accept();
      const returned = await this.config.vad.candidates(structuredClone(vadRequest), signal);
      check(Array.isArray(returned) && returned.every(candidate => typeof candidate === 'object' && candidate !== null),
        'MEDIA_VAD_RESULT_INVALID', 422);
      const hasSampleResult = returned.some(candidate => 'schema' in candidate);
      check(!hasSampleResult || returned.every(candidate => 'schema' in candidate), 'MEDIA_VAD_RESULT_INVALID', 422);
      const candidates = hasSampleResult ?
        finalizeSampleSignals(returned as SampleAudioResult[], vadRequest, this.config.max_segments) :
        (returned as SampleVadCandidate[]).map(candidate => legacyVadCandidate(candidate, vadRequest));
      check(candidates.length <= this.config.max_segments, 'MEDIA_SEGMENT_BUDGET_EXCEEDED', 413);
      const scope = request.time_range;
      windows = candidates.map(candidate => {
        check(candidate.semantic_status === 'open' && Number.isFinite(candidate.start_ms) && Number.isFinite(candidate.end_ms) &&
          candidate.start_ms >= scope.start_ms && candidate.end_ms <= scope.end_ms && candidate.end_ms > candidate.start_ms,
          'MEDIA_VAD_RANGE_INVALID', 422);
        return {...scope, start_ms: candidate.start_ms, end_ms: candidate.end_ms};
      });
      vadEvidenceRef = await publishVadEvidence(this.config.storage, full.segment, vadRequest,
        hasSampleResult ? 'sample_result' : 'legacy_candidates', candidates, signal,
        hasSampleResult ? returned as SampleAudioResult[] : []);
    } else windows = [request.time_range];
    check(windows.length <= this.config.max_segments, 'MEDIA_SEGMENT_BUDGET_EXCEEDED', 413);
    check(windows.length <= 1 || (request.revision ?? 1) === 1, 'MEDIA_REVISION_REQUIRES_SINGLE_SEGMENT', 422);
    const completed: ProcessedEvent[] = [];
    for (const window of windows) {
      check(!signal.aborted, 'MEDIA_CANCELLED', 409);
      const aligned = await align(window);
      if (vadEvidenceRef) {
        const refs = await vadRefsForCandidate(this.config.storage, aligned.segment, request.revision ?? 1, vadEvidenceRef);
        aligned.segment.continuation.basis_refs.push(...refs);
        if (!refs.length) warnings.push('HISTORICAL_D_WITHOUT_VAD_SELECTION_EVIDENCE');
        else if (!refs.includes(vadEvidenceRef)) warnings.push('CACHED_D_RETAINS_PRIOR_VAD_SELECTION_EVIDENCE');
      }
      check(!signal.aborted, 'MEDIA_CANCELLED', 409);
      // Current CAP is fetched for every analysis. Selection/format/duration/consent stay in the processor authority.
      const d = await this.config.processor.process(aligned.segment, aligned.views, this.config.capabilities,
        request.revision ?? 1, request.replaces ?? null, signal,accept);
      completed.push(d);
    }
    check(!signal.aborted, 'MEDIA_CANCELLED', 409);
    return {status: completed.length ? 'processed' : 'no_segments', processed_events: completed, warnings,
      archive_revision: request.archive_revision};
    };
    const result=this.audioOwner?await this.audioOwner.consume(archived,prepared,'finite',consume,result=>result.processed_events):await consume();
    if(!this.audioOwner||(request.revision??1)===1||!prepared.views.some(view=>view.modality==='audio'))return result;
    check(Number.isSafeInteger(request.revision)&&request.revision!>1&&typeof request.replaces==='string'&&result.processed_events.length===1,
      'MEDIA_AV_REVISION_EVIDENCE_REQUIRED',409);
    const audio=result.processed_events[0]!;
    check(audio.segment_id===full.segment.segment_id,'MEDIA_AV_REVISION_SEGMENT_MISMATCH',409);
    const predecessor=revisionPredecessor!;
    const prior=await this.config.archive.readRecord(predecessor.raw_ref,principal,predecessor.archive_revision);
    check(prior.kind==='stream'&&record.kind==='stream','MEDIA_AV_REVISION_STREAM_REQUIRED',409);
    check(full.views.some(view=>view.chunk.modality==='visual'&&!prior.manifest.chunks.some(chunk=>digest(chunk)===digest(view.chunk))),
      'MEDIA_REVISION_WITHOUT_NEW_VISUAL_CONTEXT',409);
    check(await this.config.archive.validateEvidence(audio),'MEDIA_REUSED_AUDIO_SOURCE_DENIED',403);
    const d=await this.config.processor.process(full.segment,full.views,this.config.capabilities,request.revision!,request.replaces,signal,undefined,audio);
    return {status:'processed',processed_events:[d],warnings:[...warnings,'CACHED_AUDIO_RESULT_REUSED'],archive_revision:request.archive_revision};
  }
}
