"""Every durable payment cut layout and an intent-only restore survive process loss."""
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

import pytest

from test_data_reset_review import ROOT, payment, settings_at
from data_reset_live_fixture import export_old_engine
import data_reset
import data_reset_manifest as journal
from data_reset_inventory import inventory, keep_hashes
from data_reset_sqlite import companions, inventory as payment_inventory


@pytest.fixture(scope='module')
def old_payment_engine(tmp_path_factory):
    return export_old_engine(tmp_path_factory.mktemp('payment-legacy-engine'))


def cut_wal(path, meta_only):
    source = path.parent/'wal-source.sqlite'
    shutil.copyfile(path, source)
    with sqlite3.connect(source) as db:
        db.execute('PRAGMA journal_mode=WAL')
        if meta_only:
            db.execute("INSERT INTO meta VALUES('payment-context:payment-1:1:card_opened','cut-wal-only')")
        else:
            db.execute('UPDATE policy SET version=2')
            db.execute("INSERT INTO events(at_ms,principal_id,kind,actor,data,prev_hash,hash) "
                       "VALUES(1,'owner','cut-wal-only','owner','{}','a','b')")
        db.commit()
        shutil.copyfile(source, path)
        for old, new in zip(companions(source), companions(path)):
            shutil.copyfile(old, new)
    db.close()
    source.unlink()


CUT_CRASH = '''import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import data_reset,data_reset_quarantine as q,data_reset_manifest as journal
settings=json.loads(sys.argv[2]); payment=Path(sys.argv[3]); point=sys.argv[4]
rename,project,save=q.rename,q.retained_projection,journal.save
def stop_rename(source,target):
 rename(source,target)
 label=('db-moved' if Path(source)==payment else 'shm-moved' if str(source)==str(payment)+'-shm'
        else 'wal-moved' if str(source)==str(payment)+'-wal'
        else 'fresh-published' if Path(source).name=='.rq102-keep-payment.sqlite' else '')
 if point==label:os._exit(92)
def stop_project(*args,**kwargs):
 stage=project(*args,**kwargs)
 if point=='stage-built' and args[1]['action']=='payment':os._exit(92)
 return stage
def stop_save(path,row):
 save(path,row)
 for suffix,label in [('', 'db-journal'),('-shm','shm-journal'),('-wal','wal-journal')]:
  if point==label and any(e['original']==str(payment)+suffix and e['state']=='moved' for e in row['entries']):os._exit(92)
 if point=='completed' and row['state']=='quarantined':os._exit(92)
q.rename=stop_rename;q.retained_projection=stop_project;journal.save=stop_save
if point=='intent':q.resume=lambda *args,**kwargs:os._exit(92)
data_reset.run(settings,'quarantine')
'''


@pytest.mark.parametrize('engine', ['new','legacy'])
@pytest.mark.parametrize('meta_only', [True,False])
@pytest.mark.parametrize('point', ['intent','stage-built','db-moved','shm-moved','wal-moved',
                                   'fresh-published','shm-journal','wal-journal','db-journal','completed'])
def test_payment_cut_every_durable_window_rolls_back(tmp_path, old_payment_engine, engine, meta_only, point):
    settings = settings_at(tmp_path)
    path = payment(settings)
    cut_wal(path, meta_only)
    expected = payment_inventory(path, True)
    root = ROOT if engine == 'new' else old_payment_engine
    result = subprocess.run([sys.executable,'-c',CUT_CRASH,str(root/'deploy/cloud'),json.dumps(settings),
                             str(path),point],capture_output=True)
    assert result.returncode == 92, result.stderr.decode()
    receipt_path = next(Path(settings['state_dir']).glob('data-reset-*.json'))
    assert data_reset.run(settings,'rollback',receipt_path=str(receipt_path))['rollback_verified']
    assert payment_inventory(path, True) == expected
    assert all(not side.exists() for side in companions(path))
    assert journal.load(settings,receipt_path)['state'] == 'restored'


@pytest.mark.parametrize('engine', ['new','legacy'])
def test_intent_only_payment_publish_crash_finds_cut_in_displaced(tmp_path, old_payment_engine, engine):
    settings = settings_at(tmp_path)
    path = payment(settings)
    cut_wal(path, True)
    expected = payment_inventory(path, True)
    root = ROOT if engine == 'new' else old_payment_engine
    result = subprocess.run([sys.executable,'-c',CUT_CRASH,str(root/'deploy/cloud'),json.dumps(settings),
                             str(path),'intent'],capture_output=True)
    assert result.returncode == 92, result.stderr.decode()
    live_keep = keep_hashes(inventory(settings))
    receipt_path = next(Path(settings['state_dir']).glob('data-reset-*.json'))
    script = '''import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import data_reset,data_reset_restore as r
rename=r.rename
def crash(source,target):
 rename(source,target)
 if Path(source).name=='.rq102-restore-payment.sqlite':os._exit(97)
r.rename=crash
data_reset.run(json.loads(sys.argv[2]),'rollback',receipt_path=sys.argv[3])
'''
    first = subprocess.run([sys.executable,'-c',script,str(ROOT/'deploy/cloud'),json.dumps(settings),
                            str(receipt_path)],capture_output=True)
    assert first.returncode == 97, first.stderr.decode()
    receipt = journal.load(settings,receipt_path)
    entry = next(e for e in receipt['entries'] if e['action'] == 'payment')
    assert any(row['original'] == str(path) and Path(row['quarantine']).stat().st_ino == entry['inode']
               for row in receipt['displaced'])
    assert data_reset.run(settings,'rollback',receipt_path=str(receipt_path))['rollback_verified']
    assert payment_inventory(path, True) == expected
    assert keep_hashes(inventory(settings)) == live_keep
