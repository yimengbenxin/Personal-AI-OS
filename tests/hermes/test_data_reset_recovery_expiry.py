"""Expired recovery receipts remain actionable until the interrupted operation finishes."""
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from data_reset_fixtures import ROOT
from data_reset_pg_fixture import pg_server, postgres
import data_reset_manifest as journal
import data_reset_quarantine as quarantine
import data_reset_retention as retention
import release
import release_data_reset
from data_reset_policy import TTL
from test_data_reset_release import product_command


@pytest.fixture(autouse=True)
def recovery_context(product_command, postgres, monkeypatch):
    stores, host, calls, active = product_command
    def context(*args):
        # The child cut uses the fixture's already migrated database. Recovery
        # must run before another migration, with every writer stopped.
        assert not {'gateway', 'hermes', 'workshop', 'workshop-link'} & active
        assert 'release-watchdog' not in active
        calls.append(['reset'])
        return stores.settings, postgres, stores.cold
    monkeypatch.setattr(release_data_reset.data_reset_host, 'context', context)


def crash_engine(stores, pg, *, action, release_dir, expected_exit):
    """Use a separate engine process that exits after a durable recovery checkpoint."""
    settings = {**stores.settings, 'release_dir': str(release_dir)}
    script = r'''import json, os, sys
sys.path.insert(0, sys.argv[1])
import data_reset, data_reset_manifest as journal
from data_reset_cold import Cold
from data_reset_postgres import Postgres
settings = json.loads(sys.argv[2])
pg = Postgres(json.loads(sys.argv[3]))
cold = Cold(json.loads(sys.argv[4]))
action = sys.argv[5]
exit_code = int(sys.argv[6])
if action == 'quarantining':
    save = journal.save
    def save_then_crash(path, row):
        save(path, row)
        if row['state'] == 'quarantining' and any(entry['state'] == 'moved' for entry in row['entries']):
            os._exit(exit_code)
    journal.save = save_then_crash
    data_reset.run(settings, 'quarantine', pg, cold)
else:
    cut = data_reset.run(settings, 'quarantine', pg, cold)
    save = journal.save
    def save_then_crash(path, row):
        save(path, row)
        if row['state'] == 'restoring' and row.get('rollback_started'):
            os._exit(exit_code)
    journal.save = save_then_crash
    data_reset.run(settings, 'rollback', pg, cold, cut['receipt'])
'''
    result = subprocess.run([
        sys.executable, '-c', script, str(ROOT / 'deploy/cloud'), json.dumps(settings),
        json.dumps(pg.commands), json.dumps(stores.cold.config), action, str(expected_exit),
    ], capture_output=True)
    assert result.returncode == expected_exit, f'engine crash checkpoint exit was {result.returncode}'
    path = Path(settings['state_dir']) / 'data-reset-RQ-102-N15.json'
    assert path.is_file()
    return settings, path


def advance_reset_clock(monkeypatch, now):
    """Advance only reset modules, leaving pytest and subprocess timing alone."""
    clock = SimpleNamespace(time=lambda: now)
    for module in (journal, retention, release_data_reset, quarantine):
        monkeypatch.setattr(module, 'time', clock, raising=False)


def previous_release(host, tmp_path, monkeypatch, calls):
    previous = tmp_path / 'previous'
    previous.mkdir()
    host.root = tmp_path
    host.release = lambda name: tmp_path if name == 'current' else previous
    host.event = lambda *args, **kwargs: None
    monkeypatch.setattr(release.release_migrations, 'project_rollback', lambda *args: calls.append(['project']))
    monkeypatch.setattr(release, 'point', lambda *args: calls.append(['point']))
    monkeypatch.setattr(release, 'restore_front', lambda *args: {})
    monkeypatch.setattr(release, 'retire_newer_transport', lambda *args: {})
    monkeypatch.setattr(release.release_build, 'write', lambda *args: None)


