import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { compileDynamicGraph } from '../../server/lib/graph-compiler.mjs';
import { ValidationError } from '../../server/lib/errors.mjs';
import {
  HOST_PROTOCOL_VERSION,
  classifyToolRisk,
  hostCapabilities,
  normalizeHostCommand,
  normalizeHostEvent,
  normalizeToolPolicyDecision,
  normalizeToolPolicyRequest,
} from './protocol.mjs';

const DEFAULT_MAX_BODY = 512_000;

function requireBridgeIdentity(actualHost, configuredHost) {
  if (actualHost === configuredHost) return;
  const error = new Error(`Host identity mismatch: bridge is ${configuredHost}, request claimed ${actualHost}`);
  error.statusCode = 403;
  error.details = { configured_host: configuredHost, requested_host: actualHost };
  throw error;
}

function requireHostCommandAuthority(command) {
  // OpenCode's model-visible plugin deliberately excludes human-gate authority.
  // Enforce that boundary again at the bridge so a caller cannot bypass it by
  // constructing a raw authenticated command. Operators use the local
  // `proofgraph approve|abort` CLI path instead.
  if (command.host === 'opencode' && ['approve', 'deny', 'abort'].includes(command.command)) {
    const error = new Error(`Host ${command.host} is not authorized for operator command ${command.command}`);
    error.statusCode = 403;
    error.details = { host: command.host, command: command.command, operator_path: 'proofgraph CLI' };
    throw error;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); }
}

function normalizeObjectivePayload(payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const objective = typeof value.objective === 'string' ? value.objective.trim() : '';
  if (objective.length < 1 || objective.length > 10_000) throw new ValidationError('payload.objective must contain 1..10000 characters');
  return {
    objective,
    mode: typeof value.mode === 'string' ? value.mode : 'auto',
    template: typeof value.template === 'string' ? value.template : null,
    signals: value.signals && typeof value.signals === 'object' && !Array.isArray(value.signals) ? structuredClone(value.signals) : undefined,
    constraints: value.constraints && typeof value.constraints === 'object' && !Array.isArray(value.constraints) ? structuredClone(value.constraints) : undefined,
    adapter: typeof value.adapter === 'string' ? value.adapter : undefined,
  };
}

function compileInput(templates, payload) {
  const selected = normalizeObjectivePayload(payload);
  const matched = selected.template ? null : templates.match(selected.objective);
  const templateName = selected.template ?? matched?.name;
  const base = {
    objective: selected.objective,
    mode: selected.mode,
    ...(selected.signals ? { signals: selected.signals } : {}),
    ...(selected.constraints ? { constraints: selected.constraints } : {}),
  };
  if (!templateName) return { input: base, metadata: { selection: 'none' }, adapter: selected.adapter };
  const applied = templates.apply(templateName, base);
  const { template, ...input } = applied;
  return {
    input,
    adapter: selected.adapter,
    metadata: {
      template,
      selection: selected.template ? 'explicit' : 'auto',
      ...(matched ? { matched_keyword: matched.keyword } : {}),
    },
  };
}

async function currentRevision(kernel, runId) {
  const status = await kernel.status(runId);
  return { status, revision: status.graph_revision ?? status.revision ?? 0 };
}

async function requireRevision(kernel, command) {
  if (!command.run_id || command.expected_revision == null) return null;
  const current = await currentRevision(kernel, command.run_id);
  if (current.revision !== command.expected_revision) {
    const error = new Error(`Stale host command revision: expected ${command.expected_revision}, current ${current.revision}`);
    error.statusCode = 409;
    error.details = { expected_revision: command.expected_revision, current_revision: current.revision };
    throw error;
  }
  return current.status;
}

