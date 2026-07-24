import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupContext, makeContext, McpClient } from '../helpers.mjs';

function content(result) {
  return result.structuredContent;
}

async function successfulTool(client, name, args) {
  const result = await client.callTool(name, args);
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  return content(result);
}

test('MCP requires initialize before tool operations', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: true }).start();
  t.after(() => client.close());
  const response = await client.request('tools/list');
  assert.equal(response.error.code, -32002);
});

test('MCP negotiates the latest supported protocol when requested version is unknown', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context }).start();
  t.after(() => client.close());
  const response = await client.request('initialize', {
    protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(response.result.protocolVersion, '2025-11-25');
});

test('production tool list excludes the deterministic fixture importer', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start();
  t.after(() => client.close());
  await client.initialize();
  const response = await client.request('tools/list');
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('pg_test_import_source'), false);
  assert.equal(names.includes('pg_start_run'), true);
});

test('test-mode MCP completes a full evidence-gated lifecycle', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: true }).start();
  t.after(() => client.close());
  await client.initialize();
  const start = await successfulTool(client, 'pg_start_run', {
    objective: 'Verify that the test system uses exact source quotations for evidence.',
    policy: { max_tool_calls: 40, max_source_fetches: 4, max_claims: 4, max_agents: 5, max_wall_time_seconds: 300 },
  });
  const runId = start.run_id;
  await successfulTool(client, 'pg_register_plan', {
    run_id: runId, actor: 'planner', tasks: [
      { task_id: 'research-primary', title: 'Primary research', role: 'research-primary' },
      { task_id: 'research-secondary', title: 'Secondary research', role: 'research-secondary' },
      { task_id: 'verification', title: 'Independent verification', role: 'verifier' },
    ],
  });
  await successfulTool(client, 'pg_register_claims', {
    run_id: runId, actor: 'planner', claims: [{ claim_id: 'claim-01', text: 'The test system uses exact source quotations for evidence.', importance: 'high' }],
  });
  const quote1 = 'The test system uses exact source quotations for evidence validation.';
  const quote2 = 'The independent specification confirms exact quotation matching for evidence.';
  const source1 = (await successfulTool(client, 'pg_test_import_source', {
    run_id: runId, actor: 'research-primary', url: 'https://official.example/spec', content: `Official. ${quote1} End.`,
  })).source.source_id;
  const source2 = (await successfulTool(client, 'pg_test_import_source', {
    run_id: runId, actor: 'research-secondary', url: 'https://independent.example/report', content: `Report. ${quote2} End.`,
  })).source.source_id;
  const evidence = await successfulTool(client, 'pg_attach_evidence', {
    run_id: runId, actor: 'research-primary', items: [
      { claim_id: 'claim-01', source_id: source1, quote: quote1, stance: 'supports' },
      { claim_id: 'claim-01', source_id: source2, quote: quote2, stance: 'supports' },
    ],
  });
  await successfulTool(client, 'pg_complete_task', { run_id: runId, actor: 'research-primary', task_id: 'research-primary', outcome: 'success', summary: 'Primary source recorded.' });
  await successfulTool(client, 'pg_complete_task', { run_id: runId, actor: 'research-secondary', task_id: 'research-secondary', outcome: 'success', summary: 'Secondary source recorded.' });
  await successfulTool(client, 'pg_record_verdicts', {
    run_id: runId, actor: 'verifier', items: [{
      claim_id: 'claim-01', verdict: 'supported', rationale: 'Both stored exact quotations directly support the claim.', evidence_ids: evidence.evidence_ids,
    }],
  });
  await successfulTool(client, 'pg_complete_task', { run_id: runId, actor: 'verifier', task_id: 'verification', outcome: 'success', summary: 'Every quotation and source was checked.' });
  const final = await successfulTool(client, 'pg_finalize_run', { run_id: runId, actor: 'synthesizer' });
  assert.equal(final.quality_gate_passed, true);
  const integrity = await successfulTool(client, 'pg_verify_integrity', { run_id: runId });
  assert.equal(integrity.ok, true);
  const report = await successfulTool(client, 'pg_get_report', { run_id: runId, format: 'markdown' });
  assert.match(report.report, /claim-01 — SUPPORTED/);
});

test('MCP reports malformed JSON and unknown tools without crashing', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start();
  t.after(() => client.close());
  const parse = await client.sendRaw('{broken json');
  assert.equal(parse.error.code, -32700);
  await client.initialize();
  const unknown = await client.request('tools/call', { name: 'pg_not_real', arguments: {} });
  assert.equal(unknown.error.code, -32602);
});

test('MCP state persists across server restarts', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  let client = await new McpClient({ ...context, testMode: true }).start();
  await client.initialize();
  const start = await successfulTool(client, 'pg_start_run', { objective: 'Verify persistence of a run across MCP server process restarts.' });
  await client.close();
  client = await new McpClient({ ...context, testMode: true }).start();
  t.after(() => client.close());
  await client.initialize();
  const status = await successfulTool(client, 'pg_get_status', { run_id: start.run_id });
  assert.equal(status.status, 'active');
  const active = await successfulTool(client, 'pg_get_active_run', {});
  assert.equal(active.active.run_id, start.run_id);
});

test('MCP output schemas permit the documented structured result fields', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const client = await new McpClient({ ...context, testMode: false }).start();
  t.after(() => client.close());
  await client.initialize();
  const listed = await client.request('tools/list');
  assert.ok(listed.result.tools.length >= 14);
  for (const tool of listed.result.tools) {
    assert.equal(tool.outputSchema.type, 'object');
    assert.equal(tool.outputSchema.additionalProperties, true, tool.name);
    assert.deepEqual(tool.outputSchema.required, ['ok']);
  }
});
