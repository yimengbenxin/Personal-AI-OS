"""Real migration -> quarantine -> verification -> source authorization/native ACK -> rollback."""
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest
from data_reset_fixtures import ROOT, Stores, write
import data_reset
import data_reset_quarantine as moving
from data_reset_inventory import inventory, keep_hashes


@pytest.fixture
def contract(tmp_path):
    roots = {name: str(tmp_path/name) for name in ('owner', 'hermes', 'errands', 'secrets', 'models', 'projections')}
    for path in roots.values():
        Path(path).mkdir(mode=0o700)
    settings = {'id': 'RQ-102-N15', 'roots': roots, 'state_dir': str(tmp_path/'state'),
                'capacity': {'reserve_bytes': 1024**3, 'reserve_inodes': 100000, 'margin_bytes': 2*1024**3}}
    write(Path(roots['hermes']), 'sessions/old.jsonl', 'synthetic history')
    write(Path(roots['hermes']), 'skills/own/tool.py', 'synthetic own tool')
    path = tmp_path/'settings.json'

    def node(mode):
        path.write_text(json.dumps(settings))
        result = subprocess.run(['node', str(ROOT/'tests/hermes/data_reset_contract.ts'), mode, str(path)],
                                capture_output=True, text=True, env={**os.environ, 'PAIOS_HERMES_PYTHON': sys.executable})
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    return settings, node


def test_migrated_send_grants_and_unmigrated_reasons_survive_reset_and_rollback(contract):
    settings, node = contract
    migrated = node('seed-consents')
    original = {str(p): p.read_bytes() for root in settings['roots'].values() for p in Path(root).rglob('*') if p.is_file()}
    before = inventory(settings)
    kept = {r['root']+'/'+r['path'] for r in before['files'] if r['action'] == 'keep'}
    assert {'hermes/channel_directory.json', 'hermes/channel_aliases.json'} <= kept
    assert sum('/send-consents-v1/' in p for p in kept) == 2
    assert sum('/send-consent-migrations-v1/' in p for p in kept) == 2
    cut = data_reset.run(settings, 'quarantine')
    assert data_reset.run(settings, 'verify', receipt_path=cut['receipt'])['clear_verified']
    replay = node('check-consents')
    assert replay['status'] == migrated['status'] == 'completed_with_unmigrated'
    assert replay['unmigrated'] == migrated['unmigrated']
    assert sorted(r['reason'] for r in replay['unmigrated']) == [
        'SEND_KIND_AMBIGUOUS', 'SEND_RECIPIENT_AMBIGUOUS', 'SEND_RECIPIENT_UNRESOLVED']
    assert data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])['rollback_verified']
    assert all(Path(p).read_bytes() == body for p, body in original.items())
    assert node('check-consents')['unmigrated'] == migrated['unmigrated']


def test_rollback_directly_after_mixed_original_rename_restores_its_keep_rows(tmp_path):
    from data_reset_policy import VOICE_KEY
    stores = Stores(tmp_path)
    before = inventory(stores.settings)
    rename = moving.rename
    def interrupted(source, target):
        rename(source, target)
        if Path(source).name == VOICE_KEY:
            raise KeyboardInterrupt('interrupted before publishing mixed keep projection')
    with patch.object(moving, 'rename', interrupted), pytest.raises(KeyboardInterrupt):
        data_reset.run(stores.settings, 'quarantine')
    receipt = next(Path(stores.settings['state_dir']).glob('data-reset-*.json'))
    assert data_reset.run(stores.settings, 'rollback', receipt_path=str(receipt))['rollback_verified']
    assert keep_hashes(inventory(stores.settings)) == keep_hashes(before)


@pytest.mark.parametrize('layout', ['mounts', 'owner'])
def test_rollback_after_rq115_cli_and_native_ack_keeps_live_revision_and_history(contract, layout):
    settings, node = contract
    if layout == 'owner':
        settings['roots'].pop('models'); settings['roots'].pop('projections')
    node('seed-models')
    cut = data_reset.run(settings, 'quarantine')
    node('migrate-models'); state = node('ack-models')
    assert state['groups']['brain']['desired'] == state['groups']['brain']['effective'] == 2
    live = keep_hashes(inventory(settings))
    assert data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])['rollback_verified']
    assert keep_hashes(inventory(settings)) == live
    assert node('read-models') == state
    assert (Path(settings['roots']['hermes'])/'sessions/old.jsonl').read_text() == 'synthetic history'


@pytest.mark.parametrize('role,path', [('hermes', 'skills/own/tool.py'), ('models', 'unrelated.json'),
                                       ('projections', 'unrelated.json')])
def test_every_pure_keep_change_survives_rollback(contract, role, path):
    settings, node = contract
    write(Path(settings['roots'][role]), path, 'original unrelated keep')
    node('seed-models'); cut = data_reset.run(settings, 'quarantine')
    node('migrate-models'); node('ack-models')
    write(Path(settings['roots'][role]), path, 'changed unrelated keep')
    live = keep_hashes(inventory(settings))
    assert data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])['rollback_verified']
    assert keep_hashes(inventory(settings)) == live
