#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'bin', 'proofgraph-org.mjs');
const OPERATOR = path.join(ROOT, 'bin', 'proofgraph.mjs');
const DAEMON = path.join(ROOT, 'bin', 'proofgraphd.mjs');
const MCP = path.join(ROOT, 'runtime', 'mcp', 'server.mjs');
const results = [];

async function check(name, fn) {
  try { results.push({ name, passed: true, detail: await fn() ?? null }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
async function cli(args, env = {}) {
  const result = await exec(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1', ...env }, maxBuffer: 30_000_000 });
  return JSON.parse(result.stdout);
}
async function operator(args, env = {}) {
  return exec(process.execPath, [OPERATOR, ...args], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1', ...env }, maxBuffer: 30_000_000 });
}
async function expectFailure(fn, pattern) {
  try { await fn(); throw new Error('operation unexpectedly succeeded'); }
  catch (error) {
    if (error.message === 'operation unexpectedly succeeded') throw error;
    const text = `${error.stderr ?? ''}\n${error.message}`;
    if (pattern && !pattern.test(text)) throw new Error(`unexpected failure: ${text}`);
    return text;
  }
}

class Rpc {
  constructor(child) {
    this.child = child; this.id = 1; this.pending = new Map(); this.stderr = '';
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const message = JSON.parse(line); const resolve = this.pending.get(message.id);
      if (resolve) { this.pending.delete(message.id); resolve(message); }
    });
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
  }
  request(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout ${method}: ${this.stderr}`)); }, 10000);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); }
}
async function withRpc(dataDir, env, fn) {
  const child = spawn(process.execPath, [MCP], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ORG_DATA: dataDir, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new Rpc(child);
  try {
    const init = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'intelligence-independent', version: '1' } });
    if (init.result?.serverInfo?.version !== PACKAGE.version) throw new Error('MCP version mismatch');
    rpc.notify('notifications/initialized'); return await fn(rpc);
  } finally { rpc.close(); }
}
async function rpcCall(rpc, name, args) {
  const response = await rpc.request('tools/call', { name, arguments: args });
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? `MCP ${name} failed`);
  return response.result.structuredContent;
}

function request(baseUrl, method, pathname, { token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl); const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length, 'x-idempotency-key': crypto.randomUUID() } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => {
        let value = null; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
        resolve({ status: res.statusCode, value, text });
      });
    });
    req.once('error', reject); if (payload) req.write(payload); req.end();
  });
}
async function startDaemon(dataDir, extraArgs = []) {
  const child = spawn(process.execPath, [DAEMON, '--data-dir', dataDir, '--port', '0', ...extraArgs], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const line = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error(`daemon timeout: ${stderr}`)), 10000);
    child.stdout.on('data', (chunk) => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(text.split('\n')[0]); } });
    child.once('error', reject); child.once('exit', (code) => { if (code && !text) reject(new Error(`daemon exited ${code}: ${stderr}`)); });
  });
  const info = JSON.parse(line); const token = (await fs.readFile(info.token_files.operator, 'utf8')).trim();
  return { child, baseUrl: info.url, token, dataDir };
}
async function stopDaemon(daemon) {
  await request(daemon.baseUrl, 'POST', '/v1/shutdown', { token: daemon.token }).catch(() => {});
  await new Promise((resolve) => { const timer = setTimeout(() => { daemon.child.kill('SIGTERM'); resolve(); }, 3000); daemon.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
}
async function waitRun(daemon, runId) {
  for (let i = 0; i < 200; i += 1) {
    const response = await request(daemon.baseUrl, 'GET', `/v1/runs/${runId}`, { token: daemon.token });
    const run = response.value?.run;
    if (run && ['completed_clean', 'completed_with_recovery', 'partial', 'failed', 'denied'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('run did not terminate');
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-intelligence-independent-'));
let daemon;
try {
  const registry = {
    schema: 'proofgraph.model-registry.v1', schema_version: 1, registry_version: 'independent-registry-1', entries: [{
      model_id: 'independent/all-capable-v1', provider: 'independent', host: 'opencode', enabled: true,
      capabilities: ['coding', 'general', 'planning', 'reasoning', 'research', 'structured_output', 'verification'],
      data_classifications: ['public', 'internal', 'confidential', 'restricted'], risk_ceiling: 'critical', max_context_tokens: 250000,
      quality: 0.9, reliability: 0.9, health: 1, latency_ms: 10, input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, tags: ['independent'],
    }],
  };
  const registryFile = path.join(work, 'model-registry.json'); await fs.writeFile(registryFile, JSON.stringify(registry));

  await check('CLI v4 product contract', async () => {
    const version = await cli(['version']);
    if (version.product !== '@proofgraph/standalone' && version.product !== 'proofgraph-standalone') throw new Error(`unexpected product ${version.product}`);
    if (version.version !== '5.0.0') throw new Error('version mismatch'); return version;
  });

  let mission;
  const missionData = path.join(work, 'mission');
  await check('CLI exact model routing and verified completion', async () => {
    mission = await cli(['mission-run', 'Implement and independently verify a bounded API', '--data-dir', missionData, '--model-registry', registryFile]);
    if (mission.status !== 'completed' || !mission.quality_gate_passed) throw new Error(`unexpected mission state ${mission.status}`);
    const routes = mission.intelligence?.route_decisions ?? [];
    if (!routes.length || routes.some((route) => route.model_id !== 'independent/all-capable-v1')) throw new Error('exact model route not applied');
    return { mission_id: mission.mission.mission_id, routes: routes.length, model_id: routes[0].model_id };
  });

  await check('CLI Intelligence sections are operational and bounded', async () => {
    const id = mission.mission.mission_id;
    const summary = await cli(['mission-intelligence', id, 'summary', '--data-dir', missionData, '--model-registry', registryFile]);
    const contexts = await cli(['mission-intelligence', id, 'contexts', '--data-dir', missionData, '--model-registry', registryFile]);
    const contracts = await cli(['mission-intelligence', id, 'contracts', '--data-dir', missionData, '--model-registry', registryFile]);
    const memory = await cli(['mission-intelligence', id, 'memory', '--data-dir', missionData, '--model-registry', registryFile]);
    if (summary.fabric_version !== '5.0.0' || !contexts.length || !contracts.contracts.length || !Array.isArray(memory.entries)) throw new Error('Intelligence CLI sections incomplete');
    if (contexts.some((item) => Object.hasOwn(item, 'sections') && !Array.isArray(item.sections))) throw new Error('bounded context summary leaked full section object');
    return { contexts: contexts.length, contracts: contracts.contracts.length, memory: memory.entries.length };
  });

  await check('Registry drift is rejected through public CLI', async () => {
    const error = await expectFailure(() => cli(['mission-integrity', mission.mission.mission_id, '--data-dir', missionData]), /registry mismatch/i);
    return { detected: true, message: error.split('\n').find(Boolean) };
  });

  await check('Registry symlink is rejected through public CLI', async () => {
    const link = path.join(work, 'registry-link.json'); await fs.symlink(registryFile, link);
    await expectFailure(() => cli(['mission-run', 'Implement a feature', '--data-dir', path.join(work, 'symlink'), '--model-registry', link]), /symlink/i);
    return { rejected: true };
  });

  await check('MCP exposes read-only pg4 surface and all six runtime results', async () => withRpc(path.join(work, 'mcp'), { PROOFGRAPH_MODEL_REGISTRY: registryFile }, async (rpc) => {
    const listed = await rpc.request('tools/list'); const names = listed.result.tools.map((tool) => tool.name);
    const required = ['pg4_intelligence_status', 'pg4_context', 'pg4_model_routes', 'pg4_model_observations', 'pg4_contracts', 'pg4_impact', 'pg4_memory', 'pg4_intelligence_verification'];
    for (const name of required) if (!names.includes(name)) throw new Error(`missing ${name}`);
    if (names.some((name) => /^pg4_.*(?:approve|deny|abort|write|apply)/i.test(name))) throw new Error('operator mutation tool exposed');
    const created = await rpcCall(rpc, 'pg2_create_mission', { objective: 'Research, implement, and verify a bounded component' });
    const id = created.mission.mission_id; const state = await rpcCall(rpc, 'pg2_run_mission', { mission_id: id });
    const summary = await rpcCall(rpc, 'pg4_intelligence_status', { mission_id: id });
    const contexts = await rpcCall(rpc, 'pg4_context', { mission_id: id, include_sections: false });
    const routes = await rpcCall(rpc, 'pg4_model_routes', { mission_id: id });
    const observations = await rpcCall(rpc, 'pg4_model_observations', { mission_id: id });
    const contracts = await rpcCall(rpc, 'pg4_contracts', { mission_id: id });
    const memory = await rpcCall(rpc, 'pg4_memory', { mission_id: id, query: 'verification', limit: 10 });
    const verification = await rpcCall(rpc, 'pg4_intelligence_verification', { mission_id: id });
    const impacts = await rpcCall(rpc, 'pg4_impact', { mission_id: id, source_ids: [state.mission.work_items[0].work_item_id], max_depth: 2 });
    if (summary.counts.contexts < 1 || summary.counts.observations < 1 || !contexts.length || !routes.length || !observations.observations.length || !observations.model_summary.length || !contracts.contracts.length || !Array.isArray(memory) || !verification.length || !Array.isArray(impacts)) throw new Error('MCP Intelligence output incomplete');
    if (routes.some((route) => route.model_id !== 'independent/all-capable-v1')) throw new Error('MCP did not use configured exact model');
    return { tools: required.length, contexts: contexts.length, observations: observations.observations.length, contracts: contracts.contracts.length, memory: memory.length };
  }));

  daemon = await startDaemon(path.join(work, 'daemon'), ['--model-registry', registryFile]);
  await check('Control Plane requires operator auth for Intelligence detail', async () => {
    const unauthorized = await request(daemon.baseUrl, 'GET', '/v1/runs/not-a-run/intelligence');
    if (unauthorized.status !== 401) throw new Error(`expected 401, got ${unauthorized.status}`);
    const health = await request(daemon.baseUrl, 'GET', '/v1/health');
    if (health.value?.model_registry?.version !== 'independent-registry-1') throw new Error('health omits configured registry');
    return { unauthorized: unauthorized.status, registry: health.value.model_registry };
  });

  let runId;
  await check('REST projections expose Context, Routing, Collaboration, Knowledge, Memory, Verification', async () => {
    const created = await request(daemon.baseUrl, 'POST', '/v1/runs', { token: daemon.token, body: { objective: 'Implement and independently verify an operator API', auto_start: true } });
    runId = created.value.run.run_id; const run = await waitRun(daemon, runId);
    if (run.status !== 'completed_clean') throw new Error(`unexpected run ${run.status}`);
    const sections = ['intelligence', 'context?full=true', 'routes?full=true', 'model-observations?full=true', 'contracts?full=true', 'knowledge?full=true', 'memory?full=true', 'verification?full=true'];
    const values = {};
    for (const section of sections) {
      const key = section.split('?')[0]; const response = await request(daemon.baseUrl, 'GET', `/v1/runs/${runId}/${section}`, { token: daemon.token });
      if (response.status !== 200) throw new Error(`${section} failed: ${response.text}`); values[key] = response.value.value;
    }
    if (!values.context.length || !values.routes.length || !values['model-observations'].length || !values.contracts.contracts.length || !values.knowledge.nodes.length || !values.memory.entries.length || !values.verification.length) throw new Error('REST detail missing runtime data');
    return { run_id: runId, status: run.status, contexts: values.context.length, routes: values.routes.length, observations: values['model-observations'].length };
  });

  await check('TUI snapshots render all six Intelligence views', async () => {
    const env = { PROOFGRAPH_ORG_DATA: daemon.dataDir, PROOFGRAPH_CONTROL_URL: daemon.baseUrl };
    const views = { context: 'CONTEXT DELIVERY', models: 'MODEL ROUTING', collaboration: 'COLLABORATION', knowledge: 'KNOWLEDGE / IMPACT', memory: 'ORGANIZATION MEMORY', verification: 'INTELLIGENCE VERIFICATION' };
    for (const [view, heading] of Object.entries(views)) {
      const screen = (await operator(['snapshot', '--run', runId, '--view', view, '--width', '120', '--height', '32'], env)).stdout;
      if (!screen.includes(heading)) throw new Error(`${view} heading missing`);
    }
    return { views: Object.keys(views) };
  });

  await check('Mission state tampering blocks Intelligence status', async () => {
    const stateFile = path.join(daemon.dataDir, 'missions', runId, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); state.intelligence.model_registry_version = 'forged'; await fs.writeFile(stateFile, JSON.stringify(state));
    const response = await request(daemon.baseUrl, 'GET', `/v1/runs/${runId}/intelligence`, { token: daemon.token });
    if (response.status !== 500 || !/digest mismatch/i.test(response.value?.message ?? response.text)) throw new Error(`tamper not detected: ${response.text}`);
    return { detected: true };
  });

  await check('Independent verifier imports no production runtime module', async () => {
    const source = await fs.readFile(new URL(import.meta.url), 'utf8');
    if (/from ['"]\.\.\/runtime\//.test(source) || /import\(['"]\.\.\/runtime\//.test(source)) throw new Error('production runtime import detected');
    return { production_imports: 0 };
  });
} finally {
  if (daemon) await stopDaemon(daemon).catch(() => {});
  await fs.rm(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 });
}

const summary = {
  schema_version: 1,
  verifier: 'intelligence-independent-black-box',
  version: PACKAGE.version,
  production_module_imports: 0,
  total: results.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
};
summary.digest = crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(ROOT, 'verification', 'intelligence-independent-results.json');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, output }, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
