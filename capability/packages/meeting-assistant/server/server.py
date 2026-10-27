"""Small shared-host package; platform owns consent, identity, storage and Mac routing."""
from functools import partial

from jsonschema import ValidationError

from capability.sdk.python.yimi_receipt import failed, unknown, unknown_fact
from .contract import SCHEMAS, validate_call
from .port import UnwiredPlatform
from .platform import Platform

DESCRIPTIONS = {
    'read_deck': '只读准确的本地 Keynote 文档、当前页及文字；不切页、不投屏。',
    'locate_region': '用同一会话的话语、眼镜帧与当前页定位指向；不分析人脸、表情或情绪。',
    'plan_text': '整理已有文字的封闭计划和逐条预览；不修改主人文件。',
    'apply_text': '执行平台确认的本地 Keynote 文字计划；首次等待确认，结果未知先查状态。',
    'edit_status': '只读核对原操作的保存和回读凭据；不重复修改。',
}


def normalize_call(name, args):
    """Native op:<key> aliases normalize to the gateway's existing check_for key."""
    prepared = dict(args)
    operation = prepared.get('operation_id')
    if (name == 'edit_status' and isinstance(operation, str) and operation.startswith('op:')
            and prepared.get('idempotency_key', operation[3:]) == operation[3:]):
        # Hermes shallow-merges modify.args: consume this alias at the server, never by omission.
        prepared['idempotency_key'] = operation[3:]
    return prepared


def prepare_call(name, args):
    prepared = normalize_call(name, args)
    if name == 'apply_text' and Platform.configured():
        return Platform().prepare(name, prepared)
    return {'args': prepared}


def register(host, port=None):
    platform = port if port is not None else Platform() if Platform.configured() else UnwiredPlatform()

    def invoke(name, **arguments):
        # The shared host consumes owner_requested. Scope and execution are never tool arguments.
        arguments.pop('owner_requested', None)
        arguments = normalize_call(name, arguments)
        if name == 'edit_status' and 'operation_id' in arguments and 'idempotency_key' in arguments:
            key = arguments['idempotency_key']
            if not isinstance(key, str) or arguments['operation_id'] != 'op:' + key:
                return failed(status={'reason_code': 'MEETING_INPUT_INVALID'})
            arguments.pop('operation_id')
        try:
            validate_call(name, arguments)
        except ValidationError:
            return failed(status={'reason_code': 'MEETING_INPUT_INVALID'})
        try:
            return platform.invoke(name, arguments)
        except Exception:
            return unknown(status={'reason_code': 'MEETING_TRANSPORT_UNKNOWN'},
                           unknowns=[unknown_fact(arguments['target_id'], 'Platform result unavailable.')],
                           next={'retry': 'after_check', 'check_with': 'edit_status'})

    for name, schema in SCHEMAS.items():
        host.add(name, partial(invoke, name), schema, DESCRIPTIONS[name])
