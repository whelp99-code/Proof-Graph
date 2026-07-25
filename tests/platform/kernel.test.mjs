import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MockAdapter } from '../../runtime/adapters/mock.mjs';
import { AdapterRegistry } from '../../runtime/adapters/registry.mjs';
import { normalizePlatformConfig } from '../../runtime/config.mjs';
import { ProofGraphKernel } from '../../runtime/kernel.mjs';

async function setup(handler = undefined) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-kernel-'));
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
  }, { handler });
  registry.register('mock', adapter);
  return { root, project, config, registry, adapter, kernel: new ProofGraphKernel({ config, registry }) };
}

test('universal kernel executes a simple dynamic graph to verified completion', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const result = await env.kernel.run({
    objective: 'Explain one deterministic invariant without research or implementation',
    signals: { complexity: 10, uncertainty: 10, risk: 'low', requires_research: false, requires_implementation: false, estimated_subtasks: 1 },
  });
  assert.equal(result.status, 'finalized');
  assert.equal(result.report.report.quality_gate_passed, true);
  assert.equal(result.integrity.ok, true);
  assert.ok(env.adapter.calls.length >= 3);
});

test('adapter failures become typed graph failures instead of disappearing', async (t) => {
  const env = await setup(async (request) => {
    if (request.node.kind === 'direct') throw new Error('intentional adapter crash');
    return request.node.kind === 'verify'
      ? { outcome: 'success', summary: 'verify', output: { verification: { passed: true, checks: ['x'] } } }
      : { outcome: 'success', summary: 'ok', output: {} };
  });
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const result = await env.kernel.run({
    objective: 'Run a simple deterministic operation with failure visibility',
    signals: { complexity: 10, uncertainty: 10, risk: 'low', requires_research: false, requires_implementation: false, estimated_subtasks: 1 },
  });
  assert.equal(result.status, 'finalized');
  assert.equal(result.report.report.terminal_status, 'failed');
  assert.ok(result.report.report.failures.length >= 1);
});
