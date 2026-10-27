"""Run the shipped native installer; only external credential retrieval is synthetic."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'integrations/hermes'))
from personal_aios import model_transport

model_transport.credential = lambda *_: 'synthetic-model-credential'
print(json.dumps(model_transport.activate(Path(sys.argv[1]), json.load(sys.stdin))))
