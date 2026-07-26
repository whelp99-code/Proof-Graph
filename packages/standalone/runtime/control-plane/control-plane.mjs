import path from 'node:path';
import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson, randomId, sha256 } from '../core/canonical.mjs';
import { ConflictError, PolicyError, ValidationError } from '../core/errors.mjs';
import { loadOrCreateSecret } from '../core/secret-store.mjs';
import { identifier } from '../core/validate.mjs';
import { CompanyRuntime, ReferenceGraphKernelPort } from '../company/index.mjs';
import { AutonomousOrganizationOS } from '../os/index.mjs';
import { readEvents, summarizeTimeline, missionProjection, osProjection } from '../observability/index.mjs';
import { HostRegistry, OpenCodeClient } from '../hosts/index.mjs';

const MISSION_TERMINAL = new Set(['completed', 'simulated', 'partial', 'failed', 'aborted']);
const OS_TERMINAL = new Set(['completed', 'failed', 'aborted']);
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function nowIso() { return new Date().toISOString(); }

export class ControlPlane {
  constructor({
    dataDir = '.proofgraph-org',
    graphPort = new ReferenceGraphKernelPort(),
    companyRuntime = null,
    osRuntime = null,
    hostRegistry = null,
    tickDelayMs = 75,
    operatorToken = null,
    hostToken = null,
    modelRegistry = null,
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.company = companyRuntime ?? new CompanyRuntime({ dataDir: this.dataDir, graphPort, modelRegistry });
    this.os = osRuntime ?? new AutonomousOrganizationOS({ dataDir: this.dataDir, companyRuntime: this.company });
    this.hosts = hostRegistry ?? new HostRegistry({ dataDir: this.dataDir });
    this.commands = new HashChainStore(this.dataDir, { namespace: 'operator-commands' });
    this.tickDelayMs = tickDelayMs;
    this.operatorTokenOptions = { filename: '.operator-api-token', provided: operatorToken };
    this.hostTokenOptions = { filename: '.host-ingest-token', provided: hostToken };
    this._operatorToken = null;
    this._hostToken = null;
    this.runners = new Map();
    this.hostConnections = new Map();
  }

  async init() {
    this._operatorToken ??= await loadOrCreateSecret(this.dataDir, this.operatorTokenOptions);
    this._hostToken ??= await loadOrCreateSecret(this.dataDir, this.hostTokenOptions);
    return this;
  }

  async operatorToken() { await this.init(); return this._operatorToken; }
  async hostToken() { await this.init(); return this._hostToken; }
  tokenFiles() {
    return {
      operator: path.join(this.dataDir, '.operator-api-token'),
      host_ingest: path.join(this.dataDir, '.host-ingest-token'),
    };
  }

  async command(commandId, { actor = 'external-human', action, target = null, input = null } = {}, operation) {
    const id = identifier(commandId ?? randomId('command'), 'command_id');
    try {
      const existing = await this.commands.read(id);
      if (existing.status === 'completed') return cloneJson(existing.result);
      if (existing.status === 'failed') throw new ConflictError('Idempotent command previously failed', existing.error);
      throw new ConflictError('Command is already in progress');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.commands.create(id, {
      schema_version: 1, command_id: id, actor, action, target, input_digest: sha256(input ?? null),
      status: 'running', result: null, error: null, created_at: nowIso(), completed_at: null,
    }, { type: 'operator.command_started', actor, data: { action, target } });
    try {
      const result = await operation();
      await this.commands.update(id, ({ state, emit }) => {
        state.status = 'completed'; state.result = cloneJson(result); state.completed_at = nowIso();
        emit('operator.command_completed', actor, { action, target }); return state;
      });
      return result;
    } catch (error) {
      await this.commands.update(id, ({ state, emit }) => {
        state.status = 'failed'; state.error = { name: error.name, code: error.code ?? 'error', message: error.message }; state.completed_at = nowIso();
        emit('operator.command_failed', actor, { action, target, code: error.code ?? 'error' }); return state;
      });
      throw error;
    }
  }

  async listRuns() {
    const missions = await this.company.store.list();
    const osRuns = await this.os.store.list();
    const result = [];
    for (const id of missions) {
      try { result.push(await this.missionView(id, { timelineLimit: 30 })); }
      catch (error) { result.push({ run_id: id, run_type: 'mission', status: 'failed', integrity_error: error.message }); }
    }
    for (const id of osRuns) {
      try { result.push(await this.osView(id)); }
      catch (error) { result.push({ run_id: id, run_type: 'organization_os', status: 'failed', integrity_error: error.message }); }
    }
    return result.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  }

  async missionView(missionId, { timelineLimit = 100 } = {}) {
    const id = identifier(missionId, 'mission_id');
    const state = await this.company.status(id);
    const events = timelineLimit ? await readEvents(this.dataDir, id, { namespace: 'missions', afterSeq: Math.max(0, Number(state.event_head?.seq ?? 0) - timelineLimit), limit: timelineLimit }) : [];
    let host = state.host ?? null;
    try {
      const registered = await this.hosts.list();
      const matching = registered.find((item) => Object.values(item.sessions ?? {}).some((session) => session.run_id === id));
      if (matching) host = {
        name: matching.name, type: matching.type, status: matching.status, version: matching.version,
        sessions: Object.values(matching.sessions).filter((session) => session.run_id === id), last_event_at: matching.last_event_at,
      };
    } catch { /* host registry is supplemental */ }
    return missionProjection(state, { host, timeline: summarizeTimeline(events, timelineLimit) });
  }

  async osView(osRunId) {
    const id = identifier(osRunId, 'os_run_id');
    const state = await this.os.status(id);
    const missions = [];
    for (const missionId of state.mission_ids ?? []) missions.push(await this.missionView(missionId, { timelineLimit: 20 }));
    return osProjection(state, missions);
  }

  async runView(runId, options = {}) {
    if (String(runId).startsWith('osrun_')) return this.osView(runId);
    return this.missionView(runId, options);
  }

  async intelligenceView(missionId, { section = 'summary', full = false, sourceIds = [], maxDepth = 2 } = {}) {
    const id = identifier(missionId, 'mission_id');
    const state = await this.company.status(id);
    if (!state.intelligence || !this.company.intelligence) throw new ValidationError('Mission has no Intelligence Fabric state');
    const summary = (await this.missionView(id, { timelineLimit: 0 })).intelligence;
    if (section === 'summary') return summary;
    const intelligence = state.intelligence;
    if (section === 'contexts') return full ? cloneJson(intelligence.context_packets ?? []) : cloneJson(summary.contexts);
    if (section === 'routes') return full ? cloneJson(intelligence.route_decisions ?? []) : cloneJson(summary.routing);
    if (section === 'observations') return full ? cloneJson(intelligence.model_observations ?? []) : cloneJson({ total: summary.routing?.observation_total ?? 0, observations: summary.routing?.observations ?? [], model_summary: summary.routing?.model_summary ?? [] });
    if (section === 'collaboration') return full ? { contracts: cloneJson(intelligence.contracts ?? []), handoffs: cloneJson(intelligence.handoffs ?? []) } : cloneJson(summary.collaboration);
    if (section === 'knowledge') return full ? cloneJson(intelligence.knowledge_graph) : cloneJson(summary.knowledge);
    if (section === 'memory') {
      const memoryState = await this.company.intelligence.memory.ensure();
      if (full) return { entries: cloneJson(memoryState.entries ?? []), recalled: cloneJson(intelligence.memory_recalled ?? []), captured: cloneJson(intelligence.memory_captured ?? []) };
      return { ...cloneJson(summary.memory), stored: (memoryState.entries ?? []).map((entry) => ({ memory_id: entry.memory_id, kind: entry.kind, title: entry.title, status: entry.status, confidence: entry.confidence, sensitivity: entry.sensitivity, verified_by: entry.verified_by ?? null, valid_at: entry.valid_at, digest: entry.digest })).slice(-1000) };
    }
    if (section === 'verification') return full ? cloneJson(intelligence.verifications ?? []) : cloneJson(summary.verification);
    if (section === 'impact') {
      if (!Array.isArray(sourceIds) || sourceIds.length === 0) throw new ValidationError('impact view requires at least one source id');
      return this.company.intelligence.knowledge.impact(intelligence.knowledge_graph, { source_ids: sourceIds, max_depth: maxDepth });
    }
    throw new ValidationError(`Unknown intelligence section: ${section}`);
  }

  async timeline(runId, { afterSeq = 0, limit = 500 } = {}) {
    const osRun = String(runId).startsWith('osrun_');
    return readEvents(this.dataDir, runId, { namespace: osRun ? 'organization-os' : 'missions', afterSeq, limit });
  }

  async createMission(input, options = {}) {
    if (!input?.objective || typeof input.objective !== 'string') throw new ValidationError('objective is required');
    const created = await this.company.create(input, options);
    if (options.auto_start !== false) this.launchMission(created.mission.mission_id);
    return this.missionView(created.mission.mission_id);
  }

  launchMission(missionId) {
    const id = identifier(missionId, 'mission_id');
    if (this.runners.has(id)) return this.runners.get(id).summary;
    const summary = { run_id: id, launched_at: nowIso(), type: 'mission' };
    const promise = (async () => {
      try {
        for (;;) {
          const state = await this.company.status(id);
          if (MISSION_TERMINAL.has(state.status) || state.status === 'waiting_approval' || state.operator?.paused === true) return state;
          await this.company.tick(id);
          await sleep(this.tickDelayMs);
        }
      } finally { this.runners.delete(id); }
    })();
    promise.catch(() => {});
    this.runners.set(id, { promise, summary });
    return summary;
  }

  async createOS(input, options = {}) {
    const created = await this.os.create(input, options);
    if (options.auto_start !== false) this.launchOS(created.os_run_id);
    return this.osView(created.os_run_id);
  }

  launchOS(osRunId) {
    const id = identifier(osRunId, 'os_run_id');
    if (this.runners.has(id)) return this.runners.get(id).summary;
    const summary = { run_id: id, launched_at: nowIso(), type: 'organization_os' };
    const promise = (async () => {
      try {
        for (;;) {
          const state = await this.os.status(id);
          if (OS_TERMINAL.has(state.status) || state.status === 'waiting_approval') return state;
          await this.os.runCycle(id);
          await sleep(this.tickDelayMs);
        }
      } finally { this.runners.delete(id); }
    })();
    promise.catch(() => {});
    this.runners.set(id, { promise, summary });
    return summary;
  }

  async pauseMission(missionId, reason = 'operator pause') { return this.company.pause(missionId, { actor: 'external-human', reason }); }
  async resumeMission(missionId) { const state = await this.company.resume(missionId, { actor: 'external-human' }); this.launchMission(missionId); return state; }
  async abortRun(runId, reason = 'operator abort') {
    if (String(runId).startsWith('osrun_')) return this.os.abort(runId, reason, 'external-human');
    return this.company.abort(runId, reason, 'external-human');
  }
  async retryNode(missionId, nodeId, reason = 'operator retry') { const state = await this.company.retryWorkItem(missionId, nodeId, { actor: 'external-human', reason }); this.launchMission(missionId); return state; }

  async decideApproval(runId, approvalId, decision) {
    if (!['approved', 'denied'].includes(decision)) throw new ValidationError('decision must be approved or denied');
    if (String(runId).startsWith('osrun_')) {
      const state = await this.os.status(runId);
      const approval = state.approvals.find((item) => item.approval_id === approvalId && item.status === 'pending');
      if (!approval) throw new ValidationError('Pending OS approval not found');
      const result = await this.os.resolveOSApproval(runId, {
        approval_id: approval.approval_id, challenge: approval.challenge, decision,
        actor: 'external-human', decision_source: 'host-ui-confirmed',
      });
      if (decision === 'approved') this.launchOS(runId);
      return result;
    }
    const state = await this.company.status(runId);
    const approval = state.approvals.find((item) => item.approval_id === approvalId && item.status === 'pending');
    if (!approval) throw new ValidationError('Pending mission approval not found');
    const result = approval.kind === 'delivery'
      ? await this.company.decideDelivery(runId, { approval_id: approvalId, challenge: approval.challenge, decision, actor: 'external-human', decision_source: 'host-ui-confirmed' })
      : await this.company.decide(runId, { approval_id: approvalId, challenge: approval.challenge, decision, actor: 'external-human', decision_source: 'host-ui-confirmed' });
    if (decision === 'approved' && approval.kind !== 'delivery') this.launchMission(runId);
    return result;
  }

  async pendingApprovals() {
    const runs = await this.listRuns();
    return runs.flatMap((run) => (run.approvals?.pending ?? []).map((approval) => ({ run_id: run.run_id, run_type: run.run_type, objective: run.objective, ...approval })));
  }

  async connectOpenCode({ base_url = 'http://127.0.0.1:4096', allow_remote = false } = {}) {
    const key = 'opencode';
    if (this.hostConnections.has(key)) return this.hosts.get(key);
    const client = new OpenCodeClient({ baseUrl: base_url, allowRemote: allow_remote });
    const health = await client.health();
    let project = null;
    try { project = await client.currentProject(); } catch { /* health is enough */ }
    await this.hosts.connected(key, { type: 'opencode', name: 'OpenCode', base_url, version: health.version ?? null, project });
    const controller = new AbortController();
    const task = (async () => {
      try {
        for await (const event of client.events({ signal: controller.signal, context: { project_id: project?.id ?? null } })) await this.hosts.ingest(key, event);
      } catch (error) {
        if (!controller.signal.aborted) await this.hosts.disconnected(key, error.message);
      } finally { this.hostConnections.delete(key); }
    })();
    task.catch(() => {});
    this.hostConnections.set(key, { controller, task, client });
    return this.hosts.get(key);
  }

  async disconnectHost(hostId = 'opencode') {
    const connection = this.hostConnections.get(hostId);
    connection?.controller.abort();
    this.hostConnections.delete(hostId);
    return this.hosts.disconnected(hostId, 'operator disconnected');
  }

  async ingestHostEvent(hostId, event) { return this.hosts.ingest(identifier(hostId, 'host_id'), event); }
}
