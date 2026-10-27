"""Production package selection, portable transports and native identity mapping."""
from pathlib import Path
import importlib
import json
import os
import sys

import pytest

from capability.packages.load import load_packages
from capability.hosts.python import Host
from capability.packages.phone.server.registration import select_transport

ROOT = Path(__file__).parents[2]
NAMES = ['mijia', 'phone', 'messaging', 'wechat-mac', 'ts-delivery', 'ts-erasure', 'ts-health',
         'ts-location', 'ts-memory', 'ts-model-settings', 'ts-personal', 'ts-personality', 'ts-schedule', 'desktop', 'owner-mac']


def test_package_boundary_converts_images_and_preserves_media_without_kernel_mutation():
    from capability.sdk.python.mcp_media import content
    image = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,fixture'}}
    raw = {'content': [{'type': 'text', 'text': 'coordinate map'}, image], 'result': 'MEDIA:/fixture.png'}
    blocks = content(raw)
    assert blocks == [{'type': 'text', 'text': 'coordinate map'},
        {'type': 'image', 'mimeType': 'image/png', 'data': 'fixture'}, {'type': 'text', 'text': 'MEDIA:/fixture.png'}]
    assert raw['content'][1] == image


def test_release_gate_reuses_only_the_exact_source_candidate_and_owner(tmp_path, monkeypatch):
    from integrations.hermes.personal_aios.capability_runtime import release_gate
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(tmp_path))
    for name in ('status', 'decisions'):
        (tmp_path / name).mkdir()
    source = {'request_id': '123456abcdef', 'base': 'a' * 40, 'commit': 'b' * 40}
    (tmp_path / 'status/123456abcdef.json').write_text(json.dumps(source))
    (tmp_path / 'decisions/123456abcdef.json').write_text(json.dumps({**source, 'principal_id': 'owner', 'approved': True}))
    body = {'call': {'args': {'request_id': source['request_id']}, 'admission': {'d': {'principal_id': 'owner'}}}}
    assert release_gate(body)['action'] == 'allow'
    (tmp_path / 'status/123456abcdef.json').write_text(json.dumps({**source, 'commit': 'c' * 40}))
    assert release_gate(body)['action'] == 'block'
    body['call']['admission']['d']['principal_id'] = 'foreign'
    assert release_gate(body)['action'] == 'block'
    body['call']['args']['request_id'] = '../123456abcdef'
    assert release_gate(body)['action'] == 'block'


def test_dynamic_package_cannot_select_the_native_messaging_alias_with_server_metadata(monkeypatch):
    from unittest.mock import Mock
    from integrations.hermes.personal_aios import capability_runtime
    from tools.registry import registry
    identity = 'mcp__yimi_shared__owner_example__send_message'
    version = 'a' * 64
    monkeypatch.setattr(capability_runtime, 'package_tool', lambda name: (
        {'runtime': {'server': 'messaging'}}, 'send_message', {}, identity, version))
    dispatch = Mock(return_value='isolated package result')
    monkeypatch.setattr(registry, 'dispatch', dispatch)
    body = {'tool_name': identity, 'package_digest': version, 'task_id': 'task', 'args': {},
            'consent': {'context': {'run_id': 'run', 'session_id': 'session', 'tool_call_id': 'call'}}}
    assert capability_runtime.execute(body) == 'isolated package result'
    assert dispatch.call_args.args[0] == identity


def test_all_families_share_transports_without_rewriting_module_arguments(tmp_path):
    product = {'capability_packages': {'enabled': NAMES, 'gateway': NAMES}}
    servers, skills, tools = load_packages(ROOT, product, tmp_path, environ={'PAIOS_INTEGRATION_PORT': '19661'})
    assert set(servers) == {'mijia', 'phone', 'yimi_shared', 'platform_ts', 'desktop', 'owner_mac'}
    assert servers['yimi_shared']['args'] == ['-m', 'capability.hosts.python',
        'messaging=capability.packages.messaging.server.server', 'wechat-mac=capability.packages.wechat-mac.server.server']
    assert len(skills) == 15
    assert servers['platform_ts']['url'] == 'http://127.0.0.1:19661/internal/capability/mcp'
    assert servers['platform_ts']['headers']['Authorization'] == 'Bearer ${PAIOS_HERMES_INTERNAL_KEY}'
    assert servers['desktop']['url'] == 'http://127.0.0.1:19661/internal/desktop/mcp'
    assert servers['owner_mac']['args'] == [str(ROOT / 'capability/packages/owner-mac/server/main.py')]
    assert {'send_message', 'mcp__messaging__send_message', 'mcp__yimi_shared__messaging__send_message'} <= set(tools)
    assert 'paios_health_query' in tools
    legacy = {'command': '/provider/python', 'args': ['old.py'], 'env': {
        'PROVIDER': 'same', 'PAIOS_PHONE_PROVIDER': 'mac-android', 'PAIOS_INTEGRATION_PORT': '19661',
        'PAIOS_DEEPSEEK_KEY_FILE': str(tmp_path / 'fast.key'), 'PAIOS_SILICONFLOW_KEY_FILE': str(tmp_path / 'vision.key'),
        'PAIOS_MOBILERUN_CONFIG': str(tmp_path / 'mobilerun.yaml'), 'PAIOS_ERRAND_SPOOL': str(tmp_path / 'spool'),
        'PAIOS_PAYMENT_URL': 'http://127.0.0.1:19661', 'PAIOS_PAYMENT_KEY_FILE': str(tmp_path / 'payment.key')}, 'timeout': 660}
    phone = select_transport(product['capability_packages'], legacy, servers['phone'])
    assert phone['command'] == legacy['command'] and phone['timeout'] == 660
    assert phone['env']['PROVIDER'] == 'same'
    assert phone['args'] == [str(ROOT / 'capability/packages/phone/server/main.py')]


