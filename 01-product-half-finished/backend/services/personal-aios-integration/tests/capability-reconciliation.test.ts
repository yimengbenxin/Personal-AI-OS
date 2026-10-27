import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityGateway,type GatewayCall} from '../src/capability/gateway.ts';
import {packageCatalog} from '../src/capability/packages.ts';
import {PosixStorage} from '../src/storage.ts';
import {digest} from '../src/contracts.ts';
import {receipt,effect,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';

const binding={principal_id:'owner',run_id:'run',scope:'owner',invocation:'interactive' as const};
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'reconcile-')),storage=new PosixStorage(root);
  t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
  const gateway=new CapabilityGateway(storage,async()=>({action:'allow'}),packageCatalog({enabled:['wechat-mac','mijia'],gateway:['wechat-mac','mijia']}));
  let sequence=0;
  const call=(name:string,args:Record<string,unknown>):GatewayCall=>({tool_name:[...gateway.tools].find(([,tool])=>tool.name===name)![0],
    args,task_id:'child',tool_call_id:`call-${++sequence}`,api_request_id:'run',session_id:'session',turn_id:'turn'});
  return {gateway,call};
}
for(const name of ['wechat_send_text','control_device','run_scene'])test(`${name} checks correlate operation, package and every affected target`,async t=>{
  const {gateway,call}=await fixture(t),wechat=name.startsWith('wechat');
  const args=wechat?{command:'fixture',recipient:'wechat:fixture'}:name==='run_scene'?{name:'fixture',steps:[]}:{device:'lamp',service:'light',property:'on',value:true};
  const original=call(name,args),id=digest([binding.principal_id,binding.run_id,original.task_id,original.tool_call_id]);
  const targets=wechat?['wechat:fixture']:name==='run_scene'?['mijia:1','mijia:2']:['mijia:1'];
  await gateway.receipt(binding,{...original,result:to_mcp_result(receipt('unknown',{
    effects:targets.map(target=>effect(wechat?'send':'physical',target,'fixture','unknown','',id)),
    next:{retry:'after_check',check_with:wechat?'wechat_read_recent':'read_device'}}))});
  const retry=()=>gateway.decide(binding,call(name,args));assert.equal((await retry()).action,'block');
  const checkName=wechat?'wechat_read_recent':'read_device';
  const check=async(target:string,ref=id,state:'succeeded'|'unknown'='succeeded')=>gateway.receipt(binding,{
    ...call(checkName,{...(wechat?{recipient:target}:{device:target}),check_for:id}),
    result:to_mcp_result(receipt(state,{effects:[effect('observe',target,'read','verified','fixture read',ref)]}))});
  await check(targets[0]!,'foreign');assert.equal((await retry()).action,'block');
  await check('unrelated');assert.equal((await retry()).action,'block');
  await check(targets[0]!,id,'unknown');assert.equal((await retry()).action,'block');
  // A successful unrelated package/tool with the same opaque id is not a check proof.
  await gateway.receipt(binding,{...call(wechat?'read_device':'wechat_read_recent',{check_for:id}),
    result:to_mcp_result(receipt('succeeded',{effects:targets.map(target=>effect('observe',target,'read','verified','fixture',id))}))});
  assert.equal((await retry()).action,'block');
  for(let i=0;i<targets.length;i++){
    await check(targets[i]!);assert.equal((await retry()).action,i===targets.length-1?'allow':'block');
  }
  // A new uncertain attempt needs its own later check, rather than inheriting the first attempt's proof.
  const again=call(name,args),nextId=digest([binding.principal_id,binding.run_id,again.task_id,again.tool_call_id]);
  await gateway.receipt(binding,{...again,result:to_mcp_result(receipt('unknown',{
    effects:targets.map(target=>effect(wechat?'send':'physical',target,'fixture','unknown','',nextId)),
    next:{retry:'after_check',check_with:checkName}}))});
  assert.equal((await retry()).action,'block');
});
