import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalMediaExecution, type LocalMediaCommand } from '../src/media/local-execution.ts';
import {childPid} from './child-pid-fixture.ts';
import {timeoutClock} from './timeout-clock-fixture.ts';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const command = (source: string, root: string, overrides: Partial<LocalMediaCommand> = {}): LocalMediaCommand => ({
    executable: process.execPath, args: ['-e', source], cwd: root, stdin_limit_bytes: 0,
    stdout_limit_bytes: 1024, stderr_limit_bytes: 1024, stderr_mode: 'lossless', ...overrides
});
async function fixture(t: test.TestContext, slots = 1) {
    const root = await fs.mkdtemp(join(tmpdir(), 'media-owner-'));
    const owner = await LocalMediaExecution.create({ runtime: root, slots });
    t.after(async () => { await owner.close(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, owner };
}

test('shared decode/audio admission and canonical legacy audio exclusion, no automatic stale cleanup', async t => {
    const { root, owner } = await fixture(t);
    const second = await LocalMediaExecution.create({ runtime: root, slots: 1 });
    t.after(() => second.close());
    await assert.rejects(LocalMediaExecution.create({ runtime: root, slots: 2 }), /LOCAL_MEDIA_CONFIG_CONFLICT/);
    const held = await owner.reserve('decode', signal(), 2000);
    await assert.rejects(second.reserve('audio', signal(), 2000), /LOCAL_AUDIO_BUSY/);
    await held.release();
    await fs.mkdir(join(root, 'media', '.local-audio-lease'));
    await assert.rejects(owner.reserve('audio', signal(), 2000), /LOCAL_AUDIO_BUSY/);
    assert.ok(await fs.stat(join(root, 'media', '.local-audio-lease')));
    const decode = await owner.reserve('decode', signal(), 2000);
    await decode.release();
    await fs.rmdir(join(root, 'media', '.local-audio-lease'));
    const audio = await owner.reserve('audio', signal(), 2000);
    await assert.rejects(second.reserve('decode', signal(), 2000), /DEMUX_BUSY/);
    await audio.release();
});

test('wall clock adjustment during acquisition does not invalidate the operation deadline', async t => {
    const { root, owner } = await fixture(t);
    const mkdir = fs.mkdir.bind(fs);
    let wallClock = 0;
    t.mock.method(Date, 'now', () => wallClock);
    t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
        const value = await mkdir(...args);
        wallClock = 1_000_000_000;
        return value;
    });
    const reservation = await owner.reserve('decode', signal(), 2000);
    try {
        const result = await reservation.run(command("process.stdout.write('joined');", root));
        assert.equal(result.stdout.toString(), 'joined');
    } finally { await reservation.release(); }
});

test('two actual Node processes share fixed capacity and audio domain', async t => {
    const { root, owner } = await fixture(t);
    const held = await owner.reserve('audio', signal(), 3000);
    const module = new URL('../src/media/local-execution.ts', import.meta.url).href;
    const source = `import {LocalMediaExecution} from ${JSON.stringify(module)};
const owner=await LocalMediaExecution.create({runtime:process.argv[1],slots:1});
try {const held=await owner.reserve('decode',new AbortController().signal,1000);await held.release();console.log('ADMITTED');}
catch(error){console.log(error.message);}finally{await owner.close();}`;
    const busy = await exec(process.execPath, ['--input-type=module', '-e', source, root]);
    assert.match(busy.stdout, /DEMUX_BUSY/);
    await held.release();
    const admitted = await exec(process.execPath, ['--input-type=module', '-e', source, root]);
    assert.match(admitted.stdout, /ADMITTED/);
});

