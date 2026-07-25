import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'orca-live-preflight.mjs');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-orca-cli.mjs');

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--command', FAKE, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function mutating(command) {
  const joined = command.join(' ');
  return /(?:^|\s)(?:worktree\s+(?:create|rm)|terminal\s+(?:send|create|close)|orchestration\s+(?:task-create|dispatch|run|reset|gate-create|gate-resolve|task-update)|automations\s+(?:create|run)|exec|computer)(?:\s|$)/.test(joined);
}

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-orca-preflight-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return {
    FAKE_ORCA_STATE: path.join(tmp, 'state.json'),
    FAKE_ORCA_ROOT: path.join(tmp, 'root'),
    FAKE_ORCA_BEHAVIOR: 'success',
  };
}

test('Orca live preflight performs only read-only discovery and becomes canary-ready after explicit Manual acknowledgement', async (t) => {
  const env = await fixture(t);
  const result = await run(['--manual-confirmed'], env);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'read-only');
  assert.equal(report.mutation_commands_executed, false);
  assert.equal(report.command_surface_safe, true);
  assert.equal(report.manual_permissions_confirmed_by_operator, true);
  assert.equal(report.release_gate, 'PASS_READ_ONLY_ORCA_CANARY_READY');
  assert.equal(report.summary.read_only_checks_failed, 0);
  const state = JSON.parse(await fs.readFile(env.FAKE_ORCA_STATE, 'utf8'));
  assert.ok((state.commands ?? []).length >= 9);
  assert.equal((state.commands ?? []).some(mutating), false);
});

test('Orca live preflight never infers the UI permission setting and preserves an explicit confirmation gate', async (t) => {
  const env = await fixture(t);
  const result = await run([], env);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.manual_permissions_confirmed_by_operator, false);
  assert.equal(report.release_gate, 'PASS_READ_ONLY_MANUAL_PERMISSION_CONFIRMATION_REQUIRED');
  assert.match(report.next_step, /Agent Permissions to Manual/i);
});
