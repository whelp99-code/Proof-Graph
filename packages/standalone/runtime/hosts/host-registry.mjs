import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson } from '../core/canonical.mjs';
import { ConflictError, ValidationError } from '../core/errors.mjs';
import { identifier } from '../core/validate.mjs';

function nowIso() { return new Date().toISOString(); }

export class HostRegistry {
  constructor({ dataDir, maxRecentEvents = 200 } = {}) {
    this.store = new HashChainStore(dataDir, { namespace: 'hosts' });
    this.maxRecentEvents = maxRecentEvents;
  }

  async ensure(hostId, options = {}) {
    const id = identifier(hostId, 'host_id');
    try { return await this.store.read(id); }
    catch (error) {
      if (!/ENOENT|no such file|Record/i.test(`${error.code ?? ''} ${error.message}`)) throw error;
    }
    return this.store.create(id, {
      schema_version: 1,
      host_id: id,
      name: options.name ?? id,
      type: options.type ?? id,
      base_url: options.base_url ?? null,
      status: options.status ?? 'disconnected',
      version: options.version ?? null,
      project: options.project ?? null,
      sessions: {},
      counters: {},
      recent_events: [],
      connected_at: null,
      disconnected_at: null,
      last_event_at: null,
      created_at: nowIso(),
    }, { type: 'host.registered', actor: 'control-plane', data: { host_id: id } });
  }

  async connected(hostId, details = {}) {
    await this.ensure(hostId, details);
    return this.store.update(hostId, ({ state, emit }) => {
      state.status = 'connected'; state.connected_at = nowIso(); state.disconnected_at = null;
      state.version = details.version ?? state.version; state.base_url = details.base_url ?? state.base_url;
      state.project = details.project ?? state.project;
      emit('host.connected', 'host-registry', { host_id: hostId, version: state.version, project: state.project });
      return state;
    });
  }

  async disconnected(hostId, reason = 'connection closed') {
    await this.ensure(hostId);
    return this.store.update(hostId, ({ state, emit }) => {
      state.status = 'disconnected'; state.disconnected_at = nowIso();
      emit('host.disconnected', 'host-registry', { host_id: hostId, reason: String(reason) });
      return state;
    });
  }

  async ingest(hostId, event) {
    if (!event || typeof event !== 'object') throw new ValidationError('Host event object is required');
    await this.ensure(hostId);
    return this.store.update(hostId, ({ state, emit }) => {
      const type = String(event.type ?? 'host.event');
      state.last_event_at = nowIso();
      state.status = 'connected';
      state.counters[type] = Number(state.counters[type] ?? 0) + 1;
      if (event.session_id) {
        const current = state.sessions[event.session_id] ?? { session_id: event.session_id, status: 'unknown', events: 0 };
        current.status = event.status ?? (type === 'session.idle' ? 'idle' : type === 'session.error' ? 'error' : current.status);
        current.model = event.model ?? current.model ?? null;
        current.tool = event.tool ?? current.tool ?? null;
        current.run_id = event.run_id ?? current.run_id ?? null;
        current.node_id = event.node_id ?? current.node_id ?? null;
        current.events += 1; current.last_event_at = state.last_event_at;
        state.sessions[event.session_id] = current;
      }
      state.recent_events.push(cloneJson({ ...event, received_at: state.last_event_at }));
      if (state.recent_events.length > this.maxRecentEvents) state.recent_events.splice(0, state.recent_events.length - this.maxRecentEvents);
      emit('host.event', hostId, { type, session_id: event.session_id ?? null, run_id: event.run_id ?? null, node_id: event.node_id ?? null });
      return state;
    });
  }

  async get(hostId) { return this.store.read(identifier(hostId, 'host_id')); }
  async list() {
    const ids = await this.store.list();
    const result = [];
    for (const id of ids) {
      try { result.push(await this.store.read(id)); } catch { /* corrupted host stays out; integrity endpoint reports it */ }
    }
    return result;
  }

  async bindSession(hostId, sessionId, { run_id, node_id } = {}) {
    if (!sessionId) throw new ValidationError('session_id is required');
    await this.ensure(hostId);
    return this.store.update(hostId, ({ state, emit }) => {
      const current = state.sessions[sessionId] ?? { session_id: sessionId, status: 'unknown', events: 0 };
      if (current.run_id && run_id && current.run_id !== run_id) throw new ConflictError('Session is already bound to another run');
      current.run_id = run_id ?? current.run_id ?? null;
      current.node_id = node_id ?? current.node_id ?? null;
      state.sessions[sessionId] = current;
      emit('host.session_bound', 'operator', { session_id: sessionId, run_id: current.run_id, node_id: current.node_id });
      return state;
    });
  }
}
