#!/usr/bin/env python3
"""The one release entry point for people and for 依米: candidate source, build, suites, staging, switch, rollback.

Each host owns exactly one pair of pointers, `<root>/current` and `<root>/previous`, naming release directories under
`<root>/releases`. A release directory is the commit's own tree plus `.release/` (its stage env and receipts). Every
host-side consumer follows `current`: Compose, the snapshot units and settings and the watchdog. A switch moves the
pointers atomically with the services; a rollback swaps them back.

依米's own repairs ship automatically: the build host turns her patch into a staging-accepted candidate on
production's current commit and packages it (`requests`); production pulls, verifies and loads it and switches at
an idle moment with the watchdog armed, then tells the owner (`ship`). Her 「改回去」 is a rollback request that the
same `ship` run executes when the current release is still the latest switch. Operator candidates switch only by hand.

All mutating commands hold the stack's shared `release.lock` (the watchdog's lock): an operator command that finds it
held exits 75 (BUSY); the agent request runner queues behind it.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

# Build hosts share the receipt contract without loading the native provider package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'integrations/hermes/personal_aios'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_status import project_result
import release_build
import release_checks
import release_notice
import release_identity
import release_parity
import release_source
import release_transfer
import release_migrations
import release_compose
import release_data_reset
from release_compose import stop_writers
from release_watchdog import compose_files, release_files
from watchdog_platform import atomic_json, install_front, point, restore_front, retire_newer_transport

BUSY = 75


def now():
    return datetime.now(timezone.utc)


class Host:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['root'])
        self.releases = self.root / 'releases'
        self.stage = config['stage']
        self.suffix = '-staging' if self.stage == 'staging' else ''

    def release(self, name):
        path = self.root / name if name in ('current', 'previous') else self.releases / name
        return path.resolve(strict=True)

    def compose(self, release):
        return release_compose.command(release, self.config['project'], self.config['profiles'])

    def runner(self, release):
        prefix = self.compose(release)
        def run(args, **options):
            return subprocess.run(prefix + args, check=True, env=release_build.clean_env(), **options)
        return run

    def definition(self, release):
        return json.loads(self.runner(release)(['config', '--format', 'json'], capture_output=True, text=True).stdout)

    def model_source(self):
        definition = self.definition(self.release('current'))
        gateway = definition['services']['gateway' + self.suffix]
        mount = next(m for m in gateway['volumes'] if m['target'] == gateway['environment']['PAIOS_MODEL_ROOT'])
        return definition['volumes'][mount['source']]['name'] if mount['type'] == 'volume' else mount['source']

    def lock_path(self):
        if not hasattr(self, 'state'):
            watchdog = self.definition(self.release('current'))['services']['release-watchdog' + self.suffix]
            self.state = Path(next(m['source'] for m in watchdog['volumes'] if m['target'] == '/watchdog'))
            self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        return self.state / 'release.lock'

    @contextmanager
    def locked(self, wait=False):
        path = self.lock_path()
        with path.open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            except BlockingIOError:
                print(json.dumps({'event': 'release_busy', 'lock': str(path)}))
                raise SystemExit(BUSY)
            yield lock

    def event(self, kind, **fields):
        line = json.dumps({'schema': 1, 'event': kind, 'at': time.time(), **fields}, sort_keys=True)
        with (self.lock_path().parent / 'events.jsonl').open('a') as stream:
            stream.write(line + '\n')
        print(line, flush=True)

    def flip(self, release):
        """current -> release, previous -> what current was; returns the old pair for unflip."""
        old = self.release('current'), (self.root / 'previous').resolve() if (self.root / 'previous').exists() else None
        point(self.root, 'current', release)
        point(self.root, 'previous', old[0])
        return old

    def unflip(self, old):
        point(self.root, 'current', old[0])
        if old[1] is not None:
            point(self.root, 'previous', old[1])

    def refresh_base(self):
        """The agent's repair base is production's current commit, as production last published it."""
        production = release_transfer.production_base(self.config)
        base = Path(self.config['requests']) / 'base.json'
        base.with_suffix('.tmp').write_text(json.dumps({'commit': production['commit'], 'release': production['release']}) + '\n')
        base.with_suffix('.tmp').chmod(0o644)
        base.with_suffix('.tmp').replace(base)

    def commit(self, release):
        return json.loads((Path(release) / '.release/source.json').read_text())['commit']

    def latest(self):
        """The last switch or rollback on this host (release.py and the watchdog share events.jsonl)."""
        path = self.lock_path().parent / 'events.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return next((row for row in reversed(rows) if row['event'] in ('switch_passed', 'rollback_passed', 'rollback_started')), None)


def read_env(path):
    return [line for line in Path(path).read_text().splitlines()]


def write_env(path, lines, changes):
    kept = [line for line in lines if line.split('=', 1)[0] not in changes]
    Path(path).write_text('\n'.join(kept + [f'{k}={v}' for k, v in changes.items()]) + '\n')
    Path(path).chmod(0o600)


def env_value(lines, key):
    return next((line.split('=', 1)[1] for line in lines if line.startswith(key + '=')), None)


def render(host, release):
    """Render the selected release's config with its own env, as every deployment and rollback requires."""
    env = release_build.clean_env()
    for line in read_env(release_files(release)['env_file']):
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            env[key] = value
    subprocess.run([sys.executable, str(release / 'deploy/cloud/prepare-build.py'), '--config-only'], check=True, env=env,
                   cwd=release / 'deploy/cloud', capture_output=True)


# ---------------------------------------------------------------- service lifecycle (shared by switch/rollback)

