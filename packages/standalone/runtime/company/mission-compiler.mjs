import { deterministicId, sha256, deepFreeze } from '../core/canonical.mjs';
import { ExecutiveManager } from '../organization/executive-manager.mjs';

function incomingDependencies(blueprint, stageId) {
  return blueprint.edges
    .filter((edge) => edge.to === stageId && !['implementation_error', 'design_or_requirements_error', 'evidence_gap', 'denied'].includes(edge.condition))
    .map((edge) => edge.from);
}

export function compileMission(input, options = {}) {
  const executive = options.executiveManager ?? new ExecutiveManager(options);
  const compiled = executive.compile(input);
  const { task, organization, plan } = compiled;
  const missionId = deterministicId('mission', { task_id: task.task_id, organization_id: organization.organization_id });
  const projectId = `${missionId}:project-main`;
  const sprintId = `${missionId}:sprint-01`;
  const includedStages = task.blueprint.stages.filter((stage) => !['terminal'].includes(stage.kind));
  const stageToItem = new Map(includedStages.map((stage) => [stage.stage_id, `${missionId}:work:${stage.stage_id}`]));
  const workItems = includedStages.map((stage, index) => ({
    work_item_id: stageToItem.get(stage.stage_id),
    stage_id: stage.stage_id,
    kind: stage.kind,
    objective: `${stage.kind}: ${task.objective}`,
    assigned_role_id: plan.workstreams.find((item) => item.stage_id === stage.stage_id)?.assigned_role_id
      ?? executive.selectRole(organization, stage.role),
    dependencies: incomingDependencies(task.blueprint, stage.stage_id).filter((id) => stageToItem.has(id)).map((id) => stageToItem.get(id)),
    status: stage.kind === 'triage' ? 'completed' : 'pending',
    attempts: stage.kind === 'triage' ? 1 : 0,
    max_attempts: stage.max_attempts ?? 1,
    join: stage.join ?? 'any',
    approval_required: stage.approval_required === true,
    sequence: index + 1,
    run_ids: [],
    output: stage.kind === 'triage' ? { route: task.requires_research ? 'research' : task.requires_implementation ? 'plan' : 'direct' } : null,
    failure: null,
  }));
  const mission = {
    schema_version: 1,
    mission_id: missionId,
    title: options.title ?? `Mission: ${task.objective.slice(0, 120)}`,
    objective: task.objective,
    task,
    organization,
    executive_plan: plan,
    projects: [{ project_id: projectId, name: 'Primary Mission Project', status: 'planned' }],
    sprints: [{ sprint_id: sprintId, project_id: projectId, name: 'Execution Sprint 1', status: 'planned' }],
    work_items: workItems.map((item) => ({ ...item, project_id: projectId, sprint_id: sprintId })),
    policy: {
      max_ticks: options.max_ticks ?? Math.min(500, task.blueprint.limits.max_steps * 2),
      max_parallel: options.max_parallel ?? task.blueprint.limits.max_parallel,
      max_failures: options.max_failures ?? Math.max(3, task.estimated_subtasks),
      external_effects_require_approval: true,
      self_modification_allowed: false,
    },
  };
  mission.digest = sha256(mission);
  return deepFreeze(mission);
}
