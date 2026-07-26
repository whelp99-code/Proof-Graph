import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanyRuntime, ReferenceGraphKernelPort, NativeAgentGraphPort } from '../../runtime/company/index.mjs';
import { OpenAICompatibleProvider } from '../../runtime/providers/index.mjs';
import { SandboxRuntime } from '../../runtime/tools/index.mjs';
import { WorkerRuntime } from '../../runtime/workers/index.mjs';
import { missionProjection } from '../../runtime/observability/index.mjs';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-v5-')); }

function response(content, model = 'local/test-model') {
  return new Response(JSON.stringify({ id: 'req_1', model, choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Truthfulness Gate marks Reference Kernel as simulation and blocks quality promotion', async () => {
  const previous = process.env.PROOFGRAPH_ALLOW_SIMULATION_PROMOTION;
  delete process.env.PROOFGRAPH_ALLOW_SIMULATION_PROMOTION;
  try {
    const runtime = new CompanyRuntime({ dataDir: await tmp(), graphPort: new ReferenceGraphKernelPort(), allowSimulationPromotion: false });
    const created = await runtime.create({ objective: 'Implement a real API', signals: { requires_implementation: true } });
    const state = await runtime.run(created.mission.mission_id);
    assert.equal(state.status, 'simulated');
    assert.equal(state.quality_gate_passed, false);
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.execution.real_execution, false);
    const view = missionProjection(state);
    assert.equal(view.status, 'simulation_complete');
    assert.equal(view.execution.mode, 'simulation');
  } finally { if (previous == null) delete process.env.PROOFGRAPH_ALLOW_SIMULATION_PROMOTION; else process.env.PROOFGRAPH_ALLOW_SIMULATION_PROMOTION = previous; }
});

test('OpenAI-compatible provider rejects insecure remote endpoint', () => {
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: 'http://example.com/v1', model: 'x' }), /HTTPS/);
});

test('Native Agent Port invokes real provider contract and records model evidence', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://127.0.0.1:1234/v1', model: 'local/test-model', local: true,
    fetchImpl: async () => response({ summary: 'planned', deliverables: [{ name: 'plan', media_type: 'text/plain', content: 'safe plan' }], evidence: [], verification: { passed: false, independent: false, findings: [] }, file_operations: [], commands: [] }),
  });
  const port = new NativeAgentGraphPort({ provider });
  const report = await port.execute({ request_id: 'r1', mission_id: 'm1', task: { objective: 'Plan feature', archetype: 'feature' }, organization: { organization_id: 'o1' }, work_item: { work_item_id: 'w1', stage_id: 'plan', kind: 'plan', assigned_role_id: 'planner' }, context_packet: {}, collaboration: {}, knowledge_impacts: [], memory_refs: [] });
  assert.equal(report.status, 'success');
  assert.equal(report.execution.mode, 'native_local');
  assert.equal(report.execution.real_model_invoked, true);
  assert.equal(report.execution.model_id, 'local/test-model');
  assert.equal(report.usage.tokens, 30);
  assert.equal((await port.verifyIntegrity(report)).ok, true);
});

test('Native verifier fails closed without independent evidence', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://127.0.0.1:1234/v1', model: 'local/test-model', local: true,
    fetchImpl: async () => response({ summary: 'looks fine', deliverables: [], evidence: [], verification: { passed: true, independent: true, findings: [] }, file_operations: [], commands: [] }),
  });
  const report = await new NativeAgentGraphPort({ provider }).execute({ request_id: 'r2', mission_id: 'm2', task: { objective: 'Verify', archetype: 'feature' }, organization: { organization_id: 'o2' }, work_item: { work_item_id: 'w2', stage_id: 'verify', kind: 'verify', assigned_role_id: 'verifier' }, context_packet: {}, collaboration: {}, knowledge_impacts: [], memory_refs: [] });
  assert.equal(report.status, 'failed');
  assert.equal(report.verification.passed, false);
});

test('SandboxRuntime blocks path escape and command outside allowlist, and captures test receipt', async () => {
  const sandbox = new SandboxRuntime({ allowedCommands: ['node'] });
  const workspace = await sandbox.createWorkspace();
  await assert.rejects(() => sandbox.writeFile(workspace, '../escape.txt', 'x'), /escape/);
  await assert.rejects(() => sandbox.run(workspace, 'bash', ['-lc', 'echo x']), /not allowed/);
  await sandbox.writeFile(workspace, 'test.mjs', "console.log('ok')\n");
  const receipt = await sandbox.run(workspace, 'node', ['test.mjs']);
  assert.equal(receipt.passed, true);
  assert.match(receipt.stdout, /ok/);
});

test('WorkerRuntime executes bounded concurrent contracts and rejects duplicate work', async () => {
  const workers = new WorkerRuntime({ concurrency: 2 });
  workers.submit({ id: 'a' }, async () => 'A');
  workers.submit({ id: 'b' }, async () => 'B');
  assert.throws(() => workers.submit({ id: 'a' }, async () => 'again'), /Duplicate/);
  assert.deepEqual((await workers.wait('a')).result, 'A');
  assert.deepEqual((await workers.wait('b')).result, 'B');
  assert.equal(workers.snapshot().active.length, 0);
});
