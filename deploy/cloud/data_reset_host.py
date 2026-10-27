"""Resolve the deployed release's stores and credentials from its Compose authority."""
import json
from pathlib import Path
from string import Template
import subprocess
from urllib.parse import urlsplit

from data_reset_cold import Cold
from data_reset_policy import RESET_ID, require
from data_reset_postgres import Postgres


def run_worker(settings, request):
    command = settings['voice_command']
    if command[:2] == ['docker', 'run']:
        mounted = [Path(command[n+1].split(':')[1]) for n, value in enumerate(command) if value == '-v']
        inputs = [Path(request['path'])]
        if request.get('keep_from'):
            inputs.append(Path(request['keep_from']))
        if request.get('sqlite'):
            wal = Path(request['path']+'-wal')
            if wal.exists():
                inputs.append(wal)
        additions = []
        for path in inputs:
            if not any(path == root or path.is_relative_to(root) for root in mounted):
                # Cut files live outside product mounts. Expose only the requested input, read-only.
                additions += ['-v', str(path)+':'+str(path)+':ro']
                mounted.append(path)
        command = command[:-2] + additions + command[-2:]
    return subprocess.run(command, input=json.dumps(request), text=True, capture_output=True)



def volume_source(definition, mount):
    volume = definition['volumes'][mount['source']]
    options = volume.get('driver_opts', {})
    if options.get('type') == 'none' and 'bind' in options.get('o', '').split(','):
        # Docker unmounts a local bind volume on stop: its _data can then be an empty stub.
        return Path(options['device']).resolve(strict=True)
    result = subprocess.run(['docker','volume','inspect','--format','{{.Mountpoint}}',volume['name']],
                            check=True,capture_output=True,text=True)
    return Path(result.stdout.strip()).resolve(strict=True)

def settings(host, release):
    spec = host.config['data_reset']
    require(spec['id'] == RESET_ID, 'RESET_ID_REQUIRED')
    definition, suffix = host.definition(release), host.suffix
    services = definition['services']
    gateway = services['gateway' + suffix]

    def source(service, target):
        candidates=[m for m in services[service + suffix]['volumes'] if target == m['target'] or target.startswith(m['target'].rstrip('/')+'/')]
        mount=max(candidates,key=lambda m:len(m['target']))
        tail=target[len(mount['target']):].lstrip('/')
        if mount['type'] == 'bind':
            return str((Path(mount['source']) / tail).resolve(strict=True))
        return str((volume_source(definition,mount)/tail).resolve(strict=True))

    roots = {'owner': source('gateway', '/var/lib/paios'), 'hermes': source('hermes', '/opt/data'),
             'errands': source('gateway', '/var/lib/paios/state/errands'),
             'models': source('gateway', '/var/lib/paios/central-storage/model-settings'),
             'projections': source('gateway', '/var/lib/paios/model-projections'),
             'secrets': str(Path(source('gateway', '/run/secrets/model-settings-master.key')).parent)}
    for role, service, target in [('core','gateway','/var/lib/paios/core-profile/memories'),
                                 ('desktop_in','gateway','/var/lib/paios/desktop-in'),
                                 ('desktop_out','gateway','/var/lib/paios/desktop-out'),
                                 ('release_spool','hermes','/srv/release-spool')]:
        if any(m['target'] == target for m in services[service + suffix]['volumes']):
            roots[role] = source(service, target)
    roots['release_dumps'] = str(host.root.resolve(strict=True))
    snapshots = Path(spec.get('snapshot_settings', '/etc/paios/staging-snapshot-production.json'))
    if snapshots.exists():
        snapshot_spec = json.loads(snapshots.read_text())
        roots['snapshot_spool'] = str(Path(snapshot_spec['spool']).resolve(strict=True))
    state = host.lock_path().parent / 'data-reset'
    state.mkdir(mode=0o700, exist_ok=True)
    baselines = [*spec.get('baselines', []), source('gateway','/opt/models'), source('workshop','/workshop'),
                 source('workshop','/srv/workshop-snapshots'), source('workshop','/var/lib/workshop-ssh'), source('hermes','/run/workshop-access')]
    worker = '/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts'
    command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'node']
    for role, root in roots.items():
        if role in ('release_dumps','snapshot_spool'):
            continue
        command += ['-v', root + ':' + root + (':ro' if root == roots['secrets'] else ':rw')]
    command += ['-v', str(state)+':'+str(state), '-e', 'TMPDIR='+str(state)]
    for baseline in baselines:
        command += ['-v', baseline+':'+baseline+':ro']
    command += [gateway['image'], worker]
    result = {**spec, 'roots': roots, 'voice_command': command, 'state_dir': str(state)}
    result['baselines'] = baselines
    result['guard_paths'] = [roots['owner'], str(state), source('postgres','/var/lib/postgresql')]
    if snapshots.exists():
        result['snapshot_lock'] = snapshot_spec['lock']
    # Include all Compose mount sources, including the watchdog and nested bind mounts.
    mounts = set()
    for service in services.values():
        for mount in service.get('volumes', []):
            if mount['type'] == 'bind':
                mounts.add(str(Path(mount['source']).resolve(strict=True)))
            elif mount['type'] == 'volume':
                mounts.add(str(volume_source(definition,mount)))
    result['mount_roots'] = sorted(mounts)
    Path(result['state_dir']).mkdir(mode=0o700, exist_ok=True)
    config = json.loads(Template(Path(source('gateway', '/etc/paios/cloud.json')).read_text()).substitute(gateway['environment']))
    cold = config.get('archive_tiering', {}).get('cold')
    if cold:
        # Reuse the existing host-loopback OpenList archive port; no new endpoint or credential is introduced.
        ports = services['cold-webdav' + suffix]['ports']
        port = next(p for p in ports if int(p['target']) == 5244 and p.get('host_ip') == '127.0.0.1')
        result['cold'] = {**cold, 'url': 'http://127.0.0.1:' + str(port['published']) + urlsplit(cold['url']).path,
                          'password_file': source('gateway', cold['password_file'])}
    return result


def postgres(host, release):
    service = 'postgres' + host.suffix
    pg = host.definition(release)['services'][service]
    from release_compose import command
    prefix = command(release, host.config['project'], host.config['profiles']) + ['exec', '-T', service]
    arguments = ['--port', pg['command'][pg['command'].index('-p') + 1],
                 '--username', pg['environment']['POSTGRES_USER'], '--dbname', pg['environment']['POSTGRES_DB']]
    return Postgres.local(prefix, arguments)


def context(host, release):
    value = settings(host, release)
    return value, postgres(host, release), Cold(value['cold']) if value.get('cold') else None
