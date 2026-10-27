import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import AjvModule from 'ajv';
import {check} from '../../contracts.ts';
import {readBody} from '../../http-body.ts';
import type {PersonalAIOSRuntime, ToolCall} from '../../runtime.ts';
import type {ToolSchema} from '../../tool-contracts.ts';
import {to_mcp_result} from '../../../../../../../capability/sdk/ts/receipt.ts';
import {withMedia} from '../../../../../../../capability/sdk/ts/mcp-media.ts';
import {failure, type ResultAdapter, type ResultInput, type ToolPolicy} from '../../../../../../../capability/packages/ts-host/result.ts';

/** Supplied by the enabled-package authority; the host does not keep another registry or decide policy. */
export interface TSHostTool extends ToolPolicy {package: string; server: string; name: string;principal_id?:string}
export type CapabilityToolCatalog = () => ReadonlyMap<string, TSHostTool>;
type Runtime = Pick<PersonalAIOSRuntime, 'tool' | 'toolSchemas'>;
/** Package-owned argument preparation cannot be overridden by model-supplied selector fields. */
export async function prepareTSCall(policy:{package:string;name:string},args:Record<string,unknown>){
  const module=await import(new URL(`../../../../../../../capability/packages/${policy.package}/server/index.ts`,import.meta.url).href);
  return module.prepareCall?.(policy.name,args)??{args,business:args};
}
const context = {type: 'object', properties: {run_id: {type: 'string', minLength: 1},
  session_id: {type: 'string', minLength: 1}, tool_call_id: {type: 'string', minLength: 1}},
  required: ['run_id', 'session_id', 'tool_call_id'], additionalProperties: false};

/** HTTP MCP framing only; runtime.tool owns admission and all business effects. */
export function createTSMcpHost(runtime: Runtime, catalog: CapabilityToolCatalog, maximum: number) {
  const active = new Set<Server>();
  const adapters = new Map<string, Promise<{mapResult: ResultAdapter}>>();
  const ajv = new AjvModule.default({strict: false, validateFormats: false});
  function selected() {
    return [...catalog().values()].filter(tool => tool.server === 'platform_ts'&&!tool.principal_id);
  }
  function schemas() {
    const enabled = new Set(selected().map(tool => tool.name));
    return runtime.toolSchemas().filter(tool => enabled.has(tool.name));
  }
  function wireSchema(schema: ToolSchema) {
    const inputSchema = structuredClone(schema.parameters);
    const policy=selected().find(tool=>tool.name===schema.name)!;
    const operation=policy.effect_by_arg?.['$._operation'];
    if(operation)inputSchema.properties._operation={type:'string',enum:Object.keys(operation),
      description:'Derived from the business arguments by the package. Omit; supplied by the gateway.'};
    inputSchema.properties._context = {...context, description: 'Trusted gateway context. Omit; the gateway supplies and overwrites it.'};
    inputSchema.properties.owner_requested={type:'boolean',description:'Whether the owner explicitly requested this operation.'};
    // Alternatives constrain the same argument object, including their own closed property sets.
    function extend(branch: unknown) {
      const row = branch as {maxProperties?: number; additionalProperties?: boolean;
        properties?: Record<string, unknown>; oneOf?: unknown[]; anyOf?: unknown[]; allOf?: unknown[]};
      if (row.maxProperties !== undefined) row.maxProperties+=2;
      if (row.additionalProperties === false && row.properties){row.properties._context = inputSchema.properties._context;
        row.properties.owner_requested=inputSchema.properties.owner_requested;}
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) for (const child of row[key] ?? []) extend(child);
    }
    extend(inputSchema);
    return {name: schema.name, description: schema.description, inputSchema};
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const policy = selected().find(tool => tool.name === name);
    check(policy, 'CAPABILITY_TOOL_NOT_ENABLED', 404);
    const schema = schemas().find(tool => tool.name === name);
    check(schema, 'TOOL_NOT_ENABLED', 404);
    const {_context, owner_requested: _requested, ...wire} = args;
    const prepared=await prepareTSCall(policy,wire),business=prepared.business;
    const input: ResultInput = {name, args: prepared.args, policy, result: null, now: new Date().toISOString()};
    try {
      check(ajv.compile(context)(_context), 'TOOL_CONTEXT_REQUIRED', 403);
      check(ajv.compile(schema.parameters)(business), 'CAPABILITY_TOOL_ARGUMENT_INVALID');
      if (!adapters.has(policy.package)) adapters.set(policy.package, import(new URL(
        `../../../../../../../capability/packages/${policy.package}/server/index.ts`, import.meta.url).href));
      const adapter = await adapters.get(policy.package)!;
      const raw = process.env.PAIOS_STAGE==='staging'?JSON.parse(readFileSync(new URL(
        `../../../../../../../capability/packages/${policy.package}/tests/contract.yaml`,import.meta.url),'utf8')).cases
        .find((row:{tool:string})=>row.tool===name).raw:
        await runtime.tool(name, {context: _context as ToolCall['context'], args: business});
      input.result = raw; input.now = new Date().toISOString();
      const result=to_mcp_result(adapter.mapResult(input));
      return withMedia(result,raw);
    } catch (error) {
      return to_mcp_result(failure(input, error));
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    check(request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
    check(selected().length > 0, 'CAPABILITY_PACKAGE_DISABLED', 404);
    const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBody(request, maximum)));
    check(!Array.isArray(body), 'MCP_BATCH_UNSUPPORTED');
    const server = new Server({name: 'yimi-platform-ts', version: '1.0.0'}, {capabilities: {tools: {}}});
    const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse: true});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: schemas().map(wireSchema)}));
    server.setRequestHandler(CallToolRequestSchema, async call => {
      const result = await callTool(call.params.name, call.params.arguments ?? {});
      return {...result, structuredContent: {...result.structuredContent}};
    });
    active.add(server);
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [key, val] of Object.entries(request.headers))
        if (val !== undefined && key !== 'content-length') headers.set(key, Array.isArray(val) ? val.join(',') : val);
      const reply = await transport.handleRequest(new Request('http://localhost/internal/capability/mcp', {method: 'POST', headers}), {parsedBody: body});
      const out: Record<string, string> = {'cache-control': 'no-store'};
      reply.headers.forEach((val, key) => out[key] = val); response.writeHead(reply.status, out);
      if (reply.body) await pipeline(Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]), response);
      else response.end();
    } finally {active.delete(server); await server.close();}
  }
  return {handle, callTool, tools: () => schemas().map(wireSchema),
    close: () => Promise.all([...active].map(server => server.close()))};
}
