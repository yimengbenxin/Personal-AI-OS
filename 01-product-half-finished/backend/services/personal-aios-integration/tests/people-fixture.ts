import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type test from 'node:test';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {VoiceprintRegistry,type ClusterView} from '../src/voiceprint/registry.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {VisualMemory} from '../src/visual/store.ts';
import {OutputAuthority} from '../src/output.ts';
import {sha256} from '../src/contracts.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {createTSMcpHost} from '../src/capability/ts/host.ts';

export const peopleRows=()=>Array.from({length:127},(_,index)=>({cluster_id:String(index),
  display_name:index<124?null:`fixture-name-${index}`,known_person_id:index<124?null:`fixture-person-${index}`,
  count:5,speech_ms:37858,stale_model:index%3===0,label:`speaker-${index}`,
  created_at:'2026-10-01T00:00:00Z',last_seen:'2026-10-25T09:00:00Z'} satisfies ClusterView));
export async function peopleFixture(t:test.TestContext){
  const folder=await mkdtemp(join(tmpdir(),'people-read-')),storage=new PosixStorage(folder);
  const run={run_id:'people-fixture',session_id:'session',conversation_session_id:'session',status:'running' as const};
  const native:NativeClient={create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:60000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  const registry=new VoiceprintRegistry(storage,{id:'fixture',sha256:'a'.repeat(64),dim:16});
  registry.clusters=async()=>peopleRows();registry.nearbyPeople=async()=>peopleRows();
  const visual=await VisualMemory.open(join(folder,'visual'),{embedImage:async()=>[],embedQuery:async()=>[],describe:async()=>({caption:'fixture',ocr:''})},{},registry);
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,65536),admission,native,
    output:new OutputAuthority(storage),skill:'fixture',max_read_bytes:65536,voiceprint:registry,visual_memory:visual,
    devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'http',consent_ref:'fixture',
      token_sha256:sha256('fixture-token'),route_version:'route',output_modes:['text']}]});
  t.after(async()=>{await runtime.close();await visual.close();await registry.close();await rm(folder,{recursive:true,force:true});});
  const source=await runtime.authenticate('fixture-token');
  const accepted=await runtime.submit({schema_version:'paios.event.v1',event_id:'fixture',device_id:'phone',device_type:'phone',
    captured_at:new Date().toISOString(),source:{channel:'http'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('已知人物和相机策略是什么？')},source,'session',true);
  for(let index=0;index<200;index++){
    if((await admission.getAsync('owner','session',accepted.processed_event.processed_event_id))?.run_id)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const catalog=packageCatalog({enabled:['ts-personal'],gateway:['ts-personal']});
  const host=createTSMcpHost(runtime,()=>catalog,262144);
  let id=0;
  return {runtime,catalog,storage,host,call:(name:string,args:Record<string,unknown>={})=>host.callTool(name,
    {...args,_context:{run_id:run.run_id,session_id:'session',tool_call_id:`fixture-${id++}`}})};
}
