"""Freeze an existing WeChat send batch, reusing the owner_mac transport and cached primitives."""
import shlex
from pathlib import Path

from capability.sdk.python.yimi_receipt import receipt, effect, unknown_fact
from capability.packages.messaging.server.delivery import Delivery


def prepare_call(name, args):
    if name in {'wechat_send_text', 'wechat_send_file', 'wechat_reply'}:
        from integrations.hermes.personal_aios.send_recipients import prepare_wechat
        return prepare_wechat(args)
    return {'args': args}


def execute(args):
    from integrations.hermes.personal_aios.owner_mac import environment, resolve
    command=args.get('command')
    if args.get('read_recent'):
        binding=resolve(args['context'],args.get('device_id',''),read_only=True)
        key=(Path(__file__).parents[4]/'integrations/hermes/personal_aios/errands/wechat/references/cache-key.txt').read_text().strip()
        command=shlex.quote(str(Path(binding['home'])/'Library/Application Support/PersonalAIOS/wechat'/key/'ax-read'))
    with environment(args['context'], args.get('device_id', ''),read_only=args.get('read_recent', False)) as env:
        result = env.execute(command, timeout=120, bounded_capture=True)
    # A completed shell batch/posted input cannot prove delivery; read the same chat before any retry.
    return result


def register(host, transport=execute, directory=None):
    from hermes_constants import get_hermes_home
    def sender(args):
        result = transport(args)
        if args.get('action') == 'list':
            return {'targets': result['output']} if result['returncode'] == 0 else {'error': 'read_failed'}
        return {'error': 'Send batch returned without a recipient delivery acknowledgement.'}
    delivery = Delivery(Path(directory or get_hermes_home() / 'capability/wechat-mac') / 'calls.sqlite', sender)

    def send(command, recipient, context, idempotency_key='', device_id=''):
        result = delivery.invoke(idempotency_key=idempotency_key, command=command, target=recipient,
                                 context=context, device_id=device_id)
        if result['status']['state'] == 'unknown':
            result['next']['check_with'] = 'wechat_read_recent'
            result['effects'] = [effect('send', recipient, 'send', 'unknown', '', idempotency_key)]
        return result

    params = {'type': 'object', 'required': ['command', 'recipient', 'context'], 'additionalProperties': False,
        'properties': {'command': {'type': 'string'}, 'recipient': {'type': 'string'}, 'context': {'type': 'object'},
                       'idempotency_key': {'type': 'string'}, 'device_id': {'type': 'string'},
                       'owner_requested': {'type': 'boolean'}}}
    for name in ('wechat_send_text', 'wechat_send_file', 'wechat_reply'):
        host.add(name, send, params, '执行已准备的 Mac 微信发送批次；沿用现有原语、稳定身份核验和现场恢复。')

    def read(recipient, context, device_id='', check_for=''):
        try:
            result = transport({'read_recent': True, 'target': recipient, 'context': context, 'device_id': device_id})
        except Exception:
            return receipt('unknown',status={'reason_code':'TRANSPORT_DISCONNECTED'},
                unknowns=[unknown_fact('visible_chat','The read transport disconnected.')],
                next={'retry':'after_check','check_with':'wechat_read_recent'})
        if result['returncode']:
            return receipt('failed', status={'reason_code': 'WECHAT_READ_UNAVAILABLE'})
        return receipt('succeeded', content=[{'key': 'visible_chat', 'text': result['output'], 'provenance': 'observed'}],
            effects=[effect('observe', recipient, 'read_recent', 'service_ack', 'ax-read completed', check_for)] if check_for else [])
    host.add('wechat_read_recent', read, {'type': 'object', 'required': ['recipient', 'context'],
        'properties': {'recipient': {'type': 'string'}, 'context': {'type': 'object'},
                       'device_id': {'type': 'string'}, 'check_for': {'type': 'string'}, 'owner_requested': {'type': 'boolean'}},
        'additionalProperties': False}, '用已有 ax-read 原语只读核对当前微信聊天；AX 不可见时沿用截图和 vision。')
