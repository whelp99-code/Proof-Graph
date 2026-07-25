import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatform } from '../../runtime/platform.mjs';
import { startHostBridge } from '../../runtime/hosts/bridge-server.mjs';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-bridge-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  const platform = await createPlatform({ projectDir: project, overrides: { data_dir: path.join(root, 'data') } });
  const token = 'test-token-1234567890-abcdef';
  const bridge = await startHostBridge({ platform, host: 'opencode', token });
  return { root, project, platform, token, bridge, cleanup: async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

async function post(ctx, pathname, body, token = ctx.token) {
  const response = await fetch(`${ctx.bridge.url}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('host bridge exposes authenticated command, event, and policy surfaces', async () => {
  const ctx = await setup();
  try {
    const health = await fetch(`${ctx.bridge.url}/v1/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.host, 'opencode');

    const unauthorized = await post(ctx, '/v1/commands', { host: 'opencode', command: 'status', run_id: 'x', payload: {} }, 'wrong-token-123456789012345');
    assert.equal(unauthorized.status, 401);

    const started = await post(ctx, '/v1/commands', {
      host: 'opencode', command: 'start', payload: { objective: 'Implement a bounded host bridge test', template: 'feature' },
    });
    assert.equal(started.status, 200);
    const runId = started.body.result.run_id;
    assert.match(runId, /^pg_/);

    const status = await post(ctx, '/v1/commands', { host: 'opencode', command: 'status', run_id: runId, payload: {} });
    assert.equal(status.status, 200);
    assert.equal(status.body.result.run_id, runId);

    const readPolicy = await post(ctx, '/v1/tool-policy', { host: 'opencode', run_id: runId, tool: 'read', arguments: { filePath: 'README.md' } });
    assert.equal(readPolicy.body.decision.decision, 'allow');

    const writePolicy = await post(ctx, '/v1/tool-policy', { host: 'opencode', run_id: runId, tool: 'write', arguments: { filePath: 'x' }, mutation: true });
    assert.ok(['deny', 'require_approval'].includes(writePolicy.body.decision.decision));

    const event = await post(ctx, '/v1/events', { host: 'opencode', type: 'session.created', run_id: runId, session_id: 'ses_1', payload: { source: 'test' } });
    assert.equal(event.status, 202);
    const log = await fs.readFile(path.join(ctx.platform.config.data_dir, 'host-events', 'opencode.jsonl'), 'utf8');
    assert.match(log, /session.created/);
  } finally { await ctx.cleanup(); }
});

test('host bridge enforces optimistic revision and loopback binding', async () => {
  const ctx = await setup();
  try {
    const started = await post(ctx, '/v1/commands', { host: 'opencode', command: 'start', payload: { objective: 'Create a deterministic revision test' } });
    const runId = started.body.result.run_id;
    const stale = await post(ctx, '/v1/commands', { host: 'opencode', command: 'status', run_id: runId, expected_revision: 9999, payload: {} });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /Stale host command revision/);

    const mismatched = await post(ctx, '/v1/commands', { host: 'pi', command: 'status', run_id: runId, payload: {} });
    assert.equal(mismatched.status, 403);
    assert.match(mismatched.body.message, /Host identity mismatch/);

    const unauthorizedOperator = await post(ctx, '/v1/commands', {
      host: 'opencode', command: 'abort', run_id: runId, payload: { reason: 'raw bridge bypass' },
    });
    assert.equal(unauthorizedOperator.status, 403);
    assert.match(unauthorizedOperator.body.message, /not authorized for operator command/);
  } finally { await ctx.cleanup(); }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-bind-'));
  try {
    const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
    const platform = await createPlatform({ projectDir: project, overrides: { data_dir: path.join(root, 'data') } });
    await assert.rejects(() => startHostBridge({ platform, host: 'custom', bind: '0.0.0.0', token: 'token-12345678901234567890' }), /loopback/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
