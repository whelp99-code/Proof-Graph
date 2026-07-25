#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Black-box verifier: intentionally uses only public CLI/HTTP/files and fake vendor endpoints.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'proofgraph.mjs');
const FAKE_PI = path.join(ROOT, 'tests', 'fixtures', 'fake-pi-rpc.mjs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
const results = [];

function add(name, ok, details = {}, residual = false) {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', residual, ...details });
}
async function cli(argv, options = {}) {
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'TIMEOUT' }); }, options.timeoutMs ?? 60_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
  return { ...outcome, stdout, stderr, json };
}
async function initProject(base, name) {
  const project = path.join(base, name);
  await fs.mkdir(project, { recursive: true });
  const initialized = await cli(['init', project]);
  if (initialized.code !== 0) throw new Error(`init failed: ${initialized.stderr}`);
  return project;
}
async function updateConfig(project, mutate) {
  const file = path.join(project, 'proofgraph.config.json');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  mutate(config);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
function agentResult(prompt = '') {
  const verify = prompt.includes('(verify)');
  return verify
    ? { outcome: 'success', summary: 'fake OpenCode verified', output: { verification: { passed: true, checks: ['opencode-http-contract'] } }, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} }
    : { outcome: 'success', summary: 'fake OpenCode completed', output: { result: { host: 'opencode' } }, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} };
}
async function fakeOpenCode() {
  const requests = []; let sequence = 0;
  const expected = `Basic ${Buffer.from('opencode:host-test-password').toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (req.headers.authorization !== expected) return send(res, { error: 'unauthorized' }, 401);
    if (req.url === '/global/health') return send(res, { healthy: true, version: 'fake-opencode-host' });
    if (req.url === '/project/current') return send(res, { id: 'project_fake', worktree: '/tmp/fake' });
    if (req.url === '/agent') return send(res, [{ name: 'plan' }, { name: 'build' }]);
    if (req.url === '/session' && req.method === 'POST') return send(res, { id: `ses_${++sequence}` });
    const message = /^\/session\/([^/]+)\/message$/.exec(req.url ?? '');
    if (message && req.method === 'POST') {
      const prompt = body?.parts?.find((part) => part?.type === 'text')?.text ?? '';
      return send(res, { info: { id: `msg_${sequence}`, structured_output: agentResult(prompt) }, parts: [] });
    }
    if (/^\/session\/[^/]+\/diff$/.test(req.url ?? '')) return send(res, []);
    if (/^\/session\/[^/]+\/abort$/.test(req.url ?? '')) return send(res, true);
    if (/^\/session\/[^/]+$/.test(req.url ?? '') && req.method === 'DELETE') return send(res, true);
    return send(res, { error: 'not_found' }, 404);
  });
  function send(res, body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(url, options = {}) {
  for (let i = 0; i < 60; i += 1) {
    try { const response = await fetch(url, options); if (response.status < 500) return response; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-hosts-independent-'));
try {
  const version = await cli(['version']);
  add('public_version_is_v1_1_0', version.code === 0 && version.json?.version === '1.1.0', { result: version.json, stderr: version.stderr });

  const hosts = await cli(['hosts']);
  add('opencode_and_pi_are_reference_hosts', hosts.code === 0 && Array.isArray(hosts.json) && hosts.json[0]?.name === 'opencode' && hosts.json[1]?.name === 'pi', {
    hosts: hosts.json?.slice?.(0, 3)?.map((host) => ({ name: host.name, priority: host.priority, integration: host.integration })),
  });

  const installProject = await initProject(tmp, 'install-project');
  const openInstall = await cli(['host', 'install', 'opencode', '--project', installProject]);
  const piInstall = await cli(['host', 'install', 'pi', '--project', installProject]);
  const openPlugin = path.join(installProject, '.opencode', 'plugins', 'proofgraph.ts');
  const piExtension = path.join(installProject, '.pi', 'extensions', 'proofgraph', 'index.ts');
  add('managed_integrations_install_without_forking_hosts', openInstall.code === 0 && piInstall.code === 0
    && (await fs.stat(openPlugin)).isFile() && (await fs.stat(piExtension)).isFile(), {
    opencode_files: openInstall.json?.installed?.length, pi_files: piInstall.json?.installed?.length,
  });
  const openText = await fs.readFile(openPlugin, 'utf8');
  const piText = await fs.readFile(piExtension, 'utf8');
  add('installed_entrypoints_use_official_host_extension_shapes', /Plugin/.test(openText) && /@opencode-ai\/plugin/.test(openText)
    && /export default function/.test(piText) && /ExtensionAPI/.test(piText), {});
  const installedOpenPackage = JSON.parse(await fs.readFile(path.join(installProject, '.opencode', 'package.json'), 'utf8'));
  add('opencode_install_pins_the_reviewed_plugin_dependency', installedOpenPackage.dependencies?.['@opencode-ai/plugin'] === '1.18.4', {
    dependency: installedOpenPackage.dependencies?.['@opencode-ai/plugin'] ?? null,
  });
  const installedOpenCore = await fs.readFile(path.join(installProject, '.opencode', 'proofgraph', 'core.mjs'), 'utf8');
  add('opencode_model_tool_surface_excludes_human_gate_authority', !installedOpenCore.includes('proofgraph_approve')
    && !installedOpenCore.includes('proofgraph_abort'), {
    approval_tool_exposed: installedOpenCore.includes('proofgraph_approve'),
    abort_tool_exposed: installedOpenCore.includes('proofgraph_abort'),
  });

  const bridgeProject = await initProject(tmp, 'bridge-project');
  const port = await freePort();
  const token = 'independent-host-bridge-token-1234567890';
  const bridge = spawn(process.execPath, [BIN, 'host', 'serve', 'opencode', '--project', bridgeProject, '--port', String(port), '--token', token], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeStderr = ''; bridge.stderr.on('data', (chunk) => { bridgeStderr += chunk.toString('utf8'); });
  try {
    const health = await waitFor(`http://127.0.0.1:${port}/v1/health`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
    const compiled = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'compile', payload: { objective: 'Compile a bounded host contract test' } }),
    });
    const compiledBody = await compiled.json();
    add('host_bridge_is_authenticated_and_command_capable', health.ok && unauthorized.status === 401 && compiled.ok && compiledBody.result?.graph?.schema_version === 1, {
      health_status: health.status, unauthorized_status: unauthorized.status, compile_status: compiled.status,
    });

    const started = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'start', payload: { objective: 'Verify host identity and operator authority boundaries' } }),
    });
    const startedBody = await started.json();
    const runId = startedBody.result?.run_id;
    const impersonated = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'pi', command: 'status', run_id: runId, payload: {} }),
    });
    const rawAbort = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'abort', run_id: runId, payload: { reason: 'black-box bypass attempt' } }),
    });
    const statusAfter = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'opencode', command: 'status', run_id: runId, payload: {} }),
    });
    const statusAfterBody = await statusAfter.json();
    add('opencode_bridge_pins_identity_and_denies_human_gate_authority', started.ok && impersonated.status === 403
      && rawAbort.status === 403 && statusAfter.ok && statusAfterBody.result?.status !== 'aborted', {
      start_status: started.status, impersonation_status: impersonated.status,
      raw_abort_status: rawAbort.status, final_status: statusAfterBody.result?.status,
    });
  } finally {
    bridge.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => bridge.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { bridge.kill('SIGKILL'); resolve(); }, 2000))]);
  }

  const openServer = await fakeOpenCode();
  try {
    const project = await initProject(tmp, 'opencode-project');
    await updateConfig(project, (config) => {
      config.adapters.opencode = {
        enabled: true, transport: 'server', server_url: openServer.url, username: 'opencode', password: 'host-test-password', pure_worker_confirmed: true,
        allow_host_tools: false, require_isolated_workspace: true, keep_sessions: true,
      };
    });
    const run = await cli(['run', 'Return one concise bounded answer', '--adapter', 'opencode', '--project', project], { timeoutMs: 60_000 });
    const report = run.json?.report?.report;
    const messageRequests = openServer.requests.filter((request) => /\/message$/.test(request.url ?? ''));
    add('opencode_server_adapter_completes_verified_graph', run.code === 0 && run.json?.status === 'finalized'
      && report?.terminal_status === 'success' && report?.quality_gate_passed === true && messageRequests.length >= 3, {
      exit_code: run.code, terminal_status: report?.terminal_status, quality_gate_passed: report?.quality_gate_passed, message_requests: messageRequests.length,
      stderr: run.stderr,
    });
    add('opencode_server_uses_authenticated_structured_contract', openServer.requests.length > 0
      && openServer.requests.every((request) => request.authorization === `Basic ${Buffer.from('opencode:host-test-password').toString('base64')}`)
      && messageRequests.every((request) => request.body?.format?.type === 'json_schema'), { request_count: openServer.requests.length });
  } finally { await openServer.close(); }

  const piProject = await initProject(tmp, 'pi-project');
  await updateConfig(piProject, (config) => {
    config.adapters.pi = {
      enabled: true, command: FAKE_PI, allow_host_tools: false,
      env: { FAKE_PI_MODE: 'settled' }, ui_policy: 'deny',
    };
  });
  const piRun = await cli(['run', 'Return one concise bounded answer', '--adapter', 'pi', '--project', piProject], { timeoutMs: 60_000 });
  const piReport = piRun.json?.report?.report;
  add('pi_jsonl_rpc_adapter_completes_verified_graph', piRun.code === 0 && piRun.json?.status === 'finalized'
    && piReport?.terminal_status === 'success' && piReport?.quality_gate_passed === true, {
    exit_code: piRun.code, terminal_status: piReport?.terminal_status, quality_gate_passed: piReport?.quality_gate_passed, stderr: piRun.stderr,
  });

  add('live_vendor_canaries_remain_explicit_release_gate', true, {
    impact: 'The verifier exercises fake OpenCode HTTP and Pi JSONL RPC endpoints only. Real installed hosts, authentication, model behavior, and permissions still require pinned live canaries.',
  }, true);
} catch (error) {
  add('verifier_internal_error', false, { error: error.stack ?? error.message });
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

const failures = results.filter((result) => result.status === 'FAIL');
const summary = {
  schema_version: 1,
  product: 'proofgraph',
  version: '1.1.0',
  generated_at: new Date().toISOString(),
  verifier_type: 'black-box-cli-http-fake-opencode-and-pi-jsonl-rpc',
  production_modules_imported: false,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  residuals_confirmed: results.filter((result) => result.residual).length,
  release_gate: failures.length === 0 ? 'PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED' : 'FAIL',
  results,
};
if (outputPath) { await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`); }
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
