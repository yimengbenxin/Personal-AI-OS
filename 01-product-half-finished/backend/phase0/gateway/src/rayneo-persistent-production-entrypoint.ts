import {createAppearanceImages} from './avatar-appearance-images.ts';
import {readAppearancePricing} from './avatar-appearance-wire.ts';
import {emitRuntimeEvent} from '../../../services/personal-aios-integration/src/self-events.ts';
import {createAvatarProfileService,assertAvatarLook,type AvatarLook} from './avatar-profile.ts';
import {createViduAvatarAssets} from './vidu-avatar-assets.ts';
import { publicApiOrigins } from './public-api-origins.ts';
import { assertCanonicalLiveKitApiUrl } from './livekit-cloud-token-signer.ts';
import { PRODUCT_RESOURCE_KEYS, PRODUCT_RESOURCE_OPTIONAL_KEYS } from './product-resource-keys.ts';
import { L3Service, isL3Namespace } from '../../../services/personal-aios-integration/src/memory/l3.ts';
import {canonical,check,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {CENTRAL_PROVISION_CONFIGURATION_FIELDS, provisionCentralResources, createMainStop, withShutdownDrain, joinShutdown, type CentralProvisionConfiguration} from '../../../services/personal-aios-integration/src/main.ts';
import type { createPersonalAIOSAssembly } from '../../../services/personal-aios-integration/src/assembly.ts';
import { createPersistentPublicExecutionHost, createPersistentPublicExecutionOwner, type PersistentPublicExecutionSelection } from './persistent-public-execution-owner.ts';
import {assertVideoCallConfiguration,type VideoCallConfiguration,type ViduRetrieval} from './vidu-call-session.ts';
import {createViduLiveJournal} from './vidu-live-journal.ts';
import { createBarkNotifier } from './bark-notifier.ts';
import { createStagingEffectSink } from './staging-effect-sink.ts';
import { createAmapNavigation } from './amap-navigation.ts';
import { createReceiptClockProvider } from './source-media-receipt-clock.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function reportPersistentExecutionError(error:unknown){
  const report=error as {code?:unknown;continuous_pcm_admission?:unknown;stream_key?:unknown;cause?:unknown;errors?:unknown[]};
  const safeCode=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(value)?value:undefined;
  // Messages are private text unless they are a bare code; code-less errors print the throwing frames instead.
  const code=safeCode(report?.code)??safeCode(error instanceof Error?error.message:undefined)??(error instanceof Error?error.name:'unknown');
  const admission=['rejected','recovered'].includes(String(report?.continuous_pcm_admission)),causeCodes=new Set<string>();
  const causes=[...(report?.errors??(report?.cause===undefined?[]:[report.cause]))];
  for(let n=0;n<Math.min(causes.length,8);n++){
    const cause=causes[n] as {code?:unknown;cause?:unknown;errors?:unknown[]}|undefined;
    const causeCode=safeCode(cause?.code)??safeCode(cause instanceof Error?cause.message:undefined);
    if(causeCode&&causeCode!==code&&causeCode!=='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN')causeCodes.add(causeCode);
    if(cause?.cause)causes.push(cause.cause);
    if(Array.isArray(cause?.errors))causes.push(...cause.errors.slice(0,8));
  }
  const frames=code===(error instanceof Error?error.name:'unknown')&&error instanceof Error?String(error.stack).split('\n')
    .filter(line=>/^\s+at /.test(line)).slice(0,3).map(line=>line.trim().slice(3).replace(/(?:file:\/\/)?\/[^\s()]*?\/(?=01-product-half-finished\/|node_modules\/)/g,'')
      .replace(/[^\w.$<>/:() -]/g,'').slice(0,160)):[];
  emitRuntimeEvent({...admission?{continuous_pcm_admission:report.continuous_pcm_admission,code,
    ...(typeof report.stream_key==='string'&&/^[a-f0-9]{64}$/.test(report.stream_key)?{stream_key:report.stream_key}:{})}:{central_text_failed:code,...(frames.length?{frames}:{})},
    ...(causeCodes.size?{cause_codes:[...causeCodes]}:{})});
}

import {
  createSourceMediaAuthority,
  type SourceMediaAuthorityPort,
} from '../../../services/connector-runtime/src/index.ts';
import {
  createProductionMemoryReady,
  type ProductionFinalTranscriptEvidenceCommitProjection,
  type ProductionMemoryReady,
  type ProductionMemoryReadyBinding,
} from '../../../services/memory-os/src/production-memory-ready.ts';
import {
  createProductionMemoryRuntime,
  type ProductionMemoryRuntime,
} from '../../../services/platform-data/src/memory-runtime.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import {
  createFinalTranscriptEvidencePostgresBridge,
  type FinalTranscriptEvidencePostgresBridge,
} from '../../../services/platform-data/src/final-transcript-evidence-postgres.ts';
import {
  createFinalTranscriptEvidenceService,
  type FinalTranscriptEvidenceResult,
} from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import {
  createRealtimeConversationTurnPostgres,
  type RealtimeConversationTurnBinding,
} from '../../../services/platform-data/src/realtime-conversation-turn-postgres.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import type { RealtimeExternalEffectCoordinatorPort } from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import {
  createRealtimePublicControlT02OwnerBundle,
  type RealtimePublicControlT02OwnerBundle,
} from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import type { ProductionPortRegistration } from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { RealtimeClockPort, RealtimeIdentityPort } from '../../../services/realtime-core/src/ports.ts';
import {
  parseConfiguredOwnerPolicy,
  type RayneoLocalOwnerPolicy,
} from './rayneo-demo-owner-projection.ts';
import { Phase0SharedSessionOwner } from './phase0-shared-session-owner.ts';
import {
  QWEN38_ORCAROUTER_CANARY_PROFILE,
  Qwen38ProviderAdapter,
  type Qwen38LocalProviderProfile,
} from './qwen38-provider-adapter.ts';
import {
  createRealtimePublicControlAssistantBridge,
  type RealtimePublicControlAssistantAudioFactory,
  type RealtimePublicControlAssistantProvider,
} from './realtime-public-control-assistant-bridge.ts';
import {
  RayneoRealtimeAudioController,
  type RayneoRealtimeAudioBinding,
  type RayneoRealtimeAudioConfig,
  type RayneoRealtimeAudioRoomProfile,
} from './rayneo-realtime-audio-controller.ts';
import { RayneoPairingRegistry } from './rayneo-pairing-registry.ts';
import { createLiveKitCloudParticipant, type LiveKitCloudParticipantPort, type LiveKitCloudRoomPort } from './livekit-cloud-participant.ts';
import {
  createPersistentPublicSecretFileReader,
  createPersistentPublicSecretResolver,
  createPersistentRealtimePublicControlPorts,
  type PersistentRealtimePublicControlPorts,
  type PersistentPublicOwnerProtectionPort,
  type PersistentPublicSecretFileReader,
  type PersistentPublicSecretPaths,
} from './realtime-public-control-persistent-public-ports.ts';
import {
  createRealtimePublicControlLiveKitTransportDisconnection,
} from './realtime-public-control-livekit-room-admin.ts';
import {
  createPersistentPublicBearerAuthority,
} from './realtime-public-control-persistent-bearer-authority.ts';
import {
  createRealtimePublicControlSelfHostedCloudProjection,
} from './realtime-public-control-self-hosted-cloud-projection.ts';
import {
  createRealtimePublicControlPgComposition,
  createRuntimeCredentialFenceAdmission,
  type V2CompositionReadinessInput,
  type RealtimePublicControlPgComposition,
  type RealtimePublicControlPgPrebuiltBorrowedOptions,
  type RealtimePublicControlPgCompositionOptions,
} from './realtime-public-control-pg-composition.ts';
import {
  type T03AppleCyclingAuthorityRecordReader,
  type T03AppleCyclingOwnerProtectionPort,
} from './t03-apple-cycling-lease-authority.ts';
import {
  APPLE_PRODUCTION_ENROLLMENT_BUNDLE_PATH,
  // Legacy owner import; paired-device enrollment owns production.
  createAppleProductionSuccessorEnrollmentPort,
  createRuntimeCurrentBindingProvider,
  createRuntimeOwnerIssuer,
  assertAppleEnrollmentOwnerProtectedPath,
  type AppleAuthorityHashPort,
} from './apple-production-enrollment-owner.ts';
import {
  createT03AppleCyclingOwnerBundle,
  type T03AppleCyclingOwnerBundle,
} from './t03-apple-cycling-owner-bundle.ts';
import { createPairedTerminalAuthorities,readActivePairedDevice } from './paired-device-authority.ts';
import {createPairedDeviceCapabilities} from './paired-device-capabilities.ts';
import {pairedPaymentInventory} from './personal-aios-payment-source.ts';
import { createGlassesEnrollment } from './paired-device-registration.ts';
import {createOwnerMacSsh,type MacRelayConfiguration} from './owner-mac-ssh.ts';
import { DeviceSessionAdapter, type GatewayConfig } from './device-session-adapter.ts';
import { GATEWAY_PORT } from './gateway-binding.ts';
import { startDemoRoamingGateway, type GatewayRuntimeConfig } from './main.ts';
import type {
  RealtimeE2eeCiphertextResolverPort,
  RealtimeKeyResolverPort,
  RealtimeBootstrapConnectedInput,
  RealtimeBootstrapConnectedPort,
} from './realtime-public-control-runtime.ts';
import type { RealtimePublicControlController } from './realtime-public-control-controller.ts';
import { createRealtimeSchemaRegistry } from './realtime-public-control-controller.ts';
import type {
  RealtimeAcceptedUserActivityOwnerSource,
} from './realtime-accepted-user-activity-production.ts';
import type { T04ProductionOwner } from './realtime-public-control-t04-owner.ts';
import {
  type QwenModelSupervisor,
} from './qwen-model-supervisor.ts';
import type { ExplicitUserRememberCommand } from '../../../services/memory-os/src/explicit-user-remember-service.ts';
import { createRealtimeCredentialFence } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import type { CurrentBindingLookup } from '../../../services/realtime-core/src/types.ts';
import {
  prepareRealtimePublicControlPersistentOwnerInputs,
  type PersistentOwnerInputsPrepared,
  type PersistentOwnerInputsPrepareOptions,
  type PersistentOwnerInputsT02Attachment,
  type PersistentRayneoPublicControlOwnerInputs,
} from './realtime-public-control-persistent-owner-inputs.ts';

export {
  prepareRealtimePublicControlPersistentOwnerInputs,
  createPersistentOwnerInputs,
  preparePersistentOwnerInputs,
  createRayneoPersistentPublicControlOwnerInputs,
  createPersistentPublicControlOwnerInputsFactory,
} from './realtime-public-control-persistent-owner-inputs.ts';
export type {
  PersistentOwnerInputsPrepared,
  PersistentOwnerInputsPrepareOptions,
  PersistentOwnerInputsT02Attachment,
  PersistentRayneoPublicControlOwnerInputs,
} from './realtime-public-control-persistent-owner-inputs.ts';

const LOOPBACK_HOST = '127.0.0.1' as const;
const RAYNEO_STANDALONE_SESSION_DURATION_MS = 86_400_000 as const;
export const PERSISTENT_PROVIDER_READINESS_HORIZON_MS = 2_110_000 as const;
export type PersistentProductionOwnerProtectionPort = PersistentPublicOwnerProtectionPort &
  T03AppleCyclingOwnerProtectionPort;

/** T03's record reader is fixed to the owner-governed canonical record path. */
export function createPersistentT03AuthorityRecordReader(path: string): T03AppleCyclingAuthorityRecordReader {
  return Object.freeze({
    path,
    read: () => {
      const facts = lstatSync(path);
      if (!facts.isFile() || facts.isSymbolicLink()) throw new Error('PERSISTENT_T03_AUTHORITY_RECORD_FILE_INVALID');
      return readFileSync(path);
    },
  });
}

function readCurrentT03AuthorityRecordSha256(
  record: T03AppleCyclingAuthorityRecordReader,
  ownerProtection: T03AppleCyclingOwnerProtectionPort,
): string {
  try {
    ownerProtection.assertOwnerProtected(record.path);
    const bytes = record.read();
    if (bytes === undefined) fail('PERSISTENT_T03_AUTHORITY_RECORD_UNAVAILABLE');
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error instanceof Error && error.message === 'PERSISTENT_T03_AUTHORITY_RECORD_UNAVAILABLE') throw error;
    fail('PERSISTENT_T03_AUTHORITY_RECORD_UNAVAILABLE', error);
  }
}

function readPersistentT03AuthoritySelector(
  record: T03AppleCyclingAuthorityRecordReader,
  ownerProtection: T03AppleCyclingOwnerProtectionPort,
): Readonly<{ readonly userId: string; readonly deviceId: string }> {
  try {
    ownerProtection.assertOwnerProtected(record.path);
    const bytes = record.read();
    if (bytes === undefined) fail('PERSISTENT_T03_AUTHORITY_RECORD_INVALID');
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (typeof value.user_id !== 'string' || value.user_id.length === 0 ||
        typeof value.device_id !== 'string' || value.device_id.length === 0) {
      fail('PERSISTENT_T03_AUTHORITY_RECORD_INVALID');
    }
    return Object.freeze({ userId: value.user_id, deviceId: value.device_id });
  } catch (error) {
    if (error instanceof Error && error.message === 'PERSISTENT_T03_AUTHORITY_RECORD_INVALID') throw error;
    fail('PERSISTENT_T03_AUTHORITY_RECORD_INVALID', error);
  }
}

