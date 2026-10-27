"""Real ColdStorage.upload boundaries against the existing loopback WebDAV fixture."""
import json
from pathlib import Path
import subprocess

import pytest

from data_reset_cold import Cold
from data_reset_dav_fixture import drive

ROOT = Path(__file__).resolve().parents[2]
PRODUCER = Path(__file__).with_name('data_reset_cold_review_producer.ts')


@pytest.mark.parametrize('stage', ['after_mkcol', 'before_put', 'before_verify'])
@pytest.mark.parametrize('interrupted', ['none', 'displace', 'restore'])
def test_producer_upload_collision_restores_and_resumes(tmp_path, stage, interrupted):
    directory = tmp_path/'drive'
    (directory/'backups').mkdir(parents=True)
    (directory/'backups/old').write_bytes(b'cut cold history')
    password = tmp_path/'synthetic-password'
    password.write_text('synthetic')
    events = []
    with drive(directory, events=events) as url:
        cold = Cold({'url':url, 'username':'pci', 'password_file':str(password)})
        before = cold.inventory()
        entries = cold.entries(before)
        cold.move(entries[0]['original'], entries[0]['quarantine'])
        child = subprocess.run(['node', str(PRODUCER), url, str(password), stage],
                               check=True, text=True, capture_output=True, cwd=ROOT)
        calls = json.loads(child.stdout)['calls']
        assert calls == {'after_mkcol':['MKCOL'], 'before_put':['MKCOL','PUT'],
                         'before_verify':['MKCOL','PUT','GET']}[stage]
        assert (directory/'backups').is_dir()
        assert (directory/'backups/live').exists() == (stage == 'before_verify')
        expected_live = cold.inventory()
        move = cold.move
        stopped = False

        def move_and_interrupt(source, target):
            nonlocal stopped
            move(source, target)
            boundary = ('/displaced/' in target if interrupted == 'displace'
                        else source == entries[0]['quarantine'])
            if interrupted != 'none' and boundary and not stopped:
                stopped = True
                raise KeyboardInterrupt('MOVE committed before receipt save')

        cold.move = move_and_interrupt

        def restore():
            cold.displace_live(entries)
            for entry in entries:
                if cold.listing(entry['quarantine']) is not None:
                    cold.check(entry)
                    cold.move(entry['quarantine'], entry['original'])
                cold.check(entry, False)

        if interrupted != 'none':
            with pytest.raises(KeyboardInterrupt):
                restore()
        restore()
        restore()
        assert cold.inventory() == before
        displaced = directory/cold.prefix/'displaced/backups'
        assert displaced.is_dir()
        assert list(displaced.iterdir()) == ([] if not expected_live else [displaced/'live'])
        if expected_live:
            assert (displaced/'live').read_bytes() == b'new live cold recording'
    assert events.count('MOVE') == 3
    assert 'GET' not in events
    assert events.count('PUT') == (1 if stage == 'before_verify' else 0)


@pytest.mark.parametrize('transport', ['local', 'dav'])
def test_empty_nested_restore_target_collection_is_displaced(tmp_path, transport):
    from contextlib import nullcontext
    directory = tmp_path/'drive'
    old = directory/'originals/2026-10-26/old.jpg'
    old.parent.mkdir(parents=True)
    old.write_bytes(b'cut photo')
    password = tmp_path/'synthetic-password'
    password.write_text('synthetic')
    with drive(directory) if transport == 'dav' else nullcontext() as url:
        cold = Cold({'url':url, 'username':'pci', 'password_file':str(password)} if url
                    else {'directory':str(directory)})
        entries = cold.entries(cold.inventory())
        cold.move('originals', entries[0]['quarantine'])
        (directory/'originals/2026-10-26').mkdir(parents=True)
        assert cold.inventory() == []
        cold.displace_live(entries)
        cold.displace_live(entries)
        cold.move(entries[0]['quarantine'], 'originals')
        cold.displace_live(entries)
        cold.check(entries[0], False)
        assert (directory/cold.prefix/'displaced/originals/2026-10-26').is_dir()


def test_empty_producer_collection_full_rollback(tmp_path):
    import data_reset
    from data_reset_policy import RESET_ID
    roots = {name:str(tmp_path/name) for name in ('owner', 'hermes', 'errands', 'secrets')}
    for root in roots.values():
        Path(root).mkdir()
    (tmp_path/'hermes/MEMORY.md').write_text('cut local history')
    directory = tmp_path/'drive'
    (directory/'backups').mkdir(parents=True)
    (directory/'backups/old').write_bytes(b'cut cold history')
    password = tmp_path/'synthetic-password'
    password.write_text('synthetic')
    settings = {'id':RESET_ID, 'roots':roots, 'state_dir':str(tmp_path/'state'),
                'capacity':{'reserve_bytes':1024**3,'reserve_inodes':100000,'margin_bytes':2*1024**3}}
    with drive(directory) as url:
        cold = Cold({'url':url, 'username':'pci', 'password_file':str(password)})
        cut = data_reset.run(settings, 'quarantine', cold=cold)
        subprocess.run(['node', str(PRODUCER), url, str(password), 'before_put'],
                       check=True, text=True, capture_output=True, cwd=ROOT)
        result = data_reset.run(settings, 'rollback', cold=cold, receipt_path=cut['receipt'])
        assert result['state'] == 'restored' and result['rollback_verified']
        assert (directory/'backups/old').read_bytes() == b'cut cold history'
        assert (directory/cold.prefix/'displaced/backups').is_dir()
        assert (tmp_path/'hermes/MEMORY.md').read_text() == 'cut local history'
