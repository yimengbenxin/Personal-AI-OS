"""The release entry point with real Git, real files and a fake Docker/Compose boundary; no daemon or host writes."""
import fcntl
from contextlib import contextmanager, nullcontext
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
import release
import release_build
import release_checks
import release_source
from watchdog_platform import point

IMAGE = {role: 'sha256:' + c * 64 for role, c in zip(('gateway', 'hermes', 'front', 'workshop', 'watchdog'), 'abcde')}


@pytest.fixture
def prune_stack(tmp_path, monkeypatch):
    host = release.Host({'root': str(tmp_path), 'stage': 'production', 'native_root': str(tmp_path / 'native')})
    host.state = tmp_path / 'state'
    host.state.mkdir()
    native = Path(host.config['native_root'])
    rows, removed = {}, []
    for index, name in enumerate(('current', 'previous', 'seed', 'unused'), 1):
        path = host.releases / name
        (path / '.release').mkdir(parents=True)
        image = 'sha256:' + f'{index:064x}'
        (path / '.release/build.json').write_text(json.dumps({'images': {'hermes': {'id': image}}}))
        (native / name).mkdir(parents=True)
        build = path / 'deploy/cloud/.build'
        build.mkdir(parents=True)
        (build / 'hermes').symlink_to(native / name)
        rows[name] = (path, image)
    for name in ('current', 'previous'):
        point(host.root, name, rows[name][0])
    def docker(command, **options):
        if command == ['docker', 'ps', '-q']:
            return SimpleNamespace(stdout='')
        assert command[:3] == ['docker', 'image', 'rm']
        removed.append(command[-1])
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(release.subprocess, 'run', docker)
    return host, native, rows, removed


@pytest.mark.parametrize('kind', ['directory', 'symlink', 'url'])
def test_prune_preserves_configured_local_seed_and_its_native_target(prune_stack, capsys, kind):
    host, native, rows, removed = prune_stack
    seed = rows['seed'][0] / 'producer'
    if kind == 'symlink':
        # The configured seed need not be the release's usual .build/hermes symlink.
        target = native / 'configured-input'
        target.mkdir()
        seed.symlink_to(target)
    else:
        seed.mkdir()
    host.config['hermes_source'] = 'https://example.invalid/hermes.git' if kind == 'url' else str(seed)
    release.cmd_prune(host, SimpleNamespace(execute=True))
    result = json.loads(capsys.readouterr().out)
    retained = {'current', 'previous'} | ({'seed'} if kind != 'url' else set())
    assert {p.name for p in host.releases.iterdir()} == retained
    assert set(removed) == {image for name, (_, image) in rows.items() if name not in retained}
    assert set(result['keep']) == {str(rows[name][0].resolve()) for name in retained}
    assert {p.name for p in native.iterdir()} == retained | ({'configured-input'} if kind == 'symlink' else set())
    if kind != 'url':
        assert seed.is_dir(), 'the next native export can still read its configured source'


@pytest.mark.parametrize('execute', [False, True])
def test_prune_plans_from_the_pointer_observed_after_acquiring_the_release_lock(prune_stack, capsys, monkeypatch, execute):
    host, native, rows, removed = prune_stack
    original = host.locked
    @contextmanager
    def locked():
        with original() as lock:
            point(host.root, 'current', rows['seed'][0])
            yield lock
    monkeypatch.setattr(host, 'locked', locked)
    release.cmd_prune(host, SimpleNamespace(execute=execute))
    result = json.loads(capsys.readouterr().out)
    assert set(result['keep']) == {str(rows[name][0].resolve()) for name in ('seed', 'previous')}
    assert {Path(row['release']).name for row in result['remove']} == {'current', 'unused'}
    assert rows['seed'][0].is_dir() and (native / 'seed').is_dir()
    assert set(removed) == ({rows[name][1] for name in ('current', 'unused')} if execute else set())


def test_drill_build_uses_a_local_from_tag_bound_to_the_pinned_gateway(tmp_path):
    """Run the real Bash entry through its first fault-image build, without a daemon."""
    root, tools, bin_dir = (tmp_path / name for name in ('stack', 'tools', 'bin'))
    for path in (root, tools, bin_dir):
        path.mkdir()
    good = IMAGE['gateway']
    ids = {'candidate': good, 'old': IMAGE['hermes']}
    for name, image_id in ids.items():
        state = root / name / '.release'
        state.mkdir(parents=True)
        (state / 'env').write_text('PAIOS_GATEWAY_IMAGE=' + image_id + '\n')
    for pointer, name in (('current', 'candidate'), ('previous', 'old')):
        (root / pointer).symlink_to(root / name)
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({'root': str(root), 'project': 'fixture', 'stage': 'staging'}))
    script = tools / 'release-drill.sh'
    script.write_bytes((ROOT / 'deploy/cloud/release-drill.sh').read_bytes())
    (tools / 'release.py').write_text('''import json,sys
from pathlib import Path
assert sys.argv[1]=='--config' and sys.argv[3:]==['rollback']
root=Path(json.loads(Path(sys.argv[2]).read_text())['root'])
current,previous=(root/'current').resolve(),(root/'previous').resolve()
for name,target in [('current',previous),('previous',current)]:
    (root/name).unlink();(root/name).symlink_to(target)
''')
    calls, tagged = tmp_path / 'docker.jsonl', tmp_path / 'tag.json'
    (bin_dir / 'docker').write_text(f'''#!{sys.executable}
import json,sys
from pathlib import Path
args=sys.argv[1:];root=Path({str(root)!r});tagged=Path({str(tagged)!r})
with open({str(calls)!r},'a') as f:f.write(json.dumps(args)+'\\n')
if args[0]=='ps':print((root/'current').resolve().name)
elif args[0]=='inspect':print({ids!r}[args[-1]])
elif args[:2]==['image','tag']:
    assert args[2]=={good!r};tagged.write_text(json.dumps(args[2:]))
elif args[0]=='build' and '--build-arg' in args:
    base=args[args.index('--build-arg')+1].removeprefix('GOOD_IMAGE=')
    if base.startswith('sha256:'):
        print('FROM resolved as docker.io/library/sha256 instead of the local image',file=sys.stderr);sys.exit(42)
    assert json.loads(tagged.read_text())==[{good!r},base]
elif args[0]=='build' and args[-1]=='-':sys.exit(73)  # Stop at the next fixture build.
else:raise AssertionError(args)
''')
    (bin_dir / 'docker').chmod(0o755)
    env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
    legacy = subprocess.run(['docker', 'build', '--build-arg', 'GOOD_IMAGE=' + good], env=env, capture_output=True, text=True)
    assert legacy.returncode == 42 and 'docker.io/library/sha256' in legacy.stderr
    calls.write_text('')
    result = subprocess.run(['bash', str(script), str(config)], env=env, capture_output=True, text=True)
    assert result.returncode == 73, result.stdout + result.stderr
    rows = [json.loads(line) for line in calls.read_text().splitlines()]
    tag = 'paios-gateway:watchdog-base-' + good.removeprefix('sha256:')
    binding = ['image', 'tag', good, tag]
    build = next(row for row in rows if row[0] == 'build' and '--build-arg' in row)
    assert rows.index(binding) < rows.index(build)
    assert build[build.index('--build-arg') + 1] == 'GOOD_IMAGE=' + tag


