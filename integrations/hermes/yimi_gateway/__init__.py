"""Documented Hermes hooks; platform admission owns policy and receipt facts."""
import json
from pathlib import Path
from functools import partial
from jsonschema import Draft202012Validator
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def _unknown():
    body = {"receipt": 1, "status": {"state": "unknown", "reason_code": "gateway_unavailable"},
            "effects": [], "values": [], "content": [],
            "unknowns": [{"about": "执行结果", "why": "回执服务暂时不可用"}],
            "next": {"retry": "after_check", "waiting_on": "none"}}
    return "结果尚未核实，需要先核查，再决定是否重试。\n" + json.dumps(body, ensure_ascii=False)


class Gateway:
    def __init__(self, config):
        self.config = config
        self.tools = set(config.get("capability_tools") or [])
        contracts = Path(__file__).resolve().parents[3] / 'capability/contracts'
        self.receipts = Draft202012Validator(json.loads((contracts / 'receipt.v1.schema.json').read_text()))
        self.hooks = json.loads((contracts / 'hermes-hook-input.v1.schema.json').read_text())

    def package_receipt(self, result):
        pending = [result]
        while pending:
            item = pending.pop()
            if isinstance(item, str):
                try:
                    pending.append(json.loads(item))
                except ValueError:
                    pass
            elif isinstance(item, dict):
                if self.receipts.is_valid(item):
                    return item
                if 'structuredContent' in item:
                    pending.append(item['structuredContent'])
                    continue
                if 'result' in item:
                    pending.append(item['result'])
                blocks = item.get('content')
                if isinstance(blocks, list):
                    pending.extend(block.get('text') for block in blocks
                                   if isinstance(block, dict) and block.get('type') == 'text')
        return None

    def lifecycle(self, hook, **fields):
        allowed = self.hooks['properties']['payload']['properties']
        try:
            payload = {key: value for key, value in fields.items() if key in allowed}
            if 'conversation_history' in payload:
                payload['conversation_history'] = [{key: row.get(key) for key in ('role', 'content')}
                    for row in payload['conversation_history'] if isinstance(row, dict)]
            self.rpc('lifecycle', {'hook': hook, 'payload': payload})
        except Exception:
            pass  # A lost observer never supplies execution authority.

    def rpc(self, operation, body=None):
        base = self.config["internal_base_url"]
        address = urlsplit(base)
        if address.scheme != "http" or address.hostname not in {"127.0.0.1", "::1", "localhost"} or address.username:
            raise ValueError("internal_loopback_configuration_required")
        request = Request(base.rstrip("/") + "/internal/hermes/gateway/" + operation,
            data=None if body is None else json.dumps(body).encode(), headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + Path(self.config["internal_key_file"]).read_text().strip()})
        with urlopen(request, timeout=3) as response:
            payload = response.read(1048577)
            if len(payload) > 1048576:
                raise ValueError("gateway_response_budget_exceeded")
            return json.loads(payload) if payload else None

    @staticmethod
    def envelope(tool_name, args, fields, *, result=False, post=False):
        body = {key: fields.get(key, "") for key in ("task_id", "session_id", "tool_call_id", "turn_id", "api_request_id")}
        body.update(tool_name=tool_name, args=args)
        if result:
            body.update({key: fields.get(key) for key in ("result", "error_type", "error_message")})
            body.update(duration_ms=fields.get("duration_ms", 0), status=fields.get("status", ""))
        if not result or post:
            body["middleware_trace"] = fields.get("middleware_trace", [])
        return body

    def pre(self, tool_name, args, **fields):
        try:
            catalog = self.rpc("catalog")
            if tool_name not in catalog["tools"]:
                return ({'action': 'block', 'message': 'CAPABILITY_TOOL_NOT_ENABLED'}
                        if tool_name.startswith('mcp__yimi_shared__') else None)
            decision = self.rpc("decide", self.envelope(tool_name, args, fields))
            if decision["action"] == "allow":
                return None
            if decision["action"] == "block" and decision.get("message"):
                return decision
            if decision["action"] == "modify" and isinstance(decision.get("args"), dict):
                return decision
            if decision["action"] == "approve" and decision.get("message") and decision.get("rule_key"):
                return decision  # Native approval gate; the platform shows the owner's card and answers it.
            raise ValueError("invalid_gateway_decision")
        except Exception:
            return {"action": "block", "message": "能力判定服务暂时不可用，本次未执行。"}

    def transform(self, tool_name, args, **fields):
        if self.package_receipt(fields.get('result')) is not None:
            return None
        try:
            if tool_name not in self.rpc("catalog")["tools"]:
                return None
            view = self.rpc("receipt", self.envelope(tool_name, args, fields, result=True))["model_view"]
            if not isinstance(view, str) or not view.strip():
                raise ValueError("invalid_gateway_receipt_view")
            return view
        except Exception:
            return _unknown() if tool_name in self.tools or tool_name.startswith('mcp__yimi_shared__') else None

    def post(self, tool_name, args, **fields):
        try:
            if tool_name in self.rpc("catalog")["tools"]:
                self.rpc("receipt", self.envelope(tool_name, args, fields, result=True))
                self.rpc("observe", self.envelope(tool_name, args, fields, result=True, post=True))
        except Exception:
            pass  # Observation failure cannot undo execution or change an admitted receipt.

def register(ctx):
    keys = ('internal_base_url', 'internal_key_file', 'capability_tools')
    gateway = Gateway({key: ctx.get_config(key) for key in keys})
    ctx.register_hook("pre_tool_call", gateway.pre)
    ctx.register_hook("transform_tool_result", gateway.transform)
    ctx.register_hook("post_tool_call", gateway.post)
    for hook in gateway.hooks['properties']['hook']['enum']:
        ctx.register_hook(hook, partial(gateway.lifecycle, hook))