def start(host, release, run, receipt, before_services=None):
    release_data_reset.guard_start(host)
    s, up = host.suffix, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never']
    run(up + ['--wait', 'postgres' + s], capture_output=True)
    # The candidate's ledgered migrator is the schema authority; its result is recorded, not re-derived here.
    release_migrations.recorded(run, ['run', '--rm', '--no-deps', '--pull', 'never', 'gateway' + s, 'node',
         '01-product-half-finished/backend/phase0/gateway/tools/mac-product-provision.ts',
         'migrate', '--config', '/etc/paios/cloud.json', '--root', '/var/lib/paios'], receipt, 'migration')
    if before_services:
        before_services()
    release_data_reset.guard_start(host)
    services = host.definition(release)['services']
    # The release's own Compose graph orders Gateway and Hermes: a Hermes that depends on Gateway (its model
    # settings authority) starts only after Gateway is healthy; an older Hermes-first release keeps its order.
    gateway_first = 'gateway' + s in services['hermes' + s].get('depends_on', {})
    if gateway_first:
        run(up + ['gateway' + s], capture_output=True)
        receipt.update(release_checks.wait_health(run, s))
    run(up + ['--wait', 'hermes' + s], capture_output=True)
    receipt['native_ready'] = release_checks.native_ready(run, s)
    if not receipt['native_ready']['official_native_ready']:
        raise RuntimeError('NATIVE_NOT_READY')
    run(up + ['livekit' + s], capture_output=True)
    if not gateway_first:
        run(up + ['gateway' + s], capture_output=True)
        receipt.update(release_checks.wait_health(run, s))
    receipt['core_postcheck'] = release_checks.postcheck(run, s, core_only=True)
    if not receipt['core_postcheck']['passed']:
        raise RuntimeError('CORE_POSTCHECK_FAILED')
    relay = [name for name in ('owner-mac-relay', 'owner-mac-visitor') if host.stage == 'production' and name in services]
    if relay:
        run(up + relay, capture_output=True)
    run(up + ['--wait', 'workshop' + s, 'workshop-link' + s], capture_output=True)
    if 'edge-forward' in host.config['profiles']:
        run(up + ['frpc'], capture_output=True)


def front(host, release, reviewed_sha):
    """The live front keeps its container and namespace; only a reviewed config change is written into its mounts."""
    name = 'front' + host.suffix
    container = subprocess.run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + host.config['project'],
                                '--filter', 'label=com.docker.compose.service=' + name], check=True, capture_output=True, text=True).stdout.strip()
    mounts = {m['Destination']: m['Source'] for m in json.loads(subprocess.run(['docker', 'inspect', container], check=True,
                                                                               capture_output=True, text=True).stdout)[0]['Mounts']}
    rendered = release / 'deploy/cloud/.build' / ('front-staging.conf' if host.suffix else 'front.conf')
    guard = release / 'deploy/cloud/.build' / ('paios_roaming_guard-staging.js' if host.suffix else 'paios_roaming_guard.js')
    live_config, live_guard = Path(mounts['/etc/nginx/conf.d/default.conf']), Path(mounts['/etc/paios-roaming/paios_roaming_guard.js'])
    if live_config.read_bytes() == rendered.read_bytes() and live_guard.read_bytes() == guard.read_bytes():
        return {'changed': False}
    digest = hashlib.sha256(rendered.read_bytes() + b'\0' + guard.read_bytes()).hexdigest()
    if reviewed_sha != digest:
        raise ValueError('FRONT_REVIEW_REQUIRED: the rendered front differs from the live one; review it and pass --front-sha ' + digest)
    state = release / '.release'
    shutil.copyfile(live_config, state / 'front-before.conf')
    shutil.copyfile(live_guard, state / 'front-before.js')
    install_front(container, live_config, live_guard, rendered.read_bytes(), guard.read_bytes())
    return {'changed': True, 'sha256': digest, 'container': container}


def watchdog_record(host, lock, mode, release_id, candidate, previous):
    if not host.config.get('timing'):
        return None
    command = [sys.executable, str(candidate / 'deploy/cloud/watchdog-record.py'), '--mode', mode, '--lock-fd', str(lock.fileno()),
               '--state-dir', str(host.lock_path().parent), '--release-id', release_id, '--project', host.config['project'],
               '--profile', host.stage, '--root', str(host.root), '--candidate-release', str(candidate),
               '--previous-release', str(previous), '--timing', host.config['timing'],
               '--principal-id', host.config['owner']['principal_id'], '--device-id', host.config['owner']['device_id']]
    for unit in host.config['units']:
        command += ['--unit', unit]
    for profile in host.config['profiles']:
        command += ['--compose-profile', profile]
    subprocess.run(command, check=True, pass_fds=(lock.fileno(),), env=release_build.clean_env(), cwd=candidate / 'deploy/cloud')
    return mode


# ---------------------------------------------------------------- commands

def cmd_adopt(host, args):
    """One-time: make an already-running release the host's current one, with the env it runs under."""
    release = Path(args.release).resolve(strict=True)
    if (host.root / 'current').exists():
        raise ValueError('This host already has a current release')
    state = release / '.release'
    state.mkdir(mode=0o700, exist_ok=True)
    write_env(state / 'env', read_env(args.env), {})
    if not (state / 'source.json').exists():
        release_build.write(state / 'source.json', {'schema': 'paios.release-source.v1', 'commit': args.commit, 'adopted_at': now().isoformat()})
    point(host.root, 'current', release)
    print(json.dumps({'current': str(release)}))


def cmd_source(host, args):
    if args.bundle:
        release_source.fetch(host.config['repo'], args.bundle)
    target, receipt = release_source.materialize(host.config['repo'], args.commit, host.releases, base=args.base)
    print(json.dumps({'release': str(target), **{k: receipt[k] for k in ('commit', 'tree', 'docker_inputs', 'build_inputs_equal')}}))


def candidate_env(host, release, images, copy_secrets=False):
    """The candidate's stage env is the current one with its accepted immutable images (and optionally fresh secrets)."""
    current = host.release('current')
    lines = read_env(release_files(current)['env_file'])
    changes = {f'PAIOS_{role.upper()}_IMAGE': images[role] for role in host.config.get('image_roles', ('gateway', 'hermes', 'workshop', 'watchdog'))}
    if copy_secrets:
        old = env_value(lines, 'PAIOS_SECRETS_DIR')
        new = str(host.root / f'production-secrets-{release.name}')
        subprocess.run(['cp', '-a', old, new], check=True)
        changes['PAIOS_SECRETS_DIR'] = new
        if (cold := env_value(lines, 'PAIOS_COLD_CONFIG_DIR')) and cold.startswith(old):
            changes['PAIOS_COLD_CONFIG_DIR'] = new + cold[len(old):]
    (release / '.release').mkdir(mode=0o700, exist_ok=True)
    write_env(release_files(release)['env_file'], lines, changes)


