import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, subscriptionBaseUrl, subscriptionKey } from './subscription-connection.mjs';

const execute = promisify(execFile);
export const usageVersion = '20.0.21';
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9._/-]{1,128}$/.test(value) ? value : 'unknown';

// ccusage inputTokens excludes both cache read and cache creation. Native
// Codex input_tokens includes them. Keep one explicit convention at this boundary.
export function normalizeTokens(value = {}) {
  const uncachedInputTokens = count(value.inputTokens);
  const cachedInputTokens = count(value.cacheReadTokens);
  const cacheWriteInputTokens = count(value.cacheCreationTokens);
  const inputTokens = [uncachedInputTokens, cachedInputTokens, cacheWriteInputTokens].every(n => n !== null)
    ? count(uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens) : null;
  return { inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteInputTokens,
    outputTokens: count(value.outputTokens), reasoningOutputTokens: count(value.reasoningOutputTokens),
    totalTokens: count(value.totalTokens),
    cacheReadPercent: inputTokens > 0 ? cachedInputTokens / inputTokens * 100 : null };
}

export function normalizeReport(report, timezone) {
  if (!report || !Array.isArray(report.daily) || !report.totals) throw new Error('Invalid ccusage report');
  return { source: 'ccusage', version: usageVersion, scope: 'Local Codex JSONL sessions today, including direct connections',
    timezone, ...normalizeTokens(report.totals),
    days: report.daily.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date)).map(row => ({ date: row.date,
      ...normalizeTokens(row), models: Object.entries(row.models ?? {}).map(([model, values]) => ({
        model: safeName(model), modelInferred: values.isFallback === true, ...normalizeTokens(values),
      })) })),
    costEstimate: null, subscriptionCharge: null,
    limitations: ['Local recorded usage only; compressed archives are excluded.',
      'Reasoning tokens are part of output tokens.', 'Token counts do not determine subscription quota.'] };
}

export async function readCodexUsage({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const { stdout } = await execute(process.execPath, [join(root, 'node_modules/ccusage/src/cli.js'),
    'codex', 'daily', '--last', '1', '--json', '--no-cost', '--offline', '--timezone', timezone,
    '--config', join(root, 'CONFIG/ccusage.json')], {
    cwd: root, env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' },
    timeout: 45000, maxBuffer: 8 * 1024 * 1024,
  });
  return normalizeReport(JSON.parse(stdout), timezone);
}

async function sessionFiles(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await sessionFiles(path, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

function quotaWindow(value) {
  if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent) || value.used_percent < 0 ||
      !Number.isSafeInteger(value.window_minutes) || value.window_minutes < 1 ||
      !Number.isSafeInteger(value.resets_at) || value.resets_at < 0 || value.resets_at > 8640000000000) return null;
  return { usedPercent: value.used_percent, remainingPercent: Math.max(0, 100 - value.used_percent),
    windowMinutes: value.window_minutes, resetsAt: new Date(value.resets_at * 1000).toISOString() };
}

export function quotaFromEvent(event, now = Date.now()) {
  if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return null;
  const value = event.payload.rate_limits;
  const observed = Date.parse(event.timestamp);
  if (!value || !Number.isFinite(observed) || observed > now + 60000) return null;
  const primary = quotaWindow(value.primary), secondary = quotaWindow(value.secondary);
  if (!primary && !secondary) return null;
  return { limitId: safeName(value.limit_id ?? 'codex'), observedAt: new Date(observed).toISOString(),
    primary, secondary };
}

// Only bounded tails are parsed for rate-limit metadata. No prompts, account
// identifiers, credit balances, paths or session IDs leave this reader.
export async function readCodexLimits({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), now = Date.now() } = {}) {
  const files = (await Promise.all(codexHome.split(',').filter(Boolean).map(home => sessionFiles(join(resolve(home), 'sessions'))))).flat();
  const recent = [];
  for (const path of files) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) continue;
    try { const meta = await file.stat(); recent.push({path, modified: meta.mtimeMs}); }
    finally { await file.close(); }
  }
  recent.sort((a, b) => b.modified - a.modified);
  const limits = new Map();
  for (const {path} of recent.slice(0, 32)) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) continue;
    try {
      const {size} = await file.stat();
      const start = Math.max(0, size - 512 * 1024);
      const data = Buffer.alloc(size - start);
      const {bytesRead} = await file.read(data, 0, data.length, start);
      const lines = data.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines.shift();
      lines.pop(); // A partial last line may still be in the writer's buffer.
      for (const line of lines) {
        if (!line.includes('"token_count"')) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        const limit = quotaFromEvent(event, now);
        if (limit && (!limits.has(limit.limitId) || limit.observedAt > limits.get(limit.limitId).observedAt)) limits.set(limit.limitId, limit);
      }
    } finally { await file.close(); }
  }
  return { source: 'Codex-reported rate-limit snapshots in local sessions',
    scope: 'Account limits as last reported; may be shared with other devices',
    limits: [...limits.values()].map(limit => ({ ...limit, ageSeconds: Math.max(0, (now - Date.parse(limit.observedAt)) / 1000),
      stale: now - Date.parse(limit.observedAt) > 300000 || [limit.primary, limit.secondary].some(w => w && Date.parse(w.resetsAt) <= now) })) };
}

export async function collectUsage(options = {}) {
  const results = await Promise.allSettled([readCodexUsage(options), readCodexLimits(options)]);
  return { sampledAt: new Date().toISOString(), status: results.every(r => r.status === 'fulfilled') ? 'ready' : 'partial',
    codex: results[0].status === 'fulfilled' ? results[0].value : null,
    quota: results[1].status === 'fulfilled' ? results[1].value : null,
    errors: results.flatMap((r, i) => r.status === 'rejected' ? [i === 0 ? 'Codex usage scan unavailable' : 'Codex limit snapshot unavailable'] : []) };
}

export function startUsageMonitor({ telemetry, intervalMs = 30000, collect = collectUsage } = {}) {
  let snapshot = { status: 'loading', sampledAt: null, codex: null, quota: null, errors: [] };
  let timer, stopped = false, lastFingerprint;
  const refresh = async () => {
    try {
      snapshot = await collect();
      const fingerprint = JSON.stringify(snapshot.codex?.days);
      if (fingerprint && fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        for (const day of snapshot.codex.days) telemetry?.usageSnapshot({
          'organized.usage.source': 'ccusage', 'organized.usage.date': day.date,
          'organized.usage.input_tokens': day.inputTokens, 'organized.usage.output_tokens': day.outputTokens,
          'organized.usage.cached_input_tokens': day.cachedInputTokens, 'organized.usage.total_tokens': day.totalTokens,
        });
        if (telemetry) void telemetry.flush();
      }
    } catch { snapshot = {...snapshot, status: 'error', errors: ['Usage refresh failed; previous sample retained']}; }
    if (!stopped) { timer = setTimeout(refresh, intervalMs); timer.unref(); }
  };
  void refresh();
  return { snapshot: () => structuredClone(snapshot), stop: () => { stopped = true; clearTimeout(timer); } };
}

export async function routerUsage() {
  const response = await fetch(subscriptionBaseUrl + '/api/usage', { redirect: 'error',
    headers: { 'x-organized-gateway-key': await subscriptionKey() }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Router usage endpoint unavailable');
  return await response.json();
}
