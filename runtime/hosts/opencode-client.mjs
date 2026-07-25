import { AdapterError } from '../adapters/base.mjs';

export class OpenCodeHttpError extends AdapterError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'OpenCodeHttpError';
  }
}

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function normalizeBaseUrl(value, options = {}) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new OpenCodeHttpError('OpenCode baseUrl must be a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new OpenCodeHttpError('OpenCode baseUrl must use HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new OpenCodeHttpError('OpenCode baseUrl must not embed credentials');
  const loopback = loopbackHost(parsed.hostname);
  if (!loopback && options.allowRemote !== true) {
    throw new OpenCodeHttpError('OpenCode server must use a loopback address unless allowRemote=true');
  }
  if (!loopback && parsed.protocol !== 'https:' && options.allowInsecureRemote !== true) {
    throw new OpenCodeHttpError('Remote OpenCode servers require HTTPS unless allowInsecureRemote=true');
  }
  if (!loopback && !options.password) {
    throw new OpenCodeHttpError('Remote OpenCode servers require HTTP basic authentication');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function joinUrl(base, pathname) {
  return new URL(pathname.replace(/^\//, ''), `${String(base).replace(/\/+$/, '')}/`).toString();
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new OpenCodeHttpError(`OpenCode response exceeded ${maxBytes} bytes`, { max_bytes: maxBytes });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function basicAuth(username, password) {
  if (!password) return null;
  return `Basic ${Buffer.from(`${username ?? 'opencode'}:${password}`, 'utf8').toString('base64')}`;
}

function collectText(value, output = [], seen = new Set()) {
  if (value == null) return output;
  if (typeof value === 'string') {
    if (value.trim()) output.push(value);
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value)) {
    for (const key of ['text', 'content', 'message', 'output']) {
      if (typeof value[key] === 'string' && value[key].trim()) output.push(value[key]);
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectText(child, output, seen);
  return output;
}

export function openCodeMessageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : message;
  return [...new Set(collectText(parts))].join('\n');
}

export function eventSessionId(event) {
  const queue = [event];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)) {
      for (const key of ['sessionID', 'sessionId', 'session_id']) {
        if (typeof value[key] === 'string' && value[key]) return value[key];
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

export function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const raw of String(block).split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue;
    const index = raw.indexOf(':');
    const field = index < 0 ? raw : raw.slice(0, index);
    const value = index < 0 ? '' : raw.slice(index + 1).replace(/^ /, '');
    if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  const text = data.join('\n');
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new OpenCodeHttpError('OpenCode SSE emitted malformed JSON', { event, data: text.slice(0, 4000) }); }
  return { event, data: payload };
}

export class OpenCodeClient {
  constructor(options = {}) {
    this.username = options.username ?? 'opencode';
    this.password = options.password ?? null;
    this.allowRemote = options.allowRemote === true;
    this.allowInsecureRemote = options.allowInsecureRemote === true;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:4096', {
      allowRemote: this.allowRemote,
      allowInsecureRemote: this.allowInsecureRemote,
      password: this.password,
    });
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 100_000_000) {
      throw new OpenCodeHttpError('OpenCode maxResponseBytes must be an integer between 1024 and 100000000');
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new OpenCodeHttpError('A fetch implementation is required');
  }

  headers(extra = {}) {
    const authorization = basicAuth(this.username, this.password);
    return {
      accept: 'application/json',
      ...(authorization ? { authorization } : {}),
      ...extra,
    };
  }

  async request(method, pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new OpenCodeHttpError(`OpenCode HTTP timeout after ${this.timeoutMs}ms`)), options.timeoutMs ?? this.timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(options.signal?.reason ?? new OpenCodeHttpError('OpenCode request aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const response = await this.fetch(joinUrl(this.baseUrl, pathname), {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await readBoundedBody(response, this.maxResponseBytes).catch(() => '');
        throw new OpenCodeHttpError(`OpenCode ${method} ${pathname} failed with ${response.status}`, {
          status: response.status,
          body: text.slice(0, 20_000),
        });
      }
      if (response.status === 204) return null;
      const text = await readBoundedBody(response, this.maxResponseBytes);
      if (!text.trim()) return null;
      try { return JSON.parse(text); }
      catch { throw new OpenCodeHttpError(`OpenCode ${method} ${pathname} returned malformed JSON`, { body: text.slice(0, 20_000) }); }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  health(options) { return this.request('GET', '/global/health', options); }
  currentProject(options) { return this.request('GET', '/project/current', options); }
  agents(options) { return this.request('GET', '/agent', options); }
  createSession(body = {}, options) { return this.request('POST', '/session', { ...options, body }); }
  session(sessionId, options) { return this.request('GET', `/session/${encodeURIComponent(sessionId)}`, options); }
  sessionStatus(options) { return this.request('GET', '/session/status', options); }
  abortSession(sessionId, options) { return this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, { ...options, body: {} }); }
  messages(sessionId, limit = 50, options) { return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message?limit=${encodeURIComponent(limit)}`, options); }
  diff(sessionId, options) { return this.request('GET', `/session/${encodeURIComponent(sessionId)}/diff`, options); }
  respondPermission(sessionId, permissionId, response, remember = false, options) {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      ...options,
      body: { response, remember },
    });
  }
  sendMessage(sessionId, body, options) {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/message`, { ...options, body });
  }
  promptAsync(sessionId, body, options) {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, { ...options, body });
  }
  showToast(message, variant = 'info', options) {
    return this.request('POST', '/tui/show-toast', { ...options, body: { message, variant } });
  }

  async *events(options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? new OpenCodeHttpError('OpenCode SSE aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await this.fetch(joinUrl(this.baseUrl, '/global/event'), {
        headers: this.headers({ accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      if (!response.ok) throw new OpenCodeHttpError(`OpenCode event stream failed with ${response.status}`, { status: response.status });
      if (!response.body) throw new OpenCodeHttpError('OpenCode event stream has no response body');
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        while (true) {
          if (Buffer.byteLength(buffer, 'utf8') > this.maxResponseBytes) throw new OpenCodeHttpError(`OpenCode SSE buffer exceeded ${this.maxResponseBytes} bytes`);
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const parsed = parseSseBlock(block);
          if (parsed) yield parsed;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) yield parsed;
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      try { controller.abort(); } catch {}
    }
  }
}
