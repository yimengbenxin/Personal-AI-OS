"""Run the shipped MCP contract validator with a host transport for this no-network template."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('driver', ROOT/'01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def run(package, command, requests, fixtures=None, dependencies=None):
    with tempfile.TemporaryDirectory(prefix='reset-package-contract-') as directory:
        work = Path(directory)
        for name, content in (fixtures or {}).items():
            (work/name).write_text(content)
        before = {p.relative_to(work).as_posix():p.read_bytes() for p in work.rglob('*') if p.is_file()}
        command = [sys.executable if command[0] == 'python3' else command[0],
                   *[arg.replace('/package/', str(package)+'/') for arg in command[1:]]]
        # Only OS transport is replaced. driver.check still evaluates real MCP replies and tests.
        profile = '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath '+json.dumps(str(work))+'))'
        command = ['/usr/bin/sandbox-exec', '-p', profile, *command]
        result = subprocess.run(command, cwd=work, input=''.join(json.dumps(row)+'\n' for row in requests),
                                text=True, capture_output=True, timeout=15,
                                env={**os.environ, 'PYTHONPATH':str(ROOT), 'PYTHONDONTWRITEBYTECODE':'1'})
        after = {p.relative_to(work).as_posix():p.read_bytes() for p in work.rglob('*') if p.is_file()}
        audit = dict(writes=[k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)],
                     network=[], stdout=result.stdout, stderr=result.stderr)
        return [json.loads(line) for line in result.stdout.splitlines()] if requests else [], audit, result.returncode


if sys.platform == 'darwin':
    driver.run = run
print(json.dumps(driver.check(Path(sys.argv[1]))))
