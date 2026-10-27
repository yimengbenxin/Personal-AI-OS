"""Fake-key real SDK retries and streaming reach the native attempt observer."""
import asyncio
import importlib.util
import json
import re
import os
import subprocess
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from openai import OpenAI, AsyncOpenAI, APIStatusError

ROOT = Path(__file__).parents[2]
NATIVE = Path(os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT'])
spec = importlib.util.spec_from_file_location('model_usage', ROOT / 'integrations/hermes/personal_aios/model_usage.py')
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


def configure(tmp_path, monkeypatch):
    path = tmp_path / 'projection.json'
    path.write_text(json.dumps({'environment_id': 'staging', 'profile': 'owner', 'revision': 4, 'group': 'brain',
        'config': {'providers': {'fake-primary': {'api': 'https://primary.invalid/v1'},
                                 'fake-fallback': {'api': 'https://fallback.invalid/v1'}}}}))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', str(path))
    monkeypatch.setattr(usage, '_projection', lambda: json.loads(path.read_text()))
    monkeypatch.setattr(usage, '_context', lambda: {'run_id': 'native-run', 'session_id': 'admitted-session',
        'request_id': 'logical-request', 'role': 'brain'})
    from types import SimpleNamespace
    monkeypatch.setattr(usage, 'journal_context', SimpleNamespace(get=lambda: lambda fact: None))
    facts = []
    monkeypatch.setattr(usage, 'publish', facts.append)
    return facts


RECORDED_USAGE = json.loads((ROOT / 'tests/hermes/fixtures/model-usage-responses.json').read_text())['cases']


@pytest.mark.parametrize('case', RECORDED_USAGE, ids=lambda case: case['id'])
@pytest.mark.parametrize('async_mode', [False, True])
def test_raw_usage_protocol_priority(tmp_path, monkeypatch, case, async_mode):
    facts = configure(tmp_path, monkeypatch)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=case['response']))
    url = 'https://primary.invalid/v1/' + case['route']
    if async_mode:
        async def run():
            async with usage.instrument(httpx.AsyncClient(transport=transport)) as client:
                assert (await client.post(url, json={'model': 'fake-model'})).json() == case['response']
        asyncio.run(run())
    else:
        with usage.instrument(httpx.Client(transport=transport)) as client:
            assert client.post(url, json={'model': 'fake-model'}).json() == case['response']
    assert len(facts) == 1 and facts[0]['status'] == 'completed'
    assert facts[0]['original_usage'] == case['expected_usage']


def test_messages_partial_usage_keeps_earlier_counters_without_summing(tmp_path, monkeypatch):
    facts = configure(tmp_path, monkeypatch)
    start = {'type': 'message_start', 'message': {'usage': {
        'input_tokens': 100, 'output_tokens': 1, 'cache_read_input_tokens': 12, 'cache_creation_input_tokens': 5}}}
    delta = {'type': 'message_delta', 'usage': {'output_tokens': 20}}
    body = b''.join(b'data: ' + json.dumps(event).encode() + b'\n\n' for event in (start, start, delta, {'type': 'message_stop'}))
    with usage.instrument(httpx.Client(transport=httpx.MockTransport(lambda request:
            httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})))) as client:
        client.post('https://primary.invalid/v1/messages', json={'model': 'fake-model'})
    assert facts[0]['original_usage'] == {'input_tokens': 100, 'output_tokens': 20,
        'cache_read_input_tokens': 12, 'cache_creation_input_tokens': 5}


@pytest.fixture
def provider():
    """Real HTTP content decoding and incremental SSE, without a paid provider."""
    servers = []

    def serve(encoding, parts, status=200, content_type='text/event-stream', flush_parts=True):
        if encoding == 'gzip':
            compressor = zlib.compressobj(wbits=31)
            chunks = [compressor.compress(part) + compressor.flush(zlib.Z_SYNC_FLUSH) for part in parts]
            chunks.append(compressor.flush())
        elif encoding == 'br':
            try:
                import brotli
            except ImportError:
                import brotlicffi as brotli
            compressor = brotli.Compressor()
            chunks = ([compressor.process(part) + compressor.flush() for part in parts] + [compressor.finish()]
                if flush_parts else [brotli.compress(b''.join(parts))])
        else:
            chunks = parts
        requests = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_POST(self):
                requests.append({'headers': dict(self.headers),
                    'body': json.loads(self.rfile.read(int(self.headers['Content-Length'])))})
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Encoding', encoding)
                self.send_header('Transfer-Encoding', 'chunked')
                self.send_header('Connection', 'close')
                self.end_headers()
                try:
                    for chunk in chunks:
                        if chunk:
                            self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                            self.wfile.flush()
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # The SDK closes as soon as it sees [DONE].

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return f'http://127.0.0.1:{server.server_port}/v1', requests

    yield serve
    for server, thread in servers:
        server.shutdown()
        server.server_close()
        thread.join()


