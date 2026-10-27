// The 24-hour ambient lane end to end through the actual continuous source, Processor, archive, Runtime and Admission:
// ambient speech is journaled and never runs; a wake turn's request audio is analysed as one speaker turn and runs as
// that turn D's request revision, with the conversation only for the verified owner; "确认是我" carries it for an
// uncertain owner; journal tools are owner-only; after a turn's reply is delivered its asker follows up without the wake word.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {ContractError,principalAttribution,runScope,sha256,type ProcessedEvent,type RawEvent} from '../src/contracts.ts';
import {Timeline} from '../src/timeline.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive,type TrackChunk} from '../src/stream-archive.ts';
import {MediaProcessor,type Capability,type WorkerPort,type WorkerRequest} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import type {CallHeard,FollowUpRequest,WakeRequest} from '../src/ambient/lane.ts';
import {controlledDetector,testJournal,transcriptionResult} from './speech-fixture.ts';
import {CareAuthority} from '../src/care/authority.ts';
import type {SoundEvent,SpeechEmotion} from '../src/voiceprint/contracts.ts';
import {PHONE_CAPABILITIES,GLASSES_CAPABILITIES,StaticFixtureDeviceAuthority,type SourceDeviceAuthority,type RegisteredDevice} from '../src/source-authority.ts';
import {randomUUID} from 'node:crypto';
import {openFixtureDatabase} from '../src/memory/fixture-database.ts';
import {fileURLToPath} from 'node:url';

const T0=Date.parse('2026-10-09T08:00:00.000Z');
const capability:Capability={id:'local-sherpa-audio',version:'fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],joint_av:false,
  healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'real_verified',speaker_identity:'local_voiceprint'};
const turnCapability:Capability={...capability,id:'local-sherpa-turn',max_duration_ms:20000};
/** One heard utterance (what the ambient worker reports for its candidate): `wake` is where the spotter's 依米 ends, as a
 *  fraction of the utterance (1: said alone); `ms` its speech (default 1.15 s), `gap_ms` the silence before it. */
interface Line {text:string;speaker?:string;score?:number;wake?:number;gap_ms?:number;ms?:number;event?:SoundEvent;emotion?:SpeechEmotion}
/** What the turn worker reports for a wake turn's request audio: its text and the one identity over its speech. */
interface Turn {text:string;speaker?:string;score?:number}
const marker=(samples:number,speech:boolean)=>{const pcm=Buffer.alloc(samples*2);if(speech)for(let n=0;n<samples;n++)pcm.writeInt16LE(1,n*2);return pcm;};

async function fixture(t:test.TestContext,lines:Line[],turns:Turn[]=[],options:{l3?:import('../src/memory/l3.ts').L3Service;call_heard?:CallHeard;realtime_busy?:()=>boolean;on_turn?:(request:WorkerRequest)=>Promise<void>;on_audio?:()=>void;revalidate?:(source:RegisteredDevice)=>Promise<void>;care?:true;wear?:true;local_wake?:true;notify?:(notice:{title:string;body:string})=>Promise<void>}={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-ambient-lane-'));
  const storage=new PosixStorage(join(directory,'storage'));
  const budget={max_chunk_bytes:400000,max_total_bytes:8000000,max_chunks:200,max_revisions:200,max_seq:200};
  const archive=new RawArchive(storage,400000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  const lineSpans:{start_ms:number;end_ms:number;line:Line}[]=[];let analyses=0;
  const turnScript=[...turns],errors:unknown[]=[],turnWindows:{start_ms:number;end_ms:number;carrier?:WorkerRequest['speaker_carrier']}[]=[];
  const worker:WorkerPort={effects:'pure_analysis',analyze:async request=>{
    const range=request.time_range;assert.ok(range.kind==='interval');
    const selected=lineSpans.find(span=>range.start_ms>=span.start_ms&&range.start_ms<span.end_ms);assert.ok(selected,'analysis must match received source speech');
    const line=selected.line;analyses++;options.on_audio?.();
    return transcriptionResult(request,capability,line.text,{...(line.wake!==undefined?{wake:line.wake}:{}),
      ...(line.speaker?{speaker:line.speaker,speaker_score:line.score??0.9}:{}),...(line.event?{event:line.event}:{}),
      ...(line.emotion?{emotion:line.emotion}:{})});}};
  const turnWorker:WorkerPort={effects:'pure_analysis',analyze:async request=>{const turn=turnScript.shift()!,range=request.time_range as {start_ms:number;end_ms:number};
    turnWindows.push({start_ms:range.start_ms,end_ms:range.end_ms,...(request.speaker_carrier?{carrier:request.speaker_carrier}:{})});
    await options.on_turn?.(request);
    return transcriptionResult(request,turnCapability,turn.text,turn.speaker?{speaker:turn.speaker,speaker_score:turn.score??0.9}:{});}};
  const processor=new MediaProcessor(storage,new Map([[capability.id,worker],[turnCapability.id,turnWorker]]),{policy_version:'ambient-fixture',max_inflight:1,
    max_input_bytes:400000,timeout_ms:10000,allow_external:false,allow_replay:false,allow_partial:true});
  const service=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[capability],fixtureOnly:true,clockEvidence:'synthetic',
    turn:{capabilities:async()=>[turnCapability]},
    align:{max_chunks:200,max_visual_refs:1,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:20000,
    continuous:{detector:controlledDetector(),budget:{max_streams:2,max_pending_chunks:16,max_pending_candidates:16,max_chunk_bytes:400000,
      block_samples:160000,overlap_samples:8000},onError:error=>errors.push(error)}});
  // Another person's persistent profile (cluster 1), as ambient listening would have created it.
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'voiceprints')),{id:'fixture-speaker',sha256:'c'.repeat(64),dim:16});
  const voice=new Float32Array(16);voice[5]=1;await registry.identify(voice,{speech_ms:3000,observed_at:new Date(T0).toISOString(),mode:'observe'});
  // Runs of one session are sequential: a run stays running (its tools callable) until the test finishes it.
  // A finished run may carry its final reply text (sealed by automatic output, as in production).
  const bodies:{input:string;instructions:string;session_id:string;run_scope?:string;guest_key?:string;care_decision?:true;model_options?:{reasoning:{enabled:boolean}};run_id:string}[]=[],finished=new Map<string,string|undefined>();
  const native:NativeClient={create:async(body,key)=>{const run_id=`run-${sha256(key).slice(0,12)}`;bodies.push({...structuredClone(body),run_id});
    return {run_id,session_id:body.care_decision?`paios-care-${run_id}`:body.session_id,conversation_session_id:body.session_id,status:'running',
      ...(body.care_decision?{}:{})};},
    status:async id=>({run_id:id,session_id:'continuity',conversation_session_id:'continuity',status:finished.has(id)?'completed':'running',
      ...(finished.get(id)?{output:finished.get(id)!}:{})}),
    cancel:async id=>({run_id:id,session_id:'continuity',conversation_session_id:'continuity',status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:16,max_pending_bytes:4000000,max_event_age_ms:100000,poll_interval_ms:5,
    native_idempotency_retention_ms:86400000,policy_version:'controlled'});
  const device=(device_id:string,device_type:'glasses'|'phone')=>({principal_id:'owner',device_id,device_type,capabilities:device_type==='phone'?PHONE_CAPABILITIES:[...GLASSES_CAPABILITIES.filter(c=>options.wear||c!=='wear_state'),'location' as const,...(options.local_wake?['local_wake' as const]:[])],consent_ref:'fixture',channel:'fixture',
    route_version:'route',output_modes:['text'],token_sha256:sha256(`${device_id}-token`)});
  const journal=await testJournal(t),outputErrors:unknown[]=[];
  // The wall clock follows the stream: audio is "now" as it is appended.
  let seq=0,at=0;
  const devices=[device('glasses','glasses'),device('phone','phone')],authority=options.revalidate?new StaticFixtureDeviceAuthority(devices):undefined;
  const sourceAuthority:SourceDeviceAuthority|undefined=authority?{authenticate:credential=>authority.authenticate(credential),
    revalidate:async source=>{const current=await authority.revalidate(source);await options.revalidate!(current);return current;}}:undefined;
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),media:service,
    ...(sourceAuthority?{sourceAuthority}:{devices}),skill:'controlled',max_read_bytes:400000,voiceprint:registry,ambient_journal:journal,...(options.l3?{l3:options.l3}:{}),
    automatic_output:{onError:error=>outputErrors.push(error)},ambient_clock:()=>T0+at/16,
    ...(options.care?{care:CareAuthority.open(join(directory,'care'),()=>T0+at/16)}:{}),
    ...(options.call_heard?{call_heard:options.call_heard}:{}),...(options.realtime_busy?{realtime_busy:options.realtime_busy}:{}),
    ...(options.notify?{notify:options.notify}:{}),
    continuous_context:async(_source,_event,chunk)=>({session:'continuity',clock_maps:[{modality:'audio',track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,
      source_timebase_id:'samples',target_timebase_id:'utc_epoch_ms',offset_ms:T0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]})});
  t.after(async()=>{await runtime.close();await processor.close();await registry.close();await rm(directory,{recursive:true,force:true});});
  if(options.care)await runtime.configureTimeline({directory:join(directory,'timeline'),now:()=>T0+at/16});
  const glasses=await runtime.authenticate('glasses-token'),phone=await runtime.authenticate('phone-token');
  const append=async(pcm:Buffer)=>{const chunk:TrackChunk={track_id:'mic',stream_epoch:'ambient',seq:seq++,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'ambient',start_ms:at/16,end_ms:(at+pcm.length/2)/16}};at+=pcm.length/2;
    const raw:RawEvent={schema_version:'paios.event.v1',event_id:'ambient-lane',device_id:'glasses',device_type:'glasses',captured_at:new Date(T0).toISOString(),
      source:{channel:'fixture'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm};
    const result=await runtime.appendMedia(raw,glasses,chunk);assert.equal(result.processing_admission?.status,'queued',result.processing_admission?.error_code);};
  const samples=(ms:number)=>Math.max(1,Math.round(ms*16/512))*512;
  // Each line is its gap of silence then its speech (the marker detector cuts one candidate per speech run); 2 s of
  // trailing silence lets the last turn's pause reach the turn gap. `count`: the next lines only (default: the rest).
  let next=0;
  const hear=async(count=lines.length-next)=>{for(const line of lines.slice(next,next+=count)){if(line.gap_ms)await append(marker(samples(line.gap_ms),false));
    const length=samples(line.ms??1150);lineSpans.push({start_ms:T0+at/16,end_ms:T0+(at+length)/16,line});
    await append(marker(length,true));}await append(marker(samples(2000),false));await runtime.continuousMedia().drain();};
  const runs=async(count:number)=>{for(let i=0;i<400&&bodies.length<count;i++)await new Promise(r=>setTimeout(r,5));assert.equal(bodies.length,count);
    return bodies.map(body=>({...body,d:JSON.parse(body.input) as ProcessedEvent}));};
  const tool=async(name:string,run_id:string,args:Record<string,unknown>)=>{
    for(let i=0;i<400;i++){const value=await runtime.tool(name,{context:{run_id,session_id:'continuity',tool_call_id:`tc-${i}`},args}) as {status?:string;error_code?:string};
      if(value.error_code!=='RUN_BINDING_PENDING')return value;await new Promise(r=>setTimeout(r,5));}
    assert.fail('run binding did not settle');
  };
  const heard=()=>journal.search({principal_id:'owner',limit:20}).entries.reverse();
  /** The run answers `text` and its reply is delivered to the device that heard the turn (now, by the stream's clock). */
  const reply=async(run:{run_id:string;d:ProcessedEvent},text:string)=>{
    await tool('paios_open_reply',run.run_id,{reply_mode:text?'text':'none'});finished.set(run.run_id,text);
    const delivered=Promise.withResolvers<string>();
    await runtime.subscribeResult(glasses,'continuity',run.d.processed_event_id,async value=>{
      if(value.result.reply_mode==='none'||value.chunks.some(chunk=>chunk.final))delivered.resolve(value.chunks.map(chunk=>chunk.text).join(''));},delivered.reject);
    assert.equal(await delivered.promise,text);
  };
  return {storage,archive,runtime,registry,journal,glasses,phone,errors,outputErrors,hear,runs,tool,turnWindows,heard,reply,
    analyses:()=>analyses,created:()=>bodies.length,finish:(run_id:string,text?:string)=>finished.set(run_id,text)};
}
const wakeOf=(d:ProcessedEvent)=>d.content.wake_request as unknown as WakeRequest;
const until=async(done:()=>boolean)=>{for(let i=0;i<400&&!done();i++)await new Promise(r=>setTimeout(r,5));assert.ok(done());};

