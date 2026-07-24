import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, eventHash, sha256 } from '../../server/lib/canonical.mjs';

 test('canonical JSON is stable across key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { y: 1, x: 0 } }), canonicalJson({ a: { x: 0, y: 1 }, b: 2 }));
});

test('sha256 and event hashes are deterministic', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const event = { seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'x', actor: 'a', data: {}, prev_hash: '0'.repeat(64) };
  assert.equal(eventHash(event), eventHash(structuredClone(event)));
});
