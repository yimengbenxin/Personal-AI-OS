"""Project the single package selection into native transports, skills and tool identities."""
import copy
import json
from pathlib import Path
from string import Template

import jsonschema


def transport(directory, definition, home, environ):
    from hermes_cli.agent_plugins import _translate_stdio, _translate_remote
    value = copy.deepcopy(definition)
    extra = {key: value.pop(key) for key in ('timeout', 'connect_timeout', 'trust') if key in value}
    value.setdefault('type', 'stdio' if 'command' in value else 'streamable-http')
    command = value.get('command', '')
    if value['type'] == 'stdio':
        value['command'] = Path(command).name
        result = _translate_stdio(value, directory, home / 'capability/data' / directory.name, False)
        if result['args'] and result['args'][0].endswith('.py') and not Path(result['args'][0]).is_absolute():
            result['args'][0] = str(directory / result['args'][0])
        if command.startswith('/'):
            result['command'] = command
    else:
        result = _translate_remote(value)
        result['url'] = Template(result['url']).safe_substitute(environ)
        if 'PAIOS_INTEGRATION_PORT' in environ:
            from urllib.parse import urlsplit, urlunsplit
            url = urlsplit(result['url'])
            result['url'] = urlunsplit(url._replace(netloc='127.0.0.1:' + environ['PAIOS_INTEGRATION_PORT']))
        result['headers'] = {key: Template(val).safe_substitute({
                                 'HERMES_INTERNAL_KEY': '${PAIOS_HERMES_INTERNAL_KEY}',
                                 'PAIOS_HERMES_INTERNAL_KEY': '${PAIOS_HERMES_INTERNAL_KEY}'})
                             for key, val in result.get('headers', {}).items()}
    result.update(extra)
    result.setdefault('env', {}).update(HERMES_HOME=str(home), PYTHONPATH=str(directory.parents[2]) + ':/opt/hermes')
    return result


def bind_runtime(definition, binding, secret_names=(), environ=None):
    """The host supplies deployment paths; packages name the secret files they consume."""
    result = copy.deepcopy(definition)
    values = {**(environ or {}), **binding.get('env', {})}
    result.update({key: binding[key] for key in ('command', 'cwd', 'timeout', 'connect_timeout') if key in binding})
    result['env'] = {key: (Template(value).substitute(values) if binding else Template(value).safe_substitute(values))
                     for key, value in {**binding.get('env', {}), **result.get('env', {})}.items()}
    for name in secret_names:
        if name in values:
            result['env'][name] = str(Path(values[name]).expanduser())
    return result


def load_packages(root, product, home, *, staging=False, single_host=False, environ=None, runtime_bindings=None):
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    environ = dict(environ or {})
    servers, skills, tools, shared = {}, [], [], []
    selection = product.get('capability_packages', {})
    for name in selection.get('enabled', []):
        if name == 'yimi':
            if name in selection.get('gateway', []):
                shared.append('registry=capability.hosts.registry')
            continue
        directory = root / 'capability/packages' / name
        if directory.resolve().parent != (root / 'capability/packages').resolve():
            raise ValueError('capability_package_path_invalid')
        manifest = json.loads((directory / 'plugin.json').read_text())
        extension = manifest['extensions']['ai.yimi.capability']
        jsonschema.validate(manifest, json.loads((root / 'capability/contracts/upstream/plugin-1.0.0.schema.json').read_text()))
        jsonschema.validate(extension, json.loads((root / 'capability/contracts/manifest.v1.schema.json').read_text()))
        flag = selection.get('single_host_flags', {}).get(name)
        if single_host and flag and environ.get(flag) != '1':
            continue
        gateway = name in selection.get('gateway', [])
        if not gateway and name != 'mijia':
            continue
        server = extension['runtime']['server']
        definition = json.loads((directory / 'mcp.json').read_text())['mcpServers'][server]
        if staging and server != 'platform_ts':
            definition = {**{key: definition[key] for key in ('timeout',) if key in definition},
                          **extension['staging']['fake'], 'type': 'stdio'}
            if Path(definition['command']).name.startswith('python'):
                definition['command'] = '/opt/hermes/.venv/bin/python'
        definition = transport(directory, definition, home, environ)
        if not staging:
            definition = bind_runtime(definition, (runtime_bindings or {}).get(server, {}),
                                      [secret['name'] for secret in extension['secrets']], environ)
        definition.update({key: extension['runtime'][key] for key in ('lazy', 'idle_timeout_seconds')})
        if staging:
            definition['env']['PAIOS_FAKE_' + server.upper() + '_LOG'] = str(home / ('fake-' + server + '.jsonl'))
        if definition.get('args', [])[:2] == ['-m', 'capability.hosts.python']:
            shared.extend(server + '=' + module for module in definition['args'][2:])
        elif server in servers:
            if servers[server] != definition:
                raise ValueError('capability_server_conflict')
        else:
            servers[server] = definition
        skills.append(str(directory / 'skills'))
        if gateway:
            tools.extend('mcp__' + server + '__' + tool for tool in extension['tools'])
            if definition.get('args', [])[:2] == ['-m', 'capability.hosts.python']:
                tools.extend(mcp_prefixed_tool_name('yimi_shared', server + '__' + tool) for tool in extension['tools'])
            else:
                tools.extend(mcp_prefixed_tool_name(server, tool) for tool in extension['tools']
                             if mcp_prefixed_tool_name(server, tool) != 'mcp__' + server + '__' + tool)
            if server in ('messaging', 'platform_ts'):
                tools.extend(extension['tools'])
    if shared:
        servers['yimi_shared'] = {'command': '/opt/hermes/.venv/bin/python',
            'args': ['-m', 'capability.hosts.python', *shared], 'cwd': str(root),
            'env': {'HERMES_HOME': str(home), 'PYTHONPATH': str(root) + ':/opt/hermes'},
            'lazy': True, 'idle_timeout_seconds': 900}
    return servers, skills, tools