def local_client(tmp_path, monkeypatch, endpoint, async_mode):
    facts = configure(tmp_path, monkeypatch)
    projection = Path(os.environ['PAIOS_MODEL_SETTINGS_PROJECTION'])
    value = json.loads(projection.read_text())
    value['config']['providers'] = {'fake-primary': {'api': endpoint}}
    projection.write_text(json.dumps(value))
    client_type = httpx.AsyncClient if async_mode else httpx.Client
    sdk_type = AsyncOpenAI if async_mode else OpenAI
    return facts, sdk_type(base_url=endpoint, api_key='fake-key', max_retries=0,
        http_client=usage.instrument(client_type(trust_env=False)))


def test_production_row_with_brotli_sdk_completion(tmp_path, monkeypatch, provider):
    event = b'data: ' + json.dumps({'id': 'production-repro', 'choices': [], 'usage': {
        'prompt_tokens': 29960, 'completion_tokens': 210,
        'prompt_tokens_details': {'cached_tokens': 8704}}}).encode() + b'\n\n: 1\n\ndata: [DONE]\n\n'
    endpoint, _ = provider('br', [event], flush_parts=False)
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, False)
    with sdk:
        with sdk.chat.completions.create(model='fake-model', messages=[{'role': 'user', 'content': 'test'}], stream=True) as stream:
            chunks = list(stream)
    assert chunks[0].usage.prompt_tokens == 29960
    assert len(facts) == 1
    assert {key: facts[0][key] for key in ('status', 'input_tokens', 'output_tokens', 'original_usage')} == {
        'status': 'completed', 'input_tokens': 29960, 'output_tokens': 210,
        'original_usage': {'prompt_tokens': 29960, 'completion_tokens': 210, 'cached_tokens': 8704}}


@pytest.mark.parametrize('encoding', ['br', 'gzip', 'identity'])
@pytest.mark.parametrize('async_mode', [False, True])
def test_compressed_sdk_stream_observes_decoded_usage_before_done(tmp_path, monkeypatch, provider, encoding, async_mode):
    provider_usage = {'prompt_tokens': 29960, 'completion_tokens': 210,
        'prompt_tokens_details': {'cached_tokens': 8704}}
    event = b'data: ' + json.dumps({'id': 'production-repro', 'choices': [], 'usage': provider_usage}).encode() + b'\n\n'
    endpoint, requests = provider(encoding, [event[:45], event[45:], b'data: [DO', b'NE]\n\n', b': trailer\n\n'])
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, async_mode)
    args = dict(model='fake-model', messages=[{'role': 'user', 'content': 'test'}], stream=True,
        stream_options={'include_usage': True})
    if async_mode:
        async def run():
            async with sdk:
                async with await sdk.chat.completions.create(**args) as stream:
                    return [chunk async for chunk in stream]
        chunks = asyncio.run(run())
    else:
        with sdk:
            with sdk.chat.completions.create(**args) as stream:
                chunks = list(stream)
    assert chunks[0].usage.prompt_tokens == 29960, 'The SDK really completed and decoded usage'
    assert len(facts) == 1
    assert {key: facts[0][key] for key in ('status', 'input_tokens', 'output_tokens', 'original_usage')} == {
        'status': 'completed', 'input_tokens': 29960, 'output_tokens': 210,
        'original_usage': {'prompt_tokens': 29960, 'completion_tokens': 210, 'cached_tokens': 8704}}
    assert 'br' in requests[0]['headers']['Accept-Encoding']
    assert requests[0]['body']['stream_options'] == {'include_usage': True}


@pytest.mark.parametrize('encoding', ['br', 'gzip', 'identity'])
@pytest.mark.parametrize('async_mode', [False, True])
def test_compressed_sdk_early_close_preserves_seen_usage(tmp_path, monkeypatch, provider, encoding, async_mode):
    event = b'data: {"id":"partial","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n'
    endpoint, _ = provider(encoding, [event, b'data: [DONE]\n\n'])
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, async_mode)
    args = dict(model='fake-model', messages=[{'role': 'user', 'content': 'test'}], stream=True)
    if async_mode:
        async def run():
            async with sdk:
                async with await sdk.chat.completions.create(**args) as stream:
                    assert (await stream.__anext__()).usage.prompt_tokens == 7
        asyncio.run(run())
    else:
        with sdk:
            with sdk.chat.completions.create(**args) as stream:
                assert next(stream).usage.prompt_tokens == 7
    assert len(facts) == 1
    assert facts[0]['status'] == 'cancelled'
    assert (facts[0]['input_tokens'], facts[0]['output_tokens']) == (7, 2)


