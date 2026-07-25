import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MockAdapter } from '../../runtime/adapters/mock.mjs';
import { AdapterRegistry } from '../../runtime/adapters/registry.mjs';
import { normalizePlatformConfig } from '../../runtime/config.mjs';
import { DebuggerController } from '../../runtime/debugger/controller.mjs';
import { ProofGraphKernel } from '../../runtime/kernel.mjs';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-debugger-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const config = normalizePlatformConfig({
    default_adapter: 'mock',
    routing: { direct: 'mock', researcher: 'mock', planner: 'mock', developer: 'mock', verifier: 'mock', synthesizer: 'mock' },
    data_dir: path.join(root, 'data'),
  }, { projectDir: project });
  const registry = new AdapterRegistry();
  const adapter = new MockAdapter({
    agent_id: 'proofgraph.mock', adapter: 'mock', roles: ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'], capabilities: ['structured_output'],
  });
  registry.register('mock', adapter);
  const debuggerController = new DebuggerController({ dataDir: config.data_dir });
  const kernel = new ProofGraphKernel({ config, registry, debuggerController });
  return { root, project, config, registry, adapter, debuggerController, kernel };
}

const input = {
  objective: 'Explain one deterministic invariant without research or implementation',
  signals: { complexity: 10, uncertainty: 10, risk: 'low', requires_research: false, requires_implementation: false, estimated_subtasks: 1 },
};

test('node-kind breakpoint pauses before adapter invocation and can be bypassed once', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const started = await env.kernel.start(input);
  await env.debuggerController.command(started.run_id, 'break', { type: 'kind', value: 'direct' });
  const paused = await env.kernel.resume(started.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(env.adapter.calls.length, 0);
  const nodeId = paused.status_snapshot.ready_nodes[0].node_id;
  await env.debuggerController.bypassBreakpointOnce(started.run_id, nodeId);
  const finished = await env.kernel.resume(started.run_id);
  assert.equal(finished.status, 'finalized');
  assert.equal(finished.integrity.ok, true);
});

test('step executes one node and pauses before the next ready node', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const started = await env.kernel.start(input);
  await env.debuggerController.command(started.run_id, 'step');
  const paused = await env.kernel.resume(started.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(env.adapter.calls.length, 1);
  assert.match(paused.debugger.pause_reason, /step/);
  await env.debuggerController.command(started.run_id, 'resume');
  const finished = await env.kernel.resume(started.run_id);
  assert.equal(finished.status, 'finalized');
});

test('operator pause is fail-closed and debugger state tampering is detected', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const started = await env.kernel.start(input);
  await env.debuggerController.command(started.run_id, 'pause', { reason: 'inspection' });
  const paused = await env.kernel.resume(started.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(env.adapter.calls.length, 0);
  const file = env.debuggerController.file(started.run_id);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.mode = 'running';
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => env.debuggerController.read(started.run_id), /digest mismatch/);
});
