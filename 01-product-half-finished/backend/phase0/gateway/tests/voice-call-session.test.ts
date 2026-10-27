import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { AudioSource, dispose } from '@livekit/rtc-node';
import {createCallPlayout,CallPcmBudget,CALL_PCM_LIMITS} from '../src/call-playout.ts';
import { createVoiceCallSession, FIRST_AUDIO_CONFIRM_MS, PICKUP_EVENT, frontInstructions, type CallStateExtra } from '../src/voice-call-session.ts';

after(() => dispose()); // the native audio source keeps the FFI loop alive otherwise

const room = {localParticipant: {publishTrack: async () => ({sid: 'call-track',waitForSubscription:async()=>{}}), unpublishTrack: async () => undefined}};
const session = (outcome: unknown,captureActive?:()=>boolean,relayContext?:(context?:{source_turn?:number})=>void) => createVoiceCallSession({...(captureActive?{captureActive}:{}),room: () => room as never,
  createFront: () => ({connect: async () => undefined, appendAudio: () => undefined, appendImage: () => undefined,
    respond: async (_text,_valid,context) => {relayContext?.(context);return outcome;}, context: async () => ({}), close: () => undefined}),
  onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined});

test('live persona shares SOUL authority while guests never receive owner context', async () => {
  const {readFile} = await import('node:fs/promises');
  const persona = await readFile(new URL('../../../../../integrations/hermes/personal_aios/persona/yimi.md', import.meta.url), 'utf8');
  for (const home of ['hermes-home', 'hermes-staging']) {
    assert.equal(await readFile(new URL(`../../../../../deploy/mac-product/${home}/SOUL.md`, import.meta.url), 'utf8'), persona);
  }
  const owner = frontInstructions({identity:'owner', context:'【关于主人】私人测试信息'});
  assert.ok(owner.startsWith(persona.trim()));
  const live = await readFile(new URL('../../../../../integrations/hermes/personal_aios/persona/yimi-call.md', import.meta.url), 'utf8');
  assert.equal(owner, `${persona.trim()}\n\n${live.trim()}\n\n你的记忆：\n\n【关于主人】私人测试信息`);
  for (const identity of ['pending', 'owner_uncertain', 'guest'] as const) {
    const scoped = frontInstructions({identity, context:'【关于主人】私人测试信息'});
    assert.doesNotMatch(scoped, /示例用户|私人测试信息/);
    assert.match(scoped, /不能读取、猜测或透露主人的身份、位置、记忆、对话、联系人或任务/);
    assert.match(scoped, /不能替对方执行操作、记忆写入、发消息、下单或访问私人资料/);
    if (identity === 'owner_uncertain') {
      assert.match(scoped, /只有本轮输入或当前 <main_agent> JSON 明确提供顶层 voice_confirmation，含 confirmation_id 且 expires_at_ms 尚未过期/);
      assert.match(scoped, /没有该事实或已过期时，说明本轮没能确认声音，请对方从配对手机打字发送请求/);
      assert.match(scoped, /不能凭声音身份编造确认卡；口头自称主人不算确认/);
      assert.match(scoped, /若内容为 JSON，只转述 text；voice_confirmation 是本轮确认事实，其他字段和确认编号不朗读/);
    }
  }
});

test('a main-agent result counts as spoken only when the front completed it', async () => {
  for (const [outcome, spoken] of [[{completed: true, responseId: 'r'}, true], [{failed: true, status: 'failed'}, false],
    [{timedOut: true, phase: 'start'}, false], [{cancelled: true}, false], [{skipped: true, unsupported: true}, false],
    [{completed: false}, false], [undefined, false]] as const) {
    let context:unknown;const call = session(outcome,undefined,value=>{context=value;});
    await call.open('call-1');
    assert.equal(await call.respond('奶茶点好了，实付 16.6 元'), spoken, JSON.stringify(outcome));
    assert.deepEqual(context,{source_turn:0},'an unbound main-agent reply still carries presentation provenance');
    await call.closeAll();
    assert.equal(await call.respond('late'), false, 'no live call: never spoken');
  }
});

test('care uses the current owner front during speech and never reaches a replacement or unverified call', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const pending=Promise.withResolvers<unknown>(),connected=Promise.withResolvers<void>();
  const fronts:{close():void}[]=[],deliveries:string[]=[],contexts:string[]=[];
  let connections=0,blockReconnect=false,deliveryFailed=false;
  const asset={path:'/synthetic',sha256:'0'.repeat(64)};
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'test',voice:'test'}},score:async()=>.1,thinking:new Int16Array(480)},identifySpeech:async()=>true,transcribeSpeech:async()=>'',classifySpeech:async()=>({stop:false,guests:'unchanged'}),
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>480,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    openVad:async()=>({write:async pcm=>pcm.some(v=>v!==0)?[{at:512,start:0}]:[{at:1024,end:512}],close:async()=>{}}),
    createFront:callbacks=>{
      fronts.push({close:()=>callbacks.onClose?.()});
      return {connect:async()=>{connections++;if(blockReconnect&&connections===2)await connected.promise;},
        appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async text=>{contexts.push(text);},close:()=>{},
        greet:async(_event,delivery)=>{if(delivery.includes('CARE')){if(deliveryFailed)return {timedOut:true};deliveries.push(delivery);callbacks.onEvent({type:'response.audio.delta',response_id:'care',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});return pending.promise;}return {completed:true};}};
    },onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  try{
    await call.open('owner');assert.equal(await call.context('OWNER CARE'),true);
    call.pushPcm(new Int16Array(512).fill(1000));await new Promise(r=>setImmediate(r));
    assert.equal(await call.respond('ordinary'),false,'ordinary result still respects speech');
    const care=call.respond('CARE',undefined,true);await new Promise(r=>setImmediate(r));
    assert.equal(deliveries.length,0,'care waits for the owner to finish speaking');
    call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));t.mock.timers.tick(120);await new Promise(r=>setImmediate(r));
    assert.equal(deliveries.length,1,'care enters the same front delivery queue after speech');
    t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);pending.resolve({completed:true});assert.equal(await care,true);
    deliveryFailed=true;await assert.rejects(call.respond('FAILED CARE',undefined,true),/VOICE_CALL_CARE_NOT_DELIVERED/);
    deliveryFailed=false;
    blockReconnect=true;fronts[0]!.close();await new Promise(r=>setImmediate(r));
    const stale=call.respond('STALE CARE',undefined,true);
    await call.close('owner','button');await call.open('replacement');t.mock.timers.tick(100);
    assert.equal(await stale,false,'hangup releases care while the old connect is still pending');connected.resolve();
    assert.equal(deliveries.length,1,'waiting care cannot spill into replacement');
    await call.closeAll();await call.open('pending',{mode:'ambient'});
    assert.equal(await call.context('PRIVATE CARE'),false);
    assert.equal(await call.respond('PRIVATE CARE',undefined,true),false);
    await call.identify('pending','guest');
    assert.equal(await call.context('PRIVATE CARE'),false);
    assert.equal(await call.respond('PRIVATE CARE',{call_id:'pending',identity:'guest'},true),false);
    assert.equal(deliveries.length,1,'pending and guest fronts never receive private care');
    assert.deepEqual(contexts,['OWNER CARE']);
  }finally{connected.resolve();await call.closeAll();}
});

function harness(publish: (track: unknown) => Promise<{sid?: string;waitForSubscription():Promise<void>}> = async () => ({sid: 'call-track',waitForSubscription:async()=>{}}), mirrorBarrier?:Promise<void>) {
  const turns: {user: string; interrupted: boolean}[] = [], states: string[] = [], unpublished: string[] = [];
  const delivered=Promise.withResolvers<void>();
  let emit: ((event: Record<string, unknown>) => void) | undefined, frontClosed = 0;
  const call = createVoiceCallSession({room: () => ({localParticipant: {publishTrack: publish,
      unpublishTrack: async (sid: string) => {unpublished.push(sid);}}}) as never,
    createFront: callbacks => {emit = callbacks.onEvent; return {connect: async () => undefined, appendAudio: () => undefined,
      appendImage: () => undefined, respond: async () => ({completed: true}), context: async () => ({}), close: () => {frontClosed++;}};},
    onState: (_id, state) => {states.push(state);}, onTranscript: () => undefined,
    onTurn: turn => {turns.push({user: turn.user, interrupted: turn.interrupted});delivered.resolve();return mirrorBarrier;}, onError: () => undefined});
  return {call, turns, states, unpublished,delivered:delivered.promise, emit: (event: Record<string, unknown>) => emit!(event), frontClosed: () => frontClosed};
}

test('a transcribed request reaches the main agent even when the call ends before the front answers', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const h = harness();
  await h.call.open('call-1');
  h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: '帮我叫车回家'});
  await h.call.close('call-1', 'button');
  assert.deepEqual(h.turns, [{user: '帮我叫车回家', interrupted: true}], 'handed over once, marked unanswered');

  const normal = harness();
  await normal.call.open('call-2');
  normal.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: '今天天气怎么样'});
  normal.emit({type:'response.audio.delta',response_id:'r1',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);
  normal.emit({type: 'response.done', response: {id: 'r1', status: 'completed'}});
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);
  await normal.delivered;
  await normal.call.close('call-2', 'button');
  assert.deepEqual(normal.turns, [{user: '今天天气怎么样', interrupted: false}], 'answered turn: handed over once, not again at close');
});

test('hanging up while the call is still opening releases what the opening acquired late', async () => {
  let release!: (value: {sid?: string;waitForSubscription():Promise<void>}) => void;
  const h = harness(() => new Promise(resolve => {release = resolve;}));
  const opening = h.call.open('call-3');
  await new Promise(resolve => setImmediate(resolve));
  await h.call.close('call-3', 'button');
  release({sid: 'late-track',waitForSubscription:async()=>{}});
  await assert.rejects(opening, /VOICE_CALL_SUPERSEDED/);
  assert.deepEqual(h.unpublished, ['late-track'], 'the track published after the hang-up is taken down');
  assert.ok(h.frontClosed() >= 1, 'the provider front is closed');
  assert.equal(h.states.includes('live'), false);
  assert.equal(h.states.includes('failed'), false, 'a hang-up is not reported as a failed call');
  assert.equal(h.call.active(), undefined);
});

test('raw transcripts without verified turn identity never hang up a call',async t=>{
  for(const user of ['\u518d\u89c1','\u597d\u4e86\uff0c\u62dc\u62dc']){
    const h=harness();t.after(()=>h.call.close('call-bye','button'));await h.call.open('call-bye');
    h.emit({type:'conversation.item.input_audio_transcription.completed',transcript:user});
    h.emit({type:'response.created',response:{id:'r-bye'}});
    h.emit({type:'response.audio.delta',response_id:'r-bye',delta:Buffer.from(new Int16Array(480).fill(800).buffer).toString('base64')});
    await new Promise(resolve=>setTimeout(resolve,FIRST_AUDIO_CONFIRM_MS+20));
    h.emit({type:'response.done',response:{id:'r-bye',status:'completed'}});
    await h.delivered;assert.equal(h.call.active(),'call-bye');assert.equal(h.states.includes('closed'),false);
    await h.call.close('call-bye','button');assert.equal(h.call.active(),undefined);assert.equal(h.states.at(-1),'closed');
    assert.deepEqual(h.turns,[{user,interrupted:false}]);
  }
});

test('a button hang-up discards queued reply audio immediately', async () => {
  const h = harness();
  await h.call.open('call-btn');
  h.emit({type: 'response.created', response: {id: 'r-long'}});
  h.emit({type: 'response.audio.delta', response_id: 'r-long', delta: Buffer.from(new Int16Array(24000 * 3).buffer).toString('base64')});
  const started = Date.now();
  await h.call.close('call-btn', 'button');
  assert.ok(Date.now() - started < 600, 'no drain on a hang-up');
  assert.equal(h.states.at(-1), 'closed');
});

