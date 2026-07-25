import { sha256 } from './canonical.mjs';
import { VERSION } from '../../runtime/version.mjs';
import { validateGraphSpec } from './graph-spec.mjs';
import {
  arrayValue,
  booleanValue,
  enumValue,
  integerValue,
  rejectUnknownKeys,
  stringValue,
} from './validate.mjs';

const COMPLEX = ['architecture', 'migration', 'refactor', 'distributed', 'parallel', 'workflow', 'multi-agent', 'benchmark', '구축', '설계', '아키텍처', '마이그레이션', '분산', '병렬', '워크플로'];
const RESEARCH = ['research', 'verify', 'compare', 'evidence', 'paper', 'documentation', 'latest', '조사', '검증', '비교', '근거', '논문', '문서', '최신'];
const IMPLEMENT = ['implement', 'build', 'code', 'develop', 'patch', 'fix', 'create', 'deploy', '구현', '개발', '코드', '패치', '수정', '배포'];
const RISK = ['production', 'deploy', 'delete', 'credential', 'secret', 'payment', 'medical', 'legal', 'security', 'database', '프로덕션', '배포', '삭제', '자격증명', '비밀', '결제', '의료', '법률', '보안', '데이터베이스'];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const has = (text, words) => words.some((word) => text.toLowerCase().includes(word));

function profileStrings(value, name, max = 32) {
  return arrayValue(value ?? [], name, { min: 0, max })
    .map((item, index) => stringValue(item, `${name}[${index}]`, { min: 1, max: 1000 }));
}

function normalizeProfile(input = {}) {
  rejectUnknownKeys(input, [
    'template_name', 'research_workstreams', 'implementation_workstreams',
    'deliverables', 'acceptance_tests', 'non_goals',
  ], 'profile');
  return {
    template_name: input.template_name == null
      ? null
      : stringValue(input.template_name, 'profile.template_name', { min: 1, max: 64 }),
    research_workstreams: profileStrings(input.research_workstreams, 'profile.research_workstreams'),
    implementation_workstreams: profileStrings(input.implementation_workstreams, 'profile.implementation_workstreams'),
    deliverables: profileStrings(input.deliverables, 'profile.deliverables'),
    acceptance_tests: profileStrings(input.acceptance_tests, 'profile.acceptance_tests'),
    non_goals: profileStrings(input.non_goals, 'profile.non_goals'),
  };
}

function heuristicSignals(objective) {
  const complex = has(objective, COMPLEX);
  const research = has(objective, RESEARCH);
  const implementation = has(objective, IMPLEMENT);
  const risky = has(objective, RISK);
  const listLike = (objective.match(/[\n,;]|(?:\d+\.)/g) ?? []).length >= 3;
  return {
    complexity: clamp(15 + Math.floor(objective.length / 120) * 8 + (complex ? 30 : 0) + (listLike ? 15 : 0) + (research && implementation ? 10 : 0), 0, 100),
    uncertainty: clamp(15 + (research ? 40 : 0) + (objective.includes('?') ? 10 : 0) + (/latest|최신/i.test(objective) ? 15 : 0), 0, 100),
    risk: risky ? 'high' : 'low',
    requires_research: research,
    requires_implementation: implementation,
    external_side_effects: /deploy|delete|send|publish|purchase|배포|삭제|전송|게시|구매/i.test(objective),
    compliance_sensitive: /medical|legal|finance|privacy|의료|법률|재무|개인정보/i.test(objective),
    detected: { complex, research, implementation, risky, list_like: listLike },
  };
}

