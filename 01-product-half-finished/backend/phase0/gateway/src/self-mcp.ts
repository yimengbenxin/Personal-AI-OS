import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {check,ContractError,EVENT_SCHEMA} from '../../../services/personal-aios-integration/src/contracts.ts';
import {readBody} from '../../../services/personal-aios-integration/src/http-body.ts';
import {RuntimeEventStore} from '../../../services/personal-aios-integration/src/self-events.ts';
import {runtimeAggregates,memoryLayerCounts} from '../../../services/personal-aios-integration/src/self-metrics.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import type {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import type {L3Service} from '../../../services/personal-aios-integration/src/memory/l3.ts';
import type {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import pkg from '../package.json' with {type:'json'};
import {errandOutcomes} from './self-errands.ts';
import {PersonalityZone} from '../../../services/personal-aios-integration/src/personality/zone.ts';

const context={type:'object',properties:{run_id:{type:'string'},session_id:{type:'string'},tool_call_id:{type:'string'}},required:['run_id','session_id','tool_call_id'],additionalProperties:false};
const tools=[
  {name:'runtime_query',description:'Read my own runtime sources (source): events/gateway_logs are sanitized structured diagnostics whose channel field is input-device metadata, not a delivery route; hermes_agent/hermes_errors/mcp_stderr are secret-redacted retained log tails; errands includes all retained states and producer step traces; release reads production receipts; resources reads own Gateway/Hermes cgroup CPU and memory; personality reads my preference document and version history (offset/limit). limit bounds rows (1-100). Default metrics: calls, turns, speaker verdicts/similarity by channel, failures, latency percentiles, video lifecycle and backlogs. Default metrics omit transcripts. Verdicts are not labeled accuracy. Omit time bounds for the last 24 hours. Authentication context is supplied by Hermes; never invent it.',
    inputSchema:{type:'object',properties:{since:{type:'number',description:'Inclusive Unix epoch milliseconds, UTC'},until:{type:'number',description:'Inclusive Unix epoch milliseconds, UTC'},channel:{type:'string',description:'Physical input device that produced the event: phone, glasses, mac, watch or rtc_*; unknown means the event recorded no input-device metadata. channel never names an output, recipient or delivery route, so unknown is not a routing or delivery failure'},service:{type:'string',enum:['gateway','hermes']},level:{type:'string',enum:['DEBUG','INFO','WARNING','ERROR','CRITICAL']},text:{type:'string',maxLength:200},source:{type:'string',enum:['metrics','events','gateway_logs','hermes_agent','hermes_errors','mcp_stderr','errands','release','resources','personality']},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,description:'Personality history offset; read-only'},request_id:{type:'string'},_local:{type:['object','null']},_context:context,_l4:{type:'null'},_identity:{type:'null'}},additionalProperties:false}},
  {name:'runtime_status',description:'Read my memory-layer counts, voiceprint enrollment status, safe configuration, personality preferences/versions and version identity. L4 counts come from Hermes session_search. Background inventory yields to live calls; runtime_query remains available. Authentication context is supplied by Hermes.',
    inputSchema:{type:'object',properties:{_local:{type:'null'},_context:context,_l4:{type:'object'},_identity:{type:'object'}},additionalProperties:false}}
] satisfies Tool[];
export async function createSelfSurface(options:{storage:PosixStorage;l3?:L3Service;voiceprint?:VoiceprintRegistry;
  model_route?:{provider:string;model:string;base_url:string};policy_version:string;errand_spool?:string;busy?:()=>boolean;onError:(error:unknown)=>void;store?:RuntimeEventStore}) {
  const store=options.store??new RuntimeEventStore({directory:join(options.storage.root,'runtime-events'),onError:options.onError});
  await store.flush();
  const owned=options.store===undefined;
  let closed=false;
  const active=new Set<Server>();
  async function query(runtime:Pick<PersonalAIOSRuntime,'scheduleContext'>,name:string,args:Record<string,unknown>) {
    const schema=tools.find(t=>t.name===name);check(schema,'SELF_TOOL_UNKNOWN',404);
    check(Object.keys(args).every(k=>k in schema.inputSchema.properties),'SELF_ARGUMENT_INVALID');
    const binding=args._context as Parameters<PersonalAIOSRuntime['scheduleContext']>[0];
    check(binding&&typeof binding==='object','SELF_OWNER_CONTEXT_REQUIRED',403);
    // Admission resolves these native keys to the authoritative D and its owner origin on every call.
    const owner=await runtime.scheduleContext(binding);
    check(owner.allow_owner_mutation===true,'SELF_OWNER_REQUIRED',403);
    if(name==='runtime_status'){
      const layers=await memoryLayerCounts({principal:owner.principal_id,storage:options.storage,
        ...(options.l3?{l3:options.l3}:{}),...(options.voiceprint?{voiceprint:options.voiceprint}:{}),...(options.busy?{busy:options.busy}:{})});
      const l4=args._l4 as {sessions?:unknown;complete?:unknown}|undefined;
      check(l4&&Number.isSafeInteger(l4.sessions)&&Number(l4.sessions)>=0&&Number(l4.sessions)<=10&&l4.complete===false,'SELF_L4_CONTEXT_REQUIRED');
      const identity=args._identity as Record<string,unknown>|undefined;
      check(identity&&['hermes_version','provider','model'].every(k=>identity[k]===null||typeof identity[k]==='string'&&identity[k].length<=256),'SELF_IDENTITY_REQUIRED');
      return {schema:'paios.self.status.v1',as_of:Date.now(),...layers,l4:{sessions:l4.sessions,complete:l4.complete,source:'Hermes session_search',scope:'Browse-visible recent sessions, up to 10; current and hidden sessions excluded'},
        personality_zone:{read_only:true,...await new PersonalityZone(options.storage).read(owner.principal_id)},
        identity:{gateway_version:pkg.version,node:process.version,event_schema:EVENT_SCHEMA,policy_version:options.policy_version,
          hermes_version:identity.hermes_version,configured_main_model:{provider:identity.provider,model:identity.model},
          configured_gateway_model:options.model_route?{provider:options.model_route.provider,model:options.model_route.model}:null},store:store.snapshot()};
    }
    const source=args.source??'metrics',limit=args.limit??50;
    check(tools[0].inputSchema.properties.source.enum.includes(source as never),'SELF_SOURCE_INVALID');
    check(typeof limit==='number'&&Number.isInteger(limit)&&limit>=1&&limit<=100,'SELF_LIMIT_INVALID');
    if(source==='personality')return {read_only:true,...await new PersonalityZone(options.storage).read(owner.principal_id,
      args.offset as number|undefined,Math.min(limit,50))};
    check(args.service===undefined||['gateway','hermes'].includes(String(args.service)),'SELF_SERVICE_INVALID');
    const levels=['DEBUG','INFO','WARNING','ERROR','CRITICAL'];
    check(args.level===undefined||levels.includes(String(args.level)),'SELF_LEVEL_INVALID');
    check(args.text===undefined||typeof args.text==='string'&&args.text.length<=200,'SELF_TEXT_INVALID');
    const until=args.until??Date.now(),since=args.since??Number(until)-86400000;
    check(typeof since==='number'&&Number.isSafeInteger(since)&&since>=0&&typeof until==='number'&&Number.isSafeInteger(until)&&until>=since,'SELF_TIME_RANGE_INVALID');
    check(args.channel===undefined||typeof args.channel==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/.test(args.channel),'SELF_CHANNEL_INVALID');
    if(['hermes_agent','hermes_errors','mcp_stderr','errands','release','resources'].includes(String(source))){
      check(args._local&&typeof args._local==='object'&&!Array.isArray(args._local)&&Buffer.byteLength(JSON.stringify(args._local))<=131072,'SELF_LOCAL_CONTEXT_REQUIRED');
      const observation:Record<string,unknown>={hermes:args._local};
      if(source==='resources'){
        const values:Record<string,string|null>={};
        for(const name of ['cpu.stat','cpu.max','memory.current','memory.max','memory.events']){
          try{values[name]=(await readFile(join('/sys/fs/cgroup',name),'utf8')).slice(0,2048);}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;values[name]=null;}
        }
        observation.gateway={source:'own container cgroup v2',values};
      }
      return {schema:'paios.self.observation.v1',as_of:Date.now(),source,...observation};
    }
    const events=await store.read({since,until,...(typeof args.channel==='string'?{channel:args.channel}:{})});
    if(source==='events'||source==='gateway_logs'){
      const records=events.filter(e=>(source!=='gateway_logs'||e.log_schema==='paios.runtime.log.v1')&&
        (args.service===undefined||e.service===args.service)&&(args.level===undefined||levels.indexOf(String(e.level))>=levels.indexOf(String(args.level)))&&
        (args.text===undefined||JSON.stringify(e).toLowerCase().includes(String(args.text).toLowerCase())));
      return {schema:'paios.self.observation.v1',source,window:{since,until},records:records.slice(-limit),metadata_unknown:events.filter(e=>!e.log_schema).length,
        truncated:records.length>limit||store.snapshot().query_truncated,scope:'Retained structured producer logs; legacy events have unknown log metadata',store:store.snapshot()};
    }
    const errands=options.errand_spool?await errandOutcomes(options.errand_spool,owner.principal_id,since,until,options.busy):{status:'disabled'};
    return {schema:'paios.self.metrics.v1',window:{since,until},...runtimeAggregates(events),errands,store:store.snapshot()};
  }
  async function handle(runtime:PersonalAIOSRuntime,request:IncomingMessage,response:ServerResponse) {
    check(!closed,'SELF_CLOSED',503);check(request.method==='POST','METHOD_NOT_ALLOWED',405);
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBody(request,262144)));
    check(!Array.isArray(body),'SELF_BATCH_UNSUPPORTED');
    check(active.size<4,'SELF_BUSY',429);
    const server=new Server({name:'paios-self',version:'1'},{capabilities:{tools:{}}});
    const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
    server.setRequestHandler(CallToolRequestSchema,async call=>{
      try{const result=await query(runtime,call.params.name,call.params.arguments??{});
        return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
      catch(error){const code=error instanceof ContractError?error.code:'SELF_QUERY_FAILED';
        if(!(error instanceof ContractError))options.onError(error);
        return {isError:true,content:[{type:'text',text:code}]};}
    });
    active.add(server);
    try{
      await server.connect(transport);
      const headers=new Headers();for(const [k,v] of Object.entries(request.headers))if(v!==undefined&&k!=='content-length')headers.set(k,Array.isArray(v)?v.join(','):v);
      const reply=await transport.handleRequest(new Request('http://localhost/internal/self/mcp',{method:'POST',headers}),{parsedBody:body});
      const out:Record<string,string>={'cache-control':'no-store'};reply.headers.forEach((v,k)=>out[k]=v);response.writeHead(reply.status,out);
      if(reply.body)await pipeline(Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]),response);else response.end();
    }finally{active.delete(server);await server.close();}
  }
  return {handle,store,close:async()=>{if(closed)return;closed=true;await Promise.all([...active].map(s=>s.close()));if(owned)await store.close();}};
}