test('the voice she speaks with is handed out per response as it plays, and closed when the response is done', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const heard: [string, number | null][] = [];
  let emit!: (event: Record<string, unknown>) => void;
  const call = createVoiceCallSession({room: () => room as never,
    createFront: callbacks => {emit = callbacks.onEvent; return {connect: async () => undefined, appendAudio: () => undefined,
      appendImage: () => undefined, respond: async () => ({completed: true}), context: async () => ({}), close: () => undefined};},
    onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined,
    onVoiceAudio: (id, pcm) => {heard.push([id, pcm && pcm.length]); if (id === 'r2') throw new Error('learner failure stays out of playback');}});
  await call.open('call-voice');
  const delta = (n: number) => Buffer.from(new Int16Array(n).fill(500).buffer).toString('base64');
  emit({type: 'response.created', response: {id: 'r1'}});
  emit({type: 'response.audio.delta', response_id: 'r1', delta: delta(480)});
  emit({type: 'response.output_audio.delta', response_id: 'r1', delta: delta(960)});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);
  emit({type: 'response.done', response: {id: 'r1', status: 'completed'}});
  emit({type: 'response.created', response: {id: 'r2'}});
  emit({type: 'response.audio.delta', response_id: 'r2', delta: delta(480)});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);
  assert.deepEqual(heard, [['r1', 480], ['r1', 960], ['r1', null], ['r2', 480]]);
  assert.equal(call.active(), 'call-voice', 'a failing listener never stops the call');
  await call.closeAll();
});

test('the call says what it heard: spans while it was live (with clock slack), not before it went live or after it closed', async () => {
  let clock = 1_000_000;
  const call = createVoiceCallSession({room: () => room as never,
    createFront: () => ({connect: async () => undefined, appendAudio: () => undefined, appendImage: () => undefined,
      respond: async () => ({completed: true}), context: async () => ({}), close: () => undefined}),
    onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined, now: () => clock});
  const span = (start_ms: number, end_ms: number) => ({start_ms, end_ms});
  assert.equal(call.heard(span(999_000, 1_001_000)), false, 'no call yet');
  await call.open('call-heard');
  assert.equal(call.heard(span(1_002_000, 1_003_000)), true, 'live and still open-ended');
  clock = 1_010_000; await call.closeAll(); clock = 1_020_000;
  assert.deepEqual([span(1_005_000, 1_006_000), span(1_009_000, 1_010_200), span(1_011_000, 1_012_000), span(998_000, 999_400)].map(call.heard),
    [true, true, false, false], 'heard during the call; nothing it did not hear');
  clock = 1_010_000 + 11 * 60_000;
  assert.equal(call.heard(span(1_005_000, 1_006_000)), false, 'an old call is forgotten once the lane is long past it');
});

test('what the user says while the call is connecting reaches the front first, in order, once it is ready (bounded)', async () => {
  // Speech received while the call is opening must reach the front after connection.
  let clock = 2_000_000, ready!: () => void;
  const appended: number[] = [];
  const connecting = (fail = false) => new Promise<void>((resolve, reject) => {ready = fail ? () => reject(new Error('provider down')) : resolve;});
  const make = (fail = false) => createVoiceCallSession({room: () => room as never,
    createFront: () => ({connect: () => connecting(fail), appendImage: () => undefined, respond: async () => ({completed: true}),
      context: async () => ({}), close: () => undefined,
      appendAudio: (base64: string) => {const pcm = Buffer.from(base64, 'base64'); for(let at=0;at<pcm.length;at+=3200)appended.push(pcm.readInt16LE(at));}}),
    onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined, now: () => clock});
  const frame = (marker: number, samples = 1600) => new Int16Array(samples).fill(marker);
  const call = make();
  const opening = call.open('call-early');
  await new Promise(resolve => setImmediate(resolve));
  call.pushPcm(frame(1)); call.pushPcm(frame(2));
  assert.deepEqual(appended, [], 'nothing reaches a front that is not ready');
  assert.equal(call.heard({start_ms: 2_000_100, end_ms: 2_000_400}), true, 'speech while connecting is the call\'s to answer');
  clock = 2_003_000; ready(); await opening;
  call.pushPcm(frame(3));
  assert.deepEqual(appended, [1, 2, 3], 'kept opening audio first, then live audio');
  await call.closeAll();

  appended.length = 0;
  const bounded = make(); const second = bounded.open('call-long');
  await new Promise(resolve => setImmediate(resolve));
  for (let n = 1; n <= 120; n++) bounded.pushPcm(frame(n)); // 12 s of 100 ms frames
  ready(); await second;
  assert.deepEqual([appended.length, appended[0], appended.at(-1)], [100, 21, 120], 'only the last 10 s are kept');
  await bounded.closeAll();

  appended.length = 0; clock = 3_000_000;
  const failing = make(true); const third = failing.open('call-down');
  await new Promise(resolve => setImmediate(resolve));
  failing.pushPcm(frame(9)); ready();
  await assert.rejects(third, /VOICE_CALL_CONNECT_FAILED/);
  assert.deepEqual(appended, [], 'a call that never connected hands nothing over');
  assert.equal(failing.heard({start_ms: 3_000_000, end_ms: 3_000_500}), false, 'and heard nothing');
});

test('each owner call opens with the shared persona and live rules plus fresh memory', async () => {
  const instructions: string[] = [];
  const call = createVoiceCallSession({room: () => room as never,
    createFront: callbacks => {instructions.push(callbacks.instructions); return {connect: async () => undefined, appendAudio: () => undefined,
      appendImage: () => undefined, respond: async () => ({completed: true}), context: async () => ({}), close: () => undefined};},
    onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined});
  await call.open('call-a', {context: '【关于主人】\n- 主人叫示例用户'});
  await call.closeAll();
  await call.open('call-b', {context: '【关于主人】\n- 主人叫示例用户，刚搬到示例市样例区'});
  await call.closeAll();
  await call.open('call-c');
  await call.closeAll();
  assert.equal(instructions.length, 3);
  assert.ok(instructions.every(text => text.includes('你是依米，') && text.includes('私人 AI 助理。') && text.includes('长短跟随他的请求')), 'shared persona and adaptive spoken length kept');
  assert.ok(instructions[0]!.endsWith('- 主人叫示例用户') && instructions[1]!.endsWith('刚搬到示例市样例区'), 'fresh context per call, after the rules');
  assert.ok(!instructions[2]!.includes('【关于主人】\n'), 'no context: rules only');
});

function greeter(options: {greeting?: {enabled?: boolean; text?: string}; expressive?: boolean; now?:()=>number} = {}) {
  const log: string[] = [], transcripts: string[] = [], turns: unknown[] = [],deliveries:string[]=[];
  const transcribed=Promise.withResolvers<void>();
  let emit!: (event: Record<string, unknown>) => void;
  const call = createVoiceCallSession({...options, room: () => room as never,
    createFront: callbacks => {emit = callbacks.onEvent; return {connect: async () => undefined,
      appendAudio: () => {log.push('audio');}, appendImage: () => undefined, respond: async () => ({completed: true}),
      context: async text => {log.push(`context:${text.includes('不要再重复问候')}`); return {};}, close: () => undefined,
      greet: async (event, delivery) => {deliveries.push(delivery);log.push(`greet:${/喂~我在呢！|哈喽，我在！/.exec(delivery)?.[0]}|${delivery.includes('俏皮')}|${event === PICKUP_EVENT}`);
        // A spoken care line must really play: the session only counts care as delivered after its audio is heard.
        if (event.includes('依米主动关心主人')) callbacks.onEvent({type: 'response.audio.delta', response_id: `care-${deliveries.length}`, delta: Buffer.from(new Int16Array(480).buffer).toString('base64')});
        return {completed: true};}};},
    onState: (_id, state) => {log.push(`state:${state}`);}, onTranscript: (_id, _turn, role, text) => {transcripts.push(`${role}:${text}`);transcribed.resolve();},
    onTurn: turn => {turns.push(turn);}, onError: () => undefined});
  return {call, log, transcripts, turns,deliveries,transcribed:transcribed.promise, emit: (event: Record<string, unknown>) => emit(event)};
}
const frame = (level: number) => new Int16Array(320).fill(level);

test('the greeting is spoken once the call is live, before the buffered audio, and mirrors her words into the native timeline', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const g = greeter();
  await g.call.open('g1'); // opening happens with no audio yet: nothing buffered
  assert.deepEqual(g.log.slice(0, 2), ['state:opening', 'state:live']);
  assert.match(g.deliveries[0]!,/结合共享时间线自然接上对话/u);assert.ok(g.log[2]!.endsWith('|true'),'same pickup request before buffered audio');
  g.emit({type: 'response.created', response: {id: 'rg'}});
  g.emit({type: 'response.audio_transcript.delta', response_id: 'rg', delta: '喂~我在呢！'});
  g.emit({type:'response.audio.delta',response_id:'rg',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);
  g.emit({type: 'response.done', response: {id: 'rg', status: 'completed'}});
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);
  await g.transcribed;
  assert.deepEqual(g.transcripts, ['assistant:喂~我在呢！']);
  assert.deepEqual(g.turns,[{call_id:'g1',turn:0,user:'',assistant:'喂~我在呢！',interrupted:false,route:'front_only',speaker:'owner'}], 'her greeting is a native call observation even without an owner utterance');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.log.some(line => line.startsWith('context')), false, 'the greeting is in her own conversation: no extra note (3.1 voiced such notes)');
  g.emit({type:'response.created',response:{id:'main-result'},__voiceContext:{source_turn:0}});
  g.emit({type:'response.audio_transcript.delta',response_id:'main-result',delta:'后台查到结果了。'});
  g.emit({type:'response.audio.delta',response_id:'main-result',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);g.emit({type:'response.done',response:{id:'main-result',status:'completed'}});
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(g.turns.length,1,'main-agent result playback cannot feed another assistant-only run back to the main agent');
  await g.call.closeAll();
});

test('an ambient session 依米 opens herself says her line first; a woken one answers in her own words', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const greeted: string[][] = [],drain=Promise.withResolvers<void>();let delivered=false;
  const call = createVoiceCallSession({room: () => room as never, createFront: cb => ({connect: async () => undefined, appendAudio: () => undefined,
    appendImage: () => undefined, respond: async () => ({completed: true}), context: async () => ({}), close: () => undefined,
    greet: async (event, delivery) => {cb.onEvent({type:'response.audio_transcript.delta',response_id:'greeting',delta:'嗓子还难受吗？'});cb.onEvent({type:'response.audio.delta',response_id:'greeting',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});cb.onEvent({type:'response.done',response:{id:'greeting',status:'completed'}});greeted.push([event, delivery]); return {completed: true};}}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:()=>drain.promise,close:async()=>{}}),
    onState: () => undefined, onTranscript: () => undefined, onTurn: () => undefined, onError: () => undefined});
  const opening=call.open('ambient-care', {mode: 'ambient', say: '示例用户，你还好吗？'});
  void opening.then(()=>{delivered=true;});await new Promise(r=>setImmediate(r));t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(r=>setImmediate(r));
  assert.equal(delivered,false,'care still owns delivery until its complete audio drains');drain.resolve();assert.equal(await opening,'嗓子还难受吗？','the actual spoken words return through the care delivery receipt');
  await call.close('ambient-care','button');await call.open('ambient-wake', {mode: 'ambient'});
  await call.closeAll();
  assert.ok(greeted[0]![0]!.includes('依米主动关心主人') && greeted[0]![1]!.includes('示例用户，你还好吗？'));
  assert.ok(greeted[1]![1]!.includes('轻轻应一声')&&!greeted[1]![1]!.includes('我在'),'the wake reply is guidance, not a fixed line');
});

