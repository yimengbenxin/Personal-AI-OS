"""Offline catalog sends resolve recipients from channel evidence; model metadata has no authority."""
import importlib
import json
from pathlib import Path

import pytest

from integrations.hermes.personal_aios.send_recipients import (
    message_kind, prepare_phone, prepare_wechat, wechat_name, wechat_recipient,
)
from capability.packages.messaging.server.server import prepare_call

ROOT = Path(__file__).parents[2]
DIRECTORY = {'platforms': {'wechat': [{'name': '测试·联系人'}, {'name': '另一个人'}]}}


@pytest.fixture
def directory(monkeypatch):
    from gateway import channel_directory
    monkeypatch.setattr(channel_directory, 'load_directory', lambda: DIRECTORY)


@pytest.mark.parametrize('reference', ['wechat:测试联系人', '测试·联系人', 'wechat: 测试 • 联系人 🌟'])
def test_display_only_identity_matches_app_card_and_pins_the_executed_recipient(directory, reference):
    args = {'recipient': reference, 'task_type': 'invented', 'effect': {'recipient': 'somebody-else'}, 'command': 'fixture'}
    prepared = prepare_wechat(args)
    assert prepared['consent']['target'] == prepared['args']['recipient'] == 'wechat:name:测试联系人'
    assert prepared['consent']['legacy_recipients'] == ['wechat:测试·联系人', 'wechat:测试联系人']
    assert 'task_type' not in prepared['consent']
    assert prepared['args']['command'] == 'fixture'


def test_channel_id_survives_renames_and_ambiguous_display_names_require_the_id():
    directory = {'platforms': {'wechat': [{'id': 'wxid_one', 'name': '测试联系人'}, {'id': 'wxid_two', 'name': '测试·联系人'}]}}
    with pytest.raises(ValueError, match='AMBIGUOUS'):
        wechat_recipient('wechat:测试联系人', directory)
    assert wechat_recipient('wechat:id:wxid_two', directory) == {'target': 'wechat:id:wxid_two', 'legacy_recipients': ['wechat:wxid_two']}
    directory['platforms']['wechat'][1]['name'] = '另一个名字'
    assert wechat_recipient('wechat:wxid_two', directory)['target'] == 'wechat:id:wxid_two'
    with pytest.raises(ValueError, match='UNRESOLVED'):
        wechat_recipient('wechat:没有证据的名字', directory)


@pytest.mark.parametrize('tool,kind', [('wechat_send_text', 'message.text'), ('wechat_reply', 'message.text'), ('wechat_send_file', 'message.file')])
def test_wechat_preparation_is_the_real_package_hook_and_kind_is_only_in_manifest(directory, tool, kind):
    server = importlib.import_module('capability.packages.wechat-mac.server.server')
    args = {'recipient': '测试联系人', 'command': 'fixture', 'task_type': 'opposite-kind'}
    assert server.prepare_call(tool, args) == prepare_wechat(args)
    manifest = json.loads((ROOT / 'capability/packages/wechat-mac/plugin.json').read_text())
    assert manifest['extensions']['ai.yimi.capability']['tools'][tool]['send_consent']['kind'] == kind


@pytest.mark.parametrize('args,kind', [
    ({'message': '正文'}, 'text'),
    ({'message': '正文 MEDIA:/tmp/report.pdf'}, 'file'),
    ({'message': 'MEDIA:/tmp/image.png'}, 'file'),
    ({'action': 'react', 'emoji': '👍'}, 'react'),
    ({'action': 'unreact'}, 'unreact'),
])
def test_messaging_and_email_use_actual_native_payload_classification(args, kind):
    prepared = prepare_call('send_message', {'target': 'email:Owner+tag@example.com', 'recipient': 'email:forged@example.com',
        'task_type': 'wechat_send_file', 'owner_requested': True, **args})
    assert prepared['consent']['target'] == 'email:Owner+tag@example.com'
    assert prepared['consent']['message_kind'] == kind
    assert 'task_type' not in prepared['consent']


def test_recipient_resolution_preserves_thread_boundaries():
    prepared = prepare_call('send_message', {'target': 'telegram:-1001234567890:17585', 'message': 'hi'})
    assert prepared['consent']['target'] == prepared['args']['target'] == 'telegram:-1001234567890:17585'


@pytest.mark.parametrize('task,kind', [('wechat_message', 'text'), ('send_message', 'text'), ('send_file', 'file')])
def test_phone_finite_send_variants_use_the_same_identity_and_manifest_kinds(directory, task, kind):
    prepared = prepare_phone({'recipient': 'wechat:测试联系人', 'task_type': task})
    assert prepared['consent']['target'] == 'wechat:name:测试联系人'
    assert prepared['consent']['message_kind'] == kind


def test_empty_names_and_collisions_never_become_guessed_identities():
    assert wechat_name(' 测试 • 联系人 🌟') == '测试联系人'
    # This newer emoji is unassigned in Python 3.12's Unicode database, but must match Node and future releases.
    assert wechat_name('测试\U0001fae9联系人') == '测试联系人'
    for directory in ({}, {'platforms': {'wechat': [{'name': '测试联系人'}, {'name': '测试·联系人'}]}}):
        with pytest.raises(ValueError):
            wechat_recipient('wechat:测试联系人', directory)
    with pytest.raises(ValueError, match='UNRESOLVED'):
        wechat_recipient('🌟', {'platforms': {'wechat': [{'name': '🌟'}]}})


def test_native_list_has_no_send_identity_or_kind():
    assert prepare_call('send_message', {'action': 'list'})['consent'] == {}
    with pytest.raises(ValueError, match='SEND_KIND_UNRESOLVED'):
        message_kind({'action': 'unknown'})
