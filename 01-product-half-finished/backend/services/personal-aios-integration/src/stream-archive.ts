import { bindRaw, canonical, check, digest, id, sha256, utc, validateRange } from './contracts.ts';
import type { ArchivedEvent, BoundEvent, RawEvent, TimeRange, TrustedContext } from './contracts.ts';
import type { StoragePort } from './storage.ts';

export interface TrackChunk {
  track_id: string; stream_epoch: string; seq: number; modality: 'audio' | 'visual';
  source_range: TimeRange; format: string; clock_basis_ref?: string;
  source_video?:{track_id:string;frame_count:number;width:number;height:number;source_width:number;source_height:number;rotation:number;
    frames:{timestamp_us:string;received_at_ms:number}[]};
}
export interface StoredChunk extends TrackChunk {
  object_hash: string; bytes: number; received_at: string; mime: string;
  representation: RawEvent['representation']; fingerprint: string;
}
export interface TrackExtent {
  track_id: string; stream_epoch: string; timebase_id: string;
  durable_ranges: TimeRange[]; gaps: TimeRange[]; missing_seqs: number[];
  durable_until_ms: number | null;
}
export interface StreamManifest {
  schema: 'paios.stream.v1' | 'paios.stream.v2'; journal?: JournalRevision[]; raw_ref: string; revision: number; parent: string | null;
  event: BoundEvent; chunks: StoredChunk[]; extents: TrackExtent[];
}
export interface JournalRevision {
  schema:'paios.stream.delta.v2'; raw_ref:string; revision:number; parent:string|null;
  event:BoundEvent; chunk:StoredChunk; total_bytes:number; payload_sha256:string;
}
interface JournalState {entries:JournalRevision[]; chunks:StoredChunk[]; slots:Map<string,JournalRevision>; tracks:Map<string,StoredChunk>; firsts:Map<string,{chunk:StoredChunk;revision:number}>}
const slot=(c:TrackChunk)=>digest([c.track_id,c.stream_epoch,c.seq]);
const track=(c:TrackChunk)=>digest([c.track_id,c.stream_epoch]);
const rolling=(parent:string|null,object:string)=>digest({schema:'paios.stream.payload.v2',parent,object_hash:object});
// Manifests this archive materialized from its own journal, whose every entry was verified once when it was loaded and
// deep-frozen then: the prefix proof cannot have changed since, so its revision is answered without re-walking a lane of
// thousands of entries on each read (a 10-minute ambient lane: ~0.7 s of main-thread hashing per read, which stalled PCM appends).
// Full lanes the journal cache keeps verified: the live ambient lane, a call's audio and video, and one being re-read.
const JOURNAL_CACHE_LANES=4;
const verifiedManifests=new WeakMap<StreamManifest,string>();
function deepFreeze<T>(value:T):T{
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){for(const inner of Object.values(value))deepFreeze(inner);Object.freeze(value);}
  return value;
}
/** v2 revision commits deltas. Any manifest not materialized by this process is validated independently of local state. */
export function streamManifestRevision(m:StreamManifest):string {
  const known=verifiedManifests.get(m);if(known!==undefined)return known;
  if(m.schema==='paios.stream.v1')return digest(m);
  check(m.schema==='paios.stream.v2'&&m.journal&&m.journal.length===m.revision,'STREAM_REVISION_INTEGRITY',500);
  let prior:JournalRevision|undefined,total=0,payload:string|null=null;
  for(let n=0;n<m.journal.length;n++){
    const j=m.journal[n]!;total+=j.chunk.bytes;payload=rolling(payload,j.chunk.object_hash);
    check(j.schema==='paios.stream.delta.v2'&&j.raw_ref===m.raw_ref&&j.revision===n+1&&
      j.parent===(prior?digest(prior):null)&&j.total_bytes===total&&j.payload_sha256===payload&&
      canonical(j.event)===canonical(m.event)&&canonical(j.chunk)===canonical(m.chunks[n]),'STREAM_REVISION_INTEGRITY',500);prior=j;
  }
  check(prior&&m.chunks.length===m.revision&&m.parent===prior.parent&&digest(extents(m.chunks))===digest(m.extents),'STREAM_REVISION_INTEGRITY',500);
  return digest(prior);
}
export interface StreamBudget {max_chunk_bytes: number; max_total_bytes: number; max_chunks: number; max_revisions: number; max_seq: number}
/** proof_only: the verified manifest and receipt fields without reading any chunk bytes (evidence checks). */
export interface StreamReadOptions {maxReadBytes?: number; source_range?: TimeRange; track_ids?: string[]; proof_only?: boolean}
export const MAX_READ_TRACK_IDS = 64;
export interface StreamReadSelection {
  semantics: 'whole_chunks_overlap'; source_range: TimeRange | null; track_ids: string[] | null;
}
export interface VerifiedStreamRecord {manifest: StreamManifest; chunks: {chunk: StoredChunk; bytes: Uint8Array; source_ref: string}[];
  total_bytes: number; payload_sha256: string; selected_bytes: number; selection: StreamReadSelection}
const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(canonical(v));
const parse = <T>(v: Uint8Array): T => JSON.parse(new TextDecoder().decode(v)) as T;
const absent = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
export async function requireRawAvailable(storage:StoragePort,rawRef:string){
  let intent:{raw_ref?:string};
  try{intent=parse(await storage.read('owner-deletions',rawRef.slice(rawRef.indexOf(':')+1)));}catch(error){if(absent(error))return;throw error;}
  check(!intent.raw_ref||intent.raw_ref===rawRef,'OWNER_DELETE_INTENT_CONFLICT',500);
  check(false,'RAW_DELETED',410);
}
/** One revocation fence for source-owned publication; producer work stays outside it. */
export function withRawPublication<T>(storage:StoragePort,rawRef:string,work:()=>Promise<T>):Promise<T>{
  const publish=async()=>{await requireRawAvailable(storage,rawRef);return work();};
  return storage.withOriginalWrite?storage.withOriginalWrite(publish):publish();
}
export function publishRawRecord(storage:StoragePort,rawRef:string,namespace:string,key:string,bytes:Uint8Array):Promise<Uint8Array>{
  return withRawPublication(storage,rawRef,async()=>{
    await storage.trackSessionRecords?.(rawRef,[{namespace,key}]);
    return storage.publish(namespace,key,bytes);
  });
}
const identity = (e: BoundEvent): unknown => ({event_id: e.event_id, device_id: e.device_id,
  device_type: e.device_type, principal_id: e.principal_id, consent_ref: e.consent_ref,
  captured_at: e.captured_at, source: e.source, media_type: e.media_type, origin: e.origin,
  ...(e.audio_capture?{audio_capture:e.audio_capture}:{})});
