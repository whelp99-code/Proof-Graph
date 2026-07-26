import { deterministicId, sha256 } from '../core/canonical.mjs';

function stage(id, kind, role, extra = {}) {
  return { stage_id: id, kind, role, max_attempts: extra.max_attempts ?? 1, join: extra.join ?? 'any', approval_required: extra.approval_required ?? false, ...extra };
}

export function createGraphBlueprint(taskSpec) {
  const stages = [stage('triage', 'triage', 'coordinator')];
  const edges = [];
  let previous = 'triage';
  if (taskSpec.requires_research) {
    const count = Math.max(1, Math.min(6, Math.ceil(taskSpec.estimated_subtasks / 3)));
    for (let index = 1; index <= count; index += 1) {
      const id = `research-${String(index).padStart(2, '0')}`;
      stages.push(stage(id, 'research', 'researcher', { max_attempts: 2, join: 'all', shard_index: index, shard_count: count }));
      edges.push({ from: previous, to: id, condition: 'success' });
    }
    const join = 'research-join';
    stages.push(stage(join, 'join', 'coordinator', { join: 'all' }));
    for (let index = 1; index <= count; index += 1) edges.push({ from: `research-${String(index).padStart(2, '0')}`, to: join, condition: 'success' });
    previous = join;
  }
  if (taskSpec.risk === 'high' || taskSpec.risk === 'critical' || taskSpec.external_effects || taskSpec.reversibility !== 'reversible') {
    stages.push(stage('human-approval', 'human_approval', 'human', { approval_required: true }));
    edges.push({ from: previous, to: 'human-approval', condition: 'success' });
    previous = 'human-approval';
  }
  if (taskSpec.requires_implementation) {
    stages.push(stage('plan', 'plan', 'planner', { max_attempts: 3 }));
    edges.push({ from: previous, to: 'plan', condition: 'approved_or_success' });
    stages.push(stage('develop', 'develop', 'developer', { max_attempts: 4 }));
    edges.push({ from: 'plan', to: 'develop', condition: 'success' });
    previous = 'develop';
  } else {
    stages.push(stage('direct', 'direct', 'direct', { max_attempts: 2 }));
    edges.push({ from: previous, to: 'direct', condition: 'approved_or_success' });
    previous = 'direct';
  }
  stages.push(stage('verify', 'verify', 'verifier', { max_attempts: taskSpec.verification_strength === 'deep' ? 4 : 2 }));
  edges.push({ from: previous, to: 'verify', condition: 'success' });
  if (taskSpec.requires_implementation) {
    edges.push({ from: 'verify', to: 'develop', condition: 'implementation_error', bounded: true });
    edges.push({ from: 'verify', to: 'plan', condition: 'design_or_requirements_error', bounded: true });
  }
  if (taskSpec.requires_research) edges.push({ from: 'verify', to: 'research-01', condition: 'evidence_gap', bounded: true });
  stages.push(stage('synthesize', 'synthesize', 'synthesizer'));
  edges.push({ from: 'verify', to: 'synthesize', condition: 'verification_passed' });
  stages.push(stage('terminal-success', 'terminal', 'system', { terminal_status: 'success' }));
  stages.push(stage('terminal-partial', 'terminal', 'system', { terminal_status: 'partial' }));
  stages.push(stage('terminal-failed', 'terminal', 'system', { terminal_status: 'failed' }));
  edges.push({ from: 'synthesize', to: 'terminal-success', condition: 'success' });
  edges.push({ from: 'verify', to: 'terminal-partial', condition: 'budget_or_attempts_exhausted' });
  edges.push({ from: 'verify', to: 'terminal-failed', condition: 'critical_failure' });
  if (stages.some((item) => item.stage_id === 'human-approval')) edges.push({ from: 'human-approval', to: 'terminal-failed', condition: 'denied' });
  const blueprint = {
    schema_version: 1,
    blueprint_id: deterministicId('blueprint', { task_id: taskSpec.task_id, stages, edges }),
    task_id: taskSpec.task_id,
    stages,
    edges,
    limits: {
      max_steps: Math.min(200, 20 + taskSpec.estimated_subtasks * 8),
      max_parallel: Math.max(1, Math.min(8, Math.ceil(taskSpec.estimated_subtasks / 2))),
      max_iterations: taskSpec.risk === 'critical' ? 1 : taskSpec.verification_strength === 'deep' ? 4 : 3,
    },
  };
  blueprint.digest = sha256(blueprint);
  return blueprint;
}
