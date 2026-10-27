"""Release's local PostgreSQL transport; a closed table set protects settings and migration baselines."""
import hashlib
import json
import subprocess

from data_reset_policy import PG_CLEAR, PG_KEEP, require
from data_reset_pg_hash import scan

PINNED_LEASE = 'lease_ref_id IN (SELECT iphone_lease_ref_id FROM public.apple_physical_canary_bindings UNION SELECT watch_lease_ref_id FROM public.apple_physical_canary_bindings)'
MIXED = {'public.device_leases': PINNED_LEASE,
         'public.realtime_sessions': 'session_ref_id IN (SELECT session_ref_id FROM public.apple_physical_canary_bindings UNION '
             'SELECT session_ref_id FROM public.device_leases WHERE ' + PINNED_LEASE + ')'}


def quoted(name):
    return '.'.join('"' + p.replace('"', '""') + '"' for p in name.split('.'))


class Postgres:
    def __init__(self, commands):
        self.commands = commands

    def query(self, sql):
        result = subprocess.run(self.commands['query'] + ['-q'], input=sql, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode == 0, 'RESET_POSTGRES_QUERY_FAILED')
        return result.stdout.strip()

    def inventory(self):
        relations = json.loads(self.query("SELECT coalesce(json_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]') "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') "
            "AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema';"))
        selections = []
        for table in relations:
            schema, name = table.split('.')
            require(table in PG_KEEP or name in PG_CLEAR and (schema == 'public' or name.startswith('paios_l3_')),
                    'RESET_POSTGRES_UNCLASSIFIED_TABLE')
            action = 'keep' if table in PG_KEEP else 'mixed' if table in MIXED else 'clear'
            predicate = 'true' if action == 'keep' else MIXED.get(table, 'false')
            selections.append((table, action, predicate, quoted(table)))
        require('public.paired_devices' in relations and 'paios_migrations.schema_migrations' in relations,
                'RESET_POSTGRES_BASELINE_REQUIRED')
        return scan(self.commands['query'], selections)

    def clear(self, before, fresh=True):
        selected = [r['table'] for r in before if r['action'] == 'clear']
        # TRUNCATE avoids changing append-only UPDATE/DELETE guards. No CASCADE: a protected FK aborts the transaction.
        if selected:
            seed = ("INSERT INTO public.memory_authority_clock(clock_id,watermark) VALUES(true,'1');"
                    if fresh and 'public.memory_authority_clock' in selected else '')
            delete = ''.join('DELETE FROM ' + quoted(t) + ' WHERE NOT (' + MIXED[t] + ');'
                             for t in ('public.device_leases', 'public.realtime_sessions') if any(r['table'] == t for r in before))
            self.query('BEGIN; TRUNCATE ' + ','.join(map(quoted, selected)) + ' RESTART IDENTITY;' + delete + seed + 'COMMIT;')

    def dump(self):
        selected = [r['table'] for r in self.inventory() if r['action'] != 'keep']
        return subprocess.Popen(self.commands['dump'] + ['--data-only', '--inserts', '--on-conflict-do-nothing', *['--table=' + quoted(t) for t in selected]],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def database_bytes(self):
        return int(self.query('SELECT pg_database_size(current_database());'))

    def identity(self):
        return json.loads(self.query("SELECT json_build_object('database',current_database(),'user',current_user,"
                                     "'cluster',(SELECT system_identifier::text FROM pg_control_system()));"))

    def restore(self):
        return subprocess.Popen(self.commands['restore'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
