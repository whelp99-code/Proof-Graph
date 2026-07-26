import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { tempDir, cleanup } from '../helpers.mjs';

const MCP = path.resolve('runtime/mcp/server.mjs');

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
      const timer = setTimeout(() => reject(new Error(`RPC timeout: ${this.stderr}`)), 8000);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); }
}

async function call(rpc, name, args) {
  const response = await rpc.request('tools/call', { name, arguments: args });
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
  return response.result.structuredContent;
}

test('stdio MCP exposes read-only Intelligence Fabric tools end to end', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, PROOFGRAPH_ORG_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new Rpc(child); t.after(() => rpc.close());
  const init = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.version, '5.0.0'); rpc.notify('notifications/initialized');
  const listed = await rpc.request('tools/list'); const names = listed.result.tools.map((item) => item.name);
  for (const name of ['pg4_intelligence_status', 'pg4_context', 'pg4_model_routes', 'pg4_model_observations', 'pg4_contracts', 'pg4_impact', 'pg4_memory', 'pg4_intelligence_verification']) assert.ok(names.includes(name));
  assert.equal(names.some((name) => /^pg4_.*(?:approve|deny|abort)/.test(name)), false);
  const created = await call(rpc, 'pg2_create_mission', { objective: 'Implement and independently verify a bounded API' });
  const missionId = created.mission.mission_id;
  const state = await call(rpc, 'pg2_run_mission', { mission_id: missionId });
  assert.equal(state.status, 'completed');
  const summary = await call(rpc, 'pg4_intelligence_status', { mission_id: missionId });
  assert.equal(summary.fabric_version, '5.0.0'); assert.ok(summary.counts.contexts > 0); assert.ok(summary.counts.routes > 0); assert.ok(summary.counts.observations > 0);
  const contexts = await call(rpc, 'pg4_context', { mission_id: missionId, include_sections: false });
  assert.ok(contexts.length > 0); assert.ok(Array.isArray(contexts[0].sections));
  const routes = await call(rpc, 'pg4_model_routes', { mission_id: missionId });
  assert.ok(routes.every((route) => route.model_id && route.registry_digest));
  const observations = await call(rpc, 'pg4_model_observations', { mission_id: missionId });
  assert.ok(observations.observations.length > 0); assert.ok(observations.model_summary.length > 0);
  const contracts = await call(rpc, 'pg4_contracts', { mission_id: missionId });
  assert.ok(contracts.contracts.length > 0);
  const impacts = await call(rpc, 'pg4_impact', { mission_id: missionId, source_ids: [state.mission.work_items[0].work_item_id], max_depth: 2 });
  assert.ok(Array.isArray(impacts));
  const memories = await call(rpc, 'pg4_memory', { mission_id: missionId, query: 'verification', limit: 10 });
  assert.ok(Array.isArray(memories));
  const verification = await call(rpc, 'pg4_intelligence_verification', { mission_id: missionId });
  assert.ok(verification.length > 0);
});
