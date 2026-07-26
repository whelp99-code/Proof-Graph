import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSseStream } from '../hosts/opencode-client.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';

function base(value) {
  const url = new URL(value ?? 'http://127.0.0.1:8742');
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new PolicyError('Operator client requires loopback HTTP');
  return url.toString().replace(/\/$/, '');
}

export async function readOperatorToken(dataDir) {
  const file = path.join(path.resolve(dataDir), '.operator-api-token');
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PolicyError('Operator token path must be a regular file');
  if ((stat.mode & 0o077) !== 0 && process.platform !== 'win32') throw new PolicyError('Operator token file permissions are too broad');
  const value = (await fs.readFile(file, 'utf8')).trim();
  if (value.length < 40) throw new ValidationError('Invalid operator token file');
  return value;
}

export class OperatorClient {
  constructor({ url = 'http://127.0.0.1:8742', token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    if (!token) throw new ValidationError('Operator token is required');
    this.url = base(url); this.token = token; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }

  async request(method, endpoint, body = null, { idempotency = method !== 'GET', timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.url}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body == null ? {} : { 'content-type': 'application/json' }),
          ...(idempotency ? { 'idempotency-key': `command_${randomUUID().replaceAll('-', '')}` } : {}),
        },
        body: body == null ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text(); let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      if (!response.ok || parsed.ok === false) throw new PolicyError(parsed.message ?? parsed.error ?? `Request failed (${response.status})`, parsed);
      return parsed;
    } finally { clearTimeout(timer); }
  }

  health() { return this.request('GET', '/v1/health', null, { idempotency: false }); }
  runs() { return this.request('GET', '/v1/runs', null, { idempotency: false }).then((value) => value.runs); }
  run(runId) { return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`, null, { idempotency: false }).then((value) => value.run); }
  timeline(runId, after = 0) { return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/timeline?after=${after}`, null, { idempotency: false }).then((value) => value.events); }
  intelligence(runId, section = 'intelligence', { full = false } = {}) { return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/${encodeURIComponent(section)}${full ? '?full=true' : ''}`, null, { idempotency: false }).then((value) => value.value); }
  contexts(runId, options) { return this.intelligence(runId, 'context', options); }
  routes(runId, options) { return this.intelligence(runId, 'routes', options); }
  modelObservations(runId, options) { return this.intelligence(runId, 'model-observations', options); }
  contracts(runId, options) { return this.intelligence(runId, 'contracts', options); }
  knowledge(runId, options) { return this.intelligence(runId, 'knowledge', options); }
  memory(runId, options) { return this.intelligence(runId, 'memory', options); }
  verification(runId, options) { return this.intelligence(runId, 'verification', options); }
  impact(runId, sourceIds, depth = 2) { const query = new URLSearchParams({ depth: String(depth) }); for (const source of sourceIds) query.append('source', source); return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/impact?${query}`, null, { idempotency: false }).then((value) => value.value); }
  approvals() { return this.request('GET', '/v1/approvals', null, { idempotency: false }).then((value) => value.approvals); }
  hosts() { return this.request('GET', '/v1/hosts', null, { idempotency: false }).then((value) => value.hosts); }
  createRun(input) { return this.request('POST', '/v1/runs', input).then((value) => value.run); }
  pause(runId, reason) { return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/pause`, { reason }).then((value) => value.run); }
  resume(runId) { return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/resume`, {}).then((value) => value.run); }
  abort(runId, reason) { return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/abort`, { reason }).then((value) => value.run); }
  retry(runId, nodeId, reason) { return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`, { reason }).then((value) => value.run); }
  decide(runId, approvalId, decision, reason) { return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`, { decision, reason }).then((value) => value.run); }
  connectOpenCode(base_url) { return this.request('POST', '/v1/hosts/opencode/connect', { base_url }).then((value) => value.host); }
  shutdown() { return this.request('POST', '/v1/shutdown', {}); }

  async *events({ runId = null, signal, after = 0 } = {}) {
    const endpoint = runId ? `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}` : `/v1/events?after=${after}`;
    const response = await this.fetchImpl(`${this.url}${endpoint}`, { headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, signal });
    if (!response.ok) throw new PolicyError(`SSE connection failed (${response.status})`);
    for await (const frame of parseSseStream(response.body, { signal })) yield frame;
  }
}
