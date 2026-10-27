import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {meetingFixture} from './meeting-fixture.ts';
import {CapabilityGateway,type GatewayCall,type GatewayBinding} from '../src/capability/gateway.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {CapabilityConfirmations} from '../src/capability/consent/confirmation.ts';
import type {FrozenCall} from '../src/capability/consent/call.ts';
import {VoiceConfirmations} from '../src/voiceprint/confirmation.ts';
import {confirmFrozenEffect,effectConsent} from '../src/effect-consent.ts';
import {ActivityProjection} from '../src/activity.ts';
import {carryMeetingReceipts} from '../src/meeting/history.ts';
import {recordFacts} from '../src/capability/renderer.ts';
import {presentationResult} from '../../../phase0/gateway/src/presentation-relay.ts';
import {validatePresentationInput} from '../src/presentation-validate.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {DashScopeTts} from '../src/tts.ts';
import {fakeQwenConfiguration,fakeTtsConfiguration} from './speech-fixture.ts';

const root=new URL('../../../../../',import.meta.url).pathname;
test('PC1 full chain: actual package/loopback → frozen confirmation → exact relay fake → ledger/page card → next-run evidence',async t=>{
  const f=await meetingFixture(t);const invoke=f.ports.invoke;
  f.ports.invoke=async(binding,action,args,signal)=>{validatePresentationInput(action,args,binding,f.now());
    return presentationResult(action,args,JSON.parse(JSON.stringify(await invoke(binding,action,args,signal))));};
  const server=createServer(async(req,res)=>{try{
    assert.equal(req.url,'/internal/meeting/call');assert.equal(req.headers.authorization,'Bearer demo-only-token');
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(body.args.context,f.context);
    const value=body.method==='prepare'?await f.service.prepare('owner',f.context,body.tool,body.args):await f.service.call('owner',f.context,body.tool,body.args);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  }catch(error){res.writeHead(409);res.end(JSON.stringify({error:String(error)}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  const mcp=(tool:string,args:object)=>new Promise<any>((resolve,reject)=>{
    const child=spawn(process.env.PAIOS_HERMES_PYTHON??'python3',[root+'capability/packages/meeting-assistant/tests/pc1_client.py'],
      {cwd:root,env:{...process.env,PYTHONPATH:root,PAIOS_INTEGRATION_PORT:String(port),PAIOS_HERMES_INTERNAL_KEY:'demo-only-token'},timeout:30000});
    let out='',err='';child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});child.on('error',reject);
    child.on('exit',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({tool,args:{target_id:f.target.target_id,context:f.context,...args}}));
  });
  const read=await mcp('read_deck',{}),snapshot=read.structuredContent.content.find((c:any)=>c.key==='snapshot_ref').text;
  const word=(await f.observations.words('owner',f.workspace.scope_session_id))[0]!;
  const located=await mcp('locate_region',{utterance_id:word.utterance_id,snapshot_ref:snapshot,frame_refs:[f.frame_ref]});
  const suggestion=JSON.parse(located.structuredContent.content.find((c:any)=>c.key==='suggestion').text);
  const planned=await mcp('plan_text',{suggestion_ids:[suggestion.id],base_snapshot_ref:snapshot});
  const plan=JSON.parse(planned.structuredContent.content.find((c:any)=>c.key==='text_plan').text);
  const args={target_id:f.target.target_id,context:f.context,plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,idempotency_key:'chain:one'};
  const prepared=await f.service.prepare('owner',f.context,'apply_text',args),cards=new VoiceConfirmations(f.storage,{now:f.now});
  const admission={...f.bound,record:{...f.bound.record,run_id:f.context.run_id,session_id:f.context.session_id}};
  let frozen:FrozenCall,gateway:CapabilityGateway,service:CapabilityConfirmations;
  const binding:GatewayBinding={principal_id:'owner',run_id:f.context.run_id,scope:'owner',invocation:'background'};
  const call:GatewayCall={tool_name:'mcp__meeting_assistant__apply_text',args,task_id:'main',session_id:f.context.session_id,
    tool_call_id:f.context.tool_call_id,api_request_id:'opaque-provider-attempt',turn_id:'turn:chain'};
  gateway=new CapabilityGateway(f.storage,async(_binding,gated,_tool,effect,target)=>{
    frozen={tool_name:gated.tool_name,task_id:gated.task_id,args:gated.args,idempotency_key:args.idempotency_key,admission,check_with:'edit_status',
      consent:{context:f.context,effect:effect as any,target,task_type:'document.text.update',operation_kind:'document.text.update',owner_requested:false,
        scope_allowed:true,consent_required:true,invocation:'background',scope:(await f.authority.prepare(f.context,target,'document.text.update','owner_data'))!,...prepared.consent}};
    return service.decide(frozen);
  },packageCatalog({enabled:['meeting-assistant'],gateway:['meeting-assistant']}));
  service=new CapabilityConfirmations(f.storage,cards,{
    gates:(saved,approved)=>({...f.gates,scopes:f.authority.forOwner(async()=>'owner'),effectConsent:(context,effect,_approved,ride,request,confirmation,force)=>approved?
      confirmFrozenEffect(f.effectPorts,saved.admission,context,effect,ride===true,request!,confirmation!,force):effectConsent(f.effectPorts,context,effect,false,false,'',undefined,force)}),
    execute:async saved=>(await mcp('apply_text',saved.args)).structuredContent,
    receipt:async(saved,receipt,phase)=>{await gateway.ledger.admit(binding,{task_id:saved.task_id,tool_call_id:f.context.tool_call_id,tool_name:saved.tool_name,args:saved.args,phase},receipt);},
    followUp:async()=>{},error:assert.fail});
  t.after(async()=>{await service.close();cards.close();});
  assert.equal((await gateway.decide(binding,call)).action,'block');assert.equal(f.writes(),0);
  const waiting=await gateway.ledger.current(binding);assert.equal(waiting[0]!.receipt.work_items![0]!.state,'waiting');
  const activity=new ActivityProjection('owner','session','processed',()=>{},f.now);t.after(()=>activity.close());activity.receipts(waiting);
  assert.equal(activity.card!.state,'waiting');assert.deepEqual(activity.card!.progress,{version:1,value:0,total:1});
  const card=cards.list('owner').find(c=>c.kind==='capability_call')!;assert.ok(card);
  await assert.rejects(service.answer(card.confirmation_id,{principal_id:'other',device_id:'mac:other',device_type:'mac'},'approve'));
  assert.equal(f.writes(),0);await service.answer(card.confirmation_id,{principal_id:'owner',device_id:'mac:demo',device_type:'mac'},'approve');
  assert.equal((await f.storage.list('scope-grants')).length,1);const result=await service.settle(card);assert.equal(result.status.state,'succeeded');assert.equal(f.writes(),1);
  const receipts=await gateway.ledger.current(binding);activity.receipts(receipts);assert.deepEqual(activity.card!.progress,{version:1,value:1,total:1});
  await f.observations.bindRun('owner',f.workspace.scope_session_id,{run_id:'run:next',session_id:'session:next'});
  await carryMeetingReceipts(f.storage,gateway.ledger,'owner',f.workspace.scope_session_id,'run:next');
  const next=await gateway.ledger.current({principal_id:'owner',run_id:'run:next'});assert.equal(next[0]!.id,receipts[0]!.id);
  assert.ok(recordFacts(next,'run:next').some(fact=>fact.kind==='progress'&&fact.quantities?.some(q=>q.value===1)));
  assert.equal((await gateway.decide(binding,call)).action,'block');assert.equal(f.writes(),1);
  const at=new Date(f.now()).toISOString(),d=await new UnifiedIngress(new RawArchive(f.storage,4096,()=>at)).accept({schema_version:'paios.event.v1',event_id:'chain:stage',
    device_id:'glasses:demo',device_type:'glasses',captured_at:at,source:{channel:'fixture'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',payload:Buffer.from('{"kind":"stage_result"}')},
    {principal_id:'owner',device_id:'glasses:demo',device_type:'glasses',channel:'fixture',consent_ref:'consent:demo',submission:'observation'});
  const ctx={principal_id:'owner',run_id:'run:next',session_id:'session:next',tool_call_id:'call:out',d,speech_role:'call' as const,report_budget:{max_characters:48},
    target:{device_id:'glasses:demo',device_type:'glasses' as const,route_version:'route:demo',output_modes:['text','voice']}};
  const tts=new DashScopeTts({...fakeQwenConfiguration(),call:{model:'existing-call',voice:'existing-call-voice'}},fakeTtsConfiguration);
  const out=new OutputAuthority(f.storage,{tts,capability:gateway}),done=Promise.withResolvers<void>();
  out.setVoiceOwner(async context=>{if((await out.readFinalized(context)).result.voice_status==='ready')done.resolve();});
  t.after(async()=>{await out.close();tts.close();});await out.openAdmittedPrompt(ctx,'text_and_voice');
  await out.seal(ctx,{run_id:ctx.run_id,session_id:ctx.session_id,conversation_session_id:ctx.session_id,status:'completed',output:'都改好了，一处。'});await done.promise;
  let value=await out.readFinalized(ctx);assert.ok([...value.result.reply_text].length<=48,value.result.reply_text);
  assert.equal(value.result.voice_status,'ready');assert.ok(value.voice_chunks.length>0);assert.equal(value.rendered_text_through_seq,0);
  const ack=(chunk:any,status:'accepted'|'rendered'|'played')=>({output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,
    target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:1,status,observed_at:at});
  await out.ack(ctx,ack(value.chunks[0],'accepted'));assert.equal((await out.readFinalized(ctx)).rendered_text_through_seq,0);
  await out.ack(ctx,ack(value.chunks[0],'rendered'));await out.ack(ctx,ack(value.voice_chunks[0],'played'));
  value=await out.readFinalized(ctx);assert.equal(value.pending_voice_chunk_count,0);assert.equal(value.rendered_text_through_seq,1);
});
