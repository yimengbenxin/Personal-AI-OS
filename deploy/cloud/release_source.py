"""One candidate source authority: a commit in the host's Git store, extracted and checked as Docker will read it.

The Docker build context is the repository root filtered by `.dockerignore` (every Dockerfile builds `../..`).
That filter is the only input-set authority: the materialized tree must equal the commit over every path Docker
reads, two-way, with file kinds (regular, executable, symlink) and contents, and nothing extra.
Release-owned state (stage env, receipts) lives in `<release>/.release`, which `.dockerignore` excludes.
"""
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
from release_send_policy import changed_send_policies

KINDS = {'100644': 'file', '100755': 'executable', '120000': 'symlink'}
B, G, I, H = ('01-product-half-finished/backend/', '01-product-half-finished/backend/phase0/gateway/src/',
              '01-product-half-finished/backend/services/personal-aios-integration/src/', 'integrations/hermes/personal_aios/')
# Only owner baselines need consent. Ordinary prompts, skills, model settings and integrations can self-release.
PROTECTED = ('deploy/', '.dockerignore', 'integrations/hermes/verify-producer.mjs', H + 'workshop_sandbox.py',
             H + 'effects.py', H + 'release_consent.py', I + 'effect-consent.ts', I + 'payment/', I + 'voiceprint/', I + 'owner-override.ts', I + 'owner-authority.ts',
             H + 'send_recipients.py', I + 'capability/send-', 'capability/contracts/send-recipient',
             G + 'personal-aios-payment-source.ts', G + 'personal-aios-payment-wire.ts', G + 'paired-device-',
             G + 'call-speech-identity.ts', G + 'owner-mac-ssh.ts', I + 'care/authority.ts',
             'integrations/connectors/phone_executor/payment_guard.py',
             'integrations/connectors/phone_executor/payment_checkpoint.py',
             'integrations/connectors/phone_executor/payment_lineage.py',
             'integrations/connectors/phone_executor/payment-grounded-regions.json')
NATIVE_BASELINES = ('gateway/run_scope.py', 'agent/secret_scope.py', 'agent/secret_sources/',
                    'agent/file_safety.py', 'tools/credential_files.py', 'tools/approval', 'tools/write_approval.py',
                    'tools/file_tools_write_guards.py', 'tools/environments/local_env_policy.py',
                    'tools/environments/docker', 'tools/environments/ssh.py')
PERSONA = H + 'persona/yimi.md'


def git(repo, *args, **options):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, **options).stdout


def ignore_rules(text):
    rules = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            rules.append((line.startswith('!'), line.lstrip('!').strip('/')))
    return rules


def _matches(path, pattern):
    parts = path.split('/')
    if pattern.startswith('**/'):
        tail = pattern[3:]
        return any(fnmatch.fnmatchcase('/'.join(parts[i:j]), tail)
                   for i in range(len(parts)) for j in range(i + 1, len(parts) + 1))
    # A pattern that names a directory excludes everything below it.
    return any(fnmatch.fnmatchcase('/'.join(parts[:j]), pattern) for j in range(1, len(parts) + 1))


def ignored(path, rules):
    # Docker semantics: the last matching rule decides.
    excluded = False
    for negated, pattern in rules:
        if _matches(path, pattern):
            excluded = not negated
    return excluded


