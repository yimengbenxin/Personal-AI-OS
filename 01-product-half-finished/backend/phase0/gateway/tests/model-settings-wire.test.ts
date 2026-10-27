import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {modelSettingsWire,mergeModelSettingsWire,dispatchModelSettings,type ModelSettingsWireRuntime} from '../src/personal-aios-model-settings-wire.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const ajv=new Ajv({strict:true});
const outputs=Object.fromEntries(Object.entries(modelSettingsWire.outputs).map(([op,value])=>[op,ajv.compile({$defs:modelSettingsWire.$defs,...value as object})]));
const inputs=Object.fromEntries(Object.entries(modelSettingsWire.inputs).map(([op,value])=>[op,ajv.compile({$defs:modelSettingsWire.$defs,...value.definition as object})]));
test('local switching uses signed draft execution and rejects arbitrary model paths or downloads',()=>{
  const message={operation:'model_settings_draft',control_id:'local-switch',request:{action:'switch_local',expected_revision:1,local_kind:'voiceprint',local_target:'installed-model'}};
  assert.equal(inputs.model_settings_draft!(message),true);
  assert.equal(inputs.model_settings_draft!({...message,request:{...message.request,path:'/tmp/unpinned.onnx'}}),false);
  assert.equal(inputs.model_settings_draft!({...message,request:{...message.request,download:true}}),false);
  const signed=modelSettingsWire.examples.model_settings_switch_local![0]!;
  assert.equal(inputs.model_settings_switch_local!(signed),true);
  assert.equal(inputs.model_settings_switch_local!({...signed,signature_b64:undefined}),false);
  assert.equal(inputs.model_settings_local_catalog!({operation:'model_settings_local_catalog',control_id:'catalog',request:{offset:0}}),true);
});
test('model settings frozen examples cover every formal operation and reject unknown fields and secret draft fields',()=>{
  for(const [operation,examples] of Object.entries(modelSettingsWire.examples))for(const example of examples){
    const validate=inputs[operation]??outputs[operation]!;assert.ok(validate(example),`${operation}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({...example,secret:'not-a-key'}),false);
  }
  const draft=modelSettingsWire.examples.model_settings_draft![0]!;
  assert.equal(inputs.model_settings_draft!({...draft,request:{...draft.request as object,providers:[{...(draft.request as {providers:object[]}).providers[0],key:'forbidden'}]}}),false);
  const execute=modelSettingsWire.examples.model_settings_commit![0]!;
  assert.equal(inputs.model_settings_commit!({...execute,signature_b64:undefined}),false);
  assert.equal(inputs.model_settings_commit!({...execute,request:{draft_id:'draft:1',providers:[]}}),false);
  const base:Parameters<typeof mergeModelSettingsWire>[0]={$defs:{},inputs:{},outputs:{}};mergeModelSettingsWire(base);
  assert.equal(base.inputs.model_settings_read,modelSettingsWire.inputs.model_settings_read);
  const receipt=modelSettingsWire.examples.model_settings_receipt!.find(value=>(value.result as {usage?:object}).usage)!;
  const result=receipt.result as {usage:Record<string,unknown>},validate=outputs.model_settings_receipt!;
  assert.equal(validate({...receipt,result:{...result,usage:{...result.usage,estimate_note:42}}}),false);
  const {estimate_note,...legacyUsage}=result.usage;
  assert.equal(validate({...receipt,result:{...result,usage:legacyUsage}}),true);
});
test('paired formal dispatch preserves authenticated source and authority result, and denies other terminals',async()=>{
  const source:RegisteredDevice={principal_id:'owner',device_id:'mac',device_type:'mac',channel:'fixture',consent_ref:'c',route_version:'r',output_modes:['text']};
  const body=modelSettingsWire.examples.model_settings_read![0]!;
  const runtime:ModelSettingsWireRuntime={modelSettingsControl:async(s,b)=>{assert.equal(s,source);assert.equal(b,body);return {desired_revision:1};},modelSettingsWatch:async()=>()=>{}};
  assert.deepEqual(await dispatchModelSettings(runtime,source,body),{operation:'model_settings_receipt',control_id:body.control_id,ok:true,result:{desired_revision:1}});
  await assert.rejects(dispatchModelSettings(runtime,{...source,device_type:'glasses'},body),/MODEL_SETTINGS_TERMINAL_NOT_ALLOWED/);
  runtime.modelSettingsControl=async()=>{throw Error('MODEL_SETTINGS_CAS');};
  await assert.rejects(dispatchModelSettings(runtime,source,body),/MODEL_SETTINGS_CAS/);
});
test('key publication, pending Macs, catalog and budget policy are frozen in examples and byte-identical client contracts',()=>{
 const defs=modelSettingsWire.$defs;
 for(const [name,control] of [['ms_key_challenge_result','settings:key-challenge'],['ms_pending_macs_result','settings:pending'],['ms_catalog_result','settings:catalog'],['ms_catalog_result','settings:no-catalog']]){
  const validate=ajv.compile({$defs:defs,...defs[name!] as object});
  const example=modelSettingsWire.examples.model_settings_receipt!.find(value=>value.control_id===control)!;
  assert.ok(validate(example.result),JSON.stringify(validate.errors));
 }
 const draft=inputs.model_settings_draft!,message=(request:object)=>({operation:'model_settings_draft',control_id:'budget',request:{action:'pause',expected_revision:1,...request}});
 assert.equal(draft(message({pause_on_limit:true,owner_reserve_cny:1})),true);assert.equal(draft(message({pause_on_limit:false})),true);
 assert.equal(draft(message({pause_on_limit:true,owner_reserve_cny:0})),false);assert.equal(draft(message({enabled:true})),false);
 for(const name of ['model-settings.v1.json','formal-message.v1.json']){
  const root=new URL('../../../../../',import.meta.url),canonical=readFileSync(new URL(`integrations/contracts/${name}`,root));
  for(const target of [`01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/${name}`,`01-product-half-finished/glasses-android/app/src/test/resources/${name}`])assert.deepEqual(readFileSync(new URL(target,root)),canonical);
  if(name==='formal-message.v1.json'){
   const digest=createHash('sha256').update(canonical).digest('hex');
   for(const file of ['01-product-half-finished/backend/phase0/gateway/src/personal-aios-formal-text.ts','01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Core/AssistantCentralTextWire.swift'])assert.ok(readFileSync(new URL(file,root),'utf8').includes(digest));
  }
 }
});
