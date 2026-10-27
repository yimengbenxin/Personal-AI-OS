import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {LocalMediaExecution} from './local-execution.ts';
import {FfmpegDemux} from './ffmpeg-demux.ts';
import type {DemuxPort} from './tracks.ts';
import {SherpaSileroStreamFactory,type VadStreamFactory} from './silero-stream.ts';
import {finiteVadSelection,type ContinuousBudget} from './continuous-source.ts';
import { check } from '../contracts.ts';
import { PosixStorage, type StoragePort } from '../storage.ts';
import { RawArchive } from '../archive.ts';
import { MediaProcessor, type WorkerPort } from './processing.ts';
import { MediaService, type MediaServiceConfig, type MediaVadPort } from './service.ts';
import { WindowsVisionWorker, windowsVisionCapability, type WindowsVisionSnapshot } from './windows-vision-worker.ts';
import { LOCAL_SHERPA_AUDIO, LOCAL_SHERPA_TURN, SherpaAudioWorker, sherpaAudioCapability } from './sherpa-audio-worker.ts';
import { parseMediaReplayConfiguration } from './configuration.ts';
import { readEvidenceFile } from './protocol-evidence.ts';
import { LocalSpeechEngine, recoveringEngine } from '../voiceprint/engine.ts';
import type { SpeakerIdentifier } from '../voiceprint/contracts.ts';
export { parseMediaReplayConfiguration } from './configuration.ts';
export type { MediaReplayConfiguration } from './configuration.ts';

