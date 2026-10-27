import assert from 'node:assert/strict';
import test from 'node:test';
import {reportPersistentExecutionError} from '../src/rayneo-persistent-production-entrypoint.ts';
import {AudioConsumptionUnknownError} from '../../../services/personal-aios-integration/src/media/audio-consumption.ts';
import {CallTurnBackpressureError} from '../src/call-turn-manager.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeEventStore,installRuntimeEventStore} from '../../../services/personal-aios-integration/src/self-events.ts';

test('a throwing frame survives timestamp normalization and persistent event storage',async t=>{
  const root=await mkdtemp(join(tmpdir(),'execution-error-')),store=new RuntimeEventStore({directory:root}),detach=installRuntimeEventStore(store);
  t.after(async()=>{detach();await store.close();await rm(root,{recursive:true,force:true});});
  const lines:string[]=[];t.mock.method(process.stderr,'write',(value:string)=>{lines.push(value);return true;});
  reportPersistentExecutionError(new TypeError('fetch failed'));
  const wire=JSON.parse(lines[0]!);assert.equal(wire.at,undefined);assert.ok(wire.frames.length>0);
  const rows=await store.read();assert.equal(typeof rows[0]?.at,'number');assert.deepEqual(rows[0]?.frames,wire.frames);
});

test('production reporting preserves each known call turn budget reason',t=>{
  const lines:string[]=[];
  t.mock.method(process.stderr,'write',(value:string)=>{lines.push(value);return true;});
  const reasons=['identity_jobs','turn_samples','candidates','retained_bytes','prefix_samples','commit_jobs'] as const;
  for(const reason of reasons)reportPersistentExecutionError(new CallTurnBackpressureError(reason));
  assert.deepEqual(lines.map(line=>JSON.parse(line)),reasons.map(reason=>({central_text_failed:`VOICE_CALL_TURN_BACKPRESSURE_${reason.toUpperCase()}`})));
});

test('production reporting separates lane transitions and prints only safe unknown cause codes',t=>{
  const lines:string[]=[];
  t.mock.method(process.stderr,'write',(value:string)=>{lines.push(value);return true;});
  for(const state of ['rejected','recovered'])reportPersistentExecutionError(Object.assign(new Error('private transcript'),{
    code:state==='rejected'?'CONTINUOUS_STREAM_BACKLOG':'CONTINUOUS_ADMISSION_RECOVERED',continuous_pcm_admission:state,stream_key:'a'.repeat(64)}));
  reportPersistentExecutionError(new AudioConsumptionUnknownError('private-ref',[
    new Error('VOICE_WINDOW_TIMEOUT'),Object.assign(new Error('secret credential'),{code:'EIO'}),new Error('private transcript')]));
  reportPersistentExecutionError(Object.assign(new Error('private transcript'),{code:'AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN',
    continuous_pcm_admission:'rejected',cause:new AudioConsumptionUnknownError('private-ref',[new Error('VOICE_WINDOW_CANCELLED')])}));
  reportPersistentExecutionError(new Error('CALL_ARCHIVE_UNAVAILABLE',{cause:Object.assign(new Error('secret path'),{code:'EIO'})}));
  reportPersistentExecutionError(new Error('private transcript\nsecond private line'));
  assert.ok(lines.every(line=>line.endsWith('\n')&&!line.includes('\\n')));
  const records=lines.map(line=>JSON.parse(line));
  assert.deepEqual(records.slice(0,2).map(record=>record.continuous_pcm_admission),['rejected','recovered']);
  assert.ok(records.slice(0,2).every(record=>record.central_text_failed===undefined));
  assert.equal(records[2].central_text_failed,'AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN');
  assert.deepEqual(records[2].cause_codes,['VOICE_WINDOW_TIMEOUT','EIO']);
  assert.deepEqual(records[3].cause_codes,['VOICE_WINDOW_CANCELLED']);
  assert.deepEqual(records[4],{central_text_failed:'CALL_ARCHIVE_UNAVAILABLE',cause_codes:['EIO']});
  assert.equal(records[5].central_text_failed,'Error');
  assert.ok(records[5].frames.length>0&&records[5].frames.every((frame:string)=>frame.length<=160&&!frame.includes('/Users/')&&!frame.includes('/opt/')));
  assert.match(records[5].frames[0],/persistent-execution-error-report\.test\.ts:\d+:\d+/);
  assert.doesNotMatch(lines.join(''),/private|secret|transcript/);
});
