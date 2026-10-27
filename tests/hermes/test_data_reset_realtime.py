"""Repository-shaped reconnect, old sequence evidence, and actual trigger recovery."""
import json
import subprocess
import sys

import pytest
from data_reset_fixtures import ROOT
from data_reset_pg_fixture import pg_server, postgres, realtime, verify_realtime
from data_reset_live_fixture import accepted, export_old_engine, rebind


def legacy_dump(pg, engine, archive):
    script = '''
import json,sys
sys.path.insert(0,sys.argv[1])
from data_reset_postgres import Postgres
p=Postgres(json.load(sys.stdin)).dump()
with open(sys.argv[2],'wb') as f:
    f.write(p.stdout.read())
assert p.wait()==0
'''
    commands = dict(pg.commands)
    run = subprocess.run([sys.executable,'-c',script,str(engine/'deploy/cloud'),str(archive)],
                         input=json.dumps(commands),text=True,capture_output=True)
    assert run.returncode == 0, run.stderr
    decode = pg.commands['restore'][:1]+['--data-only','--file=-',str(archive)]
    return subprocess.run(decode,capture_output=True,text=True,check=True).stdout


def test_realtime_repository_load_and_use_after_restore(postgres, tmp_path):
    before = postgres.inventory()
    archive = tmp_path/'cut.jsonl'
    postgres.write_dump(archive)
    postgres.clear(before)
    rebind(postgres)
    postgres.restore(archive)
    assert verify_realtime(postgres)['repository']


def test_old_dump_sequence_highwater_and_missing_refusal(postgres, tmp_path):
    old = export_old_engine(tmp_path/'old')
    postgres.query("SELECT setval('outbox_events_accepted_activity_cursor_seq',110,true);")
    assert accepted(postgres,1) == 111
    postgres.query("SELECT setval('outbox_events_accepted_activity_cursor_seq',150,true);")
    before = postgres.inventory()
    archive = tmp_path/'old.dump'
    decoded = legacy_dump(postgres,old,archive)
    sets = [line for line in decoded.splitlines() if 'pg_catalog.setval' in line]
    print('OLD_SEQUENCE_SET',sets)
    assert "SELECT pg_catalog.setval('public.outbox_events_accepted_activity_cursor_seq', 150, true);" in sets
    assert not any('paios_l3_watermark' in line for line in sets)
    converted = postgres.prepare_restore(archive,before)
    rows = [json.loads(line) for line in converted.read_text().splitlines()]
    assert any(row.get('value') == 150 and 'outbox_events_accepted_activity_cursor_seq' in row.get('sequence','') for row in rows)
    postgres.clear(before)
    postgres.restore(converted)
    assert accepted(postgres,2) == 151
    # The old source omits an unowned sequence. Inventory's table/schema-migration
    # fingerprints cannot prove the sequence's catalog ownership was intact.
    missing = tmp_path/'missing.dump'
    postgres.query('ALTER SEQUENCE outbox_events_accepted_activity_cursor_seq OWNED BY NONE;')
    try:
        decoded = legacy_dump(postgres,old,missing)
    finally:
        postgres.query('ALTER SEQUENCE outbox_events_accepted_activity_cursor_seq OWNED BY outbox_events.accepted_activity_cursor;')
    assert 'pg_catalog.setval' not in decoded
    live_before = postgres.inventory()
    with pytest.raises(ValueError,match='RESET_POSTGRES_LEGACY_CURSOR_SEQUENCE_REQUIRED'):
        postgres.prepare_restore(missing,live_before)
    assert postgres.inventory() == live_before
    assert not missing.with_name(missing.name+'.clear-v2').exists()


@pytest.mark.parametrize('state,clause',[('O','ENABLE'),('D','DISABLE'),('R','ENABLE REPLICA'),('A','ENABLE ALWAYS')])
def test_trigger_state_and_origin_replica_behavior(postgres,tmp_path,state,clause):
    accepted(postgres,1)
    triggers = ['outbox_events_accepted_activity_cursor_allocator','outbox_events_accepted_activity_notify']
    for name in triggers:
        postgres.query('ALTER TABLE outbox_events '+clause+' TRIGGER '+name+';')
    before = postgres.inventory()
    archive = tmp_path/'trigger-cut.jsonl'
    postgres.write_dump(archive)
    postgres.clear(before)
    postgres.restore(archive)
    states = postgres.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='outbox_events'::regclass AND tgname IN ('"+"','".join(triggers)+"') ORDER BY tgname;")
    assert states.splitlines() == [state,state]
    assert realtime(postgres,'triggers',state)['repository']
