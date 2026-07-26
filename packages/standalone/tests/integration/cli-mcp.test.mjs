import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, cleanup } from '../helpers.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin', 'proofgraph-org.mjs');
const MCP = path.join(ROOT, 'runtime', 'mcp', 'server.mjs');

test('CLI reports version and compiles TaskSpec', async () => {
  const version = JSON.parse((await exec(process.execPath, [CLI, 'version'])).stdout);
  assert.equal(version.version, '5.0.0');
  const task = JSON.parse((await exec(process.execPath, [CLI, 'task', 'Implement and verify a bounded feature'])).stdout);
  assert.equal(task.schema_version, 1);
  assert.equal(task.requires_implementation, true);
  assert.equal(task.adequacy.adequate, true);
});

test('CLI mission run persists a verified result', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const result = JSON.parse((await exec(process.execPath, [CLI, 'mission-run', 'Implement and verify a small feature', '--data-dir', dir])).stdout);
  assert.equal(result.status, 'completed');
  const report = JSON.parse((await exec(process.execPath, [CLI, 'mission-report', result.mission.mission_id, '--data-dir', dir])).stdout);
  assert.equal(report.quality_gate_passed, true);
  assert.ok(report.artifacts.length > 0);
});

test('CLI high-risk Mission resumes after external approval', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  let state = JSON.parse((await exec(process.execPath, [CLI, 'mission-run', 'Deploy a production migration', '--data-dir', dir])).stdout);
  assert.equal(state.status, 'waiting_approval');
  const approval = state.approvals.find((item) => item.status === 'pending');
  await exec(process.execPath, [CLI, 'mission-approve', state.mission.mission_id, approval.approval_id, approval.challenge, 'approved', '--data-dir', dir]);
  state = JSON.parse((await exec(process.execPath, [CLI, 'mission-resume', state.mission.mission_id, '--data-dir', dir])).stdout);
  assert.equal(state.status, 'completed');
  assert.equal(state.quality_gate_passed, true);
});

class RpcClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.pending = new Map(); this.stderr = '';
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      const entry = this.pending.get(message.id);
      if (entry) { this.pending.delete(message.id); entry.resolve(message); }
    });
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
  }
  request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}; ${this.stderr}`)); }, 5000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async close() { this.child.stdin.end(); if (!this.child.killed) this.child.kill('SIGTERM'); }
}

async function mcpClient(t) {
  const dir = await tempDir();
  const child = spawn(process.execPath, [MCP], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ORG_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new RpcClient(child);
  t.after(async () => { await client.close(); await cleanup(dir); });
  const initialized = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.version, '5.0.0');
  client.notify('notifications/initialized');
  return client;
}

test('MCP exposes bounded organization tools but no model-callable approval tool', async (t) => {
  const client = await mcpClient(t);
  const listed = await client.request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('pg2_compile_task'));
  assert.ok(names.includes('pg2_run_os'));
  assert.equal(names.some((name) => /approve|deny|abort/i.test(name)), false);
});

test('MCP compiles TaskSpec and runs a persistent mission', async (t) => {
  const client = await mcpClient(t);
  const compiled = await client.request('tools/call', { name: 'pg2_compile_task', arguments: { objective: 'Research and verify organization runtimes' } });
  assert.equal(compiled.result.isError, false);
  assert.equal(compiled.result.structuredContent.adequacy.adequate, true);
  const created = await client.request('tools/call', { name: 'pg2_create_mission', arguments: { objective: 'Implement and verify a bounded feature' } });
  const missionId = created.result.structuredContent.mission.mission_id;
  const run = await client.request('tools/call', { name: 'pg2_run_mission', arguments: { mission_id: missionId } });
  assert.equal(run.result.structuredContent.status, 'completed');
  const integrity = await client.request('tools/call', { name: 'pg2_verify_integrity', arguments: { kind: 'mission', id: missionId } });
  assert.equal(integrity.result.structuredContent.ok, true);
});

test('MCP rejects unknown fields and unknown tools without mutating state', async (t) => {
  const client = await mcpClient(t);
  const bad = await client.request('tools/call', { name: 'pg2_compile_task', arguments: { objective: 'Do work', arbitrary_graph: { bypass: true } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Unknown tool arguments/);
  const unknown = await client.request('tools/call', { name: 'pg2_apply_policy', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /Unknown tool/);
});


test('CLI external delivery requires persisted operator approval', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const mission = JSON.parse((await exec(process.execPath, [CLI, 'mission-run', 'Implement and verify a delivery candidate', '--data-dir', dir])).stdout);
  const missionId = mission.mission.mission_id;
  let state = JSON.parse((await exec(process.execPath, [CLI, 'mission-delivery-propose', missionId, '--target', 'production', '--external', '--irreversible', '--data-dir', dir])).stdout);
  const proposal = state.deliveries.at(-1);
  const approval = state.approvals.find((item) => item.kind === 'delivery' && item.delivery_id === proposal.delivery_id);
  assert.ok(approval);
  await assert.rejects(() => exec(process.execPath, [CLI, 'mission-delivery-execute', missionId, proposal.delivery_id, '--data-dir', dir]), /persisted.*approval/);
  state = JSON.parse((await exec(process.execPath, [CLI, 'mission-delivery-approve', missionId, approval.approval_id, approval.challenge, 'approved', '--data-dir', dir])).stdout);
  assert.equal(state.approvals.find((item) => item.approval_id === approval.approval_id).status, 'approved');
  state = JSON.parse((await exec(process.execPath, [CLI, 'mission-delivery-execute', missionId, proposal.delivery_id, '--data-dir', dir])).stdout);
  assert.equal(state.receipts.length, 1);
});

test('CLI operator can verify integrity and explicitly abort Mission and OS runs', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  let mission = JSON.parse((await exec(process.execPath, [CLI, 'mission-create', 'Implement a bounded component', '--data-dir', dir])).stdout);
  const missionId = mission.mission.mission_id;
  const missionIntegrity = JSON.parse((await exec(process.execPath, [CLI, 'mission-integrity', missionId, '--data-dir', dir])).stdout);
  assert.equal(missionIntegrity.ok, true);
  mission = JSON.parse((await exec(process.execPath, [CLI, 'mission-abort', missionId, 'operator cancelled', '--data-dir', dir])).stdout);
  assert.equal(mission.status, 'aborted');

  let osRun = JSON.parse((await exec(process.execPath, [CLI, 'os-create', 'Implement a bounded service', '--data-dir', dir])).stdout);
  const osIntegrity = JSON.parse((await exec(process.execPath, [CLI, 'os-integrity', osRun.os_run_id, '--data-dir', dir])).stdout);
  assert.equal(osIntegrity.ok, true);
  osRun = JSON.parse((await exec(process.execPath, [CLI, 'os-abort', osRun.os_run_id, 'operator cancelled', '--data-dir', dir])).stdout);
  assert.equal(osRun.status, 'aborted');
});
