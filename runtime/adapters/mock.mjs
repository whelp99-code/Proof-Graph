import { AgentAdapter, AdapterError, withTimeout } from './base.mjs';

function defaultResult(request) {
  const kind = request.node.kind;
  if (kind === 'verify') {
    return {
      outcome: 'success',
      summary: `Verified ${request.node.node_id}`,
      output: { verification: { passed: true, checks: ['mock-contract'] }, result: { mock: true } },
    };
  }
  return {
    outcome: 'success',
    summary: `Completed ${request.node.node_id}`,
    output: kind === 'direct'
      ? { result: { mock: true, kind }, route: 'synthesize' }
      : { result: { mock: true, kind } },
  };
}

export class MockAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    this.handler = options.handler ?? defaultResult;
    this.calls = [];
    this.delay_ms = options.delay_ms ?? 0;
  }

  async doctor() {
    return { ok: true, adapter: this.manifest.adapter, agent_id: this.manifest.agent_id, mode: 'mock' };
  }

  async invoke(input, externalSignal) {
    const request = this.normalizeRequest(input);
    this.calls.push(structuredClone(request));
    return withTimeout(async (signal) => {
      if (this.delay_ms > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delay_ms);
          const abort = () => { clearTimeout(timer); reject(signal.reason ?? new AdapterError('Mock call aborted')); };
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (signal.aborted) throw signal.reason ?? new AdapterError('Mock call aborted');
      const raw = await this.handler(request, { signal, calls: this.calls });
      return this.normalizeResult(raw);
    }, this.manifest.timeout_ms, externalSignal);
  }
}
