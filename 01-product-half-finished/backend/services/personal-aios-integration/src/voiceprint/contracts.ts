/** Local speech and voiceprint contracts. One engine (sherpa-onnx, in-process on the Mac) produces transcripts and
 *  speaker embeddings; one registry decides who spoke. Embeddings and voiceprints stay on the deployment host. */
import { check, isIdentifier } from '../contracts.ts';

/** Who spoke one speech segment, decided only by the local voiceprint registry. */
export type SpeakerIdentity =
  /** The enrolled owner. `uncertain` may chat but needs the paired phone's "确认是我" before any sensitive action. */
  | {kind: 'owner'; band: 'verified' | 'uncertain'; score: number; call_only?: true; trust_window?: true}
  /** A persistent other-person profile ("说话人#12"), optionally named by the owner ("老王"). */
  | {kind: 'speaker'; cluster_id: string; display_name?: string; known_person_id?: string; score: number}
  /** 依米's own voice: a reply the phone or glasses played, heard again by a microphone. Never the owner, never a person,
   *  never a wake word or a request. */
  | {kind: 'assistant'; score: number}
  /** `unmatched`: the owner is enrolled, no profile matched and none was created (verify mode, short or capped). */
  | {kind: 'unknown'; reason: 'too_short' | 'no_enrollment' | 'low_quality' | 'unmatched'};

/** Minimum current-utterance evidence for playback interruption only; identity admission keeps its own longer floors. */
export const CALL_INTERRUPT_MIN_SPEECH_MS = 200;

/** `observe` (ambient) may create or update another-person cluster; `verify` (a request turn) learns only when an explicit channel is supplied. `request`: a
 *  turn identified over its opening (the wake word, or a follow-up's carrier: the replied request's speech) and a short
 *  request together carries the request alone — its embedding (null when too short to embed) and speech — which must
 *  itself sound like the owner for the owner to be verified. `interrupt` is read-only evidence for stopping call
 *  playback; never use its result to grant owner scope. `call` may retain bounded, independently verified call-chain samples for the turn manager:
 *  verified matches may answer; `call_only` evidence cannot authorize guests and is never used by payment or guest authorization; a short unmatched window remains undecided until min_identify_ms. */
export type VoiceprintChannel = 'file' | 'phone_app' | 'call' | 'video' | 'ambient' | 'glasses' | 'journal' | 'mac';
export interface IdentifyInput {signal?: AbortSignal; principal_id?: string; device_id?: string; call_id?: string; quality?: number; learning?: false; evidence_start_at?: string; channel?: VoiceprintChannel; speech_ms: number; observed_at: string; mode: 'observe' | 'verify' | 'interrupt' | 'call' | 'payment'; request?: {embedding: Float32Array | null; speech_ms?: number}}
/** The longest audio one turn analysis reads (the turn consumer's budget): a wake turn (the lane caps it at 20 s) or a
 *  follow-up whose window opens with the replied request's speech and ends with the follow-up's words. */
export const TURN_WINDOW_MAX_MS = 60000;
export interface SpeakerIdentifier {
  /** The speaker model whose embedding space the profiles live in; embeddings from any other model must not be identified. */
  readonly model: {id: string; sha256: string; dim: number};
  identify(embedding: Float32Array, input: IdentifyInput): Promise<SpeakerIdentity>;
}