test('pickup gives the model local context, call timing and the last actual greeting in the existing single request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let at=1_000_000;
  const g=greeter({now:()=>at});
  await g.call.open('first',{context:'【此刻】2026年10月10日 23:00（Asia/Shanghai）\n【最近关心】23:00 依米：嗓子还好吗？'});
  assert.equal(g.deliveries.length,1);assert.match(g.deliveries[0]!,/共享时间线/u);assert.doesNotMatch(g.deliveries[0]!,/主人当地时间|最近关心|上次主动关心/u);
  g.emit({type:'response.created',response:{id:'pickup'}});
  g.emit({type:'response.audio_transcript.delta',response_id:'pickup',delta:'喂，你说，我听着呢。'});
  g.emit({type:'response.audio.delta',response_id:'pickup',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);g.emit({type:'response.done',response:{id:'pickup',status:'completed'}});
  at+=60_000;await g.call.closeAll();at+=12_000;await g.call.open('callback');
  assert.equal(g.deliveries.length,2);assert.match(g.deliveries[1]!,/上次拨入是72秒前，通话结束于12秒前/u);
  assert.match(g.deliveries[1]!,/上次实际开场白：喂，你说，我听着呢。/u);
  g.emit({type:'response.created',response:{id:'discarded-pickup'}});g.emit({type:'response.done',response:{id:'discarded-pickup',status:'cancelled'}});
  g.emit({type:'response.created',response:{id:'ordinary'}});g.emit({type:'response.audio_transcript.delta',response_id:'ordinary',delta:'奶茶已经送到了。'});
  g.emit({type:'response.audio.delta',response_id:'ordinary',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);g.emit({type:'response.done',response:{id:'ordinary',status:'completed'}});
  await g.call.closeAll();await g.call.open('again');assert.match(g.deliveries[2]!,/上次实际开场白：喂，你说，我听着呢。/u,'a discarded pickup never turns an ordinary reply into the last greeting');await g.call.closeAll();
  const custom=greeter({greeting:{text:'哈喽，我在！'}});await custom.call.open('custom');
  assert.match(custom.deliveries[0]!,/使用配置的开场白：哈喽，我在！/u);await custom.call.closeAll();
});

test('greeting goes before silent buffered audio; speech already said while connecting skips it; config turns it off or changes it', async () => {
  const quiet = greeter();
  const opening = quiet.call.open('g2');
  quiet.call.pushPcm(frame(5)); await opening;
  assert.ok(quiet.log.findIndex(line=>line.startsWith('greet:')) < quiet.log.indexOf('audio'), 'greeting first, then the buffered audio');
  await quiet.call.closeAll();

  const talking = greeter();
  const opening2 = talking.call.open('g3');
  talking.call.pushPcm(frame(4000)); await opening2;
  assert.equal(talking.log.some(line => line.startsWith('greet')), false, 'user already speaking: the front answers them instead');
  assert.ok(talking.log.includes('audio'), 'their audio still reaches the front');
  await talking.call.closeAll();

  const off = greeter({greeting: {enabled: false}});
  await off.call.open('g4'); assert.equal(off.log.some(line => line.startsWith('greet')), false); await off.call.closeAll();
  const custom = greeter({greeting: {text: '哈喽，我在！'}, expressive: false});
  await custom.call.open('g5'); assert.ok(custom.deliveries[0]!.includes('使用配置的开场白：哈喽，我在！')&&custom.deliveries[0]!.includes('语气平和自然'), 'custom text, plain delivery when not expressive');
  await custom.call.closeAll();
});

function ownerSpeech() {
  let samples=0,active=false;
  const asset={path:'/synthetic',sha256:'0'.repeat(64)};
  return {turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'test',voice:'test'}},score:async()=>1,thinking:new Int16Array(480)},classifySpeech:async()=>({stop:false,guests:'unchanged' as const}),identifySpeech:async()=>true,transcribeSpeech:async()=>"停",
    openVad:async()=>({write:async(pcm:Float32Array)=>{const before=samples;samples+=pcm.length;
      const speech=pcm.some(v=>v!==0),changed=speech!==active;active=speech;
      return changed?[speech?{at:samples,start:before}:{at:samples,end:before}]:[];},close:async()=>{}})};
}
test('managed playout capability rejection releases the output and pending call',async()=>{
  let released=0;const states:string[]=[];
  const call=createVoiceCallSession({...ownerSpeech(),room:()=>({}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{released++;}}),
    createFront:()=>{throw Error('UNEXPECTED_FRONT');},onState:(_id,state)=>{states.push(state);},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await assert.rejects(call.open('missing-playhead',{context:async()=>new Promise(()=>{})}),/CALL_PLAYOUT_POSITION_REQUIRED/);
  await new Promise(setImmediate);
  assert.equal(released,1);assert.equal(call.pending(),undefined);assert.equal(states.filter(state=>state==='failed').length,1);assert.equal(states.at(-1),'closed');
});

const ownerInterrupt=async(call:ReturnType<typeof createVoiceCallSession>)=>{
  call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
  for(let i=0;i<42;i++){call.pushPcm(new Int16Array(512).fill(1000));await new Promise(r=>setImmediate(r));}
  call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
};

test('only owner dial wires unknown speech to the existing paired-device biometric confirmation',async()=>{
  for(const intent of ['dial','automatic'] as const){
    const confirmations:{call_id:string;trust_call?:boolean}[]=[],errors:unknown[]=[];let requests=0;
    const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
      identifySpeech:async()=>({verdict:'unknown'}),transcribeSpeech:async()=> '依米帮我查天气',
      classifySpeech:async()=>({stop:false,guests:'unchanged',directed:true}),
      confirmSpeech:async(_source,_session,turn)=>{confirmations.push(turn);return false;},
      createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
        clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{requests++;return {completed:true};}}),
      onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
    try{
      await call.open(`bootstrap-${intent}`,{mode:'ambient',intent,continuity:'paired-session',
        source:{principal_id:'owner',device_id:'phone',device_type:'phone'} as never});
      const archive=Promise.resolve({event:{raw_ref:`l5:${'a'.repeat(64)}`,archive_revision:'b'.repeat(64)},chunk:{}} as never);
      const push=async(value:number)=>{call.pushPcm(new Int16Array(512).fill(value),archive);await new Promise(r=>setImmediate(r));};
      for(let turn=0;turn<2;turn++){await push(0);for(let n=0;n<42;n++)await push(1000);await push(0);
        for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));}
      assert.equal(confirmations.length,intent==='dial'?1:0);assert.equal(requests,0);assert.deepEqual(errors,[]);
      if(intent==='dial')assert.equal(confirmations[0]!.trust_call,true,'the existing call intent remains the biometric trust authority');
    }finally{await call.closeAll();}
  }
});

test('a side remark the front observes before the thinking delay stays silent',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
  const audio:Int16Array[]=[],errors:unknown[]=[],requested=Promise.withResolvers<void>(),decision=Promise.withResolvers<void>();
  let callbacks!:Parameters<Parameters<typeof createVoiceCallSession>[0]['createFront']>[0];
  const speech=ownerSpeech();
  const call=createVoiceCallSession({...speech,greeting:{enabled:false},room:()=>({}),
    transcribeSpeech:async()=> '你先坐，我打个电话',
    createPlayout:()=>({open:async()=>{},push:pcm=>{audio.push(pcm);},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:front=>{callbacks=front;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{assert.fail('no status voice');},context:async()=>{},close:()=>{},
      clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{requested.resolve();await decision.promise;return {completed:true};}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  t.after(async()=>{decision.resolve();await call.closeAll();});await call.open('side-remark');
  await ownerInterrupt(call);await requested.promise;
  callbacks.onEvent({type:'response.created',response:{id:'silent'}});callbacks.onTool!('observe_call_turn',{});
  t.mock.timers.tick(5000);await new Promise(setImmediate);assert.deepEqual(audio,[]);assert.deepEqual(errors,[]);
});

test('barge-in retires the published track and a later response uses a fresh SID',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const published:string[]=[],unpublished:string[]=[],resets:string[]=[];
  let emit!:(event:Record<string,unknown>)=>void,cancels=0;
  const call=createVoiceCallSession({...ownerSpeech(),room:()=>({localParticipant:{publishTrack:async()=>{
    const sid=`TR_${published.length}`;published.push(sid);return {sid,waitForSubscription:async()=>{}};},unpublishTrack:async (sid:string)=>{unpublished.push(sid);}}}) as never,
    createFront:callbacks=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),
      context:async()=>{},close:()=>{},cancel:()=>{cancels++;}};},onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{},
    onPlaybackReset:(_id,sid)=>resets.push(sid)});
  await call.open('rotate');emit({type:'response.created',response:{id:'old'}});
  emit({type:'response.audio.delta',response_id:'old',delta:Buffer.from(new Int16Array(72001).buffer).toString('base64')});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(r=>setImmediate(r));
  emit({type:'input_audio_buffer.speech_started'});assert.deepEqual(resets,[],'onset alone does not retire audio');
  await ownerInterrupt(call);assert.deepEqual(published,['TR_0','TR_1'],'replacement publishes before reply audio');assert.deepEqual(resets,['TR_0']);assert.equal(cancels,1);
  emit({type:'response.audio.delta',response_id:'old',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  emit({type:'response.created',response:{id:'new'}});
  emit({type:'response.audio.delta',response_id:'new',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(published,['TR_0','TR_1']);assert.ok(unpublished.includes('TR_0'));
  await call.closeAll();assert.ok(unpublished.includes('TR_1'));
});

test('first reply waits for subscription after idle recovery and interruption, without leaking cancelled frames',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const archived:number[]=[],captured:number[]=[],subscriptions:ReturnType<typeof Promise.withResolvers<void>>[]=[],resets:string[]=[],errors:unknown[]=[];
  t.mock.method(AudioSource.prototype,'captureFrame',async(frame:{data:Int16Array})=>{if(captured.at(-1)!==frame.data[0])captured.push(frame.data[0]!);});
  let emit!:(event:Record<string,unknown>)=>void,fronts=0;
  const call=createVoiceCallSession({...ownerSpeech(),room:()=>({localParticipant:{publishTrack:async()=>{
    const sid=`TR_${subscriptions.length}`,sub=Promise.withResolvers<void>();subscriptions.push(sub);
    return {sid,waitForSubscription:()=>sub.promise};},unpublishTrack:async()=>{}}}),
    createPlayout:(room,id,reset,onError,mode,budget,options)=>{
      assert.equal(mode,'manual');assert.equal(options.video,true);assert.equal(options.context,'shared-call-context');
      return createCallPlayout(room,id,reset,onError,budget,options.onPlayed);
    },
    createFront:callbacks=>{fronts++;emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},
      respond:async()=>({completed:true}),context:async()=>{},cancel:()=>{},close:()=>{}};},
    onPlayedAudio:(_id,pcm)=>{if(archived.at(-1)!==pcm[0])archived.push(pcm[0]!);},onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:e=>errors.push(e),onPlaybackReset:(_id,sid)=>resets.push(sid)});
  const audio=(id:string,value:number,samples=480)=>({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(samples).fill(value).buffer).toString('base64')});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  await call.open('first',{silence_timeout_ms:600000,video:true,context:'shared-call-context'});assert.equal(subscriptions.length,1,'open does not wait for subscription');
  emit({type:'response.created',response:{id:'pickup'}});emit(audio('pickup',1));await tick();assert.deepEqual(captured,[]);
  subscriptions[0]!.resolve();t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await tick();assert.deepEqual(captured,[1]);
  emit({type:'response.done',response:{id:'pickup',status:'completed'}});
  emit({type:'error',error:{code:'response_idle_timeout',message:'Your session was closed because no response was generated for 180 seconds.'}});
  await tick();assert.equal(fronts,2);assert.equal(subscriptions.length,2);
  emit({type:'response.created',response:{id:'after-idle'}});emit(audio('after-idle',2,72001));await tick();assert.deepEqual(captured,[1]);
  subscriptions[1]!.resolve();t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await tick();assert.deepEqual(captured,[1,2],'first post-idle PCM reaches subscribed output');
  emit({type:'input_audio_buffer.speech_started'});await ownerInterrupt(call);assert.equal(subscriptions.length,3,'replacement publishes during speech');
  emit(audio('after-idle',99));emit({type:'response.done',response:{id:'after-idle',status:'cancelled'}});
  call.pushPcm(new Int16Array(512));await tick();
  emit({type:'response.created',response:{id:'after-cut'}});emit(audio('after-cut',3,72001));await tick();assert.deepEqual(captured,[1,2]);
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);emit({type:'input_audio_buffer.speech_started'});await ownerInterrupt(call);assert.equal(subscriptions.length,4);
  subscriptions[2]!.resolve();emit(audio('after-cut',99));await tick();assert.deepEqual(captured,[1,2],'a retired subscription releases no queued audio');
  call.pushPcm(new Int16Array(512));await tick();
  emit({type:'response.created',response:{id:'latest'}});emit(audio('latest',4));subscriptions[3]!.resolve();t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await tick();
  assert.deepEqual(captured,[1,2,4]);assert.deepEqual(archived,captured,'archive receives only frames captured by the live output track');assert.deepEqual(resets,['TR_0','TR_1','TR_2']);assert.deepEqual(errors,[]);await call.closeAll();
});