@pytest.mark.parametrize('boundary', ['disk', 'monitor'])
def test_guarded_joins_its_shell_and_signal_resistant_child_on_cancellation(tmp_path, monkeypatch, boundary):
    child_pid = tmp_path / 'child.pid'
    script = tmp_path / 'build.sh'
    child = ('import os,signal,time;from pathlib import Path;'
             'signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN);'
             f'Path({str(child_pid)!r}).write_text(str(os.getpid()));time.sleep(300)')
    import shlex
    script.write_text("trap '' INT TERM\n" + shlex.quote(sys.executable) + ' -c ' + shlex.quote(child) + ' &\nwait\n')
    popen = subprocess.Popen
    processes = []
    def start(*args, **kwargs):
        process = popen(*args, **kwargs)
        wait = process.wait
        # Exercise real signals and joins without waiting the production grace periods.
        process.wait = lambda timeout=None: wait(timeout=min(timeout, .05) if timeout is not None else None)
        processes.append(process)
        return process
    def disk_usage(_path):
        if child_pid.exists():
            if boundary == 'monitor':
                raise OSError('MONITOR_FAILED')
            return SimpleNamespace(free=1)
        return SimpleNamespace(free=100)
    monkeypatch.setattr(release_build.subprocess, 'Popen', start)
    monkeypatch.setattr(release_build.shutil, 'disk_usage', disk_usage)
    try:
        error, message = (RuntimeError, '^DISK_GUARD$') if boundary == 'disk' else (OSError, 'MONITOR_FAILED')
        with pytest.raises(error, match=message):
            release_build.guarded(['/bin/sh', str(script)], tmp_path, os.environ.copy(), tmp_path / 'build.log', 10)
        process = processes[0]
        assert process.returncode is not None, 'the owned shell is reaped before cancellation returns'
        pid = int(child_pid.read_text())
        state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        assert not state or state.startswith('Z'), 'the owned descendant must not remain running'
    finally:
        # Exact fixture PIDs only, including cleanup when the pre-fix implementation leaks its child.
        for pid in ([int(child_pid.read_text())] if child_pid.exists() else []) + [p.pid for p in processes if p.poll() is None]:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in processes:
            process.wait()


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', *args],
                          check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    git(work, 'init', '-q')
    (work / '.dockerignore').write_text('**/node_modules\n**/.env.*\n!**/.env.example\ndeploy/cloud/.build\n.release\n')
    (work / 'deploy/cloud').mkdir(parents=True)
    (work / 'deploy/cloud/build.sh').write_text('#!/bin/sh\n')
    (work / 'deploy/cloud/build.sh').chmod(0o755)
    (work / 'scripts/call-handoff-eval').mkdir(parents=True)
    (work / 'scripts/call-handoff-eval/eval.py').write_text('print(1)\n')
    (work / 'integrations').mkdir()
    (work / 'integrations/tool.py').write_text('x = 1\n')
    (work / 'integrations/.env.example').write_text('A=1\n')
    os.symlink('tool.py', work / 'integrations/link.py')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'base')
    bare = tmp_path / 'source.git'
    subprocess.run(['git', 'clone', '-q', '--bare', str(work), str(bare)], check=True)
    return SimpleNamespace(work=work, bare=bare, base=git(work, 'rev-parse', 'HEAD'), releases=tmp_path / 'releases')


def test_source_equals_the_whole_docker_context_two_way_with_kinds(repo):
    target, receipt = release_source.materialize(repo.bare, repo.base, repo.releases)
    assert receipt['build_inputs_equal'] and receipt['docker_inputs'] == 6
    assert json.loads((target / '.release/source.json').read_text())['commit'] == repo.base
    # Ignored paths and release state never count.
    (target / 'integrations/node_modules').mkdir()
    (target / 'integrations/node_modules/x.js').write_text('')
    (target / 'integrations/.env.local').write_text('SECRET=1')
    (target / 'deploy/cloud/.build').mkdir()
    release_source.verify(repo.bare, target)
    # A file outside deploy/integrations/backend that Docker copies (audit D2: scripts/call-handoff-eval) is caught.
    (target / 'scripts/call-handoff-eval/stray.py').write_text('')
    with pytest.raises(ValueError, match='scripts/call-handoff-eval/stray.py'):
        release_source.verify(repo.bare, target)
    (target / 'scripts/call-handoff-eval/stray.py').unlink()
    (target / 'deploy/cloud/build.sh').chmod(0o644)
    assert release_source.compare(repo.bare, repo.base, target)['kind_mismatches'] == ['deploy/cloud/build.sh']
    (target / 'deploy/cloud/build.sh').chmod(0o755)
    (target / 'integrations/link.py').unlink()
    (target / 'integrations/link.py').write_text('x = 1\n')
    assert release_source.compare(repo.bare, repo.base, target)['kind_mismatches'] == ['integrations/link.py']
    (target / 'integrations/link.py').unlink()
    os.symlink('tool.py', target / 'integrations/link.py')
    (target / 'integrations/empty').mkdir()
    assert release_source.compare(repo.bare, repo.base, target)['extra'] == ['integrations/empty']
    with pytest.raises(ValueError, match='PRESERVE_EXISTING_RELEASE'):
        release_source.materialize(repo.bare, repo.base, repo.releases)


