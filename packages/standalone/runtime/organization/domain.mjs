export const ORGANIZATION_SCHEMA_VERSION = 1;
export const ROLE_TYPES = Object.freeze(['executive', 'manager', 'specialist', 'verifier', 'human', 'system']);
export const DEPARTMENT_TYPES = Object.freeze(['executive', 'research', 'product', 'engineering', 'quality', 'risk', 'delivery']);

export function budgetEnvelope({ calls = 0, tokens = 0, cost_micros = 0, wall_time_ms = 0 } = {}) {
  return Object.freeze({ calls, tokens, cost_micros, wall_time_ms });
}

export function zeroBudget() { return budgetEnvelope(); }
