import type {ThinkingModeConfiguration} from './voice/contracts.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {RuntimeEventStore,installRuntimeEventStore,emitRuntimeEvent} from './self-events.ts';
import {openModelSettingsEmbedding} from './model-settings-embedding-runtime.ts';
import {localSpeechRuntime} from './model-settings-local-runtime.ts';
import {localSpeakerIdentity,verifyLocalModel,type LocalModelSelection} from './model-settings-local-catalog.ts';
import {PaymentAuthority} from './payment/authority.ts';
import {openModelSettingsResources,type ModelSettingsConfiguration} from './model-settings-resources.ts';
import {OwnerOverride} from './owner-override.ts';
import {deploymentTimeZone} from './deployment-time.ts';
import {parsePaymentConfig} from './payment/config.ts';
import {PAYMENT_MAX_ENROLMENT_CHARS} from './payment/wire-budget.ts';
import {loadRegistryCipher} from './voiceprint/cipher.ts';
import { promises as fs } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, digest } from './contracts.ts';
import { PosixStorage } from './storage.ts';
import { acquireProcessLock } from './process-lock.ts';
import { HermesClient } from './hermes-client.ts';
import type { AdmissionPolicy } from './admission.ts';
import type { FixtureRegisteredDevice } from './runtime.ts';
import { createPersonalAIOSAssembly, type PersonalAIOSAssemblyResources } from './assembly.ts';
import { DashScopeTts } from './tts.ts';
import { loadHostConfiguration } from './host-configuration.ts';
import { openFixtureDatabase } from './memory/fixture-database.ts';
import { ActionAuthority, initializeActionSchema } from './actions/authority.ts';
import { configureMediaReplay, parseMediaReplayConfiguration } from './media/setup.ts';
import { createQwenVoiceResources, DASHSCOPE_DIALECTS, type DashScopeDialect } from './voice/qwen-resources.mjs';
import { createFormalVoiceAuthority } from './voice/formal-authority.ts';
import { configuredScoring, speakerModelIdentity, VoiceprintRegistry, DEFAULT_VOICEPRINT_POLICY, type VoiceprintScoringConfig, type VoiceprintThresholds, type AdaptiveVerifiedPolicy } from './voiceprint/registry.ts';
import { AmbientJournal, parseAmbientPolicy, type AmbientPolicy } from './ambient/journal.ts';
import { HealthStore } from './health/store.ts';
import { ContactsStore } from './contacts/store.ts';
import { CareAuthority } from './care/authority.ts';
import {DeviceLocations} from './location.ts';
import {VisualMemory,type VisualRetention} from './visual/store.ts';
import {DashScopeEmbedding,describeVision,parseEmbeddingConfiguration} from './visual/models.ts';
import {CpuFaceEngine} from './visual/image.ts';
import { join } from 'node:path';
import {openTurnModel,parseCallTurnConfiguration,THINKING_MAX_BYTES,type CallTurnConfiguration} from './voice/turn-model.mjs';
import {verifyModelFile} from './voiceprint/engine.ts';

function validThinkingMode(value:unknown):value is ThinkingModeConfiguration {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const config=value as ThinkingModeConfiguration;
  if(Object.keys(config).sort().join(',')!=='enabled,reader_instructions,status_text'||typeof config.enabled!=='boolean'||
    typeof config.reader_instructions!=='string'||!config.reader_instructions.trim()||config.reader_instructions.length>4000)return false;
  const text=config.status_text;
  return !!text&&typeof text==='object'&&!Array.isArray(text)&&
    Object.keys(text).sort().join(',')==='failed,greeting,interrupted,readout_mismatch,slow,waiting'&&
    Object.values(text).every(value=>typeof value==='string'&&value.trim().length>0&&value.length<=500);
}

