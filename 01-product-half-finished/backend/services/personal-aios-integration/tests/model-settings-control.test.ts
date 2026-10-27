import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign,createHash,createPublicKey,diffieHellman,hkdfSync,createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentStore} from '../src/payment/store.ts';
import {PaymentKeys} from '../src/payment/keys.ts';
import {ModelSettingsControl} from '../src/model-settings-control.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {canonical,check} from '../src/contracts.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
const phone:RegisteredDevice={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text']};
const identity=generateKeyPairSync('x25519');
const mac:RegisteredDevice={...phone,device_id:'mac',device_type:'mac',recipient_public_key:identity.publicKey.export({format:'jwk'}).x!};
function pair(){const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),j=key.publicKey.export({format:'jwk'});return {...key,public_x963_b64:Buffer.concat([Buffer.from([4]),Buffer.from(j.x!,'base64url'),Buffer.from(j.y!,'base64url')]).toString('base64')};}
function fixture(t:test.TestContext,durable=false){
  const home=mkdtempSync(join(tmpdir(),'model-control-'));
  let beforeKeyRevalidate:((source:RegisteredDevice)=>Promise<void>)|undefined;
  const revalidateKey=async(source:RegisteredDevice)=>{await beforeKeyRevalidate?.(source);return source;};
  let store=PaymentStore.open(home),keys=new PaymentKeys({store,challenge_ttl_s:120,now:()=>1000,revalidate:revalidateKey});
  const settingsOptions={environment_id:'fixture',master_key:Buffer.alloc(32,7),now:()=>1000};
  let persisted=durable?ModelSettingsAuthority.open(join(home,'settings'),settingsOptions):undefined;
  t.after(()=>{persisted?.close();store.close();rmSync(home,{recursive:true,force:true});});
  const user=pair(),macKey=pair();store.db.prepare('INSERT INTO device_keys VALUES(?,?,?,?,?,NULL)').run('phone','user','owner',user.public_x963_b64,1000);
  let revision=0,fail=false,sequence=0;const drafts=new Map<string,Record<string,unknown>>(),cache=new Map<string,{id:string;fingerprint:string;device:string}>();
  const fakeAuthority={read:()=>({environment_id:'fixture',desired:revision,groups:{},providers:[],roles:[],credentials:{}}),
    readRevision:(revision:number)=>({revision,snapshot:{providers:[],roles:[]},versions:{}}),
    draft:(_s:RegisteredDevice,request:Record<string,unknown>)=>{const draft={draft_id:`draft-${++sequence}`,principal_id:'owner',expected_revision:revision,
      expires_at_ms:100000,action:request.action??'commit',payload:structuredClone(request),change_sha256:createHash('sha256').update(canonical(request)).digest('hex')};drafts.set(draft.draft_id,draft);return draft;},
    getDraft:(_s:RegisteredDevice,id:string)=>{const draft=drafts.get(id);assert.ok(draft);return draft;},
    latestMacAuthorization:(principal:string,device:string)=>{
      const draft=[...cache.values()].map(entry=>drafts.get(entry.id)).filter(draft=>draft?.action==='authorize_mac'&&
        (draft.payload as Record<string,unknown>).device_id===device&&draft.principal_id===principal).at(-1);
      return draft?{revision:Number(draft.expected_revision)+1,public_x963_b64:(draft.payload as Record<string,unknown>).public_x963_b64 as string}:undefined;
    },
    cached:(s:RegisteredDevice,id:string,nonce:string,fingerprint:string)=>{const old=cache.get(nonce);if(!old)return;
      check(old.id===id&&old.fingerprint===fingerprint&&old.device===s.device_id,'MODEL_SETTINGS_REPLAY_CONFLICT');return fakeAuthority.read();},
    commitDraft:(s:RegisteredDevice,id:string,nonce:string,fingerprint:string)=>{check(!fail,'MODEL_SETTINGS_CAS');revision++;cache.set(nonce,{id,fingerprint,device:s.device_id});return fakeAuthority.read();},
    keyDraft:()=>({prepared:true}),testConnection:async()=>({ok:true})};
  let authority=persisted??fakeAuthority;
  const makeControl=()=>new ModelSettingsControl({authority:authority as never,keys,revalidate:async s=>s,devices:async()=>[phone,mac]});
  let control=makeControl();
  const reopen=()=>{
    assert.ok(persisted);persisted.close();store.close();
    store=PaymentStore.open(home);keys=new PaymentKeys({store,challenge_ttl_s:120,now:()=>1000,revalidate:revalidateKey});
    persisted=ModelSettingsAuthority.open(join(home,'settings'),settingsOptions);authority=persisted;control=makeControl();
  };
  const publishInput=async(source=mac,key=macKey,privateKey=identity.privateKey)=>{
    const challenge=await control.dispatch(source,{operation:'model_settings_key_challenge'}) as {nonce:string;server_public_key_b64:string};
    const publicKey=createPublicKey({key:{kty:'OKP',crv:'X25519',x:Buffer.from(challenge.server_public_key_b64,'base64').toString('base64url')},format:'jwk'});
    const shared=diffieHellman({privateKey,publicKey}),macKeyBytes=Buffer.from(hkdfSync('sha256',shared,Buffer.from(challenge.nonce,'base64url'),Buffer.from('paios.model_settings.publish_key.v1'),32));
    const statement=Buffer.from(JSON.stringify({purpose:'model_settings_publish_key',device_id:source.device_id,principal_id:source.principal_id,nonce:challenge.nonce,
      key_sha256:createHash('sha256').update(Buffer.from(key.public_x963_b64,'base64')).digest('hex')}));
    return {operation:'model_settings_publish_key',request:{public_x963_b64:key.public_x963_b64},statement_b64:statement.toString('base64'),signature_b64:createHmac('sha256',macKeyBytes).update(statement).digest('base64')};
  };
  const publish=async()=>control.dispatch(mac,await publishInput());
  const execute=async(s:RegisteredDevice,key:ReturnType<typeof pair>,draft:Record<string,unknown>)=>{
    const challenge=await keys.challenge(s,'model_settings'),statement={purpose:'model_settings',device_id:s.device_id,nonce:challenge.nonce,
      ...Object.fromEntries(['action','draft_id','expected_revision','change_sha256','expires_at_ms','principal_id'].map(field=>[field,draft[field]]))};
    const bytes=Buffer.from(JSON.stringify(statement));return {operation:`model_settings_${draft.action}`,control_id:'execute',request:{draft_id:draft.draft_id},
      statement_b64:bytes.toString('base64'),signature_b64:sign('sha256',bytes,key.privateKey).toString('base64')};
  };
  return {get control(){return control;},get authority(){return authority;},get keys(){return keys;},user,macKey,execute,get store(){return store;},publish,publishInput,reopen,setKeyRevalidate:(hook:typeof beforeKeyRevalidate)=>{beforeKeyRevalidate=hook;},setFail:(value:boolean)=>{fail=value;}};
}
test('formal controls enforce read-only Mac, phone authorization, direct Mac signatures, exact replay and payment isolation',async t=>{
  const f=fixture(t);
  assert.equal((await f.control.dispatch(mac,{operation:'model_settings_read'}) as {revision:number}).revision,0);
  for(const operation of ['draft','test','challenge','set_key','commit','undo','authorize_mac','pause','resume','catalog'])await assert.rejects(f.control.dispatch(mac,{operation:`model_settings_${operation}`,request:{}}),/MODEL_SETTINGS_MAC_UNAUTHORIZED/);
  await f.publish();
  const auth=await f.control.dispatch(phone,{operation:'model_settings_draft',request:{action:'authorize_mac',expected_revision:0,device_id:'mac',public_x963_b64:f.macKey.public_x963_b64}}) as Record<string,unknown>;
  await f.control.dispatch(phone,await f.execute(phone,f.user,auth));assert.ok(f.keys.registered(mac,'model_settings'));
  assert.deepEqual(await f.control.dispatch(phone,{operation:'model_settings_pending_macs'}),{items:[],next_offset:null});
  const draft=await f.control.dispatch(mac,{operation:'model_settings_draft',request:{expected_revision:1,providers:[],roles:[],change_summary:'Change routes'}}) as Record<string,unknown>;
  const signed=await f.execute(mac,f.macKey,draft);
  assert.deepEqual(await f.control.dispatch(mac,signed),{environment_id:'fixture',desired:2,groups:{}});assert.deepEqual(await f.control.dispatch(mac,signed),{environment_id:'fixture',desired:2,groups:{}});
  await assert.rejects(f.control.dispatch(mac,{...signed,operation:'model_settings_pause'}),/MODEL_SETTINGS_ACTION_MISMATCH/);
  await assert.rejects(f.control.dispatch(mac,{...signed,signature_b64:Buffer.from('different').toString('base64')}),/MODEL_SETTINGS_REPLAY_CONFLICT/);
  await assert.rejects(f.keys.challenge(mac,'phone_unlock'),/PAYMENT_SETTINGS_DEVICE_REQUIRED/);
});
test('failed authority CAS does not consume nonce or authorize Mac; same signed request can be retried',async t=>{
  const f=fixture(t);await f.publish();const draft=await f.control.dispatch(phone,{operation:'model_settings_draft',request:{action:'authorize_mac',expected_revision:0,device_id:'mac',public_x963_b64:f.macKey.public_x963_b64}}) as Record<string,unknown>;
  const signed=await f.execute(phone,f.user,draft);f.setFail(true);
  await assert.rejects(f.control.dispatch(phone,signed),/MODEL_SETTINGS_CAS/);assert.equal(f.keys.registered(mac,'model_settings'),undefined);
  f.setFail(false);await f.control.dispatch(phone,signed);assert.ok(f.keys.registered(mac,'model_settings'));
});
test('cached exact phone authorization recovers a lost registry commit without replaying authority mutation',async t=>{
 const f=fixture(t);await f.publish();const draft=await f.control.dispatch(phone,{operation:'model_settings_draft',request:{action:'authorize_mac',expected_revision:0,device_id:'mac',public_x963_b64:f.macKey.public_x963_b64}}) as Record<string,unknown>;
 const input=await f.execute(phone,f.user,draft);const original=f.store.tx.bind(f.store);let crash=true;
 f.store.tx=mutation=>original(()=>{const value=mutation();if(crash)throw Error('crash after authority commit');return value;});
 await assert.rejects(f.control.dispatch(phone,input),/crash after authority commit/);assert.equal(f.keys.registered(mac,'model_settings'),undefined);
 crash=false;await f.control.dispatch(phone,input);assert.ok(f.keys.registered(mac,'model_settings'));assert.equal(f.authority.read().desired,1);
});
test('publication authenticates the paired identity, binds its device and key, consumes nonce and grants only pending purpose',async t=>{
 const f=fixture(t),input=await f.publishInput();
 await assert.rejects(f.control.dispatch({...mac,device_id:'victim'},input),/PAYMENT_SIGNATURE_INVALID/);
 const different=pair();await assert.rejects(f.control.dispatch(mac,{...input,request:{public_x963_b64:different.public_x963_b64}}),/PAYMENT_SIGNATURE_INVALID/);
 const forged=await f.publishInput(mac,f.macKey,generateKeyPairSync('x25519').privateKey);
 await assert.rejects(f.control.dispatch(mac,forged),/PAYMENT_SIGNATURE_INVALID/);
 await f.control.dispatch(mac,input);await assert.rejects(f.control.dispatch(mac,input),/PAYMENT_CHALLENGE_INVALID/);
 assert.ok(f.keys.pendingModelSettings(mac));assert.equal(f.keys.registered(mac,'model_settings'),undefined);
 await assert.rejects(f.keys.challenge(mac,'model_settings'),/MODEL_SETTINGS_MAC_UNAUTHORIZED/);
 await assert.rejects(f.keys.challenge(mac,'keys_register'),/PAYMENT_SETTINGS_DEVICE_REQUIRED/);
 assert.deepEqual(f.store.db.prepare('SELECT role FROM device_keys WHERE device_id=?').all('mac').map(row=>row.role),['model_settings_pending']);
});
test('phone pending projection includes unpublished Macs, then the exact fingerprint; approval rejects a changed publication',async t=>{
 const f=fixture(t);
 const pending=()=>f.control.dispatch(phone,{operation:'model_settings_pending_macs'}) as Promise<{items:{device_id:string;key_sha256:string|null;public_x963_b64:string|null}[]}>;
 assert.equal((await pending()).items[0]!.key_sha256,null);await f.publish();
 const item=(await pending()).items[0]!;assert.equal(item.public_x963_b64,f.macKey.public_x963_b64);
 assert.equal(item.key_sha256,createHash('sha256').update(Buffer.from(f.macKey.public_x963_b64,'base64')).digest('hex'));
 await assert.rejects(f.control.dispatch(mac,{operation:'model_settings_pending_macs'}),/PAYMENT_SETTINGS_DEVICE_REQUIRED/);
 const draft=await f.control.dispatch(phone,{operation:'model_settings_draft',request:{action:'authorize_mac',expected_revision:0,device_id:'mac',public_x963_b64:item.public_x963_b64}}) as Record<string,unknown>;
 const signed=await f.execute(phone,f.user,draft),replacement=pair();
 await f.control.dispatch(mac,await f.publishInput(mac,replacement));
 await assert.rejects(f.control.dispatch(phone,signed),/MODEL_SETTINGS_MAC_KEY_CHANGED/);assert.equal(f.authority.read().desired,0);
});


