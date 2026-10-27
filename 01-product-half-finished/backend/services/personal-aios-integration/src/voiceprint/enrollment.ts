import { randomUUID } from 'node:crypto';
import { check, ContractError } from '../contracts.ts';
import { speechSpans } from '../media/continuous-source.ts';
import type { VadStreamFactory } from '../media/silero-stream.ts';
import { embedSpeech, speakerWindows, speechQuality, type SpeechEngine } from './contracts.ts';
import { deviceChannel, VoiceprintEnrollmentError, type OwnerStatus, type VoiceprintRegistry } from './registry.ts';

/** One recording: `ok` windows are held for enrollment; other results explain why it cannot count. */
export interface EnrollmentSample {sample_id: string | null; speech_ms: number; quality: 'ok' | 'too_short' | 'no_speech' | 'low_snr' | 'clipped' | 'multiple_speakers'; samples?: {sample_id: string; speech_ms: number; weight: number}[]}
export interface EnrollmentOutcome {
  status: 'enrolled' | 'inconsistent'; owner: OwnerStatus;
  /** Present when the registry refused the set: each sample's leave-one-out consistency and whether it passed. */
  samples?: {sample_id: string; consistency: number; ok: boolean}[];
}
interface Held {embedding: Float32Array; speech_ms: number; quality: number; at: number}
/** The enrolling device: its type names the capture channel whose set it records (phone → `phone_app`). */
type Owner = {principal_id: string; device_id: string; device_type: string};
/** A bounded long recording, split into the same speaker windows as identification. */
export const ENROLLMENT_MAX_PCM_BYTES = 10 * 60 * 16000 * 2;

/** Owner enrollment from a paired microphone. Each recorded window, already archived by the one
 *  PCM reader, is cut to its speech by the engine's own detector and embedded by the same engine that identifies speakers
 *  (so enrollment and identification embed alike). The registry alone judges the set when the device commits. Measured
 *  samples live only in memory, per device, bounded and short-lived: a restart forgets them, never a profile. A device
 *  enrolls its own capture channel's set, never another channel's. */
export class VoiceprintEnrollment {
  private readonly registry: VoiceprintRegistry; private readonly engine: () => Promise<SpeechEngine>;
  private readonly detector: VadStreamFactory; private readonly maxSamples: number; private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly held = new Map<string, Map<string, Held>>();
  constructor(registry: VoiceprintRegistry, engine: () => Promise<SpeechEngine>, detector: VadStreamFactory,
    options: {max_samples?: number; ttl_ms?: number; now?: () => number} = {}) {
    this.registry = registry; this.engine = engine; this.detector = detector;
    this.maxSamples = options.max_samples ?? 32; this.ttlMs = options.ttl_ms ?? 30 * 60_000; this.now = options.now ?? Date.now;
    check(Number.isSafeInteger(this.maxSamples) && this.maxSamples >= registry.policy.max_owner_samples &&
      Number.isSafeInteger(this.ttlMs) && this.ttlMs > 0, 'VOICEPRINT_ENROLLMENT_POLICY_INVALID');
  }
  private samples(owner: Owner): Map<string, Held> {
    const key = `${owner.principal_id}\n${owner.device_id}`, at = this.now();
    const held = this.held.get(key) ?? new Map<string, Held>();
    for (const [id, sample] of held) if (at - sample.at > this.ttlMs) held.delete(id);
    this.held.set(key, held);
    return held;
  }
  /** One recording's 16 kHz s16le PCM: speech only, with one held sample per canonical speaker window. */
  async measure(owner: Owner, pcm: Uint8Array, signal: AbortSignal = new AbortController().signal, clean?: (speech: Float32Array) => void): Promise<EnrollmentSample> {
    await this.registry.requireLearning();
    check(pcm.byteLength > 0 && pcm.byteLength % 2 === 0 && pcm.byteLength <= ENROLLMENT_MAX_PCM_BYTES, 'VOICEPRINT_SAMPLE_INVALID');
    const engine = await this.engine(), model = this.registry.model;
    check(engine.speaker_model.id === model.id && engine.speaker_model.sha256 === model.sha256 && engine.speaker_model.dim === model.dim, 'VOICEPRINT_SPEAKER_MODEL_MISMATCH', 503);
    const {segments, terminal} = await speechSpans(this.detector, pcm, signal);
    const view = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const speech = new Float32Array(segments.reduce((n, s) => n + s.end_sample_exclusive - s.start_sample, 0));
    let at = 0;
    for (const s of segments) for (let n = s.start_sample; n < s.end_sample_exclusive; n++) speech[at++] = view.readInt16LE(n * 2) / 32768;
    const speech_ms = Math.round(speech.length / 16);
    if (!speech.length) return {sample_id: null, speech_ms, quality: 'no_speech'};
    if (speech_ms < this.registry.policy.min_enroll_ms) return {sample_id: null, speech_ms, quality: 'too_short'};
    const noisePower = enrollmentNoiseFloor(terminal.processed_samples, segments, n => view.readInt16LE(n * 2) / 32768);
    const measured = await measureEnrollmentSpeech(engine, speech, noisePower,
      this.registry.policy.min_enroll_ms, this.registry.policy.thresholds.enroll_consistency, signal);
    if (typeof measured === 'string') return {sample_id: null, speech_ms, quality: measured};
    await this.registry.requireLearning();
    clean?.(speech);
    const held = this.samples(owner), samples: NonNullable<EnrollmentSample['samples']> = [];
    const selected = selectEnrollmentSamples(measured, this.registry.policy.max_owner_samples);
    for (const sample of selected) {
      while (held.size >= this.maxSamples) held.delete(held.keys().next().value!);
      const sample_id = `vps-${randomUUID()}`;
      held.set(sample_id, {...sample, at: this.now()});
      samples.push({sample_id, speech_ms: sample.speech_ms, weight: sample.quality});
    }
    return {sample_id: samples[0]!.sample_id, speech_ms, quality: 'ok', ...(samples.length > 1 ? {samples} : {})};
  }

