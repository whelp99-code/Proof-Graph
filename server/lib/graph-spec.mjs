import { canonicalJson, sha256 } from './canonical.mjs';
import { SecurityError, ValidationError } from './errors.mjs';
import {
  arrayValue,
  booleanValue,
  enumValue,
  identifier,
  integerValue,
  rejectUnknownKeys,
  stringValue,
  uniqueStrings,
} from './validate.mjs';

export const GRAPH_NODE_KINDS = Object.freeze([
  'triage', 'direct', 'research', 'plan', 'develop', 'verify',
  'human_approval', 'synthesize', 'terminal',
]);
export const GRAPH_ROLES = Object.freeze([
  'system', 'coordinator', 'direct', 'researcher', 'planner',
  'developer', 'verifier', 'human', 'synthesizer',
]);
export const GRAPH_RISKS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const GRAPH_MODEL_TIERS = Object.freeze(['fast', 'standard', 'deep', 'inherit']);
export const GRAPH_TOOLS = Object.freeze(['proofgraph', 'web_search', 'workspace_read', 'workspace_write', 'shell']);
export const GRAPH_FAILURE_TYPES = Object.freeze([
  'implementation_error', 'design_error', 'requirements_error', 'evidence_gap',
  'verification_error', 'security_risk', 'budget_exceeded', 'unknown',
]);
export const GRAPH_ROUTES = Object.freeze(['direct', 'research', 'plan', 'develop', 'verify', 'human', 'synthesize', 'success', 'partial', 'failed']);

export const DEFAULT_GRAPH_LIMITS = Object.freeze({
  max_steps: 120,
  max_route_visits: 4,
  max_dynamic_nodes: 24,
  max_parallel_nodes: 6,
  max_iterations: 4,
});

export const DEFAULT_GRAPH_POLICY = Object.freeze({
  require_verification_for_success: true,
  require_human_for_high_risk: true,
  allow_workspace_mutation: false,
  allow_shell: false,
});

const KIND_ROLES = Object.freeze({
  triage: new Set(['system', 'coordinator']),
  direct: new Set(['direct', 'developer']),
  research: new Set(['researcher']),
  plan: new Set(['planner']),
  develop: new Set(['developer']),
  verify: new Set(['verifier']),
  human_approval: new Set(['human']),
  synthesize: new Set(['synthesizer']),
  terminal: new Set(['system']),
});

function jsonObject(value, name, maxBytes = 20_000) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  if (bytes > maxBytes) throw new ValidationError(`${name} exceeds ${maxBytes} bytes`);
  return structuredClone(value);
}

function normalizeLimits(input = {}) {
  rejectUnknownKeys(input, Object.keys(DEFAULT_GRAPH_LIMITS), 'graph.limits');
  return {
    max_steps: input.max_steps === undefined ? 120 : integerValue(input.max_steps, 'graph.limits.max_steps', { min: 4, max: 2000 }),
    max_route_visits: input.max_route_visits === undefined ? 4 : integerValue(input.max_route_visits, 'graph.limits.max_route_visits', { min: 1, max: 20 }),
    max_dynamic_nodes: input.max_dynamic_nodes === undefined ? 24 : integerValue(input.max_dynamic_nodes, 'graph.limits.max_dynamic_nodes', { min: 0, max: 200 }),
    max_parallel_nodes: input.max_parallel_nodes === undefined ? 6 : integerValue(input.max_parallel_nodes, 'graph.limits.max_parallel_nodes', { min: 1, max: 32 }),
    max_iterations: input.max_iterations === undefined ? 4 : integerValue(input.max_iterations, 'graph.limits.max_iterations', { min: 1, max: 20 }),
  };
}

function normalizePolicy(input = {}) {
  rejectUnknownKeys(input, Object.keys(DEFAULT_GRAPH_POLICY), 'graph.policy');
  return {
    require_verification_for_success: input.require_verification_for_success === undefined ? true : booleanValue(input.require_verification_for_success, 'graph.policy.require_verification_for_success'),
    require_human_for_high_risk: input.require_human_for_high_risk === undefined ? true : booleanValue(input.require_human_for_high_risk, 'graph.policy.require_human_for_high_risk'),
    allow_workspace_mutation: input.allow_workspace_mutation === undefined ? false : booleanValue(input.allow_workspace_mutation, 'graph.policy.allow_workspace_mutation'),
    allow_shell: input.allow_shell === undefined ? false : booleanValue(input.allow_shell, 'graph.policy.allow_shell'),
  };
}

