import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const subscriptionBaseUrl = 'http://127.0.0.1:8788';
export async function subscriptionKey({ create = false } = {}) {
  const directory = resolve(root, '.local');
  const file = resolve(directory, 'subscription.key');
  if (create) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local subscription key.');
  return key;
}
