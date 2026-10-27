import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import {ActivityProjection,type ActivitySaved,type ActivityUpdate} from '../src/activity.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {activityTitle} from '../src/activity-title.ts';
import {receipt} from '../../../../../capability/sdk/ts/receipt.ts';

const contracts=new URL('../../../../../integrations/contracts/',import.meta.url);
const schema=JSON.parse(readFileSync(new URL('formal-message.v1.json',contracts),'utf8'));
const validate=new Ajv({strict:false,validateFormats:false}).compile({$defs:schema.$defs,...schema.outputs.activity_update});
const base=Date.parse('2026-10-19T16:28:00.000Z');
function harness(saved?:ActivitySaved){
  let clock=base;const packets:ActivityUpdate[]=[];
  const projection=new ActivityProjection('owner','session-test','processed-test',packet=>{
    assert.ok(validate(packet),JSON.stringify(validate.errors));packets.push(packet);
  },()=>clock,saved);
  return {projection,packets,at:(ms:number)=>{clock=base+ms;},now:()=>clock,latest:()=>projection.snapshot()!.packet.card};
}
async function sse(h:ReturnType<typeof harness>,events:Record<string,unknown>[]){
  const frames=events.map(event=>`data: ${JSON.stringify({run_id:'run-test',timestamp:h.now()/1000,tool_call_id:'tool-test',...event})}\r\n\r\n`).join('');
  const bytes=new TextEncoder().encode(frames);
  const fetcher=(async()=>new Response(new ReadableStream({start(controller){
    // Split inside frames and UTF-8 text to exercise the native stream decoder.
    for(let start=0;start<bytes.length;start+=31)controller.enqueue(bytes.slice(start,start+31));controller.close();
  }}),{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  const client=new HermesClient('http://127.0.0.1:1','synthetic-test-auth-value',10000,65536,undefined,fetcher);
  await client.events('run-test',event=>h.projection.event(event));
}
const start=(id:string)=>({event:'subagent.start',subagent_id:id,goal:`处理第 ${id} 件事`});
const done=(id:string,status='completed')=>({event:'subagent.complete',subagent_id:id,status,
  ...(status==='completed'?{exit_reason:'completed',outcome:'succeeded' as const,outcome_reason:''}:{})});
const progress={job_id:'job-test',title:'打开云手机',app:'phone',state:'running' as const,
  started_at:new Date(base).toISOString(),step:1,max_steps:10};
const result=(success:boolean,terminal_reason:'completed'|'timed_out'='completed')=>({principal_id:'owner',
  job_id:'job-test',task:'synthetic',success,answer:'private raw answer',finished_at:new Date(base+60000).toISOString(),terminal_reason});

test('receipt-derived states satisfy the existing card and item wire requirements',()=>{
  for(const state of ['succeeded','failed','partial','unknown','waiting','accepted'] as const){
    const h=harness();
    h.projection.event({run_id:'run-test',event:'subagent.start',subagent_id:'child',goal:'处理事情',timestamp:base/1000});
    h.projection.receipts([{id:'record',task_id:'child',tool_call_id:'call',tool:'opaque',invocation:'opaque',fingerprint:'opaque',receipt:receipt(state)}]);
    const expected=state==='accepted'?'running':state;
    assert.equal(h.latest().state,expected);assert.equal(h.latest().items[0]!.state,expected);
    h.projection.event({run_id:'run-test',event:'subagent.complete',subagent_id:'child',status:'failed',timestamp:(base+1000)/1000});
    assert.equal(h.latest().items[0]!.state,expected);h.projection.close();
  }
});

test('an owner payment check remains a visible waiting card after the reporting run completes',()=>{
  const h=harness();
  h.projection.event({run_id:'run-test',event:'subagent.start',subagent_id:'child',goal:'核对执行结果',timestamp:base/1000});
  h.projection.receipts([{id:'owner-check',task_id:'child',tool_call_id:'call',tool:'opaque',invocation:'opaque',fingerprint:'opaque',
    receipt:receipt('waiting',{status:{reason_code:'PAYMENT_LINEAGE_OWNER_CHECK_REQUIRED'},
      unknowns:[{about:'payment_state',why:'隔离记录可能含付款，缺少可信来源'}],
      next:{retry:'after_check',check_with:'phone_status',waiting_on:'owner'},job:{id:'job-0123456789ab',revision:1}})}]);
  h.projection.settle('completed');
  const card=h.latest();assert.equal(card.state,'waiting');assert.equal(card.items[0]!.state,'waiting');
  assert.equal(card.completed_at,undefined);assert.match(card.summary,/主人/u);assert.equal(card.failure_reason,undefined);
  h.projection.close();
});

test('delegated short title is preserved and a derived title ends at a word boundary with an ellipsis',async()=>{
  const h=harness(),title='计算 Excel 并通过微信发送';
  await sse(h,[{...start('titled'),goal:title}]);
  assert.equal(h.latest().items[0]!.summary,title);
  await sse(h,[{...start('derived'),goal:'核对 Excel 报表、保存结果并发送给联系人，最后检查 internationalization 的计算结果和文件内容'}]);
  const derived=h.latest().items[1]!.summary;
  assert.ok(derived.endsWith('…'),derived);
  assert.ok([...derived].length<=48);
  assert.ok(!/internation[^…]*…$/u.test(derived),derived);
  h.projection.close();
});

test('bounded titles keep exact-fit text and whole Chinese or English words',()=>{
  assert.equal(activityTitle('核对报表并发送',7),'核对报表并发送');
  assert.equal(activityTitle('核对报表并发送结果',8),'核对报表并发送…');
  assert.equal(activityTitle('Review the spreadsheet calculations and deliver the verified output',32),'Review the spreadsheet…');
  assert.equal(activityTitle('准备数据，核对报表，发送结果',10),'准备数据，核对报表…');
  // An unbroken first word longer than the budget keeps a visible prefix instead of a lone ellipsis.
  const identifier='run_0123456789abcdef0123456789abcdef0123456789abcdef_0123';
  assert.equal([...identifier].length,57);
  assert.equal(activityTitle(identifier+' failed'),'run_0123456789abcdef0123456789abcdef0123456789a…');
  assert.equal([...activityTitle(identifier+' failed')].length,48);
  assert.equal(activityTitle('x'.repeat(60),10),'xxxxxxxxx…');
  // Unicode: astral letters count once each, and a combining accent stays with its letter.
  assert.equal(activityTitle('𝒜'.repeat(60),10),'𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜𝒜…');
  assert.equal(activityTitle('e\u0301'.repeat(30),10),'e\u0301e\u0301e\u0301e\u0301…');
});

test('a child business outcome remains partial with its reason through SSE, settlement and recovery',async()=>{
  const h=harness();await sse(h,[{...start('excel'),goal:'计算 Excel 并通过微信发送'}]);
  h.at(61000);await sse(h,[{...done('excel'),exit_reason:'completed',outcome:'partial',outcome_reason:'Excel 已完成；微信发送已停止'}]);
  h.projection.settle('completed');
  const card=h.latest();assert.equal(card.state,'partial');assert.equal(card.items[0]!.state,'partial');
  assert.equal(card.failure_reason,'Excel 已完成；微信发送已停止');
  assert.equal(card.items[0]!.failure_reason,card.failure_reason);assert.equal(card.items[0]!.elapsed_ms,61000);
  assert.equal(card.counts.succeeded,0);assert.equal(card.counts.partial,1);
  const restored=harness(h.projection.snapshot());assert.deepEqual(restored.latest(),card);
  h.projection.close();restored.projection.close();
});

test('an exhausted child with returned text is not a completed task',async()=>{
  const h=harness();await sse(h,[start('limited')]);
  await sse(h,[{...done('limited'),exit_reason:'max_iterations',outcome:'partial',outcome_reason:'达到工具调用上限，任务未完成'}]);
  h.projection.settle('completed');assert.equal(h.latest().state,'partial');assert.equal(h.latest().counts.succeeded,0);
  h.projection.close();
});

test('a legacy completed child without a business outcome remains unverified',async()=>{
  const h=harness();await sse(h,[start('legacy')]);
  await sse(h,[{event:'subagent.complete',subagent_id:'legacy',status:'completed',exit_reason:'completed'}]);
  h.projection.settle('completed');assert.equal(h.latest().state,'partial');
  assert.equal(h.latest().items[0]!.failure_reason,'子任务已结束，完成情况待核对');
  assert.equal(h.latest().counts.succeeded,0);h.projection.close();
});

test('an errand terminal receipt keeps its supplied title and cannot become running progress',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'}]);
  h.projection.errand({...result(true),title:'核对报表并发送'});h.projection.settle('completed');
  assert.equal(h.latest().state,'succeeded');assert.equal(h.latest().items[0]!.summary,'核对报表并发送');
  assert.equal(h.latest().items[0]!.state,'succeeded');h.projection.close();
});

test('a verified dispatch stage finishes while its errand still owns the business terminal state',async()=>{
  const h=harness();await sse(h,[{...start('dispatch'),goal:'发起手机报价查询'}]);h.projection.errand(progress);
  await sse(h,[done('dispatch')]);h.projection.settle('completed');
  assert.equal(h.latest().state,'running');assert.equal(h.latest().counts.running,1);
  h.at(60000);h.projection.errand(result(true));
  assert.equal(h.latest().state,'succeeded');assert.equal(h.latest().counts.succeeded,2);h.projection.close();
});

test('executor partial findings retain a partial card while cancellation keeps its terminal authority',async()=>{
  for(const cancelled of [false,true]){
    const h=harness();await sse(h,[{event:'tool.started'}]);h.projection.errand(progress);
    h.at(60000);h.projection.errand({...result(false,'timed_out'),
      terminal_reason:cancelled?'cancelled_by_user':'timed_out',
      partial_findings:{verified:['private observed content'],not_verified:['private missing requirement'],last_screen_text:'private screen',truncated:false}});
    h.projection.settle('completed');
    const card=h.latest();assert.equal(card.state,cancelled?'cancelled':'partial');
    assert.equal(card.items[0]!.state,card.state);assert.equal(card.counts.succeeded,0);
    if(!cancelled){assert.equal(card.counts.partial,1);assert.equal(card.failure_reason,'超时，结果未知');}
    assert.ok(!JSON.stringify(card).includes('private'));h.projection.close();
  }
});

test('canonical activity fixtures and emitted snapshots share the wire contract',()=>{
  const fixtures=JSON.parse(readFileSync(new URL('activity-update.fixtures.json',contracts),'utf8')).fixtures;
  assert.ok(Object.keys(fixtures).length>=6);
  for(const [name,packet] of Object.entries(fixtures))assert.ok(validate(packet),`${name}: ${JSON.stringify(validate.errors)}`);
  for(const relative of [
    '../01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Tests/Fixtures/activity-update.fixtures.json',
    '../01-product-half-finished/glasses-android/app/src/test/resources/activity-update.fixtures.json'])
    assert.deepEqual(readFileSync(new URL('activity-update.fixtures.json',contracts)),readFileSync(new URL(relative,new URL('../',contracts))));
});

test('long tool keeps the latest first-line public intent, then settles',async()=>{
  const h=harness();
  await sse(h,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'正在检查资料\n这行不显示',name:'private_tool'}]);
  assert.equal(h.packets.length,1);assert.equal(h.latest().summary,'正在检查资料');
  h.at(45000);await sse(h,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'正在整理核验结果'},{event:'tool.completed'}]);
  assert.equal(h.latest().state,'running');assert.equal(h.latest().elapsed_ms,45000);
  h.projection.settle('completed');assert.equal(h.packets.at(-1)!.card.state,'succeeded');
  assert.equal(h.packets.at(-1)!.card.summary,'正在整理核验结果');h.projection.close();
});

