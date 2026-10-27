import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Timeline} from '../src/timeline.ts';
import {AmbientJournal} from '../src/ambient/journal.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputAuthority} from '../src/output.ts';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun} from './native-source-fixture.ts';
import {MAC_CAPABILITIES} from '../src/source-authority.ts';
import {EVENT_SCHEMA,sha256,digest} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';
import {buildCallContext} from '../src/call-context.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
import {fileURLToPath} from 'node:url';

async function directory(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'paios-timeline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const unreachable=async()=>{throw Error('NO_ADMISSION');},noAdmission={readOnly:async()=>undefined};
const item=(principal:string,id:string,at_ms:number)=>({principal_id:principal,item_id:id,kind:'owner' as const,via:'text' as const,text:id,at_ms});

test('sensing observations stay in call context and never occupy owner chat pages',async t=>{
  const root=await directory(t),now=Date.now(),store=new Timeline({directory:join(root,'timeline')},new PosixStorage(root),unreachable,noAdmission);
  t.after(()=>store.close());
  const source={principal_id:'owner',device_id:'glasses',device_type:'glasses'} as RegisteredDevice;
  store.append(item('owner','before',now));
  store.heard(source,[{burst_id:'cough',device_id:'glasses',speaker:null,event:'cough',start_ms:now,end_ms:now,count:1}],
    [{processed_event_id:'d:emotion',segment_index:0,speaker:'owner',text:'你看到了吗',emotion:'angry',start_ms:now}] as Parameters<Timeline['heard']>[2]);
  store.observation(source,'health',now,'手表检测到可能摔倒');
  store.append({...item('owner','detached',now),kind:'notice',text:'我接着处理',via:'text'});
  store.append(item('owner','after',now));
  const expected=['手表检测到可能摔倒','主人语气分类候选：angry；你看到了吗','声音分类候选：cough；记录1段，不代表次数或诊断；发声人未识别'];
  assert.deepEqual(store.observations('owner').map(line=>line.text),expected);
  for(const request of [{},{after_seq:1},{before_seq:store.head('owner')+1}])
    assert.deepEqual(store.page('owner',request).items.map(value=>value.item_id),request.after_seq?['detached','after']:['before','detached','after']);
  const page=store.page('owner',{after_seq:1,limit:1});
  assert.deepEqual(page.items.map(value=>value.item_id),['detached']);assert.equal(page.has_more,true);
  assert.deepEqual(store.page('owner',{after_seq:page.items[0]!.seq,limit:1}).items.map(value=>value.item_id),['after']);
  const context=await buildCallContext({now:()=>now,sessionOwner:async()=>undefined,observations:principal=>store.observations(principal)},
    {principal_id:'owner',session:'call'});
  for(const text of expected)assert.ok(context.includes(text),context);
  assert.deepEqual(store.observations('other'),[]);
});

test('erasing one source revokes shared sound aggregates and its emotion without erasing retained sources',async t=>{
  const root=await directory(t),now=Date.now(),storage=new PosixStorage(root);
  const store=new Timeline({directory:join(root,'timeline')},storage,unreachable,noAdmission),journal=AmbientJournal.open(join(root,'journal'));
  t.after(async()=>{await store.close();journal.close();});
  const device={principal_id:'owner',device_id:'glasses',device_type:'glasses'} as RegisteredDevice;
  const source=(n:number)=>({principal_id:'owner',device_id:'glasses',processed_event_id:`d:${n}`,segment_id:`s:${n}`,
    raw_ref:`l5:${String(n).repeat(64)}`,archive_revision:'a'.repeat(64)});
  const utterance=(n:number)=>({segment_index:0,start_ms:now+n*1000,end_ms:now+n*1000+300,speaker:'owner',score:0.9,
    text:`录音${n}`,lang:null,wake:null,wake_cut_ms:null,event:'cough' as const,emotion:'sad' as const});
  const first=journal.append(source(1),[utterance(1)]),firstBurst=journal.bursts('owner','d:1');
  store.heard(device,firstBurst,first);
  const kept=journal.append(source(2),[utterance(2)]),sharedBurst=journal.bursts('owner','d:2');
  assert.equal(sharedBurst[0]!.count,2);assert.equal(sharedBurst[0]!.burst_id,firstBurst[0]!.burst_id);
  store.heard(device,sharedBurst,kept);
  store.observation(device,'health',now,'保留独立健康提示');
  const head=store.head('owner'),projections=journal.projectionSources('owner',[source(1).raw_ref]);
  assert.deepEqual(journal.projectionSources('other',[source(1).raw_ref]),[]);
  assert.equal(store.removeHeard('owner',projections),3);
  assert.equal(journal.eraseSources('owner',[source(1).raw_ref]),1);
  const expected=store.observations('owner');
  assert.deepEqual(expected.map(row=>row.text),['主人语气分类候选：sad；录音2','保留独立健康提示']);
  assert.equal(store.page('owner',{after_seq:head}).removals!.flatMap(row=>row.removed_seqs).length,3);
  assert.deepEqual(journal.entriesOf('owner','d:1'),[]);assert.deepEqual(journal.entriesOf('owner','d:2'),kept);
  assert.equal(journal.bursts('owner','d:2')[0]!.count,1);
  assert.equal(store.removeHeard('owner',projections),0);
  store.heard(device,firstBurst,first);
  assert.deepEqual(store.observations('owner'),expected);
});

test('upgrade retracts cached observation seqs without deleting context, replay keys or owner notices',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),path=join(root,'timeline'),options={directory:path};let store=new Timeline(options,storage,unreachable,noAdmission);
  const now=Date.now(),seqs:number[]=[];
  for(let n=0;n<105;n++)seqs.push(store.append({...item('owner',`observation:legacy-${n}`,now),kind:'notice',via:'ambient',processed_event_id:'d:legacy'})!.seq);
  const visible=store.append({...item('owner','dispatch-owner',now),kind:'notice'})!,head=store.head('owner');
  const foreign=store.append({...item('other','observation:foreign',now),kind:'notice',via:'ambient'})!;
  await store.close();
  // Simulate the production v2 store before the visibility upgrade.
  const db=new DatabaseSync(join(path,'timeline.sqlite'));db.prepare("DELETE FROM meta WHERE key='observations-context-only'").run();db.close();
  store=new Timeline(options,storage,unreachable,noAdmission);
  const page=store.page('owner',{after_seq:head});
  assert.deepEqual(page.items,[]);assert.deepEqual(page.removals?.flatMap(value=>value.removed_seqs),seqs);
  assert.ok(page.removals!.every(value=>value.seq>head&&value.removed_seqs.length<=100));
  assert.deepEqual(store.page('owner').items,[visible]);assert.equal(store.observations('owner').length,32);
  assert.deepEqual(store.page('other',{after_seq:foreign.seq}).removals?.flatMap(value=>value.removed_seqs),[foreign.seq]);
  assert.equal(store.append({...item('owner','observation:legacy-0',now),kind:'notice',via:'ambient'}),undefined);
  const migrated=store.head('owner');await store.close();store=new Timeline(options,storage,unreachable,noAdmission);
  t.after(()=>store.close());assert.equal(store.head('owner'),migrated);
  assert.equal(store.remove('owner',['d:legacy']),105);assert.deepEqual(store.observations('owner'),[]);
  assert.deepEqual(store.page('owner').items,[visible]);
});

