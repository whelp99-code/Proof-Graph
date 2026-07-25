import { canonicalJson, nowIso, randomId, sha256 } from './canonical.mjs';
import { PRODUCT_NAME, VERSION } from '../../runtime/version.mjs';
import { compileDynamicGraph } from './graph-compiler.mjs';
import { GRAPH_FAILURE_TYPES, validateGraphSpec } from './graph-spec.mjs';
import { BudgetError, SecurityError, StateError, ValidationError } from './errors.mjs';
import {
  clearActiveRun,
  createRun,
  projectKey,
  readActiveRun,
  readReport,
  readRun,
  readVerifiedRun,
  resolveDataDir,
  resolveProjectDir,
  setActiveRun,
  verifyEventChain,
  withRunTransaction,
  writeReportArtifacts,
} from './store.mjs';
import {
  arrayValue,
  assertFiniteJson,
  booleanValue,
  enumValue,
  identifier,
  integerValue,
  rejectUnknownKeys,
  runId as validateRunId,
  stringValue,
} from './validate.mjs';

const OUTCOMES = ['success', 'failed', 'blocked'];
const ACTIVE = new Set(['active', 'waiting_approval']);
const TERMINAL = new Set(['finalized', 'aborted']);

export const DEFAULT_GRAPH_RUNTIME_POLICY = Object.freeze({
  max_tool_calls: 180,
  max_source_fetches: 0,
  max_agents: 16,
  max_wall_time_seconds: 3600,
  max_output_bytes: 100_000,
  max_failure_bytes: 20_000,
});

function runtimePolicy(input = {}) {
  rejectUnknownKeys(input, Object.keys(DEFAULT_GRAPH_RUNTIME_POLICY), 'runtime_policy');
  return {
    max_tool_calls: input.max_tool_calls === undefined ? 180 : integerValue(input.max_tool_calls, 'runtime_policy.max_tool_calls', { min: 10, max: 2000 }),
    max_source_fetches: 0,
    max_agents: input.max_agents === undefined ? 16 : integerValue(input.max_agents, 'runtime_policy.max_agents', { min: 1, max: 64 }),
    max_wall_time_seconds: input.max_wall_time_seconds === undefined ? 3600 : integerValue(input.max_wall_time_seconds, 'runtime_policy.max_wall_time_seconds', { min: 60, max: 28800 }),
    max_output_bytes: input.max_output_bytes === undefined ? 100_000 : integerValue(input.max_output_bytes, 'runtime_policy.max_output_bytes', { min: 1000, max: 1_000_000 }),
    max_failure_bytes: input.max_failure_bytes === undefined ? 20_000 : integerValue(input.max_failure_bytes, 'runtime_policy.max_failure_bytes', { min: 1000, max: 100_000 }),
  };
}

function assertGraph(state) {
  if (state.run_kind !== 'graph') throw new StateError('Run is not a dynamic graph run');
}

function nodeState(node) {
  return {
    node_id: node.node_id,
    status: 'pending',
    attempts: 0,
    visits: 0,
    actor: null,
    activated_incoming: [],
    started_at: null,
    completed_at: null,
    output: null,
    output_sha256: null,
    failure: null,
    failure_sha256: null,
    approval_id: null,
    route_history: [],
  };
}

function outputValue(value, maxBytes, name = 'output') {
  const result = value === undefined ? {} : structuredClone(value);
  assertFiniteJson(result);
  const bytes = Buffer.byteLength(canonicalJson(result), 'utf8');
  if (bytes > maxBytes) throw new ValidationError(`${name} exceeds ${maxBytes} bytes`);
  return result;
}

function failureValue(input, maxBytes) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('failure is required for a failed outcome');
  rejectUnknownKeys(input, ['failure_type', 'severity', 'summary', 'evidence', 'expected', 'observed', 'recommended_route', 'retryable', 'signature'], 'failure');
  const result = {
    failure_type: enumValue(input.failure_type, 'failure.failure_type', GRAPH_FAILURE_TYPES),
    severity: input.severity === undefined ? 'medium' : enumValue(input.severity, 'failure.severity', ['low', 'medium', 'high', 'critical']),
    summary: stringValue(input.summary, 'failure.summary', { min: 5, max: 8000 }),
    evidence: input.evidence === undefined ? [] : arrayValue(input.evidence, 'failure.evidence', { max: 30 }).map((item, index) => stringValue(item, `failure.evidence[${index}]`, { min: 1, max: 4000 })),
    expected: input.expected === undefined ? null : stringValue(input.expected, 'failure.expected', { min: 1, max: 4000 }),
    observed: input.observed === undefined ? null : stringValue(input.observed, 'failure.observed', { min: 1, max: 4000 }),
    recommended_route: input.recommended_route === undefined ? null : enumValue(input.recommended_route, 'failure.recommended_route', ['research', 'plan', 'develop', 'verify', 'human', 'partial', 'failed']),
    retryable: input.retryable === undefined ? true : booleanValue(input.retryable, 'failure.retryable'),
    signature: input.signature === undefined ? sha256(`${input.failure_type}\n${input.summary}`).slice(0, 24) : stringValue(input.signature, 'failure.signature', { min: 8, max: 128 }),
  };
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > maxBytes) throw new ValidationError(`failure exceeds ${maxBytes} bytes`);
  return result;
}

