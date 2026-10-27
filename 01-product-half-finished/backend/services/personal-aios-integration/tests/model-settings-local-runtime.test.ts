import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {localSpeechRuntime} from '../src/model-settings-local-runtime.ts';
import {localSpeakerIdentity,type LocalModelEntry} from '../src/model-settings-local-catalog.ts';
import {LocalSpeechEngine,type LocalSpeechConfig} from '../src/voiceprint/engine.ts';

for(const wrongDimension of [false,true])test(`startup binds selected speaker before load; dimension mismatch=${wrongDimension}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'local-model-startup-'));
  const artifact=(name:string)=>{const path=join(directory,name),bytes=Buffer.from(name);writeFileSync(path,bytes);
    return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const original=artifact('original.onnx'),selected=artifact('selected.onnx');
  const entry:Extract<LocalModelEntry,{kind:'voiceprint'}>={id:'selected',display_name:'Selected',kind:'voiceprint',
    config:{model:selected,dim:16,thresholds:{owner_verified:.8,owner_uncertain:.5,cluster:.5,enroll_consistency:.7,assistant:.8}}};
  const options={environment_id:'fixture',master_key:Buffer.alloc(32,7),local_catalog:()=>({catalog_id:'fixture',models:[entry]})};
  let authority=ModelSettingsAuthority.open(directory,options);
  t.after(async()=>{await authority.stopLocalActivations();authority.close();rmSync(directory,{recursive:true,force:true});});
  authority.registerLocalBaseline({id:'original',display_name:'Original',kind:'voiceprint',config:{model:original,dim:16}});
  const actor={principal_id:'owner',device_id:'phone'};
  const draft=authority.draft(actor,{action:'switch_local',expected_revision:0,local_kind:'voiceprint',local_target:'selected'});
  authority.commitDraft(actor,draft.draft_id,'switch');
  assert.equal(authority.localState('voiceprint')!.effective.generation,0);
  authority.close();authority=ModelSettingsAuthority.open(directory,options);
  const config:LocalSpeechConfig={num_threads:1,timeout_ms:1000,asr:{model:original,tokens:original},vad:{model:original},speaker:{model:original}};
  let captured:LocalSpeechConfig|undefined,closed=false;
  const engine={speaker_model:{...localSpeakerIdentity(entry),dim:wrongDimension?8:16},close:async()=>{closed=true;}} as LocalSpeechEngine;
  const open=await localSpeechRuntime(authority,authority.localSelection('voiceprint'),async incoming=>{captured=incoming;return engine;}).prepare(config);
  assert.equal(authority.localState('voiceprint')!.effective.generation,0);
  if(wrongDimension){await assert.rejects(open,/VOICEPRINT_ENGINE_MODEL_MISMATCH/);assert.equal(closed,true);
    assert.equal(authority.localState('voiceprint')!.effective.generation,0);}
  else{assert.equal(await open(),engine);assert.equal(authority.localState('voiceprint')!.effective.generation,draft.expected_revision+1);}
  assert.equal(captured!.speaker.model.path,selected.path);
  assert.equal(config.speaker.model.path,original.path);
});

for(const failure of ['none','ambient','call'])test(`selected wake model warms both workers before ACK; load failure=${failure}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'local-wake-startup-')),path=join(directory,'wake.onnx'),bytes=Buffer.from('wake fixture');
  writeFileSync(path,bytes);const model={path,sha256:createHash('sha256').update(bytes).digest('hex')};
  const {CALL_INTERRUPT_KEYWORDS}=await import('../src/voiceprint/engine.ts');
  const kws={encoder:model,decoder:model,joiner:model,tokens:model,keywords:[{label:'依米',tokens:'baseline'}],score:2,threshold:.2};
  const entry:LocalModelEntry={id:'next',display_name:'Next',kind:'wakeword',config:{...kws,
    call_keywords:CALL_INTERRUPT_KEYWORDS.map((word,i)=>({...word,tokens:`target-${i}`}))}};
  const authority=ModelSettingsAuthority.open(directory,{environment_id:'fixture',master_key:Buffer.alloc(32,7),
    local_catalog:()=>({catalog_id:'fixture',models:[entry]})});
  t.after(async()=>{await authority.stopLocalActivations();authority.close();rmSync(directory,{recursive:true,force:true});});
  authority.registerLocalBaseline({id:'original',display_name:'Original',kind:'wakeword',config:kws});
  const actor={principal_id:'owner',device_id:'phone'},draft=authority.draft(actor,{action:'switch_local',expected_revision:0,local_kind:'wakeword',local_target:entry.id});
  authority.commitDraft(actor,draft.draft_id,'next');let streamClosed=false,engineClosed=false;
  const engine={keywords:{open:async()=>{assert.equal(authority.localState('wakeword')!.effective.generation,0);
    if(failure==='ambient')throw Error('fixture ambient model failed');return {close:async()=>{}};}},openCallKeywords:async()=>{
    assert.equal(authority.localState('wakeword')!.effective.generation,0);
    if(failure==='call')throw Error('fixture call model failed');
    return {close:async()=>{streamClosed=true;}};
  },close:async()=>{engineClosed=true;}} as unknown as LocalSpeechEngine;
  const open=await localSpeechRuntime(authority,undefined,async()=>engine).prepare({num_threads:1,timeout_ms:1000,
    asr:{model,tokens:model},vad:{model},speaker:{model},kws});
  if(failure!=='none'){await assert.rejects(open,/fixture (?:ambient|call) model failed/);assert.equal(engineClosed,true);
    assert.equal(authority.localState('wakeword')!.effective.generation,0);}
  else{await open();assert.equal(streamClosed,true);assert.equal(authority.localState('wakeword')!.effective.generation,1);}
});

