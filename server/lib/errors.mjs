export class ProofGraphError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProofGraphError';
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ProofGraphError {
  constructor(message, details = undefined) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class BudgetError extends ProofGraphError {
  constructor(message, details = undefined) {
    super('BUDGET_EXCEEDED', message, details);
    this.name = 'BudgetError';
  }
}

export class StateError extends ProofGraphError {
  constructor(message, details = undefined) {
    super('INVALID_STATE', message, details);
    this.name = 'StateError';
  }
}

export class SecurityError extends ProofGraphError {
  constructor(message, details = undefined) {
    super('SECURITY_BLOCK', message, details);
    this.name = 'SecurityError';
  }
}

export function asToolError(error) {
  const code = error?.code || 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const result = { ok: false, error: { code, message } };
  if (error?.details !== undefined) result.error.details = error.details;
  return result;
}