  /** Appends these samples to the device channel's bounded owner set, in this order. A refused set reports each sample's
   *  consistency (the registry's own leave-one-out numbers) so the phone can ask for the bad ones again. */
  async enroll(owner: Owner, sampleIds: readonly string[]): Promise<EnrollmentOutcome> {
    this.registry.requireModelActive();
    const held = this.samples(owner), channel = deviceChannel(owner.device_type);
    check(Array.isArray(sampleIds) && sampleIds.length > 0 && sampleIds.length <= this.registry.policy.max_owner_samples &&
      new Set(sampleIds).size === sampleIds.length, 'VOICEPRINT_ENROLLMENT_INVALID');
    const chosen = sampleIds.map(id => {const sample = held.get(id); check(sample, 'VOICEPRINT_SAMPLE_NOT_FOUND', 404); return sample;});
    try {
      const current = await this.registry.owner(channel);
      const {absorbed_clusters: _absorbed, ...status} = await this.registry.enrollOwner({speaker_model: this.registry.model, channel,
        mode: current.reenrollment_required ? 'replace' : 'add',
        samples: chosen.map(sample => ({embedding: sample.embedding, speech_ms: sample.speech_ms, quality: sample.quality}))});
      held.clear();
      return {status: 'enrolled', owner: status};
    } catch (error) {
      if (!(error instanceof VoiceprintEnrollmentError) || error.code !== 'VOICEPRINT_ENROLLMENT_INCONSISTENT' ||
        error.sample_consistency.length < sampleIds.length) throw error;
      const floor = this.registry.policy.thresholds.enroll_consistency, consistency = error.sample_consistency.slice(-sampleIds.length);
      return {status: 'inconsistent', owner: await this.registry.owner(channel),
        samples: sampleIds.map((sample_id, index) => ({sample_id, consistency: consistency[index]!, ok: consistency[index]! >= floor}))};
    }
  }
  /** Internal held evidence. Conversation uses a separate instance, so its sample IDs never enter fixed enrollment. */
  evidence(owner: Owner, ids: readonly string[]): Held[] {
    this.registry.requireModelActive();
    const held = this.samples(owner);
    return ids.map(id => {const sample = held.get(id); check(sample, 'VOICEPRINT_SAMPLE_NOT_FOUND', 404); return sample;});
  }
  /** "忘记我的声音": the profile (every channel's set) goes, and so does anything measured but not committed from this phone. */
  async forget(owner: Owner): Promise<OwnerStatus> {
    this.samples(owner).clear();
    await this.registry.forgetOwner();
    return this.status(owner);
  }
  /** The device channel's set: what this device enrolls and is heard through. */
  status(owner: Owner): Promise<OwnerStatus> {return this.registry.owner(deviceChannel(owner.device_type));}
}

