import { makeMacProductResourceFixture } from './mac-product-resource-fixture.ts';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, mkdirSync, mkdtempSync } from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {createProductionRealtimeIdentityPort} from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import test from 'node:test';
import {createViduLiveJournal} from '../src/vidu-live-journal.ts';
import {CENTRAL_PROVISION_CONFIGURATION_FIELDS} from '../../../services/personal-aios-integration/src/main.ts';

import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from '../../../services/realtime-core/src/ports.ts';
import type { RealtimeExternalEffectCoordinatorPort } from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import type { RealtimePublicControlT02OwnerBundle } from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import { createProductionAuthorityFactory } from '../../../services/realtime-core/src/production-authority-factory.ts';
import {
  createProductionStructuralEquality,
  type ProductionPortRegistration,
} from '../../../services/realtime-core/src/production-owner-ports.ts';
import type {
  RealtimePublicControlPgCompositionOptions,
  RealtimePublicControlPgPrebuiltBorrowedOptions,
  V2CompositionReadinessInput,
  V2T11bOwnerPorts,
} from '../src/realtime-public-control-pg-composition.ts';
import {
  PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA,
} from '../src/realtime-public-control-persistent-bearer-authority.ts';
import {
  PERSISTENT_PROVIDER_READINESS_HORIZON_MS,
  createPersistentT03AuthorityRecordReader,
  createConfiguredProductResources,
  createConfiguredViduCleanup,
  passiveProviderReadiness,
  runPersistentAudioFinalization,
  startRayneoPersistentProduction,
  startConfiguredHermesProduct,
  shutdownFailureDetails,
  createRayneoPersistentProductionHandoff,
  createRayneoPersistentPublicControl,
  type RayneoPersistentPublicControlOwnerHandoff,
} from '../src/rayneo-persistent-production-entrypoint.ts';
import {fileURLToPath} from 'node:url';

const ENTRYPOINT = new URL('../src/rayneo-persistent-production-entrypoint.ts', import.meta.url);
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const PUBLIC_PATHS = Object.freeze([
  '/v1/realtime/bootstrap', '/v1/realtime/e2ee/key/resolve',
  '/v1/realtime/credentials/refresh', '/v1/realtime/media/stop',
  '/v1/realtime/end-continuity',
]);
const errorAsync = async (): Promise<never> => { throw new Error('OWNER_PORT_NOT_CALLED'); };

