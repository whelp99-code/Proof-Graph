#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import crypto from 'node:crypto';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_VERSION = PACKAGE.version;
const EXPECTED_GATE = 'PASS_OFFLINE_LIVE_PROVIDER_AND_HOST_CANARY_REQUIRED';
const CLI = path.join(ROOT, 'bin', 'proofgraph-org.mjs');
const MCP = path.join(ROOT, 'runtime', 'mcp', 'server.mjs');
const results = [];

async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, passed: true, detail: detail ?? null }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}

async function cli(args, options = {}) {
  const result = await exec(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1', ...(options.env ?? {}) }, maxBuffer: 20_000_000 });
  return JSON.parse(result.stdout);
}

async function expectCliFailure(args, options = {}) {
  try { await cli(args, options); throw new Error('CLI unexpectedly succeeded'); }
  catch (error) { if (error.message === 'CLI unexpectedly succeeded') throw error; return String(error.stderr ?? error.message); }
}

class Rpc {
  constructor(child) {
    this.child = child; this.id = 1; this.pending = new Map(); this.stderr = '';
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const message = JSON.parse(line); const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); pending(message); }
    });
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
  }
  request(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout ${method}: ${this.stderr}`)); }, 5000);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); }
}

async function withRpc(dataDir, fn) {
  const child = spawn(process.execPath, [MCP], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ORG_DATA: dataDir, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new Rpc(child);
  try {
    const init = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-verifier', version: '1' } });
    if (init.result?.serverInfo?.version !== EXPECTED_VERSION) throw new Error('MCP version mismatch');
    rpc.notify('notifications/initialized');
    return await fn(rpc);
  } finally { rpc.close(); }
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-v4-baseline-independent-'));
try {
  await check('CLI version contract', async () => {
    const value = await cli(['version']);
    if (value.version !== EXPECTED_VERSION || value.release_gate !== EXPECTED_GATE) throw new Error('Unexpected version contract');
    return value;
  });

  await check('CLI deterministic TaskSpec', async () => {
    const one = await cli(['task', 'Implement and verify a bounded feature']);
    const two = await cli(['task', 'Implement and verify a bounded feature']);
    if (one.digest !== two.digest || !one.adequacy?.adequate) throw new Error('TaskSpec is not deterministic and adequate');
    return { task_id: one.task_id, digest: one.digest };
  });

  await check('CLI Organization independence', async () => {
    const org = await cli(['organization', 'Implement and verify a secure API']);
    const developer = org.roles.find((role) => role.name === 'Developer');
    const verifier = org.roles.find((role) => role.name === 'Independent Verifier');
    if (!developer || !verifier || developer.role_id === verifier.role_id || developer.independence_group === verifier.independence_group) throw new Error('Developer/verifier independence missing');
    if (org.roles.some((role) => role.model_eligible && role.capabilities.includes('approval.decide'))) throw new Error('Model role has approval authority');
    return { organization_id: org.organization_id, roles: org.roles.length };
  });

  const missionData = path.join(work, 'mission-success');
  let missionId;
  await check('CLI full Mission success', async () => {
    const state = await cli(['mission-run', 'Implement and independently verify a feature', '--data-dir', missionData]);
    missionId = state.mission.mission_id;
    if (state.status !== 'completed' || state.quality_gate_passed !== true || !state.artifacts.length) throw new Error('Mission did not reach verified completion');
    return { mission_id: missionId, artifacts: state.artifacts.length };
  });

  await check('CLI Mission report preserves unverified candidates', async () => {
    const report = await cli(['mission-report', missionId, '--data-dir', missionData]);
    if (!Array.isArray(report.artifact_candidates) || !Array.isArray(report.failures)) throw new Error('Report omits candidate or failure state');
    return { candidates: report.artifact_candidates.length, failures: report.failures.length };
  });

  const approvalData = path.join(work, 'mission-approval');
  let approvalMission;
  await check('High-risk Mission stops at external approval', async () => {
    const state = await cli(['mission-run', 'Deploy a production database migration', '--data-dir', approvalData]);
    approvalMission = state;
    if (state.status !== 'waiting_approval' || !state.approvals.some((item) => item.status === 'pending')) throw new Error('High-risk mission bypassed approval');
    return { mission_id: state.mission.mission_id, pending_approvals: state.approvals.filter((item) => item.status === 'pending').length };
  });

  await check('CLI external operator approval resumes and completes high-risk Mission', async () => {
    const approval = approvalMission.approvals.find((item) => item.status === 'pending');
    await cli(['mission-approve', approvalMission.mission.mission_id, approval.approval_id, approval.challenge, 'approved', '--data-dir', approvalData]);
    const resumed = await cli(['mission-resume', approvalMission.mission.mission_id, '--data-dir', approvalData]);
    if (resumed.status !== 'completed' || resumed.quality_gate_passed !== true) throw new Error('Approved Mission did not complete');
    const current = await cli(['mission-report', approvalMission.mission.mission_id, '--data-dir', approvalData]);
    if (!current.approvals.some((item) => item.status === 'approved' && item.actor === 'external-human')) throw new Error('External approval was not persisted');
    return { mission_id: approvalMission.mission.mission_id, status: resumed.status, approval_status: 'approved' };
  });

  await check('CLI external Delivery requires proposal-bound operator approval', async () => {
    let state = await cli(['mission-delivery-propose', missionId, '--target', 'production', '--external', '--irreversible', '--data-dir', missionData]);
    const proposal = state.deliveries.at(-1);
    const approval = state.approvals.find((item) => item.kind === 'delivery' && item.delivery_id === proposal.delivery_id);
    const denied = await expectCliFailure(['mission-delivery-execute', missionId, proposal.delivery_id, '--data-dir', missionData]);
    if (!/persisted.*approval/i.test(denied)) throw new Error(`Unapproved delivery response was unexpected: ${denied}`);
    await cli(['mission-delivery-approve', missionId, approval.approval_id, approval.challenge, 'approved', '--data-dir', missionData]);
    state = await cli(['mission-delivery-execute', missionId, proposal.delivery_id, '--data-dir', missionData]);
    if (!state.receipts.some((item) => item.delivery_id === proposal.delivery_id && item.approval_id === approval.approval_id)) throw new Error('Approved delivery receipt missing');
    return { delivery_completed: true, approval_persisted: true };
  });

  await check('Runtime-generated approval secrets are private and not shipped constants', async () => {
    const files = [path.join(approvalData, '.mission-approval-secret')];
    for (const file of files) {
      const value = (await fs.readFile(file, 'utf8')).trim();
      const stat = await fs.stat(file);
      if (value.length < 40 || /change-me|development-only/i.test(value)) throw new Error('Approval secret is weak or constant');
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Approval secret permissions are too broad');
    }
    return { files: files.length };
  });

  await check('MCP tool surface excludes approval, abort, and policy apply', async () => withRpc(path.join(work, 'mcp-list'), async (rpc) => {
    const listed = await rpc.request('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    if (names.some((name) => /approve|deny|abort|apply_policy|modify_runtime/i.test(name))) throw new Error(`Operator tool exposed: ${names.join(', ')}`);
    return { count: names.length, names };
  }));

  await check('MCP Task and Organization compilation', async () => withRpc(path.join(work, 'mcp-compile'), async (rpc) => {
    const task = await rpc.request('tools/call', { name: 'pg2_compile_task', arguments: { objective: 'Research and verify orchestration systems' } });
    const org = await rpc.request('tools/call', { name: 'pg2_build_organization', arguments: { objective: 'Implement and verify a feature' } });
    if (task.result.isError || org.result.isError || !task.result.structuredContent.adequacy.adequate) throw new Error('MCP compile failed');
    return { task_id: task.result.structuredContent.task_id, organization_id: org.result.structuredContent.organization_id };
  }));

  await check('MCP rejects arbitrary fields and unknown tools', async () => withRpc(path.join(work, 'mcp-reject'), async (rpc) => {
    const injected = await rpc.request('tools/call', { name: 'pg2_compile_task', arguments: { objective: 'Do work', arbitrary_graph: { bypass: true } } });
    const unknown = await rpc.request('tools/call', { name: 'pg2_apply_policy', arguments: {} });
    if (!injected.result.isError || !unknown.result.isError) throw new Error('MCP accepted injected or unknown tool');
    return { injected_error: injected.result.content[0].text, unknown_error: unknown.result.content[0].text };
  }));

  await check('MCP persistent Mission and integrity', async () => withRpc(path.join(work, 'mcp-mission'), async (rpc) => {
    const created = await rpc.request('tools/call', { name: 'pg2_create_mission', arguments: { objective: 'Implement and verify a bounded component' } });
    const id = created.result.structuredContent.mission.mission_id;
    const run = await rpc.request('tools/call', { name: 'pg2_run_mission', arguments: { mission_id: id } });
    const integrity = await rpc.request('tools/call', { name: 'pg2_verify_integrity', arguments: { kind: 'mission', id } });
    if (run.result.structuredContent.status !== 'completed' || integrity.result.structuredContent.ok !== true) throw new Error('MCP mission/integrity failed');
    return { mission_id: id };
  }));

  const tamperData = path.join(work, 'tamper-state');
  await check('State tampering is detected through CLI', async () => {
    const created = await cli(['mission-create', 'Implement a feature', '--data-dir', tamperData]);
    const id = created.mission.mission_id;
    const file = path.join(tamperData, 'missions', id, 'state.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8')); state.status = 'completed'; state.quality_gate_passed = true;
    await fs.writeFile(file, JSON.stringify(state));
    const message = await expectCliFailure(['mission-status', id, '--data-dir', tamperData]);
    if (!/digest mismatch/i.test(message)) throw new Error(`Unexpected tamper response: ${message}`);
    return { mission_id: id, detected: true };
  });

  const eventData = path.join(work, 'tamper-event');
  await check('Event-chain tampering is detected through CLI', async () => {
    const created = await cli(['mission-create', 'Implement a feature', '--data-dir', eventData]);
    const id = created.mission.mission_id;
    const file = path.join(eventData, 'missions', id, 'events.jsonl');
    await fs.appendFile(file, '{"forged":true}\n');
    const message = await expectCliFailure(['mission-status', id, '--data-dir', eventData]);
    if (!/event chain|event head|malformed event/i.test(message)) throw new Error(`Unexpected event tamper response: ${message}`);
    return { mission_id: id, detected: true };
  });

  const osData = path.join(work, 'os-success');
  await check('CLI Autonomous Organization OS bounded success', async () => {
    const created = await cli(['os-create', 'Implement and verify a bounded service', '--data-dir', osData]);
    const state = await cli(['os-run', created.os_run_id, '--data-dir', osData]);
    if (state.status !== 'completed' || state.cycle > state.max_cycles) throw new Error('OS did not complete within bound');
    const report = await cli(['os-report', created.os_run_id, '--data-dir', osData]);
    if (!Array.isArray(report.improvement_proposals) || report.quality_gate_passed !== true) throw new Error('OS report contract failed');
    return { os_run_id: created.os_run_id, cycle: state.cycle };
  });

  await check('No production source module imported by verifier', async () => {
    const source = await fs.readFile(new URL(import.meta.url), 'utf8');
    if (/from ['"]\.\.\/runtime\//.test(source) || /import\(['"]\.\.\/runtime\//.test(source)) throw new Error('Verifier imports production runtime');
    return { production_imports: 0 };
  });

  await check('v1.1 integration manifest declares operator-only commands', async () => {
    const text = await fs.readFile(path.join(ROOT, 'runtime', 'integration', 'v1-1-port.mjs'), 'utf8');
    for (const command of ['approve', 'deny', 'abort']) if (!text.includes(command)) throw new Error(`Missing operator-only command declaration: ${command}`);
    if (!text.includes('proofgraph.host.v1')) throw new Error('Missing v1.1 host protocol');
    return { protocol: 'proofgraph.host.v1' };
  });
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

const summary = {
  schema_version: 1,
  verifier: 'independent-black-box',
  version: EXPECTED_VERSION,
  production_module_imports: 0,
  total: results.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
};
summary.digest = crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(ROOT, 'verification', 'independent-results.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, output }, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
