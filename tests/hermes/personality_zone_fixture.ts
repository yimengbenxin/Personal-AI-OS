/** Fixtures only: produce both model contexts from the actual platform document authority. */
import {mkdir, copyFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {PersonalityZone} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/personality/zone.ts';

const out = process.argv[2]!;
const zone = new PersonalityZone(new PosixStorage(join(out, 'platform')));
for (const phase of ['before', 'after']) {
  if (phase === 'after') await zone.call('replay-owner', {action: 'apply', expected_version: 0,
    content: ['语气：轻快活泼', '语气：轻松幽默', '表达：适度使用表情符号', '习惯：适度开玩笑',
      '表达：先说结论', '表达：步骤用列表'].join('\n')}, 'sample-change');
  const home = join(out, phase);
  await mkdir(join(home, 'memories'), {recursive: true});
  await copyFile(new URL('../../integrations/hermes/personal_aios/persona/yimi.md', import.meta.url), join(home, 'SOUL.md'));
  for (const file of ['USER.md', 'MEMORY.md']) await writeFile(join(home, 'memories', file), '');
  await zone.project('replay-owner', home);
  await writeFile(join(out, `${phase}.json`), JSON.stringify(await zone.read('replay-owner'), null, 2));
}