def test_agent_patch_commits_on_its_exact_base_and_protected_paths_are_named(repo, tmp_path):
    (repo.work / 'integrations/tool.py').write_text('x = 2\n')
    (repo.work / 'deploy/cloud/build.sh').write_text('#!/bin/sh\necho changed\n')
    git(repo.work, 'commit', '-q', '-am', 'fix')
    patch_file = tmp_path / 'candidate.patch'
    patch_file.write_text(git(repo.work, 'format-patch', '--binary', '--stdout', repo.base + '..HEAD') + '\n')
    commit = release_source.apply_patch(repo.bare, repo.base, patch_file, 'candidates/abc')
    assert git(repo.bare, 'rev-parse', commit + '^') == repo.base
    assert release_source.protected_changes(repo.bare, repo.base, commit) == ['deploy/cloud/build.sh']


def test_every_protected_baseline_of_the_handbook_has_its_source_listed():
    for path in (release_source.I + 'payment/authority.ts',
                 'integrations/connectors/phone_executor/payment_guard.py',
                 release_source.G + 'owner-mac-ssh.ts', release_source.I + 'care/authority.ts',
                 release_source.I + 'voiceprint/registry.ts', release_source.G + 'call-speech-identity.ts',
                 release_source.H + 'effects.py', 'deploy/cloud/release.py'):
        assert path.startswith(release_source.PROTECTED), path


def test_suites_gate_on_new_failure_names_and_never_pass_an_unexplained_exit(tmp_path):
    state = tmp_path / '.release'
    state.mkdir()
    release_build.write(state / 'build.json', {'images': {r: {'id': IMAGE[r]} for r in IMAGE}})
    baseline = tmp_path / 'baseline.json'
    baseline.write_text(json.dumps({'suites': {'gateway': {'failures': ['known flaky']}}}))
    logs = {'gateway': (1, '✖ known flaky (12ms)\n✖ new break (3.1ms)\n'),
            'hermes': (1, 'FAILED tests/hermes/test_x.py::test_y - x\nERROR tests/hermes/test_z.py::test_fixture - missing\n'),
            'native-gateway': (1, '✖ known flaky (12ms)\n'), 'native-integration': (0, ''),
            'executor': (1, 'Traceback\n'), 'integration': (0, ''), 'platform-data': (0, '')}
    def fake_run(command, **options):
        workdir = command[command.index('-w') + 1]
        name = next(n for n, (_, path, cmd) in release_build.SUITES.items() if path == workdir and cmd == command[-1])
        code, out = logs[name]
        return SimpleNamespace(returncode=code, stdout=out, stderr='')
    with patch.object(release_build, 'pytest_cache', return_value='vol'), \
            patch.object(release_build, 'suite_backend', side_effect=lambda image: nullcontext('backend')), \
            patch('subprocess.run', side_effect=fake_run):
        result = release_build.suites({'repo': '/source.git'}, tmp_path, baseline, model_source='fixture-models')
    assert not result['passed']
    assert result['suites']['gateway']['new_failures'] == ['new break']
    assert result['suites']['hermes']['new_failures'] == ['tests/hermes/test_x.py::test_y', 'tests/hermes/test_z.py::test_fixture']
    assert result['suites']['native-gateway']['new_failures'] == []
    assert result['suites']['executor']['unexplained_failure']
    assert json.loads((state / 'suites.json').read_text())['passed'] is False


