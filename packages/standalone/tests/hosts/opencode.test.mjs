import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenCodeClient, normalizeOpenCodeEvent } from '../../runtime/hosts/opencode-client.mjs';
import { HostRegistry } from '../../runtime/hosts/host-registry.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

async function fakeOpenCode() {
  const server = http.createServer((req, res) => {
    if (req.url === '/global/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ healthy: true, version: 'test' })); return; }
    if (req.url === '/project/current') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'project_1', name: 'demo' })); return; }
    if (req.url === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })}\n\n`);
      setTimeout(() => res.end(), 20); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('OpenCode client validates health and parses official SSE surface', async (t) => {
  const fake = await fakeOpenCode(); t.after(() => new Promise((resolve) => fake.server.close(resolve)));
  const client = new OpenCodeClient({ baseUrl: fake.url });
  assert.equal((await client.health()).version, 'test');
  const events = [];
  for await (const event of client.events()) events.push(event);
  assert.equal(events[0].type, 'session.status');
  assert.equal(events[0].session_id, 's1');
});

test('OpenCode event normalization preserves run binding without executable behavior', () => {
  const event = normalizeOpenCodeEvent({ type: 'tool.execute.before', properties: { sessionID: 's', tool: 'bash', status: 'running' } }, { run_id: 'mission_1', node_id: 'develop' });
  assert.equal(event.run_id, 'mission_1'); assert.equal(event.node_id, 'develop'); assert.equal(event.tool, 'bash');
});

test('Host registry persists sessions and bounded recent events', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const registry = new HostRegistry({ dataDir: dir, maxRecentEvents: 2 });
  await registry.connected('opencode', { version: '1' });
  await registry.ingest('opencode', { type: 'session.status', session_id: 's1', status: 'busy', run_id: 'mission_1' });
  await registry.ingest('opencode', { type: 'tool.execute.before', session_id: 's1', tool: 'read' });
  await registry.ingest('opencode', { type: 'session.idle', session_id: 's1', status: 'idle' });
  const state = await registry.get('opencode');
  assert.equal(state.sessions.s1.status, 'idle');
  assert.equal(state.recent_events.length, 2);
});
