import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AdapterError } from '../adapters/base.mjs';
import { ExecutionHost, HostError, booleanOption, optionalString, positiveInteger } from './base.mjs';
import { OrcaCliClient, collectTypedMessages, field, findFirstField } from './orca-client.mjs';

const ROLES = ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'];
const FORBIDDEN_ORCA_COMMANDS = new Set(['run', 'reset', 'exec', 'computer']);

function normalizeAgentMap(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HostError('adapters.orca.agent_map must be an object');
  const defaults = {
    direct: 'codex', researcher: 'claude', planner: 'claude',
    developer: 'codex', verifier: 'claude', synthesizer: 'claude',
  };
  const result = { ...defaults };
  for (const [role, agent] of Object.entries(input)) {
    if (!ROLES.includes(role)) throw new HostError(`Unsupported Orca role mapping: ${role}`);
    if (typeof agent !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) {
      throw new HostError(`Invalid Orca agent name for ${role}`);
    }
    result[role] = agent;
  }
  return result;
}

function slug(value, max = 44) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || 'task').slice(0, max).replace(/-+$/g, '') || 'task';
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function exactMessageId(message, kind) {
  if (kind === 'task') return field(message, 'taskId', 'task_id');
  if (kind === 'dispatch') return field(message, 'dispatchId', 'dispatch_id');
  return null;
}

function messageType(message) {
  return String(field(message, 'type', 'messageType', 'message_type') ?? '');
}

function messageBody(message) {
  return String(field(message, 'body', 'summary', 'message', 'question') ?? '').slice(0, 20_000);
}

function buildWorkerSpec(request, reportPath) {
  return [
    request.prompt,
    '',
    '# Orca host completion contract',
    `- This is ProofGraph run ${request.run_id}, node ${request.node.node_id}, attempt ${request.attempt}.`,
    '- Work only on the dispatched task and remain inside the assigned Orca worktree.',
    '- Never report completion for another task or dispatch.',
    '- Do not start Orca autonomous orchestration. ProofGraph owns routing and final state.',
    '- For a blocking question, use Orca ask/decision-gate only when required by the host; do not silently guess.',
    `- Write exactly one ProofGraph AgentResult JSON object to: ${reportPath}`,
    '- The JSON must satisfy the output contract in the prompt and contain no Markdown wrapper.',
    '- Send worker_done exactly once with the active taskId and dispatchId and the same report path.',
    '- On failure, still write a typed failed AgentResult and send worker_done exactly once.',
  ].join('\n');
}

function classifyEscalation(message) {
  const body = messageBody(message);
  const sensitive = /security|credential|permission/i.test(body);
  return {
    outcome: 'failed',
    summary: body || 'Orca worker escalated the task',
    output: { orca: { event_type: 'escalation' } },
    failure: {
      failure_type: sensitive ? 'security_risk' : 'requirements_error',
      summary: body || 'Orca worker escalation requires coordinator action',
      severity: sensitive ? 'high' : 'medium',
      retryable: !sensitive,
      evidence: [],
      expected: 'Worker completes or emits a structured blocked result',
      observed: body || 'escalation',
      recommended_route: sensitive ? 'human' : 'plan',
      metadata: {},
    },
    usage: {}, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {},
  };
}

async function safeReadReport(worktreePath, expectedReportPath, maxBytes) {
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw new HostError('Orca local bridge requires an absolute local worktree path', { worktree_path: worktreePath });
  }
  if (typeof expectedReportPath !== 'string' || path.isAbsolute(expectedReportPath)) {
    throw new HostError('Orca report path must be a relative path');
  }
  const root = await fs.realpath(worktreePath);
  const candidate = path.resolve(root, expectedReportPath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new HostError('Orca report path escapes the worktree', { report_path: expectedReportPath });
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HostError('Orca report must be a regular non-symlink file');
  if (stat.size > maxBytes) throw new HostError(`Orca report exceeds ${maxBytes} bytes`, { bytes: stat.size });
  const real = await fs.realpath(candidate);
  if (!real.startsWith(`${root}${path.sep}`)) throw new HostError('Orca report resolves outside the worktree');
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(real, 'utf8')); }
  catch (error) { throw new HostError(`Orca report is not a valid ProofGraph AgentResult JSON: ${error.message}`); }
  return { parsed, absolutePath: real };
}

