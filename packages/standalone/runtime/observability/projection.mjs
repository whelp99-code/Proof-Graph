import { cloneJson, sha256 } from '../core/canonical.mjs';
import { classifyFailures, displayRunStatus, failureIdentity, nodeDisplayStatus, OBSERVABILITY_SCHEMA_VERSION } from './contracts.mjs';


function publicApproval(item) {
  const copy = cloneJson(item);
  delete copy.challenge;
  return copy;
}

function progress(workItems) {
  const total = workItems.length || 1;
  const completed = workItems.filter((item) => ['completed', 'skipped'].includes(item.status)).length;
  const terminal = workItems.filter((item) => ['completed', 'failed', 'blocked', 'skipped', 'cancelled'].includes(item.status)).length;
  return { completed, terminal, total, percent: Math.round((completed / total) * 100) };
}

function nextNodeIds(state, items) {
  const completed = new Set(items.filter((item) => item.status === 'completed').map((item) => item.work_item_id));
  return items.filter((item) => {
    if (item.status !== 'pending') return false;
    if (!item.dependencies?.length) return true;
    return item.join === 'all'
      ? item.dependencies.every((id) => completed.has(id))
      : item.dependencies.some((id) => completed.has(id));
  }).map((item) => item.work_item_id);
}

function loopsFromRoutes(state) {
  const routes = state.route_history ?? [];
  const grouped = new Map();
  for (const route of routes) {
    const loopId = route.loop_id ?? `loop:${route.from}->${route.to}:${route.failure_type ?? 'unknown'}`;
    const current = grouped.get(loopId) ?? {
      loop_id: loopId,
      source_node: route.from,
      target_node: route.to,
      failure_type: route.failure_type ?? 'unknown_failure',
      iteration: 0,
      max_iterations: route.max_iterations ?? null,
      entered_at: route.at ?? null,
      last_at: route.at ?? null,
      status: 'active',
      exit_reason: null,
    };
    current.iteration = Math.max(current.iteration, route.iteration ?? current.iteration + 1);
    current.max_iterations = route.max_iterations ?? current.max_iterations;
    current.last_at = route.at ?? current.last_at;
    current.status = route.status ?? current.status;
    current.exit_reason = route.exit_reason ?? current.exit_reason;
    grouped.set(loopId, current);
  }
  return [...grouped.values()].sort((a, b) => String(a.entered_at).localeCompare(String(b.entered_at)));
}

function graphProjection(state) {
  const workItems = state.mission?.work_items ?? [];
  const nodes = workItems.map((item) => ({
    id: item.work_item_id,
    stage_id: item.stage_id,
    kind: item.kind,
    label: item.stage_id,
    role_id: item.assigned_role_id,
    status: nodeDisplayStatus(item, state),
    attempts: item.attempts ?? 0,
    max_attempts: item.max_attempts ?? 1,
    failure: item.failure ? cloneJson(item.failure) : null,
    approval_required: item.approval_required === true,
    progress: item.progress ?? null,
    sequence: item.sequence ?? 0,
  }));
  const edges = [];
  for (const item of workItems) {
    for (const dependency of item.dependencies ?? []) {
      edges.push({ id: `dep:${dependency}->${item.work_item_id}`, from: dependency, to: item.work_item_id, kind: 'dependency', active: false });
    }
  }
  for (const route of state.route_history ?? []) {
    edges.push({
      id: route.route_id ?? `route:${route.from}->${route.to}:${route.iteration ?? 1}`,
      from: route.from,
      to: route.to,
      kind: 'retry',
      failure_type: route.failure_type,
      iteration: route.iteration ?? 1,
      max_iterations: route.max_iterations ?? null,
      active: route.status !== 'exited',
    });
  }
  const activeNodeIds = nodes.filter((node) => ['running', 'paused', 'waiting_approval', 'failed'].includes(node.status)).map((node) => node.id);
  return { nodes, edges, active_node_ids: activeNodeIds, next_node_ids: nextNodeIds(state, workItems) };
}

function organizationProjection(state) {
  const organization = state.mission?.organization ?? {};
  return {
    organization_id: organization.organization_id ?? null,
    departments: cloneJson(organization.departments ?? []),
    teams: cloneJson(organization.teams ?? []),
    roles: cloneJson(organization.roles ?? []),
  };
}


