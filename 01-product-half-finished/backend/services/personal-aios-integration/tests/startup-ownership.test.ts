import {loadHostConfiguration} from '../src/host-configuration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {fakeSpeechConfig} from './speech-fixture.ts';
import {main, createMainStop, provisionCentralResources, type CentralProvisionConfiguration} from '../src/main.ts';
import {openFixtureDatabase} from '../src/memory/fixture-database.ts';
import {fileURLToPath} from 'node:url';

type Dependencies = NonNullable<Parameters<typeof main>[0]>;
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'startup-owner-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.writeFile(join(root,'key'), 'controlled-fixture-secret-123456789', {mode:0o600});
  await fs.writeFile(join(root,'skill'), 'fixed skill');
  await fs.writeFile(join(root,'migration'),await fs.readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url)));
  const config = {mode:'isolated_fixture',port:18899,storage_root:join(root,'storage'),lock_file:join(root,'lock'),
    hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),hermes_base_url:'http://127.0.0.1:1',
    native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:1000,max_event_bytes:1000,max_read_bytes:1000,
    admission:{},devices:[],fixture_database:{url:'postgresql://l3test@127.0.0.1:55439/postgres',schema:'paios_fixture_owner',migration_file:join(root,'migration')},
    local_note_actions:{local_notes_root:join(root,'notes')},media_replay:{fixture_only:true,
      stream_budget:{max_chunk_bytes:1000,max_total_bytes:10000,max_chunks:10,max_revisions:10,max_seq:10},
      alignment:{max_chunks:10,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},
      processing:{policy_version:'controlled',max_inflight:2,max_input_bytes:10000,timeout_ms:1000,allow_external:false,allow_replay:true,allow_partial:true},max_segments:10,max_window_ms:1000,audio:{provider:'local_sherpa',config:fakeSpeechConfig()}}};
  await fs.writeFile(join(root,'config'), JSON.stringify(config));
  return {root,config};
}
for (const phase of ['media','database','schema','assembly','listen'] as const) {
  test(`actual main startup ${phase} failure closes only acquired owners then removes lock`, async t => {
    const f = await fixture(t), events:string[] = [], primary = new Error(`PRIMARY_${phase}`);
    const media = {service:{close:async()=>{events.push('media.close');}},archive:{}};
    const database = {pool:{},l3:{},close:async()=>{events.push('database.close');}};
    const assembly = {server:{on:()=>{},listen:()=>{throw primary;}},close:async()=>{events.push('assembly.close');}};
    const dependencies = {
      configureMediaReplay:async()=>{events.push('media');if(phase==='media')throw primary;return media;},
      openFixtureDatabase:async()=>{events.push('database');if(phase==='database')throw primary;return database;},
      initializeActionSchema:async()=>{events.push('schema');if(phase==='schema')throw primary;},
      createPersonalAIOSAssembly:()=>{events.push('assembly');if(phase==='assembly')throw primary;return assembly;},
    } as unknown as Dependencies;
    const previous = process.argv;process.argv=[process.execPath,'test','--config',join(f.root,'config')];
    try {await assert.rejects(main(dependencies), error=>error===primary);} finally {process.argv=previous;}
    await assert.rejects(fs.stat(f.config.lock_file), {code:'ENOENT'});
    const close = events.filter(e=>e.endsWith('.close'));
    assert.deepEqual(close,phase==='media'?[]:phase==='database'?['media.close']:phase==='listen'?['assembly.close','database.close']:['media.close','database.close']);
  });
}
for (const phase of ['storage','native','tts','tts-constructor'] as const) {
  test(`actual startup synchronous ${phase} construction failure releases acquired owners`,async t=>{
    const f=await fixture(t),events:string[]=[];
    const config: Record<string,unknown>={...f.config};
    if(phase==='storage')config.storage_root=null;
    if(phase==='native')config.native_request_timeout_ms=0;
    if(phase==='tts')config.tts={provider:'unsupported'};
    if(phase==='tts-constructor')config.tts={provider:'dashscope',model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050};
    await fs.writeFile(join(f.root,'config'),JSON.stringify(config));
    const dependencies={configureMediaReplay:async()=>({service:{close:async()=>{events.push('media.close');}},archive:{}}),
      openFixtureDatabase:async()=>({pool:{},l3:{},close:async()=>{events.push('db.close');}}),
      initializeActionSchema:async()=>{},createPersonalAIOSAssembly:()=>{throw new Error('unexpected assembly');}} as unknown as Dependencies;
    const previous=process.argv;process.argv=[process.execPath,'test','--config',join(f.root,'config')];
    try {await assert.rejects(main(dependencies), error=>phase==='storage'?error instanceof TypeError:
      error instanceof Error&&error.message===(phase==='native'?'INVALID_HERMES_CONFIG':phase==='tts-constructor'?'TTS_VOICE_FRONTEND_REQUIRED':'TTS_PROVIDER_NOT_CONFIGURED'));}
    finally {process.argv=previous;}
    // TTS now belongs to central provisioning; invalid config/construction precedes MEDIA/DB allocation.
    assert.deepEqual(events,phase==='native'?['media.close']:[]);
    await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  });
}
test('startup original cause survives join and database cleanup failures; lock remains until join settles', async t => {
  const f=await fixture(t), gate=Promise.withResolvers<void>(), entered=Promise.withResolvers<void>();
  const primary=new Error('ASSEMBLY_START'), joinFailure=new Error('MEDIA_JOIN'), dbFailure=new Error('DB_END');const events:string[]=[];
  const dependencies={configureMediaReplay:async()=>({service:{close:async()=>{events.push('join');entered.resolve();await gate.promise;throw joinFailure;}},archive:{}}),
    openFixtureDatabase:async()=>({pool:{},l3:{},close:()=>{events.push('db');throw dbFailure;}}),
    initializeActionSchema:async()=>{},createPersonalAIOSAssembly:()=>{throw primary;}} as unknown as Dependencies;
  const previous=process.argv;process.argv=[process.execPath,'test','--config',join(f.root,'config')];
  const result=main(dependencies).catch(error=>error);
  try {await entered.promise;assert.ok(await fs.stat(f.config.lock_file));assert.deepEqual(events,['join']);gate.resolve();
    const error=await result;assert.ok(error instanceof AggregateError);assert.equal(error.cause,primary);assert.equal(error.errors[0],primary);
    assert.deepEqual(error.errors[1].errors,[joinFailure,dbFailure]);assert.deepEqual(events,['join','db']);
    await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  } finally {gate.resolve();await result;process.argv=previous;}
});

