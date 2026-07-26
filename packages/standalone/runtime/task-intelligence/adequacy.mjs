import { sha256 } from '../core/canonical.mjs';
import { ValidationError } from '../core/errors.mjs';

const CONDITIONS = new Set(['success', 'approved_or_success', 'verification_passed', 'implementation_error', 'design_or_requirements_error', 'evidence_gap', 'budget_or_attempts_exhausted', 'critical_failure', 'denied']);

export function validateGraphAdequacy(taskSpec, blueprint = taskSpec.blueprint) {
  if (!blueprint || !Array.isArray(blueprint.stages) || !Array.isArray(blueprint.edges)) throw new ValidationError('Graph blueprint is required');
  const stages = new Map(blueprint.stages.map((stage) => [stage.stage_id, stage]));
  if (stages.size !== blueprint.stages.length) throw new ValidationError('Graph blueprint contains duplicate stages');
  const issues = [];
  const hasKind = (kind) => blueprint.stages.some((stage) => stage.kind === kind);
  if (!hasKind('triage')) issues.push('missing_triage');
  if (!hasKind('verify')) issues.push('missing_verifier');
  if (!hasKind('terminal')) issues.push('missing_terminal');
  if (taskSpec.requires_research && !hasKind('research')) issues.push('research_required_but_missing');
  if (taskSpec.requires_implementation && (!hasKind('plan') || !hasKind('develop'))) issues.push('implementation_stages_missing');
  const approvalRequired = taskSpec.risk === 'high' || taskSpec.risk === 'critical' || taskSpec.external_effects || taskSpec.reversibility !== 'reversible';
  if (approvalRequired && !hasKind('human_approval')) issues.push('approval_required_but_missing');
  if (!Number.isSafeInteger(blueprint.limits?.max_steps) || blueprint.limits.max_steps < 1) issues.push('missing_step_bound');
  if (!Number.isSafeInteger(blueprint.limits?.max_iterations) || blueprint.limits.max_iterations < 1) issues.push('missing_iteration_bound');
  const adjacency = new Map([...stages.keys()].map((id) => [id, []]));
  for (const edge of blueprint.edges) {
    if (!stages.has(edge.from) || !stages.has(edge.to)) issues.push(`dangling_edge:${edge.from}->${edge.to}`);
    else adjacency.get(edge.from).push(edge);
    if (!CONDITIONS.has(edge.condition)) issues.push(`unknown_condition:${edge.condition}`);
    if (['implementation_error', 'design_or_requirements_error', 'evidence_gap'].includes(edge.condition) && edge.bounded !== true) issues.push(`unbounded_retry:${edge.from}->${edge.to}`);
  }
  const entry = blueprint.stages.find((stage) => stage.kind === 'triage')?.stage_id;
  const reachable = new Set();
  if (entry) {
    const queue = [entry];
    while (queue.length) {
      const id = queue.shift(); if (reachable.has(id)) continue; reachable.add(id);
      for (const edge of adjacency.get(id) ?? []) queue.push(edge.to);
    }
    for (const id of stages.keys()) if (!reachable.has(id)) issues.push(`unreachable_stage:${id}`);
  }
  const successTerminals = blueprint.stages.filter((stage) => stage.kind === 'terminal' && stage.terminal_status === 'success').map((stage) => stage.stage_id);
  if (!successTerminals.length) issues.push('missing_success_terminal');
  if (entry) {
    const visited = new Set();
    const queue = [{ id: entry, sawVerifier: stages.get(entry)?.kind === 'verify' }];
    while (queue.length) {
      const current = queue.shift();
      const key = `${current.id}:${current.sawVerifier}`; if (visited.has(key)) continue; visited.add(key);
      if (successTerminals.includes(current.id) && !current.sawVerifier) issues.push('success_path_bypasses_verifier');
      for (const edge of adjacency.get(current.id) ?? []) {
        if (['implementation_error', 'design_or_requirements_error', 'evidence_gap'].includes(edge.condition)) continue;
        queue.push({ id: edge.to, sawVerifier: current.sawVerifier || stages.get(edge.to)?.kind === 'verify' });
      }
    }
  }
  for (const deliverable of taskSpec.deliverables) {
    if (!taskSpec.acceptance_criteria.some((criterion) => criterion.toLowerCase().includes(deliverable.toLowerCase().split(/\s+/)[0]))) issues.push(`deliverable_without_acceptance:${deliverable}`);
  }
  const uniqueIssues = [...new Set(issues)];
  const result = {
    adequate: uniqueIssues.length === 0,
    issues: uniqueIssues,
    checks: {
      verifier_present: hasKind('verify'),
      approval_present_when_required: !approvalRequired || hasKind('human_approval'),
      research_present_when_required: !taskSpec.requires_research || hasKind('research'),
      implementation_present_when_required: !taskSpec.requires_implementation || (hasKind('plan') && hasKind('develop')),
      finite_limits: Number.isSafeInteger(blueprint.limits?.max_steps) && Number.isSafeInteger(blueprint.limits?.max_iterations),
      all_stages_reachable: stages.size === reachable.size,
      success_requires_verifier: !uniqueIssues.includes('success_path_bypasses_verifier'),
    },
  };
  result.digest = sha256(result);
  if (!result.adequate) throw new ValidationError(`Graph blueprint is inadequate: ${uniqueIssues.join(', ')}`, result);
  return result;
}
