"""Operator-only reset commands, using release.lock, stop_writers and start's post-migration boundary."""
import json
from contextlib import contextmanager
import fcntl
import re
import time
from pathlib import Path

import data_reset
import data_reset_manifest as journal
import data_reset_retention as retention
import data_reset_host
import release_data_reset_runtime
from data_reset_inventory import public_plan
from data_reset_policy import RESET_ID, require
from staging_snapshot_stack import WRITERS


def guard_start(host):
    if 'data_reset' not in host.config:
        return
    directory = host.lock_path().parent / 'data-reset'
    journal.cleanup_scratch({'state_dir':str(directory)})
    for path in directory.glob('data-reset-*.json'):
        require(json.loads(path.read_text())['state'] not in ('quarantining', 'restoring'), 'RESET_RECOVERY_REQUIRED')


def stopped(host, run):
    active = run(['ps', '--status', 'running', '--services'], capture_output=True, text=True).stdout.split()
    require(not set(active) & {name + host.suffix for name in WRITERS},
            'RESET_WRITERS_NOT_STOPPED')
    # Also reject a forced/failed exit; a partially flushed native WAL is not an acceptable release cut.
    for name in WRITERS:
        result = run(['ps', '-aq', name + host.suffix], capture_output=True, text=True).stdout.strip()
        if result:
            import subprocess
            state = json.loads(subprocess.run(['docker', 'inspect', '--format', '{{json .State}}', result],
                                              check=True, capture_output=True, text=True).stdout)
            require(state['Status'] == 'exited' and state['ExitCode'] in (0, 143), 'RESET_WRITER_EXIT_UNCLEAN')


def hook(host, release, run, receipt, action='quarantine', receipt_path=None, *, preview=None):
    stopped(host, run)
    recover_mountpoints(host)
    settings, pg, cold = data_reset_host.context(host, release)
    settings = {**settings,'release_dir':str(release.resolve())}
    retention = release_data_reset_runtime.prepare(host) if 'data_reset' in host.config else None
    with snapshot_fence(settings):
        result = data_reset.run(settings, action, pg, cold, receipt_path, preview=preview)
    if retention:
        result['retention_entrypoint']=retention
    receipt['data_reset'] = result
    return result


@contextmanager
def snapshot_fence(settings):
    if not settings.get('snapshot_lock'):
        yield; return
    with Path(settings['snapshot_lock']).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('RESET_SNAPSHOT_BUSY') from None
        yield


def restore_switch(host, release, run, receipt):
    result = receipt.get('data_reset')
    if result and result.get('state') == 'quarantined':
        hook(host, release, run, receipt, 'rollback', result['receipt'])



def recover_mountpoints(host):
    path = host.lock_path().parent/'data-reset'/('data-reset-'+RESET_ID+'.json')
    if not path.exists():
        return
    row = json.loads(path.read_text())
    if row.get('format') == journal.FORMAT and row['state'] in ('quarantining','restoring'):
        row = journal.load({'state_dir':str(path.parent),'roots':row['roots']},path)
        from data_reset_layout import matches
        from data_reset_quarantine import fresh_root
        for entry in row['entries']:
            if matches(entry['quarantine'],entry):
                fresh_root({},entry)


def rollback_cut(host, release):
    if 'data_reset' not in getattr(host,'config',{}):
        return None
    path = host.lock_path().parent/'data-reset'/('data-reset-'+RESET_ID+'.json')
    if path.exists():
        row = json.loads(path.read_text())
        if (row.get('format')==journal.FORMAT and row.get('applied_release')==str(release.resolve())
                and (row['state'] in journal.RECOVERY_STATES or
                     row['state']=='quarantined' and time.time()<row['expires_at'])):
            return str(path)
    return None


def resume_watchdog(host, release, run, stopped):
    guard_start(host)
    if stopped and stopped.get('watchdog_was_running'):
        run(['up','-d','--no-deps','--no-build','--pull','never','release-watchdog'+host.suffix],capture_output=True)


