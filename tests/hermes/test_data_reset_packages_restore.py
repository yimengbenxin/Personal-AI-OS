"""Real registry publishes, cut pins and restored history agree with retained selections."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest

from test_data_reset_review import ROOT, settings_at
import data_reset
import data_reset_packages as packages
import data_reset_manifest as journal
from data_reset_inventory import inventory, keep_hashes
from data_reset_policy import digest


PRINCIPAL = 'synthetic-owner'
HISTORY_KEY = hashlib.sha256(PRINCIPAL.encode()).hexdigest()


def registry(settings, operation='status', name='yimi-capability-template', version='0.1.0'):
    result = subprocess.run(['node',str(ROOT/'tests/hermes/data_reset_packages_restore.mjs')],
        input=json.dumps(dict(owner=settings['roots']['owner'], operation=operation, name=name,
                              version=version, python=sys.executable)), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def history_file(settings):
    return Path(settings['roots']['owner'])/'central-storage/capability-registry'/(HISTORY_KEY+'.json')


def assert_matching(status):
    for enabled in status['enabled']:
        assert any(r['name']==enabled['name'] and r['after']['digest']==enabled['digest'] and
                   not r['reverted'] and r['state']=='applied' for r in status['releases'])


def test_cut_real_registry_pins_are_live_and_rollback_is_per_package(tmp_path):
    settings = settings_at(tmp_path)
    first = registry(settings,'publish')
    assert first['result']['checked']['evidence']['success']
    registry(settings,'publish','reset-second-package')
    cut = data_reset.run(settings,'quarantine')
    status = registry(settings)['status']
    assert len(status['enabled']) == 2
    assert_matching(status)
    assert all(row['reason']=='RQ-102-N15' for row in status['releases'])
    assert len(status['releases']) == 2
    assert not (history_file(settings).parent/(digest(PRINCIPAL)+'.json')).exists()
    assert data_reset.run(settings,'verify',receipt_path=cut['receipt'])['clear_verified']
    outcome = registry(settings,'rollback')['status']
    assert [row['name'] for row in outcome['enabled']] == ['reset-second-package']
    assert_matching(outcome)


@pytest.mark.parametrize('new_version',[False,True])
def test_restore_preserves_cut_history_and_pins_live_selection(tmp_path,new_version):
    settings = settings_at(tmp_path)
    registry(settings,'publish')
    cut_history = json.loads(history_file(settings).read_text())
    cut = data_reset.run(settings,'quarantine')
    if new_version:
        registry(settings,'publish',version='0.2.0')
    live = registry(settings)['status']['enabled']
    baseline = keep_hashes(inventory(settings))
    restored = data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert restored['rollback_verified']
    status = registry(settings)['status']
    assert status['enabled'] == live
    assert status['releases'][:len(cut_history)] == cut_history
    assert_matching(status)
    restored_inventory = inventory(settings)
    history_row = next(row for row in restored_inventory['files']
                       if row['root']=='owner' and row['path']=='central-storage/capability-registry/'+HISTORY_KEY+'.json')
    assert history_row['clear_rows'] == len(cut_history)
    assert keep_hashes(restored_inventory) == baseline
    if new_version:
        assert status['releases'][-1]['reason']=='RQ-102-N15'
    result = registry(settings,'rollback')
    assert result['result']['success']
    assert result['status']['enabled'] == []


def test_historical_reset_pin_is_history_when_selection_changes(tmp_path):
    settings = settings_at(tmp_path)
    registry(settings,'publish')
    data_reset.run(settings,'quarantine')
    registry(settings,'publish',version='0.2.0')
    state = json.loads(history_file(settings).read_text())
    assert state[0]['reason']=='RQ-102-N15'
    assert packages.history_rows(settings['roots']['owner'],history_file(settings)) == len(state)


def test_restore_pin_publication_retry_keeps_history_and_keep_baseline(tmp_path):
    settings = settings_at(tmp_path)
    registry(settings,'publish')
    cut_history = json.loads(history_file(settings).read_text())
    cut = data_reset.run(settings,'quarantine')
    registry(settings,'publish',version='0.2.0')
    baseline = keep_hashes(inventory(settings))
    original_save = journal.save
    failed = False
    def crash_after_pin(path,value):
        nonlocal failed
        original_save(path,value)
        if Path(path)==history_file(settings) and isinstance(value,list) and not failed:
            failed = True
            raise OSError('package pin publication interrupted')
    with patch.object(journal,'save',crash_after_pin):
        with pytest.raises(OSError,match='package pin publication interrupted'):
            data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert failed
    assert data_reset.run(settings,'rollback',receipt_path=cut['receipt'])['rollback_verified']
    history = registry(settings)['status']
    assert history['releases'][:len(cut_history)] == cut_history
    assert_matching(history)
    assert len(history['releases']) == len(cut_history)+1
    assert keep_hashes(inventory(settings)) == baseline


def test_restore_preserves_two_real_releases_and_previous_version_rollback(tmp_path):
    settings = settings_at(tmp_path)
    registry(settings,'publish')
    registry(settings,'publish',version='0.2.0')
    original = registry(settings)['status']
    assert len(original['releases']) == 2
    assert original['releases'][-1]['before']['version'] == '0.1.0'
    cut = data_reset.run(settings,'quarantine')
    assert data_reset.run(settings,'rollback',receipt_path=cut['receipt'])['rollback_verified']
    restored = registry(settings)['status']
    assert restored == original
    rolled = registry(settings,'rollback')
    assert rolled['result']['outcome'] == 'restored_previous_version'
    assert rolled['result']['restored'] == original['releases'][-1]['before']
    assert [v['version'] for v in rolled['status']['enabled']] == ['0.1.0']


def test_restore_pins_selection_when_real_registry_pruned_its_cut_predecessor(tmp_path):
    settings = settings_at(tmp_path)
    first = registry(settings,'publish')['status']['enabled'][0]
    registry(settings,'publish',version='0.2.0')
    original = registry(settings)['status']['releases']
    cut = data_reset.run(settings,'quarantine')
    registry(settings,'publish',version='0.3.0')
    assert not Path(first['root']).exists()  # Real prune, without deleting a fixture by hand.
    registry(settings,'rollback')
    live = registry(settings)['status']['enabled']
    assert [v['version'] for v in live] == ['0.2.0']
    baseline = keep_hashes(inventory(settings))
    assert data_reset.run(settings,'rollback',receipt_path=cut['receipt'])['rollback_verified']
    restored = registry(settings)['status']
    assert restored['enabled'] == live and restored['releases'][:len(original)] == original
    assert_matching(restored)
    assert keep_hashes(inventory(settings)) == baseline
    rolled = registry(settings,'rollback')
    assert rolled['result']['success'] and rolled['status']['enabled'] == []
