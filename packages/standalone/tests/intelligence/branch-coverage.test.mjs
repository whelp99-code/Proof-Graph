import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMission } from '../../runtime/company/index.mjs';
import {
  CollaborationRuntime,
  ContextRuntime,
  IntelligenceVerificationRuntime,
  KnowledgeGraphRuntime,
  ModelRouter,
  OrganizationMemoryRuntime,
} from '../../runtime/intelligence/index.mjs';
import { cloneJson, sha256 } from '../../runtime/core/canonical.mjs';
import { BudgetError, ConflictError, IntegrityError, PolicyError, ValidationError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

function routingRegistry() {
  const all = ['general', 'reasoning', 'planning', 'research', 'coding', 'verification', 'structured_output'];
  return {
    schema: 'proofgraph.model-registry.v1', schema_version: 1, registry_version: 'coverage-registry', entries: [
      { model_id: 'preferred/model', provider: 'p', host: 'preferred', enabled: true, capabilities: all, data_classifications: ['public', 'internal', 'confidential', 'restricted'], risk_ceiling: 'critical', max_context_tokens: 100000, quality: 0.8, reliability: 0.8, health: 1, latency_ms: 100, input_cost_micros_per_million: 2, output_cost_micros_per_million: 3, tags: ['preferred'] },
      { model_id: 'fallback/model', provider: 'p', host: 'fallback', enabled: true, capabilities: all, data_classifications: ['public', 'internal', 'confidential', 'restricted'], risk_ceiling: 'critical', max_context_tokens: 100000, quality: 0.9, reliability: 0.9, health: 1, latency_ms: 200, input_cost_micros_per_million: 1, output_cost_micros_per_million: 1, tags: [] },
      { model_id: 'rejected/model', provider: 'r', host: 'rejected', enabled: false, capabilities: ['general'], data_classifications: ['public'], risk_ceiling: 'low', max_context_tokens: 1000, quality: 0.1, reliability: 0.1, health: 0.1, latency_ms: 5000, input_cost_micros_per_million: 999999, output_cost_micros_per_million: 999999, tags: [] },
    ],
  };
}

const evidenceRef = (id = 'e1') => ({ type: 'report', id, digest: sha256({ id }) });

function resign(value) { const copy = cloneJson(value); delete copy.digest; copy.digest = sha256(copy); return copy; }

test('Model Router covers eligibility rejection reasons, failure observations, and explicit observed registry copies', () => {
  const router = new ModelRouter({ registry: routingRegistry() });
  const route = router.route({ mission_id: 'm', work_item_id: 'w', kind: 'verify', risk: 'high', classification: 'confidential', context_tokens: 2000, expected_output_tokens: 100, verification_strength: 'deep', preferred_hosts: ['preferred'], preferred_tags: ['preferred'] });
  assert.equal(route.model_id, 'preferred/model');
  const rejected = route.rejected.find((item) => item.model_id === 'rejected/model');
  assert.ok(rejected.rejection_reasons.includes('disabled'));
  assert.ok(rejected.rejection_reasons.includes('unhealthy'));
  assert.ok(rejected.rejection_reasons.includes('classification_not_allowed'));
  assert.ok(rejected.rejection_reasons.includes('risk_ceiling'));
  assert.ok(rejected.rejection_reasons.includes('context_limit'));
  assert.ok(rejected.rejection_reasons.some((item) => item.startsWith('missing:')));

  const failed = router.observe({ routeDecision: route, attempt: 2, report: { run_id: 'r', status: 'failed', failure: { type: 'timeout' }, usage: { calls: 2, tokens: 10, cost_micros: 3, wall_time_ms: 1500 }, integrity: { report_digest: sha256('r') } } });
  assert.equal(failed.success, false); assert.equal(failed.failure_type, 'timeout');
  const summary = router.summarizeObservations([failed]);
  assert.equal(summary[0].failures, 1); assert.equal(summary[0].p95_latency_ms, 1500);
  const observedRouter = router.withObservations([{ model_id: 'preferred/model', health: 0.7, reliability: 0.6, latency_ms: 777 }]);
  assert.equal(observedRouter.registry.entries.find((item) => item.model_id === 'preferred/model').latency_ms, 777);

  assert.throws(() => router.route({ mission_id: 'm', work_item_id: 'cost', kind: 'verify', risk: 'high', classification: 'confidential', context_tokens: 2000, max_cost_micros: 0 }), PolicyError);
  assert.throws(() => router.route({ mission_id: 'm', work_item_id: 'host', kind: 'verify', risk: 'high', classification: 'confidential', context_tokens: 2000, allowed_hosts: ['none'] }), PolicyError);
  assert.throws(() => router.route({ mission_id: 'm', work_item_id: 'model', kind: 'verify', risk: 'high', classification: 'confidential', context_tokens: 2000, allowed_models: ['none/model'] }), PolicyError);

  const inconsistent = resign({ ...failed, success: true });
  assert.throws(() => router.verifyObservation(inconsistent), IntegrityError);
  const badDate = resign({ ...failed, observed_at: 'not-a-date' });
  assert.throws(() => router.verifyObservation(badDate), IntegrityError);
});

test('Collaboration Runtime covers partial acknowledgement, rejection, blocking, cancellation, and impact follow-ups', () => {
  const runtime = new CollaborationRuntime();
  const base = { mission_id: 'm', work_item_id: 'w', producer_role_id: 'producer', consumer_role_ids: ['qa1', 'qa2'], type: 'implementation_change', subject: 'Review a change', deliverables: ['verdict'], evidence_requirements: ['tests'] };
  const contract = runtime.create(base);
  const partial = runtime.transition(contract, { action: 'acknowledge', actor_role_id: 'qa1' });
  assert.equal(partial.status, 'proposed');
  const duplicate = runtime.transition(partial, { action: 'acknowledge', actor_role_id: 'qa1' });
  assert.equal(duplicate.acknowledgements.length, 1);
  const acknowledged = runtime.transition(duplicate, { action: 'acknowledge', actor_role_id: 'qa2' });
  assert.equal(acknowledged.status, 'acknowledged');
  assert.throws(() => runtime.transition(contract, { action: 'unknown', actor_role_id: 'qa1' }), ValidationError);
  assert.throws(() => runtime.transition(contract, { action: 'acknowledge', actor_role_id: 'outsider' }), PolicyError);
  assert.throws(() => runtime.transition(acknowledged, { action: 'complete', actor_role_id: 'qa1' }), PolicyError);
  assert.throws(() => runtime.transition(acknowledged, { action: 'complete', actor_role_id: 'qa1', evidence_refs: [evidenceRef()] }), PolicyError);
  const completed = runtime.transition(acknowledged, { action: 'complete', actor_role_id: 'qa1', evidence_refs: [evidenceRef()], output_refs: [evidenceRef('out')] });
  assert.throws(() => runtime.transition(completed, { action: 'acknowledge', actor_role_id: 'qa2' }), ConflictError);
  assert.throws(() => runtime.handoff(completed, { context_packet_id: 'ctx', route_id: 'route' }), ConflictError);

  const rejected = runtime.transition(runtime.create({ ...base, work_item_id: 'reject' }), { action: 'reject', actor_role_id: 'qa1', reason: 'bad' });
  assert.equal(rejected.status, 'rejected');
  const blocked = runtime.transition(runtime.create({ ...base, work_item_id: 'block' }), { action: 'block', actor_role_id: 'qa1' });
  assert.equal(blocked.status, 'blocked');
  const cancelBase = runtime.create({ ...base, work_item_id: 'cancel' });
  assert.throws(() => runtime.transition(cancelBase, { action: 'cancel', actor_role_id: 'qa1' }), PolicyError);
  assert.equal(runtime.transition(cancelBase, { action: 'cancel', actor_role_id: 'producer' }).status, 'cancelled');

  const impacts = [
    { impact_id: 'i1', target_id: 'file1', target_kind: 'file', severity: 'medium', path: ['a', 'b'], digest: sha256('i1') },
    { impact_id: 'i2', target_id: 'decision1', target_kind: 'decision', severity: 'critical', path: ['a', 'c'], digest: sha256('i2') },
    { impact_id: 'i3', target_id: 'none', target_kind: 'decision', severity: 'low', path: [], digest: sha256('i3') },
  ];
  const followups = runtime.impactFollowUps({ mission_id: 'm', producer_role_id: 'developer', work_item_id: 'w', impacts, roleMap: { verifier: 'verifier', risk: 'risk' } });
  assert.equal(followups.length, 2);
  assert.ok(followups.some((item) => item.consumer_role_ids.includes('risk')));
  assert.equal(runtime.impactFollowUps({ mission_id: 'm', producer_role_id: 'verifier', work_item_id: 'w', impacts: [impacts[0]], roleMap: { verifier: 'verifier' } }).length, 0);
});

test('Knowledge Graph ingests rich report entities, artifacts, relations, and enforces update bounds', () => {
  const mission = compileMission({ objective: 'Implement and verify an authentication API' });
  const workItem = mission.work_items.find((item) => item.kind === 'develop');
  const runtime = new KnowledgeGraphRuntime({ maxNodes: 200, maxEdges: 500, maxDepth: 3 });
  let graph = runtime.ingestMission(runtime.create({ mission_id: mission.mission_id }), mission);
  const artifact = { artifact_id: 'artifact_1', name: 'auth patch', media_type: 'text/plain', digest: sha256('patch') };
  const report = {
    run_id: 'run_rich', integrity: { report_digest: sha256('rich') },
    output: {
      entities: [null, { kind: 'service', id: 'auth-service', label: 'Auth Service', criticality: 'high', attributes: { owner: 'backend' } }],
      changed_files: ['src/auth.js', { path: 'src/token.js', name: 'Token file', criticality: 'high' }],
      apis: [{ id: '/auth/login', label: 'Login API' }], services: ['session-service'], tests: [{ name: 'auth-regression' }],
      relations: [null, { from_kind: 'file', from: 'src/auth.js', to_kind: 'api', to: '/auth/login', kind: 'impacts', severity: 'high', attributes: { reason: 'handler' } }],
    },
  };
  graph = runtime.ingestReport(graph, { mission, workItem, report, artifacts: [artifact] });
  assert.equal(runtime.verify(graph).ok, true);
  assert.ok(graph.nodes.some((item) => item.external_id === '/auth/login'));
  assert.ok(graph.edges.some((item) => item.kind === 'impacts'));
  const revision = graph.revision;
  graph = runtime.ingestReport(graph, { mission, workItem, report, artifacts: [artifact] });
  assert.ok(graph.revision > revision);
  assert.equal(runtime.impact(graph, { source_ids: ['src/auth.js'], max_depth: 2, include_edge_kinds: [] }).length, 0);
  assert.throws(() => runtime.update(graph, { edges: [{ from: graph.nodes[0].node_id, to: graph.nodes[0].node_id, kind: 'impacts' }] }), ValidationError);
  assert.throws(() => runtime.update(graph, { edges: [{ from: graph.nodes[0].node_id, to: 'missing', kind: 'impacts' }] }), ValidationError);
  const bounded = new KnowledgeGraphRuntime({ maxNodes: 1 });
  assert.throws(() => bounded.update(bounded.create({ mission_id: 'small' }), { nodes: [{ kind: 'file', external_id: 'a' }, { kind: 'file', external_id: 'b' }] }), BudgetError);
});

test('Organization Memory covers duplicate, reject, supersede, expiry, sensitivity, and entry bounds', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const memory = new OrganizationMemoryRuntime({ dataDir: dir, maxEntries: 10 });
  const proposed = await memory.remember({ kind: 'decision', title: 'Use bounded retries', content: { decision: 'three attempts' }, role_id: 'planner', tags: ['retry'], metadata: { role_type: 'planner' } });
  const duplicate = await memory.remember({ kind: 'decision', title: 'Use bounded retries', content: { decision: 'three attempts' }, role_id: 'planner', tags: ['retry'], metadata: { role_type: 'planner' } });
  assert.equal(duplicate.memory_id, proposed.memory_id);
  assert.equal((await memory.retrieve({ query: '', include_proposed: true })).length, 1);
  const rejected = await memory.reject(proposed.memory_id, { actor_role_id: 'verifier', reason: 'superseded by policy' });
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(() => memory.promote(proposed.memory_id, { verifier_role_id: 'verifier', evidence_refs: [evidenceRef()] }), ConflictError);
  await assert.rejects(() => memory.reject('missing', { actor_role_id: 'v', reason: 'none' }), ValidationError);

  const base = await memory.remember({ kind: 'lesson', title: 'Old lesson', content: { lesson: 'old' }, role_id: 'developer' });
  const replacement = await memory.supersede(base.memory_id, { kind: 'lesson', title: 'New lesson', content: { lesson: 'new' }, role_id: 'developer' });
  assert.ok(replacement.derived_from.includes(base.memory_id));
  const stored = await memory.ensure();
  assert.equal(stored.entries.find((item) => item.memory_id === base.memory_id).status, 'superseded');

  await memory.remember({ kind: 'verification', title: 'Expired verification', content: { passed: true }, status: 'verified', verified_by: 'qa', source_refs: [evidenceRef('expired')], expires_at: '2000-01-01T00:00:00.000Z' });
  await memory.remember({ kind: 'verification', title: 'Restricted verification', content: { passed: true }, status: 'verified', verified_by: 'qa', source_refs: [evidenceRef('restricted')], sensitivity: 'restricted' });
  assert.equal((await memory.retrieve({ query: 'verification', classification: 'internal' })).length, 0);
  assert.throws(() => memory.createEntry({ kind: 'verification', title: 'Missing provenance', content: {}, status: 'verified', verified_by: 'qa' }), PolicyError);

  const tinyDir = await tempDir(); t.after(() => cleanup(tinyDir));
  const tiny = new OrganizationMemoryRuntime({ dataDir: tinyDir, maxEntries: 1 });
  await tiny.remember({ kind: 'lesson', title: 'First lesson', content: { value: 1 } });
  await assert.rejects(() => tiny.remember({ kind: 'lesson', title: 'Second lesson', content: { value: 2 } }), PolicyError);
});

