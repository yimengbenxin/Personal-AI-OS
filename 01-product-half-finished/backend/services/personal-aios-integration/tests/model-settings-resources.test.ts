import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {openModelSettingsResources} from '../src/model-settings-resources.ts';
import type {ModelSnapshot} from '../src/model-settings-contract.ts';

const actor={principal_id:'owner',device_id:'phone'};
function fixture(seeded=true){
  const directory=mkdtempSync(join(tmpdir(),'model-resources-')),master=join(directory,'master.key');
  writeFileSync(master,Buffer.alloc(32,6),{mode:0o600});
  const config={environment_id:'test',master_key_file:master,service_key_file:join(directory,'service.key'),
    projection_dir:join(directory,'projections')};
  const snapshot:ModelSnapshot={providers:[{id:'custom',display_name:'Custom',wire_protocol:'chat_completions',
    base_url:'https://models.example/v1',credential_ref:'custom'}],roles:[
    {id:'brain',profile:'owner',provider_ref:'custom',model_id:'old-brain',parameters:{context_limit:262144,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'brain_idle'},
    {id:'build.workshop',profile:'workshop',provider_ref:'custom',model_id:'old-workshop',parameters:{context_limit:262144,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'build_idle'},
    {id:'build.workshop',profile:'builder',provider_ref:'custom',model_id:'old-builder',parameters:{context_limit:262144,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'build_idle'}]};
  const authority=ModelSettingsAuthority.open(join(directory,'model-settings'),{environment_id:'test',master_key_file:master});
  if(seeded)authority.bootstrap(snapshot,{custom:'fake-key-1234'});authority.close();
  return {directory,config,snapshot,current:(group='brain')=>JSON.parse(readFileSync(join(config.projection_dir,group==='brain'?'current.json':'build-current.json'),'utf8')),
    close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('empty authority publishes inert startup groups and first live brain setup waits for native acknowledgement',async t=>{
  const f=fixture(false);let resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
  const entered=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>();
  try{
    for(const group of ['brain','build']){const projection=f.current(group);assert.equal(projection.revision,0);
      assert.equal(projection.configured,false);assert.equal(projection.config.model.enabled,false);}
    const key=resources.authority.keyDraft(actor,{expected_revision:0,credential_ref:'custom',key:'fake-first-key-1234'});
    resources.authority.commitDraft(actor,key.draft_id,'key');
    const route=resources.authority.draft(actor,{expected_revision:1,providers:f.snapshot.providers,roles:[f.snapshot.roles[0]!]});
    resources.authority.commitDraft(actor,route.draft_id,'route');
    assert.equal(resources.authority.read().groups.brain.effective,0);assert.equal(f.current().revision,0);
    // Restart must republish the acknowledged initial state, never the pending desired route.
    await resources.close();resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
    assert.equal(f.current().revision,0);assert.equal(f.current('build').revision,0);
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));assert.equal(body.revision,2);assert.equal(body.projections[0].configured,true);
      assert.equal(JSON.parse(readFileSync(join(f.config.projection_dir,'revisions/2/owner.json'),'utf8')).revision,2);
      entered.resolve();await ack.promise;return Response.json({status:'effective',revision:2});
    });
    const activation=resources.authority.activateIdle('brain',true);await entered.promise;
    assert.equal(resources.authority.read().groups.brain.effective,0);assert.equal(f.current().revision,0);
    ack.resolve();assert.equal((await activation).effective,2);assert.equal(f.current().revision,2);assert.equal(f.current().configured,true);
    assert.equal(f.current('build').revision,0);assert.equal(f.current('build').configured,false);
  }finally{ack.resolve();await resources.close();f.close();}
});
test('composition prepares an immutable projection, retains busy effective, then publishes only after native acknowledgement',async t=>{
  const f=fixture();let busy=true,calls=0;
  const resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
  try{
    t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
      assert.equal(url,'http://127.0.0.1:9999/api/model-settings/activate');
      assert.equal((init.headers as Record<string,string>).Authorization,'Bearer fake-service-key-at-least24');
      const body=JSON.parse(String(init.body));calls++;
      assert.equal(body.projections[0].config.model.default,'new-brain');assert.equal(body.projections[0].revision,2);
      assert.equal(f.current().revision,1);
      assert.equal(JSON.parse(readFileSync(join(f.config.projection_dir,'revisions/2/owner.json'),'utf8')).revision,2);
      assert.ok(!String(init.body).includes('fake-key-1234'));
      return Response.json({status:busy?'pending':'effective',revision:2},{status:busy?409:200});
    });
    const draft=resources.authority.draft(actor,{expected_revision:1,roles:[{...f.snapshot.roles[0]!,model_id:'new-brain'}]});
    resources.authority.commitDraft(actor,draft.draft_id,'model');
    assert.equal((await resources.authority.activateIdle('brain',true)).status,'pending');
    assert.equal(f.current().revision,1);busy=false;
    assert.equal((await resources.authority.activateIdle('brain',true)).effective,2);
    assert.equal(f.current().revision,2);assert.equal(calls,2);
  }finally{await resources.close();f.close();}
});
test('an explicitly selected remote builder receives its authority profile rather than the co-resident workshop',async t=>{
  const f=fixture(),resources=openModelSettingsResources(f.directory,{...f.config,build_profile:'builder',
    build_activation_url:'https://builder.example'},'http://127.0.0.1:9999','fake-service-key-at-least24');
  try{
    t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
      assert.equal(url,'https://builder.example/api/model-settings/activate');
      const body=JSON.parse(String(init.body));assert.equal(body.projections[0].profile,'builder');
      assert.equal(body.projections[0].config.model.default,'new-builder');
      return Response.json({status:'effective',revision:2});
    });
    const draft=resources.authority.draft(actor,{expected_revision:1,roles:[{...f.snapshot.roles[2]!,model_id:'new-builder'}]});
    resources.authority.commitDraft(actor,draft.draft_id,'builder');
    assert.equal((await resources.authority.activateIdle('build',true)).effective,2);
    assert.equal(f.current('build').profile,'builder');assert.equal(f.current('build').revision,2);
    assert.equal(f.current().revision,1);
  }finally{await resources.close();f.close();}
});

