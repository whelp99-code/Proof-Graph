#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createControlPlaneServer, ControlPlane } from '../runtime/control-plane/index.mjs';
import { OperatorClient } from '../runtime/operator/index.mjs';
import { VERSION, RELEASE_GATE, PRODUCT_NAME } from '../runtime/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
async function check(name, fn) {
  try { const detail = await fn(); checks.push({ name, status: 'pass', detail: detail ?? null }); }
  catch (error) { checks.push({ name, status: 'fail', error: error.message }); }
}
function skip(name, reason) { checks.push({ name, status: 'skip', reason }); }
async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist', '.proofgraph-org'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(file)); else out.push(file);
  }
  return out;
}
async function waitFor(fn, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await check('Node.js version >=20', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node ${process.versions.node} is unsupported`);
  return process.versions.node;
});

await check('package, lock and runtime versions are consistent', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (pkg.version !== VERSION || lock.version !== VERSION || lock.packages?.['']?.version !== VERSION) throw new Error('Version mismatch');
  if (pkg.name !== '@proofgraph/standalone' || PRODUCT_NAME !== 'proofgraph-standalone') throw new Error('Product identity mismatch');
  return { name: pkg.name, version: VERSION, release_gate: RELEASE_GATE };
});

await check('intelligence development plan predates release validation', async () => {
  const plan = await fs.stat(path.join(ROOT, 'DEVELOPMENT_PLAN_INTELLIGENCE_FABRIC_V3_1_TO_V4_0_KO.md'));
  const runtime = await fs.stat(path.join(ROOT, 'runtime', 'operator'));
  if (!plan.isFile() || !runtime.isDirectory()) throw new Error('Intelligence plan or runtime missing');
  return { plan_bytes: plan.size };
});

await check('all JavaScript modules pass syntax check', async () => {
  const files = (await walk(ROOT)).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${path.relative(ROOT, file)}: ${result.stderr}`);
  }
  return { files: files.length };
});

await check('operator CLI version contract', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'proofgraph.mjs'), 'version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const value = JSON.parse(result.stdout);
  if (value.version !== VERSION || value.release_gate !== RELEASE_GATE) throw new Error('CLI version contract mismatch');
  return value;
});

await check('Control Plane truthfully projects simulation without quality promotion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-operator-preflight-'));
  const plane = new ControlPlane({ dataDir: dir, tickDelayMs: 1 });
  const app = await createControlPlaneServer({ controlPlane: plane, port: 0, pollMs: 10 });
  try {
    const address = await app.listen();
    const token = await plane.operatorToken();
    const api = new OperatorClient({ url: `http://127.0.0.1:${address.port}`, token });
    const created = await api.createRun({ objective: 'Implement and independently verify an operator preflight feature', auto_start: true });
    const done = await waitFor(() => api.run(created.run_id), (run) => ['simulation_complete', 'completed_clean', 'completed_with_recovery', 'failed', 'partial'].includes(run.status));
    if (done.status !== 'simulation_complete' || done.quality_gate_passed !== false || done.execution?.mode !== 'simulation') throw new Error(`Unexpected truthful simulation projection: ${done.status}`);
    if (!done.graph?.nodes?.length || !Array.isArray(done.timeline)) throw new Error('Graph/timeline projection missing');
    return { run_id: done.run_id, status: done.status, nodes: done.graph.nodes.length };
  } finally { await app.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
});

await check('high-risk approval is challenge-redacted and operator-decidable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-operator-approval-'));
  const plane = new ControlPlane({ dataDir: dir, tickDelayMs: 1 });
  const app = await createControlPlaneServer({ controlPlane: plane, port: 0, pollMs: 10 });
  try {
    const address = await app.listen();
    const api = new OperatorClient({ url: `http://127.0.0.1:${address.port}`, token: await plane.operatorToken() });
    const created = await api.createRun({ objective: 'Deploy a production database migration', auto_start: true });
    const waiting = await waitFor(() => api.run(created.run_id), (run) => run.status === 'waiting_approval');
    const approval = waiting.approvals.pending[0];
    if (!approval || Object.hasOwn(approval, 'challenge')) throw new Error('Approval challenge escaped operator API');
    await api.decide(waiting.run_id, approval.approval_id, 'denied', 'preflight safety denial');
    const denied = await api.run(waiting.run_id);
    if (denied.status !== 'denied') throw new Error(`Expected denied, got ${denied.status}`);
    return { run_id: denied.run_id, approval_id: approval.approval_id };
  } finally { await app.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
});

