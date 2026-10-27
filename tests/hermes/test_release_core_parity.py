"""Self core changes qualify staging first and rebuild against a moving production source."""
from contextlib import nullcontext
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from test_release import IMAGE, git, repo
from test_release_ship import Production, oci
import release
import release_build
import release_identity
import release_parity
import release_source
import release_transfer
from watchdog_platform import point


def identity(commit):
    return {'schema': 'paios.production-state.v1', 'commit': commit, 'release': commit[:8], 'images': IMAGE,
            'native_tree': 'native-tree', 'skill_catalog': 'latest-skills', 'package_registry': 'latest-packages',
            'service_images': {**{k: v for k, v in IMAGE.items() if k != 'watchdog'},
                               'release-watchdog': IMAGE['watchdog'], 'workshop-link': IMAGE['workshop'],
                               'postgres': 'sha256:' + 'f' * 64, 'livekit': 'sha256:' + '0' * 64},
            'config_schema': {'native': 46, 'native_latest': 46, 'cloud_shape': 'shape'},
            'snapshot_at': '2026-10-24T03:00:00+00:00'}


@pytest.mark.parametrize('move_at', ['suites', 'staging'])
def test_production_moving_mid_change_rebuilds_and_regresses_on_the_new_base(tmp_path, repo, monkeypatch, move_at):
    (repo.work / 'integrations/tool.py').write_text('x = 4\n')
    git(repo.work, 'commit', '-qam', 'repair')
    patch = git(repo.work, 'format-patch', '--binary', '--stdout', repo.base + '..HEAD')
    git(repo.work, 'checkout', '-q', '--detach', repo.base)
    (repo.work / 'integrations/lead.py').write_text('preserve the direct deploy\n')
    git(repo.work, 'add', 'integrations/lead.py')
    git(repo.work, 'commit', '-qm', 'lead direct deploy')
    new_base = git(repo.work, 'rev-parse', 'HEAD')
    git(repo.bare, 'fetch', '-q', str(repo.work), 'HEAD:refs/paios/lead')
    exchange = tmp_path / 'exchange'
    exchange.mkdir()
    release_build.write(exchange / 'production.json', identity(repo.base))
    request = tmp_path / 'requests/0123456789ab'
    request.mkdir(parents=True)
    release_build.write(request / 'request.json', {'request_id': request.name, 'base': repo.base})
    (request / 'candidate.patch').write_text(patch + '\n')
    old, _ = release_source.materialize(repo.bare, repo.base, repo.releases)
    point(tmp_path, 'current', old)
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'repo': str(repo.bare), 'exchange': str(exchange)})
    host.state = tmp_path / 'state'
    host.state.mkdir()
    calls = []
    def ensure(selected, lock):
        state = release_transfer.production_base(host.config)
        calls.append(('parity', state['commit']))
        base = repo.releases / state['commit'][:8]
        if not base.exists():
            release_source.materialize(repo.bare, state['commit'], repo.releases)
        point(tmp_path, 'current', base)
        return state
    def build(config, target):
        calls.append(('build', host.commit(target)))
        release_build.write(target / '.release/build.json', {'images': {r: {'id': v} for r, v in IMAGE.items()}})
    def move(name):
        if name == move_at:
            release_build.write(exchange / 'production.json', identity(new_base))
    def suites(config, target, baseline, **kwargs):
        calls.append(('suites', host.commit(target)))
        move('suites')
        value = {'passed': True, 'suites': {}}
        release_build.write(target / '.release/suites.json', value)
        return value
    def stage(selected, target, snapshot, lock):
        calls.append(('staging', host.commit(target)))
        selected.flip(target)
        move('staging')
        value = {'commit': host.commit(target), 'images': IMAGE}
        release_build.write(target / '.release/accepted.json', value)
        return value
    def export(config, target, result, summary):
        calls.append(('export', result['base']))
        assert (target / 'integrations/lead.py').read_text() == 'preserve the direct deploy\n'
        assert (target / 'integrations/tool.py').read_text() == 'x = 4\n'
        return {'package': 'fake-host-package'}
    monkeypatch.setattr(release_parity, 'ensure', ensure)
    monkeypatch.setattr(host, 'model_source', lambda: 'models')
    monkeypatch.setattr(release_build, 'build', build)
    monkeypatch.setattr(release_build, 'suites', suites)
    monkeypatch.setattr(release, 'stage', stage)
    monkeypatch.setattr(release_transfer, 'export', export)
    result = release.candidate(host, request)
    assert result['state'] == 'accepted' and result['base'] == new_base
    assert result['rebuilds'][0]['base'] == repo.base
    assert [name for name, _ in calls] == ['parity', 'build', 'suites', 'staging'] * 2 + ['export']
    git(repo.bare, 'merge-base', '--is-ancestor', new_base, result['commit'])


