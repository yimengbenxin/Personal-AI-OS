import {readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {withMedia} from '../../../../../capability/sdk/ts/mcp-media.ts';

/** Fixture transport, using each package's real result adapter. No accounts or devices. */
export async function serveFake(root: URL) {
  const manifest = JSON.parse(readFileSync(new URL('plugin.json', root), 'utf8')).extensions['ai.yimi.capability'];
  const fixtures = JSON.parse(readFileSync(new URL('tests/contract.yaml', root), 'utf8')).cases;
  const {mapResult} = await import(new URL('server/index.ts', root).href);
  const revisions = new Map<string, number>();
  const server = new Server({name: 'yimi-ts-fixture', version: '1'}, {capabilities: {tools: {}}});
  const schemas = enabledToolSchemas({memory: true, actions: true, ambient: true, visual: true, voiceprint: true,
    health: true, contacts: true, places: true, movement: true, desktop_queue: true, model_settings: true});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: schemas.filter(tool => manifest.tools[tool.name])
    .map(({name, description, parameters}) => ({name, description, inputSchema: parameters}))}));
  server.setRequestHandler(CallToolRequestSchema, async call => {
    const key = JSON.stringify([call.params.name, call.params.arguments ?? {}]);
    const matches = fixtures.filter((row: any) => row.tool === call.params.name && JSON.stringify(row.args) === JSON.stringify(call.params.arguments ?? {}));
    const revision = revisions.get(key) ?? 0;
    const sample = matches[Math.min(revision, matches.length - 1)] ?? fixtures.find((row: any) => row.tool === call.params.name);
    revisions.set(key, revision + 1);
    if (!sample) throw new Error('FIXTURE_NOT_FOUND');
    const result = to_mcp_result(mapResult({name: call.params.name, args: call.params.arguments ?? {}, result: sample.raw,
      policy: manifest.tools[call.params.name], now: '2026-10-24T12:00:00.000Z'}));
    return withMedia(result,sample.raw);
  });
  await server.connect(new StdioServerTransport());
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const directory=process.argv[2];
  if(!directory)throw new Error('PACKAGE_ROOT_REQUIRED');
  await serveFake(pathToFileURL(resolve(directory)+sep));
}
