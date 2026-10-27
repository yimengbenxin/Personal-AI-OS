"""Real PostgreSQL archive/clear/restore regressions for SQL NULL versus JSON null."""
import json
import subprocess

import pytest

from data_reset_fixtures import ROOT
from data_reset_pg_fixture import pg_server, postgres
from data_reset_postgres import fingerprint, literal, quoted
from test_data_reset_review import settings_at
import data_reset


def produce(pg, mode):
    command = pg.commands['query']
    options = {name: command[command.index(flag) + 1] for name, flag in
               [('host', '-h'), ('port', '-p'), ('user', '-U'), ('database', '-d')]}
    options['port'] = int(options['port'])
    result = subprocess.run(['node', str(ROOT / 'tests/hermes/data_reset_json_null.ts'), json.dumps(options), mode],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def cycle(pg, path):
    before = pg.inventory()
    pg.write_dump(path, before)
    pg.verify_dump(path, before)
    pg.clear(before)
    pg.validate_restore(path)
    pg.restore(path)
    assert pg.inventory() == before


def test_not_null_jsonb_null_restores_through_production_memory_candidate(tmp_path, postgres):
    produce(postgres, 'mandatory')
    state = "SELECT value IS NULL,jsonb_typeof(value) FROM memory_candidates;"
    assert postgres.query(state) == 'f|null'
    settings = settings_at(tmp_path)
    cut = data_reset.run(settings, 'quarantine', postgres)
    assert postgres.query('SELECT count(*) FROM memory_candidates;') == '0'
    result = data_reset.run(settings, 'rollback', postgres, receipt_path=cut['receipt'])
    assert result['state'] == 'restored' and result['rollback_verified']
    assert postgres.query(state) == 'f|null'


def test_nullable_jsonb_preserves_json_null_and_sql_null(tmp_path, postgres):
    produce(postgres, 'nullable')
    produce(postgres, 'sql-null')
    state = "SELECT slot,conflict IS NULL,jsonb_typeof(conflict) FROM memory_candidates ORDER BY slot;"
    expected = 'null.nullable|f|null\nnull.sql-null|t|'
    assert postgres.query(state) == expected
    settings = settings_at(tmp_path)
    cut = data_reset.run(settings, 'quarantine', postgres)
    result = data_reset.run(settings, 'rollback', postgres, receipt_path=cut['receipt'])
    assert result['state'] == 'restored' and result['rollback_verified']
    assert postgres.query(state) == expected


def migration_json_columns(pg):
    return json.loads(pg.query("SELECT json_agg(json_build_object('table',n.nspname||'.'||c.relname,"
        "'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) "
        "ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a "
        "JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE a.attnum>0 AND NOT a.attisdropped AND a.atttypid IN ('json'::regtype,'jsonb'::regtype) "
        "AND c.relkind IN ('r','p') AND n.nspname='public';"))


def test_all_migration_json_columns_roundtrip_both_nulls(tmp_path, postgres):
    columns = migration_json_columns(postgres)
    assert columns
    grouped = {}
    for column in columns:
        grouped.setdefault(column['table'], []).append(column)
    checks = []
    for index, (table, fields) in enumerate(grouped.items()):
        schema = 'v7_catalog_' + str(index)
        clone = quoted(schema + '.paios_l3_versions')
        # Preserve each migration's full row shape. Drop only the clones' NOT NULL
        # flags so even originally mandatory fields can exercise SQL NULL as well.
        attributes = json.loads(postgres.query("SELECT json_agg(attname) FROM pg_attribute WHERE attrelid="
            + literal(table) + "::regclass AND attnum>0 AND NOT attisdropped AND attnotnull;")) or []
        sql = 'CREATE SCHEMA ' + schema + '; CREATE TABLE ' + clone + ' (LIKE ' + quoted(table) + ');'
        sql += ''.join('ALTER TABLE ' + clone + ' ALTER COLUMN ' + quoted(name) + ' DROP NOT NULL;' for name in attributes)
        names = ','.join(quoted(field['column']) for field in fields)
        for value in ('null', '{"nested":[null,{"x":null}]}', '[null,{"x":[null]}]'):
            sql += 'INSERT INTO ' + clone + '(' + names + ') VALUES(' + ','.join(
                literal(value) + '::' + field['type'] for field in fields) + ');'
        sql += 'INSERT INTO ' + clone + ' DEFAULT VALUES;'
        postgres.query(sql)
        for field in fields:
            name = quoted(field['column'])
            checks.append("SELECT " + literal(table + '.' + field['column']) + ",count(*) FILTER(WHERE " + name
                + ' IS NULL),count(*) FILTER(WHERE ' + field['type'] + '_typeof(' + name + ")='null'),"
                + 'count(*) FILTER(WHERE ' + name + "::jsonb='" + '{"nested":[null,{"x":null}]}' + "'::jsonb),"
                + 'count(*) FILTER(WHERE ' + name + "::jsonb='[null,{\"x\":[null]}]'::jsonb) FROM " + clone + ';')
    expected = postgres.query(''.join(checks))
    assert all(line.endswith('|1|1|1|1') for line in expected.splitlines())
    print('MIGRATION_JSON_COLUMNS', json.dumps({'columns': len(columns), 'json': sum(c['type'] == 'json' for c in columns),
        'jsonb': sum(c['type'] == 'jsonb' for c in columns), 'not_null': sum(c['not_null'] for c in columns)}))
    cycle(postgres, tmp_path / 'catalog.jsonl')
    assert postgres.query(''.join(checks)) == expected


def test_nested_json_nulls_already_survive(tmp_path, postgres):
    postgres.query("CREATE SCHEMA v7_nested; CREATE TABLE v7_nested.paios_l3_versions (j json,jb jsonb);"
        "INSERT INTO v7_nested.paios_l3_versions VALUES('{\"obj\":null,\"arr\":[null,{\"x\":null}]}',"
        "'[null,{\"x\":[null]}]');")
    state = 'SELECT j::text,jb::text FROM v7_nested.paios_l3_versions;'
    expected = postgres.query(state)
    cycle(postgres, tmp_path / 'nested.jsonl')
    assert postgres.query(state) == expected


def test_json_arrays_domains_composites_and_native_types_roundtrip(tmp_path, postgres):
    postgres.query("CREATE SCHEMA v7_types; CREATE DOMAIN v7_types.dj AS json; CREATE DOMAIN v7_types.djb AS jsonb;"
        "CREATE TYPE v7_types.pair AS (j json,jb jsonb); CREATE DOMAIN v7_types.dp AS v7_types.pair;"
        "CREATE DOMAIN v7_types.da AS jsonb[];"
        "CREATE TABLE v7_types.paios_l3_versions (id int,j json,jb jsonb,ja json[],jba jsonb[],"
        "dj v7_types.dj,djb v7_types.djb,p v7_types.pair,dp v7_types.dp,da v7_types.da,pa v7_types.pair[],"
        "texts text[],at timestamptz,span interval,bytes bytea,f float8);"
        "INSERT INTO v7_types.paios_l3_versions VALUES(1,'null','null',"
        "ARRAY['null'::json,NULL,'{\"x\":[null]}'],ARRAY['null'::jsonb,NULL,'[null]'],"
        "'null','null',ROW('null'::json,'null'::jsonb),ROW('null'::json,'null'::jsonb),"
        "ARRAY['null'::jsonb,NULL],ARRAY[ROW('null'::json,'null'::jsonb)::v7_types.pair,NULL,ROW(NULL,NULL)::v7_types.pair],"
        "ARRAY['NULL',NULL,'null','quote\" slash\\ newline' || chr(10) || '汉字'],"
        "'2026-10-27T12:34:56.123456+08','1 year 2 mons 3 days 04:05:06.789','\\x000a27ff',1.2345678901234567);"
        "INSERT INTO v7_types.paios_l3_versions(id) VALUES(2);"
        "INSERT INTO v7_types.paios_l3_versions(id,ja,jba) VALUES(3,"
        "'[0:1][2:3]={{\"null\",NULL},{\"{\\\"x\\\":null}\",\"[null]\"}}'::json[],"
        "'[0:1][2:3]={{\"null\",NULL},{\"{\\\"x\\\":null}\",\"[null]\"}}'::jsonb[]);")
    state = 'SELECT t::text FROM v7_types.paios_l3_versions t ORDER BY id;'
    # A textual json value also retains whitespace and duplicate keys.
    postgres.query("UPDATE v7_types.paios_l3_versions SET j='{ \"x\": null, \"x\": [null] }' WHERE id=3;")
    expected = postgres.query(state)
    cycle(postgres, tmp_path / 'types.jsonl')
    assert postgres.query(state) == expected
    assert postgres.query("SELECT j IS NULL,json_typeof(j),ja[1] IS NULL,json_typeof(ja[1]),ja[2] IS NULL,"
        "(p).j IS NULL,json_typeof((p).j),pa[2]::text IS NULL,pa[3]::text IS NULL "
        "FROM v7_types.paios_l3_versions WHERE id=1;") == 'f|null|f|null|t|f|null|t|f'
    assert postgres.query('SELECT array_dims(ja) FROM v7_types.paios_l3_versions WHERE id=3;') == '[0:1][2:3]'


def test_native_row_encoding_independent_of_session_defaults(tmp_path, postgres):
    postgres.query("CREATE SCHEMA v7_guc; CREATE TABLE v7_guc.paios_l3_versions (at timestamptz,span interval,bytes bytea,f float8);"
        "INSERT INTO v7_guc.paios_l3_versions VALUES('2026-10-27T12:34:56.123456+08',"
        "'1 year 2 mons 3 days 04:05:06.789','\\x000a27ff',1.2345678901234567);")
    before = postgres.inventory()
    archive = tmp_path / 'session-defaults.jsonl'
    postgres.write_dump(archive, before)
    postgres.verify_dump(archive, before)
    database = postgres.identity()['database']
    postgres.query('ALTER DATABASE ' + quoted(database) + " SET DateStyle='SQL, DMY'; ALTER DATABASE "
        + quoted(database) + " SET IntervalStyle='iso_8601'; ALTER DATABASE " + quoted(database)
        + " SET TimeZone='America/Los_Angeles'; ALTER DATABASE " + quoted(database) + " SET bytea_output='escape';")
    postgres.clear(before)
    postgres.validate_restore(archive)
    postgres.restore(archive)
    assert postgres.inventory() == before


@pytest.mark.parametrize('source,target', [("'null'::jsonb", 'NULL'), ('NULL', "'null'::jsonb")],
                         ids=['json-to-sql', 'sql-to-json'])
def test_json_null_flip_invalidates_dump_and_locked_plan(tmp_path, postgres, source, target):
    postgres.query('CREATE SCHEMA v7_seal; CREATE TABLE v7_seal.paios_l3_versions (j jsonb);'
                   'INSERT INTO v7_seal.paios_l3_versions VALUES(' + source + ');')
    before = postgres.inventory()
    postgres.query('UPDATE v7_seal.paios_l3_versions SET j=' + target + ';')
    archive = tmp_path / 'drift.jsonl'
    postgres.write_dump(archive, before)
    with pytest.raises(ValueError, match='^RESET_POSTGRES_DUMP_PLAN_CHANGED$'):
        postgres.verify_dump(archive, before)
    with pytest.raises(ValueError, match='^RESET_POSTGRES_CHANGED_SINCE_PLAN$'):
        postgres.clear(before)
    assert postgres.query('SELECT count(*) FROM v7_seal.paios_l3_versions;') == '1'


@pytest.mark.parametrize('kind', ['json', 'jsonb'])
@pytest.mark.parametrize('source,target', [("'null'", 'NULL'), ('NULL', "'null'")], ids=['json-to-sql', 'sql-to-json'])
def test_restore_verification_rejects_json_null_flip(tmp_path, postgres, kind, source, target):
    postgres.query('CREATE SCHEMA v7_flip; CREATE TABLE v7_flip.paios_l3_versions (j ' + kind + ');'
        'INSERT INTO v7_flip.paios_l3_versions VALUES(' + source + '::' + kind + ');')
    before = postgres.inventory()
    archive = tmp_path / 'flip.jsonl'
    postgres.write_dump(archive, before)
    postgres.verify_dump(archive, before)
    postgres.clear(before)
    postgres.query('CREATE FUNCTION v7_flip.flip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.j := '
        + target + '::' + kind + '; RETURN NEW; END; $$; CREATE TRIGGER flip BEFORE INSERT ON '
        'v7_flip.paios_l3_versions FOR EACH ROW EXECUTE FUNCTION v7_flip.flip();')
    live = postgres.inventory()
    with pytest.raises(ValueError, match='^RESET_POSTGRES_CONFLICT_CLEAR_V7_FLIP_PAIOS_L3_VERSIONS_P0001$'):
        postgres.restore(archive)
    assert postgres.inventory() == live


def test_each_catalog_json_column_digest_detects_both_null_flips(postgres):
    columns = migration_json_columns(postgres)
    unchanged = []
    for column in columns:
        relation = quoted(column['table'])
        attrs = json.loads(postgres.query("SELECT json_agg(format_type(atttypid,atttypmod) ORDER BY attnum) "
            "FROM pg_attribute WHERE attrelid=" + literal(column['table']) + "::regclass AND attnum>0 AND NOT attisdropped;"))
        # Typed row expressions avoid all table constraints without changing the
        # real composite type used by the digest, including mandatory columns.
        row = 'ROW(' + ','.join('NULL::' + typ for typ in attrs) + ')::' + relation
        sql_null = '(SELECT (' + row + ').*)'
        fields = json.loads(postgres.query("SELECT json_agg(attname ORDER BY attnum) FROM pg_attribute WHERE attrelid="
            + literal(column['table']) + "::regclass AND attnum>0 AND NOT attisdropped;"))
        values = ["'null'::" + typ if field == column['column'] else 'NULL::' + typ for field, typ in zip(fields, attrs)]
        json_null = '(SELECT (ROW(' + ','.join(values) + ')::' + relation + ').*)'
        a, b = fingerprint(sql_null, 'true'), fingerprint(json_null, 'true')
        if postgres.query('SELECT ' + a + '<>' + b + ';') != 't':
            unchanged.append(column['table'] + '.' + column['column'])
    assert unchanged == [], 'Digest misses SQL/JSON null in: ' + ', '.join(unchanged)