function normalizeSignals(input, objective) {
  rejectUnknownKeys(input, [
    'complexity', 'uncertainty', 'risk', 'reversibility', 'requires_research',
    'requires_implementation', 'estimated_subtasks', 'external_side_effects',
    'compliance_sensitive', 'user_approval_required', 'verification_strength',
  ], 'signals');
  const h = heuristicSignals(objective);
  const external = input.external_side_effects === undefined ? h.external_side_effects : booleanValue(input.external_side_effects, 'signals.external_side_effects');
  const compliance = input.compliance_sensitive === undefined ? h.compliance_sensitive : booleanValue(input.compliance_sensitive, 'signals.compliance_sensitive');
  let risk = input.risk === undefined ? h.risk : enumValue(input.risk, 'signals.risk', ['low', 'medium', 'high', 'critical']);
  if ((external || compliance) && risk === 'low') risk = 'high';
  return {
    complexity: input.complexity === undefined ? h.complexity : integerValue(input.complexity, 'signals.complexity', { min: 0, max: 100 }),
    uncertainty: input.uncertainty === undefined ? h.uncertainty : integerValue(input.uncertainty, 'signals.uncertainty', { min: 0, max: 100 }),
    risk,
    reversibility: input.reversibility === undefined ? (external ? 'partially_reversible' : 'reversible') : enumValue(input.reversibility, 'signals.reversibility', ['reversible', 'partially_reversible', 'irreversible']),
    requires_research: input.requires_research === undefined ? h.requires_research : booleanValue(input.requires_research, 'signals.requires_research'),
    requires_implementation: input.requires_implementation === undefined ? h.requires_implementation : booleanValue(input.requires_implementation, 'signals.requires_implementation'),
    estimated_subtasks: input.estimated_subtasks === undefined ? clamp(Math.ceil(h.complexity / 25), 1, 12) : integerValue(input.estimated_subtasks, 'signals.estimated_subtasks', { min: 1, max: 50 }),
    external_side_effects: external,
    compliance_sensitive: compliance,
    user_approval_required: input.user_approval_required === undefined ? false : booleanValue(input.user_approval_required, 'signals.user_approval_required'),
    verification_strength: input.verification_strength === undefined ? null : enumValue(input.verification_strength, 'signals.verification_strength', ['lite', 'standard', 'deep']),
    heuristic_fields: Object.keys(input).length === 0 ? ['all'] : Object.keys(h).filter((key) => input[key] === undefined),
    heuristic_details: h.detected,
  };
}

export function assessObjective(input) {
  rejectUnknownKeys(input, ['objective', 'mode', 'signals', 'constraints', 'profile'], 'input');
  const objective = stringValue(input.objective, 'objective', { min: 10, max: 10000 });
  const mode = input.mode === undefined ? 'auto' : enumValue(input.mode, 'mode', ['auto', 'research', 'build', 'review']);
  const constraints = input.constraints ?? {};
  rejectUnknownKeys(constraints, ['max_parallel_nodes', 'max_iterations', 'max_dynamic_nodes'], 'constraints');
  const signals = normalizeSignals(input.signals ?? {}, objective);
  const profile = normalizeProfile(input.profile ?? {});
  const maxParallel = constraints.max_parallel_nodes === undefined ? 6 : integerValue(constraints.max_parallel_nodes, 'constraints.max_parallel_nodes', { min: 1, max: 16 });
  const maxIterations = constraints.max_iterations === undefined ? 4 : integerValue(constraints.max_iterations, 'constraints.max_iterations', { min: 1, max: 10 });
  const maxDynamic = constraints.max_dynamic_nodes === undefined ? 24 : integerValue(constraints.max_dynamic_nodes, 'constraints.max_dynamic_nodes', { min: 0, max: 100 });

  const approvalRequired = ['high', 'critical'].includes(signals.risk)
    || signals.external_side_effects || signals.compliance_sensitive
    || signals.user_approval_required || signals.reversibility === 'irreversible';
  let workRoute;
  if (mode === 'research') workRoute = 'research';
  else if (mode === 'build') workRoute = signals.requires_research || signals.uncertainty >= 45 ? 'research' : 'plan';
  else if (mode === 'review') workRoute = signals.requires_research || signals.uncertainty >= 55 ? 'research' : 'direct';
  else if (signals.complexity <= 30 && signals.uncertainty <= 30 && !signals.requires_research && !signals.requires_implementation) workRoute = 'direct';
  else if (signals.requires_research || signals.uncertainty >= 45) workRoute = 'research';
  else workRoute = 'plan';

  const fanout = workRoute === 'research'
    ? (profile.research_workstreams.length
      ? clamp(profile.research_workstreams.length, 2, maxParallel)
      : clamp(Math.ceil((signals.complexity + signals.uncertainty + signals.estimated_subtasks * 4) / 55), 2, maxParallel))
    : 0;
  const verificationStrength = signals.verification_strength
    ?? (approvalRequired || signals.complexity >= 75 ? 'deep' : signals.complexity <= 25 && signals.uncertainty <= 25 ? 'lite' : 'standard');
  const iterations = clamp(1 + Math.floor((signals.complexity + signals.uncertainty) / 55), 1, maxIterations);
  return {
    objective,
    mode,
    signals,
    profile,
    recommendation: {
      initial_route: approvalRequired ? 'human' : workRoute,
      post_approval_route: workRoute,
      research_fanout: fanout,
      verification_strength: verificationStrength,
      max_iterations: iterations,
      max_parallel_nodes: maxParallel,
      max_dynamic_nodes: maxDynamic,
      human_approval_required: approvalRequired,
      model_tiers: {
        direct: signals.complexity <= 25 ? 'fast' : 'standard',
        research: signals.uncertainty >= 70 ? 'deep' : 'standard',
        plan: signals.complexity >= 70 ? 'deep' : 'standard',
        develop: signals.complexity >= 80 ? 'deep' : 'standard',
        verify: verificationStrength === 'deep' ? 'deep' : 'standard',
        synthesize: 'standard',
      },
      reason_codes: [`mode:${mode}`, `complexity:${signals.complexity}`, `uncertainty:${signals.uncertainty}`, `risk:${signals.risk}`, `route:${approvalRequired ? 'human' : workRoute}`],
    },
  };
}

