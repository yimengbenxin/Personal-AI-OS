import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import {existsSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_RESOURCE_KEYS, PRODUCT_RESOURCE_OPTIONAL_KEYS } from '../src/product-resource-keys.ts';

const tool = fileURLToPath(new URL('../tools/mac-product-provision.ts', import.meta.url));

test('config keeps every resource the entrypoint reads (errands, Bark) and drops only retired ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-provision-'));
  const resources: Record<string, unknown> = Object.fromEntries(PRODUCT_RESOURCE_KEYS.map(key => [key, `/srv/${key}`]));
  for (const key of PRODUCT_RESOURCE_OPTIONAL_KEYS) resources[key] = `/srv/${key}`;
  resources.t03_authority_file = '/srv/retired';
  await writeFile(join(root, 'mac-product.json'), JSON.stringify({port: 8787, product_resources: resources}), {mode: 0o600});
  const out = JSON.parse(execFileSync(process.execPath, [tool, 'config', '--root', root], {encoding: 'utf8'}));
  assert.deepEqual(out.removed_resources, ['t03_authority_file']);
  const saved = JSON.parse(await readFile(join(root, 'mac-product.json'), 'utf8')).product_resources;
  for (const key of [...PRODUCT_RESOURCE_KEYS, ...PRODUCT_RESOURCE_OPTIONAL_KEYS]) assert.equal(saved[key], `/srv/${key}`, key);
  assert.equal('t03_authority_file' in saved, false);
});

 test('optional cloud config cleanup preserves raw environment expressions and leaves the legacy default alone', async () => {
  const root=await mkdtemp(join(tmpdir(),'cloud-provision-'));
  const configPath=join(root,'cloud.json'), legacyPath=join(root,'mac-product.json');
  const resources=Object.fromEntries(PRODUCT_RESOURCE_KEYS.map(key=>[key,'${PAIOS_UNSET_TEMPLATE_ROOT}/'+key]));
  const template={port:'${PAIOS_UNSET_PORT}',product_resources:{...resources,public_api_url:'https://${PAIOS_UNSET_HOST}:9443',retired:'drop'}};
  await writeFile(configPath,JSON.stringify(template),{mode:0o600});
  await writeFile(legacyPath,'legacy configuration untouched',{mode:0o600});
  execFileSync(process.execPath,[tool,'config','--root',join(root,'data'),'--config',configPath],{encoding:'utf8'});
  const saved=JSON.parse(await readFile(configPath,'utf8'));
  assert.equal(saved.port,template.port);assert.equal(saved.product_resources.public_api_url,template.product_resources.public_api_url);
  for(const key of PRODUCT_RESOURCE_KEYS) assert.equal(saved.product_resources[key],resources[key]);
  assert.equal('retired' in saved.product_resources,false);
  assert.equal(await readFile(legacyPath,'utf8'),'legacy configuration untouched');
 });

test('native Hermes MCP config uses an env reference, preserves existing config and unregisters without a key', async t => {
  const runtime=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT??'/opt/personal-aios-runtime/hermes-agent', python=process.env.PAIOS_HERMES_PYTHON??join(runtime,'.venv/bin/python');
  if(!existsSync(python)){t.skip('Hermes native Python unavailable');return;}
  const home=await mkdtemp(join(tmpdir(),'amap-mcp-')); t.after(()=>rm(home,{recursive:true,force:true}));
  const file=join(home,'amap.key'), product=join(home,'product.json'), KEY='synthetic-amap-secret-never-a-real-key';
  await writeFile(file,KEY,{mode:0o600});
  await writeFile(product,JSON.stringify({product_resources:{amap_key_file:'${NV1_KEY_FILE}'}}));
  await writeFile(join(home,'config.yaml'),'model: {default: fixture-model}\nplatform_toolsets: {api_server: [memory]}\nmcp_servers: {existing: {command: fixture}}\n');
  execFileSync(python,['-c',`
import importlib.util,json,os,sys,yaml
from pathlib import Path
home,product,source=map(Path,sys.argv[1:])
spec=importlib.util.spec_from_file_location('amap_config',source); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.configure_amap(home,product)
from tools.mcp_tool_config import _load_mcp_config
assert _load_mcp_config()['amap']['url']=='https://mcp.amap.com/mcp?key='+os.environ['PAIOS_AMAP_KEY']
text=(home/'config.yaml').read_text(); config=yaml.safe_load(text)
assert os.environ['PAIOS_AMAP_KEY'] not in text and '\u0024{PAIOS_AMAP_KEY}' in text
assert config['model']['default']=='fixture-model' and config['mcp_servers']['existing']=={'command':'fixture'}
assert 'amap' in config['platform_toolsets']['api_server']
for resources in [{},{'amap_key_file':str(home/'missing.key')},{'amap_key_file':os.environ['NV1_KEY_FILE']}]:
    Path(os.environ['NV1_KEY_FILE']).write_text('  ')
    product.write_text(json.dumps({'product_resources':resources})); module.configure_amap(home,product)
    assert 'amap' not in _load_mcp_config() and 'PAIOS_AMAP_KEY' not in os.environ
    assert 'amap' not in yaml.safe_load((home/'config.yaml').read_text())['platform_toolsets']['api_server']
` ,home,product,fileURLToPath(new URL('../../../../../integrations/hermes/personal_aios/run_api.py',import.meta.url))],
    {env:{...process.env,HERMES_HOME:home,PYTHONPATH:runtime,PYTHONDONTWRITEBYTECODE:'1',NV1_KEY_FILE:file},stdio:'pipe'});
  assert.ok(!(await readFile(join(home,'config.yaml'),'utf8')).includes(KEY));
});
