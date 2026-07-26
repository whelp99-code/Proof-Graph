import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneServer, ControlPlane } from '../../runtime/control-plane/index.mjs';
import { OperatorClient } from '../../runtime/operator/client.mjs';
import { ReferenceGraphKernelPort } from '../../runtime/company/index.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

const OP = 'o'.repeat(48); const HOST = 'h'.repeat(48);
async function fixture(t, options = {}) {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const controlPlane = new ControlPlane({ dataDir: dir, operatorToken: OP, hostToken: HOST, tickDelayMs: 1, ...options });
  const app = await createControlPlaneServer({ controlPlane, port: 0, pollMs: 10 }); const address = await app.listen();
  t.after(() => app.close().catch(() => {}));
  const url = `http://127.0.0.1:${address.port}`; const client = new OperatorClient({ url, token: OP });
  return { dir, app, controlPlane, url, client };
}
async function waitFor(client, id, predicate, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) { const run = await client.run(id); if (predicate(run)) return run; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('waitFor timeout');
}

test('Control Plane requires operator auth and exposes safe health', async (t) => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/health`)).status, 200);
  assert.equal((await fetch(`${url}/v1/runs`)).status, 401);
  assert.equal((await fetch(`${url}/v1/runs`, { headers: { authorization: `Bearer ${HOST}` } })).status, 401);
});

test('Control Plane creates, streams, and completes a mission', async (t) => {
  const { client } = await fixture(t);
  const created = await client.createRun({ objective: 'Implement and verify a bounded API feature', auto_start: true });
  const final = await waitFor(client, created.run_id, (run) => run.status.startsWith('completed'));
  assert.equal(final.status, 'completed_clean');
  assert.equal(final.quality_gate_passed, true);
  assert.ok(final.graph.nodes.some((node) => node.kind === 'verify'));
  const timeline = await client.timeline(final.run_id);
  assert.ok(timeline.some((event) => event.type === 'mission.terminal'));
});

test('Control Plane pause, resume, and SSE snapshot work without state-file editing', async (t) => {
  const { client } = await fixture(t);
  const created = await client.createRun({ objective: 'Implement a feature', auto_start: false });
  const paused = await client.pause(created.run_id, 'test pause');
  assert.equal(paused.status, 'paused');
  const controller = new AbortController();
  const frames = [];
  const reader = (async () => {
    for await (const frame of client.events({ runId: created.run_id, signal: controller.signal })) {
      frames.push(frame); if (frames.some((item) => item.event === 'run.updated')) { controller.abort(); break; }
    }
  })();
  await assert.rejects(reader, /abort/i).catch(() => {});
  assert.ok(frames.some((item) => item.event === 'run.updated'));
  await client.resume(created.run_id);
  const final = await waitFor(client, created.run_id, (run) => run.status.startsWith('completed'));
  assert.equal(final.quality_gate_passed, true);
});

test('Control Plane hides challenge and makes approval decision operator-only', async (t) => {
  const { client } = await fixture(t);
  const created = await client.createRun({ objective: 'Deploy a production database migration', signals: { risk: 'high', external_effects: true }, auto_start: true });
  const waiting = await waitFor(client, created.run_id, (run) => run.status === 'waiting_approval');
  const approval = waiting.approvals.pending[0];
  assert.ok(approval.approval_id);
  assert.equal('challenge' in approval, false);
  await client.decide(waiting.run_id, approval.approval_id, 'approved', 'test approval');
  const final = await waitFor(client, waiting.run_id, (run) => run.status.startsWith('completed'));
  assert.equal(final.quality_gate_passed, true);
});

test('Control Plane shows recovered loop as completed_with_recovery', async (t) => {
  const port = new ReferenceGraphKernelPort({ failurePlan: { verify: [{ type: 'implementation_error', retryable: true }] } });
  const { client } = await fixture(t, { graphPort: port });
  const created = await client.createRun({ objective: 'Implement with a regression test', auto_start: true });
  const final = await waitFor(client, created.run_id, (run) => run.status.startsWith('completed'));
  assert.equal(final.status, 'completed_with_recovery');
  assert.equal(final.failures.unresolved.length, 0);
  assert.equal(final.loop_summary.total, 1);
  assert.ok(final.graph.edges.some((edge) => edge.kind === 'retry'));
});

test('Control Plane idempotency key returns the original create result', async (t) => {
  const { url, client } = await fixture(t);
  const headers = { authorization: `Bearer ${OP}`, 'content-type': 'application/json', 'idempotency-key': 'command_same' };
  const body = JSON.stringify({ objective: 'Idempotent mission', auto_start: false });
  const first = await (await fetch(`${url}/v1/runs`, { method: 'POST', headers, body })).json();
  const second = await (await fetch(`${url}/v1/runs`, { method: 'POST', headers, body })).json();
  assert.equal(first.run.run_id, second.run.run_id);
  assert.equal((await client.runs()).length, 1);
});

test('Control Plane connects to OpenCode health/SSE and projects host session state', async (t) => {
  const http = await import('node:http');
  const fake = http.createServer((req, res) => {
    if (req.url === '/global/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ healthy: true, version: 'fake-1' })); return; }
    if (req.url === '/project/current') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'project_x' })); return; }
    if (req.url === '/global/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 'session_x', status: { type: 'busy' } } })}\n\n`); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const { client, controlPlane } = await fixture(t);
  const host = await client.connectOpenCode(`http://127.0.0.1:${fake.address().port}`);
  assert.equal(host.status, 'connected');
  let hosts;
  for (let i = 0; i < 50; i += 1) { hosts = await client.hosts(); if (hosts[0]?.sessions?.session_x) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(hosts[0].version, 'fake-1'); assert.equal(hosts[0].sessions.session_x.status, 'busy');
  await controlPlane.disconnectHost('opencode');
  fake.closeAllConnections?.();
  await new Promise((resolve) => fake.close(resolve));
});

