import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDynamicGraph, assessObjective } from '../../server/lib/graph-compiler.mjs';
import { validateGraphSpec } from '../../server/lib/graph-spec.mjs';

function minimalGraph(overrides = {}) {
  return {
    schema_version: 1,
    graph_id: 'graph_test',
    name: 'Minimal verified graph',
    objective: 'Execute one task and verify the result before completion.',
    entry_node: 'work',
    nodes: [
      { node_id: 'work', title: 'Do work', kind: 'direct', role: 'direct', tool_policy: ['proofgraph'] },
      { node_id: 'verify', title: 'Verify work', kind: 'verify', role: 'verifier', tool_policy: ['proofgraph'] },
      { node_id: 'done', title: 'Done', kind: 'terminal', role: 'system', terminal_status: 'success', tool_policy: ['proofgraph'] },
    ],
    edges: [
      { edge_id: 'e-work-verify', from: 'work', to: 'verify', condition: { type: 'outcome', value: 'success' } },
      { edge_id: 'e-verify-done', from: 'verify', to: 'done', condition: { type: 'verification', value: 'passed' } },
    ],
    ...overrides,
  };
}

test('dynamic compiler is deterministic for identical normalized inputs', () => {
  const input = {
    objective: 'Research and design a verified multi-agent workflow implementation.',
    mode: 'build',
    signals: { complexity: 80, uncertainty: 70, risk: 'medium', requires_research: true, requires_implementation: true, estimated_subtasks: 6 },
  };
  const first = compileDynamicGraph(input);
  const second = compileDynamicGraph(input);
  assert.equal(first.graph_digest, second.graph_digest);
  assert.deepEqual(first.graph, second.graph);
});

test('simple low-risk objective compiles to direct route with verification', () => {
  const compiled = compileDynamicGraph({
    objective: 'Summarize one short local note accurately.',
    signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
  });
  assert.equal(compiled.assessment.recommendation.initial_route, 'direct');
  assert.ok(compiled.graph.nodes.some((node) => node.kind === 'verify'));
  assert.ok(compiled.graph.edges.some((edge) => edge.from === 'direct' && edge.to === 'verify'));
});

test('complex uncertain objective compiles bounded parallel research', () => {
  const compiled = compileDynamicGraph({
    objective: 'Deep research and implement a distributed graph workflow with independent validation.',
    mode: 'build',
    signals: { complexity: 90, uncertainty: 85, risk: 'medium', requires_research: true, requires_implementation: true, estimated_subtasks: 9 },
    constraints: { max_parallel_nodes: 4, max_iterations: 3 },
  });
  const research = compiled.graph.nodes.filter((node) => node.kind === 'research');
  assert.equal(compiled.assessment.recommendation.initial_route, 'research');
  assert.ok(research.length >= 2 && research.length <= 4);
  assert.equal(compiled.graph.limits.max_parallel_nodes, 4);
  assert.equal(compiled.graph.limits.max_iterations, 3);
});

test('compiler profile gives research shards domain titles and carries implementation contracts', () => {
  const compiled = compileDynamicGraph({
    objective: 'Develop a keyboard-first AI agent terminal interface with independent verification.',
    mode: 'build',
    signals: { complexity: 80, uncertainty: 60, risk: 'medium', requires_research: true, requires_implementation: true },
    constraints: { max_parallel_nodes: 3 },
    profile: {
      template_name: 'agent-tui',
      research_workstreams: ['Terminal UX', 'Runtime integration', 'Safety controls'],
      implementation_workstreams: ['State reducer', 'Renderer', 'Command controller'],
      deliverables: ['Runnable TUI'],
      acceptance_tests: ['Snapshot mode works without a TTY'],
      non_goals: ['Unrestricted shell execution'],
    },
  });
  assert.deepEqual(
    compiled.graph.nodes.filter((node) => node.kind === 'research').map((node) => node.title),
    ['Terminal UX', 'Runtime integration', 'Safety controls'],
  );
  const plan = compiled.graph.nodes.find((node) => node.node_id === 'plan');
  assert.deepEqual(plan.metadata.implementation_workstreams, ['State reducer', 'Renderer', 'Command controller']);
  assert.equal(compiled.graph.metadata.profile.template_name, 'agent-tui');
});

