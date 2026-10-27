import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {receipt,succeeded,unknown,value,type Receipt} from '../../../../../capability/sdk/ts/receipt.ts';
import {result,type ResultInput} from '../../../../../capability/packages/ts-host/result.ts';
import {receiptFacts,recordFacts,renderFacts} from '../src/capability/renderer.ts';
import {checkReport,factCarried} from '../src/capability/checker.ts';
import {ReceiptLedger,type ReceiptRecord} from '../src/capability/ledger.ts';
import {PosixStorage} from '../src/storage.ts';

const at='2026-10-25T09:00:00Z';
const people=Array.from({length:124},()=>({display_name:null,count:5,speech_ms:37858,last_seen_ms:0,visible:false}));
const peopleResult={face_recognition:false,people};
const legacyPeople=()=>succeeded({values:[value('face_recognition',false,'none','observed','fixture',at),
  ...people.flatMap((row,index)=>Object.entries(row).map(([key,raw])=>value(`people[${index}].${key}`,raw,
    key==='count'?'count':key.endsWith('_ms')?'ms':'none','observed','fixture',at)))],
  content:[{key:'fixture',text:JSON.stringify(peopleResult),provenance:'observed'}]});
const phone=(id:string,why='付款来源记录无法核验')=>unknown({job:{id,revision:0},
  unknowns:[{about:'payment_state',why}],next:{retry:'after_check',check_with:'check'}});
const record=(body:Receipt,index:number):ReceiptRecord=>({id:`receipt-${index}`,call_id:`call-${index}`,
  task_id:'child',tool_call_id:`tool-${index}`,tool:'fixture',invocation:'fixture',fingerprint:'fixture',receipt:body});

test('124 rows by five fields become one list fact without losing the admitted payload',()=>{
  const body=legacyPeople(),before=structuredClone(body),facts=receiptFacts([body]);
  const text=renderFacts(facts,'text'),voice=renderFacts(facts,'voice');
  assert.ok(text.split('\n').length<=13);
  assert.ok(text.length<2200);
  assert.match(text,/people.*124.*124.*未知/u);
  assert.doesNotMatch(text,/people\[\d+\]|37858ms|5count|"display_name"/u);
  assert.doesNotMatch(voice,/people\[\d+\]|ms|count/u);
  assert.equal(facts.filter(fact=>fact.value?.key==='people'&&fact.value.value===124).length,1);
  assert.deepEqual(body,before);
});

test('four different phone jobs render each equal fact once and retain every causal identity',()=>{
  const records=Array.from({length:4},(_,index)=>record(phone(`job-${index}`),index));
  const facts=recordFacts(records,'run');
  assert.equal(new Set(facts.map(fact=>fact.id)).size,facts.length);
  assert.equal(facts.length,12);
  const text=renderFacts(facts,'text');
  for(const sentence of ['结果尚未核实。','payment_state尚不清楚：付款来源记录无法核验。','需要先核查结果，再决定是否重试。'])
    assert.equal(text.split(sentence).length-1,1);
  const decision=checkReport(text,records.map(row=>row.receipt),'',facts,'text',facts);
  assert.equal(decision.removed.length,0);
  assert.equal(decision.fact_ids.length,facts.length);
  const repeated=checkReport(Array(4).fill(text).join('\n'),records.map(row=>row.receipt),'',facts,'text',facts);
  assert.equal(repeated.text,text);
  const different=renderFacts([...facts,...recordFacts([record(phone('other-job','收款方身份无法核验'),4)],'run')],'text');
  assert.match(different,/付款来源记录无法核验/u);
  assert.match(different,/收款方身份无法核验/u);
});

test('a copied scalar dump is bounded even when every row, boolean and null is valid',()=>{
  const body=legacyPeople(),facts=receiptFacts([body]);
  const dump=body.values.map(row=>`${row.key}：${row.value===null?'未知':typeof row.value==='boolean'?(row.value?'是':'否'):row.value}${row.unit==='none'?'':row.unit}。`).join('\n');
  const checked=checkReport(dump,[body],'',facts);
  assert.ok(checked.text.split('\n').length<=13);
  assert.ok(checked.text.length<2200);
  assert.ok(checked.removed.some(row=>row.reasons.includes('fact_budget')));
});

test('omissions are reported and repaired without expanding the list; contradictions still fail',()=>{
  const body=legacyPeople(),facts=receiptFacts([body]);
  const missing=checkReport('我来说明。',[body],'',facts);
  assert.ok(missing.missing_fact_ids.length>0);
  assert.match(missing.text,/people.*124/u);
  assert.ok(missing.text.split('\n').length<=14);
  const wrong=checkReport('people共有125个。',[body],'',facts);
  assert.ok(wrong.removed.some(row=>row.reasons.includes('unsupported_number')||row.reasons.includes('value_conflict')));
  const unresolved=phone('job');
  assert.ok(checkReport('失败了。',[unresolved],'',receiptFacts([unresolved])).removed.some(row=>row.reasons.includes('status_conflict')));
  assert.ok(checkReport('face_recognition：是。',[body],'',facts).removed.some(row=>row.reasons.includes('value_conflict')));
  assert.ok(checkReport('people[0].display_name是张三。',[body],'',facts).removed.some(row=>row.reasons.includes('value_conflict')));
});

