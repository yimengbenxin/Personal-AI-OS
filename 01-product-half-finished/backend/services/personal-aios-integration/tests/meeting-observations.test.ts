import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeFixture} from './scope-grant-fixture.ts';
import {MeetingObservations} from '../src/meeting/observations.ts';
import {meetingSpeaker} from '../src/meeting/speakers.ts';
import {digest,type ProcessedEvent} from '../src/contracts.ts';

test('meeting requires both trusted devices fresh within 30s; one device cannot restore the aggregate',async t=>{
  const f=await scopeFixture(t),meeting=new MeetingObservations(f.storage,f.authority,f.now);
  meeting.evidence('owner','mac:demo');meeting.evidence('owner','glasses:demo');
  const row=await meeting.open({...f.input,glasses_device_id:'glasses:demo'});
  const bound=await meeting.bindRun('owner',row.id,{run_id:'run:trusted',session_id:'conversation'});assert.equal(bound.target_device_id,'mac:demo');
  await meeting.guard('owner',row.id);const signal=meeting.signal(row.id);
  f.advance(30001);await assert.rejects(meeting.guard('owner',row.id),/MEETING_CONNECTION_REQUIRED/);
  assert.equal(signal.aborted,true);meeting.evidence('owner','mac:demo');
  await assert.rejects(meeting.guard('owner',row.id),/MEETING_CONNECTION_REQUIRED/);
  meeting.evidence('owner','glasses:demo');await meeting.guard('owner',row.id);
  assert.equal(meeting.signal(row.id).aborted,false);
  meeting.disconnected('owner','mac:demo');await meeting.sweep();f.advance(60000);
  await assert.rejects(meeting.guard('owner',row.id),/MEETING_SESSION_ENDED/);
});

test('derived records contain only anonymous other words and evidence; stale media remains privacy-scoped',async t=>{
  const f=await scopeFixture(t),meeting=new MeetingObservations(f.storage,f.authority,f.now);
  meeting.evidence('owner','mac:demo');meeting.evidence('owner','glasses:demo');
  const row=await meeting.open({...f.input,glasses_device_id:'glasses:demo'});
  const d={principal_id:'owner',device_id:'glasses:demo',raw_ref:'l5:demo',archive_revision:'rev:demo',segment_id:'segment:demo',
    processed_event_id:'processed:demo',time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:f.now(),end_ms:f.now()+100},
    content:{audio_observations:[{segments:[{speaker:'owner',text:'主人原话'},
      {speaker:'speaker:meeting-other',text:'<|HAPPY|>改成六十家',emotion:'happy',face:'secret'}]}]}} as unknown as ProcessedEvent;
  assert.equal(await meeting.observe(d),true);
  const words=await meeting.words('owner',row.id);assert.equal(words.length,1);assert.equal(words[0]!.text,'改成六十家');
  assert.equal(JSON.stringify(words).includes('happy'),false);assert.equal(JSON.stringify(words).includes('主人原话'),false);
  f.advance(1000);await meeting.end('owner',row.id,'privacy_pause');
  assert.equal((await meeting.purpose('owner','glasses:demo',d.time_range))?.id,row.id);
  assert.equal(await meeting.analysisPurpose('owner','glasses:demo',d.time_range),'meeting_paused');
  assert.equal(await meeting.observe({...d,processed_event_id:'processed:late'}),true);
  assert.equal((await meeting.words('owner',row.id)).length,1);
});

test('S13 meeting verification never learns, names guests, or accepts mixed/call-only/assistant identity',async()=>{
  const calls:any[]=[];let n=0;
  const engine={speaker_model:{id:'fixture',sha256:digest('speaker'),dim:2},embed:async()=>Float32Array.of(1,0)};
  const speakers={model:engine.speaker_model,identify:async(_e:any,input:any)=>{calls.push(input);return n++===0?
    {kind:'owner' as const,band:'verified' as const,score:.9}:{kind:'unknown' as const,reason:'unmatched' as const};}};
  const result=await meetingSpeaker(engine,speakers,new Float32Array(96000),{principal_id:'owner',device_id:'glasses',observed_at:new Date().toISOString()},new AbortController().signal);
  assert.equal(result,undefined);assert.ok(calls.every(c=>c.mode==='verify'&&c.learning===false&&c.channel==='glasses'));
  for(const identity of [{kind:'owner',band:'verified',score:.9,call_only:true},{kind:'owner',band:'verified',score:.9,trust_window:true},
    {kind:'unknown',reason:'too_short'},{kind:'assistant',score:.9}]){
    const r=await meetingSpeaker(engine,{...speakers,identify:async()=>identity as any},new Float32Array(32000),{observed_at:new Date().toISOString()},new AbortController().signal);
    assert.equal(r?.label,identity.kind==='assistant'?'assistant':undefined);
  }
});

test('the real media entry uses words-only ASR and S13 verify before journal, preserving exact L5 PCM',async t=>{
  const {controlledEngine,transcribeWindow}=await import('./speech-fixture.ts');
  const engine=controlledEngine(),calls:any[]=[];
  engine.transcribe=async()=>{assert.fail('tagged ASR must not run');};
  engine.tag=async()=>{assert.fail('sound/emotion classifier must not run');};
  engine.transcribeWords=async()=>'<|HAPPY|>这里改成六十家';
  const speakers={model:engine.speaker_model,identify:async(_embedding:any,input:any)=>{calls.push(input);return {kind:'unknown' as const,reason:'unmatched' as const};}};
  const pcm=Buffer.alloc(64000);for(let n=0;n<32000;n++)pcm.writeInt16LE(1,n*2);
  const {d,observation}=await transcribeWindow(t,pcm,engine,speakers,Date.parse('2026-10-26T00:00:00Z'),'utterance',undefined,'meeting');
  assert.equal(d.content.transcript,'这里改成六十家');assert.equal(observation.segments[0]!.speaker,'speaker:meeting-other');
  assert.ok(calls.length>0&&calls.every(c=>c.mode==='verify'&&c.learning===false));
  assert.equal(JSON.stringify(d).includes('happy'),false);assert.equal(JSON.stringify(d).includes('emotion'),false);
  assert.equal(observation.model.native_metadata.wake_spotting,false);
});


test('paused meeting evidence archives through the normal media path without speech/tag/identity inference',async t=>{
  const {controlledEngine,transcribeWindow}=await import('./speech-fixture.ts');
  const engine=controlledEngine();engine.transcribe=async()=>{assert.fail('paused ASR');};
  engine.transcribeWords=async()=>{assert.fail('paused words');};engine.embed=async()=>{assert.fail('paused identity');};
  const pcm=Buffer.alloc(64000);for(let n=0;n<32000;n++)pcm.writeInt16LE(1,n*2);
  const {d}=await transcribeWindow(t,pcm,engine,undefined,Date.parse('2026-10-26T00:00:00Z'),'utterance',undefined,'meeting_paused');
  assert.equal(d.content.transcript,'');
});