def test_hermes_suite_reads_backend_and_native_dependencies_from_the_gateway_candidate(tmp_path, monkeypatch):
    """The host source lacks installed packages; cross-runtime tests need the exact shipped gateway tree."""
    import shutil
    state = tmp_path / '.release'
    state.mkdir()
    package = tmp_path / release_build.BACKEND.removeprefix('/opt/paios/') / 'phase0/gateway/package.json'
    package.parent.mkdir(parents=True)
    package.write_text(json.dumps({'devDependencies': {'typescript': '5.9.3'}}))
    release_build.write(state / 'build.json', {'images': {r: {'id': IMAGE[r]} for r in IMAGE}})
    shipped = tmp_path / 'gateway-image/backend'
    module = 'services/personal-aios-integration/src/visual/store.ts'
    dependency = 'services/personal-aios-integration/node_modules/sqlite-vec/native.so'
    for path, data in ((module, 'candidate visual source'), (dependency, 'candidate native library')):
        target = shipped / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data)
    volume = tmp_path / 'suite-volume'
    volume.mkdir()
    observed = []
    checked = set()
    def run(command, **options):
        if command[:3] == ['docker', 'volume', 'create']:
            volume.mkdir(exist_ok=True)
            return SimpleNamespace(stdout=str(volume) + '\n')
        if command[:3] == ['docker', 'volume', 'rm']:
            assert command[-1] == str(volume)
            shutil.rmtree(volume)
        elif '--entrypoint' in command and command[command.index('--entrypoint') + 1] == 'sh':
            assert command[-3] == IMAGE['gateway']
            assert '--network' in command and command[command.index('--network') + 1] == 'none'
            shutil.copytree(shipped, volume / 'backend')
        elif '-w' in command:
            workdir = command[command.index('-w') + 1]
            name = next(name for name, (_, path, cmd) in release_build.SUITES.items() if path == workdir and cmd == command[-1])
            checked.add(name)
            image = command[command.index('--entrypoint') + 2]
            env = dict(command[i + 1].split('=', 1) for i, arg in enumerate(command) if arg == '-e')
            assert 'fixture-models:/opt/models:ro' in command and env['PAIOS_MODEL_ROOT'] == '/opt/models'
            for path in ('tests', 'deploy', 'scripts'):
                assert f'{tmp_path}/{path}:/opt/paios/{path}:ro' in command
            assert any('CompanionService.kt:/opt/paios/' in arg and arg.endswith(':ro') for arg in command)
            assert any('/app/Contracts:/opt/paios/' in arg and arg.endswith(':ro') for arg in command)
            assert any('formal-message.v1.json:/opt/paios/01-product-half-finished/glasses' in arg for arg in command)
            assert any('rayneo_debug_local_audio.pcm.gz.b64:/opt/paios/' in arg and arg.endswith(':ro') for arg in command)
            assert '/opt/paios/.scratch:size=256m,uid=10000,gid=10000,mode=0700,exec' in command
            assert command[command.index('--memory') + 1] == '2g'
            if name in ('gateway', 'integration', 'platform-data'):
                assert image == IMAGE['gateway']
            ts_mount = (f'type=volume,src=pytest,dst={release_build.BACKEND}/phase0/gateway/node_modules/typescript,'
                        'volume-subpath=node_modules/typescript,readonly')
            assert (ts_mount in command) == (name == 'gateway')
            if name == 'integration':
                assert env['PAIOS_DEMUX_TOOLCHAIN'] == '/usr/bin'
                assert "--test-skip-pattern='^legacy care run tools retain native isolation across provider HTTP$'" in command[-1]
            if name.startswith('native-'):
                assert image == IMAGE['hermes']
                assert env['PAIOS_NATIVE_SOURCE_TEST_ROOT'] == env['PAIOS_HERMES_REBUILD_DIR'] == '/opt/hermes'
                assert env['PAIOS_HERMES_PYTHON'] == env['PAIOS_NATIVE_TEST_PYTHON'] == '/opt/hermes/.venv/bin/python'
                assert f'type=volume,src={volume},dst={release_build.BACKEND},volume-subpath=backend,readonly' in command
                assert (volume / 'backend' / module).read_text() == 'candidate visual source'
            if '/opt/paios-phone/bin/python' in command[-1]:
                assert f'type=volume,src={volume},dst={release_build.BACKEND},volume-subpath=backend,readonly' in command
                assert (volume / 'backend' / module).read_text() == 'candidate visual source'
                assert env['PAIOS_TEST_CJK_FONT'] == '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
            else:
                assert 'PAIOS_TEST_CJK_FONT' not in env
            if command[command.index('-w') + 1] == '/opt/paios':
                assert '/source.git:/opt/paios/.git:ro' in command
                assert env['GIT_CONFIG_VALUE_0'] == '/opt/paios'
                assert f'type=volume,src={volume},dst={release_build.BACKEND},volume-subpath=backend,readonly' in command
                assert {key: env[key] for key in ('PAIOS_NATIVE_SOURCE_TEST_ROOT', 'HERMES_NATIVE_SOURCE', 'HERMES_SOURCE')} == {
                    'PAIOS_NATIVE_SOURCE_TEST_ROOT': '/opt/hermes', 'HERMES_NATIVE_SOURCE': '/opt/hermes',
                    'HERMES_SOURCE': '/opt/hermes'}
                assert env['PAIOS_HERMES_PYTHON'] == '/opt/hermes/.venv/bin/python'
                assert command[command.index('--entrypoint') + 2] == IMAGE['hermes']
                observed.extend((volume / 'backend' / p).read_text() for p in (module, dependency))
                # A real failed suite still releases its temporary candidate inputs.
                return SimpleNamespace(returncode=1, stdout='FAILED tests/hermes/test_cloud_init.py::visual - fixture\n', stderr='')
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        return SimpleNamespace(stdout='')
    def cache(image, candidate):
        assert image == IMAGE['hermes'] and candidate == tmp_path
        return 'pytest'
    monkeypatch.setattr(release_build, 'pytest_cache', cache)
    monkeypatch.setattr(release_build.subprocess, 'run', run)
    result = release_build.suites({'repo': '/source.git'}, tmp_path, model_source='fixture-models')
    assert observed == ['candidate visual source', 'candidate native library']
    assert checked == {'gateway', 'integration', 'platform-data', 'native-gateway', 'native-integration', 'hermes', 'executor'}
    assert not result['passed'] and not volume.exists()


def test_failed_pytest_cache_install_is_removed_so_the_next_run_retries(tmp_path, monkeypatch):
    existing, attempts = set(), 0
    package = tmp_path / release_build.BACKEND.removeprefix('/opt/paios/') / 'phase0/gateway/package.json'
    package.parent.mkdir(parents=True)
    package.write_text(json.dumps({'devDependencies': {'typescript': '5.9.3'}}))
    def run(command, **options):
        nonlocal attempts
        if command[:3] == ['docker', 'volume', 'inspect']:
            return SimpleNamespace(returncode=0 if command[-1] in existing else 1)
        if command[:3] == ['docker', 'volume', 'create']:
            existing.add(command[-1])
        elif command[:3] == ['docker', 'volume', 'rm']:
            existing.remove(command[-1])
        else:
            attempts += 1
            assert 'numpy==2.2.6 opencv-python-headless==4.12.0.88' in command[-1]
            version = command[command.index('-e') + 1].split('=', 1)[1]
            assert command[command.index('-v') + 1].endswith('-vision-v1-ts-' + version + ':/target')
            assert command[-2] == '-ec'
            assert 'npm install --prefix /target --ignore-scripts --no-audit --no-fund "typescript@$PAIOS_TEST_TYPESCRIPT"' in command[-1]
            if attempts == 1:
                raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(release_build.subprocess, 'run', run)
    with pytest.raises(subprocess.CalledProcessError):
        release_build.pytest_cache(IMAGE['hermes'], tmp_path)
    assert not existing
    assert release_build.pytest_cache(IMAGE['hermes'], tmp_path).startswith('paios-release-pytest-')
    assert existing and attempts == 2
    release_build.pytest_cache(IMAGE['hermes'], tmp_path)
    assert attempts == 2
    first = set(existing)
    package.write_text(json.dumps({'devDependencies': {'typescript': '5.9.4'}}))
    release_build.pytest_cache(IMAGE['hermes'], tmp_path)
    assert attempts == 3 and len(existing - first) == 1


def test_native_suite_file_ownership_is_complete_and_disjoint():
    import re
    for name in ('gateway', 'integration'):
        _, workdir, ordinary = release_build.SUITES[name]
        root = ROOT / workdir.removeprefix('/opt/paios/')
        expanded = subprocess.run(['bash', '-O', 'extglob', '-c', 'printf "%s\\n" ' + ordinary.split()[-1]],
                                  cwd=root, check=True, capture_output=True, text=True)
        ordinary_files = set(expanded.stdout.splitlines())
        native = release_build.SUITES['native-' + name][2]
        native_files = set(re.findall(r'tests/[a-z-]+\.test\.ts', native))
        expected = {'tests/' + path.name for path in (root / 'tests').glob('*.test.ts')}
        overlap = {'tests/server.test.ts'} if name == 'integration' else set()
        assert ordinary_files & native_files == overlap
        assert ordinary_files | native_files == expected
        if overlap:
            assert "--test-skip-pattern='" + release_build.CARE_NATIVE + "'" in ordinary
            assert "--test-name-pattern='" + release_build.CARE_NATIVE + "' tests/server.test.ts" in native


