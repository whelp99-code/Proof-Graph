import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupContext, makeContext, McpClient } from '../helpers.mjs';

function structured(result) {
  return result.structuredContent;
}

async function ok(client, name, args) {
  const result = await client.callTool(name, args);
  assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.structuredContent)}`);
  return structured(result);
}

async function err(client, name, args) {
  const result = await client.callTool(name, args);
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return structured(result);
}

const SIMPLE_INPUT = {
  objective: 'Produce a short deterministic output and verify it before finalization.',
  signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
};

test('MCP production surface exposes graph tools without fixture importer', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const response = await client.request('tools/list');
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 24);
  assert.equal(new Set(names).size, names.length);
  for (const required of ['pg_graph_preview', 'pg_graph_start', 'pg_graph_claim_node', 'pg_graph_complete_node', 'pg_graph_resolve_approval', 'pg_graph_expand', 'pg_graph_verify_integrity']) {
    assert.ok(names.includes(required), required);
  }
  assert.equal(names.includes('pg_test_import_source'), false);
});

test('MCP graph preview is deterministic and side-effect free', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const first = await ok(client, 'pg_graph_preview', SIMPLE_INPUT);
  const second = await ok(client, 'pg_graph_preview', SIMPLE_INPUT);
  assert.equal(first.graph_digest, second.graph_digest);
  const active = await ok(client, 'pg_get_active_run', {});
  assert.equal(active.active, null);
});

test('MCP completes a full dynamic direct workflow', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const start = await ok(client, 'pg_graph_start', SIMPLE_INPUT);
  const runId = start.run_id;
  assert.deepEqual(start.ready_nodes.map((node) => node.node_id), ['direct']);
  await ok(client, 'pg_graph_claim_node', { run_id: runId, actor: 'direct', node_id: 'direct' });
  await ok(client, 'pg_graph_complete_node', { run_id: runId, actor: 'direct', node_id: 'direct', outcome: 'success', output: { result: 'MCP result' } });
  await ok(client, 'pg_graph_claim_node', { run_id: runId, actor: 'verifier', node_id: 'verify' });
  await ok(client, 'pg_graph_complete_node', { run_id: runId, actor: 'verifier', node_id: 'verify', outcome: 'success', output: { verification: { passed: true }, checks: ['bounded'] } });
  await ok(client, 'pg_graph_claim_node', { run_id: runId, actor: 'synthesizer', node_id: 'synthesize' });
  const final = await ok(client, 'pg_graph_complete_node', { run_id: runId, actor: 'synthesizer', node_id: 'synthesize', outcome: 'success', output: { summary: 'Verified.' } });
  assert.equal(final.status, 'finalized');
  assert.equal(final.terminal_status, 'success');
  const integrity = await ok(client, 'pg_graph_verify_integrity', { run_id: runId });
  assert.equal(integrity.ok, true, JSON.stringify(integrity.failed_checks));
  const report = await ok(client, 'pg_graph_get_report', { run_id: runId, format: 'markdown' });
  assert.match(report.report, /Dynamic Workflow Report/);
});

test('MCP graph state persists across process restart', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  let client = await new McpClient({ ...context, testMode: false }).start();
  await client.initialize();
  const start = await ok(client, 'pg_graph_start', SIMPLE_INPUT);
  await client.close();
  client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const status = await ok(client, 'pg_graph_get_status', { run_id: start.run_id });
  assert.equal(status.status, 'active');
  assert.deepEqual(status.ready_nodes.map((node) => node.node_id), ['direct']);
});

test('MCP high-risk workflow rejects wrong challenge and accepts explicit decision', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const start = await ok(client, 'pg_graph_start', {
    objective: 'Prepare a production deployment with external side effects.',
    mode: 'build',
    signals: { complexity: 65, uncertainty: 30, risk: 'high', requires_implementation: true, external_side_effects: true },
  });
  const approval = start.pending_approvals[0];
  const rejected = await err(client, 'pg_graph_resolve_approval', {
    run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'approved', challenge: 'confirm_invalid00', decision_source: 'AskUserQuestion',
  });
  assert.match(rejected.error.message, /challenge/i);
  const resolved = await ok(client, 'pg_graph_resolve_approval', {
    run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'denied', challenge: approval.challenge, decision_source: 'AskUserQuestion', comment: 'Not approved for production.',
  });
  assert.equal(resolved.status, 'finalized');
});

test('MCP enforces role ownership and verifier output contract', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start(); t.after(() => client.close());
  await client.initialize();
  const start = await ok(client, 'pg_graph_start', SIMPLE_INPUT);
  const mismatch = await err(client, 'pg_graph_claim_node', { run_id: start.run_id, actor: 'verifier', node_id: 'direct' });
  assert.match(mismatch.error.message, /role/i);
  await ok(client, 'pg_graph_claim_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct' });
  await ok(client, 'pg_graph_complete_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct', outcome: 'success', output: {} });
  await ok(client, 'pg_graph_claim_node', { run_id: start.run_id, actor: 'verifier', node_id: 'verify' });
  const invalid = await err(client, 'pg_graph_complete_node', { run_id: start.run_id, actor: 'verifier', node_id: 'verify', outcome: 'success', output: { verification: { passed: false } } });
  assert.match(invalid.error.message, /passed\s*=\s*true/i);
});