export interface CentralProvisionConfiguration {
  time_zone?:string;
  model_settings?:ModelSettingsConfiguration;
  identity?:{owner_override_ttl_s?:number};
  payment?:unknown;
  storage_root: string; lock_file: string; port: number;
  shutdown_drain_ms?:number;
  session_folding?:boolean;
  archive_tiering?:{cold:import('./cold-storage.ts').ColdConfig;hot_days?:number;min_free_bytes?:number;min_free_inodes?:number;max_upload_kbps?:number;paused?:boolean};
  tts?: {provider: 'dashscope'; model: string; voice: string; sample_rate: number; endpoint?: string; instruction?: string; key_file?: string};
  /** Voice reply transport only; the target device is the paired device the execution owner was built for. */
  formal_voice?: {transport: 'wav_byte_stream_v1'};
  /** H-mode Qwen realtime candidate frontend. Workspace WSS endpoint and a 0600 key file; no key value in config. */
  voice_frontend?: {provider: 'dashscope'; model: string; dialect?: DashScopeDialect; transcription_model?: string; region: 'cn-beijing' | 'ap-southeast-1';
    endpoint: string; key_file: string; voice: string; instructions: string;
    /** The live call front's own model and voice (same workspace endpoint and key); absent = the fields above.
     *  `expressive` (default true): 依米 speaks with fitting tone and emotion; false: evenly. */
    call?: {thinking_mode?:ThinkingModeConfiguration; dialect?: DashScopeDialect; transcription_model?: string; model: string; voice: string; expressive?: boolean;
      /** Pickup greeting: `enabled` (default true), `text` (optional seed; consecutive pickups vary). */
      greeting?: {enabled?: boolean; text?: string};ambient_silence_ms?:number;silence_duration_ms?:number;
      /** Omni-family session options: built-in web search for live facts and sampling against verbatim repeats. */
      session_options?:{enable_search?:boolean;temperature?:number;presence_penalty?:number};turn_manager?:CallTurnConfiguration}};
  model_route?: {provider: string; model: string; base_url: string};
  hermes_base_url: string; hermes_key_file: string; internal_key_file: string; skill_file: string;
  native_request_timeout_ms: number; http_request_timeout_ms: number; max_request_bytes: number;
  max_event_bytes: number; max_read_bytes: number; admission: AdmissionPolicy;
  core_profile?: {enabled:true; profile_home:string; native_profile_home?:string};
  /** Host voiceprint registry (owner + other-person profiles, `<storage_root>/voiceprints`). */
  voiceprint?: {speaker_model: {file: string; dim: number}; thresholds?: Partial<VoiceprintThresholds>; adaptive_verified?: Partial<AdaptiveVerifiedPolicy>; max_clusters?: number;
    scoring?: VoiceprintScoringConfig; trust_window_ms?: number;
    confirmation_ttl_ms?: number; encryption_key_file?:string; enrolment_sentences?:string[]};
  /** Ambient lane policy (conversation gap, wake follow window, context window); the journal is `<storage_root>/ambient-journal`. */
  ambient?: Partial<AmbientPolicy>;
  visual?: Partial<VisualRetention>&{embedding?: unknown; faces?:ConstructorParameters<typeof CpuFaceEngine>[0]};
}
// True means required. Exhaustive typing keeps accepted fields and optionality tied to the provisioner's contract.
export const CENTRAL_PROVISION_CONFIGURATION_FIELDS = Object.freeze({
  time_zone:false, storage_root:true, lock_file:true, port:true, hermes_base_url:true, hermes_key_file:true, internal_key_file:true, skill_file:true,
  native_request_timeout_ms:true, http_request_timeout_ms:true, max_request_bytes:true, max_event_bytes:true, max_read_bytes:true,
  admission:true, model_route:false, tts:false, formal_voice:false, voice_frontend:false, core_profile:false,
  voiceprint:false, ambient:false, visual:false, archive_tiering:false, shutdown_drain_ms:false, session_folding:false, payment:false, identity:false,model_settings:false,
} satisfies {[K in keyof CentralProvisionConfiguration]-?: {} extends Pick<CentralProvisionConfiguration,K> ? false : true});
export type CentralProvisionResources = Omit<PersonalAIOSAssemblyResources, 'devices' | 'sourceAuthority' | 'media' | 'output'> & {self_events?:RuntimeEventStore;tts?: DashScopeTts; formal_voice?: CentralProvisionConfiguration['formal_voice'];local_models?:ReturnType<typeof localSpeechRuntime>};
interface Configuration extends CentralProvisionConfiguration {
  mode: 'isolated_fixture' | 'isolated_provider'; devices: FixtureRegisteredDevice[];
  fixture_database?: {url: string; schema: string; migration_file: string};
  local_note_actions?: {local_notes_root: string};
  media_replay?: unknown;
}
async function key(path: string): Promise<string> {
  const stat = await fs.lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'UNSAFE_KEY_FILE');
  const value = (await fs.readFile(path, 'utf-8')).trim(); check(value.length >= 24, 'INVALID_KEY'); return value;
}

