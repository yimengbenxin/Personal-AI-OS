"""RQ-102 drill: cut history, live authorities, interruptions and expiry; no production endpoints."""
import json
import os
from pathlib import Path
import shutil
import tempfile
from unittest.mock import patch

import pytest
from data_reset_fixtures import Stores, write
from data_reset_pg_fixture import pg_server, postgres
import data_reset
import data_reset_manifest as journal
import data_reset_quarantine as moving
import data_reset_retention as retention
from data_reset_inventory import clear_hash, inventory, keep_hashes, public_plan, voice
from data_reset_layout import matches
from data_reset_policy import EPOCH_PATH, GUARD, TTL, VOICE_KEY
from data_reset_sqlite import connect, quote


@pytest.fixture
def stores(tmp_path):
    return Stores(tmp_path)


def snapshot(stores):
    result = {}
    for role, path in stores.roots.items():
        root = Path(path)
        for file in root.rglob('*'):
            relative = str(file.relative_to(root))
            if not file.is_file() or file.is_symlink() or relative == EPOCH_PATH:
                continue
            if role == 'owner' and relative == 'central-storage/voiceprints/'+VOICE_KEY:
                state = voice(file,stores.settings)
                value = {key:state[key] for key in ('counts','settings_sha256','clear_sha256')}
                value['owner_sha256'] = state['metadata']['owner_sha256']
            elif role == 'owner' and relative == 'central-storage/payment/payment.sqlite':
                with connect(file) as db:
                    schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
                    rows = {name:sorted(db.execute('SELECT * FROM '+quote(name)).fetchall(),key=repr)
                            for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
                    value = {'schema':schema,'rows':rows}
            elif role == 'owner' and relative in ('central-storage/payment/payment.sqlite-wal','central-storage/payment/payment.sqlite-shm'):
                continue  # The payment snapshot includes committed WAL rows, independent of checkpoint layout.
            else:
                value = file.read_bytes()
            result[role+'/'+relative] = value
    return result


def test_cycle_keeps_every_setting_and_restores_cut_history(stores, postgres):
    original = snapshot(stores)
    before = data_reset.run(stores.settings,'plan',postgres,stores.cold)
    result = data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    receipt = journal.load(stores.settings,result['receipt'])
    assert all(e['action']!='control' for e in receipt['entries'])
    assert json.loads((Path(stores.roots['owner'])/EPOCH_PATH).read_text())!='0'*32
    assert result['verification']['manifest_complete'] and result['verification']['keep_verified']
    assert keep_hashes(before) == keep_hashes(inventory(stores.settings,postgres,stores.cold))
    assert all(matches(e['quarantine'],e) for e in receipt['entries'])
    assert stores.node(True) == {'owner_enrolled':True,'samples':5}
    pinned = {r['table']:r for r in inventory(stores.settings,postgres,stores.cold)['postgres']}
    assert pinned['public.apple_physical_canary_bindings']['keep_rows']==1
    assert pinned['public.realtime_sessions']['keep_rows']==1 and pinned['public.device_leases']['keep_rows']==2
    assert result['expires_at']-receipt['quarantined_at']==TTL
    output = json.dumps(public_plan(before))
    assert 'sha256' not in output and 'synthetic-credential-never-print' not in output
    assert before['hardlink_pairs'] and all(v is None or '.rq102-quarantine' in v for v in before['quarantine'].values())
    assert data_reset.run(stores.settings,'verify',postgres,stores.cold,result['receipt'])['clear_verified']
    live = inventory(stores.settings,postgres,stores.cold)
    live_keep = keep_hashes(live)
    voice_revisions = {r['root']+'/'+r['path']:r['voiceprint']['metadata']['revision']
                       for r in live['files'] if r['action'] == 'voiceprint'}
    cut_revisions = {r['root']+'/'+r['path']:r['voiceprint']['metadata']['revision']
                      for r in before['files'] if r['action'] == 'voiceprint'}
    cut_clear = {r['root']+'/'+r['path']:clear_hash(r) for r in before['files'] if r['action'] in moving.MIXED}
    restored = data_reset.run(stores.settings,'rollback',postgres,stores.cold,result['receipt'])
    assert restored['inode_counts_verified'] and snapshot(stores)==original
    receipt = journal.load(stores.settings,result['receipt'])
    assert all(matches(e['original'],e.get('rollback_stage',e)) for e in receipt['entries'])
    after = inventory(stores.settings,postgres,stores.cold)
    assert keep_hashes(after) == live_keep
    for row in after['files']:
        if row['action'] == 'voiceprint':
            key = row['root']+'/'+row['path']
            assert row['voiceprint']['metadata']['revision'] == max(cut_revisions[key],voice_revisions[key])+1
    assert {r['root']+'/'+r['path']:clear_hash(r) for r in after['files'] if r['action'] in moving.MIXED} == cut_clear
    assert retention.expire(stores.settings,at=result['expires_at']+1)=={'expired_quarantines':1,'pending_quarantines':0}
    assert snapshot(stores)==original
    if destination := os.environ.get('RQ102_EVIDENCE_DIR'):
        folder=Path(destination); folder.mkdir(parents=True,exist_ok=True)
        (folder/'synthetic-plan.json').write_text(json.dumps(public_plan(before),indent=2))
        (folder/'synthetic-result.json').write_text(json.dumps({'synthetic_only':True,'retained_bytes':before['source_bytes'],
            'pg_dump_bytes':result['pg_dump_bytes'],'expires_in_seconds':TTL,'keep_objects':receipt['verification']['keep_objects'],
            'keep_sha256':receipt['verification']['keep_sha256'],'quarantine_verified':True,'rollback_verified':True,
            'expiry_verified':True,'original_roots':len(receipt['entries'])},indent=2))


def test_hardlinks_across_clear_and_keep_are_isolated_before_expiry(stores):
    kept=Path(stores.roots['hermes'])/'skills/hardlink.txt'; info=kept.stat()
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    receipt=journal.load(stores.settings,result['receipt'])
    shared=next(e for e in receipt['entries'] if e['path']=='central-storage/stream-revisions')
    for name in ('shared','clear-twin'):
        saved = Path(shared['quarantine'])/name
        assert saved.stat().st_ino != info.st_ino and saved.stat().st_nlink == 1
        assert saved.read_bytes() == kept.read_bytes() == b'synthetic shared inode'
    assert kept.stat().st_ino == info.st_ino and kept.stat().st_nlink == 1
    retention.expire(stores.settings,at=result['expires_at']+1)
    assert kept.stat().st_ino==info.st_ino and kept.read_bytes()==b'synthetic shared inode'
    assert kept.stat().st_nlink==1


def test_cross_filesystem_target_is_refused_without_copying_or_mutation(stores):
    original=snapshot(stores)
    with tempfile.TemporaryDirectory(prefix='rq102-cross-device-',dir=os.environ.get('RQ102_CROSS_DEVICE_DIR', '/dev/shm')) as directory:
        assert Path(directory).stat().st_dev != Path(stores.roots['owner']).stat().st_dev
        stores.settings['quarantine_parents']={'owner':directory}
        with pytest.raises(ValueError,match='CROSS_FILESYSTEM'):
            data_reset.run(stores.settings,'plan',cold=stores.cold)
        with pytest.raises(ValueError,match='CROSS_FILESYSTEM'):
            moving.rename(Path(stores.roots['errands'])/'job.done',Path(directory)/'no-copy')
        assert not list(Path(directory).iterdir())
    assert snapshot(stores)==original


@pytest.mark.parametrize('stop_at', [1, 3])
def test_interruption_after_rename_before_journal_update_resumes(stores, stop_at):
    original=snapshot(stores); rename=moving.rename; calls=[]
    def interrupted(source,target):
        rename(source,target); calls.append(target)
        if len(calls)==stop_at:
            raise KeyboardInterrupt('synthetic power loss after rename')
    with patch.object(moving,'rename',interrupted):
        with pytest.raises(KeyboardInterrupt):
            data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    path=next(Path(stores.settings['state_dir']).glob('data-reset-*.json'))
    assert json.loads(path.read_text())['state']=='quarantining'
    assert retention.expire(stores.settings,at=10**12)=={'expired_quarantines':0,'pending_quarantines':1}
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    assert result['state']=='quarantined'
    data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=result['receipt'])
    assert snapshot(stores)==original


