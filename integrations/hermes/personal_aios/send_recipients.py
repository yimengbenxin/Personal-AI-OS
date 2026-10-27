"""Resolve sends from the native channel directory, not model-written effect metadata."""
import unicodedata
import json
from pathlib import Path

_RULES = json.loads((Path(__file__).resolve().parents[3] / 'capability/contracts/send-recipient-normalization.v1.json').read_text())


def wechat_name(value):
    return ''.join(char for char in unicodedata.normalize('NFC', value)
                   if not any(lo <= ord(char) <= hi for lo, hi in _RULES['decoration_ranges']))


def wechat_recipient(reference, directory):
    value = reference.strip()
    for prefix in ('wechat:', 'weixin:'):
        if value.lower().startswith(prefix):
            value = value[len(prefix):].strip()
            break
    rows = directory.get('platforms', {}).get('wechat', directory.get('platforms', {}).get('weixin', []))
    explicit = value.removeprefix('id:')
    matches = [row for row in rows if row.get('id') == explicit]
    if not matches:
        matches = [row for row in rows if wechat_name(row['name']) == wechat_name(value.removeprefix('name:'))]
    if len(matches) != 1:
        raise ValueError('SEND_RECIPIENT_AMBIGUOUS' if matches else 'SEND_RECIPIENT_UNRESOLVED')
    row = matches[0]
    name = wechat_name(row['name'])
    if not name and not row.get('id'):
        raise ValueError('SEND_RECIPIENT_UNRESOLVED')
    unique = sum(wechat_name(other['name']) == name for other in rows) == 1
    legacy = ([f"wechat:{row['id']}"] if row.get('id') else [])
    if unique:
        legacy += [f"wechat:{row['name']}", f'wechat:{name}']
    return {'target': 'wechat:' + ('id:' + row['id'] if row.get('id') else 'name:' + name),
            'legacy_recipients': list(dict.fromkeys(legacy))}


def prepare_wechat(args):
    from gateway.channel_directory import load_directory
    identity = wechat_recipient(args.get('recipient', ''), load_directory())
    # Execution receives the resolved address too; a forged recipient/effect cannot select another consent.
    pinned = {key: value for key, value in args.items() if key not in {'effect', 'task_type'}}
    return {'args': {**pinned, 'recipient': identity['target']}, 'consent': identity}


def message_kind(args):
    action = args.get('action', 'send')
    if action in {'react', 'unreact'}:
        return action
    if action != 'send':
        raise ValueError('SEND_KIND_UNRESOLVED')
    from gateway.platforms.base import BasePlatformAdapter
    media, _ = BasePlatformAdapter.extract_media(args.get('message', ''))
    return 'file' if media else 'text'


def prepare_phone(args):
    """The manifest's finite send variants, resolved through the same native contact authority."""
    reference = args.get('recipient', '')
    if reference.startswith(('wechat:', 'weixin:')):
        prepared = prepare_wechat(args)
        prepared['args']['task_type'] = args['task_type']
    else:
        from .effects import prepare_message
        pinned, _ = prepare_message({'target': reference, 'message': '', 'action': 'send'})
        prepared = {'args': {**args, 'recipient': pinned['target']}, 'consent': {'target': pinned['target']}}
    prepared['consent']['message_kind'] = 'file' if args['task_type'] == 'send_file' else 'text'
    return prepared
