import crypto from 'node:crypto';
import { ValidationError } from './errors.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function assertFiniteJson(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`Non-finite number at ${path}`);
    return;
  }
  if (typeof value !== 'object') throw new ValidationError(`Unsupported JSON value at ${path}`);
  if (seen.has(value)) throw new ValidationError(`Circular structure at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteJson(item, `${path}[${index}]`, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new ValidationError(`Non-plain object at ${path}`);
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new ValidationError(`Forbidden key ${key} at ${path}`);
      assertFiniteJson(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function canonicalize(value) {
  assertFiniteJson(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function hmacSha256(key, value) {
  return crypto.createHmac('sha256', key).update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function timingSafeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length || !/^[a-f0-9]+$/i.test(left + right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function deterministicId(prefix, value, length = 20) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(prefix)) throw new ValidationError('Invalid ID prefix');
  return `${prefix}_${sha256(value).slice(0, length)}`;
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function cloneJson(value) {
  assertFiniteJson(value);
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function hashEnvelope(payload, omitted = []) {
  const copy = cloneJson(payload);
  for (const key of omitted) delete copy[key];
  return sha256(copy);
}
