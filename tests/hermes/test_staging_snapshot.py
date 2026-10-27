"""Local store/envelope drill. PostgreSQL and Docker acceptance remains a server drill."""
from datetime import datetime, timedelta, timezone
from contextlib import nullcontext
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import pytest

TOOLS = Path(__file__).parents[2] / 'deploy/cloud'
sys.path.insert(0, str(TOOLS))
import staging_snapshot as snapshot
import staging_snapshot_data as data
import staging_snapshot_restore as restore
import staging_snapshot_transfer as transport
from staging_snapshot_stack import Stack


@pytest.fixture(autouse=True)
def deployment_clock(tmp_path, monkeypatch):
    config = tmp_path / 'production.json'
    config.write_text(json.dumps({'time_zone': 'Asia/Taipei'}))
    monkeypatch.setattr(transport, 'PRODUCT_CONFIG', config)


@pytest.mark.parametrize('zone,hour', [('America/Los_Angeles', 3), ('UTC', 10), ('Asia/Taipei', 18)])
def test_snapshot_clock_uses_rendered_deployment_zone(zone, hour):
    transport.PRODUCT_CONFIG.write_text(json.dumps({'time_zone': zone}))
    instant = datetime(2026, 10, 18, 10, tzinfo=timezone.utc)
    assert transport.local_time(instant).hour == hour
    if hour == 3:
        assert transport.night(instant).hour == 3
    else:
        with pytest.raises(ValueError, match='deployment-local'):
            transport.night(instant)


@pytest.fixture
def envelope(tmp_path):
    if not shutil.which('age') or not shutil.which('age-keygen'):
        pytest.fail('Install age and age-keygen on the test PATH; crypto tests must run')
    identity = tmp_path / 'staging-host.key'
    subprocess.run(['age-keygen', '-o', str(identity)], check=True, capture_output=True)
    public = subprocess.run(['age-keygen', '-y', str(identity)], check=True, capture_output=True).stdout
    recipient = tmp_path / 'production.pub'
    recipient.write_bytes(public)
    return identity, recipient


def test_frozen_sqlite_wal_snapshot_encrypt_restore_checks(tmp_path, envelope):
    identity, public = envelope
    home, bundle = tmp_path / 'home', tmp_path / 'bundle'
    home.mkdir(); bundle.mkdir()
    db = sqlite3.connect(home / 'state.db')
    db.executescript("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY); "
                     "CREATE TABLE messages(session_id TEXT,content TEXT); INSERT INTO sessions VALUES('s1'); "
                     "INSERT INTO messages VALUES('s1','fixture');")
    db.commit()
    (home / 'MEMORY.md').write_text('owner fixture memory')
    (home / 'USER.md').write_text('owner fixture')
    (home / 'skills').mkdir(); (home / 'skills/learned.md').write_text('learned fixture')
    (home / '.env').write_text('FIXTURE_ONLY=must-not-export')
    (home / 'config.yaml').write_text('model:\n  default: fixture-model\ncustom_providers:\n'
                                    '- name: fixture-provider\n  base_url: https://model.invalid/v1\n'
                                    '  key_env: STAGING_MODEL_KEY\n  api_key: must-not-export\n')
    (home / 'skills/credential.key').write_text('must-not-export')
    before = sorted(p.name for p in home.iterdir())
    data.copy_tree(home, bundle / 'data/hermes-home', hermes=True)
    data.home_config(home / 'config.yaml', bundle / 'data/hermes-home/config.yaml')
    assert sorted(p.name for p in home.iterdir()) == before
    db.close()
    expected = data.inventory(bundle / 'data')
    assert expected['sqlite']['hermes-home/state.db']['messages'] == 1
    assert not (bundle / 'data/hermes-home/.env').exists()
    model_config = (bundle / 'data/hermes-home/config.yaml').read_text()
    assert json.loads(model_config) == {}
    assert not (bundle / 'data/hermes-home/skills/credential.key').exists()
    (bundle / 'files.json').write_text(json.dumps(expected))
    encrypted = tmp_path / 'snapshot-20261017T190500Z.age'
    transport.encrypt(bundle, encrypted, public)
    assert b'owner fixture memory' not in encrypted.read_bytes()
    recovered = tmp_path / 'restored'; recovered.mkdir()
    transport.decrypt(encrypted, identity, recovered)
    data.verify(recovered / 'data', json.loads((recovered / 'files.json').read_text()))
    assert (recovered / 'data/hermes-home/skills/learned.md').read_text() == 'learned fixture'
    with sqlite3.connect(recovered / 'data/hermes-home/state.db') as changed:
        changed.execute("DELETE FROM messages")
    with pytest.raises(ValueError, match='row counts'):
        data.verify(recovered / 'data', expected)


