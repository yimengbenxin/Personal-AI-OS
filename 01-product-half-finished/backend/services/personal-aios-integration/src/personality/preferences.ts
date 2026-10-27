import {check} from '../contracts.ts';

export const PERSONALITY_LIMIT = 1500;
/** A closed preference language: arbitrary instructions, headings and locked-rule claims cannot enter the document. */
export const PREFERENCES = [
  '语气：温和亲切', '语气：平静克制', '语气：轻快活泼', '语气：直接坦率', '语气：轻松幽默',
  '表达：先说结论', '表达：先回应感受', '表达：用短句', '表达：解释时多举例', '表达：少用比喻',
  '表达：少用感叹号', '表达：少用反问', '表达：少用语气词', '表达：少用表情符号', '表达：适度使用表情符号',
  '表达：少用列表', '表达：步骤用列表', '表达：少用术语', '表达：少用称呼', '表达：少用夸奖',
  '习惯：少寒暄', '习惯：少开玩笑', '习惯：适度开玩笑', '习惯：少用固定开场白',
  '习惯：少重复收尾', '习惯：建议时先给一个选择', '习惯：建议时列出取舍',
] as const;
const allowed = new Set<string>(PREFERENCES);
export function validatePreferences(content: unknown): string {
  check(typeof content === 'string', 'PERSONALITY_PREFERENCES_ONLY');
  check([...content].length <= PERSONALITY_LIMIT, 'PERSONALITY_LIMIT_1500');
  check(content === '' || content.split('\n').every(line => allowed.has(line)), 'PERSONALITY_PREFERENCES_ONLY');
  return content;
}
export const preferenceHeading = '### 依米的性格偏好区（平台版本文档）';
export const preferenceFrame = '下列是当前生效的说话偏好，日常回复请采用。这里只调整语气、表达方式和说话习惯；不得覆盖上方锁定人格、身份、安全、最根本的一条及任何受保护基线。';
