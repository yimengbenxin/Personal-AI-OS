import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { EVENT_SCHEMA, sha256 } from '../src/contracts.ts';
import { readonlyRuntime,policy } from './sealed-replay-check.ts';
import {fileURLToPath} from 'node:url';
const now='2026-10-01T00:00:00.000Z';
const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('fixture-token')},
  {principal_id:'owner',device_id:'other',device_type:'mac' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('other-token')}];
async function snapshot(root:string):Promise<Record<string,string>> {
  const found:Record<string,string>={};for(const item of await fs.readdir(root,{recursive:true,withFileTypes:true}))if(item.isFile()){
    const path=join(item.parentPath,item.name),stat=await fs.stat(path);found[path]=sha256(await fs.readFile(path))+':'+stat.mtimeMs;}return found;
}
test('actual POSIX sealed replay survives partial/full/lost ACK and fresh runtime/process with zero native/write/refresh/TTS calls',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-sealed-replay-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);let creates=0,observed!:()=>void;const firstStatus=new Promise<void>(done=>{observed=done;});
  const run={run_id:'one-run',session_id:'session',conversation_session_id:'session',status:'running',output:'🔬中文'.repeat(40)};
  const native={create:async()=>{creates++;return {...run};},status:async()=>{observed();return {...run};},cancel:async()=>({...run,status:'cancelled'})};
  const out=new OutputAuthority(storage,{chunkChars:12,listRunReceipts:async()=>({sources:[]})});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,output:out,devices,skill:'fixed',max_read_bytes:8192});
  t.after(()=>runtime.close());const source=await runtime.authenticate('fixture-token');
  const {processed_event:d}=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'original',device_id:'mac',device_type:'mac',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('original')},source,'session',true);await firstStatus;
  await assert.rejects(runtime.result(source,'session',d.processed_event_id,{text_replay:'sealed'}),/SEALED_TEXT_NOT_AVAILABLE/);
  await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'reply'},args:{reply_mode:'text'}});
  await assert.rejects(runtime.result(source,'session',d.processed_event_id),/OUTPUT_NATIVE_NOT_TERMINAL/);
  await assert.rejects(runtime.result(source,'session',d.processed_event_id,{text_replay:'sealed'}),/SEALED_TEXT_NOT_AVAILABLE/);
  run.status='completed';const pending=await runtime.result(source,'session',d.processed_event_id);const chunks=pending.chunks;
  assert.ok(chunks.length>3);assert.equal(pending.rendered_text_through_seq,0);assert.equal(pending.text_chunk_count,chunks.length);
  const first=chunks[0]!,ack={output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:first.target_device_id,
    route_version:first.route_version,highest_contiguous_seq:2,status:'rendered' as const,observed_at:now};
  await runtime.acknowledge(source,'session',d.processed_event_id,ack); // The consumer loses this returned receipt.
  const partialPending=await runtime.result(source,'session',d.processed_event_id);assert.equal(partialPending.chunks[0]!.seq,3);
  await runtime.close();
  const config=join(root,'replay-config.json');await fs.writeFile(config,JSON.stringify({devices,session:'session',d:d.processed_event_id}));
  async function readFresh(watermark:number) {
    const before=await snapshot(root),fresh=readonlyRuntime(root,devices),handle=await fresh.runtime.authenticate('fixture-token');
    try {
    const replay=await fresh.runtime.result(handle,'session',d.processed_event_id,{text_replay:'sealed'});
    assert.deepEqual(replay.chunks,chunks);assert.equal(replay.rendered_text_through_seq,watermark);assert.equal(replay.pending_text_chunk_count,chunks.length-watermark);
    await assert.rejects(fresh.runtime.result(await fresh.runtime.authenticate('other-token'),'session',d.processed_event_id,{text_replay:'sealed'}),{code:'OUTPUT_RECIPIENT_SCOPE_DENIED',status:403});
    } finally {await fresh.runtime.close();}
    assert.deepEqual(fresh.calls,{native:0,writes:0,receipts:0,tts:0});
    const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./sealed-replay-check.ts',import.meta.url)),root,config]);
    const child=JSON.parse(stdout);assert.deepEqual(child.result.chunks,chunks);assert.equal(child.result.rendered_text_through_seq,watermark);
    assert.deepEqual(child.calls,{native:0,writes:0,receipts:0,tts:0});assert.deepEqual(await snapshot(root),before);
    if(process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT){const path=process.env.PAIOS_FORMAL_ENVELOPE_FIXTURE_OUT,fixture=JSON.parse(await fs.readFile(path,'utf8'));
      fixture.source_restart_evidence??={evidence:'independent real POSIX runtime + fresh Node process test; separate small-chunk D from main wire fixture',checkpoints:[]};
      fixture.source_restart_evidence.checkpoints.push({rendered_text_through_seq:watermark,text_chunk_count:chunks.length,lost_ack:watermark===2,fresh_runtime_calls:fresh.calls,fresh_process_calls:child.calls,all_original_chunks_equal:true,all_file_hash_and_mtime_unchanged:true});
      await fs.writeFile(path,JSON.stringify(fixture,null,2)+'\n');}
  }
  await readFresh(2);
  // Durable OUT owns the watermark; inspection never resets it or invokes the native run.
  const ctx={principal_id:d.principal_id,run_id:run.run_id,session_id:'session',tool_call_id:'final-buffer',d,target:{device_id:'mac',device_type:'mac' as const,route_version:'route',output_modes:['text']}};
  await out.ack(ctx,{...ack,highest_contiguous_seq:chunks.length});await readFresh(chunks.length);assert.equal(creates,1);
  await out.cancel(ctx,first.reply_epoch);await assert.rejects(out.readSealedText(ctx),/SEALED_TEXT_OLD_EPOCH/);
});
test('readonly result rejects persisted D before native acceptance without scheduling or writing',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-unaccepted-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let release!:(value:any)=>void;const held=new Promise<any>(done=>{release=done;});
  const storage=new PosixStorage(root),native={create:async()=>held,status:async()=>({run_id:'held',session_id:'session',conversation_session_id:'session',status:'completed'}),cancel:async()=>({run_id:'held',session_id:'session',conversation_session_id:'session',status:'cancelled'})};
  const producer=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,output:new OutputAuthority(storage),devices,skill:'fixed',max_read_bytes:8192});
  const source=await producer.authenticate('fixture-token'),{processed_event:d}=await producer.submit({schema_version:EVENT_SCHEMA,event_id:'held',device_id:'mac',device_type:'mac',captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('held')},source,'session',true);
  const fresh=readonlyRuntime(root,devices);await assert.rejects(fresh.runtime.result(await fresh.runtime.authenticate('fixture-token'),'session',d.processed_event_id,{text_replay:'sealed'}),/RUN_NOT_ACCEPTED/);
  assert.deepEqual(fresh.calls,{native:0,writes:0,receipts:0,tts:0});await fresh.runtime.close();release({run_id:'held',session_id:'session',conversation_session_id:'session',status:'completed'});await producer.close();
});
