"""Unknown payments permit only a targeted screen check, never a new phone operation."""
import asyncio
import hashlib
import json
from pathlib import Path


class OrderCheckRequired(RuntimeError):
    code = "PAYMENT_ORDER_CHECK_REQUIRED"


class OwnerCheckRequired(ValueError):
    code = "PAYMENT_LINEAGE_OWNER_CHECK_REQUIRED"

    def __init__(self, path):
        self.source_job = path.name.split('.')[0]
        super().__init__(self.code)


def owner_check(principal_id, error):
    from . import receipts
    identity = hashlib.sha256((principal_id + ':' + error.source_job).encode()).hexdigest()[:12]
    return receipts.receipt('waiting', status={'reason_code': error.code},
        unknowns=[receipts.unknown_fact('payment_state', '付款结果尚未核实，需要主人核对原订单')],
        next={'retry': 'after_check', 'check_with': 'phone_status', 'waiting_on': 'owner',
              'waiting_detail': '请在执行手机核对原订单付款状态；核对清楚前不会继续操作'},
        job={'id': 'job-' + identity, 'revision': 1})


def before_operation(executor, job):
    if job.get("tier") != "payment_check" and unresolved(executor, job["principal_id"]):
        raise OrderCheckRequired("付款结果未知，必须先只读核对原订单。")


def unresolved(executor, principal_id):
    import payment_lineage
    if not executor.SPOOL:
        return None
    apps = set()
    for path in Path(executor.SPOOL).glob("job-*.json"):
        if path.suffixes[-2:] not in [["." + state, ".json"] for state in payment_lineage._SPOOL_STATES]:
            continue
        try:
            record = payment_lineage._read_spool_job(path)
        except (ValueError, OSError):
            raise OwnerCheckRequired(path) from None
        if record is None:
            try:
                quarantine = json.loads(path.read_text())
            except (ValueError, OSError):
                raise OwnerCheckRequired(path) from None
            if isinstance(quarantine, dict) and 'payment_intent' not in quarantine:
                continue  # This ignored quarantine cannot establish or clear canonical ownership.
            raise OwnerCheckRequired(path)
        if not isinstance(record, dict) or not record.get("principal_id"):
            raise OwnerCheckRequired(path)
        if record.get("principal_id") == principal_id:
            apps.add(record.get("app"))
    for app in sorted(apps, key=lambda item: item or ""):
        if owner := payment_lineage.unresolved(executor.SPOOL, principal_id, app):
            return owner
    return None


async def check_order(executor, task):
    import payment_lineage
    from payment_checkpoint import PaymentError
    job = executor._jobs[executor._job_id.get()]
    observation = {"state": "unknown"}
    mac_binding = None
    if executor.PHONE_PROVIDER == "mac-android":
        mac_binding, _ = await asyncio.to_thread(executor.mac_android.request, task.get("context"))
    async with executor._errand(None, None, continuation=True, mac_binding=mac_binding):
        owner = job["payment_owner"]
        bound = payment_lineage.binding(owner)
        if owner == task["check_owner"] and bound:
            driver = await executor._driver()
            observer = executor.CheckoutStop(driver)
            try:
                observation = (await executor._payment_screen(observer)).reconciliation(bound)
            except PaymentError:
                pass
    return {"success": observation["state"] in {"paid", "unpaid"},
            "payment_observation": observation,
            "answer": "原订单付款核对：" + observation["state"]}


def start_check(executor, owner, check_job_id, origin_processed_event_id, context=None, self_check_of=None):
    for jid, job in executor._jobs.items():
        if job.get("tier") == "payment_check" and job.get("payment_owner") == owner:
            return jid
    jid = check_job_id
    task = {"goal": "从当前页面继续：只读核对原订单付款状态", "app": owner["app"],
            "tier": "payment_check", "max_steps": 1, "payment_check": True,"check_owner":owner,"context":context}
    if executor._same_errand(task["goal"], owner["app"], owner["principal_id"], job_id=jid) is not None:
        return jid
    executor._start(jid, task, "核对原订单付款状态", owner["principal_id"], origin_processed_event_id, self_check_of)
    executor._jobs[jid]["task_type"] = "read_app"
    executor._write_running(jid, force=True)
    return jid


async def status_check(executor, owner, args):
    from . import receipts
    job_id = args["job_id"]
    if owner and job_id == owner["of_job"]:
        if not args.get("check_job_id") or not args.get("origin_processed_event_id"):
            return {"capability_receipt": receipts.receipt("unknown", status={"reason_code": "PAYMENT_CHECK_BINDING_REQUIRED"},
                unknowns=[receipts.unknown_fact("payment_state", "原订单核对需要平台绑定的任务来源")],
                next={"retry": "after_check", "check_with": "phone_check", "waiting_on": "none"},
                job={"id": job_id, "revision": 1})}
        job_id = start_check(executor, owner, args["check_job_id"], args["origin_processed_event_id"],
                             args.get("context"), args.get("self_check_of"))
    elif executor.SPOOL:
        import payment_lineage
        records = (payment_lineage._read_spool_job(path) for state in payment_lineage._SPOOL_STATES
                   for path in Path(executor.SPOOL).glob(f"job-*.{state}.json"))
        checked = max((record for record in records if record and record.get("principal_id") == args["principal_id"]
                       and record.get("payment_reconciliation", {}).get("of_job") == job_id
                       and record["payment_reconciliation"]["state"] in {"paid", "unpaid"} and record.get("finished_at")),
                      key=lambda record: record["finished_at"], default=None)
        if checked:
            job_id = checked["job_id"]
    status = await executor.phone_status(principal_id=args["principal_id"], job_id=job_id, context=args.get("context"))
    if not status["jobs"]:
        return {"capability_receipt": receipts.receipt("unknown",
            unknowns=[receipts.unknown_fact("outcome", "未找到可核验的原任务或核对结果")],
            next={"retry": "after_check", "check_with": "phone_status", "waiting_on": "none"})}
    return status