function node(node_id, title, kind, role, options = {}) {
  const value = {
    node_id, title, kind, role,
    risk: options.risk ?? 'low',
    max_attempts: options.max_attempts ?? 1,
    join: options.join ?? 'any',
    approval_required: options.approval_required ?? false,
    agent_type: options.agent_type ?? null,
    model_tier: options.model_tier ?? 'inherit',
    tool_policy: options.tool_policy ?? ['proofgraph'],
    dynamic: options.dynamic ?? false,
    metadata: options.metadata ?? {},
  };
  if (kind === 'terminal') value.terminal_status = options.terminal_status;
  return value;
}

function edge(edge_id, from, to, type, value, priority = 50) {
  return { edge_id, from, to, condition: value === undefined ? { type } : { type, value }, priority };
}

function agent(kind, strength = 'standard') {
  if (kind === 'direct') return 'proofgraph-claude:graph-direct';
  if (kind === 'research') return 'proofgraph-claude:graph-researcher';
  if (kind === 'plan') return 'proofgraph-claude:graph-planner';
  if (kind === 'develop') return 'proofgraph-claude:graph-developer';
  if (kind === 'verify') return strength === 'deep' ? 'proofgraph-claude:graph-verifier-deep' : 'proofgraph-claude:graph-verifier';
  if (kind === 'synthesize') return 'proofgraph-claude:graph-synthesizer';
  return null;
}