export class OrcaExecutionHost extends ExecutionHost {
  constructor(options = {}) {
    super({ name: 'orca' });
    this.enabled = booleanOption(options.enabled, false, 'adapters.orca.enabled');
    this.manualPermissionsConfirmed = booleanOption(options.manualPermissionsConfirmed, false, 'adapters.orca.manual_permissions_confirmed');
    this.projectDir = path.resolve(options.projectDir ?? process.cwd());
    this.repoSelector = optionalString(options.repoSelector, null, 'adapters.orca.repo_selector', { max: 4096 });
    this.requireExplicitRepoSelector = booleanOption(options.requireExplicitRepoSelector, true, 'adapters.orca.require_explicit_repo_selector');
    this.setup = optionalString(options.setup, 'inherit', 'adapters.orca.setup', { max: 16 });
    if (!['run', 'skip', 'inherit'].includes(this.setup)) throw new HostError('adapters.orca.setup must be run, skip, or inherit');
    this.coordinatorTerminal = optionalString(options.coordinatorTerminal, null, 'adapters.orca.coordinator_terminal', { max: 256 });
    this.agentMap = normalizeAgentMap(options.agentMap);
    this.allowedAgents = new Set(options.allowedAgents ?? Object.values(this.agentMap));
    for (const agent of this.allowedAgents) {
      if (typeof agent !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) throw new HostError('adapters.orca.allowed_agents contains an invalid agent name');
    }
    this.allowNodeAgentOverride = booleanOption(options.allowNodeAgentOverride, false, 'adapters.orca.allow_node_agent_override');
    this.allowWorkspaceMutation = booleanOption(options.allowWorkspaceMutation, false, 'adapters.orca.allow_workspace_mutation');
    this.checkTimeoutMs = positiveInteger(options.checkTimeoutMs, 900_000, 'adapters.orca.check_timeout_ms', { min: 1_000, max: 3_600_000 });
    this.terminalWaitMs = positiveInteger(options.terminalWaitMs, 60_000, 'adapters.orca.terminal_wait_ms', { min: 1_000, max: 600_000 });
    this.maxCheckpoints = positiveInteger(options.maxCheckpoints, 2, 'adapters.orca.max_checkpoints', { min: 0, max: 20 });
    this.maxSpecBytes = positiveInteger(options.maxSpecBytes, 60_000, 'adapters.orca.max_spec_bytes', { min: 1_000, max: 200_000 });
    this.maxReportBytes = positiveInteger(options.maxReportBytes, 1_000_000, 'adapters.orca.max_report_bytes', { min: 1_024, max: 10_000_000 });
    this.reportDir = optionalString(options.reportDir, '.proofgraph/orca-results', 'adapters.orca.report_dir', { max: 512 });
    if (path.isAbsolute(this.reportDir) || this.reportDir.split(/[\\/]+/).includes('..')) throw new HostError('adapters.orca.report_dir must remain inside the worktree');
    this.allowInlineResult = booleanOption(options.allowInlineResult, false, 'adapters.orca.allow_inline_result');
    this.commandTrace = [];
    this.client = options.client ?? new OrcaCliClient({
      command: options.command ?? 'orca', args: options.args ?? [], cwd: this.projectDir, env: options.env,
      timeoutMs: Math.max(this.checkTimeoutMs + 30_000, 60_000),
      trace: (entry) => this.commandTrace.push(entry),
    });
  }

  selectAgent(request) {
    const override = request.node?.metadata?.orca_agent;
    const selected = override && this.allowNodeAgentOverride ? override : this.agentMap[request.node.role] ?? this.agentMap.direct;
    if (!this.allowedAgents.has(selected)) throw new HostError(`Orca agent is not allowlisted: ${selected}`);
    return selected;
  }

  assertSafeNode(request) {
    if (!this.manualPermissionsConfirmed) {
      throw new HostError('Orca Agent Permissions must be set to Manual and adapters.orca.manual_permissions_confirmed=true before dispatch');
    }
    if (this.requireExplicitRepoSelector && !this.repoSelector) {
      throw new HostError('Set adapters.orca.repo_selector to an explicit id:<repoId> from `orca repo list --json` before dispatch');
    }
    if (request.workspace?.enabled === true || request.workspace?.isolated === true) {
      throw new HostError('Disable the ProofGraph Workspace Engine for Orca-hosted runs; Orca must be the sole worktree owner');
    }
    const policies = new Set(request.tool_policy ?? []);
    const mutationRequested = [...policies].some((item) => /write|edit|shell|command|mutation/i.test(item));
    if (mutationRequested && !this.allowWorkspaceMutation) {
      throw new HostError('Orca host mutation is disabled; use read-only/planning agents until a supervised live canary passes');
    }
  }

