import { deterministicId, sha256, cloneJson } from '../core/canonical.mjs';
import { ValidationError } from '../core/errors.mjs';

function normalizeProposal(item, index) {
  if (!item || typeof item !== 'object') throw new ValidationError(`Council proposal ${index} must be an object`);
  if (typeof item.role_id !== 'string' || typeof item.independence_group !== 'string' || typeof item.recommendation !== 'string') {
    throw new ValidationError(`Council proposal ${index} lacks role, independence group, or recommendation`);
  }
  return {
    proposal_id: item.proposal_id ?? deterministicId('proposal', { index, role_id: item.role_id, recommendation: item.recommendation, evidence: item.evidence ?? [] }),
    role_id: item.role_id,
    independence_group: item.independence_group,
    recommendation: item.recommendation,
    confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
    evidence: Array.isArray(item.evidence) ? cloneJson(item.evidence) : [],
    risks: Array.isArray(item.risks) ? cloneJson(item.risks) : [],
  };
}

export class CouncilRuntime {
  convene({ subject, proposals, required_groups = 2, require_verifier = true }) {
    const normalized = proposals.map(normalizeProposal);
    if (normalized.length < 2) throw new ValidationError('Council requires at least two proposals');
    const groups = new Set(normalized.map((item) => item.independence_group));
    const evidenceBearing = normalized.filter((item) => item.evidence.length > 0);
    const grouped = new Map();
    for (const item of normalized) {
      const bucket = grouped.get(item.recommendation) ?? [];
      bucket.push(item); grouped.set(item.recommendation, bucket);
    }
    const rankings = [...grouped.entries()].map(([recommendation, items]) => ({
      recommendation,
      support: items.length,
      independent_groups: new Set(items.map((item) => item.independence_group)).size,
      evidence_count: items.reduce((sum, item) => sum + item.evidence.length, 0),
      weighted_confidence: items.reduce((sum, item) => sum + item.confidence, 0) / items.length,
    })).sort((a, b) => b.independent_groups - a.independent_groups || b.evidence_count - a.evidence_count || b.weighted_confidence - a.weighted_confidence || a.recommendation.localeCompare(b.recommendation));
    const winner = rankings[0];
    const tie = rankings[1] && winner.independent_groups === rankings[1].independent_groups && winner.evidence_count === rankings[1].evidence_count && Math.abs(winner.weighted_confidence - rankings[1].weighted_confidence) < 0.05;
    const verifierPresent = normalized.some((item) => item.independence_group === 'quality' || item.independence_group === 'risk');
    const accepted = !tie && groups.size >= required_groups && evidenceBearing.length >= 1 && (!require_verifier || verifierPresent) && winner.independent_groups >= Math.min(required_groups, groups.size);
    const result = {
      schema_version: 1,
      council_id: deterministicId('council', { subject, proposals: normalized }),
      subject: cloneJson(subject),
      proposals: normalized,
      rankings,
      decision: accepted ? winner.recommendation : null,
      status: accepted ? 'decision_proposed' : 'unresolved',
      unresolved: accepted ? [] : [tie ? 'tie_or_near_tie' : 'insufficient_independent_evidence'],
      decision_is_advisory: true,
      execution_authority: 'governance_policy_or_external_operator',
    };
    result.digest = sha256(result);
    return result;
  }
}