test('conversation recap receives sourced owner, voice-cluster and unknown observations and can retrieve their L5 originals',async t=>{
  const f=await fixture(t,[
    {text:'周敏，我们周五交方案，我负责预算。',speaker:'owner'},
    {text:'好，我周四把设计稿发你。',speaker:'speaker:1',gap_ms:500},
    {text:'电视剧台词：我中了五百万。',gap_ms:500},
    {text:'依米，刚才那场聊天帮我回顾一下。',speaker:'owner',wake:0.1,gap_ms:500}],
    [{text:'刚才那场聊天帮我回顾一下。',speaker:'owner'}]);
  await f.hear();const [run]=await f.runs(1),context=wakeOf(run!.d).context!;
  assert.ok(context.entries.some(e=>e.speaker_ref==='owner'&&e.text.includes('预算')&&e.instruction_eligible));
  assert.ok(context.entries.some(e=>e.speaker_ref==='speaker:1'&&e.text.includes('设计稿')&&!e.instruction_eligible));
  assert.ok(context.entries.some(e=>e.speaker_ref==='unknown'&&e.text.includes('五百万')&&!e.instruction_eligible));
  await f.tool('paios_speaker_name',run!.run_id,{speaker:'speaker:1',name:'周敏'});
  const named=await f.tool('paios_ambient_journal_search',run!.run_id,{speaker:'周敏'}) as unknown as {entries:{text:string;speaker_ref:string;evidence:{raw_ref:string;archive_revision:string;processed_event_id:string;segment_id:string}}[]};
  assert.ok(named.entries.some(e=>e.speaker_ref==='speaker:1'&&e.text.includes('周四')));
  const all=await f.tool('paios_ambient_journal_search',run!.run_id,{from:new Date(T0).toISOString(),until:new Date(T0+60000).toISOString()}) as typeof named;
  for(const text of ['预算','设计稿','五百万'])assert.ok(all.entries.some(e=>e.text.includes(text)));
  for(const e of all.entries){
    const ref=e.evidence;assert.ok(ref.processed_event_id&&ref.segment_id);
    const original=await f.archive.readRecord(ref.raw_ref,'owner',ref.archive_revision,{proof_only:true});
    assert.equal(original.archive_revision,ref.archive_revision);
    const located=await f.tool('paios_l5_locate',run!.run_id,{raw_ref:ref.raw_ref});assert.equal(located.status,'located');
  }
  assert.deepEqual(f.errors,[]);
});

test('ambient evidence reaches real L3 through the main tool and raw erasure removes derived journal text',
  {skip:!process.env.PAIOS_L3_TEST_DATABASE_URL},async t=>{
  const schema='paios_fixture_ambient_'+randomUUID().replaceAll('-','').slice(0,20);
  const database=await openFixtureDatabase({url:process.env.PAIOS_L3_TEST_DATABASE_URL!,schema,
    migration_file:fileURLToPath(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url))});
  const f=await fixture(t,[{text:'我周四把设计稿发给你。',speaker:'speaker:1'},
    {text:'依米，记下刚才的约定。',speaker:'owner',wake:0.2,gap_ms:500}],[{text:'记下刚才的约定。',speaker:'owner'}],{l3:database.l3});
  t.after(async()=>{await f.runtime.close();await database.pool.query('DROP SCHEMA '+schema+' CASCADE');await database.close();});
  await f.hear();const [run]=await f.runs(1),entry=wakeOf(run!.d).context!.entries.find(e=>e.speaker_ref==='speaker:1')!,evidence=entry.evidence!;
  const original=await f.archive.locate(evidence.raw_ref,'owner'),ref={event_id:original.event_id,...evidence};
  const assertion={assertion_id:'heard-agreement',kind:'observation',subject_ref:{type:'speaker_cluster',id:'speaker:1'},predicate:'said',value:entry.text,
    scope:{principal_id:'owner',purpose:'recap',situation:'conversation',role:'participant',evaluation_frame:'observation'},evidence_refs:[ref],
    evidence_status:'available',unknown_conditions:[],conflicts:[],status:'active',applicability_status:'applicable',relation_to_peers:'independent',typed_scores:{},depends_on:[]};
  const receipt=await f.tool('paios_l3_commit',run!.run_id,{command_id:'heard-command',operation:'create',expected_version:0,assertion,evidence_refs:[ref]});
  assert.equal(receipt.status,'committed');assert.equal((receipt as {version?:number}).version,1);
  await f.archive.delete(evidence.raw_ref,'owner');
  const search=await f.tool('paios_ambient_journal_search',run!.run_id,{query:'设计稿'}) as {entries?:unknown[]};
  assert.deepEqual(search.entries,[]);assert.equal(await f.archive.validateEvidence(run!.d),false);
  await assert.rejects(f.archive.read(evidence.raw_ref,'owner',evidence.archive_revision));
});

test('sound observations do not create runs beside an active owner conversation',async t=>{
  const f=await fixture(t,[{text:'依米现在几点',speaker:'owner',wake:0.3},{text:'',event:'cough',ms:300},
    {text:'',event:'sneeze',ms:300,gap_ms:500}], [{text:'现在几点',speaker:'owner'}],{care:true});
  await f.hear(1);const [owner]=await f.runs(1);await f.hear(2);const runs=await f.runs(1);
  assert.equal(runs[0]!.run_id,owner!.run_id);assert.equal(runs[0]!.care_decision,undefined);
  assert.equal(f.runtime.timeline!.observations('owner').length,2);
});

test('sound observations stay on the shared timeline without proactive runs or opening a voice session',async t=>{
  const notices:string[]=[],shown:string[]=[],wakes:import('../src/runtime.ts').AmbientVoiceWake[]=[];
  const f=await fixture(t,[{text:'',event:'cough',ms:300},{text:'',event:'sneeze',ms:300,gap_ms:6000}],[],
    {care:true,notify:async notice=>{notices.push(notice.body);}});
  await f.runtime.watchCare(f.phone,async(_id,text)=>{shown.push(text);return true;});
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{wakes.push(wake);return true;},
    {active:()=>false,identified:async()=>true});
  await f.hear();await f.runs(0);
  const observations=f.runtime.timeline!.observations('owner');
  assert.equal(observations.length,2);
  assert.ok(observations.every(item=>item.who==='观察'&&item.text.includes('发声人未识别')));
  assert.ok(observations.some(item=>item.text.includes('cough')));
  assert.ok(observations.some(item=>item.text.includes('sneeze')));
  assert.deepEqual([wakes,shown,notices],[[],[],[]]);
  assert.deepEqual(f.errors,[]);
});

test('raw deletion removes sound and emotion context before and after reopening the timeline',async t=>{
  const f=await fixture(t,[{text:'',event:'cough',ms:300},{text:'',event:'sneeze',ms:300,gap_ms:6000},
    {text:'预算的事让我有些难过',speaker:'owner',emotion:'sad',gap_ms:500}],[],{care:true});
  await f.hear();await f.runs(0);
  const timeline=f.runtime.timeline!,entry=f.heard()[0]!,ref=entry.raw_ref;
  assert.equal(timeline.observations('owner').length,3);
  const kept=timeline.append({principal_id:'owner',item_id:'kept-owner',kind:'owner',via:'text',text:'保留独立对话',at_ms:T0})!;
  await f.archive.delete(ref,'owner');
  await assert.rejects(f.archive.readRecord(ref,'owner',entry.archive_revision),/RAW_DELETED/);
  assert.deepEqual(f.journal.search({principal_id:'owner',limit:20}),{entries:[],events:[],truncated:false});
  assert.deepEqual(timeline.observations('owner'),[]);
  assert.deepEqual(timeline.page('owner').items,[kept]);
  assert.doesNotMatch(await f.runtime.callContext(f.phone,'after-delete'),/难过|cough|sneeze/u);
  await f.archive.delete(ref,'owner');
  await f.runtime.close();
  const reopened=new Timeline({directory:join(f.storage.root,'..','timeline'),now:()=>T0+60000},f.storage,
    async()=>{throw new Error('NO_ADMISSION');},{readOnly:async()=>undefined});
  try {
    assert.deepEqual(reopened.observations('owner'),[]);
    assert.deepEqual(reopened.page('owner').items,[kept]);
  }finally{await reopened.close();}
  assert.deepEqual(f.errors,[]);
});

