import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {sha256} from '../src/contracts.ts';
import {speechSpans} from '../src/media/continuous-source.ts';
import {SherpaSileroStreamFactory} from '../src/media/silero-stream.ts';
import {NATIVE_WINDOW_SAMPLES} from '../src/voiceprint/contracts.ts';
import {LocalSpeechEngine,parseLocalSpeechConfig,recoveringEngine,type LocalSpeechConfig} from '../src/voiceprint/engine.ts';

const thread=new URL('./speech-thread-fake.ts',import.meta.url);
type Seen={kind:string;op?:string;length?:number;buffer_bytes?:number;keywords?:string|null;threshold?:number|null};
async function fixture(t:test.TestContext,timeout_ms=5000,kws=false) {
  const root=await fs.mkdtemp(join(tmpdir(),'paios-speech-engine-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=async(name:string)=>{await fs.writeFile(join(root,name),`controlled ${name}`);return {path:join(root,name),sha256:sha256(`controlled ${name}`)};};
  const config:LocalSpeechConfig={num_threads:1,timeout_ms,vad:{model:await file('vad.onnx')},asr:{model:await file('asr.onnx'),tokens:await file('tokens.txt')},
    speaker:{model:await file('speaker.onnx')},...(kws?{kws:parseLocalSpeechConfig({num_threads:1,timeout_ms,vad:{model:await file('vad.onnx')},
      asr:{model:await file('asr.onnx'),tokens:await file('tokens.txt')},speaker:{model:await file('speaker.onnx')},
      kws:{encoder:await file('enc.onnx'),decoder:await file('dec.onnx'),joiner:await file('join.onnx'),tokens:await file('kws-tokens.txt')}}).kws!}:{})};
  const seen:Seen[]=[],channel=new BroadcastChannel('paios-speech-fake');
  channel.onmessage=event=>seen.push((event as MessageEvent).data as Seen);t.after(()=>channel.close());
  const until=async(predicate:()=>boolean)=>{for(let n=0;n<1000&&!predicate();n++)await new Promise(r=>setTimeout(r,5));assert.ok(predicate());};
  const dispatched=()=>seen.filter(e=>e.kind==='dispatched').map(e=>`${e.op}${e.length===undefined?'':':'+e.length}`);
  return {root,config,seen,until,dispatched,file};
}
const held=(ms:number)=>new Float32Array(ms).fill(-1);
const plain=(n:number)=>new Float32Array(n).fill(0.25);

test('config parsing fills keyword defaults and rejects malformed pins, paths and keywords',()=>{
  const file={path:'/m/x.onnx',sha256:'a'.repeat(64)};
  const base={num_threads:2,timeout_ms:30000,vad:{model:file},asr:{model:file,tokens:file},speaker:{model:file}};
  const parsed=parseLocalSpeechConfig({...base,kws:{encoder:file,decoder:file,joiner:file,tokens:file}});
  assert.deepEqual(parsed.kws!.keywords,[{label:'依米',tokens:'y ī m ǐ'}]);assert.equal(parsed.kws!.score,2);assert.equal(parsed.kws!.threshold,0.15);
  const call_keywords=[{label:'停',tokens:'model-specific'}];
  assert.deepEqual(parseLocalSpeechConfig({...base,kws:{...parsed.kws,call_keywords}}).kws!.call_keywords,call_keywords);
  assert.equal(parseLocalSpeechConfig(base).kws,undefined);
  for(const bad of [{...base,num_threads:0},{...base,num_threads:5},{...base,timeout_ms:0},{...base,extra:true},
    {...base,vad:{model:{path:'relative.onnx',sha256:'a'.repeat(64)}}},{...base,asr:{model:file,tokens:{path:'/t',sha256:'A'.repeat(64)}}},
    {...base,speaker:{}},{...base,kws:{encoder:file,decoder:file,joiner:file,tokens:file,keywords:[{label:'依米',tokens:'y ī @m'}]}},
    {...base,kws:{encoder:file,decoder:file,joiner:file,tokens:file,keywords:[]}},{...base,kws:{encoder:file,decoder:file,joiner:file,tokens:file,threshold:1}}])
    assert.throws(()=>parseLocalSpeechConfig(bad),/SPEECH_CONFIG_INVALID/);
});

test('pins are verified before any thread starts; mismatch, missing file and load failure fail closed',async t=>{
  const f=await fixture(t);
  await assert.rejects(LocalSpeechEngine.open({...f.config,asr:{...f.config.asr,model:{...f.config.asr.model,sha256:'0'.repeat(64)}}},{thread}),
    /SPEECH_MODEL_PIN_MISMATCH/);
  await assert.rejects(LocalSpeechEngine.open({...f.config,speaker:{model:{path:join(f.root,'absent.onnx'),sha256:'0'.repeat(64)}}},{thread}),
    /SPEECH_MODEL_UNAVAILABLE/);
  const tagging={model:await f.file('tagging.onnx'),labels:await f.file('labels.csv')};
  await assert.rejects(LocalSpeechEngine.open({...f.config,tagging:{...tagging,labels:{...tagging.labels,sha256:'0'.repeat(64)}}},{thread}),
    /SPEECH_MODEL_PIN_MISMATCH/);
  await assert.rejects(LocalSpeechEngine.open({...f.config,asr:{...f.config.asr,model:await f.file('asr.fail-load')}},{thread}),/SPEECH_ENGINE_LOAD_FAILED/);
  const engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  await f.until(()=>f.seen.some(e=>e.kind==='started'));
  assert.equal(f.seen.filter(e=>e.kind==='started').length,1);assert.equal(engine.keywords,undefined);
  assert.match(engine.version,/^sherpa-onnx@fake\+[a-f0-9]{16}$/u);assert.equal(engine.speaker_model.dim,4);
  assert.deepEqual(engine.vad_model.native_metadata,{onnx_sha256:f.config.vad.model.sha256,threshold:0.5,min_speech_ms:250,min_silence_ms:352,max_speech_ms:20000});
});

test('requests run one at a time and an abort is honoured before dispatch only',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const queued=new AbortController(),running=new AbortController();
  const a=engine.transcribe(held(300)),b=engine.transcribe(plain(7),queued.signal),c=engine.transcribe(plain(9));
  queued.abort();await assert.rejects(b,error=>(error as {code?:string;status?:number}).code==='SPEECH_CANCELLED'&&(error as {status:number}).status===409);
  assert.deepEqual(await a,{text:'fake:300'});assert.deepEqual(await c,{text:'fake:9'});
  const d=engine.transcribe(held(200),running.signal);await f.until(()=>f.dispatched().includes('transcribe:200'));running.abort();
  assert.deepEqual(await d,{text:'fake:200'});
  assert.deepEqual(f.dispatched(),['transcribe:300','transcribe:9','transcribe:200']);
  await assert.rejects(engine.transcribe(plain(3),AbortSignal.abort()),/SPEECH_CANCELLED/);
  assert.deepEqual([...await engine.embed(plain(5))],[5,5,5,5]);
});

test('bounded queue refuses beyond capacity; close drops queued work, joins the running call, then refuses',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});
  const running=engine.transcribe(held(400));await f.until(()=>f.dispatched().length===1);
  const queued=Array.from({length:64},(_,n)=>engine.transcribe(plain(n+1)).then(()=>undefined,(error:unknown)=>error));
  assert.equal(engine.available(),false);await assert.rejects(engine.transcribe(plain(1)),/SPEECH_ENGINE_BUSY/);
  let joined=false;void running.then(()=>{joined=true;});
  await engine.close();assert.equal(joined,true);assert.deepEqual(await running,{text:'fake:400'});
  for(const error of await Promise.all(queued))assert.match(String(error),/SPEECH_ENGINE_CLOSED/);
  assert.equal(engine.available(),false);await assert.rejects(engine.transcribe(plain(1)),/SPEECH_ENGINE_CLOSED/);
  await assert.rejects(engine.openVad(new AbortController().signal),/SPEECH_ENGINE_CLOSED/);
  assert.deepEqual(f.dispatched(),['transcribe:400']);await engine.close();
});

