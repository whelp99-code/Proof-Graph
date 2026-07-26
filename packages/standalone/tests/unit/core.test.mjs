import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, deterministicId, sha256, assertFiniteJson } from '../../runtime/core/canonical.mjs';
import { HashChainStore } from '../../runtime/core/atomic-store.mjs';
import { loadOrCreateSecret } from '../../runtime/core/secret-store.mjs';
import { ConflictError, IntegrityError, ValidationError } from '../../runtime/core/errors.mjs';
import { boundedJson } from '../../runtime/core/validate.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('canonical JSON sorts object keys recursively', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('canonical validation rejects prototype-pollution keys', () => {
  const value = JSON.parse('{"safe":1,"__proto__":{"admin":true}}');
  assert.throws(() => assertFiniteJson(value), ValidationError);
});

test('canonical validation rejects circular and non-finite values', () => {
  const value = {}; value.self = value;
  assert.throws(() => assertFiniteJson(value), /Circular/);
  assert.throws(() => assertFiniteJson({ x: Infinity }), /Non-finite/);
});

test('bounded JSON rejects oversized structured input', () => {
  assert.equal(boundedJson({ ok: true }, 'payload', { maxBytes: 32 }).ok, true);
  assert.throws(() => boundedJson({ data: 'x'.repeat(64) }, 'payload', { maxBytes: 32 }), /exceeds 32 bytes/);
  assert.throws(() => boundedJson({ ok: true }, 'payload', { maxBytes: 0 }), /positive safe integer/);
});

test('deterministic IDs and hashes are stable', () => {
  assert.equal(deterministicId('task', { b: 2, a: 1 }), deterministicId('task', { a: 1, b: 2 }));
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }));
});

test('HashChainStore persists state and events', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir);
  let state = await store.create('run_a', { status: 'new', created_at: new Date(0).toISOString() });
  assert.equal(state.revision, 1);
  state = await store.update('run_a', ({ state: next, emit }) => { next.status = 'done'; emit('run.done', 'test', { ok: true }); return next; });
  assert.equal(state.status, 'done');
  assert.equal((await store.verifyEvents('run_a', state.event_head)).seq, 2);
});

test('HashChainStore detects stale revision', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir);
  const state = await store.create('run_b', { status: 'new', created_at: new Date(0).toISOString() });
  await assert.rejects(() => store.update('run_b', ({ state: next }) => next, { expectedRevision: state.revision - 1 }), ConflictError);
});

test('HashChainStore detects state tampering', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir);
  await store.create('run_c', { status: 'new', created_at: new Date(0).toISOString() });
  const file = store.stateFile('run_c');
  const state = JSON.parse(await fs.readFile(file, 'utf8')); state.status = 'forged';
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(() => store.read('run_c'), IntegrityError);
});

test('HashChainStore detects event deletion and mutation', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir);
  await store.create('run_d', { status: 'new', created_at: new Date(0).toISOString() });
  const file = store.eventsFile('run_d');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  const event = JSON.parse(lines[0]); event.actor = 'attacker'; lines[0] = JSON.stringify(event);
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  await assert.rejects(() => store.read('run_d'), IntegrityError);
});


test('approval secret store creates a stable private secret', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const first = await loadOrCreateSecret(dir, { filename: '.test-secret' });
  const second = await loadOrCreateSecret(dir, { filename: '.test-secret' });
  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first) >= 40);
  const stat = await fs.stat(path.join(dir, '.test-secret'));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);
});

test('approval secret store rejects symlink and short supplied secrets', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'target'), 'not-a-secret\n');
  try {
    await fs.symlink(path.join(dir, 'target'), path.join(dir, '.test-secret'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(() => loadOrCreateSecret(dir, { filename: '.test-secret' }), /regular file|Symbolic/i);
  await assert.rejects(() => loadOrCreateSecret(dir, { filename: '.another-secret', provided: 'short' }), /32 bytes/);
});

test('HashChainStore rejects state and event symlink replacement', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir);
  await store.create('run_symlink', { status: 'new', created_at: new Date(0).toISOString() });
  const original = await fs.readFile(store.stateFile('run_symlink'), 'utf8');
  const outside = path.join(dir, 'outside.json');
  await fs.writeFile(outside, original);
  await fs.rm(store.stateFile('run_symlink'));
  try {
    await fs.symlink(outside, store.stateFile('run_symlink'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(() => store.read('run_symlink'), /Symbolic links/);
});
