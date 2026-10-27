from pathlib import Path

import pytest
from data_reset_fixtures import Stores, write
from data_reset_dav_fixture import drive
from data_reset_cold import Cold
import data_reset
import data_reset_cut as cut
import data_reset_quarantine as moving
import data_reset_retention as retention


def test_scoped_webdav_server_moves_and_restores_cold_without_any_download(tmp_path):
    stores=Stores(tmp_path); directory=tmp_path/'drive'; events=[]
    original={str(p.relative_to(directory)):p.read_bytes() for p in directory.rglob('*') if p.is_file()}
    password=write(Path(stores.roots['secrets']),'cold-webdav.password',b'synthetic')
    with drive(directory,events=events) as url:
        cold=Cold({'url':url,'username':'pci','password_file':str(password)})
        assert len(cold.inventory())==3
        result=data_reset.run(stores.settings,'quarantine',cold=cold)
        assert cold.inventory()==[] and events.count('MOVE')==3
        assert data_reset.run(stores.settings,'rollback',cold=cold,receipt_path=result['receipt'])['rollback_verified']
        assert {str(p.relative_to(directory)):p.read_bytes() for p in directory.rglob('*') if p.is_file()}==original
        assert retention.expire(stores.settings,at=result['expires_at']+1)['expired_quarantines']==1
    assert 'GET' not in events and 'PUT' not in events and events.count('MOVE')==6


def test_unsupported_server_move_reports_and_rolls_back_without_downloading(tmp_path):
    stores=Stores(tmp_path); events=[]
    password=write(Path(stores.roots['secrets']),'cold-webdav.password',b'synthetic')
    with drive(tmp_path/'drive',moves=False,events=events) as url:
        cold=Cold({'url':url,'username':'pci','password_file':str(password)})
        with pytest.raises(ValueError,match='SERVER_MOVE_UNSUPPORTED'):
            data_reset.run(stores.settings,'quarantine',cold=cold)
        path=next(Path(stores.settings['state_dir']).glob('data-reset-*.json'))
        assert data_reset.run(stores.settings,'rollback',cold=cold,receipt_path=str(path))['rollback_verified']
        assert len(cold.inventory())==3
    assert 'GET' not in events and 'PUT' not in events


def test_webdav_equal_length_overwrite_after_cut_refuses_before_any_move(tmp_path, monkeypatch):
    stores = Stores(tmp_path); events = []; moved = []; capacity = cut.capacity
    password = write(Path(stores.roots['secrets']), 'cold-webdav.password', b'synthetic')
    def after_plan(*args, **kwargs):
        result = capacity(*args, **kwargs)
        target = next((tmp_path/'drive').rglob('*.jpg'))
        target.write_bytes(b'x'*target.stat().st_size)
        return result
    monkeypatch.setattr(cut, 'capacity', after_plan)
    monkeypatch.setattr(moving, 'rename', lambda *a: moved.append(a))
    with drive(tmp_path/'drive', events=events) as url:
        cold = Cold({'url': url, 'username': 'pci', 'password_file': str(password)})
        with pytest.raises(ValueError, match='^RESET_CUT_COLD_WRITTEN$'):
            data_reset.run(stores.settings, 'quarantine', cold=cold)
    assert not moved and 'MOVE' not in events and 'GET' not in events and 'PUT' not in events
    assert not list(Path(stores.settings['state_dir']).glob('data-reset-*.json'))


def test_webdav_without_etag_cannot_claim_a_sealed_cut(tmp_path):
    stores = Stores(tmp_path); events = []
    password = write(Path(stores.roots['secrets']), 'cold-webdav.password', b'synthetic')
    with drive(tmp_path/'drive', events=events, metadata=False) as url:
        cold = Cold({'url': url, 'username': 'pci', 'password_file': str(password)})
        assert len(cold.inventory()) == 3  # Online preview keeps the metadata-only public contract.
        with pytest.raises(ValueError, match='^RESET_COLD_ETAG_REQUIRED$'):
            data_reset.run(stores.settings, 'quarantine', cold=cold)
    assert 'MOVE' not in events and not list(Path(stores.settings['state_dir']).glob('data-reset-*.json'))
