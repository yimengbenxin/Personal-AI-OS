"""Opt-in native brain probe driven by the real HTTP platform fixture in capability_wiring_model.ts."""
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from capability_model import configure, brain

request = json.loads(Path(sys.argv[1]).read_text())
ROOT, HOME, OUT = (Path(request[key]) for key in ('root', 'home', 'out'))
OUT.mkdir(parents=True, exist_ok=True)
config = configure(HOME, request['model_key_file'])
os.environ['PAIOS_CAPABILITY_TEST_KEY_FILE'] = request['model_key_file']
os.environ['PAIOS_HERMES_SOURCE'] = os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT']
os.environ['PYTHONPATH'] = str(ROOT) + ':' + os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT']
from hermes_constants import set_hermes_home_override
set_hermes_home_override(HOME)
from integrations.hermes.personal_aios import capability_runtime, packaged_messaging, workshop
from integrations.hermes.personal_aios.workshop_capability import registry_client
from capability.packages.load import load_packages
from tools.registry import registry

key = 'synthetic-native-token-abcdefghijklmnop'
sent = []


class NativeHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer ' + key:
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        try:
            result = capability_runtime.operation(self.path.rsplit('/', 1)[1], body)
            payload, status = json.dumps(result).encode(), 200
        except Exception as error:
            payload, status = json.dumps({'error': type(error).__name__ + ':' + str(error)}).encode(), 500
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(payload)


native = ThreadingHTTPServer(('127.0.0.1', 0), NativeHandler)
threading.Thread(target=native.serve_forever, daemon=True).start()
os.environ.update(API_SERVER_PORT=str(native.server_port), API_SERVER_KEY=key,
                  PAIOS_HERMES_INTERNAL_KEY=request['internal_token'])
