import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';

/** Platform computes the before/after document; the shared ledger computes delivered/new facts. */
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (['read', 'proposed', 'committed'].includes(row.status) && Number.isSafeInteger(row.current)) {
    const body = result(input, 'succeeded', {mutated: row.status === 'committed',
      ...(row.status === 'committed' ? {ref: `personality-version:${row.current}`} : {})});
    for (const value of body.values) {
      if (value.key === 'limit_chars') value.unit = 'character';
      if (value.key === 'total_versions') value.unit = 'count';
    }
    if (row.diff) body.content.push({key: 'personality.diff', text: JSON.stringify(row.diff), provenance: 'computed'});
    return body;
  }
  return unmapped(input);
}