function nodeById(state, nodeId) {
  return state.graph.nodes.find((node) => node.node_id === nodeId);
}

function outgoing(state, nodeId) {
  return state.graph.edges.filter((edge) => edge.from === nodeId).sort((a, b) => b.priority - a.priority || a.edge_id.localeCompare(b.edge_id));
}

function incoming(state, nodeId) {
  return state.graph.edges.filter((edge) => edge.to === nodeId);
}

function actorAllowed(actor, node) {
  if (actor === node.role) return true;
  if (node.role === 'direct' && actor === 'developer') return true;
  return node.kind === 'triage' || node.kind === 'terminal' ? actor === 'system' : false;
}

function conditionMatches(condition, context) {
  if (condition.type === 'always') return true;
  if (condition.type === 'outcome') return condition.value === context.outcome;
  if (condition.type === 'route') return condition.value === context.route;
  if (condition.type === 'failure_type') return condition.value === context.failure_type;
  if (condition.type === 'approval') return condition.value === context.approval;
  if (condition.type === 'verification') return condition.value === context.verification;
  return false;
}

function joinReady(state, node, runtime, triggeringFrom) {
  if (node.join === 'any') return runtime.activated_incoming.length > 0 || node.node_id === state.graph.entry_node;
  const configured = Array.isArray(node.metadata?.join_from) ? node.metadata.join_from : null;
  if (runtime.attempts > 0 && configured && triggeringFrom && !configured.includes(triggeringFrom)) return true;
  const sources = configured?.length ? configured : [...new Set(incoming(state, node.node_id).map((edge) => edge.from))];
  const activated = new Set(runtime.activated_incoming.map((edgeId) => state.graph.edges.find((edge) => edge.edge_id === edgeId)?.from).filter(Boolean));
  return sources.every((source) => activated.has(source));
}

function pendingApprovals(state) {
  return Object.values(state.approvals).filter((approval) => approval.status === 'pending').map((approval) => ({
    approval_id: approval.approval_id,
    node_id: approval.node_id,
    risk: approval.risk,
    reason: approval.reason,
    requested_at: approval.requested_at,
    challenge: approval.challenge,
    warning: 'The challenge binds the decision to this local run but does not cryptographically prove human identity.',
  }));
}

function readyNodes(state) {
  return state.graph.nodes.filter((node) => state.node_states[node.node_id]?.status === 'ready').map((node) => ({
    node_id: node.node_id,
    title: node.title,
    kind: node.kind,
    role: node.role,
    risk: node.risk,
    agent_type: node.agent_type,
    model_tier: node.model_tier,
    tool_policy: node.tool_policy,
    attempt: state.node_states[node.node_id].attempts + 1,
    max_attempts: node.max_attempts,
    metadata: node.metadata,
  }));
}

function requestApproval(state, node, emit) {
  const approvalId = randomId('approval');
  const challenge = randomId('confirm');
  state.approvals[approvalId] = {
    approval_id: approvalId,
    node_id: node.node_id,
    status: 'pending',
    risk: node.risk,
    reason: node.metadata?.reason ?? `Node ${node.node_id} requires human approval.`,
    requested_at: nowIso(),
    decided_at: null,
    decision: null,
    decided_by: null,
    decision_source: null,
    challenge,
    challenge_sha256: sha256(challenge),
  };
  const runtime = state.node_states[node.node_id];
  runtime.status = 'waiting_approval';
  runtime.approval_id = approvalId;
  state.status = 'waiting_approval';
  state.counters.approvals_requested += 1;
  emit('graph.approval_requested', 'system', { approval_id: approvalId, node_id: node.node_id, risk: node.risk, challenge_sha256: sha256(challenge) });
}

function activate(state, nodeId, edgeId, emit, triggeringFrom) {
  const node = nodeById(state, nodeId);
  const runtime = state.node_states[nodeId];
  if (!node || !runtime) throw new StateError(`Unknown activation target: ${nodeId}`);
  const wasTerminal = ['succeeded', 'failed', 'blocked', 'skipped'].includes(runtime.status);
  if (wasTerminal) {
    if (runtime.attempts >= node.max_attempts || runtime.visits >= state.graph.limits.max_route_visits) {
      emit('graph.retry_exhausted', 'system', { node_id: nodeId, attempts: runtime.attempts, visits: runtime.visits });
      const partial = state.graph.nodes.find((candidate) => candidate.kind === 'terminal' && candidate.terminal_status === 'partial')
        ?? state.graph.nodes.find((candidate) => candidate.kind === 'terminal' && candidate.terminal_status === 'failed');
      if (partial && partial.node_id !== nodeId) activate(state, partial.node_id, `synthetic-${nodeId}-${runtime.attempts}`, emit, nodeId);
      return;
    }
    Object.assign(runtime, nodeState(node), { attempts: runtime.attempts, visits: runtime.visits });
  }
  if (!runtime.activated_incoming.includes(edgeId)) runtime.activated_incoming.push(edgeId);
  if (!joinReady(state, node, runtime, triggeringFrom)) return;
  if (!['pending'].includes(runtime.status)) return;
  runtime.visits += 1;
  if (node.kind === 'human_approval' || node.approval_required) requestApproval(state, node, emit);
  else runtime.status = 'ready';
  emit('graph.node_ready', 'system', { node_id: nodeId, role: node.role, kind: node.kind, visit: runtime.visits, activated_by: edgeId });
}

