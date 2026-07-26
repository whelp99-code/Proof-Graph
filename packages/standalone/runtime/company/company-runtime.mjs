import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson, hmacSha256, randomId, sha256 } from '../core/canonical.mjs';
import { BudgetError, ConflictError, IntegrityError, PolicyError, ValidationError } from '../core/errors.mjs';
import { loadOrCreateSecret } from '../core/secret-store.mjs';
import { compileMission } from './mission-compiler.mjs';
import { ReferenceGraphKernelPort } from './graph-port.mjs';
import { executionModeOf, isRealExecutionMode, simulationPromotionAllowed } from './execution-mode.mjs';
import { ArtifactRuntime } from './artifact-runtime.mjs';
import { EVENT_TYPES, failureIdentity } from '../observability/contracts.mjs';
import { DeliveryRuntime } from './delivery-runtime.mjs';
import { IntelligenceFabric } from '../intelligence/fabric.mjs';

function nowIso() { return new Date().toISOString(); }
function terminal(status) { return ['completed', 'simulated', 'partial', 'failed', 'aborted'].includes(status); }
function graphPortName(port) { return port?.constructor?.name === 'HostBridgeGraphPort' ? (port.host ?? 'host-bridge') : 'reference'; }

export class CompanyRuntime {
  constructor({ dataDir, graphPort = new ReferenceGraphKernelPort(), allowSimulationPromotion = simulationPromotionAllowed(), artifactRuntime = new ArtifactRuntime(), deliveryRuntime = new DeliveryRuntime(), approvalSecret = null, intelligenceFabric = null, modelRegistry = null, intelligenceLimits = {} }) {
    this.dataDir = dataDir;
    this.store = new HashChainStore(dataDir, { namespace: 'missions' });
    this.graphPort = graphPort;
    this.executionMode = executionModeOf(graphPort);
    this.allowSimulationPromotion = allowSimulationPromotion === true;
    this.artifacts = artifactRuntime;
    this.delivery = deliveryRuntime;
    this.intelligence = intelligenceFabric === false ? null : (intelligenceFabric ?? new IntelligenceFabric({ dataDir, modelRegistry, limits: intelligenceLimits }));
    this.approvalSecretOptions = { filename: '.mission-approval-secret', provided: approvalSecret };
    this._approvalSecretPromise = null;
  }


  approvalSecret() {
    this._approvalSecretPromise ??= loadOrCreateSecret(this.dataDir, this.approvalSecretOptions);
    return this._approvalSecretPromise;
  }

  async create(input, options = {}) {
    const mission = compileMission(input, options);
    const initial = {
      schema_version: 1,
      mission,
      status: 'planned',
      tick_count: 0,
      failures: [],
      approvals: [],
      artifact_candidates: [],
      artifacts: [],
      deliveries: [],
      receipts: [],
      usage: { calls: 0, tokens: 0, cost_micros: 0, wall_time_ms: 0 },
      created_at: nowIso(),
      updated_at: nowIso(),
      quality_gate_passed: false,
      route_history: [],
      operator: { paused: false, paused_at: null, paused_by: null, reason: null },
      host: { name: graphPortName(this.graphPort), status: 'configured', session_id: null, last_event_at: null },
      execution: { mode: this.executionMode, real_execution: isRealExecutionMode(this.executionMode), simulation_promotion_allowed: this.allowSimulationPromotion, model_invocations: 0, tool_invocations: 0 },
      intelligence: this.intelligence ? this.intelligence.initialize(mission) : null,
    };
    return this.store.create(mission.mission_id, initial, { type: 'mission.created', actor: 'executive-manager', data: { task_id: mission.task.task_id, organization_id: mission.organization.organization_id } });
  }

  async status(missionId) { return this.store.read(missionId); }

  async start(missionId) {
    return this.store.update(missionId, ({ state, emit }) => {
      if (state.status !== 'planned') throw new ConflictError(`Mission cannot start from ${state.status}`);
      state.status = 'active';
      state.operator ??= { paused: false, paused_at: null, paused_by: null, reason: null };
      state.operator.paused = false;
      state.mission.projects.forEach((item) => { item.status = 'active'; });
      state.mission.sprints.forEach((item) => { item.status = 'active'; });
      emit('mission.started', 'executive-manager', {});
      return state;
    });
  }