test('production handoff keeps the designated Watch authority for pair read, register, replace and revoke',async t=>{
  const scratch=fileURLToPath(new URL('../../../../../.scratch/',import.meta.url));
  mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'d5-watch-'));
  const resources=makeMacProductResourceFixture(root);t.after(()=>resources.cleanup());
  const identity=createProductionRealtimeIdentityPort({clock:{now:()=>new Date().toISOString() as never}});
  const userId='01952f00-0000-7000-8000-000000000501',deviceId='01952f00-0000-7000-8000-000000000502';
  const continuityId=identity.createContinuityId({userId,requestId:'watch-continuity'});
  const session=identity.createSessionRef({continuityId,userId,requestId:'watch-session'}) as Record<string,unknown>;
  const lease=identity.createDeviceLeaseRef({sessionRef:session as never,deviceId,requestId:'watch-primary'}) as Record<string,unknown>;
  const observedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
  const policy={ref_type:'PolicyDecision',ref_id:userId};
  const paired={device_id:deviceId,user_id:userId,device_class:'iphone',recipient_public_key:Buffer.alloc(32,7).toString('base64url'),
    device_credential_ref:{ref_type:'DeviceCredential',ref_id:deviceId},media:['data'],paired_at:observedAt,
    governance:{purpose_scopes:['cycling_assistant'],consent_record_refs:[{ref_type:'ConsentRecord',ref_id:userId}],
      policy_decision_refs:[policy],purpose_token_refs:[{ref_type:'PurposeToken',ref_id:userId}],
      capability_grant_refs:[{ref_type:'CapabilityGrant',ref_id:userId}]}};
  const primary={observed_at:observedAt,realtime_session_ref:session,session_object_version:'1',session_payload_sha256:session.canonical_payload_sha256,
    session_state:'active',continuity_state:'active',continuity_expires_at:expiresAt,active_device_lease_ref:lease,active_device_id:deviceId,
    session_user_id:userId,session_continuity_id:continuityId,session_continuity_ref:{},iphone_device_lease_ref:lease,
    iphone_lease_object_version:'1',iphone_lease_payload_sha256:lease.canonical_payload_sha256,iphone_session_ref:session,
    iphone_session_ref_id:session.ref_id,iphone_device_id:deviceId,iphone_state:'active',iphone_user_id:userId,
    iphone_continuity_id:continuityId,iphone_continuity_ref:{},iphone_expires_at:expiresAt,iphone_revocable:true,
    capabilities:['data'],purpose:'cycling_assistant',iphone_lease_version:'1',iphone_fencing_token:'1',policy_decision_ref:policy,
    capability_scope:{},purpose_scope:{},policy_binding:{}};
  const bindings:Record<string,any>[]=[],leases=new Map<string,Record<string,any>>(),ledger=new Map<string,Record<string,any>>();
  const primaryCalls:unknown[]=[];
  const query=async(sql:string,v:any[]=[])=>{
    let rows:Record<string,any>[]=[];
    if(sql.includes("FROM paired_devices WHERE status = 'active'"))rows=[paired];
    else if(sql.includes('FROM paired_devices WHERE device_id = $1')){primaryCalls.push(v[0]);rows=[{device_id:deviceId}];}
    else if(/^(?:BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|LISTEN |UNLISTEN )/u.test(sql))return {rows:[],rowCount:0};
    else if(sql.startsWith('SELECT s.user_id, il.device_id'))rows=v[0]===session.ref_id&&v[1]===lease.ref_id?[{user_id:userId,device_id:deviceId,realtime_session_ref:session,device_lease_ref:lease,observed_at:observedAt}]:[];
    else if(sql.includes('FROM realtime_sessions AS s'))rows=[primary];
    else if(sql.startsWith('INSERT INTO idempotency_ledger')){
      const row={scope:v[0],idempotency_key:v[1],request_hash:v[2],status:'in_flight'};ledger.set(v[1],row);rows=[row];
    }else if(sql.startsWith('UPDATE idempotency_ledger')){
      const row=ledger.get(v[1])!;Object.assign(row,{status:'committed',response:JSON.parse(v[2]),response_hash:v[3]});rows=[row];
    }else if(sql.startsWith('INSERT INTO outbox_events'))rows=[{event_id:v[0],aggregate_type:v[1],aggregate_id:v[2],event_type:v[3],event_version:v[4],
      idempotency_scope:v[5],idempotency_key:v[6],payload:JSON.parse(v[7]),payload_sha256:v[8],status:'pending',attempt_count:0}];
    else if(sql.startsWith('INSERT INTO device_leases')||sql.startsWith('INSERT INTO apple_physical_canary_bindings')){
      const match=/INSERT INTO \w+\s*\((.*?)\) VALUES \((.*?)\) RETURNING/u.exec(sql)!;
      const columns=match[1]!.split(',').map(s=>s.trim()),values=match[2]!.split(',').map(s=>s.trim());
      const row:Record<string,any>={released_at:null,revoked_at:null,companion_role:'watch'};
      for(let n=0;n<columns.length;n++){
        const value=values[n]!,parameter=/^\$(\d+)/u.exec(value);
        row[columns[n]!]=parameter?(value.includes('::jsonb')?JSON.parse(v[Number(parameter[1])-1]):v[Number(parameter[1])-1]):
          value==='TRUE'?true:value==="'active'"?'active':Number(value);
      }
      if(sql.startsWith('INSERT INTO device_leases'))leases.set(row.lease_ref_id,row);else bindings.unshift(row);
      rows=[row];
    }else if(sql.startsWith('SELECT binding_id FROM apple_physical_canary_bindings WHERE user_id'))rows=bindings.map(row=>({binding_id:row.binding_id}));
    else if(sql.startsWith('SELECT * FROM apple_physical_canary_bindings WHERE user_id'))rows=sql.includes('LIMIT 1')?bindings.slice(0,1):bindings;
    else if(sql.startsWith('SELECT * FROM apple_physical_canary_bindings WHERE session_ref_id'))rows=bindings.filter(row=>row.session_ref_id===v[0]&&row.iphone_lease_ref_id===v[1]&&row.state==='active');
    else if(/FROM device_leases (?:AS wl )?WHERE lease_ref_id/u.test(sql))rows=[leases.get(v[0])!];
    else if(sql.startsWith('UPDATE device_leases SET state = \'released\'')){
      Object.assign(leases.get(v[0])!,{state:'released',released_at:observedAt});return {rows:[],rowCount:1};
    }else if(sql.startsWith('UPDATE apple_physical_canary_bindings')){
      const row=bindings.find(row=>row.binding_id===v[0])!;
      if(sql.includes('SET state ='))Object.assign(row,{state:'revoked',revoked_at:observedAt,receipt_jcs:v[1],canonical_payload_sha256:v[2]});
      else Object.assign(row,{pair_version:v[1],receipt_jcs:v[2],canonical_payload_sha256:v[3],request_id:v[4],idempotency_key:v[5],request_fingerprint_sha256:v[6]});
      return {rows:[],rowCount:1};
    }else throw new Error('UNEXPECTED_TEST_SQL:'+sql);
    return {rows,rowCount:rows.length};
  };
  const pool={query,connect:async()=>Object.assign(new EventEmitter(),{query,release(){}}),end:async()=>undefined};
  const handoff=await createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources:resources.config,
    inputReadiness:{owner:'controlled-native',isReady:()=>true},central:{storage:new PosixStorage(join(root,'storage')),
      native:sourceClient({create:errorAsync,status:errorAsync,cancel:errorAsync}),skill:'controlled Watch skill',max_event_bytes:8192,max_read_bytes:8192,
      admission:{max_pending_events:2,max_pending_bytes:8192,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:10000,policy_version:'watch-test'},
      http:{internal_token:'controlled-watch-internal-key',max_request_bytes:8192,request_timeout_ms:1000}}},
    {createPool:()=>pool as never,inspectPostgres:async()=>true});
  const control=await createRayneoPersistentPublicControl({...handoff.publicControl,persistentPublicPorts:{...handoff.publicControl.persistentPublicPorts!,
    edge:{authorize:async()=>undefined},bearer:{authorize:async()=>({principal:userId,deviceId})},
    participant:{connect:errorAsync,disconnect:async()=>undefined,snapshot:()=>({connected:false,transportState:'disconnected'}),close:async()=>undefined} as never}});
  t.after(async()=>{await control.close();await handoff.launcherInput.owner.close();});
  const readWire={operation:'watch_binding',realtime_session_ref:session,iphone_device_lease_ref:lease};
  const route=async(wire:Record<string,unknown>,read=false,authenticated=true)=>{
    const bytes=Buffer.from(JSON.stringify(wire)),request=Readable.from([bytes]);
    Object.assign(request,{method:'POST',url:'/v1/realtime/watch-binding'+(read?'/read':''),socket:{remoteAddress:'127.0.0.1'},
      rawHeaders:['Content-Type','application/json','Content-Length',String(bytes.length),...(authenticated?['Authorization','Bearer controlled-watch-bearer']:[])]});
    let status=0,body='';const response={headersSent:false,writableEnded:false,writeHead(value:number){status=value;this.headersSent=true;},end(value:string){body=value;this.writableEnded=true;}};
    assert.equal(await control.controller.handle(request as never,response as never),true);
    return {status,body:JSON.parse(body)};
  };
  assert.deepEqual(await route(readWire,true),{status:200,body:{operation:'watch_binding',pair_state:{pair_version:'0',status:'absent',requires_rebind:false},binding:null}});
  assert.equal((await route(readWire,true,false)).status,401);
  assert.equal((await route({...readWire,action:'register'},true)).status,422);
  for(const changed of [
    {realtime_session_ref:identity.createSessionRef({continuityId,userId,requestId:'stale-session'})},
    {iphone_device_lease_ref:identity.createDeviceLeaseRef({sessionRef:session as never,deviceId,requestId:'wrong-lease'})},
  ])assert.deepEqual(await route({...readWire,...changed},true),{status:403,body:{error:'APPLE_FORMAL_WATCH_AUTHORITY_MISMATCH'}});
  for(const [index,action] of ['register','replace','revoke'].entries()){
    const wire={operation:'watch_binding',action,request_id:'watch-'+action,idempotency_key:'watch-'+action,realtime_session_ref:session,
      iphone_device_lease_ref:lease,expected_pair_version:String(index),...(action==='revoke'?{}:{installation_id:randomUUID(),ttl_seconds:600})};
    const result=await route(wire);assert.equal(result.status,200,JSON.stringify(result.body));const receipt=result.body.binding;
    assert.equal(receipt.pairVersion,String(index+1));assert.equal(receipt.status,action==='revoke'?'revoked':'active');
    assert.equal(receipt.iphone.deviceId,deviceId);assert.equal(receipt.principalRef,userId);
    assert.deepEqual(await route(readWire,true),{status:200,body:{operation:'watch_binding',
      pair_state:{pair_version:String(index+1),status:receipt.status,requires_rebind:action==='revoke'},binding:action==='revoke'?null:receipt}});
  }
  assert.deepEqual(primaryCalls,Array(9).fill(deviceId));
});

