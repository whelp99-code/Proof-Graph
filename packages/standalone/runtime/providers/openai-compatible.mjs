import { PolicyError, ValidationError } from '../core/errors.mjs';

function cleanBaseUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (!loopback && url.protocol !== 'https:') throw new PolicyError('Remote model endpoints require HTTPS');
  if (loopback && !['http:', 'https:'].includes(url.protocol)) throw new PolicyError('Unsupported local model endpoint protocol');
  return url.toString().replace(/\/$/, '');
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey = null, model, fetchImpl = globalThis.fetch, timeoutMs = 120_000, provider = 'openai-compatible', local = false } = {}) {
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetch implementation is required');
    if (!model || typeof model !== 'string') throw new ValidationError('model is required');
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.provider = provider;
    this.local = local;
  }

  async invoke({ messages, responseFormat = null, temperature = 0, maxTokens = 4096, metadata = {} } = {}) {
    if (!Array.isArray(messages) || !messages.length) throw new ValidationError('messages must be a non-empty array');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const started = Date.now();
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens, ...(responseFormat ? { response_format: responseFormat } : {}), metadata }),
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { throw new PolicyError(`Model provider returned malformed JSON (${response.status})`); }
      if (!response.ok) throw new PolicyError(body?.error?.message ?? `Model provider failed (${response.status})`, { status: response.status });
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new PolicyError('Model provider returned no text content');
      return {
        provider: this.provider,
        model_id: body.model ?? this.model,
        request_id: body.id ?? null,
        content,
        finish_reason: choice.finish_reason ?? null,
        usage: {
          prompt_tokens: Number(body.usage?.prompt_tokens ?? 0),
          completion_tokens: Number(body.usage?.completion_tokens ?? 0),
          total_tokens: Number(body.usage?.total_tokens ?? 0),
          latency_ms: Date.now() - started,
        },
      };
    } finally { clearTimeout(timer); }
  }
}
