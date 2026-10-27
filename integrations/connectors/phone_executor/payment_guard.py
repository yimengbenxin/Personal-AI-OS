"""Payment and ride input authority, current-order evidence and checkpoint handoff.

The executor supplies its live device/runtime port. Job and lease state stay with that owner.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import re
import sys
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path
from typing import NamedTuple
import payment_lineage

class _Refused(RuntimeError):
    """A safety refusal is final, not a device failure to repair and retry."""


class _AppLoginRequired(_Refused):
    def __init__(self, app):
        self.app = app
        super().__init__(f"APP_LOGIN_REQUIRED: {app}。请按 cloud-phone 技能，用 phone_start 打开云手机让主人登录；本次任务未完成。")


# Checkout screens: 支付宝收银台/AI付 (in-app SDK), 支付宝 App, 微信支付, 云闪付, other cashiers.
CHECKOUT = re.compile(r"com\.alipay\.android\.msp|com\.eg\.android\.AlipayGphone|plugin\.wallet|com\.unionpay|cashier", re.I)


def _at_checkout(runtime) -> bool:
    return bool(CHECKOUT.search(runtime._shell("dumpsys window | grep mCurrentFocus")))


def _screen_texts(runtime) -> list[str]:
    return [t for t, *_ in runtime._tree() if t]


# A cashier asking for the payment password or a fingerprint is not password-free: the cloud agent never answers it.
VERIFY_PROMPT = re.compile(r"支付密码|验证指纹|指纹验证|面容|刷脸|人脸验证|短信验证码")


def _checkout_amount(runtime, texts: list[str] | None = None) -> float | None:
    """A single readable cashier amount; conflicting readable values are unknown."""
    texts = runtime._screen_texts() if texts is None else texts
    marked = [float(v) for v in YUAN.findall(" ".join(texts))]
    bare = [float(t) for t in texts if re.fullmatch(r"\d{1,6}\.\d{2}", t)]
    found = set(marked + bare)
    return next(iter(found)) if len(found) == 1 else None


# With 小额免密 on, an order-card payment button can pay immediately without a cashier screen.
# Judge what each tap lands on by the screen as well as the accessibility tree: image/WebView-rendered
# payment buttons may be absent from the tree, so a tree-only guard cannot protect a tap to read the card.
# Use charge vocabulary, not a phrase list: unknown one-tap/submit labels must stop, never be tried. Substrings also
# catch amount-bearing buttons (「确认付款 ¥16.60」) and OCR-merged bars (「合计¥16.6提交订单」).
PAY_BUTTON = re.compile(r"下单|免密|付款|买单|结账|提交订单|支付(?!宝)|购买")
PAY_NAVIGATION = re.compile(r"\s*(?:立即购买|支付方式|付款方式|购买须知|购买记录|购买说明)\s*")
CONFIRM_BUTTON = re.compile(r"提交|确认|立即|购买")
TOTAL_LABEL = re.compile(r"^(总计|实付|合计|应付|实付款|需付款)")
YUAN = re.compile(r"[¥￥]\s*(\d{1,6}(?:\.\d{1,2})?)(?![\d.])")


class _ScreenImage(bytes):
    """Keep the helper's original screenshot dimensions alongside its resized bytes."""
    def __new__(cls, data, capture_size):
        image = super().__new__(cls, data)
        image.capture_size = capture_size
        return image


class _NativeRead(list):
    def __init__(self, viewport):
        super().__init__()
        self.viewport = viewport


class _NativeText(tuple):
    """Tuple projection keeps the released guard ABI; ancestry remains available to the observation owner."""
    def __new__(cls, text, bounds, path, ancestors, clickable, role="", roles=(), geometry_ok=True, editable=False):
        node = super().__new__(cls, (text, *bounds))
        node.path, node.ancestors, node.clickable = path, ancestors, clickable
        node.container = ancestors[-1][0] if ancestors else ()
        node.role, node.roles = role, roles
        node.geometry_ok = geometry_ok
        node.editable = editable
        return node


def _tree(runtime) -> list[tuple[str, int, int, int, int]]:
    """Retain native ancestor containers rather than discarding them at the device boundary."""
    root = ET.fromstring(runtime._observation("tree"))
    try:
        viewport = tuple(int(root.attrib[k]) for k in ("width", "height"))
    except (KeyError, ValueError):
        viewport = None
    result = _NativeRead(viewport if viewport and min(viewport) > 0 else None)
    def visit(element, path=(), ancestors=(), roles=(), parent=None, coherent=True):
        bounds = tuple(map(int, re.findall(r"-?\d+", element.get("bounds", ""))))
        children = list(element)
        role = element.get("resource-id", "").split("/")[-1]
        roles = (*roles, role) if role else roles
        if element.tag == "node" or len(bounds) == 4:
            valid = coherent and _positive_bounds(bounds) and (parent is None or _inside(bounds, parent))
            bounds = bounds if len(bounds) == 4 else (0, 0, 0, 0)
            result.append(_NativeText(element.get("text") or element.get("content-desc") or "", bounds,
                path, ancestors, element.get("clickable") == "true", role, roles, valid, element.get("editable") == "true"))
            parent, coherent = bounds, valid
            if children:
                ancestors = (*ancestors, (path, bounds))
        for index, child in enumerate(children):
            visit(child, (*path, index), ancestors, roles, parent, coherent)
    visit(root)
    return result


_ocr = None


