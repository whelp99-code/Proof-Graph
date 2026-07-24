#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
const checks = [];

function add(name, ok, details = {}) { checks.push({ name, ok, ...details }); }
async function exists(rel) { try { await fs.access(path.join(ROOT, rel)); return true; } catch { return false; } }
async function json(rel) { return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8')); }
function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) data[match[1]] = match[2].trim();
  }
  return data;
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

class Client {
  async start(env) {
    this.child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iter = this.reader[Symbol.asyncIterator]();
    this.seq = 0; this.stderr = '';
    this.child.stderr.on('data', c => { this.stderr += c.toString(); });
    return this;
  }
  async request(method, params = {}) {
    const id = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await Promise.race([
      this.iter.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP response timeout')), 5000)),
    ]);
    if (next.done) throw new Error(`MCP server closed: ${this.stderr}`);
    const msg = JSON.parse(next.value);
    if (msg.id !== id) throw new Error(`Unexpected response id ${msg.id}`);
    return msg;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await Promise.race([new Promise(r => this.child.once('exit', r)), new Promise(r => setTimeout(() => { this.child.kill('SIGKILL'); r(); }, 1500))]);
    this.reader.close();
  }
}

try {
  const [manifest, pkg, mcp, hooks] = await Promise.all([
    json('.claude-plugin/plugin.json'), json('package.json'), json('.mcp.json'), json('hooks/hooks.json'),
  ]);
  add('node_version', Number(process.versions.node.split('.')[0]) >= 20, { actual: process.versions.node, required: '>=20' });
  add('version_alignment', manifest.version === pkg.version, { plugin: manifest.version, package: pkg.version });
  add('plugin_name', manifest.name === 'proofgraph-claude', { actual: manifest.name });
  const componentPaths = [manifest.skills, manifest.hooks, manifest.mcpServers, ...(manifest.agents ?? [])].filter(Boolean).map(v => String(v).replace(/^\.\//, ''));
  const missing = [];
  for (const rel of componentPaths) if (!await exists(rel)) missing.push(rel);
  add('component_paths', missing.length === 0, { checked: componentPaths, missing });
  const server = mcp?.mcpServers?.proofgraph;
  add('mcp_configuration', server?.type === 'stdio' && server?.command === 'node' && server?.args?.[0]?.includes('${CLAUDE_PLUGIN_ROOT}/server/index.mjs') && server?.env?.PROOFGRAPH_TEST_MODE === '0', { server });
  const hookEvents = Object.keys(hooks?.hooks ?? {});
  add('hook_surface', ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].every(x => hookEvents.includes(x)), { events: hookEvents });
  const componentFailures = [];
  const skillFm = frontmatter(await fs.readFile(path.join(ROOT, 'skills/research/SKILL.md'), 'utf8'));
  if (!skillFm || skillFm.name !== 'research' || skillFm['disable-model-invocation'] !== 'true' || !skillFm['allowed-tools'] || !skillFm['disallowed-tools']) {
    componentFailures.push({ file: 'skills/research/SKILL.md', frontmatter: skillFm });
  }
  for (const expected of ['planner', 'researcher', 'verifier', 'synthesizer']) {
    const rel = `agents/${expected}.md`;
    const fm = frontmatter(await fs.readFile(path.join(ROOT, rel), 'utf8'));
    if (!fm || fm.name !== expected || !fm.tools || !fm.description) componentFailures.push({ file: rel, frontmatter: fm });
  }
  add('component_frontmatter', componentFailures.length === 0, { failures: componentFailures });

  const files = await walk(ROOT);
  const mjs = files.filter(f => f.endsWith('.mjs'));
  const syntaxFailures = [];
  for (const file of mjs) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) syntaxFailures.push({ file: path.relative(ROOT, file), error: r.stderr.trim() });
  }
  add('javascript_syntax', syntaxFailures.length === 0, { files_checked: mjs.length, failures: syntaxFailures });

  const importFailures = [];
  for (const file of mjs) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      const spec = match[2];
      if (!(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'))) importFailures.push({ file: path.relative(ROOT, file), specifier: spec });
    }
  }
  add('no_external_runtime_imports', importFailures.length === 0 && !pkg.dependencies, { failures: importFailures, dependencies: pkg.dependencies ?? null });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-preflight-'));
  const client = await new Client().start({ PROOFGRAPH_DATA_DIR: path.join(tmp, 'data'), PROOFGRAPH_PROJECT_DIR: path.join(tmp, 'project'), PROOFGRAPH_TEST_MODE: '0' });
  try {
    const before = await client.request('tools/list');
    add('mcp_requires_initialize', before.error?.code === -32002, { response: before.error ?? before.result });
    const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'preflight', version: pkg.version } });
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    const names = listed.result?.tools?.map(t => t.name) ?? [];
    add('mcp_initialize', init.result?.serverInfo?.name === 'proofgraph-claude' && init.result?.protocolVersion === '2025-11-25', { result: init.result });
    add('mcp_tool_surface', names.length === 14 && !names.includes('pg_test_import_source') && new Set(names).size === names.length, { count: names.length, names });
    add('mcp_tool_schemas', (listed.result?.tools ?? []).every(t => t.inputSchema?.type === 'object' && t.outputSchema?.type === 'object'), {});
  } finally { await client.close(); await fs.rm(tmp, { recursive: true, force: true }); }

  const hook = spawnSync(process.execPath, [path.join(ROOT, 'hooks/guard.mjs')], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify({ cwd: path.join(os.tmpdir(), 'proofgraph-no-run'), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    env: { ...process.env, PROOFGRAPH_DATA_DIR: path.join(os.tmpdir(), `pg-empty-${process.pid}`), PROOFGRAPH_PROJECT_DIR: path.join(os.tmpdir(), 'proofgraph-no-run') },
  });
  add('hook_no_active_run_is_silent', hook.status === 0 && hook.stdout.trim() === '', { status: hook.status, stdout: hook.stdout.trim(), stderr: hook.stderr.trim() });

  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claudeVersion.error?.code === 'ENOENT') add('claude_cli_plugin_validation', true, { skipped: true, reason: 'claude CLI is not installed in this verification environment' });
  else {
    const validation = spawnSync('claude', ['plugin', 'validate', ROOT, '--strict'], { encoding: 'utf8', timeout: 30000 });
    add('claude_cli_plugin_validation', validation.status === 0, { skipped: false, version: claudeVersion.stdout.trim(), stdout: validation.stdout.trim(), stderr: validation.stderr.trim() });
  }
} catch (error) {
  add('preflight_internal', false, { error: error.stack || error.message });
}

const result = {
  product: 'proofgraph-claude', version: '0.2.0', generated_at: new Date().toISOString(), root: ROOT,
  node: process.version, platform: `${process.platform}-${process.arch}`,
  passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length,
  checks,
};
if (outputPath) { await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`); }
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.skipped ? ' (SKIPPED)' : ''}`);
console.log(`\n${result.passed}/${checks.length} checks passed`);
if (result.failed) process.exitCode = 1;