@pytest.mark.parametrize('encoding', ['br', 'gzip', 'identity'])
@pytest.mark.parametrize('async_mode', [False, True])
@pytest.mark.parametrize('status', [200, 429])
def test_compressed_nonstreaming_and_http_error(tmp_path, monkeypatch, provider, encoding, async_mode, status):
    body = {'id': 'json', 'choices': [], 'usage': {'prompt_tokens': 11, 'completion_tokens': 3}} if status == 200 else {'error': {'message': 'rate limited'}}
    endpoint, _ = provider(encoding, [json.dumps(body, indent=2).encode()], status, 'application/json')
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, async_mode)
    args = dict(model='fake-model', messages=[{'role': 'user', 'content': 'test'}])
    if async_mode:
        async def run():
            async with sdk:
                if status == 200:
                    assert (await sdk.chat.completions.create(**args)).usage.prompt_tokens == 11
                else:
                    with pytest.raises(APIStatusError):
                        await sdk.chat.completions.create(**args)
        asyncio.run(run())
    else:
        with sdk:
            if status == 200:
                assert sdk.chat.completions.create(**args).usage.prompt_tokens == 11
            else:
                with pytest.raises(APIStatusError):
                    sdk.chat.completions.create(**args)
    assert len(facts) == 1
    assert facts[0]['status'] == ('completed' if status == 200 else 'failed')
    assert facts[0]['input_tokens'] == (11 if status == 200 else None)


@pytest.mark.parametrize('route,event', [('responses', {'type': 'response.completed', 'response': {
    'usage': {'input_tokens': 11, 'output_tokens': 3}}}),
    ('messages', {'type': 'message_stop', 'usage': {'input_tokens': 11, 'output_tokens': 3}})])
@pytest.mark.parametrize('async_mode', [False, True])
def test_terminal_event_close_is_completed(tmp_path, monkeypatch, provider, route, event, async_mode):
    endpoint, _ = provider('br', [b'data: ' + json.dumps(event).encode() + b'\n\n', b': trailer\n\n'])
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, async_mode)
    client = sdk._client
    if async_mode:
        async def run():
            async with sdk:
                async with client.stream('POST', endpoint + '/' + route, json={'model': 'fake-model'}) as response:
                    line = await response.aiter_lines().__anext__()
                    assert json.loads(line[5:]) == event
        asyncio.run(run())
    else:
        with sdk:
            with client.stream('POST', endpoint + '/' + route, json={'model': 'fake-model'}) as response:
                assert json.loads(next(response.iter_lines())[5:]) == event
    assert len(facts) == 1
    assert (facts[0]['status'], facts[0]['input_tokens'], facts[0]['output_tokens']) == ('completed', 11, 3)


@pytest.mark.parametrize('async_mode', [False, True])
def test_streamed_json_read_reaches_eof_before_recording(tmp_path, monkeypatch, provider, async_mode):
    body = json.dumps({'id': 'json', 'choices': [], 'usage': {'prompt_tokens': 11, 'completion_tokens': 3}}, indent=2).encode()
    endpoint, _ = provider('gzip', [body[:30], body[30:]], content_type='application/json')
    facts, sdk = local_client(tmp_path, monkeypatch, endpoint, async_mode)
    args = dict(model='fake-model', messages=[{'role': 'user', 'content': 'test'}])
    if async_mode:
        async def run():
            async with sdk:
                async with sdk.chat.completions.with_streaming_response.create(**args) as response:
                    assert (await response.parse()).usage.prompt_tokens == 11
        asyncio.run(run())
    else:
        with sdk:
            with sdk.chat.completions.with_streaming_response.create(**args) as response:
                assert response.parse().usage.prompt_tokens == 11
    assert len(facts) == 1
    assert (facts[0]['status'], facts[0]['input_tokens'], facts[0]['output_tokens']) == ('completed', 11, 3)


