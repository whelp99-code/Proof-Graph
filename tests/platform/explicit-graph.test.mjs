import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin/proofgraph.mjs');
const GRAPH = path.join(ROOT, 'examples/graphs/ai-agent-tui.graph.json');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? ROOT, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI validates and executes the explicit AI Agent TUI GraphSpec', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-explicit-'));
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  await fs.mkdir(project, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const validated = await run(['graph', 'validate', GRAPH, '--project', project, '--data-dir', data]);
  assert.equal(validated.code, 0, validated.stderr);
  const validation = JSON.parse(validated.stdout);
  assert.equal(validation.ok, true);
  assert.equal(validation.validation.node_count, 14);
  assert.equal(validation.graph.graph_id, 'graph_ai_agent_tui_v1');

  const executed = await run(['graph', 'run', GRAPH, '--adapter', 'mock', '--project', project, '--data-dir', data]);
  assert.equal(executed.code, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'finalized');
  assert.equal(result.report.report.terminal_status, 'success');
  assert.equal(result.report.report.quality_gate_passed, true);

  const snapshot = await run(['tui', result.run_id, '--snapshot', '--project', project, '--data-dir', data]);
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /ProofGraph AI Agent TUI/);
  assert.match(snapshot.stdout, /verify-adversarial/);
});
