import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { inspectRun } from '../debugger/inspector.mjs';
import { readVerifiedRun } from '../../server/lib/store.mjs';
import { VERSION } from '../version.mjs';

const ESC = '\u001b[';
const FOCUS_ORDER = Object.freeze(['runs', 'nodes', 'events']);
const CONFIRM_WINDOW_MS = 4_000;

function safeText(value) {
  return String(value ?? '')
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '�');
}

function clip(value, width) {
  const text = safeText(value);
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function line(width, char = '─') { return char.repeat(Math.max(0, width)); }

function statusGlyph(status) {
  return ({ finalized: '✓', active: '●', waiting_approval: '!', paused: 'Ⅱ', failed: '×', aborted: '×', budget_exceeded: '$', integrity_error: '?' })[status] ?? '○';
}

function nodeGlyph(status) {
  return ({ succeeded: '✓', running: '●', ready: '▶', waiting_approval: '!', failed: '×', blocked: '■', skipped: '–', pending: '○' })[status] ?? '○';
}

function objectValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value);
}

function renderPanel(title, content, width, height, options = {}) {
  const inner = Math.max(1, width - 2);
  const marker = options.active ? '*' : '-';
  const headerText = ` ${marker} ${title} `;
  const top = `┌${headerText}${line(Math.max(0, inner - headerText.length), '─')}┐`;
  const rows = [clip(top, width)];
  for (const item of content.slice(0, Math.max(0, height - 2))) rows.push(`│${clip(item, inner)}│`);
  while (rows.length < height - 1) rows.push(`│${' '.repeat(inner)}│`);
  rows.push(`└${line(inner, '─')}┘`);
  return rows.slice(0, height).map((row) => clip(row, width));
}

function joinColumns(columns, gap = ' ') {
  const height = Math.max(...columns.map((column) => column.length));
  const rows = [];
  for (let index = 0; index < height; index += 1) {
    rows.push(columns.map((column) => column[index] ?? '').join(gap));
  }
  return rows;
}

async function runDirectories(dataDir) {
  const root = path.join(path.resolve(dataDir), 'runs');
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listTuiRuns(dataDir) {
  const rows = [];
  for (const runId of await runDirectories(dataDir)) {
    try {
      const state = await readVerifiedRun(dataDir, runId);
      rows.push({
        run_id: runId,
        run_kind: state.run_kind ?? 'unknown',
        status: state.status,
        objective: state.objective,
        updated_at: state.updated_at,
        graph_id: state.graph?.graph_id ?? null,
        integrity_ok: true,
      });
    } catch (error) {
      let updatedAt = null;
      try { updatedAt = (await fs.stat(path.join(path.resolve(dataDir), 'runs', runId))).mtime.toISOString(); } catch {}
      rows.push({ run_id: runId, run_kind: 'unknown', status: 'integrity_error', objective: error.message, updated_at: updatedAt, graph_id: null, integrity_ok: false });
    }
  }
  return rows.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) || a.run_id.localeCompare(b.run_id));
}

function chooseNode(inspection, requested) {
  const nodes = inspection?.nodes ?? [];
  if (!nodes.length) return null;
  if (requested && nodes.some((node) => node.node_id === requested)) return requested;
  const preferred = nodes.find((node) => ['waiting_approval', 'failed', 'running', 'ready'].includes(node.status));
  return preferred?.node_id ?? nodes[0].node_id;
}

