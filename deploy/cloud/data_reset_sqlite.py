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


def companions(path):
    return [Path(str(path)+suffix) for suffix in ('-wal', '-shm')]


def cleanup_payment_scratch(path, published=()):
    target = Path(path).with_name('.reset-payment.sqlite')
    for candidate in [target, *companions(target)]:
        if candidate.exists() or candidate.is_symlink():
            require(candidate.is_file() and not candidate.is_symlink(), 'RESET_SQLITE_SCRATCH_UNSAFE')
            info = candidate.stat()
            require(all((info.st_dev, info.st_ino) != (row['device'], row['inode']) for row in published),
                    'RESET_SQLITE_SCRATCH_PUBLISHED')
            require(info.st_nlink == 1, 'RESET_SQLITE_SCRATCH_PUBLISHED')
            candidate.unlink()
    sync_directory(target.parent)


@contextmanager
def connect(path, scratch=None, wal=True):
    path = Path(path)
    wal = Path(str(path) + '-wal') if wal is True else Path(wal) if wal else None
    temporary, db = None, None
    try:
        if wal and wal.exists() and wal.stat().st_size:
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


def inventory(path, mixed=False, scratch=None, wal=True):
    with connect(path,scratch,wal) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'RESET_SQLITE_CORRUPT')
        result = []
        for table in tables(db):
            total = db.execute(f'SELECT count(*) FROM {quote(table)}').fetchone()[0]
            keep = db.execute(f'SELECT count(*) FROM {quote(table)} WHERE {predicate(table)}').fetchone()[0] if mixed else 0
            result.append({'table': table, 'clear_rows': total - keep, 'keep_rows': keep,
                           'keep_sha256': row_hash(db, table, predicate(table)) if mixed else None,
                           **({'clear_sha256': row_hash(db, table, 'NOT ('+predicate(table)+')')} if mixed else {})})
        return result


def reset_payment(path, scratch=None, keep_from=None, keep_wal=True):
    """Build one substrate: live settings plus either empty or cut history, then install atomically."""
    path = Path(path)
    target = path.with_name('.reset-payment.sqlite')
    cleanup_payment_scratch(path)
    stat = path.stat()
    try:
        with connect(path,scratch) as source, connect(keep_from or path,scratch,keep_wal) as live, sqlite3.connect(target) as out:
            objects = source.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL "
                                     "AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").fetchall()
            if keep_from:
                require(source.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').fetchall() ==
                        live.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').fetchall(),
                        'RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT')
            for kind, name, sql in objects:
                if kind == 'table':
                    out.execute(sql)
            for table in tables(source):
                selections = [(live, predicate(table))]
                if keep_from:
                    selections.append((source, 'NOT ('+predicate(table)+')'))
                for db, where in selections:
                    for row in db.execute(f'SELECT * FROM {quote(table)} WHERE {where}'):
                        out.execute(f'INSERT INTO {quote(table)} VALUES ({",".join("?" for _ in row)})', row)
            if keep_from and source.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
                for table, seq in live.execute('SELECT name,seq FROM sqlite_sequence'):
                    prior = out.execute('SELECT seq FROM sqlite_sequence WHERE name=?', (table,)).fetchone()
                    out.execute('DELETE FROM sqlite_sequence WHERE name=?', (table,))
                    out.execute('INSERT INTO sqlite_sequence VALUES(?,?)', (table, max(seq, prior[0] if prior else 0)))
            for kind, name, sql in objects:
                if kind != 'table':
                    out.execute(sql)
            require(out.execute('PRAGMA foreign_key_check').fetchall() == [],
                    'RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT' if keep_from else 'RESET_SQLITE_FOREIGN_KEY')
        out.close()
        os.chmod(target, stat.st_mode & 0o777)
        if os.geteuid() == 0:
            os.chown(target, stat.st_uid, stat.st_gid)
        with target.open('rb') as stream:
            os.fsync(stream.fileno())
        # Writers are fenced by the lifecycle. Old WAL cannot be replayed into the replacement.
        for companion in companions(path):
            companion.unlink(missing_ok=True)
        target.replace(path)
        sync_directory(path.parent)
    except sqlite3.DatabaseError:
        if keep_from:
            raise ValueError('RESET_ROLLBACK_MIXED_UNMERGEABLE_PAYMENT') from None
        raise
    finally:
        target.unlink(missing_ok=True)