def _screen_nodes(png: bytes, width: int, height: int) -> list[tuple[str, int, int, int, int]]:
    """(text, x0, y0, x1, y1) in device pixels, top-left origin; scale resized screenshots back to the device."""
    global _ocr
    import rapidocr
    from PIL import Image
    if _ocr is None:
        models = Path(rapidocr.__file__).parent / "models"
        _ocr = rapidocr.RapidOCR(params={"Det.model_path": str(models / "PP-OCRv6_det_small.onnx"),
            "Cls.model_path": str(models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
            "Rec.model_path": str(models / "PP-OCRv6_rec_small.onnx")})
    with Image.open(io.BytesIO(png)) as image:
        found = _ocr(image)
        sx, sy = width / image.width, height / image.height
    if found.txts is None:
        return []
    return [(text, int(box[:, 0].min() * sx), int(box[:, 1].min() * sy),
             int(box[:, 0].max() * sx), int(box[:, 1].max() * sy)) for text, box in zip(found.txts, found.boxes)]


# Shown once an order is placed and paid. An agent's own "not paid" is not evidence:
# tapping 免密支付 can pay immediately, even when the intended action is to open the cashier.
PAID = re.compile(r"商家正在备餐|已完成支付|支付成功|付款成功|成功下单|下单成功|骑手已接单|申请售后")


# Shown once a car has been called. The owner: "千万不要真实打车，如果真打了，第一时间取消" — an errand without
# ride_ok that leaves these on screen is followed at once by a cancel run on the same phone.
RIDE_CALLED = re.compile(r"正在为[你您]呼叫|呼叫中|等待(应答|接单)|司机已接单|司机正在|司机将在|行程(中|已开始)")
CANCEL_RIDE = ("刚才误叫了车，必须马上取消：在行程卡片或页面里点「取消订单」「取消行程」或「取消呼叫」，问原因就选「行程有变」"
               "或任意一项，确认取消，直到看到已取消。不要再叫车，不要付款。回报是否已取消、有没有取消费。")


async def _screen_signs(runtime, driver, label: re.Pattern) -> set[str] | None:
    """Lines on screen matching the label (a paid order, a called car); None when the screen cannot be read, so an
    unreadable screen is never mistaken for "no sign" (e.g. a cancelled ride)."""
    from mobilerun_core_local.driver.base import DeviceDisconnectedError
    try:
        png = await driver.screenshot()
        nodes = await asyncio.to_thread(runtime._screen_nodes, png, 1, 1)
        return {text for text, *_ in nodes if label.search(text)} if nodes else None
    except DeviceDisconnectedError:
        raise
    except Exception:  # noqa: BLE001
        return None


async def _signs_after(runtime, driver, label: re.Pattern) -> set[str] | None:
    """Post-run check: one more look 2 s later before calling the screen unreadable (a transition or redraw)."""
    signs = await runtime._screen_signs(driver, label)
    if signs is None:
        await asyncio.sleep(2)
        signs = await runtime._screen_signs(driver, label)
    return signs


async def _cancel_ride(runtime, config, driver) -> str:
    """A short agent run that only cancels a ride; its own guard still refuses calling a car or paying."""
    config.agent.max_steps = 15
    handler = runtime.MobileAgent(goal=runtime.OPERATING_RULES + CANCEL_RIDE, config=config, timeout=180, driver=runtime.CheckoutStop(driver)).run()
    try:
        return str((await asyncio.wait_for(runtime._finished(handler), 180)).reason or "")
    except (Exception, asyncio.CancelledError) as exc:  # noqa: BLE001
        await runtime._join_cleanup(handler.cancel_run())
        if isinstance(exc, asyncio.CancelledError): raise
        return f"取消没有完成（{type(exc).__name__}）"


# Calling a car commits the user (driver dispatched, cancellation fees). 千问's ride card calls it 「确认（26.3~34.3元起）」.
# Undoing a ride is not calling one: 「取消呼叫」 contains 呼叫, and the cancel run must be able to tap it.
RIDE_BUTTON = re.compile(r"(?<!取消)(?:呼叫|叫车)|确认用车|立即用车|确认[（(][^）)]*元")
CANCEL_CONTROL = re.compile(r"取消(?:呼叫|叫车|订单|行程)|确认取消")


def _hits(x: int, y: int, nodes, label: re.Pattern) -> bool:
    """True when the tap lands on (or right around) a label matching the pattern."""
    return any(label.search(t) and x0 - 200 <= x <= x1 + 200 and y0 - 60 <= y <= y1 + 60 for t, x0, y0, x1, y1 in nodes)


def _on(x: int, y: int, nodes, label: re.Pattern) -> bool:
    """True when the tap lands inside a label matching the pattern (no margin: the control actually tapped)."""
    return any(label.search(t) and x0 <= x <= x1 and y0 <= y <= y1 for t, x0, y0, x1, y1 in nodes)


def _charge_control(text: str, surface: bool = False) -> bool:
    return bool((PAY_BUTTON.search(text) and not PAY_NAVIGATION.fullmatch(text))
                or (surface and CONFIRM_BUTTON.search(text)))


def _pays(x: int, y: int, nodes, cashier: bool = False) -> bool:
    """True when an input lands on (or right around) a charge-capable control's label."""
    return _recognize_charge(nodes, cashier).pays(x, y)


def _order_amounts(nodes) -> set[float]:
    """All readable payable totals, preserving conflicting totals and ambiguous split rows."""
    totals = set()
    for t, x0, y0, x1, y1 in nodes:
        if not TOTAL_LABEL.match(t):
            continue
        if YUAN.search(t):
            totals.update(float(value) for value in YUAN.findall(t))
            continue
        row = [(n[1], float(YUAN.search(n[0]).group(1))) for n in nodes
               if YUAN.search(n[0]) and n[1] >= x0 and abs((n[2] + n[4]) / 2 - (y0 + y1) / 2) < 60]
        if row:
            totals.update(value for _, value in row)
    return totals


def _order_total(nodes) -> float | None:
    totals = _order_amounts(nodes)
    return next(iter(totals)) if len(totals) == 1 else None


def _order_items(texts):
    """Read labelled item facts, not headings, controls or arbitrary Screen.items text.

    A SKU plus quantity, or a product name, variant and quantity, identifies this supported single-item view.
    Multiple values/rows are unidentifiable here; never guess which product belongs to the current order.
    """
    aliases = {"SKU": "sku", "商品编号": "sku", "商品名称": "name", "商品": "name",
               "商品规格": "spec", "规格": "spec", "数量": "quantity", "件数": "quantity"}
    found = {}
    for text in texts:
        match = re.fullmatch(r"(SKU|商品编号|商品名称|商品|商品规格|规格|数量|件数)[：:]\s*(.*)", text)
        if match:
            value = unicodedata.normalize("NFC", match[2].strip())
            found.setdefault(aliases[match[1]], set()).add(value)
    conflict = any(len(values) != 1 or any(not v or len(v) > 200 for v in values) for values in found.values())
    facts = tuple(sorted((key, next(iter(values))) for key, values in found.items() if len(values) == 1))
    required = ("sku", "quantity") if "sku" in found else ("name", "spec", "quantity")
    identity = tuple((key, dict(facts)[key]) for key in required) if not conflict and all(k in found for k in required) else ()
    return identity, facts, conflict


class _ControlInput(NamedTuple):
    points: tuple
    confirm: bool

    @classmethod
    def from_call(cls, action, args, kwargs):
        """Resolve positional/keyword coordinates and Android confirmation key aliases once."""
        if action in ("press_key_code", "press_button"):
            key = args[0] if args else kwargs.get("key_code" if action == "press_key_code" else "button")
            confirm = str(key).upper().removeprefix("KEYCODE_") in (
                "66", "23", "160", "ENTER", "DPAD_CENTER", "NUMPAD_ENTER", "CONFIRM")
            return cls((), confirm)
        names = ("x", "y") if action == "tap" else ("x1", "y1", "x2", "y2") if action in ("swipe", "drag") else ()
        values = [args[i] if len(args) > i else kwargs.get(name) for i, name in enumerate(names)]
        return cls(tuple((int(x), int(y)) for x, y in zip(values[::2], values[1::2])
                         if x is not None and y is not None), False)

    def activates(self, charge):
        return (self.confirm and charge.surface is not False) or any(charge.pays(x, y) for x, y in self.points)


class _ChargeRecognition(NamedTuple):
    surface: bool | None
    candidates: tuple
    risk_candidates: tuple

    def pays(self, x, y):
        return any(x0 - 200 <= x <= x1 + 200 and y0 - 60 <= y <= y1 + 60
                   for _, x0, y0, x1, y1 in self.risk_candidates)

    def activates(self, action, args, kwargs):
        """Gestures can activate either endpoint; confirm keys do not need coordinates."""
        return _ControlInput.from_call(action, args, kwargs).activates(self)


def _recognize_charge(nodes, cashier: bool = False, shown=()):
    """Retain release refusal risk separately from actionable checkpoint controls."""
    from payment_checkpoint import payment_evidence
    # Editable text describes a message, not a charge control. Keep unrelated and merged OCR controls.
    editing = [n for n in nodes if getattr(n, "editable", False) and n.geometry_ok]
    def controls(observations):
        return [n for n in observations if getattr(n, "editable", None) is False or not any(
                _inside(n[1:], e[1:]) and re.sub(r"\s+", "", n[0]) in re.sub(r"\s+", "", e[0]) for e in editing)]
    nodes, shown = controls(nodes), controls(shown)
    surface = True if cashier or _order_amounts(nodes) else (
        None if any(_charge_control(t) for t, *_ in nodes) else False)
    risk_candidates = tuple(node for node in nodes if _charge_control(node[0], surface is True))

    def actionable(observations):
        evidence = payment_evidence(tuple(node[0] for node in observations))
        return [node for node, text in zip(observations, evidence.control_texts)
                if _charge_control(TOTAL_LABEL.sub("", text, count=1), surface is True)]

    # Keep every visible OCR candidate. Only merge a native label into an overlapping visible control.
    candidates = actionable(shown)
    for node in actionable(nodes):
        if not any(max(node[1], b[1]) <= min(node[3], b[3]) and
                   max(node[2], b[2]) <= min(node[4], b[4]) for b in candidates):
            candidates.append(node)
    return _ChargeRecognition(surface, tuple(candidates), risk_candidates)


def _confirmation_surface(nodes, cashier: bool = False) -> bool | None:
    """A readable total or a cashier. None means a charge control with an unreadable total."""
    return _recognize_charge(nodes, cashier).surface


def _charge_input(action: str, args, kwargs, nodes, cashier: bool = False) -> bool:
    return _recognize_charge(nodes, cashier).activates(action, args, kwargs)


class _CheckpointReached(_Refused):
    """Stop the model workflow before handing the cashier to deterministic code."""


class CheckoutStop:
    """Driver wrapper: stop charge-capable inputs before placing or paying an order without authorization.
    Payment stays the user's own act; goal text alone does not stop a mis-tap on a password-free 确认付款.
    An intent stops the agent at the cashier; it never lets the agent pay. A ride is called only when
    the user asked for one (ride_ok); price checks and tests never press the call button."""

    def __init__(self, runtime, inner: AndroidDriver, payment_intent: str | None = None, ride_ok: bool = False) -> None:
        self.runtime = runtime
        self.inner = inner
        self.payment_intent = payment_intent
        self.ride_ok = ride_ok
        self.size: tuple[int, int] | None = None
        self.png = b""
        self.shown = []
        self.app_namespace: str | None = None
        self.read_order_scope = False
        self.capture_unresolved = True
        self.reached = asyncio.Event()
        self.login_required: _AppLoginRequired | None = None

    def _checkpoint(self):
        self.reached.set()
        raise _CheckpointReached()

    async def _seen(self) -> list[tuple[str, int, int, int, int]]:
        """The accessibility tree plus the text actually on screen. Fails closed: when the screen cannot be read the
        input is not made, because nothing else can tell whether it activates a password-free charge control."""
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        from PIL import Image
        def namespace():
            focus = self.runtime._shell("dumpsys window | grep mCurrentFocus")
            match = re.search(r"\b([A-Za-z][\w]*(?:\.[\w]+)+)/", focus)
            return match[1] if match else None
        before = await asyncio.to_thread(namespace) if self.payment_intent or self.read_order_scope else None
        try:
            png = await self.inner.screenshot()
            self.native_nodes = await asyncio.to_thread(self.runtime._tree)
            viewport = self.native_nodes.viewport
            self.size = viewport  # Projection for callers only; the per-read hierarchy owns it.
            self.capture_unresolved = viewport is None or getattr(png, "capture_size", None) != viewport
            with Image.open(io.BytesIO(png)) as image:
                scale = min(1.0, self.runtime.REMOTE_MAX_SIDE / max(viewport)) if viewport else 1.0
                expected = tuple(int(v * scale + .5) for v in viewport) if viewport else None
                self.capture_unresolved |= image.size != expected
            shown = await asyncio.to_thread(self.runtime._screen_nodes, png, *viewport) if viewport else []
            self.capture_unresolved |= bool(viewport and any(not _inside(n[1:], (0, 0, *viewport)) for n in shown))
        except DeviceDisconnectedError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _Refused(f"读不到屏幕内容（{type(exc).__name__}），无法确认这一下不会付款：不点，立即结束并汇报。") from exc
        # Nothing readable (WebView/image UI mid-transition, OCR found no text): that is unknown, not safe.
        if not any(text.strip() for text, *_ in shown):
            if not self.read_order_scope:
                raise _Refused("屏幕上读不到任何文字，无法确认这一下不会付款或叫车：不点，立即结束并汇报。")
            self.capture_unresolved = True
        nodes = self.native_nodes + shown
        after = await asyncio.to_thread(namespace) if self.payment_intent or self.read_order_scope else None
        self.app_namespace = before if before == after else None
        self.png, self.shown = png, shown
        return nodes

    def __getattr__(self, name: str):
        member = getattr(self.inner, name)
        if not asyncio.iscoroutinefunction(member):
            return member
        async def step(*args, **kwargs):
            return await self.runtime._phone_step(lambda: getattr(self.inner, name)(*args, **kwargs), reconnect=self._reconnect)
        return step

    async def _reconnect(self):
        self.inner = await self.runtime._driver(repair=False)

    async def get_ui_tree(self):
        try:
            return await self.runtime._phone_step(lambda: self.inner.get_ui_tree(), reconnect=self._reconnect)
        except _AppLoginRequired as exc:
            self.login_required = exc
            self.reached.set()
            raise

    async def _input(self, action: str, *args, **kwargs):
        if self.login_required:
            raise self.login_required
        if self.payment_intent and await asyncio.to_thread(self.runtime._at_checkout):
            self._checkpoint()  # Before typing/repair can touch a cashier's keyboard.
        return await self.runtime._phone_step(lambda: self._checked_input(action, *args, **kwargs), reconnect=self._reconnect,
                                 typing=action == "input_text")

    async def _checked_input(self, action: str, *args, **kwargs):
        control = _ControlInput.from_call(action, args, kwargs)
        nodes = await self._seen() if action in ("tap", "swipe", "drag", "press_key_code", "press_button") else []
        cashier = await asyncio.to_thread(self.runtime._at_checkout)
        # Confirm keys may activate any focused ride control. Cancel targets and back remain available.
        if not self.ride_ok and ((control.confirm and any(RIDE_BUTTON.search(t) for t, *_ in nodes)) or
                any(not _on(x, y, nodes, CANCEL_CONTROL) and _hits(x, y, nodes, RIDE_BUTTON) for x, y in control.points)):
            raise _Refused("这一下会叫车：用户没有要求真的叫车（只问价或测试），不点，立即结束并汇报车型和预估价。")
        charge = _recognize_charge(nodes, cashier, self.shown)
        if control.activates(charge):
            if self.payment_intent:
                self._checkpoint()
            raise _Refused("这一下会直接付款（小额免密不弹收银台）：没有用户付款授权，不点，立即结束并汇报订单信息。")
        if cashier:
            if self.payment_intent:
                self._checkpoint()
            raise _Refused("已到付款页（收银台）：按规则不再点击或输入，立即结束任务并汇报商家、商品规格、金额和预计时间。")
        if self.capture_unresolved and (control.points or control.confirm):
            raise _Refused("屏幕图像与视图尺寸不一致，无法确认这一下不会付款：不输入，重新观察屏幕。")
        if await asyncio.to_thread(self.runtime._locked):
            raise RuntimeError("执行手机锁屏，当前输入未执行。")
        if self.login_required:
            raise self.login_required
        try:
            result = await getattr(self.inner, action)(*args, **kwargs)
            if result is False: raise RuntimeError("执行手机未确认输入完成。")
            return result
        except Exception as exc:
            raise _Refused("输入结果未知；不要重试这一下。先重新观察屏幕，核对 App 的订单、行程或消息状态，再决定是否继续。"
                           f"（{type(exc).__name__}: {exc}）") from exc

    async def tap(self, *args, **kwargs): return await self._input("tap", *args, **kwargs)
    async def swipe(self, *args, **kwargs): return await self._input("swipe", *args, **kwargs)
    async def drag(self, *args, **kwargs): return await self._input("drag", *args, **kwargs)
    async def input_text(self, *args, **kwargs): return await self._input("input_text", *args, **kwargs)
    async def press_button(self, *args, **kwargs): return await self._input("press_button", *args, **kwargs)
    async def press_key_code(self, *args, **kwargs): return await self._input("press_key_code", *args, **kwargs)


_MERCHANT_FIELD = re.compile(r"^(?:收款方|收款人|商家|店铺|商品名称|商品|商品规格|规格|备注|留言|附言)(?:[：:]|$)")
_IDENTITY_FIELD = re.compile(r"^(?:(?:订单号|订单编号|SKU|商品编号|数量|件数)(?:[：:]|$)|配送至)")
_NATIVE_DATA_ROLE = re.compile(r"(?:merchant|shop|item|product|remark|note)(?:_.*)?")
_NATIVE_STATUS_ROLE = re.compile(r"(?:payment|pay|order|transaction)_(?:status|result)")


def _positive_bounds(bounds):
    return len(bounds) == 4 and bounds[0] < bounds[2] and bounds[1] < bounds[3]


def _inside(bounds, outer):
    return (_positive_bounds(bounds) and _positive_bounds(outer) and outer[0] <= bounds[0] <= bounds[2] <= outer[2]
            and outer[1] <= bounds[1] <= bounds[3] <= outer[3])


class _PaymentSection(NamedTuple):
    key: tuple
    container: tuple
    title: str
    bounds: tuple
    heading_bounds: tuple
    eligible: bool


def _overlaps(a, b):
    return (_positive_bounds(a) and _positive_bounds(b)
            and a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3])


