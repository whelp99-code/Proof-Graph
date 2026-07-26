import path from 'node:path';
import { ValidationError } from './errors.mjs';
import { assertFiniteJson } from './canonical.mjs';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export function plainObject(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new ValidationError(`${label} must be a plain object`);
  assertFiniteJson(value, label);
  return value;
}

export function unknownKeys(value, allowed, label = 'value') {
  plainObject(value, label);
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) throw new ValidationError(`${label} contains unknown keys: ${unknown.join(', ')}`);
}

export function boundedJson(value, label = 'value', { maxBytes = 1_000_000 } = {}) {
  assertFiniteJson(value, label);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ValidationError('maxBytes must be a positive safe integer');
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw new ValidationError(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

export function stringValue(value, label, { min = 1, max = 10_000, pattern } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new ValidationError(`${label} length must be ${min}..${max}`);
  if (pattern && !pattern.test(text)) throw new ValidationError(`${label} has invalid format`);
  return text;
}

export function optionalString(value, label, options = {}) {
  return value == null ? null : stringValue(value, label, options);
}

export function identifier(value, label = 'identifier') {
  return stringValue(value, label, { min: 1, max: 128, pattern: IDENTIFIER });
}

export function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function integer(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidationError(`${label} must be an integer ${min}..${max}`);
  return value;
}

export function numberValue(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) throw new ValidationError(`${label} must be a finite number ${min}..${max}`);
  return value;
}

export function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be boolean`);
  return value;
}

export function arrayValue(value, label, { min = 0, max = 1000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ValidationError(`${label} must be an array of length ${min}..${max}`);
  return value;
}

export function uniqueStrings(value, label, { max = 100, itemMax = 256 } = {}) {
  const values = arrayValue(value ?? [], label, { max }).map((item, index) => stringValue(item, `${label}[${index}]`, { max: itemMax }));
  if (new Set(values).size !== values.length) throw new ValidationError(`${label} contains duplicates`);
  return values;
}

export function safeRelativePath(value, label = 'path') {
  const text = stringValue(value, label, { max: 1000 }).replaceAll('\\', '/');
  if (text.includes('\0') || path.posix.isAbsolute(text) || /^[A-Za-z]:/.test(text)) throw new ValidationError(`${label} must be relative`);
  const normalized = path.posix.normalize(text);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new ValidationError(`${label} is unsafe`);
  }
  return normalized.replace(/^\.\//, '');
}

export function isoDate(value, label = 'date') {
  const text = stringValue(value, label, { max: 64 });
  if (!Number.isFinite(Date.parse(text))) throw new ValidationError(`${label} must be ISO date-time`);
  return new Date(text).toISOString();
}

export function boundedRecord(value, label, { keyPattern = IDENTIFIER, max = 100 } = {}) {
  plainObject(value, label);
  const entries = Object.entries(value);
  if (entries.length > max) throw new ValidationError(`${label} has too many entries`);
  for (const [key] of entries) if (!keyPattern.test(key)) throw new ValidationError(`${label} contains invalid key ${key}`);
  return value;
}
