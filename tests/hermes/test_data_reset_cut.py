"""One source cut on real stores/PG and two filesystems; no candidate image build."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
from types import SimpleNamespace

import pytest
from data_reset_fixtures import Stores, write
from data_reset_pg_fixture import pg_server, postgres
import data_reset
import data_reset_cut as cut
import data_reset_inventory as scanning
import data_reset_manifest as journal
import data_reset_quarantine as moving
import release
import release_data_reset


@pytest.fixture
def stores(tmp_path):
    value = Stores(tmp_path)
    with tempfile.TemporaryDirectory(prefix='rq102-cut-', dir=os.environ.get('RQ102_CROSS_DEVICE_DIR', '/dev/shm')) as other:
        target = Path(other)/'desktop_out'
        shutil.move(value.roots['desktop_out'], target)
        value.roots['desktop_out'] = str(target)
        assert target.stat().st_dev != Path(value.roots['owner']).stat().st_dev
        yield value


def test_live_writers_stop_then_migrate_then_one_bound_cut(stores, postgres, monkeypatch):
    home = Path(stores.roots['hermes']); stopped = threading.Event(); writes = []
    for relative in ('state/progress.jsonl', 'cron/runner.log'):
        write(home, relative, b'initial state\n')
    def writer():
        while not stopped.is_set():
            for relative in ('logs/call.log', 'cron/runner.log', 'state/progress.jsonl'):
                with (home/relative).open('ab') as stream:
                    stream.write(b'live history\n')
            stage = stores.directory/'atomic-stage'
            previous_inode = (home/'cron/jobs.json').stat().st_ino
            stage.write_bytes(b'atomic state')
            stage.replace(home/'cron/jobs.json')
            writes.append((previous_inode, (home/'cron/jobs.json').stat().st_ino)); time.sleep(.005)
    worker = threading.Thread(target=writer); worker.start()
    try:
        preview = data_reset.run(stores.settings, 'plan', postgres, stores.cold)
    finally:
        stopped.set(); worker.join()
    assert len(writes) > 1
    assert all(old != new for old, new in writes)
    assert all((home/p).stat().st_size > len(b'initial state\n') for p in ('state/progress.jsonl', 'cron/runner.log'))
    write(home, 'cron/migration.txt', b'post-stop migrated state')
    audit = "'{\"schema\":\"l3.audit.v1\",\"status\":\"active\",\"applicability_status\":\"applicable\"}'"
    postgres.query("INSERT INTO paios_l3_versions VALUES('post-stop-migration','fact',1,"+audit+");")
    events = []; original_inventory = data_reset.inventory; prepare = journal.prepare
    def inventory(*args, **kwargs):
        events.append('plan' if kwargs.get('cut') else 'verification'); return original_inventory(*args, **kwargs)
    def prepared(settings, before, cold=None, **kwargs):
        assert events == ['plan', 'review', 'capacity']
        assert before['preimage'] == cut.plan_digest(before) == kwargs['review']['plan_digest']
        assert kwargs['review']['preview_delta']['gated'] is False
        assert kwargs['review']['preview_delta']['cut'] != kwargs['review']['preview_delta']['preview']
        return prepare(settings, before, cold, **kwargs)
    review, capacity = cut.review, cut.capacity
    def reviewed(*args, **kwargs):
        events.append('review'); return review(*args, **kwargs)
    def budget(*args, **kwargs):
        events.append('capacity'); return capacity(*args, **kwargs)
    monkeypatch.setattr(data_reset, 'inventory', inventory)
    monkeypatch.setattr(journal, 'prepare', prepared)
    monkeypatch.setattr(cut, 'review', reviewed); monkeypatch.setattr(cut, 'capacity', budget)
    # Only the cut scan needs PG.inventory; post-reset verify is independently allowed.
    original_pg_inventory = type(postgres).inventory
    calls = []; declarations = []; original_declarations = type(postgres).declarations
    def pg_inventory():
        calls.append(1)
        assert len(calls) <= 2
        return original_pg_inventory(postgres)
    monkeypatch.setattr(postgres, 'inventory', pg_inventory)
    def declared():
        declarations.append(1)
        return original_declarations(postgres)
    monkeypatch.setattr(postgres, 'declarations', declared)
    result = data_reset.run(stores.settings, 'quarantine', postgres, stores.cold, preview=scanning.public_plan(preview))
    row = journal.load(stores.settings, result['receipt'])
    assert result['state'] == 'quarantined' and result['verification']['keep_verified']
    assert events == ['plan', 'review', 'capacity', 'verification'] and len(calls) == len(declarations) == 2
    assert row['cut']['plan_digest'] == row['before']['preimage']
    assert len(row['cut']['capacity']['per_filesystem']) >= 2
    assert all(e['state'] == 'moved' for e in row['entries'])


def test_capacity_counts_the_isolated_hardlink_copies_once(stores):
    plan = data_reset.run(stores.settings, 'plan')
    copied = sum(Path(path).stat().st_size for path in {p['clear'] for p in plan['hardlink_pairs']})
    mixed = sum(row['bytes'] for row in plan['files'] if row['action'] in moving.MIXED)
    assert copied > 0
    assert cut.capacity(stores.settings, plan)['additional_bytes_estimate'] == 3*mixed + copied


@pytest.mark.parametrize('mutation', ['growth', 'atomic', 'postgres', 'cold', 'cold_overwrite', 'new_file', 'digest'])
def test_write_after_cut_is_refused_before_journal_or_any_move(stores, postgres, monkeypatch, mutation):
    capacity = cut.capacity; calls = []
    def after_plan(settings, plan, pg=None, cold=None):
        result = capacity(settings, plan, pg, cold)
        home = Path(stores.roots['hermes'])
        if mutation == 'growth':
            with (home/'logs/call.log').open('ab') as stream: stream.write(b'late write')
        elif mutation == 'atomic':
            stage = home/'cron/.late'; stage.write_bytes(b'new state'); stage.replace(home/'cron/jobs.json')
        elif mutation == 'new_file':
            write(home, 'sessions/late.jsonl', b'late history')
        elif mutation == 'postgres':
            pg.query("INSERT INTO paios_l3_versions VALUES('late','fact',1,"
                     "'{\"schema\":\"l3.audit.v1\",\"status\":\"active\",\"applicability_status\":\"applicable\"}');")
        elif mutation == 'cold':
            write(stores.directory/'drive', 'originals/2026-10-27/late.jpg', b'late cold')
        elif mutation == 'cold_overwrite':
            target = next((stores.directory/'drive').rglob('*.jpg'))
            target.write_bytes(b'x'*target.stat().st_size)
        else:
            plan['files'][0]['bytes'] += 1
        return result
    monkeypatch.setattr(cut, 'capacity', after_plan)
    monkeypatch.setattr(moving, 'rename', lambda *a: calls.append(a))
    monkeypatch.setattr(stores.cold, 'move', lambda *a: calls.append(a))
    with pytest.raises(ValueError, match='^RESET_CUT_(WRITTEN|POSTGRES_WRITTEN|COLD_WRITTEN|PLAN_CHANGED)$'):
        data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
    assert not calls and not list(Path(stores.settings['state_dir']).glob('data-reset-*.json'))


def test_late_write_after_prepare_is_refused_before_first_move(stores, postgres, monkeypatch):
    prepare = journal.prepare; moved = []
    def interrupted(*args, **kwargs):
        result = prepare(*args, **kwargs)
        write(Path(stores.roots['hermes']), 'sessions/late.jsonl', b'late after intent')
        return result
    monkeypatch.setattr(journal, 'prepare', interrupted)
    monkeypatch.setattr(moving, 'rename', lambda *a: moved.append(a))
    monkeypatch.setattr(stores.cold, 'move', lambda *a: moved.append(a))
    with pytest.raises(ValueError, match='^RESET_CUT_WRITTEN$'):
        data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
    path, = Path(stores.settings['state_dir']).glob('data-reset-*.json')
    assert not moved and all(e['state'] == 'pending' for e in json.loads(path.read_text())['entries'])
    # A durable intent is not permission to bypass the same cut on the retry.
    with pytest.raises(ValueError, match='^RESET_CUT_WRITTEN$'):
        data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
    assert not moved and all(e['state'] == 'pending' for e in json.loads(path.read_text())['entries'])


@pytest.mark.parametrize('short_capacity', [False, True])
def test_crash_before_first_move_resumes_same_cut_only_if_capacity_still_fits(stores, postgres, monkeypatch, short_capacity):
    prepare = journal.prepare
    def interrupted(*args, **kwargs):
        prepare(*args, **kwargs)
        raise KeyboardInterrupt('power loss after durable intent, before first move')
    with monkeypatch.context() as injection:
        injection.setattr(journal, 'prepare', interrupted)
        with pytest.raises(KeyboardInterrupt):
            data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
    path, = Path(stores.settings['state_dir']).glob('data-reset-*.json')
    original_digest = json.loads(path.read_text())['cut']['plan_digest']
    if short_capacity:
        capacity = cut.capacity
        def short(*args, **kwargs):
            value = capacity(*args, **kwargs); value['per_filesystem'][0]['free_bytes'] = 0
            return value
        monkeypatch.setattr(cut, 'capacity', short)
        with pytest.raises(ValueError, match='^RESET_CUT_CAPACITY$'):
            data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
        row = json.loads(path.read_text())
        assert all(e['state'] == 'pending' and Path(e['original']).exists() for e in row['entries'])
    else:
        result = data_reset.run(stores.settings, 'quarantine', postgres, stores.cold)
        assert result['state'] == 'quarantined'
        assert result['cut']['plan_digest'] == original_digest


def test_existing_cold_prefix_refuses_before_any_hot_move(stores, monkeypatch):
    stores.cold.mkdir(stores.cold.prefix)
    moved = []; monkeypatch.setattr(moving, 'rename', lambda *a: moved.append(a))
    with pytest.raises(ValueError, match='^RESET_COLD_QUARANTINE_EXISTS$'):
        data_reset.run(stores.settings, 'quarantine', cold=stores.cold)
    assert not moved and (Path(stores.roots['hermes'])/'sessions/owner.jsonl').is_file()


def test_capacity_short_on_second_filesystem_prevents_candidate_service_start(stores, postgres, monkeypatch):
    capacity = cut.capacity; calls = []; active = set()
    def short(*args, **kwargs):
        value = capacity(*args, **kwargs)
        device = Path(stores.roots['desktop_out']).stat().st_dev
        next(r for r in value['per_filesystem'] if r['device'] == device)['free_bytes'] = 0
        return value
    def run(args, **kwargs):
        calls.append(args)
        if args[0] == 'up': active.update(args)
        return SimpleNamespace(stdout='')
    state = Path(stores.settings['state_dir'])
    host = SimpleNamespace(config={'profiles': []}, suffix='', stage='production', lock_path=lambda: state/'release.lock')
    monkeypatch.setattr(cut, 'capacity', short)
    with pytest.raises(ValueError, match='^RESET_CUT_CAPACITY$'):
        release.start(host, stores.directory, run, {}, before_services=lambda:
                      data_reset.run(stores.settings, 'quarantine', postgres, stores.cold))
    assert not {'gateway', 'hermes', 'workshop', 'workshop-link'} & active
    assert not list(state.glob('data-reset-*.json'))
    assert (Path(stores.roots['hermes'])/'sessions/owner.jsonl').exists()


@pytest.mark.parametrize('field,value', [('margin_bytes', 2*1024**3-1), ('reserve_bytes', -1), ('reserve_inodes', True)])
def test_release_capacity_policy_is_explicit_and_cannot_lower_cut_margin(stores, field, value):
    plan = data_reset.run(stores.settings, 'plan')
    stores.settings['capacity'][field] = value
    with pytest.raises(ValueError, match='^RESET_CAPACITY_POLICY$'):
        cut.capacity(stores.settings, plan)
