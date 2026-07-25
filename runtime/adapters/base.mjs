import { ValidationError } from '../../server/lib/errors.mjs';
import { normalizeAgentManifest, normalizeAgentRequest, normalizeAgentResult } from '../contracts.mjs';

export class AdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.details = details;
  }
}

export class AgentAdapter {
  constructor(manifest) {
    this.manifest = normalizeAgentManifest(manifest);
  }

  async doctor() {
    return { ok: true, adapter: this.manifest.adapter, agent_id: this.manifest.agent_id, mode: 'base' };
  }

  async invoke(_request, _signal) {
    throw new AdapterError('Adapter.invoke() is not implemented');
  }

  normalizeRequest(request) {
    return normalizeAgentRequest(request);
  }

  normalizeResult(result) {
    return normalizeAgentResult(result, { maxOutputBytes: this.manifest.max_output_bytes });
  }
}

export async function withTimeout(promiseFactory, timeoutMs, externalSignal = undefined) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ValidationError('timeoutMs must be a positive integer');
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason ?? new Error('External abort'));
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AdapterError(`Adapter timed out after ${timeoutMs}ms`, { timeout_ms: timeoutMs })), timeoutMs);
  timer.unref?.();
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}
