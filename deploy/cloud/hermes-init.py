"""Compose the cloud product with owner transport, runtime state and deployment paths."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

import yaml
from dotenv import dotenv_values, unset_key

SECRETS = Path('/run/secrets')
ACCESS = Path('/run/workshop-access')
EXECUTOR_MODELS = Path('/etc/paios/executor-models.json')


# Imported homes retain runtime choices. Model transport belongs to the settings authority.
RUNTIME_KEYS = ('_config_version', 'command_allowlist', 'known_plugin_toolsets',
                'known_builtin_toolsets', 'tool_gateway_declined_tools', 'timezone')


def compose_config(product, existing):
    config = copy.deepcopy(product)
    config.setdefault('memory', {}).update(memory_enabled=False, user_profile_enabled=False)
    for field in RUNTIME_KEYS:
        if field in existing:
            config[field] = copy.deepcopy(existing[field])
    for section, names in {
        'approvals': ('timeout', 'smart_policy', 'denial_breaker_threshold', 'deny',
                      'mcp_reload_confirm', 'destructive_slash_confirm'),
        'monitoring': ('install_id',), 'security': ('acked_advisories',), 'onboarding': ('seen',),
    }.items():
        for field in names:
            if field in existing.get(section, {}):
                config.setdefault(section, {})[field] = copy.deepcopy(existing[section][field])
    return config


def transport(config, path):
    spec = importlib.util.spec_from_file_location('model_transport',
        Path(os.environ.get('PAIOS_APP_ROOT', Path(__file__).parents[2])) / 'integrations/hermes/personal_aios/model_transport.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.projected_config(config, path)


def seed_config(home, product_config):
    config_file = home / 'config.yaml'
    if config_file.exists() and config_file.stat().st_size:
        return
    home.mkdir(parents=True, exist_ok=True)
    config_file.write_bytes(product_config.read_bytes())
    config_file.chmod(0o600)


def bind_image_path(path, target):
    if path.is_symlink():
        if path.resolve() == target.resolve():
            return
        path.unlink()
    elif path.exists():
        backups = path.parent / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        path.rename(backups / f'{path.name}.cloud-import-{time.time_ns()}')
    path.symlink_to(target, target_is_directory=target.is_dir())


def agentbay_phone(home, integration, provider):
    if not ((SECRETS / 'agentbay.key').is_file() and (SECRETS / 'agentbay.key').read_text().strip()
            and os.environ.get('PAIOS_AGENTBAY_IMAGE')):
        return None
    executor = integration.parents[1] / 'connectors/phone_executor'
    return {'command': '/opt/paios-phone/bin/python',
        'args': [str(executor / 'server.py')], 'cwd': str(executor), 'env': {
            'PAIOS_PHONE_PROVIDER': provider, 'PAIOS_AGENTBAY_IMAGE': os.environ['PAIOS_AGENTBAY_IMAGE'],
            'PAIOS_AGENTBAY_KEY_FILE': str(SECRETS / 'agentbay.key'),
            'PAIOS_AGENTBAY_ADBKEY': str(SECRETS / 'agentbay.adbkey'),
            'PAIOS_DEEPSEEK_KEY_FILE': str(SECRETS / 'deepseek.key'),
            'PAIOS_SILICONFLOW_KEY_FILE': str(SECRETS / 'siliconflow.key'),
            'PAIOS_MOBILERUN_CONFIG': str(executor / 'mobilerun-config.example.yaml'),
            'PAIOS_AGENTBAY_STATE': str(home / 'agentbay-session.json'),
            'PAIOS_AGENTBAY_CONTEXT_PREFIX': os.environ.get('PAIOS_AGENTBAY_CONTEXT_PREFIX', 'paios-app-'),
            'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 660}


def mac_android_phone(home, integration, provider):
    executor = integration.parents[1] / 'connectors/phone_executor'
    return {'command': '/opt/paios-phone/bin/python',
        'args': [str(executor / 'server.py')], 'cwd': str(executor), 'env': {
            'PAIOS_PHONE_PROVIDER': provider,
            'PAIOS_INTEGRATION_PORT': os.environ['PAIOS_INTEGRATION_PORT'],
            'PAIOS_DEEPSEEK_KEY_FILE': str(SECRETS / 'deepseek.key'),
            'PAIOS_SILICONFLOW_KEY_FILE': str(SECRETS / 'siliconflow.key'),
            'PAIOS_MOBILERUN_CONFIG': str(executor / 'mobilerun-config.example.yaml'),
            'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 660}


PHONE_PROVIDERS = {'agentbay': agentbay_phone, 'mac-android': mac_android_phone,
                   'off': lambda home, integration, provider: None}


def payment_environment():
    return {'PAIOS_PAYMENT_URL': f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}",
            'PAIOS_PAYMENT_KEY_FILE': str(SECRETS / 'payment-executor.key')}


def phone_runtime(home, integration, provider, *, time_zone, packaged=True):
    """The existing provider and settings authorities own executor deployment values."""
    phone = PHONE_PROVIDERS[provider](home, integration, provider)
    if phone is None:
        return None
    phone['env'].update(payment_environment(), PAIOS_TIME_ZONE=time_zone)
    if packaged:
        phone['env']['PAIOS_INTEGRATION_PORT'] = os.environ['PAIOS_INTEGRATION_PORT']
    if os.environ.get('PAIOS_DEPLOYMENT') == 'single-host' and os.environ.get('PAIOS_STAGE') != 'staging':
        roles = json.loads(EXECUTOR_MODELS.read_text())
        for role in ('executor_fast', 'executor_thorough'):
            if role not in roles:
                raise ValueError('Phone requires ' + ', '.join(f'PAIOS_{role.upper()}_{field}' for field in ('MODEL', 'BASE_URL', 'API_KEY')))
        phone_config = yaml.safe_load((integration.parents[1] / 'connectors/phone_executor/mobilerun-config.example.yaml').read_text())
        phone_env = phone['env']
        for name, profile in phone_config['llm_profiles'].items():
            role = 'executor_thorough' if name == 'thorough' else 'executor_fast'
            route = roles[role]
            variable = f'PAIOS_{role.upper()}_KEY_FILE'
            profile.update(provider='OpenAILike', model=route['model'], base_url=route['base_url'],
                kwargs={'is_chat_model': True, 'is_function_calling_model': True, 'api_key_file_env': variable})
            phone_env[variable] = route['key_file']
        path = home / 'mobilerun-config.yaml'
        path.touch(mode=0o600, exist_ok=True)
        path.write_text(yaml.safe_dump(phone_config, sort_keys=False))
        path.chmod(0o600)
        os.chown(path, 10000, 10000)
        phone_env['PAIOS_MOBILERUN_CONFIG'] = str(path)
    return phone


def initialize(home, integration, product_config):
    single_host = os.environ.get('PAIOS_DEPLOYMENT') == 'single-host'
    # Authority bootstraps independently of the model and publishes both generations before inference starts.
    deadline = time.monotonic() + 90
    paths = [Path(os.environ[name]) for name in
             ('PAIOS_MODEL_SETTINGS_PROJECTION', 'PAIOS_MODEL_SETTINGS_BUILD_PROJECTION')]
    while not all(path.is_file() for path in paths):
        if time.monotonic() >= deadline:
            raise RuntimeError('Model settings authority did not publish startup projections')
        time.sleep(1)
    native = yaml.safe_load(product_config.read_text())
    config_file = home / 'config.yaml'
    original_config = config_file.read_bytes() if config_file.exists() else None
    config = compose_config(native, yaml.safe_load(original_config) if original_config else {})
    config = transport(config, os.environ['PAIOS_MODEL_SETTINGS_PROJECTION'])
    if os.environ.get('PAIOS_STAGE') != 'staging':
        # Upstream setup seeds this key even for fresh homes. Hermes dotenv
        # overrides the mounted key injected by hermes-start, breaking gateway auth.
        env_file = home / '.env'
        if env_file.exists():
            original = env_file.read_bytes()
            retained = b''.join(line for line in original.splitlines(keepends=True)
                if not re.match(rb'^[ \t]*(?:export[ \t]+)?API_SERVER_KEY[ \t]*=', line))
            if retained != original:
                env_file.write_bytes(retained)
    if os.environ.get('PAIOS_STAGE') == 'staging':
        backups = home / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        for name in ('.env', '.op.env'):
            path = home / name
            if path.exists() and path.stat().st_size:
                path.rename(backups / f'{name}.pre-staging-{time.time_ns()}')
        (home / '.env').write_text('')
        os.chmod(home / '.env', 0o600)
        os.chown(home / '.env', 10000, 10000)
        plugins = home / 'plugins'
        if plugins.exists():
            for path in plugins.iterdir():
                if path.name == 'personal_aios' and path.is_symlink() and path.resolve() == integration.resolve():
                    continue
                path.rename(backups / f'plugin-{path.name}.pre-staging-{time.time_ns()}')
    # Imported native launch flags must not bypass cloud consent or move file writes.
    policy = {'HERMES_YOLO_MODE', 'HERMES_WRITE_SAFE_ROOT'}
    for name in ('.env', '.op.env'):
        path = home / name
        if path.exists() and (flags := policy.intersection(dotenv_values(path, interpolate=False))):
            backups = home / 'backups'
            backups.mkdir(exist_ok=True)
            os.chown(backups, 10000, 10000)
            saved = backups / f'{name}.pre-workshop-{time.time_ns()}'
            path.rename(saved)
            path.write_bytes(saved.read_bytes())
            for key in flags:
                unset_key(path, key)
            path.chmod(0o600)
            os.chown(path, 10000, 10000)
    config.setdefault('personal_aios', {}).update(
        internal_base_url=f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}",
        internal_key_file='/run/secrets/hermes-internal.key')
    shared_skills = str(integration / 'shared-skills')
    product = json.loads(Path(os.environ['PAIOS_PRODUCT_CONFIG']).read_text())
    config['timezone'] = product['time_zone']
    spec = importlib.util.spec_from_file_location('capability_packages', integration.parents[2] / 'capability/packages/load.py')
    packages = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packages)
    provider = os.environ.get('PAIOS_PHONE_PROVIDER', 'off' if single_host else 'agentbay')
    phone = None if os.environ.get('PAIOS_STAGE') == 'staging' else phone_runtime(home, integration, provider,
        time_zone=product['time_zone'], packaged='phone' in product.get('capability_packages', {}).get('gateway', []))
    package_servers, package_skills, package_tools = packages.load_packages(integration.parents[2], product, home,
        staging=os.environ.get('PAIOS_STAGE') == 'staging', single_host=single_host, environ=os.environ,
        runtime_bindings={'phone': phone} if phone else {})
    config['personal_aios']['capability_tools'] = package_tools
    config['plugins'].setdefault('entries', {}).setdefault('yimi-gateway', {})['settings'] = {
        key: config['personal_aios'][key] for key in ('internal_base_url', 'internal_key_file', 'capability_tools')}
    selection = product.get('capability_packages', {})
    config['personal_aios']['capability_registry'] = 'yimi' in selection.get('enabled', []) and 'yimi' in selection.get('gateway', [])
    config['skills']['external_dirs'] = [str(integration / 'errands'), shared_skills, *package_skills]
    if single_host:
        disabled = set(config['skills'].get('disabled', []))
        if os.environ.get('PAIOS_ENABLE_WECHAT', '0') == '1':
            disabled.discard('wechat')
        else:
            disabled.add('wechat')
        config['skills']['disabled'] = sorted(disabled)
    config['terminal'] = {'backend': 'ssh', 'ssh_host': os.environ['PAIOS_WORKSHOP_HOST'],
        'ssh_user': 'root', 'ssh_port': 2222, 'ssh_key': str(home / 'workshop-ssh/owner_ed25519'),
        'cwd': '/workshop', 'ssh_isolated': True}
    authorized = []
    for name, command in [('id_ed25519', '/usr/local/bin/workshop-scope'),
                          ('owner_ed25519', '/usr/local/bin/workshop-scope --offline')]:
        key = home / 'workshop-ssh' / name
        key.parent.mkdir(mode=0o700, exist_ok=True)
        if not key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        for path in (key.parent, key, key.with_suffix('.pub')):
            os.chown(path, 10000, 10000)
        authorized.append(f'restrict,command="{command}" '.encode() + key.with_suffix('.pub').read_bytes())
    (ACCESS / 'authorized_keys').write_bytes(b''.join(authorized))
    os.chmod(ACCESS / 'authorized_keys', 0o644)
    spec = importlib.util.spec_from_file_location('paios_cron_policy', integration / 'cron.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    growth = policy.GROWTH_TOOLSETS
    # Replace imported Mac commands with image-owned MCP servers.
    config['mcp_servers'] = package_servers
    if os.environ.get('PAIOS_STAGE') == 'staging':
        if provider != 'off':
            legacy_fake = {'command': '/opt/hermes/.venv/bin/python',
                'args': [str(integration / 'staging/fake_phone.py')],
                'env': {'PAIOS_FAKE_PHONE_LOG': str(home / 'fake-phone.jsonl'),
                        'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 120}
            if 'phone' in package_servers:
                from capability.packages.phone.server.registration import select_transport
                legacy_fake['command'] = '/opt/paios-phone/bin/python'
                config['mcp_servers']['phone'] = select_transport(selection, legacy_fake, package_servers['phone'])
            else:
                config['mcp_servers']['phone'] = legacy_fake
        else:
            config['mcp_servers'].pop('phone', None)
        policy.isolate_staging_jobs(home)
        os.chown(home / '.paios-cloud-staging-v2', 10000, 10000)
        if (home / 'cron/jobs.json').exists():
            os.chown(home / 'cron/jobs.json', 10000, 10000)
        config['platform_toolsets']['api_server'] = list(policy.STAGING_API_TOOLSETS)
        config['platform_toolsets']['api_server_background'] = list(policy.staging_toolsets())
        config['platform_toolsets']['cron'] = list(policy.staging_toolsets())
        config.setdefault('agent', {})['disabled_toolsets'] = ['browser', 'computer_use', 'connections', 'homeassistant', 'discord', 'discord_admin', 'yuanbao', 'feishu_drive', 'spotify', 'tts', 'messaging']
    else:
        if phone is not None:
            from capability.packages.phone.server.registration import select_transport
            config['mcp_servers']['phone'] = select_transport(product.get('capability_packages', {}), phone,
                package_servers.get('phone', phone))
        else:
            config['mcp_servers'].pop('phone', None)
    desktop_enabled = json.loads(Path(os.environ['PAIOS_PRODUCT_CONFIG']).read_text()).get('desktop', {}).get('enabled') is True
    if single_host and os.environ.get('PAIOS_ENABLE_OWNER_MAC', '0') != '1':
        desktop_enabled = False
    if desktop_enabled:
        config['mcp_servers'].setdefault('desktop', {
            'url': f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}/internal/desktop/mcp",
            'headers': {'Authorization': 'Bearer ${PAIOS_HERMES_INTERNAL_KEY}'},
            'timeout': 330, 'connect_timeout': 10, 'trust': 'full'})
    if desktop_enabled:
        legacy_owner_mac = {
            'command': '/opt/hermes/.venv/bin/python', 'args': [str(integration / 'owner_mac.py')],
            'env': {'PAIOS_INTEGRATION_PORT': os.environ['PAIOS_INTEGRATION_PORT'],
                    'PAIOS_OWNER_MAC_FILES': str(home / 'cache/owner-mac')},
            'timeout': 330, 'trust': 'full'}
        if 'owner_mac' in config['mcp_servers']:
            config['mcp_servers']['owner_mac']['command'] = legacy_owner_mac['command']
            config['mcp_servers']['owner_mac']['env'].update(legacy_owner_mac['env'])
            config['mcp_servers']['owner_mac'].update(timeout=330, trust='full')
        else:
            config['mcp_servers']['owner_mac'] = legacy_owner_mac
        config.setdefault('computer_use', {}).update(backend='cua', no_overlay=False)
        if 'disabled_toolsets' in config['agent']:
            config['agent']['disabled_toolsets'] = [name for name in config['agent']['disabled_toolsets'] if name != 'computer_use']
        for platform in ('api_server', 'api_server_background'):
            config['platform_toolsets'][platform] = [*config['platform_toolsets'][platform], 'owner_mac']
    else:
        for name in ('desktop', 'owner_mac'):
            config['mcp_servers'].pop(name, None)
    config['mcp_servers']['self'] = {
        'url': f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}/internal/self/mcp",
        'headers': {'Authorization': 'Bearer ${PAIOS_HERMES_INTERNAL_KEY}'},
        'timeout': 15, 'connect_timeout': 10, 'trust': 'full'}
    if single_host:
        unavailable = {name for name in ('phone', 'mijia', 'owner_mac') if name not in config['mcp_servers']}
        if config['auxiliary']['vision'].get('enabled') is False:
            unavailable.add('vision')
        for platform, tools in config['platform_toolsets'].items():
            config['platform_toolsets'][platform] = [name for name in tools if name not in unavailable]
    grantable = ['desktop', 'terminal', 'file']
    config['personal_aios']['grantable_toolsets'] = grantable
    for platform, tools in config['platform_toolsets'].items():
        config['platform_toolsets'][platform] = [name for name in tools if name not in grantable]
    if 'disabled_toolsets' in config['agent']:
        config['agent']['disabled_toolsets'] = [name for name in config['agent']['disabled_toolsets'] if name not in grantable]
    # Tool visibility is not authorization: children inherit the admitted scope and grants.
    conversation = ['memory', 'session_search', 'skills', 'delegation', 'kanban']
    execution = set(grantable) | set(config['mcp_servers']) | {'skills_hub', 'code_execution', 'effects'}
    if desktop_enabled:
        execution.add('computer_use')
    for platform in ('api_server', 'api_server_background', 'cron'):
        execution.update(config['platform_toolsets'].get(platform, []))
        config['platform_toolsets'][platform] = list(conversation)
    config['personal_aios']['delegated_toolsets'] = sorted(execution)
    if 'phone' in config['mcp_servers']:
        config['mcp_servers']['phone']['env'].update(payment_environment())
    for server in config['mcp_servers'].values():
        server.setdefault('tools', {}).update(resources=False, prompts=False)
    # A native profile is the data boundary: only model transport and build machinery cross.
    build_home = home / 'workshop'
    build_home.mkdir(mode=0o700, exist_ok=True)
    build = {field: copy.deepcopy(config[field]) for field in
        ('network', 'terminal', 'security', 'approvals') if field in config}
    build['terminal']['ssh_key'] = str(home / 'workshop-ssh/id_ed25519')
    build['agent'] = {key: native['agent'][key] for key in ('max_tool_calls', 'tool_call_milestone_interval')}
    build = transport(build, os.environ['PAIOS_MODEL_SETTINGS_BUILD_PROJECTION'])
    build['timezone'] = product['time_zone']
    build['plugins'] = {'enabled': ['personal_aios'], 'entries': {'personal_aios': {'allow_tool_override': True}}}
    build['personal_aios'] = {key: config['personal_aios'][key] for key in ('internal_base_url', 'internal_key_file', 'capability_registry')}
    build['personal_aios']['grantable_toolsets'] = []
    if os.environ.get('PAIOS_BUILDER_URL'):
        build['personal_aios'].update(builder_url=os.environ['PAIOS_BUILDER_URL'],
            builder_token_file=os.environ.get('PAIOS_BUILDER_TOKEN_FILE', '/run/secrets/workshop-builder.key'),
            builder_ca_file=os.environ.get('PAIOS_BUILDER_CA_FILE', '/run/secrets/workshop-builder.crt'))
        # Remote builder requests own their HTTP deadlines; keep waiting for their bounded result.
        build['timeouts'] = {'tools': {'sequential_call': 0, 'concurrent_batch': 0}}
        # Remote development leaves this profile as discovery and release control.
        growth = [tool for tool in growth if tool not in {'terminal', 'file', 'code_execution'}]
    build.update(memory={'provider': 'personal_aios', 'memory_enabled': False, 'user_profile_enabled': False},
        skills={'external_dirs': [shared_skills], 'inline_shell': False, 'create_dir': '', 'guard_agent_created': True},
        tools={'tool_search': {'enabled': 'off'}}, platform_toolsets={'api_server_build': growth},
        sync={'enabled': False})
    (build_home / 'config.yaml').write_text(yaml.safe_dump(build, allow_unicode=True, sort_keys=False))
    (build_home / 'plugins').mkdir(exist_ok=True)
    bind_image_path(build_home / 'plugins/personal_aios', integration)
    for path in (build_home, build_home / 'config.yaml', build_home / 'plugins'):
        os.chown(path, 10000, 10000)
    # Always use the persona shipped with the plugin, including imported regular
    # SOUL files. Preserve owner files before rebinding, without overwriting backups.
    (home / 'plugins').mkdir(parents=True, exist_ok=True)
    bind_image_path(home / 'plugins/personal_aios', integration)
    bind_image_path(home / 'plugins/yimi_gateway', integration.parent / 'yimi_gateway')
    bind_image_path(home / 'SOUL.md', integration / 'persona/yimi.md')
    rendered = yaml.safe_dump(config, allow_unicode=True, sort_keys=False).encode()
    if original_config is not None and original_config != rendered:
        backups = home / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        saved = backups / f'config.yaml.pre-cloud-{time.time_ns()}'
        saved.touch(mode=0o600)
        saved.write_bytes(original_config)
        os.chown(saved, 10000, 10000)
    config_file.write_bytes(rendered)
    # The upstream s6 hook initializes permissions before this hook.
    for path in [home / 'plugins', config_file]:
        os.chown(path, 10000, 10000)
    # Native config imports in this root hook also write last-good backups.
    backups = home / 'backups/config'
    backups.mkdir(parents=True, exist_ok=True)
    for path in [backups.parent, backups, *backups.iterdir()]:
        os.chown(path, 10000, 10000)


if __name__ == '__main__':
    home = Path(os.environ['HERMES_HOME'])
    product_config = Path('/opt/paios/hermes-product-config.yaml')
    if sys.argv[1:] == ['--seed-only']:
        seed_config(home, product_config)
    elif not sys.argv[1:]:
        initialize(home, Path('/opt/paios/integrations/hermes/personal_aios'), product_config)
    else:
        raise ValueError('Usage: hermes-init.py [--seed-only]')
