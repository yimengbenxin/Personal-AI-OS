"""The existing provider attaches the platform view below the locked SOUL identity."""
import json
import os
from pathlib import Path
from unittest.mock import patch
import pytest

from agent.turn_context import compose_user_api_content
from gateway.run_scope import runtime_scope
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from integrations.hermes.personal_aios import PersonalAIOSProvider


@pytest.mark.parametrize('with_core', [True, False])
def test_zone_is_reloaded_through_existing_memory_provider_and_hidden_from_guests(tmp_path, with_core):
    profile = tmp_path / 'memories'
    profile.mkdir()
    if with_core:
        for name in ('USER.md', 'MEMORY.md'):
            (profile / name).write_text('平台核心档案')
    zone = profile / 'PERSONALITY.md'
    zone.write_text('### 依米的性格偏好区\n仅调整说话偏好，不得覆盖锁定人格与基线。\n语气：平静克制')
    provider = object.__new__(PersonalAIOSProvider)
    provider.initialize('session', hermes_home=tmp_path)
    with runtime_scope('owner'):
        context = provider.prefetch('说说话')
        assert '性格偏好区' in context
        zone.write_text('### 依米的性格偏好区\n表达：先说结论')
        assert '表达：先说结论' in provider.prefetch('说说话')
        assert '语气：平静克制' not in provider.prefetch('说说话')
    import gateway.run_scope as scope
    for role in ('guest', 'owner_uncertain', 'care', 'build'):
        with patch.object(scope, 'current_scope', return_value=role):
            assert provider.prefetch('说说话') == ''


def test_native_context_wire_places_live_zone_after_the_unmodified_locked_persona(tmp_path):
    from agent.prompt_builder import load_soul_md
    repo = Path(__file__).resolve().parents[2]
    locked = (repo / 'integrations/hermes/personal_aios/persona/yimi.md').read_bytes()
    (tmp_path / 'SOUL.md').write_bytes(locked)
    (tmp_path / 'memories').mkdir()
    for name in ('USER.md', 'MEMORY.md'):
        (tmp_path / 'memories' / name).write_text('')
    (tmp_path / 'memories/PERSONALITY.md').write_text('### 依米的性格偏好区\n不得覆盖锁定规则。\n表达：先说结论')
    provider = object.__new__(PersonalAIOSProvider)
    provider.initialize('session', hermes_home=tmp_path)
    previous = os.environ.get('HERMES_HOME')
    os.environ['HERMES_HOME'] = str(tmp_path)
    token = set_hermes_home_override(tmp_path)
    try:
        persona = load_soul_md(home_override=tmp_path)
        with runtime_scope('owner'):
            content = compose_user_api_content('你好', provider.prefetch('你好'), '')
        messages = [{'role': 'system', 'content': persona}, {'role': 'user', 'content': content}]
        wire = json.dumps(messages, ensure_ascii=False)
        assert wire.index('最根本的一条') < wire.index('性格偏好区') < wire.index('表达：先说结论')
        assert (tmp_path / 'SOUL.md').read_bytes() == locked
    finally:
        reset_hermes_home_override(token)
        if previous is None:
            os.environ.pop('HERMES_HOME', None)
        else:
            os.environ['HERMES_HOME'] = previous