def test_age_truncation_does_not_restore_plaintext(tmp_path, envelope):
    identity, public = envelope
    bundle = tmp_path / 'bundle'; bundle.mkdir(); (bundle / 'fixture').write_text('fixture')
    encrypted = tmp_path / 'snapshot-20261017T190500Z.age'
    transport.encrypt(bundle, encrypted, public)
    encrypted.write_bytes(encrypted.read_bytes()[:-16])
    destination = tmp_path / 'restored'; destination.mkdir()
    with pytest.raises(subprocess.CalledProcessError):
        transport.decrypt(encrypted, identity, destination)
    assert not (destination / 'fixture').exists()


def test_auxiliary_keeps_projected_sessions_without_copying_historical_index(tmp_path):
    source, target = tmp_path / 'source', tmp_path / 'target'
    source.mkdir(); target.mkdir()
    for name in ('session-records.sqlite', 'session-records.sqlite-wal', 'session-records.sqlite-shm'):
        (source / name).write_text('all historical sessions')
    for name in ('session-finals', 'session-ends'):
        (source / name).mkdir(); (source / name / 'historical').write_text('excluded')
    (target / 'session-records.sqlite').write_text('selected canonical sessions')
    (source / 'consumer-state').mkdir(); (source / 'consumer-state/recent').write_text('keep')
    data.copy_auxiliary(source, target)
    assert (target / 'session-records.sqlite').read_text() == 'selected canonical sessions'
    assert not (target / 'session-ends').exists()
    assert (target / 'consumer-state/recent').read_text() == 'keep'


def test_structural_cut_omits_only_raw_consumer_records(tmp_path):
    source, full, cut = tmp_path / 'source', tmp_path / 'full', tmp_path / 'cut'
    stores = ('audio-consumer-results', 'media-source-progress', 'processed-media', 'processed-media-inputs',
              'derived-audio', 'processed-events', 'timeline', 'health')
    for name in stores:
        (source / name).mkdir(parents=True); (source / name / 'key').write_text(name)
    data.copy_auxiliary(source, full)
    data.copy_auxiliary(source, cut, omit_raw=True)
    assert sorted(p.name for p in full.iterdir()) == sorted(stores)
    assert sorted(p.name for p in cut.iterdir()) == ['health', 'processed-events', 'timeline']

BETWEEN_CALLS = {'camera': None, 'archive': {'pending_bytes': 0, 'call_id': 'ended', 'coverage_incomplete': False,
                                            'unaccepted_bytes': 0}}


@pytest.mark.parametrize('call', [{'call_id': 'preparing'}, {**BETWEEN_CALLS, 'call_id': 'live', 'closed': False}])
def test_gateway_authority_busy_refuses(call):
    stack = object.__new__(Stack)
    stack.run = lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps({
        'schema': 'paios.gateway.resources.v1', 'terminals': [{'resources': {'call': call}}]}))
    with pytest.raises(ValueError, match='BUSY'):
        stack.idle()


@pytest.mark.parametrize('call', [None, BETWEEN_CALLS])
def test_gateway_authority_between_calls_is_idle(call):
    # Release N reports camera and the last reply archive on every terminal; only an owned call carries call_id.
    stack = object.__new__(Stack)
    stack.run = lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps({
        'schema': 'paios.gateway.resources.v1', 'terminals': [{'resources': {'call': call}}]}))
    stack.idle()


