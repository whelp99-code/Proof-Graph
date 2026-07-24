#!/usr/bin/env node
import { getActiveState, readHookInput, reserveAllowedAgent, reserveAllowedTool, structuredDecision, writeJson } from './hook-lib.mjs';

const OWN_MCP_PREFIX = 'mcp__plugin_proofgraph-claude_proofgraph__';
const ALLOWED_AGENTS = new Set([
  'proofgraph-claude:planner',
  'proofgraph-claude:researcher',
  'proofgraph-claude:verifier',
  'proofgraph-claude:synthesizer',
]);
const SAFE_BUILTINS = new Set([
  'WebSearch',
  'Agent',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
]);

function agentTypeFromInput(toolInput = {}) {
  return toolInput.subagent_type || toolInput.agent_type || toolInput.type || toolInput.name || null;
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
  if (!SAFE_BUILTINS.has(toolName)) {
    writeJson(structuredDecision('deny', `Tool ${toolName || '<unknown>'} is not in the ProofGraph read-only allowlist while run ${active.run_id} is active.`));
    process.exit(0);
  }
  if (toolName === 'Agent') {
    const agentType = agentTypeFromInput(payload.tool_input);
    if (!agentType || !ALLOWED_AGENTS.has(agentType)) {
      writeJson(structuredDecision('deny', `Only ProofGraph plugin agents may be spawned during an active run. Requested: ${String(agentType)}`));
      process.exit(0);
    }
    const reservation = await reserveAllowedAgent(payload, agentType);
    if (!reservation.allowed) {
      writeJson(structuredDecision('deny', reservation.reason || 'ProofGraph agent budget exhausted'));
      process.exit(0);
    }
  }
  if (toolName === 'WebSearch') {
    await reserveAllowedTool(payload, toolName);
  }
  if (state?.status === 'budget_exceeded') {
    writeJson(structuredDecision('deny', 'The ProofGraph run exceeded its budget. Use pg_get_status and pg_abort_run; no further agent or open-world operations are permitted.'));
    process.exit(0);
  }
  writeJson(structuredDecision('allow', `Read-only tool allowed for active ProofGraph run ${active.run_id}`));
} catch (error) {
  writeJson(structuredDecision('deny', `ProofGraph guard failed closed: ${error.message}`));
}
