"""Actual INT authority + fake_phone; scripted native/owner turns, fake voice verifier.
PAIOS_TEST_WS may point to an existing ws wrapper.mjs when the checkout lacks that runtime import.
PAIOS_TEST_NODE optionally selects a Node version with native TypeScript support.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
STAGING = ROOT / 'integrations/hermes/personal_aios/staging'
INT = ROOT / '01-product-half-finished/backend/services/personal-aios-integration'

# The fixture owns SQLite/signatures/policy. HTTP is numeric loopback, no proxy or redirects.
BRIDGE = r'''
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PersonalAIOSRuntime,RunAdmission} from 'NATIVE';
import {PosixStorage} from 'STORAGE';
import {RawArchive} from 'ARCHIVE';
import {OutputAuthority} from 'OUTPUT';
import {sha256} from 'CONTRACTS';
import {paymentFixture,signed} from 'FIXTURE';
import {PaymentAuthority} from 'AUTHORITY';
import {handlePaymentExecutor} from 'EXECUTOR';
const cleanups:any[]=[];
const f=await paymentFixture({after:(fn:any)=>cleanups.push(fn)} as any,{staging:true});
f.setNow(Date.now());await f.locks();f.policy(true,false);await f.known();f.setNow(Date.now());
await f.authority.observePayUtterance('owner',f.utterance());
assert.equal(f.authority.store.events().filter(e=>e.kind==='voice_ignored').at(-1)?.data.reason,'NO_PENDING_PAYMENT');
const v=await f.open({initiating:f.initiating('voice')});
assert.equal(f.authority.store.getPayment(v.payment_id)?.state,'awaiting_owner');
await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance());
assert.equal(f.authority.store.getPayment(v.payment_id)?.state,'granted');await f.complete(v.payment_id);f.setNow(Date.now());
f.authority.close();
// Use one monotonic epoch clock for the live authority fixture.
const epoch=Date.now(),started=performance.now(),now=()=>epoch+Math.floor(performance.now()-started);
const authority=PaymentAuthority.open(f.directory,{config:f.config,now});
const storage=new PosixStorage(f.directory+'/runtime'),skill=readFileSync('SKILL','utf8');
let serial=0,nativeInstructions='';const done=new Set<string>(),owners=new Set<string>();
const native:any={create:async(body:any)=>{nativeInstructions=body.instructions;const id='run-'+(++serial);if(JSON.parse(body.input).origin==='explicit_user_prompt')owners.add(id);return {run_id:id,session_id:'native-'+serial,conversation_session_id:'session',status:'running'};},
 status:async(run_id:string)=>({run_id,session_id:'native-'+run_id.slice(4),conversation_session_id:'session',status:done.has(run_id)||!owners.has(run_id)?'completed':'running',...(done.has(run_id)||!owners.has(run_id)?{output:'收到'}:{})}),cancel:async()=>{throw Error('unused');}};
const admission=new RunAdmission(storage,native,{max_pending_events:10,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:10000,policy_version:'recovery-fixture'});
const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,10000),admission,native,output:new OutputAuthority(storage),skill,max_read_bytes:10000,payment:authority,
 devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'consent',route_version:'route',output_modes:['text'],token_sha256:sha256('fixture-token')}]});
const source=await runtime.authenticate('fixture-token');
const unlock=await authority.keys.challenge(source,'phone_unlock');
await authority.leases.unlock(source,signed(f.user,{purpose:'phone_unlock',device_id:'phone',nonce:unlock.nonce}));
const results=new Map<string,any>();let latest:any;
async function request(text=serial?'付吧':'帮我买午饭'){
 const raw:any={schema_version:'paios.event.v1',event_id:'owner-'+serial,device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(text)};
 const accepted=await runtime.submit(raw,source,'session',true);let record=accepted.admission;
 for(let n=0;!record.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));record=(await runtime.event(source,'session',accepted.processed_event.processed_event_id)).admission;}
 const run=record.run_id!;
 assert.ok(run);assert.equal(nativeInstructions,skill);
 const result=await runtime.tool('paios_payment',{context:{run_id:run,session_id:'session',tool_call_id:'request-'+serial},args:{action:'request',purpose:'午饭',app:'千问',budget_yuan:16.6}});
 await runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'reply-'+serial},args:{reply_mode:'text'}});
 done.add(run);const final=await runtime.result(source,'session',accepted.processed_event.processed_event_id);results.set(accepted.processed_event.processed_event_id,final);await runtime.reconcile(source,'session',accepted.processed_event.processed_event_id);
 return latest={...result as any,run_id:run,processed_event_id:accepted.processed_event.processed_event_id,skill_loaded:true,accepted:{...accepted,admission:record}};
}
const server=createServer((req,res)=>{void(async()=>{
 if(req.url?.startsWith('/v1/events/')){res.end(JSON.stringify(results.get(decodeURIComponent(req.url.split('/')[3]))));return;}
 if(!req.url?.startsWith('/fixture/')&&req.url!=='/v1/prompts')return handlePaymentExecutor(req,res,authority,'fixture-key',32768);
 let raw='';for await(const b of req)raw+=b;const input=JSON.parse(raw||'{}');let result:any;
 const cards=()=>authority.store.principalPayments('owner');
 if(req.url==='/v1/prompts')result=(await request(input.text)).accepted;
 else if(req.url==='/fixture/last')result=latest;
 else if(req.url==='/fixture/request')result=await request();
 // Structural executor cases need a real intent, not an unrelated durable native/output turn.
 else if(req.url==='/fixture/section-request')result=await authority.request({principal_id:'owner',run_id:'section-'+(++serial),tool_call_id:'request',session_id:'session',processed_event_id:'section-'+serial,initiating:f.initiating('text'),initiating_text:'帮我买午饭',purpose:'午饭',app:'千问',budget_fen:1660},true);
 else if(req.url==='/fixture/phrase'){await f.advance(3001);await authority.observePayUtterance('owner',f.utterance());result={ignored:authority.store.events().filter(e=>e.kind==='voice_ignored').at(-1)};}
 else if(req.url==='/fixture/confirm'){const p=authority.store.getPayment(input.payment_id)!;await runtime.paymentInput(source,{operation:'payment_decide',control_id:'confirm-'+input.payment_id,payment_id:input.payment_id,decision:'pay',...signed(f.dev,{purpose:'payment_decide',device_id:'phone',payment_id:input.payment_id,decision:'pay',amount_fen:p.amount_fen,payee_key:p.payee_key,nonce:p.decision_nonce})});result={state:authority.store.getPayment(input.payment_id)?.state};}
 else result={cards:cards(),intents:cards().map(p=>authority.store.getIntent(p.intent_id)),grants:cards().map(p=>authority.store.getGrant(p.payment_id))};
 res.end(JSON.stringify(result));
 })().catch(e=>{res.statusCode=500;res.end(JSON.stringify({error:String(e)}));});});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}`})));
process.on('SIGTERM',()=>{server.close();void runtime.close().then(()=>{f.terminals.close();});});
'''


class Recovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        scratch = ROOT / '.scratch/r13'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch, prefix='recovery-')
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name)
        bridge = self.private / 'bridge.mts'
        content = BRIDGE.replace('FIXTURE', (INT / 'tests/payment-fixture.ts').as_uri()).replace(
            'EXECUTOR', (INT / 'src/payment/executor-api.ts').as_uri()).replace('SKILL',
            str(STAGING.parent / 'skills/personal-aios-main/SKILL.md'))
        for token, filename in {'NATIVE':'tests/native-source-fixture.ts', 'STORAGE':'src/storage.ts',
                'ARCHIVE':'src/archive.ts', 'OUTPUT':'src/output.ts', 'CONTRACTS':'src/contracts.ts', 'AUTHORITY':'src/payment/authority.ts'}.items():
            content = content.replace(token, (INT / filename).as_uri())
        bridge.write_text(content)
        node = os.environ.get('PAIOS_TEST_NODE') or shutil.which('node')
        self.bridge_log = (self.private / 'bridge.log').open('w')
        self.addCleanup(self.bridge_log.close)
        command = [node]
        if os.environ.get('PAIOS_TEST_WS'):
            loader = self.private / 'dependencies.mjs'
            loader.write_text("import {registerHooks} from 'node:module';\n" +
                "registerHooks({resolve(s,c,n){return n(s === 'ws' ? " +
                json.dumps(Path(os.environ['PAIOS_TEST_WS']).resolve().as_uri()) + " : s,c);}});\n")
            command += ['--import', str(loader)]
        self.process = subprocess.Popen([*command, str(bridge)], stdout=subprocess.PIPE,
            stderr=self.bridge_log, text=True,
            env={**os.environ, 'TMPDIR': str(self.private), 'NODE_COMPILE_CACHE': str(self.private / 'cache')})
        self.addCleanup(self.stop)
        line = await asyncio.wait_for(asyncio.to_thread(self.process.stdout.readline), 20)
        self.assertTrue(line, (self.private / 'bridge.log').read_text())
        self.url = json.loads(line)['url']
        key = self.private / 'key'
        key.write_text('fixture-key')
        self.env = patch.dict(os.environ, {'PAIOS_FAKE_PHONE_LOG': str(self.private / 'phone.jsonl'),
            'PAIOS_ERRAND_SPOOL': str(self.private / 'spool'), 'PAIOS_FAKE_CASHIER': str(self.private / 'cashier.json'),
            'PAIOS_PAYMENT_URL': self.url, 'PAIOS_PAYMENT_KEY_FILE': str(key),
            'PAIOS_PAYMENT_RESULT_WAIT_S': '0', 'PAIOS_PAYMENT_RESULT_POLL_S': '1',
            'PAIOS_PAYMENT_POLL_WAIT_MS': '10'})
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location('recovery_fake_phone', STAGING / 'fake_phone.py')
        self.phone = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_fake_cashier import _ToolShell
        with patch('mcp.server.MCPServer', _ToolShell, create=True):
            spec.loader.exec_module(self.phone)
        self.addAsyncCleanup(self.phone.phone_cancel)
        spec = importlib.util.spec_from_file_location('recovery_scenarios', STAGING / 'run_scenarios.py')
        self.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runner)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.process.stdout.close()

    async def authority(self, operation, **body):
        from urllib.request import Request
        def send():
            req = Request(self.url + '/fixture/' + operation, data=json.dumps(body).encode())
            from urllib.error import HTTPError
            try:
                with self.runner._isolated_opener().open(req, timeout=5) as response:
                    return json.load(response)
            except HTTPError as exc:
                raise AssertionError(exc.read().decode()) from exc
        return await asyncio.to_thread(send)

    async def job(self, intent=None):
        goal = '从当前页面继续：核对同一订单，只读，不下单、付款或修改订单。' if intent is None else (
            '从当前页面继续：沿同一订单付款，不重新下单。' if self.phone._cashier else '买一杯奶茶，到付款。')
        started = await self.phone.phone_task(goal, payment_intent=intent, app='千问', principal_id='owner', effect={"kind": "external" if intent else "read", "task_type": "purchase_errand" if intent else "reconcile_order", "requested": True})
        return started['job_id'], self.phone._jobs[started['job_id']]['task']

    async def payment(self, terminal='paid'):
        from types import SimpleNamespace
        binding = SimpleNamespace(authority=self.url, open=self.runner._isolated_opener().open)
        lineage = await asyncio.to_thread(self.runner._payment_turn, binding, 'fixture-token', 'session',
            '付吧' if self.phone._cashier else '帮我买午饭',
            {'request_timeout_s':5, 'run_timeout_s':5, 'poll_s':.01})
        requested = await self.authority('last')
        self.assertEqual(lineage['result']['run_id'], requested['run_id'])
        self.assertTrue(requested['skill_loaded'])
        self.assertTrue(requested['run_id'] and requested['processed_event_id'])
        self.assertEqual(requested['status'], 'accepted', requested)
        intent = requested['intent_id']
        job, task = await self.job(intent)
        async def card():
            while True:
                state = await self.authority('state')
                cards = [p for p in state['cards'] if p['intent_id'] == intent]
                if cards:
                    return cards[0]
                if task.done():
                    await task
                    self.fail((self.private / 'spool' / (job + '.done.json')).read_text())
                await asyncio.sleep(.01)
        pending = await asyncio.wait_for(card(), 5)
        self.assertEqual(pending['state'], 'awaiting_owner')
        confirmed = await self.authority('confirm', payment_id=pending['payment_id'])
        self.assertEqual(confirmed['state'], 'granted')
        await asyncio.wait_for(task, 5)
        result = json.loads((self.private / 'spool' / (job + '.done.json')).read_text())
        self.assertEqual(result['success'], terminal == 'paid', result)
        return intent, pending['payment_id'], result

    async def chain(self, reconcile='unpaid', second='paid'):
        (self.private / 'cashier.json').write_text(json.dumps({'amount_fen':1660,'payee':'一点点 南门店',
            'items':['奶茶'], 'tap_results':['unknown',second], 'reconcile_state':reconcile}))
        first, original, first_result = await self.payment('unknown')
        order = self.phone._cashier.order_id
        reconciliation_job, task = await self.job()
        await task
        reconciled = json.loads((self.private / 'spool' / (reconciliation_job + '.done.json')).read_text())
        self.assertEqual(reconciled['payment_reconciliation'], {'of_job': first_result['job_id'], 'intent_id':first, 'state':reconcile})
        events = [json.loads(x) for x in (self.private / 'phone.jsonl').read_text().splitlines()]
        read = next(x['result'] for x in events if x['tool'] == 'payment_reconcile')
        self.assertEqual(read['state'], reconcile)
        self.assertEqual(read['taps'], 1)
        self.assertEqual(read['order_id'], order)
        phrase = await self.authority('phrase')
        self.assertEqual(phrase['ignored']['data']['reason'], 'NO_PENDING_PAYMENT')
        state = await self.authority('state')
        self.assertEqual(next(p for p in state['cards'] if p['payment_id'] == original)['state'], 'outcome_unknown')
        self.assertEqual(next(p for p in state['intents'] if p['intent_id'] == first)['state'], 'closed')
        if reconcile == 'unpaid':
            new, card, _ = await self.payment(second)
            self.assertNotEqual(new, first)
            self.assertNotEqual(card, original)
            self.assertEqual(self.phone._cashier.order_id, order)
            self.assertEqual(self.phone._cashier.taps, 2)
            final = await self.authority('state')
            self.assertEqual(next(p for p in final['cards'] if p['payment_id'] == original)['state'], 'outcome_unknown')
            self.assertEqual(next(g for g in final['grants'] if g and g['payment_id'] == card)['taps'], 1)
        events = [json.loads(x) for x in (self.private / 'phone.jsonl').read_text().splitlines()]
        self.runner.assert_recovery_trace(events, second if reconcile == 'unpaid' else reconcile)

    async def test_unknown_reconcile_new_request_new_card_one_input_paid(self):
        await self.chain()

    async def test_second_unknown_ends_chain(self):
        await self.chain(second='unknown')

    async def test_reconcile_paid_stops_without_new_intent(self):
        await self.chain(reconcile='paid')

    async def test_reconcile_unresolved_stops_without_new_intent(self):
        await self.chain(reconcile='unknown')

class ServerContinuation(unittest.IsolatedAsyncioTestCase):
    async def test_real_dispatch_preserves_page_and_bound_observation(self):
        import contextlib
        from dataclasses import replace
        from unittest import mock
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from test_payment_checkpoint import CARD
        current = replace(CARD, payment_statuses=("支付状态：待支付",), page_title="订单详情")
        @contextlib.asynccontextmanager
        async def lease():
            yield
        for intent, changed in [(None, False), (None, True), (None, 'missing'), (None, 'payee'), (None, 'amount'), ('new-intent', False)]:
            with self.subTest(intent=intent, changed=changed), contextlib.ExitStack() as stack:
                for name, value in {'PHONE_PROVIDER':'adb', '_one_phone':asyncio.Lock(),
                        '_device_lease':lease, '_online':lambda *_: True, '_owner_active':lambda:False,
                        '_preflight':lambda *_:None, '_ensure_unlocked':lambda *_:None,
                        '_ensure_cn_identity':lambda **_:None, '_sleep_later':lambda:None,
                        '_at_checkout':lambda:True}.items():
                    stack.enter_context(mock.patch.object(server, name, value))
                shell = stack.enter_context(mock.patch.object(server, '_shell', return_value='null'))
                stack.enter_context(mock.patch.object(server, '_driver', new=mock.AsyncMock(return_value=object())))
                stack.enter_context(mock.patch.object(server, '_agent', new=mock.AsyncMock(
                    return_value={'success':True,'answer':'model says paid'})))
                temporary = stack.enter_context(tempfile.TemporaryDirectory())
                from test_payment_lineage import seed
                from payment_checkpoint import PaymentBinding
                binding = PaymentBinding(current.order_id, current.payee, current.amount_fen,
                    current.order_namespace, current.item_identity, current.item_facts)
                owner = seed(temporary, binding.wire())
                jid = 'job-0123456789ab'
                stack.enter_context(mock.patch.object(server, 'SPOOL', temporary))
                stack.enter_context(mock.patch.object(server, '_jobs', {jid:{'principal_id':'owner', 'app':'千问', 'goal':'从当前页面继续：只读核对同一订单',
                    'payment_intent':intent, 'payment_owner':owner if intent is None else None,
                    'state':'running', 'tier':'deterministic'}}))
                token = server._job_id.set(jid)
                stack.callback(server._job_id.reset, token)
                initial = replace(current, order_id=None) if changed == 'missing' else current
                final = replace(current, order_id='other-order') if changed is True else initial
                if changed in ('payee', 'amount'):
                    final = replace(current, **{'payee' if changed == 'payee' else 'amount_fen':None})
                stack.enter_context(mock.patch.object(server, '_payment_screen', new=mock.AsyncMock(return_value=final)))
                with patch.dict(os.environ, {'PAIOS_STAGE':'fixture'}):
                    result = await server._errand_task('从当前页面继续：只读核对同一订单', 10, None, None, intent, '千问', 'fast')
                self.assertFalse(any(any(word in str(c) for word in ('BACK','HOME','monkey','force-stop')) for c in shell.call_args_list))
                if intent is None:
                    self.assertEqual(result['payment_observation']['state'], 'unknown' if changed else 'unpaid')

    async def test_continuation_refuses_region_repair_that_would_restart_app(self):
        import server
        with patch.object(server, '_shell', return_value='unknown') as shell:
            with self.assertRaises(server._Refused):
                server._ensure_cn_identity(preserve_app=True)
        self.assertEqual([c.args[0] for c in shell.call_args_list], ['getprop gsm.sim.operator.iso-country'])

    async def test_read_only_screen_collects_namespace_without_intent(self):
        from types import SimpleNamespace
        from unittest import mock
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from payment_capture_fixture import frame
        texts = ['订单详情','订单号：order-A','收款方：shop-A','总计 ¥16.60',
                 '商品名称：奶茶','规格：大杯','数量：1','支付状态：待支付']
        nodes = [(t, 0, i*50, 200, i*50+40) for i,t in enumerate(texts)]
        guard = server.CheckoutStop(SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame((1000,2000)))))
        self.assertIsNone(guard.payment_intent)
        with mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
             mock.patch.object(server, '_screen_nodes', return_value=nodes), \
             mock.patch.object(server, '_observation', return_value=b'<hierarchy width="1000" height="2000"/>'), \
             mock.patch.object(server, '_at_checkout', return_value=False):
            screen = await server._payment_screen(guard)
        self.assertEqual(screen.order_namespace, 'com.aliyun.tongyi')
        # Future grounded-positive candidate: namespace alone cannot ground OCR status.
        self.assertEqual(screen.evidence().state, 'unknown')
        self.assertIsNone(screen.amount_fen)

if __name__ == '__main__':
    unittest.main()
