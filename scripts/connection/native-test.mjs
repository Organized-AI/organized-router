import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function command(executable, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native Codex verification timed out')); }, 45000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code) reject(new Error(`${executable} verification failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function verifyNativeConnection({ root, temporary, base, catalog, native }) {
  const home = join(temporary, 'codex-home');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), 'model = "gpt-6-astra"\n');
  const catalogPath = join(temporary, 'codex-catalog.json');
  const nativePath = join(temporary, 'native-models.json');
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(nativePath, JSON.stringify(native));
  const setup = 'import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import configure; h=Path(sys.argv[2]); c=json.loads(Path(sys.argv[3]).read_text()); n=json.loads(Path(sys.argv[4]).read_text()); print(json.dumps(configure.configure(h,"api",sys.argv[5],"fixture-router-key",c,n,model="test")))';
  await command('python3', ['-c', setup, join(root, 'scripts/connection'), home, catalogPath, nativePath, base + '/v1']);
  const env = { ...process.env, CODEX_HOME: home };
  // No -c/provider overrides: the same saved default is consumed by CLI and app server.
  const output = await command('codex', ['--strict-config', 'exec', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', temporary, '--json', 'Reply with Fixture completion. Do not use tools.'], { env, cwd: temporary });
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text === 'Fixture completion'));
  const usage = events.find(event => event.type === 'turn.completed')?.usage;
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cached_input_tokens, 800);
  const threadId = events.find(event => event.type === 'thread.started')?.thread_id;
  assert.ok(threadId);
  await inspectAppServer({ env, temporary, provider: 'organized-router', model: 'test', threadId });
  const undo = 'import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import configure; print(json.dumps(configure.unconfigure(Path(sys.argv[2]))))';
  await command('python3', ['-c', undo, join(root, 'scripts/connection'), home]);
  await inspectAppServer({ env, temporary, provider: 'openai', threadId });
  return { cliDefaultProvider: 'organized-router', appServerDefaultProvider: 'organized-router', modelListed: 'test',
    commandAuthentication: true, providerOverridesUsed: false, inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens,
    nativeHistoryVisible: true, nativeHistoryVisibleAfterUnconfigure: true };
}

async function inspectAppServer({ env, temporary, provider, model, threadId }) {
  const server = spawn('codex', ['app-server', '--stdio', '--strict-config'], { env, cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: server.stdout }).on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    const promise = pending.get(event.id);
    if (promise) { pending.delete(event.id); event.error ? promise.reject(new Error(JSON.stringify(event.error))) : promise.resolve(event.result); }
  });
  server.stderr.resume();
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`app-server ${method} timed out`)); }, 20000);
    pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    server.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'organized-router-verification', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const configuration = await request('config/read', { includeLayers: false, cwd: temporary });
    assert.equal(configuration.config.model_provider ?? 'openai', provider);
    if (model) {
      const models = await request('model/list', { limit: 100 });
      assert.ok(models.data.some(row => row.id === model));
    }
    // Do not override modelProviders: verify the active-provider history filter.
    const threads = await request('thread/list', { limit: 100, sourceKinds: ['exec'] });
    assert.ok(threads.data.some(row => row.id === threadId), `Native history is hidden on ${provider}`);
  } finally {
    const closed = once(server, 'close');
    server.kill('SIGTERM');
    await closed;
  }
}