test('queued work times out on its own; a native call past timeout_ms fails the engine closed',async t=>{
  const f=await fixture(t,1000),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const a=engine.transcribe(held(700)),b=engine.transcribe(held(700)),c=engine.transcribe(plain(5));
  await assert.rejects(c,/SPEECH_TIMEOUT/);assert.deepEqual(await a,{text:'fake:700'});assert.deepEqual(await b,{text:'fake:700'});
  assert.equal(engine.failed,false);
  const hung=engine.transcribe(held(5000)),behind=engine.transcribe(plain(3));
  await assert.rejects(hung,/SPEECH_ENGINE_TIMEOUT/);await assert.rejects(behind,/SPEECH_ENGINE_TIMEOUT/);
  assert.equal(engine.failed,true);assert.equal(engine.available(),false);await assert.rejects(engine.transcribe(plain(1)),/SPEECH_ENGINE_TIMEOUT/);
  assert.ok(!f.dispatched().includes('transcribe:5')&&!f.dispatched().includes('transcribe:3'));
});

test('a crashed thread fails the running call and every later call',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  await assert.rejects(engine.transcribe(new Float32Array(4).fill(-2)),/SPEECH_ENGINE_EXITED/);
  assert.equal(engine.failed,true);await assert.rejects(engine.embed(plain(2)),/SPEECH_ENGINE_EXITED/);
});