@pytest.mark.parametrize('existing', [False, True])
def test_interrupted_receipt_write_never_publishes_partial_completion(tmp_path, monkeypatch, existing):
    receipt = tmp_path / 'build.json'
    if existing:
        release_build.write(receipt, {'finished_at': 'old'})
    before = receipt.read_text() if existing else None
    def interrupted_replace(*args):
        raise KeyboardInterrupt()
    with monkeypatch.context() as interrupted:
        interrupted.setattr(Path, 'replace', interrupted_replace)
        with pytest.raises(KeyboardInterrupt):
            release_build.write(receipt, {'finished_at': 'new', 'summary': '修复'})
    assert receipt.read_text() == before if existing else not receipt.exists()
    value = {'finished_at': 'new', 'summary': '修复'}
    release_build.write(receipt, value)
    assert receipt.read_text() == json.dumps(value, indent=2, ensure_ascii=False) + '\n'
    assert receipt.stat().st_mode & 0o777 == 0o600


def test_accept_binds_build_suites_and_staging_to_one_image_set(tmp_path):
    state = tmp_path / '.release'
    state.mkdir()
    release_build.write(state / 'build.json', {'commit': 'c' * 40, 'images': {r: {'id': IMAGE[r]} for r in IMAGE}})
    release_build.write(state / 'suites.json', {'passed': True, 'images': {k: IMAGE[k] for k in ('gateway', 'hermes')}})
    staged = {'regression_passed': True, 'snapshot': 'snapshot-x.age', 'window_hours': 0,
              'candidate_images': {k: IMAGE[k] for k in ('gateway', 'hermes', 'workshop')}}
    assert release_build.accept(tmp_path, staged)['raw_media_verified'] is False
    with pytest.raises(ValueError, match='CANDIDATE_DRIFT'):
        release_build.accept(tmp_path, {**staged, 'candidate_images': {**staged['candidate_images'], 'gateway': IMAGE['front']}})
    with pytest.raises(ValueError, match='GATE_FAILED'):
        release_build.accept(tmp_path, {**staged, 'regression_passed': False})


def test_drain_asks_the_gateway_call_authority_and_ignores_presence_rooms_and_persisted_completions():
    calls = []
    resources = {'schema': 'paios.gateway.resources.v1', 'terminals': [{'resources': {'call': {'camera': 'idle'}}}]}
    def run(args, **options):
        calls.append(args)
        if args[0] == 'exec' and 'resources' in args[-1]:
            return SimpleNamespace(stdout=json.dumps(resources))
        if args[0] == 'exec' and args[2].startswith('hermes'):
            return SimpleNamespace(stdout=json.dumps({'session_turn_leases': 0, 'compression_locks': 0, 'active_api_runs': 0, 'active_delegations': 0}))
        if args[0] == 'exec':
            return SimpleNamespace(stdout='{"running_errands": 0}')
        if args[0] == 'ps':
            return SimpleNamespace(stdout='id1\n')
        return SimpleNamespace(stdout='')
    inspect = SimpleNamespace(stdout=json.dumps([{'Config': {'Labels': {'com.docker.compose.service': 'gateway'}}, 'State': {'OOMKilled': False}}]))
    with patch('subprocess.run', return_value=inspect):
        assert release_checks.drain(run)['passed']
    assert 'process_completions' not in release_checks.NATIVE_DRAIN and not any('ListRooms' in ' '.join(a) for a in calls)
    resources['terminals'][0]['resources']['call'] = {'call_id': 'live'}
    with patch('subprocess.run', return_value=inspect), pytest.raises(ValueError, match='BUSY'):
        release_checks.drain(run)


class Stack:
    """Two release dirs under one pointer root and a recorded fake service lifecycle."""
    def __init__(self, tmp_path, monkeypatch, fail_start=False, loaded=True):
        self.root = tmp_path / 'paios'
        self.events, self.started = [], []
        for name in ('old', 'cand'):
            state = self.root / 'releases' / name / '.release'
            state.mkdir(parents=True)
            (state / 'env').write_text('PAIOS_SECRETS_DIR=/s\nPAIOS_GATEWAY_IMAGE=old\n')
        point(self.root, 'current', self.root / 'releases/old')
        release_build.write(self.root / 'releases/cand/.release/accepted.json', {'commit': 'c' * 40, 'images': IMAGE})
        self.host = release.Host({'stage': 'production', 'root': str(self.root), 'project': 'paios', 'profiles': ['production']})
        self.host.state = tmp_path / 'state'
        self.host.state.mkdir()
        def start(host, rel, run, receipt):
            self.started.append(rel.name)
            if fail_start and rel.name == 'cand':
                raise RuntimeError('CORE_POSTCHECK_FAILED')
        monkeypatch.setattr(release, 'start', start)
        monkeypatch.setattr(release, 'stop_writers', lambda host, run: self.events.append('stop'))
        monkeypatch.setattr(release, 'render', lambda host, rel: None)
        monkeypatch.setattr(release, 'front', lambda host, rel, sha: {'changed': False})
        monkeypatch.setattr(release, 'watchdog_record', lambda host, lock, mode, *a: self.events.append(mode) or mode)
        monkeypatch.setattr(release_checks, 'drain', lambda run, suffix='': {'passed': True})
        monkeypatch.setattr(release_checks, 'postcheck', lambda *a, **k: {'passed': True})
        monkeypatch.setattr(release_build, 'image_id', lambda ref: ref if loaded else 'sha256:' + '0' * 64)
        definition = {'services': {'postgres': {'command': ['postgres', '-p', '5432'], 'environment': {'POSTGRES_USER': 'u', 'POSTGRES_DB': 'd'}}}}
        monkeypatch.setattr(release.Host, 'definition', lambda host, rel: definition)
        monkeypatch.setattr(release.Host, 'runner', lambda host, rel: (lambda args, **o: self.events.append(args[0])))

    def pointers(self):
        return (self.root / 'current').resolve().name, (self.root / 'previous').resolve().name if (self.root / 'previous').exists() else None