  readyItems(state) {
    const byId = new Map(state.mission.work_items.map((item) => [item.work_item_id, item]));
    return state.mission.work_items.filter((item) => {
      if (item.status !== 'pending') return false;
      if (item.dependencies.length === 0) return true;
      const statuses = item.dependencies.map((id) => byId.get(id)?.status);
      return item.join === 'all' ? statuses.every((status) => status === 'completed') : statuses.some((status) => status === 'completed');
    });
  }

  async requestApproval(missionId, workItem) {
    const approvalSecret = await this.approvalSecret();
    return this.store.update(missionId, ({ state, emit }) => {
      const current = state.mission.work_items.find((item) => item.work_item_id === workItem.work_item_id);
      if (!current || current.status !== 'pending') throw new ConflictError('Approval work item is no longer pending');
      const approvalId = randomId('approval');
      const challenge = hmacSha256(approvalSecret, { mission_id: missionId, work_item_id: current.work_item_id, approval_id: approvalId }).slice(0, 32);
      const approval = {
        approval_id: approvalId,
        work_item_id: current.work_item_id,
        kind: 'mission-risk-gate',
        reason: `Approval required for ${state.mission.task.risk} risk / external effect policy`,
        challenge,
        status: 'pending',
        requested_at: nowIso(),
        decided_at: null,
        decision_source: null,
      };
      state.approvals.push(approval);
      current.status = 'waiting_approval';
      state.status = 'waiting_approval';
      emit('approval.requested', 'company-runtime', { approval_id: approvalId, work_item_id: current.work_item_id });
      return state;
    });
  }

  async decide(missionId, { approval_id, challenge, decision, actor = 'external-human', decision_source = 'operator' }) {
    if (!['approved', 'denied'].includes(decision)) throw new ValidationError('Decision must be approved or denied');
    if (actor !== 'external-human' || !['operator', 'proofgraph-cli', 'host-ui-confirmed'].includes(decision_source)) throw new PolicyError('Approval decision requires external human operator source');
    return this.store.update(missionId, ({ state, emit }) => {
      const approval = state.approvals.find((item) => item.approval_id === approval_id);
      if (!approval || approval.status !== 'pending') throw new ConflictError('Approval is not pending');
      if (approval.challenge !== challenge) throw new PolicyError('Approval challenge mismatch');
      approval.status = decision;
      approval.decided_at = nowIso();
      approval.decision_source = decision_source;
      approval.actor = actor;
      const item = state.mission.work_items.find((candidate) => candidate.work_item_id === approval.work_item_id);
      if (decision === 'approved') {
        item.status = 'completed'; item.attempts += 1; item.output = { approved: true, approval_id };
        state.status = 'active';
      } else {
        item.status = 'failed'; item.failure = { type: 'approval_denied', severity: 'high', retryable: false, message: 'External human denied mission gate' };
        state.failures.push({ work_item_id: item.work_item_id, ...item.failure });
        state.status = 'failed';
      }
      emit(`approval.${decision}`, actor, { approval_id, work_item_id: item.work_item_id, decision_source });
      return state;
    });
  }

  async claim(missionId) {
    let claimed = null;
    const state = await this.store.update(missionId, ({ state: next, emit }) => {
      if (next.status !== 'active' || next.operator?.paused === true) return next;
      if (next.tick_count >= next.mission.policy.max_ticks) {
        next.status = 'partial'; next.failure_reason = 'max_ticks_exceeded';
        emit('mission.budget_exceeded', 'company-runtime', { limit: 'max_ticks' });
        return next;
      }
      const ready = this.readyItems(next).sort((a, b) => a.sequence - b.sequence);
      const item = ready[0];
      if (!item) return next;
      if (item.kind === 'join') {
        item.status = 'completed'; item.attempts += 1; item.output = { joined: item.dependencies };
        next.tick_count += 1;
        emit('work_item.joined', 'company-runtime', { work_item_id: item.work_item_id });
        return next;
      }
      if (item.kind === 'human_approval' || item.approval_required) return next;
      item.status = 'running'; item.attempts += 1; item.started_at = nowIso();
      claimed = cloneJson(item);
      next.tick_count += 1;
      emit('work_item.claimed', item.assigned_role_id, { work_item_id: item.work_item_id, attempt: item.attempts });
      emit(EVENT_TYPES.NODE_PROGRESS, item.assigned_role_id, { work_item_id: item.work_item_id, status: 'running', attempt: item.attempts, max_attempts: item.max_attempts });
      return next;
    });
    return { state, claimed };
  }