def test_interrupted_cold_move_rolls_back_with_the_original_mixed_file(stores,postgres):
    original=snapshot(stores); move=stores.cold.move
    def interrupted(source,target):
        move(source,target); raise KeyboardInterrupt('synthetic interrupted MOVE reply')
    with patch.object(stores.cold,'move',interrupted):
        with pytest.raises(KeyboardInterrupt):
            data_reset.run(stores.settings,'quarantine',postgres,stores.cold)
    path=next(Path(stores.settings['state_dir']).glob('data-reset-*.json'))
    result=data_reset.run(stores.settings,'rollback',postgres,stores.cold,str(path))
    assert result['rollback_verified'] and snapshot(stores)==original
    assert stores.node(True)['owner_enrolled']


def test_keep_drift_blocks_prestart_verify_but_is_preserved_by_rollback(stores):
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    write(Path(stores.roots['hermes']),'skills/tool/SKILL.md',b'changed synthetic setting')
    with pytest.raises(ValueError,match='KEEP_HASH_CHANGED'):
        data_reset.run(stores.settings,'verify',cold=stores.cold,receipt_path=result['receipt'])
    assert data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=result['receipt'])['rollback_verified']
    assert (Path(stores.roots['hermes'])/'skills/tool/SKILL.md').read_bytes() == b'changed synthetic setting'


def test_manifest_must_cover_every_root_before_any_rollback(stores):
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    path=Path(result['receipt']); row=json.loads(path.read_text()); row['entries'].pop(); journal.save(path,row)
    with pytest.raises(ValueError,match='MANIFEST_INCOMPLETE'):
        data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=str(path))


