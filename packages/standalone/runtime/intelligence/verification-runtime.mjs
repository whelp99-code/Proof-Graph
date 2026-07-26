import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { IntegrityError, ValidationError } from '../core/errors.mjs';
import { INTELLIGENCE_VERIFICATION_SCHEMA } from './domain.mjs';

function check(name, ok, details = null, severity = 'blocking') {
  return { name, ok: Boolean(ok), severity, details: details == null ? null : cloneJson(details) };
}

export class IntelligenceVerificationRuntime {
  constructor({ contextRuntime, modelRouter, collaborationRuntime, knowledgeGraphRuntime, memoryRuntime = null } = {}) {
    this.context = contextRuntime; this.router = modelRouter; this.collaboration = collaborationRuntime; this.knowledge = knowledgeGraphRuntime; this.memory = memoryRuntime;
  }

  verifyExecutionBundle(bundle) {
    const checks = [];
    try { checks.push(check('context_integrity', this.context.verify(bundle.context_packet).ok)); }
    catch (error) { checks.push(check('context_integrity', false, { error: error.message })); }
    try { checks.push(check('route_integrity', this.router.verify(bundle.route_decision).ok)); }
    catch (error) { checks.push(check('route_integrity', false, { error: error.message })); }
    checks.push(check('route_context_binding', bundle.route_decision.context_tokens === bundle.context_packet.token_estimate, { expected: bundle.context_packet.token_estimate, actual: bundle.route_decision.context_tokens }));
    checks.push(check('work_item_binding', bundle.context_packet.work_item_id === bundle.route_decision.work_item_id && bundle.context_packet.work_item_id === bundle.work_item_id));
    for (const contract of bundle.contracts ?? []) {
      try { checks.push(check(`contract:${contract.contract_id}`, this.collaboration.verify(contract).ok)); }
      catch (error) { checks.push(check(`contract:${contract.contract_id}`, false, { error: error.message })); }
    }
    for (const handoff of bundle.handoffs ?? []) checks.push(check(`handoff:${handoff.handoff_id}`, handoff.contract_id && handoff.context_packet_id === bundle.context_packet.packet_id && handoff.route_id === bundle.route_decision.route_id));
    const blocking = checks.filter((item) => !item.ok && item.severity === 'blocking');
    const report = {
      schema: INTELLIGENCE_VERIFICATION_SCHEMA,
      schema_version: 1,
      verification_id: deterministicId('intelverify', { work_item_id: bundle.work_item_id, context: bundle.context_packet.digest, route: bundle.route_decision.digest }),
      scope: 'execution_bundle', mission_id: bundle.mission_id, work_item_id: bundle.work_item_id,
      passed: blocking.length === 0, checks, blocking_failures: blocking.map((item) => item.name), verified_at: new Date().toISOString(),
    };
    report.digest = sha256(report);
    return deepFreeze(report);
  }

  async verifyTerminal({ state }) {
    const intelligence = state.intelligence;
    if (!intelligence) return deepFreeze({ schema: INTELLIGENCE_VERIFICATION_SCHEMA, schema_version: 1, scope: 'terminal', passed: false, checks: [check('intelligence_present', false)], blocking_failures: ['intelligence_present'], digest: sha256({ absent: true }) });
    const checks = [];
    try { checks.push(check('knowledge_integrity', this.knowledge.verify(intelligence.knowledge_graph).ok)); }
    catch (error) { checks.push(check('knowledge_integrity', false, { error: error.message })); }
    for (const packet of intelligence.context_packets ?? []) {
      try { checks.push(check(`context:${packet.packet_id}`, this.context.verify(packet).ok)); }
      catch (error) { checks.push(check(`context:${packet.packet_id}`, false, { error: error.message })); }
    }
    for (const route of intelligence.route_decisions ?? []) {
      try { checks.push(check(`route:${route.route_id}`, this.router.verify(route).ok)); }
      catch (error) { checks.push(check(`route:${route.route_id}`, false, { error: error.message })); }
    }
    const invalidImpacts = [];
    for (const impact of intelligence.impacts ?? []) {
      const copy = cloneJson(impact); const digest = copy.digest; delete copy.digest;
      if (digest !== sha256(copy)) invalidImpacts.push(impact.impact_id ?? 'unknown');
    }
    checks.push(check('impact_integrity', invalidImpacts.length === 0, { impact_ids: invalidImpacts }));
    const openContracts = (intelligence.contracts ?? []).filter((item) => ['proposed', 'acknowledged'].includes(item.status));
    checks.push(check('collaboration_contracts_closed', openContracts.length === 0, { open_contract_ids: openContracts.map((item) => item.contract_id) }));
    const criticalImpacts = (intelligence.impacts ?? []).filter((item) => item.action_required === true && ['high', 'critical'].includes(item.severity));
    const addressed = new Set((intelligence.contracts ?? []).filter((item) => item.type === 'impact_followup' && ['completed', 'rejected', 'blocked', 'cancelled'].includes(item.status)).flatMap((item) => item.input_refs.map((ref) => ref.id)));
    const unaddressed = criticalImpacts.filter((item) => !addressed.has(item.impact_id));
    checks.push(check('critical_impacts_addressed', unaddressed.length === 0, { impact_ids: unaddressed.map((item) => item.impact_id) }));
    const invalidMemory = [];
    for (const memory of intelligence.memory_recalled ?? []) {
      try {
        if (memory.status !== 'verified') invalidMemory.push(memory.memory_id);
        else if (this.memory) this.memory.verifyEntry(memory);
      } catch { invalidMemory.push(memory.memory_id); }
    }
    checks.push(check('recalled_memory_verified', invalidMemory.length === 0, { memory_ids: invalidMemory }));
    const bundleFailures = (intelligence.verifications ?? []).filter((item) => item.scope === 'execution_bundle' && item.passed !== true);
    checks.push(check('execution_bundles_verified', bundleFailures.length === 0, { verification_ids: bundleFailures.map((item) => item.verification_id) }));
    const blocking = checks.filter((item) => !item.ok && item.severity === 'blocking');
    const report = {
      schema: INTELLIGENCE_VERIFICATION_SCHEMA, schema_version: 1,
      verification_id: deterministicId('intelterminal', { mission_id: state.mission.mission_id, revision: state.revision, checks }),
      scope: 'terminal', mission_id: state.mission.mission_id, passed: blocking.length === 0, checks,
      blocking_failures: blocking.map((item) => item.name), verified_at: new Date().toISOString(),
    };
    report.digest = sha256(report);
    return deepFreeze(report);
  }

  verifyReport(report) {
    if (!report || typeof report !== 'object' || report.schema !== INTELLIGENCE_VERIFICATION_SCHEMA) throw new ValidationError('Unsupported intelligence verification report');
    const copy = cloneJson(report); const digest = copy.digest; delete copy.digest;
    if (digest !== sha256(copy)) throw new IntegrityError('Intelligence verification digest mismatch');
    return { ok: true, verification_id: report.verification_id, passed: report.passed };
  }
}
