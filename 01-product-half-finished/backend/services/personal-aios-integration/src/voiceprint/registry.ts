import {normalizedScore, type VoiceprintScoring} from './scoring.ts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { check, ContractError, digest, isIdentifier, utc } from '../contracts.ts';
import type { StoragePort } from '../storage.ts';
import { resolveSpeaker } from '../ambient/lane.ts';
import type { VisualMemory } from '../visual/store.ts';
import { CALL_INTERRUPT_MIN_SPEECH_MS, type IdentifyInput, type SpeakerIdentifier, type SpeakerIdentity, type VoiceprintChannel } from './contracts.ts';
import { isSealedRegistry, type RegistryCipher } from './cipher.ts';

export interface VoiceprintTrustScope {principal_id: string; device_id: string}
interface TrustWindow {opened: number; expires: number; calls: Set<string>; closed_calls: Set<string>; anchors: Map<string, Float32Array>}
export interface DeviceOwnerConfirmationInput {
  speaker_model: SpeakerModel; channel: VoiceprintChannel; speech_ms: number; observed_at: string;
  evidence_start_at?: string; quality?: number; trust_scope?: VoiceprintTrustScope; call_id?: string;
}
export interface SpeakerModel {id: string; sha256: string; dim: number}
/** Calibrated cosine lines belong to this exact model and capture channel; absent channels stay locked. */
export interface ModelVerification {speaker_model: SpeakerModel; channels: Partial<Record<OwnerChannel, number>>}
interface VerifiedLineDoc {model: SpeakerModel; channel: VoiceprintChannel; threshold: number}
export interface VoiceprintThresholds {
  /** Initial per-channel verified line and permanent floor (at least 0.65). */
  owner_verified: number;
  /** Below the channel's verified line: chat only until the phone's "确认是我". */
  owner_uncertain: number;
  /** Nearest other-person cluster at or above which a segment joins it. */
  cluster: number;
  /** Each enrollment sample against the centroid of the other samples. */
  enroll_consistency: number;
  /** Nearest assistant voice at or above which (and above the owner and every person) a segment is 依米's own voice. */
  assistant: number;
  /** In-call follow, trusted-centroid learning and enrollment matching have independent fixed contracts. */
  call_anchor: number; trusted_centroid: number; enroll_match: number;
}
export interface AdaptiveVerifiedPolicy {min_samples: number; margin: number; step: number; ceiling: number}
export interface VoiceprintPolicy {
  thresholds: VoiceprintThresholds;
  adaptive_verified: AdaptiveVerifiedPolicy;
  min_identify_ms: number; min_cluster_ms: number; min_enroll_ms: number; min_enroll_samples: number;
  max_owner_samples: number; max_clusters: number; centroid_cap: number; flush_ms: number;
  /** Shortest speech checked against any voice: the assistant's (owner and people need min_identify_ms), and a short
   *  request alone in a combined turn; voices kept. */
  min_assistant_ms: number; max_assistant_voices: number;
  /** Shortest wake turn identified over its wake word and a short request together (guarded by the request alone). */
  min_turn_ms: number;
  trust_window_ms: number;
}
/** Real speech can score lower than synthetic speech: calibrate from the owner's enrollment consistency
 *  before trusting the verified band. Assistant-voice scores also depend on reply length and capture channel.
 *  Adaptive verified line: after 8 confirmed same-chain samples, each additional sample permits a 0.0025 rise from
 *  the configured floor; cap it at both minimum leave-one-out cosine across that channel's sets minus 0.04 and 0.68.
 *  Historical calibration supplied in the requirement: same-chain owner 0.69-0.89, impostors <=0.61, call 0.46-0.69.
 *  A low-consistency set (minimum <=0.69) cannot raise the line. Eight samples delay adaptation beyond the five-sample
 *  enrollment minimum; the 0.04 reserve and 0.68 ceiling leave room below those observed owner scores.
 *  Persist max(previous, candidate) in the channel's sets only when confirmed evidence joins; enrollment replacement,
 *  invalidation, restart and lower policy reload retain that watermark. A higher configured floor is persisted on load.
 *  These calibration ranges justify a conservative candidate, not held-out human recall: replay the owner's store
 *  offline before release and require zero additional confirmed-owner rejections against fixed 0.65. */
export const DEFAULT_VOICEPRINT_POLICY: VoiceprintPolicy = Object.freeze({
  thresholds: Object.freeze({owner_verified: 0.65, owner_uncertain: 0.45, cluster: 0.65, enroll_consistency: 0.6, assistant: 0.5,
    call_anchor: 0.65, trusted_centroid: 0.65, enroll_match: 0.65}),
  adaptive_verified: Object.freeze({min_samples: 8, margin: 0.04, step: 0.0025, ceiling: 0.68}),
  min_identify_ms: 1000, min_cluster_ms: 2000, min_enroll_ms: 1500, min_enroll_samples: 5,
  max_owner_samples: 20, max_clusters: 200, centroid_cap: 50, flush_ms: 10000, min_assistant_ms: 400, max_assistant_voices: 4,
  // Short wake-word requests need a lower minimum than ordinary utterances; their request evidence is checked separately.
  min_turn_ms: 800, trust_window_ms: 60000,
});
/** Shared by live admission and the read-only historical evaluator; never infer evidence on reload. */
export function advanceVerifiedThreshold(previous: number, evidence: {samples: number; min: number}, policy = DEFAULT_VOICEPRINT_POLICY): number {
  const {min_samples, margin, step, ceiling} = policy.adaptive_verified, floor = policy.thresholds.owner_verified;
  return Math.max(previous, floor, evidence.samples < min_samples ? floor :
    Math.min(ceiling, floor + (evidence.samples - min_samples + 1) * step, evidence.min - margin));
}

export type VoiceprintPolicyOptions = Partial<Omit<VoiceprintPolicy, 'thresholds'|'adaptive_verified'>> & {
  thresholds?: Partial<VoiceprintThresholds>; adaptive_verified?: Partial<AdaptiveVerifiedPolicy>};
/** Live provisioning and offline measurements validate the same policy. */
export function voiceprintPolicy(options: VoiceprintPolicyOptions = {}): VoiceprintPolicy {
  const thresholds = {...DEFAULT_VOICEPRINT_POLICY.thresholds, ...options?.thresholds};
  const adaptive_verified = {...DEFAULT_VOICEPRINT_POLICY.adaptive_verified, ...options?.adaptive_verified};
  const policy = {...DEFAULT_VOICEPRINT_POLICY, ...options, thresholds, adaptive_verified};
  check(Object.values(thresholds).every(value => Number.isFinite(value) && value > 0 && value < 1) &&
    thresholds.owner_verified >= DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified &&
    (['call_anchor','trusted_centroid','enroll_match'] as const).every(key=>thresholds[key]===DEFAULT_VOICEPRINT_POLICY.thresholds[key]) &&
    thresholds.owner_uncertain <= thresholds.owner_verified, 'VOICEPRINT_THRESHOLDS_INVALID');
  check(Object.keys(adaptive_verified).every(key => ['min_samples','margin','step','ceiling'].includes(key)) &&
    Number.isSafeInteger(adaptive_verified.min_samples) && adaptive_verified.min_samples >= 2 &&
    ['margin','step','ceiling'].every(key => Number.isFinite(adaptive_verified[key as keyof AdaptiveVerifiedPolicy]) &&
      adaptive_verified[key as keyof AdaptiveVerifiedPolicy] > 0 && adaptive_verified[key as keyof AdaptiveVerifiedPolicy] < 1) &&
    adaptive_verified.ceiling >= DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified, 'VOICEPRINT_POLICY_INVALID');
  check(['min_identify_ms', 'min_cluster_ms', 'min_enroll_ms', 'min_enroll_samples', 'max_owner_samples', 'max_clusters',
    'centroid_cap', 'flush_ms', 'min_assistant_ms', 'max_assistant_voices', 'min_turn_ms', 'trust_window_ms'].every(key => Number.isSafeInteger(policy[key as keyof VoiceprintPolicy]) &&
    (policy[key as keyof VoiceprintPolicy] as number) > 0) && policy.max_owner_samples >= policy.min_enroll_samples &&
    policy.min_cluster_ms >= policy.min_identify_ms && policy.min_identify_ms >= policy.min_turn_ms && policy.min_turn_ms >= policy.min_assistant_ms,
  'VOICEPRINT_POLICY_INVALID');
  return Object.freeze({...policy, thresholds: Object.freeze(thresholds), adaptive_verified: Object.freeze(adaptive_verified)});
}

/** Capture channels an owner enrollment set comes from. Embeddings move with the capture chain
 *  (WebRTC AEC/NS/AGC, Opus and resampling), so each channel keeps its own set: `file` (WAV recordings through the enrollment CLI and
 *  the internal endpoint), `phone_app` (the paired phone's in-app enrollment, the chain 随身模式 hears through), `glasses`
 *  (the glasses' own capture). `call` is derived from independently verified call windows only; it never joins the
 *  enrollment centroids or verifies payments. */
export const OWNER_CHANNELS = Object.freeze(['file', 'phone_app', 'glasses', 'mac', 'call'] as const);
export type OwnerChannel = typeof OWNER_CHANNELS[number];
const validChannel = (channel: unknown): channel is OwnerChannel => OWNER_CHANNELS.includes(channel as OwnerChannel);
/** The enrollment channel of a capturing device type (the one rule for enrollment from a paired device). */
export function deviceChannel(deviceType: string): OwnerChannel {
  check(deviceType === 'phone' || deviceType === 'glasses' || deviceType === 'mac', 'VOICEPRINT_CHANNEL_INVALID');
  return deviceType === 'phone' ? 'phone_app' : deviceType as 'glasses'|'mac';
}
/** One enrollment set: the owner's utterances from one capture channel, judged for consistency and averaged on their own. */
export interface OwnerSetDoc {
  channel: OwnerChannel; model: SpeakerModel; samples: {embedding: string; speech_ms: number; added_at: string; quality?: number; evidence_start_at?: string}[]; centroid: string;
  source_device?: {device_id: string; device_type: string};
  enrolled_at: string; updated_at: string; consistency: {min: number; mean: number};
  verified_threshold?: number;
  enrollment_generation?: number;
}
export type LearnedSetDoc = Omit<OwnerSetDoc, 'channel'> & {channel: VoiceprintChannel; source_sets: string; provenance?: 'biometric_confirmed'};
interface ClusterDoc {
  cluster_id: string; model_sha256: string; centroid: string; count: number; speech_ms: number;
  created_at: string; last_seen: string; display_name?: string; known_person_id?: string;
  face_samples?: {frame_id: string; embedding: string; at: string}[];
  aliases?: {ids: string[]; names: string[]};
}
/** One outgoing voice of the assistant (`voice`: its source, e.g. `system_tts`), learned from the speech the system sends. */
interface AssistantDoc {voice: string; model_sha256: string; centroid: string; count: number; speech_ms: number; created_at: string; last_seen: string}
export interface RegistryDoc {
  schema: 'paios.voiceprint.registry.v2'; revision: number; next_number: number;
  /** The owner's enrollment sets, at most one per capture channel; none: not enrolled. */
  call_owner?: LearnedSetDoc & {channel: 'call'};
  learned_owner?: Partial<Record<VoiceprintChannel, LearnedSetDoc>>;
  conversation_owner?: OwnerSetDoc[];
  owner_sets: OwnerSetDoc[]; clusters: ClusterDoc[]; assistant: AssistantDoc[]; face_recognition?: boolean; recognition_hints?: boolean;
  face_people?: ClusterDoc[];
  /** Template replacement must not erase an established model/channel operating line. No vectors are retained here. */
  verified_lines?: VerifiedLineDoc[];
}
/** v1 held one owner set (enrolled from WAV files) and no assistant voices before those existed. */
export interface RegistryDocV1 {
  schema: 'paios.voiceprint.registry.v1'; revision: number; next_number: number; owner: Omit<OwnerSetDoc, 'channel'> | null;
  clusters: ClusterDoc[]; assistant?: AssistantDoc[];
}
/** In-place migration on load: a v1 owner profile becomes the `file` channel's set. The document keeps its key and is
 *  written as v2 on the next durable mutation, or immediately for encryption or a higher configured floor. */
