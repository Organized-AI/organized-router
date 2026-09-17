import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readCodexUsage, readCodexLimits, normalizeTokens, quotaFromEvent, startUsageMonitor } from '../scripts/usage.mjs';
import { usageText } from '../scripts/usage-status.mjs';
import { codexArguments } from '../scripts/codex-arguments.mjs';
import { createSubscriptionProxy } from '../scripts/subscription-proxy.mjs';
import { createTelemetry } from '../src/telemetry/telemetry.mjs';

async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), 'organized-usage-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  for (const name of ['sessions', 'archived_sessions']) await mkdir(join(directory, name));
  return directory;
}
const now = new Date().toISOString();
const usage = (input, cached, output) => ({input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:2,total_tokens:input+output});
const entry = (total, last = total) => ({timestamp:now,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:total,last_token_usage:last}}});
const quota = (used = 40, timestamp = now, id = 'codex') => ({timestamp,type:'event_msg',payload:{type:'token_count',rate_limits:{limit_id:id,
  primary:{used_percent:used,window_minutes:10080,resets_at:Math.floor(Date.now()/1000)+86400},secondary:null,
  credits:{balance:'private-credit-balance'},account_id:'private-account'}}});

test('normalizes cached input and does not count reasoning twice; unknown remains unknown', () => {
  const result = normalizeTokens({inputTokens:100,cacheReadTokens:850,cacheCreationTokens:50,outputTokens:20,reasoningOutputTokens:12,totalTokens:1020});
  assert.equal(result.inputTokens,1000); assert.equal(result.cacheReadPercent,85); assert.equal(result.totalTokens,1020);
  assert.equal(normalizeTokens({inputTokens:2}).inputTokens,null);
  assert.equal(normalizeTokens({inputTokens:-1,cacheReadTokens:0,cacheCreationTokens:0}).inputTokens,null);
});

test('pinned ccusage binary counts advancing usage and prefers active files over duplicate archives', async t => {
  const directory=await home(t);
  const context={timestamp:now,type:'turn_context',payload:{model:'gpt-6-astra'}};
  const rows=[context,entry(usage(100,60,10)),entry(usage(100,60,10)),entry(usage(250,150,25),usage(150,90,15))];
  const contents=rows.map(JSON.stringify).join('\n')+'\n';
  await writeFile(join(directory,'sessions','fixture.jsonl'),contents);
  await writeFile(join(directory,'archived_sessions','fixture.jsonl'),contents);
  const result=await readCodexUsage({codexHome:directory,timezone:'UTC'});
  assert.equal(result.inputTokens,250); assert.equal(result.cachedInputTokens,150);
  assert.equal(result.outputTokens,25); assert.equal(result.totalTokens,275);
  assert.equal(result.costEstimate,null); assert.equal(result.subscriptionCharge,null);
  assert.equal(result.days[0].models[0].model,'gpt-6-astra');
});

