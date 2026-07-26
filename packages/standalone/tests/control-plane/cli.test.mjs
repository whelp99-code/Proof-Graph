import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tempDir, cleanup } from '../helpers.mjs';
const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

async function daemon(t) {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/proofgraphd.mjs'), '--data-dir', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  const line = await new Promise((resolve, reject) => {
    let text = ''; child.stdout.on('data', (chunk) => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('error', reject); child.once('exit', (code) => { if (code && !text) reject(new Error(`daemon exited ${code}`)); });
  });
  const info = JSON.parse(line); return { dir, child, ...info };
}

test('operator CLI reports v3 contract and renders a one-screen snapshot', async (t) => {
  const run = await daemon(t);
  const version = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'version'])).stdout);
  assert.equal(version.version, '5.0.0');
  const env = { ...process.env, PROOFGRAPH_ORG_DATA: run.dir, PROOFGRAPH_CONTROL_URL: run.url };
  const created = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'run', 'Implement and verify a CLI feature'], { env })).stdout);
  assert.ok(created.run_id);
  for (let i = 0; i < 100; i += 1) {
    const status = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'status', created.run_id], { env })).stdout);
    if (status.status.startsWith('completed')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = (await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'snapshot', '--run', created.run_id, '--width', '100', '--height', '30'], { env })).stdout;
  assert.match(snapshot, /ProofGraph Operator/); assert.match(snapshot, /EXECUTION GRAPH/); assert.equal(snapshot.trimEnd().split('\n').length, 30);
  for (const section of ['intelligence', 'context', 'routes', 'model-observations', 'contracts', 'knowledge', 'memory', 'verification']) {
    const value = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'intelligence', created.run_id, section], { env })).stdout);
    assert.ok(value != null, `missing intelligence section ${section}`);
  }
  const fullContexts = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'intelligence', created.run_id, 'context', '--full'], { env })).stdout);
  assert.ok(Array.isArray(fullContexts)); assert.ok(fullContexts.length > 0);
});

test('operator CLI installs the OpenCode observer and custom commands', async (t) => {
  const run = await daemon(t); const project = await tempDir(); t.after(() => cleanup(project));
  const env = { ...process.env, PROOFGRAPH_ORG_DATA: run.dir, PROOFGRAPH_CONTROL_URL: run.url };
  await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'install-opencode', '--project', project], { env });
  assert.ok((await fs.stat(path.join(project, '.opencode/plugins/proofgraph-observer.js'))).isFile());
  assert.ok((await fs.stat(path.join(project, '.opencode/commands/pg-status.md'))).isFile());
  const plugin = await fs.readFile(path.join(project, '.opencode/plugins/proofgraph-observer.js'), 'utf8');
  assert.match(plugin, /tool\.execute\.before/); assert.match(plugin, /x-proofgraph-host-token/);
});

async function freePort() {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('operator CLI covers status lists, approvals, hosts, doctor, TUI and stop', async (t) => {
  const run = await daemon(t);
  const env = { ...process.env, PROOFGRAPH_ORG_DATA: run.dir, PROOFGRAPH_CONTROL_URL: run.url };
  const status = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'status'], { env })).stdout);
  assert.ok(Array.isArray(status));
  assert.deepEqual(JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'approvals'], { env })).stdout), []);
  assert.ok(Array.isArray(JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'hosts'], { env })).stdout)));
  const doctor = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'doctor'], { env })).stdout);
  assert.equal(doctor.ok, true); assert.ok(doctor.checks.some((item) => item.name === 'control_plane' && item.ok));
  const tui = (await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'tui'], { env })).stdout;
  assert.match(tui, /ProofGraph Operator/);
  const stopped = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'stop'], { env })).stdout);
  assert.equal(stopped.ok, true);
});

test('operator CLI start auto-launches daemon and supports OS run and unknown-command failure', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PROOFGRAPH_ORG_DATA: dir, PROOFGRAPH_CONTROL_URL: url };
  try {
    const screen = (await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'start', '--new', 'Implement and verify a started mission', '--port', String(port)], { env, timeout: 15000 })).stdout;
    assert.match(screen, /ProofGraph Operator/);
    const osRun = JSON.parse((await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'run', 'Implement a bounded service', '--type', 'organization_os'], { env })).stdout);
    assert.equal(osRun.run_type, 'organization_os');
    await assert.rejects(exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'unknown-command'], { env }), /Unknown command/);
  } finally {
    await exec(process.execPath, [path.join(ROOT, 'bin/proofgraph.mjs'), 'stop'], { env }).catch(() => {});
  }
});