def test_busy_capture_never_stops_writers_or_creates_snapshot(tmp_path, monkeypatch):
    calls = []
    class Busy:
        def __init__(self, settings):
            pass
        def idle(self):
            calls.append('check')
            raise ValueError('BUSY')
        def run(self, *args, **kwargs):
            calls.append('stop')
    monkeypatch.setattr(snapshot, 'Stack', Busy)
    monkeypatch.setattr(snapshot, 'night', lambda: (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=3))
    monkeypatch.setattr(snapshot.shutil, 'which', lambda tool: '/fixture/' + tool)
    with pytest.raises(ValueError, match='BUSY'):
        snapshot.capture({'spool': str(tmp_path)})
    assert calls == ['check']
    assert not list(tmp_path.glob('snapshot-*'))


@pytest.mark.parametrize('failure_stage', ['counts', 'l5'])
def test_capture_failure_restarts_only_previously_running_writers(tmp_path, monkeypatch, failure_stage):
    calls = []
    class Failed:
        def __init__(self, settings):
            pass
        def idle(self):
            return None
        def preflight(self, *args):
            pass
        def maintenance(self, held=None):
            return nullcontext()
        def run(self, args, **kwargs):
            calls.append(args)
            return SimpleNamespace(stdout='gateway\nhermes\n' if '--services' in args else 'id')
        def counts(self):
            if failure_stage == 'counts':
                raise ValueError('fixture PG unavailable')
            return {}
        def pg(self, *args):
            pass
        def tools(self, *args):
            pass
        def home_config(self, *args):
            pass
        def volume(self, name):
            return name
        def l5(self, *args):
            raise ValueError('L5_RECEIPT_BUDGET_EXCEEDED')
    monkeypatch.setattr(snapshot, 'Stack', Failed)
    monkeypatch.setattr(snapshot, 'night', lambda: (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=3))
    monkeypatch.setattr(snapshot.shutil, 'which', lambda tool: '/fixture/' + tool)
    monkeypatch.setattr(snapshot.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout='{"Status":"exited","ExitCode":0}'))
    with pytest.raises(ValueError, match='PG unavailable|L5_RECEIPT_BUDGET_EXCEEDED'):
        snapshot.capture({'spool': str(tmp_path / 'spool'), 'scratch': str(tmp_path / 'scratch')})
    assert calls[-1] == ['start', 'gateway', 'hermes']
    assert not list((tmp_path / 'spool').glob('*.age'))


def test_retention_only_deletes_old_accepted_envelopes(tmp_path):
    for day in (15, 16, 17):
        (tmp_path / f'snapshot-202610{day}T190500Z.age').write_text('encrypted fixture')
    unrelated = tmp_path / 'snapshot-old.age'; unrelated.write_text('keep')
    partial = tmp_path / 'snapshot-20261014T190500Z.age.partial'; partial.write_text('keep')
    transport.retain(tmp_path, 2)
    assert not (tmp_path / 'snapshot-20261015T190500Z.age').exists()
    assert unrelated.exists() and partial.exists()
    assert len(list(tmp_path.glob('snapshot-202610*T190500Z.age'))) == 2
    with pytest.raises(ValueError):
        transport.retain(tmp_path, 0)


def test_retention_counts_incoming_and_accepted_together(tmp_path):
    incoming, accepted = tmp_path / 'incoming', tmp_path / 'accepted'
    incoming.mkdir(); accepted.mkdir()
    for root, day in [(accepted, 15), (incoming, 16), (incoming, 17)]:
        (root / f'snapshot-202610{day}T190500Z.age').write_text('encrypted fixture')
    transport.retain(accepted, 2, others=[incoming])
    assert not list(accepted.iterdir())
    assert len(list(incoming.iterdir())) == 2


def test_retention_cli_refuses_production_role_before_touching_files(tmp_path):
    settings = tmp_path / 'settings.json'; settings.write_text('{"role":"production"}')
    protected = tmp_path / 'snapshot-20261015T190500Z.age'; protected.write_text('encrypted fixture')
    result = subprocess.run([sys.executable, str(TOOLS / 'staging_snapshot.py'), 'retain', '--settings', str(settings)], capture_output=True)
    assert result.returncode != 0 and b'restricted' in result.stderr
    assert protected.exists()


