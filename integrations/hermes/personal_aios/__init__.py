"""Thin Personal-AIOS provider; TS owns tool contracts, Hermes owns loop/history."""
import copy
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from agent.memory_provider import MemoryProvider
from .effects import http_error_result, http_error_block
from .ts_packages import legacy_schemas

EXPERIENCE_REVIEW_CONTEXT = """【成功经验的保存门槛】
复用原生后台复盘和 skill_manage，不另建成长回路。判断操作方法是否值得保存时，本产品门槛优先于复盘中“每次都应更新技能／不保存是 missed opportunity”的通用鼓励；不合格时不写 how-to 是正确结果。
只有全部满足才写或更新 how-to：实际结果有工具收据、文件或应用状态等证据；该任务家族的整次运行耗时和工具调用数都有测量，且在预算内；无需主人救援，没有反复试错；发送确认及安全规则完整遵守；首次确认仍按同一主人、稳定收件地址和任务类型复用服务器记录，不另加每条消息确认。Mac 微信纯文本消息的初始参考预算是约120秒、约10次工具调用，覆盖准备、确认检查、发送和核验；主人等待确认的时间单独列出，不冒充执行耗时。其他家族预算从实测运行建立，不套微信数值；测量、家族预算或安全证据未知都不能认定成功经验。
合格 how-to 记录准确快路径、实测时间和调用数、验证日期、设备／系统与应用版本及证据范围；这些是方法的验证元数据，不能因原生通用提示不存事故日期而删掉。既有路径后来失败或明显变慢，先标 stale，未经重新合格验证不当作可靠快路径使用。
过慢、未核实、主人救援或反复试错的运行只保存避坑 lesson 到平台记忆或工程手册，不新建或更新成功 how-to；没有可复用教训可不保存。memory 不在当前复盘白名单时，不强行调用它，按工程手册的既有产品 patch 入口保存 lesson。
慢运行中发现的修复立即保存为 unverified candidate／候选 patch，附已验证范围和缺口，并按既有入口提交产品修复；候选不是 how-to，不能宣称已学会可靠快路径。先保存候选再清临时目录，之后只有合格运行才能将它确认为成功方法。修改已有技能仍须先读，产品技能、工坊工具包与普通自有技能各沿原生权限和发布合同。
"""


class PersonalAIOSProvider(MemoryProvider):
    name = "personal_aios"

    def __init__(self):
        from hermes_constants import get_hermes_home
        from hermes_cli.config import _expand_env_vars
        import yaml
        config_path = get_hermes_home() / "config.yaml"
        config = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
        self.owner_mac_enabled = 'owner_mac' in (config or {}).get('mcp_servers', {})
        config = _expand_env_vars((config or {}).get("personal_aios", {}))
        self.base_url = config.get("internal_base_url", "")
        # One tool RPC may include a cold download and the bounded native vision call.
        self.timeout = float(config.get("timeout_seconds", 600))
        self.key_file = config.get("internal_key_file", "")
        self._schemas = None
        self.capability_tools = frozenset(config.get('capability_tools', []))

    def capability_enabled(self, package):
        """Use the loader's active gateway catalog, including its rollback and single-host filtering."""
        if not self.capability_tools:
            return False
        manifest=Path(__file__).resolve().parents[3]/'capability/packages'/package/'plugin.json'
        if not manifest.is_file():
            return False
        server=json.loads(manifest.read_text())['extensions']['ai.yimi.capability']['runtime']['server']
        return any(tool.startswith(f'mcp__{server}__') for tool in self.capability_tools)

    def is_available(self):
        url = urlsplit(self.base_url)
        return (url.scheme == "http" and url.hostname in {"127.0.0.1", "::1", "localhost"}
                and not url.username and Path(self.key_file).is_file())

    def initialize(self, session_id, **kwargs):
        # The provider stays bound to the profile selected by the native loader.
        self.profile_home = Path(kwargs["hermes_home"])

    def prefetch(self, query, *, session_id=""):
        from gateway.run_scope import current_scope
        if current_scope() != "owner":
            return ""
        core = '\n\n'.join(f"{name}（平台核心档案，只读）\n{text}"
            for name in ('USER.md', 'MEMORY.md')
            if (path := self.profile_home / 'memories' / name).is_file() and (text := path.read_text()))
        # Same platform-owned, read-only volume; no native/persona writer owns this document.
        zone = self.profile_home / 'memories' / 'PERSONALITY.md'
        return '\n\n'.join(part for part in (core, zone.read_text() if zone.exists() else '') if part)

    def _request(self, path, body=None, max_bytes=1048576):
        if not self.is_available():
            raise ValueError("internal_loopback_configuration_required")
        request = Request(self.base_url.rstrip("/") + path,
            data=None if body is None else json.dumps(body).encode(), headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + Path(self.key_file).read_text().strip()})
        with urlopen(request, timeout=self.timeout) as response:
            payload = response.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise ValueError("internal_response_budget_exceeded")
        return json.loads(payload)

    def errand_report_context(self, context, job_ids):
        result = self._request('/internal/hermes/errand-report-context', {'context': context, 'job_ids': job_ids})
        return result.get('prior_reports', [])

    def get_tool_schemas(self):
        if self._schemas is None:
            schemas = self._request("/internal/hermes/tool-contracts", max_bytes=131072)
            if not isinstance(schemas, list) or not 1 <= len(schemas) <= 40:
                raise ValueError("invalid_tool_contract_snapshot")
            if any(not isinstance(schema, dict) or
                   not isinstance(schema.get("name"), str) or
                   not isinstance(schema.get("description"), str) or
                   not isinstance(schema.get("parameters"), dict) or
                   not isinstance(schema["parameters"].get("properties"), dict)
                   for schema in schemas):
                raise ValueError("invalid_tool_contract_snapshot")
            self._schemas = schemas
        return copy.deepcopy(legacy_schemas(self._schemas, self.capability_tools))

    def handle_tool_call(self, tool_name, args, **kwargs):
        context = {key: kwargs.get(key, "") for key in ("session_id", "run_id", "tool_call_id")}
        try:
            result = self._request("/internal/hermes/tools/" + quote(tool_name, safe=""), {"context": context, "args": args})
        except HTTPError as exc:
            result = {"status": "rejected", **http_error_result(exc)}
        except (URLError, TimeoutError, ValueError):
            result = {"status": "failed", "error_code": "internal_service_unavailable"}
        if isinstance(result, dict) and result.get("status") in {"rejected", "failed"}:
            result = {**result, "success": False, "error": result["error_code"]}
        return json.dumps(result, ensure_ascii=False)