function intelligenceProjection(state) {
  const intelligence = state.intelligence;
  if (!intelligence) return null;
  const contextSummary = (packet) => ({
    packet_id: packet.packet_id,
    work_item_id: packet.work_item_id,
    role_id: packet.role_id,
    role_type: packet.role_type,
    classification: packet.classification,
    byte_size: packet.byte_size,
    token_estimate: packet.token_estimate,
    source_count: packet.sources?.length ?? 0,
    stale_source_count: packet.stale_source_count ?? 0,
    unknown_freshness_source_count: packet.unknown_freshness_source_count ?? 0,
    redaction_count: packet.redactions?.length ?? 0,
    dropped_sections: cloneJson(packet.dropped_sections ?? []),
    sections: Object.keys(packet.sections ?? {}),
    digest: packet.digest,
  });
  const routeSummary = (route) => ({
    route_id: route.route_id,
    work_item_id: route.work_item_id,
    model_id: route.model_id,
    provider: route.provider,
    host: route.host,
    score: route.score,
    estimated_cost_micros: route.estimated_cost_micros,
    fallback_chain: cloneJson(route.fallback_chain ?? []),
    reasons: cloneJson(route.reasons ?? []),
    digest: route.digest,
  });
  const observationSummary = (observation) => ({
    observation_id: observation.observation_id,
    route_id: observation.route_id,
    work_item_id: observation.work_item_id,
    model_id: observation.model_id,
    provider: observation.provider,
    host: observation.host,
    attempt: observation.attempt,
    status: observation.status,
    success: observation.success === true,
    failure_type: observation.failure_type ?? null,
    calls: observation.calls ?? 0,
    tokens: observation.tokens ?? 0,
    cost_micros: observation.cost_micros ?? 0,
    latency_ms: observation.latency_ms ?? 0,
    observed_at: observation.observed_at,
    digest: observation.digest,
  });
  const contractSummary = (contract) => ({
    contract_id: contract.contract_id,
    work_item_id: contract.work_item_id,
    type: contract.type,
    status: contract.status,
    subject: contract.subject,
    producer_role_id: contract.producer_role_id,
    consumer_role_ids: cloneJson(contract.consumer_role_ids ?? []),
    acknowledgement_count: contract.acknowledgements?.length ?? 0,
    evidence_count: contract.evidence_refs?.length ?? 0,
    output_count: contract.output_refs?.length ?? 0,
    digest: contract.digest,
  });
  const handoffSummary = (handoff) => ({
    handoff_id: handoff.handoff_id,
    contract_id: handoff.contract_id,
    context_packet_id: handoff.context_packet_id,
    route_id: handoff.route_id,
    producer_role_id: handoff.producer_role_id,
    consumer_role_ids: cloneJson(handoff.consumer_role_ids ?? []),
    digest: handoff.digest,
  });
  const memorySummary = (entry) => ({
    memory_id: entry.memory_id,
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    confidence: entry.confidence,
    retrieval_score: entry.retrieval_score ?? null,
    sensitivity: entry.sensitivity,
    verified_by: entry.verified_by ?? null,
    valid_at: entry.valid_at,
    digest: entry.digest,
  });
  const verificationSummary = (verification) => ({
    verification_id: verification.verification_id,
    scope: verification.scope,
    work_item_id: verification.work_item_id ?? null,
    passed: verification.passed === true,
    blocking_failures: cloneJson(verification.blocking_failures ?? []),
    check_count: verification.checks?.length ?? 0,
    verified_at: verification.verified_at,
    digest: verification.digest,
  });
  const contexts = (intelligence.context_packets ?? []).map(contextSummary);
  const routes = (intelligence.route_decisions ?? []).map(routeSummary);
  const observations = (intelligence.model_observations ?? []).map(observationSummary);
  const latestContextByWork = new Map(contexts.map((item) => [item.work_item_id, item]));
  const latestRouteByWork = new Map(routes.map((item) => [item.work_item_id, item]));
  const latestObservationByWork = new Map(observations.map((item) => [item.work_item_id, item]));
  const observationByModel = new Map();
  for (const observation of observations) {
    const current = observationByModel.get(observation.model_id) ?? { model_id: observation.model_id, provider: observation.provider, host: observation.host, observations: 0, successes: 0, failures: 0, latency_total_ms: 0, tokens: 0, cost_micros: 0, last_observed_at: null, failure_types: {} };
    current.observations += 1; current.successes += observation.success ? 1 : 0; current.failures += observation.success ? 0 : 1; current.latency_total_ms += observation.latency_ms; current.tokens += observation.tokens; current.cost_micros += observation.cost_micros;
    if (!current.last_observed_at || observation.observed_at > current.last_observed_at) current.last_observed_at = observation.observed_at;
    if (observation.failure_type) current.failure_types[observation.failure_type] = (current.failure_types[observation.failure_type] ?? 0) + 1;
    observationByModel.set(observation.model_id, current);
  }
  const modelObservationSummary = [...observationByModel.values()].map((item) => ({ ...item, success_rate: item.observations ? Number((item.successes / item.observations).toFixed(6)) : null, average_latency_ms: item.observations ? Math.round(item.latency_total_ms / item.observations) : 0 })).sort((a, b) => a.model_id.localeCompare(b.model_id));
  const contracts = (intelligence.contracts ?? []).map(contractSummary);
  const handoffs = (intelligence.handoffs ?? []).map(handoffSummary);
  const graphNodes = (intelligence.knowledge_graph?.nodes ?? []).slice(0, 500).map((node) => ({
    node_id: node.node_id, external_id: node.external_id, kind: node.kind, label: node.label, criticality: node.criticality,
  }));
  const graphEdges = (intelligence.knowledge_graph?.edges ?? []).slice(0, 1000).map((edge) => ({
    edge_id: edge.edge_id, from: edge.from, to: edge.to, kind: edge.kind, severity: edge.severity,
  }));
  const impacts = (intelligence.impacts ?? []).slice(-500).map((impact) => ({
    impact_id: impact.impact_id, source_id: impact.source_id, target_id: impact.target_id,
    target_external_id: impact.target_external_id, target_kind: impact.target_kind, severity: impact.severity,
    depth: impact.depth, action_required: impact.action_required === true, source_work_item_id: impact.source_work_item_id,
    digest: impact.digest,
  }));
  return {
    fabric_version: intelligence.fabric_version,
    model_registry_version: intelligence.model_registry_version,
    model_registry_digest: intelligence.model_registry_digest,
    contexts: {
      total: contexts.length,
      bytes: intelligence.stats?.context_bytes ?? 0,
      redactions: intelligence.stats?.context_redactions ?? 0,
      stale_sources: intelligence.stats?.stale_context_sources ?? 0,
      unknown_freshness_sources: intelligence.stats?.unknown_freshness_sources ?? 0,
      latest_by_work_item: Object.fromEntries(latestContextByWork),
      packets: contexts.slice(-500),
    },
    routing: {
      total: routes.length,
      latest_by_work_item: Object.fromEntries(latestRouteByWork),
      decisions: routes.slice(-500),
      observation_total: observations.length,
      latest_observation_by_work_item: Object.fromEntries(latestObservationByWork),
      observations: observations.slice(-1000),
      model_summary: modelObservationSummary,
    },
    collaboration: {
      contracts: contracts.slice(-1000),
      handoffs: handoffs.slice(-1000),
      pending: contracts.filter((item) => ['proposed', 'acknowledged'].includes(item.status)).length,
      blocked: contracts.filter((item) => ['blocked', 'rejected'].includes(item.status)).length,
      completed: contracts.filter((item) => item.status === 'completed').length,
    },
    knowledge: {
      graph_id: intelligence.knowledge_graph?.graph_id ?? null,
      revision: intelligence.knowledge_graph?.revision ?? 0,
      node_count: intelligence.knowledge_graph?.nodes?.length ?? 0,
      edge_count: intelligence.knowledge_graph?.edges?.length ?? 0,
      nodes: graphNodes,
      edges: graphEdges,
      impacts,
      actionable_impacts: impacts.filter((item) => item.action_required).length,
      digest: intelligence.knowledge_graph?.digest ?? null,
    },
    memory: {
      recalled: (intelligence.memory_recalled ?? []).slice(-500).map(memorySummary),
      captured: (intelligence.memory_captured ?? []).slice(-500).map((item) => cloneJson(item)),
    },
    verification: (intelligence.verifications ?? []).slice(-500).map(verificationSummary),
    stats: cloneJson(intelligence.stats ?? {}),
    digest: intelligence.digest,
  };
}

