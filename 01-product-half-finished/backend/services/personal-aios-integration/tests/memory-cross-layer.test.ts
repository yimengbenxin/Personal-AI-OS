// Actual retrieval/lifecycle acceptance. This test performs no LLM generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {openFixtureDatabase} from '../src/memory/fixture-database.ts';
import {MemoryToolAuthority} from '../src/memory/tools.ts';
import type {AssertionInput, ForgetReceipt} from '../src/memory/contracts.ts';
import {fileURLToPath} from 'node:url';
const database=process.env.PAIOS_L3_TEST_DATABASE_URL, python=process.env.PAIOS_HERMES_PYTHON;
const nativeSource=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;

test('real L5/L3 correction and scoped native L2/L4 forget retain receipts and clean fresh retrieval',
 {skip:!database||!python||!nativeSource},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'paios-memory-cross-layer-'));
 const schema='paios_fixture_cross_'+randomUUID().replaceAll('-','').slice(0,24);
 const fixture=await openFixtureDatabase({url:database!,schema,
  migration_file:fileURLToPath(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url))});
 t.after(async()=>{try{await fixture.l3.close();await fixture.pool.query('DROP SCHEMA '+schema+' CASCADE');}
  finally{await fixture.close();await rm(directory,{recursive:true,force:true});}});
 const storage=new PosixStorage(join(directory,'central')),archive=new RawArchive(storage,16384);
 const d=await new UnifiedIngress(archive).accept({schema_version:'paios.event.v1',event_id:'cross-owner',
  device_id:'cross-mac',device_type:'mac',captured_at:'2026-10-17T00:00:00.000Z',source:{channel:'text'},
  media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',
  payload:Buffer.from('Remember tea. Correct it to coffee. Then forget this preference.'),
  time_range:{kind:'instant',timebase_id:'utc_unix_ms',at_ms:1}},
  {principal_id:'owner',device_id:'cross-mac',device_type:'mac',consent_ref:'cross-owner-consent',channel:'text',submission:'explicit_text'});
 const tools=new MemoryToolAuthority({l3:fixture.l3,storage,archive,
  lookupProcessed:async(principal,id)=>principal==='owner'&&id===d.processed_event_id?structuredClone(d):undefined});
 const context={principal_id:'owner',run_id:'cross-run',session_id:'memory-cross-layer',tool_call_id:'cross-call',d};
 const evidence={event_id:d.event_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,
  archive_revision:d.archive_revision,time_range:d.time_range};
 const a:AssertionInput={assertion_id:'cross-preference',kind:'preference',subject_ref:{type:'known_person',id:'owner'},
  predicate:'drink',value:'tea',scope:{principal_id:'owner',purpose:'assistance',situation:'daily',role:'owner',evaluation_frame:'preference'},
  evidence_refs:[evidence],evidence_status:'available',unknown_conditions:[],conflicts:[],status:'active',
  applicability_status:'applicable',relation_to_peers:'independent',typed_scores:{},depends_on:[]};
 const create={command_id:'cross-create',operation:'create' as const,expected_version:0,assertion:a,evidence_refs:[evidence]};
 const created=await tools.commit(context,create);assert.equal(created.status,'committed');
 const corrected=await tools.commit(context,{...create,command_id:'cross-correct',operation:'correct',expected_version:1,
  assertion:{...a,value:'coffee'}});
 assert.equal(corrected.status,'committed');if(corrected.status!=='committed')throw Error('expected receipt');
 assert.equal(corrected.version,2);
 const current=await tools.query(context,{assertion_id:a.assertion_id,status:'active'});
 assert.equal(current.assertions[0]?.value,'coffee');assert.equal(current.assertions[0]?.previous_version,1);
 assert.equal(current.assertions[0]?.effective_at,corrected.committed_at);
 const marker=String(current.assertions[0]!.value),assertionRef='assertion:'+a.assertion_id,home=join(directory,'native');
 await mkdir(home);
 const harness=fileURLToPath(new URL('../../../../../tests/hermes/memory_cross_layer_fixture.py',import.meta.url));
 function native(phase:string,receipt?:ForgetReceipt){
  const child=spawnSync(python!,[harness,phase,home,marker,assertionRef,String(a.value)],{encoding:'utf8',timeout:60000,
   env:{...process.env,PAIOS_NATIVE_SOURCE_TEST_ROOT:nativeSource!,PYTHONPATH:nativeSource!,PYTHONDONTWRITEBYTECODE:'1'},input:receipt?JSON.stringify(receipt):undefined});
  assert.equal(child.status,0,child.stderr||String(child.error));
  return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
 }
 assert.equal(native('seed').assertion_ref,assertionRef);
 const erased=await tools.forget(context,{command_id:'cross-forget',assertion_id:a.assertion_id,expected_version:2,
  scope:'l3_live_payloads_all_versions',retention:'audit_metadata'});
 assert.equal(erased.erased_versions,2);assert.equal(erased.residual.l2,'not_run');
 const nativeResult=native('purge',erased);
 assert.equal(nativeResult.receipt.l3_receipt_ref,erased.receipt_ref);
 assert.equal(nativeResult.fresh_prompt_absent,true);assert.equal(nativeResult.search_empty,true);
 assert.equal(nativeResult.receipt.strict_forget_complete,false);
 assert.equal((await tools.inspect(context,{assertion_id:a.assertion_id})).status,'erased');
 assert.deepEqual((await tools.query(context,{assertion_id:a.assertion_id})).assertions,[]);
 assert.deepEqual(await tools.commit(context,create),created);
 assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM paios_l3_payloads')).rows[0].n,0);
});
