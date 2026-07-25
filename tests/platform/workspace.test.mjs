import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../runtime/adapters/process-utils.mjs';
import { WorkspaceEngine } from '../../runtime/workspace/engine.mjs';
import { normalizeWorkspaceActions } from '../../runtime/workspace/actions.mjs';

const runId = 'pg_aaaaaaaaaaaaaaaaaaaaaaaa';

async function git(cwd, args) {
  return runProcess({ command: 'git', args, cwd, timeoutMs: 20_000, maxStdoutBytes: 500_000, maxStderrBytes: 500_000 });
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-workspace-'));
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  const workspaces = path.join(root, 'workspaces');
  await fs.mkdir(project);
  await git(project, ['init', '-b', 'main']);
  await git(project, ['config', 'user.email', 'proofgraph@example.invalid']);
  await git(project, ['config', 'user.name', 'ProofGraph Test']);
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }, null, 2));
  await fs.writeFile(path.join(project, 'test.mjs'), "console.log('ok')\n");
  await fs.writeFile(path.join(project, 'README.md'), '# baseline\n');
  await git(project, ['add', '.']);
  await git(project, ['commit', '-m', 'baseline']);
  const engine = new WorkspaceEngine({ projectDir: project, dataDir: data, rootDir: workspaces, allowedCommands: ['node', 'npm'] });
  return { root, project, data, workspaces, engine };
}

test('workspace creates an isolated detached git worktree with persistent state', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const state = await env.engine.prepare({ run_id: runId });
  assert.equal(state.status, 'ready');
  assert.notEqual(state.worktree_path, env.project);
  assert.equal((await fs.readFile(path.join(state.worktree_path, 'README.md'), 'utf8')).trim(), '# baseline');
  const description = await env.engine.describe(runId);
  assert.equal(description.isolated, true);
  assert.equal(description.network_isolated, false);
});

test('workspace proposal requires challenge-bound approval and produces a hashed receipt', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const proposal = await env.engine.proposeActions({
    run_id: runId,
    node: { node_id: 'develop', kind: 'develop' },
    actions: [
      { type: 'write_file', path: 'src/value.txt', content: '42\n' },
      { type: 'run_command', argv: ['node', 'test.mjs'], timeout_ms: 10_000 },
    ],
  });
  assert.equal(proposal.status, 'approval_required');
  await assert.rejects(env.engine.decide(runId, 'wrong', 'approved'), /challenge mismatch/);
  await env.engine.decide(runId, proposal.challenge, 'approved');
  const executed = await env.engine.executeApproved(runId);
  assert.equal(executed.receipt.status, 'executed');
  assert.match(await fs.readFile(path.join(executed.state.worktree_path, 'src/value.txt'), 'utf8'), /42/);
  assert.equal(executed.receipt.action_results[1].exit_code, 0);
  assert.equal(executed.receipt.receipt_digest.length, 64);
  assert.match(await env.engine.diff(runId), /value\.txt/);
  await env.engine.rollback(runId);
  assert.equal((await env.engine.diff(runId)).trim(), '');
  const closed = await env.engine.close(runId);
  assert.equal(closed.status, 'closed');
});

test('workspace rejects traversal, .git access, unsafe patch paths, and non-allowlisted commands', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  assert.throws(() => normalizeWorkspaceActions([{ type: 'write_file', path: '../escape', content: 'x' }]), /unsafe|relative/);
  assert.throws(() => normalizeWorkspaceActions([{ type: 'delete_file', path: '.git/config' }]), /\.git/);
  assert.throws(() => normalizeWorkspaceActions([{ type: 'apply_patch', patch: '--- a/../../x\n+++ b/../../x\n@@ -0,0 +1 @@\n+x\n' }]), /unsafe/);
  const proposal = await env.engine.proposeActions({ run_id: runId, node: { node_id: 'develop', kind: 'develop' }, actions: [{ type: 'run_command', argv: ['sh', '-c', 'touch pwned'] }] });
  await env.engine.decide(runId, proposal.challenge, 'approved');
  await assert.rejects(env.engine.executeApproved(runId), /not allowlisted/);
  const state = await env.engine.readState(runId);
  assert.equal(state.status, 'ready');
});

test('unauthorized adapter mutation is detected and rolled back', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const state = await env.engine.prepare({ run_id: runId });
  const before = await env.engine.beforeInvocation({ run_id: runId });
  await fs.writeFile(path.join(state.worktree_path, 'README.md'), '# tampered\n');
  await assert.rejects(env.engine.afterInvocation({ run_id: runId, before, allowMutation: false }), /mutated the isolated worktree/);
  assert.equal((await fs.readFile(path.join(state.worktree_path, 'README.md'), 'utf8')).trim(), '# baseline');
});

test('workspace state tampering is detected before execution', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await env.engine.prepare({ run_id: runId });
  const file = env.engine.stateFile(runId);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.status = 'approved';
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(env.engine.readState(runId), /digest mismatch/);
});
