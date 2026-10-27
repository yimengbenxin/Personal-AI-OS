"""Public MCP, persisted-session and pre-network lock contracts; Xiaomi is forbidden."""
import asyncio
import json
import logging
import os
from pathlib import Path
import sys
import threading
import time

from mcp import ClientSession, StdioServerParameters, stdio_client
import pytest
import requests

ROOT = Path(__file__).parents[2]
import importlib.util
spec = importlib.util.spec_from_file_location('mijia_fake', ROOT / 'capability/packages/mijia/fake/server.py')
fake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fake)
from mijia import create_server, mijiaAPI
from mijiaAPI.errors import APIError, LoginError


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    original = requests.sessions.Session.request
    def forbidden(*args, **kwargs):
        pytest.fail('Tests must never contact Xiaomi or fetch a MIoT spec')
    monkeypatch.setattr(requests.sessions.Session, 'request', forbidden)
    return original


async def invoke(server, tool, **args):
    result = await server.call_tool(tool, args)
    assert not result.is_error
    return result.structured_content["legacy"]


def test_fake_stdio_contract_and_call_journal(tmp_path):
    async def run():
        log = tmp_path / 'fake.jsonl'
        params = StdioServerParameters(command=sys.executable,
            args=[str(ROOT / 'capability/packages/mijia/fake/server.py')],
            env={**os.environ, 'HERMES_HOME': str(tmp_path), 'PAIOS_FAKE_MIJIA_LOG': str(log),
                 'PYTHONDONTWRITEBYTECODE': '1'})
        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            tools = {tool.name: tool for tool in (await client.list_tools()).tools}
            assert set(tools) == {'prepare_login', 'get_login_status', 'refresh_devices',
                                 'read_device', 'control_device', 'run_scene'}
            assert set(tools['control_device'].input_schema['properties']) == {'device', 'home', 'room', 'service', 'property', 'value', 'action', 'arguments', 'owner_requested', 'idempotency_key'}
            qr = await invoke(client, 'prepare_login')
            assert qr['qr_markdown'] == '![米家登录二维码](qr:https://example.invalid/staging-mijia-login)'
            assert (await invoke(client, 'get_login_status'))['status'] in {'connected', 'waiting_for_scan'}
            devices = (await invoke(client, 'refresh_devices'))['devices']
            assert {d['type'] for d in devices} == {'light', 'door-lock', 'air-conditioner', 'air-purifier', 'curtain'}
            assert all(d['home'] == '家' and d['room'] == '客厅' for d in devices)
            await invoke(client, 'read_device', device='入户门锁')
            step = {'device': '客厅灯', 'service': 'light', 'property': 'on', 'value': True}
            assert (await invoke(client, 'control_device', **step))['status'] == 'succeeded'
            assert (await invoke(client, 'control_device', device='窗帘', service='curtain', property='motor-control', value=1))['status'] == 'succeeded'
            curtain = await invoke(client, 'read_device', device='窗帘')
            assert curtain['properties'] == [{'service': 'curtain', 'property': 'motor-control', 'unit': 'none', 'code': 0, 'value': 1}]
            assert (await invoke(client, 'run_scene', name='到家', steps=[{**step, 'owner_requested': True}], owner_requested=True))['status'] == 'succeeded'
            rejected = await client.call_tool('run_scene', {'name': '不透明', 'steps': [{'scene_id': 'opaque'}]})
            assert rejected.is_error
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        assert [entry['tool'] for entry in calls] == ['prepare_login', 'get_login_status', 'refresh_devices',
                                                   'read_device', 'control_device', 'control_device', 'read_device', 'run_scene', 'run_scene']
        assert calls[-1]['result']['status'] == 'failed'
        assert all(calls[4]['args'][k] == v for k, v in step.items())
        assert 'synthetic-session-secret' not in log.read_text()
        audit = [json.loads(line) for line in (tmp_path / 'mijia/actions.jsonl').read_text().splitlines()]
        assert len(audit) == 3 and all(set(line) == {'device', 'action', 'result', 'ms'} for line in audit)
    asyncio.run(run())


