"""The release's Compose inputs and writer boundary, shared with the watchdog."""
from pathlib import Path
from release_watchdog import compose_files, release_files


def command(release, project, profiles, executable=('docker', 'compose')):
    files = release_files(release)
    result = [*executable, '-p', project, '--env-file', files['env_file'], '--env-file', files['public_env_file']]
    result += compose_files(files['compose'], files['env_file'])
    if (Path(release) / '.release/parity.compose.json').exists():
        result += ['-f', str(Path(release) / '.release/parity.compose.json')]
    for profile in profiles:
        result += ['--profile', profile]
    return result


def stop_writers(host, run, *, stop_transport=True, stop_watchdog=False):
    watchdog = 'release-watchdog' + host.suffix
    stopped_watchdog = stop_watchdog and watchdog in host.definition(host.release('current'))['services']
    running_watchdog = stopped_watchdog and watchdog in run(['ps','--status','running','--services'],capture_output=True,text=True).stdout.split()
    if stopped_watchdog:
        run(['stop', watchdog], capture_output=True)
    if stop_transport and 'edge-forward' in host.config['profiles']:
        run(['stop', 'frpc'], capture_output=True)
    suffix = host.suffix
    run(['stop', '-t', '120', *[name + suffix for name in ('gateway', 'hermes', 'workshop', 'workshop-link')]], capture_output=True)
    return {'watchdog_stopped': stopped_watchdog,'watchdog_was_running':running_watchdog}
