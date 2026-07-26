import { sha256 } from '../core/canonical.mjs';
import { compileTaskSpec } from './task-spec.mjs';

export function evaluateTaskCompiler(cases) {
  const results = cases.map((item, index) => {
    try {
      const first = compileTaskSpec(item.input);
      const second = compileTaskSpec(item.input);
      const checks = {
        compiled: true,
        deterministic: first.digest === second.digest,
        archetype: item.expected?.archetype == null || first.archetype === item.expected.archetype,
        risk: item.expected?.risk == null || first.risk === item.expected.risk,
        approval: item.expected?.approval_required == null || first.blueprint.stages.some((stage) => stage.kind === 'human_approval') === item.expected.approval_required,
        research: item.expected?.requires_research == null || first.requires_research === item.expected.requires_research,
        implementation: item.expected?.requires_implementation == null || first.requires_implementation === item.expected.requires_implementation,
      };
      return { case_id: item.case_id ?? `case-${index + 1}`, passed: Object.values(checks).every(Boolean), checks, task_digest: first.digest, error: null };
    } catch (error) {
      return { case_id: item.case_id ?? `case-${index + 1}`, passed: item.expected?.reject === true, checks: { compiled: false }, task_digest: null, error: error.message };
    }
  });
  const summary = {
    schema_version: 1,
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    pass_rate: results.length ? results.filter((item) => item.passed).length / results.length : 1,
    results,
  };
  summary.digest = sha256(summary);
  return summary;
}
