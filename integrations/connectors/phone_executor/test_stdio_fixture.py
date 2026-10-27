"""The stdio probe's actual call must satisfy the executor's public MCP schema."""
import ast
import asyncio
from pathlib import Path
import sys
import unittest

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server

ROOT = Path(__file__).resolve().parents[3]


class StdioFixture(unittest.TestCase):
    def test_probe_passes_a_read_effect_to_the_real_executor_schema(self):
        tree = ast.parse((ROOT / "tests/hermes/stdio/phone_client.py").read_text())
        call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "call"
                    and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "phone_task")
        args = ast.literal_eval(call.args[1])
        schema = next(t.inputSchema for t in asyncio.run(server.mcp.list_tools()) if t.name == "phone_task")
        Draft202012Validator(schema).validate(args)
        self.assertEqual(args["effect"], {"kind": "read", "task_type": "stdio_checkout_probe", "requested": True})


if __name__ == "__main__":
    unittest.main()
