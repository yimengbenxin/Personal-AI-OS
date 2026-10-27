#!/usr/bin/env python3
"""Materialize the locked producer from an explicit source and guard config."""
import os
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo
import subprocess
import sys
from ipaddress import IPv6Address
from urllib.parse import urlsplit

from staging_config import render as render_staging

root = Path(__file__).resolve().parents[2]
cloud = root / 'deploy/cloud'
build = cloud / '.build'
build.mkdir(exist_ok=True)
def exact_origin(value, scheme='https'):
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    authority = f'[{IPv6Address(host).compressed}]' if ':' in host else host
    if (len(value) > 253 or parsed.scheme != scheme or not host or parsed.port == 443
            or not re.fullmatch(r'[a-z0-9.:-]+', host)
            or value != f'{scheme}://{authority}' + (f':{parsed.port}' if parsed.port is not None else '')):
        raise ValueError('Public endpoints must be exact HTTPS/WSS origins')
    return parsed

# Validate the same bounded origin configuration before producing gateway or workshop output.
canonical_origin = os.environ.get('PAIOS_PUBLIC_API_URL') or f"https://{os.environ['PAIOS_PUBLIC_HOST']}:{os.environ.get('PAIOS_TLS_PORT', '9443')}"
canonical = exact_origin(canonical_origin)
if not re.fullmatch(r'[a-z0-9.-]+', canonical.hostname):
    raise ValueError('The direct front requires a DNS hostname')
legacy_csv = os.environ.get('PAIOS_LEGACY_PUBLIC_API_URLS', '')
legacy = legacy_csv.split(',') if legacy_csv else []
if len(legacy_csv) > 2048 or len(legacy) > 8 or len(set([canonical_origin] + legacy)) != len(legacy) + 1:
    raise ValueError('Invalid legacy public origin list')
public_livekit = os.environ.get('PAIOS_LIVEKIT_URL') or 'wss://' + canonical.netloc
deny_hosts = list(dict.fromkeys(endpoint.hostname for endpoint in
    [canonical] + [exact_origin(origin) for origin in legacy] + [exact_origin(public_livekit, 'wss')]))
stage_host = os.environ.get('PAIOS_STAGING_PUBLIC_HOST') or canonical.hostname
stage_origin = exact_origin(f"https://{stage_host}:{os.environ.get('PAIOS_STAGING_TLS_PORT', '19443')}")
if not re.fullmatch(r'[a-z0-9.-]+', stage_origin.hostname):
    raise ValueError('The staging front requires a DNS hostname')
stage_authority = stage_origin.netloc
deny_hosts = list(dict.fromkeys(deny_hosts + [stage_host]))
# Optional external avatar must be absent, not an empty URL.
production = json.loads((cloud / 'cloud.json').read_text())
# Freeze the deployer's IANA zone before configuration enters a UTC container.
zone = os.environ.get('PAIOS_TIME_ZONE') or production.get('time_zone')
if not zone:
    zone = os.environ.get('TZ')
if not zone:
    localtime = Path('/etc/localtime').resolve().as_posix()
    zone = localtime.split('/zoneinfo/', 1)[1] if '/zoneinfo/' in localtime else Path('/etc/timezone').read_text().strip()
ZoneInfo(zone)
production['time_zone'] = zone
(build / 'paios-staging-snapshot.timer').write_text((cloud / 'paios-staging-snapshot.timer').read_text().replace('@PAIOS_TIME_ZONE@', zone))
if 'model_settings' in production and os.environ.get('PAIOS_BUILDER_URL'):
    production['model_settings'].update(build_profile='builder', build_activation_url=os.environ['PAIOS_BUILDER_URL'],
        build_ca_file='${PAIOS_SECRET_ROOT}/workshop-builder.crt')
production['product_resources'].update(public_api_url=canonical_origin, legacy_public_api_urls=legacy_csv,
    livekit_url=public_livekit,
    livekit_api_url=os.environ.get('PAIOS_LIVEKIT_API_URL') or f"http://127.0.0.1:{os.environ.get('PAIOS_LIVEKIT_SIGNAL_PORT', '7880')}")
if not os.environ.get('PAIOS_AVATAR_URL'):
    production['product_resources'].pop('avatar_url', None)