export async function loadTuiModel(options) {
  const runs = await listTuiRuns(options.dataDir);
  const selectedRunId = options.runId && runs.some((run) => run.run_id === options.runId)
    ? options.runId
    : runs.find((run) => run.run_kind === 'graph')?.run_id ?? runs[0]?.run_id ?? null;
  let inspection = null;
  let error = null;
  if (selectedRunId) {
    try {
      inspection = await inspectRun({
        dataDir: options.dataDir,
        projectDir: options.projectDir,
        runId: selectedRunId,
        debuggerController: options.debuggerController ?? null,
        workspace: options.workspace ?? null,
      });
    } catch (caught) {
      error = { name: caught.name, message: caught.message };
    }
  }
  const selectedNodeId = chooseNode(inspection, options.nodeId);
  return {
    generated_at: new Date().toISOString(),
    runs,
    selected_run_id: selectedRunId,
    selected_node_id: selectedNodeId,
    focus: FOCUS_ORDER.includes(options.focus) ? options.focus : 'runs',
    message: options.message ?? '',
    confirmation: options.confirmation ?? null,
    inspection,
    error,
  };
}

function renderRuns(model, width, height) {
  const rows = [];
  const selected = model.selected_run_id;
  for (const run of model.runs.slice(0, height)) {
    const prefix = run.run_id === selected ? '›' : ' ';
    rows.push(`${prefix}${statusGlyph(run.status)} ${run.run_id} ${run.status}`);
  }
  if (!rows.length) rows.push('No runs. Use proofgraph run "objective".');
  return renderPanel('RUNS', rows, width, height + 2, { active: model.focus === 'runs' });
}

function renderNodes(model, width, height) {
  const rows = [];
  for (const node of model.inspection?.nodes?.slice(0, height) ?? []) {
    const prefix = node.node_id === model.selected_node_id ? '›' : ' ';
    rows.push(`${prefix}${nodeGlyph(node.status)} ${node.node_id} [${node.kind}/${node.role}] a=${node.attempts}`);
  }
  if (!rows.length) rows.push('No graph nodes available.');
  return renderPanel('GRAPH / AGENTS', rows, width, height + 2, { active: model.focus === 'nodes' });
}

function selectedNode(model) {
  return model.inspection?.nodes?.find((node) => node.node_id === model.selected_node_id) ?? null;
}

function summaryFromOutput(output) {
  if (!output || typeof output !== 'object') return '-';
  return output.summary ?? output.result?.summary ?? output.verification?.checks?.join(', ') ?? JSON.stringify(output).slice(0, 300);
}

function renderDetails(model, width, height) {
  const i = model.inspection;
  const node = selectedNode(model);
  const approvals = i?.pending_approvals ?? [];
  const failures = objectValues(i?.failures);
  const rows = [];
  if (model.error) rows.push(`ERROR ${model.error.name}: ${model.error.message}`);
  else if (!i) rows.push('No selected graph run.');
  else {
    rows.push(`Run: ${i.status} · Integrity: ${i.integrity.ok ? 'PASS' : 'FAIL'}`);
    rows.push(`Graph: ${i.graph_id} r${i.graph_revision}`);
    rows.push(`Ready: ${i.ready_nodes.join(', ') || '-'}`);
    rows.push(`Approvals: ${approvals.length} · Failures: ${failures.length} · Events: ${i.event_count}`);
    if (approvals[0]) rows.push(`APPROVAL ${approvals[0].risk}: ${approvals[0].node_id} — ${approvals[0].reason}`);
    if (node) {
      rows.push('');
      rows.push(`Node: ${node.node_id}`);
      rows.push(`Title: ${node.title}`);
      rows.push(`Kind/Role: ${node.kind}/${node.role}`);
      rows.push(`Status: ${node.status} · Attempts: ${node.attempts}/${node.max_attempts}`);
      rows.push(`Risk/Model: ${node.risk}/${node.model_tier}`);
      if (node.failure) rows.push(`Failure: ${node.failure.failure_type} — ${node.failure.summary}`);
      if (node.output) rows.push(`Output: ${summaryFromOutput(node.output)}`);
    }
  }
  return renderPanel('INSPECTOR / APPROVALS', rows, width, height + 2, { active: false });
}

