#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
function value(flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
}
const command = value('--command', 'orca');
const output = value('--output');
const manualConfirmed = argv.includes('--manual-confirmed');
const timeoutMs = Number(value('--timeout-ms', '30000'));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
  console.error('--timeout-ms must be an integer between 1000 and 120000');
  process.exit(2);
}

const SAFE_COMMANDS = Object.freeze([
  ['status'],
  ['repo', 'list'],
  ['worktree', 'ps'],
  ['terminal', 'list'],
  ['orchestration', 'task-list'],
  ['orchestration', 'gate-list', '--status', 'pending'],
  ['orchestration', 'inbox', '--limit', '20'],
  ['automations', 'list'],
  ['skills', 'get', 'orchestration', '--full'],
]);

function run(args) {
  return new Promise((resolve) => {
    const logical = args.includes('--json') ? args : [...args, '--json'];
    // Source archives and ZIP extractors do not always preserve executable bits.
    // A JavaScript CLI shim is therefore launched through the current Node runtime,
    // while the real `orca` binary continues to execute directly.
    const isJavaScriptShim = /\.(?:mjs|cjs|js)$/i.test(command);
    const executable = isJavaScriptShim ? process.execPath : command;
    const spawnArgs = isJavaScriptShim ? [command, ...logical] : logical;
    const child = spawn(executable, spawnArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, args: logical, code: null, signal: null, stdout, stderr, error: error.message });
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let parsed = null;
      try { parsed = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({
        ok: code === 0,
        args: logical,
        code,
        signal,
        json: parsed,
        stdout: parsed ? undefined : stdout.slice(0, 20000),
        stderr: stderr.slice(0, 20000),
        error: signal === 'SIGKILL' ? `timeout after ${timeoutMs}ms` : null,
      });
    });
  });
}

const startedAt = new Date().toISOString();
const results = [];
for (const args of SAFE_COMMANDS) results.push(await run(args));
const commandSurfaceSafe = results.every((entry) => {
  const joined = entry.args.join(' ');
  return !/(?:^|\s)(?:worktree\s+(?:create|rm)|terminal\s+(?:send|create|close)|orchestration\s+(?:task-create|dispatch|run|reset|gate-create|gate-resolve|task-update)|automations\s+(?:create|run)|exec|computer)(?:\s|$)/.test(joined);
});
const allReadOnlyPassed = results.every((entry) => entry.ok);
const status = results[0]?.json ?? null;
const orchestrationEvidence = results.find((entry) => entry.args[0] === 'skills')?.json ?? null;
const report = {
  schema_version: 1,
  tool: 'proofgraph-orca-live-preflight',
  generated_at: new Date().toISOString(),
  started_at: startedAt,
  cwd: process.cwd(),
  command,
  mode: 'read-only',
  mutation_commands_executed: false,
  command_surface_safe: commandSurfaceSafe,
  manual_permissions_confirmed_by_operator: manualConfirmed,
  checks: results,
  summary: {
    read_only_checks_passed: results.filter((entry) => entry.ok).length,
    read_only_checks_failed: results.filter((entry) => !entry.ok).length,
    total: results.length,
    runtime_status_available: Boolean(status),
    orchestration_skill_available: Boolean(orchestrationEvidence),
  },
  integration: {
    mode: 'compatibility_bridge',
    strict_orca_native: false,
    proofgraph_state_authority: true,
    orca_execution_authority: true,
    orca_workspace_authority: true,
  },
  release_gate: !commandSurfaceSafe || !allReadOnlyPassed
    ? 'FAIL_READ_ONLY_PREFLIGHT'
    : manualConfirmed
      ? 'PASS_READ_ONLY_ORCA_CANARY_READY'
      : 'PASS_READ_ONLY_MANUAL_PERMISSION_CONFIRMATION_REQUIRED',
  next_step: !manualConfirmed
    ? 'In Orca, set Settings → Agents → Agent Permissions to Manual, then rerun with --manual-confirmed.'
    : 'Run the bounded read-only canary with at most three workers; inspect git status before and after.',
};

if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (!commandSurfaceSafe || !allReadOnlyPassed) process.exitCode = 1;
