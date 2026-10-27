import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {AdmissionHooks}=await import(process.env.PAIOS_ADMISSION_HOOKS_TEST_SOURCE??'../src/admission-hooks.ts');
import {PosixStorage} from '../src/storage.ts';

async function fixture(t:test.TestContext){
  const path=await mkdtemp(join(tmpdir(),'public-hooks-')),storage=new PosixStorage(path);
  t.after(()=>rm(path,{recursive:true,force:true}));
  return {storage,hooks:new AdmissionHooks(storage,'authenticated-owner-profile')};
}
const event=(hook:string,payload:object)=>({hook,payload});
const root=(session='session',turn='turn',task='root')=>({session_id:session,turn_id:turn,task_id:task});
const start=(depth:number,parent=root())=>event('subagent_start',{
  parent_session_id:parent.session_id,parent_turn_id:parent.turn_id,
  parent_subagent_id:parent.task_id==='root'?'':parent.task_id,
  child_session_id:`child-session-${depth}`,child_subagent_id:`child-${depth}`});

for(const depth of [1,2])test(`public child lineage authorizes exactly its original admission at depth ${depth}`,async t=>{
  const {hooks}=await fixture(t);
  await hooks.reserve('admission-a','session','immutable-input');
  await hooks.event(event('pre_llm_call',{...root(),user_message:'immutable-input'}));
  let ids=root();
  for(let i=1;i<=depth;i++){
    await hooks.event(start(i,ids));ids=root(`child-session-${i}`,`child-turn-${i}`,`child-${i}`);
    await hooks.event(event('pre_llm_call',{...ids,user_message:'delegated goal'}));
  }
  assert.equal(await hooks.resolve(ids,true),'admission-a');
  assert.equal(await hooks.resolve({...ids,session_id:'session'},true),'admission-a');
  await assert.rejects(hooks.resolve({...ids,task_id:'forged'},true),/BINDING_REQUIRED/);
});

test('concurrent reservations are matched by immutable input and never by active-run count',async t=>{
  const {hooks}=await fixture(t);
  await Promise.all([hooks.reserve('a','session-a','input-a'),hooks.reserve('b','session-b','input-b')]);
  await hooks.event(event('pre_llm_call',{...root('session-b','turn-b'),user_message:'input-b'}));
  await hooks.event(event('pre_llm_call',{...root('session-a','turn-a'),user_message:'input-a'}));
  assert.deepEqual(await Promise.all([hooks.resolve(root('session-a','turn-a')),hooks.resolve(root('session-b','turn-b'))]),['a','b']);
  await assert.rejects(hooks.resolve(root('session-a','unknown-turn'),true),/BINDING_REQUIRED/);
  await Promise.all([hooks.reserve('shared-a','shared','input-shared-a'),hooks.reserve('shared-b','shared','input-shared-b')]);
  await Promise.all(['a','b'].map(suffix=>hooks.event(event('pre_llm_call',{
    ...root('shared',`turn-shared-${suffix}`),user_message:`input-shared-${suffix}`}))));
  assert.deepEqual(await Promise.all(['a','b'].map(suffix=>hooks.resolve(root('shared',`turn-shared-${suffix}`),true))),['shared-a','shared-b']);
  await hooks.reserve('duplicate','session-a','input-a');
  assert.equal(await hooks.event(event('pre_llm_call',{...root('session-a','new-turn'),user_message:'input-a'})),undefined);
  await assert.rejects(hooks.resolve(root('session-a','new-turn'),true),/BINDING_REQUIRED/);
});

test('observer loss blocks effects; a matching public attempt can verify the root, but not a missing child edge',async t=>{
  const {hooks}=await fixture(t);await hooks.reserve('a','session','input');
  await assert.rejects(hooks.resolve(root(),true),/BINDING_REQUIRED/);
  await hooks.event(event('pre_api_request',{...root(),api_request_id:'opaque-attempt',user_message:'input'}));
  assert.equal(await hooks.resolve(root(),true),'a');
  const child=root('child-session','child-turn','child');
  await hooks.event(event('pre_llm_call',{...child,user_message:'goal'}));
  await assert.rejects(hooks.resolve(child,true),/BINDING_REQUIRED/);
});

test('compression aliases require a known turn; create acknowledgement confirms a rotated session',async t=>{
  const {hooks}=await fixture(t);await hooks.reserve('a','conversation','input');
  const ids=root('compressed-tip');
  assert.equal(await hooks.event(event('pre_llm_call',{...ids,user_message:'input'})),undefined);
  await assert.rejects(hooks.resolve(ids,true),/BINDING_REQUIRED/);
  await hooks.accepted('a','compressed-tip');assert.equal(await hooks.resolve(ids,true),'a');
  await hooks.event(event('pre_api_request',{...ids,session_id:'next-tip',user_message:'input'}));
  assert.equal(await hooks.resolve({...ids,session_id:'next-tip'},true),'a');
  await assert.rejects(hooks.resolve({...ids,session_id:'foreign'},true),/BINDING_REQUIRED/);
});

