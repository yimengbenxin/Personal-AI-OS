import {ColdStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/cold-storage.ts';

const [url, password, stage] = process.argv.slice(2);
const transport = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = async (input, init) => {
  const method = init?.method ?? 'GET';
  calls.push(method);
  if ((stage === 'before_put' && method === 'PUT') || (stage === 'before_verify' && method === 'GET')) {
    throw new Error('SYNTHETIC_UPLOAD_INTERRUPTED');
  }
  const response = await transport(input, init);
  if (stage === 'after_mkcol' && method === 'MKCOL') throw new Error('SYNTHETIC_UPLOAD_INTERRUPTED');
  return response;
};
const cold = new ColdStorage('.', {url: url!, username: 'pci', password_file: password!});
try {
  await cold.upload('backups/live', Buffer.from('new live cold recording'));
  throw new Error('EXPECTED_UPLOAD_INTERRUPTION');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'SYNTHETIC_UPLOAD_INTERRUPTED') throw error;
  console.log(JSON.stringify({stage, calls}));
} finally {
  await cold.close();
  globalThis.fetch = transport;
}