test('VAD and keyword streams: frames only, closing drops the stream, finish ends it',async t=>{
  const f=await fixture(t,5000,true),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  await f.until(()=>f.seen.some(e=>e.kind==='started'));
  assert.deepEqual(f.seen.find(e=>e.kind==='started'),{kind:'started',keywords:'y ī m ǐ @依米\n',threshold:0.15});
  const vad=await engine.openVad(new AbortController().signal),frames=new Float32Array(2048);frames.fill(0.5,512,1024);
  assert.deepEqual(await vad.write(frames),[{at:1024,start:512},{at:1536,end:1024}]);
  await vad.close();await assert.rejects(vad.write(frames),/SPEECH_STREAM_CLOSED/);
  const spotter=await engine.keywords!.open(new AbortController().signal);
  assert.deepEqual(await spotter.write(new Float32Array(1600)),[]);
  assert.deepEqual(await spotter.write(new Float32Array(800).fill(0.5)),[{keyword:'依米',at_sample:2400}]);
  assert.deepEqual(await spotter.finish(),[]);await assert.rejects(spotter.write(new Float32Array(1)),/SPEECH_STREAM_CLOSED/);
  await f.until(()=>f.dispatched().filter(op=>op.endsWith('close')).join()==='vad_close,kws_close');
  await assert.rejects(engine.keywords!.open(AbortSignal.abort()),/SPEECH_CANCELLED/);
});

test('a failed engine is replaced on a later use, at most once per cooldown; concurrent callers share one reopen', async () => {
  let clock=1_000,opens=0,closes=0;const fail=new Set<number>();
  const owner=recoveringEngine(async()=>{const n=++opens;if(fail.has(n))throw new Error('load');
    return {n,failed:false,close:async()=>{closes++;}};},30_000,()=>clock);
  const first=await owner.current();assert.equal((await owner.current()).n,first.n,'a healthy engine is reused');
  (first as {failed:boolean}).failed=true;
  await assert.rejects(owner.current(),/SPEECH_ENGINE_RECOVERING/,'within the cooldown the slot stays down');
  clock+=30_000;
  const [a,b]=await Promise.all([owner.current(),owner.current()]);
  assert.equal(a.n,2);assert.equal(b.n,2,'one reopen for concurrent callers');assert.equal(closes,1,'the failed engine is closed');
  (a as {failed:boolean}).failed=true;fail.add(3);clock+=30_000;
  await assert.rejects(owner.current(),/load/);
  await assert.rejects(owner.current(),/load/,'a failed load keeps its cause and waits out the cooldown');assert.equal(opens,3);
  clock+=30_000;assert.equal((await owner.current()).n,4);
  await owner.close();await assert.rejects(owner.current(),/LOCAL_AUDIO_CLOSED/);assert.equal(closes,3);
});