export interface RayneoPersistentProductionHandle {
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface RayneoPersistentProductionReadiness {
  readonly t13: true;
  readonly t02: true;
  readonly t11b: true;
  readonly memory: true;
  readonly provider: true;
  readonly gateway: true;
}

export interface RayneoPersistentProductionStartOptions {
  readonly executionOwner?: 'hermes_text';
  readonly publicControl?: RayneoPersistentPublicControlOwnerHandoff;
  /** Explicit product provisioning activates this exact central assembly's existing server. */
  readonly centralListenPort?: number;
  readonly gatewayBinding?: {readonly host: string; readonly port: number};
}

export type RayneoPersistentPublicControlCompositionInput = Omit<
  Extract<RealtimePublicControlPgCompositionOptions, { readonly t02AuthorityMode: 'prebuilt-borrowed' }>,
  | 'enabled'
  | 'controlHost'
  | 'postgres'
  | 'gateway'
  | 'startGateway'
  | 'edge'
  | 'bearer'
  | 'cloud'
  | 'tokenSigner'
  | 'participant'
  | 't02AuthorityMode'
  | 'pool'
  | 'postgresReadiness'
  | 'prebuiltT02Bundle'
  | 'ownerPorts'
  | 'issuerReadiness'
  | 'externalEffectExecutor'
  | 'terminalCodec'
  | 'handoffAuthority'
  | 'handoffOutputFence'
  | 'handoffTerminalCodec'
>;

/** T02 supplies one already-composed authority/coordinator bundle. */
export type RayneoPersistentPublicControlT02PublicControlHandoff = Pick<
  RealtimePublicControlPgPrebuiltBorrowedOptions,
  'pool' | 'postgresReadiness' | 'prebuiltT02Bundle'
>;

export interface RayneoPersistentPublicControlOwnerHandoff {
  /** One concrete Windows ACL owner proof shared by T03 and Public secrets. */
  readonly ownerProtection: PersistentProductionOwnerProtectionPort;
  readonly secretFileReader: PersistentPublicSecretFileReader;
  /** Production handoffs retain the T03 owner for ordered cleanup. */
  readonly t03?: Pick<T03AppleCyclingOwnerBundle, 'close'>;
  /** Production handoffs may precompose the Public ports exactly once. */
  readonly persistentPublicPorts?: PersistentRealtimePublicControlPorts;
  readonly composition: RayneoPersistentPublicControlCompositionInput;
  /** Candidate internal HTTP server uses the same source-owned runtime; listener activation belongs to its caller. */
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  readonly centralTextAssembly?: ReturnType<typeof createPersonalAIOSAssembly>;
  readonly t02: Readonly<{
    readonly publicControl: RayneoPersistentPublicControlT02PublicControlHandoff;
  }>;
  readonly gateway: RealtimePublicControlPgCompositionOptions['gateway'];
  readonly postgresCredential: Readonly<{
    readonly reference: Readonly<{ readonly name: string }>;
    readonly resolvePassword: () => string;
  }>;
  /** Owner/T11B readback only; it carries no local or request-derived identity. */
  readonly appleBindingReadiness: Readonly<{
    readonly owner: string;
    readonly isReady: () => boolean;
  }>;
  readonly room?: LiveKitCloudRoomPort;
  readonly qwenSupervisor?: Pick<QwenModelSupervisor, 'close'>;
}

type PersistentAcceptedUserActivityInput = NonNullable<
  RayneoPersistentPublicControlCompositionInput['acceptedUserActivity']
>;

/** External owner inputs required to finish the persistent Public composition. */
export type RayneoPersistentPublicControlOwnerInputs = PersistentRayneoPublicControlOwnerInputs;

/**
 * Begin the persistent carrier assembly without binding 8787.  T02 is attached
 * by the caller only after this returned object has supplied its lazy effect
 * coordinator to the T02 owner bundle.
 */
export function prepareRayneoPersistentPublicControlOwnerInputs(
  options: PersistentOwnerInputsPrepareOptions,
): PersistentOwnerInputsPrepared {
  return prepareRealtimePublicControlPersistentOwnerInputs(options);
}

/** Attach the single authoritative T02 bundle exactly once. */
export function attachRayneoPersistentT02OwnerInputs(
  prepared: PersistentOwnerInputsPrepared,
  attachment: PersistentOwnerInputsT02Attachment,
): Promise<RayneoPersistentPublicControlOwnerInputs> {
  if (prepared === null || typeof prepared !== 'object' || typeof prepared.attachT02 !== 'function') {
    return Promise.reject(new Error('PERSISTENT_OWNER_INPUTS_PREPARED_REQUIRED'));
  }
  return prepared.attachT02(attachment);
}

/** One production launcher input and one owner handoff share one PG pool. */
export interface HermesProductLauncherInput {
  readonly executionOwner: 'hermes_text';
  readonly owner: Phase0SharedSessionOwner;
  readonly pool: ReturnType<typeof createPostgresPool>;
  readonly environment: NodeJS.ProcessEnv;
  readonly pairingRegistry: Pick<RayneoPairingRegistry, 'read' | 'writePaired' | 'revoke'>;
  readonly inputReadiness: V2CompositionReadinessInput;
}

export type WholeProductExecutionSelection = PersistentPublicExecutionSelection & {
  /** Readiness of the caller-owned ING/D/L4 resources; never a Qwen/STT readiness proxy. */
  readonly inputReadiness: V2CompositionReadinessInput;
  readonly l3?: {readonly namespace: string};
  readonly product_resources?: ProductResourceConfiguration;
  readonly viduCleanup?:ReturnType<typeof createConfiguredViduCleanup>;
};

/** Concrete owner factory seams for controlled source tests; production uses these exact defaults. */
export interface WholeProductOwnerPorts {
  readonly createPool: typeof createPostgresPool;
  readonly inspectPostgres: typeof inspectPostgres;
  readonly createSourceMedia: typeof createSourceMediaAuthority;
  readonly createFinalTranscript: typeof createFinalTranscriptEvidencePostgresBridge;
  readonly createPublicOwner: typeof createPersistentPublicControlOwnerHandoff;
}

export interface RayneoPersistentProductionHandoff {
  readonly launcherInput: HermesProductLauncherInput;
  readonly publicControl: RayneoPersistentPublicControlOwnerHandoff;
}

export interface RayneoPersistentPublicControlHandle {
  readonly controller: RealtimePublicControlController;
  readonly composition: RealtimePublicControlPgComposition;
  readonly close: () => Promise<void>;
}

type SecretResolver = Readonly<{
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly proxyAttestationSecret: string;
}>;

function fail(code: string, cause?: unknown): never {
  throw new Error(code, cause === undefined ? {} : { cause });
}

export async function runPersistentAudioFinalization(input: Readonly<{
  readonly evidenceKey: string;
  readonly recordUserAction: () => Promise<void>;
  readonly afterFinalTranscript: () => Promise<void>;
  readonly releaseCommit: (evidenceKey: string) => void;
}>): Promise<void> {
  try {
    await input.recordUserAction();
    await input.afterFinalTranscript();
  } finally {
    input.releaseCommit(input.evidenceKey);
  }
}

const PUBLIC_REF_KEYS = Object.freeze(['canonical_payload_sha256', 'object_version', 'ref_id', 'ref_type'] as const);
const PUBLIC_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_SHA256 = /^[0-9a-f]{64}$/u;

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PERSISTENT_PUBLIC_AUDIO_CANONICAL_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === undefined || seen.has(value)) {
    fail('PERSISTENT_PUBLIC_AUDIO_CANONICAL_INVALID');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function publicRealtimeSessionRef(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('PERSISTENT_PUBLIC_AUDIO_SESSION_REF_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...PUBLIC_REF_KEYS].sort().join(',') ||
      record.ref_type !== 'RealtimeSession' || typeof record.ref_id !== 'string' ||
      !PUBLIC_UUID_V7.test(record.ref_id) || typeof record.object_version !== 'string' ||
      !/^[1-9][0-9]*$/u.test(record.object_version) || typeof record.canonical_payload_sha256 !== 'string' ||
      !PUBLIC_SHA256.test(record.canonical_payload_sha256)) {
    fail('PERSISTENT_PUBLIC_AUDIO_SESSION_REF_INVALID');
  }
  return Object.freeze({
    ref_type: 'RealtimeSession',
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

function stablePublicAudioId(prefix: string, value: unknown): string {
  return `${prefix}${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 20)}`;
}

function nonEmptyPublicAudioString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\u0000')) {
    fail(code);
  }
  return value;
}

function requireRegularFile(path: string, code: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) fail(code);
}

function readTextFile(path: string, code: string): string {
  requireRegularFile(path, code);
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/u, '');
  if (value.length === 0 || value.includes('\u0000')) fail(code);
  return value;
}

function readProtectedTextFile(
  path: string,
  code: string,
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentProductionOwnerProtectionPort,
): string {
  requireRegularFile(path, code);
  try {
    if (ownerProtection.isOwnerProtected(path) !== true) fail(code);
    const value = reader.read(path).toString('utf8').replace(/\r?\n$/u, '');
    if (value.length === 0 || value.includes('\u0000')) fail(code);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    fail(code, error);
  }
}

function valueFromCredential(resolve: () => string): string {
  let value: string;
  try { value = resolve(); }
  catch (error) { fail('PERSISTENT_PUBLIC_PG_CREDENTIAL_UNAVAILABLE', error); }
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    fail('PERSISTENT_PUBLIC_PG_CREDENTIAL_INVALID');
  }
  return value;
}

function readProxyAttestationSecret(
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentProductionOwnerProtectionPort,
  path: string,
): string {
  const value = reader !== undefined && ownerProtection !== undefined
    ? readProtectedTextFile(path, 'PERSISTENT_PROXY_ATTESTATION_REF_INVALID', reader, ownerProtection)
    : readTextFile(path, 'PERSISTENT_PROXY_ATTESTATION_REF_INVALID');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) fail('PERSISTENT_PROXY_ATTESTATION_INVALID');
  return value;
}

function readLiveKitCredentials(
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentProductionOwnerProtectionPort,
  paths: PersistentPublicSecretPaths,
): SecretResolver {
  const read = reader !== undefined && ownerProtection !== undefined
    ? (path: string, code: string) => readProtectedTextFile(path, code, reader, ownerProtection)
    : readTextFile;
  const livekitApiKey = read(paths.livekitApiKey, 'PERSISTENT_LIVEKIT_API_KEY_REF_INVALID');
  const livekitApiSecret = read(paths.livekitApiSecret, 'PERSISTENT_LIVEKIT_API_SECRET_REF_INVALID');
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(livekitApiKey) || !/^[A-Za-z0-9_-]{32,128}$/u.test(livekitApiSecret)) {
    fail('PERSISTENT_LIVEKIT_CREDENTIAL_INVALID');
  }
  return Object.freeze({
    livekitApiKey,
    livekitApiSecret,
    proxyAttestationSecret: readProxyAttestationSecret(reader, ownerProtection, paths.proxyAttestation),
  });
}

function readOwnerPolicy(path: string): RayneoLocalOwnerPolicy {
  return parseConfiguredOwnerPolicy(JSON.parse(readTextFile(path, 'PERSISTENT_OWNER_POLICY_INVALID')));
}

