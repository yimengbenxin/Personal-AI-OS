"""age envelopes, capped transfer and staging-only retention of accepted snapshots."""
from datetime import datetime, timezone
import os
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time

PRODUCT_CONFIG = Path(__file__).resolve().parent / '.build/production.json'

NAME = re.compile(r'snapshot-\d{8}T\d{6}Z\.age')


def encrypt(bundle, output, recipient_file):
    recipient = Path(recipient_file).read_text().strip()
    if not re.fullmatch(r'age1[0-9a-z]+', recipient):
        raise ValueError('Expected a native age public recipient, never a private key')
    output = Path(output)
    partial = output.with_suffix('.age.partial')
    with partial.open('xb') as target:
        os.chmod(partial, 0o600)
        process = subprocess.Popen(['age', '--encrypt', '--recipient', recipient], stdin=subprocess.PIPE, stdout=target)
        try:
            with tarfile.open(fileobj=process.stdin, mode='w|gz') as archive:
                archive.add(bundle, arcname='.', recursive=True)
            process.stdin.close()
            if process.wait() != 0:
                raise ValueError('age encryption failed; partial ciphertext retained')
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
    partial.replace(output)


def decrypt(snapshot, identity, destination):
    destination = Path(destination)
    packed = destination / '.decrypted.tar.gz'
    subprocess.run(['age', '--decrypt', '--identity', str(identity), '--output', str(packed), str(snapshot)], check=True)
    seen = set()
    with tarfile.open(packed) as archive:
        for member in archive:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe encrypted snapshot member')
            if path in seen:
                raise ValueError('Duplicate encrypted snapshot member')
            seen.add(path)
            target = destination / path
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as source, target.open('xb') as stream:
                    shutil.copyfileobj(source, stream)
                target.chmod(0o600)
    packed.unlink()


def retain(directory, keep, others=()):
    if keep not in (1, 2):
        raise ValueError('Staging retention must keep one or two snapshots')
    directories = {Path(root).resolve() for root in [directory, *others]}
    files = sorted((p for root in directories if root.is_dir() for p in root.iterdir()
                    if NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()),
                   key=lambda path: path.name, reverse=True)
    for path in files[keep:]:
        path.unlink()


def transfer(snapshot, destination, idle, bwlimit=244):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:/[a-zA-Z0-9_./-]+/', destination):
        raise ValueError('Expected user@staging-host:/absolute/incoming/ destination')
    idle()
    # No --protect-args: the receiving account's rrsync must read the paths to confine them, and both names are
    # already restricted to [a-zA-Z0-9_./-] (the envelope name and the validated destination).
    process = subprocess.Popen(['rsync', '--partial-dir=.partial', '--bwlimit=%d' % bwlimit,
                                '-e', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
                                str(snapshot), destination])
    try:
        while process.poll() is None:
            time.sleep(15)
            idle()
        if process.returncode:
            raise ValueError('Transfer failed; Source ciphertext and destination partial retained for retry')
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()


def local_time(now=None):
    from zoneinfo import ZoneInfo
    config = json.loads(PRODUCT_CONFIG.read_text())
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(config['time_zone']))


def night(now=None):
    local = local_time(now)
    if not 3 <= local.hour < 6:
        raise ValueError('Capture is allowed only at deployment-local 03:00–06:00')
    return local