test('idle is distinct from capacity and queued VAD runs before queued utterance models',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  assert.equal(engine.idle(),true);const vad=await engine.openVad(new AbortController().signal);
  const running=engine.transcribe(held(300));assert.equal(engine.available(),true);assert.equal(engine.idle(),false);
  const text=engine.transcribe(plain(9)),embedding=engine.embed(plain(8)),detection=vad.write(new Float32Array(512));
  await Promise.all([running,text,embedding,detection]);await f.until(()=>f.dispatched().length===5);
  assert.deepEqual(f.dispatched().filter(op=>!op.startsWith('embed:')),['vad_open','transcribe:300','vad_write:512','transcribe:9']);
  assert.ok(f.dispatched().indexOf('embed:8')<f.dispatched().indexOf('transcribe:9'),'shared speaker never waits for ASR');
  assert.equal(engine.idle(),true);await vad.close();
});

test('call VAD detects while ASR is busy; call onset policy does not alter ambient policy',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const vad=await engine.openCallVad(new AbortController().signal);
  let finished=false;const asr=engine.transcribe(held(600)).then(value=>{finished=true;return value;});
  await f.until(()=>f.dispatched().includes('transcribe:600'));
  assert.deepEqual(await vad.write(new Float32Array(512).fill(0.5)),[{at:512,start:0}]);
  assert.equal(finished,false,'call onset must not wait for the ASR worker');
  const start=f.seen.find(e=>e.kind==='call_started') as Seen&{min_speech_ms:number};assert.equal(start.min_speech_ms,64);
  assert.equal(engine.vad_model.native_metadata.min_speech_ms,250);
  await vad.close();await asr;
});

test('call VAD bounds frame size and outstanding writes; abort closes and releases detector budget',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const owner=new AbortController(),vad=await engine.openCallVad(owner.signal);
  for(const invalid of [new Float32Array(0),plain(513),plain(2560),new Float32Array(512).fill(NaN)])
    await assert.rejects(vad.write(invalid),/SPEECH_INPUT_INVALID/);
  const active=vad.write(new Float32Array(512).fill(-1));
  await assert.rejects(vad.write(plain(512)),/SPEECH_ENGINE_BUSY/);
  owner.abort();await assert.rejects(vad.write(plain(512)),/SPEECH_STREAM_CLOSED/);
  await active;await vad.close();await vad.close();
  const streams=await Promise.all(Array.from({length:4},()=>engine.openCallVad(new AbortController().signal)));
  await Promise.all(streams.map(s=>s.close()));
  await assert.rejects(engine.openCallVad(AbortSignal.abort()),/SPEECH_CANCELLED/);
  await engine.close();await assert.rejects(engine.openCallVad(new AbortController().signal),/SPEECH_ENGINE_CLOSED/);
});

test('call VAD worker failure isolates ASR and ambient VAD; failed stream stays failed',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const vad=await engine.openCallVad(new AbortController().signal);
  await assert.rejects(vad.write(new Float32Array(512).fill(-2)),/SPEECH_ENGINE_EXITED/);
  assert.equal(engine.failed,false);assert.deepEqual(await engine.transcribe(plain(5)),{text:'fake:5'});
  const ambient=await engine.openVad(new AbortController().signal);assert.deepEqual(await ambient.write(plain(512)),[{at:512,start:0}]);
  await assert.rejects(engine.openCallVad(new AbortController().signal),/SPEECH_ENGINE_RECOVERING/);
  await vad.close();await ambient.close();
});

test('call keywords and shared speaker evidence run while ambient ASR runs; abort releases keyword stream',async t=>{
  const f=await fixture(t,5000,true),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const owner=new AbortController(),spot=await engine.openCallKeywords(owner.signal);
  let finished=false;const asr=engine.transcribe(held(600)).then(()=>{finished=true;});
  await f.until(()=>f.dispatched().includes('transcribe:600'));
  assert.deepEqual(await spot.write(new Float32Array(512).fill(0.5)),[{keyword:'依米',at_sample:512}]);
  assert.deepEqual([...await engine.embedCall(plain(6400))],[6400,6400,6400,6400]);
  assert.equal(finished,false,'call KWS and speaker evidence must not wait for ambient ASR');
  const started=f.seen.find(e=>e.kind==='call_started');assert.match(started!.keywords!,/b ié sh uō l e @别说了\n/u);
  owner.abort();await assert.rejects(spot.write(plain(512)),/SPEECH_STREAM_CLOSED/);await spot.close();
  const replacement=await engine.openCallKeywords(new AbortController().signal);await replacement.finish();
  await assert.rejects(engine.embedCall(plain(6400),AbortSignal.abort()),/SPEECH_CANCELLED/);
  await assert.rejects(engine.openCallKeywords(AbortSignal.abort()),/SPEECH_CANCELLED/);
  await asr;await engine.close();await assert.rejects(engine.openCallKeywords(new AbortController().signal),/SPEECH_ENGINE_CLOSED/);
});

