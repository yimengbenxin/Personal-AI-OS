import {readReusedAudio,audioContent,verifySelectedAudio,type MediaInputRecord} from './media/processing.ts';
import {publishUnknownClock,readUnknownClock,validateUnknownClock,type UnknownClockRaw,type QuarantinedOriginal} from './unknown-clock.ts';
import type {StoredChunk,TrackChunk} from './stream-archive.ts';
import { bindRaw, canonical, check, ContractError, digest, principalAttribution, sha256, validateProcessed, validateRange, type ArchivedEvent, type BoundEvent,
  type RawEvent, type TrustedContext, type ProcessedEvent, type TimeRange } from './contracts.ts';
import type { StoragePort } from './storage.ts';
import type {ColdRecord} from './cold-storage.ts';
import {requireRawAvailable,streamManifestRevision,StreamArchive,type StreamBudget,type StreamReadOptions,type VerifiedStreamRecord} from './stream-archive.ts';
import {DerivedArchive,type DerivedManifest,type VerifiedDerivedRecord} from './derived-archive.ts';
import type {DemuxPort} from './media/tracks.ts';
import type {MediaView} from './media/align.ts';
import {constants,promises as fs} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {PosixStorage} from './storage.ts';
import {OriginalAdmission} from './original-admission.ts';
import {finalizeSession} from './session-finalization.ts';
import {discoverSessionRecords} from './session-discovery.ts';
import type {CallAudioTrack,FinalSession} from './session-records.ts';
export type {CallAudioTrack} from './session-records.ts';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';

type TierRecord=Omit<ColdRecord,'bytes'>&{size?:number;modified?:number};
export interface TierUploadPolicy {busy?:()=>boolean;max_upload_kbps?:number;budget_ms?:number;paused?:boolean}
// Immutable archive records use the same cold namespace/key reader. Mutable registries and work intents stay local.
export const TIER_NAMESPACES=['objects','stream-revisions','manifests','quarantine-manifests',
  'derived-manifests','derivation-attempts','derivation-settlements','original-source-metadata',
  'media-source-progress','media-source-failures','media-capture-gaps','media-postarchive-admissions',
  'media-views','media-vad-selections','processed-media','processed-media-inputs',
  'media-continuous-candidates','media-continuous-attempts','media-continuous-admitted','media-continuous-dispositions',
  'media-continuous-selection','media-detection-epochs','media-detection-finished',
  'audio-consumer-attempts','audio-consumer-accepted','audio-consumer-not-accepted','audio-consumer-results',
  'audio-consumer-d','audio-consumer-routes','audio-consumer-spans','voice-transcripts'] as const;
interface TierBacklog {hot_records:number;hot_bytes:number;old_records:number;old_bytes:number;oversized_records:number;
  oldest_hot_record:{namespace:string;key:string;modified_at:string}|null;observed_at:string|null;complete:boolean}
class TierUploadDeferred extends Error {}
class MaintenanceClosed extends Error {}

type Capture=({kind:'stream'|'unknown';raw:Omit<RawEvent,'payload'>|Omit<UnknownClockRaw,'payload'>;chunk:TrackChunk}|
  {kind:'original';raw:Omit<RawEvent,'payload'>})&{trusted:TrustedContext;received_at:string;binding?:unknown};
type CaptureResult=Awaited<ReturnType<StreamArchive['append']>>|QuarantinedOriginal|ArchivedEvent;

export type OriginalArchiveRecord = {kind:'original'; event:BoundEvent; bytes:Uint8Array;
  archive_revision:string;payload_sha256:string;total_bytes:number;selected_bytes:number};
export type StreamArchiveRecord = VerifiedStreamRecord & {kind:'stream';event:BoundEvent;archive_revision:string};
export type ArchiveRecord = OriginalArchiveRecord | StreamArchiveRecord;
export interface OriginalArchive {
  read(rawRef:string,principalId:string,revision:string):Promise<Uint8Array>;
  readRecord(rawRef:string,principalId:string,revision:string,options?:StreamReadOptions):Promise<ArchiveRecord>;
  validateEvidence(event:ProcessedEvent):Promise<boolean>;
  locate(rawRef:string,principalId:string):Promise<ArchivedEvent>;
}

