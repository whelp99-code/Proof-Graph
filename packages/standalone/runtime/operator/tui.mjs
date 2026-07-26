import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { renderOperatorSnapshot } from './render.mjs';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class OperatorTUI {
  constructor({ client, refreshMs = 1500, reconnectMs = 1000, stdout = output, stdin = input } = {}) {
    this.client = client; this.refreshMs = refreshMs; this.reconnectMs = reconnectMs; this.stdout = stdout; this.stdin = stdin;
    this.state = { runs: [], selectedRunIndex: 0, selectedNodeIndex: 0, view: 'graph', query: '', connected: false, message: 'Starting…' };
    this.stopped = false; this.sseController = null; this.refreshTimer = null;
  }

  currentRun() { return this.state.runs[this.state.selectedRunIndex] ?? null; }
  render() {
    const width = this.stdout.columns ?? 120; const height = this.stdout.rows ?? 36;
    const screen = renderOperatorSnapshot({ ...this.state, width, height });
    this.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${screen}`);
  }
  async refresh() {
    try {
      const runs = await this.client.runs();
      const selectedId = this.currentRun()?.run_id;
      this.state.runs = runs;
      if (selectedId) this.state.selectedRunIndex = Math.max(0, runs.findIndex((item) => item.run_id === selectedId));
      this.state.connected = true; this.state.message = '';
    } catch (error) { this.state.connected = false; this.state.message = error.message; }
    this.render();
  }
  async listenEvents() {
    this.sseController = new AbortController();
    while (!this.stopped) {
      try {
        for await (const frame of this.client.events({ signal: this.sseController.signal })) {
          if (frame.event === 'run.updated') {
            const run = frame.data; const index = this.state.runs.findIndex((item) => item.run_id === run.run_id);
            if (index >= 0) this.state.runs[index] = run; else this.state.runs.unshift(run);
            this.state.connected = true; this.render();
          }
        }
      } catch (error) {
        if (this.stopped || this.sseController.signal.aborted) return;
        this.state.connected = false; this.state.message = `Reconnecting: ${error.message}`; this.render(); await sleep(this.reconnectMs);
      }
    }
  }
  async prompt(question) {
    const wasRaw = this.stdin.isRaw; if (wasRaw) this.stdin.setRawMode(false);
    this.stdout.write('\x1b[?25h\n'); const rl = readline.createInterface({ input: this.stdin, output: this.stdout });
    try { return (await rl.question(question)).trim(); }
    finally { rl.close(); if (wasRaw) this.stdin.setRawMode(true); }
  }
  async act(key) {
    const run = this.currentRun(); const nodes = run?.graph?.nodes ?? [];
    if (key === 'q' || key === '\u0003') { this.stop(); return; }
    if (key === 'g') this.state.view = 'graph';
    else if (key === 'o') this.state.view = 'org';
    else if (key === 'c') this.state.view = 'cycles';
    else if (key === 't') this.state.view = 'timeline';
    else if (key === 'f') this.state.view = 'failures';
    else if (key === 'i') this.state.view = 'artifacts';
    else if (key === 'e') this.state.view = 'context';
    else if (key === 'm') this.state.view = 'models';
    else if (key === 'b') this.state.view = 'collaboration';
    else if (key === 'w') this.state.view = 'knowledge';
    else if (key === 'y') this.state.view = 'memory';
    else if (key === 'v') this.state.view = 'verification';
    else if (key === '/') this.state.query = await this.prompt('Search current run (empty clears): ');
    else if (key === '?') this.state.message = 'Views: G/O/C/E/M/B/W/Y/V/T/F/I · Actions: N/P/R/A/D/X · Navigation: arrows or H/J/K/L';
    else if (key === 'j' || key === '\u001b[B') this.state.selectedRunIndex = Math.min(this.state.runs.length - 1, this.state.selectedRunIndex + 1);
    else if (key === 'k' || key === '\u001b[A') this.state.selectedRunIndex = Math.max(0, this.state.selectedRunIndex - 1);
    else if (key === 'l' || key === '\u001b[C') this.state.selectedNodeIndex = Math.min(nodes.length - 1, this.state.selectedNodeIndex + 1);
    else if (key === 'h' || key === '\u001b[D') this.state.selectedNodeIndex = Math.max(0, this.state.selectedNodeIndex - 1);
    else if (key === 'n') {
      const objective = await this.prompt('New mission objective: ');
      if (objective) { const created = await this.client.createRun({ objective, auto_start: true }); this.state.runs.unshift(created); this.state.selectedRunIndex = 0; }
    } else if (key === 'p' && run?.run_type === 'mission') {
      if (run.status === 'paused') await this.client.resume(run.run_id); else await this.client.pause(run.run_id, 'Operator TUI pause');
    } else if (key === 'r' && run?.run_type === 'mission') {
      const node = nodes[this.state.selectedNodeIndex] ?? run.current_nodes?.[0];
      if (node) await this.client.retry(run.run_id, node.id, 'Operator TUI retry');
    } else if ((key === 'a' || key === 'd') && run?.approvals?.pending?.length) {
      const approval = run.approvals.pending[0]; const decision = key === 'a' ? 'approved' : 'denied';
      const confirm = await this.prompt(`${decision.toUpperCase()} ${approval.kind} (${approval.approval_id})? type YES: `);
      if (confirm === 'YES') await this.client.decide(run.run_id, approval.approval_id, decision, 'Operator TUI decision');
    } else if (key === 'x' && run) {
      const confirm = await this.prompt(`Abort ${run.run_id}? type ABORT: `);
      if (confirm === 'ABORT') await this.client.abort(run.run_id, 'Operator TUI abort');
    }
    await this.refresh();
  }
  async start() {
    await this.refresh();
    if (!this.stdin.isTTY || !this.stdout.isTTY) { this.stdout.write(`${renderOperatorSnapshot({ ...this.state, width: 120, height: 36 })}\n`); return; }
    this.stdin.setEncoding('utf8'); this.stdin.setRawMode(true); this.stdin.resume();
    this.stdin.on('data', (chunk) => { this.act(chunk).catch((error) => { this.state.message = error.message; this.render(); }); });
    this.refreshTimer = setInterval(() => this.refresh(), this.refreshMs); this.refreshTimer.unref?.();
    this.listenEvents(); this.render();
    await new Promise((resolve) => { this.resolveStop = resolve; });
  }
  stop() {
    this.stopped = true; clearInterval(this.refreshTimer); this.sseController?.abort();
    if (this.stdin.isTTY && this.stdin.isRaw) this.stdin.setRawMode(false);
    this.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); this.resolveStop?.();
  }
}
