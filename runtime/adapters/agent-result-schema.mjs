export const AGENT_RESULT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'output', 'artifacts', 'dynamic_tasks', 'workspace_actions'],
  properties: {
    outcome: { type: 'string', enum: ['success', 'failed', 'blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 20_000 },
    output: { type: 'object', additionalProperties: true },
    failure: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['failure_type', 'summary', 'severity', 'retryable', 'evidence'],
      properties: {
        failure_type: {
          type: 'string',
          enum: [
            'implementation_error', 'design_error', 'requirements_error', 'evidence_gap',
            'verification_error', 'security_risk', 'budget_exceeded', 'unknown',
          ],
        },
        summary: { type: 'string', minLength: 3, maxLength: 8_000 },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        retryable: { type: 'boolean' },
        evidence: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 8_000 } },
        expected: { type: ['string', 'null'], maxLength: 8_000 },
        observed: { type: ['string', 'null'], maxLength: 8_000 },
        recommended_route: {
          type: ['string', 'null'],
          enum: ['direct', 'research', 'plan', 'develop', 'verify', 'human', 'synthesize', 'success', 'partial', 'failed', null],
        },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    usage: { type: 'object', additionalProperties: true },
    artifacts: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } },
    dynamic_tasks: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: true } },
    workspace_actions: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: true } },
    metadata: { type: 'object', additionalProperties: true },
  },
});
