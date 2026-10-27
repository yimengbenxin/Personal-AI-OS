"""Qualify the existing SSH/file/CUA results without claiming an external effect."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re

from capability.sdk.python.yimi_receipt import effect, receipt, to_mcp_result, unknown_fact, value
from capability.sdk.python.mcp_media import content as media_content

POLICIES = json.loads((Path(__file__).parents[1] / 'plugin.json').read_text())['extensions']['ai.yimi.capability']['tools']
READ_ACTIONS = {'capture', 'list_apps', 'list_windows', 'wait'}


def facts(raw, at, values, content, key=''):
    if isinstance(raw, dict):
        for name, item in raw.items():
            if not name.startswith('_') and name not in {'base64_content', 'content'}:
                facts(item, at, values, content, key + '.' + name if key else name)
        if isinstance(raw.get('content'), str):
            content.append(dict(key='content', text=raw['content'], provenance='observed'))
    elif isinstance(raw, list):
        values.append(value(key + '.count', len(raw), 'items', 'computed', 'owner Mac transport', at))
        for i, item in enumerate(raw):
            facts(item, at, values, content, f'{key}[{i}]')
    elif raw is not None:
        leaf = key.rsplit('.', 1)[-1]
        if isinstance(raw, str) and leaf in {'output', 'summary', 'text_summary', 'error', 'message', 'text'}:
            content.append(dict(key=key, text=raw, provenance='observed'))
        else:
            unit = {'bytes': 'B', 'bytes_written': 'B', 'file_size': 'B', 'png_bytes': 'B',
                    'width': 'px', 'height': 'px', 'total_lines': 'lines', 'returncode': 'exit_code'}.get(leaf, '1')
            values.append(value(key, raw, unit, 'observed', 'owner Mac transport', at))


def convert(name, args, raw, *, at=None):
    policy = POLICIES[name]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {'message': raw}
    at = at or datetime.now(timezone.utc).isoformat()
    fields = dict(values=[], content=[], effects=[], unknowns=[], next={'retry': 'forbidden'})
    facts(raw, at, fields['values'], fields['content'])
    error = raw.get('error')
    diagnostic = ' '.join(str(raw.get(key, '')) for key in ('error', 'code', 'message'))
    timeout = raw.get('returncode') in {124, 255, 130} or bool(re.search(r'tim(?:e[ -]?out|ed out)|disconnect', diagnostic, re.I))
    confirmed = raw.get('verified') is True or raw.get('effect') == 'confirmed'
    state, reason = 'unknown', 'UNCLASSIFIED_MAC_RESULT'
    if timeout:
        reason = 'MAC_TRANSPORT_UNKNOWN'
    elif error:
        state, reason = 'failed', 'MAC_OPERATION_FAILED'
    elif name == 'exec' and 'returncode' in raw:
        state, reason = ('succeeded', '') if raw['returncode'] == 0 else ('failed', 'COMMAND_EXIT_NONZERO')
        fields['unknowns'].append(unknown_fact('external_effects', 'Command exit status does not verify external effects.'))
    elif name == 'read' and 'content' in raw:
        state, reason = ('partial', 'RESULT_TRUNCATED') if raw.get('truncated') else ('succeeded', '')
    elif (name == 'write' and 'bytes_written' in raw) or (name in {'fetch', 'put'} and {'path', 'bytes'} <= raw.keys()):
        state, reason = 'succeeded', ''
    elif name == 'computer_use':
        if raw.get('ok') is False:
            state, reason = 'failed', str(raw.get('code') or 'COMPUTER_ACTION_FAILED')
        elif args['action'] in READ_ACTIONS and any(key in raw for key in ('mode', 'apps', 'windows', 'ok', '_multimodal')):
            state, reason = 'succeeded', ''
        elif confirmed:
            state, reason = 'succeeded', ''
        else:
            reason = 'COMPUTER_EFFECT_UNVERIFIED'
    effect_kind = policy.get('effect') or policy['effect_by_arg']['$.action'][args['action']]
    mutation = effect_kind != 'observe'
    if mutation and state in {'succeeded', 'unknown'}:
        verification = 'verified' if confirmed else 'service_ack' if state == 'succeeded' else 'not_verified'
        fields['effects'].append(effect(effect_kind, str(args.get(policy['target'][2:]) or 'owner Mac'),
            str(args.get('action') or name), verification,
            'Existing owner Mac operation result; external application effects require their own verification.'))
    if state == 'unknown':
        fields['unknowns'].append(unknown_fact('outcome', 'The transport did not establish the operation outcome.'))
        fields['next'] = dict(retry='after_check', check_with=policy['check_with'], waiting_on='none')
    elif state == 'failed' and mutation:
        fields['unknowns'].append(unknown_fact('partial_effects', 'An error does not prove that no earlier changes occurred.'))
        fields['next'] = dict(retry='after_check', check_with=policy['check_with'])
    return receipt(state, status={'reason_code': reason} if reason else {}, **fields)


def exception_result(name, error):
    # No exception message: SSH diagnostics and HTTP bodies can contain credentials.
    transport = not isinstance(error, (ValueError, PermissionError))
    body = receipt('unknown' if transport else 'failed', status={'reason_code': 'MAC_TRANSPORT_UNKNOWN' if transport else 'MAC_CALL_DENIED'},
        unknowns=[unknown_fact('outcome', type(error).__name__)] if transport else [],
        next={'retry': 'after_check' if transport else 'forbidden', 'check_with': POLICIES[name]['check_with']})
    return to_mcp_result(body)


def mcp_result(name, args, raw):
    original = raw
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {'message': raw}
    result = to_mcp_result(convert(name, args, raw))
    for block in media_content(original):
        if block['type'] == 'text':
            result['content'][0]['text'] += '\n' + block['text']
        else:
            result['content'].append(block)
    if isinstance(raw, dict) and raw.get('base64_content'):
        if raw.get('is_image'):
            result['content'].append({'type': 'image', 'mimeType': raw['mime_type'], 'data': raw['base64_content']})
        else:
            result['content'].append({'type': 'resource', 'resource': {
                'uri': (Path('/') / raw.get('path', 'attachment')).as_uri(),
                'mimeType': raw.get('mime_type', 'application/octet-stream'), 'blob': raw['base64_content']}})
    return result
