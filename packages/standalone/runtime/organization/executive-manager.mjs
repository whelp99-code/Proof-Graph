import { compileTaskSpec } from '../task-intelligence/task-spec.mjs';
import { buildOrganization } from './builders.mjs';
import { sha256, deepFreeze } from '../core/canonical.mjs';

export class ExecutiveManager {
  constructor(options = {}) { this.options = options; }

  compile(input) {
    const task = input?.taskSpec ?? compileTaskSpec(input);
    const organization = buildOrganization(task, this.options.organization ?? {});
    const plan = {
      schema_version: 1,
      task_id: task.task_id,
      organization_id: organization.organization_id,
      executive_role_id: organization.governance.executive_role_id,
      workstreams: task.blueprint.stages.filter((stage) => !['triage', 'join', 'terminal'].includes(stage.kind)).map((stage, index) => ({
        order: index + 1,
        stage_id: stage.stage_id,
        kind: stage.kind,
        assigned_role_id: this.selectRole(organization, stage.role),
        depends_on: task.blueprint.edges.filter((edge) => edge.to === stage.stage_id).map((edge) => edge.from),
      })),
    };
    plan.digest = sha256(plan);
    return deepFreeze({ task, organization, plan });
  }

  selectRole(organization, roleName) {
    const mapping = {
      coordinator: 'executive', researcher: 'research', planner: 'planning', developer: 'engineering', verifier: 'quality',
      synthesizer: 'executive', direct: 'executive', human: 'human', system: 'executive',
    };
    const group = mapping[roleName] ?? roleName;
    return organization.roles.find((role) => role.independence_group === group && role.role_type !== 'manager')?.role_id
      ?? organization.roles.find((role) => role.independence_group === group)?.role_id
      ?? organization.governance.executive_role_id;
  }
}