def test_retention_cli_accepts_staging_role(tmp_path):
    incoming, accepted = tmp_path / 'incoming', tmp_path / 'accepted'
    incoming.mkdir(); accepted.mkdir()
    older = incoming / 'snapshot-20261015T190500Z.age'; older.write_text('encrypted fixture')
    newer = accepted / 'snapshot-20261016T190500Z.age'; newer.write_text('encrypted fixture')
    settings = tmp_path / 'settings.json'
    settings.write_text(json.dumps({'role': 'staging', 'lock': str(tmp_path / 'retention.lock'),
                                   'incoming': str(incoming), 'accepted': str(accepted), 'keep': 1}))
    subprocess.run([sys.executable, str(TOOLS / 'staging_snapshot.py'), 'retain', '--settings', str(settings)], check=True)
    assert newer.exists() and not older.exists()


def test_taiwan_capture_window():
    assert transport.night(datetime(2026, 10, 17, 19, tzinfo=timezone.utc)).hour == 3
    with pytest.raises(ValueError, match='03:00'):
        transport.night(datetime(2026, 10, 17, 22, tzinfo=timezone.utc))


def test_daytime_capture_is_explicit_and_keeps_its_stop_budget(tmp_path, monkeypatch):
    calls, alarms = [], []
    class Failed:
        def __init__(self, settings):
            pass
        def idle(self):
            return None
        def preflight(self, *args):
            pass
        def maintenance(self, held=None):
            return nullcontext()
        def run(self, args, **kwargs):
            calls.append(args)
            return SimpleNamespace(stdout='gateway\nhermes\n' if '--services' in args else 'id')
        def counts(self):
            raise ValueError('fixture PG unavailable')
    daytime = lambda: datetime(2026, 10, 18, 7, tzinfo=timezone.utc).astimezone(transport.local_time().tzinfo)
    monkeypatch.setattr(snapshot, 'Stack', Failed)
    monkeypatch.setattr(snapshot, 'local_time', daytime)
    monkeypatch.setattr(snapshot, 'night', lambda: transport.night(datetime(2026, 10, 18, 7, tzinfo=timezone.utc)))
    monkeypatch.setattr(snapshot.shutil, 'which', lambda tool: '/fixture/' + tool)
    monkeypatch.setattr(snapshot.signal, 'alarm', lambda seconds: alarms.append(seconds))
    monkeypatch.setattr(snapshot.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout='{"Status":"exited","ExitCode":0}'))
    settings = {'spool': str(tmp_path / 'spool'), 'scratch': str(tmp_path / 'scratch')}
    with pytest.raises(ValueError, match='03:00'):
        snapshot.capture(settings)
    assert calls == []
    Path(settings['spool']).mkdir()
    (Path(settings['spool']) / 'snapshot-earlier.sent').write_text(daytime().isoformat())
    with pytest.raises(ValueError, match='PG unavailable'):
        snapshot.capture(settings, daytime=True)
    with pytest.raises(ValueError, match='PG unavailable'):
        snapshot.capture(settings, daytime=True, stop_seconds=5400)
    assert alarms == [snapshot.DAYTIME_STOP_SECONDS, 0, 5400, 0]
    assert calls[-1] == ['start', 'gateway', 'hermes']