test('a general fact budget records deferred facts and never acknowledges their hidden details',async t=>{
  const body=succeeded({values:Array.from({length:80},(_,index)=>value(`测量${index}`,index,'count','observed','fixture',at))});
  const facts=receiptFacts([body]),text=renderFacts(facts,'text');
  assert.ok(text.split('\n').length<=13);
  assert.match(text,/共81项事实，已记录/u);
  const decision=checkReport('',[body],'',facts);
  assert.ok(decision.deferred_fact_ids.length>0);
  assert.ok(decision.deferred_fact_ids.every(id=>!decision.fact_ids.includes(id)));
  assert.equal(checkReport(decision.text,[body],'',facts).removed.length,0);
  const folder=await mkdtemp(join(tmpdir(),'fact-budget-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const ledger=new ReceiptLedger(new PosixStorage(folder));
  await ledger.delivered('owner',decision.fact_ids,'rendered');
  const novel=await ledger.novel('owner',facts);
  assert.ok(decision.deferred_fact_ids.every(id=>novel.some(fact=>fact.id===id)));
});

test('human units preserve exact quantities, nullable values stay unknown, and unsupported units fail',()=>{
  const body=succeeded({values:[value('次数',5,'count','observed','fixture',at),
    value('时长',37858,'ms','observed','fixture',at),value('缺失值',null,'none','observed','fixture',at)]});
  const facts=receiptFacts([body]),text=renderFacts(facts,'text');
  assert.match(text,/5个/u);assert.match(text,/37\.858秒/u);assert.match(text,/缺失值：未知/u);
  assert.doesNotMatch(text,/null|ms|count/u);
  assert.equal(checkReport('时长37.858秒。',[body],'',facts).removed.length,0);
  assert.equal(checkReport('次数5次。',[body],'',facts).removed.length,0);
  assert.ok(checkReport('时长37.859秒。',[body],'',facts).removed.length);
  assert.ok(checkReport('时长37.858元。',[body],'',facts).removed.length);
  assert.ok(factCarried(facts.find(fact=>fact.value?.key==='时长')!,'时长37.858秒。','text'));
});

test('the generic TS package emits aggregate list values and preserves raw details for checked requests',()=>{
  const input:ResultInput={name:'fixture_read',args:{},policy:{effect:'observe'},result:peopleResult,now:at};
  const body=result(input,'succeeded');
  assert.equal(body.values.find(row=>row.key==='people')?.value,124);
  assert.ok(body.values.length<=3);
  assert.ok(body.values.every(row=>!row.key.includes('[')));
  assert.ok(body.unknowns.some(row=>row.about==='people'));
  assert.deepEqual(JSON.parse(body.content[0]!.text),peopleResult);
  const facts=receiptFacts([body]);
  const detail=checkReport('people[0].speech_ms是37.858秒。',[body],'请看第一个条目的时长',facts);
  assert.equal(detail.removed.length,0);
  assert.ok(checkReport('people[0].speech_ms是37.859秒。',[body],'',facts).removed.length);
});

test('null and large structured contents have honest projections without raw JSON or a synthetic result label',()=>{
  const input:ResultInput={name:'fixture_read',args:{},policy:{effect:'observe'},result:null,now:at};
  const empty=result(input,'unknown');
  const text=renderFacts(receiptFacts([empty]),'text');
  assert.doesNotMatch(text,/result：|null/u);
  assert.match(text,/未知|不清楚|未核实/u);
  const body=receipt('succeeded',{content:[{key:'fixture',text:JSON.stringify({rows:people}),provenance:'observed'}]});
  const facts=receiptFacts([body]),shown=renderFacts(facts,'text');
  assert.ok(shown.length<2200);assert.doesNotMatch(shown,/"display_name"/u);
  assert.equal(checkReport(shown,[body],'',facts).removed.length,0);
});

test('delivery of duplicate sentences is causal, restart-safe, and does not suppress a fresh job',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'fact-delivery-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const storage=new PosixStorage(folder),ledger=new ReceiptLedger(storage),binding={principal_id:'owner',run_id:'run'};
  for(let index=0;index<4;index++)await ledger.admit(binding,{task_id:'child',tool_call_id:`call-${index}`,tool_name:'fixture',args:{}},phone(`job-${index}`));
  const records=await ledger.current(binding),facts=recordFacts(records,'run'),shown=renderFacts(facts,'text');
  const decision=checkReport(shown,records.map(row=>row.receipt),'',facts);
  assert.deepEqual(await ledger.novel('owner',facts),facts);
  await ledger.delivered('owner',decision.fact_ids,'rendered');
  const restored=new ReceiptLedger(storage);
  assert.equal((await restored.novel('owner',facts)).length,0);
  assert.deepEqual(await restored.novel('guest',facts),facts);
  const fresh=recordFacts([record(phone('fresh-job'),5)],'run');
  assert.deepEqual(await restored.novel('owner',fresh),fresh);
});

test('a bounded projection of mixed outcomes is a checker fixed point',()=>{
  const bodies=[legacyPeople(),unknown({unknowns:[{about:'返回内容',why:'尚未提供'}]})];
  const facts=recordFacts(bodies.map(record),'run');
  for(const outlet of ['text','voice']as const){
    const text=renderFacts(facts,outlet),checked=checkReport(text,bodies,'',facts,outlet,facts);
    assert.equal(checked.removed.length,0);
    assert.equal(checked.text,text);
    assert.equal(checked.missing_fact_ids.length,0);
  }
});
