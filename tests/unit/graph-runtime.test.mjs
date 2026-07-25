import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  abortGraphRun,
  claimGraphNode,
  completeGraphNode,
  expandGraph,
  getGraphReport,
  getGraphStatus,
  resolveGraphApproval,
  startGraphRun,
  verifyGraphIntegrity,
} from '../../server/lib/graph-runtime.mjs';
import { readRun } from '../../server/lib/store.mjs';
import { cleanupContext, makeContext } from '../helpers.mjs';

const SIMPLE = {
  objective: 'Produce one concise local result and verify it.',
  signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
};

async function claimReady(context, runId, nodeId = null) {
  const status = await getGraphStatus({ run_id: runId }, context);
  const node = nodeId ? status.ready_nodes.find((item) => item.node_id === nodeId) : status.ready_nodes[0];
  assert.ok(node, `No ready node${nodeId ? ` ${nodeId}` : ''}: ${JSON.stringify(status.ready_nodes)}`);
  await claimGraphNode({ run_id: runId, actor: node.role, node_id: node.node_id }, context);
  return node;
}

async function completeReady(context, runId, nodeId, outcome, output = {}, failure = undefined) {
  const node = await claimReady(context, runId, nodeId);
  return completeGraphNode({ run_id: runId, actor: node.role, node_id: node.node_id, outcome, output, ...(failure ? { failure } : {}) }, context);
}

async function finishSimple(context, runId) {
  await completeReady(context, runId, 'direct', 'success', { result: 'A bounded result.' });
  await completeReady(context, runId, 'verify', 'success', { verification: { passed: true }, checks: ['format', 'scope'] });
  return completeReady(context, runId, 'synthesize', 'success', { summary: 'Verified bounded result.' });
}

test('direct graph lifecycle finalizes and passes integrity', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  assert.deepEqual(start.ready_nodes.map((node) => node.node_id), ['direct']);
  const final = await finishSimple(context, start.run_id);
  assert.equal(final.status, 'finalized');
  assert.equal(final.terminal_status, 'success');
  const report = await getGraphReport({ run_id: start.run_id, format: 'json' }, context);
  assert.equal(report.report.quality_gate_passed, true);
  assert.equal(report.report.terminal_status, 'success');
  const integrity = await verifyGraphIntegrity({ run_id: start.run_id }, context);
  assert.equal(integrity.ok, true, JSON.stringify(integrity.failed_checks));
});

test('complex research graph activates bounded parallel shards and all-join plan', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Research and implement a distributed workflow using multiple independent sources.',
    mode: 'build',
    signals: { complexity: 85, uncertainty: 80, risk: 'medium', requires_research: true, requires_implementation: true, estimated_subtasks: 8 },
    constraints: { max_parallel_nodes: 3, max_iterations: 3 },
  }, context);
  let status = await getGraphStatus({ run_id: start.run_id }, context);
  const researchIds = status.ready_nodes.map((node) => node.node_id);
  assert.equal(researchIds.length, 3);
  assert.ok(researchIds.every((id) => id.startsWith('research-')));
  await completeReady(context, start.run_id, researchIds[0], 'success', { findings: ['source A'] });
  status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.equal(status.ready_nodes.some((node) => node.node_id === 'plan'), false);
  for (const id of researchIds.slice(1)) await completeReady(context, start.run_id, id, 'success', { findings: [`result ${id}`] });
  status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['plan']);
});

test('verification failure routes back to developer and can recover', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await completeReady(context, start.run_id, 'direct', 'success', { result: 'first draft' });
  await completeReady(context, start.run_id, 'verify', 'failed', { verification: { passed: false } }, {
    failure_type: 'implementation_error', severity: 'medium', summary: 'The implementation output omitted a required field.', evidence: ['missing field'], signature: 'missing-field-01',
  });
  let status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['develop']);
  await completeReady(context, start.run_id, 'develop', 'success', { patch: 'Add the required field.' });
  status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['verify']);
  await completeReady(context, start.run_id, 'verify', 'success', { verification: { passed: true }, checks: ['required field present'] });
  await completeReady(context, start.run_id, 'synthesize', 'success', { summary: 'Recovered after one implementation correction.' });
  const report = await getGraphReport({ run_id: start.run_id, format: 'json' }, context);
  assert.equal(report.report.terminal_status, 'success');
  assert.equal(report.report.failures.length, 1);
  assert.equal(report.report.quality_gate_passed, true);
});

test('second identical implementation failure escalates from developer to planner', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await completeReady(context, start.run_id, 'direct', 'success', { result: 'draft' });
  const failure = {
    failure_type: 'implementation_error', severity: 'medium', summary: 'The same deterministic check fails.', signature: 'same-check-01', evidence: ['check-1'],
  };
  await completeReady(context, start.run_id, 'verify', 'failed', { verification: { passed: false } }, failure);
  await completeReady(context, start.run_id, 'develop', 'success', { patch: 'attempt one' });
  await completeReady(context, start.run_id, 'verify', 'failed', { verification: { passed: false } }, failure);
  const status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['plan']);
  assert.match(JSON.stringify(status.route_history.at(-1)), /design_error/);
});

