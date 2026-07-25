import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../server/lib/canonical.mjs';
import { BudgetError, SecurityError, StateError, ValidationError } from '../server/lib/errors.mjs';
import {
  abortGraphRun,
  claimGraphNode,
  completeGraphNode,
  expandGraph,
  getGraphReport,
  getGraphStatus,
  resolveGraphApproval,
  startGraphRun,
  verifyGraphIntegrity,
} from '../server/lib/graph-runtime.mjs';
import { buildAgentPrompt, normalizeAgentRequest, normalizeAgentResult } from './contracts.mjs';
import { AgentRouter } from './router.mjs';
import { DebugPauseError } from './debugger/controller.mjs';

function requestId() {
  return `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function contextFromStatus(status, config) {
  const completed = status.node_states
    .filter((node) => ['succeeded', 'failed', 'blocked'].includes(node.status) && node.output != null)
    .slice(-config.kernel.max_context_nodes)
    .map((node) => ({
      node_id: node.node_id,
      kind: node.kind,
      role: node.role,
      status: node.status,
      output: node.output,
      failure: node.failure,
      output_sha256: node.output_sha256,
    }));
  while (Buffer.byteLength(canonicalJson(completed), 'utf8') > config.kernel.max_context_bytes && completed.length > 1) {
    completed.shift();
  }
  return completed;
}


function toGraphFailure(failure) {
  if (!failure) return null;
  const allowedRoutes = new Set(['research', 'plan', 'develop', 'verify', 'human', 'partial', 'failed']);
  return {
    failure_type: failure.failure_type,
    summary: failure.summary,
    severity: failure.severity,
    retryable: failure.retryable,
    evidence: failure.evidence,
    expected: failure.expected ?? undefined,
    observed: failure.observed ?? undefined,
    recommended_route: allowedRoutes.has(failure.recommended_route) ? failure.recommended_route : undefined,
  };
}

function findJoinNode(status, nodeId) {
  const graphNode = status.node_states.find((node) => node.node_id === nodeId);
  const explicit = graphNode?.metadata?.dynamic_join_node_id;
  if (explicit) return explicit;
  const candidates = status.node_states.filter((node) => ['develop', 'verify', 'plan'].includes(node.kind) && node.status === 'pending');
  return candidates[0]?.node_id ?? null;
}

export class ProofGraphKernel {
  constructor({ config, registry, workspace = null, debuggerController = null }) {
    this.config = config;
    this.registry = registry;
    this.router = new AgentRouter(config, registry);
    this.workspace = workspace;
    this.debugger = debuggerController;
  }

  context() {
    return { dataDir: this.config.data_dir, projectDir: this.config.project_dir };
  }

  async start(input) {
    return startGraphRun(input, this.context());
  }

  async startGraph(graph, runtimePolicy = undefined) {
    return this.start({ graph, ...(runtimePolicy ? { runtime_policy: runtimePolicy } : {}) });
  }

  async runGraph(graph, options = {}) {
    const started = await this.startGraph(graph, options.runtimePolicy);
    return this.resume(started.run_id, options);
  }

  async status(runId) {
    return getGraphStatus({ run_id: runId }, this.context());
  }

  async approve(runId, approval) {
    return resolveGraphApproval({ run_id: runId, ...approval }, this.context());
  }

  async abort(runId, reason, actor = 'coordinator') {
    return abortGraphRun({ run_id: runId, actor, reason }, this.context());
  }

  async report(runId, format = 'json') {
    return getGraphReport({ run_id: runId, format }, this.context());
  }

  async integrity(runId) {
    return verifyGraphIntegrity({ run_id: runId }, this.context());
  }

  async run(input, options = {}) {
    const started = await this.start(input);
    return this.resume(started.run_id, options);
  }

  async resume(runId, options = {}) {
    const maxRounds = options.maxRounds ?? this.config.kernel.max_orchestration_rounds;
    const signal = options.signal;
    for (let round = 1; round <= maxRounds; round += 1) {
      if (signal?.aborted) throw signal.reason ?? new StateError('Kernel run aborted');
      const status = await this.status(runId);
      await this.debugger?.onStatus?.(status);
      if (status.status === 'finalized') {
        return {
          ok: true,
          run_id: runId,
          status: status.status,
          report: await this.report(runId, 'json'),
          integrity: await this.integrity(runId),
        };
      }
      if (status.status === 'waiting_approval') {
        return { ok: true, run_id: runId, status: status.status, pending_approvals: status.pending_approvals };
      }
      if (['budget_exceeded', 'failed', 'aborted'].includes(status.status)) {
        return { ok: false, run_id: runId, status: status.status, status_snapshot: status };
      }
      const ready = status.ready_nodes ?? [];
      if (!ready.length) {
        const running = status.node_states.filter((node) => node.status === 'running');
        if (running.length) {
          throw new StateError('Graph contains running nodes without an active kernel invocation', { running: running.map((node) => node.node_id) });
        }
        await this.abort(runId, 'Kernel detected a graph deadlock with no ready, running, approval, or terminal node');
        return { ok: false, run_id: runId, status: 'aborted', reason: 'deadlock' };
      }
      // A debugger single-step is a global execution budget, not a per-node
      // hint. When several nodes are ready in parallel, executing the normal
      // batch would race multiple nodes through a one-node step budget.
      const debuggerState = await this.debugger?.read?.(runId).catch(() => null);
      const parallelLimit = debuggerState?.mode === 'step'
        ? 1
        : (status.policy?.max_parallel_nodes ?? status.assessment?.recommendation?.max_parallel_nodes ?? 1);
      const batch = ready.slice(0, parallelLimit);
      const results = await Promise.allSettled(batch.map((node) => this.executeNode(runId, node, status, { signal, adapter: options.adapter })));
      const rejected = results.filter((result) => result.status === 'rejected');
      const paused = rejected.find((result) => result.reason instanceof DebugPauseError || result.reason?.code === 'DEBUG_PAUSED');
      if (paused) {
        return {
          ok: true,
          run_id: runId,
          status: 'paused',
          debugger: await this.debugger?.read?.(runId),
          status_snapshot: await this.status(runId),
        };
      }
      if (rejected.length && this.config.kernel.fail_fast_on_adapter_error) throw rejected[0].reason;
    }
    throw new BudgetError(`Kernel orchestration round limit exceeded: ${maxRounds}`, { run_id: runId });
  }

  async executeNode(runId, node, statusBefore, options = {}) {
    if (node.kind === 'human_approval' || node.kind === 'terminal' || node.kind === 'triage') {
      throw new SecurityError(`Kernel cannot invoke an adapter for ${node.kind}`);
    }
    await this.debugger?.beforeNode?.({ run_id: runId, node, status: statusBefore });
    let workspaceBefore = null;
    if (this.workspace) {
      await this.workspace.prepare({ run_id: runId, node, status: statusBefore });
      workspaceBefore = await this.workspace.beforeInvocation({ run_id: runId, node });
    }
    const claimed = await claimGraphNode({ run_id: runId, actor: node.role, node_id: node.node_id }, this.context());
    const selected = this.router.select(node, options.adapter);
    const context = contextFromStatus(statusBefore, this.config);
    const baseRequest = {
      request_id: requestId(),
      run_id: runId,
      node,
      objective: statusBefore.objective,
      attempt: claimed.node.attempts,
      model_tier: node.model_tier,
      tool_policy: node.tool_policy,
      context,
      workspace: this.workspace ? await this.workspace.describe(runId) : { enabled: false, isolated: false, project_dir: this.config.project_dir },
      constraints: {
        graph_digest: statusBefore.graph_digest,
        graph_revision: statusBefore.graph_revision,
        deadline_at: statusBefore.deadline_at,
      },
      prompt: 'placeholder',
      metadata: { adapter: selected.name },
    };
    const manifest = selected.adapter.manifest;
    const prompt = buildAgentPrompt(baseRequest, manifest);
    const request = normalizeAgentRequest({ ...baseRequest, prompt });
    let result;
    try {
      let rawResult;
      let invocationError = null;
      try {
        rawResult = await selected.adapter.invoke(request, options.signal);
      } catch (error) {
        invocationError = error;
      }
      if (this.workspace && workspaceBefore) {
        try {
          await this.workspace.afterInvocation({ run_id: runId, node, before: workspaceBefore, allowMutation: false });
        } catch (mutationError) {
          mutationError.cause = invocationError;
          throw mutationError;
        }
      }
      if (invocationError) throw invocationError;
      result = normalizeAgentResult(rawResult, { maxOutputBytes: manifest.max_output_bytes });
      if (node.kind === 'verify' && result.outcome === 'success' && result.output?.verification?.passed !== true) {
        throw new ValidationError('Verifier adapter returned success without output.verification.passed=true');
      }
      if (result.dynamic_tasks.length) {
        if (node.kind !== 'plan') throw new SecurityError('Only plan nodes may request dynamic tasks');
        const latest = await this.status(runId);
        const joinNodeId = result.output?.join_node_id ?? findJoinNode(latest, node.node_id);
        if (!joinNodeId) throw new StateError('No safe join node is available for dynamic expansion');
        await expandGraph({
          run_id: runId,
          actor: 'planner',
          parent_node_id: node.node_id,
          join_node_id: joinNodeId,
          tasks: result.dynamic_tasks,
          reason: result.summary,
        }, this.context());
      }
      if (this.workspace && result.workspace_actions.length) {
        const workspaceReceipt = await this.workspace.executeActions({
          run_id: runId,
          node,
          actions: result.workspace_actions,
          signal: options.signal,
        });
        result.output = { ...result.output, workspace_actions: result.workspace_actions, workspace_receipt: workspaceReceipt };
      }
      const completion = await completeGraphNode({
        run_id: runId,
        actor: node.role,
        node_id: node.node_id,
        outcome: result.outcome,
        output: {
          ...result.output,
          summary: result.summary,
          artifacts: result.artifacts,
          usage: result.usage,
          adapter: selected.name,
          adapter_agent_id: manifest.agent_id,
        },
        ...(result.failure ? { failure: toGraphFailure(result.failure) } : {}),
      }, this.context());
      await this.debugger?.afterNode?.({ run_id: runId, node, request, result, completion });
      return completion;
    } catch (error) {
      if (error instanceof DebugPauseError || error?.code === 'DEBUG_PAUSED') throw error;
      const latest = await this.status(runId).catch(() => null);
      const runtime = latest?.node_states?.find((item) => item.node_id === node.node_id);
      if (runtime && runtime.status !== 'running') throw error;
      const failure = {
        failure_type: error instanceof BudgetError ? 'budget_exceeded' : error instanceof SecurityError ? 'security_risk' : 'unknown',
        summary: `Adapter ${selected.name} failed: ${error.message}`,
        severity: error instanceof SecurityError ? 'high' : 'medium',
        retryable: !(error instanceof SecurityError),
        evidence: [],
        expected: 'A structured AgentResult matching the ProofGraph contract',
        observed: error.message,
        recommended_route: node.kind === 'develop' ? 'develop' : node.kind === 'verify' ? 'verify' : 'plan',
        metadata: { adapter: selected.name, error_name: error.name },
      };
      try {
        const completion = await completeGraphNode({
          run_id: runId,
          actor: node.role,
          node_id: node.node_id,
          outcome: 'failed',
          output: node.kind === 'verify'
            ? { verification: { passed: false, checks: [] }, adapter: selected.name }
            : { adapter: selected.name },
          failure: toGraphFailure(failure),
        }, this.context());
        await this.debugger?.afterNode?.({ run_id: runId, node, request, result: { outcome: 'failed', failure }, completion });
        return completion;
      } catch (completionError) {
        completionError.cause = error;
        throw completionError;
      }
    }
  }
}
