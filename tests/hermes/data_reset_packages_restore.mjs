import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry,readPackage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/registry.ts';
import {EnabledPackages} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/selection.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
let input='';for await(const chunk of process.stdin)input+=chunk;
const {owner,operation,name='yimi-capability-template',version='0.1.0',python}=JSON.parse(input);
const principal='synthetic-owner',context={principal_id:principal,scope:'owner',run_id:'reset-packages'};
const central=join(owner,'central-storage'),root=join(central,'capability-registry');
await mkdir(root,{recursive:true});
const hostCalls=[];
// Native prepare/activate is the only authority seam; selection CAS and projection are production code.
const authority=new EnabledPackages(new PosixStorage(central),{tools:new Map()},
  {capability:async(op,body)=>{hostCalls.push({op,name:body.version?.name??body.name});return {};}});
const runner={check:async path=>JSON.parse(execFileSync(python,
  [join(ROOT,'tests/hermes/data_reset_packages_restore_driver.py'),path],{encoding:'utf8'})),health:async()=>true};
const registry=new CapabilityRegistry(root,authority,runner,{},{});
let result;
if(operation==='publish'){
  const files=await readPackage(join(ROOT,'capability/templates/yimi-capability-template'));
  files['server/server.py']=files['server/server.py'].replace('/opt/yimi/capability/contracts/receipt.v1.schema.json',join(ROOT,'capability/contracts/receipt.v1.schema.json'));
  files['scripts/test.py']=files['scripts/test.py'].replace('import runpy','import runpy\nfrom pathlib import Path').replace("'/package/server/server.py'","str(Path(__file__).resolve().parents[1]/'server/server.py')");
  const manifest=JSON.parse(files['plugin.json']);manifest.name=name;manifest.version=version;
  files['plugin.json']=JSON.stringify(manifest);
  const checked=await registry.check(context,files);
  result={checked,published:await registry.publish(context,checked.candidate_id)};
}else if(operation==='rollback')result=await registry.rollback(context,name);
console.log(JSON.stringify({result,status:await registry.status(context),hostCalls}));
