import { sha256, cloneJson } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';
import { plainObject, unknownKeys } from '../core/validate.mjs';

export const DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);

const POLICY_KEYS = Object.freeze([
  'version',
  'max_autonomous_cycles',
  'max_parallel_missions',
  'allow_low_risk_retry',
  'allow_medium_risk_retry',
  'external_effects_require_approval',
  'policy_changes_require_approval',
  'runtime_changes_require_approval',
  'self_apply_improvements',
]);

export class GovernancePolicyEngine {
  constructor(policy = {}) {
    plainObject(policy, 'governance policy');
    unknownKeys(policy, POLICY_KEYS, 'governance policy');
    const supplied = cloneJson(policy);
    for (const key of ['external_effects_require_approval', 'policy_changes_require_approval', 'runtime_changes_require_approval']) {
      if (supplied[key] === false) throw new PolicyError(`${key} cannot be disabled`);
    }
    if (supplied.self_apply_improvements === true) throw new PolicyError('Self-applying improvements are forbidden');
    this.policy = Object.freeze({
      version: supplied.version ?? 'governance.v1',
      max_autonomous_cycles: supplied.max_autonomous_cycles ?? 3,
      max_parallel_missions: supplied.max_parallel_missions ?? 2,
      allow_low_risk_retry: supplied.allow_low_risk_retry !== false,
      allow_medium_risk_retry: supplied.allow_medium_risk_retry === true,
      external_effects_require_approval: true,
      policy_changes_require_approval: true,
      runtime_changes_require_approval: true,
      self_apply_improvements: false,
    });
    if (typeof this.policy.version !== 'string' || this.policy.version.length < 3 || this.policy.version.length > 100) {
      throw new ValidationError('Governance policy version must be a bounded string');
    }
    if (!Number.isSafeInteger(this.policy.max_autonomous_cycles) || this.policy.max_autonomous_cycles < 1 || this.policy.max_autonomous_cycles > 20) {
      throw new ValidationError('max_autonomous_cycles must be 1..20');
    }
    if (!Number.isSafeInteger(this.policy.max_parallel_missions) || this.policy.max_parallel_missions < 1 || this.policy.max_parallel_missions > 16) {
      throw new ValidationError('max_parallel_missions must be 1..16');
    }
  }

  evaluate(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new ValidationError('Governance action is required');
    let decision = 'allow';
    const reasons = [];
    if (action.type === 'apply_improvement' || action.type === 'modify_policy' || action.type === 'modify_runtime') {
      decision = 'require_approval'; reasons.push('self_modification_requires_external_approval');
    }
    if (action.external_effect === true || action.irreversible === true || ['high', 'critical'].includes(action.risk)) {
      decision = 'require_approval'; reasons.push('high_risk_or_external_effect');
    }
    if (action.actor_type === 'model' && ['approve', 'deny', 'abort', 'apply_policy'].includes(action.type)) {
      decision = 'deny'; reasons.push('model_has_no_operator_authority');
    }
    if (action.type === 'autonomous_retry') {
      if (action.risk === 'low' && this.policy.allow_low_risk_retry) decision = 'allow';
      else if (action.risk === 'medium' && this.policy.allow_medium_risk_retry) decision = 'allow';
      else { decision = 'require_approval'; reasons.push('retry_risk_requires_approval'); }
    }
    if (action.capability_escalation === true) { decision = 'deny'; reasons.push('capability_escalation_forbidden'); }
    const result = { decision, reasons: [...new Set(reasons)], policy_version: this.policy.version, action_digest: sha256(action) };
    result.digest = sha256(result);
    return result;
  }
}
