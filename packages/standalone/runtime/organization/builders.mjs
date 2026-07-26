import { deterministicId, sha256, deepFreeze } from '../core/canonical.mjs';
import { ValidationError } from '../core/errors.mjs';
import { CAPABILITY_REGISTRY, validateCapabilities } from './capabilities.mjs';
import { ORGANIZATION_SCHEMA_VERSION, budgetEnvelope } from './domain.mjs';

function splitBudget(total, weight, totalWeight) {
  return budgetEnvelope({
    calls: Math.max(1, Math.floor(total.calls * weight / totalWeight)),
    tokens: Math.max(1000, Math.floor(total.tokens * weight / totalWeight)),
    cost_micros: Math.max(0, Math.floor(total.cost_micros * weight / totalWeight)),
    wall_time_ms: Math.max(10_000, Math.floor(total.wall_time_ms * weight / totalWeight)),
  });
}

function role(spec) {
  return {
    role_id: spec.role_id,
    name: spec.name,
    role_type: spec.role_type,
    department_id: spec.department_id,
    team_id: spec.team_id ?? null,
    manager_role_id: spec.manager_role_id ?? null,
    purpose: spec.purpose,
    capabilities: validateCapabilities(spec.capabilities, { allowHumanOnly: spec.role_type === 'human', allowOperatorOnly: spec.role_type === 'human' }),
    delegable_capabilities: spec.role_type === 'human' ? [] : spec.capabilities.filter((capability) => CAPABILITY_REGISTRY[capability]?.delegable).sort(),
    budget: spec.budget,
    independence_group: spec.independence_group,
    can_delegate: Boolean(spec.can_delegate),
    model_eligible: spec.model_eligible !== false,
  };
}

