import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, eventHash, nowIso, sha256 } from './canonical.mjs';
import { acquireFileLock, atomicWriteFile, atomicWriteJson, ensureDir } from './lock.mjs';
import { BudgetError, SecurityError, StateError, ValidationError } from './errors.mjs';
import { runId as validateRunId } from './validate.mjs';

const ZERO_HASH = '0'.repeat(64);

export function resolveDataDir(env = process.env) {
  const candidate = env.PROOFGRAPH_DATA_DIR || env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.proofgraph');
  return path.resolve(candidate);
}

export function resolveProjectDir(env = process.env) {
  return path.resolve(env.PROOFGRAPH_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd());
}

export function projectKey(projectDir = resolveProjectDir()) {
  return sha256(path.resolve(projectDir)).slice(0, 24);
}

export function runDirectory(dataDir, runId) {
  validateRunId(runId);
  return path.join(path.resolve(dataDir), 'runs', runId);
}

export function sourcePath(dataDir, runId, sourceId) {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(sourceId)) throw new ValidationError('Invalid source_id');
  return path.join(runDirectory(dataDir, runId), 'sources', `${sourceId}.txt`);
}

export function reportPath(dataDir, runId, format = 'md') {
  if (!['md', 'json'].includes(format)) throw new ValidationError('Invalid report format');
  return path.join(runDirectory(dataDir, runId), `report.${format}`);
}

function statePath(dataDir, runId) {
  return path.join(runDirectory(dataDir, runId), 'state.json');
}

function eventsPath(dataDir, runId) {
  return path.join(runDirectory(dataDir, runId), 'events.jsonl');
}

function transactionPath(dataDir, runId) {
  return path.join(runDirectory(dataDir, runId), 'transaction.json');
}

function lockPath(dataDir, runId) {
  return path.join(runDirectory(dataDir, runId), '.lock');
}

