"""Stream only row digests out of PG; inventory memory does not grow with the history."""
import hashlib
import json
import subprocess

from data_reset_policy import require


def scan(command, declarations):
    statements = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', "SET LOCAL temp_file_limit='512MB';"]
    for table, action, predicate, relation in declarations:
        literal = table.replace("'", "''")
        statements += ["SELECT json_build_object('table','" + literal + "','action','" + action + "');",
            "SELECT json_build_object('keep',(" + predicate + "),'hash',h) FROM "
            "(SELECT t.*,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM " + relation + ' t) t ORDER BY h;']
    statements.append('COMMIT;')
    process = subprocess.Popen(command + ['-q', '-c', ''.join(statements)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    rows, current, all_hash, keep_hash = [], None, None, None
    def finish():
        if current is not None:
            current.update(sha256=all_hash.hexdigest(), keep_sha256=keep_hash.hexdigest(),
                           clear_rows=current['rows']-current['keep_rows'])
            rows.append(current)
    try:
        for line in process.stdout:
            value = json.loads(line)
            if 'table' in value:
                finish()
                current = {**value, 'rows': 0, 'keep_rows': 0}
                all_hash, keep_hash = hashlib.sha256(), hashlib.sha256()
            else:
                require(current is not None, 'RESET_POSTGRES_HASH_ORDER')
                hashed = value['hash'].encode()
                all_hash.update((b'\n' if current['rows'] else b'') + hashed)
                current['rows'] += 1
                if value['keep']:
                    keep_hash.update((b'\n' if current['keep_rows'] else b'') + hashed)
                    current['keep_rows'] += 1
        require(process.wait() == 0, 'RESET_POSTGRES_HASH_FAILED')
        finish()
        require(len(rows) == len(declarations), 'RESET_POSTGRES_HASH_INCOMPLETE')
        return rows
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill(); process.wait()
