import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMission } from '../../runtime/company/index.mjs';
import { ContextRuntime, ModelRouter, CollaborationRuntime, KnowledgeGraphRuntime, IntelligenceVerificationRuntime } from '../../runtime/intelligence/index.mjs';
import { IntegrityError, PolicyError } from '../../runtime/core/errors.mjs';
import { sha256 } from '../../runtime/core/canonical.mjs';

const registry = {
  schema: 'proofgraph.model-registry.v1', schema_version: 1, registry_version: 'locked', entries: [{
    model_id: 'safe/model-v1', provider: 'safe', host: 'safehost', enabled: true,
    capabilities: ['general', 'reasoning', 'verification', 'structured_output'], data_classifications: ['public', 'internal'],
    risk_ceiling: 'medium', max_context_tokens: 10000, quality: 1, reliability: 1, health: 1, latency_ms: 1,
    input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, tags: [],
  }],
};

test('ADVERSARIAL Intelligence Fabric fails closed on secrets, route escalation, contract forgery, and impact tampering', () => {
  const mission = compileMission({ objective: 'Verify a small feature' });
  const item = mission.work_items.find((candidate) => candidate.kind === 'verify');
  const context = new ContextRuntime();
  const packet = context.compile({ mission, workItem: item, memory: [{ memory_id: 'm1', kind: 'lesson', title: 'secret', content: { password: 'top-secret' }, confidence: 1, valid_at: new Date().toISOString() }] });
  assert.equal(JSON.stringify(packet).includes('top-secret'), false);
  const forgedPacket = structuredClone(packet); forgedPacket.sources[0].digest = '0'.repeat(64);
  assert.throws(() => context.verify(forgedPacket), IntegrityError);

  const router = new ModelRouter({ registry });
  assert.throws(() => router.route({ mission_id: 'm', work_item_id: 'w', kind: 'verify', risk: 'critical', classification: 'internal', context_tokens: 1 }), PolicyError);
  assert.throws(() => router.route({ mission_id: 'm', work_item_id: 'w', kind: 'verify', risk: 'low', classification: 'restricted', context_tokens: 1 }), PolicyError);

  const collaboration = new CollaborationRuntime();
  const contract = collaboration.create({ mission_id: 'm', work_item_id: 'w', producer_role_id: 'dev', consumer_role_ids: ['qa'], subject: 'independent review' });
  const forgedContract = structuredClone(contract); forgedContract.consumer_role_ids = ['dev'];
  assert.throws(() => collaboration.verify(forgedContract), IntegrityError);

  const knowledge = new KnowledgeGraphRuntime();
  let graph = knowledge.create({ mission_id: 'm' });
  graph = knowledge.update(graph, { nodes: [{ kind: 'file', external_id: 'src/auth.js', label: 'auth', criticality: 'high' }] });
  const forgedGraph = structuredClone(graph); forgedGraph.nodes.push(structuredClone(graph.nodes[0]));
  assert.throws(() => knowledge.verify(forgedGraph), IntegrityError);

  const verification = new IntelligenceVerificationRuntime({ contextRuntime: context, modelRouter: router, collaborationRuntime: collaboration, knowledgeGraphRuntime: knowledge });
  const actionable = { impact_id: 'impact_1', source_id: graph.nodes[0].node_id, target_id: graph.nodes[0].node_id, target_external_id: 'src/auth.js', target_kind: 'file', depth: 1, severity: 'critical', path: [graph.nodes[0].node_id], via_edge: 'none', action_required: true, source_work_item_id: 'w', source_phase: 'report' };
  actionable.digest = sha256(actionable);
  return verification.verifyTerminal({ state: { mission: { mission_id: 'm' }, intelligence: { knowledge_graph: graph, context_packets: [], route_decisions: [], contracts: [], impacts: [actionable], memory_recalled: [], verifications: [] }, revision: 1 } }).then((result) => {
    assert.equal(result.passed, false);
    assert.ok(result.blocking_failures.includes('critical_impacts_addressed'));
  });
});
