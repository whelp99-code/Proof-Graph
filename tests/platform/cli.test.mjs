import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../runtime/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin/proofgraph.mjs');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? ROOT, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI initializes a project and exposes templates and doctor status', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const init = await run(['init', root]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).ok, true);
  const templates = await run(['templates', '--project', root]);
  assert.equal(templates.code, 0, templates.stderr);
  assert.equal(JSON.parse(templates.stdout).length, 7);
  const doctor = await run(['doctor', '--project', root]);
  assert.equal(doctor.code, 0, doctor.stderr);
  const status = JSON.parse(doctor.stdout);
  assert.equal(status.product, 'proofgraph');
  assert.equal(status.version, VERSION);
});

test('CLI compiles a template and runs the safe mock adapter', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-cli-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run(['init', root]);
  const compiled = await run(['compile', 'Fix the authorization regression without changing API behavior', '--template', 'bugfix', '--project', root]);
  assert.equal(compiled.code, 0, compiled.stderr);
  assert.equal(JSON.parse(compiled.stdout).metadata.template.name, 'bugfix');
  const executed = await run(['run', 'Explain one deterministic invariant in this repository', '--project', root]);
  assert.equal(executed.code, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).status, 'finalized');
});

test('CLI auto-matches the AI Agent TUI template from a natural-language command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-cli-agent-tui-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run(['init', root]);
  const compiled = await run(['compile', 'AI 에이전트 TUI를 개발하라', '--project', root]);
  assert.equal(compiled.code, 0, compiled.stderr);
  const result = JSON.parse(compiled.stdout);
  assert.equal(result.metadata.template.name, 'agent-tui');
  assert.equal(result.metadata.selection, 'auto');
  assert.equal(result.assessment.profile.template_name, 'agent-tui');
  assert.equal(result.graph.nodes.filter((node) => node.kind === 'research').length, 6);

  const typoVariant = await run(['compile', 'AI에인전트 TUI를 개발하라', '--project', root]);
  assert.equal(typoVariant.code, 0, typoVariant.stderr);
  const typoResult = JSON.parse(typoVariant.stdout);
  assert.equal(typoResult.metadata.template.name, 'agent-tui');
  assert.equal(typoResult.metadata.selection, 'auto');
});



test('CLI can complete an auto-matched AI Agent TUI graph through explicit human approval', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-cli-agent-tui-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run(['init', root]);
  const started = await run(['run', 'AI에인전트 TUI를 개발하라', '--adapter', 'mock', '--project', root]);
  assert.equal(started.code, 0, started.stderr);
  const waiting = JSON.parse(started.stdout);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.pending_approvals.length, 1);
  const approval = waiting.pending_approvals[0];

  const approved = await run([
    'approve', waiting.run_id, approval.approval_id, approval.challenge, 'approve', '--project', root,
  ]);
  assert.equal(approved.code, 0, approved.stderr);
  const approvalResult = JSON.parse(approved.stdout);
  assert.equal(approvalResult.status, 'active');
  assert.equal(approvalResult.decision, 'approved');

  const resumed = await run(['resume', waiting.run_id, '--adapter', 'mock', '--project', root]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.status, 'finalized');
  assert.equal(result.report.report.terminal_status, 'success');
  assert.equal(result.report.report.quality_gate_passed, true);
});

test('CLI start allows breakpoint configuration before resume', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-cli-debug-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run(['init', root]);
  const started = await run(['start', 'Explain one deterministic invariant in this repository', '--project', root]);
  assert.equal(started.code, 0, started.stderr);
  const runId = JSON.parse(started.stdout).run_id;
  const breakpoint = await run(['debug', 'break', runId, 'kind', 'direct', '--project', root]);
  assert.equal(breakpoint.code, 0, breakpoint.stderr);
  const resumed = await run(['resume', runId, '--project', root]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, 'paused');
});
