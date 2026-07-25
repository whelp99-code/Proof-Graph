import { compileDynamicGraph } from '../../server/lib/graph-compiler.mjs';
import { ValidationError } from '../../server/lib/errors.mjs';
import { validateGraphSpec } from '../../server/lib/graph-spec.mjs';
import { assertFiniteJson, rejectUnknownKeys, stringValue } from '../../server/lib/validate.mjs';
import { inspectRun } from '../debugger/inspector.mjs';

const objectOutput = { type: 'object', additionalProperties: true };
function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const string = { type: 'string' };

const TOOLS = Object.freeze([
  { name: 'proofgraph_compile', description: 'Compile a natural-language engineering objective into a validated dynamic GraphSpec.', inputSchema: schema({ objective: string, template: string, mode: { enum: ['auto', 'research', 'build', 'review'] }, signals: { type: 'object' }, constraints: { type: 'object' } }, ['objective']), outputSchema: objectOutput },
  { name: 'proofgraph_graph_validate', description: 'Validate a reviewed explicit GraphSpec, including topology and security invariants.', inputSchema: schema({ graph: { type: 'object' } }, ['graph']), outputSchema: objectOutput },
  { name: 'proofgraph_graph_start', description: 'Validate and persist an explicit GraphSpec without executing worker nodes.', inputSchema: schema({ graph: { type: 'object' }, runtime_policy: { type: 'object' } }, ['graph']), outputSchema: objectOutput },
  { name: 'proofgraph_graph_run', description: 'Validate and execute an explicit GraphSpec through the configured adapter routing.', inputSchema: schema({ graph: { type: 'object' }, runtime_policy: { type: 'object' }, adapter: string, max_rounds: { type: 'integer', minimum: 1, maximum: 5000 } }, ['graph']), outputSchema: objectOutput },
  { name: 'proofgraph_start', description: 'Compile and persist a graph without executing worker nodes, enabling breakpoints and operator inspection before resume.', inputSchema: schema({ objective: string, template: string, mode: { enum: ['auto', 'research', 'build', 'review'] }, signals: { type: 'object' }, constraints: { type: 'object' } }, ['objective']), outputSchema: objectOutput },
  { name: 'proofgraph_run', description: 'Compile and execute a graph through the configured adapter routing.', inputSchema: schema({ objective: string, template: string, mode: { enum: ['auto', 'research', 'build', 'review'] }, signals: { type: 'object' }, constraints: { type: 'object' }, adapter: string, max_rounds: { type: 'integer', minimum: 1, maximum: 5000 } }, ['objective']), outputSchema: objectOutput },
  { name: 'proofgraph_resume', description: 'Resume an existing graph run.', inputSchema: schema({ run_id: string, adapter: string, max_rounds: { type: 'integer', minimum: 1, maximum: 5000 } }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_status', description: 'Read verified graph state and node status.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_report', description: 'Read a finalized or in-progress graph report.', inputSchema: schema({ run_id: string, format: { enum: ['json', 'markdown'] } }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_integrity', description: 'Verify graph state, event, report, and artifact integrity.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_approve', description: 'Resolve a graph human-approval gate using its challenge.', inputSchema: schema({ run_id: string, approval_id: string, challenge: string, decision: { enum: ['approved', 'denied'] }, comment: string }, ['run_id', 'approval_id', 'challenge', 'decision']), outputSchema: objectOutput },
  { name: 'proofgraph_adapters', description: 'Return configured adapter availability and live-canary status.', inputSchema: schema(), outputSchema: objectOutput },
  { name: 'proofgraph_templates', description: 'List graph templates or inspect one template.', inputSchema: schema({ name: string }), outputSchema: objectOutput },
  { name: 'proofgraph_debug', description: 'Pause, resume, single-step, or manage graph breakpoints.', inputSchema: schema({ run_id: string, command: { enum: ['status', 'pause', 'resume', 'step', 'break', 'clear', 'bypass'] }, type: { enum: ['node', 'kind'] }, value: string, reason: string }, ['run_id', 'command']), outputSchema: objectOutput },
  { name: 'proofgraph_inspect', description: 'Inspect verified graph, event, debugger, and workspace state.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_status', description: 'Read approval-gated worktree state.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_propose', description: 'Propose typed workspace actions; returns an approval challenge without executing them.', inputSchema: schema({ run_id: string, node_id: string, actions: { type: 'array' } }, ['run_id', 'actions']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_decide', description: 'Approve or deny a workspace proposal using its challenge.', inputSchema: schema({ run_id: string, challenge: string, decision: { enum: ['approved', 'denied'] } }, ['run_id', 'challenge', 'decision']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_execute', description: 'Execute an already approved workspace proposal in its disposable worktree.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_diff', description: 'Read the current disposable worktree diff.', inputSchema: schema({ run_id: string }, ['run_id']), outputSchema: objectOutput },
  { name: 'proofgraph_workspace_rollback', description: 'Rollback all disposable worktree changes.', inputSchema: schema({ run_id: string, reason: string }, ['run_id']), outputSchema: objectOutput },
]);

function cleanCompileInput(platform, args) {
  rejectUnknownKeys(args, ['objective', 'template', 'mode', 'signals', 'constraints', 'adapter', 'max_rounds'], 'arguments');
  const base = { objective: stringValue(args.objective, 'objective', { min: 10, max: 10000 }), mode: args.mode ?? 'auto', ...(args.signals ? { signals: args.signals } : {}), ...(args.constraints ? { constraints: args.constraints } : {}) };
  const matched = args.template ? null : platform.templates.match(base.objective);
  const selectedTemplate = args.template ?? matched?.name;
  if (!selectedTemplate) return { input: base, template: null };
  const applied = platform.templates.apply(selectedTemplate, base);
  const { template, ...input } = applied;
  return {
    input,
    template: {
      ...template,
      selection: args.template ? 'explicit' : 'auto',
      ...(matched ? { matched_keyword: matched.keyword } : {}),
    },
  };
}

function requireWorkspace(platform) {
  if (!platform.workspace) throw new ValidationError('Workspace Engine is disabled in proofgraph.config.json');
  return platform.workspace;
}

export function listPlatformTools() { return structuredClone(TOOLS); }

export async function invokePlatformTool(name, args, platform) {
  if (!TOOLS.some((tool) => tool.name === name)) throw new ValidationError(`Unknown platform tool: ${name}`);
  const input = args ?? {};
  assertFiniteJson(input);
  if (name === 'proofgraph_compile') {
    const { input: compileInput, template } = cleanCompileInput(platform, input);
    return { ...compileDynamicGraph(compileInput), template };
  }
  if (name === 'proofgraph_graph_validate') {
    rejectUnknownKeys(input, ['graph'], 'arguments');
    const validated = validateGraphSpec(input.graph);
    return { ok: true, graph_digest: validated.digest, validation: validated.analysis, graph: validated.spec };
  }
  if (name === 'proofgraph_graph_start') {
    rejectUnknownKeys(input, ['graph', 'runtime_policy'], 'arguments');
    const validated = validateGraphSpec(input.graph);
    return { ...(await platform.kernel.startGraph(validated.spec, input.runtime_policy)), graph_digest: validated.digest, validation: validated.analysis };
  }
  if (name === 'proofgraph_graph_run') {
    rejectUnknownKeys(input, ['graph', 'runtime_policy', 'adapter', 'max_rounds'], 'arguments');
    const validated = validateGraphSpec(input.graph);
    const result = await platform.kernel.runGraph(validated.spec, {
      runtimePolicy: input.runtime_policy,
      adapter: input.adapter ?? platform.config.default_adapter,
      maxRounds: input.max_rounds,
    });
    return { ...result, graph_digest: validated.digest, validation: validated.analysis };
  }
  if (name === 'proofgraph_start') {
    const { input: runInput, template } = cleanCompileInput(platform, input);
    return { ...(await platform.kernel.start(runInput)), template };
  }
  if (name === 'proofgraph_run') {
    const { input: runInput, template } = cleanCompileInput(platform, input);
    const result = await platform.kernel.run(runInput, { adapter: input.adapter ?? platform.config.default_adapter, maxRounds: input.max_rounds });
    return { ...result, template };
  }
  if (name === 'proofgraph_resume') {
    rejectUnknownKeys(input, ['run_id', 'adapter', 'max_rounds'], 'arguments');
    return platform.kernel.resume(input.run_id, { adapter: input.adapter ?? platform.config.default_adapter, maxRounds: input.max_rounds });
  }
  if (name === 'proofgraph_status') { rejectUnknownKeys(input, ['run_id'], 'arguments'); return platform.kernel.status(input.run_id); }
  if (name === 'proofgraph_report') { rejectUnknownKeys(input, ['run_id', 'format'], 'arguments'); return platform.kernel.report(input.run_id, input.format ?? 'json'); }
  if (name === 'proofgraph_integrity') { rejectUnknownKeys(input, ['run_id'], 'arguments'); return platform.kernel.integrity(input.run_id); }
  if (name === 'proofgraph_approve') {
    rejectUnknownKeys(input, ['run_id', 'approval_id', 'challenge', 'decision', 'comment'], 'arguments');
    return platform.kernel.approve(input.run_id, { actor: 'human', approval_id: input.approval_id, challenge: input.challenge, decision: input.decision, decision_source: 'external_human', comment: input.comment ?? 'Explicit MCP decision' });
  }
  if (name === 'proofgraph_adapters') { rejectUnknownKeys(input, [], 'arguments'); return { ok: true, adapters: await platform.registry.doctor() }; }
  if (name === 'proofgraph_templates') { rejectUnknownKeys(input, ['name'], 'arguments'); return { ok: true, templates: input.name ? [platform.templates.get(input.name)] : platform.templates.list() }; }
  if (name === 'proofgraph_debug') {
    rejectUnknownKeys(input, ['run_id', 'command', 'type', 'value', 'reason'], 'arguments');
    if (input.command === 'status') return platform.debuggerController.read(input.run_id);
    if (input.command === 'bypass') return platform.debuggerController.bypassBreakpointOnce(input.run_id, input.value);
    return platform.debuggerController.command(input.run_id, input.command, { type: input.type, value: input.value, reason: input.reason, actor: 'mcp-operator' });
  }
  if (name === 'proofgraph_inspect') {
    rejectUnknownKeys(input, ['run_id'], 'arguments');
    return inspectRun({ dataDir: platform.config.data_dir, projectDir: platform.config.project_dir, runId: input.run_id, debuggerController: platform.debuggerController, workspace: platform.workspace });
  }
  const workspace = requireWorkspace(platform);
  if (name === 'proofgraph_workspace_status') { rejectUnknownKeys(input, ['run_id'], 'arguments'); return workspace.readState(input.run_id); }
  if (name === 'proofgraph_workspace_propose') {
    rejectUnknownKeys(input, ['run_id', 'node_id', 'actions'], 'arguments');
    return workspace.proposeActions({ run_id: input.run_id, node: { node_id: input.node_id ?? 'mcp', kind: 'develop' }, actions: input.actions });
  }
  if (name === 'proofgraph_workspace_decide') { rejectUnknownKeys(input, ['run_id', 'challenge', 'decision'], 'arguments'); return workspace.decide(input.run_id, input.challenge, input.decision, 'human-mcp'); }
  if (name === 'proofgraph_workspace_execute') { rejectUnknownKeys(input, ['run_id'], 'arguments'); return workspace.executeApproved(input.run_id); }
  if (name === 'proofgraph_workspace_diff') { rejectUnknownKeys(input, ['run_id'], 'arguments'); return { ok: true, run_id: input.run_id, diff: await workspace.diff(input.run_id) }; }
  if (name === 'proofgraph_workspace_rollback') { rejectUnknownKeys(input, ['run_id', 'reason'], 'arguments'); return workspace.rollback(input.run_id, { reason: input.reason ?? 'MCP rollback' }); }
  throw new ValidationError(`Unhandled platform tool: ${name}`);
}
