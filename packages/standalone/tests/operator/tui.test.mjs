import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { OperatorTUI } from '../../runtime/operator/tui.mjs';

function output({ tty = false } = {}) {
  return {
    columns: 100, rows: 30, isTTY: tty, writes: [],
    write(value) { this.writes.push(String(value)); return true; },
  };
}

function mission(overrides = {}) {
  return {
    run_id: 'mission_tui', run_type: 'mission', objective: 'TUI test', status: 'active', quality_gate_passed: false,
    progress: { completed: 1, total: 3, percent: 33 }, current_node_ids: ['node_develop'], next_node_ids: ['node_verify'],
    graph: { nodes: [
      { id: 'node_plan', label: 'plan', kind: 'plan', status: 'completed', attempts: 1, max_attempts: 2, sequence: 0 },
      { id: 'node_develop', label: 'develop', kind: 'develop', status: 'running', attempts: 1, max_attempts: 3, sequence: 1 },
      { id: 'node_verify', label: 'verify', kind: 'verify', status: 'pending', attempts: 0, max_attempts: 3, sequence: 2 },
    ], edges: [{ id: 'e1', from: 'node_plan', to: 'node_develop', kind: 'dependency' }], active_node_ids: ['node_develop'], next_node_ids: ['node_verify'] },
    current_nodes: [{ id: 'node_develop', label: 'develop', kind: 'develop', status: 'running' }],
    organization: { departments: [], teams: [], roles: [] }, loops: [], loop_summary: { total: 0, active: 0, current_iteration: 0 },
    failures: { historical: [], resolved: [], unresolved: [] }, approvals: { pending: [{ approval_id: 'approval_tui', kind: 'mission-risk-gate', reason: 'risk' }], decided: [] },
    artifacts: { candidates: [], verified: [] }, host: { name: 'OpenCode', status: 'connected' }, operator: { paused: false }, timeline: [],
    ...overrides,
  };
}

test('OperatorTUI refresh, render and non-TTY start produce a complete screen', async () => {
  const stdout = output();
  const client = { runs: async () => [mission()] };
  const tui = new OperatorTUI({ client, stdout, stdin: { isTTY: false } });
  await tui.refresh();
  assert.equal(tui.currentRun().run_id, 'mission_tui');
  assert.equal(tui.state.connected, true);
  assert.match(stdout.writes.join(''), /ProofGraph Operator/);
  stdout.writes.length = 0;
  await tui.start();
  assert.match(stdout.writes.join(''), /EXECUTION GRAPH/);
});

test('OperatorTUI refresh fails visibly without destroying previous state', async () => {
  const stdout = output();
  const tui = new OperatorTUI({ client: { runs: async () => { throw new Error('offline'); } }, stdout, stdin: { isTTY: false } });
  tui.state.runs = [mission()];
  await tui.refresh();
  assert.equal(tui.state.connected, false);
  assert.equal(tui.state.message, 'offline');
  assert.equal(tui.currentRun().run_id, 'mission_tui');
});

test('OperatorTUI event listener merges live run projections', async () => {
  const stdout = output();
  let tui;
  const client = {
    async *events() {
      yield { event: 'run.updated', data: mission({ status: 'completed_clean', progress: { completed: 3, total: 3, percent: 100 } }) };
      tui.stopped = true;
    },
  };
  tui = new OperatorTUI({ client, stdout, stdin: { isTTY: false } });
  tui.state.runs = [mission()];
  await tui.listenEvents();
  assert.equal(tui.currentRun().status, 'completed_clean');
  assert.equal(tui.state.connected, true);
});

test('OperatorTUI prompt temporarily disables raw mode and trims input', async () => {
  const stdin = new PassThrough(); stdin.isRaw = true; stdin.isTTY = true; stdin.setRawMode = (value) => { stdin.isRaw = value; };
  const stdout = new PassThrough(); stdout.columns = 100; stdout.rows = 30; stdout.isTTY = true;
  const tui = new OperatorTUI({ client: {}, stdout, stdin });
  setImmediate(() => stdin.write('  YES  \n'));
  const answer = await tui.prompt('Confirm: ');
  assert.equal(answer, 'YES');
  assert.equal(stdin.isRaw, true);
});

