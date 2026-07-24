import { ValidationError } from './errors.mjs';

const IDENT_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const RUN_ID_RE = /^pg_[a-f0-9]{24}$/;

export function assertPlainObject(value, name = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value;
}

export function rejectUnknownKeys(object, allowed, name = 'object') {
  assertPlainObject(object, name);
  const extra = Object.keys(object).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ValidationError(`${name} contains unknown keys`, { extra });
}

export function stringValue(value, name, { min = 1, max = 10000, trim = true } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const output = trim ? value.trim() : value;
  if (output.length < min || output.length > max) {
    throw new ValidationError(`${name} length must be between ${min} and ${max}`, { actual: output.length });
  }
  if (output.includes('\u0000')) throw new ValidationError(`${name} contains a NUL character`);
  return output;
}

export function optionalString(value, name, options = {}) {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, name, options);
}

export function integerValue(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function booleanValue(value, name) {
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return value;
}

export function arrayValue(value, name, { min = 0, max = 1000 } = {}) {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array`);
  if (value.length < min || value.length > max) {
    throw new ValidationError(`${name} length must be between ${min} and ${max}`, { actual: value.length });
  }
  return value;
}

export function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function identifier(value, name = 'identifier') {
  const output = stringValue(value, name, { min: 1, max: 64 });
  if (!IDENT_RE.test(output)) throw new ValidationError(`${name} has an invalid format`);
  return output;
}

export function runId(value) {
  const output = stringValue(value, 'run_id', { min: 27, max: 27 });
  if (!RUN_ID_RE.test(output)) throw new ValidationError('run_id has an invalid format');
  return output;
}

export function urlString(value, name = 'url') {
  const output = stringValue(value, name, { min: 8, max: 2048 });
  let parsed;
  try {
    parsed = new URL(output);
  } catch {
    throw new ValidationError(`${name} must be a valid URL`);
  }
  return parsed;
}

export function uniqueStrings(values, name, { min = 0, max = 100, itemMax = 255 } = {}) {
  const arr = arrayValue(values, name, { min, max }).map((value, index) =>
    stringValue(value, `${name}[${index}]`, { min: 1, max: itemMax }),
  );
  if (new Set(arr).size !== arr.length) throw new ValidationError(`${name} must not contain duplicates`);
  return arr;
}

export function assertFiniteJson(value, depth = 0) {
  if (depth > 30) throw new ValidationError('JSON nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('JSON numbers must be finite');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5000) throw new ValidationError('JSON array is too large');
    for (const item of value) assertFiniteJson(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 5000) throw new ValidationError('JSON object is too large');
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ValidationError('Forbidden JSON key');
      }
      assertFiniteJson(value[key], depth + 1);
    }
    return;
  }
  throw new ValidationError('Unsupported JSON value');
}