test('six delegates keep two early successes while the other four run; mixed results are partial',async()=>{
  const h=harness();await sse(h,Array.from({length:6},(_,i)=>start(String(i))));
  h.at(6000);await sse(h,[done('0'),done('1')]);
  assert.deepEqual(h.latest().counts,{total:6,running:4,succeeded:2,failed:0,cancelled:0});
  assert.equal(h.latest().summary,'6 件事一起办');
  h.at(30000);await sse(h,[done('2'),done('3'),done('4'),done('5','failed')]);h.projection.settle('completed');
  assert.equal(h.latest().state,'partial');assert.equal(h.latest().counts.failed,1);
  assert.ok(h.latest().failure_reason);assert.equal(h.latest().items[0]!.elapsed_ms,6000);h.projection.close();
});

test('errand outlives final run and timeout gives the safe Chinese reason',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'}]);h.projection.errand(progress);
  h.at(1000);h.projection.settle('completed');assert.equal(h.latest().state,'running');
  assert.equal(h.latest().completed_at,undefined);
  h.at(60000);h.projection.errand(result(false,'timed_out'));
  const card=h.packets.at(-1)!.card;assert.equal(card.state,'failed');
  assert.equal(card.failure_reason,'超时，结果未知');assert.equal(card.items[0]!.failure_reason,'超时，结果未知');
  assert.equal(card.elapsed_ms,60000);h.projection.close();
});

