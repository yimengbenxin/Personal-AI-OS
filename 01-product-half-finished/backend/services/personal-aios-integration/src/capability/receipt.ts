import {qualifyWorkItems} from './work-items.ts';
import type {WorkItemReceipt} from '../../../../../../capability/contracts/work-items.ts';
import Ajv2020Module from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {unknown, unknown_fact, type Receipt} from '../../../../../../capability/sdk/ts/receipt.ts';

const schema = JSON.parse(readFileSync(new URL(
  '../../../../../../capability/contracts/receipt.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020Module.default({strict: true});
ajv.addFormat('date-time', value =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
  Number.isFinite(Date.parse(value)));
const validate = ajv.compile<Receipt>(schema);
const uncertainReason = /(?:^|_)(?:TIMEOUT|DISCONNECTED)(?:_|$)/u;

/** Package trust boundary. Call with MCP structuredContent, not its text summary. */
export function admitReceipt(raw: unknown): WorkItemReceipt {
  if (!validate(raw)) {
    return unknown({status: {reason_code: 'CAPABILITY_RECEIPT_INVALID'},
      unknowns: [unknown_fact('contract_violation', ajv.errorsText(validate.errors))]});
  }
  const body = structuredClone(raw);
  if (body.status.state === 'rejected') {
    body.status.state = 'unknown';
    body.status.reason_code = 'CAPABILITY_PACKAGE_REJECTED';
    body.next.retry = 'after_check';
    body.unknowns.push(unknown_fact('contract_violation', 'Only the gateway may write rejected.'));
  }
  if (body.status.state === 'failed' && uncertainReason.test(body.status.reason_code ?? '')) {
    body.status.state = 'unknown';
    body.next.retry = 'after_check';
    body.unknowns.push(unknown_fact('outcome', 'A timeout or disconnect does not prove failure.'));
  }
  if (body.status.state === 'succeeded') {
    const verified = body.effects.filter(effect =>
      effect.verification === 'verified' || effect.verification === 'service_ack').length;
    if (verified < body.effects.length) {
      body.status.state = verified > 0 ? 'partial' : 'unknown';
      body.unknowns.push(unknown_fact('contradiction', 'Succeeded was claimed with unverified effects.'));
    }
  }
  return qualifyWorkItems(body);
}