  async completeClaim(missionId, workItem, report) {
    const integrity = await this.graphPort.verifyIntegrity(report);
    if (integrity?.ok !== true) throw new IntegrityError(`Graph report integrity failed for ${workItem.work_item_id}`, integrity);
    const before = await this.status(missionId);
    const processed = this.intelligence ? this.intelligence.processReport({ state: before, workItem, report }) : null;
    let updated = await this.store.update(missionId, ({ state, emit }) => {
      const item = state.mission.work_items.find((candidate) => candidate.work_item_id === workItem.work_item_id);
      if (!item || item.status !== 'running' || item.attempts !== workItem.attempts) throw new ConflictError('Stale work item completion');
      if (processed) state.intelligence = cloneJson(processed.intelligence);
      item.run_ids.push(report.run_id);
      item.completed_at = nowIso();
      state.usage.calls += report.usage?.calls ?? 1;
      state.usage.tokens += report.usage?.tokens ?? 0;
      state.usage.cost_micros += report.usage?.cost_micros ?? 0;
      if (report.status === 'success' || report.status === 'simulated') {
        const simulated = (report.status === 'simulated' || report.execution?.mode === 'simulation') && !this.allowSimulationPromotion;
        if (report.execution?.real_model_invoked) state.execution.model_invocations += 1;
        if (report.execution?.real_tools_invoked) state.execution.tool_invocations += 1;
        item.status = 'completed'; item.output = cloneJson(report.output); item.failure = null;
        const resolvedFailures = state.failures.filter((failure) => failure.work_item_id === item.work_item_id && (failure.status ?? 'unresolved') !== 'resolved' && Number(failure.attempt ?? 0) < Number(item.attempts ?? 0));
        for (const failure of resolvedFailures) {
          failure.status = 'resolved'; failure.resolved_at = nowIso(); failure.resolved_by_attempt = item.attempts;
          emit(EVENT_TYPES.FAILURE_RESOLVED, item.assigned_role_id, { failure_id: failureIdentity(failure), work_item_id: item.work_item_id, resolved_by_attempt: item.attempts });
        }
        for (const route of state.route_history ?? []) {
          if (route.from === item.work_item_id && route.status !== 'exited') {
            route.status = 'exited'; route.exited_at = nowIso(); route.exit_reason = 'target_completed';
            emit(EVENT_TYPES.LOOP_EXITED, item.assigned_role_id, { loop_id: route.loop_id, source_node: route.from, target_node: route.to, iteration: route.iteration, exit_reason: route.exit_reason });
          }
        }
        const candidates = simulated ? [] : this.artifacts.candidateFromReport(report, item);
        if (!simulated) state.artifact_candidates.push(...candidates);
        if (!simulated && item.kind === 'verify' && report.verification?.passed === true && report.verification?.independent === true) {
          const unverified = state.artifact_candidates.filter((candidate) => candidate.status === 'candidate' && candidate.producer_role_id !== item.assigned_role_id);
          const promoted = this.artifacts.promote(unverified, report, item);
          const promotedIds = new Set(promoted.map((artifact) => artifact.artifact_id));
          state.artifact_candidates = state.artifact_candidates.filter((candidate) => !promotedIds.has(candidate.artifact_id));
          state.artifacts.push(...promoted);
        }
        emit(simulated ? 'work_item.simulated' : 'work_item.completed', item.assigned_role_id, { work_item_id: item.work_item_id, run_id: report.run_id, artifact_candidates: candidates.length, execution_mode: report.execution?.mode ?? this.executionMode });
        if (processed) {
          emit('intelligence.report_ingested', 'intelligence-fabric', { work_item_id: item.work_item_id, knowledge_revision: processed.intelligence.knowledge_graph.revision, contract_count: processed.intelligence.contracts.length, impact_count: processed.intelligence.impacts.length });
          if (processed.model_observation) emit('intelligence.model_observed', 'model-router', { work_item_id: item.work_item_id, observation_id: processed.model_observation.observation_id, model_id: processed.model_observation.model_id, host: processed.model_observation.host, status: processed.model_observation.status, latency_ms: processed.model_observation.latency_ms, tokens: processed.model_observation.tokens, cost_micros: processed.model_observation.cost_micros });
        }
      } else {
        item.status = 'failed'; item.failure = cloneJson(report.failure ?? { type: 'unknown_failure', severity: 'medium', retryable: false, message: 'Unknown failure' });
        const failureRecord = { work_item_id: item.work_item_id, attempt: item.attempts, status: 'unresolved', ...item.failure };
        failureRecord.failure_id = failureIdentity(failureRecord);
        state.failures.push(failureRecord);
        emit('work_item.failed', item.assigned_role_id, { work_item_id: item.work_item_id, failure: item.failure });
        this.routeFailure(state, item, emit);
      }
      return state;
    });
    if (processed?.memory_inputs?.length) {
      const memoryRefs = await this.intelligence.persistMemories(processed.memory_inputs);
      if (memoryRefs.length) {
        updated = await this.store.update(missionId, ({ state, emit }) => {
          const intel = cloneJson(state.intelligence);
          const existing = new Set((intel.memory_captured ?? []).map((item) => item.memory_id));
          intel.memory_captured = [...(intel.memory_captured ?? []), ...memoryRefs.filter((item) => !existing.has(item.memory_id))].slice(-2000);
          state.intelligence = cloneJson(this.intelligence.seal(intel));
          emit('intelligence.memory_captured', 'memory-runtime', { work_item_id: workItem.work_item_id, memory_refs: memoryRefs });
          return state;
        });
      }
    }
    return updated;
  }

