import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOperatorSnapshot } from '../../runtime/operator/render.mjs';
import { renderExecutionGraph } from '../../runtime/operator/graph-layout.mjs';

function sampleRun() {
  return {
    run_id: 'mission_demo', run_type: 'mission', status: 'waiting_approval', quality_gate_passed: false,
    progress: { percent: 60 }, host: { name: 'OpenCode', status: 'connected' }, updated_at: new Date().toISOString(),
    graph: {
      active_node_ids: ['verify'], next_node_ids: ['develop'],
      nodes: [
        { id: 'triage', label: 'Triage', kind: 'triage', status: 'completed', attempts: 1, max_attempts: 1, sequence: 1 },
        { id: 'develop', label: 'Develop', kind: 'develop', status: 'pending', attempts: 1, max_attempts: 3, sequence: 2 },
        { id: 'verify', label: 'Verify', kind: 'verify', status: 'failed', attempts: 1, max_attempts: 3, sequence: 3, failure: { type: 'implementation_error', message: 'test failed' } },
      ],
      edges: [
        { from: 'triage', to: 'develop', kind: 'dependency' },
        { from: 'develop', to: 'verify', kind: 'dependency' },
        { from: 'verify', to: 'develop', kind: 'retry', failure_type: 'implementation_error', iteration: 1, max_iterations: 2 },
      ],
    },
    organization: { departments: [{ department_id: 'eng', name: 'Engineering' }], teams: [], roles: [{ role_id: 'developer', department_id: 'eng', role_type: 'model' }] },
    loop_summary: { total: 1 }, failures: { unresolved: [{ type: 'implementation_error', work_item_id: 'verify', message: 'test failed' }] },
    approvals: { pending: [{ approval_id: 'approval_1', kind: 'mission-risk-gate', reason: 'production risk' }] }, timeline: [{ at: new Date().toISOString(), type: 'route.changed', data: { from: 'verify', to: 'develop', iteration: 1, max_iterations: 2 } }],
  };
}

test('operator snapshot shows graph, loop, approval, and host in one screen', () => {
  const output = renderOperatorSnapshot({ runs: [sampleRun()], width: 120, height: 36 });
  assert.match(output, /ProofGraph Operator/);
  assert.match(output, /OpenCode CONNECTED/);
  assert.match(output, /Verify/);
  assert.match(output, /↺ Verify → Develop/);
  assert.match(output, /APPROVAL QUEUE/);
  assert.equal(output.split('\n').length, 36);
});

test('operator renderer removes terminal escape injection', () => {
  const run = sampleRun(); run.failures.unresolved[0].message = '\u001b[2JOWNED';
  const output = renderOperatorSnapshot({ runs: [run], view: 'failures', width: 100, height: 30 });
  assert.equal(output.includes('\u001b'), false);
  assert.match(output, /OWNED/);
});

test('execution graph virtualizes one thousand nodes within bounded output', () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, label: `Node-${i}`, status: i < 995 ? 'completed' : 'pending', attempts: 1, max_attempts: 2, sequence: i }));
  const edges = Array.from({ length: 999 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'dependency' }));
  const start = performance.now();
  const lines = renderExecutionGraph({ nodes, edges, active_node_ids: ['n999'], next_node_ids: ['n995'] }, { width: 80, height: 24, maxVisibleNodes: 80 });
  assert.ok(performance.now() - start < 500);
  assert.ok(lines.length <= 24);
  assert.ok(lines.some((line) => /folded/.test(line)) || lines.length === 24);
});

test('operator snapshot supports artifact view and bounded search filter', () => {
  const run = sampleRun();
  run.artifacts = { verified: [{ artifact_id: 'artifact_1', name: 'auth-patch' }], candidates: [{ artifact_id: 'artifact_2', name: 'other-doc' }] };
  run.timeline.push({ at: new Date().toISOString(), type: 'custom.event', data: { detail: 'needle-value' } });
  const artifacts = renderOperatorSnapshot({ runs: [run], view: 'artifacts', query: 'auth', width: 110, height: 30 });
  assert.match(artifacts, /ARTIFACTS/); assert.match(artifacts, /auth-patch/); assert.doesNotMatch(artifacts, /other-doc/);
  const timeline = renderOperatorSnapshot({ runs: [run], view: 'timeline', query: 'needle', width: 110, height: 30 });
  assert.match(timeline, /custom.event/); assert.match(timeline, /\/needle/);
});
