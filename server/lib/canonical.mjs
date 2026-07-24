import { createHash, randomBytes } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(input).digest('hex');
}

export function randomId(prefix = 'id') {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function eventHash(eventWithoutHash) {
  return sha256(`${eventWithoutHash.prev_hash}\n${canonicalJson(eventWithoutHash)}`);
}

export function nowIso() {
  return new Date().toISOString();
}
