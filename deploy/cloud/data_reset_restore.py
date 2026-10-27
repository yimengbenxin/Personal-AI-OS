"""Restore cut history while preserving the durable, pre-rollback live keep baseline."""
from copy import deepcopy
from pathlib import Path

import data_reset_manifest as journal
from data_reset_inventory import clear_hash, file_hash, inventory, keep_hashes, mixed_state, retained_hash
from data_reset_layout import check, matches
from data_reset_policy import require
from data_reset_quarantine import MIXED, rename, retained_projection
from data_reset_sqlite import cleanup_payment_scratch, companions


def started(receipt, cold=None):
    if receipt.get('rollback_started') or any(matches(row['quarantine'], row) for row in receipt['displaced']):
        return True
    for entry in receipt['entries'] + receipt.get('rollback_mixed', []):
        if entry.get('rollback_stage') and matches(entry['original'], entry['rollback_stage']):
            return True
    if 'rollback_sources' in receipt:
        return any(not Path(path).exists() for path in receipt['rollback_sources'])
    for entry in receipt['entries']:
        if entry.get('state') == 'restored':
            return True
    return bool(cold and any(entry.get('state') == 'restored' for entry in receipt['cold_entries']))


def cleanup(settings, receipt):
    entries = receipt['entries'] + receipt.get('rollback_mixed', [])
    published = [row for entry in entries for row in
                 (entry, entry.get('isolated'), entry.get('rollback_stage')) if row is not None]
    published += [row for row in receipt.get('hardlink_copies', {}).values() if 'inode' in row]
    for entry in entries:
        if entry['action'] not in MIXED:
            continue
        original = Path(entry['original'])
        if entry['action'] == 'payment':
            cleanup_payment_scratch(original, published)
        if entry.get('rollback_stage'):
            continue
        stage = original.with_name('.rq102-restore-'+original.name)
        for candidate in [stage, *companions(stage)]:
            if candidate.exists() or candidate.is_symlink():
                require(candidate.is_file() and not candidate.is_symlink(), 'RESET_MIXED_STAGE_UNSAFE')
                info = candidate.stat()
                require(all((info.st_dev,info.st_ino) != (row['device'],row['inode']) for row in published),
                        'RESET_MIXED_STAGE_PUBLISHED')
                candidate.unlink()


def cancel_preparation(receipt, state):
    receipt['state'] = state
    for row in [receipt, *receipt['entries']]:
        for key in list(row):
            if key.startswith('rollback_'):
                del row[key]


def cut_source(receipt, entry):
    """A cut inode can be unmoved, quarantined, restored, or journalled as displaced."""
    paths = [entry['original'], entry['quarantine']]
    paths += [row['quarantine'] for row in receipt['displaced'] if row['original'] == entry['original']]
    source = next((Path(path) for path in paths if matches(path, entry)), Path(entry['quarantine']))
    check(source, entry)
    return source


def restored_result(receipt_path):
    return {'state':'restored', 'restored':True, 'receipt':str(receipt_path), 'keep_verified':True,
            'inode_counts_verified':True, 'rollback_verified':True}


def restore(settings, receipt_path, postgres=None, cold=None):
    receipt = journal.load(settings, receipt_path)
    if receipt['state'] == 'restored':
        return restored_result(receipt_path)
    require(receipt['state'] in ('quarantined', 'quarantining', 'restoring'), 'RESET_NOT_RESTORABLE')
    if cold:
        cold.prefix = receipt['cold_prefix']
    # Older engines could persist restoring before any move. Such a receipt is still cancellable.
    if receipt['state'] == 'restoring' and not started(receipt, cold):
        # 78d persisted neither rollback_from nor a baseline. Its completed-cut
        # verification is durable evidence of which state preceded restoring.
        state = receipt.get('rollback_from') or (
            'quarantined' if receipt.get('verification', {}).get('manifest_complete') else 'quarantining')
        cancel_preparation(receipt, state)
        receipt['displaced'] = []  # No recorded destination contains a moved inode.
        journal.save(receipt_path, receipt)
    elif receipt['state'] == 'restoring':
        receipt['rollback_started'] = True
    previous = deepcopy(receipt)
    cleanup(settings, receipt)
    try:
        return apply(settings, receipt_path, receipt, postgres, cold)
    except BaseException:
        if receipt['state'] == 'restoring' and previous['state'] != 'restoring' and not started(receipt, cold):
            cancel_preparation(receipt, previous['state'])
            receipt['displaced'] = previous['displaced']
            for old, entry in zip(previous['entries'], receipt['entries']):
                entry['state'] = old['state']
            journal.save(receipt_path, receipt)  # Keep any cut-copy installation completed during preflight.
            cleanup(settings, receipt)
        raise


