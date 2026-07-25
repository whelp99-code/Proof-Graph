import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createBuiltInRegistry } from '../../runtime/adapters/profiles.mjs';
import { normalizePlatformConfig } from '../../runtime/config.mjs';
import { startInspectorServer } from '../../runtime/debugger/inspector.mjs';
import { initializeProject } from '../../runtime/project.mjs';
import { createTemplateRegistry } from '../../runtime/templates/registry.mjs';

async function temp(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('PLATFORM ADVERSARIAL: force init refuses config symlink overwrite', async (t) => {
  const root = await temp(t, 'proofgraph-init-link-');
  const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, '{"safe":true}\n');
  const project = path.join(root, 'project'); await fs.mkdir(project);
  await fs.symlink(outside, path.join(project, 'proofgraph.config.json'));
  await assert.rejects(() => initializeProject(project, { force: true }), /symbolic-link/);
  assert.equal(await fs.readFile(outside, 'utf8'), '{"safe":true}\n');
});

test('PLATFORM ADVERSARIAL: force init refuses data-directory symlink escape', async (t) => {
  const root = await temp(t, 'proofgraph-data-link-');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  await fs.symlink(outside, path.join(project, '.proofgraph'));
  await assert.rejects(() => initializeProject(project), /symbolic-link/);
  await assert.rejects(() => fs.access(path.join(outside, '.gitignore')));
});

test('PLATFORM ADVERSARIAL: templates cannot inject arbitrary graph blueprints', () => {
  const registry = createTemplateRegistry();
  assert.throws(() => registry.apply('feature', { objective: 'Implement a sufficiently specific feature', graph: { nodes: [{ tool_policy: ['shell'] }] } }), /unknown keys/);
});

test('PLATFORM ADVERSARIAL: all live vendor adapters remain disabled by default', async () => {
  const config = normalizePlatformConfig({}, { projectDir: process.cwd() });
  const doctor = await createBuiltInRegistry(config).doctor();
  for (const item of doctor.filter((entry) => entry.name !== 'mock')) assert.notEqual(item.status, 'ready');
});

test('PLATFORM ADVERSARIAL: inspector refuses public binding without explicit override', async () => {
  await assert.rejects(() => startInspectorServer({ host: '0.0.0.0', port: 0, inspect: async () => ({}) }), /loopback/);
});

test('PLATFORM ADVERSARIAL: prototype keys in custom template registry are rejected', () => {
  const payload = JSON.parse('{"__proto__":{"title":"bad","description":"bad"}}');
  assert.throws(() => createTemplateRegistry(payload), /Template name|Forbidden JSON key/);
});

test('PLATFORM ADVERSARIAL: TUI renderer strips terminal control injection from run data', async () => {
  const { renderTui } = await import('../../runtime/tui/app.mjs');
  const rendered = renderTui({
    selected_run_id: 'pg_safe',
    runs: [{ run_id: 'pg_safe', status: 'active', objective: 'safe', updated_at: '2026-01-01T00:00:00Z' }],
    inspection: {
      status: 'active', graph_id: 'graph_safe', graph_revision: 1, integrity: { ok: true }, ready_nodes: [], pending_approvals: [], event_count: 1,
      objective: '\u001b[2J\u001b[31mINJECTED', nodes: [], recent_events: [{ seq: 1, type: '\u001b[2J\u009b31m\rbad', actor: 'attacker\troot' }],
    },
    error: null,
  }, { width: 120, height: 36 });
  assert.equal(rendered.includes('\u001b'), false);
  assert.equal(rendered.includes('\r'), false);
  assert.equal(rendered.includes('\u009b'), false);
  assert.match(rendered, /bad.*attacker.*root/);
});