def cmd_build(host, args):
    with host.locked():
        result = release_build.build(host.config, host.release(args.release))
    print(json.dumps({k: result[k] for k in ('commit', 'images')}))


def cmd_suites(host, args):
    with host.locked():
        baseline = host.release('current') / '.release/suites.json'
        result = release_build.suites(host.config, host.release(args.release), baseline if baseline.exists() else None,
                                      model_source=host.model_source())
    print(json.dumps({'passed': result['passed'], **{k: v['new_failures'] for k, v in result['suites'].items()}}))
    return 0 if result['passed'] else 1


def stage(host, release, snapshot, lock):
    """Run the existing snapshot restore + regression with the candidate as current; a failure keeps the old current."""
    import staging_snapshot_restore
    settings = json.loads(Path(host.config['snapshot_settings']).read_text())
    images = {role: image['id'] for role, image in json.loads((release / '.release/build.json').read_text())['images'].items()}
    candidate_env(host, release, images)
    old = host.flip(release)
    host.event('staging_started', release=str(release))
    try:
        with Path(settings['lock']).open('a') as snapshot_lock:
            fcntl.flock(snapshot_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            snapshot = Path(snapshot) if snapshot else release_build.newest_snapshot(settings)
            staging_snapshot_restore.restore(settings, snapshot, True, lock=lock,
                                              inventory=getattr(host, 'parity_inventory', None))
        receipt = json.loads((Path(settings['evidence']) / (snapshot.stem + '.json')).read_text())
        atomic_json(release / '.release/snapshot.json', {**receipt, 'release_parity': True})
        accepted = release_build.accept(release, receipt)
    except BaseException:
        host.unflip(old)
        host.event('staging_failed', release=str(release))
        raise
    host.event('staging_accepted', release=str(release), commit=accepted['commit'])
    return accepted


def cmd_stage(host, args):
    with host.locked() as lock:
        accepted = stage(host, host.release(args.release), args.snapshot, lock)
    print(json.dumps(accepted))


def switch(host, release, lock, front_sha=None, copy_secrets=False, data_reset_id=None, data_reset_preview=None):
    if data_reset_id is not None and data_reset_id != 'RQ-102-N15':
        raise ValueError('RESET_ID_REQUIRED')
    accepted = json.loads((release / '.release/accepted.json').read_text())
    for role in host.config.get('image_roles', ('gateway', 'hermes', 'workshop', 'watchdog')):
        if release_build.image_id(accepted['images'][role]) != accepted['images'][role]:
            raise ValueError('CANDIDATE_IMAGE_NOT_LOADED: ' + role)
    current = host.release('current')
    release_id = release.name + '-' + now().strftime('%Y%m%dT%H%M%SZ')
    receipt = {'schema': 'paios.release-switch.v1', 'release_id': release_id, 'candidate': str(release),
               'previous': str(current), 'commit': accepted['commit'], 'started_at': now().isoformat()}
    old_run = host.runner(current)
    receipt['drain'] = release_checks.drain(old_run, host.suffix)
    if not receipt['drain']['passed']:
        raise RuntimeError('DRAIN_FAILED: ' + json.dumps(receipt['drain']))
    candidate_env(host, release, accepted['images'], copy_secrets)
    render(host, release)
    stopped = flipped = False
    reset_stopped = None
    try:
        receipt['front'] = front(host, release, front_sha)
        release_build.write(release / '.release/front.json', receipt['front'])
        receipt['watchdog'] = watchdog_record(host, lock, 'prepare', release_id, release, current)
        # Everything a rollback needs exists before any release container changes: the previous release dir, its env,
        # its rendered config and its still-loaded images. The dump is for human recovery; an image switch never
        # undoes a migration.
        if data_reset_id:
            receipt['postgres_before'] = 'quarantined_RQ102_clear_tables_after_migrations'
        else:
            pg = host.definition(current)['services']['postgres' + host.suffix]
            with (release / '.release/postgres-before.dump').open('wb') as dump:
                old_run(['exec', '-T', 'postgres' + host.suffix, 'pg_dump', '-p', pg['command'][pg['command'].index('-p') + 1],
                         '-U', pg['environment']['POSTGRES_USER'], '-d', pg['environment']['POSTGRES_DB'], '-Fc', '--no-owner', '--no-acl'],
                        stdout=dump)
        stopped = True
        if data_reset_id:
            reset_stopped = stop_writers(host, old_run, stop_watchdog=True)
        else:
            stop_writers(host, old_run)
        host.flip(release)
        flipped = True
        host.event('switch_started', release_id=release_id, candidate=str(release), previous=str(current))
        run = host.runner(release)
        if data_reset_id:
            start(host, release, run, receipt, before_services=lambda: release_data_reset.hook(
                host, release, run, receipt, preview=data_reset_preview))
        else:
            start(host, release, run, receipt)
        receipt['postcheck'] = release_checks.postcheck(run, host.suffix, expected=expected_images(accepted, host.suffix),
                                                        edge_forward='edge-forward' in host.config['profiles'])
        if not receipt['postcheck']['passed']:
            raise RuntimeError('POSTCHECK_FAILED')
        if watchdog_record(host, lock, 'arm', release_id, release, current):
            run(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'release-watchdog' + host.suffix], capture_output=True)
            receipt['watchdog'] = 'armed'
    except BaseException as error:
        receipt['failure'] = type(error).__name__ + ': ' + str(error)[:500]
        host.event('switch_failed', release_id=release_id, reason=type(error).__name__)
        try:
            if receipt.get('data_reset', {}).get('state') == 'quarantined':
                stop_writers(host, host.runner(release))
                release_data_reset.restore_switch(host, release, host.runner(release), receipt)
            if flipped:
                rollback(host, release_id, receipt.setdefault('immediate_rollback', {}))
            else:
                receipt['front_restored'] = restore_front(release)
                if stopped:
                    start(host, current, old_run, receipt.setdefault('restart', {}))
            if reset_stopped:
                resumed = host.release('current')
                release_data_reset.resume_watchdog(host, resumed, host.runner(resumed), reset_stopped)
        finally:
            release_build.write(release / f'.release/switch-{release_id}.json', receipt)
        raise
    receipt['finished_at'] = now().isoformat()
    if data_reset_id and not host.config.get('timing'):
        release_data_reset.resume_watchdog(host, release, run, reset_stopped)
    release_build.write(release / f'.release/switch-{release_id}.json', receipt)
    host.event('switch_passed', release_id=release_id, commit=accepted['commit'], candidate=str(release))
    return receipt