test('a live call owns its raw sounds without duplicate ambient analysis; after the call sounds reach the shared timeline',async t=>{
  let live=true;const spoken:string[]=[],shown:string[]=[],context:string[]=[];
  const f=await fixture(t,[{text:'',event:'cough',ms:300},{text:'依米，你在吗',speaker:'owner',wake:0.25,gap_ms:500},
    {text:'',event:'sneeze',ms:300,gap_ms:6000}],[],{care:true,call_heard:()=>live});
  await f.runtime.watchCare(f.phone,async(_id,text)=>{shown.push(text);return true;},async text=>{
    if(!live)return false;spoken.push(text);return true;},async text=>{if(!live)return false;context.push(text);return true;});
  await f.hear(2);
  assert.deepEqual(f.journal.search({principal_id:'owner',limit:20}).events,[]);assert.deepEqual(f.heard(),[]);assert.equal(f.analyses(),0);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,2);
  assert.equal((await f.storage.list('media-continuous-dispositions')).length,2);
  for(const key of await f.storage.list('media-continuous-candidates')){
    const {event}=JSON.parse(Buffer.from(await f.storage.read('media-continuous-candidates',key)).toString());
    assert.equal((await f.archive.locate(event.raw_ref,'owner')).archive_status,'durable');
  }
  live=false;await f.hear(1);await f.runs(0);assert.equal(f.analyses(),1);
  const observations=f.runtime.timeline!.observations('owner');
  assert.equal(observations.length,1);assert.match(observations[0]!.text,/sneeze/u);
  assert.equal(observations[0]!.text.includes('cough'),false,'the call-heard cough never became duplicate evidence');
  assert.deepEqual(shown,[]);assert.deepEqual(spoken,[]);assert.deepEqual(context,[]);
});

test('ambient speech is journaled and never runs; a verified owner\'s wake turn runs in the owner session with the conversation',async t=>{
  const f=await fixture(t,[{text:'我们周末去爬山吧',speaker:'speaker:1'},{text:'好啊，去香山',speaker:'owner',gap_ms:300},
    {text:'一米，帮我查一下周末北京的天气',speaker:'owner',wake:0.25,gap_ms:1500,ms:2500}],[{text:'帮我查一下周末北京的天气',speaker:'owner'}]);
  await f.hear();assert.deepEqual(f.errors,[]);
  const entries=f.heard();
  assert.deepEqual(entries.map(e=>[e.speaker,e.text,e.wake]),[['speaker:1','我们周末去爬山吧',null],['owner','好啊，去香山',null],
    ['owner','一米，帮我查一下周末北京的天气','依米']]);
  assert.equal(new Set(entries.map(e=>e.conversation_id)).size,1);
  const [run]=await f.runs(1);const d=run!.d;
  assert.deepEqual([d.revision,d.intent_class,d.reply_hint,d.processing.path_id],[2,'explicit_request','respond','ambient_wake_request']);
  assert.deepEqual([runScope(d),principalAttribution(d),run!.run_scope,Object.hasOwn(run!,'memory_write'),run!.session_id],['owner','owner_voice',undefined,false,'continuity']);
  const wake=wakeOf(d);assert.equal(wake.text,'帮我查一下周末北京的天气');assert.equal(wake.wake,'依米');
  assert.equal(wake.wake_processed_event_id,entries[2]!.processed_event_id);
  assert.deepEqual(wake.context!.entries.map(e=>[e.speaker,e.text]),[['说话人#1','我们周末去爬山吧'],['主人','好啊，去香山']]);
  assert.equal(wake.context!.entries[0]!.speaker_ref,'speaker:1');
  // The turn audio starts at the wake word, the request where it ends; its turn D carries the turn worker's text and identity.
assert.equal(f.turnWindows.length,1);assert.equal(f.turnWindows[0]!.start_ms,entries[2]!.start_ms);
  assert.equal(wake.heard_at,new Date(entries[2]!.wake_cut_ms!).toISOString());
  assert.equal(d.content.transcript,'帮我查一下周末北京的天气');assert.equal(await f.archive.validateEvidence(d),true);
  // Its own segment, though its audio is exactly the wake utterance the ambient lane already analysed.
  assert.equal(d.segment_basis,'wake_turn');assert.equal(d.time_range.kind==='interval'&&d.time_range.start_ms,entries[2]!.start_ms);
  assert.equal((await f.storage.list('processed-events')).length,1,'only the wake turn was admitted');
});

test('the device that heard a wake turn is told as it is admitted (its app shows the reply); other devices and sessions are not',async t=>{
  const f=await fixture(t,[{text:'一米，明天早上八点提醒我开会',speaker:'owner',wake:0.2,ms:2500}],[{text:'明天早上八点提醒我开会',speaker:'owner'}]);
  await f.runtime.configureTimeline({directory:join(f.storage.root,'timeline')});
  const heard:ProcessedEvent[]=[],elsewhere:ProcessedEvent[]=[];
  const stop=await f.runtime.watchAmbientTurns(f.glasses,'continuity',d=>heard.push(d));
  await f.runtime.watchAmbientTurns(f.phone,'continuity',d=>elsewhere.push(d));
  await f.runtime.watchAmbientTurns(f.glasses,'other-session',d=>elsewhere.push(d));
  await f.hear();const [run]=await f.runs(1);
  assert.deepEqual(heard.map(d=>[d.processed_event_id,wakeOf(d).text]),[[run!.d.processed_event_id,'明天早上八点提醒我开会']]);
  assert.deepEqual(elsewhere,[]);stop();
  await f.reply(run!,'明早八点提醒你');const {chunks}=await f.runtime.result(f.glasses,'continuity',run!.d.processed_event_id);
  const expected=[{id:`me-ambient-${run!.d.processed_event_id}`,via:'ambient',text:'明天早上八点提醒我开会'},
    {id:`her-${run!.d.processed_event_id}`,via:'ambient',text:'明早八点提醒你'}];
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>({id:item.item_id,via:item.via,text:item.text})),expected,'the sealed reply is history before any ACK');
  const last=chunks.at(-1)!;
  await f.runtime.acknowledge(f.glasses,'continuity',run!.d.processed_event_id,{output_id:last.output_id,reply_id:last.reply_id,
    reply_epoch:last.reply_epoch,target_device_id:last.target_device_id,route_version:last.route_version,
    highest_contiguous_seq:last.seq,status:'rendered',observed_at:new Date(T0).toISOString()});
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>({id:item.item_id,via:item.via,text:item.text})),expected,'a rendered ACK never duplicates it');
});

test('the owner\'s measured pattern: "依米" alone, a pause, a request with a mid-sentence pause — one owner turn, no "确认是我"',async t=>{
  const f=await fixture(t,[{text:'今天中午吃什么好呢',speaker:'owner'},{text:'意味？',wake:1,ms:450,gap_ms:800},
    {text:'给我妈发个消息说，今晚。',speaker:'owner',ms:2200,gap_ms:500},{text:'7点回家。',ms:900,gap_ms:600}],
  [{text:'给我妈发个消息说，今晚。7点回家。',speaker:'owner',score:0.81}]);
  await f.hear();assert.deepEqual(f.errors,[]);
  const [run]=await f.runs(1),wake=wakeOf(run!.d),entries=f.heard();
  assert.equal(runScope(run!.d),'owner','the unidentifiable wake-only segment is a trigger, not request evidence');
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.equal(wake.text,'给我妈发个消息说，今晚。7点回家。');assert.equal(wake.wake_processed_event_id,entries[1]!.processed_event_id);
  assert.equal(f.turnWindows[0]!.start_ms,entries[1]!.start_ms,'the turn audio holds the wake word');
  assert.equal(f.turnWindows[0]!.end_ms,entries[3]!.end_ms);assert.equal(wake.heard_at,new Date(entries[2]!.start_ms).toISOString());
  assert.deepEqual(wake.context!.entries.map(e=>e.text),['今天中午吃什么好呢']);
});

test('another speaker addressing Yimi stays restricted without journal context and opens no identity card',async t=>{
  const f=await fixture(t,[{text:'今天中午我去银行办事',speaker:'owner'},{text:'依米，你好，今天几号',speaker:'speaker:1',wake:0.3,ms:2000,gap_ms:1500}],
    [{text:'你好，今天几号',speaker:'speaker:1'}]);
  const outreach:string[]=[];
  await f.runtime.watchCare(f.glasses,async()=>{outreach.push('glasses');return true;});
  await f.runtime.watchCare(f.phone,async()=>{outreach.push('phone');return true;});
  await f.hear(1);await f.runtime.ownerInput(f.phone);await f.hear(1);const [run]=await f.runs(1);
  await f.runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:'owner',device_id:'glasses',id:'guest-does-not-activate',text:'主人的提醒'});
  assert.deepEqual(outreach,['phone']);
  assert.deepEqual([runScope(run!.d),run!.run_scope,Object.hasOwn(run!,'memory_write')],['owner_uncertain','owner_uncertain',false]);
  assert.equal(run!.guest_key,undefined);assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.equal(wakeOf(run!.d).text,'你好，今天几号');assert.equal(wakeOf(run!.d).context,undefined);
  assert.equal(run!.input.includes('银行'),false,'nothing of the owner\'s journal reaches a guest run');
});

test('a wake turn that turns out to be 依米\'s own voice heard back never runs',async t=>{
  // The ambient pass could not tell (unlabelled); the turn's one identity over its speech is the assistant's voice.
  const f=await fixture(t,[{text:'依米在呢，灯已经关好了',wake:0.25,ms:2000}],[{text:'在呢，灯已经关好了',speaker:'assistant',score:0.62}]);
  await f.hear();assert.deepEqual(f.errors,[]);
  for(let i=0;i<40&&f.turnWindows.length<1;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.turnWindows.length,1,'the turn was analysed');await new Promise(r=>setTimeout(r,50));
  await f.runs(0);assert.deepEqual(await f.storage.list('processed-events'),[]);
});

test('"依米" during a live call stays with that call without ambient analysis; after hang-up the wake word works again',async t=>{
  const hungUp=T0+4000,heard:{device:string;start_ms:number}[]=[];
  const f=await fixture(t,[{text:'依米，帮我叫车去机场',speaker:'owner',wake:0.25,ms:2500},{text:'依米，现在几点',speaker:'owner',wake:0.25,ms:2000,gap_ms:3000}],
    [{text:'现在几点',speaker:'owner'}],{call_heard:(_principal,device,span)=>{heard.push({device,start_ms:span.start_ms});return span.start_ms<hungUp;}});
  await f.hear();assert.deepEqual(f.errors,[]);
  assert.deepEqual(f.heard().map(e=>[e.text,e.wake]),[['依米，现在几点','依米']]);assert.equal(f.analyses(),1);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,2);assert.equal((await f.storage.list('media-continuous-dispositions')).length,1);
  const [run]=await f.runs(1);await new Promise(resolve=>setTimeout(resolve,50));await f.runs(1);
  assert.equal(wakeOf(run!.d).text,'现在几点','only the wake word after the hang-up ran');assert.equal(f.turnWindows.length,1);
  assert.ok(heard.length>=2&&heard.every(h=>h.device==='glasses'));
});