@pytest.mark.parametrize('family', NAMES[1:])
def test_per_family_gateway_rollback_removes_only_its_new_transport_and_skills(tmp_path, family):
    product = {'capability_packages': {'enabled': NAMES, 'gateway': [name for name in NAMES if name != family]}}
    servers, skills, tools = load_packages(ROOT, product, tmp_path)
    extension = json.loads((ROOT / 'capability/packages' / family / 'plugin.json').read_text())['extensions']['ai.yimi.capability']
    assert str(ROOT / 'capability/packages' / family / 'skills') not in skills
    for tool in extension['tools']:
        assert 'mcp__' + extension['runtime']['server'] + '__' + tool not in tools
    if family == 'phone':
        legacy = {'command': 'old'}
        assert select_transport(product['capability_packages'], legacy, None) is legacy


def test_shared_host_keeps_declared_names_distinct_and_uses_the_same_receipt_contract(tmp_path):
    host = Host()
    for package, kwargs in [('messaging', {'sender': lambda args: {'success': True}}), ('wechat-mac', {'transport': lambda args: {}})]:
        module = importlib.import_module('capability.packages.' + package + '.server.server')
        host.namespace = package + '__'
        module.register(host, directory=tmp_path / package, **kwargs)
    assert len(host.tools) == 6
    assert {'messaging__send_message', 'wechat-mac__wechat_send_text'} <= host.tools.keys()
    for _, tool in host.tools.values():
        assert tool.output_schema['$id'] == 'urn:yimi:capability:receipt:1'


def test_dynamic_package_versions_refresh_on_the_same_native_mcp_connection(tmp_path, monkeypatch):
    import importlib.util
    import yaml
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from integrations.hermes.personal_aios import capability_packages as live, workshop
    from tools.mcp_tool_discovery import discover_mcp_tools, _get_connected_server_for_call
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.registry import registry
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    config = {'plugins': {'enabled': []}, 'skills': {'external_dirs': []}, 'mcp_servers': {'yimi_shared': {
        'command': sys.executable, 'args': ['-B', '-m', 'capability.hosts.python', 'registry=capability.hosts.registry'],
        'cwd': str(ROOT), 'env': {'HERMES_HOME': str(tmp_path), 'PYTHONPATH': str(ROOT) + ':' + os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT']},
        'timeout': 15}}, 'personal_aios': {'capability_tools': []}}
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    template = ROOT / 'capability/templates/yimi-capability-template'
    files = {str(path.relative_to(template)): path.read_text() for path in template.rglob('*') if path.is_file()}
    manifest = json.loads(files['plugin.json'])
    def bridge(path, body):
        assert path == '/capability-invoke'
        return {'result': {'tools': [{'name': 'sample', 'inputSchema': {'type': 'object', 'properties': {}}}]}}
    monkeypatch.setattr(live, 'request', bridge)
    def version(number):
        return {'name': manifest['name'], 'version': '0.' + str(number) + '.0', 'digest': str(number) * 64,
                'root': str(template), 'manifest': manifest}
    try:
        discover_mcp_tools()
        host = _get_connected_server_for_call('yimi_shared')
        first = version(1)
        live.prepare({'principal_id': 'owner', 'version': first, 'files': files})
        live.activate({'principal_id': 'owner', 'name': first['name'], 'expected': None, 'next': first})
        stored = next(iter(live.read_installed().values()))
        name = live.identity(stored, 'sample')
        assert registry.get_entry(name)
        old_handler = registry.get_entry(name).handler
        assert _get_connected_server_for_call('yimi_shared') is host
        second = version(2)
        live.prepare({'principal_id': 'owner', 'version': second, 'files': files})
        live.activate({'principal_id': 'owner', 'name': first['name'], 'expected': first['digest'], 'next': second})
        assert _get_connected_server_for_call('yimi_shared') is host
        assert any(tool.meta.get('yimi.version') == second['digest'] for tool in host._tools)
        assert registry.get_entry(name) is None
        late = old_handler({})
        assert json.loads(late).get('error'), 'a call that passed preflight before the swap cannot execute the new version'
        from integrations.hermes.personal_aios.capability_runtime import execute
        with pytest.raises(ValueError, match='TOOL_NOT_ENABLED'):
            execute({'tool_name': name, 'package_digest': first['digest']})
        live.activate({'principal_id': 'owner', 'name': first['name'], 'expected': second['digest'], 'next': None})
        assert registry.get_entry(name) is None
        assert _get_connected_server_for_call('yimi_shared') is host
    finally:
        shutdown_mcp_servers()
        reset_hermes_home_override(token)
