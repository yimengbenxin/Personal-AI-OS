import { randomUUID } from 'node:crypto';
import { createQwenTtsTransport, type QwenTtsSocket, type QwenVoiceConfiguration } from './voice/qwen-resources.mjs';
import { check, sha256 } from './contracts.ts';
export interface TtsAudio {
  bytes: Uint8Array; mime: 'audio/wav'; codec: 'pcm_s16le'; sample_rate: number;
  channels: number; duration_ms: number; sha256: string;
}
export interface TtsPort {
  /** Same configured provider/model, using its existing live-call voice selection. No fallback voice. */
  forCall?():TtsPort;
  synthesize(text: string, requestId: string, signal?: AbortSignal): Promise<TtsAudio>;
  stream?(text: string, requestId: string, signal?: AbortSignal): AsyncIterable<TtsAudio>;
}
// Parse the actual converted file, never infer duration from text length or synthesis exit status.
export function inspectWav(bytes: Uint8Array): TtsAudio {
  const wav = Buffer.from(bytes);
  check(wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' &&
    wav.toString('ascii', 8, 12) === 'WAVE' && wav.readUInt32LE(4) + 8 === wav.length, 'TTS_INVALID_WAV');
  let sampleRate = 0; let channels = 0; let byteRate = 0; let blockAlign = 0; let dataBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    check(start + length <= wav.length, 'TTS_INVALID_WAV');
    if (kind === 'fmt ') {
      check(length >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 14) === 16, 'TTS_UNSUPPORTED_WAV');
      channels = wav.readUInt16LE(start + 2); sampleRate = wav.readUInt32LE(start + 4);
      byteRate = wav.readUInt32LE(start + 8); blockAlign = wav.readUInt16LE(start + 12);
    }
    if (kind === 'data') dataBytes += length;
    offset = start + length + (length % 2);
  }
  check(channels > 0 && channels <= 2 && sampleRate > 0 && byteRate === sampleRate * channels * 2 &&
    blockAlign === channels * 2 && dataBytes > 0 && dataBytes % blockAlign === 0, 'TTS_INVALID_WAV');
  // Whole milliseconds, rounded: the voice_chunk contract carries an integer and the phone checks the same rounding
  // against the WAV it receives (a 24 kHz reply is almost never a whole number of milliseconds).
  return {bytes, mime: 'audio/wav', codec: 'pcm_s16le', sample_rate: sampleRate,
    channels, duration_ms: Math.round(dataBytes * 1000 / byteRate), sha256: sha256(bytes)};
}

/** The PCM16 samples of a WAV inspectWav accepts (interleaved when stereo). */
export function wavSamples(bytes: Uint8Array): Int16Array {
  inspectWav(bytes);
  const wav = Buffer.from(bytes), parts: Buffer[] = [];
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') parts.push(wav.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length + (length % 2);
  }
  const data = Buffer.concat(parts), samples = new Int16Array(data.length / 2);
  for (let n = 0; n < samples.length; n++) samples[n] = data.readInt16LE(n * 2);
  return samples;
}

/** Wrap provider PCM16 into a self-contained mono WAV at the requested provider rate. */
function pcmWav(pcm: Buffer, sampleRate: number): TtsAudio {
  check(pcm.length > 0 && pcm.length % 2 === 0, 'TTS_INVALID_AUDIO');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return inspectWav(wav);
}

// First audio passes through immediately. Later blocks flush at 256 KiB or 500 ms,
// so provider fragmentation cannot set journal growth or leave playback waiting for a large block.
export async function* coalesceTts(source: AsyncIterable<TtsAudio>): AsyncIterable<TtsAudio> {
  let first = true, rate = 0, channels = 0, size = 0, deadline = 0;
  const parts: Buffer[] = [], iterator = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<TtsAudio>> | undefined;
  try {
    while (true) {
      pending ??= iterator.next();
      let timer: NodeJS.Timeout | undefined;
      const next = size ? await Promise.race([pending, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now()));
      })]).finally(() => clearTimeout(timer)) : await pending;
      if (next === null) {yield merged(); continue;}
      pending = undefined;
      if (next.done) break;
      const parsed = inspectWav(next.value.bytes);
      check(parsed.sha256 === next.value.sha256, 'OUTPUT_AUDIO_INVALID');
      if (first) {first = false; rate = parsed.sample_rate; channels = parsed.channels; yield parsed; continue;}
      check(parsed.sample_rate === rate && parsed.channels === channels, 'TTS_FORMAT_CHANGED');
      const samples = wavSamples(parsed.bytes), pcm = Buffer.alloc(samples.length * 2);
      for (let n = 0; n < samples.length; n++) pcm.writeInt16LE(samples[n]!, n * 2);
      for (let at = 0; at < pcm.length;) {
        if (!size) deadline = performance.now() + 500;
        const part = pcm.subarray(at, at + Math.min(pcm.length - at, 262144 - size));
        parts.push(part); size += part.length; at += part.length;
        if (size === 262144) yield merged();
      }
    }
    if (size) yield merged();
  } finally {await iterator.return?.();}
  function merged(): TtsAudio {
    const wav = Buffer.from(pcmWav(Buffer.concat(parts), rate).bytes);
    wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(rate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
    parts.length = 0; size = 0; return inspectWav(wav);
  }
}

