"""The same closed MCP contracts validate injected and offline calls."""
import hashlib
import json
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker

ROOT = Path(__file__).parents[4]
SCHEMAS = json.loads(Path(__file__).with_name('schemas.json').read_text())
PRESENTATION = json.loads((ROOT / 'integrations/contracts/presentation.v1.schema.json').read_text())


def validate_call(name, arguments):
    Draft7Validator(SCHEMAS[name]).validate(arguments)


def validate_native(kind, value):
    Draft7Validator({**PRESENTATION, '$ref': '#/$defs/' + kind}, format_checker=FormatChecker()).validate(value)


def plan_hash(plan):
    body = {k: v for k, v in plan.items() if k != 'plan_sha256'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def validate_plan(plan):
    validate_native('plan', plan)
    if plan_hash(plan) != plan['plan_sha256']:
        raise ValueError('PRESENTATION_PLAN_HASH_MISMATCH')
    edits = plan['edits']
    if (len({edit['work_item_id'] for edit in edits}) != len(edits)
            or len({(edit['slide_id'], edit['element_id']) for edit in edits}) != len(edits)
            or len(plan['preview_items']) != len(edits)):
        raise ValueError('PRESENTATION_PLAN_ITEMS_INVALID')
