import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson, deterministicId, hmacSha256, sha256 } from '../core/canonical.mjs';
import { BudgetError, ConflictError, PolicyError, ValidationError } from '../core/errors.mjs';
import { boundedJson, integer, plainObject, stringValue, unknownKeys } from '../core/validate.mjs';
import { loadOrCreateSecret } from '../core/secret-store.mjs';
import { CompanyRuntime } from '../company/company-runtime.mjs';
import { compileTaskSpec } from '../task-intelligence/task-spec.mjs';
import { GovernancePolicyEngine } from './governance.mjs';
import { CouncilRuntime } from './council.mjs';
import { ImprovementEngine } from './improvement.mjs';

export class AutonomousOrganizationOS {
  constructor({ dataDir, companyRuntime = null, governance = new GovernancePolicyEngine(), council = new CouncilRuntime(), improvement = new ImprovementEngine(), approvalSecret = null }) {
    this.dataDir = dataDir;
    this.company = companyRuntime ?? new CompanyRuntime({ dataDir });
    this.governance = governance;
    this.council = council;
    this.improvement = improvement;
    this.store = new HashChainStore(dataDir, { namespace: 'organization-os' });
    this.approvalSecretOptions = { filename: '.os-approval-secret', provided: approvalSecret };
    this._approvalSecretPromise = null;
  }


  approvalSecret() {
    this._approvalSecretPromise ??= loadOrCreateSecret(this.dataDir, this.approvalSecretOptions);
    return this._approvalSecretPromise;
  }

  async create(input) {
    plainObject(input, 'input');
    unknownKeys(input, ['objective', 'workspace', 'constraints', 'signals', 'deliverables', 'acceptance_criteria', 'metadata', 'max_cycles'], 'input');
    boundedJson(input, 'input', { maxBytes: 2_500_000 });
    const objective = stringValue(input.objective, 'objective', { min: 3, max: 20_000 });
    const maxCycles = input.max_cycles == null
      ? this.governance.policy.max_autonomous_cycles
      : integer(input.max_cycles, 'max_cycles', { min: 1, max: this.governance.policy.max_autonomous_cycles });
    const { max_cycles: _maxCycles, ...missionInput } = input;
    // Validate the complete future mission input before persisting an OS run.
    // This prevents an apparently valid OS record from failing only after the first cycle starts.
    compileTaskSpec(missionInput);
    const normalizedInput = cloneJson({ ...missionInput, objective, max_cycles: maxCycles });
    const osId = deterministicId('osrun', { input: normalizedInput, policy: this.governance.policy.version });
    const initial = {
      schema_version: 1,
      os_run_id: osId,
      objective,
      input: normalizedInput,
      status: 'planned',
      cycle: 0,
      max_cycles: maxCycles,
      mission_ids: [],
      council_records: [],
      improvement_proposals: [],
      approvals: [],
      failures: [],
      current_mission_id: null,
      quality_gate_passed: false,
      created_at: new Date().toISOString(),
    };
    return this.store.create(osId, initial, { type: 'os.created', actor: 'executive-manager', data: { objective_digest: sha256(objective) } });
  }

  async status(osRunId) { return this.store.read(osRunId); }

  async createNextMission(osRunId) {
    const osState = await this.status(osRunId);
    if (osState.cycle >= osState.max_cycles) throw new BudgetError('Autonomous cycle limit reached');
    const constraints = [...(osState.input.constraints ?? [])];
    if (osState.failures.length) constraints.push(`Previous mission failures to address: ${JSON.stringify(osState.failures.slice(-10))}`);
    constraints.push(`Autonomous organization cycle ${osState.cycle + 1} of ${osState.max_cycles}; do not weaken verification or approval.`);
    const { max_cycles: _maxCycles, ...missionInput } = osState.input;
    const missionState = await this.company.create({ ...missionInput, objective: osState.objective, constraints, metadata: { ...(missionInput.metadata ?? {}), os_run_id: osRunId, cycle: osState.cycle + 1 } });
    await this.store.update(osRunId, ({ state, emit }) => {
      state.cycle += 1; state.status = 'active'; state.current_mission_id = missionState.mission.mission_id; state.mission_ids.push(missionState.mission.mission_id);
      emit('os.mission_created', 'executive-manager', { mission_id: missionState.mission.mission_id, cycle: state.cycle }); return state;
    });
    return missionState;
  }

