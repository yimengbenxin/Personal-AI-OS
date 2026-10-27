import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalMediaExecution, type LocalMediaCommand} from '../src/media/local-execution.ts';
import {childPid} from './child-pid-fixture.ts';
import {timeoutClock} from './timeout-clock-fixture.ts';
const signal = () => new AbortController().signal;
const command = (source: string, root: string, overrides: Partial<LocalMediaCommand> = {}): LocalMediaCommand => ({
    executable: process.execPath, args:['-e',source], cwd:root,
    env:{PATH:'/usr/bin:/bin', PAIOS_CONTROLLED_CHILD:'1'}, stdin_limit_bytes:1024,
    stdout_limit_bytes:1024, stderr_limit_bytes:1024, stderr_mode:'lossless', ...overrides
});
async function fixture(t: test.TestContext, vad = 1) {
    const root = await fs.mkdtemp(join(tmpdir(), 'duplex-'));
    const owner = await LocalMediaExecution.create({runtime:root,slots:1,vad_slots:vad});
    t.after(async()=>{await owner.close();await fs.rm(root,{recursive:true,force:true});});
    return {root,owner};
}
const echo = "process.stdin.on('data',b=>process.stdout.write(b));";

test('VAD topology is immutable and separately budgeted across instances',async t=>{
    const {root,owner}=await fixture(t);
    const second=await LocalMediaExecution.create({runtime:root,slots:1,vad_slots:1});
    t.after(()=>second.close());
    await assert.rejects(LocalMediaExecution.create({runtime:root,slots:1}),/CONFIG_CONFLICT/);
    await assert.rejects(LocalMediaExecution.create({runtime:root,slots:16,vad_slots:1}),/LOCAL_MEDIA_CONFIG/);
    const vad=await owner.reserve('vad',signal(),3000);
    const audio=await second.reserve('audio',signal(),3000);
    assert.equal(await owner.available('vad'),false);
    await assert.rejects(second.reserve('vad',signal(),3000),/LOCAL_VAD_BUSY/);
    await assert.rejects(owner.reserve('decode',signal(),3000),/DEMUX_BUSY/);
    await vad.release();
    // Failed acquisition did not remove another instance's audio lease/slot.
    await assert.rejects(owner.reserve('audio',signal(),3000),/LOCAL_AUDIO_BUSY/);
    await audio.release();
    const fresh=await second.reserve('vad',signal(),3000);await fresh.release();
});

test('zero VAD preserves legacy identity and reports explicit unavailability',async t=>{
    const {root,owner}=await fixture(t,0);
    assert.equal(await fs.readFile(join(root,'media','.local-execution-config'),'utf8'),'{"schema":"paios.local-media-execution.v1","slots":1}');
    assert.equal(await owner.available('vad'),false);
    await assert.rejects(owner.reserve('vad',signal(),1000),/LOCAL_VAD_UNAVAILABLE/);
});

test('normal duplex bytes are delivered once, end joins, writes and second use fenced',async t=>{
    const {root,owner}=await fixture(t);
    const held=await owner.reserve('vad',signal(),3000);const output:Buffer[]=[];
    const exchange=held.open(command(echo,root),bytes=>output.push(Buffer.from(bytes)));
    await assert.rejects(held.run(command(echo,root)),/RESERVATION_ACTIVE/);
    assert.throws(()=>held.open(command(echo,root),()=>{}),/RESERVATION_ACTIVE/);
    await exchange.write(Buffer.from([0,255,128]));await exchange.write(Buffer.from('€'));
    assert.strictEqual(exchange.end(),exchange.done);
    const result=await exchange.done;
    assert.deepEqual(Buffer.concat(output),Buffer.from([0,255,128,226,130,172]));
    assert.equal(result.stdout.length,0);
    await assert.rejects(exchange.write(Buffer.from('x')),/INPUT_CLOSED/);
    await assert.rejects(held.run(command(echo,root)),/RESERVATION_ACTIVE/);
    await held.release();
});

test('blocked stdin native write has single active promise; end drains and closes',async t=>{
    const {root,owner}=await fixture(t);const held=await owner.reserve('vad',signal(),3000);
    const exchange=held.open(command("setTimeout(()=>process.stdin.resume(),150);",root,{stdin_limit_bytes:4_000_000}),()=>{});
    const writing=exchange.write(Buffer.alloc(4_000_000));
    await assert.rejects(exchange.write(Buffer.from('x')),/INPUT_BUSY/);
    const ending=exchange.end();await writing;await ending;await held.release();
});

test('input/stdout/stderr bounds and callback failures kill and join',async t=>{
    const {root,owner}=await fixture(t);
    for(const mode of ['input','stdout','stderr','callback','async'] as const){
        const held=await owner.reserve('vad',signal(),3000);
        const source=mode==='stderr'?"process.stderr.write('xx');setInterval(()=>{},1000);":echo;
        const exchange=held.open(command(source,root,{stdin_limit_bytes:mode==='input'?1:1024,
            stdout_limit_bytes:mode==='stdout'?1:1024,stderr_limit_bytes:mode==='stderr'?1:1024}),
            mode==='callback'?()=>{throw new Error('controlled-callback');}:mode==='async'?async()=>{}:()=>{});
        const failure=assert.rejects(exchange.done,mode==='input'?/INPUT_BUDGET/:mode==='stdout'?/OUTPUT_BUDGET/:
            mode==='stderr'?/METADATA_BUDGET/:mode==='callback'?/controlled-callback/:/ASYNC_CALLBACK/);
        if(mode==='input')await assert.rejects(exchange.write(Buffer.from('xx')),/INPUT_BUDGET/);
        else if(mode!=='stderr')await exchange.write(Buffer.from('xx'));
        await failure;await held.release();assert.equal(await owner.available('vad'),true);
    }
});