function renderEvents(model, width, height) {
  const rows = [];
  for (const event of model.inspection?.recent_events?.slice(-height) ?? []) {
    rows.push(`#${event.seq} ${event.type} ${event.actor}`);
  }
  if (!rows.length) rows.push('No events.');
  return renderPanel('EVENTS', rows, width, height + 2, { active: model.focus === 'events' });
}

function footerText(model) {
  const confirm = model.confirmation && model.confirmation.expires_at > Date.now()
    ? ` CONFIRM: press ${model.confirmation.key} again to ${model.confirmation.action}.`
    : '';
  const message = model.message ? ` ${model.message}` : '';
  return `Tab focus · j/k or arrows select · p pause/resume · s step · a approve · d deny · x abort · r refresh · q quit.${confirm}${message}`;
}

export function renderTui(model, options = {}) {
  const width = Math.max(40, Math.min(240, Number(options.width ?? 120)));
  const height = Math.max(12, Math.min(100, Number(options.height ?? 36)));
  const body = [];
  const focus = FOCUS_ORDER.includes(model.focus) ? model.focus : 'runs';
  const status = model.inspection?.status ?? model.error?.name ?? 'idle';
  const integrity = model.inspection ? (model.inspection.integrity.ok ? 'integrity:PASS' : 'integrity:FAIL') : 'integrity:-';
  body.push(clip(`ProofGraph AI Agent TUI v${VERSION} · ${model.selected_run_id ?? 'no-run'} · ${status} · ${integrity} · focus:${focus}`, width));
  body.push(line(width));

  if (width >= 108) {
    const topHeight = Math.max(10, Math.floor((height - 8) * 0.64));
    const runWidth = Math.max(25, Math.floor(width * 0.25));
    const nodeWidth = Math.max(38, Math.floor(width * 0.42));
    const detailWidth = width - runWidth - nodeWidth - 2;
    body.push(...joinColumns([
      renderRuns(model, runWidth, topHeight - 2),
      renderNodes(model, nodeWidth, topHeight - 2),
      renderDetails(model, detailWidth, topHeight - 2),
    ]));
    const remaining = Math.max(4, height - body.length - 2);
    body.push(...renderEvents(model, width, remaining - 2));
  } else {
    const compact = height < 22;
    if (compact) {
      const contentBudget = Math.max(9, height - 3);
      const runsPanelHeight = Math.max(3, Math.min(4, Math.floor(contentBudget * 0.25)));
      const nodesPanelHeight = Math.max(3, Math.min(7, Math.floor(contentBudget * 0.42)));
      const detailsPanelHeight = Math.max(3, contentBudget - runsPanelHeight - nodesPanelHeight);
      body.push(...renderRuns(model, width, runsPanelHeight - 2));
      body.push(...renderNodes(model, width, nodesPanelHeight - 2));
      body.push(...renderDetails(model, width, detailsPanelHeight - 2));
    } else {
      const runsHeight = 5;
      const nodesHeight = Math.max(6, Math.floor((height - 10) * 0.38));
      const detailsHeight = Math.max(6, Math.floor((height - 10) * 0.35));
      body.push(...renderRuns(model, width, runsHeight - 2));
      body.push(...renderNodes(model, width, nodesHeight - 2));
      body.push(...renderDetails(model, width, detailsHeight - 2));
      const remaining = Math.max(4, height - body.length - 2);
      body.push(...renderEvents(model, width, remaining - 2));
    }
  }

  body.push(clip(footerText(model), width));
  return body.slice(0, height).join('\n');
}

export function nextConfirmation(current, action, key, now = Date.now()) {
  if (current?.action === action && current?.key === key && current.expires_at > now) {
    return { confirmed: true, confirmation: null };
  }
  return {
    confirmed: false,
    confirmation: { action, key, requested_at: now, expires_at: now + CONFIRM_WINDOW_MS },
  };
}

