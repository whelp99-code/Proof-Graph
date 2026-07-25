import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../runtime/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class Client {
  async start(env) {
    this.child = spawn(process.execPath, [path.join(ROOT, 'runtime/mcp/server.mjs')], { cwd: env.PROOFGRAPH_PROJECT_DIR, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iter = this.reader[Symbol.asyncIterator](); this.seq = 0; this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    return this;
  }
  async request(method, params = {}) {
    const id = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await Promise.race([this.iter.next(), new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP timeout: ${this.stderr}`)), 5000))]);
    return JSON.parse(next.value);
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async close() { this.child.stdin.end(); await new Promise((resolve) => this.child.once('exit', resolve)); this.reader.close(); }
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-platform-mcp-'));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const client = await new Client().start({ PROOFGRAPH_PROJECT_DIR: project, PROOFGRAPH_DATA_DIR: path.join(root, 'data') });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, client };
}

async function initialize(client) {
  const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: VERSION } });
  client.notify('notifications/initialized');
  return init;
}

test('universal MCP initializes as proofgraph and exposes the platform surface', async (t) => {
  const { client } = await setup(t);
  assert.equal((await client.request('tools/list')).error.code, -32002);
  const init = await initialize(client);
  assert.equal(init.result.serverInfo.name, 'proofgraph');
  assert.equal(init.result.serverInfo.version, VERSION);
  const listed = await client.request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  for (const required of ['proofgraph_compile', 'proofgraph_graph_validate', 'proofgraph_graph_start', 'proofgraph_graph_run', 'proofgraph_run', 'proofgraph_status', 'proofgraph_templates', 'proofgraph_debug', 'proofgraph_inspect']) assert.ok(names.includes(required));
  assert.equal(new Set(names).size, names.length);
});

test('universal MCP compiles a template and executes a verified mock graph', async (t) => {
  const { client } = await setup(t); await initialize(client);
  const compiled = await client.request('tools/call', { name: 'proofgraph_compile', arguments: { template: 'bugfix', objective: 'Fix an authorization regression without changing public API behavior' } });
  assert.equal(compiled.result.isError, false);
  assert.equal(compiled.result.structuredContent.template.name, 'bugfix');
  const executed = await client.request('tools/call', { name: 'proofgraph_run', arguments: { objective: 'Explain a deterministic invariant in this codebase' } });
  assert.equal(executed.result.isError, false);
  const run = executed.result.structuredContent;
  assert.equal(run.status, 'finalized');
  const status = await client.request('tools/call', { name: 'proofgraph_status', arguments: { run_id: run.run_id } });
  assert.equal(status.result.structuredContent.quality_gate_passed, true);
});

test('universal MCP auto-matches the agent-tui template', async (t) => {
  const { client } = await setup(t); await initialize(client);
  const compiled = await client.request('tools/call', {
    name: 'proofgraph_compile',
    arguments: { objective: 'AI 에이전트 TUI를 개발하라' },
  });
  assert.equal(compiled.result.isError, false);
  const result = compiled.result.structuredContent;
  assert.equal(result.template.name, 'agent-tui');
  assert.equal(result.template.selection, 'auto');
  assert.equal(result.assessment.profile.template_name, 'agent-tui');
});

test('universal MCP rejects prototype-pollution keys and unknown tools without exiting', async (t) => {
  const { client } = await setup(t); await initialize(client);
  const id = ++client.seq;
  client.child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"proofgraph_compile","arguments":{"objective":"Compile this sufficiently long objective","__proto__":{"polluted":true}}}}\n`);
  const response = JSON.parse((await client.iter.next()).value);
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error.message, /Forbidden JSON key/);
  const unknown = await client.request('tools/call', { name: 'proofgraph_delete_everything', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  assert.equal((await client.request('ping')).result && true, true);
});


test('universal MCP validates and runs a reviewed explicit AI Agent TUI GraphSpec', async (t) => {
  const { client } = await setup(t); await initialize(client);
  const graph = JSON.parse(await fs.readFile(path.join(ROOT, 'examples/graphs/ai-agent-tui.graph.json'), 'utf8'));
  const validated = await client.request('tools/call', {
    name: 'proofgraph_graph_validate',
    arguments: { graph },
  });
  assert.equal(validated.result.isError, false);
  assert.equal(validated.result.structuredContent.validation.node_count, 14);
  assert.equal(validated.result.structuredContent.validation.edge_count, 38);
  const executed = await client.request('tools/call', {
    name: 'proofgraph_graph_run',
    arguments: { graph, adapter: 'mock' },
  });
  assert.equal(executed.result.isError, false);
  assert.equal(executed.result.structuredContent.status, 'finalized');
  assert.equal(executed.result.structuredContent.report.report.terminal_status, 'success');
  assert.equal(executed.result.structuredContent.integrity.ok, true);
});