test('plain reply without any tool or delegate creates no card',async()=>{
  const h=harness();await sse(h,[{event:'message.interim',text:'你好'},{event:'run.completed'}]);
  h.projection.settle('completed');h.projection.close();assert.equal(h.projection.snapshot(),undefined);assert.deepEqual(h.packets,[]);
});

test('a recovered tool error does not override successful authoritative run settlement',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'},{event:'tool.completed',error:true},
    {event:'tool.started'},{event:'tool.completed',error:false}]);h.projection.settle('completed');
  assert.equal(h.latest().state,'succeeded');assert.equal(h.latest().failure_reason,undefined);h.projection.close();
});

test('successful delegated items determine card success even when parent run fails',async()=>{
  const h=harness();await sse(h,[start('1'),start('2'),done('1'),done('2')]);h.projection.settle('failed');
  assert.equal(h.latest().state,'succeeded');assert.equal(h.latest().counts.succeeded,2);h.projection.close();
});

test('more than eight items retains complete counts and reports omitted items',async()=>{
  const h=harness();await sse(h,Array.from({length:11},(_,i)=>start(String(i))));
  assert.equal(h.latest().items.length,8);assert.equal(h.latest().omitted_items,3);assert.equal(h.latest().counts.total,11);
  await sse(h,Array.from({length:11},(_,i)=>done(String(i))));h.projection.settle('completed');
  assert.equal(h.latest().state,'succeeded');assert.equal(h.latest().counts.succeeded,11);h.projection.close();
});

