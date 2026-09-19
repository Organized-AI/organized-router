import { subscriptionKey, subscriptionBaseUrl } from './subscription-connection.mjs';

try {
  const response = await fetch(subscriptionBaseUrl + '/api/cache/stats', {
    headers: { 'x-organized-gateway-key': await subscriptionKey() }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error();
  process.stdout.write(JSON.stringify({ endpoint: subscriptionBaseUrl, ...await response.json() }, null, 2) + '\n');
} catch {
  process.stderr.write('Subscription router is unavailable. Run npm run router:subscription first.\n');
  process.exitCode = 1;
}
