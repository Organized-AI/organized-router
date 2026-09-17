#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { collectUsage, routerUsage } from './usage.mjs';

export function usageText(snapshot) {
  const n = value => value == null ? 'unknown' : value.toLocaleString('en-US', {maximumFractionDigits: 1});
  const lines = ['Organized Router • live usage', `Sample: ${snapshot.sampledAt ?? 'loading'} (${snapshot.status})`];
  if (snapshot.codex) {
    const c = snapshot.codex;
    lines.push(`Today · local Codex sessions · ${c.timezone}`, `Input ${n(c.inputTokens)}  |  cached ${n(c.cachedInputTokens)} (${n(c.cacheReadPercent)}%)  |  output ${n(c.outputTokens)}`,
      `Total ${n(c.totalTokens)} tokens · reasoning is included in output`);
    for (const day of c.days) for (const m of day.models) lines.push(`  ${m.model}${m.modelInferred ? ' (inferred model)' : ''}: ${n(m.totalTokens)} total, ${n(m.cachedInputTokens)} cached`);
  }
  if (snapshot.router) lines.push(`Router since ${snapshot.router.startedAt ?? 'service start'}: ${n(snapshot.router.completedResponses)} completed, ${n(snapshot.router.inputTokens)} input, ${n(snapshot.router.cachedInputTokens)} cached`);
  lines.push('Subscription limits · reported by Codex');
  if (!snapshot.quota?.limits.length) lines.push('  No recorded limit snapshot available.');
  for (const limit of snapshot.quota?.limits ?? []) {
    const stale = limit.stale || Date.now() - Date.parse(limit.observedAt) > 300000;
    for (const window of [limit.primary, limit.secondary].filter(Boolean)) lines.push(`  ${limit.limitId} · ${n(window.windowMinutes / 60)}h window: ${n(window.usedPercent)}% used, ${n(window.remainingPercent)}% remaining · resets ${window.resetsAt}`);
    lines.push(`  Observed ${limit.observedAt}${stale ? ' · STALE: waiting for a new Codex reading' : ''}`);
  }
  lines.push('Local and router usage overlap; totals are not added. Subscription charges and quota savings are not inferred.');
  if (snapshot.errors?.length) lines.push(...snapshot.errors);
  return lines.join('\n') + '\n';
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const {values} = parseArgs({options:{watch:{type:'boolean'},json:{type:'boolean'},interval:{type:'string',default:'5'},help:{type:'boolean'}}});
    if (values.help) { console.log('organized-router usage [--watch] [--json] [--interval 5]\nRefreshes every 5 seconds; the background Codex scan runs every 30 seconds.'); }
    else {
      const interval = Number(values.interval);
      if (!Number.isFinite(interval) || interval < 1 || interval > 3600) throw new Error('Interval must be between 1 and 3600 seconds.');
      let fallback, fallbackAt = 0, stopped = false;
      const controller = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {stopped = true; controller.abort();});
      do {
        let snapshot;
        try { snapshot = await routerUsage(); }
        catch {
          if (!fallback || Date.now() - fallbackAt > 30000) { fallback = await collectUsage(); fallbackAt = Date.now(); }
          snapshot = {...fallback, router: null, errors: [...fallback.errors, 'Router usage unavailable; showing local Codex records.']};
        }
        if (values.watch && !values.json && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(values.json ? JSON.stringify(snapshot) + '\n' : usageText(snapshot));
        if (!values.watch || stopped) break;
        await delay(interval * 1000, undefined, {signal:controller.signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
      } while (!stopped);
    }
  } catch (error) { process.stderr.write(`Usage monitor: ${error.message}\n`); process.exitCode = 1; }
}