test('held speech transfers its budget to blocked playout; stalls and capacity reject cancel and resume the producer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const failure of ['stall','capacity']){
    const pressure:boolean[]=[],errors:unknown[]=[],resets:string[]=[];let emit!:(event:Record<string,unknown>)=>void,cancelled=0;
    const call=createVoiceCallSession({greeting:{enabled:false},room:()=>({localParticipant:{
      publishTrack:async()=>({sid:'blocked',waitForSubscription:()=>new Promise<void>(()=>{})}),unpublishTrack:async()=>{}}}),
      createFront:callbacks=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},
        setOutputPaused:paused=>pressure.push(paused),respond:async()=>{},context:async()=>{},cancel:()=>{cancelled++;},close:()=>{}};},
      onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error),onPlaybackReset:(_id,sid)=>resets.push(sid)});
    await call.open(failure);pressure.length=0;emit({type:'response.created',response:{id:'burst'}});
    const audio=(samples:number)=>({type:'response.audio.delta',response_id:'burst',delta:Buffer.from(new Int16Array(samples).buffer).toString('base64')});
    emit(audio(18*24000));assert.deepEqual(pressure,[true]);
    t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(errors.length,0,'held→output transfers credit without double admission');
    if(failure==='capacity')emit(audio(13*24000));else t.mock.timers.tick(CALL_PCM_LIMITS.no_progress_ms);
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(pressure,[true,false]);assert.equal(cancelled,1);
    assert.match(String(errors[0]),failure==='capacity'?/VOICE_CALL_PCM_CAPACITY/:/VOICE_CALL_PCM_STALLED/);
    assert.ok(resets.includes('blocked'));const count=errors.length;emit(audio(480));assert.equal(errors.length,count,'late rejected-response audio is discarded');
    await call.closeAll();
  }
});

test('retiring an unsubscribed thinking track releases its PCM but preserves held reply credit',async()=>{
  const budget=new CallPcmBudget(),held=budget.reserve(CALL_PCM_LIMITS.max_samples-24000);
  const output=createCallPlayout({localParticipant:{publishTrack:async()=>({sid:'thinking',waitForSubscription:()=>new Promise<void>(()=>{})}),
    unpublishTrack:async()=>{}}},'credit',()=>{},error=>{throw error;},budget);
  await output.open();output.push(new Int16Array(24000));output.interrupt(true);await new Promise(resolve=>setImmediate(resolve));
  const next=budget.reserve(24000);assert.throws(()=>budget.reserve(1),/VOICE_CALL_PCM_CAPACITY/);
  held.release(CALL_PCM_LIMITS.max_samples-24000);next.release(24000);await output.close();
});

test('ambient and manual prewarm stay restricted and silent; scoped adoption removes connect latency without another front',async t=>{
  const measure=async(warm:boolean,mode:'ambient'|'manual')=>{
    let created=0,appended=0,greeted=0,closed=0,updated=0;
    const connected=Promise.withResolvers<void>(),audio=Promise.withResolvers<void>();
    const callbacks:Parameters<Parameters<typeof createVoiceCallSession>[0]['createFront']>[0][]=[];
    const call=createVoiceCallSession({room:()=>room as never,createFront:cb=>{
      callbacks.push(cb);created++;
      return {connect:async()=>{await new Promise(r=>setTimeout(r,250));connected.resolve();},
        appendAudio:()=>{appended++;},appendImage:()=>{appended++;},context:async()=>({}),respond:async()=>({completed:true}),
        setInstructions:async (instructions,extra)=>{updated++;assert.match(instructions,/PRIVATE_OWNER_CONTEXT/);
          assert.deepEqual(extra?.tools?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn']);},
        greet:async()=>{greeted++;await new Promise(r=>setTimeout(r,100));cb.onEvent({type:'response.audio.delta',response_id:'hello',delta:Buffer.from(new Int16Array(8).buffer).toString('base64')});},
        close:()=>{closed++;}};
    },createPlayout:()=>({open:async()=>{},push:()=>{audio.resolve();},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>{throw error;}});
    if(warm){call.prepare();call.prepare();call.pushPcm(new Int16Array(512));call.pushImage('unused');await connected.promise;
      assert.equal(created,1);assert.equal(appended,0);assert.equal(greeted,0);assert.match(callbacks[0]!.instructions,/身份/);assert.deepEqual(callbacks[0]!.tools,[]);}
    const begun=performance.now();await call.open(`prewarm-${warm}`,{mode,...(mode==='manual'?{context:'PRIVATE_OWNER_CONTEXT'}:{})});
    const front_ms=performance.now()-begun;await audio.promise;const first_audio_ms=performance.now()-begun;
    assert.equal(created,1);assert.equal(greeted,1);assert.equal(updated,warm&&mode==='manual'?1:0);await call.closeAll();assert.equal(closed,1);
    return {front:Math.round(front_ms),audio:Math.round(first_audio_ms)};
  };
  for(const mode of ['ambient','manual'] as const){const cold=await measure(false,mode),warm=await measure(true,mode);
    t.diagnostic(`${mode}: controlled front connect cold=${cold.front}ms prepared=${warm.front}ms; first audio cold=${cold.audio}ms prepared=${warm.audio}ms; inference fixture=100ms`);
    assert.ok(cold.front>=240);assert.ok(warm.front<100);assert.ok(warm.audio<cold.audio-150);}
});

test('manual prepared scope waits for owner context and instruction ACK; hangup at either boundary cannot resurrect it',async()=>{
  for(const cancelAt of ['none','context','ack'] as const){
    const context=Promise.withResolvers<string>(),ack=Promise.withResolvers<void>();
    const log:string[]=[],states:string[]=[];let updates=0,created=0;
    const call=createVoiceCallSession({room:()=>room as never,createFront:callbacks=>{
      created++;assert.doesNotMatch(callbacks.instructions,/PRIVATE/);
      return {connect:async()=>{},appendAudio:()=>{log.push('audio');},appendImage:()=>{log.push('image');},
        respond:async()=>({completed:true}),context:async()=>{},close:()=>{log.push('close');},
        setInstructions:async instructions=>{updates++;assert.match(instructions,/PRIVATE_OWNER_CONTEXT/);await ack.promise;log.push('ack');},
        greet:async()=>{log.push('greet');}};
    },createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    onState:(_id,state)=>states.push(state),onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
    call.prepare();await new Promise(r=>setImmediate(r));
    const opening=call.open('manual-scope',{context:()=>context.promise});
    const rejected=cancelAt==='none'?undefined:assert.rejects(opening,/VOICE_CALL_SUPERSEDED/);
    call.pushPcm(new Int16Array(512));call.pushImage('PRIVATE_CAMERA');
    assert.equal(updates,0);assert.equal(log.length,0);
    if(cancelAt==='context')await call.close('manual-scope','button');
    context.resolve('PRIVATE_OWNER_CONTEXT');await new Promise(r=>setImmediate(r));
    if(cancelAt!=='context'){assert.equal(updates,1);assert.equal(log.length,0);}
    if(cancelAt==='ack')await call.close('manual-scope','button');
    ack.resolve();await (rejected??opening);
    assert.equal(created,1);assert.equal(log.includes('greet'),cancelAt==='none');assert.equal(log.includes('audio'),cancelAt==='none');
    assert.equal(states.includes('live'),cancelAt==='none');await call.closeAll();
  }
});

test('disabled capture discards an unused prewarm and provider close permits one later prepare',async()=>{
  let closed=0,created=0;const callbacks:Parameters<Parameters<typeof createVoiceCallSession>[0]['createFront']>[0][]=[];
  const call=createVoiceCallSession({room:()=>room as never,createFront:cb=>{created++;callbacks.push(cb);return {
    connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},context:async()=>({}),respond:async()=>({}),close:()=>{closed++;}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  call.prepare();await new Promise(r=>setImmediate(r));callbacks[0]!.onClose?.();
  call.prepare();await new Promise(r=>setImmediate(r));assert.equal(created,2);
  call.unprepare();await call.closeAll();assert.equal(closed,1);assert.equal(call.pending(),undefined);
});

test('cancelled or failed prewarm closes once; PCM never retries it and a later wake connects normally',async()=>{
  for(const cancel of [true,false]){
    const ready=Promise.withResolvers<void>();let created=0,closed=0,errors=0;
    const call=createVoiceCallSession({room:()=>room as never,createFront:()=>{created++;return {
      connect:()=>created===1?ready.promise:Promise.resolve(),appendAudio:()=>{},appendImage:()=>{},context:async()=>({}),respond:async()=>({}),close:()=>{closed++;}};},
      createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{errors++;}});
    call.prepare();if(cancel)call.unprepare();ready.reject(new Error('provider unavailable'));
    await new Promise(r=>setImmediate(r));assert.equal(created,1);assert.equal(closed,1);assert.equal(errors,cancel?0:1);
    if(!cancel){for(let frame=0;frame<100;frame++)call.prepare();assert.equal(created,1);
      await call.open('later-wake',{mode:'ambient'});assert.equal(created,2);assert.equal(closed,1);}
    else assert.equal(call.pending(),undefined);
    await call.closeAll();assert.equal(closed,cancel?1:2);
  }
});


test('each accepted reply can reattach its publisher while first audio stays held',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  let emit!:(event:Record<string,unknown>)=>void,opened=0;const played:number[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{opened++;},push:pcm=>played.push(...pcm),interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},
      respond:async()=>({completed:true}),context:async()=>{},close:()=>{}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('reattach');const initial=opened;
  emit({type:'response.created',response:{id:'discarded'},__voiceContext:{suppressed:true}});
  assert.equal(opened,initial);
  for(const id of ['first','later']){
    emit({type:'response.created',response:{id}});
    emit({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array([7]).buffer).toString('base64')});
    const count=played.length;t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS-1);assert.equal(played.length,count);
    t.mock.timers.tick(1);assert.equal(played.length,count+1);
    emit({type:'response.done',response:{id,status:'completed'}});
  }
  assert.equal(opened,initial+2);await call.closeAll();
});


test('a second loss fences a held rejoin announcement without extending the original window',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const room={},source={principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'fixture',consent_ref:'fixture',route_version:'fixture',output_modes:['text' as const]};
  const held=Promise.withResolvers<void>(),states:{state:string;extra:any}[]=[];let hold=false,frontCloses=0;
  const call=createVoiceCallSession({room:()=>room,callRejoinWindowS:2,greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{frontCloses++;}}),
    onState:async(_id,state,extra)=>{if(hold&&state==='live')await held.promise;states.push({state,extra});},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  try{
    await call.open('held-announcement',{source,continuity:'same-conversation'});
    assert.equal(states.at(-1)!.extra.rejoin_deadline,undefined,'healthy opening has no transport-loss deadline');
    call.peerLost(source,'same-conversation');const issued=Date.parse(call.callRejoin()!.rejoin_deadline);hold=true;
    const rejoining=call.rejoin(source,'same-conversation');await new Promise(setImmediate);call.peerLost(source,'same-conversation');const before=states.length;
    await call.rejoin({...source,device_id:'foreign-phone'},'same-conversation');await call.rejoin(source,'foreign-continuity');assert.equal(states.length,before);
    t.mock.timers.tick(issued-Date.now()-1);assert.equal(frontCloses,0);
    t.mock.timers.tick(1);await new Promise(setImmediate);assert.equal(frontCloses,1);assert.equal(call.pending(),undefined);
    held.resolve();await rejoining;await call.rejoin(source,'same-conversation');
    assert.equal(states.at(-1)!.state,'closed');assert.equal(states.at(-1)!.extra.reason,'network');
    assert.equal(Date.parse(states.at(-1)!.extra.rejoin_deadline),issued,'a late announcement cannot reset or extend the loss window');
  }finally{held.resolve();await new Promise(setImmediate);await call.closeAll();}
});

test('verified directed goodbye closes and mirrors once; quoted and guest speech cannot close',async t=>{
  for(const [text,owner,directed,hangup] of [
    ['再见',true,true,true],['拜拜',true,true,true],['退下吧',true,true,true],['再见',{verdict:'owner',call_only:true},true,true],
    ['他说再见是什么意思',true,true,false],['电视里说拜拜',false,true,true],
  ] as const){
    const turns:string[]=[],errors:unknown[]=[],states:string[]=[];
    const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
      identifySpeech:async()=>owner,transcribeSpeech:async()=>text,
      classifySpeech:async()=>({stop:false,guests:'unchanged',directed,hangup}),
      createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
        clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
      onState:(_id,state)=>{states.push(state);},onTranscript:()=>{},onTurn:turn=>{turns.push(turn.user);},onError:error=>errors.push(error)});
    t.after(()=>call.closeAll());await call.open('directed');await ownerInterrupt(call);
    for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
    assert.equal(call.active(),owner&&hangup?undefined:'directed',text);
    if(owner&&hangup){assert.deepEqual(turns,[text]);assert.equal(states.at(-1),'closed');}
    assert.deepEqual(errors,[]);
  }
});

test('false wakes expire while verified owner speech renews the automatic 25 second idle window',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  for(const wake_word of [false,true]){
    const h=harness();await h.call.open('wake',{wake_word});
    h.emit({type:'conversation.item.input_audio_transcription.completed',transcript:'电视背景'});
    t.mock.timers.tick(8000);await new Promise(r=>setImmediate(r));
    assert.equal(h.call.active(),wake_word?undefined:'wake');
    if(wake_word)assert.deepEqual(h.turns,[],'false wake transcripts never become memory observations');
    await h.call.closeAll();
  }
  const ambient=session({},()=>true);await ambient.open('standing-recording',{wake_word:true});
  assert.equal(ambient.captureDecision(),undefined,'an existing microphone source keeps its standing recording permission');await ambient.closeAll();
  const mirrored:string[]=[],states:{state:string;reason?:string}[]=[];
  const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
    transcribeSpeech:async()=> '帮我查一下天气',classifySpeech:async()=>({stop:false,guests:'unchanged',directed:true,hangup:false}),
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:(_id,state,extra)=>{states.push({state,reason:extra?.reason});},onTranscript:()=>{},onTurn:turn=>{mirrored.push(turn.user);},onError:()=>{}});
  t.after(()=>call.closeAll());await call.open('confirmed',{wake_word:true});
  call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
  for(let i=0;i<42;i++){call.pushPcm(new Int16Array(512).fill(1000));await new Promise(r=>setImmediate(r));}
  t.mock.timers.tick(6000);await new Promise(r=>setImmediate(r));
  assert.equal(call.active(),'confirmed','verified owner speech may continue beyond the false-wake window');
  call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
  t.mock.timers.tick(24999);await new Promise(r=>setImmediate(r));assert.equal(call.active(),'confirmed');
  t.mock.timers.tick(1);await new Promise(r=>setImmediate(r));assert.equal(call.pending(),undefined);
  assert.deepEqual(states.at(-1),{state:'closed',reason:'idle'});
  await call.closeAll();assert.deepEqual(mirrored,['帮我查一下天气'],'local committed text mirrors once even without provider input acknowledgement');
});

