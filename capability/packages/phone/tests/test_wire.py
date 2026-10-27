"""Real stdio MCP sessions, with offline transport boundaries and no model calls."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "capability/contracts/receipt.v1.schema.json").read_text())


class Wire(unittest.IsolatedAsyncioTestCase):
    async def test_real_offline_and_fake_hosts_return_receipts_for_all_tools(self):
        for mode in ("server/main.py", "fake/server.py"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                params = StdioServerParameters(command=sys.executable, args=[str(PACKAGE / mode)],
                    env={**os.environ, "PAIOS_ERRAND_SPOOL": folder, "PAIOS_PHONE_PROVIDER": "",
                         "PAIOS_PHONE_SERIAL": "", "PAIOS_ADB": "/nonexistent/offline-test-adb"})
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        catalog = await session.list_tools()
                        self.assertEqual(len(catalog.tools), 9)
                        async def call(name, **args):
                            result = await session.call_tool(name, {"principal_id": "owner", **args})
                            self.assertFalse(result.isError)
                            Draft202012Validator(SCHEMA).validate(result.structuredContent)
                            self.assertEqual(len(result.content), 1)
                            self.assertEqual(result.content[0].type, "text")
                            return result.structuredContent
                        query = await call("phone_status")
                        self.assertNotIn("job", query)
                        self.assertEqual(query["status"]["state"], "succeeded")
                        await call("phone_check", job_id="job-0123456789ab")
                        await call("phone_control_link")
                        await call("phone_start")
                        await call("phone_restore_apps", apps=["千问"])
                        await call("phone_save_apps", apps=["千问"])
                        await call("phone_close")
                        await call("phone_cancel")
                        body = await call("phone_task", goal="离线合同", task_type="read_app",
                                          app="千问" if mode.startswith("fake") else "offline-invalid-app")
                        if mode.startswith("fake"):
                            self.assertEqual(body["status"]["state"], "accepted")
                            for _ in range(50):
                                status = await call("phone_status", job_id=body["job"]["id"])
                                if status["status"]["state"] not in {"running", "accepted"}:
                                    break
                                await asyncio.sleep(.01)
                            self.assertEqual(status["status"]["state"], "succeeded")
                            self.assertEqual(status["effects"][0]["kind"], "observe")
                            self.assertGreater(status["job"]["revision"], body["job"]["revision"])
                        else:
                            self.assertEqual(body["status"]["state"], "failed")
                            self.assertIn("offline-invalid-app", body["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
