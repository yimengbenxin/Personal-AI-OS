"""Seven-day deletion, under release.lock; unavailable mounts or recovery stay pending."""
import json
from pathlib import Path
import shutil
import time

from data_reset_cold import Cold
import data_reset_manifest as journal
from data_reset_policy import RESET_ID, require, sync_directory


def expire(settings, at=None):
    journal.cleanup_scratch(settings)
    at, removed, pending = time.time() if at is None else at, 0, 0
    for path in Path(settings['state_dir']).glob('data-reset-*.json'):
        row = json.loads(path.read_text())
        if row.get('format') != journal.FORMAT:
            continue  # Older encrypted receipts have their own retained CLI; never guess their ownership.
        if row['expires_at'] > at or row['state']=='expired':
            continue
        if row['state'] in journal.RECOVERY_STATES:
            row['expiry_pending']=True; journal.save(path,row); pending+=1
            continue
        require(row['id']==RESET_ID and row['state'] in ('quarantined','restored','expiry_pending'),'RESET_EXPIRY_SCOPE')
        try:
            require(all(journal.available(base) for base in row['storage']),'RESET_QUARANTINE_MOUNT_CHANGED')
            if row.get('cold_config') and row['cold_bound']:
                Cold(row['cold_config'],prefix=row['cold_prefix']).expire(row['cold_identity'])
            for base in row['storage']:
                target = Path(base['path'])/RESET_ID
                require(target.parent.name=='.rq102-quarantine' and not target.is_symlink(),'RESET_EXPIRY_SCOPE')
                if target.exists():
                    shutil.rmtree(target)
                require(not target.exists(),'RESET_DELETE_NOT_CONFIRMED')
                sync_directory(target.parent)
        except (OSError,ValueError):
            row.update(state='expiry_pending',expiry_pending=True); journal.save(path,row); pending+=1
            continue
        row.update(state='expired',expired_at=at); row.pop('expiry_pending',None)
        journal.save(path,row); removed+=1
    return {'expired_quarantines':removed,'pending_quarantines':pending}