def expected_images(accepted, suffix):
    images = accepted['images']
    return {'gateway' + suffix: images['gateway'], 'hermes' + suffix: images['hermes'],
            'workshop' + suffix: images['workshop'], 'workshop-link' + suffix: images['workshop']}


def rollback(host, reason, receipt=None):
    """Swap current and previous, then start the previous release with its own env, config and images."""
    failed, target = host.release('current'), host.release('previous')
    receipt = {} if receipt is None else receipt
    receipt.update({'from': str(failed), 'to': str(target)})
    reset_cut = release_data_reset.rollback_cut(host,failed)
    reset_stopped = stop_writers(host,host.runner(failed),stop_watchdog=True) if reset_cut else stop_writers(host,host.runner(failed))
    if reset_cut:
        release_data_reset.hook(host,failed,host.runner(failed),receipt,'rollback',reset_cut)
    release_data_reset.guard_start(host)
    # The newer image understands its L3 facts. Project before moving pointers or starting any older writer.
    try:
        release_migrations.project_rollback(host, failed, target, receipt)
    except BaseException:
        release_build.write(failed / '.release/rollback-failed.json', receipt)
        raise
    point(host.root, 'current', target)
    point(host.root, 'previous', failed)
    restored_front = restore_front(failed)
    # The previous release keeps the config it was rendered with; re-rendering could rewrite a live front mount.
    receipt['front_restored'] = restored_front
    receipt['transport_retired'] = retire_newer_transport(host.runner(target), target, failed, ['hermes' + host.suffix])
    start(host, target, host.runner(target), receipt)
    if reset_cut:
        release_data_reset.resume_watchdog(host,target,host.runner(target),reset_stopped)
    host.event('rollback_passed', reason=reason, **{k: receipt[k] for k in ('from', 'to')})
    release_build.write(failed / '.release/rollback.json', receipt)
    return receipt


def cmd_switch(host, args):
    if getattr(args,'data_reset',None) and not getattr(args,'operator_apply_rq102',False):
        raise ValueError('RESET_OPERATOR_FLAG_REQUIRED')
    with host.locked() as lock:
        release = host.release(args.release)
        if args.accepted:
            shutil.copyfile(args.accepted, release / '.release/accepted.json')
        receipt = switch(host, release, lock, args.front_sha, args.copy_secrets, getattr(args, 'data_reset', None))
    print(json.dumps({k: receipt[k] for k in ('release_id', 'commit', 'watchdog')}))


def cmd_rollback(host, args):
    with host.locked():
        print(json.dumps(rollback(host, 'manual')))


def candidate(host, request):
    while True:
        result = _candidate(host, request)
        if result.get('state') != 'rebuilding':
            return result


def _candidate(host, request):
    """Agent request: an exact base plus a patch from the coding workshop, through every gate up to accepted."""
    request = Path(request)
    spec = json.loads((request / 'request.json').read_text())
    # The spool is written by the build workshop: validate its two identifiers at this trust boundary.
    if not re.fullmatch(r'[0-9a-f]{12}', spec['request_id']) or not re.fullmatch(r'[0-9a-f]{40}', spec['base']):
        raise ValueError('INVALID_REQUEST')
    result = {'schema': 'paios.release-request-result.v1', 'request_id': spec['request_id'], 'base': spec['base'],
              'started_at': now().isoformat(), 'steps': {}, **{k: spec[k] for k in ('origin', 'description', 'captured_at') if k in spec}}
    result_path = request / 'result.json'
    def save():
        atomic_json(result_path, result, mode=0o644)
    step = 'source'
    try:
        with host.locked(wait=True) as lock:
            production = release_transfer.production_base(host.config)
            if result_path.exists():
                result = json.loads(result_path.read_text())
                if result.get('finished_at') and (not result.get('ready_for_production') or
                        production['commit'] in (result['base'], result.get('commit')) or
                        spec['request_id'] in production.get('closed_requests', [])):
                    return result
            step = 'parity'
            production = release_parity.ensure(host, lock)
            base = production['commit']
            if result['base'] != base:
                rebuilds = result.get('rebuilds', []) + [{'base': result['base'], 'commit': result.get('commit')}]
                result = {key: value for key, value in result.items() if key not in
                          ('commit', 'finished_at', 'accepted', 'transfer', 'owner_decision', 'protected_paths')}
                result.update(base=base, steps={}, state='rebuilding', ready_for_production=False, rebuilds=rebuilds)
            result['parity'] = {'equal': True, 'base': base}
            save()
            step = 'source'
            commit = result.get('commit')
            if not commit:
                ref = 'candidates/' + spec['request_id']
                saved = subprocess.run(['git', '-C', host.config['repo'], 'rev-parse', '--verify', '--quiet',
                                        'refs/paios/' + ref], capture_output=True, text=True)
                if saved.returncode not in (0, 1):
                    saved.check_returncode()
                reusable = saved.returncode == 0 and subprocess.run(['git', '-C', host.config['repo'],
                    'merge-base', '--is-ancestor', base, saved.stdout.strip()], capture_output=True).returncode == 0
                commit = saved.stdout.strip() if reusable else release_source.apply_patch(
                    host.config['repo'], base, request / 'candidate.patch', ref)
            result['commit'] = commit
            save()
            if protected := release_source.protected_changes(host.config['repo'], base, commit):
                decision = owner_decision(Path(host.config['exchange']) / 'decisions', spec['request_id'], base, commit,
                                          superseded_ok=True)
                if decision is None:
                    result.update(state='awaiting_owner', protected_paths=protected)
                    save()
                    request_notice(host, spec, 'release-approval-required', '这次修复涉及主人基线，需要主人确认后继续。',
                                   base=base, commit=commit, paths=protected)
                    return result
                result['owner_decision'] = decision
                result['state'] = 'approved'
                if not decision['approved']:
                    result.update(state='refused', finished_at=now().isoformat(), reason='OWNER_DECLINED_BASELINE_CHANGE')
                    save()
                    return result
            release = host.releases / commit[:8]
            if not release.exists():
                release, _ = release_source.materialize(host.config['repo'], commit, host.releases, base=base)
            state = release / '.release'
            result['steps']['source'] = 'passed'
            save()
            step = 'build'
            if not (state / 'build.json').exists():
                release_build.build(host.config, release)
            result['steps']['build'] = 'passed'
            save()
            step = 'suites'
            baseline = host.release('current') / '.release/suites.json'
            suites = json.loads((state / 'suites.json').read_text()) if (state / 'suites.json').exists() else (
                release_build.suites(host.config, release, baseline if baseline.exists() else None, model_source=host.model_source()))
            result['steps']['suites'] = 'passed' if suites['passed'] else {k: v['new_failures'] for k, v in suites['suites'].items()}
            save()
            if not suites['passed']:
                raise RuntimeError('SUITES_FAILED')
            step = 'staging'
            if not (state / 'accepted.json').exists() and host.release('current') == release:
                # A stopped restore already flipped staging; retry from its retained previous pointer.
                point(host.root, 'current', host.release('previous'))
            accepted = json.loads((state / 'accepted.json').read_text()) if (state / 'accepted.json').exists() else (
                stage(host, release, None, lock))
            result['steps']['staging'] = 'passed'
            result.update(accepted=accepted, ready_for_production=True)
            save()
            if release_transfer.production_base(host.config)['commit'] != base:
                result.update(state='rebuilding', ready_for_production=False)
                save()
                return result
            # The owner reads this line: the commit subject the repair builder wrote, bounded, from the host's own store.
            summary = release_source.git(host.config['repo'], 'log', '-1', '--format=%s', commit, text=True).strip()[:200]
            step = 'transfer'
            package = Path(host.config['exchange']) / 'candidates' / spec['request_id']
            if package.exists():
                manifest = json.loads((package / 'manifest.json').read_text())
                if manifest['base'] != base:
                    package.rename(package.with_name('.superseded-' + package.name + '-' + manifest['commit'][:8]))
            if not package.exists():
                result['transfer'] = release_transfer.export(host.config, release, result, summary)
            else:
                result['transfer'] = {'package': str(package), **{k: manifest[k] for k in ('delta_bytes', 'reused_bytes')}}
    except Exception as error:
        result.update(state='failed', ready_for_production=False)
        result['failure'] = step + ': ' + type(error).__name__
        result['finished_at'] = now().isoformat()
        save()
        task_failure(host, spec, step, type(error).__name__)
        raise
    result.update(state='accepted', finished_at=now().isoformat())
    save()
    return result


