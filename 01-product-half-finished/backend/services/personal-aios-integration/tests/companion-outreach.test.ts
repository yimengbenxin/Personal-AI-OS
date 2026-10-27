import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionOutreach} from '../src/voice/companion-outreach.ts';
import {DashScopeTts} from '../src/tts.ts';
import {FakeSpeechSocket,fakeQwenConfiguration,fakeTtsConfiguration} from './speech-fixture.ts';

test('companion results use formal OUT; publication is pending, with no invented rendered or played ACK',async()=>{
  let inCall=true,callback:any,subscriptions=0;const published:any[]=[];
  const outreach=new CompanionOutreach({available:async()=>!inCall,subscribe:async(_notice,receive)=>{subscriptions++;callback=receive;return()=>{};},
    publish:async(_notice,value)=>{published.push(value);},error:assert.fail},()=>1000);
  const notice={key:'processed:demo',principal_id:'owner',device_id:'glasses',session_id:'native-conversation',expires_at:5000,signal:new AbortController().signal};
  assert.equal(await outreach.offer(notice),'pending');assert.equal(subscriptions,0);
  inCall=false;await outreach.tick();assert.equal(subscriptions,1);
  const value={result:{reply_text:'好，我在后台改，你接着讲。',reply_mode:'text_and_voice',reply_epoch:2,output_plan:[{target_device_id:'glasses'}],voice_status:'ready'},chunks:[],voice_chunks:[]};
  await callback(value);assert.equal(published[0],value);assert.equal('played' in published[0],false);
  outreach.close();
});

test('call voice is read from existing configuration; the TTS model/provider and saved voice config stay untouched',async()=>{
  const messages:any[]=[];class Socket extends FakeSpeechSocket {send(text:string){messages.push(JSON.parse(text));super.send(text);}}
  const configuration={...fakeQwenConfiguration(Socket),call:{model:'configured-call-model',dialect:'nested-audio' as const,voice:'configured-call-voice'}};
  const synthesis={...fakeTtsConfiguration};const before=structuredClone(synthesis);
  const tts=new DashScopeTts(configuration,synthesis);
  try{await tts.forCall().synthesize('原样短句。','companion');assert.equal(messages[0].payload.parameters.voice,'configured-call-voice');
    assert.equal(messages[0].payload.model,synthesis.model);assert.deepEqual(synthesis,before);assert.equal(tts.voice,synthesis.voice);
  }finally{tts.close();}
});

test('real OUT authority distinguishes accepted, rendered and played using the same call-voice result epoch',async t=>{
  const {scopeFixture}=await import('./scope-grant-fixture.ts');const {UnifiedIngress}=await import('../src/ingress.ts');
  const {RawArchive}=await import('../src/archive.ts');const {OutputAuthority}=await import('../src/output.ts');
  const f=await scopeFixture(t),at=new Date(f.now()).toISOString(),d=await new UnifiedIngress(new RawArchive(f.storage,4096,()=>at)).accept({schema_version:'paios.event.v1',event_id:'event:out',device_id:'glasses',device_type:'glasses',captured_at:at,source:{channel:'fixture'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',payload:Buffer.from('{"kind":"stage_result"}')},
    {principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'fixture',consent_ref:'consent',submission:'observation'});
  const ctx={principal_id:'owner',run_id:'run',session_id:'session',tool_call_id:'call',d,speech_role:'call' as const,target:{device_id:'glasses',device_type:'glasses' as const,route_version:'route',output_modes:['text','voice']}};
  const tts=new DashScopeTts({...fakeQwenConfiguration(),call:{model:'existing-call',voice:'existing-call-voice'}},fakeTtsConfiguration),out=new OutputAuthority(f.storage,{tts});
  const done=Promise.withResolvers<void>();out.setVoiceOwner(async context=>{if((await out.readFinalized(context)).result.voice_status==='ready')done.resolve();});
  t.after(async()=>{await out.close();tts.close();});await out.openAdmittedPrompt(ctx,'text_and_voice');
  await out.seal(ctx,{run_id:'run',session_id:'session',conversation_session_id:'session',status:'completed',output:'好，我在后台改。'});await done.promise;
  let value=await out.readFinalized(ctx);const text=value.chunks[0]!,voice=value.voice_chunks[0]!;
  const ack=(chunk:any,status:'accepted'|'rendered'|'played')=>({output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:1,status,observed_at:at});
  await out.ack(ctx,ack(text,'accepted'));await out.ack(ctx,ack(voice,'accepted'));
  value=await out.readFinalized(ctx);assert.equal(value.rendered_text_through_seq,0);assert.equal(value.pending_voice_chunk_count,1);
  await out.ack(ctx,ack(text,'rendered'));assert.equal((await out.readFinalized(ctx)).rendered_text_through_seq,1);
  await out.ack(ctx,ack(voice,'played'));assert.equal((await out.readFinalized(ctx)).pending_voice_chunk_count,0);
  await assert.rejects(out.ack(ctx,{...ack(voice,'played'),target_device_id:'another-glasses'}),/BINDING_MISMATCH/);
});
