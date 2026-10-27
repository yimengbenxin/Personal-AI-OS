import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openLocalEmbedding,validateLocalEmbeddingConfiguration,localEmbeddingSpace,type LocalEmbeddingConfiguration} from '../src/visual/local-embedding.ts';
const configuredPython=process.env.PAIOS_EMBEDDING_TEST_PYTHON||process.env.PAIOS_VISION_PYTHON||'python3';
const fixturePython=isAbsolute(configuredPython)?configuredPython:execFileSync('/usr/bin/which',[configuredPython],{encoding:'utf8'}).trim();
const config=(directory:string,python=fixturePython):LocalEmbeddingConfiguration=>({runtime:'transformers-clip-cpu',python,model_directory:directory,
  artifacts:[{path:'config.json',sha256:'a'.repeat(64)}],dimensions:3,space_id:'fixture:local:clip:pinned',threads:1,timeout_ms:5000});

test('local embedding boundary rejects absent pins, traversal, duplicate artifacts, invalid budget, and unsupported runtimes',()=>{
  const valid=config('/fixture');assert.equal(validateLocalEmbeddingConfiguration(valid),valid);
  for(const value of [null,{...valid,model_directory:'relative'},{...valid,python:'python3'},{...valid,dimensions:0},{...valid,runtime:'text-only'},
    {...valid,artifacts:[{path:'../weights',sha256:'a'.repeat(64)}]}, {...valid,artifacts:[valid.artifacts[0],valid.artifacts[0]]},
    {...valid,artifacts:[null]}, {...valid,timeout_ms:0},{...valid,download:true}]){
    assert.throws(()=>validateLocalEmbeddingConfiguration(value),/LOCAL_EMBEDDING_/u);
  }
});

test('configured CPU process transport serves both modalities and closes; fixture does not load a model',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'clip-transport-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=join(directory,'fixture-python');
  await writeFile(script,"#!/usr/bin/env python3\nimport sys,json\njson.loads(sys.stdin.readline())\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({'vector':[1,0,0]}),flush=True)\n");await chmod(script,0o700);
  const local=await openLocalEmbedding(config(directory,script));t.after(()=>local.close());
  assert.deepEqual(local.embeddingSpace,localEmbeddingSpace(config(directory,script)));
  assert.deepEqual(await local.embedImage(Buffer.from('synthetic')), [1,0,0]);
  assert.deepEqual(await local.embedQuery('fixture query'),[1,0,0]);
  await assert.rejects(local.embedImage(Buffer.alloc(0)),/LOCAL_EMBEDDING_IMAGE_TOO_LARGE/u);
  await local.close();await assert.rejects(local.embedQuery('after close'),/LOCAL_EMBEDDING_CLOSED/u);
});

test('real offline worker rejects text-only pinned package before importing inference dependencies',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'clip-text-only-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const files={'config.json':JSON.stringify({model_type:'bert',projection_dim:3,text_config:{hidden_size:3}}),
    'preprocessor_config.json':'{}','tokenizer_config.json':'{}','vocab.json':'{}','merges.txt':'# synthetic','model.safetensors':'synthetic invalid weights never loaded'};
  const artifacts=[];
  for(const [path,value] of Object.entries(files)){await writeFile(join(directory,path),value);artifacts.push({path,sha256:createHash('sha256').update(value).digest('hex')});}
  await assert.rejects(openLocalEmbedding({...config(directory),artifacts}),/LOCAL_EMBEDDING_MULTIMODAL_REQUIRED/u);
});

test('VisualMemory owns local process until suspended old query releases its generation, and joins it once',async t=>{
  const {VisualMemory}=await import('../src/visual/store.ts');
  const directory=await mkdtemp(join(tmpdir(),'clip-process-lease-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=join(directory,'fixture-python');
  await writeFile(script,"#!/usr/bin/env python3\nimport sys,json\nsettings=json.loads(sys.stdin.readline())\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n json.loads(line)\n print(json.dumps({'vector':[1]+[0]*(settings['dimensions']-1)}),flush=True)\n");await chmod(script,0o700);
  const local=await openLocalEmbedding({...config(directory,script),dimensions:1024});let closes=0;
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  const initial={...local,close:async()=>{closes++;await local.close();},embedQuery:async(text:string)=>{entered.resolve();await gate.promise;return local.embedQuery(text);}};
  const store=await VisualMemory.open(join(directory,'memory'),{...initial,describe:async()=>({caption:'',ocr:''})});
  t.after(()=>store.close());
  const query=store.recall('owner',{query:'suspended'});await entered.promise;
  for(const dimensions of [3,4]){
    const next={embeddingSpace:{id:`fixture:${dimensions}`,dimensions},embedImage:async()=>[1,...Array(dimensions-1).fill(0)],embedQuery:async()=>[1,...Array(dimensions-1).fill(0)]};
    const candidate=await store.prepareEmbeddingSpace(next);store.activateEmbeddingSpace(candidate);
  }
  assert.equal(closes,0);assert.equal((await local.embedQuery('process remains usable')).length,1024);
  gate.resolve();assert.deepEqual((await query).frames,[]);await store.close();assert.equal(closes,1);
  await assert.rejects(local.embedQuery('closed process'),/LOCAL_EMBEDDING_CLOSED/u);
});

test('local vector identity follows artifact pins and preprocessing rather than a reused label',()=>{
  const first=config('/fixture'),sameLabel={...first,artifacts:[{path:'config.json',sha256:'b'.repeat(64)}]};
  assert.notEqual(localEmbeddingSpace(first).id,localEmbeddingSpace(sameLabel).id);
  assert.equal(localEmbeddingSpace(first).dimensions,localEmbeddingSpace(sameLabel).dimensions);
  const tokenizer={path:'tokenizer_config.json',sha256:'c'.repeat(64)};
  assert.equal(localEmbeddingSpace({...first,artifacts:[first.artifacts[0]!,tokenizer]}).id,
    localEmbeddingSpace({...first,artifacts:[tokenizer,first.artifacts[0]!]}).id);
  assert.notEqual(localEmbeddingSpace(first).id,localEmbeddingSpace({...first,artifacts:[...first.artifacts,tokenizer]}).id);
});

test('failed local process surfaces the failed request and reopens the same pin on a later use after cooldown',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'clip-process-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=join(directory,'fixture-python');
  await writeFile(script,"#!/usr/bin/env python3\nimport sys,json\nsettings=json.loads(sys.stdin.readline())\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n if request['value']=='fail':\n  print(json.dumps({'error':'LOCAL_EMBEDDING_RUNTIME_FAILED'}),flush=True)\n else:\n  print(json.dumps({'vector':[1]+[0]*(settings['dimensions']-1)}),flush=True)\n");await chmod(script,0o700);
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const configuration=config(directory,script),local=await openLocalEmbedding(configuration);t.after(()=>local.close());
  const pin=local.embeddingSpace.id;
  await assert.rejects(local.embedQuery('fail'),/LOCAL_EMBEDDING_RUNTIME_FAILED/u);
  await assert.rejects(local.embedQuery('cooldown'),/LOCAL_EMBEDDING_RECOVERING/u);
  clock+=30001;
  assert.deepEqual(await local.embedQuery('later use'),[1,0,0]);assert.equal(local.embeddingSpace.id,pin);
});
