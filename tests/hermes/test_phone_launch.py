"""Exercise the real executor launch contract without acquiring a phone or calling a model."""
import importlib.util
import json
from pathlib import Path
import sys

import pytest

from capability.packages.load import load_packages

ROOT = Path(__file__).parents[2]
EXECUTOR = ROOT / 'integrations/connectors/phone_executor'
spec = importlib.util.spec_from_file_location('phone_launch_cloud', ROOT / 'deploy/cloud/hermes-init.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
CONTRACT = {'PAIOS_DEEPSEEK_KEY_FILE', 'PAIOS_ERRAND_SPOOL', 'PAIOS_INTEGRATION_PORT',
            'PAIOS_MOBILERUN_CONFIG', 'PAIOS_PAYMENT_KEY_FILE', 'PAIOS_PAYMENT_URL',
            'PAIOS_PHONE_PROVIDER', 'PAIOS_SILICONFLOW_KEY_FILE'}


@pytest.mark.parametrize('provider', ['mac-android', 'agentbay'])
@pytest.mark.parametrize('single_host', [False, True])
def test_loader_binds_the_executor_directory_and_host_values(tmp_path, monkeypatch, provider, single_host):
    secrets = tmp_path / 'secrets'
    secrets.mkdir()
    for name in ['agentbay.key', 'agentbay.adbkey', 'agentbay.adbkey.pub', 'deepseek.key', 'siliconflow.key',
                 'payment-executor.key', 'fast.key', 'thorough.key', 'unlock.pin']:
        (secrets / name).write_text('fixture-only')
    monkeypatch.setattr(cloud, 'SECRETS', secrets)
    monkeypatch.setenv('PAIOS_INTEGRATION_PORT', '19661')
    monkeypatch.setenv('PAIOS_AGENTBAY_IMAGE', 'fixture-never-leased')
    monkeypatch.setenv('PAIOS_DEPLOYMENT', 'single-host' if single_host else 'cloud')
    monkeypatch.delenv('PAIOS_STAGE', raising=False)
    monkeypatch.setattr(cloud.os, 'chown', lambda *args: None)
    models = tmp_path / 'executor-models.json'
    models.write_text(json.dumps({f'executor_{role}': {'model': 'fixture-' + role,
        'base_url': 'http://127.0.0.1:9/v1', 'key_file': str(secrets / (role + '.key'))}
        for role in ['fast', 'thorough']}))
    monkeypatch.setattr(cloud, 'EXECUTOR_MODELS', models)
    binding = cloud.phone_runtime(tmp_path, ROOT / 'integrations/hermes/personal_aios', provider, time_zone='UTC')
    selection = {'capability_packages': {'enabled': ['phone'], 'gateway': ['phone']}}
    environment = {'PAIOS_PHONE_UNLOCK_FILE': str(secrets / 'unlock.pin')}
    servers, _, _ = load_packages(ROOT, selection, tmp_path, runtime_bindings={'phone': binding}, environ=environment)
    phone = servers['phone']
    assert phone['cwd'] == str(EXECUTOR)
    assert phone['command'] == binding['command']
    assert phone['args'] == [str(ROOT / 'capability/packages/phone/server/main.py')]
    assert CONTRACT <= phone['env'].keys()
    assert all('${' not in value for value in phone['env'].values())
    assert {name: phone['env'][name] for name in CONTRACT} == {name: binding['env'][name] for name in CONTRACT}
    manifest = json.loads((ROOT / 'capability/packages/phone/plugin.json').read_text())['extensions']['ai.yimi.capability']
    declared = {secret['name'] for secret in manifest['secrets']}
    for name in phone['env'].keys() & declared:
        assert Path(phone['env'][name]).is_file()
    if provider == 'agentbay':
        assert Path(phone['env']['PAIOS_AGENTBAY_ADBKEY'] + '.pub').is_file()
    if single_host:
        assert {'PAIOS_EXECUTOR_FAST_KEY_FILE', 'PAIOS_EXECUTOR_THOROUGH_KEY_FILE'} <= phone['env'].keys()
    assert Path(phone['env']['PAIOS_MOBILERUN_CONFIG']).is_file()
    assert Path(phone['cwd'], 'fast_agent_system.jinja2').is_file()
    assert Path(phone['cwd'], 'app_cards').is_dir()
    del binding['env']['PAIOS_ERRAND_SPOOL']
    with pytest.raises(KeyError, match='PAIOS_ERRAND_SPOOL'):
        load_packages(ROOT, selection, tmp_path, runtime_bindings={'phone': binding})

