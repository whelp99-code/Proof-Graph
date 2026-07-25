import { ValidationError } from '../../server/lib/errors.mjs';

export class HostError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HostError';
    this.details = details;
  }
}

export class ExecutionHost {
  constructor(options = {}) {
    this.name = options.name ?? 'host';
  }

  async doctor() {
    return { ok: true, host: this.name, mode: 'base' };
  }

  async execute(_request, _signal) {
    throw new HostError('ExecutionHost.execute() is not implemented');
  }
}

export function positiveInteger(value, fallback, label, options = {}) {
  const selected = value ?? fallback;
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return selected;
}

export function optionalString(value, fallback, label, options = {}) {
  const selected = value ?? fallback;
  if (selected == null) return null;
  if (typeof selected !== 'string') throw new ValidationError(`${label} must be a string`);
  const text = options.trim === false ? selected : selected.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 4096;
  if (text.length < min || text.length > max) {
    throw new ValidationError(`${label} must contain between ${min} and ${max} characters`);
  }
  return text;
}

export function booleanOption(value, fallback, label) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') throw new ValidationError(`${label} must be a boolean`);
  return selected;
}