test('an uncertain owner gets no context until "确认是我"; the confirmation carries the conversation read at that moment',async t=>{
  const f=await fixture(t,[{text:'老王说明天下午要下雨',speaker:'speaker:1'},{text:'依米，帮我把明天的会改到上午',speaker:'owner_uncertain',score:0.52,wake:0.25,ms:2400,gap_ms:1500}],
    [{text:'帮我把明天的会改到上午',speaker:'owner_uncertain',score:0.52}]);
  await f.hear();const [run]=await f.runs(1);
  assert.deepEqual([runScope(run!.d),run!.run_scope],['owner_uncertain','owner_uncertain']);
  assert.equal(wakeOf(run!.d).context,undefined);assert.equal(run!.input.includes('下雨'),false);
  const [pending]=await f.runtime.voiceConfirmations(f.phone);assert.equal(pending!.processed_event_id,run!.d.processed_event_id);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  const app=(confirmed.processed_event as ProcessedEvent).content.app_event as unknown as {request_text:string;ambient_context:WakeRequest['context']};
  assert.equal(app.request_text,'帮我把明天的会改到上午');
  assert.deepEqual(app.ambient_context!.entries.map(e=>[e.speaker,e.text]),[['说话人#1','老王说明天下午要下雨']]);
  // A repeated tap replays the same confirmation even after the owner renamed the speaker.
  await f.registry.renameCluster('1',{display_name:'老王'});
  const again=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  assert.deepEqual(again.processed_event,confirmed.processed_event);
  f.finish(run!.run_id);const [, confirmation]=await f.runs(2);assert.equal(confirmation!.run_scope,undefined);
  assert.equal(confirmation!.d.processed_event_id,(confirmed.processed_event as ProcessedEvent).processed_event_id);
});

test('a wake turn is located by its device\'s fresh fix: the owner\'s run gets it, a guest\'s never, a stale fix is not used',async t=>{
  // A weather wake turn needs its device location without exposing it to a visitor.
  const fix=(minutes_ago=0)=>({latitude:31.239700,longitude:121.49980,accuracy_m:65,observed_at:new Date(Date.now()-minutes_ago*60_000).toISOString(),
    datum:'wgs84' as const,place:'上海市陆家嘴（公开地标）'});
  const owner=await fixture(t,[{text:'依米，明天会不会下雨',speaker:'owner',wake:0.25,ms:2200}],[{text:'明天会不会下雨',speaker:'owner'}]);
  const sent=fix();assert.deepEqual(await owner.runtime.locate(owner.glasses,sent),sent);
  assert.equal(await owner.runtime.locate(owner.phone),undefined,'one fix per device');
  await owner.hear();assert.deepEqual(owner.errors,[]);const [run]=await owner.runs(1);
  assert.deepEqual(run!.d.source.location,sent);assert.equal(runScope(run!.d),'owner');
  assert.deepEqual((JSON.parse(run!.input) as ProcessedEvent).source.location,sent,'the owner run reads it');
  const renderedCoordinates=[sent.latitude,sent.longitude].map(value=>JSON.stringify(value));
  for(const coordinate of renderedCoordinates)assert.ok(run!.input.includes(coordinate),'the owner input contains the rendered coordinate');

  const guest=await fixture(t,[{text:'依米，明天会不会下雨',speaker:'speaker:1',wake:0.25,ms:2200}],[{text:'明天会不会下雨',speaker:'speaker:1'}]);
  await guest.runtime.locate(guest.glasses,fix());await guest.hear();const [visitor]=await guest.runs(1);
  assert.equal(runScope(visitor!.d),'owner_uncertain');assert.equal(visitor!.d.source.location,undefined);for(const coordinate of renderedCoordinates)assert.equal(visitor!.input.includes(coordinate),false,'the visitor input must not contain the owner coordinate');

  const stale=await fixture(t,[{text:'依米，明天会不会下雨',speaker:'owner',wake:0.25,ms:2200}],[{text:'明天会不会下雨',speaker:'owner'}]);
  assert.equal(await stale.runtime.locate(stale.glasses,fix(20)),undefined,'older than 15 min');
  await stale.hear();const [late]=await stale.runs(1);assert.equal(late!.d.source.location,undefined);
  const lost=await fixture(t,[{text:'依米，我现在在哪',speaker:'owner',wake:0.25,ms:2200}],[{text:'我现在在哪',speaker:'owner'}]);
  const retained=fix();await lost.runtime.locate(lost.glasses,retained);await lost.runtime.locate(lost.glasses,null);
  await lost.runtime.locate(lost.glasses,retained);await lost.hear();const [missing]=await lost.runs(1);
  assert.equal(missing!.d.source.location,undefined,'provider loss never locates an answer with the retained fix');
});

test('reminder cannot bypass wear ranking through its original ambient device',async t=>{
  const f=await fixture(t,[{text:'周围有人说话',speaker:'speaker:1'}],[],{wear:true});
  await f.runtime.configureTimeline({directory:join(f.storage.root,'reminder-timeline')});
  t.after(await f.runtime.watchCare(f.glasses,async()=>{assert.fail('unworn display');},undefined,undefined,undefined,undefined,undefined,
    {session:'continuity',deliver:async()=>{}}));
  let opened=0;
  t.after(await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{opened++;return true;},{active:()=>false,identified:async()=>true}));
  await f.hear();assert.deepEqual(f.runtime.terminals('owner'),[]);
  await assert.rejects(f.runtime.scheduledDelivery({principal_id:'owner',device_id:'glasses',id:'unworn-reminder',text:'起来走两步',captured_at:new Date().toISOString()}),/CARE_OUTREACH_UNAVAILABLE/);
  assert.equal(opened,0);assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),['起来走两步']);
});

test('a sound observation does not request a location fix or create a proactive run',async t=>{
  const f=await fixture(t,[{text:'',event:'cough',ms:300}],[],{care:true});
  const fix={latitude:25.05,longitude:121.52,accuracy_m:20,observed_at:new Date(Date.now()-16*60_000).toISOString(),datum:'wgs84' as const,place:'台北车站'};
  await f.runtime.locate(f.glasses,fix);let requests=0;
  await f.runtime.watchCare(f.glasses,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'continuity',locate:async()=>{requests++;}});
  await f.hear();await f.runs(0);
  assert.equal(requests,0);assert.equal(f.runtime.timeline!.observations('owner').length,1);
});

test('an uncertain owner\'s wake turn keeps the fix for "确认是我": withheld from the restricted run, carried by the confirmation',async t=>{
  const f=await fixture(t,[{text:'依米，附近有什么好吃的',speaker:'owner_uncertain',score:0.52,wake:0.25,ms:2400}],
    [{text:'附近有什么好吃的',speaker:'owner_uncertain',score:0.52}]);
  const sent={latitude:31.239700,longitude:121.49980,accuracy_m:65,observed_at:new Date(Date.now()-2000).toISOString(),datum:'wgs84' as const};
  await f.runtime.locate(f.glasses,sent);
  // A newer fix wins; a late older one never replaces it.
  // Six decimals: no ISO timestamp (three fraction digits) or hex digest in the run input can contain this text.
  const newer={...sent,latitude:31.239701,observed_at:new Date().toISOString()};
  await f.runtime.locate(f.glasses,newer);assert.deepEqual(await f.runtime.locate(f.glasses,sent),newer);
  await f.hear();const [run]=await f.runs(1);
  assert.deepEqual([runScope(run!.d),run!.run_scope],['owner_uncertain','owner_uncertain']);
  assert.equal(run!.d.source.location,undefined);assert.equal(run!.input.includes(JSON.stringify(newer.latitude)),false,'a restricted run never reads the owner\'s location');
  const [pending]=await f.runtime.voiceConfirmations(f.phone);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  assert.deepEqual((confirmed.processed_event as ProcessedEvent).source.location,newer);
  f.finish(run!.run_id);const [, confirmation]=await f.runs(2);
  assert.equal(confirmation!.run_scope,undefined);assert.deepEqual((JSON.parse(confirmation!.input) as ProcessedEvent).source.location,newer);
  await assert.rejects(f.runtime.locate(f.glasses,{...sent,datum:'gcj02'} as never),/INVALID_CAPTURE_LOCATION/);
});

test('journal tools are owner-only: served in an owner run, refused in guest and uncertain runs; naming relabels old entries',async t=>{
  const f=await fixture(t,[{text:'我是老王，周五一起吃饭吧',speaker:'speaker:1'},{text:'依米，刚才那个人是老王',speaker:'owner',wake:0.25,ms:2000,gap_ms:1500},
    {text:'依米，帮我看看主人的日程',speaker:'speaker:1',wake:0.25,ms:2000,gap_ms:1500},{text:'依米，帮我看看日程',speaker:'owner_uncertain',score:0.5,wake:0.25,ms:2000,gap_ms:1500}],
  [{text:'刚才那个人是老王',speaker:'owner'},{text:'帮我看看主人的日程',speaker:'speaker:1'},{text:'帮我看看日程',speaker:'owner_uncertain',score:0.5}]);
  assert.deepEqual(f.runtime.toolSchemas().map(s=>s.name).filter(n=>n.startsWith('paios_ambient')||n==='paios_speaker_name'),
    ['paios_ambient_journal_search','paios_speaker_name']);
  await f.hear();const [owner]=await f.runs(1);assert.equal(runScope(owner!.d),'owner');
  const found=await f.tool('paios_ambient_journal_search',owner!.run_id,{query:'周五一起'}) as {entries:{speaker:string;text:string}[]};
  assert.deepEqual(found.entries.map(e=>[e.speaker,e.text]),[['说话人#1','我是老王，周五一起吃饭吧']]);
  const secondVoice=new Float32Array(16);secondVoice[6]=1;
  await f.registry.identify(secondVoice,{speech_ms:3000,observed_at:new Date(T0).toISOString(),mode:'observe'});
  const people=await f.registry.clusters();
  await assert.rejects(f.tool('paios_speaker_name',owner!.run_id,{speaker:'说话人#1',also_speaker:'说话人#2',name:''}),/VOICEPRINT_DISPLAY_NAME_INVALID/);
  assert.deepEqual(await f.registry.clusters(),people,'invalid naming cannot merge people through the public owner tool');
  assert.deepEqual(await f.tool('paios_speaker_name',owner!.run_id,{speaker:'说话人#1',also_speaker:'说话人#2',name:'老王'}),
    {status:'named',speaker_ref:'speaker:1',speaker:'老王',display_name:'老王',known_person_id:null});
  const renamed=await f.tool('paios_ambient_journal_search',owner!.run_id,{speaker:'老王'}) as {entries:{speaker:string}[]};
  assert.ok(renamed.entries.length>=1&&renamed.entries.every(e=>e.speaker==='老王'));
  assert.equal((await f.tool('paios_speaker_name',owner!.run_id,{speaker:'说话人#9',name:'x'}) as {error_code:string}).error_code,'SPEAKER_NOT_FOUND');
  await assert.rejects(f.tool('paios_ambient_journal_search',owner!.run_id,{limit:500}),/AMBIENT_SEARCH_INVALID/);
  f.finish(owner!.run_id);
  for(const [count,scope] of [[2,'owner_uncertain'],[3,'owner_uncertain']] as const){
    const run=(await f.runs(count)).at(-1)!;assert.equal(runScope(run.d),scope);
    await assert.rejects(f.tool('paios_ambient_journal_search',run.run_id,{query:'老王'}),/RUN_SCOPE_TOOL_DENIED/);
    await assert.rejects(f.tool('paios_speaker_name',run.run_id,{speaker:'说话人#1',name:'老王'}),/RUN_SCOPE_TOOL_DENIED/);
    f.finish(run.run_id);
  }
});

