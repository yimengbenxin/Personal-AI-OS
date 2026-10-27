import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import type {ModelSnapshot} from '../src/model-settings-contract.ts';

const actor={principal_id:'owner',device_id:'phone'};
const seed:ModelSnapshot={providers:[{id:'fixture',display_name:'Fixture',wire_protocol:'chat_completions',
  base_url:'https://models.example/v1',credential_ref:'fixture'}],roles:[{id:'brain',profile:'owner',
  provider_ref:'fixture',model_id:'unchanged',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}]};
const options={environment_id:'test',master_key:Buffer.alloc(32,9)};
function rotate(authority:ModelSettingsAuthority,key:string,nonce:string){
  const draft=authority.keyDraft(actor,{expected_revision:authority.read().desired,credential_ref:'fixture',key});
  authority.commitDraft(actor,draft.draft_id,nonce);
}
function credential(authority:ModelSettingsAuthority,revision:number){
  const route=authority.resolve('test','owner','brain',revision);
  return authority.credential({environment_id:'test',profile:'owner',revision,handle:route.credential_handle!});
}

for(const readBeforeCommit of [false,true])test(`in-flight activation leases its key across a later commit (${readBeforeCommit?'already read':'not yet read'})`,async()=>{
  const home=mkdtempSync(join(tmpdir(),'model-activation-lease-'));
  const entered=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>();
  const authority=ModelSettingsAuthority.open(home,{...options,activate:async(_group,revision)=>{
    if(revision===2){
      if(readBeforeCommit)assert.equal(credential(authority,2),'fake-key-B');
      entered.resolve();await ack.promise;
      assert.equal(credential(authority,2),'fake-key-B');
    }
  }});
  let activation:ReturnType<ModelSettingsAuthority['activateIdle']>|undefined;
  try{
    authority.bootstrap(seed,{fixture:'fake-key-A'});rotate(authority,'fake-key-B','B');
    activation=authority.activateIdle('brain',true);await entered.promise;
    rotate(authority,'fake-key-C','C');
    assert.equal(credential(authority,2),'fake-key-B','a pending activation retains its exact generation');
    ack.resolve();assert.equal((await activation).effective,2);
    assert.equal(credential(authority,2),'fake-key-B','the acknowledged intermediate generation remains restartable');
    assert.equal((await authority.activateIdle('brain',true)).effective,3);
    assert.equal(credential(authority,3),'fake-key-C');
    assert.throws(()=>credential(authority,2),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/,'ACK of its replacement releases the old lease');
    assert.ok(!authority.db.prepare('SELECT body FROM model_drafts').all().some(row=>String(row.body).includes('ciphertext')));
  }finally{ack.resolve();await activation;authority.close();rmSync(home,{recursive:true,force:true});}
});

for(const recovery of ['replacement','rollback'] as const)test(`crashed activation retains its generation until ${recovery} is acknowledged after restart`,async()=>{
  const home=mkdtempSync(join(tmpdir(),'model-activation-crash-'));
  // Abrupt process death leaves only committed SQLite state, with no catch/finally cleanup.
  const program=`
    import {ModelSettingsAuthority} from ${JSON.stringify(new URL('../src/model-settings.ts',import.meta.url).href)};
    const actor=${JSON.stringify(actor)},seed=${JSON.stringify(seed)};
    const authority=ModelSettingsAuthority.open(process.argv[1],{
      environment_id:'test',master_key:Buffer.alloc(32,9),activate:async()=>{
        const draft=${recovery==='replacement'?
          "authority.keyDraft(actor,{expected_revision:2,credential_ref:'fixture',key:'fake-key-C'})":
          "authority.draft(actor,{action:'undo',expected_revision:2,revision:1})"};
        authority.commitDraft(actor,draft.draft_id,'later');
        process.kill(process.pid,'SIGKILL');
      }});
    authority.bootstrap(seed,{fixture:'fake-key-A'});
    const draft=authority.keyDraft(actor,{expected_revision:1,credential_ref:'fixture',key:'fake-key-B'});
    authority.commitDraft(actor,draft.draft_id,'B');
    await authority.activateIdle('brain',true);
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,home],{encoding:'utf8',timeout:15_000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const entered=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>();
  let authority=ModelSettingsAuthority.open(home,{...options,activate:async()=>{entered.resolve();await ack.promise;}});
  let activation:ReturnType<ModelSettingsAuthority['activateIdle']>|undefined;
  try{
    assert.equal(authority.read().groups.brain.effective,1);
    assert.equal(credential(authority,2),'fake-key-B','restart must not revoke a possibly installed generation');
    activation=authority.activateIdle('brain',true);await entered.promise;
    assert.equal(credential(authority,2),'fake-key-B','recovery keeps the lease until its replacement/rollback ACK');
    ack.resolve();assert.equal((await activation).effective,3);
    assert.equal(credential(authority,3),recovery==='replacement'?'fake-key-C':'fake-key-A');
    assert.throws(()=>credential(authority,2),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/);
    authority.close();authority=ModelSettingsAuthority.open(home,options);
    assert.equal(credential(authority,3),recovery==='replacement'?'fake-key-C':'fake-key-A');
    assert.throws(()=>credential(authority,2),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/,'recovered old keys stay revoked after another restart');
  }finally{ack.resolve();await activation;authority.close();rmSync(home,{recursive:true,force:true});}
});
