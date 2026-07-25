#!/usr/bin/env node
/**
 * Independent black-box verifier for the current ProofGraph release.
 * It imports no ProofGraph production module and interacts only through the
 * public CLI, universal stdio MCP server, Git, and persisted artifacts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const CLI = path.join(ROOT, 'bin', 'proofgraph.mjs');
const OUTPUT = process.argv.includes('--output')
  ? path.resolve(process.argv[process.argv.indexOf('--output') + 1])
  : path.join(ROOT, 'verification', 'platform_independent_results.json');
const results = [];

function assert(condition, message, details = undefined) {
  if (!condition) { const error = new Error(message); error.details = details; throw error; }
}
async function temporary(prefix = 'proofgraph-platform-independent-') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(base, 'project');
  const data = path.join(base, 'data');
  const home = path.join(base, 'home');
  await Promise.all([fs.mkdir(project), fs.mkdir(data), fs.mkdir(home)]);
  return { base, project, data, home };
}
async function cleanup(ctx) { await fs.rm(ctx.base, { recursive: true, force: true }); }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 20_000_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}
function cli(args, ctx, options = {}) {
  return run(process.execPath, [CLI, ...args], { cwd: ctx?.project ?? ROOT, env: ctx ? { HOME: ctx.home, PROOFGRAPH_DATA_DIR: ctx.data } : {}, ...options });
}
function jsonOutput(result, label) {
  assert(result.code === 0, `${label} failed`, result);
  try { return JSON.parse(result.stdout); } catch { throw Object.assign(new Error(`${label} returned invalid JSON`), { details: result }); }
}
function git(ctx, args) {
  const result = run('git', args, { cwd: ctx.project, env: { HOME: ctx.home } });
  assert(result.code === 0, `git ${args.join(' ')} failed`, result);
  return result;
}

class McpClient {
  constructor(ctx) { this.ctx = ctx; this.id = 0; }
  async start() {
    this.child = spawn(process.execPath, [path.join(ROOT, 'runtime/mcp/server.mjs')], {
      cwd: this.ctx.project,
      env: { ...process.env, HOME: this.ctx.home, PROOFGRAPH_PROJECT_DIR: this.ctx.project, PROOFGRAPH_DATA_DIR: this.ctx.data },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iter = this.reader[Symbol.asyncIterator](); this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    return this;
  }
  async next(timeout = 8000) {
    const item = await Promise.race([this.iter.next(), new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP timeout: ${this.stderr}`)), timeout))]);
    if (item.done) throw new Error(`MCP server exited: ${this.stderr}`);
    return JSON.parse(item.value);
  }
  async request(method, params = {}) {
    const id = ++this.id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await this.next();
    assert(message.id === id, 'Unexpected MCP response id', { expected: id, actual: message.id });
    return message;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async initialize() {
    const message = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'platform-independent', version: VERSION } });
    this.notify('notifications/initialized'); return message;
  }
  async call(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  async ok(name, args = {}) {
    const message = await this.call(name, args);
    assert(!message.error && message.result?.isError !== true, `${name} failed`, message.error ?? message.result?.structuredContent);
    return message.result.structuredContent;
  }
  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await Promise.race([new Promise((resolve) => this.child.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500))]);
    this.reader.close();
  }
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

await runCase('release metadata, package, and Claude adapter versions are aligned', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  assert(PACKAGE.name === 'proofgraph', 'Unexpected package name', PACKAGE);
  assert(/^1\.1\.0$/.test(PACKAGE.version) && manifest.version === PACKAGE.version, 'Version alignment failed', { package: PACKAGE.version, plugin: manifest.version });
  return { package: PACKAGE.name, version: PACKAGE.version, claude_plugin: manifest.name };
});

await runCase('CLI initializes a project without overwriting existing configuration', async () => {
  const ctx = await temporary();
  try {
    const first = jsonOutput(cli(['init', ctx.project], ctx), 'proofgraph init');
    assert(first.ok && first.replaced === false, 'Unexpected init result', first);
    const second = cli(['init', ctx.project], ctx);
    assert(second.code !== 0 && /already exists/.test(second.stderr), 'Second init did not fail closed', second);
    const config = JSON.parse(await fs.readFile(path.join(ctx.project, 'proofgraph.config.json'), 'utf8'));
    return { data_dir: config.data_dir, default_adapter: config.default_adapter };
  } finally { await cleanup(ctx); }
});

await runCase('built-in templates compile to verified graph paths', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const templates = jsonOutput(cli(['templates', '--project', ctx.project], ctx), 'templates');
    assert(templates.length === 7 && templates.some((item) => item.name === 'agent-tui'), 'Unexpected template count', templates);
    const compiled = jsonOutput(cli(['compile', 'Implement an audited authorization feature without bypassing tests', '--template', 'feature', '--project', ctx.project], ctx), 'compile');
    const successIncoming = compiled.graph.edges.filter((edge) => edge.to === 'terminal-success');
    assert(successIncoming.length === 1 && successIncoming[0].from === 'synthesize', 'Success path bypassed synthesis', successIncoming);
    assert(compiled.graph.nodes.some((node) => node.kind === 'verify'), 'Verifier missing');
    return { templates: templates.map((item) => item.name), graph_digest: compiled.graph_digest };
  } finally { await cleanup(ctx); }
});

await runCase('safe mock adapter completes a graph and passes integrity', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const executed = jsonOutput(cli(['run', 'Explain one deterministic invariant in this repository', '--project', ctx.project], ctx), 'run');
    assert(executed.status === 'finalized', 'Graph did not finalize', executed);
    assert(executed.report?.report?.quality_gate_passed === true, 'Quality gate failed', executed.report);
    assert(executed.integrity?.ok === true, 'Integrity failed', executed.integrity);
    return { run_id: executed.run_id, terminal_status: executed.report.report.terminal_status };
  } finally { await cleanup(ctx); }
});

await runCase('CLI breakpoint pauses before invocation and one-shot bypass resumes execution', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const started = jsonOutput(cli(['start', 'Explain one deterministic invariant in this repository', '--project', ctx.project], ctx), 'start');
    jsonOutput(cli(['debug', 'break', started.run_id, 'kind', 'direct', '--project', ctx.project], ctx), 'debug break');
    const paused = jsonOutput(cli(['resume', started.run_id, '--project', ctx.project], ctx), 'resume pause');
    assert(paused.status === 'paused', 'Breakpoint did not pause', paused);
    const nodeId = paused.status_snapshot.ready_nodes[0].node_id;
    jsonOutput(cli(['debug', 'bypass', started.run_id, nodeId, '--project', ctx.project], ctx), 'debug bypass');
    const finished = jsonOutput(cli(['resume', started.run_id, '--project', ctx.project], ctx), 'resume finish');
    assert(finished.status === 'finalized', 'Graph did not finish after bypass', finished);
    return { run_id: started.run_id, breakpoint_node: nodeId };
  } finally { await cleanup(ctx); }
});

await runCase('all non-mock vendor adapters require explicit configuration and live canary', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const adapters = jsonOutput(cli(['adapters', '--project', ctx.project], ctx), 'adapters');
    const nonMock = adapters.filter((item) => item.name !== 'mock');
    assert(nonMock.length >= 6, 'Expected vendor adapters', adapters);
    assert(nonMock.every((item) => item.status !== 'ready'), 'A vendor adapter was ready by default', nonMock);
    return nonMock.map((item) => ({ name: item.name, status: item.status, live_canary_required: item.live_canary_required }));
  } finally { await cleanup(ctx); }
});

await runCase('universal MCP exposes compile, runtime, debugger, template, and workspace tools', async () => {
  const ctx = await temporary(); const client = await new McpClient(ctx).start();
  try {
    const early = await client.request('tools/list'); assert(early.error?.code === -32002, 'MCP tools available before initialize', early);
    const init = await client.initialize();
    assert(init.result.serverInfo.name === 'proofgraph' && init.result.serverInfo.version === VERSION, 'Unexpected universal MCP identity', init.result.serverInfo);
    const listed = await client.request('tools/list'); const names = listed.result.tools.map((item) => item.name);
    for (const required of ['proofgraph_compile', 'proofgraph_graph_validate', 'proofgraph_graph_start', 'proofgraph_graph_run', 'proofgraph_start', 'proofgraph_run', 'proofgraph_debug', 'proofgraph_inspect', 'proofgraph_templates', 'proofgraph_workspace_propose']) assert(names.includes(required), `Missing ${required}`, names);
    return { protocol: init.result.protocolVersion, tool_count: names.length };
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('universal MCP survives malformed and prototype-pollution requests', async () => {
  const ctx = await temporary(); const client = await new McpClient(ctx).start();
  try {
    await client.initialize();
    const id = ++client.id;
    client.child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"proofgraph_compile","arguments":{"objective":"Compile this sufficiently detailed objective","__proto__":{"polluted":true}}}}\n`);
    const polluted = await client.next();
    assert(polluted.result?.isError === true && /Forbidden JSON key/.test(polluted.result.structuredContent.error.message), 'Prototype key was not rejected', polluted);
    const unknown = await client.call('proofgraph_destroy', {});
    assert(unknown.error?.code === -32602, 'Unknown tool was not rejected', unknown);
    const ping = await client.request('ping'); assert(ping.result && !ping.error, 'MCP process did not survive invalid input');
  } finally { await client.close(); await cleanup(ctx); }
});

await runCase('workspace changes require challenge-bound approval and remain rollbackable', async () => {
  const ctx = await temporary();
  try {
    jsonOutput(cli(['init', ctx.project], ctx), 'init');
    const configPath = path.join(ctx.project, 'proofgraph.config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.workspace.enabled = true; config.workspace.root = path.join(ctx.base, 'worktrees');
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    git(ctx, ['init']); git(ctx, ['config', 'user.email', 'verify@example.invalid']); git(ctx, ['config', 'user.name', 'Verifier']); git(ctx, ['add', '.']); git(ctx, ['commit', '-m', 'baseline']);
    const started = jsonOutput(cli(['start', 'Prepare a reversible implementation artifact for workspace verification', '--project', ctx.project], ctx), 'start');
    jsonOutput(cli(['workspace', 'create', started.run_id, '--project', ctx.project], ctx), 'workspace create');
    const actionFile = path.join(ctx.base, 'actions.json');
    await fs.writeFile(actionFile, JSON.stringify([{ type: 'write_file', path: 'generated.txt', content: 'verified workspace action\n' }]));
    const proposed = jsonOutput(cli(['workspace', 'propose', started.run_id, actionFile, '--project', ctx.project], ctx), 'workspace propose');
    const premature = cli(['workspace', 'execute', started.run_id, '--project', ctx.project], ctx);
    assert(premature.code !== 0 && /not approved/.test(premature.stderr), 'Workspace executed without approval', premature);
    jsonOutput(cli(['workspace', 'approve', started.run_id, proposed.challenge, 'approve', '--project', ctx.project], ctx), 'workspace approve');
    const executed = jsonOutput(cli(['workspace', 'execute', started.run_id, '--project', ctx.project], ctx), 'workspace execute');
    assert(executed.receipt.status === 'executed', 'Workspace receipt not executed', executed);
    const diff = cli(['workspace', 'diff', started.run_id, '--project', ctx.project], ctx);
    assert(diff.code === 0 && /generated\.txt/.test(diff.stdout), 'Workspace diff missing file', diff);
    jsonOutput(cli(['workspace', 'rollback', started.run_id, '--project', ctx.project], ctx), 'workspace rollback');
    return { run_id: started.run_id, receipt_digest: executed.receipt.receipt_digest };
  } finally { await cleanup(ctx); }
});

await runCase('git worktree isolation does not claim network isolation', async () => ({
  impact: 'Workspace Engine isolates files with a disposable Git worktree, but network isolation requires an external container or sandbox policy.',
}), { residual: true });

const failures = results.filter((item) => item.status === 'FAIL');
const residuals = results.filter((item) => item.residual);
const summary = {
  schema_version: 1,
  product: 'proofgraph',
  version: VERSION,
  generated_at: new Date().toISOString(),
  verifier_type: 'black-box-cli-stdio-mcp-git-and-persisted-artifacts',
  production_modules_imported: false,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  residuals_confirmed: residuals.length,
  release_gate: failures.length === 0 ? 'PASS_OFFLINE_VENDOR_CANARY_REQUIRED' : 'FAIL',
  results,
};
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${summary.passed}/${summary.total} platform checks passed; residuals: ${summary.residuals_confirmed}`);
console.log(`Wrote ${OUTPUT}`);
const exitCode = failures.length ? 1 : 0;
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(exitCode);
