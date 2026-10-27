"""Offline contracts exercise the same projection and transport in real and fake hosts."""
import asyncio
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from capability.packages.phone.server import receipts
from capability.packages.phone.server import host
import yaml
from jsonschema import Draft202012Validator, FormatChecker

PACKAGE = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "capability/contracts/receipt.v1.schema.json").read_text())


class Contract(unittest.TestCase):
    def test_unknown_payment_requiring_owner_check_remains_unknown_on_a_waiting_card(self):
        body = receipts.project({'success': False, 'error_code': 'PAYMENT_LINEAGE_OWNER_CHECK_REQUIRED',
            'payment_intent': 'pi-fixture', 'payment_outcome': 'unknown'}, job_id='job-0123456789ab', revision=3)
        self.assertEqual(body['status']['state'], 'waiting')
        self.assertEqual(body['next']['waiting_on'], 'owner')
        self.assertEqual(body['next']['check_with'], 'phone_status')
        self.assertTrue(any(fact['about'] == 'payment_state' for fact in body['unknowns']))
        self.assertEqual(body['effects'], [])

    def test_receipt_result_shapes(self):
        for fixture in yaml.safe_load((PACKAGE / "tests/contract.yaml").read_text())["fixtures"]:
            with self.subTest(fixture=fixture["id"]):
                body = receipts.project(fixture["input"], job_id="job-0123456789ab", revision=1)
                Draft202012Validator(SCHEMA, format_checker=FormatChecker()).validate(body)
                self.assertEqual(body["status"]["state"], fixture["state"])
                result = receipts.result(body)
                self.assertEqual(len(result["content"]), 1)
                self.assertEqual(result["structuredContent"], body)
                if fixture["state"] == "unknown":
                    self.assertEqual(body["next"]["retry"], "after_check")
                    self.assertEqual(body["next"]["check_with"], "phone_check")
                if fixture["id"] == "empty_status":
                    self.assertNotIn("job", body)

    def test_manifest_and_adapter_limits(self):
        manifest = json.loads((PACKAGE / "plugin.json").read_text())
        for name, value in [("manifest.v1.schema.json", manifest["extensions"]["ai.yimi.capability"]),
                            ("upstream/plugin-1.0.0.schema.json", manifest)]:
            Draft202012Validator(json.loads((ROOT / "capability/contracts" / name).read_text())).validate(value)
        for module in manifest["extensions"]["ai.yimi.capability"]["provenance"]["adapter_modules"]:
            self.assertLessEqual(len((PACKAGE / module).read_text().splitlines()), 200, module)

    def test_screen_values_are_exact_and_payment_private(self):
        record = {"success": True, "task_type": "read_app", "partial_findings": {
            "last_screen_text": "￥16.60，预计23分钟。订单号：20261024001"}}
        body = receipts.project(record, job_id="job-0123456789ab", revision=1)
        self.assertEqual([(v["value"], v["unit"]) for v in body["values"]],
                         [(16.6, "CNY"), (23, "min"), ("20261024001", "none")])
        self.assertEqual(body["values"][0]["display"], "16.60")
        for v in body["values"]:
            self.assertEqual(v["provenance"], "observed")
            self.assertTrue(v["as_of"])
        record["payment_intent"] = "pi-private"
        private = receipts.project(record, job_id="job-0123456789ab", revision=2)
        self.assertEqual(private["values"], [])

    def test_spool_revisions_survive_terminal_and_restart(self):
        job = {}
        running = {"state": "running", "job_id": "job-0123456789ab"}
        receipts.stamp(running["job_id"], running, job)
        first = running["capability_receipt"]["job"]["revision"]
        receipts.stamp(running["job_id"], running, job)
        second = running["capability_receipt"]["job"]["revision"]
        recovered = json.loads(json.dumps(running))
        recovered.update(success=False, terminal_reason="interrupted")
        receipts.stamp(running["job_id"], recovered)
        self.assertLess(first, second)
        self.assertLess(second, recovered["capability_receipt"]["job"]["revision"])
        self.assertEqual(recovered["capability_receipt"]["status"]["state"], "unknown")


