import './gateway-test-port.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DashScopeTts, inspectWav} from '../../../services/personal-aios-integration/src/tts.ts';
import {NATIVE_RUN_SHAPE_SHA256} from '../../../services/personal-aios-integration/src/hermes-client.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {StoragePort} from '../../../services/personal-aios-integration/src/storage.ts';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomEvent, DataPacketKind} from '@livekit/rtc-node';
import {configuredPcm, startConfiguredHermesProduct, startRayneoPersistentProduction, type HermesProductConfiguration,
  type RayneoPersistentProductionHandoff, type WholeProductExecutionSelection} from '../src/rayneo-persistent-production-entrypoint.ts';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {Phase0SharedSessionOwner} from '../src/phase0-shared-session-owner.ts';
import {FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import {makeMacProductResourceFixture} from './mac-product-resource-fixture.ts';
import {makePublicControl} from './whole-product-public-owner-fixture.ts';
import type {RealtimeBootstrapConnectedInput} from '../src/realtime-public-control-runtime.ts';
import {loadHostConfiguration} from '../../../services/personal-aios-integration/src/host-configuration.ts';

const KEY='controlled-provisioning-key-not-real-123456';
const SKILL='controlled fixed skill: actual receipt required';
test('expand renders guarded FRP loopback and contract preserves direct TLS routes',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'cloud-expand-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const path of ['prepare-build.py','staging_config.py','cloud.json','front.conf.in','paios_roaming_guard.js.in','paios-staging-snapshot.timer']){
    await fs.mkdir(join(root,'deploy/cloud'),{recursive:true});
    await fs.copyFile(new URL('../../../../../deploy/cloud/'+path,import.meta.url),join(root,'deploy/cloud',path));
  }
  const canonical='bj.example:9443',legacy='old.example';
  const results=[];
  for(const alias of ['',`https://${legacy}`]){
    const rendered=spawnSync('python3',[join(root,'deploy/cloud/prepare-build.py'),'--config-only'],{
      env:{...process.env,PAIOS_PUBLIC_API_URL:`https://${canonical}`,PAIOS_LEGACY_PUBLIC_API_URLS:alias,
        PAIOS_GATEWAY_PORT:'8787',PAIOS_LIVEKIT_SIGNAL_PORT:'7880',PAIOS_LIVEKIT_URL:''},encoding:'utf8'});
    assert.equal(rendered.status,0,rendered.stderr);
    const front=await fs.readFile(join(root,'deploy/cloud/.build/front.conf'),'utf8');
    assert.doesNotMatch(front,/@[A-Z_]+@/);
    const guard=await fs.readFile(join(root,'deploy/cloud/.build/paios_roaming_guard.js'),'utf8');
    const runtime=(await import('data:text/javascript;base64,'+Buffer.from(guard).toString('base64'))).default;
    const request=(headers:string[][])=>({rawHeadersIn:headers,variables:{is_args:''},headersOut:{},
      status:0,return(status:number){this.status=status;}});
    const edge=[['Host',legacy],['X-Forwarded-Host',legacy],['X-Forwarded-Proto','https'],
      ['X-Forwarded-For','192.0.2.1'],['X-PAIOS-Trusted-Edge','tencent-nginx-loopback-v1'],
      ['X-PAIOS-Trusted-Source-Family','ipv4'],['X-PAIOS-Proxy-Attestation','synthetic-only']];
    const direct=request([['Host',canonical]]);runtime.enforce(direct);assert.equal(direct.status,0);
    const wrongHost=request([['Host',legacy]]);runtime.enforce(wrongHost);assert.equal(wrongHost.status,400);
    const spoof=request([['Host',canonical],['X-Forwarded-For','192.0.2.1']]);
    runtime.enforce(spoof);assert.equal(spoof.status,400);
    const old=request(edge);runtime.enforceLegacy(old);assert.equal(old.status,alias?0:400);
    for(const invalid of [edge.slice(0,-1),[...edge,['Host',legacy]],
      edge.map(row=>row[0]==='X-Forwarded-Host'?[row[0],canonical]:row),[...edge,['Forwarded','for=192.0.2.1']]]){
      const denied=request(invalid);runtime.enforceLegacy(denied);assert.equal(denied.status,400);
    }
    results.push(front);
    const resources=JSON.parse(await fs.readFile(join(root,'deploy/cloud/.build/production.json'),'utf8')).product_resources;
    assert.equal(resources.legacy_public_api_urls,alias);
    const staging=await fs.readFile(join(root,'deploy/cloud/.build/front-staging.conf'),'utf8');
    assert.ok(!staging.includes('listen 127.0.0.1:8788;'));
  }
  assert.equal(results.length,2);
  const [contract,expand]=results as [string,string];
  assert.equal(expand.split('\n# Authenticated loopback forwarding')[0],contract);
  assert.ok(contract.includes('listen 443 ssl http2;'));
  assert.ok(!contract.includes('listen 127.0.0.1:8788;'));
  const loopback=expand.slice(expand.indexOf('\n# Authenticated loopback forwarding'));
  assert.ok(loopback.includes('listen 127.0.0.1:8788;'));
  assert.ok(loopback.includes('proxy_set_header Host $http_host;'));
  assert.ok(loopback.includes('proxy_set_header X-Forwarded-For $http_x_forwarded_for;'));
  assert.ok(loopback.includes('proxy_set_header X-PAIOS-Proxy-Attestation $http_x_paios_proxy_attestation;'));
  assert.ok(!loopback.includes('include /run/secrets/nginx-attestation.conf;'));
  assert.equal((contract.match(/js_access paios_roaming_guard.enforce;/g)||[]).length,
    (contract.match(/proxy_pass http:\/\/127.0.0.1:8787;/g)||[]).length);
  assert.ok(!contract.slice(contract.indexOf('location ~ ^/rtc'),contract.indexOf('location ~ ^/v1/devices')).includes('js_access'));
  assert.deepEqual([...loopback.matchAll(/    location [^\n]+/g)].map(m=>m[0]),
    [...contract.matchAll(/    location [^\n]+/g)].map(m=>m[0]));
  assert.equal((loopback.match(/js_access paios_roaming_guard.enforceLegacy;/g)||[]).length,
    (contract.match(/proxy_pass http:\/\/127.0.0.1:8787;/g)||[]).length);
});
test('rendered cloud production and staging reach formal provisioning with optional visual and reject unknown keys',async t=>{
  const scratch=new URL('../../../../../.scratch/',import.meta.url);
  await fs.mkdir(scratch,{recursive:true});
  const root=await fs.mkdtemp(join(scratch.pathname,'d5-cloud-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const path of ['deploy/cloud/prepare-build.py','deploy/cloud/staging_config.py','deploy/cloud/cloud.json','deploy/cloud/front.conf.in','deploy/cloud/paios_roaming_guard.js.in','deploy/cloud/paios-staging-snapshot.timer']){
    await fs.mkdir(join(root,path,'..'),{recursive:true});
    await fs.copyFile(new URL('../../../../../'+path,import.meta.url),join(root,path));
  }
  // Supply the optional cleanup credential explicitly; public defaults have no avatar instance.
  const cloudFile=join(root,'deploy/cloud/cloud.json'),cloudFixture=JSON.parse(await fs.readFile(cloudFile,'utf8'));
  cloudFixture.product_resources.vidu_cleanup_key_file='${PAIOS_SECRET_ROOT}/vidu.key';
  await fs.writeFile(cloudFile,JSON.stringify(cloudFixture));
  const rendered=spawnSync('python3',[join(root,'deploy/cloud/prepare-build.py'),'--config-only'],{
    env:{...process.env,PAIOS_PUBLIC_HOST:'entry.example',PAIOS_AVATAR_URL:''},encoding:'utf8'});
  assert.equal(rendered.status,0,rendered.stderr);
  const front=await fs.readFile(join(root,'deploy/cloud/.build/front.conf'),'utf8');
  for(const route of ['/v1/place/upload','/v1/place/credential']){
    assert.ok(front.includes(`"HTTP/2.0:POST:${route}" 1;`));
    const location=front.slice(front.indexOf(`    location = ${route} {`)).split('\n    }')[0];
    assert.ok(location);
    assert.ok(location.includes(`if ($request_uri != "${route}")`));
    assert.ok(location.includes('client_max_body_size 131072;'));
    assert.ok(location.includes('client_body_buffer_size 131072;'));
    assert.ok(location.includes('proxy_request_buffering on;'));
    assert.ok(location.includes('proxy_pass http://127.0.0.1:8787;'));
    assert.equal(location.includes('proxy_set_header'),false,'place locations inherit the closed server projection');
  }
  const environment={PAIOS_CONFIG_ROOT:root,PAIOS_DATA_ROOT:join(root,'data'),PAIOS_SECRET_ROOT:join(root,'secrets'),
    PAIOS_MODEL_ROOT:join(root,'models'),PAIOS_POSTGRES_PORT:'5432',PAIOS_LIVEKIT_URL:'wss://entry.example:9443',
    PAIOS_PUBLIC_API_URL:'https://entry.example:9443',PAIOS_GATEWAY_PORT:'18787',PAIOS_LIVEKIT_SIGNAL_PORT:'7880',
    PAIOS_LIVEKIT_API_URL:'http://127.0.0.1:7880',
    PAIOS_INTEGRATION_PORT:'18091',PAIOS_HERMES_PORT:'18191',PAIOS_DASHSCOPE_ENDPOINT:'wss://voice.invalid/realtime',PAIOS_MODEL_SETTINGS_ENVIRONMENT:'test'};
  await fs.mkdir(environment.PAIOS_SECRET_ROOT,{recursive:true,mode:0o700});
  await fs.writeFile(join(environment.PAIOS_SECRET_ROOT,'vidu.key'),KEY,{mode:0o600});
  const previous=Object.fromEntries([...Object.keys(environment),'PAIOS_STAGE'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,environment);
  t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const reached=new Error('CONTROLLED_PROVISIONING_BOUNDARY');let calls=0,provisioned:unknown;
  const ports={createHandoff:async()=>{throw new Error('UNEXPECTED_HANDOFF');},start:async()=>{throw new Error('UNEXPECTED_START');},
    provision:async(config:unknown)=>{calls++;provisioned=config;throw reached;}};
  for(const stage of ['production','staging']){
    process.env.PAIOS_STAGE=stage;
    const config=await loadHostConfiguration(join(root,'deploy/cloud/.build',stage+'.json')) as HermesProductConfiguration;
    assert.ok(config.visual?.faces);
    assert.equal(config.product_resources.vidu_cleanup_key_file,stage==='production'?join(root,'secrets','vidu.key'):undefined);
    assert.equal(config.shutdown_drain_ms,105000);
    assert.deepEqual(config.capability_packages,cloudFixture.capability_packages);
    assert.equal(config.product_resources.call_rejoin_window_s,120);
    assert.deepEqual(config.timeline,{enabled:true,fanout_classes:['iphone','mac'],retention_days:90,max_items:5000,sync_page_max:100});
    assert.deepEqual(config.desktop?.queue,{max_pending:8,default_ttl_min:720,max_ttl_min:1440});
    await assert.rejects(startConfiguredHermesProduct(config,ports),error=>error===reached);
    assert.equal(provisioned,config);
    const {visual,...withoutVisual}=config;
    await assert.rejects(startConfiguredHermesProduct(withoutVisual,ports),error=>error===reached);
    assert.equal(provisioned,withoutVisual);
    await assert.rejects(startConfiguredHermesProduct({...config,unknown_product_key:true} as never,ports),/HERMES_PRODUCT_CONFIGURATION_REQUIRED/);
  }
  assert.equal(calls,4);
});
async function listen(server:ReturnType<typeof createServer>) {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');return address.port;
}
async function fixture(t:test.TestContext,memoryProfile?:string) {
  const root=await fs.mkdtemp(join(tmpdir(),'product-provision-'));
  const handles:Awaited<ReturnType<typeof startConfiguredHermesProduct>>[]=[];
  let native:ReturnType<typeof createServer>|undefined;
  t.after(async()=>{
    for(const handle of [...handles].reverse())await handle.close();
    const server=native;
    if(server)await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    await fs.rm(root,{recursive:true,force:true});
  });
  await fs.writeFile(join(root,'key'),KEY,{mode:0o600});await fs.writeFile(join(root,'skill'),SKILL);
  const requests:any[]=[];let healthRequests=0,healthy=true,oversized=false,completed=false;
  native=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${KEY}`);
    if(req.method==='GET'&&req.url?.startsWith('/api/sessions')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
    if(req.url==='/health/detailed') {
      healthRequests++;res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({...(oversized?{diagnostic:'x'.repeat(20000)}:{}),platform:'hermes-agent',readiness:{checks:{gateway:{state:healthy?'running':'draining'},
        session_store:{status:'ok'},model:{status:healthy?'ok':'degraded'}}}}));return;
    }
    if(req.method==='GET'&&new URL(req.url!, 'http://fixture').pathname==='/personal-aios/reminders') {
      assert.ok(new URL(req.url!, 'http://fixture').searchParams.get('principal_id'));
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({reminders:[]}));return;
    }
    const chunks:Buffer[]=[];for await(const bytes of req)chunks.push(Buffer.from(bytes));
    if(req.method==='POST'&&req.url==='/v1/runs') {
      const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(body.instructions,SKILL);
      requests.push({body,key:req.headers['idempotency-key']});
    }
    const session=requests[0]?.body.session_id??'continuity';
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:memoryProfile??'/fixture',granted_toolsets:requests[0]?.body.grant_toolsets??[],run_id:'native-controlled',session_id:session,conversation_session_id:session,status:completed&&req.method==='GET'?'completed':'running',
      ...(completed&&req.method==='GET'?{output:'controlled native final 原文。'}:{})}));
  });
  const nativePort=await listen(native);
  const reserve=createServer();const port=await listen(reserve);await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const productResources=makeMacProductResourceFixture(join(root,'public-resources'));
  const config:HermesProductConfiguration={executionOwner:'hermes_text',product_resources:productResources.config,storage_root:join(root,'storage'),lock_file:join(root,'lock'),port,
    timeline:{enabled:true},desktop:{enabled:false,queue:{max_pending:8,default_ttl_min:720,max_ttl_min:1440}},
    hermes_base_url:`http://127.0.0.1:${nativePort}`,hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),
    native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:16384,max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'provision-fixture'},
    ...(memoryProfile?{core_profile:{enabled:true as const,profile_home:memoryProfile}}:{})};
  let owned:Extract<Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>,{executionOwner:'hermes_text'}>|undefined;
  let ends=0;let storage:StoragePort|undefined;let ttsResource:DashScopeTts|undefined;let issuedSource:RegisteredDevice|undefined;
  const now=Date.now(),sessionRef={ref_type:'RealtimeSession',ref_id:'controlled-session'},leaseRef={ref_type:'DeviceLease',ref_id:'controlled-lease'};
  const principal={opaque:'controlled-principal'},policy={ref_type:'PolicyDecision',ref_id:'controlled-policy'};
  const current={session:{realtimeSessionRef:sessionRef,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:new Date(now+600000).toISOString(),activeDeviceId:'phone',activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'phone',connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'owner',deviceId:'phone',state:'active',
      expiresAt:new Date(now+600000).toISOString(),leaseVersion:'1',fencingToken:'1',capabilities:['data'],policyDecisionRef:policy}};
  const t03={ownerContext:{resolve:async()=>({userId:'owner',deviceId:'phone',purpose:'assistant',capabilities:['data'],occurredAt:new Date(now).toISOString()})},
    formalWatchPrimaryAuthority:{resolve:async()=>({userId:'owner',deviceId:'phone',principalRef:principal,policyDecisionRef:policy})},
    readCurrentAuthority:()=>({userId:'owner',deviceId:'phone',principal,policyDecisionRef:policy,allowedMediaCapabilities:['data'],
      governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent'}]}})};
  const listeners=new Map<string,(...args:any[])=>void>(),packets:any[]=[];
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:any[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>packets.push(JSON.parse(Buffer.from(bytes).toString()))}};
  const publicFixture=makePublicControl();
  const ports={start:startRayneoPersistentProduction,createHandoff:async(selection:WholeProductExecutionSelection)=>{
    assert.equal(selection.executionOwner,'hermes_text');if(selection.executionOwner!=='hermes_text')throw new Error('MODE');assert.equal(selection.inputReadiness.isReady(),true);storage=selection.central.storage;ttsResource=selection.central.tts;
    const {voice:_voice,...central}=selection.central;
    const result=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central:{...central,
      payment_devices:async principal=>principal==='owner'?[{principal_id:'owner',device_id:'phone',device_type:'phone',
        channel:'fixture_inventory',consent_ref:'consent',route_version:'paired:phone',output_modes:['text']}]:[]},
      t03:t03 as never,readCurrentBinding:async()=>current as never,deviceId:'phone',participant:{roomPort:room} as never,
      onError:error=>assert.fail(String(error))});
    assert.equal(result.executionOwner,'hermes_text');if(result.executionOwner!=='hermes_text')throw new Error('OWNER');owned=result;
    const publicControl={...publicFixture.handoff,centralTextAssembly:owned.assembly,
      composition:{...publicFixture.handoff.composition,assistantBridge:owned.bridge}};
    return {publicControl,launcherInput:{executionOwner:'hermes_text',owner:new Phase0SharedSessionOwner(),pool:{end:async()=>{ends++;}} as never,
      pairingRegistry:undefined as never,environment:{PAIOS_DEMO_ROAMING:'1',PAIOS_GATE_A_LOCAL_DEVICE:'1',
        PAIOS_RAYNEO_LIVEKIT_URL:'ws://127.0.0.1:7880',PAIOS_RAYNEO_PROXY_ATTESTATION_SECRET:Buffer.alloc(32,1).toString('base64url')},inputReadiness:selection.inputReadiness}} as RayneoPersistentProductionHandoff;
  }};
  async function submit() {
    assert.ok(owned);
    const input={request:{requested_media:{data:true,audio:false,video:false},start:{modalities:['data']}},bearer:{principal,deviceId:'phone'},
      governance:{controlled:true},authority:{gateway:{identity:'controlled-gateway',roomName:'room'}},
      currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialIdentity:'terminal',credentialRoom:'room'},
      enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
    await owned.bridge.onBootstrapConnected!(input);
    issuedSource=await owned.authority.authenticate(owned.authority.credentialForBootstrap(input));
    const bytes=Buffer.from(JSON.stringify({operation:'submit',event_id:'controlled-provision-event',captured_at:new Date(now).toISOString(),text:'  原始文字\r\n'}));
    const emit=()=>listeners.get(RoomEvent.DataReceived)!(bytes,{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    emit();for(let n=0;n<2000&&requests.length===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(requests.length,1);emit();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(requests.length,1);
    // Native acceptance and a persisted binding can precede the runtime's live tool owner.
    let bound=false;
    for(let n=0;n<2000;n++){
      const located=await owned.assembly.runtime.tool('paios_l5_locate',{context:{run_id:'native-controlled',session_id:'continuity',tool_call_id:'fixture-binding-check'},args:{}});
      if(!(located && typeof located==='object' && 'error_code' in located && located.error_code==='RUN_BINDING_PENDING')){bound=true;break;}
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(bound,true,'native acceptance must reach the live tool owner');
    return JSON.parse(requests[0].body.input);
  }
  async function http(path:string,body?:unknown,key=KEY){const res=await fetch(`http://127.0.0.1:${config.port}${path}`,{
    method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json() as any};}
  async function start(configuration:Parameters<typeof startConfiguredHermesProduct>[0]=config,
    overrides:Parameters<typeof startConfiguredHermesProduct>[1]=ports){
    const handle=await startConfiguredHermesProduct(configuration,overrides);handles.push(handle);return handle;
  }
  return {config,ports,start,requests,submit,http,packets,setHealthy:(value:boolean)=>{healthy=value;},setOversized:()=>{oversized=true;},get healthRequests(){return healthRequests;},get storage(){return storage!;},get owned(){return owned!;},get ends(){return ends;},get ttsResource(){return ttsResource;},setCompleted(){completed=true;},get issuedSource(){return issuedSource!;}};
}

test('configured production start uses actual HermesClient, one source assembly, exact L5 bytes and OPEN receipt',async t=>{
  const f=await fixture(t);const handle=await f.start(f.config,f.ports);
  assert.equal(f.owned.assembly.server.listening,true);assert.equal(handle.centralPort,f.config.port);assert.equal(f.healthRequests,0);assert.equal(Object.hasOwn(f.owned.bridge.centralTextTransport!,'voiceTransport'),false);
  const d=await f.submit();assert.equal(f.requests[0].body.session_id,'continuity');
  assert.deepEqual(f.owned.assembly.runtime.timeline!.page('owner').items.map(item=>item.item_id),['me-controlled-provision-event']);
  assert.ok(f.packets.some(packet=>packet.operation==='timeline_items'&&packet.items.some((item:any)=>item.item_id==='me-controlled-provision-event')));
  assert.equal((await f.storage.list('processed-events')).length,1);
  const schemas=await f.http('/internal/hermes/tool-contracts');assert.equal(schemas.status,200);
  assert.ok(schemas.body.some((x:any)=>x.name==='paios_l5_read'));assert.ok(!schemas.body.some((x:any)=>/paios_l3_|paios_action/.test(x.name)));
  const context={run_id:'native-controlled',session_id:'continuity',tool_call_id:'read'};
  const located=await f.http('/internal/hermes/tools/paios_l5_locate',{context,args:{}});assert.equal(located.body.raw_ref,d.raw_ref);
  const read=await f.http('/internal/hermes/tools/paios_l5_read',{context,args:{}});assert.equal(read.body.content,'  原始文字\r\n');
  assert.equal(read.body.sha256,createHash('sha256').update('  原始文字\r\n').digest('hex'));
  assert.equal(read.body.archive_revision,d.archive_revision);
  const opened=await f.http('/internal/hermes/tools/paios_open_reply',{context:{...context,tool_call_id:'open'},args:{reply_mode:'text'}});
  assert.deepEqual(opened.body,{status:'opened',error_code:null});
  const records=await Promise.all((await f.storage.list('output-journal')).map(async key=>
    JSON.parse(Buffer.from(await f.storage.read('output-journal',key)).toString('utf8'))));
  assert.equal(records.length,2);
  const defaults=records.filter(entry=>entry.operation==='admission-open');assert.equal(defaults.length,1);
  assert.equal(defaults[0].open.status,'opened');assert.equal(defaults[0].open.reply_epoch,1);
  const journals=records.filter(entry=>entry.operation==='open:open');assert.equal(journals.length,1);
  const journal=journals[0];assert.equal(journal.binding,defaults[0].binding);
  assert.equal(journal.open.status,'opened');assert.match(journal.open.receipt_ref,/^out:/);
  assert.equal(journal.operation,'open:open');assert.equal(journal.open.phase,'final_buffer');
  assert.equal((await f.http('/internal/hermes/tool-contracts',undefined,'wrong')).status,401);
  assert.equal((await f.http('/internal/hermes/tools/paios_l5_read',{context:{...context,run_id:'forged'},args:{}})).body.error_code,'RUN_BINDING_PENDING');
  assert.equal((await f.http('/internal/hermes/tools/paios_l5_read',{context:{...context,session_id:'other'},args:{}})).body.error_code,'RUN_BINDING_PENDING');
  assert.equal((await f.http('/internal/hermes/tools/paios_l5_read',{context,args:{extra:'x'.repeat(20000)}})).status,413);
  await Promise.all([handle.close(),handle.close()]);assert.equal(f.ends,1);await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
});

test('pending central tool handler is joined before pool end and central lock release',async t=>{
  const f=await fixture(t);const handle=await f.start(f.config,f.ports);await f.submit();
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();const tool=f.owned.assembly.runtime.tool.bind(f.owned.assembly.runtime);
  f.owned.assembly.runtime.tool=async(name,call)=>{entered.resolve();await gate.promise;return tool(name,call);};
  const request=f.http('/internal/hermes/tools/paios_l5_read',{context:{run_id:'native-controlled',session_id:'continuity',tool_call_id:'held'},args:{}}).catch(()=>undefined);
  await entered.promise;const close=handle.close();await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(await fs.stat(f.config.lock_file));assert.equal(f.ends,0);gate.resolve();await close;await request;
  assert.equal(f.ends,1);await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
});

for(const kind of ['native-unready','native-budget'] as const)test(`configured controls start while ${kind} without claiming model acceptance`,async t=>{
  const f=await fixture(t);if(kind==='native-unready')f.setHealthy(false);else f.setOversized();
  await f.start(f.config,f.ports);
  assert.equal(f.owned.assembly.server.listening,true);assert.equal(f.healthRequests,0);
  assert.equal((await f.http('/internal/hermes/tool-contracts')).status,200);
  assert.equal(f.requests.length,0);
});

for(const kind of ['occupied','empty-skill','unsafe-key','fixture-fields'] as const)test(`configured startup ${kind} preserves source cause and releases only acquired resources`,async t=>{
  const f=await fixture(t);let calls=0;const ports={...f.ports,createHandoff:async(...args:Parameters<typeof f.ports.createHandoff>)=>{calls++;return f.ports.createHandoff(...args);}};
  let occupied:ReturnType<typeof createServer>|undefined;
  if(kind==='occupied'){occupied=createServer();await new Promise<void>(resolve=>occupied!.listen(f.config.port,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>occupied!.close(()=>resolve())));}
  if(kind==='empty-skill')await fs.writeFile(f.config.skill_file,'  ');
  if(kind==='unsafe-key')await fs.chmod(f.config.hermes_key_file,0o644);
  if(kind==='fixture-fields')Object.assign(f.config,{fixture_database:{}});
  await assert.rejects(f.start(f.config,ports),error=>kind==='occupied'?(error as NodeJS.ErrnoException).code==='EADDRINUSE':
    error instanceof Error&&error.message===(kind==='empty-skill'?'FIXED_SKILL_EMPTY':kind==='unsafe-key'?'UNSAFE_KEY_FILE':'HERMES_PRODUCT_CONFIGURATION_REQUIRED'));
  await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});assert.equal(calls,kind==='occupied'?1:0);
  if(kind==='occupied'){assert.equal(f.owned.assembly.server.listening,false);assert.equal(f.ends,1);}
});

function controlledWav() {
  const b=Buffer.alloc(244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);
  b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(200,40);return inspectWav(b);
}
test('optional TTS rejects invalid config and constructor errors without leaking lock or allocating a product owner',async t=>{
  const f=await fixture(t);let calls=0;const ports={...f.ports,createHandoff:async(...args:Parameters<typeof f.ports.createHandoff>)=>{calls++;return f.ports.createHandoff(...args);}};
  for(const tts of [null,{provider:'qwen',voice:'x'},{provider:'mac_system',voice:1},{provider:'mac_system',voice:'x',output:{}},
    {provider:'mac_system',voice:''},{provider:'mac_system',voice:'x'.repeat(201)}]){
    await assert.rejects(f.start({...f.config,tts} as never,ports),/TTS_PROVIDER_NOT_CONFIGURED|TTS_INVALID_VOICE/);
    await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  }
  assert.equal(calls,0);const handle=await f.start(f.config,ports);assert.equal(f.ttsResource,undefined);await handle.close();
});
test('configured TTS resource follows existing listener-failure cleanup without synthesis or native rerun',async t=>{
  const f=await fixture(t);f.config.tts={provider:'dashscope',model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050};f.config.voice_frontend={provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',endpoint:'wss://synthetic.invalid/realtime',key_file:f.config.hermes_key_file,voice:'Tina',instructions:'candidate'};f.config.pcm={media:{fixture_only:true},producer:{device_type:'phone',channel:'rtc_pcm_and_text'},receipt_clock:{uncertainty_ms:1000},budget:{max_frame_samples:1600,max_pending_frames:64,max_pending_bytes:262144,max_samples:9600000,archive_batch:{max_delay_ms:500,max_frames:20,max_bytes:65536}}};let calls=0;
  t.mock.method(DashScopeTts.prototype,'stream',async function*(){calls++;throw new Error('MUST_NOT_SYNTHESIZE');});
  const busy=createServer();await new Promise<void>(resolve=>busy.listen(f.config.port,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>busy.close(()=>resolve())));
  await assert.rejects(f.start(f.config,f.ports),{code:'EADDRINUSE'});assert.equal(calls,0);assert.equal(f.ends,1);assert.equal(f.requests.length,0);
  await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
});

test('lower source owner rejects arbitrary central.output and structural TtsPort despite configured product readiness',async t=>{
  const f=await fixture(t);
  for(const field of ['output','tts'] as const){
    const ports={...f.ports,createHandoff:async(selection:WholeProductExecutionSelection)=>{
      if(selection.executionOwner!=='hermes_text')throw new Error('MODE');
      return f.ports.createHandoff({...selection,central:{...selection.central,
        [field]:field==='output'?{tts:{synthesize:async()=>controlledWav()}}:{synthesize:async()=>controlledWav()}}} as never);
    }};
    await assert.rejects(f.start(f.config,ports),field==='output'?/CENTRAL_OWNED_RESOURCES_REQUIRED/:/CENTRAL_TTS_RESOURCE_REQUIRED/);
    await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  }
});


test('concrete provisioned TTS reaches same product OUT while formal route and bootstrap stay text-only',async t=>{
  const f=await fixture(t);f.config.tts={provider:'dashscope',model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050};f.config.voice_frontend={provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',endpoint:'wss://synthetic.invalid/realtime',key_file:f.config.hermes_key_file,voice:'Tina',instructions:'candidate'};f.config.pcm={media:{fixture_only:true},producer:{device_type:'phone',channel:'rtc_pcm_and_text'},receipt_clock:{uncertainty_ms:1000},budget:{max_frame_samples:1600,max_pending_frames:64,max_pending_bytes:262144,max_samples:9600000,archive_batch:{max_delay_ms:500,max_frames:20,max_bytes:65536}}};let synthesis=0;
  t.mock.method(DashScopeTts.prototype,'stream',async function*(){synthesis++;throw new Error('MUST_NOT_SYNTHESIZE_TEXT_ONLY');});
  const handle=await f.start(f.config,f.ports);const d=await f.submit();
  assert.ok(f.ttsResource instanceof DashScopeTts);
  assert.deepEqual([f.ttsResource.model,f.ttsResource.voice,f.ttsResource.sampleRate],['qwen-audio-3.0-tts-plus','longanlingxin',22050]);
  const output=Reflect.get(f.owned.assembly.runtime,'output') as OutputAuthority;
  assert.ok(output instanceof OutputAuthority);assert.equal(Reflect.get(output,'config').tts,f.ttsResource);
  assert.deepEqual(f.issuedSource.output_modes,['text']);assert.equal(Object.hasOwn(f.owned.bridge.centralTextTransport!,'voiceTransport'),false);
  assert.equal(f.owned.bridge.centralTextTransport?.outputTopic,'paios.central.sealed-text.v1');
  const opened=await f.http('/internal/hermes/tools/paios_open_reply',{context:{run_id:'native-controlled',session_id:'continuity',tool_call_id:'voice'},args:{reply_mode:'text_and_voice'}});
  assert.deepEqual(opened.body,{status:'opened',error_code:null});
  f.setCompleted();
  const reply=await f.owned.assembly.runtime.result(f.issuedSource,'continuity',d.processed_event_id);
  assert.equal(reply.result.result_status,'completed');
  assert.equal(reply.result.reply_mode,'text');assert.equal(reply.result.voice_status,'none');
  assert.equal(reply.chunks.map(chunk=>chunk.text).join(''),'controlled native final 原文。');
  assert.deepEqual(reply.voice_chunks,[]);assert.deepEqual(await f.storage.list('derived-audio'),[]);
  assert.equal(synthesis,0);assert.equal(f.requests.length,1);
  assert.ok(d.raw_ref);await handle.close();assert.equal(f.ends,1);await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
});

test('explicit optional L3 namespace is forwarded while malformed resource configuration rejects before allocation', async t => {
  const f = await fixture(t);
  for (const l3 of [null, 'schema', {namespace: 42}, {namespace: 'bad;schema'},
    {namespace: 'test_l3', fixture_database: true}]) {
    await assert.rejects(f.start({...f.config, l3} as never, f.ports), /L3_CONFIGURATION_INVALID/);
  }
  let seen = 0;
  const ports = {...f.ports, createHandoff: async (selection?: WholeProductExecutionSelection) => {
    if (!selection) throw new Error('MODE_REQUIRED');
    assert.equal(selection.executionOwner, 'hermes_text');
    if (selection.executionOwner !== 'hermes_text') throw new Error('MODE');
    assert.deepEqual(selection.l3, {namespace: 'test_l3'}); seen++;
    return f.ports.createHandoff(selection);
  }};
  const handle = await f.start({...f.config, l3: {namespace: 'test_l3'}}, ports);
  await handle.close(); assert.equal(seen, 1); assert.equal(f.ends, 1);
});

test('formal product threads the generated core profile into the one runtime without native L2 receipts',async t=>{
  const profile=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'hermes-profile-')));t.after(()=>fs.rm(profile,{recursive:true,force:true}));
  const f=await fixture(t,profile);const handle=await f.start(f.config,f.ports);
  await f.submit();
  const read=await f.owned.assembly.runtime.runReceipts({run_id:'native-controlled',session_id:'continuity'} as never);
  assert.deepEqual(read.sources.map(source=>[source.source,source.status]),[['l3','not_configured'],['action','not_configured']]);
  await handle.close();
});
test('formal product core profile rejects unresolved or malformed paths before taking the lock',async t=>{
  const real=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'hermes-profile-')));t.after(()=>fs.rm(real,{recursive:true,force:true}));
  const alias=join(real,'..',`alias-${process.pid}-${Date.now()}`);await fs.symlink(real,alias);t.after(()=>fs.rm(alias,{force:true}));
  for(const [memory,code] of [[{enabled:true,profile_home:alias},/CORE_PROFILE_HOME_UNRESOLVED/],[{enabled:true,profile_home:join(real,'missing')},/CORE_PROFILE_HOME_UNRESOLVED/],
    [{enabled:true,profile_home:'relative/home'},/CORE_PROFILE_CONFIG_INVALID/],[{enabled:true,profile_home:real,extra:1},/CORE_PROFILE_CONFIG_INVALID/]] as const){
    const f=await fixture(t);
    await assert.rejects(f.start({...f.config,core_profile:memory as never},f.ports),code);
    await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  }
  const f=await fixture(t);
  await assert.rejects(f.start({...f.config,native_memory_receipt:{}} as never,f.ports),/HERMES_PRODUCT_CONFIGURATION_REQUIRED/);
});

