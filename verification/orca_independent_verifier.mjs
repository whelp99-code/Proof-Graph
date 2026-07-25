#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Black-box verifier: this file intentionally does not import ProofGraph production modules.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'proofgraph.mjs');
const PACKAGE = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const FAKE_ORCA = path.join(ROOT, 'tests', 'fixtures', 'fake-orca-cli.mjs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
const checks = [];

function add(name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), ...details });
}


async function runExternal(executable, argv, options = {}) {
  const child = spawn(executable, argv, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const result = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (result.code !== 0) throw new Error(`${executable} ${argv.join(' ')} failed: ${stderr || stdout}`);
  return { ...result, stdout, stderr };
}

async function command(argv, options = {}) {
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'TIMEOUT' });
    }, options.timeoutMs ?? 30_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
  return { ...exitCode, stdout, stderr, json };
}

function configFor({ stateFile, fakeRoot, behavior = 'success', manual = true, workspace = false }) {
  return {
    schema_version: 1,
    default_adapter: 'orca',
    data_dir: '.proofgraph',
    routing: {
      direct: 'orca', researcher: 'orca', planner: 'orca',
      developer: 'orca', verifier: 'orca', synthesizer: 'orca',
    },
    kernel: {
      max_orchestration_rounds: 120,
      max_context_nodes: 24,
      max_context_bytes: 512000,
      fail_fast_on_adapter_error: false,
    },
    workspace: {
      enabled: workspace,
      backend: 'git-worktree',
      require_approval: true,
      require_clean: !workspace,
      allowed_commands: ['node'],
      command_timeout_ms: 300000,
      max_command_output_bytes: 1000000,
    },
    debugger: { enabled: true, event_poll_ms: 250 },
    adapters: {
      orca: {
        enabled: true,
        command: process.execPath,
        args: [FAKE_ORCA],
        env: {
          FAKE_ORCA_STATE: stateFile,
          FAKE_ORCA_ROOT: fakeRoot,
          FAKE_ORCA_BEHAVIOR: behavior,
        },
        manual_permissions_confirmed: manual,
        repo_selector: 'id:repo_1',
        require_explicit_repo_selector: true,
        setup: 'inherit',
        agent_map: {
          direct: 'claude', researcher: 'claude', planner: 'claude',
          developer: 'claude', verifier: 'claude', synthesizer: 'claude',
        },
        allowed_agents: ['claude'],
        allow_node_agent_override: false,
        allow_workspace_mutation: false,
        check_timeout_ms: 1000,
        terminal_wait_ms: 1000,
        max_checkpoints: 1,
        max_spec_bytes: 60000,
        max_report_bytes: 256000,
        report_dir: '.proofgraph/orca-results',
        allow_inline_result: false,
      },
    },
    templates: {},
  };
}

async function makeProject(base, name, options = {}) {
  const project = path.join(base, name);
  const stateFile = path.join(base, `${name}-orca-state.json`);
  const fakeRoot = path.join(base, `${name}-orca-root`);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, 'proofgraph.config.json'),
    `${JSON.stringify(configFor({ stateFile, fakeRoot, ...options }), null, 2)}\n`,
    { mode: 0o600 },
  );
  return { project, stateFile, fakeRoot };
}

