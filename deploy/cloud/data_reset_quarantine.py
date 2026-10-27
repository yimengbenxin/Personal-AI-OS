"""Journalled root renames. Mixed authorities alone get a small retained projection."""
import os
from pathlib import Path
import shutil
import time

import data_reset_manifest as journal
from data_reset_inventory import clear_hash, file_hash, mixed_state, voice
from data_reset_layout import check, matches
from data_reset_policy import GUARD, TTL, require, sync_directory
from data_reset_sqlite import cleanup_payment_scratch, reset_payment

MIXED = ('voiceprint','override','payment')


def rename(source, target):
    source, target = Path(source), Path(target)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(target.parent.resolve() == target.parent and source.parent.resolve() == source.parent, 'RESET_RENAME_PATH')
    require(source.lstat().st_dev == target.parent.stat().st_dev, 'RESET_CROSS_FILESYSTEM')
    require(not target.exists() and not target.is_symlink(), 'RESET_RENAME_DESTINATION_EXISTS')
    os.rename(source, target)  # Never shutil.move: EXDEV must never fall back to a copy.
    sync_directory(source.parent); sync_directory(target.parent)


def fresh_root(settings, entry):
    if entry['path'] != '.' or entry['type'] != 'directory':
        return
    path = Path(entry['original'])
    if not path.exists():
        path.mkdir(mode=entry['mode'])
        os.chmod(path, entry['mode'])
        if os.geteuid() == 0:
            os.chown(path, entry['uid'], entry['gid'])
        sync_directory(path.parent)


def retained_projection(settings, entry, source, keep_from=None, restoring=False, source_wal=True, keep_wal=True):
    stage = Path(entry['original']).with_name(('.rq102-restore-' if restoring else '.rq102-keep-')+Path(entry['original']).name)
    require(not stage.is_symlink(), 'RESET_MIXED_STAGE_UNSAFE')
    if entry['action'] == 'payment':
        cleanup_payment_scratch(stage, [entry.get('rollback_stage', entry)])
    require(shutil.disk_usage(stage.parent).free > GUARD + 3*Path(source).stat().st_size, 'RESET_MIXED_CAPACITY')
    stage.unlink(missing_ok=True)
    for suffix in ('-wal','-shm'):
        Path(str(stage)+suffix).unlink(missing_ok=True)
    shutil.copy2(source, stage)
    if os.geteuid() == 0:
        os.chown(stage, entry['uid'], entry['gid'])
    if entry['action'] == 'payment':
        wal = Path(str(source)+'-wal') if source_wal is True else Path(source_wal) if source_wal else None
        if wal and wal.exists():
            shutil.copyfile(wal, str(stage)+'-wal')
        if restoring and keep_from:
            entry['rollback_clear'] = clear_hash(mixed_state(stage, entry['action'], settings))
        reset_payment(stage, settings['state_dir'], keep_from=keep_from, keep_wal=keep_wal)
    else:
        state = voice(stage, settings, apply=True, override=entry['action']=='override', keep_from=keep_from)
        if restoring and keep_from:
            entry['rollback_clear'] = state['clear_sha256']
    if restoring and not keep_from:
        entry['rollback_clear'] = clear_hash(mixed_state(stage, entry['action'], settings))
    return stage


def payment_sidecars(receipt, entry, path):
    """Move the cut unit's sidecars before publishing its fresh, checkpointed DB."""
    from data_reset_sqlite import companions
    sides = {str(side) for side in companions(entry['original'])}
    for row in receipt['entries']:
        if row['original'] not in sides:
            continue
        if not matches(row['quarantine'], row):
            check(row['original'], row)
            rename(row['original'], row['quarantine'])
        row['state'] = 'moved'
        journal.save(path, receipt)


