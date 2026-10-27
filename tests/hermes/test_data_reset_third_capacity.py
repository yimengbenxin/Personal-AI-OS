"""Payload budgets follow actual filesystem ownership, without large allocations."""
from collections import namedtuple
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace

import pytest

import data_reset_cut as cut
from data_reset_inventory import additional_bytes
from data_reset_policy import GUARD


@pytest.fixture
def devices(tmp_path):
    with tempfile.TemporaryDirectory(dir=os.environ.get('RQ102_CROSS_DEVICE_DIR', '/dev/shm')) as other:
        other = Path(other).resolve()
        assert other.stat().st_dev != tmp_path.stat().st_dev
        yield tmp_path, other


def plan_at(roots):
    return {'roots': {str(n): str(root) for n, root in enumerate(roots)},
            'quarantine': {str(n): str(root/'.rq102-quarantine/cut'/str(n))
                           for n, root in enumerate(roots)},
            'files': [], 'hardlink_pairs': [], 'postgres': [], 'cold': []}


def settings_at(root):
    return {'state_dir': str(root), 'capacity': {
        'reserve_bytes': 1024**3, 'reserve_inodes': 100, 'margin_bytes': 2*1024**3}}


@pytest.mark.parametrize('pg_on_other', [False, True])
def test_pg_dump_budget_follows_journal_auxiliary_device(devices, monkeypatch, pg_on_other):
    main, other = devices
    pg_root, rename_root = (other, main) if pg_on_other else (main, other)
    plan = plan_at((pg_root, rename_root))
    database = 5_000_000_000
    pg = SimpleNamespace(database_bytes=lambda: database)
    usage = namedtuple('Usage', 'total used free')
    def space(path):
        free = 20_000_000_000 if Path(path).stat().st_dev == rename_root.stat().st_dev else 100_000_000_000
        return usage(100_000_000_000, 100_000_000_000-free, free)
    monkeypatch.setattr(cut.shutil, 'disk_usage', space)

    assert additional_bytes(plan, pg) == {pg_root.stat().st_dev: 3*database}
    value = cut.capacity(settings_at(main), plan, pg)
    rows = {row['device']: row for row in value['per_filesystem']}
    overhead = GUARD + value['reserve_bytes'] + value['margin_bytes']
    assert rows[pg_root.stat().st_dev]['required_bytes'] == overhead + 3*database
    assert rows[rename_root.stat().st_dev]['required_bytes'] == overhead
    assert value['additional_bytes_estimate'] == 3*database
    assert value['resources']['bytes'] == 3*database + value['reserve_bytes']
    cut.require_capacity(value)

    rows[pg_root.stat().st_dev]['free_bytes'] = overhead + 3*database - 1
    with pytest.raises(ValueError, match='^RESET_CUT_CAPACITY$'):
        cut.require_capacity(value)


def test_mixed_and_hardlink_copies_charge_only_their_written_devices(devices):
    main, other = devices
    plan = plan_at((main, other))
    expected = {}
    for n, root in enumerate((main, other)):
        kept = root/'keep'; kept.write_bytes(b'history'*(n+1))
        clear = root/'clear'; os.link(kept, clear)
        alias = root/'keep-alias'; os.link(kept, alias)
        plan['hardlink_pairs'].extend([
            {'clear': str(clear), 'keep': str(kept)},
            {'clear': str(clear), 'keep': str(alias)}])
        size = 31*(n+1)
        plan['files'].append({'root': str(n), 'path': 'mixed', 'action': 'payment',
                              'device': root.stat().st_dev, 'bytes': size, 'files': 1})
        expected[root.stat().st_dev] = 3*size + clear.stat().st_size

    assert additional_bytes(plan) == expected
    value = cut.capacity(settings_at(main), plan)
    assert value['additional_bytes_estimate'] == sum(expected.values())
    assert value['mixed_file_bytes'] == 93
    for row in value['per_filesystem']:
        assert row['required_bytes'] == (GUARD + expected[row['device']] +
                                         value['reserve_bytes'] + value['margin_bytes'])