export function compileDynamicGraph(input) {
  const assessment = assessObjective(input);
  const { recommendation: r, signals, objective, profile } = assessment;
  const stableInput = { objective, mode: assessment.mode, signals, profile, recommendation: r };
  const graphId = `graph_${sha256(JSON.stringify(stableInput)).slice(0, 16)}`;
  const nodes = [];
  const edges = [];
  const addNode = (value) => { nodes.push(value); return value.node_id; };
  const addEdge = (...args) => edges.push(edge(...args));

  addNode(node('triage', 'Deterministic complexity and risk triage', 'triage', 'system', {
    metadata: { auto: true, initial_route: r.initial_route, assessment },
  }));
  addNode(node('terminal-success', 'Successful completion', 'terminal', 'system', { terminal_status: 'success' }));
  addNode(node('terminal-partial', 'Partial completion', 'terminal', 'system', { terminal_status: 'partial' }));
  addNode(node('terminal-failed', 'Failed completion', 'terminal', 'system', { terminal_status: 'failed' }));

  let firstWork;
  const researchIds = [];
  if (r.post_approval_route === 'research') {
    for (let index = 0; index < r.research_fanout; index += 1) {
      const id = `research-${String(index + 1).padStart(2, '0')}`;
      const workstream = profile.research_workstreams[index] ?? `Research shard ${index + 1}`;
      researchIds.push(id);
      addNode(node(id, workstream, 'research', 'researcher', {
        max_attempts: 2,
        agent_type: agent('research'),
        model_tier: r.model_tiers.research,
        tool_policy: ['proofgraph', 'web_search', 'workspace_read'],
        dynamic: true,
        metadata: { shard_index: index + 1, shard_count: r.research_fanout, workstream },
      }));
    }
    firstWork = researchIds;
  } else if (r.post_approval_route === 'plan') firstWork = ['plan'];
  else firstWork = ['direct'];

  if (r.post_approval_route === 'direct') {
    addNode(node('direct', 'Direct low-complexity execution', 'direct', 'direct', {
      max_attempts: 2,
      agent_type: agent('direct'),
      model_tier: r.model_tiers.direct,
      tool_policy: ['proofgraph', 'workspace_read'],
    }));
  }
  addNode(node('plan', 'Plan requirements, implementation, and acceptance criteria', 'plan', 'planner', {
    max_attempts: r.max_iterations,
    join: researchIds.length ? 'all' : 'any',
    agent_type: agent('plan'),
    model_tier: r.model_tiers.plan,
    tool_policy: ['proofgraph', 'workspace_read'],
    metadata: {
      ...(researchIds.length ? { join_from: researchIds } : {}),
      dynamic_join_node_id: 'develop',
      implementation_workstreams: profile.implementation_workstreams,
      deliverables: profile.deliverables,
      acceptance_tests: profile.acceptance_tests,
      non_goals: profile.non_goals,
    },
  }));
  addNode(node('develop', 'Produce an auditable implementation artifact', 'develop', 'developer', {
    max_attempts: r.max_iterations,
    agent_type: agent('develop'),
    model_tier: r.model_tiers.develop,
    tool_policy: ['proofgraph', 'workspace_read'],
    metadata: {
      mutation_mode: 'artifact_only',
      implementation_workstreams: profile.implementation_workstreams,
      deliverables: profile.deliverables,
      non_goals: profile.non_goals,
    },
  }));
  addNode(node('verify', `${r.verification_strength} independent verification`, 'verify', 'verifier', {
    max_attempts: r.max_iterations + 1,
    agent_type: agent('verify', r.verification_strength),
    model_tier: r.model_tiers.verify,
    tool_policy: ['proofgraph', 'workspace_read', ...(signals.requires_research ? ['web_search'] : [])],
    metadata: {
      verification_strength: r.verification_strength,
      acceptance_tests: profile.acceptance_tests,
      deliverables: profile.deliverables,
    },
  }));
  addNode(node('synthesize', 'Synthesize verified outputs', 'synthesize', 'synthesizer', {
    agent_type: agent('synthesize'),
    model_tier: r.model_tiers.synthesize,
    metadata: { deliverables: profile.deliverables, non_goals: profile.non_goals },
  }));

  if (r.human_approval_required) {
    addNode(node('human-gate', 'Human approval for high-risk execution', 'human_approval', 'human', {
      risk: signals.risk,
      approval_required: true,
      metadata: { reason: 'High-risk, sensitive, externally acting, or irreversible work requires explicit approval.' },
    }));
    addEdge('e-triage-human', 'triage', 'human-gate', 'route', 'human', 100);
    for (const target of firstWork) addEdge(`e-human-${target}`, 'human-gate', target, 'approval', 'approved', 100);
    addEdge('e-human-denied', 'human-gate', 'terminal-failed', 'approval', 'denied', 100);
  } else {
    for (const target of firstWork) addEdge(`e-triage-${target}`, 'triage', target, 'route', r.initial_route, 100);
  }

  if (researchIds.length) {
    for (const id of researchIds) {
      addEdge(`e-${id}-plan`, id, 'plan', 'outcome', 'success', 100);
      addEdge(`e-${id}-partial`, id, 'terminal-partial', 'outcome', 'blocked', 100);
      addEdge(`e-${id}-failed`, id, 'terminal-partial', 'outcome', 'failed', 10);
    }
  }
  if (r.post_approval_route === 'direct') {
    addEdge('e-direct-verify', 'direct', 'verify', 'outcome', 'success', 100);
    addEdge('e-direct-plan', 'direct', 'plan', 'failure_type', 'implementation_error', 100);
    addEdge('e-direct-partial', 'direct', 'terminal-partial', 'outcome', 'blocked', 100);
  }
  addEdge('e-plan-develop', 'plan', 'develop', 'outcome', 'success', 100);
  if (researchIds.length) {
    for (const id of researchIds) addEdge(`e-plan-evidence-${id}`, 'plan', id, 'failure_type', 'evidence_gap', 100);
  } else addEdge('e-plan-evidence-develop', 'plan', 'develop', 'failure_type', 'evidence_gap', 100);
  addEdge('e-plan-security', 'plan', r.human_approval_required ? 'human-gate' : 'terminal-failed', 'failure_type', 'security_risk', 100);
  addEdge('e-plan-partial', 'plan', 'terminal-partial', 'outcome', 'blocked', 100);

  addEdge('e-develop-verify', 'develop', 'verify', 'outcome', 'success', 100);
  addEdge('e-develop-plan-design', 'develop', 'plan', 'failure_type', 'design_error', 100);
  addEdge('e-develop-plan-requirements', 'develop', 'plan', 'failure_type', 'requirements_error', 100);
  addEdge('e-develop-security', 'develop', r.human_approval_required ? 'human-gate' : 'terminal-failed', 'failure_type', 'security_risk', 100);
  addEdge('e-develop-partial', 'develop', 'terminal-partial', 'outcome', 'blocked', 100);

  addEdge('e-verify-pass', 'verify', 'synthesize', 'verification', 'passed', 100);
  addEdge('e-verify-implementation', 'verify', 'develop', 'failure_type', 'implementation_error', 100);
  addEdge('e-verify-design', 'verify', 'plan', 'failure_type', 'design_error', 100);
  addEdge('e-verify-requirements', 'verify', 'plan', 'failure_type', 'requirements_error', 100);
  if (researchIds.length) {
    for (const id of researchIds) addEdge(`e-verify-evidence-${id}`, 'verify', id, 'failure_type', 'evidence_gap', 100);
  } else addEdge('e-verify-evidence-plan', 'verify', 'plan', 'failure_type', 'evidence_gap', 100);
  addEdge('e-verify-self', 'verify', 'plan', 'failure_type', 'verification_error', 100);
  addEdge('e-verify-security', 'verify', r.human_approval_required ? 'human-gate' : 'terminal-failed', 'failure_type', 'security_risk', 100);
  addEdge('e-verify-budget', 'verify', 'terminal-partial', 'failure_type', 'budget_exceeded', 100);
  addEdge('e-verify-unknown', 'verify', 'plan', 'failure_type', 'unknown', 20);
  addEdge('e-verify-blocked', 'verify', 'terminal-partial', 'outcome', 'blocked', 100);

  addEdge('e-synthesize-success', 'synthesize', 'terminal-success', 'outcome', 'success', 100);
  addEdge('e-synthesize-partial', 'synthesize', 'terminal-partial', 'outcome', 'blocked', 100);
  addEdge('e-synthesize-failed', 'synthesize', 'terminal-partial', 'outcome', 'failed', 100);

  const graph = {
    schema_version: 1,
    graph_id: graphId,
    name: `ProofGraph dynamic workflow (${assessment.mode})`,
    objective,
    entry_node: 'triage',
    nodes,
    edges,
    limits: {
      max_steps: clamp(nodes.length * (r.max_iterations + 3), 20, 500),
      max_route_visits: r.max_iterations + 1,
      max_dynamic_nodes: r.max_dynamic_nodes,
      max_parallel_nodes: r.max_parallel_nodes,
      max_iterations: r.max_iterations,
    },
    policy: {
      require_verification_for_success: true,
      require_human_for_high_risk: true,
      allow_workspace_mutation: false,
      allow_shell: false,
    },
    metadata: {
      generated: true,
      compiler_version: VERSION,
      assessment,
      profile,
      artifact_only_development: true,
    },
    compiler: {
      name: 'proofgraph-deterministic-compiler',
      version: VERSION,
      input_digest: sha256(JSON.stringify(input)),
    },
  };
  const validated = validateGraphSpec(graph);
  return {
    ok: true,
    assessment,
    graph: validated.spec,
    graph_digest: validated.digest,
    validation: validated.analysis,
    warnings: [
      ...(signals.heuristic_fields.length ? [`Heuristic assessment fields: ${signals.heuristic_fields.join(', ')}`] : []),
      'Development nodes emit auditable artifacts only; the default compiler does not grant write or shell capabilities.',
      'Model tiers are routing recommendations and remain subject to the selected adapter, model availability, and account policy.',
    ],
  };
}
