import {callSpeechChannel,type CallSpeechChannel} from './call-speech-identity.ts';
import {DurableCaptureDetached} from '../../../services/personal-aios-integration/src/archive.ts';
import {randomUUID} from 'node:crypto';
import { terminalCapabilities, hasTerminalCapability, type RegisteredDevice } from '../../../services/personal-aios-integration/src/source-authority.ts';
import { DashScopeTts } from '../../../services/personal-aios-integration/src/tts.ts';
import { digest, check, type RawEvent, type TrustedContext } from '../../../services/personal-aios-integration/src/contracts.ts';
import { createPersonalAIOSAssembly } from '../../../services/personal-aios-integration/src/assembly.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { RealtimeCurrentBindingProjection, CurrentBindingLookup } from '../../../services/realtime-core/src/types.ts';
import type { LiveKitCloudParticipantPort } from './livekit-cloud-participant.ts';

import type { RealtimeBootstrapConnectedPort, RealtimeBootstrapConnectedInput } from './realtime-public-control-runtime.ts';
import { FormalSourceAuthority, FormalTerminalSources, createAppleCyclingTypedSourceResolver } from './personal-aios-formal-source.ts';
import { createFormalTextIngress, FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC } from './personal-aios-formal-text.ts';
import {createTimelineWire,createTurnWorkWire} from './personal-aios-terminal-wire.ts';
import {createOwnerOverrideWire} from './owner-override-wire.ts';
import {createAppearanceWire,type AppearancePricing} from './avatar-appearance-wire.ts';
import {createAvatarWire} from './personal-aios-avatar-wire.ts';
import type {AvatarProfileService} from './avatar-profile.ts';
import {createCallAvatarWire} from './call-avatar-wire.ts';
import { REALTIME_ASSISTANT_MAX_PACKET_BYTES } from './realtime-public-control-assistant-bridge.ts';
import { configureMediaReplay, type MediaProviderPorts, type MediaCompositionSource } from '../../../services/personal-aios-integration/src/media/setup.ts';
import type { DeviceType } from '../../../services/personal-aios-integration/src/contracts.ts';
import type { CredentialFencePort } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { createSourceMediaPermission } from './source-media-permission.ts';
import { createSourceMediaAdmission } from './source-media-admission.ts';
import { createSourceMediaClock, SourceClockUnavailableError, sourceStorageUnavailable, type SourceClockProvider } from './source-media-clock.ts';
import { createFormalPcmIngress, pcmEventId, type PcmCaptureBudget, type VoiceWindowPurpose } from './personal-aios-formal-pcm.ts';
import {embedSpeech,CALL_INTERRUPT_MIN_SPEECH_MS,speechQuality,type SpeechEmbeddingCache} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import { createVoiceCallSession, type FrontSession } from './voice-call-session.ts';
import {assertVideoCallConfiguration,VIDU_COMPONENT_RULES,VIDU_GESTURE_TOOL} from './vidu-call-session.ts';
import {createViduComponentPlayout} from './vidu-component-playout.ts';
import { createCallPlayout,CALL_PCM_LIMITS,type CallPlayout } from './call-playout.ts';
import type { LiveKitCloudTokenSignerPort } from './livekit-cloud-token-signer.ts';
import { createCallCamera, type CallCameraSegment } from './personal-aios-call-camera.ts';
import {CALL_VIDEO_SEGMENT_BYTES,callVideoResourcesSnapshot} from './call-video-encoder.ts';
import { AssistantVoiceLearner, learningTts } from '../../../services/personal-aios-integration/src/voiceprint/assistant-voice.ts';
import type {CallTurnResources} from '../../../services/personal-aios-integration/src/voice/qwen-resources.mjs';
import type {HermesClient} from '../../../services/personal-aios-integration/src/hermes-client.ts';
import { createErrandSpool } from './errand-spool.ts';
import {createSelfSurface} from './self-mcp.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import type { Notify } from './bark-notifier.ts';
import type {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import type { CallSink } from './personal-aios-formal-text.ts';
import {paymentClockMap,paymentCallAudio} from './personal-aios-payment-source.ts';

/** Identity evidence for an admitted paired-device call source; also used by the isolated call probe. */
export async function identifyPairedCallSpeech(registry:Pick<VoiceprintRegistry,'owner'|'identify'>|undefined,
  embed:(samples:Float32Array,signal:AbortSignal)=>Promise<Float32Array>,samples:Float32Array,speech_ms:number,signal:AbortSignal,observed_at=new Date().toISOString(),channel:CallSpeechChannel='call',cache?:SpeechEmbeddingCache,context?:{source:{principal_id:string;device_id:string;device_type:string}|undefined;call_id:string;trust_call:boolean;learning?:false},ownerOverride?:{active:()=>Promise<boolean>}
):Promise<{verdict:'owner'|'uncertain'|'guest'|'assistant'|'unknown';score?:number;call_only?:true;trust_window?:true;embedding?:Float32Array}|undefined> {
  if(await ownerOverride?.active())return {verdict:'owner',call_only:true};
  if(speech_ms<CALL_INTERRUPT_MIN_SPEECH_MS)return undefined;
  // Pairing admits the microphone, not its speaker. Without an enrolled voice nothing can be judged, so the speaker
  // is uncertain: the call asks Face ID once and the in-call anchor carries the rest.
  if(!registry)return {verdict:'uncertain'};
  const enrolled=(await registry.owner()).enrolled;
  const embedding=await embedSpeech({embed:part=>embed(part,signal)},samples,signal,{...(cache?{cache}:{})});
  const captureChannel=context?.source?callSpeechChannel(context.source,channel==='video'):channel;
  const identity=await registry.identify(embedding,{speech_ms,signal,mode:'call',channel:captureChannel,observed_at,...(context?.source?{principal_id:context.source.principal_id,device_id:context.source.device_id,...(context.trust_call&&context.learning!==false?{call_id:context.call_id}:{})}:{}),...(context?.learning===false?{learning:false as const}:{}),quality:speechQuality(samples)});
  if(identity.kind==='assistant')return {verdict:'assistant',score:identity.score,embedding};
  if(identity.kind==='owner')return {verdict:identity.band==='verified'?'owner':'uncertain',score:identity.score,embedding,...(identity.call_only?{call_only:true}:{}),...(identity.trust_window?{trust_window:true}:{})};
  if(!enrolled)return {verdict:'uncertain',embedding};
  if(identity.kind==='speaker')return {verdict:'guest',score:identity.score,embedding};
  return {verdict:'unknown',embedding};
}

export type CentralTextResources = import('../../../services/personal-aios-integration/src/main.ts').CentralProvisionResources & {desktop?:unknown;timeline?:import('../../../services/personal-aios-integration/src/timeline.ts').TimelineOptions};
export interface FormalPcmResources {
  configuration: unknown; producer: {device_type:DeviceType;channel:string}; budget:PcmCaptureBudget;
  span?: import('./source-media-clock.ts').SourceSpanDeclaration;
  input_contract?:'frame_v1'|'interval_v2';
  clock?: SourceClockProvider; ports?:MediaProviderPorts;
  continuous?:Omit<NonNullable<MediaCompositionSource['continuous']>,'onError'>;
  streamFactory?: Parameters<typeof createFormalPcmIngress>[0]['streamFactory'];
  cameraStreamFactory?:Parameters<typeof createCallCamera>[0]['streamFactory'];
  cameraEncoderFactory?:Parameters<typeof createCallCamera>[0]['encoderFactory'];
}
interface SharedTerminalSource {
  authority: FormalSourceAuthority;
  pcm: () => ReturnType<typeof createFormalPcmIngress>|undefined;
  clock: ReturnType<typeof createSourceMediaClock>|undefined;
  heard: (span:{start_ms:number;end_ms:number}) => boolean;
  realtimeBusy:()=>boolean;
  resourceSnapshot?:()=>unknown;
}
interface SharedExecution {
  closeResources:()=>Promise<void>;
  assembly: ReturnType<typeof createPersonalAIOSAssembly>;
  sources: FormalTerminalSources;
  terminals: Map<string, SharedTerminalSource>;
  admissions: Map<string, ReturnType<typeof createSourceMediaAdmission>>;
  media: Awaited<ReturnType<typeof configureMediaReplay>>|undefined;
  assistantVoice?: AssistantVoiceLearner;
  errands: ReturnType<typeof createErrandSpool>|undefined;
  desktop?:NonNullable<Awaited<ReturnType<typeof import('./desktop-relay.ts').createDesktopRelay>>>;
}
export type PersistentPublicExecutionSelection =
  {executionOwner:'hermes_text'; central:CentralTextResources;pcm?:FormalPcmResources};
// The central assembly is the sole public execution owner.
type PersistentPublicExecutionOptions = PersistentPublicExecutionSelection & {
  sharedExecution?: SharedExecution;
  desktopPool?:Parameters<typeof import('./desktop-relay.ts').createDesktopRelay>[0]['pool'];
  ownerMac?: ReturnType<typeof import('./owner-mac-ssh.ts').createOwnerMacSsh>;
  retainAssembly?: boolean;
  t03: import('./personal-aios-formal-source.ts').FormalSourceDeviceAuthority; readCurrentBinding: (lookup:CurrentBindingLookup)=>Promise<RealtimeCurrentBindingProjection|undefined>;
  watchSnapshot?: import('./apple-production-enrollment-owner.ts').AppleCurrentBindingSnapshotProvider;
  watchCredentials?: import('./personal-aios-formal-source.ts').FormalSourceOptions['watchCredentials'];
  deviceId:string; participant:LiveKitCloudParticipantPort; now?:()=>number;
  readCurrentBindingInAdmission?: Parameters<typeof createSourceMediaPermission>[0]['readCurrentBindingInAdmission'];
  credentialFence?:Pick<CredentialFencePort,'verify'|'withAdmission'>;
  onError:(error:unknown)=>void;
  /** Owner-only directory where the phone executor drops finished background errands. */
  errandSpool?:string;
  /** Phone notifications for results the app cannot take (Bark). */
  notify?:Notify;
  navigation?:CentralTextResources['navigation'];
  rideHrAlertBpm?:number;
  movementPendingTtlMs?:number;
  stagingEffects?:ReturnType<typeof import('./staging-effect-sink.ts').createStagingEffectSink>;
  avatar?:AvatarProfileService;
  appearancePricing?:AppearancePricing;
  avatarSigner?:LiveKitCloudTokenSignerPort;
  avatarOrigin?:string;
  avatarToken?:string;
  videoCall?:Pick<Parameters<typeof createViduComponentPlayout>[0],'configuration'|'apiKey'|'fetch'|'connect'|'journal'>;
  callRejoinWindowS?:number;
};

/** Host resources exist before any terminal is paired; terminal owners share this one assembly. */
export async function createPersistentPublicExecutionHost(options: Omit<PersistentPublicExecutionOptions,
  't03'|'deviceId'|'participant'|'sharedExecution'|'readCurrentBinding'>): Promise<SharedExecution> {
  const {tts, formal_voice, desktop, ...centralResources} = options.central;
  const sources = new FormalTerminalSources();
  const terminals = new Map<string, SharedTerminalSource>();
  const admissions = new Map<string, ReturnType<typeof createSourceMediaAdmission>>();
  const realtimeBusy=()=>[...terminals.values()].some(terminal=>terminal.realtimeBusy());
  const voiceWindows=!!centralResources.voice;
  let media:SharedExecution['media'];
  const clock=options.pcm?createSourceMediaClock(options.central.storage,options.pcm.clock!,async event=>{check(media,'MEDIA_NOT_CONFIGURED',503);return media.archive.readStreamHeader(event);}):undefined;
  const admissionFor = (trusted: TrustedContext) => {
    const source=trusted as TrustedContext & Pick<RegisteredDevice,'route_version'>;
    check(typeof source.route_version==='string','MEDIA_SOURCE_ROUTE_REQUIRED',503);
    const admission=admissions.get(source.device_id);check(admission,'MEDIA_SOURCE_AUTHORITY_NOT_CONFIGURED',503);return admission;
  };
  media = (options.pcm && clock ? await configureMediaReplay(options.central.storage,options.pcm.configuration,
    options.central.max_event_bytes,fetch,{
      withAppendAdmission:(raw,trusted,chunk,append)=>admissionFor(trusted).withAppendAdmission!(raw,trusted,chunk,append),
      withAppendBatchAdmission:(inputs,trusted,append)=>admissionFor(trusted).withAppendBatchAdmission!(inputs,trusted,append),
      authorizeClockMaps:(principal,maps,event,manifest)=>{
        const owner = terminals.get(event.device_id); check(owner?.clock,'SOURCE_CLOCK_REQUIRED',503);
        return owner.clock.authorizeClockMaps(principal,maps,event,manifest);
      },clockEvidence:clock.evidence,
      sourceWarnings:['SOURCE_PCM_SAMPLE_ORDINAL_NOT_HARDWARE_CONTINUITY'],
      ...(options.pcm.continuous?{continuous:{...options.pcm.continuous,onError:options.onError}}:{}),
      // The one voiceprint registry labels local transcription segments; its speaker model must be the engine's.
      ...(options.central.voiceprint?{speakers:options.central.voiceprint}:{}),
    },options.pcm.ports,options.central.local_models) : undefined);
  const notify=options.stagingEffects?.notify??options.notify;
  let assembly:ReturnType<typeof createPersonalAIOSAssembly>|undefined,desktopRelay:SharedExecution['desktop'];
  let errands:SharedExecution['errands'];
  let self:Awaited<ReturnType<typeof createSelfSurface>>|undefined;
  const assistantVoice=media?.speech&&options.central.voiceprint?new AssistantVoiceLearner(media.speech,options.central.voiceprint,{onError:options.onError}):undefined;
  try {
    if(centralResources.self_events&&centralResources.storage instanceof PosixStorage)self=await createSelfSurface({
      store:centralResources.self_events,storage:centralResources.storage,policy_version:centralResources.admission.policy_version,onError:options.onError,busy:realtimeBusy,
      ...(options.errandSpool?{errand_spool:options.errandSpool}:{}),
      ...(centralResources.l3?{l3:centralResources.l3}:{}),...(centralResources.voiceprint?{voiceprint:centralResources.voiceprint}:{}),
      ...(centralResources.http.model_route?{model_route:centralResources.http.model_route}:{})});
    {
      errands = options.errandSpool ? createErrandSpool(options.errandSpool, options.onError,{...(centralResources.storage instanceof PosixStorage?{originStorage:centralResources.storage}:{}),...(notify?{notify}:{}),
        deliver:result=>assembly?.runtime.deliverErrand(result,options.onError)??Promise.resolve(false),
        failed:(result,code,at,cause)=>assembly?.runtime.errandDeliveryFailed(result,code,at,cause)??Promise.resolve(false),
        progress:(principal,running)=>assembly?.runtime.errandProgress(principal,running,options.onError)??Promise.resolve()}) : undefined;
      await errands?.start();
    }
    {
      const resourceSnapshot=centralResources.http.resource_snapshot;
      Object.assign(centralResources.http,{...(self?{self}:{}),resource_snapshot:()=>{
        const video=callVideoResourcesSnapshot();return {...resourceSnapshot?.(),
          call_video:video,encoder_backlog:video.queued_bytes+video.stdin_bytes,
          terminals:[...terminals].map(([device_id,terminal])=>({device_id,resources:terminal.resourceSnapshot?.()??null}))};
      }});
    }
    assembly = createPersonalAIOSAssembly({...centralResources,sourceAuthority:sources,
      realtime_busy:realtimeBusy,
      ...(options.avatar?{avatar:options.avatar}:{}),
      ...(options.navigation?{navigation:options.navigation}:{}),movement:{...centralResources.movement,...(options.movementPendingTtlMs!==undefined?{pending_ttl_ms:options.movementPendingTtlMs}:{}),...(options.now?{now:options.now}:{}),
        ...(options.rideHrAlertBpm!==undefined?{ride_hr_alert_bpm:options.rideHrAlertBpm}:{})},
      // Care reaches the owner's phone without the app (Bark) and texts emergency contacts through the phone executor.
      ...(notify ? {notify} : {}),...(options.stagingEffects ? {care_sms:options.stagingEffects.sms,staging_outreach:options.stagingEffects.outreach} : errands ? {care_sms:errands.sms} : {}),
      ...(tts ? {output:{tts:assistantVoice ? learningTts(tts, assistantVoice) : tts}} : {}),
      ...(clock?{quarantine_admission:(raw,trusted,chunk,append)=>admissionFor(trusted).withQuarantineAdmission(raw,trusted,chunk,append)}:{}),
      ...(media ? {media:media.service,archive:media.archive} : {}),
      // The composition's one speech engine also measures the owner's enrollment windows (with the voiceprint registry).
      ...(media?.speech ? {speech:media.speech,speech_detector:media.detector,
        payment_clock_map:paymentClockMap(device=>terminals.get(device))} : {}),
      ...(options.pcm?{audio_route:async(source,event)=>terminals.get(source.device_id)?.pcm()?.route(event)}:{}),
      ...(voiceWindows?{call_heard:(_principal:string,device:string,span:{start_ms:number;end_ms:number})=>terminals.get(device)?.heard(span)===true}:{}),
      ...(options.pcm?.continuous&&clock?{continuous_context:async(source,event,chunk)=>{
        const terminal = terminals.get(source.device_id); check(terminal?.clock,'SOURCE_CLOCK_REQUIRED',503);
        const {binding}=await terminal.authority.captureSource(source);
        const maps=(await terminal.clock.archivedReceiptClockMaps(source.principal_id,event,binding)).filter(map=>map.modality==='visual'||
          (map.track_id===chunk.track_id&&map.stream_epoch===chunk.stream_epoch));
        return {session:binding.continuityId,clock_maps:maps};
      }}:{})});
    const central = assembly;
    if(errands)central.runtime.setErrandRefresh(errands.refresh);
    if(options.ownerMac)centralResources.http.ownerMac=options.ownerMac.resolve;
    if(options.central.timeline)await central.runtime.configureTimeline(options.central.timeline);
    desktopRelay=(desktop===undefined?undefined:await (await import('./desktop-relay.ts')).createDesktopRelay({config:desktop,analyzeVision:centralResources.native.analyzeVision.bind(centralResources.native),runtime:central.runtime,sources,pool:options.desktopPool!,http:centralResources.http,onError:options.onError,capabilityCatalog:central.runtime.capabilityGateway.tools}));
    if(desktopRelay)central.runtime.attachMeetingRelay(desktopRelay.invokePresentation);
    return {assembly,sources,terminals,admissions,media,errands,...(assistantVoice?{assistantVoice}:{}),...(desktopRelay?{desktop:desktopRelay}:{}),
      closeResources:async()=>{await Promise.all([errands?.close(),assistantVoice?.close()]);}};
  } catch(error) {
    await self?.close();await desktopRelay?.close();await errands?.close();await assistantVoice?.close();
    await (assembly?assembly.close():media?.service.close());throw error;
  }
}

export async function createPersistentPublicExecutionOwner(options: PersistentPublicExecutionOptions) {
  if(options.videoCall)assertVideoCallConfiguration(options.videoCall.configuration);
  const mode = options.executionOwner;
  check(mode === 'hermes_text', 'PUBLIC_EXECUTION_OWNER_INVALID');
  check(options.central && !['devices','sourceAuthority','media','output'].some(key=>Object.hasOwn(options.central!,key)), 'CENTRAL_OWNED_RESOURCES_REQUIRED');
  const terminalAuthority = options.t03.readCurrentAuthority?.();
  const terminal = {device_type:terminalAuthority?.deviceType ?? options.pcm?.producer.device_type ?? 'phone',
    capabilities:terminalAuthority?.capabilities};
  const capabilities = terminalCapabilities(terminal);
  check(!options.pcm || hasTerminalCapability(terminal,'microphone'), 'TERMINAL_MICROPHONE_REQUIRED',422);
  check(!options.pcm?.continuous || hasTerminalCapability(terminal,'continuous_audio'), 'TERMINAL_CONTINUOUS_AUDIO_REQUIRED',422);
  const {tts, formal_voice, desktop, ...centralResources} = options.central;
  check(!formal_voice || hasTerminalCapability(terminal,'speaker'), 'TERMINAL_SPEAKER_REQUIRED',422);
  check(!formal_voice || tts && formal_voice.transport === 'wav_byte_stream_v1', 'FORMAL_VOICE_CONFIGURATION_INVALID');
  check(tts === undefined || tts instanceof DashScopeTts, 'CENTRAL_TTS_RESOURCE_REQUIRED');
  if (options.pcm) check(!options.central.archive && options.credentialFence,
    'CENTRAL_PCM_SOURCE_RESOURCES_REQUIRED', 503);
  if (options.pcm) check(options.readCurrentBindingInAdmission, 'MEDIA_ADMISSION_READER_REQUIRED', 503);
  check(options.pcm?.input_contract===undefined||['frame_v1','interval_v2'].includes(options.pcm.input_contract),'PCM_INPUT_CONTRACT_INVALID');
  check(options.pcm?.input_contract!=='interval_v2'||!!options.pcm.continuous&&!!options.pcm.budget.archive_batch,'PCM_INTERVAL_BATCH_REQUIRED');
  // The one PCM reader routes every lane it carves; a second route source would split that authority.
  check(!options.pcm||!Object.hasOwn(options.central,'audio_route'),'PCM_ROUTE_CONFLICT');
  if(options.watchSnapshot)check(options.credentialFence && options.readCurrentBindingInAdmission,'WATCH_ADMISSION_RESOURCES_REQUIRED',503);
  // H voice windows are cut by the one PCM reader (never a sealed span); the ambient lanes around them keep their own
  // contract (interval_v2 continuous MEDIA or frame_v1).
  const voiceWindows = !!centralResources.voice;
  check(!voiceWindows || options.pcm && !options.pcm.span, 'VOICE_FRONTEND_REQUIRES_PCM_SOURCE', 503);
  const equality = createProductionStructuralEquality();
  const sourcePermission = options.credentialFence && options.readCurrentBindingInAdmission ? createSourceMediaPermission({readCurrentBinding:options.readCurrentBinding,
      readCurrentBindingInAdmission:options.readCurrentBindingInAdmission!,equality,credentialFence:options.credentialFence!,
      now:()=>new Date(options.now?.() ?? Date.now()).toISOString()}) : undefined;
  const shared = options.sharedExecution ?? await createPersistentPublicExecutionHost(options);
  const {sources,terminals,admissions,media,assembly,errands,assistantVoice} = shared;
  const desktopRelay=shared.desktop;
  try {
    const authority = new FormalSourceAuthority({credentialRegistry:sources,...(options.t03.place?{place:options.t03.place}:{}),ownerContext:options.t03.ownerContext,
      ...(options.t03.readActiveAuthority?{scheduled:{deviceId:options.deviceId,read:()=>options.t03.readActiveAuthority!()}}:{}),
      readCurrentBinding:options.readCurrentBinding,...(sourcePermission ? {runControlPermission:sourcePermission} : {}), sameRef:(a,b)=>equality.same(a as never,b as never),
      resolveSource:createAppleCyclingTypedSourceResolver({t03:options.t03,
        ...(formal_voice ? {playback:{device_id:options.deviceId,transport:formal_voice.transport}} : {}),
        producer:{device_id:options.deviceId,...options.pcm?.producer ?? {device_type:terminal.device_type,channel:'rtc_typed_text'}},
        ...(options.now ? {now:options.now} : {})}),
      // Voice actions and archived Watch controls re-read the current binding under the admission fence.
      ...(options.readCurrentBindingInAdmission ? {readCurrentBindingInAdmission:options.readCurrentBindingInAdmission} : {}),
      ...(options.watchSnapshot ? {watchSnapshot:options.watchSnapshot} : {}),
      ...(options.watchCredentials ? {watchCredentials:options.watchCredentials} : {}),
      ...(options.now ? {now:options.now} : {})});
    let pcmIngress:ReturnType<typeof createFormalPcmIngress>|undefined;
    const clock = options.pcm ? createSourceMediaClock(options.central.storage,options.pcm.clock!,async event=>{check(media,'MEDIA_NOT_CONFIGURED',503);return media.archive.readStreamHeader(event);}) : undefined;
    let admissionRoute:string|undefined,ownedAdmission:ReturnType<typeof createSourceMediaAdmission>|undefined;
    const registerAdmission = (source:Awaited<ReturnType<FormalSourceAuthority['authenticate']>>) => {
      check(clock,'SOURCE_CLOCK_REQUIRED',503);
      if(admissionRoute===source.route_version&&admissions.get(source.device_id)===ownedAdmission)return;
      // In-flight admissions retain their issued source. Durable archives replay without this terminal slot.
      ownedAdmission=createSourceMediaAdmission({clock,
        permission:createSourceMediaPermission({readCurrentBinding:options.readCurrentBinding,
          readCurrentBindingInAdmission:options.readCurrentBindingInAdmission!,equality,
          credentialFence:options.credentialFence!,now:()=>new Date(options.now?.() ?? Date.now()).toISOString()}),
        source:{capture:()=>authority.captureSource(source)},
        requestTeardown:async()=>{await pcmIngress?.stop('media_permission_denied',source.route_version);}});
      admissionRoute=source.route_version;admissions.set(source.device_id,ownedAdmission);
    };
    const notify=options.stagingEffects?.notify??options.notify;
    // The live call is fed by this gateway's one PCM reader, so it hears this device's microphone; the call session is the
    // authority on when it did (set once the session exists).
    let callHeard:((span:{start_ms:number;end_ms:number})=>boolean)|undefined;
    let callSnapshot:(()=>unknown)|undefined;
    let callBusy:(()=>boolean)|undefined;
    const realtimeBusy=()=>[...terminals.values()].some(terminal=>terminal.realtimeBusy());
    terminals.set(options.deviceId,{authority,pcm:()=>pcmIngress,clock,heard:span=>callHeard?.(span)===true,
      resourceSnapshot:()=>({pcm:pcmIngress?.snapshot()??null,call:callSnapshot?.()??null}),
      realtimeBusy:()=>callBusy?.()===true||pcmIngress?.snapshot().voice_active===true});
    const central=assembly;
    if(desktopRelay&&terminalAuthority)await desktopRelay.changed(terminalAuthority.userId);
    // One live call at a time, fed by the one PCM reader; its sinks are the current data-channel connection.
    const front = centralResources.voice as {createFront?: (callbacks: never) => FrontSession; frontVision?: boolean; frontExpressive?: boolean; ambientSilenceMs?: number; frontGreeting?: {enabled?: boolean; text?: string};thinkingMode?:import('../../../services/personal-aios-integration/src/voice/contracts.ts').ThinkingModeConfiguration;frontTurns?:CallTurnResources;classifyCall?:HermesClient['classifyCall'];searchCall?:HermesClient['searchCall']} | undefined;
    const createFront = front?.createFront, vision = front?.frontVision !== false, expressive = front?.frontExpressive !== false;
    const sinks = new Set<CallSink>();
    let componentOutput:ReturnType<typeof createViduComponentPlayout>|undefined,avatarMode=false,avatarFailure:string|undefined;
    const component=options.videoCall!==undefined;
    let videoIntent:{id:string;revision:number;video:boolean;closed:boolean}|undefined;
    const videoCommand=(id:string,command:{video:boolean;revision:number;opening?:true}|null)=>{
      if(!command){if(videoIntent?.id===id)videoIntent.closed=true;return;}
      if(command.opening&&videoIntent?.id!==id){videoIntent={id,revision:command.revision,video:command.video,closed:false};return;}
      if(videoIntent?.id!==id||videoIntent.closed||command.revision<videoIntent.revision)return;
      check(command.revision!==videoIntent.revision||command.video===videoIntent.video,'CALL_VIDEO_REVISION_CONFLICT',409);
      if(command.revision>videoIntent.revision)videoIntent={id,revision:command.revision,video:command.video,closed:false};
    };
    let avatarIntent:{id:string;revision:number;avatar:boolean;closed:boolean;work?:Promise<void>}|undefined;
    const avatarCommand=(id:string,command:{avatar:boolean;revision:number;opening?:true}|null)=>{
      if(!command){if(avatarIntent?.id===id)avatarIntent.closed=true;return;}
      if(command.opening&&avatarIntent?.id!==id){avatarIntent={id,revision:command.revision,avatar:command.avatar,closed:false};return;}
      if(avatarIntent?.id!==id)return;
      if(avatarIntent.closed||command.revision<avatarIntent.revision)return;
      check(command.revision!==avatarIntent.revision||command.avatar===avatarIntent.avatar,'CALL_AVATAR_REVISION_CONFLICT',409);
      if(command.revision>avatarIntent.revision)avatarIntent={id,revision:command.revision,avatar:command.avatar,closed:false};
    };
    const callSinks:Pick<Parameters<typeof createVoiceCallSession>[0],'onState'|'onTranscript'|'onTurn'|'onSealed'|'onError'>={
      onState:(id,state,extra)=>{
        if(replyArchive?.id===id&&replyArchive.failure!==undefined)extra={...extra,error_code:'CALL_ARCHIVE_COVERAGE_INCOMPLETE'};
        if(state==='closed'||state==='failed'){if(avatarIntent?.id===id)avatarIntent.closed=true;if(videoIntent?.id===id)videoIntent.closed=true;}
        const boundary=state==='closing'?pcmIngress?.finishSession():state==='closed'?finishCallArchive(id):state==='opening'?pcmIngress?.finishSession('call_start',id):undefined;
        const completed=state==='closing'&&call?.usesWakeAudio(id)?Promise.all([boundary,pcmIngress?.wake.close(id)]).then(()=>{}):boundary;
        const avatar={avatar:!['closing','closed','failed'].includes(state)&&(extra?.avatar??avatarMode),
          avatar_revision:extra?.avatar_revision??(avatarIntent?.id===id?avatarIntent.revision:0)};
        const publish=()=>Promise.all([...sinks].map(sink=>sink.state(id,state,{...extra,...avatar,
          ...(extra?.mode==='manual'&&['opening','connecting','live'].includes(state)?{
            video:extra.video??(videoIntent?.id===id&&videoIntent.video),video_revision:extra.video_revision??(videoIntent?.id===id?videoIntent.revision:0)}:{}),
          ...(avatarFailure?{error_code:avatarFailure}:{})})));
        let ready:Promise<void>|undefined;
        if(['opening','connecting','live'].includes(state)&&call?.usesWakeAudio(id)){
          check(pcmIngress,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);ready=pcmIngress.wake.open(id);
        }
        const delivery=ready?ready.then(()=>call?.pending()===id?publish():undefined):publish();
        if(state==='closing'){void delivery.catch(options.onError);return completed;}
        return Promise.all([completed,delivery]).then(()=>{});},
      onTranscript:(id,turn,role,text,interrupted,identity,expectsMirror)=>{for(const sink of sinks)sink.transcript(id,turn,role,text,interrupted,identity,expectsMirror);},
      onTurn:async(turn,audio)=>{const destinations=[...sinks];
        await Promise.all(destinations.map(sink=>sink.turn(turn,audio)));},
      onSealed:async(id,reason,finalTurn)=>{await Promise.all([...sinks].map(sink=>sink.sealed?.(id,reason,finalTurn)));},onError:options.onError};
    const closeCapture=new AbortController(),retainedIngressKeys=new Set<string>();
    const pendingCallArchive=new Set<Promise<void>>();
    let currentCameraCredential:object|undefined;
    let callArchiveBytes=0;
    type ReplyTrack={epoch:string;samples:number;seq:number;position:'estimate'|undefined;binding?:Promise<void>;admission?:Promise<void>;previous?:Promise<void>;rawRef?:string};
    type ReplyArchive={id:string;failure?:unknown;unaccepted_bytes:number;track?:ReplyTrack};
    let replyArchive:ReplyArchive|undefined;
    const archiveCapacity=new Set<()=>void>();
    // Avatar acknowledgements can cover its entire bounded playout queue in one callback.
    const replyReserve=CALL_PCM_LIMITS.max_samples*2;
    const callArchiveLimit=Math.max(options.pcm?.budget.max_pending_bytes??0,replyReserve*2)+CALL_VIDEO_SEGMENT_BYTES;
    const pauseAt=callArchiveLimit-replyReserve-CALL_VIDEO_SEGMENT_BYTES;
    const failReplyArchive=(state:NonNullable<typeof replyArchive>,error:unknown,bytes:number)=>{
      state.unaccepted_bytes+=bytes;if(state.failure!==undefined)return;state.failure=error;
      options.onError(new Error('CALL_ARCHIVE_COVERAGE_INCOMPLETE',{cause:error}));
      console.warn(JSON.stringify({call_archive_source:'incomplete',call_id:state.id,unaccepted_bytes:state.unaccepted_bytes}));
      void central.runtime.archiveAlert('reply_archive_coverage_incomplete').catch(options.onError);
      if(call?.pending()===state.id)void Promise.resolve(callSinks.onState(state.id,call.active()===state.id?'live':'connecting',
        {error_code:'CALL_ARCHIVE_COVERAGE_INCOMPLETE'})).catch(options.onError);
    };
    const observeArchive=(work:Promise<void>)=>{
      pendingCallArchive.add(work);void work.then(()=>pendingCallArchive.delete(work),()=>pendingCallArchive.delete(work));return work;
    };
    const finishReply=(track:ReplyTrack,endedBy='call_hangup')=>observeArchive((async()=>{
      // A failed admission is already this call's coverage gap; what was admitted still ends as one session.
      await Promise.allSettled([track.previous,track.admission]);
      if(track.rawRef)await central.runtime.existingArchive().endSession(track.rawRef,endedBy);
    })());
    const finishCallArchive=async(id:string)=>{
      const state=replyArchive?.id===id?replyArchive:undefined,track=state?.track;
      if(state)delete state.track;
      if(track)await finishReply(track);
    };
    const archiveCall=async(payload:Buffer,chunk:import('../../../services/personal-aios-integration/src/stream-archive.ts').TrackChunk,callId?:string,captureCredential?:object,reply?:ReplyArchive,replyTrack?:ReplyTrack)=>{
      if(!pcmIngress||!clock){const error=new Error('CALL_ARCHIVE_SOURCE_UNAVAILABLE');if(reply)failReplyArchive(reply,error,payload.length);throw error;}
      if(reply?.failure!==undefined){reply.unaccepted_bytes+=payload.length;throw reply.failure;}
      if(callArchiveBytes+payload.length>callArchiveLimit){const error=new Error('CALL_ARCHIVE_BACKLOG');if(reply)failReplyArchive(reply,error,payload.length);throw error;}
      callArchiveBytes+=payload.length;
      const context=(async()=>{
        // Reserve the waiting segment too. Only recording yields; the bounded reader's preview stays independent.
        while(!callId&&callArchiveBytes-payload.length>=pauseAt&&!closeCapture.signal.aborted)await new Promise<void>(resolve=>archiveCapacity.add(resolve));
        const {trusted,binding}=await (captureCredential?authority.capture(captureCredential):pcmIngress!.capture()),source=await (captureCredential?authority.authenticate(captureCredential):pcmIngress!.source());
        try{return {trusted,binding,source,timing:await clock!.capture(binding,chunk)};}
        catch(error){if(error instanceof SourceClockUnavailableError){if(error.code==='MEDIA_CLOCK_BASIS_STORAGE_UNAVAILABLE')options.onError(error);return {trusted,binding,source,timing:null};}throw error;}
      })();
      const work=context.then(async({trusted,binding,source,timing})=>{
        const input:Omit<RawEvent,'captured_at'|'time_range'>={schema_version:'paios.event.v1',event_id:pcmEventId(binding.continuityId,chunk.stream_epoch),
          device_id:trusted.device_id,device_type:trusted.device_type,
          source:{channel:trusted.channel,...(trusted.relay_device_id?{relay_device_id:trusted.relay_device_id}:{})},
          media_type:chunk.modality==='visual'?'visual':'audio',mime:chunk.modality==='visual'?'video/h264':'audio/pcm',
          representation:chunk.modality==='visual'?'encoded_video_segment':'received_decoded_sample',payload};
        if(callId&&replyTrack)await (replyTrack.binding??=central.runtime.existingArchive().bindCallTrack(`l5:${digest({event_id:input.event_id,principal_id:trusted.principal_id,device_id:input.device_id})}`,{call_id:callId,principal_id:trusted.principal_id,track:'assistant_reply'}));
        const admitted=timing?await central.runtime.admitMedia({...input,...timing.metadata,source:{...input.source,capture_timing:timing.capture_timing}},source,chunk)
          :await central.runtime.admitQuarantinedMedia({...input,captured_at:null,capture_clock_status:'unknown'},source,chunk);
        if(timing&&replyTrack)replyTrack.rawRef=`l5:${digest({event_id:input.event_id,principal_id:trusted.principal_id,device_id:input.device_id})}`;
        observeArchive(central.runtime.existingArchive().waitPublished<unknown>(admitted,closeCapture.signal).then(()=>{},error=>{
          if(error instanceof DurableCaptureDetached){error.ingress_keys.forEach(key=>retainedIngressKeys.add(key));console.info(JSON.stringify({call_archive_source:'retained',reason:'durable_pending_source_closed'}));return;}
          if(reply)failReplyArchive(reply,error,0); // The original is already durable; only future projection is skipped.
          else{void central.runtime.archiveAlert('camera_archive_publication_failed',source.principal_id).catch(options.onError);if(captureCredential===currentCameraCredential)camera?.pauseRecording(error);}
          throw error;
        }));
      }).catch(error=>{if(reply)failReplyArchive(reply,error,payload.length);throw error;}).finally(()=>{callArchiveBytes-=payload.length;
        for(const resume of archiveCapacity)resume();archiveCapacity.clear();});
      return observeArchive(work);
    };
    check(!options.pcm||media!.service.archiveBudget.max_chunk_bytes>=2&&options.central.max_event_bytes>=2,'CALL_ARCHIVE_PCM_BUDGET_INVALID');
    const archiveReply=(state:ReplyArchive,pcm:Int16Array,position?:'estimate')=>{
      const {id}=state;
      if(state.failure!==undefined){state.unaccepted_bytes+=pcm.byteLength;return;}
      const budget=media!.service.archiveBudget;
      const size=Math.floor(Math.min(budget.max_chunk_bytes,options.central.max_event_bytes,budget.max_total_bytes,options.pcm!.budget.max_samples*2)/2);
      for(let offset=0;offset<pcm.length;offset+=size){
        if(state.failure!==undefined){state.unaccepted_bytes+=(pcm.length-offset)*2;break;}
        const part=pcm.subarray(offset,offset+size);let track=state.track;
        if(!track||track.position!==position||track.samples+part.length>Math.min(options.pcm!.budget.max_samples,budget.max_total_bytes/2)||track.seq>=Math.min(budget.max_chunks,budget.max_revisions,budget.max_seq+1)){
          const previous=track?finishReply(track,'bounded_rollover'):undefined;void previous?.catch(options.onError);
          track={epoch:digest(['call-reply',id,randomUUID()]),samples:0,seq:0,position,...(previous?{previous}:{})};state.track=track;
        }
        const start=track.samples;track.samples+=part.length;
        const admitted=archiveCall(Buffer.from(Buffer.from(part.buffer,part.byteOffset,part.byteLength)),{track_id:'assistant_reply',stream_epoch:track.epoch,seq:track.seq++,modality:'audio',format:'pcm_s16le:24000:1',
          source_range:{kind:'interval',timebase_id:`${position==='estimate'?'render-estimate':'played'}-pcm:${track.epoch}`,stream_epoch:track.epoch,start_ms:start/24,end_ms:track.samples/24}},id,undefined,state,track).catch(options.onError);
        track.admission=Promise.all([track.admission,admitted]).then(()=>{});
      }
    };
    check(!component||front?.frontTurns?.config.enabled===true,'VIDU_COMPONENT_TURN_MANAGER_REQUIRED');
    const call:ReturnType<typeof createVoiceCallSession>|undefined = voiceWindows && capabilities.includes('speaker') && createFront ? createVoiceCallSession({room:()=>options.participant.roomPort as never,
      ...(options.callRejoinWindowS!==undefined?{callRejoinWindowS:options.callRejoinWindowS}:{}),...(options.now?{now:options.now}:{}),
      ...(front?.thinkingMode?{thinking_mode:front.thinkingMode}:{}),
      onReadoutFidelity:async(source,call_id,evidence)=>{check(source,'CALL_SOURCE_REQUIRED',409);
        await central.runtime.existingArchive().archive({schema_version:'paios.event.v1',
          event_id:`call-readout:${digest([call_id,evidence.message_id??null,evidence.sentence_index,evidence.response_id])}`,
          captured_at:new Date().toISOString(),device_id:source.device_id,device_type:source.device_type,source:{channel:source.channel},
          media_type:'app_event',mime:'application/json',representation:'uploaded_original',
          payload:Buffer.from(JSON.stringify({kind:'call_readout_fidelity',call_id,...evidence}))},{...source,submission:'observation'});},
      onReplyState:(source,id,turn,active,closed)=>central.runtime.callReplyState(source,id,turn,active,closed),
      pendingWork:(id,source)=>!!source&&central.runtime.pendingCallWork(source.principal_id,id),
      watchWork:(source,changed)=>central.runtime.watchTurnWork(source,changed),
      captureActive:()=>pcmIngress?.capturing()===true,componentVideo:component,createPlayout:(room,id,reset,onError,mode,budget,extra)=>{
        const archiveState:ReplyArchive={id,unaccepted_bytes:0};replyArchive=archiveState;
        const played=options.pcm?(pcm:Int16Array,position?:'estimate')=>archiveReply(archiveState,pcm,position):undefined;
        const phone=createCallPlayout(room,id,reset,onError,budget,played);
        if(!component)return phone;avatarMode=false;avatarFailure=undefined;
        // A silent subscribed phone track keeps LiveKit's one duplex/AEC engine running during video and background.
        let renderer:ReturnType<typeof createViduComponentPlayout>|undefined,route:CallPlayout=phone,revision=0,closed=false,position=0,origin=0;
        // Pin the appearance when the call opens, including calls that enable the avatar later.
        const appearance=Promise.allSettled([options.avatar&&terminalAuthority
          ? options.avatar.activeAvatarId(terminalAuthority.userId).then(avatar_id=>({...options.videoCall!.configuration,
            avatar_id:avatar_id??options.videoCall!.configuration.avatar_id}))
          : Promise.resolve(options.videoCall!.configuration)]);
        const retiring=new Set<Promise<void>>();
        const retire=(previous:typeof renderer)=>{const work=Promise.resolve().then(()=>previous?.close());retiring.add(work);
          void work.then(()=>retiring.delete(work),()=>{});return work;};
        const playedSamples=()=>position+(route.playedSamples!()-origin);
        const resetAvatar=()=>{for(const sink of sinks)try{sink.playbackReset?.(id,undefined,'avatar');}catch(error){onError(error);}};
        const voice=()=>{const previous=renderer,tail=previous?.takeUnplayed()??[];position=playedSamples();origin=phone.playedSamples!();
          route=phone;renderer=componentOutput=undefined;
          if(previous)resetAvatar();
          for(const {pcm,credit} of tail)phone.push(pcm,credit);return previous;};
        const setAvatar=async(enabled:boolean,commandRevision?:number)=>{
          check(!closed,'VOICE_CALL_SUPERSEDED',409);
          if(commandRevision===undefined&&avatarIntent?.id===id){avatarIntent={...avatarIntent,avatar:enabled};delete avatarIntent.work;}
          const expected=commandRevision??(avatarIntent?.id===id?avatarIntent.revision:extra.avatar_revision??0);
          const intended=()=>!avatarIntent||avatarIntent.id===id&&!avatarIntent.closed&&avatarIntent.revision===expected&&avatarIntent.avatar===enabled;
          if(!intended())return;
          if(enabled&&renderer&&avatarMode){await callSinks.onState(id,call?.active()===id?'live':'connecting',{mode,avatar:true,avatar_revision:expected});return;}
          const generation=++revision;if(enabled)avatarFailure=undefined;else avatarMode=false;
          const current=()=>!closed&&generation===revision&&intended();
          if(!enabled){const previous=voice();try{await Promise.all([...retiring,retire(previous)]);}catch(error){onError(error);avatarFailure='VIDU_COMPONENT_CLEANUP_FAILED';throw error;}
            if(current())await callSinks.onState(id,call?.active()===id?'live':'connecting',{mode,avatar:false,avatar_revision:expected});return;}
          if(renderer){avatarMode=false;void retire(voice()).catch(onError);}
          await Promise.all([...retiring]);await phone.drain();if(!current())return;
          const [pinned]=await appearance;
          if(pinned!.status==='rejected')throw pinned!.reason;
          const configuration=pinned!.value;
          if(!current())return;
          const next=createViduComponentPlayout({id,configuration,apiKey:options.videoCall!.apiKey,budget,
            ...(options.videoCall!.fetch?{fetch:options.videoCall!.fetch}:{}),onError,...(options.videoCall!.connect?{connect:options.videoCall!.connect}:{}),
            ...(options.videoCall!.journal?{journal:options.videoCall!.journal}:{}),
            onReset:resetAvatar,onRetired:pcm=>played?.(pcm,'estimate'),
            onMedia:async media=>{if(current()){await callSinks.onState(id,call?.active()===id?'live':'connecting',{mode,avatar:true,avatar_revision:expected,media});}},
            onEnded:()=>{if(!closed&&renderer===next){avatarFailure='VIDU_COMPONENT_ENDED';
              if(current())void call!.setAvatar(id,false).catch(options.onError);
              else{avatarMode=false;voice();void retire(next).catch(onError);void call!.setAvatar(id,false).catch(options.onError);}}}});
          renderer=componentOutput=next;
          try{await next.open();if(current()){await phone.drain();if(current()){
                position=playedSamples();origin=next.playedSamples!();route=next;avatarMode=true;return;}}
            if(renderer===next){avatarMode=false;voice();}await retire(next);}
          catch(error){const cleanup=retire(next);try{if(!closed&&generation===revision){avatarMode=false;avatarFailure='VIDU_COMPONENT_CREATE_FAILED';voice();
                if(avatarIntent?.id===id&&avatarIntent.revision===expected)avatarIntent.avatar=false;
                await callSinks.onState(id,call?.active()===id?'live':'connecting',{mode,avatar:false,avatar_revision:expected,error_code:'VIDU_COMPONENT_CREATE_FAILED'});}}
            finally{await cleanup;}if(!closed&&generation===revision)throw error;}
        };
        return {get thinkingAtCommit(){return route.thinkingAtCommit===true;},open:()=>phone.open(),
          rebindRoom:next=>phone.rebindRoom!(next),playedSamples,push:(pcm,credit,skippable)=>route.push(pcm,credit,skippable),skip:()=>route.skip?.()??0,interrupt:preserve=>{route.interrupt(preserve);position=0;origin=route.playedSamples!();},
          drain:async()=>{let draining:CallPlayout;do{draining=route;await draining.drain();}while(!closed&&draining!==route);},setCallAvatar:setAvatar,
          close:async()=>{closed=true;revision++;avatarMode=false;const previous=renderer;renderer=componentOutput=undefined;
            const result=await Promise.allSettled([retire(previous),...retiring,Promise.resolve().then(()=>phone.close())]);
            const errors=result.flatMap(item=>item.status==='rejected'?[item.reason]:[]);if(errors.length)throw new AggregateError(errors,'CALL_PLAYOUT_CLEANUP_FAILED');}};
      },createFront:callbacks=>{
        let conversationMode=callbacks.conversation_mode;
        const instructions=(value:string)=>component&&conversationMode!=='thinking'?`${value}\n${VIDU_COMPONENT_RULES}\n${avatarMode?'数字人已打开。动作只控制数字人，不能冒充主人的摄像头。':'数字人未打开。不能执行数字人动作。'}`:value;
        let tools=callbacks.tools??[];
        const combined=()=>conversationMode==='thinking'?[]:[...tools,...(component&&avatarMode?[VIDU_GESTURE_TOOL]:[])];
        const session=createFront({...callbacks,instructions:instructions(callbacks.instructions),tools:combined(),
          onTool:(name:string,args:unknown)=>name==='avatar_gesture'?
            avatarMode&&componentOutput?componentOutput.action((args as {action?:unknown})?.action):{sent:false}:callbacks.onTool?.(name,args)} as never);
        const update=session.setInstructions?.bind(session);return component&&update?{...session,setInstructions:(value,extra)=>{
          const previousTools=tools;if(extra?.tools)tools=extra.tools;
          const previous=conversationMode;conversationMode=extra?.conversation_mode??conversationMode;
          return update(instructions(value),{...extra,tools:combined()}).catch(error=>{conversationMode=previous;tools=previousTools;throw error;});}}:session;
      },
      resolveTurnAudio:references=>paymentCallAudio(references,
        {pcm:()=>pcmIngress,clock},central.runtime.existingArchive()),
      ...(front?.frontTurns?{turns:front.frontTurns}:{}),...(front?.classifyCall?{classifySpeech:front.classifyCall}:{}),
      ...(front?.searchCall?{searchCall:front.searchCall}:{}),
      ...(options.central.voiceprint?{voiceprint:options.central.voiceprint}:{}),
      speechChannel:source=>callSpeechChannel(source,!!(videoIntent?.video&&!videoIntent.closed)),
      confirmSpeech:(source,session,turn,signal)=>central.runtime.confirmCallSpeech(source,session,turn,signal),
      ...(media?.speech?{openVad:async signal=>(await media!.speech!()).openCallVad(signal),
        openKeywords:async signal=>{const engine=await media!.speech!();return engine.keywords?engine.openCallKeywords(signal):undefined;},
        identifySpeech:(samples,speech_ms,signal,observed_at,cache,context)=>identifyPairedCallSpeech(options.central.voiceprint,
          async(samples,signal)=>{const engine=await media!.speech!(),registry=options.central.voiceprint;
            check(!registry||engine.speaker_model.id===registry.model.id&&engine.speaker_model.sha256===registry.model.sha256&&engine.speaker_model.dim===registry.model.dim,'VOICEPRINT_SPEAKER_MODEL_MISMATCH',503);
            return engine.embedCall(samples,signal);},samples,speech_ms,signal,observed_at,videoIntent?.video&&!videoIntent.closed?'video':'call',cache,context,options.central.owner_override),
        transcribeSpeech:async(samples,signal)=>(await (await media!.speech!()).transcribe(samples,signal)).text}:{}),
      ...(front?.ambientSilenceMs!==undefined?{ambient_silence_ms:front.ambientSilenceMs}:{}),
      onPlaybackReset:(id,sid)=>{for(const sink of sinks)sink.playbackReset?.(id,sid);},
      ...callSinks,onAttention:reason=>camera?.focus(reason),vision,expressive,...(front?.frontGreeting?{greeting:front.frontGreeting}:{}),
      ...(assistantVoice ? {onVoiceAudio:assistantVoice.stream('realtime_call',24000)} : {})}) : undefined;
    callHeard = call?.heard;callSnapshot=()=>({...call?.resourceSnapshot(),camera:camera?.snapshot(),archive:{pending_bytes:callArchiveBytes,call_id:replyArchive?.id,coverage_incomplete:replyArchive?.failure!==undefined,unaccepted_bytes:replyArchive?.unaccepted_bytes??0}});callBusy=call?.realtimeBusy;
    // Realtime rollback is voice-only; camera originals keep the one archive authority.
    // Camera acquisition belongs to the owner source; the realtime model receives an optional JPEG projection.
    const camera:ReturnType<typeof createCallCamera>|undefined = options.pcm && capabilities.includes('camera') ? createCallCamera({participant:options.participant,sink:()=>vision&&call?.active()?call.pushImage:undefined,
      ...(options.pcm?{createArchive:(input:RealtimeBootstrapConnectedInput)=>{
        const captureCredential=authority.credentialForBootstrap(input);currentCameraCredential=captureCredential;
        let cameraTrack:{epoch:string;sourceTrackId:string;format:string;origin:number;seq:number;bytes:number}|undefined;
        return async(segment:CallCameraSegment)=>{
        const format=`h264:${segment.width}:${segment.height}:rotation:${segment.rotation*90}`,budget=media!.service.archiveBudget,payload=segment.bytes;
        if(!cameraTrack||cameraTrack.sourceTrackId!==segment.trackId||cameraTrack.format!==format||cameraTrack.bytes+payload.length>budget.max_total_bytes||cameraTrack.seq>=Math.min(budget.max_chunks,budget.max_revisions,budget.max_seq+1))
          cameraTrack={epoch:digest(['call-camera',segment.trackId,randomUUID()]),sourceTrackId:segment.trackId,format,origin:segment.startedAt,seq:0,bytes:0};
        const track=cameraTrack;
        await archiveCall(payload,{track_id:'call_camera',stream_epoch:track.epoch,seq:track.seq,modality:'visual',format,
          source_video:{track_id:segment.trackId,frame_count:segment.frameCount,width:segment.width,height:segment.height,source_width:segment.sourceWidth,source_height:segment.sourceHeight,rotation:segment.rotation*90,
            frames:segment.sourceFrames.map(frame=>({timestamp_us:frame.timestampUs,received_at_ms:frame.receivedAt}))},
          source_range:{kind:'interval',timebase_id:`received-camera:${track.epoch}`,stream_epoch:track.epoch,start_ms:segment.startedAt-track.origin,end_ms:Math.max(segment.endedAt-track.origin+1,segment.startedAt-track.origin+1)}},undefined,captureCredential);
        track.bytes+=payload.length;track.seq++;
      };}}:{}),
      ...(options.pcm?.cameraEncoderFactory?{encoderFactory:options.pcm.cameraEncoderFactory}:{}),
      ...(options.pcm?.cameraStreamFactory?{streamFactory:options.pcm.cameraStreamFactory}:{}),
      onError:error=>{options.onError(error);void central.runtime.archiveAlert('camera_capture_paused').catch(options.onError);}}) : undefined;
    const callWire:NonNullable<Parameters<typeof createFormalTextIngress>[0]['voice_call']>|undefined=call?{videoCommand,avatarCommand,
        open:async(id,extra)=>{if(extra?.video_revision!==undefined&&videoIntent&&(videoIntent.id!==id||videoIntent.closed))return Promise.resolve();
          if(avatarIntent?.id!==id)avatarIntent={id,revision:0,avatar:false,closed:false};
          const current={...extra};if(videoIntent?.id===id){current.video_revision=videoIntent.revision;if(videoIntent.video)current.video=true;else delete current.video;}
          current.avatar_revision=avatarIntent.revision;if(avatarIntent.avatar)current.avatar=true;else delete current.avatar;
          if(current.source&&!current.enrollment_instructions)current.conversation_mode??=front?.thinkingMode?.enabled?await central.runtime.callConversationMode(current.source):'chat';
          check(extra?.conversation_mode!=='thinking'||front?.thinkingMode?.enabled,'CALL_THINKING_MODE_DISABLED',409);
          if(!front?.thinkingMode?.enabled)current.conversation_mode='chat';
          const opened=await call.open(id,current);
          if(extra?.conversation_mode&&extra.source&&!extra.enrollment_instructions)await central.runtime.rememberCallConversationMode(extra.source,current.conversation_mode!);
          return opened;},
        pcm:(id,frame)=>{check(call.pending()===id&&call.usesWakeAudio(id),'WAKE_PCM_CALL_REQUIRED',409);
          check(pcmIngress,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);return pcmIngress.wake.append(id,frame);},
        close:(id,reason,errorCode)=>{videoCommand(id,null);avatarCommand(id,null);return call.close(id,reason,errorCode);},respond:(text,target,care)=>call.respond(text,target,care),request:(text,target)=>call.request(text,target),
        setVideo:async(id:string,enabled:boolean,revision?:number)=>{
          const intent=videoIntent;if(intent&&(intent.id!==id||intent.closed||revision!==undefined&&(intent.revision!==revision||intent.video!==enabled)))return;
          if(intent&&revision===undefined)intent.video=enabled;
          if(call.pending()===id)await call.setVideo(id,enabled,revision??intent?.revision);
        },
        setAvatar:async(id:string,enabled:boolean,revision?:number)=>{
          if(revision===undefined&&avatarIntent?.id===id){avatarIntent={...avatarIntent,avatar:enabled};delete avatarIntent.work;}
          const intent=avatarIntent;if(intent&&(intent.id!==id||intent.closed||revision!==undefined&&(intent.revision!==revision||intent.avatar!==enabled)))return;
          if(!component)avatarFailure=enabled?'AVATAR_CALL_DISABLED':undefined;
          const ack=()=>callSinks.onState(id,call.active()===id?'live':'connecting',{avatar:component&&avatarMode,avatar_revision:intent?.revision??0});
          if(intent?.work){if(enabled){await intent.work;return;}
            // A lost ACK or failed instruction refresh must not poison reconciliation of the completed OFF.
            await Promise.allSettled([intent.work]);if(avatarIntent===intent&&!intent.closed&&!avatarMode)await ack();return;}
          // An OFF may precede asynchronous call authorization. Opening uses the recorded latest intent.
          if(call.pending()!==id){if(intent&&!enabled)await ack();return;}
          const work=component?call.setAvatar(id,enabled,intent?.revision):Promise.resolve(ack());if(intent)intent.work=work;
          try{await work;}catch(error){if(intent?.work===work)delete intent.work;throw error;}},
        conversationMode:call.conversationMode,setConversationMode:call.setConversationMode,thinkingStatus:call.thinkingStatus,thinkingSettled:call.thinkingSettled,
        context:text=>call.context(text),pending:()=>call.pending(),trustCall:call.trustCall,
        peerLost:call.peerLost,rejoin:call.rejoin,
        ...(options.videoCall?{isVideo:()=>videoIntent?.video===true&&!videoIntent.closed}:{}),
        ...(call?{identify:call.identify}:{}),attach:(sink:CallSink)=>{sinks.add(sink);return()=>{sinks.delete(sink);};}}:undefined;
    const ingress = createFormalTextIngress({participant:options.participant,runtime:central.runtime,authority,
      realtime_busy:realtimeBusy,
      extensions:[...(desktopRelay?.extensions??[]),createTimelineWire(central.runtime,options.onError),createTurnWorkWire(central.runtime,options.onError),
        ...(centralResources.owner_override?[createOwnerOverrideWire(central.runtime,options.onError)]:[]),
        ...(options.avatar?[createAvatarWire(options.avatar,options.onError),createAppearanceWire(options.avatar,options.appearancePricing)]:[]),
        ...(callWire?[createCallAvatarWire(central.runtime,callWire,options.onError,options.appearancePricing?.callQuote)]:[])],
      max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,...(formal_voice ? {voice_transport:formal_voice.transport} : {}),
      ...(voiceWindows ? {voice_capture:{open:(operation:string,purpose?:VoiceWindowPurpose)=>{check(pcmIngress,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);return pcmIngress.voice.open(operation,purpose);},
        commit:(operation:string,purpose?:VoiceWindowPurpose)=>{check(pcmIngress,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);return pcmIngress.voice.commit(operation,purpose);},
        cancel:(operation:string)=>pcmIngress?.voice.cancel(operation)??false}} : {}),
      ...(callWire?{voice_call:callWire}:{}),
      ...(errands ? {errands:{cancel:errands.cancel}} : {}),...(notify ? {notify} : {}),
      onError:options.onError});
    let closing:Promise<void>|undefined;
    if (options.pcm) pcmIngress = createFormalPcmIngress({participant:options.participant,runtime:central.runtime,authority,
      ...(options.pcm.span?{span:options.pcm.span}:{}),...(options.pcm.input_contract?{input_contract:options.pcm.input_contract}:{}),
      budget:options.pcm.budget,...(call?{captureDecision:call.captureDecision}:{}),...(media?{max_archive_chunk_bytes:media.service.archiveChunkBytes}:{}),clock:clock!,onError:options.onError,onSource:registerAdmission,publicationWaitSignal:closeCapture.signal,onCapturePaused:(reason,principal)=>central.runtime.archiveAlert(reason,principal),
      ...(call&&(options.pcm.continuous||capabilities.includes('microphone'))?{onCapture:(active:boolean)=>active&&!closing?call.prepare():call.unprepare()}:{}),
      // Acquisition ends every archived lane; detector presence and terminal shutdown do not change that fact.
      finishArchived:async(snapshot,endedBy)=>{await central.runtime.finalizeMediaSession(snapshot.event,snapshot.chunk,endedBy);},
      finishUnpublished:async(rawRef,endedBy)=>{await central.runtime.existingArchive().endSession(rawRef,endedBy);},
      ...(options.pcm.streamFactory ? {streamFactory:options.pcm.streamFactory} : {})});
    if (pcmIngress && call) pcmIngress.tap((pcm,archive)=>{if(!closing&&(options.pcm?.continuous||capabilities.includes('microphone')))call.prepare();call.pushPcm(pcm,archive);});
    const bridge:RealtimeBootstrapConnectedPort = Object.freeze({
      assertBootstrapRequest:(request:Record<string,unknown>)=>{
        const media=request.requested_media as Record<string,unknown>|undefined;
        const start=request.start as Record<string,unknown>|undefined;
        // Authorized camera originals are independent of the call model and its visual-input support.
        const audio = media?.audio === true && !!options.pcm;
        const video = media?.video === true && !!camera;
        const expected = ['data',...(audio ? ['audio'] : []),...(video ? ['video'] : [])];
        check(media?.data === true && media.audio === audio && (media.video === false || video) &&
          Array.isArray(start?.modalities) && start.modalities.length === expected.length &&
          expected.every(modality=>(start.modalities as unknown[]).includes(modality)),
          options.pcm ? 'HERMES_PCM_DATA_AUDIO_REQUIRED' : 'HERMES_TEXT_ONLY_DATA_REQUIRED',422);
      },
      centralTextTransport:Object.freeze({inputTopic:FORMAL_TEXT_INPUT_TOPIC,outputTopic:FORMAL_TEXT_OUTPUT_TOPIC,maxPacketBytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,...(formal_voice ? {voiceTransport:formal_voice.transport} : {}),...(call?{callRejoinWindowS:call.rejoinWindowS}:{})}),
      callRejoinForDevice:(deviceId:string)=>deviceId===options.deviceId?call?.callRejoin():undefined,
      onBootstrapConnected:async(input:RealtimeBootstrapConnectedInput)=>{
        ingress.beginBootstrap();
        // Admission follows the authority-issued route; old captures keep their own source projection.
        await pcmIngress?.onBootstrapConnected(input);
        let cameraReady=pcmIngress?.snapshot().paused_reason!=='capture_storage_unavailable';
        if(input.enabledMedia.video&&!input.enabledMedia.audio)try{await central.runtime.existingArchive().prepareCapture();}
        catch(error){if(!sourceStorageUnavailable(error))throw error;options.onError(error);await central.runtime.archiveAlert('camera_capture_storage_unavailable');cameraReady=false;}
        if(cameraReady)await camera?.onBootstrapConnected(input);
        // The phone starts publishing on ready; register raw consumers before admitting that producer.
        await ingress.onBootstrapConnected(input);},
      close:()=>closing??=(async()=>{
        if(!options.retainAssembly&&!options.sharedExecution)central.runtime.cancelMediaProcessing();
        // Final call turns still need published PCM references. Stop acquisition before detaching those waits.
        const calls=await Promise.allSettled([Promise.resolve().then(()=>call?.closeAll()),Promise.resolve().then(()=>ingress.close()),Promise.resolve().then(()=>pcmIngress?.stop('source_closed'))]);
        closeCapture.abort();for(const resume of archiveCapacity)resume();archiveCapacity.clear();
        const producers=await Promise.allSettled([Promise.resolve().then(()=>camera?.close()),Promise.resolve().then(()=>pcmIngress?.close()),Promise.resolve().then(()=>options.retainAssembly || options.sharedExecution ? undefined : errands?.close()),
          Promise.resolve().then(()=>options.retainAssembly || options.sharedExecution ? undefined : assistantVoice?.close())]);
        await Promise.allSettled([...pendingCallArchive]);
        const consumer=await Promise.allSettled([Promise.resolve().then(()=>options.retainAssembly || options.sharedExecution ? undefined : central.close())]);
        if(admissions.get(options.deviceId)===ownedAdmission)admissions.delete(options.deviceId);
        const settled=[...calls,...producers,...consumer];
        const failures=settled.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
        if(failures.length)throw new AggregateError(failures,'PERSISTENT_PUBLIC_EXECUTION_CLEANUP_FAILED');
      })(),
    });
    return Object.freeze({executionOwner:mode,bridge,assembly,authority,pcmIngress,clock,media,pendingRawKeys:()=>[...retainedIngressKeys],sharedExecution:shared});
  } catch(error) {
    // Everything acquired before the failure is released: the started spool timer included.
    if (!options.sharedExecution){await desktopRelay?.close();await shared.closeResources();await assembly.close();}
    throw error;
  }
}
