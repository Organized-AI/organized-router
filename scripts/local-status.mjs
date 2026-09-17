import { localConnection } from './local-connection.mjs';

try {
  const c = await localConnection();
  const health = await fetch(c.baseUrl + '/health', { signal: AbortSignal.timeout(3000) });
  const statsResponse = await fetch(c.baseUrl + '/api/cache/stats', {
    headers: { authorization: 'Bearer ' + c.gatewayKey }, signal: AbortSignal.timeout(3000),
  });
  const stats = await statsResponse.json();
  process.stdout.write(JSON.stringify({ endpoint: c.baseUrl + '/v1', model: c.model,
    gatewayHealthy: health.ok, providerKeyConfigured: c.ready,
    requests: stats.requests, upstreamAttempts: stats.upstreamAttempts,
    cacheHits: stats.hits, promptCacheReadTokens: stats.cacheReadTokens }, null, 2) + '\n');
  if (!health.ok || !statsResponse.ok) process.exitCode = 1;
} catch {
  process.stderr.write('Local gateway is unavailable or .dev.vars is not configured. Run npm run dev first.\n');
  process.exitCode = 1;
}
