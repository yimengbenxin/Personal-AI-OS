"""Real PostgreSQL 18 regressions for the reset dump and locked clear contract."""
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0, str(ROOT / 'deploy/cloud'))

import data_reset
import data_reset_cut as cut
import data_reset_manifest as journal
import data_reset_quarantine as quarantine
from data_reset_inventory import inventory
from data_reset_policy import RESET_ID
from data_reset_postgres import Postgres
from data_reset_pg_fixture import pg_server, postgres
from data_reset_live_fixture import accepted
from test_data_reset_review import settings_at


BODY = '{"schema":"l3.audit.v1","status":"active","applicability_status":"applicable"}'


def insert_version(postgres, principal):
    postgres.query("INSERT INTO paios_l3_versions VALUES(" +
                   "'" + principal + "','late',1,'" + BODY + "'::jsonb);")


def activity(postgres, marker):
    return postgres.query(
        "SELECT json_build_object('pid',pid,'xid',backend_xid::text,'state',state,"
        "'wait_event_type',wait_event_type,'wait_event',wait_event)::text "
        "FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() "
        "AND query LIKE '/* " + marker + " */%';")


def wait_activity(postgres, marker, ready, description, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = activity(postgres, marker)
        if result:
            row = json.loads(result)
            if ready(row):
                return row
        time.sleep(0.025)
    raise AssertionError('timed out waiting for ' + description + '; last activity=' + (result or 'none'))


def wait_no_activity(postgres, marker, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = activity(postgres, marker)
        if not result:
            return
        time.sleep(0.025)
    raise AssertionError('timed out waiting for backend exit; last activity=' + result)


def pg_plan(settings, postgres):
    return inventory(settings, postgres, cut=True)


def assert_plan_unchanged(postgres, plan):
    expected = {row['table']: row['sha256'] for row in plan['postgres']}
    assert postgres.fingerprints(plan['postgres']) == expected
    actual = {row['table']: row for row in postgres.inventory()}
    for before in plan['postgres']:
        if before['action'] in ('keep', 'mixed'):
            assert actual[before['table']]['keep_rows'] == before['keep_rows']
            assert actual[before['table']]['keep_sha256'] == before['keep_sha256']


def assert_kept_fingerprints(postgres, plan):
    actual = {row['table']: row for row in postgres.inventory()}
    for before in plan['postgres']:
        if before['action'] in ('keep', 'mixed'):
            assert actual[before['table']]['keep_rows'] == before['keep_rows']
            assert actual[before['table']]['keep_sha256'] == before['keep_sha256']


def clear_receipt(tmp_path):
    return tmp_path / 'state' / ('data-reset-' + RESET_ID + '.json')


@pytest.mark.parametrize('orphan_client', [False, True], ids=['live-client', 'orphaned-backend'])
def test_no_xid_writer_refuses_reset_and_plain_retry_after_abort_succeeds(tmp_path, postgres, orphan_client):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    marker = 'n15_no_xid_' + uuid4().hex
    sql = ("/* " + marker + " */ INSERT INTO paios_l3_versions SELECT '" + marker +
           "','late',1,'" + BODY + "'::jsonb FROM pg_sleep(30);")
    child = subprocess.Popen(postgres.commands['query'] + ['-q', '-c', sql],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        row = wait_activity(postgres, marker,
            lambda value: value['state'] == 'active' and value['wait_event'] == 'PgSleep',
            'the INSERT SELECT backend to reach pg_sleep')
        assert row['xid'] is None
        if orphan_client:
            child.terminate()
            child.wait(timeout=5)
            row = wait_activity(postgres, marker,
                lambda value: value['state'] == 'active' and value['wait_event'] == 'PgSleep',
                'the disconnected client backend to remain active')
            assert row['xid'] is None

        with pytest.raises(ValueError, match='^RESET_POSTGRES_WRITER_ACTIVE$'):
            data_reset.run(settings, 'quarantine', postgres)
        assert_plan_unchanged(postgres, plan)
        assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '0'

        assert postgres.query('SELECT pg_cancel_backend(' + str(row['pid']) + ');') == 't'
        wait_no_activity(postgres, marker)
        if child.poll() is None:
            child.communicate(timeout=5)
        result = data_reset.run(settings, 'quarantine', postgres)
        assert result['state'] == 'quarantined'
        assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '0'
        assert_kept_fingerprints(postgres, plan)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_dump_that_differs_from_plan_is_refused_before_any_clear(tmp_path, postgres, monkeypatch):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    marker = 'n15_dump_mismatch_' + uuid4().hex
    original_dump = Postgres.write_dump
    original_rename = quarantine.rename
    moved = []

    def insert_then_dump(self, target, before=None):
        insert_version(self, marker)
        return original_dump(self, target, before)

    def record_move(source, target):
        moved.append((source, target))
        return original_rename(source, target)

    monkeypatch.setattr(Postgres, 'write_dump', insert_then_dump)
    monkeypatch.setattr(quarantine, 'rename', record_move)
    with pytest.raises(ValueError, match='^RESET_POSTGRES_DUMP_PLAN_CHANGED$'):
        data_reset.run(settings, 'quarantine', postgres)
    receipt = journal.load(settings, clear_receipt(tmp_path))
    assert receipt['state'] == 'quarantining'
    assert receipt['pg_state'] == 'pending'
    assert all(entry['state'] == 'pending' for entry in receipt['entries'])
    assert all(Path(entry['original']).exists() for entry in receipt['entries'])
    assert moved == []
    assert postgres.fingerprints(plan['postgres']) != {row['table']: row['sha256'] for row in plan['postgres']}
    assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '1'


@pytest.mark.parametrize('crash_after_first_move', [False, True], ids=['before-first-move', 'after-first-move-crash'])
def test_committed_post_dump_row_is_never_rebound_to_cut(tmp_path, postgres, monkeypatch, crash_after_first_move):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    marker = 'n15_late_history_' + uuid4().hex
    if crash_after_first_move:
        original_rename = quarantine.rename
        committed = False

        def commit_after_first_move(source, target):
            nonlocal committed
            original_rename(source, target)
            if not committed:
                committed = True
                insert_version(postgres, marker)
                raise KeyboardInterrupt('first hot move committed; late PostgreSQL row committed')

        monkeypatch.setattr(quarantine, 'rename', commit_after_first_move)
        with pytest.raises(KeyboardInterrupt):
            data_reset.run(settings, 'quarantine', postgres)
        monkeypatch.setattr(quarantine, 'rename', original_rename)
        expected = 'RESET_POSTGRES_CHANGED_SINCE_PLAN'
    else:
        original_dump = Postgres.write_dump
        committed = False

        def commit_after_dump(self, target, before=None):
            nonlocal committed
            result = original_dump(self, target, before)
            if not committed:
                committed = True
                insert_version(self, marker)
            return result

        monkeypatch.setattr(Postgres, 'write_dump', commit_after_dump)
        expected = 'RESET_CUT_POSTGRES_WRITTEN'

    with pytest.raises(ValueError, match='^' + expected + '$'):
        data_reset.run(settings, 'quarantine', postgres)
    receipt = journal.load(settings, clear_receipt(tmp_path))
    assert receipt['state'] == 'quarantining'
    assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '1'
    assert postgres.fingerprints(plan['postgres']) != {row['table']: row['sha256'] for row in plan['postgres']}
    assert marker not in Path(receipt['pg_dump']).read_text()
    postgres.verify_dump(receipt['pg_dump'], plan['postgres'])

    with pytest.raises(ValueError, match='^' + expected + '$'):
        data_reset.run(settings, 'quarantine', postgres)
    receipt = journal.load(settings, clear_receipt(tmp_path))
    assert receipt['state'] == 'quarantining'
    assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '1'


def test_unrelated_database_write_does_not_change_product_table_cut(tmp_path, postgres):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    query = list(postgres.commands['query'])
    query[query.index('-d') + 1] = 'postgres'
    other = Postgres({'query': query})
    table = 'n15_unrelated_' + uuid4().hex
    try:
        other.query('CREATE TABLE public.' + table + '(value integer); INSERT INTO public.' + table + ' VALUES(1);')
        assert_plan_unchanged(postgres, plan)
        cut.check(settings, plan, plan['preimage'], postgres)
        assert data_reset.run(settings, 'quarantine', postgres)['state'] == 'quarantined'
    finally:
        other.query('DROP TABLE IF EXISTS public.' + table + ';')


def advisory_gate(postgres, application_name, key):
    env = {**os.environ, 'PGAPPNAME': application_name}
    process = subprocess.Popen(postgres.commands['query'], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    process.stdin.write('BEGIN; SELECT pg_advisory_xact_lock(' + str(key) + '); SELECT 1;\n')
    process.stdin.flush()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if postgres.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='" +
                          application_name + "' AND state='idle in transaction';") == '1':
            return process
        time.sleep(0.025)
    process.kill()
    process.wait(timeout=5)
    raise AssertionError('advisory gate did not become ready: ' + application_name)


def release_gate(process):
    if process.poll() is None:
        process.stdin.write('COMMIT;\n\\q\n')
        process.stdin.flush()
        _, error = process.communicate(timeout=10)
        assert process.returncode == 0, error


def test_clear_locks_every_planned_table_and_waiting_writer_commits_after_clear(tmp_path, postgres, monkeypatch):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    marker = 'n15_after_clear_' + uuid4().hex
    clear_key, writer_key = 8172635, 8172636
    clear_gate = advisory_gate(postgres, 'n15-clear-gate', clear_key)
    writer_gate = advisory_gate(postgres, 'n15-writer-gate', writer_key)
    original_query = Postgres.query
    outcome = {}

    def hold_clear_transaction(self, sql):
        if 'ACCESS EXCLUSIVE MODE NOWAIT' in sql:
            head, separator, tail = sql.rpartition('COMMIT;')
            assert separator
            sql = (head + '/* n15_clear_tx */ SELECT pg_advisory_xact_lock(' +
                   str(clear_key) + '); COMMIT;' + tail)
        return original_query(self, sql)

    monkeypatch.setattr(Postgres, 'query', hold_clear_transaction)

    def reset():
        try:
            outcome['result'] = data_reset.run(settings, 'quarantine', postgres)
        except BaseException as error:
            outcome['error'] = error

    worker = None
    reset_thread = threading.Thread(target=reset, daemon=True)
    try:
        reset_thread.start()
        try:
            wait_activity(postgres, 'n15_clear_tx',
                lambda row: row['wait_event_type'] == 'Lock' and row['wait_event'] == 'advisory',
                'reset transaction to acquire planned table locks')
        except AssertionError as error:
            reset_thread.join(timeout=1)
            active = postgres.query(
                "SELECT coalesce(json_agg(json_build_object('pid',pid,'state',state,'wait',wait_event,"
                "'query',left(query,180))),'[]') FROM pg_stat_activity "
                "WHERE datname=current_database() AND pid<>pg_backend_pid();")
            raise AssertionError(str(error) + '; reset outcome=' + repr(outcome) + '; active=' + active) from error
        lock_rows = json.loads(postgres.query(
            "SELECT coalesce(json_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]') "
            "FROM pg_locks l JOIN pg_class c ON c.oid=l.relation "
            "JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE l.pid=(SELECT pid FROM pg_stat_activity WHERE query LIKE '/* n15_clear_tx */%' "
            "AND wait_event='advisory' LIMIT 1) AND l.locktype='relation' "
            "AND l.mode='AccessExclusiveLock' AND l.granted AND c.relkind IN ('r','p');"))
        assert set(lock_rows) == {row['table'] for row in plan['postgres']}

        writer_sql = ("/* " + marker + " */ BEGIN; /* " + marker +
                      " */ INSERT INTO paios_l3_versions VALUES('" + marker +
                      "','late',1,'" + BODY + "'::jsonb); /* " + marker +
                      " */ SELECT pg_advisory_xact_lock(" +
                      str(writer_key) + '); COMMIT;')
        worker = subprocess.Popen(postgres.commands['query'] + ['-q', '-c', writer_sql],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        blocked = wait_activity(postgres, marker,
            lambda row: row['wait_event_type'] == 'Lock' and row['wait_event'] == 'relation',
            'writer to block on the clear table lock')
        release_gate(clear_gate)
        reset_thread.join(timeout=60)
        assert not reset_thread.is_alive(), 'reset did not finish after releasing table locks'
        if 'error' in outcome:
            raise outcome['error']
        assert outcome['result']['state'] == 'quarantined'
        wait_activity(postgres, marker,
            lambda row: row['wait_event_type'] == 'Lock' and row['wait_event'] == 'advisory',
            'writer to finish its insert after the clear commit')
        assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '0'
        release_gate(writer_gate)
        _, error = worker.communicate(timeout=15)
        assert worker.returncode == 0, error
        assert postgres.query("SELECT count(*) FROM paios_l3_versions WHERE principal_id='" + marker + "';") == '1'
        assert_kept_fingerprints(postgres, plan)
    finally:
        release_gate(clear_gate)
        release_gate(writer_gate)
        if worker is not None and worker.poll() is None:
            worker.kill()
            worker.wait(timeout=5)
        if reset_thread.is_alive():
            reset_thread.join(timeout=15)


def test_backend_crash_inside_clear_transaction_rolls_back_then_receipt_retry_clears(tmp_path, postgres, monkeypatch):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    original_query = Postgres.query

    def terminate_clear_backend(self, sql):
        if 'ACCESS EXCLUSIVE MODE NOWAIT' in sql:
            head, separator, tail = sql.rpartition('COMMIT;')
            assert separator
            sql = head + 'SELECT pg_terminate_backend(pg_backend_pid()); COMMIT;' + tail
        return original_query(self, sql)

    monkeypatch.setattr(Postgres, 'query', terminate_clear_backend)
    with pytest.raises(ValueError, match='^RESET_POSTGRES_QUERY_FAILED$'):
        data_reset.run(settings, 'quarantine', postgres)
    assert_plan_unchanged(postgres, plan)
    receipt = journal.load(settings, clear_receipt(tmp_path))
    assert receipt['state'] == 'quarantining'
    assert receipt['pg_state'] == 'clearing'

    monkeypatch.setattr(Postgres, 'query', original_query)
    result = data_reset.run(settings, 'quarantine', postgres)
    assert result['state'] == 'quarantined'
    assert_kept_fingerprints(postgres, plan)
    for row in postgres.inventory():
        if row['action'] in ('clear', 'mixed'):
            expected = 1 if row['table'] == 'public.memory_authority_clock' else 0
            assert row['clear_rows'] == expected


def test_commit_before_receipt_checkpoint_retry_does_not_replay_sequence_reset(tmp_path, postgres, monkeypatch):
    settings = settings_at(tmp_path)
    plan = pg_plan(settings, postgres)
    original_clear = Postgres.clear

    def commit_then_crash(self, before, fresh=True, *, resume=False):
        original_clear(self, before, fresh, resume=resume)
        raise KeyboardInterrupt('clear committed before receipt checkpoint')

    monkeypatch.setattr(Postgres, 'clear', commit_then_crash)
    with pytest.raises(KeyboardInterrupt, match='clear committed before receipt checkpoint'):
        data_reset.run(settings, 'quarantine', postgres)
    receipt_path = clear_receipt(tmp_path)
    receipt = journal.load(settings, receipt_path)
    assert receipt['state'] == 'quarantining'
    assert receipt['pg_state'] == 'clearing'
    assert_kept_fingerprints(postgres, plan)
    for row in postgres.inventory():
        if row['action'] in ('clear', 'mixed'):
            expected = 1 if row['table'] == 'public.memory_authority_clock' else 0
            assert row['clear_rows'] == expected

    postgres.query("SELECT setval('public.outbox_events_accepted_activity_cursor_seq',500,true);")
    monkeypatch.setattr(Postgres, 'clear', original_clear)
    result = data_reset.run(settings, 'quarantine', postgres)
    assert result['state'] == 'quarantined'
    assert postgres.query('SELECT last_value::text||\':\'||is_called::text '
                          'FROM public.outbox_events_accepted_activity_cursor_seq;') == '500:true'
    assert accepted(postgres, 1) == 501