def test_structural_cut_omits_raw_l5_day_or_night_and_declares_window_zero(tmp_path, monkeypatch):
    tools, l5, sealed = [], [], []
    config = tmp_path / 'cloud.json'; config.write_text('{}')
    class Fixture:
        def __init__(self, settings):
            pass
        def idle(self):
            return None
        def preflight(self, *args):
            pass
        def maintenance(self, held=None):
            return nullcontext()
        def run(self, args, **kwargs):
            return SimpleNamespace(stdout='gateway\nhermes\n' if '--services' in args else 'id')
        def counts(self):
            return {'public.fixture': 1}
        def pg(self, operation, stream):
            stream.write(b'fixture dump')
        def volume(self, name):
            return 'paios_' + name
        def tools(self, args, work, mounts=(), **kwargs):
            tools.append(args)
        def home_config(self, work):
            pass
        def l5(self, *args, **kwargs):
            l5.append(args)
        def config_mount(self):
            return str(config)
    def encrypt(work, output, recipient):
        sealed.append(json.loads((work / 'manifest.json').read_text())); Path(output).write_bytes(b'age')
    monkeypatch.setattr(snapshot, 'Stack', Fixture)
    monkeypatch.setattr(snapshot, 'local_time', lambda: datetime(2026, 10, 18, 8, tzinfo=timezone.utc).astimezone(transport.local_time().tzinfo))
    monkeypatch.setattr(snapshot.shutil, 'which', lambda tool: '/fixture/' + tool)
    monkeypatch.setattr(snapshot.signal, 'alarm', lambda seconds: None)
    monkeypatch.setattr(snapshot.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout='{"Status":"exited","ExitCode":0}'))
    monkeypatch.setattr(snapshot, 'encrypt', encrypt)
    monkeypatch.setattr(snapshot, 'transfer', lambda *args: None)
    settings = {'spool': str(tmp_path / 'spool'), 'scratch': str(tmp_path / 'scratch'), 'recipient_file': 'unused', 'destination': 'unused'}
    snapshot.capture(settings, daytime=True, raw=False)
    # The timer takes the same structural cut inside the night window while folding stays off (10-23).
    monkeypatch.setattr(snapshot, 'night', lambda: transport.night(datetime(2026, 10, 18, 19, 30, tzinfo=timezone.utc)))
    snapshot.capture({**settings, 'spool': str(tmp_path / 'night-spool')}, raw=False)
    assert l5 == []
    assert tools.count(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'auxiliary', '--omit-raw']) == 2
    assert [manifest['window_hours'] for manifest in sealed] == [0, 0]


@pytest.mark.parametrize('window, verified, replace', [(48, 1, False), (0, 0, False), (24, None, False),
                                                     (48, 2, True), (0, 0, True)])
def test_restore_verifies_raw_l5_only_when_the_cut_carries_it(tmp_path, monkeypatch, window, verified, replace):
    l5, events = [], []
    projection = {group: {'environment_id': 'staging-fixture', 'profile': profile, 'revision': 1,
                         'group': group, 'configured': True} for group, profile in [('brain', 'owner'), ('build', 'workshop')]}
    class Fixture:
        def __init__(self, settings, stage=False):
            self.definition = {'services': {name+'-staging': {'image': 'fixture-image', 'profiles': ['staging']}
                for name in ('gateway', 'hermes', 'postgres', 'front', 'livekit', 'workshop')}}
        def maintenance(self, held=None):
            return nullcontext()
        def tools(self, args, *rest, **kwargs):
            if '/opt/paios/deploy/cloud/staging_model_settings.py' in args:
                events.append('projection-installed')
        def l5(self, *args, **kwargs):
            l5.append(args)
        def volume(self, name):
            return 'staging_' + name
        def run(self, args, **kwargs):
            if args[0] == 'up' and 'gateway-staging' in args:
                assert 'hermes-staging' in args
                assert '--wait' in args
                events.append('models-started')
            return SimpleNamespace(stdout='')
        def pg(self, *args):
            pass
        def counts(self):
            return {}
    def decrypt(snapshot_path, identity, destination):
        (Path(destination) / 'manifest.json').write_text(json.dumps({
            'schema': 'paios.staging-snapshot.v1', 'window_hours': window, 'consistency': 'all-application-writers-stopped',
            'as_of': datetime.now(timezone.utc).isoformat(), 'postgres_rows': {}}))
        (Path(destination) / 'postgres.dump').write_bytes(b'synthetic-dump')
    def command(args, **kwargs):
        if args == ['fixture-regression']:
            events.append('regression')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(restore, 'Stack', Fixture)
    monkeypatch.setattr(restore, 'preflight', lambda stack, settings: projection)
    monkeypatch.setattr(restore, 'decrypt', decrypt)
    monkeypatch.setattr(restore.subprocess, 'run', command)
    monkeypatch.setattr(restore, 'retain', lambda *args, **kwargs: None)
    envelope = tmp_path / 'snapshot-20261018T080000Z.age'; envelope.write_bytes(b'age')
    settings = {'evidence': str(tmp_path / 'evidence'), 'scratch': str(tmp_path), 'identity_file': 'unused',
                'model_settings_projection': 'synthetic-owner.json', 'model_settings_build_projection': 'synthetic-workshop.json',
                'regression_command': ['fixture-regression'], 'accepted': str(tmp_path), 'incoming': str(tmp_path)}
    if replace:
        restore.restore(settings, envelope, True)
        assert events == ['projection-installed', 'models-started', 'regression']
    else:
        with pytest.raises(ValueError, match='Unsupported' if verified is None else 'staging volumes exist'):
            restore.restore(settings, envelope, False)
    assert len(l5) == (verified or 0)

