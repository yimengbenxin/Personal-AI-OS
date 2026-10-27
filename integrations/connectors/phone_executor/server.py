"""Personal AIOS phone executor: one MCP tool that hands a goal to Mobilerun on the agent phone.

The agent phone (USB or remote Android, PAIOS_PHONE_SERIAL) is logged in to the user's apps. Mobilerun
(MIT, droidrun/mobilerun) does the step-by-step UI work; this file only adapts it to MCP for Hermes.
Run with the Mobilerun venv's python and requirements.lock.txt (RapidOCR's bundled Chinese models and ONNX
Runtime CPU serve the pay guard on macOS and Linux). Telemetry is forced off; the model key comes from a file.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import contextvars
import fcntl
import io
import json
import logging
import os
import re
import select
import shlex
import socket
import xml.etree.ElementTree as ET
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
import payment_lineage
import payment_guard
from payment_guard import (
    _Refused, _AppLoginRequired, _CheckpointReached, _ScreenImage, _NativeRead, _NativeText,
    CHECKOUT, VERIFY_PROMPT, PAY_BUTTON, PAY_NAVIGATION, CONFIRM_BUTTON, TOTAL_LABEL, YUAN,
    PAID, RIDE_CALLED, CANCEL_RIDE, RIDE_BUTTON, CANCEL_CONTROL, CANCEL_ORDER,
    _hits, _on, _charge_control, _pays, _order_amounts, _order_total, _order_items,
    _ControlInput, _ChargeRecognition, _recognize_charge, _confirmation_surface, _charge_input,
    _MERCHANT_FIELD, _IDENTITY_FIELD, _NATIVE_DATA_ROLE, _NATIVE_STATUS_ROLE,
    _positive_bounds, _inside, _PaymentSection, _overlaps, _native_ocr_occurrences,
    _payment_fields, _payment_identity, _screen_nodes,
)
import mac_android
import step_trace
from errand_status import RECENT_S, SPOOL_CONTRACT, TERMINAL_STATES, terminal_records, job_status

os.environ["MOBILERUN_TELEMETRY_ENABLED"] = "false"
os.environ["DROIDRUN_TELEMETRY_ENABLED"] = "false"
from mcp.server.fastmcp import FastMCP  # noqa: E402


def _load_model() -> None:
    """SMS startup does not read model credentials or import model/vision dependencies."""
    global MobileAgent, ManagerPlanEvent, FastAgentResponseEvent, ConfigLoader, AndroidDriver
    from mobilerun import MobileAgent
    from mobilerun.agent.droid.events import ManagerPlanEvent
    from mobilerun.agent.fast_agent.events import FastAgentResponseEvent
    from mobilerun.config_manager import ConfigLoader
    from mobilerun_core_local.driver.android import AndroidDriver
    key_file = os.environ.get("PAIOS_DEEPSEEK_KEY_FILE")
    if key_file and not os.environ.get("DEEPSEEK_API_KEY"):
        os.environ["DEEPSEEK_API_KEY"] = Path(key_file).read_text().strip()


CONFIG = os.environ.get("PAIOS_MOBILERUN_CONFIG", "config.yaml")


def _mobile_config():
    if state := os.environ.get("PAIOS_PHONE_STATE_DIR"):
        from runtime_config import load_config
        return load_config(ConfigLoader, CONFIG, state)
    return ConfigLoader.load(CONFIG)


PHONE_PROVIDER = os.environ.get("PAIOS_PHONE_PROVIDER", "")
PHONE_SERIAL = os.environ.get("PAIOS_PHONE_SERIAL", "")  # ro.serialno identity; SERIAL is the selected transport
SERIAL = PHONE_SERIAL
OFFLINE = "执行手机现在不在线（没有连上 Mac），这件事没有开始办。如实告诉用户，等执行手机连上后再办。"
ADB = os.environ.get("PAIOS_ADB", "adb")
TASK_TIMEOUT_S = int(os.environ.get("PAIOS_PHONE_TASK_TIMEOUT", "600"))
SPOOL = os.environ.get("PAIOS_ERRAND_SPOOL")  # finished background errands land here; the gateway delivers them
_receipt_stamp = None  # Enabled by the capability host; legacy transport keeps its existing wire.
_payment_check = None
_before_phone_operation = None
UNLOCK_FILE = os.environ.get("PAIOS_PHONE_UNLOCK_FILE")  # owner-only file with the agent phone's screen PIN

logging.basicConfig(stream=sys.stderr, level=logging.INFO)  # stdout carries the MCP protocol


@contextlib.asynccontextmanager
async def _lifespan(_server):
    tasks = [asyncio.create_task(_cancel_poller())]
    if PHONE_PROVIDER == "agentbay":
        tasks.append(asyncio.create_task(_reap_login()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await _join_cleanup(asyncio.gather(*tasks, return_exceptions=True))


async def _reap_login(lease=None):
    """Start-up: delete a cloud login session a dead executor left open, only while no live process holds the phone."""
    delay = LOGIN_RETRY_S
    while True:
        fd = None if lease else os.open(_device_lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if fd is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            import agentbay_phone
            work = asyncio.create_task(asyncio.to_thread(agentbay_phone.reap_login, **({"force": True} if lease else {})))
            try:
                reaped = await asyncio.shield(work)
            except asyncio.CancelledError:
                try:
                    await _join_cleanup(work)
                finally:
                    raise asyncio.CancelledError
            if reaped:
                logging.warning("cloud login session left by a previous executor was deleted")
            if lease:
                global _login_lease
                await lease.__aexit__(None, None, None)
                _login_lease = None
            return
        except BlockingIOError:
            return  # the live lease owner performs its own cleanup
        except Exception as exc:  # noqa: BLE001
            logging.warning("cloud login reap failed; retrying: %s", exc)
        finally:
            if fd is not None:
                os.close(fd)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60)


LOGIN_MAX_S = int(os.environ.get("PAIOS_LOGIN_MAX_S", "1800"))
LOGIN_RETRY_S = 1


async def _login_expiry(phone, delay=None):
    """Retry failed closure while retaining this exact login's cross-process lease."""
    await asyncio.sleep(LOGIN_MAX_S if delay is None else delay)
    delay = LOGIN_RETRY_S
    while True:
        try:
            async with _one_phone:
                if _login_phone is not phone:
                    return
                await _close_login()
            return
        except Exception as exc:  # noqa: BLE001
            logging.warning("cloud login close failed; retrying: %s", exc)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60)


async def _login_active():
    """Called under _one_phone; the SDK session is authoritative even after remote reclamation."""
    if _login_phone is not None:
        import agentbay_phone
        work = asyncio.create_task(asyncio.to_thread(agentbay_phone.session_exists, _login_phone))
        try:
            active = await asyncio.shield(work)
        except asyncio.CancelledError:
            try:
                await _join_cleanup(work)
            finally:
                raise asyncio.CancelledError
        if not active:
            await _clear_login()
    return _login_phone is not None


async def _clear_login():
    global _login_phone, _login_lease
    if (expiry := getattr(_login_phone, "_expiry", None)) and expiry is not asyncio.current_task():
        expiry.cancel()
    _login_phone = None
    await _login_lease.__aexit__(None, None, None)
    _login_lease = None


async def _close_login():
    import agentbay_phone
    await _join_cleanup(agentbay_phone.release(_login_phone, keep_warm=False, sync=False))
    await _clear_login()


mcp = FastMCP("paios-phone", lifespan=_lifespan)
_one_phone = asyncio.Lock()  # one device, one task at a time
_observations = None  # the phone lease's observation pipe (_Observations); None outside a lease
_cloud_phone = None
_mac_phone = None
_login_phone = _login_lease = None
LOGIN_BUSY = "主人正在云手机上登录，暂时不能办事。请完成登录并说「登录好了」，关闭登录会话后再办。"

# BlueStacks re-spoofs a US SIM (T-Mobile 310260) and the host timezone on every boot and has no mainland carrier
# profile; 千问/饿了么 then answer "非中国大陆地区无法下单". A real China-SIM phone already reads cn, so this is a no-op there.
CN_IDENTITY = ("setprop gsm.sim.operator.iso-country cn; setprop gsm.operator.iso-country cn; "
               "setprop gsm.sim.operator.numeric 46000; setprop gsm.operator.numeric 46000; "
               "setprop gsm.sim.operator.alpha 'China Mobile'; setprop gsm.operator.alpha 'China Mobile'; "
               "settings put global auto_time_zone 0; service call alarm 3 s16 {time_zone}")


def _shell(cmd: str, check: bool = False) -> str:
    """One adb shell command; check=True raises when the device reports failure (adb propagates the exit status)."""
    if cmd.startswith(("input ", "am start ")):
        _check_sms_deadline()
    try:
        done = subprocess.run([ADB, "-s", SERIAL, "shell", cmd], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"执行手机命令超时：{cmd.split()[0]}（15 s）") from None  # input text may contain the PIN
    if check and done.returncode != 0:
        raise RuntimeError(f"执行手机命令失败：{cmd.split()[0]} {done.returncode} {done.stderr.strip()[:240]}")
    return done.stdout.strip()


