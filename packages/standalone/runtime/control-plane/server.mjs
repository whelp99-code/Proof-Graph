import http from 'node:http';
import { PRODUCT_NAME, VERSION } from '../version.mjs';
import { URL } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { ControlPlane } from './control-plane.mjs';
import { ValidationError, PolicyError } from '../core/errors.mjs';

function loopbackHost(host) { return ['127.0.0.1', '::1', 'localhost'].includes(host); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? '')); const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
function bearer(req) { const value = req.headers.authorization ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : null; }
function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'");
}
function json(res, status, body) {
  securityHeaders(res); res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}
async function bodyJson(req, maxBytes = 1_048_576) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw new ValidationError('Request body too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Malformed JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('JSON object body required');
  return value;
}
function route(pathname, pattern) {
  const left = pathname.split('/').filter(Boolean); const right = pattern.split('/').filter(Boolean);
  if (left.length !== right.length) return null;
  const params = {};
  for (let index = 0; index < right.length; index += 1) {
    if (right[index].startsWith(':')) params[right[index].slice(1)] = decodeURIComponent(left[index]);
    else if (right[index] !== left[index]) return null;
  }
  return params;
}
function commandId(req) { return String(req.headers['idempotency-key'] ?? `command_${randomUUID().replaceAll('-', '')}`); }

