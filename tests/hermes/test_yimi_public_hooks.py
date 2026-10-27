"""The thin plugin forwards public identities and preserves package-owned media."""
import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('public_gateway', os.environ.get('PAIOS_PLUGIN_TEST_FILE', ROOT / 'integrations/hermes/yimi_gateway/__init__.py'))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
TOOL = 'mcp__owner_mac__computer_use'
IDS = dict(session_id='native-session', task_id='child-id', turn_id='native-turn',
           api_request_id='opaque-attempt', tool_call_id='call-id')
RECEIPT = {'receipt': 1, 'status': {'state': 'succeeded'}, 'effects': [], 'values': [],
           'content': [], 'unknowns': [], 'next': {'retry': 'forbidden', 'waiting_on': 'none'}}
SERIALIZED = json.dumps({'result': 'succeeded\nMEDIA:/fixture.png', 'structuredContent': RECEIPT})


def test_public_tool_ids_are_forwarded_without_identity_from_model_arguments():
    result = plugin.Gateway.envelope(TOOL, {'context': {'run_id': 'forged'}}, IDS)
    for key, value in IDS.items():
        assert result[key] == value


def test_registration_uses_own_settings_and_only_public_lifecycle_payloads(monkeypatch):
    calls, hooks = [], {}
    monkeypatch.setattr(plugin.Gateway, 'rpc', lambda self, operation, body=None: calls.append((operation, body)))
    config = {'internal_base_url': 'http://127.0.0.1:1234', 'capability_tools': [TOOL]}
    plugin.register(SimpleNamespace(get_config=lambda key, default=None: config.get(key, default),
        register_hook=lambda name, callback: hooks.update({name: callback})))
    for name in ['pre_llm_call', 'pre_api_request', 'subagent_start', 'subagent_stop',
                 'on_session_start', 'on_session_end', 'on_session_reset', 'on_session_delete', 'on_session_finalize']:
        assert name in hooks
    hooks['subagent_stop'](parent_session_id='native-session', parent_turn_id='native-turn',
        child_session_id='child-session', child_subagent_id='child-id', child_status='failed',
        duration_ms=12, child_summary='not forwarded', agent=object())
    assert calls == [('lifecycle', {'hook': 'subagent_stop', 'payload': {
        'parent_session_id': 'native-session', 'parent_turn_id': 'native-turn',
        'child_session_id': 'child-session', 'child_subagent_id': 'child-id',
        'child_status': 'failed', 'duration_ms': 12}})]


@pytest.mark.parametrize('result', [
    {'_multimodal': True, 'content': [{'type': 'text', 'text': SERIALIZED},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,Zml4dHVyZQ=='}}], 'text_summary': 'receipt'},
    SERIALIZED,
])
def test_admitted_package_result_passes_unchanged(result, monkeypatch):
    gateway = plugin.Gateway({'capability_tools': [TOOL]})
    before = copy.deepcopy(result)
    monkeypatch.setattr(gateway, 'rpc', lambda operation, body=None:
        {'tools': [TOOL]} if operation == 'catalog' else {'model_view': 'admitted receipt', 'passthrough': True})
    assert gateway.transform(TOOL, {}, result=result, **IDS) is None
    assert result == before


def test_service_loss_blocks_execution_and_returns_unknown_for_legacy_text(monkeypatch):
    gateway = plugin.Gateway({'capability_tools': [TOOL]})
    monkeypatch.setattr(gateway, 'rpc', lambda *args: (_ for _ in ()).throw(TimeoutError()))
    assert gateway.pre(TOOL, {}, **IDS)['action'] == 'block'
    assert 'gateway_unavailable' in gateway.transform(TOOL, {}, result='legacy', **IDS)
    complete = {'structuredContent': RECEIPT, 'content': [{'type': 'image', 'mimeType': 'image/png', 'data': 'AAAA'}]}
    assert gateway.transform('mcp__yimi_shared__dynamic__capture', {}, result=complete, **IDS) is None


def test_unreceipted_nontext_is_replaced_by_unknown_without_mutating_it(monkeypatch):
    gateway = plugin.Gateway({'capability_tools': [TOOL]})
    raw = {'content': [{'type': 'image', 'data': 'fixture', 'mimeType': 'image/png'}]}
    before = copy.deepcopy(raw)
    monkeypatch.setattr(gateway, 'rpc', lambda *args: (_ for _ in ()).throw(TimeoutError()))
    assert 'gateway_unavailable' in gateway.transform(TOOL, {}, result=raw, **IDS)
    assert raw == before