test('owner Mac relay configuration fails before paired-device listener allocation', async t => {
  const fixture = makeMacProductResourceFixture();
  t.after(fixture.cleanup);
  const previousRoot = process.env.PAIOS_OWNER_MAC_ROOT;
  const previousRelay = process.env.PAIOS_OWNER_MAC_RELAY_FILE;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PAIOS_OWNER_MAC_ROOT; else process.env.PAIOS_OWNER_MAC_ROOT = previousRoot;
    if (previousRelay === undefined) delete process.env.PAIOS_OWNER_MAC_RELAY_FILE; else process.env.PAIOS_OWNER_MAC_RELAY_FILE = previousRelay;
  });
  process.env.PAIOS_OWNER_MAC_ROOT = join(fixture.root, 'owner-mac');
  const malformed = join(fixture.root, 'malformed-relay.json');
  writeFileSync(malformed, '{invalid json');
  for (const relay of [join(fixture.root, 'missing-relay.json'), malformed]) {
    process.env.PAIOS_OWNER_MAC_RELAY_FILE = relay;
    const queries: string[] = [];
    let borrowed = 0, ended = 0;
    const query = async (sql: string) => { queries.push(sql); return {rows: [], rowCount: 0}; };
    const pool = {query, connect: async () => {
      borrowed++;
      return Object.assign(new EventEmitter(), {query, release() { borrowed--; }});
    }, end: async () => { ended++; }};
    await assert.rejects(createRayneoPersistentProductionHandoff({
      executionOwner: 'hermes_text', product_resources: fixture.config, central: {} as never,
      inputReadiness: {owner: 'fixture', isReady: () => true},
    }, {createPool: () => pool as never, inspectPostgres: async () => true}), error => {
      if (relay === malformed) assert.ok(error instanceof SyntaxError);
      else assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });
    assert.deepEqual(queries, [], 'configuration failure must precede paired-device authority reads and LISTEN');
    assert.equal(borrowed, 0);
    assert.equal(ended, 1, 'the outer handoff must release its pool after configuration failure');
  }
});

