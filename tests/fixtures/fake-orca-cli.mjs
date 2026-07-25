#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2).filter((arg) => arg !== '--json');
const stateFile = process.env.FAKE_ORCA_STATE;
const root = path.resolve(process.env.FAKE_ORCA_ROOT ?? path.join(process.cwd(), '.fake-orca'));
const behavior = process.env.FAKE_ORCA_BEHAVIOR ?? 'success';
if (!stateFile) {
  process.stderr.write('FAKE_ORCA_STATE is required\n');
  process.exit(2);
}

const lockDir = `${stateFile}.lock`;
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
let locked = false;
for (let attempt = 0; attempt < 1000; attempt += 1) {
  try { fs.mkdirSync(lockDir); locked = true; break; }
  catch (error) { if (error?.code !== 'EEXIST') throw error; sleep(5); }
}
if (!locked) {
  process.stderr.write('fake Orca state lock timeout\n');
  process.exit(4);
}
process.on('exit', () => { try { fs.rmdirSync(lockDir); } catch {} });

function load() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { commands: [], counters: {}, tasks: {}, worktrees: {}, terminals: {}, dispatches: {}, checks: 0, staleWaitFailed: {} }; }
}
function save(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, stateFile);
}
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function flag(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function has(name) { return argv.includes(name); }
function next(state, name) { state.counters[name] = (state.counters[name] ?? 0) + 1; return state.counters[name]; }
function fail(message, code = 2) { process.stderr.write(`${message}\n`); process.exit(code); }
function reportPathFromSpec(spec) {
  const match = String(spec ?? '').match(/Write exactly one ProofGraph AgentResult JSON object to:\s*([^\s]+)/);
  return match?.[1] ?? '.proofgraph/orca-results/default.json';
}
function makeResult(spec) {
  const verify = String(spec).includes('(verify)');
  return verify
    ? { outcome: 'success', summary: 'orca fake verified', output: { verification: { passed: true, checks: ['orca-contract'] }, result: { host: 'orca' } }, usage: {}, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} }
    : { outcome: 'success', summary: 'orca fake completed', output: { result: { host: 'orca' } }, usage: {}, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} };
}

const state = load();
state.commands.push(argv);

