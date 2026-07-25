import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlatform } from '../../runtime/platform.mjs';
import { startHostBridge } from '../../runtime/hosts/bridge-server.mjs';
import { OpenCodeExecutionHost } from '../../runtime/hosts/opencode.mjs';
import { OpenCodeClient } from '../../runtime/hosts/opencode-client.mjs';
import { createOpenCodeProofGraphPlugin } from '../../integrations/opencode/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin', 'proofgraph.mjs');

async function setupBridge(host = 'custom') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-adv-'));
  const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
  const platform = await createPlatform({ projectDir: project, overrides: { data_dir: path.join(root, 'data') } });
  const token = 'adversarial-token-1234567890';
  const bridge = await startHostBridge({ platform, host, token, maxBodyBytes: 2048 });
  return { root, platform, bridge, token, cleanup: async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('host bridge rejects oversized, malformed, and unauthenticated requests without writing events', async () => {
  const ctx = await setupBridge();
  try {
    const oversized = await fetch(`${ctx.bridge.url}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(4000) }),
    });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(`${ctx.bridge.url}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' }, body: '{bad',
    });
    assert.equal(malformed.status, 400);
    const unauth = await fetch(`${ctx.bridge.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    const eventDir = path.join(ctx.platform.config.data_dir, 'host-events');
    const files = await fs.readdir(eventDir);
    assert.deepEqual(files, []);
  } finally { await ctx.cleanup(); }
});

test('provided Host Bridge bearer token is never echoed by the CLI', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-token-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initialized = spawnSync(process.execPath, [CLI, 'init', root], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const secret = 'provided-secret-token-1234567890abcdef';
  const child = spawn(process.execPath, [CLI, 'host', 'serve', 'opencode', '--project', root, '--port', '0', '--token', secret], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host Bridge CLI did not start: ${stderr}`)), 5000);
    const inspect = () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        // Pretty-printed JSON may arrive in multiple chunks.
      }
    };
    child.stdout.on('data', inspect);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      try { inspect(); }
      catch { /* handled by the timeout or explicit close error */ }
      if (!stdout.trim()) { clearTimeout(timer); reject(new Error(`Host Bridge exited ${code}: ${stderr}`)); }
    });
  });
  assert.equal(started.token_source, 'provided');
  assert.equal('token' in started, false);
  assert.equal(stdout.includes(secret), false);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
});

