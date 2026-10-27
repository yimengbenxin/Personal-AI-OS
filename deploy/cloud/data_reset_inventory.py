"""Count clear trees without reading L5 payloads; hash only retained authorities."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from data_reset_host import run_worker
from data_reset_policy import classify, digest, require, tree_kind, validate
from data_reset_sqlite import inventory as sqlite_inventory
from data_reset_history import SELECTIVE_ROOTS, objects


def file_hash(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            result.update(chunk)
    return result.hexdigest()


def files(root, observe=lambda path: None):
    for directory, folders, names in os.walk(root, followlinks=False):
        for name in sorted(folders + names):
            path = Path(directory) / name
            observe(path)
            if path.is_symlink() or path.is_file():
                yield path
            else:
                require(path.is_dir(), 'RESET_SPECIAL_FILE_REFUSED')
        folders.sort()


def voice(path, settings, apply=False, override=False, keep_from=None, restoring=False):
    result = run_worker(settings, {
        'path': str(path), 'key_file': str(Path(settings['roots']['secrets']) / 'voiceprint.key'),
        'apply': apply, 'override': override, 'keep_from': str(keep_from) if keep_from else None})
    require(result.returncode == 0, 'RESET_ROLLBACK_MIXED_UNMERGEABLE_'+('OVERRIDE' if override else 'VOICEPRINT')
            if keep_from or restoring else 'RESET_VOICEPRINT_FAILED')
    value = json.loads(result.stdout)
    require('error' not in value, 'RESET_VOICEPRINT_FAILED')
    return value


def inventory(settings, postgres=None, cold=None, restoring=False, payment_wals=None, *, cut=False):
    directory = Path(settings['state_dir']); directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.inspection-', dir=directory) as scratch:
        roots, rows, linked = validate(settings, restoring), [], {'keep': {}, 'clear': {}}
        observed = {**roots, **{'baseline'+str(n): Path(p).resolve() for n, p in enumerate(settings.get('baselines', []))}}
        from data_reset_cut import stamp
        observations = {'files': {}, 'selective': {}}
        def observe(path):
            if cut:
                observations['files'].setdefault(str(path), stamp(path))

        def table_counts(path, mixed=False):
            if path.suffix not in ('.sqlite', '.db') or path.name == '.reset-payment.sqlite':
                return []
            with path.open('rb') as stream:
                if stream.read(16) != b'SQLite format 3\0':
                    return []
            try:
                return sqlite_inventory(path, mixed, scratch, (payment_wals or {}).get(str(path), True))
            except sqlite3.DatabaseError:
                require(not mixed, 'RESET_PAYMENT_SQLITE_UNSUPPORTED')
                worker = run_worker(settings, {'path': str(path), 'sqlite': True, 'scratch_directory': scratch})
                require(worker.returncode == 0, 'RESET_SQLITE_WORKER_FAILED')
                return json.loads(worker.stdout)['tables']

        def meta(role, root, path, action):
            info = path.lstat()
            return {'root': role, 'path': path.relative_to(root).as_posix(), 'action': action,
                    'device': info.st_dev, 'inode': info.st_ino, 'mode': info.st_mode & 0o7777,
                    'uid': info.st_uid, 'gid': info.st_gid, 'type': 'directory' if path.is_dir() else 'file',
                    'files': 0, 'bytes': 0}

        def leaf(role, root, path, action, row):
            info = path.lstat()
            require(action == 'keep' or not path.is_symlink(), 'RESET_SYMLINK_REFUSED')
            require(path.is_file() or path.is_symlink(), 'RESET_SPECIAL_FILE_REFUSED')
            require(info.st_dev == row['device'], 'RESET_CROSS_FILESYSTEM')
            row['files'] += 1; row['bytes'] += info.st_size
            # The control epoch is replaced atomically; it has no quarantined history entry.
            if info.st_nlink > 1 and action != 'control':
                linked['keep' if action == 'keep' else 'clear'].setdefault((info.st_dev, info.st_ino), []).append(str(path))
            if action == 'keep':
                row['sha256'] = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest() if path.is_symlink() else file_hash(path)
                if path.is_symlink():
                    row['symlink'] = True
            if not path.is_symlink():
                tables = table_counts(path, action == 'payment')
                if not tables and action == 'clear':
                    row['payload_bytes'] = row.get('payload_bytes',0) + info.st_size
                if tables:
                    row.setdefault('tables', []).extend({**t, 'path': path.relative_to(root).as_posix()} for t in tables)
                    if action == 'keep':
                        for t in row['tables']:
                            t['keep_rows'], t['clear_rows'] = t['clear_rows'], 0

        def visit(role, root, path):
            observe(path)
            relative = path.relative_to(root).as_posix()
            action = tree_kind(role, '' if relative == '.' else relative)
            if path.is_dir() and not path.is_symlink():
                if action == 'clear':
                    row = meta(role, root, path, action)
                    for p in files(path, observe):
                        leaf(role, root, p, action, row)
                    rows.append(row)
                else:
                    for child in sorted(path.iterdir()):
                        visit(role, root, child)
                return
            action = 'keep' if role.startswith('baseline') else classify(role, relative)
            if action == 'consent':
                grant = json.loads(path.read_bytes())
                require(isinstance(grant, dict) and grant.get('kind') in ('send','login','delete','external','file_edit','read'),
                        'RESET_CONSENT_UNKNOWN')
                action = 'keep' if grant['kind'] == 'send' else 'clear'
            row = meta(role, root, path, action); leaf(role, root, path, action, row)
            if action in ('voiceprint', 'override'):
                row['voiceprint'] = voice(path, settings, override=action == 'override', restoring=restoring)
            elif action == 'package_pins':
                from data_reset_packages import history_rows
                row['clear_rows'] = history_rows(root, path)
            rows.append(row)

        for role, root in sorted(observed.items()):
            if not root.exists():
                continue  # A pure clear root can be absent after an interrupted quarantine rename.
            selected = list(objects(role, root)) if role in SELECTIVE_ROOTS else [root]
            if cut and role in SELECTIVE_ROOTS:
                observations['selective'][role] = [str(p) for p in selected]
            for path in selected:
                visit(role, root, path)
        cold_seal = {} if cut else None
        report = {'id': settings['id'], 'roots': {k: str(v) for k,v in observed.items()}, 'files': rows,
                  'binding': digest({'roots': settings['roots'], 'cold': cold.config if cold else None,
                                     'postgres': postgres.identity() if postgres else None}),
                  'cold_quarantine_root': str(cold.local/cold.prefix) if cold and cold.local else cold.url+'/'+cold.prefix if cold else None,
                  'cold_root': str(cold.local) if cold and cold.local else cold.url if cold else None,
                  'postgres': postgres.inventory() if postgres else [], 'cold': cold.inventory(seal=cold_seal) if cold else [],
                  'hardlink_pairs': [{'clear': c, 'keep': k} for key, names in linked['clear'].items()
                                     for c in names for k in linked['keep'].get(key, [])]}
        report['source_bytes'] = sum(r['bytes'] for r in rows if r['action'] not in ('keep', 'control')) + sum(r['bytes'] for r in report['cold'])
        from data_reset_layout import targets
        report['quarantine'] = targets(settings, report)
        if cut:
            observations['postgres'] = {row['table']: row['sha256'] for row in report['postgres']}
            observations['cold'] = cold_seal
            report['cut_observations'] = observations
        report['preimage'] = digest(report)
        return report


def retained_hash(row):
    if row['action'] == 'keep':
        return row['sha256']
    if row['action'] in ('voiceprint','override'):
        return {k:v for k,v in row['voiceprint'].items() if k.endswith('sha256') and k != 'clear_sha256'}
    if row['action'] == 'payment':
        return {t['table']:t['keep_sha256'] for t in row['tables']}


def mixed_state(path, action, settings):
    if action == 'payment':
        return {'action':action, 'tables':sqlite_inventory(path, True, settings['state_dir'])}
    return {'action':action, 'voiceprint':voice(path, settings, override=action == 'override')}


def clear_hash(row):
    if row['action'] == 'payment':
        return {t['table']:t['clear_sha256'] for t in row['tables']}
    return row['voiceprint']['clear_sha256']


def keep_hashes(report):
    hashes = {r['root']+'/'+r['path']:retained_hash(r) for r in report['files'] if retained_hash(r) is not None}
    for table in report['postgres']:
        if table['action'] in ('keep','mixed'):
            hashes['postgres/' + table['table']] = table['keep_sha256']
    return hashes


def public_plan(report):
    def counts(row):
        return {k: ([counts(t) for t in v] if k == 'tables' else v) for k,v in row.items()
                if not k.endswith('sha256') and k not in ('device','inode','uid','gid','mode','voiceprint')}
    return {'id': report['id'], 'source_bytes': report['source_bytes'], 'roots': report['roots'],
            'cold_root': report['cold_root'], 'cold_quarantine_root':report['cold_quarantine_root'], 'files': [counts(r) | ({'voiceprint_counts':r['voiceprint']['counts']}
                if 'voiceprint' in r else {}) for r in report['files']], 'postgres': [counts(r) for r in report['postgres']],
            'cold': [counts(r) for r in report['cold']], 'quarantine': report['quarantine'],
            'hardlink_pairs': report['hardlink_pairs'],
            'classes': {a: {'files':sum(r['files'] for r in report['files'] if r['action']==a),
                            'bytes':sum(r['bytes'] for r in report['files'] if r['action']==a)}
                        for a in sorted({r['action'] for r in report['files']})}}


def additional_bytes(report, postgres=None, *, database_bytes=None):
    """Budget payload writes on the device that receives each copy or scratch file."""
    devices = {}
    for row in report['files']:
        if row['action'] in ('voiceprint','override','payment'):
            devices[row['device']] = devices.get(row['device'], 0) + 3*row['bytes']
    for path in {pair['clear'] for pair in report['hardlink_pairs']}:
        info = Path(path).stat()
        devices[info.st_dev] = devices.get(info.st_dev, 0) + info.st_size
    database = postgres.database_bytes() if database_bytes is None and postgres else database_bytes or 0
    if database:
        # Match manifest.prepare: the first quarantine owns the PG dump and scratch.
        auxiliary = Path(next(v for v in report['quarantine'].values() if v)).parent/'_postgres'
        while not auxiliary.exists():
            auxiliary = auxiliary.parent
        device = auxiliary.stat().st_dev
        devices[device] = devices.get(device, 0) + 3*database
    return devices
