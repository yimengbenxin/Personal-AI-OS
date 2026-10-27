import {publishRawRecord,withRawPublication} from '../stream-archive.ts';
import {emitRuntimeEvent} from '../self-events.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {MediaCancelledWithoutEffectError} from './processing.ts';
import {AudioConsumptionUnknownError} from './audio-consumption.ts';
import {randomUUID} from 'node:crypto';
import {canonical,ContractError,check,digest,sha256} from '../contracts.ts';
import type {ArchivedEvent,ProcessedEvent,TimeRange} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {RawArchive} from '../archive.ts';
import type {TrackChunk} from '../stream-archive.ts';
import {mappedRange,type ClockMap} from './align.ts';
import type {VadStream,VadStreamFactory,VadProgress} from './silero-stream.ts';
import {NATIVE_WINDOW_SAMPLES} from '../voiceprint/contracts.ts';
interface QueueAcceptance {status:'queued'|'duplicate';stream_key:string}
type QueueOwner=(queue:(accepted:()=>Promise<void>)=>Promise<QueueAcceptance>)=>Promise<QueueAcceptance>;
export interface ContinuousContext {session:string;clock_maps:ClockMap[]}
/** Detection identity excludes changing visual associations; queued C owns its full context. */
export function sameDetectionContext(a:ContinuousContext,b:ContinuousContext):boolean {
  const audio=(context:ContinuousContext)=>context.clock_maps.filter(map=>map.modality==='audio');
  const left=audio(a),right=audio(b);
  return a.session===b.session&&left.length===1&&right.length===1&&canonical(left[0])===canonical(right[0]);
}
export interface ContinuousBudget {
  max_streams:number; max_pending_chunks:number; max_pending_candidates:number;
  max_chunk_bytes:number; block_samples:number; overlap_samples:number;
}
export interface ContinuousCandidate {
  schema:'paios.media.continuous-candidate.v1'; authority:'central_media_c_owner';
  stream_key:string; detection_epoch:string; detection_origin_sample:number; partial:boolean;
  event:ArchivedEvent; track:Pick<TrackChunk,'track_id'|'stream_epoch'>; context:ContinuousContext;
  source_range:TimeRange; time_range:TimeRange; semantic_status:'open';
  reason:'acoustic_pause'|'resource_limit'|'input_exhausted'|'non_speech';
  start_sample:number;end_sample_exclusive:number; predecessor_refs:string[];
  detection:{model:VadStream['model'];progress:VadProgress;start_evidence:VadProgress};
}
interface StreamState {
  key:string; raw_ref:string; detection_epoch:string; source:TrackChunk; origin:number; expected_seq:number; next_sample:number;
  context:ContinuousContext; partial:boolean; abort:AbortController; detector?:VadStream;
  tail:Promise<void>; ending?:Promise<void>; queued:number;queued_seqs:Map<number,string>; failure?:unknown; speech?:{start:number;evidence:VadProgress};
  idle?:{event:ArchivedEvent;at:number;exhausted:boolean};
  sound_from?:number;
  previous:string[]; last?:{event:ArchivedEvent;progress:VadProgress;context:ContinuousContext};
}
class ContinuousCallOwnedError extends MediaCancelledWithoutEffectError {}
export interface ContinuousSourceOptions {
  disposition?(candidate:ContinuousCandidate):'process'|'call_owned'|'defer';
  storage:StoragePort;archive:RawArchive;detector:VadStreamFactory;budget:ContinuousBudget;
  process(candidate:ContinuousCandidate,ref:string,signal:AbortSignal):Promise<ProcessedEvent[]>;
  admit(candidate:ContinuousCandidate,events:ProcessedEvent[],signal:AbortSignal):Promise<void>;
  /** Detected silence: the detector has heard no open speech through `through_ms` (the audio clock's target timebase);
   *  `exhausted` when the stream's input ended there. Ordered after every candidate detected before it, on the same
   *  serial processing chain. */
  idle?(event:ArchivedEvent,through_ms:number,exhausted:boolean,signal:AbortSignal):Promise<void>;
  onError(error:unknown,ref?:string):void;
  /** Called when a stream or pinned C job of this raw source settles; the host drops its handle once nothing holds it. */
  release?(raw_ref:string):void;
}
// Source business owner. Storage holds original bytes, checkpoints and pinned C jobs;
// Hermes scheduling, history, native create retries and output remain existing owners.
export class ContinuousMediaSource {
  private readonly streams=new Map<string,StreamState>();
  private readonly jobs=new Map<string,string>(); // candidate key -> raw_ref
  private processing=Promise.resolve();
  private closed=false;private closing:Promise<void>|undefined;
  private processAbort=new AbortController();
  private readonly options:ContinuousSourceOptions;
  private control=Promise.resolve();
  private pendingControl=0;
  private mutate<T>(run:()=>Promise<T>):Promise<T> {
    try {check(this.pendingControl<this.options.budget.max_streams*(this.options.budget.max_pending_chunks+1),'CONTINUOUS_CONTROL_BACKLOG',429);}
    catch(error){return Promise.reject(error);}
    this.pendingControl++;
    const work=this.control.then(run).finally(()=>{this.pendingControl--;});this.control=work.then(()=>undefined,()=>undefined);return work;
  }
  constructor(options:ContinuousSourceOptions) {
    this.options={...options,budget:Object.freeze({...options.budget})};
    const b=options.budget;
    check([b.max_streams,b.max_pending_chunks,b.max_pending_candidates,b.max_chunk_bytes,b.block_samples].every(n=>Number.isSafeInteger(n)&&n>0)&&
      Number.isSafeInteger(b.overlap_samples)&&b.overlap_samples>=0&&b.overlap_samples<b.block_samples&&
      b.block_samples<=160000,'CONTINUOUS_MEDIA_BUDGET');
  }
  private key(event:ArchivedEvent,chunk:TrackChunk){return digest([event.raw_ref,chunk.track_id,chunk.stream_epoch]);}
  private async publish(namespace:string,key:string,value:unknown,rawRef?:string) {
    const ref=rawRef??(value as {raw_ref?:string;event?:{raw_ref?:string}}).raw_ref??(value as {event?:{raw_ref?:string}}).event?.raw_ref;
    const encoded=Buffer.from(canonical(value));check(encoded.length<=1048576,'CONTINUOUS_METADATA_BUDGET',413);
    const stored=ref?await publishRawRecord(this.options.storage,ref,namespace,key,encoded):await this.options.storage.publish(namespace,key,encoded);
    check(Buffer.from(stored).equals(encoded),'CONTINUOUS_METADATA_CONFLICT',409);
  }
  /** Accept only an already published L5 revision and host-resolved context; stores no PCM queue. */
  accept(event:ArchivedEvent,chunk:TrackChunk,context:ContinuousContext,reset=false,beforeQueue?:()=>Promise<void>,owner?:QueueOwner):Promise<QueueAcceptance> {
    const snapshots=[structuredClone(event),structuredClone(chunk),structuredClone(context)] as const;
    return this.mutate(()=>owner?owner(accepted=>this.acceptOwned(...snapshots,reset,accepted)):
      this.acceptOwned(...snapshots,reset,beforeQueue));
  }
  /** Host v2 input: preflight every frame before the one durable claim acceptance. */
  acceptInterval(entries:{event:ArchivedEvent;chunk:TrackChunk;context:ContinuousContext}[],owner:(queue:(fresh:number[],accept:()=>Promise<void>)=>Promise<QueueAcceptance[]>)=>Promise<{result:QueueAcceptance;replayed:boolean}[]>,reset=false){
    entries=structuredClone(entries);
    return this.mutate(async()=>{
      check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);
      check(entries.length>0&&entries.length<=64,'CONTINUOUS_INTERVAL_BUDGET');
      const first=entries[0]!,key=this.key(first.event,first.chunk);
      const state=reset?undefined:this.streams.get(key);
      let seq=first.chunk.seq,sample:number|undefined;

      for(const {event,chunk,context} of entries){
        check(this.key(event,chunk)===key&&chunk.source_range.kind==='interval'&&chunk.format==='pcm_s16le:16000:1'&&chunk.modality==='audio','CONTINUOUS_INTERVAL_SOURCE_CONFLICT',403);
        check(event.archive_status==='durable'&&event.origin==='device_observation'&&event.user_identity==='unknown','CONTINUOUS_SOURCE_REQUIRED',403);
        check(context.session.length>0&&context.clock_maps.length>0&&context.clock_maps.length<=64,'CONTINUOUS_CONTEXT_REQUIRED',403);
        const maps=context.clock_maps.filter(m=>m.modality==='audio');check(maps.length===1,'CONTINUOUS_AUDIO_CLOCK_REQUIRED',403);
        check(maps[0]!.track_id===chunk.track_id&&maps[0]!.stream_epoch===chunk.stream_epoch,'CONTINUOUS_CLOCK_SCOPE',403);
        check(new Set(context.clock_maps.map(m=>digest([m.track_id,m.stream_epoch]))).size===context.clock_maps.length&&context.clock_maps.every(m=>m.target_timebase_id===maps[0]!.target_timebase_id),'CONTINUOUS_CLOCK_ASSOCIATION',403);
        mappedRange(chunk.source_range,maps[0]!);
        check(chunk.source_range.timebase_id===first.chunk.source_range.timebase_id&&(!state||state.source.source_range.timebase_id===chunk.source_range.timebase_id),'CONTINUOUS_CONTEXT_CHANGED',403);
        check(sameDetectionContext(first.context,context)&&(!state||sameDetectionContext(state.context,context)),'CONTINUOUS_CONTEXT_CHANGED',403);
        const start=chunk.source_range.start_ms*16,end=chunk.source_range.end_ms*16;
        check(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&end>start,'CONTINUOUS_SAMPLE_AXIS');
        // Input axes remain checked even when every canonical claim is already completed.
        check(chunk.seq===seq&&(sample===undefined||sample===start),'CONTINUOUS_SEQUENCE_GAP_OR_REORDER',409);seq++;sample=end;
      }
      return owner(async(fresh,accept)=>{
        const queue=fresh.map(n=>entries[n]!);
        if(!queue.length)return [];
        const current=reset?undefined:this.streams.get(key);
        check(current||queue[0]!.chunk.seq===0||reset,'CONTINUOUS_RESET_REQUIRED',409);
        check((current?.queued??0)+queue.length<=this.options.budget.max_pending_chunks,'CONTINUOUS_CHUNK_BACKLOG',429);
        let next=current?.expected_seq??(reset?queue[0]!.chunk.seq:0),start=current?.next_sample;
        for(const entry of queue){check(entry.chunk.source_range.kind==='interval','CONTINUOUS_SOURCE_REQUIRED');
          check(entry.chunk.seq===next&&(start===undefined||entry.chunk.source_range.start_ms*16===start),'CONTINUOUS_SEQUENCE_GAP_OR_REORDER',409);
          next++;start=entry.chunk.source_range.end_ms*16;}
        check(!this.closed&&!current?.ending&&!current?.failure&&!current?.abort.signal.aborted,'CONTINUOUS_DETECTION_FAILED',409);
        if(reset){const prior=this.streams.get(key);if(prior){prior.abort.abort();await prior.tail;await prior.detector?.close();this.streams.delete(key);}}
        const group:{frames:unknown[];remaining:number}={frames:[],remaining:queue.length};
        // Existing acceptOwned creates the canonical detection epoch before durable acceptance.
        const results:QueueAcceptance[]=[];
        for(let n=0;n<queue.length;n++){
          const entry=queue[n]!;results.push(await this.acceptOwned(entry.event,entry.chunk,entry.context,reset&&n===0,n===0?accept:undefined,group));
        }
        return results;
      });
    });
  }
  private async acceptOwned(event:ArchivedEvent,chunk:TrackChunk,context:ContinuousContext,reset:boolean,beforeQueue?:()=>Promise<void>,group?:{frames:unknown[];remaining:number}):Promise<{status:'queued'|'duplicate';stream_key:string}> {
    check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);
    event=structuredClone(event);chunk=structuredClone(chunk);context=structuredClone(context);
    check(event.archive_status==='durable'&&event.origin==='device_observation'&&event.user_identity==='unknown'&&
      chunk.modality==='audio'&&chunk.format==='pcm_s16le:16000:1'&&chunk.source_range.kind==='interval',
      'CONTINUOUS_SOURCE_REQUIRED',403);
    check(context.session.length>0&&context.clock_maps.length>0&&context.clock_maps.length<=64,'CONTINUOUS_CONTEXT_REQUIRED',403);
    const audio=context.clock_maps.filter(map=>map.modality==='audio');
    check(audio.length===1,'CONTINUOUS_AUDIO_CLOCK_REQUIRED',403);
    const map=audio[0]!;
    check(new Set(context.clock_maps.map(map=>digest([map.track_id,map.stream_epoch]))).size===context.clock_maps.length&&
      context.clock_maps.every(other=>other.target_timebase_id===map.target_timebase_id), 'CONTINUOUS_CLOCK_ASSOCIATION',403);
    check(map.modality==='audio'&&map.track_id===chunk.track_id&&map.stream_epoch===chunk.stream_epoch,
      'CONTINUOUS_CLOCK_SCOPE',403);
    mappedRange(chunk.source_range,map);
    const key=this.key(event,chunk),checkpoint=digest([key,chunk.seq]);
    try {let saved=JSON.parse(Buffer.from(await this.options.storage.read('media-source-progress',checkpoint)).toString());
      if(saved.schema==='paios.media.source-progress.interval.v2')saved=saved.frames.find((frame:{seq:number})=>frame.seq===chunk.seq);
      check(saved,'CONTINUOUS_DUPLICATE_CONFLICT');
      check(saved.archive_revision===event.archive_revision||saved.raw_ref===event.raw_ref,'CONTINUOUS_DUPLICATE_CONFLICT');
      return {status:'duplicate',stream_key:key};
    } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);
    let state=this.streams.get(key);
    if(reset&&state){state.abort.abort();await state.tail;await state.detector?.close();this.streams.delete(key);state=undefined;}
    const start=chunk.source_range.start_ms*16,end=chunk.source_range.end_ms*16;
    check(Number.isSafeInteger(start)&&Number.isSafeInteger(end),'CONTINUOUS_SAMPLE_AXIS');
    if(!state) {
      check(this.streams.size<this.options.budget.max_streams,'CONTINUOUS_STREAM_BACKLOG',429);
      // A nonzero first sequence explicitly starts a new partial detection epoch, never restores hidden RNN state.
      check(chunk.seq===0||reset,'CONTINUOUS_RESET_REQUIRED',409);
      state={key,raw_ref:event.raw_ref,detection_epoch:randomUUID(),source:chunk,origin:start,expected_seq:chunk.seq,next_sample:start,
        context,partial:reset||chunk.seq!==0,abort:new AbortController(),tail:Promise.resolve(),queued:0,queued_seqs:new Map(),previous:[]};
      await this.publish('media-detection-epochs',digest([key,state.detection_epoch]),{
        raw_ref:event.raw_ref,track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,detection_epoch:state.detection_epoch,
        origin_sample:start,seq:chunk.seq,reset_reason:state.partial?'explicit_gap_or_restart':'source_start',semantic_status:'open'});
      check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);this.streams.set(key,state);
    }
    check(!state.ending,'CONTINUOUS_INPUT_EXHAUSTED',409);
    check(!state.failure,'CONTINUOUS_DETECTION_FAILED',409);
    check(!state.abort.signal.aborted,'CONTINUOUS_DETECTION_CANCELLED',409);
    check(sameDetectionContext(state.context,context)&&
      state.source.source_range.timebase_id===chunk.source_range.timebase_id,
      'CONTINUOUS_CONTEXT_CHANGED',403);
    if(state.queued_seqs.get(chunk.seq)===digest(chunk))return {status:'duplicate',stream_key:key};
    check(chunk.seq===state.expected_seq&&start===state.next_sample,'CONTINUOUS_SEQUENCE_GAP_OR_REORDER',409);
    check(state.queued<this.options.budget.max_pending_chunks,'CONTINUOUS_CHUNK_BACKLOG',429);
    await beforeQueue?.();check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);
    const owned=state;owned.expected_seq++;owned.next_sample=end;owned.queued++;owned.queued_seqs.set(chunk.seq,digest(chunk));
    const work=owned.tail.then(()=>this.detect(owned,event,chunk,context,group));
    owned.tail=work.catch(async error=>{
      owned.failure=error;owned.abort.abort();await owned.detector?.close();
      await this.publish('media-source-failures',digest([key,chunk.seq]),{
        raw_ref:event.raw_ref,archive_revision:event.archive_revision,seq:chunk.seq,detection_epoch:owned.detection_epoch,
        state:'failed',error:error instanceof Error?error.message:String(error),raw_status:'durable'});
      this.options.onError(error);
    }).finally(()=>{owned.queued--;owned.queued_seqs.delete(chunk.seq);});
    return {status:'queued',stream_key:key};
  }
  private async detect(state:StreamState,event:ArchivedEvent,chunk:TrackChunk,context:ContinuousContext,group?:{frames:unknown[];remaining:number}) {
    check(!state.abort.signal.aborted,'CONTINUOUS_CANCELLED',409);
    const selected=await this.options.archive.readExactChunk(event,chunk,this.options.budget.max_chunk_bytes);
    check(selected.chunk.seq===chunk.seq&&selected.chunk.stream_epoch===chunk.stream_epoch&&
      canonical(selected.chunk.source_range)===canonical(chunk.source_range),'CONTINUOUS_SOURCE_SELECTION');
    if(!state.detector){state.detector=await this.options.detector.open(state.abort.signal);
      if(state.detector.model.native_metadata.sound_window_samples)state.sound_from=state.origin;}
    const progress=await state.detector.write(selected.bytes);
    for(const item of progress) {
      const absolute=state.origin+item.processed_samples;
      if(item.start!==undefined){check(!state.speech,'CONTINUOUS_VAD_START_CONFLICT');
        await this.sounds(state,event,state.origin+item.start,item,context,true);delete state.sound_from;
        state.speech={start:state.origin+item.start,evidence:item};}
      if(state.speech) {
        const stop=item.end===undefined?absolute:state.origin+item.end;
        while(stop-state.speech.start>=this.options.budget.block_samples) {
          const end=state.speech.start+this.options.budget.block_samples;
          await this.candidate(state,event,end,'resource_limit',item,context);
          state.speech.start=end-this.options.budget.overlap_samples;
        }
        if(item.end!==undefined){if(stop>state.speech.start)await this.candidate(state,event,stop,'acoustic_pause',item,context);delete state.speech;
          if(state.detector.model.native_metadata.sound_window_samples)state.sound_from=stop;}
      } else check(item.end===undefined,'CONTINUOUS_VAD_END_WITHOUT_START');
      // Keep the detector's onset lookback unclassified until it either becomes speech or is confirmed non-speech.
      if(!state.speech)await this.sounds(state,event,absolute-Number(state.detector.model.native_metadata.lookback_samples??0),item,context);
      state.last={event,progress:item,context};
    }
    if(state.last)Object.assign(state.last,{event,context});
    else state.last={event,context,progress:{processed_samples:0,input_sha256:sha256(Buffer.alloc(0))}};
    if(!state.speech)this.silence(state);
    const checkpoint={raw_ref:event.raw_ref,archive_revision:event.archive_revision,seq:chunk.seq,detection_epoch:state.detection_epoch,
      source_sample_end:chunk.source_range.kind==='interval'?chunk.source_range.end_ms*16:0,
      inferred_sample_end:state.last?state.origin+state.last.progress.processed_samples:state.origin,
      detector_state_exported:false,candidates:[...state.previous],semantic_status:'open'};
    if(!group){await this.publish('media-source-progress',digest([state.key,chunk.seq]),checkpoint);return;}
    group.frames.push(checkpoint);if(--group.remaining)return;
    const value={schema:'paios.media.source-progress.interval.v2',raw_ref:event.raw_ref,frames:group.frames},bytes=Buffer.from(canonical(value)),hash=digest(value);
    if(this.options.storage.publishMany&&this.options.storage.stageAlias&&this.options.storage.flushNamespace){
      await withRawPublication(this.options.storage,event.raw_ref,async()=>{
        await this.options.storage.trackSessionRecords?.(event.raw_ref,[{namespace:'media-source-progress',key:hash},
          ...group.frames.map(frame=>({namespace:'media-source-progress',key:digest([state.key,(frame as typeof checkpoint).seq])}))]);
        await this.options.storage.publishMany!('media-source-progress',[{key:hash,bytes}]);
        for(const frame of group.frames as typeof checkpoint[]){
          const winner=await this.options.storage.stageAlias!('media-source-progress',hash,digest([state.key,frame.seq]));
          check(Buffer.from(winner.winner).equals(bytes),'CONTINUOUS_METADATA_CONFLICT',409);
        }
        await this.options.storage.flushNamespace!('media-source-progress');
      });
    }else{
      for(const frame of group.frames as typeof checkpoint[])await this.publish('media-source-progress',digest([state.key,frame.seq]),frame);
    }

  }
  private async sounds(state:StreamState,event:ArchivedEvent,through:number,progress:VadProgress,context:ContinuousContext,flush=false) {
    const width=Math.min(Number(state.detector!.model.native_metadata.sound_window_samples??0),this.options.budget.block_samples);
    if(state.sound_from===undefined)return;
    while(through-state.sound_from>=width||flush&&through>state.sound_from){
      const start=state.sound_from,end=Math.min(start+width,through);
      await this.candidate(state,event,end,'non_speech',progress,context,{start,evidence:progress});state.sound_from=end;
    }
  }
  private async candidate(state:StreamState,event:ArchivedEvent,end:number,reason:ContinuousCandidate['reason'],progress:VadProgress,context:ContinuousContext,
    speech=state.speech!) {
    const source_range:TimeRange={kind:'interval',timebase_id:state.source.source_range.timebase_id,
      stream_epoch:state.source.stream_epoch,start_ms:speech.start/16,end_ms:end/16};
    const candidate:ContinuousCandidate={schema:'paios.media.continuous-candidate.v1',authority:'central_media_c_owner',
      stream_key:state.key,detection_epoch:state.detection_epoch,detection_origin_sample:state.origin,partial:state.partial,
      event:structuredClone(event),track:{track_id:state.source.track_id,stream_epoch:state.source.stream_epoch},context:structuredClone(context),
      source_range,time_range:mappedRange(source_range,context.clock_maps.find(map=>map.modality==='audio')!),semantic_status:'open',reason,
      start_sample:speech.start,end_sample_exclusive:end,predecessor_refs:[...state.previous],
      detection:{model:structuredClone(state.detector!.model),progress:structuredClone(progress),start_evidence:structuredClone(speech.evidence)}};
    delete state.idle;
    const key=digest(candidate);await this.publish('media-continuous-candidates',key,candidate);
    state.previous=[`l5-continuous:${key}`];
    // Deferred analysis keeps its bounded slots. Let detection yield at the pinned candidate,
    // so overload reaches the existing chunk admission budget without poisoning the detector.
    // Call-owned PCM has no ambient work and never waits for a slot.
    const signal=AbortSignal.any([state.abort.signal,this.processAbort.signal]);
    while(this.jobs.size>=this.options.budget.max_pending_candidates&&this.options.disposition?.(candidate)!=='call_owned'){
      signal.throwIfAborted();await delay(250,undefined,{signal});
    }
    signal.throwIfAborted();
    if(await this.queueCandidate(key,candidate)){
      try{emitRuntimeEvent({ambient_stage:'candidate_ready',candidate:key.slice(-8),at:Date.now(),reason,
        ...(reason==='acoustic_pause'?{endpoint_ms:Math.round((state.origin+progress.processed_samples-end)/16)}:{})});}catch{}
    }
  }
  private silence(state:StreamState,exhausted=false) {
    const idle=this.options.idle,last=state.last;if(!idle||!last)return;
    const map=last.context.clock_maps.find(m=>m.modality==='audio')!,signal=this.processAbort.signal;
    const through=mappedRange({kind:'instant',timebase_id:state.source.source_range.timebase_id,stream_epoch:state.source.stream_epoch,
      at_ms:(state.origin+last.progress.processed_samples)/16},map);
    const event=structuredClone(last.event),at=through.kind==='instant'?through.at_ms:through.end_ms;
    if(state.idle){Object.assign(state.idle,{event,at,exhausted});return;}
    const marker={event,at,exhausted};state.idle=marker;
    this.processing=this.processing.then(()=>{
      if(state.idle===marker)delete state.idle;
      return signal.aborted?undefined:idle(marker.event,marker.at,marker.exhausted,signal);
    }).catch(error=>this.options.onError(error));
  }
  /** Recheck at queued start, actual model dispatch, and admission. Deferred work stays in the existing bounded chain. */
  async beforeAnalysis(candidate:ContinuousCandidate,signal:AbortSignal){
    while(true){
      check(!signal.aborted,'CONTINUOUS_PROCESS_CANCELLED',409);
      const disposition=this.options.disposition?.(candidate)??'process';
      if(disposition==='call_owned')throw new ContinuousCallOwnedError();
      if(disposition==='process')return;
      await delay(250,undefined,{signal});
    }
  }
  private async queueCandidate(key:string,candidate:ContinuousCandidate) {
    check(!this.closed,'CONTINUOUS_MEDIA_CLOSED',503);
    check(!this.jobs.has(key),'CONTINUOUS_CANDIDATE_ACTIVE',409);
    // Call-owned PCM has no ambient work: settle it before the serial lane and its candidate budget.
    if(this.options.disposition?.(candidate)==='call_owned'){
      await this.callOwned(key,candidate.event.raw_ref);this.options.release?.(candidate.event.raw_ref);return false;
    }
    this.enqueue(key,candidate.event.raw_ref);return true;
  }
  private callOwned(key:string,rawRef:string){
    return this.publish('media-continuous-dispositions',key,{candidate_ref:`l5-continuous:${key}`,state:'call_owned',raw_status:'durable'},rawRef);
  }
  private enqueue(key:string,rawRef:string) {
    check(this.jobs.size<this.options.budget.max_pending_candidates,'CONTINUOUS_CANDIDATE_BACKLOG',429);
    this.jobs.set(key,rawRef);const signal=this.processAbort.signal,queued=performance.now();
    this.processing=this.processing.then(async()=>{
      const candidate=JSON.parse(Buffer.from(await this.options.storage.read('media-continuous-candidates',key)).toString()) as ContinuousCandidate;
      check(digest(candidate)===key&&candidate.authority==='central_media_c_owner','CONTINUOUS_CANDIDATE_INTEGRITY');
      try {
        await this.beforeAnalysis(candidate,signal);
        const started=performance.now(),events=await this.options.process(candidate,`l5-continuous:${key}`,signal);
        try{emitRuntimeEvent({ambient_stage:'analysis_ready',candidate:key.slice(-8),at:Date.now(),
          queue_ms:Math.round(started-queued),processing_ms:Math.round(performance.now()-started)});}catch{}
        await this.beforeAnalysis(candidate,signal);
        await this.options.admit(candidate,events,signal);
        await this.publish('media-continuous-admitted',key,{candidate_ref:`l5-continuous:${key}`,
          processed_event_ids:events.map(d=>d.processed_event_id),state:'admission_accepted',native_completion:'not_asserted'},candidate.event.raw_ref);
      } catch(error) {
        if(error instanceof ContinuousCallOwnedError){
          await this.callOwned(key,candidate.event.raw_ref);return;
        }
        await this.publish('media-continuous-attempts',digest([key,randomUUID()]),{candidate_ref:`l5-continuous:${key}`,
          state:error instanceof AudioConsumptionUnknownError||error instanceof ContractError&&error.code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'?'unknown':'retryable',error:error instanceof Error?error.message:String(error)},candidate.event.raw_ref);this.options.onError(error,`l5-continuous:${key}`);
      }
    }).catch(error=>this.options.onError(error,`l5-continuous:${key}`)).finally(()=>{this.jobs.delete(key);this.options.release?.(rawRef);});
  }
  /** The original pinned C drives cached D and SAME Admission; no new native retry loop. */
  async retry(ref:string,authorize?:(event:ArchivedEvent)=>void) {
    const key=/^l5-continuous:([a-f0-9]{64})$/u.exec(ref)?.[1];check(key,'CONTINUOUS_CANDIDATE_REF');
    const candidate=JSON.parse(Buffer.from(await this.options.storage.read('media-continuous-candidates',key)).toString()) as ContinuousCandidate;
    check(digest(candidate)===key,'CONTINUOUS_CANDIDATE_INTEGRITY');authorize?.(candidate.event);await this.queueCandidate(key,candidate);
  }
  /** True while a live (possibly failed/cancelled, not yet finished) stream or a pinned C job still needs this source. */
  holds(rawRef:string){return [...this.streams.values()].some(state=>state.raw_ref===rawRef)||[...this.jobs.values()].includes(rawRef);}
  finish(key:string){return this.mutate(async()=>{
    const state=this.streams.get(key);check(state,'CONTINUOUS_STREAM_UNKNOWN',404);
    // Seal this stream on the control chain; waiting for its detector must not fence another stream's acceptance.
    state.ending??=this.finishOwned(key);void state.ending.catch(()=>{});return {done:state.ending};
  }).then(result=>result.done);}
  private async finishOwned(key:string) {
    const state=this.streams.get(key);check(state,'CONTINUOUS_STREAM_UNKNOWN',404);
    try {
      await state.tail;
      check(!state.failure,'CONTINUOUS_DETECTION_FAILED',409);check(!state.abort.signal.aborted,'CONTINUOUS_DETECTION_CANCELLED',409);
      const terminal=await state.detector?.finish();
      if(state.speech&&state.last){const end=state.origin+state.last.progress.processed_samples;
        if(end>state.speech.start)await this.candidate(state,state.last.event,end,'input_exhausted',state.last.progress,state.last.context);delete state.speech;
        if(state.detector!.model.native_metadata.sound_window_samples)state.sound_from=end;}
      if(state.last&&terminal)await this.sounds(state,state.last.event,state.origin+terminal.processed_samples+terminal.uninferred_samples,
        {...state.last.progress,processed_samples:terminal.processed_samples+terminal.uninferred_samples,input_sha256:terminal.input_sha256},state.last.context,true);
      this.silence(state,true);
      await this.publish('media-detection-finished',digest([key,state.detection_epoch]),{
        detection_epoch:state.detection_epoch,terminal:terminal??null,semantic_status:'open',acoustic_end_asserted:false},state.raw_ref);
    } finally {
      // Finish is the host's terminal signal for this stream: failed/cancelled detection is reclaimed too,
      // so neither its detector slot nor its source handle outlives the capture span.
      if(this.streams.get(key)===state)this.streams.delete(key);
      this.options.release?.(state.raw_ref);await state.detector?.close();
    }
  }
  cancelDetection(key:string){return this.mutate(()=>this.cancelDetectionOwned(key));}
  private async cancelDetectionOwned(key:string){const state=this.streams.get(key);check(state,'CONTINUOUS_STREAM_UNKNOWN',404);
    state.abort.abort();await state.detector?.close();await state.tail;}
  cancelProcessing(){this.processAbort.abort();this.processAbort=new AbortController();for(const state of this.streams.values())delete state.idle;}
  async drain(){await this.control;await Promise.all([...this.streams.values()].map(async state=>{await state.tail;await state.ending;}));await this.processing;}
  snapshot(){return {streams:this.streams.size,pending_control:this.pendingControl,pending_chunks:[...this.streams.values()].reduce((n,s)=>n+s.queued,0),pending_candidates:this.jobs.size};}
  close():Promise<void> {
    if(this.closing)return this.closing;this.closed=true;this.processAbort.abort();
    this.closing=(async()=>{await this.control;for(const state of this.streams.values())state.abort.abort();
      await Promise.allSettled([...this.streams.values()].map(async state=>{await state.detector?.close();await state.tail;await state.ending;}));
      await this.processing;this.streams.clear();})();return this.closing;
  }
}

// Manual finite selection reuses exactly the streaming detector; EOF is a resource boundary,
// never an acoustic pause. Sample provenance is finalized by the existing MEDIA source timeline.
export async function finiteVadSelection(factory:VadStreamFactory,request:import('./processing.ts').WorkerRequest,signal:AbortSignal,maxSamples=160000) {
  const {selectedAudioTimeline}=await import('./sample-timeline.ts');
  const {sampleInput}=await import('./sample-results.ts');
  const groups=selectedAudioTimeline(request);check(groups.length===1&&groups[0]!.total_samples<=maxSamples,'CONTINUOUS_FINITE_BUDGET');
  const group=groups[0]!,input=sampleInput(group);
  const {stream,segments,terminal}=await speechSpans(factory,Buffer.concat(group.views.map(view=>Buffer.from(view.bytes))),signal);
  return [{schema:'paios.media.audio-sample-result.v1' as const,kind:'speech_signal' as const,...input,sample_rate:group.sample_rate,
    sample_count:group.total_samples,segments,model:{...stream.model,native_metadata:{...stream.model.native_metadata,
      processed_samples:terminal.processed_samples,uninferred_samples:terminal.uninferred_samples,input_exhaustion_flushed:false}}}];
}
/** Speech spans of one finite s16le 16 kHz buffer from the streaming detector's start/end events (finite selection and
 *  voiceprint enrollment). A span still open at the end runs to the last inferred sample; EOF is never a pause. */
export async function speechSpans(factory:VadStreamFactory,pcm:Uint8Array,signal:AbortSignal) {
  const stream=await factory.open(signal);
  try {
    const writeBytes=Math.floor(NATIVE_WINDOW_SAMPLES/512)*512*2;
    const segments:{start_sample:number;end_sample_exclusive:number}[]=[];let start:number|undefined;
    // One stream keeps the complete sample axis; each native write stays bounded even for minutes of enrollment.
    for(let at=0;at<pcm.length;at+=writeBytes){
      const progress=await stream.write(pcm.subarray(at,at+writeBytes));
      for(const event of progress){if(event.start!==undefined){check(start===undefined,'CONTINUOUS_VAD_START_CONFLICT');start=event.start;}
        if(event.end!==undefined){check(start!==undefined,'CONTINUOUS_VAD_END_WITHOUT_START');if(event.end>start)segments.push({start_sample:start,end_sample_exclusive:event.end});start=undefined;}}
    }
    const terminal=await stream.finish();
    if(start!==undefined&&terminal.processed_samples>start)segments.push({start_sample:start,end_sample_exclusive:terminal.processed_samples});
    return {stream,segments,terminal};
  } finally {await stream.close();}
}
