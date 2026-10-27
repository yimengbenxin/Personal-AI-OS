"""Product main-agent backlog registration through the unchanged native Kanban owner."""
import json
from types import SimpleNamespace

import pytest

from test_cloud_init import cloud, home, INTEGRATION, PRODUCT_CONFIG, load


@pytest.fixture
def native_board(home, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(home))
    # Native boards are shared across profiles; pin this fixture's board to its own temporary home.
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(home))
    monkeypatch.setenv('HERMES_PROFILE', 'default')
    for name in ('HERMES_KANBAN_TASK', 'HERMES_KANBAN_RUN_ID', 'HERMES_KANBAN_DB',
                 'HERMES_KANBAN_BOARD', 'HERMES_DELEGATED_CHILD_CONTEXT'):
        monkeypatch.delenv(name, raising=False)
    cloud.initialize(home, INTEGRATION, PRODUCT_CONFIG)
    config = load(home)
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from hermes_cli.profiles import list_profiles
    from model_tools import get_tool_definitions
    from tools import kanban_tools  # noqa: F401 - native registration
    from gateway.run_scope import restrict_agent
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    profiles = list_profiles()
    assert any(profile.name == 'default' for profile in profiles)
    tools = get_tool_definitions(enabled_toolsets=['kanban'], quiet_mode=True)
    agent = SimpleNamespace(platform='api_server', tools=tools)
    restrict_agent(agent, 'owner')
    return config, agent, kb, kbc


def test_initialized_main_can_record_unrepairable_issue_and_read_receipt(native_board):
    config, main, kb, kbc = native_board
    from gateway.run_scope import tool_block
    from tools.registry import registry
    assert config['kanban']['dispatch_in_gateway'] is False
    for platform in ('api_server', 'api_server_background', 'cron'):
        assert 'kanban' in config['platform_toolsets'][platform]
    assert 'kanban' in main._paios_delegate_toolsets
    assert main.valid_tool_names == {'kanban_create', 'kanban_list', 'kanban_show'}
    assert tool_block(main, 'kanban_create') is None
    receipt = json.loads(registry.dispatch('kanban_create', {
        'title': 'Cannot repair: fixture endpoint contract mismatch',
        'body': 'Observed failure: schema version mismatch. Tried local retry; needs owner repair.',
        'assignee': 'default', 'initial_status': 'blocked',
        'idempotency_key': 'growth-unrepairable-fixture',
    }))
    assert receipt['ok'] is True and receipt['status'] == 'blocked'
    print('native kanban receipt:', json.dumps(receipt, sort_keys=True))
    tid = receipt['task_id']
    conn = kbc.connect()
    try:
        task = kb.get_task(conn, tid)
        assert task.assignee == 'default' and task.created_by == 'default'
        assert task.status == 'blocked' and 'schema version mismatch' in task.body
        assert kb.latest_run(conn, tid) is None
    finally:
        conn.close()
    assert tool_block(main, 'kanban_list') is None
    listed = json.loads(registry.dispatch('kanban_list', {'status': 'blocked'}))
    assert tid in {task['id'] for task in listed['tasks']}
    assert tool_block(main, 'kanban_show') is None
    shown = json.loads(registry.dispatch('kanban_show', {'task_id': tid}))
    assert shown['task']['id'] == tid
    for name in ('kanban_complete', 'kanban_unblock', 'kanban_request_review', 'terminal'):
        assert tool_block(main, name)


@pytest.mark.parametrize('scope', ['guest', 'owner_uncertain'])
def test_restricted_main_cannot_write_or_query_backlog(native_board, scope):
    _, main, _, _ = native_board
    from gateway.run_scope import restrict_agent, tool_block
    restrict_agent(main, scope)
    assert not main.valid_tool_names
    for name in ('kanban_create', 'kanban_list', 'kanban_show'):
        assert tool_block(main, name)


@pytest.mark.parametrize('product_catalog', [False, True])
def test_delegated_child_still_cannot_mutate_native_board(native_board, product_catalog):
    _, main, kb, kbc = native_board
    from agent.delegation_context import delegated_child_context, is_dispatcher_owned_worker_context
    from tools.delegate_tool_toolsets import _resolve_child_toolsets
    from model_tools import get_tool_definitions
    from tools.registry import registry
    parent = main if product_catalog else SimpleNamespace(enabled_toolsets=['kanban'])
    enabled, disabled = _resolve_child_toolsets(parent, ['kanban'], 'leaf')
    assert 'kanban' not in enabled and 'kanban' in disabled
    with delegated_child_context():
        assert not is_dispatcher_owned_worker_context()
        assert not get_tool_definitions(enabled_toolsets=['kanban'], quiet_mode=True)
        rejected = json.loads(registry.dispatch('kanban_create', {
            'title': 'must not land', 'assignee': 'default', 'initial_status': 'blocked'}))
        assert rejected.get('error')
        conn = kbc.connect()
        try:
            with pytest.raises(PermissionError, match='delegate_task'):
                kb.create_task(conn, title='direct write must not land', assignee='default')
        finally:
            conn.close()
    conn = kbc.connect()
    try:
        assert kb.list_tasks(conn) == []
    finally:
        conn.close()
