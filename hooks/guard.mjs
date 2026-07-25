#!/usr/bin/env node
import { getActiveState, readHookInput, reserveAllowedAgent, reserveAllowedTool, structuredDecision, writeJson } from './hook-lib.mjs';

const OWN_MCP_PREFIX = 'mcp__plugin_proofgraph-claude_proofgraph__';
const LEGACY_AGENTS = new Set([
  'proofgraph-claude:planner',
  'proofgraph-claude:researcher',
  'proofgraph-claude:verifier',
  'proofgraph-claude:synthesizer',
]);
const GRAPH_AGENTS = new Set([
  'proofgraph-claude:graph-direct',
  'proofgraph-claude:graph-researcher',
  'proofgraph-claude:graph-planner',
  'proofgraph-claude:graph-developer',
  'proofgraph-claude:graph-verifier',
  'proofgraph-claude:graph-verifier-deep',
  'proofgraph-claude:graph-synthesizer',
]);
const SAFE_CONTROL_BUILTINS = new Set(['Agent', 'TaskOutput', 'TaskStop', 'AskUserQuestion']);
const GRAPH_READ_TO_CAPABILITY = new Map([
  ['WebSearch', 'web_search'],
  ['Read', 'workspace_read'],
  ['Glob', 'workspace_read'],
  ['Grep', 'workspace_read'],
]);

function agentTypeFromInput(toolInput = {}) {
  return toolInput.subagent_type || toolInput.agent_type || toolInput.type || toolInput.name || null;
}

function callerAgentType(payload = {}) {
  return payload.agent_type || payload.agent_name || payload.subagent_type || null;
}

function roleForAgentType(agentType) {
  if (agentType === 'proofgraph-claude:graph-direct') return 'direct';
  if (agentType === 'proofgraph-claude:graph-researcher') return 'researcher';
  if (agentType === 'proofgraph-claude:graph-planner') return 'planner';
  if (agentType === 'proofgraph-claude:graph-developer') return 'developer';
  if (['proofgraph-claude:graph-verifier', 'proofgraph-claude:graph-verifier-deep'].includes(agentType)) return 'verifier';
  if (agentType === 'proofgraph-claude:graph-synthesizer') return 'synthesizer';
  return null;
}

function graphReadyAgentAllowed(state, agentType) {
  return state.graph?.nodes?.some((node) =>
    node.agent_type === agentType && state.node_states?.[node.node_id]?.status === 'ready');
}

function graphReadAllowed(state, payload, capability) {
  const agentType = callerAgentType(payload);
  const role = roleForAgentType(agentType);
  if (!role) return false;
  return state.graph?.nodes?.some((node) => {
    const runtime = state.node_states?.[node.node_id];
    return node.role === role
      && node.agent_type === agentType
      && runtime?.status === 'running'
      && runtime.actor === role
      && node.tool_policy?.includes(capability);
  });
}

try {
  const payload = await readHookInput();
  const { active, state } = await getActiveState(payload);
  if (!active) process.exit(0);
  const toolName = String(payload.tool_name ?? '');

  if (toolName.startsWith(OWN_MCP_PREFIX)) {
    writeJson(structuredDecision('allow', `ProofGraph local MCP tool allowed for active run ${active.run_id}`));
    process.exit(0);
  }
  if (toolName.startsWith('mcp__')) {
    writeJson(structuredDecision('deny', 'External MCP tools are blocked while a ProofGraph run is active. Use the bundled ProofGraph MCP server only.'));
    process.exit(0);
  }
  if (state?.status === 'budget_exceeded') {
    writeJson(structuredDecision('deny', `ProofGraph run ${active.run_id} exceeded its budget. Only bundled MCP status, integrity, report, and abort tools remain available.`));
    process.exit(0);
  }

  if (toolName === 'Agent') {
    const requested = agentTypeFromInput(payload.tool_input);
    const allowedSet = state?.run_kind === 'graph' ? GRAPH_AGENTS : LEGACY_AGENTS;
    if (!requested || !allowedSet.has(requested)) {
      writeJson(structuredDecision('deny', `Only agents registered for this ProofGraph run kind may be spawned. Requested: ${String(requested)}`));
      process.exit(0);
    }
    if (state?.run_kind === 'graph' && !graphReadyAgentAllowed(state, requested)) {
      writeJson(structuredDecision('deny', `Agent ${requested} does not correspond to a currently ready graph node.`));
      process.exit(0);
    }
    const reservation = await reserveAllowedAgent(payload, requested);
    if (!reservation.allowed) {
      writeJson(structuredDecision('deny', reservation.reason || 'ProofGraph agent budget exhausted'));
      process.exit(0);
    }
    writeJson(structuredDecision('allow', `Registered ProofGraph agent allowed for run ${active.run_id}`));
    process.exit(0);
  }

  if (SAFE_CONTROL_BUILTINS.has(toolName)) {
    if (toolName === 'AskUserQuestion' && state?.run_kind === 'graph' && state.status !== 'waiting_approval') {
      writeJson(structuredDecision('allow', `User clarification is allowed; no approval state is implied for run ${active.run_id}.`));
    } else {
      writeJson(structuredDecision('allow', `ProofGraph control tool allowed for run ${active.run_id}`));
    }
    process.exit(0);
  }

  const capability = GRAPH_READ_TO_CAPABILITY.get(toolName);
  if (state?.run_kind === 'graph' && capability) {
    if (!graphReadAllowed(state, payload, capability)) {
      writeJson(structuredDecision('deny', `Tool ${toolName} is not authorized by a currently running graph node for caller ${String(callerAgentType(payload))}.`));
      process.exit(0);
    }
    await reserveAllowedTool(payload, toolName);
    writeJson(structuredDecision('allow', `${toolName} is allowed by the running graph node's ${capability} capability.`));
    process.exit(0);
  }

  if (state?.run_kind !== 'graph' && toolName === 'WebSearch') {
    await reserveAllowedTool(payload, toolName);
    writeJson(structuredDecision('allow', `Legacy read-only WebSearch allowed for active run ${active.run_id}`));
    process.exit(0);
  }

  writeJson(structuredDecision('deny', `Tool ${toolName || '<unknown>'} is outside the active ProofGraph capability set. Workspace writes, shell access, WebFetch, other Skills, and external MCP servers remain blocked.`));
} catch (error) {
  writeJson(structuredDecision('deny', `ProofGraph guard failed closed: ${error.message}`));
}
