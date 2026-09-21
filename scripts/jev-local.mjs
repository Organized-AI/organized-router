import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './subscription-connection.mjs';
import { createJevShadow } from '../src/decision/jev.mjs';

export async function subscriptionDecisions({ telemetry, onDecision, directory = resolve(root, '.local'), env = process.env } = {}) {
  let settings = {};
  try { settings = JSON.parse(await readFile(resolve(directory, 'jev.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') settings = { mode: 'invalid' }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = { mode: 'invalid' };
  if (env.TYPESAFE_API_KEY) settings.apiKey = env.TYPESAFE_API_KEY;
  return createJevShadow({ settings, telemetry, onDecision });
}