def blob_id(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def commit_manifest(repo, commit, rules):
    manifest = {}
    for row in git(repo, 'ls-tree', '-r', '-z', '--full-tree', commit).split(b'\0'):
        if not row:
            continue
        meta, path = row.split(b'\t', 1)
        mode, kind, blob = meta.decode().split()
        path = path.decode()
        if kind != 'blob' or mode not in KINDS:
            raise ValueError('Unsupported tree entry for a Docker build input: ' + path)
        if not ignored(path, rules):
            manifest[path] = (KINDS[mode], blob)
    return manifest


def tree_manifest(root, rules):
    root = Path(root)
    manifest, directories = {}, set()
    for directory, names, files in os.walk(root):
        relative = Path(directory).relative_to(root).as_posix()
        prefix = '' if relative == '.' else relative + '/'
        kept = []
        for name in names:
            path = Path(directory) / name
            if ignored(prefix + name, rules):
                continue
            if path.is_symlink():
                files.append(name)
            else:
                kept.append(name)
                directories.add(prefix + name)
        names[:] = kept
        for name in files:
            if ignored(prefix + name, rules):
                continue
            path = Path(directory) / name
            if path.is_symlink():
                manifest[prefix + name] = ('symlink', blob_id(os.readlink(path).encode()))
            elif path.is_file():
                kind = 'executable' if path.stat().st_mode & 0o111 else 'file'
                manifest[prefix + name] = (kind, blob_id(path.read_bytes()))
            else:
                manifest[prefix + name] = ('special', '')
    return manifest, directories


def compare(repo, commit, root):
    """Two-way equality of the Docker input set; returns the receipt fields."""
    rules = ignore_rules(git(repo, 'show', commit + ':.dockerignore', text=True))
    expected = commit_manifest(repo, commit, rules)
    actual, directories = tree_manifest(root, rules)
    parents = {'/'.join(path.split('/')[:i]) for path in expected for i in range(1, path.count('/') + 1)}
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected)) + sorted(directories - parents)
    kinds = sorted(p for p in set(expected) & set(actual) if expected[p][0] != actual[p][0])
    different = sorted(p for p in set(expected) & set(actual) if expected[p][1] != actual[p][1])
    return {'docker_inputs': len(expected), 'missing': missing, 'extra': extra, 'kind_mismatches': kinds,
            'different': different, 'build_inputs_equal': not (missing or extra or kinds or different)}


def fetch(repo, bundle):
    """Import an operator or agent bundle into the store; commits are identified by hash, never by ref names."""
    git(repo, 'bundle', 'verify', str(bundle))
    git(repo, 'fetch', '--no-tags', str(bundle), '+refs/*:refs/paios/incoming/*')


def apply_patch(repo, base, patch, ref):
    """Commit an agent patch onto its exact base with a fixed identity; returns the candidate commit."""
    work = Path(repo).parent / ('.apply-' + ref.replace('/', '-'))
    git(repo, 'worktree', 'add', '--detach', str(work), base)
    try:
        identity = ['-c', 'user.name=Personal-AIOS release', '-c', 'user.email=release@paios.invalid', '-c', 'commit.gpgsign=false']
        subprocess.run(['git', '-C', str(work), *identity, 'am', '--3way', '--keep-cr', '--whitespace=nowarn', str(patch)],
                       check=True, capture_output=True)
        commit = git(work, 'rev-parse', 'HEAD', text=True).strip()
        git(repo, 'update-ref', 'refs/paios/' + ref, commit)
        return commit
    finally:
        git(repo, 'worktree', 'remove', '--force', str(work))


def native_baseline_changes(repo, base, commit, changed):
    """Compare baseline source hunks inside the locked archive; the producer verifier still proves the tree."""
    def read(revision, path):
        return git(repo, 'show', revision + ':' + path, text=True) if git(repo, 'ls-tree', revision, '--', path) else ''
    locks = [json.loads(text) if (text := read(revision, H + 'producer.lock.json')) else None
             for revision in (base, commit)]
    patches = [os.path.normpath(H + lock['patch']['path']) if lock else H + 'native-context.patch' for lock in locks]
    if not any(path in changed for path in (*patches, H + 'producer.lock.json')):
        return []
    def baselines(revision, path):
        patch = read(revision, path)
        sections = re.split(r'(?m)^diff --git a/(\S+) b/\S+\n', patch)
        return {sections[i]: sections[i + 1]
                for i in range(1, len(sections), 2) if sections[i].startswith(NATIVE_BASELINES)}
    before, after = (baselines(revision, path) for revision, path in zip((base, commit), patches))
    changes = ['native:' + path for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]
    if all(locks) and locks[0]['upstream'] != locks[1]['upstream']:
        changes.append('native:upstream-baseline')
    return changes


