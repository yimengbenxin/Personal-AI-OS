import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import AjvModule from 'ajv/dist/2020.js';
import {check,sha256} from '../contracts.ts';
import type {SendPolicy} from './send-identity.ts';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const schema = JSON.parse(readFileSync(resolve(root, 'capability/contracts/manifest.v1.schema.json'), 'utf8'));
interface Extension {
  runtime: {server: string}; scopes: string[];
  tools: Record<string, Omit<PackageTool, 'package'|'server'|'name'|'scopes'>>;
}
const validate = new AjvModule.default({strict: true}).compile<Extension>(schema);
/** Hermes' MCP wire encoding, including its provider name limit. Verified against the composed producer. */
export function mcpIdentity(server:string,name:string):string{
  const encode=(part:string)=>part.replace(/[^A-Za-z0-9_]/gu,'_');
  const full=`mcp__${encode(server)}__${encode(name)}`;
  return full.length<=64?full:`${full.slice(0,55)}_${sha256(full).slice(0,8)}`;
}
export interface PackageSelection {enabled: string[]; gateway: string[]; single_host_flags?: Record<string, string>}
export interface PackageTool {
  package: string; server: string; name: string; scopes: string[];
  effect?: string; effect_by_arg?: Record<string, Record<string, string>>; target?: string; task_type?: string;
  retry: string; check_with?: string; context_inject?: string[];
  aliases?:string[]; transport_name?:string; version_digest?:string;
  principal_id?:string;
  send_consent?:SendPolicy;
}
/** The deploy config selects packages; their manifests alone declare tool identity and policy. */
export function packageSelection():PackageSelection {
    const config = JSON.parse(readFileSync(process.env.PAIOS_PRODUCT_CONFIG ?? resolve(root, 'deploy/cloud/cloud.json'), 'utf8'));
    return config.capability_packages??{enabled:[],gateway:[]};
}
export function packageCatalog(selection:PackageSelection=packageSelection()): Map<string, PackageTool> {
  const selected=selection;
  const catalog = new Map<string, PackageTool>();
  for (const name of selected.enabled) {
    if(name==='yimi')continue;
    check(/^[a-z][a-z0-9-]*$/u.test(name), 'CAPABILITY_PACKAGE_NAME_INVALID');
    const directory = resolve(root, 'capability/packages', name);
    check(directory.startsWith(resolve(root, 'capability/packages') + sep), 'CAPABILITY_PACKAGE_PATH_INVALID');
    const manifest = JSON.parse(readFileSync(resolve(directory, 'plugin.json'), 'utf8'));
    const extension:unknown = manifest.extensions['ai.yimi.capability'];
    check(validate(extension), 'CAPABILITY_MANIFEST_INVALID');
    if (!selected.gateway.includes(name)) continue;
    const flag = selected.single_host_flags?.[name];
    if (process.env.PAIOS_DEPLOYMENT === 'single-host' && flag && process.env[flag] !== '1') continue;
    const definition=JSON.parse(readFileSync(resolve(directory,'mcp.json'),'utf8')).mcpServers[extension.runtime.server];
    const shared=definition.args?.[0]==='-m'&&definition.args?.[1]==='capability.hosts.python';
    for (const [tool, policy] of Object.entries(extension.tools)) {
      const identity = `mcp__${extension.runtime.server}__${tool}`;
      const transport=mcpIdentity(shared?'yimi_shared':extension.runtime.server,shared?`${extension.runtime.server}__${tool}`:tool);
      check(!catalog.has(identity), 'CAPABILITY_TOOL_CONFLICT');
      catalog.set(identity, {package: name, server: extension.runtime.server, name: tool,
        scopes: extension.scopes, ...policy,
        transport_name:transport,
        aliases:[...(transport!==identity?[transport]:[]),
          ...(['messaging','platform_ts'].includes(extension.runtime.server)?[tool]:[])]});
    }
  }
  return catalog;
}
