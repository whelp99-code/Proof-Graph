import { parseAgentResultFromOutput } from '../adapters/result-parser.mjs';
import { AGENT_RESULT_JSON_SCHEMA } from '../adapters/agent-result-schema.mjs';
import { ExecutionHost, HostError, booleanOption, optionalString, positiveInteger } from './base.mjs';
import { OpenCodeClient, openCodeMessageText } from './opencode-client.mjs';

const ROLES = ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'];

function normalizeAgentMap(input = {}, allowHostTools = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HostError('OpenCode agent_map must be an object');
  const defaults = {
    direct: 'plan', researcher: 'plan', planner: 'plan', developer: allowHostTools ? 'build' : 'plan', verifier: 'plan', synthesizer: 'plan',
  };
  const output = { ...defaults };
  for (const [role, agent] of Object.entries(input)) {
    if (!ROLES.includes(role)) throw new HostError(`Unsupported OpenCode role mapping: ${role}`);
    if (typeof agent !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) throw new HostError(`Invalid OpenCode agent for ${role}`);
    output[role] = agent;
  }
  return output;
}

function modelBody(model) {
  if (model == null) return undefined;
  if (typeof model === 'string') {
    const [providerID, ...parts] = model.split('/');
    if (!providerID || !parts.length) throw new HostError('OpenCode model string must use provider/model format');
    return { providerID, modelID: parts.join('/') };
  }
  if (model && typeof model === 'object' && !Array.isArray(model) && typeof model.providerID === 'string' && typeof model.modelID === 'string') {
    return { providerID: model.providerID, modelID: model.modelID };
  }
  throw new HostError('OpenCode model must be provider/model or {providerID, modelID}');
}

function messageBody(request, agent, model, options = {}) {
  const mutatingTools = ['bash', 'edit', 'write', 'patch', 'apply_patch'];
  return {
    agent,
    ...(model ? { model } : {}),
    system: 'ProofGraph owns orchestration, retries, approvals, and final state. Return only the contracted AgentResult JSON object.',
    format: {
      type: 'json_schema',
      schema: AGENT_RESULT_JSON_SCHEMA,
      retryCount: options.retryCount ?? 2,
    },
    ...(!options.allowHostTools ? { tools: Object.fromEntries(mutatingTools.map((name) => [name, false])) } : {}),
    parts: [{ type: 'text', text: request.prompt }],
  };
}

function structuredOutput(message) {
  return message?.info?.structured_output
    ?? message?.data?.info?.structured_output
    ?? message?.structured_output
    ?? null;
}

function structuredOutputError(message) {
  return message?.info?.error ?? message?.data?.info?.error ?? null;
}

export class OpenCodeExecutionHost extends ExecutionHost {
  constructor(options = {}) {
    super({ name: 'opencode' });
    this.enabled = booleanOption(options.enabled, false, 'OpenCode enabled');
    this.allowHostTools = booleanOption(options.allowHostTools, false, 'OpenCode allowHostTools');
    this.requireIsolatedWorkspace = booleanOption(options.requireIsolatedWorkspace, true, 'OpenCode requireIsolatedWorkspace');
    this.keepSessions = booleanOption(options.keepSessions, true, 'OpenCode keepSessions');
    this.pureWorkerConfirmed = booleanOption(options.pureWorkerConfirmed, false, 'OpenCode pureWorkerConfirmed');
    this.maxMessages = positiveInteger(options.maxMessages, 50, 'OpenCode maxMessages', { min: 1, max: 500 });
    this.agentMap = normalizeAgentMap(options.agentMap, this.allowHostTools);
    this.defaultModel = options.model ?? null;
    this.client = options.client ?? new OpenCodeClient({
      baseUrl: optionalString(options.baseUrl, 'http://127.0.0.1:4096', 'OpenCode baseUrl', { max: 2048 }),
      username: optionalString(options.username, 'opencode', 'OpenCode username', { max: 256 }),
      password: options.password ?? null,
      allowRemote: booleanOption(options.allowRemote, false, 'OpenCode allowRemote'),
      allowInsecureRemote: booleanOption(options.allowInsecureRemote, false, 'OpenCode allowInsecureRemote'),
      timeoutMs: positiveInteger(options.timeoutMs, 300_000, 'OpenCode timeoutMs', { min: 1000, max: 3_600_000 }),
      maxResponseBytes: positiveInteger(options.maxResponseBytes, 2_000_000, 'OpenCode maxResponseBytes', { min: 1024, max: 100_000_000 }),
      fetch: options.fetch,
    });
  }

