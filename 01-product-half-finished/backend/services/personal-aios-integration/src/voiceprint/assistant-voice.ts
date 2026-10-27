import {embedSpeech} from './contracts.ts';
import { check } from '../contracts.ts';
import { wavSamples, type TtsAudio, type TtsPort } from '../tts.ts';
import type { AssistantVoiceView } from './registry.ts';

/** The engine surface the learner needs (LocalSpeechEngine, or a controlled one in tests). */
export interface AssistantVoiceEngine {
  readonly speaker_model: {sha256: string; dim: number};
  idle(): boolean;
  embed(samples: Float32Array, signal?: AbortSignal): Promise<Float32Array>;
}
/** The registry surface that keeps the assistant's voice profiles. */
export interface AssistantVoiceProfiles {
  readonly model: {sha256: string; dim: number};
  observeAssistant(input: {voice: string; embedding: Float32Array; speech_ms: number}): Promise<AssistantVoiceView>;
}
/** At most `max_ms` of an utterance is kept; one sample per source per `interval_ms`; `min_ms` of speech or none. */
export interface AssistantVoicePolicy {max_ms: number; min_ms: number; interval_ms: number}
export const DEFAULT_ASSISTANT_VOICE_POLICY: AssistantVoicePolicy = Object.freeze({max_ms: 8000, min_ms: 1500, interval_ms: 60000});
export interface AssistantUtterance {push(pcm: Int16Array): void; end(): void}

/** 16 kHz mono floats in [-1, 1] from PCM16 at `rate`: Hann-windowed sinc, ±32 input taps, low-passed at 0.94 of the lower
 *  Nyquist frequency (24 kHz in: flat to 7 kHz, -5.6 dB at 7.5 kHz, < -60 dB from 8.5 kHz, so nothing folds into the voice band). */
export function to16k(pcm: Int16Array, rate: number): Float32Array {
  check(Number.isSafeInteger(rate) && rate >= 8000 && rate <= 48000, 'ASSISTANT_VOICE_RATE_INVALID');
  if (rate === 16000) return Float32Array.from(pcm, value => value / 32768);
  const ratio = rate / 16000, cutoff = Math.min(1, 1 / ratio) * 0.94, taps = 32, out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let n = 0; n < out.length; n++) {
    const t = n * ratio, center = Math.floor(t);
    let sum = 0;
    for (let k = Math.max(0, center - taps + 1); k <= Math.min(pcm.length - 1, center + taps); k++) {
      const x = t - k, window = 0.5 + 0.5 * Math.cos(Math.PI * x / taps);
      sum += pcm[k]! * window * (x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x));
    }
    out[n] = sum / 32768;
  }
  return out;
}
/** Leading and trailing silence (20 ms frames under -40 dBFS) removed, 100 ms kept on each side. */
function trimmed(samples: Float32Array): Float32Array {
  const frame = 320, loud = (at: number) => {let energy = 0; for (let i = at; i < at + frame; i++) energy += samples[i]! * samples[i]!; return energy / frame > 1e-4;};
  let first = -1, last = -1;
  for (let at = 0; at + frame <= samples.length; at += frame) if (loud(at)) {if (first < 0) first = at; last = at + frame;}
  return first < 0 ? new Float32Array(0) : samples.slice(Math.max(0, first - 1600), Math.min(samples.length, last + 1600));
}

/** Learns 依米's own voice from the speech the system sends out — the replies the system TTS synthesizes for formal voice
 *  playback, the live call's realtime voice — so a reply a microphone hears back is recognised whatever voice is
 *  configured, without enrollment. Bounded and best effort: at most `max_ms` of an utterance is kept, one sample per
 *  source per `interval_ms`, one embedding at a time and only while the speech engine is idle. Queued listening wins;
 *  an already running native embedding cannot be preempted. A failure is reported, never thrown into the speaking path. */
