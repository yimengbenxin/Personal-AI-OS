"""Independent-review reproductions: isolated cuts, no-move refusals and power-loss recovery."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deploy/cloud'))
import data_reset
import data_reset_manifest as journal
import data_reset_restore as restoring
from data_reset_inventory import additional_bytes, inventory, keep_hashes
from data_reset_policy import RESET_ID
from data_reset_sqlite import companions, connect


def settings_at(base):
    roots = {name:str(base/name) for name in ('owner','hermes','errands','secrets')}
    for root in roots.values():
        Path(root).mkdir()
    (base/'state').mkdir()
    (base/'hermes/MEMORY.md').write_text('cut history')
    return dict(id=RESET_ID,roots=roots,state_dir=str(base/'state'),
        capacity={'reserve_bytes':1024**3,'reserve_inodes':100000,'margin_bytes':2*1024**3},voice_command=[
        'node',str(ROOT/'01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts')])


def payment(settings):
    path = Path(settings['roots']['owner'])/'central-storage/payment/payment.sqlite'
    path.parent.mkdir(parents=True,exist_ok=True)
    ddl = (ROOT/'01-product-half-finished/backend/services/personal-aios-integration/src/payment/store.ts').read_text().split('const DDL=`',1)[1].split('`;',1)[0]
    with sqlite3.connect(path) as db:
        db.executescript(ddl)
        db.execute("INSERT INTO meta VALUES('schema','paios.payment-store.v1')")
        db.execute("INSERT INTO meta VALUES('environment','production')")
        db.execute("INSERT INTO policy VALUES('owner',1,1,0,'{}',NULL,1)")
    return path


@pytest.mark.parametrize('tree',[False,True])
def test_keep_edit_cannot_change_isolated_cut_history(tmp_path,tree):
    settings = settings_at(tmp_path)
    kept = tmp_path/'hermes/skills/tool.py'
    kept.parent.mkdir(); kept.write_bytes(b'old history')
    clear = tmp_path/('owner/history/tree.bin' if tree else 'owner/history.bin')
    clear.parent.mkdir(exist_ok=True)
    os.link(kept,clear)
    keep_inode = kept.stat().st_ino
    plan = inventory(settings)
    assert additional_bytes(plan) == {clear.stat().st_dev: len(b'old history')}
    cut = data_reset.run(settings,'quarantine')
    receipt = journal.load(settings,cut['receipt'])
    copy = receipt['hardlink_copies'][str(clear)]
    saved = Path(copy['quarantine'])
    assert saved.stat().st_ino != keep_inode and copy['sha256']
    assert kept.stat().st_ino == keep_inode and not clear.exists()
    kept.write_bytes(b'new setting')
    assert saved.read_bytes() == b'old history'
    data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert clear.read_bytes() == b'old history' and kept.read_bytes() == b'new setting'
    assert clear.stat().st_ino != kept.stat().st_ino


def test_changed_isolated_copy_refuses_before_first_move(tmp_path):
    settings = settings_at(tmp_path)
    kept = tmp_path/'hermes/skills/tool.py'
    kept.parent.mkdir(); kept.write_bytes(b'old history')
    os.link(kept,tmp_path/'owner/history.bin')
    cut = data_reset.run(settings,'quarantine')
    receipt = journal.load(settings,cut['receipt'])
    saved = Path(next(iter(receipt['hardlink_copies'].values()))['quarantine'])
    saved.write_bytes(b'bad history')
    with pytest.raises(ValueError,match='^RESET_QUARANTINE_CONTENT_CHANGED$'):
        data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert journal.load(settings,cut['receipt'])['state'] == 'quarantined'


def test_unmergeable_payment_can_start_retry_and_capture_a_new_live_baseline(tmp_path):
    from release_data_reset import guard_start
    from types import SimpleNamespace
    settings = settings_at(tmp_path)
    settings['state_dir'] = str(tmp_path/'data-reset')
    path = payment(settings)
    cut = data_reset.run(settings,'quarantine')
    with sqlite3.connect(path) as db:
        db.execute('ALTER TABLE policy ADD COLUMN incompatible TEXT')
        db.execute('UPDATE policy SET version=2')
    host = SimpleNamespace(config={'data_reset':{}},lock_path=lambda:tmp_path/'release.lock')
    for _ in range(2):
        with pytest.raises(ValueError,match='^RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT$'):
            data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
        row = journal.load(settings,cut['receipt'])
        assert row['state'] == 'quarantined' and not row['displaced'] and 'rollback_keep' not in row
        guard_start(host)
    with sqlite3.connect(path) as db:
        db.execute('ALTER TABLE policy DROP COLUMN incompatible')
        db.execute('UPDATE policy SET version=3')
    live = keep_hashes(inventory(settings))
    assert data_reset.run(settings,'rollback',receipt_path=cut['receipt'])['rollback_verified']
    assert keep_hashes(inventory(settings)) == live


def wal_cut(path):
    source = path.parent/'wal-source.sqlite'
    shutil.copyfile(path,source)
    db = sqlite3.connect(source)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('UPDATE policy SET version=2')
        db.execute("INSERT INTO events(at_ms,principal_id,kind,actor,data,prev_hash,hash) VALUES(1,'owner','cut','owner','{}','a','b')")
        db.commit()
        shutil.copyfile(source,path)
        for old,new in zip(companions(source),companions(path)):
            shutil.copyfile(old,new)
    finally:
        db.close(); source.unlink()


def test_payment_reuse_wal_case_publishes_one_checkpointed_db_and_resumes(tmp_path):
    settings = settings_at(tmp_path)
    path = payment(settings)
    wal_cut(path)
    cut = data_reset.run(settings,'quarantine')
    live = keep_hashes(inventory(settings))
    rename = restoring.rename
    def crash(source,target):
        rename(source,target)
        if Path(target) == path:
            raise KeyboardInterrupt('published checkpoint, before journal')
    with patch.object(restoring,'rename',crash),pytest.raises(KeyboardInterrupt):
        data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    with sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True) as db:
        assert db.execute('SELECT version FROM policy').fetchone() == (2,)
        assert db.execute('SELECT kind FROM events').fetchall() == [('cut',)]
    assert all(not side.exists() for side in companions(path))
    assert data_reset.run(settings,'rollback',receipt_path=cut['receipt'])['rollback_verified']
    assert keep_hashes(inventory(settings)) == live


@pytest.mark.parametrize('action',['quarantine','rollback'])
def test_power_loss_inside_payment_scratch_then_plain_retry_completes(tmp_path,action):
    settings = settings_at(tmp_path)
    path = payment(settings)
    cut = data_reset.run(settings,'quarantine') if action == 'rollback' else None
    if cut:
        with sqlite3.connect(path) as db:
            db.execute('UPDATE policy SET version=2')
    script = '''import json,os,sqlite3,sys
sys.path.insert(0,sys.argv[1])
import data_reset
original=sqlite3.connect
def crash(path,*args,**kwargs):
 db=original(path,*args,**kwargs)
 if str(path).endswith('/.reset-payment.sqlite'):os._exit(91)
 return db
sqlite3.connect=crash
data_reset.run(json.loads(sys.argv[2]),sys.argv[3],receipt_path=sys.argv[4] or None)
'''
    process = subprocess.run([sys.executable,'-c',script,str(ROOT/'deploy/cloud'),json.dumps(settings),action,
                              cut['receipt'] if cut else ''],capture_output=True)
    assert process.returncode == 91,process.stderr.decode()
    assert (path.parent/'.reset-payment.sqlite').exists()
    result = data_reset.run(settings,action,receipt_path=cut['receipt'] if cut else None)
    assert result['state'] == ('restored' if cut else 'quarantined')
    assert not (path.parent/'.reset-payment.sqlite').exists()
    with connect(path) as db:
        assert db.execute('SELECT version FROM policy').fetchone() == (2 if cut else 1,)


@pytest.mark.parametrize('tree',[False,True])
def test_pending_hardlink_copy_can_rollback_directly_after_power_loss(tmp_path,tree):
    settings = settings_at(tmp_path)
    kept = tmp_path/'hermes/skills/tool.py'
    kept.parent.mkdir(); kept.write_bytes(b'old history')
    clear = tmp_path/('owner/history/tree.bin' if tree else 'owner/history.bin')
    clear.parent.mkdir(exist_ok=True); os.link(kept,clear)
    script = '''import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import data_reset
replace=os.replace
def crash(source,target):
 if Path(source).parent.name=='_hardlink-copies':os._exit(93)
 return replace(source,target)
os.replace=crash
data_reset.run(json.loads(sys.argv[2]),'quarantine')
'''
    result = subprocess.run([sys.executable,'-c',script,str(ROOT/'deploy/cloud'),json.dumps(settings)],capture_output=True)
    assert result.returncode == 93,result.stderr.decode()
    receipt = next(Path(settings['state_dir']).glob('data-reset-*.json'))
    assert data_reset.run(settings,'rollback',receipt_path=str(receipt))['rollback_verified']
    assert clear.read_bytes() == b'old history'
    assert clear.stat().st_ino != kept.stat().st_ino


def test_actual_78d_restore_receipt_before_first_move_is_compatible(tmp_path):
    from data_reset_live_fixture import export_old_engine
    settings = settings_at(tmp_path)
    engine = export_old_engine(tmp_path/'old-engine')
    script = '''import json,os,sys
sys.path.insert(0,sys.argv[1])
import data_reset,data_reset_manifest as journal
settings=json.loads(sys.argv[2])
cut=data_reset.run(settings,'quarantine')
save=journal.save
def crash(path,row):
 save(path,row)
 if row['state']=='restoring':os._exit(94)
journal.save=crash
data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
'''
    result = subprocess.run([sys.executable,'-c',script,str(engine/'deploy/cloud'),json.dumps(settings)],capture_output=True)
    assert result.returncode == 94,result.stderr.decode()
    receipt = next(Path(settings['state_dir']).glob('data-reset-*.json'))
    old = journal.load(settings,receipt)
    assert old['state'] == 'restoring' and 'rollback_from' not in old
    assert data_reset.run(settings,'rollback',receipt_path=str(receipt))['rollback_verified']


def test_scratch_cleanup_preserves_a_referenced_cut_inode(tmp_path):
    settings = settings_at(tmp_path)
    path = payment(settings)
    cut = data_reset.run(settings,'quarantine')
    row = journal.load(settings,cut['receipt'])
    entry = next(e for e in row['entries'] if e['action'] == 'payment')
    stage = path.with_name('.rq102-restore-'+path.name)
    shutil.copyfile(path,stage)
    info = stage.stat()
    entry['rollback_stage'] = {'path':str(stage),'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'files':1}
    row.update(state='restoring',rollback_from='quarantined',rollback_started=True)
    journal.save(cut['receipt'],row)
    scratch = path.parent/'.reset-payment.sqlite'
    Path(entry['quarantine']).rename(scratch)
    with pytest.raises(ValueError,match='^RESET_SQLITE_SCRATCH_PUBLISHED$'):
        data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert scratch.exists() and scratch.stat().st_ino == entry['inode']


def test_cancelled_preflight_keeps_completed_cut_copy_metadata(tmp_path):
    settings = settings_at(tmp_path)
    path = payment(settings)
    kept = tmp_path/'hermes/skills/tool.py'
    kept.parent.mkdir(); kept.write_bytes(b'old history')
    os.link(kept,tmp_path/'owner/history.bin')
    script = '''import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import data_reset,data_reset_quarantine as q
rename=q.rename
def crash(source,target):
 rename(source,target)
 if Path(target).name=='history.bin':os._exit(95)
q.rename=crash
data_reset.run(json.loads(sys.argv[2]),'quarantine')
'''
    result = subprocess.run([sys.executable,'-c',script,str(ROOT/'deploy/cloud'),json.dumps(settings)],capture_output=True)
    assert result.returncode == 95,result.stderr.decode()
    receipt = next(Path(settings['state_dir']).glob('data-reset-*.json'))
    assert journal.load(settings,receipt)['hardlink_copies'] == {}
    with sqlite3.connect(path) as db:
        db.execute('ALTER TABLE policy ADD COLUMN incompatible TEXT')
    with pytest.raises(ValueError,match='^RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT$'):
        data_reset.run(settings,'rollback',receipt_path=str(receipt))
    row = journal.load(settings,receipt)
    assert row['state'] == 'quarantining' and row['hardlink_copies']
    with sqlite3.connect(path) as db:
        db.execute('ALTER TABLE policy DROP COLUMN incompatible')
    assert data_reset.run(settings,'rollback',receipt_path=str(receipt))['rollback_verified']


def test_failed_first_move_after_untouched_cut_entries_returns_to_quarantining(tmp_path):
    settings = settings_at(tmp_path)
    payment(settings)
    receipt, row = journal.prepare(settings,inventory(settings))
    with patch.object(restoring,'rename',side_effect=PermissionError('before first move')):
        with pytest.raises(PermissionError):
            data_reset.run(settings,'rollback',receipt_path=str(receipt))
    after = journal.load(settings,receipt)
    assert after['state'] == 'quarantining' and 'rollback_keep' not in after