function adaptiveFailure(state, node, failure, emit) {
  const signatureKey = `${node.node_id}:${failure.signature}`;
  state.failure_counts[signatureKey] = (state.failure_counts[signatureKey] ?? 0) + 1;
  const repeated = state.failure_counts[signatureKey];
  let effective = failure.failure_type;
  let reason = 'declared';
  if (failure.failure_type === 'security_risk' || failure.severity === 'critical') {
    effective = 'security_risk'; reason = 'risk_escalation';
  } else if (repeated >= 3) {
    effective = 'security_risk'; reason = 'third_repetition_escalation';
  } else if (repeated >= 2 && failure.failure_type === 'implementation_error') {
    effective = 'design_error'; reason = 'repeated_implementation_escalates_to_plan';
  }
  emit('graph.failure_classified', 'system', { node_id: node.node_id, declared: failure.failure_type, effective, repeated, reason });
  return effective;
}

function route(state, node, runtime, outcome, output, failure, emit) {
  const context = {
    outcome,
    route: output?.route ?? null,
    approval: output?.approval ?? null,
    verification: node.kind === 'verify' ? (output?.verification?.passed === true ? 'passed' : 'failed') : null,
    failure_type: failure ? adaptiveFailure(state, node, failure, emit) : null,
  };
  const matches = outgoing(state, node.node_id).filter((edge) => conditionMatches(edge.condition, context));
  const specific = matches.filter((edge) => edge.condition.type !== 'always');
  const candidates = specific.length ? specific : matches;
  if (!candidates.length) {
    const failed = state.graph.nodes.find((candidate) => candidate.kind === 'terminal' && candidate.terminal_status === 'failed');
    if (!failed) {
      state.status = 'failed';
      state.failure_reason = `No route matched ${node.node_id}`;
      return;
    }
    activate(state, failed.node_id, `synthetic-no-route-${node.node_id}`, emit, node.node_id);
    return;
  }
  const maxPriority = Math.max(...candidates.map((edge) => edge.priority));
  const selected = candidates.filter((edge) => edge.priority === maxPriority);
  if (selected.length > state.graph.limits.max_parallel_nodes) throw new BudgetError('Route fan-out exceeds max_parallel_nodes');
  for (const edge of selected) {
    const entry = { step: state.counters.graph_steps, from: node.node_id, to: edge.to, edge_id: edge.edge_id, condition: edge.condition, context, at: nowIso() };
    state.route_history.push(entry);
    runtime.route_history.push(entry);
    emit('graph.edge_activated', 'system', entry);
    activate(state, edge.to, edge.edge_id, emit, node.node_id);
  }
}

function buildReport(state, terminalNode) {
  const nodes = state.graph.nodes.map((node) => ({
    node_id: node.node_id,
    title: node.title,
    kind: node.kind,
    role: node.role,
    risk: node.risk,
    ...state.node_states[node.node_id],
  }));
  const activated = nodes.filter((node) => node.visits > 0 || node.status !== 'pending');
  const failures = Object.values(state.failures);
  const approvals = Object.values(state.approvals).map(({ challenge, ...approval }) => approval);
  const verifierPassed = activated.some((node) => node.kind === 'verify' && node.status === 'succeeded' && node.output?.verification?.passed === true);
  const quality = terminalNode.terminal_status === 'success'
    && verifierPassed
    && !activated.some((node) => ['failed', 'blocked'].includes(node.status))
    && !approvals.some((approval) => approval.status === 'pending');
  return {
    schema_version: 1,
    product: PRODUCT_NAME,
    version: VERSION,
    run_kind: 'graph',
    run_id: state.run_id,
    graph_id: state.graph.graph_id,
    graph_digest: state.graph_digest,
    objective: state.objective,
    terminal_status: terminalNode.terminal_status,
    quality_gate_passed: quality,
    finalized_at: nowIso(),
    assessment: state.assessment,
    counters: state.counters,
    nodes,
    failures,
    approvals,
    route_history: state.route_history,
    dynamic_expansions: state.dynamic_expansions,
    limitations: [
      'Agent roles are declared identities supplied by adapters, not cryptographically independent principals.',
      'Git worktrees isolate files but do not provide network or kernel isolation; use an external sandbox for untrusted commands.',
      'Vendor adapters require tool-specific live canaries before production use.',
      'Heuristic complexity and risk scores are routing inputs, not objective ground truth.',
    ],
  };
}