  routeFailure(state, failedItem, emit = () => {}) {
    const type = failedItem.failure?.type;
    const targetKind = type === 'evidence_gap' ? 'research' : ['design_error', 'requirements_error'].includes(type) ? 'plan' : type === 'security_risk' ? 'human_approval' : 'develop';
    const target = state.mission.work_items.find((item) => item.kind === targetKind);
    const canRetry = failedItem.failure?.retryable !== false && failedItem.attempts < failedItem.max_attempts && target;
    if (canRetry) {
      failedItem.status = 'pending';
      if (target.status === 'completed' || target.status === 'failed') target.status = 'pending';
      state.route_history ??= [];
      const previousRoutes = state.route_history.filter((route) => route.from === failedItem.work_item_id && route.to === target.work_item_id && route.failure_type === type);
      const iteration = previousRoutes.length + 1;
      const maxIterations = Math.max(1, failedItem.max_attempts - 1);
      const loopId = `loop:${failedItem.work_item_id}->${target.work_item_id}:${type}`;
      const route = {
        route_id: `${loopId}:${iteration}`,
        loop_id: loopId,
        at: nowIso(),
        from: failedItem.work_item_id,
        to: target.work_item_id,
        failure_type: type,
        iteration,
        max_iterations: maxIterations,
        status: 'active',
        exit_reason: null,
      };
      state.route_history.push(route);
      emit(EVENT_TYPES.ROUTE_CHANGED, 'company-runtime', route);
      emit(iteration === 1 ? EVENT_TYPES.LOOP_ENTERED : EVENT_TYPES.LOOP_ITERATION, 'company-runtime', route);
      emit(EVENT_TYPES.NODE_RETRY_SCHEDULED, 'company-runtime', { work_item_id: target.work_item_id, source_work_item_id: failedItem.work_item_id, failure_type: type, iteration, max_iterations: maxIterations });
      return;
    }
    const previousRoutes = state.route_history?.filter((route) => route.from === failedItem.work_item_id && route.failure_type === type) ?? [];
    emit(EVENT_TYPES.LOOP_EXHAUSTED, 'company-runtime', {
      loop_id: previousRoutes.at(-1)?.loop_id ?? `loop:${failedItem.work_item_id}:${type}`,
      source_node: failedItem.work_item_id,
      target_node: target?.work_item_id ?? null,
      iteration: previousRoutes.length,
      max_iterations: Math.max(0, failedItem.max_attempts - 1),
      failure_type: type,
    });
    if (state.failures.filter((failure) => (failure.status ?? 'unresolved') !== 'resolved').length >= state.mission.policy.max_failures || failedItem.failure?.severity === 'critical') state.status = 'failed';
    else state.status = 'partial';
  }