def resume(settings, receipt, path, postgres=None, cold=None, *, before_move=None):
    require(receipt['state'] == 'quarantining', 'RESET_ALREADY_APPLIED')
    if postgres and receipt['pg_state'] != 'pending':
        require(file_hash(receipt['pg_dump']) == receipt['pg_sha256'], 'RESET_POSTGRES_DUMP_CHANGED')
        postgres.verify_dump(receipt['pg_dump'], receipt['before']['postgres'])
    cold_seal = receipt['before'].get('cut_observations', {}).get('cold')
    if cold:
        cold.prefix=receipt['cold_prefix']
        if receipt['cold_bound']:
            cold.check_identity(receipt['cold_identity'])
        else:
            require(cold.listing(cold.prefix) is None, 'RESET_COLD_QUARANTINE_EXISTS')
        for entry in receipt['cold_entries']:
            if cold.listing(entry['quarantine']) is None:
                cold.check(entry, False, seal=cold_seal)
    started = any(e['state'] == 'moved' or matches(e['quarantine'],e) or
                  matches(e['quarantine'], {k:v for k,v in e.items() if k != 'isolated'}) for e in receipt['entries'])
    started = started or receipt['pg_state'] in ('clearing','cleared') or any(
        e['state'] == 'moved' for e in receipt['cold_entries'])
    # A crash may land between the root rename and recreating an empty mountpoint.
    for entry in receipt['entries']:
        if matches(entry['quarantine'],entry):
            fresh_root(settings,entry)
    if postgres and receipt['pg_state'] == 'pending':
        dump = postgres.write_dump(Path(receipt['auxiliary'])/'postgres.dump', receipt['before']['postgres'])
        postgres.verify_dump(dump['pg_dump'], receipt['before']['postgres'])
        receipt.update(dump, pg_state='dumped')
        journal.save(path, receipt)
    if before_move and not started:
        before_move()
    for entry in receipt['entries']:
        original, target = Path(entry['original']), Path(entry['quarantine'])
        cut = {k:v for k,v in entry.items() if k != 'isolated'}
        if matches(target, entry) or matches(target, cut):
            require(not matches(original,cut), 'RESET_QUARANTINE_DUPLICATE_ROOT')
            if entry['action'] == 'payment':
                payment_sidecars(receipt, entry, path)
            if entry['action'] in MIXED and not original.exists():
                stage = original.with_name('.rq102-keep-'+original.name)
                if not stage.exists():
                    stage = retained_projection(settings,entry,target)
                rename(stage,original)
        else:
            check(original,cut,recount=False)
            stage = retained_projection(settings,entry,original) if entry['action'] in MIXED else None
            rename(original,target)
            fresh_root(settings,entry)
            if entry['action'] == 'payment':
                payment_sidecars(receipt, entry, path)
            if stage:
                rename(stage,original)
        from data_reset_hardlinks import detach
        detach(receipt, entry, path)
        entry['state'] = 'moved'; journal.save(path,receipt)
    if cold:
        if not receipt['cold_bound']:
            cold.bind(receipt['cold_identity'])
            receipt['cold_bound']=True; journal.save(path,receipt)
        cold.check_identity(receipt['cold_identity'])
        for entry in receipt['cold_entries']:
            if cold.listing(entry['quarantine']) is not None:
                require(cold.listing(entry['original']) is None,'RESET_COLD_DUPLICATE_ROOT')
                cold.check(entry)
            else:
                cold.check(entry,False,seal=cold_seal)
                cold.move(entry['original'],entry['quarantine']); cold.check(entry)
            entry['state']='moved'; journal.save(path,receipt)
    if postgres and receipt['pg_state'] != 'cleared':
        require(receipt['pg_state'] in ('dumped','clearing'),'RESET_POSTGRES_DUMP_REQUIRED')
        resuming_clear = receipt['pg_state'] == 'clearing'
        receipt['pg_state']='clearing'; journal.save(path,receipt)
        postgres.clear(receipt['before']['postgres'], resume=resuming_clear)
        receipt['pg_state']='cleared'; journal.save(path,receipt)
    from data_reset_packages import seed
    from data_reset import epoch, verify
    seed(settings['roots']['owner'])
    if not receipt.get('history_epoch'):
        receipt['history_epoch'] = epoch(settings); journal.save(path,receipt)
    receipt['verification'] = verify(settings,receipt,postgres,cold)
    completed = time.time()
    receipt.update(state='quarantined', quarantined_at=completed, expires_at=completed+TTL)
    receipt.pop('expiry_pending', None)
    journal.save(path,receipt)
    return receipt