function markdown(report) {
  const lines = [
    '# ProofGraph Dynamic Workflow Report — Graph Engineering', '',
    `- Run: \`${report.run_id}\``,
    `- Graph: \`${report.graph_id}\``,
    `- Terminal status: **${report.terminal_status.toUpperCase()}**`,
    `- Quality gate: **${report.quality_gate_passed ? 'PASS' : 'FAIL/PARTIAL'}**`,
    `- Graph digest: \`${report.graph_digest}\``, '',
    '## Objective', '', report.objective, '',
    '## Nodes', '',
    '| Node | Kind | Role | Status | Attempts |',
    '|---|---|---|---|---:|',
  ];
  for (const node of report.nodes) lines.push(`| ${node.node_id} | ${node.kind} | ${node.role} | ${node.status} | ${node.attempts} |`);
  lines.push('', '## Failures', '');
  if (!report.failures.length) lines.push('- None');
  for (const item of report.failures) lines.push(`- ${item.node_id}: ${item.failure.failure_type} — ${item.failure.summary}`);
  lines.push('', '## Approvals', '');
  if (!report.approvals.length) lines.push('- None');
  for (const item of report.approvals) lines.push(`- ${item.node_id}: ${item.status}${item.decision ? ` (${item.decision})` : ''}`);
  lines.push('', '## Limitations', '');
  for (const item of report.limitations) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

async function finalizeTerminal(dataDir, runId, state, node, emit) {
  const runtime = state.node_states[node.node_id];
  runtime.status = 'succeeded';
  runtime.actor = 'system';
  runtime.attempts = Math.max(1, runtime.attempts);
  runtime.visits = Math.max(1, runtime.visits);
  runtime.started_at ??= nowIso();
  runtime.completed_at = nowIso();
  runtime.output = { terminal_status: node.terminal_status };
  runtime.output_sha256 = sha256(canonicalJson(runtime.output));
  const report = buildReport(state, node);
  const reportMarkdown = markdown(report);
  const hashes = await writeReportArtifacts(dataDir, runId, report, reportMarkdown);
  state.status = 'finalized';
  state.quality_gate_passed = report.quality_gate_passed;
  state.final = { ...report, report_json_sha256: hashes.json_sha256, report_markdown_sha256: hashes.markdown_sha256 };
  emit('graph.run_finalized', 'system', { terminal_node_id: node.node_id, terminal_status: node.terminal_status, quality_gate_passed: report.quality_gate_passed, ...hashes });
}

async function autoAdvance(dataDir, runId, state, emit) {
  let changed = true;
  let guard = 0;
  while (changed && guard < state.graph.nodes.length * 3) {
    changed = false;
    guard += 1;
    for (const node of state.graph.nodes) {
      const runtime = state.node_states[node.node_id];
      if (runtime.status !== 'ready') continue;
      if (node.kind === 'triage' && node.metadata?.auto === true) {
        runtime.status = 'succeeded';
        runtime.actor = 'system';
        runtime.attempts += 1;
        runtime.started_at = nowIso();
        runtime.completed_at = nowIso();
        runtime.output = { route: node.metadata.initial_route, assessment: node.metadata.assessment };
        runtime.output_sha256 = sha256(canonicalJson(runtime.output));
        state.counters.graph_steps += 1;
        emit('graph.node_auto_completed', 'system', { node_id: node.node_id, route: runtime.output.route });
        route(state, node, runtime, 'success', runtime.output, null, emit);
        changed = true;
      } else if (node.kind === 'terminal') {
        await finalizeTerminal(dataDir, runId, state, node, emit);
        changed = true;
      }
      if (state.status === 'finalized' || state.status === 'failed') return;
    }
  }
  if (guard >= state.graph.nodes.length * 3) {
    state.status = 'failed';
    state.failure_reason = 'Automatic advancement safety bound exceeded';
    emit('graph.auto_advance_failed', 'system', { guard });
  }
}

async function reserve(dataDir, runId, actor, operation, allowWaiting = false) {
  const { state, result } = await withRunTransaction(dataDir, runId, (next, emit) => {
    assertGraph(next);
    if (!(allowWaiting ? ACTIVE : new Set(['active'])).has(next.status)) return { ok: false, reason: `Graph run is ${next.status}` };
    if (Date.now() > Date.parse(next.deadline_at)) {
      next.status = 'budget_exceeded'; next.budget_exceeded_reason = 'max_wall_time_seconds';
      emit('budget.exceeded', actor, { operation, reason: next.budget_exceeded_reason });
      return { ok: false, budget: true, reason: 'Graph wall-clock budget expired' };
    }
    if (next.counters.tool_calls >= next.policy.max_tool_calls) {
      next.status = 'budget_exceeded'; next.budget_exceeded_reason = 'max_tool_calls';
      emit('budget.exceeded', actor, { operation, reason: next.budget_exceeded_reason });
      return { ok: false, budget: true, reason: 'Graph tool-call budget exhausted' };
    }
    next.counters.tool_calls += 1;
    emit('tool.reserved', actor, { operation, tool_calls: next.counters.tool_calls, source_fetches: 0 });
    return { ok: true };
  });
  if (!result.ok) {
    if (result.budget) throw new BudgetError(result.reason, { run_id: runId, status: state.status });
    throw new StateError(result.reason, { run_id: runId, status: state.status });
  }
}

export function previewGraph(input) {
  return compileDynamicGraph(input);
}

function explicitAssessment(graph) {
  return graph.metadata?.assessment ?? {
    objective: graph.objective,
    mode: 'explicit',
    signals: {},
    recommendation: {
      initial_route: 'graph-defined',
      post_approval_route: 'graph-defined',
      research_fanout: graph.nodes.filter((node) => node.kind === 'research').length,
      verification_strength: graph.nodes.some((node) => node.kind === 'verify' && node.model_tier === 'deep') ? 'deep' : 'standard',
      max_iterations: graph.limits.max_iterations,
      max_parallel_nodes: graph.limits.max_parallel_nodes,
      max_dynamic_nodes: graph.limits.max_dynamic_nodes,
      human_approval_required: graph.nodes.some((node) => node.kind === 'human_approval' || node.approval_required),
      model_tiers: {},
      reason_codes: ['source:explicit-graph'],
    },
  };
}

function resolveGraphInput(input) {
  const hasGraph = input.graph !== undefined;
  const hasObjective = input.objective !== undefined;
  if (hasGraph === hasObjective) throw new ValidationError('Provide exactly one of input.graph or input.objective');
  if (hasGraph) {
    const validated = validateGraphSpec(input.graph);
    return {
      graph: validated.spec,
      graph_digest: validated.digest,
      assessment: explicitAssessment(validated.spec),
      validation: validated.analysis,
      source: 'explicit',
    };
  }
  const compiled = compileDynamicGraph({
    objective: input.objective,
    mode: input.mode,
    signals: input.signals,
    constraints: input.constraints,
    profile: input.profile,
  });
  return { ...compiled, source: 'compiled' };
}

export async function startGraphRun(input, context = {}) {
  rejectUnknownKeys(input, ['objective', 'mode', 'signals', 'constraints', 'profile', 'runtime_policy', 'graph'], 'input');
  const compiled = resolveGraphInput(input);
  const policy = runtimePolicy(input.runtime_policy ?? {});
  const dataDir = context.dataDir ?? resolveDataDir();
  const projectDir = context.projectDir ?? resolveProjectDir();
  const key = projectKey(projectDir);
  const active = await readActiveRun(dataDir, key);
  if (active) throw new StateError('A ProofGraph run is already active for this project', active);
  const runId = randomId('pg');
  await setActiveRun(dataDir, key, runId);
  const created = nowIso();
  const nodeStates = Object.fromEntries(compiled.graph.nodes.map((node) => [node.node_id, nodeState(node)]));
  nodeStates[compiled.graph.entry_node].status = 'ready';
  nodeStates[compiled.graph.entry_node].visits = 1;
  const state = {
    schema_version: 2,
    product: PRODUCT_NAME, version: VERSION, run_kind: 'graph', run_id: runId,
    project_key: key, project_dir_sha256: sha256(projectDir), objective: compiled.graph.objective,
    status: 'active', quality_gate_passed: false, budget_exceeded_reason: null, failure_reason: null,
    created_at: created, updated_at: created,
    deadline_at: new Date(Date.now() + policy.max_wall_time_seconds * 1000).toISOString(),
    policy, graph: compiled.graph, graph_digest: compiled.graph_digest, original_graph_digest: compiled.graph_digest,
    graph_revision: 1, assessment: compiled.assessment,
    counters: { tool_calls: 0, source_fetches: 0, agents_spawned: 0, graph_steps: 0, dynamic_nodes: 0, approvals_requested: 0 },
    node_states: nodeStates, route_history: [], failures: {}, failure_counts: {}, approvals: {}, dynamic_expansions: [], final: null,
    event_head: { seq: 0, hash: '0'.repeat(64) },
  };
  try {
    await createRun(dataDir, state, { type: 'graph.run_created', actor: 'coordinator', data: { graph_id: state.graph.graph_id, graph_digest: state.graph_digest, assessment_digest: sha256(canonicalJson(state.assessment)), runtime_policy: policy } });
    const { state: advanced } = await withRunTransaction(dataDir, runId, async (next, emit) => { await autoAdvance(dataDir, runId, next, emit); });
    if (advanced.status === 'finalized') await clearActiveRun(dataDir, key, runId);
    return { ok: true, run_id: runId, status: advanced.status, graph_id: advanced.graph.graph_id, graph_digest: advanced.graph_digest, assessment: advanced.assessment, ready_nodes: readyNodes(advanced), pending_approvals: pendingApprovals(advanced) };
  } catch (error) {
    await clearActiveRun(dataDir, key, runId).catch(() => {});
    throw error;
  }
}

export async function getGraphStatus(input, context = {}) {
  rejectUnknownKeys(input, ['run_id'], 'input');
  const runId = validateRunId(input.run_id);
  const dataDir = context.dataDir ?? resolveDataDir();
  const state = await readVerifiedRun(dataDir, runId);
  assertGraph(state);
  return {
    ok: true, run_id: runId, objective: state.objective, status: state.status, quality_gate_passed: state.quality_gate_passed,
    graph_id: state.graph.graph_id, graph_digest: state.graph_digest, graph_revision: state.graph_revision,
    assessment: state.assessment, policy: state.policy, counters: state.counters, deadline_at: state.deadline_at,
    budget_exceeded_reason: state.budget_exceeded_reason, failure_reason: state.failure_reason,
    graph: state.graph, failures: state.failures,
    ready_nodes: readyNodes(state), pending_approvals: pendingApprovals(state),
    node_states: state.graph.nodes.map((node) => ({ ...node, ...state.node_states[node.node_id] })),
    route_history: state.route_history, dynamic_expansions: state.dynamic_expansions, event_head: state.event_head,
  };
}

export async function claimGraphNode(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'node_id'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  const nodeId = identifier(input.node_id, 'node_id');
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserve(dataDir, runId, actor, 'pg_graph_claim_node');
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    assertGraph(next);
    if (next.status !== 'active') throw new StateError(`Graph run is ${next.status}`);
    const node = nodeById(next, nodeId); const runtime = next.node_states[nodeId];
    if (!node || !runtime) throw new StateError(`Unknown graph node: ${nodeId}`);
    if (!actorAllowed(actor, node)) throw new SecurityError('Actor does not match node role', { actor, node_role: node.role });
    if (runtime.status !== 'ready') throw new StateError(`Node is not ready: ${nodeId}`, { status: runtime.status });
    if (runtime.attempts >= node.max_attempts) throw new StateError(`Node attempt limit exhausted: ${nodeId}`);
    if (Object.values(next.node_states).filter((item) => item.status === 'running').length >= next.graph.limits.max_parallel_nodes) throw new BudgetError('Parallel-node limit reached');
    runtime.status = 'running'; runtime.actor = actor; runtime.attempts += 1; runtime.started_at = nowIso();
    emit('graph.node_claimed', actor, { node_id: nodeId, attempt: runtime.attempts, agent_type: node.agent_type, model_tier: node.model_tier, tool_policy: node.tool_policy });
  });
  return { ok: true, run_id: runId, node: { ...nodeById(state, nodeId), ...state.node_states[nodeId] } };
}