test('same lifecycle stop invoked concurrently joins, closes DB and releases once even with synchronous throws',async()=>{
  const events:string[]=[], gate=Promise.withResolvers<void>(), primary=new Error('JOIN');
  const stop=createMainStop({close:async()=>{events.push('join');await gate.promise;throw primary;}},
    {close:()=>{events.push('db');throw new Error('DB');}},async()=>{events.push('release');});
  const one=stop(),two=stop();assert.equal(one,two);const result=one.catch(error=>error);gate.resolve();
  const error=await result;assert.ok(error instanceof AggregateError);assert.equal(error.errors[0],primary);
  assert.deepEqual(events,['join','db','release']);assert.equal(stop(),one);
});

for (const failure of ['connect','query','rollback','release','end','all','none'] as const) {
  test(`actual fixture DB ${failure} ownership and original error propagation`,async t=>{
    const f=await fixture(t),events:string[]=[],errors=Object.fromEntries(['connect','query','rollback','release','end'].map(k=>[k,new Error(k)]));
    let constructors=0;
    class ControlledPool {
      constructor(_config:unknown){constructors++;events.push(`pool${constructors}`);}
      async connect(){events.push('connect');if(failure==='connect')throw errors.connect;return {
        query:async(sql:string)=>{events.push(sql);if(sql==='BEGIN'&&['query','rollback','all'].includes(failure))throw errors.query;
          if(sql==='ROLLBACK'&&['rollback','all'].includes(failure))throw errors.rollback;return {rows:[]};},
        release:()=>{events.push('release');if(['release','all'].includes(failure))throw errors.release;}};}
      async end(){events.push('end');if(['end','all'].includes(failure))throw errors.end;}
    }
    let result: Awaited<ReturnType<typeof openFixtureDatabase>> | undefined, caught:unknown;
    try {result=await openFixtureDatabase(f.config.fixture_database,ControlledPool as unknown as NonNullable<Parameters<typeof openFixtureDatabase>[1]>);}catch(error){caught=error;}
    assert.equal(events.filter(e=>e==='connect').length,1);assert.equal(events.filter(e=>e==='release').length,failure==='connect'?0:1);
    assert.equal(events.filter(e=>e==='end').length,1);
    if(failure==='none') {assert.ok(result);assert.equal(constructors,2);const a=result.close(),b=result.close();assert.equal(a,b);await a;assert.equal(events.filter(e=>e==='end').length,2);}
    else {assert.equal(constructors,1);assert.equal(result,undefined);
      if(['all','rollback'].includes(failure)){assert.ok(caught instanceof AggregateError);assert.equal(caught.cause,errors.query);assert.equal(caught.errors[0],errors.query);
        assert.deepEqual(caught.errors,failure==='all'?[errors.query,errors.rollback,errors.release,errors.end]:[errors.query,errors.rollback]);}
      else assert.equal(caught,errors[failure]);}
  });
}
for (let failedQuery=1;failedQuery<=12;failedQuery++) {
  test(`fixture transaction query phase ${failedQuery} preserves its cause and releases once`,async t=>{
    const f=await fixture(t), primary=new Error(`QUERY_${failedQuery}`);let queries=0,releases=0,ends=0,rollbacks=0;
    class ControlledPool {
      async connect(){return {query:async(sql:string)=>{if(sql==='ROLLBACK'){rollbacks++;return {rows:[]};}
        if(++queries===failedQuery)throw primary;return {rows:[]};},release:()=>{releases++;}};}
      async end(){ends++;}
    }
    await assert.rejects(openFixtureDatabase(f.config.fixture_database,ControlledPool as unknown as NonNullable<Parameters<typeof openFixtureDatabase>[1]>),error=>error===primary);
    assert.equal(rollbacks,1);assert.equal(releases,1);assert.equal(ends,1);
  });
}
test('fixture data-pool close memoizes a rejecting end without duplicate disposal',async t=>{
  const f=await fixture(t),primary=new Error('DATA_POOL_END');let number=0,dataEnds=0;
  class ControlledPool {
    readonly admin=++number===1;
    async connect(){return {query:async()=>({rows:[]}),release:()=>{}};}
    end(){if(this.admin)return Promise.resolve();dataEnds++;throw primary;}
  }
  const database=await openFixtureDatabase(f.config.fixture_database,ControlledPool as unknown as NonNullable<Parameters<typeof openFixtureDatabase>[1]>);
  const a=database.close(),b=database.close();assert.equal(a,b);await assert.rejects(a,error=>error===primary);
  assert.equal(database.close(),a);assert.equal(dataEnds,1);
});
test('synchronous admin connect and asynchronous end failures retain first cause without invented client release',async t=>{
  const f=await fixture(t),primary=new Error('CONNECT_SYNC'),secondary=new Error('ADMIN_END');let connects=0,ends=0;
  class ControlledPool {
    connect(){connects++;throw primary;}
    async end(){ends++;throw secondary;}
  }
  await assert.rejects(openFixtureDatabase(f.config.fixture_database,ControlledPool as unknown as NonNullable<Parameters<typeof openFixtureDatabase>[1]>),error=>{
    assert.ok(error instanceof AggregateError);assert.equal(error.cause,primary);assert.deepEqual(error.errors,[primary,secondary]);return true;});
  assert.equal(connects,1);assert.equal(ends,1);
});

