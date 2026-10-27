"""Same-device destinations outside every product mount; no copy fallback."""
import os
from pathlib import Path

from data_reset_policy import RESET_ID, require
from data_reset_history import SELECTIVE_ROOTS


def outside(path, mounts):
    return all(not path.is_relative_to(m) for m in mounts)


def targets(settings, report, *, include_empty=False):
    roots = {k: Path(v) for k,v in settings['roots'].items()}
    mounts = [Path(p) for p in settings.get('mount_roots', [str(v) for k,v in roots.items() if k not in SELECTIVE_ROOTS])]
    result = {}
    for role, root in roots.items():
        if not include_empty and not any(r['root'] == role and r['action'] not in ('keep','control') for r in report['files']):
            result[role] = None; continue
        parent = Path(settings.get('quarantine_parents', {}).get(role, root.parent))
        if role not in settings.get('quarantine_parents', {}):
            while not outside(parent, mounts):
                require(parent != parent.parent, 'RESET_QUARANTINE_NO_LOCATION')
                parent = parent.parent
        require(parent.is_dir() and parent.resolve() == parent and outside(parent, mounts), 'RESET_QUARANTINE_LOCATION')
        require(parent.stat().st_dev == root.stat().st_dev and all(
            row['device'] == parent.stat().st_dev for row in report['files'] if row['root']==role and row['action'] not in ('keep','control')),
            'RESET_CROSS_FILESYSTEM')
        target = parent / '.rq102-quarantine' / RESET_ID / role
        require(all(not target.is_relative_to(Path(b)) and not Path(b).is_relative_to(target)
                    for b in settings.get('baselines', [])), 'RESET_QUARANTINE_BASELINE_OVERLAP')
        result[role] = str(target)
    return result


def entries(settings, before):
    result = []
    for row in before['files']:
        if row['action'] in ('keep','control'):
            continue
        original = Path(settings['roots'][row['root']]) / row['path']
        target = Path(before['quarantine'][row['root']]) / row['path']
        result.append({**row, 'original': str(original), 'quarantine': str(target), 'state': 'pending'})
    return result


def matches(path, row):
    row = row.get('isolated', row)
    try:
        stat = Path(path).lstat()
        return stat.st_dev == row['device'] and stat.st_ino == row['inode']
    except FileNotFoundError:
        return False


def counts(path, device):
    path, total, size = Path(path), 0, 0
    if path.is_dir():
        for directory, folders, names in os.walk(path, followlinks=False):
            for name in folders + names:
                p = Path(directory)/name
                info = p.lstat()
                require(info.st_dev == device and not p.is_symlink(), 'RESET_QUARANTINE_TREE_CHANGED')
                if p.is_file():
                    total += 1; size += info.st_size
                else:
                    require(p.is_dir(), 'RESET_SPECIAL_FILE_REFUSED')
    else:
        info = path.lstat(); total, size = 1, info.st_size
    return total, size


def check(path, row, recount=True):
    row = row.get('isolated', row)
    require(matches(path, row), 'RESET_QUARANTINE_INODE_CHANGED')
    if recount:
        require(counts(path, row['device']) == (row['files'], row['bytes']), 'RESET_QUARANTINE_COUNTS_CHANGED')
    if 'sha256' in row and row.get('type') != 'directory':
        from data_reset_inventory import file_hash
        require(file_hash(path) == row['sha256'], 'RESET_QUARANTINE_CONTENT_CHANGED')
