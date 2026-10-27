import { createHash } from 'node:crypto';

export class ContractError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function check(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new ContractError(code, status);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  check(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_JSON');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const digest = (value: unknown): string => sha256(canonical(value));
