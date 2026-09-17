import { createSubscriptionProxy } from './subscription-proxy.mjs';
import { subscriptionKey, subscriptionBaseUrl } from './subscription-connection.mjs';

const server = createSubscriptionProxy({ gatewayKey: await subscriptionKey({ create: true }) });
server.on('error', error => { process.stderr.write(`Subscription router could not start (${error.code ?? 'unknown'}).\n`); process.exitCode = 1; });
server.listen(8788, '127.0.0.1', () => process.stdout.write(`Organized Router subscription mode: ${subscriptionBaseUrl}\nUpstream: ChatGPT Codex subscription. No API-key fallback.\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