  councilForFailure(osState, missionReport) {
    const evidence = missionReport.failures.map((failure) => ({ work_item_id: failure.work_item_id, type: failure.type, message: failure.message }));
    return this.council.convene({
      subject: { os_run_id: osState.os_run_id, mission_id: missionReport.mission_id, status: missionReport.status },
      proposals: [
        { role_id: 'executive-manager', independence_group: 'executive', recommendation: 'retry', confidence: 0.6, evidence, risks: ['repeat_cost'] },
        { role_id: 'independent-verifier', independence_group: 'quality', recommendation: missionReport.failures.some((item) => item.severity === 'critical') ? 'escalate' : 'retry', confidence: 0.8, evidence, risks: ['quality_risk'] },
        { role_id: 'risk-officer', independence_group: 'risk', recommendation: missionReport.task.risk === 'low' ? 'retry' : 'escalate', confidence: 0.75, evidence, risks: ['policy_risk'] },
      ],
    });
  }

  async runCycle(osRunId) {
    let osState = await this.status(osRunId);
    if (['completed', 'failed', 'waiting_approval', 'aborted'].includes(osState.status)) return osState;
    if (!osState.current_mission_id) await this.createNextMission(osRunId);
    osState = await this.status(osRunId);
    let mission = await this.company.status(osState.current_mission_id);
    if (mission.status === 'planned') mission = await this.company.start(osState.current_mission_id);
    mission = await this.company.run(osState.current_mission_id, { maxTicks: mission.mission.policy.max_ticks });
    if (mission.status === 'waiting_approval') {
      return this.store.update(osRunId, ({ state, emit }) => { state.status = 'waiting_approval'; emit('os.waiting_approval', 'governance', { mission_id: state.current_mission_id }); return state; });
    }
    const report = await this.company.report(osState.current_mission_id);
    if (report.status === 'completed' && report.quality_gate_passed) {
      return this.store.update(osRunId, ({ state, emit }) => { state.status = 'completed'; state.quality_gate_passed = true; emit('os.completed', 'executive-manager', { mission_id: report.mission_id }); return state; });
    }
    const council = this.councilForFailure(osState, report);
    const action = { type: 'autonomous_retry', actor_type: 'system', risk: report.task.risk, external_effect: false, irreversible: false };
    const policy = this.governance.evaluate(action);
    const proposal = this.improvement.propose({
      source_run_id: report.mission_id,
      metrics: { quality_gate_passed: report.quality_gate_passed, status: report.status, usage: report.usage },
      failures: report.failures,
      evidence: council.proposals.map((item) => ({ proposal_id: item.proposal_id, recommendation: item.recommendation, evidence: item.evidence })),
    });
    const approvalSecret = await this.approvalSecret();
    const next = await this.store.update(osRunId, ({ state, emit }) => {
      state.council_records.push(council); state.improvement_proposals.push(proposal); state.failures.push(...report.failures);
      state.current_mission_id = null;
      if (council.decision === 'retry' && policy.decision === 'allow' && state.cycle < state.max_cycles) state.status = 'active';
      else if (policy.decision === 'require_approval' || council.decision === 'escalate') {
        state.status = 'waiting_approval';
        const approval_id = deterministicId('osapproval', { os_run_id: state.os_run_id, cycle: state.cycle, council: council.digest });
        const challenge = hmacSha256(approvalSecret, { os_run_id: state.os_run_id, approval_id, council: council.digest }).slice(0, 32);
        state.approvals.push({ approval_id, challenge, status: 'pending', action: 'retry', council_digest: council.digest, requested_at: new Date().toISOString() });
      } else state.status = 'failed';
      emit('os.cycle_reviewed', 'governance', { council_status: council.status, decision: council.decision, policy: policy.decision, next_status: state.status });
      return state;
    });
    return next;
  }

