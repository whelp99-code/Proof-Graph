import test from 'node:test';
import assert from 'node:assert/strict';
import { missionProjection, osProjection, intelligenceProjection } from '../../runtime/observability/projection.mjs';
import { renderOperatorSnapshot } from '../../runtime/operator/render.mjs';

function minimalState() {
  return {
    revision: 0,
    status: 'planned',
    mission: {
      mission_id: 'mission_sparse', objective: 'Sparse projection', organization: {},
      work_items: [
        { work_item_id: 'root', stage_id: 'root', kind: 'plan', assigned_role_id: 'planner', status: 'pending', join: 'any' },
        { work_item_id: 'all', stage_id: 'all', kind: 'develop', assigned_role_id: 'developer', status: 'pending', dependencies: ['root'], join: 'all' },
        { work_item_id: 'any', stage_id: 'any', kind: 'verify', assigned_role_id: 'verifier', status: 'pending', dependencies: ['root', 'missing'], join: 'any', approval_required: true },
      ],
    },
    approvals: [], route_history: [], failures: [], artifact_candidates: [], artifacts: [],
  };
}

function richIntelligence() {
  return {
    fabric_version: '5.0.0', model_registry_version: 'r1', model_registry_digest: 'rd', digest: 'fd',
    stats: { context_bytes: 10, context_redactions: 1, stale_context_sources: 1, unknown_freshness_sources: 1 },
    context_packets: [{ packet_id: 'p1', work_item_id: 'w', role_id: 'r', role_type: 'developer', classification: 'internal', byte_size: 10, token_estimate: 3, sources: [{}], stale_source_count: 1, unknown_freshness_source_count: 1, redactions: [{}], dropped_sections: ['secret'], sections: { objective: 'x' }, digest: 'pd' }],
    route_decisions: [{ route_id: 'r1', work_item_id: 'w', model_id: 'm1', provider: 'p', host: 'h', score: 1, estimated_cost_micros: 2, fallback_chain: ['m2'], reasons: ['capability'], digest: 'r1d' }],
    model_observations: [
      { observation_id: 'o1', route_id: 'r1', work_item_id: 'w', model_id: 'm1', provider: 'p', host: 'h', attempt: 1, status: 'completed', success: true, calls: 1, tokens: 5, cost_micros: 2, latency_ms: 10, observed_at: '2026-01-01T00:00:00Z', digest: 'o1d' },
      { observation_id: 'o2', route_id: 'r1', work_item_id: 'w', model_id: 'm1', provider: 'p', host: 'h', attempt: 2, status: 'failed', success: false, failure_type: 'timeout', calls: 1, tokens: 1, cost_micros: 1, latency_ms: 30, observed_at: '2026-01-02T00:00:00Z', digest: 'o2d' },
      { observation_id: 'o3', route_id: 'r2', work_item_id: 'w2', model_id: 'm2', provider: 'p2', host: 'h2', attempt: 1, status: 'failed', success: false, calls: 0, observed_at: null, digest: 'o3d' },
    ],
    contracts: [
      { contract_id: 'c1', work_item_id: 'w', type: 'implementation', status: 'proposed', subject: 'A', producer_role_id: 'p', consumer_role_ids: ['d'], digest: 'c1d' },
      { contract_id: 'c2', work_item_id: 'w2', type: 'review', status: 'blocked', subject: 'B', producer_role_id: 'd', consumer_role_ids: [], acknowledgements: [{}], evidence_refs: [{}], output_refs: [{}], digest: 'c2d' },
      { contract_id: 'c3', work_item_id: 'w3', type: 'result', status: 'completed', subject: 'C', producer_role_id: 'v', consumer_role_ids: ['s'], digest: 'c3d' },
    ],
    handoffs: [{ handoff_id: 'h1', contract_id: 'c1', context_packet_id: 'p1', route_id: 'r1', producer_role_id: 'p', consumer_role_ids: ['d'], digest: 'h1d' }],
    knowledge_graph: {
      graph_id: 'g', revision: 1, digest: 'gd',
      nodes: [{ node_id: 'n1', external_id: 'file:a', kind: 'file', label: 'a', criticality: 'high' }],
      edges: [{ edge_id: 'e1', from: 'n1', to: 'n1', kind: 'relates_to', severity: 'low' }],
    },
    impacts: [{ impact_id: 'i1', source_id: 'n1', target_id: 'n1', target_external_id: 'file:a', target_kind: 'file', severity: 'high', depth: 1, action_required: true, source_work_item_id: 'w', digest: 'i1d' }],
    memory_recalled: [{ memory_id: 'mem1', kind: 'lesson', title: 'x', status: 'verified', confidence: 1, retrieval_score: 2, sensitivity: 'internal', verified_by: 'v', valid_at: 'now', digest: 'md' }],
    memory_captured: [{ memory_id: 'mem2', title: 'captured' }],
    verifications: [
      { verification_id: 'v1', scope: 'execution_bundle', work_item_id: 'w', passed: true, checks: [{}], verified_at: 'now', digest: 'vd1' },
      { verification_id: 'v2', scope: 'terminal', passed: false, blocking_failures: ['x'], verified_at: 'now', digest: 'vd2' },
    ],
  };
}

