import { AgentAdapter } from './base.mjs';
import { OpenCodeExecutionHost } from '../hosts/opencode.mjs';

export class OpenCodeServerAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    this.host = options.host ?? new OpenCodeExecutionHost(options);
  }

  doctor() { return this.host.doctor(); }

  async invoke(input, signal) {
    const request = this.normalizeRequest(input);
    const result = await this.host.execute(request, signal);
    return this.normalizeResult(result);
  }
}
