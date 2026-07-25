import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin', 'proofgraph.mjs');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI lists prioritized hosts and installs OpenCode and Pi integrations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const listed = await run(['hosts']);
  assert.equal(listed.code, 0, listed.stderr);
  const hosts = JSON.parse(listed.stdout);
  assert.deepEqual(hosts.slice(0, 2).map((host) => host.name), ['opencode', 'pi']);

  for (const host of ['opencode', 'pi']) {
    const installed = await run(['host', 'install', host, '--project', root]);
    assert.equal(installed.code, 0, installed.stderr);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.host, host);
    assert.ok(result.installed.length >= 3);
  }
  assert.equal((await fs.stat(path.join(root, '.opencode', 'plugins', 'proofgraph.ts'))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, '.pi', 'extensions', 'proofgraph', 'index.ts'))).isFile(), true);
});

test('CLI abort explicitly releases an active run', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-host-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await run(['init', root])).code, 0);
  const started = await run(['start', 'Create a bounded host abort test', '--project', root]);
  assert.equal(started.code, 0, started.stderr);
  const runId = JSON.parse(started.stdout).run_id;
  const aborted = await run(['abort', runId, 'operator requested host shutdown', '--project', root]);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.equal(JSON.parse(aborted.stdout).status, 'aborted');
});
