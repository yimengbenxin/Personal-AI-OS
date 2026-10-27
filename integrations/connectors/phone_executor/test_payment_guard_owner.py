"""The payment authority runs with explicit phone IO and no model/configuration imports."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import payment_guard


async def direct(call, **kwargs):
    return await call()


class PaymentGuardOwner(unittest.IsolatedAsyncioTestCase):
    async def test_charge_refusal_and_intent_handoff_share_the_same_authority(self):
        port = SimpleNamespace(_at_checkout=lambda: False, _phone_step=direct, _locked=lambda: False)
        for intent in (None, 'pi-current-request'):
            phone = SimpleNamespace(tap=mock.AsyncMock())
            guard = payment_guard.CheckoutStop(port, phone, payment_intent=intent)
            with mock.patch.object(guard, '_seen', return_value=[('确认付款 ¥16.60', 0, 100, 200, 300)]):
                with self.assertRaises(payment_guard._CheckpointReached if intent else payment_guard._Refused):
                    await guard.tap(100, 200)
            self.assertEqual(guard.reached.is_set(), bool(intent))
            phone.tap.assert_not_awaited()

    async def test_phone_ports_do_not_share_cashier_or_driver_state(self):
        for cashier in (True, False):
            phone = SimpleNamespace(input_text=mock.AsyncMock())
            port = SimpleNamespace(_at_checkout=lambda: cashier, _phone_step=direct, _locked=lambda: False)
            guard = payment_guard.CheckoutStop(port, phone)
            if cashier:
                with self.assertRaisesRegex(payment_guard._Refused, '收银台'):
                    await guard.input_text('hello')
                phone.input_text.assert_not_awaited()
            else:
                await guard.input_text('hello')
                phone.input_text.assert_awaited_once_with('hello')

    async def test_ride_price_check_refuses_call_but_allows_cancel(self):
        port = SimpleNamespace(_at_checkout=lambda: False, _phone_step=direct, _locked=lambda: False)
        phone = SimpleNamespace(tap=mock.AsyncMock())
        guard = payment_guard.CheckoutStop(port, phone)
        guard.capture_unresolved = False  # These isolated control coordinates are a consistent observation.
        with mock.patch.object(guard, '_seen', return_value=[('确认（26.3~34.3元起）', 0, 100, 200, 300)]):
            with self.assertRaisesRegex(payment_guard._Refused, '会叫车'):
                await guard.tap(100, 200)
        phone.tap.assert_not_awaited()
        with mock.patch.object(guard, '_seen', return_value=[('取消呼叫', 0, 100, 200, 300)]):
            await guard.tap(100, 200)
        phone.tap.assert_awaited_once_with(100, 200)


if __name__ == '__main__':
    unittest.main()
