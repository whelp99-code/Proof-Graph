import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatform } from '../../runtime/platform.mjs';
import { startHostBridge } from '../../runtime/hosts/bridge-server.mjs';
import { createOpenCodeProofGraphPlugin } from '../../integrations/opencode/core.mjs';
import { createPiProofGraphExtension } from '../../integrations/pi/core.mjs';

const schema = {
  object: (shape) => shape,
  string: () => ({ type: 'string', optional() { return { ...this, optional: true }; } }),
  optional: (value) => ({ ...value, optional: true }),
};

function fakePi() {
  const commands = new Map(); const tools = new Map(); const handlers = new Map(); const entries = [];
  return {
    commands, tools, handlers, entries,
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
  };
}

async function setup(host) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pg-${host}-e2e-`));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const platform = await createPlatform({ projectDir: project, overrides: { data_dir: path.join(root, 'data') } });
  const token = `${host}-bridge-token-12345678901234567890`;
  const bridge = await startHostBridge({ platform, host, token });
  const env = { PROOFGRAPH_HOST_URL: bridge.url, PROOFGRAPH_HOST_TOKEN: token };
  return { root, project, platform, bridge, env, cleanup: async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('OpenCode managed plugin executes a mock ProofGraph run through the authenticated bridge', async () => {
  const ctx = await setup('opencode');
  try {
    const plugin = createOpenCodeProofGraphPlugin({ env: ctx.env, directory: ctx.project, worktree: ctx.project, toolFactory: (x) => x, schema });
    const text = await plugin.hooks.tool.proofgraph_run.execute({ objective: 'Return a short safe summary', adapter: 'mock' });
    const result = JSON.parse(text);
    assert.match(result.run_id, /^pg_/);
    assert.equal(plugin.getActiveRunId(), result.run_id);
    await plugin.hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath: 'README.md' } });
    await assert.rejects(() => plugin.hooks['tool.execute.before']({ tool: 'write' }, { args: { filePath: 'x', content: 'y' } }), /ProofGraph deny|require_approval/);
    const eventFile = path.join(ctx.platform.config.data_dir, 'host-events', 'opencode.jsonl');
    assert.match(await fs.readFile(eventFile, 'utf8'), /tool.requested/);
  } finally { await ctx.cleanup(); }
});

test('Pi managed extension executes through the bridge and persists the attached run', async () => {
  const ctx = await setup('pi');
  try {
    const pi = fakePi();
    const extension = createPiProofGraphExtension(pi, { env: ctx.env, schema });
    const output = await pi.tools.get('proofgraph_run').execute('call_1', { objective: 'Return a short safe summary', adapter: 'mock' });
    const parsed = JSON.parse(output.content[0].text);
    assert.match(parsed.run_id, /^pg_/);
    assert.equal(extension.getActiveRunId(), parsed.run_id);
    assert.ok(pi.entries.some((entry) => entry.data.run_id === parsed.run_id));
  } finally { await ctx.cleanup(); }
});
