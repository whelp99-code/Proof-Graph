import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlane, createControlPlaneServer } from '../../runtime/control-plane/index.mjs';
import { OperatorClient } from '../../runtime/operator/index.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

async function waitFor(client, runId, predicate, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const run = await client.run(runId); if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for run');
}

test('Control Plane exposes authenticated Intelligence Fabric projections and bounded detail', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const plane = new ControlPlane({ dataDir: dir, tickDelayMs: 1 });
  const server = await createControlPlaneServer({ controlPlane: plane, port: 0 });
  const address = await server.listen(); t.after(() => server.close());
  const token = await plane.operatorToken();
  const client = new OperatorClient({ url: `http://127.0.0.1:${address.port}`, token });
  const created = await client.createRun({ objective: 'Implement and verify a bounded API', auto_start: true });
  const completed = await waitFor(client, created.run_id, (run) => ['completed_clean', 'completed_with_recovery', 'partial', 'failed'].includes(run.status));
  assert.equal(completed.status, 'completed_clean');
  const summary = await client.intelligence(created.run_id);
  assert.equal(summary.fabric_version, '5.0.0');
  assert.ok((await client.contexts(created.run_id)).total > 0);
  assert.ok((await client.routes(created.run_id)).total > 0);
  const observations = await client.modelObservations(created.run_id);
  assert.ok(observations.total > 0); assert.ok(observations.model_summary.length > 0);
  assert.ok((await client.contracts(created.run_id)).contracts.length > 0);
  assert.ok((await client.knowledge(created.run_id)).node_count > 0);
  assert.ok(Array.isArray((await client.memory(created.run_id)).stored));
  assert.ok(Array.isArray(await client.verification(created.run_id)));
  const fullContexts = await client.contexts(created.run_id, { full: true });
  assert.ok(fullContexts[0].sections && typeof fullContexts[0].sections === 'object');
});
