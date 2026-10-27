"""Real stdio fake + native MCP serialization + documented plugin hooks, against the HTTP gateway."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters, stdio_client


async def main(request):
    root = Path(request["root"])
    spec = importlib.util.spec_from_file_location("capability_gateway_plugin", root / "integrations/hermes/yimi_gateway/__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    gateway = plugin.Gateway(request["config"])
    from tools.mcp_tool_handlers import _render_call_tool_result
    root_task, root_turn = 'fixture-root:' + request['run'], 'fixture-turn:' + request['run']
    child, grandchild = 'fixture-child:' + request['run'], 'fixture-grandchild:' + request['run']
    gateway.lifecycle('pre_llm_call', session_id=request['session'], task_id=root_task, turn_id=root_turn, user_message=request['input'])
    parent_session, parent_turn, parent_task = request['session'], root_turn, ''
    for task in [child, grandchild]:
        child_session, child_turn = task + ':session', task + ':turn'
        gateway.lifecycle('subagent_start', parent_session_id=parent_session, parent_turn_id=parent_turn,
            parent_subagent_id=parent_task, child_session_id=child_session, child_subagent_id=task)
        gateway.lifecycle('pre_llm_call', session_id=child_session, task_id=task, turn_id=child_turn, user_message='fixture goal')
        parent_session, parent_turn, parent_task = child_session, child_turn, task
    try:
        if request.get("decide_only"):
            # The gate alone, through the same plugin, HTTP route and admission binding as an executed call.
            fields = {"task_id": grandchild, "session_id": request["session"], "tool_call_id": request["call"],
                      "turn_id": parent_turn, "api_request_id": "opaque-fixture-attempt"}
            print(json.dumps({"decision": gateway.pre("mcp__mijia__" + request["tool"], request["args"], **fields)}, ensure_ascii=False))
            return
        params = StdioServerParameters(command=sys.executable,
            args=[str(root / "capability/packages/mijia/fake/server.py")],
            env={**os.environ, "HERMES_HOME": request["home"], "PAIOS_FAKE_MIJIA_LOG": request["home"] + "/calls.jsonl",
                 "PAIOS_FAKE_MIJIA_OUTCOME": request["outcome"]})
        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            # Discovery is precondition setup; every fixture's measured tool crosses all production boundaries.
            if request["outcome"] != "login_required":
                await client.call_tool("refresh_devices", {})
            name, args = request["tool"], request["args"]
            identity = "mcp__mijia__" + name
            fields = {"task_id": grandchild, "session_id": request["session"],
                "tool_call_id": "call-" + request["outcome"], "turn_id": parent_turn, "api_request_id": "opaque-fixture-attempt"}
            decision = gateway.pre(identity, args, **fields)
            assert decision is None or decision['action'] == 'modify', decision
            if decision:
                args = {**args, **decision['args']}
            raw = await client.call_tool(name, args)
            native = _render_call_tool_result(raw, "mijia")
            fields.update(result=native, status="success", duration_ms=1, error_type=None, error_message=None)
            gateway.post(identity, args, **fields)
            view = gateway.transform(identity, args, **fields)
            view = native if view is None else view
            assert "gateway_unavailable" not in view, view
            print(json.dumps({"receipt": raw.structured_content, "view": view, "native": native}, ensure_ascii=False))
    finally:
        pass


if __name__ == "__main__":
    asyncio.run(main(json.loads(Path(sys.argv[1]).read_text())))
