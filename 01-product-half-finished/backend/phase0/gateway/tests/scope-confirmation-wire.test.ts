import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createFormalWireAjv} from '../src/personal-aios-formal-text.ts';
import type {ScopeConfirmationView} from '../../../../../capability/contracts/scope-grant.ts';

const root=new URL('../../../../../',import.meta.url),bytes=readFileSync(new URL('integrations/contracts/formal-message.v1.json',root));
const wire=JSON.parse(bytes.toString()),accepts=createFormalWireAjv().compile({$defs:wire.$defs,...wire.outputs.voice_confirmations});
const scope:ScopeConfirmationView={grant_request:{scope_session_id:'scope:demo',target_id:'deck:demo',target_device_id:'mac:demo',
  expires_at:'2026-10-26T02:00:00.000Z',allowed_operation_kinds:['document.text.update']},preview_items:['第 2 页：30 万杯 → 50 万杯']};
const card={confirmation_id:'a'.repeat(64),event_id:'approval:demo',expires_in_ms:60000,kind:'native_approval',text:'本次会议仅修改此文件文字',scope_confirmation:scope};
const message=(confirmation:unknown)=>({schema_version:wire.schema,operation:'voice_confirmations',session_id:'session:demo',confirmations:[confirmation]});

test('scope confirmation is additive to the existing owner confirmation wire and remains closed',()=>{
  assert.equal(accepts(message(card)),true,JSON.stringify(accepts.errors));
  const {scope_confirmation:_,...legacy}=card;assert.equal(accepts(message(legacy)),true);
  for(const extra of [{...card,scope_confirmation:{...scope,admission:{principal_id:'owner'}}},
    {...card,scope_confirmation:{...scope,grant_request:{...scope.grant_request,script:'activate'}}},
    {...card,scope_confirmation:{...scope,preview_items:['x'.repeat(241)]}},
    {...card,kind:undefined}])assert.equal(accepts(message(extra)),false);
});

test('formal scope contract and hash pins are identical in gateway and shipped client contract assets',()=>{
  const app='01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/';
  for(const file of [app+'Contracts/formal-message.v1.json','01-product-half-finished/glasses-android/app/src/test/resources/formal-message.v1.json'])
    assert.deepEqual(readFileSync(new URL(file,root)),bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');
  for(const file of [app+'Core/AssistantCentralTextWire.swift','01-product-half-finished/backend/phase0/gateway/src/personal-aios-formal-text.ts'])
    assert.ok(readFileSync(new URL(file,root),'utf8').includes(hash));
});
