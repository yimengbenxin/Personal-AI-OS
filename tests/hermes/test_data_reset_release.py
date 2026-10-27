"""Run the product command with the real release lock/start/stop and synthetic store transports."""
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from data_reset_fixtures import Stores
from data_reset_pg_fixture import pg_server, postgres
import data_reset_manifest as journal
import data_reset_retention as retention
import release
import release_data_reset


def test_product_plan_is_count_only_and_does_not_change_product_stores(tmp_path,monkeypatch,capsys):
    from data_reset_inventory import inventory
    stores=Stores(tmp_path)
    state=tmp_path/'release-state';state.mkdir()
    host=release.Host({'root':str(tmp_path),'stage':'production','data_reset':stores.settings})
    host.state=state
    monkeypatch.setattr(host,'release',lambda name:tmp_path)
    monkeypatch.setattr(release_data_reset.data_reset_host,'context',lambda *a:(stores.settings,None,stores.cold))
    before=inventory(stores.settings,cold=stores.cold)['preimage']
    release_data_reset.command(host,SimpleNamespace(action='plan',receipt=None))
    output=capsys.readouterr().out;result=json.loads(output)
    assert 'synthetic-private-history-marker' not in output and 'synthetic-credential-never-print' not in output
    assert 'sha256' not in output and result['quarantine']['owner']
    assert Path(result['retention_entrypoint']).is_file()
    assert inventory(stores.settings,cold=stores.cold)['preimage']==before


def test_expiry_cli_survives_an_old_release_pointer_and_source_pruning(tmp_path,monkeypatch):
    import os
    import shutil
    import subprocess
    import sys
    from data_reset_fixtures import ROOT
    import release_data_reset_runtime as runtime
    candidate=tmp_path/'candidate'
    (candidate/'deploy/cloud').mkdir(parents=True)
    for source in (ROOT/'deploy/cloud').glob('*.py'):
        if not source.name.startswith('test_'):
            shutil.copyfile(source,candidate/'deploy/cloud'/source.name)
    status=candidate/'integrations/hermes/personal_aios/release_status.py'
    status.parent.mkdir(parents=True)
    shutil.copyfile(ROOT/'integrations/hermes/personal_aios/release_status.py',status)
    state=tmp_path/'state';state.mkdir()
    with monkeypatch.context() as patch:
        patch.setattr(runtime,'__file__',str(candidate/'deploy/cloud/release_data_reset_runtime.py'))
        entry=Path(runtime.prepare(SimpleNamespace(lock_path=lambda:state/'release.lock')))
    shutil.rmtree(candidate)
    host_root=tmp_path/'host';old=host_root/'releases/old'
    (old/'.release').mkdir(parents=True)
    (old/'deploy/cloud').mkdir(parents=True)
    (old/'.release/env').write_text('')
    (old/'deploy/cloud/compose.yaml').write_text('services: {}')
    (old/'deploy/cloud/release.py').write_text('raise RuntimeError("old CLI has no reset command")')
    (host_root/'current').symlink_to(old)
    fake=tmp_path/'bin';fake.mkdir()
    definition={'services':{'release-watchdog':{'volumes':[{'source':str(state),'target':'/watchdog'}]}}}
    docker=fake/'docker'
    docker.write_text('#!/usr/bin/env python3\nimport sys\nassert "config" in sys.argv\nprint('+repr(json.dumps(definition))+')\n')
    docker.chmod(0o700)
    directory=tmp_path/'stores';directory.mkdir()
    stores=Stores(directory); stores.settings['state_dir']=str(state/'data-reset')
    result=release_data_reset.data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    manifest=Path(result['receipt']); row=json.loads(manifest.read_text()); row['expires_at']=1; journal.save(manifest,row)
    config=tmp_path/'release.json'
    config.write_text(json.dumps({'root':str(host_root),'stage':'production','project':'synthetic','profiles':[],
        'data_reset':{'id':'RQ-102-N15'}}))
    result=subprocess.run([sys.executable,str(entry),'--config',str(config),'data-reset','expire'],capture_output=True,
        env={**os.environ,'PYTHONPATH':'','PATH':str(fake)+os.pathsep+os.environ['PATH']})
    assert result.returncode==0,'retained release CLI failed'
    assert json.loads(result.stdout)=={'expired_quarantines':1,'pending_quarantines':0}
    assert json.loads(manifest.read_text())['state']=='expired'
    assert all(not (Path(b['path'])/'RQ-102-N15').exists() for b in row['storage'])
    service=(ROOT/'deploy/cloud/paios-data-reset-expire.service').read_text()
    timer=(ROOT/'deploy/cloud/paios-data-reset-expire.timer').read_text()
    assert '${PAIOS_RELEASE_ENTRYPOINT}' in service and 'data-reset expire' in service
    assert 'Persistent=true' in timer and 'OnCalendar=*-*-* *:*:00' in timer
    assert not result.stderr
    assert ROOT not in entry.parents and entry.is_file()


