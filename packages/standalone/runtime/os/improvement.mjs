import { deterministicId, sha256, cloneJson } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';

export class ImprovementEngine {
  propose({ source_run_id, metrics, failures = [], evidence = [], proposed_change = null }) {
    if (!source_run_id || !metrics) throw new ValidationError('Improvement proposal requires source run and metrics');
    const dominant = failures.reduce((counts, item) => { counts[item.type ?? 'unknown'] = (counts[item.type ?? 'unknown'] ?? 0) + 1; return counts; }, {});
    const observedProblem = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (metrics.quality_gate_passed ? 'efficiency_opportunity' : 'quality_gate_failure');
    const proposal = {
      schema_version: 1,
      proposal_id: deterministicId('improvement', { source_run_id, metrics, failures, proposed_change }),
      source_run_id,
      observed_problem: observedProblem,
      evidence: cloneJson(evidence),
      proposed_change: proposed_change ?? {
        type: 'policy_or_blueprint_candidate',
        description: `Review bounded routing, role assignment, or verification policy for ${observedProblem}`,
      },
      expected_benefit: 'Improve quality, reliability, or efficiency without relaxing verification and approval invariants.',
      risk: 'high',
      rollback: 'Do not activate the candidate; retain the current signed policy/package.',
      required_verification: ['independent regression suite', 'adversarial policy bypass suite', 'external operator approval'],
      approval_status: 'pending',
      status: 'proposed',
      auto_apply_allowed: false,
    };
    proposal.digest = sha256(proposal);
    return proposal;
  }

  apply(_proposal) {
    throw new PolicyError('Improvement proposals cannot self-apply; publish a reviewed, signed package after external approval');
  }
}
