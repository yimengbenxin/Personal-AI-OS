"""Return original inodes; retain new live history in the same quarantine until expiry."""
from pathlib import Path

import data_reset_manifest as journal
from data_reset_inventory import file_hash, inventory, keep_hashes
from data_reset_layout import check, matches
from data_reset_models import rollback_hashes
from data_reset_policy import require
from data_reset_quarantine import MIXED, fresh_root, rename, write_dump


def restore(settings, receipt_path, postgres=None, cold=None):
    receipt = journal.load(settings,receipt_path)
    require(receipt['state'] in ('quarantined','quarantining','restoring'),'RESET_NOT_RESTORABLE')
    if cold:
        cold.prefix=receipt['cold_prefix']
    if cold and receipt['cold_bound']:
        cold.check_identity(receipt['cold_identity'])
    before, originals = receipt['before'], {Path(r['original']) for r in receipt['entries']}
    for entry in receipt['entries']:
        if matches(entry['quarantine'],entry):
            fresh_root(settings,entry)
        if entry['action'] in MIXED:
            stage = Path(entry['original']).with_name('.rq102-keep-'+Path(entry['original']).name)
            stage.unlink(missing_ok=True)
            for suffix in ('-wal','-shm'):
                Path(str(stage)+suffix).unlink(missing_ok=True)
    current = inventory(settings,postgres,cold)
    require(current['binding'] == before['binding'],'RESET_STORE_BINDING_CHANGED')
    expected, retained = rollback_hashes(before, current)
    for entry in receipt['entries']:
        if entry['action'] in MIXED and not Path(entry['original']).exists() and matches(entry['quarantine'],entry):
            key = entry['root']+'/'+entry['path']; retained[key] = keep_hashes(before)[key]
    require(retained == expected,'RESET_ROLLBACK_KEEP_DRIFT')
    receipt['state']='restoring'; journal.save(receipt_path,receipt)

    def displace(path, role):
        if not path.exists():
            return
        target = Path(before['quarantine'].get(role) or receipt['auxiliary'])
        base = journal.base_for(target)/receipt['id']/'rollback-displaced'
        target = base/str(len(receipt['displaced']))
        info = path.lstat()
        row = {'original':str(path),'quarantine':str(target),'device':info.st_dev,'inode':info.st_ino}
        receipt['displaced'].append(row); journal.save(receipt_path,receipt)
        rename(path,target)

    def extra(path, role):
        if any(path == p or path.is_relative_to(p) for p in originals):
            return
        if any(p.is_relative_to(path) for p in originals):
            if path.is_dir():
                for p in list(path.iterdir()):
                    extra(p,role)
        else:
            displace(path,role)

    for row in current['files']:
        if row['action'] not in ('keep','control'):
            extra(Path(settings['roots'][row['root']])/row['path'],row['root'])
    for entry in receipt['entries']:
        original, target = Path(entry['original']), Path(entry['quarantine'])
        if not matches(original,entry):
            check(target,entry)
            displace(original,entry['root'])
            rename(target,original)
        check(original,entry)
        entry['state']='restored'; journal.save(receipt_path,receipt)
    if cold and receipt['cold_bound']:
        expected = {e['original']:e for e in receipt['cold_entries']}
        for live in cold.entries(cold.inventory()):
            old = expected.get(live['original'])
            # An unmoved original in an interrupted quarantine already is the rollback result.
            if old and cold.listing(old['quarantine']) is None:
                cold.check(old,False)
            else:
                cold.move(live['original'],cold.prefix+'/displaced/'+live['original'])
        for entry in receipt['cold_entries']:
            if cold.listing(entry['quarantine']) is not None:
                cold.check(entry); cold.move(entry['quarantine'],entry['original'])
            cold.check(entry,False)
            entry['state']='restored'; journal.save(receipt_path,receipt)
    if postgres and receipt['pg_state'] not in ('pending','restored'):
        require(file_hash(receipt['pg_dump']) == receipt['pg_sha256'],'RESET_POSTGRES_DUMP_CHANGED')
        if not receipt.get('rollback_pg_dump'):
            receipt['rollback_pg_dump']=write_dump(postgres,Path(receipt['auxiliary'])/'rollback-postgres.dump')
            journal.save(receipt_path,receipt)
        postgres.clear(postgres.inventory(),fresh=False)
        process = postgres.restore()
        try:
            with Path(receipt['pg_dump']).open('rb') as stream:
                while chunk := stream.read(1 << 20):
                    process.stdin.write(chunk)
            process.stdin.close()
            require(process.wait() == 0,'RESET_RESTORE_POSTGRES_FAILED')
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
        receipt['pg_state']='restored'; journal.save(receipt_path,receipt)
    restored = inventory(settings,postgres,cold)
    # Original mixed keep rows may have been absent from an interrupted live cut.
    expected, retained = rollback_hashes({**before, 'model_settings': current.get('model_settings')}, restored)
    require(retained == expected,'RESET_KEEP_HASH_CHANGED')
    require(restored['postgres']==before['postgres'] and restored['cold']==before['cold'],'RESET_RESTORE_ROWS_CHANGED')
    for entry in receipt['entries']:
        check(entry['original'],entry)
    from data_reset import epoch
    receipt.update(state='restored',rollback_epoch=epoch(settings),rollback_verified=True)
    journal.save(receipt_path,receipt)
    return {'state':'restored','restored':True,'receipt':str(receipt_path),'keep_verified':True,
            'inode_counts_verified':True,'rollback_verified':True}
