"""Operation-bound read proofs, using only the production adapters and offline transports."""
import importlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import jsonschema
import pytest

from capability.hosts.python import Host

ROOT = Path(__file__).parents[2]
SCHEMA = json.loads((ROOT / 'capability/contracts/receipt.v1.schema.json').read_text())
spec = importlib.util.spec_from_file_location('reconciliation_mijia_fake', ROOT / 'capability/packages/mijia/fake/server.py')
fake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fake)
from mijia import create_server


def test_wechat_closed_schema_and_bound_read_proof(tmp_path):
    module = importlib.import_module('capability.packages.wechat-mac.server.server')
    transport = Mock(return_value={'returncode': 0, 'output': '{"content_exposed":true,"messages":[]}'})
    host = Host();module.register(host, transport=transport, directory=tmp_path)
    send, _ = host.tools['wechat_send_text']
    read, tool = host.tools['wechat_read_recent']
    assert tool.input_schema['additionalProperties'] is False
    assert 'check_for' in tool.input_schema['properties']
    args = {'command': 'fixture', 'recipient': 'wechat:fixture', 'context': {}, 'idempotency_key': 'original'}
    original = send(**args)
    assert original['effects'][0]['ref'] == 'original'
    assert original['effects'][0]['verification'] == 'unknown'
    proof = read(recipient='wechat:fixture', context={}, check_for='original')
    jsonschema.validate(proof, SCHEMA)
    assert proof['effects'][0]['kind'] == 'observe'
    assert proof['effects'][0]['target'] == original['effects'][0]['target']
    assert proof['effects'][0]['ref'] == 'original'
    assert not read(recipient='wechat:fixture', context={})['effects']
    transport.return_value = {'returncode': 1, 'output': ''}
    assert not read(recipient='wechat:fixture', context={}, check_for='original')['effects']
    transport.side_effect = TimeoutError('fixture')
    assert not read(recipient='wechat:fixture', context={}, check_for='original')['effects']


@pytest.mark.asyncio
@pytest.mark.parametrize('scene', [False, True])
async def test_mijia_unknown_execution_and_read_proofs_use_device_identity(tmp_path, monkeypatch, scene):
    def forbidden(*args, **kwargs):
        pytest.fail('reconciliation fixtures must never contact Xiaomi')
    monkeypatch.setattr('requests.sessions.Session.request', forbidden)
    api = fake.FakeAPI();server = create_server(api, fake.load_spec, tmp_path)
    await server.call_tool('refresh_devices', {})
    tools = {tool.name: tool for tool in await server.list_tools()}
    assert 'check_for' in tools['read_device'].input_schema['properties']
    assert tools['read_device'].input_schema.get('additionalProperties') is False
    step = {'device': '客厅灯', 'service': 'light', 'property': 'on', 'value': True}
    if scene:
        original_write = api.set_devices_prop
        def uncertain_second(params):
            if api.writes:
                api.outcome = 'unknown'
            return original_write(params)
        api.set_devices_prop = uncertain_second
        args = {'name': 'fixture', 'steps': [step, {**step, 'device': '空调', 'service': 'air-conditioner'}], 'idempotency_key': 'original'}
    else:
        api.outcome = 'unknown';args = {**step, 'idempotency_key': 'original'}
    original = (await server.call_tool('run_scene' if scene else 'control_device', args)).structured_content
    jsonschema.validate(original, SCHEMA)
    assert original['status']['state'] == ('partial' if scene else 'unknown')
    assert {effect['ref'] for effect in original['effects']} == {'original'}
    assert len(original['effects']) == (2 if scene else 1)
    for device, target in [('客厅灯', 'mijia:0'), ('空调', 'mijia:2')]:
        proof = (await server.call_tool('read_device', {'device': device, 'check_for': 'original'})).structured_content
        jsonschema.validate(proof, SCHEMA)
        assert proof['status']['state'] == 'succeeded'
        assert proof['effects'][0]['target'] == target
        assert proof['effects'][0]['ref'] == 'original'
    assert api.writes == (2 if scene else 1), 'checks must not execute the original operation'