@pytest.mark.parametrize('async_mode', [False, True])
def test_close_during_blocked_read_is_cancelled(tmp_path, monkeypatch, async_mode):
    facts = configure(tmp_path, monkeypatch)
    entered, released, finished = threading.Event(), threading.Event(), threading.Event()

    class BlockedStream(httpx.SyncByteStream, httpx.AsyncByteStream):
        def __iter__(self):
            entered.set()
            released.wait(5)
            yield from ()

        def close(self):
            released.set()
            assert finished.wait(2)

        async def __aiter__(self):
            entered.set()
            await asyncio.to_thread(released.wait, 5)
            for chunk in ():
                yield chunk

        async def aclose(self):
            released.set()
            assert await asyncio.to_thread(finished.wait, 2)

    client_type = httpx.AsyncClient if async_mode else httpx.Client
    sdk_type = AsyncOpenAI if async_mode else OpenAI
    client = usage.instrument(client_type(transport=httpx.MockTransport(lambda request:
        httpx.Response(200, stream=BlockedStream(), headers={'content-type': 'text/event-stream'}))))
    sdk = sdk_type(base_url='https://primary.invalid/v1', api_key='fake-key', http_client=client)
    args = dict(model='fake-model', messages=[{'role': 'user', 'content': 'test'}], stream=True)
    if async_mode:
        async def run():
            async with sdk:
                stream = await sdk.chat.completions.create(**args)
                async def read():
                    try:
                        return [chunk async for chunk in stream]
                    finally:
                        finished.set()
                reader = asyncio.create_task(read())
                try:
                    assert await asyncio.to_thread(entered.wait, 2)
                    await stream.close()
                finally:
                    released.set()
                    await reader
        asyncio.run(run())
    else:
        with sdk:
            stream = sdk.chat.completions.create(**args)
            def read():
                try:
                    list(stream)
                finally:
                    finished.set()
            reader = threading.Thread(target=read)
            reader.start()
            try:
                assert entered.wait(2)
                stream.close()
            finally:
                released.set()
                reader.join(5)
    assert len(facts) == 1
    assert facts[0]['status'] == 'cancelled'


def test_actual_sdk_retry_and_fallback_are_separate_attempts(tmp_path, monkeypatch):
    facts = configure(tmp_path, monkeypatch)
    sends = []

    def handle(request):
        sends.append(str(request.url))
        if len(sends) == 1:
            return httpx.Response(503, json={'error': {'message': 'provider unavailable'}})
        return httpx.Response(200, json={'id': 'fake', 'object': 'chat.completion', 'created': 1,
            'model': 'fake-model', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 11, 'completion_tokens': 3, 'total_tokens': 14}})

    client = usage.instrument(httpx.Client(transport=httpx.MockTransport(handle)))
    with OpenAI(base_url='https://primary.invalid/v1', api_key='fake-key-never-publish', http_client=client, max_retries=1) as sdk:
        sdk.chat.completions.create(model='fake-model', messages=[{'role': 'user', 'content': 'test'}])
        sdk.base_url = 'https://fallback.invalid/v1/'
        sdk.chat.completions.create(model='fake-model', messages=[{'role': 'user', 'content': 'test'}])
    assert len(facts) == 3
    assert len({fact['attempt_id'] for fact in facts}) == 3
    assert {fact['request_id'] for fact in facts} == {'logical-request'}
    assert [fact['status'] for fact in facts] == ['failed', 'completed', 'completed']
    assert [fact['provider_id'] for fact in facts] == ['fake-primary', 'fake-primary', 'fake-fallback']
    assert facts[0]['input_tokens'] is None
    assert facts[0]['fallback_reason'] == 'provider_error'
    assert facts[1]['input_tokens'] == 11
    assert facts[1]['original_usage']['completion_tokens'] == 3
    assert all(fact['cost']['kind'] == 'unknown' for fact in facts)
    assert all(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', fact['captured_at']) for fact in facts)
    assert 'fake-key-never-publish' not in json.dumps(facts)
    assert 'provider unavailable' not in json.dumps(facts)


def test_stream_usage_records_final_usage_and_async_source(tmp_path, monkeypatch):
    facts = configure(tmp_path, monkeypatch)
    data = b'data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n'

    async def run():
        client = usage.instrument(httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=data, headers={'content-type': 'text/event-stream'}))))
        async with client:
            async with client.stream('POST', 'https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'}) as response:
                assert b''.join([part async for part in response.aiter_bytes()]) == data

    asyncio.run(run())
    assert len(facts) == 1
    assert facts[0]['status'] == 'completed'
    assert facts[0]['input_tokens'] == 7
    assert facts[0]['output_tokens'] == 2


def test_sdk_stream_done_is_completed_even_when_sdk_stops_before_transport_exhaustion(tmp_path, monkeypatch):
    facts = configure(tmp_path, monkeypatch)
    data = b'data: {"id":"fake","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    client = usage.instrument(httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, stream=httpx.ByteStream(data), headers={'content-type': 'text/event-stream'}))))
    with OpenAI(base_url='https://primary.invalid/v1', api_key='fake-key', http_client=client) as sdk:
        with sdk.chat.completions.create(model='fake-model', messages=[{'role': 'user', 'content': 'test'}], stream=True) as stream:
            list(stream)
    assert facts[0]['status'] == 'completed'
    assert facts[0]['output_tokens'] == 2


