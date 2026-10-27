"""Isolate the inventory's clear/keep hardlinks inside each cut before writers restart."""
import os
from pathlib import Path
import shutil

import data_reset_manifest as journal
from data_reset_inventory import file_hash
from data_reset_layout import check, matches
from data_reset_policy import GUARD, require, sync_directory


def detach(receipt, entry, receipt_path):
    pairs = {pair['clear']: pair['keep'] for pair in receipt['before']['hardlink_pairs']}
    original, target = Path(entry['original']), Path(entry['quarantine'])
    kept = {str(Path(receipt['before']['roots'][r['root']])/r['path']): r
            for r in receipt['before']['files'] if r['action'] == 'keep'}
    copies = receipt.setdefault('hardlink_copies', {})
    for clear, keep in pairs.items():
        path = Path(clear)
        if path != original and not path.is_relative_to(original):
            continue
        saved = target/path.relative_to(original)
        row = copies.get(clear)
        if row and 'inode' in row and matches(saved, row):
            require(file_hash(saved) == row['sha256'], 'RESET_QUARANTINE_CONTENT_CHANGED')
            continue
        if row is None:
            scratch = journal.base_for(target)/receipt['id']/'_hardlink-copies'/str(len(copies))
            row = {'scratch':str(scratch), 'quarantine':str(saved), 'sha256':kept[keep]['sha256']}
            copies[clear] = row
            journal.save(receipt_path, receipt)
        scratch = Path(row['scratch'])
        if 'inode' not in row or not matches(scratch, row):
            require(not scratch.is_symlink(), 'RESET_HARDLINK_SCRATCH_UNSAFE')
            scratch.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            scratch.unlink(missing_ok=True)
            require(shutil.disk_usage(scratch.parent).free > GUARD + saved.stat().st_size,
                    'RESET_HARDLINK_COPY_CAPACITY')
            shutil.copy2(saved, scratch)
            if os.geteuid() == 0:
                info = saved.stat(); os.chown(scratch, info.st_uid, info.st_gid)
            with scratch.open('rb') as stream:
                os.fsync(stream.fileno())
            require(file_hash(scratch) == row['sha256'], 'RESET_QUARANTINE_CONTENT_CHANGED')
            info = scratch.stat()
            row.update(device=info.st_dev, inode=info.st_ino, files=1, bytes=info.st_size)
            if path == original:
                entry['isolated'] = {k:row[k] for k in ('device','inode','files','bytes','sha256')}
            journal.save(receipt_path, receipt)
        else:
            require(file_hash(scratch) == row['sha256'], 'RESET_QUARANTINE_CONTENT_CHANGED')
        os.replace(scratch, saved)
        sync_directory(saved.parent); sync_directory(scratch.parent)


def finish_pending(receipt, receipt_path):
    if 'hardlink_copies' not in receipt:
        return  # Old cuts keep their original integrity rule; never invent overwritten bytes.
    controls = {str(Path(receipt['before']['roots'][r['root']])/r['path'])
                for r in receipt['before']['files'] if r['action'] == 'control'}
    for pair in receipt['before']['hardlink_pairs']:
        clear = Path(pair['clear'])
        if str(clear) in controls:
            continue  # Older inventories included the atomically replaced epoch in clear pairs.
        entry = next(e for e in receipt['entries'] if clear == Path(e['original']) or clear.is_relative_to(e['original']))
        row = receipt['hardlink_copies'].get(str(clear))
        if row and 'inode' in row and matches(row['quarantine'], row):
            continue
        target = Path(entry['quarantine'])
        if target.exists():
            check(target, {k:v for k,v in entry.items() if k != 'isolated'})
            detach(receipt, entry, receipt_path)


def verify(receipt):
    for row in receipt.get('hardlink_copies', {}).values():
        entry = next(e for e in receipt['entries'] if row['quarantine'] == e['quarantine']
                     or Path(row['quarantine']).is_relative_to(e['quarantine']))
        path = Path(row['quarantine'])
        if not path.exists():
            path = Path(entry['original'])/path.relative_to(entry['quarantine'])
        require(('inode' not in row or matches(path, row)) and file_hash(path) == row['sha256'],
                'RESET_QUARANTINE_CONTENT_CHANGED')
