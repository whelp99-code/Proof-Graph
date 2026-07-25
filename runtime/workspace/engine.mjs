import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson, nowIso, sha256 } from '../../server/lib/canonical.mjs';
import { SecurityError, StateError, ValidationError } from '../../server/lib/errors.mjs';
import { runDirectory } from '../../server/lib/store.mjs';
import { runProcess } from '../adapters/process-utils.mjs';
import { normalizeWorkspaceActions, safeRelativePath } from './actions.mjs';

const DEFAULT_COMMANDS = ['npm', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'bun', 'pnpm', 'yarn'];

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, value, { mode: 0o600 });
  await fs.rename(temp, file);
}

function workspaceId(projectDir) {
  return sha256(path.resolve(projectDir)).slice(0, 20);
}

function stateDigest(state) {
  const clone = structuredClone(state);
  delete clone.state_digest;
  return sha256(canonicalJson(clone));
}

export class WorkspaceEngine {
  constructor(options = {}) {
    this.projectDir = path.resolve(options.projectDir ?? process.cwd());
    this.dataDir = path.resolve(options.dataDir ?? path.join(this.projectDir, '.proofgraph', 'runs'));
    this.rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), '.proofgraph', 'workspaces', workspaceId(this.projectDir)));
    this.requireClean = options.requireClean ?? true;
    this.allowedCommands = new Set(options.allowedCommands ?? DEFAULT_COMMANDS);
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 300_000;
    this.maxCommandOutputBytes = options.maxCommandOutputBytes ?? 1_000_000;
    this.prepareLocks = new Map();
  }

  stateFile(runId) { return path.join(runDirectory(this.dataDir, runId), 'workspace', 'state.json'); }
  receiptDir(runId) { return path.join(runDirectory(this.dataDir, runId), 'workspace', 'receipts'); }
  worktreePath(runId) { return path.join(this.rootDir, runId); }

  async git(args, options = {}) {
    return runProcess({
      command: 'git', args, cwd: options.cwd ?? this.projectDir, stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 60_000, maxStdoutBytes: options.maxStdoutBytes ?? 2_000_000,
      maxStderrBytes: options.maxStderrBytes ?? 500_000, signal: options.signal,
    });
  }

  async verifyRepository() {
    const root = (await this.git(['rev-parse', '--show-toplevel'])).stdout.trim();
    const resolvedRoot = await fs.realpath(root);
    const resolvedProject = await fs.realpath(this.projectDir);
    if (resolvedRoot !== resolvedProject) throw new ValidationError(`project_dir must be the Git repository root: ${root}`);
    const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const rawStatus = (await this.git(['status', '--porcelain=v1', '--untracked-files=normal'])).stdout;
    const relevantLines = rawStatus.split(/\r?\n/).filter(Boolean).filter((line) => {
      const file = line.slice(3).replaceAll('\\', '/');
      return file !== '.proofgraph' && !file.startsWith('.proofgraph/');
    });
    const dirty = relevantLines.join('\n');
    if (this.requireClean && dirty) throw new StateError('Workspace engine requires a clean source checkout', { status: dirty.slice(0, 20_000) });
    return { root, head, source_dirty: Boolean(dirty) };
  }

  async readState(runId, options = {}) {
    let state;
    try { state = JSON.parse(await fs.readFile(this.stateFile(runId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && options.allowMissing) return null;
      if (error instanceof SyntaxError) throw new SecurityError('Workspace state JSON is corrupt');
      throw error;
    }
    if (state.state_digest !== stateDigest(state)) throw new SecurityError('Workspace state digest mismatch');
    if (state.run_id !== runId || path.resolve(state.project_dir) !== this.projectDir) throw new SecurityError('Workspace state identity mismatch');
    return state;
  }

  async writeState(state) {
    const next = { ...state, updated_at: nowIso() };
    next.state_digest = stateDigest(next);
    await atomicWrite(this.stateFile(state.run_id), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async prepare(input) {
    const runId = input.run_id;
    if (this.prepareLocks.has(runId)) return this.prepareLocks.get(runId);
    const promise = this._prepare(runId).finally(() => this.prepareLocks.delete(runId));
    this.prepareLocks.set(runId, promise);
    return promise;
  }

  async _prepare(runId) {
    const current = await this.readState(runId, { allowMissing: true });
    if (current) {
      if (!(await exists(current.worktree_path))) throw new SecurityError('Workspace path disappeared after creation');
      return current;
    }
    const repo = await this.verifyRepository();
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const worktree = this.worktreePath(runId);
    if (await exists(worktree)) throw new StateError(`Workspace path already exists without state: ${worktree}`);
    await this.git(['worktree', 'add', '--detach', worktree, repo.head]);
    const state = await this.writeState({
      schema_version: 1,
      run_id: runId,
      project_dir: this.projectDir,
      worktree_path: worktree,
      base_commit: repo.head,
      source_dirty: repo.source_dirty,
      status: 'ready',
      pending: null,
      approvals: [],
      receipts: [],
      created_at: nowIso(),
    });
    return state;
  }

  async describe(runId = null) {
    if (!runId) return { enabled: true, isolated: true, backend: 'git-worktree', project_dir: this.projectDir, path: null };
    const state = await this.readState(runId, { allowMissing: true });
    return {
      enabled: true,
      isolated: true,
      backend: 'git-worktree',
      project_dir: this.projectDir,
      path: state?.worktree_path ?? this.worktreePath(runId),
      base_commit: state?.base_commit ?? null,
      status: state?.status ?? 'unprepared',
      network_isolated: false,
    };
  }

  async computeDiff(worktreePath) {
    // Intent-to-add makes untracked files visible in a binary diff without staging content.
    await this.git(['add', '-N', '--', '.'], { cwd: worktreePath });
    return (await this.git(['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: worktreePath })).stdout;
  }

  async snapshot(runId) {
    const state = await this.prepare({ run_id: runId });
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: state.worktree_path });
    const diff = await this.computeDiff(state.worktree_path);
    return { status: status.stdout, diff_sha256: sha256(diff), status_sha256: sha256(status.stdout) };
  }

  async beforeInvocation({ run_id: runId }) {
    await this.prepare({ run_id: runId });
    return this.snapshot(runId);
  }

  async afterInvocation({ run_id: runId, before, allowMutation = false }) {
    const after = await this.snapshot(runId);
    const changed = before.diff_sha256 !== after.diff_sha256 || before.status_sha256 !== after.status_sha256;
    if (changed && !allowMutation) {
      await this.rollback(runId, { reason: 'unauthorized adapter mutation' });
      throw new SecurityError('Adapter mutated the isolated worktree outside the Workspace Engine action protocol');
    }
    return { changed, before, after };
  }

  async proposeActions({ run_id: runId, node, actions }) {
    const state = await this.prepare({ run_id: runId });
    if (state.pending) throw new StateError('Workspace already has a pending action proposal');
    const normalized = normalizeWorkspaceActions(actions);
    const challenge = randomBytes(18).toString('hex');
    const pending = {
      proposal_id: `wsp_${randomBytes(12).toString('hex')}`,
      node_id: node.node_id,
      node_kind: node.kind,
      action_digest: normalized.digest,
      actions: normalized.actions,
      challenge,
      decision: 'pending',
      proposed_at: nowIso(),
    };
    await this.writeState({ ...state, status: 'waiting_approval', pending });
    return {
      status: 'approval_required', proposal_id: pending.proposal_id, action_digest: pending.action_digest,
      challenge, action_count: pending.actions.length, workspace_path: state.worktree_path,
      warning: 'Approval authorizes changes only in the disposable worktree. Network isolation is not provided by git-worktree.',
    };
  }

  async executeActions(input) { return this.proposeActions({ run_id: input.run_id, node: input.node, actions: input.actions }); }

  async decide(runId, challenge, decision, actor = 'human') {
    const state = await this.readState(runId);
    if (!state.pending) throw new StateError('Workspace has no pending action proposal');
    if (state.pending.challenge !== challenge) throw new SecurityError('Workspace approval challenge mismatch');
    if (!['approved', 'denied'].includes(decision)) throw new ValidationError('Workspace decision must be approved or denied');
    const approval = { proposal_id: state.pending.proposal_id, actor, decision, decided_at: nowIso(), action_digest: state.pending.action_digest };
    if (decision === 'denied') {
      return this.writeState({ ...state, status: 'ready', pending: null, approvals: [...state.approvals, approval] });
    }
    const pending = { ...state.pending, decision, approved_by: actor, approved_at: approval.decided_at };
    return this.writeState({ ...state, status: 'approved', pending, approvals: [...state.approvals, approval] });
  }

  async assertNoSymlink(worktree, relative) {
    const pieces = safeRelativePath(relative).split('/');
    let current = worktree;
    for (const piece of pieces.slice(0, -1)) {
      current = path.join(current, piece);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new SecurityError(`Workspace path traverses a symbolic link: ${relative}`);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
    }
  }

  async applyAction(state, action, signal) {
    const cwd = state.worktree_path;
    if (action.type === 'write_file') {
      await this.assertNoSymlink(cwd, action.path);
      const target = path.join(cwd, action.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temp, action.content);
      await fs.rename(temp, target);
      return { type: action.type, path: action.path, sha256: sha256(action.content), bytes: Buffer.byteLength(action.content) };
    }
    if (action.type === 'delete_file') {
      await this.assertNoSymlink(cwd, action.path);
      const target = path.join(cwd, action.path);
      const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isSymbolicLink()) throw new SecurityError(`Refusing to delete a symbolic link: ${action.path}`);
      await fs.rm(target, { force: true, recursive: false });
      return { type: action.type, path: action.path, existed: Boolean(stat) };
    }
    if (action.type === 'apply_patch') {
      for (const file of action.paths) await this.assertNoSymlink(cwd, file);
      await this.git(['apply', '--check', '--whitespace=error-all', '-'], { cwd, stdin: action.patch, signal });
      await this.git(['apply', '--whitespace=error-all', '-'], { cwd, stdin: action.patch, signal });
      return { type: action.type, paths: action.paths, patch_sha256: sha256(action.patch) };
    }
    const command = action.argv[0];
    if (!this.allowedCommands.has(command)) throw new SecurityError(`Command is not allowlisted: ${command}`);
    const timeoutMs = action.timeout_ms == null ? this.defaultCommandTimeoutMs : action.timeout_ms;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new ValidationError('run_command.timeout_ms must be 100..3600000');
    const result = await runProcess({
      command, args: action.argv.slice(1), cwd, timeoutMs, signal,
      maxStdoutBytes: this.maxCommandOutputBytes, maxStderrBytes: this.maxCommandOutputBytes,
      env: { CI: '1', NO_COLOR: '1' },
    });
    return {
      type: action.type,
      argv: action.argv,
      exit_code: result.code,
      stdout_sha256: sha256(result.stdout),
      stderr_sha256: sha256(result.stderr),
      stdout: result.stdout.slice(0, 100_000),
      stderr: result.stderr.slice(0, 100_000),
    };
  }

  async executeApproved(runId, options = {}) {
    let state = await this.readState(runId);
    if (state.status !== 'approved' || state.pending?.decision !== 'approved') throw new SecurityError('Workspace proposal is not approved');
    const normalized = normalizeWorkspaceActions(state.pending.actions);
    if (normalized.digest !== state.pending.action_digest) throw new SecurityError('Approved workspace action digest changed');
    const before = await this.snapshot(runId);
    const actionResults = [];
    try {
      for (const action of normalized.actions) actionResults.push(await this.applyAction(state, action, options.signal));
    } catch (error) {
      await this.rollback(runId, { reason: `action failure: ${error.message}` });
      state = await this.readState(runId);
      await this.writeReceipt(runId, { status: 'rolled_back', action_digest: normalized.digest, error: error.message, action_results: actionResults, created_at: nowIso() });
      throw error;
    }
    const after = await this.snapshot(runId);
    const diff = await this.computeDiff(state.worktree_path);
    const receipt = await this.writeReceipt(runId, {
      status: 'executed', proposal_id: state.pending.proposal_id, action_digest: normalized.digest,
      base_commit: state.base_commit, before, after, action_results: actionResults,
      diff_sha256: sha256(diff), diff, created_at: nowIso(),
    });
    const next = await this.writeState({ ...state, status: 'executed', pending: null, receipts: [...state.receipts, receipt.receipt_id] });
    return { state: next, receipt };
  }

  async writeReceipt(runId, payload) {
    const receipt = { receipt_id: `wsr_${randomBytes(12).toString('hex')}`, run_id: runId, ...payload };
    receipt.receipt_digest = sha256(canonicalJson(receipt));
    const file = path.join(this.receiptDir(runId), `${receipt.receipt_id}.json`);
    await atomicWrite(file, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }

  async diff(runId) {
    const state = await this.readState(runId);
    return this.computeDiff(state.worktree_path);
  }

  async rollback(runId, options = {}) {
    const state = await this.readState(runId);
    await this.git(['reset', '--hard', state.base_commit], { cwd: state.worktree_path });
    await this.git(['clean', '-fdx'], { cwd: state.worktree_path });
    return this.writeState({ ...state, status: 'ready', pending: null, rollback_reason: options.reason ?? 'operator requested rollback' });
  }

  async close(runId, options = {}) {
    const state = await this.readState(runId);
    const diff = await this.diff(runId);
    if (diff.trim() && !options.force) throw new StateError('Workspace contains uncommitted changes; rollback or use force');
    await this.git(['worktree', 'remove', ...(options.force ? ['--force'] : []), state.worktree_path]);
    return this.writeState({ ...state, status: 'closed', closed_at: nowIso() });
  }
}
