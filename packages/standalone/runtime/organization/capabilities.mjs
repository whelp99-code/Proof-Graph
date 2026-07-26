import { ValidationError } from '../core/errors.mjs';

export const CAPABILITY_REGISTRY = Object.freeze({
  'proofgraph.control': { delegable: true, risk: 'low' },
  'workspace.read': { delegable: true, risk: 'low' },
  'workspace.propose': { delegable: true, risk: 'medium' },
  'workspace.mutate': { delegable: true, risk: 'high', approval_required: true },
  'web.research': { delegable: true, risk: 'medium' },
  'artifact.read': { delegable: true, risk: 'low' },
  'artifact.write': { delegable: true, risk: 'medium' },
  'verification.execute': { delegable: true, risk: 'medium' },
  'risk.review': { delegable: true, risk: 'medium' },
  'delivery.propose': { delegable: true, risk: 'medium' },
  'delivery.execute': { delegable: true, risk: 'critical', approval_required: true },
  'organization.plan': { delegable: true, risk: 'medium' },
  'organization.delegate': { delegable: true, risk: 'high' },
  'budget.allocate': { delegable: true, risk: 'high' },
  'policy.propose': { delegable: true, risk: 'high' },
  'policy.apply': { delegable: false, risk: 'critical', human_only: true },
  'approval.decide': { delegable: false, risk: 'critical', human_only: true },
  'run.abort': { delegable: false, risk: 'high', operator_only: true },
});

export function validateCapabilities(capabilities, { allowHumanOnly = false, allowOperatorOnly = false } = {}) {
  if (!Array.isArray(capabilities)) throw new ValidationError('Capabilities must be an array');
  const unique = [...new Set(capabilities)].sort();
  if (unique.length !== capabilities.length) throw new ValidationError('Capabilities contain duplicates');
  for (const capability of unique) {
    const policy = CAPABILITY_REGISTRY[capability];
    if (!policy) throw new ValidationError(`Unknown capability: ${capability}`);
    if (policy.human_only && !allowHumanOnly) throw new ValidationError(`Human-only capability cannot be assigned: ${capability}`);
    if (policy.operator_only && !allowOperatorOnly) throw new ValidationError(`Operator-only capability cannot be assigned: ${capability}`);
  }
  return unique;
}

export function capabilitySubset(child, parent) {
  const allowed = new Set(parent);
  return child.every((capability) => allowed.has(capability));
}

export function delegableSubset(capabilities) {
  return capabilities.filter((capability) => CAPABILITY_REGISTRY[capability]?.delegable === true).sort();
}