test('OperatorTUI key actions cover navigation, lifecycle, retry and approval controls', async () => {
  const calls = [];
  const client = {
    createRun: async (input) => { calls.push(['create', input]); return mission({ run_id: 'mission_new' }); },
    pause: async (...args) => calls.push(['pause', ...args]), resume: async (...args) => calls.push(['resume', ...args]),
    retry: async (...args) => calls.push(['retry', ...args]), decide: async (...args) => calls.push(['decide', ...args]),
    abort: async (...args) => calls.push(['abort', ...args]),
  };
  const tui = new OperatorTUI({ client, stdout: output(), stdin: { isTTY: false } });
  tui.state.runs = [mission(), mission({ run_id: 'mission_second' })];
  tui.refresh = async () => { calls.push(['refresh']); };
  const answers = ['new objective', 'search term', 'YES', 'YES', 'ABORT'];
  tui.prompt = async () => answers.shift();

  for (const key of ['o', 'c', 't', 'f', 'i', '?', 'g', 'j', 'k', 'l', 'h']) await tui.act(key);
  assert.equal(tui.state.view, 'graph');
  await tui.act('n');
  await tui.act('/');
  assert.equal(tui.state.query, 'search term');
  assert.equal(tui.currentRun().run_id, 'mission_new');
  tui.state.runs[0] = mission();
  await tui.act('p');
  tui.state.runs[0].status = 'paused';
  await tui.act('p');
  tui.state.runs[0].status = 'active';
  await tui.act('r');
  await tui.act('a');
  await tui.act('d');
  await tui.act('x');

  assert.ok(calls.some(([name]) => name === 'create'));
  assert.ok(calls.some(([name]) => name === 'pause'));
  assert.ok(calls.some(([name]) => name === 'resume'));
  assert.ok(calls.some(([name]) => name === 'retry'));
  assert.equal(calls.filter(([name]) => name === 'decide').length, 2);
  assert.ok(calls.some(([name]) => name === 'abort'));
});

test('OperatorTUI stop restores terminal state and resolves active start loop', async () => {
  const stdout = output({ tty: true });
  const stdin = { isTTY: true, isRaw: true, setRawMode(value) { this.isRaw = value; } };
  const tui = new OperatorTUI({ client: {}, stdout, stdin });
  let resolved = false; tui.resolveStop = () => { resolved = true; };
  tui.sseController = new AbortController(); tui.refreshTimer = setInterval(() => {}, 1000);
  tui.stop();
  assert.equal(tui.stopped, true);
  assert.equal(stdin.isRaw, false);
  assert.equal(tui.sseController.signal.aborted, true);
  assert.equal(resolved, true);
});

test('OperatorTUI retries a failed event stream with bounded reconnect delay', async () => {
  const stdout = output(); let tui; let attempts = 0;
  const client = {
    async *events() {
      attempts += 1;
      if (attempts === 1) throw new Error('stream lost');
      tui.stopped = true;
    },
  };
  tui = new OperatorTUI({ client, stdout, stdin: { isTTY: false }, reconnectMs: 1 });
  tui.state.runs = [mission()];
  await tui.listenEvents();
  assert.equal(attempts, 2);
  assert.match(tui.state.message, /Reconnecting: stream lost/);
});

test('OperatorTUI TTY start handles keyboard shutdown and restores cursor', async () => {
  const { EventEmitter } = await import('node:events');
  const stdin = new EventEmitter(); stdin.isTTY = true; stdin.isRaw = false;
  stdin.setEncoding = () => {}; stdin.setRawMode = (value) => { stdin.isRaw = value; }; stdin.resume = () => {};
  const stdout = output({ tty: true }); let abortSignal;
  const client = {
    runs: async () => [mission()],
    async *events({ signal }) {
      abortSignal = signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const tui = new OperatorTUI({ client, stdout, stdin, refreshMs: 10000 });
  setImmediate(() => stdin.emit('data', 'q'));
  await tui.start();
  assert.equal(tui.stopped, true);
  assert.equal(stdin.isRaw, false);
  assert.equal(abortSignal.aborted, true);
  assert.match(stdout.writes.join(''), /ProofGraph Operator/);
});