test('binary output remains lossless; Unicode budgets count bytes and stderr tail is bounded bytes', async t => {
    const { root, owner } = await fixture(t);
    const good = await owner.reserve('decode', signal(), 2000);
    const result = await good.run(command("process.stdout.write(Buffer.from([0,255,128]));process.stderr.write('€€');", root,
        { stdout_limit_bytes: 3, stderr_limit_bytes: 6 }));
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 128]));
    assert.equal(result.stderr.toString(), '€€');
    await good.release();
    const stdout = await owner.reserve('audio', signal(), 2000);
    await assert.rejects(stdout.run(command("process.stdout.write('€€');", root, { stdout_limit_bytes: 5 })), /LOCAL_AUDIO_OUTPUT_BUDGET/);
    await stdout.release();
    const stderr = await owner.reserve('decode', signal(), 2000);
    await assert.rejects(stderr.run(command("process.stderr.write('€€');", root, { stderr_limit_bytes: 5 })), /DEMUX_METADATA_BUDGET/);
    await stderr.release();
    const tail = await owner.reserve('audio', signal(), 2000);
    const captured = await tail.run(command("process.stderr.write('123456789€');", root,
        { stderr_mode: 'tail', stderr_limit_bytes: 3 }));
    assert.equal(captured.stderr.length, 3);
    assert.equal(captured.stderr.toString(), '€');
    await tail.release();
});

test('timeout and cancellation join actual child close before shared quota is released', async t => {
    const { root, owner } = await fixture(t);
    // Bootstrap the real child before advancing the controlled operation deadline.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clock = t.mock.method(performance, 'now', () => 0);
    for (const mode of ['timeout', 'cancel', 'release', 'close'] as const) {
        const local = mode === 'close' ? await LocalMediaExecution.create({ runtime: root, slots: 1 }) : owner;
        const abort = new AbortController();
        const reservation = await local.reserve('decode', abort.signal, mode === 'timeout' ? 200 : 2000);
        const started = Promise.withResolvers<number>();
        let announced = '';
        const child = reservation.open(command("process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000);", root), bytes => {
            announced += bytes.toString();
            if (announced.endsWith('\n')) started.resolve(Number(announced));
        });
        const rejected = assert.rejects(child.done, mode === 'timeout' ? /DEMUX_TIMEOUT/ : mode === 'cancel' ? /DEMUX_CANCELLED/ : /DEMUX_CLOSED/);
        const pid = await started.promise;
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        await assert.rejects(owner.reserve('audio', signal(), 2000), /LOCAL_AUDIO_BUSY/);
        if (mode === 'timeout') t.mock.timers.tick(200);
        if (mode === 'cancel') abort.abort();
        if (mode === 'release') await reservation.release();
        if (mode === 'close') {
            const closing = local.close();
            assert.strictEqual(local.close(), closing);
            await closing;
        }
        await rejected;
        await reservation.release();
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        const next = await owner.reserve('audio', signal(), 2000);
        await next.release();
    }
    t.mock.timers.reset();
    clock.mock.restore();
});

test('stdin error retains first failure and joins child; input admission rejects bytes before spawn', async t => {
    const { root, owner } = await fixture(t);
    const input = await owner.reserve('audio', signal(), 2000);
    await assert.rejects(input.run(command("throw Error('must not spawn');", root,
        { stdin: Buffer.alloc(2), stdin_limit_bytes: 1 })), /LOCAL_AUDIO_INPUT_BUDGET/);
    await input.release();
    const broken = await owner.reserve('audio', signal(), 2000);
    await assert.rejects(broken.run(command("require('node:fs').closeSync(0);setInterval(()=>{},1000);", root,
        { stdin: Buffer.alloc(2_000_000), stdin_limit_bytes: 2_000_000 })), /EPIPE|ECONNRESET/);
    await broken.release();
    const next = await owner.reserve('decode', signal(), 2000);
    await next.release();
});

