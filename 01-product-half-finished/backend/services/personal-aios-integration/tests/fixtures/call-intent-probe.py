"""Run the locked native classifier/attempt observer against loopback fake providers."""
import asyncio
import json
import os
import sys
from pathlib import Path

from personal_aios import model_usage
from personal_aios.run_api import auxiliary_execution, classify_call_intent


async def main():
    request = json.load(sys.stdin)
    from agent.secret_scope import set_secret_scope
    projection = json.loads(Path(os.environ['PAIOS_MODEL_SETTINGS_PROJECTION']).read_text())
    set_secret_scope({binding['name']: 'fake-inference-key' for binding in projection['credentials']})
    model_usage.install()
    with auxiliary_execution(None, {'source_context': request['source_context']}, 'call.intent'):
        result = await classify_call_intent(request['text'])
    print(json.dumps(result), flush=True)


asyncio.run(main())