def expire(host):
    if 'data_reset' not in host.config:
        return {'expired_quarantines': 0, 'pending_quarantines': 0}
    spec = {**host.config['data_reset'], 'state_dir': str(host.lock_path().parent / 'data-reset')}
    return retention.expire(spec)


def command(host, args):
    try:
        require(args.action != 'quarantine' or getattr(args,'operator_apply_rq102',False), 'RESET_OPERATOR_FLAG_REQUIRED')
        with host.locked():
            if args.action == 'expire':
                result = expire(host); print(json.dumps(result))
                return 75 if result['pending_quarantines'] else 0
            if args.action == 'rollback' and args.receipt:
                path = Path(args.receipt).resolve(strict=True)
                directory = (host.lock_path().parent/'data-reset').resolve()
                require(path.parent == directory, 'RESET_RECEIPT_SCOPE')
                row = json.loads(path.read_text())
                if row['state'] == 'restored':
                    settings = {'state_dir':str(directory), 'roots':row['roots']}
                    result = data_reset.run(settings, 'rollback', receipt_path=path)
                    print(json.dumps(result, sort_keys=True)); return
            release = host.release('current')
            if args.action == 'plan':
                settings, pg, cold = data_reset_host.context(host, release)
                retention=release_data_reset_runtime.prepare(host)
                report = data_reset.run(settings, 'plan', pg, cold)
                from data_reset_cut import capacity
                budget = capacity(settings,report,pg,cold)
                print(json.dumps({**public_plan(report), 'additional_bytes_estimate':budget['additional_bytes_estimate'],
                                  'capacity':budget, 'retention_entrypoint':retention},sort_keys=True)); return
            from release import start, stop_writers
            from release_checks import drain
            require(args.action not in ('verify', 'rollback') or args.receipt, 'RESET_RECEIPT_REQUIRED')
            pending = host.lock_path().parent/'data-reset'/('data-reset-'+RESET_ID+'.json')
            state = json.loads(pending.read_text())['state'] if pending.exists() else None
            run = host.runner(release)
            recovering = (args.action == 'quarantine' and state == 'quarantining'
                          or args.action == 'rollback' and state in journal.RECOVERY_STATES)
            active = set()
            if recovering:
                active = set(run(['ps', '--status', 'running', '--services'],
                                 capture_output=True, text=True).stdout.split())
            writers = {name + host.suffix for name in WRITERS}
            # An unfinished journal already fences stopped writers. Live writers
            # still need the release drain before stop_writers establishes the cut.
            if not recovering or active & writers:
                require(drain(run, host.suffix)['passed'], 'RESET_DRAIN_FAILED')
            stopped = stop_writers(host, run, stop_watchdog=True)
            receipt = {}
            try:
                if args.action == 'rollback' or args.action == 'quarantine' and recovering:
                    hook(host, release, run, receipt, args.action, args.receipt)
                    start(host, release, run, receipt)
                else:
                    start(host, release, run, receipt,
                          before_services=lambda: hook(host, release, run, receipt, args.action, args.receipt))
            except BaseException:
                try:
                    guard_start(host)
                except ValueError as fence:
                    # Preserve the operation's precise error while retaining the recovery fence.
                    if str(fence) != 'RESET_RECOVERY_REQUIRED':
                        raise
                else:
                    start(host, release, run, {})
                    resume_watchdog(host, release, run, stopped)
                raise
            resume_watchdog(host, release, run, stopped)
            print(json.dumps(receipt['data_reset'], sort_keys=True))
    except Exception as error:
        # Subprocess and parser exceptions can carry credentials or row text. Only a fixed error crosses the CLI.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'RESET_[A-Z0-9_]+', str(error)) else 'RESET_OPERATION_FAILED'
        raise RuntimeError(code) from None
