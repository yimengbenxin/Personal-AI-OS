"""Package tools wrap the existing executor; no action/consent authority lives here."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
from typing import Literal

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "integrations/connectors/phone_executor"))
import server as executor
from capability.packages.phone.server import payment, receipts
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult

MANIFEST = json.loads(Path(__file__).resolve().parents[1].joinpath("plugin.json").read_text())["extensions"]["ai.yimi.capability"]
executor._receipt_stamp = receipts.stamp
executor._payment_check = lambda task: payment.check_order(executor, task)
executor._before_phone_operation = lambda job: payment.before_operation(executor, job)
mcp = FastMCP("phone", lifespan=executor._lifespan)


def output(body):
    return CallToolResult.model_validate(receipts.result(body))


def snapshot(raw, job_id=None):
    if "jobs" in raw:
        return receipts.project(raw, job_id=None, revision=1)
    if raw.get("capability_receipt"):
        return raw["capability_receipt"]
    return receipts.project(raw, job_id=job_id or raw.get("job_id"),
                            revision=raw.get("receipt_revision", 1))


async def invoke(name, args):
    principal = args.get("principal_id", "")
    if not principal:
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    try:
        try:
            owner = None if name == "phone_cancel" else payment.unresolved(executor, principal)
        except payment.OwnerCheckRequired as exc:
            if name != "phone_status":
                return output(payment.owner_check(principal, exc))
            owner = None
        except (ValueError, AttributeError, OSError):
            if name != "phone_status":
                return output(receipts.receipt("unknown", status={"reason_code": "PAYMENT_LINEAGE_UNREADABLE"},
                    unknowns=[receipts.unknown_fact("payment_state", "付款来源记录无法核验")],
                    next={"retry": "after_check", "check_with": "phone_check", "waiting_on": "none"}))
            owner = None  # Reading a snapshot cannot start a reconciliation without readable ownership.
        if owner and name not in {"phone_status", "phone_check", "phone_control_link", "phone_cancel"}:
            return output(receipts.receipt("unknown", status={"reason_code": "PAYMENT_ORDER_CHECK_REQUIRED"},
                unknowns=[receipts.unknown_fact("payment_state", "必须先核对原订单")],
                next={"retry": "after_check", "check_with": "phone_check", "waiting_on": "none",
                      "waiting_detail": owner["of_job"]}, job={"id": owner["of_job"], "revision": 1}))
        if name == "phone_cancel":
            # The legacy stop wire has no principal. Narrow its targets before calling it.
            targets = [jid for jid, job in executor._jobs.items() if job["principal_id"] == principal and
                       (args.get("job_id") == jid or args.get("job_id") is None and job["state"] in {"running", "stopping"})]
            for jid in targets:
                await executor.phone_cancel(jid)
            if len(targets) == 1:
                jid = targets[0]
                raw = executor._jobs.get(jid)
                if raw is None:
                    raw = (await executor.phone_status(principal_id=principal, job_id=jid))["jobs"][0]
                return output(snapshot(raw, jid))
            body = snapshot({"jobs": []}) if targets else snapshot({"success": True, "task_type": "status", "status": "ready"})
            body["values"] = [receipts.value("任务", jid, "none", "observed", "executor_spool", receipts.now()) for jid in targets]
            return output(body)
        kind = None
        if name == "phone_task":
            task_type = args.pop("task_type")
            declared = MANIFEST["tools"][name]["effect_by_arg"]["$.task_type"][task_type]
            kind = {"observe": "read", "physical": "external", "send": "send", "account": "login",
                    "owner_data": "file_edit", "delete": "delete", "spend": "external"}[declared]
            # Legacy validation only; the gateway has already consumed owner_requested and made the decision.
            args["effect"] = {"kind": kind, "task_type": task_type, "requested": False,
                              **({"recipient": args.pop("recipient")} if kind == "send" else {})}
            args.pop("recipient", None)
        raw = await payment.status_check(executor, owner, args) if name == "phone_check" else await getattr(executor, name)(**args)
        jid = raw.get("job_id")
        if jid in executor._jobs:
            executor._jobs[jid]["effect_kind"] = declared if kind is not None else MANIFEST["tools"][name]["effect"]
            if kind is not None:
                executor._jobs[jid]["task_type"] = task_type
                executor._write_running(jid, force=True)
            return output(snapshot(executor._jobs[jid], jid))
        if jid or "jobs" in raw or name in {"phone_status", "phone_control_link"}:
            status = raw if "jobs" in raw else await executor.phone_status(principal_id=principal, job_id=jid)
            jobs = status.get("jobs", [])
            if len(jobs) == 1 and args.get("job_id") and name != "phone_control_link":
                return output(snapshot(jobs[0], jobs[0]["job_id"]))
            body = (receipts.receipt("unknown", unknowns=[receipts.unknown_fact("outcome", "尚未找到指定任务的可核验回执")],
                    next={"retry": "allowed", "check_with": "phone_check", "waiting_on": "none"})
                    if name == "phone_status" and args.get("job_id") and not jobs else snapshot({"jobs": []}))
            body["jobs"] = [snapshot(job, job["job_id"]) for job in jobs]
            body["values"] = [receipts.value("任务", job["job_id"], "none", "observed", "executor_spool", receipts.now()) for job in jobs]
            for key in ("provider", "status", "state", "stage", "view_url", "summary", "control_url", "control_link", "control_links", "resource_url", "answer", "phase"):
                if key in status:
                    body["content"].append({"key": key, "text": str(status[key]), "provenance": "observed"})
            return output(body)
        if raw.get("status") == "ready" and MANIFEST["tools"][name].get("effect"):
            raw["effect_evidence"] = [{"kind": MANIFEST["tools"][name]["effect"], "action": "启动设备",
                "target": "执行手机", "verification": "service_ack", "evidence": "设备服务确认 ready", "ref": None}]
        if executor.SPOOL and raw.get("answer"):
            raw["observed_content"] = [{"key": "诊断", "text": raw["answer"], "provenance": "observed"}]
        return output(snapshot(raw))
    except (FileNotFoundError, PermissionError):
        return output(receipts.receipt("unknown", status={"reason_code": "PHONE_LOCAL_RESOURCE_UNAVAILABLE"},
            unknowns=[receipts.unknown_fact("outcome", "执行器本地配置或资源不可用，尚未核实执行结果")],
            next={"retry": "allowed" if name == "phone_status" else "after_check",
                  "check_with": "phone_status" if name == "phone_status" else "phone_check", "waiting_on": "none"}))
    except (TimeoutError, ConnectionError, OSError):
        return output(receipts.receipt("unknown", status={"reason_code": "PHONE_DISCONNECTED"},
            unknowns=[receipts.unknown_fact("outcome", "连接中断，不能证明操作失败")],
            next={"retry": "allowed" if name == "phone_status" else "after_check",
                  "check_with": "phone_status" if name == "phone_status" else "phone_check", "waiting_on": "none"}))
    except ValueError:
        return output(receipts.receipt("failed", status={"reason_code": "PHONE_INPUT_INVALID"},
            next={"retry": "forbidden", "check_with": "phone_status", "waiting_on": "none"}))


@mcp.tool()
async def phone_task(goal: str, task_type: Literal["read", "read_app", "purchase_errand", "ride_request", "send_message", "wechat_message", "send_file", "login", "file_edit", "delete", "pay_order"],
                     owner_requested: bool = False, recipient: str = "", max_steps: int = 80,
                     latitude: float | None = None, longitude: float | None = None,
                     payment_intent: str | None = None, app: str | None = None, tier: str = "fast",
                     ride_ok: bool = False, title: str = "", repeat: bool = False, principal_id: str = "",
                     job_id: str | None = None, origin_processed_event_id: str | None = None,
                     context: dict | None = None, self_check_of: str | None = None) -> CallToolResult:
    """在执行手机办理一项任务。发送填写实际 recipient；付款仍需逐次 payment_intent，叫车仍需 ride_ok。"""
    return await invoke("phone_task", {k: v for k, v in locals().items() if k != "owner_requested"})


@mcp.tool()
async def phone_status(principal_id: str, job_id: str | None = None, context: dict | None = None) -> CallToolResult:
    """读取本人已有的任务回执，不启动任务。"""
    return await invoke("phone_status", locals())


@mcp.tool()
async def phone_check(principal_id: str, job_id: str, context: dict | None = None, check_job_id: str | None = None,
                      origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> CallToolResult:
    """只读核对原任务的订单付款状态；再次查询原任务沿用已有核对结果，核对任务可用 phone_status 读取。"""
    return await invoke("phone_check", locals())


@mcp.tool()
async def phone_control_link(principal_id: str, context: dict | None = None) -> CallToolResult:
    """读取本人的云手机控制链接。"""
    return await invoke("phone_control_link", locals())


@mcp.tool()
async def phone_start(principal_id: str, purpose: str = "login", owner_requested: bool = False,
                      job_id: str | None = None, context: dict | None = None,
                      origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> CallToolResult:
    """后台启动执行手机。"""
    return await invoke("phone_start", {k: v for k, v in locals().items() if k != "owner_requested"})


@mcp.tool()
async def phone_restore_apps(apps: list[str], principal_id: str, owner_requested: bool = False,
                             job_id: str | None = None, origin_processed_event_id: str | None = None,
                             self_check_of: str | None = None) -> CallToolResult:
    """恢复本次指定 App 的已保存数据。"""
    return await invoke("phone_restore_apps", {k: v for k, v in locals().items() if k != "owner_requested"})


@mcp.tool()
async def phone_save_apps(apps: list[str], principal_id: str, owner_requested: bool = False,
                          job_id: str | None = None, origin_processed_event_id: str | None = None,
                          self_check_of: str | None = None) -> CallToolResult:
    """保存主人已完成登录的指定 App。"""
    return await invoke("phone_save_apps", {k: v for k, v in locals().items() if k != "owner_requested"})


@mcp.tool()
async def phone_close(principal_id: str, owner_requested: bool = False, job_id: str | None = None,
                      origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> CallToolResult:
    """关闭云手机，不自动保存。"""
    return await invoke("phone_close", {k: v for k, v in locals().items() if k != "owner_requested"})


@mcp.tool()
async def phone_cancel(principal_id: str, job_id: str | None = None, owner_requested: bool = False) -> CallToolResult:
    """停止本人的任务，已经发生的影响不因此撤销。"""
    return await invoke("phone_cancel", {k: v for k, v in locals().items() if k != "owner_requested"})