test('close fences pending acquisition and idle reservations with a stable join promise', async t => {
    const { root, owner } = await fixture(t);
    const pending = owner.reserve('decode', signal(), 2000);
    const rejected = assert.rejects(pending, /DEMUX_CLOSED/);
    const closing = owner.close();
    assert.strictEqual(owner.close(), closing);
    await Promise.all([closing, rejected]);
    await assert.rejects(owner.reserve('audio', signal(), 2000), /LOCAL_AUDIO_CLOSED/);
    const second = await LocalMediaExecution.create({ runtime: root, slots: 1 });
    const idle = await second.reserve('decode', signal(), 2000);
    await second.close();
    assert.throws(() => idle.assertReady(), /DEMUX_CLOSED/);
    await assert.rejects(idle.run(command("console.log('must not run')", root)), /DEMUX_CLOSED/);
    await idle.release();
    const third = await LocalMediaExecution.create({ runtime: root, slots: 1 });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(third.reserve('decode', aborted.signal, 2000), /DEMUX_CANCELLED/);
    await third.close();
});


test('close reports owned cleanup failure only after every reserved child joins', async t => {
    const root=await fs.mkdtemp(join(tmpdir(),'media-owner-cleanup-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const owner=await LocalMediaExecution.create({runtime:root,slots:2});
    timeoutClock(t);t.mock.method(performance,'now',()=>0);
    const audio=await owner.reserve('audio',signal(),3000);
    await fs.writeFile(join(root,'media','.local-audio-lease','controlled-blocker'),'fixture');
    const decode=await owner.reserve('decode',signal(),3000);
    const child=childPid(t,root,'cleanup-child.pid');
    const running=decode.run(command(child.source+'setInterval(()=>{},1000);',root));
    const rejected=assert.rejects(running,/DEMUX_CLOSED/);
    const pid=await child.ready;
    // Delay the second release's observable join; close must not reject at the first failed cleanup.
    const release=decode.release.bind(decode);
    let joined=false,settled=false;const joining=Promise.withResolvers<void>(),joinGate=Promise.withResolvers<void>();t.after(()=>joinGate.resolve());
    decode.release=async()=>{await release();joining.resolve();await joinGate.promise;joined=true;};
    const closing=owner.close();
    void closing.then(()=>{settled=true;},()=>{settled=true;});
    await joining.promise;assert.equal(settled,false);joinGate.resolve();
    await assert.rejects(closing,{code:'ENOTEMPTY'});
    assert.equal(joined,true);
    await rejected;
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    await assert.rejects(audio.release(),{code:'ENOTEMPTY'});
    assert.ok(await fs.stat(join(root,'media','.local-audio-lease')));
});

test('one operation deadline spans sequential real children',async t=>{
    const {root,owner}=await fixture(t);
    t.mock.timers.enable({apis:['setTimeout']});
    const clock=t.mock.method(performance,'now',()=>0);
    const held=await owner.reserve('decode',signal(),300);
    try {
        await held.run(command('setTimeout(()=>{},180);',root));
        t.mock.timers.tick(180);
        const rejected=assert.rejects(held.run(command('setTimeout(()=>{},180);',root)),/DEMUX_TIMEOUT/);
        t.mock.timers.tick(119);
        held.assertReady();
        t.mock.timers.tick(1);
        assert.throws(()=>held.assertReady(),/DEMUX_TIMEOUT/);
        await rejected;
    } finally {
        await held.release();
        t.mock.timers.reset();
        clock.mock.restore();
    }
});

test('audio domain remains exclusive across processes when a second shared slot is free',async t=>{
    const {root,owner}=await fixture(t,2);
    const audio=await owner.reserve('audio',signal(),3000);
    const module=new URL('../src/media/local-execution.ts',import.meta.url).href;
    const source=`import {LocalMediaExecution} from ${JSON.stringify(module)};
const owner=await LocalMediaExecution.create({runtime:process.argv[1],slots:2});
try {const held=await owner.reserve(process.argv[2],new AbortController().signal,1000);await held.release();console.log('ADMITTED');}
catch(error){console.log(error.message);}finally{await owner.close();}`;
    assert.match((await exec(process.execPath,['--input-type=module','-e',source,root,'audio'])).stdout,/LOCAL_AUDIO_BUSY/);
    assert.match((await exec(process.execPath,['--input-type=module','-e',source,root,'decode'])).stdout,/ADMITTED/);
    await audio.release();
});