test('after the reply, the asker goes on without the wake word: a follow-up turn in the owner session with the conversation',async t=>{
  // The answer "杭州" is too short for ambient listening to identify; the turn consumer identifies it with the request.
  const f=await fixture(t,[{text:'一米，帮我看看明天会不会下雨',speaker:'owner',wake:0.2,ms:2500},
    {text:'杭州',ms:600,gap_ms:1500},{text:'那后天呢',speaker:'owner_uncertain',score:0.55,ms:1200,gap_ms:1000}],
  [{text:'帮我看看明天会不会下雨',speaker:'owner'},{text:'杭州',speaker:'owner',score:0.81},{text:'那后天呢',speaker:'owner_uncertain',score:0.55}]);
  const seen:ProcessedEvent[]=[];await f.runtime.watchAmbientTurns(f.glasses,'continuity',d=>seen.push(d));
  await f.hear(1);const [asked]=await f.runs(1);
  await f.reply(asked!,'你在哪个城市？我帮你查明天的天气。');
  await f.hear(1);const [,follow]=await f.runs(2);const entries=f.heard();
  const framing=follow!.d.content.wake_request as unknown as FollowUpRequest;
  assert.deepEqual([framing.kind,framing.text,framing.follows_processed_event_id,framing.opened_processed_event_id],
    ['ambient_follow_up','杭州',asked!.d.processed_event_id,entries[1]!.processed_event_id]);
  assert.deepEqual([runScope(follow!.d),principalAttribution(follow!.d),follow!.run_scope,follow!.session_id],['owner','owner_voice',undefined,'continuity']);
  // Its audio opens with the replied request's speech (from where the wake word ends), its own words from the answer on.
  const asked_range=asked!.d.time_range as {end_ms:number};
  assert.deepEqual(f.turnWindows[1],{start_ms:Date.parse(wakeOf(asked!.d).heard_at),end_ms:entries[1]!.end_ms,
    carrier:{end_ms:asked_range.end_ms,request_start_ms:entries[1]!.start_ms}});
  assert.deepEqual(framing.context!.entries.map(e=>[e.speaker,e.text]),[['主人','一米，帮我看看明天会不会下雨']]);
  // Chained: its reply re-arms the window; an uncertain voice follows up as an uncertain owner, and "确认是我" brings the
  // conversation it was asked in.
  await f.reply(follow!,'杭州明天小雨，记得带伞。');
  await f.hear(1);const [,,chained]=await f.runs(3);
  assert.deepEqual([runScope(chained!.d),chained!.run_scope,(chained!.d.content.wake_request as unknown as FollowUpRequest).follows_processed_event_id],
    ['owner_uncertain','owner_uncertain',follow!.d.processed_event_id]);
  assert.equal((chained!.d.content.wake_request as unknown as FollowUpRequest).context,undefined);
  const [pending]=await f.runtime.voiceConfirmations(f.phone);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  const app=(confirmed.processed_event as ProcessedEvent).content.app_event as unknown as {ambient_context:WakeRequest['context']};
  assert.deepEqual(app.ambient_context!.entries.map(e=>e.text),['一米，帮我看看明天会不会下雨','杭州']);
  assert.deepEqual(seen.map(d=>(d.content.wake_request as unknown as {kind:string}).kind),['ambient_wake','ambient_follow_up','ambient_follow_up'],
    'the app is shown every turn\'s reply');
  assert.deepEqual([f.errors,f.outputErrors],[[],[]]);
});

test('another speaker follow-up stays restricted; unrelated speech first ends the window unanswered',async t=>{
  const f=await fixture(t,[{text:'依米，今天几号',speaker:'speaker:1',wake:0.25,ms:2000},{text:'那明天星期几',speaker:'speaker:1',ms:1400,gap_ms:1200},
    {text:'我们走吧',speaker:'owner',ms:1200,gap_ms:1000},{text:'后天呢',speaker:'speaker:1',ms:1200,gap_ms:800}],
  [{text:'今天几号',speaker:'speaker:1'},{text:'那明天星期几',speaker:'speaker:1'}]);
  await f.hear(1);const [asked]=await f.runs(1);await f.reply(asked!,'今天是十月九号。');
  await f.hear(1);const [,follow]=await f.runs(2);
  assert.deepEqual([runScope(follow!.d),follow!.run_scope,follow!.guest_key,Object.hasOwn(follow!,'memory_write')],['owner_uncertain','owner_uncertain',undefined,false]);
  assert.equal((follow!.d.content.wake_request as unknown as FollowUpRequest).context,undefined);
  await f.reply(follow!,'明天是星期六。');
  await f.hear();await new Promise(resolve=>setTimeout(resolve,50));await f.runs(2);
  assert.equal(f.turnWindows.length,2,'the owner spoke first; the guest\'s next words are ambient speech');
  assert.deepEqual([f.errors,f.outputErrors],[[],[]]);
});


test('local-wake terminals journal server wake detections without opening voice or admitting a fallback turn',async t=>{
  for(const connected of [false,true]) {
    const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25},{text:'几点了',speaker:'owner',gap_ms:2000}],
      [{text:'几点了',speaker:'owner'}],{local_wake:true});
    let opened=0,live=false;
    const stop=await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{opened++;live=true;return true;},
      {active:()=>live,identified:async()=>true});
    if(!connected)stop();
    await f.hear(1);await f.runs(0);
    assert.equal(opened,0);assert.equal(f.turnWindows.length,0);
    assert.equal(f.heard()[0]!.text,'依米，几点了');assert.equal(f.heard()[0]!.wake,'依米');
    if(connected) {
      assert.equal(await f.runtime.openAmbientVoice(f.glasses,'continuity',{id:'local-wake',text:'',
        heard_at:new Date(T0+3000).toISOString(),start_ms:T0+3000,end_ms:T0+3000}),true);
      await f.hear(1);const [run]=await f.runs(1);
      assert.equal(opened,1);assert.equal(wakeOf(run!.d).voice_session_id,'local-wake');assert.equal(runScope(run!.d),'owner');
    }
    assert.deepEqual(f.errors,[]);
  }
});

test('every non-assistant wake opens neutral voice, then existing turn evidence supplies scope before one admission',async t=>{
  for(const speaker of ['owner','owner_uncertain','speaker:1',undefined]) {
    const f=await fixture(t,[{text:'依米，几点了',...(speaker?{speaker}:{}),wake:0.25}],
      [{text:'几点了',...(speaker?{speaker}:{})}]);
    const wakes:import('../src/runtime.ts').AmbientVoiceWake[]=[],identified:{identity:string;d:ProcessedEvent}[]=[];
    let live=true;
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{wakes.push(wake);return true;},{active:()=>live,
      identified:async(_id,d,identity)=>{assert.equal(f.created(),0);identified.push({identity,d});return true;}});
    await f.hear();const [run]=await f.runs(1);
    assert.equal(wakes.length,1);assert.equal('context' in wakes[0]!,false,'opening never grants owner context');
    assert.equal(identified.length,1);assert.equal(identified[0]!.identity,speaker==='owner'?'owner':'owner_uncertain');
    assert.equal(runScope(run!.d),speaker==='owner'?'owner':'owner_uncertain');
    assert.equal(wakeOf(run!.d).voice_session_id,wakes[0]!.id);assert.equal(wakeOf(run!.d).voice_turn,0);
    assert.equal(f.turnWindows.length,1,'all voice sessions reuse processTurn instead of raw call admission');
    assert.equal(Boolean(wakeOf(run!.d).context),speaker==='owner');live=false;
  }
});

test('verified initial ambient requests reach the live front before native admission, while rejected requests retain the existing path',async t=>{
  for(const accepted of [true,false]){
    const f=await fixture(t,[{text:'依米，你好',speaker:'owner',wake:0.25}],[{text:'你好',speaker:'owner'}]);
    const requests:{id:string;d:ProcessedEvent;identity:string}[]=[];
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,identified:async()=>true,
      request:async(id,d,identity)=>{assert.equal(f.created(),0);requests.push({id,d,identity});return accepted;}});
    await f.hear();await f.runs(accepted?0:1);
    assert.equal(requests.length,1);assert.equal(requests[0]!.identity,'owner');
    assert.equal(wakeOf(requests[0]!.d).text,'你好');assert.equal(runScope(requests[0]!.d),'owner');
    assert.deepEqual(f.errors,[]);
  }
});

test('a half-second bare wake opens pending voice and its short request is identified over the existing combined window',async t=>{
  const f=await fixture(t,[{text:'意味？',wake:1,ms:450},{text:'关灯',ms:500}], [{text:'关灯',speaker:'owner'}]);
  const wakes:import('../src/runtime.ts').AmbientVoiceWake[]=[],identities:string[]=[];
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{wakes.push(wake);return true;},
    {active:()=>true,identified:async(_id,_d,identity)=>{identities.push(identity);return true;}});
  await f.hear(1);await f.runs(0);assert.equal(wakes.length,1);assert.equal(wakes[0]!.text,'');assert.equal('context' in wakes[0]!,false);
  assert.equal(identities.length,0);assert.equal(f.turnWindows.length,0,'bare wake has no request to admit');
  await f.hear(1);const [run]=await f.runs(1);assert.deepEqual(identities,['owner']);
  assert.equal(f.turnWindows.length,1);assert.equal(f.turnWindows[0]!.start_ms,T0);
  assert.equal(wakeOf(run!.d).voice_session_id,wakes[0]!.id);assert.equal(wakeOf(run!.d).voice_turn,0);assert.equal(wakeOf(run!.d).text,'关灯');
});

