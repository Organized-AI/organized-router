import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const [file] = process.argv.slice(2);
if (!file) {
  process.stderr.write('Usage: node scripts/configure.mjs CONFIG/my-router.json\n');
  process.exitCode = 1;
} else {
  const config = JSON.parse(await readFile(resolve(file), 'utf8'));
  if (!config.routes || JSON.stringify(config).includes('REPLACE_WITH')) throw new Error('Choose real model IDs before configuring');
  const gateKey = 'org_' + randomBytes(32).toString('hex');
  // Exclusive creation avoids overwriting an existing operator configuration.
  await writeFile('.dev.vars', [
    'GATE_API_KEY=' + gateKey,
    'PROVIDER_KEYS=' + JSON.stringify({ openai: '', anthropic: '' }),
    'ROUTER_CONFIG=' + JSON.stringify(config),
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  process.stdout.write('Created .dev.vars with a random gateway key. Add provider keys there, then run npm run dev.\n');
}