  async tick(missionId) {
    let state = await this.status(missionId);
    if (terminal(state.status) || state.status === 'waiting_approval' || state.operator?.paused === true) return state;
    if (state.status === 'planned') state = await this.start(missionId);
    const approvalItem = this.readyItems(state).find((item) => item.kind === 'human_approval' || item.approval_required);
    if (approvalItem) return this.requestApproval(missionId, approvalItem);
    const { state: afterClaim, claimed } = await this.claim(missionId);
    if (!claimed) return this.reconcile(missionId, afterClaim);
    let prepared = null;
    if (this.intelligence) {
      prepared = await this.intelligence.prepareExecution({ state: afterClaim, workItem: claimed });
      await this.store.update(missionId, ({ state: next, emit }) => {
        const current = next.mission.work_items.find((item) => item.work_item_id === claimed.work_item_id);
        if (!current || current.status !== 'running' || current.attempts !== claimed.attempts) throw new ConflictError('Stale intelligence preparation');
        next.intelligence = cloneJson(prepared.intelligence);
        emit('intelligence.context_compiled', current.assigned_role_id, { work_item_id: current.work_item_id, context_packet_id: prepared.bundle.context_packet.packet_id, bytes: prepared.bundle.context_packet.byte_size, redactions: prepared.bundle.context_packet.redactions.length });
        emit('intelligence.model_routed', 'model-router', { work_item_id: current.work_item_id, route_id: prepared.bundle.route_decision.route_id, model_id: prepared.bundle.route_decision.model_id, host: prepared.bundle.route_decision.host });
        emit('intelligence.collaboration_prepared', 'collaboration-runtime', { work_item_id: current.work_item_id, contract_ids: prepared.bundle.contracts.map((item) => item.contract_id), handoff_ids: prepared.bundle.handoffs.map((item) => item.handoff_id) });
        return next;
      });
    }
    const request = {
      request_id: randomId('request'),
      mission_id: missionId,
      task: afterClaim.mission.task,
      organization: afterClaim.mission.organization,
      work_item: claimed,
      adapter: prepared?.bundle.route_decision.host ?? 'reference',
      model_id: prepared?.bundle.route_decision.model_id ?? null,
      intelligence: prepared?.bundle ?? null,
      context_packet: prepared?.bundle.context_packet ?? null,
      route_decision: prepared?.bundle.route_decision ?? null,
      collaboration: prepared ? { contracts: prepared.bundle.contracts, handoffs: prepared.bundle.handoffs } : null,
      knowledge_impacts: prepared?.bundle.impacts ?? [],
      memory_refs: prepared?.bundle.memory_refs ?? [],
    };
    let report;
    try { report = await this.graphPort.execute(request); }
    catch (error) {
      report = {
        schema_version: 1, run_id: randomId('run'), request_id: request.request_id, mission_id: missionId, work_item_id: claimed.work_item_id,
        stage_id: claimed.stage_id, kind: claimed.kind, assigned_role_id: claimed.assigned_role_id, status: 'failed', output: null,
        verification: { passed: false, independent: false, evidence: [] },
        failure: { type: 'adapter_error', severity: 'high', message: error.message, evidence: [], retryable: true },
        usage: { calls: 1, tokens: 0, cost_micros: 0, wall_time_ms: 0 },
      };
      const digestInput = cloneJson(report);
      delete digestInput.integrity;
      report.integrity = { report_digest: sha256(digestInput) };
    }
    return this.completeClaim(missionId, claimed, report);
  }


  async recoverInterrupted(missionId, { olderThanMs = 0, actor = 'external-operator' } = {}) {
    if (actor !== 'external-operator') throw new PolicyError('Interrupted work recovery requires an external operator');
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new ValidationError('olderThanMs must be a non-negative integer');
    const cutoff = Date.now() - olderThanMs;
    return this.store.update(missionId, ({ state, emit }) => {
      let recovered = 0;
      for (const item of state.mission.work_items) {
        if (item.status === 'running' && (!item.started_at || Date.parse(item.started_at) <= cutoff)) {
          item.status = 'pending';
          item.failure = { type: 'interrupted_execution', severity: 'medium', retryable: true, message: 'Operator recovered an interrupted work item' };
          recovered += 1;
          emit('work_item.recovered', actor, { work_item_id: item.work_item_id, previous_started_at: item.started_at ?? null });
        }
      }
      if (recovered && !terminal(state.status)) state.status = 'active';
      state.last_recovery = { at: nowIso(), recovered, actor };
      return state;
    });
  }

