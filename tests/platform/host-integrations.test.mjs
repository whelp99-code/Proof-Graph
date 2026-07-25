import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeProofGraphPlugin } from '../../integrations/opencode/core.mjs';
import { createPiProofGraphExtension } from '../../integrations/pi/core.mjs';

function fakeBridge(policyDecision = 'allow') {
  const calls = [];
  return {
    calls,
    async command(command, fields) {
      calls.push({ type: 'command', command, fields });
      if (command === 'start' || command === 'run') return { ok: true, result: { run_id: 'pg_000000000000000000000000', status: 'active' } };
      if (command === 'status') return { ok: true, result: { run_id: fields.run_id, status: 'active', graph_revision: 2, ready_nodes: [], node_states: [], pending_approvals: [] } };
      return { ok: true, result: { run_id: fields.run_id, command } };
    },
    async event(type, fields) { calls.push({ type: 'event', event: type, fields }); return { ok: true }; },
    async toolPolicy(fields) { calls.push({ type: 'policy', fields }); return { ok: true, decision: { decision: policyDecision, reason: `${policyDecision} by test` } }; },
  };
}

const schema = {
  object: (shape) => shape,
  string: () => ({ type: 'string', optional() { return { ...this, optional: true }; } }),
  optional: (value) => ({ ...value, optional: true }),
};

test('OpenCode plugin tools start runs and tool hooks enforce ProofGraph policy', async () => {
  const allow = fakeBridge('allow');
  const plugin = createOpenCodeProofGraphPlugin({ bridge: allow, directory: '/repo', worktree: '/repo/wt', toolFactory: (value) => value, schema });
  assert.equal('proofgraph_approve' in plugin.hooks.tool, false);
  assert.equal('proofgraph_abort' in plugin.hooks.tool, false);
  const started = await plugin.hooks.tool.proofgraph_start.execute({ objective: 'Implement a safe feature' });
  assert.match(started, /pg_000000000000000000000000/);
  assert.equal(plugin.getActiveRunId(), 'pg_000000000000000000000000');
  const output = { args: { filePath: 'README.md' } };
  await plugin.hooks['tool.execute.before']({ tool: 'read' }, output);
  assert.ok(allow.calls.some((call) => call.type === 'policy' && call.fields.tool === 'read'));

  const deny = fakeBridge('deny');
  const blocked = createOpenCodeProofGraphPlugin({ bridge: deny, runId: 'pg_000000000000000000000000', directory: '/repo', worktree: '/repo', toolFactory: (value) => value, schema });
  await assert.rejects(() => blocked.hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'npm test' } }), /ProofGraph deny/);
});

function fakePi() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  return {
    commands, tools, handlers, entries,
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
  };
}

function fakeContext(entries = []) {
  const notifications = [];
  const statuses = [];
  const widgets = [];
  return {
    cwd: '/repo', hasUI: true,
    sessionManager: { getEntries: () => entries },
    ui: {
      notifications, statuses, widgets,
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(name, value) { statuses.push({ name, value }); },
      setWidget(name, value) { widgets.push({ name, value }); },
      async confirm() { return true; },
    },
  };
}

test('Pi extension registers commands/tools, persists run state, and blocks denied tools', async () => {
  const pi = fakePi();
  const bridge = fakeBridge('deny');
  const extension = createPiProofGraphExtension(pi, { bridge, schema });
  assert.ok(pi.commands.has('pg'));
  assert.ok(pi.commands.has('pg-status'));
  assert.ok(pi.tools.has('proofgraph_run'));
  assert.ok(pi.commands.has('pg-resume'));
  assert.ok(pi.commands.has('pg-integrity'));
  const ctx = fakeContext();
  await pi.commands.get('pg').handler('Implement a safe feature', ctx);
  assert.equal(extension.getActiveRunId(), 'pg_000000000000000000000000');
  assert.ok(pi.entries.some((entry) => entry.customType === 'proofgraph-run'));
  assert.ok(ctx.ui.widgets.length > 0);

  const toolCall = pi.handlers.get('tool_call')[0];
  const decision = await toolCall({ toolName: 'bash', input: { command: 'npm test' } }, ctx);
  assert.equal(decision.block, true);
  assert.match(decision.reason, /ProofGraph deny/);
});

test('Pi extension restores an active run from session entries and fails closed when policy bridge errors', async () => {
  const pi = fakePi();
  const bridge = fakeBridge('allow');
  bridge.toolPolicy = async () => { throw new Error('bridge down'); };
  const extension = createPiProofGraphExtension(pi, { bridge, schema });
  const runId = 'pg_111111111111111111111111';
  const ctx = fakeContext([{ type: 'custom', customType: 'proofgraph-run', data: { run_id: runId } }]);
  await pi.handlers.get('session_start')[0]({}, ctx);
  assert.equal(extension.getActiveRunId(), runId);
  const decision = await pi.handlers.get('tool_call')[0]({ toolName: 'write', input: { path: 'x' } }, ctx);
  assert.equal(decision.block, true);
  assert.match(decision.reason, /bridge unavailable/);
});
