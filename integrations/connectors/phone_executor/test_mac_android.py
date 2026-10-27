"""Persistent host contract and executor wiring; fake SSH and a loopback adb peer only."""
import asyncio
import io
import json
from pathlib import Path
import socket
import socketserver
import subprocess
import shlex
import threading
import unittest
from unittest import mock

import mac_android as provider
import test_errand_safety as fixtures

CONTEXT = {'run_id': 'run', 'session_id': 'session', 'tool_call_id': 'call'}


class Channel(unittest.TestCase):
    def setUp(self):
        self.reply = {'schema': 'paios.mac-android.v1', 'state': 'running', 'adb_port': 5555}
        self.commands, self.peers, self.state = [], [], 'device'
        self.replies = []
        self.resolutions = 0
        self.binding = dict(device_id='mac-a', home="/Users/Owner's Mac", ssh_user='owner', visitor_port=22001)
        for patch in (mock.patch.object(provider.Path, 'read_text', return_value='synthetic-key'),
                      mock.patch.dict(provider.os.environ, {'PAIOS_INTEGRATION_PORT': '19661', 'PAIOS_ADB': 'fake-adb'}),
                      mock.patch.object(provider, 'urlopen', side_effect=self.resolve),
                      mock.patch.object(provider.subprocess, 'run', side_effect=self.command)):
            patch.start()
            self.addCleanup(patch.stop)

    def resolve(self, request, **_):
        self.resolutions += 1
        self.assertEqual(json.loads(request.data), {'_context': CONTEXT})
        self.assertTrue(request.full_url.endswith('/internal/owner-mac/resolve'))
        return io.StringIO(json.dumps(self.binding))

    def command(self, argv, **_):
        self.commands.append(argv)
        if argv[0] == 'ssh':
            if '-M' in argv:
                Path(argv[argv.index('-S') + 1]).touch()
            elif 'forward' in argv:
                spec = argv[argv.index('-L') + 1].split(':')
                self.assertEqual((spec[0], spec[2], spec[3]), ('127.0.0.1', '127.0.0.1', '5555'))
                fixture = self
                class Adb(socketserver.BaseRequestHandler):
                    def handle(self):
                        self.server.query = self.request.recv(128).decode()
                        self.request.sendall(fixture.state.encode())
                peer = socketserver.TCPServer(('127.0.0.1', int(spec[1])), Adb)
                thread = threading.Thread(target=peer.serve_forever, daemon=True)
                thread.start()
                self.peers.append(peer)
                self.addCleanup(peer.server_close)
                self.addCleanup(peer.shutdown)
            elif argv[-1].endswith((' status', ' start')):
                self.assertEqual(shlex.split(argv[-1])[0], self.binding['home'] + '/Library/Application Support/Yimi/Android/control')
                reply = self.replies.pop(0) if self.replies else self.reply
                return subprocess.CompletedProcess(argv, 0, json.dumps(reply), '')
        elif argv[0] == 'fake-adb' and argv[1] == 'connect':
            with socket.create_connection(('127.0.0.1', int(argv[2].split(':')[1])), timeout=2) as peer:
                peer.sendall(b'connect')
                state = peer.recv(128).decode()
            return subprocess.CompletedProcess(argv, int(state != 'device'), state, '')
        return subprocess.CompletedProcess(argv, 0, '', '')

    def test_forward_is_private_pinned_and_only_transport_is_closed(self):
        binding, status = provider.request(CONTEXT)
        self.assertEqual(status['status'], 'ready')
        for _ in range(2):
            with provider.phone(binding) as serial:
                self.assertTrue(serial.startswith('127.0.0.1:'))
                self.assertEqual(self.peers[-1].query, 'connect')
        self.assertEqual(self.resolutions, 1, 'queued work must not resolve an already-completed native run')
        self.assertEqual(sum('forward' in c for c in self.commands), 2)
        self.assertEqual(sum('exit' in c for c in self.commands), 3)
        self.assertEqual(sum(c[:2] == ['fake-adb', 'disconnect'] for c in self.commands), 2)
        self.assertFalse(any(c[-1].endswith(' start') for c in self.commands))
        first = self.commands[0]
        self.assertIn('StrictHostKeyChecking=yes', first)
        self.assertIn('HostKeyAlias=owner-mac-mac-a', first)
        self.assertEqual(first[-1], 'owner@127.0.0.1')
        self.assertFalse(any(word in ' '.join(c) for c in self.commands for word in ('wipe', 'restore', 'upload', '5037', '5554')))

    def test_host_states_start_and_invalid_responses(self):
        for state in ('running', 'starting', 'stopped', 'not_installed'):
            self.reply['state'] = state
            _, result = provider.request(CONTEXT)
            self.assertEqual(result['status'], 'ready' if state == 'running' else 'starting' if state == 'starting' else 'unavailable')
            self.assertIn(state, result['answer'])
        self.assertFalse(any(c[-1].endswith(' start') for c in self.commands))
        self.reply['state'] = 'starting'
        self.assertEqual(provider.request(CONTEXT, 'start')[1]['status'], 'starting')
        self.assertFalse(self.peers)
        for field, value in [('state', 'unknown'), ('adb_port', 0), ('adb_port', True), ('schema', 'other')]:
            with self.subTest(field=field, value=value):
                with mock.patch.dict(self.reply, {field: value}), self.assertRaises(ValueError):
                    provider.request(CONTEXT)

    def test_unreachable_ssh_is_unavailable_and_non_transport_errors_surface(self):
        with mock.patch.object(provider.subprocess, 'run', return_value=subprocess.CompletedProcess([], 255, '', 'offline')):
            result = provider.request(CONTEXT)[1]
            self.assertEqual(result['status'], 'unavailable')
            self.assertIn('Mac 不可达', result['answer'])
        with mock.patch.object(provider.subprocess, 'run', return_value=subprocess.CompletedProcess([], 2, '', 'host failed')):
            with self.assertRaisesRegex(RuntimeError, 'host failed'):
                provider.request(CONTEXT)

    def test_stopped_and_starting_devices_start_once_then_forward_only_when_running(self):
        for state in ('stopped', 'starting'):
            with self.subTest(state=state), mock.patch('time.sleep'):
                self.commands.clear()
                self.replies = [{**self.reply, 'state': s} for s in (state, 'starting', 'running')]
                with provider.phone(self.binding):
                    self.assertEqual([c[-1].rsplit(' ', 1)[-1] for c in self.commands
                                      if c[-1].endswith((' status', ' start'))], ['status', 'start', 'status'])
                    self.assertFalse(self.replies)
                self.assertEqual(sum('forward' in c for c in self.commands), 1)

    def test_failed_or_timed_out_start_names_state_and_never_forwards(self):
        for state in ('stopped', 'starting'):
            with self.subTest(state=state), mock.patch('time.monotonic', side_effect=[0, 91]):
                self.commands.clear()
                self.replies = [{**self.reply, 'state': 'stopped'},
                                {**self.reply, 'state': state, 'last_error': 'VM boot failed' if state == 'stopped' else None}]
                with self.assertRaisesRegex(provider.Unavailable, f'启动失败（状态：{state}）') as failure:
                    with provider.phone(self.binding):
                        self.fail('a failed start cannot yield an ADB transport')
                if state == 'stopped':
                    self.assertIn('VM boot failed', str(failure.exception))
                self.assertFalse(any('forward' in c for c in self.commands))

    def test_start_command_failure_retains_state_and_reason(self):
        with mock.patch.object(provider, '_request', side_effect=[{**self.reply, 'state': 'stopped'},
                                                                 RuntimeError('host refused start')]):
            with self.assertRaisesRegex(provider.Unavailable, '启动失败（状态：stopped）.*host refused start'):
                with provider.phone(self.binding):
                    self.fail('a refused start cannot yield an ADB transport')