for(const group of ['brain','build'] as const)test(`intentional ${group} disable is acknowledged, survives restart and can re-enable its unchanged route`,async t=>{
  const f=fixture(),index=group==='brain'?0:1,role=f.snapshot.roles[index]!;
  let resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
  let disabling=true,calls=0;
  try{
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(String(init.body)),projection=body.projections[0];calls++;
      assert.equal(projection.profile,role.profile);assert.equal(projection.group,group);
      assert.equal(projection.revision,disabling?2:3);
      assert.equal(resources.authority.read().groups[group].effective,disabling?1:2);
      assert.equal(f.current(group).revision,disabling?1:2,'publish waits for native acknowledgement');
      if(disabling){
        assert.equal(projection.configured,false);assert.deepEqual(projection.config.model,{enabled:false});
        assert.deepEqual(projection.credentials,[]);assert.deepEqual(projection.config.providers,{});
      }else{
        assert.equal(projection.configured,true);assert.equal(projection.config.model.default,role.model_id);
        assert.equal(projection.config.model.provider,role.provider_ref);
        assert.equal(projection.config.model.request_overrides.max_tokens,role.parameters.max_output_tokens);
      }
      return Response.json({status:'effective',revision:body.revision});
    });
    const disabled=resources.authority.draft(actor,{expected_revision:1,roles:[{...role,disabled:true}]});
    resources.authority.commitDraft(actor,disabled.draft_id,'disable');
    const stopped=await resources.authority.activateIdle(group,true);
    assert.equal(stopped.status,'effective');assert.equal(stopped.effective,2);assert.equal(calls,1);
    assert.equal(f.current(group).configured,false);assert.equal(f.current(group).config.model.enabled,false);
    const other=group==='brain'?'build':'brain';assert.equal(f.current(other).revision,1);
    await resources.close();resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
    assert.equal(resources.authority.read().groups[group].effective,2);
    assert.equal(f.current(group).revision,2);assert.equal(f.current(group).config.model.enabled,false);
    disabling=false;
    const enabled=resources.authority.draft(actor,{expected_revision:2,roles:[role]});
    resources.authority.commitDraft(actor,enabled.draft_id,'enable');
    assert.equal((await resources.authority.activateIdle(group,true)).effective,3);assert.equal(calls,2);
    assert.equal(f.current(group).configured,true);assert.equal(f.current(group).config.model.default,role.model_id);
    assert.deepEqual(resources.authority.read().providers,f.snapshot.providers);
    await resources.close();resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
    assert.equal(f.current(group).revision,3);assert.equal(f.current(group).config.model.default,role.model_id);
  }finally{await resources.close();f.close();}
});

test('an active main route with unavailable credentials remains failed closed and never reaches native activation',async t=>{
  const f=fixture(),resources=openModelSettingsResources(f.directory,f.config,'http://127.0.0.1:9999','fake-service-key-at-least24');
  let calls=0;
  try{
    t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({status:'effective',revision:2});});
    const replacement=resources.authority.keyDraft(actor,{expected_revision:1,credential_ref:'custom',key:'fake-replacement-5678'});
    resources.authority.commitDraft(actor,replacement.draft_id,'replace-key');
    t.mock.method(resources.authority,'credentialConfigured',()=>false);
    const state=await resources.authority.activateIdle('brain',true);
    assert.equal(state.status,'failed');assert.equal(state.effective,1);assert.equal(calls,0);
    assert.equal(f.current().revision,1);assert.equal(f.current().config.model.default,'old-brain');
    assert.deepEqual(resources.authority.read().providers,f.snapshot.providers);
  }finally{await resources.close();f.close();}
});
