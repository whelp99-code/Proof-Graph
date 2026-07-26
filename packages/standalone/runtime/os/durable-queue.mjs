import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson, deterministicId, randomId, sha256 } from '../core/canonical.mjs';
import { ConflictError, PolicyError, ValidationError } from '../core/errors.mjs';

function nowIso(now) { return new Date(now()).toISOString(); }

export class DurableQueue {
  constructor({ dataDir, name = 'default', now = () => Date.now() }) {
    this.store = new HashChainStore(dataDir, { namespace: 'queues' });
    this.name = name;
    this.now = now;
  }

  async initialize() {
    try { return await this.store.read(this.name); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return this.store.create(this.name, { schema_version: 1, queue_name: this.name, jobs: [], completed_keys: [], created_at: nowIso(this.now), updated_at: nowIso(this.now) }, { type: 'queue.created', actor: 'system', data: {} });
    }
  }

  async enqueue(payload, { idempotency_key = null, max_attempts = 3, available_at = null } = {}) {
    await this.initialize();
    if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 || max_attempts > 20) throw new ValidationError('max_attempts must be 1..20');
    let result;
    await this.store.update(this.name, ({ state, emit }) => {
      if (idempotency_key) {
        const existing = state.jobs.find((job) => job.idempotency_key === idempotency_key) ?? (state.completed_keys.includes(idempotency_key) ? { job_id: null, status: 'completed' } : null);
        if (existing) { result = cloneJson(existing); return state; }
      }
      const job = {
        job_id: deterministicId('job', { payload, idempotency_key, seq: state.jobs.length }),
        payload: cloneJson(payload), payload_digest: sha256(payload), idempotency_key,
        status: 'queued', attempts: 0, max_attempts, available_at: available_at ? new Date(available_at).toISOString() : nowIso(this.now),
        lease: null, result: null, failure: null,
      };
      state.jobs.push(job); result = cloneJson(job); emit('job.enqueued', 'queue', { job_id: job.job_id }); return state;
    });
    return result;
  }

  async claim(workerId, { lease_ms = 30_000 } = {}) {
    if (!Number.isSafeInteger(lease_ms) || lease_ms < 100 || lease_ms > 3_600_000) throw new ValidationError('lease_ms must be 100..3600000');
    await this.initialize();
    let claimed = null;
    await this.store.update(this.name, ({ state, emit }) => {
      const now = this.now();
      for (const job of state.jobs) {
        if (job.status === 'leased' && Date.parse(job.lease.expires_at) <= now) {
          job.status = job.attempts >= job.max_attempts ? 'failed' : 'queued';
          job.lease = null;
          emit('job.lease_expired', 'queue', { job_id: job.job_id });
        }
      }
      const job = state.jobs.find((item) => item.status === 'queued' && Date.parse(item.available_at) <= now);
      if (!job) return state;
      job.status = 'leased'; job.attempts += 1;
      const leaseToken = randomId('lease');
      job.lease = { worker_id: workerId, token_hash: sha256(leaseToken), issued_at: nowIso(this.now), expires_at: new Date(now + lease_ms).toISOString() };
      claimed = { ...cloneJson(job), lease_token: leaseToken };
      emit('job.claimed', workerId, { job_id: job.job_id, attempt: job.attempts });
      return state;
    });
    return claimed;
  }

  async heartbeat(jobId, workerId, leaseToken, { lease_ms = 30_000 } = {}) {
    return this.store.update(this.name, ({ state, emit }) => {
      const job = state.jobs.find((item) => item.job_id === jobId);
      this.assertLease(job, workerId, leaseToken);
      job.lease.expires_at = new Date(this.now() + lease_ms).toISOString();
      emit('job.heartbeat', workerId, { job_id: jobId }); return state;
    });
  }

  assertLease(job, workerId, leaseToken) {
    if (!job || job.status !== 'leased' || job.lease?.worker_id !== workerId || job.lease?.token_hash !== sha256(leaseToken)) throw new PolicyError('Invalid or stale job lease');
    if (Date.parse(job.lease.expires_at) <= this.now()) throw new PolicyError('Job lease expired');
  }

  async complete(jobId, workerId, leaseToken, result) {
    return this.store.update(this.name, ({ state, emit }) => {
      const job = state.jobs.find((item) => item.job_id === jobId);
      this.assertLease(job, workerId, leaseToken);
      job.status = 'completed'; job.result = cloneJson(result); job.result_digest = sha256(result); job.lease = null;
      if (job.idempotency_key && !state.completed_keys.includes(job.idempotency_key)) state.completed_keys.push(job.idempotency_key);
      emit('job.completed', workerId, { job_id: jobId, result_digest: job.result_digest }); return state;
    });
  }

  async fail(jobId, workerId, leaseToken, failure, { retry_delay_ms = 0 } = {}) {
    return this.store.update(this.name, ({ state, emit }) => {
      const job = state.jobs.find((item) => item.job_id === jobId);
      this.assertLease(job, workerId, leaseToken);
      job.failure = cloneJson(failure); job.lease = null;
      if (job.attempts < job.max_attempts && failure?.retryable !== false) {
        job.status = 'queued'; job.available_at = new Date(this.now() + retry_delay_ms).toISOString();
      } else job.status = 'failed';
      emit('job.failed', workerId, { job_id: jobId, status: job.status, failure: job.failure }); return state;
    });
  }

  async state() { await this.initialize(); return this.store.read(this.name); }
  async verifyIntegrity() { const state = await this.state(); return { ok: true, event_head: await this.store.verifyEvents(this.name, state.event_head), jobs: state.jobs.length }; }
}
