"""Observe each inference HTTP attempt, including native and SDK retries."""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import httpx
from agent.model_usage import usage_context, provider_context, source_context, journal_context


def _projection():
    from hermes_cli.config import load_config
    return json.loads(Path(load_config()['secrets']['personal_aios']['projection']).read_text())


def _context():
    from agent.delegation_context import is_delegated_child_context
    from agent.auxiliary_client import _RELAY_AUX_CALL_CONTEXT
    from gateway.session_context import current_api_run_conversation
    bound = current_api_run_conversation()
    role, request_id = usage_context.get()
    auxiliary = _RELAY_AUX_CALL_CONTEXT.get()
    if auxiliary:
        role, request_id = auxiliary.get("role") or "auxiliary." + auxiliary["task"], auxiliary["request_id"]
    source = source_context.get()
    return {**({'source_context': source} if source else {}), 'run_id': bound[0] if bound else source.get('run_id', '') if source else '', 'session_id': bound[1] if bound else source.get('session_id', source.get('raw_ref', '')) if source else '',
            'request_id': request_id or str(uuid4()), 'role': role or ('delegation' if is_delegated_child_context() else 'cron' if source and source['kind'] == 'run' else 'brain'),
            '_provider': auxiliary['provider_id'] if auxiliary else provider_context.get()}