export async function completeGraphNode(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'node_id', 'outcome', 'output', 'failure'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  const nodeId = identifier(input.node_id, 'node_id');
  const outcome = enumValue(input.outcome, 'outcome', OUTCOMES);
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserve(dataDir, runId, actor, 'pg_graph_complete_node');
  const before = await readVerifiedRun(dataDir, runId); assertGraph(before);
  const output = outputValue(input.output, before.policy.max_output_bytes);
  const failure = outcome === 'failed' ? failureValue(input.failure, before.policy.max_failure_bytes) : null;
  if (outcome !== 'failed' && input.failure !== undefined) throw new ValidationError('failure is allowed only with outcome=failed');
  const { state } = await withRunTransaction(dataDir, runId, async (next, emit) => {
    assertGraph(next);
    if (next.status !== 'active') throw new StateError(`Graph run is ${next.status}`);
    const node = nodeById(next, nodeId); const runtime = next.node_states[nodeId];
    if (!node || !runtime) throw new StateError(`Unknown graph node: ${nodeId}`);
    if (!actorAllowed(actor, node) || runtime.actor !== actor) throw new SecurityError('Only the claiming actor can complete the node');
    if (runtime.status !== 'running') throw new StateError(`Node is not running: ${nodeId}`);
    if (node.kind === 'verify' && outcome === 'success' && output?.verification?.passed !== true) throw new ValidationError('Verifier success requires output.verification.passed=true');
    if (node.kind === 'verify' && outcome === 'failed' && output?.verification?.passed === true) throw new ValidationError('Failed verification cannot report passed=true');
    runtime.status = outcome === 'success' ? 'succeeded' : outcome;
    runtime.completed_at = nowIso(); runtime.output = output; runtime.output_sha256 = sha256(canonicalJson(output));
    runtime.failure = failure; runtime.failure_sha256 = failure ? sha256(canonicalJson(failure)) : null;
    next.counters.graph_steps += 1;
    if (failure) {
      const failureId = randomId('failure');
      next.failures[failureId] = { failure_id: failureId, node_id: nodeId, actor, attempt: runtime.attempts, failure, created_at: nowIso() };
    }
    emit('graph.node_completed', actor, { node_id: nodeId, outcome, output_sha256: runtime.output_sha256, failure_sha256: runtime.failure_sha256 });
    if (next.counters.graph_steps > next.graph.limits.max_steps) {
      next.status = 'budget_exceeded'; next.budget_exceeded_reason = 'graph.max_steps';
      emit('budget.exceeded', actor, { operation: 'graph_step', reason: next.budget_exceeded_reason });
      return;
    }
    route(next, node, runtime, outcome, output, failure, emit);
    if (next.status === 'active') await autoAdvance(dataDir, runId, next, emit);
  });
  if (state.status === 'finalized') await clearActiveRun(dataDir, state.project_key, runId);
  return { ok: true, run_id: runId, status: state.status, node: state.node_states[nodeId], ready_nodes: readyNodes(state), pending_approvals: pendingApprovals(state), terminal_status: state.final?.terminal_status ?? null };
}

