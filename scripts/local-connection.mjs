import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export async function localConnection() {
  const text = await readFile(resolve(root, '.dev.vars'), 'utf8');
  const values = Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  const config = JSON.parse(values.ROUTER_CONFIG);
  const providers = JSON.parse(values.PROVIDER_KEYS);
  const model = Object.keys(config.routes).find(alias => config.routes[alias].some(c => c.endpoints.includes('/v1/responses')));
  if (!model || !values.GATE_API_KEY) throw new Error('Configure a Responses route and gateway key in .dev.vars first.');
  return { model, gatewayKey: values.GATE_API_KEY, ready: config.routes[model].every(c => Boolean(providers[c.provider])),
    baseUrl: 'http://127.0.0.1:8787' };
}
