import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CapabilityGateway,type GatewayCall} from '../src/capability/gateway.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {PosixStorage} from '../src/storage.ts';
import {receipt,succeeded,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
const binding={principal_id:'owner',run_id:'fixture',scope:'owner',invocation:'interactive' as const};
async function fixture(t:test.TestContext){
  const folder=await mkdtemp(join(tmpdir(),'read-retry-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const gateway=new CapabilityGateway(new PosixStorage(folder),async()=>({action:'allow'}),
    packageCatalog({enabled:['ts-personal','owner-mac'],gateway:['ts-personal','owner-mac']}));
  let index=0;
  const call=(tool_name:string,args:Record<string,unknown>):GatewayCall=>({tool_name,args,task_id:'child',
    tool_call_id:`call-${index++}`,session_id:'session',api_request_id:'fixture',turn_id:'turn'});
  return {gateway,call};
}
test('observe after_check re-read is the check, for fixed and resolved argument effects',async t=>{
  const {gateway,call}=await fixture(t);
  for(const [name,args]of [['mcp__owner_mac__read',{path:'/fixture/a'}],
    ['mcp__platform_ts__paios_visual_capture_policy',{_operation:'read'}]] as const){
    for(const state of ['unknown','partial'] as const){
      const input=call(name,args);
      await gateway.receipt(binding,{...input,result:to_mcp_result(receipt(state,{next:{retry:'after_check',check_with:name.split('__').at(-1)}}))});
      assert.equal((await gateway.decide(binding,call(name,args))).action,'allow');
    }
  }
});
test('non-observe after_check stays blocked until its matching check succeeds',async t=>{
  const {gateway,call}=await fixture(t),args={path:'/fixture/a',content:'data'};
  await gateway.receipt(binding,{...call('mcp__owner_mac__write',args),
    result:to_mcp_result(receipt('unknown',{next:{retry:'after_check',check_with:'read'}}))});
  const retry=()=>gateway.decide(binding,call('mcp__owner_mac__write',args));
  assert.equal((await retry()).action,'block');
  for(const [path,state]of [['/fixture/b','succeeded'],['/fixture/a','unknown'],['/fixture/a','succeeded']] as const){
    await gateway.receipt(binding,{...call('mcp__owner_mac__read',{path}),result:to_mcp_result(state==='succeeded'?succeeded():receipt(state))});
    assert.equal((await retry()).action,state==='succeeded'&&path==='/fixture/a'?'allow':'block');
  }
});
test('failed after_check still requires a matching check; failed allowed and observe can retry',async t=>{
  const {gateway,call}=await fixture(t),args={path:'/fixture/failed',content:'data'};
  await gateway.receipt(binding,{...call('mcp__owner_mac__write',args),
    result:to_mcp_result(receipt('failed',{next:{retry:'after_check',check_with:'read'}}))});
  const retry=()=>gateway.decide(binding,call('mcp__owner_mac__write',args));
  assert.equal((await retry()).action,'block');
  await gateway.receipt(binding,{...call('mcp__owner_mac__read',{path:args.path}),result:to_mcp_result(succeeded())});
  assert.equal((await retry()).action,'allow');
  const safe={path:'/fixture/not-started',content:'data'};
  await gateway.receipt(binding,{...call('mcp__owner_mac__write',safe),
    result:to_mcp_result(receipt('failed',{next:{retry:'allowed'}}))});
  assert.equal((await gateway.decide(binding,call('mcp__owner_mac__write',safe))).action,'allow');
  const read=call('mcp__owner_mac__read',{path:'/fixture/read'});
  await gateway.receipt(binding,{...read,result:to_mcp_result(receipt('failed',{next:{retry:'after_check',check_with:'read'}}))});
  assert.equal((await gateway.decide(binding,call(read.tool_name,read.args))).action,'allow');
});