function assertPersistentPublicControlHandoff(
  value: RayneoPersistentPublicControlOwnerHandoff | undefined,
): asserts value is RayneoPersistentPublicControlOwnerHandoff {
  if (value === undefined || value === null || typeof value !== 'object' ||
      typeof value.ownerProtection?.isOwnerProtected !== 'function' ||
      typeof value.ownerProtection?.assertOwnerProtected !== 'function' ||
      typeof value.secretFileReader?.inspect !== 'function' ||
      typeof value.secretFileReader?.read !== 'function' ||
      value.composition === null || typeof value.composition !== 'object' ||
      value.t02 === null || typeof value.t02 !== 'object' ||
      value.t02.publicControl === null || typeof value.t02.publicControl !== 'object' ||
      value.gateway === null || typeof value.gateway !== 'object' ||
      value.gateway.config === null || typeof value.gateway.config !== 'object' ||
      value.gateway.adapter === null || typeof value.gateway.adapter !== 'object' ||
      typeof value.gateway.adapter.close !== 'function' ||
      value.postgresCredential === null || typeof value.postgresCredential !== 'object' ||
      typeof value.postgresCredential.reference?.name !== 'string' ||
      value.postgresCredential.reference.name.trim().length === 0 ||
      typeof value.postgresCredential.resolvePassword !== 'function' ||
      value.appleBindingReadiness === null || typeof value.appleBindingReadiness !== 'object' ||
      typeof value.appleBindingReadiness.owner !== 'string' ||
      value.appleBindingReadiness.owner.trim().length === 0 ||
      typeof value.appleBindingReadiness.isReady !== 'function') {
    fail('PERSISTENT_PUBLIC_CONTROL_HANDOFF_REQUIRED');
  }
  const t02PublicControl = value.t02.publicControl;
  const bundle = t02PublicControl.prebuiltT02Bundle;
  const pool = t02PublicControl.pool;
  const hasMethods = (candidate: unknown, methods: readonly string[]): boolean => {
    if (candidate === null || typeof candidate !== 'object') return false;
    return methods.every((name) => typeof (candidate as Record<string, unknown>)[name] === 'function');
  };
  if (value.composition.acceptedUserActivity !== undefined) {
    fail('PERSISTENT_T04_OWNER_SOURCE_CONFLICT');
  }
  if (!hasMethods(value.composition.t04Owner, ['onBootstrapConnected', 'preflight', 'close'])) {
    fail('PERSISTENT_T04_OWNER_REQUIRED');
  }
  const t04Owner = value.composition.t04Owner as unknown as T04ProductionOwner;
  if (t04Owner.source.environment !== 'production') fail('PERSISTENT_T04_OWNER_NON_PRODUCTION');
  let t04Ready = false;
  try { t04Ready = t04Owner.source.isReady() === true; } catch { t04Ready = false; }
  if (!t04Ready) fail('PERSISTENT_T04_OWNER_NOT_READY');
  if (pool === null || typeof pool !== 'object' ||
      !hasMethods(pool, ['connect', 'query']) ||
      t02PublicControl.postgresReadiness === null || typeof t02PublicControl.postgresReadiness !== 'object' ||
      t02PublicControl.postgresReadiness.environment !== 'production' ||
      typeof t02PublicControl.postgresReadiness.owner !== 'string' ||
      t02PublicControl.postgresReadiness.owner.trim().length === 0 ||
      typeof t02PublicControl.postgresReadiness.isReady !== 'function' ||
      bundle === null || typeof bundle !== 'object') {
    fail('PERSISTENT_PUBLIC_CONTROL_HANDOFF_INVALID');
  }
  const bundleRecord = bundle as unknown as Record<string, unknown>;
  const authority = bundleRecord.authority;
  const authorityRecord = authority !== null && typeof authority === 'object'
    ? authority as Record<string, unknown>
    : undefined;
  const service = bundleRecord.service;
  const projection = bundleRecord.projection;
  const dataPorts = bundleRecord.dataPorts;
  const identity = dataPorts !== null && typeof dataPorts === 'object'
    ? (dataPorts as Record<string, unknown>).identity
    : undefined;
  if (!hasMethods(authority, ['assertReady', 'close', 'readCurrentBinding']) ||
      !hasMethods(service, ['handoff', 'readCurrentBinding']) ||
      !hasMethods(projection, ['bootstrap', 'connectedRefresh', 'fullyDisconnectedRefresh', 'mediaStop', 'endContinuity']) ||
      !hasMethods(bundleRecord.externalEffectCoordinator,
        ['claim', 'suppressAndClose', 'commit', 'release', 'close']) ||
      !hasMethods(bundleRecord.handoffOutputFence,
        ['claim', 'suppressAndClose', 'commit', 'release', 'close']) ||
      !hasMethods(identity, [
        'createContinuityId', 'assertRepositoryIssuedRef', 'createSessionRef', 'createDeviceLeaseRef',
        'createTransportAlias', 'createConnectionId',
      ]) ||
      !hasMethods(bundle, ['readCurrentBinding', 'assertReady', 'close']) ||
      bundleRecord.service !== authorityRecord?.service ||
      bundleRecord.projection !== authorityRecord?.projection ||
       bundleRecord.readCurrentBinding !== authorityRecord?.readCurrentBinding ||
       bundleRecord.readiness !== authorityRecord?.readiness ||
       bundleRecord.assertReady !== authorityRecord?.assertReady ||
       bundleRecord.close !== authorityRecord?.close ||
       bundleRecord.issuerReadiness === null ||
      typeof bundleRecord.issuerReadiness !== 'object' ||
      (bundleRecord.issuerReadiness as Record<string, unknown>).environment !== 'production' ||
      typeof (bundleRecord.issuerReadiness as Record<string, unknown>).owner !== 'string' ||
      ((bundleRecord.issuerReadiness as Record<string, unknown>).owner as string).trim().length === 0 ||
      typeof (bundleRecord.issuerReadiness as Record<string, unknown>).isReady !== 'function') {
    fail('PERSISTENT_PUBLIC_CONTROL_HANDOFF_INVALID');
  }
  for (const forbidden of [
    'enabled', 'controlHost', 'postgres', 'gateway', 'startGateway', 'edge', 'bearer',
    'cloud', 'tokenSigner', 'participant', 't02AuthorityMode', 'pool', 'postgresReadiness',
    'prebuiltT02Bundle', 'ownerPorts', 'issuerReadiness', 'externalEffectExecutor', 'handoffOutputFence',
    'terminalCodec', 'handoffTerminalCodec',
  ] as const) {
    if (Object.hasOwn(value.composition, forbidden)) fail('PERSISTENT_PUBLIC_CONTROL_HANDOFF_INVALID');
  }
}

function requirePersistentAcceptedUserActivitySource(
  value: RealtimePublicControlPgCompositionOptions['acceptedUserActivity'],
): RealtimeAcceptedUserActivityOwnerSource {
  if (value === undefined || value === null || typeof value !== 'object' ||
      value.source === null || typeof value.source !== 'object' ||
      typeof value.source.owner !== 'string' || value.source.owner.trim().length === 0 ||
      typeof value.source.isReady !== 'function' || typeof value.source.subscribe !== 'function' ||
      typeof value.purpose !== 'string' || value.purpose.trim().length === 0) {
    fail('PERSISTENT_ACCEPTED_USER_ACTIVITY_SOURCE_REQUIRED');
  }
  if (value.source.environment !== 'production') {
    fail('PERSISTENT_ACCEPTED_USER_ACTIVITY_SOURCE_NON_PRODUCTION');
  }
  let ready = false;
  try { ready = value.source.isReady() === true; }
  catch (error) { fail('PERSISTENT_ACCEPTED_USER_ACTIVITY_SOURCE_NOT_READY', error); }
  if (!ready) fail('PERSISTENT_ACCEPTED_USER_ACTIVITY_SOURCE_NOT_READY');
  return value.source;
}

/**
 * Compose the accepted Public/T03/T11B source graph without binding a listener.
 * Every identity- and governance-bearing port is supplied by its production
 * owner; this function only binds those ports to the fixed local files and PG.
 */
export async function createRayneoPersistentPublicControl(
  handoff: RayneoPersistentPublicControlOwnerHandoff | undefined,
): Promise<RayneoPersistentPublicControlHandle> {
  assertPersistentPublicControlHandoff(handoff);
  const t02PublicControl = handoff.t02.publicControl;
  if (handoff.appleBindingReadiness.isReady() !== true) {
    fail('PERSISTENT_PUBLIC_CONTROL_APPLE_BINDING_NOT_READY');
  }
  const now = handoff.composition.now ?? Date.now;
  const publicPorts = handoff.persistentPublicPorts ?? (() => {
    const bearerAuthority = createPersistentPublicBearerAuthority({
      fileReader: handoff.secretFileReader,
      ownerProtection: handoff.ownerProtection,
      now,
    });
    return createPersistentRealtimePublicControlPorts({
      bearerAuthority,
      livekitUrl: handoff.gateway.config.gateway.livekitUrl,
      publicApiUrl: handoff.gateway.config.deviceLanSecurity.publicOrigin,
      ownerProtection: handoff.ownerProtection,
      secretFileReader: handoff.secretFileReader,
      now,
      ...(handoff.room === undefined ? {} : { room: handoff.room }),
    });
  })();
  const publicReadiness = publicPorts.readiness();
  if (!publicReadiness.ready) {
    await publicPorts.close().catch(() => undefined);
    fail('PERSISTENT_PUBLIC_CONTROL_OWNER_PORTS_NOT_READY');
  }
  const cloudProjection = createRealtimePublicControlSelfHostedCloudProjection({ now, livekitUrl: publicPorts.livekitUrl });
  let cloudCloseFlight: Promise<void> | undefined;
  const cloud = Object.freeze({
    bootstrap: cloudProjection.bootstrap,
    connectedRefresh: cloudProjection.connectedRefresh,
    secretResolver: publicPorts.secretResolver,
    close: (): Promise<void> => {
      cloudCloseFlight ??= Promise.resolve().then(() => cloudProjection.close?.());
      return cloudCloseFlight;
    },
  });
  let composition: RealtimePublicControlPgComposition | undefined;
  try {
    composition = createRealtimePublicControlPgComposition({
      ...handoff.composition,
      enabled: true,
      controlHost: LOOPBACK_HOST,
      t02AuthorityMode: 'prebuilt-borrowed',
      pool: t02PublicControl.pool,
      postgresReadiness: t02PublicControl.postgresReadiness,
      prebuiltT02Bundle: t02PublicControl.prebuiltT02Bundle,
      gateway: handoff.gateway,
      edge: publicPorts.edge,
      bearer: publicPorts.bearer,
      cloud,
      tokenSigner: publicPorts.tokenSigner,
      participant: publicPorts.participant,
      ...(handoff.participantForDevice ? {participantForDevice:handoff.participantForDevice} : {}),
    });
    await composition.preflight();
    if (!composition.readiness().ready) fail('PERSISTENT_PUBLIC_CONTROL_COMPOSITION_NOT_READY');
  } catch (error) {
    await composition?.close().catch(() => undefined);
    await t02PublicControl.prebuiltT02Bundle.close().catch(() => undefined);
    await handoff.t03?.close().catch(() => undefined);
    await handoff.qwenSupervisor?.close().catch(() => undefined);
    await cloud.close().catch(() => undefined);
    await publicPorts.close().catch(() => undefined);
    throw error;
  }
  const boundComposition = composition;
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeFlight ??= withShutdownDrain(async () => {
      const settled=await Promise.allSettled([joinShutdown(()=>handoff.composition.assistantBridge?.close?.()),joinShutdown(()=>boundComposition.close())]);
      const failures: unknown[] = settled.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      try { await joinShutdown(()=>t02PublicControl.prebuiltT02Bundle.close()); } catch (error) { failures.push(error); }
      try { await joinShutdown(()=>handoff.t03?.close()); } catch (error) { failures.push(error); }
      try { await joinShutdown(()=>handoff.qwenSupervisor?.close()); } catch (error) { failures.push(error); }
      try { await joinShutdown(()=>publicPorts.close()); } catch (error) { failures.push(error); }
      if (failures.length !== 0) throw new AggregateError(failures, 'PERSISTENT_PUBLIC_CONTROL_CLEANUP_FAILED');
    });
    return closeFlight;
  };
  return Object.freeze({ controller: boundComposition.controller, composition: boundComposition, close });
}

async function inspectPostgres(pool: { query: (sql: string) => Promise<unknown> }): Promise<boolean> {
  try { await pool.query('SELECT 1'); return true; } catch (error) { fail('PERSISTENT_POSTGRES_NOT_READY', error); }
}

function assertT13Runtime(value: unknown): boolean {
  if (value === null || typeof value !== 'object' ||
      (value as Record<string, unknown>).runtimeRootExists !== true ||
      (value as Record<string, unknown>).casRootExists !== true ||
      (value as Record<string, unknown>).metadataRootExists !== true ||
      (value as Record<string, unknown>).catalogExists !== true ||
      (value as Record<string, unknown>).runtimeRootNonReparse !== true ||
      (value as Record<string, unknown>).casRootNonReparse !== true ||
      (value as Record<string, unknown>).metadataRootNonReparse !== true ||
      (value as Record<string, unknown>).catalogNonReparse !== true) {
    fail('PERSISTENT_T13_NOT_READY');
  }
  return true;
}

export function passiveProviderReadiness(
  profile: Qwen38LocalProviderProfile,
  ready: boolean,
  now: () => number = Date.now,
) {
  let closed = false;
  const validThrough = (): number => {
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0 ||
        current > Number.MAX_SAFE_INTEGER - PERSISTENT_PROVIDER_READINESS_HORIZON_MS) return 0;
    return current + PERSISTENT_PROVIDER_READINESS_HORIZON_MS;
  };
  return Object.freeze({
    start: async () => {
      if (closed || !ready) fail('PERSISTENT_PROVIDER_NOT_READY');
      // Qwen16001 is externally owned. Readiness here is an injected owner
      // contract; the first real turn performs the actual model request.
      const validThroughMs = validThrough();
      if (validThroughMs === 0) fail('PERSISTENT_PROVIDER_NOT_READY');
      return Object.freeze({ ready: true, validThroughMs });
    },
    inspect: (requiredThroughMs: number) => {
      const validThroughMs = closed ? 0 : validThrough();
      const requiredThroughValid = Number.isSafeInteger(requiredThroughMs) && requiredThroughMs >= 0;
      return Object.freeze({
        ready: !closed && ready && validThroughMs !== 0 && requiredThroughValid &&
          requiredThroughMs <= validThroughMs,
        validThroughMs,
      });
    },
    close: () => { closed = true; void profile; },
  });
}