def test_sync_uses_exact_images_config_snapshot_and_reapplies_staging_boundaries(tmp_path, repo, monkeypatch):
    state = identity(repo.base)
    state['sync'] = {'files': ['sync/images.tar', 'sync/source.bundle', 'sync/config.json', 'sync/latest-inventory.tar.gz']}
    root = tmp_path / 'host'
    current = root / 'releases/old'
    (current / '.release').mkdir(parents=True)
    (current / '.release/env').write_text('PAIOS_SECRETS_DIR=/stage-only\nPAIOS_GATEWAY_IMAGE=old\n')
    point(root, 'current', current)
    exchange = tmp_path / 'exchange'
    exchange.mkdir()
    release_build.write(exchange / 'production.json', state)
    settings = {key: str(tmp_path / key) for key in ('incoming', 'accepted', 'evidence', 'lock')}
    for key in ('incoming', 'accepted', 'evidence'):
        Path(settings[key]).mkdir()
    snapshot = Path(settings['incoming']) / 'snapshot-20261024T030000Z.age'
    snapshot.touch()
    config = tmp_path / 'snapshot-settings.json'
    config.write_text(json.dumps(settings))
    host = release.Host({'stage': 'staging', 'root': str(root), 'repo': str(repo.bare),
                         'exchange': str(exchange), 'snapshot_settings': str(config)})
    host.state = tmp_path / 'release-state'
    host.state.mkdir()
    commands = []
    source_config = {'payment': {'enabled': True, 'staging': False}, 'archive_tiering': {},
                     'product_resources': {'postgres': {'host': 'production'}, 'avatar_url': 'external',
                                           'new_production_setting': True}}
    def render(selected, target):
        (target / 'stage.json').write_text(json.dumps({'product_resources': {
            'public_api_url': 'https://staging.invalid', 'livekit_api_url': 'http://127.0.0.1:7880'}}))
    def definition(target):
        services = {name + '-staging': {} for name in state['service_images']}
        services['gateway-staging']['volumes'] = [{'source': str(target / 'stage.json'), 'target': '/etc/paios/cloud.json'}]
        return {'services': services}
    def restore(actual, envelope, replace, **kwargs):
        assert envelope == snapshot and replace
        assert kwargs == {'lock': kwargs['lock'], 'inventory': exchange / 'sync/latest-inventory.tar.gz'}
        assert actual['disarm_watchdog']
        assert actual['parity_compose'].endswith('/.release/parity.compose.json')
        release_build.write(Path(settings['evidence']) / (snapshot.stem + '.json'),
                            {'as_of': state['snapshot_at'], 'stores_verified': True, 'regression_passed': True})
    monkeypatch.setattr(release, 'render', render)
    monkeypatch.setattr(host, 'definition', definition)
    monkeypatch.setattr(host, 'runner', lambda target: lambda command, **kwargs: commands.append(command))
    monkeypatch.setattr(release_transfer, 'production_inputs', lambda config, production:
                        (source_config, exchange / 'sync/latest-inventory.tar.gz'))
    monkeypatch.setattr(release_parity.staging_snapshot_restore, 'restore', restore)
    monkeypatch.setattr(release_identity, 'capture', lambda selected: state)
    with host.locked() as lock:
        assert release_parity.ensure(host, lock)['commit'] == repo.base
    target = host.release('current')
    actual = json.loads((target / 'stage.json').read_text())
    assert not actual['payment']['enabled'] and actual['payment']['staging']
    assert 'avatar_url' not in actual['product_resources'] and 'archive_tiering' not in actual
    assert actual['product_resources']['new_production_setting']
    assert actual['product_resources']['postgres']['host'] == 'postgres-staging'
    assert 'PAIOS_POSTGRES_IMAGE=' + state['service_images']['postgres'] in (target / '.release/env').read_text()
    assert 'PAIOS_SECRETS_DIR=/stage-only' in (target / '.release/env').read_text()
    report = json.loads((host.state / 'parity.json').read_text())
    assert report['equal'] and report['synced'] and report['before']
    assert commands[-1][1] == '--no-start'
    assert json.loads((exchange / 'parity.json').read_text()) == report