  async reconcile(missionId, provided = null) {
    const state = provided ?? await this.status(missionId);
    if (terminal(state.status) || state.status === 'waiting_approval') return state;
    const all = state.mission.work_items;
    if (all.every((item) => item.status === 'completed')) {
      const intelligenceGate = this.intelligence ? await this.intelligence.terminalGate(state) : null;
      return this.store.update(missionId, ({ state: next, emit }) => {
        if (intelligenceGate) next.intelligence = cloneJson(intelligenceGate.intelligence);
        const verified = next.artifacts.length > 0 || !next.mission.task.requires_implementation;
        const intelligencePassed = intelligenceGate?.verification?.passed !== false;
        const simulationBlocked = next.execution?.mode === 'simulation' && !next.execution?.simulation_promotion_allowed;
        next.status = simulationBlocked ? 'simulated' : (verified && intelligencePassed ? 'completed' : 'partial');
        const unresolved = next.failures.filter((failure) => (failure.status ?? 'unresolved') !== 'resolved');
        next.quality_gate_passed = !simulationBlocked && verified && unresolved.length === 0 && intelligencePassed;
        next.mission.projects.forEach((item) => { item.status = next.status; });
        next.mission.sprints.forEach((item) => { item.status = next.status; });
        if (intelligenceGate) emit('intelligence.terminal_verified', 'intelligence-verifier', { passed: intelligenceGate.verification.passed, verification_id: intelligenceGate.verification.verification_id, blocking_failures: intelligenceGate.verification.blocking_failures });
        emit('mission.terminal', 'company-runtime', { status: next.status, quality_gate_passed: next.quality_gate_passed, execution_mode: next.execution?.mode, real_execution: next.execution?.real_execution });
        return next;
      });
    }
    const active = all.some((item) => ['pending', 'ready', 'running', 'waiting_approval'].includes(item.status));
    if (!active) {
      return this.store.update(missionId, ({ state: next, emit }) => {
        next.status = next.failures.length ? 'failed' : 'partial';
        emit('mission.terminal', 'company-runtime', { status: next.status, reason: 'no_runnable_work' });
        return next;
      });
    }
    return state;
  }

  async run(missionId, { maxTicks = null } = {}) {
    const initial = await this.status(missionId);
    const limit = maxTicks ?? initial.mission.policy.max_ticks;
    let state = initial;
    for (let index = 0; index < limit; index += 1) {
      state = await this.tick(missionId);
      if (terminal(state.status) || state.status === 'waiting_approval' || state.operator?.paused === true) return state;
    }
    throw new BudgetError('run() exhausted caller tick limit');
  }

  async pause(missionId, { actor = 'external-human', reason = 'operator pause' } = {}) {
    if (actor !== 'external-human') throw new PolicyError('Only external human operator can pause a mission');
    return this.store.update(missionId, ({ state, emit }) => {
      if (terminal(state.status)) return state;
      state.operator ??= { paused: false, paused_at: null, paused_by: null, reason: null };
      state.operator = { paused: true, paused_at: nowIso(), paused_by: actor, reason: String(reason) };
      emit(EVENT_TYPES.RUN_PAUSED, actor, { reason: state.operator.reason });
      return state;
    });
  }

  async resume(missionId, { actor = 'external-human' } = {}) {
    if (actor !== 'external-human') throw new PolicyError('Only external human operator can resume a mission');
    return this.store.update(missionId, ({ state, emit }) => {
      if (terminal(state.status)) return state;
      state.operator ??= { paused: false, paused_at: null, paused_by: null, reason: null };
      state.operator = { paused: false, paused_at: null, paused_by: actor, reason: null };
      if (state.status === 'planned') state.status = 'active';
      emit(EVENT_TYPES.RUN_RESUMED, actor, {});
      return state;
    });
  }