function productionReadiness(owner: string, ready: boolean) {
  return Object.freeze({
    owner,
    environment: 'production' as const,
    isReady: () => ready,
  });
}

function productionReadinessProbe(owner: string, probe: () => boolean): V2CompositionReadinessInput {
  return Object.freeze({
    owner,
    isReady: () => {
      try { return probe() === true; } catch { return false; }
    },
  });
}

function productionCanaryReadinessProbe(owner: string, probe: () => boolean) {
  return Object.freeze({
    owner,
    environment: 'production' as const,
    isReady: () => {
      try { return probe() === true; } catch { return false; }
    },
  });
}

function createPersistentT04OwnerSource(): RealtimeAcceptedUserActivityOwnerSource {
  let closed = false;
  return Object.freeze({
    owner: 'T04.accepted-user-activity',
    environment: 'production' as const,
    isReady: () => !closed,
    subscribe: () => {
      if (closed) fail('PERSISTENT_T04_OWNER_SOURCE_CLOSED');
      return () => undefined;
    },
    close: () => { closed = true; },
  });
}

async function readPersistentCurrentBindingLookup(
  pool: ReturnType<typeof createPostgresPool>,
  userId: string,
  deviceId: string,
): Promise<CurrentBindingLookup> {
  let result: { readonly rows?: readonly Record<string, unknown>[] };
  try {
    result = await pool.query(
      [
        'SELECT continuity_id::text AS continuity_id',
        'FROM realtime_sessions',
        "WHERE user_id = $1 AND active_device_id = $2 AND state = 'active' AND continuity_state = 'active'",
      ].join(' '),
      [userId, deviceId],
    );
  } catch (error) {
    fail('PERSISTENT_CURRENT_BINDING_LOOKUP_UNAVAILABLE', error);
  }
  if (result.rows === undefined || result.rows.length !== 1 ||
      typeof result.rows[0]?.continuity_id !== 'string' || result.rows[0].continuity_id.length === 0) {
    fail('PERSISTENT_CURRENT_BINDING_LOOKUP_INVALID');
  }
  return Object.freeze({ continuityId: result.rows[0].continuity_id as never });
}

function createPersistentE2eeOwnerOptions(): PersistentOwnerInputsPrepareOptions['e2ee'] {
  const schemaRegistry = createRealtimeSchemaRegistry();
  return Object.freeze({
    requestValidator: Object.freeze({
      validateRequest: (operation: Parameters<NonNullable<PersistentOwnerInputsPrepareOptions['e2ee']['requestValidator']['validateRequest']>>[0], request: unknown) =>
        operation === 'realtime_e2ee_key_resolve' && schemaRegistry.validateRequest(operation, request),
    }),
    terminalValidator: Object.freeze({
      validateTerminalResult: (operation: Parameters<NonNullable<PersistentOwnerInputsPrepareOptions['e2ee']['terminalValidator']['validateTerminalResult']>>[0], result: Record<string, unknown>) =>
        operation === 'realtime_e2ee_key_resolve' && schemaRegistry.validateTerminal(result),
    }),
  });
}

function readinessInput(value: unknown, code: string): asserts value is V2CompositionReadinessInput {
  if (value === null || typeof value !== 'object' ||
      typeof (value as { readonly owner?: unknown }).owner !== 'string' ||
      (value as { readonly owner: string }).owner.trim().length === 0 ||
      typeof (value as { readonly isReady?: unknown }).isReady !== 'function') {
    fail(code);
  }
}

function assertPersistentPublicControlOwnerInputs(
  value: RayneoPersistentPublicControlOwnerInputs | undefined,
): asserts value is RayneoPersistentPublicControlOwnerInputs {
  if (value === undefined || value === null || typeof value !== 'object') {
    fail('PERSISTENT_PUBLIC_CONTROL_OWNER_INPUTS_REQUIRED');
  }
  for (const [candidate, code] of [
    [value.finalTranscriptReadiness, 'PERSISTENT_FINAL_TRANSCRIPT_OWNER_REQUIRED'],
    [value.externalEffectsReadiness, 'PERSISTENT_EXTERNAL_EFFECTS_OWNER_REQUIRED'],
    [value.e2eeReadiness, 'PERSISTENT_E2EE_OWNER_REQUIRED'],
    [value.e2eeCiphertextReadiness, 'PERSISTENT_E2EE_CIPHERTEXT_OWNER_REQUIRED'],
  ] as const) {
    readinessInput(candidate, code);
  }
  if (value.appleBindingReadiness === null || typeof value.appleBindingReadiness !== 'object' ||
      typeof value.appleBindingReadiness.owner !== 'string' ||
      value.appleBindingReadiness.owner.trim().length === 0 ||
      typeof value.appleBindingReadiness.isReady !== 'function') {
    fail('PERSISTENT_APPLE_BINDING_OWNER_REQUIRED');
  }
  if (value.externalEffectCoordinator === null || typeof value.externalEffectCoordinator !== 'object' ||
      ![
        'claim', 'restore', 'executeStage', 'commit', 'release', 'suppressAndClose', 'reconcileStage', 'close',
      ].every((name) => typeof (value.externalEffectCoordinator as unknown as Record<string, unknown>)[name] === 'function')) {
    fail('PERSISTENT_EXTERNAL_EFFECT_COORDINATOR_REQUIRED');
  }
  if (value.e2ee === null || typeof value.e2ee !== 'object' || typeof value.e2ee.issue !== 'function') {
    fail('PERSISTENT_E2EE_OWNER_REQUIRED');
  }
  if (value.e2eeCiphertext === null || typeof value.e2eeCiphertext !== 'object' ||
      typeof value.e2eeCiphertext.resolve !== 'function') {
    fail('PERSISTENT_E2EE_CIPHERTEXT_OWNER_REQUIRED');
  }
  if (value.t04Owner === undefined || typeof value.t04Owner !== 'object' ||
      typeof value.t04Owner.onBootstrapConnected !== 'function' ||
      typeof value.t04Owner.preflight !== 'function' || typeof value.t04Owner.close !== 'function') {
    fail('PERSISTENT_T04_OWNER_REQUIRED');
  }
  if (typeof value.readCurrentBinding !== 'function' ||
      value.service === null || typeof value.service !== 'object' ||
      typeof value.service.recordAcceptedUserActivity !== 'function' ||
      value.equality === null || typeof value.equality !== 'object' ||
      typeof value.equality.same !== 'function' ||
      value.applePhysicalBinding === null || typeof value.applePhysicalBinding !== 'object' ||
      typeof value.applePhysicalBinding.readActiveByPrimary !== 'function') {
    fail('PERSISTENT_T02_OWNER_INPUTS_INVALID');
  }
}

function createPersistentGateway(
  livekit: SecretResolver,
  resources?: ProductResourceConfiguration,
): Readonly<{ readonly config: GatewayRuntimeConfig; readonly adapter: DeviceSessionAdapter }> {
  if (!resources) fail('PRODUCT_RESOURCES_REQUIRED');
  const gatewayConfig: GatewayConfig = Object.freeze({
    livekitUrl: resources.livekit_url,
    ...(resources?.livekit_api_url ? {livekitApiUrl: resources.livekit_api_url} : {}),
    apiKey: livekit.livekitApiKey,
    apiSecret: livekit.livekitApiSecret,
    sessionTtlSeconds: 120,
    tokenTtlSeconds: 120,
  });
  const config: GatewayRuntimeConfig = Object.freeze({
    gateway: gatewayConfig,
    deviceLanSecurity: Object.freeze({
      publicOrigin: resources?.public_api_url ?? `https://${LOOPBACK_HOST}`,
      publicHost: resources?.public_api_url ? new URL(resources.public_api_url).host : LOOPBACK_HOST,
      hostIpv4: LOOPBACK_HOST,
      hostIpv4Cidr: `${LOOPBACK_HOST}/32`,
      subnetPrefixLength: 32,
      iphoneIpv4: LOOPBACK_HOST,
      proxyAttestationSecret: livekit.proxyAttestationSecret,
    }),
    precontactAdmission: 'OPEN_NORMAL',
  });
  const adapter = new DeviceSessionAdapter(gatewayConfig, { enableGatewayJoin: false });
  return Object.freeze({ config, adapter });
}

