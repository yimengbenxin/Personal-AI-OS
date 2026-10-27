"""Stopped recovery uses the durable reset fence; live writers still use release drain."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from data_reset_pg_fixture import pg_server, postgres
from test_data_reset_release import product_command
import data_reset_manifest as journal
import release
import release_data_reset


WRITERS = {'gateway', 'hermes', 'workshop', 'workshop-link'}


def command(host, action, receipt=None):
    return release_data_reset.command(host, SimpleNamespace(
        action=action, receipt=receipt, operator_apply_rq102=True))


def live_drain(monkeypatch, calls, active, *, passed=True):
    def drain(*args):
        calls.append(['drain'])
        if not WRITERS <= active:
            raise RuntimeError('synthetic compose exec: writer is stopped')
        return {'passed': passed}
    monkeypatch.setattr(release.release_checks, 'drain', drain)


def interrupt_after_save(monkeypatch, predicate):
    save = journal.save
    def interrupted(path, row):
        save(path, row)
        if row.get('format') == journal.FORMAT and predicate(row):
            raise KeyboardInterrupt('synthetic durable checkpoint interruption')
    monkeypatch.setattr(journal, 'save', interrupted)


@pytest.mark.parametrize('checkpoint', ['dumped', 'moved'])
def test_stopped_quarantine_recovery_never_execs_live_drain(product_command, monkeypatch, capsys, checkpoint):
    stores, host, calls, active = product_command
    live_drain(monkeypatch, calls, active)
    with monkeypatch.context() as interrupted:
        interrupt_after_save(interrupted, lambda row: row['state'] == 'quarantining' and (
            row['pg_state'] == 'dumped' if checkpoint == 'dumped'
            else any(entry['state'] == 'moved' for entry in row['entries'])))
        with pytest.raises(KeyboardInterrupt):
            command(host, 'quarantine')
    path = Path(stores.settings['state_dir'])/'data-reset-RQ-102-N15.json'
    pending = journal.load(stores.settings, path)
    assert pending['state'] == 'quarantining' and pending['pg_state'] == 'dumped'
    assert not WRITERS & active and 'release-watchdog' not in active
    phase = len(calls)
    command(host, 'quarantine')
    result = json.loads(capsys.readouterr().out)
    assert result['state'] == 'quarantined' and result['verification']['manifest_complete']
    recovery = calls[phase:]
    assert ['drain'] not in recovery
    assert recovery.index(['reset']) < next(n for n, call in enumerate(recovery) if 'migrate' in call)
    assert WRITERS <= active and 'release-watchdog' not in active


def test_stopped_restoring_rollback_never_execs_live_drain(product_command, monkeypatch, capsys):
    stores, host, calls, active = product_command
    live_drain(monkeypatch, calls, active)
    command(host, 'quarantine')
    cut = json.loads(capsys.readouterr().out)
    with monkeypatch.context() as interrupted:
        interrupt_after_save(interrupted, lambda row: row['state'] == 'restoring' and row.get('rollback_started'))
        with pytest.raises(KeyboardInterrupt):
            command(host, 'rollback', cut['receipt'])
    assert journal.load(stores.settings, cut['receipt'])['state'] == 'restoring'
    assert not WRITERS & active
    phase = len(calls)
    command(host, 'rollback', cut['receipt'])
    result = json.loads(capsys.readouterr().out)
    assert result['state'] == 'restored' and result['rollback_verified']
    assert ['drain'] not in calls[phase:] and WRITERS <= active


def test_running_writers_still_drain_before_recovery(product_command, monkeypatch):
    stores, host, calls, active = product_command
    live_drain(monkeypatch, calls, active)
    with monkeypatch.context() as interrupted:
        interrupt_after_save(interrupted, lambda row: row.get('pg_state') == 'dumped')
        with pytest.raises(KeyboardInterrupt):
            command(host, 'quarantine')
    # Even an unfinished journal cannot exempt writers that are running now.
    active.update(WRITERS)
    phase = len(calls)
    live_drain(monkeypatch, calls, active, passed=False)
    with pytest.raises(RuntimeError, match='^RESET_DRAIN_FAILED$'):
        command(host, 'quarantine')
    assert calls[phase:].count(['drain']) == 1
    assert not any(call[0] == 'stop' for call in calls[phase:])
    assert WRITERS <= active


def test_official_release_rollback_stops_writers_before_reset_hook(product_command, monkeypatch, capsys, tmp_path):
    stores, host, calls, active = product_command
    command(host, 'quarantine')
    capsys.readouterr()
    previous = tmp_path/'previous'; previous.mkdir()
    host.root = tmp_path
    host.release = lambda name: tmp_path if name == 'current' else previous
    host.event = lambda *args, **kwargs: None
    monkeypatch.setattr(release.release_migrations, 'project_rollback', lambda *args: None)
    monkeypatch.setattr(release, 'point', lambda *args: None)
    monkeypatch.setattr(release, 'restore_front', lambda *args: {})
    monkeypatch.setattr(release, 'retire_newer_transport', lambda *args: {})
    monkeypatch.setattr(release.release_build, 'write', lambda *args: None)
    hook = release_data_reset.hook
    def checked_hook(*args, **kwargs):
        calls.append(['rollback-hook'])
        assert not WRITERS & active and 'release-watchdog' not in active
        return hook(*args, **kwargs)
    monkeypatch.setattr(release_data_reset, 'hook', checked_hook)
    phase = len(calls)
    result = release.rollback(host, 'owner_request')
    assert result['data_reset']['rollback_verified']
    recovery = calls[phase:]
    assert next(n for n, call in enumerate(recovery) if call[0] == 'stop') < recovery.index(['rollback-hook'])
    assert WRITERS <= active and 'release-watchdog' in active


def test_restored_cli_retry_delegates_engine_result_without_service_lifecycle(product_command, monkeypatch, capsys):
    stores, host, calls, active = product_command
    command(host, 'quarantine')
    cut = json.loads(capsys.readouterr().out)
    command(host, 'rollback', cut['receipt'])
    completed = json.loads(capsys.readouterr().out)
    assert journal.load(stores.settings, cut['receipt'])['state'] == 'restored'
    # A completed receipt is answered under the release lock by the real engine's
    # idempotent result, before any host context, drain or service step.
    def no_context(*args):
        raise AssertionError('context resolved for a completed receipt')
    monkeypatch.setattr(release_data_reset.data_reset_host, 'context', no_context)
    live_drain(monkeypatch, calls, active)
    assert WRITERS <= active
    phase = len(calls)
    command(host, 'rollback', cut['receipt'])
    retried = json.loads(capsys.readouterr().out)
    assert retried['state'] == 'restored' and retried['restored'] and retried['rollback_verified']
    assert Path(retried['receipt']).resolve() == Path(cut['receipt']).resolve()
    assert journal.load(stores.settings, cut['receipt'])['state'] == 'restored'
    assert calls[phase:] == []
