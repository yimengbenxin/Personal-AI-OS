"""Authenticated adapters to the existing native tool registry and package implementations."""
import importlib
import json
from pathlib import Path


def package_tool(identity):
    from .capability_packages import lookup
    dynamic = lookup(identity)
    if dynamic:
        return dynamic
    root = Path(__file__).resolve().parents[3]
    from hermes_cli.config import load_config
    enabled = load_config().get('personal_aios', {}).get('capability_tools', [])
    if identity not in enabled:
        raise ValueError('CAPABILITY_TOOL_NOT_ENABLED')
    _, server, name = identity.split('__', 2)
    for directory in (root / 'capability/packages').iterdir():
        path = directory / 'plugin.json'
        if not path.is_file():
            continue
        cap = json.loads(path.read_text())['extensions']['ai.yimi.capability']
        if cap['runtime']['server'] == server and name in cap['tools']:
            definition = json.loads((directory / 'mcp.json').read_text())['mcpServers'][server]
            shared = definition.get('args', [])[:2] == ['-m', 'capability.hosts.python']
            from tools.mcp_tool_schema import mcp_prefixed_tool_name
            actual = mcp_prefixed_tool_name('yimi_shared' if shared else server,
                                           server + '__' + name if shared else name)
            return cap, name, definition, actual, None
    raise ValueError('CAPABILITY_MANIFEST_REQUIRED')


def prepare(body):
    cap, name, definition, _, _ = package_tool(body['tool_name'])
    args = body['args']
    if cap['runtime']['server'] == 'phone' and name == 'phone_task' and args.get('task_type') in {'send_message', 'wechat_message', 'send_file'}:
        from .send_recipients import prepare_phone
        return prepare_phone(args)
    if definition.get('args', [])[:2] == ['-m', 'capability.hosts.python']:
        module = importlib.import_module(definition['args'][2])
        if hasattr(module, 'prepare_call'):
            return module.prepare_call(name, args)
    return {'args': args}


def execute(body):
    from gateway.run_scope import runtime_scope
    from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation
    from tools.registry import registry
    cap, name, _, transport, version = package_tool(body['tool_name'])
    if version != body.get('package_digest'):
        raise ValueError('CAPABILITY_FROZEN_VERSION_CHANGED')
    context = body['consent']['context']
    # The authenticated platform freezes this call only after the existing gate succeeds.
    # Native messaging aliases keep the process' live reaction adapters.
    if version is None and cap['runtime']['server'] == 'messaging':
        transport = name
    policy = bind_api_run_conversation(context['run_id'], context['session_id'])
    try:
        with runtime_scope('owner', ()):
            return registry.dispatch(transport, body['args'], task_id=body['task_id'],
                                     session_id=context['session_id'], tool_call_id=context['tool_call_id'],
                                     api_request_id='')
    finally:
        reset_api_run_conversation(policy)


def release_gate(body):
    import re
    from .release_status import read_status
    call = body['call']
    request_id = call['args'].get('request_id', '')
    if not isinstance(request_id, str) or not re.fullmatch(r'[0-9a-f]{12}', request_id):
        return {'action': 'block', 'message': 'RELEASE_EXACT_CANDIDATE_REQUIRED'}
    import os
    spool = Path(os.environ['PAIOS_RELEASE_SPOOL'])
    status = read_status(spool, request_id)
    path = spool / 'decisions' / (request_id + '.json')
    saved = json.loads(path.read_text()) if path.is_file() else {}
    allowed = (saved.get('approved') is True and saved.get('request_id') == request_id
               and saved.get('principal_id') == call['admission']['d']['principal_id'] and isinstance(status, dict)
               and all(isinstance(saved.get(key), str) and saved[key] == status.get(key) for key in ('base', 'commit')))
    return {'action': 'allow'} if allowed else {'action': 'block', 'message': 'RELEASE_CONFIRMATION_REQUIRED'}


def operation(name, body):
    if name.startswith('package-'):
        from . import capability_packages
        return {'package-prepare': capability_packages.prepare, 'package-activate': capability_packages.activate,
                'package-health': capability_packages.healthy}[name](body)
    if name == 'native-message':
        from tools.send_message_tool import send_message_tool
        return json.loads(send_message_tool(body))
    if name == 'prepare':
        return prepare(body)
    if name == 'execute':
        return execute(body)
    if name == 'release-gate':
        return release_gate(body)
    if name == 'registration-check':
        from .capability_packages import request
        return request('/capability-check', body)
    if name == 'discovery':
        from .workshop_capability import local_discovery
        return local_discovery(body['query'], body['source'])
    raise ValueError('CAPABILITY_OPERATION_UNKNOWN')
