import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createControlPlaneServer, ControlPlane } from '../../runtime/control-plane/index.mjs';
import { OperatorClient } from '../../runtime/operator/client.mjs';
import { PolicyError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

const OP = 'p'.repeat(48); const HOST = 'x'.repeat(48);
async function fixture(t) {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const cp = new ControlPlane({ dataDir: dir, operatorToken: OP, hostToken: HOST, tickDelayMs: 1 });
  const app = await createControlPlaneServer({ controlPlane: cp, port: 0, maxSseClients: 1 }); const address = await app.listen();
  t.after(() => app.close().catch(() => {}));
  return { dir, cp, app, url: `http://127.0.0.1:${address.port}`, client: new OperatorClient({ url: `http://127.0.0.1:${address.port}`, token: OP }) };
}

test('ADVERSARIAL: Control Plane refuses non-loopback binding', async () => {
  await assert.rejects(() => createControlPlaneServer({ host: '0.0.0.0', port: 0 }), PolicyError);
});

test('ADVERSARIAL: host ingest token cannot call operator actions', async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/v1/runs`, { headers: { authorization: `Bearer ${HOST}` } });
  assert.equal(response.status, 401);
});

test('ADVERSARIAL: operator token cannot impersonate host ingest', async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/v1/hosts/opencode/events`, { method: 'POST', headers: { 'x-proofgraph-host-token': OP, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
});

test('ADVERSARIAL: approval challenge never leaves the Control Plane', async (t) => {
  const { client } = await fixture(t);
  const created = await client.createRun({ objective: 'Deploy to production', signals: { risk: 'high', external_effects: true }, auto_start: true });
  let run;
  for (let i = 0; i < 100; i += 1) { run = await client.run(created.run_id); if (run.status === 'waiting_approval') break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(JSON.stringify(run).includes('challenge'), false);
});

test('ADVERSARIAL: traversal run identifier cannot escape the data directory', async (t) => {
  const { url, dir } = await fixture(t);
  const response = await fetch(`${url}/v1/runs/${encodeURIComponent('../etc/passwd')}`, { headers: { authorization: `Bearer ${OP}` } });
  assert.ok([400, 500].includes(response.status));
  assert.equal((await fs.readdir(dir)).includes('etc'), false);
});

test('ADVERSARIAL: oversized JSON request fails before runtime mutation', async (t) => {
  const { url, client } = await fixture(t);
  const body = JSON.stringify({ objective: 'x'.repeat(1_100_000) });
  const response = await fetch(`${url}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/json' }, body });
  assert.equal(response.status, 400);
  assert.equal((await client.runs()).length, 0);
});

test('ADVERSARIAL: malformed host event is rejected without corrupting registry', async (t) => {
  const { url, cp } = await fixture(t);
  const response = await fetch(`${url}/v1/hosts/opencode/events`, { method: 'POST', headers: { 'x-proofgraph-host-token': HOST, 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(response.status, 400);
  assert.equal((await cp.hosts.list()).length, 0);
});