// One inherited budget: stop waiting with 15 s left for durable release. Actual work may still run.
const shutdownContext=new AsyncLocalStorage<{signal:AbortSignal;deadline:number;pending:Set<Promise<void>>}>();
export const DEFAULT_SHUTDOWN_DRAIN_MS=105000;
export function shutdownSignal(){return shutdownContext.getStore()?.signal;}
export async function withShutdownDrain<T>(action:()=>Promise<T>,ms=DEFAULT_SHUTDOWN_DRAIN_MS):Promise<T>{
  if(shutdownContext.getStore())return action();
  check(Number.isSafeInteger(ms)&&ms>15000&&ms<=DEFAULT_SHUTDOWN_DRAIN_MS,'SHUTDOWN_DRAIN_INVALID');
  const controller=new AbortController(),deadline=Date.now()+ms;
  const timer=setTimeout(()=>controller.abort(new Error('SHUTDOWN_DRAIN_EXPIRED')),ms-15000);
  try{return await shutdownContext.run({signal:controller.signal,deadline,pending:new Set()},action);}finally{clearTimeout(timer);}
}
export async function joinShutdown(action:()=>void|Promise<void>,release=false):Promise<void>{
  const context=shutdownContext.getStore();
  if(!context)return withShutdownDrain(()=>joinShutdown(action,release));
  const work=Promise.resolve().then(action);
  context.pending.add(work);
  // Keep nested work visible even after an outer close rejects on the shared deadline.
  void work.then(()=>context.pending.delete(work),()=>context.pending.delete(work));
  let timer:NodeJS.Timeout|undefined,abort:(()=>void)|undefined;
  try{await Promise.race([work,new Promise<never>((_,reject)=>{
    if(release)timer=setTimeout(()=>reject(new Error('SHUTDOWN_RELEASE_EXPIRED')),Math.max(0,context.deadline-Date.now()));
    else{abort=()=>reject(context.signal.reason);if(context.signal.aborted)abort();else context.signal.addEventListener('abort',abort,{once:true});}
  })]);}finally{clearTimeout(timer);if(abort)context.signal.removeEventListener('abort',abort);}
}
// Preserve assembly/database/release order while still invoking each owner after a failed join.
export function createMainStop(assembly: {close(): Promise<void>} | undefined, database: {close(): Promise<void>} | undefined,
  release: () => Promise<void>,shutdownDrainMs=DEFAULT_SHUTDOWN_DRAIN_MS): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => stopping ??= withShutdownDrain(async () => {
    const errors: unknown[] = [];
    for (const owner of [assembly,database]) {
      if(!owner)continue;
      try { await joinShutdown(()=>owner.close()); } catch (error) { errors.push(error); }
    }
    // A timeout only ends the join. Retain exclusive ownership until process exit
    // if any old owner can still mutate; never schedule a detached late release.
    if(shutdownContext.getStore()!.pending.size)errors.push(new Error('SHUTDOWN_OWNERS_UNSETTLED'));
    else try{await joinShutdown(release,true);}catch(error){errors.push(error);}
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'MAIN_SHUTDOWN_FAILED');
  },shutdownDrainMs);
}

// Central resources are provisioned once; the calling source owner creates its own one assembly.
// Native construction remains lazy so isolated media startup keeps its existing ownership order.
const validModel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const validDialect = (value: unknown) => value === undefined || typeof value === 'string' && Object.hasOwn(DASHSCOPE_DIALECTS, value);
const validSessionOptions = (options: unknown) => options !== null && typeof options === 'object' && !Array.isArray(options) &&
  Object.entries(options).every(([key, value]) => key === 'enable_search' ? typeof value === 'boolean' :
    key === 'temperature' ? typeof value === 'number' && value >= 0 && value < 2 :
    key === 'presence_penalty' ? typeof value === 'number' && value >= -2 && value <= 2 : false);
