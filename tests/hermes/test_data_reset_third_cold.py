"""Unmoved cold subtrees remain bound to the cut across hot/cold interruption."""
from contextlib import nullcontext
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deploy/cloud'))
import data_reset
from data_reset_cold import Cold
from data_reset_dav_fixture import drive
import data_reset_manifest as journal
from data_reset_policy import RESET_ID
import data_reset_quarantine as moving


@pytest.mark.parametrize('transport', ['local', 'dav'])
@pytest.mark.parametrize(('interruption', 'mutation'), [
    (stage, mutation) for stage in ('hot', 'cold') for mutation in ('none', 'equal_size', 'empty_collection')
] + [('cold', 'during_move')])
def test_resume_preserves_unmoved_cold_seal(tmp_path, monkeypatch, transport, interruption, mutation):
    roots = {name:str(tmp_path/name) for name in ('owner', 'hermes', 'errands', 'secrets')}
    for root in roots.values():
        Path(root).mkdir()
    (tmp_path/'hermes/MEMORY.md').write_text('cut hot history')
    directory = tmp_path/'drive'
    (directory/'backups').mkdir(parents=True)
    (directory/'backups/old').write_bytes(b'backup')
    photo = directory/'originals/2026-10-26/old.jpg'
    photo.parent.mkdir(parents=True)
    photo.write_bytes(b'cut cold history')
    empty = directory/'originals/2026-10-25'
    empty.mkdir()
    password = tmp_path/'synthetic-password'
    password.write_text('synthetic')
    settings = {'id':RESET_ID, 'roots':roots, 'state_dir':str(tmp_path/'state'),
                'capacity':{'reserve_bytes':1024**3, 'reserve_inodes':100000, 'margin_bytes':2*1024**3}}
    events = []
    with drive(directory, events=events) if transport == 'dav' else nullcontext() as url:
        cold = Cold({'url':url, 'username':'pci', 'password_file':str(password)} if url
                    else {'directory':str(directory)})
        rename, move = moving.rename, cold.move

        def interrupt_hot(source, target):
            rename(source, target)
            raise KeyboardInterrupt('after first hot rename')

        def interrupt_cold(source, target):
            move(source, target)
            if mutation == 'during_move':
                photo.write_bytes(b'x'*photo.stat().st_size)
                return
            raise KeyboardInterrupt('after first cold MOVE before journal save')

        with monkeypatch.context() as injection:
            if interruption == 'hot':
                injection.setattr(moving, 'rename', interrupt_hot)
            else:
                injection.setattr(cold, 'move', interrupt_cold)
            failure = ValueError if mutation == 'during_move' else KeyboardInterrupt
            with pytest.raises(failure, match='^RESET_CUT_COLD_WRITTEN$' if mutation == 'during_move' else None):
                data_reset.run(settings, 'quarantine', cold=cold)
        path, = (tmp_path/'state').glob('data-reset-*.json')
        receipt = journal.load(settings, path)
        assert receipt['state'] == 'quarantining'
        if interruption == 'cold':
            assert (directory/cold.prefix/'backups/old').read_bytes() == b'backup'
        if mutation == 'equal_size':
            photo.write_bytes(b'x'*photo.stat().st_size)
        elif mutation == 'empty_collection':
            # Replacement preserves the pathname, size and empty member inventory.
            empty.rmdir()
            empty.mkdir()
        moves = []

        def tracked_move(source, target):
            moves.append(source)
            return move(source, target)

        monkeypatch.setattr(cold, 'move', tracked_move)
        if mutation != 'none':
            with pytest.raises(ValueError, match='^RESET_CUT_COLD_WRITTEN$'):
                data_reset.run(settings, 'quarantine', cold=cold)
            assert not moves
            assert photo.exists()
            assert journal.load(settings, path)['state'] == 'quarantining'
        else:
            result = data_reset.run(settings, 'quarantine', cold=cold)
            assert result['state'] == 'quarantined'
            assert result['verification']['manifest_complete']
            assert (directory/cold.prefix/'originals/2026-10-26/old.jpg').read_bytes() == b'cut cold history'
    assert not {'GET', 'PUT'} & set(events)


def test_legacy_unsealed_cold_check_still_accepts_manifest(tmp_path):
    (tmp_path/'backups').mkdir()
    target = tmp_path/'backups/old'
    target.write_bytes(b'old')
    cold = Cold({'directory':str(tmp_path)})
    entry, = cold.entries(cold.inventory())
    target.write_bytes(b'new')
    cold.check(entry, False)
