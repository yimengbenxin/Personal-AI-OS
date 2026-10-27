"""RQ-102 one-time quarantine engine; the release lifecycle owns all writer fences."""
import json
import os
from pathlib import Path
from uuid import uuid4

import data_reset_manifest as journal
from data_reset_inventory import file_hash, inventory, keep_hashes
from data_reset_layout import check
from data_reset_policy import EPOCH_PATH, RESET_ID, require, sync_directory


def epoch(settings):
    root = Path(settings['roots']['owner']); path = root/EPOCH_PATH
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    value = uuid4().hex; temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value)); temporary.chmod(0o600)
    if os.geteuid() == 0:
        info = root.stat(); os.chown(path.parent,info.st_uid,info.st_gid); os.chown(temporary,info.st_uid,info.st_gid)
    with temporary.open('rb') as stream:
        os.fsync(stream.fileno())
    temporary.replace(path); sync_directory(path.parent)
    return value


def verify(settings, receipt, postgres=None, cold=None):
    if cold:
        cold.prefix=receipt['cold_prefix']
    before = receipt['before']; after = inventory(settings,postgres,cold)
    require(after['binding'] == before['binding'],'RESET_STORE_BINDING_CHANGED')
    require(keep_hashes(after) == keep_hashes(before),'RESET_KEEP_HASH_CHANGED')
    require(len(receipt['entries']) == sum(r['action'] not in ('keep','control') for r in before['files']), 'RESET_MANIFEST_INCOMPLETE')
    for entry in receipt['entries']:
        require(entry['state'] == 'moved','RESET_MANIFEST_INCOMPLETE')
        check(entry['quarantine'],entry,recount=False)
    for row in after['files']:
        if row['action'] == 'clear':
            require(row.get('payload_bytes',0) == 0 and all(t['clear_rows']==0 for t in row.get('tables',[])),
                    'RESET_CLEAR_FILE_REMAINS')
        elif row['action'] == 'payment':
            require(all(t['clear_rows']==0 for t in row['tables']),'RESET_PAYMENT_HISTORY_REMAINS')
        elif row['action'] in ('voiceprint','override'):
            require(all(n==0 for k,n in row['voiceprint']['counts'].items() if k not in ('owner_sets','settings')),'RESET_PEOPLE_REMAIN')
        elif row['action'] == 'package_pins':
            require(row['clear_rows']==0,'RESET_PACKAGE_HISTORY_REMAINS')
    require(not after['cold'],'RESET_COLD_REMAINS')
    if cold:
        require(receipt['cold_bound'],'RESET_MANIFEST_INCOMPLETE')
        cold.check_identity(receipt['cold_identity'])
        require(len(receipt['cold_entries']) == len(cold.entries(before['cold'])),'RESET_MANIFEST_INCOMPLETE')
        expected = cold.entries(before['cold'])
        require(all(all(a[k]==b[k] for k in ('original','quarantine','files','bytes','members'))
                    for a,b in zip(receipt['cold_entries'],expected)),'RESET_MANIFEST_INCOMPLETE')
        for entry in receipt['cold_entries']:
            require(entry['state']=='moved','RESET_MANIFEST_INCOMPLETE'); cold.check(entry)
    for row in after['postgres']:
        if row['action'] in ('clear','mixed'):
            require(row['clear_rows'] == (1 if row['table']=='public.memory_authority_clock' else 0), 'RESET_POSTGRES_HISTORY_REMAINS')
    if postgres:
        require(receipt['pg_state']=='cleared' and Path(receipt['pg_dump']).is_file()
                and file_hash(receipt['pg_dump'])==receipt['pg_sha256'],'RESET_MANIFEST_INCOMPLETE')
        if any(r['table']=='public.memory_authority_clock' for r in after['postgres']):
            require(postgres.query('SELECT watermark FROM public.memory_authority_clock WHERE clock_id=true;')=='1', 'RESET_POSTGRES_CLOCK_NOT_FRESH')
    from data_reset_packages import verify as verify_packages
    verify_packages(settings['roots']['owner'])
    return {'clear_verified':True,'keep_verified':True,'manifest_complete':True,'roots_verified':len(receipt['entries']),
            'keep_objects':len(keep_hashes(after)),'keep_sha256':keep_hashes(after)}


def run(settings, action, postgres=None, cold=None, receipt_path=None):
    if action == 'expire':
        from data_reset_retention import expire
        return expire(settings)
    if action == 'plan':
        return inventory(settings,postgres,cold)
    if action == 'quarantine':
        path = Path(settings['state_dir'])/('data-reset-'+RESET_ID+'.json')
        if path.exists():
            receipt = journal.load(settings,path)
            require(receipt['state']=='quarantining','RESET_ALREADY_APPLIED')
        else:
            before = inventory(settings,postgres,cold)
            path, receipt = journal.prepare(settings,before,cold)
        from data_reset_quarantine import resume
        receipt = resume(settings,receipt,path,postgres,cold)
        return {'receipt':str(path),'state':receipt['state'],'expires_at':receipt['expires_at'],
                'quarantine':receipt['before']['quarantine'],'cold_quarantine_root':receipt['before']['cold_quarantine_root'],'retained_bytes':receipt['before']['source_bytes'],
                'pg_dump_bytes':receipt.get('pg_bytes',0),
                'extra_bytes':receipt.get('pg_bytes',0)+path.stat().st_size+sum(Path(e['original']).stat().st_size
                    for e in receipt['entries'] if e['action'] in ('voiceprint','override','payment')), 'verification':receipt['verification']}
    require(receipt_path,'RESET_RECEIPT_REQUIRED')
    if action == 'verify':
        receipt = journal.load(settings,receipt_path)
        require(receipt['state']=='quarantined','RESET_NOT_QUARANTINED')
        return verify(settings,receipt,postgres,cold)
    require(action == 'rollback','RESET_ACTION')
    from data_reset_restore import restore
    return restore(settings,receipt_path,postgres,cold)