class Host(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for p in (patch.object(host.executor, "SPOOL", self.tmp.name), patch.object(host.executor, "_jobs", {}),
                  patch.object(host.executor, "PHONE_PROVIDER", "fake"), patch.object(host.executor, "_online", lambda: True)):
            p.start()
            self.addCleanup(p.stop)

    async def test_empty_and_list_status_are_successful_queries_without_execution_jobs(self):
        jobs = [{"job_id": "job-0123456789ab", "success": False},
                {"job_id": "job-ffffffffffff", "state": "running"}]
        for observed in ([], jobs[:1], jobs):
            with self.subTest(jobs=observed), patch.object(host.executor, "phone_status", AsyncMock(return_value={"jobs": observed})):
                body = (await host.phone_status("owner")).structuredContent
                Draft202012Validator(SCHEMA).validate(body)
                self.assertEqual(body["status"]["state"], "succeeded")
                self.assertNotIn("job", body)
                self.assertEqual([job["job"]["id"] for job in body["jobs"]], [job["job_id"] for job in observed])

    async def test_status_never_starts_a_check_and_check_has_a_declared_bound_identity(self):
        owner = {"principal_id": "owner", "app": "千问", "of_job": "job-0123456789ab", "intent_id": "pi-unknown"}
        with patch.object(host.payment, "unresolved", return_value=owner), \
             patch.object(host.payment, "start_check") as start, \
             patch.object(host.executor, "phone_status", AsyncMock(return_value={"jobs": []})):
            body = (await host.phone_status("owner", owner["of_job"])).structuredContent
            self.assertEqual(body["status"]["state"], "unknown")
            self.assertEqual(body["next"]["retry"], "allowed")
            self.assertNotIn("job", body)
            start.assert_not_called()
        query, check = host.MANIFEST["tools"]["phone_status"], host.MANIFEST["tools"]["phone_check"]
        self.assertFalse(query.get("long_running", False))
        self.assertNotIn("check_job_id", query["context_inject"])
        self.assertTrue(check["long_running"])
        self.assertEqual(check["target"], "$.job_id")
        self.assertIn("check_job_id", check["context_inject"])
        self.assertNotIn("job_id", check["context_inject"])

    async def test_check_returns_the_real_platform_job_and_status_resolves_its_terminal_receipt(self):
        original, checked = "job-0123456789ab", "job-ffffffffffff"
        Path(self.tmp.name, original + ".delivered.json").write_text(json.dumps({
            "job_id": original, "principal_id": "owner", "app": "千问", "task": "synthetic order",
            "payment_intent": "pi-fixture", "phone_started_at": "2026-10-24T01:00:00Z", "payment_outcome": "unknown",
            "finished_at": "2026-10-24T01:00:01.000Z", "success": False, "answer": "unknown"}))
        async def check(executor, task):
            self.assertEqual(task["check_owner"]["of_job"], original)
            return {"success": True, "payment_observation": {"state": "unpaid"}, "answer": "synthetic read"}
        with patch.object(host.payment, "check_order", side_effect=check) as read:
            first = (await host.phone_check("owner", original, check_job_id=checked,
                                           origin_processed_event_id="d:trusted")).structuredContent
            self.assertEqual(first["job"]["id"], checked)
            self.assertTrue(Path(self.tmp.name, checked + ".running.json").exists())
            await host.executor._jobs[checked]["task"]
            final = (await host.phone_status("owner", checked)).structuredContent
            self.assertEqual(final["status"]["state"], "succeeded")
            self.assertEqual(final["job"]["id"], checked)
            self.assertGreater(final["job"]["revision"], first["job"]["revision"])
            self.assertIsNone(host.payment.unresolved(host.executor, "owner"))
            repeated = (await host.phone_check("owner", original)).structuredContent
            self.assertEqual(repeated, final)
            read.assert_called_once()

    async def test_all_declared_tools_and_no_effect_parameter(self):
        tools = await host.mcp.list_tools()
        self.assertEqual({t.name for t in tools}, set(host.MANIFEST["tools"]))
        self.assertEqual(len(tools), 9)
        for t in tools:
            self.assertNotIn("effect", t.inputSchema["properties"])

    async def test_real_job_start_progress_done_and_status(self):
        release = asyncio.Event()
        async def task(**args):
            await release.wait()
            return {"success": True, "answer": "read", "observed_values": [
                {"key": "价格", "value": "16.60", "unit": "CNY", "source": "screen", "provenance": "observed"}]}
        with patch.object(host.executor, "_errand_task", task):
            started = await host.phone_task("读取价格", "read_app", principal_id="owner", owner_requested=True)
            first = started.structuredContent
            jid = first["job"]["id"]
            host.executor._jobs[jid]["state"] = "running"
            host.executor._write_running(jid, force=True)
            progress = (await host.phone_status("owner", jid)).structuredContent
            self.assertEqual(progress["status"]["state"], "running")
            self.assertGreater(progress["job"]["revision"], first["job"]["revision"])
            work = host.executor._jobs[jid]["task"]
            release.set()
            await work
            final = (await host.phone_status("owner", jid)).structuredContent
            self.assertEqual(final["status"]["state"], "succeeded")
            self.assertGreater(final["job"]["revision"], progress["job"]["revision"])
            self.assertEqual(final["values"][0]["value"], "16.60")
            self.assertEqual((await host.phone_status("other", jid)).structuredContent.get("jobs"), [])

    async def test_unknown_payment_blocks_every_mutation_before_driver(self):
        owner = {"principal_id": "owner", "app": "千问", "of_job": "job-0123456789ab", "intent_id": "pi-unknown"}
        with patch.object(host.payment, "unresolved", return_value=owner):
            for name in ("phone_task", "phone_start", "phone_restore_apps", "phone_save_apps", "phone_close"):
                with self.subTest(tool=name), patch.object(host.executor, name, AsyncMock()) as call:
                    result = await host.invoke(name, {"principal_id": "owner"})
                    self.assertEqual(result.structuredContent["status"]["state"], "unknown")
                    self.assertEqual(result.structuredContent["next"]["waiting_detail"], owner["of_job"])
                    call.assert_not_called()

    async def test_disconnect_is_unknown(self):
        with patch.object(host.executor, "phone_status", AsyncMock(side_effect=ConnectionError)):
            result = await host.phone_status("owner")
        self.assertEqual(result.structuredContent["status"]["state"], "unknown")
        self.assertEqual(result.structuredContent["next"]["retry"], "allowed")
        self.assertNotIn("job", result.structuredContent)

    async def test_missing_runtime_resource_is_unknown_with_the_local_cause(self):
        with patch.object(host.executor, "_errand_task", AsyncMock(side_effect=FileNotFoundError("fixture prompt"))):
            first = await host.phone_task("读取页面", "read", principal_id="owner")
            jid = first.structuredContent['job']['id']
            await host.executor._jobs[jid]['task']
            result = (await host.phone_status("owner", jid)).structuredContent
        self.assertEqual(result['status']['state'], 'unknown')
        self.assertEqual(result['status']['reason_code'], 'PHONE_LOCAL_RESOURCE_UNAVAILABLE')
        self.assertEqual(result['next']['retry'], 'after_check')

    async def test_unreadable_lineage_cannot_block_reading_an_existing_job(self):
        jid = "job-0123456789ab"
        Path(self.tmp.name, jid + ".invalid.json").write_text("{}")
        body = receipts.receipt("failed", job={"id": jid, "revision": 7})
        with patch.object(host.executor, "phone_status", AsyncMock(return_value={
                "jobs": [{"job_id": jid, "capability_receipt": body}]})) as read, \
             patch.object(host.payment, "start_check") as start:
            result = await host.phone_status("owner", jid)
        self.assertEqual(result.structuredContent, body)
        read.assert_awaited_once_with(principal_id="owner", job_id=jid, context=None)
        start.assert_not_called()

    async def test_lineage_io_failure_does_not_prevent_status_or_start_work(self):
        with patch.object(host.payment, "unresolved", side_effect=OSError("fixture unavailable")), \
             patch.object(host.executor, "phone_status", AsyncMock(return_value={"jobs": []})) as read, \
             patch.object(host.payment, "start_check") as start:
            await host.phone_status("owner")
        read.assert_awaited_once()
        start.assert_not_called()

    async def test_cancel_is_principal_scoped(self):
        host.executor._jobs.update({"job-0123456789ab": {"principal_id": "other", "state": "running"}})
        with patch.object(host.executor, "phone_cancel", AsyncMock()) as cancel, \
             patch.object(host.payment, "unresolved", side_effect=ValueError("unreadable")):
            await host.phone_cancel("owner", "job-0123456789ab")
        cancel.assert_not_called()

    async def test_pending_cancel_keeps_the_original_job_snapshot(self):
        jid = "job-0123456789ab"
        body = receipts.receipt("running", job={"id": jid, "revision": 4})
        host.executor._jobs[jid] = {"principal_id": "owner", "state": "stopping", "capability_receipt": body}
        with patch.object(host.executor, "phone_cancel", AsyncMock()):
            result = await host.phone_cancel("owner", jid)
        self.assertEqual(result.structuredContent["job"], {"id": jid, "revision": 4})
        self.assertEqual(result.structuredContent["status"]["state"], "running")

    async def test_queued_operation_rechecks_payment_under_the_phone_lease(self):
        record = {"job_id": "job-0123456789ab", "principal_id": "owner", "app": "千问",
                  "payment_intent": "pi-unknown", "phone_started_at": "2026-10-24T01:00:00Z", "payment_outcome": "unknown",
                  "finished_at": "2026-10-24T01:00:01.000Z", "task": "synthetic order", "success": False,
                  "answer": "unknown", "delivery_failure": {"error_code": "REPORT_FAILED"}}
        Path(self.tmp.name, record["job_id"] + ".delivered.json").write_text(json.dumps(record))
        job = {"principal_id": "owner", "goal": "下一项操作", "app": "淘宝", "state": "waiting", "tier": "fast"}
        host.executor._jobs["job-ffffffffffff"] = job
        token = host.executor._job_id.set("job-ffffffffffff")
        @contextlib.asynccontextmanager
        async def lease(*args):
            yield
        try:
            with patch.object(host.executor, "_device_lease", lease), patch.object(host.executor, "_online") as online:
                with self.assertRaises(host.payment.OrderCheckRequired):
                    async with host.executor._errand(None, None):
                        self.fail("an unknown payment reached the phone")
                online.assert_not_called()
        finally:
            host.executor._job_id.reset(token)

    async def test_targeted_payment_check_reads_only_the_bound_order_without_an_agent(self):
        owner = {"principal_id": "owner", "app": "千问", "of_job": "job-0123456789ab", "intent_id": "pi-unknown",
                 "binding": {"order_id": "private-order", "payee": "fixture", "amount_fen": 1660,
                             "order_namespace": "fixture", "item_identity": [["item", "fixture"]]}}
        host.executor._jobs["job-ffffffffffff"] = {"payment_owner": owner}
        token = host.executor._job_id.set("job-ffffffffffff")
        @contextlib.asynccontextmanager
        async def lease(*args, **kwargs):
            yield
        screen = SimpleNamespace(reconciliation=lambda bound: {"state": "unpaid" if bound.order_id == "private-order" else "unknown"})
        try:
            with patch.object(host.executor, "_errand", lease), patch.object(host.executor, "_driver", AsyncMock()), \
                 patch.object(host.executor, "_payment_screen", AsyncMock(return_value=screen)), \
                 patch.object(host.executor, "_agent", AsyncMock()) as agent:
                result = await host.payment.check_order(host.executor, {"check_owner": owner})
                self.assertEqual(result["payment_observation"], {"state": "unpaid"})
                agent.assert_not_called()
        finally:
            host.executor._job_id.reset(token)

    async def test_report_retirement_cannot_erase_an_unknown_payment(self):
        record = {"job_id": "job-0123456789ab", "principal_id": "owner", "app": "千问",
                  "payment_intent": "pi-unknown", "phone_started_at": "2026-10-24T01:00:00Z", "payment_outcome": "unknown",
                  "finished_at": "2026-10-24T01:00:01.000Z", "task": "synthetic order", "success": False,
                  "answer": "unknown", "delivery_failure": {"error_code": "REPORT_FAILED"}}
        for state in ("done", "notified", "delivered", "delivery-failed", "invalid"):
            path = Path(self.tmp.name, record["job_id"] + "." + state + ".json")
            path.write_text(json.dumps(record))
            self.assertEqual(host.payment.unresolved(host.executor, "owner")["of_job"], record["job_id"])
            path.unlink()

    async def test_unreadable_retired_spool_does_not_become_a_failed_payment_or_allow_a_new_operation(self):
        Path(self.tmp.name, "job-0123456789ab.invalid.json").write_text("{")
        with patch.object(host.executor, "phone_start", AsyncMock()) as start:
            result = await host.phone_start("owner")
            self.assertEqual(result.structuredContent["status"]["state"], "waiting")
            self.assertEqual(result.structuredContent["next"]["waiting_on"], "owner")
            self.assertEqual(result.structuredContent["next"]["retry"], "after_check")
            start.assert_not_called()

    async def test_malformed_nonpayment_quarantine_follows_the_lineage_authority(self):
        Path(self.tmp.name, "job-0123456789ab.invalid.json").write_text(json.dumps({
            'principal_id': 'owner', 'job_id': 'job-0123456789ab', 'app': '千问',
            'answer': 'synthetic failed read', 'payment_owner': None, 'phone_started_at': None}))
        self.assertIsNone(host.payment.unresolved(host.executor, 'owner'))

    async def test_possible_payment_quarantine_requests_one_stable_owner_check_without_execution(self):
        jid = 'job-0123456789ab'
        Path(self.tmp.name, jid + '.invalid.json').write_text(json.dumps({
            'principal_id': 'owner', 'job_id': jid, 'payment_intent': 'pi-fixture'}))
        with patch.object(host.executor, 'phone_start', AsyncMock()) as start:
            first = (await host.phone_start('owner')).structuredContent
            second = (await host.phone_start('owner')).structuredContent
        self.assertEqual(first, second)
        self.assertEqual(first['status']['state'], 'waiting')
        self.assertEqual(first['next']['waiting_on'], 'owner')
        self.assertEqual(first['effects'], [])
        self.assertEqual(first['next']['retry'], 'after_check')
        start.assert_not_called()
        with patch.object(host.executor, 'phone_status', AsyncMock(return_value={'jobs': []})) as read:
            await host.phone_status('owner', jid)
        read.assert_awaited_once()

    async def test_malformed_present_payment_intent_is_not_proof_of_no_payment(self):
        path = Path(self.tmp.name, 'job-0123456789ab.invalid.json')
        for intent in [None, '', False, 0, [], {}]:
            with self.subTest(intent=intent):
                path.write_text(json.dumps({'payment_intent': intent}))
                with patch.object(host.executor, 'phone_start', AsyncMock()) as start:
                    body = (await host.phone_start('owner')).structuredContent
                self.assertEqual(body['status']['state'], 'waiting')
                self.assertEqual(body['next']['waiting_on'], 'owner')
                start.assert_not_called()

    async def test_payment_check_cannot_create_an_unbound_executor_job(self):
        owner = {"principal_id": "owner", "app": "千问", "of_job": "job-0123456789ab", "intent_id": "pi-unknown"}
        with patch.object(host.payment, "unresolved", return_value=owner), patch.object(host.executor, "_start") as start:
            result = await host.phone_check("owner", owner["of_job"])
            self.assertEqual(result.structuredContent["status"]["reason_code"], "PAYMENT_CHECK_BINDING_REQUIRED")
            start.assert_not_called()

    async def test_payment_check_uses_platform_job_origin_and_selfcheck_lineage(self):
        owner = {"principal_id": "owner", "app": "千问", "of_job": "job-0123456789ab", "intent_id": "pi-unknown"}
        jid = "job-ffffffffffff"
        def create(job, *args):
            host.executor._jobs[job] = {}
        with patch.object(host.executor, "_same_errand", return_value=None), \
             patch.object(host.executor, "_start", side_effect=create) as start, \
             patch.object(host.executor, "_write_running"):
            self.assertEqual(host.payment.start_check(host.executor, owner, jid, "d:trusted", self_check_of="source:0"), jid)
        self.assertEqual(start.call_args.args[3:], ("owner", "d:trusted", "source:0"))


if __name__ == "__main__":
    unittest.main()