if os.environ.get('PAIOS_DEPLOYMENT') == 'single-host':
    from single_host_models import configured_roles, snapshot
    roles = configured_roles()
    (build / 'model-settings-import.json').write_text(json.dumps(snapshot(roles), indent=2) + '\n')
    (build / 'executor-models.json').write_text(json.dumps({name: role for name, role in roles.items()
                                                        if name.startswith('executor_')}, indent=2) + '\n')
    for key in ('voiceprint', 'visual'):
        production.pop(key, None)
    if 'realtime' not in roles:
        for key in ('pcm', 'tts', 'formal_voice', 'voice_frontend'):
            production.pop(key, None)
    else:
        production['voice_frontend'].update(model=roles['realtime']['model'], endpoint=roles['realtime']['base_url'],
            key_file=roles['realtime']['key_file'], voice=os.environ['PAIOS_REALTIME_VOICE'])
        production['voice_frontend']['call'].update(model=roles['realtime']['model'], voice=os.environ['PAIOS_REALTIME_VOICE'])
        production['voice_frontend']['call'].pop('turn_manager', None)
        production.pop('tts', None)
        production.pop('formal_voice', None)
    production['desktop']['enabled'] = os.environ.get('PAIOS_ENABLE_OWNER_MAC', '0') == '1'
    if 'tts' in roles:
        if 'realtime' not in roles:
            raise ValueError('PAIOS_TTS_MODEL requires PAIOS_REALTIME_MODEL')
        production['tts'] = dict(provider='dashscope', model=roles['tts']['model'],
            voice=os.environ['PAIOS_TTS_VOICE'], endpoint=roles['tts']['base_url'], sample_rate=22050,
            key_file=roles['tts']['key_file'])
        production['formal_voice'] = {'transport': 'wav_byte_stream_v1'}
    if os.environ.get('PAIOS_ENABLE_AMAP', '0') != '1':
        production['product_resources'].pop('amap_key_file', None)
    if os.environ.get('PAIOS_ENABLE_COLD_STORAGE', '0') != '1':
        production.pop('archive_tiering', None)
    if os.environ.get('PAIOS_ENABLE_AVATAR', '0') != '1':
        for key in ('avatar_url', 'video_call', 'vidu_cleanup_key_file'):
            production['product_resources'].pop(key, None)
(build / 'production.json').write_text(json.dumps(production, ensure_ascii=False, indent=2) + '\n')
# Staging differs only at named external-effect/state boundaries.
staging = render_staging(production, stage_authority,
    f"http://127.0.0.1:{os.environ.get('PAIOS_LIVEKIT_SIGNAL_PORT', '7880')}", os.environ.get('PAIOS_STAGING_BUILDER_URL'))
(build / 'staging.json').write_text(json.dumps(staging, ensure_ascii=False, indent=2) + '\n')
public_environment = {name: production['product_resources'][key] for name, key in
    [('PAIOS_PUBLIC_API_URL', 'public_api_url'), ('PAIOS_LEGACY_PUBLIC_API_URLS', 'legacy_public_api_urls'),
     ('PAIOS_LIVEKIT_URL', 'livekit_url'), ('PAIOS_LIVEKIT_API_URL', 'livekit_api_url')]}
public_environment.update(PAIOS_PUBLIC_HOST=canonical.hostname, PAIOS_WORKSHOP_DENY_HOSTS=','.join(deny_hosts),
    PAIOS_STAGING_PUBLIC_API_URL='https://' + stage_authority, PAIOS_STAGING_LIVEKIT_URL='wss://' + stage_authority)
(build / 'production.public.env').write_text(''.join(f'{name}={value}\n' for name, value in public_environment.items()))
def replace_required(text, old, new, count=-1):
    if old not in text or (count == 1 and text.count(old) != 1):
        raise ValueError(f'Build template replacement did not match: {old!r}')
    return text.replace(old, new, count)

if sys.argv[1:] not in ([], ['--config-only']):
    raise ValueError('Usage: prepare-build.py [--config-only]')
