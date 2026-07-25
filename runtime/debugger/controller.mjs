import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, nowIso, sha256 } from '../../server/lib/canonical.mjs';
import { SecurityError, StateError, ValidationError } from '../../server/lib/errors.mjs';
import { acquireFileLock, atomicWriteJson } from '../../server/lib/lock.mjs';
import { runDirectory } from '../../server/lib/store.mjs';
import { runId as validateRunId, stringValue } from '../../server/lib/validate.mjs';

export class DebugPauseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DebugPauseError';
    this.code = 'DEBUG_PAUSED';
    this.details = details;
  }
}

function digest(state) {
  const copy = structuredClone(state);
  delete copy.state_digest;
  return sha256(canonicalJson(copy));
}

function initial(runId) {
  const state = {
    schema_version: 1,
    run_id: runId,
    mode: 'running',
    breakpoints: [],
    step_budget: 0,
    active_node: null,
    pause_reason: null,
    history: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.state_digest = digest(state);
  return state;
}

export class DebuggerController {
  constructor({ dataDir, enabled = true }) {
    this.dataDir = path.resolve(dataDir);
    this.enabled = enabled;
  }

  file(runId) { return path.join(runDirectory(this.dataDir, validateRunId(runId)), 'debug.json'); }
  lock(runId) { return `${this.file(runId)}.lock`; }

  async read(runId, options = {}) {
    if (!this.enabled) return { ...initial(runId), mode: 'running', disabled: true };
    let state;
    try { state = JSON.parse(await fs.readFile(this.file(runId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') {
        state = initial(runId);
        if (options.create !== false) await atomicWriteJson(this.file(runId), state);
        return state;
      }
      if (error instanceof SyntaxError) throw new SecurityError('Debugger state is corrupt');
      throw error;
    }
    if (state.run_id !== runId || state.state_digest !== digest(state)) throw new SecurityError('Debugger state digest mismatch');
    return state;
  }

  async mutate(runId, actor, action, fn) {
    const release = await acquireFileLock(this.lock(runId));
    try {
      const state = await this.read(runId);
      const next = await fn(structuredClone(state));
      next.updated_at = nowIso();
      next.history = [...(next.history ?? []), { at: next.updated_at, actor, action }].slice(-200);
      next.state_digest = digest(next);
      await atomicWriteJson(this.file(runId), next);
      return next;
    } finally { await release(); }
  }

  async command(runId, command, options = {}) {
    const actor = options.actor ?? 'operator';
    return this.mutate(runId, actor, command, (state) => {
      if (command === 'pause') {
        state.mode = 'paused'; state.step_budget = 0; state.pause_reason = options.reason ?? 'operator pause';
      } else if (command === 'resume') {
        state.mode = 'running'; state.step_budget = 0; state.pause_reason = null; state.active_node = null;
      } else if (command === 'step') {
        state.mode = 'step'; state.step_budget = 1; state.pause_reason = null; state.active_node = null;
      } else if (command === 'break') {
        const type = options.type === 'kind' ? 'kind' : 'node';
        const value = stringValue(options.value, 'breakpoint value', { min: 1, max: 128 });
        const key = `${type}:${value}`;
        if (!state.breakpoints.some((item) => `${item.type}:${item.value}` === key)) state.breakpoints.push({ type, value, created_at: nowIso() });
      } else if (command === 'clear') {
        if (!options.value) state.breakpoints = [];
        else state.breakpoints = state.breakpoints.filter((item) => item.value !== options.value && `${item.type}:${item.value}` !== options.value);
      } else if (command === 'retry') {
        state.mode = 'running'; state.step_budget = 0; state.pause_reason = null; state.retry_node = options.value ?? null;
      } else throw new ValidationError(`Unknown debugger command: ${command}`);
      return state;
    });
  }

  matches(state, node) {
    return state.breakpoints.some((item) => (item.type === 'node' && item.value === node.node_id) || (item.type === 'kind' && item.value === node.kind));
  }

  async beforeNode({ run_id: runId, node }) {
    if (!this.enabled) return;
    const release = await acquireFileLock(this.lock(runId));
    try {
      const state = await this.read(runId);
      const persist = async (action) => {
        state.updated_at = nowIso();
        state.history = [...(state.history ?? []), { at: state.updated_at, actor: 'kernel', action }].slice(-200);
        state.state_digest = digest(state);
        await atomicWriteJson(this.file(runId), state);
      };
      if (state.mode === 'paused') throw new DebugPauseError(state.pause_reason ?? 'Graph debugger is paused', { run_id: runId, node_id: node.node_id });
      if (this.matches(state, node) && state.skip_breakpoint_once !== node.node_id) {
        state.mode = 'paused'; state.pause_reason = `breakpoint:${node.node_id}`; state.active_node = node.node_id;
        await persist('breakpoint-hit');
        throw new DebugPauseError(`Breakpoint reached at ${node.node_id}`, { run_id: runId, node_id: node.node_id });
      }
      if (state.mode === 'step') {
        if (state.step_budget <= 0) {
          state.mode = 'paused'; state.pause_reason = 'step complete'; state.active_node = node.node_id;
          await persist('step-exhausted');
          throw new DebugPauseError('Step budget exhausted', { run_id: runId, node_id: node.node_id });
        }
        state.step_budget -= 1;
        state.active_node = node.node_id;
        await persist('step-started');
      }
    } finally { await release(); }
  }

  async afterNode({ run_id: runId, node }) {
    if (!this.enabled) return;
    await this.mutate(runId, 'kernel', 'node-complete', (state) => {
      if (state.mode === 'step') {
        state.mode = 'paused'; state.pause_reason = `step completed:${node.node_id}`; state.step_budget = 0;
      }
      state.active_node = null;
      if (state.skip_breakpoint_once === node.node_id) delete state.skip_breakpoint_once;
      return state;
    });
  }

  async bypassBreakpointOnce(runId, nodeId) {
    const value = stringValue(nodeId, 'node_id', { min: 1, max: 128 });
    return this.mutate(runId, 'operator', 'bypass-breakpoint-once', (state) => {
      state.skip_breakpoint_once = value;
      state.mode = 'running';
      state.pause_reason = null;
      return state;
    });
  }

  async onStatus(status) {
    if (!this.enabled) return;
    const state = await this.read(status.run_id);
    if (state.last_graph_status === status.status && state.last_graph_revision === status.graph_revision) return;
    await this.mutate(status.run_id, 'kernel', 'status', (next) => {
      next.last_graph_status = status.status;
      next.last_graph_revision = status.graph_revision;
      next.last_ready_nodes = (status.ready_nodes ?? []).map((node) => node.node_id);
      return next;
    });
  }
}
