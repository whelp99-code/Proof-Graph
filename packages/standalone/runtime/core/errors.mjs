export class ProofGraphError extends Error {
  constructor(message, { code = 'proofgraph_error', details = null, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ProofGraphError {
  constructor(message, details = null) {
    super(message, { code: 'validation_error', details });
  }
}

export class PolicyError extends ProofGraphError {
  constructor(message, details = null) {
    super(message, { code: 'policy_error', details });
  }
}

export class IntegrityError extends ProofGraphError {
  constructor(message, details = null) {
    super(message, { code: 'integrity_error', details });
  }
}

export class ConflictError extends ProofGraphError {
  constructor(message, details = null) {
    super(message, { code: 'conflict_error', details });
  }
}

export class BudgetError extends ProofGraphError {
  constructor(message, details = null) {
    super(message, { code: 'budget_exceeded', details });
  }
}