/** AudioSet labels and their journal/care meaning. Observations, never diagnoses; SenseVoice uses the same event names. */
export const HEALTH_SOUNDS={
  cough:['Cough','咳嗽'],sneeze:['Sneeze','打喷嚏'],sniff:['Sniff','吸鼻子'],snort:['Snort','鼻息'],
  throat_clearing:['Throat clearing','清嗓子'],breath:['Breathing','呼吸声'],wheeze:['Wheeze','喘鸣'],gasp:['Gasp','倒吸气'],pant:['Pant','喘气'],
  groan:['Groan','呻吟'],moan:['Wail, moan','哀鸣'],whimper:['Whimper','呜咽'],cry:['Crying, sobbing','哭'],baby_cry:['Baby cry, infant cry','婴儿哭声'],
  snore:['Snoring','打鼾'],hiccup:['Hiccup','打嗝'],grunt:['Grunt','哼声'],sigh:['Sigh','叹气'],scream:['Screaming','尖叫'],
} as const;
export type SoundEvent='bgm'|'laughter'|'applause'|'sing'|'speech_noise'|keyof typeof HEALTH_SOUNDS;
export const SOUND_EVENTS:readonly SoundEvent[]=['bgm','laughter','applause','sing','speech_noise',...Object.keys(HEALTH_SOUNDS) as (keyof typeof HEALTH_SOUNDS)[]];
export const SPEECH_EMOTIONS=['happy','sad','angry','neutral','fearful','disgusted','surprised','other','unknown'] as const;
export type SpeechEmotion=typeof SPEECH_EMOTIONS[number];
export interface SpeechTranscript {text:string;lang?:string;event?:SoundEvent;emotion?:SpeechEmotion}
/** Native fields use <|Token|>. Ignore Speech/unknown event markers rather than inventing a sound. */
export function senseVoiceTranscript(result:{text:string;lang?:string;event?:string;emotion?:string}):SpeechTranscript {
  const token=(value:string|undefined)=>/^<\|([^|]+)\|>$/u.exec(value??'')?.[1]?.toLowerCase();
  const lang=token(result.lang),event=token(result.event),mood=token(result.emotion),emotion=mood==='emo_unknown'?'unknown':mood;
  return {text:result.text.trim(),...(lang&&/^[a-z]{2,8}$/u.test(lang)&&lang!=='nospeech'?{lang}:{}),
    ...(SOUND_EVENTS.includes(event as SoundEvent)?{event:event as SoundEvent}:{}),
    ...(SPEECH_EMOTIONS.includes(emotion as SpeechEmotion)?{emotion:emotion as SpeechEmotion}:{})};
}

export interface SpeechEngine {
  readonly asr_model: {id: string; sha256: string};
  readonly speaker_model: {id: string; sha256: string; dim: number};
  readonly tagging_model?: {id:string;sha256:string;labels_sha256:string}|undefined;
  /** 16 kHz mono float samples in [-1, 1]. */
  transcribe(samples: Float32Array, signal?: AbortSignal): Promise<SpeechTranscript>;
  transcribeWords?(samples:Float32Array,signal?:AbortSignal):Promise<string>;
  tag?(samples:Float32Array,signal?:AbortSignal):Promise<SoundEvent|undefined>;
  embed(samples: Float32Array, signal?: AbortSignal): Promise<Float32Array>;
  close(): Promise<void>;
}

/** The longest input one native speaker or tagging call runs on. ERes2NetV2's working set grows ~25 MiB per second of
 *  input (10 s ~250 MiB, 60 s ~1.45 GiB), and the zipformer tagger aborts the process past ~30 s. */
export const NATIVE_WINDOW_SAMPLES = 160000;
/** Canonical non-overlapping windows: fixed 3 s prefix, balanced final pair, never a tiny tail. */
export const SPEAKER_WINDOW_SAMPLES = 3 * 16000;
/** One immutable utterance's completed windows only; owned and discarded by its existing turn lifecycle. */
export type SpeechEmbeddingCache = Map<number, Float32Array>;
export function speakerWindows(samples: Float32Array): Float32Array[] {
  const size=SPEAKER_WINDOW_SAMPLES,complete=Math.floor(samples.length/size),tail=samples.length%size;
  const prefix=Math.max(0,complete-(tail?1:0)),windows:Float32Array[]=[];
  for(let n=0;n<prefix;n++)windows.push(samples.subarray(n*size,(n+1)*size));
  const start=prefix*size,remaining=samples.length-start,count=Math.ceil(remaining/size);
  for(let n=0;n<count;n++)windows.push(samples.subarray(start+Math.floor(n*remaining/count),start+Math.floor((n+1)*remaining/count)));
  return windows.length?windows:[samples];
}
/** Acoustic weight: clipped speech contributes less. Enrollment also measures SNR against VAD silence. */
export function speechQuality(samples: Float32Array): number {
  let clipped = 0;
  for (const value of samples) if (Math.abs(value) >= .99) clipped++;
  return Math.max(.01, 1 - clipped / Math.max(1, samples.length));
}
/** All consumers, including payment, embed alike. Payment isolation is enforced by identify mode `payment`.
 * Short speech keeps the native result; longer speech averages unit vectors by speech length and acoustic quality. */