test('speech owns exact-size transferred inputs and releases byte reservations on cancellation and close',async t=>{
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const backing=plain(960000),view=backing.subarray(0,16);
  await engine.transcribe(view);await f.until(()=>f.seen.some(e=>e.length===16));
  assert.equal(f.seen.find(e=>e.length===16)!.buffer_bytes,64);assert.equal(backing.byteLength,3840000);
  const running=engine.transcribe(held(200)),cancel=new AbortController();
  const first=engine.transcribe(backing,cancel.signal),second=engine.transcribe(backing,cancel.signal);
  const observed=[assert.rejects(first,/SPEECH_CANCELLED/),assert.rejects(second,/SPEECH_CANCELLED/)];
  await assert.rejects(engine.transcribe(backing),/SPEECH_ENGINE_BUSY/);
  await assert.rejects(engine.transcribe(new Float32Array(960001)),/SPEECH_INPUT_BUDGET/);
  assert.ok(engine.resourceSnapshot().ambient.admitted_bytes<=8*1024*1024);
  cancel.abort();await Promise.all(observed);await running;
  await Promise.all([engine.embed(plain(8000)),engine.embedCall(plain(8000))]);
  await f.until(()=>f.seen.some(e=>e.kind==='speaker_started'));
  assert.equal(f.seen.filter(e=>e.kind==='speaker_started').length,1);
  await engine.close();assert.equal(engine.resourceSnapshot().ambient.admitted_bytes,0);
});

test('recovery joins native termination before concurrent callers can load one replacement',async()=>{
  let clock=0,opens=0;
  const stopped=Promise.withResolvers<void>(),closing=Promise.withResolvers<void>();
  const owner=recoveringEngine(async()=>({number:++opens,failed:false as boolean,close:async()=>{closing.resolve();await stopped.promise;}}),1,()=>clock);
  const first=await owner.current();first.failed=true;clock=2;
  const a=owner.current();await closing.promise;const b=owner.current();
  assert.equal(opens,1);stopped.resolve();
  const replacements=await Promise.all([a,b]);assert.equal(opens,2);assert.equal(replacements[0],replacements[1]);
  await owner.close();
});


test('call models can initialize beyond one second within the configured speech deadline',async t=>{
  const f=await fixture(t,2000);f.config.speaker.model=await f.file('speaker.slow-load');
  const engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const vad=await engine.openCallVad(new AbortController().signal);
  assert.deepEqual(await vad.write(plain(512)),[{at:512,start:0}]);await vad.close();
  assert.deepEqual([...await engine.embedCall(plain(3200))],[3200,3200,3200,3200]);
});

