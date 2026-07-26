import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOperatorSnapshot } from '../../runtime/operator/render.mjs';
import { OperatorTUI } from '../../runtime/operator/tui.mjs';

const run = {
  run_id: 'mission_intelligence', run_type: 'mission', objective: 'Intelligence view', status: 'active', quality_gate_passed: false,
  progress: { completed: 1, total: 2, percent: 50 }, current_node_ids: [], next_node_ids: [], graph: { nodes: [], edges: [] },
  current_nodes: [], organization: { departments: [], teams: [], roles: [] }, loops: [], loop_summary: { total: 0, active: 0, current_iteration: 0 },
  failures: { historical: [], resolved: [], unresolved: [] }, approvals: { pending: [], decided: [] }, artifacts: { candidates: [], verified: [] },
  host: { name: 'OpenCode', status: 'connected' }, operator: { paused: false }, timeline: [],
  intelligence: {
    model_registry_version: 'test-1',
    contexts: { total: 1, bytes: 123, redactions: 1, stale_sources: 0, unknown_freshness_sources: 1, packets: [{ role_type: 'developer', work_item_id: 'w1', token_estimate: 31, byte_size: 123, sections: ['objective'], redaction_count: 1, stale_source_count: 0, unknown_freshness_source_count: 1 }] },
    routing: { total: 1, observation_total: 1, decisions: [{ work_item_id: 'w1', model_id: 'model/x', host: 'opencode', score: 9 }], model_summary: [{ model_id: 'model/x', observations: 1, successes: 1, failures: 0, success_rate: 1, average_latency_ms: 100 }] },
    collaboration: { pending: 1, completed: 0, blocked: 0, contracts: [{ status: 'acknowledged', type: 'implementation', subject: 'API', producer_role_id: 'planner', consumer_role_ids: ['developer'] }] },
    knowledge: { node_count: 3, edge_count: 2, actionable_impacts: 1, impacts: [{ target_external_id: 'src/auth.js', severity: 'high', depth: 1, action_required: true }] },
    memory: { recalled: [{ kind: 'lesson', status: 'verified', title: 'Bound retries' }], captured: [] },
    verification: [{ passed: true, scope: 'execution_bundle', work_item_id: 'w1', check_count: 6 }],
  },
};

test('Operator snapshot renders all Intelligence Fabric views', () => {
  const expected = { context: 'CONTEXT DELIVERY', models: 'MODEL ROUTING', collaboration: 'COLLABORATION', knowledge: 'KNOWLEDGE / IMPACT', memory: 'ORGANIZATION MEMORY', verification: 'INTELLIGENCE VERIFICATION' };
  for (const [view, heading] of Object.entries(expected)) assert.match(renderOperatorSnapshot({ runs: [run], view, width: 120, height: 32 }), new RegExp(heading.replace('/', '\\/')));
});

test('Operator TUI key map reaches each Intelligence Fabric view', async () => {
  const tui = new OperatorTUI({ client: {}, stdout: { columns: 120, rows: 32, isTTY: false, write() {} }, stdin: { isTTY: false } });
  tui.state.runs = [structuredClone(run)];
  const mapping = { e: 'context', m: 'models', b: 'collaboration', w: 'knowledge', y: 'memory', v: 'verification' };
  for (const [key, view] of Object.entries(mapping)) { await tui.act(key); assert.equal(tui.state.view, view); }
});