def _native_ocr_occurrences(fields, viewport, *, headings=False):
    """One-to-one occurrence confirmation; neither text equality nor ancestry is provenance."""
    matches = {i: [j for j, image in enumerate(fields) if image.source == "ocr" and image.text == field.text
                  and image.container == field.container and _inside(image.bounds, field.bounds)
                  and _overlaps(image.bounds, viewport)
                  and (image.heading if headings else field.section_instance is not None
                       and image.section_instance == field.section_instance)]
               for i, field in enumerate(fields) if field.eligible and (field.heading or not headings)}
    return [(i, images[0]) for i, images in matches.items() if len(images) == 1
            and sum(images[0] in others for others in matches.values()) == 1]


def _payment_fields(guard, nodes, cashier):
    """Direct section membership precedes binding. Headings are instances, never inherited title strings."""
    from dataclasses import replace
    from payment_checkpoint import CURRENT_ORDER_TITLES, PaymentField, payment_evidence
    native = getattr(guard, "native_nodes", None)
    native = native if isinstance(native, list) else []
    # No image-only region is grounded yet. Nonempty entries need frozen-capture
    # validation at this owner before they can be admitted; data alone grants nothing.
    if json.loads(Path(__file__).with_name("payment-grounded-regions.json").read_text()) != {"schema_version": 1, "regions": {}}:
        raise ValueError("Payment grounding requires validated frozen captures")
    size = getattr(native, "viewport", None)
    viewport = (0, 0, *size) if isinstance(size, (tuple, list)) and len(size) == 2 else (0, 0, 0, 0)
    containers = {path: bounds for n in native for path, bounds in getattr(n, "ancestors", ())}
    surface = cashier or bool(_order_amounts(nodes))
    sources = [(n, n.path if n.path in containers else n.container, "native", n.role, n.roles)
               for n in native if n[0].strip()]
    for n in dict.fromkeys(guard.shown):
        if not n[0].strip():
            continue
        fitting = [p for p, b in containers.items() if _inside(n[1:], b)]
        deepest = [p for p in fitting if not any(p != q and q[:len(p)] == p for q in fitting)]
        covered = [x for x in native if _inside(n[1:], x[1:])]
        roles = tuple(r for x in covered for r in x.roles)
        sources.append((n, deepest[0] if len(deepest) == 1 else None, "ocr", "", roles))
    merchant_rows = {p: n[0].strip().rstrip("：:") for n, p, _, _, _ in sources
                     if p is not None and (_MERCHANT_FIELD.fullmatch(n[0].strip()) or _IDENTITY_FIELD.fullmatch(n[0].strip()))}
    labelled_data = [n.path for n in native if n.path in containers and _MERCHANT_FIELD.match(n[0].strip())]
    fields, unidentified_roles = [], set()
    for n, container, source, role, roles in sorted(sources, key=lambda row: (row[0][2], row[0][1])):
        text = n[0].strip()
        in_value_row = any(container is not None and container[:len(p)] == p for p in merchant_rows)
        in_value_row = in_value_row or source == "native" and any(n.path != p and n.path[:len(p)] == p for p in labelled_data)
        data_role = any(_NATIVE_DATA_ROLE.fullmatch(r) for r in roles)
        merchant = bool(_MERCHANT_FIELD.match(text) or _IDENTITY_FIELD.match(text) or in_value_row or data_role)
        status = bool(payment_evidence([text]).statuses)
        known = merchant or TOTAL_LABEL.match(text) or YUAN.fullmatch(text) or status or _charge_control(text, surface)
        heading = not merchant and (text in CURRENT_ORDER_TITLES or not known)
        if status and role and not _NATIVE_STATUS_ROLE.fullmatch(role):
            unidentified_roles.add(len(fields))
        fields.append(PaymentField(text, n[1:], container, merchant=merchant, source=source,
            binding_text=None if in_value_row or data_role else text, heading=heading,
            eligible=source == "native" and n.geometry_ok and _overlaps(n[1:], viewport)))
    data_regions = [(f.bounds, i) for i, f in enumerate(fields) if f.merchant]
    data_regions += [(containers[p], None) for p in merchant_rows]
    data_regions += [(n[1:], None) for n in native if any(_NATIVE_DATA_ROLE.fullmatch(r) for r in n.roles)]
    for index, field in enumerate(fields):
        if field.source != "ocr":
            continue
        boundaries = [box for box, owner in data_regions if owner != index]
        owned = any(_inside(field.bounds, box) for box in boundaries)
        crosses = not owned and any(_overlaps(field.bounds, box) for box in boundaries)
        fields[index] = replace(field, container=None if crosses else field.container,
            merchant=field.merchant or owned, heading=field.heading and not owned,
            binding_text=None if owned and not field.merchant else field.binding_text)
    # Match occurrences only after direct containers/data ownership are known.
    # A grouping label's broad box is not the glyph: localize it to its unique
    # same-container OCR occurrence. Ambiguous/multiple occurrences stay headed.
    for index, image in _native_ocr_occurrences(fields, viewport, headings=True):
        fields[index] = replace(fields[index], bounds=fields[image].bounds)
        fields[image] = replace(fields[image], heading=False)
    sections = []
    for index, field in enumerate(fields):
        if not field.heading or field.container is None:
            continue
        box = containers[field.container]
        earlier = any(f.heading and f.container == field.container and f.bounds[1] < field.bounds[1] for f in fields)
        later = [f.bounds[1] for f in fields if f.heading and f.container == field.container and f.bounds[1] > field.bounds[1]]
        bounds = (box[0], field.bounds[1] if earlier else box[1], box[2], min(later, default=box[3]))
        sections.append(_PaymentSection((field.container, index), field.container, field.text, bounds, field.bounds, field.eligible))
    resolved = []
    for index, field in enumerate(fields):
        if field.source == "native":
            ancestors = [s for s in sections if field.container is not None and field.container[:len(s.container)] == s.container]
            depth = max((len(s.container) for s in ancestors), default=-1)
            members = [s for s in ancestors if len(s.container) == depth and _inside(field.bounds, s.bounds)
                       and field.bounds[1] >= s.heading_bounds[1]]
            if not field.heading and any(_overlaps(field.bounds, s.bounds) and s not in ancestors for s in sections):
                members = []  # Tree ancestry cannot override another visible headed card's boundary.
        else:
            hits = [s for s in sections if field.container is not None and _overlaps(field.bounds, s.bounds)]
            # A crossing box cannot retreat to a screen/ancestor section. Flat duplicate headings also split it.
            leaves = [s for s in hits if not any(s.container != t.container and t.container[:len(s.container)] == s.container for t in hits)]
            members = [s for s in leaves if _inside(field.bounds, s.bounds)
                       and field.bounds[1] >= s.heading_bounds[1]] if len(leaves) == 1 else []
        section = members[0] if len(members) == 1 else None
        field = replace(field, section=section.title if section and index not in unidentified_roles else None,
                        section_instance=section.key if section else None)
        resolved.append(field)
    # OCR can confirm an existing native occurrence, never create an evidential fact.
    confirmed = {image for _, image in _native_ocr_occurrences(resolved, viewport)}
    resolved = [f for i, f in enumerate(resolved) if i not in confirmed]
    for path, label in merchant_rows.items():
        labels = [f for f in resolved if f.container == path and f.text.rstrip("：:") == label]
        values = [f for f in resolved if f.container == path and f.text.rstrip("：:") != label]
        if (len(labels) == len(values) == 1 and labels[0].eligible and values[0].eligible and labels[0].section_instance is not None
                and labels[0].section_instance == values[0].section_instance):
            value = values[0]
            resolved.append(replace(value, text=label + "：" + value.text, merchant=True, source="native-row",
                                    binding_text=label + "：" + value.text, heading=False))
    return resolved, sections