def test_switch_prepares_rollback_before_any_change_and_arms_after_postcheck(tmp_path, monkeypatch):
    stack = Stack(tmp_path, monkeypatch)
    with open(tmp_path / 'lock', 'a') as lock:
        receipt = release.switch(stack.host, stack.root / 'releases/cand', lock)
    assert stack.pointers() == ('cand', 'old')
    assert stack.events.index('prepare') < stack.events.index('stop') < stack.events.index('arm')
    assert receipt['watchdog'] == 'armed' and stack.started == ['cand']
    env = (stack.root / 'releases/cand/.release/env').read_text()
    assert 'PAIOS_GATEWAY_IMAGE=' + IMAGE['gateway'] in env and 'PAIOS_SECRETS_DIR=/s' in env
    assert (stack.root / 'releases/cand/.release' / f"switch-{receipt['release_id']}.json").exists()
    events = [json.loads(line)['event'] for line in (stack.host.state / 'events.jsonl').read_text().splitlines()]
    assert events == ['switch_started', 'switch_passed']


def test_failed_gate_rolls_back_immediately_to_the_previous_release(tmp_path, monkeypatch):
    stack = Stack(tmp_path, monkeypatch, fail_start=True)
    with open(tmp_path / 'lock', 'a') as lock, pytest.raises(RuntimeError, match='CORE_POSTCHECK_FAILED'):
        release.switch(stack.host, stack.root / 'releases/cand', lock)
    assert stack.pointers() == ('old', 'cand') and stack.started == ['cand', 'old']
    assert 'arm' not in stack.events
    receipt = json.loads(next((stack.root / 'releases/cand/.release').glob('switch-*.json')).read_text())
    assert receipt['immediate_rollback']['to'].endswith('/old')


def test_candidate_drift_refuses_before_any_service_or_pointer_changes(tmp_path, monkeypatch):
    stack = Stack(tmp_path, monkeypatch, loaded=False)
    with open(tmp_path / 'lock', 'a') as lock, pytest.raises(ValueError, match='CANDIDATE_IMAGE_NOT_LOADED'):
        release.switch(stack.host, stack.root / 'releases/cand', lock)
    assert stack.events == [] and stack.pointers() == ('old', None)


def test_manual_rollback_swaps_back_and_forth(tmp_path, monkeypatch):
    stack = Stack(tmp_path, monkeypatch)
    point(stack.root, 'previous', stack.root / 'releases/cand')
    release.rollback(stack.host, 'drill')
    assert stack.pointers() == ('cand', 'old')
    release.rollback(stack.host, 'drill')
    assert stack.pointers() == ('old', 'cand') and stack.started == ['cand', 'old']


def test_operators_get_busy_while_the_release_lock_is_held_and_the_agent_queues(tmp_path):
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'project': 'p', 'profiles': ['staging']})
    host.state = tmp_path
    with open(tmp_path / 'release.lock', 'a') as holder:
        fcntl.flock(holder, fcntl.LOCK_EX)
        with pytest.raises(SystemExit) as busy:
            with host.locked():
                pass
        assert busy.value.code == release.BUSY
    with host.locked(wait=True) as lock:
        assert os.fstat(lock.fileno()).st_ino == (tmp_path / 'release.lock').stat().st_ino


def test_staging_failure_keeps_the_last_accepted_release_as_current(tmp_path, monkeypatch):
    stack = Stack(tmp_path, monkeypatch)
    cand = stack.root / 'releases/cand'
    release_build.write(cand / '.release/build.json', {'commit': 'c' * 40, 'images': {r: {'id': IMAGE[r]} for r in IMAGE}})
    release_build.write(cand / '.release/source.json', {'commit': 'c' * 40})
    settings = tmp_path / 'settings.json'
    settings.write_text(json.dumps({'lock': str(tmp_path / 'snap.lock'), 'evidence': str(tmp_path)}))
    stack.host.config.update(snapshot_settings=str(settings))
    import staging_snapshot_restore
    monkeypatch.setattr(staging_snapshot_restore, 'restore', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('regression failed')))
    with pytest.raises(RuntimeError):
        release.stage(stack.host, cand, tmp_path / 'snapshot-20261020T000000Z.age', None)
    assert stack.pointers()[0] == 'old'
    monkeypatch.setattr(staging_snapshot_restore, 'restore', lambda *a, **k: None)
    (tmp_path / 'snapshot-20261020T000000Z.json').write_text(json.dumps({'regression_passed': True, 'snapshot': 's', 'window_hours': 0,
        'candidate_images': {k: IMAGE[k] for k in ('gateway', 'hermes', 'workshop')}}))
    release_build.write(cand / '.release/suites.json', {'passed': True, 'images': {k: IMAGE[k] for k in ('gateway', 'hermes')}})
    release.stage(stack.host, cand, tmp_path / 'snapshot-20261020T000000Z.age', None)
    assert stack.pointers() == ('cand', 'old')


def test_repair_base_is_what_production_last_published_not_the_build_hosts_staging(tmp_path):
    exchange, requests = tmp_path / 'exchange', tmp_path / 'requests'
    exchange.mkdir()
    requests.mkdir()
    (exchange / 'production.json').write_text(json.dumps({'commit': 'p' * 40, 'release': 'pppppppp', 'images': {}}))
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'project': 'p', 'profiles': ['staging'],
                         'exchange': str(exchange), 'requests': str(requests)})
    host.state = tmp_path
    assert release.cmd_requests(host, None) == 0
    assert json.loads((requests / 'base.json').read_text())['commit'] == 'p' * 40