test('recovery retains original ownership; terminal and late evidence cannot authorize the next run',async t=>{
  const {hooks,storage}=await fixture(t);await hooks.reserve('old','session','old-input');
  await hooks.event(event('pre_llm_call',{...root(),user_message:'old-input'}));
  await hooks.event(event('on_session_end',root()));
  const restarted=new AdmissionHooks(storage,'authenticated-owner-profile');
  await restarted.reserve('new','session','new-input');
  await restarted.event(event('pre_llm_call',{...root('session','new-turn'),user_message:'new-input'}));
  await assert.rejects(restarted.resolve(root(),true),/TURN_ENDED/);
  assert.equal(await restarted.resolve(root()),'old');
  assert.equal(await restarted.resolve(root('session','new-turn'),true),'new');
  await assert.rejects(new AdmissionHooks(storage,'other-authenticated-profile').resolve(root()),/BINDING_REQUIRED/);
});

test('late child stop closes the child without transferring it to the next root',async t=>{
  const {hooks}=await fixture(t);await hooks.reserve('old','session','input');
  await hooks.event(event('pre_llm_call',{...root(),user_message:'input'}));await hooks.event(start(1));
  const child=root('child-session-1','child-turn','child-1');
  await hooks.event(event('pre_llm_call',{...child,user_message:'goal'}));
  await hooks.event(event('on_session_end',root()));await hooks.reserve('new','session','new-input');
  assert.equal(await hooks.event(event('subagent_stop',{parent_session_id:'session',parent_turn_id:'turn',
    child_session_id:'child-session-1',child_subagent_id:'child-1',child_status:'failed',duration_ms:100})),'old');
  await assert.rejects(hooks.resolve(child,true),/TURN_ENDED/);
});

test('system continuations join the original public history, never the next generation',async t=>{
  const {hooks}=await fixture(t);await hooks.reserve('old','session','original');
  await hooks.event(event('pre_llm_call',{...root(),user_message:'original'}));
  await hooks.event(event('on_session_end',root()));
  await hooks.reserve('new','session','next-original');
  const resumed=root('session','resumed-turn');
  await hooks.event(event('pre_llm_call',{...resumed,user_message:'child completion',conversation_history:[
    {role:'user',content:'original'},{role:'system',content:'child completion'}]}));
  assert.equal(await hooks.resolve(resumed),'old');
  const foreign=root('session','unregistered-turn');
  await hooks.event(event('pre_llm_call',{...foreign,user_message:'unregistered',conversation_history:[
    {role:'user',content:'original'},{role:'user',content:'unregistered'}]}));
  await assert.rejects(hooks.resolve(foreign),/BINDING_REQUIRED/);
});

test('evidence received before a reservation cannot acquire a future grant',async t=>{
  const {hooks}=await fixture(t);
  await hooks.event(event('pre_llm_call',{...root(),user_message:'future'}));
  await hooks.reserve('new','session','future');await hooks.accepted('new','session');
  await assert.rejects(hooks.resolve(root()),/BINDING_REQUIRED/);
  await hooks.reserve('old','old-session','repeated');
  await hooks.event(event('pre_llm_call',{...root('foreign-session','late'),user_message:'repeated'}));
  await hooks.reserve('later','foreign-session','repeated');await hooks.accepted('later','foreign-session');
  await assert.rejects(hooks.resolve(root('foreign-session','late')),/BINDING_REQUIRED/);
});

test('verified immutable evidence is published once across retries and repeated observers',async t=>{
  const {storage,hooks}=await fixture(t),publish=storage.publish.bind(storage);let writes=0;
  storage.publish=async(namespace,key,data)=>{if(namespace==='admission-hooks')writes++;return publish(namespace,key,data);};
  await hooks.reserve('a','session','input');await hooks.reserve('a','session','input');
  assert.equal(writes,1);
  await hooks.accepted('a','session');assert.equal(writes,1);
  await assert.rejects(hooks.reserve('a','session','different-input'),/BINDING_CONFLICT/);
  const first=event('pre_llm_call',{...root(),user_message:'input'});
  await hooks.event(first);const committed=writes;
  await hooks.event(first);await hooks.event(first);
  assert.equal(writes,committed+1); // The first repeat records its observed alias; later repeats reuse it.
  assert.equal(await hooks.resolve(root(),true),'a');
});