def test_native_delegate_refuses_new_child_before_credentials_or_construction(tmp_path):
    code = '''
import json
from types import SimpleNamespace
from agent import model_usage
from tools import delegate_tool
receipt={'allowed':False,'status':'paused','settings_entry':'模型与密钥'}
model_usage.new_task_admission=lambda role: receipt
def forbidden(*args,**kwargs):raise AssertionError('child construction reached')
delegate_tool._resolve_delegation_credentials=forbidden
delegate_tool._build_child_agent=forbidden
assert json.loads(delegate_tool.delegate_task(goal='new paid child',parent_agent=SimpleNamespace()))==receipt
'''
    result = subprocess.run([sys.executable, '-c', code], env={**os.environ, 'PYTHONPATH': str(NATIVE),
        'HERMES_HOME': str(tmp_path), 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_duplicate_provider_urls_require_the_selected_native_identity(tmp_path, monkeypatch):
    facts = configure(tmp_path, monkeypatch)
    projection = Path(os.environ['PAIOS_MODEL_SETTINGS_PROJECTION'])
    value = json.loads(projection.read_text())
    value['config']['providers']['same-endpoint'] = {'api': 'https://primary.invalid/v1'}
    projection.write_text(json.dumps(value))
    client = usage.instrument(httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'usage': {}}))))
    import pytest
    with pytest.raises(ValueError, match='PROVIDER_BINDING_REQUIRED'):
        client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
    original = usage._context
    monkeypatch.setattr(usage, '_context', lambda: {**original(), '_provider': 'same-endpoint'})
    client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
    assert facts[0]['provider_id'] == 'same-endpoint'
    client.close()


def test_active_native_generation_is_used_before_bootstrap_pointer_publication(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(NATIVE))
    import yaml
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    home = tmp_path / 'active'
    home.mkdir()
    old, applied = tmp_path / 'current.json', home / 'immutable-revision.json'
    old.write_text('{"revision":6}')
    applied.write_text('{"revision":7,"group":"build","profile":"builder"}')
    (home / 'config.yaml').write_text(yaml.safe_dump({'secrets': {'personal_aios': {'projection': str(applied)}}}))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', str(old))
    token = set_hermes_home_override(home)
    try:
        assert usage._projection() == {'revision': 7, 'group': 'build', 'profile': 'builder'}
    finally:
        reset_hermes_home_override(token)


def test_build_preflight_refusal_and_remote_context_preserve_the_admitted_source(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    monkeypatch.syspath_prepend(str(NATIVE))
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes/personal_aios'))
    monkeypatch.setitem(sys.modules, 'model_usage', usage)
    admission_spec = importlib.util.spec_from_file_location('model_task_admission', ROOT / 'integrations/hermes/personal_aios/model_task_admission.py')
    admission = importlib.util.module_from_spec(admission_spec)
    admission_spec.loader.exec_module(admission)
    monkeypatch.setitem(sys.modules, 'model_task_admission', admission)
    key = tmp_path / 'service-token'
    key.write_text('fake-service-source-only-token')
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_TOKEN_FILE', str(key))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_SERVICE_URL', 'http://127.0.0.1:1')
    class Reply:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, limit): return b'{"allowed":false,"status":"paused","settings_entry":"models"}'
    def request_admission(request, timeout):
        assert request.full_url == 'http://127.0.0.1:1/internal/model-settings/admission'
        assert json.loads(request.data) == {'run_id': 'native-run', 'session_id': 'admitted-session',
            'environment': 'staging', 'profile': 'owner', 'role': 'delegation'}
        return Reply()
    monkeypatch.setattr(admission, 'urlopen', request_admission)
    assert admission.preflight('delegation')['status'] == 'paused'
    monkeypatch.setattr(admission, 'preflight', lambda role: {'allowed': False, 'status': 'paused', 'settings_entry': '模型与密钥'})
    builder_spec = importlib.util.spec_from_file_location('workshop_builder', ROOT / 'integrations/hermes/personal_aios/workshop_builder.py')
    builder = importlib.util.module_from_spec(builder_spec)
    builder_spec.loader.exec_module(builder)
    import pytest
    with pytest.raises(ValueError, match='paused'):
        builder.build_tool({})
    with pytest.raises(ValueError, match='paused'):
        builder.repair_product({})
    from gateway.session_context import current_api_run_conversation
    body = {'input': 'data-free', '_model_context': {'run_id': 'parent-run', 'session_id': 'canonical-session'}}
    with admission.remote_context(body):
        assert current_api_run_conversation() == ('parent-run', 'canonical-session')
        assert '_model_context' not in body
    assert current_api_run_conversation() is None