interface Manifest {
  schema_version: 'paios.archive.v1'; event: BoundEvent; fingerprint: string;
  payload_sha256: string; bytes: number; archive_revision: string;
}
export class DurableCaptureDetached extends Error {
  readonly ingress_keys:string[];
  constructor(key:string|string[]){super('L5_DURABLE_CAPTURE_DETACHED');this.ingress_keys=Array.isArray(key)?key:[key];}
}
export class RawArchive implements OriginalArchive {
  private readonly storage: StoragePort; private readonly maxEventBytes: number; private readonly now: () => string;
  /** The one stream authority (and journal cache) for this storage's L5 lanes. */
  readonly streams:StreamArchive;
  private readonly derivatives:DerivedArchive;
  private readonly admission:OriginalAdmission<CaptureResult>;
  private readonly endingSessions=new Set<string>();
  private recovery:Promise<void>|undefined;
  private closing=false;
  private hotDays=2;
  private sessionFolding=true;
  private tierScan:AsyncGenerator<TierRecord|null>|undefined;
  private tierNext:TierRecord|undefined;
  private tierPending:ColdRecord[]=[];
  private nextUploadAt=0;
  private tierPaused=false;
  private backlog:TierBacklog={hot_records:0,hot_bytes:0,old_records:0,old_bytes:0,oversized_records:0,oldest_hot_record:null,observed_at:null,complete:false};
  private readonly tierProgress={verified_records:0,hot_bytes:0,cold_bytes:0,evicted_records:0,evicted_bytes:0};
  private evictionAfter='';
  private evictionPack:string|undefined;
  private foldWork:Promise<void>|undefined;
  private foldResume:(()=>void)|undefined;
  private foldPaused=Promise.withResolvers<void>();
  private maintenanceDeadline=0;
  private maintenanceBusy:()=>boolean=()=>false;
  private legacyDiscovered=false;
  private readonly folding={enabled:true,phase:'idle',sessions_remaining:0,files_remaining:0,completed:0,
    discovery:{scanned:0,adopted:0,unresolved:0},
    active_raw_ref:null as string|null,last_error:null as string|null,observed_at:null as string|null};
  private removal:((principal:string,processed:readonly string[],rawRefs:readonly string[])=>void|Promise<void>)|undefined;
  async setRemoval(owner:(principal:string,processed:readonly string[],rawRefs:readonly string[])=>void|Promise<void>):Promise<void> {
    check(!this.removal,'ARCHIVE_REMOVAL_OWNER_CONFLICT');this.removal=owner;
    await this.reconcileRemovals();
  }
  async reconcileRemovals():Promise<void> {
    await this.exclusively(async()=>{
      const deleted=new Map<string,Set<string>>();
      for(const key of await this.storage.list('owner-deletions')){
        const intent=JSON.parse(Buffer.from(await this.storage.read('owner-deletions',key)).toString()) as {principal_id:string;raw_ref?:string};
        let targets=deleted.get(intent.principal_id);if(!targets)deleted.set(intent.principal_id,targets=new Set());
        targets.add(intent.raw_ref??`l5:${key}`);
      }
      for(const [principal,targets] of deleted)await this.notifyRemoval(principal,targets);
    });
  }
  private async notifyRemoval(principal:string,targets:ReadonlySet<string>):Promise<void> {
    if(!this.removal)return;
    const processed:string[]=[];
    for(const key of await this.storage.list('processed-events')){
      const d=JSON.parse(Buffer.from(await this.storage.read('processed-events',key)).toString()) as ProcessedEvent;
      const observations=d.content.audio_observations;
      const derived=Array.isArray(observations)&&observations.some(o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&
        o.observation_kind==='sourced_speech'&&o.evidence!==null&&typeof o.evidence==='object'&&!Array.isArray(o.evidence)&&
        typeof o.evidence.raw_ref==='string'&&targets.has(o.evidence.raw_ref));
      if(d.principal_id===principal&&(targets.has(d.raw_ref)||derived))processed.push(d.processed_event_id);
    }
    await this.removal(principal,processed,[...targets]);
  }
  private alert:(reason:string,principal?:string)=>Promise<void>=async reason=>{console.warn(reason);};
  private alertWork=new Set<Promise<void>>();
  private lifecycle:Promise<unknown>=Promise.resolve();
  private exclusively<T>(work:()=>Promise<T>){const result=this.lifecycle.then(work);this.lifecycle=result.catch(()=>undefined);return result;}
  constructor(storage: StoragePort, maxEventBytes: number, now = () => new Date().toISOString(), streamBudget?:StreamBudget) {
    this.storage = storage; this.maxEventBytes = maxEventBytes; this.now = now;
    check(Number.isSafeInteger(maxEventBytes) && maxEventBytes > 0, 'INVALID_EVENT_BUDGET');
    this.streams=new StreamArchive(storage,streamBudget??{max_chunk_bytes:maxEventBytes,max_total_bytes:maxEventBytes,
      max_chunks:4096,max_revisions:4096,max_seq:65536});
    this.derivatives=new DerivedArchive(storage,this.streams.budget);
    this.admission=new OriginalAdmission(storage,(record,payload)=>this.commitCapture(record as Capture,payload),(error,record)=>{
      this.notify('L5_CAPTURE_PAUSED',(record as Capture|undefined)?.trusted.principal_id);},
      record=>requireRawAvailable(storage,this.captureRef(record as Capture)),async record=>{
        const capture=record as Capture,ref=this.captureRef(capture);
        if(this.endingSessions.has(ref))await this.endSession(ref);
        if(capture.kind==='stream'&&await storage.readFinal?.(ref))await storage.resumeFinalCleanup?.(ref);
      });
    if(storage instanceof PosixStorage){storage.setReservePolicy(async bytes=>{await this.evictCold(Date.now(),true,bytes);});
      storage.setAlert(error=>this.notify(error instanceof Error?error.message:String(error)));}
  }
  setAlert(alert:RawArchive['alert']){this.alert=alert;}
  private notify(reason:string,principal?:string){
    const work=Promise.resolve().then(()=>this.alert(reason,principal));this.alertWork.add(work);
    void work.catch(()=>console.warn('L5_OWNER_ALERT_UNDELIVERED')).finally(()=>this.alertWork.delete(work));
  }
  setHotDays(days=2){check(Number.isSafeInteger(days)&&days>=1,'INVALID_HOT_DAYS');this.hotDays=days;}
  setSessionFolding(enabled:boolean){this.sessionFolding=enabled;this.folding.enabled=enabled;}
  async prepareCapture(){await this.storage.prepareCapture?.();}
  /** Only the producer's publication wait detaches. The admitted original and its retry job remain durable. */
  waitPublished<T>(admitted:{key:string|string[];commit:Promise<T>},signal?:AbortSignal):Promise<T>{
    if(!signal)return admitted.commit;
    return new Promise<T>((resolve,reject)=>{
      const detached=()=>reject(new DurableCaptureDetached(admitted.key));
      if(signal.aborted){detached();return;}
      signal.addEventListener('abort',detached,{once:true});
      void admitted.commit.then(resolve,reject).finally(()=>signal.removeEventListener('abort',detached));
    });
  }
  private captureRef(c:Capture){if(c.kind==='original')return `l5:${digest({principal_id:c.trusted.principal_id,event_id:c.raw.event_id})}`;return c.kind==='unknown'?`l5-quarantine:${digest([c.trusted.principal_id,c.raw.event_id,c.chunk.track_id,c.chunk.stream_epoch,c.chunk.seq])}`:
    `l5:${digest({event_id:c.raw.event_id,principal_id:c.trusted.principal_id,device_id:c.raw.device_id})}`;}
  recover():Promise<void>{
    if(this.closing)return Promise.reject(new ContractError('RAW_ARCHIVE_CLOSED',503));
    return this.recovery??=(async()=>{
      const deleted=new Map<string,string[]>();
      for(const key of await this.storage.list('owner-deletions')){
        const intent=JSON.parse(Buffer.from(await this.storage.read('owner-deletions',key)).toString());
        const refs=deleted.get(intent.principal_id)??[];refs.push(intent.raw_ref??`l5:${key}`);deleted.set(intent.principal_id,refs);
      }
      for(const [principal,refs] of deleted)await this.deleteMany(refs,principal);
      for(const key of await this.storage.listHot?.('session-ends')??[])this.endingSessions.add(`l5:${key}`);
      await this.admission.recover();
    })().catch(error=>{this.recovery=undefined;throw error;});
  }
  finalizeSession(rawRef:string,endedBy='source_exhausted'){
    this.endingSessions.add(rawRef);
    return this.exclusively(async()=>{const final=await finalizeSession(this.storage,this.streams,rawRef,endedBy,this.sessionFolding);
      if(final||!this.sessionFolding)this.endingSessions.delete(rawRef);return final;});
  }
  /** Acquisition records only the end intent. The maintenance tick owns physical folding. */
  endSession(rawRef:string,endedBy='source_exhausted'){
    this.endingSessions.add(rawRef);
    // The existing original-write fence serializes this short fact; remote packing must not delay call/PTT closure.
    const end=finalizeSession(this.storage,this.streams,rawRef,endedBy,false);
    this.lifecycle=Promise.all([this.lifecycle,end]).catch(()=>undefined);return end;
  }
  async close(){this.closing=true;try{await Promise.allSettled([this.recovery]);await this.admission.close();}
    finally{this.foldResume?.();await this.foldWork;await this.lifecycle;await this.tierScan?.return(null);while(this.alertWork.size)await Promise.allSettled([...this.alertWork]);}}
  async admitStream(raw:RawEvent,trusted:TrustedContext,chunk:TrackChunk){
    ({raw,trusted,chunk}=structuredClone({raw,trusted,chunk}));const received_at=this.now();
    this.streams.validateInput(raw,trusted,received_at,chunk);
    const {payload,...metadata}=raw;
    const admitted=await this.admission.admit({kind:'stream',raw:metadata,trusted,chunk,received_at} satisfies Capture,payload);
    return {...admitted,commit:admitted.commit as Promise<Awaited<ReturnType<StreamArchive['append']>>>};
  }
  /** Group the durable I/O while retaining each original's identity, recovery and deletion record. */
  async admitStreamBatch(inputs:{raw:RawEvent;chunk:TrackChunk}[],trusted:TrustedContext,limit:{max_chunks:number;max_bytes:number}){
    ({inputs,trusted,limit}=structuredClone({inputs,trusted,limit}));
    check(Number.isSafeInteger(limit.max_chunks)&&limit.max_chunks>0&&limit.max_chunks<=64&&Number.isSafeInteger(limit.max_bytes)&&limit.max_bytes>0&&
      inputs.length>0&&inputs.length<=limit.max_chunks&&inputs.reduce((n,x)=>n+x.raw.payload.length,0)<=limit.max_bytes,'STREAM_BATCH_BUDGET',413);
    const first=inputs[0]!,received_at=this.now();
    check(inputs.every(x=>x.raw.event_id===first.raw.event_id&&x.raw.device_id===first.raw.device_id),'STREAM_BATCH_SOURCE_CONFLICT',403);
    for(const {raw,chunk} of inputs)this.streams.validateInput(raw,trusted,received_at,chunk);
    const admitted=await this.admission.admitMany(inputs.map(({raw,chunk})=>{
      const {payload,...metadata}=raw;return {record:{kind:'stream',raw:metadata,trusted,chunk,received_at} satisfies Capture,payload};
    }));
    const commit=Promise.all(admitted.map(x=>x.commit)) as Promise<Awaited<ReturnType<StreamArchive['appendBatch']>>>;
    void commit.catch(()=>{});return {key:admitted.map(x=>x.key),commit};
  }
  async admitUnknownClock(raw:UnknownClockRaw,trusted:TrustedContext,chunk:TrackChunk,binding:unknown){
    ({raw,trusted,chunk,binding}=structuredClone({raw,trusted,chunk,binding}));const received_at=this.now();
    validateUnknownClock(this.maxEventBytes,raw,trusted,chunk,binding,received_at);const {payload,...metadata}=raw;
    const admitted=await this.admission.admit({kind:'unknown',raw:metadata,trusted,chunk,binding,received_at} satisfies Capture,payload);
    return {...admitted,commit:admitted.commit as Promise<QuarantinedOriginal>};
  }
  async admitOriginal(raw:RawEvent,trusted:TrustedContext,sourceMetadata?:unknown){
    const {payload,...metadata}=structuredClone(raw);
    const admitted=await this.admission.admit({kind:'original',raw:metadata,trusted:structuredClone(trusted),received_at:this.now(),...(sourceMetadata===undefined?{}:{binding:structuredClone(sourceMetadata)})} satisfies Capture,payload);
    return {...admitted,commit:admitted.commit as Promise<ArchivedEvent>};
  }
  private commitCapture(c:Capture,payload:Uint8Array):Promise<CaptureResult>{
    check(['stream','unknown','original'].includes(c.kind),'RAW_INGRESS_CAPTURE_INVALID',500);
    if(c.kind==='original')return (async()=>{
      if(c.binding!==undefined){
        const bytes=Buffer.from(canonical(c.binding)),key=digest({principal_id:c.trusted.principal_id,event_id:c.raw.event_id});
        const saved=await this.storage.publish('original-source-metadata',key,bytes);
        check(Buffer.from(saved).equals(bytes),'EVENT_ID_PAYLOAD_CONFLICT',409);
      }
      return this.archive({...c.raw,payload} as RawEvent,c.trusted);
    })();
    if(c.kind==='stream')return this.streams.append({...c.raw,payload} as RawEvent,c.trusted,c.received_at,c.chunk);
    const work=()=>publishUnknownClock(this.storage,this.maxEventBytes,{...c.raw,payload} as UnknownClockRaw,c.trusted,c.chunk,c.binding,c.received_at);
    return this.storage.withOriginalWrite?this.storage.withOriginalWrite(work):work();
  }
  archiveUnknownClock(raw:UnknownClockRaw,trusted:TrustedContext,chunk:TrackChunk,binding:unknown):Promise<QuarantinedOriginal> {
    ({raw,trusted,chunk,binding}=structuredClone({raw,trusted,chunk,binding}));
    const work=()=>publishUnknownClock(this.storage,this.maxEventBytes,raw,trusted,chunk,binding,this.now());
    return this.storage.withOriginalWrite?this.storage.withOriginalWrite(work):work();
  }
  readUnknownClock(ref:string,principal:string,revision:string,maxReadBytes?:number) {
    return readUnknownClock(this.storage,this.maxEventBytes,ref,principal,revision,maxReadBytes);
  }
  async archive(raw: RawEvent, trusted: TrustedContext): Promise<ArchivedEvent> {
    ({raw,trusted}=structuredClone({raw,trusted}));
    return this.storage.withOriginalWrite?this.storage.withOriginalWrite(()=>this.archiveOwned(raw,trusted)):this.archiveOwned(raw,trusted);
  }
  private async archiveOwned(raw:RawEvent,trusted:TrustedContext):Promise<ArchivedEvent>{
    check(raw.payload.byteLength <= this.maxEventBytes, 'EVENT_TOO_LARGE', 413);
    const event = bindRaw(raw, trusted, this.now());
    const payloadHash = sha256(raw.payload);
    // received_at is transport metadata; a retry must not create a new logical event.
    const {received_at: _received, ...sourceMetadata} = event;
    const fingerprint = digest({event: sourceMetadata, payload_sha256: payloadHash});
    const key = digest({principal_id: trusted.principal_id, event_id: raw.event_id});
    await requireRawAvailable(this.storage,`l5:${key}`);
    const object = await this.storage.publish('objects', payloadHash, raw.payload);
    check(sha256(object) === payloadHash, 'ARCHIVE_OBJECT_INTEGRITY_FAILURE', 500);
    const proposed: Manifest = {schema_version: 'paios.archive.v1', event, fingerprint,
      payload_sha256: payloadHash, bytes: raw.payload.byteLength, archive_revision: fingerprint};
    const stored = await this.storage.publish('manifests', key, Buffer.from(canonical(proposed)));
    const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(stored)) as Manifest;
    check(manifest.schema_version === 'paios.archive.v1' && manifest.event.principal_id === trusted.principal_id,
      'ARCHIVE_MANIFEST_INVALID', 500);
    // A transport may enrich a retry with the device's newer fix. The winning archive owns the capture's place;
    // payload and every other source/identity field still have to match that immutable original.
    const {location: _retryLocation, ...sourceIdentity} = event.source;
    const replayMetadata = {...sourceMetadata, source: {...sourceIdentity,
      ...(manifest.event.source.location === undefined ? {} : {location: manifest.event.source.location})}};
    check(manifest.fingerprint === digest({event: replayMetadata, payload_sha256: payloadHash}),
      'EVENT_ID_PAYLOAD_CONFLICT', 409);
    return {...manifest.event, raw_ref: `l5:${key}`, archive_status: 'durable',
      archive_revision: manifest.archive_revision, payload_sha256: manifest.payload_sha256, bytes: manifest.bytes};
  }
  readStreamHeader(event:ArchivedEvent){return this.streams.readHeader(event);}
  private sourceMetadata(namespace:string,key:string,bytes:Uint8Array){
    const record=JSON.parse(Buffer.from(bytes).toString());
    if(namespace==='stream-revisions'){
      check(['paios.stream.delta.v2','paios.stream.v1'].includes(record.schema),'ARCHIVE_TIER_METADATA_INVALID',500);
      if(record.schema==='paios.stream.delta.v2')return {ref:record.raw_ref as string,received:record.chunk.received_at as string,
        objects:[{hash:record.chunk.object_hash as string,format:record.chunk.format as string}]};
      return {ref:record.raw_ref as string,received:record.event.received_at as string,
        objects:(record.chunks as StoredChunk[]).map(c=>({hash:c.object_hash,format:c.format}))};
    }
    if(namespace==='manifests'){check(record.schema_version==='paios.archive.v1','ARCHIVE_TIER_METADATA_INVALID',500);
      return {ref:`l5:${key}`,received:record.event.received_at as string,objects:[{hash:record.payload_sha256 as string,format:undefined}]};}
    check(namespace==='quarantine-manifests'&&record.schema==='paios.unknown-clock-original.v1','ARCHIVE_TIER_METADATA_INVALID',500);
    return {ref:record.quarantine_ref as string,group:`quarantine:${digest([record.event.principal_id,record.event.device_id,record.event.event_id])}`,
      received:record.event.received_at as string,objects:[{hash:record.payload_sha256 as string,format:record.chunk.format as string}]};
  }
  /** Physical tiers preserve every namespace/key and the immutable archive proofs. No clock or media reclassification. */
  packingSnapshot(){const cold=(this.storage as PosixStorage).cold?.snapshot();
    return {...cold,active:cold?.active??0,queued:cold?.queued??0,folding:this.maintenanceSnapshot(),
      tiering:{paused:this.tierPaused,backlog:{...this.backlog},progress:{...this.tierProgress},
        scope:'physical immutable archive files; sampled during the resumable sweep; SQLite and mutable registries excluded'}};}
  maintenanceSnapshot(){return {...this.folding,discovery:{...this.folding.discovery},files_scope:'tracked loose records in pending folds; refreshed between sessions'};}
  private foldCheckpoint=async()=>{
    await new Promise<void>(resolve=>setImmediate(resolve));
    while(!this.closing&&(this.maintenanceBusy()||performance.now()>=this.maintenanceDeadline)){
      this.folding.phase='yielded';
      const gate=Promise.withResolvers<void>();this.foldResume=()=>gate.resolve();this.foldPaused.resolve();await gate.promise;
    }
    if(this.closing)throw new MaintenanceClosed();
  };
  /** One resumable sweep on the existing maintenance clock; durable intents remain the recovery authority. */
  private async foldSessions(now:number){
    this.folding.phase='discovering';
    if(!this.legacyDiscovered){
      await discoverSessionRecords(this.storage,this.foldCheckpoint,state=>{this.folding.discovery=state;});
      this.legacyDiscovered=true;
    }
    const refs=new Set([...(await this.storage.pendingFinals?.()??[]),...(await this.storage.listHot?.('session-ends')??[]).map(k=>`l5:${k}`)]);
    const candidates:{ref:string;at:number;files:number;idle:boolean}[]=[];
    for(const ref of await this.storage.activeSessionRefs?.()??[]){await this.foldCheckpoint();refs.add(ref);}
    for(const ref of refs){
      await this.foldCheckpoint();let at:number,idle=false;
      try{at=await this.storage.modifiedAt!('session-ends',ref.slice(3));}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        const final=await this.storage.readFinal?.(ref);
        if(final)at=0;
        else{const head=await this.streams.head(ref,{checkpoint:this.foldCheckpoint});if(!head)continue;
          at=head.chunks.reduce((latest,c)=>Math.max(latest,Date.parse(c.received_at)),-Infinity);if(at>now-30*60000)continue;idle=true;}}
      candidates.push({ref,at,files:await this.storage.sessionRecordCount?.(ref)??0,idle});
    }
    candidates.sort((a,b)=>a.at-b.at||a.ref.localeCompare(b.ref));
    this.folding.sessions_remaining=candidates.length;this.folding.files_remaining=candidates.reduce((n,c)=>n+c.files,0);
    this.folding.observed_at=new Date(now).toISOString();
    for(const candidate of candidates){
      await this.foldCheckpoint();this.folding.phase='folding';this.folding.active_raw_ref=candidate.ref;
      try{
        const final=await finalizeSession(this.storage,this.streams,candidate.ref,'idle_timeout',true,
          {checkpoint:this.foldCheckpoint,...(candidate.idle?{idle_before:now-30*60000}:{})});
        if(final){this.folding.completed++;this.folding.sessions_remaining--;this.folding.files_remaining-=candidate.files;this.endingSessions.delete(candidate.ref);}
      }catch(error){if(error instanceof MaintenanceClosed)throw error;
        this.folding.last_error=`${candidate.ref}: ${error instanceof Error?error.message:String(error)}`;this.notify('L5_SESSION_FOLD_FAILED');}
    }
    this.folding.active_raw_ref=null;this.folding.phase='idle';
  }
  maintenance(hotDays=this.hotDays,now=Date.now(),upload:TierUploadPolicy={}){
    return this.exclusively(async()=>{
      this.setHotDays(hotDays);const started=performance.now(),budget=upload.budget_ms??55000,deadline=started+budget;
      // The existing minute clock works throughout idle time. Discovery gets a bounded share, then evacuation runs.
      this.maintenanceDeadline=started+((this.storage as PosixStorage).cold?Math.min(5000,budget*0.1):budget);
      this.maintenanceBusy=upload.busy??(()=>false);
      this.tierPaused=upload.paused??false;
      if(this.closing||this.tierPaused||this.maintenanceBusy())return;
      if(this.sessionFolding){
        this.foldPaused=Promise.withResolvers<void>();
        if(!this.foldWork)this.foldWork=this.foldSessions(now).catch(error=>{
          if(!(error instanceof MaintenanceClosed)){this.folding.last_error=error instanceof Error?error.message:String(error);this.notify('L5_SESSION_FOLD_FAILED');}
        }).finally(()=>{this.foldWork=undefined;this.foldResume=undefined;});
        else{this.foldResume?.();this.foldResume=undefined;}
        await Promise.race([this.foldWork,this.foldPaused.promise]);
      }
      if((this.storage as PosixStorage).cold&&!this.maintenanceBusy()&&performance.now()<deadline){
        await this.moveColdOwned({...upload,budget_ms:deadline-performance.now()},now);
      }
      if(this.backlog.old_records)this.notify('L5_TIERING_BACKLOG');
      if((this.storage as PosixStorage).cold)console.info('L5_TIERING_STATUS',JSON.stringify(this.packingSnapshot().tiering));
    }).catch(error=>{this.tierFailure(error);throw error;});
  }
  async moveCold(hotDays=2,now=Date.now(),upload:TierUploadPolicy={}):Promise<{segments:number;hot_bytes:number;cold_bytes:number}>{
    this.setHotDays(hotDays);return this.exclusively(async()=>{const result=await this.moveColdOwned(upload);
      await this.evictCold(now,false);return result;}).catch(error=>{this.tierFailure(error);throw error;});
  }
  private tierFailure(error:unknown){this.notify('L5_TIERING_UNAVAILABLE');
    if(error instanceof Error&&/^COLD_.*(?:INTEGRITY|INVALID|TRUNCATED)$/u.test(error.message))this.notify('L5_COLD_VERIFICATION_FAILED');}
  private async *coldCandidates():AsyncGenerator<TierRecord|null>{
    // A bounded physical sweep reports all backlog, including records blocked by a live session owner.
    const sweep:TierBacklog={hot_records:0,hot_bytes:0,old_records:0,old_bytes:0,oversized_records:0,oldest_hot_record:null,observed_at:null,complete:false};
    const before=Date.now()-this.hotDays*86400000;let oldest=Infinity;
    for(const namespace of TIER_NAMESPACES)for await(const entry of (this.storage as PosixStorage).hotEntries(namespace)){
      sweep.hot_records++;sweep.hot_bytes+=entry.size;
      if(entry.modified<before){sweep.old_records++;sweep.old_bytes+=entry.size;}
      if(entry.size>64*1024*1024)sweep.oversized_records++;
      if(entry.modified<oldest){oldest=entry.modified;sweep.oldest_hot_record={namespace,key:entry.key,modified_at:new Date(oldest).toISOString()};}
      sweep.observed_at=new Date().toISOString();this.backlog={...sweep};yield null;
    }
    this.backlog={...sweep,complete:true};
    // Prefer a final's declared codec. Loose immutable proofs also tier, including unresolved historical leaves.
    for await(const key of this.storage.hotKeys!('session-finals')){
      if(await (this.storage as PosixStorage).cold?.contains('session-finals',key)){yield null;continue;}
      const final=await this.storage.readFinal!(`l5:${key}`);check(final,'SESSION_FINAL_REQUIRED',500);
      if(await this.storage.hasLiveSessionOwner?.({namespace:'objects',key:final.object_hash})){yield null;continue;}
      // Referenced originals precede metadata so a paused upload cannot strand an unpacked object.
      yield {namespace:'objects',key:final.object_hash};
      for(const object of final.retained_objects??[])yield {namespace:'objects',key:object.key,format:object.format};
      // Bounded folds leave overflow and later processing proofs at their original keys in the same owner ledger.
      for(const record of await this.storage.sessionRecords?.(final.raw_ref,true)??[])yield record;
      // The existing rollback readers cap a decoded cold object at 64 MiB; SQLite still owns oversized metadata.
      if(await this.storage.hotSize!('session-finals',key)<=64*1024*1024)yield {namespace:'session-finals',key};
    }
    for(const namespace of TIER_NAMESPACES)for await(const entry of (this.storage as PosixStorage).hotEntries(namespace)){
      if(entry.size>64*1024*1024){yield null;continue;}
      // Pre-ledger journals still prove their live ownership through the producer's original-object edges.
      if(namespace==='stream-revisions'&&!await this.storage.hasSessionRecord?.({namespace,key:entry.key}))try{
        const source=this.sourceMetadata(namespace,entry.key,await (this.storage as PosixStorage).readHot(namespace,entry.key));
        let live=false;for(const object of source.objects)if(await this.storage.hasLiveSessionOwner?.({namespace:'objects',key:object.hash})){live=true;break;}
        if(live){yield null;continue;}
      }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      yield {namespace,key:entry.key,size:entry.size,modified:entry.modified};
    }
  }
  private async moveColdOwned(upload:TierUploadPolicy,evictAt?:number){
    check(this.storage.moveCold&&this.storage.hotKeys&&this.storage.hotSize&&this.storage.modifiedAt,'COLD_STORAGE_NOT_CONFIGURED',503);
    const cold=(this.storage as PosixStorage).cold,scan=this.tierScan??=this.coldCandidates();
    let segments=0,hot_bytes=0,cold_bytes=0,finished=false;const deadline=performance.now()+(upload.budget_ms??5000);
    const evictedPacks=new Set<string>();
    const yielded=()=>this.closing||!!upload.paused||!!upload.busy?.()||performance.now()>=deadline;
    const gate=()=>{if(this.closing||upload.paused||upload.busy?.())throw new TierUploadDeferred();};
    const pace=async(bytes:number)=>{
      gate();if(!upload.max_upload_kbps)return;
      this.nextUploadAt=Math.max(performance.now(),this.nextUploadAt)+bytes*8/upload.max_upload_kbps;
      for(;;){const remaining=this.nextUploadAt-performance.now();if(remaining<=0)break;
        await sleep(Math.min(50,remaining));gate();}
    };
    try{
      if(evictAt!==undefined)await this.evictCold(evictAt,false,0,yielded);
      // 3072 items keep the existing 1-MiB decoded header contract. No new pack format or index migration.
      // Pending bytes survive realtime yields; after restart, verified locations are the resume authority.
      while(!finished&&!yielded()){
        const records=this.tierPending,ids=new Set(records.map(r=>`${r.namespace}:${r.key}`));let size=records.reduce((n,r)=>n+r.bytes.length,0);
        while(records.length<3072&&size<16*1024*1024&&!yielded()){
          const batch:TierRecord[]=[];let planned=size;
          while(batch.length<8&&records.length+batch.length<3072&&!yielded()){
            if(!this.tierNext){const next=await scan.next();
              if(next.done){finished=true;this.tierScan=undefined;break;}
              if(!next.value)continue;this.tierNext=next.value;}
            const record=this.tierNext,id=`${record.namespace}:${record.key}`;
            if(ids.has(id)||await this.storage.hasLiveSessionOwner?.(record)){this.tierNext=undefined;continue;}
            const location=(await cold?.locations([record]))?.[0];
            if(location){
              // Hot discovery, not the size of cold history, determines the age-to-eviction delay.
              if(evictAt!==undefined&&!evictedPacks.has(location.pack))try{
                if((record.modified??await this.storage.modifiedAt!(record.namespace,record.key))<evictAt-this.hotDays*86400000){
                  evictedPacks.add(location.pack);this.evictionPack=location.pack;await this.evictCold(evictAt,false,0,yielded);
                }
              }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
              this.tierNext=undefined;continue;
            }
            try{
              const next=record.size??await this.storage.hotSize!(record.namespace,record.key);check(next<=64*1024*1024,'COLD_SEGMENT_LIMIT');
              if((records.length||batch.length)&&planned+next>16*1024*1024)break;
              batch.push(record);ids.add(id);planned+=next;
            }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
            this.tierNext=undefined;if(planned>=16*1024*1024)break;
          }
          const physical=batch.filter(r=>r.namespace!=='session-finals'),data=await (this.storage as PosixStorage).readHotMany(physical);let offset=0;
          for(const record of batch){const bytes=record.namespace==='session-finals'?await this.storage.read(record.namespace,record.key):data[offset++];
            if(bytes){records.push({namespace:record.namespace,key:record.key,...(record.format?{format:record.format}:{}),bytes});size+=bytes.length;}}
          if(finished||this.tierNext||!batch.length)break;
        }
        if(records.length){gate();const receipt=await this.storage.moveCold(records,gate,pace);
          segments++;hot_bytes+=size;cold_bytes+=receipt.bytes;this.tierProgress.verified_records+=records.length;
          this.tierProgress.hot_bytes+=size;this.tierProgress.cold_bytes+=receipt.bytes;this.tierPending=[];
          this.evictionPack=receipt.pack;
          if(evictAt!==undefined)await this.evictCold(evictAt,false,0,yielded);}
      }
      return {segments,hot_bytes,cold_bytes};
    }catch(error){
      if(error instanceof TierUploadDeferred)return {segments,hot_bytes,cold_bytes};
      await this.tierScan?.return(null);this.tierScan=undefined;this.tierNext=undefined;this.tierPending=[];throw error;}
  }
  private async evictCold(now:number,emergency:boolean,pendingBytes=0,yieldWork=()=>false){
    const disk=this.storage as PosixStorage,cold=disk.cold;if(!cold)return 0;
    const before=now-this.hotDays*86400000;let freed=0;
    const preferred=this.evictionPack;
    let packs=preferred?[{key:preferred}]:await cold.packs(true,this.evictionAfter,8);
    if(!preferred&&packs.length===0&&this.evictionAfter){this.evictionAfter='';packs=await cold.packs(true,'',8);}
    for(const pack of packs){
      if(yieldWork())break;
      if(emergency&&await disk.reserveFits(pendingBytes))break;
      const selection=[];
      for(const record of await cold.locations(undefined,pack.key)){
        try{const modified=await disk.modifiedAt(record.namespace,record.key);if(emergency||modified<before)selection.push(record);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      let verified:Awaited<ReturnType<typeof cold.verifiedRecords>>;
      try{verified=await cold.verifiedRecords(selection);}
      catch(error){this.notify('L5_COLD_VERIFICATION_FAILED');throw new AggregateError([error],'L5_COLD_VERIFICATION_FAILED');}
      // Raise the owner notice before crossing the configured hot window, outside the original-write fence.
      if(emergency&&verified.length)await this.alert('L5_HOT_WINDOW_EMERGENCY');
      const batchSize=emergency?1:64;
      for(let offset=0;offset<verified.length;offset+=batchSize){
        if(yieldWork())return freed;
        const remove=async()=>{
          if(emergency&&await disk.reserveFits(pendingBytes))return false;
          const batch=verified.slice(offset,offset+batchSize),current=new Map((await cold.locations(batch)).map(r=>[`${r.namespace}:${r.key}`,r]));
          const ingress=new Set<string>();
          if(batch.some(r=>r.namespace==='objects'))for(const key of await disk.listHot('raw-ingress')){
            const input=JSON.parse(Buffer.from(await disk.readHot('raw-ingress',key)).toString());ingress.add(input.object_hash);}
          const eligible=[];
          for(const record of batch){const location=current.get(`${record.namespace}:${record.key}`);
            if(!location||location.pack!==record.pack||location.hash!==record.hash||location.size!==record.size)continue;
            if(await disk.hasLiveSessionOwner(record)||record.namespace==='objects'&&ingress.has(record.key))continue;
            try{if(emergency||await disk.modifiedAt(record.namespace,record.key)<before)eligible.push(record);}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
          // A missing hot name never starts a remote read under the original-write fence.
          const data=await disk.readHotMany(eligible),removals=[];let bytes=0;
          for(let n=0;n<eligible.length;n++){const record=eligible[n]!,value=data[n];if(!value)continue;
            check(value.length===record.size&&sha256(value)===record.hash,'HOT_EVICTION_CONFLICT',500);
            removals.push(record);bytes+=value.length;}
          await disk.removeOriginals(removals);freed+=bytes;
          this.tierProgress.evicted_records+=removals.length;this.tierProgress.evicted_bytes+=bytes;
          return !emergency||!await disk.reserveFits(pendingBytes);
        };
        if(!await disk.withOriginalWrite(remove))return freed;
      }
      if(preferred)this.evictionPack=undefined;else this.evictionAfter=pack.key;
    }
    if(emergency&&preferred&&!this.evictionPack&&!await disk.reserveFits(pendingBytes))
      freed+=await this.evictCold(now,true,pendingBytes,yieldWork);
    return freed;
  }
  readExactChunk(event:ArchivedEvent,chunk:TrackChunk,maxBytes:number){return this.streams.readExactChunk(event,chunk,maxBytes);}
  async bindCallTrack(rawRef:string,group:CallAudioTrack):Promise<void>{
    check(this.storage.bindCallTrack,'CALL_TRACK_STORAGE_REQUIRED',503);
    await this.storage.bindCallTrack(rawRef,group);
  }
  readCallBindings(callId:string,principalId:string):Promise<{raw_ref:string;track:CallAudioTrack['track'];finalized:boolean}[]>{
    check(this.storage.callTracks,'CALL_TRACK_STORAGE_REQUIRED',503);
    return this.storage.callTracks(callId,principalId);
  }
  async readCallTracks(callId:string,principalId:string):Promise<{raw_ref:string;track:CallAudioTrack['track'];event:ArchivedEvent;finalized:boolean}[]>{
    const result:{raw_ref:string;track:CallAudioTrack['track'];event:ArchivedEvent;finalized:boolean}[]=[];
    for(const record of await this.readCallBindings(callId,principalId)){
      let event:ArchivedEvent;
      try{event=await this.locate(record.raw_ref,principalId);}
      catch(error){if(error instanceof ContractError&&error.message==='RAW_REF_NOT_FOUND')continue;throw error;}
      if(event.bytes>0)result.push({...record,event});
    }
    return result;
  }
  async read(rawRef: string, principalId: string, revision: string): Promise<Uint8Array> {
    const record=await this.readRecord(rawRef,principalId,revision);
    check(record.kind==='original','STREAM_REQUIRES_RECORD_READ',409);
    return record.bytes;
  }
  /** Explicit-reference metadata lookup. Payload I/O belongs to the caller's selected, bounded read. */
  async locate(rawRef:string,principalId:string):Promise<ArchivedEvent> {
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef),'INVALID_RAW_REF');
    await requireRawAvailable(this.storage,rawRef);
    const event=await this.locateMetadata(rawRef,principalId);
    await requireRawAvailable(this.storage,rawRef);
    return event;
  }
  async readRecord(rawRef:string,principalId:string,revision:string,options:StreamReadOptions={}):Promise<ArchiveRecord> {
    options = structuredClone(options);
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef), 'INVALID_RAW_REF');
    await requireRawAvailable(this.storage,rawRef);
    let stored:Uint8Array;
    try {stored=await this.storage.read('manifests',rawRef.slice(3));}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      const stream=await this.streams.readRecord(rawRef,principalId,revision,options);
      return {...stream,kind:'stream',event:stream.manifest.event,archive_revision:revision};
    }
    const manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stored)) as Manifest;
    check(manifest.event.principal_id === principalId, 'RAW_ACCESS_DENIED', 403);
    check(manifest.archive_revision === revision, 'ARCHIVE_REVISION_CONFLICT', 409);
    check(options.source_range === undefined && options.track_ids === undefined, 'ORIGINAL_SELECTION_UNSUPPORTED');
    const {received_at:_received,...sourceMetadata}=manifest.event;
    check(manifest.schema_version==='paios.archive.v1'&&manifest.fingerprint===revision&&
      digest({event:sourceMetadata,payload_sha256:manifest.payload_sha256})===revision&&
      rawRef===`l5:${digest({principal_id:principalId,event_id:manifest.event.event_id})}`,'ARCHIVE_MANIFEST_INVALID',500);
    this.validateOriginalBytes(manifest);
    const limit=options.maxReadBytes??this.maxEventBytes;
    check(Number.isSafeInteger(limit)&&limit>0,'INVALID_READ_BUDGET');
    check(manifest.bytes<=limit,'RAW_READ_BUDGET_EXCEEDED',413);
    const bytes = options.proof_only?new Uint8Array():await this.storage.read('objects', manifest.payload_sha256);
    check(options.proof_only||bytes.byteLength === manifest.bytes && sha256(bytes) === manifest.payload_sha256,
      'ARCHIVE_OBJECT_INTEGRITY_FAILURE', 500);
    return {kind:'original',event:manifest.event,bytes,archive_revision:revision,
      payload_sha256:manifest.payload_sha256,total_bytes:manifest.bytes,selected_bytes:bytes.length};
  }
  async delete(rawRef:string,principal:string):Promise<{status:'deleted'}>{return this.deleteMany([rawRef],principal);}
  /** Exact owner-confirmed references only. Tombstones survive crashes; shared payloads survive other owners' deletion. */
  async deleteMany(rawRefs:string[],principal:string):Promise<{status:'deleted'}>{
    return this.exclusively(()=>this.storage.withOriginalWrite?this.storage.withOriginalWrite(()=>this.deleteManyOwned(rawRefs,principal)):this.deleteManyOwned(rawRefs,principal));
  }
  private async deleteManyOwned(rawRefs:string[],principal:string):Promise<{status:'deleted'}>{
    check(this.storage.removeOriginals,'OWNER_DELETE_NOT_CONFIGURED',503);
    // A realtime yield may hold an uncommitted pack. Deletion retires that scan before changing its sources.
    await this.tierScan?.return(null);this.tierScan=undefined;this.tierNext=undefined;this.tierPending=[];
    const targets=new Set(rawRefs),objects=new Set<string>(),preserved=new Set<string>(),remove:Pick<ColdRecord,'namespace'|'key'>[]=[];
    const transcripts:{raw_ref:string;key:string}[]=[];
    for(const key of await this.storage.list('voice-transcripts')){
      const record=JSON.parse(Buffer.from(await this.storage.read('voice-transcripts',key)).toString());
      check(record.schema==='paios.voice-transcript.v1'&&record.candidate_ref===`voice-candidate:${key}`,'VOICE_CANDIDATE_CONFLICT',500);
      transcripts.push({raw_ref:record.raw_ref,key});
    }
    const derivations=new Map<string,{raw_ref:string;hashes:string[]}>();
    for(const namespace of ['derivation-attempts','derived-manifests'])for(const key of await this.storage.list(namespace)){
      const record=JSON.parse(Buffer.from(await this.storage.read(namespace,key)).toString()) as DerivedManifest;
      const prior=derivations.get(key);check(!prior||prior.raw_ref===record.raw_ref,'DERIVATION_SOURCE_MISMATCH',500);
      derivations.set(key,{raw_ref:record.raw_ref,hashes:record.chunks?.map(chunk=>chunk.object_hash)??prior?.hashes??[]});
    }
    const pending=[];for(const key of await this.storage.list('raw-ingress')){
      const bytes=await this.storage.read('raw-ingress',key),input=JSON.parse(Buffer.from(bytes).toString()),c=input.record as Capture;
      check(input.schema==='paios.raw-ingress.v1'&&sha256(bytes)===key&&/^[a-f0-9]{64}$/u.test(input.object_hash),'RAW_INGRESS_METADATA_INVALID',500);
      const ref=this.captureRef(c);if(targets.has(ref))check(c.trusted.principal_id===principal,'RAW_ACCESS_DENIED',403);
      pending.push({key,ref,hash:input.object_hash as string});
    }
    for(const ref of targets){check(/^l5(?:-quarantine)?:[a-f0-9]{64}$/u.test(ref),'INVALID_RAW_REF');const key=ref.slice(ref.indexOf(':')+1);let intent:{principal_id:string;raw_ref?:string;objects:string[];derivations?:string[];records?:TierRecord[]};
      try{intent=JSON.parse(Buffer.from(await this.storage.read('owner-deletions',key)).toString());}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        let hashes:string[]=[];
        try{if(ref.startsWith('l5-quarantine:')){
          const manifest=JSON.parse(Buffer.from(await this.storage.read('quarantine-manifests',key)).toString()) as QuarantinedOriginal;
          const {receipt}=await readUnknownClock(this.storage,this.maxEventBytes,ref,principal,manifest.archive_revision,this.maxEventBytes,true);hashes=[receipt.payload_sha256];
        }else{const event=await this.locateMetadata(ref,principal),record=await this.readRecord(ref,principal,event.archive_revision,{proof_only:true});
          hashes=record.kind==='stream'?record.manifest.chunks.map(c=>c.object_hash):[record.payload_sha256];}}
        catch(error){if(!pending.some(p=>p.ref===ref)||!((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof ContractError&&error.code==='RAW_REF_NOT_FOUND'))throw error;}
        const final=ref.startsWith('l5:')?await this.storage.readFinal?.(ref):null;
        if(final)hashes.push(final.object_hash,...final.objects.map(o=>o.key),...final.retained_objects?.map(o=>o.key)??[]);
        intent={principal_id:principal,raw_ref:ref,objects:[...new Set([...hashes,...pending.filter(p=>p.ref===ref).map(p=>p.hash)])]};
        const bytes=Buffer.from(canonical(intent));
        if(this.storage.publishIngressMeta)await this.storage.publishIngressMeta('owner-deletions',key,bytes);else await this.storage.publish('owner-deletions',key,bytes);}
      check(intent.principal_id===principal&&(!intent.raw_ref||intent.raw_ref===ref),'RAW_ACCESS_DENIED',403);
      const final=ref.startsWith('l5:')?await this.storage.readFinal?.(ref):null;
      const owned=[...derivations].filter(([,d])=>d.raw_ref===ref),derivedHashes=owned.flatMap(([,d])=>d.hashes);
      const keys=[...new Set([...(intent.derivations??[]),...owned.map(([key])=>key)])];
      const tracked=ref.startsWith('l5:')?await this.storage.sessionRecords?.(ref)??[]:[];
      const records=[...new Map([...(intent.records??[]),...final?.records??[],...tracked,
        ...transcripts.filter(t=>t.raw_ref===ref).map(({key})=>({namespace:'voice-transcripts',key}))].filter(r=>r.namespace!=='objects')
        .map(({namespace,key})=>[`${namespace}:${key}`,{namespace,key}])).values()];
      const hashes=[...new Set([...intent.objects,...derivedHashes,...tracked.filter(r=>r.namespace==='objects').map(r=>r.key),...(final?[final.object_hash,...final.objects.map(o=>o.key),...final.retained_objects?.map(o=>o.key)??[]]:[])])];
      if(hashes.length!==intent.objects.length||keys.length!==(intent.derivations?.length??0)||records.length!==(intent.records?.length??0)){
        check(this.storage.replace,'OWNER_DELETE_INTENT_UPDATE_NOT_CONFIGURED',503);
        intent={...intent,objects:hashes,derivations:keys,records};await this.storage.replace('owner-deletions',key,Buffer.from(canonical(intent)));}
      for(const hash of intent.objects)objects.add(hash);
      for(const key of intent.derivations??[])remove.push(...['derived-manifests','derivation-attempts','derivation-settlements'].map(namespace=>({namespace,key})));
      remove.push(...intent.records??[]);
    }
    const deleted=new Set<string>();for(const key of await this.storage.list('owner-deletions')){
      const intent=JSON.parse(Buffer.from(await this.storage.read('owner-deletions',key)).toString());deleted.add(intent.raw_ref??`l5:${key}`);}
    const liveRefs=new Set<string>(),sharedRecords=new Set<string>(),removedFinals:FinalSession[]=[];
    this.admission.cancel(record=>targets.has(this.captureRef(record as Capture)));
    for(const derived of derivations.values()){
      if(!deleted.has(derived.raw_ref))for(const hash of derived.hashes)preserved.add(hash);
    }
    for(const namespace of ['manifests','stream-revisions','quarantine-manifests'])for(const key of await this.storage.list(namespace)){
      const record=this.sourceMetadata(namespace,key,await this.storage.read(namespace,key)),{ref}=record;
      if(ref&&targets.has(ref)){remove.push({namespace,key});continue;}if(ref&&deleted.has(ref))continue;
      if(ref?.startsWith('l5:'))liveRefs.add(ref);
      for(const {hash} of record.objects)preserved.add(hash);
    }
    for(const key of await this.storage.list('session-finals')){
      const final=JSON.parse(Buffer.from(await this.storage.read('session-finals',key)).toString()) as FinalSession;
      if(targets.has(final.raw_ref)){
        removedFinals.push(final);
        // A finite original or decoded source may still use a slice routed through this container.
        for(const object of final.objects)if(preserved.has(object.key)){
          const bytes=await this.storage.read('objects',object.key);check(sha256(bytes)===object.key,'SESSION_FINAL_RANGE_FAILED',500);
          await this.storage.publish('objects',object.key,bytes);
        }
        remove.push({namespace:'session-finals',key},{namespace:'session-ends',key},...final.records.map(({namespace,key})=>({namespace,key})));
        continue;
      }
      if(deleted.has(final.raw_ref))continue;
      liveRefs.add(final.raw_ref);for(const record of final.records)sharedRecords.add(`${record.namespace}:${record.key}`);
      preserved.add(final.object_hash);for(const object of final.retained_objects??[])preserved.add(object.key);
    }
    for(const input of pending){if(targets.has(input.ref))remove.push({namespace:'raw-ingress',key:input.key});else preserved.add(input.hash);}
    for(const ref of liveRefs)for(const record of await this.storage.sessionRecords?.(ref)??[])sharedRecords.add(`${record.namespace}:${record.key}`);
    // Legacy peers may not yet have an owner ledger. Their durable route still owns its shared span.
    for(const key of await this.storage.list('audio-consumer-routes')){
      const route=JSON.parse(Buffer.from(await this.storage.read('audio-consumer-routes',key)).toString());
      if(!liveRefs.has(route.raw_ref)||deleted.has(route.raw_ref))continue;
      check(key===digest([route.principal_id,route.device_id,route.raw_ref]),'AUDIO_ROUTE_CONFLICT',409);
      sharedRecords.add(`audio-consumer-spans:${digest([route.principal_id,route.device_id,route.source_scope,route.capture_span])}`);
    }
    for(const final of removedFinals)for(const record of final.records)if(sharedRecords.has(`${record.namespace}:${record.key}`)){
      check(this.storage.publishRestored,'OWNER_DELETE_SHARED_RECORD_PUBLICATION_REQUIRED',503);
      await this.storage.publishRestored(record.namespace,record.key,await this.storage.read(record.namespace,record.key));
    }
    for(const hash of preserved)objects.delete(hash);
    remove.push(...[...objects].map(key=>({namespace:'objects',key})),...rawRefs.filter(ref=>ref.startsWith('l5:')).map(ref=>({namespace:'session-ends',key:ref.slice(3)})));
    const exclusive=remove.filter(record=>!sharedRecords.has(`${record.namespace}:${record.key}`));
    await this.notifyRemoval(principal,targets);
    await this.removeColdRecords(exclusive);await this.storage.removeSessions?.([...targets].filter(ref=>ref.startsWith('l5:')));await this.storage.removeOriginals(exclusive);return {status:'deleted'};
  }
  private validateOriginalBytes(manifest:Manifest):void {
    check(Number.isSafeInteger(manifest.bytes)&&(manifest.bytes>0||manifest.bytes===0&&
      manifest.event.media_type==='text'&&manifest.event.device_type==='mac'&&
      manifest.event.origin==='explicit_user_prompt'&&Boolean(manifest.event.attachments?.length))&&manifest.bytes<=this.maxEventBytes,'EVENT_TOO_LARGE',413);
  }
  private async locateMetadata(ref:string,principal:string):Promise<ArchivedEvent>{
    try{const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await this.storage.read('manifests',ref.slice(3)))) as Manifest;
      const {received_at:_received,...metadata}=m.event;
      check(m.event.principal_id===principal,'RAW_ACCESS_DENIED',403);
      check(m.schema_version==='paios.archive.v1'&&m.fingerprint===m.archive_revision&&digest({event:metadata,payload_sha256:m.payload_sha256})===m.archive_revision&&
        ref===`l5:${digest({principal_id:principal,event_id:m.event.event_id})}`,'ARCHIVE_MANIFEST_INVALID',500);
      this.validateOriginalBytes(m);
      return {...m.event,raw_ref:ref,archive_revision:m.archive_revision,archive_status:'durable',payload_sha256:m.payload_sha256,bytes:m.bytes};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const head=await this.streams.head(ref);check(head,'RAW_REF_NOT_FOUND',404);check(head.event.principal_id===principal,'RAW_ACCESS_DENIED',403);
    const revision=streamManifestRevision(head),record=await this.streams.readRecord(ref,principal,revision,{proof_only:true});
    return {...record.manifest.event,raw_ref:ref,archive_revision:revision,archive_status:'durable',payload_sha256:record.payload_sha256,bytes:record.total_bytes};
  }
  private async removeColdRecords(records:Pick<ColdRecord,'namespace'|'key'>[]){
    const cold=(this.storage as PosixStorage).cold;if(!cold)return;
    const removed=new Set(records.map(r=>`${r.namespace}:${r.key}`)),packs=new Set([
      ...(await cold.locations(records)).map(r=>r.pack),...(await cold.packs('unreferenced')).map(p=>p.key)]);
    for(const pack of packs){const locations=await cold.locations(undefined,pack);
      const keep=locations.filter(r=>!removed.has(`${r.namespace}:${r.key}`));
      if(keep.length){const data=await cold.records(pack);await this.storage.moveCold!(data.filter(r=>keep.some(k=>k.namespace===r.namespace&&k.key===r.key)));}
      await cold.forget(records,pack);
      if(!(await this.snapshotPins()).has(pack))await cold.removePack(pack);
    }
  }
  async retainBackupDependencies(id:string):Promise<{packs:number;bytes:number}>{
    check(/^[a-f0-9]{64}$/u.test(id),'INVALID_BACKUP_ID');
    let receipt:{dependency_packs:{key:string;size:number}[]};
    try{receipt=JSON.parse(Buffer.from(await this.storage.read('backup-dependencies',id)).toString());}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      receipt={dependency_packs:(await (this.storage as PosixStorage).cold?.packs(true)??[]).map(({key,size})=>({key,size}))};
      await this.storage.publish('backup-dependencies',id,Buffer.from(canonical(receipt)));}
    return {packs:receipt.dependency_packs.length,bytes:receipt.dependency_packs.reduce((sum,p)=>sum+p.size,0)};
  }
  private async snapshotPins(){
    const root=(this.storage as PosixStorage).root,pins=new Set<string>();if(!root)return pins;
    for(const key of await this.storage.list('backup-dependencies')){
      const receipt=JSON.parse(Buffer.from(await this.storage.read('backup-dependencies',key)).toString());
      for(const pack of receipt.dependency_packs)pins.add(pack.key);}
    let ids:string[];try{ids=await fs.readdir(join(root,'.snapshots'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return pins;throw error;}
    for(const id of ids){if(/^\.pending-[a-f0-9]{64}$/u.test(id))continue;check(/^[a-f0-9]{64}$/u.test(id),'ARCHIVE_SNAPSHOT_INVALID',500);
      const receipt=JSON.parse(await fs.readFile(join(root,'.snapshots',id,'snapshot.json'),'utf8'));
      for(const pack of receipt.dependency_packs)pins.add(pack.key);}
    return pins;
  }
  private async copySnapshotTree(source:string,target:string,consumer=false){
    await fs.mkdir(target,{recursive:true,mode:0o700});let bytes=0;
    for await(const entry of await fs.opendir(source)){
      const from=join(source,entry.name),to=join(target,entry.name),root=(this.storage as PosixStorage).root;
      if(entry.name==='.snapshots'||entry.name==='.raw-ingress-reserve'||source===(this.storage as PosixStorage).root&&['snapshot.json','voiceprints'].includes(entry.name)||entry.name.startsWith('.pending-')||
        ['-wal','-shm','-journal'].some(suffix=>entry.name.endsWith(suffix)))continue;
      check(!entry.isSymbolicLink(),'UNSAFE_ARCHIVE_SNAPSHOT',500);
      if(entry.isDirectory())bytes+=await this.copySnapshotTree(from,to,consumer);
      else{check(entry.isFile(),'UNSAFE_ARCHIVE_SNAPSHOT',500);
        if(!consumer&&source===join(root,'objects'))await fs.link(from,to);
        else{const input=await fs.open(from,constants.O_RDONLY|constants.O_NOFOLLOW);try{
          const before=await input.stat(),header=Buffer.alloc(16);await input.read(header,0,16,0);
          if(header.equals(Buffer.from('SQLite format 3\0'))){const db=new DatabaseSync(from,{readOnly:true});try{
            const pages=db.prepare('PRAGMA page_count').get()!.page_count as number,pageSize=db.prepare('PRAGMA page_size').get()!.page_size as number;
            await (this.storage as PosixStorage).reserve(pages*pageSize);await backup(db,to);
          }finally{db.close();}}
          else{await (this.storage as PosixStorage).reserve(before.size);await fs.copyFile(from,to);const after=await fs.stat(from);
            check(before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'ARCHIVE_SNAPSHOT_CONSUMER_CHANGED',409);}
          const output=await fs.open(to,constants.O_RDONLY|constants.O_NOFOLLOW);try{await output.sync();}finally{await output.close();}
        }finally{await input.close();}}
        bytes+=(await fs.stat(to)).size;}
    }const directory=await fs.open(target,'r');try{await directory.sync();}finally{await directory.close();}return bytes;
  }
  /** A coherent archive cut. Hard links pin hot bytes; the durable manifest pins cold dependencies during transfer. */
  async snapshot(includeConsumerState=false){return this.exclusively(async()=>{
    check(this.storage instanceof PosixStorage,'ARCHIVE_SNAPSHOT_STORAGE_REQUIRED',503);
    const disk=this.storage,source=disk.root,id=randomBytes(32).toString('hex'),target=join(source,'.snapshots',id),pending=join(source,'.snapshots',`.pending-${id}`);
    const dependency_packs=(await disk.cold?.packs(true)??[]).map(p=>({key:p.key,size:p.size}));
    const receipt={schema:'paios.archive.snapshot.v1' as const,snapshot_id:id,root:target,dependency_mode:'remote-versioned' as const,dependency_packs,hot_bytes:0,reserve_bytes:disk.reserveBytes,
      ...(includeConsumerState?{consumer_root:join(target,'.consumer-state'),consumer_roots:['resources','state'],consumer_bytes:0}:{})};
    try{await disk.withOriginalWrite(async()=>{
      await fs.mkdir(pending,{recursive:true,mode:0o700});
      if(includeConsumerState){
        await fs.mkdir(join(pending,'.consumer-state'),{mode:0o700});
        for(const name of receipt.consumer_roots!){const root=join(dirname(source),name);
          try{check((await fs.lstat(root)).isDirectory(),'UNSAFE_ARCHIVE_SNAPSHOT',500);}
          catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
          receipt.consumer_bytes!+=await this.copySnapshotTree(root,join(pending,'.consumer-state',name),true);
        }
      }
      receipt.hot_bytes=await this.copySnapshotTree(source,pending);
      const handle=await fs.open(join(pending,'snapshot.json'),'wx',0o600);
      try{await handle.writeFile(canonical(receipt));await handle.sync();}finally{await handle.close();}
      const directory=await fs.open(pending,'r');try{await directory.sync();}finally{await directory.close();}
      await fs.rename(pending,target);const parent=await fs.open(join(source,'.snapshots'),'r');try{await parent.sync();}finally{await parent.close();}
    });return receipt;}catch(error){await fs.rm(pending,{recursive:true,force:true});await fs.rm(target,{recursive:true,force:true});
      if((error as NodeJS.ErrnoException).code==='ENOSPC')this.notify('L5_BACKUP_DISK_RESERVE_EXHAUSTED');throw error;}
  });}
  async releaseSnapshot(id:string,retainDependencies=false){return this.exclusively(async()=>{
    check(this.storage instanceof PosixStorage&&/^[a-f0-9]{64}$/u.test(id),'ARCHIVE_SNAPSHOT_INVALID');
    const receipt=JSON.parse(await fs.readFile(join(this.storage.root,'.snapshots',id,'snapshot.json'),'utf8'));
    if(retainDependencies)await this.storage.publish('backup-dependencies',id,Buffer.from(canonical(receipt)));
    await fs.rm(join(this.storage.root,'.snapshots',id),{recursive:true,force:true});
    const cold=this.storage.cold;if(cold){const referenced=new Set((await cold.packs(true)).map(p=>p.key)),pins=await this.snapshotPins();
      for(const p of receipt.dependency_packs)if(!referenced.has(p.key)&&!pins.has(p.key))await cold.removePack(p.key);}
  });}
  /** Explicit restore verifies the versioned dependencies and preserves their cold locations. */
  async restoreSnapshot(){return this.exclusively(async()=>{
    check(this.storage instanceof PosixStorage,'ARCHIVE_SNAPSHOT_STORAGE_REQUIRED',503);
    const disk=this.storage,receipt=JSON.parse(await fs.readFile(join(disk.root,'snapshot.json'),'utf8'));
    check(receipt.schema==='paios.archive.snapshot.v1'&&receipt.dependency_mode==='remote-versioned'&&Array.isArray(receipt.dependency_packs),'ARCHIVE_SNAPSHOT_INVALID',500);
    await disk.publishRestored('backup-dependencies',receipt.snapshot_id,Buffer.from(canonical(receipt)));
    const sizes=new Map((await disk.cold?.packs()??[]).map(p=>[p.key,p.size]));
    let objects=0;for(const pack of receipt.dependency_packs){check(disk.cold,'ARCHIVE_SNAPSHOT_CODEC_REQUIRED',503);
      check(sizes.get(pack.key)===pack.size,'ARCHIVE_SNAPSHOT_DEPENDENCY_INVALID',500);
      const records=await disk.cold.records(pack.key);
      objects+=records.filter(r=>r.namespace==='objects').length;
    }
    await disk.withOriginalWrite(async()=>{for(const key of await this.storage.list('owner-deletions')){
      const intent=JSON.parse(Buffer.from(await this.storage.read('owner-deletions',key)).toString());
      await this.deleteManyOwned([intent.raw_ref??`l5:${key}`],intent.principal_id);
    }});
    if(receipt.consumer_root){const labels=join(dirname(disk.root),'state','call-turns');let files:string[]=[];
    try{files=await fs.readdir(labels);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const file of files.filter(file=>file.endsWith('.json'))){
      const row=JSON.parse(await fs.readFile(join(labels,file),'utf8'));if(row.schema!=='paios.call-turn.v2')continue;
      check(Array.isArray(row.audio),'CALL_TURN_ARCHIVE_REFERENCE_REQUIRED',500);
      for(const audio of row.audio){if('silence_samples' in audio)continue;const event=audio.legacy_original?.event??audio.event;
        try{if(audio.chunk)await this.readExactChunk(event,audio.chunk,this.streams.budget.max_chunk_bytes);
          else await this.read(event.raw_ref,event.principal_id,event.archive_revision);}
        catch(error){if(!(error instanceof ContractError&&error.code==='RAW_DELETED'))throw error;}
      }
    }}return {packs:receipt.dependency_packs.length,objects};
  });}
  async uploadBackup(name:string,bytes:Uint8Array){check(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(name),'BACKUP_NAME_INVALID');
    const cold=(this.storage as PosixStorage).cold;check(cold,'COLD_STORAGE_NOT_CONFIGURED',503);
    const receipt=await cold.upload(`backups/${name}`,bytes);return {name,size:receipt.size,sha256:receipt.hash};}
  async downloadBackup(name:string){check(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(name),'BACKUP_NAME_INVALID');
    const cold=(this.storage as PosixStorage).cold;check(cold,'COLD_STORAGE_NOT_CONFIGURED',503);return cold.download(`backups/${name}`);}
  async deriveMedia(original:ArchivedEvent,port:DemuxPort,signal:AbortSignal):Promise<VerifiedDerivedRecord> {
    original=structuredClone(original);
    const record=await this.readRecord(original.raw_ref,original.principal_id,original.archive_revision);
    check(record.kind==='original'&&canonical(this.originalEvent(record,original.raw_ref))===canonical(original),'DERIVATION_SOURCE_MISMATCH');
    return this.derivatives.derive(original,record.bytes,port,signal);
  }
  private originalEvent(record:OriginalArchiveRecord,rawRef:string):ArchivedEvent {
    return {...record.event,raw_ref:rawRef,archive_revision:record.archive_revision,archive_status:'durable',
      payload_sha256:record.payload_sha256,bytes:record.total_bytes};
  }
  async readDerivation(original:ArchivedEvent,ref:string):Promise<VerifiedDerivedRecord> {
    original=structuredClone(original);
    const record=await this.readRecord(original.raw_ref,original.principal_id,original.archive_revision);
    check(record.kind==='original'&&canonical(this.originalEvent(record,original.raw_ref))===canonical(original),'DERIVATION_SOURCE_MISMATCH');
    return this.derivatives.read(original,ref);
  }
  /** Actual L5 evidence check, not a reference-shape or model-content check. */
  async validateEvidence(d:ProcessedEvent):Promise<boolean> {
    try {
      validateProcessed(d);
      // The proof, never the whole lane's bytes: a wake turn late in a 10-minute lane read ~17 MB here.
      const record=await this.readRecord(d.raw_ref,d.principal_id,d.archive_revision,
        {proof_only:d.media_type!=='text'&&d.media_type!=='app_event'});
      const source=record.event;
      const {time_range:_sourceRange,attachments,...sourceMetadata}=source;
      check(canonical(d.content.attachments ?? null) === canonical(attachments ?? null), 'EVIDENCE_ATTACHMENT_MISMATCH');
      const actualMetadata=Object.fromEntries(Object.keys(sourceMetadata).map(key=>[key,d[key as keyof ProcessedEvent]]));
      // Captured audio has no speaker at acquisition; owner-verified speech is attributed by processing, not by the source.
      if(['owner_voice','owner_override'].includes(principalAttribution(d)??'')&&sourceMetadata.user_identity==='unknown')actualMetadata.user_identity='unknown';
      // Nor a place: a wake turn's request revision is located by its device's latest fix (the runtime's one per-device
      // authority), the only field it may add to the captured stream's source.
      if(d.processing.path_id==='ambient_wake_request'&&sourceMetadata.source.location===undefined&&d.source.location!==undefined){
        const {location:_located,...captured}=d.source;actualMetadata.source=captured;}
      check(canonical(actualMetadata)===canonical(sourceMetadata)&&record.payload_sha256===d.payload_sha256&&
        record.total_bytes===d.bytes,'EVIDENCE_SOURCE_MISMATCH');
      if(record.kind==='original'&&source.media_type!=='muxed_av'&&!(source.media_type==='audio'&&source.mime==='audio/mp4')){
        // Text/App and finite original files retain their complete acquisition range.
        check(canonical(d.time_range)===canonical(source.time_range),'EVIDENCE_RANGE_MISMATCH');
        return true;
      }
      const derivedRefs=d.continuation?.basis_refs.filter(ref=>ref.startsWith('l5-derived:'))??[];
      const mediaManifest=record.kind==='stream'?record.manifest:
        (check(derivedRefs.length===1,'EVIDENCE_DERIVATION_REQUIRED'),
          (await this.derivatives.read(this.originalEvent(record,d.raw_ref),derivedRefs[0]!)).manifest);
      check(d.segment_id===`segment:${digest([d.event_id,d.time_range,d.segment_basis])}`&&d.continuation,
        'EVIDENCE_SEGMENT_MISMATCH');
      const refs=d.continuation.basis_refs.filter(ref=>/^l5-view:[a-f0-9]{64}$/u.test(ref));
      check(refs.length===1,'EVIDENCE_MEDIA_VIEW_REQUIRED');
      const hash=refs[0]!.slice(8);
      const view=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await this.storage.read('media-views',hash))) as {
        raw_ref:string;archive_revision:string;window:TimeRange;views:MediaView[];derivation_ref?:string};
      check(digest(view)===hash&&view.raw_ref===d.raw_ref&&view.archive_revision===d.archive_revision&&
        canonical(view.window)===canonical(d.time_range)&&Array.isArray(view.views)&&view.views.length>0&&
        view.views.length<=mediaManifest.chunks.length,'EVIDENCE_MEDIA_VIEW_MISMATCH');
      check(record.kind==='stream'?view.derivation_ref===undefined:view.derivation_ref===derivedRefs[0],'EVIDENCE_DERIVATION_MISMATCH');
      const seen=new Set<string>(),bySlot=new Map<string,unknown[]>();
      const slotOf=(c:{track_id:string;stream_epoch:string;seq:number})=>`${c.track_id}\u0000${c.stream_epoch}\u0000${c.seq}`;
      for(const c of mediaManifest.chunks){const same=bySlot.get(slotOf(c));if(same)same.push(c);else bySlot.set(slotOf(c),[c]);}
      for(const v of view.views){
        validateRange(v.mapped_range);
        check(v.ref===`l5-object:${v.chunk.object_hash}`&&!!bySlot.get(slotOf(v.chunk))?.some(c=>canonical(c)===canonical(v.chunk))&&
          v.mapped_range.timebase_id===d.time_range.timebase_id&&overlaps(d.time_range,v.mapped_range),
          'EVIDENCE_MEDIA_CHUNK_MISMATCH');
        const slot=digest([v.chunk.track_id,v.chunk.stream_epoch,v.chunk.seq]);
        check(!seen.has(slot),'EVIDENCE_MEDIA_CHUNK_MISMATCH');seen.add(slot);
        // The D's own evidence bytes are intact (object hash, length, PCM duration).
        if(record.kind==='stream')await this.streams.verifiedPcm(v.chunk as StoredChunk);
      }
      const audio=view.views.filter(v=>v.chunk.modality==='audio');
      check(d.segment_basis==='speech_candidate'||d.segment_basis==='wake_turn'?audio.length>0:audio.length===0,'EVIDENCE_SEGMENT_MISMATCH');
      if(d.coverage.status==='complete'&&audio.length&&d.time_range.kind==='interval'){
        let cursor=d.time_range.start_ms;
        for(const v of audio.sort((a,b)=>start(a.mapped_range)-start(b.mapped_range))){
          check(v.mapped_range.kind==='interval'&&v.mapped_range.start_ms<=cursor,'EVIDENCE_COVERAGE_MISMATCH');
          cursor=Math.max(cursor,v.mapped_range.end_ms);
        }
        check(cursor>=d.time_range.end_ms,'EVIDENCE_COVERAGE_MISMATCH');
      }
      for(const gap of d.coverage.missing_ranges){validateRange(gap);check(contained(d.time_range,gap),'EVIDENCE_COVERAGE_MISMATCH');}
      check(d.coverage.status!=='complete'||d.coverage.missing_ranges.length===0,'EVIDENCE_COVERAGE_MISMATCH');
      if(d.processing.reused_audio){
        const input=JSON.parse(Buffer.from(await this.storage.read('processed-media-inputs',digest([d.raw_ref,d.segment_id,d.revision]))).toString()) as MediaInputRecord;
        check(canonical(input.reused_audio)===canonical(d.processing.reused_audio)&&input.selected_views&&
          input.selected_input_sha256===digest({input_contract:input.input_contract,views:input.selected_views}),'EVIDENCE_AUDIO_REUSE_INPUT_MISMATCH');
        await verifySelectedAudio(this.storage,d,input.selected_views!,view.views,refs[0]!);
        const audio=await readReusedAudio(this.storage,d.processing.reused_audio,d,input.selected_views!);
        check(await this.validateEvidence(audio),'EVIDENCE_REUSED_AUDIO_INVALID');
        check(canonical(audioContent(d))===canonical(audioContent(audio))&&
          canonical(d.speakers)===canonical(audio.speakers),'EVIDENCE_REUSED_AUDIO_OUTPUT_MISMATCH');
      }
      return true;
    }catch{return false;}
  }
}
const start=(r:TimeRange)=>r.kind==='instant'?r.at_ms:r.start_ms;
const end=(r:TimeRange)=>r.kind==='instant'?r.at_ms:r.end_ms;
const overlaps=(a:TimeRange,b:TimeRange)=>a.kind==='instant'?start(b)<=a.at_ms&&end(b)>=a.at_ms:
  b.kind==='instant'?b.at_ms>=a.start_ms&&b.at_ms<a.end_ms:b.start_ms<a.end_ms&&b.end_ms>a.start_ms;
const contained=(a:TimeRange,b:TimeRange)=>a.timebase_id===b.timebase_id&&start(b)>=start(a)&&end(b)<=end(a);