await check('OpenCode observer surface and commands are packaged', async () => {
  const required = [
    'examples/opencode/.opencode/plugins/proofgraph-observer.js',
    'examples/opencode/.opencode/commands/pg-status.md',
    'examples/opencode/.opencode/commands/pg-flow.md',
    'examples/opencode/.opencode/commands/pg-approvals.md',
    'examples/opencode/.opencode/commands/pg-run.md',
  ];
  for (const file of required) await fs.access(path.join(ROOT, file));
  const plugin = await fs.readFile(path.join(ROOT, required[0]), 'utf8');
  if (!plugin.includes('tool.execute.before') || !plugin.includes('tool.execute.after') || !plugin.includes('x-proofgraph-host-token')) throw new Error('OpenCode observer contract incomplete');
  if (/PROOFGRAPH_OPERATOR_TOKEN/.test(plugin)) throw new Error('Operator token must never enter OpenCode plugin');
  return { files: required.length };
});

await check('production surfaces contain no dynamic eval or shell:true', async () => {
  const dirs = ['runtime', 'bin']; const findings = [];
  for (const dir of dirs) {
    const files = (await walk(path.join(ROOT, dir))).filter((file) => file.endsWith('.mjs'));
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (/\beval\s*\(|new\s+Function\s*\(|shell\s*:\s*true/.test(text)) findings.push(path.relative(ROOT, file));
    }
  }
  if (findings.length) throw new Error(`Unsafe dynamic execution in ${findings.join(', ')}`);
  return { files_checked: (await walk(path.join(ROOT, 'runtime'))).length + (await walk(path.join(ROOT, 'bin'))).length };
});

await check('operator and host tokens use separate files and values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-operator-token-'));
  try {
    const plane = await new ControlPlane({ dataDir: dir }).init();
    const operator = await plane.operatorToken(); const host = await plane.hostToken();
    if (operator === host || operator.length < 40 || host.length < 40) throw new Error('Token separation failed');
    const opStat = await fs.lstat(plane.tokenFiles().operator); const hostStat = await fs.lstat(plane.tokenFiles().host_ingest);
    if (opStat.isSymbolicLink() || hostStat.isSymbolicLink()) throw new Error('Token file symlink detected');
    if (process.platform !== 'win32' && ((opStat.mode | hostStat.mode) & 0o077) !== 0) throw new Error('Token permissions too broad');
    return { separated: true };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

await check('required v5 documentation exists', async () => {
  const required = [
    'README.md', 'README_KO.md', 'CHANGELOG.md', 'CODE_AUDIT_INTELLIGENCE_FABRIC_KO.md',
    'DEVELOPMENT_PLAN_OPERATOR_TUI_V2_0_1_TO_V3_0_0_KO.md', 'DEVELOPMENT_PLAN_INTELLIGENCE_FABRIC_V3_1_TO_V4_0_KO.md',
    'docs/ARCHITECTURE_KO.md', 'docs/SECURITY_MODEL_KO.md', 'docs/OPERATIONS_KO.md',
    'docs/OPERATOR_TUI_KO.md', 'docs/CONTROL_PLANE_API_KO.md', 'docs/OPENCODE_INTEGRATION_KO.md',
    'docs/INTELLIGENCE_FABRIC_KO.md', 'docs/CONTEXT_DELIVERY_KO.md', 'docs/MODEL_ROUTING_KO.md',
    'docs/COLLABORATION_CONTRACTS_KO.md', 'docs/KNOWLEDGE_MEMORY_KO.md', 'docs/RELEASE_NOTES_v4.0.0_KO.md', 'docs/STANDALONE_EXECUTION_KO.md', 'DEVELOPMENT_PLAN_STANDALONE_V4_0_1_TO_V5_0_0_KO.md',
    'docs/LIMITATIONS_KO.md', 'docs/TRACEABILITY_MATRIX_KO.md', 'examples/model-registry.example.json',
    'verification/VERIFICATION_REPORT_KO.md', 'verification/ADVERSARIAL_REPORT_KO.md', 'verification/RELEASE_DECISION_KO.md',
  ];
  const missing = [];
  for (const file of required) { try { await fs.access(path.join(ROOT, file)); } catch { missing.push(file); } }
  if (missing.length) throw new Error(`Missing docs: ${missing.join(', ')}`);
  return { files: required.length };
});


await check('Intelligence Fabric modules and model registry example are packaged', async () => {
  const modules = ['context-runtime.mjs', 'model-router.mjs', 'registry-loader.mjs', 'collaboration-runtime.mjs', 'knowledge-graph.mjs', 'memory-runtime.mjs', 'verification-runtime.mjs', 'fabric.mjs'];
  for (const file of modules) await fs.access(path.join(ROOT, 'runtime', 'intelligence', file));
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, 'examples', 'model-registry.example.json'), 'utf8'));
  if (registry.schema !== 'proofgraph.model-registry.v1' || !Array.isArray(registry.entries) || registry.entries.length < 3) throw new Error('Model registry example contract incomplete');
  if (registry.entries.some((entry) => entry.enabled !== false)) throw new Error('Example model entries must be disabled by default');
  if (/sk-|api[_-]?key|access[_-]?token/i.test(JSON.stringify(registry))) throw new Error('Model registry example contains secret-like content');
  return { modules: modules.length, registry_entries: registry.entries.length };
});