test('host configuration binds relative paths and environment ports to the mounted root, without embedding secrets', async t => {
  const f=await fixture(t); const previous=process.env.PAIOS_CONFIG_ROOT;
  process.env.PAIOS_CONFIG_ROOT=f.root; t.after(()=>{if(previous===undefined)delete process.env.PAIOS_CONFIG_ROOT;else process.env.PAIOS_CONFIG_ROOT=previous;});
  await fs.writeFile(join(f.root,'config'),JSON.stringify({hermes_key_file:'secrets/hermes.key',native_profile_home:'native',port:'${PAIOS_TEST_SERVICE_PORT}',
    instructions:'literal ${PAIOS_PERSONA_TEXT}',persona:'${PAIOS_PERSONA_TEXT}'}));
  process.env.PAIOS_TEST_SERVICE_PORT='18661'; t.after(()=>{delete process.env.PAIOS_TEST_SERVICE_PORT;});
  assert.deepEqual(await loadHostConfiguration(join(f.root,'config')),{hermes_key_file:join(f.root,'secrets/hermes.key'),native_profile_home:join(f.root,'native'),port:18661,
    instructions:'literal ${PAIOS_PERSONA_TEXT}',persona:'${PAIOS_PERSONA_TEXT}'});
  delete process.env.PAIOS_TEST_SERVICE_PORT;
  await assert.rejects(loadHostConfiguration(join(f.root,'config')),/HOST_CONFIG_ENV_REQUIRED:PAIOS_TEST_SERVICE_PORT/);
});
test('cloud migration config preserves exact origin aliases and permits an empty migration window', async t => {
  const f=await fixture(t),previous=process.env.PAIOS_LEGACY_PUBLIC_API_URLS;
  t.after(()=>{if(previous===undefined)delete process.env.PAIOS_LEGACY_PUBLIC_API_URLS;else process.env.PAIOS_LEGACY_PUBLIC_API_URLS=previous;});
  await fs.writeFile(join(f.root,'origins.json'),JSON.stringify({product_resources:{legacy_public_api_urls:'${PAIOS_LEGACY_PUBLIC_API_URLS}'}}));
  for(const value of [undefined,'','https://ai.example.invalid']) {
    if(value===undefined)delete process.env.PAIOS_LEGACY_PUBLIC_API_URLS;else process.env.PAIOS_LEGACY_PUBLIC_API_URLS=value;
    assert.deepEqual(await loadHostConfiguration(join(f.root,'origins.json')),{product_resources:{legacy_public_api_urls:value??''}});
  }
});
test('tracked Mac product snapshot passes the real central startup checks before deployment', async t => {
  const f=await fixture(t);
  const snapshot=await loadHostConfiguration(fileURLToPath(new URL('../../../../../deploy/mac-product/mac-product.json',import.meta.url))) as CentralProvisionConfiguration;
  const {core_profile,voiceprint,...portable}=snapshot;
  const config={...portable,storage_root:f.config.storage_root,lock_file:f.config.lock_file,
    hermes_key_file:f.config.hermes_key_file,internal_key_file:f.config.internal_key_file,skill_file:f.config.skill_file,
    voice_frontend:{...snapshot.voice_frontend!,key_file:f.config.hermes_key_file}};
  const turn=config.voice_frontend.call?.turn_manager;
  if(turn&&process.env.PAIOS_MODEL_ROOT)for(const file of [turn.model,turn.thinking_sound])file.path=join(process.env.PAIOS_MODEL_ROOT,'turns',basename(file.path));
  const provision=await provisionCentralResources(config);
  try {assert.ok(provision.resources.tts);} finally {await provision.release();}
});

