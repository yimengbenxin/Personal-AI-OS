"""Project executor evidence; the spool remains the only job authority."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "capability/sdk/python"))
from yimi_receipt import effect, receipt, to_mcp_result, unknown_fact, value

CHECK = "phone_status"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def project(record, *, job_id, revision):
    if "jobs" in record:
        return receipt("succeeded", next={"retry": "allowed"})
    reason = record.get("error_code") or record.get("terminal_reason") or record.get("status") or record.get("state", "")
    uncertain = any(record.get(key) in {"timed_out", "interrupted", "retryable", "PHONE_DISCONNECTED", "PAYMENT_ORDER_CHECK_REQUIRED", "PHONE_LOCAL_RESOURCE_UNAVAILABLE"}
                    for key in ("terminal_reason", "error_code", "status", "state"))
    owner_wait = record.get("error_code") in {"APP_LOGIN_REQUIRED", "PAYMENT_LINEAGE_OWNER_CHECK_REQUIRED"}
    state = ("unknown" if uncertain else "waiting" if owner_wait else
             "cancelled" if reason == "cancelled_by_user" else
             "running" if reason in {"running", "stopping", "already_running"} else
             "accepted" if reason in {"waiting", "started", "busy"} else
             "succeeded" if record.get("success") is True or reason == "ready" else
             "failed" if record.get("success") is False or reason in {"failed", "error", "unavailable", "rejected"} else "unknown")
    stamp = record.get("trace", {}).get("screen_observed_at") or record.get("finished_at") or record.get("started_at") or now()
    effects, values, content, unknowns = [], [], [], []
    target = record.get("app") or "执行手机"
    # A model's claimed_verified todo is not a re-read. Only explicit screen/service evidence qualifies effects.
    for fact in record.get("effect_evidence", []):
        effects.append(effect(fact["kind"], fact.get("target", target), fact["action"],
                              fact["verification"], fact["evidence"], fact.get("ref")))
    # The agent's legacy answer stays in the spool. Reportable content needs its own source, like values and effects.
    content.extend(record.get("observed_content", []))
    for fact in record.get("observed_values", []):
        values.append(value(fact["key"], fact["value"], fact["unit"], fact["provenance"],
                            fact["source"], fact.get("as_of", stamp)))
    # Preserve exact screen tokens, without guessing order IDs, rounding prices or promoting the agent's answer.
    private = record.get("payment_intent") or record.get("payment_owner") or record.get("payment_reconciliation")
    screen = "" if private else record.get("partial_findings", record.get("trace", {}).get("findings", {})).get("last_screen_text", "")
    for match in re.finditer(r"(?:[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*元)", screen):
        shown=match[1] or match[2]
        values.append({**value("价格", float(shown), "CNY", "observed", "phone_screen", stamp), "display": shown})
    for match in re.finditer(r"(\d+(?:\.\d+)?)\s*分钟", screen):
        values.append({**value("预计时间", float(match[1]), "min", "observed", "phone_screen", stamp), "display":match[1]})
    for match in re.finditer(r"订单(?:编号|号)\s*[:：]?\s*([A-Za-z0-9-]+)", screen):
        values.append(value("订单号", match[1], "none", "observed", "phone_screen", stamp))
    payment = record.get("payment_reconciliation", {}).get("state") or record.get("payment_outcome")
    if record.get("payment_reconciliation", {}).get("state") in {"paid", "unpaid"}:
        values.append(value("付款状态", payment, "none", "observed", "bound_order_screen", stamp))
    if record.get("payment_outcome") == "paid":
        effects.append(effect("spend", target, "付款", "verified", "原订单收银台回读确认已支付"))
    if payment == "unknown" or record.get("payment_intent") and not payment:
        unknowns.append(unknown_fact("payment_state", "付款结果尚未按原订单核对"))
        state = "unknown"
    if record.get('error_code') == 'PAYMENT_LINEAGE_OWNER_CHECK_REQUIRED':
        state = 'waiting'
        unknowns.append(unknown_fact('payment_state', '付款结果尚未核实，需要主人核对原订单'))
    if state == "unknown":
        unknowns.append(unknown_fact("outcome", str(reason or "没有可核验的执行结果")))
    for text in record.get("partial_findings", {}).get("not_verified", []):
        unknowns.append(unknown_fact("effect", text))
    if state == "succeeded" and any(f["verification"] not in {"verified", "service_ack"} for f in effects):
        state = "partial" if any(f["verification"] in {"verified", "service_ack"} for f in effects) else "unknown"
        unknowns.append(unknown_fact("effect", "部分影响缺少核验证据"))
    # Agent completion alone does not prove a mutation. The evidence can still contain useful observed values.
    if state == "succeeded" and record.get("task_type") not in {"read", "read_app", "status"} and not effects:
        state = "unknown"
        unknowns.append(unknown_fact("effect", "执行器摘要不是独立的屏幕回读或服务确认"))
    retry = "after_check" if state in {"unknown", "partial", "failed"} else "forbidden"
    if record.get("status") == "rejected":
        retry = "forbidden"
    waiting = "owner" if owner_wait else "external" if state in {"accepted", "running"} else "none"
    return receipt(state, status={**({"reason_code": str(reason)} if reason else {}),
        **({"progress": {"done": record["step"], "total": record["max_steps"], "unit": "step"}}
           if "step" in record and "max_steps" in record else {}),
        **({"started_at": record["started_at"]} if record.get("started_at") else {}),
        **({"ended_at": record["finished_at"]} if record.get("finished_at") else {})},
        effects=effects, values=values, content=content, unknowns=unknowns,
        next={"retry": retry, "check_with": "phone_check" if retry == "after_check" else CHECK,
              "waiting_on": waiting},
        job={"id": job_id, "revision": revision} if job_id else None)


def stamp(job_id, record, running=None):
    """Advance only when the executor publishes a new snapshot; re-reading it is idempotent."""
    revision = max(record.get("receipt_revision", 0), (running or {}).get("receipt_revision", 0)) + 1
    record["receipt_revision"] = revision
    if running is not None:
        running["receipt_revision"] = revision
        record["task_type"] = running.get("task_type", "phone_operation")
    record["capability_receipt"] = project(record, job_id=job_id, revision=revision)
    if running is not None:
        running["capability_receipt"] = record["capability_receipt"]


def result(body):
    return to_mcp_result(body)
