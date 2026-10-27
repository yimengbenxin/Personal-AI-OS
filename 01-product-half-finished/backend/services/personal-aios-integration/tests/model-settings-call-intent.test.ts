import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {callIntentFallbackUpdate} from '../src/model-settings-call-intent.ts';
import {loadModelSettingsImport} from '../src/model-settings-import.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {projectModelSettings} from '../src/model-settings-projection.ts';

const imported=()=>loadModelSettingsImport(new URL('../../../../../deploy/cloud/model-settings-import.example.json',import.meta.url));
test('RQ-115 approved import already projects the main ordered routes with classifier parameters',()=>{
  const snapshot=imported();assert.equal(callIntentFallbackUpdate(snapshot,'owner'),undefined);
  const intent=snapshot.roles.find(role=>role.id==='call.intent')!,brain=snapshot.roles.find(role=>role.id==='brain')!;
  assert.deepEqual(intent.ordered_fallbacks.map(({provider_ref,model_id})=>({provider_ref,model_id})),brain.ordered_fallbacks.map(({provider_ref,model_id})=>({provider_ref,model_id})));
});
test('RQ-115 copies arbitrary ordered routes without mutating any model, provider or original role',()=>{
  const snapshot=imported(),intent=snapshot.roles.find(role=>role.id==='call.intent')!,brain=snapshot.roles.find(role=>role.id==='brain')!;
  intent.ordered_fallbacks=[];
  brain.ordered_fallbacks.push({provider_ref:brain.provider_ref!,model_id:brain.model_id!,parameters:{context_limit:65536,max_output_tokens:4096}});
  const before=structuredClone(snapshot),updated=callIntentFallbackUpdate(snapshot,'owner')!;
  assert.deepEqual(snapshot,before);
  assert.deepEqual(updated,{...intent,ordered_fallbacks:brain.ordered_fallbacks.map(route=>({...route,parameters:{...route.parameters,...intent.parameters}}))});
  updated.ordered_fallbacks[0]!.parameters.thinking!.enabled=true;
  assert.equal(intent.parameters.thinking!.enabled,false);
  intent.ordered_fallbacks=[brain.ordered_fallbacks[0]!];
  assert.throws(()=>callIntentFallbackUpdate(snapshot,'owner'),/MODEL_SETTINGS_CALL_INTENT_FALLBACK_CONFLICT/);
});
test('RQ-115 deployment CLI previews, CAS-stages only the missing list, and leaves activation to the service',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rq115-migration-')),db=join(directory,'models'),master=join(directory,'master.key');
  writeFileSync(master,Buffer.alloc(32,5),{mode:0o600});
  let authority=ModelSettingsAuthority.open(db,{environment_id:'test',master_key_file:master});
  try{
    const snapshot=imported();snapshot.roles.find(role=>role.id==='call.intent')!.ordered_fallbacks=[];
    authority.bootstrap(snapshot,{deepseek:'fake-deepseek-key',opencode:'fake-opencode-key',siliconflow:'fake-siliconflow-key'});authority.close();
    const command=[new URL('../../../../../deploy/cloud/model-settings-call-intent.ts',import.meta.url).pathname,
      '--directory',db,'--master',master,'--environment','test','--profile','owner','--principal-id','owner'];
    const run=(...args:string[])=>spawnSync(process.execPath,[...command,...args],{encoding:'utf8'});
    const preview=run('--expected-revision','1');assert.equal(preview.status,0,preview.stderr);
    assert.equal(JSON.parse(preview.stdout).desired,1);assert.equal(JSON.parse(preview.stdout).applied,false);
    const stale=run('--expected-revision','2','--apply');assert.notEqual(stale.status,0);assert.match(stale.stderr,/MODEL_SETTINGS_REVISION_CONFLICT/);
    const applied=run('--expected-revision','1','--apply');assert.equal(applied.status,0,applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout).brain,{desired:2,effective:1,status:'pending',error:null});
    const repeated=run('--expected-revision','2','--apply');assert.equal(repeated.status,0,repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).changed,false);assert.equal(JSON.parse(repeated.stdout).desired,2);
    authority=ModelSettingsAuthority.open(db,{environment_id:'test',master_key_file:master});
    const before=authority.readRevision(1),after=authority.readRevision(2);
    assert.deepEqual(after.versions,before.versions);assert.deepEqual(after.snapshot.providers,before.snapshot.providers);
    assert.deepEqual(after.snapshot.roles.filter(role=>role.id!=='call.intent'),before.snapshot.roles.filter(role=>role.id!=='call.intent'));
    assert.deepEqual(authority.read().groups.build,{desired:1,effective:1,status:'effective',error:null});
    const config=projectModelSettings(authority,'owner',2,'brain').config as Record<string,any>;
    assert.deepEqual(config.auxiliary.call_intent.fallback_chain.map((route:any)=>[route.provider,route.model]),config.fallback_providers.map((route:any)=>[route.provider,route.model]));
    assert.equal(config.auxiliary.call_intent.fallback_chain[0].extra_body.max_tokens,128);
    assert.deepEqual(config.auxiliary.call_intent.fallback_chain[0].extra_body.thinking,{type:'disabled'});
    assert.ok(!applied.stdout.includes('fake-')&&!preview.stdout.includes('fake-'));
  }finally{authority.close();rmSync(directory,{recursive:true,force:true});}
});