test('active ambient voice bypasses manual call.heard exclusion and identifies later short speech using the same carrier',async t=>{
  let live=false;const f=await fixture(t,[{text:'依米，帮我看明天天气',speaker:'owner',wake:0.25},
    {text:'杭州',ms:500}], [{text:'帮我看明天天气',speaker:'owner'},{text:'杭州',speaker:'owner'}],{call_heard:()=>live,realtime_busy:()=>live});
  let opened=0,wakeId='';const seen:ProcessedEvent[]=[],spoken:string[]=[];
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{opened++;wakeId=wake.id;live=true;return true;},
    {active:()=>live,identified:async(_id,d)=>{seen.push(d);return true;}});
  t.after(await f.runtime.watchCare(f.glasses,async()=>false,async(text,origin)=>{
    assert.equal(origin?.voice_session_id,wakeId);assert.equal(origin?.identity,'owner');spoken.push(text);return true;
  }));
  await f.hear(1);const [first]=await f.runs(1);await f.reply(first!,'你在哪个城市？');
  await f.hear(1);const runs=await f.runs(2);
  assert.equal(opened,1);assert.equal(seen.length,2);assert.equal(f.heard().length,2);assert.equal(f.analyses(),2);
  const later=runs[1]!.d.content.wake_request as {kind:string;voice_session_id:string;voice_turn:number};
  assert.equal(later.kind,'ambient_voice');assert.equal(later.voice_turn,1);assert.equal(later.voice_session_id,wakeOf(first!.d).voice_session_id);
  assert.ok(f.turnWindows[1]!.carrier,'the existing speech carrier identifies a short continuation');
  assert.deepEqual(spoken,['你在哪个城市？']);
});

test('a directed nonowner request stays restricted until later speech actually verifies as owner',async t=>{
  for(const next of ['owner','owner_uncertain']) {
    const f=await fixture(t,[{text:'依米，几点了',speaker:'speaker:1',wake:0.25},{text:'我的名字呢',speaker:next}],
      [{text:'几点了',speaker:'speaker:1'},{text:'我的名字呢',speaker:next}]);
    const identified:ProcessedEvent[]=[];
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,
      identified:async(_id,d)=>{identified.push(d);return true;}});
    await f.hear(1);const [first]=await f.runs(1);f.finish(first!.run_id);
    await f.hear(1);const runs=await f.runs(2);assert.equal(identified.length,2);assert.equal(wakeOf(identified[0]!).context,undefined);
    assert.equal(runScope(runs[1]!.d),next==='owner'?'owner':'owner_uncertain');
    assert.equal(Boolean(wakeOf(runs[1]!.d).context),next==='owner');
    assert.equal(f.turnWindows.length,2,'each directed continuation is analysed using its own evidence');
  }
});

test('unidentified directed speech stays restricted with confirmation, then sufficient owner evidence can verify',async t=>{
  const f=await fixture(t,[{text:'依米，几点了',wake:0.25},{text:'帮我看看我的计划',speaker:'owner'}],
    [{text:'几点了'},{text:'帮我看看我的计划',speaker:'owner'}]);
  const identities:string[]=[];
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,
    identified:async(_id,_d,identity)=>{identities.push(identity);return true;}});
  await f.hear(1);const [first]=await f.runs(1);assert.equal(runScope(first!.d),'owner_uncertain');f.finish(first!.run_id);
  await f.hear(1);const runs=await f.runs(2);assert.deepEqual(identities,['owner_uncertain','owner']);
  assert.equal(runScope(runs[1]!.d),'owner');assert.ok(wakeOf(runs[1]!.d).context);
});

test('uncertain identity confirmation retains voice routing and supplies owner identity before confirmed admission',async t=>{
  const f=await fixture(t,[{text:'依米，几点了',speaker:'owner_uncertain',wake:0.25}],[{text:'几点了',speaker:'owner_uncertain'}]);
  const identified:{identity:string;d:ProcessedEvent}[]=[],seen:ProcessedEvent[]=[],phoneSeen:ProcessedEvent[]=[],prompts:unknown[][]=[];
  await f.runtime.watchCare(f.phone,async()=>true);await f.runtime.watchCare(f.glasses,async()=>true);
  await f.runtime.watchVoiceConfirmations(f.phone,async pending=>{prompts.push(pending);},error=>{throw error;});
  await f.runtime.watchAmbientTurns(f.phone,'continuity',d=>phoneSeen.push(d));
  await f.runtime.watchAmbientTurns(f.glasses,'continuity',d=>seen.push(d));
  const stopVoice=await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,
    identified:async(_id,d,identity)=>{identified.push({identity,d});return true;}});
  await f.hear();const [first]=await f.runs(1);f.finish(first!.run_id);
  const [pending]=await f.runtime.voiceConfirmations(f.phone);
  assert.ok(pending);await until(()=>prompts.at(-1)?.length===1);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  await f.runs(2);assert.deepEqual(identified.map(i=>i.identity),['owner_uncertain','owner']);
  const event=confirmed.processed_event.content.app_event as {voice_session_id:string;voice_turn:number;ambient_context:unknown};
  assert.equal(event.voice_session_id,wakeOf(first!.d).voice_session_id);assert.ok(event.ambient_context);
  assert.equal(seen.length,2,'the original capture connection receives the confirmation once');
  assert.equal(phoneSeen.length,0);assert.equal(confirmed.processed_event.device_id,'glasses');
  assert.equal((await f.runtime.event(f.glasses,'continuity',confirmed.processed_event.processed_event_id)).processed_event.device_id,'glasses');
  assert.equal(event.voice_turn,1);
  stopVoice();
  const repeated=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});
  assert.equal(repeated.processed_event.processed_event_id,confirmed.processed_event.processed_event_id);
  assert.deepEqual(repeated.processed_event.content.app_event,confirmed.processed_event.content.app_event);await f.runs(2);
});

test('call closure during processTurn consumes the voice turn without owner context or admission',async t=>{
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let live=true,identified=0;
  const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25}],[{text:'几点了',speaker:'owner'}],
    {on_turn:async()=>{entered.resolve();await finish.promise;}});
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>live,identified:async()=>{identified++;return true;}});
  const hearing=f.hear();await entered.promise;live=false;finish.resolve();await hearing;await f.runs(0);
  assert.equal(identified,0);assert.equal(f.heard().length,1);
});

test('closure while identity update awaits does not start a main-agent run',async t=>{
  let live=true;const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25}],[{text:'几点了',speaker:'owner'}]);
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>live,identified:async()=>{live=false;return true;}});
  await f.hear();await f.runs(0);assert.equal(f.turnWindows.length,1);
});

test('assistant echo cannot wake or admit; a declined or disconnected voice route keeps one legacy text request',async t=>{
  const echo=await fixture(t,[{text:'依米，几点了',speaker:'assistant',wake:0.25}]);let offers=0;
  await echo.runtime.watchAmbientVoice(echo.glasses,'continuity',async()=>{offers++;return true;},{active:()=>false,identified:async()=>true});await echo.hear();await echo.runs(0);assert.equal(offers,0);
  for(const disconnected of [false,true]) {
    const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25}],[{text:'几点了',speaker:'owner'}]);let opened=0;
    const stop=await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{opened++;return false;},{active:()=>false,identified:async()=>true});if(disconnected)stop();
    await f.hear();const [run]=await f.runs(1);assert.equal(opened,disconnected?0:1);assert.equal(wakeOf(run!.d).voice_session_id,undefined);
  }
});

test('failed partial opening is consumed when its call is inactive and never becomes a text run',async t=>{
  const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25}]);let opened=0;
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{opened++;throw new Error('partial opening');},
    {active:()=>false,identified:async()=>{assert.fail('inactive call cannot identify');}});
  await f.hear();await f.runs(0);assert.equal(opened,1);assert.equal(f.turnWindows.length,0);assert.equal(f.heard().length,1);
});

test('neutral acknowledgment echo preserves a bare wake and is excluded from the short request carrier',async t=>{
  const f=await fixture(t,[{text:'意味？',wake:1,ms:450},{text:'嗯，我在',speaker:'assistant',gap_ms:500},
    {text:'关灯',ms:500,gap_ms:600}], [{text:'关灯',speaker:'owner'}]);
  let opened=0;const identities:string[]=[];
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{opened++;return true;},{active:()=>true,
    identified:async(_id,_d,identity)=>{identities.push(identity);return true;}});
  await f.hear(2);await f.runs(0);assert.equal(opened,1);assert.equal(f.turnWindows.length,0);
  await f.hear(1);const [run]=await f.runs(1);assert.deepEqual(identities,['owner']);
  assert.equal(wakeOf(run!.d).kind,'ambient_wake');assert.equal(f.turnWindows.length,1);
  const carrier=f.turnWindows[0]!.carrier;
  assert.ok(carrier);assert.equal(carrier!.end_ms,f.heard()[0]!.end_ms);
  assert.equal(carrier!.request_start_ms,f.heard()[2]!.start_ms,'the turn worker skips acknowledgment audio between wake carrier and request');
  assert.equal(f.heard()[1]!.speaker,'assistant','echo is journaled but never admitted');
});

test('another speaker followed by unidentified directed speech remains restricted without context',async t=>{
  const f=await fixture(t,[{text:'依米，几点了',speaker:'speaker:1',wake:0.25},{text:'再说一次'}],
    [{text:'几点了',speaker:'speaker:1'},{text:'再说一次'}]);const identities:string[]=[];
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,
    identified:async(_id,_d,identity)=>{identities.push(identity);return true;}});
  await f.hear(1);const [first]=await f.runs(1);f.finish(first!.run_id);await f.hear(1);const runs=await f.runs(2);
  assert.deepEqual(identities,['owner_uncertain','owner_uncertain']);assert.equal(runScope(runs[1]!.d),'owner_uncertain');assert.equal(wakeOf(runs[1]!.d).context,undefined);
});

