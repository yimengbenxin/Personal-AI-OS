import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/contracts.ts';
import {effectConsent} from '../src/effect-consent.ts';
import {migrateSendConsents} from '../src/capability/send-consent-migration.ts';
import {SEND_CONSENTS} from '../src/capability/send-identity.ts';
import {channelAddress,wechatName,wechatRecipient} from '../../../../../capability/contracts/send-recipient.ts';
import {directory,records,recordScope,sendFixture,tools} from './send-consent-fixture.ts';

test('owner-shaped 10-19 text and file grants survive migration, release upgrade and actual legacy rollback',async t=>{
  const f=await sendFixture(t);
  for(const record of records)await f.seed(record);
  const before=await Promise.all(records.map((r:any)=>f.storage.read('effect-consents',digest(recordScope(r)))));
  assert.equal((await f.decide('wechat_send_text')).status,'confirmation_required');
  const migrated=await migrateSendConsents(f.storage,'owner-fixture',directory);
  assert.equal(migrated.migrated,2);assert.deepEqual(migrated.unmigrated,[]);
  for(const [index,tool] of ['wechat_send_text','wechat_send_file'].entries()){
    const decision=await f.decide(tool);assert.equal(decision.status,'allowed');
    assert.equal(decision.approval?.confirmation_id,records[index].confirmation_id);
    assert.equal(decision.approval?.reused,true);
    const legacy=await effectConsent(f.ports,f.context,{kind:'send',task_type:records[index].task_type,recipient:records[index].recipient,requested:true});
    assert.equal(legacy.status,'allowed');assert.equal(legacy.approval?.confirmation_id,records[index].confirmation_id);
  }
  const replay=await migrateSendConsents(f.storage,'owner-fixture',directory);
  assert.equal(replay.migrated,0);assert.equal(replay.already_migrated,2);
  for(const [index,record] of records.entries())assert.deepEqual(await f.storage.read('effect-consents',digest(recordScope(record))),before[index]);
});

test('a new person, another kind, another owner and unsolicited sends still ask',async t=>{
  const f=await sendFixture(t);await f.seed(records[0]);await migrateSendConsents(f.storage,'owner-fixture',directory);
  assert.equal((await f.decide('wechat_send_text')).status,'allowed');
  assert.equal((await f.decide('wechat_reply')).status,'allowed');
  assert.equal((await f.decide('wechat_send_text','wechat:name:另一个人')).status,'confirmation_required');
  assert.equal((await f.decide('wechat_send_file')).status,'confirmation_required');
  assert.equal((await f.decide('wechat_send_text',undefined,false,false)).status,'confirmation_required');
  assert.equal((await f.decide('wechat_send_text',undefined,true,false)).status,'allowed');
  assert.equal((await f.decide('wechat_send_text',undefined,false,false,'next-call')).status,'confirmation_required');
  f.entry.d.principal_id='another-owner';f.entry.d.user_identity='another-owner';
  assert.equal((await f.decide('wechat_send_text')).status,'confirmation_required');
});

test('a new WeChat approval projects only that kind for rollback, and recovers an interrupted projection',async t=>{
  const f=await sendFixture(t);
  const publish=f.storage.publish.bind(f.storage);let interrupted=false;
  f.storage.publish=async(...args)=>{if(args[0]==='effect-consents'&&!interrupted){interrupted=true;throw Error('interrupted');}return publish(...args);};
  await assert.rejects(f.decide('wechat_send_text',undefined,true),/interrupted/u);
  f.storage.publish=publish;
  assert.equal((await f.decide('wechat_send_text')).status,'allowed');
  for(const task_type of ['wechat_reply_text','wechat_send_text','wechat_reply'])assert.equal((await effectConsent(f.ports,f.context,
    {kind:'send',task_type,recipient:'wechat:测试联系人',requested:true})).status,'allowed');
  assert.equal((await effectConsent(f.ports,f.context,{kind:'send',task_type:'wechat_file_send',recipient:'wechat:测试联系人',requested:true})).status,'confirmation_required');
  assert.equal((await f.decide('wechat_send_file')).status,'confirmation_required');
});