test('Control Plane exposes OS projections, graph, integrity, pending approvals and abort', async (t) => {
  const { client, url } = await fixture(t);
  const created = await client.createRun({ type: 'organization_os', objective: 'Implement and verify a bounded service', max_cycles: 2, auto_start: true });
  const final = await waitFor(client, created.run_id, (run) => ['completed_clean', 'failed', 'denied'].includes(run.status), 400);
  assert.equal(final.run_type, 'organization_os');
  assert.ok(Array.isArray(final.cycles));
  const graph = await (await fetch(`${url}/v1/runs/${final.run_id}/graph`, { headers: { authorization: `Bearer ${OP}` } })).json();
  assert.ok(Array.isArray(graph.graph.cycles));
  const integrity = await (await fetch(`${url}/v1/runs/${final.run_id}/integrity`, { headers: { authorization: `Bearer ${OP}` } })).json();
  assert.equal(integrity.integrity.ok, true);

  const abortable = await client.createRun({ type: 'organization_os', objective: 'Plan a bounded service', auto_start: false });
  const aborted = await client.abort(abortable.run_id, 'operator test abort');
  assert.equal(aborted.status, 'aborted');
  assert.deepEqual(await client.approvals(), []);
});

test('Control Plane records explicit denial and failed idempotent commands', async (t) => {
  const { client, url } = await fixture(t);
  const created = await client.createRun({ objective: 'Delete production records permanently', signals: { risk: 'high', external_effects: true }, auto_start: true });
  const waiting = await waitFor(client, created.run_id, (run) => run.status === 'waiting_approval');
  const approval = waiting.approvals.pending[0];
  const denied = await client.decide(waiting.run_id, approval.approval_id, 'denied', 'deny test');
  assert.equal(denied.status, 'denied');
  assert.equal(denied.approvals.decided[0].status, 'denied');

  const headers = { authorization: `Bearer ${OP}`, 'content-type': 'application/json', 'idempotency-key': 'command_failed' };
  const first = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: '{}' });
  const second = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: '{}' });
  assert.equal(first.status, 400);
  assert.equal(second.status, 409);
});

test('Control Plane config, host disconnect and shutdown endpoints are operator authenticated', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const controlPlane = new ControlPlane({ dataDir: dir, operatorToken: OP, hostToken: HOST, tickDelayMs: 1 });
  const app = await createControlPlaneServer({ controlPlane, port: 0, pollMs: 10 });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${OP}`, 'content-type': 'application/json', 'idempotency-key': 'disconnect_host' };
  const config = await (await fetch(`${url}/v1/config`, { headers })).json();
  assert.equal(config.ok, true); assert.match(config.token_files.operator, /operator-api-token/);
  const disconnected = await (await fetch(`${url}/v1/hosts/opencode/disconnect`, { method: 'POST', headers, body: '{}' })).json();
  assert.equal(disconnected.host.status, 'disconnected');
  const shutdown = await fetch(`${url}/v1/shutdown`, { method: 'POST', headers, body: '{}' });
  assert.equal(shutdown.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(fetch(`${url}/v1/health`));
});
