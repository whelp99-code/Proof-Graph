import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getGraphStatus, verifyGraphIntegrity } from '../../server/lib/graph-runtime.mjs';
import { runDirectory } from '../../server/lib/store.mjs';
import { runId as validateRunId } from '../../server/lib/validate.mjs';

async function readEvents(dataDir, runId) {
  const file = path.join(runDirectory(dataDir, validateRunId(runId)), 'events.jsonl');
  const text = await fs.readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function escapeDot(value) { return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n'); }

export function graphToDot(status) {
  const lines = ['digraph ProofGraph {', '  rankdir=LR;', '  node [shape=box,fontname="monospace"];'];
  const states = new Map(status.node_states.map((node) => [node.node_id, node]));
  for (const node of status.graph?.nodes ?? status.node_states) {
    const runtime = states.get(node.node_id) ?? node;
    const label = `${node.node_id}\\n${node.kind} / ${runtime.status}`;
    lines.push(`  "${escapeDot(node.node_id)}" [label="${escapeDot(label)}"];`);
  }
  for (const edge of status.graph?.edges ?? []) lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.condition?.type ?? 'always')}"];`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export async function inspectRun({ dataDir, projectDir, runId, debuggerController = null, workspace = null }) {
  const context = { dataDir: path.resolve(dataDir), projectDir: path.resolve(projectDir) };
  const [status, integrity, events, debug] = await Promise.all([
    getGraphStatus({ run_id: runId }, context),
    verifyGraphIntegrity({ run_id: runId }, context),
    readEvents(dataDir, runId),
    debuggerController ? debuggerController.read(runId, { create: false }).catch(() => null) : null,
  ]);
  const workspaceState = workspace ? await workspace.readState(runId, { allowMissing: true }) : null;
  return {
    run_id: runId,
    status: status.status,
    objective: status.objective,
    graph_id: status.graph_id,
    graph_digest: status.graph_digest,
    graph_revision: status.graph_revision,
    ready_nodes: (status.ready_nodes ?? []).map((node) => node.node_id),
    nodes: status.node_states,
    failures: status.failures,
    pending_approvals: status.pending_approvals,
    counters: status.counters,
    debugger: debug,
    workspace: workspaceState,
    integrity,
    event_count: events.length,
    recent_events: events.slice(-50),
    dot: graphToDot(status),
  };
}

export function renderInspection(inspection) {
  const lines = [
    `ProofGraph ${inspection.run_id}`,
    `Status: ${inspection.status}`,
    `Graph: ${inspection.graph_id} revision=${inspection.graph_revision}`,
    `Integrity: ${inspection.integrity.ok ? 'PASS' : 'FAIL'}`,
    `Debugger: ${inspection.debugger?.mode ?? 'disabled'}`,
    `Workspace: ${inspection.workspace?.status ?? 'disabled'}`,
    '', 'Nodes:',
  ];
  for (const node of inspection.nodes) lines.push(`  ${node.status.padEnd(10)} ${node.node_id} (${node.kind}/${node.role}) attempts=${node.attempts}`);
  if (inspection.pending_approvals?.length) lines.push('', `Approvals: ${inspection.pending_approvals.map((item) => item.approval_id).join(', ')}`);
  if (inspection.failures && Object.keys(inspection.failures).length) lines.push('', `Failures: ${Object.keys(inspection.failures).length}`);
  return `${lines.join('\n')}\n`;
}

function authorized(req, token) {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  const url = new URL(req.url, 'http://127.0.0.1');
  return url.searchParams.get('token') === token;
}

export async function startInspectorServer(options) {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && options.allowRemote !== true) throw new Error('Inspector may bind only to loopback unless allowRemote=true');
  const token = options.token ?? randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, token)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
        res.end(`<!doctype html><meta charset="utf-8"><title>ProofGraph Inspector</title><style>body{font:14px ui-monospace,monospace;background:#111;color:#eee;margin:2rem}pre{white-space:pre-wrap}button{margin-right:.5rem}</style><h1>ProofGraph Inspector</h1><pre id="out">Loading…</pre><script>const token=${JSON.stringify(token)};async function load(){const r=await fetch('/api/run',{headers:{Authorization:'Bearer '+token}});document.querySelector('#out').textContent=JSON.stringify(await r.json(),null,2)};load();setInterval(load,1000);</script>`);
        return;
      }
      if (url.pathname === '/api/run') {
        const result = await options.inspect();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result)); return;
      }
      if (url.pathname === '/graph.dot') {
        const result = await options.inspect();
        res.writeHead(200, { 'content-type': 'text/vnd.graphviz', 'cache-control': 'no-store' }); res.end(result.dot); return;
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const result = await options.inspect();
        for (const event of result.recent_events) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end(); return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, resolve); });
  const address = server.address();
  return { server, host, port: address.port, token, url: `http://${host}:${address.port}/?token=${token}` };
}
