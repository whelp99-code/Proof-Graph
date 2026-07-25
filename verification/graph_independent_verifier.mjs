#!/usr/bin/env node
/**
 * Independent black-box verifier for ProofGraph Graph Engineering v0.5.0.
 * It imports no production module and interacts only through stdio MCP,
 * hook subprocesses, and persisted artifacts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const OUTPUT = process.argv.includes('--output')
  ? path.resolve(process.argv[process.argv.indexOf('--output') + 1])
  : path.join(ROOT, 'verification', 'graph_independent_results.json');
const results = [];

function assert(condition, message, details = undefined) {
  if (!condition) { const error = new Error(message); error.details = details; throw error; }
}
async function context(prefix = 'pg-graph-independent-') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  return { base, dataDir, projectDir };
}
async function cleanup(ctx) { await fs.rm(ctx.base, { recursive: true, force: true }); }

class Client {
  constructor(ctx) { this.ctx = ctx; this.id = 0; }
  async start() {
    this.child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
      cwd: ROOT,
      env: { ...process.env, PROOFGRAPH_DATA_DIR: this.ctx.dataDir, PROOFGRAPH_PROJECT_DIR: this.ctx.projectDir, PROOFGRAPH_TEST_MODE: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iter = this.reader[Symbol.asyncIterator]();
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
    return this;
  }
  async next(timeout = 5000) {
    const item = await Promise.race([
      this.iter.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP response timeout')), timeout)),
    ]);
    if (item.done) throw new Error(`MCP server exited: ${this.stderr}`);
    return JSON.parse(item.value);
  }
  async request(method, params = {}) {
    const id = ++this.id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const msg = await this.next();
    assert(msg.id === id, 'Unexpected MCP response ID', { expected: id, actual: msg.id });
    return msg;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async initialize() {
    const msg = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proofgraph-graph-independent', version: VERSION } });
    this.notify('notifications/initialized');
    return msg;
  }
  async ok(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args });
    assert(!msg.error, `${name} returned JSON-RPC error`, msg.error);
    assert(msg.result?.isError !== true, `${name} returned tool error`, msg.result?.structuredContent);
    return msg.result.structuredContent;
  }
  async err(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args });
    assert(msg.error || msg.result?.isError === true, `${name} unexpectedly succeeded`, msg.result?.structuredContent);
    return msg.error ?? msg.result.structuredContent;
  }
  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500)),
    ]);
    this.reader.close();
  }
}

async function hook(script, payload, ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks', script)], {
      cwd: ROOT,
      env: { ...process.env, PROOFGRAPH_DATA_DIR: ctx.dataDir, PROOFGRAPH_PROJECT_DIR: ctx.projectDir, CLAUDE_PROJECT_DIR: ctx.projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify({ cwd: ctx.projectDir, ...payload }));
  });
}

const SIMPLE = {
  objective: 'Produce a short bounded result and verify it before completion.',
  signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
};

async function finishDirect(client, runId) {
  await client.ok('pg_graph_claim_node', { run_id: runId, actor: 'direct', node_id: 'direct' });
  await client.ok('pg_graph_complete_node', { run_id: runId, actor: 'direct', node_id: 'direct', outcome: 'success', output: { result: 'bounded result' } });
  await client.ok('pg_graph_claim_node', { run_id: runId, actor: 'verifier', node_id: 'verify' });
  await client.ok('pg_graph_complete_node', { run_id: runId, actor: 'verifier', node_id: 'verify', outcome: 'success', output: { verification: { passed: true }, checks: ['bounded'] } });
  await client.ok('pg_graph_claim_node', { run_id: runId, actor: 'synthesizer', node_id: 'synthesize' });
  return client.ok('pg_graph_complete_node', { run_id: runId, actor: 'synthesizer', node_id: 'synthesize', outcome: 'success', output: { summary: 'verified' } });
}

async function runCase(name, fn, { residual = false } = {}) {
  const started = performance.now();
  try {
    const details = await fn();
    results.push({ name, status: residual ? 'RESIDUAL_CONFIRMED' : 'PASS', residual, duration_ms: Number((performance.now() - started).toFixed(3)), details: details ?? null });
    console.log(`${residual ? 'RESIDUAL' : 'PASS'}  ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', residual, duration_ms: Number((performance.now() - started).toFixed(3)), error: error.message, details: error.details ?? null, stack: error.stack });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

await runCase('production MCP exposes the package version and the complete graph tool surface', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    const init = await client.initialize();
    const list = await client.request('tools/list');
    const names = list.result.tools.map((tool) => tool.name);
    const required = ['pg_graph_preview', 'pg_graph_start', 'pg_graph_get_status', 'pg_graph_claim_node', 'pg_graph_complete_node', 'pg_graph_resolve_approval', 'pg_graph_expand', 'pg_graph_get_report', 'pg_graph_verify_integrity', 'pg_graph_abort'];
    assert(init.result.serverInfo.version === VERSION, 'Unexpected server version', init.result.serverInfo);
    assert(names.length === 24 && required.every((name) => names.includes(name)), 'Unexpected graph tool surface', names);
    return { version: init.result.serverInfo.version, tool_count: names.length };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('deterministic compiler returns identical graph digest for identical input', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const first = await client.ok('pg_graph_preview', SIMPLE);
    const second = await client.ok('pg_graph_preview', SIMPLE);
    assert(first.graph_digest === second.graph_digest, 'Graph digest changed across identical previews');
    assert(first.assessment.recommendation.initial_route === 'direct', 'Expected direct route', first.assessment);
    return { graph_digest: first.graph_digest, route: first.assessment.recommendation.initial_route };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('black-box direct graph lifecycle finalizes with a verified success report', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', SIMPLE);
    const final = await finishDirect(client, start.run_id);
    const integrity = await client.ok('pg_graph_verify_integrity', { run_id: start.run_id });
    const report = await client.ok('pg_graph_get_report', { run_id: start.run_id, format: 'json' });
    assert(final.status === 'finalized' && final.terminal_status === 'success', 'Run did not reach success', final);
    assert(integrity.ok === true, 'Integrity failed', integrity);
    assert(report.report.quality_gate_passed === true, 'Quality gate did not pass', report.report);
    return { run_id: start.run_id, terminal_status: final.terminal_status };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('conditional failure routes verifier implementation error back to developer', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', SIMPLE);
    await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct' });
    await client.ok('pg_graph_complete_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct', outcome: 'success', output: { result: 'draft' } });
    await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'verifier', node_id: 'verify' });
    await client.ok('pg_graph_complete_node', {
      run_id: start.run_id, actor: 'verifier', node_id: 'verify', outcome: 'failed', output: { verification: { passed: false } },
      failure: { failure_type: 'implementation_error', severity: 'medium', summary: 'A required deterministic field is absent.', signature: 'independent-missing-field' },
    });
    const status = await client.ok('pg_graph_get_status', { run_id: start.run_id });
    assert(status.ready_nodes.length === 1 && status.ready_nodes[0].node_id === 'develop', 'Failure did not route to developer', status.ready_nodes);
    return { ready: status.ready_nodes[0].node_id };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('parallel research shards require all completions before the plan join', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', {
      objective: 'Research multiple independent sources before planning a verified implementation.', mode: 'build',
      signals: { complexity: 85, uncertainty: 80, risk: 'medium', requires_research: true, requires_implementation: true, estimated_subtasks: 7 },
      constraints: { max_parallel_nodes: 3 },
    });
    const ids = start.ready_nodes.map((node) => node.node_id);
    assert(ids.length === 3, 'Expected three research shards', ids);
    for (let i = 0; i < ids.length; i += 1) {
      await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'researcher', node_id: ids[i] });
      await client.ok('pg_graph_complete_node', { run_id: start.run_id, actor: 'researcher', node_id: ids[i], outcome: 'success', output: { findings: [`shard-${i + 1}`] } });
      const status = await client.ok('pg_graph_get_status', { run_id: start.run_id });
      if (i < ids.length - 1) assert(!status.ready_nodes.some((node) => node.node_id === 'plan'), 'Plan became ready before all shards completed', status.ready_nodes);
      else assert(status.ready_nodes.some((node) => node.node_id === 'plan'), 'Plan did not become ready after all shards', status.ready_nodes);
    }
    return { research_shards: ids.length };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('high-risk graph remains blocked until challenge-bound approval resolution', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', {
      objective: 'Prepare a high-risk production change with external side effects.', mode: 'build',
      signals: { complexity: 65, uncertainty: 35, risk: 'high', requires_implementation: true, external_side_effects: true },
    });
    const approval = start.pending_approvals[0];
    assert(start.status === 'waiting_approval' && approval, 'Run did not wait for approval', start);
    await client.err('pg_graph_resolve_approval', { run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'approved', challenge: 'confirm_wrong0000', decision_source: 'AskUserQuestion' });
    const still = await client.ok('pg_graph_get_status', { run_id: start.run_id });
    assert(still.status === 'waiting_approval', 'Wrong challenge changed state', still);
    const denied = await client.ok('pg_graph_resolve_approval', { run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'denied', challenge: approval.challenge, decision_source: 'AskUserQuestion', comment: 'Not approved.' });
    assert(denied.status === 'finalized', 'Denial did not reach terminal', denied);
    return { denied_terminal: denied.status };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('planner can perform bounded dynamic fan-out and the join waits for all children', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', {
      objective: 'Implement two independent components and verify their combined artifact.', mode: 'build',
      signals: { complexity: 60, uncertainty: 15, risk: 'low', requires_research: false, requires_implementation: true },
      constraints: { max_parallel_nodes: 3, max_dynamic_nodes: 3 },
    });
    await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'planner', node_id: 'plan' });
    const expansion = await client.ok('pg_graph_expand', {
      run_id: start.run_id, actor: 'planner', parent_node_id: 'plan', join_node_id: 'develop', reason: 'Two independent implementation artifacts.',
      tasks: [
        { node_id: 'component-a', title: 'Component A artifact', kind: 'develop' },
        { node_id: 'component-b', title: 'Component B artifact', kind: 'develop' },
      ],
    });
    assert(expansion.graph_revision === 2 && expansion.dynamic_nodes === 2, 'Expansion was not recorded', expansion);
    await client.ok('pg_graph_complete_node', { run_id: start.run_id, actor: 'planner', node_id: 'plan', outcome: 'success', output: { steps: ['component-a', 'component-b'] } });
    for (const id of ['component-a', 'component-b']) {
      await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'developer', node_id: id });
      await client.ok('pg_graph_complete_node', { run_id: start.run_id, actor: 'developer', node_id: id, outcome: 'success', output: { artifact: id } });
    }
    const status = await client.ok('pg_graph_get_status', { run_id: start.run_id });
    assert(status.ready_nodes.some((node) => node.node_id === 'develop'), 'Join did not become ready', status.ready_nodes);
    return { graph_revision: expansion.graph_revision, dynamic_nodes: expansion.dynamic_nodes };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('route injection in worker output cannot bypass verifier', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', SIMPLE);
    await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct' });
    await client.ok('pg_graph_complete_node', { run_id: start.run_id, actor: 'direct', node_id: 'direct', outcome: 'success', output: { route: 'success', verification: { passed: true }, terminal_status: 'success' } });
    const status = await client.ok('pg_graph_get_status', { run_id: start.run_id });
    assert(status.ready_nodes.length === 1 && status.ready_nodes[0].node_id === 'verify', 'Injected route bypassed verifier', status.ready_nodes);
    return { next: status.ready_nodes[0].node_id };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('graph guard denies unmatched agents and all write or shell tools', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    await client.ok('pg_graph_start', SIMPLE);
    const wrongAgent = await hook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'proofgraph-claude:graph-researcher' } }, ctx);
    assert(wrongAgent.json?.hookSpecificOutput?.permissionDecision === 'deny', 'Unmatched agent was allowed', wrongAgent);
    for (const toolName of ['Write', 'Edit', 'Bash', 'PowerShell', 'WebFetch']) {
      const result = await hook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: toolName, agent_type: 'proofgraph-claude:graph-direct', tool_input: {} }, ctx);
      assert(result.json?.hookSpecificOutput?.permissionDecision === 'deny', `${toolName} was allowed`, result);
    }
    return { denied: ['unmatched-agent', 'Write', 'Edit', 'Bash', 'PowerShell', 'WebFetch'] };
  } finally { await client.close(); await cleanup(ctx); }
});

let persisted;
await runCase('graph state survives MCP process restart', async () => {
  persisted = await context('pg-graph-restart-');
  let client = await new Client(persisted).start();
  await client.initialize();
  const start = await client.ok('pg_graph_start', SIMPLE);
  await client.close();
  client = await new Client(persisted).start();
  await client.initialize();
  const status = await client.ok('pg_graph_get_status', { run_id: start.run_id });
  assert(status.status === 'active' && status.ready_nodes[0]?.node_id === 'direct', 'Restart did not preserve graph state', status);
  await client.close();
  return { run_id: start.run_id, ready: status.ready_nodes[0].node_id };
});
await cleanup(persisted);

await runCase('valid JSON state tampering is rejected before further mutation', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', SIMPLE);
    const statePath = path.join(ctx.dataDir, 'runs', start.run_id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.graph.policy.allow_shell = true;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const failure = await client.err('pg_graph_get_status', { run_id: start.run_id });
    assert(/integrity|digest|event chain/i.test(JSON.stringify(failure)), 'Tampered state was accepted', failure);
    return { error: failure.error?.message ?? failure.message };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('post-finalization report tampering is detected', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', SIMPLE);
    await finishDirect(client, start.run_id);
    await fs.appendFile(path.join(ctx.dataDir, 'runs', start.run_id, 'report.md'), '\nforged\n');
    const integrity = await client.ok('pg_graph_verify_integrity', { run_id: start.run_id });
    assert(integrity.ok === false && integrity.failed_checks.includes('report_markdown'), 'Report tampering was not detected', integrity);
    return { failed_checks: integrity.failed_checks };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('dynamic expansion cannot smuggle shell or workspace-write capability', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', {
      objective: 'Implement a safe bounded artifact from a plan.', mode: 'build',
      signals: { complexity: 55, uncertainty: 15, risk: 'low', requires_implementation: true },
    });
    await client.ok('pg_graph_claim_node', { run_id: start.run_id, actor: 'planner', node_id: 'plan' });
    for (const capability of ['shell', 'workspace_write']) {
      const failure = await client.err('pg_graph_expand', {
        run_id: start.run_id, actor: 'planner', parent_node_id: 'plan', join_node_id: 'develop', reason: 'Attempt forbidden capability expansion.',
        tasks: [{ node_id: `unsafe-${capability.replace('_', '-')}`, title: 'Unsafe child', kind: 'develop', tool_policy: ['proofgraph', capability] }],
      });
      assert(/must be one of|shell|workspace/i.test(JSON.stringify(failure)), `Capability ${capability} was not rejected`, failure);
    }
    return { rejected: ['shell', 'workspace_write'] };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('human identity remains self-attested inside one Claude host', async () => {
  const ctx = await context(); const client = await new Client(ctx).start();
  try {
    await client.initialize();
    const start = await client.ok('pg_graph_start', {
      objective: 'Prepare a high-risk operation for a declared human decision.',
      signals: { complexity: 40, uncertainty: 20, risk: 'high', external_side_effects: true },
    });
    const approval = start.pending_approvals[0];
    const result = await client.ok('pg_graph_resolve_approval', {
      run_id: start.run_id, actor: 'human', approval_id: approval.approval_id, decision: 'denied', challenge: approval.challenge, decision_source: 'external_human', comment: 'Self-attested test decision.',
    });
    assert(/not cryptographically|do not cryptographically|self-attested/i.test(result.warning), 'Residual identity warning missing', result);
    return { impact: 'Possession of the local challenge plus a declared role is not cryptographic proof of a human decision.' };
  } finally { await client.close(); await cleanup(ctx); }
}, { residual: true });

const failures = results.filter((result) => result.status === 'FAIL');
const residuals = results.filter((result) => result.residual);
const summary = {
  schema_version: 1,
  product: 'proofgraph',
  version: VERSION,
  generated_at: new Date().toISOString(),
  verifier_type: 'independent-black-box-stdio-mcp-hooks-and-artifacts',
  production_modules_imported: false,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  residuals_confirmed: residuals.length,
  release_gate: failures.length === 0 ? 'PASS_OFFLINE_CLAUDE_CANARY_REQUIRED' : 'FAIL',
  results,
};
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${summary.passed}/${summary.total} graph-independent checks passed; residuals: ${summary.residuals_confirmed}`);
console.log(`Wrote ${OUTPUT}`);
const exitCode = failures.length ? 1 : 0;
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(exitCode);