export async function createPersistentPublicControlOwnerHandoff(
  input: Readonly<{
    readonly pool: ReturnType<typeof createPostgresPool>;
    readonly postgresReadiness: ProductionPortRegistration<RealtimeClockPort>['readiness'];
    readonly postgresPassword: string;
    readonly identity: RealtimeIdentityPort;
    readonly livekit: SecretResolver;
    readonly ownerProtection: PersistentProductionOwnerProtectionPort;
    readonly secretFileReader: PersistentPublicSecretFileReader;
    readonly policy: RayneoLocalOwnerPolicy;
    readonly productResources?: ReturnType<typeof createConfiguredProductResources>;
    readonly finalTranscriptReadiness?: V2CompositionReadinessInput;
    readonly inputReadiness?: V2CompositionReadinessInput;
    readonly assistantProviderProfile?: Qwen38LocalProviderProfile;
    readonly sourceMedia?: SourceMediaAuthorityPort;
    readonly finalTranscriptEvidence?: FinalTranscriptEvidencePostgresBridge;
  }> & PersistentPublicExecutionSelection,
): Promise<RayneoPersistentPublicControlOwnerHandoff> {
  if (input.executionOwner !== 'hermes_text') fail('PUBLIC_EXECUTION_OWNER_INVALID');
  const now = (): number => Date.now();
  const clockPort: RealtimeClockPort = Object.freeze({
    now: () => assertCanonicalTimestamp(new Date(now()).toISOString()),
  });
  const clock: ProductionPortRegistration<RealtimeClockPort> = Object.freeze({
    port: clockPort,
    readiness: productionReadiness('T01.clock', true),
  });
  const avatarLooks=input.productResources?.configuration.avatar_looks;
  let avatar:ReturnType<typeof createAvatarProfileService>|undefined;
  let appearanceImages:ReturnType<typeof createAppearanceImages>|undefined;
  let t02: RealtimePublicControlT02OwnerBundle | undefined;
  let publicPorts: PersistentRealtimePublicControlPorts | undefined;
  let transportDisconnection: ReturnType<typeof createRealtimePublicControlLiveKitTransportDisconnection> | undefined;
  let prepared: PersistentOwnerInputsPrepared | undefined;
  let composedT02: RealtimePublicControlT02OwnerBundle | undefined;
  let gateway: Readonly<{ readonly config: GatewayRuntimeConfig; readonly adapter: DeviceSessionAdapter }> | undefined;
  const participants = new Map<string, LiveKitCloudParticipantPort>();
  const executions: Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>[] = [];
  let sharedExecution:Awaited<ReturnType<typeof createPersistentPublicExecutionHost>>|undefined;
  const ownerMac=process.env.PAIOS_OWNER_MAC_ROOT?createOwnerMacSsh({pool:input.pool,root:process.env.PAIOS_OWNER_MAC_ROOT,
    relay:JSON.parse(readFileSync(process.env.PAIOS_OWNER_MAC_RELAY_FILE!,'utf8')) as MacRelayConfiguration,
    paused:deviceId=>sharedExecution?.desktop?.paused(deviceId)}):undefined;
  // Read owner-Mac configuration before borrowing the paired-device LISTEN client.
  // The paired-device table is the one device authority: bearer, lease policy, ownership, E2EE recipient.
  const devices = await createPairedTerminalAuthorities({ pool: input.pool, now, ownerUserId:input.policy.userId });
  const stopRevoked = devices.onRevoked(async deviceId=>{await Promise.all([participants.get(deviceId)?.disconnect(),ownerMac?.revoked(deviceId)]);});
  const executionByDevice = new Map<string, Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>>();
  const viduRetrieval:ViduRetrieval=new Map();
  let assistantBridge: RealtimeBootstrapConnectedPort | undefined;
  let assistantProvider: Qwen38ProviderAdapter | undefined;
  try {
    const imageDirectory=process.env.PAIOS_APPEARANCE_IMAGE_DIR;
    if(imageDirectory){
      check(isAbsolute(imageDirectory),'AVATAR_IMAGE_DIRECTORY_INVALID');
      const publicOrigin=input.productResources?.configuration.public_api_url;
      check(publicOrigin,'AVATAR_IMAGE_ORIGIN_REQUIRED');
      appearanceImages=createAppearanceImages({directory:imageDirectory,publicOrigin,authenticate:async request=>{
        const authorization=request.headers.authorization;
        check(typeof authorization==='string'&&authorization.startsWith('Bearer '),'AVATAR_IMAGE_UNAUTHORIZED',401);
        const bearer=await publicPorts!.bearer.authorize({token:authorization.slice(7),operation:'bootstrap',request:{}});
        check(typeof bearer.principal==='string','AVATAR_IMAGE_UNAUTHORIZED',401);
        const execution=executionByDevice.get(bearer.deviceId);
        check(execution,'AVATAR_IMAGE_SOURCE_UNAVAILABLE',503);
        const source=await execution.authority.scheduled(bearer.principal,bearer.deviceId);
        check(source.device_type==='phone'||source.device_type==='mac','AVATAR_APPEARANCE_OWNER_REQUIRED',403);
        return{principal_id:source.principal_id,device_id:source.device_id};
      }});
    }
    avatar=createAvatarProfileService({pool:input.pool,looks:avatarLooks??[],
      ...(appearanceImages?{resolveLook:appearanceImages.resolveLook}:{}),
      ...(input.productResources?.videoCall?{assets:createViduAvatarAssets(input.productResources.videoCall)}:{})});
    publicPorts = createPersistentRealtimePublicControlPorts({
      bearerAuthority: devices.bearer,
      ownerProtection: input.ownerProtection,
      secretFileReader: input.secretFileReader,
      ...(input.productResources ? {secretPaths:input.productResources.secretPaths,livekitUrl:input.productResources.configuration.livekit_url,
        ...(input.productResources.configuration.livekit_api_url ? {livekitApiUrl: input.productResources.configuration.livekit_api_url} : {}),
        ...(input.productResources.configuration.public_api_url ? {publicApiUrl: input.productResources.configuration.public_api_url} : {}),
        ...(input.productResources.configuration.legacy_public_api_urls === undefined ? {}
          : {legacyPublicApiUrls: input.productResources.configuration.legacy_public_api_urls})} : {}),
    });
    for (const terminal of devices.terminals) participants.set(terminal.deviceId,
      createLiveKitCloudParticipant(undefined, publicPorts.livekitApiUrl));
    const participantForDevice = (deviceId: string): LiveKitCloudParticipantPort | undefined => participants.get(deviceId);
    publicPorts = Object.freeze({...publicPorts,participantForDevice});
    transportDisconnection = createRealtimePublicControlLiveKitTransportDisconnection({
      serverUrl: publicPorts.livekitUrl,
      ...(publicPorts.livekitApiUrl ? {apiUrl: publicPorts.livekitApiUrl} : {}),
      apiKeyRef: publicPorts.livekitApiKeyRef,
      apiSecretRef: publicPorts.livekitApiSecretRef,
      secretResolver: publicPorts.secretResolver,
      readiness: () => publicPorts!.readiness().ready,
      now,
    });
    // Sessions are created by the device's own bootstrap; startup no longer needs a pre-existing binding.
    const credentialFence = createRealtimeCredentialFence(input.pool);
    prepared = prepareRayneoPersistentPublicControlOwnerInputs({
      pool: input.pool,
      publicPorts,
      t03: {
        activityAcceptance: devices.activityAcceptance,
        formalWatchPrimaryAuthority: devices.formalWatchPrimaryAuthority,
        recipientCredential: devices.recipientCredential,
        readiness: devices.readiness,
      },
      ...(input.executionOwner === 'hermes_text'
        ? {inputReadiness: input.inputReadiness ?? fail('HERMES_INPUT_READINESS_REQUIRED')}
        : {finalTranscriptReadiness: input.finalTranscriptReadiness ?? fail('LEGACY_TRANSCRIPT_READINESS_REQUIRED')}),
      t04: { source: createPersistentT04OwnerSource() },
      e2ee: createPersistentE2eeOwnerOptions(),
      credentialFence,
      now,
    });
    t02 = await createRealtimePublicControlT02OwnerBundle({
      pool: input.pool,
      postgresReadiness: input.postgresReadiness,
      clock,
      t03: {
        policy: devices.policy,
        bindCurrentBinding: devices.bindCurrentBinding,
      },
      activityAcceptance: devices.activityAcceptance,
      transportDisconnection,
      externalEffectCoordinator: prepared.externalEffectCoordinator,
    });
    composedT02 = Object.freeze({ ...t02, close: t02.authority.close });
    const ownerInputs = await attachRayneoPersistentT02OwnerInputs(prepared, {
      t02: composedT02,
    });
    const t04Owner = ownerInputs.t04Owner;
    if (t04Owner === undefined) fail('PERSISTENT_T04_OWNER_REQUIRED');
    const captureT02 = composedT02;
    const sourceRank = (terminal:typeof devices.terminals[number]):number => {
      const capabilities = terminal.readCurrentAuthority().capabilities;
      return !input.pcm || !capabilities.includes('microphone') ? 0 :
        input.pcm.continuous && capabilities.includes('continuous_audio') ? 2 : 1;
    };
    const terminalOrder = [...devices.terminals].sort((left,right)=>sourceRank(right)-sourceRank(left));
    const amapKeyFile = input.productResources?.configuration.amap_key_file;
    const navigation = amapKeyFile ? createAmapNavigation({keyFile:amapKeyFile}) : undefined;
    const capabilityUpgrade=createPairedDeviceCapabilities({pool:input.pool,identity:input.identity,
      request:(request,text)=>sharedExecution!.assembly.runtime.requestCapabilityUpgrade(request,text),
      refresh:deviceId=>refreshTerminal(deviceId)});
    sharedExecution=await createPersistentPublicExecutionHost({
      ...(ownerMac?{ownerMac}:{}),
      ...(input.productResources?.configuration.call_rejoin_window_s!==undefined?{callRejoinWindowS:input.productResources.configuration.call_rejoin_window_s}:{}),
      ...(input.productResources?.configuration.ride_hr_alert_bpm!==undefined?{rideHrAlertBpm:input.productResources.configuration.ride_hr_alert_bpm}:{}),
      ...(input.productResources?.configuration.movement_pending_ttl_ms!==undefined?{movementPendingTtlMs:input.productResources.configuration.movement_pending_ttl_ms}:{}),
      ...(navigation?{navigation}:{}),
      ...(avatar?{avatar,appearancePricing:{...readAppearancePricing(process.env.PAIOS_APPEARANCE_PRICING),photoUploadAvailable:appearanceImages!==undefined}}:{}),
      executionOwner:'hermes_text',central:{...input.central,
        capability_grants:{approve:capabilityUpgrade.approve},payment_devices:principal=>pairedPaymentInventory(input.pool,principal)},
      ...(input.pcm?{pcm:input.pcm}:{}),desktopPool:input.pool,now,onError:reportPersistentExecutionError,
      ...(input.productResources?.configuration.errand_spool_dir?{errandSpool:input.productResources.configuration.errand_spool_dir}:{}),
      ...(input.productResources?.configuration.staging_effect_sink_file?{stagingEffects:createStagingEffectSink(input.productResources.configuration.staging_effect_sink_file)}:{}),
      ...(input.productResources?.configuration.bark_device_file?{notify:createBarkNotifier(input.productResources.configuration.bark_device_file,input.productResources.configuration.bark_key_file!)}:{})});
    const activateTerminal = async (terminal:typeof devices.terminals[number]) => {
      if (executionByDevice.has(terminal.deviceId)) return;
      if (!participants.has(terminal.deviceId)) participants.set(terminal.deviceId, createLiveKitCloudParticipant(undefined, publicPorts!.livekitApiUrl));
      const participant = participantForDevice(terminal.deviceId)!;
      const projection = terminal.readCurrentAuthority();
      const supportsAudio = projection.capabilities.includes('microphone');
      const supportsPlayback = projection.capabilities.includes('speaker');
      const {formal_voice, voice, ...resources} = input.central;
      let terminalPcm = input.pcm && supportsAudio ? {...input.pcm,
        producer:{...input.pcm.producer,device_type:projection.deviceType}} : undefined;
      if (terminalPcm?.continuous && !projection.capabilities.includes('continuous_audio')) {
        const {continuous, ...finite} = terminalPcm; terminalPcm = {...finite,input_contract:'frame_v1'};
      }
      const terminalWatch = projection.deviceType === 'phone' ? createRuntimeCurrentBindingProvider(input.pool,
        {userId:projection.userId,deviceId:terminal.deviceId,readPrincipalRef:()=>terminal.readCurrentAuthority().principal}) : undefined;
      const execution = await createPersistentPublicExecutionOwner({
      ...(ownerMac?{ownerMac}:{}),
      ...(input.productResources?.configuration.call_rejoin_window_s!==undefined?{callRejoinWindowS:input.productResources.configuration.call_rejoin_window_s}:{}),
      ...(input.productResources?.configuration.ride_hr_alert_bpm!==undefined?{rideHrAlertBpm:input.productResources.configuration.ride_hr_alert_bpm}:{}),
      ...(input.productResources?.configuration.movement_pending_ttl_ms!==undefined?{movementPendingTtlMs:input.productResources.configuration.movement_pending_ttl_ms}:{}),
      ...(navigation?{navigation}:{}),
        retainAssembly:true,
      sharedExecution:sharedExecution!,
      ...(avatar?{avatar,appearancePricing:{...readAppearancePricing(process.env.PAIOS_APPEARANCE_PRICING),photoUploadAvailable:appearanceImages!==undefined}}:{}),
      avatarSigner:publicPorts!.tokenSigner,
      ...(input.productResources?.configuration.avatar_url?{avatarOrigin:input.productResources.configuration.avatar_url,avatarToken:input.productResources.avatarToken!}:{}),
      ...(input.productResources?.videoCall?{videoCall:{configuration:input.productResources.videoCall,
        apiKey:input.productResources.viduApiKey!,journal:input.productResources.viduJournal!}}:{}),
      ...(input.executionOwner === 'hermes_text' ? {executionOwner:'hermes_text',central:{...resources,
        capability_grants:{approve:capabilityUpgrade.approve},
        payment_devices:principal=>pairedPaymentInventory(input.pool,principal),
        ...(supportsPlayback && formal_voice ? {formal_voice} : {}),...(terminalPcm && voice ? {voice} : {})},
        ...(terminalPcm ? {pcm:terminalPcm} : {}),
        ...(input.productResources?.configuration.staging_effect_sink_file ? {stagingEffects:createStagingEffectSink(input.productResources.configuration.staging_effect_sink_file)} : {}),
        ...(input.productResources?.configuration.bark_device_file ? {notify:createBarkNotifier(input.productResources.configuration.bark_device_file,
          input.productResources.configuration.bark_key_file!)} : {})} : fail('PUBLIC_EXECUTION_OWNER_INVALID')),
      readCurrentBindingInAdmission:(client,lookup)=>{captureT02.assertReady();return captureT02.dataPorts.repository.readCurrentBindingInTransaction(client,lookup);},
      ...(terminalWatch ? {watchSnapshot:terminalWatch} : {}),
      ...(ownerInputs.watchCredentials ? {watchCredentials:ownerInputs.watchCredentials} : {}),
      t03:terminal,desktopPool:input.pool,readCurrentBinding:captureT02.readCurrentBinding,deviceId:terminal.deviceId,participant,now,credentialFence,
      onError:reportPersistentExecutionError,
    });
      executions.push(execution); executionByDevice.set(terminal.deviceId,execution);
    };
    avatar?.start(reportPersistentExecutionError);
    for (const terminal of terminalOrder) await activateTerminal(terminal);
    const activation = new Map<string, Promise<unknown>>();
    const refreshTerminal=async(deviceId:string)=>{
      const pending=(activation.get(deviceId)??Promise.resolve()).then(async()=>{
          if(terminalsClosing)fail('PERSISTENT_PUBLIC_CONTROL_OWNER_CLOSED');
          const current=await readActivePairedDevice(input.pool,deviceId);
          const projection=devices.forDevice(deviceId).readCurrentAuthority();
          const unchanged=canonical(current.governance.capability_grant_refs)===canonical((projection.governance as Record<string,unknown>).capability_grant_refs);
          if(unchanged&&executionByDevice.has(deviceId))return projection;
          const previous=executionByDevice.get(deviceId);
          if(previous){
            await participants.get(deviceId)!.disconnect();
            await previous.bridge.close!();
            executionByDevice.delete(deviceId);
          }
          await activateTerminal(unchanged?devices.forDevice(deviceId):await devices.register(deviceId,true));
          return devices.forDevice(deviceId).readCurrentAuthority();
      });activation.set(deviceId,pending);
      try{return await pending;}finally{if(activation.get(deviceId)===pending)activation.delete(deviceId);}
    };
    let terminalsClosing = false,terminalsCloseFlight:Promise<void>|undefined;
    assistantBridge = Object.freeze({
      centralTextTransportForDevice:(deviceId:string)=>executionByDevice.get(deviceId)?.bridge.centralTextTransport,
      callRejoinForDevice:(deviceId:string)=>executionByDevice.get(deviceId)?.bridge.callRejoinForDevice?.(deviceId),
      assertBootstrapRequest:(request:Record<string,unknown>)=>{
        const execution = executionByDevice.get(String(request.device_id)) ?? fail('PAIRED_DEVICE_REQUIRED');
        execution.bridge.assertBootstrapRequest?.(request);
      },
      onBootstrapConnected:async(input:RealtimeBootstrapConnectedInput)=>{
        const execution = executionByDevice.get(input.bearer.deviceId) ?? fail('PAIRED_DEVICE_REQUIRED');
        await execution.bridge.onBootstrapConnected?.(input);
      },
      close:()=>terminalsCloseFlight??=(async()=>{
        terminalsClosing = true;const retiring=[avatar?.close(),...executions.map(execution=>execution.bridge.close?.())];
        const retired=await Promise.allSettled([...retiring,...activation.values()]);
        const closed=await Promise.allSettled(executions.map(execution=>execution.bridge.close?.()));
        const desktop=await Promise.allSettled([Promise.resolve().then(()=>sharedExecution?.desktop?.close()),
          Promise.resolve().then(()=>sharedExecution?.closeResources())]);
        const assembly=await Promise.allSettled([Promise.resolve().then(()=>sharedExecution?.assembly.close())]);
        const failures=[...retired,...closed,...desktop,...assembly].flatMap(result=>result.status==='rejected'?[result.reason]:[]);
        if(failures.length)throw new AggregateError([...new Set(failures)],'PERSISTENT_TERMINALS_CLEANUP_FAILED');
      })(),
    });
    prepared.assertReady();
    const boundPrepared = prepared;
    gateway = createPersistentGateway(input.livekit, input.productResources?.configuration);
    const publicReady = (): boolean => publicPorts!.readiness().ready;
    const readiness = Object.freeze({
      postgres: input.postgresReadiness,
      canonicalIssuer: t02.issuerReadiness,
      ownerContext: devices.readiness,
      finalTranscript: ownerInputs.finalTranscriptReadiness,
      governance: devices.readiness,
      edge: productionReadinessProbe('Public', publicReady),
      bearer: productionReadinessProbe('Public', publicReady),
      cloud: productionReadinessProbe('Cloud', publicReady),
      externalEffects: ownerInputs.externalEffectsReadiness,
      terminalCodec: productionReadiness('T01', true),
      handoffTerminalCodec: productionReadiness('T01', true),
      e2ee: ownerInputs.e2eeReadiness,
      e2eeCiphertext: ownerInputs.e2eeCiphertextReadiness,
      secretResolver: productionReadinessProbe('OwnerSecrets', publicReady),
      tokenSigner: productionReadinessProbe('LiveKit', publicReady),
      participant: productionReadinessProbe('LiveKit', publicReady),
    });
    const composition: RayneoPersistentPublicControlCompositionInput = {
      readiness,
      capabilityUpgrade,
      ...(input.productResources?.configuration.public_api_url ? {canonicalApiOrigin: input.productResources.configuration.public_api_url} : {}),
      viduRetrieval,
      ...(ownerInputs.watchCredentials ? {watch:{
        authenticate:async(token:string)=>{
          const resolved=await ownerInputs.watchCredentials!.resolveCredential(token);
          const execution=executionByDevice.get(resolved.binding.iphone.deviceId);
          check(execution,'service_unavailable',503);
          const source=await execution.assembly.runtime.authenticate(execution.authority.credentialForWatch(token));
          return {source,session:resolved.continuityId,pairVersion:resolved.binding.pairVersion};
        },
        utterance:(context,turn,metadata,bytes)=>sharedExecution!.assembly.runtime.watchUtterance(context.source,context.session,context.pairVersion,turn,metadata,bytes),
        turn:(context,turn,signal)=>sharedExecution!.assembly.runtime.watchTurn(context.source,context.session,context.pairVersion,turn,signal),
        credential:async(token:string,body:Record<string,unknown>)=>{
          let bearer;
          try{bearer=await publicPorts!.bearer.authorize({token,operation:'bootstrap',request:body});}
          catch(error){if((error as {status?:number}).status===401)throw new ContractError('credential_invalid',401);throw error;}
          return ownerInputs.watchCredentials!.credential({action:body.action as 'issue'|'refresh'|'revoke',
            requestId:body.request_id as string,watchDeviceId:body.watch_device_id as string,installationId:body.installation_id as string,
            expectedPairVersion:body.expected_pair_version as string},bearer);
        },
      }} : {}),
      ...(appearanceImages?{appearanceImages}:{}),
      ...(ownerMac?{ownerMac}:{}),
      wechatPreviews:async(bearer,value)=>{
        const paired=await readActivePairedDevice(input.pool,bearer.deviceId);
        check(paired?.deviceType==='mac'&&paired.userId===bearer.principal&&value.device_id===paired.deviceId,'WECHAT_MAC_REQUIRED',403);
        const execution=executionByDevice.get(paired.deviceId);
        check(execution,'WECHAT_PREVIEWS_UNAVAILABLE',503);
        return execution.assembly.runtime.wechatPreviews(paired.userId,paired.deviceId,value);
      },
      place:{credential:(token,value)=>devices.place.credential(token,value),upload:async(token,batch)=>{
        const projection=await devices.place.resolve(createHash('sha256').update(token).digest('hex'));
        if(!projection || batch.device_id!==projection.deviceId)throw Object.assign(new Error('PLACE_CAPABILITY_INVALID'),{status:401});
        const execution=executionByDevice.get(projection.deviceId);
        if(!execution)throw Object.assign(new Error('PLACE_SOURCE_UNAVAILABLE'),{status:503});
        const source=await execution.assembly.runtime.authenticate(execution.authority.credentialForPlace(token));
        return execution.assembly.runtime.placeUpload(source,batch);
      }},
      ...(input.productResources ? {glassesEnrollment:createGlassesEnrollment({pool:input.pool,
        identity:input.identity,origin:input.productResources.configuration.public_api_url ?? `https://${new URL(input.productResources.configuration.livekit_url).host}`,
        artifactDirectory:dirname(input.productResources.configuration.owner_policy_file),now,
        verifyMacApproval:async(phone,nonce,keyDigest,signed)=>{
          const execution=executionByDevice.get(phone.deviceId);
          if(!execution)fail('PAIRED_PHONE_REQUIRED');
          const source=await execution.authority.scheduled(phone.userId,phone.deviceId);
          await execution.assembly.runtime.verifyMacPairing(source,signed,nonce,keyDigest);
        },
        activate:async deviceId=>{
          if(terminalsClosing) fail('PERSISTENT_PUBLIC_CONTROL_OWNER_CLOSED');
          let pending=activation.get(deviceId);
          if(!pending){pending=devices.register(deviceId).then(activateTerminal);activation.set(deviceId,pending);}
          try {await pending;} finally {if(activation.get(deviceId)===pending)activation.delete(deviceId);}
        }})} : {}),
      ownerContext: devices.ownerContext,
      governance: devices.governance,
      e2ee: ownerInputs.e2ee,
      e2eeCiphertext: ownerInputs.e2eeCiphertext,
      applePhysicalBinding: ownerInputs.applePhysicalBinding,
      ...(ownerInputs.watchBinding === undefined ? {} : {watchBinding:ownerInputs.watchBinding}),
      t04Owner,
      assistantBridge:assistantBridge!,
      deviceCredential: devices.deviceCredential,
      credentialFenceAdmission: createRuntimeCredentialFenceAdmission(credentialFence),
      now,
    };
    const postgresCredential = Object.freeze({
      reference: Object.freeze({ name: 'paios-memory-pg18' }),
      resolvePassword: () => input.postgresPassword,
    });
    const closePreparedAndT03 = async (): Promise<void> => {
      stopRevoked();
      const failures: unknown[] = [];
      try { await boundPrepared.close(); } catch (error) { failures.push(error); }
      try { await devices.close(); } catch (error) { failures.push(error); }
      const closed = await Promise.allSettled([...participants.values()].map(participant=>participant.close()));
      for(const result of closed) if(result.status==='rejected') failures.push(result.reason);
      if (failures.length !== 0) throw new AggregateError(failures, 'PERSISTENT_PUBLIC_CONTROL_OWNER_CLEANUP_FAILED');
    };
    return Object.freeze({
      ownerProtection: input.ownerProtection,
      secretFileReader: input.secretFileReader,
      t03: Object.freeze({ close: closePreparedAndT03 }),
      persistentPublicPorts: publicPorts,
      composition,
      centralTextAssembly:sharedExecution.assembly,
      participantForDevice,
      t02: Object.freeze({
        publicControl: Object.freeze({
          pool: input.pool,
          postgresReadiness: input.postgresReadiness,
          prebuiltT02Bundle: composedT02,
        }),
      }),
      gateway,
      postgresCredential,
      appleBindingReadiness: ownerInputs.appleBindingReadiness,
    });
  } catch (error) {
    await avatar?.close();
    stopRevoked();
    await gateway?.adapter.close().catch(() => undefined);
    await t02?.close().catch(() => undefined);
    await Promise.resolve(transportDisconnection?.close?.()).catch(() => undefined);
    await prepared?.close().catch(() => undefined);
    await Promise.resolve(assistantBridge?.close?.()).catch(() => undefined);
    if (assistantBridge === undefined) assistantProvider?.close();
    await devices.close().catch(() => undefined);
    await Promise.allSettled([...participants.values()].map(participant=>participant.close()));
    if (!assistantBridge) {await Promise.allSettled(executions.map(execution=>execution.bridge.close?.())); await sharedExecution?.desktop?.close();await sharedExecution?.closeResources();await sharedExecution?.assembly.close();}
    await publicPorts?.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Build the real owner handoff used by the scheduled Gateway task. Construction
 * probes existing PG and builds only the selected central/public owner;
 * no listener, device session or physical collector starts until explicit start.
 */
export async function createRayneoPersistentProductionHandoff(
  selection: WholeProductExecutionSelection,
  overrides: Partial<WholeProductOwnerPorts> = {},
): Promise<RayneoPersistentProductionHandoff> {
  assertStagingProductResources(selection.product_resources);
  if (selection.executionOwner !== 'hermes_text') fail('PUBLIC_EXECUTION_OWNER_INVALID');
  const cleanup=selection.viduCleanup??createConfiguredViduCleanup(selection.product_resources!);
  try {
  if(!selection.viduCleanup&&cleanup)try{await cleanup.viduJournal.reconcile({apiKey:cleanup.viduApiKey});}
  catch{process.stderr.write('VIDU_RESTART_CLEANUP_FAILED\n');}
  if (selection.executionOwner === 'hermes_text' &&
      (!selection.central || typeof selection.inputReadiness?.isReady !== 'function' ||
       !selection.inputReadiness.isReady())) fail('HERMES_INPUT_OWNER_NOT_READY');
  const ports: WholeProductOwnerPorts = {
    createPool: createPostgresPool, inspectPostgres, createSourceMedia: createSourceMediaAuthority,
    createFinalTranscript: createFinalTranscriptEvidencePostgresBridge,
    createPublicOwner: createPersistentPublicControlOwnerHandoff, ...overrides,
  };
  const productResources = createConfiguredProductResources(selection.product_resources!,cleanup);
  const ownerProtection = productResources.ownerProtection;
  const secretFileReader = productResources.secretFileReader;
  const policy = productResources.policy;
  const postgresPassword = productResources.postgresPassword;
  const livekit = productResources.livekit;
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  let sourceMedia: SourceMediaAuthorityPort | undefined;
  let publicControl: RayneoPersistentPublicControlOwnerHandoff | undefined;
  let owner: Phase0SharedSessionOwner | undefined;
  try {
    pool = ports.createPool({
      host: productResources.configuration.postgres.host,
      port: productResources.configuration.postgres.port,
      database: productResources.configuration.postgres.database,
      user: productResources.configuration.postgres.user,
      password: postgresPassword,
      max: 4,
      applicationName: 'paios-rayneo-persistent-gateway',
    });
      const postgresReady = await ports.inspectPostgres(pool);
      if (!postgresReady) fail('PERSISTENT_PRODUCTION_AUTHORITIES_NOT_READY');
      const l3 = selection.l3 ? await L3Service.openExisting(pool, selection.l3.namespace) : undefined;
      const identity = createProductionRealtimeIdentityPort({
        clock: Object.freeze({now: () => assertCanonicalTimestamp(new Date().toISOString())}),
      });
      publicControl = await ports.createPublicOwner({
        pool, postgresReadiness: productionReadiness('T02.postgres', postgresReady),
        postgresPassword, identity, livekit, ownerProtection, secretFileReader, policy,
        productResources,
        // The historical preflight field is an input-owner port, not transcript evidence.
        inputReadiness: selection.inputReadiness!,
        executionOwner: 'hermes_text', central: l3 ? {...selection.central, l3} : selection.central,
        ...(selection.pcm ? {pcm: selection.pcm} : {}),
      });
      owner = new Phase0SharedSessionOwner({
        rayneoStandaloneSessionDurationMs: RAYNEO_STANDALONE_SESSION_DURATION_MS,
      });
      return Object.freeze({publicControl, launcherInput: Object.freeze({
        executionOwner: 'hermes_text' as const, owner, pool,
        environment: Object.freeze({PAIOS_DEMO_ROAMING: '1', PAIOS_GATE_A_LOCAL_DEVICE: '1',
          PAIOS_RAYNEO_LIVEKIT_URL: productResources.configuration.livekit_url,
          PAIOS_GATEWAY_OWNER_HOST: `127.0.0.1:${productResources.configuration.gateway_port ?? GATEWAY_PORT}`,
          ...(productResources.configuration.public_api_url ? {PAIOS_PUBLIC_API_URL: productResources.configuration.public_api_url} : {}),
          PAIOS_RAYNEO_PROXY_ATTESTATION_SECRET: livekit.proxyAttestationSecret}),
        pairingRegistry: new RayneoPairingRegistry({path:productResources.configuration.pairing_file}), inputReadiness: selection.inputReadiness!,
      })});
  } catch (error) {
    await publicControl?.centralTextAssembly?.close().catch(() => undefined);
    await publicControl?.gateway.adapter.close().catch(() => undefined);
    await publicControl?.persistentPublicPorts?.close().catch(() => undefined);
    await publicControl?.t02.publicControl.prebuiltT02Bundle.close().catch(() => undefined);
    await publicControl?.t03?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await sourceMedia?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    throw error;
  }
  } catch(error) {
    if(!selection.viduCleanup)await cleanup?.viduJournal.stop();
    throw error;
  }
}

/** Start one Gateway with the owner-composed production turn. */
export async function startRayneoPersistentProduction(
  input: HermesProductLauncherInput,
  options: RayneoPersistentProductionStartOptions = {},
): Promise<RayneoPersistentProductionHandle> {
  if (input === undefined || typeof input !== 'object') fail('PERSISTENT_HANDOFF_REQUIRED');
  const mode = options.executionOwner ?? input.executionOwner;
  if (mode !== 'hermes_text') fail('PUBLIC_EXECUTION_OWNER_INVALID');
  if (mode === 'hermes_text') {
    if (!('executionOwner' in input) || input.executionOwner !== 'hermes_text' ||
        !options.publicControl?.centralTextAssembly) fail('HERMES_EXECUTION_RESOURCES_CONFLICT');
    const binding = options.gatewayBinding ?? {host: LOOPBACK_HOST, port: GATEWAY_PORT};
    let control: RayneoPersistentPublicControlHandle | undefined;
    let native: Awaited<ReturnType<typeof startDemoRoamingGateway>> | undefined;
    try {
      if (options.centralListenPort !== undefined) {
        const server = options.publicControl.centralTextAssembly.server;
        check(!server.listening && Number.isSafeInteger(options.centralListenPort) && options.centralListenPort > 1024 &&
          options.centralListenPort < 65536 && options.centralListenPort !== binding.port, 'CENTRAL_LISTENER_INVALID');
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => {server.removeListener('listening', ready); reject(error);};
          const ready = () => {server.removeListener('error', failed); resolve();};
          server.once('error', failed); server.once('listening', ready);
          try {server.listen(options.centralListenPort, '127.0.0.1');}
          catch (error) {server.removeListener('error', failed); server.removeListener('listening', ready); reject(error);}
        });
      }
      control = await createRayneoPersistentPublicControl(options.publicControl);
      const boundControl = control;
      native = await startDemoRoamingGateway(input.owner, {
        environment: input.environment, listenerBinding: binding,
        installDemoSignalHandlers: false, publicRtcControl: control.controller,
        hermes: {gateway: options.publicControl.gateway,
          isReady: () => input.inputReadiness.isReady() && boundControl.composition.readiness().ready},
      });
    } catch (error) {
      await native?.close().catch(() => undefined);
      await control?.close().catch(() => undefined);
      if (!control) await options.publicControl.centralTextAssembly.close().catch(() => undefined);
      await input.owner.close().catch(() => undefined);
      await input.pool.end().catch(() => undefined);
      throw error;
    }
    const boundNative = native;
    const boundControl = control;
    let closeFlight: Promise<void> | undefined;
    return Object.freeze({host: boundNative.host, port: boundNative.port, close: () => closeFlight ??= withShutdownDrain(async () => {
      const failures: unknown[] = [];
      const settled=await Promise.allSettled([joinShutdown(()=>boundControl.close()),joinShutdown(()=>boundNative.close())]);
      for(const result of settled)if(result.status==='rejected')failures.push(result.reason);
      try{await joinShutdown(()=>input.pool.end());}catch(error){failures.push(error);}
      if (failures.length) throw new AggregateError(failures, 'PERSISTENT_GATEWAY_CLEANUP_FAILED');
    })});
  }
  fail('PUBLIC_EXECUTION_OWNER_INVALID');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/giu, '$1=<redacted>')
    .replace(/[A-Za-z0-9_-]{43,}/gu, value=>/^[A-Z]+(?:_[A-Z]+)+$/.test(value)?value:'<redacted>').slice(0, 200);
}

