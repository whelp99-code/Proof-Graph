import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableQueue } from '../../runtime/os/durable-queue.mjs';
import { PolicyError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('durable queue enqueues, leases, heartbeats, and completes idempotently', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const queue = new DurableQueue({ dataDir: dir, now: () => now });
  const job = await queue.enqueue({ task: 'x' }, { idempotency_key: 'key-1' });
  const duplicate = await queue.enqueue({ task: 'x' }, { idempotency_key: 'key-1' });
  assert.equal(duplicate.job_id, job.job_id);
  const claim = await queue.claim('worker-a', { lease_ms: 1000 });
  assert.equal(claim.job_id, job.job_id);
  now += 100; await queue.heartbeat(job.job_id, 'worker-a', claim.lease_token, { lease_ms: 2000 });
  await queue.complete(job.job_id, 'worker-a', claim.lease_token, { ok: true });
  const state = await queue.state();
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal((await queue.verifyIntegrity()).ok, true);
});

test('durable queue rejects lease hijack', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const queue = new DurableQueue({ dataDir: dir });
  const job = await queue.enqueue({ task: 'x' });
  const claim = await queue.claim('worker-a');
  await assert.rejects(() => queue.complete(job.job_id, 'worker-b', claim.lease_token, { ok: true }), PolicyError);
  await assert.rejects(() => queue.complete(job.job_id, 'worker-a', 'forged', { ok: true }), PolicyError);
});

test('durable queue recovers stale lease and respects attempt bound', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const queue = new DurableQueue({ dataDir: dir, now: () => now });
  const job = await queue.enqueue({ task: 'x' }, { max_attempts: 2 });
  await queue.claim('worker-a', { lease_ms: 100 });
  now += 101;
  const second = await queue.claim('worker-b', { lease_ms: 100 });
  assert.equal(second.job_id, job.job_id);
  now += 101;
  const none = await queue.claim('worker-c', { lease_ms: 100 });
  assert.equal(none, null);
  const state = await queue.state();
  assert.equal(state.jobs[0].status, 'failed');
});
