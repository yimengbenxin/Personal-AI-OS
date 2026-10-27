"""Unprivileged, Unix-socket-only PostgreSQL. Never uses an existing database or Docker daemon."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
from uuid import uuid4

import pytest
from data_reset_fixtures import ROOT
from data_reset_postgres import Postgres


def realtime(pg, mode, continuity=201):
    """Exercise the production T11B repository, using only this fixture's socket DB."""
    command = pg.commands['query']
    def option(flag):
        return command[command.index(flag)+1]
    options = dict(host=option('-h'), port=int(option('-p')), user=option('-U'), database=option('-d'))
    result = subprocess.run(['node', str(ROOT/'tests/hermes/data_reset_realtime.ts'), mode,
                             json.dumps(options), str(continuity)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def verify_realtime(pg):
    return realtime(pg, 'use')


def seed_pinned_baseline(pg):
    realtime(pg, 'seed')
    pg.query("""INSERT INTO apple_physical_canary_bindings(
        binding_id,request_id,idempotency_key,request_fingerprint_sha256,realtime_session_ref,session_ref_id,
        session_object_version,session_payload_sha256,iphone_device_lease_ref,iphone_lease_ref_id,
        iphone_lease_object_version,iphone_lease_payload_sha256,iphone_device_id,iphone_client_instance_id,
        watch_device_lease_ref,watch_lease_ref_id,watch_lease_object_version,watch_lease_payload_sha256,
        watch_device_id,watch_client_instance_id,issued_at,expires_at,object_version,receipt_jcs,canonical_payload_sha256)
        SELECT '00000000-0000-7000-8000-000000000001','synthetic-baseline','synthetic-baseline',repeat('a',64),
        s.realtime_session_ref,s.session_ref_id,s.session_object_version,s.session_payload_sha256,
        i.device_lease_ref,i.lease_ref_id,i.lease_object_version,i.lease_payload_sha256,i.device_id,
        '00000000-0000-7000-8000-000000000402',w.device_lease_ref,w.lease_ref_id,w.lease_object_version,
        w.lease_payload_sha256,w.device_id,'00000000-0000-7000-8000-000000000404',
        '2026-10-25T00:00:00Z','2099-01-01T00:00:00Z','1','{}',repeat('a',64)
        FROM realtime_sessions s JOIN device_leases i ON i.session_ref_id=s.session_ref_id
        JOIN device_leases w ON w.session_ref_id=s.session_ref_id
        WHERE i.lease_ref_id='00000000-0000-7000-8000-000000000301'
        AND w.lease_ref_id='00000000-0000-7000-8000-000000000302';""")


@pytest.fixture(scope='session')
def pg_server(tmp_path_factory):
    binary = os.environ.get('RQ102_PG_BIN')
    if not binary:
        pytest.skip('Set RQ102_PG_BIN for the real isolated PostgreSQL drill')
    binary = Path(binary)
    work = tmp_path_factory.mktemp('rq102-pg')
    data, socket = work / 'data', work / 'socket'
    socket.mkdir()
    shared = binary.parents[3] / 'share/postgresql' / binary.parent.name
    init = subprocess.run([str(binary/'initdb'), '-D', str(data), '-L', str(shared), '-A', 'trust', '-U', 'rq102',
                           '--encoding=UTF8', '--locale=C'], capture_output=True)
    assert init.returncode == 0, 'isolated initdb failed'
    control = [str(binary/'pg_ctl'), '-D', str(data)]
    options = "-F -h '' -k " + shlex.quote(str(socket)) + ' -p 6543'
    started = subprocess.run(control + ['-o', options, '-l', str(work/'postgres.log'), '-w', 'start'], capture_output=True)
    assert started.returncode == 0, 'isolated postgres start failed'
    try:
        yield binary, socket
    finally:
        subprocess.run(control + ['-m', 'immediate', '-w', 'stop'], capture_output=True, check=True)


@pytest.fixture
def postgres(pg_server):
    binary, socket = pg_server
    name = 'rq102_' + uuid4().hex
    common = ['-h', str(socket), '-p', '6543', '-U', 'rq102']
    subprocess.run([str(binary/'createdb'), *common, name], check=True, capture_output=True)
    args = [*common, '-d', name]
    pg = Postgres({'query':[str(binary/'psql'),'-XAt','--set','ON_ERROR_STOP=1',*args],
                   'dump':[str(binary/'pg_dump'),'-Fc','--no-owner','--no-acl',*args],
                   'restore':[str(binary/'pg_restore'),'--data-only','--single-transaction','--exit-on-error',
                              '--no-owner','--no-acl',*args]})
    try:
        pg.query('CREATE SCHEMA paios_migrations; CREATE TABLE paios_migrations.schema_migrations '
                 '(version integer PRIMARY KEY,name text NOT NULL,sha256 text NOT NULL,origin text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());')
        for path in sorted((ROOT/'01-product-half-finished/backend/migrations').glob('*.up.sql')):
            pg.query(path.read_text())
            number = int(path.name.split('_',1)[0])
            pg.query(f"INSERT INTO paios_migrations.schema_migrations(version,name,sha256,origin) VALUES({number},'{path.name}',"
                     f"'{hashlib.sha256(path.read_bytes()).hexdigest()}','synthetic-drill');")
        pg.query("INSERT INTO paired_devices(device_id,user_id,device_class,token_sha256,recipient_public_key,recipient_public_key_sha256,"
                 "device_credential_ref,media,governance,status,paired_at) VALUES('00000000-0000-4000-8000-000000000001',"
                 "'00000000-0000-4000-8000-000000000002','iphone',repeat('a',64),repeat('A',43),repeat('b',64),'{}',ARRAY['data'],'{}','active',now());")
        pg.query("INSERT INTO terminal_enrollments(token_sha256,phone_device_id,expires_at,device_class) VALUES(repeat('c',64),"
                 "'00000000-0000-4000-8000-000000000001',now()+interval '1 day','glasses');")
        seed_pinned_baseline(pg)
        for principal in ('owner','guest'):
            pg.query(f"INSERT INTO paios_l3_versions VALUES('{principal}','fact',1,"
                     "'{\"schema\":\"l3.audit.v1\",\"status\":\"active\",\"applicability_status\":\"applicable\"}');")
            pg.query(f"INSERT INTO paios_l3_heads VALUES('{principal}','fact',1);")
            pg.query(f"INSERT INTO paios_l3_payloads VALUES('{principal}','fact',1,"
                     "'{\"schema\":\"l3.assertion.v1\",\"text\":\"synthetic-private-history-marker\"}','{}');")
        yield pg
    finally:
        subprocess.run([str(binary/'dropdb'), *common, '--force', name], check=True, capture_output=True)
