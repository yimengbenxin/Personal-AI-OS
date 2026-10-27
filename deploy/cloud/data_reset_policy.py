"""RQ-102's fixed data boundary. No policy, payment or biometric decision changes."""
import hashlib
import json
import os
from pathlib import Path

RESET_ID = 'RQ-102-N15'
TTL = 7 * 86400
GUARD = 12_000_000_000
EPOCH_KEY = hashlib.sha256(b'"paios.history.epoch.v1"').hexdigest()
EPOCH_PATH = 'central-storage/history-control/' + EPOCH_KEY
VOICE_KEY = hashlib.sha256(b'"paios.voiceprint.registry.v1"').hexdigest()
OVERRIDE_KEY = hashlib.sha256(b'paios.owner-override.v1').hexdigest()
KEEP_ROOTS = {'models', 'projections', 'secrets', 'packages', 'archive_settings'}
HOME_SETTINGS = {
    'config.yaml', '.env', '.op.env', 'auth.json', 'credentials.json', '.credentials.json', 'secrets', 'skills', 'plugins', 'tools',
    'toolsets', 'capabilities', 'capability-packages', 'SOUL.md', 'AGENTS.md', 'IDENTITY.md',
    'auth', '.auth', 'credentials', 'oauth', 'auth-pool', 'auth_pool', 'provider-tokens', 'mcp-tokens',
    '.ssh', '.gitconfig', '.netrc', 'workshop-ssh',
    '.claude', '.codex', '.qwen', '.aws', 'model-settings', 'model-projections', 'vault',
    'model-overrides.json', 'model_catalog.json', 'model_overrides.json', 'transport-overrides.json',
    'channel_directory.json', 'channel_aliases.json',
}
OWNER_SETTINGS = (
    'resources/', 'model-projections/', 'central-storage/model-settings/',
    'central-storage/capability-registry/versions/', 'central-storage/capability-packages/',
    'central-storage/enabled-packages/',
    'central-storage/camera-capture-policy/', 'central-storage/principal-preferences/',
    'central-storage/send-consents-v1/', 'central-storage/send-consent-migrations-v1/',
)
PAYMENT_KEEP = {'policy', 'locks', 'device_keys'}
PG_KEEP = {'public.paired_devices', 'public.glasses_enrollments', 'public.avatar_profiles',
           'public.terminal_enrollments', 'public.apple_physical_canary_bindings', 'paios_migrations.schema_migrations'}
PG_CLEAR = {
    'idempotency_ledger', 'outbox_events', 'outbox_consumer_dedupe', 'realtime_sessions',
    'device_leases', 'realtime_transport_aliases', 'realtime_terminal_facts', 'realtime_handoff_facts',
    'realtime_external_effects', 'memory_authority_clock', 'memory_candidates', 'memory_versions',
    'memory_dream_deltas', 'memory_derived_projections', 'memory_deletion_mutations', 'memory_rebuild_runs',
    'memory_candidate_heads', 'memory_slot_heads', 'apple_physical_canary_bindings',
    'paios_l3_versions', 'paios_l3_heads', 'paios_l3_receipts', 'paios_l3_dependencies',
    'paios_l3_invalidations', 'paios_l3_payloads', 'paios_l3_forgotten', 'mac_pairing_requests',
    'avatar_profile_commands',
}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def require(condition, code):
    if not condition:
        raise ValueError(code)


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def classify(role, relative):
    if role in ('release_dumps', 'snapshot_spool'):
        from data_reset_history import selected
        require(selected(role, relative), 'RESET_HISTORY_BACKUP_SCOPE')
        return 'clear'
    if role in KEEP_ROOTS:
        return 'keep'
    if role == 'hermes':
        if relative.startswith('workshop/'):
            return classify('hermes', relative[len('workshop/'):])
        if relative.startswith(('pairing/', 'platforms/pairing/')):
            return 'keep' if Path(relative).name.endswith('-approved.json') else 'clear'
        return 'keep' if Path(relative).parts[0] in HOME_SETTINGS else 'clear'
    if role == 'release_spool':
        return 'keep' if relative == 'base.json' else 'clear'
    if role in ('errands', 'core', 'desktop_in', 'desktop_out'):
        return 'clear'
    require(role == 'owner', 'RESET_ROOT_ROLE')
    if relative == 'central-storage/voiceprints/' + VOICE_KEY:
        return 'voiceprint'
    if relative == 'central-storage/voiceprints/' + OVERRIDE_KEY:
        return 'override'
    if relative == 'central-storage/payment/payment.sqlite':
        return 'payment'
    if relative.startswith('central-storage/effect-consents/'):
        return 'consent'
    if relative == EPOCH_PATH:
        return 'control'
    if relative.startswith('central-storage/capability-registry/'):
        import re
        if re.fullmatch(r'central-storage/capability-registry/[a-f0-9]{64}\.json',relative):
            return 'package_pins'
    if relative.startswith(OWNER_SETTINGS):
        return 'keep'
    return 'clear'


