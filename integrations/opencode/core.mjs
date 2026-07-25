import { createBridgeClient, likelyExternalSideEffect, likelyMutation } from './bridge-client.mjs';

function eventType(sourceType) {
  if (sourceType === 'permission.asked') return 'permission.requested';
  if (sourceType === 'permission.replied') return 'permission.resolved';
  if (sourceType === 'session.created') return 'session.created';
  if (sourceType === 'session.status') return 'session.status';
  if (sourceType === 'session.idle') return 'session.idle';
  if (sourceType === 'session.error') return 'session.error';
  if (sourceType === 'message.updated') return 'message.updated';
  if (sourceType === 'file.edited' || sourceType === 'session.diff') return 'artifact.created';
  if (sourceType === 'command.executed' || sourceType === 'tui.command.execute') return 'ui.command';
  return null;
}

function findField(value, names) {
  const wanted = new Set(names);
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      for (const [key, field] of Object.entries(current)) {
        if (wanted.has(key) && (typeof field === 'string' || typeof field === 'number')) return String(field);
      }
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

function text(value, max = 10_000) {
  return String(value ?? '').trim().slice(0, max);
}

function resultText(payload) {
  return JSON.stringify(payload?.result ?? payload, null, 2);
}

export function createOpenCodeProofGraphPlugin(options = {}) {
  const bridge = options.bridge ?? createBridgeClient({ host: 'opencode', env: options.env, fetch: options.fetch });
  const directory = options.directory ?? process.cwd();
  const worktree = options.worktree ?? directory;
  const isolated = worktree !== directory || options.workspaceIsolated === true;
  const toolFactory = options.toolFactory ?? ((definition) => definition);
  const logger = options.logger ?? (() => {});
  let activeRunId = options.runId ?? options.env?.PROOFGRAPH_RUN_ID ?? process.env.PROOFGRAPH_RUN_ID ?? null;

  async function postEvent(sourceEvent, override = {}) {
    const type = override.type ?? eventType(sourceEvent?.type);
    if (!type) return null;
    try {
      return await bridge.event(type, {
        run_id: activeRunId ?? undefined,
        session_id: override.session_id ?? findField(sourceEvent, ['sessionID', 'sessionId', 'session_id']),
        node_id: override.node_id,
        request_id: override.request_id,
        payload: {
          source_type: sourceEvent?.type ?? type,
          source_id: findField(sourceEvent, ['id', 'messageID', 'messageId', 'permissionID', 'permissionId']),
          status: findField(sourceEvent, ['status', 'state', 'type']),
          ...(override.payload ?? {}),
        },
      });
    } catch (error) {
      logger('warn', 'ProofGraph event forwarding failed', { error: error.message, type });
      return null;
    }
  }

  async function command(name, fields = {}) {
    const response = await bridge.command(name, fields);
    const runId = response?.result?.run_id;
    if (runId) activeRunId = runId;
    return response;
  }

  const objectiveArgs = () => options.schema?.object?.({
    objective: options.schema.string(),
    template: options.schema.optional(options.schema.string()),
    adapter: options.schema.optional(options.schema.string()),
  }) ?? {};
  const runArgs = () => options.schema?.object?.({ run_id: options.schema.optional(options.schema.string()) }) ?? {};

  const tools = {
    proofgraph_compile: toolFactory({
      description: 'Compile a ProofGraph development graph without executing it.',
      args: objectiveArgs(),
      async execute(args) {
        return resultText(await command('compile', { payload: { objective: args.objective, template: args.template } }));
      },
    }),
    proofgraph_start: toolFactory({
      description: 'Create a ProofGraph run without executing ready nodes.',
      args: objectiveArgs(),
      async execute(args) {
        const payload = await command('start', { payload: { objective: args.objective, template: args.template, adapter: args.adapter ?? 'opencode' } });
        return resultText(payload);
      },
    }),
    proofgraph_run: toolFactory({
      description: 'Compile and execute a ProofGraph run using OpenCode as the default worker adapter.',
      args: objectiveArgs(),
      async execute(args) {
        const payload = await command('run', { payload: { objective: args.objective, template: args.template, adapter: args.adapter ?? 'opencode' } });
        return resultText(payload);
      },
    }),
    proofgraph_resume: toolFactory({
      description: 'Resume an existing ProofGraph run using OpenCode as the default worker adapter.',
      args: runArgs(),
      async execute(args) {
        const runId = args.run_id ?? activeRunId;
        if (!runId) throw new Error('No ProofGraph run is active');
        return resultText(await command('resume', { run_id: runId, payload: { adapter: 'opencode' } }));
      },
    }),
    proofgraph_status: toolFactory({
      description: 'Read the current status of a ProofGraph run.',
      args: runArgs(),
      async execute(args) {
        const runId = args.run_id ?? activeRunId;
        if (!runId) throw new Error('No ProofGraph run is active');
        return resultText(await command('status', { run_id: runId }));
      },
    }),
    proofgraph_report: toolFactory({
      description: 'Read the final or current ProofGraph report.',
      args: options.schema?.object?.({ run_id: options.schema.optional(options.schema.string()), format: options.schema.optional(options.schema.string()) }) ?? {},
      async execute(args) {
        const runId = args.run_id ?? activeRunId;
        if (!runId) throw new Error('No ProofGraph run is active');
        return resultText(await command('report', { run_id: runId, payload: { format: args.format ?? 'json' } }));
      },
    }),
    proofgraph_integrity: toolFactory({
      description: 'Verify the ProofGraph state, event, and report integrity for a run.',
      args: runArgs(),
      async execute(args) {
        const runId = args.run_id ?? activeRunId;
        if (!runId) throw new Error('No ProofGraph run is active');
        return resultText(await command('integrity', { run_id: runId }));
      },
    }),
  };

  const hooks = {
    tool: tools,
    event: async ({ event }) => postEvent(event),
    'tool.execute.before': async (input, output) => {
      const toolName = text(input?.tool ?? input?.name, 160);
      if (!toolName || toolName.startsWith('proofgraph_')) return;
      if (!activeRunId) return;
      let response;
      try {
        response = await bridge.toolPolicy({
          run_id: activeRunId,
          session_id: findField(input, ['sessionID', 'sessionId', 'session_id']),
          tool: toolName,
          arguments: output?.args ?? input?.args ?? {},
          cwd: worktree,
          workspace_isolated: isolated,
          mutation: likelyMutation(toolName),
          external_side_effect: likelyExternalSideEffect(toolName),
        });
      } catch (error) {
        throw new Error(`ProofGraph policy bridge unavailable during active run: ${error.message}`);
      }
      const decision = response?.decision?.decision;
      if (decision !== 'allow') {
        throw new Error(`ProofGraph ${decision ?? 'deny'}: ${response?.decision?.reason ?? 'tool blocked'}`);
      }
      await postEvent({ type: 'tool.requested', input }, { type: 'tool.requested', payload: { tool: toolName, decision } });
    },
    'tool.execute.after': async (input, output) => {
      const toolName = text(input?.tool ?? input?.name, 160);
      await postEvent({ type: 'tool.completed', input }, { type: 'tool.completed', payload: { tool: toolName, output_present: output != null } });
    },
    'shell.env': async (_input, output) => {
      if (activeRunId) output.env.PROOFGRAPH_RUN_ID = activeRunId;
      output.env.PROOFGRAPH_HOST = 'opencode';
    },
  };

  return { hooks, getActiveRunId: () => activeRunId, setActiveRunId: (value) => { activeRunId = value || null; } };
}