export function migrateRegistry(doc: RegistryDoc | RegistryDocV1): RegistryDoc {
  if (doc?.schema !== 'paios.voiceprint.registry.v1') return doc as RegistryDoc;
  const {owner, assistant, ...rest} = doc;
  return {...rest, schema: 'paios.voiceprint.registry.v2', owner_sets: owner && typeof owner === 'object' ? [{channel: 'file', ...owner}] : [],
    assistant: assistant ?? []};
}
export function registryOwnerSets(doc: RegistryDoc): (OwnerSetDoc|LearnedSetDoc)[] {
  return [...doc.owner_sets, ...(doc.conversation_owner ?? []), ...(doc.call_owner ? [doc.call_owner] : []),
    ...Object.values(doc.learned_owner ?? {})];
}
/** The stored channel watermark also survives stale learned-source bindings and model migrations. */
export function channelVerifiedLine(doc: RegistryDoc, channel: VoiceprintChannel, policy = DEFAULT_VOICEPRINT_POLICY): number {
  return Math.max(policy.thresholds.owner_verified, ...registryOwnerSets(doc).filter(set => set.channel === channel)
    .map(set => set.verified_threshold ?? policy.thresholds.owner_verified));
}
/** Decoded vectors exist only for profiles of the current speaker model; others stay opaque until re-enrolled or forgotten. */
interface State {doc: RegistryDoc; owner: Map<OwnerChannel, Float32Array>; clusters: Map<string, Float32Array>; assistant: Map<string, Float32Array>}
export interface OwnerSetStatus {
  channel: OwnerChannel; samples: number; enrolled_at: string; updated_at: string; consistency: {min: number; mean: number}; stale_model: boolean;
  verified_threshold: number;
}
/** Independent enrollment status, or a selected channel. `channels` also exposes the bounded derived call set. */
export interface OwnerStatus {
  enrolled: boolean; reenrollment_required: boolean; samples: number; speaker_model: SpeakerModel | null;
  enrolled_at: string | null; updated_at: string | null; consistency: {min: number; mean: number} | null; channels: OwnerSetStatus[];
}
export interface ClusterView {
  cluster_id: string; label: string; display_name: string | null; known_person_id: string | null;
  count: number; speech_ms: number; created_at: string; last_seen: string; stale_model: boolean; aliases?: {ids: string[]; names: string[]};
}
/** OpenCV SFace's published LFW cosine threshold; uncalibrated for glasses/phone capture. */
export const SFACE_COSINE_THRESHOLD = 0.363;
export const SFACE_DIM = 128;
export interface AssistantVoiceView {voice: string; count: number; speech_ms: number; created_at: string; last_seen: string; stale_model: boolean}
export class VoiceprintEnrollmentError extends ContractError {
  readonly sample_consistency: number[];
  constructor(code: string, sampleConsistency: number[] = []) {super(code, 422); this.sample_consistency = sampleConsistency;}
}

// The document's key stays the v1 name's digest across schema versions (one document, migrated in place).
const KEY = digest('paios.voiceprint.registry.v1'), NAMESPACE = 'voiceprints';
const round = (value: number) => Math.round(value * 10000) / 10000;
function unit(vector: Float32Array): Float32Array | undefined {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (!Number.isFinite(norm) || norm <= 1e-12) return undefined;
  const length = Math.sqrt(norm);
  return Float32Array.from(vector, value => value / length);
}
const dot = (a: Float32Array, b: Float32Array) => {let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum;};
function blend(parts: {vector: Float32Array; weight: number}[]): Float32Array {
  const sum = new Float32Array(parts[0]!.vector.length);
  for (const {vector, weight} of parts) for (let i = 0; i < sum.length; i++) sum[i]! += vector[i]! * weight;
  const result = unit(sum); check(result, 'VOICEPRINT_CENTROID_DEGENERATE', 422); return result;
}
/** Little-endian float32 base64: the one embedding wire/storage form (CLI, internal endpoint, registry file). */
export function encodeEmbedding(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}
export function decodeEmbedding(value: unknown, dim: number): Float32Array {
  check(typeof value === 'string' && value.length <= 65536, 'VOICEPRINT_EMBEDDING_INVALID');
  const bytes = Buffer.from(value, 'base64');
  check(bytes.length === dim * 4 && bytes.toString('base64') === value, 'VOICEPRINT_EMBEDDING_INVALID');
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vector[i] = bytes.readFloatLE(i * 4);
  check(vector.every(Number.isFinite), 'VOICEPRINT_EMBEDDING_INVALID');
  return vector;
}
export type VoiceprintScoringConfig = Omit<VoiceprintScoring,'cohort'> & {cohort?: {model_sha256: string; embeddings_base64: string[]}};
/** Live composition and offline replay decode the same model-bound scoring configuration. */
export function configuredScoring(config:VoiceprintScoringConfig|undefined,model:SpeakerModel):VoiceprintScoring {
  if(config === undefined) return {};
  check(config && typeof config === 'object' && !Array.isArray(config) &&
    Object.keys(config).every(k=>['cohort','cohort_top_k','calibration'].includes(k)), 'VOICEPRINT_SCORING_INVALID');
  const cohort=config.cohort;
  check(cohort === undefined || cohort && cohort.model_sha256 === model.sha256 && Array.isArray(cohort.embeddings_base64) &&
    cohort.embeddings_base64.length <= 1000, 'VOICEPRINT_COHORT_MODEL_MISMATCH');
  return {...(cohort ? {cohort:cohort.embeddings_base64.map(e=>decodeEmbedding(e,model.dim))} : {}),
    ...(config.calibration !== undefined ? {calibration:config.calibration} : {}),
    ...(config.cohort_top_k !== undefined ? {cohort_top_k:config.cohort_top_k} : {})};
}
/** The one speaker-model identity rule (registry, enrollment CLI, speech engine): file basename and content hash. */
export async function speakerModelIdentity(file: string, dim: number): Promise<SpeakerModel> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const model = {id: basename(file).replace(/\.onnx$/u, ''), sha256: hash.digest('hex'), dim};
  check(validModel(model), 'VOICEPRINT_SPEAKER_MODEL_INVALID');
  return model;
}
const validVoice = (voice: unknown): voice is string => typeof voice === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(voice);
function validModel(model: unknown): model is SpeakerModel {
  const m = model as SpeakerModel | null;
  return Boolean(m && typeof m === 'object' && Object.keys(m).sort().join(',') === 'dim,id,sha256' && typeof m.id === 'string' &&
    m.id.length > 0 && m.id.length <= 200 && /^[a-f0-9]{64}$/u.test(m.sha256) && Number.isSafeInteger(m.dim) && m.dim >= 16 && m.dim <= 4096);
}

/** The one voiceprint authority: owner profile (one enrollment set per capture channel; the owner scores as the best of
 *  them), other-person clusters and the assistant's own voice (so a reply heard back is never a person or a wake word),
 *  persisted as one owner-only document, sealed when a cipher is configured, under the storage root (namespace `voiceprints`, 0700 dir, 0600 file, atomic
 *  replace). Mutations are serialized in-process; the integration's process lock makes this the only writer. Ambient centroid updates are written behind (flush_ms); any
 *  cluster creation, enrollment, rename, merge or forget is durable before it returns. */