export function shutdownFailureDetails(error: unknown): string {
  const details = (failure: unknown): string[] => [safeError(failure),
    ...(failure instanceof AggregateError ? failure.errors.flatMap(details) : []),
    ...(failure instanceof Error && failure.cause !== undefined ? details(failure.cause) : [])];
  return details(error).join(' | ');
}

export interface ProductResourceConfiguration {
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password_file: string;
  };
  readonly livekit_url: string;
  readonly livekit_api_url?: string;
  readonly public_api_url?: string;
  readonly legacy_public_api_urls?: string;
  readonly gateway_host?: string;
  readonly gateway_port?: number;
  readonly avatar_url?: string;
  readonly avatar_token_file?: string;
  readonly video_call?:VideoCallConfiguration;
  readonly avatar_looks?:readonly AvatarLook[];
  readonly vidu_cleanup_key_file?:string;
  readonly call_rejoin_window_s?:number;
  readonly ride_hr_alert_bpm?:number;
  readonly movement_pending_ttl_ms?:number;
  readonly amap_key_file?:string;
  readonly owner_policy_file: string;
  readonly livekit_key_file: string;
  readonly livekit_secret_file: string;
  readonly proxy_file: string;
  readonly e2ee_file: string;
  readonly pairing_file: string;
  /** Owner-only directory the phone executor writes finished background errands into (optional). */
  readonly errand_spool_dir?: string;
  /** Bark phone notifications (optional, both or neither): the device URL file and the 32-character key file. */
  readonly bark_device_file?: string;
  readonly bark_key_file?: string;
  /** Staging outbound authority; notification, care outreach and SMS attempts are persisted here. */
  readonly staging_effect_sink_file?: string;
}