export async function resolveGraphApproval(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'approval_id', 'decision', 'challenge', 'decision_source', 'comment'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  if (!['human', 'coordinator'].includes(actor)) throw new SecurityError('Only human or coordinator may resolve approval');
  const approvalId = identifier(input.approval_id, 'approval_id');
  const decision = enumValue(input.decision, 'decision', ['approved', 'denied']);
  const challenge = stringValue(input.challenge, 'challenge', { min: 8, max: 128 });
  const source = enumValue(input.decision_source, 'decision_source', ['AskUserQuestion', 'external_human', 'test_fixture']);
  const comment = input.comment === undefined ? null : stringValue(input.comment, 'comment', { min: 1, max: 2000 });
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserve(dataDir, runId, actor, 'pg_graph_resolve_approval', true);
  const { state } = await withRunTransaction(dataDir, runId, async (next, emit) => {
    assertGraph(next);
    if (next.status !== 'waiting_approval') throw new StateError(`Graph is not waiting for approval: ${next.status}`);
    const approval = next.approvals[approvalId];
    if (!approval || approval.status !== 'pending') throw new StateError(`Unknown or resolved approval: ${approvalId}`);
    if (sha256(challenge) !== approval.challenge_sha256) throw new SecurityError('Approval challenge mismatch');
    const node = nodeById(next, approval.node_id); const runtime = next.node_states[node.node_id];
    approval.status = 'resolved'; approval.decision = decision; approval.decided_at = nowIso(); approval.decided_by = actor; approval.decision_source = source; approval.comment_sha256 = comment ? sha256(comment) : null; delete approval.challenge;
    runtime.status = decision === 'approved' ? 'succeeded' : 'blocked'; runtime.actor = actor; runtime.attempts += 1; runtime.started_at ??= nowIso(); runtime.completed_at = nowIso(); runtime.output = { approval: decision, decision_source: source, comment }; runtime.output_sha256 = sha256(canonicalJson(runtime.output));
    next.status = 'active'; next.counters.graph_steps += 1;
    emit('graph.approval_resolved', actor, { approval_id: approvalId, node_id: node.node_id, decision, decision_source: source, identity_warning: 'self-attested-human-role' });
    route(next, node, runtime, decision === 'approved' ? 'success' : 'blocked', runtime.output, null, emit);
    if (next.status === 'active') await autoAdvance(dataDir, runId, next, emit);
  });
  if (state.status === 'finalized') await clearActiveRun(dataDir, state.project_key, runId);
  return { ok: true, run_id: runId, status: state.status, decision, ready_nodes: readyNodes(state), pending_approvals: pendingApprovals(state), warning: 'Approval identity remains self-attested inside Claude Code.' };
}