test('expired observation retractions use the existing reset protocol for an offline cache',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),path=join(root,'timeline');let now=Date.now();
  const options={directory:path,now:()=>now,retention_days:1};let store=new Timeline(options,storage,unreachable,noAdmission);
  store.append({...item('owner','observation:old',now),kind:'notice',via:'ambient'});const cached=store.head('owner');await store.close();
  const db=new DatabaseSync(join(path,'timeline.sqlite'));db.prepare("DELETE FROM meta WHERE key='observations-context-only'").run();db.close();
  store=new Timeline(options,storage,unreachable,noAdmission);t.after(()=>store.close());
  now+=2*86400_000;store.purge();
  assert.equal(store.page('owner',{after_seq:cached}).reset,true);assert.deepEqual(store.page('owner').items,[]);
});

test('C2.2 timeline is owner-only WAL/FULL, write-once, persistent and refuses schema tag drift',async t=>{
  const root=await directory(t),path=join(root,'timeline'),storage=new PosixStorage(root);
  const store=new Timeline({directory:path},storage,unreachable,noAdmission),now=Date.now();
  store.append(item('owner','me-one',now));store.append({...item('owner','me-one',now+1),text:'must not replace'});
  store.append(item('other','me-one',now));assert.deepEqual(store.page('owner').items.map(value=>value.text),['me-one']);
  assert.equal((await fs.stat(path)).mode&0o777,0o700);assert.equal((await fs.stat(join(path,'timeline.sqlite'))).mode&0o777,0o600);
  await store.close();
  const reopened=new Timeline({directory:path},storage,unreachable,noAdmission);assert.equal(reopened.page('owner').items.length,1);await reopened.close();
  const db=new DatabaseSync(join(path,'timeline.sqlite'));
  assert.equal((db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode,'wal');
  assert.equal((db.prepare('PRAGMA synchronous').get() as {synchronous:number}).synchronous,2);
  db.prepare("UPDATE meta SET value='unsupported' WHERE key='schema'").run();db.close();
  assert.throws(()=>new Timeline({directory:path},storage,unreachable,noAdmission),/TIMELINE_STORE_SCHEMA_UNSUPPORTED/);
});

test('C8.5 purge applies age and count per principal without deleting another principal history',async t=>{
  const root=await directory(t),now=10*86400_000,store=new Timeline({directory:join(root,'timeline'),now:()=>now,retention_days:2,max_items:2},new PosixStorage(root),unreachable,noAdmission);
  t.after(()=>store.close());
  store.append(item('one','old',now-3*86400_000));
  for(const principal of ['one','two'])for(let i=0;i<3;i++)store.append(item(principal,`${principal}-${i}`,now-100+i));
  assert.equal(store.purge(),3);
  for(const principal of ['one','two'])assert.deepEqual(store.page(principal).items.map(value=>value.item_id),[`${principal}-1`,`${principal}-2`]);
});

test('C2.2 online checkpoint and staging archive include timeline conversation data without a store allowlist',async t=>{
  const root=await directory(t),source=join(root,'owner-data'),store=new Timeline({directory:join(source,'central-storage/timeline')},new PosixStorage(source),unreachable,noAdmission);
  t.after(()=>store.close());store.append(item('owner','me-backup',Date.now()));
  const script=`import importlib.util,sys,sqlite3,tarfile,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('migration',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source=Path(sys.argv[2]);root=Path(sys.argv[3]);relative='central-storage/timeline/timeline.sqlite'
for mode,omitted in [('online',m.ONLINE_PRIVATE_PATHS),('staging',m.VISUAL_PRIVATE_PATHS)]:
    archive=root/(mode+'.tar.gz')
    with archive.open('wb') as output:
        if mode=='online': m.archive_online(source,output,omitted)
        else: subprocess.run(['tar','-czf','-','-C',str(source)]+['--exclude=./'+path for path in omitted]+['.'],stdout=output,check=True)
    target=root/mode;target.mkdir()
    with tarfile.open(archive) as bundle:
        assert any(member.name.removeprefix('./')==relative for member in bundle)
        subprocess.run(['tar','-xf',str(archive),'-C',str(target)],check=True)
    with sqlite3.connect(target/relative) as db:
        assert db.execute('SELECT item_id FROM items WHERE principal_id=?',('owner',)).fetchall()==[('me-backup',)]
print('online and staging timeline restore passed')`;
  const result=await promisify(execFile)(process.env.PAIOS_HERMES_PYTHON??'python3',['-c',script,fileURLToPath(new URL('../../../../../deploy/cloud/migrate.py',import.meta.url)),source,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.match(result.stdout,/online and staging timeline restore passed/);
});

test('C8.3 cursor pages preserve chronology, catch disconnects and repair a missed live item',async t=>{
  const root=await directory(t),store=new Timeline({directory:join(root,'timeline')},new PosixStorage(root),unreachable,noAdmission);t.after(()=>store.close());
  for(let i=1;i<=6;i++)store.append(item('owner',`me-${i}`,Date.now()));
  const ids=(page:ReturnType<Timeline['page']>)=>page.items.map(value=>value.item_id);
  assert.deepEqual(ids(store.page('owner',{limit:2})),['me-5','me-6']);assert.equal(store.page('owner',{limit:2}).has_more,true);
  const second=store.page('owner',{after_seq:2,limit:2});assert.deepEqual(ids(second),['me-3','me-4']);assert.equal(second.head_seq,6);assert.equal(second.has_more,true);
  assert.deepEqual(ids(store.page('owner',{before_seq:5,limit:2})),['me-3','me-4']);
  assert.deepEqual(ids(store.page('owner',{after_seq:4})),['me-5','me-6']);assert.equal(store.page('other').head_seq,0);
  const live:number[]=[],sent=Promise.withResolvers<void>();
  const stop=store.watch('owner',()=>{live.push(store.head('owner'));sent.resolve();});
  store.append(item('owner','me-7',Date.now()));await sent.promise;stop();
  store.append(item('owner','me-8',Date.now()));store.append(item('owner','me-9',Date.now()));
  assert.deepEqual(live,[7]);assert.deepEqual(ids(store.page('owner',{after_seq:7})),['me-8','me-9']);
  assert.equal(store.page('owner',{after_seq:9}).has_more,false);
});

test('C10.3 queue caps and TTL are principal-scoped; expiry writes one durable notice',async t=>{
  const root=await directory(t);let now=Date.now();const storage=new PosixStorage(root),options={directory:join(root,'timeline'),now:()=>now};
  const store=new Timeline(options,storage,unreachable,noAdmission),rows=[];
  for(let i=0;i<8;i++)rows.push(store.queue('owner','d:origin',{action:'add',task:`task-${i}`,expires_in_minutes:1},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:`fixture-add-1-${i}`}) as {queue_id:string});
  assert.throws(()=>store.queue('owner','d:origin',{action:'add',task:'ninth'},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-2'}),/DESKTOP_QUEUE_FULL/);
  assert.throws(()=>store.queue('other','d:origin',{action:'add',task:'too long',expires_in_minutes:1441},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-3'}),/DESKTOP_QUEUE_TTL_INVALID/);
  const foreign=store.queue('other','d:origin',{action:'add',task:'foreign'},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-4'}) as {queue_id:string;created_at_ms:number;expires_at_ms:number};
  assert.equal(foreign.expires_at_ms-foreign.created_at_ms,720*60_000);
  assert.equal((store.queue('other','d:origin',{action:'cancel',queue_id:rows[0]!.queue_id}) as {cancelled:boolean}).cancelled,false);
  assert.equal((store.queue('owner','d:origin',{action:'cancel',queue_id:rows[0]!.queue_id}) as {cancelled:boolean}).cancelled,true);
  now+=60_001;assert.deepEqual(store.queue('owner','d:origin',{action:'list'}),{items:[]});
  const notices=store.page('owner').items;assert.equal(notices.length,7);assert.equal(notices[0]!.item_id,`notice-${rows[1]!.queue_id}`);
  assert.equal(notices[0]!.text,'排队的事已过期：task-1');assert.equal(notices[0]!.via,'queue');assert.equal(store.page('other').items.length,0);
  await store.close();const reopened=new Timeline(options,storage,unreachable,noAdmission);t.after(()=>reopened.close());assert.equal(reopened.page('owner').items.length,7);
});

test('C10.3 real admission runs each queued entry once across concurrent ready, interrupted handoff and restart',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),runs=new Map<string,NativeRun>(),keys=new Set<string>(),created: string[]=[];
  const native={create:async(body:{session_id:string;input:string},key:string)=>{
    assert.equal(keys.has(key),false,'existing admission must absorb queue replay');keys.add(key);
    const d=JSON.parse(body.input);created.push(d.content.app_event?.queue_id??'owner-prompt');
    const run={run_id:`run-${keys.size}`,conversation_session_id:body.session_id,session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return {...run};
  },status:async(id:string)=>({...runs.get(id)!}),cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route-mac',output_modes:['text'],token_sha256:sha256('mac')},
    {principal_id:'owner',device_id:'mac-two',device_type:'mac' as const,capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route-two',output_modes:['text'],token_sha256:sha256('mac-two')},
    {principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'text',consent_ref:'consent',route_version:'route-phone',output_modes:['text'],token_sha256:sha256('phone')}];
  const open=async()=>{const admission=new RunAdmission(storage,native,policy),runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),devices,skill:'fixed',max_read_bytes:8192});
    await runtime.configureTimeline({directory:join(root,'timeline')});return {runtime,admission};};
  let {runtime,admission}=await open();t.after(()=>runtime.close());
  const phone=await runtime.authenticate('phone'),source=await runtime.authenticate('mac');
  const accepted=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'queue-owner',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('when online do this')},phone,'owner-session',true);
  const first=Promise.withResolvers<void>(),bindingDeadline=Date.now()+5000;
  while(!accepted.admission.run_id){assert.ok(Date.now()<bindingDeadline,'owner run did not bind');const state=await runtime.event(phone,'owner-session',accepted.processed_event.processed_event_id);if(state.admission.run_id){accepted.admission=state.admission;break;}await new Promise(resolve=>setTimeout(resolve,5));}
  const context={run_id:accepted.admission.run_id!,session_id:'owner-session',tool_call_id:'queue-add'};
  const queued=await runtime.tool('paios_desktop_queue',{context,args:{action:'add',task:'sort invoices'}}) as {queue_id:string};
  const saved=storage.publish.bind(storage);let inject=true;
  storage.publish=async(namespace,key,bytes)=>{const result=await saved(namespace,key,bytes);if(inject&&namespace==='admissions'){
    const record=JSON.parse(Buffer.from(bytes).toString());if(record.session_id.startsWith('desktop-queue:')){inject=false;first.resolve();throw Error('crash after durable admission');}}
    return result;};
  await assert.rejects(runtime.desktopReady(source),/crash after durable admission/);await first.promise;await runtime.close();storage.publish=saved;
  ({runtime,admission}=await open());await admission.recover();
  await Promise.all([runtime.desktopReady(await runtime.authenticate('mac-two')),runtime.desktopReady(await runtime.authenticate('mac'))]);
  const deadline=Date.now()+3000;while(created.filter(id=>id===queued.queue_id).length<1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(created.filter(id=>id===queued.queue_id).length,1);
  assert.deepEqual(runtime.timeline!.queue('owner','unused',{action:'list'}),{items:[]});
  await runtime.desktopReady(await runtime.authenticate('mac-two'));assert.equal(created.filter(id=>id===queued.queue_id).length,1);
  await assert.rejects(runtime.desktopReady(await runtime.authenticate('phone')),/DESKTOP_DEVICE_REQUIRED/);
  const duringShutdown=runtime.timeline!.queue('owner','origin',{action:'add',task:'finish accepted handoff before shutdown'},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-5'}) as {queue_id:string};
  const writing=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  storage.publish=async(namespace,key,bytes)=>{
    const result=await saved(namespace,key,bytes);
    if(namespace==='processed-events'&&JSON.parse(Buffer.from(bytes).toString()).content.app_event?.queue_id===duringShutdown.queue_id){writing.resolve();await release.promise;}
    return result;
  };
  const handingOff=runtime.desktopReady(await runtime.authenticate('mac'));await writing.promise;
  const closing=runtime.close();release.resolve();
  const settled=await Promise.allSettled([handingOff,closing]);storage.publish=saved;
  assert.deepEqual(settled.map(result=>result.status),['fulfilled','fulfilled'],'shutdown joins accepted queue submission before closing admission');
  ({runtime,admission}=await open());await admission.recover();await runtime.desktopReady(await runtime.authenticate('mac-two'));
  await runtime.desktopReady(await runtime.authenticate('mac'));
  const records=await Promise.all((await storage.list('admissions')).map(async key=>JSON.parse(Buffer.from(await storage.read('admissions',key)).toString())));
  assert.equal(records.filter(record=>record.session_id===`desktop-queue:${digest(['owner',duringShutdown.queue_id])}`).length,1);
  assert.ok(created.filter(id=>id===duringShutdown.queue_id).length<=1,'the existing admission owner retains unknown-create recovery policy');
});

test('C10.3 a pre-admission interrupted handoff expires after restart instead of reviving past its TTL',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),ingress=new UnifiedIngress(new RawArchive(storage,8192));let now=Date.now(),submissions=0;
  const options={directory:join(root,'timeline'),now:()=>now},source={principal_id:'owner',device_id:'mac',device_type:'mac' as const,capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text']};
  const store=new Timeline(options,storage,async(raw,device,session)=>{
    submissions++;await store.input(await ingress.accept(raw,{...device,submission:'observation'}),session);
    throw Error('interrupted before durable admission');
  },{readOnly:async()=>{throw Error('admission evidence unavailable during interruption');}});
  const row=store.queue('owner','origin',{action:'add',task:'must expire',expires_in_minutes:1},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-6'}) as {queue_id:string};
  await assert.rejects(store.ready(source,async()=>source),/admission evidence unavailable/);await store.close();
  now+=60_001;
  const reopened=new Timeline(options,storage,async()=>{submissions++;},noAdmission);t.after(()=>reopened.close());await reopened.recover();
  await reopened.ready(source,async()=>source);
  assert.equal(submissions,1);assert.deepEqual(reopened.queue('owner','unused',{action:'list'}),{items:[]});
  assert.deepEqual(reopened.page('owner').items.map(item=>({id:item.item_id,text:item.text})),[{id:`notice-${row.queue_id}`,text:'排队的事已过期：must expire'}]);
});

test('C10.3 unresolved admission reserves queue capacity during concurrent add and failed handoff',async t=>{
  const root=await directory(t),started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const source={principal_id:'owner',device_id:'mac',device_type:'mac' as const,capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text']};
  const store=new Timeline({directory:join(root,'timeline')},new PosixStorage(root),async()=>{started.resolve();await finish.promise;throw Error('admission unavailable');},noAdmission);t.after(()=>store.close());
  for(let n=0;n<8;n++)store.queue('owner','origin',{action:'add',task:`task-${n}`},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:`fixture-add-7-${n}`});
  const work=store.ready(source,async()=>source);await started.promise;
  assert.throws(()=>store.queue('owner','origin',{action:'add',task:'ninth'},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-8'}),/DESKTOP_QUEUE_FULL/);
  finish.resolve();await assert.rejects(work,/admission unavailable/);
  assert.equal((store.queue('owner','origin',{action:'list'}) as {items:unknown[]}).items.length,8);
});


test('retained dedup keys survive purge and restart; immutable native replay time cannot renew old replies',async t=>{
  const root=await directory(t),storage=new PosixStorage(root);let now=Date.now();const start=now,options={directory:join(root,'timeline'),max_items:2,now:()=>now,replay_window_ms:1000};
  let store=new Timeline(options,storage,unreachable,noAdmission);
  for(const id of ['her-first','her-second','her-third'])store.append({...item('owner',id,start),source_at_ms:start});
  assert.equal(store.purge(),1);const head=store.head('owner');await store.close();
  store=new Timeline(options,storage,unreachable,noAdmission);
  assert.equal(store.append({...item('owner','her-first',++now),source_at_ms:start}),undefined);assert.equal(store.head('owner'),head);
  now+=2000;store.purge();await store.close();store=new Timeline(options,storage,unreachable,noAdmission);t.after(()=>store.close());
  assert.equal(store.append({...item('owner','her-first',now),source_at_ms:start}),undefined);assert.equal(store.head('owner'),head);
});

test('650 offline items recover in seven ordered bounded pages with principal isolation',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),options={directory:join(root,'timeline')};let store=new Timeline(options,storage,unreachable,noAdmission);t.after(()=>store.close());
  for(let n=1;n<=650;n++)store.append(item('owner',`item-${n}`,Date.now()));store.append(item('other','foreign',Date.now()));
  await store.close();store=new Timeline(options,storage,unreachable,noAdmission);
  let cursor=0,pages=0;const ids:string[]=[];
  for(;;){const page=store.page('owner',{after_seq:cursor});pages++;assert.ok(page.items.length<=100);ids.push(...page.items.map(row=>row.item_id));cursor=page.items.at(-1)!.seq;if(!page.has_more)break;}
  assert.equal(pages,7);assert.deepEqual(ids,Array.from({length:650},(_,n)=>`item-${n+1}`));assert.equal(store.page('other').items[0]!.item_id,'foreign');
});

test('v1 store upgrades atomically, preserves sequence and blocks unknowable pre-migration replay',async t=>{
  const root=await directory(t),storage=new PosixStorage(root),path=join(root,'timeline');let store=new Timeline({directory:path},storage,unreachable,noAdmission);
  const now=Date.now();store.append(item('owner','old',now));await store.close();
  const db=new DatabaseSync(join(path,'timeline.sqlite'));db.exec("DROP TABLE seen;DROP TABLE removals;DELETE FROM meta WHERE key<>'schema';UPDATE meta SET value='paios.timeline-store.v1' WHERE key='schema';");db.close();
  store=new Timeline({directory:path,now:()=>now+1000},storage,unreachable,noAdmission);t.after(()=>store.close());
  assert.equal(store.page('owner').items[0]!.seq,1);assert.equal(store.append(item('owner','unknown-purged',now)),undefined);
  assert.equal(store.append(item('owner','new',now+1001))!.seq,2);
});


test('in-window dedup saturation applies backpressure instead of evicting replay protection',async t=>{
  const root=await directory(t),path=join(root,'timeline');let now=Date.now();
  const store=new Timeline({directory:path,now:()=>now,replay_window_ms:1000},new PosixStorage(root),unreachable,noAdmission);t.after(()=>store.close());
  const db=new DatabaseSync(join(path,'timeline.sqlite'));
  db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO seen SELECT 'owner','synthetic-'||x,NULL,?,? FROM n").run(now,now);
  assert.throws(()=>store.append(item('owner','must-wait',now)),/TIMELINE_DEDUP_FULL/);assert.deepEqual(store.page('owner').items,[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen').get()!.n,100000);
  now+=1001;assert.ok(store.append(item('owner','after-window',now)));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen').get()!.n,1);db.close();
});

test('proactive delivery retries use immutable source time after purge, dedup compaction and restart',async t=>{
  const root=await directory(t),storage=new PosixStorage(root);let now=Date.now();const sourceAt=now,options={directory:join(root,'timeline'),now:()=>now,retention_days:1,replay_window_ms:1000};
  let store=new Timeline(options,storage,unreachable,noAdmission);store.outreach('owner','phone','scheduled-final','old final',sourceAt);
  now+=2*86400_000;assert.equal(store.purge(),1);const head=store.head('owner');await store.close();
  store=new Timeline(options,storage,unreachable,noAdmission);t.after(()=>store.close());
  store.outreach('owner','phone','scheduled-final','old final',sourceAt);
  assert.deepEqual(store.page('owner').items,[]);assert.equal(store.head('owner'),head);
});


test('A6.4 additive metadata migration preserves v2 history, sequence, restart and replay dedup',async t=>{
  const root=await directory(t),path=join(root,'timeline'),storage=new PosixStorage(root),now=Date.now();
  let store=new Timeline({directory:path},storage,unreachable,noAdmission);
  store.append(item('owner','before-attachments',now));await store.close();
  const db=new DatabaseSync(join(path,'timeline.sqlite'));
  db.exec('ALTER TABLE items DROP COLUMN attachments');db.close();
  store=new Timeline({directory:path},storage,unreachable,noAdmission);
  assert.equal(store.page('owner').items[0]!.seq,1);assert.equal(store.page('owner').items[0]!.attachments,undefined);
  const attachments=[{name:'发票.pdf',kind:'pdf' as const,size:1024}];
  assert.equal(store.append({...item('owner','with-attachments',now),attachments})!.seq,2);await store.close();
  store=new Timeline({directory:path},storage,unreachable,noAdmission);t.after(()=>store.close());
  assert.equal(store.append({...item('owner','with-attachments',now),attachments}),undefined);
  assert.deepEqual(store.page('owner',{after_seq:1}).items.map(row=>({seq:row.seq,attachments:row.attachments})),[{seq:2,attachments}]);
  assert.equal(store.head('owner'),2);assert.deepEqual(store.page('other').items,[]);
});
