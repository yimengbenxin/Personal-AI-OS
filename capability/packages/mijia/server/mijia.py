# SPDX-License-Identifier: GPL-3.0-or-later
import asyncio
from functools import lru_cache, wraps
import json
import os
from pathlib import Path
import time
from typing import Annotated
from urllib.parse import parse_qs, quote, urlsplit

from mcp.server import MCPServer
from mcp.types import CallToolResult, TextContent
from pydantic import Field
from mijiaAPI import mijiaAPI as XiaomiAPI
from mijiaAPI.errors import APIError, LoginError
from mijiaAPI.logger import logger
import requests
from mijia_receipts import package_receipt

logger.disabled = True  # Upstream debug logging includes credentials and API payloads.
# Consumed by the capability gateway's consent decision; the connector itself never reads it.
OwnerRequested = Annotated[bool, Field(description="仅当主人明确要求本次操作时为 true；我自己决定的操作为 false。")]


class MijiaTransport(requests.adapters.HTTPAdapter):
    def send(self, request, **kwargs):
        kwargs["timeout"] = kwargs.get("timeout") or (5, 30)
        return super().send(request, **kwargs)


class mijiaAPI(XiaomiAPI):
    def _init_session(self):
        super()._init_session()
        self.session.mount("https://", MijiaTransport())

    def _get_location(self):
        # mijiaAPI 5.0.0 uses a module-level request here, outside its session transport.
        headers = {
            "User-Agent": self.user_agent,
            "Connection": "keep-alive",
            "Accept-Encoding": "gzip",
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": f"deviceId={self.deviceId};"
                      f"pass_o={self.pass_o};"
                      f"passToken={self.auth_data.get('passToken', '')};"
                      f"userId={self.auth_data.get('userId', '')};"
                      f"cUserId={self.auth_data.get('cUserId', '')};"
                      f"uLocale={self.locale};",
        }
        service_ret = requests.get(self.service_login_url, headers=headers, timeout=(5, 30))
        service_data = self._handle_ret(service_ret, verify_code=False)
        location = service_data["location"]
        if service_data['code'] == 0:
            ret = self.session.get(location, timeout=(5, 30))
            if ret.status_code == 200 and ret.text == "ok":
                self.auth_data.update(self.session.cookies.get_dict())
                self.auth_data["ssecurity"] = service_data["ssecurity"]
                return {"code": 0, "message": "刷新Token成功"}
        return {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}