def test_builder_waits_for_the_host_parity_receipt_and_surfaces_failure(tmp_path, monkeypatch):
    import personal_aios.release_preflight as preflight
    host = SimpleNamespace(config={'requests': str(tmp_path)}, locked=lambda **kwargs: nullcontext(None))
    events = []
    monkeypatch.setattr(release_parity, 'ensure', lambda host, lock: events.append('qualified') or {'commit': 'base'})
    # Keep the request pump local; native background threads use the shared time module.
    monkeypatch.setattr(preflight, 'time', SimpleNamespace(
        monotonic=preflight.time.monotonic, sleep=lambda _: release_parity.prepare_requests(host)))
    assert preflight.prepare(tmp_path, '0123456789ab')['base'] == 'base'
    assert events == ['qualified']
    monkeypatch.setattr(release_parity, 'ensure', lambda host, lock: (_ for _ in ()).throw(ValueError('sensitive-detail')))
    with pytest.raises(ValueError, match='CORE_PARITY_FAILED'):
        preflight.prepare(tmp_path, 'abcdef012345')
    assert 'sensitive-detail' not in (tmp_path / 'abcdef012345.prepared').read_text()


def test_ship_and_lead_entry_write_the_same_production_identity(tmp_path, repo, monkeypatch):
    prod = Production(tmp_path, monkeypatch, repo)
    prod.host.config['exchange_remote'] = 'fixture@staging:/exchange/'
    monkeypatch.setattr(release_identity, 'capture', lambda host, **kwargs: identity(host.commit(host.release('current'))))
    release.cmd_ship(prod.host, None)
    path = Path(prod.host.config['incoming']) / 'production.json'
    shipped = json.loads(path.read_text())
    assert json.loads((prod.host.state / 'production.json').read_text()) == shipped
    assert shipped['commit'] == prod.commit
    assert set(release_identity.FIELDS) <= set(shipped)
    point(prod.host.root, 'current', prod.host.releases / 'old')
    release.cmd_identity(prod.host, SimpleNamespace(dry_run=False))
    direct = json.loads(path.read_text())
    assert json.loads((prod.host.state / 'production.json').read_text()) == direct
    assert direct['commit'] == repo.base
    assert set(direct) == set(shipped)


def test_production_transfer_reuses_exact_source_images_config_and_current_inventory(tmp_path, repo, monkeypatch):
    current = tmp_path / 'current'
    current.mkdir()
    cloud = current / 'cloud.json'
    cloud.write_text(json.dumps({'payment': {'enabled': True}, 'product_resources': {}}))
    incoming, exchange = tmp_path / 'production-incoming', tmp_path / 'staging-exchange'
    (exchange / 'sync').mkdir(parents=True)
    host = SimpleNamespace(config={'incoming': str(incoming), 'repo': str(repo.bare),
                                   'exchange_remote': 'fixture@staging:/exchange/'},
                           release=lambda name: current, definition=lambda path: {'services': {'gateway': {
                               'volumes': [{'source': str(cloud), 'target': '/etc/paios/cloud.json'}]}}})
    saves, loaded = [], set()
    def save(refs, path, guard):
        saves.append(refs)
        oci(path, {'blobs/sha256/exact-production-images': b'OCI bytes', 'index.json': b'{}'})
    def inventory_export(host, state):
        path = incoming / 'sync/inventory.tar.gz'
        path.write_bytes(b'current installed inventory, newer than the nightly snapshot')
        return {'file': 'sync/' + path.name, 'sha256': release_transfer.sha256(path)}
    def rsync(config, *args):
        destination = exchange / 'sync' if args[-1].endswith('/sync/') else exchange
        shutil.copyfile(args[-2], destination / Path(args[-2]).name)
    original_run = subprocess.run
    def run(command, **kwargs):
        if command[:2] == ['docker', 'load']:
            loaded.update(identity(repo.base)['service_images'].values())
            return SimpleNamespace(returncode=0)
        return original_run(command, **kwargs)
    monkeypatch.setattr(release_transfer, 'save', save)
    monkeypatch.setattr(release_transfer.release_inventory, 'export', inventory_export)
    monkeypatch.setattr(release_transfer, 'rsync', rsync)
    monkeypatch.setattr(release_transfer, 'present', lambda image: image in loaded)
    monkeypatch.setattr(subprocess, 'run', run)
    state = identity(repo.base)
    state['sync'] = release_transfer.production_package(host, state)
    release_transfer.publish(host.config, state)
    config = {'exchange': str(exchange), 'repo': str(repo.bare)}
    actual, inventory = release_transfer.production_inputs(config, release_transfer.production_base(config))
    assert actual == json.loads(cloud.read_text())
    assert inventory.read_bytes().startswith(b'current installed inventory')
    assert saves == [sorted(set(state['service_images'].values()))]
    release_transfer.production_package(host, state)
    assert len(saves) == 1
    inventory.write_bytes(b'changed after transfer')
    with pytest.raises(ValueError, match='TRANSFER_INVENTORY_DIGEST_MISMATCH'):
        release_transfer.production_inputs(config, state)