@pytest.fixture
def product_command(tmp_path, monkeypatch, postgres):
    stores = Stores(tmp_path)
    state = tmp_path/'release-state'; state.mkdir()
    stores.settings['state_dir'] = str(state/'data-reset')
    Path(stores.settings['state_dir']).mkdir()
    services = {'gateway':{},'hermes':{'depends_on':{'gateway':{}}},'workshop':{},'workshop-link':{},'postgres':{},'livekit':{},'release-watchdog':{}}
    calls, active = [], {'gateway','hermes','workshop','workshop-link','postgres','release-watchdog'}
    def run(args, **options):
        calls.append(args)
        if args[0] == 'stop':
            active.difference_update(args)
        if args[0] == 'up':
            active.update(set(args)&services.keys())
        if args[:4] == ['ps','--status','running','--services']:
            return SimpleNamespace(stdout=' '.join(active))
        if args[:2] == ['ps','-aq']:
            return SimpleNamespace(stdout='')
        return SimpleNamespace(stdout='')
    @contextmanager
    def locked():
        with (state/'release.lock').open('a') as stream:
            fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
            yield stream
    host = SimpleNamespace(config={'profiles':[],'data_reset':stores.settings},suffix='',stage='production',
        release=lambda name:tmp_path,runner=lambda path:run,definition=lambda path:{'services':services},
        lock_path=lambda:state/'release.lock',locked=locked)
    def context(*args):
        assert not {'gateway','hermes','workshop','workshop-link'}&active
        assert 'release-watchdog' not in active
        assert any('migrate' in call for call in calls)
        calls.append(['reset'])
        return stores.settings,postgres,stores.cold
    monkeypatch.setattr(release_data_reset.data_reset_host,'context',context)
    monkeypatch.setattr(release.release_checks,'drain',lambda *a:{'passed':True})
    monkeypatch.setattr(release.release_checks,'wait_health',lambda *a:{})
    monkeypatch.setattr(release.release_checks,'native_ready',lambda *a:{'official_native_ready':True})
    monkeypatch.setattr(release.release_checks,'postcheck',lambda *a,**kw:{'passed':True})
    return stores,host,calls,active


@pytest.mark.parametrize('owner_rollback',[False,True])
def test_product_command_orders_stop_migrate_quarantine_verify_start_and_rollback(tmp_path,monkeypatch,capsys,owner_rollback,product_command):
    stores,host,calls,active = product_command
    release_data_reset.command(host,SimpleNamespace(action='quarantine',receipt=None,operator_apply_rq102=True))
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result['state'] == 'quarantined' and result['verification']['keep_verified']
    assert 'synthetic-private-history-marker' not in output and 'AGE-SECRET-KEY' not in output
    stop = next(n for n,c in enumerate(calls) if c[0]=='stop')
    migrate = next(n for n,c in enumerate(calls) if 'migrate' in c)
    reset = calls.index(['reset'])
    start = next(n for n,c in enumerate(calls) if c[0]=='up' and 'gateway' in c)
    assert stop < migrate < reset < start
    assert 'release-watchdog' in active
    if owner_rollback:
        old=tmp_path/'previous'; old.mkdir()
        host.root=tmp_path
        host.event=lambda *a,**kw:None
        host.release=lambda name:tmp_path if name=='current' else old
        monkeypatch.setattr(release.release_migrations,'project_rollback',lambda *a:calls.append(['project']))
        monkeypatch.setattr(release,'point',lambda *a:calls.append(['point']))
        monkeypatch.setattr(release,'restore_front',lambda *a:{})
        monkeypatch.setattr(release,'retire_newer_transport',lambda *a:{})
        monkeypatch.setattr(release.release_build,'write',lambda *a:None)
        assert release_data_reset.rollback_cut(host,old) is None
        restored=release.rollback(host,'owner_request')['data_reset']
        assert restored['inode_counts_verified']
        assert calls.index(['project']) < calls.index(['point'])
        assert release_data_reset.rollback_cut(host,tmp_path) is None
    else:
        release_data_reset.command(host,SimpleNamespace(action='rollback',receipt=result['receipt']))
        assert json.loads(capsys.readouterr().out)['inode_counts_verified']
    assert {'gateway','hermes'} <= active