const sameTrack = (a: TrackChunk, b: TrackChunk): boolean => a.track_id === b.track_id && a.stream_epoch === b.stream_epoch;

function extents(chunks: StoredChunk[]): TrackExtent[] {
  const groups = new Map<string, StoredChunk[]>();
  for (const c of chunks) { const k = `${c.track_id}\u0000${c.stream_epoch}`; const group=groups.get(k);if(group)group.push(c);else groups.set(k,[c]); }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const intervals = group.map(c => c.source_range).filter(r => r.kind === 'interval').sort((a,b) => a.start_ms-b.start_ms);
    const ranges: TimeRange[] = [], gaps: TimeRange[] = [];
    for (const r of intervals) {
      const last = ranges.at(-1);
      if (last?.kind === 'interval' && r.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, r.end_ms);
      else { if (last?.kind === 'interval') gaps.push({...r, start_ms: last.end_ms, end_ms: r.start_ms}); ranges.push({...r}); }
    }
    // Point frames remain points; they never claim coverage between two frames.
    ranges.push(...group.map(c => c.source_range).filter(r => r.kind === 'instant'));
    // The highest seq once, not per loop test: re-spreading the set each iteration made this quadratic in the lane length.
    const seqs = new Set(group.map(c => c.seq)), missing: number[] = [], top = Math.max(...seqs);
    for (let n=0; n<top; n++) if (!seqs.has(n)) missing.push(n);
    const initial=group.find(c=>c.seq===0)?.source_range;
    const contiguous=initial?.kind==='interval'?ranges.find(r=>r.kind==='interval'&&r.start_ms<=initial.start_ms&&r.end_ms>=initial.end_ms):undefined;
    return {track_id: first.track_id, stream_epoch: first.stream_epoch, timebase_id: first.source_range.timebase_id,
      durable_ranges: ranges, gaps, missing_seqs: missing,durable_until_ms:contiguous?.kind==='interval'?contiguous.end_ms:null};
  });
}