def protected_changes(repo, base, commit):
    changed = git(repo, 'diff', '--name-only', '--no-renames', base, commit, text=True).split()
    protected = [path for path in changed if path.startswith(PROTECTED)]
    if PERSONA in changed:
        def principle(revision):
            exists = git(repo, 'ls-tree', revision, '--', PERSONA, text=True)
            text = git(repo, 'show', revision + ':' + PERSONA, text=True) if exists else ''
            return re.findall(r'(?m)^最根本的一条[^\n]*(?:\n(?!\s*$)[^\n]+)*', text)
        if principle(base) != principle(commit):
            protected.append(PERSONA)
    phone_config = 'integrations/connectors/phone_executor/mobilerun-config.example.yaml'
    if phone_config in changed:
        import yaml
        def models(revision):
            if not git(repo, 'ls-tree', revision, '--', phone_config):
                return {}
            config = yaml.safe_load(git(repo, 'show', revision + ':' + phone_config, text=True))
            return {role: {key: profile.get(key) for key in ('provider', 'model', 'base_url')}
                    for role, profile in config['llm_profiles'].items()}
        if models(base) != models(commit):
            protected.append(phone_config)
    protected.extend(native_baseline_changes(repo, base, commit, changed))
    protected.extend(changed_send_policies(git, repo, base, commit, changed))
    return sorted(protected)


def materialize(repo, commit, releases, base=None):
    """Extract `commit` as releases/<sha8> and bind the receipt to it; an existing release is never overwritten."""
    commit = git(repo, 'rev-parse', '--verify', commit + '^{commit}', text=True).strip()
    target = Path(releases) / commit[:8]
    partial = target.with_name(target.name + '.partial')
    if target.exists():
        raise ValueError('PRESERVE_EXISTING_RELEASE: ' + str(target))
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(mode=0o755, parents=True)
    archive = subprocess.Popen(['git', '-C', str(repo), 'archive', '--format=tar', commit], stdout=subprocess.PIPE)
    digest = hashlib.sha256()
    extract = subprocess.Popen(['tar', '-x', '-f', '-', '-C', str(partial), '--no-same-owner'], stdin=subprocess.PIPE)
    for block in iter(lambda: archive.stdout.read(1 << 20), b''):
        digest.update(block)
        extract.stdin.write(block)
    extract.stdin.close()
    if archive.wait() or extract.wait():
        raise RuntimeError('SOURCE_EXTRACT_FAILED')
    receipt = {'schema': 'paios.release-source.v1', 'commit': commit, 'base': base,
               'tree': git(repo, 'rev-parse', commit + '^{tree}', text=True).strip(),
               'git_archive_tar_sha256': digest.hexdigest(), **compare(repo, commit, partial),
               'materialized_at': datetime.now(timezone.utc).isoformat()}
    if not receipt['build_inputs_equal']:
        raise ValueError('DOCKER_INPUTS_DIFFER: ' + json.dumps({k: receipt[k][:20] for k in ('missing', 'extra', 'kind_mismatches', 'different')}))
    (partial / '.release').mkdir(mode=0o700)
    (partial / '.release/source.json').write_text(json.dumps(receipt, indent=2) + '\n')
    partial.rename(target)
    return target, receipt


def verify(repo, release):
    """Re-check a release tree just before its images are built: nothing may have been added or changed."""
    receipt = json.loads((Path(release) / '.release/source.json').read_text())
    result = compare(repo, receipt['commit'], release)
    if not result['build_inputs_equal']:
        raise ValueError('DOCKER_INPUTS_DIFFER: ' + json.dumps({k: result[k][:20] for k in ('missing', 'extra', 'kind_mismatches', 'different')}))
    return receipt
