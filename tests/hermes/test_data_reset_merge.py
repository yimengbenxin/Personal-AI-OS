"""Old-cut compatibility, live-use preservation and crash recovery through the real reset engine."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from unittest.mock import patch
from uuid import uuid4

import pytest
from data_reset_fixtures import Stores, write
from data_reset_pg_fixture import pg_server, postgres, verify_realtime
from data_reset_live_fixture import accepted, clear_files, export_old_engine, live_stores, node, old_cut, rebind, uid, use
import data_reset
import data_reset_manifest as journal
import data_reset_postgres as pg_engine
import data_reset_restore as restoring
from data_reset_inventory import clear_hash, inventory, keep_hashes, public_plan
from data_reset_policy import VOICE_KEY
from data_reset_sqlite import companions, connect


@pytest.fixture(scope='session')
def old_engine(tmp_path_factory):
    return export_old_engine(tmp_path_factory.mktemp('old-engine'))


def clear_pg(report):
    return {row['table']:(row['clear_rows'],row['clear_sha256']) for row in report['postgres'] if row['action'] != 'keep'}


@contextmanager
def interrupt(point, stores, pg):
    if point in ('file', 'mixed'):
        rename = restoring.rename
        expected = Path(stores.roots['hermes'])/'MEMORY.md' if point == 'file' else Path(stores.roots['owner'])/'central-storage/voiceprints'/VOICE_KEY
        def stop(source, target):
            rename(source, target)
            if Path(target) == expected:
                raise KeyboardInterrupt('after rename, before journal')
        with patch.object(restoring, 'rename', stop):
            yield
    elif point == 'pg-commit':
        restore = pg.restore
        def stop(*args, **kwargs):
            restore(*args, **kwargs)
            if kwargs.get('commit', True):
                raise KeyboardInterrupt('after COMMIT, before receipt save')
        with patch.object(pg, 'restore', stop):
            yield
    elif point == 'pg-transaction':
        popen = subprocess.Popen
        def launch(*args, **kwargs):
            targeted = kwargs.get('stdin') == subprocess.PIPE and kwargs.get('stdout') == subprocess.DEVNULL
            if targeted:
                kwargs['stdout'] = subprocess.PIPE
            process = popen(*args, **kwargs)
            if targeted:
                original = process.stdin
                class Input:
                    def write(self, body):
                        if b' CONTINUE IDENTITY;' in body and body.endswith(b'COMMIT;'):
                            # Execute the real clear inside the transaction and wait for its acknowledgement.
                            prefix = body.split(b"DO 'BEGIN INSERT INTO ", 1)[0]
                            original.write(prefix+b"SELECT 'rq102-clear-executed';\n")
                            original.flush()
                            assert process.stdout.readline().strip() == b'rq102-clear-executed'
                            raise KeyboardInterrupt('connection lost after transactional clear')
                        return original.write(body)
                    def __getattr__(self, name):
                        return getattr(original, name)
                process.stdin = Input()
            return process
        with patch.object(pg_engine.subprocess, 'Popen', launch):
            yield
    else:
        yield


@pytest.mark.parametrize('engine,point', [('old',None),('new',None),('old','file'),('old','mixed'),
                                         ('old','pg-transaction'),('old','pg-commit')])
def test_cut_live_use_merge_restore_and_resume(tmp_path, postgres, old_engine, engine, point):
    cross = os.environ.get('RQ102_CROSS_DEVICE_DIR')
    if not cross:
        pytest.skip('RQ102_CROSS_DEVICE_DIR must name a real second filesystem')
    stores, external = live_stores(tmp_path, cross)
    try:
        postgres.query("SELECT setval('outbox_events_accepted_activity_cursor_seq',110,true); SELECT setval('paios_l3_watermark',40,true);")
        cut_cursor = accepted(postgres, 1)
        postgres.query("SELECT setval('outbox_events_accepted_activity_cursor_seq',150,true);")
        before = inventory(stores.settings, postgres, stores.cold)
        files = clear_files(stores)
        mixed = {r['root']+'/'+r['path']:clear_hash(r) for r in before['files'] if r['action'] in restoring.MIXED}
        cut = old_cut(stores, postgres, old_engine) if engine == 'old' else data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
        receipt = journal.load(stores.settings, cut['receipt'])
        assert public_plan(before) == public_plan(receipt['before'])
        if engine == 'old':
            assert Path(receipt['pg_dump']).read_bytes()[:5] == b'PGDMP'
            decoder = postgres.commands['restore'][:1]+['--data-only','--file=-',receipt['pg_dump']]
            decoded = subprocess.run(decoder,capture_output=True,text=True,check=True).stdout
            # The shipped old table-only archive really captures this owned sequence, including holes.
            assert "setval('public.outbox_events_accepted_activity_cursor_seq', 150, true)" in decoded
        live_cursor = use(stores, postgres)
        # Exercise a live highwater greater than the cut, and the opposite for the owned cursor sequence.
        postgres.query("SELECT setval('paios_l3_watermark',90,true);")
        live = inventory(stores.settings, postgres, stores.cold)
        if point:
            with interrupt(point, stores, postgres), pytest.raises(KeyboardInterrupt):
                data_reset.run(stores.settings,'rollback',postgres,stores.cold,cut['receipt'])
            partial = journal.load(stores.settings,cut['receipt'])
            assert partial['state'] == 'restoring'
            assert partial['rollback_keep'] == keep_hashes(live)
            if point == 'pg-transaction':
                assert postgres.inventory() == live['postgres']
        result = data_reset.run(stores.settings,'rollback',postgres,stores.cold,cut['receipt'])
        assert result['rollback_verified']
        after = inventory(stores.settings,postgres,stores.cold)
        assert keep_hashes(after) == keep_hashes(live)
        assert clear_pg(after) == clear_pg(before)
        assert clear_files(stores) == files
        assert after['cold'] == before['cold']
        assert {r['root']+'/'+r['path']:clear_hash(r) for r in after['files'] if r['action'] in restoring.MIXED} == mixed
        node(stores,'check-live-grant')
        assert node(stores,'read-models')['groups']['brain']['effective'] == 2
        row = journal.load(stores.settings,cut['receipt'])
        assert row['rollback_keep'] == keep_hashes(live)
        displaced = {entry['original']:Path(entry['quarantine']) for entry in row['displaced']}
        assert (displaced[str(Path(stores.roots['hermes'])/'sessions')]/'live.jsonl').read_text() == 'new live conversation'
        for action in restoring.MIXED:
            entry = next(e for e in row['entries'] if e['action'] == action)
            assert entry['original'] in displaced and Path(entry['quarantine']).exists()
        pg_dump = row['rollback_pg_dump']['pg_dump']
        assert {k:(v['clear_rows'],v['clear_sha256']) for k,v in postgres.archive_inventory(pg_dump).items()} == clear_pg(live)
        cold_new = stores.directory/'drive'/row['cold_prefix']/'displaced/originals/2026-10-27/live.jpg'
        assert cold_new.read_bytes() == b'new live cold recording'
        assert int(postgres.query('SELECT last_value FROM paios_l3_watermark;')) == 90
        assert int(postgres.query('SELECT last_value FROM outbox_events_accepted_activity_cursor_seq;')) == 150
        assert accepted(postgres,3) > max(150,live_cursor)
        with pytest.raises(ValueError,match='RESET_POSTGRES_QUERY_FAILED'):
            accepted(postgres,4,explicit_cursor=999)
        triggers = postgres.query("SELECT tgname||':'||tgenabled::text FROM pg_trigger WHERE tgrelid='outbox_events'::regclass AND tgname IN ('outbox_events_accepted_activity_cursor_allocator','outbox_events_accepted_activity_notify') ORDER BY tgname;")
        assert triggers.splitlines() == ['outbox_events_accepted_activity_cursor_allocator:O','outbox_events_accepted_activity_notify:O']
        verify_realtime(postgres)
    finally:
        shutil.rmtree(external)


def test_changed_quarantine_original_refuses_before_restore(tmp_path):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    receipt = journal.load(stores.settings,cut['receipt'])
    entry = next(e for e in receipt['entries'] if e['path'] == 'MEMORY.md')
    with Path(entry['quarantine']).open('ab') as stream:
        stream.write(b'changed original')
    with pytest.raises(ValueError,match='RESET_QUARANTINE_COUNTS_CHANGED'):
        data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=cut['receipt'])
    assert not Path(entry['original']).exists()


def test_same_size_write_through_keep_hardlink_cannot_silently_change_cut_history(tmp_path):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    kept = Path(stores.roots['hermes'])/'skills/hardlink.txt'
    kept.write_bytes(b'x'*kept.stat().st_size)
    data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=cut['receipt'])
    restored = Path(stores.roots['owner'])/'central-storage/stream-revisions/shared'
    assert restored.read_bytes() == b'synthetic shared inode'
    assert kept.read_bytes() == b'x'*kept.stat().st_size
    assert kept.stat().st_ino != restored.stat().st_ino


def test_changed_store_binding_refuses(tmp_path, postgres):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    role = 'rq102_'+uuid4().hex
    postgres.query('CREATE ROLE '+role+' SUPERUSER LOGIN;')
    commands = {key:[role if arg == 'rq102' else arg for arg in value] for key,value in postgres.commands.items()}
    changed = pg_engine.Postgres(commands)
    try:
        with pytest.raises(ValueError,match='RESET_STORE_BINDING_CHANGED'):
            data_reset.run(stores.settings,'rollback',changed,stores.cold,cut['receipt'])
    finally:
        postgres.query('DROP ROLE '+role+';')


@pytest.mark.parametrize('kind', ['payment','voiceprint'])
def test_unmergeable_mixed_names_only_its_class(tmp_path, kind):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    if kind == 'payment':
        with sqlite3.connect(Path(stores.roots['owner'])/'central-storage/payment/payment.sqlite') as db:
            db.execute("UPDATE policy SET version=2")
            db.execute('ALTER TABLE policy ADD COLUMN newer_setting TEXT')
    else:
        # Only a schema the producer cannot migrate is unmergeable.
        path = Path(stores.roots['owner'])/'central-storage/voiceprints'/VOICE_KEY
        path.write_text(json.dumps(dict(schema='paios.voiceprint.registry.v3',revision=20,next_number=1,
                                       owner=None,clusters=[],assistant=[])))
    with pytest.raises(ValueError,match='^RESET_ROLLBACK_MIXED_UNMERGEABLE_'+kind.upper()+'$'):
        data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=cut['receipt'])
    receipt = journal.load(stores.settings,cut['receipt'])
    assert not receipt['displaced'] and receipt['state'] == 'quarantined'


def test_real_pg_unique_conflict_names_table_and_preserves_live_rows(tmp_path, postgres):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    rebind(postgres,continuity=202)  # Cut clear session 102 already owns this active continuity.
    live = postgres.inventory()
    with pytest.raises(ValueError,match=r'^RESET_POSTGRES_CONFLICT_MIXED_PUBLIC_REALTIME_SESSIONS_23505$'):
        data_reset.run(stores.settings,'rollback',postgres,stores.cold,cut['receipt'])
    assert postgres.inventory() == live


def test_real_deferred_fk_conflict_names_table_and_preserves_live_rows(tmp_path, postgres):
    stores = Stores(tmp_path)
    postgres.query("INSERT INTO avatar_profiles VALUES('cut-owner','{}'); INSERT INTO avatar_profile_commands VALUES('cut-owner','cut-command','queued',now(),'{}');")
    cut = data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    postgres.query("DELETE FROM avatar_profiles WHERE principal_id='cut-owner';")
    live = postgres.inventory()
    with pytest.raises(ValueError,match=r'^RESET_POSTGRES_CONFLICT_CLEAR_PUBLIC_AVATAR_PROFILE_COMMANDS_23503$'):
        data_reset.run(stores.settings,'rollback',postgres,stores.cold,cut['receipt'])
    assert postgres.inventory() == live


def test_old_cut_with_unprovable_mixed_partition_refuses_by_class(tmp_path, postgres, old_engine):
    stores = Stores(tmp_path)
    cut = old_cut(stores,postgres,old_engine)
    postgres.query('DELETE FROM apple_physical_canary_bindings;')
    live = postgres.inventory()
    with pytest.raises(ValueError,match=r'^RESET_POSTGRES_CONFLICT_MIXED_PUBLIC_DEVICE_LEASES_P0001$'):
        data_reset.run(stores.settings,'rollback',postgres,stores.cold,cut['receipt'])
    assert postgres.inventory() == live
    assert not journal.load(stores.settings,cut['receipt'])['displaced']


@pytest.mark.parametrize('kind', ['pure','mixed','postgres'])
def test_prestart_verification_remains_strict(tmp_path, postgres, kind):
    stores = Stores(tmp_path)
    cut = data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    if kind == 'pure':
        write(Path(stores.roots['hermes']),'skills/tool/SKILL.md','prestart keep drift')
    elif kind == 'mixed':
        with sqlite3.connect(Path(stores.roots['owner'])/'central-storage/payment/payment.sqlite') as db:
            db.execute('UPDATE policy SET version=2')
    else:
        postgres.query("UPDATE paired_devices SET token_sha256=repeat('e',64);")
    with pytest.raises(ValueError,match='^RESET_KEEP_HASH_CHANGED$'):
        data_reset.run(stores.settings,'verify',postgres,stores.cold,cut['receipt'])


def test_payment_wal_merges_live_keep_and_preserves_readable_displaced_snapshot(tmp_path):
    stores = Stores(tmp_path)
    payment = Path(stores.roots['owner'])/'central-storage/payment/payment.sqlite'
    def offline_snapshot(version, marker):
        source = tmp_path/'wal-source.sqlite'
        shutil.copyfile(payment,source)
        db = sqlite3.connect(source)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('UPDATE policy SET version=?',(version,))
            db.execute("INSERT INTO events(at_ms,principal_id,kind,actor,data,prev_hash,hash) VALUES(3,'owner',?,'owner','{}','b','c')",(marker,))
            db.commit()
            shutil.copyfile(source,payment)
            for side, target in zip(companions(source),companions(payment)):
                shutil.copyfile(side,target)
        finally:
            db.close()
            source.unlink()
    offline_snapshot(2,'cut-wal-history')
    before = inventory(stores.settings,cold=stores.cold)
    cut = data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    offline_snapshot(3,'live-wal-history')
    live = inventory(stores.settings,cold=stores.cold)
    assert data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=cut['receipt'])['rollback_verified']
    after = inventory(stores.settings,cold=stores.cold)
    assert keep_hashes(after) == keep_hashes(live)
    assert clear_hash(next(r for r in after['files'] if r['action']=='payment')) == clear_hash(next(r for r in before['files'] if r['action']=='payment'))
    row = journal.load(stores.settings,cut['receipt'])
    displaced = Path(next(r['quarantine'] for r in row['displaced'] if r['original']==str(payment)))
    with connect(displaced,stores.settings['state_dir']) as db:
        assert db.execute('SELECT version FROM policy').fetchone() == (3,)
        assert db.execute('SELECT kind FROM events').fetchall() == [('live-wal-history',)]
    assert all(not side.exists() for side in companions(payment))
    assert any(r.get('rollback_absorbed') for r in row['entries'])


def test_new_mixed_authority_keeps_live_settings_and_displaces_only_new_history(tmp_path):
    from data_reset_policy import OVERRIDE_KEY
    stores = Stores(tmp_path)
    path = Path(stores.roots['owner'])/'central-storage/voiceprints'/OVERRIDE_KEY
    path.unlink()
    cut = data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    value = dict(enabled=True,expires_at=None,enabled_by_device='live-phone',failures=[dict(device='guest',at=1)])
    path.write_text(json.dumps(value))
    live = keep_hashes(inventory(stores.settings,cold=stores.cold))
    assert data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=cut['receipt'])['rollback_verified']
    assert keep_hashes(inventory(stores.settings,cold=stores.cold)) == live
    assert json.loads(path.read_text()) == {**value,'failures':[]}
