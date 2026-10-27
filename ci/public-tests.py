#!/usr/bin/env python3
"""Run the public server suites with an explicit, reviewable prerequisite inventory."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / '01-product-half-finished/backend'
PACKAGES = {'gateway': BACKEND / 'phase0/gateway',
            'integration': BACKEND / 'services/personal-aios-integration'}
# Exact test names only. Other tests in these files still run.
NODE_OMISSIONS = {
    'gateway': {
        'enabled video requires the component contract and a protected key; absence explicitly disables it':
            'Requires a deployment-specific mac-product.json profile not included in this repository.',
        'direct Watch routes are registered at the public edge, including strict-query rejection targets':
            'Requires an edge deployment configuration not included in this repository.',
        'public edge admits enrollment, Mac pairing, capability declarations and SSH lifecycle but never internal desktop MCP':
            'Requires the same separately supplied edge deployment configuration.',
        'live persona shares SOUL authority while guests never receive owner context':
            'Requires SOUL files from a separately supplied deployment profile.',
        'debug text stream accepts one exact PCM envelope and reuses the normal STT/final/reply pipeline':
            'Uses the excluded legacy rayneo-android debug audio fixture.',
        'debug text stream rejects binding, shape, encoding, hash, read, duplicate, and closed failures':
            'Uses the same excluded legacy rayneo-android debug audio fixture.',
        'B1 source keeps token and attestation memory-only and statically binds React one-shot HTTPS':
            'Reads the excluded historical upstream React starter; current native clients remain in the export.',
        'React consumes only directed Gateway ChatMessage events with lifecycle-clean room binding':
            'Reads the excluded historical upstream React starter.',
        'React Stop helper verifies terminal cleanup and bounds in-progress polling':
            'Reads the excluded historical upstream React starter.',
        'official React validator closes canSubscribe and grant claim variants':
            'Reads the excluded historical upstream React starter.',
        'B1 generic React token route returns the same closed no-store 403 for every method':
            'Reads the excluded historical upstream React starter.',
        'T15 Safari permission may remain pending past eight seconds and settles exactly once':
            'Reads the excluded historical React microphone control component.',
        'T15 Phase-0 mic consumer has no permission timer, replacement, or media expansion':
            'Reads the excluded historical React microphone control component.',
    },
    'integration': {
        'new plaintext registry remains readable and enrollable by deployed 0dd85cf4':
            'Requires an earlier Git object not present in this repository.',
        'legacy registry reads independent enrollment and its re-enrollment invalidates the call profile':
            'Requires an earlier Git object not present in this repository.',
        'e248d09a production storage reader resolves retained folded and original records after reset':
            'Requires an earlier storage-reader Git object not present here; current storage/reset tests still run.',
        'tracked Mac product snapshot passes the real central startup checks before deployment':
            'Requires a separately supplied mac-product.json deployment profile.',
        'clean upstream pin + repo patch rebuilds the locked tree, the fixture producer and a gate-accepted checkout':
            'Requires producer provenance not included here; CI setup independently rebuilds and checks the producer.',
    },
}
PYTHON_OMISSIONS = {
    'tests/hermes/test_endpoint_rollback.py::RollbackEndpointTests::test_rel26_own_loader_and_edge_accept_n_rendered_endpoints':
        'Requires an earlier Git object and its deployment configuration; current deployment tests still run.',
    'tests/hermes/test_cloud_init.py::test_cloud_image_input_has_no_mac_or_retired_phone_configuration':
        'Requires a separately supplied Hermes deployment profile.',
    'tests/hermes/test_cloud_init.py::test_mac_mijia_config_uses_owner_volume_or_fake':
        'Requires an installed Mac profile and its deployment configuration.',
    'tests/hermes/test_cloud_init.py::test_persona_and_main_skill_references_are_discoverable':
        'Requires a separately supplied Mac profile for the skill-discovery comparison.',
    'tests/hermes/test_cloud_init.py::test_mac_staging_launcher_isolates_authority_before_start':
        'Requires a separately supplied Mac staging launcher.',
}
EXECUTOR_OMISSIONS = {
    'test_payment_privacy':
        'Its test requires an earlier Gateway/Integration Git object not present in this repository.',
    'test_payment_release_equality':
        'Its test compares the current guard with an earlier Git object not present here.',
}


def test_environment(temp_root, suite):
    env = dict(os.environ)
    source = ROOT / '.scratch/hermes-source'
    hermes_python = ROOT / '.scratch/hermes-venv/bin/python'
    phone_locks = ROOT / '.scratch/phone-locks'
    phone_locks.mkdir(parents=True, exist_ok=True)
    env.update(PYTHONDONTWRITEBYTECODE='1', HERMES_DISABLE_LAZY_INSTALLS='1',
               GIT_CEILING_DIRECTORIES=str(ROOT.parent),
               NODE_COMPILE_CACHE=str(ROOT / '.scratch/node-compile-cache'),
               PYTHONPATH=os.pathsep.join([str(source), str(ROOT)]),
               HERMES_HOME=str(temp_root / 'test-home'), TMPDIR=str(temp_root),
               HERMES_SOURCE=str(source), HERMES_NATIVE_SOURCE=str(source),
               PAIOS_HERMES_UPSTREAM_SOURCE=str(source), PAIOS_NATIVE_CONTRACT_SOURCE_ROOT=str(source),
               PAIOS_NATIVE_SOURCE_TEST_ROOT=str(source), PAIOS_HERMES_REBUILD_DIR=str(source),
               PAIOS_NATIVE_TEST_PYTHON=str(hermes_python), PAIOS_HERMES_PYTHON=str(hermes_python),
               PAIOS_VISION_PYTHON=env.get('PAIOS_VISION_PYTHON', str(hermes_python)),
               PAIOS_PHONE_LOCK_DIR=str(phone_locks),
               PAIOS_MODEL_ROOT=str(ROOT / '.scratch/no-model-assets'))
    if suite in ('integration', 'executor'):
        env['PAIOS_EXECUTOR_PYTHON'] = str(ROOT / '.scratch/executor-venv/bin/python')
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite', choices=['gateway', 'integration', 'hermes', 'executor', 'list'])
    args = parser.parse_args()
    if args.suite == 'list':
        print(json.dumps({'node': NODE_OMISSIONS, 'python': PYTHON_OMISSIONS,
                          'executor': EXECUTOR_OMISSIONS}, ensure_ascii=False, indent=2))
        return 0
    # Runtime and pytest scratch data must stay outside the protected source tree.
    with tempfile.TemporaryDirectory(prefix='paios-public-ci-') as folder:
        return run_suite(args.suite, test_environment(Path(folder), args.suite))


def run_suite(suite, env):
    if suite in PACKAGES:
        package = PACKAGES[suite]
        for name, reason in NODE_OMISSIONS[suite].items():
            print(f'OMITTED {name}: {reason}', flush=True)
        pattern = '|'.join('^' + re.escape(name) + '$' for name in NODE_OMISSIONS[suite])
        command = ['node', '--test', '--test-concurrency=1', '--test-reporter=spec',
                   '--test-skip-pattern=' + pattern,
                   *[str(p.relative_to(package)) for p in sorted((package / 'tests').glob('*.test.ts'))]]
        return subprocess.run(command, cwd=package, env=env).returncode
    if suite == 'hermes':
        for name, reason in PYTHON_OMISSIONS.items():
            print(f'OMITTED {name}: {reason}', flush=True)
        command = [env['PAIOS_HERMES_PYTHON'], '-m', 'pytest', '-q', '-p', 'no:cacheprovider',
                   *['--deselect=' + name for name in PYTHON_OMISSIONS], 'tests/hermes/',
                   'capability/sdk/python/test_yimi_receipt.py']
        return subprocess.run(command, cwd=ROOT, env=env).returncode
    python = ROOT / '.scratch/executor-venv/bin/python'
    package = ROOT / 'integrations/connectors/phone_executor'
    for name, reason in EXECUTOR_OMISSIONS.items():
        print(f'OMITTED {name}: {reason}', flush=True)
    modules = [p.stem for p in sorted(package.glob('test_*.py')) if p.stem not in EXECUTOR_OMISSIONS]
    return subprocess.run([str(python), '-m', 'unittest', *modules], cwd=package, env=env).returncode


if __name__ == '__main__':
    sys.exit(main())
