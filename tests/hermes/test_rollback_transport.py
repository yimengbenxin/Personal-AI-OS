"""Rolling back to a build from before the model settings authority restores that build's own key environment."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
import release
import watchdog_platform

N12 = Path(__file__).parent / 'fixtures/n12-4856a14d8'  # exact deploy/cloud files of N12 4856a14d8
MODULE = 'integrations/hermes/personal_aios/model_transport.py'
RUN = subprocess.run
spec = importlib.util.spec_from_file_location('model_transport', ROOT / MODULE)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def generation_home(tmp_path):
    """A Hermes home after an authority release ran: its transport names only private projection keys."""
    key = 'PAIOS_MODEL_KEY_0123456789ABCDEF01234567'
    projection = tmp_path / 'projection.json'
    projection.write_text(json.dumps({'environment_id': 'production', 'profile': 'owner', 'revision': 3,
        'group': 'brain', 'configured': True, 'credentials': [{'name': key, 'handle': 'opaque'}],
        'config': {'model': {'default': 'brain-model', 'provider': 'brain', 'base_url': 'https://brain.invalid/v1',
            'key_env': key, 'context_length': 128000, 'request_overrides': {'max_tokens': 8192}},
            'providers': {'brain': {'api': 'https://brain.invalid/v1', 'transport': 'chat_completions', 'key_env': key}},
            'fallback_providers': [], 'delegation': {'enabled': True, 'provider': 'brain', 'model': 'brain-model',
            'key_env': key, 'max_spawn_depth': 2}, 'auxiliary': {'vision': {'enabled': False}}, 'cron': {'enabled': False}}}))
    product = yaml.safe_load((ROOT / 'deploy/cloud/hermes-product-config.yaml').read_text())
    home = tmp_path / 'home'
    (home / 'workshop').mkdir(parents=True)
    config = transport.projected_config({**product, '_config_version': 23, 'timezone': 'Asia/Shanghai'}, projection)
    for path in (home / 'config.yaml', home / 'workshop/config.yaml'):
        path.write_text(yaml.safe_dump(config))
    return home


def n12_composition(home):
    spec = importlib.util.spec_from_file_location('n12_hermes_init', N12 / 'hermes-init.py')
    init = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(init)
    product = yaml.safe_load((N12 / 'hermes-product-config.yaml').read_text())
    return init.compose_config(product, yaml.safe_load((home / 'config.yaml').read_text()))


def key_names(config):
    return set(re.findall(r'PAIOS_[A-Z0-9_]+', json.dumps({k: v for k, v in config.items()
        if k in transport.TRANSPORT_FIELDS})))


def compose_runner(home, calls):
    """Executes the retirement container command locally with its bind mounts and /opt/data mapped to the home."""
    def run(args, **options):
        calls.append(args)
        if args[:2] == ['run', '--rm']:
            mount = args[args.index('-v') + 1].split(':')[0]
            paths = [str(home / Path(path).relative_to('/opt/data')) for path in args[args.index('retire') + 1:]]
            RUN([sys.executable, mount, 'retire', *paths], check=True)
        return SimpleNamespace(stdout='')
    return run


def releases(tmp_path):
    authority, legacy = tmp_path / 'releases/n121', tmp_path / 'releases/n12'
    (authority / MODULE).parent.mkdir(parents=True)
    (authority / MODULE).write_text((ROOT / MODULE).read_text())
    # A rendered release always carries .release/; a rollback leaves its receipt there.
    (authority / '.release').mkdir()
    legacy.mkdir(parents=True)
    return authority, legacy


def test_n12_without_retirement_keeps_unloadable_private_key_names(tmp_path):
    legacy_variables = set(re.findall(r"'(PAIOS_[A-Z_]+_API_KEY)'", (N12 / 'hermes-start.py').read_text()))
    assert legacy_variables == {'PAIOS_DEEPSEEK_API_KEY', 'PAIOS_SILICONFLOW_API_KEY'}
    assert not key_names(n12_composition(generation_home(tmp_path))) <= legacy_variables


def test_manual_rollback_to_n12_restores_its_own_legacy_key_environment(tmp_path, monkeypatch):
    home = generation_home(tmp_path)
    authority, legacy = releases(tmp_path)
    calls, order = [], []
    host = SimpleNamespace(config={}, suffix='', release=lambda name: {'current': authority, 'previous': legacy}[name],
                           runner=lambda target: compose_runner(home, calls), root=tmp_path, event=lambda *a, **k: None)
    monkeypatch.setattr(release, 'stop_writers', lambda host, run: order.append('stop'))
    monkeypatch.setattr(release, 'point', lambda *args: None)
    monkeypatch.setattr(release, 'restore_front', lambda failed: False)
    monkeypatch.setattr(release, 'start', lambda host, target, run, receipt: order.append(('start', target)))
    receipt = release.rollback(host, 'manual')
    assert receipt['transport_retired'] and order == ['stop', ('start', legacy)]
    assert calls[0][:2] == ['run', '--rm'] and 'hermes' in calls[0]
    composed = n12_composition(home)
    assert key_names(composed) <= {'PAIOS_DEEPSEEK_API_KEY', 'PAIOS_SILICONFLOW_API_KEY'}
    assert composed['model']['provider'] == 'deepseek-paios' and 'secrets' not in composed
    retired = yaml.safe_load((home / 'workshop/config.yaml').read_text())
    assert not {'model', 'providers', 'secrets', 'model_settings'} & retired.keys()
    assert yaml.safe_load((home / 'config.yaml').read_text())['_config_version'] == 23


def test_watchdog_rollback_retires_before_compose_starts_the_old_build(tmp_path, monkeypatch):
    home = generation_home(tmp_path)
    authority, legacy = releases(tmp_path)
    calls = []
    run = compose_runner(home, calls)
    monkeypatch.setattr(watchdog_platform.subprocess, 'run', lambda args, **options: run(args[args.index('--profile') + 2:]))
    monkeypatch.setattr(watchdog_platform, 'restore_front', lambda release: False)
    monkeypatch.setattr(watchdog_platform, 'point', lambda *args: None)
    monkeypatch.setitem(sys.modules, 'release_watchdog', SimpleNamespace(release_files=lambda release: {
        'compose': str(legacy / 'deploy/cloud/compose.yaml'), 'env_file': 'env', 'public_env_file': 'public'}))
    class Started(Exception):
        pass
    def execute(command, args, environment):
        raise Started(args)
    monkeypatch.setattr(watchdog_platform.os, 'execvpe', execute)
    platform = watchdog_platform.Platform(tmp_path)
    platform.lock = SimpleNamespace(fileno=lambda: 0)
    monkeypatch.setattr(watchdog_platform.os, 'set_inheritable', lambda *args: None)
    record = {'candidate_release': str(authority), 'previous_release': str(legacy), 'root': str(tmp_path),
              'project': 'paios', 'previous_compose': 'compose.yaml', 'profile': 'production',
              'services': [{'service': 'gateway'}, {'service': 'hermes'}]}
    with pytest.raises(Started) as started:
        platform.rollback(record)
    assert 'up' in started.value.args[0] and calls and calls[0][:2] == ['run', '--rm']
    assert key_names(n12_composition(home)) <= {'PAIOS_DEEPSEEK_API_KEY', 'PAIOS_SILICONFLOW_API_KEY'}


def test_rollback_between_authority_builds_keeps_the_generation(tmp_path):
    home = generation_home(tmp_path)
    authority, _ = releases(tmp_path)
    calls = []
    assert not watchdog_platform.retire_newer_transport(compose_runner(home, calls), authority, authority, ['hermes'])
    assert calls == [] and 'model_settings' in yaml.safe_load((home / 'config.yaml').read_text())
