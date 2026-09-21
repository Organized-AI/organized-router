import { createSubscriptionProxy } from './subscription-proxy.mjs';
import { subscriptionKey, subscriptionBaseUrl } from './subscription-connection.mjs';
import { subscriptionTelemetry } from './telemetry-local.mjs';
import { startUsageMonitor } from './usage.mjs';
import { subscriptionDecisions } from './jev-local.mjs';

const telemetry = await subscriptionTelemetry();
const usageMonitor = startUsageMonitor({ telemetry });
const decisions = await subscriptionDecisions({ telemetry });
const server = createSubscriptionProxy({ gatewayKey: await subscriptionKey({ create: true }), telemetry, usageMonitor, decisions });
server.on('error', error => { process.stderr.write(`Subscription router could not start (${error.code ?? 'unknown'}).\n`); process.exitCode = 1; });
server.listen(8788, '127.0.0.1', () => process.stdout.write(`Organized Router subscription mode: ${subscriptionBaseUrl}\nUpstream: ChatGPT Codex subscription. No API-key fallback.\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  usageMonitor.stop();
  server.closeAllConnections();
  server.close(async () => { await decisions.shutdown(); await telemetry.shutdown(); process.exit(0); });
});
