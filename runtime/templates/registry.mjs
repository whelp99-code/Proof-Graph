import { ValidationError } from '../../server/lib/errors.mjs';
import { arrayValue, assertFiniteJson, assertPlainObject, rejectUnknownKeys, stringValue } from '../../server/lib/validate.mjs';

const BUILT_INS = Object.freeze({
  feature: {
    name: 'feature',
    title: 'Feature development',
    description: 'Research, plan, implement, and independently verify a new product feature.',
    mode: 'build',
    signals: { complexity: 70, uncertainty: 45, risk: 'medium', requires_research: true, requires_implementation: true, estimated_subtasks: 5, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 4, max_iterations: 4, max_dynamic_nodes: 20 },
    success_contract: ['requirements traced to implementation', 'tests and regression risks identified', 'independent verification passed'],
  },
  bugfix: {
    name: 'bugfix',
    title: 'Bug diagnosis and repair',
    description: 'Reproduce, diagnose, patch, and verify a software defect with bounded retry.',
    mode: 'build',
    signals: { complexity: 55, uncertainty: 40, risk: 'medium', requires_research: false, requires_implementation: true, estimated_subtasks: 3, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 3, max_iterations: 4, max_dynamic_nodes: 12 },
    success_contract: ['failure reproduced or evidence recorded', 'root cause identified', 'fix and regression checks verified'],
  },
  refactor: {
    name: 'refactor',
    title: 'Behavior-preserving refactor',
    description: 'Plan and execute a behavior-preserving refactor with rollback and regression verification.',
    mode: 'build',
    signals: { complexity: 75, uncertainty: 35, risk: 'medium', requires_research: false, requires_implementation: true, estimated_subtasks: 6, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 4, max_iterations: 4, max_dynamic_nodes: 24 },
    success_contract: ['public behavior preserved', 'migration boundaries explicit', 'regression verification passed'],
  },
  'security-audit': {
    name: 'security-audit',
    title: 'Security audit',
    description: 'Inspect attack surfaces, collect evidence, reproduce findings safely, and require human review for risky actions.',
    mode: 'review',
    signals: { complexity: 80, uncertainty: 65, risk: 'high', requires_research: true, requires_implementation: false, estimated_subtasks: 6, user_approval_required: true, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 5, max_iterations: 3, max_dynamic_nodes: 24 },
    success_contract: ['findings tied to evidence', 'false positives challenged', 'risky actions remain approval-gated'],
  },
  migration: {
    name: 'migration',
    title: 'Software migration',
    description: 'Research compatibility, plan staged changes, produce migration artifacts, and verify rollback paths.',
    mode: 'build',
    signals: { complexity: 90, uncertainty: 70, risk: 'high', reversibility: 'partially_reversible', requires_research: true, requires_implementation: true, estimated_subtasks: 8, user_approval_required: true, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 6, max_iterations: 5, max_dynamic_nodes: 32 },
    success_contract: ['compatibility evidence collected', 'staged rollback plan exists', 'migration verification passed'],
  },
  research: {
    name: 'research',
    title: 'Evidence-driven engineering research',
    description: 'Fan out primary-source research, reconcile conflicts, and synthesize a verified engineering decision.',
    mode: 'research',
    signals: { complexity: 60, uncertainty: 80, risk: 'low', requires_research: true, requires_implementation: false, estimated_subtasks: 5, verification_strength: 'deep' },
    constraints: { max_parallel_nodes: 6, max_iterations: 3, max_dynamic_nodes: 20 },
    success_contract: ['primary sources distinguished from commentary', 'conflicts and unknowns preserved', 'claims independently verified'],
  },
  'agent-tui': {
    name: 'agent-tui',
    title: 'AI agent operator TUI',
    description: 'Design, implement, and independently verify a keyboard-first terminal UI for operating AI agents and dynamic graphs.',
    mode: 'build',
    match_keywords: [
      'ai agent tui', 'agent tui', 'ai 에이전트 tui', 'ai에이전트 tui', '에이전트 tui',
      'ai 에인전트 tui', 'ai에인전트 tui', '에인전트 tui',
      'terminal agent ui', 'terminal ui for agents', '터미널 에이전트 ui',
    ],
    signals: {
      complexity: 85,
      uncertainty: 55,
      risk: 'medium',
      requires_research: true,
      requires_implementation: true,
      estimated_subtasks: 8,
      verification_strength: 'deep',
    },
    constraints: { max_parallel_nodes: 6, max_iterations: 5, max_dynamic_nodes: 32 },
    research_workstreams: [
      'Operator jobs, user flows, and information architecture for runs, graphs, agents, approvals, and evidence',
      'Cross-platform terminal rendering, keyboard input, resize handling, accessibility, and graceful shutdown',
      'ProofGraph runtime integration, event/state synchronization, adapter boundaries, and reconnect behavior',
      'Safety UX for approvals, failures, retries, cancellation, budgets, and integrity warnings',
      'Packaging and compatibility across macOS, Linux, Windows Terminal, and SSH sessions',
      'Testing strategy for reducers, rendering snapshots, keyboard commands, and non-interactive CI',
    ],
    implementation_workstreams: [
      'State model and deterministic reducer for runs, graph nodes, agents, approvals, and events',
      'Terminal renderer with responsive panes, focus management, status indicators, and compact fallback layout',
      'Keyboard command router for navigation, pause, resume, single-step, abort, approve, deny, and help',
      'ProofGraph client boundary supporting mock fixtures first and CLI/MCP integration behind an interface',
      'Event log, node inspector, failure packet viewer, and approval queue',
      'Automated tests, snapshot mode, demo fixtures, packaging, and operator documentation',
    ],
    deliverables: [
      'Runnable AI agent TUI executable with a deterministic demo mode',
      'Architecture and state/event contracts',
      'Keyboard map and operator flows',
      'Unit, integration, rendering snapshot, and failure-path tests',
      'Installation, operation, troubleshooting, and security documentation',
    ],
    acceptance_tests: [
      'The TUI starts and exits without leaving the terminal in raw mode',
      'Runs, graph nodes, agents, approvals, failures, and events remain visible at narrow and wide terminal sizes',
      'Pause, resume, single-step, abort, approve, and deny commands update state deterministically; automatic failure reroutes remain visible',
      'Non-interactive snapshot mode runs in CI without a TTY',
      'Disconnects, malformed events, unknown states, and integrity failures are rendered without crashing',
      'No unrestricted shell or workspace mutation is available from the TUI by default',
    ],
    non_goals: [
      'A full desktop GUI',
      'Unattended production deployment or unrestricted command execution',
      'Embedding provider credentials in the TUI',
    ],
    success_contract: [
      'operator flows are mapped to explicit graph and agent state transitions',
      'a runnable keyboard-first TUI and deterministic demo are delivered',
      'failure, approval, cancellation, resize, and terminal restoration paths are independently verified',
    ],
  },
});

