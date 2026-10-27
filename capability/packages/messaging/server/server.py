"""Reuse Hermes' native messaging engine inside the shared MCP host or its existing process."""
from pathlib import Path

from .delivery import Delivery


def prepare(args):
    from integrations.hermes.personal_aios.effects import prepare_message
    if args.get('action') == 'list':
        return {k: v for k, v in args.items() if k != 'owner_requested'}, None
    pinned, effect = prepare_message({**args, 'action': args.get('action', 'send')}, args.get('owner_requested'))
    pinned.pop('owner_requested', None)
    pinned.pop('requested', None)
    return pinned, effect


def prepare_call(name, args):
    if name != 'send_message':
        return {'args': args}
    pinned, effect = prepare(args)
    from integrations.hermes.personal_aios.send_recipients import message_kind
    return {'args': {**pinned, 'owner_requested': args.get('owner_requested') is True},
            'consent': {'target': pinned['target'], 'message_kind': message_kind(pinned),
                        'summary': effect['summary']} if effect else {}}


def parameters():
    from integrations.hermes.personal_aios.effects import send_message_schema
    schema = send_message_schema()['parameters']
    schema['properties'].pop('requested', None)
    schema['properties']['owner_requested'] = {'type': 'boolean'}
    schema['properties']['idempotency_key'] = {'type': 'string'}
    return schema


def create(sender=None, directory=None):
    from hermes_constants import get_hermes_home
    if sender is None:
        import os
        import json
        from urllib.request import Request, urlopen
        def sender(args):
            request = Request('http://127.0.0.1:' + os.environ['API_SERVER_PORT'] + '/v1/paios/capability/native-message',
                json.dumps(args).encode(), headers={'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + os.environ['API_SERVER_KEY']})
            with urlopen(request, timeout=120) as response:
                return json.load(response)
    return Delivery(Path(directory or get_hermes_home() / 'capability/messaging') / 'calls.sqlite', sender)


def register(host, sender=None, directory=None):
    delivery = create(sender, directory)
    host.add('send_message', delivery.invoke, parameters(), '向已核实的稳定平台地址发送消息、附件或回应；action=list 查询联系人。')
    host.add('message_status', delivery.status, {'type': 'object', 'required': ['idempotency_key'],
        'properties': {'idempotency_key': {'type': 'string'}, 'owner_requested': {'type': 'boolean'}},
        'additionalProperties': False}, '只读核对同一次发送的执行回执；结果未知时不要再次发送。')