def cmd_requests(host, args):
    """Refresh the repair base from production, then process every queued agent request in order (path unit)."""
    host.refresh_base()
    release_parity.prepare_requests(host)
    status = 0
    for request in sorted(Path(host.config['requests']).glob('*/request.json')):
        result = request.parent / 'result.json'
        previous = json.loads(result.read_text()) if result.exists() else {}
        production = release_transfer.production_base(host.config)
        if request.parent.name.startswith('.') or request.parent.name in production.get('closed_requests', []) or (
                previous.get('finished_at') and (not previous.get('ready_for_production') or
                production['commit'] in (previous['base'], previous.get('commit')))):
            continue
        try:
            candidate(host, request.parent)
        except Exception:
            status = 1
    release_transfer.publish_requests(host.config)
    return status


# ---------------------------------------------------------------- production: 依米's repairs and her 「改回去」

TERMINAL = {'switched', 'switch_failed', 'refused', 'transfer_failed'}
PACKAGE = ('manifest.json', 'accepted.json', 'result.json', 'source.bundle', 'delta.tar')


def set_status(host, name, **fields):
    """The receipt 依米 reads through release_status (spool/status, readable by her container)."""
    path = Path(host.config['spool']) / 'status' / (name + '.json')
    value = {**(json.loads(path.read_text()) if path.exists() else {}), **fields, 'updated_at': now().isoformat()}
    release_build.write(path, value)
    path.chmod(0o644)
    return value


def owner_decision(directory, request_id, base, commit, superseded_ok=False):
    path = directory / (request_id + '.json')
    if not path.exists():
        return None
    decision = json.loads(path.read_text())
    if (decision.get('request_id'), decision.get('base'), decision.get('commit')) != (request_id, base, commit):
        if superseded_ok and decision.get('request_id') == request_id:
            return None
        raise ValueError('OWNER_DECISION_CANDIDATE_MISMATCH')
    if type(decision.get('approved')) is not bool:
        raise ValueError('INVALID_OWNER_DECISION')
    return decision


def request_notice(host, spec, kind, text, **event):
    """Keep the request's real owner and origin across the existing host notice exchange."""
    origin = spec.get('origin')
    if not origin:
        host.event('request_notice_missing_origin', request_id=spec['request_id'], notice_kind=kind)
        return
    directory = (Path(host.config['exchange']) / 'notices' if host.stage == 'staging'
                 else host.lock_path().parent / 'notices')
    release_notice.queue(directory, release_notice.body(spec, kind, text, **event))
    if host.stage == 'staging':
        release_transfer.share_notices(host.config)


def task_failure(host, spec, stage, error):
    if not spec.get('origin'):
        host.event('request_notice_missing_origin', request_id=spec['request_id'], notice_kind='task-failure')
        return
    directory = (Path(host.config['exchange']) / 'notices' if host.stage == 'staging'
                 else host.lock_path().parent / 'notices')
    release_notice.queue(directory, release_notice.failure(spec, stage, error))
    if host.stage == 'staging':
        release_transfer.share_notices(host.config)


