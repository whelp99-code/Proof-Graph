import { PolicyError, ValidationError } from '../core/errors.mjs';

function assertBaseUrl(value, { allowRemote = false } = {}) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (!allowRemote && (!loopback || url.protocol !== 'http:')) throw new PolicyError('OpenCode server must use loopback HTTP unless allowRemote is enabled');
  if (allowRemote && !loopback && url.protocol !== 'https:') throw new PolicyError('Remote OpenCode server requires HTTPS');
  return url.toString().replace(/\/$/, '');
}

export function normalizeOpenCodeEvent(event, context = {}) {
  const payload = event?.properties ?? event?.data ?? event ?? {};
  const type = String(event?.type ?? payload?.type ?? 'opencode.unknown');
  const sessionId = payload.sessionID ?? payload.session_id ?? payload.session?.id ?? context.session_id ?? null;
  const tool = payload.tool ?? payload.name ?? payload.part?.tool ?? null;
  const normalized = {
    schema_version: 1,
    host: 'opencode',
    type,
    at: new Date().toISOString(),
    session_id: sessionId,
    project_id: context.project_id ?? payload.projectID ?? payload.project_id ?? null,
    run_id: context.run_id ?? payload.run_id ?? null,
    node_id: context.node_id ?? payload.node_id ?? null,
    tool,
    status: payload.status?.type ?? payload.status ?? null,
    model: payload.model ?? payload.modelID ?? payload.model_id ?? null,
    data: payload,
  };
  if (type === 'session.error') normalized.severity = 'error';
  else if (type === 'permission.asked') normalized.severity = 'attention';
  else normalized.severity = 'info';
  return normalized;
}

export async function* parseSseStream(body, { signal } = {}) {
  if (!body?.getReader) throw new ValidationError('ReadableStream body is required');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const split = buffer.search(/\r?\n\r?\n/);
        if (split < 0) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, '');
        let eventName = 'message';
        let id = null;
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const raw = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') eventName = raw;
          else if (field === 'id') id = raw;
          else if (field === 'data') data.push(raw);
        }
        if (!data.length) continue;
        const text = data.join('\n');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        yield { event: eventName, id, data: parsed };
      }
    }
  } finally { reader.releaseLock(); }
}

export class OpenCodeClient {
  constructor({ baseUrl = 'http://127.0.0.1:4096', fetchImpl = globalThis.fetch, allowRemote = false, timeoutMs = 10_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetch implementation is required');
    this.baseUrl = assertBaseUrl(baseUrl, { allowRemote });
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
        signal: options.signal ?? controller.signal,
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!response.ok) throw new PolicyError(`OpenCode request failed (${response.status})`, body);
      return body;
    } finally { clearTimeout(timer); }
  }

  health() { return this.request('/global/health'); }
  currentProject() { return this.request('/project/current'); }
  projects() { return this.request('/project'); }

  async *events({ signal, context = {} } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}/global/event`, { headers: { accept: 'text/event-stream' }, signal });
    if (!response.ok) throw new PolicyError(`OpenCode SSE failed (${response.status})`);
    for await (const frame of parseSseStream(response.body, { signal })) {
      yield normalizeOpenCodeEvent(frame.data, context);
    }
  }
}