@pytest.mark.parametrize('interrupted_at', ['commit', 'build', 'suites', 'staging', 'export'])
def test_interrupted_request_resumes_its_commit_and_completed_receipts(tmp_path, repo, monkeypatch, interrupted_at):
    (repo.work / 'integrations/tool.py').write_text('x = 4\n')
    git(repo.work, 'commit', '-q', '-am', 'repair')
    request = tmp_path / 'requests/0123456789ab'
    request.mkdir(parents=True)
    (request / 'candidate.patch').write_text(git(repo.work, 'format-patch', '--binary', '--stdout', repo.base + '..HEAD') + '\n')
    (request / 'request.json').write_text(json.dumps({'request_id': request.name, 'base': repo.base}))
    old, _ = release_source.materialize(repo.bare, repo.base, repo.releases)
    point(tmp_path, 'current', old)
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'project': 'p', 'profiles': ['staging'],
                         'repo': str(repo.bare), 'requests': str(request.parent), 'exchange': str(tmp_path / 'exchange')})
    host.state = tmp_path
    (tmp_path / 'exchange').mkdir()
    release_build.write(tmp_path / 'exchange/production.json', {'commit': repo.base})
    monkeypatch.setattr(release.release_parity, 'ensure', lambda selected, lock: {'commit': repo.base})
    monkeypatch.setattr(host, 'refresh_base', lambda: None)
    monkeypatch.setattr(host, 'model_source', lambda: 'fixture-models')
    calls = {name: 0 for name in ('commit', 'build', 'suites', 'staging', 'export')}
    interrupted = False
    def interrupt(name):
        nonlocal interrupted
        calls[name] += 1
        if name == interrupted_at and not interrupted:
            interrupted = True
            raise KeyboardInterrupt()
    apply_patch = release_source.apply_patch
    def apply(*args):
        commit = apply_patch(*args)
        interrupt('commit')
        return commit
    def build(config, target):
        interrupt('build')
        release_build.write(target / '.release/build.json', {'images': {r: {'id': IMAGE[r]} for r in IMAGE}})
    def suites(config, target, baseline, *, model_source):
        assert model_source == 'fixture-models'
        interrupt('suites')
        value = {'passed': True, 'suites': {}}
        release_build.write(target / '.release/suites.json', value)
        return value
    def stage(selected, target, snapshot, lock):
        assert selected.release('current') == old
        selected.flip(target)
        interrupt('staging')
        value = {'commit': host.commit(target), 'images': IMAGE}
        release_build.write(target / '.release/accepted.json', value)
        return value
    def export(config, target, result, summary):
        package = Path(config['exchange']) / 'candidates' / request.name
        package.mkdir(parents=True)
        release_build.write(package / 'manifest.json', {'base': result['base'], 'commit': result['commit'],
                                                        'delta_bytes': 12, 'reused_bytes': 34})
        interrupt('export')
        return {'package': str(package), 'delta_bytes': 12, 'reused_bytes': 34}
    monkeypatch.setattr(release_build, 'build', build)
    monkeypatch.setattr(release_source, 'apply_patch', apply)
    monkeypatch.setattr(release_build, 'suites', suites)
    monkeypatch.setattr(release, 'stage', stage)
    monkeypatch.setattr(release.release_transfer, 'export', export)
    with pytest.raises(KeyboardInterrupt):
        release.candidate(host, request)
    pending = json.loads((request / 'result.json').read_text())
    assert 'finished_at' not in pending and 'failure' not in pending
    commit = git(repo.bare, 'rev-parse', 'refs/paios/candidates/' + request.name)
    if interrupted_at == 'build':
        assert 'build' not in pending['steps'] and not (repo.releases / commit[:8] / '.release/build.json').exists()
    monkeypatch.setattr(release_source, 'apply_patch', lambda *a: pytest.fail('must reuse the committed request'))
    if interrupted_at != 'commit':
        monkeypatch.setattr(release_source, 'materialize', lambda *a, **k: pytest.fail('must reuse its release directory'))
    assert release.cmd_requests(host, None) == 0
    completed = json.loads((request / 'result.json').read_text())
    assert completed['commit'] == commit and completed['started_at'] == pending['started_at']
    assert completed['finished_at'] and completed['ready_for_production']
    assert completed['transfer']['delta_bytes'] == 12
    assert calls == {name: 2 if name == interrupted_at and name not in ('commit', 'export') else 1 for name in calls}
    assert release.cmd_requests(host, None) == 0
    assert calls == {name: 2 if name == interrupted_at and name not in ('commit', 'export') else 1 for name in calls}


def test_native_producer_is_content_addressed_and_shared_by_every_release(tmp_path):
    """Two releases render the locked base from one tree-named native checkout; the export runs once."""
    upstream = Path(os.environ.get('PAIOS_NATIVE_SOURCE_TEST_ROOT', '/nonexistent')) / 'Dockerfile'
    if not upstream.is_file():
        pytest.skip('locked Hermes source is not available')
    bin_dir, calls = tmp_path / 'bin', tmp_path / 'node-calls.jsonl'
    bin_dir.mkdir()
    (bin_dir / 'node').write_text(f'''#!{sys.executable}
import json, os, shutil, sys
args = sys.argv[1:]
open({str(calls)!r}, 'a').write(json.dumps({{'args': args, 'optional_locks': os.environ.get('GIT_OPTIONAL_LOCKS')}}) + '\\n')
if '--keep' in args:
    target = args[args.index('--keep') + 1]
    os.mkdir(target)
    shutil.copyfile({str(upstream)!r}, os.path.join(target, 'Dockerfile'))
''')
    (bin_dir / 'node').chmod(0o755)
    tree = json.loads((ROOT / 'integrations/hermes/personal_aios/producer.lock.json').read_text())['result_tree']
    native = tmp_path / 'native'
    env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}', PAIOS_HERMES_NATIVE_ROOT=str(native),
               PAIOS_PUBLIC_API_URL='https://bj.example.invalid:9443', PAIOS_LEGACY_PUBLIC_API_URLS='')
    for name in ('one', 'two'):
        root = tmp_path / name
        for relative in ('deploy/cloud/prepare-build.py', 'deploy/cloud/staging_config.py', 'deploy/cloud/cloud.json', 'deploy/cloud/front.conf.in',
                         'deploy/cloud/paios_roaming_guard.js.in', 'deploy/cloud/paios-staging-snapshot.timer',
                         'integrations/hermes/personal_aios/producer.lock.json'):
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_bytes((ROOT / relative).read_bytes())
        subprocess.run([sys.executable, str(root / 'deploy/cloud/prepare-build.py')], env=env, check=True, capture_output=True)
        assert (root / 'deploy/cloud/.build/hermes').resolve() == (native / tree).resolve()
    rows = [json.loads(line) for line in calls.read_text().splitlines()]
    assert sum('--keep' in row['args'] for row in rows) == 1
    assert all(row['optional_locks'] == '0' for row in rows if '--check-running' in row['args'])
    assert not (native / (tree + '.partial')).exists()