export class AssistantVoiceLearner {
  private readonly engine: () => Promise<AssistantVoiceEngine>;
  private readonly profiles: AssistantVoiceProfiles;
  private readonly policy: AssistantVoicePolicy;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private readonly learned = new Map<string, number>();
  private active: Promise<void> | undefined;
  private closed = false;
  constructor(engine: () => Promise<AssistantVoiceEngine>, profiles: AssistantVoiceProfiles,
    options: {policy?: Partial<AssistantVoicePolicy>; onError?: (error: unknown) => void; now?: () => number} = {}) {
    const policy = {...DEFAULT_ASSISTANT_VOICE_POLICY, ...options.policy};
    check(Object.values(policy).every(value => Number.isSafeInteger(value) && value > 0) && policy.max_ms >= policy.min_ms, 'ASSISTANT_VOICE_POLICY_INVALID');
    this.engine = engine; this.profiles = profiles; this.policy = Object.freeze(policy);
    this.onError = options.onError ?? (error => console.error('ASSISTANT_VOICE_FAILED', error instanceof Error ? error.message : 'unknown'));
    this.now = options.now ?? Date.now;
  }
  /** One outgoing utterance of source `voice` (e.g. `system_tts`): mono PCM16 at `sample_rate`, pushed as it is sent. */
  utterance(voice: string, sample_rate: number): AssistantUtterance {
    const limit = Math.round(this.policy.max_ms * sample_rate / 1000), parts: Int16Array[] = [];
    let kept = 0, ended = false;
    return {
      push: pcm => {if (ended || kept >= limit) return; const part = pcm.slice(0, limit - kept); parts.push(part); kept += part.length;},
      end: () => {
        if (ended) return; ended = true;
        const pcm = new Int16Array(kept); parts.reduce((at, part) => {pcm.set(part, at); return at + part.length;}, 0);
        this.learn(voice, sample_rate, pcm);
      },
    };
  }
  /** Utterances keyed by id (the call's responses): audio of a new key ends the previous utterance; `null` ends it. */
  stream(voice: string, sample_rate: number): (key: string, pcm: Int16Array | null) => void {
    let current: {key: string; utterance: AssistantUtterance} | undefined;
    return (key, pcm) => {
      if (current && current.key !== key) {current.utterance.end(); current = undefined;}
      if (pcm === null) {current?.utterance.end(); current = undefined; return;}
      current ??= {key, utterance: this.utterance(voice, sample_rate)};
      current.utterance.push(pcm);
    };
  }
  /** One reply the system TTS synthesized (mono WAV). */
  reply(voice: string, audio: TtsAudio): void {
    try {
      if (audio.channels !== 1) return;
      const utterance = this.utterance(voice, audio.sample_rate); utterance.push(wavSamples(audio.bytes)); utterance.end();
    } catch (error) {this.onError(error);}
  }
  async close(): Promise<void> {this.closed = true; await this.active;}
  private learn(voice: string, sample_rate: number, pcm: Int16Array): void {
    const last = this.learned.get(voice);
    if (this.closed || this.active || last !== undefined && this.now() - last < this.policy.interval_ms) return;
    const work = (async () => {
      const engine = await this.engine();
      if (!engine.idle()) return; // listening comes first; a later reply teaches the same voice
      const speech = trimmed(to16k(pcm, sample_rate));
      if (speech.length < this.policy.min_ms * 16) return;
      check(engine.speaker_model.sha256 === this.profiles.model.sha256 && engine.speaker_model.dim === this.profiles.model.dim,
        'VOICEPRINT_SPEAKER_MODEL_MISMATCH', 503);
      this.learned.set(voice, this.now());
      await this.profiles.observeAssistant({voice, embedding: await embedSpeech(engine,speech), speech_ms: speech.length / 16});
    })();
    const job: Promise<void> = work.catch(this.onError).finally(() => {if (this.active === job) this.active = undefined;});
    this.active = job;
  }
}

/** The system TTS port teaching the learner each reply it synthesizes (the audio formal voice playback sends). */
export function learningTts(tts: TtsPort, learner: AssistantVoiceLearner, voice = 'system_tts'): TtsPort {
  return {...(tts.forCall?{forCall:()=>learningTts(tts.forCall!(),learner,voice)}:{}),...(tts.stream ? {stream: async function* (text: string, requestId: string, signal?: AbortSignal) {
    let utterance: AssistantUtterance | undefined;
    try {for await (const audio of tts.stream!(text, requestId, signal)) {
      utterance ??= learner.utterance(voice, audio.sample_rate);
      utterance.push(wavSamples(audio.bytes));
      yield audio;
    }} finally {utterance?.end();}
  }} : {}),synthesize: async (text, requestId, signal) => {
    const audio = await tts.synthesize(text, requestId, signal);
    learner.reply(voice, audio);
    return audio;
  }};
}
