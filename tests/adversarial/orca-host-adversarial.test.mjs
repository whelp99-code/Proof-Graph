import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRequest, setupOrca } from '../orca-test-helpers.mjs';

test('ORCA ADVERSARIAL: Manual permission acknowledgement is fail-closed before dispatch', async () => {
  const ctx = await setupOrca('success', { manualPermissionsConfirmed: false });
  try {
    const doctor = await ctx.adapter.doctor();
    assert.equal(doctor.ok, false);
    assert.match(doctor.error, /Agent Permissions to Manual/);
    await assert.rejects(ctx.adapter.invoke(makeRequest({ projectDir: ctx.project })), /Agent Permissions must be set to Manual/);
    const state = await ctx.state();
    assert.equal(state.commands.some((args) => args[0] === 'orchestration' && args[1] === 'task-create'), false);
  } finally { await ctx.cleanup(); }
});

test('ORCA ADVERSARIAL: ProofGraph and Orca cannot both own workspace isolation', async () => {
  const ctx = await setupOrca();
  try {
    await assert.rejects(
      ctx.adapter.invoke(makeRequest({ projectDir: ctx.project, workspace: { enabled: true, isolated: true, project_dir: ctx.project } })),
      /sole worktree owner/,
    );
    const state = await ctx.state();
    assert.equal(state, null);
  } finally { await ctx.cleanup(); }
});

test('ORCA ADVERSARIAL: mutation capabilities remain disabled before supervised live canary', async () => {
  const ctx = await setupOrca();
  try {
    await assert.rejects(
      ctx.adapter.invoke(makeRequest({ projectDir: ctx.project, toolPolicy: ['proofgraph', 'workspace_write'] })),
      /mutation is disabled/,
    );
  } finally { await ctx.cleanup(); }
});

test('ORCA ADVERSARIAL: stale, missing, wrong-task, and duplicate completion cannot finalize a node', async () => {
  for (const [behavior, expected] of [
    ['stale-dispatch', /matching completion message/],
    ['wrong-task', /matching completion message/],
    ['no-message', /matching completion message/],
    ['duplicate', /duplicate worker_done/],
  ]) {
    const ctx = await setupOrca(behavior, { maxCheckpoints: 1 });
    try {
      await assert.rejects(ctx.adapter.invoke(makeRequest({ projectDir: ctx.project })), expected, behavior);
    } finally { await ctx.cleanup(); }
  }
});

test('ORCA ADVERSARIAL: report path mismatch, traversal, malformed, missing, and symlink reports fail closed', async () => {
  for (const [behavior, expected] of [
    ['wrong-report', /does not match the dispatch contract/],
    ['traversal', /escapes the worktree/],
    ['malformed-report', /not a valid ProofGraph AgentResult JSON/],
    ['missing-report', /ENOENT|no such file/i],
    ['symlink-report', /non-symlink/],
  ]) {
    const ctx = await setupOrca(behavior);
    try {
      await assert.rejects(ctx.adapter.invoke(makeRequest({ projectDir: ctx.project })), expected, behavior);
    } finally { await ctx.cleanup(); }
  }
});

test('ORCA ADVERSARIAL: unallowlisted node agent override is rejected before task creation', async () => {
  const ctx = await setupOrca('success', { allowNodeAgentOverride: true, allowedAgents: ['claude', 'codex'] });
  try {
    await assert.rejects(
      ctx.adapter.invoke(makeRequest({ projectDir: ctx.project, nodeMetadata: { orca_agent: 'untrusted-agent' } })),
      /not allowlisted/,
    );
    assert.equal(await ctx.state(), null);
  } finally { await ctx.cleanup(); }
});

test('ORCA ADVERSARIAL: oversized task specifications are rejected before Orca mutation', async () => {
  const ctx = await setupOrca('success', { maxSpecBytes: 1_000 });
  try {
    await assert.rejects(
      ctx.adapter.invoke(makeRequest({ projectDir: ctx.project, prompt: 'x'.repeat(2_000) })),
      /task spec exceeds/,
    );
    assert.equal(await ctx.state(), null);
  } finally { await ctx.cleanup(); }
});

test('ORCA ADVERSARIAL: execution trace never uses autonomous Orca run or ad hoc terminal injection', async () => {
  const ctx = await setupOrca();
  try {
    await ctx.adapter.invoke(makeRequest({ projectDir: ctx.project }));
    const state = await ctx.state();
    const commands = state.commands.map((args) => args.join(' '));
    for (const forbidden of ['orchestration run', 'terminal send', 'reset', ' exec ', 'computer']) {
      assert.equal(commands.some((value) => ` ${value} `.includes(forbidden)), false, forbidden);
    }
  } finally { await ctx.cleanup(); }
});
