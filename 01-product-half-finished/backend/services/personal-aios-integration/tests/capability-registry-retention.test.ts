import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CapabilityRegistry,readPackage} from '../src/capability/registry/registry.ts';
import type {PackageVersion,ContractEvidence} from '../src/capability/registry/interfaces.ts';
import {succeeded,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {fileURLToPath} from 'node:url';

const context={principal_id:'owner',run_id:'run',scope:'build'};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function filesUnder(root:string):Promise<string[]>{
  const files:string[]=[];
  for(const name of await readdir(root).catch(()=>[])){
    const path=join(root,name);if((await lstat(path)).isDirectory())files.push(...await filesUnder(path));else files.push(path);
  }
  return files;
}
async function bytes(root:string){let total=0;for(const path of await filesUnder(root))total+=(await lstat(path)).size;return total;}
async function fixture(t:test.TestContext,options:object={}){
  const root=await mkdtemp(join(tmpdir(),'registry-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const current=new Map<string,PackageVersion>(),staged:string[]=[],reservations:number[]=[];
  let fail=false,mutate=false,at=1000;
  const authority={installed:async()=>[...current.values()],enabled:async()=>[...current.values()],
    replace:async(_context:any,{name,expected,next}:any)=>{assert.equal(current.get(name)?.digest??null,expected);if(next)current.set(name,next);else current.delete(name);}};
  const evidence:ContractEvidence={success:true,errors:[],cases:['server','fake'].map(implementation=>({implementation,tool:'sample',args:{},
    result:to_mcp_result(succeeded()),writes:[],network:[]}))};
  const runner={check:async(path:string)=>{staged.push(path);if(mutate)await writeFile(join(path,'fixture.txt'),'changed');if(fail)throw Error('fixture_check_failed');return evidence;},health:async()=>true};
  const policy={candidate_ttl_ms:1000,max_bytes:200000,now:()=>at,reserve:async(n:number)=>{reservations.push(n);},...options};
  const make=()=>new CapabilityRegistry(root,authority,runner,{outcomes:async()=>({total:0,failed:0,unknown:0})},
    {hub:async()=>[],mcp:async()=>[]},policy);
  const files=await readPackage(fileURLToPath(new URL('../../../../../capability/templates/yimi-capability-template',import.meta.url)));
  const version=(n:number)=>{const manifest=JSON.parse(files['plugin.json']!);manifest.version=`1.0.${n}`;
    return {...files,'plugin.json':JSON.stringify(manifest),'fixture.txt':'fixture-'+n};};
  return {root,current,make,registry:make(),version,staged,reservations,fail:()=>{fail=true;},mutate:()=>{mutate=true;},advance:()=>{at+=2000;}};
}
test('failed and mutated checks leave no candidate, package files or staging transaction',async t=>{
  for(const mode of ['fail','mutate'] as const){
    const f=await fixture(t);f[mode]();
    for(let n=0;n<4;n++)await assert.rejects(f.registry.check(context,f.version(n)),/fixture_check_failed|checked_package_changed/);
    assert.deepEqual(await filesUnder(f.root),[]);
  }
});
test('checking an existing digest cannot mutate its enabled recovery copy',async t=>{
  const f=await fixture(t),files=f.version(0),checked=await f.registry.check(context,files);
  const published=await f.registry.publish(context,checked.candidate_id);
  f.mutate();await assert.rejects(f.registry.check(context,files),/checked_package_changed/);
  assert.equal(await readFile(join(published.version.root,'fixture.txt'),'utf8'),files['fixture.txt']);
});
test('startup reclaims expired candidates, abandoned transactions and orphan versions, preserving current and previous',async t=>{
  const f=await fixture(t);
  const first=await f.registry.check(context,f.version(0)),v1=await f.registry.publish(context,first.candidate_id);
  const second=await f.registry.check(context,f.version(1)),v2=await f.registry.publish(context,second.candidate_id);
  await f.registry.check(context,f.version(2));
  const orphan=join(f.root,'versions',hash('owner'),'orphan','f'.repeat(64));await mkdir(orphan,{recursive:true});await writeFile(join(orphan,'leftover'),'fixture');
  await mkdir(join(f.root,'staging','interrupted'),{recursive:true});await writeFile(join(f.root,'staging','interrupted','leftover'),'fixture');
  await writeFile(join(f.root,'interrupted.json.tmp'),'fixture');
  const historyPath=join(f.root,hash('owner')+'.json'),history=JSON.parse(await readFile(historyPath,'utf8'));
  await writeFile(historyPath,JSON.stringify(history.map(({principal:_,...row}:any)=>row))); // Historical release arrays did not carry their principal.
  f.advance();
  const restored=f.make();await restored.recover();
  await f.make().recover(); // Legacy history must still protect the retained copies after its candidates are gone.
  const paths=await filesUnder(f.root);
  assert.equal(paths.some(path=>path.endsWith('.candidate.json')||path.includes('/staging/')||path.includes('/orphan/')||path.endsWith('.tmp')),false);
  assert.deepEqual(await readPackage(v1.version.root),f.version(0));assert.deepEqual(await readPackage(v2.version.root),f.version(1));
  await restored.rollback(context);assert.equal(f.current.values().next().value!.digest,v1.version.digest);
});
test('startup retains both rollback points while an activation transaction is still prepared',async t=>{
  const f=await fixture(t);
  const first=await f.registry.check(context,f.version(0)),v1=await f.registry.publish(context,first.candidate_id);
  const second=await f.registry.check(context,f.version(1)),v2=await f.registry.publish(context,second.candidate_id);
  const third=await f.registry.check(context,f.version(2));
  const candidate=JSON.parse(await readFile(join(f.root,third.candidate_id+'.candidate.json'),'utf8'));
  const historyPath=join(f.root,hash('owner')+'.json'),history=JSON.parse(await readFile(historyPath,'utf8'));
  history.push({id:'interrupted',name:v2.version.name,before:v2.version,after:candidate.version,reverted:false,reason:'publish',state:'prepared'});
  await writeFile(historyPath,JSON.stringify(history));f.advance();await f.make().recover();
  for(const version of [v1.version,v2.version,candidate.version])assert.ok((await readPackage(version.root))['plugin.json']);
  assert.equal(f.current.values().next().value!.digest,v2.version.digest);
});
test('candidate TTL is enforced at publish and checked, even without another write',async t=>{
  const f=await fixture(t),candidate=await f.registry.check(context,f.version(0));f.advance();
  await assert.rejects(f.registry.publish(context,candidate.candidate_id),/candidate_expired/);
  await assert.rejects(f.registry.checked(context,candidate.candidate_id),/candidate_expired/);
  assert.equal(f.current.size,0);
});
test('startup can reclaim legacy storage while reserve rejects every new write',async t=>{
  let pressure=false;
  const f=await fixture(t,{reserve:async()=>{if(pressure)throw Error('fixture_storage_reserve');}});
  const candidate=await f.registry.check(context,f.version(0)),published=await f.registry.publish(context,candidate.candidate_id);
  const path=join(f.root,hash('owner')+'.json'),history=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify(history.map(({principal:_,...row}:any)=>row)));
  f.advance();pressure=true;await f.make().recover();await f.make().recover();
  assert.ok((await readPackage(published.version.root))['plugin.json']);
  assert.equal((await filesUnder(f.root)).some(path=>path.endsWith('.candidate.json')),false);
});
test('total quota spans principals and metadata; storage reserve rejects before registration writes',async t=>{
  const f=await fixture(t,{max_bytes:30000});let refused=0;
  for(let n=0;n<12;n++){
    const input={...f.version(n),'payload.txt':'x'.repeat(10000)};
    try{await f.registry.check({...context,principal_id:n%2?'other':'owner'},input);}
    catch(error){assert.match(String(error),/package_storage_quota/);refused++;}
    assert.ok(await bytes(f.root)<=30000);
  }
  assert.ok(refused>0);assert.ok(f.reservations.length>0);
  const blocked=await fixture(t,{reserve:async()=>{throw Error('fixture_storage_reserve');}});
  await assert.rejects(blocked.registry.check(context,blocked.version(0)),/fixture_storage_reserve/);
  assert.equal(blocked.staged.length,0);assert.deepEqual(await filesUnder(blocked.root),[]);
});