test('OpenCode bridge identity cannot impersonate Pi or invoke human-gate commands', async () => {
  const ctx = await setupBridge('opencode');
  try {
    const started = await fetch(`${ctx.bridge.url}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'start', payload: { objective: 'Host identity boundary test' } }),
    });
    const startedBody = await started.json();
    assert.equal(started.status, 200);
    const runId = startedBody.result.run_id;

    const impersonation = await fetch(`${ctx.bridge.url}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'pi', command: 'abort', run_id: runId, payload: { reason: 'impersonated' } }),
    });
    assert.equal(impersonation.status, 403);

    const rawAbort = await fetch(`${ctx.bridge.url}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'abort', run_id: runId, payload: { reason: 'raw bypass' } }),
    });
    const rawBody = await rawAbort.json();
    assert.equal(rawAbort.status, 403);
    assert.match(rawBody.message, /not authorized/);

    const status = await ctx.platform.kernel.status(runId);
    assert.notEqual(status.status, 'aborted');
  } finally { await ctx.cleanup(); }
});

test('host bridge denies unmanaged mutation and external side effects', async () => {
  const ctx = await setupBridge();
  try {
    for (const [tool, extra, expected] of [
      ['write', { mutation: true }, 'deny'],
      ['bash', { mutation: true, arguments: { command: 'rm -rf /tmp/x' } }, 'deny'],
      ['deploy', { external_side_effect: true }, 'deny'],
    ]) {
      const response = await fetch(`${ctx.bridge.url}/v1/tool-policy`, {
        method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'custom', tool, arguments: {}, ...extra }),
      });
      const body = await response.json();
      assert.equal(body.decision.decision, expected, tool);
    }
  } finally { await ctx.cleanup(); }
});

test('OpenCode plugin fails closed during active runs when the policy bridge is unavailable', async () => {
  const bridge = {
    command: async () => ({ ok: true }), event: async () => ({ ok: true }),
    toolPolicy: async () => { throw new Error('network partition'); },
  };
  const plugin = createOpenCodeProofGraphPlugin({ bridge, runId: 'pg_000000000000000000000000', directory: '/repo', worktree: '/repo', toolFactory: (x) => x, schema: { object: (x) => x, string: () => ({ optional() { return this; } }), optional: (x) => x } });
  await assert.rejects(() => plugin.hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath: 'x' } }), /policy bridge unavailable/);
});

test('OpenCode model tool surface cannot self-approve or abort a ProofGraph run', () => {
  const plugin = createOpenCodeProofGraphPlugin({
    bridge: { command: async () => ({ ok: true }), event: async () => ({ ok: true }), toolPolicy: async () => ({ decision: { decision: 'allow' } }) },
    runId: 'pg_000000000000000000000000', directory: '/repo', worktree: '/repo', toolFactory: (value) => value,
    schema: { object: (value) => value, string: () => ({ optional() { return this; } }), optional: (value) => value },
  });
  assert.equal(plugin.hooks.tool.proofgraph_approve, undefined);
  assert.equal(plugin.hooks.tool.proofgraph_abort, undefined);
});

test('OpenCode worker execution is fail-closed until a dedicated pure server is attested', async () => {
  let calls = 0;
  const host = new OpenCodeExecutionHost({ enabled: true, client: { createSession: async () => { calls += 1; return { id: 'ses' }; } } });
  const request = {
    request_id: 'r', run_id: 'pg_000000000000000000000000',
    node: { node_id: 'direct', kind: 'direct', role: 'direct', metadata: {} }, objective: 'x', attempt: 1,
    workspace: { isolated: false }, prompt: '{}', metadata: {},
  };
  await assert.rejects(() => host.execute(request), /pure_worker_confirmed/);
  assert.equal(calls, 0);
});

test('OpenCode host rejects model identifiers without provider namespace before network execution', async () => {
  let calls = 0;
  const client = {
    createSession: async () => { calls += 1; return { id: 'ses' }; },
  };
  const host = new OpenCodeExecutionHost({ enabled: true, pureWorkerConfirmed: true, client, model: 'invalid-model' });
  const request = {
    request_id: 'r', run_id: 'pg_000000000000000000000000',
    node: { node_id: 'direct', kind: 'direct', role: 'direct', metadata: {} }, objective: 'x', attempt: 1,
    workspace: { isolated: false }, prompt: '{}', metadata: {},
  };
  await assert.rejects(() => host.execute(request), /provider\/model/);
  assert.equal(calls, 0);
});

test('OpenCode host aborts sessions when an agent returns malformed contract output', async () => {
  let aborted = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/session') return send(res, { id: 'ses_1' });
    if (req.url === '/session/ses_1/message') return send(res, { parts: [{ type: 'text', text: 'not-json' }] });
    if (req.url === '/session/ses_1/abort') { aborted = true; return send(res, true); }
    if (req.url === '/session/ses_1/diff') return send(res, []);
    return send(res, { healthy: true });
  });
  function send(res, body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const host = new OpenCodeExecutionHost({ enabled: true, pureWorkerConfirmed: true, baseUrl: `http://127.0.0.1:${address.port}`, requireIsolatedWorkspace: false });
    await assert.rejects(() => host.execute({
      request_id: 'r', run_id: 'pg_000000000000000000000000',
      node: { node_id: 'direct', kind: 'direct', role: 'direct', metadata: {} }, objective: 'x', attempt: 1,
      workspace: { isolated: false }, prompt: '{}', metadata: {},
    }), /No .*AgentResult JSON|parse/i);
    assert.equal(aborted, true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('OpenCode client rejects remote, credential-bearing, and unauthenticated endpoints by default', () => {
  assert.throws(() => new OpenCodeClient({ baseUrl: 'http://example.com:4096' }), /loopback/);
  assert.throws(() => new OpenCodeClient({ baseUrl: 'https://user:pass@example.com' }), /must not embed credentials/);
  assert.throws(() => new OpenCodeClient({ baseUrl: 'https://example.com', allowRemote: true }), /require HTTP basic authentication/);
});

test('OpenCode client enforces bounded JSON and SSE response buffers', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${'x'.repeat(5000)}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: 'x'.repeat(5000) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${port}`, maxResponseBytes: 1024 });
    await assert.rejects(() => client.health(), /exceeded 1024 bytes/);
    await assert.rejects(async () => { for await (const _event of client.events()) {} }, /SSE buffer exceeded 1024 bytes/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