def test_expiry_missing_mount_stays_pending_and_retries(stores):
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    row=journal.load(stores.settings,result['receipt']); base=Path(row['storage'][0]['path'])
    marker=base/'.rq102-storage-id'; detached=base/'.detached-id'; marker.rename(detached)
    assert retention.expire(stores.settings,at=result['expires_at']-1)['expired_quarantines']==0
    assert retention.expire(stores.settings,at=result['expires_at']+1)=={'expired_quarantines':0,'pending_quarantines':1}
    assert json.loads(Path(result['receipt']).read_text())['state']=='expiry_pending'
    detached.rename(marker)
    assert retention.expire(stores.settings,at=result['expires_at']+2)=={'expired_quarantines':1,'pending_quarantines':0}
    with pytest.raises(ValueError,match='EXPIRED'):
        journal.load(stores.settings,result['receipt'])


def test_partial_expiry_never_claims_success_and_can_retry(stores):
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    remove=retention.shutil.rmtree
    def refused(path,*a,**kw):
        if Path(path).name=='RQ-102-N15':
            raise PermissionError('synthetic busy filesystem')
        return remove(path,*a,**kw)
    with patch.object(retention.shutil,'rmtree',refused):
        assert retention.expire(stores.settings,at=result['expires_at']+1)['pending_quarantines']==1
    assert retention.expire(stores.settings,at=result['expires_at']+2)['expired_quarantines']==1


def test_new_history_is_displaced_during_rollback_and_expires(stores):
    original=snapshot(stores); result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    write(Path(stores.roots['owner']),'central-storage/new-namespace/new',b'synthetic new history')
    write(stores.directory/'drive','originals/2026-10-26/new.jpg',b'synthetic new photo')
    data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=result['receipt'])
    assert snapshot(stores)==original
    row=journal.load(stores.settings,result['receipt']); assert row['displaced']
    assert retention.expire(stores.settings,at=result['expires_at']+1)['expired_quarantines']==1


def test_unknown_pg_table_and_symlinked_clear_data_fail_closed(stores,postgres):
    postgres.query('CREATE TABLE protected_unknown_baseline(id integer);')
    with pytest.raises(ValueError,match='UNCLASSIFIED_TABLE'):
        inventory(stores.settings,postgres,stores.cold)
    (Path(stores.roots['owner'])/'leak').symlink_to(Path(stores.settings['baselines'][0]))
    with pytest.raises(ValueError,match='SYMLINK_REFUSED'):
        inventory(stores.settings)


def test_one_time_reset_and_empty_fresh_sqlite(stores):
    import sqlite3
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    with pytest.raises(ValueError,match='ALREADY_APPLIED'):
        data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    path=Path(stores.roots['hermes'])/'state.db'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE sessions(id TEXT)')
    assert data_reset.run(stores.settings,'verify',cold=stores.cold,receipt_path=result['receipt'])['clear_verified']
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO sessions VALUES('new synthetic history')")
    with pytest.raises(ValueError,match='CLEAR_FILE_REMAINS'):
        data_reset.run(stores.settings,'verify',cold=stores.cold,receipt_path=result['receipt'])


def test_quarantine_needs_no_history_sized_free_space(stores):
    usage=shutil.disk_usage
    def space(path):
        return usage(path)._replace(free=GUARD+3*1024**3+(1<<20))
    with patch.object(moving.shutil,'disk_usage',space):
        result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    assert result['pg_dump_bytes']==0 and result['retained_bytes']>0


def test_interrupted_mixed_projection_can_resume_and_rollback_without_changing_owner(stores):
    from data_reset_policy import VOICE_KEY
    original=snapshot(stores); rename=moving.rename
    def interrupted(source,target):
        rename(source,target)
        if Path(source).name==VOICE_KEY:
            raise KeyboardInterrupt('synthetic power loss with owner projection staged')
    with patch.object(moving,'rename',interrupted):
        with pytest.raises(KeyboardInterrupt):
            data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    assert stores.node(True)['owner_enrolled']
    data_reset.run(stores.settings,'rollback',cold=stores.cold,receipt_path=result['receipt'])
    assert snapshot(stores)==original


def test_missing_cloud_storage_identity_never_counts_as_deletion(stores):
    result=data_reset.run(stores.settings,'quarantine',cold=stores.cold)
    row=journal.load(stores.settings,result['receipt'])
    stores.cold.prefix='.rq102-quarantine/2099-01-01-RQ-102-N15'
    assert data_reset.run(stores.settings,'verify',cold=stores.cold,receipt_path=result['receipt'])['clear_verified']
    assert stores.cold.prefix==row['cold_prefix']
    marker=stores.directory/'drive'/('.rq102-quarantine/.storage-'+row['cold_identity'])
    detached=marker.with_name('.detached'); marker.rename(detached)
    assert retention.expire(stores.settings,at=result['expires_at']+1)=={'expired_quarantines':0,'pending_quarantines':1}
    assert (stores.directory/'drive'/row['cold_prefix']).exists()
    detached.rename(marker)
    assert retention.expire(stores.settings,at=result['expires_at']+2)['expired_quarantines']==1