def publish(attempt):
    if not attempt.get('source_context'):
        journal_context.get()(attempt)
    token = Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip()
    request = Request(os.environ['PAIOS_MODEL_SETTINGS_SERVICE_URL'].rstrip('/') + '/internal/model-settings/usage',
        data=json.dumps(attempt).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    try:
        with urlopen(request, timeout=15) as response:
            response.read(65536)
    except (HTTPError, URLError, TimeoutError) as error:
        # The service answers {"error":{"code":...}}; keep it so a refusal names the contract check that fired.
        detail = f'{error.code} {error.read(512).decode("utf-8", "replace")}' if isinstance(error, HTTPError) else type(error).__name__
        if attempt.get('phase') == 'started':
            raise RuntimeError('MODEL_USAGE_START_UNAVAILABLE ' + detail) from error
        logging.getLogger(__name__).error('MODEL_USAGE_DELIVERY_FAILED attempt=%s error=%s', attempt['attempt_id'], detail)


def _usage_numbers(usage, protocol):
    # Protocol details precede compatibility aliases. A reported zero wins; an absent counter stays absent.
    if protocol == 'messages':
        fields = {'input_tokens': ('input_tokens',), 'output_tokens': ('output_tokens',),
                  'cache_read_input_tokens': ('cache_read_input_tokens',),
                  'cache_creation_input_tokens': ('cache_creation_input_tokens',),
                  'reasoning_tokens': ('reasoning_tokens',)}
    elif protocol == 'responses':
        fields = {'input_tokens': ('input_tokens',), 'output_tokens': ('output_tokens',),
                  'cached_tokens': ('input_tokens_details.cached_tokens', 'cache_read_input_tokens', 'cached_tokens'),
                  'cache_creation_input_tokens': ('input_tokens_details.cache_write_tokens',
                      'input_tokens_details.cache_creation_tokens', 'cache_creation_input_tokens', 'cache_write_tokens'),
                  'reasoning_tokens': ('output_tokens_details.reasoning_tokens', 'reasoning_tokens')}
    else:
        fields = {'prompt_tokens': ('prompt_tokens', 'input_tokens'), 'completion_tokens': ('completion_tokens', 'output_tokens'),
                  'cached_tokens': ('prompt_tokens_details.cached_tokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cached_tokens'),
                  'cache_creation_input_tokens': ('prompt_tokens_details.cache_write_tokens',
                      'prompt_tokens_details.cache_creation_input_tokens', 'cache_creation_input_tokens', 'cache_write_tokens'),
                  'reasoning_tokens': ('completion_tokens_details.reasoning_tokens', 'reasoning_tokens')}
    numbers = {}
    for key, paths in fields.items():
        for path in paths:
            value = usage
            for part in path.split('.'):
                value = value.get(part) if isinstance(value, dict) else None
            if type(value) is int and value >= 0:
                numbers[key] = value
                break
    return numbers


class _Attempt:
    def __init__(self, request, projection):
        body = json.loads(request.content)
        context = _context()
        if not context.get('source_context') and journal_context.get() is None:
            raise RuntimeError('MODEL_USAGE_SOURCE_REQUIRED_RESCHEDULE')
        selected = context.pop('_provider', None)
        providers = [(name, value) for name, value in projection['config']['providers'].items()
                     if (not selected or name == selected) and str(request.url).startswith(value['api'].rstrip('/') + '/')]
        if len(providers) != 1:
            raise ValueError('MODEL_USAGE_PROVIDER_BINDING_REQUIRED')
        if context['role'] == 'brain' and projection['group'] == 'build':
            context['role'] = 'build.workshop'
        self.fact = {**context, 'attempt_id': str(uuid4()), 'environment': projection['environment_id'],
            'profile': projection['profile'], 'revision': projection['revision'], 'provider_id': providers[0][0],
            'model_id': body['model'], 'base_url': providers[0][1]['api'], 'captured_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'input_tokens': None, 'output_tokens': None, 'cost': {'kind': 'unknown', 'amount': None, 'currency': 'CNY'}}
        self.pending = b''
        self.protocol = request.url.path.rsplit('/', 1)[-1]
        self.usage = {}
        self.done = False
        self.complete = False
        if context.get('source_context'):
            publish({**self.fact, 'phase': 'started', 'status': 'started', 'original_usage': {}})
            self.fact['phase'] = 'terminal'

    def parse(self, data):
        try:
            value = json.loads(data)
        except json.JSONDecodeError:
            return
        if not isinstance(value, dict):
            return
        if value.get('type') in ('response.completed', 'message_stop'):
            self.complete = True
        usage = value.get('usage') or value.get('response', {}).get('usage') or value.get('message', {}).get('usage')
        if usage:
            self.usage.update(_usage_numbers(usage, self.protocol))


    def feed(self, chunk):
        self.pending += chunk
        while b'\n' in self.pending:
            line, self.pending = self.pending.split(b'\n', 1)
            if line.startswith(b'data:'):
                if line[5:].strip() == b'[DONE]':
                    self.complete = True
                else:
                    self.parse(line[5:].strip())

    def finish(self, status):
        if self.done:
            return
        self.done = True
        self.parse(self.pending)
        self.fact.update(status=status, input_tokens=self.usage.get('prompt_tokens', self.usage.get('input_tokens')),
            output_tokens=self.usage.get('completion_tokens', self.usage.get('output_tokens')), original_usage=self.usage)
        publish(self.fact)

    def fail(self, error):
        self.fact['fallback_reason'] = 'timeout' if isinstance(error, httpx.TimeoutException) else 'provider_error'
        self.finish('failed')


class _ObservedResponse(httpx.SyncByteStream, httpx.AsyncByteStream):
    def __init__(self, response, attempt, status):
        self.attempt, self.status = attempt, status
        self.bytes, self.async_bytes = response.iter_bytes, response.aiter_bytes
        self.stream, self.exhausted = response.stream, False
        self.sse = 'text/event-stream' in response.headers.get('content-type', '')
        # Observe HTTPX's public decoded iterators, leaving transport bytes and headers intact.
        response.iter_bytes, response.aiter_bytes = self.iter_bytes, self.aiter_bytes
        response.stream = self

    def __iter__(self):
        yield from self.stream
        self.exhausted = True

    async def __aiter__(self):
        async for chunk in self.stream:
            yield chunk
        self.exhausted = True

    def feed(self, chunk):
        if self.sse:
            self.attempt.feed(chunk)
        else:
            self.attempt.pending += chunk

    def iter_bytes(self, chunk_size=None):
        try:
            for chunk in self.bytes(chunk_size):
                self.feed(chunk)
                yield chunk
        except httpx.HTTPError as error:
            if self.status == 'cancelled':
                self.attempt.finish('cancelled')
            else:
                self.attempt.fail(error)
            raise
        self.attempt.finish(self.status)

    def close(self):
        if not self.exhausted and not self.attempt.complete and self.status != 'failed':
            self.status = 'cancelled'
        self.stream.close()
        # iter_raw closes at EOF before the content decoder flushes its last bytes.
        if not self.exhausted or self.attempt.complete or self.status == 'cancelled':
            self.attempt.finish(self.status)

    async def aiter_bytes(self, chunk_size=None):
        try:
            async for chunk in self.async_bytes(chunk_size):
                self.feed(chunk)
                yield chunk
        except httpx.HTTPError as error:
            if self.status == 'cancelled':
                await asyncio.to_thread(self.attempt.finish, 'cancelled')
            else:
                await asyncio.to_thread(self.attempt.fail, error)
            raise
        await asyncio.to_thread(self.attempt.finish, self.status)

    async def aclose(self):
        if not self.exhausted and not self.attempt.complete and self.status != 'failed':
            self.status = 'cancelled'
        await self.stream.aclose()
        if not self.exhausted or self.attempt.complete or self.status == 'cancelled':
            await asyncio.to_thread(self.attempt.finish, self.status)


def instrument(client):
    if not os.environ.get('PAIOS_MODEL_SETTINGS_PROJECTION'):
        return client
    projection = _projection()
    send = client.send

    def completed(response, attempt):
        status = 'failed' if response.status_code >= 400 else 'completed'
        reason = {401: 'authentication_error', 403: 'authentication_error', 404: 'model_not_found', 429: 'rate_limit'}.get(response.status_code)
        if reason or response.status_code >= 500:
            attempt.fact['fallback_reason'] = reason or 'provider_error'
        if response.is_stream_consumed:
            parse = attempt.feed if 'text/event-stream' in response.headers.get('content-type', '') else attempt.parse
            parse(response.content)
            attempt.finish(status)
        else:
            _ObservedResponse(response, attempt, status)
        return response

    def sync_send(request, **kwargs):
        if request.method != 'POST' or not request.url.path.endswith(('/chat/completions', '/responses', '/messages')):
            return send(request, **kwargs)
        attempt = _Attempt(request, projection)
        try:
            return completed(send(request, **kwargs), attempt)
        except httpx.HTTPError as error:
            attempt.fail(error)
            raise

    async def async_send(request, **kwargs):
        if request.method != 'POST' or not request.url.path.endswith(('/chat/completions', '/responses', '/messages')):
            return await send(request, **kwargs)
        attempt = await asyncio.to_thread(_Attempt, request, projection)
        try:
            response = await send(request, **kwargs)
        except httpx.HTTPError as error:
            await asyncio.to_thread(attempt.fail, error)
            raise
        return completed(response, attempt)

    client.send = async_send if isinstance(client, httpx.AsyncClient) else sync_send
    return client


def install():
    from agent import process_bootstrap
    process_bootstrap._model_usage_observer = instrument
