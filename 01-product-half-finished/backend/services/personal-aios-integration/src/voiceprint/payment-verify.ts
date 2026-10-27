import {check, ContractError, type TimeRange} from '../contracts.ts';
import type {RawArchive, StreamArchiveRecord} from '../archive.ts';
import {mappedRange, type ClockMap} from '../media/align.ts';
import {speechSpans} from '../media/continuous-source.ts';
import type {VadStreamFactory} from '../media/silero-stream.ts';
import type {PaymentVoiceVerifier, UtteranceRef, VoiceVerdict} from '../payment/contracts.ts';
import {embedSpeech, type SpeechEngine, type SpeakerIdentity} from './contracts.ts';
import {deviceChannel, type VoiceprintRegistry} from './registry.ts';

export type VoiceprintAudioRef = Pick<UtteranceRef, 'device_id'|'raw_ref'|'archive_revision'|'start_ms'|'end_ms'> & {device_type: string};
export interface PaymentVoiceVerifierOptions {
  archive: Pick<RawArchive, 'locate'|'readRecord'>;
  registry: VoiceprintRegistry;
  engine: () => Promise<SpeechEngine>;
  detector: VadStreamFactory;
  /** Resolve the pinned audio track/epoch through the existing source-clock authority, never fixture offsets or
   *  a first-track guess. The composition owns archivedReceiptClockMaps(principal, receipt, binding) and
   *  authorizeClockMaps(principal, maps, receipt, record.manifest); the verifier never invents source bindings. */
  clock_map: (principal: string, utterance: VoiceprintAudioRef, record: StreamArchiveRecord) => Promise<ClockMap>;
  owner_override_active?: () => Promise<boolean>;
  carrier_ms: number;
  max_read_bytes: number;
}
type Evidence = {score: number|null; speech_ms: number};
const score = (identity: SpeakerIdentity): number|null => 'score' in identity ? Math.round(identity.score * 100) / 100 : null;
function conclusion(identity: SpeakerIdentity): Pick<VoiceVerdict, 'verdict'|'reason'> {
  // The shared identity output can mark learned call evidence; it cannot authorize payment.
  if (identity.kind === 'owner') return {verdict: identity.band === 'verified' && !('call_only' in identity && identity.call_only) ? 'pass' : 'uncertain'};
  if (identity.kind === 'assistant') return {verdict: 'fail', reason: 'assistant_voice'};
  if (identity.kind === 'speaker' || identity.reason === 'unmatched') return {verdict: 'fail', reason: 'other_speaker'};
  if (identity.reason === 'no_enrollment') return {verdict: 'unavailable', reason: 'not_enrolled'};
  return {verdict: 'insufficient', reason: identity.reason};
}