export async function createControlPlaneServer({
  controlPlane = new ControlPlane(), host = '127.0.0.1', port = 8742, allowRemote = false,
  pollMs = 250, maxSseClients = 32,
} = {}) {
  if (!allowRemote && !loopbackHost(host)) throw new PolicyError('Control Plane binds to loopback by default');
  await controlPlane.init();
  const operatorToken = await controlPlane.operatorToken();
  const hostToken = await controlPlane.hostToken();
  let sseClients = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/v1/health') return json(res, 200, { ok: true, product: PRODUCT_NAME, version: VERSION, model_registry: controlPlane.company.intelligence ? { version: controlPlane.company.intelligence.router.registry.registry_version, digest: controlPlane.company.intelligence.router.registry.digest, models: controlPlane.company.intelligence.router.registry.entries.length } : null });

      const hostIngest = req.method === 'POST' && route(pathname, '/v1/hosts/:hostId/events');
      if (hostIngest) {
        if (!safeEqual(req.headers['x-proofgraph-host-token'], hostToken)) return json(res, 401, { ok: false, error: 'unauthorized_host' });
        const event = await bodyJson(req, 512_000);
        const result = await controlPlane.ingestHostEvent(hostIngest.hostId, event);
        return json(res, 202, { ok: true, revision: result.revision });
      }

      if (!safeEqual(bearer(req), operatorToken)) return json(res, 401, { ok: false, error: 'unauthorized' });

      if (req.method === 'GET' && pathname === '/v1/config') return json(res, 200, { ok: true, data_dir: controlPlane.dataDir, token_files: controlPlane.tokenFiles(), model_registry: controlPlane.company.intelligence ? { version: controlPlane.company.intelligence.router.registry.registry_version, digest: controlPlane.company.intelligence.router.registry.digest, models: controlPlane.company.intelligence.router.registry.entries.map((entry) => ({ model_id: entry.model_id, provider: entry.provider, host: entry.host, enabled: entry.enabled, capabilities: entry.capabilities, risk_ceiling: entry.risk_ceiling })) } : null });
      if (req.method === 'POST' && pathname === '/v1/shutdown') {
        json(res, 202, { ok: true, status: 'shutting_down' });
        setTimeout(() => { for (const connection of controlPlane.hostConnections.values()) connection.controller.abort(); server.close(); }, 25).unref?.();
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/runs') return json(res, 200, { ok: true, runs: await controlPlane.listRuns() });
      if (req.method === 'POST' && pathname === '/v1/runs') {
        const input = await bodyJson(req);
        const type = input.type ?? 'mission';
        const clean = Object.fromEntries(Object.entries({ objective: input.objective, signals: input.signals, constraints: input.constraints, metadata: input.metadata, max_cycles: input.max_cycles }).filter(([, value]) => value !== undefined));
        const result = await controlPlane.command(commandId(req), { action: 'run.create', input }, () => type === 'organization_os'
          ? controlPlane.createOS(clean, { auto_start: input.auto_start !== false })
          : controlPlane.createMission(clean, { auto_start: input.auto_start !== false }));
        return json(res, 201, { ok: true, run: result });
      }
      if (req.method === 'GET' && pathname === '/v1/approvals') return json(res, 200, { ok: true, approvals: await controlPlane.pendingApprovals() });
      if (req.method === 'GET' && pathname === '/v1/hosts') return json(res, 200, { ok: true, hosts: await controlPlane.hosts.list() });
      if (req.method === 'POST' && pathname === '/v1/hosts/opencode/connect') {
        const input = await bodyJson(req);
        const result = await controlPlane.command(commandId(req), { action: 'host.connect', target: 'opencode', input }, () => controlPlane.connectOpenCode(input));
        return json(res, 200, { ok: true, host: result });
      }
      if (req.method === 'POST' && pathname === '/v1/hosts/opencode/disconnect') {
        const result = await controlPlane.command(commandId(req), { action: 'host.disconnect', target: 'opencode' }, () => controlPlane.disconnectHost('opencode'));
        return json(res, 200, { ok: true, host: result });
      }

      const getRun = route(pathname, '/v1/runs/:runId');
      if (req.method === 'GET' && getRun) return json(res, 200, { ok: true, run: await controlPlane.runView(getRun.runId) });
      const getGraph = route(pathname, '/v1/runs/:runId/graph');
      if (req.method === 'GET' && getGraph) { const run = await controlPlane.runView(getGraph.runId); return json(res, 200, { ok: true, graph: run.graph ?? { cycles: run.cycles } }); }
      const getTimeline = route(pathname, '/v1/runs/:runId/timeline');
      if (req.method === 'GET' && getTimeline) return json(res, 200, { ok: true, events: await controlPlane.timeline(getTimeline.runId, { afterSeq: Number(url.searchParams.get('after') ?? 0), limit: Math.min(2000, Number(url.searchParams.get('limit') ?? 500)) }) });
      const intelligenceSections = [
        ['intelligence', 'summary'], ['context', 'contexts'], ['routes', 'routes'], ['model-observations', 'observations'], ['contracts', 'collaboration'],
        ['knowledge', 'knowledge'], ['memory', 'memory'], ['verification', 'verification'],
      ];
      for (const [pathName, section] of intelligenceSections) {
        const match = route(pathname, `/v1/runs/:runId/${pathName}`);
        if (req.method === 'GET' && match) {
          const value = await controlPlane.intelligenceView(match.runId, { section, full: url.searchParams.get('full') === 'true' });
          return json(res, 200, { ok: true, section, value });
        }
      }
      const getImpact = route(pathname, '/v1/runs/:runId/impact');
      if (req.method === 'GET' && getImpact) {
        const sourceIds = url.searchParams.getAll('source').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
        const value = await controlPlane.intelligenceView(getImpact.runId, { section: 'impact', sourceIds, maxDepth: Math.min(5, Math.max(1, Number(url.searchParams.get('depth') ?? 2))) });
        return json(res, 200, { ok: true, section: 'impact', value });
      }
      const getIntegrity = route(pathname, '/v1/runs/:runId/integrity');
      if (req.method === 'GET' && getIntegrity) {
        const result = String(getIntegrity.runId).startsWith('osrun_') ? await controlPlane.os.verifyIntegrity(getIntegrity.runId) : await controlPlane.company.verifyIntegrity(getIntegrity.runId);
        return json(res, 200, { ok: true, integrity: result });
      }
      const pause = route(pathname, '/v1/runs/:runId/pause');
      if (req.method === 'POST' && pause) { const input = await bodyJson(req); const result = await controlPlane.command(commandId(req), { action: 'run.pause', target: pause.runId, input }, () => controlPlane.pauseMission(pause.runId, input.reason)); return json(res, 200, { ok: true, run: await controlPlane.runView(result.mission.mission_id) }); }
      const resume = route(pathname, '/v1/runs/:runId/resume');
      if (req.method === 'POST' && resume) { const result = await controlPlane.command(commandId(req), { action: 'run.resume', target: resume.runId }, () => controlPlane.resumeMission(resume.runId)); return json(res, 200, { ok: true, run: await controlPlane.runView(result.mission.mission_id) }); }
      const abort = route(pathname, '/v1/runs/:runId/abort');
      if (req.method === 'POST' && abort) { const input = await bodyJson(req); await controlPlane.command(commandId(req), { action: 'run.abort', target: abort.runId, input }, () => controlPlane.abortRun(abort.runId, input.reason)); return json(res, 200, { ok: true, run: await controlPlane.runView(abort.runId) }); }
      const retry = route(pathname, '/v1/runs/:runId/nodes/:nodeId/retry');
      if (req.method === 'POST' && retry) { const input = await bodyJson(req); await controlPlane.command(commandId(req), { action: 'node.retry', target: retry.nodeId, input }, () => controlPlane.retryNode(retry.runId, retry.nodeId, input.reason)); return json(res, 200, { ok: true, run: await controlPlane.runView(retry.runId) }); }
      const decision = route(pathname, '/v1/runs/:runId/approvals/:approvalId/decision');
      if (req.method === 'POST' && decision) { const input = await bodyJson(req); await controlPlane.command(commandId(req), { action: `approval.${input.decision}`, target: decision.approvalId, input: { decision: input.decision, reason: input.reason } }, () => controlPlane.decideApproval(decision.runId, decision.approvalId, input.decision)); return json(res, 200, { ok: true, run: await controlPlane.runView(decision.runId) }); }

      const sseRun = route(pathname, '/v1/runs/:runId/events');
      if (req.method === 'GET' && (pathname === '/v1/events' || sseRun)) {
        if (sseClients >= maxSseClients) return json(res, 429, { ok: false, error: 'too_many_sse_clients' });
        sseClients += 1; securityHeaders(res); res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8'); res.setHeader('connection', 'keep-alive'); res.setHeader('x-accel-buffering', 'no');
        res.write('retry: 1000\n\n');
        const runId = sseRun?.runId ?? null;
        const last = String(req.headers['last-event-id'] ?? '');
        const match = last.match(/:(\d+)$/); let cursor = Number(match?.[1] ?? url.searchParams.get('after') ?? 0);
        const revisions = new Map(); let busy = false;
        const push = (event, data, id = null) => { if (id) res.write(`id: ${id}\n`); res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        const poll = async () => {
          if (busy || res.destroyed) return; busy = true;
          try {
            const runs = runId ? [await controlPlane.runView(runId, { timelineLimit: 0 })] : await controlPlane.listRuns();
            for (const run of runs) {
              const seen = revisions.get(run.run_id);
              if (seen !== run.projection_version) { revisions.set(run.run_id, run.projection_version); push('run.updated', run, `snapshot:${run.run_id}:${run.projection_version}`); }
            }
            if (runId) {
              const events = await controlPlane.timeline(runId, { afterSeq: cursor, limit: 500 });
              for (const event of events) { cursor = Math.max(cursor, event.seq); push(event.type, event, event.event_id); }
            }
          } catch (error) { push('stream.error', { error: error.message }); }
          finally { busy = false; }
        };
        await poll(); const timer = setInterval(poll, pollMs); timer.unref?.();
        const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15_000); heartbeat.unref?.();
        req.on('close', () => { clearInterval(timer); clearInterval(heartbeat); sseClients -= 1; });
        return;
      }

      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const status = error.code === 'validation_error' ? 400 : error.code === 'policy_error' ? 403 : error.code === 'conflict_error' ? 409 : error.code === 'budget_exceeded' ? 429 : 500;
      return json(res, status, { ok: false, error: error.code ?? 'internal_error', message: error.message, details: error.details ?? null });
    }
  });

  return {
    server, controlPlane, host, port,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address(); return { host, port: typeof address === 'object' ? address.port : port };
    },
    async close() {
      for (const connection of controlPlane.hostConnections.values()) connection.controller.abort();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