async function executeHostCommand(command, platform) {
  const { kernel, templates, config } = platform;
  requireHostCommandAuthority(command);
  await requireRevision(kernel, command);
  switch (command.command) {
    case 'compile': {
      const compiled = compileInput(templates, command.payload);
      return { ...compileDynamicGraph(compiled.input), metadata: compiled.metadata };
    }
    case 'start': {
      const compiled = compileInput(templates, command.payload);
      return { ...(await kernel.start(compiled.input)), metadata: compiled.metadata };
    }
    case 'run': {
      const compiled = compileInput(templates, command.payload);
      return { ...(await kernel.run(compiled.input, { adapter: compiled.adapter ?? config.default_adapter })), metadata: compiled.metadata };
    }
    case 'resume': {
      if (!command.run_id) throw new ValidationError('run_id is required for resume');
      return kernel.resume(command.run_id, { adapter: command.payload.adapter ?? config.default_adapter });
    }
    case 'status': {
      if (!command.run_id) throw new ValidationError('run_id is required for status');
      return kernel.status(command.run_id);
    }
    case 'report': {
      if (!command.run_id) throw new ValidationError('run_id is required for report');
      return kernel.report(command.run_id, command.payload.format ?? 'json');
    }
    case 'integrity': {
      if (!command.run_id) throw new ValidationError('run_id is required for integrity');
      return kernel.integrity(command.run_id);
    }
    case 'approve':
    case 'deny': {
      if (!command.run_id) throw new ValidationError('run_id is required for approval decisions');
      const decision = command.command === 'approve' ? 'approved' : 'denied';
      return kernel.approve(command.run_id, {
        actor: 'human',
        approval_id: command.payload.approval_id,
        challenge: command.payload.challenge,
        decision,
        decision_source: command.payload.decision_source ?? 'external_human',
        comment: command.payload.comment ?? `Decision from ${command.host}`,
      });
    }
    case 'abort': {
      if (!command.run_id) throw new ValidationError('run_id is required for abort');
      return kernel.abort(command.run_id, command.payload.reason ?? `Aborted from ${command.host}`, 'coordinator');
    }
    default:
      throw new ValidationError(`Unsupported host command: ${command.command}`);
  }
}

async function defaultToolPolicy(request, platform, options = {}) {
  const risk = classifyToolRisk(request.tool, request.arguments);
  if (!risk.mutation && !risk.shell && !risk.external && !request.external_side_effect) {
    return normalizeToolPolicyDecision({ decision: 'allow', reason: 'Read-only host tool permitted by default policy', policy_revision: 1 });
  }
  if (!request.run_id) {
    return normalizeToolPolicyDecision({ decision: 'deny', reason: 'Mutation, shell, and external tools require an active ProofGraph run', policy_revision: 1 });
  }
  let status;
  try { status = await platform.kernel.status(request.run_id); }
  catch {
    return normalizeToolPolicyDecision({ decision: 'deny', reason: 'The referenced ProofGraph run does not exist or cannot be verified', policy_revision: 1 });
  }
  if (['finalized', 'failed', 'aborted', 'budget_exceeded'].includes(status.status)) {
    return normalizeToolPolicyDecision({ decision: 'deny', reason: `Run ${request.run_id} is terminal (${status.status})`, policy_revision: status.graph_revision ?? 1 });
  }
  if (risk.destructive || risk.external || request.external_side_effect) {
    return normalizeToolPolicyDecision({
      decision: 'require_approval',
      reason: 'External or destructive tool execution requires an explicit ProofGraph approval',
      approval: { run_id: request.run_id, tool: request.tool, risk },
      policy_revision: status.graph_revision ?? 1,
    });
  }
  const workspace = platform.workspace ? await platform.workspace.describe(request.run_id).catch(() => null) : null;
  const isolated = request.workspace_isolated === true || workspace?.isolated === true;
  if ((risk.mutation || risk.shell || request.mutation) && !isolated) {
    return normalizeToolPolicyDecision({ decision: 'deny', reason: 'Mutation or shell execution is allowed only in a ProofGraph isolated workspace', policy_revision: status.graph_revision ?? 1 });
  }
  if (options.allowIsolatedMutation === true && isolated) {
    return normalizeToolPolicyDecision({ decision: 'allow', reason: 'Isolated workspace mutation allowed by explicit bridge policy', policy_revision: status.graph_revision ?? 1 });
  }
  return normalizeToolPolicyDecision({
    decision: 'require_approval',
    reason: 'Mutation and shell tools require an explicit approval even inside an isolated workspace',
    approval: { run_id: request.run_id, tool: request.tool, risk, isolated },
    policy_revision: status.graph_revision ?? 1,
  });
}