/** Shared by paired enrollment and WAV CLI. Reject unusable audio before holding any sample. */
export async function measureEnrollmentSpeech(engine: Pick<SpeechEngine, 'embed'>, speech: Float32Array, noisePower: number,
  minMs: number, consistencyFloor: number, signal?: AbortSignal): Promise<Omit<Held, 'at'>[] | Exclude<EnrollmentSample['quality'], 'ok'>> {
  if (!speech.length) return 'no_speech';
  if (speech.length / 16 < minMs) return 'too_short';
  const windows = speakerWindows(speech), measured: Omit<Held, 'at'>[] = [];
  for (const part of windows) {
    const quality = speechQuality(part);
    if (quality < .99) return 'clipped';
    let power = 0; for (const value of part) power += value * value;
    const snr = noisePower > 0 ? 10 * Math.log10(power / part.length / noisePower) : Infinity;
    if (snr < 10) return 'low_snr';
    let embedding: Float32Array;
    try {embedding = await embedSpeech(engine, part, signal);}
    catch (error) {if (error instanceof ContractError && error.code === 'SPEECH_INPUT_TOO_SHORT') return 'too_short'; throw error;}
    check(embedding.length > 0 && embedding.every(Number.isFinite) && embedding.some(value => value !== 0), 'SPEECH_EMBEDDING_INVALID', 503);
    for (const prior of measured) {
      check(embedding.length === prior.embedding.length, 'SPEECH_EMBEDDING_INVALID', 503);
      let dot = 0, aa = 0, bb = 0;
      for (let i = 0; i < embedding.length; i++) {dot += embedding[i]! * prior.embedding[i]!; aa += embedding[i]! ** 2; bb += prior.embedding[i]! ** 2;}
      if (dot / Math.sqrt(aa * bb) < consistencyFloor) return 'multiple_speakers';
    }
    measured.push({embedding, speech_ms: Math.round(part.length / 16), quality: quality * Math.min(1, snr / 30)});
  }
  return measured;
}

/** Keep bounded coverage across the complete recording after every window passed the one-speaker check. */
export function selectEnrollmentSamples<T>(samples: T[], limit: number): T[] {
  return samples.length <= limit ? samples : Array.from({length: limit}, (_, i) => samples[Math.floor(i * (samples.length - 1) / (limit - 1))]!);
}

/** Low-power non-speech frames estimate background without treating unvoiced consonants as steady noise.
 * Both PCM enrollment and the WAV CLI use the 5th percentile of complete 5 ms frames outside VAD spans.
 * Short onset gaps can contain mostly missed speech, so 20 ms averages cannot resolve their actual quiet floor. */
export function enrollmentNoiseFloor(sampleCount: number, spans: readonly {start_sample: number; end_sample_exclusive: number}[],
  sampleAt: (index: number) => number): number {
  const powers: number[] = [], frame = 80;
  let previous = 0;
  for (const span of [...spans, {start_sample: sampleCount, end_sample_exclusive: sampleCount}]) {
    for (let at = previous; at + frame <= span.start_sample; at += frame) {
      let power = 0; for (let n = at; n < at + frame; n++) power += sampleAt(n) ** 2;
      powers.push(power / frame);
    }
    previous = span.end_sample_exclusive;
  }
  powers.sort((a, b) => a - b);
  return powers.length ? powers[Math.floor((powers.length - 1) * .05)]! : 0;
}

export type ConversationAction = 'status'|'start'|'resume'|'pause'|'stop'|'check'|'commit'|'discard'|'preview';
export interface ConversationEnrollmentState {
  available: boolean; session_id: string|null; call_id: string|null;
  phase: 'idle'|'collecting'|'paused'|'checked'|'committed'|'discarded';
  recorded_ms: number; preview_audio_base64?: string; clean_speech_ms: number; target_speech_ms: number; issue: string|null; can_use: boolean;
  source_device: {device_id: string; device_type: string}|null; updated_at: string|null; owner: OwnerStatus;
}
interface ConversationSession {
  id: string; call: string; owner: Owner; phase: ConversationEnrollmentState['phase'];
  samples: Held[]; speech: number; recorded: number; preview?: string; issue: string|null; at: number; turns: Set<number>; through: number;
}
/** One bounded draft per paired capture device. Uses the existing detector, window measurement and registry validation.
 * Drafts are memory-only; payment enrollment has a separate held-evidence instance and cannot consume these samples. */