  async doctor() {
    const base = {
      host: 'orca',
      mode: 'orca-cli-manual-dispatch',
      compatibility_bridge: true,
      strict_orca_native: false,
      state_authority: 'proofgraph-kernel',
      execution_authority: 'orca-runtime',
      workspace_authority: 'orca-worktree',
      enabled: this.enabled,
      manual_permissions_confirmed: this.manualPermissionsConfirmed,
      require_explicit_repo_selector: this.requireExplicitRepoSelector,
      repo_selector_configured: Boolean(this.repoSelector),
      live_canary_required: true,
      orchestration_experimental: true,
    };
    if (!this.enabled) return { ...base, ok: false, error: 'Orca host is disabled' };
    const checks = {};
    try {
      ({ data: checks.status } = await this.client.call(['status'], { timeoutMs: 15_000 }));
      ({ data: checks.repos } = await this.client.call(['repo', 'list'], { timeoutMs: 15_000 }));
      if (this.repoSelector) ({ data: checks.repo } = await this.client.call(['repo', 'show', '--repo', this.repoSelector], { timeoutMs: 15_000 }));
      ({ data: checks.worktrees } = await this.client.call(['worktree', 'ps'], { timeoutMs: 15_000 }));
      ({ data: checks.terminals } = await this.client.call(['terminal', 'list'], { timeoutMs: 15_000 }));
      ({ data: checks.tasks } = await this.client.call(['orchestration', 'task-list'], { timeoutMs: 15_000 }));
      ({ data: checks.gates } = await this.client.call(['orchestration', 'gate-list', '--status', 'pending'], { timeoutMs: 15_000 }));
      ({ data: checks.inbox } = await this.client.call(['orchestration', 'inbox', '--limit', '20'], { timeoutMs: 15_000 }));
      if (!this.manualPermissionsConfirmed) {
        return { ...base, ok: false, checks, error: 'Set Orca Agent Permissions to Manual, then set adapters.orca.manual_permissions_confirmed=true' };
      }
      if (this.requireExplicitRepoSelector && !this.repoSelector) {
        return { ...base, ok: false, checks, error: 'Set adapters.orca.repo_selector to an explicit id:<repoId> from `orca repo list --json`' };
      }
      return { ...base, ok: true, checks };
    } catch (error) {
      return { ...base, ok: false, checks, error: error.message, code: error.details?.code ?? null };
    }
  }

  async terminalForWorktree(worktreeSelector, signal) {
    const { data } = await this.client.call(['terminal', 'list', '--worktree', worktreeSelector], { signal });
    const handle = findFirstField(data, ['terminalHandle', 'terminal_handle', 'handle']);
    if (!handle) throw new HostError('Orca did not return a terminal handle for the created worktree');
    return handle;
  }