/** A6.3: read-only evidence. The payment authority alone applies locks, limits, freshness and grants. */
export class VoiceprintPaymentVerifier implements PaymentVoiceVerifier {
  private readonly options: PaymentVoiceVerifierOptions;
  constructor(options: PaymentVoiceVerifierOptions) {
    check(Number.isSafeInteger(options.carrier_ms) && options.carrier_ms > 0 &&
      Number.isSafeInteger(options.max_read_bytes) && options.max_read_bytes > 0, 'PAYMENT_VOICE_CONFIG_INVALID');
    this.options = {...options};
  }
  verifyInitiating(principal: string, initiating: UtteranceRef, signal?: AbortSignal): Promise<VoiceVerdict> {
    return this.verifyGuarded(principal, initiating, undefined, signal ?? new AbortController().signal);
  }
  verifyPay(principal: string, initiating: UtteranceRef, pay: UtteranceRef, signal?: AbortSignal): Promise<VoiceVerdict> {
    return this.verifyGuarded(principal, initiating, pay, signal ?? new AbortController().signal);
  }
  private async verifyGuarded(principal: string, initiating: UtteranceRef, pay: UtteranceRef|undefined, signal: AbortSignal): Promise<VoiceVerdict> {
    const unavailable = (): VoiceVerdict => ({verdict: 'unavailable', reason: 'engine_unavailable',
      initiating: {score: null, speech_ms: 0}, channel: deviceChannel(initiating.device_type) as VoiceVerdict['channel'],
      speaker_model: this.options.registry.model.id});
    signal.throwIfAborted();
    if (await this.options.owner_override_active?.()) return unavailable();
    if (!await this.options.registry.paymentReady(deviceChannel(initiating.device_type))) return {...unavailable(), reason: 'not_enrolled'};
    const result = await this.verify(principal, initiating, pay, signal);
    signal.throwIfAborted();
    return await this.options.owner_override_active?.() || !await this.options.registry.paymentReady(deviceChannel(initiating.device_type)) ? unavailable() : result;
  }
  private async verify(principal: string, initiating: UtteranceRef, pay: UtteranceRef|undefined, signal: AbortSignal): Promise<VoiceVerdict> {
    signal.throwIfAborted();
    const {registry} = this.options;
    const result: VoiceVerdict = {verdict: 'unavailable', initiating: {score: null, speech_ms: 0},
      channel: deviceChannel(initiating.device_type) as VoiceVerdict['channel'], speaker_model: registry.model.id};
    const owner = await registry.owner();
    signal.throwIfAborted();
    if (!owner.enrolled) return {...result, reason: 'not_enrolled'};
    let engine: SpeechEngine;
    try {
      engine = await this.options.engine();
      signal.throwIfAborted();
      check(engine.speaker_model.id === registry.model.id && engine.speaker_model.sha256 === registry.model.sha256 && engine.speaker_model.dim === registry.model.dim,
        'VOICEPRINT_SPEAKER_MODEL_MISMATCH', 503);
    } catch (error) {signal.throwIfAborted(); return {...result, reason: 'engine_unavailable'};}
    const measure = async (u: UtteranceRef, evidence: Evidence): Promise<Float32Array|VoiceVerdict> => {
      let pcm: Uint8Array;
      try {pcm = await this.readPcm(principal, u, signal);}
      catch (error) {signal.throwIfAborted(); return {...result, verdict: 'unavailable', reason: 'audio_missing'};}
      signal.throwIfAborted();
      try {
        const {segments} = await speechSpans(this.options.detector, pcm, signal);
        const view = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const speech = new Float32Array(segments.reduce((n, s) => n + s.end_sample_exclusive - s.start_sample, 0));
        let at = 0;
        for (const s of segments) for (let n = s.start_sample; n < s.end_sample_exclusive; n++) speech[at++] = view.readInt16LE(n * 2) / 32768;
        evidence.speech_ms = Math.round(speech.length / 16);
        signal.throwIfAborted();
        return speech;
      } catch (error) {signal.throwIfAborted(); return {...result, verdict: 'unavailable', reason: 'engine_unavailable'};}
    };
    const speech = await measure(initiating, result.initiating);
    if (!(speech instanceof Float32Array)) return speech;
    if (!speech.length) return {...result, verdict: 'insufficient', reason: 'no_speech'};
    try {
      const identity = await registry.identify(await embedSpeech(engine, speech, signal),
        {mode: 'payment', channel: deviceChannel(initiating.device_type), speech_ms: result.initiating.speech_ms, observed_at: initiating.captured_at});
      result.initiating.score = score(identity);
      Object.assign(result, conclusion(identity));
      if (result.verdict === 'pass' && result.initiating.speech_ms < registry.policy.min_identify_ms)
        Object.assign(result, {verdict: 'insufficient', reason: 'too_short'});
      signal.throwIfAborted();
      if (result.verdict !== 'pass' || !pay) return result;
      result.pay = {score: null, speech_ms: 0};
      const follow = await measure(pay, result.pay);
      if (!(follow instanceof Float32Array)) return follow;
      if (result.pay.speech_ms < registry.policy.min_assistant_ms)
        return {...result, verdict: 'insufficient', reason: follow.length ? 'too_short' : 'no_speech'};
      if (initiating.device_id !== pay.device_id) return {...result, verdict: 'unavailable', reason: 'different_terminal'};
      const carrier = speech.subarray(Math.max(0, speech.length - this.options.carrier_ms * 16));
      const combined = new Float32Array(carrier.length + follow.length);
      combined.set(carrier); combined.set(follow, carrier.length);
      const payEmbedding = await embedSpeech(engine, follow, signal);
      const combinedIdentity = await registry.identify(await embedSpeech(engine, combined, signal),
        {mode: 'payment', channel: deviceChannel(pay.device_type), speech_ms: Math.round(combined.length / 16), observed_at: pay.captured_at,
          request: {embedding: payEmbedding, speech_ms: result.pay.speech_ms}});
      result.combined = {score: score(combinedIdentity), speech_ms: Math.round(combined.length / 16)};
      signal.throwIfAborted();
      return {...result, ...conclusion(combinedIdentity)};
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ContractError && error.code === 'SPEECH_INPUT_TOO_SHORT') return {...result, verdict: 'insufficient', reason: 'too_short'};
      return {...result, verdict: 'unavailable', reason: 'engine_unavailable'};
    }
  }
  /** L5 alone verifies originals and restores cold bytes. No storage bypass, PCM cache or writes here. */
  async readPcm(principal: string, u: VoiceprintAudioRef, signal: AbortSignal): Promise<Uint8Array> {
    const {archive, max_read_bytes} = this.options;
    check(Number.isFinite(u.start_ms) && Number.isFinite(u.end_ms) && u.end_ms > u.start_ms, 'PAYMENT_AUDIO_SPAN_INVALID');
    signal.throwIfAborted();
    const revision = u.archive_revision ?? (await archive.locate(u.raw_ref, principal)).archive_revision;
    signal.throwIfAborted();
    const header = await archive.readRecord(u.raw_ref, principal, revision, {proof_only: true, maxReadBytes: max_read_bytes});
    signal.throwIfAborted();
    check(header.kind === 'stream' && header.event.device_id === u.device_id && header.event.device_type === u.device_type,
      'PAYMENT_AUDIO_SOURCE_DENIED', 403);
    const map = await this.options.clock_map(principal, u, header);
    signal.throwIfAborted();
    check(map.modality === 'audio' && map.target_timebase_id === 'utc_epoch_ms', 'PAYMENT_AUDIO_CLOCK_REQUIRED');
    const scale = 1 + map.drift_ppm / 1e6;
    const source_range: TimeRange = {kind: 'interval', timebase_id: map.source_timebase_id, stream_epoch: map.stream_epoch,
      start_ms: (u.start_ms - map.offset_ms) / scale, end_ms: (u.end_ms - map.offset_ms) / scale};
    const record = await archive.readRecord(u.raw_ref, principal, revision, {source_range, track_ids: [map.track_id], maxReadBytes: max_read_bytes});
    signal.throwIfAborted();
    check(record.kind === 'stream', 'PAYMENT_AUDIO_STREAM_REQUIRED');
    const parts: Buffer[] = [];
    let through = u.start_ms;
    for (const {chunk, bytes} of [...record.chunks].sort((a, b) => a.chunk.seq - b.chunk.seq)) {
      const range = mappedRange(chunk.source_range, map);
      check(chunk.modality === 'audio' && chunk.format === 'pcm_s16le:16000:1' && range.kind === 'interval' &&
        range.start_ms <= through && range.end_ms > through, 'PAYMENT_AUDIO_COVERAGE_REQUIRED');
      const first = Math.max(0, Math.ceil((through - range.start_ms) * 16 / scale));
      const end = Math.min(bytes.length / 2, Math.ceil((u.end_ms - range.start_ms) * 16 / scale));
      parts.push(Buffer.from(bytes.buffer, bytes.byteOffset + first * 2, (end - first) * 2));
      through = Math.min(u.end_ms, range.end_ms);
    }
    check(through === u.end_ms && parts.length > 0, 'PAYMENT_AUDIO_COVERAGE_REQUIRED');
    return Buffer.concat(parts);
  }
}
