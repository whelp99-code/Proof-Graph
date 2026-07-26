import { ConflictError, ValidationError } from '../core/errors.mjs';
import { randomId } from '../core/canonical.mjs';

export class WorkerRuntime {
  constructor({ concurrency = 4 } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new ValidationError('concurrency must be 1..64');
    this.concurrency = concurrency; this.queue = []; this.active = new Map(); this.completed = new Map(); this.waiters = [];
  }
  submit(task, handler) {
    if (!task?.id || typeof handler !== 'function') throw new ValidationError('task.id and handler are required');
    if (this.active.has(task.id) || this.completed.has(task.id) || this.queue.some((entry) => entry.task.id === task.id)) throw new ConflictError('Duplicate worker task');
    const entry = { task: structuredClone(task), handler, job_id: randomId('job'), submitted_at: new Date().toISOString() };
    this.queue.push(entry); this.pump(); return entry.job_id;
  }
  pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const entry = this.queue.shift(); this.active.set(entry.task.id, entry);
      Promise.resolve().then(() => entry.handler(entry.task)).then((result) => this.finish(entry, { status: 'completed', result }), (error) => this.finish(entry, { status: 'failed', error: { name: error.name, message: error.message } }));
    }
  }
  finish(entry, outcome) { this.active.delete(entry.task.id); this.completed.set(entry.task.id, { ...outcome, job_id: entry.job_id, completed_at: new Date().toISOString() }); this.pump(); this.flushWaiters(); }
  flushWaiters() { for (const waiter of [...this.waiters]) { const result = this.completed.get(waiter.id); if (result) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(structuredClone(result)); } } }
  wait(id) { const result = this.completed.get(id); if (result) return Promise.resolve(structuredClone(result)); return new Promise((resolve) => this.waiters.push({ id, resolve })); }
  snapshot() { return { concurrency: this.concurrency, queued: this.queue.map((e) => e.task.id), active: [...this.active.keys()], completed: [...this.completed.entries()].map(([id, value]) => ({ id, status: value.status })) }; }
}