// Domain authority for open streams. Storage remains the sole publication boundary.
// Sequence slots are exclusive immutable records: races retry from the winning revision.
export class StreamArchive {
  readonly storage: StoragePort;
  readonly budget: StreamBudget;
  constructor(storage: StoragePort, budget: StreamBudget) {
    this.storage=storage;this.budget=budget;
    check(Object.values(budget).every(n => Number.isSafeInteger(n) && n > 0), 'INVALID_STREAM_BUDGET');
  }
  private readonly journals=new Map<string,JournalState>();
  private journalTail:Promise<unknown>=Promise.resolve();
  private journalPending=0;
  private journalWork<T>(run:()=>Promise<T>):Promise<T>{
    check(this.journalPending<this.budget.max_chunks,'STREAM_APPEND_CONTENTION',429);this.journalPending++;
    const work=this.journalTail.then(run).finally(()=>this.journalPending--);
    this.journalTail=work.catch(()=>undefined);return work;
  }
  private async isLegacy(rawRef:string):Promise<boolean>{
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef),'INVALID_RAW_REF');
    let data:Uint8Array;try{data=await this.storage.read('stream-revisions',this.key(rawRef,1));}
    catch(e){if(absent(e))return false;throw e;}
    const m=parse<{schema:string}>(data);check(['paios.stream.v1','paios.stream.delta.v2'].includes(m.schema),'STREAM_REVISION_INTEGRITY',500);
    return m.schema==='paios.stream.v1';
  }
  private async journal(rawRef:string,through=this.budget.max_revisions,checkpoint?:()=>Promise<void>):Promise<JournalState>{
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef),'INVALID_RAW_REF');
    // Least recently used lanes leave first. The bound is in entries, not lanes (~2 KB of heap each): 16 full lanes per
    // archive held ~190 MB, growing ~1 MiB/min per live 100 ms PCM lane. A re-read lane is re-verified.
    let state:JournalState=(!checkpoint?this.journals.get(rawRef):undefined)??{entries:[],chunks:[],slots:new Map(),tracks:new Map(),firsts:new Map()};
    if(!checkpoint){this.journals.delete(rawRef);this.journals.set(rawRef,state);}
    for(let n=state.entries.length+1;n<=through;n++){
      await checkpoint?.();
      let data:Uint8Array;try{data=await this.storage.read('stream-revisions',this.key(rawRef,n));}
      catch(e){if(absent(e))break;throw e;}
      const j=parse<JournalRevision>(data),prior=state.entries.at(-1),c=j.chunk;
      check(j.schema==='paios.stream.delta.v2'&&j.raw_ref===rawRef&&j.revision===n&&
        j.parent===(prior?digest(prior):null)&&canonical(j.event)===canonical(prior?.event??j.event)&&
        j.event.origin==='device_observation'&&j.event.user_identity==='unknown'&&
        rawRef===`l5:${digest({event_id:j.event.event_id,principal_id:j.event.principal_id,device_id:j.event.device_id})}`,
        'STREAM_REVISION_INTEGRITY',500);
      let object:Uint8Array;try{object=await this.storage.read('stream-revisions',digest(j));}
      catch(e){if(absent(e))check(false,'STREAM_REVISION_INTEGRITY',500);throw e;}
      check(canonical(parse(object))===canonical(j),'STREAM_REVISION_INTEGRITY',500);
      this.validateStoredChunk(c,j.event);
      check(!state.slots.has(slot(c)),'STREAM_CHUNK_INTEGRITY',500);
      const descriptor=state.tracks.get(track(c));if(descriptor)this.checkDescriptor(descriptor,c);
      check(j.total_bytes===(prior?.total_bytes??0)+c.bytes&&j.total_bytes<=this.budget.max_total_bytes&&
        n<=this.budget.max_chunks&&j.payload_sha256===rolling(prior?.payload_sha256??null,c.object_hash),'STREAM_BUDGET_EXCEEDED',413);
      deepFreeze(j);if(!state.firsts.has(track(c)))state.firsts.set(track(c),{chunk:c,revision:n});
      state.entries.push(j);state.chunks.push(c);state.slots.set(slot(c),j);state.tracks.set(track(c),c);
    }
    if(checkpoint)return state;
    let cached=0;for(const lane of this.journals.values())cached+=lane.entries.length;
    for(const [ref,lane] of this.journals){if(ref===rawRef||cached<=JOURNAL_CACHE_LANES*this.budget.max_revisions&&this.journals.size<=64)break;
      this.journals.delete(ref);cached-=lane.entries.length;}
    return state;
  }
  private validateStoredChunk(c:StoredChunk,event:BoundEvent){
    id(c.track_id);id(c.stream_epoch);validateRange(c.source_range);utc(c.received_at);
    check(c.source_range.stream_epoch===c.stream_epoch&&Number.isSafeInteger(c.seq)&&c.seq>=0&&c.seq<=this.budget.max_seq&&
      ['audio','visual'].includes(c.modality)&&['audio','visual','livekit_tracks'].includes(event.media_type)&&
      (event.media_type==='livekit_tracks'||event.media_type===c.modality)&&typeof c.format==='string'&&c.format.length>0&&c.format.length<=200&&
      /^[a-f0-9]{64}$/u.test(c.object_hash)&&Number.isSafeInteger(c.bytes)&&c.bytes>0&&c.bytes<=this.budget.max_chunk_bytes&&
      (c.clock_basis_ref===undefined||/^source-clock:[a-f0-9]{64}$/u.test(c.clock_basis_ref)),'STREAM_CHUNK_INTEGRITY',500);
    if(c.source_video){const v=c.source_video;id(v.track_id);
      check(c.modality==='visual'&&c.representation==='encoded_video_segment'&&c.mime==='video/h264'&&
        v.width===1280&&v.height===720&&Number.isSafeInteger(v.frame_count)&&v.frame_count>0&&v.frame_count<=60&&
        Number.isSafeInteger(v.source_width)&&v.source_width>0&&Number.isSafeInteger(v.source_height)&&v.source_height>0&&
        [0,90,180,270].includes(v.rotation)&&Array.isArray(v.frames)&&v.frames.length===v.frame_count&&
        v.frames.every(f=>/^-?\d{1,21}$/u.test(f.timestamp_us)&&Number.isSafeInteger(f.received_at_ms)&&f.received_at_ms>=0),
        'VIDEO_SEGMENT_METADATA_INVALID',422);}
    else check(c.representation!=='encoded_video_segment','VIDEO_SEGMENT_METADATA_REQUIRED',422);
    const {received_at:_received,fingerprint,...detail}=c;check(digest(detail)===fingerprint,'STREAM_CHUNK_INTEGRITY',500);
  }
  private checkDescriptor(a:StoredChunk,b:StoredChunk){
    check(a.clock_basis_ref===b.clock_basis_ref&&a.modality===b.modality&&a.format===b.format&&a.mime===b.mime&&
      a.representation===b.representation&&a.source_range.timebase_id===b.source_range.timebase_id,'TRACK_DESCRIPTOR_CHANGED_WITHOUT_EPOCH',409);
  }
  /** Shares the verified frozen entries (no copy of the lane per read); the manifest itself is frozen too. */
  private materialize(state:JournalState,n:number):StreamManifest{
    const journal=state.entries.slice(0,n),j=journal.at(-1)!;
    const chunks=journal.map(x=>x.chunk);
    const manifest=deepFreeze<StreamManifest>({schema:'paios.stream.v2',raw_ref:j.raw_ref,revision:n,parent:j.parent,event:j.event,chunks,extents:extents(chunks),journal});
    verifiedManifests.set(manifest,digest(j));return manifest;
  }
  private async publishJournal(j:JournalRevision):Promise<JournalRevision>{
    const encoded=bytes(j),key=digest(j),alias=this.key(j.raw_ref,j.revision);
    if(this.storage.publishAliased)return parse(await this.storage.publishAliased('stream-revisions',key,alias,encoded));
    const commit=await this.storage.publish('stream-revisions',key,encoded);
    check(canonical(parse(commit))===canonical(j),'STREAM_REVISION_INTEGRITY',500);
    return parse(await this.storage.publish('stream-revisions',alias,encoded));
  }
  private journalRecords(j:JournalRevision){return [digest(j),this.key(j.raw_ref,j.revision)].map(key=>({namespace:'stream-revisions',key}));}
  private receipt(j:JournalRevision):ArchivedEvent{return {...j.event,raw_ref:j.raw_ref,archive_revision:digest(j),
    archive_status:'durable',payload_sha256:j.payload_sha256,bytes:j.total_bytes};}
  private async requireOpen(rawRef:string,chunk:StoredChunk){
    let end:{pending?:{fingerprint:string}[]};
    try{end=parse(await this.storage.read('session-ends',rawRef.slice(3)));}
    catch(error){if(absent(error))return;throw error;}
    if(end.pending?.some(p=>p.fingerprint===chunk.fingerprint))return;
    check(false,'STREAM_ALREADY_FINAL',409);
  }
  async head(rawRef:string,options:{checkpoint?:()=>Promise<void>}={}):Promise<StreamManifest|null>{
    await requireRawAvailable(this.storage,rawRef);
    if(await this.isLegacy(rawRef))return this.legacyHead(rawRef,options.checkpoint);
    if(options.checkpoint){const state=await this.journal(rawRef,undefined,options.checkpoint);return state.entries.length?this.materialize(state,state.entries.length):null;}
    return this.journalWork(async()=>{const s=await this.journal(rawRef);return s.entries.length?this.materialize(s,s.entries.length):null;});
  }
  async readRecord(rawRef:string,principal:string,revision:string,options:StreamReadOptions={}):Promise<VerifiedStreamRecord>{
    options=structuredClone(options);
    await requireRawAvailable(this.storage,rawRef);
    if(await this.isLegacy(rawRef))return this.legacyReadRecord(rawRef,principal,revision,options);
    const m=await this.journalWork(async()=>{
      const j=await this.pinned(rawRef,principal,revision),s=await this.journal(rawRef,j.revision);return this.materialize(s,j.revision);});
    check(streamManifestRevision(m)===revision,'STREAM_REVISION_INTEGRITY',500);
    if(options.source_range!==undefined){check(options.source_range!==null&&typeof options.source_range==='object'&&!Array.isArray(options.source_range),'INVALID_TIME_RANGE');validateRange(options.source_range);}
    if(options.track_ids!==undefined){check(Array.isArray(options.track_ids)&&options.track_ids.length>0&&options.track_ids.length<=MAX_READ_TRACK_IDS&&
      new Set(options.track_ids).size===options.track_ids.length,'INVALID_TRACK_SELECTION');options.track_ids.forEach(id);
      check(options.track_ids.every(t=>m.chunks.some(c=>c.track_id===t)),'STREAM_TRACK_NOT_FOUND');}
    const selected=m.chunks.filter(c=>(!options.track_ids||options.track_ids.includes(c.track_id))&&(!options.source_range||rangeOverlaps(c.source_range,options.source_range)));
    const selectedBytes=options.proof_only?0:selected.reduce((n,c)=>n+c.bytes,0),limit=options.maxReadBytes??this.budget.max_total_bytes;
    check(Number.isSafeInteger(limit)&&limit>0,'INVALID_READ_BUDGET');check(selectedBytes<=limit,'RAW_READ_BUDGET_EXCEEDED',413);
    const chunks:VerifiedStreamRecord['chunks']=[];
    if(!options.proof_only)for(const c of selected)chunks.push({chunk:c,bytes:await this.verifiedPcm(c),source_ref:`l5-object:${c.object_hash}`});
    const last=m.journal!.at(-1)!;
    return {manifest:m,chunks,total_bytes:last.total_bytes,payload_sha256:last.payload_sha256,selected_bytes:selectedBytes,
      selection:{semantics:'whole_chunks_overlap',source_range:options.source_range??null,track_ids:options.track_ids??null}};
  }
  private async pinned(rawRef:string,principal:string,revision:string):Promise<JournalRevision>{
    await requireRawAvailable(this.storage,rawRef);
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef)&&/^[a-f0-9]{64}$/u.test(revision),'INVALID_RAW_REF');
    let data:Uint8Array;try{data=await this.storage.read('stream-revisions',revision);}catch(e){if(absent(e))check(false,'ARCHIVE_REVISION_CONFLICT',409);throw e;}
    const j=parse<JournalRevision>(data);
    check(digest(j)===revision&&j.raw_ref===rawRef,'STREAM_REVISION_INTEGRITY',500);
    check(j.event.principal_id===principal,'RAW_ACCESS_DENIED',403);
    check(Number.isSafeInteger(j.revision)&&j.revision>0&&j.revision<=this.budget.max_revisions,'INVALID_ARCHIVE_REVISION');
    const slot=parse<JournalRevision>(await this.storage.read('stream-revisions',this.key(rawRef,j.revision)));
    check(digest(slot)===revision,'ARCHIVE_REVISION_CONFLICT',409);return j;
  }
  /** Clock projection from this owner's verified committed prefix; it does not read PCM objects. */
  async readHeader(event:ArchivedEvent):Promise<{event:ArchivedEvent;tracks:StoredChunk[]}>{
    event=structuredClone(event);
    await requireRawAvailable(this.storage,event.raw_ref);
    if(await this.isLegacy(event.raw_ref)){
      const record=await this.legacyReadRecord(event.raw_ref,event.principal_id,event.archive_revision,{});
      const archived={...record.manifest.event,raw_ref:event.raw_ref,archive_revision:event.archive_revision,archive_status:'durable' as const,payload_sha256:record.payload_sha256,bytes:record.total_bytes};
      check(canonical(archived)===canonical(event),'STREAM_REVISION_INTEGRITY',500);
      const tracks=new Map<string,StoredChunk>();for(const c of record.manifest.chunks)if(!tracks.has(track(c)))tracks.set(track(c),c);
      return {event:archived,tracks:[...tracks.values()]};
    }
    return this.journalWork(async()=>{
      const j=await this.pinned(event.raw_ref,event.principal_id,event.archive_revision),state=await this.journal(event.raw_ref,j.revision);
      check(state.entries.length>=j.revision&&canonical(this.receipt(j))===canonical(event),'STREAM_REVISION_INTEGRITY',500);
      return structuredClone({event:this.receipt(j),tracks:[...state.firsts.values()].filter(x=>x.revision<=j.revision).map(x=>x.chunk)});
    });
  }
  /** Exact committed delta for streaming detector. Range/L5 readers still validate the complete pinned proof. */
  async readExactChunk(event:ArchivedEvent,chunk:TrackChunk,maxBytes:number):Promise<{chunk:StoredChunk;bytes:Uint8Array}>{
    event=structuredClone(event);chunk=structuredClone(chunk);
    await requireRawAvailable(this.storage,event.raw_ref);
    if(await this.isLegacy(event.raw_ref)){
      const r=await this.legacyReadRecord(event.raw_ref,event.principal_id,event.archive_revision,{source_range:chunk.source_range,track_ids:[chunk.track_id],maxReadBytes:maxBytes});
      check(r.chunks.length===1,'CONTINUOUS_EXACT_CHUNK_REQUIRED');return r.chunks[0]!;
    }
    const selected=await this.journalWork(async()=>{
      const j=await this.pinned(event.raw_ref,event.principal_id,event.archive_revision),s=await this.journal(event.raw_ref,j.revision);
      check(canonical(this.receipt(j))===canonical(event)&&s.entries.length>=j.revision,'CONTINUOUS_SOURCE_SELECTION');
      // The requested frame must be the delta that the supplied durable receipt commits.
      check(canonical({...chunk,object_hash:j.chunk.object_hash,bytes:j.chunk.bytes,received_at:j.chunk.received_at,mime:j.chunk.mime,
        representation:j.chunk.representation,fingerprint:j.chunk.fingerprint})===canonical(j.chunk),'CONTINUOUS_SOURCE_SELECTION');
      check(Number.isSafeInteger(maxBytes)&&maxBytes>0&&j.chunk.bytes<=maxBytes,'RAW_READ_BUDGET_EXCEEDED',413);return structuredClone(j.chunk);
    });return {chunk:selected,bytes:await this.verifiedPcm(selected)};
  }
  /** One committed chunk's bytes: object hash, length and PCM duration verified. */
  async verifiedPcm(c:StoredChunk):Promise<Uint8Array>{
    const data=await this.readChunk(c);
    if(c.format.startsWith('pcm_s16le:')){const pcm=/^pcm_s16le:(\d+):1$/u.exec(c.format),r=c.source_range;
      check(pcm&&Number(pcm[1])>0&&r.kind==='interval'&&data.length%2===0&&Math.abs((r.end_ms-r.start_ms)-data.length/2*1000/Number(pcm[1]))<0.001,'STREAM_PCM_FORMAT_TIME_MISMATCH',500);}
    return data;
  }
  private key(rawRef: string, revision: number): string {return digest([rawRef, revision]);}
  private async legacyHead(rawRef: string,checkpoint?:()=>Promise<void>): Promise<StreamManifest | null> {
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef), 'INVALID_RAW_REF');
    let previous: StreamManifest | null = null;
    for (let n=1; n<=this.budget.max_revisions; n++) {
      await checkpoint?.();
      let stored: Uint8Array;
      try {stored = await this.storage.read('stream-revisions', this.key(rawRef,n));}
      catch (e) {if (absent(e)) return previous; throw e;}
      const manifest = parse<StreamManifest>(stored);
      check(manifest.schema === 'paios.stream.v1' && manifest.raw_ref === rawRef && manifest.revision === n &&
        manifest.parent === (previous ? digest(previous) : null), 'STREAM_REVISION_INTEGRITY', 500);
      previous = manifest;
    }
    return previous;
  }
  async revision(rawRef:string,n:number):Promise<StreamManifest>{
    await requireRawAvailable(this.storage,rawRef);
    check(Number.isSafeInteger(n)&&n>0&&n<=this.budget.max_revisions,'INVALID_ARCHIVE_REVISION');
    if(await this.isLegacy(rawRef))return this.legacyRevision(rawRef,n);
    return this.journalWork(async()=>{const state=await this.journal(rawRef,n);check(state.entries.length>=n,'ARCHIVE_REVISION_CONFLICT',409);return this.materialize(state,n);});
  }
  private async legacyRevision(rawRef: string, n: number): Promise<StreamManifest> {
    check(Number.isSafeInteger(n) && n > 0 && n <= this.budget.max_revisions, 'INVALID_ARCHIVE_REVISION');
    const m = parse<StreamManifest>(await this.storage.read('stream-revisions', this.key(rawRef,n)));
    check(m.raw_ref === rawRef && m.revision === n, 'STREAM_REVISION_INTEGRITY', 500); return m;
  }
  /** Resolve only bounded immutable slots. A pinned old revision never resolves to the newer head. */
  private async legacyReadRecord(rawRef: string, principal: string, revision: string, options: StreamReadOptions = {}): Promise<VerifiedStreamRecord> {
    options = structuredClone(options);
    check(/^l5:[a-f0-9]{64}$/u.test(rawRef) && /^[a-f0-9]{64}$/u.test(revision), 'INVALID_RAW_REF');
    let previous: StreamManifest | null = null, manifest: StreamManifest | undefined;
    for (let n=1; n<=this.budget.max_revisions; n++) {
      let m: StreamManifest;
      try {m = await this.legacyRevision(rawRef,n);} catch (e) {if(absent(e))break;throw e;}
      check(m.schema==='paios.stream.v1' && m.parent===(previous?digest(previous):null), 'STREAM_REVISION_INTEGRITY',500);
      check(m.event.principal_id===principal,'RAW_ACCESS_DENIED',403);
      check(m.raw_ref===`l5:${digest({event_id:m.event.event_id,principal_id:principal,device_id:m.event.device_id})}` &&
        m.event.origin==='device_observation' && m.event.user_identity==='unknown', 'STREAM_IDENTITY_INTEGRITY',500);
      if(previous){
        check(digest(identity(m.event))===digest(identity(previous.event))&&
          previous.chunks.every(c=>m.chunks.some(next=>canonical(next)===canonical(c))),'STREAM_IDENTITY_INTEGRITY',500);
      }
      previous=m;if(digest(m)===revision){manifest=m;break;}
    }
    check(manifest,'ARCHIVE_REVISION_CONFLICT',409);
    const m=manifest;
    check(Array.isArray(m.chunks)&&m.chunks.length>0&&m.chunks.length<=this.budget.max_chunks,'STREAM_BUDGET_EXCEEDED',413);
    const slots=new Set<string>(), descriptors=new Map<string,StoredChunk>();let total=0;
    for(const c of m.chunks){
      check(c.clock_basis_ref===undefined||/^source-clock:[a-f0-9]{64}$/u.test(c.clock_basis_ref),'STREAM_CHUNK_INTEGRITY',500);
      id(c.track_id);id(c.stream_epoch);validateRange(c.source_range);utc(c.received_at);
      check(c.source_range.stream_epoch===c.stream_epoch && Number.isSafeInteger(c.seq)&&c.seq>=0&&c.seq<=this.budget.max_seq &&
        ['audio','visual'].includes(c.modality)&&typeof c.format==='string'&&c.format.length>0&&c.format.length<=200 &&
        /^[a-f0-9]{64}$/u.test(c.object_hash)&&Number.isSafeInteger(c.bytes)&&c.bytes>0&&c.bytes<=this.budget.max_chunk_bytes,
        'STREAM_CHUNK_INTEGRITY',500);
      check(['audio','visual','livekit_tracks'].includes(m.event.media_type)&&
        (m.event.media_type==='livekit_tracks'||m.event.media_type===c.modality), 'STREAM_CHUNK_INTEGRITY',500);
      const {received_at:_received,fingerprint,...detail}=c;
      check(digest(detail)===fingerprint,'STREAM_CHUNK_INTEGRITY',500);
      const slot=digest([c.track_id,c.stream_epoch,c.seq]),track=digest([c.track_id,c.stream_epoch]);
      check(!slots.has(slot),'STREAM_CHUNK_INTEGRITY',500);slots.add(slot);
      const prior=descriptors.get(track);
      if(prior)check(prior.clock_basis_ref===c.clock_basis_ref&&prior.modality===c.modality&&prior.format===c.format&&prior.mime===c.mime&&
        prior.representation===c.representation&&prior.source_range.timebase_id===c.source_range.timebase_id,'STREAM_CHUNK_INTEGRITY',500);
      descriptors.set(track,c);total+=c.bytes;
    }
    check(total<=this.budget.max_total_bytes,'STREAM_BUDGET_EXCEEDED',413);
    check(digest(extents(m.chunks))===digest(m.extents),'STREAM_EXTENT_INTEGRITY',500);
    if (options.source_range !== undefined) {
      check(options.source_range !== null && typeof options.source_range === 'object' &&
        !Array.isArray(options.source_range), 'INVALID_TIME_RANGE');
      validateRange(options.source_range);
    }
    if (options.track_ids !== undefined) {
      check(Array.isArray(options.track_ids) && options.track_ids.length > 0 &&
        options.track_ids.length <= MAX_READ_TRACK_IDS &&
        new Set(options.track_ids).size === options.track_ids.length, 'INVALID_TRACK_SELECTION');
      options.track_ids.forEach(id);
      check(options.track_ids.every(track => m.chunks.some(chunk => chunk.track_id === track)), 'STREAM_TRACK_NOT_FOUND');
    }
    const selected=options.proof_only?[]:m.chunks.filter(c=>(!options.track_ids||options.track_ids.includes(c.track_id))&&
      (!options.source_range||rangeOverlaps(c.source_range,options.source_range)));
    const selectedBytes=selected.reduce((n,c)=>n+c.bytes,0),limit=options.maxReadBytes??this.budget.max_total_bytes;
    check(Number.isSafeInteger(limit)&&limit>0,'INVALID_READ_BUDGET');
    check(selectedBytes<=limit,'RAW_READ_BUDGET_EXCEEDED',413);
    const chunks:VerifiedStreamRecord['chunks']=[];
    for(const chunk of selected){
      const data=await this.readChunk(chunk);
      if(chunk.format.startsWith('pcm_s16le:')){
        const pcm=/^pcm_s16le:(\d+):1$/u.exec(chunk.format),range=chunk.source_range;
        check(pcm&&Number(pcm[1])>0&&range.kind==='interval'&&data.length%2===0&&
          Math.abs((range.end_ms-range.start_ms)-data.length/2*1000/Number(pcm[1]))<0.001,'STREAM_PCM_FORMAT_TIME_MISMATCH',500);
      }
      chunks.push({chunk,bytes:data,source_ref:`l5-object:${chunk.object_hash}`});
    }
    return {manifest:m,chunks,total_bytes:total,payload_sha256:digest(m.chunks.map(c=>c.object_hash)),selected_bytes:selectedBytes,
      selection: {semantics: 'whole_chunks_overlap', source_range: options.source_range ?? null,
        track_ids: options.track_ids ?? null}};
  }
  private prepare(event:RawEvent,trusted:TrustedContext,receivedAt:string,chunk:TrackChunk){
    const bound = parse<BoundEvent>(bytes(bindRaw(event, trusted, receivedAt)));
    chunk=parse<TrackChunk>(bytes(chunk));
    const payload=Uint8Array.from(event.payload);
    check(['audio','visual','livekit_tracks'].includes(event.media_type) && bound.origin === 'device_observation', 'NOT_CONTINUOUS_MEDIA');
    check(chunk.clock_basis_ref===undefined||/^source-clock:[a-f0-9]{64}$/u.test(chunk.clock_basis_ref),'INVALID_TRACK_CLOCK_PROOF');
    id(chunk.track_id); id(chunk.stream_epoch); validateRange(chunk.source_range);
    check(chunk.source_range.stream_epoch === chunk.stream_epoch, 'CHUNK_EPOCH_MISMATCH');
    check(Number.isSafeInteger(chunk.seq) && chunk.seq >= 0 && chunk.seq <= this.budget.max_seq, 'INVALID_CHUNK_SEQUENCE');
    check(chunk.modality === 'audio' || chunk.modality === 'visual', 'INVALID_TRACK_MODALITY');
    check(event.media_type === 'livekit_tracks' || event.media_type === chunk.modality, 'TRACK_MODALITY_MISMATCH');
    check(typeof chunk.format === 'string' && chunk.format.length > 0 && chunk.format.length <= 200, 'INVALID_TRACK_FORMAT');
    check(event.payload.length <= this.budget.max_chunk_bytes, 'CHUNK_BUDGET_EXCEEDED', 413);
    const rawRef = `l5:${digest({event_id: bound.event_id, principal_id: bound.principal_id, device_id: bound.device_id})}`;
    const objectHash = sha256(payload);
    const detail = {...chunk, mime: event.mime, representation: event.representation, object_hash: objectHash, bytes: event.payload.length};
    const record: StoredChunk = {...detail, received_at: receivedAt, fingerprint: digest(detail)};
    this.validateStoredChunk(record,bound);
    return {bound,payload,rawRef,objectHash,record};
  }
  async append(event: RawEvent, trusted: TrustedContext, receivedAt: string, chunk: TrackChunk): Promise<{event: ArchivedEvent; chunk: StoredChunk}> {
    ({event,trusted,chunk}=structuredClone({event,trusted,chunk}));
    return this.storage.withOriginalWrite?this.storage.withOriginalWrite(()=>this.appendOwned(event,trusted,receivedAt,chunk)):this.appendOwned(event,trusted,receivedAt,chunk);
  }
  validateInput(event:RawEvent,trusted:TrustedContext,receivedAt:string,chunk:TrackChunk){this.prepare(event,trusted,receivedAt,chunk);}
  private async appendOwned(event:RawEvent,trusted:TrustedContext,receivedAt:string,chunk:TrackChunk):Promise<{event:ArchivedEvent;chunk:StoredChunk}>{
    const {bound,payload,rawRef,objectHash,record}=this.prepare(event,trusted,receivedAt,chunk);
    await requireRawAvailable(this.storage,rawRef);
    return this.journalWork(async()=>{
      if(await this.isLegacy(rawRef)){const legacy=await this.legacyAppend(event,trusted,receivedAt,chunk);
        const stored=legacy.manifest.chunks.find(c=>sameTrack(c,chunk)&&c.seq===chunk.seq)!;return {event:legacy.event,chunk:structuredClone(stored)};}
      for(let attempts=0;attempts<this.budget.max_revisions;attempts++){
        const state=await this.journal(rawRef),previous=state.entries.at(-1);
        if(previous)check(digest(identity(previous.event))===digest(identity(bound)),'STREAM_IDENTITY_CONFLICT',409);
        const existing=state.slots.get(slot(record));
        if(existing){check(existing.chunk.fingerprint===record.fingerprint,'CHUNK_IDENTITY_CONFLICT',409);
          const committed=existing;
          await this.storage.trackSessionRecords?.(rawRef,this.journalRecords(committed));
          check(digest(await this.publishJournal(committed))===digest(committed),'STREAM_REVISION_INTEGRITY',500);
          return {event:this.receipt(committed),chunk:structuredClone(existing.chunk)};}
        const descriptor=state.tracks.get(track(record));if(descriptor)this.checkDescriptor(descriptor,record);
        await this.requireOpen(rawRef,record);
        const n=state.entries.length+1,total=(previous?.total_bytes??0)+record.bytes;
        check(n<=this.budget.max_chunks&&total<=this.budget.max_total_bytes,'STREAM_BUDGET_EXCEEDED',413);
        check(n<=this.budget.max_revisions,'STREAM_REVISION_BUDGET_EXCEEDED',413);
        const j:JournalRevision={schema:'paios.stream.delta.v2',raw_ref:rawRef,revision:n,parent:previous?digest(previous):null,
          event:previous?.event??bound,chunk:record,total_bytes:total,payload_sha256:rolling(previous?.payload_sha256??null,objectHash)};
        await this.storage.trackSessionRecords?.(rawRef,[{namespace:'objects',key:objectHash},...this.journalRecords(j)]);
        const object=await this.storage.publish('objects',objectHash,payload);check(sha256(object)===objectHash,'STREAM_OBJECT_INTEGRITY',500);
        const winner=await this.publishJournal(j);
        // Only the slot winner commits a revision. Losing content-addressed proposals remain unreferenced.
        if(digest(winner)===digest(j)){await this.journal(rawRef,n);return {event:this.receipt(j),chunk:structuredClone(record)};}
      }
      throw new Error('STREAM_APPEND_CONTENTION');
    });
  }
  /** Bounded source transaction. Every SDK chunk keeps its own immutable delta and receipt. */
  async appendBatch(inputs:{event:RawEvent;trusted:TrustedContext;received_at:string;chunk:TrackChunk}[],limit:{max_chunks:number;max_bytes:number}):Promise<{event:ArchivedEvent;chunk:StoredChunk}[]>{
    check(Number.isSafeInteger(limit.max_chunks)&&limit.max_chunks>0&&limit.max_chunks<=64&&Number.isSafeInteger(limit.max_bytes)&&limit.max_bytes>0&&
      inputs.length>0&&inputs.length<=limit.max_chunks&&inputs.reduce((n,x)=>n+x.event.payload.length,0)<=limit.max_bytes,'STREAM_BATCH_BUDGET',413);
    inputs=structuredClone(inputs);
    if(!this.storage.publishMany||!this.storage.stageAlias||!this.storage.flushNamespace){
      const results=[];for(const x of inputs)results.push(await this.append(x.event,x.trusted,x.received_at,x.chunk));return results;
    }
    const records=inputs.map(x=>this.prepare(x.event,x.trusted,x.received_at,x.chunk)),rawRef=records[0]!.rawRef;
    await requireRawAvailable(this.storage,rawRef);
    check(records.every(x=>x.rawRef===rawRef&&digest(identity(x.bound))===digest(identity(records[0]!.bound))),'STREAM_BATCH_IDENTITY_CONFLICT',409);
    const work=()=>this.journalWork(async()=>{
      await requireRawAvailable(this.storage,rawRef);
      if(await this.isLegacy(rawRef)){const results=[];for(const x of inputs){const value=await this.legacyAppend(x.event,x.trusted,x.received_at,x.chunk);
        results.push({event:value.event,chunk:value.manifest.chunks.find(c=>slot(c)===slot(x.chunk))!});}return results;}
      const objects=new Map(records.map(x=>[x.objectHash,x.payload]));
      let objectsPublished=false;
      const results=new Map<number,{event:ArchivedEvent;chunk:StoredChunk}>();
      for(let attempt=0;attempt<Math.min(8,this.budget.max_revisions);attempt++){
        const state=await this.journal(rawRef),tracks=new Map<string,StoredChunk>();
        let previous=state.entries.at(-1);const proposals:{j:JournalRevision;indices:number[]}[]=[],bySlot=new Map<string,{j:JournalRevision;indices:number[]}>();
        for(let index=0;index<records.length;index++){
          if(results.has(index))continue;const x=records[index]!;
          if(previous)check(digest(identity(previous.event))===digest(identity(x.bound)),'STREAM_IDENTITY_CONFLICT',409);
          const duplicate=bySlot.get(slot(x.record))?.j??state.slots.get(slot(x.record));
          if(duplicate){check(duplicate.chunk.fingerprint===x.record.fingerprint,'CHUNK_IDENTITY_CONFLICT',409);
            const proposal=bySlot.get(slot(x.record));if(proposal)proposal.indices.push(index);else results.set(index,{event:this.receipt(duplicate),chunk:structuredClone(duplicate.chunk)});continue;}
          const descriptor=tracks.get(track(x.record))??state.tracks.get(track(x.record));if(descriptor)this.checkDescriptor(descriptor,x.record);
          await this.requireOpen(rawRef,x.record);
          const n=(previous?.revision??0)+1,total=(previous?.total_bytes??0)+x.record.bytes;
          check(n<=this.budget.max_chunks&&n<=this.budget.max_revisions&&total<=this.budget.max_total_bytes,'STREAM_BUDGET_EXCEEDED',413);
          const j:JournalRevision={schema:'paios.stream.delta.v2',raw_ref:rawRef,revision:n,parent:previous?digest(previous):null,event:previous?.event??x.bound,
            chunk:x.record,total_bytes:total,payload_sha256:rolling(previous?.payload_sha256??null,x.objectHash)};
          const proposal={j,indices:[index]};proposals.push(proposal);bySlot.set(slot(x.record),proposal);tracks.set(track(x.record),x.record);previous=j;
        }
        await this.storage.trackSessionRecords?.(rawRef,[...(!objectsPublished?[...objects.keys()].map(key=>({namespace:'objects',key})):[]),
          ...proposals.flatMap(({j})=>this.journalRecords(j))]);
        if(!objectsPublished){
          await this.storage.publishMany!('objects',[...objects].map(([key,bytes])=>({key,bytes})));objectsPublished=true;}
        if(proposals.length)await this.storage.publishMany!('stream-revisions',proposals.map(x=>({key:digest(x.j),bytes:bytes(x.j)})));
        const committed:{j:JournalRevision;indices:number[]}[]=[];
        for(const proposal of proposals){
          const {winner}=await this.storage.stageAlias!('stream-revisions',digest(proposal.j),this.key(rawRef,proposal.j.revision));
          // A competing winner invalidates later precomputed parents. Never link those later slots.
          if(digest(parse(winner))!==digest(proposal.j))break;committed.push(proposal);
        }
        await this.storage.flushNamespace!('stream-revisions');
        for(const proposal of committed)for(const index of proposal.indices)results.set(index,{event:this.receipt(proposal.j),chunk:structuredClone(proposal.j.chunk)});
        if(results.size===records.length){await this.journal(rawRef);return records.map((_,index)=>results.get(index)!);}
      }
      throw new Error('STREAM_APPEND_CONTENTION');
    });
    return this.storage.withOriginalWrite?this.storage.withOriginalWrite(work):work();
  }
  private async legacyAppend(event: RawEvent, trusted: TrustedContext, receivedAt: string, chunk: TrackChunk): Promise<{event: ArchivedEvent; manifest: StreamManifest}> {
    const bound = parse<BoundEvent>(bytes(bindRaw(event, trusted, receivedAt)));
    chunk=parse<TrackChunk>(bytes(chunk));
    const payload=Uint8Array.from(event.payload);
    check(['audio','visual','livekit_tracks'].includes(event.media_type) && bound.origin === 'device_observation', 'NOT_CONTINUOUS_MEDIA');
    check(chunk.clock_basis_ref===undefined||/^source-clock:[a-f0-9]{64}$/u.test(chunk.clock_basis_ref),'INVALID_TRACK_CLOCK_PROOF');
    id(chunk.track_id); id(chunk.stream_epoch); validateRange(chunk.source_range);
    check(chunk.source_range.stream_epoch === chunk.stream_epoch, 'CHUNK_EPOCH_MISMATCH');
    check(Number.isSafeInteger(chunk.seq) && chunk.seq >= 0 && chunk.seq <= this.budget.max_seq, 'INVALID_CHUNK_SEQUENCE');
    check(chunk.modality === 'audio' || chunk.modality === 'visual', 'INVALID_TRACK_MODALITY');
    check(event.media_type === 'livekit_tracks' || event.media_type === chunk.modality, 'TRACK_MODALITY_MISMATCH');
    check(typeof chunk.format === 'string' && chunk.format.length > 0 && chunk.format.length <= 200, 'INVALID_TRACK_FORMAT');
    check(event.payload.length <= this.budget.max_chunk_bytes, 'CHUNK_BUDGET_EXCEEDED', 413);
    const rawRef = `l5:${digest({event_id: bound.event_id, principal_id: bound.principal_id, device_id: bound.device_id})}`;
    const objectHash = sha256(payload);
    const detail = {...chunk, mime: event.mime, representation: event.representation, object_hash: objectHash, bytes: event.payload.length};
    const record: StoredChunk = {...detail, received_at: receivedAt, fingerprint: digest(detail)};
    const publishResult = async (m: StreamManifest) => ({manifest: m, event: {...m.event, raw_ref: rawRef,
      archive_revision: digest(m), archive_status: 'durable' as const, payload_sha256: digest(m.chunks.map(c=>c.object_hash)),
      bytes: m.chunks.reduce((sum,c)=>sum+c.bytes,0)}});
    for (let attempts=0; attempts<this.budget.max_revisions; attempts++) {
      const previous = await this.legacyHead(rawRef);
      if (previous) check(digest(identity(previous.event)) === digest(identity(bound)), 'STREAM_IDENTITY_CONFLICT', 409);
      const existing = previous?.chunks.find(c => sameTrack(c,chunk) && c.seq === chunk.seq);
      if (existing) {check(existing.fingerprint === record.fingerprint, 'CHUNK_IDENTITY_CONFLICT', 409); return publishResult(previous!);}
      const priorTrack = previous?.chunks.find(c=>sameTrack(c,chunk));
      await this.requireOpen(rawRef,record);
      if (priorTrack) check(priorTrack.clock_basis_ref === chunk.clock_basis_ref && priorTrack.modality === chunk.modality && priorTrack.format === chunk.format &&
        priorTrack.source_range.timebase_id === chunk.source_range.timebase_id && priorTrack.mime === event.mime &&
        priorTrack.representation === event.representation, 'TRACK_DESCRIPTOR_CHANGED_WITHOUT_EPOCH', 409);
      const chunks = [...(previous?.chunks ?? []), record];
      check(chunks.length <= this.budget.max_chunks && chunks.reduce((sum,c)=>sum+c.bytes,0) <= this.budget.max_total_bytes,
        'STREAM_BUDGET_EXCEEDED', 413);
      const n = (previous?.revision ?? 0)+1;
      check(n <= this.budget.max_revisions, 'STREAM_REVISION_BUDGET_EXCEEDED', 413);
      const m: StreamManifest = {schema:'paios.stream.v1', raw_ref: rawRef, revision:n,
        parent: previous ? digest(previous) : null, event: previous?.event ?? bound, chunks, extents: extents(chunks)};
      await this.storage.trackSessionRecords?.(rawRef,[{namespace:'objects',key:objectHash},{namespace:'stream-revisions',key:this.key(rawRef,n)}]);
      const object = await this.storage.publish('objects',objectHash,payload);
      check(sha256(object) === objectHash, 'STREAM_OBJECT_INTEGRITY', 500);
      const winner = await this.storage.publish('stream-revisions',this.key(rawRef,n),bytes(m));
      if (digest(parse(winner)) === digest(m)) return publishResult(m);
    }
    throw new Error('STREAM_APPEND_CONTENTION');
  }
  async readChunk(chunk: StoredChunk): Promise<Uint8Array> {
    const b = await this.storage.read('objects',chunk.object_hash);
    check(b.length === chunk.bytes && sha256(b) === chunk.object_hash, 'STREAM_OBJECT_INTEGRITY', 500); return b;
  }
}

function rangeOverlaps(a:TimeRange,b:TimeRange):boolean {
  if(a.timebase_id!==b.timebase_id||a.stream_epoch!==b.stream_epoch)return false;
  return b.kind==='instant'?a.kind==='instant'?a.at_ms===b.at_ms:b.at_ms>=a.start_ms&&b.at_ms<a.end_ms:
    a.kind==='instant'?a.at_ms>=b.start_ms&&a.at_ms<b.end_ms:a.start_ms<b.end_ms&&a.end_ms>b.start_ms;
}
