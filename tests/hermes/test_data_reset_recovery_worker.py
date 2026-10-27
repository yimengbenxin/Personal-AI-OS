"""Exercise the host Docker transport against the real engine and frozen worker on macOS."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deploy/cloud'))
import data_reset
from data_reset_cold import Cold
import data_reset_host
from data_reset_inventory import inventory, keep_hashes, mixed_state, voice
import data_reset_manifest as journal
from data_reset_policy import RESET_ID, VOICE_KEY, OVERRIDE_KEY


@pytest.fixture
def worker_host(tmp_path, monkeypatch):
    roots = {role:str(tmp_path/role) for role in ('owner','hermes','errands','models','projections','secrets')}
    for path in roots.values():
        Path(path).mkdir()
    (Path(roots['secrets'])/'model-settings-master.key').write_text('synthetic-unused-key')
    mounts = [{'type':'bind','source':roots[role],'target':target} for role,target in (
        ('owner','/var/lib/paios'), ('errands','/var/lib/paios/state/errands'),
        ('models','/var/lib/paios/central-storage/model-settings'),
        ('projections','/var/lib/paios/model-projections'), ('secrets','/run/secrets'))]
    config = tmp_path/'cloud.json'; config.write_text('{}')
    mounts.append({'type':'bind','source':str(config),'target':'/etc/paios/cloud.json'})
    services = {'gateway':{'image':'frozen-synthetic-image','volumes':mounts,'environment':{}},
                'hermes':{'volumes':[{'type':'bind','source':roots['hermes'],'target':'/opt/data'}]},
                'workshop':{'volumes':[]}, 'postgres':{'volumes':[]}}
    for service,target in [('gateway','/opt/models'), ('workshop','/workshop'),
                           ('workshop','/srv/workshop-snapshots'), ('workshop','/var/lib/workshop-ssh'),
                           ('hermes','/run/workshop-access'), ('postgres','/var/lib/postgresql')]:
        path = tmp_path/('mount-'+target.rsplit('/',1)[-1]); path.mkdir()
        services[service]['volumes'].append({'type':'bind','source':str(path),'target':target})
    state = tmp_path/'release-state'; state.mkdir()
    releases = tmp_path/'releases'; releases.mkdir()
    # The cut deliberately lives outside every deployed mount and outside release state.
    cut_parent = tmp_path/'cut-only'; cut_parent.mkdir()
    spec = dict(id=RESET_ID, snapshot_settings=str(tmp_path/'absent-snapshot'),
        quarantine_parents={role:str(cut_parent) for role in roots},
        capacity={'reserve_bytes':1024**3,'reserve_inodes':100000,'margin_bytes':2*1024**3})
    host = SimpleNamespace(config={'data_reset':spec}, suffix='', root=releases,
        definition=lambda release:{'services':services}, lock_path=lambda:state/'release.lock')
    settings = data_reset_host.settings(host, releases)
    registry = Path(roots['owner'])/'central-storage/voiceprints'/VOICE_KEY
    registry.parent.mkdir(parents=True)
    registry.write_text(json.dumps(dict(schema='paios.voiceprint.registry.v2', revision=9,
        next_number=1, owner_sets=[], clusters=[], assistant=[])))
    override = registry.with_name(OVERRIDE_KEY)
    override.write_text(json.dumps(dict(enabled=False, expires_at=None, enabled_by_device=None,
                                      failures=[{'device':'synthetic-guest','at':1}])))
    (Path(roots['hermes'])/'MEMORY.md').write_text('synthetic cut history')
    native_run, calls = subprocess.run, []

    def runner(command, **kwargs):
        if command[:2] != ['docker','run']:
            return native_run(command, **kwargs)
        payload = json.loads(kwargs['input'])
        binds = [command[n+1].split(':') for n,value in enumerate(command) if value == '-v']
        calls.append((payload, binds))
        for field in ('path','keep_from','scratch_directory'):
            if not payload.get(field):
                continue
            path = Path(payload[field])
            covering = [bind for bind in binds if path == Path(bind[1]) or path.is_relative_to(bind[1])]
            if not covering:
                return SimpleNamespace(returncode=1, stdout='', stderr='worker path is outside Docker binds: '+str(path))
            effective = max(covering, key=lambda bind:len(bind[1]))
            if path.is_relative_to(cut_parent):
                assert effective == [str(path),str(path),'ro'], 'cut inputs need exact read-only binds'
            elif path.is_relative_to(roots['owner']):
                assert effective[-1] == 'rw', 'preserve live write mounts'
        assert [roots['secrets'],roots['secrets'],'ro'] in binds
        worker = ROOT/'01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts'
        return native_run(['node',str(worker)], **kwargs)

    monkeypatch.setattr(subprocess, 'run', runner)
    return settings, registry, override, calls


def test_cold_move_failure_then_rollback_reads_quarantined_voice_cut(worker_host, tmp_path, monkeypatch):
    settings, registry, override, calls = worker_host
    before = inventory(settings)
    cold_root = tmp_path/'cold'; (cold_root/'backups').mkdir(parents=True)
    (cold_root/'backups/history').write_text('synthetic cold history')
    cold = Cold({'directory':str(cold_root)})
    with monkeypatch.context() as failure:
        def fail_move(source, target):
            raise ValueError('SYNTHETIC_COLD_MOVE_FAILED')
        failure.setattr(cold, 'move', fail_move)
        with pytest.raises(ValueError, match='^SYNTHETIC_COLD_MOVE_FAILED$'):
            data_reset.run(settings, 'quarantine', cold=cold)
    receipt_path, = Path(settings['state_dir']).glob('data-reset-*.json')
    cut = journal.load(settings, receipt_path)
    assert cut['state'] == 'quarantining'
    assert all(entry['state'] == 'moved' for entry in cut['entries'])
    result = data_reset.run(settings, 'rollback', cold=cold, receipt_path=receipt_path)
    assert result['state'] == 'restored'
    assert keep_hashes(inventory(settings)) == keep_hashes(before)
    assert json.loads(registry.read_text())['revision'] == 11
    assert len(json.loads(override.read_text())['failures']) == 1
    assert any('.rq102-quarantine' in payload['path'] for payload,_ in calls)


@pytest.mark.parametrize('override', [False,True])
def test_worker_reads_cut_keep_from_without_widening_live_mounts(worker_host, tmp_path, override):
    settings, registry, override_path, calls = worker_host
    live = override_path if override else registry
    cut = tmp_path/'cut-only'/'isolated-cut'; cut.write_bytes(live.read_bytes())
    expected = voice(live, settings, override=override)
    assert mixed_state(cut, 'override' if override else 'voiceprint', settings)['voiceprint'] == expected
    voice(live, settings, apply=True, override=override, keep_from=cut, restoring=True)
    payload, binds = calls[-1]
    assert payload['keep_from'] == str(cut)
    assert [str(cut),str(cut),'ro'] in binds