test('staging startup rejects missing sink, Bark and avatar before provisioning', async () => {
  const previous = process.env.PAIOS_STAGE;
  process.env.PAIOS_STAGE = 'staging';
  const fixture = makeMacProductResourceFixture();
  try {
    await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text'} as never), /PRODUCT_STAGING_EFFECT_BOUNDARY_REQUIRED/);
    for (const product_resources of [fixture.config,
      { ...fixture.config, staging_effect_sink_file: `${fixture.root}/effects`, bark_device_file: `${fixture.root}/bark`, bark_key_file: `${fixture.root}/key` },
      { ...fixture.config, staging_effect_sink_file: `${fixture.root}/effects`, avatar_url: 'https://avatar.invalid' },
    ]) {
      await assert.rejects(startConfiguredHermesProduct({ product_resources } as never), /PRODUCT_STAGING_EFFECT_BOUNDARY_REQUIRED/);
      assert.throws(() => createConfiguredProductResources(product_resources), /PRODUCT_STAGING_EFFECT_BOUNDARY_REQUIRED/);
    }
    assert.equal(createConfiguredProductResources({ ...fixture.config,
      staging_effect_sink_file: `${fixture.root}/effects` }).configuration.staging_effect_sink_file, `${fixture.root}/effects`);
  } finally {
    fixture.cleanup();
    if (previous === undefined) delete process.env.PAIOS_STAGE; else process.env.PAIOS_STAGE = previous;
  }
});

