#!/usr/bin/env node
/**
 * Independent black-box verifier for the ProofGraph AI Agent TUI in the current release.
 * It imports no production module and interacts only through the public CLI
 * plus persisted run artifacts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'proofgraph.mjs');
const GRAPH = path.join(ROOT, 'examples', 'graphs', 'ai-agent-tui.graph.json');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const OUTPUT = process.argv.includes('--output')
  ? path.resolve(process.argv[process.argv.indexOf('--output') + 1])
  : path.join(ROOT, 'verification', 'tui_independent_results.json');
const results = [];

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function temporary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-tui-independent-'));
  const project = path.join(base, 'project');
  const data = path.join(base, 'data');
  const home = path.join(base, 'home');
  await Promise.all([fs.mkdir(project), fs.mkdir(data), fs.mkdir(home)]);
  return { base, project, data, home };
}

async function cleanup(ctx) {
  await fs.rm(ctx.base, { recursive: true, force: true });
}

function cli(args, ctx, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ctx?.project ?? ROOT,
    env: {
      ...process.env,
      ...(ctx ? { HOME: ctx.home, PROOFGRAPH_PROJECT_DIR: ctx.project, PROOFGRAPH_DATA_DIR: ctx.data } : {}),
      ...(options.env ?? {}),
    },
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 20_000_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

function jsonOutput(result, label) {
  assert(result.code === 0, `${label} failed`, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw Object.assign(new Error(`${label} returned invalid JSON`), { details: result });
  }
}

async function runCase(name, fn) {
  const started = performance.now();
  try {
    const details = await fn();
    results.push({ name, status: 'PASS', duration_ms: Number((performance.now() - started).toFixed(3)), details: details ?? null });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', duration_ms: Number((performance.now() - started).toFixed(3)), error: error.message, details: error.details ?? null, stack: error.stack });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

await runCase('CLI and Claude plugin metadata are aligned', async () => {
  const plugin = JSON.parse(await fs.readFile(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const version = jsonOutput(cli(['version']), 'proofgraph version');
  assert(/^1\.1\.0$/.test(PACKAGE.version), 'Unexpected package version', PACKAGE.version);
  assert(version.version === PACKAGE.version && plugin.version === PACKAGE.version, 'Version alignment failed', { package: PACKAGE.version, cli: version.version, plugin: plugin.version });
  return { version: PACKAGE.version, product: version.product, plugin: plugin.name };
});

await runCase('natural-language AI agent TUI request selects the bounded agent-tui template', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const compiled = jsonOutput(cli(['compile', 'AI에인전트 TUI를 개발하라', '--project', ctx.project], ctx), 'compile');
    assert(compiled.metadata?.template?.name === 'agent-tui', 'agent-tui template was not selected', compiled.metadata);
    assert(compiled.metadata?.selection === 'auto', 'Template selection was not automatic', compiled.metadata);
    const research = compiled.graph.nodes.filter((node) => node.kind === 'research');
    const verify = compiled.graph.nodes.filter((node) => node.kind === 'verify');
    assert(research.length === 6, 'Expected six bounded research workstreams', research.map((node) => node.node_id));
    assert(verify.length >= 1, 'Verifier missing from compiled graph');
    assert(compiled.graph.policy.allow_shell === false && compiled.graph.policy.allow_workspace_mutation === false, 'Unsafe compiler policy', compiled.graph.policy);
    return { template: compiled.metadata.template.name, graph_digest: compiled.graph_digest, research_nodes: research.length, verifier_nodes: verify.length };
  } finally {
    await cleanup(ctx);
  }
});

await runCase('explicit AI Agent TUI GraphSpec validates with typed nodes, cycles, and verification gates', async () => {
  const ctx = await temporary();
  try {
    const validated = jsonOutput(cli(['graph', 'validate', GRAPH, '--project', ctx.project, '--data-dir', ctx.data], ctx), 'graph validate');
    assert(validated.ok === true, 'Graph validation did not pass', validated);
    assert(validated.graph.graph_id === 'graph_ai_agent_tui_v1', 'Unexpected graph id', validated.graph.graph_id);
    assert(validated.validation.node_count === 14 && validated.validation.edge_count === 38, 'Unexpected graph shape', validated.validation);
    assert(validated.validation.cycle_count >= 1, 'Expected bounded verification reroute cycle', validated.validation);
    assert(validated.graph.nodes.some((node) => node.node_id === 'verify-functional'), 'Functional verifier missing');
    assert(validated.graph.nodes.some((node) => node.node_id === 'verify-adversarial'), 'Adversarial verifier missing');
    return { graph_digest: validated.graph_digest, analysis: validated.validation };
  } finally {
    await cleanup(ctx);
  }
});

await runCase('explicit GraphSpec completes through the mock adapter and the TUI snapshot renders verified state', async () => {
  const ctx = await temporary();
  try {
    const executed = jsonOutput(cli(['graph', 'run', GRAPH, '--adapter', 'mock', '--project', ctx.project, '--data-dir', ctx.data], ctx, { timeout: 60_000 }), 'graph run');
    assert(executed.status === 'finalized', 'Graph did not finalize', executed);
    assert(executed.report?.report?.terminal_status === 'success', 'Graph terminal status was not success', executed.report);
    assert(executed.report?.report?.quality_gate_passed === true, 'Graph quality gate failed', executed.report);
    assert(executed.integrity?.ok === true, 'Graph integrity failed', executed.integrity);

    const snapshot = cli(['tui', executed.run_id, '--snapshot', '--project', ctx.project, '--data-dir', ctx.data], ctx);
    assert(snapshot.code === 0, 'TUI snapshot failed', snapshot);
    assert(new RegExp(`ProofGraph AI Agent TUI v${PACKAGE.version.replace(/\./g, '\\.')}`).test(snapshot.stdout), 'TUI identity missing', snapshot.stdout);
    for (const expected of ['RUNS', 'GRAPH / AGENTS', 'INSPECTOR / APPROVALS', 'verify-adversarial', 'Integrity: PASS', 'a approve', 'd deny', 'x abort']) {
      assert(snapshot.stdout.includes(expected), `TUI snapshot missing ${expected}`, snapshot.stdout);
    }
    assert(!/[\u001b\u009b]/.test(snapshot.stdout), 'Snapshot emitted terminal escape controls', snapshot.stdout);
    return { run_id: executed.run_id, terminal_status: executed.report.report.terminal_status, snapshot_lines: snapshot.stdout.trimEnd().split('\n').length };
  } finally {
    await cleanup(ctx);
  }
});


await runCase('natural-language run stops for explicit approval and CLI approval resumes to verified success', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const waiting = jsonOutput(cli(['run', 'AI에인전트 TUI를 개발하라', '--adapter', 'mock', '--project', ctx.project], ctx, { timeout: 60_000 }), 'natural graph run');
    assert(waiting.status === 'waiting_approval', 'Natural graph did not stop at human approval', waiting);
    assert(waiting.pending_approvals?.length === 1, 'Expected one pending approval', waiting.pending_approvals);
    const approval = waiting.pending_approvals[0];
    const decided = jsonOutput(cli(['approve', waiting.run_id, approval.approval_id, approval.challenge, 'approve', '--project', ctx.project], ctx), 'approve');
    assert(decided.decision === 'approved' && decided.status === 'active', 'CLI approval contract failed', decided);
    const resumed = jsonOutput(cli(['resume', waiting.run_id, '--adapter', 'mock', '--project', ctx.project], ctx, { timeout: 60_000 }), 'resume');
    assert(resumed.status === 'finalized', 'Approved graph did not finalize', resumed);
    assert(resumed.report?.report?.terminal_status === 'success', 'Approved graph did not reach success', resumed.report);
    assert(resumed.report?.report?.quality_gate_passed === true, 'Approved graph did not pass quality gate', resumed.report);
    return { run_id: waiting.run_id, approval_id: approval.approval_id, terminal_status: resumed.report.report.terminal_status };
  } finally {
    await cleanup(ctx);
  }
});

await runCase('TUI fails closed on persisted-state tampering without crashing', async () => {
  const ctx = await temporary();
  try {
    const executed = jsonOutput(cli(['graph', 'run', GRAPH, '--adapter', 'mock', '--project', ctx.project, '--data-dir', ctx.data], ctx, { timeout: 60_000 }), 'graph run');
    const statePath = path.join(ctx.data, 'runs', executed.run_id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'active';
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const snapshot = cli(['tui', executed.run_id, '--snapshot', '--project', ctx.project, '--data-dir', ctx.data], ctx);
    assert(snapshot.code === 0, 'Fail-closed TUI snapshot crashed', snapshot);
    assert(/integrity_error|ERROR|digest mismatch/i.test(snapshot.stdout), 'Tampered run was not isolated', snapshot.stdout);
    assert(!snapshot.stdout.includes('integrity:PASS'), 'Tampered run was displayed as valid', snapshot.stdout);
    return { run_id: executed.run_id, fail_closed: true };
  } finally {
    await cleanup(ctx);
  }
});

await runCase('interactive mode rejects non-TTY use and directs automation to snapshot mode', async () => {
  const ctx = await temporary();
  try {
    const result = cli(['tui', '--project', ctx.project, '--data-dir', ctx.data], ctx);
    assert(result.code !== 0, 'Interactive TUI unexpectedly accepted non-TTY streams', result);
    assert(/requires a TTY|--snapshot/i.test(result.stderr), 'Non-TTY error did not explain snapshot mode', result);
    return { rejected: true, stderr: result.stderr.trim() };
  } finally {
    await cleanup(ctx);
  }
});

const failures = results.filter((item) => item.status === 'FAIL');
const summary = {
  schema_version: 1,
  product: 'proofgraph',
  component: 'ai-agent-tui',
  version: PACKAGE.version,
  generated_at: new Date().toISOString(),
  verifier_type: 'black-box-cli-and-persisted-artifacts',
  production_modules_imported: false,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  release_gate: failures.length === 0 ? 'PASS_OFFLINE_VENDOR_CANARY_REQUIRED' : 'FAIL',
  results,
};
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${summary.passed}/${summary.total} AI Agent TUI checks passed`);
console.log(`Wrote ${OUTPUT}`);
const exitCode = failures.length ? 1 : 0;
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(exitCode);