test('production PCM configuration: frame_v1 by default; the ambient lane opts in with interval_v2, continuous and archive_batch',()=>{
  const base={media:{fixture_only:false},producer:{device_type:'phone' as const,channel:'rtc_pcm_and_text'},receipt_clock:{uncertainty_ms:1000},
    budget:{max_frame_samples:1600,max_pending_frames:64,max_pending_bytes:262144,max_samples:9600000,archive_batch:{max_delay_ms:500,max_frames:20,max_bytes:65536}}};
  const plain=configuredPcm(base)!;assert.equal(plain.input_contract,'frame_v1');assert.equal('continuous' in plain,false);
  assert.deepEqual(plain.budget.archive_batch,base.budget.archive_batch);
  const budget={max_streams:2,max_pending_chunks:64,max_pending_candidates:32,max_chunk_bytes:65536,block_samples:160000,overlap_samples:8000};
  const ambient=configuredPcm({...base,input_contract:'interval_v2',continuous:{budget}})!;
  assert.equal(ambient.input_contract,'interval_v2');assert.deepEqual(ambient.continuous,{budget});
  for(const bad of [{...base,input_contract:'interval_v3'},{...base,continuous:{budget,detector:{}}},{...base,continuous:null},{...base,continuous:{}},{...base,extra:1}])
    assert.throws(()=>configuredPcm(bad as never),/PCM_CONFIGURATION_INVALID/);
});