test('nonowner speech uses one sourced observation without a reply; false wakes keep no transcript',async()=>{
  for(const wake_word of [false,true])for(const verdict of ['guest','unknown','uncertain'] as const){
    const turns:import('../src/voice-call-session.ts').CallTurn[]=[],errors:unknown[]=[],transcripts:string[]=[];
    const fronts:Parameters<Parameters<typeof createVoiceCallSession>[0]['createFront']>[0][]=[];let replies=0,final=-1;
    const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
      identifySpeech:async()=>({verdict,score:.5}),transcribeSpeech:async()=> '电视里说拜拜',
      createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      createFront:callbacks=>{fronts.push(callbacks);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
        clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{replies++;return {completed:true};}};},
      onState:()=>{},onTranscript:(_id,_turn,_role,text)=>{transcripts.push(text);},onSealed:(_id,_reason,turn)=>{final=turn;},onTurn:turn=>{turns.push(turn);},onError:error=>errors.push(error)});
    try{
      await call.open('observed',{wake_word});await ownerInterrupt(call);
      assert.deepEqual(transcripts,!wake_word&&verdict==='uncertain'?['电视里说拜拜']:[],
        'unadmitted speech is archived without projecting it as the owner live transcript');
      if(!wake_word){fronts[0]!.onClose?.();await new Promise(r=>setImmediate(r));
        assert.ok(fronts[1]!.instructions.includes(`${verdict==='uncertain'?'声音待确认':'未确认说话人'}: 电视里说拜拜`));
        assert.ok(!fronts[1]!.instructions.includes('你: 电视里说拜拜'),'reconnect history preserves speaker uncertainty');}
      await call.close('observed','button');await call.closeAll();
      assert.equal(replies,0);assert.deepEqual(errors,[]);
      assert.deepEqual(turns.map(({user,speaker,route})=>({user,speaker,route})),wake_word?[]:[{
        user:'电视里说拜拜',speaker:verdict==='uncertain'?'owner_uncertain':'unknown',route:'front_only'}]);
      assert.equal(final,wake_word?-1:turns[0]!.turn);
    }finally{await call.closeAll();}
  }
});

test('a nonowner observation cannot replace pending owner text or its final close watermark',async()=>{
  const text=Promise.withResolvers<string>(),turns:import('../src/voice-call-session.ts').CallTurn[]=[];let final=-1;
  const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
    identifySpeech:async samples=>samples.at(-1)!>0,transcribeSpeech:async samples=>samples.some(v=>v<0)?'旁人说的话':text.promise,
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
      clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:()=>{},onTranscript:()=>{},onTurn:turn=>{turns.push(turn);},onSealed:(_id,_reason,turn)=>{final=turn;},onError:error=>{throw error;}});
  try{
    await call.open('overlap-observation');await ownerInterrupt(call);
    for(let i=0;i<42;i++){call.pushPcm(new Int16Array(512).fill(-1000));await new Promise(r=>setImmediate(r));}
    call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
    await call.close('overlap-observation','button');assert.equal(call.pending(),undefined);
    text.resolve('整理明天的行程');await call.closeAll();
    assert.equal(turns.length,2);assert.equal(new Set(turns.map(t=>t.turn)).size,2);
    assert.deepEqual(turns.filter(t=>t.speaker==='owner').map(t=>({user:t.user,route:t.route})),[{user:'整理明天的行程',route:'handoff'}]);
    assert.deepEqual(turns.filter(t=>t.speaker==='unknown').map(t=>({user:t.user,route:t.route})),[{user:'旁人说的话',route:'front_only'}]);
    assert.equal(final,Math.max(...turns.map(t=>t.turn)));
  }finally{text.resolve('整理明天的行程');await call.closeAll();}
});


test('call presentation closes before final mirror admission and shutdown joins its existing barrier',async()=>{
  const mirrored=Promise.withResolvers<void>(),h=harness(undefined,mirrored.promise);
  await h.call.open('seal');h.emit({type:'conversation.item.input_audio_transcription.completed',transcript:'整理发票，做完告诉我'});
  const closing=h.call.close('seal','button'),again=h.call.close('seal','button');
  await new Promise(r=>setImmediate(r));assert.equal(h.states.at(-1),'closed');assert.equal(h.turns.length,1);
  mirrored.resolve();assert.equal(await closing,true);assert.equal(await again,true);await h.call.closeAll();assert.equal(h.states.at(-1),'closed');
  assert.equal(h.turns.length,1);
});

test('failed final mirror still retires the call and permits the next call while surfacing failure',async()=>{
  const mirrored=Promise.withResolvers<void>(),h=harness(undefined,mirrored.promise);
  await h.call.open('failed-seal');h.emit({type:'conversation.item.input_audio_transcription.completed',transcript:'请求'});
  const closing=h.call.close('failed-seal','button');mirrored.reject(new Error('MIRROR_ARCHIVE_FAILED'));
  await closing;await assert.rejects(h.call.closeAll(),/MIRROR_ARCHIVE_FAILED/);assert.equal(h.call.pending(),undefined);assert.equal(h.states.at(-1),'closed');
  await h.call.open('next');assert.equal(h.call.active(),'next');await h.call.closeAll();
});

test('hangup stops front and output immediately but preserves committed ASR until its bounded transcription settles',async t=>{
  const text=Promise.withResolvers<string>(),started=Promise.withResolvers<AbortSignal>(),turns:string[]=[],sealed=Promise.withResolvers<void>(),states:string[]=[];let frontClosed=false,outputClosed=false;
  const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
    transcribeSpeech:async(_samples,signal)=>{started.resolve(signal);return new Promise<string>((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('ASR_ABORTED')),{once:true});text.promise.then(resolve,reject);});},
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{outputClosed=true;}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{frontClosed=true;},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:(id,state)=>{states.push(`${id}:${state}`);},onSealed:id=>{if(id==='pending-asr')sealed.resolve();},onTranscript:()=>{},onTurn:turn=>{turns.push(turn.user);},onError:()=>{}});
  t.after(()=>call.closeAll());await call.open('pending-asr');await ownerInterrupt(call);const signal=await started.promise;
  const closing=call.close('pending-asr','button');await new Promise(r=>setImmediate(r));
  assert.equal(frontClosed,true);assert.equal(outputClosed,true);assert.equal(signal.aborted,false,'committed ASR is retained while media stops');
  await closing;await call.open('replacement');assert.equal(call.active(),'replacement');
  text.resolve('明天上午九点提醒我');await sealed.promise;assert.equal(call.active(),'replacement');assert.equal(states.at(-1),'replacement:live','old asynchronous seal cannot overwrite replacement presentation');await call.closeAll();assert.deepEqual(turns,['明天上午九点提醒我']);assert.equal(signal.aborted,true);
});

