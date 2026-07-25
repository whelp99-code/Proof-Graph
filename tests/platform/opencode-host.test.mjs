import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenCodeClient, parseSseBlock } from '../../runtime/hosts/opencode-client.mjs';
import { OpenCodeExecutionHost } from '../../runtime/hosts/opencode.mjs';

function result(kind = 'direct') {
  return {
    outcome: 'success',
    summary: 'opencode fake completed',
    output: kind === 'verify' ? { verification: { passed: true, checks: ['contract'] }, result: { host: 'opencode' } } : { result: { host: 'opencode' } },
    usage: {}, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {},
  };
}

async function fakeOpenCode(options = {}) {
  const requests = [];
  const expectedAuth = `Basic ${Buffer.from('opencode:secret').toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (options.requireAuth !== false && req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'auth' })); return;
    }
    if (req.url === '/global/health') return send(res, { healthy: true, version: 'test-1' });
    if (req.url === '/project/current') return send(res, { id: 'project_1', worktree: '/tmp/project' });
    if (req.url === '/agent') return send(res, [{ name: 'plan' }, { name: 'build' }]);
    if (req.url === '/session' && req.method === 'POST') return send(res, { id: 'ses_1', title: body.title });
    if (req.url === '/session/ses_1/message' && req.method === 'POST') {
      const kind = body.parts?.[0]?.text?.includes('(verify)') ? 'verify' : 'direct';
      if (options.structuredOutput === true) {
        return send(res, { info: { id: 'msg_1', structured_output: result(kind) }, parts: [] });
      }
      return send(res, { info: { id: 'msg_1' }, parts: [{ type: 'text', text: JSON.stringify(result(kind)) }] });
    }
    if (req.url === '/session/ses_1/diff') return send(res, [{ file: 'src/demo.ts', before: '', after: 'x' }]);
    if (req.url === '/session/ses_1/abort') return send(res, true);
    if (req.url === '/session/status') return send(res, { ses_1: { type: 'idle' } });
    if (req.url === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify({ type: 'server.connected' })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_1' } })}\n\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'missing' }));
  });
  function send(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function request(kind = 'direct') {
  return {
    request_id: 'req_1', run_id: 'pg_000000000000000000000000',
    node: { node_id: kind, kind, role: kind === 'verify' ? 'verifier' : 'direct', tool_policy: [], metadata: {}, model_tier: 'inherit' },
    objective: 'test OpenCode server host', attempt: 1, model_tier: 'inherit', tool_policy: [], context: [],
    workspace: { enabled: false, isolated: false, project_dir: process.cwd() }, constraints: {},
    prompt: `# ProofGraph Agent Contract\nNode: ${kind} (${kind})\nReturn JSON.`, metadata: {},
  };
}

test('OpenCode HTTP client uses basic auth and parses SSE blocks', async () => {
  const fake = await fakeOpenCode();
  try {
    const client = new OpenCodeClient({ baseUrl: fake.url, password: 'secret' });
    assert.equal((await client.health()).healthy, true);
    const events = [];
    for await (const event of client.events()) events.push(event);
    assert.equal(events.length, 2);
    assert.equal(events[1].data.type, 'session.idle');
    assert.equal(fake.requests[0].authorization, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    assert.deepEqual(parseSseBlock('event: test\ndata: {"ok":true}\n'), { event: 'test', data: { ok: true } });
    assert.throws(() => parseSseBlock('data: {bad}\n'), /malformed JSON/);
  } finally { await fake.close(); }
});

test('OpenCode execution host maps a ProofGraph node to a server session and diff artifact', async () => {
  const fake = await fakeOpenCode();
  try {
    const host = new OpenCodeExecutionHost({ enabled: true, pureWorkerConfirmed: true, baseUrl: fake.url, password: 'secret', allowHostTools: false });
    const doctor = await host.doctor();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.mode, 'server-api');
    const output = await host.execute(request('direct'));
    assert.equal(output.outcome, 'success');
    assert.equal(output.metadata.opencode.session_id, 'ses_1');
    assert.equal(output.metadata.opencode.agent, 'plan');
    assert.equal(output.metadata.opencode.diff_count, 1);
    assert.equal(output.artifacts[0].type, 'opencode.diff');
    const messageCall = fake.requests.find((entry) => entry.url === '/session/ses_1/message');
    assert.equal(messageCall.body.agent, 'plan');
    assert.equal(messageCall.body.format.type, 'json_schema');
    assert.equal(messageCall.body.format.retryCount, 2);
    assert.equal(messageCall.body.format.schema.type, 'object');
    assert.ok(messageCall.body.format.schema.required.includes('outcome'));
    assert.equal(messageCall.body.tools.bash, false);
    assert.equal(messageCall.body.tools.edit, false);
  } finally { await fake.close(); }
});


test('OpenCode execution host consumes official structured_output when the server validates the AgentResult schema', async () => {
  const fake = await fakeOpenCode({ structuredOutput: true });
  try {
    const host = new OpenCodeExecutionHost({ enabled: true, pureWorkerConfirmed: true, baseUrl: fake.url, password: 'secret', allowHostTools: false });
    const output = await host.execute(request('verify'));
    assert.equal(output.outcome, 'success');
    assert.equal(output.output.verification.passed, true);
    assert.equal(output.metadata.opencode.structured_output, true);
    assert.equal(output.metadata.opencode.agent, 'plan');
  } finally { await fake.close(); }
});

test('OpenCode build agent requires an isolated workspace when host tools are enabled', async () => {
  const fake = await fakeOpenCode();
  try {
    const host = new OpenCodeExecutionHost({ enabled: true, pureWorkerConfirmed: true, baseUrl: fake.url, password: 'secret', allowHostTools: true });
    const develop = request('develop');
    develop.node.role = 'developer';
    await assert.rejects(() => host.execute(develop), /isolated ProofGraph workspace/);
    develop.workspace.isolated = true;
    develop.workspace.path = '/tmp/isolated';
    const output = await host.execute(develop);
    assert.equal(output.metadata.opencode.agent, 'build');
  } finally { await fake.close(); }
});
