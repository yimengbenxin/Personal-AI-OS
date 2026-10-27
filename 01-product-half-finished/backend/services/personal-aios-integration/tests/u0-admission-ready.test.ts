import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RawArchive} from '../src/archive.ts';

const {RunAdmission}=await import(process.env.PAIOS_U0_NATIVE_FIXTURE_TEST_SOURCE??'./native-source-fixture.ts');
test('a native run id becomes visible only after its public session binding is durable',async()=>{
  const path=await mkdtemp(join(tmpdir(),'public-binding-')),storage=new PosixStorage(path);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),publish=storage.publish.bind(storage);
  storage.publish=async(namespace,key,data)=>{
    if(namespace==='admission-hooks'&&JSON.parse(new TextDecoder().decode(data)).kind==='accepted'){
      entered.resolve();await release.promise;
    }
    return publish(namespace,key,data);
  };
  const run={run_id:'run-1',session_id:'compressed-tip',conversation_session_id:'session',status:'running'};
  const native={create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:1048576,max_event_age_ms:60000,
    poll_interval_ms:5,native_idempotency_retention_ms:60000,policy_version:'fixture'});
  try{
    const ingress=new UnifiedIngress(new RawArchive(storage,1048576));
    const d=await ingress.accept({schema_version:'paios.event.v1',event_id:'binding',device_id:'mac',device_type:'mac',
      captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('fixture')},{principal_id:'owner',device_id:'mac',device_type:'mac',
      consent_ref:'fixture',channel:'text',submission:'explicit_text'});
    await admission.admit(d,'session','skill');await entered.promise;
    assert.equal(admission.get('owner','session',d.processed_event_id)?.run_id,undefined);
    release.resolve();
    for(let i=0;i<400&&admission.get('owner','session',d.processed_event_id)?.state!=='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(admission.get('owner','session',d.processed_event_id)?.state,'running');
    assert.equal(admission.get('owner','session',d.processed_event_id)?.run_id,'run-1');
  }finally{release.resolve();await admission.close();await rm(path,{recursive:true,force:true});}
});