  async run(osRunId) {
    let state = await this.status(osRunId);
    for (let index = 0; index < state.max_cycles + 1; index += 1) {
      state = await this.runCycle(osRunId);
      if (['completed', 'failed', 'waiting_approval', 'aborted'].includes(state.status)) return state;
    }
    throw new BudgetError('Autonomous organization loop exceeded bound');
  }


  async resolveOSApproval(osRunId, { approval_id, challenge, decision, actor = 'external-human', decision_source = 'operator' }) {
    if (!['approved', 'denied'].includes(decision)) throw new ValidationError('Decision must be approved or denied');
    if (actor !== 'external-human' || !['operator', 'proofgraph-cli', 'host-ui-confirmed'].includes(decision_source)) throw new PolicyError('OS approval requires external human operator source');
    return this.store.update(osRunId, ({ state, emit }) => {
      const approval = state.approvals.find((item) => item.approval_id === approval_id);
      if (!approval || approval.status !== 'pending') throw new ConflictError('OS approval is not pending');
      if (approval.challenge !== challenge) throw new PolicyError('OS approval challenge mismatch');
      approval.status = decision; approval.actor = actor; approval.decision_source = decision_source; approval.decided_at = new Date().toISOString();
      state.status = decision === 'approved' && state.cycle < state.max_cycles ? 'active' : 'failed';
      emit(`os.approval.${decision}`, actor, { approval_id, decision_source, next_status: state.status });
      return state;
    });
  }

  async resolveMissionApproval(osRunId, decision) {
    const state = await this.status(osRunId);
    if (state.status !== 'waiting_approval' || !state.current_mission_id) throw new ConflictError('OS run is not waiting on a mission approval');
    const mission = await this.company.status(state.current_mission_id);
    const approval = mission.approvals.find((item) => item.status === 'pending');
    if (!approval) throw new ConflictError('No pending mission approval');
    await this.company.decide(state.current_mission_id, { ...decision, approval_id: approval.approval_id, challenge: approval.challenge });
    return this.store.update(osRunId, ({ state: next, emit }) => { next.status = decision.decision === 'approved' ? 'active' : 'failed'; emit('os.approval_resolved', 'external-human', { decision: decision.decision }); return next; });
  }

  async abort(osRunId, reason, actor = 'external-human') {
    if (actor !== 'external-human') throw new PolicyError('Only external human operator can abort an OS run');
    const current = await this.status(osRunId);
    if (['completed', 'failed', 'aborted'].includes(current.status)) return current;
    if (current.current_mission_id) {
      try { await this.company.abort(current.current_mission_id, reason, actor); }
      catch (error) {
        if (!/Only external human|not found/i.test(error.message)) throw error;
      }
    }
    return this.store.update(osRunId, ({ state, emit }) => {
      state.status = 'aborted';
      state.abort_reason = String(reason ?? 'operator abort');
      emit('os.aborted', actor, { reason: state.abort_reason, mission_id: state.current_mission_id });
      return state;
    });
  }

  async verifyIntegrity(osRunId) {
    const state = await this.store.read(osRunId);
    for (const missionId of state.mission_ids) await this.company.verifyIntegrity(missionId);
    return { ok: true, os_run_id: osRunId, event_head: await this.store.verifyEvents(osRunId, state.event_head), missions: state.mission_ids.length };
  }

  async report(osRunId) {
    const state = await this.status(osRunId);
    const missions = [];
    for (const missionId of state.mission_ids) missions.push(await this.company.report(missionId));
    return {
      schema_version: 1, os_run_id: osRunId, objective: state.objective, status: state.status, cycle: state.cycle, max_cycles: state.max_cycles,
      quality_gate_passed: state.quality_gate_passed, missions, council_records: cloneJson(state.council_records),
      improvement_proposals: cloneJson(state.improvement_proposals), approvals: cloneJson(state.approvals), failures: cloneJson(state.failures), integrity: cloneJson(state.integrity),
    };
  }

  applyImprovement(proposal) { return this.improvement.apply(proposal); }
}