@pytest.mark.parametrize('kind,code', [('payment','RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT'),
    ('postgres','RESET_POSTGRES_CONFLICT_MIXED_PUBLIC_REALTIME_SESSIONS_23505')])
def test_product_cli_precise_preflight_refusal_keeps_both_starts_available(product_command,postgres,capsys,kind,code):
    import sqlite3
    from data_reset_live_fixture import rebind
    stores,host,calls,active = product_command
    release_data_reset.command(host,SimpleNamespace(action='quarantine',receipt=None,operator_apply_rq102=True))
    cut = json.loads(capsys.readouterr().out)
    if kind == 'payment':
        with sqlite3.connect(Path(stores.roots['owner'])/'central-storage/payment/payment.sqlite') as db:
            db.execute('UPDATE policy SET version=2')
            db.execute('ALTER TABLE policy ADD COLUMN incompatible TEXT')
    else:
        rebind(postgres,continuity=202)
    with pytest.raises(RuntimeError,match='^'+code+'$'):
        release_data_reset.command(host,SimpleNamespace(action='rollback',receipt=cut['receipt']))
    row = journal.load(stores.settings,cut['receipt'])
    assert row['state'] == 'quarantined' and not row['displaced']
    assert {'gateway','hermes','release-watchdog'} <= active
    release_data_reset.guard_start(host)
    with pytest.raises(RuntimeError,match='^'+code+'$'):
        release_data_reset.command(host,SimpleNamespace(action='rollback',receipt=cut['receipt']))
    assert journal.load(stores.settings,cut['receipt'])['state'] == 'quarantined'


def test_expiry_never_removes_an_unfinished_recovery_fence(tmp_path):
    stores=Stores(tmp_path)
    stores.settings['state_dir']=str(tmp_path/'data-reset')
    from data_reset_inventory import inventory
    path,row=journal.prepare(stores.settings,inventory(stores.settings,cold=stores.cold),stores.cold)
    scratch=Path(stores.settings['state_dir'])/'.inspection-orphan'; scratch.mkdir()
    (scratch/'state.db').write_bytes(b'synthetic private scratch')
    assert retention.expire(stores.settings,at=row['expires_at']+1)['pending_quarantines']==1
    assert not scratch.exists() and json.loads(path.read_text())['state']=='quarantining'
    host=SimpleNamespace(config={'data_reset':{}},lock_path=lambda:tmp_path/'release.lock')
    with pytest.raises(ValueError,match='RECOVERY_REQUIRED'):
        release_data_reset.guard_start(host)


def test_operator_apply_flag_is_required_before_stop(tmp_path,monkeypatch):
    stores=Stores(tmp_path)
    host=release.Host({'root':str(tmp_path),'stage':'production','data_reset':stores.settings})
    monkeypatch.setattr(host,'release',lambda name:tmp_path)
    with pytest.raises(RuntimeError,match='OPERATOR_FLAG_REQUIRED'):
        release_data_reset.command(host,SimpleNamespace(action='quarantine',receipt=None))


def test_product_recovery_recreates_a_mountpoint_lost_after_atomic_rename(tmp_path):
    from data_reset_inventory import inventory
    from data_reset_quarantine import rename
    stores=Stores(tmp_path); stores.settings['state_dir']=str(tmp_path/'data-reset')
    path,row=journal.prepare(stores.settings,inventory(stores.settings,cold=stores.cold),stores.cold)
    entry=next(r for r in row['entries'] if r['root']=='core')
    rename(entry['original'],entry['quarantine'])
    assert not Path(entry['original']).exists()
    host=SimpleNamespace(lock_path=lambda:tmp_path/'release.lock')
    release_data_reset.recover_mountpoints(host)
    assert Path(entry['original']).is_dir() and not list(Path(entry['original']).iterdir())
    result=release_data_reset.data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    assert result['verification']['manifest_complete']
    restored=release_data_reset.data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=str(path))
    assert restored['inode_counts_verified']
