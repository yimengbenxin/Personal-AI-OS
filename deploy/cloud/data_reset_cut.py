"""One quiescent plan, its release-configured budget, and pre-move observation seal."""
import json
import os
from pathlib import Path
import shutil

from data_reset_policy import GUARD, RESET_ID, digest, require


def stamp(path):
    row = Path(path).lstat()
    return [getattr(row, name) for name in
            ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')]


def plan_digest(plan):
    return digest({k: v for k, v in plan.items() if k != 'preimage'})


def capacity(settings, plan, postgres=None, cold=None):
    """Renames need no payload copy; PG/mixed scratch and metadata do need space."""
    from data_reset_inventory import additional_bytes
    policy = settings['capacity']
    require(all(type(policy.get(k)) is int and policy[k] >= 0 for k in
                ('reserve_bytes', 'reserve_inodes', 'margin_bytes')) and policy['margin_bytes'] >= 2*1024**3,
            'RESET_CAPACITY_POLICY')
    mixed = sum(r['bytes'] for r in plan['files'] if r['action'] in ('voiceprint', 'override', 'payment'))
    database = postgres.database_bytes() if postgres else 0
    additional_by_device = additional_bytes(plan, postgres, database_bytes=database)
    additional = sum(additional_by_device.values())
    objects = sum(r['files'] for r in plan['files']) + len(plan['files']) + len(plan['postgres']) + len(plan['cold'])
    reserve = max(policy['reserve_bytes'], 8*len(json.dumps(plan).encode()) + 4096*(objects + 1))
    inodes = max(policy['reserve_inodes'], 2*(objects + 1))
    paths = {Path(settings['state_dir']), *map(Path, settings.get('guard_paths', []))}
    paths.update(Path(path) for role,path in plan['roots'].items() if not role.startswith('baseline'))
    for role, target in plan['quarantine'].items():
        if target:
            paths.update((Path(plan['roots'][role]), Path(target)))
    if cold and cold.local:
        paths.add(cold.local)
    devices = {}
    for path in sorted(paths):
        while not path.exists():
            path = path.parent
        device = path.stat().st_dev
        row = devices.setdefault(device, {'device': device, 'paths': [],
            'free_bytes': shutil.disk_usage(path).free, 'free_inodes': os.statvfs(path).f_favail})
        row['paths'].append(str(path))
        row.update(required_bytes=GUARD + additional_by_device.get(device, 0) + reserve + policy['margin_bytes'],
                   required_inodes=inodes)
    return {'pg_database_bytes': database, 'mixed_file_bytes': mixed, 'additional_bytes_estimate': additional,
            'configured_reserve_bytes': policy['reserve_bytes'], 'reserve_bytes': reserve, 'reserve_inodes': inodes,
            'margin_bytes': policy['margin_bytes'], 'source_guard_bytes': GUARD,
            'resources': {'bytes': additional + reserve, 'inodes': inodes, 'evidence': 'source data_reset_cut.capacity'},
            'per_filesystem': list(devices.values())}


def require_capacity(result):
    require(all(r['free_bytes'] >= r['required_bytes'] and r['free_inodes'] >= r['required_inodes']
                for r in result['per_filesystem']), 'RESET_CUT_CAPACITY')


def review(settings, plan, preview=None):
    """Inventory already applied the closed source policy, mixed partitions and hardlink classification."""
    from data_reset_inventory import keep_hashes, public_plan
    require(plan['id'] == settings['id'] == RESET_ID and plan['preimage'] == plan_digest(plan), 'RESET_CUT_PLAN_CHANGED')
    expected = {**settings['roots'], **{'baseline'+str(n): str(Path(p).resolve())
                                      for n, p in enumerate(settings.get('baselines', []))}}
    require(plan['roots'] == expected and 'cm1' not in plan['roots'], 'RESET_CUT_ROOTS_CHANGED')
    delta = None
    if preview is not None:
        def counts(value):
            return {'files': sum(r['files'] for r in value['files']),
                    'rows': sum(r['rows'] for r in value['postgres']) +
                            sum(t['clear_rows'] + t['keep_rows'] for r in value['files'] for t in r.get('tables', [])),
                    'bytes': value['source_bytes'], 'cold_objects': len(value['cold'])}
        delta = {'preview': counts(preview), 'cut': counts(plan), 'gated': False}
    return {'plan_digest': plan['preimage'], 'policy_validated': True, 'hardlink_pairs': len(plan['hardlink_pairs']),
            'keep_objects': len(keep_hashes(plan)), 'preview_delta': delta, 'plan': public_plan(plan)}


def check(settings, plan, expected_digest, postgres=None, cold=None):
    """Validate file seals and the selected product tables, without classifying another inventory."""
    require(expected_digest == plan['preimage'] == plan_digest(plan), 'RESET_CUT_PLAN_CHANGED')
    require(plan.get('cut_observations') is not None, 'RESET_CUT_SEAL_REQUIRED')
    try:
        require(all(stamp(path) == value for path, value in plan['cut_observations']['files'].items()),
                'RESET_CUT_WRITTEN')
    except FileNotFoundError:
        raise ValueError('RESET_CUT_WRITTEN') from None
    require((postgres.fingerprints(plan['postgres']) if postgres else {}) ==
            {row['table']:row['sha256'] for row in plan['postgres']}, 'RESET_CUT_POSTGRES_WRITTEN')
    from data_reset_history import objects
    require(all([str(p) for p in objects(role, Path(plan['roots'][role]))] == paths
                for role, paths in plan['cut_observations']['selective'].items()), 'RESET_CUT_WRITTEN')
    if cold:
        observed = {}
        rows = cold.listing(seal=observed) or []
        require(sorted(rows, key=lambda r: r['path']) == plan['cold'] and
                observed == plan['cut_observations']['cold'], 'RESET_CUT_COLD_WRITTEN')
