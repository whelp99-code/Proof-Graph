import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPrompt, normalizeAgentManifest, normalizeAgentResult } from '../../runtime/contracts.mjs';

const manifest = normalizeAgentManifest({
  agent_id: 'proofgraph.test', adapter: 'mock', roles: ['developer'], capabilities: ['structured_output'],
});

test('agent manifest and result contracts normalize deterministic structured data', () => {
  const result = normalizeAgentResult({ outcome: 'success', summary: 'done', output: { value: 1 } });
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.output, { value: 1 });
  assert.throws(() => normalizeAgentResult({ outcome: 'failed', summary: 'bad' }), /must be an object/);
});

test('agent prompt embeds node contract and verified context', () => {
  const prompt = buildAgentPrompt({
    node: { node_id: 'develop', kind: 'develop', role: 'developer' },
    objective: 'Implement a deterministic feature', attempt: 1, tool_policy: ['proofgraph'], context: [{ node_id: 'plan', output: { plan: true } }],
  }, manifest);
  assert.match(prompt, /ProofGraph Agent Contract/);
  assert.match(prompt, /Implement a deterministic feature/);
  assert.match(prompt, /plan/);
});
