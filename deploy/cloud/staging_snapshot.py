#!/usr/bin/env python3
"""Nightly production capture and restore into the existing staging profile."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

from staging_snapshot_stack import Stack, WRITERS
from staging_snapshot_transfer import encrypt, night, retain, local_time, transfer

# Manual daytime capture is separate from the timer. Calls prevent capture and take priority over upload.
# Writers stop for at most the configured stop budget. Any capture may omit raw L5 when the loose per-chunk
# layout would exceed that budget; rehearsing folding conversion still requires a raw capture.
DAYTIME_STOP_SECONDS = 1800


def capture(settings, daytime=False, bwlimit=244, stop_seconds=DAYTIME_STOP_SECONDS, raw=True):
    local = local_time() if daytime else night()
    for tool in ('age', 'rsync', 'docker'):
        if not shutil.which(tool):
            raise ValueError('Required installed tool is missing: ' + tool)
    spool = Path(settings['spool']).resolve()
    spool.mkdir(parents=True, exist_ok=True, mode=0o700)
    stack = Stack(settings)
    if not daytime and any(datetime.fromisoformat(p.read_text()).astimezone(local.tzinfo).date() == local.date()
           for p in spool.glob('snapshot-*.sent')):
        print('Today snapshot was already delivered; no duplicate capture')
        return
    # A failed transfer retries the same immutable encrypted cut. Production has no retention deletion.
    pending = sorted(p for p in spool.glob('snapshot-*.age') if not p.with_suffix('.sent').exists())
    if pending:
        snapshot = pending[0]
    else:
        stack.idle()
        running = stack.run(['ps', '--status', 'running', '--services'], capture_output=True, text=True).stdout.split()
        writers = [name for name in WRITERS if name in running]
        if not {'gateway', 'hermes'} <= set(writers):
            raise ValueError('Production gateway and Hermes must be running before capture')
        scratch = Path(settings['scratch']).resolve()
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix='snapshot-', dir=scratch) as temporary:
            work = Path(temporary)
            if daytime:
                budget = stop_seconds
            else:
                current = night()
                budget = (current.replace(hour=6, minute=0, second=0, microsecond=0) - current).total_seconds() - 120
            with stack.maintenance():
                # SIGTERM must unwind the restart fence as systemd stops this service.
                def interrupted(signum, frame):
                    raise InterruptedError('Snapshot interrupted')
                previous = signal.signal(signal.SIGTERM, interrupted)
                previous_alarm = signal.signal(signal.SIGALRM, interrupted)
                started = time.monotonic()
                stop_requested = stopped = False
                try:
                    stack.preflight(work, spool, budget, raw)
                    if daytime:
                        budget = stop_seconds
                    else:
                        current = night()
                        budget = (current.replace(hour=6, minute=0, second=0, microsecond=0) - current).total_seconds() - 120
                        if budget <= 0:
                            raise ValueError('Insufficient night window to capture and restart the writers')
                    signal.alarm(max(1, int(budget)))
                    stack.idle()
                    stop_requested = True
                    stack.run(['stop', '--timeout', '120'] + writers)
                    for writer in writers:
                        identity = stack.run(['ps', '-aq', writer], capture_output=True, text=True).stdout.strip()
                        state = json.loads(subprocess.run(['docker', 'inspect', '--format', '{{json .State}}', identity],
                                                           check=True, capture_output=True, text=True).stdout)
                        if state['Status'] != 'exited' or state['ExitCode'] not in (0, 143):
                            raise ValueError('All writers must stop gracefully before the common cut')
                    stopped = True
                    as_of = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                    counts = stack.counts()
                    before = time.monotonic()
                    with (work / 'postgres.dump').open('wb') as dump:
                        stack.pg('dump', dump)
                    dump_seconds = time.monotonic() - before
                    stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'copy'], work,
                                [(stack.volume('hermes-home'), '/source/home:ro'),
                                 (stack.volume('owner-data'), '/source/owner:ro'),
                                 (stack.volume('errands'), '/source/errands:ro')])
                    stack.home_config(work)
                    if raw:
                        stack.l5(work, 'export', as_of)
                    stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'auxiliary']
                                + ([] if raw else ['--omit-raw']), work, [(stack.volume('owner-data'), '/source:ro')])
                    stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'inventory'], work)
                    if stack.counts() != counts:
                        raise ValueError('Postgres changed while application writers were stopped')
                    config = json.loads(Path(stack.config_mount()).read_text())
                    # Shipped cloud config contains secret paths, never secret values. Do not archive the host env.
                    forbidden = {'password', 'api_key', 'access_token', 'secret', 'token'}
                    def check_config(value):
                        if isinstance(value, dict):
                            if forbidden.intersection(value):
                                raise ValueError('Config contains inline secret fields; use file references')
                            for child in value.values():
                                check_config(child)
                        elif isinstance(value, list):
                            for child in value:
                                check_config(child)
                    check_config(config)
                    (work / 'source-config.json').write_text(json.dumps(config))
                    manifest = {'schema': 'paios.staging-snapshot.v1', 'as_of': as_of, 'window_hours': 48 if raw else 0,
                                'consistency': 'all-application-writers-stopped', 'postgres_rows': counts,
                                'pg_dump_bytes': (work / 'postgres.dump').stat().st_size, 'pg_dump_seconds': dump_seconds,
                                'capture_seconds': time.monotonic() - started}
                    visual = work / 'data/owner-data/central-storage/visual-memory/visual-inventory.json'
                    manifest['legacy_visual_rows'] = json.loads(visual.read_text())['legacy_rows'] if visual.exists() else 0
                    (work / 'manifest.json').write_text(json.dumps(manifest, indent=2))
                finally:
                    signal.alarm(0)
                    try:
                        if stop_requested:
                            # A disconnected Docker client can leave its stop request running on the daemon.
                            try:
                                if not stopped:
                                    stack.run(['stop', '--timeout', '120'] + writers)
                            finally:
                                stack.run(['start'] + writers)
                    finally:
                        signal.signal(signal.SIGTERM, previous)
                        signal.signal(signal.SIGALRM, previous_alarm)
            stamp = datetime.fromisoformat(as_of.replace('Z', '+00:00')).strftime('%Y%m%dT%H%M%SZ')
            snapshot = spool / ('snapshot-' + stamp + '.age')
            encrypt(work, snapshot, settings['recipient_file'])
            # Release identity uses the captured cut time, never the later upload timestamp.
            from watchdog_platform import atomic_json
            atomic_json(snapshot.with_suffix('.json'), manifest)
            print(json.dumps({**manifest, 'encrypted_bytes': snapshot.stat().st_size, 'snapshot': snapshot.name}))
    transfer(snapshot, settings['destination'], stack.idle, bwlimit)
    snapshot.with_suffix('.sent').write_text(datetime.now(timezone.utc).isoformat())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['capture', 'restore', 'retain'])
    parser.add_argument('--settings', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--replace-staging', action='store_true')
    parser.add_argument('--daytime', action='store_true', help='manual capture outside deployment-local 03:00-06:00')
    parser.add_argument('--bwlimit', type=int, default=244, help='capture upload KiB/s')
    parser.add_argument('--daytime-minutes', type=int, default=DAYTIME_STOP_SECONDS // 60,
                        help='writer stop budget of a daytime capture')
    parser.add_argument('--omit-raw', action='store_true',
                        help='structural cut: no raw L5 window and none of its per-chunk consumer records')
    args = parser.parse_args()
    if (args.daytime or args.bwlimit != 244 or args.omit_raw) and args.command != 'capture':
        parser.error('--daytime, --bwlimit and --omit-raw apply only to capture')
    if not 1 <= args.bwlimit <= 1024:
        parser.error('--bwlimit must be 1-1024 KiB/s')
    if not 5 <= args.daytime_minutes <= 150:
        parser.error('--daytime-minutes must be 5-150')
    os.umask(0o077)
    settings = json.loads(args.settings.read_text())
    expected = 'production' if args.command == 'capture' else 'staging'
    if settings['role'] != expected:
        raise ValueError('This operation is restricted to the configured host role: ' + expected)
    lock = Path(settings['lock'])
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'capture':
            capture(settings, args.daytime, args.bwlimit, args.daytime_minutes * 60, not args.omit_raw)
        elif args.command == 'restore':
            from staging_snapshot_restore import restore
            if not args.snapshot:
                parser.error('restore requires --snapshot')
            restore(settings, args.snapshot, args.replace_staging)
        else:
            retain(settings['accepted'], settings.get('keep', 2), others=[settings['incoming']])


if __name__ == '__main__':
    main()