if '--config-only' not in sys.argv:
    # The native producer is content-addressed by its locked result tree and shared by every release that pins it,
    # so its bytes (including .git) stay identical between builds and the locked base image reuses its build cache.
    tree = json.loads((root / 'integrations/hermes/personal_aios/producer.lock.json').read_text())['result_tree']
    native = Path(os.environ.get('PAIOS_HERMES_NATIVE_ROOT', '/srv/paios/hermes-native')) / tree
    if not native.exists():
        partial = native.with_name(tree + '.partial')
        subprocess.run(['rm', '-rf', str(partial)], check=True)
        partial.parent.mkdir(parents=True, exist_ok=True)
        command = ['node', str(root / 'integrations/hermes/verify-producer.mjs'), '--keep', str(partial)]
        if os.environ.get('HERMES_SOURCE'):
            command += ['--source', os.environ['HERMES_SOURCE']]
        subprocess.run(command, check=True)
        partial.rename(native)
    # Without optional locks, the check never refreshes .git/index, which would change the build context.
    subprocess.run(['node', str(root / 'integrations/hermes/verify-producer.mjs'), '--check-running', str(native)], check=True,
                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    hermes = build / 'hermes'
    if hermes.is_symlink():
        hermes.unlink()
    hermes.symlink_to(native)
    # Keep tracked source unchanged. Dockerfile-specific ignore restores complete
    # tracked files and .git so the in-image producer verifier sees the exact tree.
    dockerfile = build / 'hermes-base.Dockerfile'
    text = (hermes / 'Dockerfile').read_text()
    # Upstream chmods a tracked 0644 dispatcher. Execute its unchanged bytes
    # outside the locked tree so producer verification still covers file modes.
    text = replace_required(text, 'COPY --chmod=0755 docker/entrypoint-dispatch.sh /opt/hermes/docker/entrypoint-dispatch.sh',
                            'COPY --chmod=0755 docker/entrypoint-dispatch.sh /usr/local/bin/hermes-entrypoint', 1)
    text = replace_required(text, 'ENTRYPOINT [ "/opt/hermes/docker/entrypoint-dispatch.sh" ]',
                            'ENTRYPOINT [ "/usr/local/bin/hermes-entrypoint" ]', 1)
    # PM owns its pinned tool store and dependency lock; configure transport without rewriting them.
    apt_arg = 'ARG PAIOS_BUILD_MAINLAND_MIRRORS=0\nRUN if [ "$PAIOS_BUILD_MAINLAND_MIRRORS" = "1" ]; then sed -i "s|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g" /etc/apt/sources.list.d/debian.sources; fi\n'
    stages = re.findall(r'^FROM debian:[^\n]+\n', text, re.M)
    if len(stages) != 2:
        raise ValueError('Expected the locked upstream SQLite and runtime Debian stages')
    for stage in stages:
        text = replace_required(text, stage, stage + apt_arg, 1)
    npm_export = 'if [ "$PAIOS_BUILD_MAINLAND_MIRRORS" = "1" ]; then export npm_config_registry=https://registry.npmmirror.com; fi && '
    text = replace_required(text, 'RUN node scripts/build/node-deps.mjs', 'RUN ' + npm_export + 'node scripts/build/node-deps.mjs', 1)
    text = replace_required(text, 'RUN cd plugins/platforms/photon/sidecar', 'RUN ' + npm_export + 'cd plugins/platforms/photon/sidecar', 1)
    text = replace_required(text, 'RUN python3 -m pm.build_env', 'RUN if [ "$PAIOS_BUILD_MAINLAND_MIRRORS" = "1" ]; then export UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple; fi && python3 -m pm.build_env', 1)
    dockerfile.write_text(text)
    (dockerfile.with_name(dockerfile.name + '.dockerignore')).write_text('node_modules\n**/node_modules\n.venv\n**/.venv\n**/__pycache__\n**/.env\n**/.env.*\n!**/.env.example\n')
# Both ingress paths share one closed route/header template. The loopback path
# preserves the remote edge attestation; it must never mint local trust for it.
def render_front(host, authority, aliases):
    front = (cloud / 'front.conf.in').read_text()
    if os.environ.get('PAIOS_DEPLOYMENT') == 'single-host' and re.fullmatch(r'[0-9.]+', host):
        front = front.replace('map $ssl_server_name $paios_roaming_sni_exact {',
                              'map $ssl_server_name $paios_roaming_sni_exact {\n    "" 1;')
    for key, value in {
        '@PUBLIC_HOST_REGEX@': host.replace('.', '[.]'), '@PUBLIC_HOST@': host,
        '@PUBLIC_AUTHORITY@': authority,
        '@GATEWAY_UPSTREAM@': f"127.0.0.1:{os.environ.get('PAIOS_GATEWAY_PORT', '8787')}",
        '@LIVEKIT_UPSTREAM@': f"127.0.0.1:{os.environ.get('PAIOS_LIVEKIT_SIGNAL_PORT', '7880')}"
    }.items():
        front = replace_required(front, key, value)
    prefix, server = front.split('server {', 1)
    direct = server
    for key, value in {
        '@LISTEN@': 'listen 443 ssl http2;\n    listen [::]:443 ssl http2;',
        '@SNI_GUARD@': 'if ($paios_roaming_sni_exact != 1) { return 444; }',
        '@TLS@': 'ssl_certificate /etc/paios-tls/fullchain.pem;\n    ssl_certificate_key /etc/paios-tls/privkey.pem;\n    ssl_verify_client off;\n    ssl_protocols TLSv1.2 TLSv1.3;',
        '@ATTESTATION@': 'include /run/secrets/nginx-attestation.conf;',
    }.items():
        direct = replace_required(direct, key, value)
    gateway_proxy = f"proxy_pass http://127.0.0.1:{os.environ.get('PAIOS_GATEWAY_PORT', '8787')};"
    direct = replace_required(direct, gateway_proxy, 'js_access paios_roaming_guard.enforce;\n        ' + gateway_proxy)
    front = prefix + 'server {' + direct
    if aliases:
        loopback = direct.replace('listen 443 ssl http2;\n    listen [::]:443 ssl http2;', 'listen 127.0.0.1:8788;')
        start = loopback.index('    ssl_certificate ')
        end = loopback.index('    server_tokens ', start)
        loopback = loopback[:start] + loopback[end:]
        loopback = replace_required(loopback, 'if ($paios_roaming_sni_exact != 1) { return 444; }', '')
        loopback = replace_required(loopback, f'server_name {host};', 'server_name ' + ' '.join(urlsplit(origin).hostname for origin in aliases) + ';')
        loopback = replace_required(loopback, f'proxy_set_header Host {authority};', 'proxy_set_header Host $http_host;')
        loopback = replace_required(loopback, f'proxy_set_header X-Forwarded-Host {authority};', 'proxy_set_header X-Forwarded-Host $http_host;')
        loopback = replace_required(loopback, 'include /run/secrets/nginx-attestation.conf;', 'proxy_set_header X-PAIOS-Proxy-Attestation $http_x_paios_proxy_attestation;')
        loopback = replace_required(loopback, 'X-Forwarded-For $remote_addr;', 'X-Forwarded-For $http_x_forwarded_for;')
        loopback = replace_required(loopback, 'X-PAIOS-Trusted-Source-Family $paios_roaming_source_family;', 'X-PAIOS-Trusted-Source-Family $http_x_paios_trusted_source_family;')
        loopback = replace_required(loopback, 'js_access paios_roaming_guard.enforce;', 'js_access paios_roaming_guard.enforceLegacy;')
        front += '\n# Authenticated loopback forwarding for configured legacy origins.\nserver {' + loopback
    guard = replace_required((cloud / 'paios_roaming_guard.js.in').read_text(), '@PUBLIC_AUTHORITY@', authority)
    guard = replace_required(guard, '@LEGACY_AUTHORITIES@', json.dumps([urlsplit(origin).netloc for origin in aliases]))
    return front, guard

for suffix, host, authority in [('', canonical.hostname, canonical.netloc),
                                 ('-staging', stage_host, stage_authority)]:
    front, guard = render_front(host, authority, legacy if not suffix else [])
    (build / f'front{suffix}.conf').write_text(front)
    (build / f'paios_roaming_guard{suffix}.js').write_text(guard)
# These mounts contain paths/config only; gateway UID 10000 must read root-prepared files.
for name in ('production.json', 'staging.json', 'front.conf', 'front-staging.conf',
             'paios_roaming_guard.js', 'paios_roaming_guard-staging.js'):
    (build / name).chmod(0o644)
print('Prepared owner-domain runtime config' + (' and locked Hermes build context' if '--config-only' not in sys.argv else ''))
