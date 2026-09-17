import { object } from '../cache/policy';
import type { Candidate, Endpoint, RouterConfig } from './types';

export const ENDPOINTS: Endpoint[] = ['/v1/responses', '/v1/chat/completions', '/v1/messages'];
export function parseConfig(raw: string | undefined, local = false): RouterConfig {
  const cfg = object(JSON.parse(raw ?? '{}'));
  const routes = object(cfg.routes);
  if (!Object.keys(routes).length) throw new Error('ROUTER_CONFIG must define routes');
  for (const [name, items] of Object.entries(routes)) {
    if (!name || name.length > 64 || !Array.isArray(items) || !items.length || items.length > 8) throw new Error('Invalid route candidates');
    const ids = new Set();
    for (const item of items) {
      const c = object(item);
      for (const key of ['id', 'provider', 'model', 'baseUrl']) {
        const max = key === 'baseUrl' ? 2048 : key === 'model' ? 256 : 64;
        if (typeof c[key] !== 'string' || !c[key] || (c[key] as string).length > max) throw new Error('Invalid candidate field: ' + key);
      }
      if (ids.has(c.id)) throw new Error('Duplicate candidate id');
      ids.add(c.id);
      if (!['openai', 'anthropic'].includes(String(c.protocol))) throw new Error('Unsupported protocol');
      const url = new URL(String(c.baseUrl));
      if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
        throw new Error('Provider URL must use HTTPS (loopback HTTP only in local mode)');
      }
      if (!Array.isArray(c.endpoints) || !c.endpoints.length || c.endpoints.some(p =>
        !ENDPOINTS.includes(p) || (c.protocol === 'anthropic') !== (p === '/v1/messages'))) throw new Error('Invalid candidate endpoints');
      if (c.prices !== undefined) {
        const p = object(c.prices);
        if (typeof p.input !== 'number' || typeof p.output !== 'number' || Object.values(p).some(v =>
          typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('Invalid candidate prices');
      }
    }
  }
  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + key);
    return value;
  };
  return { routes: routes as Record<string, Candidate[]>, timeoutMs: bounded('timeoutMs', 60000, 100, 300000),
    responseTtlSeconds: bounded('responseTtlSeconds', 300, 1, 86400), maxEntries: bounded('maxEntries', 128, 1, 1024),
    maxEntryBytes: bounded('maxEntryBytes', 64000, 128, 96000) };
}