def test_expired_quarantining_crash_is_preserved_and_same_journal_resume_restarts_ttl(
        product_command, postgres, monkeypatch, capsys):
    stores, host, calls, active = product_command
    settings, path = crash_engine(stores, postgres,
                                  action='quarantining', release_dir=Path(host.release('current')), expected_exit=91)
    pending = json.loads(path.read_text())
    assert pending['state'] == 'quarantining'
    moved = next(entry for entry in pending['entries'] if entry['state'] == 'moved')
    archived = Path(moved['quarantine'])
    archived_inode = archived.stat().st_ino

    now = pending['expires_at'] + 30
    advance_reset_clock(monkeypatch, now)
    assert retention.expire(settings) == {'expired_quarantines': 0, 'pending_quarantines': 1}
    expired_pending = json.loads(path.read_text())
    assert expired_pending['state'] == 'quarantining' and expired_pending['expiry_pending']
    for entry in expired_pending['entries']:
        surviving_path = entry['quarantine'] if entry['state'] == 'moved' else entry['original']
        assert Path(surviving_path).exists()
    assert archived.stat().st_ino == archived_inode

    release_data_reset.command(host, SimpleNamespace(
        action='quarantine', receipt=None, operator_apply_rq102=True))
    result = json.loads(capsys.readouterr().out)
    completed = json.loads(path.read_text())
    assert result['state'] == completed['state'] == 'quarantined'
    assert completed['quarantined_at'] == now
    assert completed['expires_at'] == now + TTL
    assert completed['expires_at'] > pending['expires_at']
    assert 'expiry_pending' not in completed
    assert archived.stat().st_ino == archived_inode
    assert retention.expire(settings) == {'expired_quarantines': 0, 'pending_quarantines': 0}
    release_data_reset.guard_start(host)


@pytest.mark.parametrize('route', ['engine', 'official_release'])
@pytest.mark.parametrize('state', ['quarantining', 'restoring'])
def test_expired_recovery_crash_receipt_finishes_and_releases_fence(
        product_command, postgres, monkeypatch, tmp_path, route, state):
    stores, host, calls, active = product_command
    settings, path = crash_engine(stores, postgres, action=state, release_dir=tmp_path, expected_exit=92)
    pending = json.loads(path.read_text())
    assert pending['state'] == state
    if state == 'restoring':
        assert pending['rollback_started']
    advance_reset_clock(monkeypatch, pending['expires_at'] + 30)
    assert retention.expire(settings) == {'expired_quarantines': 0, 'pending_quarantines': 1}

    if route == 'engine':
        result = release_data_reset.data_reset.run(
            settings, 'rollback', postgres, stores.cold, str(path))
        assert result['state'] == 'restored' and result['rollback_verified']
    else:
        previous_release(host, tmp_path, monkeypatch, calls)
        result = release.rollback(host, 'owner_request')
        assert result['data_reset']['state'] == 'restored'
        assert result['data_reset']['rollback_verified']
        assert calls.index(['project']) < calls.index(['point'])

    assert json.loads(path.read_text())['state'] == 'restored'
    release_data_reset.guard_start(host)


def test_official_release_rollback_refuses_unselected_unfinished_receipt_before_point_changes(
        product_command, postgres, monkeypatch, tmp_path):
    stores, host, calls, active = product_command
    _, path = crash_engine(stores, postgres, action='restoring',
                           release_dir=tmp_path / 'different-release', expected_exit=93)
    pending = json.loads(path.read_text())
    assert pending['state'] == 'restoring'
    advance_reset_clock(monkeypatch, pending['expires_at'] + 30)
    previous_release(host, tmp_path, monkeypatch, calls)

    with pytest.raises(ValueError, match='^RESET_RECOVERY_REQUIRED$'):
        release.rollback(host, 'owner_request')

    assert ['project'] not in calls and ['point'] not in calls
    with pytest.raises(ValueError, match='^RESET_RECOVERY_REQUIRED$'):
        release_data_reset.guard_start(host)


def test_completed_expired_quarantine_still_refuses_rollback_then_expires_cleanly(
        product_command, postgres, monkeypatch, capsys):
    stores, host, calls, active = product_command
    release_data_reset.command(host, SimpleNamespace(
        action='quarantine', receipt=None, operator_apply_rq102=True))
    result = json.loads(capsys.readouterr().out)
    path = Path(result['receipt'])
    completed = json.loads(path.read_text())
    assert completed['state'] == 'quarantined'
    advance_reset_clock(monkeypatch, completed['expires_at'] + 30)

    with pytest.raises(ValueError, match='^RESET_QUARANTINE_EXPIRED$'):
        release_data_reset.data_reset.run(
            stores.settings, 'rollback', postgres, stores.cold, str(path))
    assert json.loads(path.read_text())['state'] == 'quarantined'
    assert retention.expire(stores.settings) == {'expired_quarantines': 1, 'pending_quarantines': 0}
    expired = json.loads(path.read_text())
    assert expired['state'] == 'expired'
    assert all(not (Path(storage['path']) / 'RQ-102-N15').exists() for storage in expired['storage'])
    release_data_reset.guard_start(host)