test('saved snapshot preserves stable identity and increasing revisions after a simulated restart',async()=>{
  const first=harness();await sse(first,[start('1')]);first.at(5000);
  await sse(first,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'正在检查资料'}]);first.projection.close();
  const saved=first.projection.snapshot()!,before=structuredClone(saved);
  const resumed=harness(structuredClone(saved));resumed.at(1000);await sse(resumed,[done('1')]);resumed.projection.settle('completed');
  const after=resumed.latest();assert.equal(after.id,before.packet.card.id);
  assert.equal(after.items[0]!.id,before.items[0]!.id);assert.ok(after.revision>before.packet.card.revision);
  assert.equal(after.state,'succeeded');resumed.projection.close();
});

test('terminal card elapsed time and completion instant stay frozen on repeated settlement',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'}]);h.at(2000);h.projection.settle('completed');
  const terminal=structuredClone(h.latest());h.at(9000);h.projection.settle('completed');
  assert.equal(h.latest().elapsed_ms,terminal.elapsed_ms);assert.equal(h.latest().completed_at,terminal.completed_at);h.projection.close();
});

test('running updates publish at most twice per second, coalesce latest intent, and publish terminal immediately',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness();await sse(h,[{event:'tool.started'}]);
  h.at(100);await sse(h,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'正在核验第一项'}]);
  h.at(200);await sse(h,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'正在核验最新一项'}]);
  assert.equal(h.packets.length,1);h.at(499);t.mock.timers.tick(399);assert.equal(h.packets.length,1);
  h.at(500);t.mock.timers.tick(1);assert.equal(h.packets.length,2);assert.equal(h.packets[1]!.card.summary,'正在核验最新一项');
  h.at(600);await sse(h,[{event:'tool.started',tool_call_id:'tool-test',public_intent:'已经核验完成'}]);assert.equal(h.packets.length,2);
  h.projection.settle('completed');assert.equal(h.packets.length,3);assert.equal(h.packets[2]!.card.state,'succeeded');
  t.mock.timers.tick(1000);assert.equal(h.packets.length,3);h.projection.close();
});