function forbiddenCommands(state) {
  const commands = (state?.commands ?? []).map((items) => items.join(' '));
  return commands.filter((value) => (
    /(?:^|\s)orchestration\s+(?:run|reset|exec|computer)(?:\s|$)/.test(value)
    || /(?:^|\s)terminal\s+send(?:\s|$)/.test(value)
    || /(?:^|\s)(?:exec|computer)(?:\s|$)/.test(value)
  ));
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-orca-independent-'));
try {
  const version = await command(['version']);
  add('public_cli_version', version.code === 0 && version.json?.product === 'proofgraph' && version.json?.version === PACKAGE.version, {
    exit_code: version.code,
    result: version.json,
  });

  const good = await makeProject(tmp, 'good', { behavior: 'success', manual: true });
  const adapters = await command(['adapters', '--project', good.project]);
  const orca = Array.isArray(adapters.json) ? adapters.json.find((row) => row.name === 'orca') : null;
  add('doctor_ready_for_canary', adapters.code === 0 && orca?.ok === true && orca?.status === 'ready_for_canary' && orca?.mode === 'orca-orchestration-bridge' && orca?.host_mode === 'execution-host', {
    exit_code: adapters.code,
    orca,
  });
  add('doctor_declares_boundaries', orca?.compatibility_bridge === true && orca?.strict_orca_native === false && orca?.manual_permissions_confirmed === true && orca?.live_canary_required === true, { orca });

  const run = await command([
    'run', 'Return one concise bounded answer', '--adapter', 'orca', '--project', good.project,
  ], { timeoutMs: 60_000 });
  const report = run.json?.report?.report;
  add('verified_graph_completion', run.code === 0 && run.json?.status === 'finalized' && report?.terminal_status === 'success' && report?.quality_gate_passed === true, {
    exit_code: run.code,
    run_id: run.json?.run_id,
    terminal_status: report?.terminal_status,
    quality_gate_passed: report?.quality_gate_passed,
  });
  const nodes = report?.nodes ?? [];
  const orcaNodes = nodes.filter((node) => ['direct', 'verify', 'synthesize'].includes(node.kind));
  add('task_dispatch_metadata_preserved', orcaNodes.length === 3 && orcaNodes.every((node) => node.output?.adapter === 'orca'), {
    nodes: orcaNodes.map((node) => ({ node_id: node.node_id, kind: node.kind, status: node.status, adapter: node.output?.adapter })),
  });
  const integrity = await command(['integrity', run.json?.run_id ?? 'missing', '--project', good.project]);
  add('graph_integrity_after_orca', integrity.code === 0 && integrity.json?.ok === true && Array.isArray(integrity.json?.failed_checks) && integrity.json.failed_checks.length === 0, {
    exit_code: integrity.code,
    failed_checks: integrity.json?.failed_checks,
  });
  const goodState = JSON.parse(await fs.readFile(good.stateFile, 'utf8'));
  const goodForbidden = forbiddenCommands(goodState);
  add('manual_dispatch_only', goodForbidden.length === 0, {
    command_count: goodState.commands?.length ?? 0,
    forbidden: goodForbidden,
  });
  const taskSpecs = Object.values(goodState.tasks ?? {}).map((task) => task.spec ?? '');
  add('worker_contract_injected', taskSpecs.length >= 3 && taskSpecs.every((spec) => spec.includes('worker_done exactly once') && spec.includes('ProofGraph AgentResult JSON object')), {
    task_count: taskSpecs.length,
  });

  const parallel = await makeProject(tmp, 'parallel', { behavior: 'success', manual: true });
  const parallelRun = await command([
    'run', 'Compare multiple independent implementation approaches and verify the evidence',
    '--template', 'research', '--adapter', 'orca', '--project', parallel.project,
  ], { timeoutMs: 120_000 });
  const parallelReport = parallelRun.json?.report?.report;
  const parallelResearch = (parallelReport?.nodes ?? []).filter((node) => node.kind === 'research');
  const parallelState = JSON.parse(await fs.readFile(parallel.stateFile, 'utf8'));
  const checkCommands = (parallelState.commands ?? []).filter((items) => items.includes('check'));
  add('parallel_fanout_uses_non_consuming_checks',
    parallelRun.code === 0
      && parallelReport?.terminal_status === 'success'
      && parallelReport?.quality_gate_passed === true
      && parallelResearch.length >= 2
      && parallelResearch.every((node) => node.status === 'succeeded')
      && checkCommands.length >= parallelResearch.length
      && checkCommands.every((items) => items.includes('--all')), {
      terminal_status: parallelReport?.terminal_status,
      quality_gate_passed: parallelReport?.quality_gate_passed,
      research_nodes: parallelResearch.map((node) => ({ node_id: node.node_id, status: node.status })),
      check_commands: checkCommands,
    });

  const unsafe = await makeProject(tmp, 'unsafe', { behavior: 'traversal', manual: true });
  const unsafeRun = await command([
    'run', 'Return one concise bounded answer', '--adapter', 'orca', '--project', unsafe.project,
  ], { timeoutMs: 60_000 });
  const unsafeReport = unsafeRun.json?.report?.report;
  const unsafeFailure = unsafeReport?.failures?.[0]?.failure;
  add('report_path_traversal_fails_closed', unsafeRun.code === 0 && unsafeReport?.terminal_status === 'failed' && unsafeReport?.quality_gate_passed === false && /escapes the worktree/i.test(unsafeFailure?.observed ?? ''), {
    terminal_status: unsafeReport?.terminal_status,
    quality_gate_passed: unsafeReport?.quality_gate_passed,
    failure: unsafeFailure,
  });

  const noManual = await makeProject(tmp, 'no-manual', { behavior: 'success', manual: false });
  const noManualDoctor = await command(['adapters', '--project', noManual.project]);
  const blockedOrca = Array.isArray(noManualDoctor.json) ? noManualDoctor.json.find((row) => row.name === 'orca') : null;
  add('manual_permission_acknowledgement_fails_closed', noManualDoctor.code === 0 && blockedOrca?.ok === false && blockedOrca?.invocable === false && /Permissions to Manual/i.test(blockedOrca?.error ?? ''), {
    orca: blockedOrca,
  });

  const noRepo = await makeProject(tmp, 'no-repo', { behavior: 'success', manual: true });
  const noRepoConfigPath = path.join(noRepo.project, 'proofgraph.config.json');
  const noRepoConfig = JSON.parse(await fs.readFile(noRepoConfigPath, 'utf8'));
  noRepoConfig.adapters.orca.repo_selector = null;
  await fs.writeFile(noRepoConfigPath, `${JSON.stringify(noRepoConfig, null, 2)}
`);
  const noRepoDoctor = await command(['adapters', '--project', noRepo.project]);
  const noRepoOrca = Array.isArray(noRepoDoctor.json) ? noRepoDoctor.json.find((row) => row.name === 'orca') : null;
  add('explicit_repo_selector_fails_closed', noRepoDoctor.code === 0 && noRepoOrca?.ok === false && noRepoOrca?.invocable === false && /repo_selector/i.test(noRepoOrca?.error ?? ''), {
    orca: noRepoOrca,
  });

  const doubleOwner = await makeProject(tmp, 'double-owner', { behavior: 'success', manual: true, workspace: true });
  await fs.writeFile(path.join(doubleOwner.project, 'README.md'), 'ProofGraph Orca black-box workspace boundary test\n');
  await runExternal('git', ['init', '--quiet'], { cwd: doubleOwner.project });
  await runExternal('git', ['config', 'user.email', 'proofgraph@example.invalid'], { cwd: doubleOwner.project });
  await runExternal('git', ['config', 'user.name', 'ProofGraph Verifier'], { cwd: doubleOwner.project });
  await runExternal('git', ['add', 'README.md', 'proofgraph.config.json'], { cwd: doubleOwner.project });
  await runExternal('git', ['commit', '--quiet', '-m', 'test: initialize black-box repository'], { cwd: doubleOwner.project });
  const doubleRun = await command([
    'run', 'Return one concise bounded answer', '--adapter', 'orca', '--project', doubleOwner.project,
  ], { timeoutMs: 60_000 });
  const doubleReport = doubleRun.json?.report?.report;
  const doubleObserved = doubleReport?.failures?.map((entry) => entry.failure?.observed ?? '').join('\n') ?? '';
  add('double_workspace_ownership_rejected', doubleRun.code === 0 && doubleReport?.quality_gate_passed === false && /sole worktree owner/i.test(doubleObserved), {
    terminal_status: doubleReport?.terminal_status,
    failures: doubleReport?.failures,
  });
} catch (error) {
  add('verifier_internal', false, { error: error.stack || error.message });
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

const result = {
  schema_version: 1,
  product: 'proofgraph',
  version: PACKAGE.version,
  verifier: 'orca-black-box',
  generated_at: new Date().toISOString(),
  boundary: 'CLI subprocess and persisted artifacts only; no ProofGraph production module imports',
  passed: checks.filter((check) => check.ok).length,
  failed: checks.filter((check) => !check.ok).length,
  total: checks.length,
  checks,
  release_gate: checks.every((check) => check.ok)
    ? 'PASS_OFFLINE_ORCA_LIVE_CANARY_REQUIRED'
    : 'FAIL',
};

if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`);
console.log(`\n${result.passed} passed, ${result.failed} failed (${result.total} total)`);
if (result.failed) process.exitCode = 1;