test('high-risk graph waits for challenge-bound human approval', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Prepare a production deployment change after verification.',
    mode: 'build',
    signals: { complexity: 60, uncertainty: 30, risk: 'high', requires_implementation: true, external_side_effects: true },
  }, context);
  assert.equal(start.status, 'waiting_approval');
  assert.equal(start.pending_approvals.length, 1);
  const approval = start.pending_approvals[0];
  await assert.rejects(() => resolveGraphApproval({
    run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'approved', challenge: 'confirm_wrong0000', decision_source: 'AskUserQuestion',
  }, context), /challenge mismatch/i);
  const resolved = await resolveGraphApproval({
    run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'approved', challenge: approval.challenge, decision_source: 'AskUserQuestion', comment: 'Approved for a sandbox-only artifact.',
  }, context);
  assert.equal(resolved.status, 'active');
  assert.ok(resolved.ready_nodes.length >= 1);
});

test('human denial reaches failed terminal without executing worker nodes', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Delete a production resource after evaluating the request.',
    mode: 'build',
    signals: { complexity: 40, uncertainty: 20, risk: 'critical', requires_implementation: true, external_side_effects: true, reversibility: 'irreversible' },
  }, context);
  const approval = start.pending_approvals[0];
  const result = await resolveGraphApproval({
    run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'denied', challenge: approval.challenge, decision_source: 'AskUserQuestion', comment: 'Production deletion is not approved.',
  }, context);
  assert.equal(result.status, 'finalized');
  const report = await getGraphReport({ run_id: start.run_id, format: 'json' }, context);
  assert.equal(report.report.terminal_status, 'failed');
  assert.equal(report.report.quality_gate_passed, false);
  assert.equal(report.report.nodes.find((node) => node.node_id === 'develop').attempts, 0);
});

test('planner can insert bounded dynamic fan-out before a pending join', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Implement a modular local design and verify each planned component.',
    mode: 'build',
    signals: { complexity: 60, uncertainty: 20, risk: 'low', requires_research: false, requires_implementation: true },
    constraints: { max_parallel_nodes: 3, max_dynamic_nodes: 3, max_iterations: 3 },
  }, context);
  await claimGraphNode({ run_id: start.run_id, actor: 'planner', node_id: 'plan' }, context);
  const expansion = await expandGraph({
    run_id: start.run_id,
    actor: 'planner',
    parent_node_id: 'plan',
    join_node_id: 'develop',
    reason: 'Split the implementation into two independently reviewable artifacts.',
    tasks: [
      { node_id: 'component-a', title: 'Design component A', kind: 'develop' },
      { node_id: 'component-b', title: 'Design component B', kind: 'develop' },
    ],
  }, context);
  assert.equal(expansion.dynamic_nodes, 2);
  assert.equal(expansion.graph_revision, 2);
  await completeGraphNode({ run_id: start.run_id, actor: 'planner', node_id: 'plan', outcome: 'success', output: { plan: ['component-a', 'component-b'] } }, context);
  let status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id).sort(), ['component-a', 'component-b']);
  await completeReady(context, start.run_id, 'component-a', 'success', { artifact: 'A' });
  status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.equal(status.ready_nodes.some((node) => node.node_id === 'develop'), false);
  await completeReady(context, start.run_id, 'component-b', 'success', { artifact: 'B' });
  status = await getGraphStatus({ run_id: start.run_id }, context);
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['develop']);
  const integrity = await verifyGraphIntegrity({ run_id: start.run_id }, context);
  assert.equal(integrity.ok, true, JSON.stringify(integrity.failed_checks));
});

test('dynamic expansion cannot exceed graph node budget', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Implement a small bounded design with one dynamic task.',
    mode: 'build',
    signals: { complexity: 45, uncertainty: 10, risk: 'low', requires_implementation: true },
    constraints: { max_parallel_nodes: 2, max_dynamic_nodes: 1 },
  }, context);
  await claimGraphNode({ run_id: start.run_id, actor: 'planner', node_id: 'plan' }, context);
  await assert.rejects(() => expandGraph({
    run_id: start.run_id, actor: 'planner', parent_node_id: 'plan', join_node_id: 'develop', reason: 'Attempt to exceed the declared budget.',
    tasks: [
      { node_id: 'extra-a', title: 'Extra A', kind: 'develop' },
      { node_id: 'extra-b', title: 'Extra B', kind: 'develop' },
    ],
  }, context), /budget|length must be between/i);
});

test('actor-role mismatch cannot claim or complete another role node', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await assert.rejects(() => claimGraphNode({ run_id: start.run_id, actor: 'verifier', node_id: 'direct' }, context), /does not match (?:graph )?node role/i);
  await claimGraphNode({ run_id: start.run_id, actor: 'direct', node_id: 'direct' }, context);
  await assert.rejects(() => completeGraphNode({ run_id: start.run_id, actor: 'developer', node_id: 'direct', outcome: 'success', output: {} }, context), /claiming actor/i);
});

test('graph state and report tampering are detected', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await finishSimple(context, start.run_id);
  const reportPath = path.join(context.dataDir, 'runs', start.run_id, 'report.md');
  await fs.appendFile(reportPath, '\nforged line\n');
  const integrity = await verifyGraphIntegrity({ run_id: start.run_id }, context);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.failed_checks.includes('report_markdown'));
});

test('abort releases project singleton for a new graph run', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const first = await startGraphRun(SIMPLE, context);
  await assert.rejects(() => startGraphRun(SIMPLE, context), /already active/);
  await abortGraphRun({ run_id: first.run_id, actor: 'coordinator', reason: 'Test abort before starting a replacement.' }, context);
  const second = await startGraphRun(SIMPLE, context);
  assert.notEqual(second.run_id, first.run_id);
  const state = await readRun(context.dataDir, second.run_id);
  assert.equal(state.run_kind, 'graph');
});