def test_auxiliary_rpc_binds_existing_execution_and_journals_before_http_failure(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from urllib.error import URLError
    from aiohttp import web
    from gateway.session_context import current_api_run_conversation
    from agent.model_usage import journal_context
    spec = importlib.util.spec_from_file_location('usage_bound_rpc', ROOT / 'integrations/hermes/personal_aios/run_api.py')
    rpc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rpc)
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', 'enabled')
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_SERVICE_URL', 'http://integration.invalid')
    key = tmp_path / 'service-token'
    key.write_text('fake-service-token-only')
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_TOKEN_FILE', str(key))
    monkeypatch.setattr(usage, '_projection', lambda: {'environment_id': 'staging', 'profile': 'owner',
        'revision': 4, 'group': 'brain', 'config': {'providers': {'fake-primary': {'api': 'https://primary.invalid/v1'}}}})
    failures = []
    def down(request, timeout):
        failures.append(request)
        raise URLError('offline fixture')
    monkeypatch.setattr(usage, 'urlopen', down)
    source = {'conversation_session_id': 'source-session', 'activity_events': []}
    server = SimpleNamespace(_run_statuses={'source-run': source}, _run_idempotency_ids=set(), _run_streams={})
    async def run():
        for role in ('call.intent', 'auxiliary.vision'):
            with rpc.auxiliary_execution(server, {'_model_context': {'run_id': 'source-run', 'session_id': 'source-session'}}, role):
                assert current_api_run_conversation()[:2] == ('source-run', 'source-session')
                assert usage._context()['request_id'] == usage._context()['request_id']
                transport = usage.instrument(httpx.AsyncClient(transport=httpx.MockTransport(lambda request:
                    httpx.Response(200, json={'model': 'fake-model', 'usage': {'prompt_tokens': 9, 'completion_tokens': 2}}))))
                async with transport:
                    async with transport.stream('POST', 'https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'}) as response:
                        await response.aread()
    asyncio.run(run())
    facts = [json.loads(event['text']) for event in source['activity_events']]
    assert [fact['role'] for fact in facts] == ['call.intent', 'auxiliary.vision']
    assert all(fact['run_id'] == 'source-run' and fact['session_id'] == 'source-session' for fact in facts)
    assert len(failures) == 2
    assert current_api_run_conversation() is None and journal_context.get() is None
    import pytest
    for context, error in (({}, web.HTTPBadRequest), ({'run_id': 'source-run', 'session_id': 'other-owner'}, web.HTTPForbidden)):
        with pytest.raises(error):
            with rpc.auxiliary_execution(server, {'_model_context': context}, 'call.intent'):
                raise AssertionError('unbound request reached paid inference')


def test_auxiliary_without_native_run_keeps_existing_front_inference_supported(monkeypatch):
    from types import SimpleNamespace
    from agent.model_usage import usage_context, journal_context
    spec = importlib.util.spec_from_file_location('usage_nonrun_rpc', ROOT / 'integrations/hermes/personal_aios/run_api.py')
    rpc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rpc)
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', 'enabled')
    with rpc.auxiliary_execution(SimpleNamespace(), {'text': 'current turn'}, 'call.intent'):
        assert usage_context.get()[0] == 'call.intent'
        assert journal_context.get() is None
    assert journal_context.get() is None
    from agent.model_usage import source_context
    proof = {'kind': 'capture', 'raw_ref': 'l5:exact-source', 'archive_revision': 'exact-revision',
             'principal_id': 'owner', 'device_id': 'camera'}
    with rpc.auxiliary_execution(SimpleNamespace(), {'source_context': proof}, 'auxiliary.vision'):
        assert source_context.get() == proof
        assert usage._context()['source_context'] == proof
    assert source_context.get() is None


