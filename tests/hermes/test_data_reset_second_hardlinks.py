"""Public verify and rollback regressions for epoch and nested cut hardlinks."""
import json
import os
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deploy/cloud'))
import data_reset
import data_reset_manifest as journal
from data_reset_inventory import inventory
from data_reset_policy import EPOCH_PATH, RESET_ID


def settings_at(base):
    roots = {name:str(base/name) for name in ('owner','hermes','errands','secrets')}
    for root in roots.values():
        Path(root).mkdir()
    return dict(id=RESET_ID, roots=roots, state_dir=str(base/'state'), voice_command=[],
                capacity={'reserve_bytes':1024**3,'reserve_inodes':100000,'margin_bytes':2*1024**3})


@pytest.mark.parametrize('legacy_pair', [False, True])
def test_control_epoch_hardlink_keeps_authority_and_allows_history_rollback(tmp_path, legacy_pair):
    settings = settings_at(tmp_path)
    kept = tmp_path/'hermes/skills/epoch-copy'
    kept.parent.mkdir(); kept.write_text(json.dumps('a'*32))
    original = kept.read_bytes(); keep_inode = kept.stat().st_ino
    epoch = tmp_path/'owner'/EPOCH_PATH
    epoch.parent.mkdir(parents=True); os.link(kept,epoch)
    history = tmp_path/'hermes/MEMORY.md'
    history.write_text('cut history')
    assert not inventory(settings)['hardlink_pairs']
    cut = data_reset.run(settings, 'quarantine')
    receipt = journal.load(settings, cut['receipt'])
    assert not receipt['before']['hardlink_pairs']
    assert epoch.stat().st_ino != keep_inode
    assert kept.stat().st_ino == keep_inode and kept.read_bytes() == original
    if legacy_pair:
        receipt['before']['hardlink_pairs'].append({'clear':str(epoch), 'keep':str(kept)})
        journal.save(cut['receipt'], receipt)
    assert data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])['rollback_verified']
    assert history.read_text() == 'cut history'
    assert kept.stat().st_ino == keep_inode and kept.read_bytes() == original


@pytest.mark.parametrize('corrupt', [False, True])
def test_public_verify_checks_nested_isolated_hardlink_content(tmp_path, corrupt):
    settings = settings_at(tmp_path)
    kept = tmp_path/'hermes/skills/tool'
    kept.parent.mkdir(); kept.write_bytes(b'old history')
    clear = tmp_path/'owner/history/tree.bin'
    clear.parent.mkdir(); os.link(kept, clear)
    cut = data_reset.run(settings, 'quarantine')
    receipt = journal.load(settings, cut['receipt'])
    saved = Path(receipt['hardlink_copies'][str(clear)]['quarantine'])
    assert saved.read_bytes() == b'old history'
    if corrupt:
        saved.write_bytes(b'bad history')
        with pytest.raises(ValueError, match='^RESET_QUARANTINE_CONTENT_CHANGED$'):
            data_reset.run(settings, 'verify', receipt_path=cut['receipt'])
        assert journal.load(settings, cut['receipt'])['state'] == 'quarantined'
    else:
        assert data_reset.run(settings, 'verify', receipt_path=cut['receipt'])['manifest_complete']
        kept.write_bytes(b'new setting')
        assert data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])['rollback_verified']
        assert clear.read_bytes() == b'old history' and kept.read_bytes() == b'new setting'