function clone(value) { return structuredClone(value); }
function stringList(value, name, max = 32) {
  return arrayValue(value ?? [], name, { min: 0, max })
    .map((item, index) => stringValue(item, `${name}[${index}]`, { min: 1, max: 1000 }));
}
function merge(base, overlay) {
  if (overlay === undefined) return clone(base);
  if (!base || typeof base !== 'object' || Array.isArray(base) || !overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return clone(overlay);
  const out = clone(base);
  for (const [key, value] of Object.entries(overlay)) out[key] = merge(out[key], value);
  return out;
}

export class TemplateRegistry {
  constructor(extra = {}) {
    assertPlainObject(extra, 'templates');
    assertFiniteJson(extra);
    this.templates = new Map();
    for (const template of Object.values(BUILT_INS)) this.register(template.name, template, { builtIn: true });
    for (const [name, template] of Object.entries(extra)) this.register(name, template, { builtIn: false });
  }

  register(name, template, metadata = {}) {
    const id = stringValue(name, 'template name', { min: 1, max: 64 });
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new ValidationError('Template name must use lowercase letters, numbers, and hyphens');
    assertPlainObject(template, `template.${id}`);
    rejectUnknownKeys(template, [
      'name', 'title', 'description', 'mode', 'signals', 'constraints',
      'match_keywords', 'research_workstreams', 'implementation_workstreams',
      'deliverables', 'acceptance_tests', 'non_goals', 'success_contract',
    ], `template.${id}`);
    assertFiniteJson(template);
    const normalized = {
      name: id,
      title: stringValue(template.title ?? id, `template.${id}.title`, { min: 1, max: 120 }),
      description: stringValue(template.description ?? id, `template.${id}.description`, { min: 1, max: 1000 }),
      mode: template.mode ?? 'auto',
      signals: clone(template.signals ?? {}),
      constraints: clone(template.constraints ?? {}),
      match_keywords: stringList(template.match_keywords, `template.${id}.match_keywords`, 32).map((item) => item.toLowerCase()),
      research_workstreams: stringList(template.research_workstreams, `template.${id}.research_workstreams`),
      implementation_workstreams: stringList(template.implementation_workstreams, `template.${id}.implementation_workstreams`),
      deliverables: stringList(template.deliverables, `template.${id}.deliverables`),
      acceptance_tests: stringList(template.acceptance_tests, `template.${id}.acceptance_tests`),
      non_goals: stringList(template.non_goals, `template.${id}.non_goals`),
      success_contract: stringList(template.success_contract, `template.${id}.success_contract`),
      built_in: metadata.builtIn === true,
    };
    this.templates.set(id, Object.freeze(normalized));
    return clone(normalized);
  }

  list() { return [...this.templates.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name)); }

  get(name) {
    const template = this.templates.get(String(name));
    if (!template) throw new ValidationError(`Unknown graph template: ${String(name)}`, { available: [...this.templates.keys()].sort() });
    return clone(template);
  }

  match(objective) {
    const text = stringValue(objective, 'objective', { min: 1, max: 10000 }).toLowerCase();
    const candidates = [];
    for (const template of this.templates.values()) {
      for (const keyword of template.match_keywords) {
        if (text.includes(keyword)) candidates.push({ name: template.name, keyword, score: keyword.length });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.keyword.localeCompare(b.keyword));
    return candidates.length ? clone(candidates[0]) : null;
  }

  apply(name, input) {
    assertPlainObject(input, 'template input');
    rejectUnknownKeys(input, ['objective', 'mode', 'signals', 'constraints'], 'template input');
    const template = this.get(name);
    const objective = stringValue(input.objective, 'objective', { min: 10, max: 10000 });
    const sections = [
      ['Template research workstreams', template.research_workstreams],
      ['Template implementation workstreams', template.implementation_workstreams],
      ['Template deliverables', template.deliverables],
      ['Template acceptance tests', template.acceptance_tests],
      ['Template non-goals', template.non_goals],
      ['Template success contract', template.success_contract],
    ].filter(([, items]) => items.length)
      .map(([title, items]) => `\n\n${title}:\n${items.map((item) => `- ${item}`).join('\n')}`)
      .join('');
    return {
      objective: `${objective}${sections}`,
      mode: input.mode ?? template.mode,
      signals: merge(template.signals, input.signals ?? {}),
      constraints: merge(template.constraints, input.constraints ?? {}),
      profile: {
        template_name: template.name,
        research_workstreams: clone(template.research_workstreams),
        implementation_workstreams: clone(template.implementation_workstreams),
        deliverables: clone(template.deliverables),
        acceptance_tests: clone(template.acceptance_tests),
        non_goals: clone(template.non_goals),
      },
      template: {
        name: template.name,
        title: template.title,
        built_in: template.built_in,
      },
    };
  }
}

export function createTemplateRegistry(extra = {}) { return new TemplateRegistry(extra); }
