import { createBridgeClient, likelyExternalSideEffect, likelyMutation } from './bridge-client.mjs';

function outputText(value) {
  return JSON.stringify(value?.result ?? value, null, 2);
}

function findRunEntry(ctx) {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === 'custom' && entry?.customType === 'proofgraph-run' && typeof entry?.data?.run_id === 'string') return entry.data.run_id;
  }
  return null;
}

function statusLines(status) {
  const result = status?.result ?? status;
  if (!result || typeof result !== 'object') return ['ProofGraph: unavailable'];
  const nodes = Array.isArray(result.node_states) ? result.node_states : [];
  const counts = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  return [
    `ProofGraph ${result.run_id ?? ''}`.trim(),
    `state=${result.status ?? 'unknown'} revision=${result.graph_revision ?? '?'}`,
    `ready=${(result.ready_nodes ?? []).length} running=${counts.running ?? 0} failed=${counts.failed ?? 0}`,
    `approvals=${(result.pending_approvals ?? []).length}`,
  ];
}

export function createPiProofGraphExtension(pi, options = {}) {
  const bridge = options.bridge ?? createBridgeClient({ host: 'pi', env: options.env, fetch: options.fetch });
  const schema = options.schema ?? {};
  let activeRunId = options.runId ?? options.env?.PROOFGRAPH_RUN_ID ?? process.env.PROOFGRAPH_RUN_ID ?? null;

  function remember(runId) {
    activeRunId = runId || null;
    if (activeRunId) pi.appendEntry('proofgraph-run', { run_id: activeRunId, updated_at: new Date().toISOString() });
  }

  async function command(name, fields = {}) {
    const response = await bridge.command(name, fields);
    const runId = response?.result?.run_id;
    if (runId) remember(runId);
    return response;
  }

  async function showStatus(ctx, runId = activeRunId) {
    if (!runId) {
      ctx.ui.notify('No ProofGraph run is active', 'warning');
      ctx.ui.setStatus('proofgraph', 'idle');
      ctx.ui.setWidget('proofgraph', ['ProofGraph: no active run']);
      return null;
    }
    const response = await command('status', { run_id: runId });
    const lines = statusLines(response);
    ctx.ui.setStatus('proofgraph', lines[1] ?? 'active');
    ctx.ui.setWidget('proofgraph', lines);
    return response;
  }

  pi.registerCommand('pg', {
    description: 'Start a ProofGraph graph-engineered development run',
    handler: async (args, ctx) => {
      const objective = String(args ?? '').trim();
      if (!objective) {
        ctx.ui.notify('Usage: /pg <objective>', 'warning');
        return;
      }
      try {
        const response = await command('run', { payload: { objective, adapter: 'pi' } });
        ctx.ui.notify(`ProofGraph run executed: ${response.result.run_id}`, 'success');
        await showStatus(ctx, response.result.run_id);
      } catch (error) { ctx.ui.notify(`ProofGraph start failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-status', {
    description: 'Show the active ProofGraph run status',
    handler: async (args, ctx) => {
      const runId = String(args ?? '').trim() || activeRunId;
      try { await showStatus(ctx, runId); }
      catch (error) { ctx.ui.notify(`ProofGraph status failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-resume', {
    description: 'Resume the active ProofGraph run',
    handler: async (args, ctx) => {
      const runId = String(args ?? '').trim() || activeRunId;
      if (!runId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      try {
        const response = await command('resume', { run_id: runId, payload: { adapter: 'pi' } });
        ctx.ui.notify(`ProofGraph run resumed: ${runId}`, 'success');
        await showStatus(ctx, response?.result?.run_id ?? runId);
      } catch (error) { ctx.ui.notify(`ProofGraph resume failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-integrity', {
    description: 'Verify active ProofGraph run integrity',
    handler: async (args, ctx) => {
      const runId = String(args ?? '').trim() || activeRunId;
      if (!runId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      try { ctx.ui.notify(outputText(await command('integrity', { run_id: runId })).slice(0, 20_000), 'info'); }
      catch (error) { ctx.ui.notify(`ProofGraph integrity failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-report', {
    description: 'Show the ProofGraph report',
    handler: async (args, ctx) => {
      const runId = String(args ?? '').trim() || activeRunId;
      if (!runId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      try {
        const response = await command('report', { run_id: runId, payload: { format: 'markdown' } });
        ctx.ui.notify(outputText(response).slice(0, 20_000), 'info');
      } catch (error) { ctx.ui.notify(`ProofGraph report failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-approve', {
    description: 'Approve a pending ProofGraph gate: /pg-approve <approval_id> <challenge>',
    handler: async (args, ctx) => {
      if (!activeRunId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      const [approvalId, challenge] = String(args ?? '').trim().split(/\s+/, 2);
      if (!approvalId || !challenge) return ctx.ui.notify('Usage: /pg-approve <approval_id> <challenge>', 'warning');
      const confirmed = await ctx.ui.confirm('ProofGraph approval', `Approve ${approvalId} for run ${activeRunId}?`);
      if (!confirmed) return ctx.ui.notify('Approval cancelled', 'warning');
      try {
        await command('approve', { run_id: activeRunId, payload: { approval_id: approvalId, challenge, decision_source: 'external_human', comment: 'Approved in Pi TUI' } });
        ctx.ui.notify('ProofGraph approval recorded', 'success');
        await showStatus(ctx);
      } catch (error) { ctx.ui.notify(`Approval failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-deny', {
    description: 'Deny a pending ProofGraph gate: /pg-deny <approval_id> <challenge>',
    handler: async (args, ctx) => {
      if (!activeRunId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      const [approvalId, challenge] = String(args ?? '').trim().split(/\s+/, 2);
      if (!approvalId || !challenge) return ctx.ui.notify('Usage: /pg-deny <approval_id> <challenge>', 'warning');
      const confirmed = await ctx.ui.confirm('ProofGraph denial', `Deny ${approvalId} for run ${activeRunId}?`);
      if (!confirmed) return ctx.ui.notify('Denial cancelled', 'warning');
      try {
        await command('deny', { run_id: activeRunId, payload: { approval_id: approvalId, challenge, decision_source: 'external_human', comment: 'Denied in Pi TUI' } });
        ctx.ui.notify('ProofGraph denial recorded', 'success');
        await showStatus(ctx);
      } catch (error) { ctx.ui.notify(`Denial failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerCommand('pg-abort', {
    description: 'Abort the active ProofGraph run',
    handler: async (args, ctx) => {
      if (!activeRunId) return ctx.ui.notify('No ProofGraph run is active', 'warning');
      const confirmed = await ctx.ui.confirm('Abort ProofGraph run', `Abort ${activeRunId}?`);
      if (!confirmed) return;
      try {
        await command('abort', { run_id: activeRunId, payload: { reason: String(args ?? '').trim() || 'Aborted in Pi TUI' } });
        ctx.ui.notify('ProofGraph run aborted', 'success');
        await showStatus(ctx);
      } catch (error) { ctx.ui.notify(`Abort failed: ${error.message}`, 'error'); }
    },
  });

  pi.registerTool({
    name: 'proofgraph_run', label: 'ProofGraph Run', description: 'Compile and execute a ProofGraph run and return its structured state.',
    parameters: schema.object?.({ objective: schema.string?.(), template: schema.optional?.(schema.string?.()), adapter: schema.optional?.(schema.string?.()) }) ?? {},
    async execute(_toolCallId, params) { return { content: [{ type: 'text', text: outputText(await command('run', { payload: { ...params, adapter: params.adapter ?? 'pi' } })) }], details: {} }; },
  });
  pi.registerTool({
    name: 'proofgraph_status', label: 'ProofGraph Status', description: 'Read the active ProofGraph run status.',
    parameters: schema.object?.({ run_id: schema.optional?.(schema.string?.()) }) ?? {},
    async execute(_toolCallId, params) {
      const runId = params.run_id ?? activeRunId;
      if (!runId) throw new Error('No ProofGraph run is active');
      return { content: [{ type: 'text', text: outputText(await command('status', { run_id: runId })) }], details: {} };
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    activeRunId = activeRunId ?? findRunEntry(ctx);
    if (activeRunId) await showStatus(ctx).catch((error) => ctx.ui.notify(`ProofGraph reconnect failed: ${error.message}`, 'warning'));
    else ctx.ui.setStatus('proofgraph', 'idle');
    await bridge.event('host.connected', { run_id: activeRunId ?? undefined, payload: { mode: ctx.hasUI ? 'interactive' : 'headless' } }).catch(() => null);
  });
  pi.on('session_shutdown', async () => {
    await bridge.event('host.disconnected', { run_id: activeRunId ?? undefined, payload: {} }).catch(() => null);
  });
  pi.on('agent_start', async () => bridge.event('session.status', { run_id: activeRunId ?? undefined, payload: { status: 'agent_start' } }).catch(() => null));
  pi.on('agent_end', async (_event, ctx) => {
    await bridge.event('session.idle', { run_id: activeRunId ?? undefined, payload: {} }).catch(() => null);
    if (activeRunId && ctx.hasUI) await showStatus(ctx).catch(() => null);
  });
  pi.on('tool_call', async (event, ctx) => {
    const toolName = String(event.toolName ?? '');
    if (!activeRunId || toolName.startsWith('proofgraph_')) return;
    try {
      const response = await bridge.toolPolicy({
        run_id: activeRunId,
        tool: toolName,
        arguments: event.input ?? {},
        cwd: ctx.cwd,
        workspace_isolated: options.workspaceIsolated === true,
        mutation: likelyMutation(toolName),
        external_side_effect: likelyExternalSideEffect(toolName),
      });
      if (response?.decision?.decision !== 'allow') return { block: true, reason: `ProofGraph ${response?.decision?.decision ?? 'deny'}: ${response?.decision?.reason ?? 'tool blocked'}` };
      await bridge.event('tool.requested', { run_id: activeRunId, payload: { tool: toolName, decision: 'allow' } }).catch(() => null);
    } catch (error) {
      return { block: true, reason: `ProofGraph policy bridge unavailable during active run: ${error.message}` };
    }
  });
  pi.on('tool_result', async (event) => {
    await bridge.event(event.isError ? 'tool.failed' : 'tool.completed', { run_id: activeRunId ?? undefined, payload: { tool: event.toolName, is_error: event.isError === true } }).catch(() => null);
  });

  return { getActiveRunId: () => activeRunId, setActiveRunId: remember, showStatus };
}