def tree_kind(role, relative):
    """Only descend across policy boundaries; L5 objects need stat/count, never byte reads."""
    if role in KEEP_ROOTS or role.startswith('baseline'):
        return 'keep'
    if role in ('errands', 'core', 'desktop_in', 'desktop_out'):
        return 'clear'
    if not relative:
        return 'mixed'
    if role == 'hermes':
        if relative == 'workshop':
            return 'mixed'
        if relative.startswith('workshop/'):
            return tree_kind(role, relative[len('workshop/'):])
        if any(p.startswith(relative.rstrip('/') + '/') or relative.startswith(p) for p in ('pairing/', 'platforms/pairing/')):
            return 'mixed'
        return classify(role, relative)
    if role == 'owner':
        protected = (*OWNER_SETTINGS, 'central-storage/voiceprints/', 'central-storage/payment/',
                     'central-storage/effect-consents/', 'central-storage/capability-registry/', EPOCH_PATH)
        if any(p.rstrip('/') == relative or p.startswith(relative.rstrip('/') + '/') for p in protected):
            return 'mixed'
        if relative.startswith(('central-storage/effect-consents/', 'central-storage/voiceprints/',
                                'central-storage/payment/', 'central-storage/capability-registry/')):
            return 'mixed'
    return classify(role, relative)


def validate(settings, restoring=False):
    require(settings.get('id') == RESET_ID, 'RESET_ID_REQUIRED')
    roots = {k: Path(v).absolute() for k, v in settings['roots'].items()}
    require({'owner', 'hermes', 'errands', 'secrets'} <= roots.keys(), 'RESET_ROOTS_REQUIRED')
    selective = {'release_dumps', 'snapshot_spool'}
    require(roots.keys() <= {'owner', 'hermes', 'errands', 'core', 'desktop_in', 'desktop_out', 'release_spool'} | KEEP_ROOTS | selective, 'RESET_ROOT_ROLE')
    checkout = Path(__file__).resolve().parents[2]
    for role, root in roots.items():
        absent_clear = restoring and not root.exists() and tree_kind(role, '') == 'clear'
        require((root.is_dir() or absent_clear) and not root.is_symlink() and root == root.resolve(), 'RESET_ROOT_UNSAFE')
        require(root != Path('/') and (role in selective or not root.is_relative_to(checkout) and not checkout.is_relative_to(root)),
                'RESET_SOURCE_TREE_PROTECTED')
        require(all(role in selective or other_role in selective or root == other or not root.is_relative_to(other)
                    for other_role, other in roots.items()), 'RESET_ROOT_OVERLAP')
    require(len(set(roots.values())) == len(roots), 'RESET_ROOT_ALIAS')
    for baseline in settings.get('baselines', []):
        path = Path(baseline).resolve(strict=True)
        require(all(role in selective or not path.is_relative_to(root) and not root.is_relative_to(path) for role, root in roots.items()),
                'RESET_BASELINE_OVERLAP')
    return roots