test('tool arguments previews results and unsafe public text never reach activity wire',async()=>{
  const h=harness(),secrets=['sk-syntheticSecret123456','https://private.example/secret','/Users/private/file'];
  await sse(h,[{event:'tool.started',name:'private_tool_name',args:{token:secrets[0],url:secrets[1],path:secrets[2]},preview:secrets.join(' ')},
    {event:'tool.started',tool_call_id:'tool-test',public_intent:`正在读取 ${secrets[2]}`},
    {event:'subagent.start',subagent_id:'private-subagent-id',goal:`正在访问 ${secrets[1]}`},
    {event:'tool.started',tool_call_id:'tool-test',public_intent:`token ${secrets[0]}`},
    {event:'tool.completed',result:secrets.join(' ')}]);
  h.projection.errand({...progress,title:`打开 ${secrets[2]}`});h.at(60000);h.projection.errand({...result(true),answer:secrets.join(' ')});
  await sse(h,[done('private-subagent-id')]);h.projection.settle('completed');h.projection.close();
  const wire=JSON.stringify(h.packets);for(const secret of [...secrets,'private_tool_name','private-subagent-id','private raw answer'])assert.ok(!wire.includes(secret),secret);
});

test('an errand result before the first progress sweep never exposes its raw task argument',()=>{
  const h=harness();h.projection.event({event:'tool.started',run_id:'run-test',timestamp:base/1000});
  h.projection.errand({...result(true),task:'原始工具任务参数不可展示'});h.projection.settle('completed');
  assert.equal(h.latest().items[0]!.summary,'正在处理这件事');assert.ok(!JSON.stringify(h.packets).includes('原始工具任务参数不可展示'));
});

test('parallel tool progress keeps each public intent bound to its actual call',async()=>{
  const h=harness();
  await sse(h,[{event:'tool.started',tool_call_id:'a',public_intent:'正在检查资料'},
    {event:'tool.started',tool_call_id:'b',public_intent:'正在整理结果'},
    {event:'tool.progress',tool_call_id:'a',progress:2,total:5,message:'private progress text'}]);
  assert.equal(h.latest().summary,'正在检查资料');assert.deepEqual(h.latest().progress,{version:1,value:2,total:5});
  await sse(h,[{event:'tool.completed',tool_call_id:'b'}]);
  assert.deepEqual(h.latest().progress,{version:1,value:2,total:5});
  await sse(h,[{event:'message.interim',text:'unbound commentary'}]);
  assert.equal(h.latest().summary,'正在检查资料');assert.ok(!JSON.stringify(h.packets).includes('private progress text'));
  h.projection.settle('completed');h.projection.close();
});

test('authoritative snapshot replaces native items, keeps errands, and restores offline elapsed time',()=>{
  const h=harness();h.at(60000);
  h.projection.event({event:'subagent.start',run_id:'run-test',timestamp:base/1000,subagent_id:'stale',goal:'旧任务'});
  h.projection.errand(progress);
  h.projection.event({event:'run.snapshot',run_id:'run-test',timestamp:(base+60000)/1000,activity_events:[
    {event:'tool.started',run_id:'run-test',timestamp:base/1000,tool_call_id:'actual',public_intent:'正在核验资料'},
    {event:'tool.progress',run_id:'run-test',timestamp:(base+45000)/1000,tool_call_id:'actual',progress:3,total:4},
    {event:'subagent.start',run_id:'run-test',timestamp:base/1000,subagent_id:'actual-agent',goal:'核验资料'},
    {...done('actual-agent'),run_id:'run-test',timestamp:(base+30000)/1000}]});
  assert.equal(h.latest().elapsed_ms,60000);assert.equal(h.latest().counts.total,2);
  assert.equal(h.latest().last_progress_at,new Date(base+60000).toISOString());
  assert.equal(h.latest().items.filter(item=>item.kind==='errand').length,1);
  assert.deepEqual(h.latest().progress,{version:1,value:3,total:4});
  assert.equal(h.latest().items.find(item=>item.kind==='subagent')!.elapsed_ms,30000);
  assert.ok(!JSON.stringify(h.latest()).includes('旧任务'));h.projection.close();
});