def register(ctx):
    from .model_transport import register_source
    register_source()
    heading = '### 只报告记录支持的事实'
    rules = (Path(__file__).parent / 'skills/personal-aios-main/SKILL.md').read_text()
    section = heading + rules.split(heading, 1)[1].split('\n### ', 1)[0]
    ctx.register_system_prompt_section('personal-aios.reporting', section, max_chars=4000)
    provider = PersonalAIOSProvider()
    ctx.register_memory_provider(provider)
    ctx.register_system_prompt_section('personal-aios.experience-review', EXPERIENCE_REVIEW_CONTEXT)
    from .self_tools import register as register_self_tools
    register_self_tools(ctx, provider)
    from .owner_mac_tools import register as register_owner_mac_tools
    register_owner_mac_tools(ctx, provider)
    from .cron import register as register_cron
    register_cron(ctx, provider)
    from .effects import register as register_effects, register_execution_gate
    register_effects(ctx, provider)
    lifecycle = {"phone_start", "phone_restore_apps", "phone_save_apps", "phone_close"}
    def phone_source(tool_name, args, session_id="", **kwargs):
        if tool_name.removeprefix('mcp__phone__') in {'phone_task','phone_status','phone_control_link',*lifecycle} and provider.capability_enabled('phone'):
            return None
        if tool_name.removeprefix("mcp__phone__") in {"phone_status", "phone_control_link"}:
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            if not run:
                return {"action": "block", "message": "Phone status requires a bound owner run."}
            try:
                owner = provider._request("/internal/hermes/schedule-context", {"context": {
                    "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}})
                return {"action": "modify", "args": {"principal_id": owner["principal_id"]}}
            except HTTPError as exc:
                return http_error_block(exc)
            except Exception as exc:
                # An escaped middleware error would let Hermes execute model-supplied identity.
                return {"action": "block", "message": "PHONE_SOURCE_CHECK_FAILED: " + type(exc).__name__}
        if tool_name.removeprefix("mcp__phone__") in lifecycle:
            # Background cloud-phone steps carry the request's job lineage so its activity card shows them.
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            if not run:
                return None
            owner = provider._request("/internal/hermes/phone-task-context", {"context": {
                "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}})
            return {"action": "modify", "args": {key: owner[key] for key in ("principal_id", "job_id", "origin_processed_event_id")}}
        if tool_name not in {"phone_task", "mcp__phone__phone_task"}:
            return None
        if "pay_limit_yuan" in args:
            return {"action": "block", "message": "pay_limit_yuan 已取消：先调用 paios_payment(action=request)，再传 payment_intent"}
        from .effects import check_effect
        gate = check_effect(provider, tool_name, args, session_id, kwargs.get("tool_call_id", ""))
        if gate and gate.get("action") == "block":
            return gate
        payment, ride = args.get("payment_intent"), bool(args.get("ride_ok"))
        try:
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            owner = provider._request("/internal/hermes/phone-task-context", {"context": {
                "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}}) if run else {}
            principal = owner.get("principal_id")
            body = {"run_id": run, **({"intent_id": payment} if payment else {})}
            source = provider._request("/internal/hermes/payment-source", body) if run and (payment or ride) else {}
            allowed = (isinstance(principal, str) and bool(principal) and isinstance(source, dict)
                       and (not payment or source.get("allowed") is True) and (not ride or source.get("ride_allowed") is True))
            if not allowed:
                return {"action": "block", "message": "Phone work requires a bound owner run. Payment requires a live intent from this run. A real ride requires an owner request or a verified affirmative ride-card answer."}
            # The server's approval record rides in effect to the tool result (effects.report_approval).
            approval = {"effect": {**args["effect"], "approval": gate}} if gate else {}
            return {"action": "modify", "args": {**{key: owner[key] for key in ("principal_id", "job_id", "origin_processed_event_id")}, **approval}}
        except HTTPError as exc:
            return http_error_block(exc)
        except (URLError, TimeoutError, ConnectionError) as exc:
            return {"action": "block", "message": "PHONE_SOURCE_UNAVAILABLE: " + type(exc).__name__}
        except Exception as exc:
            # Native execution middleware skips escaped errors; expose the failure and block here.
            return {"action": "block", "error_code": "PHONE_SOURCE_CHECK_FAILED", "error_type": type(exc).__name__,
                    "message": f"PHONE_SOURCE_CHECK_FAILED: {type(exc).__name__}"}
    register_execution_gate(ctx, phone_source)
    if __import__('os').environ.get('PAIOS_WORKSHOP_HOST'):
        from .workshop import register as register_workshop
        from .workshop_capability import registry_client
        config = __import__('hermes_cli.config', fromlist=['load_config']).load_config().get('personal_aios', {})
        register_workshop(ctx, provider, registry_factory=(lambda kwargs: registry_client(provider, kwargs))
                          if config.get('capability_registry') else None)
