import { AgentAdapter, AdapterError } from './base.mjs';

export class ConfiguredExtensionAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    this.reason = options.reason ?? 'External adapter configuration is required';
    this.integration = options.integration ?? 'module';
  }
  async doctor() {
    return { ok: false, adapter: this.manifest.adapter, agent_id: this.manifest.agent_id, mode: this.integration, enabled: false, live_canary_required: true, error: this.reason };
  }
  async invoke() { throw new AdapterError(this.reason); }
}
