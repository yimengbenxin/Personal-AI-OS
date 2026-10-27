"""PostgreSQL reset engine: one partition policy, durable cut and atomic rollback."""
from graphlib import TopologicalSorter
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess

from data_reset_policy import PG_CLEAR, PG_KEEP, GUARD, require, sync_directory

PINNED_LEASE = 'lease_ref_id IN (SELECT iphone_lease_ref_id FROM public.apple_physical_canary_bindings UNION SELECT watch_lease_ref_id FROM public.apple_physical_canary_bindings)'
MIXED = {'public.device_leases': PINNED_LEASE,
         'public.realtime_sessions': 'session_ref_id IN (SELECT session_ref_id FROM public.apple_physical_canary_bindings UNION '
             'SELECT session_ref_id FROM public.device_leases WHERE ' + PINNED_LEASE + ')'}
FORMAT = 'rq102-postgres-clear-v2'
# Composite text uses each field's native type I/O, preserving SQL NULL, JSON
# null, array bounds and nested composites. Use the same bytes for every seal.
ROW_TEXT = 't::text'
TEXT_SETTINGS = ("SET standard_conforming_strings=on; SET DateStyle='ISO, YMD'; SET IntervalStyle='postgres'; "
                 "SET TimeZone='UTC'; SET extra_float_digits=3; SET bytea_output='hex'; "
                 "SET array_nulls=on; SET client_encoding='UTF8';")


def quoted(name):
    return '.'.join('"' + part.replace('"', '""') + '"' for part in name.split('.'))


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def planned_tables(before):
    return [(row['table'], row['action'], 'true' if row['action'] == 'keep' else MIXED.get(row['table'], 'false'),
             quoted(row['table'])) for row in before]