def test_fake_property_writes_are_visible_to_reads(tmp_path):
    server = create_server(fake.FakeAPI(), fake.load_spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        assert (await invoke(server, 'read_device', device='客厅灯'))['properties'][0]['value'] is False
        for value in (True, False):
            assert (await invoke(server, 'control_device', device='客厅灯', service='light',
                                property='on', value=value))['status'] == 'succeeded'
            assert (await invoke(server, 'read_device', device='客厅灯'))['properties'][0]['value'] is value
            assert (await invoke(server, 'read_device', device='空调'))['properties'][0]['value'] is False
    asyncio.run(run())


@pytest.mark.parametrize('restricted_type', ['door-lock', 'dlock', 'ulock', 'door', 'gate', 'garage-door', 'door-opener', 'garage-door-controller'])
@pytest.mark.parametrize('as_device', [True, False])
def test_all_mutations_deny_entrance_device_or_service_before_network(tmp_path, monkeypatch, restricted_type, as_device):
    api = fake.FakeAPI()
    device_type, lock_service = (restricted_type, 'switch') if as_device else ('light', restricted_type)
    api.devices = [{'did': 'lock', 'name': '任意名称', 'home_id': '1', 'spec_type': fake.urn('device', device_type)},
                   {'did': 'lamp', 'name': '灯', 'home_id': '1', 'spec_type': fake.urn('device', 'switch')}]
    def spec(urn):
        value = fake.load_spec(urn)
        if urn.split(':')[3] != 'switch':
            value['services'][0]['type'] = fake.urn('service', lock_service)
            value['services'][0]['actions'][0]['type'] = fake.urn('action', 'unlock')
        return value
    dispatched = []
    monkeypatch.setattr(api, 'set_devices_prop', lambda params: dispatched.append(params))
    monkeypatch.setattr(api, 'run_action', lambda params: dispatched.append(params))
    server = create_server(api, spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        for args in [{'property': 'on', 'value': False}, {'action': 'unlock'}]:
            result = await invoke(server, 'control_device', device='任意名称', service=lock_service, **args)
            assert result == {'status': 'rejected', 'error': 'entrance_control_denied'}
        result = await invoke(server, 'run_scene', name='间接开锁', steps=[
            {'device': '灯', 'service': 'switch', 'property': 'on', 'value': True},
            {'device': '任意名称', 'service': lock_service, 'action': 'unlock'}])
        assert result['status'] == 'rejected' and not dispatched
        assert (await invoke(server, 'read_device', device='任意名称'))['properties'][0]['code'] == 0
        audit = [json.loads(line) for line in (tmp_path / 'actions.jsonl').read_text().splitlines()]
        assert len(audit) == 3 and all(line['result'] == 'rejected' for line in audit)
    asyncio.run(run())


def test_login_qr_private_session_expiry_and_token_free_failure(tmp_path, monkeypatch, caplog):
    api = mijiaAPI(str(tmp_path / 'session.json'))
    requests_started, scanned = [], threading.Event()
    def prepare():
        requests_started.append(True)
        return {'loginUrl': 'https://example.invalid/scan', 'lp': 'synthetic-private-poll'}
    monkeypatch.setattr(api, '_get_qr_login_data', prepare)
    def complete(data):
        assert scanned.wait(3)
        api.auth_data = {'expireTime': (time.time() + 86400) * 1000, 'serviceToken': 'synthetic-session-secret'}
        api._save_auth_data()
        return api.auth_data
    monkeypatch.setattr(api, '_complete_qr_login', complete)
    monkeypatch.setattr(api, 'get_homes_list', fake.FakeAPI().get_homes_list)
    monkeypatch.setattr(api, 'get_devices_list', fake.FakeAPI().get_devices_list)
    server = create_server(api, fake.load_spec, tmp_path, tmp_path / 'calls.jsonl')
    async def run():
        qr, concurrent = await asyncio.gather(invoke(server, 'prepare_login'), invoke(server, 'prepare_login'))
        assert set(qr) == {'status', 'qr_markdown'}
        assert qr['qr_markdown'] == '![米家登录二维码](qr:https://example.invalid/scan)'
        assert qr == concurrent and len(requests_started) == 1
        assert (await invoke(server, 'refresh_devices')) == {'status': 'rejected', 'error': 'login_scan_pending'}
        scanned.set()
        async with asyncio.timeout(3):
            while (await invoke(server, 'get_login_status'))['status'] == 'waiting_for_scan':
                await asyncio.sleep(0.01)
        assert (tmp_path / 'session.json').stat().st_mode & 0o777 == 0o600
        assert json.loads((tmp_path / 'session.json').read_text())['serviceToken'] == 'synthetic-session-secret'
        await invoke(server, 'refresh_devices')
        api.auth_data['expireTime'] = 0
        assert (await invoke(server, 'get_login_status'))['status'] == 'login_required'
        result = await invoke(server, 'control_device', device='客厅灯', service='light', property='on', value=True)
        assert result['status'] == 'login_required' and 'instruction' in result
        def fail():
            raise LoginError(-1, 'synthetic-session-secret')
        monkeypatch.setattr(api, '_get_qr_login_data', fail)
        assert (await invoke(server, 'prepare_login'))['status'] == 'login_required'
        api.auth_data['expireTime'] = (time.time() + 86400) * 1000
        def revoked(params):
            raise APIError(-10030, 'synthetic-session-secret')
        monkeypatch.setattr(api, 'set_devices_prop', revoked)
        assert (await invoke(server, 'control_device', device='客厅灯', service='light', property='on', value=True))['status'] == 'login_required'
        assert not (tmp_path / 'session.json').exists()
        restarted = create_server(mijiaAPI(str(tmp_path / 'session.json')), fake.load_spec, tmp_path)
        assert (await invoke(restarted, 'get_login_status'))['status'] == 'login_required'
    caplog.set_level(logging.DEBUG)
    previous = os.umask(0o077)
    try:
        asyncio.run(run())
    finally:
        os.umask(previous)
    assert 'synthetic-session-secret' not in caplog.text + (tmp_path / 'calls.jsonl').read_text()
    assert 'synthetic-private-poll' not in (tmp_path / 'calls.jsonl').read_text()


def test_reads_match_miot_identifiers_when_responses_are_reordered(tmp_path, monkeypatch):
    api = fake.FakeAPI()
    def spec(urn):
        value = fake.load_spec(urn)
        value['services'][0]['properties'].append({'type': fake.urn('property', 'temperature'),
            'iid': 2, 'format': 'float', 'access': ['read']})
        return value
    monkeypatch.setattr(api, 'get_devices_prop', lambda params: [
        {**p, 'code': 0, 'value': False if p['piid'] == 1 else 23.5} for p in reversed(params)])
    server = create_server(api, spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        result = await invoke(server, 'read_device', device='客厅灯')
        assert {p['property']: p['value'] for p in result['properties']} == {'on': False, 'temperature': 23.5}
    asyncio.run(run())


@pytest.mark.parametrize('kind', ['clock', 'curtain', 'window-opener', 'doorbell', 'gateway'])
def test_named_action_emits_miot_input_contract_for_allowed_types(tmp_path, monkeypatch, kind):
    api, fixture = mijiaAPI(str(tmp_path / 'session.json')), fake.FakeAPI()
    fixture.devices[0]['spec_type'] = fake.urn('device', kind)
    api.auth_data = {'expireTime': (time.time() + 86400) * 1000}
    monkeypatch.setattr(api, 'get_homes_list', fixture.get_homes_list)
    monkeypatch.setattr(api, 'get_devices_list', fixture.get_devices_list)
    sent = []
    monkeypatch.setattr(api, '_request', lambda uri, data: sent.append((uri, data)) or {'code': 0})
    def spec(urn):
        value = fake.load_spec(urn)
        value['services'][0]['actions'][0]['type'] = fake.urn('action', 'toggle')
        value['services'][0]['actions'][0]['in'] = [1]
        return value
    server = create_server(api, spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        await invoke(server, 'control_device', device='客厅灯', service=kind, action='toggle', arguments=[2])
        assert sent == [('/miotspec/action', {'params': {'did': '0', 'siid': 2, 'aiid': 1, 'in': [2]}})]
    asyncio.run(run())


@pytest.mark.parametrize('url', ['http://example.invalid/scan', 'file:///session.json', 'https://', 'https://example.invalid/' + 'a' * 2048])
def test_login_rejects_invalid_qr_urls_before_polling(tmp_path, monkeypatch, url):
    api, polled = fake.FakeAPI(), []
    monkeypatch.setattr(api, '_get_qr_login_data', lambda: {'loginUrl': url})
    monkeypatch.setattr(api, '_complete_qr_login', lambda data: polled.append(data))
    result = asyncio.run(invoke(create_server(api, fake.load_spec, tmp_path), 'prepare_login'))
    assert result['status'] == 'rejected' and not polled


def test_refresh_caches_specs_per_urn_but_refreshes_devices(tmp_path):
    api, loaded = fake.FakeAPI(), []
    api.devices.append({**api.devices[0], 'did': 'other', 'name': '另一盏灯'})
    def spec(urn):
        loaded.append(urn)
        return fake.load_spec(urn)
    server = create_server(api, spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        api.devices[0]['name'] = '更名的灯'
        refreshed = await invoke(server, 'refresh_devices')
        assert '更名的灯' in {d['device'] for d in refreshed['devices']}
        assert len(loaded) == len(set(d['spec_type'] for d in api.devices)) == len(set(loaded))
    asyncio.run(run())


@pytest.mark.parametrize('mutation', ['property', 'action', 'scene'])
@pytest.mark.parametrize('code', [0, 1, -1, 'timeout', 'malformed'])
@pytest.mark.parametrize('successor', ['read', 'property', 'action'])
def test_cancelled_mutation_keeps_lock_until_sdk_settles(tmp_path, monkeypatch, mutation, code, successor):
    api = fake.FakeAPI()
    release, calls = threading.Event(), []

    async def checkpoint():
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        loop.call_soon(future.set_result, None)
        await future

    async def run():
        loop = asyncio.get_running_loop()
        started = loop.create_future()
        step = {'device': '客厅灯', 'service': 'light', 'property': 'on', 'value': True}
        def blocked(params):
            if calls:
                calls.append('successor')
                api.values[('0', 2, 1)] = False
                return {'code': 0}
            calls.append('started')
            loop.call_soon_threadsafe(started.set_result, None)
            assert release.wait(5), 'test must release SDK barrier'
            api.values[('0', 2, 1)] = True
            calls.append('settled')
            if code == 'timeout':
                raise requests.Timeout('response lost after device write')
            if code == 'malformed':
                return {}
            return {'code': code}
        monkeypatch.setattr(api, 'set_devices_prop', blocked)
        monkeypatch.setattr(api, 'run_action', blocked)
        server = create_server(api, fake.load_spec, tmp_path, tmp_path / 'calls.jsonl')
        await invoke(server, 'refresh_devices')
        tool, args = 'control_device', step
        if mutation == 'action':
            args = {'device': '客厅灯', 'service': 'light', 'action': 'toggle'}
        elif mutation == 'scene':
            tool, args = 'run_scene', {'name': '取消场景', 'steps': [step, step]}
        first = asyncio.create_task(invoke(server, tool, **args))
        await asyncio.wait_for(started, 5)
        second = None
        try:
            queued = asyncio.create_task(invoke(server, 'control_device', **step))
            await checkpoint()
            queued.cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued
            assert calls == ['started'], 'cancelling a lock waiter must not dispatch it'
            first.cancel()
            await checkpoint()
            first.cancel()  # Repeated interruption must not cancel the exact SDK task.
            if successor == 'read':
                second = asyncio.create_task(invoke(server, 'read_device', device='客厅灯'))
            else:
                next_args = {**step, 'value': False} if successor == 'property' else {
                    'device': '客厅灯', 'service': 'light', 'action': 'toggle'}
                second = asyncio.create_task(invoke(server, 'control_device', **next_args))
            await checkpoint()
            assert not first.done(), 'cancellation must join the in-flight SDK mutation'
            assert not second.done(), 'subsequent SDK calls must remain behind the same lock'
            assert not (tmp_path / 'actions.jsonl').exists(), 'in-flight outcome is not failed'
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await first
            if second:
                result = await second
                assert not second.cancel(), 'cancellation after completion must have no effect'
                if successor == 'read':
                    assert result['properties'][0]['value'] is True
                else:
                    assert result['status'] == 'succeeded'
                    assert api.values[('0', 2, 1)] is False
        assert calls == ['started', 'settled'] + ([] if successor == 'read' else ['successor'])
        audit = [json.loads(line) for line in (tmp_path / 'actions.jsonl').read_text().splitlines()]
        assert [entry['result'] for entry in audit] == [
            {0: 'succeeded', 1: 'accepted', 'timeout': 'outcome_unknown',
             'malformed': 'outcome_unknown'}.get(code, 'failed')
        ] + ([] if successor == 'read' else ['succeeded'])
        journal = [json.loads(line) for line in (tmp_path / 'calls.jsonl').read_text().splitlines()]
        assert next(entry for entry in journal if entry['tool'] == tool)['result']['status'] == 'cancelled'
    asyncio.run(run())


def test_scene_stops_after_uncertain_write_and_does_not_retry(tmp_path, monkeypatch):
    api, dispatched = fake.FakeAPI(), []
    def timeout(params):
        dispatched.append(params)
        raise requests.Timeout('response lost')
    monkeypatch.setattr(api, 'set_devices_prop', timeout)
    server = create_server(api, fake.load_spec, tmp_path)
    async def run():
        await invoke(server, 'refresh_devices')
        step = {'device': '客厅灯', 'service': 'light', 'property': 'on', 'value': True}
        result = await invoke(server, 'run_scene', name='断网', steps=[step, step])
        assert result == {'scene': '断网', 'results': [
            {'status': 'outcome_unknown', 'error': 'mijia_request_failed', 'device_id': '0'}], 'status': 'incomplete'}
        assert len(dispatched) == 1
        assert json.loads((tmp_path / 'actions.jsonl').read_text())['result'] == 'outcome_unknown'
    asyncio.run(run())


@pytest.mark.parametrize('method', ['set_devices_prop', 'run_action'])
def test_sdk_refresh_preserves_protocol_and_bounds_mutation_transport(tmp_path, monkeypatch, offline, method):
    api = mijiaAPI(str(tmp_path / 'session.json'))
    secret = 'eHl6eHl6eHl6eHl6eHl6eA=='
    api.auth_data = {'expireTime': (time.time() + 86400) * 1000, 'ssecurity': secret,
                     'userId': 'user', 'cUserId': 'cookie-user', 'serviceToken': 'old-token'}
    api._init_session()
    original_session, sent = api.session, []
    def send(adapter, request, **kwargs):
        sent.append((request.method, request.url, kwargs['timeout']))
        response = requests.Response()
        response.status_code = 200
        if request.url == api.service_login_url:
            payload = {'code': 0, 'location': 'https://example.invalid/callback', 'ssecurity': secret}
        elif request.url == 'https://example.invalid/callback':
            api.session.cookies.set('serviceToken', 'refreshed-token')
            response._content = b'ok'
            return response
        elif request.url.endswith('/v2/message/v2/check_new_msg'):
            payload = {'code': -1, 'message': 'refresh required'}
        else:
            assert request.url.endswith(('/miotspec/prop/set', '/miotspec/action'))
            payload = {'code': 0, 'result': [{'code': 0}] if request.url.endswith('/prop/set') else {'code': 0}}
        response._content = json.dumps(payload).encode()
        return response
    # Keep requests' real request preparation; the transport is an offline response barrier.
    monkeypatch.setattr(requests.sessions.Session, 'request', offline)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, 'send', send)
    params = {'did': '0', 'siid': 2, 'piid': 1, 'value': True} if method == 'set_devices_prop' else {
        'did': '0', 'siid': 2, 'aiid': 1, 'in': []}
    assert getattr(api, method)(params)['code'] == 0
    assert len(sent) == 4 and all(timeout == (5, 30) for _, _, timeout in sent)
    assert api.session is not original_session
    assert api.auth_data['serviceToken'] == 'refreshed-token'
    assert json.loads((tmp_path / 'session.json').read_text())['serviceToken'] == 'refreshed-token'
    assert api.session.get_adapter('https://example.invalid').max_retries.total == 0


def test_public_thirty_device_discovery_is_compact_and_specs_survive_restart(tmp_path):
    fixture = json.loads((Path(__file__).parent / 'fixtures/mijia-public-specs.json').read_text())
    api, fetched = fake.FakeAPI(), []
    api.devices = fixture['devices']
    def load(urn):
        fetched.append(urn)
        return json.loads(json.dumps(fixture['specs'][urn]))
    async def run():
        server = create_server(api, load, tmp_path)
        wire = await server.call_tool('refresh_devices', {})
        assert not wire.is_error
        discovery = wire.structured_content["legacy"]
        wire_chars, wire_bytes = len(wire.content[0].text), len(wire.content[0].text.encode())
        print(f'MCP wire: chars={wire_chars} bytes={wire_bytes}')
        assert wire_chars < 35_000
        assert len(discovery['devices']) == 30
        raw_bytes = len(json.dumps({'devices': [fixture['specs'][d['spec_type']] for d in api.devices]}).encode())
        compact_bytes = len(json.dumps(discovery).encode())
        print(f'public MIoT 30 devices: raw={raw_bytes} compact={compact_bytes}')
        assert compact_bytes < 50_000 and compact_bytes < raw_bytes / 2
        for device, source in zip(discovery['devices'], api.devices):
            assert device['online'] is True
            assert device['home'] == '家' and device['room'] == '客厅'
            spec = fixture['specs'][source['spec_type']]
            for service, raw in zip(discovery['capabilities'][device['capability']], spec['services']):
                base = raw['type'].split(':')[3]
                duplicate = sum(s['type'].split(':')[3] == base for s in spec['services']) > 1
                assert service['name'] == base + (f"#{raw['iid']}" if duplicate else '')
                assert 'type' not in service and 'description' not in service
                for action, original in zip(service['actions'], raw.get('actions', [])):
                    assert action['name'] == original['type'].split(':')[3]
                    for direction in ('in', 'out'):
                        assert action[direction] == [next(p['type'].split(':')[3]
                            for p in raw['properties'] if p['iid'] == iid)
                            for iid in original.get(direction, [])]
                for prop, original in zip(service['properties'], raw.get('properties', [])):
                    assert prop['name'] == original['type'].split(':')[3]
                    assert prop['access'] == original['access']
                    if 'write' in original['access'] or any(original['iid'] in a.get('in', []) for a in raw.get('actions', [])):
                        for key in ('format', 'unit', 'value-range'):
                            if key in original:
                                assert prop[key] == original[key]
                        if 'value-list' in original:
                            assert prop['values'] == {str(v['value']): v['description'] for v in original['value-list']}
        await invoke(server, 'refresh_devices')
        restarted = create_server(api, load, tmp_path)
        assert await invoke(restarted, 'refresh_devices') == discovery
        assert len(fetched) == len(set(d['spec_type'] for d in api.devices))
        first = discovery['devices'][0]
        detail = await invoke(restarted, 'read_device', device=first['device'], include_spec=True)
        assert detail['spec']['type'] == api.devices[0]['spec_type']
        assert detail['spec']['services'][0]['description']
    asyncio.run(run())


def test_duplicate_service_names_control_exact_iid_and_cache_is_raw(tmp_path, monkeypatch):
    api = fake.FakeAPI()
    api.devices = [api.devices[0]]
    sent = []
    monkeypatch.setattr(api, 'set_devices_prop', lambda params: sent.append(params) or {'code': 0})
    def load(urn):
        spec = fake.load_spec(urn)
        spec['services'].append({**spec['services'][0], 'iid': 8})
        return spec
    async def run():
        server = create_server(api, load, tmp_path)
        discovery = await invoke(server, 'refresh_devices')
        device = discovery['devices'][0]
        assert [s['name'] for s in discovery['capabilities'][device['capability']]] == ['light#2', 'light#8']
        assert (await invoke(server, 'control_device', device=device['device'], service='light#8',
                             property='on', value=True))['status'] == 'succeeded'
        assert sent == [{'did': '0', 'siid': 8, 'piid': 1, 'value': True}]
        cached = list((tmp_path / 'specs').glob('*.json'))
        assert len(cached) == 1
        assert all('name' not in service for service in json.loads(cached[0].read_text())['services'])
    asyncio.run(run())