test('avatar requires a paired owner-protected canonical token and an HTTPS origin',()=>{
  const fixture=makeMacProductResourceFixture();
  const avatar_url='https://configured-avatar.invalid:9443', avatar_token_file=`${fixture.root}/avatar-token`;
  const token=Buffer.alloc(32,7).toString('base64url');
  const config={...fixture.config,avatar_url,avatar_token_file};
  try{
    assert.equal(createConfiguredProductResources(fixture.config).avatarToken,undefined);
    assert.throws(()=>createConfiguredProductResources({...fixture.config,avatar_url}),/PRODUCT_AVATAR_TOKEN_FILE_REQUIRED/);
    assert.throws(()=>createConfiguredProductResources({...fixture.config,avatar_token_file}),/PRODUCT_AVATAR_TOKEN_FILE_REQUIRED/);
    assert.throws(()=>createConfiguredProductResources({...config,avatar_token_file:'secrets/avatar-token'}),/PRODUCT_RESOURCE_PATH_INVALID/);
    assert.throws(()=>createConfiguredProductResources({...config,avatar_token_file:fixture.config.e2ee_file}),/PRODUCT_RESOURCE_PATH_INVALID/);
    assert.throws(()=>createConfiguredProductResources(config));
    writeFileSync(avatar_token_file,token+'\n',{mode:0o600});
    const resources=createConfiguredProductResources(config);
    assert.equal(resources.configuration.avatar_url,avatar_url);
    assert.equal(resources.configuration.avatar_token_file,avatar_token_file);
    assert.equal(resources.avatarToken,token);
    assert.equal(resources.ownerProtection.isOwnerProtected(avatar_token_file),true);
    assert.equal(resources.ownerProtection.isOwnerProtected(`${fixture.root}/unknown`),false);
    for(const invalid of ['not a URL','http://avatar.invalid','https://avatar.invalid/call','https://user:pass@avatar.invalid'])
      assert.throws(()=>createConfiguredProductResources({...config,avatar_url:invalid}),/PRODUCT_AVATAR_URL_INVALID/);
    chmodSync(avatar_token_file,0o644);assert.throws(()=>createConfiguredProductResources(config),/OWNER_ACL_INVALID/);
    chmodSync(avatar_token_file,0o600);
    for(const invalid of ['short','A'.repeat(42)+'!', 'A'.repeat(42)+'B']) {
      writeFileSync(avatar_token_file,invalid);
      assert.throws(()=>createConfiguredProductResources(config),/PRODUCT_AVATAR_TOKEN_INVALID/);
    }
    rmSync(avatar_token_file);symlinkSync(fixture.config.e2ee_file,avatar_token_file);
    assert.throws(()=>createConfiguredProductResources(config),/OWNER_FILE_INVALID/);
  }finally{fixture.cleanup();}
});

test('enabled video requires the component contract and a protected key; absence explicitly disables it',()=>{
  const fixture=makeMacProductResourceFixture(),path=`${fixture.root}/vidu-key`;
  const video_call={provider:'vidu_component' as const,api_key_file:path,base_url:'https://video.invalid',avatar_id:'operator-asset',component_model:'configured-component-model',action_library_id:'operator-library'};
  try{
    writeFileSync(path,'offline-vidu-key\n',{mode:0o600});
    const resources=createConfiguredProductResources({...fixture.config,video_call});
    assert.equal(resources.viduApiKey,'offline-vidu-key');assert.deepEqual(resources.videoCall,video_call);
    assert.equal(createConfiguredProductResources(fixture.config).videoCall,undefined);
    const mac={...JSON.parse(readFileSync(new URL('../../../../../deploy/mac-product/mac-product.json',import.meta.url),'utf8')).product_resources.video_call,api_key_file:path};
    assert.deepEqual(createConfiguredProductResources({...fixture.config,video_call:mac}).videoCall,mac,'frozen Mac assets retain a valid component provider');
    assert.equal(createConfiguredProductResources({...fixture.config,video_call,vidu_cleanup_key_file:path}).viduApiKey,'offline-vidu-key');
    for(const provider of ['vidu_realtime','other'])
      assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call:{...video_call,provider} as never}),/PRODUCT_VIDEO_PROVIDER_UNSUPPORTED/);
    for(const field of ['component_model','action_library_id','avatar_id','api_key_file','base_url'])
      for(const value of [undefined,''])
        assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call:{...video_call,[field]:value} as never}),/PRODUCT_VIDEO_/);
    // Retired realtime fields cannot suggest another speech, retrieval or WebSocket authority.
    for(const field of ['model','voice','websocket_url','vad_type','retrieval_base_url'])
      assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call:{...video_call,[field]:'retired'} as never}),/PRODUCT_VIDEO_CALL_INVALID/);
    assert.equal(resources.ownerProtection.isOwnerProtected(path),true);
    chmodSync(path,0o644);assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call}),/OWNER_ACL_INVALID/);chmodSync(path,0o600);
    for(const invalid of [{base_url:'relative'},{base_url:'http://video.invalid'},{base_url:'https://video.invalid/private'},
      {base_url:'https://user:pass@video.invalid'},{base_url:'https://VIDEO.invalid'},{idle_timeout_seconds:0},{max_call_seconds:0},{api_key_file:'relative.key'},{extra:true}])
      assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call:{...video_call,...invalid} as never}),/PRODUCT_VIDEO_/);
    writeFileSync(path,'key\nwith-header-injection');assert.throws(()=>createConfiguredProductResources({...fixture.config,video_call}),/PRODUCT_VIDU_KEY_INVALID/);
  }finally{fixture.cleanup();}
});

