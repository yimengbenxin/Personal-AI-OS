import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {openModelSettingsEmbedding} from '../src/model-settings-embedding-runtime.ts';
import {localEmbeddingSpace,type LocalEmbeddingConfiguration} from '../src/visual/local-embedding.ts';
import {VisualMemory} from '../src/visual/store.ts';
import type {LocalModelEntry} from '../src/model-settings-local-catalog.ts';

test('restart recovers artifact pin and same label/dimensions changed weights rebuild before ACK',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'embedding-composition-')),visualDirectory=join(directory,'visual');
  const entry=(id:string):Extract<LocalModelEntry,{kind:'embedding'}>=>{
    const bytes=Buffer.from(id);writeFileSync(join(directory,id),bytes);
    return {id,display_name:id,kind:'embedding',config:{runtime:'transformers-clip-cpu',python:process.execPath,model_directory:directory,
      artifacts:[{path:id,sha256:createHash('sha256').update(bytes).digest('hex')}],dimensions:1024,space_id:'shared-label',threads:1,timeout_ms:1000}};
  };
  const a=entry('weights-a'),b=entry('weights-b');assert.ok(!('legacy' in a)&&!('legacy' in b));
  const options={environment_id:'fixture',master_key:Buffer.alloc(32,7),local_catalog:()=>({catalog_id:'fixture',models:[a,b]})};
  const authority=ModelSettingsAuthority.open(directory,options),legacy={model:'qwen3-vl-embedding',endpoint:'https://example.test/embedding',region:'cn-beijing',apiKey:'fixture-only'};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let block=false;
  const opener=async(config:LocalEmbeddingConfiguration)=>{if(block)await gate;
    return {embeddingSpace:localEmbeddingSpace(config),embedImage:async()=>[1,...Array(1023).fill(0)],embedQuery:async()=>[1,...Array(1023).fill(0)],close:async()=>{}};};
  let runtime=await openModelSettingsEmbedding(authority,visualDirectory,legacy,opener),store:VisualMemory|undefined;
  const attach=async()=>{store=await VisualMemory.open(visualDirectory,{...runtime.provider,describe:async()=>({caption:'fixture',ocr:''})});runtime.attach(store);await setImmediate();};
  const approve=(id:string,revision:number)=>{const actor={principal_id:'owner',device_id:'phone'},draft=authority.draft(actor,{action:'switch_local',expected_revision:revision,local_kind:'embedding',local_target:id});authority.commitDraft(actor,draft.draft_id,`switch-${id}`);};
  try{
    await attach();approve(a.id,0);await authority.activateLocal('embedding',async()=>assert.fail('watch owns activation'));
    assert.equal(store!.embeddingSpaceInfo()!.active.space.id,localEmbeddingSpace(a.config).id);
    await runtime.close();await store!.close();store=undefined;
    runtime=await openModelSettingsEmbedding(authority,visualDirectory,legacy,opener);await attach();
    assert.equal(runtime.provider.embeddingSpace.id,localEmbeddingSpace(a.config).id);
    block=true;approve(b.id,1);const activation=authority.activateLocal('embedding',async()=>assert.fail('watch owns activation'));
    assert.equal(authority.localState('embedding')!.effective.generation,1);
    assert.equal(store!.embeddingSpaceInfo()!.active.space.id,localEmbeddingSpace(a.config).id);
    release();await activation;
    assert.equal(authority.localState('embedding')!.effective.generation,2);
    assert.equal(store!.embeddingSpaceInfo()!.active.space.id,localEmbeddingSpace(b.config).id);
    assert.notEqual(localEmbeddingSpace(a.config).id,localEmbeddingSpace(b.config).id);
  }finally{release();await runtime.close();await store?.close();await authority.stopLocalActivations();authority.close();rmSync(directory,{recursive:true,force:true});}
});