def import_request_notices(host):
    """Reuse status receipts for import progress; notice IDs remain stable across host retries."""
    for path in sorted((Path(host.config['incoming']) / 'notices').glob('*.json')):
        body = json.loads(path.read_text())
        event, request_id = body['system_event'], body['system_event']['request_id']
        if not re.fullmatch(r'[0-9a-f]{12}', request_id):
            raise ValueError('INVALID_REQUEST_NOTICE')
        status_path = Path(host.config['spool']) / 'status' / (request_id + '.json')
        status = json.loads(status_path.read_text()) if status_path.exists() else {}
        marker = event['type'] + '_queued'
        if status.get(marker):
            continue
        directory = host.lock_path().parent / 'notices'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_json(directory / path.name, body)
        fields = {marker: True, 'origin': {k: body[k] for k in ('principal_id', 'device_id')}}
        if event['type'] == 'release_approval_required':
            fields.update(project_result(status, {'state': 'awaiting_owner', 'base': event['base'],
                          'commit': event['commit'], 'protected_paths': event['paths']}))
        else:
            fields.update(state='failed', failure=event['failure']['answer'])
        set_status(host, request_id, **fields)


def notice(host, kind, release_id, text, **event):
    """Queue one system message for the owner's timeline (the gateway's existing system-notice path)."""
    body = {**host.config['owner'], 'id': f'{kind}:{release_id}', 'text': text,
            'captured_at': now().strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            'system_event': {'type': kind.replace('-', '_'), 'release_id': release_id, **event}}
    path = host.lock_path().parent / 'notices' / (kind + '-' + release_id + '.json')
    path.parent.mkdir(mode=0o700, exist_ok=True)
    release_build.write(path, body)


def deliver_notices(host):
    """At least once: the gateway deduplicates by notice id, and a notice stays queued while the owner is unreachable."""
    for path in sorted((host.lock_path().parent / 'notices').glob('*.json')):
        body = json.loads(path.read_text())
        try:
            release_checks.notice(host.runner(host.release('current')), host.suffix, body)
        except (subprocess.CalledProcessError, ValueError) as error:
            host.event('notice_pending', id=body['id'], reason=type(error).__name__)
            continue
        path.unlink()
        host.event('notice_delivered', id=body['id'])


def idle(host):
    """The switch's own drain authority: owner call, native runs and delegations, errands, faults, OOM."""
    try:
        return release_checks.drain(host.runner(host.release('current')), host.suffix)['passed']
    except (ValueError, subprocess.CalledProcessError):
        return False


def rollback_requests(host):
    """依米's 「改回去」: undo the latest switch at the next idle moment, then tell the owner."""
    pending = sorted(p for p in (Path(host.config['spool']) / 'rollback').glob('*.json') if re.fullmatch(r'[0-9a-f]{12}\.json', p.name))
    if not pending:
        return None
    names = ['rollback-' + path.stem for path in pending]
    latest, current = host.latest(), host.release('current')
    if not latest or latest['event'] != 'switch_passed' or latest.get('candidate') != str(current):
        for name, path in zip(names, pending):
            set_status(host, name, state='refused', reason='NOT_THE_LATEST_SWITCH: the running release is already a rollback target or was never switched in')
            path.unlink()
        return 'refused'
    if not idle(host):
        for name in names:
            set_status(host, name, state='waiting_idle')
        return 'waiting_idle'
    request = current / '.release/request.json'
    spec = json.loads(request.read_text()) if request.exists() else None
    request_id = spec['request_id'] if spec else None
    try:
        receipt = rollback(host, 'owner_request')
    except BaseException as error:
        if spec:
            task_failure(host, spec, 'rollback', type(error).__name__)
        for name, path in zip(names, pending):
            set_status(host, name, state='failed', reason='rollback: ' + type(error).__name__)
            path.unlink()
        raise
    notice(host, 'release-reverted', latest['release_id'], '系统消息：已按你的要求换回上一个版本。',
           commit=host.commit(host.release('current')), **({'request_id': request_id} if request_id else {}))
    for name, path in zip(names, pending):
        set_status(host, name, state='done', undone=latest['release_id'], **receipt)
        path.unlink()
    return 'done'


def ship_package(host, lock, package):
    manifest = json.loads((package / 'manifest.json').read_text())
    try:
        return _ship_package(host, lock, package)
    except Exception as error:
        set_status(host, manifest['request_id'], state='failed', reason=type(error).__name__)
        task_failure(host, manifest, 'production', type(error).__name__)
        raise


def _ship_package(host, lock, package):
    """Switch one verified agent candidate at an idle moment; every refusal is a receipt, never a partial switch."""
    manifest = json.loads((package / 'manifest.json').read_text())
    request_id, repo = manifest['request_id'], host.config['repo']
    if package.name != request_id or not re.fullmatch(r'[0-9a-f]{12}', request_id):
        raise ValueError('INVALID_PACKAGE: ' + package.name)
    def stop(state, reason):
        set_status(host, request_id, state=state, reason=reason)
        if state != 'switched' and reason != 'OWNER_DECLINED_BASELINE_CHANGE':
            task_failure(host, manifest, state, (reason or state).split(':', 1)[0])
        shutil.rmtree(package)
        return state
    base = host.commit(host.release('current'))
    set_status(host, request_id, state='verifying', commit=manifest['commit'], base=manifest['base'],
               **{k: manifest[k] for k in ('origin',) if k in manifest})
    if not json.loads((package / 'result.json').read_text()).get('ready_for_production'):
        return stop('refused', 'NOT_READY: the build host did not accept this candidate')
    if manifest['base'] != base:
        return stop('stale_base', f"built on {manifest['base'][:8]} but production runs {base[:8]}; repair again on the new base")
    # Production independently checks the owner decision for this exact immutable candidate.
    release_source.fetch(repo, package / 'source.bundle')
    if protected := release_source.protected_changes(repo, base, manifest['commit']):
        decision = owner_decision(Path(host.config['spool']) / 'decisions', request_id, base, manifest['commit'], superseded_ok=True)
        if decision is None:
            set_status(host, request_id, state='awaiting_owner', protected_paths=protected)
            request_notice(host, manifest, 'release-approval-required', '这次修复涉及主人基线，需要主人确认后继续。',
                           base=base, commit=manifest['commit'], paths=protected)
            return 'awaiting_owner'
        if not decision['approved']:
            return stop('refused', 'OWNER_DECLINED_BASELINE_CHANGE')
    summary = release_source.git(repo, 'log', '-1', '--format=%s', manifest['commit'], text=True).strip()[:200]
    set_status(host, request_id, summary=summary)
    if not host.config.get('auto_switch'):
        set_status(host, request_id, state='automatic_switch_disabled')
        return 'automatic_switch_disabled'
    if not idle(host):
        set_status(host, request_id, state='waiting_idle')
        return 'waiting_idle'
    try:
        set_status(host, request_id, transfer=release_transfer.load(host.config, package))
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        return stop('transfer_failed', type(error).__name__)
    release = host.releases / manifest['commit'][:8]
    if not release.exists():
        release, _ = release_source.materialize(repo, manifest['commit'], host.releases, base=base)
    shutil.copyfile(package / 'accepted.json', release / '.release/accepted.json')
    release_build.write(release / '.release/request.json', {**manifest, 'summary': summary})
    try:
        receipt = switch(host, release, lock)
    except Exception as error:
        if str(error).startswith('DRAIN_FAILED'):
            set_status(host, request_id, state='waiting_idle')
            return 'waiting_idle'
        return stop('switch_failed', type(error).__name__)
    notice(host, 'release-shipped', receipt['release_id'],
           f'系统消息：依米修好了「{summary}」，已在空闲时上线（修复单 {request_id}）。新版本有自动回退保护；不满意的话，跟依米说一声想用回之前的版本就行。',
           request_id=request_id, commit=manifest['commit'])
    set_status(host, request_id, release_id=receipt['release_id'], watchdog=receipt.get('watchdog'))
    return stop('switched', None)


