"""Frozen package/Keynote contracts, shared stdio and honest offline consent behavior."""
import asyncio
from copy import deepcopy
import importlib
import json
import os
from pathlib import Path
import sys

import jsonschema
import pytest

from capability.hosts.python import Host
from capability.packages.load import load_packages

ROOT = Path(__file__).parents[2]
PACKAGE = ROOT / 'capability/packages/meeting-assistant'
CONTRACTS = ROOT / 'capability/contracts'
module = importlib.import_module('capability.packages.meeting-assistant.server.server')
contract = importlib.import_module('capability.packages.meeting-assistant.server.contract')
FakePlatform = importlib.import_module('capability.packages.meeting-assistant.fake.server').FakePlatform
RECEIPT = json.loads((CONTRACTS / 'receipt.v1.schema.json').read_text())
CASES = json.loads((PACKAGE / 'tests/contract.yaml').read_text())['fixtures']
CONTEXT = {'run_id': 'run:demo', 'session_id': 'session:demo', 'tool_call_id': 'call:demo'}


def args(case):
    return {'target_id': 'deck:demo', 'context': CONTEXT, **case['args']}


def test_manifest_loads_shared_host_and_skill_without_deployment_changes(tmp_path):
    plugin = json.loads((PACKAGE / 'plugin.json').read_text())
    jsonschema.validate(plugin, json.loads((CONTRACTS / 'upstream/plugin-1.0.0.schema.json').read_text()))
    extension = plugin['extensions']['ai.yimi.capability']
    jsonschema.validate(extension, json.loads((CONTRACTS / 'manifest.v1.schema.json').read_text()))
    assert json.loads((PACKAGE / 'mcp.json').read_text())['mcpServers']['meeting_assistant']['type'] == 'stdio'
    servers, skills, tools = load_packages(ROOT, {'capability_packages': {
        'enabled': ['meeting-assistant'], 'gateway': ['meeting-assistant']}}, tmp_path)
    assert servers['yimi_shared']['args'][-1] == 'meeting_assistant=capability.packages.meeting-assistant.server.server'
    assert str(PACKAGE / 'skills') in skills and (PACKAGE / 'skills/meeting-assistant/SKILL.md').is_file()
    assert 'mcp__meeting_assistant__apply_text' in tools
    assert extension['tools']['apply_text']['effect'] == 'owner_data'
    assert extension['tools']['apply_text']['task_type'] == 'document.text.update'
    assert extension['scopes'] == ['owner'] and extension['network']['egress'] == []
    assert extension['secrets'] == [{'name': 'PAIOS_HERMES_INTERNAL_KEY'}]


@pytest.mark.parametrize('case', CASES, ids=lambda row: row['name'])
@pytest.mark.parametrize('backend', ['fake', 'skeleton'])
def test_contract_matrix(case, backend):
    port = FakePlatform() if backend == 'fake' else None
    host = Host()
    module.register(host, port)
    assert set(host.tools) == set(contract.SCHEMAS)
    for _, tool in host.tools.values():
        assert tool.output_schema == RECEIPT
        for forbidden in ('effect', 'grant', 'execution', 'script', 'target_device_id', 'scope_session_id'):
            assert forbidden not in tool.input_schema['properties']
    result = host.tools[case['tool']][0](**args(case))
    jsonschema.validate(result, RECEIPT)
    assert result['status']['state'] == (case['state'] if backend == 'fake' else 'unknown')
    if backend == 'skeleton':
        assert result['status']['reason_code'] == 'MEETING_ADAPTER_NOT_WIRED'
    assert not result.get('delivery')  # Sixth fact is authored only by the platform ledger.
    if port:
        assert port.writes == 0


def test_fake_confirmation_is_outside_model_tools_and_success_has_save_readback_and_one_write():
    port = FakePlatform()
    host = Host()
    module.register(host, port)
    call = args(CASES[3])
    assert host.tools['apply_text'][0](**call, owner_requested=True)['status']['state'] == 'waiting'
    assert port.writes == 0 and not any('confirm' in name for name in host.tools)
    port.confirm()
    result = host.tools['apply_text'][0](**call)
    assert result['status']['state'] == 'succeeded'
    assert host.tools['apply_text'][0](**call) == result and port.writes == 1
    assert host.tools['edit_status'][0](target_id='deck:demo', context=CONTEXT,
                                      idempotency_key=call['idempotency_key']) == result
    native = json.loads(result['content'][0]['text'])
    contract.validate_native('edit_result', native)
    assert native['checks'][0]['after_text_sha256'] != native['checks'][0]['before_text_sha256']
    assert native['review_status'] == 'awaiting_owner'
    assert native['checks'][0]['evidence_ref'] in result['work_items'][0]['effect_refs']
    jsonschema.validate(result, RECEIPT)
    jsonschema.validate(result['work_items'], json.loads((CONTRACTS / 'work-items.v1.schema.json').read_text()))


