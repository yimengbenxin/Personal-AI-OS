"""Fixture chain: native cron -> admission -> native tool -> durable watch -> delivery."""
import asyncio
import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


# This fixture checks persisted job bytes and ACK-loss/module-reload semantics, not power-loss durability.
# Keep the real file reads/writes; avoid benchmarking a sync of every native registry update under CI I/O load.
@patch("os.fsync", lambda _fd: None)
@patch("hermes_cli.plugins.PluginManager.discover_and_load", lambda *_args, **_kwargs: None)
@patch("tools.registry.discover_builtin_tools", lambda *_args, **_kwargs: [])
@patch("cron.scheduler._start_heartbeat_thread", lambda *_args, **_kwargs: SimpleNamespace(join=lambda **_kw: None))
def exercise(home, *, mcp=False, message="包裹到了"):
    model_tools_was_loaded = 'model_tools' in sys.modules
    from cron.jobs import claim_job_for_fire, get_job
    from cron.scheduler import run_one_job
    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.registry import registry
    from personal_aios import cron
    # Native cron, watch persistence and registry dispatch are the owners under test.
    # The query is a controlled tool port; loading an unused model runtime and policy workers
    # for it adds unrelated imports/threads to every fixture process.

    owner = {"principal_id": "owner", "device_id": "phone", "allow_owner_mutation": True,
             "allow_reasoning_create": True, "origin_processed_event_id": "d:watch-owner"}
    current = dict(owner)
    calls, tasks, attempts, handlers = [], [], [], {}
    state = ["pending"]
    lose_ack = [True]
    query_name = 'mcp__phone__parcel_status' if mcp else 'fixture_parcel_query'
    if mcp:
        from mcp.server import MCPServer
        from tools.mcp_tool_handlers import _render_call_tool_result
        server = MCPServer('phone')
        @server.tool()
        def parcel_status() -> dict:
            return {'status': state[0]}

    def request(path, body):
        if path.endswith("schedule-context"):
            return current
        if path.endswith("scheduled-task"):
            tasks.append(body)
            current.update(scheduled_job_id=body["job_id"], scheduled_occurrence_id=body["occurrence_id"],
                           scheduled_captured_at=body["captured_at"], allow_owner_mutation=False,
                           allow_reasoning_create=False)
            return {"status": "admitted"}
        if path.endswith("scheduled-delivery"):
            attempts.append(body)
            if lose_ack[0]:
                lose_ack[0] = False
                raise OSError("fixture lost delivery ACK after downstream acceptance")
            return {"status": "delivered"}
        return {"status": "synced"}

    def register_tool(name, toolset, schema, handler, **kw):
        handlers[name] = handler
        registry.register(name=name, toolset=toolset, schema=schema, handler=handler)
        return True

    def query(args, **kwargs):
        calls.append(args)
        if mcp:
            return _render_call_tool_result(asyncio.run(server.call_tool('parcel_status', {})), 'phone')
        return json.dumps({"status": state[0]})

    ctx = SimpleNamespace(register_tool=register_tool,
        register_platform=lambda name, label, factory, check, **kw: platform_registry.register(
            PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kw)),
        register_platform_handler=lambda *a, **kw: None)
    token = set_hermes_home_override(Path(home))
    try:
        cron.register(ctx, SimpleNamespace(_request=request))
        schema = {"name": query_name, "description": "Synthetic query", "parameters": {"type": "object", "properties": {}}}
        register_tool(query_name, "cronjob", schema, query)
        prompt, skills = "Run paios_watch_check for the saved watch", ["fixture-watch"]
        created = json.loads(handlers["cronjob_manage"]({"action": "create", "schedule": "every 5m",
            "prompt": prompt, "skills": skills,
            "standing_watch": {"query_tool": query_name, "query_args": {"tracking_id": "fixture"},
                               "status_field": "status", "from_status": "pending", "to_status": "arrived", "message": message}}))
        assert created["success"], created
        job_id = created["job_id"]
        Path(home, "config.yaml").write_text('cron: {wrap_response: false}\nplatforms: {personal_aios: {enabled: true}}\n')

        async def fire():
            adapter = platform_registry.create_adapter("personal_aios", PlatformConfig(enabled=True))
            claimed = claim_job_for_fire(job_id, manual=True, return_job=True)
            assert await asyncio.to_thread(run_one_job, claimed, adapters={Platform("personal_aios"): adapter}, loop=asyncio.get_running_loop())
            result = await asyncio.to_thread(registry.dispatch, "paios_watch_check", {},
                session_id="standing-watch-tool-fixture", tool_call_id="watch-check")
            return json.loads(result)

        async def scenario():
            observed = await fire()
            assert observed.get("status") == "silent", observed
            assert (await fire())["status"] == "silent"
            state[0] = "arrived"
            failed = await fire()
            assert failed.get("error"), failed
            assert get_job(job_id)["standing_watch"]["pending"] == attempts[0]
            # Reload adapter and native job reads; only the durable pending observation survives.
            import personal_aios.watch as watch
            importlib.reload(watch)
            cron.register(ctx, SimpleNamespace(_request=request))
            assert (await fire())["status"] == "delivered"
            assert (await fire())["status"] == "silent"
            assert attempts[0] == attempts[1] and len(attempts) == 2
            assert len(calls) == 4 and get_job(job_id)["standing_watch"]["delivered_sequence"] == 1
            # A standing watch keeps observing after delivery; the next transition gets its own receipt.
            state[0] = "pending"
            assert (await fire())["status"] == "silent"
            state[0] = "arrived"
            assert (await fire())["status"] == "delivered"
            assert (await fire())["status"] == "silent"
            assert len(calls) == 7 and len(attempts) == 3
            assert attempts[2]["id"] != attempts[0]["id"]
            assert get_job(job_id)["standing_watch"]["delivered_sequence"] == 2
            assert len(tasks) == len({task["occurrence_id"] for task in tasks}) == 8
            assert all(task["prompt"] == prompt and task["skills"] == skills for task in tasks)
            return {"tasks": tasks, "deliveries": attempts, "query_calls": len(calls), "restarted": True,
                    "state": get_job(job_id)["standing_watch"]}

        # The execution ledger also requests FULL sync through SQLite's C API (os.fsync above
        # cannot intercept it). Retain real transactions/reopens, without a power-loss benchmark.
        from hermes_cli import sqlite_util
        open_db = sqlite_util.open_db
        def fixture_db(*args, **kwargs):
            kwargs['synchronous_full'] = False
            connection = open_db(*args, **kwargs)
            connection.execute('PRAGMA synchronous=OFF')
            return connection
        def query_dispatch(name, args, **kwargs):
            return registry.dispatch(name, args, **kwargs)
        with patch.object(sqlite_util, 'open_db', fixture_db), patch(
                'tools.personal_aios_dispatch.dispatch_nested_tool', side_effect=query_dispatch):
            return asyncio.run(scenario())
    finally:
        platform_registry.unregister("personal_aios")
        reset_hermes_home_override(token)
        # An error formatter may import model_tools under this fixture's discovery isolation.
        # A later test must get its normal discovery when it first imports the module.
        if not model_tools_was_loaded:
            sys.modules.pop('model_tools', None)


if __name__ == "__main__":
    import sys
    print("WATCH_RESULT=" + json.dumps(exercise(sys.argv[1]), ensure_ascii=False))
