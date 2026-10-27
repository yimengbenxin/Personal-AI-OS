import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical, check, ContractError, digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {receipt, to_mcp_result} from '../../../../../../capability/sdk/ts/receipt.ts';
import {PERSONALITY_LIMIT, preferenceHeading, preferenceFrame, validatePreferences} from './preferences.ts';

interface Version {
  version: number; content: string; action: 'initial'|'apply'|'revert'; at: string;
  call_key?: string; fingerprint?: string; restored_from?: number;
}
interface Document {current: number; previous: number|null; history: Version[]}
const initial = (): Document => ({current: 0, previous: null, history: [
  {version: 0, content: '', action: 'initial', at: '1970-01-01T00:00:00.000Z'}]});
const key = (principal: string) => digest({principal_id: principal});

/** Platform-owned state. The existing single-writer storage fence and atomic replace commit history and pointers together. */
export class PersonalityZone {
  private storage: StoragePort;
  constructor(storage: StoragePort) {this.storage = storage;}
  private async document(principal: string): Promise<Document> {
    try {return JSON.parse(Buffer.from(await this.storage.read('personality-zones', key(principal))).toString());}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return initial();}
  }
  private view(doc: Document, offset = 0, limit = 20) {
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50,
      'PERSONALITY_PAGE_INVALID');
    const history = [...doc.history].reverse().slice(offset, offset + limit);
    return {current: doc.current, previous: doc.previous, content: doc.history[doc.current]!.content,
      limit_chars: PERSONALITY_LIMIT, history, total_versions: doc.history.length,
      next_offset: offset + history.length < doc.history.length ? offset + history.length : null};
  }
  async read(principal: string, offset = 0, limit = 20) {return this.view(await this.document(principal), offset, limit);}
  async call(principal: string, args: Record<string, unknown>, callKey: string) {
    if (args.action === 'read') return {status: 'read', ...await this.read(principal, args.offset as number, args.limit as number)};
    check(['propose', 'apply', 'revert'].includes(String(args.action)), 'PERSONALITY_ACTION_INVALID');
    const content = args.action === 'revert' ? undefined : validatePreferences(args.content);
    check(Number.isSafeInteger(args.expected_version) && Number(args.expected_version) >= 0, 'PERSONALITY_VERSION_REQUIRED');
    check(this.storage.withOriginalWrite && this.storage.replace, 'PERSONALITY_PLATFORM_STORAGE_REQUIRED', 503);
    return this.storage.withOriginalWrite(async () => {
      let doc = await this.document(principal);
      const fingerprint = digest(args), prior = doc.history.find(row => row.call_key === callKey);
      if (prior) {
        check(prior.fingerprint === fingerprint, 'PERSONALITY_CALL_CONFLICT', 409);
        doc = {current: prior.version, previous: prior.version - 1, history: doc.history.slice(0, prior.version + 1)};
        return {status: 'committed', ...this.view(doc), diff: {before: doc.history[prior.version - 1]!.content, after: prior.content},
          owner_line: prior.action === 'revert' ? '已恢复上一次的说话偏好。' : '已更新我的说话偏好。'};
      }
      check(doc.current === args.expected_version, 'PERSONALITY_VERSION_CONFLICT', 409);
      if (args.action === 'revert') check(doc.previous !== null, 'PERSONALITY_NO_PREVIOUS', 409);
      const after = content ?? doc.history[doc.previous!]!.content;
      const diff = {before: doc.history[doc.current]!.content, after};
      if (args.action === 'propose') return {status: 'proposed', ...this.view(doc), diff};
      const version: Version = {version: doc.current + 1, content: after, action: args.action as 'apply'|'revert',
        at: new Date().toISOString(), call_key: callKey, fingerprint,
        ...(args.action === 'revert' ? {restored_from: doc.previous!} : {})};
      const updated = {current: version.version, previous: doc.current, history: [...doc.history, version]};
      await this.storage.replace!('personality-zones', key(principal), Buffer.from(canonical(updated)));
      return {status: 'committed', ...this.view(updated), diff,
        owner_line: args.action === 'revert' ? '已恢复上一次的说话偏好。' :
          `已调整说话偏好：${after ? after.split('\n').map(line => line.split('：')[1]).join('、').slice(0, 50) : '恢复默认'}。`};
    });
  }
  /** Read-only derived view in the same platform volume as USER.md/MEMORY.md, never SOUL.md. */
  async project(principal: string, home: string) {
    check(this.storage.withOriginalWrite, 'PERSONALITY_PLATFORM_STORAGE_REQUIRED', 503);
    await this.storage.withOriginalWrite(async () => {
      const doc = await this.read(principal), directory = join(home, 'memories');
      await fs.mkdir(directory, {recursive: true});
      const path = join(directory, 'PERSONALITY.md'), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${preferenceHeading}\n${preferenceFrame}\n版本：${doc.current}\n${doc.content || '（沿用锁定人格的默认说话偏好）'}\n`, {flag: 'wx', mode: 0o444});
        await fs.rename(temporary, path);
      } finally {await fs.rm(temporary, {force: true});}
    });
  }
}

/** The existing self_change authority recognizes only this built-in ordinary preference tool. All other releases keep their gate. */
export function personalityDecision(call: {package?: string; tool_name: string; package_digest?: string; args: Record<string, unknown>}):
  {action: 'allow'}|{action: 'block'; message: string}|undefined {
  if (call.package !== 'ts-personality' || call.tool_name !== 'mcp__platform_ts__paios_personality_zone' || call.package_digest) return;
  try {
    check(['apply', 'revert'].includes(String(call.args.action)), 'PERSONALITY_ACTION_INVALID');
    if (call.args.action === 'apply') validatePreferences(call.args.content);
    return {action: 'allow'};
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return {action: 'block', message: JSON.stringify(to_mcp_result(receipt('rejected', {
      status: {reason_code: error.code}, content: [{key: 'reason', text: error.code === 'PERSONALITY_LIMIT_1500' ?
        '性格偏好区最多1500个字符。' : '只接受词表中的语气、表达和习惯偏好句；身份、安全和受保护基线不可修改。', provenance: 'computed'}]})))};
  }
}