export async function provisionCentralResources(config: CentralProvisionConfiguration) {
  const time_zone=deploymentTimeZone(config.time_zone);
  check(config.identity===undefined||config.identity!==null&&typeof config.identity==='object'&&!Array.isArray(config.identity)&&
    Object.keys(config.identity).every(key=>key==='owner_override_ttl_s')&&
    (config.identity.owner_override_ttl_s===undefined||Number.isSafeInteger(config.identity.owner_override_ttl_s)&&config.identity.owner_override_ttl_s>=0),
    'OWNER_OVERRIDE_CONFIGURATION_INVALID');
  check(config.shutdown_drain_ms===undefined||Number.isSafeInteger(config.shutdown_drain_ms)&&config.shutdown_drain_ms>15000&&config.shutdown_drain_ms<=DEFAULT_SHUTDOWN_DRAIN_MS,'SHUTDOWN_DRAIN_INVALID');
  check(config.session_folding===undefined||typeof config.session_folding==='boolean','INVALID_SESSION_FOLDING');
  const settings=config.archive_tiering;
  check(settings===undefined||settings!==null&&typeof settings==='object'&&Object.keys(settings).every(k=>['cold','hot_days','min_free_bytes','min_free_inodes','max_upload_kbps','paused'].includes(k))&&
    settings.cold!==null&&typeof settings.cold==='object'&&Object.keys(settings.cold).sort().join(',')==='password_file,url,username'&&
    typeof settings.cold.url==='string'&&typeof settings.cold.username==='string'&&settings.cold.username.length>0&&
    typeof settings.cold.password_file==='string'&&isAbsolute(settings.cold.password_file)&&
    Number.isSafeInteger(settings.hot_days??2)&&(settings.hot_days??2)>=1&&Number.isSafeInteger(settings.min_free_bytes??1073741824)&&
    (settings.min_free_bytes??1073741824)>0&&Number.isSafeInteger(settings.min_free_inodes??10000)&&
    (settings.min_free_inodes??10000)>0&&(settings.max_upload_kbps===undefined||Number.isSafeInteger(settings.max_upload_kbps)&&
    settings.max_upload_kbps>0)&&(settings.paused===undefined||typeof settings.paused==='boolean'),'INVALID_ARCHIVE_TIERING');
  const tier=settings?{cold:settings.cold,hot_days:settings.hot_days??2,min_free_bytes:settings.min_free_bytes??1073741824,min_free_inodes:settings.min_free_inodes??10000,max_upload_kbps:settings.max_upload_kbps??2000,paused:settings.paused??false}:undefined;
  check(Number.isSafeInteger(config.port) && config.port > 1024 && config.port < 65536, 'INVALID_SERVICE_PORT');
  check(config.formal_voice === undefined || config.formal_voice !== null && typeof config.formal_voice === 'object' &&
    !Array.isArray(config.formal_voice) && config.tts && config.formal_voice.transport === 'wav_byte_stream_v1' &&
    Object.keys(config.formal_voice).join(',') === 'transport', 'FORMAL_VOICE_CONFIGURATION_INVALID');
  check(config.tts === undefined || config.tts !== null && typeof config.tts === 'object' &&
    Object.keys(config.tts).every(key => ['provider', 'model', 'voice', 'sample_rate', 'endpoint', 'instruction', 'key_file'].includes(key)) &&
    (config.tts.key_file === undefined || typeof config.tts.key_file === 'string' && isAbsolute(config.tts.key_file)) &&
    validModel(config.tts.model) && validModel(config.tts.voice) &&
    Number.isSafeInteger(config.tts.sample_rate) && config.tts.sample_rate > 0 &&
    (config.tts.instruction === undefined || typeof config.tts.instruction === 'string' &&
      config.tts.instruction.trim().length > 0 && config.tts.instruction.length <= 500) &&
    (config.tts.endpoint === undefined || URL.canParse(config.tts.endpoint) && new URL(config.tts.endpoint).protocol === 'wss:') &&
    config.tts.provider === 'dashscope', 'TTS_PROVIDER_NOT_CONFIGURED');
  const voice = config.voice_frontend;
  check(voice === undefined || voice !== null && typeof voice === 'object' && !Array.isArray(voice) &&
    Object.keys(voice).filter(key => !['call', 'dialect', 'transcription_model'].includes(key)).sort().join(',') === 'endpoint,instructions,key_file,model,provider,region,voice' &&
    (voice.call === undefined || voice.call !== null && typeof voice.call === 'object' && !Array.isArray(voice.call) &&
      Object.keys(voice.call).filter(key => !['dialect', 'transcription_model', 'expressive', 'greeting', 'ambient_silence_ms', 'silence_duration_ms', 'session_options','turn_manager','thinking_mode'].includes(key)).sort().join(',') === 'model,voice' && validModel(voice.call.model) && validDialect(voice.call.dialect) &&
      (voice.call.transcription_model === undefined || validModel(voice.call.transcription_model)) &&
      typeof voice.call.voice === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(voice.call.voice) &&
      (voice.call.thinking_mode === undefined || validThinkingMode(voice.call.thinking_mode)) &&
      (voice.call.expressive === undefined || typeof voice.call.expressive === 'boolean') &&
      (voice.call.silence_duration_ms === undefined || Number.isSafeInteger(voice.call.silence_duration_ms) && voice.call.silence_duration_ms >= 200 && voice.call.silence_duration_ms <= 6000) &&
      (voice.call.session_options === undefined || validSessionOptions(voice.call.session_options)) &&
      (voice.call.ambient_silence_ms === undefined || Number.isSafeInteger(voice.call.ambient_silence_ms) && voice.call.ambient_silence_ms >= 5000 && voice.call.ambient_silence_ms <= 120000) &&
      (voice.call.greeting === undefined || voice.call.greeting !== null && typeof voice.call.greeting === 'object' &&
        Object.keys(voice.call.greeting).every(key => ['enabled', 'text'].includes(key)) &&
        (voice.call.greeting.enabled === undefined || typeof voice.call.greeting.enabled === 'boolean') &&
        (voice.call.greeting.text === undefined || typeof voice.call.greeting.text === 'string' && voice.call.greeting.text.length <= 80))) &&
    voice.provider === 'dashscope' && validModel(voice.model) && validDialect(voice.dialect) &&
    (voice.transcription_model === undefined || validModel(voice.transcription_model)) &&
    ['cn-beijing', 'ap-southeast-1'].includes(voice.region) && typeof voice.endpoint === 'string' &&
    URL.canParse(voice.endpoint) && new URL(voice.endpoint).protocol === 'wss:' &&
    typeof voice.key_file === 'string' && voice.key_file.startsWith('/') &&
    [voice.voice, voice.instructions].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000),
    'VOICE_FRONTEND_CONFIGURATION_INVALID');
  const turnConfig=voice?.call?.turn_manager===undefined?undefined:parseCallTurnConfiguration(voice.call.turn_manager,voice.call.model,voice.call.voice);
  check(!config.tts || voice, 'TTS_VOICE_FRONTEND_REQUIRED');
  const memory = config.core_profile;
  check(memory === undefined || memory !== null && typeof memory === 'object' && !Array.isArray(memory) &&
    Object.keys(memory).every(key => ['enabled','profile_home','native_profile_home'].includes(key)) && memory.enabled === true &&
    [memory.profile_home, memory.native_profile_home ?? memory.profile_home].every(home =>
      typeof home === 'string' && isAbsolute(home) && normalize(home) === home),
    'CORE_PROFILE_CONFIG_INVALID');
  if (memory) check(await fs.realpath(memory.profile_home).then(real => real === memory.profile_home, () => false) &&
    (await fs.stat(memory.profile_home)).isDirectory(), 'CORE_PROFILE_HOME_UNRESOLVED');
  let print = config.voiceprint;
  check(print === undefined || print !== null && typeof print === 'object' && !Array.isArray(print) &&
    Object.keys(print).every(key => ['speaker_model', 'thresholds', 'adaptive_verified', 'max_clusters', 'confirmation_ttl_ms','encryption_key_file','enrolment_sentences','scoring','trust_window_ms'].includes(key)) &&
    print.speaker_model && Object.keys(print.speaker_model).sort().join(',') === 'dim,file' && typeof print.speaker_model.file === 'string' &&
    isAbsolute(print.speaker_model.file) && Number.isSafeInteger(print.speaker_model.dim) &&
    (print.thresholds === undefined || print.thresholds !== null && typeof print.thresholds === 'object' &&
      Object.keys(print.thresholds).every(key => ['owner_verified', 'owner_uncertain', 'cluster', 'enroll_consistency', 'assistant','call_anchor','trusted_centroid','enroll_match'].includes(key))) &&
    (print.adaptive_verified === undefined || print.adaptive_verified !== null && typeof print.adaptive_verified === 'object' &&
      !Array.isArray(print.adaptive_verified)),
    'VOICEPRINT_CONFIGURATION_INVALID');
  check(print?.trust_window_ms===undefined||Number.isSafeInteger(print.trust_window_ms)&&print.trust_window_ms>0,'VOICEPRINT_CONFIGURATION_INVALID');
  check(print?.encryption_key_file===undefined||typeof print.encryption_key_file==='string'&&isAbsolute(print.encryption_key_file),'VOICEPRINT_CONFIGURATION_INVALID');
  check(print?.enrolment_sentences===undefined||Array.isArray(print.enrolment_sentences)&&print.enrolment_sentences.length===8&&print.enrolment_sentences.every(s=>typeof s==='string'&&s.trim().length>0&&Array.from(s).length<=PAYMENT_MAX_ENROLMENT_CHARS),'VOICEPRINT_CONFIGURATION_INVALID');
  const paymentConfig=parsePaymentConfig(config.payment);
  check(!print||print.encryption_key_file,'PAYMENT_VOICEPRINT_ENCRYPTION_REQUIRED',503);
  const paymentKey=paymentConfig.executor_key_file?await key(paymentConfig.executor_key_file):undefined;
  check(paymentKey===undefined||paymentKey.length>=32,'PAYMENT_EXECUTOR_KEY_INVALID');
  const ambientPolicy = parseAmbientPolicy(config.ambient ?? {});
  const [nativeKey, internalKey, skill, voiceKey, ttsKey] = await Promise.all([key(config.hermes_key_file), key(config.internal_key_file),
    fs.readFile(config.skill_file, 'utf-8'), voice ? key(voice.key_file) : undefined,
    config.tts?.key_file ? key(config.tts.key_file) : undefined]);
  check(skill.trim().length > 0, 'FIXED_SKILL_EMPTY', 500);
  let speakerModel:Awaited<ReturnType<typeof speakerModelIdentity>>|undefined;let speakerSelection:LocalModelSelection|undefined;
  const lock = await acquireProcessLock(config.lock_file);
  let tts: DashScopeTts | undefined, voiceprint: VoiceprintRegistry | undefined, journal: AmbientJournal | undefined, health: HealthStore | undefined, contacts: ContactsStore | undefined,
    care: CareAuthority | undefined,payment:PaymentAuthority|undefined,visual:VisualMemory|undefined,locations:DeviceLocations|undefined,ownerOverride:OwnerOverride|undefined;
  let turnModel:Awaited<ReturnType<typeof openTurnModel>>|undefined;
  let disk:PosixStorage|undefined,selfEvents:RuntimeEventStore|undefined,detachSelf:(()=>void)|undefined;
  let modelSettings:ReturnType<typeof openModelSettingsResources>|undefined;
  let embeddingRuntime:Awaited<ReturnType<typeof openModelSettingsEmbedding>>|undefined;
  // The provisioning owner's release flushes write-behind voiceprint state and closes the journal before the lock goes.
  const release = async () => {
    const settled = await Promise.allSettled([Promise.resolve().then(async()=>{await embeddingRuntime?.close();await visual?.close();}),Promise.resolve().then(()=>turnModel?.close())]);
    settled.push(...await Promise.allSettled([tts, voiceprint, journal, health, contacts, care,locations,payment,ownerOverride].map(owner => Promise.resolve().then(() => owner?.close()))));
    try{await disk?.close();}catch(reason){settled.push({status:'rejected',reason});}
    detachSelf?.();
    await modelSettings?.close();
    try {await selfEvents?.close();} catch(reason) {settled.push({status:'rejected',reason});}
    try {await lock();} catch (reason) {settled.push({status: 'rejected', reason});}
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'CENTRAL_RELEASE_FAILED');
  };
  try {
    const storage = disk = new PosixStorage(config.storage_root,tier?{cold:tier.cold,min_free_bytes:tier.min_free_bytes,min_free_inodes:tier.min_free_inodes}:{});
    await storage.recoverPending();
    selfEvents=new RuntimeEventStore({directory:join(storage.root,'runtime-events'),onError:error=>emitRuntimeEvent({central_text_failed:'RUNTIME_EVENT_STORE_FAILED',code:(error as NodeJS.ErrnoException).code,at:Date.now()})});
    await selfEvents.flush();detachSelf=installRuntimeEventStore(selfEvents);
    ownerOverride=new OwnerOverride({storage,...(process.env.PAIOS_SECRET_ROOT?{secret_root:process.env.PAIOS_SECRET_ROOT}:{}),
      ...(config.identity?.owner_override_ttl_s===undefined?{}:{ttl_s:config.identity.owner_override_ttl_s})});
    await ownerOverride.status();
    journal = AmbientJournal.open(join(storage.root, 'ambient-journal'), ambientPolicy);
    health = HealthStore.open(join(storage.root, 'health'));
    contacts = ContactsStore.open(join(storage.root, 'contacts'));
    care = CareAuthority.open(join(storage.root, 'care'),Date.now,time_zone);
    locations=DeviceLocations.open(join(storage.root,'location'));
    payment=PaymentAuthority.open(join(storage.root,'payment'),{config:paymentConfig,time_zone,owner_override_active:()=>ownerOverride!.active()});
    const modelServiceKey=config.model_settings?await key(config.model_settings.service_key_file):undefined;
    check(modelServiceKey===undefined||modelServiceKey!==internalKey&&modelServiceKey!==nativeKey,'MODEL_SETTINGS_SERVICE_KEY_NOT_SEPARATE');
    if(config.model_settings&&modelServiceKey)modelSettings=openModelSettingsResources(storage.root,config.model_settings,config.hermes_base_url,modelServiceKey);
    if(print&&(!modelSettings||!modelSettings.authority.localState('voiceprint')))
      speakerModel=await speakerModelIdentity(print.speaker_model.file,print.speaker_model.dim);
    if(print&&modelSettings){
      if(speakerModel)modelSettings.authority.registerLocalBaseline({id:'startup-voiceprint',display_name:'启动配置声纹',kind:'voiceprint',
        config:{model:{path:print.speaker_model.file,sha256:speakerModel.sha256},dim:speakerModel.dim,
          ...(print.thresholds?{thresholds:print.thresholds}:{}),...(print.scoring?{scoring:print.scoring}:{})}});
      speakerSelection=modelSettings.authority.localSelection('voiceprint');
      if(speakerSelection){check(speakerSelection.entry.kind==='voiceprint','LOCAL_SPEAKER_KIND_MISMATCH');
        const selected=speakerSelection.entry;await verifyLocalModel(selected);speakerModel=localSpeakerIdentity(selected);
        const {thresholds:_oldThresholds,scoring:_oldScoring,...speakerConfiguration}=print;
        print={...speakerConfiguration,speaker_model:{file:selected.config.model.path,dim:selected.config.dim},
          ...(selected.config.thresholds?{thresholds:selected.config.thresholds}:{}),
          ...(selected.config.scoring?{scoring:selected.config.scoring}:{})};}
    }
    if(print&&speakerModel){
      const registryOptions={policy:{...(print.trust_window_ms!==undefined?{trust_window_ms:print.trust_window_ms}:{}),...(print.thresholds?{thresholds:print.thresholds}:{}),...(print.adaptive_verified?{adaptive_verified:print.adaptive_verified}:{}),...(print.max_clusters!==undefined?{max_clusters:print.max_clusters}:{})}};
      const priorVoiceprint=modelSettings?.authority.localState('voiceprint');
      const priorModelThresholds=[priorVoiceprint?.effective,priorVoiceprint?.previous].flatMap(selection=>
        selection?.entry.kind==='voiceprint'?[{speaker_model:localSpeakerIdentity(selection.entry),
          owner_verified:selection.entry.config.thresholds?.owner_verified??DEFAULT_VOICEPRINT_POLICY.thresholds.owner_verified}]:[]);
      voiceprint=new VoiceprintRegistry(storage,speakerModel,{...registryOptions,scoring:configuredScoring(print.scoring,speakerModel),
        prior_model_thresholds:priorModelThresholds,
        ...(speakerSelection&&speakerSelection.generation>0?{enrollment_generation:speakerSelection.generation,
          verification:{speaker_model:speakerModel,channels:speakerSelection.entry.kind==='voiceprint'?speakerSelection.entry.config.verified_channels??{}:{}}}:{}),
        owner_override_active:()=>ownerOverride!.active(),
        ...(print.encryption_key_file?{cipher:await loadRegistryCipher(print.encryption_key_file)}:{})});
      // Persist legacy threshold provenance before settings can retire effective/previous pins.
      if(modelSettings)await voiceprint.owner();
    }
    tts = config.tts && voice && voiceKey ? new DashScopeTts({usable: true, ...voice, apiKey: ttsKey ?? voiceKey}, {model: config.tts.model, voice: config.tts.voice,
      sample_rate: config.tts.sample_rate, ...(config.tts.endpoint ? {endpoint: config.tts.endpoint} : {}),
      ...(config.tts.instruction ? {instruction: config.tts.instruction} : {})}) : undefined;
    let native: HermesClient | undefined;
    const nativeClient=()=>native??=new HermesClient(config.hermes_base_url,nativeKey,config.native_request_timeout_ms,config.max_read_bytes,memory?.native_profile_home??memory?.profile_home);
    let callTurns:Parameters<typeof createQwenVoiceResources>[0]['callTurns'];
    if(turnConfig?.enabled){
      turnModel=await openTurnModel(turnConfig.model);await verifyModelFile(turnConfig.thinking_sound);
      const bytes=await fs.readFile(turnConfig.thinking_sound.path);
      check(bytes.length>0&&bytes.length%2===0&&bytes.length<=THINKING_MAX_BYTES,'CALL_THINKING_SOUND_INVALID');
      const thinking=Int16Array.from({length:bytes.length/2},(_,i)=>bytes.readInt16LE(i*2));
      callTurns={config:turnConfig,score:(samples,signal)=>turnModel!.score(samples,signal),thinking};
    }
    if(config.visual){
      check(!Object.hasOwn(config.visual,'archive'),'VISUAL_ARCHIVE_REPLACED_BY_ARCHIVE_TIERING');
      check(voice&&voiceKey,'VISUAL_DASHSCOPE_REQUIRED');
      check(!config.visual.faces||voiceprint,'VISUAL_PERSON_REGISTRY_REQUIRED');
      const {faces,embedding:embeddingConfig,...retention}=config.visual;
      const embeddingConfiguration={...parseEmbeddingConfiguration(embeddingConfig,{endpoint:voice.endpoint}),region:voice.region,apiKey:voiceKey};
      const visualDirectory=join(storage.root,'visual-memory');
      embeddingRuntime=modelSettings?await openModelSettingsEmbedding(modelSettings.authority,visualDirectory,embeddingConfiguration):undefined;
      const embedding=embeddingRuntime?.provider??new DashScopeEmbedding(embeddingConfiguration);
      visual=await VisualMemory.open(visualDirectory,{...(embeddingRuntime?embeddingRuntime.provider:{}),embedImage:(bytes,signal)=>embedding.embedImage(bytes,signal),
        embedQuery:text=>embedding.embedQuery(text),describe:(bytes,signal,context)=>describeVision((bytes,prompt,signal)=>nativeClient().analyzeVision(bytes,prompt,signal,context),bytes,signal)},
        retention,voiceprint,faces?new CpuFaceEngine(faces):undefined,storage.cold);
      embeddingRuntime?.attach(visual);
    }
    const resources: CentralProvisionResources = {
      time_zone,storage,self_events:selfEvents,owner_override:ownerOverride,session_folding:config.session_folding??true, get native() {return nativeClient();},
      ...(tier?{archive_tiering:{hot_days:tier.hot_days,max_upload_kbps:tier.max_upload_kbps,paused:tier.paused}}:{}),
      ...(visual?{visual_memory:visual}:{}),
      // The native identity stays bound to Hermes; the generated view is writable only by the platform.
      ...(memory ? {core_profile: Object.freeze({enabled: true as const, profile_home: memory.profile_home,
        source_profile_home: memory.native_profile_home ?? memory.profile_home})} : {}),
      payment,payment_ports:{enrolment_sentences:print?.enrolment_sentences??[
        '依米，明天早上八点提醒我开会。','今天中午我想吃一碗牛肉面，不要香菜。','帮我看看周末的天气，适不适合去爬山。',
        '我刚才和老王聊的那个项目，下周一要交方案。','给我妈发个消息，说我晚上七点到家。','最近睡眠不太好，晚上总是醒好几次。',
        '这家咖啡店的拿铁比上次那家好喝多了。','依米，把刚才那段对话总结一下。']},
      ...(modelSettings?{local_models:localSpeechRuntime(modelSettings.authority,speakerSelection),
        voice_model_current:()=>speakerSelection!==undefined&&modelSettings!.authority.localModelCurrent('voiceprint',speakerSelection.generation)}:{}),
      ...(voiceprint ? {voiceprint} : {}), ambient_journal: journal, health, contacts, care,locations,
      ...(print?.confirmation_ttl_ms !== undefined ? {voice_confirmation: {ttl_ms: print.confirmation_ttl_ms}} : {}),
      ...(tts ? {tts} : {}),
      ...(config.formal_voice ? {formal_voice:{...config.formal_voice}} : {}),
      ...(voice && voiceKey ? {voice: createQwenVoiceResources({
        ...(callTurns?{callTurns}:{}),classifyCall:(text,signal,context)=>nativeClient().classifyCall(text,signal,context),searchCall:(query,signal)=>nativeClient().searchCall(query,signal),
        configuration: {usable: true, provider: voice.provider, model: voice.model, ...(voice.dialect ? {dialect: voice.dialect} : {}), ...(voice.transcription_model ? {transcription_model: voice.transcription_model} : {}), region: voice.region,
          endpoint: voice.endpoint, voice: voice.voice, instructions: voice.instructions, apiKey: voiceKey,
          ...(voice.call ? {call: {model: voice.call.model, voice: voice.call.voice, ...(voice.call.dialect ? {dialect: voice.call.dialect} : {}), ...(voice.call.transcription_model ? {transcription_model: voice.call.transcription_model} : {}),
            ...(voice.call.thinking_mode ? {thinking_mode:voice.call.thinking_mode} : {}),
            ...(voice.call.expressive !== undefined ? {expressive: voice.call.expressive} : {}),
            ...(voice.call.silence_duration_ms !== undefined ? {silence_duration_ms: voice.call.silence_duration_ms} : {}),
            ...(voice.call.session_options !== undefined ? {session_options: voice.call.session_options} : {}),
            ...(turnConfig?{turn_manager:turnConfig}:{}),
            ...(voice.call.greeting ? {greeting: voice.call.greeting} : {}),
            ...(voice.call.ambient_silence_ms!==undefined?{ambient_silence_ms:voice.call.ambient_silence_ms}:{})}} : {})},
        ...createFormalVoiceAuthority(storage),
        onError: error => console.error('VOICE_FRONTEND_FAILED', error instanceof Error ? error.message : 'unknown')})} : {}),
      admission: config.admission, skill, max_event_bytes: config.max_event_bytes, max_read_bytes: config.max_read_bytes,
      ...(modelSettings?{model_settings:modelSettings}:{}),
      http: {internal_token: internalKey,...(paymentKey?{payment_key:paymentKey}:{}),...(modelServiceKey?{model_settings_key:modelServiceKey}:{}), max_request_bytes: config.max_request_bytes,
        resource_snapshot:()=>({turn:turnModel?.snapshot()??null,visual:visual?.resourceSnapshot()??null}),
        request_timeout_ms: config.http_request_timeout_ms, ...(config.model_route ? {model_route: config.model_route} : {})},
    };
    return Object.freeze({resources, get native() {return resources.native as HermesClient;},
      port: config.port, release, skill_sha256: digest(skill)});
  } catch (error) {
    try {await release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'CENTRAL_PROVISION_FAILED', {cause: error});}
    throw error;
  }
}