test('passive provider readiness covers the frozen capability window and remains bounded', async () => {
  const now = 1_900_000_000_000;
  const readiness = passiveProviderReadiness({} as never, true, () => now);
  const started = await readiness.start();
  assert.deepEqual(started, { ready: true, validThroughMs: now + PERSISTENT_PROVIDER_READINESS_HORIZON_MS });
  assert.equal(PERSISTENT_PROVIDER_READINESS_HORIZON_MS, 2_110_000);
  assert.deepEqual(readiness.inspect(now + 2_105_000), {
    ready: true,
    validThroughMs: now + PERSISTENT_PROVIDER_READINESS_HORIZON_MS,
  });
  assert.equal(readiness.inspect(now + PERSISTENT_PROVIDER_READINESS_HORIZON_MS).ready, true);
  assert.equal(readiness.inspect(now + PERSISTENT_PROVIDER_READINESS_HORIZON_MS + 1).ready, false);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, now + 0.5]) {
    assert.equal(readiness.inspect(invalid).ready, false);
  }
  readiness.close();
  assert.deepEqual(readiness.inspect(now), { ready: false, validThroughMs: 0 });
  await assert.rejects(readiness.start(), /PERSISTENT_PROVIDER_NOT_READY/u);

  const unavailable = passiveProviderReadiness({} as never, false, () => now);
  assert.equal(unavailable.inspect(now + 2_105_000).ready, false);
  await assert.rejects(unavailable.start(), /PERSISTENT_PROVIDER_NOT_READY/u);
});

test('persistent audio finalization orders T04 before turn and always releases evidence state', async () => {
  const success: string[] = [];
  await runPersistentAudioFinalization({
    evidenceKey: 'segment-evidence-1',
    recordUserAction: async () => { success.push('t04:segment-1'); },
    afterFinalTranscript: async () => { success.push('turn:segment-1'); },
    releaseCommit: (key) => { success.push(`release:${key}`); },
  });
  assert.deepEqual(success, ['t04:segment-1', 'turn:segment-1', 'release:segment-evidence-1']);
  const failure: string[] = [];
  await assert.rejects(runPersistentAudioFinalization({
    evidenceKey: 'segment-evidence-2',
    recordUserAction: async () => { failure.push('t04:segment-2'); throw new Error('T04_FAILED'); },
    afterFinalTranscript: async () => { failure.push('turn:segment-2'); },
    releaseCommit: (key) => { failure.push(`release:${key}`); },
  }), /T04_FAILED/u);
  assert.deepEqual(failure, ['t04:segment-2', 'release:segment-evidence-2']);
});

test('T03 record reader uses the supplied configured path and reads its real bytes', () => {
  const f = makeMacProductResourceFixture();
  try {
    const path = f.config.owner_policy_file;
    const reader = createPersistentT03AuthorityRecordReader(path);
    assert.equal(reader.path, path);
    assert.deepEqual(reader.read(), readFileSync(path));
  } finally { f.cleanup(); }
});

function injectedInput(end: () => Promise<void>): object {
  return Object.freeze({
    pool: Object.freeze({ end }),
  });
}


for(const gate of ['native','provision'] as const)test(`retained Vidu cleanup precedes failed ${gate} with enabled and disabled video`,async t=>{
  const f=makeMacProductResourceFixture();t.after(f.cleanup);
  const key=join(f.root,'vidu-key');writeFileSync(key,'offline-fixture-key',{mode:0o600});
  const video_call={provider:'vidu_component' as const,api_key_file:key,avatar_id:'fixture',base_url:'https://renderer.invalid',component_model:'fixture',action_library_id:'fixture'};
  for(const video of [video_call,undefined]){
    const product_resources={...f.config,vidu_cleanup_key_file:key,...(video?{video_call:video}:{})};
    const cleanup=createConfiguredViduCleanup(product_resources)!;cleanup.viduJournal.remember('https://renderer.invalid','retained-id');
    let queries=0,releases=0,provisions=0;
    const reconcile=cleanup.viduJournal.reconcile;
    cleanup.viduJournal.reconcile=options=>reconcile({...options,connect:()=>({readyState:3}) as never,
      fetch:async()=>{queries++;return Response.json({live:{status:'ended',billed_seconds:1,credits_cost:0}});}});
    const config={...Object.fromEntries(Object.entries(CENTRAL_PROVISION_CONFIGURATION_FIELDS).filter(([,required])=>required).map(([key])=>[key,1])),
      executionOwner:'hermes_text',product_resources,port:18091,hermes_base_url:'http://127.0.0.1:18191'} as never;
    await assert.rejects(startConfiguredHermesProduct(config,{viduCleanup:()=>cleanup,
      createHandoff:async()=>{throw new Error('UNEXPECTED_HANDOFF');},start:async()=>{throw new Error('UNEXPECTED_START');},
      provision:async()=>{provisions++;assert.equal(queries,1);assert.equal(cleanup.viduJournal.size,0);
        if(gate==='provision')throw new Error('CONTROLLED_PROVISION_FAILURE');
        return {native:{ready:async()=>false},resources:{},release:async()=>{releases++;}} as never;}}),
      gate==='native'?/UNEXPECTED_HANDOFF/:/CONTROLLED_PROVISION_FAILURE/);
    assert.equal(queries,1);assert.equal(provisions,1);assert.equal(releases,gate==='native'?1:0);
  }
});