def test_transfer_cap_is_explicit(tmp_path, monkeypatch):
    seen = []
    class Done:
        returncode = 0
        def __init__(self, args):
            seen.append(args)
        def poll(self):
            return 0
    monkeypatch.setattr(transport.subprocess, 'Popen', Done)
    envelope = tmp_path / 'snapshot-20261018T070000Z.age'
    envelope.write_bytes(b'x')
    transport.transfer(envelope, 'snapshot@staging-host:/incoming/', lambda: None)
    transport.transfer(envelope, 'snapshot@staging-host:/incoming/', lambda: None, 600)
    assert [args[2] for args in seen] == ['--bwlimit=244', '--bwlimit=600']


def test_snapshot_respects_the_existing_release_watchdog_lock(tmp_path):
    stack = object.__new__(Stack); stack.suffix = ''
    stack.definition = {'services': {'release-watchdog': {'volumes': [{'source': str(tmp_path / 'never-started'), 'target': '/watchdog'}]}}}
    with stack.maintenance():
        with pytest.raises(BlockingIOError), stack.maintenance():
            pytest.fail('Concurrent maintenance acquired the same release lock')
    with stack.maintenance():
        pass


@pytest.mark.parametrize('target', ['owner-data', 'model-settings-authority', 'model-settings-projections'])
def test_restore_rejects_cross_name_production_volume_alias(tmp_path, target):
    config = tmp_path / 'staging.json'
    config.write_text(json.dumps({'payment': {'staging': True}, 'product_resources': {'staging_effect_sink_file': '/fixture/effects'}}))
    names = ('gateway', 'hermes', 'postgres', 'front', 'livekit', 'workshop')
    services = {name + '-staging': {'image': 'fixture@sha256:' + 'a' * 64,
                                   'profiles': ['staging'], 'environment': {'PAIOS_STAGE': 'staging'}} for name in names}
    stack = object.__new__(Stack); stack.suffix = '-staging'
    stack.definition = {'services': services}
    stack.volumes = {key: {'name': 'project_' + key} for name in (*restore.TARGETS, *restore.PRESERVED) for key in (name, name + '-staging')}
    stack.config_mount = lambda: str(config)
    stack.volumes[target + '-staging']['name'] = stack.volumes['hermes-home']['name']
    with pytest.raises(ValueError, match='every production volume'):
        restore.preflight(stack, {'staging_secrets': str(tmp_path), 'regression_command': ['fixture-regression']})


def test_candidate_helper_keeps_rel26_compose_and_runs_all_helpers_from_candidate(tmp_path, monkeypatch):
    calls = []
    production = 'sha256:' + 'a' * 64
    candidate = 'sha256:' + 'b' * 64
    definition = {'name': 'paios', 'services': {
        'gateway': {'image': production, 'environment': {'PAIOS_INTEGRATION_PORT': '18661'}},
        'hermes': {'image': 'legacy-hermes'}}, 'volumes': {'hermes-home': {'name': 'paios_hermes-home'}}}
    def run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(stdout=json.dumps(definition))
    monkeypatch.setattr(subprocess, 'run', run)
    env = tmp_path / 'production.env'
    env.write_text('')
    settings = {'compose': str(tmp_path / 'compose.yaml'), 'env_file': str(env),
                'helper_image': candidate, 'compose_project': 'paios'}
    stack = Stack(settings)
    assert stack.gateway['image'] == production
    assert stack.image == candidate
    stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'inventory'], tmp_path)
    assert calls[-1][-4] == candidate
    assert str(TOOLS) + ':/opt/paios/deploy/cloud:ro' in calls[-1]
    stack.home_config(tmp_path)
    assert calls[-1][-4] == candidate
    assert calls[-1][-3] == 'python3'
    assert calls[0][:5] == ['docker', 'compose', '--env-file', str(env), '-f']
    assert ['--project-name', 'paios'] == calls[0][-5:-3]


