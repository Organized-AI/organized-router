import { addReceipt, emptyStats, type Receipt, type Stats, type Store, type RouterConfig } from '../src/router/types';

export class MemoryStore implements Store {
  rows = new Map<string, unknown>();
  version = 0;
  metrics = emptyStats();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.rows.get(key)) as T | undefined; }
  async epoch(): Promise<number> { return this.version; }
  async putBounded<T extends { expiresAt: number }>(prefix: string, key: string, value: T, limit: number, epoch: number): Promise<void> {
    if (epoch !== this.version) return;
    const entries = [...this.rows].filter(([k]) => k.startsWith(prefix) && k !== prefix + key);
    entries.sort((a, b) => (a[1] as T).expiresAt - (b[1] as T).expiresAt);
    for (const [id] of entries.slice(0, Math.max(0, entries.length - limit + 1))) this.rows.delete(id);
    this.rows.set(prefix + key, structuredClone(value));
  }
  async delete(key: string): Promise<void> { this.rows.delete(key); }
  async clear(): Promise<void> { this.version++; this.rows.clear(); }
  async record(r: Receipt): Promise<void> { addReceipt(this.metrics, r); }
  async stats(): Promise<Stats> { return structuredClone(this.metrics); }
}
export const config: RouterConfig = {
  routes: { test: [
    { id: 'primary', provider: 'one', model: 'model-a', baseUrl: 'https://one.invalid', protocol: 'openai',
      endpoints: ['/v1/responses', '/v1/chat/completions'], prices: { input: 2, output: 8, cacheRead: 0.2 } },
    { id: 'backup', provider: 'two', model: 'model-b', baseUrl: 'https://two.invalid', protocol: 'openai',
      endpoints: ['/v1/responses', '/v1/chat/completions'], prices: { input: 1, output: 4, cacheRead: 0.1 } },
  ], claude: [{ id: 'anthropic', provider: 'anthropic', model: 'claude-test', baseUrl: 'https://anthropic.invalid',
    protocol: 'anthropic', endpoints: ['/v1/messages'], prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 } }] },
  timeoutMs: 1000, responseTtlSeconds: 60, maxEntries: 8, maxEntryBytes: 64000,
};
export const keys = { one: 'secret-a', two: 'secret-b', anthropic: 'secret-c' };
export function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}, path = '/v1/responses'): Request {
  return new Request('https://router.invalid' + path, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-organized-cache': 'exact', ...headers }, body: JSON.stringify({ model: 'test', input: 'hello', temperature: 0, store: false, ...body }) });
}
export function completion(extra: Record<string, unknown> = {}): Response {
  return Response.json({ id: 'resp-test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 10 }, ...extra });
}