class Postgres:
    def __init__(self, commands):
        self.commands = commands

    @classmethod
    def local(cls, prefix, arguments):
        return cls({'query': prefix + ['psql', '-XAt', '--set', 'ON_ERROR_STOP=1'] + arguments,
                    'decode': prefix + ['pg_restore', '--data-only', '--no-owner', '--no-acl', '--file=-']})

    def query(self, sql):
        result = subprocess.run(self.commands['query'] + ['-q'], input=TEXT_SETTINGS + sql, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            failure = re.search(r'\bRESET_POSTGRES_(?:WRITER_ACTIVE|CHANGED_SINCE_PLAN|CLEAR_VERIFY_FAILED)\b', result.stderr)
            raise ValueError(failure.group(0) if failure else 'RESET_POSTGRES_QUERY_FAILED')
        return result.stdout.strip()

    def declarations(self):
        relations = json.loads(self.query("SELECT coalesce(json_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]') "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') "
            "AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema';"))
        selections = []
        for table in relations:
            schema, name = table.split('.')
            require(table in PG_KEEP or name in PG_CLEAR and (schema == 'public' or name.startswith('paios_l3_')),
                    'RESET_POSTGRES_UNCLASSIFIED_TABLE')
            action = 'keep' if table in PG_KEEP else 'mixed' if table in MIXED else 'clear'
            selections.append((table, action, 'true' if action == 'keep' else MIXED.get(table, 'false'), quoted(table)))
        require('public.paired_devices' in relations and 'paios_migrations.schema_migrations' in relations,
                'RESET_POSTGRES_BASELINE_REQUIRED')
        return selections

    def inventory(self):
        return scan(self.commands['query'], self.declarations())

    def fingerprints(self, before):
        statements = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', "SET LOCAL temp_file_limit='512MB';"]
        for table, _, _, relation in planned_tables(before):
            statements.append("SELECT json_build_array(" + literal(table) + ',' + fingerprint(relation, 'true') + ');')
        statements.append('COMMIT;')
        return dict(json.loads(line) for line in self.query(''.join(statements)).splitlines())

    def clear_sql(self, before, fresh):
        selected = [row['table'] for row in before if row['action'] == 'clear']
        sql = ''
        if selected:
            sql = 'TRUNCATE ' + ','.join(map(quoted, selected)) + (' RESTART IDENTITY;' if fresh else ' CONTINUE IDENTITY;')
        sql += ''.join('DELETE FROM ' + quoted(table) + ' WHERE NOT (' + MIXED[table] + ');'
                       for table in ('public.device_leases', 'public.realtime_sessions') if any(row['table'] == table for row in before))
        if fresh and 'public.memory_authority_clock' in selected:
            sql += "INSERT INTO public.memory_authority_clock(clock_id,watermark) VALUES(true,'1');"
        return sql

    def clear(self, before, fresh=True, *, resume=False):
        """One lock/compare/clear/verify transaction; no row outside the cut is deleted."""
        tables = planned_tables(before)
        unchanged = ' AND '.join(fingerprint(relation, 'true') + '=' + literal(row['sha256'])
                                for row, (_, _, _, relation) in zip(before, tables)) or 'true'
        cleared = []
        for row, (table, _, predicate, relation) in zip(before, tables):
            cleared.append(fingerprint(relation, predicate) + '=' + literal(row['keep_sha256']))
            if fresh and table == 'public.memory_authority_clock':
                cleared.append("(SELECT count(*)=1 AND bool_and(clock_id AND watermark='1') FROM " + relation + ')')
            else:
                cleared.append('NOT EXISTS(SELECT 1 FROM ' + relation + ' WHERE NOT (' + predicate + '))')
        verified = ' AND '.join(cleared) or 'true'
        body = 'BEGIN LOCK TABLE ' + ','.join(relation for _, _, _, relation in tables) + ' IN ACCESS EXCLUSIVE MODE NOWAIT;'
        body += 'IF NOT (' + unchanged + ') THEN '
        if resume:
            # The prior COMMIT may have succeeded before the receipt save. Never clear again on this path.
            body += 'IF ' + verified + ' THEN RETURN; END IF;'
        body += "RAISE EXCEPTION 'RESET_POSTGRES_CHANGED_SINCE_PLAN'; END IF;"
        body += self.clear_sql(before, fresh)
        body += 'IF NOT (' + verified + ") THEN RAISE EXCEPTION 'RESET_POSTGRES_CLEAR_VERIFY_FAILED'; END IF;"
        body += "EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'RESET_POSTGRES_WRITER_ACTIVE'; END;"
        # No CASCADE and no disabled FKs: any failure rolls back clear and releases all locks.
        self.query("BEGIN; SET LOCAL temp_file_limit='512MB'; DO " + literal(body) + '; COMMIT;')

    def order(self, declarations):
        graph = {table: set() for table, _, _, _ in declarations}
        edges = json.loads(self.query("SELECT coalesce(json_agg(json_build_array(n.nspname||'.'||c.relname,"
            "pn.nspname||'.'||p.relname)),'[]') FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid "
            "JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class p ON p.oid=f.confrelid "
            "JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE f.contype='f';"))
        for child, parent in edges:
            if child in graph and parent in graph and child != parent:
                graph[child].add(parent)
        order = list(TopologicalSorter(graph).static_order())
        return sorted(declarations, key=lambda declaration: order.index(declaration[0]))

    def dump(self, before=None):
        statements = [TEXT_SETTINGS, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
                      'SELECT json_build_object(\'format\',' + literal(FORMAT) + ');']
        declarations = self.declarations() if before is None else planned_tables(before)
        for table, action, predicate, relation in self.order(declarations):
            if action != 'keep':
                statements.append(export_rows(table, relation, predicate))
        sequences = json.loads(self.query("SELECT coalesce(json_agg(quote_ident(n.nspname)||'.'||quote_ident(c.relname)),'[]') "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%';"))
        for sequence in sequences:
            statements.append("SELECT json_build_object('sequence'," + literal(sequence)
                              + ",'value',last_value,'called',is_called) FROM " + sequence + ';')
        statements.append('COMMIT;')
        return subprocess.Popen(self.commands['query'] + ['-q', '-c', ''.join(statements)],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def write_dump(self, target, before=None):
        target = Path(target)
        temporary = target.with_suffix('.partial')
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        process = self.dump(before)
        digest = hashlib.sha256()
        try:
            with temporary.open('wb') as stream:
                os.chmod(temporary, 0o600)
                while chunk := process.stdout.read(1 << 20):
                    require(shutil.disk_usage(target.parent).free > GUARD + len(chunk), 'RESET_POSTGRES_DUMP_CAPACITY')
                    stream.write(chunk)
                    digest.update(chunk)
                require(process.wait() == 0, 'RESET_POSTGRES_DUMP_FAILED')
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(target)
            sync_directory(target.parent)
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait()
        return {'pg_dump': str(target), 'pg_sha256': digest.hexdigest(), 'pg_bytes': target.stat().st_size}

    def database_bytes(self):
        return int(self.query('SELECT pg_database_size(current_database());'))

    def identity(self):
        return json.loads(self.query("SELECT json_build_object('database',current_database(),'user',current_user,"
                                     "'cluster',(SELECT system_identifier::text FROM pg_control_system()));"))

    def verify_dump(self, path, before):
        archive = self.prepare_restore(path, before)
        expected = {row['table']:{'clear_rows':row['clear_rows'], 'clear_sha256':row.get('clear_sha256', row['sha256'])}
                    for row in before if row['action'] != 'keep'}
        require(self.archive_inventory(archive, before) == expected, 'RESET_POSTGRES_DUMP_PLAN_CHANGED')

    def archive_inventory(self, path, before=None):
        declarations = self.declarations() if before is None else planned_tables(before)
        result = {table: {'clear_rows': 0, 'hash': hashlib.sha256()} for table, action, _, _ in declarations if action != 'keep'}
        with Path(path).open('rb') as stream:
            require(json.loads(stream.readline()) == {'format': FORMAT}, 'RESET_POSTGRES_ARCHIVE_FORMAT')
            for line in stream:
                row = json.loads(line)
                if 'table' in row:
                    current = result[row['table']]
                    current['hash'].update((b'\n' if current['clear_rows'] else b'') + row['hash'].encode())
                    current['clear_rows'] += 1
        return {table: {'clear_rows': row['clear_rows'], 'clear_sha256': row['hash'].hexdigest()} for table, row in result.items()}

    def prepare_restore(self, path, before):
        """Convert this engine's old custom archive without modifying live rows."""
        path = Path(path)
        with path.open('rb') as stream:
            if stream.read(5) != b'PGDMP':
                return path
        declarations = self.order(self.declarations())
        stages = {table: 'pg_temp.rq102_' + str(index) for index, (table, action, _, _) in enumerate(declarations) if action != 'keep'}
        actions = {table: action for table, action, _, _ in declarations}
        predicates = {table: predicate.replace('public.device_leases', stages['public.device_leases'])
                      for table, _, predicate, _ in declarations}
        sql = TEXT_SETTINGS + 'BEGIN ISOLATION LEVEL REPEATABLE READ;'
        for table, stage in stages.items():
            sql += 'CREATE TEMP TABLE ' + stage + ' (LIKE ' + quoted(table) + ') ON COMMIT DROP;'
        process = subprocess.Popen(self.commands['query'] + ['-q'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        decode = self.commands.get('decode')
        if decode is None:
            command = self.commands['restore']
            index = next(i for i, arg in enumerate(command) if Path(arg).name == 'pg_restore')
            decode = command[:index + 1] + ['--data-only', '--no-owner', '--no-acl', '--file=-']
        target = path.with_name(path.name + '.clear-v2')
        temporary = target.with_suffix('.partial')
        sequences = []
        try:
            process.stdin.write(sql.encode())
            with path.open('rb') as archive:
                decoder = subprocess.Popen(decode, stdin=archive, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                try:
                    for statement in sql_statements(decoder.stdout):
                        if statement.startswith('INSERT INTO '):
                            match = re.match(r'INSERT INTO ((?:"[^"]+"|[\w]+)\.(?:"[^"]+"|[\w]+))(?=\s)', statement)
                            require(match is not None, 'RESET_POSTGRES_LEGACY_INSERT')
                            table = match[1].replace('"', '')
                            require(table in stages, 'RESET_POSTGRES_LEGACY_TABLE')
                            tail = statement[match.end():]
                            require(tail.endswith(' ON CONFLICT DO NOTHING;'), 'RESET_POSTGRES_LEGACY_INSERT')
                            statement = 'INSERT INTO ' + stages[table] + tail[:-len(' ON CONFLICT DO NOTHING;')] + ';'
                            process.stdin.write(guarded(actions[table], table, statement).encode())
                        elif statement.startswith('SELECT pg_catalog.setval('):
                            match = re.fullmatch(r"SELECT pg_catalog.setval\('([\w.]+)', (\d+), (true|false)\);", statement)
                            require(match is not None, 'RESET_POSTGRES_LEGACY_SEQUENCE')
                            sequences.append({'sequence': quoted(match[1]), 'value': int(match[2]), 'called': match[3] == 'true'})
                        else:
                            require(statement.startswith('SET ') or statement.startswith('SELECT pg_catalog.set_config('), 'RESET_POSTGRES_LEGACY_STATEMENT')
                    require(decoder.wait() == 0, 'RESET_POSTGRES_LEGACY_DECODE')
                finally:
                    decoder.stdout.close()
                    if decoder.poll() is None:
                        decoder.kill()
                        decoder.wait()
            # pg_dump includes owned sequence state for the selected outbox table.
            # Row maxima cannot prove allocated-but-unused cursors from the cut.
            cursor_sequence = self.query("SELECT pg_get_serial_sequence('public.outbox_events','accepted_activity_cursor');")
            require(any(row['sequence'] == quoted(cursor_sequence) for row in sequences),
                    'RESET_POSTGRES_LEGACY_CURSOR_SEQUENCE_REQUIRED')
            expected = {row['table']: row for row in before}
            # Only 78d receipts lack clear_sha256. Preserve their existing
            # custom-dump proof in its original session/JSON digest convention.
            legacy_receipt = all('clear_sha256' not in row for row in before)
            sql = 'RESET ALL;' if legacy_receipt else ''
            proof_text = 'to_jsonb(t)::text' if legacy_receipt else ROW_TEXT
            for table in MIXED:
                # The old receipt proves this candidate, including retained refs on revoked bindings.
                sql += guarded('mixed', table, 'IF ' + fingerprint(stages[table], predicates[table], proof_text) + ' <> '
                    + literal(expected[table]['keep_sha256']) + ' OR (SELECT count(*) FROM ' + stages[table]
                    + ' WHERE ' + predicates[table] + ') <> ' + str(expected[table]['keep_rows'])
                    + " THEN RAISE EXCEPTION 'RESET_POSTGRES_LEGACY_PARTITION_UNRECOVERABLE'; END IF;")
            sql += TEXT_SETTINGS + 'SELECT json_build_object(\'format\',' + literal(FORMAT) + ');'
            for table, _, _, _ in declarations:
                if table in stages:
                    sql += export_rows(table, stages[table], predicates[table])
            sql += 'ROLLBACK;'
            process.stdin.write(sql.encode())
            process.stdin.close()
            with temporary.open('wb') as stream:
                os.chmod(temporary, 0o600)
                while chunk := process.stdout.read(1 << 20):
                    require(shutil.disk_usage(target.parent).free > GUARD + len(chunk), 'RESET_POSTGRES_DUMP_CAPACITY')
                    stream.write(chunk)
                error = process.stderr.read().decode(errors='replace')
                if process.wait() != 0:
                    raise restore_failure(error)
                for row in sequences:
                    stream.write((json.dumps(row) + '\n').encode())
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(target)
            sync_directory(target.parent)
            return target
        except BrokenPipeError:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            error = process.stderr.read().decode(errors='replace')
            process.wait()
            raise restore_failure(error) from None
        finally:
            process.stdout.close()
            process.stderr.close()
            if process.poll() is None:
                process.kill()
                process.wait()
            temporary.unlink(missing_ok=True)

    def validate_restore(self, path):
        self.restore(path, commit=False)

    def restore(self, path, commit=True):
        declarations = self.order(self.declarations())
        stages = {table: 'pg_temp.rq102_' + str(index) for index, (table, action, _, _) in enumerate(declarations) if action != 'keep'}
        actions = {table: action for table, action, _, _ in declarations}
        sql = TEXT_SETTINGS + 'BEGIN; SET CONSTRAINTS ALL IMMEDIATE; LOCK TABLE '
        sql += ','.join(relation for _, _, _, relation in declarations) + ' IN ACCESS EXCLUSIVE MODE;'
        # The checkpoint is captured under the same locks as the merge.
        sql += 'CREATE TEMP TABLE rq102_keep(table_name text PRIMARY KEY, fingerprint text) ON COMMIT DROP;'
        for table, _, predicate, relation in declarations:
            sql += 'INSERT INTO rq102_keep VALUES(' + literal(table) + ',' + fingerprint(relation, predicate) + ');'
            if table in stages:
                sql += 'CREATE TEMP TABLE ' + stages[table] + ' (LIKE ' + relation + ') ON COMMIT DROP;'
        sql += "CREATE TEMP TABLE rq102_trigger AS SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='public.outbox_events'::regclass "
        sql += "AND tgname IN ('outbox_events_accepted_activity_cursor_allocator','outbox_events_accepted_activity_notify');"
        sql += "DO $rq$ DECLARE t record; BEGIN FOR t IN SELECT * FROM rq102_trigger LOOP EXECUTE format('ALTER TABLE public.outbox_events DISABLE TRIGGER %I',t.tgname); END LOOP; END $rq$;"
        process = subprocess.Popen(self.commands['query'] + ['-q'], stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            process.stdin.write(sql.encode())
            with Path(path).open('rb') as stream:
                require(stream.read(5) != b'PGDMP', 'RESET_POSTGRES_LEGACY_PARTITION_REQUIRED')
                stream.seek(0)
                require(json.loads(stream.readline()) == {'format': FORMAT}, 'RESET_POSTGRES_ARCHIVE_FORMAT')
                sequences = []
                for line in stream:
                    row = json.loads(line)
                    if 'sequence' in row:
                        sequences.append(row)
                    else:
                        require(row['table'] in stages, 'RESET_POSTGRES_ARCHIVE_TABLE')
                        relation = stages[row['table']]
                        statement = 'INSERT INTO ' + relation + ' SELECT (' + literal(row['row']) + '::' + quoted(row['table']) + ').*;'
                        process.stdin.write(guarded(actions[row['table']], row['table'], statement).encode())
            sql = self.clear_sql([{'table': table, 'action': action} for table, action, _, _ in declarations], False)
            for table, action, _, relation in declarations:
                if table in stages:
                    sql += guarded(action, table, 'INSERT INTO ' + relation + ' SELECT * FROM ' + stages[table] + ';')
            for table, action, predicate, relation in declarations:
                sql += guarded(action, table, 'IF ' + fingerprint(relation, predicate)
                    + ' IS DISTINCT FROM (SELECT fingerprint FROM rq102_keep WHERE table_name=' + literal(table)
                    + ") THEN RAISE EXCEPTION 'RESET_POSTGRES_KEEP_CHANGED'; END IF;")
                if table in stages:
                    actual = 'SELECT ' + ROW_TEXT + ' FROM ' + relation + ' t WHERE NOT (' + predicate + ')'
                    archived = 'SELECT ' + ROW_TEXT + ' FROM ' + stages[table] + ' t'
                    difference = '((' + actual + ' EXCEPT ALL ' + archived + ') UNION ALL (' + archived + ' EXCEPT ALL ' + actual + '))'
                    sql += guarded(action, table, 'IF EXISTS' + difference + " THEN RAISE EXCEPTION 'RESET_POSTGRES_CLEAR_CHANGED'; END IF;")
            for sequence in sequences if commit else []:
                name = sequence['sequence']
                value, called = int(sequence['value']), 'true' if sequence['called'] else 'false'
                sql += 'SELECT setval(' + literal(name) + ',GREATEST(last_value,' + str(value) + '),is_called OR '
                sql += called + ') FROM ' + name + ';'
            sql += "DO $rq$ DECLARE t record; BEGIN FOR t IN SELECT * FROM rq102_trigger LOOP EXECUTE format('ALTER TABLE public.outbox_events %s TRIGGER %I',"
            sql += "CASE t.tgenabled WHEN 'O' THEN 'ENABLE' WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' END,t.tgname); END LOOP; END $rq$;"
            sql += 'COMMIT;' if commit else 'ROLLBACK;'
            process.stdin.write(sql.encode())
            process.stdin.close()
            error = process.stderr.read().decode(errors='replace')
            if process.wait() != 0:
                raise restore_failure(error)
        except BrokenPipeError:
            # ON_ERROR_STOP can close stdin before the remaining merge SQL is sent.
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            error = process.stderr.read().decode(errors='replace')
            process.wait()
            raise restore_failure(error) from None
        finally:
            process.stderr.close()
            if process.poll() is None:
                process.kill()
                process.wait()


def guarded(action, table, statement):
    code = 'RESET_POSTGRES_CONFLICT_'+action.upper()+'_'+table.replace('.', '_').upper()
    body = 'BEGIN ' + statement + " EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '" + code + "_%',SQLSTATE; END;"
    return 'DO ' + literal(body) + ';'


def restore_failure(error):
    failure = re.search(r'RESET_POSTGRES_CONFLICT_(?:KEEP|MIXED|CLEAR)_[A-Z0-9_]+_[0-9A-Z]{5}', error)
    return ValueError(failure.group(0) if failure else 'RESET_RESTORE_POSTGRES_FAILED')


def fingerprint(relation, predicate, row_text=ROW_TEXT):
    return "(SELECT encode(sha256(convert_to(coalesce(string_agg(h,E'\\n' ORDER BY h),''),'UTF8')),'hex') FROM " \
        + '(SELECT ' + row_digest(row_text) + ' h FROM ' + relation + ' t WHERE ' + predicate + ') s)'


def row_digest(row_text=ROW_TEXT):
    return "encode(sha256(convert_to(" + row_text + ",'UTF8')),'hex')"


def export_rows(table, relation, predicate):
    hashed = row_digest()
    return "SELECT json_build_object('table'," + literal(table) + ",'row'," + ROW_TEXT + ",'hash'," + hashed \
        + ') FROM ' + relation + ' t WHERE NOT (' + predicate + ') ORDER BY ' + hashed + ';'


def scan(command, declarations):
    statements = [TEXT_SETTINGS, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', "SET LOCAL temp_file_limit='512MB';"]
    for table, action, predicate, relation in declarations:
        literal = table.replace("'", "''")
        statements += ["SELECT json_build_object('table','" + literal + "','action','" + action + "');",
            "SELECT json_build_object('keep',(" + predicate + "),'hash',h) FROM "
            "(SELECT t.*," + row_digest() + ' h FROM ' + relation + ' t) t ORDER BY h;']
    statements.append('COMMIT;')
    process = subprocess.Popen(command + ['-q', '-c', ''.join(statements)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    rows, current, all_hash, keep_hash, clear_hash = [], None, None, None, None
    def finish():
        if current is not None:
            current.update(sha256=all_hash.hexdigest(), keep_sha256=keep_hash.hexdigest(), clear_sha256=clear_hash.hexdigest(),
                           clear_rows=current['rows']-current['keep_rows'])
            rows.append(current)
    try:
        for line in process.stdout:
            value = json.loads(line)
            if 'table' in value:
                finish()
                current = {**value, 'rows': 0, 'keep_rows': 0}
                all_hash, keep_hash, clear_hash = hashlib.sha256(), hashlib.sha256(), hashlib.sha256()
            else:
                require(current is not None, 'RESET_POSTGRES_HASH_ORDER')
                hashed = value['hash'].encode()
                all_hash.update((b'\n' if current['rows'] else b'') + hashed)
                current['rows'] += 1
                if value['keep']:
                    keep_hash.update((b'\n' if current['keep_rows'] else b'') + hashed)
                    current['keep_rows'] += 1
                else:
                    clear_count = current['rows'] - current['keep_rows'] - 1
                    clear_hash.update((b'\n' if clear_count else b'') + hashed)
        require(process.wait() == 0, 'RESET_POSTGRES_HASH_FAILED')
        finish()
        require(len(rows) == len(declarations), 'RESET_POSTGRES_HASH_INCOMPLETE')
        return rows
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill(); process.wait()


def sql_statements(lines):
    """Split pg_restore INSERT output; quoted row bytes can contain newlines and SQL."""
    buffer, quote, dollar, block, escaped = [], None, None, 0, False
    for line in lines:
        if not buffer and line.startswith(('\\restrict ', '\\unrestrict ')):
            continue
        index = 0
        while index < len(line):
            char = line[index]
            pair = line[index:index + 2]
            if block:
                if pair in ('/*', '*/'):
                    block += 1 if pair == '/*' else -1
                    index += 2
                else:
                    index += 1
                continue
            if dollar:
                if line.startswith(dollar, index):
                    buffer.append(dollar)
                    index += len(dollar)
                    dollar = None
                else:
                    buffer.append(char)
                    index += 1
                continue
            if quote:
                buffer.append(char)
                if escaped and char == '\\':
                    index += 1
                    require(index < len(line), 'RESET_POSTGRES_LEGACY_STRING')
                    buffer.append(line[index])
                elif char == quote:
                    if index + 1 < len(line) and line[index + 1] == quote:
                        index += 1
                        buffer.append(quote)
                    else:
                        quote = None
                index += 1
                continue
            if pair == '--':
                if buffer:
                    buffer.append('\n')
                break
            if pair == '/*':
                block = 1
                index += 2
                continue
            if char in ("'", '"'):
                quote = char
                escaped = char == "'" and bool(buffer) and buffer[-1] in ('E', 'e')
            elif char == '$':
                match = re.match(r'\$(?:[A-Za-z_]\w*)?\$', line[index:])
                if match:
                    dollar = match[0]
                    buffer.append(dollar)
                    index += len(dollar)
                    continue
            buffer.append(char)
            index += 1
            if char == ';':
                yield ''.join(buffer).strip()
                buffer = []
        if not quote and not dollar and not block and not ''.join(buffer).strip():
            buffer = []
    require(not quote and not dollar and not block and not ''.join(buffer).strip(), 'RESET_POSTGRES_LEGACY_SQL_INCOMPLETE')
