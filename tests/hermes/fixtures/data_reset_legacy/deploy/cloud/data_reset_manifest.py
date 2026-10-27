"""Private durable journal; its storage identity prevents an absent mount being called expired."""
import json
import os
from pathlib import Path
import shutil
import time
from uuid import uuid4

from data_reset_policy import RESET_ID, TTL, require, sync_directory

FORMAT = 'rq102.quarantine.v1'


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600); json.dump(value, stream, sort_keys=True)
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path); sync_directory(path.parent)


def storage_identity(directory, create=False):
    directory = Path(directory)
    require(directory.is_dir() and directory.resolve() == directory, 'RESET_QUARANTINE_MOUNT_CHANGED')
    path = directory/'.rq102-storage-id'
    if create:
        try:
            descriptor = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(uuid4().hex); stream.flush(); os.fsync(stream.fileno())
            sync_directory(directory)
    require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1, 'RESET_QUARANTINE_MOUNT_CHANGED')
    value = path.read_text()
    require(len(value) == 32 and all(c in '0123456789abcdef' for c in value), 'RESET_QUARANTINE_MOUNT_CHANGED')
    return value


def base_for(path):
    path = Path(path)
    return next(p for p in path.parents if p.name == '.rq102-quarantine')


def prepare(settings, before, cold=None):
    from data_reset_layout import entries
    path = Path(settings['state_dir']) / ('data-reset-'+RESET_ID+'.json')
    require(not path.exists(), 'RESET_ALREADY_APPLIED')
    auxiliary = Path(next(v for v in before['quarantine'].values() if v)).parent/'_postgres'
    moves = entries(settings, before)
    bases = {base_for(r['quarantine']) for r in moves} | {base_for(auxiliary)}
    storage = []
    for base in sorted(bases):
        base.mkdir(mode=0o700, exist_ok=True)
        require(base.resolve() == base and base.stat().st_mode & 0o077 == 0, 'RESET_QUARANTINE_PERMISSIONS')
        cut = base/RESET_ID
        require(not cut.exists(), 'RESET_QUARANTINE_ALREADY_EXISTS')
        storage.append({'path':str(base), 'identity':storage_identity(base, create=True), 'device':base.stat().st_dev})
    now = time.time()
    receipt = {'format': FORMAT, 'id': RESET_ID, 'roots': settings['roots'], 'created_at': now, 'expires_at': now+TTL,
               'state': 'quarantining', 'applied_release':settings.get('release_dir'), 'before': before, 'entries': moves, 'storage': storage,
               'auxiliary': str(auxiliary), 'cold_entries': cold.entries(before['cold']) if cold else [],
               'cold_config': cold.config if cold else None, 'cold_identity':uuid4().hex if cold else None,
               'cold_bound':False, 'cold_prefix':cold.prefix if cold else None, 'pg_state': 'pending', 'displaced': []}
    save(path, receipt)  # Intent precedes even the first root rename.
    for base in bases:
        (base/RESET_ID).mkdir(mode=0o700); sync_directory(base)
    return path, receipt


def available(row):
    base = Path(row['path'])
    return base.stat().st_dev == row['device'] and storage_identity(base) == row['identity']


def load(settings, path, expired=False):
    path = Path(path).resolve(strict=True)
    require(path.parent == Path(settings['state_dir']).resolve() and not path.is_symlink(), 'RESET_RECEIPT_SCOPE')
    row = json.loads(path.read_text())
    require(row['format'] == FORMAT and row['id'] == RESET_ID and row['roots'] == settings['roots'], 'RESET_RECEIPT_BINDING')
    if not expired:
        require(time.time() < row['expires_at'] and row['state'] != 'expired', 'RESET_QUARANTINE_EXPIRED')
    require(all(available(base) for base in row['storage']), 'RESET_QUARANTINE_MOUNT_CHANGED')
    from data_reset_layout import entries
    expected = entries(settings, row['before'])
    require(len(expected) == len(row['entries']) and all(
        all(old[k] == actual[k] for k in ('root','path','original','quarantine','device','inode','files','bytes','action'))
        for old,actual in zip(expected,row['entries'])), 'RESET_MANIFEST_INCOMPLETE')
    return row


def cleanup_scratch(settings):
    for path in Path(settings['state_dir']).glob('.inspection-*'):
        if path.is_symlink():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