def _online(bind: bool = False) -> bool:
    """Resolve once, owner's order: attached USB; then the LAN (the hotspot gateway, a LAN phone already connected,
    or a peer found on this /24 at home); then an already-connected network phone. Identity is ro.serialno."""
    global SERIAL
    if PHONE_PROVIDER in ("agentbay", "mac-android"):
        if (PHONE_PROVIDER == "agentbay" and _cloud_phone is None) or (PHONE_PROVIDER == "mac-android" and _mac_phone is None): return False
        serial = _cloud_phone.serial if PHONE_PROVIDER == "agentbay" else SERIAL
        if bind: SERIAL = serial
        try:
            state = subprocess.run([ADB, "-s", serial, "get-state"], capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            return False
        return state.returncode == 0 and state.stdout.strip() == "device"
    if not PHONE_SERIAL or ":" in PHONE_SERIAL:
        raise RuntimeError("PAIOS_PHONE_SERIAL 应配置手机的 ro.serialno（如 6c050de4），不是网络地址。")
    devices = subprocess.run([ADB, "devices"], capture_output=True, text=True, timeout=5, check=True).stdout
    connected = re.findall(r"^(\S+)\s+device$", devices, re.M)
    if PHONE_SERIAL in connected:
        if bind: SERIAL = PHONE_SERIAL
        return True
    route = subprocess.run(["/sbin/route", "-n", "get", "default"], capture_output=True, text=True, timeout=3).stdout
    gateway = re.search(r"gateway: (\d+\.\d+\.\d+\.\d+)", route)
    interface = re.search(r"interface: (\S+)", route)
    wired = bool(interface and interface[1].startswith("en"))
    private = re.compile(r"(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.")
    remote = [d for d in connected if ":" in d]

    def phone(candidate: str, connect: bool) -> bool:
        try:
            if connect:
                subprocess.run([ADB, "connect", candidate], capture_output=True, timeout=3)
            identity = subprocess.run([ADB, "-s", candidate, "shell", "getprop ro.serialno"],
                                      capture_output=True, text=True, timeout=3)
        except subprocess.TimeoutExpired:
            return False
        return identity.returncode == 0 and identity.stdout.strip() == PHONE_SERIAL

    lan = [(f"{gateway[1]}:5555", True)] if gateway and wired else []
    lan += [(d, False) for d in remote if private.match(d) and d != (lan[0][0] if lan else None)]
    for candidate, connect in lan + [(peer, True) for peer in (_lan_peers(interface[1]) if wired else [])
                                     if peer not in remote and all(peer != c for c, _ in lan)] \
            + [(d, False) for d in remote if not private.match(d)]:
        if phone(candidate, connect):
            if bind: SERIAL = candidate
            return True
    return False


def _lan_peers(interface: str) -> list[str]:
    """Home Wi-Fi: the phone is a peer on this /24, not the gateway. Hosts with adb's port 5555 open (~0.3 s)."""
    own = re.search(r"inet (\d+\.\d+\.\d+)\.(\d+)", subprocess.run(["/sbin/ifconfig", interface],
                    capture_output=True, text=True, timeout=3).stdout)
    if not own:
        return []

    def open_port(host: str) -> str | None:
        with contextlib.suppress(OSError), socket.create_connection((host, 5555), timeout=0.3):
            return f"{host}:5555"
        return None
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(64) as pool:
        return [peer for peer in pool.map(open_port, (f"{own[1]}.{i}" for i in range(1, 255) if str(i) != own[2])) if peer]


def _ensure_cn_identity(*, preserve_app: bool = False) -> None:
    if _shell("getprop gsm.sim.operator.iso-country", check=True) == "cn":
        return
    if preserve_app:
        raise _Refused("【付款结果不明】当前页面不能保留，已停止；请自行核对原订单，不会重开 App 或付款。")
    _shell(CN_IDENTITY.format(time_zone=shlex.quote(os.environ["PAIOS_TIME_ZONE"])))
    _shell("am force-stop com.aliyun.tongyi")  # it reads the region at launch; only after a reboot, so no task state is lost


# The agent phone may be the owner's own phone: an errand does not start while they are using it. With the
# phone plugged in the screen stays on and unlocked, so "in use" means a touch the executor did not make itself.
OWNER_IDLE_S, OWNER_WAIT_S = 20.0, 60.0
OWNER_BUSY = "主人正在用执行手机（刚有触摸操作），没有开始办，免得和主人抢手机。告诉用户放下手机后再办，或稍后再派一次。"
_own_input_until = 0.0  # wall time when the executor last finished touching the phone


def _owner_active() -> bool:
    found = re.search(r"lastUserActivityTime=\d+ \((\d+) ms ago\)",
                      _shell("dumpsys power | grep -m 1 lastUserActivityTime=", check=True))
    if not found:
        raise RuntimeError("无法确认主人是否正在使用执行手机，未执行。")
    last = time.time() - int(found.group(1)) / 1000
    return time.time() - last < OWNER_IDLE_S and last > _own_input_until + 2


def _locked() -> bool:
    return "isKeyguardShowing=true" in _shell("dumpsys window | grep isKeyguardShowing", check=True)


class _Stopped(Exception):
    """A stopped errand reached a blocking step's next phone input; nothing more is typed."""


def _check_app_login(root):
    for app in ("千问", "淘宝", "支付宝", "米家"):
        texts = {node.get(key, "") for node in root.iter("node") if node.get("package") == APPS[app]
                 for key in ("text", "content-desc")}
        if (texts & {"登录/注册", "手机号登录", "立即登录", "登录后体验", "立即登录，解锁更多功能"}
                or {"输入手机号", "下一步"} <= texts or {"手机号", "淘宝用户快速登录"} <= texts):
            raise _AppLoginRequired(app)


class _SMSExpired(_Refused):
    """The gateway's result-wait deadline forbids further SMS input, including repair unlocks."""


_sms_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar("sms_deadline", default=None)


def _check_sms_deadline() -> None:
    if (deadline := _sms_deadline.get()) is not None and time.time() >= deadline:
        raise _SMSExpired("短信请求期限已过，禁止继续输入。")


def _ensure_unlocked(stop: threading.Event | None = None) -> None:
    """Wake the agent phone and unlock it with the owner's PIN before the model sees it. The PIN never goes to
    the model or the logs; a phone without a lock screen needs no file. A stop is honoured before every input."""
    def go() -> None:
        if stop is not None and stop.is_set():
            raise _Stopped()
    go()
    _shell("input keyevent KEYCODE_WAKEUP")
    time.sleep(0.6)
    if not _locked():
        return
    if not UNLOCK_FILE or not Path(UNLOCK_FILE).is_file():
        raise RuntimeError("执行手机锁屏中，且未配置解锁密码文件")
    pin = Path(UNLOCK_FILE).read_text().strip()
    if not pin.isdigit():
        raise RuntimeError("解锁密码文件格式无效（应为纯数字）")
    w, h = (int(v) for v in re.findall(r"(\d+)x(\d+)", _shell("wm size"))[-1])
    go()
    _shell(f"input swipe {w // 2} {h * 85 // 100} {w // 2} {h // 3} 250")  # reveal the PIN pad
    time.sleep(0.8)
    go()
    _shell(f"input text {pin}")
    go()
    _shell("input keyevent KEYCODE_ENTER")
    for _ in range(10):
        time.sleep(0.5)
        if not _locked():
            return
    raise RuntimeError("执行手机解锁失败，请检查解锁密码")


def _mock_location(stop: threading.Event | None = None) -> bool:
    if "allow" in _shell("appops get io.appium.settings android:mock_location", check=True):
        return False
    _repair_note("模拟定位未授权，尝试授权。")
    if stop is not None and stop.is_set(): raise _Stopped()
    try:
        _shell("appops set io.appium.settings android:mock_location allow", check=True)
    except RuntimeError as exc:
        if "MANAGE_APP_OPS_MODES" in str(exc):
            raise RuntimeError("模拟定位未授权：需要插线授权一次（网络 adb 缺少 MANAGE_APP_OPS_MODES）。") from exc
        raise
    if "allow" not in _shell("appops get io.appium.settings android:mock_location", check=True):
        raise RuntimeError("模拟定位授权未生效：需要插线授权一次。")
    _repair_note("模拟定位已授权。")
    return True


def _place_device(latitude: float, longitude: float, stop: threading.Event | None = None) -> None:
    """Moves the agent phone's GPS to the user's iPhone fix, so apps choose the nearest saved address and pick up here.
    Uses Appium Settings' mock provider (Apache-2.0, io.appium.settings); WGS-84 in, the apps convert to GCJ-02 themselves."""
    _mock_location(stop)
    if stop is not None and stop.is_set(): raise _Stopped()
    _shell("am start-foreground-service --user 0 -n io.appium.settings/.LocationService "
           f"--es latitude {latitude:.6f} --es longitude {longitude:.6f}", check=True)
    # An errand told "pick up here" must not run on a stale fix: confirm the mock provider is allowed and running.
    allowed = "allow" in _shell("appops get io.appium.settings android:mock_location")
    if not (allowed and _location_service_running()):
        raise RuntimeError("没能把执行手机的定位设到用户当前位置，未执行（定位服务未就绪）。")


def _location_service_running() -> bool:
    # A stopped service can still be listed as "* Destroy ServiceRecord{…}" while it is torn down; only a live record counts.
    dump = _shell("dumpsys activity services io.appium.settings/.LocationService", True)
    return re.search(r"^\s*\* ServiceRecord\{[^}]*LocationService", dump, re.M) is not None


# Assistants like 千问 can reject long instruction-style messages with "当前访问人数过多".
# Send one short line; the task's own rules stay with the agent.
OPERATING_RULES = (
    "【执行规则，只给你看，不要发给任何 App】你在用户自己的手机上替用户操作 App。"
    "给千问等 AI 助手发消息时，只用用户日常口吻的一句短话，一次只说一件事，例如「帮我点一杯示例茶饮，中杯常温无糖」；"
    "下面任务里的取舍、限制和汇报要求是给你自己的，不要复制给 App。"
    "如果 App 回复「访问人数过多」之类，等十几秒，用更短的话重发一次。"
    "只在任务指定的 App 里办，不要自己换到别的 App（如饿了么、美团）；办不了就停下汇报。"
    "遇到滑块、拼图、点选文字之类的人机验证，不要尝试，停下汇报。各 App 的操作要点见随附的 App 说明卡片。\n【任务】"
)

# Opening the named app is an OS-level launch by package, not UI scripting: model-based app selection
# can resolve the wrong app or enter a slider captcha.
# Apps that hide their UI from accessibility (WeChat shows 0 nodes): screenshots and coordinates only, so always the
# thorough (vision) tier with Mobilerun's screenshot-only mode; otherwise it refuses every coordinate tap.
SCREENSHOT_ONLY = {"微信"}
APPS = {"千问": "com.aliyun.tongyi", "淘宝": "com.taobao.taobao", "美团": "com.sankuai.meituan", "饿了么": "me.ele",
        "滴滴": "com.sdu.didi.psnger", "高德": "com.autonavi.minimap", "支付宝": "com.eg.android.AlipayGphone", "米家": "com.xiaomi.smarthome", "微信": "com.tencent.mm"}

class CheckoutStop(payment_guard.CheckoutStop):
    def __init__(self, inner, payment_intent=None, ride_ok=False):
        super().__init__(sys.modules[__name__], inner, payment_intent, ride_ok)


def _at_checkout():
    return payment_guard._at_checkout(sys.modules[__name__])


def _screen_texts():
    return payment_guard._screen_texts(sys.modules[__name__])


def _checkout_amount(texts=None):
    return payment_guard._checkout_amount(sys.modules[__name__], texts)


def _tree():
    return payment_guard._tree(sys.modules[__name__])


async def _screen_signs(driver, label):
    return await payment_guard._screen_signs(sys.modules[__name__], driver, label)


async def _signs_after(driver, label):
    return await payment_guard._signs_after(sys.modules[__name__], driver, label)


async def _cancel_ride(config, driver):
    return await payment_guard._cancel_ride(sys.modules[__name__], config, driver)


IDLE_SLEEP_S = 300  # owner: five minutes after the executor's last action the agent phone's screen goes off
_idle_sleep: asyncio.Task | None = None


def _sleep_later() -> None:
    """After each action: unless another one starts or the owner is using the phone, press the sleep key in five
    minutes. No phone setting changes; the next action wakes and unlocks it (_ensure_unlocked)."""
    global _idle_sleep
    if _idle_sleep:
        _idle_sleep.cancel()

    async def later() -> None:
        _sms_deadline.set(None)  # the executor's idle action is independent of the preceding SMS
        await asyncio.sleep(IDLE_SLEEP_S)
        if not _jobs and not await asyncio.to_thread(_owner_active):
            await asyncio.to_thread(_shell, "input keyevent KEYCODE_SLEEP")
    _idle_sleep = asyncio.get_running_loop().create_task(later())


def _device_lock_path():
    key = PHONE_PROVIDER if PHONE_PROVIDER in ("agentbay", "mac-android") else PHONE_SERIAL
    return Path(os.environ.get("PAIOS_PHONE_LOCK_DIR", "/tmp")) / f"paios-phone-{re.sub(r'[^A-Za-z0-9]', '_', key)}.lock"


@contextlib.asynccontextmanager
async def _device_lease(mac_binding=None):
    """Cross-process exclusivity per phone: _one_phone only orders this process's errands, but a real-phone staging
    Hermes runs its own executor. The OS releases the flock when the holder closes it or dies."""
    if PHONE_PROVIDER == "agentbay" and await _login_active(): raise _Refused(LOGIN_BUSY)
    fd = os.open(_device_lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.time() + OWNER_WAIT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() > deadline:
                    raise RuntimeError("另一个执行器（例如预发环境）正在用这台执行手机，未执行。")
                await asyncio.sleep(1)
        global _observations, _mac_phone, SERIAL
        _observations = _Observations()
        try:
            if PHONE_PROVIDER == "mac-android":
                _mac_phone = mac_android.phone(mac_binding)
                SERIAL = await _typing_step(lambda _: _mac_phone.__enter__())
            yield
        finally:
            try:
                await _typing_step(lambda _: _observations.close())
            except (Exception, asyncio.CancelledError) as exc:
                _cleanup_note("观测连接关闭", exc)
            finally:
                _observations = None
                if _mac_phone is not None:
                    try:
                        await _typing_step(lambda _: _mac_phone.__exit__(None, None, None))
                    except (Exception, asyncio.CancelledError) as exc:
                        _cleanup_note("Mac ADB 转发关闭", exc)
                    finally:
                        _mac_phone = None
    finally:
        os.close(fd)


@contextlib.asynccontextmanager
async def _errand(latitude: float | None, longitude: float | None, payment_intent: str | None = None,
                  *, continuation: bool = False, mac_binding=None):
    """One errand on the agent phone: wake and unlock it, mainland identity, GPS to the user; afterwards give the
    owner's keyboard and real GPS back (the agent phone may be the owner's own phone)."""
    global _cloud_phone, SERIAL
    async with _one_phone, (_device_lease(mac_binding) if PHONE_PROVIDER == "mac-android" else _device_lease()):
        if (job := _jobs.get(_job_id.get() or "")) is not None and job["state"] == "waiting":
            job.update(state="running", since=time.time())
            job["payment_owner"] = payment_lineage.capture(SPOOL, job)
            if _before_phone_operation is not None:
                _before_phone_operation(job)
            _write_running(_job_id.get(), force=True)
        placed, ime = False, None
        try:
            if PHONE_PROVIDER == "agentbay":
                import agentbay_phone
                if payment_intent:
                    from payment_checkpoint import CheckpointConfig
                    cfg = CheckpointConfig.from_env()
                    _cloud_phone = await agentbay_phone.lease("errand", extra_budget_s=(
                        cfg.card_ttl_s * (1 + cfg.max_recards) + cfg.phase_extra_s + cfg.cancel_timeout_s))
                else:
                    _cloud_phone = await agentbay_phone.lease("errand")
                SERIAL = _cloud_phone.serial
            if PHONE_PROVIDER != "agentbay" and not await asyncio.to_thread(_online, True):
                if PHONE_PROVIDER == "mac-android": raise mac_android.Unavailable()
                raise RuntimeError(OFFLINE)
            if PHONE_PROVIDER not in ("agentbay", "mac-android"):
                deadline = time.time() + OWNER_WAIT_S
                while await asyncio.to_thread(_owner_active):
                    if time.time() > deadline:
                        raise RuntimeError(OWNER_BUSY)
                    await asyncio.sleep(3)
            if job is not None:
                job["phone_started_at"] = _now()
                try:
                    _write_running(_job_id.get(), force=True, durable=True)
                except OSError:
                    job["phone_started_at"] = None
                    raise
            if PHONE_PROVIDER == "mac-android":
                from async_adbutils import adb
                from mobilerun_core_local.driver.android.portal import ensure_portal_ready
                await ensure_portal_ready(await adb.device(serial=SERIAL))
            ime = await _phone_step(lambda: asyncio.to_thread(_shell, "settings get secure default_input_method", True))
            placed = latitude is not None and longitude is not None
            await _typing_step(_preflight)
            if PHONE_PROVIDER not in ("agentbay", "mac-android"): await _typing_step(_ensure_unlocked)
            await _phone_step(lambda: _typing_step(lambda _: _ensure_cn_identity(preserve_app=True) if continuation else _ensure_cn_identity()))
            if placed:
                if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    raise RuntimeError("定位坐标无效，未执行。")
                await _phone_step(lambda: _typing_step(lambda stop: _place_device(latitude, longitude, stop)))
            if not continuation and _at_checkout():  # a new errand must not inherit an earlier cashier
                _shell("input keyevent KEYCODE_BACK", check=True)
                if job is not None:
                    job["payment_page_left"] = True
                    _write_running(_job_id.get(), force=True, durable=True)
            yield
        finally:
            try:
                if ime and ime != "null" and await _typing_step(lambda _: _shell("settings get secure default_input_method", True)) != ime:
                    await _typing_step(lambda _: _shell(f"ime set {shlex.quote(ime)}", check=True))
            except (Exception, asyncio.CancelledError) as exc:
                _cleanup_note("默认键盘恢复", exc)
            if placed:
                try:
                    await _typing_step(lambda _: _shell("am stopservice io.appium.settings/.LocationService"))
                    if await _typing_step(lambda _: _location_service_running()):
                        raise RuntimeError("模拟定位服务仍在运行")
                except (Exception, asyncio.CancelledError) as exc:
                    _cleanup_note("模拟定位关闭", exc)
            if PHONE_PROVIDER == "agentbay" and _cloud_phone is not None:
                try:
                    await _join_cleanup(agentbay_phone.release(_cloud_phone, keep_warm=True))
                except (Exception, asyncio.CancelledError) as exc:
                    _cleanup_note("云手机会话同步", exc)
                finally:
                    _cloud_phone = None
            elif PHONE_PROVIDER not in ("agentbay", "mac-android") and ime is not None:
                global _own_input_until
                _own_input_until = time.time()
                _sleep_later()


async def _typing_step(fn):
    """A blocking step that types into the phone. Cancelling the coroutine cannot stop its thread, so a stop sets the
    step's flag (honoured before its next input) and is held until the thread has returned: the phone lock is kept and
    "stopped" is reported only once nothing more can be typed."""
    stop = threading.Event()
    work = asyncio.ensure_future(asyncio.to_thread(fn, stop))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        stop.set()
        joined = asyncio.ensure_future(asyncio.wait({work}))
        while not joined.done():
            try:
                await asyncio.shield(joined)
            except asyncio.CancelledError:
                pass  # repeated stops still join the same blocking step before releasing the phone
        if not work.cancelled():
            work.exception()  # retrieve it: _Stopped from the worker is the expected end
        raise


_repairs: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar("phone_repairs", default=None)


def _repair_note(message: str) -> None:
    if (notes := _repairs.get()) is not None:
        notes.append("【手机自修复】" + message)
    if (job := _jobs.get(_job_id.get() or "")) is not None:
        job["repair"] = message
        _write_running(_job_id.get(), force=True)


def _cleanup_note(stage: str, exc: BaseException) -> None:
    message = f"【手机收尾】{stage}未确认完成：{type(exc).__name__}: {exc}"[:600]
    logging.warning(message)
    if (notes := _repairs.get()) is not None:
        notes.append(message)


def _portal_problem() -> str:
    dump = _shell("dumpsys accessibility", check=True)
    bound = re.search(r"Bound services:\{(.*?)\}\s*Enabled services:", dump, re.S)
    enabled = re.search(r"Enabled services:\{(.*?)\}\s*Binding services:", dump, re.S)
    crashed = re.search(r"Crashed services:\{(.*?)\}", dump, re.S)
    if not bound or not enabled or not crashed:
        raise RuntimeError("无法读取 Portal 无障碍服务的绑定/崩溃状态。")
    if "com.mobilerun.portal" in crashed[1]: return "Portal 无障碍服务已崩溃"
    if "com.mobilerun.portal" not in enabled[1]: return "Portal 无障碍服务未启用"
    if "label=Mobilerun Portal," not in bound[1]: return "Portal 无障碍服务未绑定"
    return ""


def _keyboard(stop: threading.Event, typing: bool = False) -> bool:
    from mobilerun_core_local.driver.android.portal import PORTAL_PACKAGE_NAME, portal_ime_id
    ime, changed = portal_ime_id(PORTAL_PACKAGE_NAME), False
    for command, needed in [(f"ime enable {ime}", ime not in _shell("ime list -s", check=True).splitlines()),
                            (f"ime set {ime}", typing and _shell("settings get secure default_input_method", check=True) != ime)]:
        if needed:
            if stop.is_set(): raise _Stopped()
            _repair_note("Portal 键盘未启用。" if command.startswith("ime enable") else "输入时默认键盘不是 Portal。")
            _shell(command, check=True)
            changed = True
    if ime not in _shell("ime list -s", check=True).splitlines() or (typing and _shell("settings get secure default_input_method", check=True) != ime):
        raise RuntimeError("Portal 键盘修复未生效。")
    if changed: _repair_note("Portal 键盘已恢复。")
    return changed


def _preflight(stop: threading.Event, typing: bool = False, portal: bool = True) -> bool:
    changed = False
    if stop.is_set(): raise _Stopped()
    try:
        connected = _online(True) if PHONE_PROVIDER in ("agentbay", "mac-android") else _shell("getprop ro.serialno", check=True) == PHONE_SERIAL
    except (RuntimeError, subprocess.TimeoutExpired):
        connected = False
    if not connected:
        if PHONE_PROVIDER in ("agentbay", "mac-android"):
            _repair_note("ADB 传输中断，重新连接当前执行手机。")
            subprocess.run([ADB, "connect", SERIAL], capture_output=True, text=True, timeout=15, check=True)
        else:
            _repair_note("ADB 传输中断，重新解析 USB/LAN/网络连接。")
        if not _online(True):
            if PHONE_PROVIDER == "mac-android": raise mac_android.Unavailable()
            raise RuntimeError(OFFLINE)
        if _observations is not None: _observations.close()
        changed = True
        _repair_note("ADB 连接已恢复。")
    if PHONE_PROVIDER not in ("agentbay", "mac-android") and _locked():
        _repair_note("执行手机锁屏，尝试解锁。")
        _ensure_unlocked(stop)
        changed = True
        _repair_note("执行手机已解锁。")
    if not portal: return changed
    if PHONE_PROVIDER in ("agentbay", "mac-android"):
        if not _shell("if [ -f /data/local/tmp/paios-observe.jar ]; then echo ready; fi", check=True):
            if stop.is_set(): raise _Stopped()
            subprocess.run([ADB, "-s", SERIAL, "push", str(Path(__file__).with_name("phone-observation.jar")),
                            "/data/local/tmp/paios-observe.jar"], capture_output=True, text=True, timeout=120, check=True)
            changed = True
    from mobilerun_core_local.driver.android.portal import PORTAL_PACKAGE_NAME, portal_a11y_service
    if problem := _portal_problem():
        service = portal_a11y_service(PORTAL_PACKAGE_NAME)
        original = _shell("settings get secure enabled_accessibility_services", check=True)
        enabled = [] if original == "null" else original.split(":")
        restored = original if service in enabled else ":".join([*enabled, service])
        _repair_note((problem if service in enabled else "Portal 无障碍服务未启用") + "，重新启用。")
        if stop.is_set(): raise _Stopped()
        try:
            _shell("settings put secure enabled_accessibility_services " + shlex.quote(":".join(s for s in enabled if s != service)), check=True)
        finally:
            _shell("settings put secure enabled_accessibility_services " + shlex.quote(restored), check=True)
        _shell("settings put secure accessibility_enabled 1", check=True)
        for _ in range(20):
            if not _portal_problem(): break
            if stop.wait(0.25): raise _Stopped()
        else: raise RuntimeError("Portal 无障碍服务重启后仍未绑定或仍在崩溃列表。")
        changed = True
        _repair_note("Portal 无障碍服务已绑定，崩溃状态已清除。")
    changed |= _keyboard(stop, typing)
    if PHONE_PROVIDER == "mac-android" and (
            _shell("getprop ro.debuggable", check=True) == "1" or _shell("id -u", check=True) == "0"):
        changed |= _mock_location(stop)
    return changed


async def _phone_step(fn, reconnect=None, typing: bool = False, portal: bool = True):
    for attempt in range(2):
        try:
            if typing: await _typing_step(lambda stop: _keyboard(stop, True))
            return await fn()
        except (_Refused, _Stopped):
            raise
        except Exception as exc:
            if attempt: raise RuntimeError(f"修复后重试一次仍失败：{type(exc).__name__}: {exc}") from exc
            if not await _typing_step(lambda stop: _preflight(stop, typing, portal)): raise
            _repair_note("已修复，重试失败步骤一次。")
            if reconnect is not None: await reconnect()


async def _driver(repair: bool = True) -> AndroidDriver:
    _load_model()
    config = _mobile_config()
    class ObservedDriver(AndroidDriver):
        async def screenshot(self, hide_overlay=True):
            return await _typing_step(lambda _: _observation("screen"))

        async def input_coordinate_size(self, *_):
            return _observations.size

        async def get_ui_tree(self):
            from mobilerun_core_local.driver.android.adb import _uiautomator_node_to_dict
            root = ET.fromstring(await _typing_step(lambda _: _observation("tree")))
            if PHONE_PROVIDER in ("agentbay", "mac-android"):
                _check_app_login(root)
            bounds = {k: int(root.attrib[k]) for k in ("width", "height")}
            focused = root.find(".//node[@focused='true']")
            # One screen-sized root with every window as its child, as Portal reports it: Mobilerun's tree
            # filters take a single node, so a list of windows failed every step's state read.
            tree = _uiautomator_node_to_dict(root)
            tree["boundsInScreen"] = {"left": 0, "top": 0, "right": bounds["width"], "bottom": bounds["height"]}
            return {"a11y_tree": tree,
                    "phone_state": {"packageName": next(root.iter("node")).get("package", ""),
                                    "focusedElement": _uiautomator_node_to_dict(focused) if focused is not None else None,
                                    "isEditable": focused is not None and focused.get("editable") == "true"},
                    "device_context": {"screen_bounds": bounds, "display_metrics": bounds}}

        _get_ui_tree_adb = get_ui_tree  # upstream's text-clear fallback must never suppress Portal either

    async def connect():
        driver = ObservedDriver(serial=SERIAL, use_tcp=config.device.use_tcp, portal_mode="required")
        await driver.connect()
        return driver
    return await _phone_step(connect) if repair else await connect()


async def _launched_app_tree():
    """A Mac emulator's activity can launch before its accessibility root is published."""
    from mobilerun_core_local.driver.base import DeviceDisconnectedError
    deadline = time.monotonic() + 30
    while True:
        try:
            return ET.fromstring(await _typing_step(lambda _: _observation("tree")))
        except DeviceDisconnectedError as exc:
            if "No active UI root;" not in str(exc) or time.monotonic() >= deadline:
                raise
            await asyncio.sleep(0.5)


REMOTE_MAX_SIDE = 1600


class _Observations:
    """One framed adb pipe per existing phone lease; no capture cache or reconnect/retry."""
    def __init__(self):
        self.process, self.buffer, self.lock = None, b"", threading.Lock()

    def request(self, command):
        with self.lock:
            if self.process is None:
                self._reply()
            return self._reply(command)

    def _reply(self, command=None):
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        started, stage = time.monotonic(), "startup"
        try:
            if self.process is None:
                self.process = subprocess.Popen([ADB, "-s", SERIAL, "shell", "-T",
                    "CLASSPATH=/data/local/tmp/paios-observe.jar app_process /system/bin PhoneObservation"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            if command is not None:
                self.process.stdin.write((command + "\n").encode())
            while True:
                while b"\n" not in self.buffer:
                    remaining = 15 - (time.monotonic() - started)
                    if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                        raise TimeoutError("timed out after 15 s waiting for helper response")
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        detail = os.read(self.process.stderr.fileno(), 1000) if select.select([self.process.stderr], [], [], 0)[0] else b""
                        raise EOFError(f"helper exit={self.process.poll()}; {detail.decode(errors='replace')}")
                    self.buffer += chunk
                line, self.buffer = self.buffer.split(b"\n", 1)
                result = json.loads(line)
                if "stage" in result: stage = result["stage"]
                if result.get("kind") == "error":
                    # A newly launched window can have no accessibility root yet. Wait within this read only.
                    if (command == "tree" and stage == "tree" and
                            result["detail"] == "java.lang.IllegalStateException: No active UI root" and
                            time.monotonic() - started < 5):
                        time.sleep(0.1)
                        self.process.stdin.write(b"tree\n")
                        continue
                    raise ValueError(f"{result['detail']}; device elapsed={result['elapsed_ms']} ms")
                if "kind" in result: return result
        except (TimeoutError, EOFError, OSError, ValueError) as exc:
            raise DeviceDisconnectedError(f"执行手机观测失败 stage={stage}, elapsed={time.monotonic() - started:.2f}s: {exc}") from exc

    def close(self):
        with self.lock:
            if self.process is not None:
                self.process.stdin.close()
                try: self.process.wait(timeout=5)
                except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
                self.process.stdout.close(); self.process.stderr.close()
                self.process, self.buffer = None, b""


def _observation(kind: str) -> bytes:
    session = _observations
    result = session.request(f"screen {REMOTE_MAX_SIDE}" if kind == "screen" else kind)
    if kind == "screen": session.size = (result["width"], result["height"])
    data = base64.b64decode(result["data"])
    return _ScreenImage(data, session.size) if kind == "screen" else data


# Two tiers, chosen by the main brain per task difficulty. Models and endpoints are configuration (the Mobilerun config
# file), never code: each deployment and user may pick their own.
#   fast     — the role profiles, accessibility tree only: clear errands. Default DeepSeek-V4.1-Flash, thinking off.
#   thorough — the `thorough` profile with screenshots for every role: comparing, searching, unlabeled screens, or after
#              the fast tier failed. Default GLM-5.3-Flash on SiliconFlow.
ROLES = ("fast_agent", "app_opener", "structured_output", "manager", "executor")


def _ipv4_clients() -> dict:
    import httpx  # some endpoints publish AAAA records; the async client does not fall back to IPv4 without an IPv6 route
    return dict(http_client=httpx.Client(transport=httpx.HTTPTransport(local_address="0.0.0.0"), timeout=90),
                async_http_client=httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0"), timeout=90))


def _thorough(config) -> None:
    for role in ROLES:
        config.llm_profiles[role] = config.llm_profiles["thorough"]
    config.agent.fast_agent.vision = True
    config.agent.use_normalized_coordinates = True  # vision models answer in 0–1000 coordinates; as pixels they landed ~170 px high


def _bind(config) -> None:
    """Give each role's profile IPv4 transport and its key; a profile names the variable that holds its key file's path."""
    clients = _ipv4_clients()
    for profile in {id(config.llm_profiles[role]): config.llm_profiles[role] for role in ROLES if role in config.llm_profiles}.values():
        kwargs = {**profile.kwargs, **clients}
        if env := kwargs.pop("api_key_file_env", None):
            kwargs["api_key"] = Path(os.environ[env]).read_text().strip()
        profile.kwargs = kwargs


async def _finished(handler):
    return await handler


async def _join_cleanup(work):
    cleanup = asyncio.ensure_future(work)
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            pass  # keep the lease until this same cleanup has finished
    cleanup.result()


async def _payment_screen(guard):
    return await payment_guard._payment_screen(sys.modules[__name__], guard)


async def _cancel_order(config, driver, payment_config, target_order_id=None):
    return await payment_guard._cancel_order(sys.modules[__name__], config, driver, payment_config, target_order_id)


async def _checkpoint_payment(guard, config, app, cancelled=False):
    return await payment_guard._checkpoint_payment(sys.modules[__name__], guard, config, app, cancelled)


async def _open_qwen_order_history(*, ctx):
    """Open the official order-list H5 in Qwen; subsequent inspection remains with the agent."""
    from mobilerun.agent.action_result import ActionResult
    url = "https://tb.ele.me/app/eleme/miniapp-plugin-orderlist/et-index/pages/index/index"
    await _typing_step(lambda _: _shell("am start -W -a android.intent.action.VIEW "
        "-n com.aliyun.tongyi/com.ucpro.MainActivity -d " + shlex.quote(url), True))
    return ActionResult(success=True, summary="已打开千问官方闪购订单页；接下来只读核对本次订单。")


QWEN_TOOLS = {"open_qwen_order_history": {
    "function": _open_qwen_order_history, "parameters": {},
    "description": "在千问内打开官方闪购订单列表（仅导航，不下单、不付款、不修改订单）；随后按屏幕只读核对。",
}}


async def _agent(goal: str, max_steps: int, payment_intent: str | None, tier: str = "fast",
                 screenshot_only: bool = False, driver: AndroidDriver | None = None, ride_ok: bool = False,
                 app: str | None = None) -> dict:
    """The general Mobilerun agent on the current screen (inside an errand)."""
    _load_model()
    if job := _jobs.get(_job_id.get() or ""):
        job["_trace"] = step_trace.StepTrace(lambda force=False: _write_running(_job_id.get(), force=force))
        step_trace.bind(job["_trace"])
    config = _mobile_config()
    config.device.serial = SERIAL
    if screenshot_only:
        tier, config.agent.vision_only = "thorough", True
    config.agent.max_steps = max(1, min(max_steps, 120))
    if tier == "thorough":
        _thorough(config)
    _bind(config)
    driver, before, rides_before = await payment_guard.begin_agent(
        sys.modules[__name__], driver or await _driver(), payment_intent, ride_ok)
    agent = MobileAgent(goal=OPERATING_RULES + goal, config=config, timeout=TASK_TIMEOUT_S, driver=driver,
                        custom_tools=QWEN_TOOLS if app == "千问" else {})
    with contextlib.redirect_stdout(sys.stderr):  # keep Mobilerun's console output off the protocol
        handler = agent.run()
        counter = asyncio.create_task(_count_steps(handler, config.agent.max_steps))
        running = asyncio.ensure_future(_finished(handler))
        reached = asyncio.create_task(driver.reached.wait())
        checkpoint = stopped = False
        try:
            done, _ = await asyncio.wait({running, reached}, timeout=TASK_TIMEOUT_S, return_when=asyncio.FIRST_COMPLETED)
            if driver.reached.is_set():
                checkpoint = driver.login_required is None
                await _join_cleanup(handler.cancel_run())
                outcome = {}
            else:
                if not done:
                    raise asyncio.TimeoutError()
                result = running.result()
                outcome = {"success": bool(result.success), "answer": str(result.reason or ""), "steps": result.steps}
        except (asyncio.TimeoutError, asyncio.CancelledError) as stop:
            if job := _jobs.get(_job_id.get() or ""):
                if trace := job.get("_trace"):
                    trace.stall()
            # Not awaiting a workflow does not stop it: its steps would keep tapping after the phone is released.
            await _join_cleanup(handler.cancel_run())
            stopped = True
            # A user stop still gets the unauthorized-car and payment checks below before it is reported.
            outcome = {"success": False, "steps": None, "answer": STOPPED if isinstance(stop, asyncio.CancelledError) else
                       f"本次已运行 {TASK_TIMEOUT_S}s 仍未完成；先只读核对 App 的订单、行程或消息状态，确认上次操作是否生效，再决定是否继续。"}
        except _AppLoginRequired as exc:
            outcome = {"success": False, "status": "APP_LOGIN_REQUIRED", "login_app": exc.app,
                       "error_code": "APP_LOGIN_REQUIRED", "answer": str(exc), "steps": None}
        except (FileNotFoundError, PermissionError) as exc:
            outcome = {"success": False, "answer": f"执行器本地资源不可用：{type(exc).__name__}",
                       "error_code": "PHONE_LOCAL_RESOURCE_UNAVAILABLE", "steps": None}
        except (ConnectionError, OSError):
            outcome = {"success": False, "answer": "执行手机连接中断，结果未知。", "error_code": "PHONE_DISCONNECTED", "steps": None}
        except Exception as exc:  # noqa: BLE001
            outcome = {"success": False, "answer": f"执行手机出错：{type(exc).__name__}: {exc}"[:500], "steps": None}
        finally:
            counter.cancel()
            reached.cancel()
            running.cancel()
            await asyncio.gather(counter, reached, running, return_exceptions=True)
    return await payment_guard.finish_agent(sys.modules[__name__], driver, config, app, handler, outcome,
                                           checkpoint, stopped, before, rides_before)


@mcp.tool()
async def phone_task(goal: str, max_steps: int = 80, latitude: float | None = None, longitude: float | None = None,
                     payment_intent: str | None = None, app: str | None = None, tier: str = "fast",
                     ride_ok: bool = False, title: str = "", repeat: bool = False, principal_id: str = "", *, effect: dict,
                     job_id: str | None = None, origin_processed_event_id: str | None = None,
                     context: dict | None = None, self_check_of: str | None = None) -> dict:
    """在执行手机（已登录用户的千问、美团、淘宝、滴滴等 App 的安卓设备）上替用户办一件事并返回结果。
    effect 必填：{kind:read|file_edit|send|login|delete|external, task_type:稳定任务类型, requested:是否主人要求, recipient:发送收件人}。首次向某人发送某类任务须由主人确认。
    goal 写成完整、具体、可执行的中文指令：用哪个 App、要做什么、商品/规格/数量、起点终点或收货地址、
    以及停在哪里。需要付款时按下面的 payment_intent 流程；打车只有传了 ride_ok 才能叫车。
    完成后要求回报关键信息（商家、商品、价格、预计时间、车牌等）。一次只办一件事；返回 success/answer/steps。
    后台执行：调用立刻返回 {status: started, job_id}，执行手机在后台办；办完结果会作为一条 errand_result 事件送回会话，
    那时再向用户汇报。所以拿到 started 后只需告诉用户"已经开始办了，好了告诉你"，不要等待、不要重复派同一件事。
    代理运行时限由配置决定，付款卡等候另计；失败、超时或重启后，先派只读任务核对 App 的订单、行程或消息状态，确认上次操作是否生效。
    核对结果回来后再决定是否继续；尚未完成时在 goal 里写"从当前页面继续：…"，不得盲目重新下单、叫车或发消息。
    写 goal 时把取舍提前定好（口味等偏好先向用户问清或取自记忆），例如"中辣、少冰半糖；起送价不够就同款点两杯或换一家起送价低的店；其余规格用推荐默认；不要来回确认"。
    latitude/longitude 只传输入事件 source.location 里的值（用户 iPhone 的实时定位，WGS-84），没有就不传，绝不编造或沿用旧坐标；
    传了执行手机会先把 GPS 移到这里，
    外卖在 goal 里写"收货地址选离当前位置最近的已保存地址"，打车写"起点用当前位置"。
    需要付款的跑腿先调用 paios_payment(action=request)，把返回的 intent_id 作为 payment_intent 传入；goal 写到『点「支付宝付款」付款』为止。执行手机在付款前会自动停下，等主人在付款卡上授权（最多 5 分钟），授权后由执行手机核对屏幕金额等于授权金额才点；没授权就取消这张未付款订单。不传 payment_intent 就停在付款前，绝不付款。永远不输入支付密码。
    ride_ok 只在用户这次要真的叫车时传 true（"帮我叫车去…""打车去…"）；问价、比价、测试不传，叫车按钮（呼叫/确认（…元起））会被拒绝。
    app 填要用的 App 名（千问/淘宝/美团/饿了么/滴滴/高德/支付宝/微信），执行手机会先直接打开它（新任务从首页开始，
    goal 以"从当前页面继续"开头时保留当前页面），代理只在这个 App 里办。
    tier 按难度选：fast（默认，快，只读界面文字）用于目标明确的任务，如按已知偏好直接下单；
    thorough（看截图的强模型，单步慢但少走弯路）用于比价、挑店、找东西、界面没文字标签，或 fast 失败/超时后从当前页面继续。
    title 是给用户看的一句话进度标题（中文，不超过 40 字，如"点一杯香柠养乐多""查打车价格：回家"），App 里的进度条会显示它；每次都传。
    repeat：同一件事正在办、10 分钟内刚办完或刚被用户停下时，默认不会再办一次（返回原来那单的情况）；只有用户明确要求再办一次才传 True。"""
    if (not isinstance(effect, dict) or effect.get("kind") not in {"read", "file_edit", "send", "login", "delete", "external"}
            or not isinstance(effect.get("requested"), bool) or not isinstance(effect.get("task_type"), str)
            or not effect["task_type"].strip() or effect.get("kind") == "send" and not effect.get("recipient")):
        return {"success": False, "status": "rejected", "error_code": "EFFECT_CLASSIFICATION_REQUIRED", "answer": "先声明 effect 的 kind、task_type、requested；发送还需 recipient。任务未开始。", "steps": None}
    if not isinstance(principal_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", principal_id):
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    if job_id is not None and (not isinstance(job_id, str) or not CANCEL_FILE.fullmatch(job_id + ".cancel")):
        raise ValueError("ERRAND_JOB_INVALID")
    if origin_processed_event_id is not None and (not isinstance(origin_processed_event_id, str) or
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", origin_processed_event_id)):
        raise ValueError("ERRAND_ORIGIN_INVALID")
    if self_check_of is not None and (not isinstance(self_check_of, str) or
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", self_check_of)):
        raise ValueError("ERRAND_SELF_CHECK_INVALID")
    if tier not in ("fast", "thorough"):
        return {"success": False, "answer": f"tier 只能是 fast 或 thorough，收到：{tier}", "steps": None}
    tier = "thorough" if app in SCREENSHOT_ONLY else tier  # screenshot-only apps always run on the vision tier
    if app and app not in APPS:
        return {"success": False, "answer": f"不认识的 App：{app}（可用：{'、'.join(APPS)}）", "steps": None}
    if payment_intent and not app:
        return {"success": False, "answer": "付款跑腿必须传 app，与 paios_payment 申请的 App 相同；任务未开始。", "steps": None}
    if PHONE_PROVIDER == "agentbay":
        if app == "微信":
            return {"success": False, "answer": "云手机禁止使用微信。", "steps": None}
        if _login_phone is not None or any(j.get("operation") for j in _jobs.values()):
            return {"success": False, "status": "unavailable", "answer": LOGIN_BUSY, "steps": None}
    if PHONE_PROVIDER == "mac-android":
        mac_binding, host = await asyncio.to_thread(mac_android.request, context)
        if host['status'] != 'ready' and host.get('state') not in {'stopped', 'starting'}:
            return {**host, 'success': False, 'steps': None}
    elif PHONE_PROVIDER != "agentbay" and not await asyncio.to_thread(_online):  # cloud transport is leased inside the errand
        return {"success": False, "status": "unavailable", "answer": OFFLINE, "steps": None}
    task = dict(goal=goal, max_steps=max_steps, latitude=latitude, longitude=longitude, payment_intent=payment_intent, app=app, tier=tier,
                ride_ok=ride_ok)
    if PHONE_PROVIDER == "mac-android":
        task['mac_binding'] = mac_binding
    if not SPOOL:
        return await _errand_task(**task)
    if job_id is not None and (same := _same_errand(goal, app, principal_id, job_id=job_id)) is not None:
        return same
    if not repeat and (same := _same_errand(goal, app, principal_id)) is not None:
        return same
    job_id = job_id or f"job-{uuid.uuid4().hex[:12]}"
    _start(job_id, task, title, principal_id, origin_processed_event_id, self_check_of)
    return {"status": "started", "job_id": job_id,
            "answer": "已在执行手机上开始办理。现在只需告诉用户已经开始、大概几分钟；办完结果会作为 errand_result 事件自动送回，"
                      "届时再汇报。不要等待，也不要重复派同一件事。"}


def _start(job_id: str, task: dict, title: str, principal_id: str, origin_processed_event_id: str | None = None,
           self_check_of: str | None = None) -> None:
    _jobs[job_id] = {"principal_id": principal_id, "goal": task["goal"], "title": _title(title, task["goal"]), "app": task["app"], "tier": task["tier"], "state": "waiting",
                     "payment_intent": task.get("payment_intent"), "phone_started_at": None, "payment_owner": payment_lineage.capture(SPOOL, {**task, "principal_id": principal_id}),
                     "since": time.time(), "started_at": _now(), "step": 0, "max_steps": max(1, min(task["max_steps"], 120)), "written": 0.0,
                     "task": asyncio.create_task(_job(job_id, task))}
    if "operation" in task:
        _jobs[job_id]["operation"] = task["operation"]
    if origin_processed_event_id is not None:
        _jobs[job_id]["origin_processed_event_id"] = origin_processed_event_id
    if self_check_of is not None:
        _jobs[job_id]["self_check_of"] = self_check_of
    _write_running(job_id, force=True)


# ---- background errands: the main agent only dispatches; results come back through the spool as events ----
# job_id -> goal, title, app, tier, state (waiting for the phone / running / stopping), since, started_at, step, max_steps, written, task
_jobs: dict[str, dict] = {}
_job_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("job_id", default=None)
STOPPED = "已按用户要求停止，没有办完。手机停在当时的页面；已经下的单、叫的车不会因此取消，需要取消就再派一次。"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _spool(job_id: str, record: dict, state: str) -> None:
    """Atomically write <job>.<state>.json (owner-only); a done file replaces the job's running marker."""
    folder = Path(SPOOL)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if _receipt_stamp is not None and record.get("kind") != "sms":
        _receipt_stamp(job_id, record, _jobs.get(job_id))
    tmp = folder / f"{job_id}.{state}.json.tmp"
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump(record, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, folder / f"{job_id}.{state}.json")
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    if state == TERMINAL_STATES["pending"]:
        (folder / f"{job_id}.running.json").unlink(missing_ok=True)


def _errand_key(goal: str, app: str | None) -> tuple[str, str]:
    return " ".join(goal.split())[:4000], app or ""


def _terminal_alert(folder: Path, job_id: str) -> None:
    # Notification receipt only; terminal bytes remain the sole authority for duplicate detection.
    try:
        fd = os.open(folder / f"{job_id}.dedup-alert", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return
    else:
        os.close(fd)
    logging.error("ERRAND_DEDUP_STATE_UNKNOWN job=%s: unreadable terminal; inspect the spool before retrying", job_id)


def _dedup_retryable() -> dict:
    return {"success": False, "status": "retryable", "retryable": True, "code": "ERRAND_DEDUP_STATE_UNKNOWN", "steps": None,
            "answer": "暂时无法核验上次跑腿结果，本次没有开始。请稍后重试核验，不要用 repeat=True 绕过核验。"}


def _same_errand(goal: str, app: str | None, principal_id: str, *, job_id: str | None = None) -> dict | None:
    """A repeated dispatch of the same request (a retried tool call, or the model asking twice) must not act on the phone
    again: return the running job, a just-finished result, or a fresh user stop instead of starting another job."""
    key = _errand_key(goal, app)
    for jid, job in _jobs.items():
        if job_id is not None and jid == job_id and job.get("principal_id") != principal_id:
            raise ValueError("ERRAND_JOB_PRINCIPAL_MISMATCH")
        if (jid == job_id if job_id is not None else
                job.get("principal_id") == principal_id and _errand_key(job["goal"], job["app"]) == key):
            return {"status": "already_running", "job_id": jid,
                    "answer": f"这件事已经在办（{jid}），不要重复派；用户问进度就查 phone_status。"}
    now = time.time()
    try:
        folder = Path(SPOOL)
        records = terminal_records(folder, now, job_id=job_id)
        unknown = False
        for jid, (_, record, verified) in records:
            if verified:
                continue
            if job_id is not None:
                return _dedup_retryable()
            if (record is not None and isinstance(record.get("principal_id"), str) and record["principal_id"] and
                isinstance(record.get("task"), str)):
                known_app = (record.get("app") in (None, "") or
                             isinstance(record.get("app"), str) and record["app"] in APPS)
                different_app = ("app" in record and known_app and
                                 _errand_key(record["task"], record["app"]) != key)
                unknown |= (record["principal_id"] == principal_id and
                            _errand_key(record["task"], None)[0] == key[0] and not different_app)
            else:
                _terminal_alert(folder, jid)
                unknown = True
        if unknown:
            return _dedup_retryable()
    except (OSError, ValueError) as exc:
        logging.warning("errand duplicate check unavailable: %s", exc)
        return _dedup_retryable()
    for _, (_, record, verified) in sorted(records, key=lambda item: item[1][0], reverse=True):
        if record is None or not verified:
            continue
        if job_id is not None:
            if record["principal_id"] != principal_id:
                raise ValueError("ERRAND_JOB_PRINCIPAL_MISMATCH")
            return {"status": "duplicate", "job_id": job_id,
                    "answer": f"这次调用已结束：{record['answer'][:300]}。不要重复执行；新的用户请求须使用新的调用。"}
        if record["principal_id"] != principal_id or _errand_key(record["task"], record.get("app")) != key:
            continue
        if record.get("terminal_reason") == "cancelled_by_user":
            return {"status": "cancelled_recently", "job_id": record.get("job_id"),
                    "answer": "用户刚让这件事停下了；不要自动重办。只有用户再次明确要求，才带 repeat=True 重新派。"}
        if record.get("success") or record.get("terminal_reason") == "completed":
            return {"status": "duplicate", "job_id": record.get("job_id"),
                    "answer": f"这件事刚办完：{str(record.get('answer', ''))[:300]}。不要重复办；用户明确要再来一次才带 repeat=True。"}
        return None  # failed / timed out / interrupted: the model must reconcile App state before continuing
    return None


def _title(title: str, goal: str) -> str:
    line = " ".join((title or (goal.strip().splitlines() or [""])[0]).split())
    if len(line) <= 40:
        return line
    boundary = max((match.start() for match in re.finditer(r"[\s，,、。.!！?？:：;；]+", line[:40])), default=0)
    return line[:boundary].rstrip(" ，,、。.!！?？:：;；") + "…"


def _write_running(job_id: str, force: bool = False, *, durable: bool = False) -> None:
    """Rewrite the running marker the gateway shows as progress. Only while the job is in _jobs: _job drops it before the
    done record is written, so a late step event can never resurrect a finished job's marker. Step writes: <= 1 per second."""
    job = _jobs.get(job_id)
    if job is None or job.get("tier") == "deterministic" or not SPOOL or (not force and time.time() - job["written"] < 1):
        return
    job["written"] = time.time()
    try:
        _spool(job_id, {"principal_id": job["principal_id"], "job_id": job_id, "task": job["goal"][:4000], "title": job["title"], "app": job["app"], "tier": job["tier"],
                        "state": job["state"], "started_at": job["started_at"], "step": job["step"], "max_steps": job["max_steps"],
                        **step_trace.snapshot(job),
                        **({"payment_intent": job["payment_intent"]} if job.get("payment_intent") else {}),
                        **{key: job[key] for key in ("payment_owner", "payment_binding", "phone_started_at", "payment_page_left", "origin_processed_event_id", "self_check_of") if key in job},
                        **({"title": _title("手机自修复：" + job["repair"], "")} if job.get("repair") else {})}, "running")
    except OSError as exc:
        if durable:
            raise
        print(f"errand marker write failed for {job_id}: {exc}", file=sys.stderr)


async def _count_steps(handler, max_steps: int) -> None:
    """Mobilerun forwards every agent step on the workflow's event stream: one FastAgentResponseEvent per LLM step
    (ManagerPlanEvent in reasoning mode). Count them for the progress marker; never affects the run itself."""
    from mobilerun.agent.droid.events import ManagerPlanEvent
    from mobilerun.agent.fast_agent.events import FastAgentResponseEvent
    try:
        async for ev in handler.stream_events():
            if job := _jobs.get(_job_id.get() or ""):
                if trace := job.get("_trace"):
                    trace.event(ev)
            if isinstance(ev, (FastAgentResponseEvent, ManagerPlanEvent)) and (job := _jobs.get(_job_id.get() or "")) is not None:
                job["step"] = min(job["step"] + 1, max_steps)
                job.pop("repair", None)
                _write_running(_job_id.get(), force=job["step"] == 1)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — progress is best-effort
        print(f"step stream ended: {type(exc).__name__}: {exc}", file=sys.stderr)


async def _job(job_id: str, task: dict) -> None:
    _job_id.set(job_id)
    try:
        result = (await _payment_check(task) if task.get("payment_check") else
                  await _phone_operation(task) if "operation" in task else await _errand_task(**task))
    except asyncio.CancelledError:  # phone_cancel: the agent has stopped acting; report it like any other end
        result = {"success": False, "answer": STOPPED + (("\n" + " ".join(_repairs.get())) if _repairs.get() else "")}
    except TimeoutError:
        result = {"success": False, "answer": "执行手机任务超时，结果未知。", "terminal_reason": "timed_out"}
    except (FileNotFoundError, PermissionError) as exc:
        result = {"success": False, "answer": f"执行器本地资源不可用：{type(exc).__name__}",
                  "error_code": "PHONE_LOCAL_RESOURCE_UNAVAILABLE"}
    except (ConnectionError, OSError):
        result = {"success": False, "answer": "执行手机连接中断，结果未知。", "error_code": "PHONE_DISCONNECTED"}
    except Exception as exc:  # noqa: BLE001 — every job must end with a delivered result
        result = {"success": False, "answer": f"执行手机出错：{type(exc).__name__}: {exc}"[:500]
                  + (("\n" + " ".join(_repairs.get())) if _repairs.get() else ""),
                  **({"error_code": exc.code} if _receipt_stamp is not None and hasattr(exc, "code") else {})}
    finally:
        job = _jobs.pop(job_id, None)
    if "operation" in task and not result.get("success"):
        import agentbay_phone
        agentbay_phone.progress("failed", "云手机步骤失败，请检查状态", error=result["answer"][:500])
    # A user stop is final; retryable failures require model-led App reconciliation before continuing.
    answer = str(result.get("answer") or "")
    reason = ("cancelled_by_user" if (job or {}).get("state") == "stopping" or answer == STOPPED else
              "completed" if result.get("success") else "timed_out" if result.get("terminal_reason") == "timed_out" or "仍未完成" in answer else "failed")
    _spool(job_id, step_trace.partial_result({"principal_id": job["principal_id"], "job_id": job_id, "task": task["goal"][:4000], "app": task["app"], "tier": task["tier"],
                    **({"payment_intent": task["payment_intent"]} if task.get("payment_intent") else {}),
                    **{key: job[key] for key in ("payment_owner", "payment_binding", "phone_started_at", "payment_page_left", "started_at", "origin_processed_event_id", "self_check_of", "receipt_revision", "task_type") if job and key in job},
                    **payment_lineage.terminal(job or task, result),
                    "success": bool(result.get("success")), "answer": answer[:8000], "finished_at": _now(),
                    "title": job["title"], "evidence_ref": {"tool": "phone_status", "job_id": job_id},
                    **step_trace.snapshot(job, terminal=True),
                    **{key: result[key] for key in ("status", "error_code", "login_app", "effect_evidence", "observed_values", "observed_content") if key in result},
                    "terminal_reason": reason, "retryable": reason in ("failed", "timed_out") and not task.get("payment_intent")
                    and result.get("error_code") != "APP_LOGIN_REQUIRED" and "operation" not in task}), TERMINAL_STATES["pending"])


@mcp.tool()
async def phone_status(context: dict | None = None, principal_id: str = "", job_id: str | None = None) -> dict:
    """查询当前主人的运行中任务和最近 600 秒的持久终态（state/success/terminal_reason/answer/finished_at）。
    job_id 可精确读取超过 600 秒的终态及内部 trace。principal_id 由原生 run 绑定。Mac 安卓另含宿主状态，云手机另含控制链接；空列表不证明结果或确认状态。"""
    result = job_status(SPOOL, _jobs, principal_id, job_id=job_id)
    if PHONE_PROVIDER == "agentbay":
        import agentbay_phone
        result.update(agentbay_phone.status())
    elif PHONE_PROVIDER == "mac-android":
        _, host = await asyncio.to_thread(mac_android.request, context)
        result.update(host)
    return result


def _dispatch_phone(operation, principal_id, *, purpose="login", apps=(), job_id=None, origin_processed_event_id=None,
                    self_check_of: str | None = None):
    if PHONE_PROVIDER == "mac-android":
        return {"status": "unavailable", "answer": "Mac 安卓使用常驻设备，请在 Mac 上登录；无需恢复、保存或释放云会话。"}
    if PHONE_PROVIDER != "agentbay":
        return {"status": "unavailable", "answer": "当前使用实体手机，请在实体手机上登录。"}
    if not SPOOL:
        raise ValueError("后台云手机需要配置 PAIOS_ERRAND_SPOOL")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", principal_id):
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    import agentbay_phone
    packages = tuple(APPS.get(app, app) for app in apps)
    if not all(package in agentbay_phone.APP_PACKAGES for package in packages):
        raise ValueError("仅支持千问、淘宝、支付宝、米家；云手机禁止微信")
    if purpose not in ("login", "errand"):
        raise ValueError("purpose 只能是 login 或 errand")
    if _jobs or _login_lease is not None and _login_phone is None:
        return {"status": "busy", "answer": "云手机正在执行后台步骤，请先查询 phone_status。"}
    if operation == "start" and _login_phone is not None:
        return {"status": "ready", "answer": "云手机已经打开，请查询控制链接。"}
    if operation != "start" and _login_phone is None:
        return {"status": "unavailable", "answer": "没有打开的云手机，请先 phone_start。"}
    job_id = job_id or f"job-{uuid.uuid4().hex[:12]}"
    task = dict(operation=operation, purpose=purpose, packages=packages, goal={
        "start": "启动云手机", "restore": "恢复所选 App 数据", "save": "保存所选 App 数据", "close": "关闭云手机"
    }[operation], app=None, tier="lifecycle", max_steps=1)
    _start(job_id, task, task["goal"], principal_id, origin_processed_event_id, self_check_of)
    return {"status": "started", "job_id": job_id, "summary": task["goal"],
            "answer": task["goal"] + "已在后台开始；用 phone_status 查看进展，结果由 errand_result 返回。"}


async def _phone_operation(task):
    global _login_phone, _login_lease
    import agentbay_phone
    async with _one_phone:
        job = _jobs[_job_id.get()]
        if _before_phone_operation is not None:
            _before_phone_operation(job)
        job.update(state="running", since=time.time())
        _write_running(_job_id.get(), force=True)
        if task["operation"] == "start":
            lock = _device_lease()
            await lock.__aenter__()
            try:
                _login_phone = await agentbay_phone.lease(task["purpose"])
            except BaseException:
                _login_lease = lock
                asyncio.create_task(_reap_login(lock))
                raise
            _login_lease = lock
            _login_phone._expiry = asyncio.create_task(_login_expiry(_login_phone))
        elif task["operation"] == "close":
            try:
                await _close_login()
            except Exception:
                _login_phone._expiry.cancel()
                _login_phone._expiry = asyncio.create_task(_login_expiry(_login_phone, LOGIN_RETRY_S))
                raise
        else:
            work = asyncio.create_task(asyncio.to_thread(agentbay_phone.sync_data, _login_phone,
                task["packages"], "download" if task["operation"] == "restore" else "upload"))
            await _join_cleanup(work)
        return {"success": True, "answer": task["goal"] + "完成。",
                **({"effect_evidence": [{"kind": job["effect_kind"], "target": "执行手机", "action": task["goal"],
                     "verification": "service_ack", "evidence": "云手机服务确认操作完成", "ref": None}]}
                   if "effect_kind" in job else {})}


@mcp.tool()
async def phone_start(principal_id: str, purpose: str = "login", job_id: str | None = None,
                      origin_processed_event_id: str | None = None, context: dict | None = None,
                      self_check_of: str | None = None) -> dict:
    """启动执行手机。Mac 安卓请求启动已安装的常驻设备；云手机后台创建会话。用 phone_status 查看状态。"""
    if PHONE_PROVIDER == "mac-android":
        _, host = await asyncio.to_thread(mac_android.request, context, 'start')
        return host
    return _dispatch_phone("start", principal_id, purpose=purpose, job_id=job_id,
                           origin_processed_event_id=origin_processed_event_id, self_check_of=self_check_of)


@mcp.tool()
async def phone_control_link(context: dict | None = None, principal_id: str = "") -> dict:
    """立即返回已生成的云手机控制链接；尚在创建时查询 phone_status，不重复启动。链接仅发给主人。"""
    return await phone_status(context, principal_id)


@mcp.tool()
async def phone_restore_apps(apps: list[str], principal_id: str, job_id: str | None = None,
                             origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> dict:
    """后台恢复指定 App（千问/淘宝/支付宝/米家）的已保存数据；先给出控制链接，再按需恢复。"""
    return _dispatch_phone("restore", principal_id, apps=apps, job_id=job_id,
                           origin_processed_event_id=origin_processed_event_id, self_check_of=self_check_of)


@mcp.tool()
async def phone_save_apps(apps: list[str], principal_id: str, job_id: str | None = None,
                          origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> dict:
    """主人确认登录完成后，仅后台保存指定 App；恢复未完成的 App 禁止上传，关闭不会自动保存。"""
    return _dispatch_phone("save", principal_id, apps=apps, job_id=job_id,
                           origin_processed_event_id=origin_processed_event_id, self_check_of=self_check_of)


@mcp.tool()
async def phone_close(principal_id: str, job_id: str | None = None,
                      origin_processed_event_id: str | None = None, self_check_of: str | None = None) -> dict:
    """后台关闭并释放云手机，不自动保存；需要保留登录时先 phone_save_apps 并确认成功。"""
    return _dispatch_phone("close", principal_id, job_id=job_id,
                           origin_processed_event_id=origin_processed_event_id, self_check_of=self_check_of)


@mcp.tool()
async def phone_cancel(job_id: str | None = None) -> dict:
    """立刻让执行手机停手（不传 job_id 就停正在办的那个）。用户说"停""别办了""不要了"时调用。
    只是停止操作：已经下的单、叫的车不会因此取消；停下后要取消订单或行程，再派一次 phone_task 去取消。
    停下的任务仍会以 errand_result 回来（写明已停止）。"""
    targets = {jid: job["task"] for jid, job in _jobs.items() if jid == job_id or (job_id is None and job["state"] in ("running", "stopping"))}
    if not targets:
        return {"stopped": [], "answer": "执行手机上没有正在办的任务。"}
    if any(_jobs[jid].get("operation") for jid in targets):
        for jid in targets:
            _request_stop(jid, _jobs[jid])
        return {"stopping": list(targets), "answer": "已请求停止云手机步骤，后台清理完成后会返回结果。"}
    await _stop(targets)
    return {"stopped": list(targets), "answer": "执行手机已停手，停在当时的页面。"}


def _request_stop(jid: str, job: dict) -> None:
    if job["state"] != "stopping":
        job["state"] = "stopping"
        _write_running(jid, force=True)
        # Let a newly queued job enter its cleanup handler before cancellation.
        asyncio.get_running_loop().call_soon(job["task"].cancel)


async def _stop(targets: dict[str, asyncio.Task]) -> None:
    for jid in targets:
        if (job := _jobs.get(jid)) is not None:
            _request_stop(jid, job)
    await asyncio.gather(*(asyncio.shield(task) for task in targets.values()), return_exceptions=True)


CANCEL_FILE = re.compile(r"job-[0-9a-f]{12}\.cancel")


def _scan_cancels() -> None:
    """Discover stop markers; the job owns and joins its cleanup while retaining the phone lease."""
    if not SPOOL or not Path(SPOOL).is_dir():
        return
    for marker in sorted(Path(SPOOL).iterdir()):
        if not CANCEL_FILE.fullmatch(marker.name):
            continue
        try:
            if (job := _jobs.get(marker.stem)) is not None:
                _request_stop(marker.stem, job)
            marker.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001 — a bad file must not take the server down
            print(f"cancel marker {marker.name} failed: {type(exc).__name__}: {exc}", file=sys.stderr)


REQUEST_FILE = re.compile(r"job-[0-9a-f]{12}\.request\.json")


def _sms_nodes() -> list:
    return list(ET.fromstring(_observation("tree")).iter("node"))


def _sms_sent(to: str, text: str) -> set[str] | None:
    # Evidence of submission, not delivery. Unreadable evidence must not prevent the emergency send.
    where = f"address='{to}' AND body='{text.replace(chr(39), chr(39) * 2)}'"
    try:
        output = _shell("content query --uri content://sms/sent --projection _id --where " + shlex.quote(where), check=True)
    except (RuntimeError, subprocess.TimeoutExpired):
        return None
    if output == "No result found.":
        return set()
    rows = re.findall(r"^Row: \d+ _id=(\d+)$", output, re.M)
    if not rows or len(rows) != len(output.splitlines()):
        return None
    return set(rows)


def _sms_send(to: str, text: str, barrier, stop: threading.Event, evidence: dict) -> None:
    if not evidence.get("attempted"):
        before = _sms_sent(to, text)
        _ensure_unlocked(stop)
        if stop.is_set():
            raise _Stopped()
        _shell("am start -W -a android.intent.action.SENDTO -d " + shlex.quote("smsto:" + to)
               + " --es sms_body " + shlex.quote(text), check=True)
        nodes = _sms_nodes()
        packages = {"com.android.messaging", "com.google.android.apps.messaging", "com.android.mms"}
        # The title shows the number, or the contact's name when the number is saved (emergency contacts usually are).
        try:  # an unreadable contacts provider only narrows the check to the number; it never blocks the send
            found = re.search(r"display_name=(.*)$", _shell(f"content query --uri content://com.android.contacts/phone_lookup/{to} --projection display_name"), re.M)
        except (RuntimeError, subprocess.TimeoutExpired):
            found = None
        shown = {to} | ({found.group(1).strip()} if found else set())
        compose = [n for n in nodes if n.get("resource-id") in {p + ":id/compose_message_text" for p in packages}
                   and n.get("text") == text]
        recipients = [n for n in nodes if n.get("resource-id", "").split(":id/")[-1] in
                      {"", "recipient_text_view", "contact_name", "recipient_text", "recipient_number"}
                      and n.get("package") in packages and (re.sub(r"[ ()-]", "", n.get("text", "")) in shown or n.get("text", "").strip() in shown)]
        send = [n for n in nodes if n.get("resource-id") in {f"{p}:id/{b}" for p in packages for b in ("send_message_button", "send_btn_rcs")}
                and n.get("enabled") == "true" and n.get("clickable") == "true"]
        if len(compose) != 1 or len(recipients) != 1 or len(send) != 1 or compose[0].get("package") != send[0].get("package"):
            raise RuntimeError("短信界面不符合已支持合同，未点击发送")
        bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", send[0].get("bounds", ""))
        if not bounds:
            raise RuntimeError("短信发送按钮位置无效")
        x0, y0, x1, y1 = map(int, bounds.groups())
        if x1 <= x0 or y1 <= y0 or stop.is_set():
            raise _Stopped()
        evidence["before"] = before
        barrier()  # fsynced before the only send input: restart can never blindly send it again
        if stop.is_set():
            raise _Stopped()
        evidence["attempted"] = True
        try:
            _shell(f"input tap {(x0 + x1) // 2} {(y0 + y1) // 2}", check=True)
        except _SMSExpired:
            evidence["attempted"] = False  # the input boundary refused the tap before dispatch
            raise
    before = evidence["before"]
    unreadable = before is None
    for _ in range(10):  # bounded observation, never a send retry
        after = _sms_sent(to, text)
        if before is not None and after is not None and after - before:
            return
        unreadable |= after is None
        if stop.is_set():
            raise _Stopped()
        time.sleep(0.5)
    raise RuntimeError("已尝试发送，但" + ("短信已发送记录无法读取，发送状态未核验" if unreadable else
                       "未核验到新的短信已发送记录") + "；禁止自动重发")


async def _sms_job(job_id: str, request: dict) -> None:
    _job_id.set(job_id)
    notes = []
    _repairs.set(notes)
    record = {"principal_id": request["principal_id"], "job_id": job_id, "kind": "sms", "task": request["text"], "title": request["title"],
              "app": "短信", "tier": "deterministic", "state": "waiting", "started_at": _now(), "step": 0, "max_steps": 1}
    attempted, verified = False, False
    evidence = {}
    deadline = request.get("deadline_ms", 0) / 1000  # legacy requests have already expired
    token = _sms_deadline.set(deadline)
    expiry = asyncio.timeout(deadline - time.time())
    def barrier():
        nonlocal attempted
        record["sms_phase"] = "send_attempted"
        _spool(job_id, record, "running")
        attempted = True
    try:
        _check_sms_deadline()
        async with expiry:
            if PHONE_PROVIDER in ("agentbay", "mac-android"):
                raise _Refused("执行手机没有真实 SIM，不能发送短信。主人的短信必须由真实手机发送。")
            # Earlier deterministic requests finish serially before the bounded model-lock wait begins.
            for jid, job in list(_jobs.items()):
                if jid == job_id:
                    break
                if job.get("tier") == "deterministic":
                    await asyncio.shield(asyncio.gather(job["task"], return_exceptions=True))
            # Cancel model work without awaiting its possibly hung provider. Its own lock remains until inputs stop.
            for jid, job in list(_jobs.items()):
                if jid != job_id and job.get("tier") != "deterministic":
                    _request_stop(jid, job)
            await asyncio.wait_for(_one_phone.acquire(), 15)
            try:
                _check_sms_deadline()
                async with _device_lease():
                    if not await asyncio.to_thread(_online, True):
                        raise RuntimeError(OFFLINE)
                    record["state"] = "running"
                    await _typing_step(lambda stop: _preflight(stop, portal=False))
                    expiry.reschedule(None)  # input guards remain; sent-row verification may finish after the deadline
                    await _phone_step(lambda: _typing_step(lambda stop: _sms_send(request["to"], request["text"], barrier, stop, evidence)), portal=False)
                    verified = True
            finally:
                global _own_input_until
                _own_input_until = time.time()
                _one_phone.release()
                _sleep_later()
        result = {"success": True, "answer": "已核验新的短信已发送记录（不代表收件人已收到）", "terminal_reason": "completed"}
    except (Exception, asyncio.CancelledError) as exc:
        if not evidence.get("attempted") and (isinstance(exc, _SMSExpired) or expiry.expired()):
            result = {"success": False, "answer": "短信未发送：等待结果的期限已过。", "terminal_reason": "timed_out"}
        else:
            result = {"success": verified, "answer": f"{'短信已核验发送；【手机收尾】未确认完成' if verified else '短信发送状态未核验' if attempted else '短信未完成'}：{type(exc).__name__}: {exc}"[:500],
                      "terminal_reason": "completed" if verified else "interrupted" if attempted else "failed"}
    finally:
        _sms_deadline.reset(token)
    result["answer"] += ("\n" + " ".join(notes)) if notes else ""
    _spool(job_id, {**record, **result, "finished_at": _now(), "retryable": False}, TERMINAL_STATES["pending"])
    _jobs.pop(job_id, None)


def _scan_requests() -> None:
    """Accept only structured SMS requests; a durable job claim prevents replay after restart."""
    if not SPOOL or not Path(SPOOL).is_dir():
        return
    for request in sorted(Path(SPOOL).iterdir()):
        if not REQUEST_FILE.fullmatch(request.name):
            continue
        job_id = request.name.split(".")[0]
        body = {}
        try:
            if job_id not in _jobs and not any(p != request for p in Path(SPOOL).glob(f"{job_id}.*.json")):
                body = json.loads(request.read_text())
                if (not isinstance(body.get("principal_id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", body["principal_id"]) or body.get("kind") != "sms" or body.get("job_id") != job_id or
                    not isinstance(body.get("to"), str) or not re.fullmatch(r"\+?[0-9]{7,15}", body["to"]) or
                    not isinstance(body.get("text"), str) or not 1 <= len(body["text"]) <= 2000 or "\x00" in body["text"] or
                    type(body.get("deadline_ms", 0)) is not int or not 0 <= body.get("deadline_ms", 0) <= 2**53 - 1):
                    raise ValueError("invalid structured SMS request")
                body["title"] = _title(str(body.get("title", "")), "紧急短信")
                _spool(job_id, {"principal_id": body["principal_id"], "job_id": job_id, "kind": "sms", "task": body["text"], "sms_phase": "claimed",
                                "sms_request": body}, "running")
                _jobs[job_id] = {"principal_id": body["principal_id"], "goal": body["text"], "title": body["title"], "app": "短信", "tier": "deterministic",
                                 "state": "waiting", "since": time.time(), "task": asyncio.create_task(_sms_job(job_id, body))}
            request.unlink(missing_ok=True)
        except Exception as exc:  # malformed requests remain visible, never an LLM goal
            principal = body.get("principal_id") if isinstance(body, dict) else None
            if not isinstance(principal, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", principal):
                request.replace(request.with_name(f"{job_id}.{TERMINAL_STATES['quarantined']}.json"))
                continue
            _spool(job_id, {"principal_id": principal, "job_id": job_id, "task": "短信请求", "success": False, "answer": str(exc)[:500],
                            "finished_at": _now(), "terminal_reason": "failed", "retryable": False}, TERMINAL_STATES["pending"])
            request.unlink(missing_ok=True)


async def _cancel_poller() -> None:
    while True:
        try:
            _scan_requests()
            _scan_cancels()
        except Exception as exc:  # noqa: BLE001
            print(f"cancel poller: {type(exc).__name__}: {exc}", file=sys.stderr)
        await asyncio.sleep(1)


def _recover_interrupted() -> None:
    """Jobs still marked running when the executor (re)starts were cut off; report them instead of losing them."""
    if not SPOOL or not Path(SPOOL).is_dir():
        return
    for marker in Path(SPOOL).glob("*.running.json"):
        try:
            started = json.loads(marker.read_text())
        except ValueError:
            marker.replace(marker.with_name(marker.name.replace(".running.json", f".{TERMINAL_STATES['quarantined']}.json")))
            continue
        if (not isinstance(started, dict) or started.get("job_id") != marker.name.split(".")[0] or
            not isinstance(started.get("principal_id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", started["principal_id"])):
            marker.replace(marker.with_name(marker.name.replace(".running.json", f".{TERMINAL_STATES['quarantined']}.json")))
            continue
        if started.get("kind") == "sms" and any((Path(SPOOL) / f"{started['job_id']}.{state}.json").exists()
                                               for state in TERMINAL_STATES.values()):
            marker.unlink(missing_ok=True)
            continue
        if started.get("kind") == "sms" and started.get("sms_phase") == "claimed" and "sms_request" in started:
            # No send barrier was crossed. Restore the durable request before releasing the claim.
            _spool(started["job_id"], started["sms_request"], "request")
            marker.unlink(missing_ok=True)
            continue
        if started.get("state") == "waiting" and "phone_started_at" not in started:
            started["phone_started_at"] = None
        for key in ("state", "step", "max_steps"):
            started.pop(key, None)
        _spool(started["job_id"], step_trace.partial_result({**started, **step_trace.snapshot(started, terminal=True),
                                   "evidence_ref": {"tool": "phone_status", "job_id": started["job_id"]}, "success": False, "finished_at": _now(), "terminal_reason": "interrupted", "retryable": started.get("kind") != "sms" and started.get("tier") != "lifecycle" and not started.get("payment_intent"),
                                   **payment_lineage.terminal(started, {}),
                                   "answer": ("短信执行中断，发送状态未知；禁止自动重发，请人工核对。" if started.get("kind") == "sms" else
                                              "云手机步骤因执行器重启中断；先查 phone_status，按 cloud-phone 技能处理，不重复发起原步骤。" if started.get("tier") == "lifecycle" else
                                              "【付款结果不明】执行手机重启，付款状态没有确认；未尝试取消未付款订单。请只读核对订单，不会再付一次。" if started.get("payment_intent") else
                                              "执行手机在办理时被重启，任务中断，操作结果未知；先只读核对 App 的订单、行程或消息状态，"
                                              "确认上次操作是否生效，再决定是否从当前页面继续；不要盲目重新下单、叫车或发消息。")}), TERMINAL_STATES["pending"])


async def _errand_task(goal: str, max_steps: int, latitude: float | None, longitude: float | None,
                       payment_intent: str | None, app: str | None, tier: str, ride_ok: bool = False, mac_binding=None) -> dict:
    if payment_intent and os.environ.get("PAIOS_STAGE") == "staging":
        return {"success": False, "answer": "测试付款只允许假收银台，不能使用真实执行手机。", "steps": None}
    if ride_ok and os.environ.get("PAIOS_STAGE") == "staging":
        return {"success": False, "answer": "测试环境不能真的叫车。请用假手机验证叫车请求，或只查询价格。", "steps": None}
    notes = []
    job = _jobs.get(_job_id.get())
    _repairs.set(notes)
    continuation = goal.startswith("从当前页面继续")
    try:
        async with _errand(latitude, longitude, payment_intent, continuation=continuation, mac_binding=mac_binding):
            owner = (job or {}).get("payment_owner")
            driver = None
            if app:
                if continuation:
                    driver = await _driver()  # Reconciliation and a new intent retain the exact same order page.
                else:
                    # Connect Portal from home for a new errand; some foreground apps hide its keyboard/tree.
                    await _phone_step(lambda: _typing_step(lambda _: _shell("input keyevent KEYCODE_HOME", True)))
                    if job is not None:
                        job["payment_page_left"] = True
                        _write_running(_job_id.get(), force=True, durable=True)
                    await asyncio.sleep(0.5)
                    driver = await _driver()
                    await _phone_step(lambda: _typing_step(lambda _: _shell(f"am force-stop {APPS[app]}", True)))
                    await _phone_step(lambda: driver.start_app(APPS[app]))
                    await asyncio.sleep(2)
                if PHONE_PROVIDER == "mac-android":
                    _check_app_login(await _launched_app_tree())
                elif PHONE_PROVIDER == "agentbay":
                    _check_app_login(ET.fromstring(await _typing_step(lambda _: _observation("tree"))))
                goal = f"（{app} 已经打开，就在 {app} 里完成）{goal}"
            if latitude is not None and longitude is not None:
                goal = f"【本次用户当前位置 WGS-84：纬度 {latitude:.6f}，经度 {longitude:.6f}】\n" + goal
            reconciliation = payment_lineage.binding(owner)
            if owner:
                from payment_checkpoint import PaymentError
                observer = CheckoutStop(driver or await _driver())
            result = await _agent(goal, max_steps, payment_intent, tier, screenshot_only=app in SCREENSHOT_ONLY, driver=driver,
                                  ride_ok=ride_ok, app=app)
            if owner:
                try:
                    current = await _payment_screen(observer)
                    result["payment_observation"] = current.reconciliation(reconciliation) if reconciliation else {"state": "unknown"}
                except PaymentError:
                    result["payment_observation"] = {"state": "unknown"}
                # The existing errand wire carries answer; keep the authoritative observation through that boundary.
                result["answer"] = "【付款核对】" + json.dumps(result["payment_observation"], ensure_ascii=False) + "\n" + result["answer"]
    except _AppLoginRequired as exc:
        result = {"success": False, "status": "APP_LOGIN_REQUIRED", "login_app": exc.app,
                  "error_code": "APP_LOGIN_REQUIRED", "answer": str(exc), "steps": None}
    except mac_android.Unavailable as exc:
        result = {"success": False, "status": "unavailable", "answer": str(exc), "steps": None}
    except RuntimeError as exc:
        result = {"success": False, "answer": str(exc), "steps": None,
                  **({"error_code": exc.code} if _receipt_stamp is not None and hasattr(exc, "code") else {})}
    if login := re.match(r"APP_LOGIN_REQUIRED: (千问|淘宝|支付宝|米家)(?:[。\s]|$)", result["answer"]):
        result.update(success=False, status="APP_LOGIN_REQUIRED", error_code="APP_LOGIN_REQUIRED", login_app=login[1])
    result.update(payment_lineage.terminal(job or {}, result))
    result["answer"] += ("\n" + " ".join(notes)) if notes else ""
    return result


if __name__ == "__main__":
    _recover_interrupted()
    mcp.run("stdio")