test('central native binding uses the Hermes home independently of the generated profile volume', async t => {
  const f=await fixture(t), view=join(f.root,'generated'), nativeHome=join(f.root,'native');
  await fs.mkdir(view);await fs.mkdir(nativeHome);
  const originalFetch=globalThis.fetch;
  let responseHome=nativeHome;
  globalThis.fetch=async()=>Response.json({schema:'hermes.run.v2',
    shape_sha256:(await import('../src/hermes-client.ts')).NATIVE_RUN_SHAPE_SHA256,
    profile_home:responseHome,run_id:'run-1',session_id:'session-1',conversation_session_id:'session-1',status:'completed'});
  const provision=await provisionCentralResources({...f.config,admission:{max_pending_events:32,max_pending_bytes:65536,
    max_event_age_ms:1000,poll_interval_ms:1000,native_idempotency_retention_ms:86400000,policy_version:'fixture'},
    core_profile:{enabled:true,profile_home:view,native_profile_home:nativeHome}});
  try {
    const native=provision.resources.native;
    assert.equal((await native.status('run-1')).profile_home,nativeHome);
    responseHome=view;
    await assert.rejects(native.status('run-1'),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
    assert.equal(provision.resources.core_profile?.profile_home,view);
    assert.equal(provision.resources.core_profile?.source_profile_home,nativeHome);
  } finally {globalThis.fetch=originalFetch;await provision.release();}
});
