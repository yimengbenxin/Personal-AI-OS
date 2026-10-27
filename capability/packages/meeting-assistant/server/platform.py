"""Thin loopback platform transport; consent, models, L5 and exact-Mac execution stay in the platform."""
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen


class Platform:
    def __init__(self, request=None):
        self.request = request or self._request

    @staticmethod
    def configured():
        return bool(os.environ.get('PAIOS_INTEGRATION_PORT'))

    @staticmethod
    def _request(body):
        port = int(os.environ['PAIOS_INTEGRATION_PORT'])
        key = os.environ.get('PAIOS_HERMES_INTERNAL_KEY') or Path('/run/secrets/hermes-internal.key').read_text().strip()
        request = Request(f'http://127.0.0.1:{port}/internal/meeting/call',
                          data=json.dumps(body, ensure_ascii=False).encode(),
                          headers={'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=120) as response:
            return json.load(response)

    def invoke(self, tool, arguments):
        return self.request({'method': 'invoke', 'tool': tool, 'args': arguments})

    def prepare(self, tool, arguments):
        return self.request({'method': 'prepare', 'tool': tool, 'args': arguments})