def create_server(api, load_spec, data_root, call_log=None):
    mcp = MCPServer("mijia")
    devices, login = [], {}
    api_lock = asyncio.Lock()

    @lru_cache(maxsize=None)
    def cached_spec(urn):
        path = data_root / "specs" / (quote(urn, safe="") + ".json")
        if path.exists():
            return json.loads(path.read_text())
        spec = load_spec(urn)
        path.parent.mkdir(mode=0o700, exist_ok=True)
        pending = path.with_suffix(".tmp")
        pending.write_text(json.dumps(spec, ensure_ascii=False, separators=(",", ":")))
        pending.replace(path)
        return spec

    def record(path, entry):
        with open(path, "a") as out:
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def tool(fn):
        @wraps(fn)
        async def call(**args):
            async with api_lock:
                result = {"status": "failed", "error": "tool_execution_failed"}
                try:
                    result = await fn(**args)
                except asyncio.CancelledError:
                    result = {"status": "cancelled"}
                    raise
                except (LoginError, APIError, requests.RequestException) as error:
                    if isinstance(error, LoginError) or str(error).startswith(("code: -10020,", "code: -10030,")):
                        api.auth_data.clear()
                        (data_root / "session.json").unlink(missing_ok=True)
                        result = {"status": "login_required", "instruction": "请主人重新用米家 App 扫码。"}
                    else:
                        result = {"status": "outcome_unknown" if isinstance(error, requests.RequestException) else "failed", "error": "mijia_request_failed"}
                except PermissionError as error:
                    result = {"status": "rejected", "error": str(error)}
                finally:
                    if call_log:
                        record(call_log, {"tool": fn.__name__, "args": args, "result": result})
                wire = package_receipt(fn.__name__, args, result)
                return CallToolResult(content=[TextContent(**wire["content"][0])],
                                      structured_content=wire["structuredContent"])
        mcp.add_tool(call)
        registered = mcp._tool_manager.get_tool(fn.__name__)
        registered.fn_metadata.arg_model.model_config['extra'] = 'forbid'
        registered.fn_metadata.arg_model.model_rebuild(force=True)
        registered.parameters = registered.fn_metadata.arg_model.model_json_schema(by_alias=True)

    def ready():
        if login.get("task") and not login["task"].done():
            raise PermissionError("login_scan_pending")
        if api.auth_data.get("expireTime", 0) <= time.time() * 1000:
            raise LoginError(-1, "scan_required")

    def one(items):
        if len(items) != 1:
            raise PermissionError("refresh_devices_then_use_unique_home_room_device_or_capability")
        return items[0]

    def urn_name(item):
        return item["type"].split(":")[3]

    def capabilities(spec):
        def property_info(p, inputs):
            item = {"name": urn_name(p), "access": p["access"]}
            if "write" in p["access"] or p["iid"] in inputs:
                item.update({k: p[k] for k in ("format", "unit", "value-range") if k in p})
                if "value-list" in p:
                    item["values"] = {str(v["value"]): v["description"] for v in p["value-list"]}
            return item

        return [{"name": s["name"],
                 "properties": [property_info(p, {iid for a in s.get("actions", []) for iid in a.get("in", [])})
                     for p in s.get("properties", [])],
                 "actions": [{"name": urn_name(a), **{k: [
                     next(urn_name(p) for p in s.get("properties", []) if p["iid"] == iid)
                     for iid in a.get(k, [])] for k in ("in", "out")}}
                     for a in s.get("actions", [])]}
                for s in spec["services"]] if spec else []

    def device_named(device, home="", room=""):
        d = one([d for d in devices if d["name"] == device and
                 (not home or d["home"] == home) and (not room or d["room"] == room)])
        if d["spec"] is None:
            raise PermissionError("miot_unavailable_use_mijia_phone_app")
        return d

    def plan(device, service, home="", room="", property="", value=None, action="", arguments=None):
        d = device_named(device, home, room)
        s = one([s for s in d["spec"]["services"] if s["name"] == service])
        if any("lock" in kind.split("-") or kind in {"dlock", "ulock"} or
               kind.removesuffix("-opener").removesuffix("-controller") in {"door", "gate", "garage-door"}
               for kind in (urn_name(d["spec"]), urn_name(s))):
            record(data_root / "actions.jsonl", {"device": d["name"], "action": service + "." + (property or action),
                   "result": "rejected", "ms": 0})
            raise PermissionError("entrance_control_denied")
        if bool(property) == bool(action):
            raise PermissionError("choose_property_or_action")
        member = one([p for p in s.get("properties" if property else "actions", [])
                      if urn_name(p) == (property or action)])
        if property and "write" not in member["access"]:
            raise PermissionError("property_not_writable")
        params = {"did": d["did"], "siid": s["iid"], "piid" if property else "aiid": member["iid"]}
        # The SDK forwards action params unchanged; MIoT names action inputs "in".
        params["value" if property else "in"] = value if property else (arguments or [])
        return d["name"], service + "." + (property or action), property, params

    async def execute(item):
        device, action, property, params = item
        started, outcome, cancelled = time.monotonic(), "failed", None
        try:
            ready()
            outcome = "outcome_unknown"
            pending = asyncio.create_task(asyncio.to_thread(api.set_devices_prop if property else api.run_action, params))
            # Cancellation cannot stop the SDK thread. Keep its exact task and the API lock until settlement.
            while not pending.done():
                try:
                    await asyncio.shield(pending)
                except asyncio.CancelledError as error:
                    cancelled = error
            result = pending.result()
            outcome = {0: "succeeded", 1: "accepted"}.get(result["code"], "failed")
            return {"status": outcome, "code": result["code"], "device_id": str(params["did"])}
        except requests.RequestException:
            outcome = "outcome_unknown"
            return {"status": outcome, "error": "mijia_request_failed", "device_id": str(params["did"])}
        finally:
            record(data_root / "actions.jsonl", {"device": device, "action": action,
                   "result": outcome, "ms": round((time.monotonic() - started) * 1000)})
            if cancelled:
                raise cancelled

    @tool
    async def get_login_status() -> dict:
        """米家连接状态；login_required/expired/failed 时请主人重新扫码，不要声称已操作。"""
        task = login.get("task")
        if task and not task.done():
            return {"status": "waiting_for_scan"}
        if task and task.exception():
            return {"status": "failed", "instruction": "扫码未完成，请重新生成二维码。"}
        return {"status": "connected" if api.auth_data.get("expireTime", 0) > time.time() * 1000 else "login_required"}

    @tool
    async def prepare_login(owner_requested: OwnerRequested = False) -> dict:
        """返回短 qr: 登录链接供 iPhone 本地生成二维码。将 qr_markdown 放入文字回复，请主人保存图片后用米家相册扫码。"""
        if login.get("task") and not login["task"].done():
            return {"status": "waiting_for_scan", "qr_markdown": login["qr"]}
        if api.auth_data.get("expireTime", 0) <= time.time() * 1000:
            api.auth_data.clear()
        data = await asyncio.to_thread(api._get_qr_login_data)
        if data.get("refreshed"):
            login.clear()
            return {"status": "connected"}
        url = data["loginUrl"].replace("(", "%28").replace(")", "%29")
        if len(url.encode()) > 2048 or urlsplit(url).scheme != "https" or not urlsplit(url).hostname:
            raise PermissionError("qr_requires_https_url_up_to_2048_bytes")
        login["qr"] = f"![米家登录二维码](qr:{url})"
        login["task"] = asyncio.create_task(asyncio.to_thread(api._complete_qr_login, data))
        login["task"].add_done_callback(lambda task: None if task.cancelled() else task.exception())
        return {"status": "waiting_for_scan", "qr_markdown": login["qr"]}

    @tool
    async def refresh_devices() -> dict:
        """发现设备与在线状态；capability 引用共享 capabilities 的服务/属性/动作。控制前先发现。"""
        ready()
        homes = await asyncio.to_thread(api.get_homes_list)
        rooms = {str(did): (h["name"], r["name"]) for h in homes
                 for r in h.get("roomlist", []) for did in r.get("dids", [])}
        home_names = {str(h["id"]): h["name"] for h in homes}
        found = []
        for d in await asyncio.to_thread(api.get_devices_list):
            spec = await asyncio.to_thread(cached_spec, d["spec_type"]) if d.get("spec_type") else None
            if spec:
                spec = {**spec, "services": [{**s, "name": urn_name(s) +
                    (f"#{s['iid']}" if sum(urn_name(other) == urn_name(s)
                     for other in spec["services"]) > 1 else "")} for s in spec["services"]]}
            home, room = rooms.get(str(d["did"]), (home_names[str(d["home_id"])], ""))
            found.append({"did": d["did"], "name": d["name"], "home": home, "room": room,
                          "online": d.get("isOnline"), "spec": spec})
        devices[:] = found
        specs = {d["spec"]["type"]: d["spec"] for d in devices if d["spec"]}
        keys = {urn: str(i) for i, urn in enumerate(specs, 1)}
        return {"devices": [{"device": d["name"], "home": d["home"], "room": d["room"],
                "type": urn_name(d["spec"]) if d["spec"] else "unsupported",
                "online": d["online"], "capability": keys[d["spec"]["type"]] if d["spec"] else None}
                for d in devices], "capabilities": {keys[urn]: capabilities(spec) for urn, spec in specs.items()}}

    @tool
    async def read_device(device: str, home: str = "", room: str = "", include_spec: bool = False, check_for: str = "") -> dict:
        """读设备状态，包括门锁；include_spec=true 同时返回此设备完整 MIoT 规格。非零 code 不是成功读数。"""
        ready()
        d = device_named(device, home, room)
        props = [(s, p) for s in d["spec"]["services"] for p in s.get("properties", []) if "read" in p["access"]]
        result = await asyncio.to_thread(api.get_devices_prop, [
            {"did": d["did"], "siid": s["iid"], "piid": p["iid"]} for s, p in props]) if props else []
        values = {(str(r["did"]), r["siid"], r["piid"]): {"code": r["code"], "value": r.get("value")} for r in result}
        return {"device": device, "device_id": str(d["did"]), **({"spec": d["spec"]} if include_spec else {}),
                "properties": [{"service": s["name"], "property": urn_name(p),
                "unit": p.get("unit", "none"), **values[(str(d["did"]), s["iid"], p["iid"])]} for s, p in props]}

    @tool
    async def control_device(device: str, service: str, home: str = "", room: str = "", property: str = "",
                             value: bool | int | float | str | None = None, action: str = "", arguments: list | None = None,
                             owner_requested: OwnerRequested = False, idempotency_key: str = "") -> dict:
        """按发现的名称设置 property/value 或执行 action/arguments，二选一。门锁及入口开门设备/服务只读。"""
        return await execute(plan(device, service, home, room, property, value, action, arguments))

    @tool
    async def run_scene(name: str, steps: list[dict], owner_requested: OwnerRequested = False, idempotency_key: str = "") -> dict:
        """执行明确设备步骤组成的场景。steps 是 control_device 参数对象；先整体拒绝门锁和入口开门，再逐步执行。不要传不透明云场景 ID。"""
        # owner_requested belongs to the whole scene (the gateway decided it once); a step copying it carries no meaning.
        planned = [plan(**{k: v for k, v in step.items() if k != "owner_requested"}) for step in steps]
        results = []
        for item in planned:
            result = await execute(item)
            results.append(result)
            if result["status"] not in {"succeeded", "accepted"}:
                break
        return {"scene": name, "results": results, "status": "succeeded" if len(results) == len(steps)
                and all(r["status"] == "succeeded" for r in results) else "incomplete"}

    return mcp


if __name__ == "__main__":
    os.umask(0o077)
    root = Path(os.environ["HERMES_HOME"]) / "mijia"
    root.mkdir(mode=0o700, exist_ok=True)
    session = root / "session.json"
    if session.exists():
        session.chmod(0o600)
    def load_spec(urn):
        response = requests.get("https://miot-spec.org/miot-spec-v2/instance", params={"type": urn}, timeout=30)
        response.raise_for_status()
        return response.json()
    create_server(mijiaAPI(str(session)), load_spec, root).run("stdio")