export function missionProjection(state, { host = null, timeline = [] } = {}) {
  const failures = classifyFailures(state);
  const graph = graphProjection(state);
  const displayStatus = displayRunStatus(state);
  const pendingApprovals = (state.approvals ?? []).filter((item) => item.status === 'pending');
  const currentNodes = graph.nodes.filter((node) => graph.active_node_ids.includes(node.id));
  const loops = loopsFromRoutes(state);
  const projection = {
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    projection_version: Number(state.revision ?? 0),
    run_id: state.mission?.mission_id ?? null,
    run_type: 'mission',
    objective: state.mission?.objective ?? '',
    raw_status: state.status,
    status: displayStatus,
    quality_gate_passed: state.quality_gate_passed === true,
    execution: cloneJson(state.execution ?? { mode: 'unknown', real_execution: false }),
    completed_with_recovery: displayStatus === 'completed_with_recovery',
    progress: progress(state.mission?.work_items ?? []),
    current_node_ids: currentNodes.map((node) => node.id),
    current_nodes: currentNodes,
    next_node_ids: graph.next_node_ids,
    graph,
    organization: organizationProjection(state),
    loops,
    loop_summary: {
      total: loops.length,
      active: loops.filter((item) => item.status === 'active').length,
      exhausted: loops.filter((item) => item.status === 'exhausted').length,
      current_iteration: Math.max(0, ...loops.map((item) => item.iteration ?? 0)),
    },
    failures: {
      historical: failures.historical,
      resolved: failures.resolved,
      unresolved: failures.unresolved,
    },
    approvals: {
      pending: pendingApprovals.map(publicApproval),
      decided: (state.approvals ?? []).filter((item) => item.status !== 'pending').map(publicApproval),
    },
    artifacts: {
      candidates: cloneJson(state.artifact_candidates ?? []),
      verified: cloneJson(state.artifacts ?? []),
    },
    intelligence: intelligenceProjection(state),
    usage: cloneJson(state.usage ?? {}),
    host: cloneJson(host ?? state.host ?? { name: 'reference', status: 'unknown' }),
    operator: cloneJson(state.operator ?? { paused: false }),
    timeline: cloneJson(timeline),
    integrity: cloneJson(state.integrity ?? null),
    updated_at: state.updated_at ?? null,
  };
  projection.digest = sha256(projection);
  return projection;
}

