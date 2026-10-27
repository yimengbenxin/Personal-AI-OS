"""Synthetic image/tree disagreement at the real input boundary; no device or model."""
import io
import sys
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
from payment_capture_fixture import frame


class PaymentGeometry(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tree = server._NativeRead((720, 1280))
        # The real image has a charge button at this point. The stale portrait tree
        # scales the OCR box away from it, even beyond the guard's refusal margin.
        self.point = (350, 650)
        self.misscaled = [("确认付款", 169, 1066, 225, 1244)]
        image = Image.new("RGB", (1280, 720), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((300, 600, 400, 700), fill="blue")
        draw.text((320, 640), "PAY", fill="white")
        png = io.BytesIO(); image.save(png, format="PNG")
        self.driver = type("Phone", (), {})()
        self.driver.screenshot = AsyncMock(return_value=server._ScreenImage(png.getvalue(), (1280, 720)))
        self.driver.tap = AsyncMock(side_effect=self.real_tap)
        self.driver.press_button = AsyncMock()
        self.driver.press_key_code = AsyncMock()
        self.driver.swipe = AsyncMock()
        self.driver.drag = AsyncMock()
        self.charges = []
        self.guard = server.CheckoutStop(self.driver)
        for name, value in [("_tree", lambda: self.tree), ("_screen_nodes", lambda *_: self.misscaled),
                            ("_at_checkout", lambda: False), ("_locked", lambda: False)]:
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)

    async def real_tap(self, x, y):
        if 300 <= x <= 400 and 600 <= y <= 700:
            self.charges.append((x, y))

    async def test_misscaled_ocr_misses_a_real_charge_button_but_input_is_blocked(self):
        self.assertFalse(server._pays(*self.point, self.misscaled))
        for args, kwargs in [(self.point, {}), ((), dict(x=350, y=650))]:
            with self.subTest(kwargs=kwargs), self.assertRaises(server._Refused):
                await self.guard._checked_input("tap", *args, **kwargs)
        self.assertTrue(self.guard.capture_unresolved)
        self.assertEqual(self.charges, [])
        self.driver.tap.assert_not_awaited()

    async def test_unknown_geometry_blocks_unseen_charge_and_confirm_but_keeps_back(self):
        self.misscaled = [("商品详情", 10, 10, 200, 40)]
        for action, args in [("tap", self.point), ("swipe", (*self.point, 500, 650)),
                             ("drag", (100, 100, *self.point)),
                             ("press_button", ("confirm",)), ("press_key_code", (66,))]:
            with self.subTest(action=action), self.assertRaises(server._Refused):
                await self.guard._checked_input(action, *args)
        await self.guard._checked_input("press_button", "back")
        await self.guard._checked_input("press_key_code", 4)
        self.driver.press_button.assert_awaited_once_with("back")
        self.driver.press_key_code.assert_awaited_once_with(4)

    async def test_new_consistent_observation_allows_safe_cancel(self):
        self.misscaled = [("取消订单", 300, 600, 400, 700)]
        with self.assertRaises(server._Refused):
            await self.guard._checked_input("tap", *self.point)
        self.driver.screenshot.return_value = frame((720, 1280))
        self.driver.tap.side_effect = None
        await self.guard._checked_input("tap", *self.point)
        self.assertFalse(self.guard.capture_unresolved)
        self.driver.tap.assert_awaited_once_with(*self.point)


if __name__ == "__main__":
    unittest.main()