function normalizeNode(input, index, policy) {
  const name = `graph.nodes[${index}]`;
  rejectUnknownKeys(input, [
    'node_id', 'title', 'kind', 'role', 'risk', 'max_attempts', 'join',
    'approval_required', 'agent_type', 'model_tier', 'tool_policy',
    'terminal_status', 'dynamic', 'metadata',
  ], name);
  const kind = enumValue(input.kind, `${name}.kind`, GRAPH_NODE_KINDS);
  const role = enumValue(input.role, `${name}.role`, GRAPH_ROLES);
  const risk = input.risk === undefined ? 'low' : enumValue(input.risk, `${name}.risk`, GRAPH_RISKS);
  const approvalRequired = input.approval_required === undefined
    ? ['high', 'critical'].includes(risk)
    : booleanValue(input.approval_required, `${name}.approval_required`);
  const tools = input.tool_policy === undefined
    ? ['proofgraph']
    : uniqueStrings(input.tool_policy, `${name}.tool_policy`, { min: 1, max: GRAPH_TOOLS.length, itemMax: 64 })
      .map((value, toolIndex) => enumValue(value, `${name}.tool_policy[${toolIndex}]`, GRAPH_TOOLS));
  const node = {
    node_id: identifier(input.node_id, `${name}.node_id`),
    title: stringValue(input.title, `${name}.title`, { min: 3, max: 300 }),
    kind,
    role,
    risk,
    max_attempts: input.max_attempts === undefined ? 1 : integerValue(input.max_attempts, `${name}.max_attempts`, { min: 1, max: 20 }),
    join: input.join === undefined ? 'any' : enumValue(input.join, `${name}.join`, ['any', 'all']),
    approval_required: approvalRequired,
    agent_type: input.agent_type == null ? null : stringValue(input.agent_type, `${name}.agent_type`, { min: 3, max: 120 }),
    model_tier: input.model_tier === undefined ? 'inherit' : enumValue(input.model_tier, `${name}.model_tier`, GRAPH_MODEL_TIERS),
    tool_policy: tools,
    terminal_status: kind === 'terminal' ? enumValue(input.terminal_status, `${name}.terminal_status`, ['success', 'partial', 'failed']) : null,
    dynamic: input.dynamic === undefined ? false : booleanValue(input.dynamic, `${name}.dynamic`),
    metadata: jsonObject(input.metadata, `${name}.metadata`),
  };
  if (!KIND_ROLES[kind].has(role)) throw new ValidationError(`${name}.role ${role} is incompatible with ${kind}`);
  if (kind !== 'terminal' && input.terminal_status != null) throw new ValidationError(`${name}.terminal_status is allowed only for terminal nodes`);
  if (kind === 'terminal' && node.agent_type) throw new ValidationError(`${name} terminal nodes cannot spawn agents`);
  if (policy.require_human_for_high_risk && ['high', 'critical'].includes(risk) && kind !== 'human_approval' && !approvalRequired) {
    throw new SecurityError(`${name} high-risk nodes must require approval`);
  }
  if (tools.includes('workspace_write') && !policy.allow_workspace_mutation) throw new SecurityError(`${name} workspace mutation is disabled`);
  if (tools.includes('shell') && !policy.allow_shell) throw new SecurityError(`${name} shell access is disabled`);
  if ((tools.includes('workspace_write') || tools.includes('shell')) && !approvalRequired) throw new SecurityError(`${name} mutating capabilities require approval`);
  return node;
}

function normalizeCondition(input, name) {
  if (input === undefined) return { type: 'always' };
  rejectUnknownKeys(input, ['type', 'value'], name);
  const type = enumValue(input.type, `${name}.type`, ['always', 'outcome', 'route', 'failure_type', 'approval', 'verification']);
  if (type === 'always') {
    if (input.value !== undefined) throw new ValidationError(`${name}.value is not allowed for always`);
    return { type };
  }
  const allowed = type === 'outcome' ? ['success', 'failed', 'blocked']
    : type === 'route' ? GRAPH_ROUTES
      : type === 'failure_type' ? GRAPH_FAILURE_TYPES
        : type === 'approval' ? ['approved', 'denied']
          : ['passed', 'failed'];
  return { type, value: enumValue(input.value, `${name}.value`, allowed) };
}

function normalizeEdge(input, index) {
  const name = `graph.edges[${index}]`;
  rejectUnknownKeys(input, ['edge_id', 'from', 'to', 'condition', 'priority', 'label'], name);
  return {
    edge_id: identifier(input.edge_id, `${name}.edge_id`),
    from: identifier(input.from, `${name}.from`),
    to: identifier(input.to, `${name}.to`),
    condition: normalizeCondition(input.condition, `${name}.condition`),
    priority: input.priority === undefined ? 50 : integerValue(input.priority, `${name}.priority`, { min: 0, max: 100 }),
    label: input.label == null ? null : stringValue(input.label, `${name}.label`, { min: 1, max: 200 }),
  };
}

function maps(spec) {
  const outgoing = new Map(spec.nodes.map((node) => [node.node_id, []]));
  const incoming = new Map(spec.nodes.map((node) => [node.node_id, []]));
  for (const edge of spec.edges) {
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  }
  return { outgoing, incoming };
}

function reachable(spec, outgoing) {
  const seen = new Set();
  const stack = [spec.entry_node];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) stack.push(edge.to);
  }
  return seen;
}