export function buildOrganization(taskSpec, options = {}) {
  if (!taskSpec?.task_id) throw new ValidationError('TaskSpec is required');
  const organizationId = deterministicId('org', { task_id: taskSpec.task_id, policy: options.policy_version ?? 'organization.v1' });
  const totalBudget = budgetEnvelope({
    calls: options.calls ?? Math.max(20, taskSpec.estimated_subtasks * 10),
    tokens: options.tokens ?? Math.max(100_000, taskSpec.estimated_subtasks * 40_000),
    cost_micros: options.cost_micros ?? Math.max(1_000_000, taskSpec.estimated_subtasks * 500_000),
    wall_time_ms: options.wall_time_ms ?? Math.max(900_000, taskSpec.estimated_subtasks * 300_000),
  });
  const departmentDefs = [
    { id: 'executive', type: 'executive', name: 'Executive Office', weight: 1 },
    ...(taskSpec.requires_research ? [{ id: 'research', type: 'research', name: 'Research Department', weight: 2 }] : []),
    ...((taskSpec.requires_implementation || taskSpec.archetype === 'product') ? [{ id: 'product', type: 'product', name: 'Product and Planning', weight: 2 }] : []),
    ...(taskSpec.requires_implementation ? [{ id: 'engineering', type: 'engineering', name: 'Engineering Department', weight: 4 }] : []),
    { id: 'quality', type: 'quality', name: 'Independent Quality Office', weight: 2 },
    ...(['medium', 'high', 'critical'].includes(taskSpec.risk) ? [{ id: 'risk', type: 'risk', name: 'Risk and Security Office', weight: 2 }] : []),
    ...(taskSpec.external_effects ? [{ id: 'delivery', type: 'delivery', name: 'Delivery Operations', weight: 2 }] : []),
  ];
  const totalWeight = departmentDefs.reduce((sum, item) => sum + item.weight, 0);
  const departments = departmentDefs.map((item) => ({
    department_id: `${organizationId}:${item.id}`,
    type: item.type,
    name: item.name,
    purpose: `${item.name} responsibilities for task ${taskSpec.task_id}`,
    budget: splitBudget(totalBudget, item.weight, totalWeight),
    capability_ceiling: [],
  }));
  const byType = Object.fromEntries(departments.map((department) => [department.type, department]));
  const teams = [];
  const roles = [];
  const executiveDepartment = byType.executive;
  roles.push(role({
    role_id: `${organizationId}:executive-manager`, name: 'Executive Manager', role_type: 'executive', department_id: executiveDepartment.department_id,
    purpose: 'Compile mission intent, allocate bounded work, reconcile results, and preserve governance.',
    capabilities: ['proofgraph.control', 'workspace.read', 'workspace.propose', 'web.research', 'artifact.read', 'artifact.write', 'verification.execute', 'risk.review', 'delivery.propose', 'organization.plan', 'organization.delegate', 'budget.allocate', 'policy.propose'],
    budget: totalBudget, independence_group: 'executive', can_delegate: true,
  }));
  const executiveId = roles[0].role_id;

  function addTeam(type, teamName, leadName, leadCaps, specialistName, specialistCaps, independenceGroup) {
    const department = byType[type];
    if (!department) return;
    const teamId = `${organizationId}:${type}-team`;
    teams.push({ team_id: teamId, department_id: department.department_id, name: teamName, purpose: department.purpose });
    const leadId = `${organizationId}:${type}-lead`;
    roles.push(role({
      role_id: leadId, name: leadName, role_type: type === 'quality' ? 'verifier' : 'manager', department_id: department.department_id, team_id: teamId,
      manager_role_id: executiveId, purpose: `Lead ${teamName}`, capabilities: leadCaps, budget: department.budget,
      independence_group: independenceGroup, can_delegate: true,
    }));
    roles.push(role({
      role_id: `${organizationId}:${type}-specialist`, name: specialistName, role_type: type === 'quality' ? 'verifier' : 'specialist',
      department_id: department.department_id, team_id: teamId, manager_role_id: leadId, purpose: `Execute ${teamName} work`, capabilities: specialistCaps,
      budget: splitBudget(department.budget, 3, 4), independence_group: independenceGroup, can_delegate: false,
    }));
  }

  addTeam('research', 'Evidence Research', 'Research Lead', ['proofgraph.control', 'workspace.read', 'web.research', 'artifact.read', 'artifact.write'], 'Researcher', ['workspace.read', 'web.research', 'artifact.read', 'artifact.write'], 'research');
  addTeam('product', 'Planning', 'Planning Lead', ['proofgraph.control', 'workspace.read', 'artifact.read', 'artifact.write', 'organization.plan'], 'Planner', ['workspace.read', 'artifact.read', 'artifact.write'], 'planning');
  addTeam('engineering', 'Implementation', 'Engineering Lead', ['proofgraph.control', 'workspace.read', 'workspace.propose', 'artifact.read', 'artifact.write'], 'Developer', ['workspace.read', 'workspace.propose', 'artifact.read', 'artifact.write'], 'engineering');
  addTeam('quality', 'Independent Verification', 'Quality Lead', ['proofgraph.control', 'workspace.read', 'artifact.read', 'artifact.write', 'verification.execute'], 'Independent Verifier', ['workspace.read', 'artifact.read', 'artifact.write', 'verification.execute'], 'quality');
  addTeam('risk', 'Risk Review', 'Risk Officer', ['proofgraph.control', 'workspace.read', 'artifact.read', 'artifact.write', 'risk.review'], 'Security Reviewer', ['workspace.read', 'artifact.read', 'risk.review'], 'risk');
  addTeam('delivery', 'Delivery Coordination', 'Delivery Manager', ['proofgraph.control', 'artifact.read', 'artifact.write', 'delivery.propose'], 'Delivery Specialist', ['artifact.read', 'delivery.propose'], 'delivery');

  const humanDepartmentId = `${organizationId}:external-governance`;
  departments.push({
    department_id: humanDepartmentId, type: 'executive', name: 'External Governance', purpose: 'External human authority; never model delegated.',
    budget: budgetEnvelope(), capability_ceiling: ['approval.decide', 'policy.apply', 'run.abort'], external: true,
  });
  roles.push(role({
    role_id: `${organizationId}:human-approver`, name: 'External Human Approver', role_type: 'human', department_id: humanDepartmentId,
    purpose: 'Approve or deny high-risk, irreversible, policy-changing, or external-effect actions.',
    capabilities: ['approval.decide', 'policy.apply', 'run.abort'], budget: budgetEnvelope(), independence_group: 'human', can_delegate: false, model_eligible: false,
  }));

  for (const department of departments) {
    if (!department.capability_ceiling.length) {
      department.capability_ceiling = [...new Set(roles.filter((item) => item.department_id === department.department_id).flatMap((item) => item.capabilities))].sort();
    }
  }

  const organization = {
    schema_version: ORGANIZATION_SCHEMA_VERSION,
    organization_id: organizationId,
    task_id: taskSpec.task_id,
    name: options.name ?? `ProofGraph Mission Organization for ${taskSpec.task_id}`,
    mission_scope: taskSpec.objective,
    policy_version: options.policy_version ?? 'organization.v1',
    departments,
    teams,
    roles,
    budget: totalBudget,
    governance: {
      executive_role_id: executiveId,
      human_approver_role_id: `${organizationId}:human-approver`,
      verifier_independence_group: 'quality',
      capability_attenuation_required: true,
      external_effects_require_approval: true,
      self_modification_allowed: false,
    },
  };
  organization.digest = sha256(organization);
  validateOrganization(organization);
  return deepFreeze(organization);
}