test('limit snapshots select latest per bucket, reject malformed readings and exclude private fields', async t => {
  const directory=await home(t);
  await writeFile(join(directory,'sessions','one.jsonl'), [quota(30,new Date(Date.now()-600000).toISOString()),quota(40),
    {type:'response_item',payload:{content:'secret prompt'}},quota(90,now,'codex-other')].map(JSON.stringify).join('\n')+'\n{"partial":');
  const result=await readCodexLimits({codexHome:directory});
  assert.equal(result.limits.length,2);
  const primary=result.limits.find(x=>x.limitId==='codex');
  assert.equal(primary.primary.remainingPercent,60); assert.equal(primary.secondary,null); assert.equal(primary.stale,false);
  for(const secret of ['private-credit-balance','private-account','secret prompt','one.jsonl']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(quotaFromEvent(quota(-2)),null);
  assert.equal(quotaFromEvent(quota(20,new Date(Date.now()+120000).toISOString())),null);
  const text=usageText({status:'ready',sampledAt:now,codex:null,quota:{limits:[{...primary,observedAt:new Date(Date.now()-600000).toISOString()}]}});
  assert.match(text,/STALE/);
});

test('usage endpoint requires the private key, excludes polling telemetry and keeps totals separate', async t => {
  const gatewayKey='b'.repeat(64);
  const server=createSubscriptionProxy({gatewayKey,requestUpstream(){assert.fail('No inference expected');},
    telemetry:{start(){assert.fail('Usage polling must not create request telemetry');}},
    usageMonitor:{snapshot:()=>({status:'ready',sampledAt:now,codex:{totalTokens:275}})}});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/usage`;
  assert.equal((await fetch(base)).status,401);
  const response=await fetch(base,{headers:{'x-organized-gateway-key':gatewayKey}});
  const result=await response.json();
  assert.equal(result.codex.totalTokens,275); assert.equal(result.router.inputTokens,0);
  assert.ok(!JSON.stringify(result).includes(gatewayKey));
});

test('monitor serializes scans and emits only changed metadata snapshots', async () => {
  let scans=0, active=0, highest=0; const events=[];
  const monitor=startUsageMonitor({intervalMs:5,telemetry:{usageSnapshot:e=>events.push(e),flush:async()=>{}},collect:async()=>{
    active++; highest=Math.max(highest,active); await delay(8); active--; scans++;
    return {status:'ready',codex:{days:[{date:now.slice(0,10),inputTokens:100,outputTokens:10,cachedInputTokens:60,totalTokens:110}]}};
  }});
  await delay(60); monitor.stop(); await delay(15);
  assert.ok(scans>=2); assert.equal(highest,1); assert.equal(events.length,1);
});

test('usage telemetry exports metadata-only logs without creating fake inference spans', async () => {
  const exported=[];
  const telemetry=createTelemetry({serviceName:'fixture',mode:'subscription',capture:async(signal,payload)=>exported.push({signal,payload})});
  telemetry.usageSnapshot({'organized.usage.source':'ccusage','organized.usage.input_tokens':100, 'prompt':'secret-payload'});
  await telemetry.flush(); await telemetry.shutdown();
  assert.deepEqual(exported.map(x=>x.signal),['logs']);
  assert.ok(JSON.stringify(exported).includes('organized.usage.snapshot'));
  assert.ok(!JSON.stringify(exported).includes('secret-payload'));
});

test('native Codex retains provider overrides when user settings were placed after a subcommand', async t => {
  const directory=await home(t);
  // config/read performs no inference; the loopback URL must never receive a request.
  const args=codexArguments(['app-server','--stdio','-c','model_reasoning_effort="low"'],['-c','model_provider="organized_fixture"',
    '-c','model_providers.organized_fixture={name="fixture",base_url="http://127.0.0.1:1",wire_api="responses"}']);
  const {spawn}=await import('node:child_process');
  const {createInterface}=await import('node:readline');
  const server=spawn('codex',args,{env:{...process.env,CODEX_HOME:directory},cwd:directory,stdio:['pipe','pipe','ignore']});
  const timeout=setTimeout(()=>server.kill('SIGTERM'),15000);
  t.after(()=>{clearTimeout(timeout);server.kill('SIGTERM');});
  let n=0; const pending=new Map();
  createInterface({input:server.stdout}).on('line',line=>{const e=JSON.parse(line);const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.reject(e.error):p.resolve(e.result);}});
  const send=(method,params)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});server.stdin.write(JSON.stringify({id,method,params})+'\n');});
  await send('initialize',{clientInfo:{name:'usage-regression',version:'0.1.0'},capabilities:{experimentalApi:true}});
  server.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const {config}=await send('config/read',{includeLayers:false});
  assert.equal(config.model_provider,'organized_fixture'); assert.equal(config.model_reasoning_effort,'low');
  assert.deepEqual(codexArguments(['exec','--','-c prompt text'],[]),['exec','--','-c prompt text']);
  const closed=once(server,'close');server.stdin.end();await closed;
});