function dynamicNode(task, index, graph) {
  rejectUnknownKeys(task, ['node_id', 'title', 'kind', 'role', 'risk', 'agent_type', 'model_tier', 'tool_policy'], `tasks[${index}]`);
  const kind = enumValue(task.kind, `tasks[${index}].kind`, ['research', 'develop', 'verify']);
  const role = kind === 'research' ? 'researcher' : kind === 'develop' ? 'developer' : 'verifier';
  if (task.role !== undefined && task.role !== role) throw new ValidationError(`tasks[${index}].role must be ${role}`);
  const defaultAgent = kind === 'research' ? 'proofgraph-claude:graph-researcher' : kind === 'develop' ? 'proofgraph-claude:graph-developer' : 'proofgraph-claude:graph-verifier';
  const allowedTools = kind === 'research' ? ['proofgraph', 'web_search', 'workspace_read'] : ['proofgraph', 'workspace_read'];
  const tools = task.tool_policy === undefined ? allowedTools : arrayValue(task.tool_policy, `tasks[${index}].tool_policy`, { min: 1, max: allowedTools.length }).map((item, toolIndex) => enumValue(item, `tasks[${index}].tool_policy[${toolIndex}]`, allowedTools));
  return {
    node_id: identifier(task.node_id, `tasks[${index}].node_id`), title: stringValue(task.title, `tasks[${index}].title`, { min: 3, max: 300 }),
    kind, role, risk: task.risk === undefined ? 'low' : enumValue(task.risk, `tasks[${index}].risk`, ['low', 'medium']),
    max_attempts: graph.limits.max_iterations, join: 'any', approval_required: false,
    agent_type: task.agent_type === undefined ? defaultAgent : stringValue(task.agent_type, `tasks[${index}].agent_type`, { min: 3, max: 120 }),
    model_tier: task.model_tier === undefined ? 'standard' : enumValue(task.model_tier, `tasks[${index}].model_tier`, ['fast', 'standard', 'deep', 'inherit']),
    tool_policy: tools, dynamic: true, metadata: { expanded: true },
  };
}

export async function expandGraph(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'parent_node_id', 'join_node_id', 'tasks', 'reason'], 'input');
  const runId = validateRunId(input.run_id); const actor = identifier(input.actor, 'actor');
  if (actor !== 'planner') throw new SecurityError('Only planner may expand a graph');
  const parentId = identifier(input.parent_node_id, 'parent_node_id'); const joinId = identifier(input.join_node_id, 'join_node_id');
  const reason = stringValue(input.reason, 'reason', { min: 5, max: 2000 });
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserve(dataDir, runId, actor, 'pg_graph_expand');
  const before = await readVerifiedRun(dataDir, runId); assertGraph(before);
  const tasks = arrayValue(input.tasks, 'tasks', { min: 1, max: before.graph.limits.max_parallel_nodes }).map((task, index) => dynamicNode(task, index, before.graph));
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    assertGraph(next);
    const parent = nodeById(next, parentId); const join = nodeById(next, joinId);
    if (!parent || parent.kind !== 'plan') throw new ValidationError('parent_node_id must be a plan node');
    if (!join || !['develop', 'verify', 'plan'].includes(join.kind)) throw new ValidationError('join_node_id must be a plan, develop, or verify node');
    if (next.node_states[parentId].status !== 'running' || next.node_states[parentId].actor !== actor) throw new StateError('Planner must claim the parent node before expansion');
    if (next.node_states[joinId].status !== 'pending') throw new StateError('Join node must be pending');
    if (next.counters.dynamic_nodes + tasks.length > next.graph.limits.max_dynamic_nodes) throw new BudgetError('Dynamic-node budget exceeded');
    const existing = new Set(next.graph.nodes.map((node) => node.node_id));
    for (const task of tasks) if (existing.has(task.node_id)) throw new ValidationError(`Dynamic node exists: ${task.node_id}`);
    const removed = next.graph.edges.filter((edge) => edge.from === parentId && edge.to === joinId && edge.condition.type === 'outcome' && edge.condition.value === 'success');
    next.graph.edges = next.graph.edges.filter((edge) => !removed.some((item) => item.edge_id === edge.edge_id));
    for (const task of tasks) {
      next.graph.nodes.push(task); next.node_states[task.node_id] = nodeState(task);
      const suffix = sha256(`${parentId}:${task.node_id}:${joinId}`).slice(0, 12);
      next.graph.edges.push({ edge_id: `dyn-out-${suffix}`, from: parentId, to: task.node_id, condition: { type: 'outcome', value: 'success' }, priority: 100, label: 'dynamic fan-out' });
      next.graph.edges.push({ edge_id: `dyn-in-${suffix}`, from: task.node_id, to: joinId, condition: { type: 'outcome', value: 'success' }, priority: 100, label: 'dynamic fan-in' });
    }
    join.join = 'all'; join.metadata = { ...join.metadata, join_from: tasks.map((task) => task.node_id), dynamically_expanded: true };
    const checked = validateGraphSpec(next.graph); next.graph = checked.spec; next.graph_digest = checked.digest; next.graph_revision += 1; next.counters.dynamic_nodes += tasks.length;
    const expansion = { expansion_id: randomId('expand'), actor, parent_node_id: parentId, join_node_id: joinId, task_node_ids: tasks.map((task) => task.node_id), removed_edge_ids: removed.map((edge) => edge.edge_id), reason_sha256: sha256(reason), graph_revision: next.graph_revision, graph_digest: next.graph_digest, created_at: nowIso() };
    next.dynamic_expansions.push(expansion); emit('graph.expanded', actor, expansion);
  });
  return { ok: true, run_id: runId, graph_revision: state.graph_revision, graph_digest: state.graph_digest, dynamic_nodes: state.counters.dynamic_nodes, expansion: state.dynamic_expansions.at(-1) };
}