spec = importlib.util.spec_from_file_location('wiring_contract_driver', ROOT /
    '01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class WorkshopHandler(NativeHandler):
    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer synthetic-workshop-token':
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        try:
            if self.path == '/capability-build':
                prior = OUT / 'model-package.json'
                if os.environ.get('PAIOS_MODEL_RESUME_PACKAGE') == '1' and prior.exists() and not body.get('files'):
                    body['files'] = json.loads(prior.read_text())['files']
                    body['input'] += '\n这是你本次任务刚写好的草稿。读取并重跑已有 scripts/test.py，通过后返回候选；保留已验证的业务语义，无需重写。'
                path = OUT / 'build-request.json'
                path.write_text(json.dumps(body))
                output = OUT / 'model-package.json'
                log = OUT / 'builder.log'
                with log.open('w') as stream:
                    completed = subprocess.run([sys.executable, str(ROOT / 'tests/hermes/capability_wiring_builder.py'),
                        str(ROOT), str(HOME / 'isolated-builder'), str(path), str(output)],
                        stdout=stream, stderr=stream, timeout=900)
                if completed.returncode:
                    raise RuntimeError('builder_failed_see_builder_log')
                result = json.loads(output.read_text())
            else:
                import tempfile
                with tempfile.TemporaryDirectory(dir=HOME) as directory:
                    package = Path(directory)
                    files = body['files'] if self.path == '/capability-invoke' else body
                    for name, content in files.items():
                        path = package / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(content)
                    if self.path == '/capability-check':
                        result = driver.check(package, None)
                    elif self.path == '/capability-invoke':
                        result = driver.invoke(package, body['call'], None)
                    else:
                        raise ValueError('unknown_fixture_route')
            payload, status = json.dumps(result).encode(), 200
        except Exception as error:
            payload, status = json.dumps({'error': type(error).__name__ + ':' + str(error)}).encode(), 500
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(payload)


cert, private = HOME / 'fixture-ca.pem', HOME / 'fixture-tls.pem'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', str(private), '-out', str(cert), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(HOME / 'workshop-token').write_text('synthetic-workshop-token')
builder = ThreadingHTTPServer(('127.0.0.1', 0), WorkshopHandler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(cert, private)
builder.socket = tls.wrap_socket(builder.socket, server_side=True)
threading.Thread(target=builder.serve_forever, daemon=True).start()
service = {**request['config'], 'builder_url': 'https://127.0.0.1:' + str(builder.server_port),
    'builder_ca_file': str(cert), 'builder_token_file': str(HOME / 'workshop-token')}
families = request['families']
servers, skills, tools = load_packages(ROOT, {'capability_packages': {'enabled': families, 'gateway': families}}, HOME,
    staging=True, environ={'PAIOS_INTEGRATION_PORT': request['integration_port']})
for name, server in servers.items():
    if 'command' in server and Path(server['command']).name.startswith('python'):
        server['command'] = sys.executable
    server.setdefault('env', {}).update(PYTHONPATH=os.environ['PYTHONPATH'], PAIOS_HERMES_SOURCE=os.environ['PAIOS_HERMES_SOURCE'])
    server['lazy'] = False
    server['trust'] = 'full'
servers['phone']['command'] = '/opt/paios-runner/toolchains/executor-venv/bin/python'
# Keep the real shared messaging implementation; replace only its final native sender.
servers['yimi_shared']['args'] = ['-m', 'capability.hosts.python',
    'messaging=capability.packages.messaging.server.server', 'registry=capability.hosts.registry']
servers['yimi_shared']['env'].update(API_SERVER_PORT=str(native.server_port), API_SERVER_KEY=key)
cashier = {'success': True, 'answer': '已到假收银台，合成订单金额16.60元，尚未付款。',
    'observed_values': [{'key': '订单金额', 'value': '16.60', 'unit': 'CNY', 'provenance': 'observed', 'source': 'fake_cashier'}],
    'effect_evidence': [{'kind': 'physical', 'action': '准备订单', 'verification': 'verified',
                         'evidence': '假收银台回读同一订单，未付款', 'ref': 'fake:cashier'}]}
(HOME / 'cashier.json').write_text(json.dumps(cashier, ensure_ascii=False))
(HOME / 'errands').mkdir()
servers['phone']['env'].update(PAIOS_PHONE_FAKE_RESULT=str(HOME / 'cashier.json'),
    PAIOS_ERRAND_SPOOL=str(HOME / 'errands'), HERMES_INTERNAL_BASE=request['config']['internal_base_url'],
    HERMES_INTERNAL_KEY_FILE=request['config']['internal_key_file'])
service['capability_tools'] = tools
service['capability_registry'] = True
config.update(plugins={'enabled': ['yimi-gateway'], 'entries': {'yimi-gateway': {'settings': service}}}, personal_aios=service, mcp_servers=servers,
    platform_toolsets={'api_server': ['mcp-phone', 'mcp-yimi_shared', 'mcp-platform_ts', 'mcp-owner_mac', 'skills_hub']})
import yaml
(HOME / 'config.yaml').write_text(yaml.safe_dump(config, allow_unicode=True))
(HOME / 'workshop').mkdir()
(HOME / 'workshop/config.yaml').write_text(yaml.safe_dump(config, allow_unicode=True))
(HOME / 'plugins').mkdir()
(HOME / 'plugins/yimi_gateway').symlink_to(ROOT / 'integrations/hermes/yimi_gateway', target_is_directory=True)
from hermes_cli.plugins import get_plugin_manager
get_plugin_manager().discover_and_load()


class Context:
    def register_tool(self, name, toolset, schema, handler, **kwargs):
        registry.register(name=name, toolset=toolset, schema=schema, handler=handler, override=True)

    def register_hook(self, *args):
        pass  # yimi-gateway supplies the pre/post hooks; this native alias is execution-only here.


class Provider:
    def _request(self, path, body, **kwargs):
        wire = Request(service['internal_base_url'] + path, json.dumps(body).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + request['internal_token']})
        with urlopen(wire, timeout=900) as response:
            return json.load(response)


provider = Provider()
workshop.register(Context(), provider, registry_factory=lambda kwargs: registry_client(provider, kwargs))
import tools.send_message_tool as native_messaging


def sender(args):
    sent.append(args)
    (OUT / 'message-executions.json').write_text(json.dumps(sent, ensure_ascii=False, indent=2))
    return json.dumps({'success': True, 'message_id': 'synthetic-' + str(len(sent))})


native_messaging.send_message_tool = sender
packaged_messaging.register(Context())
from tools.mcp_tool_discovery import discover_mcp_tools, _get_connected_server_for_call
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
discover_mcp_tools()
from gateway.session_context import set_session_vars, clear_session_vars, bind_api_run_conversation, reset_api_run_conversation
from gateway.run_scope import restrict_agent, runtime_scope
from tools import approval_context


def send_result(value):
    print('N13:' + json.dumps(value, ensure_ascii=False), flush=True)


send_result({'ready': True, 'native_port': native.server_port, 'native_token': key})
try:
    for line in sys.stdin:
        turn = json.loads(line)
        if turn.get('action') == 'close':
            break
        session, run = turn['session'], turn['run']
        tokens = set_session_vars(platform='api_server', session_id=session, session_key=run)
        policy = bind_api_run_conversation(run, session)
        approval = approval_context.set_current_session_key(run)
        agent = brain(config, tools=turn['tools'], session=session, max_tokens=None)
        restrict_agent(agent, turn.get('scope', 'owner'))
        try:
            with runtime_scope(turn.get('scope', 'owner')):
                result = agent.run_conversation(turn['input'], system_message=turn['system'])
            messages = result.get('messages') or []
            answers = {m.get('tool_call_id'): m.get('content') for m in messages if m.get('role') == 'tool'}
            calls = [{'tool': call['function']['name'], 'args': json.loads(call['function']['arguments'] or '{}'),
                      'result': answers.get(call['id'])}
                     for message in messages if message.get('role') == 'assistant' for call in message.get('tool_calls') or []]
            host = _get_connected_server_for_call('yimi_shared')
            send_result({'name': turn['name'], 'calls': calls, 'final': result.get('final_response'),
                'failed': result.get('failed'), 'host_connection': id(host), 'dynamic': [tool.name for tool in host._tools
                if (tool.meta or {}).get('yimi.version')] if host else [], 'sent': len(sent)})
            (OUT / (turn['name'] + '-transcript.json')).write_text(json.dumps(result, ensure_ascii=False, default=str, indent=2))
        except Exception as error:
            send_result({'name': turn['name'], 'error': type(error).__name__ + ':' + str(error)})
        finally:
            agent.close()
            reset_api_run_conversation(policy)
            approval_context.reset_current_session_key(approval)
            clear_session_vars(tokens)
finally:
    shutdown_mcp_servers()
    native.shutdown()
    builder.shutdown()