for(const kind of ['asr','vad'] as const)for(const failLoad of [false,true])test(`selected ${kind} native readiness before ACK; failure=${failLoad}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'local-readiness-')),path=join(directory,'model.onnx'),bytes=Buffer.from('readiness fixture');
  writeFileSync(path,bytes);const model={path,sha256:createHash('sha256').update(bytes).digest('hex')};
  const oldConfig=kind==='asr'?{model,tokens:model}:{model};
  const entry:LocalModelEntry=kind==='asr'?{id:'next',display_name:'Next',kind,config:{model,tokens:model}}:
    {id:'next',display_name:'Next',kind,config:{model}};
  const authority=ModelSettingsAuthority.open(directory,{environment_id:'fixture',master_key:Buffer.alloc(32,7),local_catalog:()=>({catalog_id:'fixture',models:[entry]})});
  t.after(async()=>{await authority.stopLocalActivations();authority.close();rmSync(directory,{recursive:true,force:true});});
  authority.registerLocalBaseline({id:'old',display_name:'Old',kind,config:oldConfig} as LocalModelEntry);
  const actor={principal_id:'owner',device_id:'phone'},draft=authority.draft(actor,{action:'switch_local',expected_revision:0,local_kind:kind,local_target:'next'});
  authority.commitDraft(actor,draft.draft_id,'next');let loaded=false,engineClosed=false,streamsClosed=0;
  const load=()=>{assert.equal(authority.localState(kind)!.effective.generation,0);loaded=true;if(failLoad)throw Error('fixture native load failed');};
  const engine={transcribe:async(samples:Float32Array)=>{assert.equal(samples.length,16000);load();},
    openVad:async()=>{load();return {close:async()=>{streamsClosed++;}};},openCallVad:async()=>({close:async()=>{streamsClosed++;}}),
    close:async()=>{engineClosed=true;}} as unknown as LocalSpeechEngine;
  const open=await localSpeechRuntime(authority,undefined,async()=>engine).prepare({num_threads:1,timeout_ms:1000,asr:{model,tokens:model},vad:{model},speaker:{model}});
  if(failLoad){await assert.rejects(open,/fixture native load failed/);assert.equal(engineClosed,true);assert.equal(authority.localState(kind)!.effective.generation,0);}
  else{await open();assert.equal(authority.localState(kind)!.effective.generation,1);if(kind==='vad')assert.equal(streamsClosed,2);}
  assert.equal(loaded,true);
});