def test_restore_stack_reads_the_production_services_it_must_not_share(tmp_path, monkeypatch):
    calls = []
    definition = {'services': {'gateway': {'image': 'legacy'}, 'gateway-staging': {'image': 'candidate'}}, 'volumes': {}}
    def run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(stdout=json.dumps(definition))
    monkeypatch.setattr(subprocess, 'run', run)
    env = tmp_path / 'staging.env'
    env.write_text('')
    settings = {'compose': str(tmp_path / 'compose.yaml'), 'env_file': str(env), 'compose_project': 'paios-n-stg'}
    Stack(settings, stage=True)
    Stack(settings)
    assert calls[0][calls[0].index('config') - 2:calls[0].index('config')] == ['--profile', 'production']
    assert calls[0].count('--profile') == 2 and 'staging' in calls[0]
    assert calls[1].count('--profile') == 1 and 'production' in calls[1]


@pytest.mark.parametrize('image', ['candidate:latest', '', 'sha256:bad'])
def test_helper_image_requires_immutable_identity(tmp_path, monkeypatch, image):
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps({
        'services': {'gateway': {'image': 'legacy'}}, 'volumes': {}})))
    env = tmp_path / 'production.env'
    env.write_text('')
    with pytest.raises(ValueError, match='helper_image'):
        Stack({'compose': str(tmp_path / 'compose.yaml'), 'env_file': str(env), 'helper_image': image})


@pytest.mark.parametrize('failure', [ValueError('SNAPSHOT_CAPACITY: scratch bytes'), InterruptedError('preflight interrupted')])
def test_capacity_failure_happens_before_any_writer_stop(tmp_path, monkeypatch, failure):
    calls = []
    class Full:
        def __init__(self, settings):
            pass
        def idle(self):
            pass
        def maintenance(self, held=None):
            return nullcontext()
        def run(self, args, **kwargs):
            assert args[0] != 'stop', 'writers stopped before capacity preflight'
            calls.append(args)
            return SimpleNamespace(stdout='gateway\nhermes\n')
        def preflight(self, *args):
            raise failure
    monkeypatch.setattr(snapshot, 'Stack', Full)
    monkeypatch.setattr(snapshot.shutil, 'which', lambda tool: '/fixture/' + tool)
    with pytest.raises(type(failure), match='SNAPSHOT_CAPACITY|interrupted'):
        snapshot.capture({'spool': str(tmp_path / 'spool'), 'scratch': str(tmp_path / 'scratch')}, daytime=True)
    assert not any(args[0] in ('stop', 'start') for args in calls)


@pytest.mark.parametrize('files,size,free_bytes,free_inodes,budget,error', [
    (100, 1024, 10 << 30, 10000, 1800, None),
    (2_600_000, 1024, 10 << 30, 10_000_000, 1800, 'stopped interval'),
    (100, 1024, 100, 10000, 1800, 'scratch bytes'),
    (100, 1024, 10 << 30, 100, 1800, 'scratch inodes'),
])
def test_capacity_preflight_bounds_bytes_inodes_and_estimated_downtime(tmp_path, monkeypatch,
        files, size, free_bytes, free_inodes, budget, error):
    stack = object.__new__(Stack)
    stack.definition = {'services': {'postgres': {'command': ['postgres', '-p', '5432'],
                         'environment': {'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture'}}}}
    stack.volume = lambda name: name
    stack.tools = lambda args, work, mounts: (work / 'capacity.json').write_text(json.dumps({'files': files, 'bytes': size}))
    stack.run = lambda *args, **kwargs: SimpleNamespace(stdout='1024')
    monkeypatch.setattr(snapshot.os, 'statvfs', lambda path: SimpleNamespace(
        f_bavail=free_bytes, f_frsize=1, f_favail=free_inodes))
    if error:
        with pytest.raises(ValueError, match=error):
            stack.preflight(tmp_path, tmp_path, budget, True)
    else:
        stack.preflight(tmp_path, tmp_path, budget, True)