test('hangup retains a verified mid-utterance tail once without requesting another reply; other voices never gain an owner turn',async()=>{
  for(const speaker of ['owner','guest','changed'] as const){
    const turns:{user:string;interrupted:boolean}[]=[],errors:unknown[]=[];let replies=0;
    const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
      identifySpeech:async samples=>speaker==='guest'?false:samples.at(-1)!>0,
      transcribeSpeech:async()=> '最后这半句话',
      createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{replies++;return {completed:true};}}),
      onState:()=>{},onTranscript:()=>{},onTurn:turn=>{turns.push(turn);},onError:error=>errors.push(error)});
    await call.open(`tail-${speaker}`);call.pushPcm(new Int16Array(512));await new Promise(r=>setImmediate(r));
    for(let i=0;i<36;i++){call.pushPcm(new Int16Array(512).fill(speaker==='changed'&&i>=32?-1000:1000));await new Promise(r=>setImmediate(r));}
    await call.close(`tail-${speaker}`,'button');await call.closeAll();
    assert.equal(replies,0,'final observation never asks the front to answer');
    assert.deepEqual(turns.map(({user,interrupted})=>({user,interrupted})),[{user:'最后这半句话',interrupted:true}]);
    assert.equal((turns[0] as import('../src/voice-call-session.ts').CallTurn).speaker,speaker==='owner'?'owner':'unknown');
    assert.deepEqual(errors,[]);
  }
});

test('terminal speaker failure still mirrors retained committed text and seals the old call once',async()=>{
  const turns:string[]=[],errors:unknown[]=[];let final=false,sealed=0;
  const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
    identifySpeech:async()=>{if(final)throw new Error('FINAL_SPEAKER_FAILED');return true;},transcribeSpeech:async()=> '已经说完的请求',
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>({completed:true})}),
    onState:()=>{},onSealed:()=>{sealed++;},onTranscript:()=>{},onTurn:turn=>{turns.push(turn.user);},onError:error=>errors.push(error)});
  await call.open('failed-tail');await ownerInterrupt(call);
  for(let i=0;i<36;i++){call.pushPcm(new Int16Array(512).fill(1000));await new Promise(r=>setImmediate(r));}
  final=true;await call.close('failed-tail','button');assert.equal(call.pending(),undefined);
  await assert.rejects(call.closeAll(),/FINAL_SPEAKER_FAILED/);
  assert.deepEqual(turns,['已经说完的请求']);assert.equal(sealed,1);assert.equal(errors.length,1);
});

test('guest and mixed tails remain sourced observations without an owner turn',async()=>{
  for(const mixed of [false,true]){
    const turns:import('../src/voice-call-session.ts').CallTurn[]=[],guestChat:string[]=[],errors:unknown[]=[];let guestSpeaking=false,replies=0;
    const call=createVoiceCallSession({...ownerSpeech(),greeting:{enabled:false},room:()=>({}),
      identifySpeech:async samples=>samples.at(-1)!>0,transcribeSpeech:async()=>guestSpeaking?'访客没说完':'允许访客提问',
      classifySpeech:async text=>({stop:false,guests:text==='允许访客提问'?'allow':'unchanged'}),
      createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
      createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{replies++;return {completed:true};}}),
      onState:()=>{},onTranscript:(_id,_turn,role,text,interrupted,identity)=>{if(role==='user'&&identity==='guest'&&interrupted)guestChat.push(text);},
      onTurn:turn=>{turns.push(turn);},onError:error=>errors.push(error)});
    await call.open('allowed-guest');await ownerInterrupt(call);guestSpeaking=true;
    for(let i=0;i<36;i++){call.pushPcm(new Int16Array(512).fill(mixed&&i<32?1000:-1000));await new Promise(r=>setImmediate(r));}
    await call.close('allowed-guest','button');await call.closeAll();
    assert.deepEqual(turns.filter(t=>t.speaker==='owner').map(t=>t.user),['允许访客提问'],'guest tail adds no owner admission');
    assert.deepEqual(turns.filter(t=>t.speaker==='unknown').map(t=>({user:t.user,route:t.route})),[{user:'访客没说完',route:'front_only'}]);
    assert.deepEqual(guestChat,['访客没说完']);assert.equal(replies,1);assert.deepEqual(errors,[]);
  }
});

test('opening receipt exposes the archive gate and accepts bounded early PCM before front connection completes',async t=>{
  const connected=Promise.withResolvers<void>(),directed=Promise.withResolvers<{stop:boolean;guests:'unchanged';directed:boolean;hangup:boolean}>(),classified=Promise.withResolvers<void>();
  const speech=ownerSpeech(),errors:unknown[]=[],states:string[]=[];let vadStreams=0,vadSamples=0,fronts=0,replies=0,uploaded=0;
  let openingGate:Promise<boolean>|undefined,gateAccepted:boolean|undefined;
  const call=createVoiceCallSession({...speech,greeting:{enabled:false},room:()=>({}),
    openVad:async()=>{vadStreams++;const stream=await speech.openVad();return {...stream,write:async samples=>{vadSamples+=samples.length;return stream.write(samples);}};},
    transcribeSpeech:async()=> '帮我查天气',classifySpeech:async()=>{classified.resolve();return directed.promise;},
    createPlayout:()=>({open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>{fronts++;return {connect:()=>connected.promise,appendAudio:()=>{uploaded++;},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},clearInput:()=>{},commitInput:()=>{},requestReply:async()=>{replies++;return {completed:true};}};},
    onState:(_id,state)=>{states.push(state);if(state==='opening'){openingGate=call.captureDecision();void openingGate?.then(value=>{gateAccepted=value;});}},
    onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const opening=call.open('early-wake',{wake_word:true});
  t.after(async()=>{directed.resolve({stop:false,guests:'unchanged',directed:true,hangup:false});connected.resolve();await opening;await call.closeAll();});
  assert.ok(openingGate,'the opening receipt already carries the source-owned archive decision');
  assert.equal(openingGate,call.captureDecision());assert.equal(call.pending(),'early-wake');assert.equal(call.active(),undefined);
  await ownerInterrupt(call);await classified.promise;
  const snapshot=call.resourceSnapshot();assert(snapshot?.limits);assert(snapshot.retained_bytes!==undefined);
  assert.equal(vadStreams,1);assert.ok(vadSamples>0,'first speech reaches the existing detector while connect is pending');
  assert.ok(snapshot.retained_bytes>0);assert.ok(snapshot.retained_bytes<=snapshot.limits.retained_bytes);
  assert.equal(gateAccepted,undefined,'the archive gate stays unresolved before directed owner confirmation');
  assert.deepEqual(states,['opening']);assert.equal(replies,0);assert.equal(uploaded,0);assert.equal(fronts,1);
  directed.resolve({stop:false,guests:'unchanged',directed:true,hangup:false});assert.equal(await openingGate,true);
  assert.equal(call.active(),undefined);assert.equal(replies,0,'confirmation does not create another front or bypass its readiness');
  connected.resolve();await opening;assert.equal(call.active(),'early-wake');assert.deepEqual(errors,[]);
});

test('avatar ON follows current owner identity on an ambient call while OFF remains available',async()=>{
  const changes:boolean[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{},setCallAvatar:async enabled=>{changes.push(enabled);}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},setInstructions:async()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  try{
    await call.open('glasses-call',{mode:'ambient'});
    await assert.rejects(call.setAvatar('glasses-call',true,1),/CALL_AVATAR_OWNER_REQUIRED/);
    await call.setAvatar('glasses-call',false,2);assert.deepEqual(changes,[false]);
    assert.equal(await call.identify('glasses-call','owner'),true);
    await call.setAvatar('glasses-call',true,3);assert.deepEqual(changes,[false,true]);
    assert.equal(await call.identify('glasses-call','guest'),true);
    await assert.rejects(call.setAvatar('glasses-call',true,4),/CALL_AVATAR_OWNER_REQUIRED/);
    await call.setAvatar('glasses-call',false,5);assert.deepEqual(changes,[false,true,false]);
    assert.equal(await call.identify('glasses-call','owner'),false,'ordinary identity cannot promote a guest session');
    assert.equal(await call.identify('glasses-call','owner',undefined,{owner_override:true}),true,'the explicit server override applies to an already open wake session');
  }finally{await call.closeAll();}
});


test('avatar instruction failure settles after the held renderer change without an early stale refresh',async()=>{
  const renderer=Promise.withResolvers<void>(),updates:boolean[]=[];let avatar=false,rejectInstructions=false,settled=false;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},componentVideo:true,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{},
      setCallAvatar:async enabled=>{await renderer.promise;avatar=enabled;}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},
      setInstructions:async()=>{updates.push(avatar);if(rejectInstructions)throw Error('INSTRUCTION_UPDATE_FAILED');}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  try{
    await call.open('held-avatar');assert.deepEqual(updates,[false]);rejectInstructions=true;
    const changing=call.setAvatar('held-avatar',true,1);void changing.then(()=>{settled=true;},()=>{settled=true;});
    const rejected=assert.rejects(changing,/INSTRUCTION_UPDATE_FAILED/);
    await new Promise(setImmediate);
    assert.equal(settled,false,'instruction failure cannot finish the command while renderer activation is pending');
    assert.deepEqual(updates,[false],'no OFF instruction refresh races with pending ON');
    renderer.resolve();await rejected;
    assert.equal(avatar,true);assert.deepEqual(updates,[false,true],'one final refresh observes the settled renderer state');
  }finally{renderer.resolve();await call.closeAll();}
});

test('front reply projection follows actual generation and retires at audio, interruption and hangup',async()=>{
  const replies:{call_id:string;turn:number;active:boolean;closed?:boolean}[]=[],source={principal_id:'owner',device_id:'phone',device_type:'phone'} as never;
  let event!:(value:Record<string,unknown>)=>void;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>{event=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},context:async()=>{},respond:async()=>({completed:true}),close:()=>{}};},
    onReplyState:(_source,call_id,turn,active,closed)=>replies.push({call_id,turn,active,...(closed?{closed}:{})}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>assert.fail(String(error))});
  try{
    await call.open('call-one',{source});
    event({type:'input_audio_buffer.speech_stopped'});assert.equal(replies.at(-1)?.active,true);
    event({type:'response.created',response_id:'r-one'});assert.equal(replies.at(-1)?.active,true);
    event({type:'response.audio.delta',response_id:'r-one',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
    assert.equal(replies.at(-1)?.active,false);
    event({type:'response.created',response_id:'r-two',__voiceContext:{source_turn:7}});assert.equal(replies.at(-1)?.active,true);
    event({type:'input_audio_buffer.speech_started'});assert.deepEqual(replies.at(-1),{call_id:'call-one',turn:7,active:false});
    event({type:'response.created',response_id:'r-three'});assert.equal(replies.at(-1)?.active,true);
    await call.close('call-one','button');assert.deepEqual(replies.at(-1),{call_id:'call-one',turn:0,active:false,closed:true});
  }finally{await call.closeAll();}
});

test('enrollment mode keeps the existing persona and opens with a natural question after context is ready',async()=>{
  const instructions:string[]=[],greetings:string[]=[],errors:unknown[]=[];
  const mode='正在自然聊天录入声音。一次问一个生活问题，顺着回答追问。';
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>{instructions.push(callbacks.instructions);assert.deepEqual(callbacks.tools,[]);assert.throws(()=>callbacks.onTool?.('handoff_to_brain',{}),/CALL_ENROLLMENT_TOOL_DENIED/);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},
      respond:async()=>({completed:true}),context:async()=>{},close:()=>{},greet:async(_event,delivery)=>{greetings.push(delivery);}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  try{
    await call.open('enrollment-call',{enrollment_instructions:mode,context:async()=> '最近喜欢散步'});
    assert.doesNotMatch(instructions[0]!,/最近喜欢散步/);assert.ok(instructions[0]!.includes(mode));
    assert.equal(greetings.length,1);assert.match(greetings[0]!,/提出一个容易展开的生活问题/);
    const guest=frontInstructions({identity:'guest',enrollment:mode,context:'PRIVATE'});
    assert.ok(guest.includes(mode));assert.doesNotMatch(guest,/PRIVATE/);assert.deepEqual(errors,[]);
  }finally{await call.closeAll();}
});


