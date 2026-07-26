import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../../runtime/core/canonical.mjs';
import { IntegrityError, PolicyError } from '../../runtime/core/errors.mjs';
import { CollaborationRuntime, KnowledgeGraphRuntime } from '../../runtime/intelligence/index.mjs';

const ref = (type, id, value) => ({ type, id, digest: sha256(value) });

test('Collaboration Runtime enforces typed contract lifecycle and evidence handoff', () => {
  const runtime = new CollaborationRuntime();
  const contract = runtime.create({
    mission_id: 'mission_1', work_item_id: 'work_verify', producer_role_id: 'developer', consumer_role_ids: ['verifier'],
    type: 'verification_request', subject: 'Verify authentication implementation', deliverables: ['verification verdict'],
    acceptance_criteria: ['tests pass'], evidence_requirements: ['test evidence'], input_refs: [ref('artifact', 'a1', { code: true })],
  });
  const acknowledged = runtime.transition(contract, { action: 'acknowledge', actor_role_id: 'verifier' });
  assert.equal(acknowledged.status, 'acknowledged');
  const handoff = runtime.handoff(acknowledged, { context_packet_id: 'ctx_123', route_id: 'route_123', producer_output_refs: acknowledged.input_refs });
  assert.equal(handoff.contract_id, contract.contract_id);
  const completed = runtime.transition(acknowledged, { action: 'complete', actor_role_id: 'verifier', evidence_refs: [ref('test', 't1', { passed: true })], output_refs: [ref('verdict', 'v1', { supported: true })] });
  assert.equal(completed.status, 'completed');
  assert.equal(runtime.verify(completed).ok, true);

  assert.throws(() => runtime.create({ mission_id: 'm', work_item_id: 'w', producer_role_id: 'same', consumer_role_ids: ['same'], subject: 'self contract' }), PolicyError);
  assert.throws(() => runtime.transition(contract, { action: 'complete', actor_role_id: 'developer', evidence_refs: [ref('x', 'x', {})], output_refs: [ref('y', 'y', {})] }), PolicyError);
  const tampered = structuredClone(completed); tampered.status = 'proposed';
  assert.throws(() => runtime.verify(tampered), IntegrityError);
});

test('Knowledge Graph performs bounded N-hop impact analysis with integrity', () => {
  const runtime = new KnowledgeGraphRuntime({ maxNodes: 20, maxEdges: 40, maxDepth: 4 });
  let graph = runtime.create({ mission_id: 'mission_kg' });
  graph = runtime.update(graph, { nodes: [
    { kind: 'api', external_id: 'auth-api', label: 'Auth API', criticality: 'high' },
    { kind: 'service', external_id: 'session-service', label: 'Session Service', criticality: 'high' },
    { kind: 'test', external_id: 'auth-regression', label: 'Auth regression', criticality: 'medium' },
  ] });
  const ids = Object.fromEntries(graph.nodes.map((item) => [item.external_id, item.node_id]));
  graph = runtime.update(graph, { edges: [
    { from: ids['auth-api'], to: ids['session-service'], kind: 'impacts', severity: 'high', source_ref: { type: 'design', id: 'd1' } },
    { from: ids['session-service'], to: ids['auth-regression'], kind: 'verifies', severity: 'medium', source_ref: { type: 'test-plan', id: 't1' } },
  ] });
  assert.equal(runtime.verify(graph).ok, true);
  const impacts = runtime.impact(graph, { source_ids: ['auth-api'], max_depth: 3 });
  assert.deepEqual(impacts.map((item) => item.target_external_id), ['session-service', 'auth-regression']);
  assert.equal(impacts[0].severity, 'high');
  const tampered = structuredClone(graph); tampered.nodes[0].label = 'Changed';
  assert.throws(() => runtime.verify(tampered), IntegrityError);
});