def test_nonrun_source_started_is_durable_before_wire_and_completion_reuses_uuid(tmp_path, monkeypatch):
    import pytest
    import io
    from contextlib import nullcontext
    from urllib.error import HTTPError, URLError
    from types import SimpleNamespace
    facts = configure(tmp_path, monkeypatch)
    origin = {'kind': 'capture', 'raw_ref': 'l5:exact-frame', 'archive_revision': 'exact-revision',
              'principal_id': 'fixture-owner', 'device_id': 'fixture-camera'}
    monkeypatch.setattr(usage, '_context', lambda: {'run_id': '', 'session_id': origin['raw_ref'],
        'request_id': 'caption-request', 'role': 'auxiliary.vision', 'source_context': origin})
    # Restore the real request publisher; configure intentionally captures terminal-only fixtures.
    spec = importlib.util.spec_from_file_location('source_attempt_publisher', ROOT / 'integrations/hermes/personal_aios/model_usage.py')
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    monkeypatch.setattr(usage, 'publish', real.publish)
    token = tmp_path / 'service-token'
    token.write_text('fake-service-token')
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_TOKEN_FILE', str(token))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_SERVICE_URL', 'http://integration.invalid')
    wire = []
    reject = False
    def receive(request, timeout):
        fact = json.loads(request.data)
        if reject:
            raise reject if isinstance(reject, Exception) else URLError('fixture-start-unavailable')
        facts.append(fact)
        return nullcontext(SimpleNamespace(read=lambda limit: b'{}'))
    monkeypatch.setattr(real, 'urlopen', receive)
    def infer(request):
        assert facts[-1]['phase'] == 'started'
        wire.append(request)
        return httpx.Response(200, json={'usage': {'prompt_tokens': 4, 'completion_tokens': 1}})
    with usage.instrument(httpx.Client(transport=httpx.MockTransport(infer))) as client:
        client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
        assert [fact['phase'] for fact in facts] == ['started', 'terminal']
        assert facts[0]['attempt_id'] == facts[1]['attempt_id']
        assert facts[0]['input_tokens'] is None and facts[1]['input_tokens'] == 4
        assert facts[0]['source_context'] == origin
        reject = True
        with pytest.raises(RuntimeError, match='MODEL_USAGE_START_UNAVAILABLE'):
            client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
        reject = HTTPError('http://integration.invalid', 403, 'Forbidden', {},
                           io.BytesIO(b'{"error":{"code":"MODEL_USAGE_SOURCE_MISMATCH"}}'))
        with pytest.raises(RuntimeError, match='MODEL_USAGE_START_UNAVAILABLE 403 .*MODEL_USAGE_SOURCE_MISMATCH'):
            client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
        from agent import model_usage as native_usage
        monkeypatch.setattr(usage, 'journal_context', native_usage.journal_context)
        monkeypatch.setattr(usage, '_context', lambda: {'run_id': '', 'session_id': '', 'request_id': 'unbound', 'role': 'brain'})
        with pytest.raises(RuntimeError, match='MODEL_USAGE_SOURCE_REQUIRED_RESCHEDULE'):
            client.post('https://primary.invalid/v1/chat/completions', json={'model': 'fake-model'})
    assert len(wire) == 1


def test_paid_cron_keeps_creator_execution_and_refuses_unknown_or_paused_source(tmp_path, monkeypatch):
    import pytest
    from contextlib import nullcontext
    from cron import jobs, scheduler
    from agent import model_usage as native_usage
    from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation
    saved = []
    monkeypatch.setattr(jobs, '_jobs_lock', nullcontext)
    monkeypatch.setattr(jobs, 'load_jobs', lambda: [])
    monkeypatch.setattr(jobs, 'save_jobs', saved.extend)
    source = {'kind': 'run', 'run_id': 'exact-parent-run', 'session_id': 'exact-parent-session',
              'principal_id': 'exact-owner', 'processed_event_id': 'exact-original-event'}
    origin = native_usage.origin_context.set(source)
    token = bind_api_run_conversation('exact-parent-run', 'exact-parent-session')
    try:
        job = jobs.create_job('fixture paid cron', 'every 1h')
    finally:
        reset_api_run_conversation(token)
        native_usage.origin_context.reset(origin)
    assert saved[0]['model_usage_source'] == source
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', 'enabled')
    monkeypatch.setattr(scheduler, '_resolve_job_workdir', lambda job, job_id: None)
    calls = []
    monkeypatch.setattr(native_usage, 'new_task_admission', lambda role: calls.append((role, native_usage.source_context.get())) or {'status': 'paused'})
    scope = scheduler._CronRunScope(job, job['id'], 'new-execution')
    try:
        with pytest.raises(RuntimeError, match='paused'):
            scope.enter()
        assert native_usage.source_context.get() is None
    finally:
        scope.exit()
    assert calls == [('cron', source)] and native_usage.source_context.get() is None
    legacy = scheduler._CronRunScope({'id': 'legacy-unbound'}, 'legacy-unbound', 'new-execution')
    try:
        with pytest.raises(RuntimeError, match='MODEL_USAGE_SOURCE_REQUIRED_RESCHEDULE'):
            legacy.enter()
    finally:
        legacy.exit()