@pytest.mark.parametrize('collision,current_inventory', [(True, False), (False, False), (True, True)])
def test_snapshot_skill_authority_gate_runs_before_staging_volume_changes(tmp_path, monkeypatch, collision, current_inventory):
    from contextlib import nullcontext
    from datetime import datetime, timezone
    import staging_snapshot_restore as restore
    import staging_snapshot_data as snapshot_data
    from tools.skill_product import check_local_collisions
    integration = ROOT / 'integrations/hermes/personal_aios'
    snapshot_home = tmp_path / 'production-snapshot'
    skill = snapshot_home / 'skills/errands' / ('cloud-phone' if collision else 'learned-method') / 'SKILL.md'
    skill.parent.mkdir(parents=True)
    skill.write_text((integration / 'errands/cloud-phone/SKILL.md').read_text().replace(
        'name: cloud-phone', 'name: cloud-phone' if collision else 'name: learned-method') +
        '\nLoad the categorized path; accept restore only at phone_status stage=ready, installing is busy.\n')
    gates = []
    inventory_file = None
    if current_inventory:
        import release_inventory
        fresh = tmp_path / 'current-home'
        (fresh / 'skills').mkdir(parents=True)
        (fresh / 'config.yaml').write_text('mcp_servers: {}\n')
        inventory_file = tmp_path / 'current-inventory.tar.gz'
        release_inventory.pack(fresh, inventory_file)
        monkeypatch.setenv('PAIOS_STAGE', 'staging')
        monkeypatch.setattr(os, 'chown', lambda *args: None)
    class Fixture:
        definition = {'services': {'hermes-staging': {'image': 'fixture-candidate-hermes'}}}
        def __init__(self, *args, **kwargs):
            pass
        def maintenance(self, held=None):
            return nullcontext()
        def tools(self, args, work, **options):
            if len(args) > 1 and args[1].endswith('/release_inventory.py'):
                import release_inventory
                release_inventory.install(work / 'inventory.tar.gz', work / 'current-inventory')
            if options.get('entrypoint'):
                assert options['image'] == 'fixture-candidate-hermes'
                script = args[1].replace("'/work/data/hermes-home/skills'", repr(str(work / 'data/hermes-home/skills')))
                script = script.replace("'/opt/paios/integrations/hermes/personal_aios'", repr(str(integration)))
                # Execute the exact staging gate with real native discovery, replacing Docker only.
                exec(compile(script, '<staging-skill-gate>', 'exec'), {})
                gates.append('passed')
        def volume(self, name):
            raise RuntimeError('volume_boundary')
    def decrypt(snapshot, identity, work):
        snapshot_data.copy_tree(snapshot_home, work / 'data/hermes-home', hermes=True)
        (work / 'manifest.json').write_text(json.dumps({'schema': 'paios.staging-snapshot.v1',
            'window_hours': 0, 'consistency': 'all-application-writers-stopped',
            'as_of': datetime.now(timezone.utc).isoformat()}))
    monkeypatch.setattr(restore, 'Stack', Fixture)
    monkeypatch.setattr(restore, 'preflight', lambda *args: None)
    monkeypatch.setattr(restore, 'decrypt', decrypt)
    envelope = tmp_path / 'snapshot-20261020T031800Z.age'
    envelope.touch()
    settings = {'evidence': str(tmp_path / 'evidence'), 'scratch': str(tmp_path), 'identity_file': 'fixture'}
    rejected = collision and not current_inventory
    with pytest.raises(ValueError if rejected else RuntimeError,
                       match='SKILL_AUTHORITY_COLLISION.*cloud-phone' if rejected else 'volume_boundary'):
        restore.restore(settings, envelope, True, inventory=inventory_file)
    assert gates == ([] if rejected else ['passed'])
    assert skill.exists()  # Both the snapshot copy and the proposed learning are preserved.
    if collision:
        with pytest.raises(ValueError, match='reconcile local skills with product authority'):
            check_local_collisions(snapshot_home / 'skills', [integration / 'errands', integration / 'shared-skills'])


def test_suite_models_use_the_compose_declared_source_and_runtime_target(tmp_path, monkeypatch):
    host = release.Host({'root': str(tmp_path), 'stage': 'staging'})
    monkeypatch.setattr(host, 'release', lambda name: tmp_path)
    definition = {'services': {'gateway-staging': {'environment': {'PAIOS_MODEL_ROOT': '/actual/models'},
        'volumes': [{'type': 'volume', 'source': 'assets', 'target': '/actual/models'}]}},
        'volumes': {'assets': {'name': 'stack-retained-assets'}}}
    monkeypatch.setattr(host, 'definition', lambda root: definition)
    assert host.model_source() == 'stack-retained-assets'

@pytest.mark.parametrize('builder_url', ['', 'https://builder.invalid'])
def test_switch_and_manual_rollback_keep_configured_workshop_client(tmp_path, monkeypatch, builder_url):
    runner = release.Host.runner
    stack = Stack(tmp_path, monkeypatch)
    env = stack.root / 'releases/old/.release/env'
    env.write_text(env.read_text() + f'PAIOS_BUILDER_URL={builder_url}\n')
    calls = []
    monkeypatch.setattr(release.Host, 'runner', runner)
    monkeypatch.setattr(subprocess, 'run', lambda command, **kw: calls.append(command))
    monkeypatch.setattr(release, 'start', lambda host, target, run, receipt: run(['up', '-d', 'hermes']))
    with (tmp_path / 'lock').open('a') as lock:
        release.switch(stack.host, stack.root / 'releases/cand', lock)
    release.rollback(stack.host, 'manual')
    for name in ('cand', 'old'):
        command = next(c for c in calls if str(stack.root / f'releases/{name}/deploy/cloud/compose.yaml') in c)
        files = [command[i + 1] for i, arg in enumerate(command) if arg == '-f']
        expected = [str(stack.root / f'releases/{name}/deploy/cloud/compose.yaml')]
        if builder_url:
            expected.append(str(stack.root / f'releases/{name}/deploy/cloud/compose.workshop-client.yaml'))
        assert files == expected
    overlay = (ROOT / 'deploy/cloud/compose.workshop-client.yaml').read_text()
    assert 'PAIOS_BUILDER_URL:' in overlay and '/run/secrets/workshop-builder.key:ro' in overlay
    assert '/run/secrets/workshop-builder.crt:ro' in overlay
