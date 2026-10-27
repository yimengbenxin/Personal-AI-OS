import {CALL_INTERRUPT_KEYWORDS} from '../src/voiceprint/engine.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {ModelSettingsControl} from '../src/model-settings-control.ts';
import {PaymentStore} from '../src/payment/store.ts';
import {PaymentKeys} from '../src/payment/keys.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
import {parseLocalModelCatalog,type LocalModelEntry,type LocalModelCatalog} from '../src/model-settings-local-catalog.ts';

const actor={principal_id:'owner',device_id:'phone'};
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'settings-local-'));
  const artifact=(name:string)=>{const path=join(directory,name);writeFileSync(path,name);return {path,sha256:createHash('sha256').update(name).digest('hex')};};
  const a:LocalModelEntry={id:'vad-a',display_name:'VAD A',kind:'vad',config:{model:artifact('a.onnx')}};
  const b:LocalModelEntry={id:'vad-b',display_name:'VAD B',kind:'vad',config:{model:artifact('b.onnx')}};
  const c:LocalModelEntry={id:'vad-c',display_name:'VAD C',kind:'vad',config:{model:artifact('c.onnx')}};
  const catalog:LocalModelCatalog={catalog_id:'fixture-pins',models:[b,c]};
  const options={environment_id:'fixture',master_key:Buffer.alloc(32,8),local_catalog:()=>catalog};
  let authority=ModelSettingsAuthority.open(directory,options);
  authority.registerLocalBaseline?.(a);
  t.after(async()=>{await authority.stopLocalActivations?.();authority.close();rmSync(directory,{recursive:true,force:true});});
  const draft=(target='vad-b')=>authority.draft(actor,{action:'switch_local',expected_revision:authority.read().desired,local_kind:'vad',local_target:target});
  const commit=(target='vad-b')=>{const d=draft(target);authority.commitDraft(actor,d.draft_id,`approve-${d.draft_id}`);return d;};
  return {directory,artifact,a,b,c,catalog,options,get authority(){return authority;},draft,commit,
    reopen(){authority.close();authority=ModelSettingsAuthority.open(directory,options);return authority;}};
}
test('owner-approved local selection persists independently of its effective producer and uses existing revision CAS',async t=>{
  const f=fixture(t),first=f.draft(),stale=f.draft('vad-c');
  assert.equal(f.authority.read().desired,0,'draft alone does not change any producer');
  const receipt=f.authority.commitDraft(actor,first.draft_id,'owner-approval');
  assert.equal(receipt.desired,1);assert.deepEqual(f.authority.commitDraft(actor,first.draft_id,'owner-approval'),receipt);
  assert.throws(()=>f.authority.commitDraft(actor,stale.draft_id,'stale'),/MODEL_SETTINGS_REVISION_CONFLICT/);
  const state=f.reopen().localState('vad')!;
  assert.equal(state.status,'restart_required');assert.equal(state.effective.entry.id,'vad-a');assert.equal(state.desired.entry.id,'vad-b');
  await f.authority.activateLocal('vad',async(selected,context)=>{assert.equal(selected.entry.id,'vad-b');context.commit(()=>{});});
  assert.equal(f.authority.localState('vad')!.effective.entry.id,'vad-b');
  f.commit('previous');assert.equal(f.authority.localState('vad')!.desired.entry.id,'vad-a');
  assert.equal(f.authority.localState('vad')!.effective.entry.id,'vad-b','revert also waits for verified activation');
});
test('catalog identity and artifact pins are frozen by approval; unknown, absent and owner-data switches refuse',t=>{
  const f=fixture(t);assert.throws(()=>f.draft('not-pinned'),/LOCAL_MODEL_NOT_IN_CATALOG/);
  const d=f.draft();f.catalog.models[0]={...f.b,display_name:'Changed after review'};
  assert.throws(()=>f.authority.commitDraft(actor,d.draft_id,'changed'),/LOCAL_MODEL_CATALOG_CHANGED/);
  f.catalog.models[0]=f.b;rmSync((f.b.config as {model:{path:string}}).model.path);
  assert.throws(()=>f.draft(),/LOCAL_MODEL_NOT_INSTALLED/);
  const face:LocalModelEntry={id:'face-new',display_name:'Face',kind:'face',config:{model:f.artifact('face.onnx')}};
  f.authority.registerLocalBaseline({...face,id:'face-old'});f.catalog.models.push(face);
  assert.throws(()=>f.authority.draft(actor,{action:'switch_local',expected_revision:0,local_kind:'face',local_target:face.id}),/LOCAL_MODEL_FACE_ENROLLMENT_REQUIRED/);
  assert.equal(f.authority.read().desired,0);
});
test('wake model packages preserve approved words while accepting model-specific tokens',t=>{
  const f=fixture(t),model=f.artifact('wake.onnx'),config={encoder:model,decoder:model,joiner:model,tokens:model,keywords:[{label:'依米',tokens:'old'}],score:2,threshold:.2};
  const missingCall={id:'wake-missing',display_name:'Missing call tokens',kind:'wakeword',config};
  assert.throws(()=>parseLocalModelCatalog({catalog_id:'fixture',models:[missingCall]}),/LOCAL_MODEL_CATALOG_INVALID/);
  f.authority.registerLocalBaseline({id:'wake-a',display_name:'Wake A',kind:'wakeword',config});
  const b:LocalModelEntry={id:'wake-b',display_name:'Wake B',kind:'wakeword',config:{...config,keywords:[{label:'different',tokens:'new'}],call_keywords:CALL_INTERRUPT_KEYWORDS.map((word,i)=>({...word,tokens:`new-token-${i}`}))}};
  assert.equal(parseLocalModelCatalog({catalog_id:'fixture',models:[b]}).models.length,1);
  f.catalog.models.push(b);
  const draft=()=>f.authority.draft(actor,{action:'switch_local',expected_revision:0,local_kind:'wakeword',local_target:b.id});
  assert.throws(draft,/LOCAL_MODEL_WAKE_WORD_CHANGED/);b.config.keywords[0]!.label='依米';
  const callWord=b.config.call_keywords![0]!;callWord.label='changed-call-label';assert.throws(draft,/LOCAL_MODEL_WAKE_WORD_CHANGED/);callWord.label=CALL_INTERRUPT_KEYWORDS[0]!.label;
  assert.ok(draft().draft_id);
});
test('a superseding desired generation cancels unfinished installation and cannot ACK its stale candidate',async t=>{
  const f=fixture(t);f.commit();const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let installed=false;
  const applying=f.authority.activateLocal('vad',async(_,context)=>{started.resolve();await release.promise;context.commit(()=>{installed=true;});});
  await started.promise;f.commit('vad-c');release.resolve();await applying;
  const state=f.authority.localState('vad')!;assert.equal(installed,false);assert.equal(state.effective.entry.id,'vad-a');assert.equal(state.desired.entry.id,'vad-c');
  await f.authority.activateLocal('vad',async(_,context)=>context.commit(()=>{}));
  assert.equal(f.authority.localState('vad')!.effective.entry.id,'vad-c');
});
test('withdrawing a pending change also requires a fresh approval of the retained effective pin',async t=>{
  const f=fixture(t);f.commit();const cancel=f.draft('effective');
  assert.equal(f.authority.localSelection('vad')!.entry.id,'vad-b','review alone cannot cancel approval');
  f.authority.commitDraft(actor,cancel.draft_id,'cancel-approved');
  assert.equal(f.authority.localSelection('vad')!.entry.id,'vad-a');
  await f.authority.activateLocal('vad',async(_,context)=>context.commit(()=>{}));
  assert.equal(f.authority.localState('vad')!.effective.generation,2);
});
test('crash between derived install and settings ACK retains a recoverable generation; replay ACKs it after restart',async t=>{
  const f=fixture(t);f.commit();const pin=join(f.directory,'fixture-derived-pin');
  f.authority.db.exec(`CREATE TEMP TRIGGER crash_before_ack BEFORE UPDATE ON model_local_state
    WHEN json_extract(NEW.body,'$.status')='effective' BEGIN SELECT RAISE(FAIL,'fixture crash after install'); END;`);
  const failed=await f.authority.activateLocal('vad',async(selected,context)=>context.commit(()=>writeFileSync(pin,selected.entry.id)));
  assert.equal(failed.effective.entry.id,'vad-a');assert.equal(readFileSync(pin,'utf8'),'vad-b');
  f.reopen();assert.equal(f.authority.localState('vad')!.installing!.entry.id,'vad-b');
  await f.authority.activateLocal('vad',async(selected,context)=>{
    assert.equal(selected.entry.id,readFileSync(pin,'utf8'));context.commit(()=>{});
  });
  const recovered=f.authority.localState('vad')!;assert.equal(recovered.effective.entry.id,'vad-b');assert.equal(recovered.installing,undefined);
});
test('local control uses the existing owner key and challenge, exact replay, and Mac authorization gate',async t=>{
  const f=fixture(t),store=PaymentStore.open(join(f.directory,'payment'));t.after(()=>store.close());
  const phone:RegisteredDevice={...actor,device_type:'phone',channel:'fixture',route_version:'r',consent_ref:'c',output_modes:['text']};
  const mac:RegisteredDevice={...phone,device_id:'mac',device_type:'mac'};
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
  const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64');
  store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run(phone.device_id,'user',phone.principal_id,publicKey,Date.now());
  const keys=new PaymentKeys({store,challenge_ttl_s:120,now:Date.now,revalidate:async source=>source});
  const control=new ModelSettingsControl({authority:f.authority,keys,revalidate:async source=>source,devices:async()=>[phone,mac]});
  await assert.rejects(control.dispatch(mac,{operation:'model_settings_local_catalog'}),/MODEL_SETTINGS_MAC_UNAUTHORIZED/);
  const draft=await control.dispatch(phone,{operation:'model_settings_draft',request:{action:'switch_local',expected_revision:0,local_kind:'vad',local_target:'vad-b'}}) as Record<string,unknown>;
  const unsigned={operation:'model_settings_switch_local',request:{draft_id:draft.draft_id}};
  await assert.rejects(control.dispatch(phone,unsigned),/PAYMENT_SIGNATURE_REQUIRED/);
  const challenge=await keys.challenge(phone,'model_settings');
  const statement={purpose:'model_settings',device_id:phone.device_id,nonce:challenge.nonce,
    ...Object.fromEntries(['action','draft_id','expected_revision','change_sha256','expires_at_ms','principal_id'].map(field=>[field,draft[field]]))};
  const bytes=Buffer.from(JSON.stringify(statement)),signed={...unsigned,statement_b64:bytes.toString('base64'),signature_b64:sign('sha256',bytes,pair.privateKey).toString('base64')};
  const result=await control.dispatch(phone,signed);assert.deepEqual(await control.dispatch(phone,signed),result);
  assert.equal(f.authority.localSelection('vad')!.entry.id,'vad-b');
  assert.equal(f.authority.localState('vad')!.effective.entry.id,'vad-a');
  const page=await control.dispatch(phone,{operation:'model_settings_read'}) as object;
  assert.ok(!JSON.stringify(page).includes(f.directory),'public state contains no runtime paths');
});
