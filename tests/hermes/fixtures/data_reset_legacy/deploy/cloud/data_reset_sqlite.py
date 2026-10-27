"""Counts and exact retained-row hashes; rebuild mixed SQLite without weakening audit triggers."""
import base64
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import sqlite3
import shutil
import tempfile

from data_reset_policy import GUARD, PAYMENT_KEEP, encoded, require, sync_directory


def quote(name):
    return '"' + name.replace('"', '""') + '"'


@contextmanager
def connect(path, scratch=None):
    path = Path(path)
    wal = Path(str(path) + '-wal')
    temporary, db = None, None
    try:
        if wal.exists() and wal.stat().st_size:
            # Inspect a private snapshot: even a read-only WAL connection can create/change the source SHM.
            require(shutil.disk_usage(scratch or tempfile.gettempdir()).free > GUARD + path.stat().st_size + wal.stat().st_size,
                    'RESET_SQLITE_SNAPSHOT_CAPACITY')
            temporary = tempfile.TemporaryDirectory(prefix='sqlite-',dir=scratch)
            copied = Path(temporary.name) / path.name
            shutil.copyfile(path, copied); shutil.copyfile(wal, str(copied) + '-wal')
            db = sqlite3.connect(copied.as_uri() + '?mode=ro', uri=True)
        else:
            db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
        yield db
    finally:
        if db is not None:
            db.close()
        if temporary is not None:
            temporary.cleanup()


def tables(db):
    return [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                   "AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def predicate(table):
    if table in PAYMENT_KEEP:
        return '1'
    return "key IN ('schema','environment')" if table == 'meta' else '0'


def row_hash(db, table, where='1'):
    def cell(value):
        return {'blob': base64.b64encode(value).decode()} if isinstance(value, bytes) else value
    # Sort row digests, not values: preserves types/BLOB bytes without publishing any row body.
    hashes = sorted(hashlib.sha256(encoded([cell(v) for v in row])).digest()
                    for row in db.execute(f'SELECT * FROM {quote(table)} WHERE {where}'))
    return hashlib.sha256(b''.join(hashes)).hexdigest()


def inventory(path, mixed=False, scratch=None):
    with connect(path,scratch) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'RESET_SQLITE_CORRUPT')
        result = []
        for table in tables(db):
            total = db.execute(f'SELECT count(*) FROM {quote(table)}').fetchone()[0]
            keep = db.execute(f'SELECT count(*) FROM {quote(table)} WHERE {predicate(table)}').fetchone()[0] if mixed else 0
            result.append({'table': table, 'clear_rows': total - keep, 'keep_rows': keep,
                           'keep_sha256': row_hash(db, table, predicate(table)) if mixed else None})
        return result


def reset_payment(path, scratch=None):
    """New empty substrate with identical schema and setting rows; immutable events stay in the original quarantined file."""
    path = Path(path)
    target = path.with_name('.reset-payment.sqlite')
    require(not target.exists(), 'RESET_SQLITE_SCRATCH_EXISTS')
    stat = path.stat()
    try:
        with connect(path,scratch) as source, sqlite3.connect(target) as out:
            objects = source.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL "
                                     "AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").fetchall()
            for kind, name, sql in objects:
                if kind == 'table':
                    out.execute(sql)
            for table in tables(source):
                for row in source.execute(f'SELECT * FROM {quote(table)} WHERE {predicate(table)}'):
                    out.execute(f'INSERT INTO {quote(table)} VALUES ({",".join("?" for _ in row)})', row)
            for kind, name, sql in objects:
                if kind != 'table':
                    out.execute(sql)
            require(out.execute('PRAGMA foreign_key_check').fetchall() == [], 'RESET_SQLITE_FOREIGN_KEY')
        out.close()
        os.chmod(target, stat.st_mode & 0o777)
        if os.geteuid() == 0:
            os.chown(target, stat.st_uid, stat.st_gid)
        with target.open('rb') as stream:
            os.fsync(stream.fileno())
        # Writers are fenced by the lifecycle. Old WAL cannot be replayed into the replacement.
        for suffix in ('-wal', '-shm'):
            Path(str(path) + suffix).unlink(missing_ok=True)
        target.replace(path)
        sync_directory(path.parent)
    finally:
        target.unlink(missing_ok=True)