@pytest.mark.parametrize('task', ['vision', 'compression'])
@pytest.mark.parametrize('fallback,streaming', [(False, False), (True, False), (False, True)])
def test_native_named_auxiliary_route_and_fallback_keep_declared_identity(tmp_path, monkeypatch, task, fallback, streaming):
    import yaml
    from agent import auxiliary_client
    from agent.model_usage import journal_context
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.env_loader import install_profile_secret_source_values
    primary, alternate = 'named-' + task, 'named-fallback-' + task
    endpoint = f'https://{task}-{int(fallback)}-shared-native-fixture.invalid/v1'
    fallback_endpoint = f'https://{task}-{int(fallback)}-fallback-native-fixture.invalid/v1'
    route = {'provider': primary, 'model': 'primary-model', 'base_url': endpoint,
        'key_env': 'PRIMARY_FIXTURE_KEY', 'api_mode': 'chat_completions', 'role_id': 'auxiliary.' + task,
        'extra_body': {}, 'fallback_chain': [{'provider': alternate, 'model': 'fallback-model',
            'base_url': fallback_endpoint, 'key_env': 'FALLBACK_FIXTURE_KEY', 'api_mode': 'chat_completions'}]}
    providers = {primary: {'api': endpoint, 'transport': 'chat_completions', 'key_env': 'PRIMARY_FIXTURE_KEY'},
        alternate: {'api': fallback_endpoint, 'transport': 'chat_completions', 'key_env': 'FALLBACK_FIXTURE_KEY'},
        'same-host-decoy': {'api': endpoint, 'transport': 'chat_completions', 'key_env': 'PRIMARY_FIXTURE_KEY'}}
    config = {'model_settings': {'revision': 4}, 'model': {'provider': primary, 'default': 'primary-model'},
        'providers': providers, 'secrets': {'environment': 'profile'}, 'auxiliary': {task: route, 'transient_retries': 0}}
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    install_profile_secret_source_values(tmp_path, {'PRIMARY_FIXTURE_KEY': 'private-primary',
        'FALLBACK_FIXTURE_KEY': 'private-fallback'})
    projection = {'environment_id': 'fixture', 'profile': 'owner', 'revision': 4, 'group': 'brain',
        'config': {'providers': providers}}
    projection_path = tmp_path / 'projection.json'
    projection_path.write_text(json.dumps(projection))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', str(projection_path))
    monkeypatch.setattr(usage, '_projection', lambda: projection)
    facts, wire = [], []
    monkeypatch.setattr(usage, 'publish', facts.append)
    def send(request):
        body = json.loads(request.content)
        wire.append((body['model'], request.headers['Authorization']))
        if fallback and body['model'] == 'primary-model':
            return httpx.Response(402, json={'error': {'message': 'fixture quota exhausted'}})
        if streaming:
            data = b'data: ' + json.dumps({'id': 'fixture', 'choices': [{'index': 0,
                'delta': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 5, 'completion_tokens': 1}}).encode() + b'\n\ndata: [DONE]\n\n'
            return httpx.Response(200, stream=httpx.ByteStream(zlib.compress(data, wbits=31)),
                headers={'content-type': 'text/event-stream', 'content-encoding': 'gzip'})
        return httpx.Response(200, json={'id': 'fixture', 'object': 'chat.completion', 'created': 1,
            'model': body['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'ok'},
            'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 5, 'completion_tokens': 1}})
    clients = []
    def create(api_key, base_url, **kwargs):
        client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0,
            http_client=usage.instrument(httpx.Client(transport=httpx.MockTransport(send))))
        clients.append(client)
        return client
    monkeypatch.setattr(auxiliary_client, '_create_openai_client', create)
    token = set_hermes_home_override(tmp_path)
    journal = journal_context.set(lambda fact: None)
    route_info = {}
    try:
        response = auxiliary_client.call_llm(task=task, messages=[{'role': 'user', 'content': 'fixture'}], route_info=route_info, stream=streaming)
        if streaming:
            assert ''.join(chunk.choices[0].delta.content or '' for chunk in response if chunk.choices) == 'ok'
            response.close()
        else:
            assert response.choices[0].message.content == 'ok'
        assert [fact['provider_id'] for fact in facts] == ([primary, alternate] if fallback else [primary])
        assert all(fact['role'] == 'auxiliary.' + task for fact in facts)
        assert facts[-1]['status'] == 'completed' and facts[-1]['input_tokens'] == 5
        assert route_info['provider'] == (alternate if fallback else primary), 'compression pins retain declared provider identity'
        assert wire == ([('primary-model', 'Bearer private-primary'), ('fallback-model', 'Bearer private-fallback')]
                        if fallback else [('primary-model', 'Bearer private-primary')])
    finally:
        journal_context.reset(journal)
        auxiliary_client.shutdown_cached_clients()
        reset_hermes_home_override(token)
        for client in clients: client.close()


def test_native_named_auxiliary_identity_is_bound_before_dispatch_for_preflight(tmp_path, monkeypatch):
    from agent import auxiliary_client
    monkeypatch.setattr(auxiliary_client, '_get_auxiliary_task_config', lambda task: {
        'provider': 'named-compression', 'role_id': 'auxiliary.compression'})
    with auxiliary_client._relay_aux_call_scope((), {'task': 'compression'}):
        assert usage._context()['_provider'] == 'named-compression'