test('confirmation after the voice call closed uses explicit text admission without a guessed voice ordinal',async t=>{
  const f=await fixture(t,[{text:'依米，几点了',speaker:'owner_uncertain',wake:0.25}],[{text:'几点了',speaker:'owner_uncertain'}]);
  let live=true,identified=0;
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>live,identified:async()=>{identified++;return true;}});
  await f.hear();const [first]=await f.runs(1);f.finish(first!.run_id);live=false;
  const [pending]=await f.runtime.voiceConfirmations(f.phone);assert.ok(pending);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending!.confirmation_id,auth:'face_id'});await f.runs(2);
  const app=confirmed.processed_event.content.app_event as {voice_session_id?:string;voice_turn?:number};
  assert.equal(app.voice_session_id,undefined);assert.equal(app.voice_turn,undefined);assert.equal(identified,1);
  assert.equal(runScope(confirmed.processed_event),'owner','the paired phone confirmation still fulfills the authorized request');
});


test('reserved ambient opening overlaps turn analysis; scope waits for the connected front', async t=>{
  const analysed=Promise.withResolvers<void>(),connect=Promise.withResolvers<boolean>();
  let reserved=false,connected=false,identified=0;
  const f=await fixture(t,[{text:'依米，几点了',speaker:'owner',wake:0.25}],[{text:'几点了',speaker:'owner'}],
    {on_turn:async()=>{assert.equal(connected,false);analysed.resolve();}});
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>{
    reserved=true;const accepted=await connect.promise;connected=accepted;return accepted;
  },{active:()=>reserved,identified:async()=>{assert.equal(connected,true);identified++;return true;}});
  const hearing=f.hear();
  try {
    await analysed.promise;
    assert.equal(identified,0);assert.equal(f.created(),0,'pending connection grants no main-agent admission');
    connect.resolve(true);await hearing;await f.runs(1);assert.equal(identified,1);
  } finally {connect.resolve(false);await hearing;}
});


test('named observations show only a name on worn active glasses without model runs; resubmission keeps fixed instructions',async t=>{
  const f=await fixture(t,[{text:'钥匙在白色碗里',speaker:'speaker:1',gap_ms:5000}],[],{wear:true});
  await f.registry.renameCluster('1',{display_name:'老王'});
  const shown:string[]=[],hints:unknown[]=[];
  await f.runtime.watchCare(f.glasses,async(_id,text)=>{shown.push(text);return true;},undefined,undefined,undefined,undefined,undefined,
    {session:'continuity',deliver:async card=>{hints.push(card);}});
  await f.runtime.wearState(f.glasses,true);await f.hear();assert.equal(f.created(),0);assert.deepEqual(shown,[]);
  assert.deepEqual(hints,[{person_ref:'speaker:1',name:'老王'}]);
  const [heard]=f.heard(),raw:RawEvent={schema_version:'paios.event.v1',event_id:'same-owner-request',device_id:f.phone.device_id,
    device_type:'phone',captured_at:new Date(heard!.end_ms+1).toISOString(),source:{channel:f.phone.channel},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('刚才是谁？')};
  const first=await f.runtime.submit(raw,f.phone,'continuity',true);const [run]=await f.runs(1);
  assert.equal(run!.instructions,'controlled');
  await f.tool('paios_speaker_name',run!.run_id,{speaker:'老王',name:'王师傅'});
  assert.match(JSON.stringify(await f.tool('paios_people',run!.run_id,{})),/王师傅/);
  await f.tool('paios_people',run!.run_id,{recognition_hints:false});
  const replay=await f.runtime.submit(raw,f.phone,'continuity',true);
  assert.equal(replay.processed_event.processed_event_id,first.processed_event.processed_event_id);assert.equal(replay.admission.run_id,run!.run_id);
  assert.equal(f.created(),1,'changed recognition state never changes admission instructions');
  const quiet=await fixture(t,[{text:'你好',speaker:'speaker:1'}],[],{wear:true});
  await quiet.registry.renameCluster('1',{display_name:'老王'});
  let reminders=0;await quiet.runtime.watchCare(quiet.phone,async()=>{reminders++;return true;});
  await quiet.hear();assert.equal(quiet.created(),0);assert.equal(reminders,0,'phone-only owners get no recognition hint');
});

for(const speaker of ['owner_uncertain','speaker:1',undefined])test(`directed wake ${speaker??'no usable identity'} asks only with owner-like uncertain evidence`,async t=>{
 const f=await fixture(t,[{text:'私人的旁边聊天',speaker:'owner'},{text:'依米，帮我查询日程',...(speaker?{speaker,score:speaker==='owner_uncertain'?.52:.9}:{}),wake:.25,gap_ms:1500}],
  [{text:'帮我查询日程',...(speaker?{speaker,score:speaker==='owner_uncertain'?.52:.9}:{})}]);
 const prompts:import('../src/runtime.ts').PendingVoiceConfirmation[][]=[],identities:string[]=[];
 await f.runtime.watchCare(f.phone,async()=>true);
 await f.runtime.watchVoiceConfirmations(f.phone,async pending=>{prompts.push(pending);},error=>{throw error;});
 await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,identified:async(_id,_d,identity)=>{identities.push(identity);return true;}});
 await f.hear();const [run]=await f.runs(1);
 assert.equal(runScope(run!.d),'owner_uncertain');assert.equal(run!.run_scope,'owner_uncertain');assert.equal(Object.hasOwn(run!,'memory_write'),false);
 assert.equal(wakeOf(run!.d).context,undefined);assert.equal(run!.input.includes('私人的旁边聊天'),false);
 const fact=JSON.parse(run!.input).voice_confirmation;
 if(speaker!=='owner_uncertain'){
  assert.equal(fact,null);assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.ok(prompts.every(pending=>pending.length===0));assert.deepEqual(identities,['owner_uncertain']);return;
 }
 assert.ok(fact&&fact.expires_at_ms>Date.now());
 await until(()=>prompts.some(pending=>pending.length===1));const prompt=prompts.flat().find(p=>p.confirmation_id===fact.confirmation_id)!;
 assert.equal(prompt.event_id,`voice-confirm:${fact.confirmation_id}`);assert.equal(prompt.processed_event_id,run!.d.processed_event_id);
 assert.equal(prompt.text,'帮我查询日程');assert.ok(prompt.expires_in_ms>0);
 await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:fact.confirmation_id}),/VOICE_CONFIRMATION_APP_UPDATE_REQUIRED/);
 await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:fact.confirmation_id,auth:'failed'}),/VOICE_CONFIRMATION_BIOMETRIC_INVALID/);
 assert.equal(f.created(),1);assert.equal((await f.runtime.voiceConfirmations(f.phone)).length,1);
 f.finish(run!.run_id);
 const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:fact.confirmation_id,auth:'face_id'});
 assert.equal(runScope(confirmed.processed_event),'owner');await f.runs(2);
 const adopted=confirmed.processed_event.content.app_event as {request_text:string;confirms_processed_event_id:string};
 assert.equal(adopted.request_text,'帮我查询日程');assert.equal(adopted.confirms_processed_event_id,run!.d.processed_event_id);
 assert.deepEqual(identities,['owner_uncertain','owner']);await until(()=>prompts.at(-1)?.length===0);
});

test('unaddressed ambient speech creates neither native requests nor identity cards for uncertain, other and unknown voices',async t=>{
 const f=await fixture(t,[{text:'我去拿一下外卖',speaker:'owner_uncertain'},{text:'好我等你',speaker:'speaker:1',gap_ms:1000},{text:'电视里的背景话',gap_ms:1000}]);
 await f.hear();await f.runs(0);
 assert.equal(f.heard().length,3);assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
 assert.deepEqual(await f.storage.list('voice-confirmations'),[]);assert.deepEqual(f.turnWindows,[]);
});


for(const delivery of ['blocked','failed'] as const)
test(`ambient follow-up carrier is armed before ${delivery} call delivery settles`,async t=>{
  let live=false,wakeId='',entered=false;
  const release=Promise.withResolvers<void>(),f=await fixture(t,[{text:'依米，帮我看明天天气',speaker:'owner',wake:0.25},
    {text:'杭州',ms:500}],[{text:'帮我看明天天气',speaker:'owner'},{text:'杭州',speaker:'owner'}],
    {call_heard:()=>live,realtime_busy:()=>live,notify:async()=>{throw new Error('CONTROLLED_DELIVERY_FAILED');}});
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{wakeId=wake.id;live=true;return true;},
    {active:()=>live,identified:async()=>true});
  t.after(await f.runtime.watchCare(f.glasses,async()=>false,async(_text,origin)=>{
    assert.equal(origin?.voice_session_id,wakeId);assert.equal(origin?.identity,'owner');entered=true;
    if(delivery==='failed')return false;await release.promise;return true;
  }));
  await f.hear(1);const [first]=await f.runs(1);assert.ok(first);
  await f.tool('paios_open_reply',first.run_id,{reply_mode:'text'});f.finish(first.run_id,'你在哪个城市？');
  try{
    await until(()=>entered);await f.hear(1);
    assert.equal(f.turnWindows.length,2);assert.ok(f.turnWindows[1]!.carrier,'sealed source speech is the short follow-up carrier before delivery settles');
  }finally{release.resolve();}
  await f.runs(2);assert.deepEqual(f.errors,[]);
  if(delivery==='failed'){await until(()=>f.outputErrors.some(error=>String(error).includes('CONTROLLED_DELIVERY_FAILED')));
    assert.ok(f.outputErrors.every(error=>String(error).includes('CONTROLLED_DELIVERY_FAILED')),'delivery retries report the same controlled failure');}
  else assert.deepEqual(f.outputErrors,[]);
});

for(const state of ['open','expired'] as const)
test(`sealed directed voice result carries its ${state} confirmation fact from durable origin after the live binding retires`,async t=>{
 let clock=Date.now();if(state==='expired')t.mock.method(Date,'now',()=>clock);
 const f=await fixture(t,[{text:'依米，帮我查日程',speaker:'owner_uncertain',score:.52,wake:.25}],[{text:'帮我查日程',speaker:'owner_uncertain',score:.52}]);
 const spoken:{text:string;origin:import('../src/runtime.ts').VoiceResultOrigin|undefined}[]=[];
 const stop=await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,identified:async()=>true});
 t.after(await f.runtime.watchCare(f.glasses,async()=>false,async(text,origin)=>{spoken.push({text,origin});return true;}));
 await f.hear();const [run]=await f.runs(1);assert.ok(run);
 const fact=JSON.parse(run.input).voice_confirmation;assert.ok(fact&&fact.expires_at_ms>Date.now());
 const voiceId=wakeOf(run.d).voice_session_id;assert.ok(voiceId);stop();
 if(state==='expired')clock=fact.expires_at_ms+1;
 await f.reply(run,'本轮没能确认声音。');await until(()=>spoken.length===1);
 assert.equal(spoken[0]!.text,'本轮没能确认声音。');
 assert.equal(spoken[0]!.origin?.identity,'owner_uncertain');assert.equal(spoken[0]!.origin?.voice_session_id,voiceId);
 assert.deepEqual(spoken[0]!.origin?.voice_confirmation,state==='open'?fact:null);
 assert.deepEqual(spoken[0]!.origin?.voice_confirmation,f.runtime.voiceConfirmationFact(run.d));
 await f.runtime.persistCallResult(f.glasses,'continuity',run.d.processed_event_id);
 assert.equal(spoken.length,1,'the existing sealed delivery journal prevents a second reply path');
 assert.deepEqual(f.outputErrors,[]);
});