test('disabled video retains cleanup key and rejects stranded nonempty ownership',async t=>{
  const f=makeMacProductResourceFixture();t.after(f.cleanup);const path=join(f.root,'pairing','vidu-live-sessions.json');
  createViduLiveJournal(path).remember('https://renderer.invalid','retained-id');
  assert.throws(()=>createConfiguredViduCleanup(f.config),/PRODUCT_VIDU_CLEANUP_KEY_REQUIRED/);
  const key=join(f.root,'vidu-key');writeFileSync(key,'offline-fixture-key',{mode:0o600});
  const configuration={...f.config,vidu_cleanup_key_file:key},cleanup=createConfiguredViduCleanup(configuration)!;
  const resources=createConfiguredProductResources(configuration,cleanup);assert.equal(resources.viduJournal,cleanup.viduJournal);
  assert.equal(resources.videoCall,undefined);assert.equal(resources.viduJournal?.size,1);assert.equal(resources.viduApiKey,'offline-fixture-key');
  assert.equal(resources.ownerProtection.isOwnerProtected(key),true);
  await resources.viduJournal!.reconcile({apiKey:resources.viduApiKey!,connect:()=>({readyState:3}) as never,
    fetch:async()=>Response.json({live:{status:'ended',billed_seconds:1,credits_cost:0}})});
  assert.equal(resources.viduJournal!.size,0);
});


test('startup terminal verification failure retains one retry owner while product runs',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const f=makeMacProductResourceFixture();t.after(f.cleanup);const key=join(f.root,'vidu-key');writeFileSync(key,'offline-fixture-key',{mode:0o600});
  const product_resources={...f.config,vidu_cleanup_key_file:key};const cleanup=createConfiguredViduCleanup(product_resources)!;
  cleanup.viduJournal.remember('https://renderer.invalid','retained-id');let terminal=false,queries=0,releases=0,closed=0,owners=0;
  const reconcile=cleanup.viduJournal.reconcile;
  cleanup.viduJournal.reconcile=options=>reconcile({...options,connect:()=>({readyState:3}) as never,
    fetch:async()=>{queries++;return Response.json({live:{status:terminal?'ended':'active',billed_seconds:1,credits_cost:0}});}});
  const config={...Object.fromEntries(Object.entries(CENTRAL_PROVISION_CONFIGURATION_FIELDS).filter(([,required])=>required).map(([key])=>[key,1])),
    executionOwner:'hermes_text',product_resources,port:18091,hermes_base_url:'http://127.0.0.1:18191'} as never;
  const starting=startConfiguredHermesProduct(config,{viduCleanup:()=>{owners++;return cleanup;},
    provision:async()=>({native:{ready:async()=>true},resources:{},release:async()=>{releases++;}}) as never,
    createHandoff:async selection=>{assert.equal(selection.viduCleanup,cleanup);return {launcherInput:{},publicControl:{}} as never;},
    start:async()=>({close:async()=>{closed++;}}) as never});
  for(let n=0;n<21;n++){await new Promise(setImmediate);if(n<20)t.mock.timers.tick(1000);}const handle=await starting;
  t.after(()=>handle.close());assert.equal(queries,21);assert.equal(cleanup.viduJournal.size,1);assert.equal(owners,1);assert.equal(releases,0);
  terminal=true;t.mock.timers.tick(29999);await new Promise(setImmediate);assert.equal(queries,21);
  t.mock.timers.tick(1);await new Promise(setImmediate);assert.equal(queries,22);assert.equal(cleanup.viduJournal.size,0);
  await handle.close();assert.equal(closed,1);assert.equal(releases,1);
});


