"""Real old/new reset engines over synthetic stores, source-shaped reconnects and DB triggers."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from data_reset_fixtures import ROOT, Stores, write
from data_reset_inventory import inventory
from data_reset_policy import EPOCH_PATH
from data_reset_pg_fixture import realtime

OLD = '78d4a67989521ae7e1b90d31aa1b8573d40a0620'
INTEGRATION = '01-product-half-finished/backend/services/personal-aios-integration'


def export_old_engine(directory):
    names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', OLD, 'deploy/cloud'], cwd=ROOT, text=True).splitlines()
    names = [name for name in names if Path(name).name.startswith('data_reset') and name.endswith('.py')]
    names.append(INTEGRATION+'/tools/data-reset-voiceprint.ts')
    for name in names:
        target = directory/name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(['git', 'show', OLD+':'+name], cwd=ROOT))
    (directory/INTEGRATION/'src').symlink_to(ROOT/INTEGRATION/'src', target_is_directory=True)
    (directory/INTEGRATION/'node_modules').symlink_to(
        ROOT/INTEGRATION/'node_modules', target_is_directory=True)
    (directory/'integrations').symlink_to(ROOT/'integrations', target_is_directory=True)
    return directory


def old_cut(stores, pg, engine):
    settings = {**stores.settings, 'voice_command':['node', str(engine/INTEGRATION/'tools/data-reset-voiceprint.ts')]}
    script = '''
import json,sys
sys.path.insert(0,sys.argv[1])
import data_reset
from data_reset_postgres import Postgres
from data_reset_cold import Cold
r=json.load(sys.stdin)
print(json.dumps(data_reset.run(r['settings'],'quarantine',Postgres(r['commands']),Cold(r['cold']))))
'''
    result = subprocess.run([sys.executable, '-c', script, str(engine/'deploy/cloud')], capture_output=True, text=True,
                            input=json.dumps({'settings':settings, 'commands':pg.commands, 'cold':stores.cold.config}))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def node(stores, mode):
    path = stores.directory/'contract.json'
    path.write_text(json.dumps(stores.settings))
    result = subprocess.run(['node', str(ROOT/'tests/hermes/data_reset_contract.ts'), mode, str(path)],
                            capture_output=True, text=True, env={**os.environ, 'PAIOS_HERMES_PYTHON':sys.executable})
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def live_stores(directory, cross):
    stores = Stores(directory)
    # Bootstrap before allocating the second-filesystem fixture, so dependency failures leave no mount data.
    for role in ('models', 'projections'):
        root = Path(stores.roots[role])
        shutil.rmtree(root)
        root.mkdir(mode=0o700)
    node(stores, 'seed-models')
    node(stores, 'seed-consents')
    # This is a real second filesystem, not a mocked st_dev.
    moved = Path(tempfile.mkdtemp(prefix=directory.name+'-', dir=Path(cross).resolve()))
    for role in ('errands',):
        root = Path(stores.roots[role])
        shutil.copytree(root, moved/role)
        shutil.rmtree(root)
        stores.roots[role] = str(moved/role)
    assert Path(stores.roots['errands']).stat().st_dev != Path(stores.roots['owner']).stat().st_dev
    return stores, moved


def uid(number):
    return '00000000-0000-7000-8000-'+f'{number:012d}'


def rebind(pg, continuity=201):
    """T11B repository owns session/lease reconnect writes and canonical ref validation.

    The canary pin is a synthetic storage consumer; its refs come from the newly
    repository-written rows. Device authentication and formal-watch HTTP are outside this drill.
    """
    realtime(pg, 'rebind', continuity)
    pg.query("""BEGIN;
        UPDATE paired_devices SET token_sha256=repeat('e',64);
        UPDATE apple_physical_canary_bindings SET state='revoked',revoked_at='2026-10-27T00:00:00Z';
        INSERT INTO apple_physical_canary_bindings
        SELECT (jsonb_populate_record(NULL::apple_physical_canary_bindings,to_jsonb(b)||jsonb_build_object(
            'binding_id','00000000-0000-7000-8000-000000000002','request_id','live-rebind',
            'idempotency_key','live-rebind','realtime_session_ref',s.realtime_session_ref,
            'session_ref_id',s.session_ref_id,'session_object_version',s.session_object_version,
            'session_payload_sha256',s.session_payload_sha256,'iphone_device_lease_ref',i.device_lease_ref,
            'iphone_lease_ref_id',i.lease_ref_id,'iphone_lease_object_version',i.lease_object_version,
            'iphone_lease_payload_sha256',i.lease_payload_sha256,'watch_device_lease_ref',w.device_lease_ref,
            'watch_lease_ref_id',w.lease_ref_id,'watch_lease_object_version',w.lease_object_version,
            'watch_lease_payload_sha256',w.lease_payload_sha256,'state','active','revoked_at',NULL))).*
        FROM apple_physical_canary_bindings b,realtime_sessions s,device_leases i,device_leases w
        WHERE b.binding_id='00000000-0000-7000-8000-000000000001'
        AND s.session_ref_id='00000000-0000-7000-8000-000000000501'
        AND i.lease_ref_id='00000000-0000-7000-8000-000000000601'
        AND w.lease_ref_id='00000000-0000-7000-8000-000000000602'; COMMIT;""")


def accepted(pg, number, explicit_cursor=None):
    """Exact T11B INSERT shape and T04 payload; the actual PG allocator assigns the cursor."""
    payload = dict(activityId='activity-'+str(number),continuityId=uid(201),acceptanceRef={'id':'acceptance'},
        authorityWatermark={'version':str(number)},actionReceipt={'text':"synthetic private\nINSERT INTO public.paired_devices fake 'quoted' $rq$ \\\t"},
        currentBinding={'session':uid(501)},authorityProjection={'authorityWatermark':str(number)})
    body = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    ref = json.dumps(dict(ref_type='RealtimeSession',ref_id=uid(501),object_version='1',canonical_payload_sha256='a'*64))
    def sqlstr(value):
        return "'"+str(value).replace("'", "''")+"'"
    fields = ['event_id','aggregate_type','aggregate_id','aggregate_ref','event_type','event_version',
              'idempotency_scope','idempotency_key','payload','payload_sha256','available_at']
    values = [sqlstr(uid(800+number)),"'realtime'",sqlstr(uid(501)),sqlstr(ref),"'realtime.t04.accepted_user_activity.v1'",'1',
              "'realtime.outbox'",sqlstr(payload['activityId']),sqlstr(body),sqlstr(hashlib.sha256(body.encode()).hexdigest()),"'2026-10-27T00:00:00Z'"]
    if explicit_cursor is not None:
        fields.append('accepted_activity_cursor'); values.append(str(explicit_cursor))
    return int(pg.query('INSERT INTO outbox_events('+','.join(fields)+') VALUES('+','.join(values)+') RETURNING accepted_activity_cursor;'))


def use(stores, pg):
    node(stores, 'migrate-models'); node(stores, 'ack-models')
    rebind(pg)
    node(stores, 'live-use')
    payment = Path(stores.roots['owner'])/'central-storage/payment/payment.sqlite'
    import sqlite3
    with sqlite3.connect(payment) as db:
        db.execute("UPDATE policy SET version=2,auto_enabled=1,updated_at_ms=2")
        db.execute("INSERT INTO device_keys VALUES('live-device','device','owner','synthetic-new-public-key',2,NULL)")
        db.execute("INSERT INTO events(at_ms,principal_id,kind,actor,data,prev_hash,hash) VALUES(2,'owner','new-history','owner','{}','b','c')")
        db.execute("INSERT INTO meta VALUES('payment-context:live','new-history')")
    write(Path(stores.roots['hermes']), 'sessions/live.jsonl', 'new live conversation')
    write(Path(stores.roots['hermes']), 'skills/new-tool/SKILL.md', 'new installed keep tool')
    write(stores.directory/'drive', 'originals/2026-10-27/live.jpg', b'new live cold recording')
    pg.query("INSERT INTO paios_l3_versions VALUES('owner','live',1,'{\"schema\":\"l3.audit.v1\",\"status\":\"active\",\"applicability_status\":\"applicable\"}');")
    pg.query("INSERT INTO paios_l3_heads VALUES('owner','live',1); SELECT nextval('paios_l3_watermark');")
    return accepted(pg, 2)


def clear_files(stores):
    result = {}
    for row in inventory(stores.settings)['files']:
        if row['action'] not in ('clear', 'package_pins'):
            continue
        path = Path(stores.roots[row['root']])/row['path']
        for child in path.rglob('*') if path.is_dir() else [path]:
            if child.is_file():
                result[row['root']+'/'+str(child.relative_to(stores.roots[row['root']]))] = child.read_bytes()
    return result
