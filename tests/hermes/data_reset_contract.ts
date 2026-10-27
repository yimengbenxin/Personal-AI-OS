/** Source-path fixtures for reset, consent migration and the RQ-115 CLI/native ACK. No external services. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {canonical,digest} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {effectConsent} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/effect-consent.ts';
import {sendConsentStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/send-consent-storage.ts';
import {releaseSendConsents} from '../../01-product-half-finished/backend/phase0/gateway/src/send-consent-release.ts';
import {wechatRecipient} from '../../capability/contracts/send-recipient.ts';
import {ModelSettingsAuthority} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings.ts';
import {loadModelSettingsImport} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-import.ts';
import {writeModelSettingsProjection} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-projection.ts';
import {VoiceprintRegistry} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts';
import {loadRegistryCipher} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/cipher.ts';
import {OwnerOverride,createOwnerOverrideSecret} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/owner-override.ts';
import {nativeApprovalId} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/confirmation.ts';

const [mode,settingsPath]=process.argv.slice(2),{roots}=JSON.parse(readFileSync(settingsPath!,'utf8'));
const central=join(roots.owner,'central-storage'),storage=new PosixStorage(central);
const write=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
const records=JSON.parse(readFileSync(new URL('../../01-product-half-finished/backend/services/personal-aios-integration/tests/fixtures/send-consents-20261019.json',import.meta.url),'utf8'));
const policy=join(roots.owner,'resources/owner.json'),config=join(roots.owner,'resources/migration.json');
if(mode==='seed-consents'){
  mkdirSync(join(roots.owner,'resources'),{recursive:true});
  write(policy,{schema:'paios.windows.local-owner.v1',purpose:'public_product_canary',userId:'owner-fixture',revocable:true});
  write(config,{storage_root:central,core_profile:{native_profile_home:roots.hermes},product_resources:{owner_policy_file:policy}});
  write(join(roots.hermes,'channel_directory.json'),{platforms:{wechat:[{id:'wxid_one',name:'旧名'},
    {id:'wxid_new',name:'新收件人'},{id:'collision-a',name:'同名'},{id:'collision-b',name:'同名'}]}});
  write(join(roots.hermes,'channel_aliases.json'),{wechat:{wxid_one:'测试·联系人'}});
  for(const record of [...records,{...records[0],task_type:'invented_kind'},
    {...records[0],recipient:'wechat:没有目录记录'},{...records[0],recipient:'wechat:同名'}]){
    const {principal_id,kind,task_type,recipient}=record;
    await storage.publish('effect-consents',digest({principal_id,kind,task_type,recipient}),Buffer.from(canonical(record)));
  }
  const result=await releaseSendConsents(config);assert.equal(result.migrated,2);
  console.log(JSON.stringify(result));
}else if(mode==='check-consents'){
  const replay=await releaseSendConsents(config);assert.equal(replay.already_migrated,2);assert.equal(replay.migrated,0);
  const directory=JSON.parse(readFileSync(join(roots.hermes,'channel_directory.json'),'utf8'));
  const aliases=JSON.parse(readFileSync(join(roots.hermes,'channel_aliases.json'),'utf8'));
  assert.equal(aliases.wechat.wxid_one,'测试·联系人');
  const recipient=wechatRecipient('wechat:id:wxid_one',directory).recipient;
  const context={run_id:'run',session_id:'session',tool_call_id:'call'};
  const entry={d:{principal_id:'owner-fixture',user_identity:'owner-fixture',origin:'explicit_user_prompt',
    device_type:'phone',device_id:'fixture-phone',media_type:'text',content:{text:'发送'},processing:{path_id:'text'},
    source:{channel:'chat'},speakers:[]},record:{run_id:'run',session_id:'session',state:'running'}} as any;
  async function decide(task_type:string,target=recipient){
    const scope={kind:'send' as const,task_type,recipient:target,requested:true};
    const ports={storage:sendConsentStorage(storage,scope),admission:{find:()=>entry},ownerOrigin:async()=>undefined,
      paymentSource:()=>({ride_allowed:false})};
    return effectConsent(ports,context,scope);
  }
  for(const [index,kind] of ['message.text','message.file'].entries()){
    const decision=await decide(kind);assert.equal(decision.status,'allowed');
    assert.equal(decision.approval?.confirmation_id,records[index].confirmation_id);assert.equal(decision.approval?.reused,true);
  }
  assert.equal((await decide('message.text','wechat:id:wxid_new')).status,'confirmation_required');
  assert.equal((await decide('message.reaction')).status,'confirmation_required');
  console.log(JSON.stringify(replay));
}else if(mode==='live-use'||mode==='check-live-grant'){
  if(mode==='live-use'){
    const model={id:'fixture-synthetic',sha256:'a'.repeat(64),dim:16};
    const registry=new VoiceprintRegistry(storage,model,{cipher:await loadRegistryCipher(join(roots.secrets,'voiceprint.key'))});
    const vector=new Float32Array(16);vector[0]=1;
    const status=await registry.enrollOwner({speaker_model:model,channel:'phone_app',mode:'add',
      samples:[{embedding:vector,speech_ms:2500}],at:'2026-10-27T00:00:00.000Z'});
    assert.equal(status.samples,6);
    vector[0]=0;vector[1]=1;
    await registry.observeAssistant({voice:'system_tts',embedding:vector,speech_ms:2500,at:'2026-10-27T00:00:00.000Z'});
    await registry.close();
    const passphrase='synthetic test-only passphrase';
    write(join(roots.secrets,'owner-override.json'),await createOwnerOverrideSecret(passphrase));
    const override=new OwnerOverride({storage,secret_root:roots.secrets,now:()=>Date.parse('2026-10-27T00:00:00Z')});
    await assert.rejects(override.enable('live-phone','wrong synthetic passphrase'));
    assert.equal((await override.enable('live-phone',passphrase)).enabled,true);override.close();
  }
  const scope={kind:'send' as const,task_type:'message.text',recipient:'wechat:id:wxid_new',requested:true};
  const context={run_id:'live-run',session_id:'live-session',tool_call_id:'live-call'},request='live-approval';
  const entry={d:{principal_id:'owner-fixture',user_identity:'owner-fixture',origin:'explicit_user_prompt',
    device_type:'phone',device_id:'live-phone',media_type:'text',content:{text:'发送'},processing:{path_id:'text'},
    source:{channel:'chat'},speakers:[]},record:{run_id:context.run_id,session_id:context.session_id,state:'running'}} as any;
  const ports={storage:sendConsentStorage(storage,scope),admission:{find:()=>entry},ownerOrigin:async()=>undefined,
    paymentSource:()=>({ride_allowed:false})};
  const decision=await effectConsent(ports,context,scope,mode==='live-use',false,request,{
    confirmation_id:nativeApprovalId('owner-fixture',context.run_id,request),confirmed_by:'owner-fixture',
    confirmed_at:'2026-10-27T00:00:00Z',surface:{device_id:'live-phone',device_type:'phone'}});
  assert.equal(decision.status,'allowed');assert.equal(decision.approval?.reused,mode==='check-live-grant');
  console.log(JSON.stringify({allowed:true}));
}else{
  const directory=roots.models??join(central,'model-settings'),output=roots.projections??join(roots.owner,'model-projections');
  const master=join(roots.secrets,'synthetic-master.key');
  const native=(projection:unknown)=>{
    const result=spawnSync(process.env.PAIOS_HERMES_PYTHON!,[new URL('./data_reset_native_ack.py',import.meta.url).pathname,roots.hermes],
      {input:JSON.stringify([projection]),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const options={environment_id:'test',master_key:Buffer.alloc(32,5),
    activate:async(group:'brain'|'build',revision:number,authority:ModelSettingsAuthority)=>{
      const projection=writeModelSettingsProjection(authority,output,group==='brain'?'owner':'workshop',revision,group);
      assert.deepEqual(native(projection),{status:'effective',revision});
    },onEffective:(group:'brain'|'build',revision:number,authority:ModelSettingsAuthority)=>
      writeModelSettingsProjection(authority,output,group==='brain'?'owner':'workshop',revision,group,true)};
  if(mode==='migrate-models'){
    const result=spawnSync(process.execPath,[new URL('../../deploy/cloud/model-settings-call-intent.ts',import.meta.url).pathname,
      '--directory',directory,'--master',master,'--environment','test','--profile','owner','--principal-id','owner',
      '--expected-revision','1','--apply'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
    assert.equal(receipt.changed,true);assert.equal(receipt.brain.desired,2);assert.equal(receipt.brain.effective,1);
    console.log(JSON.stringify(receipt));
  }else{
    const authority=ModelSettingsAuthority.open(directory,options);
    try{
      if(mode==='seed-models'){
        writeFileSync(master,Buffer.alloc(32,5),{mode:0o600});
        const snapshot=loadModelSettingsImport(new URL('../../deploy/cloud/model-settings-import.example.json',import.meta.url));
        snapshot.roles.find(role=>role.id==='call.intent')!.ordered_fallbacks=[];
        authority.bootstrap(snapshot,{deepseek:'fake-deepseek-key',opencode:'fake-opencode-key',siliconflow:'fake-siliconflow-key'});
        for(const group of ['brain','build'] as const){
          const home=group==='brain'?roots.hermes:join(roots.hermes,'workshop');mkdirSync(home,{recursive:true});
          write(join(home,'config.yaml'),{timezone:'Asia/Shanghai',terminal:{backend:'ssh'}});
          native(writeModelSettingsProjection(authority,output,group==='brain'?'owner':'workshop',1,group,true));
        }
      }else if(mode==='ack-models'){
        const result=await authority.activateIdle('brain',true);assert.equal(result.desired,2);assert.equal(result.effective,2);
      }
      const state=authority.read();console.log(JSON.stringify({desired:state.desired,groups:state.groups}));
    }finally{authority.close();}
  }
}
await storage.close();