// One isolated central composition. Provider topology and evidence belong here;
// source selection, permission, identities and per-input quality retain their owners.
export interface MediaCompositionSource {
    withAppendAdmission: NonNullable<MediaServiceConfig['withAppendAdmission']>;
    withAppendBatchAdmission?:NonNullable<MediaServiceConfig['withAppendBatchAdmission']>;
    authorizeClockMaps: NonNullable<MediaServiceConfig['authorizeClockMaps']>;
    clockEvidence: 'calibrated' | 'receipt_estimated' | 'synthetic';
    sourceWarnings?: string[];
    continuous?:{budget:ContinuousBudget;onError:(error:unknown,ref?:string)=>void};
    /** The voiceprint registry. When present every transcribed utterance carries its speaker label. */
    speakers?: SpeakerIdentifier;
}
/** Borrowed infrastructure ports, including controlled source-test ports. CAP remains processor-owned. */
export interface MediaProviderPorts {
    workers: ReadonlyMap<string, WorkerPort>;
    capabilities: import('./processing.ts').CapabilitySource;
    /** Wake-turn consumer capabilities (the turn worker must be in `workers`). */
    turn?: import('./processing.ts').CapabilitySource;
    vad: MediaVadPort;
    voiceIdentity?: import('./processing.ts').VoiceIdentityAnalysis;
    demux?: DemuxPort;
    /** Continuous-lane detector; the speech engine's own Silero detector when absent. */
    detector?: VadStreamFactory;
}
export async function configureMediaReplay(storage: StoragePort, incoming: unknown, maxEventBytes: number,
    fetcher: typeof fetch = fetch, source?: MediaCompositionSource, provided?: MediaProviderPorts, localModels?:ReturnType<typeof import('../model-settings-local-runtime.ts').localSpeechRuntime>) {
    if(source?.continuous)source={...source,continuous:{...source.continuous,budget:{...source.continuous.budget}}};
    if (source) check(typeof source.withAppendAdmission === 'function' && typeof source.authorizeClockMaps === 'function' &&
        ['calibrated','receipt_estimated','synthetic'].includes(source.clockEvidence), 'PRODUCTION_MEDIA_AUTHORITY_NOT_CONFIGURED', 503);
    const config = parseMediaReplayConfiguration(incoming, !!source);
    check(!source?.continuous||config.audio,'CONTINUOUS_AUDIO_CONFIGURATION_REQUIRED',503);
    check(!source || source.clockEvidence !== 'synthetic' || config.fixture_only,
        'SYNTHETIC_SOURCE_REQUIRES_FIXTURE_CONFIGURATION', 503);
    const archive = new RawArchive(storage, maxEventBytes, undefined, config.stream_budget);
    // Appends and reads share one journal: a second archive cached and re-verified every live lane again.
    const streamArchive = archive.streams;
    // One shared speech engine; continuous capture readies it before accepting a first wake. Other audio stays lazy.
    // A failed engine is replaced on a later use (see recoveringEngine); no provider fallback.
    let closed = false;
    let decoderWork:Promise<DemuxPort>|undefined,executionWork:Promise<LocalMediaExecution>|undefined;
    const demux=()=>decoderWork??=(async()=>{
        check(!closed,'LOCAL_AUDIO_CLOSED',503);
        check(storage instanceof PosixStorage,'DECODER_POSIX_STORAGE_REQUIRED',503);
        const runtime=join(storage.root,'runtime');
        executionWork=(async()=>{await fs.mkdir(runtime,{recursive:true,mode:0o700});return LocalMediaExecution.create({runtime,slots:1});})();
        const execution=await executionWork;
        return FfmpegDemux.create('/usr/bin/ffmpeg','/usr/bin/ffprobe',join(runtime,'decoders'),{
            timeout_ms:30000,max_input_bytes:1000000,max_output_bytes:1000000,max_chunks:512,
            max_pixels:16777216,max_metadata_bytes:1000000,max_duration_ms:30000},execution);
    })();
    const openSpeech=config.audio&&localModels&&!provided?await localModels.prepare(config.audio.config):undefined;
    const engines = recoveringEngine(() => {
        check(!closed, 'LOCAL_AUDIO_CLOSED', 503);
        check(config.audio, 'MEDIA_AUDIO_NOT_CONFIGURED', 503);
        return openSpeech?openSpeech():LocalSpeechEngine.open(config.audio.config);
    });
    const speech = engines.current;
    const localExecution = {close: async () => {
        closed = true;
        await Promise.all([engines.close(),(async()=>{if(executionWork)await (await executionWork).close();})()]);
    }};
    // One detector for finite selection, the transcription consumer and the continuous lane.
    const detector = new SherpaSileroStreamFactory(speech);
    const workers = new Map<string, WorkerPort>();
    if (config.audio) workers.set(LOCAL_SHERPA_AUDIO, new SherpaAudioWorker(speech, detector, source?.speakers));
    // The same engine and registry analyse a wake turn's request as one speaker turn.
    if (config.audio) workers.set(LOCAL_SHERPA_TURN, new SherpaAudioWorker(speech, detector, source?.speakers, 'turn'));
    if (config.windows_vision) workers.set('windows-vision', new WindowsVisionWorker(config.windows_vision.config, fetcher));
    const identityWorker=config.audio&&source?.speakers?new SherpaAudioWorker(speech,detector,source.speakers,'turn'):undefined;
    const voiceIdentity=provided?provided.voiceIdentity:identityWorker?async(request:import('./processing.ts').WorkerRequest,signal:AbortSignal)=>
        ({result:await identityWorker.analyzeIdentity(request,signal),capability:sherpaAudioCapability(await speech(),true,'turn')}):undefined;
    const processor = new MediaProcessor(storage, provided ? new Map(provided.workers) : workers, config.processing);
    async function availability(path: string) {
        const url = new URL(path, config.windows_vision!.config.base_url.replace(/\/$/u,'')+'/');
        const response = await fetcher(url, {redirect: 'error', signal: AbortSignal.timeout(5000)});
        check(response.ok, 'WINDOWS_AVAILABILITY_FAILED', 503);
        const text = await response.text();
        check(Buffer.byteLength(text) <= 65536, 'AVAILABILITY_RESPONSE_BUDGET');
        const value = JSON.parse(text);
        check(value !== null && typeof value === 'object' && !Array.isArray(value), 'WINDOWS_AVAILABILITY_INVALID');
        return value;
    }
    const capabilities: import('./processing.ts').CapabilitySource = async request => {
        const required = new Set(request.views.map(view => view.modality));
        const result: import('./processing.ts').Capability[] = [];
        if (required.has('audio') && config.audio) {
            try { result.push(sherpaAudioCapability(await speech(), source?.speakers !== undefined)); }
            catch { /* Unverified, missing or closed local models remain unavailable to source selection. */ }
        }
        if (required.has('visual') && config.windows_vision) {
            let verified = false;
            try {
                const evidence = config.windows_vision.verified_record ?
                    await readEvidenceFile(config.windows_vision.verified_record) as {model?: unknown;
                        validation?: {image_data_png_nonempty_correct?: unknown; image_counterfactual_correct?: unknown}} : undefined;
                verified = evidence?.model === config.windows_vision.config.model &&
                    evidence.validation?.image_data_png_nonempty_correct === true &&
                    evidence.validation?.image_counterfactual_correct === true;
            } catch { /* Unreadable or changed evidence cannot establish protocol support. */ }
            const replies = verified ? await Promise.allSettled([availability('/health'), availability('models')]) : [];
            const health = replies[0]?.status === 'fulfilled' ? replies[0].value :
                {status: 'unavailable', loaded_model: null, loading_model: null, last_error: 'UNAVAILABLE'};
            const models = replies[1]?.status === 'fulfilled' ? replies[1].value.data : [];
            const snapshot: WindowsVisionSnapshot = {captured_at: new Date().toISOString(), health,
                models: Array.isArray(models) ? models.flatMap((model: {id?: unknown} | null) =>
                    model && typeof model.id === 'string' ? [model.id] : []) : [],
                verified_png: verified, verified_counterfactual: verified};
            result.push(windowsVisionCapability(config.windows_vision.config, snapshot));
        }
        return result;
    };
    const continuous=source?.continuous?{budget:source.continuous.budget,onError:source.continuous.onError,
        detector:provided?.detector??detector}:undefined;
    const turn:import('./processing.ts').CapabilitySource|undefined=provided?provided.turn:config.audio?async()=>{
        try {return [sherpaAudioCapability(await speech(), source?.speakers !== undefined, 'turn')];} catch {return [];}
    }:undefined;
    const {continuous:_continuous,speakers:_speakers,...sourceFields}=source??{};
    const service = new MediaService({storage, archive, streamArchive, processor,
        capabilities: provided?.capabilities ?? capabilities, ...(voiceIdentity?{voiceIdentity}:{}), localExecution, demux:provided?.demux??demux,
        ...(provided ? {vad:provided.vad} : config.audio ? {
            // Loading verifies every pin, so a mismatch refuses here, before durable acceptance.
            authorizeVad: async () => {check((await speech()).available(), 'LOCAL_AUDIO_BUSY', 503);},
            vad: {candidates: (request, signal) => finiteVadSelection(detector,request,signal)}
        } : {}),
        align: config.alignment, max_segments: config.max_segments,
        max_window_ms: config.max_window_ms, fixtureOnly: config.fixture_only, ...sourceFields,...(continuous?{continuous}:{}),
        ...(turn?{turn:{capabilities:turn}}:{})});
    if((continuous||openSpeech)&&!provided)try {await speech();}catch(error){await service.close();throw error;}
    // `speech` is the composition's shared engine (enrollment, keyword spotting); it closes with the service.
    return {service, archive, ...(config.audio ? {speech,detector:provided?.detector??detector} : {})};
}