  async waitForTerminal(worktreeSelector, handle, signal) {
    try {
      await this.client.call(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(this.terminalWaitMs)], { signal, timeoutMs: this.terminalWaitMs + 15_000 });
      return handle;
    } catch (error) {
      if (!/stale|unknown terminal|not found/i.test(error.message)) throw error;
      const fresh = await this.terminalForWorktree(worktreeSelector, signal);
      await this.client.call(['terminal', 'wait', '--terminal', fresh, '--for', 'tui-idle', '--timeout-ms', String(this.terminalWaitMs)], { signal, timeoutMs: this.terminalWaitMs + 15_000 });
      return fresh;
    }
  }

  async awaitResult({ taskId, dispatchId, terminalHandle, signal }) {
    let decisionGatesSeen = 0;
    let staleDispatchMessages = 0;
    for (let checkpoint = 0; checkpoint <= this.maxCheckpoints; checkpoint += 1) {
      let data = null;
      try {
        const args = ['orchestration', 'check'];
        if (this.coordinatorTerminal) args.push('--terminal', this.coordinatorTerminal);
        args.push('--all', '--wait', '--types', 'worker_done,escalation,decision_gate', '--timeout-ms', String(this.checkTimeoutMs));
        ({ data } = await this.client.call(args, { signal, timeoutMs: this.checkTimeoutMs + 30_000 }));
      } catch (error) {
        if (!/timeout|timed out/i.test(error.message) || checkpoint >= this.maxCheckpoints) throw error;
      }
      const messages = collectTypedMessages(data).filter((message) => {
        const messageTask = exactMessageId(message, 'task');
        const messageDispatch = exactMessageId(message, 'dispatch');
        return messageTask === taskId && messageDispatch === dispatchId;
      });
      const staleDone = collectTypedMessages(data).filter((message) => messageType(message) === 'worker_done' && exactMessageId(message, 'task') === taskId && exactMessageId(message, 'dispatch') !== dispatchId);
      staleDispatchMessages += staleDone.length;
      const done = messages.filter((message) => messageType(message) === 'worker_done');
      if (done.length > 1) throw new HostError('Orca returned duplicate worker_done messages for one dispatch', { task_id: taskId, dispatch_id: dispatchId, count: done.length });
      if (done.length === 1) return { kind: 'worker_done', message: done[0], decisionGatesSeen, staleDispatchMessages };
      const escalation = messages.find((message) => messageType(message) === 'escalation');
      if (escalation) return { kind: 'escalation', message: escalation, decisionGatesSeen, staleDispatchMessages };
      const gate = messages.find((message) => messageType(message) === 'decision_gate');
      if (gate) {
        decisionGatesSeen += 1;
        if (checkpoint >= this.maxCheckpoints) return { kind: 'decision_gate', message: gate, decisionGatesSeen, staleDispatchMessages };
      }
      if (checkpoint >= this.maxCheckpoints) break;
      await this.client.call(['orchestration', 'task-list'], { signal, timeoutMs: 30_000 });
      try { await this.client.call(['terminal', 'read', '--terminal', terminalHandle], { signal, timeoutMs: 30_000 }); } catch {}
    }
    throw new HostError('Orca worker did not produce a matching completion message within the checkpoint budget', { task_id: taskId, dispatch_id: dispatchId });
  }

  assertNoForbiddenCommands() {
    for (const entry of this.commandTrace) {
      const args = entry.args ?? [];
      if (args[0] === 'orchestration' && FORBIDDEN_ORCA_COMMANDS.has(args[1])) {
        throw new HostError(`Forbidden Orca orchestration command was invoked: ${args[1]}`);
      }
      if (FORBIDDEN_ORCA_COMMANDS.has(args[0])) throw new HostError(`Forbidden Orca command was invoked: ${args[0]}`);
      if (args[0] === 'terminal' && args[1] === 'send') throw new HostError('Ad hoc terminal send is forbidden for tracked ProofGraph work');
    }
  }

  async execute(request, signal) {
    if (!this.enabled) throw new HostError('Orca host is disabled; enable adapters.orca.enabled after a pinned live canary');
    this.assertSafeNode(request);
    this.commandTrace.length = 0;
    const agent = this.selectAgent(request);
    const reportPath = `${this.reportDir}/${request.request_id}.json`.replace(/\\/g, '/');
    const spec = buildWorkerSpec(request, reportPath);
    const specBytes = Buffer.byteLength(spec, 'utf8');
    if (specBytes > this.maxSpecBytes) throw new HostError(`Orca task spec exceeds ${this.maxSpecBytes} bytes`, { bytes: specBytes });
    const title = String(request.node.title ?? request.node.node_id).slice(0, 160);
    const display = `${request.node.role}:${request.node.node_id}`.slice(0, 120);
    const taskResponse = await this.client.call([
      'orchestration', 'task-create', '--task-title', title, '--display-name', display, '--spec', spec,
    ], { signal, timeoutMs: 60_000 });
    const taskId = findFirstField(taskResponse.data, ['taskId', 'task_id']) ?? findFirstField(taskResponse.data, ['id']);
    if (!taskId) throw new HostError('Orca task-create did not return a task ID');

    const worktreeName = `${slug(request.run_id, 18)}-${slug(request.node.node_id, 18)}-${request.attempt}-${shortHash(request.request_id)}`.slice(0, 63);
    const worktreeArgs = ['worktree', 'create'];
    if (this.repoSelector) worktreeArgs.push('--repo', this.repoSelector);
    worktreeArgs.push('--name', worktreeName, '--agent', agent, '--setup', this.setup, '--no-parent');
    const worktreeResponse = await this.client.call(worktreeArgs, { signal, timeoutMs: 120_000 });
    const worktreeId = findFirstField(worktreeResponse.data, ['worktreeId', 'worktree_id']) ?? findFirstField(worktreeResponse.data, ['id']);
    const worktreePath = findFirstField(worktreeResponse.data, ['worktreePath', 'worktree_path', 'rootPath', 'root_path', 'path']);
    if (!worktreeId) throw new HostError('Orca worktree create did not return a worktree ID');
    const worktreeSelector = `id:${worktreeId}`;
    let terminalHandle = await this.terminalForWorktree(worktreeSelector, signal);
    terminalHandle = await this.waitForTerminal(worktreeSelector, terminalHandle, signal);

    const dispatchResponse = await this.client.call([
      'orchestration', 'dispatch', '--task', taskId, '--to', terminalHandle, '--inject',
    ], { signal, timeoutMs: 60_000 });
    const dispatchId = findFirstField(dispatchResponse.data, ['dispatchId', 'dispatch_id']) ?? findFirstField(dispatchResponse.data, ['id']);
    if (!dispatchId) throw new HostError('Orca dispatch did not return a dispatch ID');

    const event = await this.awaitResult({ taskId, dispatchId, terminalHandle, signal });
    this.assertNoForbiddenCommands();
    const commonMetadata = {
      orca: { task_id: taskId, dispatch_id: dispatchId, worktree_id: worktreeId, worktree_path: worktreePath, terminal_handle: terminalHandle, agent, integration_mode: 'compatibility_bridge', strict_orca_native: false, decision_gates_seen: event.decisionGatesSeen ?? 0, stale_dispatch_messages: event.staleDispatchMessages ?? 0 },
    };
    if (event.kind === 'decision_gate') {
      return {
        outcome: 'blocked',
        summary: messageBody(event.message) || 'Orca worker requested a decision gate',
        output: { orca_gate: event.message }, usage: {}, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: commonMetadata,
      };
    }
    if (event.kind === 'escalation') {
      const result = classifyEscalation(event.message);
      result.metadata = commonMetadata;
      return result;
    }
    const messageReportPath = field(event.message, 'reportPath', 'report_path');
    if (messageReportPath == null) {
      if (!this.allowInlineResult) {
        throw new HostError('Orca worker_done must include the exact contracted report path');
      }
      const body = messageBody(event.message);
      if (Buffer.byteLength(body, 'utf8') > this.maxReportBytes) throw new HostError('Orca worker_done body result exceeds the report limit');
      let bodyResult;
      try { bodyResult = JSON.parse(body); }
      catch { throw new HostError('Orca worker_done contains neither the contracted report path nor a valid ProofGraph AgentResult JSON body'); }
      bodyResult.metadata = {
        ...(bodyResult.metadata && typeof bodyResult.metadata === 'object' && !Array.isArray(bodyResult.metadata) ? bodyResult.metadata : {}),
        ...commonMetadata,
      };
      return bodyResult;
    }

    const messageCandidate = path.resolve(worktreePath ?? '/', String(messageReportPath));
    const rootCandidate = worktreePath ? path.resolve(worktreePath) : null;
    if (path.isAbsolute(String(messageReportPath)) || !rootCandidate || !messageCandidate.startsWith(`${rootCandidate}${path.sep}`)) {
      throw new HostError('Orca worker_done report path escapes the worktree', { report_path: messageReportPath });
    }
    if (messageReportPath !== reportPath) {
      throw new HostError('Orca worker_done report path does not match the dispatch contract or escapes the worktree', { expected: reportPath, observed: messageReportPath });
    }
    const report = await safeReadReport(worktreePath, reportPath, this.maxReportBytes);
    const parsed = report.parsed;
    parsed.metadata = {
      ...(parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata) ? parsed.metadata : {}),
      ...commonMetadata,
      orca: { ...commonMetadata.orca, report_path: report.absolutePath },
    };
    return parsed;
  }
}