for(const stage of ['context','front','greeting'] as const)test(`a manual dial replaces a call during blocked ${stage} through its own abort`,async()=>{
  const entered=Promise.withResolvers<void>(),blocked=Promise.withResolvers<unknown>();
  const states:string[]=[],errors:unknown[]=[];let blocking=true,openingDone=false,contextSignal:AbortSignal|undefined,frontClosed=0;
  const call=createVoiceCallSession({room:()=>({}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{if(blocking&&stage==='front'){entered.resolve();await blocked.promise;}},
      appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{frontClosed++;},
      greet:async()=>{if(!blocking)return {completed:true};entered.resolve();return blocked.promise;}}),
    onState:(id,state)=>{states.push(`${id}:${state}`);},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const opening=call.open('blocked',{context:async signal=>{
    contextSignal=signal;if(stage==='context'){entered.resolve();await blocked.promise;}return '上下文';
  }}).then(()=>{openingDone=true;},error=>{openingDone=true;assert.match(String(error),/VOICE_CALL_SUPERSEDED/);});
  try{
    await entered.promise;blocking=false;await call.open('replacement',{context:'新上下文'});await opening;
    assert.ok(states.includes('blocked:closing'));assert.ok(states.includes('blocked:closed'));
    assert.ok(states.indexOf('blocked:closed')<states.indexOf('replacement:opening'));assert.equal(contextSignal?.aborted,true);
    assert.equal(openingDone,true,'replacement releases the pending open without waiting for the provider');
    if(stage!=='context')assert.equal(frontClosed,1);
    assert.equal(call.active(),'replacement');
    blocked.resolve({completed:true});await opening;assert.equal(call.active(),'replacement');assert.deepEqual(errors,[]);
  }finally{blocked.resolve({completed:true});await opening;await call.closeAll();}
});

test('a manual dial waits for previous media retirement already closing and then opens',async()=>{
  const retirement=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),states:string[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{entered.resolve();await retirement.promise;}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    onState:(id,state)=>{states.push(`${id}:${state}`);},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('old');const closing=call.close('old','button');await entered.promise;
  let outcome='pending';const opening=call.open('new').then(()=>{outcome='opened';},error=>{outcome=error.code;});
  try{
    await new Promise(setImmediate);assert.equal(outcome,'pending');
    assert.equal(states.some(state=>state.startsWith('new:')),false,'no second session owns the retiring media');
    retirement.resolve();await closing;await opening;assert.equal(outcome,'opened');assert.equal(call.active(),'new');
  }finally{retirement.resolve();await closing;await opening;await call.closeAll();}
});

test('a failed opening reports its terminal state before media retirement can block',async()=>{
  const retirement=Promise.withResolvers<void>(),retiring=Promise.withResolvers<void>(),states:string[]=[];
  const call=createVoiceCallSession({room:()=>({}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{retiring.resolve();await retirement.promise;}}),
    createFront:()=>({connect:async()=>{throw new Error('front unavailable');},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    onState:(_id,state,extra)=>{states.push(state);if(state==='failed'){assert.equal(extra?.reason,'error');assert.equal(extra?.error_code,'VOICE_CALL_OPEN_FAILED');}},
    onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  const opening=assert.rejects(call.open('failed-open'),/VOICE_CALL_CONNECT_FAILED/);
  try{
    await retiring.promise;assert.equal(states.filter(state=>state==='failed').length,1);
    assert.equal(states.includes('closed'),false,'media retirement still owns physical close');
    await assert.rejects(call.open('another',{mode:'ambient'}),/VOICE_CALL_BUSY/);
    retirement.resolve();await opening;assert.equal(states.at(-1),'closed');
    assert.equal(states.filter(state=>state==='failed').length,1);
  }finally{retirement.resolve();await opening;await call.closeAll();}
});

for(const phase of ['live','closing'] as const)for(const kind of ['ambient','wake','say'] as const)
test(`an automatic ${kind} open cannot replace a ${phase} call`,async()=>{
  const retirement=Promise.withResolvers<void>(),retiring=Promise.withResolvers<void>(),states:string[]=[];
  let outputs=0,fronts=0,frontClosed=0;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>{outputs++;return {open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{retiring.resolve();await retirement.promise;}};},
    createFront:()=>{fronts++;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{frontClosed++;}};},
    onState:(id,state)=>{states.push(`${id}:${state}`);},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('owner');const closing=phase==='closing'?call.close('owner','button'):undefined;
  if(closing)await retiring.promise;
  try{
    const before=[...states],closed=frontClosed;
    await assert.rejects(call.open('automatic',kind==='ambient'?{mode:'ambient'}:kind==='wake'?{wake_word:true}:{say:'CARE'}),/VOICE_CALL_BUSY/);
    assert.deepEqual(states,before);assert.equal(frontClosed,closed);assert.equal(outputs,1);assert.equal(fronts,1);
    assert.equal(call.pending(),'owner');assert.equal(call.active(),phase==='live'?'owner':undefined);
  }finally{retirement.resolve();await closing;await call.closeAll();}
});

test('shutdown supersedes a manual dial already waiting for old media retirement',async()=>{
  const retirement=Promise.withResolvers<void>(),retiring=Promise.withResolvers<void>();let outputs=0;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>{outputs++;return {open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{retiring.resolve();await retirement.promise;}};},
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('old');const replaced=assert.rejects(call.open('new'),/VOICE_CALL_SUPERSEDED/);
  try{
    const shutdown=call.closeAll();await retiring.promise;retirement.resolve();await Promise.all([replaced,shutdown]);
    assert.equal(outputs,1);assert.equal(call.pending(),undefined);
  }finally{retirement.resolve();await call.closeAll();}
});

test('rejected old retirement supersedes stale manual dials and rejects the newest without allocating it',async()=>{
  const retirement=Promise.withResolvers<void>(),retiring=Promise.withResolvers<void>(),states:string[]=[];
  const failure=new Error('retirement failed');let outputs=0;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:()=>{outputs++;return {open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{retiring.resolve();await retirement.promise;}};},
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    onState:(id,state)=>{states.push(`${id}:${state}`);},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('old');const closing=call.close('old','button').catch(error=>error);await retiring.promise;
  const stale=call.open('stale').catch(error=>error),latest=call.open('latest').catch(error=>error);
  try{
    await assert.rejects(call.open('automatic',{wake_word:true}),/VOICE_CALL_BUSY/);
    retirement.reject(failure);
    assert.equal((await stale).code,'VOICE_CALL_SUPERSEDED');assert.equal(await latest,failure);assert.equal(await closing,failure);
    assert.equal(outputs,1);assert.equal(call.pending(),undefined);assert.equal(states.at(-1),'old:closed');
  }finally{retirement.resolve();await Promise.all([closing,stale,latest]);await call.closeAll();}
});

for(const phase of ['opening','live','closing'] as const)
test(`a neutral explicit dial replaces a ${phase} call without granting owner identity`,async()=>{
  const entered=Promise.withResolvers<void>(),context=Promise.withResolvers<string>(),retiring=Promise.withResolvers<void>(),retirement=Promise.withResolvers<void>();
  const states:{id:string;state:string;mode?:string}[]=[],instructions:string[]=[],errors:unknown[]=[];
  const dial={mode:'ambient' as const,intent:'dial' as const};
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:(_room,id)=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{
      if(id==='old'&&phase==='closing'){retiring.resolve();await retirement.promise;}}}),
    createFront:options=>{instructions.push(options.instructions);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}};},
    onState:(id,state,extra)=>{states.push({id,state,mode:extra?.mode});},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const old=call.open('old',{...dial,...(phase==='opening'?{context:async()=>{entered.resolve();return context.promise;}}:{})}).catch(error=>error);
  let closing:Promise<boolean>|undefined,replacement:Promise<unknown>|undefined;
  try{
    if(phase==='opening')await entered.promise;else await old;
    if(phase==='closing'){closing=call.close('old','button');await retiring.promise;}
    await assert.rejects(call.open('wake',{...dial,intent:'automatic',wake_word:true}),/VOICE_CALL_BUSY/);
    await assert.rejects(call.open('care',{...dial,intent:'automatic',say:'CARE'}),/VOICE_CALL_BUSY/);
    assert.equal(call.pending(),'old');
    replacement=call.open('new',{...dial,context:'PRIVATE_OWNER_CONTEXT'}).catch(error=>error);
    if(phase==='closing'){await new Promise(setImmediate);assert.equal(states.some(x=>x.id==='new'),false);retirement.resolve();}
    assert.equal(await replacement,undefined);
    if(phase==='opening')assert.equal((await old).code,'VOICE_CALL_SUPERSEDED');
    assert.equal(call.active(),'new');assert.ok(states.indexOf(states.find(x=>x.id==='old'&&x.state==='closed')!)<states.indexOf(states.find(x=>x.id==='new'&&x.state==='opening')!));
    assert.ok(states.filter(x=>x.id==='new').every(x=>x.mode==='ambient'));
    assert.equal(instructions.at(-1),frontInstructions({identity:'pending'}));
    assert.equal(instructions.some(x=>x.includes('PRIVATE_OWNER_CONTEXT')),false);
    assert.equal(await call.identify('new','owner',async()=>'VERIFIED_OWNER_CONTEXT'),true);
    assert.ok(instructions.at(-1)!.includes('VERIFIED_OWNER_CONTEXT'));assert.deepEqual(errors,[]);
  }finally{context.resolve('OLD');retirement.resolve();await Promise.allSettled([old,closing,replacement]);await call.closeAll();}
});

for(const shutdown of [false,true])
test(`neutral explicit dial ${shutdown?'shutdown invalidates':'concurrency selects'} waiting replacements`,async()=>{
  const retiring=Promise.withResolvers<void>(),retirement=Promise.withResolvers<void>(),dial={mode:'ambient' as const,intent:'dial' as const};
  let outputs=0;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    createPlayout:(_room,id)=>{outputs++;return {open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{
      if(id==='old'){retiring.resolve();await retirement.promise;}}};},
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('old',dial);
  const stale=call.open('stale',dial).catch(error=>error),latest=call.open('latest',dial).catch(error=>error);
  const joined=shutdown?call.closeAll():undefined;
  try{
    // A busy rejection on the old implementation is already observable without waiting for a timer.
    const boundary=await Promise.race([retiring.promise.then(()=> 'retiring'),stale.then(()=> 'rejected')]);
    assert.equal(boundary,'retiring');assert.equal(outputs,1);retirement.resolve();
    assert.equal((await stale).code,'VOICE_CALL_SUPERSEDED');
    if(shutdown){assert.equal((await latest).code,'VOICE_CALL_SUPERSEDED');await joined;assert.equal(call.pending(),undefined);assert.equal(outputs,1);}
    else {assert.equal(await latest,undefined);assert.equal(call.active(),'latest');assert.equal(outputs,2);}
  }finally{retirement.resolve();await Promise.allSettled([stale,latest,joined]);await call.closeAll();}
});

const thinkingConfig={enabled:true,reader_instructions:'Read supplied text exactly.',status_text:{greeting:'',waiting:'waiting',slow:'slow',failed:'failed',interrupted:'interrupted',readout_mismatch:'mismatch'}};

