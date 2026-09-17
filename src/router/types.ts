export type Json = Record<string, unknown>;
export type Endpoint = '/v1/responses' | '/v1/chat/completions' | '/v1/messages';
export interface Prices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}
export interface Candidate {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  endpoints: Endpoint[];
  prices?: Prices;
}
export interface RouterConfig {
  routes: Record<string, Candidate[]>;
  timeoutMs: number;
  responseTtlSeconds: number;
  maxEntries: number;
  maxEntryBytes: number;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  known: boolean;
}
export interface Receipt {
  id: string;
  at: number;
  route: string;
  candidate: string;
  status: number;
  cache: string;
  latencyMs: number;
  attempts: number;
  unpricedAttempts: number;
  usage: Usage;
  estimatedCostUsd: number | null;
  promptCacheDeltaUsd: number | null;
  avoidedCostUsd: number | null;
}
export interface CacheEntry {
  body: string;
  candidate: string;
  createdAt: number;
  expiresAt: number;
  cost: number | null;
}
export interface Affinity { candidate: string; expiresAt: number }
export interface Stats {
  requests: number;
  upstreamAttempts: number;
  hits: number;
  coalesced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  promptCacheDeltaUsd: number;
  avoidedCostUsd: number;
  unpricedRequests: number;
  unpricedAttempts: number;
  recent: Receipt[];
}
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  putBounded<T extends { expiresAt: number }>(prefix: string, key: string, value: T, limit: number, epoch: number): Promise<void>;
  delete(key: string): Promise<void>;
  epoch(): Promise<number>;
  clear(): Promise<void>;
  record(receipt: Receipt): Promise<void>;
  stats(): Promise<Stats>;
}
export const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, known: false };
export function emptyStats(): Stats {
  return { requests: 0, upstreamAttempts: 0, hits: 0, coalesced: 0, inputTokens: 0,
    outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0,
    promptCacheDeltaUsd: 0, avoidedCostUsd: 0, unpricedRequests: 0, unpricedAttempts: 0, recent: [] };
}
export function addReceipt(s: Stats, r: Receipt): Stats {
  s.requests++;
  s.upstreamAttempts += r.attempts;
  s.hits += Number(r.cache === 'hit');
  s.coalesced += Number(r.cache === 'coalesced');
  s.inputTokens += r.usage.input;
  s.outputTokens += r.usage.output;
  s.cacheReadTokens += r.usage.cacheRead;
  s.cacheWriteTokens += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
  s.estimatedCostUsd += r.estimatedCostUsd ?? 0;
  s.promptCacheDeltaUsd += r.promptCacheDeltaUsd ?? 0;
  s.avoidedCostUsd += r.avoidedCostUsd ?? 0;
  s.unpricedRequests += Number(r.attempts > 0 && r.estimatedCostUsd === null);
  s.unpricedAttempts = (s.unpricedAttempts ?? 0) + r.unpricedAttempts;
  s.recent = [r, ...s.recent].slice(0, 100);
  return s;
}
