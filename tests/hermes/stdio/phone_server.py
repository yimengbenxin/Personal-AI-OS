"""Synthetic boundaries; production server control flow and payment guard remain intact."""
import asyncio
import base64
import http.server
import io
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace as NS
import urllib.request
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(os.environ['PROBE_SOURCE'])
OUT = Path(os.environ['PROBE_OUT'])
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'spool').mkdir()
os.environ.update(PAIOS_PHONE_PROVIDER='agentbay', PAIOS_ERRAND_SPOOL=str(OUT / 'spool'))
sys.path.insert(0, str(ROOT / 'integrations/connectors/phone_executor'))
import server as s

calls, requests, clicks = [], [], []
NODES = [['合计 ¥16.60', 10, 100, 500, 180], ['支付宝付款', 100, 600, 600, 720]]
image = io.BytesIO()
Image.new('RGB', (720, 1280), 'white').save(image, format='PNG')
class Endpoint(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        op = body['op']
        value = NODES if op in ('screen', 'tree') else True
        if op == 'tap':
            clicks.append(body)
        if op == 'shell':
            cmd = body['cmd']
            value = {'wm size': 'Physical size: 720x1280',
                     'getprop gsm.sim.operator.iso-country': 'cn',
                     'settings get secure default_input_method': 'fixture.ime',
                     'ime list -s': 'fixture.ime\ncom.mobilerun.portal/.fixture',
                     'dumpsys accessibility': 'Bound services:{label=Mobilerun Portal,} Enabled services:{com.mobilerun.portal} Binding services:{} Crashed services:{}',
                     'pm list packages': 'package:com.mobilerun.portal\npackage:io.appium.settings'}.get(cmd, '')
            if 'paios-observe.jar' in cmd: value = 'ready'
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def log_message(self, *_): pass
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
endpoint = f'http://127.0.0.1:{httpd.server_port}'
if os.environ.get('PROBE_CASE') == 'unreachable':
    httpd.shutdown()
    httpd.server_close()
def rpc(op, **kw):
    req = urllib.request.Request(endpoint, json.dumps({'op': op, **kw}).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=1) as response:
        return json.load(response)
def audit():
    (OUT / 'audit.json').write_text(json.dumps({'calls': calls, 'requests': requests, 'payment_clicks': clicks, 'versions': {'python': sys.version, 'executable': sys.executable, 'mcp': version('mcp')}}, ensure_ascii=False))
def profile(frame, event, arg):
    if event == 'call' and frame.f_code.co_filename in (s.__file__, s.payment_guard.__file__):
        name = frame.f_code.co_name
        if name in {'phone_task', '_job', '_errand_task', '_errand', '_agent', '_checked_input', 'phone_status'} and name not in calls:
            calls.append(name)
            audit()
sys.setprofile(profile)
threading.setprofile(profile)
class Cloud:
    @staticmethod
    def status(): return {'provider': 'agentbay', 'status': 'ready'}
    @staticmethod
    async def lease(*args, **kwargs):
        await asyncio.to_thread(rpc, 'lease')
        calls.append('fake_agentbay_lease')
        audit()
        return NS(serial='synthetic-loopback')
    @staticmethod
    async def release(*args, **kwargs):
        await asyncio.to_thread(rpc, 'release')
        audit()
    @staticmethod
    def reap_login(): return False
sys.modules['agentbay_phone'] = Cloud
s.ADB = '/nonexistent/synthetic-fixture-adb'
class Observations:
    size = (720, 1280)
    def request(self, command):
        if command.startswith('screen'):
            rpc('screen')
            return {'width': 720, 'height': 1280, 'data': base64.b64encode(image.getvalue()).decode()}
        root = ET.Element('hierarchy', width='720', height='1280')
        for text, x0, y0, x1, y1 in rpc('tree'):
            ET.SubElement(root, 'node', text=text, bounds=f'[{x0},{y0}][{x1},{y1}]')
        return {'data': base64.b64encode(ET.tostring(root)).decode()}
    def close(self): pass
s._Observations = Observations
s._shell = lambda cmd, *args, **kw: rpc('shell', cmd=cmd)
s._online = lambda *args: bool(rpc('online'))
s._screen_nodes = lambda data, *args: rpc('screen')
class Driver:
    async def screenshot(self, **kw):
        return await asyncio.to_thread(s._observation, 'screen')
    async def tap(self, x, y):
        return await asyncio.to_thread(rpc, 'tap', x=x, y=y)
async def driver(**kw): return Driver()
s._driver = driver
# Actual dependency import; no key-file variable is supplied to this isolated process.
s._load_model()
from mobilerun_core_local.driver.android.portal import PORTAL_PACKAGE_NAME, portal_ime_id
original_shell = s._shell
def shell(cmd, *args, **kw):
    if cmd == 'ime list -s': return portal_ime_id(PORTAL_PACKAGE_NAME)
    return original_shell(cmd, *args, **kw)
s._shell = shell
s.ConfigLoader = NS(load=lambda _: NS(device=NS(serial=''), agent=NS(max_steps=3), llm_profiles={}))
class Handler:
    def __init__(self, guard): self.guard = guard
    def __await__(self): return self.work().__await__()
    async def work(self):
        await asyncio.sleep(0.4)  # Permit a genuine concurrent status request.
        try:
            await self.guard.tap(350, 650)
        except s._Refused as exc:
            calls.append('CheckoutStop_refused_payment')
            audit()
            return NS(success=True, reason='Synthetic model obeyed guard: ' + str(exc), steps=1)
        raise AssertionError('payment tap crossed CheckoutStop')
    async def stream_events(self):
        if False: yield None
    async def cancel_run(self): pass
class Agent:
    def __init__(self, **kw): self.guard = kw['driver']
    def run(self): return Handler(self.guard)
s.MobileAgent = Agent
s._load_model = lambda: None  # Preserve the deterministic model boundary across _agent's lazy import.
audit()
try:
    s.mcp.run('stdio')
finally:
    sys.setprofile(None); threading.setprofile(None)
    httpd.shutdown(); httpd.server_close()
