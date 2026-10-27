import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry,encodeEmbedding} from '../src/voiceprint/registry.ts';

const model={id:'adaptive-synthetic',sha256:'d'.repeat(64),dim:32},at='2026-10-21T00:00:00.000Z';
const axis=(score=1,slot=1)=>Float32Array.from({length:32},(_,i)=>i===0?score:i===slot?Math.sqrt(1-score*score):0);
const samples=(n:number,score=1)=>Array.from({length:n},(_,i)=>({embedding:axis(score,i+1),speech_ms:2000}));
const identify=(mode:'verify'|'payment'|'call'='verify',channel:'file'|'mac'|'call'='file',learning=false)=>
  ({mode,channel,speech_ms:2000,observed_at:at,...(!learning?{learning:false as const}:{})});
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'paios-adaptive-')),storage=new PosixStorage(root),opened:VoiceprintRegistry[]=[];
  const open=(options:ConstructorParameters<typeof VoiceprintRegistry>[2]={})=>{const r=new VoiceprintRegistry(storage,model,options);opened.push(r);return r;};
  t.after(async()=>{for(const r of opened)await r.close();await storage.close();await rm(root,{recursive:true,force:true});});
  const registry=open();
  const enroll=(n:number,channel:'file'|'mac'='file',mode:'replace'|'add'='add',score=1)=>registry.enrollOwner({speaker_model:model,channel,mode,samples:samples(n,score),at});
  const line=async(r=registry,channel='file')=>(await r.owner()).channels.find(c=>c.channel===channel)!.verified_threshold;
  const document=async()=>{const [key]=await storage.list('voiceprints');return {key:key!,doc:JSON.parse(Buffer.from(await storage.read('voiceprints',key!)).toString())};};
  return {registry,storage,open,enroll,line,document};
}

test('confirmed samples raise only after eight samples, gradually to the ceiling; verification alone never raises',async t=>{
  const f=await fixture(t);await f.enroll(5);assert.equal(await f.line(),.65);
  await f.enroll(2);assert.equal(await f.line(),.65);
  await f.enroll(1);assert.equal(await f.line(),.6525);
  await f.enroll(1);assert.equal(await f.line(),.655);
  await f.enroll(11);assert.equal(await f.line(),.68);
  for(let i=0;i<3;i++)await f.registry.identify(axis(),identify());
  assert.equal(await f.line(),.68);
  const diagnostics=await f.registry.diagnostics();assert.equal(diagnostics.sets[0]!.verified_threshold,.68);
});

test('rotation/re-enrollment, restart and lower policy reload retain the durable high watermark',async t=>{
  const f=await fixture(t);await f.enroll(20);await f.registry.close();
  const strict=f.open({policy:{thresholds:{owner_verified:.7}}});assert.equal(await f.line(strict),.7);await strict.close();
  const reopened=f.open({policy:{thresholds:{owner_verified:.65}}});assert.equal(await f.line(reopened),.7);
  await reopened.enrollOwner({speaker_model:model,channel:'file',mode:'replace',samples:samples(5),at});
  assert.equal(await f.line(reopened),.7);
  await reopened.enrollOwner({speaker_model:model,channel:'file',mode:'replace',purpose:'conversation',samples:samples(5),at});
  assert.equal((await reopened.owner('file',true)).channels[0]!.verified_threshold,.7);
  const {doc}=await f.document();assert.equal(doc.owner_sets[0].verified_threshold,.7);
});

test('legacy v1 migration starts at the floor without recalibrating on load and preserves a stored line',async t=>{
  const f=await fixture(t);await f.enroll(20);await f.registry.close();
  const {key,doc}=await f.document(),{channel:_channel,verified_threshold:_line,...owner}=doc.owner_sets[0];
  await f.storage.replace('voiceprints',key,Buffer.from(JSON.stringify({schema:'paios.voiceprint.registry.v1',revision:1,next_number:1,owner,clusters:[]})));
  const legacy=f.open();assert.equal(await f.line(legacy),.65);await legacy.close();
  const migrated=await f.document();migrated.doc.owner.verified_threshold=.675;
  await f.storage.replace('voiceprints',key,Buffer.from(JSON.stringify(migrated.doc)));
  assert.equal(await f.line(f.open()),.675);
  assert.throws(()=>f.open({policy:{thresholds:{owner_verified:.64}}}),/VOICEPRINT_THRESHOLDS_INVALID/);
});

test('channels are independent and a low-consistency call chain remains at the floor',async t=>{
  const f=await fixture(t);await f.enroll(20);await f.enroll(5,'mac');
  assert.equal(await f.line(),.68);assert.equal(await f.line(f.registry,'mac'),.65);
  await f.registry.close();const {key,doc}=await f.document(),base=doc.owner_sets[0];
  const low=samples(8,.7),sum=Float32Array.from({length:32},(_,i)=>low.reduce((n,s)=>n+s.embedding[i]!,0)),norm=Math.hypot(...sum);
  doc.call_owner={channel:'call',model,samples:low.map((s,i)=>({embedding:encodeEmbedding(s.embedding),speech_ms:2000,added_at:new Date(Date.parse(at)+i*2000).toISOString()})),
    centroid:encodeEmbedding(Float32Array.from(sum,v=>v/norm)),consistency:{min:.65,mean:.65},enrolled_at:at,updated_at:at,provenance:'biometric_confirmed',
    source_sets:doc.owner_sets.map((s:any)=>`${s.channel}:${s.model.sha256}:${s.enrolled_at}:${s.updated_at}:${s.centroid}`).join('|')};
  await f.storage.replace('voiceprints',key,Buffer.from(JSON.stringify(doc)));
  const r=f.open();assert.equal(await f.line(r,'call'),.65);
  assert.equal((await r.confirmCallOwner(axis(.7,9),{speaker_model:model,speech_ms:2000,observed_at:new Date(Date.parse(at)+18000).toISOString()})).accepted,true);
  assert.equal(await f.line(r,'call'),.65);assert.equal(await f.line(r,'file'),.68);
});

