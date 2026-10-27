"""Offline demo only. No socket, credentials, Apple Events, owner files or media."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from capability.sdk.python.yimi_receipt import receipt, effect, value, unknown_fact

from ..server.contract import validate_plan
from ..server.server import register as real_register


class FakePlatform:
    def __init__(self):
        self.demo = json.loads((Path(__file__).parents[1] / 'tests/demo.json').read_text())
        self.approved = False
        self.writes = 0
        self.calls = {}

    def confirm(self):
        """Test harness simulates platform consent; never registered as an MCP tool."""
        self.approved = True

    def invoke(self, tool, args):
        if args['target_id'] != self.demo['snapshot']['target']['target_id']:
            return receipt('failed', status={'reason_code': 'PRESENTATION_TARGET_MISMATCH'})
        plan = self.demo['plan']
        at = self.demo['snapshot']['captured_at']
        if tool == 'read_deck':
            return receipt('succeeded', values=[value('slide_number', 2, '页', 'observed', 'fixture:Keynote', at)],
                           content=[{'key': 'snapshot:demo', 'text': json.dumps(self.demo['snapshot'], ensure_ascii=False),
                                     'provenance': 'observed'}])
        if tool == 'locate_region':
            return receipt('succeeded', content=[{'key': 'pointing:demo', 'text': json.dumps({
                'utterance_id': args['utterance_id'], 'snapshot_ref': args['snapshot_ref'],
                'frame_refs': args['frame_refs'], 'slide_id': 'slide:2', 'element_id': 'text:2:1',
                'bbox': [0.2, 0.3, 0.7, 0.5]}), 'provenance': 'inferred'}])
        if tool == 'plan_text':
            validate_plan(plan)
            return receipt('succeeded', effects=[effect('workspace', plan['plan_id'], 'persist_plan',
                'verified', 'fixture:plan:demo', 'fixture:plan:demo')], content=[{
                    'key': plan['plan_id'], 'text': json.dumps(plan, ensure_ascii=False), 'provenance': 'inferred'}])
        if tool == 'edit_status':
            key = args.get('idempotency_key') or args.get('operation_id', '').removeprefix('op:')
            return deepcopy(self.calls.get(key, {}).get('receipt') or receipt('unknown',
                status={'reason_code': 'PRESENTATION_OPERATION_UNKNOWN'},
                unknowns=[unknown_fact('operation', 'No fixture audit for this operation.')],
                next={'retry': 'after_check', 'check_with': 'edit_status'}))
        validate_plan(plan)
        if args['plan_id'] != plan['plan_id'] or args['plan_sha256'] != plan['plan_sha256']:
            return receipt('failed', status={'reason_code': 'PRESENTATION_PLAN_HASH_MISMATCH'})
        key = args['idempotency_key']
        identity = (args['target_id'], args['plan_id'], args['plan_sha256'])
        prior = self.calls.get(key)
        if prior:
            if prior['identity'] != identity:
                return receipt('failed', status={'reason_code': 'IDEMPOTENCY_CONFLICT'})
            return deepcopy(prior['receipt'])
        if not self.approved:
            return receipt('waiting', status={'reason_code': 'needs_confirmation'},
                           next={'waiting_on': 'owner', 'needs_confirmation': 'fixture:confirmation'})
        # This changes only an in-memory demo string, after explicit test-harness confirmation.
        self.writes += 1
        edit = plan['edits'][0]
        self.demo['snapshot']['elements'][0]['text'] = edit['after_text']
        after = hashlib.sha256(edit['after_text'].encode()).hexdigest()
        self.demo['snapshot']['elements'][0]['text_sha256'] = after
        ref = 'fixture:read-back:demo'
        item = {'id': edit['work_item_id'], 'label': plan['preview_items'][0], 'state': 'succeeded',
                'effect_refs': [ref], 'slide_id': edit['slide_id'], 'slide_number': edit['slide_number']}
        result = {'version': 1, 'operation_id': 'op:' + key, 'target': plan['target'],
                  'plan_sha256': plan['plan_sha256'], 'revision': 1, 'items': [item],
                  'checks': [{'work_item_id': edit['work_item_id'], 'before_text_sha256': edit['before_text_sha256'],
                              'after_text_sha256': after, 'saved_at': at, 'read_back_at': at, 'evidence_ref': ref}],
                  'file_sha256': hashlib.sha256(b'fixture-memory-only').hexdigest(), 'saved_at': at,
                  'review_status': 'awaiting_owner'}
        body = receipt('succeeded', effects=[effect('owner_data', args['target_id'], 'document.text.update',
            'verified', ref, ref)], values=[value('completed', 1, '处', 'observed', ref, at)],
            content=[{'key': 'edit_result', 'text': json.dumps(result, ensure_ascii=False), 'provenance': 'observed'}])
        body['work_items'] = [item]
        self.calls[key] = {'identity': identity, 'receipt': deepcopy(body)}
        return body


def register(host):
    real_register(host, FakePlatform())