function components(spec, outgoing) {
  let sequence = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const output = [];
  const visit = (id) => {
    indices.set(id, sequence);
    low.set(id, sequence);
    sequence += 1;
    stack.push(id);
    onStack.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (!indices.has(edge.to)) {
        visit(edge.to);
        low.set(id, Math.min(low.get(id), low.get(edge.to)));
      } else if (onStack.has(edge.to)) low.set(id, Math.min(low.get(id), indices.get(edge.to)));
    }
    if (low.get(id) === indices.get(id)) {
      const group = [];
      let value;
      do {
        value = stack.pop();
        onStack.delete(value);
        group.push(value);
      } while (value !== id);
      output.push(group);
    }
  };
  for (const node of spec.nodes) if (!indices.has(node.node_id)) visit(node.node_id);
  return output;
}

function verifySuccessPaths(spec, outgoing, nodeMap) {
  if (!spec.policy.require_verification_for_success) return;
  const queue = [{ node_id: spec.entry_node, verified: false }];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    const key = `${current.node_id}:${current.verified ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodeMap.get(current.node_id);
    const verified = current.verified || node.kind === 'verify';
    if (node.kind === 'terminal' && node.terminal_status === 'success' && !verified) {
      throw new SecurityError('A successful terminal is reachable without a verifier', { terminal_node_id: node.node_id });
    }
    for (const edge of outgoing.get(current.node_id) ?? []) queue.push({ node_id: edge.to, verified });
  }
}

export function validateGraphSpec(input) {
  rejectUnknownKeys(input, ['schema_version', 'graph_id', 'name', 'objective', 'entry_node', 'nodes', 'edges', 'limits', 'policy', 'metadata', 'compiler'], 'graph');
  const policy = normalizePolicy(input.policy ?? {});
  const spec = {
    schema_version: input.schema_version === undefined ? 1 : integerValue(input.schema_version, 'graph.schema_version', { min: 1, max: 1 }),
    graph_id: identifier(input.graph_id, 'graph.graph_id'),
    name: stringValue(input.name, 'graph.name', { min: 3, max: 200 }),
    objective: stringValue(input.objective, 'graph.objective', { min: 10, max: 10000 }),
    entry_node: identifier(input.entry_node, 'graph.entry_node'),
    nodes: arrayValue(input.nodes, 'graph.nodes', { min: 2, max: 200 }).map((node, index) => normalizeNode(node, index, policy)),
    edges: arrayValue(input.edges, 'graph.edges', { min: 1, max: 500 }).map(normalizeEdge),
    limits: normalizeLimits(input.limits ?? {}),
    policy,
    metadata: jsonObject(input.metadata, 'graph.metadata'),
    compiler: input.compiler == null ? null : jsonObject(input.compiler, 'graph.compiler'),
  };
  const nodeIds = spec.nodes.map((node) => node.node_id);
  const edgeIds = spec.edges.map((edge) => edge.edge_id);
  if (new Set(nodeIds).size !== nodeIds.length) throw new ValidationError('Duplicate graph node IDs');
  if (new Set(edgeIds).size !== edgeIds.length) throw new ValidationError('Duplicate graph edge IDs');
  const nodeMap = new Map(spec.nodes.map((node) => [node.node_id, node]));
  if (!nodeMap.has(spec.entry_node)) throw new ValidationError('graph.entry_node does not exist');
  for (const edge of spec.edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) throw new ValidationError(`Edge ${edge.edge_id} references an unknown node`);
    if (edge.from === edge.to) throw new ValidationError(`Self-loop edge is not allowed: ${edge.edge_id}`);
  }
  const { outgoing, incoming } = maps(spec);
  for (const node of spec.nodes) {
    if (node.node_id !== spec.entry_node && (incoming.get(node.node_id) ?? []).length === 0) throw new ValidationError(`Node has no incoming edge: ${node.node_id}`);
    if (node.kind === 'terminal' && (outgoing.get(node.node_id) ?? []).length) throw new ValidationError(`Terminal node has outgoing edges: ${node.node_id}`);
    if (node.kind !== 'terminal' && (outgoing.get(node.node_id) ?? []).length === 0) throw new ValidationError(`Non-terminal node has no outgoing edge: ${node.node_id}`);
  }
  const missing = nodeIds.filter((id) => !reachable(spec, outgoing).has(id));
  if (missing.length) throw new ValidationError('Graph contains unreachable nodes', { unreachable: missing });
  const terminals = spec.nodes.filter((node) => node.kind === 'terminal');
  if (!terminals.some((node) => node.terminal_status === 'success')) throw new ValidationError('Graph requires a success terminal');
  const cycles = components(spec, outgoing).filter((group) => group.length > 1);
  for (const cycle of cycles) {
    const kinds = new Set(cycle.map((id) => nodeMap.get(id).kind));
    if (!kinds.has('verify') && !kinds.has('human_approval')) throw new SecurityError('Every cycle must include verification or human approval', { cycle });
  }
  verifySuccessPaths(spec, outgoing, nodeMap);
  return {
    spec,
    digest: sha256(canonicalJson(spec)),
    analysis: {
      node_count: spec.nodes.length,
      edge_count: spec.edges.length,
      terminal_count: terminals.length,
      cycle_count: cycles.length,
      cycles,
      dynamic_node_count: spec.nodes.filter((node) => node.dynamic).length,
    },
  };
}