export function osProjection(state, missionProjections = []) {
  const status = state.status === 'completed' ? 'completed_clean'
    : state.status === 'failed' && (state.approvals ?? []).some((item) => item.status === 'denied') ? 'denied'
      : state.status;
  const cycles = missionProjections.map((mission, index) => ({
    cycle: index + 1,
    mission_id: mission.run_id,
    status: mission.status,
    quality_gate_passed: mission.quality_gate_passed,
    failures: mission.failures.unresolved.length,
  }));
  const projection = {
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    projection_version: Number(state.revision ?? 0),
    run_id: state.os_run_id,
    run_type: 'organization_os',
    objective: state.objective,
    raw_status: state.status,
    status,
    quality_gate_passed: state.quality_gate_passed === true,
    cycle: state.cycle,
    max_cycles: state.max_cycles,
    cycles,
    current_mission_id: state.current_mission_id,
    council_records: cloneJson(state.council_records ?? []),
    improvement_proposals: cloneJson(state.improvement_proposals ?? []),
    approvals: {
      pending: (state.approvals ?? []).filter((item) => item.status === 'pending').map(publicApproval),
      decided: (state.approvals ?? []).filter((item) => item.status !== 'pending').map(publicApproval),
    },
    failures: cloneJson(state.failures ?? []),
    updated_at: state.updated_at ?? null,
    integrity: cloneJson(state.integrity ?? null),
  };
  projection.digest = sha256(projection);
  return projection;
}

export { failureIdentity, intelligenceProjection };