export class ConversationVoiceprintEnrollment {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly measuring: VoiceprintEnrollment;
  private queue: Promise<unknown> = Promise.resolve();
  readonly targetSpeechMs = 30_000;
  private readonly registry: VoiceprintRegistry; private readonly available: boolean;
  constructor(registry: VoiceprintRegistry, engine: () => Promise<SpeechEngine>, detector: VadStreamFactory, available: boolean) {
    this.registry = registry; this.available = available; this.measuring = new VoiceprintEnrollment(registry, engine, detector);
  }
  private key(owner: Owner) {return `${owner.principal_id}\n${owner.device_id}`;}
  private session(owner: Owner, id?: string): ConversationSession {
    const session = this.sessions.get(this.key(owner));
    check(session && session.id === id && Date.now() - session.at < 30 * 60_000, 'VOICE_ENROLLMENT_SESSION_NOT_FOUND', 404);
    return session;
  }
  private async state(owner: Owner): Promise<ConversationEnrollmentState> {
    let session = this.sessions.get(this.key(owner));
    if (session && Date.now() - session.at >= 30 * 60_000) {this.sessions.delete(this.key(owner)); session = undefined;}
    const channel = deviceChannel(owner.device_type), conversation = await this.registry.owner(channel, true), legacy = await this.registry.owner(channel);
    const ownerStatus = conversation.enrolled ? conversation : legacy.enrolled ? legacy : conversation.samples ? conversation : legacy.samples ? legacy : conversation;
    return {available: this.available, session_id: session?.id ?? null, call_id: session?.call ?? null,
      phase: session?.phase ?? 'idle', recorded_ms: session?.recorded ?? 0, clean_speech_ms: session?.speech ?? 0, target_speech_ms: this.targetSpeechMs,
      issue: session?.issue ?? null, can_use: session?.phase === 'checked',
      source_device: session ? {device_id: owner.device_id, device_type: owner.device_type} : ownerStatus === conversation ? await this.registry.conversationSource(channel) : null,
      updated_at: session ? new Date(session.at).toISOString() : ownerStatus.updated_at,
      owner: ownerStatus};
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result;
  }
  private async assess(owner: Owner, session: ConversationSession, commit: boolean): Promise<void> {
    session.phase = 'paused'; session.issue = null;
    try {
      check(session.speech >= this.targetSpeechMs, 'VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED', 422);
      const current = await this.registry.owner(deviceChannel(owner.device_type), true);
      await this.registry.enrollOwner({speaker_model: this.registry.model, channel: deviceChannel(owner.device_type),
        mode: current.reenrollment_required ? 'replace' : 'add', purpose: 'conversation', source_device: {device_id: owner.device_id, device_type: owner.device_type},
        check_only: !commit, samples: session.samples});
      session.phase = commit ? 'committed' : 'checked';
      if (commit) session.samples = [];
    } catch (error) {
      if (!(error instanceof ContractError) || error.status !== 422) throw error;
      session.issue = error.code;
    }
  }
  control(owner: Owner, action: ConversationAction, id?: string, callId?: string): Promise<ConversationEnrollmentState> {
    return this.serial(async () => {
      if (action === 'status') return this.state(owner);
      if (action === 'discard' && id === undefined) {
        const current = this.sessions.get(this.key(owner));
        if (!current) return this.state(owner);
        id = current.id;
      }
      check(this.available, 'VOICE_ENROLLMENT_UNAVAILABLE', 503);
      check(['start','resume','pause','stop','check','commit','discard','preview'].includes(action), 'VOICE_ENROLLMENT_ACTION_INVALID');
      if (action === 'start') {
        check(typeof callId === 'string' && callId.length > 0 && callId.length <= 200, 'VOICE_ENROLLMENT_CALL_REQUIRED');
        this.sessions.set(this.key(owner), {id: randomUUID(), call: callId, owner, phase: 'collecting',
          samples: [], speech: 0, recorded: 0, issue: null, at: Date.now(), turns: new Set(), through: -Infinity});
        return this.state(owner);
      }
      const session = this.session(owner, id);
      if (action === 'preview') {
        check(session.phase === 'checked' && session.preview, 'VOICE_ENROLLMENT_PREVIEW_UNAVAILABLE', 409);
        return {...await this.state(owner), preview_audio_base64: session.preview};
      }
      if (action === 'discard') {
        check(callId === undefined || callId === session.call, 'VOICE_ENROLLMENT_CALL_REQUIRED', 409);
        session.samples = []; delete session.preview; session.speech = 0; session.recorded = 0; session.phase = 'discarded'; session.issue = null;
      }
      else if (action === 'resume') {
        check(session.phase === 'paused', 'VOICE_ENROLLMENT_PHASE_INVALID', 409);
        check(typeof callId === 'string' && callId.length > 0 && callId.length <= 200 && callId !== session.call, 'VOICE_ENROLLMENT_CALL_REQUIRED');
        session.call = callId; session.phase = 'collecting'; session.turns.clear(); session.issue = null;
      } else if (action === 'pause' || action === 'stop') {
        if (session.phase === 'collecting') session.phase = 'paused';
      } else {
        if (action === 'check' && session.phase === 'checked') return this.state(owner);
        check(action === 'check' ? session.phase === 'collecting' || session.phase === 'paused' : session.phase === 'checked',
          'VOICE_ENROLLMENT_PHASE_INVALID', 409);
        await this.assess(owner, session, action === 'commit');
      }
      session.at = Date.now(); return this.state(owner);
    });
  }
  forget(principal: string): Promise<void> {
    return this.serial(async () => {for (const [key, session] of this.sessions) if (session.owner.principal_id === principal) this.sessions.delete(key);});
  }
  async instructions(owner: Owner, id: string, callId: string): Promise<string> {
    check(this.available, 'VOICE_ENROLLMENT_UNAVAILABLE', 503);
    const session = this.session(owner, id);
    check(session.phase === 'collecting' && session.call === callId, 'VOICE_ENROLLMENT_CALL_MISMATCH', 409);
    return '现在是主人主动开启的自然聊天声音录入。用轻松的日常问题了解主人，每次只问一个问题，根据回答自然追问。先问今天做了什么或最近喜欢什么。不要要求朗读固定句子，不做支付录入，不声称识别准确率。只收集主人的声音，旁人和依米的声音不能算。足够后由服务端结束；不要自行承诺已保存。主人会在检查后明确选择使用。';
  }
  collect(owner: Owner, id: string, callId: string, turn: number, range: {start_ms: number; end_ms: number},
    read: () => Promise<Uint8Array>): Promise<ConversationEnrollmentState> {
    return this.serial(async () => {
      await this.registry.requireLearning();
      check(this.available, 'VOICE_ENROLLMENT_UNAVAILABLE', 503);
      const session = this.session(owner, id);
      check(session.call === callId, 'VOICE_ENROLLMENT_CALL_MISMATCH', 409);
      if (session.phase !== 'collecting' || session.turns.has(turn)) return this.state(owner);
      check(Number.isSafeInteger(turn) && turn >= 0 && Number.isFinite(range.start_ms) && range.end_ms > range.start_ms,
        'VOICE_ENROLLMENT_TURN_INVALID');
      session.turns.add(turn);
      check(session.turns.size <= 200, 'VOICE_ENROLLMENT_TURN_LIMIT', 422);
      if (range.start_ms < session.through) {session.issue = 'VOICE_ENROLLMENT_OVERLAPPING_AUDIO'; return this.state(owner);}
      const pcm = await read();
      session.recorded += Math.round(pcm.byteLength / 32);
      let preview: string|undefined;
      const measured = await this.measuring.measure(owner, pcm, new AbortController().signal, speech => {
        if (!session.preview) preview = previewWav(speech.subarray(0, 16_000));
      });
      session.through = range.end_ms; session.at = Date.now();
      session.issue = measured.quality === 'ok' ? null : measured.quality;
      if (measured.quality === 'ok') {
        const ids = measured.samples?.map(s => s.sample_id) ?? [measured.sample_id!];
        const evidence = this.measuring.evidence(owner, ids);
        const candidate = session.samples.map(s => s.embedding);
        let accepted = true;
        for (const sample of evidence) {
          if (!await this.registry.admitConversation(deviceChannel(owner.device_type), sample.embedding, candidate)) {accepted = false; break;}
          candidate.push(sample.embedding);
        }
        if (accepted) {
          if (preview) session.preview = preview;
          session.samples.push(...evidence); session.speech += measured.speech_ms;
          session.samples = selectEnrollmentSamples(session.samples, this.registry.policy.max_owner_samples);
          if (session.speech >= this.targetSpeechMs) await this.assess(owner, session, false);
        } else session.issue = 'VOICE_ENROLLMENT_OTHER_SPEAKER';
      }
      return this.state(owner);
    });
  }
}

/** Bounded audition of the same clean speech that was admitted, using a standard WAV envelope. */
function previewWav(speech: Float32Array): string {
  const samples = Math.floor(speech.length / 2), wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) wav[44 + i] = Math.max(0, Math.min(255, Math.round((speech[i * 2]! + speech[i * 2 + 1]!) * 64 + 128)));
  return wav.toString('base64');
}
