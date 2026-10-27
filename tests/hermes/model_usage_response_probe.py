"""Replay stored raw usage through the observer and the real Integration usage HTTP route."""
import json
import os
from pathlib import Path
import sys

root, native, request_path = map(Path, sys.argv[1:4])
request = json.loads(request_path.read_text())
sys.path[:0] = [str(native), str(root / 'integrations/hermes/personal_aios')]
os.environ.update(HERMES_HOME=request['home'], PAIOS_MODEL_SETTINGS_PROJECTION='offline-fixture',
    PAIOS_MODEL_SETTINGS_TOKEN_FILE=request['token_file'], PAIOS_MODEL_SETTINGS_SERVICE_URL=request['service_url'],
    NO_PROXY='127.0.0.1,localhost,::1', no_proxy='127.0.0.1,localhost,::1')
Path(request['home']).mkdir()

import httpx
import model_usage
from agent.model_usage import journal_context, provider_context, usage_role
from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation

model_usage._projection = lambda: request['projection']
facts, model_requests = [], []
journal = journal_context.set(facts.append)
binding = bind_api_run_conversation('recorded-usage-run', 'recorded-usage-session')
try:
    for index, case in enumerate(request['cases']):
        selected = case['contract']['provider']
        route = request['routes'][selected]
        def replay(http_request):
            model_requests.append(str(http_request.url))
            body = json.dumps(case['response']).encode()
            if index % 2 == 0:
                return httpx.Response(200, content=b'data: ' + body + b'\n\ndata: [DONE]\n\n',
                                      headers={'content-type': 'text/event-stream'})
            return httpx.Response(200, content=body, headers={'content-type': 'application/json'})
        provider = provider_context.set(selected)
        try:
            with usage_role(route['role'], case['id']):
                with model_usage.instrument(httpx.Client(transport=httpx.MockTransport(replay))) as client:
                    client.post(route['base_url'] + '/' + case['route'], json={'model': route['model']}).raise_for_status()
        finally:
            provider_context.reset(provider)
    print(json.dumps({'attempts': facts, 'mocked_model_requests': model_requests}))
finally:
    reset_api_run_conversation(binding)
    journal_context.reset(journal)