export async function getGraphReport(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'format'], 'input');
  const runId = validateRunId(input.run_id); const format = input.format === undefined ? 'markdown' : enumValue(input.format, 'format', ['markdown', 'json']);
  const dataDir = context.dataDir ?? resolveDataDir(); const state = await readVerifiedRun(dataDir, runId); assertGraph(state);
  if (state.status !== 'finalized') throw new StateError(`Graph run is not finalized: ${state.status}`);
  const md = await readReport(dataDir, runId, 'md'); const json = await readReport(dataDir, runId, 'json');
  if (sha256(md) !== state.final.report_markdown_sha256 || sha256(json) !== state.final.report_json_sha256) throw new SecurityError('Graph report hash mismatch');
  return format === 'json' ? { ok: true, run_id: runId, format, report: state.final } : { ok: true, run_id: runId, format, report: md };
}

export async function abortGraphRun(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'reason'], 'input');
  const runId = validateRunId(input.run_id); const actor = identifier(input.actor, 'actor');
  if (actor !== 'coordinator') throw new SecurityError('Only coordinator may abort a graph run');
  const reason = stringValue(input.reason, 'reason', { min: 3, max: 2000 });
  const dataDir = context.dataDir ?? resolveDataDir();
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => { assertGraph(next); if (TERMINAL.has(next.status)) throw new StateError(`Graph run is terminal: ${next.status}`); next.status = 'aborted'; next.abort_reason = reason; emit('graph.run_aborted', actor, { reason_sha256: sha256(reason) }); });
  await clearActiveRun(dataDir, state.project_key, runId);
  return { ok: true, run_id: runId, status: 'aborted' };
}

export async function verifyGraphIntegrity(input, context = {}) {
  rejectUnknownKeys(input, ['run_id'], 'input');
  const runId = validateRunId(input.run_id); const dataDir = context.dataDir ?? resolveDataDir(); const state = await readRun(dataDir, runId); assertGraph(state);
  const checks = []; const chain = await verifyEventChain(dataDir, runId); checks.push({ check: 'event_chain', ok: chain.ok, details: chain });
  try { const checked = validateGraphSpec(state.graph); checks.push({ check: 'graph_spec', ok: checked.digest === state.graph_digest, expected: state.graph_digest, actual: checked.digest }); }
  catch (error) { checks.push({ check: 'graph_spec', ok: false, error: error.message }); }
  for (const node of state.graph.nodes) {
    const runtime = state.node_states[node.node_id];
    checks.push({ check: `node:${node.node_id}`, ok: (runtime.output === null || sha256(canonicalJson(runtime.output)) === runtime.output_sha256) && (runtime.failure === null || sha256(canonicalJson(runtime.failure)) === runtime.failure_sha256) });
  }
  if (state.status === 'finalized') {
    try {
      const md = await readReport(dataDir, runId, 'md'); const json = await readReport(dataDir, runId, 'json');
      checks.push({ check: 'report_markdown', ok: sha256(md) === state.final.report_markdown_sha256 });
      checks.push({ check: 'report_json', ok: sha256(json) === state.final.report_json_sha256 });
    } catch (error) { checks.push({ check: 'report_artifacts', ok: false, error: error.message }); }
  }
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, run_id: runId, checks, failed_checks: failed.map((check) => check.check), event_head: state.event_head, warning: 'Local hashes are not an external signature, human-identity attestation, or notarization.' };
}

export const graphRuntimeInternals = { conditionMatches, joinReady, adaptiveFailure, buildReport, markdown, readyNodes };