function assertStagingProductResources(configuration: ProductResourceConfiguration | undefined): void {
  if (process.env.PAIOS_STAGE !== 'staging') return;
  check(configuration?.staging_effect_sink_file !== undefined &&
    configuration.bark_device_file === undefined && configuration.bark_key_file === undefined &&
    configuration.avatar_url === undefined && configuration.video_call === undefined, 'PRODUCT_STAGING_EFFECT_BOUNDARY_REQUIRED');
}

/** Physical resources stay with the original product owner; no identity or credential translation. */
export function createConfiguredViduCleanup(configuration:ProductResourceConfiguration){
  if(!configuration)return undefined;
  const path=resolve(dirname(configuration.pairing_file),'vidu-live-sessions.json');
  const keyFile=configuration.vidu_cleanup_key_file??configuration.video_call?.api_key_file;
  if(keyFile===undefined&&!existsSync(path))return undefined;
  check(!configuration.video_call||!configuration.vidu_cleanup_key_file||configuration.video_call.api_key_file===keyFile,'PRODUCT_VIDU_CLEANUP_KEY_MISMATCH');
  check(isAbsolute(configuration.pairing_file)&&configuration.pairing_file===resolve(configuration.pairing_file),'PRODUCT_RESOURCE_PATH_INVALID');
  const viduJournal=createViduLiveJournal(path);
  check(keyFile!==undefined||!viduJournal.size,'PRODUCT_VIDU_CLEANUP_KEY_REQUIRED');
  if(keyFile===undefined)return undefined;
  check(isAbsolute(keyFile)&&keyFile===resolve(keyFile),'PRODUCT_RESOURCE_PATH_INVALID');
  assertAppleEnrollmentOwnerProtectedPath(keyFile);
  const viduApiKey=createPersistentPublicSecretFileReader().read(keyFile).toString('utf8').replace(/\r?\n$/u,'');
  check(viduApiKey.length>0&&!/[\s\u0000-\u001f\u007f]/u.test(viduApiKey),'PRODUCT_VIDU_KEY_INVALID');
  return Object.freeze({viduApiKey,viduJournal});
}
export function createConfiguredProductResources(configuration: ProductResourceConfiguration,cleanup?:ReturnType<typeof createConfiguredViduCleanup>) {
  check(configuration && typeof configuration === 'object', 'PRODUCT_RESOURCES_REQUIRED');
  assertStagingProductResources(configuration);
  const keys: readonly string[] = PRODUCT_RESOURCE_KEYS, optional: readonly string[] = PRODUCT_RESOURCE_OPTIONAL_KEYS;
  check(Object.keys(configuration).every(key => keys.includes(key) || optional.includes(key)) &&
    keys.every(key => Object.hasOwn(configuration, key)), 'PRODUCT_RESOURCES_INVALID');
  const absolute = (path: unknown) => typeof path === 'string' && isAbsolute(path) && path === resolve(path);
  check(configuration.errand_spool_dir === undefined || absolute(configuration.errand_spool_dir), 'PRODUCT_ERRAND_SPOOL_INVALID');
  check(configuration.call_rejoin_window_s===undefined||Number.isSafeInteger(configuration.call_rejoin_window_s)&&configuration.call_rejoin_window_s>0&&configuration.call_rejoin_window_s*1000<=2147483647,'PRODUCT_CALL_REJOIN_WINDOW_INVALID');
  check(configuration.movement_pending_ttl_ms===undefined||Number.isSafeInteger(configuration.movement_pending_ttl_ms)&&configuration.movement_pending_ttl_ms>0,'PRODUCT_MOVEMENT_PENDING_TTL_INVALID');
  check(configuration.ride_hr_alert_bpm===undefined||Number.isFinite(configuration.ride_hr_alert_bpm)&&configuration.ride_hr_alert_bpm>=20&&configuration.ride_hr_alert_bpm<=260,'PRODUCT_RIDE_HR_ALERT_INVALID');
  check((configuration.bark_device_file === undefined) === (configuration.bark_key_file === undefined) &&
    (configuration.bark_device_file === undefined || absolute(configuration.bark_device_file) && absolute(configuration.bark_key_file)),
    'PRODUCT_BARK_INVALID');
  check(configuration.staging_effect_sink_file === undefined || absolute(configuration.staging_effect_sink_file) &&
    configuration.bark_device_file === undefined, 'PRODUCT_STAGING_EFFECT_SINK_INVALID');
  check(typeof configuration.livekit_url === 'string' && URL.canParse(configuration.livekit_url), 'PRODUCT_LIVEKIT_URL_INVALID');
  const livekitUrl = new URL(configuration.livekit_url);
  check(livekitUrl.protocol === 'wss:' && !livekitUrl.username && !livekitUrl.password && !livekitUrl.search &&
    !livekitUrl.hash && livekitUrl.pathname === '/' && configuration.livekit_url === `wss://${livekitUrl.host}` &&
    configuration.livekit_url.length <= 253, 'PRODUCT_LIVEKIT_URL_INVALID');
  if (configuration.livekit_api_url !== undefined) assertCanonicalLiveKitApiUrl(configuration.livekit_api_url);
  if (configuration.public_api_url !== undefined) {
    check(typeof configuration.public_api_url === 'string' && URL.canParse(configuration.public_api_url), 'PRODUCT_PUBLIC_API_URL_INVALID');
    const url = new URL(configuration.public_api_url);
    check(url.protocol === 'https:' && url.origin === configuration.public_api_url, 'PRODUCT_PUBLIC_API_URL_INVALID');
  }
  const canonicalApiOrigin = configuration.public_api_url ?? `https://${livekitUrl.host}`;
  publicApiOrigins(canonicalApiOrigin, configuration.legacy_public_api_urls);
  check(configuration.gateway_host === undefined || ['127.0.0.1', '0.0.0.0'].includes(configuration.gateway_host), 'PRODUCT_GATEWAY_HOST_INVALID');
  check(configuration.gateway_port === undefined || Number.isSafeInteger(configuration.gateway_port) &&
    configuration.gateway_port > 1024 && configuration.gateway_port < 65536, 'PRODUCT_GATEWAY_PORT_INVALID');
  check((configuration.avatar_url === undefined) === (configuration.avatar_token_file === undefined), 'PRODUCT_AVATAR_TOKEN_FILE_REQUIRED');
  if (configuration.avatar_url !== undefined) {
    check(typeof configuration.avatar_url === 'string' && URL.canParse(configuration.avatar_url), 'PRODUCT_AVATAR_URL_INVALID');
    const url = new URL(configuration.avatar_url);
    check(url.protocol === 'https:' && url.origin === configuration.avatar_url, 'PRODUCT_AVATAR_URL_INVALID');
  }
  const video=configuration.video_call;
  if(video!==undefined)assertVideoCallConfiguration(video);
  if(configuration.avatar_looks!==undefined){
    check(Array.isArray(configuration.avatar_looks)&&configuration.avatar_looks.length<=32,'PRODUCT_AVATAR_LOOKS_INVALID');
    for(const look of configuration.avatar_looks)assertAvatarLook(look);
    check(new Set(configuration.avatar_looks.map(look=>look.look_id)).size===configuration.avatar_looks.length,'PRODUCT_AVATAR_LOOKS_INVALID');
  }
  const pg = configuration.postgres;
  check(pg && Object.keys(pg).sort().join(',') === 'database,host,password_file,port,user' &&
    [pg.host, pg.database, pg.user].every(value => typeof value === 'string' && value.length > 0) &&
    Number.isSafeInteger(pg.port) && pg.port > 0 && pg.port <= 65535, 'PRODUCT_POSTGRES_INVALID');
  const paths = keys.filter(key => key.endsWith('_file'))
    .map(key => configuration[key as keyof ProductResourceConfiguration] as string)
    .concat(pg.password_file, ...(configuration.avatar_token_file === undefined ? [] : [configuration.avatar_token_file]),...(video?[video.api_key_file]:[]),...(configuration.vidu_cleanup_key_file!==undefined&&configuration.vidu_cleanup_key_file!==video?.api_key_file?[configuration.vidu_cleanup_key_file]:[]));
  check(paths.every(path => typeof path === 'string' && isAbsolute(path) && path === resolve(path)) &&
    new Set(paths).size === paths.length, 'PRODUCT_RESOURCE_PATH_INVALID');
  const protectedPaths = new Set(paths.filter(path =>
    path !== configuration.pairing_file));
  const assertOwnerProtected = (path: string): void => {
    check(protectedPaths.has(path), 'PRODUCT_RESOURCE_PATH_UNKNOWN');
    assertAppleEnrollmentOwnerProtectedPath(path);
  };
  const ownerProtection: PersistentProductionOwnerProtectionPort = Object.freeze({
    assertOwnerProtected,
    isOwnerProtected: (path: string): boolean => {
      try {
        assertOwnerProtected(path);
        return true;
      } catch {
        return false;
      }
    },
  });
  const secretFileReader = createPersistentPublicSecretFileReader();
  for (const path of protectedPaths) assertOwnerProtected(path);
  const secretPaths: PersistentPublicSecretPaths = Object.freeze({
    livekitApiKey: configuration.livekit_key_file,
    livekitApiSecret: configuration.livekit_secret_file,
    proxyAttestation: configuration.proxy_file,
    e2eeRootKey: configuration.e2ee_file,
  });
  const resolver = createPersistentPublicSecretResolver(ownerProtection, secretFileReader, secretPaths);
  const policy = readOwnerPolicy(configuration.owner_policy_file);
  const postgresPassword = readProtectedTextFile(
    pg.password_file, 'PERSISTENT_PG_PASSWORD_REF_INVALID', secretFileReader, ownerProtection,
  );
  const livekit = readLiveKitCredentials(secretFileReader, ownerProtection, secretPaths);
  const avatarToken = configuration.avatar_token_file === undefined ? undefined : readProtectedTextFile(
    configuration.avatar_token_file, 'PRODUCT_AVATAR_TOKEN_INVALID', secretFileReader, ownerProtection);
  check(avatarToken === undefined || /^[A-Za-z0-9_-]{43}$/u.test(avatarToken) &&
    Buffer.from(avatarToken, 'base64url').toString('base64url') === avatarToken, 'PRODUCT_AVATAR_TOKEN_INVALID');
  const {viduApiKey,viduJournal}=cleanup??createConfiguredViduCleanup(configuration)??{};
  if(video)check(viduApiKey!==undefined&&(!configuration.vidu_cleanup_key_file||configuration.vidu_cleanup_key_file===video.api_key_file),'PRODUCT_VIDU_CLEANUP_KEY_MISMATCH');
  check(viduApiKey===undefined||!/[\s\u0000-\u001f\u007f]/u.test(viduApiKey),'PRODUCT_VIDU_KEY_INVALID');
  const videoCall=video&&Object.freeze({...video});
  // Original resolver retains value validation and lease release; readiness does not expose secrets.
  return Object.freeze({
    configuration: Object.freeze({...configuration, public_api_url: configuration.public_api_url ?? `https://${livekitUrl.host}`, postgres: Object.freeze({...pg}),
      ...(videoCall?{video_call:videoCall}:{})}),
    videoCall,
    policy,
    postgresPassword,
    livekit,
    avatarToken,
    viduApiKey,
    viduJournal,
    ownerProtection,
    secretFileReader,
    secretPaths,
    resolver,
  });
}

