/** Mac product setup and iPhone pairing. The paired_devices table is the one device authority (bearer, E2EE
 * recipient key, media, governance refs); this tool applies migrations through the ledgered migrator, keeps the gateway config free of any
 * second device identity, and pairs one iPhone from its exported registration. Secrets are never printed.
 *
 *   node tools/mac-product-provision.ts init --root <dir> --config <file>
 *   node tools/mac-product-provision.ts migrate --root <dir>
 *   node tools/mac-product-provision.ts config --root <dir>
 *   node tools/mac-product-provision.ts pair --root <dir> --registration <owner-only file>
 */
import { PRODUCT_RESOURCE_KEYS, PRODUCT_RESOURCE_OPTIONAL_KEYS } from '../src/product-resource-keys.ts';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { closePostgresPool, createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { migrateDatabase } from '../../../services/platform-data/src/schema-migrator.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import { loadHostConfiguration } from '../../../services/personal-aios-integration/src/host-configuration.ts';
import type { ProductResourceConfiguration } from '../src/rayneo-persistent-production-entrypoint.ts';
import { createRayneoLocalOwnerPolicyStore, parseConfiguredOwnerPolicy, RAYNEO_LOCAL_OWNER_POLICY_PATH } from '../src/rayneo-demo-owner-projection.ts';
import { pairDevice, revokePairedDevice } from '../src/paired-device-registration.ts';
import {releaseCoreProfile, coreProfileReleaseFailure} from '../src/core-profile-release.ts';
import {fileURLToPath} from 'node:url';
import {releaseSendConsents} from '../src/send-consent-release.ts';

const MIGRATIONS = resolve(fileURLToPath(new URL('../../../migrations', import.meta.url)));

function args(argv: string[]) {
  const [command, ...rest] = argv;
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw new Error('MAC_PROVISION_ARGUMENTS_INVALID');
    values.set(rest[i]!, rest[i + 1]!);
  }
  const root = values.get('--root');
  if (!root || resolve(root) !== root) throw new Error('MAC_PROVISION_ROOT_ABSOLUTE_REQUIRED');
  const configPath = values.get('--config') ?? join(root, 'mac-product.json');
  if (resolve(configPath) !== configPath) throw new Error('MAC_PROVISION_CONFIG_ABSOLUTE_REQUIRED');
  return { command, root, configPath, registration: values.get('--registration'),deviceId:values.get('--device-id') };
}
function assertOwnerOnly(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('MAC_PROVISION_FILE_NOT_OWNER_ONLY');
}
// Replace an owner-only file atomically; readers see the old or the new bytes, never a partial write.
function replaceOwnerFile(path: string, value: string) {
  const next = `${path}.next`;
  writeFileSync(next, value, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}
const readConfig = async (path: string) => await loadHostConfiguration(path) as {product_resources: ProductResourceConfiguration};
function pool(pg: ProductResourceConfiguration['postgres']) {
  assertOwnerOnly(pg.password_file);
  const password = readFileSync(pg.password_file, 'utf8').trim();
  return createPostgresPool({ host: pg.host, port: pg.port, database: pg.database, user: pg.user, password, max: 2 });
}

async function migrate(configPath: string) {
  const db = pool((await readConfig(configPath)).product_resources.postgres);
  try { return await migrateDatabase(db, MIGRATIONS); } finally { await closePostgresPool(db); }
}

async function init(root: string, configPath: string) {
  const resources = (await readConfig(configPath)).product_resources;
  const migrations = await migrate(configPath);
  const path = resources.owner_policy_file;
  mkdirSync(join(root, 'resources'), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Existing installations retain their policy bytes, including the legacy JSON formatting.
  if (existsSync(path)) {
    assertOwnerOnly(path);
    parseConfiguredOwnerPolicy(JSON.parse(readFileSync(path, 'utf8')));
    return { status: 'initialized', owner_policy: 'preserved', migrations };
  }
  const store = createRayneoLocalOwnerPolicyStore({
    path: RAYNEO_LOCAL_OWNER_POLICY_PATH,
    exists: () => existsSync(path),
    read: () => readFileSync(path),
    verifyProtectedAcl: () => assertOwnerOnly(path),
    createNewFlushedProtected: bytes => writeFileSync(path, bytes, { flag: 'wx', mode: 0o600, flush: true }),
  }, 'cloud-product-owner');
  // UUIDv7: 48-bit Unix milliseconds, version 7, random tail and the RFC 9562 variant.
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const policyDecisionRef = { ref: `local-owner-policy:${userId}` };
  const requestedCapabilities = ['realtime.audio', 'realtime.visual'];
  store.createOnce({ schema: 'paios.windows.local-owner.v1', userId, purpose: 'public_product_canary',
    policyDecisionRef, requestedCapabilities, revocable: true,
    governance: { purpose_scopes: ['public_product_canary'], policy_decision_refs: [policyDecisionRef],
      capability_grant_refs: requestedCapabilities } });
  return { status: 'initialized', owner_policy: 'created', migrations };
}

// The gateway reads device identity only from paired_devices; drop the retired T03/bearer/enrollment files and the
// voice device id so no config value can disagree with the paired device after re-pairing.
function config(path: string) {
  const current = JSON.parse(readFileSync(path, 'utf8'));
  assertOwnerOnly(path);
  const resources = current.product_resources;
  for (const key of PRODUCT_RESOURCE_KEYS) if (resources[key] === undefined) throw new Error(`MAC_PROVISION_RESOURCE_MISSING:${key}`);
  // Keep every key the entrypoint reads (required and optional capabilities); drop only retired ones.
  const kept: readonly string[] = [...PRODUCT_RESOURCE_KEYS, ...PRODUCT_RESOURCE_OPTIONAL_KEYS];
  const removed = Object.keys(resources).filter(key => !kept.includes(key));
  const next = { ...current, product_resources: Object.fromEntries(Object.entries(resources).filter(([key]) => kept.includes(key))),
    ...(current.formal_voice ? { formal_voice: { transport: current.formal_voice.transport } } : {}) };
  replaceOwnerFile(path, JSON.stringify(next, null, 2) + '\n');
  return { status: 'configured', removed_resources: removed, formal_voice_device_id_removed: current.formal_voice?.device_id !== undefined };
}

async function pair(root: string, configPath: string, registrationPath: string | undefined) {
  if (!registrationPath || resolve(registrationPath) !== registrationPath) throw new Error('MAC_PAIR_REGISTRATION_ABSOLUTE_REQUIRED');
  assertOwnerOnly(registrationPath);
  const resources = (await readConfig(configPath)).product_resources;
  // The installation's owner identity (also read by the local launcher) is the identity the first pairing adopts.
  const ownerUserId = JSON.parse(readFileSync(resources.owner_policy_file, 'utf8')).userId as string;
  const identity = createProductionRealtimeIdentityPort({ clock: { now: () => assertCanonicalTimestamp(new Date().toISOString()) } });
  const db = pool(resources.postgres);
  try {
    const pairing = await pairDevice({ pool: db, identity, registration: new Uint8Array(readFileSync(registrationPath)), ownerUserId,
      artifactDirectory: join(root, 'resources'),
      origin: resources.public_api_url! });
    const output = join(root, pairing.device_type ? `resources/${pairing.device_type}-pairing.${pairing.device_id}.v1.json` : 'resources/iphone-pairing.v1.json');
    const bytes = JSON.stringify(pairing) + '\n';
    if (!pairing.device_type) replaceOwnerFile(join(root, 'resources/iphone-pairing.v1.json'), bytes);
    return { status: 'paired', device_id: pairing.device_id, user_id: pairing.user_id, paired_at: pairing.paired_at, pairing_file: output,
      next: 'restart the gateway; it reads the active paired device at startup' };
  } finally { await closePostgresPool(db); }
}

async function revoke(configPath:string,deviceId:string|undefined) {
  if (!deviceId || !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(deviceId)) throw new Error('MAC_REVOKE_DEVICE_ID_REQUIRED');
  const resources=(await readConfig(configPath)).product_resources;
  assertOwnerOnly(resources.owner_policy_file);
  const ownerUserId=JSON.parse(readFileSync(resources.owner_policy_file,'utf8')).userId as string;
  const db=pool(resources.postgres);
  try {return await revokePairedDevice({pool:db,deviceId,ownerUserId});} finally {await closePostgresPool(db);}
}

const parsed = args(process.argv.slice(2));
try {
const result = parsed.command === 'init' ? await init(parsed.root, parsed.configPath)
  : parsed.command === 'migrate' ? {...await migrate(parsed.configPath), core_profile: await releaseCoreProfile(parsed.configPath, 'migrate'),
      send_consents:await releaseSendConsents(parsed.configPath)}
  : parsed.command === 'config' ? config(parsed.configPath)
  : parsed.command === 'pair' ? await pair(parsed.root, parsed.configPath, parsed.registration)
  : parsed.command === 'revoke' ? await revoke(parsed.configPath,parsed.deviceId)
  : (() => { throw new Error('MAC_PROVISION_COMMAND_INVALID'); })();
process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  if (parsed.command !== 'migrate') throw error;
  process.stdout.write(JSON.stringify({core_profile: coreProfileReleaseFailure(error)}) + '\n');
  process.exitCode = 1;
}