function activePath(dataDir, key) {
  if (!/^[a-f0-9]{24}$/.test(key)) throw new ValidationError('Invalid project key');
  return path.join(path.resolve(dataDir), 'active', `${key}.json`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readEvents(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendEvents(filePath, events) {
  if (!events.length) return;
  await ensureDir(path.dirname(filePath));
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await fs.appendFile(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

function buildEvents(state, specs) {
  let seq = state.event_head?.seq ?? 0;
  let prevHash = state.event_head?.hash ?? ZERO_HASH;
  const events = [];
  for (const spec of specs) {
    seq += 1;
    const base = {
      seq,
      ts: spec.ts || nowIso(),
      type: spec.type,
      actor: spec.actor || 'system',
      data: spec.data ?? {},
      prev_hash: prevHash,
    };
    const event = { ...base, hash: eventHash(base) };
    events.push(event);
    prevHash = event.hash;
  }
  return events;
}

function inspectEventChain(state, events) {
  let previous = ZERO_HASH;
  let expectedSeq = 1;
  const errors = [];
  for (const event of events) {
    const { hash, ...base } = event;
    if (event.seq !== expectedSeq) errors.push(`event seq ${event.seq} expected ${expectedSeq}`);
    if (event.prev_hash !== previous) errors.push(`event ${event.seq} prev_hash mismatch`);
    if (eventHash(base) !== hash) errors.push(`event ${event.seq} hash mismatch`);
    previous = hash;
    expectedSeq += 1;
  }
  if ((state.event_head?.seq ?? 0) !== events.length) errors.push('state event_head seq mismatch');
  if ((state.event_head?.hash ?? ZERO_HASH) !== (events.at(-1)?.hash ?? ZERO_HASH)) errors.push('state event_head hash mismatch');
  const commit = [...events].reverse().find((event) => event.type === 'state.committed');
  if (!commit) errors.push('state commit event missing');
  else if (commit.data?.state_digest !== stateDigest(state)) errors.push('state digest mismatch');
  return { ok: errors.length === 0, errors, event_count: events.length, head_hash: previous };
}

function assertEventChainAndState(state, events) {
  const result = inspectEventChain(state, events);
  if (!result.ok) throw new SecurityError('Run state or event chain failed integrity validation', result);
}

async function recoverRunUnlocked(dataDir, runId) {
  const txnPath = transactionPath(dataDir, runId);
  let transaction;
  try {
    transaction = await readJson(txnPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!transaction || !transaction.state || !Array.isArray(transaction.events)) {
    throw new StateError('Corrupt transaction journal', { run_id: runId });
  }
  const existing = await readEvents(eventsPath(dataDir, runId));
  const lastExisting = existing.at(-1);
  const firstPending = transaction.events[0];
  const lastPending = transaction.events.at(-1);
  if (transaction.events.length) {
    if (lastExisting?.hash === lastPending.hash) {
      // Already appended before a crash.
    } else if ((lastExisting?.seq ?? 0) === firstPending.seq - 1 && (lastExisting?.hash ?? ZERO_HASH) === firstPending.prev_hash) {
      await appendEvents(eventsPath(dataDir, runId), transaction.events);
    } else {
      throw new StateError('Cannot recover transaction because the event log diverged', { run_id: runId });
    }
  }
  await atomicWriteJson(statePath(dataDir, runId), transaction.state);
  await fs.rm(txnPath, { force: true });
}

export async function recoverRun(dataDir, runId) {
  const release = await acquireFileLock(lockPath(dataDir, runId));
  try {
    await recoverRunUnlocked(dataDir, runId);
  } finally {
    await release();
  }
}

export async function readRun(dataDir, runId) {
  validateRunId(runId);
  const release = await acquireFileLock(lockPath(dataDir, runId));
  try {
    await recoverRunUnlocked(dataDir, runId);
    return await readJson(statePath(dataDir, runId));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new StateError('Run does not exist', { run_id: runId });
    throw error;
  } finally {
    await release();
  }
}

export async function readVerifiedRun(dataDir, runId) {
  validateRunId(runId);
  const release = await acquireFileLock(lockPath(dataDir, runId));
  try {
    await recoverRunUnlocked(dataDir, runId);
    const state = await readJson(statePath(dataDir, runId));
    const events = await readEvents(eventsPath(dataDir, runId));
    assertEventChainAndState(state, events);
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new StateError('Run does not exist', { run_id: runId });
    throw error;
  } finally {
    await release();
  }
}

export async function createRun(dataDir, state, initialEvent) {
  validateRunId(state.run_id);
  const directory = runDirectory(dataDir, state.run_id);
  await ensureDir(path.dirname(directory));
  try {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new StateError('Run already exists', { run_id: state.run_id });
    throw error;
  }
  await ensureDir(path.join(directory, 'sources'));
  const events = buildEvents(state, [
    initialEvent,
    { type: 'state.committed', actor: 'system', data: { state_digest: stateDigest(state) } },
  ]);
  state.event_head = { seq: events.at(-1).seq, hash: events.at(-1).hash };
  await atomicWriteJson(statePath(dataDir, state.run_id), state);
  await appendEvents(eventsPath(dataDir, state.run_id), events);
  return structuredClone(state);
}

export async function withRunTransaction(dataDir, runId, mutator) {
  validateRunId(runId);
  const release = await acquireFileLock(lockPath(dataDir, runId));
  try {
    await recoverRunUnlocked(dataDir, runId);
    const current = await readJson(statePath(dataDir, runId));
    const currentEvents = await readEvents(eventsPath(dataDir, runId));
    assertEventChainAndState(current, currentEvents);
    const next = structuredClone(current);
    const specs = [];
    const emit = (type, actor = 'system', data = {}) => {
      if (typeof type !== 'string' || !type) throw new ValidationError('Event type is required');
      specs.push({ type, actor, data });
    };
    const result = await mutator(next, emit, current);
    next.updated_at = nowIso();
    specs.push({ type: 'state.committed', actor: 'system', data: { state_digest: stateDigest(next) } });
    const events = buildEvents(current, specs);
    if (events.length) next.event_head = { seq: events.at(-1).seq, hash: events.at(-1).hash };
    const transaction = { state: next, events };
    await atomicWriteJson(transactionPath(dataDir, runId), transaction);
    await appendEvents(eventsPath(dataDir, runId), events);
    await atomicWriteJson(statePath(dataDir, runId), next);
    await fs.rm(transactionPath(dataDir, runId), { force: true });
    return { state: structuredClone(next), result };
  } finally {
    await release();
  }
}

export async function readActiveRun(dataDir, key = projectKey()) {
  try {
    const active = await readJson(activePath(dataDir, key));
    if (!active?.run_id) return null;
    validateRunId(active.run_id);
    return active;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function setActiveRun(dataDir, key, runId) {
  validateRunId(runId);
  const filePath = activePath(dataDir, key);
  await ensureDir(path.dirname(filePath));
  const lock = `${filePath}.lock`;
  const release = await acquireFileLock(lock);
  try {
    const current = await readActiveRun(dataDir, key);
    if (current && current.run_id !== runId) {
      throw new StateError('Another ProofGraph run is already active for this project', current);
    }
    await atomicWriteJson(filePath, { run_id: runId, project_key: key, set_at: nowIso() });
  } finally {
    await release();
  }
}

export async function clearActiveRun(dataDir, key, expectedRunId = undefined) {
  const filePath = activePath(dataDir, key);
  const release = await acquireFileLock(`${filePath}.lock`);
  try {
    const current = await readActiveRun(dataDir, key);
    if (!current) return;
    if (expectedRunId && current.run_id !== expectedRunId) return;
    await fs.rm(filePath, { force: true });
  } finally {
    await release();
  }
}

export async function reserveBudget(dataDir, runId, { actor, operation, sourceFetch = false } = {}) {
  const { state, result } = await withRunTransaction(dataDir, runId, (next, emit) => {
    if (next.status !== 'active') {
      return { allowed: false, code: 'INVALID_STATE', message: `Run is not active: ${next.status}` };
    }
    const now = Date.now();
    const deadline = Date.parse(next.deadline_at);
    if (Number.isFinite(deadline) && now > deadline) {
      next.status = 'budget_exceeded';
      next.budget_exceeded_reason = 'max_wall_time_seconds';
      emit('budget.exceeded', actor, { operation, reason: next.budget_exceeded_reason });
      return { allowed: false, code: 'BUDGET_EXCEEDED', message: 'Run wall-clock budget has expired' };
    }
    if (next.counters.tool_calls >= next.policy.max_tool_calls) {
      next.status = 'budget_exceeded';
      next.budget_exceeded_reason = 'max_tool_calls';
      emit('budget.exceeded', actor, { operation, reason: next.budget_exceeded_reason });
      return { allowed: false, code: 'BUDGET_EXCEEDED', message: 'Tool-call budget is exhausted' };
    }
    if (sourceFetch && next.counters.source_fetches >= next.policy.max_source_fetches) {
      next.status = 'budget_exceeded';
      next.budget_exceeded_reason = 'max_source_fetches';
      emit('budget.exceeded', actor, { operation, reason: next.budget_exceeded_reason });
      return { allowed: false, code: 'BUDGET_EXCEEDED', message: 'Source-fetch budget is exhausted' };
    }
    next.counters.tool_calls += 1;
    if (sourceFetch) next.counters.source_fetches += 1;
    emit('tool.reserved', actor, {
      operation,
      tool_calls: next.counters.tool_calls,
      source_fetches: next.counters.source_fetches,
    });
    return { allowed: true };
  });
  if (!result.allowed) {
    if (result.code === 'BUDGET_EXCEEDED') throw new BudgetError(result.message, { run_id: runId, status: state.status });
    throw new StateError(result.message, { run_id: runId, status: state.status });
  }
  return state;
}

export async function reserveAgentSpawn(dataDir, runId, actor, agentType) {
  const { result } = await withRunTransaction(dataDir, runId, (next, emit) => {
    if (next.status !== 'active') return { allowed: false, reason: `Run is ${next.status}` };
    const deadline = Date.parse(next.deadline_at);
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      next.status = 'budget_exceeded';
      next.budget_exceeded_reason = 'max_wall_time_seconds';
      emit('budget.exceeded', actor, { operation: 'claude:Agent', reason: next.budget_exceeded_reason });
      return { allowed: false, reason: 'Run wall-clock budget has expired' };
    }
    if (next.counters.tool_calls >= next.policy.max_tool_calls) {
      next.status = 'budget_exceeded';
      next.budget_exceeded_reason = 'max_tool_calls';
      emit('budget.exceeded', actor, { operation: 'claude:Agent', reason: next.budget_exceeded_reason });
      return { allowed: false, reason: 'Tool-call budget is exhausted' };
    }
    if (next.counters.agents_spawned >= next.policy.max_agents) {
      emit('agent.spawn_denied', actor, { agent_type: agentType, reason: 'max_agents' });
      return { allowed: false, reason: 'Agent budget exhausted' };
    }
    next.counters.tool_calls += 1;
    next.counters.agents_spawned += 1;
    emit('tool.reserved', actor, {
      operation: 'claude:Agent',
      tool_calls: next.counters.tool_calls,
      source_fetches: next.counters.source_fetches,
    });
    emit('agent.spawn_reserved', actor, {
      agent_type: agentType,
      agents_spawned: next.counters.agents_spawned,
    });
    return { allowed: true, agents_spawned: next.counters.agents_spawned };
  });
  return result;
}

export async function writeSourceContent(dataDir, runId, sourceId, text) {
  const filePath = sourcePath(dataDir, runId, sourceId);
  await atomicWriteFile(filePath, text);
  return { path: filePath, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

export async function readSourceContent(dataDir, runId, sourceId) {
  return fs.readFile(sourcePath(dataDir, runId, sourceId), 'utf8');
}

export async function writeReportArtifacts(dataDir, runId, reportJson, reportMarkdown) {
  await atomicWriteJson(reportPath(dataDir, runId, 'json'), reportJson);
  await atomicWriteFile(reportPath(dataDir, runId, 'md'), reportMarkdown);
  return {
    json_sha256: sha256(`${JSON.stringify(reportJson, null, 2)}\n`),
    markdown_sha256: sha256(reportMarkdown),
  };
}

export async function readReport(dataDir, runId, format = 'md') {
  return fs.readFile(reportPath(dataDir, runId, format), 'utf8');
}

export async function readEventLog(dataDir, runId) {
  validateRunId(runId);
  await recoverRun(dataDir, runId);
  return readEvents(eventsPath(dataDir, runId));
}

export async function verifyEventChain(dataDir, runId) {
  const state = await readRun(dataDir, runId);
  const events = await readEvents(eventsPath(dataDir, runId));
  return inspectEventChain(state, events);
}

export function stateDigest(state) {
  const clone = structuredClone(state);
  delete clone.integrity;
  delete clone.event_head;
  return sha256(canonicalJson(clone));
}
