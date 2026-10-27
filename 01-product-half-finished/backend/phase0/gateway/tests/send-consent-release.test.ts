import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseSendConsents} from '../src/send-consent-release.ts';
import {canonical,digest} from '../../../services/personal-aios-integration/src/contracts.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {SEND_CONSENTS} from '../../../services/personal-aios-integration/src/capability/send-identity.ts';

test('the existing provision migrate step includes send consent migration against the persistent native owner directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'send-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'native');await mkdir(home);
  const policy=join(root,'owner.json'),config=join(root,'config.json'),storage=new PosixStorage(join(root,'central-storage'));
  await writeFile(policy,JSON.stringify({schema:'paios.windows.local-owner.v1',purpose:'public_product_canary',userId:'fixture-owner',revocable:true}));
  await writeFile(config,JSON.stringify({storage_root:storage.root,core_profile:{native_profile_home:home},product_resources:{owner_policy_file:policy}}));
  // Owner-maintained aliases survive native directory rebuilds, just as load_directory() already specifies.
  await writeFile(join(home,'channel_aliases.json'),JSON.stringify({wechat:{wxid_fixture:'测试·联系人'}}));
  const scope={principal_id:'fixture-owner',kind:'send',task_type:'wechat_reply_text',recipient:'wechat:测试联系人'};
  const bytes=Buffer.from(canonical({...scope,confirmation_id:'fixture-card',confirmed_at:'2026-10-19T00:00:00Z'}));
  await storage.publish('effect-consents',digest(scope),bytes);
  const result=await releaseSendConsents(config);assert.equal(result.migrated,1);assert.deepEqual(result.unmigrated,[]);
  const target=digest({...scope,task_type:'message.text',recipient:'wechat:id:wxid_fixture'});
  assert.equal(JSON.parse(Buffer.from(await storage.read(SEND_CONSENTS,target)).toString()).confirmation_id,'fixture-card');
  assert.deepEqual(await storage.read('effect-consents',digest(scope)),bytes);
  assert.equal((await releaseSendConsents(config)).already_migrated,1);
  const provision=await readFile(new URL('../tools/mac-product-provision.ts',import.meta.url),'utf8');
  assert.match(provision,/parsed.command === 'migrate'[\s\S]*?send_consents:await releaseSendConsents/u);
});

test('unmapped display names are listed during release and never acquire a grant',async t=>{
  const root=await mkdtemp(join(tmpdir(),'send-release-unresolved-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const policy=join(root,'owner.json'),config=join(root,'config.json'),storage=new PosixStorage(join(root,'central-storage'));
  await writeFile(policy,JSON.stringify({schema:'paios.windows.local-owner.v1',purpose:'public_product_canary',userId:'owner',revocable:true}));
  await writeFile(config,JSON.stringify({storage_root:storage.root,core_profile:{native_profile_home:join(root,'missing')},product_resources:{owner_policy_file:policy}}));
  const scope={principal_id:'owner',kind:'send',task_type:'wechat_file_send',recipient:'wechat:测试联系人'};
  await storage.publish('effect-consents',digest(scope),Buffer.from(canonical(scope)));
  const result=await releaseSendConsents(config);
  assert.equal(result.status,'completed_with_unmigrated');assert.equal(result.unmigrated[0]!.reason,'SEND_RECIPIENT_UNRESOLVED');
  assert.deepEqual(await storage.list(SEND_CONSENTS),[]);
});