test('high-risk objective compiles a mandatory human approval gate', () => {
  const compiled = compileDynamicGraph({
    objective: 'Deploy a production database migration after verification.',
    mode: 'build',
    signals: { complexity: 70, uncertainty: 40, risk: 'high', requires_implementation: true, external_side_effects: true },
  });
  assert.equal(compiled.assessment.recommendation.initial_route, 'human');
  const gate = compiled.graph.nodes.find((node) => node.kind === 'human_approval');
  assert.ok(gate);
  assert.equal(gate.approval_required, true);
  assert.ok(compiled.graph.edges.some((edge) => edge.from === 'triage' && edge.to === gate.node_id));
});

test('assessment routes compliance-sensitive work to human review', () => {
  const result = assessObjective({
    objective: 'Review a medical decision support recommendation.',
    signals: { complexity: 35, uncertainty: 50, risk: 'medium', compliance_sensitive: true },
  });
  assert.equal(result.recommendation.initial_route, 'human');
  assert.equal(result.recommendation.human_approval_required, true);
});

test('graph validation rejects a success path that bypasses verification', () => {
  const graph = minimalGraph({
    nodes: [
      { node_id: 'work', title: 'Do work', kind: 'direct', role: 'direct', tool_policy: ['proofgraph'] },
      { node_id: 'done', title: 'Done', kind: 'terminal', role: 'system', terminal_status: 'success', tool_policy: ['proofgraph'] },
    ],
    edges: [{ edge_id: 'e-work-done', from: 'work', to: 'done', condition: { type: 'outcome', value: 'success' } }],
  });
  assert.throws(() => validateGraphSpec(graph), /verifier/i);
});

test('graph validation rejects approval-free high-risk nodes', () => {
  const graph = minimalGraph();
  graph.nodes[0].risk = 'high';
  graph.nodes[0].approval_required = false;
  assert.throws(() => validateGraphSpec(graph), /must require (?:human )?approval/i);
});

test('graph validation rejects mutation capabilities under default policy', () => {
  const graph = minimalGraph();
  graph.nodes[0].tool_policy = ['proofgraph', 'workspace_write'];
  graph.nodes[0].approval_required = true;
  assert.throws(() => validateGraphSpec(graph), /workspace mutation/i);
});

test('graph validation rejects cycles without verifier or human gate', () => {
  const graph = minimalGraph({
    nodes: [
      { node_id: 'plan', title: 'Plan', kind: 'plan', role: 'planner', max_attempts: 3, tool_policy: ['proofgraph'] },
      { node_id: 'develop', title: 'Develop', kind: 'develop', role: 'developer', max_attempts: 3, tool_policy: ['proofgraph'] },
      { node_id: 'verify', title: 'Verify', kind: 'verify', role: 'verifier', tool_policy: ['proofgraph'] },
      { node_id: 'done', title: 'Done', kind: 'terminal', role: 'system', terminal_status: 'success', tool_policy: ['proofgraph'] },
    ],
    entry_node: 'plan',
    edges: [
      { edge_id: 'e-plan-develop', from: 'plan', to: 'develop', condition: { type: 'outcome', value: 'success' } },
      { edge_id: 'e-develop-plan', from: 'develop', to: 'plan', condition: { type: 'failure_type', value: 'design_error' } },
      { edge_id: 'e-develop-verify', from: 'develop', to: 'verify', condition: { type: 'outcome', value: 'success' } },
      { edge_id: 'e-verify-done', from: 'verify', to: 'done', condition: { type: 'verification', value: 'passed' } },
    ],
  });
  assert.throws(() => validateGraphSpec(graph), /cycle.*verification|cycle.*human approval/i);
});

test('graph validation reports cycles and stable digest for safe loop', () => {
  const compiled = compileDynamicGraph({
    objective: 'Implement and verify a bounded code design.',
    mode: 'build',
    signals: { complexity: 60, uncertainty: 20, risk: 'low', requires_implementation: true },
  });
  const validated = validateGraphSpec(compiled.graph);
  assert.equal(validated.digest, compiled.graph_digest);
  assert.ok(validated.analysis.cycle_count >= 1);
});