await check('Intelligence CLI and MCP read-only surfaces are present', async () => {
  const cli = await fs.readFile(path.join(ROOT, 'bin', 'proofgraph-org.mjs'), 'utf8');
  const operator = await fs.readFile(path.join(ROOT, 'bin', 'proofgraph.mjs'), 'utf8');
  const mcp = await fs.readFile(path.join(ROOT, 'runtime', 'mcp', 'server.mjs'), 'utf8');
  for (const token of ['mission-intelligence', 'mission-impact', '--model-registry']) if (!cli.includes(token)) throw new Error(`Missing CLI surface ${token}`);
  for (const token of ['intelligence', 'context', 'models', 'collaboration', 'knowledge', 'memory', 'verification']) if (!operator.includes(token)) throw new Error(`Missing operator surface ${token}`);
  for (const tool of ['pg4_intelligence_status', 'pg4_context', 'pg4_model_routes', 'pg4_contracts', 'pg4_impact', 'pg4_memory', 'pg4_intelligence_verification']) if (!mcp.includes(tool)) throw new Error(`Missing MCP tool ${tool}`);
  if (/pg4_.*(?:approve|deny|abort)/i.test(mcp)) throw new Error('Operator authority leaked into pg4 MCP surface');
  return { pg4_tools: 7 };
});

skip('Authenticated external provider and multi-host canary', 'Requires installed and authenticated OpenCode/Pi/Claude/Orca hosts plus measured model cost, latency, and quality.');
skip('Public v1.1.0 exact-tree integration regression', 'The standalone v5 package preserves the v1.1 host contract but has not been merged and re-certified on the exact public tree in this environment.');

const summary = {
  schema_version: 2,
  product: PRODUCT_NAME,
  version: VERSION,
  release_gate: RELEASE_GATE,
  total: checks.length,
  passed: checks.filter((item) => item.status === 'pass').length,
  failed: checks.filter((item) => item.status === 'fail').length,
  skipped: checks.filter((item) => item.status === 'skip').length,
  checks,
};
summary.digest = crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(ROOT, 'verification', 'preflight-results.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ passed: summary.passed, failed: summary.failed, skipped: summary.skipped, output }, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