test('Intelligence Verification reports all externally relevant failure branches and rejects bad reports', async () => {
  const mission = compileMission({ objective: 'Verify a small bounded feature' });
  const item = mission.work_items.find((candidate) => candidate.kind === 'verify');
  const context = new ContextRuntime();
  const router = new ModelRouter({ registry: routingRegistry() });
  const collaboration = new CollaborationRuntime();
  const knowledge = new KnowledgeGraphRuntime();
  const verification = new IntelligenceVerificationRuntime({ contextRuntime: context, modelRouter: router, collaborationRuntime: collaboration, knowledgeGraphRuntime: knowledge });
  const packet = context.compile({ mission, workItem: item });
  const route = router.route({ mission_id: mission.mission_id, work_item_id: item.work_item_id, kind: 'verify', risk: 'low', classification: 'internal', context_tokens: packet.token_estimate });
  const contract = collaboration.create({ mission_id: mission.mission_id, work_item_id: item.work_item_id, producer_role_id: 'producer', consumer_role_ids: [item.assigned_role_id], subject: 'verification input' });
  const handoff = collaboration.handoff(contract, { context_packet_id: packet.packet_id, route_id: route.route_id });
  const brokenPacket = structuredClone(packet); brokenPacket.sections.objective = 'tampered';
  const brokenRoute = structuredClone(route); brokenRoute.model_id = 'unknown/model';
  const brokenContract = structuredClone(contract); brokenContract.status = 'completed';
  const bundle = { mission_id: mission.mission_id, work_item_id: 'wrong', context_packet: brokenPacket, route_decision: { ...brokenRoute, context_tokens: route.context_tokens + 1 }, contracts: [brokenContract], handoffs: [{ ...handoff, context_packet_id: 'wrong', route_id: 'wrong' }] };
  const execution = verification.verifyExecutionBundle(bundle);
  assert.equal(execution.passed, false);
  assert.ok(execution.blocking_failures.includes('context_integrity'));
  assert.ok(execution.blocking_failures.includes('route_integrity'));
  assert.ok(execution.blocking_failures.includes('route_context_binding'));
  assert.ok(execution.blocking_failures.includes('work_item_binding'));

  const absent = await verification.verifyTerminal({ state: { mission, revision: 1 } });
  assert.equal(absent.passed, false);
  let graph = knowledge.create({ mission_id: mission.mission_id });
  graph = knowledge.update(graph, { nodes: [{ kind: 'file', external_id: 'src/a.js' }] });
  const badGraph = structuredClone(graph); badGraph.nodes[0].label = 'tampered';
  const impact = { impact_id: 'impact_x', target_id: graph.nodes[0].node_id, severity: 'critical', action_required: true, digest: 'bad' };
  const terminal = await verification.verifyTerminal({ state: { mission, revision: 2, intelligence: { knowledge_graph: badGraph, context_packets: [brokenPacket], route_decisions: [brokenRoute], contracts: [contract], impacts: [impact], memory_recalled: [{ memory_id: 'mem', status: 'proposed' }], verifications: [{ verification_id: 'failed_bundle', scope: 'execution_bundle', passed: false }] } } });
  assert.equal(terminal.passed, false);
  for (const name of ['knowledge_integrity', `context:${brokenPacket.packet_id}`, `route:${brokenRoute.route_id}`, 'impact_integrity', 'collaboration_contracts_closed', 'critical_impacts_addressed', 'recalled_memory_verified', 'execution_bundles_verified']) assert.ok(terminal.blocking_failures.includes(name));
  assert.throws(() => verification.verifyReport({}), ValidationError);
  const tamperedReport = structuredClone(execution); tamperedReport.passed = true;
  assert.throws(() => verification.verifyReport(tamperedReport), IntegrityError);
});
