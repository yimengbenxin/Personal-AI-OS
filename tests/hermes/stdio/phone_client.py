"""Container probe: real Hermes transport and executor, synthetic phone/model boundaries."""
import asyncio
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import mcp.client.stdio as sdk_stdio

spawned = []
original_spawn = sdk_stdio._create_platform_compatible_process
async def record_spawn(*args, **kwargs):
    process = await original_spawn(*args, **kwargs)
    spawned.append((process, kwargs['args']))
    return process
sdk_stdio._create_platform_compatible_process = record_spawn

async def main():
    case = sys.argv[1] if len(sys.argv) > 1 else 'checkout'
    source = Path(os.environ.get('PROBE_SOURCE', '/opt/paios'))
    with tempfile.TemporaryDirectory(prefix='phone-stdio-') as tmp:
        os.environ.update(HERMES_HOME=tmp, PYTHONDONTWRITEBYTECODE='1')
        sys.path.insert(0, '/opt/hermes')
        from tools.mcp_tool import MCPServerTask
        from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
        phone, mijia = MCPServerTask('phone'), MCPServerTask('mijia')
        out = Path(tmp)
        config = {'command': '/opt/paios-phone/bin/python', 'args': ['-B', str(Path(__file__).with_name('phone_server.py'))],
                  'env': {'PROBE_SOURCE': str(source), 'PROBE_OUT': tmp, 'PROBE_CASE': case,
                          'PYTHONDONTWRITEBYTECODE': '1', 'PAIOS_DEEPSEEK_KEY_FILE': '', 'DEEPSEEK_API_KEY': 'synthetic'},
                  'timeout': 60, 'connect_timeout': 30, 'tools': {'resources': False, 'prompts': False}}
        bad = {**config, 'command': sys.executable, 'args': ['-B', str(source / 'capability/packages/mijia/fake/server.py')]}
        report = {'case': case, 'client_python': sys.executable, 'client_versions': {'python': sys.version, 'mcp': version('mcp')}}
        async def call(tool, args):
            result = await _call_tool_racing_stdio_death(phone, 'phone', tool, args)
            assert not result.is_error, result
            return json.loads(next(c.text for c in result.content if c.type == 'text'))
        try:
            starts = await asyncio.gather(phone.start(config), mijia.start(bad), return_exceptions=True)
            report.update(starts=[str(v) for v in starts], phone_pids=list(phone._stdio_child_pids), mijia_pids=list(mijia._stdio_child_pids))
            assert not isinstance(starts[0], Exception) and isinstance(starts[1], Exception), starts
            assert not phone._stdio_children_dead()
            assert not phone._stdio_child_pids.intersection(mijia._stdio_child_pids)
            started = await call('phone_task', {'goal': '从当前页面继续：核对合计并停在付款前', 'max_steps': 3, 'app': '千问', 'principal_id': 'synthetic-owner',
                                               'effect': {'kind': 'read', 'task_type': 'stdio_checkout_probe', 'requested': True}})
            assert started['status'] == 'started', started
            concurrent = await call('phone_status', {'principal_id': 'synthetic-owner'})
            terminal = out / 'spool' / (started['job_id'] + '.done.json')
            deadline = time.monotonic() + 60
            while not terminal.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.1)
            done = json.loads(terminal.read_text())
            status = await call('phone_status', {'principal_id': 'synthetic-owner'})
            audit = json.loads((out / 'audit.json').read_text())
            report.update(started=started, concurrent_status=concurrent, terminal=done, status_after_terminal=status, audit=audit)
            assert done['principal_id'] == 'synthetic-owner', done
            terminal_status = next(job for job in status['jobs'] if job['job_id'] == started['job_id'])
            assert terminal_status['success'] == done['success'] and terminal_status['terminal_reason'] == done['terminal_reason'], status
            assert audit['payment_clicks'] == [], audit
            required = {'phone_task', '_job', '_errand_task', '_errand', 'phone_status'}
            if case == 'checkout':
                required |= {'_agent', '_checked_input', 'CheckoutStop_refused_payment'}
                assert done['success'] and '直接付款' in done['answer'], done
                assert concurrent['jobs'], concurrent
            else:
                assert not done['success'] and done['terminal_reason'] == 'failed', done
            assert required <= set(audit['calls']), audit
            assert not phone._stdio_children_dead()
        finally:
            await phone.shutdown()
            await mijia.shutdown()
            report.update(children=[{'pid': p.pid, 'exit_status': p.returncode, 'args': args} for p, args in spawned],
                          stderr=(out / 'logs/mcp-stderr.log').read_text())
            print(json.dumps(report, ensure_ascii=False))
        assert next(p.returncode for p, args in spawned if 'phone_server.py' in args[-1]) == 0

asyncio.run(main())