test('abort/release/owner close/timeout settle blocked write and join actual child',async t=>{
    const {root,owner}=await fixture(t);
    const clock=timeoutClock(t);t.mock.method(performance,'now',()=>0);
    for(const mode of ['abort','release','close','timeout'] as const){
        const local=mode==='close'?await LocalMediaExecution.create({runtime:root,slots:1,vad_slots:1}):owner;
        const abort=new AbortController();const held=await local.reserve('vad',abort.signal,mode==='timeout'?500:3000);
        const child=childPid(t,root,`${mode}.pid`);
        const exchange=held.open(command(child.source+'setInterval(()=>{},1000);',root,{stdin_limit_bytes:4_000_000}),()=>{});
        const writing=assert.rejects(exchange.write(Buffer.alloc(4_000_000)),mode==='abort'?/MEDIA_CANCELLED/:mode==='timeout'?/TIMEOUT/:/CLOSED/);
        const done=assert.rejects(exchange.done,mode==='abort'?/MEDIA_CANCELLED/:mode==='timeout'?/TIMEOUT/:/CLOSED/);
        const pid=await child.ready;
        assert(Number.isSafeInteger(pid)&&pid>0,'child must publish a complete positive PID');
        if(mode==='abort')abort.abort();else if(mode==='release')await held.release();else if(mode==='close')await local.close();
        else clock.tick(500);
        await Promise.all([writing,done]);await held.release();
        assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
        assert.equal(await owner.available('vad'),true);
    }
});

test('duplex child exit/error handles pending write and explicit callback contract',async t=>{
    const {root,owner}=await fixture(t);
    const held=await owner.reserve('vad',signal(),3000);
    assert.throws(()=>held.open(command(echo,root,{stderr_mode:'tail'}),()=>{}),/LOSSLESS_STDERR/);
    const exchange=held.open(command("require('node:fs').closeSync(0);setInterval(()=>{},1000);",root,{stdin_limit_bytes:4_000_000}),()=>{});
    const done=assert.rejects(exchange.done,/EPIPE|ECONNRESET/);
    await assert.rejects(exchange.write(Buffer.alloc(4_000_000)),/EPIPE|ECONNRESET/);
    await done;await held.release();
});

test('persistent VAD child and finite audio child run together; other process observes VAD conflict',async t=>{
    const {root,owner}=await fixture(t);
    const vad=await owner.reserve('vad',signal(),3000);
    const chunks:Buffer[]=[];const exchange=vad.open(command(echo,root),bytes=>chunks.push(Buffer.from(bytes)));
    await exchange.write(Buffer.from('vad'));
    const audio=await owner.reserve('audio',signal(),3000);
    const result=await audio.run(command("process.stdout.write('moss-controlled-child');",root));
    assert.equal(result.stdout.toString(),'moss-controlled-child');await audio.release();
    const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
    const module=new URL('../src/media/local-execution.ts',import.meta.url).href;
    const source=`import {LocalMediaExecution} from ${JSON.stringify(module)};const o=await LocalMediaExecution.create({runtime:process.argv[1],slots:1,vad_slots:1});try{await o.reserve('vad',new AbortController().signal,1000);}catch(e){console.log(e.message);}finally{await o.close();}`;
    const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',source,root],{cwd:root,env:{PATH:'/usr/bin:/bin',PAIOS_CONTROLLED_CHILD:'1'}});
    assert.match(child.stdout,/LOCAL_VAD_BUSY/);
    await exchange.end();assert.equal(Buffer.concat(chunks).toString(),'vad');await vad.release();
});

test('actual clean exit cannot report successful completion for a blocked undelivered write',async t=>{
    const {root,owner}=await fixture(t);
    const held=await owner.reserve('vad',signal(),3000);
    const exchange=held.open(command('setTimeout(()=>process.exit(0),80);',root,{stdin_limit_bytes:4_000_000}),()=>{});
    const writing=assert.rejects(exchange.write(Buffer.alloc(4_000_000)),/EPIPE|ECONNRESET|INPUT_CLOSED/);
    const done=assert.rejects(exchange.done,/EPIPE|ECONNRESET|INPUT_CLOSED/);
    await Promise.all([writing,done]);await held.release();
});

test('deterministic close seam synchronously latches pending-write failure before done',async t=>{
    const cp=await import('node:child_process');
    const {syncBuiltinESMExports}=await import('node:module');
    const {EventEmitter}=await import('node:events');
    const child=new EventEmitter() as import('node:child_process').ChildProcess;
    Object.assign(child,{
        stdout:new EventEmitter(),stderr:new EventEmitter(),
        stdin:Object.assign(new EventEmitter(),{write:()=>false,end:()=>{}}),kill:()=>false
    });
    const mock=t.mock.method(cp.default,'spawn',()=>child);syncBuiltinESMExports();
    t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
    const {root,owner}=await fixture(t);const held=await owner.reserve('vad',signal(),1000);
    const exchange=held.open(command('unused deterministic seam',root),()=>{});
    const writing=assert.rejects(exchange.write(Buffer.from('x')),/LOCAL_VAD_INPUT_CLOSED/);
    const done=assert.rejects(exchange.done,/LOCAL_VAD_INPUT_CLOSED/);
    child.emit('close',0,null);
    await Promise.all([writing,done]);await held.release();
});