  async retryWorkItem(missionId, workItemId, { actor = 'external-human', reason = 'operator retry' } = {}) {
    if (actor !== 'external-human') throw new PolicyError('Only external human operator can retry work');
    return this.store.update(missionId, ({ state, emit }) => {
      if (terminal(state.status) && state.status !== 'partial' && state.status !== 'failed') throw new ConflictError('Completed or aborted mission cannot be retried');
      const item = state.mission.work_items.find((candidate) => candidate.work_item_id === workItemId || candidate.stage_id === workItemId);
      if (!item) throw new ValidationError('Work item not found');
      if (!['failed', 'blocked', 'pending'].includes(item.status)) throw new ConflictError(`Work item cannot be retried from ${item.status}`);
      if (item.attempts >= item.max_attempts) throw new BudgetError('Work item retry budget exhausted');
      item.status = 'pending'; item.failure = null; item.completed_at = null;
      state.status = 'active';
      state.operator ??= { paused: false, paused_at: null, paused_by: null, reason: null };
      state.operator.paused = false;
      emit(EVENT_TYPES.NODE_RETRY_SCHEDULED, actor, { work_item_id: item.work_item_id, reason: String(reason), next_attempt: item.attempts + 1 });
      return state;
    });
  }

  async proposeDelivery(missionId, options = {}) {
    const approvalSecret = await this.approvalSecret();
    return this.store.update(missionId, ({ state, emit }) => {
      if (!['completed', 'partial'].includes(state.status)) throw new PolicyError('Mission must be terminal before delivery proposal');
      const proposal = this.delivery.propose({ mission_id: missionId, artifacts: state.artifacts, ...options });
      if (proposal.approval_required) {
        const approvalId = randomId('approval');
        const challenge = hmacSha256(approvalSecret, {
          mission_id: missionId,
          delivery_id: proposal.delivery_id,
          proposal_digest: proposal.digest,
          approval_id: approvalId,
        }).slice(0, 32);
        const approval = {
          approval_id: approvalId,
          kind: 'delivery',
          mission_id: missionId,
          delivery_id: proposal.delivery_id,
          proposal_digest: proposal.digest,
          challenge,
          status: 'pending',
          requested_at: nowIso(),
          decided_at: null,
          decision_source: null,
          actor: null,
        };
        state.approvals.push(approval);
      }
      state.deliveries.push(proposal);
      emit('delivery.proposed', 'delivery-runtime', {
        delivery_id: proposal.delivery_id,
        approval_required: proposal.approval_required,
        approval_id: proposal.approval_required ? state.approvals.at(-1)?.approval_id ?? null : null,
      });
      return state;
    });
  }

  async decideDelivery(missionId, { approval_id, challenge, decision, actor = 'external-human', decision_source = 'operator' }) {
    if (!['approved', 'denied'].includes(decision)) throw new ValidationError('Decision must be approved or denied');
    if (actor !== 'external-human' || !['operator', 'proofgraph-cli', 'host-ui-confirmed'].includes(decision_source)) {
      throw new PolicyError('Delivery approval requires external human operator source');
    }
    return this.store.update(missionId, ({ state, emit }) => {
      const approval = state.approvals.find((item) => item.approval_id === approval_id && item.kind === 'delivery');
      if (!approval || approval.status !== 'pending') throw new ConflictError('Delivery approval is not pending');
      if (approval.challenge !== challenge) throw new PolicyError('Delivery approval challenge mismatch');
      const proposal = state.deliveries.find((item) => item.delivery_id === approval.delivery_id);
      if (!proposal || proposal.digest !== approval.proposal_digest) throw new IntegrityError('Delivery approval is not bound to the current proposal');
      approval.status = decision;
      approval.decided_at = nowIso();
      approval.decision_source = decision_source;
      approval.actor = actor;
      if (decision === 'denied') proposal.status = 'denied';
      emit(`delivery.approval.${decision}`, actor, { approval_id, delivery_id: proposal.delivery_id, decision_source });
      return state;
    });
  }