for(const scenario of ['restore','published','superseded','race'] as const)test(`I2 durable Mac rotation reconciles target generation after outer COMMIT failure: ${scenario}`,async t=>{
  const f=fixture(t,true),keyA=f.macKey,keyB=pair(),keyC=pair();
  const authorize=async(key:ReturnType<typeof pair>,expected_revision:number)=>{
    await f.control.dispatch(mac,await f.publishInput(mac,key));
    const draft=await f.control.dispatch(phone,{operation:'model_settings_draft',request:{action:'authorize_mac',expected_revision,
      device_id:mac.device_id,public_x963_b64:key.public_x963_b64}}) as Record<string,unknown>;
    return f.execute(phone,f.user,draft);
  };
  await f.control.dispatch(phone,await authorize(keyA,0));
  assert.equal(f.keys.registered(mac,'model_settings')?.public_x963_b64,keyA.public_x963_b64);
  const rotation=await authorize(keyB,1);
  // This constraint is deferred until the real outer Payment DB COMMIT. The settings DB commits independently first.
  f.store.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TEMP TABLE i2_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE i2_commit_child(parent INTEGER REFERENCES i2_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER i2_fail_outer_commit AFTER UPDATE ON device_keys WHEN NEW.role='model_settings'
      BEGIN INSERT INTO i2_commit_child VALUES(1); END;`);
  await assert.rejects(f.control.dispatch(phone,rotation),/FOREIGN KEY constraint failed/);
  assert.equal(f.store.db.isTransaction,false);
  assert.equal(f.authority.read().desired,2,'the separate settings DB durably committed B approval');
  assert.equal(f.keys.registered(mac,'model_settings')?.public_x963_b64,keyA.public_x963_b64,'Payment COMMIT rolled back to A');
  f.reopen();
  assert.equal(f.authority.read().desired,2);assert.equal(f.keys.registered(mac,'model_settings')?.public_x963_b64,keyA.public_x963_b64);
  if(scenario==='superseded'||scenario==='race'){
    const later=await authorize(keyC,2);
    if(scenario==='superseded'){await f.control.dispatch(phone,later);f.reopen();}
    else f.setKeyRevalidate(async source=>{
      if(source.device_id===mac.device_id){f.setKeyRevalidate(undefined);await f.control.dispatch(phone,later);}
    });
    await assert.rejects(f.control.dispatch(phone,rotation),/MODEL_SETTINGS_MAC_AUTHORIZATION_SUPERSEDED/);
    assert.equal(f.keys.registered(mac,'model_settings')?.public_x963_b64,keyC.public_x963_b64);
    assert.equal(f.authority.read().desired,3);
  }else{
    if(scenario==='published')await f.control.dispatch(mac,await f.publishInput(mac,keyC));
    await f.control.dispatch(phone,rotation);
    assert.equal(f.keys.registered(mac,'model_settings')?.public_x963_b64,keyB.public_x963_b64,'existing A cannot satisfy cached approval for B');
    if(scenario==='published')assert.equal(f.keys.pendingModelSettings(mac)?.public_x963_b64,keyC.public_x963_b64,'unapproved C stays pending');
    const draft=await f.control.dispatch(mac,{operation:'model_settings_draft',request:{action:'resume',expected_revision:2}}) as Record<string,unknown>;
    await f.control.dispatch(mac,await f.execute(mac,keyB,draft));
    assert.equal(f.authority.read().desired,3,'the approved target B can actually sign');
    await f.control.dispatch(phone,rotation);assert.equal(f.authority.read().desired,3,'exact replay does not repeat the authority mutation');
  }
});
