import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin/proofgraph.mjs');
const CANARY = path.join(ROOT, 'scripts/canary.mjs');

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: options.cwd ?? ROOT, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('mock canary executes, persists its report, and passes the release gate', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-canary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await run(CLI, ['init', root])).code, 0);
  const outputPath = path.join(root, 'canary-result.json');
  const result = await run(CANARY, ['--project', root, '--adapter', 'mock', '--output', outputPath]);
  assert.equal(result.code, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const persisted = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(stdout.release_gate, 'CANARY_PASS');
  assert.equal(stdout.doctor.status, 'ready');
  assert.equal(stdout.doctor.invocable, true);
  assert.deepEqual(persisted, stdout);
});

test('disabled vendor adapter fails closed before invocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-canary-disabled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await run(CLI, ['init', root])).code, 0);
  const result = await run(CANARY, ['--project', root, '--adapter', 'claude']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not invocable for canary: disabled/);
});
