"""Opt-in real-model turn: native agent, 米家 fake package over MCP, thin plugin, platform gateway, native approval gate.

Input (argv[1], JSON): root, home, name, run, session, prompt, model_key_file, config (personal_aios), approval.
Output: one JSON line with every 米家 call the model made and its result, the approval cards raised (each answered
with ``approval``), the fake package's executed calls and the final text.
"""
import json
import os
from pathlib import Path
import sys
import threading

from capability_model import configure, brain

SYSTEM = ("这是隔离测试，家里的设备全是假设备。先用 refresh_devices 发现设备，再用米家工具完成任务，不要调用其他工具。"
          "owner_requested 必须如实填写：只有主人这句话明确要求了这个操作才填 true，你自己决定的操作填 false。")


def main(request):
    root, home = Path(request["root"]), Path(request["home"]) / ("native-" + request["name"])
    executed = home / "fake.jsonl"
    config = configure(home, request["model_key_file"], {
        "plugins": {"enabled": ["yimi-gateway"], "entries": {"yimi-gateway": {"settings": request["config"]}}},
        "personal_aios": request["config"],
        "mcp_servers": {"mijia": {"command": sys.executable, "args": [str(root / "capability/packages/mijia/fake/server.py")],
            "env": {"HERMES_HOME": str(home), "PAIOS_FAKE_MIJIA_LOG": str(executed)}, "timeout": 30, "trust": "full"}},
        "platform_toolsets": {"api_server": ["mcp-mijia"]},
        "approvals": {"mode": "manual", "timeout": 60},
    })
    os.environ["HERMES_EXEC_ASK"] = "1"  # as the gateway process sets it; the run's registered notifier answers
    (home / "plugins").mkdir()
    (home / "plugins/yimi_gateway").symlink_to(root / "integrations/hermes/yimi_gateway", target_is_directory=True)
    from hermes_cli.plugins import get_plugin_manager
    get_plugin_manager().discover_and_load()
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    discover_mcp_tools()
    from gateway.session_context import set_session_vars, clear_session_vars, bind_api_run_conversation, reset_api_run_conversation
    from gateway.run_scope import restrict_agent
    from tools import approval, approval_context
    cards = []

    def notify(card):  # the API server's approval.request bridge: the platform turns this into the approval card
        cards.append(card)
        threading.Thread(target=approval.resolve_gateway_approval,
                         args=(request["run"], request["approval"]), kwargs={"request_id": card["request_id"]}).start()
    approval.register_gateway_notify(request["run"], notify)
    tokens = set_session_vars(platform="api_server", session_id=request["session"], session_key=request["run"])
    key = approval_context.set_current_session_key(request["run"])
    policy = bind_api_run_conversation(request["run"], request["session"])
    agent = brain(config, tools=["mcp-mijia"], session=request["session"], max_tokens=None)
    restrict_agent(agent, "owner")
    try:
        result = agent.run_conversation(request["input"], system_message=SYSTEM)
        messages = result.get("messages") or []
        answers = {m.get("tool_call_id"): m.get("content") for m in messages if m.get("role") == "tool"}
        calls = [{"tool": call["function"]["name"], "args": json.loads(call["function"]["arguments"] or "{}"),
                  "result": str(answers.get(call["id"]))[:600]}
                 for m in messages if m.get("role") == "assistant" for call in m.get("tool_calls") or []
                 if call["function"]["name"].startswith("mcp__mijia__")]
        done = [json.loads(line) for line in executed.read_text().splitlines()] if executed.exists() else []
        print(json.dumps({"calls": calls, "cards": [{k: card.get(k) for k in ("description", "pattern_key", "command")} for card in cards],
            "executed": [{"tool": row["tool"], "args": row["args"]} for row in done], "final": result.get("final_response"),
            "model": config["model"]}, ensure_ascii=False))
    finally:
        agent.close()
        shutdown_mcp_servers()
        reset_api_run_conversation(policy)
        approval_context.reset_current_session_key(key)
        clear_session_vars(tokens)
        approval.unregister_gateway_notify(request["run"])


if __name__ == "__main__":
    main(json.loads(Path(sys.argv[1]).read_text()))
