import {readFileSync} from 'node:fs';
import {effect, receipt, to_mcp_result, unknown_fact, value, type Receipt, type ReceiptOptions} from '../../../sdk/ts/receipt.ts';
import {withMedia} from '../../../sdk/ts/mcp-media.ts';

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
export const desktopPolicies = manifest.extensions['ai.yimi.capability'].tools as Record<string, {
  effect: 'observe'|'owner_data'; target?: string; retry: string; check_with: string;
}>;
export interface DesktopResult {
  content: {type: string; text?: string|undefined}[];
  structuredContent?: Record<string, unknown>|undefined;
  isError?: boolean|undefined;
}

/** Preserve structured observations; never infer quantities from rendered file text. */
function observations(body: unknown, at: string, fields: ReceiptOptions, key = ''): void {
  if (Array.isArray(body)) {
    fields.values!.push(value(key + '.count', body.length, 'items', 'computed', 'desktop relay', at));
    body.forEach((item, i) => observations(item, at, fields, `${key}[${i}]`));
  } else if (body !== null && typeof body === 'object') {
    for (const [name, item] of Object.entries(body)) observations(item, at, fields, key ? `${key}.${name}` : name);
  } else if (typeof body === 'string' && /(?:^|\.)(?:text|description|content)$/u.test(key)) {
    fields.content!.push({key, text: body, provenance: 'observed'});
  } else if (body !== undefined) {
    const unit = /(?:^|\.)(?:size|bytes)$/u.test(key) ? 'B' : /(?:^|\.)(?:width|height)$/u.test(key) ? 'px' : '1';
    fields.values!.push(value(key, body as number|string|boolean|null, unit, 'observed', 'desktop relay', at));
  }
}

/** These are the existing FileText.info and NativeFileExecutor.listing wire formats. */
function fileMetadata(name: string, body: Record<string, unknown>, at: string, fields: ReceiptOptions): void {
  const text = body.content;
  if (typeof text !== 'string') return;
  const add = (key: string, data: number|string, unit: string) => fields.values!.push(value(key, data, unit, 'observed', 'desktop relay', at));
  if (name === 'get_file_info') {
    for (const line of text.split('\n')) {
      const split = line.indexOf(': '), key = line.slice(0, split), data = line.slice(split + 2);
      if (key === 'size') add(key, Number(data), 'B');
      else if (['created', 'modified', 'accessed'].includes(key)) add(key, data, 'datetime');
      else if (key === 'permissions') add(key, data, 'octal');
    }
  } else if (name === 'list_directory_with_sizes') {
    for (const [index, line] of text.split('\n').entries()) {
      const size = /\s(\d+(?:\.\d+)?) (B|KB|MB|GB|TB)$/u.exec(line);
      if (size) add(`listing[${index}].size`, Number(size[1]), size[2]!);
      const totals = /^Total: (\d+) files, (\d+) directories$/u.exec(line);
      if (totals) {add('file_count', Number(totals[1]), 'files');add('directory_count', Number(totals[2]), 'directories');}
    }
  }
}

/** Wrap only the cloud-facing result. The paired Mac's request and result wire stays intact. */
export function desktopReceipt(name: string, args: Record<string, unknown>, result: DesktopResult, at = new Date().toISOString()): Receipt {
  const policy = desktopPolicies[name]!;
  const fields: ReceiptOptions = {values: [], content: [], effects: [], unknowns: []};
  const body = result.structuredContent ?? {};
  const code = (body.error as {code?: string}|undefined)?.code;
  if (result.isError) {
    const reason = code ?? 'DESKTOP_TOOL_FAILED';
    const uncertain = /TIMEOUT|DISCONNECTED|TRANSPORT_UNKNOWN/u.test(reason) || ['DESKTOP_CANCELLED', 'DESKTOP_PAUSED', 'DESKTOP_REVOKED', 'DESKTOP_AUDIT_STORE', 'TRANSFER_INTEGRITY'].includes(reason);
    return receipt(uncertain ? 'unknown' : 'failed', {status: {reason_code: reason},
      unknowns: uncertain ? [unknown_fact('outcome', 'The desktop transport did not establish the final outcome.')] : [],
      next: {retry: uncertain ? 'after_check' : 'forbidden', check_with: policy.check_with}});
  }
  observations(body, at, fields);
  fileMetadata(name, body, at, fields);
  // window_capture's text is the cloud vision analysis; its metadata is observed on the Mac.
  if (name === 'window_capture') fields.content!.push(...result.content.filter(item => item.type === 'text' && item.text)
    .map(item => ({key: 'analysis', text: item.text!, provenance: 'inferred' as const})));
  else if (!Object.keys(body).length) fields.content!.push(...result.content.filter(item => item.type === 'text' && item.text)
    .map(item => ({key: 'text', text: item.text!, provenance: 'observed' as const})));
  const preview = name === 'edit_file' && args.dryRun === true;
  if (policy.effect !== 'observe' && !preview) {
    const selected = policy.target ? args[policy.target.slice(2)] : undefined;
    const targets = Array.isArray(selected) ? selected : [String(selected ?? body.path ?? 'owner Mac')];
    for (const target of targets) fields.effects!.push(effect(policy.effect, target, name, 'service_ack', 'The existing desktop relay returned the Mac operation result.'));
  }
  const truncated = body.truncated === true;
  return receipt(truncated ? 'partial' : 'succeeded', {...fields,
    ...(truncated ? {status: {reason_code: 'RESULT_TRUNCATED'}} : {}), next: {retry: 'forbidden'}});
}

export function desktopPackageResult(name: string, args: Record<string, unknown>, result: DesktopResult) {
  const wrapped = to_mcp_result(desktopReceipt(name, args, result));
  return {...withMedia(wrapped,result), structuredContent: {...wrapped.structuredContent}};
}