test('stream close reserves bounded control admission when the inference queue is full',async t=>{
  const f=await fixture(t,5000,true),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const vad=await engine.openVad(new AbortController().signal),kws=await engine.keywords!.open(new AbortController().signal);
  const running=engine.transcribe(held(200));await f.until(()=>f.dispatched().includes('transcribe:200'));
  const queued=Array.from({length:64},()=>engine.transcribe(plain(1)).catch(error=>error));
  await assert.rejects(engine.transcribe(plain(1)),/SPEECH_ENGINE_BUSY/);
  const closed=Promise.all([vad.close(),kws.close()]);assert.equal(engine.resourceSnapshot().ambient.pending_controls,2);
  await closed;assert.equal(engine.resourceSnapshot().ambient.pending_controls,0);
  await f.until(()=>f.dispatched().includes('vad_close')&&f.dispatched().includes('kws_close'));
  const replacement=await engine.openVad(new AbortController().signal);await replacement.close();
  await running;await engine.close();await Promise.all(queued);
});
test('watchdog failure holds active bytes until the cached worker termination actually joins',async t=>{
  const f=await fixture(t,1000),engine=await LocalSpeechEngine.open(f.config,{thread}),gate=Promise.withResolvers<void>();
  const terminate=Worker.prototype.terminate;let terminations=0;
  t.mock.method(Worker.prototype,'terminate',function(this:Worker){terminations++;const stopped=terminate.call(this);return gate.promise.then(()=>stopped);});
  t.after(async()=>{gate.resolve();await engine.close();});
  const hung=engine.transcribe(held(5000));await assert.rejects(hung,/SPEECH_ENGINE_TIMEOUT/);
  assert.equal(engine.resourceSnapshot().ambient.active_jobs,1);assert.equal(engine.resourceSnapshot().ambient.admitted_bytes,5000*4);
  let closed=false;const closing=engine.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false);assert.equal(engine.resourceSnapshot().ambient.admitted_bytes,5000*4);
  gate.resolve();await closing;assert.equal(engine.resourceSnapshot().ambient.admitted_bytes,0);
  assert.equal(engine.resourceSnapshot().ambient.active_jobs,0);assert.equal(terminations,2,'one termination per ambient and speaker worker');
});

test('undeliverable native stream close fails explicitly after the worker is joined',async t=>{
  const f=await fixture(t);f.config.vad.model=await f.file('vad.fail-close');
  const engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const vad=await engine.openVad(new AbortController().signal);
  await assert.rejects(vad.close(),/CONTROLLED_CLOSE_FAILURE/);assert.equal(engine.failed,true);
  assert.equal(engine.resourceSnapshot().ambient.active_jobs,0);assert.equal(engine.resourceSnapshot().ambient.admitted_bytes,0);
  await assert.rejects(vad.close(),/CONTROLLED_CLOSE_FAILURE/);
});


test('minutes of enrollment VAD use bounded worker writes and preserve speech crossing every write boundary', async t => {
  const f=await fixture(t),engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const signal=new AbortController().signal,pcm=Buffer.alloc(120*16000*2);
  for(let n=512;n<pcm.length/2-512;n++)pcm.writeInt16LE(3000,n*2);
  const tooLarge=await engine.openVad(signal);
  await assert.rejects(tooLarge.write(new Float32Array(pcm.length/2)),/SPEECH_INPUT_BUDGET/);
  await tooLarge.close();
  const cut=await speechSpans(new SherpaSileroStreamFactory(async()=>engine),pcm,signal);
  assert.deepEqual(cut.segments,[{start_sample:512,end_sample_exclusive:pcm.length/2-512}]);
  assert.equal(cut.terminal.processed_samples,pcm.length/2);assert.equal(cut.terminal.uninferred_samples,0);
  await f.until(()=>f.seen.filter(e=>e.kind==='dispatched'&&e.op==='vad_write').reduce((n,e)=>n+e.length!,0)===pcm.length/2);
  const writes=f.seen.filter(e=>e.kind==='dispatched'&&e.op==='vad_write');
  assert.ok(writes.length>1&&writes.every(e=>e.length!<=NATIVE_WINDOW_SAMPLES));
  assert.equal(f.seen.filter(e=>e.kind==='dispatched'&&e.op==='vad_open').length,2,'one refused stream and one complete long-recording stream');
});

// The target package supplies both ambient and call tokenizer output.
test('call keyword worker receives selected package tokens instead of legacy tokens',async t=>{
  const f=await fixture(t,5000,true);
  f.config.kws!.call_keywords=[{label:'依米',tokens:'selected-call-token'},{label:'停',tokens:'selected-stop-token'}];
  const engine=await LocalSpeechEngine.open(f.config,{thread});t.after(()=>engine.close());
  const stream=await engine.openCallKeywords(new AbortController().signal);await stream.close();
  await f.until(()=>f.seen.some(event=>event.kind==='call_started'));
  assert.equal(f.seen.find(event=>event.kind==='call_started')!.keywords,'selected-call-token @依米\nselected-stop-token @停\n');
});
