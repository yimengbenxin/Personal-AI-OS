"""Keep the 726-cell no-intent guard contract equal to its historical baseline.

The historical guard is loaded from its source. The current public executor entry uses injected inputs only.
"""
import ast
import asyncio
from pathlib import Path
import re
import subprocess
import sys
from types import ModuleType, SimpleNamespace
from typing import NamedTuple
import unittest
from unittest import mock

EXECUTOR = Path(__file__).resolve().parent
ROOT = EXECUTOR.parents[2]
SERVER = EXECUTOR / 'server.py'
BASELINE = 'ebceff14'
sys.path.insert(0, str(EXECUTOR))
FUNCTIONS = {
    '_Refused', '_charge_control', '_pays', '_hits', '_on', '_order_total', '_order_amounts',
    '_confirmation_surface', '_charge_input', '_CheckpointReached', 'CheckoutStop',
    '_ChargeRecognition', '_recognize_charge', '_ControlInput',
}
CONSTANTS = {
    'PAY_BUTTON', 'PAY_NAVIGATION', 'CONFIRM_BUTTON', 'TOTAL_LABEL', 'YUAN',
    'VERIFY_PROMPT', 'RIDE_BUTTON', 'CANCEL_CONTROL',
}
LABELS = (
    '一键下单', '下单并支付', '免密购买', '确认付款 ¥16.60', '合计¥16.6提交订单', '立即购买',
    '支付方式', '付款方式', '购买须知', '购买记录', '购买说明', '去结算', '确认', '提交', '立即',
    '购买', '取消订单', '返回', '支付成功', '支付状态：未支付', '订单状态：下单成功', '总计 ¥16.60',
)
ACTIONS = (
    ('tap', (100, 200)), ('tap', (900, 900)), ('swipe', (100, 200, 100, 200)),
    ('swipe', (100, 200, 800, 800)), ('drag', (800, 800, 100, 200)),
    ('press_key_code', (66,)), ('press_key_code', ('DPAD_CENTER',)),
    ('press_key_code', ('KEYCODE_NUMPAD_ENTER',)), ('press_button', ('confirm',)),
    ('press_key_code', ('BACK',)), ('input_text', ('x',)),
)


def load_guard(source, name):
    chosen = []
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in FUNCTIONS:
            chosen.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id in CONSTANTS for target in node.targets):
            chosen.append(node)
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    module = ModuleType(name)
    module.__dict__.update(asyncio=asyncio, re=re, NamedTuple=NamedTuple)
    tree = ast.fix_missing_locations(ast.Module(body=[future, *chosen], type_ignores=[]))
    exec(compile(tree, name, 'exec'), module.__dict__)

    async def direct(call, **kwargs):
        return await call()
    module._phone_step = direct
    module._locked = lambda: False
    return module


async def observe(module, nodes, cashier, action, args):
    dispatch = mock.AsyncMock()
    guard = module.CheckoutStop(SimpleNamespace(**{action: dispatch}), None)
    guard.capture_unresolved = False  # Compare the released input matrix with established geometry.
    refusal = None
    with mock.patch.object(guard, '_seen', mock.AsyncMock(return_value=nodes)), \
            mock.patch.object(module, '_at_checkout', return_value=cashier, create=True):
        try:
            await getattr(guard, action)(*args)
        except module._Refused as error:
            refusal = str(error)
    return dict(inputs=dispatch.await_count, refusal=refusal,
                charge=module._charge_input(action, args, {}, nodes, cashier))


class ReleaseEquality(unittest.IsolatedAsyncioTestCase):
    async def test_no_intent_release_matrix(self):
        baseline_source = subprocess.check_output(
            ['git', 'show', f'{BASELINE}:{SERVER.relative_to(ROOT).as_posix()}'], cwd=ROOT, text=True)
        baseline = load_guard(baseline_source, BASELINE)
        import server
        current = server
        self.enterContext(mock.patch.object(current, '_phone_step', baseline._phone_step))
        self.enterContext(mock.patch.object(current, '_locked', return_value=False))
        cells = matched = 0
        for surface in ('none', 'total', 'cashier'):
            for label in LABELS:
                nodes = [(label, 0, 100, 200, 300)]
                if surface == 'total':
                    nodes.append(('合计 ¥16.60', 0, 500, 200, 540))
                for action, args in ACTIONS:
                    expected = await observe(baseline, nodes, surface == 'cashier', action, args)
                    actual = await observe(current, nodes, surface == 'cashier', action, args)
                    cells += 1
                    matched += actual == expected
                    with self.subTest(surface=surface, label=label, action=action, args=args):
                        self.assertEqual(actual, expected)
        self.assertEqual(cells, 726)
        self.assertEqual(matched, 726)
        print(f'release equality {matched}/{cells}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