@pytest.mark.parametrize('raw', [True, False])
def test_capacity_helper_streams_sources_and_budgets_cold_bytes(tmp_path, monkeypatch, raw):
    roots = {name: tmp_path / name for name in ('home', 'owner', 'errands')}
    for root in roots.values():
        root.mkdir()
    (roots['home'] / 'MEMORY.md').write_bytes(b'abc')
    (roots['errands'] / 'note').write_bytes(b'four')
    cold = roots['owner'] / 'central-storage/cold.sqlite'
    cold.parent.mkdir()
    with sqlite3.connect(cold) as db:
        db.executescript('CREATE TABLE locations(size INTEGER); INSERT INTO locations VALUES(7)')
    sessions = cold.parent / 'session-records.sqlite'
    with sqlite3.connect(sessions) as db:
        db.executescript('CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ("first"),("second")')
    objects = cold.parent / 'objects'; objects.mkdir()
    (objects / 'chunk').write_bytes(b'123456789')
    (roots['home'] / 'link').symlink_to(objects)
    work = tmp_path / 'work'; work.mkdir()
    stack = object.__new__(Stack)
    stack.definition = {'services': {'postgres': {'command': ['postgres', '-p', '5432'],
                         'environment': {'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture'}}}}
    stack.volume = lambda name: name
    def tools(args, directory, mounts):
        script = args[2].replace("'/work'", repr(str(work))).replace("'/work/capacity.json'", repr(str(work / 'capacity.json')))
        script = script.replace("'/opt/paios/deploy/cloud'", repr(str(TOOLS)))
        script = script.replace("'/source/owner/central-storage/cold.sqlite'", repr(str(cold)))
        script = script.replace("'/source/owner/central-storage/session-records.sqlite'", repr(str(sessions)))
        for name, root in roots.items():
            script = script.replace(repr('/source/' + name), repr(str(root)))
        subprocess.run([sys.executable, '-B', '-c', script, args[3]], check=True)
    stack.tools = tools
    stack.run = lambda *args, **kwargs: SimpleNamespace(stdout='10')
    monkeypatch.setattr(snapshot.os, 'statvfs', lambda path: SimpleNamespace(f_bavail=1 << 40, f_frsize=1, f_favail=10000))
    stack.preflight(work, work, 1800, raw)
    estimate = json.loads((work / 'capacity.json').read_text())
    assert estimate == {'files': 10 if raw else 4, 'bytes': cold.stat().st_size + sessions.stat().st_size + 7 + (16 if raw else 0)}


@pytest.mark.parametrize('builder_url', ['', 'https://builder.invalid'])
def test_snapshot_restore_compose_keeps_workshop_client_before_archive(tmp_path, monkeypatch, builder_url):
    env = tmp_path / 'private.env'
    env.write_text(f'PAIOS_BUILDER_URL={builder_url}\n')
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(stdout=json.dumps({'services': {'gateway-staging': {'image': 'fixture'}}, 'volumes': {}}))
    monkeypatch.setattr(subprocess, 'run', run)
    Stack({'compose': str(tmp_path / 'compose.yaml'), 'env_file': str(env),
           'archive_compose': str(tmp_path / 'compose.archive.yaml')}, stage=True)
    files = [commands[0][i + 1] for i, value in enumerate(commands[0]) if value == '-f']
    expected = [str(tmp_path / 'compose.yaml')]
    if builder_url:
        expected.append(str(tmp_path / 'compose.workshop-client.yaml'))
    assert files == expected + [str(tmp_path / 'compose.archive.yaml')]