export function validateOrganization(organization) {
  const roles = new Map(organization.roles.map((item) => [item.role_id, item]));
  if (roles.size !== organization.roles.length) throw new ValidationError('Duplicate role ID');
  const departments = new Map(organization.departments.map((item) => [item.department_id, item]));
  const teams = new Map(organization.teams.map((item) => [item.team_id, item]));
  for (const item of organization.roles) {
    if (!departments.has(item.department_id)) throw new ValidationError(`Role references missing department: ${item.role_id}`);
    if (item.team_id && !teams.has(item.team_id)) throw new ValidationError(`Role references missing team: ${item.role_id}`);
    if (item.manager_role_id && !roles.has(item.manager_role_id)) throw new ValidationError(`Role references missing manager: ${item.role_id}`);
    const ceiling = departments.get(item.department_id).capability_ceiling;
    if (!item.capabilities.every((capability) => ceiling.includes(capability))) throw new ValidationError(`Role exceeds department capability ceiling: ${item.role_id}`);
    if (item.model_eligible && item.capabilities.some((capability) => CAPABILITY_REGISTRY[capability]?.human_only || CAPABILITY_REGISTRY[capability]?.operator_only)) {
      throw new ValidationError(`Model role received human/operator capability: ${item.role_id}`);
    }
  }
  for (const start of roles.keys()) {
    const seen = new Set();
    let current = roles.get(start);
    while (current?.manager_role_id) {
      if (seen.has(current.manager_role_id)) throw new ValidationError(`Reporting cycle detected at ${start}`);
      seen.add(current.manager_role_id);
      current = roles.get(current.manager_role_id);
    }
  }
  const developers = organization.roles.filter((item) => item.independence_group === 'engineering');
  const verifiers = organization.roles.filter((item) => item.independence_group === 'quality');
  if (!verifiers.length) throw new ValidationError('Independent verifier is required');
  if (developers.some((developer) => verifiers.some((verifier) => developer.role_id === verifier.role_id))) throw new ValidationError('Developer and verifier must be distinct');
  const copy = structuredClone(organization);
  const digest = copy.digest;
  delete copy.digest;
  if (digest !== sha256(copy)) throw new ValidationError('Organization digest mismatch');
  return true;
}