def _payment_identity(fields, namespace, title=None):
    """The same regional payable amount and identity feed grant checks and receipts."""
    from payment_checkpoint import optional_text
    texts = list(dict.fromkeys(f.binding_text for f in fields if f.eligible and f.binding_text is not None))
    totals = _order_amounts([(f.binding_text, *f.bounds) for f in fields if f.eligible and f.binding_text is not None and not f.merchant])
    payees = {m[1].strip() for t in texts if (m := re.fullmatch(r"(?:收款方|收款人|商家|店铺)[：:]\s*(.+)", t))}
    ids = {m[1] for t in texts if (m := re.fullmatch(r"订单(?:号|编号)[：:]\s*([A-Za-z0-9_-]+)", t))}
    item_identity, item_facts, item_conflict = _order_items(texts)
    amount = next(iter(totals)) if len(totals) == 1 else None
    return dict(amount_fen=int(Decimal(str(amount)) * 100) if amount is not None else None,
        payee=optional_text(next(iter(payees))) if len(payees) == 1 else None,
        order_id=next(iter(ids)) if len(ids) == 1 else None, order_namespace=optional_text(namespace),
        page_title=title,
        item_identity=item_identity, item_facts=item_facts, item_conflict=item_conflict,
        amount_conflict=len(totals) > 1, payee_conflict=len(payees) > 1)