export async function embedSpeech(engine: Pick<SpeechEngine, 'embed'>, samples: Float32Array, signal?: AbortSignal, options: {quality_weighting?: boolean; cache?: SpeechEmbeddingCache} = {}): Promise<Float32Array> {
  const windows = speakerWindows(samples);
  const infer=async(part:Float32Array,offset:number)=>{
    const fixed=part.length===SPEAKER_WINDOW_SAMPLES,cached=fixed?options.cache?.get(offset):undefined;
    if(cached)return cached;
    const vector=await engine.embed(part,signal);
    if(fixed)options.cache?.set(offset,vector);
    return vector;
  };
  if (windows.length === 1) return infer(samples,0);
  let offset=0;
  let sum: Float32Array | undefined;
  for (const part of windows) {
    const vector = await infer(part,offset); offset+=part.length;
    let norm = 0; for (const value of vector) norm += value * value;
    check(vector.length > 0 && vector.every(Number.isFinite) && norm > 0 && (!sum || sum.length === vector.length), 'SPEECH_EMBEDDING_INVALID', 503);
    const weight = part.length * (options.quality_weighting === false ? 1 : speechQuality(part)) / Math.sqrt(norm); sum ??= new Float32Array(vector.length);
    for (let n = 0; n < vector.length; n++) sum[n]! += vector[n]! * weight;
  }
  let norm = 0; for (const value of sum!) norm += value * value;
  check(norm > 0, 'SPEECH_EMBEDDING_INVALID', 503);
  return sum!.map(value => value / Math.sqrt(norm));
}

/** The segment label written into SampleAudioResult.segments[].speaker and D.speakers. */
export function speakerLabel(identity: SpeakerIdentity): string | undefined {
  if (identity.kind === 'owner') return identity.band === 'verified' ? 'owner' : 'owner_uncertain';
  if (identity.kind === 'speaker') return `speaker:${identity.cluster_id}`;
  if (identity.kind === 'assistant') return 'assistant';
  return undefined;
}

// The audio cut normally removes the wake word; this strips a leading one SenseVoice still transcribed (依/一/伊/衣米, 意味).
const LEADING_WAKE = /^[\s\p{P}\p{S}]*(?:(?:嗯|啊|哎|呃)[\s\p{P}]*)?(?:(?:依|一|伊|衣)米|意味)[\s\p{P}\p{S}]*/u;
export function stripWake(text: string): string {return text.replace(LEADING_WAKE, '').trim();}
/** Whether an utterance in which the spotter heard the wake word also holds the request: at least 300 ms after where the
 *  wake word ends, and words once a leading wake word is stripped from its text. Otherwise the wake word was said alone and
 *  the request follows (the owner's "依米" alone, 0.42 / 0.52 s, decodes only at the utterance's end, cut 350 ms before it,
 *  and transcribes as "意味？"). The one rule for the lane opening a turn and the turn consumer cutting it. */
export function wakeCarriesRequest(text: string, after_wake_ms: number): boolean {return after_wake_ms >= 300 && stripWake(text) !== '';}
/** One wake-word hit; `at_sample` counts the samples fed to that stream when the hit decoded. */
export interface KeywordHit {keyword: string; at_sample: number}
export interface KeywordStream {
  /** 16 kHz mono float samples in [-1, 1], any length. */
  write(samples: Float32Array): Promise<KeywordHit[]>;
  /** Pads trailing silence, decodes what is left and ends the stream. */
  finish(): Promise<KeywordHit[]>;
  close(): Promise<void>;
}
/** Streaming keyword spotter for the ambient lane; keywords and thresholds are engine configuration. */
export interface KeywordSpotterFactory {open(signal: AbortSignal): Promise<KeywordStream>}

/** Inverse of speakerLabel; anything else is not a voiceprint label. */
export function parseSpeakerLabel(label: unknown):
  {kind: 'owner'; band: 'verified' | 'uncertain'} | {kind: 'speaker'; cluster_id: string} | {kind: 'assistant'} | undefined {
  if (label === 'owner') return {kind: 'owner', band: 'verified'};
  if (label === 'assistant') return {kind: 'assistant'};
  if (label === 'owner_uncertain') return {kind: 'owner', band: 'uncertain'};
  if (typeof label === 'string' && label.startsWith('speaker:') && isIdentifier(label.slice(8))) return {kind: 'speaker', cluster_id: label.slice(8)};
  return undefined;
}