test('thinking mode admits canonical session finals once without a realtime answer or local fallback', async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  let event!:(value:Record<string,unknown>)=>void;
  const turns:unknown[]=[],transcripts:string[]=[],created:unknown[]=[],states:CallStateExtra[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>{event=callbacks.onEvent;created.push(callbacks);return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{throw Error('autonomous reply');},context:async()=>{},close:()=>{}};},
    onState:(_id,_state,extra)=>{states.push(extra??{});},onTranscript:(_id,_turn,role,text)=>{if(role==='user')transcripts.push(text);},onTurn:turn=>{turns.push(turn);},onError:error=>{throw error;}});
  await call.open('thinking',{conversation_mode:'thinking'});
  assert.equal((created[0] as {conversation_mode:string}).conversation_mode,'thinking');
  assert.deepEqual((created[0] as {tools:unknown[]}).tools,[]);
  event({type:'input_audio_buffer.committed',item_id:'canonical'});
  event({type:'conversation.item.input_audio_transcription.completed',item_id:'canonical',transcript:'核对这个决定'});
  event({type:'conversation.item.input_audio_transcription.completed',item_id:'canonical',transcript:'重复'});
  assert.deepEqual(transcripts,['核对这个决定']);
  assert.equal(turns.length,1);
  assert.equal((turns[0] as {handoff?:unknown}).handoff,undefined,'mode selection leaves reasoning and intent authority to the brain');
  assert.deepEqual(turns[0],{call_id:'thinking',turn:0,user:'核对这个决定',assistant:'',interrupted:false,route:'handoff',speaker:'unknown'});
  const readout={source_turn:0,message_id:'answer-1',sentence_index:0,readout_text:'主脑原文。',readout_last:true};
  event({type:'response.created',response:{id:'readout'},__voiceContext:readout});
  event({type:'response.audio.delta',response_id:'readout',delta:Buffer.from(new Int16Array(240).buffer).toString('base64'),__voiceContext:readout});
  event({type:'response.audio_transcript.delta',response_id:'readout',delta:'主脑原文。',__voiceContext:readout});
  t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);
  event({type:'response.done',response:{id:'readout',status:'completed'},__voiceContext:readout});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(turns.length,1,'readout never re-enters onTurn or fabricates an assistant-only brain input');
  await call.thinkingStatus('thinking','waiting','event-1');t.mock.timers.tick(2000);await Promise.resolve();
  assert.deepEqual(states.at(-1)?.thinking_status,{state:'slow',text:'slow',actions:['retry','switch_to_chat']});
  assert.equal(states.at(-1)?.processed_event_id,'event-1');
  await call.closeAll();
});

test('mode activation waits for input boundary, avatar retirement and provider acknowledgment',async()=>{
  let event!:(value:Record<string,unknown>)=>void;
  const retired=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>(),order:string[]=[];
  let rejectUpdate=false;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{},setCallAvatar:async enabled=>{order.push(`avatar:${enabled}`);await retired.promise;}}),
    createFront:callbacks=>{event=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},setInstructions:async(_text,opts)=>{order.push(`update:${opts?.conversation_mode}`);if(rejectUpdate)throw Error('provider rejected');await ack.promise;}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('switch',{avatar:true});
  event({type:'input_audio_buffer.committed',item_id:'before-switch'});
  const switchMode=call.setConversationMode('switch','thinking');
  await Promise.resolve();assert.deepEqual(order,[]);
  event({type:'conversation.item.input_audio_transcription.completed',item_id:'before-switch',transcript:'先完成这句话'});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['avatar:false']);
  assert.equal(call.conversationMode('switch'),'chat');retired.resolve();
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['avatar:false','update:thinking']);
  assert.equal(call.conversationMode('switch'),'chat');await assert.rejects(call.setAvatar('switch',true),/CALL_THINKING_AVATAR_DISABLED/);ack.resolve();await switchMode;
  assert.equal(call.conversationMode('switch'),'thinking');
  await assert.rejects(call.setAvatar('switch',true),/CALL_THINKING_AVATAR_DISABLED/);
  rejectUpdate=true;await assert.rejects(call.setConversationMode('switch','chat'),/provider rejected/);
  assert.equal(call.conversationMode('switch'),'thinking');
  await call.closeAll();
});

test('mode controls reserve call ordering before authorization and replay the same receipt promise',async()=>{
  const authorization=Promise.withResolvers<void>(),order:string[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},setInstructions:async(_text,opts)=>{order.push(`update:${opts?.conversation_mode}`);}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('ordered');
  const first=call.setConversationMode('ordered','thinking',{id:'first',authorize:async()=>{order.push('authorize:first');await authorization.promise;},confirmed:async()=>{order.push('confirm:first');}});
  const duplicate=call.setConversationMode('ordered','thinking',{id:'first',authorize:async()=>{throw Error('duplicate authorization');},confirmed:async()=>{throw Error('duplicate persistence');}});
  assert.equal(first,duplicate);
  assert.throws(()=>call.setConversationMode('ordered','chat',{id:'first',authorize:async()=>{},confirmed:async()=>{}}),/CALL_MODE_CONTROL_CONFLICT/);
  const second=call.setConversationMode('ordered','chat',{id:'second',authorize:async()=>{order.push('authorize:second');},confirmed:async()=>{order.push('confirm:second');}});
  await Promise.resolve();assert.deepEqual(order,['authorize:first']);
  authorization.resolve();await Promise.all([first,second]);
  assert.deepEqual(order,['authorize:first','update:thinking','confirm:first','authorize:second','update:chat','confirm:second']);
  assert.equal(call.conversationMode('ordered'),'chat');await call.closeAll();
});

test('thinking status: a final result for the bound turn ends waiting or slow; another turn or a failure stays',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const states:CallStateExtra[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{}}),
    onState:(_id,_state,extra)=>{states.push(extra??{});},onTranscript:()=>{},onTurn:()=>{},onError:error=>{throw error;}});
  await call.open('settle',{conversation_mode:'thinking'});
  await call.thinkingStatus('settle','waiting','event-1');t.mock.timers.tick(2000);await Promise.resolve();
  assert.equal(states.at(-1)?.thinking_status?.state,'slow');
  let count=states.length;await call.thinkingSettled('settle','event-0');
  assert.equal(states.length,count,'an older result never ends the current turn');
  await call.thinkingSettled('settle','event-1');
  assert.equal(states.at(-1)?.thinking_status,undefined,'no 较慢/重试 left after the turn ended');
  assert.equal(states.at(-1)?.conversation_mode,'thinking');
  await call.thinkingStatus('settle','waiting','event-2');await call.thinkingSettled('settle','event-2');
  count=states.length;t.mock.timers.tick(2000);await Promise.resolve();
  assert.equal(states.length,count,'a settled turn never turns slow later');
  await call.thinkingStatus('settle','failed','event-3');count=states.length;await call.thinkingSettled('settle','event-3');
  assert.equal(states.length,count,'a real failure stays visible with its retry');
  await call.thinkingStatus('settle','waiting');assert.equal(states.at(-1)?.processed_event_id,undefined,'a new turn never shows the previous result id');
  await call.closeAll();
});

test('thinking readout: transcript differences are archived only; a readout with no audio is the failure the owner sees',async t=>{
  let event!:(value:Record<string,unknown>)=>void;
  const states:CallStateExtra[]=[],archived:{call_id:string;type?:string;evidence:unknown}[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    onReadoutFidelity:async(_source,call_id,evidence)=>{archived.push({call_id,evidence});},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>{event=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{}};},
    onState:(_id,_state,extra)=>{states.push(extra??{});},onTranscript:()=>{},onTurn:()=>{},onError:error=>{throw error;}});
  t.after(()=>call.closeAll());await call.open('readout',{conversation_mode:'thinking'});
  await call.thinkingStatus('readout','waiting','event-1');
  const evidence=(sentence_index:number)=>({message_id:'answer',sentence_index,response_id:`r-${sentence_index}`,source_text:'-5 到 8。',transcript_text:'负五到八。'}),before=states.length;
  for(const [index,type] of ['thinking.readout_transcript_mismatch','thinking.readout_transcript_missing'].entries())event({type,readout_fidelity:evidence(index)});
  await new Promise(setImmediate);
  assert.deepEqual(archived.map(row=>row.evidence),[evidence(0),evidence(1)]);
  assert.equal(states.length,before,'no status, notice or projected evidence for a transcript difference');
  event({type:'thinking.readout_audio_missing',readout_fidelity:evidence(2)});
  await new Promise(setImmediate);
  assert.equal(archived.length,3);
  assert.deepEqual(states.at(-1)?.thinking_status,{state:'failed',text:'failed',actions:['retry','switch_to_chat']});
  assert.equal(states.at(-1)?.processed_event_id,'event-1');
  assert.equal(states.some(extra=>'readout_fidelity' in extra),false);
});

test('thinking care and ambient pickup read authoritative text without spoken delivery instructions',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const spoken:string[]=[],messageIds:(string|undefined)[]=[];let response=0;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:{...thinkingConfig,status_text:{...thinkingConfig.status_text,greeting:'配置问候'}},
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:callbacks=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},context:async()=>{},close:()=>{},greet:async()=>{assert.fail('thinking care must use literal respond');},
      respond:async(text,_current,context)=>{spoken.push(text);messageIds.push(context?.message_id);const id=`care-${++response}`,ctx={...context,readout_text:text,sentence_index:0,readout_last:true};
        callbacks.onEvent({type:'response.created',response:{id},__voiceContext:ctx});
        callbacks.onEvent({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(240).buffer).toString('base64'),__voiceContext:ctx});
        callbacks.onEvent({type:'response.audio_transcript.delta',response_id:id,delta:text,__voiceContext:ctx});
        callbacks.onEvent({type:'response.done',response:{id,status:'completed'},__voiceContext:ctx});
        return {completed:true};}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{assert.fail('readout is not new user input');},onError:()=>{}});
  const opening=call.open('ambient-thinking',{mode:'ambient',say:'原始关怀正文',say_message_id:'care-timeline-id',conversation_mode:'thinking'});
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await opening,'原始关怀正文');assert.deepEqual(spoken,['原始关怀正文']);
  await call.closeAll();await call.open('care-thinking',{conversation_mode:'thinking'});
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(resolve=>setImmediate(resolve));
  const care=call.respond('后续关怀正文',{call_id:'care-thinking',identity:'owner',message_id:'reach-id'},true);
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await care,true);assert.deepEqual(spoken,['原始关怀正文','配置问候','后续关怀正文']);assert.deepEqual(messageIds,['care-timeline-id','care-thinking:greeting','reach-id']);await call.closeAll();
});

test('a rejected persisted mode preference restores the acknowledged front before rejecting control',async()=>{
  const updates:{instructions:string;mode:string|undefined;tools:unknown[]|undefined}[]=[];
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},thinking_mode:thinkingConfig,
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({completed:true}),context:async()=>{},close:()=>{},
      setInstructions:async(instructions,opts)=>{updates.push({instructions,mode:opts?.conversation_mode,tools:opts?.tools});}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:()=>{}});
  await call.open('persistence');
  await assert.rejects(call.setConversationMode('persistence','thinking',{id:'disk-full',authorize:async()=>{},confirmed:async()=>{throw Error('preference disk full');}}),/preference disk full/);
  assert.equal(call.conversationMode('persistence'),'chat');
  assert.equal(updates.length,2);assert.equal(updates[0]?.mode,'thinking');assert.deepEqual(updates[0]?.tools,[]);
  assert.equal(updates[1]?.mode,'chat');assert.equal(updates[1]?.instructions,frontInstructions({identity:'owner',vision:true,expressive:true}));
  assert.ok(updates[1]?.tools?.length);await call.closeAll();
});
