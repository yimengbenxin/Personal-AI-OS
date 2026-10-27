# SPDX-License-Identifier: GPL-3.0-or-later
"""Qualify the connector's API results without changing its execution authority."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "sdk/python"))
from yimi_receipt import receipt, effect, value, unknown_fact, to_mcp_result


def package_receipt(tool, args, result):
    as_of = datetime.now(timezone.utc).isoformat()
    state = result.get("status", "succeeded")
    state = {"connected": "succeeded", "login_required": "waiting",
             "waiting_for_scan": "waiting", "outcome_unknown": "unknown",
             "incomplete": "partial", "rejected": "failed"}.get(state, state)
    reason = result.get("error")
    effects, values, content, unknowns = [], [], [], []
    next_step = {"retry": "forbidden", "waiting_on": "none"}
    if result.get("status") in {"login_required", "waiting_for_scan"}:
        reason = "login_required" if result["status"] == "login_required" else "login_scan_pending"
        next_step.update(waiting_on="owner", waiting_detail="请用米家 App 扫码登录")
    if tool == "read_device" and "properties" in result:
        for prop in result["properties"]:
            label = result["device"] + "的" + prop["service"] + "." + prop["property"]
            if prop["code"] == 0:
                values.append(value(label, prop["value"], prop.get("unit", "none"),
                                    "observed", "米家云", as_of))
            else:
                unknowns.append(unknown_fact(label, "属性读取未获有效结果"))
        if unknowns:
            state = "partial" if values else "unknown"
        if state == "succeeded" and values and args.get("check_for"):
            effects.append(effect("observe", "mijia:" + result["device_id"], "read_device", "verified",
                                  "MIoT properties read from this device", args["check_for"]))
    if tool in {"control_device", "run_scene"} and any(key in result for key in ("code", "device_id", "results")):
        steps = args.get("steps", [args])
        outcomes = result.get("results", [result])
        for step, outcome in zip(steps, outcomes):
            verification = "unknown" if "code" not in outcome else "service_ack" if outcome["code"] == 0 else "not_verified"
            effects.append(effect("physical", "mijia:" + outcome["device_id"] if "device_id" in outcome else step["device"],
                step["service"] + "." + (step.get("property") or step.get("action", "")),
                verification, json.dumps({"code": outcome.get("code")}), args.get("idempotency_key") or None))
        if any(outcome.get("status") == "outcome_unknown" for outcome in outcomes):
            state = "partial" if any(e["verification"] == "service_ack" for e in effects) else "unknown"
            unknowns.append(unknown_fact(args.get("name", args.get("device", "操作结果")), "连接中断，执行结果尚未核实"))
        if state == "partial":
            next_step.update(retry="after_check", check_with="read_device")
        if state == "accepted" or any(outcome.get("status") == "accepted" for outcome in outcomes):
            next_step.update(waiting_on="external", waiting_detail="等待设备执行结果")
    if state == "unknown":
        next_step.update(retry="after_check", check_with="read_device")
        if not unknowns:
            unknowns.append(unknown_fact(args.get("device", "操作结果"), "连接中断，结果尚未核实"))
    for key in ("instruction", "qr_markdown"):
        if key in result:
            content.append({"key": key, "text": result[key], "provenance": "observed"})
    if tool == "refresh_devices" and "devices" in result:
        values.append(value("发现设备", len(result["devices"]), "台", "observed", "米家云", as_of))
    if tool == "get_login_status" and result.get("status") == "connected":
        content.append({"key": "连接状态", "text": "已连接", "provenance": "observed"})
    body = receipt(state, status={"reason_code": reason} if reason else {}, effects=effects,
        values=values, content=content, unknowns=unknowns, next=next_step)
    # The additive snapshot supports consumers migrating from the connector's original result.
    body["legacy"] = result
    return to_mcp_result(body, json.dumps(body, ensure_ascii=False, separators=(",", ":")))
