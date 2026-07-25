import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRequest, setupOrca } from '../orca-test-helpers.mjs';

test('Orca host doctor performs only read-only discovery and reports compatibility-bridge boundaries', async () => {
  const ctx = await setupOrca();
  try {
    const doctor = await ctx.adapter.doctor();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.mode, 'orca-orchestration-bridge');
    assert.equal(doctor.host_mode, 'execution-host');
    assert.equal(doctor.compatibility_bridge, true);
    assert.equal(doctor.strict_orca_native, false);
    assert.equal(doctor.manual_permissions_confirmed, true);
    assert.ok(doctor.checks.status);
    assert.ok(doctor.checks.tasks);
    const state = await ctx.state();
    const commands = state.commands.map((args) => args.join(' '));
    assert.deepEqual(commands, [
      'status',
      'repo list',
      'repo show --repo id:repo_1',
      'worktree ps',
      'terminal list',
      'orchestration task-list',
      'orchestration gate-list --status pending',
      'orchestration inbox --limit 20',
    ]);
  } finally { await ctx.cleanup(); }
});


test('Orca host requires an explicit repo selector before dispatch', async () => {
  const ctx = await setupOrca('success', { repoSelector: null });
  try {
    const doctor = await ctx.adapter.doctor();
    assert.equal(doctor.ok, false);
    assert.match(doctor.error, /repo_selector/);
    await assert.rejects(
      () => ctx.adapter.invoke(makeRequest({ projectDir: ctx.project })),
      /repo_selector/,
    );
    const state = await ctx.state();
    const commands = state?.commands?.map((args) => args.join(' ')) ?? [];
    assert.equal(commands.some((value) => value.startsWith('orchestration task-create')), false);
  } finally { await ctx.cleanup(); }
});

test('Orca host maps a ProofGraph node to Task, worktree, terminal, Dispatch, and exact worker report', async () => {
  const ctx = await setupOrca();
  try {
    const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.summary, 'orca fake completed');
    assert.match(result.metadata.orca.task_id, /^task_/);
    assert.match(result.metadata.orca.dispatch_id, /^dispatch_/);
    assert.match(result.metadata.orca.worktree_id, /^wt_/);
    assert.match(result.metadata.orca.terminal_handle, /^terminal_/);
    assert.equal(result.metadata.orca.agent, 'claude');
    assert.equal(result.metadata.orca.integration_mode, 'compatibility_bridge');
    assert.equal(result.metadata.orca.strict_orca_native, false);
    assert.match(result.metadata.orca.report_path, /\.proofgraph\/orca-results\/req_orca_direct_123\.json$/);

    const state = await ctx.state();
    const commands = state.commands.map((args) => args.join(' '));
    assert.ok(commands.some((value) => value.startsWith('orchestration task-create ')));
    assert.ok(commands.some((value) => value.startsWith('worktree create ')));
    assert.ok(commands.some((value) => value.startsWith('terminal wait ')));
    assert.ok(commands.some((value) => value.startsWith('orchestration dispatch ')));
    assert.ok(commands.some((value) => value.startsWith('orchestration check ')));
    assert.equal(commands.some((value) => /orchestration run|terminal send|\bexec\b|\bcomputer\b/.test(value)), false);
  } finally { await ctx.cleanup(); }
});

test('Orca host preserves independent verifier output contract', async () => {
  const ctx = await setupOrca();
  try {
    const result = await ctx.adapter.invoke(makeRequest({ kind: 'verify', projectDir: ctx.project }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.output.verification.passed, true);
    assert.deepEqual(result.output.verification.checks, ['orca-contract']);
    assert.equal(result.metadata.orca.agent, 'claude');
  } finally { await ctx.cleanup(); }
});

test('Orca host survives one decision gate or stale completion before the matching worker_done', async () => {
  for (const [behavior, counter] of [['decision-then-done', 'decision_gates_seen'], ['stale-then-done', 'stale_dispatch_messages'], ['missing-dispatch-then-done', 'stale_dispatch_messages']]) {
    const ctx = await setupOrca(behavior);
    try {
      const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
      assert.equal(result.outcome, 'success', behavior);
      assert.equal(result.metadata.orca[counter], 1, behavior);
    } finally { await ctx.cleanup(); }
  }
});

test('Orca host projects an unresolved decision gate as an explicit blocked result', async () => {
  const ctx = await setupOrca('decision-gate', { maxCheckpoints: 1 });
  try {
    const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
    assert.equal(result.outcome, 'blocked');
    assert.match(result.summary, /Choose API compatibility mode/);
    assert.equal(result.metadata.orca.decision_gates_seen, 2);
    assert.equal(result.output.orca_gate.gateId, 'gate_1');
  } finally { await ctx.cleanup(); }
});

test('Orca host converts credential escalation to a non-retryable security Failure Packet', async () => {
  const ctx = await setupOrca('escalation');
  try {
    const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure.failure_type, 'security_risk');
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.recommended_route, 'human');
    assert.match(result.failure.summary, /credentials/i);
  } finally { await ctx.cleanup(); }
});

test('Orca host refreshes a stale terminal handle before dispatch', async () => {
  const ctx = await setupOrca('stale-terminal');
  try {
    const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
    assert.equal(result.outcome, 'success');
    assert.match(result.metadata.orca.terminal_handle, /^terminal_fresh_/);
  } finally { await ctx.cleanup(); }
});

test('Orca host uses bounded checkpoint recovery for a transient orchestration timeout', async () => {
  for (const behavior of ['checkpoint', 'timeout-error']) {
    const ctx = await setupOrca(behavior, { maxCheckpoints: 2 });
    try {
      const result = await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
      assert.equal(result.outcome, 'success', behavior);
      const state = await ctx.state();
      assert.equal(state.checks, 2, behavior);
      assert.ok(state.commands.some((args) => args[0] === 'orchestration' && args[1] === 'task-list'));
    } finally { await ctx.cleanup(); }
  }
});

test('Orca host can optionally accept bounded inline AgentResult but defaults to exact report files', async () => {
  const strict = await setupOrca('body-result');
  try {
    await assert.rejects(strict.adapter.invoke(makeRequest({ projectDir: strict.project })), /exact contracted report path/);
  } finally { await strict.cleanup(); }

  const compatibility = await setupOrca('body-result', { allowInlineResult: true });
  try {
    const result = await compatibility.adapter.invoke(makeRequest({ projectDir: compatibility.project }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.output.result.host, 'orca');
  } finally { await compatibility.cleanup(); }
});
