import { spawn } from 'node:child_process';
import { subscriptionKey, subscriptionBaseUrl, root } from './subscription-connection.mjs';

try {
  const gatewayKey = await subscriptionKey();
  const health = await fetch(subscriptionBaseUrl + '/health', { signal: AbortSignal.timeout(3000) });
  if (!health.ok || (await health.json()).mode !== 'chatgpt-subscription') throw new Error('Subscription router is unavailable.');
  const options = {
    model_provider: 'organized_subscription',
    forced_login_method: 'chatgpt',
    'model_providers.organized_subscription.name': 'Organized Router (Codex subscription)',
    'model_providers.organized_subscription.base_url': subscriptionBaseUrl,
    'model_providers.organized_subscription.wire_api': 'responses',
    'model_providers.organized_subscription.requires_openai_auth': true,
    'model_providers.organized_subscription.supports_websockets': false,
  };
  const args = Object.entries(options).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]);
  args.push('-c', 'model_providers.organized_subscription.env_http_headers={"x-organized-gateway-key"="ORGANIZED_SUBSCRIPTION_KEY"}');
  args.push('--cd', root, ...process.argv.slice(2));
  const child = spawn('codex', args, { stdio: 'inherit', env: { ...process.env, ORGANIZED_SUBSCRIPTION_KEY: gatewayKey } });
  child.on('error', () => { process.stderr.write('Could not launch Codex CLI.\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write('Run npm run router:subscription first, and sign in with codex login.\n');
  process.exitCode = 1;
}