@pytest.mark.parametrize('extra', [{'grant': {}}, {'execution': {}}, {'script': 'activate'},
                                  {'target_id': 'https://docs.example/test'}, {'context': {}},
                                  {'scope_session_id': 'injected'}, {'target_device_id': 'other'}])
def test_invalid_calls_never_reach_port(extra):
    class MustNotInvoke:
        def invoke(self, *args):
            pytest.fail('invalid arguments reached platform')
    host = Host()
    module.register(host, MustNotInvoke())
    result = host.tools['apply_text'][0](**{**args(CASES[3]), **extra})
    assert result['status']['reason_code'] == 'MEETING_INPUT_INVALID'


def test_plan_is_closed_local_keynote_and_hashes_match_cross_language_fixture():
    plan = FakePlatform().demo['plan']
    contract.validate_plan(plan)
    for mutate in (lambda p: p['edits'][0].update(op='delete_slide'),
                   lambda p: p['target'].update(file_url='https://online.example/demo.key'),
                   lambda p: p['edits'][0].update(script='activate')):
        changed = deepcopy(plan)
        mutate(changed)
        changed['plan_sha256'] = contract.plan_hash(changed)
        with pytest.raises(jsonschema.ValidationError):
            contract.validate_plan(changed)
    changed = deepcopy(plan)
    changed['edits'][0]['after_text'] = 'unconfirmed'
    with pytest.raises(ValueError, match='HASH_MISMATCH'):
        contract.validate_plan(changed)


def test_status_operation_alias_uses_the_existing_gateway_idempotency_check_key():
    port = FakePlatform()
    host = Host()
    module.register(host, port)
    port.confirm()
    call = args(CASES[3])
    result = host.tools['apply_text'][0](**call)
    operation_id = json.loads(result['content'][0]['text'])['operation_id']
    assert operation_id == 'op:' + call['idempotency_key']
    original = {'target_id': 'deck:demo', 'context': CONTEXT, 'operation_id': operation_id}
    modified = module.prepare_call('edit_status', original)['args']
    prepared = {**original, **modified}  # Actual Hermes modify.args shallow-merge behavior.
    assert prepared['operation_id'] == operation_id
    assert prepared['idempotency_key'] == call['idempotency_key']
    assert original['operation_id'] == operation_id
    assert host.tools['edit_status'][0](**prepared) == result
    conflict = {**original, 'idempotency_key': 'different'}
    assert host.tools['edit_status'][0](**conflict)['status']['reason_code'] == 'MEETING_INPUT_INVALID'


def test_transport_exception_never_claims_failure_or_leaks_private_details():
    class Interrupted:
        def invoke(self, *args):
            raise TimeoutError('fixture private transport')
    host = Host()
    module.register(host, Interrupted())
    result = host.tools['apply_text'][0](**args(CASES[3]))
    assert result['status']['state'] == 'unknown' and result['next']['retry'] == 'after_check'
    assert 'private transport' not in json.dumps(result)


@pytest.mark.parametrize('backend', ['fake', 'server'])
def test_real_shared_stdio_contract(backend):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def run():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'capability.hosts.python',
            f'meeting_assistant=capability.packages.meeting-assistant.{backend}.server'], env={**os.environ,
                'PYTHONPATH': os.pathsep.join([str(ROOT), os.environ.get('PYTHONPATH', '')])})
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                listing = await session.list_tools()
                assert {tool.name for tool in listing.tools} == {'meeting_assistant__' + name for name in contract.SCHEMAS}
                body = await session.call_tool('meeting_assistant__apply_text', {**args(CASES[3]), 'owner_requested': True})
                assert body.structured_content['status']['state'] == ('waiting' if backend == 'fake' else 'unknown')
                assert len(body.content) == 1 and body.content[0].type == 'text'
                jsonschema.validate(body.structured_content, RECEIPT)
                status = await session.call_tool('meeting_assistant__edit_status', {'target_id': 'deck:demo',
                    'context': CONTEXT, 'operation_id': 'op:missing', 'idempotency_key': 'missing'})
                assert status.structured_content['status']['state'] == 'unknown'

    asyncio.run(run())


def test_platform_bridge_uses_loopback_context_and_receipts_without_adding_authority():
    Platform = importlib.import_module('capability.packages.meeting-assistant.server.platform').Platform
    calls = []
    def request(body):
        calls.append(body)
        return {'args': body['args'], 'consent': {'preview_items': ['第2页：60家店']}} if body['method'] == 'prepare' else FakePlatform().invoke('read_deck', body['args'])
    bridge = Platform(request)
    arguments = args(CASES[0])
    assert bridge.invoke('read_deck', arguments)['status']['state'] == 'succeeded'
    assert bridge.prepare('apply_text', arguments)['consent']['preview_items'] == ['第2页：60家店']
    assert calls[0] == {'method': 'invoke', 'tool': 'read_deck', 'args': arguments}
    assert not any(key in calls[0] for key in ['principal_id', 'grant', 'execution', 'target_device_id'])