function nextFocus(current, delta = 1) {
  const index = Math.max(0, FOCUS_ORDER.indexOf(current));
  return FOCUS_ORDER[(index + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length];
}

export async function startTui(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const refreshMs = Math.max(100, Math.min(60_000, Number(options.refreshMs ?? 750)));
  const view = {
    runId: options.runId ?? null,
    nodeId: null,
    focus: 'runs',
    message: '',
    confirmation: null,
  };
  let stopped = false;
  let busy = false;
  let activeHandlers = 0;
  let lastModel = null;

  const snapshot = async () => {
    const model = await loadTuiModel({
      ...options,
      runId: view.runId,
      nodeId: view.nodeId,
      focus: view.focus,
      message: view.message,
      confirmation: view.confirmation,
    });
    view.runId = model.selected_run_id;
    view.nodeId = model.selected_node_id;
    lastModel = model;
    return renderTui(model, { width: options.width ?? output.columns ?? 120, height: options.height ?? output.rows ?? 36 });
  };

  if (options.snapshot) {
    const text = await snapshot();
    output.write(`${text}\n`);
    return { ok: true, mode: 'snapshot', selected_run_id: view.runId, selected_node_id: view.nodeId };
  }
  if (!input.isTTY || !output.isTTY) throw new Error('Interactive TUI requires a TTY. Use --snapshot for redirected output or CI.');

  readline.emitKeypressEvents(input);
  const previousRaw = input.isRaw;
  const draw = async () => {
    if (busy || stopped) return;
    busy = true;
    try { output.write(`${ESC}H${ESC}2J${await snapshot()}`); }
    catch (error) { view.message = `Error: ${safeText(error.message)}`; output.write(`${ESC}H${ESC}2J${clip(view.message, output.columns ?? 120)}`); }
    finally { busy = false; }
  };

  const selectRun = (delta) => {
    const runs = lastModel?.runs ?? [];
    if (!runs.length) return;
    const index = Math.max(0, runs.findIndex((run) => run.run_id === view.runId));
    view.runId = runs[(index + delta + runs.length) % runs.length].run_id;
    view.nodeId = null;
  };

  const selectNode = (delta) => {
    const nodes = lastModel?.inspection?.nodes ?? [];
    if (!nodes.length) return;
    const index = Math.max(0, nodes.findIndex((node) => node.node_id === view.nodeId));
    view.nodeId = nodes[(index + delta + nodes.length) % nodes.length].node_id;
  };

  const requireConfirmation = async (action, key, execute) => {
    const next = nextConfirmation(view.confirmation, action, key);
    view.confirmation = next.confirmation;
    if (!next.confirmed) {
      view.message = `Press ${key} again within ${CONFIRM_WINDOW_MS / 1000}s to ${action}.`;
      return;
    }
    try {
      await execute();
      view.message = `${action} completed.`;
    } catch (error) {
      view.message = `${action} failed: ${safeText(error.message)}`;
    }
  };

  const keyHandler = async (_text, key = {}) => {
    activeHandlers += 1;
    try {
      if ((key.ctrl && key.name === 'c') || key.name === 'q') { stopped = true; return; }
      if (key.name === 'tab' || key.name === 'right') view.focus = nextFocus(view.focus, 1);
      else if (key.name === 'left') view.focus = nextFocus(view.focus, -1);
      else if (key.name === 'up' || key.name === 'k') {
        if (view.focus === 'runs') selectRun(-1);
        else if (view.focus === 'nodes') selectNode(-1);
      } else if (key.name === 'down' || key.name === 'j') {
        if (view.focus === 'runs') selectRun(1);
        else if (view.focus === 'nodes') selectNode(1);
      } else if (key.name === 'p' && view.runId && options.debuggerController) {
        const debug = await options.debuggerController.read(view.runId).catch(() => null);
        if (debug?.mode === 'paused') {
          await options.debuggerController.command(view.runId, 'resume', { reason: 'ProofGraph TUI operator' });
          view.message = 'Run resumed; executing ready nodes.';
          if (options.kernel) {
            const outcome = await options.kernel.resume(view.runId);
            view.message = `Run ${outcome.status}.`;
          }
        } else {
          await options.debuggerController.command(view.runId, 'pause', { reason: 'ProofGraph TUI operator' });
          view.message = 'Run paused before the next node.';
        }
      } else if (key.name === 's' && view.runId && options.debuggerController) {
        await options.debuggerController.command(view.runId, 'step', { reason: 'ProofGraph TUI operator' });
        view.message = 'Executing one node.';
        if (options.kernel) {
          const outcome = await options.kernel.resume(view.runId);
          view.message = outcome.status === 'paused' ? 'Single-step completed; run paused.' : `Step result: ${outcome.status}.`;
        }
      } else if (key.name === 'a' && view.runId && options.kernel) {
        const approval = lastModel?.inspection?.pending_approvals?.[0];
        if (!approval) view.message = 'No pending approval.';
        else await requireConfirmation('approve', 'a', async () => {
          await options.kernel.approve(view.runId, {
            actor: 'human', approval_id: approval.approval_id, challenge: approval.challenge,
            decision: 'approved', decision_source: 'external_human', comment: 'Explicit double-key approval from ProofGraph TUI',
          });
          await options.kernel.resume(view.runId);
        });
      } else if (key.name === 'd' && view.runId && options.kernel) {
        const approval = lastModel?.inspection?.pending_approvals?.[0];
        if (!approval) view.message = 'No pending approval.';
        else await requireConfirmation('deny', 'd', async () => {
          await options.kernel.approve(view.runId, {
            actor: 'human', approval_id: approval.approval_id, challenge: approval.challenge,
            decision: 'denied', decision_source: 'external_human', comment: 'Explicit double-key denial from ProofGraph TUI',
          });
          await options.kernel.resume(view.runId);
        });
      } else if (key.name === 'x' && view.runId && options.kernel) {
        await requireConfirmation('abort run', 'x', () => options.kernel.abort(view.runId, 'Explicit double-key abort from ProofGraph TUI'));
      } else if (key.name === 'r') view.message = 'Refreshed.';
      else if (key.name === '?') view.message = 'Safety: approve, deny, and abort require the same key twice within four seconds.';
      await draw();
    } catch (error) {
      view.message = `Action failed: ${safeText(error.message)}`;
      await draw();
    } finally {
      activeHandlers -= 1;
    }
  };

  // Keypress events are emitted synchronously while handlers are async.  Queue
  // them to preserve operator intent: the second confirmation key must run
  // after the first key has committed its bounded confirmation state.
  let keyQueue = Promise.resolve();
  const keyListener = (text, key) => {
    keyQueue = keyQueue.then(() => keyHandler(text, key));
  };

  const resize = () => { void draw(); };
  let timer;
  try {
    input.setRawMode(true);
    input.resume();
    output.write(`${ESC}?1049h${ESC}?25l`);
    // Render the first verified model before accepting operator input.  This
    // prevents a fast key press from observing an uninitialised `lastModel`
    // and, for example, turning the first approval key into a no-op.
    await draw();
    input.on('keypress', keyListener);
    output.on('resize', resize);
    timer = setInterval(draw, refreshMs);
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 50));
    await keyQueue;
    // A refresh timer may already be inside an asynchronous verified-state
    // read when the quit key is processed.  Do not return control to callers
    // (which may immediately remove the run directory) until that draw has
    // finished.  This closes a real ENOTEMPTY cleanup race seen under the full
    // release suite.
    while (busy) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    if (timer) clearInterval(timer);
    input.off('keypress', keyListener);
    output.off('resize', resize);
    try { input.setRawMode(Boolean(previousRaw)); } catch {}
    input.pause();
    output.write(`${ESC}?25h${ESC}?1049l`);
  }
  return { ok: true, mode: 'interactive', selected_run_id: view.runId, selected_node_id: view.nodeId };
}