test('failed direct handoff stops only its internally owned retained cleanup timer',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const f=makeMacProductResourceFixture();t.after(f.cleanup);
  const key=join(f.root,'vidu-key');writeFileSync(key,'offline-fixture-key',{mode:0o600});
  const product_resources={...f.config,vidu_cleanup_key_file:key};let queries=0;
  // Invalid transport origin prevents socket creation; HTTP is fully fixture-owned.
  createViduLiveJournal(join(f.root,'pairing','vidu-live-sessions.json')).remember('invalid-origin','retained-id');
  t.mock.method(globalThis,'fetch',async()=>{queries++;return Response.json({live:{status:'active',billed_seconds:1,credits_cost:0}});});
  const failing=assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources,
    inputReadiness:{owner:'fixture',isReady:()=>false}} as never),/HERMES_INPUT_OWNER_NOT_READY/);
  for(let n=0;n<21;n++){await new Promise(setImmediate);if(n<20)t.mock.timers.tick(1000);}await failing;
  assert.equal(queries,21);t.mock.timers.tick(30000);await new Promise(setImmediate);assert.equal(queries,21);
  const external=createConfiguredViduCleanup(product_resources)!;let stops=0;
  t.mock.method(external.viduJournal,'stop',async()=>{stops++;});
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources,viduCleanup:external,
    inputReadiness:{owner:'fixture',isReady:()=>false}} as never),/HERMES_INPUT_OWNER_NOT_READY/);
  assert.equal(stops,0);
});


test('whole product shutdown retains provisioning lock after a stuck handle within its shared budget',async t=>{
  const {acquireProcessLock}=await import('../../../services/personal-aios-integration/src/process-lock.ts');
  const f=makeMacProductResourceFixture(),path=join(f.root,'shutdown-owner.lock');
  const release=await acquireProcessLock(path),gate=Promise.withResolvers<void>();
  t.after(async()=>{gate.resolve();await new Promise(setImmediate);await release();f.cleanup();});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  let journalStops=0,releases=0,closes=0;
  const cleanup={viduApiKey:'fixture-key',viduJournal:{reconcile:async()=>{},stop:async()=>{journalStops++;}}} as never;
  const config={...Object.fromEntries(Object.entries(CENTRAL_PROVISION_CONFIGURATION_FIELDS).filter(([,required])=>required).map(([key])=>[key,1])),
    executionOwner:'hermes_text',shutdown_drain_ms:105000,product_resources:{gateway_port:18787},port:18091,hermes_base_url:'http://127.0.0.1:18191'} as never;
  const handle=await startConfiguredHermesProduct(config,{viduCleanup:()=>cleanup,
    provision:async()=>({native:{ready:async()=>true},resources:{},release:async()=>{releases++;await release();}}) as never,
    createHandoff:async()=>({launcherInput:{},publicControl:{}}) as never,
    start:async()=>({close:async()=>{closes++;await gate.promise;}}) as never});
  const closing=assert.rejects(handle.close(),error=>{
    assert.ok(error instanceof AggregateError);assert.equal(error.message,'MAIN_SHUTDOWN_FAILED');
    assert.deepEqual(error.errors.map((cause:Error)=>cause.message),['SHUTDOWN_DRAIN_EXPIRED','SHUTDOWN_OWNERS_UNSETTLED']);return true;
  });
  await new Promise(setImmediate);assert.equal(closes,1);t.mock.timers.tick(89999);await new Promise(setImmediate);assert.equal(releases,0);
  t.mock.timers.tick(1);await closing;assert.equal(releases,0);assert.equal(journalStops,0);
  await assert.rejects(acquireProcessLock(path),/PERSONAL_AIOS_ALREADY_RUNNING/);
  gate.resolve();await new Promise(setImmediate);assert.equal(releases,0);assert.equal(journalStops,0);
  await assert.rejects(acquireProcessLock(path),/PERSONAL_AIOS_ALREADY_RUNNING/);
});

test('call rejoin configuration accepts explicit safe seconds and rejects invalid timer ranges',()=>{
  const f=makeMacProductResourceFixture();try{
    assert.equal(createConfiguredProductResources({...f.config,call_rejoin_window_s:120}).configuration.call_rejoin_window_s,120);
    for(const value of [0,-1,0.5,NaN,Infinity,2147484])assert.throws(()=>createConfiguredProductResources({...f.config,call_rejoin_window_s:value}),/PRODUCT_CALL_REJOIN_WINDOW_INVALID/);
  }finally{f.cleanup();}
});


test('shutdown failure details retain nested owner failures and error causes with redaction',()=>{
  const first=new Error('CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE');
  const second=new Error('archive publish',{cause:new Error('EIO token=private-token')});
  const owners=new AggregateError([first,second],'PERSISTENT_PUBLIC_EXECUTION_CLEANUP_FAILED');
  const product=new Error('PERSISTENT_PUBLIC_CONTROL_OWNER_CLEANUP_FAILED',{cause:owners});
  assert.equal(shutdownFailureDetails(product),
    'PERSISTENT_PUBLIC_CONTROL_OWNER_CLEANUP_FAILED | PERSISTENT_PUBLIC_EXECUTION_CLEANUP_FAILED | CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE | archive publish | EIO token=<redacted>');
});
