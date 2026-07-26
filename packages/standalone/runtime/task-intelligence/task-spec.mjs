import { cloneJson, deterministicId, sha256, deepFreeze } from '../core/canonical.mjs';
import { ValidationError } from '../core/errors.mjs';
import { boundedJson, plainObject, unknownKeys, stringValue, uniqueStrings } from '../core/validate.mjs';
import { classifyTask } from './classifier.mjs';
import { createGraphBlueprint } from './blueprints.mjs';
import { validateGraphAdequacy } from './adequacy.mjs';

const ALLOWED_INPUT = ['objective', 'workspace', 'constraints', 'signals', 'deliverables', 'acceptance_criteria', 'metadata'];

function defaultDeliverables(classification) {
  const map = {
    direct: ['verified response'], research: ['research report'], feature: ['implementation artifact', 'test evidence'], bugfix: ['fix artifact', 'regression test evidence'],
    refactor: ['refactor artifact', 'behavior-preservation evidence'], security: ['security findings', 'remediation artifact', 'reproduction evidence'],
    migration: ['migration plan', 'migration artifact', 'rollback evidence'], operations: ['operation plan', 'execution receipt', 'rollback plan'],
    product: ['product specification', 'acceptance criteria'],
  };
  return map[classification.archetype];
}

function defaultAcceptance(deliverables, classification) {
  return deliverables.map((name) => `${name} is present, traceable, and independently verified`).concat([
    'all failed, blocked, partial, and unverified items remain visible',
    classification.external_effects ? 'external effects remain blocked until explicit operator approval' : 'no unapproved external side effect occurs',
  ]);
}

function requiredCapabilities(classification) {
  const caps = ['proofgraph.control', 'artifact.read'];
  if (classification.requires_research) caps.push('workspace.read', 'web.research');
  if (classification.requires_implementation) caps.push('workspace.propose');
  if (classification.risk !== 'low') caps.push('risk.review');
  if (classification.external_effects) caps.push('delivery.propose');
  return [...new Set(caps)].sort();
}

function requiredRoles(classification) {
  const roles = ['coordinator', 'verifier', 'synthesizer'];
  if (classification.requires_research) roles.push('researcher');
  if (classification.requires_implementation) roles.push('planner', 'developer');
  else roles.push('direct');
  if (classification.risk === 'high' || classification.risk === 'critical' || classification.external_effects || classification.reversibility !== 'reversible') roles.push('human_approver');
  return roles;
}

export function compileTaskSpec(rawInput) {
  plainObject(rawInput, 'input');
  unknownKeys(rawInput, ALLOWED_INPUT, 'input');
  const objective = stringValue(rawInput.objective, 'objective', { min: 3, max: 20_000 });
  const constraints = uniqueStrings(rawInput.constraints ?? [], 'constraints', { max: 100, itemMax: 1000 });
  const signals = rawInput.signals ?? {};
  plainObject(signals, 'signals');
  unknownKeys(signals, ['archetype', 'complexity', 'uncertainty', 'risk', 'reversibility', 'external_effects', 'requires_research', 'requires_implementation', 'estimated_subtasks'], 'signals');
  const classification = classifyTask(objective, signals);
  const deliverables = uniqueStrings(rawInput.deliverables ?? defaultDeliverables(classification), 'deliverables', { max: 50, itemMax: 300 });
  const acceptance = uniqueStrings(rawInput.acceptance_criteria ?? defaultAcceptance(deliverables, classification), 'acceptance_criteria', { max: 100, itemMax: 1000 });
  if (deliverables.length === 0 || acceptance.length === 0) throw new ValidationError('Deliverables and acceptance criteria are required');
  const workspace = rawInput.workspace == null ? null : cloneJson(boundedJson(rawInput.workspace, 'workspace', { maxBytes: 2_000_000 }));
  const metadata = cloneJson(boundedJson(rawInput.metadata ?? {}, 'metadata', { maxBytes: 256_000 }));
  const seed = { objective, constraints, classification, deliverables, acceptance, workspace_digest: workspace?.digest ?? null };
  const taskSpec = {
    schema_version: 1,
    task_id: deterministicId('task', seed),
    objective,
    archetype: classification.archetype,
    complexity: classification.complexity,
    uncertainty: classification.uncertainty,
    risk: classification.risk,
    reversibility: classification.reversibility,
    external_effects: classification.external_effects,
    requires_research: classification.requires_research,
    requires_implementation: classification.requires_implementation,
    estimated_subtasks: classification.estimated_subtasks,
    constraints,
    deliverables,
    acceptance_criteria: acceptance,
    required_capabilities: requiredCapabilities(classification),
    required_roles: requiredRoles(classification),
    verification_strength: classification.risk === 'critical' || classification.complexity >= 75 || classification.uncertainty >= 70 ? 'deep' : classification.complexity >= 45 ? 'standard' : 'lite',
    workspace,
    metadata,
  };
  taskSpec.blueprint = createGraphBlueprint(taskSpec);
  taskSpec.adequacy = validateGraphAdequacy(taskSpec, taskSpec.blueprint);
  taskSpec.digest = sha256(taskSpec);
  return deepFreeze(taskSpec);
}

export function validateTaskSpec(taskSpec) {
  const copy = cloneJson(taskSpec);
  const digest = copy.digest;
  delete copy.digest;
  if (digest !== sha256(copy)) throw new ValidationError('TaskSpec digest mismatch');
  validateGraphAdequacy(taskSpec, taskSpec.blueprint);
  return true;
}