class Executor(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fixtures.CloudExecutor.setUp(self)
        self.mac = mock.MagicMock()
        self.mac.__enter__.return_value = '127.0.0.1:32000'
        self.host = dict(provider='mac-android', state='running', status='ready')
        self.binding = dict(device_id='mac-a', home='/Users/owner', ssh_user='owner', visitor_port=22001)
        self.phone = provider.phone
        self.placed, self.commands, self.mock_allowed = False, [], True
        for patch in (mock.patch.object(self.s, 'PHONE_PROVIDER', 'mac-android'),
                      mock.patch.object(provider, 'request', return_value=(self.binding, self.host)),
                      mock.patch.object(provider, 'phone', return_value=self.mac),
                      mock.patch.object(self.s, '_online', return_value=True),
                      mock.patch('async_adbutils.adb.device', new_callable=mock.AsyncMock),
                      mock.patch('mobilerun_core_local.driver.android.portal.ensure_portal_ready', new_callable=mock.AsyncMock),
                      mock.patch.object(self.s, '_shell', side_effect=self.shell)):
            patch.start()
            self.addCleanup(patch.stop)

    def shell(self, command, *_, **__):
        self.commands.append(command)
        if command == 'settings get secure default_input_method': return 'com.mobilerun.portal/.IME'
        if command == 'getprop gsm.sim.operator.iso-country': return 'cn'
        if command == 'getprop ro.debuggable': return '1'
        if command.startswith('if [ -f '): return 'ready'
        if command.startswith('appops get '): return 'MOCK_LOCATION: allow' if self.mock_allowed else 'No operations.\nDefault mode: deny'
        if command.startswith('appops set '): self.mock_allowed = True
        if command.startswith('am start-foreground-service '): self.placed = True
        if command.startswith('am stopservice '): self.placed = False
        if command.startswith('dumpsys activity services ') and self.placed:
            return '  * ServiceRecord{abc u0 io.appium.settings/.LocationService}'
        return ''

    async def test_preflight_grants_and_verifies_mock_location_once_without_coordinates(self):
        self.mock_allowed = False
        async def work(*args, **kwargs):
            self.assertTrue(self.mock_allowed, 'permission must be ready before the model starts')
            return {'success': True, 'answer': 'ok', 'steps': 1}
        with mock.patch.object(self.s, '_agent', side_effect=work):
            for _ in range(2):
                result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                    effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
                self.assertTrue(result['success'])
        grant = 'appops set io.appium.settings android:mock_location allow'
        read = 'appops get io.appium.settings android:mock_location'
        self.assertEqual(self.commands.count(grant), 1)
        self.assertEqual(self.commands.count(read), 3, 'initial check, grant verification, idempotent check')
        self.assertFalse(any(c.startswith('am start-foreground-service ') for c in self.commands))

    def test_preflight_limits_permission_repair_to_debuggable_or_rooted_mac_device(self):
        for provider, debuggable, uid, granted in (
                ('mac-android', '1', '2000', True), ('mac-android', '0', '0', True),
                ('mac-android', '0', '2000', False), ('agentbay', '1', '0', False)):
            with self.subTest(provider=provider, debuggable=debuggable, uid=uid):
                self.mock_allowed, self.commands = False, []
                probes = []
                def shell(command, *args, **kwargs):
                    if command in ('getprop ro.debuggable', 'id -u'):
                        probes.append(command)
                        return debuggable if command == 'getprop ro.debuggable' else uid
                    return self.shell(command, *args, **kwargs)
                with mock.patch.object(self.s, 'PHONE_PROVIDER', provider), mock.patch.object(self.s, '_shell', shell):
                    self.s._preflight(threading.Event())
                self.assertEqual(self.mock_allowed, granted)
                if provider == 'agentbay': self.assertEqual(probes, [])

    async def test_preflight_stops_before_model_when_grant_fails_or_does_not_take_effect(self):
        for failure in ('denied', 'unchanged'):
            with self.subTest(failure=failure):
                self.mock_allowed = False
                def shell(command, *args, **kwargs):
                    if command.startswith('appops set '):
                        if failure == 'denied': raise RuntimeError('MANAGE_APP_OPS_MODES')
                        return ''
                    return self.shell(command, *args, **kwargs)
                with mock.patch.object(self.s, '_shell', shell), mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock) as agent:
                    result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                        effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
                self.assertFalse(result['success'])
                agent.assert_not_awaited()

    async def test_app_launch_waits_for_ui_root_without_relaunch_and_passes_location_to_model(self):
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        missing = DeviceDisconnectedError('stage=tree: No active UI root; device elapsed=1 ms')
        tree = '<hierarchy><node package="com.aliyun.tongyi" text="生活帮手"/></hierarchy>'.encode()
        for latitude, longitude in ((30.2420, 120.1485), (None, None)):
            self.commands.clear()
            with mock.patch.object(self.s, '_driver', new_callable=mock.AsyncMock) as driver, \
                 mock.patch.object(self.s, '_observation', side_effect=[missing, missing, tree]) as observation, \
                 mock.patch.object(self.s.asyncio, 'sleep', new_callable=mock.AsyncMock), \
                 mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock,
                                   return_value={'success': True, 'answer': 'ok', 'steps': 1}) as agent:
                result = await self.s.phone_task('查附近外卖，只查询', app='千问',
                    latitude=latitude, longitude=longitude, principal_id='owner', context=CONTEXT,
                    effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
            self.assertTrue(result['success'])
            self.assertEqual(observation.call_count, 3)
            driver.return_value.start_app.assert_awaited_once_with('com.aliyun.tongyi')
            self.assertEqual(self.commands.count('am force-stop com.aliyun.tongyi'), 1)
            goal = agent.call_args.args[0]
            self.assertIn('查附近外卖，只查询', goal)
            if latitude is None:
                self.assertNotIn('WGS-84', goal)
            else:
                self.assertIn('WGS-84：纬度 30.242000，经度 120.148500', goal)

    async def test_launch_ui_wait_is_bounded_and_does_not_hide_transport_errors_or_login(self):
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        for message in ('No active UI root; device elapsed=1 ms', 'helper exit=1'):
            with self.subTest(error=message):
                clock = mock.Mock(wraps=self.s.time)
                clock.monotonic.side_effect = [0, 31]
                with mock.patch.object(self.s, 'time', clock), \
                     mock.patch.object(self.s, '_observation', side_effect=DeviceDisconnectedError(message)) as observation:
                    with self.assertRaisesRegex(DeviceDisconnectedError, message):
                        await self.s._launched_app_tree()
                observation.assert_called_once_with('tree')
        tree = '<hierarchy><node package="com.aliyun.tongyi" text="手机号登录"/></hierarchy>'.encode()
        with mock.patch.object(self.s, '_driver', new_callable=mock.AsyncMock), \
             mock.patch.object(self.s, '_observation', return_value=tree), \
             mock.patch.object(self.s.asyncio, 'sleep', new_callable=mock.AsyncMock), \
             mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock) as agent:
            result = await self.s.phone_task('查附近外卖', app='千问', principal_id='owner', context=CONTEXT,
                effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertEqual(result['status'], 'APP_LOGIN_REQUIRED')
        agent.assert_not_awaited()

    async def test_agentbay_app_launch_keeps_existing_observation_path(self):
        tree = '<hierarchy><node package="com.aliyun.tongyi" text="生活帮手"/></hierarchy>'.encode()
        with mock.patch.object(self.s, 'PHONE_PROVIDER', 'agentbay'), \
             mock.patch.object(self.s, '_driver', new_callable=mock.AsyncMock), \
             mock.patch.object(self.s, '_observation', return_value=tree) as observation, \
             mock.patch.object(self.s, '_launched_app_tree', new_callable=mock.AsyncMock) as wait, \
             mock.patch.object(self.s.asyncio, 'sleep', new_callable=mock.AsyncMock) as sleep, \
             mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock,
                               return_value={'success': True, 'answer': 'ok', 'steps': 1}):
            result = await self.s.phone_task('读取首页', app='千问', principal_id='owner',
                effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertTrue(result['success'])
        observation.assert_called_once_with('tree')
        wait.assert_not_awaited()
        sleep.assert_any_await(2)

    async def test_errands_reuse_device_and_keep_native_preflight_without_cloud_or_physical_actions(self):
        self.addCleanup(self.s._jobs.clear)
        with mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock,
                               return_value={'success': True, 'answer': 'ok', 'steps': 1}):
            for _ in range(2):
                result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                    latitude=31.2, longitude=121.5,
                    effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
                self.assertTrue(result['success'])
                self.assertFalse(self.placed)
        self.assertEqual(self.mac.__enter__.call_count, 2)
        self.assertEqual(self.mac.__exit__.call_count, 2)
        provider.phone.assert_called_with(self.binding)
        self.provider.lease.assert_not_called()
        self.provider.release.assert_not_called()

    async def test_autostart_reaches_task_or_reports_real_failure_before_model(self):
        for initial, device, final in (('stopped', 'stopped', 'running'), ('starting', 'starting', 'running'),
                                       ('stopped', 'stopped', 'stopped'), ('running', 'running', 'running'),
                                       ('running', 'stopped', 'running')):
            with self.subTest(initial=initial, device=device, final=final):
                self.host.update(status='ready' if initial == 'running' else 'unavailable', state=initial)
                replies = [dict(state=s, adb_port=5555) for s in (
                    ('running',) if device == 'running' else (device, 'starting', final))]
                def request(_connection, action):
                    reply = replies.pop(0)
                    if action == 'start': self.assertEqual(reply['state'], 'starting')
                    return reply
                async def work(*args, **kwargs):
                    self.assertFalse(replies, 'the task must wait until the host reports running')
                    return {'success': True, 'answer': 'ok', 'steps': 1}
                with mock.patch.object(provider, 'phone', self.phone), \
                     mock.patch.object(provider, 'channel') as channel, \
                     mock.patch.object(provider, '_request', side_effect=request) as requests, \
                     mock.patch.object(provider, '_run'), mock.patch('time.sleep'), \
                     mock.patch.object(self.s, '_agent', side_effect=work) as agent:
                    channel.return_value.__enter__.return_value = ([], 'owner@127.0.0.1', '/fake/control')
                    result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                        effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
                self.assertEqual(result['success'], final == 'running')
                self.assertEqual(sum(c.args[1] == 'start' for c in requests.call_args_list), int(device != 'running'))
                if final != 'running':
                    self.assertIn('启动失败（状态：stopped）', result['answer'])
                    self.assertEqual(result['status'], 'unavailable')
                    agent.assert_not_awaited()
                self.assertIsNone(self.s._mac_phone)

    async def test_status_preserves_host_state_and_unreachable_does_not_start_work(self):
        for state in ('running', 'starting', 'stopped', 'not_installed'):
            self.host.update(state=state, answer=f'Mac 安卓执行手机（状态：{state}）。')
            result = await self.s.phone_status(context=CONTEXT, principal_id='owner')
            self.assertEqual(result['state'], state)
            self.assertIn(state, result['answer'])
        provider.request.return_value = (None, {'provider': 'mac-android', 'status': 'unavailable', 'answer': 'Mac 不可达。'})
        with mock.patch.object(self.s, '_agent', new_callable=mock.AsyncMock) as agent:
            result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertIn('Mac 不可达', result['answer'])
        self.mac.__enter__.assert_not_called()
        agent.assert_not_awaited()

    async def test_uninstalled_and_failed_adb_do_not_start_work_and_lease_is_released(self):
        self.host.update(status='unavailable', state='not_installed', answer='Mac 安卓执行手机未安装（状态：not_installed）。')
        result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
            effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertEqual(result['status'], 'unavailable')
        self.mac.__enter__.assert_not_called()
        self.host.update(status='ready', state='running')
        self.mac.__enter__.side_effect = provider.Unavailable()
        result = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
            effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertEqual(result['status'], 'unavailable')
        self.mac.__exit__.assert_called_once()
        self.assertIsNone(self.s._mac_phone)

    async def test_cancelled_connect_finishes_before_transport_and_device_lock_are_released(self):
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        def connect():
            entered.set()
            if not finish.wait(2): raise RuntimeError('fake connection gate timed out')
            return '127.0.0.1:32000'
        self.mac.__enter__.side_effect = connect
        task = asyncio.create_task(self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
            effect={'kind': 'read', 'task_type': 'read_app', 'requested': True}))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        task.cancel()
        await asyncio.sleep(0)
        self.mac.__exit__.assert_not_called()
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.mac.__exit__.assert_called_once()
        self.assertIsNone(self.s._mac_phone)

    async def test_queued_errand_outlives_native_run_without_re_resolving_or_spooling_binding(self):
        self.addCleanup(self.s._jobs.clear)
        with mock.patch.object(self.s, 'SPOOL', self.dir.name), mock.patch.object(self.s, '_agent',
                new_callable=mock.AsyncMock, return_value={'success': True, 'answer': 'ok', 'steps': 1}):
            await self.s._one_phone.acquire()
            try:
                started = await self.s.phone_task('读取首页', principal_id='owner', context=CONTEXT,
                    effect={'kind': 'read', 'task_type': 'read_app', 'requested': True})
                provider.request.side_effect = AssertionError('origin run has completed')
            finally:
                self.s._one_phone.release()
            await self.s._jobs[started['job_id']]['task']
            saved = (Path(self.dir.name) / (started['job_id'] + '.done.json')).read_text()
            self.assertTrue(json.loads(saved)['success'])
            self.assertNotIn('visitor_port', saved)
            provider.phone.assert_called_once_with(self.binding)


class DeploymentTimeZone(unittest.TestCase):
    def test_simulator_clock_uses_deployment_zone(self):
        server = fixtures.server
        for zone in ('America/Los_Angeles', 'UTC', 'Asia/Taipei'):
            with self.subTest(zone=zone), mock.patch.dict(server.os.environ, {'PAIOS_TIME_ZONE': zone}), \
                    mock.patch.object(server, '_shell', return_value='us') as shell:
                server._ensure_cn_identity()
                self.assertTrue(shell.call_args_list[1].args[0].endswith('alarm 3 s16 ' + zone))


if __name__ == '__main__':
    unittest.main()
