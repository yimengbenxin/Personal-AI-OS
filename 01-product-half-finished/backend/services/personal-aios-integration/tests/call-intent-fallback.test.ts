import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {dispose} from '@livekit/rtc-node';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {projectModelSettings} from '../src/model-settings-projection.ts';
import {ModelUsage} from '../src/model-usage.ts';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {sourceClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {handleModelSettingsHttp} from '../src/model-settings-http.ts';
import {createVoiceCallSession} from '../../../phase0/gateway/src/voice-call-session.ts';
import type {ModelSnapshot} from '../src/model-settings-contract.ts';

after(()=>dispose());
const root=resolve(import.meta.dirname,'../../../../..');
const native=process.env.PAIOS_HERMES_REBUILD_DIR,python=process.env.PAIOS_HERMES_PYTHON;
const skip=!native||!python?'requires the locked native source and Python':false;
const cli=join(root,'deploy/cloud/model-settings-call-intent.ts');
const listen=(server:ReturnType<typeof createServer>)=>new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));

for(const primaryUp of [false,true])test(`call.intent primary ${primaryUp?'up uses no fallback':'down falls back'} and reaches brain with revision-bound per-attempt usage`,{skip,timeout:120000},async t=>{
  assert.equal(spawnSync(process.execPath,[join(root,'integrations/hermes/verify-producer.mjs'),'--check-running',native!],{encoding:'utf8'}).status,0);
  const home=await mkdtemp(join(tmpdir(),'call-intent-fallback-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const cert=join(home,'cert.pem'),key=join(home,'key.pem');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{encoding:'utf8'}).status,0);
  const requests:string[]=[],usageResponses:{status:number;body:string}[]=[],wire:any[]=[];
  const model=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),route=req.url!.split('/')[1]!;requests.push(route);
    assert.equal(req.headers.authorization,'Bearer fake-inference-key');
    assert.equal(body.temperature,0);assert.deepEqual(body.thinking,{type:'disabled'});
    if(route==='primary'&&!primaryUp){req.socket.destroy();return;}
    assert.notEqual(route,'last','fallback order stops after the first success');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'fake-completion',object:'chat.completion',created:1,model:body.model,
      choices:[{index:0,message:{role:'assistant',content:JSON.stringify({stop:false,guests:'unchanged',directed:true,hangup:false})},finish_reason:'stop'}],
      usage:{prompt_tokens:5,completion_tokens:4,total_tokens:9}}));
  });
  const base=(await listen(model)).replace('http:','https:');t.after(()=>{model.closeAllConnections();model.close();});
  const snapshot:ModelSnapshot={providers:['primary','fallback','last'].map(id=>({id:`fake-${id}`,display_name:id,wire_protocol:'chat_completions',base_url:`${base}/${id}/v1`,credential_ref:id})),
    roles:[{id:'brain',profile:'owner',provider_ref:'fake-primary',model_id:'fake-primary-model',parameters:{context_limit:32768,max_output_tokens:8192,thinking:{enabled:true}},
      ordered_fallbacks:['fallback','last'].map(id=>({provider_ref:`fake-${id}`,model_id:`fake-${id}-model`,parameters:{context_limit:32768,max_output_tokens:8192,thinking:{enabled:true}}})),activation_boundary:'brain_idle'},
      {id:'call.intent',profile:'owner',inherit_from:'brain',parameters:{max_output_tokens:128,temperature:0,thinking:{enabled:false}},ordered_fallbacks:[],activation_boundary:'brain_idle'}]};
  const master=join(home,'master.key');await writeFile(master,Buffer.alloc(32,7),{mode:0o600});
  let authority=ModelSettingsAuthority.open(join(home,'models'),{environment_id:'test',master_key_file:master,allow_private_hosts:['127.0.0.1']});
  authority.bootstrap(snapshot,{primary:'fake-inference-key',fallback:'fake-inference-key',last:'fake-inference-key'});
  authority.close();
  const migration=spawnSync(process.execPath,[cli,'--directory',join(home,'models'),'--master',master,
    '--environment','test','--profile','owner','--principal-id','owner','--expected-revision','1','--allow-private-host','127.0.0.1','--apply'],{encoding:'utf8'});
  assert.equal(migration.status,0,migration.stderr);
  assert.equal(JSON.parse(migration.stdout).brain.effective,1,'deployment stages desired without forging native activation');
  authority=ModelSettingsAuthority.open(join(home,'models'),{environment_id:'test',master_key_file:master,allow_private_hosts:['127.0.0.1'],activate:async()=>{}});
  t.after(()=>authority.close());
  await authority.activateIdle('brain',true);
  const revision=authority.read().groups.brain.effective;
  const projection=projectModelSettings(authority,'owner',revision,'brain');
  const config=structuredClone(projection.config) as Record<string,any>;
  // Only synthetic test keys; production projection credentials remain opaque handles.
  // Trust only this fixture's CA explicitly; macOS platform TLS does not use SSL_CERT_FILE as Linux does.
  for(const provider of Object.values(config.providers) as Record<string,unknown>[]){provider.api_key='fake-inference-key';provider.ssl_ca_cert=cert;}
  config.auxiliary.transient_retries=0;
  const projectionPath=join(home,'projection.json');await writeFile(projectionPath,JSON.stringify(projection));
  await writeFile(join(home,'config.yaml'),JSON.stringify({...config,secrets:{environment:'profile',personal_aios:{enabled:true,projection:projectionPath}}}));
  const unused=async()=>{throw Error('unexpected native brain request');};
  const storage=new PosixStorage(join(home,'storage')),archive=new RawArchive(storage,8192),client=sourceClient({create:unused,status:unused,cancel:unused});
  const admission=new RunAdmission(storage,client,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'rq115'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native:client,output:new OutputAuthority(storage),skill:'test',max_read_bytes:8192,
    payment:PaymentAuthority.open(join(home,'payments')),devices:[]});
  runtime.installModelSettings(authority);const usage=new ModelUsage(authority.db,{notify:async()=>{}});runtime.installModelUsage(usage,'test');t.after(()=>runtime.close());
  const token='fake-rq115-service-token-abcdefghijklmnop',service=createServer(async(req,res)=>{
    // Observe the real service response, preserving every source/route check.
    const end=res.end.bind(res);res.end=((body:any,...args:any[])=>{if(req.url?.endsWith('/usage'))usageResponses.push({status:res.statusCode,body:String(body)});return end(body,...args);}) as typeof res.end;
    let raw='';req.on('data',chunk=>{raw+=chunk;});req.on('end',()=>{if(req.url?.endsWith('/usage'))wire.push(JSON.parse(raw));});
    if(!await handleModelSettingsHttp(req,res,runtime,token,16384)){res.writeHead(404);res.end();}
  });
  const serviceUrl=await listen(service);t.after(()=>{service.closeAllConnections();service.close();});
  const trusted={principal_id:'owner',device_id:'phone',device_type:'phone' as const,consent_ref:'consent',channel:'fixture',submission:'observation' as const};
  const pcm={schema_version:'paios.event.v1',event_id:'call-pcm',device_id:'phone',device_type:'phone' as const,captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'audio' as const,mime:'audio/pcm',representation:'received_decoded_sample' as const,payload:Buffer.alloc(320)};
  const chunk=(seq:number)=>({track_id:'microphone',stream_epoch:'rq115',seq,modality:'audio' as const,format:'pcm_s16le:16000:1',source_range:{kind:'interval' as const,timebase_id:'samples',stream_epoch:'rq115',start_ms:seq*10,end_ms:(seq+1)*10}});
  const first=(await(await archive.admitStream(pcm,trusted,chunk(0))).commit).event;
  await archive.bindCallTrack(first.raw_ref,{call_id:'rq115-call',principal_id:'owner',track:'microphone'});
  await(await archive.admitStream(pcm,trusted,chunk(1))).commit; // The utterance proof is older than the stream head.
  const source={kind:'call',principal_id:'owner',device_id:'phone',call_id:'rq115-call',continuity:'rq115-session',raw_ref:first.raw_ref,archive_revision:first.archive_revision};
  await writeFile(join(home,'service.key'),token,{mode:0o600});
  let classification:Promise<any>|undefined;
  const classify=(text:string)=>classification??=new Promise((done,reject)=>{
    const child=spawn(python!,[join(import.meta.dirname,'fixtures/call-intent-probe.py')],{cwd:native!,env:{PATH:process.env.PATH!,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:`${native}:${join(root,'integrations/hermes')}`,HERMES_HOME:home,
      PAIOS_MODEL_SETTINGS_PROJECTION:projectionPath,PAIOS_MODEL_SETTINGS_SERVICE_URL:serviceUrl,PAIOS_MODEL_SETTINGS_TOKEN_FILE:join(home,'service.key'),SSL_CERT_FILE:cert,NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
    child.on('error',reject);child.on('exit',code=>code===0?done(JSON.parse(stdout.trim().split('\n').at(-1)!)):reject(Error(stderr)));
    child.stdin.end(JSON.stringify({text,source_context:source}));
  });
  const delivered=Promise.withResolvers<void>(),brain:string[]=[],errors:unknown[]=[],asset={path:'/synthetic',sha256:'0'.repeat(64)};
  let samples=0,active=false;
  const call=createVoiceCallSession({greeting:{enabled:false},room:()=>({}),turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'fake',voice:'fake'}},score:async()=>1,thinking:new Int16Array(480)},
    identifySpeech:async()=>true,transcribeSpeech:async()=> '依米帮我查天气',classifySpeech:classify,
    openVad:async()=>({write:async(pcm:Float32Array)=>{const before=samples;samples+=pcm.length;const speech=pcm.some(v=>v!==0),changed=speech!==active;active=speech;return changed?[speech?{at:samples,start:before}:{at:samples,end:before}]:[];},close:async()=>{}}),
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:()=>{},onTranscript:()=>{},onTurn:turn=>{brain.push(turn.user);delivered.resolve();},onError:error=>errors.push(error)});
  t.after(()=>call.closeAll());await call.open('rq115-call');
  call.pushPcm(new Int16Array(512));await new Promise(setImmediate);
  for(let i=0;i<42;i++){call.pushPcm(new Int16Array(512).fill(1000));await new Promise(setImmediate);}
  call.pushPcm(new Int16Array(512));
  for(let i=0;i<100&&!classification;i++)await new Promise(done=>setTimeout(done,10));
  assert.ok(classification,'the real call turn invokes the native classifier');await classification;
  await call.close('rq115-call','button');
  const guard=setTimeout(()=>delivered.reject(Error('classified call did not reach brain')),5000);
  try{await delivered.promise;}finally{clearTimeout(guard);}
  assert.deepEqual(errors,[]);assert.deepEqual(brain,['依米帮我查天气']);
  assert.ok(usageResponses.length>0);assert.ok(usageResponses.every(result=>result.status===200),JSON.stringify(usageResponses));
  assert.ok(!JSON.stringify(usageResponses).includes('ROUTE_DENIED'));
  assert.deepEqual(requests,primaryUp?['primary']:['primary','primary','fallback']);
  const attempts=usage.recentAttempts('test','owner');assert.equal(attempts.length,requests.length);
  assert.deepEqual(attempts.map(attempt=>[attempt.provider_id,attempt.status]).sort(),primaryUp?[['fake-primary','completed']]:[['fake-fallback','completed'],['fake-primary','failed'],['fake-primary','failed']]);
  assert.ok(attempts.every(attempt=>attempt.revision===String(revision)&&attempt.role==='call.intent'&&attempt.owner_chat));
  assert.ok(wire.every(attempt=>attempt.source_context.archive_revision===first.archive_revision));
  assert.equal(new Set(wire.map(attempt=>attempt.request_id)).size,1);
  assert.equal(wire.length,attempts.length*2,'each HTTP attempt has a started and a terminal record');
});
