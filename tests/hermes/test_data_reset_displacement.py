"""A role with no cut history still owns same-device rollback storage."""
import os
from pathlib import Path
import tempfile

import pytest

from test_data_reset_second_hardlinks import settings_at
import data_reset
import data_reset_manifest as journal
import data_reset_restore as restoring


def put(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    return path


@pytest.mark.parametrize('role', ['hermes', 'owner'], ids=['first-move', 'after-other-move'])
@pytest.mark.parametrize('interrupted', [False, True], ids=['plain', 'resume'])
def test_empty_cut_role_displaces_new_history_on_its_own_device(tmp_path, monkeypatch, role, interrupted):
    mount = os.environ.get('RQ102_CROSS_DEVICE_DIR')
    if not mount:
        pytest.skip('RQ102_CROSS_DEVICE_DIR must name a real second filesystem')
    settings = settings_at(tmp_path)
    with tempfile.TemporaryDirectory(prefix='rq102-displacement-', dir=mount) as other:
        remote = Path(other).resolve()/role
        remote.mkdir()
        settings['roots'][role] = str(remote)
        owner, hermes = (Path(settings['roots'][name]) for name in ('owner', 'hermes'))
        kept = put((hermes/'skills/tool.py') if role == 'hermes' else (owner/'resources/settings.json'), 'keep setting')
        kept_inode = kept.stat().st_ino
        old = put((owner/'central-storage/logs/cut.txt') if role == 'hermes' else (hermes/'MEMORY.md'), 'cut history')
        cut = data_reset.run(settings, 'quarantine')
        receipt = journal.load(settings, cut['receipt'])
        assert all(r['action'] in ('keep', 'control') for r in receipt['before']['files'] if r['root'] == role)
        assert receipt['before']['quarantine'][role] is None
        assert remote.stat().st_dev in {row['device'] for row in receipt['cut']['capacity']['per_filesystem']}
        live = put((hermes/'sessions/new.txt') if role == 'hermes' else (owner/'central-storage/logs/new.txt'), 'new live history')
        if role == 'owner':
            put(hermes/'new-sessions/live.txt', 'earlier displaced history')
        assert remote.stat().st_dev != tmp_path.stat().st_dev
        if interrupted:
            rename = restoring.rename
            def crash(source, target):
                rename(source, target)
                if Path(source) == live.parent:
                    raise KeyboardInterrupt('new history displaced before checkpoint')
            with monkeypatch.context() as injection:
                injection.setattr(restoring, 'rename', crash)
                with pytest.raises(KeyboardInterrupt, match='before checkpoint'):
                    data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])
        result = data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])
        assert result['rollback_verified']
        receipt = journal.load(settings, cut['receipt'])
        displaced = next(row for row in receipt['displaced'] if live.is_relative_to(row['original']))
        saved = Path(displaced['quarantine'])/live.relative_to(displaced['original'])
        assert saved.read_text() == 'new live history' and saved.stat().st_dev == remote.stat().st_dev
        if role == 'owner':
            earlier = next(row for row in receipt['displaced'] if row['original'] == str(hermes/'new-sessions'))
            assert receipt['displaced'].index(earlier) < receipt['displaced'].index(displaced)
            assert (Path(earlier['quarantine'])/'live.txt').read_text() == 'earlier displaced history'
        else:
            assert receipt['displaced'][0] == displaced
        assert not live.exists() and old.read_text() == 'cut history'
        assert kept.read_text() == 'keep setting' and kept.stat().st_ino == kept_inode
        assert remote.stat().st_dev in {row['device'] for row in receipt['storage']}
