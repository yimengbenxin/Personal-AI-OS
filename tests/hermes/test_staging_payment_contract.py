"""The standard renderer and release gate share the disabled staging contract."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud/staging'))
import regression


def test_standard_renderer_passes_payment_isolation_without_private_overrides(tmp_path, monkeypatch):
    for name in ('prepare-build.py', 'staging_config.py', 'cloud.json', 'front.conf.in', 'paios_roaming_guard.js.in', 'paios-staging-snapshot.timer'):
        target = tmp_path / 'deploy/cloud' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'deploy/cloud' / name, target)
    subprocess.run([sys.executable, str(tmp_path / 'deploy/cloud/prepare-build.py'), '--config-only'],
                   env={**os.environ, 'PAIOS_PUBLIC_HOST': 'payment-contract.invalid'},
                   capture_output=True, text=True, check=True)
    build = tmp_path / 'deploy/cloud/.build'
    production = json.loads((build / 'production.json').read_text())
    assert production['payment']['enabled'] is True
    assert production['payment']['staging'] is False

    # Only store/resource preflight is outside this config-contract test.
    receipts = {group: {'environment_id': 'staging-fixture', 'profile': profile, 'revision': 1,
                       'group': group, 'configured': True}
                for group, profile in [('brain', 'owner'), ('build', 'workshop')]}
    projections = {group: {**receipt, 'config': {'model': {'default': 'synthetic-stage-model'},
                    'fallback_providers': []}, 'credentials': [{'name': 'SYNTHETIC_STAGE_KEY', 'handle': 'synthetic-handle'}]}
                   for group, receipt in receipts.items()}
    monkeypatch.setattr(regression, 'preflight', lambda *args: projections)
    generations = {group: {key: value for key, value in receipt.items() if key != 'configured'}
                   for group, receipt in receipts.items()}
    def runtime_generation(command, **kwargs):
        assert command[:5] == ['exec', '-T', 'hermes-staging', '/opt/hermes/.venv/bin/python', '-c']
        assert kwargs == {'capture_output': True, 'text': True}
        return SimpleNamespace(stdout=json.dumps(generations))
    services = {name + '-staging': {'image': name, 'environment': {'PAIOS_STAGE': 'staging'}}
                for name in ('gateway', 'hermes')}
    stack = SimpleNamespace(settings={}, definition={'services': services},
                            config_mount=lambda: build / 'staging.json', run=runtime_generation)
    source = {'stores_verified': True, 'model_settings': receipts, 'candidate_images':
              {name: service['image'] for name, service in services.items()}}
    assert regression.isolation(stack, source) == {
        'stores_verified': True, 'payment_enabled': False, 'stage': 'staging', 'model_settings': receipts}
    staging = json.loads((build / 'staging.json').read_text())
    assert staging['payment']['enabled'] is False
    assert staging['payment']['staging'] is True
