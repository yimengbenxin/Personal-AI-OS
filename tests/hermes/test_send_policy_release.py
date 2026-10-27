"""The existing owner-baseline gate follows moved consent semantics without gating version bumps."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from test_release import repo, git, release_source


def test_stable_send_policy_is_protected_but_version_and_ordinary_tool_metadata_are_not(repo):
    path = 'capability/packages/wechat-mac/plugin.json'
    target = repo.work / path
    target.parent.mkdir(parents=True)
    manifest = {'version': '1.0.0', 'extensions': {'ai.yimi.capability': {'tools': {'wechat_send_text': {
        'task_type': 'release_name', 'send_consent': {'recipient': 'wechat', 'kind': 'message.text'}}}}}}
    target.write_text(json.dumps(manifest))
    git(repo.work, 'add', path);git(repo.work, 'commit', '-qm', 'stable kind')
    base = git(repo.work, 'rev-parse', 'HEAD')
    manifest['version'] = '2.0.0'
    manifest['extensions']['ai.yimi.capability']['tools']['wechat_send_text']['task_type'] = 'new_release_name'
    target.write_text(json.dumps(manifest));git(repo.work, 'commit', '-qam', 'version bump')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == []
    manifest['extensions']['ai.yimi.capability']['tools']['wechat_send_text']['send_consent']['kind'] = 'message.file'
    target.write_text(json.dumps(manifest));git(repo.work, 'commit', '-qam', 'change consent boundary')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == [path]


def test_new_scope_and_identity_implementations_remain_owner_baselines():
    for path in [release_source.I + 'capability/send-identity.ts', release_source.I + 'capability/send-consent-storage.ts',
                 release_source.I + 'capability/send-consent-migration.ts', release_source.H + 'send_recipients.py',
                 'capability/contracts/send-recipient.ts']:
        assert path.startswith(release_source.PROTECTED)
