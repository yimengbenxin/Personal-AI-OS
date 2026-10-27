"""A lost response after the durable restore commit is safe to retry through engine and CLI."""
from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_data_reset_review import settings_at
import data_reset
import data_reset_manifest as journal
import release_data_reset


def snapshot(settings, receipt):
    paths = [Path(receipt)]
    for role in ('owner', 'hermes', 'errands'):
        paths.extend(p for p in Path(settings['roots'][role]).rglob('*') if p.is_file())
    return {str(p):(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in paths}


def completed_restore(tmp_path, monkeypatch):
    settings = settings_at(tmp_path)
    settings['state_dir'] = str(tmp_path/'data-reset')
    cut = data_reset.run(settings, 'quarantine')
    save = journal.save
    def crash(path, row):
        save(path, row)
        if row['state'] == 'restored':
            raise KeyboardInterrupt('restore result was lost after durable save')
    with monkeypatch.context() as injection:
        injection.setattr(journal, 'save', crash)
        with pytest.raises(KeyboardInterrupt, match='durable save'):
            data_reset.run(settings, 'rollback', receipt_path=cut['receipt'])
    assert json.loads(Path(cut['receipt']).read_text())['state'] == 'restored'
    # Work may resume before a caller retries the lost response.
    (tmp_path/'hermes/MEMORY.md').write_text('new history after successful restore')
    return settings, cut['receipt']


def test_restore_retry_after_final_save_returns_success_without_product_writes(tmp_path, monkeypatch):
    settings, receipt = completed_restore(tmp_path, monkeypatch)
    before = snapshot(settings, receipt)
    result = data_reset.run(settings, 'rollback', receipt_path=receipt)
    assert result == dict(state='restored', restored=True, receipt=receipt, keep_verified=True,
                          inode_counts_verified=True, rollback_verified=True)
    assert data_reset.run(settings, 'rollback', receipt_path=receipt) == result
    assert snapshot(settings, receipt) == before


def test_completed_restore_cli_retry_never_resolves_or_touches_services(tmp_path, monkeypatch, capsys):
    settings, receipt = completed_restore(tmp_path, monkeypatch)
    before = snapshot(settings, receipt)
    @contextmanager
    def locked():
        yield
    def service_call(*args, **kwargs):
        pytest.fail('a completed restore must not resolve, drain, stop or start services')
    host = SimpleNamespace(config={'data_reset':settings}, locked=locked,
        lock_path=lambda:tmp_path/'release.lock', release=service_call, runner=service_call)
    release_data_reset.command(host, SimpleNamespace(action='rollback', receipt=receipt))
    result = json.loads(capsys.readouterr().out)
    assert result['state'] == 'restored' and result['rollback_verified']
    assert snapshot(settings, receipt) == before