async def _payment_screen(runtime, guard) -> Screen:
    """One fresh image/tree read. Screenshot hashing is required by A9, not a file-integrity scan."""
    from dataclasses import replace
    from payment_checkpoint import CANCELLED_STATUS, CURRENT_ORDER_TITLES, PaymentBinding, PaymentError, Screen, optional_text, payment_evidence
    try:
        guard.read_order_scope = True  # No-intent reconciliation needs the same namespace evidence as a grant.
        nodes = await guard._seen()
        cashier = await asyncio.to_thread(runtime._at_checkout)
        fields, sections = _payment_fields(guard, nodes, cashier)
        namespace = getattr(guard, "app_namespace", None)
        candidates = {}
        for section in sections:
            if not section.eligible or section.title not in CURRENT_ORDER_TITLES:
                continue
            direct = [f for f in fields if f.section_instance == section.key]
            identity = _payment_identity(direct, namespace, section.title)
            if PaymentBinding(**{k: identity[k] for k in (
                    "order_id", "payee", "amount_fen", "order_namespace", "item_identity", "item_facts")}).complete:
                candidates[section.key] = identity
        region = next(iter(candidates)) if len(candidates) == 1 else None
        identity = candidates[region] if region is not None else {**_payment_identity(fields, namespace), "amount_fen": None}
        fields = tuple(replace(f, region=region if f.section_instance == region else None) for f in fields)
        # Unsupported enclosing/same-container headings cannot establish a current-order context.
        current = next((s for s in sections if s.key == region), None)
        unresolved = current is None or getattr(guard, "capture_unresolved", True)
        if current:
            unresolved = unresolved or any(s.title not in CURRENT_ORDER_TITLES and (
            s.container[:len(current.container)] == current.container or current.container[:len(s.container)] == s.container)
            for s in sections)
        unresolved = unresolved or any(f.region != region and not f.merchant and (TOTAL_LABEL.match(f.text) or YUAN.fullmatch(f.text)) for f in fields)
        unresolved = unresolved or any(f.source == "ocr" and f.section_instance is None for f in fields)
        unresolved = unresolved or any(not f.eligible and (payment_evidence([f.text]).statuses
            or _MERCHANT_FIELD.match(f.text) or _IDENTITY_FIELD.match(f.text) or TOTAL_LABEL.match(f.text) or YUAN.fullmatch(f.text)) for f in fields)
        # Risk is classified before admissibility projection: discarded controls
        # are uncertainty, even when another native control is executable.
        retained = [(f.text, *f.bounds) for f in fields if not f.merchant]
        risk = _recognize_charge(retained, cashier, retained).risk_candidates
        unresolved = unresolved or any((f.text, *f.bounds) in risk and (not f.eligible or f.region != region)
                                      for f in fields if not f.merchant)
        visible = [f for f in fields if f.region == region] if region is not None else fields
        texts = list(dict.fromkeys(f.text for f in visible))
        charge_nodes = [(f.text, *f.bounds) for f in visible if region is not None and f.region == region and f.eligible and not f.merchant]
        charge = _recognize_charge(charge_nodes, cashier, charge_nodes)
        delivery = optional_text(next((t for t in texts if t.startswith("配送至")), None))
        evidence = payment_evidence(fields, identity["page_title"])
        labels = tuple(t for t, *_ in charge.candidates)
        return Screen(**identity, checkout="cashier" if cashier else "order_card",
            items=() if cashier else tuple(t for t in texts if len(t) <= 80 and t not in labels and t not in evidence.statuses
                                           and not VERIFY_PROMPT.search(t) and not t.startswith("配送至"))[:5],
            delivery=delivery, screen_sha256=hashlib.sha256(guard.png).hexdigest(), read_at=runtime._now(),
            pay_buttons=tuple(((x0 + x1) // 2, (y0 + y1) // 2) for _, x0, y0, x1, y1 in charge.candidates),
            verify=bool(VERIFY_PROMPT.search(" ".join(texts))),
            payment_statuses=evidence.statuses, charge_labels=labels, region=region, status_fields=fields, scope_unresolved=unresolved,
            cancelled_signs=tuple(t for t in texts if region is not None and not unresolved
                                  and identity["order_id"] and CANCELLED_STATUS.fullmatch(t)))
    except Exception:
        raise PaymentError("SCREEN_UNREADABLE") from None


CANCEL_ORDER = "刚才这张订单不要了：在千问订单或待付款里取消这张未付款订单，确认取消，直到看到已取消。不要付款，不要再下单。回报是否已取消。"


async def _cancel_order(runtime, config, driver, payment_config, target_order_id=None):
    """A9 E6: bounded undo behind the existing no-intent guard; a model claim is not cancellation evidence."""
    handler = None
    try:
        guard = runtime.CheckoutStop(driver)
        before = await runtime._payment_screen(guard)
        target_order_id = target_order_id or before.order_id
        await driver.press_key_code(4)  # BACK leaves the cashier; never replay an unacknowledged input.
        config.agent.max_steps = payment_config.cancel_steps
        target = f"目标订单号：{target_order_id}，只取消这张订单。" if target_order_id else ""
        handler = runtime.MobileAgent(goal=runtime.OPERATING_RULES + CANCEL_ORDER + target, config=config,
            timeout=payment_config.cancel_timeout_s, driver=guard).run()
        result = await asyncio.wait_for(runtime._finished(handler), payment_config.cancel_timeout_s)
        after = await runtime._payment_screen(guard)
        done = (result.success and target_order_id and after.order_id == target_order_id
                and set(after.cancelled_signs) - set(before.cancelled_signs))
        return {"outcome": "done" if done else "failed"}
    except (Exception, asyncio.CancelledError) as exc:
        if handler is not None:
            await runtime._join_cleanup(handler.cancel_run())
        if isinstance(exc, asyncio.CancelledError):
            raise
        return {"outcome": "failed", "detail": "取消未完成，请在 App 里核对"}


async def _checkpoint_payment(runtime, guard, config, app, cancelled=False):
    from payment_checkpoint import CheckpointConfig, PaymentCheckpoint, PaymentError, PaymentHTTPClient
    try:
        payment_config = CheckpointConfig.from_env()
        client = None if cancelled else PaymentHTTPClient.from_env(payment_config)
    except (PaymentError, ValueError):
        return {"success": False, "answer": "【没有付款】付款服务未配置；未尝试取消未付款订单，请在 App 里核对。"}
    async def tap(x, y):
        # No _phone_step here: a dispatched pay input is never repaired or retried.
        return await guard.inner.tap(x, y)
    async def read():
        screen = await runtime._payment_screen(guard)
        job = runtime._jobs.get(runtime._job_id.get())
        if job is not None and not job.get("payment_binding"):
            from payment_checkpoint import PaymentBinding
            job["payment_binding"] = payment_lineage.remember(PaymentBinding(screen.order_id, screen.payee, screen.amount_fen,
                screen.order_namespace, screen.item_identity, screen.item_facts))
            runtime._write_running(runtime._job_id.get(), force=True, durable=True)
        return screen
    checkpoint = PaymentCheckpoint(client, read, tap,
        lambda: runtime._cancel_order(config, guard.inner, payment_config, checkpoint.order_id), payment_config)
    if cancelled:
        return await checkpoint.cancel_before_open()
    return await checkpoint.run(guard.payment_intent, runtime._job_id.get() or f"job-{uuid.uuid4().hex[:12]}", app)


async def begin_agent(runtime, inner, payment_intent, ride_ok):
    driver = runtime.CheckoutStop(inner, payment_intent, ride_ok)
    before = (await runtime._screen_signs(driver, PAID) or set()) if not payment_intent else set()
    rides_before = set() if ride_ok else (await runtime._screen_signs(driver, RIDE_CALLED) or set())
    return driver, before, rides_before


async def finish_agent(runtime, driver, config, app, handler, outcome, checkpoint, stopped, before, rides_before):
    payment_intent, ride_ok = driver.payment_intent, driver.ride_ok
    if login := driver.login_required:
        return {"success": False, "status": "APP_LOGIN_REQUIRED", "login_app": login.app,
                "error_code": "APP_LOGIN_REQUIRED", "answer": str(login), "steps": None}
    if payment_intent and (not stopped or driver.reached.is_set()):
        from payment_checkpoint import PaymentError
        checkpoint = checkpoint or driver.reached.is_set()
        if not checkpoint:
            await runtime._join_cleanup(handler.cancel_run())
            try:
                screen = await runtime._payment_screen(driver)
                checkpoint = screen.checkout == "cashier" or bool(screen.amount_fen and screen.pay_buttons)
            except PaymentError:
                checkpoint = False
        if checkpoint:
            # This phase is outside the model-run timeout and still inside the errand's phone lease.
            cancelled = stopped or asyncio.current_task().cancelling() > 0 or (
                runtime._jobs.get(runtime._job_id.get() or "", {}).get("state") == "stopping")
            with contextlib.redirect_stdout(sys.stderr):
                return await runtime._checkpoint_payment(driver, config, app, cancelled=cancelled)
        outcome = {"success": False, "answer": "【没有付款】没有取得付款回执，未尝试取消未付款订单；请先只读核对订单。"}
    unverified = []  # no authority and an unreadable screen: never reported as "nothing happened"
    if not ride_ok and (called := await runtime._signs_after(driver, RIDE_CALLED)) is None:
        unverified.append("有没有叫到车")
    elif not ride_ok and (called := called - rides_before):
        with contextlib.redirect_stdout(sys.stderr):
            report = await runtime._cancel_ride(config, driver.inner)
        after = await runtime._screen_signs(driver, RIDE_CALLED)
        # "Cancelled" needs a finished cancel run AND a readable screen without the ride; anything else is not a success.
        verdict = ("【误叫了车，自动取消没成功，必须马上告诉用户亲自在千问里取消】" if after and after - rides_before else
                   "【误叫了车，取消结果无法核验，必须马上告诉用户亲自在千问里确认已取消】" if after is None or report.startswith("取消没有完成") else
                   "【误叫了车，已自动取消】")
        outcome = {**outcome, "success": False, "answer": (
            verdict
            + f"这次没有叫车授权，但屏幕上出现了叫车迹象（{'、'.join(sorted(called))}）。取消结果：{report}。"
            f"代理原报告：{outcome['answer']}")[:4000]}
    if not payment_intent and (signs := await runtime._signs_after(driver, PAID)) is None:
        unverified.append("有没有下单付款")
    elif not payment_intent and (signs := signs - before):
        outcome = {**outcome, "success": False, "answer": (
            f"【可能已付款】这次没有付款授权，但执行手机屏幕上出现了下单/付款的迹象（{'、'.join(sorted(signs))}）。"
            f"必须如实告诉用户这一单可能已经付款，请用户在订单列表里核对。代理自己的报告：{outcome['answer']}")[:4000]}
    if unverified:
        outcome = {**outcome, "success": False, "answer": (
            f"【{'、'.join(unverified)}无法核验】办完后执行手机屏幕读不出来，没法确认{'、'.join(unverified)}。"
            f"必须如实告诉用户，请用户在 App 的订单/行程里看一眼。代理自己的报告：{outcome['answer']}")[:4000]}
    return outcome