def apply(settings, receipt_path, receipt, postgres, cold):
    before = receipt['before']
    if cold:
        cold.prefix = receipt['cold_prefix']
        if receipt['cold_bound']:
            cold.check_identity(receipt['cold_identity'])
    cut_keep = keep_hashes(before)
    by_original = {entry['original']: entry for entry in receipt['entries']}
    payment_wals = {}
    for entry in receipt['entries']:
        if entry['action'] != 'payment':
            continue
        wal = by_original.get(str(companions(entry['original'])[0]))
        if wal and matches(wal['original'], wal) and not matches(entry['original'], entry):
            # An older cut could publish fresh DB before moving the cut WAL.
            # That WAL belongs to the cut substrate, never to the fresh live DB.
            payment_wals[entry['original']] = None
    current = inventory(settings, postgres, cold, restoring=True, payment_wals=payment_wals)
    require(current['binding'] == before['binding'], 'RESET_STORE_BINDING_CHANGED')
    displacement = {role:Path(target).parent/'rollback-displaced'
                    for role,target in before['quarantine'].items() if target}
    displacement.update({role:Path(path) for role,path in receipt.get('displacement', {}).items()})
    # Older receipts did not reserve empty roles. Reuse only an already-bound
    # store on that role's device, or refuse before moving any history.
    for row in current['files']:
        role = row['root']
        if row['action'] in ('keep', 'control') or role in displacement:
            continue
        store = next((base for base in receipt['storage'] if base['device'] == row['device']), None)
        require(store is not None, 'RESET_ROLLBACK_STORAGE_REQUIRED')
        displacement[role] = Path(store['path'])/receipt['id']/'rollback-displaced'
    from data_reset_hardlinks import finish_pending
    finish_pending(receipt, receipt_path)
    # Check all originals before product writes, including originals retained after a merge.
    for entry in receipt['entries']:
        cut_source(receipt, entry)
    cut_files = {str(Path(before['roots'][r['root']])/r['path']):r for r in before['files'] if r['action'] == 'keep'}
    live_files = {str(Path(current['roots'][r['root']])/r['path']):r for r in current['files'] if r['action'] == 'keep'}
    from data_reset_hardlinks import verify as verify_copies
    verify_copies(receipt)
    controls = {str(Path(before['roots'][row['root']])/row['path'])
                for row in before['files'] if row['action'] == 'control'}
    for pair in before['hardlink_pairs']:
        if pair['clear'] in controls or pair['clear'] in receipt.get('hardlink_copies', {}):
            continue
        clear = Path(pair['clear'])
        entry = next(e for e in receipt['entries'] if clear == Path(e['original']) or clear.is_relative_to(Path(e['original'])))
        base = Path(entry['original'] if matches(entry['original'], entry) else entry['quarantine'])
        saved = base/clear.relative_to(entry['original'])
        live = live_files.get(pair['keep'])
        # Reuse the already-read digest if both paths still refer to the same inode.
        actual = live['sha256'] if live and matches(saved, live) else file_hash(saved)
        require(actual == cut_files[pair['keep']]['sha256'], 'RESET_QUARANTINE_CONTENT_CHANGED')
    live_keep = keep_hashes(current)
    for entry in receipt['entries'] + receipt.get('rollback_mixed', []):
        key = entry['root']+'/'+entry['path']
        if entry['action'] not in MIXED or key in live_keep:
            continue
        original = Path(entry['original'])
        unpublished = receipt.get('rollback_from', receipt['state']) == 'quarantining' and not original.exists()
        displaced = any(row['original'] == str(original) and matches(row['quarantine'], row)
                        for row in receipt['displaced'])
        if unpublished or displaced:
            live_keep[key] = receipt.get('rollback_keep', cut_keep)[key]
        else:
            require(False, 'RESET_ROLLBACK_MIXED_UNMERGEABLE_'+entry['action'].upper())
    if 'rollback_keep' not in receipt:
        originals = {entry['original'] for entry in receipt['entries']}
        receipt.update(rollback_keep=live_keep, rollback_from=receipt['state'], state='restoring',
            rollback_sources=[e['quarantine'] for e in receipt['entries'] if Path(e['quarantine']).exists()], rollback_mixed=[
            {**row, 'original':str(Path(settings['roots'][row['root']])/row['path']), 'state':'pending'}
            for row in current['files'] if row['action'] in MIXED
            and str(Path(settings['roots'][row['root']])/row['path']) not in originals])
    require(live_keep == receipt['rollback_keep'], 'RESET_ROLLBACK_KEEP_DRIFT')
    if postgres and receipt['pg_state'] not in ('pending', 'restored'):
        require(file_hash(receipt['pg_dump']) == receipt['pg_sha256'], 'RESET_POSTGRES_DUMP_CHANGED')
        prepared = postgres.prepare_restore(receipt['pg_dump'], before['postgres'])
        receipt['rollback_pg_archive'] = str(prepared)
        receipt['rollback_pg_clear'] = postgres.archive_inventory(prepared)
    entries = receipt['entries'] + receipt['rollback_mixed']
    # Prepare every mixed result before displacing live files, through the fresh projection producers.
    for entry in entries:
        if entry['action'] not in MIXED or entry.get('rollback_stage'):
            continue
        key = entry['root']+'/'+entry['path']
        original = Path(entry['original'])
        source = cut_source(receipt, entry) if 'quarantine' in entry else original
        changed_revision = False
        if entry['action'] == 'voiceprint' and original.exists():
            cut_state = mixed_state(source, entry['action'], settings)['voiceprint']['metadata']
            live_state = mixed_state(original, entry['action'], settings)['voiceprint']['metadata']
            changed_revision = any(cut_state[k] != live_state[k] for k in ('schema','revision'))
        if entry['action'] != 'payment' and not changed_revision and key in cut_keep and cut_keep[key] == receipt['rollback_keep'][key]:
            continue  # Reuse preserves the exact original inode and envelope.
        live_source = original if original.is_file() else Path(source)
        require(live_source.is_file(), 'RESET_ROLLBACK_MIXED_UNMERGEABLE_'+entry['action'].upper())
        wal = by_original.get(str(companions(original)[0])) if entry['action'] == 'payment' else None
        source_wal = cut_source(receipt, wal) if wal else True
        keep_wal = payment_wals.get(str(original), True) if original.is_file() else source_wal
        stage = retained_projection(settings, entry, source, keep_from=live_source if 'quarantine' in entry else None,
                                    restoring=True, source_wal=source_wal, keep_wal=keep_wal)
        state = mixed_state(stage, entry['action'], settings)
        require(retained_hash(state) == receipt['rollback_keep'][key], 'RESET_ROLLBACK_MIXED_KEEP_CHANGED_'+entry['action'].upper())
        require(clear_hash(state) == entry['rollback_clear'], 'RESET_ROLLBACK_MIXED_CLEAR_CHANGED_'+entry['action'].upper())
        info = stage.stat()
        entry['rollback_stage'] = {'path':str(stage), 'device':info.st_dev, 'inode':info.st_ino,
                                   'files':1, 'bytes':info.st_size, 'sha256':file_hash(stage)}
    if postgres and receipt['pg_state'] not in ('pending', 'restored'):
        postgres.validate_restore(receipt['rollback_pg_archive'])
        if not receipt.get('rollback_pg_dump'):
            receipt['rollback_pg_dump'] = postgres.write_dump(Path(receipt['auxiliary'])/'rollback-postgres.dump')
    receipt['state'] = 'restoring'
    journal.save(receipt_path, receipt)  # All deterministic preparation succeeds before the recovery fence.

    def move(source, target):
        info = Path(source).lstat()
        identity = {'device':info.st_dev, 'inode':info.st_ino}
        try:
            rename(source, target)
        finally:
            if matches(target, identity):
                receipt['rollback_started'] = True
                journal.save(receipt_path, receipt)

    def displace(path, role, destination=None):
        for row in receipt['displaced']:
            if row['original'] == str(path) and matches(path, row):
                move(path, Path(row['quarantine']))
                return
        if not path.exists():
            return
        base = displacement[role]
        target = destination or base/str(len(receipt['displaced']))
        info = path.lstat()
        row = {'original':str(path), 'quarantine':str(target), 'device':info.st_dev, 'inode':info.st_ino}
        receipt['displaced'].append(row)
        journal.save(receipt_path, receipt)
        move(path, target)
        return target

    originals = {Path(entry['original']) for entry in entries}
    stages = {Path(entry['rollback_stage']['path']) for entry in entries if entry.get('rollback_stage')}
    payments = {Path(entry['original']):entry for entry in entries if entry['action'] == 'payment'}
    payment_sides = {side:entry for original,entry in payments.items() for side in companions(original)}

    def extra(path, role):
        if path in stages or path in payment_sides or any(path == p or path.is_relative_to(p) for p in originals):
            return
        if any(p.is_relative_to(path) for p in originals):
            if path.is_dir():
                for child in list(path.iterdir()):
                    extra(child, role)
        else:
            displace(path, role)
    for row in current['files']:
        if row['action'] not in ('keep', 'control'):
            extra(Path(settings['roots'][row['root']])/row['path'], row['root'])
    for entry in entries:
        original = Path(entry['original'])
        owner = payment_sides.get(original)
        if owner and owner.get('rollback_stage'):
            # The cut WAL is already incorporated in the merged substrate. Replaying it would overwrite live keep.
            cut_source(receipt, entry)
            entry['rollback_absorbed'] = True
            entry['state'] = 'absorbed'
            journal.save(receipt_path, receipt)
            continue
        stage = entry.get('rollback_stage')
        expected = stage or entry
        if not matches(original, expected):
            source = Path(stage['path']) if stage else cut_source(receipt, entry)
            check(source, expected)
            if stage:
                require(file_hash(source) == stage['sha256'], 'RESET_ROLLBACK_STAGE_CHANGED_'+entry['action'].upper())
            if entry['action'] == 'payment':
                row = next((r for r in receipt['displaced'] if r['original'] == str(original)), None)
                base = Path(row['quarantine']).parent if row else displacement[entry['root']]/str(len(receipt['displaced']))
                displace(original, entry['root'], base/original.name)
                for side in companions(original):
                    displace(side, entry['root'], base/side.name)
            else:
                displace(original, entry['root'])
            move(source, original)
        check(original, expected)
        entry['state'] = 'restored'
        journal.save(receipt_path, receipt)
        if entry['action'] in MIXED:
            leftover = original.with_name('.rq102-keep-'+original.name)
            leftover.unlink(missing_ok=True)
            for suffix in ('-wal', '-shm'):
                Path(str(leftover)+suffix).unlink(missing_ok=True)
    if cold and receipt['cold_bound']:
        cold.displace_live(receipt['cold_entries'])
        for entry in receipt['cold_entries']:
            if cold.listing(entry['quarantine']) is not None:
                cold.check(entry)
                cold.move(entry['quarantine'], entry['original'])
            cold.check(entry, False)
            entry['state'] = 'restored'
            journal.save(receipt_path, receipt)
    if postgres and receipt['pg_state'] not in ('pending', 'restored'):
        postgres.restore(receipt['rollback_pg_archive'])
        receipt['pg_state'] = 'restored'
        journal.save(receipt_path, receipt)
    restored = inventory(settings, postgres, cold)
    require(keep_hashes(restored) == receipt['rollback_keep'], 'RESET_KEEP_HASH_CHANGED')
    require(restored['cold'] == before['cold'], 'RESET_RESTORE_ROWS_CHANGED')
    if receipt.get('rollback_pg_clear'):
        actual = {row['table']:{'clear_rows':row['clear_rows'], 'clear_sha256':row['clear_sha256']}
                  for row in restored['postgres'] if row['action'] != 'keep'}
        require(actual == receipt['rollback_pg_clear'], 'RESET_RESTORE_ROWS_CHANGED')
    for entry in entries:
        check(cut_source(receipt, entry) if entry.get('rollback_absorbed') else entry['original'], entry.get('rollback_stage') or entry)
        if entry.get('rollback_stage'):
            require(clear_hash(mixed_state(entry['original'], entry['action'], settings)) == entry['rollback_clear'],
                    'RESET_ROLLBACK_MIXED_CLEAR_CHANGED_'+entry['action'].upper())
    from data_reset_packages import restore as restore_packages
    restore_packages(settings['roots']['owner'], displace)
    from data_reset import epoch
    receipt.update(state='restored', rollback_epoch=epoch(settings), rollback_verified=True)
    journal.save(receipt_path, receipt)
    return restored_result(receipt_path)
