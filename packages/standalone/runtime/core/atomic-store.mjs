import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, cloneJson, sha256 } from './canonical.mjs';
import { ConflictError, IntegrityError, ValidationError } from './errors.mjs';
import { identifier } from './validate.mjs';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}


async function assertSafePath(file, { kind = 'file', optional = false } = {}) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new IntegrityError(`Symbolic links are not allowed in runtime storage: ${file}`);
  if (kind === 'file' && !stat.isFile()) throw new IntegrityError(`Expected regular file in runtime storage: ${file}`);
  if (kind === 'directory' && !stat.isDirectory()) throw new IntegrityError(`Expected directory in runtime storage: ${file}`);
  return stat;
}

async function atomicWrite(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode });
  await fs.rename(tmp, file);
}

async function acquire(lockDir, { retries = 200, delayMs = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      return async () => fs.rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === retries) throw new ConflictError(`Lock timeout: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new ConflictError(`Lock timeout: ${lockDir}`);
}

function stateDigest(state) {
  const copy = cloneJson(state);
  delete copy.integrity;
  return sha256(copy);
}

export class HashChainStore {
  constructor(root, { namespace = 'runs' } = {}) {
    this.root = path.resolve(root);
    this.namespace = identifier(namespace, 'namespace');
  }

  recordDir(id) { return path.join(this.root, this.namespace, identifier(id, 'record_id')); }
  stateFile(id) { return path.join(this.recordDir(id), 'state.json'); }
  eventsFile(id) { return path.join(this.recordDir(id), 'events.jsonl'); }
  lockDir(id) { return `${this.recordDir(id)}.lock`; }

  async assertRecordSafe(id, { eventsOptional = true } = {}) {
    await assertSafePath(this.recordDir(id), { kind: 'directory' });
    await assertSafePath(this.stateFile(id), { kind: 'file' });
    await assertSafePath(this.eventsFile(id), { kind: 'file', optional: eventsOptional });
  }

  async create(id, initial, event = { type: 'created', actor: 'system', data: {} }) {
    const dir = this.recordDir(id);
    if (await exists(dir)) throw new ConflictError(`Record already exists: ${id}`);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: false, mode: 0o700 });
    await assertSafePath(dir, { kind: 'directory' });
    const state = cloneJson(initial);
    state.revision = 0;
    state.event_head = { seq: 0, hash: '0'.repeat(64) };
    state.integrity = { state_digest: stateDigest(state) };
    await atomicWrite(this.stateFile(id), `${JSON.stringify(state, null, 2)}\n`);
    return this.update(id, ({ state: next, emit }) => {
      emit(event.type, event.actor, event.data ?? {});
      return next;
    }, { expectedRevision: 0 });
  }

  async read(id, { verifyEvents = true, consistencyRetries = 20, consistencyDelayMs = 2 } = {}) {
    for (let attempt = 0; attempt <= consistencyRetries; attempt += 1) {
      await this.assertRecordSafe(id);
      const state = JSON.parse(await fs.readFile(this.stateFile(id), 'utf8'));
      if (state.integrity?.state_digest !== stateDigest(state)) throw new IntegrityError(`State digest mismatch for ${id}`);
      if (!verifyEvents) return state;
      try {
        await this.verifyEvents(id, state.event_head);
        return state;
      } catch (error) {
        const transientHeadRace = error instanceof IntegrityError && /Event head mismatch/.test(error.message);
        if (!transientHeadRace || attempt === consistencyRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, consistencyDelayMs));
      }
    }
    throw new IntegrityError(`Unable to obtain a consistent state snapshot for ${id}`);
  }

  async update(id, mutator, { expectedRevision = null } = {}) {
    const release = await acquire(this.lockDir(id));
    try {
      const state = await this.read(id);
      if (expectedRevision != null && state.revision !== expectedRevision) {
        throw new ConflictError(`Stale revision for ${id}`, { expected: expectedRevision, actual: state.revision });
      }
      const pending = [];
      const emit = (type, actor, data = {}) => {
        if (typeof type !== 'string' || !type) throw new ValidationError('Event type is required');
        pending.push({ type, actor: actor ?? 'system', data: cloneJson(data) });
      };
      const next = cloneJson(state);
      const result = await mutator({ state: next, emit });
      if (result && result !== next) throw new ValidationError('Store mutator must mutate and return the provided state or undefined');
      let head = { ...state.event_head };
      const lines = [];
      for (const item of pending) {
        const envelope = {
          seq: head.seq + 1,
          at: new Date().toISOString(),
          type: item.type,
          actor: item.actor,
          data: item.data,
          previous_hash: head.hash,
        };
        envelope.hash = sha256(envelope);
        lines.push(canonicalJson(envelope));
        head = { seq: envelope.seq, hash: envelope.hash };
      }
      next.revision = state.revision + 1;
      next.event_head = head;
      next.updated_at = new Date().toISOString();
      next.integrity = { state_digest: stateDigest(next) };
      if (lines.length) {
        await assertSafePath(this.eventsFile(id), { kind: 'file', optional: true });
        await fs.appendFile(this.eventsFile(id), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      await assertSafePath(this.stateFile(id), { kind: 'file' });
      await atomicWrite(this.stateFile(id), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    } finally {
      await release();
    }
  }

  async verifyEvents(id, expectedHead = null) {
    await assertSafePath(this.recordDir(id), { kind: 'directory' });
    await assertSafePath(this.eventsFile(id), { kind: 'file', optional: true });
    let text = '';
    try { text = await fs.readFile(this.eventsFile(id), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let previous = '0'.repeat(64);
    let seq = 0;
    for (const [index, line] of text.split('\n').filter(Boolean).entries()) {
      let event;
      try { event = JSON.parse(line); } catch { throw new IntegrityError(`Malformed event at line ${index + 1}`); }
      const hash = event.hash;
      const copy = { ...event };
      delete copy.hash;
      if (event.seq !== seq + 1 || event.previous_hash !== previous || sha256(copy) !== hash) throw new IntegrityError(`Event chain mismatch at line ${index + 1}`);
      seq = event.seq;
      previous = hash;
    }
    const head = { seq, hash: previous };
    if (expectedHead && (expectedHead.seq !== head.seq || expectedHead.hash !== head.hash)) throw new IntegrityError(`Event head mismatch for ${id}`);
    return head;
  }

  async list() {
    const dir = path.join(this.root, this.namespace);
    try {
      await assertSafePath(dir, { kind: 'directory' });
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.lock'))
        .map((entry) => entry.name).sort();
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}

export { atomicWrite };
