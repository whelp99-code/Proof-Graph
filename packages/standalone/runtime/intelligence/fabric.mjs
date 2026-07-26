import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { IntegrityError, ValidationError } from '../core/errors.mjs';
import { ContextRuntime } from './context-runtime.mjs';
import { ModelRouter } from './model-router.mjs';
import { CollaborationRuntime } from './collaboration-runtime.mjs';
import { KnowledgeGraphRuntime } from './knowledge-graph.mjs';
import { OrganizationMemoryRuntime } from './memory-runtime.mjs';
import { IntelligenceVerificationRuntime } from './verification-runtime.mjs';
import { INTELLIGENCE_SCHEMA_VERSION } from './domain.mjs';

function boundedAppend(list, items, max) {
  const merged = [...list, ...items];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

function enrichImpacts(items, { action_required = false, source_work_item_id = null, source_phase = 'context' } = {}) {
  return items.map((raw) => {
    const impact = cloneJson(raw);
    delete impact.digest;
    impact.action_required = Boolean(action_required);
    impact.source_work_item_id = source_work_item_id;
    impact.source_phase = source_phase;
    impact.digest = sha256(impact);
    return deepFreeze(impact);
  });
}

function boundedUpsert(list, items, max, key = 'impact_id') {
  const byId = new Map(list.map((item) => [item[key], item]));
  for (const item of items) {
    const previous = byId.get(item[key]);
    if (!previous || item.action_required === true || previous.action_required !== true) byId.set(item[key], item);
  }
  const merged = [...byId.values()];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

function roleMap(mission, futureOnly = false) {
  const futureRoleIds = futureOnly ? new Set(mission.work_items.filter((item) => ['pending', 'ready', 'running', 'waiting_approval'].includes(item.status)).map((item) => item.assigned_role_id)) : null;
  const find = (predicate) => mission.organization.roles.find((role) => predicate(role) && (!futureRoleIds || futureRoleIds.has(role.role_id)))?.role_id ?? null;
  return {
    verifier: find((role) => role.role_type === 'verifier' || role.independence_group === 'quality'),
    risk: find((role) => role.independence_group === 'risk'),
    developer: find((role) => /developer|engineering/i.test(`${role.role_type} ${role.name}`)),
    planner: find((role) => /planner|planning/i.test(`${role.role_type} ${role.name}`)),
  };
}

function activeContract(contract) { return !['completed', 'rejected', 'blocked', 'cancelled'].includes(contract.status); }
function reportRef(report) { return { type: 'report', id: report.run_id, digest: report.integrity?.report_digest ?? sha256(report) }; }

function outputRefs(report) {
  const refs = [reportRef(report)];
  for (const item of report.output?.deliverables ?? []) {
    if (item && typeof item === 'object') refs.push({ type: 'deliverable', id: String(item.name ?? item.id ?? deterministicId('deliverable', item)), digest: sha256(item) });
  }
  return refs.slice(0, 128);
}

function externalIdsFromReport(report, workItem) {
  const ids = [];
  const add = (values) => {
    for (const value of Array.isArray(values) ? values : []) {
      if (typeof value === 'string') ids.push(value);
      else if (value && typeof value === 'object') ids.push(value.id ?? value.path ?? value.name);
    }
  };
  add(report.output?.changed_files ?? report.output?.files); add(report.output?.apis); add(report.output?.services); add(report.output?.tests);
  return [...new Set(ids.filter((item) => typeof item === 'string'))].slice(0, 100);
}

export class IntelligenceFabric {
  constructor({ dataDir, modelRegistry, contextPolicies, limits = {} } = {}) {
    if (!dataDir) throw new ValidationError('IntelligenceFabric dataDir is required');
    this.context = new ContextRuntime({ policies: contextPolicies ?? {}, maxSources: limits.max_context_sources ?? 256 });
    this.router = new ModelRouter({ registry: modelRegistry });
    this.collaboration = new CollaborationRuntime();
    this.knowledge = new KnowledgeGraphRuntime({ maxNodes: limits.max_knowledge_nodes ?? 5000, maxEdges: limits.max_knowledge_edges ?? 15000, maxDepth: limits.max_impact_depth ?? 5, maxImpactResults: limits.max_impact_results ?? 500 });
    this.memory = new OrganizationMemoryRuntime({ dataDir, maxEntries: limits.max_memory_entries ?? 20_000 });
    this.verification = new IntelligenceVerificationRuntime({ contextRuntime: this.context, modelRouter: this.router, collaborationRuntime: this.collaboration, knowledgeGraphRuntime: this.knowledge, memoryRuntime: this.memory });
    this.limits = { contexts: 1000, routes: 1000, observations: 5000, contracts: 5000, handoffs: 5000, impacts: 5000, recalls: 2000, verifications: 2000, ...limits };
  }

  initialize(mission) {
    let graph = this.knowledge.create({ mission_id: mission.mission_id });
    graph = this.knowledge.ingestMission(graph, mission);
    const state = {
      schema_version: INTELLIGENCE_SCHEMA_VERSION,
      fabric_version: '5.0.0',
      model_registry_version: this.router.registry.registry_version,
      model_registry_digest: this.router.registry.digest,
      context_packets: [], route_decisions: [], model_observations: [], contracts: [], handoffs: [], impacts: [], memory_recalled: [], memory_captured: [], verifications: [],
      knowledge_graph: graph,
      current_by_work_item: {},
      stats: { context_bytes: 0, context_redactions: 0, stale_context_sources: 0, unknown_freshness_sources: 0, route_count: 0, model_observation_count: 0, model_successes: 0, model_failures: 0, model_latency_total_ms: 0, contract_count: 0, impact_count: 0, memory_recall_count: 0 },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    state.digest = sha256(state);
    return deepFreeze(state);
  }

  verifyState(intelligence) {
    if (!intelligence || intelligence.schema_version !== INTELLIGENCE_SCHEMA_VERSION) throw new ValidationError('Unsupported Intelligence Fabric state');
    const copy = cloneJson(intelligence); const digest = copy.digest; delete copy.digest;
    if (digest !== sha256(copy)) throw new IntegrityError('Intelligence Fabric state digest mismatch');
    this.knowledge.verify(intelligence.knowledge_graph);
    for (const packet of intelligence.context_packets) this.context.verify(packet);
    for (const route of intelligence.route_decisions) this.router.verify(route);
    for (const observation of intelligence.model_observations ?? []) this.router.verifyObservation(observation);
    for (const contract of intelligence.contracts) this.collaboration.verify(contract);
    for (const verification of intelligence.verifications) this.verification.verifyReport(verification);
    return { ok: true, digest, contexts: intelligence.context_packets.length, routes: intelligence.route_decisions.length, observations: intelligence.model_observations?.length ?? 0, contracts: intelligence.contracts.length };
  }

  seal(intelligence) {
    const next = cloneJson(intelligence); next.updated_at = new Date().toISOString(); delete next.digest; next.digest = sha256(next); return deepFreeze(next);
  }

  async prepareExecution({ state, workItem, options = {} }) {
    const intelligence = cloneJson(state.intelligence ?? this.initialize(state.mission));
    if (intelligence.model_registry_digest !== this.router.registry.digest) throw new IntegrityError('Configured model registry does not match persisted mission registry');
    const dependencies = state.mission.work_items.filter((item) => workItem.dependencies.includes(item.work_item_id));
    const existingByIdem = new Map(intelligence.contracts.map((item) => [item.idempotency_key, item]));
    const generated = this.collaboration.dependencyContracts({ mission: state.mission, workItem, dependencies });
    for (const contract of generated) if (!existingByIdem.has(contract.idempotency_key)) { intelligence.contracts.push(cloneJson(contract)); existingByIdem.set(contract.idempotency_key, contract); }
    const relevantContracts = [];
    intelligence.contracts = intelligence.contracts.map((raw) => {
      if (!activeContract(raw) || !raw.consumer_role_ids.includes(workItem.assigned_role_id)) return raw;
      let contract = raw;
      if (!contract.acknowledgements.some((item) => item.actor_role_id === workItem.assigned_role_id)) contract = this.collaboration.transition(contract, { action: 'acknowledge', actor_role_id: workItem.assigned_role_id });
      relevantContracts.push(contract);
      return cloneJson(contract);
    });
    const sourceIds = [...workItem.dependencies, workItem.work_item_id];
    const impacts = sourceIds.length ? enrichImpacts(this.knowledge.impact(intelligence.knowledge_graph, { source_ids: sourceIds, max_depth: options.max_impact_depth ?? 2 }), { action_required: false, source_work_item_id: workItem.work_item_id, source_phase: 'context' }) : [];
    const knowledgeNodeIds = impacts.map((item) => item.target_id);
    const memory = await this.memory.retrieve({ query: `${state.mission.objective} ${workItem.objective}`, role_id: workItem.assigned_role_id, mission_id: state.mission.mission_id, task_id: state.mission.task.task_id, knowledge_node_ids: knowledgeNodeIds, tags: [...new Set([workItem.kind, state.mission.task.archetype].filter(Boolean))], classification: options.classification ?? state.mission.task.metadata?.data_classification ?? 'internal', limit: options.memory_limit ?? 12 });
    const contextPacket = this.context.compile({ mission: state.mission, workItem, dependencies, artifacts: state.artifacts, contracts: relevantContracts, impacts, memory, classification: options.classification ?? state.mission.task.metadata?.data_classification ?? 'internal', policy: options.context_policy ?? {} });
    const routeDecision = this.router.route({
      mission_id: state.mission.mission_id, work_item_id: workItem.work_item_id, kind: workItem.kind, risk: state.mission.task.risk,
      classification: contextPacket.classification, context_tokens: contextPacket.token_estimate,
      expected_output_tokens: options.expected_output_tokens ?? (workItem.kind === 'develop' ? 12_000 : workItem.kind === 'verify' ? 8_000 : 5_000),
      verification_strength: state.mission.task.verification_strength,
      required_capabilities: options.required_model_capabilities ?? [],
      max_cost_micros: options.max_cost_micros ?? null,
      preferred_hosts: options.preferred_hosts ?? [], allowed_hosts: options.allowed_hosts ?? [], allowed_models: options.allowed_models ?? [],
    });
    const handoffs = relevantContracts.map((contract) => this.collaboration.handoff(contract, { context_packet_id: contextPacket.packet_id, route_id: routeDecision.route_id, producer_output_refs: contract.input_refs }));
    const bundle = {
      schema_version: 1, bundle_id: deterministicId('bundle', { context: contextPacket.digest, route: routeDecision.digest, contracts: relevantContracts.map((item) => item.digest) }),
      mission_id: state.mission.mission_id, work_item_id: workItem.work_item_id, context_packet: contextPacket, route_decision: routeDecision,
      contracts: relevantContracts, handoffs, impacts, memory_refs: memory.map((item) => ({ memory_id: item.memory_id, digest: item.digest })),
    };
    bundle.digest = sha256(bundle);
    const verification = this.verification.verifyExecutionBundle(bundle);
    if (!verification.passed) throw new IntegrityError('Execution intelligence bundle failed verification', verification);
    intelligence.context_packets = boundedAppend(intelligence.context_packets, [cloneJson(contextPacket)], this.limits.contexts);
    intelligence.route_decisions = boundedAppend(intelligence.route_decisions, [cloneJson(routeDecision)], this.limits.routes);
    intelligence.handoffs = boundedAppend(intelligence.handoffs, handoffs.map(cloneJson), this.limits.handoffs);
    intelligence.impacts = boundedUpsert(intelligence.impacts, impacts.map(cloneJson), this.limits.impacts);
    intelligence.memory_recalled = boundedAppend(intelligence.memory_recalled, memory.map(cloneJson), this.limits.recalls);
    intelligence.verifications = boundedAppend(intelligence.verifications, [cloneJson(verification)], this.limits.verifications);
    intelligence.current_by_work_item[workItem.work_item_id] = { bundle_id: bundle.bundle_id, context_packet_id: contextPacket.packet_id, route_id: routeDecision.route_id, contract_ids: relevantContracts.map((item) => item.contract_id), handoff_ids: handoffs.map((item) => item.handoff_id), prepared_at: new Date().toISOString() };
    intelligence.stats.context_bytes += contextPacket.byte_size; intelligence.stats.context_redactions += contextPacket.redactions.length; intelligence.stats.stale_context_sources += contextPacket.stale_source_count ?? 0; intelligence.stats.unknown_freshness_sources += contextPacket.unknown_freshness_source_count ?? 0; intelligence.stats.route_count += 1; intelligence.stats.contract_count = intelligence.contracts.length; intelligence.stats.impact_count = intelligence.impacts.length; intelligence.stats.memory_recall_count += memory.length;
    return { intelligence: this.seal(intelligence), bundle: deepFreeze(bundle) };
  }

  processReport({ state, workItem, report }) {
    const intelligence = cloneJson(state.intelligence ?? this.initialize(state.mission));
    const current = intelligence.current_by_work_item?.[workItem.work_item_id] ?? null;
    const routeDecision = current ? intelligence.route_decisions.find((item) => item.route_id === current.route_id) ?? null : null;
    const observation = routeDecision ? this.router.observe({ routeDecision, report, attempt: workItem.attempts }) : null;
    if (observation) {
      intelligence.model_observations = boundedAppend(intelligence.model_observations ?? [], [cloneJson(observation)], this.limits.observations);
      intelligence.stats.model_observation_count = (intelligence.stats.model_observation_count ?? 0) + 1;
      intelligence.stats.model_successes = (intelligence.stats.model_successes ?? 0) + (observation.success ? 1 : 0);
      intelligence.stats.model_failures = (intelligence.stats.model_failures ?? 0) + (observation.success ? 0 : 1);
      intelligence.stats.model_latency_total_ms = (intelligence.stats.model_latency_total_ms ?? 0) + observation.latency_ms;
    }
    intelligence.knowledge_graph = this.knowledge.ingestReport(intelligence.knowledge_graph, { mission: state.mission, workItem, report, artifacts: [] });
    const evidence = [reportRef(report)];
    const outputs = outputRefs(report);
    intelligence.contracts = intelligence.contracts.map((raw) => {
      if (!activeContract(raw) || !raw.consumer_role_ids.includes(workItem.assigned_role_id)) return raw;
      try {
        return cloneJson(report.status === 'success'
          ? this.collaboration.transition(raw, { action: 'complete', actor_role_id: workItem.assigned_role_id, evidence_refs: evidence, output_refs: outputs })
          : this.collaboration.transition(raw, { action: 'block', actor_role_id: workItem.assigned_role_id, reason: report.failure?.message ?? 'consumer execution failed' }));
      } catch (error) {
        return cloneJson(this.collaboration.transition(raw, { action: 'block', actor_role_id: workItem.assigned_role_id, reason: `contract transition failed: ${error.message}` }));
      }
    });
    const impactSources = externalIdsFromReport(report, workItem);
    const impacts = impactSources.length ? enrichImpacts(this.knowledge.impact(intelligence.knowledge_graph, { source_ids: impactSources, max_depth: 2 }), { action_required: true, source_work_item_id: workItem.work_item_id, source_phase: 'report' }) : [];
    intelligence.impacts = boundedUpsert(intelligence.impacts, impacts.map(cloneJson), this.limits.impacts);
    const futureRoles = roleMap(state.mission, true);
    const followUps = this.collaboration.impactFollowUps({ mission_id: state.mission.mission_id, producer_role_id: workItem.assigned_role_id, work_item_id: workItem.work_item_id, impacts, roleMap: futureRoles });
    const existingByIdem = new Set(intelligence.contracts.map((item) => item.idempotency_key));
    for (const contract of followUps) if (!existingByIdem.has(contract.idempotency_key)) { intelligence.contracts.push(cloneJson(contract)); existingByIdem.add(contract.idempotency_key); }
    const memoryInputs = [];
    if (report.status === 'success') {
      const base = { mission_id: state.mission.mission_id, project_id: state.mission.projects?.[0]?.project_id ?? null, task_id: state.mission.task.task_id, role_id: workItem.assigned_role_id, tags: [...new Set([workItem.kind, state.mission.task.archetype].filter(Boolean))], knowledge_node_ids: impacts.map((item) => item.target_id), source_refs: evidence, metadata: { work_item_id: workItem.work_item_id, stage_id: workItem.stage_id, role_type: state.mission.organization.roles.find((role) => role.role_id === workItem.assigned_role_id)?.role_type ?? null } };
      if (workItem.kind === 'verify' && report.verification?.passed === true && report.verification?.independent === true) {
        memoryInputs.push({ ...base, kind: 'verification', title: `Verified result for ${state.mission.objective.slice(0, 120)}`, content: { summary: report.output?.summary ?? 'Independent verification passed', evidence: report.verification.evidence ?? [], run_id: report.run_id }, status: 'verified', confidence: 1, verified_by: workItem.assigned_role_id });
        for (const candidate of state.artifact_candidates ?? []) memoryInputs.push({ ...base, kind: 'artifact', title: `Verified artifact ${candidate.name}`, content: { artifact_id: candidate.artifact_id, name: candidate.name, media_type: candidate.media_type, digest: candidate.digest, content: candidate.content }, status: 'verified', confidence: 1, verified_by: workItem.assigned_role_id, source_refs: [...evidence, { type: 'artifact', id: candidate.artifact_id, digest: candidate.digest }] });
        for (const failure of (state.failures ?? []).filter((item) => (item.status ?? 'unresolved') !== 'resolved')) memoryInputs.push({ ...base, kind: 'lesson', title: `Resolved failure lesson: ${failure.type}`, content: { failure, resolution: report.output?.summary ?? 'independent verification passed after rework' }, status: 'verified', confidence: 0.9, verified_by: workItem.assigned_role_id });
      } else {
        memoryInputs.push({ ...base, kind: workItem.kind === 'plan' ? 'decision' : workItem.kind === 'research' ? 'artifact' : 'artifact', title: `${workItem.stage_id} result for ${state.mission.objective.slice(0, 100)}`, content: { summary: report.output?.summary ?? `${workItem.kind} completed`, output: report.output, run_id: report.run_id }, status: 'proposed', confidence: 0.6 });
      }
    }
    intelligence.stats.contract_count = intelligence.contracts.length; intelligence.stats.impact_count = intelligence.impacts.length;
    return { intelligence: this.seal(intelligence), memory_inputs: memoryInputs, model_observation: observation };
  }

  async persistMemories(memoryInputs) {
    const refs = [];
    for (const input of memoryInputs.slice(0, 100)) {
      const entry = await this.memory.remember(input, { actor: input.verified_by ?? input.role_id ?? 'memory-runtime', eventType: input.status === 'verified' ? 'memory.verified_capture' : 'memory.proposed' });
      refs.push({ memory_id: entry.memory_id, status: entry.status, digest: entry.digest });
    }
    return refs;
  }

  async terminalGate(state) {
    const verification = await this.verification.verifyTerminal({ state });
    const intelligence = cloneJson(state.intelligence ?? this.initialize(state.mission));
    intelligence.verifications = boundedAppend(intelligence.verifications, [cloneJson(verification)], this.limits.verifications);
    return { intelligence: this.seal(intelligence), verification };
  }

  async verifyIntegrity(state) {
    const fabric = this.verifyState(state.intelligence);
    const memory = await this.memory.verifyIntegrity();
    return { ok: true, fabric, memory };
  }
}
