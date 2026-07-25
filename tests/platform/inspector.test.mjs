import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MockAdapter } from '../../runtime/adapters/mock.mjs';
import { AdapterRegistry } from '../../runtime/adapters/registry.mjs';
import { normalizePlatformConfig } from '../../runtime/config.mjs';
import { DebuggerController } from '../../runtime/debugger/controller.mjs';
import { inspectRun, renderInspection, startInspectorServer } from '../../runtime/debugger/inspector.mjs';
import { ProofGraphKernel } from '../../runtime/kernel.mjs';

async function completedRun() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-inspector-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const config = normalizePlatformConfig({
    default_adapter: 'mock',
    routing: { direct: 'mock', researcher: 'mock', planner: 'mock', developer: 'mock', verifier: 'mock', synthesizer: 'mock' },
    data_dir: path.join(root, 'data'),
  }, { projectDir: project });
  const registry = new AdapterRegistry();
  registry.register('mock', new MockAdapter({ agent_id: 'proofgraph.mock', adapter: 'mock', roles: ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'], capabilities: ['structured_output'] }));
  const debuggerController = new DebuggerController({ dataDir: config.data_dir });
  const kernel = new ProofGraphKernel({ config, registry, debuggerController });
  const result = await kernel.run({ objective: 'Inspect a deterministic graph', signals: { complexity: 10, uncertainty: 10, risk: 'low', requires_research: false, requires_implementation: false, estimated_subtasks: 1 } });
  return { root, project, config, debuggerController, kernel, runId: result.run_id };
}

test('inspector reconstructs nodes, edges, failures, events, and integrity', async (t) => {
  const env = await completedRun();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const result = await inspectRun({ dataDir: env.config.data_dir, projectDir: env.project, runId: env.runId, debuggerController: env.debuggerController });
  assert.equal(result.status, 'finalized');
  assert.equal(result.integrity.ok, true);
  assert.ok(result.event_count > 0);
  assert.match(result.dot, /digraph ProofGraph/);
  assert.match(result.dot, /->/);
  assert.match(renderInspection(result), /Integrity: PASS/);
});

test('HTTP inspector is token protected and loopback-bound by default', async (t) => {
  const env = await completedRun();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const inspect = () => inspectRun({ dataDir: env.config.data_dir, projectDir: env.project, runId: env.runId, debuggerController: env.debuggerController });
  const started = await startInspectorServer({ inspect, port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));
  const base = `http://${started.host}:${started.port}`;
  assert.equal((await fetch(`${base}/api/run`)).status, 401);
  const authorized = await fetch(`${base}/api/run`, { headers: { authorization: `Bearer ${started.token}` } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).run_id, env.runId);
  const dot = await fetch(`${base}/graph.dot?token=${started.token}`);
  assert.equal(dot.status, 200);
  assert.match(await dot.text(), /digraph ProofGraph/);
  await assert.rejects(() => startInspectorServer({ host: '0.0.0.0', inspect, port: 0 }), /loopback/);
});
