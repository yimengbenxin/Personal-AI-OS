import test from 'node:test';
import assert from 'node:assert/strict';
import {peopleFixture} from './people-fixture.ts';
import {mapResult} from '../../../../../capability/packages/ts-personal/server/index.ts';
import {failure} from '../../../../../capability/packages/ts-host/result.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {ContractError} from '../src/contracts.ts';
const input={name:'paios_visual_capture_policy',args:{},policy:packageCatalog().get('mcp__platform_ts__paios_visual_capture_policy')!,
  now:'2026-10-25T09:00:00Z',result:null};
test('disconnected policy read is a known rejection before execution, not an uncertain effect',async t=>{
  const f=await peopleFixture(t),wire=await f.call('paios_visual_capture_policy');
  assert.equal(wire.structuredContent.status.reason_code,'TERMINAL_NOT_CONNECTED');
  assert.equal(wire.structuredContent.status.state,'failed');
  assert.notEqual(wire.structuredContent.next.retry,'after_check');assert.deepEqual(wire.structuredContent.effects,[]);
});
test('completed policy read with an unknown device error still succeeded; real transport uncertainty remains',()=>{
  const body=mapResult({...input,result:{enabled:false,private_paused:false,interval_ms:30000,
    triggers:['user_request'],camera_statuses:[{device_id:'fixture-glasses',status:'available',error:null}]}});
  assert.equal(body.status.state,'succeeded');assert.notEqual(body.next.retry,'after_check');
  assert.ok(body.unknowns.some(row=>row.about==='camera_statuses'));assert.deepEqual(body.effects,[]);
  for(const error of [new ContractError('TERMINAL_TOOL_TIMEOUT',504),new ContractError('REQUEST_TIMEOUT',408)]){
    const transport=failure(input,error);
    assert.equal(transport.status.state,'unknown');assert.equal(transport.next.retry,'after_check');
  }
  const write=failure({...input,args:{_operation:'update'}},new ContractError('TERMINAL_NOT_CONNECTED',409));
  assert.equal(write.status.state,'unknown');assert.equal(write.next.retry,'after_check');
});