export class VoiceprintRegistry implements SpeakerIdentifier {
  readonly model: SpeakerModel;
  readonly policy: VoiceprintPolicy;
  private readonly callLearning: boolean;
  private readonly scoring: VoiceprintScoring;
  private readonly recent: {channel: string; verdict: string; at: string}[] = [];
  private readonly storage: StoragePort;
  private readonly cipher: RegistryCipher | undefined;
  private readonly onError: (error: unknown) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private state: State | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly ownerOverrideActive: (() => Promise<boolean>) | undefined;
  private readonly modelActive: (() => boolean) | undefined;
  private readonly verification: ModelVerification | undefined;
  private readonly enrollmentGeneration: number | undefined;
  private readonly priorModelThresholds: {speaker_model:SpeakerModel; owner_verified:number}[];
  private faceGeneration = 0;
  private visual: VisualMemory | undefined;
  private readonly trustWindows = new Map<string, TrustWindow>();
  private readonly nearbySeen = new Map<string, string>();
  constructor(storage: StoragePort, model: SpeakerModel, options: {policy?: VoiceprintPolicyOptions;
    onError?: (error: unknown) => void; cipher?: RegistryCipher; call_learning?: boolean; scoring?: VoiceprintScoring;
    owner_override_active?:()=>Promise<boolean>; model_active?:()=>boolean; verification?:ModelVerification; enrollment_generation?:number;
    prior_model_thresholds?:{speaker_model:SpeakerModel; owner_verified:number}[]} = {}) {
    this.ownerOverrideActive=options.owner_override_active;
    this.modelActive=options.model_active;
    check(options.enrollment_generation===undefined||Number.isSafeInteger(options.enrollment_generation)&&options.enrollment_generation>=0,
      'VOICEPRINT_ENROLLMENT_GENERATION_INVALID');
    this.enrollmentGeneration=options.enrollment_generation;
    const prior=options.prior_model_thresholds??[];
    check(Array.isArray(prior)&&prior.every(entry=>validModel(entry.speaker_model)&&Number.isFinite(entry.owner_verified)&&entry.owner_verified>0&&entry.owner_verified<1),
      'VOICEPRINT_PRIOR_MODEL_THRESHOLD_INVALID');
    this.priorModelThresholds=structuredClone(prior);
    const verification = options.verification;
    check(verification === undefined || verification.speaker_model.id === model.id && verification.speaker_model.sha256 === model.sha256 &&
      verification.speaker_model.dim === model.dim && Object.entries(verification.channels).every(([channel, line]) =>
        validChannel(channel) && channel !== 'call' && Number.isFinite(line) && line >= (options.policy?.thresholds?.owner_verified ?? DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified) && line < 1),
      'VOICEPRINT_VERIFICATION_MODEL_INVALID');
    this.verification = verification && structuredClone(verification);
    check(typeof storage.replace === 'function', 'VOICEPRINT_STORAGE_REQUIRED', 500);
    check(validModel(model), 'VOICEPRINT_SPEAKER_MODEL_INVALID');
    this.storage = storage; this.model = Object.freeze({...model}); this.policy = voiceprintPolicy(options.policy);
    this.scoring = options.scoring ?? {};
    const scoring = this.scoring;
    check(typeof scoring === 'object' && !Array.isArray(scoring) && Object.keys(scoring).every(k =>
      ['cohort','cohort_top_k','calibration'].includes(k)), 'VOICEPRINT_SCORING_INVALID');
    check(!scoring.cohort || scoring.cohort.length >= 2 && scoring.cohort.length <= 1000 && scoring.cohort.every(v =>
      v instanceof Float32Array && v.length === model.dim && v.every(Number.isFinite) && unit(v)), 'VOICEPRINT_COHORT_INVALID');
    check(scoring.cohort_top_k === undefined || Number.isSafeInteger(scoring.cohort_top_k) && scoring.cohort_top_k >= 2,
      'VOICEPRINT_COHORT_INVALID');
    check(scoring.calibration === undefined || scoring.calibration && typeof scoring.calibration === 'object' && !Array.isArray(scoring.calibration) &&
      Object.entries(scoring.calibration).every(([channel,t]) => ['file','phone_app','call','video','ambient','glasses','journal','mac'].includes(channel) &&
        t && Object.keys(t).sort().join(',') === 'uncertain,verified' && Number.isFinite(t.verified) && Number.isFinite(t.uncertain) && t.uncertain <= t.verified),
      'VOICEPRINT_CALIBRATION_INVALID');
    if(scoring.cohort) check(Object.keys(scoring.calibration ?? {}).length > 0, 'VOICEPRINT_CALIBRATION_REQUIRED');
    this.cipher = options.cipher; this.callLearning = options.call_learning !== false;
    this.onError = options.onError ?? (error => console.error('VOICEPRINT_FLUSH_FAILED', error instanceof Error ? error.message : 'unknown'));
  }
  private live(sha: string) {return sha === this.model.sha256;}
  private ownerLive(set: OwnerSetDoc | LearnedSetDoc): boolean {
    return set.model.id===this.model.id&&set.model.sha256===this.model.sha256&&set.model.dim===this.model.dim&&
      (this.enrollmentGeneration===undefined||set.enrollment_generation===this.enrollmentGeneration);
  }
  /** Model-settings owns activation. An immutable registry cannot accept work after that activation is retired. */
  requireModelActive(): void {check(this.modelActive?.() !== false, 'VOICEPRINT_MODEL_RETIRED', 409);}
  private sameModel(a:SpeakerModel,b:SpeakerModel):boolean {return a.id===b.id&&a.sha256===b.sha256&&a.dim===b.dim;}
  private modelLine(doc:RegistryDoc,model:SpeakerModel,channel:VoiceprintChannel,floor:number):number {
    return Math.max(floor,...(doc.verified_lines??[]).filter(line=>line.channel===channel&&this.sameModel(line.model,model)).map(line=>line.threshold),
      ...this.ownerEvidence(doc).filter(set=>set.channel===channel&&this.sameModel(set.model,model)).map(set=>set.verified_threshold??floor));
  }
  private ownerEvidence(doc:RegistryDoc):(OwnerSetDoc|LearnedSetDoc)[]{
    return [...doc.owner_sets,...(doc.conversation_owner??[]),...(doc.call_owner?[doc.call_owner]:[]),...Object.values(doc.learned_owner??{})];
  }
  private rememberLine(doc:RegistryDoc,model:SpeakerModel,channel:VoiceprintChannel,threshold:number):boolean {
    const lines=doc.verified_lines??= [],existing=lines.find(line=>line.channel===channel&&this.sameModel(line.model,model));
    if(existing){if(existing.threshold>=threshold)return false;existing.threshold=threshold;}
    else lines.push({model:{...model},channel,threshold});
    return true;
  }
  private archiveVerifiedLines(doc:RegistryDoc):boolean {
    let changed=false;
    for(const set of this.ownerEvidence(doc)){
      const matching=this.priorModelThresholds.filter(prior=>this.sameModel(set.model,prior.speaker_model)).map(prior=>prior.owner_verified);
      if(this.sameModel(set.model,this.model))matching.push(this.policy.thresholds.owner_verified);
      const floor=matching.length?Math.max(...matching):undefined;
      const line=set.verified_threshold===undefined?floor:Math.max(set.verified_threshold,floor??0);
      if(line!==undefined&&this.rememberLine(doc,set.model,set.channel,line))changed=true;
    }
    return changed;
  }
  private paymentLine(state: State, channel: OwnerChannel): number | undefined {
    const calibrated = this.verification?.channels[channel];
    if (calibrated === undefined) return undefined;
    return this.modelLine(state.doc,this.model,channel,Math.max(calibrated,this.policy.thresholds.owner_verified));
  }
  /** Payment has no learned-call or conversation fallback. Model-settings can intentionally supply no calibrated lines. */
  paymentReady(channel?: OwnerChannel): Promise<boolean> {
    return this.exclusive(state => {
      if (this.modelActive?.() === false) return false;
      if (!this.verification) return this.ownerStatus(state).enrolled;
      return state.doc.owner_sets.some(set => (channel === undefined || set.channel === channel) && this.ownerLive(set) &&
        this.verification!.channels[set.channel] !== undefined);
    });
  }
  async requireLearning():Promise<void> {
    this.requireModelActive();
    check(!await this.ownerOverrideActive?.(),'VOICEPRINT_LEARNING_FROZEN',409);
    this.requireModelActive();
  }
  setVisualMemory(visual: VisualMemory | undefined): void {this.visual = visual;}
  /** Import legacy sample links once, then recover an interrupted cross-store merge/delete from canonical identities and aliases. */
  reconcileFramePeople(): Promise<void> {
    return this.exclusive(state => {
      const people = this.people(state);
      this.visual?.migrateFaceLinks(people);
      this.visual?.remapFramePeople(this.visual.personIdsInFrames().flatMap(id => {
        const target = people.find(person => person.cluster_id === id || person.aliases?.ids.includes(id))?.cluster_id ?? null;
        return target === id ? [] : [[id, target] as [string, string | null]];
      }));
    });
  }
  private async load(): Promise<State> {
    if (this.state) return this.state;
    let doc: RegistryDoc, plaintext = false;
    try {
      const bytes = await this.storage.read(NAMESPACE, KEY), sealed = isSealedRegistry(bytes);
      if (sealed) check(this.cipher, 'VOICEPRINT_REGISTRY_KEY_REQUIRED', 503);
      else check(bytes[0] === 123, 'VOICEPRINT_REGISTRY_CORRUPT', 503);
      doc = migrateRegistry(JSON.parse(Buffer.from(sealed ? this.cipher!.open(bytes) : bytes).toString('utf8')));
      plaintext = !sealed;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      doc = {schema: 'paios.voiceprint.registry.v2', revision: 0, next_number: 1, owner_sets: [], clusters: [], assistant: []};
    }
    check(doc && doc.schema === 'paios.voiceprint.registry.v2' && Number.isSafeInteger(doc.revision) && Number.isSafeInteger(doc.next_number) &&
      doc.next_number > 0 && Array.isArray(doc.clusters) && Array.isArray(doc.owner_sets) &&
      doc.owner_sets.every(set => set?.channel !== 'call' && validChannel(set?.channel) && validModel(set.model)) &&
      (doc.call_owner === undefined || doc.call_owner.channel === 'call' && validModel(doc.call_owner.model) &&
        Array.isArray(doc.call_owner.samples) && doc.call_owner.samples.length <= this.policy.max_owner_samples) &&
      new Set(doc.owner_sets.map(set => set.channel)).size === doc.owner_sets.length &&
      Array.isArray(doc.assistant) && doc.assistant.every(v => validVoice(v?.voice)), 'VOICEPRINT_REGISTRY_CORRUPT', 503);
    check(doc.learned_owner === undefined || Object.entries(doc.learned_owner).every(([channel, set]) =>
      ['file','phone_app','video','ambient','glasses','journal','mac'].includes(channel) && set && set.channel === channel && validModel(set.model) &&
      typeof set.source_sets === 'string' && Array.isArray(set.samples) && set.samples.length <= this.policy.max_owner_samples),
      'VOICEPRINT_REGISTRY_CORRUPT', 503);
    check(doc.conversation_owner === undefined || Array.isArray(doc.conversation_owner) &&
      doc.conversation_owner.every(set => set.channel !== 'call' && validChannel(set.channel) && validModel(set.model) &&
        Array.isArray(set.samples) && set.samples.length <= this.policy.max_owner_samples) &&
      new Set(doc.conversation_owner.map(set => set.channel)).size === doc.conversation_owner.length, 'VOICEPRINT_REGISTRY_CORRUPT', 503);
    check(this.ownerEvidence(doc).every(set => set.verified_threshold === undefined ||
      Number.isFinite(set.verified_threshold) && set.verified_threshold > 0 && set.verified_threshold < 1), 'VOICEPRINT_REGISTRY_CORRUPT', 503);
    check(doc.verified_lines===undefined||Array.isArray(doc.verified_lines)&&doc.verified_lines.every(line=>validModel(line.model)&&
      ['file','phone_app','glasses','mac','call','video','ambient','journal'].includes(line.channel)&&Number.isFinite(line.threshold)&&line.threshold>0&&line.threshold<1),
      'VOICEPRINT_REGISTRY_CORRUPT',503);
    check([...doc.owner_sets,...(doc.conversation_owner??[]),...(doc.call_owner?[doc.call_owner]:[]),...Object.values(doc.learned_owner??{})]
      .every(set=>set.enrollment_generation===undefined||Number.isSafeInteger(set.enrollment_generation)&&set.enrollment_generation>=0),
      'VOICEPRINT_REGISTRY_CORRUPT',503);
    const state: State = {doc, owner: new Map(), clusters: new Map(), assistant: new Map()};
    for (const set of doc.owner_sets) if (this.ownerLive(set)) state.owner.set(set.channel, decodeEmbedding(set.centroid, this.model.dim));
    for (const cluster of doc.clusters) {
      check(cluster.count > 0 && isIdentifier(cluster.cluster_id) && Number(cluster.cluster_id) < doc.next_number, 'VOICEPRINT_REGISTRY_CORRUPT', 503);
      if (cluster.count > 0 && this.live(cluster.model_sha256)) state.clusters.set(cluster.cluster_id, decodeEmbedding(cluster.centroid, this.model.dim));
    }
    for (const voice of doc.assistant) if (this.live(voice.model_sha256)) state.assistant.set(voice.voice, decodeEmbedding(voice.centroid, this.model.dim));
    check((doc.face_recognition === undefined || typeof doc.face_recognition === 'boolean') &&
      (doc.recognition_hints === undefined || typeof doc.recognition_hints === 'boolean') &&
      (doc.face_people === undefined || Array.isArray(doc.face_people) && doc.face_people.every(p => p.count === 0 &&
        isIdentifier(p.cluster_id) && Number(p.cluster_id) < doc.next_number)), 'VOICEPRINT_REGISTRY_CORRUPT', 503);
    for (const cluster of [...doc.clusters, ...(doc.face_people ?? [])]) for (const sample of cluster.face_samples ?? []) {
      check(isIdentifier(sample.frame_id), 'VOICEPRINT_REGISTRY_CORRUPT', 503); utc(sample.at); decodeEmbedding(sample.embedding, SFACE_DIM);
    }
    delete (doc as RegistryDoc & {nearby_seen?: unknown}).nearby_seen;
    const linesChanged=this.priorModelThresholds.length>0&&this.archiveVerifiedLines(doc);
    let thresholdChanged = false;
    for (const set of this.ownerSets(state)) {
      check(set.verified_threshold === undefined || Number.isFinite(set.verified_threshold) &&
        set.verified_threshold >= DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified && set.verified_threshold < 1, 'VOICEPRINT_REGISTRY_CORRUPT', 503);
      const threshold = this.modelLine(doc,set.model,set.channel,this.sameModel(set.model,this.model)?
        this.policy.thresholds.owner_verified:DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified);
      if (set.verified_threshold !== threshold && (set.verified_threshold !== undefined ||
        threshold > DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified)) {set.verified_threshold = threshold; thresholdChanged = true;}
    }
    if (plaintext && this.cipher || thresholdChanged || linesChanged) {
      await this.write(doc);
      if (plaintext && this.cipher) console.info('VOICEPRINT_REGISTRY_ENCRYPTED');
    }
    return this.state = state;
  }
  private exclusive<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new ContractError('VOICEPRINT_REGISTRY_CLOSED', 503));
    const result = this.queue.then(async () => operation(await this.load()));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async write(doc: RegistryDoc): Promise<void> {
    doc.revision += 1;
    const bytes = Buffer.from(JSON.stringify(doc));
    await this.storage.replace!(NAMESPACE, KEY, this.cipher ? this.cipher.seal(bytes) : bytes);
    this.dirty = false;
  }
  /** Durable mutation: applied to a copy, written, then adopted, so a failed write leaves memory equal to disk. */
  private async commit<T>(state: State, mutate: (next: State) => T): Promise<T> {
    const next: State = structuredClone(state);
    const value = mutate(next);
    await this.write(next.doc);
    this.state = next;
    const people = this.people(next), ids = new Set(people.map(person => person.cluster_id));
    this.visual?.remapFramePeople(this.people(state).filter(person => !ids.has(person.cluster_id)).map(person =>
      [person.cluster_id, people.find(target => target.aliases?.ids.includes(person.cluster_id))?.cluster_id ?? null]));
    for (const [id, at] of this.nearbySeen) {
      const person = this.people(next).find(p => p.cluster_id === id || p.aliases?.ids.includes(id));
      if (person?.cluster_id === id) continue;
      this.nearbySeen.delete(id);
      if (person && at > (this.nearbySeen.get(person.cluster_id) ?? '')) this.nearbySeen.set(person.cluster_id, at);
    }
    return value;
  }
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.onError);
    }, this.policy.flush_ms);
    this.timer.unref?.();
  }
  flush(): Promise<void> {
    return this.exclusive(async state => {if (this.dirty) await this.write(state.doc);});
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer) {clearTimeout(this.timer); this.timer = undefined;}
    const flushed = this.flush();
    this.clearTrustWindows();
    this.closed = true;
    await flushed;
  }
  private identity(cluster: ClusterDoc, score: number): SpeakerIdentity {
    return {kind: 'speaker', cluster_id: cluster.cluster_id, ...(cluster.display_name ? {display_name: cluster.display_name} : {}), ...(cluster.known_person_id ? {known_person_id: cluster.known_person_id} : {}), score: round(score)};
  }
  identify(embedding: Float32Array, input: IdentifyInput): Promise<SpeakerIdentity> {
    try {
      this.requireModelActive();
      check(embedding instanceof Float32Array && embedding.length === this.model.dim, 'VOICEPRINT_EMBEDDING_INVALID');
      check(input && Number.isFinite(input.speech_ms) && input.speech_ms >= 0 && ['observe', 'verify', 'interrupt','call','payment'].includes(input.mode),
        'VOICEPRINT_IDENTIFY_INPUT_INVALID');
      const request = input.request?.embedding;
      check(input.request === undefined || (input.mode === 'verify' || input.mode === 'payment') && (request === null || request instanceof Float32Array &&
        request.length === this.model.dim) && (input.request.speech_ms === undefined || Number.isFinite(input.request.speech_ms) &&
        input.request.speech_ms >= 0), 'VOICEPRINT_IDENTIFY_INPUT_INVALID');
      check(input.channel === undefined || ['file','phone_app','call','video','ambient','glasses','journal','mac'].includes(input.channel), 'VOICEPRINT_CHANNEL_INVALID');
      check(input.principal_id === undefined && input.device_id === undefined ||
        isIdentifier(input.principal_id) && isIdentifier(input.device_id), 'VOICEPRINT_TRUST_SCOPE_INVALID');
      check(input.call_id === undefined || isIdentifier(input.call_id), 'INVALID_ID');
      check(input.quality === undefined || Number.isFinite(input.quality) && input.quality > 0 && input.quality <= 1, 'VOICEPRINT_QUALITY_INVALID');
      utc(input.observed_at);
      if(input.evidence_start_at !== undefined){utc(input.evidence_start_at);check(Date.parse(input.evidence_start_at) <= Date.parse(input.observed_at), 'VOICEPRINT_IDENTIFY_INPUT_INVALID');}
    } catch (error) {return Promise.reject(error);}
    return this.exclusive<SpeakerIdentity>(async state => {
      const frozen=await this.ownerOverrideActive?.()??false;
      this.requireModelActive();
      input.signal?.throwIfAborted();
      const effective=frozen?{...input,learning:false as const}:input;
      const trusted = this.trustIdentify(state, embedding, effective);
      let identity = trusted ?? await this.decide(state, embedding, effective,frozen);
      this.requireModelActive();
      if (input.mode === 'payment' && this.verification) {
        const channel = input.channel as OwnerChannel | undefined;
        const set = state.doc.owner_sets.find(set => set.channel === channel && this.ownerLive(set));
        const line = channel === undefined ? undefined : this.paymentLine(state, channel);
        if (!set || line === undefined) return {kind: 'unknown', reason: 'no_enrollment'};
        if (identity.kind === 'owner' && identity.band === 'verified' &&
          dot(unit(embedding)!, decodeEmbedding(set.centroid, this.model.dim)) < line)
          identity = {...identity, band: 'uncertain'};
      }
      if(!trusted && input.request && identity.kind === 'owner' && identity.band === 'verified'){
        const request = input.request.embedding && (input.request.speech_ms ?? Infinity) >= this.policy.min_assistant_ms ? unit(input.request.embedding) : undefined;
        if(!request || this.ownerScore(state, request, input.mode !== 'payment') < this.policy.thresholds.owner_uncertain) identity = {kind:'owner', band:'uncertain', score:identity.score};
      }
      this.recent.push({channel: input.channel ?? input.mode, verdict: identity.kind === 'owner' ? identity.band : identity.kind, at: input.observed_at});
      if(this.recent.length > 200) this.recent.shift();
      return identity;
    });
  }
  /** The owner's score: the best of every current-model set's centroid (each capture channel's own), -1 when none. */
  private ownerScore(state: State, e: Float32Array, conversation = false): number {
    let best = -1;
    for (const centroid of state.owner.values()) best = Math.max(best, dot(e, centroid));
    if (conversation) for (const set of state.doc.conversation_owner ?? []) if (this.ownerLive(set))
      best = Math.max(best, dot(e, decodeEmbedding(set.centroid, this.model.dim)));
    return best;
  }
  private ownerSets(state: State): (OwnerSetDoc|LearnedSetDoc)[] {
    return registryOwnerSets(state.doc);
  }
  /** The one per-channel line, shared by enrollment, conversation and learned sets of that capture chain. */
  private verifiedLine(state: State, channel: VoiceprintChannel): number {
    return this.modelLine(state.doc,this.model,channel,this.policy.thresholds.owner_verified);
  }
  private updateVerifiedLine(state: State, set: OwnerSetDoc|LearnedSetDoc): void {
    const currentSets=this.ownerSets(state).filter(current=>current.channel===set.channel&&this.ownerLive(current));
    const threshold = advanceVerifiedThreshold(this.verifiedLine(state, set.channel),
      {samples: set.samples.length, min: Math.min(...currentSets.map(current=>current.consistency.min))}, this.policy);
    for (const current of currentSets) current.verified_threshold = threshold;
    this.rememberLine(state.doc,this.model,set.channel,threshold);
  }
  private ownerVerified(state: State, e: Float32Array, conversation = false): boolean {
    return [...state.doc.owner_sets, ...(conversation ? state.doc.conversation_owner ?? [] : [])].some(set =>
      this.ownerLive(set) && dot(e, decodeEmbedding(set.centroid, this.model.dim)) >= this.verifiedLine(state, set.channel));
  }
  private callSources(state: State): string {
    return (this.enrollmentGeneration===undefined?'':`${this.enrollmentGeneration}|`)+state.doc.owner_sets.map(set => `${set.channel}:${set.model.sha256}:${set.enrolled_at}:${set.updated_at}:${set.centroid}`).join('|');
  }
  private callSet(state: State, channel: VoiceprintChannel = 'call') {
    const call = channel === 'call' ? state.doc.call_owner : state.doc.learned_owner?.[channel];
    return call && this.ownerLive(call) && call.source_sets === this.callSources(state) ? call : undefined;
  }
  /** Diagnostics use the same unit/cosine math as admission; no identity or profile mutation. */
  scoreChannels(embedding: Float32Array, channel: 'call'|'video' = 'call'): Promise<Record<string, number>> {
    check(embedding.length === this.model.dim, 'VOICEPRINT_EMBEDDING_INVALID');
    const e = unit(embedding); if (!e) return Promise.resolve({});
    return this.exclusive(state => {const call = this.callSet(state, channel); return Object.fromEntries([
      ...[...state.owner].map(([channel, centroid]) => [channel, round(dot(e, centroid))]),
      ...(state.doc.conversation_owner ?? []).filter(set => this.ownerLive(set))
        .map(set => [`conversation:${set.channel}`, round(dot(e, decodeEmbedding(set.centroid, this.model.dim)))]),
      ...(call ? [[channel, round(dot(e, decodeEmbedding(call.centroid, this.model.dim)))]] : []),
    ]);});
  }
  /** Read-only inventory for offline diagnosis. Never expose vectors, device identifiers or dependency fingerprints. */
  diagnostics(now = Date.now()) {
    return this.exclusive(state => {
      const view = (kind:'enrolled'|'conversation'|'learned', set:OwnerSetDoc|LearnedSetDoc) => ({kind, channel:set.channel,
        samples:set.samples.length, verified_threshold:this.verifiedLine(state,set.channel), speech_ms:set.samples.reduce((n,sample)=>n+sample.speech_ms,0),
        enrolled_age_ms:now-Date.parse(set.enrolled_at), centroid_age_ms:now-Date.parse(set.updated_at),
        model:{...set.model}, stale_model:!this.ownerLive(set),
        source_sets_current:kind==='learned'?this.callSet(state,set.channel)===set:null});
      return {revision:state.doc.revision, model:{...this.model}, min_identify_ms:this.policy.min_identify_ms,
        min_enroll_samples:this.policy.min_enroll_samples, thresholds:{...this.policy.thresholds}, sets:[
          ...state.doc.owner_sets.map(set=>view('enrolled',set)),
          ...(state.doc.conversation_owner ?? []).map(set=>view('conversation',set)),
          ...(state.doc.call_owner?[view('learned',state.doc.call_owner)]:[]),
          ...Object.values(state.doc.learned_owner ?? {}).map(set=>view('learned',set)),
        ]};
    });
  }
  /** Bounded per-channel evidence, admitted only by the independent enrolled sets. Never train on its own verdict.
   *  Keep the v2 owner_sets unchanged so legacy readers can still read the document. */
  private learnVerified(state: State, e: Float32Array, input: IdentifyInput): void {
    if (!this.callLearning || input.learning === false || input.mode === 'interrupt' || input.mode === 'payment' ||
      input.mode !== 'call' && !input.channel || input.speech_ms < this.policy.min_identify_ms) return;
    if(input.request){const request = input.request.embedding && unit(input.request.embedding);
      if(!request || (input.request.speech_ms ?? 0) < this.policy.min_identify_ms || !this.ownerVerified(state, request)) return;}
    const channel = input.channel ?? 'call', current = this.callSet(state, channel);
    if (input.quality !== undefined && input.quality < .5) return;
    if (current && current.samples.length >= this.policy.max_owner_samples) return;
    const previous = current?.samples.at(-1);
    const start = input.evidence_start_at === undefined ? Date.parse(input.observed_at) - input.speech_ms : Date.parse(input.evidence_start_at);
    if (previous && start < Date.parse(previous.added_at)) return;
    const sample = {embedding: encodeEmbedding(e), speech_ms: Math.round(input.speech_ms), added_at: input.observed_at, ...(input.quality === undefined ? {} : {quality: input.quality}), ...(input.evidence_start_at ? {evidence_start_at: input.evidence_start_at} : {})};
    if (current?.samples.some(s => s.embedding === sample.embedding)) return;
    const samples = [...(current?.samples ?? []), sample];
    const vectors = samples.map(s => decodeEmbedding(s.embedding, this.model.dim));
    const consistency = vectors.length < 2 ? [1] : vectors.map((v, i) => dot(v,
      blend(vectors.filter((_, n) => n !== i).map(vector => ({vector, weight: 1})))));
    if (consistency.some(score => score < this.policy.thresholds.enroll_consistency)) return;
    const centroid = blend(vectors.map(vector => ({vector, weight: 1})));
    const learned: LearnedSetDoc = {channel, source_sets: this.callSources(state), ...(current?.provenance ? {provenance: current.provenance} : {}), model: {...this.model}, samples, centroid: encodeEmbedding(centroid),
        enrolled_at: current?.enrolled_at ?? input.observed_at, updated_at: input.observed_at,
        consistency: {min: round(Math.min(...consistency)), mean: round(consistency.reduce((a, b) => a + b, 0) / consistency.length)},
        verified_threshold: this.verifiedLine(state, channel)};
    if(this.enrollmentGeneration!==undefined)learned.enrollment_generation=this.enrollmentGeneration;
    if(channel === 'call') state.doc.call_owner = {...learned, channel: 'call'}; else (state.doc.learned_owner ??= {})[channel] = learned;
    this.updateVerifiedLine(state, learned);
    this.scheduleFlush();
  }
  private trustKey(scope: VoiceprintTrustScope): string {
    check(isIdentifier(scope.principal_id) && isIdentifier(scope.device_id), 'VOICEPRINT_TRUST_SCOPE_INVALID');
    return JSON.stringify([scope.principal_id, scope.device_id]);
  }
  /** Called only after the paired device has approved its owner biometric challenge. Process-local by design. */
  openTrustWindow(scope: VoiceprintTrustScope, options: {channel?: VoiceprintChannel; call_id?: string; at?: string} = {}): void {
    const key = this.trustKey(scope), at = options.at === undefined ? Date.now() : (utc(options.at), Date.parse(options.at));
    check(options.call_id === undefined || isIdentifier(options.call_id), 'INVALID_ID');
    const prior = this.trustWindows.get(key);
    const window: TrustWindow = prior && (prior.calls.size || prior.expires > at) ? prior :
      {opened: at, expires: at, calls: new Set(), closed_calls: new Set(), anchors: new Map()};
    window.expires = Math.max(window.expires, at + this.policy.trust_window_ms);
    if (options.call_id) window.calls.add(options.call_id);
    this.trustWindows.set(key, window);
  }
  trustWindowActive(scope: VoiceprintTrustScope, at = new Date(Date.now()).toISOString()): boolean {
    const key = this.trustKey(scope), now = (utc(at), Date.parse(at)), window = this.trustWindows.get(key);
    if (!window || now < window.opened) return false;
    if (!window.calls.size && now >= window.expires) return false;
    return true;
  }
  closeTrustCall(scope: VoiceprintTrustScope, callId: string): void {
    const window = this.trustWindows.get(this.trustKey(scope));
    if (!window) return;
    const held = window.calls.delete(callId);
    if (held || window.expires > Date.now()) window.closed_calls.add(callId);
    if (held) window.expires = Math.max(window.expires, Date.now());
    for (const key of window.anchors.keys()) if (JSON.parse(key)[1] === callId) window.anchors.delete(key);
  }
  clearTrustWindows(): void {this.trustWindows.clear();}
  /** A biometric-confirmed utterance seeds only its capture chain, never payment or guest authorization. */
  confirmDeviceOwner(embedding: Float32Array, input: DeviceOwnerConfirmationInput): Promise<{accepted: boolean}> {
    this.requireModelActive();
    check(validModel(input.speaker_model) && input.speaker_model.sha256 === this.model.sha256 &&
      input.speaker_model.id === this.model.id && input.speaker_model.dim === this.model.dim, 'VOICEPRINT_SPEAKER_MODEL_MISMATCH', 409);
    check(embedding instanceof Float32Array && embedding.length === this.model.dim && embedding.every(Number.isFinite), 'VOICEPRINT_EMBEDDING_INVALID');
    check(['file','phone_app','call','video','ambient','glasses','journal','mac'].includes(input.channel), 'VOICEPRINT_CHANNEL_INVALID');
    utc(input.observed_at);
    if (input.evidence_start_at !== undefined) {utc(input.evidence_start_at); check(input.evidence_start_at <= input.observed_at, 'VOICEPRINT_IDENTIFY_INPUT_INVALID');}
    check(Number.isFinite(input.speech_ms) && input.speech_ms >= 0, 'VOICEPRINT_IDENTIFY_INPUT_INVALID');
    check(input.quality === undefined || Number.isFinite(input.quality) && input.quality > 0 && input.quality <= 1, 'VOICEPRINT_QUALITY_INVALID');
    if (input.trust_scope) this.trustKey(input.trust_scope);
    check(input.call_id === undefined || isIdentifier(input.call_id), 'INVALID_ID');
    const e = unit(embedding);
    if (!e || input.speech_ms < CALL_INTERRUPT_MIN_SPEECH_MS || (input.quality ?? 1) < .5 || !this.callLearning) return Promise.resolve({accepted: false});
    return this.exclusive(async state => {
      const frozen = await this.ownerOverrideActive?.();
      this.requireModelActive();
      return frozen ? {accepted: false} : this.commit(state, next => {
      if (this.assistantMatch(next, e)) return {accepted: false};
      if (input.trust_scope && this.trustWindowActive(input.trust_scope)) {
        this.trustWindows.get(this.trustKey(input.trust_scope))!.anchors
          .set(JSON.stringify([input.channel, input.call_id ?? '']), e);
      }
      const current = this.callSet(next, input.channel);
      if (input.speech_ms < this.policy.min_identify_ms ||
        current && dot(e, decodeEmbedding(current.centroid, this.model.dim)) < this.policy.thresholds.trusted_centroid) return {accepted: false};
      this.learnVerified(next, e, {...input, mode: 'call'});
      const learned = this.callSet(next, input.channel);
      if (!learned || !learned.samples.some(sample => sample.embedding === encodeEmbedding(e))) return {accepted: false};
      learned.provenance = 'biometric_confirmed';
      this.absorbConfirmedVoice(next, e);
      return {accepted: true};
      });
    });
  }
  confirmCallOwner(embedding: Float32Array, input: Omit<DeviceOwnerConfirmationInput, 'channel'>): Promise<{accepted: boolean}> {
    return this.confirmDeviceOwner(embedding, {...input, channel: 'call'});
  }
  /** Confirmed same-chain evidence repairs anonymous owner clusters heard before that chain was enrolled. */
  private absorbConfirmedVoice(state: State, e: Float32Array): void {
    const absorbed = new Set(state.doc.clusters.filter(cluster => !cluster.display_name && !cluster.known_person_id &&
      state.clusters.has(cluster.cluster_id) && dot(e, state.clusters.get(cluster.cluster_id)!) >= this.policy.thresholds.cluster)
      .map(cluster => cluster.cluster_id));
    state.doc.clusters = state.doc.clusters.filter(cluster => !absorbed.has(cluster.cluster_id));
    for (const id of absorbed) state.clusters.delete(id);
  }
  private assistantMatch(state: State, e: Float32Array, ownerScore = this.ownerScore(state, e, true)): SpeakerIdentity | undefined {
    const assistant = Math.max(-1, ...[...state.assistant.values()].map(v => dot(e, v)));
    const other = Math.max(-1, ...[...state.clusters.values()].map(v => dot(e, v)));
    if (assistant >= this.policy.thresholds.assistant && assistant > ownerScore && assistant > other)
      return {kind: 'assistant', score: round(assistant)};
  }
  private trustIdentify(state: State, embedding: Float32Array, input: IdentifyInput): SpeakerIdentity | undefined {
    if (!input.principal_id || !input.device_id || input.mode === 'payment' || input.mode === 'interrupt') return;
    const scope = {principal_id: input.principal_id, device_id: input.device_id};
    const window = this.trustWindows.get(this.trustKey(scope)), observed = Date.parse(input.observed_at), now = Date.now();
    if (window && input.call_id && window.closed_calls.has(input.call_id)) return {kind: 'unknown', reason: 'unmatched'};
    if (!window || observed < window.opened || observed > now || !window.calls.size && observed >= window.expires) return;
    // Only a live window can hold a current call; queued evidence never reopens an expired window.
    if (input.mode === 'call' && input.call_id && this.trustWindowActive(scope)) window.calls.add(input.call_id);
    const e = unit(embedding);
    if (!e) return {kind: 'unknown', reason: 'low_quality'};
    const channel = input.channel ?? 'call', key = JSON.stringify([channel, input.call_id ?? '']);
    const anchor = window.anchors.get(key), current = this.callSet(state, channel);
    const score = anchor ? dot(e, anchor) : 1;
    const assistant = this.assistantMatch(state, e, Math.max(this.ownerScore(state, e, true), anchor ? score : -1,
      current ? dot(e, decodeEmbedding(current.centroid, this.model.dim)) : -1));
    if (assistant) return assistant;
    const independent = input.speech_ms >= this.policy.min_identify_ms && (input.quality ?? 1) >= .5 &&
      (input.evidence_start_at === undefined ? observed - input.speech_ms : Date.parse(input.evidence_start_at)) >= window.opened;
    if (independent && score >= this.policy.thresholds.call_anchor &&
      (!current || dot(e, decodeEmbedding(current.centroid, this.model.dim)) >= this.policy.thresholds.trusted_centroid)) {
      if (!anchor && input.learning !== false) window.anchors.set(key, e);
      if (input.learning !== false) {
        this.learnVerified(state, e, input);
        const learned = this.callSet(state, channel);
        if (learned?.samples.some(sample => sample.embedding === encodeEmbedding(e))) {
          learned.provenance = 'biometric_confirmed';
          this.absorbConfirmedVoice(state, e);
        }
      }
    }
    return {kind: 'owner', band: 'verified', score: round(score), call_only: true, trust_window: true};
  }
  /** Per-call anchors are owned by the call lifecycle; this read-only match grants call scope only. */
  matchCallAnchor(embedding: Float32Array, input: {anchor: Float32Array; speech_ms: number}): SpeakerIdentity {
    this.requireModelActive();
    check(embedding.length === this.model.dim && input.anchor.length === this.model.dim, 'VOICEPRINT_EMBEDDING_INVALID');
    check(Number.isFinite(input.speech_ms) && input.speech_ms >= 0, 'VOICEPRINT_IDENTIFY_INPUT_INVALID');
    if (input.speech_ms < CALL_INTERRUPT_MIN_SPEECH_MS) return {kind: 'unknown', reason: 'too_short'};
    const e = unit(embedding), anchor = unit(input.anchor);
    if (!e || !anchor) return {kind: 'unknown', reason: 'low_quality'};
    const score = dot(e, anchor);
    return score >= this.policy.thresholds.call_anchor ? {kind: 'owner', band: 'verified', score: round(score), call_only: true} :
      {kind: 'unknown', reason: 'unmatched'};
  }
  /** Independent sets are rechecked against current enrollment; biometric provenance remains independently trusted.
   * Enrollment and learned sets retain their first accepted max_owner_samples. */
  private revalidateLearned(state: State): void {
    for (const set of [state.doc.call_owner, ...Object.values(state.doc.learned_owner ?? {})]) {
      if (!set) continue;
      if (!this.ownerLive(set)) continue;
      const samples = set.samples;
      if (!samples.every(sample => sample.speech_ms >= this.policy.min_identify_ms &&
        (sample.quality ?? 1) >= .5 && (set.provenance === 'biometric_confirmed' ||
          this.ownerVerified(state, decodeEmbedding(sample.embedding, this.model.dim))))) continue;
      const vectors = samples.map(s => ({vector: decodeEmbedding(s.embedding, this.model.dim), weight: 1}));
      set.centroid = encodeEmbedding(blend(vectors));
      const scores = vectors.length === 1 ? [1] : vectors.map((v, i) => dot(v.vector, blend(vectors.filter((_, n) => n !== i))));
      if (scores.some(score => score < this.policy.thresholds.enroll_consistency)) continue;
      set.consistency = {min: round(Math.min(...scores)), mean: round(scores.reduce((a, b) => a + b, 0) / scores.length)};
      set.source_sets = this.callSources(state);
    }
  }
  private async decide(state: State, embedding: Float32Array, input: IdentifyInput, frozen=false): Promise<SpeakerIdentity> {
    // Interruption and payment never learn. Other channels use independent enrollment evidence only.
    const streaming=input.mode==='interrupt';
    const minimum = streaming ? CALL_INTERRUPT_MIN_SPEECH_MS : this.policy.min_assistant_ms;
    const short = input.speech_ms < (streaming ? minimum :
      input.request ? this.policy.min_turn_ms : this.policy.min_identify_ms);
    if (input.speech_ms < minimum || short && !state.assistant.size) return {kind: 'unknown', reason: 'too_short'};
    const e = embedding.every(Number.isFinite) ? unit(embedding) : undefined;
    if (!e) return {kind: 'unknown', reason: 'low_quality'};
    const t = this.policy.thresholds;
    const ownerScore = this.ownerScore(state, e, input.mode !== 'payment');
    const calibration = input.mode === 'payment' ? undefined : this.scoring.calibration?.[input.channel ?? (input.mode === 'call' ? 'call' : 'ambient')];
    const normalized = calibration && this.scoring.cohort ? Math.max(-Infinity, ...[...state.owner.values(), ...(state.doc.conversation_owner ?? []).filter(s => this.ownerLive(s)).map(s => decodeEmbedding(s.centroid, this.model.dim))].map(c =>
      normalizedScore(e, c, this.scoring.cohort!, this.scoring.cohort_top_k))) : ownerScore;
    const verified = this.ownerVerified(state, e, input.mode !== 'payment') && (!calibration || normalized >= calibration.verified);
    const uncertain = ownerScore >= t.owner_uncertain && (!calibration || normalized >= calibration.uncertain);
    let best: {cluster: ClusterDoc; centroid: Float32Array; score: number} | undefined;
    for (const cluster of state.doc.clusters) {
      const centroid = state.clusters.get(cluster.cluster_id);
      if (!centroid) continue;
      const score = dot(e, centroid);
      if (!best || score > best.score) best = {cluster, centroid, score};
    }
    // 依米's own reply heard back: it must sound more like the assistant than like the owner or anyone known. Its synthetic
    // voice is steady, so shorter speech is checked against it too — and only against it.
    let assistant = -1;
    for (const centroid of state.assistant.values()) assistant = Math.max(assistant, dot(e, centroid));
    if (assistant >= t.assistant && assistant > ownerScore && assistant > (best?.score ?? -1)) return {kind: 'assistant', score: round(assistant)};
    if (short) return {kind: 'unknown', reason: 'too_short'};
    const trustedCall = input.mode === 'call' && this.callSet(state, input.channel ?? 'call');
    if (trustedCall && trustedCall.provenance === 'biometric_confirmed' &&
      dot(e, decodeEmbedding(trustedCall.centroid, this.model.dim)) >= t.trusted_centroid &&
      dot(e, decodeEmbedding(trustedCall.centroid, this.model.dim)) > Math.max(best?.score ?? -1, assistant)) this.learnVerified(state, e, input);
    if (verified) {
      // A better known voice cannot seed the call set, even when also adjacent to the owner.
      if (this.ownerVerified(state, e) && ownerScore > Math.max(best?.score ?? -1, assistant)) this.learnVerified(state, e, input);
      return {kind: 'owner', band: 'verified', score: round(ownerScore)};
    }
    const nearOwner = uncertain;
    // A known other voice that matches better than the owner centroid is that person, never an uncertain owner.
    if (best && best.score >= t.cluster && (!nearOwner || best.score > ownerScore)) {
      // Owner-adjacent speech never moves another person's centroid.
      if (!frozen && input.mode === 'observe' && !nearOwner) {
        const weight = Math.min(best.cluster.count, this.policy.centroid_cap);
        const centroid = blend([{vector: best.centroid, weight}, {vector: e, weight: 1}]);
        state.clusters.set(best.cluster.cluster_id, centroid);
        best.cluster.centroid = encodeEmbedding(centroid); best.cluster.count += 1;
        best.cluster.speech_ms += Math.round(input.speech_ms);
        if (input.observed_at > best.cluster.last_seen) best.cluster.last_seen = input.observed_at;
        this.scheduleFlush();
      }
      return this.identity(best.cluster, best.score);
    }
    const call = this.callSet(state, input.channel ?? 'call');
    if (this.callLearning && (input.mode === 'call' || input.channel && input.mode !== 'payment' && input.mode !== 'interrupt') && call && (nearOwner || call.provenance === 'biometric_confirmed') && this.ownerLive(call) &&
      call.samples.length >= this.policy.min_enroll_samples) {
      const score = dot(e, decodeEmbedding(call.centroid, this.model.dim));
      if (score >= this.verifiedLine(state, call.channel) && score > Math.max(best?.score ?? -1, assistant)) {
        if (call.provenance === 'biometric_confirmed') this.learnVerified(state, e, input);
        return {kind: 'owner', band: 'verified', score: round(score), call_only: true};
      }
    }
    if (nearOwner) return {kind: 'owner', band: 'uncertain', score: round(ownerScore)};
    if (!frozen && input.mode === 'observe' && input.speech_ms >= this.policy.min_cluster_ms) {
      const created = await this.createCluster(state, e, input);
      if (created) return this.identity(created, 1);
    }
    return {kind: 'unknown', reason: input.mode==='call'&&input.speech_ms<this.policy.min_identify_ms?'too_short':state.owner.size?'unmatched':'no_enrollment'};
  }
  private async createCluster(state: State, e: Float32Array, input: {speech_ms: number; observed_at: string}): Promise<ClusterDoc | undefined> {
    const clusters = this.people(state);
    let evict: ClusterDoc | undefined;
    if (clusters.length >= this.policy.max_clusters) {
      // Owner-named people are never evicted; stale-model profiles go first, then the least recently heard.
      evict = clusters.filter(c => !c.display_name && !c.known_person_id)
        .sort((a, b) => Number(this.live(a.model_sha256)) - Number(this.live(b.model_sha256)) || (a.last_seen < b.last_seen ? -1 : 1))[0];
      if (!evict) return undefined;
    }
    return this.commit(state, next => {
      if (evict) {
        next.doc.clusters = next.doc.clusters.filter(c => c.cluster_id !== evict!.cluster_id);
        next.doc.face_people = (next.doc.face_people ?? []).filter(c => c.cluster_id !== evict!.cluster_id);
        next.clusters.delete(evict.cluster_id);
      }
      const cluster: ClusterDoc = {cluster_id: String(next.doc.next_number++), model_sha256: this.model.sha256, centroid: encodeEmbedding(e),
        count: 1, speech_ms: Math.round(input.speech_ms), created_at: input.observed_at, last_seen: input.observed_at};
      next.doc.clusters.push(cluster); next.clusters.set(cluster.cluster_id, e);
      return cluster;
    });
  }
  /** One sample of the assistant's own outgoing speech (≥ min_enroll_ms), embedded by the configured speaker model. Each
   *  source (`voice`) keeps its own profile; a sample that does not sound like its source's profile starts it afresh (the
   *  configured voice changed), so the profile follows whatever voice is configured without enrollment. A new profile is
   *  durable at once; later samples are written behind. */
  observeAssistant(input: {voice: string; embedding: Float32Array; speech_ms: number; at?: string}): Promise<AssistantVoiceView> {
    let e: Float32Array | undefined;
    try {
      this.requireModelActive();
      check(validVoice(input?.voice), 'VOICEPRINT_ASSISTANT_VOICE_INVALID');
      check(input.embedding instanceof Float32Array && input.embedding.length === this.model.dim && input.embedding.every(Number.isFinite),
        'VOICEPRINT_EMBEDDING_INVALID');
      e = unit(input.embedding); check(e, 'VOICEPRINT_EMBEDDING_INVALID');
      check(Number.isFinite(input.speech_ms) && input.speech_ms >= this.policy.min_enroll_ms, 'VOICEPRINT_ENROLLMENT_SAMPLE_TOO_SHORT', 422);
      if (input.at !== undefined) utc(input.at);
    } catch (error) {return Promise.reject(error);}
    const at = input.at ?? new Date().toISOString(), sample = e;
    return this.exclusive(async state => {
      await this.requireLearning();
      const doc = state.doc.assistant.find(v => v.voice === input.voice), current = doc && state.assistant.get(doc.voice);
      if (doc && current && dot(sample, current) >= this.policy.thresholds.assistant) {
        const centroid = blend([{vector: current, weight: Math.min(doc.count, this.policy.centroid_cap)}, {vector: sample, weight: 1}]);
        state.assistant.set(doc.voice, centroid);
        doc.centroid = encodeEmbedding(centroid); doc.count += 1; doc.speech_ms += Math.round(input.speech_ms);
        if (at > doc.last_seen) doc.last_seen = at;
        this.scheduleFlush();
        return this.assistantView(state, doc);
      }
      return this.commit(state, next => {
        const voices = next.doc.assistant.filter(v => v.voice !== input.voice);
        // Bounded: the least recently heard other source goes first.
        while (voices.length >= this.policy.max_assistant_voices) voices.splice(voices.indexOf([...voices].sort((a, b) => a.last_seen < b.last_seen ? -1 : 1)[0]!), 1);
        const created: AssistantDoc = {voice: input.voice, model_sha256: this.model.sha256, centroid: encodeEmbedding(sample), count: 1,
          speech_ms: Math.round(input.speech_ms), created_at: at, last_seen: at};
        next.doc.assistant = [...voices, created];
        next.assistant = new Map(voices.filter(v => next.assistant.has(v.voice)).map(v => [v.voice, next.assistant.get(v.voice)!]));
        next.assistant.set(created.voice, sample);
        // Ambient clusters of this voice formed before its profile existed would otherwise outscore it.
        const absorbed = next.doc.clusters.filter(c => !c.display_name && !c.known_person_id && next.clusters.has(c.cluster_id) &&
          dot(next.clusters.get(c.cluster_id)!, sample) >= this.policy.thresholds.assistant).map(c => c.cluster_id);
        next.doc.clusters = next.doc.clusters.filter(c => !absorbed.includes(c.cluster_id));
        for (const cluster of absorbed) next.clusters.delete(cluster);
        return this.assistantView(next, created);
      });
    });
  }
  assistantVoices(): Promise<AssistantVoiceView[]> {return this.exclusive(state => state.doc.assistant.map(v => this.assistantView(state, v)));}
  private assistantView(state: State, v: AssistantDoc): AssistantVoiceView {
    return {voice: v.voice, count: v.count, speech_ms: v.speech_ms, created_at: v.created_at, last_seen: v.last_seen, stale_model: !state.assistant.has(v.voice)};
  }
  conversationSource(channel: OwnerChannel): Promise<{device_id: string; device_type: string}|null> {
    return this.exclusive(state => state.doc.conversation_owner?.find(set => set.channel === channel)?.source_device ?? null);
  }
  /** A paired owner claims the first clean turn only without a live same-channel baseline. Otherwise that baseline verifies it.
   * Later turns must verify against the held candidate.
   * Unclaimed ambient clusters cannot block first enrollment; known people and dominant assistant voices cannot seed it. No learning or writes. */
  admitConversation(channel: OwnerChannel, embedding: Float32Array, candidate: readonly Float32Array[]): Promise<boolean> {
    check(channel !== 'call' && validChannel(channel), 'VOICEPRINT_CHANNEL_INVALID');
    check(embedding.length === this.model.dim, 'VOICEPRINT_EMBEDDING_INVALID');
    const e = unit(embedding); check(e, 'VOICEPRINT_EMBEDDING_INVALID');
    return this.exclusive(state => {
      const baselines = [...state.doc.owner_sets, ...(state.doc.conversation_owner ?? [])]
        .filter(set => set.channel === channel && this.ownerLive(set));
      const baseline = Math.max(-1, ...baselines.map(set => dot(e, decodeEmbedding(set.centroid, this.model.dim))));
      if (!candidate.length && baselines.length && baseline < this.verifiedLine(state, channel)) return false;
      const claimed = candidate.length ? blend(candidate.map(vector => ({vector: unit(vector)!, weight: 1}))) : undefined;
      const score = claimed ? dot(e, claimed) : baseline;
      const bootstrap = !candidate.length && !baselines.length;
      for (const cluster of state.doc.clusters) {
        const centroid = state.clusters.get(cluster.cluster_id); if (!centroid) continue;
        const match = dot(e, centroid), known = !!(cluster.display_name || cluster.known_person_id);
        if (!known && claimed && dot(claimed, centroid) >= this.policy.thresholds.cluster) continue;
        if (match >= this.policy.thresholds.cluster && match > score &&
          (!bootstrap || known)) return false;
      }
      for (const centroid of state.assistant.values()) {
        const assistant = dot(e, centroid);
        if (assistant >= this.policy.thresholds.assistant && assistant > score) return false;
      }
      return !candidate.length || score >= this.policy.thresholds.enroll_match;
    });
  }
  /** Owner enrollment of one capture channel's set from per-utterance embeddings of the configured speaker model: `replace`
   *  makes these utterances the channel's set, `add` extends its current set. Other channels' sets stay as they are; the
   *  returned status is the channel's. */
  enrollOwner(input: {speaker_model: SpeakerModel; channel: OwnerChannel; mode: 'replace' | 'add'; samples: {embedding: Float32Array; speech_ms: number; quality?: number}[];
    at?: string; purpose?: 'conversation'; check_only?: boolean; source_device?: {device_id: string; device_type: string}}): Promise<OwnerStatus & {absorbed_clusters: string[]}> {
    try {
      this.requireModelActive();
      check(validModel(input?.speaker_model) && input.speaker_model.sha256 === this.model.sha256 && input.speaker_model.dim === this.model.dim &&
        input.speaker_model.id === this.model.id, 'VOICEPRINT_SPEAKER_MODEL_MISMATCH', 409);
      check(input.channel !== 'call' && validChannel(input.channel), 'VOICEPRINT_CHANNEL_INVALID');
      check(['replace', 'add'].includes(input.mode) && Array.isArray(input.samples) && input.samples.length > 0 &&
        input.samples.length <= this.policy.max_owner_samples, 'VOICEPRINT_ENROLLMENT_INVALID');
      for (const sample of input.samples) {
        check(sample?.embedding instanceof Float32Array && sample.embedding.length === this.model.dim && sample.embedding.every(Number.isFinite) &&
          unit(sample.embedding), 'VOICEPRINT_EMBEDDING_INVALID');
        check(sample.quality === undefined || Number.isFinite(sample.quality) && sample.quality > 0 && sample.quality <= 1, 'VOICEPRINT_QUALITY_INVALID');
        check(Number.isFinite(sample.speech_ms) && sample.speech_ms >= this.policy.min_enroll_ms, 'VOICEPRINT_ENROLLMENT_SAMPLE_TOO_SHORT', 422);
      }
      if (input.at !== undefined) utc(input.at);
    } catch (error) {return Promise.reject(error);}
    const at = input.at ?? new Date().toISOString();
    return this.exclusive(async state => {
      check(input.check_only||!await this.ownerOverrideActive?.(),'VOICEPRINT_LEARNING_FROZEN',409);
      this.requireModelActive();
      const conversation = input.purpose === 'conversation';
      const set = (conversation ? state.doc.conversation_owner ?? [] : state.doc.owner_sets).find(s => s.channel === input.channel),
        current = set && this.ownerLive(set) ? set : undefined;
      check(input.mode === 'replace' || !set || current, 'VOICEPRINT_REENROLLMENT_REQUIRED', 409);
      const candidates = [...(input.mode === 'add' && current ? current.samples.map(sample => ({...sample, vector: unit(decodeEmbedding(sample.embedding, this.model.dim))!})) : []),
        ...input.samples.map(sample => ({embedding: encodeEmbedding(sample.embedding), speech_ms: Math.round(sample.speech_ms), added_at: at, ...(sample.quality === undefined ? {} : {quality: sample.quality}),
          vector: unit(sample.embedding)!}))];
      const samples = candidates.slice(0, this.policy.max_owner_samples);
      check(samples.length >= this.policy.min_enroll_samples, 'VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES', 422);
      // Leave-one-out within the set: every utterance must sound like the rest, or the profile would verify a second voice.
      // Never across channels: the same owner scores 0.42 between capture chains.
      const consistencyFor = (set: typeof candidates) => set.map((sample, index) =>
        round(dot(sample.vector, blend(set.filter((_, other) => other !== index).map(other => ({vector: other.vector, weight: other.speech_ms * (other.quality ?? 1)}))))));
      const candidateConsistency = consistencyFor(candidates);
      if (candidateConsistency.some(score => score < this.policy.thresholds.enroll_consistency))
        throw new VoiceprintEnrollmentError('VOICEPRINT_ENROLLMENT_INCONSISTENT', candidateConsistency);
      const consistency = candidates.length === samples.length ? candidateConsistency : consistencyFor(samples);
      if (consistency.some(score => score < this.policy.thresholds.enroll_consistency))
        throw new VoiceprintEnrollmentError('VOICEPRINT_ENROLLMENT_INCONSISTENT', [...consistency, ...candidateConsistency.slice(samples.length)]);
      const centroid = blend(samples.map(sample => ({vector: sample.vector, weight: sample.speech_ms * (sample.quality ?? 1)})));
      if (input.check_only) return {...this.ownerStatus(state, input.channel, conversation), absorbed_clusters: []};
      const result = await this.commit(state, next => {
        this.archiveVerifiedLines(next.doc);
        const enrolled: OwnerSetDoc = {channel: input.channel, model: {...this.model}, samples: samples.map(({vector: _vector, ...sample}) => sample),
          centroid: encodeEmbedding(centroid), enrolled_at: input.mode === 'add' && current ? current.enrolled_at : at, updated_at: at,
          consistency: {min: Math.min(...consistency), mean: round(consistency.reduce((sum, value) => sum + value, 0) / consistency.length)}};
        enrolled.verified_threshold = this.modelLine(next.doc,this.model,input.channel,this.paymentLine(state,input.channel)??this.policy.thresholds.owner_verified);
        this.rememberLine(next.doc,this.model,input.channel,enrolled.verified_threshold);
        if(this.enrollmentGeneration!==undefined)enrolled.enrollment_generation=this.enrollmentGeneration;
        if (conversation) {
          if (input.source_device) enrolled.source_device = {...input.source_device};
          next.doc.conversation_owner = [...(next.doc.conversation_owner ?? []).filter(s => s.channel !== input.channel), enrolled];
          if (!current || samples.length > current.samples.length || input.mode === 'replace') this.updateVerifiedLine(next, enrolled);
          return {...this.ownerStatus(next, input.channel, true), absorbed_clusters: []};
        }
        next.doc.owner_sets = [...next.doc.owner_sets.filter(s => s.channel !== input.channel), enrolled]
          .sort((a, b) => OWNER_CHANNELS.indexOf(a.channel) - OWNER_CHANNELS.indexOf(b.channel));
        next.owner.set(input.channel, centroid);
        if (!current || samples.length > current.samples.length || input.mode === 'replace') this.updateVerifiedLine(next, enrolled);
        this.revalidateLearned(next);
        // Earlier ambient clusters of the owner's own voice (heard through a channel no set covered yet) would otherwise
        // outscore the owner in the uncertain band.
        const absorbed = next.doc.clusters.filter(c => !c.display_name && !c.known_person_id && next.clusters.has(c.cluster_id) &&
          this.ownerScore(next, next.clusters.get(c.cluster_id)!) >= this.policy.thresholds.cluster).map(c => c.cluster_id);
        next.doc.clusters = next.doc.clusters.filter(c => !absorbed.includes(c.cluster_id));
        for (const cluster of absorbed) next.clusters.delete(cluster);
        return {...this.ownerStatus(next, input.channel), absorbed_clusters: absorbed};
      });
      this.requireModelActive();
      return result;
    });
  }
  /** "忘记我的声音": every channel, or only the selected capture channel. */
  forgetOwner(channel?: OwnerChannel): Promise<OwnerStatus> {
    if (channel !== undefined && !validChannel(channel)) return Promise.reject(new ContractError('VOICEPRINT_CHANNEL_INVALID'));
    this.clearTrustWindows();
    return this.exclusive(state => this.commit(state, next => {
      delete next.doc.call_owner; delete next.doc.learned_owner;
      next.doc.conversation_owner = (next.doc.conversation_owner ?? []).filter(set => channel !== undefined && set.channel !== channel);
      next.doc.owner_sets = next.doc.owner_sets.filter(set => channel !== undefined && set.channel !== channel);
      if(channel===undefined)delete next.doc.verified_lines;
      else if(next.doc.verified_lines)next.doc.verified_lines=next.doc.verified_lines.filter(line=>line.channel!==channel);
      if (channel === undefined) next.owner.clear(); else next.owner.delete(channel);
      return this.ownerStatus(next);
    }));
  }
  /** The whole profile, or one channel's set (the one a device enrolls and is heard through). */
  owner(channel?: OwnerChannel, conversation = false): Promise<OwnerStatus> {
    if (channel !== undefined && !validChannel(channel)) return Promise.reject(new ContractError('VOICEPRINT_CHANNEL_INVALID'));
    return this.exclusive(state => this.ownerStatus(state, channel, conversation));
  }
  private ownerStatus(state: State, channel?: OwnerChannel, conversation = false): OwnerStatus {
    const enrolled = conversation ? state.doc.conversation_owner ?? [] : state.doc.owner_sets;
    const all = [...enrolled, ...(!conversation && state.doc.call_owner ? [state.doc.call_owner] : [])];
    const sets = (channel === 'call' ? all : enrolled).filter(set => channel === undefined || set.channel === channel);
    const live = sets.filter(set => set.channel === 'call' ? this.callSet(state) && set.samples.length >= this.policy.min_enroll_samples : this.ownerLive(set)), samples = sets.reduce((n, set) => n + set.samples.length, 0);
    return {enrolled: live.length > 0, reenrollment_required: sets.length > 0 && !live.length, samples,
      speaker_model: sets.length ? {...(live[0] ?? sets[0]!).model} : null,
      enrolled_at: sets.length ? sets.map(set => set.enrolled_at).sort()[0]! : null,
      updated_at: sets.length ? sets.map(set => set.updated_at).sort().at(-1)! : null,
      consistency: sets.length ? {min: Math.min(...sets.map(set => set.consistency.min)),
        mean: round(sets.reduce((n, set) => n + set.consistency.mean * set.samples.length, 0) / samples)} : null,
      channels: all.map(set => ({channel: set.channel, samples: set.samples.length, enrolled_at: set.enrolled_at,
        verified_threshold: this.modelLine(state.doc,set.model,set.channel,this.sameModel(set.model,this.model)?this.policy.thresholds.owner_verified:DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified),
        updated_at: set.updated_at, consistency: {...set.consistency}, stale_model: set.channel === 'call' ? !this.callSet(state) : !this.ownerLive(set)}))};
  }
  /** No embeddings or names: bounded process verdicts and a separately recorded offline evaluation. */
  status(): Promise<unknown> {
    return this.exclusive(async state => {
      const distribution: Record<string, Record<string, number>> = {};
      for(const row of this.recent){const channel = distribution[row.channel] ??= {}; channel[row.verdict] = (channel[row.verdict] ?? 0) + 1;}
      let harness: unknown = null;
      try {harness = JSON.parse(Buffer.from(await this.storage.read('voiceprint-evaluations', digest('last'))).toString());}
      catch(error){if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      return {owner: this.ownerStatus(state), clusters: state.doc.clusters.length, assistant_voices: state.doc.assistant.length,
        verified_thresholds:Object.fromEntries(this.ownerSets(state).map(set=>[set.channel,this.verifiedLine(state,set.channel)])),
        learned_samples: Object.fromEntries([
          ...(this.callSet(state) ? [['call', this.callSet(state)!.samples.length]] : []),
          ...Object.keys(state.doc.learned_owner ?? {}).map(channel => [channel, this.callSet(state, channel as VoiceprintChannel)?.samples.length ?? 0])]),
        recent_verdicts: {scope: 'current_process_last_200', count: this.recent.length, distribution}, last_harness_result: harness};
    });
  }
  clusters(): Promise<ClusterView[]> {
    return this.exclusive(state => this.people(state).map(c => this.view(state, c)).sort((a, b) => a.last_seen < b.last_seen ? 1 : -1));
  }
  private view(state: State, c: ClusterDoc): ClusterView {
    return {cluster_id: c.cluster_id, label: c.display_name ?? `${c.count > 0 ? '说话人' : '人物'}#${c.cluster_id}`, display_name: c.display_name ?? null,
      known_person_id: c.known_person_id ?? null, count: c.count, speech_ms: c.speech_ms, created_at: c.created_at, last_seen: c.last_seen,
      stale_model: c.count > 0 && !state.clusters.has(c.cluster_id), ...(c.aliases ? {aliases: structuredClone(c.aliases)} : {})};
  }
  private people(state: State): ClusterDoc[] {return [...state.doc.clusters, ...(state.doc.face_people ?? [])];}
  private find(state: State, clusterId: unknown): ClusterDoc {
    check(isIdentifier(clusterId), 'INVALID_ID');
    const cluster = this.people(state).find(c => c.cluster_id === clusterId);
    check(cluster, 'VOICEPRINT_CLUSTER_NOT_FOUND', 404);
    return cluster;
  }
  /** Owner naming: `null` clears a field; an absent field is unchanged. Optional merge and naming commit together. */
  renameCluster(clusterId: string, update: {display_name?: string | null; known_person_id?: string | null}, mergeFromId?: string): Promise<ClusterView> {
    try {
      check(update && typeof update === 'object' && Object.keys(update).length > 0 &&
        Object.keys(update).every(key => ['display_name', 'known_person_id'].includes(key)), 'VOICEPRINT_RENAME_INVALID');
      check(update.display_name === undefined || update.display_name === null || typeof update.display_name === 'string' &&
        update.display_name.trim().length > 0 && update.display_name.trim().length <= 64, 'VOICEPRINT_DISPLAY_NAME_INVALID');
      check(update.known_person_id === undefined || update.known_person_id === null || isIdentifier(update.known_person_id), 'INVALID_ID');
    } catch (error) {return Promise.reject(error);}
    return this.updateCluster(clusterId, mergeFromId, update);
  }
  /** Folds `sourceId` into `targetId` (one person heard as two); the source number is never reused. */
  mergeClusters(targetId: string, sourceId: string): Promise<ClusterView> {
    return this.updateCluster(targetId, sourceId);
  }
  private updateCluster(targetId: string, sourceId?: string, update?: {display_name?: string | null; known_person_id?: string | null}): Promise<ClusterView> {
    return this.exclusive(state => {
      const target = this.find(state, targetId), source = sourceId === undefined ? undefined : this.find(state, sourceId);
      if (source) {
        check(target !== source, 'VOICEPRINT_MERGE_INVALID');
        check((target.count === 0 || state.clusters.has(target.cluster_id)) && (source.count === 0 || state.clusters.has(source.cluster_id)),
          'VOICEPRINT_CLUSTER_MODEL_MISMATCH', 409);
        check(!target.known_person_id || !source.known_person_id || target.known_person_id === source.known_person_id, 'VOICEPRINT_PERSON_MERGE_CONFLICT', 409);
      }
      return this.commit(state, next => {
        const into = this.find(next, targetId);
        if (source) {
          const from = this.find(next, source.cluster_id);
          const voices = [into, from].filter(c => c.count > 0).map(c => ({vector: next.clusters.get(c.cluster_id)!, weight: Math.min(c.count, this.policy.centroid_cap)}));
          if (voices.length) {
            const centroid = blend(voices); into.centroid = encodeEmbedding(centroid); into.model_sha256 = this.model.sha256;
            next.clusters.set(into.cluster_id, centroid);
          }
          into.face_samples = [...(into.face_samples ?? []), ...(from.face_samples ?? [])].slice(-20);
          into.aliases = {ids: [...new Set([...(into.aliases?.ids ?? []), from.cluster_id, ...(from.aliases?.ids ?? [])])],
            names: [...new Set([...(into.aliases?.names ?? []), ...(from.aliases?.names ?? []), ...(from.display_name ? [from.display_name] : [])])]};
          into.count += from.count; into.speech_ms += from.speech_ms;
          if (from.created_at < into.created_at) into.created_at = from.created_at;
          if (from.last_seen > into.last_seen) into.last_seen = from.last_seen;
          if (!into.display_name && from.display_name) into.display_name = from.display_name;
          if (!into.known_person_id && from.known_person_id) into.known_person_id = from.known_person_id;
          next.clusters.delete(from.cluster_id);
          next.doc.clusters = next.doc.clusters.filter(c => c.cluster_id !== from.cluster_id);
          next.doc.face_people = (next.doc.face_people ?? []).filter(c => c.cluster_id !== from.cluster_id && c.cluster_id !== into.cluster_id);
          if (into.count > 0 && !next.doc.clusters.includes(into)) next.doc.clusters.push(into);
          if (into.count === 0) next.doc.face_people.push(into);

        }
        if (update?.display_name !== undefined && into.display_name && update.display_name?.trim() !== into.display_name) {
          into.aliases ??= {ids: [], names: []};
          into.aliases.names = [...new Set([...into.aliases.names, into.display_name])];
        }
        if (update?.display_name === null) delete into.display_name;
        else if (update?.display_name !== undefined) into.display_name = update.display_name.trim();
        if (update?.known_person_id === null) delete into.known_person_id;
        else if (update?.known_person_id !== undefined) into.known_person_id = update.known_person_id;
        return this.view(next, into);
      });
    });
  }
  /** Owner setting persists in the same atomic authority. Off does not alter existing evidence. */
  faceRecognition(enabled?: boolean): Promise<{enabled: boolean}> {
    if (enabled !== undefined && typeof enabled !== 'boolean') return Promise.reject(new ContractError('FACE_SETTING_INVALID'));
    if (enabled !== undefined) this.faceGeneration++;
    return this.exclusive(state => enabled === undefined || enabled === Boolean(state.doc.face_recognition) ?
      {enabled: Boolean(state.doc.face_recognition)} : this.commit(state, next => {next.doc.face_recognition = enabled; return {enabled};}));
  }
  recognitionHints(enabled?: boolean): Promise<{enabled: boolean}> {
    if (enabled !== undefined && typeof enabled !== 'boolean') return Promise.reject(new ContractError('RECOGNITION_HINTS_SETTING_INVALID'));
    return this.exclusive(state => enabled === undefined || enabled === (state.doc.recognition_hints ?? true) ?
      {enabled: state.doc.recognition_hints ?? true} : this.commit(state, next => {next.doc.recognition_hints = enabled; return {enabled};}));
  }
  /** Voice and face share transient presence; observations never rewrite persistent biometric evidence. */
  newPersonNearby(clusterId: string, at: string): Promise<ClusterView | undefined> {
    utc(at);
    return this.exclusive(state => {
      const person = this.find(state, clusterId), prior = this.nearbySeen.get(clusterId);
      if (prior && at <= prior) return undefined;
      this.nearbySeen.set(clusterId, at);
      return (!prior || Date.parse(at) - Date.parse(prior) > 120000) && (state.doc.recognition_hints ?? true) &&
        (person.display_name || person.known_person_id) ? this.view(state, person) : undefined;
    });
  }
  nearbyPeople(at = new Date().toISOString()): Promise<ClusterView[]> {
    utc(at); const now = Date.parse(at);
    return this.exclusive(state => this.people(state).filter(p => {
      const seen = this.nearbySeen.get(p.cluster_id), elapsed = seen === undefined ? Infinity : now - Date.parse(seen);
      return (p.display_name || p.known_person_id) && elapsed >= 0 && elapsed <= 120000;
    }).map(p => this.view(state, p)));
  }
  /** Generation fences setting changes and evidence deletion while external inference is running. */
  beginFaceFrame(): Promise<number | null> {
    return this.exclusive(state => state.doc.face_recognition ? this.faceGeneration : null);
  }
  /** Producer-validated face vectors are matched and committed together under one short registry lock. */
  commitFaceFrame(input: {frame_id: string; at: string}, vectors: Float32Array[], generation: number): Promise<ClusterView[]> {
    return this.exclusive(async state => {
      if (!state.doc.face_recognition || generation !== this.faceGeneration || !vectors.length) return [];
      check(isIdentifier(input.frame_id), 'INVALID_ID'); utc(input.at);
      const matches = await this.commit(state, next => {
        const matched = new Map<string, ClusterDoc>();
        for (const embedding of vectors) {
          const e = unit(embedding); check(e, 'FACE_EMBEDDING_INVALID');
          let best: ClusterDoc | undefined, score = -1;
          for (const person of this.people(next)) for (const sample of person.face_samples ?? []) {
            const similarity = dot(e, decodeEmbedding(sample.embedding, SFACE_DIM));
            if (similarity > score) {score = similarity; best = person;}
          }
          let person = best && score >= SFACE_COSINE_THRESHOLD ? best : undefined;
          if (!person) {
            if (this.people(next).length >= this.policy.max_clusters) continue;
            person = {cluster_id: String(next.doc.next_number++), model_sha256: this.model.sha256, centroid: '', count: 0,
              speech_ms: 0, created_at: input.at, last_seen: input.at};
            (next.doc.face_people ??= []).push(person);
          }
          person.face_samples = [...(person.face_samples ?? []).filter(sample => sample.frame_id !== input.frame_id),
            {frame_id: input.frame_id, embedding: encodeEmbedding(e), at: input.at}].slice(-20);
          if (input.at > person.last_seen) person.last_seen = input.at;
          matched.set(person.cluster_id, person);
        }
        return [...matched.values()].map(person => this.view(next, person));
      });
      this.visual?.linkFramePeople(input.frame_id, matches.map(person => person.cluster_id));
      return matches;
    });
  }
  /** Current names from durable frame links, independent of the bounded biometric exemplars. */
  peopleInFrames(frameIds: string[]): Promise<ClusterView[]> {
    if (!Array.isArray(frameIds) || !frameIds.every(isIdentifier)) return Promise.reject(new ContractError('INVALID_ID'));
    return this.exclusive(state => {
      const ids = new Set(this.visual?.personIdsInFrames(frameIds) ?? []);
      return this.people(state).filter(person => ids.has(person.cluster_id) || person.aliases?.ids.some(id => ids.has(id)))
        .map(person => this.view(state, person));
    });
  }
  /** A known person query uses exact frame links; an unrecognized reference remains a visual text query. */
  frameIdsForPerson(reference: string): Promise<string[] | null> {
    return this.exclusive(state => {
      const people = this.people(state), labels = new Set(resolveSpeaker(reference, people.map(person => this.view(state, person))));
      const matches = people.filter(person => labels.has(`speaker:${person.cluster_id}`));
      return matches.length ? this.visual?.framesForPeople(matches.flatMap(person => [person.cluster_id, ...(person.aliases?.ids ?? [])])) ?? [] : null;
    });
  }
  /** Retract exact links and exemplars; `removed` counts biometric samples. */
  deleteFrameEvidence(frameIds: string[]): Promise<{removed: number}> {
    if (!Array.isArray(frameIds) || !frameIds.every(isIdentifier)) return Promise.reject(new ContractError('INVALID_ID'));
    const ids = new Set(frameIds);
    return this.pruneFaceEvidence(frameId => !ids.has(frameId), frameIds).then(result => {this.visual?.deleteFrameLinks(frameIds); return result;});
  }
  /** Restore/open keeps only valid exemplars; warm frame links keep their person alive. */
  pruneFaceEvidence(keep: (frame_id: string) => boolean, excluding: string[] = []): Promise<{removed: number}> {
    this.faceGeneration++;
    return this.exclusive(state => {
      const retained = new Map(this.people(state).map(person =>
        [person.cluster_id, (person.face_samples ?? []).filter(sample => keep(sample.frame_id))]));
      const removed = this.people(state).reduce((n, person) =>
        n + (person.face_samples?.length ?? 0) - retained.get(person.cluster_id)!.length, 0);
      const empty = new Set((state.doc.face_people ?? []).filter(person => !retained.get(person.cluster_id)!.length &&
        !this.visual?.hasPersonFrames([person.cluster_id, ...(person.aliases?.ids ?? [])], excluding)).map(person => person.cluster_id));
      if (!removed && !empty.size) return {removed: 0};
      return this.commit(state, next => {
        for (const person of this.people(next)) person.face_samples = retained.get(person.cluster_id)!;
        next.doc.face_people = (next.doc.face_people ?? []).filter(person => !empty.has(person.cluster_id));
        return {removed};
      });
    });
  }
  /** Deletes all people, including voice/face exemplars and frame links; owner enrollment and assistant voice are separate. */
  forgetAll(): Promise<{forgotten: number}> {
    this.faceGeneration++;
    return this.exclusive(state => this.commit(state, next => {
      const forgotten = this.people(next).length; next.doc.clusters = []; next.doc.face_people = []; next.clusters.clear(); return {forgotten};
    }));
  }
  forgetCluster(clusterId: string): Promise<{forgotten: string}> {
    this.faceGeneration++;
    return this.exclusive(state => {
      this.find(state, clusterId);
      return this.commit(state, next => {
        next.doc.clusters = next.doc.clusters.filter(c => c.cluster_id !== clusterId);
        next.doc.face_people = (next.doc.face_people ?? []).filter(c => c.cluster_id !== clusterId);
        next.clusters.delete(clusterId);
        return {forgotten: clusterId};
      });
    });
  }
}
