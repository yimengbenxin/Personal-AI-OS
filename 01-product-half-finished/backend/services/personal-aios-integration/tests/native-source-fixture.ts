// Test seam only. Existing fake native business state supplies raw source responses.
import {HermesClient,NATIVE_RUN_SHAPE_SHA256,type NativeRun,type Reminder} from '../src/hermes-client.ts';
import {RunAdmission as SourceAdmission,type AdmissionPolicy} from '../src/admission.ts';
import {PersonalAIOSRuntime as SourceRuntime} from '../src/runtime.ts';
import type {StoragePort} from '../src/storage.ts';
export * from '../src/hermes-client.ts';
export * from '../src/admission.ts';
export * from '../src/runtime.ts';
export interface NativeClient {
  create(body:Parameters<HermesClient['create']>[0],key:string,signal?:AbortSignal):Promise<NativeRun>;
  status(runId:string):Promise<NativeRun>;
  cancel(runId:string):Promise<NativeRun>;
  reminders?(principal:string,signal?:AbortSignal):Promise<Reminder[]>;
  routeSelfcheckResult?:HermesClient['routeSelfcheckResult'];
  sessions?:HermesClient['sessions'];
  messages?:HermesClient['messages'];
}
const clients=new WeakMap<object,HermesClient>();
const submissions=new WeakMap<HermesClient,Map<string,{input:string;session_id:string}>>();
export function nativeSubmission(native:NativeClient|HermesClient,run:string){
  return submissions.get(sourceClient(native))!.get(run)!;
}
export function sourceClient(native:NativeClient | HermesClient):HermesClient {
  if(native instanceof HermesClient)return native;
  const found=clients.get(native);if(found)return found;
  const submitted=new Map<string,{input:string;session_id:string}>();
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname,body=path==='/v1/runs'?JSON.parse(String(init?.body)):undefined;
    if(path==='/health/detailed')return Response.json({platform:'hermes-agent',readiness:{checks:{session_store:{status:'ok'},model:{status:'ok'}}}});
    if(path==='/v1/paios/selfcheck-result')return Response.json({absorbed:native.routeSelfcheckResult?await native.routeSelfcheckResult(JSON.parse(String(init?.body)).result):false});
    if(path==='/personal-aios/reminders')return Response.json({reminders:native.reminders?await native.reminders(url.searchParams.get('principal_id')!,init?.signal??undefined):[]});
    if(path==='/api/sessions')return Response.json({data:native.sessions?await native.sessions(Number(url.searchParams.get('limit')),init?.signal??undefined):[]});
    if(path.startsWith('/api/sessions/')&&path.endsWith('/messages'))return Response.json({data:native.messages?
      await native.messages(decodeURIComponent(path.split('/')[3]!),Number(url.searchParams.get('limit')),init?.signal??undefined):[]});
    // Test-only event producer observes existing mutable fakes; production owns this stream natively.
    if(path.startsWith('/v1/runs/')&&path.endsWith('/events')){
      const runId=decodeURIComponent(path.split('/')[3]!);let timer:ReturnType<typeof setTimeout>|undefined,closed=false,cancelled=false;
      let observation=Promise.resolve();
      let seq=Number(url.searchParams.get('after_seq')??0),previous='';
      const body=new ReadableStream<Uint8Array>({start(controller){
        const close=()=>{if(closed)return;closed=true;clearTimeout(timer);void observation.then(()=>{if(!cancelled)controller.close();});};
        init?.signal?.addEventListener('abort',close,{once:true});
        const observe=async()=>{
          try {
            const run=await native.status(runId);if(closed)return;
            const current=JSON.stringify(run);
            if(current!==previous){
              const event={event:previous?'run.updated':'run.snapshot',run_id:runId,timestamp:Date.now()/1000,seq:++seq,
                run:{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',...run},activity_events:[]};
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));previous=current;
            }
            if(['completed','failed','cancelled','canceled','interrupted','expired'].includes(run.status)){close();return;}
            timer=setTimeout(()=>{observation=observe();},5);
          }catch(error){if(!closed){closed=true;controller.error(error);}}
        };observation=observe();
      },cancel(){cancelled=true;closed=true;clearTimeout(timer);return observation;}});
      return new Response(body,{headers:{'content-type':'text/event-stream'}});
    }
    const run=path==='/v1/runs' ? await native.create(body,String((init?.headers as Record<string,string>)['Idempotency-Key']),init?.signal ?? undefined) :
      path.endsWith('/stop') ? await native.cancel(decodeURIComponent(path.split('/').at(-2)!)) : await native.status(decodeURIComponent(path.split('/').at(-1)!));
    if(body)submitted.set(run.run_id,{input:body.input,session_id:body.session_id});
    // The patched producer acknowledges a restricted run scope on acceptance (memory writes off).
    const scope=body?.run_scope?{run_scope:body.run_scope}:{};
    // Published source fields are explicit fixtures, not receipts fabricated from model prose.
    return new Response(JSON.stringify({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',...run,...scope,...(body?{granted_toolsets:body.grant_toolsets??[]}: {})}),
      {status:path==='/v1/runs'?202:200,headers:{'content-type':'application/json'}});
  };
  const client=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000000,1048576,undefined,fetcher);
  submissions.set(client,submitted);
  clients.set(native,client);return client;
}
// Constructor seams preserve the original owners, state, delays and fake business counters.
export class RunAdmission extends SourceAdmission {
  constructor(storage:StoragePort,native:NativeClient | HermesClient,policy:AdmissionPolicy){super(storage,sourceClient(native),policy);}
}
export class PersonalAIOSRuntime extends SourceRuntime {
  constructor(options:Omit<ConstructorParameters<typeof SourceRuntime>[0],'native'> & {native:NativeClient | HermesClient}){super({...options,native:sourceClient(options.native)});}
}
