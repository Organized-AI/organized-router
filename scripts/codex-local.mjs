import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localConnection, root } from './local-connection.mjs';
import { codexArguments } from './codex-arguments.mjs';

try {
  const c = await localConnection();
  if (!c.ready) throw new Error('The local gateway is configured but its provider key is missing. Add the OpenAI key to PROVIDER_KEYS in .dev.vars.');
  const health = await fetch(c.baseUrl + '/health', { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('Start the gateway with npm run dev first.');
  const options = {
    model_provider: 'organized_router',
    'model_providers.organized_router.name': 'Organized Router (local)',
    'model_providers.organized_router.base_url': c.baseUrl + '/v1',
    'model_providers.organized_router.wire_api': 'responses',
    'model_providers.organized_router.env_key': 'ORGANIZED_ROUTER_API_KEY',
    'model_providers.organized_router.supports_websockets': false,
    'model_providers.organized_router.requires_openai_auth': false,
  };
  const args = Object.entries(options).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]);
  args.push('-c', 'model_providers.organized_router.http_headers={"X-Organized-Cache"="off","X-Organized-Session"="' + randomUUID() + '"}');
  const child = spawn('codex', codexArguments(process.argv.slice(2), args, ['--model', c.model, '--cd', root]),
    { stdio: 'inherit', env: { ...process.env, ORGANIZED_ROUTER_API_KEY: c.gatewayKey } });
  child.on('error', () => { process.stderr.write('Could not launch Codex CLI.\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Local connection failed') + '\n');
  process.exitCode = 1;
}