def production_state(host):
    return release_identity.capture(host)


def record_identity(host, *, snapshot_required=True, dry_run=False):
    """Self ship and the lead's deploy kit both enter here under the production release lock."""
    if host.stage != 'production':
        raise ValueError('PRODUCTION_IDENTITY_ONLY')
    state = production_state(host) if snapshot_required else release_identity.capture(
        host, snapshot_required=False, roles_required=False)
    if spool := host.config.get('spool'):
        state['closed_requests'] = [p.stem for p in (Path(spool) / 'status').glob('*.json')
                                    if json.loads(p.read_text()).get('state') in TERMINAL]
    if dry_run:
        return state
    if snapshot_required or host.config.get('exchange_remote'):
        state['sync'] = release_transfer.production_package(host, state)
    # This is the existing production state. Exchange publication is only its transported view.
    atomic_json(host.lock_path().parent / 'production.json', state)
    release_transfer.publish(host.config, state)
    return state


def publish_runtime(host):
    """Publish source outcomes and the derived release pointers, event log and request receipts."""
    builder = Path(host.config['incoming']) / 'requests.json'
    builder_requests = json.loads(builder.read_text()) if builder.exists() else None
    for result in builder_requests or []:
        request_id = result['request_id']
        if not re.fullmatch(r'[0-9a-f]{12}', request_id):
            raise ValueError('INVALID_REQUEST')
        path = Path(host.config['spool']) / 'status' / (request_id + '.json')
        receipt = json.loads(path.read_text()) if path.exists() else None
        projected = project_result(receipt, result)
        if projected != receipt:
            set_status(host, request_id, **projected)
    def pointer(name):
        path = host.root / name
        if not path.exists():
            return None
        selected = host.release(name)
        return {'release': selected.name, 'commit': host.commit(selected)}
    fields = ('state', 'base', 'commit', 'summary', 'updated_at', 'release_id', 'ready_for_production',
              'finished_at', 'reason', 'failure')
    requests = [{ 'request_id': p.stem, **{k: value[k] for k in fields if k in value}}
                for p in sorted((Path(host.config['spool']) / 'status').glob('*.json'))[-50:]
                if p.stem != 'runtime' for value in [json.loads(p.read_text())]]
    events = host.lock_path().parent / 'events.jsonl'
    recent = [{k: row[k] for k in ('event', 'at', 'release_id', 'commit', 'request_id') if k in row}
              for line in (events.read_text().splitlines()[-30:] if events.exists() else [])
              for row in [json.loads(line)]]
    health = {row['Config']['Labels']['com.docker.compose.service']: {
        'running': row['State']['Running'], 'status': row['State']['Status'], 'oom_killed': row['State']['OOMKilled'],
        'health': row['State'].get('Health', {}).get('Status', 'none'), 'restarts': row['RestartCount']}
        for row in release_checks.containers(host.runner(host.release('current')))
        if row['Config']['Labels']['com.docker.compose.service'] in {'gateway' + host.suffix, 'hermes' + host.suffix}}
    set_status(host, 'runtime', current=pointer('current'), previous=pointer('previous'), recent=recent,
               requests=requests, health=health, builder_requests=builder_requests,
               parity=(json.loads((Path(host.config['incoming']) / 'parity.json').read_text())
                       if (Path(host.config['incoming']) / 'parity.json').exists() else None))


def cmd_ship(host, args):
    """Production timer/path unit: 「改回去」 requests and notices first (they never wait on the build host), then
    publish production's state, pull new packages and switch at most one verified candidate at an idle moment."""
    with host.locked():
        release_data_reset.expire(host)
        rollback_requests(host)
        deliver_notices(host)
        before = host.commit(host.release('current'))
    status = Path(host.config['spool']) / 'status'
    decided = {p.stem for p in status.glob('*.json') if json.loads(p.read_text()).get('state') in TERMINAL}
    try:
        release_transfer.publish_decisions(host.config)
        with host.locked():
            record_identity(host)
        release_transfer.fetch(host.config, decided)
    except subprocess.CalledProcessError as error:
        host.event('exchange_unreachable', reason=type(error).__name__)
    incoming = Path(host.config['incoming']) / 'candidates'
    packages = sorted((p for p in incoming.glob('*') if p.name not in decided and all((p / f).exists() for f in PACKAGE)),
                      key=lambda p: p.stat().st_mtime) if incoming.is_dir() else []
    with host.locked() as lock:
        import_request_notices(host)
        for package in packages:
            if ship_package(host, lock, package) in ('waiting_idle', 'awaiting_owner', 'automatic_switch_disabled', 'switched', 'switch_failed'):
                break
        deliver_notices(host)
        publish_runtime(host)
        if host.commit(host.release('current')) != before:
            try:
                record_identity(host)
            except subprocess.CalledProcessError as error:
                host.event('exchange_unreachable', reason=type(error).__name__)


