const PROTOCOL_VERSION = 'proofgraph.host.v1';

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

export class ProofGraphBridgeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProofGraphBridgeError';
    this.details = details;
  }
}

export function bridgeConfigFromEnv(env = process.env, host = 'custom') {
  const url = env.PROOFGRAPH_HOST_URL ?? 'http://127.0.0.1:8743';
  const token = env.PROOFGRAPH_HOST_TOKEN ?? '';
  const allowRemote = env.PROOFGRAPH_HOST_ALLOW_REMOTE === '1';
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ProofGraphBridgeError('ProofGraph host URL must use HTTP or HTTPS');
  if (!allowRemote && !loopbackHost(parsed.hostname)) throw new ProofGraphBridgeError('ProofGraph host URL must be loopback unless PROOFGRAPH_HOST_ALLOW_REMOTE=1');
  return { url: parsed.toString().replace(/\/$/, ''), token, host, allowRemote };
}

export function createBridgeClient(options = {}) {
  const config = options.config ?? bridgeConfigFromEnv(options.env, options.host ?? 'custom');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ProofGraphBridgeError('fetch is required');
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request(pathname, body, requestOptions = {}) {
    if (!config.token || config.token.length < 24) throw new ProofGraphBridgeError('PROOFGRAPH_HOST_TOKEN is missing or too short');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ProofGraphBridgeError(`ProofGraph bridge timeout after ${timeoutMs}ms`)), requestOptions.timeoutMs ?? timeoutMs);
    timer.unref?.();
    const abort = () => controller.abort(requestOptions.signal?.reason ?? new ProofGraphBridgeError('ProofGraph bridge request aborted'));
    requestOptions.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(`${config.url}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { throw new ProofGraphBridgeError(`ProofGraph bridge returned malformed JSON (${response.status})`, { body: text.slice(0, 4000) }); }
      if (!response.ok || payload.ok === false) throw new ProofGraphBridgeError(payload.message ?? payload.error ?? `ProofGraph bridge request failed (${response.status})`, { status: response.status, payload });
      return payload;
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({
    config,
    async command(command, fields = {}, requestOptions = {}) {
      return request('/v1/commands', {
        protocol_version: PROTOCOL_VERSION,
        request_id: fields.request_id,
        host: config.host,
        command,
        run_id: fields.run_id,
        expected_revision: fields.expected_revision,
        payload: fields.payload ?? {},
      }, requestOptions);
    },
    async event(type, fields = {}, requestOptions = {}) {
      return request('/v1/events', {
        protocol_version: PROTOCOL_VERSION,
        host: config.host,
        type,
        event_id: fields.event_id,
        timestamp: fields.timestamp,
        run_id: fields.run_id,
        session_id: fields.session_id,
        node_id: fields.node_id,
        request_id: fields.request_id,
        revision: fields.revision,
        payload: fields.payload ?? {},
      }, requestOptions);
    },
    async toolPolicy(fields, requestOptions = {}) {
      return request('/v1/tool-policy', {
        protocol_version: PROTOCOL_VERSION,
        host: config.host,
        request_id: fields.request_id,
        run_id: fields.run_id,
        session_id: fields.session_id,
        node_id: fields.node_id,
        tool: fields.tool,
        arguments: fields.arguments ?? {},
        cwd: fields.cwd,
        workspace_isolated: fields.workspace_isolated === true,
        mutation: fields.mutation === true,
        external_side_effect: fields.external_side_effect === true,
      }, requestOptions);
    },
  });
}

export function likelyMutation(toolName) {
  return /(?:write|edit|patch|delete|move|rename|bash|shell|exec|command|terminal)/i.test(String(toolName ?? ''));
}

export function likelyExternalSideEffect(toolName) {
  return /(?:webfetch|http|browser|email|message|publish|deploy)/i.test(String(toolName ?? ''));
}
