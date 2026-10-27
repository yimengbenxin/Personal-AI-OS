"""Failure isolation and trusted lineage at the pinned native hook boundary."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from functools import partial

import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("yimi_gateway_test", ROOT / "integrations/hermes/yimi_gateway/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
TOOL = "mcp__mijia__control_device"


@pytest.fixture
def gateway(monkeypatch):
    return plugin.Gateway({"capability_tools": [TOOL]})


@pytest.mark.parametrize("error", [TimeoutError(), OSError(), ValueError()])
def test_decide_and_catalog_errors_block_and_receipt_errors_never_return_raw(gateway, monkeypatch, error):
    def unavailable(*args):
        raise error
    monkeypatch.setattr(gateway, "rpc", unavailable)
    assert gateway.pre(TOOL, {})["action"] == "block"
    view = gateway.transform(TOOL, {}, result="raw secret-shaped result")
    assert "raw secret-shaped result" not in view
    receipt = json.loads(view.split("\n", 1)[1])
    assert receipt["status"] == {"state": "unknown", "reason_code": "gateway_unavailable"}
    assert receipt["next"]["retry"] == "after_check"
    gateway.post(TOOL, {}, result="raw result")


def test_decide_rpc_failure_is_caught_after_successful_catalog(gateway, monkeypatch):
    def request(operation, body=None):
        if operation == "catalog":
            return {"tools": [TOOL]}
        raise TimeoutError()
    monkeypatch.setattr(gateway, "rpc", request)
    assert gateway.pre(TOOL, {})["action"] == "block"
    assert "gateway_unavailable" in gateway.transform(TOOL, {}, result="raw")


@pytest.mark.parametrize("decision,expected", [
    ({"action": "approve", "message": "请确认：现实操作；对象：客厅灯", "rule_key": "{\"kind\":\"external\"}"}, "approve"),
    ({"action": "approve", "message": "请确认", "rule_key": ""}, "block"),
    ({"action": "approve", "rule_key": "scope"}, "block")])
def test_a_complete_approve_decision_reaches_the_native_approval_gate(gateway, monkeypatch, decision, expected):
    monkeypatch.setattr(gateway, "rpc", lambda operation, body=None: {"tools": [TOOL]} if operation == "catalog" else decision)
    result = gateway.pre(TOOL, {"device": "客厅灯", "owner_requested": False})
    assert result["action"] == expected
    assert result == decision if expected == "approve" else result["message"] == "能力判定服务暂时不可用，本次未执行。"


@pytest.mark.parametrize("view", [None, {}, ""])
def test_malformed_receipt_response_cannot_fail_open(gateway, monkeypatch, view):
    monkeypatch.setattr(gateway, "rpc", lambda operation, body=None: {"tools": [TOOL]} if operation == "catalog" else {"model_view": view})
    assert "gateway_unavailable" in gateway.transform(TOOL, {}, result="raw")


def test_nonpackage_and_disabled_family_pass_through(gateway, monkeypatch):
    operations = []
    def catalog(operation, body=None):
        operations.append(operation)
        assert operation == "catalog"
        return {"tools": [TOOL]}
    monkeypatch.setattr(gateway, "rpc", catalog)
    assert gateway.pre("read_file", {}) is None
    assert gateway.transform("read_file", {}, result="original") is None
    gateway.post("read_file", {})
    assert operations == ["catalog", "catalog", "catalog"]
    monkeypatch.setattr(gateway, "rpc", lambda *args: {"tools": []})
    assert gateway.pre(TOOL, {}) is None
    assert gateway.transform(TOOL, {}, result="original") is None


def test_envelopes_match_the_fixed_gateway_schemas(gateway):
    import jsonschema
    schemas = json.loads((ROOT / "capability/contracts/gateway-api.v1.json").read_text())["components"]["schemas"]
    fields = {"task_id": "child", "session_id": "root-session", "tool_call_id": "call", "turn_id": "turn", "result": {},
              "status": "success", "duration_ms": 1, "error_type": None, "error_message": None}
    for name, flags in [("PreToolCall", {}), ("TransformToolResult", {"result": True}), ("PostToolCall", {"result": True, "post": True})]:
        jsonschema.validate(gateway.envelope(TOOL, {}, fields, **flags), schemas[name])


def test_escaping_native_pre_hook_exception_is_measured_at_the_pin(monkeypatch):
    from hermes_cli import plugins
    from hermes_cli.lifecycle import invoke_hook
    manager = plugins.get_plugin_manager()
    def broken(**kwargs):
        raise RuntimeError("synthetic pre hook failure")
    monkeypatch.setattr(manager, "_discovered", True)
    monkeypatch.setitem(manager._hooks, "pre_tool_call", [broken])
    result = invoke_hook("pre_tool_call", tool_name="synthetic", args={})
    assert len(result) == 1 and result[0]["action"] == "block"


@pytest.mark.parametrize('status', ['completed', 'failed', 'error', 'timeout', 'interrupted'])
def test_native_stop_hook_forwards_all_outcomes_without_tool_rules(gateway, monkeypatch, status):
    calls = []
    monkeypatch.setattr(gateway, 'rpc', lambda operation, body=None: calls.append((operation, body)))
    gateway.lifecycle('subagent_stop', parent_session_id='root-session', parent_turn_id='root-turn',
        child_session_id='child-session', child_status=status, duration_ms=126165, child_summary='private diagnostic')
    assert calls == [('lifecycle', {'hook': 'subagent_stop', 'payload': {
        'parent_session_id': 'root-session', 'parent_turn_id': 'root-turn',
        'child_session_id': 'child-session', 'child_status': status, 'duration_ms': 126165}})]


from test_activity_phase2 import native_run


@pytest.mark.asyncio
async def test_replay_parent_terminal_drops_late_progress_but_native_stop_hook_survives(native_run, gateway, monkeypatch):
    import asyncio
    from test_activity_phase2 import reserve
    from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tools.delegate_tool_results import _fire_subagent_stop_hooks
    from hermes_cli import plugins
    adapter = native_run()
    reserve(adapter)
    callback = adapter._make_run_event_callback('run', asyncio.get_running_loop())
    parent = SimpleNamespace(session_id='root-session', _current_turn_id='root-turn', tool_progress_callback=callback)
    delegate = _build_child_progress_callback(0, '还在办', parent, subagent_id='delegate',
                                              session_ref={'session_id': 'delegate-session'})
    selfcheck = _build_child_progress_callback(1, '检查失败任务', parent, subagent_id='selfcheck',
                                               session_ref={'session_id': '20261025_094926_fixture'})
    delegate('subagent.start')
    selfcheck('subagent.start')
    selfcheck('subagent.complete', status='failed', exit_reason='error')
    await asyncio.sleep(0)
    adapter._set_run_status('run', 'completed')
    delegate('subagent.complete', status='failed', exit_reason='error')
    await asyncio.sleep(0)
    assert [(event['subagent_id'], event['event']) for event in adapter._run_statuses['run']['activity_events']] == [
        ('delegate', 'subagent.start'), ('selfcheck', 'subagent.start'), ('selfcheck', 'subagent.complete')]
    # This is the real native stop-hook dispatcher, after child cleanup, independent of the progress callback.
    calls = []
    monkeypatch.setattr(gateway, 'rpc', lambda operation, body=None: calls.append((operation, body)))
    manager = plugins.get_plugin_manager()
    monkeypatch.setattr(manager, '_discovered', True)
    monkeypatch.setitem(manager._hooks, 'subagent_stop', [partial(gateway.lifecycle, 'subagent_stop')])
    token = bind_api_run_conversation('root-run', 'root-session')
    try:
        _fire_subagent_stop_hooks([{'task_index': 0, 'status': 'failed', 'duration_seconds': 126.165}],
                                 {0: SimpleNamespace(session_id='delegate-session')}, parent)
    finally:
        reset_api_run_conversation(token)
    assert calls == [('lifecycle', {'hook': 'subagent_stop', 'payload': {
        'parent_session_id': 'root-session', 'parent_turn_id': 'root-turn', 'child_session_id': 'delegate-session',
        'child_role': None, 'child_status': 'failed', 'duration_ms': 126165,
        'telemetry_schema_version': 'hermes.observer.v1'}})]


def test_installed_plugin_receives_native_stop_hook():
    hooks = {}
    plugin.register(SimpleNamespace(get_config=lambda key, default=None: default,
        register_hook=lambda name, callback: hooks.update({name: callback})))
    assert hooks['subagent_stop'].func.__self__.__class__ is plugin.Gateway


def test_activity_session_state_follows_compression_without_ending_live_child(tmp_path):
    import sys
    sys.path.insert(0, str(ROOT))
    from integrations.hermes.personal_aios.run_api import activity_session_state
    from hermes_state import SessionDB
    db = SessionDB(tmp_path / 'child.db')
    try:
        db.create_session('child', source='subagent')
        db.publish_compression_child(parent_session_id='child', child_session_id='child-tip', source='subagent',
                                     messages=[{'role': 'user', 'content': 'fixture'}], require_compression_lease=False)
        assert db.get_session('child')['ended_at'] is not None
        assert activity_session_state(db, 'child') == {'id': 'child-tip', 'ended_at': None, 'end_reason': None}
        db.end_session('child-tip', 'agent_close')
        state = activity_session_state(db, 'child')
        assert state['id'] == 'child-tip' and state['ended_at'] is not None and state['end_reason'] == 'agent_close'
    finally:
        db.close()