// One provider owner serializes both APIs and reuses completed-task connections.
export class DashScopeTts implements TtsPort {
  readonly model: string;
  readonly voice: string;
  readonly sampleRate: number;
  /** Optional natural-language tone instruction (config); the provider applies it to delivery, never to the text. */
  readonly instruction: string | undefined;
  private readonly callTts:()=>TtsPort;private readonly callPorts=new Map<string,DashScopeTts>();
  private readonly createSocket: () => QwenTtsSocket;
  private socket: QwenTtsSocket | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private stop: ((error: unknown) => void) | undefined;
  constructor(configuration: QwenVoiceConfiguration, synthesis: {model: string; voice: string; sample_rate: number; endpoint?: string; instruction?: string}) {
    this.callTts=()=>{const voice=configuration.call?.voice??configuration.voice;check(voice,'TTS_CALL_VOICE_UNAVAILABLE');
      if(voice===this.voice)return this;let port=this.callPorts.get(voice);if(!port){port=new DashScopeTts(configuration,{...synthesis,voice});this.callPorts.set(voice,port);}return port;};
    this.model = synthesis.model; this.voice = synthesis.voice; this.sampleRate = synthesis.sample_rate; this.instruction = synthesis.instruction;
    this.createSocket = createQwenTtsTransport(configuration, synthesis.endpoint);
  }
  forCall():TtsPort {return this.callTts();}
  close(): void {
    for(const port of this.callPorts.values())port.close();this.callPorts.clear();
    this.closed = true;
    this.stop?.(new Error('TTS_CLOSED'));
    this.socket?.terminate(); this.socket = undefined;
  }
  async synthesize(text: string, requestId: string, signal?: AbortSignal): Promise<TtsAudio> {
    const parts: Buffer[] = [];
    for await (const audio of this.stream(text, requestId, signal)) parts.push(Buffer.from(audio.bytes).subarray(44));
    return pcmWav(Buffer.concat(parts), this.sampleRate);
  }
  async *stream(text: string, _requestId: string, signal?: AbortSignal): AsyncIterable<TtsAudio> {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 200000, 'TTS_TEXT_INVALID');
    signal?.throwIfAborted(); check(!this.closed, 'TTS_CLOSED');
    const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    const gate = Promise.withResolvers<void>(), previous = this.tail;
    this.tail = previous.then(() => gate.promise);
    const cancelled = Promise.withResolvers<never>();
    const waitingAbort = () => cancelled.reject(abort.reason);
    abort.addEventListener('abort', waitingAbort, {once: true});
    try {await Promise.race([previous, cancelled.promise]); abort.throwIfAborted(); check(!this.closed, 'TTS_CLOSED');}
    catch (error) {gate.resolve(); throw error;}
    finally {abort.removeEventListener('abort', waitingAbort);}
    let socket: QwenTtsSocket;
    try {
      socket = this.socket?.readyState === 1 ? this.socket : this.createSocket();
      if (socket !== this.socket) socket.on('error', error => {
        if (this.socket === socket) {this.stop?.(error); socket.terminate(); this.socket = undefined;}
      });
      this.socket = socket;
    }
    catch (error) {gate.resolve(); throw error;}
    const taskId = randomUUID(), chunks: Buffer[] = [];
    let size = 0, finished = false, failure: unknown, wake = Promise.withResolvers<void>();
    const notify = () => {wake.resolve();};
    const fail = (error: unknown) => {failure = error; notify(); socket.terminate();};
    this.stop = fail;
    const send = (action: string, payload: object) => socket.send(JSON.stringify({
      header: {action, task_id: taskId, streaming: 'duplex'}, payload}));
    const run = () => {
      try {send('run-task', {task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.model,
        parameters: {text_type: 'PlainText', voice: this.voice, format: 'pcm', sample_rate: this.sampleRate,
          ...(this.instruction ? {instruction: this.instruction} : {})}, input: {}});}
      catch (error) {fail(error);}
    };
    const message = (data: Buffer, binary: boolean) => {
      try {
        if (binary) {
          size += data.length; check(size <= 33554432, 'TTS_AUDIO_TOO_LARGE');
          check(data.length > 0 && data.length % 2 === 0, 'TTS_INVALID_AUDIO');
          chunks.push(Buffer.from(data)); notify(); return;
        }
        const event = JSON.parse(data.toString());
        check(event.header?.task_id === taskId, 'TTS_TASK_MISMATCH');
        if (event.header.event === 'task-started') {
          // Slice by Unicode code points so a boundary never changes the source text.
          const characters = Array.from(text);
          for (let at = 0; at < characters.length; at += 20000)
            send('continue-task', {input: {text: characters.slice(at, at + 20000).join('')}});
          send('finish-task', {input: {}});
        } else if (event.header.event === 'task-finished') {finished = true; notify();}
        else if (event.header.event === 'task-failed') throw new Error(
          `TTS_PROVIDER_FAILED: ${event.header.error_code}: ${event.header.error_message}`);
      } catch (error) {fail(error);}
    };
    const closed = () => {if (!finished && !failure) {failure = new Error('TTS_CONNECTION_CLOSED'); notify();}};
    const aborted = () => fail(abort.reason);
    socket.on('open', run).on('message', message).on('close', closed);
    abort.addEventListener('abort', aborted, {once: true});
    try {
      abort.throwIfAborted();
      if (socket.readyState === 1) run();
      while (true) {
        if (failure) throw failure;
        if (chunks.length) {yield pcmWav(chunks.shift()!, this.sampleRate); continue;}
        if (finished) {check(size > 0, 'TTS_INVALID_AUDIO'); break;}
        await wake.promise; wake = Promise.withResolvers<void>();
      }
    } finally {
      abort.removeEventListener('abort', aborted);
      socket.off('open', run).off('message', message).off('close', closed);
      this.stop = undefined;
      if (!finished || failure) {socket.terminate(); if (this.socket === socket) this.socket = undefined;}
      gate.resolve();
    }
  }
}