test('unknown kind, name collisions, absent identities and nonpersistent legacy records never acquire a new grant',async t=>{
  const f=await sendFixture(t);
  await f.seed(records[0]);await f.seed({...records[1],task_type:'invented_file_kind'});
  await f.seed({...records[0],recipient:'wechat:没有目录记录'});
  const once={...records[0],run_id:'run',tool_call_id:'call'};
  await f.storage.publish('effect-consents',digest({...recordScope(once),run_id:'run',tool_call_id:'call'}),Buffer.from(canonical(once)));
  const result=await migrateSendConsents(f.storage,'owner-fixture',{platforms:{wechat:[{id:'a',name:'测试联系人'},{id:'b',name:'测试·联系人'}]}});
  assert.equal(result.migrated,0);assert.equal(result.unmigrated.length,3);
  assert.deepEqual(result.unmigrated.map(x=>x.reason).sort(),['SEND_KIND_AMBIGUOUS','SEND_RECIPIENT_AMBIGUOUS','SEND_RECIPIENT_UNRESOLVED']);
  assert.deepEqual(await f.storage.list(SEND_CONSENTS),[]);
});

test('stable handles beat nicknames; decoration normalisation never merges two directory rows',()=>{
  for(const name of ['测试·联系人',' 测试 • 联系人 🌟','测试联系人','测试\u{1fae9}联系人'])assert.equal(wechatName(name),'测试联系人');
  const resolved=wechatRecipient('wechat:测试联系人',{platforms:{wechat:[{id:'wxid_one',name:'测试·联系人'}]}});
  assert.equal(resolved.recipient,'wechat:id:wxid_one');
  assert.equal(wechatRecipient('wechat:id:wxid_one',{platforms:{wechat:[{id:'wxid_one',name:'新名字'}]}}).recipient,resolved.recipient);
  assert.throws(()=>wechatRecipient('wechat:测试联系人',{platforms:{wechat:[{id:'one',name:'测试联系人'},{id:'two',name:'测试·联系人'}]}}),/AMBIGUOUS/u);
  assert.equal(channelAddress('email:Owner+tag@EXAMPLE.COM'),'email:Owner+tag@example.com');
  assert.notEqual(channelAddress('email:Owner@example.com'),channelAddress('email:owner@example.com'));
});

test('legacy messaging send cannot be guessed into text or file; a legacy reaction has an unambiguous kind',async t=>{
  const f=await sendFixture(t),send={...records[0],recipient:'email:Owner@example.com',task_type:'send_message:email:send'};
  await f.seed(send);await f.seed({...send,task_type:'send_message:email:react'});
  const result=await migrateSendConsents(f.storage,'owner-fixture',directory);
  assert.equal(result.migrated,1);assert.equal(result.unmigrated.length,1);assert.equal(result.unmigrated[0]!.reason,'SEND_KIND_AMBIGUOUS');
  const grants=await f.storage.list(SEND_CONSENTS);
  assert.equal(grants.length,1);
  assert.equal(JSON.parse(Buffer.from(await f.storage.read(SEND_CONSENTS,grants[0]!)).toString()).task_type,'message.reaction');
  assert.equal((await effectConsent(f.ports,f.context,{kind:'send',recipient:send.recipient,task_type:send.task_type,requested:true})).status,'allowed');
});

test('model effect fields and package version cannot choose the catalog kind or resolved recipient',async t=>{
  const f=await sendFixture(t),tool=tools.get('mcp__wechat-mac__wechat_send_text')!;
  const original=f.identity(tool.name),spoofed=f.identity(tool.name,undefined,{task_type:'wechat_send_file',recipient:'wechat:别人',effect:{recipient:'wechat:别人'}});
  assert.deepEqual(spoofed,original);
  const upgraded={...tool,version_digest:'f'.repeat(64),task_type:'renamed_in_release'};
  const {sendIdentity}=await import('../src/capability/send-identity.ts');
  assert.equal(sendIdentity(upgraded,{tool_name:'new_name',args:{},prepared:{target:original.recipient},
    task_id:'t',session_id:'s',api_request_id:'r',tool_call_id:'c',turn_id:'t'}).task_type,original.task_type);
  assert.equal((await effectConsent(f.ports,f.context,{kind:'send',task_type:original.task_type,recipient:original.recipient,requested:true},true,false,'bad',undefined).catch(()=>({status:'denied'}))).status,'denied');
});

test('migration depends on declared stable kinds even when a release renames every catalog tool',async t=>{
  const f=await sendFixture(t);
  for(const record of records)await f.seed(record);
  const renamed=new Map([...tools].map(([id,tool])=>['renamed:'+id,{...tool,name:'renamed_'+tool.name,version_digest:'f'.repeat(64)}]));
  const result=await migrateSendConsents(f.storage,'owner-fixture',directory,renamed);
  assert.equal(result.migrated,2);assert.deepEqual(result.unmigrated,[]);
  assert.equal((await f.decide('wechat_send_text')).status,'allowed');
  assert.equal((await f.decide('wechat_send_file')).status,'allowed');
});