export async function startHostBridge(options) {
  if (!options?.platform) throw new Error('startHostBridge requires platform');
  const platform = options.platform;
  const host = options.host ?? 'custom';
  const bind = options.bind ?? '127.0.0.1';
  const allowRemote = options.allowRemote === true;
  if (!allowRemote && !['127.0.0.1', '::1', 'localhost'].includes(bind)) {
    throw new Error('Host bridge binds only to loopback unless allowRemote=true');
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Host bridge port must be 0..65535');
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const token = options.token ?? crypto.randomBytes(32).toString('base64url');
  if (String(token).length < 24) throw new Error('Host bridge token must contain at least 24 characters');
  const dataDir = path.resolve(platform.config.data_dir);
  const eventDir = path.join(dataDir, 'host-events');
  await fs.mkdir(eventDir, { recursive: true, mode: 0o700 });
  const clients = new Set();

  const publish = (event) => {
    const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...clients]) {
      try { client.write(text); } catch { clients.delete(client); }
    }
  };

  const appendEvent = async (event) => {
    const normalized = normalizeHostEvent(event);
    const file = path.join(eventDir, `${normalized.host}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
    publish(normalized);
    return normalized;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/v1/health' && !safeEqual(bearerToken(req), token)) {
        return json(res, 401, { ok: false, error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return json(res, 200, {
          ok: true,
          product: 'proofgraph',
          protocol_version: HOST_PROTOCOL_VERSION,
          host,
          capabilities: hostCapabilities(host),
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        return json(res, 200, { ok: true, protocol_version: HOST_PROTOCOL_VERSION, hosts: ['opencode', 'pi', 'orca', 'custom'].map(hostCapabilities) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`event: bridge.connected\ndata: ${JSON.stringify({ protocol_version: HOST_PROTOCOL_VERSION, host, timestamp: new Date().toISOString() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const body = await readJson(req, maxBodyBytes);
        const normalizedEvent = normalizeHostEvent(body);
        requireBridgeIdentity(normalizedEvent.host, host);
        const event = await appendEvent(normalizedEvent);
        return json(res, 202, { ok: true, event });
      }
      if (req.method === 'POST' && url.pathname === '/v1/tool-policy') {
        const body = await readJson(req, maxBodyBytes);
        const request = normalizeToolPolicyRequest(body);
        requireBridgeIdentity(request.host, host);
        const decision = options.toolPolicy
          ? normalizeToolPolicyDecision(await options.toolPolicy(request, platform))
          : await defaultToolPolicy(request, platform, options);
        await appendEvent({
          host: request.host,
          type: 'tool.requested',
          run_id: request.run_id,
          session_id: request.session_id,
          node_id: request.node_id,
          request_id: request.request_id,
          payload: { tool: request.tool, decision: decision.decision, reason: decision.reason },
        });
        return json(res, 200, { ok: true, request_id: request.request_id, decision });
      }
      if (req.method === 'POST' && url.pathname === '/v1/commands') {
        const body = await readJson(req, maxBodyBytes);
        const command = normalizeHostCommand(body);
        requireBridgeIdentity(command.host, host);
        const result = await executeHostCommand(command, platform);
        await appendEvent({
          host: command.host,
          type: 'ui.command',
          run_id: command.run_id ?? result?.run_id,
          request_id: command.request_id,
          revision: result?.graph_revision,
          payload: { command: command.command, ok: true },
        });
        return json(res, 200, { ok: true, request_id: command.request_id, result });
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const status = error.statusCode ?? (error instanceof ValidationError ? 400 : 500);
      return json(res, status, {
        ok: false,
        error: error.name ?? 'Error',
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    token,
    host: bind,
    port: actualPort,
    url: `http://${bind.includes(':') ? `[${bind}]` : bind}:${actualPort}`,
    close: () => new Promise((resolve) => {
      for (const client of clients) client.end();
      clients.clear();
      server.close(resolve);
    }),
  };
}