test('sealed voice delivery refreshes the card after terminal discovery waits for a real Face ID decision',async t=>{
 const f=await fixture(t,[{text:'依米，帮我查日程',speaker:'owner_uncertain',score:.52,wake:.25}],[{text:'帮我查日程',speaker:'owner_uncertain',score:.52}]);
 const spoken:import('../src/runtime.ts').VoiceResultOrigin[]=[];
 const stop=await f.runtime.watchAmbientVoice(f.glasses,'continuity',async()=>true,{active:()=>true,identified:async()=>true});
 t.after(await f.runtime.watchCare(f.glasses,async()=>false,async(_text,origin)=>{assert.ok(origin);spoken.push(origin);return true;}));
 await f.hear();const [run]=await f.runs(1);assert.ok(run);stop();
 const fact=f.runtime.voiceConfirmationFact(run.d);assert.ok(fact);
 const runtime=f.runtime as unknown as {connectedTerminals:(principal?:string)=>Promise<unknown[]>};
 const connected=runtime.connectedTerminals.bind(runtime);let decided=false;
 t.mock.method(runtime,'connectedTerminals',async(principal?:string)=>{
  const watchers=await connected(principal);
  if(!decided){decided=true;assert.deepEqual(f.runtime.voiceConfirmationFact(run.d),fact);
   await f.runtime.confirmVoice(f.phone,{confirmation_id:fact.confirmation_id,auth:'face_id'});
   assert.equal(f.runtime.voiceConfirmationFact(run.d),null);}
  return watchers;
 });
 await f.reply(run,'本轮没能确认声音。');await until(()=>spoken.length===1);
 assert.equal(decided,true);assert.equal(spoken[0]!.identity,'owner_uncertain');
 assert.equal(spoken[0]!.voice_confirmation,null,'a decided card is not advertised by the already sealed reply');
 assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);assert.deepEqual(f.outputErrors,[]);
});

// The real source authority owns validation; its awaited boundary exposes a delayed automatic decision without timeouts.
test('an automatic wake delayed at source validation cannot replace a pending or live explicit dial binding',async t=>{
  for(const phase of ['pending','live']){
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let armed=false,blocked=false,validations=0;
    const f=await fixture(t,[{text:'依米',wake:1,ms:450},{text:'关灯',speaker:'owner'}],[{text:'关灯',speaker:'owner'}],
      {on_audio:()=>{if(!blocked)armed=true;},revalidate:async()=>{if(armed&&++validations===2){blocked=true;entered.resolve();await release.promise;}}});
    const dialEntered=Promise.withResolvers<void>(),dialRelease=Promise.withResolvers<void>(),requests:ProcessedEvent[]=[],identified:string[]=[],opened:string[]=[];
    let active:string|undefined;
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{opened.push(wake.id);if(wake.id==='dial'){
      dialEntered.resolve();await dialRelease.promise;active='dial';return true;}active=wake.id;return true;},
      {active:id=>active===id,identified:async id=>{identified.push(id);return true;},request:async(_id,d)=>{requests.push(d);return true;}});
    const hearing=f.hear(1);await entered.promise;
    const dialing=f.runtime.openAmbientVoice(f.glasses,'continuity',{id:'dial',intent:'dial',text:'',heard_at:new Date(T0).toISOString(),start_ms:T0,end_ms:T0});
    try {
      assert.equal(await Promise.race([dialEntered.promise.then(()=>true),dialing.then(()=>false)]),true,'an explicit dial reaches the sole call owner');
      if(phase==='live'){dialRelease.resolve();assert.equal(await dialing,true);}
      release.resolve();await hearing;dialRelease.resolve();assert.equal(await dialing,true);
      await f.hear(1);assert.deepEqual(opened,['dial']);assert.deepEqual(identified,['dial']);
      assert.equal(requests.length,1);assert.equal(wakeOf(requests[0]!).voice_session_id,'dial');assert.equal(wakeOf(requests[0]!).voice_turn,0);
      assert.equal(f.created(),0);assert.deepEqual(f.errors,[]);
    } finally {release.resolve();dialRelease.resolve();await Promise.allSettled([hearing,dialing]);}
  }
});

test('late scheduled care cannot replace a pending or live explicit dial binding',async t=>{
  for(const phase of ['pending','live']){
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let armed=false;const notices:string[]=[];
    const f=await fixture(t,[{text:'环境里的普通话'},{text:'关灯',speaker:'owner'}],[{text:'关灯',speaker:'owner'}],
      {notify:async notice=>{notices.push(notice.body);},revalidate:async()=>{if(armed){armed=false;entered.resolve();await release.promise;}}});await f.hear(1);
    const dialEntered=Promise.withResolvers<void>(),dialRelease=Promise.withResolvers<void>(),requests:ProcessedEvent[]=[],identified:string[]=[],opened:string[]=[];
    let active:string|undefined;
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{opened.push(wake.id);if(wake.id==='dial'){
      dialEntered.resolve();await dialRelease.promise;active='dial';return true;}active=wake.id;return true;},
      {active:id=>active===id,identified:async id=>{identified.push(id);return true;},request:async(_id,d)=>{requests.push(d);return true;}});
    armed=true;const care=f.runtime.scheduledDelivery({principal_id:'owner',device_id:'glasses',id:'late-care',text:'休息一下',captured_at:new Date(T0).toISOString()});await entered.promise;
    const dialing=f.runtime.openAmbientVoice(f.glasses,'continuity',{id:'dial',intent:'dial',text:'',heard_at:new Date(T0).toISOString(),start_ms:T0,end_ms:T0});
    try {
      assert.equal(await Promise.race([dialEntered.promise.then(()=>true),dialing.then(()=>false)]),true);
      if(phase==='live'){dialRelease.resolve();assert.equal(await dialing,true);}
      release.resolve();await care;assert.deepEqual(notices,['休息一下']);dialRelease.resolve();assert.equal(await dialing,true);
      await f.hear(1);assert.deepEqual(opened,['dial']);assert.deepEqual(identified,['dial']);
      assert.equal(requests.length,1);assert.equal(wakeOf(requests[0]!).voice_session_id,'dial');assert.equal(f.created(),0);assert.deepEqual(f.errors,[]);
    } finally {release.resolve();dialRelease.resolve();await Promise.allSettled([care,dialing]);}
  }
});

test('a declined public automatic opening preserves a pending or live explicit dial binding',async t=>{
  for(const phase of ['pending','live']){
    const f=await fixture(t,[{text:'关灯',speaker:'owner'}],[{text:'关灯',speaker:'owner'}]);
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),requests:ProcessedEvent[]=[],identified:string[]=[];let active:string|undefined;
    await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{if(wake.id!=='dial')return false;
      entered.resolve();await release.promise;active='dial';return true;},
      {active:id=>active===id,identified:async id=>{identified.push(id);return true;},request:async(_id,d)=>{requests.push(d);return true;}});
    const dialing=f.runtime.openAmbientVoice(f.glasses,'continuity',{id:'dial',intent:'dial',text:'',heard_at:new Date(T0).toISOString(),start_ms:T0,end_ms:T0});await entered.promise;
    try {
      if(phase==='live'){release.resolve();assert.equal(await dialing,true);}
      assert.equal(await f.runtime.openAmbientVoice(f.glasses,'continuity',{id:'automatic',text:'',heard_at:new Date(T0).toISOString(),start_ms:T0,end_ms:T0}),false);
      release.resolve();assert.equal(await dialing,true);await f.hear();
      assert.deepEqual(identified,['dial']);assert.equal(requests.length,1);assert.equal(wakeOf(requests[0]!).voice_session_id,'dial');assert.equal(f.created(),0);assert.deepEqual(f.errors,[]);
    } finally {release.resolve();await Promise.allSettled([dialing]);}
  }
});

test('a replacement explicit dial keeps uncertain speech restricted until the existing Face ID confirmation verifies its owner',async t=>{
  const f=await fixture(t,[{text:'我的计划呢',speaker:'owner_uncertain'}],[{text:'我的计划呢',speaker:'owner_uncertain'}]);
  const identified:{id:string;identity:string;d:ProcessedEvent}[]=[];let active:string|undefined;
  await f.runtime.watchCare(f.phone,async()=>true);await f.runtime.watchCare(f.glasses,async()=>true);
  await f.runtime.watchAmbientVoice(f.glasses,'continuity',async wake=>{active=wake.id;return true;},
    {active:id=>active===id,identified:async(id,d,identity)=>{identified.push({id,identity,d});return true;}});
  const dial=(id:string)=>f.runtime.openAmbientVoice(f.glasses,'continuity',{id,intent:'dial',text:'',heard_at:new Date(T0).toISOString(),start_ms:T0,end_ms:T0});
  assert.equal(await dial('retired'),true);assert.equal(await dial('dial'),true);
  await f.hear();const [first]=await f.runs(1);f.finish(first!.run_id);
  assert.deepEqual(identified.map(({id,identity})=>[id,identity]),[['dial','owner_uncertain']]);
  assert.equal(runScope(first!.d),'owner_uncertain');assert.equal(wakeOf(first!.d).context,undefined);assert.equal(wakeOf(first!.d).voice_session_id,'dial');
  const [pending]=await f.runtime.voiceConfirmations(f.phone);assert.ok(pending);
  const confirmed=await f.runtime.confirmVoice(f.phone,{confirmation_id:pending.confirmation_id,auth:'face_id'});await f.runs(2);
  assert.deepEqual(identified.map(({id,identity})=>[id,identity]),[['dial','owner_uncertain'],['dial','owner']]);
  assert.equal(principalAttribution(confirmed.processed_event),'owner_confirmation');assert.equal(runScope(confirmed.processed_event),'owner');
  const route=confirmed.processed_event.content.app_event as {voice_session_id:string;voice_turn:number;ambient_context:unknown};
  assert.equal(route.voice_session_id,'dial');assert.equal(route.voice_turn,1);assert.ok(route.ambient_context);assert.deepEqual(f.errors,[]);
});
