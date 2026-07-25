import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createPlatform } from '../../runtime/platform.mjs';
import { listTuiRuns, loadTuiModel, nextConfirmation, renderTui, startTui } from '../../runtime/tui/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = path.join(ROOT, 'examples/graphs/ai-agent-tui.graph.json');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-tui-'));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = await createPlatform({ projectDir, overrides: { data_dir: dataDir } });
  const graph = JSON.parse(await fs.readFile(GRAPH, 'utf8'));
  const result = await platform.kernel.runGraph(graph, { adapter: 'mock' });
  return { ...platform, projectDir, dataDir, graph, runId: result.run_id };
}

test('AI Agent TUI lists verified runs and renders bounded snapshot panels', async (t) => {
  const fx = await fixture(t);
  const runs = await listTuiRuns(fx.dataDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, fx.runId);
  assert.equal(runs[0].integrity_ok, true);

  const model = await loadTuiModel({
    dataDir: fx.dataDir,
    projectDir: fx.projectDir,
    runId: fx.runId,
    debuggerController: fx.debuggerController,
    workspace: fx.workspace,
  });
  const rendered = renderTui(model, { width: 120, height: 36 });
  assert.match(rendered, /ProofGraph AI Agent TUI/);
  assert.match(rendered, /verify-functional/);
  assert.match(rendered, /Integrity: PASS/);
  assert.match(rendered, /a approve/);
  assert.match(rendered, /x abort/);
  assert.ok(rendered.split('\n').length <= 36);
  assert.ok(rendered.split('\n').every((line) => line.length <= 120));

  const narrow = renderTui(model, { width: 40, height: 12 });
  assert.ok(narrow.split('\n').length <= 12);
  assert.ok(narrow.split('\n').every((line) => line.length <= 40));
});

test('destructive TUI actions require the same key twice inside a bounded window', () => {
  const first = nextConfirmation(null, 'abort run', 'x', 1_000);
  assert.equal(first.confirmed, false);
  const wrong = nextConfirmation(first.confirmation, 'approve', 'a', 2_000);
  assert.equal(wrong.confirmed, false);
  const expired = nextConfirmation(first.confirmation, 'abort run', 'x', 6_000);
  assert.equal(expired.confirmed, false);
  const confirmed = nextConfirmation(first.confirmation, 'abort run', 'x', 3_000);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.confirmation, null);
});

test('snapshot mode works without a TTY and preserves selected run', async (t) => {
  const fx = await fixture(t);
  let output = '';
  const sink = { write(chunk) { output += String(chunk); }, columns: 96, rows: 22, isTTY: false };
  const result = await startTui({
    dataDir: fx.dataDir,
    projectDir: fx.projectDir,
    runId: fx.runId,
    debuggerController: fx.debuggerController,
    workspace: fx.workspace,
    snapshot: true,
    output: sink,
    input: { isTTY: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'snapshot');
  assert.equal(result.selected_run_id, fx.runId);
  assert.match(output, new RegExp(fx.runId));
});

test('corrupt run state is listed fail-closed instead of crashing the TUI', async (t) => {
  const fx = await fixture(t);
  const statePath = path.join(fx.dataDir, 'runs', fx.runId, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.status = 'active';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const runs = await listTuiRuns(fx.dataDir);
  assert.equal(runs[0].status, 'integrity_error');
  assert.equal(runs[0].integrity_ok, false);
});


function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (value) => { input.isRaw = Boolean(value); input.rawModes.push(Boolean(value)); };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });
  return { input, output, text: () => text };
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for TUI action');
}

test('interactive resume key executes an explicitly paused graph through the kernel', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-tui-resume-'));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = await createPlatform({ projectDir, overrides: { data_dir: dataDir } });
  const graph = JSON.parse(await fs.readFile(GRAPH, 'utf8'));
  const started = await platform.kernel.startGraph(graph);
  await platform.debuggerController.command(started.run_id, 'pause', { reason: 'test pause' });
  const tty = fakeTty();
  const running = startTui({
    dataDir, projectDir, runId: started.run_id,
    kernel: platform.kernel, debuggerController: platform.debuggerController, workspace: platform.workspace,
    input: tty.input, output: tty.output, refreshMs: 100,
  });
  await waitFor(() => tty.input.listenerCount('keypress') > 0);
  tty.input.emit('keypress', 'p', { name: 'p' });
  const finalStatus = await waitFor(async () => {
    const status = await platform.kernel.status(started.run_id);
    return status.status === 'finalized' ? status : null;
  });
  tty.input.emit('keypress', 'q', { name: 'q' });
  const result = await running;
  assert.equal(finalStatus.status, 'finalized');
  assert.equal(result.mode, 'interactive');
  assert.deepEqual(tty.input.rawModes, [true, false]);
});

test('interactive single-step key executes one bounded step and pauses again', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-tui-step-'));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = await createPlatform({ projectDir, overrides: { data_dir: dataDir } });
  const graph = JSON.parse(await fs.readFile(GRAPH, 'utf8'));
  const started = await platform.kernel.startGraph(graph);
  const tty = fakeTty();
  const running = startTui({
    dataDir, projectDir, runId: started.run_id,
    kernel: platform.kernel, debuggerController: platform.debuggerController, workspace: platform.workspace,
    input: tty.input, output: tty.output, refreshMs: 100,
  });
  await waitFor(() => tty.input.listenerCount('keypress') > 0);
  tty.input.emit('keypress', 's', { name: 's' });
  const debug = await waitFor(async () => {
    const state = await platform.debuggerController.read(started.run_id);
    return state.mode === 'paused' && /step completed/.test(state.pause_reason ?? '') ? state : null;
  });
  const status = await platform.kernel.status(started.run_id);
  tty.input.emit('keypress', 'q', { name: 'q' });
  await running;
  assert.equal(debug.mode, 'paused');
  assert.notEqual(status.status, 'finalized');
  assert.ok(status.node_states.some((node) => node.status === 'succeeded'));
  assert.deepEqual(tty.input.rawModes, [true, false]);
});

test('interactive double-key approval resolves the GraphKernel gate and continues the run', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-tui-approve-'));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = await createPlatform({ projectDir, overrides: { data_dir: dataDir } });
  const applied = platform.templates.apply('agent-tui', { objective: 'AI 에이전트 TUI를 개발하라', mode: 'auto' });
  const { template: _template, ...input } = applied;
  const waiting = await platform.kernel.run(input, { adapter: 'mock' });
  assert.equal(waiting.status, 'waiting_approval');
  const tty = fakeTty();
  const running = startTui({
    dataDir, projectDir, runId: waiting.run_id,
    kernel: platform.kernel, debuggerController: platform.debuggerController, workspace: platform.workspace,
    input: tty.input, output: tty.output, refreshMs: 100,
  });
  await waitFor(() => tty.input.listenerCount('keypress') > 0);
  tty.input.emit('keypress', 'a', { name: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await platform.kernel.status(waiting.run_id)).status, 'waiting_approval');
  tty.input.emit('keypress', 'a', { name: 'a' });
  const finalStatus = await waitFor(async () => {
    const status = await platform.kernel.status(waiting.run_id);
    return status.status === 'finalized' ? status : null;
  });
  tty.input.emit('keypress', 'q', { name: 'q' });
  await running;
  assert.equal(finalStatus.status, 'finalized');
  assert.deepEqual(tty.input.rawModes, [true, false]);
});