  async doctor() {
    if (!this.enabled) return { ok: false, host: this.name, mode: 'server-api', enabled: false, live_canary_required: true, error: 'OpenCode host is disabled' };
    if (!this.pureWorkerConfirmed) return { ok: false, host: this.name, mode: 'server-api', enabled: true, pure_worker_confirmed: false, live_canary_required: true, error: 'OpenCode worker server must be a dedicated --pure instance with no ProofGraph host plugin' };
    try {
      const [health, project, agents] = await Promise.all([this.client.health(), this.client.currentProject(), this.client.agents()]);
      return {
        ok: health?.healthy === true,
        host: this.name,
        mode: 'server-api',
        enabled: true,
        version: health?.version ?? null,
        project,
        agents: Array.isArray(agents) ? agents.map((agent) => agent?.name ?? agent?.id).filter(Boolean) : [],
        permission_bridge: true,
        event_stream: true,
        pure_worker_confirmed: true,
        live_canary_required: true,
      };
    } catch (error) {
      return { ok: false, host: this.name, mode: 'server-api', enabled: true, error: error.message, live_canary_required: true };
    }
  }

  async execute(request, signal) {
    if (!this.enabled) throw new HostError('OpenCode host is disabled');
    if (!this.pureWorkerConfirmed) throw new HostError('OpenCode worker server requires pure_worker_confirmed=true after starting a dedicated opencode --pure server');
    const mutatingRole = request.node.kind === 'develop';
    const isolated = request.workspace?.isolated === true;
    if (mutatingRole && this.allowHostTools && this.requireIsolatedWorkspace && !isolated) {
      throw new HostError('OpenCode build agent requires an isolated ProofGraph workspace');
    }
    const agent = request.node.metadata?.opencode_agent ?? this.agentMap[request.node.role] ?? 'plan';
    const model = modelBody(request.node.model ?? request.metadata?.model ?? this.defaultModel);
    const title = `ProofGraph ${request.run_id}/${request.node.node_id}#${request.attempt}`.slice(0, 200);
    const session = await this.client.createSession({ title }, { signal });
    const sessionId = session?.id ?? session?.sessionID ?? session?.sessionId;
    if (!sessionId) throw new HostError('OpenCode did not return a session id', { session });
    try {
      const message = await this.client.sendMessage(
        sessionId,
        messageBody(request, agent, model, { allowHostTools: this.allowHostTools && isolated }),
        { signal },
      );
      const schemaError = structuredOutputError(message);
      if (schemaError?.name === 'StructuredOutputError') {
        throw new HostError(`OpenCode structured output failed: ${schemaError.message ?? 'schema validation failed'}`, {
          session_id: sessionId,
          retries: schemaError.retries ?? null,
        });
      }
      const contracted = structuredOutput(message);
      let result;
      let usedStructuredOutput = false;
      if (contracted && typeof contracted === 'object' && !Array.isArray(contracted)) {
        result = structuredClone(contracted);
        usedStructuredOutput = true;
      } else {
        const text = openCodeMessageText(message);
        if (!text) throw new HostError('OpenCode response did not contain structured or text output', { session_id: sessionId });
        try {
          result = structuredClone(parseAgentResultFromOutput(text, { source: 'opencode-server' }).result);
        } catch (error) {
          throw new HostError(`OpenCode response could not be parsed as a valid AgentResult JSON object: ${error.message}`, {
            session_id: sessionId,
            cause: error.message,
          });
        }
      }
      const diff = await this.client.diff(sessionId, { signal }).catch(() => []);
      result.metadata = {
        ...(result.metadata ?? {}),
        opencode: {
          session_id: sessionId,
          agent,
          model: model ?? null,
          server_transport: true,
          workspace_isolated: isolated,
          structured_output: usedStructuredOutput,
          diff_count: Array.isArray(diff) ? diff.length : 0,
        },
      };
      if (Array.isArray(diff) && diff.length) {
        result.artifacts = [...(result.artifacts ?? []), { type: 'opencode.diff', session_id: sessionId, files: diff }];
      }
      return result;
    } catch (error) {
      await this.client.abortSession(sessionId).catch(() => null);
      throw error;
    } finally {
      if (!this.keepSessions) await this.client.request('DELETE', `/session/${encodeURIComponent(sessionId)}`).catch(() => null);
    }
  }
}
