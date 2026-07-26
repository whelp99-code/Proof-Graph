#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(ROOT, 'bin', 'proofgraphd.mjs');
const CLI = path.join(ROOT, 'bin', 'proofgraph.mjs');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_VERSION = PACKAGE.version;
const EXPECTED_GATE = 'PASS_OFFLINE_LIVE_PROVIDER_AND_HOST_CANARY_REQUIRED';
const results = [];

async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, passed: true, detail: detail ?? null }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(fn, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await sleep(30);
  }
}
async function cli(args, env = {}) {
  const result = await exec(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1', ...env }, maxBuffer: 30_000_000 });
  const text = result.stdout.trim();
  try { return JSON.parse(text); } catch { return text; }
}
async function startDaemon(dataDir, extra = []) {
  const child = spawn(process.execPath, [DAEMON, '--data-dir', dataDir, '--port', '0', '--tick-ms', '1', ...extra], {
    cwd: ROOT, env: { ...process.env, PROOFGRAPH_ALLOW_SIMULATION_PROMOTION: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon start timeout: ${stderr}`)), 8000);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.once('line', (value) => { clearTimeout(timer); rl.close(); resolve(value); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${stderr}`)); });
  });
  const started = JSON.parse(line);
  const token = (await fs.readFile(path.join(dataDir, '.operator-api-token'), 'utf8')).trim();
  const hostToken = (await fs.readFile(path.join(dataDir, '.host-ingest-token'), 'utf8')).trim();
  return { child, url: started.url, token, hostToken, stderr: () => stderr };
}
async function request(daemon, method, endpoint, body = null, { token = daemon.token, idempotencyKey = null, raw = false } = {}) {
  const response = await fetch(`${daemon.url}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? 'text/plain' : 'application/json',
      ...(body == null ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = text; }
  return { response, value, text };
}
async function stopDaemon(daemon) {
  try { await request(daemon, 'POST', '/v1/shutdown', {}); } catch { /* best effort */ }
  await Promise.race([
    new Promise((resolve) => daemon.child.once('exit', resolve)),
    sleep(1000).then(() => { daemon.child.kill('SIGTERM'); }),
  ]);
}
async function firstSseFrame(daemon, runId = null, after = 0) {
  const controller = new AbortController();
  const endpoint = runId ? `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}` : '/v1/events';
  const response = await fetch(`${daemon.url}${endpoint}`, { headers: { authorization: `Bearer ${daemon.token}`, accept: 'text/event-stream' }, signal: controller.signal });
  if (!response.ok) throw new Error(`SSE failed ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const index = buffer.indexOf('\n\n');
      if (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataMatch = frame.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;
        const event = frame.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
        return { event, data: JSON.parse(dataMatch[1]) };
      }
    }
    throw new Error('No SSE frame received');
  } finally { controller.abort(); reader.releaseLock(); }
}
async function fakeBridge() {
  const token = crypto.randomBytes(32).toString('hex');
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body.command === 'integrity') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { ok: true } })); return; }
    if (body.command !== 'run') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'unknown' })); return; }
    const metadata = body.payload?.metadata ?? {}; const workItemId = metadata.work_item_id;
    const stage = String(workItemId).split(':work:').at(-1); const current = (attempts.get(stage) ?? 0) + 1; attempts.set(stage, current);
    const fail = stage === 'verify' && current === 1;
    const report = {
      schema_version: 1,
      run_id: `fake_${stage}_${current}`,
      request_id: body.request_id,
      mission_id: metadata.mission_id,
      work_item_id: workItemId,
      stage_id: stage,
      kind: stage,
      assigned_role_id: metadata.assigned_role_id,
      status: fail ? 'failed' : 'success',
      output: fail ? null : {
        summary: `${stage} completed`,
        deliverables: stage === 'verify' ? [] : [{ name: `${stage}-artifact`, media_type: 'application/json', content: { stage, attempt: current } }],
      },
      verification: { passed: !fail && stage === 'verify', independent: stage === 'verify', evidence: !fail && stage === 'verify' ? ['fake bridge verifier'] : [] },
      failure: fail ? { type: 'implementation_error', severity: 'medium', message: 'Injected independent bridge failure', evidence: ['verify attempt 1'], retryable: true } : null,
      usage: { calls: 1, tokens: 1, cost_micros: 1, wall_time_ms: 1 },
      integrity: { report_digest: 'a'.repeat(64) },
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { report } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { token, url: `http://127.0.0.1:${address.port}`, attempts, close: () => new Promise((resolve) => server.close(resolve)) };
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-operator-independent-'));
let primary;
try {
  await check('Operator CLI version contract', async () => {
    const value = await cli(['version']);
    if (value.version !== EXPECTED_VERSION || value.release_gate !== EXPECTED_GATE) throw new Error('Unexpected version contract');
    return value;
  });

  const primaryDir = path.join(work, 'primary'); primary = await startDaemon(primaryDir);

  await check('Control Plane health and unauthorized boundary', async () => {
    const health = await fetch(`${primary.url}/v1/health`).then((value) => value.json());
    const unauthorized = await fetch(`${primary.url}/v1/runs`);
    if (!health.ok || health.version !== EXPECTED_VERSION || unauthorized.status !== 401) throw new Error('Health/auth boundary failed');
    return { health, unauthorized_status: unauthorized.status };
  });

  let cleanRun;
  await check('Mission reaches one-screen clean completion projection', async () => {
    const created = await request(primary, 'POST', '/v1/runs', { objective: 'Implement and independently verify a bounded operator feature', auto_start: true }, { idempotencyKey: 'independent-clean' });
    if (created.response.status !== 201) throw new Error(created.text);
    cleanRun = created.value.run;
    const done = await waitFor(async () => (await request(primary, 'GET', `/v1/runs/${cleanRun.run_id}`)).value.run, (run) => ['completed_clean', 'completed_with_recovery', 'failed', 'partial'].includes(run.status));
    if (done.status !== 'completed_clean' || done.quality_gate_passed !== true || !done.graph.nodes.length) throw new Error(`Unexpected run: ${done.status}`);
    return { run_id: done.run_id, status: done.status, progress: done.progress, nodes: done.graph.nodes.length };
  });

  await check('SSE emits projection snapshot and can resume from event cursor', async () => {
    const frame = await firstSseFrame(primary, cleanRun.run_id, 0);
    if (frame.event !== 'run.updated' || frame.data.run_id !== cleanRun.run_id) throw new Error(`Unexpected SSE frame ${frame.event}`);
    const timeline = await request(primary, 'GET', `/v1/runs/${cleanRun.run_id}/timeline?after=0&limit=500`);
    if (!timeline.value.events.some((event) => event.type === 'mission.terminal')) throw new Error('Terminal event missing');
    const last = timeline.value.events.at(-1).seq;
    const resumed = await request(primary, 'GET', `/v1/runs/${cleanRun.run_id}/timeline?after=${last - 1}&limit=5`);
    if (!resumed.value.events.length || resumed.value.events[0].seq <= last - 1) throw new Error('Event cursor resume failed');
    return { event: frame.event, event_count: timeline.value.events.length, cursor: last };
  });

  await check('Idempotency ledger returns the same run for repeated create command', async () => {
    const body = { objective: 'Idempotent mission', auto_start: false };
    const one = await request(primary, 'POST', '/v1/runs', body, { idempotencyKey: 'independent-idempotent' });
    const two = await request(primary, 'POST', '/v1/runs', body, { idempotencyKey: 'independent-idempotent' });
    if (one.value.run.run_id !== two.value.run.run_id) throw new Error('Idempotency failed');
    return { run_id: one.value.run.run_id };
  });

  await check('Pause and resume are operator-controlled and observable', async () => {
    const created = await request(primary, 'POST', '/v1/runs', { objective: 'Pauseable mission', auto_start: false }, { idempotencyKey: 'independent-pause' });
    const id = created.value.run.run_id;
    const paused = await request(primary, 'POST', `/v1/runs/${id}/pause`, { reason: 'independent pause' }, { idempotencyKey: 'independent-pause-action' });
    if (paused.value.run.status !== 'paused') throw new Error(`Expected paused, got ${paused.value.run.status}`);
    await request(primary, 'POST', `/v1/runs/${id}/resume`, {}, { idempotencyKey: 'independent-resume-action' });
    const done = await waitFor(async () => (await request(primary, 'GET', `/v1/runs/${id}`)).value.run, (run) => run.status === 'completed_clean');
    return { run_id: id, status: done.status };
  });

  await check('Approval challenge is hidden and external approval completes mission', async () => {
    const created = await request(primary, 'POST', '/v1/runs', { objective: 'Deploy a production database migration', auto_start: true }, { idempotencyKey: 'independent-approval' });
    const waiting = await waitFor(async () => (await request(primary, 'GET', `/v1/runs/${created.value.run.run_id}`)).value.run, (run) => run.status === 'waiting_approval');
    const approval = waiting.approvals.pending[0];
    if (!approval || Object.hasOwn(approval, 'challenge')) throw new Error('Approval challenge leaked');
    await request(primary, 'POST', `/v1/runs/${waiting.run_id}/approvals/${approval.approval_id}/decision`, { decision: 'approved', reason: 'independent verifier approval' }, { idempotencyKey: 'independent-approve-action' });
    const done = await waitFor(async () => (await request(primary, 'GET', `/v1/runs/${waiting.run_id}`)).value.run, (run) => run.status === 'completed_clean');
    return { run_id: done.run_id, approval_id: approval.approval_id };
  });

  await check('Approval denial produces an explicit denied terminal state', async () => {
    const created = await request(primary, 'POST', '/v1/runs', { objective: 'Delete production data irreversibly', auto_start: true }, { idempotencyKey: 'independent-denial' });
    const waiting = await waitFor(async () => (await request(primary, 'GET', `/v1/runs/${created.value.run.run_id}`)).value.run, (run) => run.status === 'waiting_approval');
    const approval = waiting.approvals.pending[0];
    await request(primary, 'POST', `/v1/runs/${waiting.run_id}/approvals/${approval.approval_id}/decision`, { decision: 'denied', reason: 'independent safety denial' }, { idempotencyKey: 'independent-deny-action' });
    const denied = (await request(primary, 'GET', `/v1/runs/${waiting.run_id}`)).value.run;
    if (denied.status !== 'denied' || !denied.approvals.decided.some((item) => item.status === 'denied')) throw new Error('Denied terminal state missing');
    return { run_id: denied.run_id, status: denied.status };
  });

  await check('Host ingest token is isolated from operator authority', async () => {
    const operatorAttempt = await fetch(`${primary.url}/v1/hosts/opencode/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proofgraph-host-token': primary.token }, body: JSON.stringify({ type: 'session.status' }) });
    if (operatorAttempt.status !== 401) throw new Error('Operator token was accepted as host token');
    const accepted = await fetch(`${primary.url}/v1/hosts/opencode/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proofgraph-host-token': primary.hostToken }, body: JSON.stringify({ type: 'session.status', session_id: 'session_independent', run_id: cleanRun.run_id, properties: { status: 'busy' } }) });
    if (accepted.status !== 202) throw new Error(`Host event rejected ${accepted.status}`);
    const hosts = (await request(primary, 'GET', '/v1/hosts')).value.hosts;
    if (!hosts.some((host) => host.name === 'opencode')) throw new Error('OpenCode host not registered');
    return { operator_status: operatorAttempt.status, host_status: accepted.status };
  });

  await check('CLI snapshot renders graph, timeline and approval-safe content', async () => {
    const output = await cli(['snapshot', '--run', cleanRun.run_id, '--url', primary.url, '--data-dir', primaryDir, '--width', '120', '--height', '36']);
    if (typeof output !== 'string' || !/ProofGraph Operator/.test(output) || !/EXECUTION GRAPH/.test(output) || !/TIMELINE/.test(output)) throw new Error('Snapshot surface incomplete');
    if (/challenge/i.test(output)) throw new Error('Approval challenge rendered');
    return { lines: output.split('\n').length };
  });

  await check('OpenCode project installer creates plugin and command surface', async () => {
    const project = path.join(work, 'opencode-project'); await fs.mkdir(project, { recursive: true });
    const installed = await cli(['install-opencode', '--project', project, '--url', primary.url, '--data-dir', primaryDir]);
    const files = [
      '.opencode/plugins/proofgraph-observer.js', '.opencode/commands/pg-status.md', '.opencode/commands/pg-flow.md', '.opencode/commands/pg-approvals.md', '.opencode/commands/pg-run.md', '.opencode/proofgraph.json',
    ];
    for (const file of files) await fs.access(path.join(project, file));
    if (installed.environment?.PROOFGRAPH_OPERATOR_TOKEN) throw new Error('Operator token exposed by installer');
    return { files: files.length };
  });

  await check('Control Plane restart preserves run projection and token identity', async () => {
    const tokenBefore = primary.token; await stopDaemon(primary); primary = await startDaemon(primaryDir);
    if (primary.token !== tokenBefore) throw new Error('Operator token changed during restart');
    const run = (await request(primary, 'GET', `/v1/runs/${cleanRun.run_id}`)).value.run;
    if (run.status !== 'completed_clean') throw new Error('Projection was not restored');
    return { run_id: run.run_id, status: run.status };
  });

  await check('State tampering fails closed through HTTP API', async () => {
    const created = await request(primary, 'POST', '/v1/runs', { objective: 'Tamper test mission', auto_start: false }, { idempotencyKey: 'independent-tamper' });
    const id = created.value.run.run_id; const file = path.join(primaryDir, 'missions', id, 'state.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8')); state.status = 'completed'; state.quality_gate_passed = true; await fs.writeFile(file, JSON.stringify(state));
    const response = await request(primary, 'GET', `/v1/runs/${id}`);
    if (response.response.status !== 500 || !/digest mismatch/i.test(response.value.message ?? '')) throw new Error(`Tamper was not detected: ${response.text}`);
    return { run_id: id, detected: true };
  });

  await check('Host bridge loop is rendered as completed with recovery', async () => {
    const bridge = await fakeBridge(); const dir = path.join(work, 'bridge-loop');
    const daemon = await startDaemon(dir, ['--bridge-url', bridge.url, '--bridge-token', bridge.token, '--runtime-host', 'opencode']);
    try {
      const created = await request(daemon, 'POST', '/v1/runs', { objective: 'Implement and independently verify a bridge feature', auto_start: true }, { idempotencyKey: 'independent-loop' });
      const done = await waitFor(async () => (await request(daemon, 'GET', `/v1/runs/${created.value.run.run_id}`)).value.run, (run) => ['completed_with_recovery', 'failed', 'partial'].includes(run.status), 12_000);
      if (done.status !== 'completed_with_recovery' || !done.quality_gate_passed) throw new Error(`Unexpected recovery state ${done.status}`);
      if (!done.loops.length || !done.graph.edges.some((edge) => edge.kind === 'retry') || !done.failures.resolved.length) throw new Error('Loop/failure projection incomplete');
      const timeline = (await request(daemon, 'GET', `/v1/runs/${done.run_id}/timeline?after=0&limit=1000`)).value.events;
      for (const type of ['route.changed', 'loop.entered', 'loop.exited', 'failure.resolved']) if (!timeline.some((event) => event.type === type)) throw new Error(`Missing ${type}`);
      return { run_id: done.run_id, status: done.status, loops: done.loops.length, verify_attempts: bridge.attempts.get('verify') };
    } finally { await stopDaemon(daemon); await bridge.close(); }
  });

  await check('No production source module imported by operator verifier', async () => {
    const source = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
    if (/from ['"]\.\.\/runtime\//.test(source) || /import\(['"]\.\.\/runtime\//.test(source)) throw new Error('Verifier imports production runtime');
    return { production_imports: 0 };
  });
} finally {
  if (primary) await stopDaemon(primary).catch(() => {});
  await fs.rm(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 });
}

const summary = {
  schema_version: 2,
  verifier: 'operator-independent-black-box',
  version: EXPECTED_VERSION,
  production_module_imports: 0,
  total: results.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
};
summary.digest = crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(ROOT, 'verification', 'operator-independent-results.json');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, output }, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
