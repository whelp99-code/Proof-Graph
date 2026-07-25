import { StateError, ValidationError } from '../../server/lib/errors.mjs';
import { identifier } from '../../server/lib/validate.mjs';

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(name, adapter) {
    const id = identifier(name, 'adapter name');
    if (!adapter || typeof adapter.invoke !== 'function') throw new ValidationError(`Adapter ${id} must implement invoke()`);
    if (this.adapters.has(id)) throw new ValidationError(`Adapter already registered: ${id}`);
    this.adapters.set(id, adapter);
    return adapter;
  }

  replace(name, adapter) {
    const id = identifier(name, 'adapter name');
    if (!adapter || typeof adapter.invoke !== 'function') throw new ValidationError(`Adapter ${id} must implement invoke()`);
    this.adapters.set(id, adapter);
    return adapter;
  }

  get(name) {
    const id = identifier(name, 'adapter name');
    const adapter = this.adapters.get(id);
    if (!adapter) throw new StateError(`Adapter is not registered: ${id}`);
    return adapter;
  }

  has(name) {
    return this.adapters.has(name);
  }

  list() {
    return [...this.adapters.entries()].map(([name, adapter]) => ({ name, manifest: structuredClone(adapter.manifest) }));
  }

  async doctor() {
    const results = [];
    for (const [name, adapter] of this.adapters) {
      try {
        const result = { name, ...(await adapter.doctor()) };
        const enabled = result.enabled !== false;
        const available = result.ok === true;
        const status = !enabled
          ? 'disabled'
          : available
            ? (result.live_canary_required === true ? 'ready_for_canary' : 'ready')
            : (result.code === 'ENOENT' ? 'unavailable' : 'error');
        results.push({ ...result, status, invocable: enabled && available });
      } catch (error) {
        results.push({ name, ok: false, status: 'error', invocable: false, error: error.message });
      }
    }
    return results;
  }
}
