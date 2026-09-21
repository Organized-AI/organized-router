import { subscriptionBaseUrl, subscriptionKey } from './subscription-connection.mjs';
import { subscriptionDecisions } from './jev-local.mjs';
import { subscriptionTelemetry } from './telemetry-local.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--probe')) throw new Error('Use --probe or no arguments');
  if (args.includes('--probe')) {
    const telemetry = await subscriptionTelemetry();
    const decisions = await subscriptionDecisions({ telemetry });
    try {
      if (!decisions.stats.active) throw new Error('Jev is not configured');
      // Public synthetic task only. This verifies connectivity, not routing quality.
      const result = await decisions.observe({ model: decisions.stats.models.complex, input: 'Fix a single spelling error in the README title.' }, { source: 'probe' });
      process.stdout.write(JSON.stringify({ ...decisions.stats, probeResult: result }, null, 2) + '\n');
      if (!result || !['classified', 'uncertain', 'low_confidence'].includes(result.reason)) process.exitCode = 1;
    } finally { await decisions.shutdown(); await telemetry.flush(); await telemetry.shutdown(); }
  } else {
    const response = await fetch(subscriptionBaseUrl + '/api/decisions', {
      headers: { 'x-organized-gateway-key': await subscriptionKey() }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Decision status unavailable');
    process.stdout.write(JSON.stringify(await response.json(), null, 2) + '\n');
  }
} catch {
  process.stderr.write('Jev status/probe unavailable. Check configuration and the running subscription service. No credentials were printed.\n');
  process.exitCode = 1;
}