export interface HermesProductConfiguration extends CentralProvisionConfiguration {
  capability_packages?:import('../../../services/personal-aios-integration/src/capability/packages.ts').PackageSelection;
  timeline?:Omit<import('../../../services/personal-aios-integration/src/timeline.ts').TimelineOptions,'directory'|'queue'|'now'>;
  executionOwner: 'hermes_text';
  desktop?:{enabled?:boolean;relay?:Partial<import('./desktop-relay.ts').DesktopConfig['relay']>;files?:Partial<import('./desktop-relay.ts').DesktopConfig['files']>;queue?:import('../../../services/personal-aios-integration/src/timeline.ts').TimelineOptions['queue']};
  l3?: {namespace: string};
  product_resources: ProductResourceConfiguration;
  /** Formal microphone PCM on the one SDK reader; clock is the server-receipt estimate with explicit uncertainty.
   *  `input_contract: 'interval_v2'` with `continuous` (and `budget.archive_batch`) is the 24-hour ambient lane: ambient
   *  spans go to continuous MEDIA (the speech engine's own VAD) while push-to-talk voice windows keep the voice consumer. */
  pcm?: {media: unknown; producer: {device_type: 'phone' | 'glasses' | 'mac'; channel: string};
    budget: import('./personal-aios-formal-pcm.ts').PcmCaptureBudget; receipt_clock: {uncertainty_ms: number};
    input_contract?: 'frame_v1' | 'interval_v2';
    continuous?: {budget: import('../../../services/personal-aios-integration/src/media/continuous-source.ts').ContinuousBudget}};
}
const HERMES_PRODUCT_CONFIGURATION_FIELDS = Object.freeze({
  ...CENTRAL_PROVISION_CONFIGURATION_FIELDS, executionOwner:true, product_resources:true, l3:false, pcm:false,timeline:false,desktop:false,capability_packages:false,
} satisfies {[K in keyof HermesProductConfiguration]-?: {} extends Pick<HermesProductConfiguration,K> ? false : true});
export function configuredPcm(pcm: HermesProductConfiguration['pcm']) {
  if (pcm === undefined) return undefined;
  const keys = pcm !== null && typeof pcm === 'object' ? Object.keys(pcm) : [];
  check(['budget', 'media', 'producer', 'receipt_clock'].every(key => keys.includes(key)) &&
    keys.every(key => ['budget', 'media', 'producer', 'receipt_clock', 'input_contract', 'continuous'].includes(key)) &&
    pcm.producer && Object.keys(pcm.producer).sort().join(',') === 'channel,device_type' &&
    ['phone', 'glasses', 'mac'].includes(pcm.producer.device_type) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(pcm.producer.channel) &&
    pcm.receipt_clock && Object.keys(pcm.receipt_clock).join(',') === 'uncertainty_ms' &&
    (pcm.input_contract === undefined || ['frame_v1', 'interval_v2'].includes(pcm.input_contract)) &&
    (pcm.continuous === undefined || pcm.continuous !== null && typeof pcm.continuous === 'object' &&
      Object.keys(pcm.continuous).join(',') === 'budget' && pcm.continuous.budget !== null && typeof pcm.continuous.budget === 'object'),
    'PCM_CONFIGURATION_INVALID');
  // Budget values are checked by their owners (formal PCM reader, continuous source) before any capture starts.
  return {configuration: pcm.media, producer: {...pcm.producer}, budget: structuredClone(pcm.budget),
    input_contract: pcm.input_contract ?? 'frame_v1' as const,
    ...(pcm.continuous ? {continuous: {budget: structuredClone(pcm.continuous.budget)}} : {}),
    clock: createReceiptClockProvider({uncertainty_ms: pcm.receipt_clock.uncertainty_ms})};
}

// The existing whole-product owner consumes central provisioning; it never creates a second assembly.
export async function startConfiguredHermesProduct(config: HermesProductConfiguration, ports: {
  createHandoff: typeof createRayneoPersistentProductionHandoff;
  start: typeof startRayneoPersistentProduction;
  provision?: typeof provisionCentralResources;
  viduCleanup?:typeof createConfiguredViduCleanup;
} = {
  createHandoff: createRayneoPersistentProductionHandoff,
  start: startRayneoPersistentProduction,
}) {
  assertStagingProductResources(config.product_resources);
  check(config.executionOwner === 'hermes_text' && Object.keys(config).every(key => Object.hasOwn(HERMES_PRODUCT_CONFIGURATION_FIELDS,key)) &&
    Object.entries(HERMES_PRODUCT_CONFIGURATION_FIELDS).every(([key,required]) => !required || Object.hasOwn(config,key)),
    'HERMES_PRODUCT_CONFIGURATION_REQUIRED');
  check(config.l3 === undefined || (config.l3 !== null && typeof config.l3 === 'object' &&
    Object.keys(config.l3).join(',') === 'namespace' && isL3Namespace(config.l3.namespace)), 'L3_CONFIGURATION_INVALID');
  check(config.port !== (config.product_resources.gateway_port ?? GATEWAY_PORT) && config.port !== Number(new URL(config.hermes_base_url).port),
    'CENTRAL_LISTENER_PORT_CONFLICT');
  const pcm = configuredPcm(config.pcm);
  check(!config.voice_frontend || pcm, 'VOICE_FRONTEND_REQUIRES_PCM_SOURCE');
  const viduCleanup=(ports.viduCleanup??createConfiguredViduCleanup)(config.product_resources);
  try{await viduCleanup?.viduJournal.reconcile({apiKey:viduCleanup.viduApiKey});}
  catch{process.stderr.write('VIDU_RESTART_CLEANUP_FAILED\n');}
  let provision:Awaited<ReturnType<typeof provisionCentralResources>>;
  try{provision=await (ports.provision ?? provisionCentralResources)(config);}
  catch(error){await viduCleanup?.viduJournal.stop();throw error;}
  let handoff: RayneoPersistentProductionHandoff | undefined;
  let handle: RayneoPersistentProductionHandle | undefined;
  let stopped = false;
  try {
    // Settings, pairing and resume must remain available while inference is unavailable.
    // NativeClient reports model transport failures at request time; input readiness owns ING/D/L4.
    const native = provision.native;
    handoff = await ports.createHandoff({executionOwner: 'hermes_text', central: {...provision.resources,desktop:config.desktop,...(config.timeline?.enabled!==false&&config.timeline?{timeline:{...config.timeline,directory:resolve(config.storage_root,'timeline'),...(config.desktop?.queue?{queue:config.desktop.queue}:{})}}:{})}, product_resources:config.product_resources,viduCleanup,
      ...(pcm ? {pcm} : {}),
      ...(config.l3 ? {l3: config.l3} : {}),
      inputReadiness: {owner: 'configured-central-inputs-model-independent',
        isReady: () => !stopped && provision.resources.native === native}});
    handle = await ports.start(handoff.launcherInput, {executionOwner: 'hermes_text',
      publicControl: handoff.publicControl, centralListenPort: provision.port,
      gatewayBinding: {host: config.product_resources.gateway_host ?? LOOPBACK_HOST, port: config.product_resources.gateway_port ?? GATEWAY_PORT}});
    const close = createMainStop(handle, undefined, async () => {stopped = true;
      const settled=await Promise.allSettled([provision.release(),viduCleanup?.viduJournal.stop()]);
      const errors=settled.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'HERMES_PRODUCT_RELEASE_FAILED');
    },config.shutdown_drain_ms);
    return Object.freeze({...handle, centralPort: provision.port, skill_sha256: provision.skill_sha256, close});
  } catch (error) {
    stopped = true;
    const stop = createMainStop(handle ?? handoff?.publicControl.centralTextAssembly, undefined, provision.release,config.shutdown_drain_ms);
    try {await stop();} catch (cleanup) {throw new AggregateError([error, cleanup], 'HERMES_PRODUCT_STARTUP_FAILED', {cause: error});}
    finally{await viduCleanup?.viduJournal.stop();}
    throw error;
  }
}

async function main(): Promise<void> {
  const ownerArgument = process.argv.indexOf('--execution-owner');
  let handle: RayneoPersistentProductionHandle;
  if (ownerArgument >= 0) {
    check(process.argv[ownerArgument + 1] === 'hermes_text', 'PUBLIC_EXECUTION_OWNER_INVALID');
    const argument = process.argv.indexOf('--config');
    check(argument >= 0 && process.argv[argument + 1], 'HERMES_PRODUCT_CONFIG_REQUIRED');
    const {loadHostConfiguration} = await import('../../../services/personal-aios-integration/src/host-configuration.ts');
    const config = await loadHostConfiguration(process.argv[argument + 1]!) as HermesProductConfiguration;
    handle = await startConfiguredHermesProduct(config);
  } else {
    fail('HERMES_PRODUCT_CONFIG_REQUIRED');
  }
  const shutdown = (): void => { void handle.close().then(() => process.exit(0), (error: unknown) => {
    process.stderr.write(`SHUTDOWN_FAILED ${shutdownFailureDetails(error)}\n`);
    process.exit(1);
  }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => undefined);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