const startupDependencies = {configureMediaReplay, openFixtureDatabase, initializeActionSchema, createPersonalAIOSAssembly};
export async function main(dependencies = startupDependencies): Promise<void> {
  const argument = process.argv.indexOf('--config');
  check(argument >= 0 && process.argv[argument + 1], 'USAGE_MAIN_CONFIG_REQUIRED');
  const config = await loadHostConfiguration(process.argv[argument + 1]!) as Configuration;
  check(['isolated_fixture', 'isolated_provider'].includes(config.mode), 'ISOLATED_RUNTIME_REQUIRED');
  check(config.mode !== 'isolated_provider' || config.model_route &&
    ['provider', 'model', 'base_url'].every(field => typeof config.model_route?.[field as keyof typeof config.model_route] === 'string'),
    'MODEL_ROUTE_REQUIRED');
  const mediaConfig = config.media_replay === undefined ? undefined : parseMediaReplayConfiguration(config.media_replay);
  const provision = await provisionCentralResources(config);
  const {release} = provision;
  let media: Awaited<ReturnType<typeof configureMediaReplay>> | undefined;
  let database: Awaited<ReturnType<typeof openFixtureDatabase>> | undefined;
  let assembly: ReturnType<typeof createPersonalAIOSAssembly> | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    const {storage, skill} = provision.resources;
    media = mediaConfig ? await dependencies.configureMediaReplay(storage, mediaConfig, config.max_event_bytes,fetch,undefined,undefined,provision.resources.local_models) : undefined;
    const native = provision.resources.native;
    database = config.fixture_database ? await dependencies.openFixtureDatabase(config.fixture_database) : undefined;
    check(!config.local_note_actions || database, 'ACTION_DATABASE_REQUIRED');
    if (config.local_note_actions && database) await dependencies.initializeActionSchema(database.pool);
    const actions = config.local_note_actions && database ? new ActionAuthority(database.pool, config.local_note_actions) : undefined;
    const {tts, formal_voice: _formalVoice, ...central} = provision.resources;
    assembly = dependencies.createPersonalAIOSAssembly({...central, native,
      devices:config.devices, ...(media ? {archive:media.archive, media:media.service,
        ...(media.speech?{speech:media.speech,speech_detector:media.detector}:{})} : {}),
      ...(tts ? {output:{tts}} : {}),
      ...(database ? {l3:database.l3} : {}), ...(actions ? {actions} : {})});
    const {server} = assembly;
    stop = createMainStop(assembly, database, release,config.shutdown_drain_ms);
    const close = stop;
    server.on('error', async error => {
      console.error(error.message); process.exitCode = 1;
      await close().catch(error => {console.error('Runtime shutdown failed:', error);});
    });
    server.listen(config.port, '127.0.0.1', () => console.log(JSON.stringify({service: 'personal-aios-integration',
      address: `http://127.0.0.1:${config.port}`, mode: config.mode, skill_sha256: digest(skill),
      native_loop_owner: 'Hermes', reply_phase: 'final_buffer'})));
    const signalStop = () => {void close().catch(error => {console.error('Runtime shutdown failed:', error); process.exitCode = 1;});};
    process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
  } catch (error) {
    stop ??= createMainStop(assembly ?? media?.service, database, release,config.shutdown_drain_ms);
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'MAIN_STARTUP_FAILED', {cause: error}); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