test('interrupted native children settle while detached errand still waits for its own result',async()=>{
  const h=harness();await sse(h,[start('unfinished')]);h.projection.errand(progress);
  h.at(60000);h.projection.settle('interrupted',base+30000);
  assert.equal(h.latest().state,'running');assert.equal(h.latest().counts.cancelled,1);
  assert.equal(h.latest().elapsed_ms,60000);
  h.projection.errand(result(true));assert.equal(h.latest().state,'partial');h.projection.close();
});

test('offline native settlement cannot predate a detached errand result',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'}]);h.projection.errand(progress);
  h.at(90000);h.projection.errand(result(true));h.projection.settle('completed',base+30000);
  assert.equal(h.latest().elapsed_ms,60000);assert.equal(h.latest().completed_at,new Date(base+60000).toISOString());
  h.projection.close();
});

test('late detached result after restart uses the retained native time and actual errand finish',async()=>{
  const h=harness();await sse(h,[{event:'tool.started'}]);h.projection.errand(progress);
  h.at(90000);h.projection.settle('completed',base+30000);
  const saved=h.projection.snapshot()!;h.projection.close();
  const resumed=harness(saved);resumed.at(120000);resumed.projection.errand(result(true));
  assert.equal(resumed.latest().elapsed_ms,60000);assert.equal(resumed.latest().completed_at,new Date(base+60000).toISOString());
  resumed.projection.close();
});

test('untrusted progress numbers are rejected in both live and snapshot frames',async()=>{
  const h=harness();
  await assert.rejects(sse(h,[{event:'tool.progress',progress:'private-token',tool_call_id:'bad'}]),/HERMES_TOOL_PROGRESS_INVALID/);
  await assert.rejects(sse(h,[{event:'run.snapshot',run:{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,
    profile_home:'/fixture',run_id:'run-test',status:'running'},activity_events:[
      {event:'tool.progress',run_id:'run-test',timestamp:base/1000,tool_call_id:'bad',progress:'private-token'}]}]),/HERMES_TOOL_PROGRESS_INVALID/);
  h.projection.close();
});

test('offline completion freezes actual source duration and reconnect keeps the last source progress instant',()=>{
  const h=harness();h.at(120000);
  h.projection.event({event:'run.snapshot',run_id:'run-test',timestamp:(base+120000)/1000,activity_events:[
    {event:'tool.started',run_id:'run-test',timestamp:base/1000,tool_call_id:'offline',public_intent:'正在检查资料'},
    {event:'tool.progress',run_id:'run-test',timestamp:(base+30000)/1000,tool_call_id:'offline',progress:1,total:2},
    {event:'tool.completed',run_id:'run-test',timestamp:(base+60000)/1000,tool_call_id:'offline'}]});
  assert.equal(h.latest().last_progress_at,new Date(base+60000).toISOString());
  assert.equal(h.latest().observed_at,new Date(base+120000).toISOString());
  h.projection.settle('completed',base+60000);
  assert.equal(h.latest().elapsed_ms,60000);assert.equal(h.latest().completed_at,new Date(base+60000).toISOString());h.projection.close();
});

test('delegated MCP numeric progress is visible on its child item and clears on completion',async()=>{
  const h=harness();await sse(h,[start('child')]);
  await sse(h,[{event:'subagent.progress',subagent_id:'child',tool_call_id:'child-mcp-call',progress:2,total:5}]);
  assert.deepEqual(h.latest().items[0]!.progress,{version:1,value:2,total:5});assert.deepEqual(h.latest().progress,{version:1,value:2,total:5});
  await assert.rejects(sse(h,[{event:'subagent.progress',subagent_id:'child',tool_call_id:'child-mcp-call',progress:'private-token',total:5}]),/HERMES_TOOL_PROGRESS_INVALID/);
  await sse(h,[{event:'subagent.progress',subagent_id:'child',status:'running'}]);
  assert.equal(h.latest().items[0]!.progress,undefined);assert.equal(h.latest().progress,undefined);
  await sse(h,[done('child')]);h.projection.settle('completed');
  assert.equal(h.latest().items[0]!.progress,undefined);assert.equal(h.latest().progress,undefined);
  assert.ok(!JSON.stringify(h.packets).includes('private-token'));h.projection.close();
});