def cmd_identity(host, args):
    with host.locked():
        value = record_identity(host, snapshot_required=False, dry_run=args.dry_run)
    print(json.dumps(value))


def cmd_parity(host, args):
    if args.production_record and args.staging_record and args.dry_run:
        value = release_identity.compare(json.loads(Path(args.production_record).read_text()),
                                         json.loads(Path(args.staging_record).read_text()))
        if args.command == 'sync':
            value['actions'] = [] if value['equal'] else release_parity.ACTIONS
    else:
        if host.stage != 'staging':
            raise ValueError('PARITY_REQUIRES_STAGING_HOST')
        with host.locked() as lock:
            if args.command == 'sync':
                value = release_parity.ensure(host, lock, dry_run=args.dry_run)
            else:
                value = release_parity.inspect(host, release_transfer.production_base(host.config))
                if not args.dry_run:
                    release_parity.publish_report(host, value)
    print(json.dumps(value))
    return 0 if args.command == 'sync' or value['equal'] else 1


def cmd_prune(host, args):
    """Keep the active releases, live mounts and configured native build input under one release lock."""
    with host.locked():
        keep = {host.release('current'), *([host.release('previous')] if (host.root / 'previous').exists() else [])}
        running = subprocess.run(['docker', 'ps', '-q'], check=True, capture_output=True, text=True).stdout.split()
        inspected = json.loads(subprocess.run(['docker', 'inspect', *running], check=True, capture_output=True, text=True).stdout) if running else []
        mounted = {Path(m['Source']) for c in inspected for m in c['Mounts']}
        in_use = {c['Image'] for c in inspected}
        def images(release):
            build, accepted = release / '.release/build.json', release / '.release/accepted.json'
            if build.exists():
                return {i['id'] for i in json.loads(build.read_text())['images'].values()}
            return set(json.loads(accepted.read_text())['images'].values()) if accepted.exists() else set()
        seed = host.config.get('hermes_source')
        seed = Path(seed).absolute() if seed and '://' not in seed else None
        if seed is not None and seed.is_dir():
            # The configured source can live under an old release even when its final component is a symlink.
            keep.update(p.resolve() for p in (seed, *seed.parents) if p.parent == host.releases)
        kept_images = set().union(*(images(r) for r in keep)) | in_use
        plan = []
        for release in sorted(p for p in host.releases.iterdir() if p.is_dir() and p.resolve() not in keep):
            if any(m == release or release in m.parents for m in mounted):
                continue  # a live bind-mount source (e.g. the front config) stays until its container moves
            plan.append({'release': str(release), 'images': sorted(images(release) - kept_images)})
        natives = {(r / 'deploy/cloud/.build/hermes').resolve() for r in keep}
        native_root = Path(host.config.get('native_root', host.root / 'hermes-native'))
        if seed is not None and seed.is_dir() and seed.resolve().is_relative_to(native_root.resolve()):
            natives.add(seed.resolve())
        stale_natives = [str(p) for p in native_root.iterdir()
                         if not any(p.resolve() == n or p.resolve() in n.parents for n in natives)] if native_root.is_dir() else []
        print(json.dumps({'keep': sorted(map(str, keep)), 'remove': plan, 'native_remove': stale_natives, 'execute': args.execute}, indent=2))
        if args.execute:
            for row in plan:
                for image in row['images']:
                    subprocess.run(['docker', 'image', 'rm', image], capture_output=True)
                shutil.rmtree(row['release'])
            for path in stale_natives:
                shutil.rmtree(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', default='/etc/paios/release.json')
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('adopt'); p.add_argument('release'); p.add_argument('--env', required=True); p.add_argument('--commit', required=True)
    p = commands.add_parser('source'); p.add_argument('commit'); p.add_argument('--bundle'); p.add_argument('--base')
    for name in ('build', 'suites'):
        commands.add_parser(name).add_argument('release')
    p = commands.add_parser('stage'); p.add_argument('release'); p.add_argument('--snapshot')
    p = commands.add_parser('switch'); p.add_argument('release'); p.add_argument('--accepted'); p.add_argument('--front-sha')
    p.add_argument('--copy-secrets', action='store_true')
    p.add_argument('--data-reset', choices=['RQ-102-N15'])
    p.add_argument('--operator-apply-rq102', action='store_true')
    p = commands.add_parser('data-reset')
    p.add_argument('action', choices=['plan', 'quarantine', 'verify', 'rollback', 'expire'])
    p.add_argument('--receipt')
    p.add_argument('--operator-apply-rq102', action='store_true')
    commands.add_parser('rollback')
    p = commands.add_parser('candidate'); p.add_argument('request')
    commands.add_parser('requests')
    commands.add_parser('ship')
    p = commands.add_parser('identity'); p.add_argument('--dry-run', action='store_true')
    for name in ('parity', 'sync'):
        p = commands.add_parser(name)
        p.add_argument('--dry-run', action='store_true')
        p.add_argument('--production-record'); p.add_argument('--staging-record')
    p = commands.add_parser('prune'); p.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    record_only = args.command in ('parity', 'sync') and args.dry_run and args.production_record and args.staging_record
    host = None if record_only else Host(json.loads(Path(args.config).read_text()))
    handler = {'adopt': cmd_adopt, 'source': cmd_source, 'build': cmd_build, 'suites': cmd_suites, 'stage': cmd_stage,
               'switch': cmd_switch, 'rollback': cmd_rollback, 'candidate': lambda h, a: candidate(h, a.request) and 0,
               'requests': cmd_requests, 'ship': cmd_ship, 'identity': cmd_identity, 'parity': cmd_parity,
               'sync': cmd_parity, 'prune': cmd_prune, 'data-reset': release_data_reset.command}[args.command]
    return handler(host, args) or 0


if __name__ == '__main__':
    sys.exit(main())
