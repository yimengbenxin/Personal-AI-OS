"""Journalled root renames. Mixed authorities alone get a small retained projection."""
import os
from pathlib import Path
import shutil

import data_reset_manifest as journal
from data_reset_inventory import file_hash, voice
from data_reset_layout import check, matches
from data_reset_policy import GUARD, require, sync_directory
from data_reset_sqlite import reset_payment

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


def retained_projection(settings, entry, source):
    stage = Path(entry['original']).with_name('.rq102-keep-'+Path(entry['original']).name)
    require(not stage.is_symlink(), 'RESET_MIXED_STAGE_UNSAFE')
    require(shutil.disk_usage(stage.parent).free > GUARD + 3*Path(source).stat().st_size, 'RESET_MIXED_CAPACITY')
    stage.unlink(missing_ok=True)
    for suffix in ('-wal','-shm'):
        Path(str(stage)+suffix).unlink(missing_ok=True)
    shutil.copy2(source, stage)
    if os.geteuid() == 0:
        os.chown(stage, entry['uid'], entry['gid'])
    if entry['action'] == 'payment':
        wal = Path(str(source)+'-wal')
        if wal.exists():
            shutil.copyfile(wal, str(stage)+'-wal')
        reset_payment(stage, settings['state_dir'])
    else:
        voice(stage, settings, apply=True, override=entry['action']=='override')
    return stage


def write_dump(postgres, target):
    target = Path(target)
    temporary = target.with_suffix('.partial')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    dump = postgres.dump()
    try:
        with temporary.open('wb') as stream:
            os.chmod(temporary,0o600)
            while chunk := dump.stdout.read(1 << 20):
                require(shutil.disk_usage(target.parent).free > GUARD + len(chunk), 'RESET_POSTGRES_DUMP_CAPACITY')
                stream.write(chunk)
            require(dump.wait() == 0, 'RESET_POSTGRES_DUMP_FAILED')
            stream.flush(); os.fsync(stream.fileno())
        temporary.replace(target); sync_directory(target.parent)
    finally:
        if dump.poll() is None:
            dump.kill(); dump.wait()
    return {'pg_dump':str(target),'pg_sha256':file_hash(target),'pg_bytes':target.stat().st_size}


def dump_postgres(settings, receipt, path, postgres):
    if postgres and receipt['pg_state']=='pending':
        receipt.update(write_dump(postgres,Path(receipt['auxiliary'])/'postgres.dump'),pg_state='dumped')
        journal.save(path,receipt)


def resume(settings, receipt, path, postgres=None, cold=None):
    require(receipt['state'] == 'quarantining', 'RESET_ALREADY_APPLIED')
    # A crash may land between the root rename and recreating an empty mountpoint.
    for entry in receipt['entries']:
        if matches(entry['quarantine'],entry):
            fresh_root(settings,entry)
    if cold:
        cold.prefix=receipt['cold_prefix']
        if not receipt['cold_bound']:
            cold.bind(receipt['cold_identity'])
            receipt['cold_bound']=True; journal.save(path,receipt)
        cold.check_identity(receipt['cold_identity'])
    dump_postgres(settings, receipt, path, postgres)
    for entry in receipt['entries']:
        original, target = Path(entry['original']), Path(entry['quarantine'])
        if matches(target, entry):
            require(not matches(original,entry), 'RESET_QUARANTINE_DUPLICATE_ROOT')
            if entry['action'] in MIXED and not original.exists():
                stage = original.with_name('.rq102-keep-'+original.name)
                if not stage.exists():
                    stage = retained_projection(settings,entry,target)
                rename(stage,original)
        else:
            check(original,entry,recount=False)
            stage = retained_projection(settings,entry,original) if entry['action'] in MIXED else None
            rename(original,target)
            fresh_root(settings,entry)
            if stage:
                rename(stage,original)
        entry['state'] = 'moved'; journal.save(path,receipt)
    if cold:
        for entry in receipt['cold_entries']:
            if cold.listing(entry['quarantine']) is not None:
                require(cold.listing(entry['original']) is None,'RESET_COLD_DUPLICATE_ROOT')
                cold.check(entry)
            else:
                cold.check(entry,False); cold.move(entry['original'],entry['quarantine']); cold.check(entry)
            entry['state']='moved'; journal.save(path,receipt)
    if postgres and receipt['pg_state'] != 'cleared':
        require(receipt['pg_state'] in ('dumped','clearing'),'RESET_POSTGRES_DUMP_REQUIRED')
        receipt['pg_state']='clearing'; journal.save(path,receipt)
        postgres.clear(receipt['before']['postgres'])
        receipt['pg_state']='cleared'; journal.save(path,receipt)
    from data_reset_packages import seed
    from data_reset import epoch, verify
    seed(settings['roots']['owner'])
    if not receipt.get('history_epoch'):
        receipt['history_epoch'] = epoch(settings); journal.save(path,receipt)
    receipt['verification'] = verify(settings,receipt,postgres,cold)
    receipt['state']='quarantined'; journal.save(path,receipt)
    return receipt