test('numeric progress needs a positive total and clears when work switches or completes',async()=>{
  const h=harness();await sse(h,[{event:'tool.started',public_intent:'正在检查资料'},
    {event:'tool.progress',progress:2}]);assert.equal(h.latest().progress,undefined);
  await sse(h,[{event:'tool.progress',progress:0,total:0}]);assert.equal(h.latest().progress,undefined);
  await sse(h,[{event:'tool.progress',progress:2,total:5}]);
  assert.deepEqual(h.latest().progress,{version:1,value:2,total:5});
  await sse(h,[{event:'tool.started',tool_call_id:'next',public_intent:'正在整理结果'}]);
  assert.equal(h.latest().progress,undefined);
  await sse(h,[{event:'tool.progress',tool_call_id:'next',progress:1,total:3},{event:'tool.completed',tool_call_id:'next'}]);
  assert.deepEqual(h.latest().progress,{version:1,value:2,total:5});
  h.projection.errand(progress);assert.ok(!h.latest().step_summary?.includes('1/10'));
  assert.equal(h.latest().items[0]!.progress,undefined);
  h.projection.settle('completed');assert.equal(h.latest().progress,undefined);
  h.projection.errand(result(true));assert.equal(h.latest().progress,undefined);h.projection.close();
});

test('restored delegated progress uses the saved authority and terminal settlement clears it',async()=>{
  const first=harness();await sse(first,[start('child'),{event:'subagent.progress',subagent_id:'child',progress:1,total:4}]);
  const saved=first.projection.snapshot()!;first.projection.close();
  const resumed=harness(saved);assert.deepEqual(resumed.latest().items[0]!.progress,{version:1,value:1,total:4});
  resumed.projection.settle('interrupted');assert.equal(resumed.latest().progress,undefined);
  assert.equal(resumed.latest().items[0]!.progress,undefined);resumed.projection.close();
});


test('errand and direct tool progress keep the card action bound to the numeric source',async()=>{
  const h=harness();await sse(h,[{event:'tool.started',public_intent:'正在核验资料'}]);
  h.projection.errand(progress);
  await sse(h,[{event:'tool.progress',progress:3,total:7}]);
  assert.equal(h.latest().summary,'正在核验资料');assert.equal(h.latest().summary_source,'agent_intent');
  assert.equal(h.latest().step_summary,undefined);assert.deepEqual(h.latest().progress,{version:1,value:3,total:7});
  assert.equal(h.latest().items[0]!.summary,'打开云手机');assert.equal(h.latest().items[0]!.progress,undefined);
  await sse(h,[{event:'tool.completed'}]);
  assert.equal(h.latest().progress,undefined);assert.equal(h.latest().step_summary,'打开云手机 · 正在处理');
  h.projection.close();
});

test('errand preceding a numeric delegate cannot replace its card action or denominator',async()=>{
  const h=harness();await sse(h,[{event:'tool.started',public_intent:'正在协调工作'}]);
  h.projection.errand(progress);
  await sse(h,[{event:'subagent.start',subagent_id:'research',goal:'正在核验资料'},
    {event:'subagent.progress',subagent_id:'research',progress:2,total:9}]);
  assert.equal(h.latest().summary,'正在核验资料');assert.equal(h.latest().summary_source,'subagent_goal');
  assert.equal(h.latest().step_summary,undefined);assert.deepEqual(h.latest().progress,{version:1,value:2,total:9});
  assert.equal(h.latest().counts.total,2);assert.equal(h.latest().items[0]!.step_summary,'打开云手机 · 正在处理');
  assert.deepEqual(h.latest().items[1]!.progress,{version:1,value:2,total:9});
  await sse(h,[done('research')]);
  assert.equal(h.latest().progress,undefined);assert.equal(h.latest().step_summary,'打开云手机 · 正在处理');
  h.projection.close();
});