if (argv[0] === 'status') {
  save(state); output({ ok: true, runtime: { version: '1.4.35', orchestration: { enabled: true, experimental: true } } }); process.exit(0);
}
if (argv[0] === 'repo' && argv[1] === 'list') {
  save(state); output({ repos: [{ id: 'repo_1', path: process.cwd() }] }); process.exit(0);
}
if (argv[0] === 'repo' && argv[1] === 'show') {
  const selector = flag('--repo');
  if (selector !== 'id:repo_1') { save(state); fail('unknown repo selector'); }
  save(state); output({ repo: { id: 'repo_1', path: process.cwd() } }); process.exit(0);
}
if (argv[0] === 'worktree' && argv[1] === 'ps') {
  save(state); output({ worktrees: Object.values(state.worktrees) }); process.exit(0);
}
if (argv[0] === 'automations' && argv[1] === 'list') {
  save(state); output({ automations: [] }); process.exit(0);
}
if (argv[0] === 'skills' && ['get', 'show'].includes(argv[1])) {
  save(state); output({ name: argv[2], content: 'fake orchestration skill contract' }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'gate-list') {
  save(state); output({ gates: [] }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'inbox') {
  save(state); output({ messages: [] }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'task-list') {
  save(state); output({ tasks: Object.values(state.tasks) }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'task-create') {
  const id = `task_${next(state, 'task')}`;
  state.tasks[id] = { id, taskId: id, title: flag('--task-title'), displayName: flag('--display-name'), spec: flag('--spec'), status: 'ready' };
  save(state); output({ task: { taskId: id, status: 'ready' } }); process.exit(0);
}
if (argv[0] === 'worktree' && argv[1] === 'create') {
  const id = `wt_${next(state, 'worktree')}`;
  const wtPath = path.join(root, id);
  const terminalHandle = `terminal_${id}`;
  fs.mkdirSync(wtPath, { recursive: true });
  state.worktrees[id] = { id, worktreeId: id, path: wtPath, name: flag('--name'), agent: flag('--agent'), terminalHandle };
  state.terminals[terminalHandle] = { terminalHandle, worktreeId: id };
  save(state); output({ worktree: { worktreeId: id, worktreePath: wtPath } }); process.exit(0);
}
if (argv[0] === 'terminal' && argv[1] === 'list') {
  const selector = flag('--worktree');
  if (!selector) {
    save(state); output({ terminals: Object.values(state.terminals) }); process.exit(0);
  }
  const worktreeId = selector.startsWith('id:') ? selector.slice(3) : selector;
  const wt = state.worktrees[worktreeId];
  if (!wt) { save(state); output({ terminals: [] }); process.exit(0); }
  state.terminalLists ??= {};
  state.terminalLists[worktreeId] = (state.terminalLists[worktreeId] ?? 0) + 1;
  let handle = wt.terminalHandle;
  if (behavior === 'stale-terminal') {
    handle = state.terminalLists[worktreeId] > 1 ? `terminal_fresh_${worktreeId}` : `terminal_stale_${worktreeId}`;
    state.terminals[handle] = { terminalHandle: handle, worktreeId };
  }
  save(state); output({ terminals: [{ terminalHandle: handle, worktreeId }] }); process.exit(0);
}
if (argv[0] === 'terminal' && argv[1] === 'wait') {
  const handle = flag('--terminal');
  state.staleWaitFailed ??= {};
  if (behavior === 'stale-terminal' && handle.startsWith('terminal_stale_') && !state.staleWaitFailed[handle]) {
    state.staleWaitFailed[handle] = true;
    save(state); fail('stale terminal handle');
  }
  save(state); output({ ok: true, terminalHandle: handle, state: 'tui-idle' }); process.exit(0);
}
if (argv[0] === 'terminal' && argv[1] === 'read') {
  save(state); output({ terminalHandle: flag('--terminal'), text: 'still working', nextCursor: '1' }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'dispatch') {
  const id = `dispatch_${next(state, 'dispatch')}`;
  const taskId = flag('--task');
  const terminal = flag('--to');
  const terminalRow = state.terminals[terminal];
  const wt = state.worktrees[terminalRow?.worktreeId];
  if (!wt) fail('unknown worktree for terminal');
  const spec = state.tasks[taskId]?.spec ?? '';
  const reportRel = reportPathFromSpec(spec);
  const reportAbs = path.join(wt.path, reportRel);
  fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
  if (behavior === 'malformed-report') fs.writeFileSync(reportAbs, '{not-json');
  else if (behavior === 'symlink-report') {
    const outside = path.join(root, `outside-${id}.json`);
    fs.writeFileSync(outside, JSON.stringify(makeResult(spec)));
    try { fs.unlinkSync(reportAbs); } catch {}
    fs.symlinkSync(outside, reportAbs);
  } else if (behavior !== 'missing-report') {
    fs.writeFileSync(reportAbs, JSON.stringify(makeResult(spec)));
  }
  state.dispatches[id] = { id, dispatchId: id, taskId, terminal, worktreeId: wt.id, reportRel, delivered: false };
  state.tasks[taskId].status = 'dispatched';
  save(state); output({ dispatch: { dispatchId: id, taskId } }); process.exit(0);
}
if (argv[0] === 'orchestration' && argv[1] === 'check') {
  state.checks += 1;
  const dispatches = Object.values(state.dispatches);
  const latest = dispatches.at(-1);
  if (!latest) { save(state); output({ messages: [] }); process.exit(0); }
  if (behavior === 'checkpoint' && state.checks === 1) { save(state); output({ timedOut: true, messages: [] }); process.exit(0); }
  if (behavior === 'timeout-error' && state.checks === 1) { save(state); fail('orchestration check timed out', 3); }
  const base = (dispatch) => ({ type: 'worker_done', taskId: dispatch.taskId, dispatchId: dispatch.dispatchId, body: 'completed', reportPath: dispatch.reportRel });
  let messages;
  if (behavior === 'decision-then-done' && state.checks === 1) messages = [{ type: 'decision_gate', taskId: latest.taskId, dispatchId: latest.dispatchId, body: 'Choose API compatibility mode', gateId: 'gate_1' }];
  else if (behavior === 'stale-then-done' && state.checks === 1) messages = [{ ...base(latest), dispatchId: 'dispatch_stale' }];
  else if (behavior === 'missing-dispatch-then-done' && state.checks === 1) { const { dispatchId: _ignored, ...rest } = base(latest); messages = [rest]; }
  else if (behavior === 'body-result') { const { reportPath: _ignored, ...inline } = base(latest); inline.body = JSON.stringify(makeResult(state.tasks[latest.taskId]?.spec ?? '')); messages = [inline]; }
  else {
    switch (behavior) {
      case 'stale-dispatch': messages = [{ ...base(latest), dispatchId: 'dispatch_stale' }]; break;
      case 'duplicate': messages = [base(latest), { ...base(latest), id: 'duplicate' }]; break;
      case 'traversal': messages = [{ ...base(latest), reportPath: '../outside.json' }]; break;
      case 'wrong-report': messages = [{ ...base(latest), reportPath: '.proofgraph/orca-results/other.json' }]; break;
      case 'wrong-task': messages = [{ ...base(latest), taskId: 'task_other' }]; break;
      case 'escalation': messages = [{ type: 'escalation', taskId: latest.taskId, dispatchId: latest.dispatchId, body: 'Missing credentials for the requested operation' }]; break;
      case 'decision-gate': messages = [{ type: 'decision_gate', taskId: latest.taskId, dispatchId: latest.dispatchId, body: 'Choose API compatibility mode', gateId: 'gate_1' }]; break;
      case 'no-message': messages = []; break;
      default: messages = dispatches.filter((dispatch) => has('--all') || !dispatch.delivered).map(base);
    }
  }
  if (!has('--all')) {
    for (const message of messages) {
      const row = state.dispatches[message.dispatchId];
      if (row) row.delivered = true;
    }
  }
  save(state); output({ messages }); process.exit(0);
}

save(state);
fail(`unsupported fake Orca command: ${argv.join(' ')}`);