  async executeDelivery(missionId, deliveryId) {
    const state = await this.status(missionId);
    const proposal = state.deliveries.find((item) => item.delivery_id === deliveryId);
    if (!proposal) throw new ValidationError('Delivery proposal not found');
    if (proposal.executed) throw new ConflictError('Delivery already executed');
    const approval = proposal.approval_required
      ? state.approvals.find((item) => item.kind === 'delivery' && item.delivery_id === proposal.delivery_id)
      : null;
    if (proposal.approval_required && (!approval || approval.status !== 'approved'
      || approval.delivery_id !== proposal.delivery_id || approval.proposal_digest !== proposal.digest
      || approval.actor !== 'external-human')) {
      throw new PolicyError('Delivery requires a persisted, proposal-bound external approval');
    }
    const receipt = await this.delivery.execute(proposal, { approval });
    return this.store.update(missionId, ({ state: next, emit }) => {
      const current = next.deliveries.find((candidate) => candidate.delivery_id === deliveryId);
      if (!current || current.executed) throw new ConflictError('Delivery is missing or already executed');
      const currentApproval = current.approval_required
        ? next.approvals.find((item) => item.kind === 'delivery' && item.delivery_id === current.delivery_id)
        : null;
      if (current.approval_required && (!currentApproval || currentApproval.status !== 'approved'
        || currentApproval.proposal_digest !== current.digest)) throw new PolicyError('Delivery approval changed before commit');
      next.receipts.push(receipt);
      current.status = 'completed'; current.executed = true; current.receipt_id = receipt.receipt_id;
      emit('delivery.completed', 'delivery-runtime', { delivery_id: deliveryId, receipt_id: receipt.receipt_id, dry_run: receipt.dry_run });
      return next;
    });
  }

  async abort(missionId, reason, actor = 'external-human') {
    if (actor !== 'external-human') throw new PolicyError('Only external human operator can abort a mission');
    return this.store.update(missionId, ({ state, emit }) => {
      if (terminal(state.status)) return state;
      state.status = 'aborted'; state.abort_reason = String(reason ?? 'operator abort');
      emit('mission.aborted', actor, { reason: state.abort_reason });
      return state;
    });
  }

  async verifyIntegrity(missionId) {
    const state = await this.store.read(missionId);
    for (const artifact of state.artifacts) this.artifacts.verify(artifact);
    const eventHead = await this.store.verifyEvents(missionId, state.event_head);
    const intelligence = this.intelligence && state.intelligence ? await this.intelligence.verifyIntegrity(state) : null;
    return { ok: true, mission_id: missionId, state_digest: state.integrity.state_digest, event_head: eventHead, artifacts: state.artifacts.length, intelligence };
  }

  async report(missionId) {
    const state = await this.status(missionId);
    return {
      schema_version: 1,
      mission_id: missionId,
      objective: state.mission.objective,
      status: state.status,
      quality_gate_passed: state.quality_gate_passed,
      task: { task_id: state.mission.task.task_id, archetype: state.mission.task.archetype, risk: state.mission.task.risk },
      organization: { organization_id: state.mission.organization.organization_id, departments: state.mission.organization.departments.length, roles: state.mission.organization.roles.length },
      work_items: state.mission.work_items.map(({ work_item_id, stage_id, kind, assigned_role_id, status, attempts, failure }) => ({ work_item_id, stage_id, kind, assigned_role_id, status, attempts, failure })),
      failures: cloneJson(state.failures),
      route_history: cloneJson(state.route_history ?? []),
      operator: cloneJson(state.operator ?? { paused: false }),
      approvals: cloneJson(state.approvals),
      artifact_candidates: cloneJson(state.artifact_candidates),
      artifacts: cloneJson(state.artifacts),
      deliveries: cloneJson(state.deliveries),
      receipts: cloneJson(state.receipts),
      usage: cloneJson(state.usage),
      intelligence: state.intelligence ? {
        fabric_version: state.intelligence.fabric_version,
        model_registry_version: state.intelligence.model_registry_version,
        context_packets: cloneJson(state.intelligence.context_packets),
        route_decisions: cloneJson(state.intelligence.route_decisions),
        model_observations: cloneJson(state.intelligence.model_observations ?? []),
        contracts: cloneJson(state.intelligence.contracts),
        handoffs: cloneJson(state.intelligence.handoffs),
        impacts: cloneJson(state.intelligence.impacts),
        memory_recalled: cloneJson(state.intelligence.memory_recalled),
        memory_captured: cloneJson(state.intelligence.memory_captured),
        verifications: cloneJson(state.intelligence.verifications),
        knowledge_graph: cloneJson(state.intelligence.knowledge_graph),
        stats: cloneJson(state.intelligence.stats),
        digest: state.intelligence.digest,
      } : null,
      integrity: cloneJson(state.integrity),
    };
  }
}