test('payment, independent learning and calibrated verification cannot bypass a channel line; anchor and enrollment retain .65',async t=>{
  const f=await fixture(t);await f.enroll(20);const probe=axis(.66);
  for(const mode of ['verify','payment','call'] as const)assert.equal((await f.registry.identify(probe,identify(mode)) as {band?:string}).band,'uncertain');
  const calibrated=f.open({scoring:{calibration:{file:{verified:.5,uncertain:.45}}}});
  assert.equal((await calibrated.identify(probe,identify()) as {band?:string}).band,'uncertain');
  assert.equal(f.registry.matchCallAnchor(probe,{anchor:axis(),speech_ms:200}).kind,'owner');
  assert.equal(await f.registry.admitConversation('file',probe,[axis()]),true,'candidate enrollment matching retains its own .65 rule');
  assert.equal(await f.registry.admitConversation('file',probe,[]),false,'an existing baseline uses the channel verified line');
  await f.registry.identify(axis(),identify('call','call',true));
  const before=(await f.registry.owner('call')).samples;
  await f.registry.identify(axis(),{...identify('verify','call',true),request:{embedding:probe,speech_ms:2000}});
  assert.equal((await f.registry.owner('call')).samples,before,'uncertain standalone requests cannot seed independent evidence');
});

test('trust-window confirmation keeps replies and trusted centroid learning, but learned decisions use the channel line',async t=>{
  const f=await fixture(t);await f.enroll(20);const scope={principal_id:'owner',device_id:'phone'};
  const now=Date.now();f.registry.openTrustWindow(scope,{channel:'file',at:new Date(now-2000).toISOString()});
  const trusted=await f.registry.identify(axis(.66),{...identify(),...scope,observed_at:new Date(now).toISOString()});
  assert.equal(trusted.kind==='owner'&&trusted.trust_window,true);
  assert.equal(await f.line(),.68);
  assert.equal(f.registry.policy.thresholds.call_anchor,.65);assert.equal(f.registry.policy.thresholds.trusted_centroid,.65);
  assert.equal(f.registry.policy.thresholds.enroll_match,.65);assert.equal(f.registry.policy.thresholds.cluster,.65);
  assert.equal(f.registry.policy.thresholds.enroll_consistency,.6);assert.equal(f.registry.policy.thresholds.owner_uncertain,.45);
  for(const key of ['call_anchor','trusted_centroid','enroll_match'] as const)
    assert.throws(()=>f.open({policy:{thresholds:{[key]:.64}}}),/VOICEPRINT_THRESHOLDS_INVALID/);
});

test('each reference must pass its own channel line even when another channel has the highest score',async t=>{
  const f=await fixture(t);await f.enroll(20);
  const mac=Float32Array.from({length:32},(_,i)=>Number(i===1));
  await f.registry.enrollOwner({speaker_model:model,channel:'mac',mode:'replace',samples:Array.from({length:5},()=>({embedding:mac,speech_ms:2000})),at});
  const probe=new Float32Array(32);probe[0]=.67;probe[1]=.66;probe[2]=Math.sqrt(1-.67**2-.66**2);
  assert.equal((await f.registry.identify(probe,identify('payment')) as {band?:string}).band,'verified');
  probe[1]=.6;probe[2]=Math.sqrt(1-.67**2-.6**2);
  assert.equal((await f.registry.identify(probe,identify('payment')) as {band?:string}).band,'uncertain');
});

test('another confirmed set on the same channel constrains a rise so its weaker genuine samples keep passing',async t=>{
  const f=await fixture(t);await f.enroll(5);
  await f.registry.enrollOwner({speaker_model:model,channel:'file',mode:'replace',purpose:'conversation',samples:samples(5,.7),at});
  await f.enroll(15);assert.equal(await f.line(),.65);
  assert.equal((await f.registry.owner('file',true)).channels[0]!.verified_threshold,.65);
});

test('stale derived evidence and its replacement after reenrollment retain the channel watermark on disk',async t=>{
  const f=await fixture(t);await f.enroll(5);
  for(let i=0;i<8;i++){
    const e=axis();e[i+1]=.001;
    await f.registry.identify(e,{...identify('call','call',true),observed_at:new Date(Date.parse(at)+i*2000).toISOString()});
  }
  assert.equal(await f.line(f.registry,'call'),.6525);
  const replacement=Float32Array.from({length:32},(_,i)=>Number(i===20));
  await f.registry.enrollOwner({speaker_model:model,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:replacement,speech_ms:2000})),at});
  assert.equal((await f.registry.owner('call')).reenrollment_required,true);
  assert.equal((await f.registry.status() as {verified_thresholds:Record<string,number>}).verified_thresholds.call,.6525);
  await f.registry.close();const reopened=f.open();assert.equal(await f.line(reopened,'call'),.6525);
  assert.equal((await reopened.confirmCallOwner(replacement,{speaker_model:model,speech_ms:2000,observed_at:new Date(Date.parse(at)+20000).toISOString()})).accepted,true);
  assert.equal(await f.line(reopened,'call'),.6525);
  await reopened.close();assert.equal((await f.document()).doc.call_owner.verified_threshold,.6525);
});