test('observability projection covers sparse defaults, ready-node joins, loop defaults, and intelligence summaries', () => {
  const sparse = missionProjection(minimalState());
  assert.equal(sparse.run_id, 'mission_sparse');
  assert.deepEqual(sparse.next_node_ids, ['root']);
  assert.equal(sparse.host.name, 'reference');
  assert.equal(sparse.intelligence, null);

  const state = minimalState();
  state.status = 'active'; state.revision = 2; state.quality_gate_passed = false;
  state.mission.work_items[0].status = 'completed'; state.mission.work_items[0].attempts = 1;
  state.mission.work_items[1].status = 'running'; state.mission.work_items[1].attempts = 2; state.mission.work_items[1].failure = { type: 'implementation_error' };
  state.route_history = [
    { from: 'all', to: 'root', failure_type: 'design_error', at: '2026-01-01T00:00:00Z' },
    { from: 'all', to: 'root', failure_type: 'design_error', iteration: 3, max_iterations: 3, status: 'exhausted', exit_reason: 'limit', at: '2026-01-02T00:00:00Z' },
    { loop_id: 'other', from: 'any', to: 'root', failure_type: 'evidence_gap', iteration: 1, status: 'exited' },
  ];
  state.approvals = [{ approval_id: 'a1', status: 'pending', challenge: 'secret' }, { approval_id: 'a2', status: 'approved', challenge: 'secret2' }];
  state.intelligence = richIntelligence();
  const view = missionProjection(state, { host: { name: 'OpenCode', status: 'connected' }, timeline: [{ type: 'x' }] });
  assert.equal(view.current_node_ids[0], 'all');
  assert.ok(view.next_node_ids.includes('any'));
  assert.equal(view.loop_summary.exhausted, 1);
  assert.equal(view.approvals.pending[0].challenge, undefined);
  assert.equal(view.intelligence.routing.model_summary.find((m) => m.model_id === 'm1').success_rate, 0.5);
  assert.equal(view.intelligence.routing.model_summary.find((m) => m.model_id === 'm1').average_latency_ms, 20);
  assert.equal(view.intelligence.collaboration.pending, 1);
  assert.equal(view.intelligence.collaboration.blocked, 1);
  assert.equal(view.intelligence.collaboration.completed, 1);
  assert.equal(view.intelligence.knowledge.actionable_impacts, 1);
});

test('OS projection covers completed, denied, and active cycle branches', () => {
  const mission = missionProjection(minimalState());
  const completed = osProjection({ os_run_id: 'os1', revision: 1, status: 'completed', objective: 'x', quality_gate_passed: true, cycle: 1, max_cycles: 2, current_mission_id: null, council_records: [], improvement_proposals: [], approvals: [], failures: [], updated_at: null, integrity: null }, [mission]);
  assert.equal(completed.status, 'completed_clean'); assert.equal(completed.cycles.length, 1);
  const denied = osProjection({ os_run_id: 'os2', revision: 0, status: 'failed', objective: 'x', quality_gate_passed: false, cycle: 1, max_cycles: 1, current_mission_id: null, council_records: [], improvement_proposals: [], approvals: [{ status: 'denied', challenge: 'x' }], failures: [{}], updated_at: null, integrity: null }, []);
  assert.equal(denied.status, 'denied'); assert.equal(denied.approvals.decided[0].challenge, undefined);
  const active = osProjection({ os_run_id: 'os3', revision: 0, status: 'active', objective: 'x', quality_gate_passed: false, cycle: 0, max_cycles: 3, current_mission_id: null, council_records: [], improvement_proposals: [], approvals: [], failures: [], updated_at: null, integrity: null }, []);
  assert.equal(active.status, 'active');
});

test('renderer covers no-run, empty intelligence views, messages, failed observations, and filters', () => {
  const noRun = renderOperatorSnapshot({ runs: [], width: 90, height: 24, connected: false, message: 'offline' });
  assert.match(noRun, /NO RUN/); assert.match(noRun, /DISCONNECTED/);
  const projected = missionProjection({ ...minimalState(), intelligence: richIntelligence(), host: { name: 'Pi', status: 'disconnected' } });
  for (const view of ['context', 'models', 'collaboration', 'knowledge', 'memory', 'verification', 'org', 'cycles', 'timeline', 'failures', 'artifacts', 'graph']) {
    const screen = renderOperatorSnapshot({ runs: [projected], view, query: view === 'models' ? 'm1' : '', width: 100, height: 28, message: 'notice' });
    assert.equal(screen.split('\n').length, 28);
    assert.doesNotMatch(screen, /undefined/);
  }
  const empty = { ...projected, intelligence: { model_registry_version: 'empty', contexts: {}, routing: {}, collaboration: {}, knowledge: {}, memory: {}, verification: [] } };
  for (const view of ['context', 'models', 'collaboration', 'knowledge', 'memory', 'verification']) {
    const screen = renderOperatorSnapshot({ runs: [empty], view, width: 100, height: 28 });
    assert.match(screen, /No |reports=0|packets=0|decisions=0|pending=0|nodes=0/);
  }
});

test('intelligenceProjection returns null without state and maps all optional defaults', () => {
  assert.equal(intelligenceProjection({}), null);
  const value = intelligenceProjection({ intelligence: { fabric_version: '4', context_packets: [{}], route_decisions: [{}], model_observations: [{}], contracts: [{}], handoffs: [{}], knowledge_graph: {}, impacts: [{}], memory_recalled: [{}], memory_captured: [{}], verifications: [{}] } });
  assert.equal(value.contexts.total, 1); assert.equal(value.routing.observation_total, 1); assert.equal(value.knowledge.node_count, 0);
});
