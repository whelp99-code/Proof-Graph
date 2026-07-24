import { canonicalJson, sha256 } from '../server/lib/canonical.mjs';
import {
  clearActiveRun,
  projectKey,
  readActiveRun,
  readVerifiedRun,
  reserveAgentSpawn,
  reserveBudget,
  resolveDataDir,
  withRunTransaction,
} from '../server/lib/store.mjs';

export async function readHookInput(input = process.stdin, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of input) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Hook input exceeds maximum size');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

export function hookContext(payload = {}) {
  const dataDir = resolveDataDir();
  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PROOFGRAPH_PROJECT_DIR || process.cwd();
  const key = projectKey(projectDir);
  return { dataDir, projectDir, key };
}

export async function getActiveState(payload = {}) {
  const context = hookContext(payload);
  const active = await readActiveRun(context.dataDir, context.key);
  if (!active) return { ...context, active: null, state: null };
  const state = await readVerifiedRun(context.dataDir, active.run_id);
  if (['finalized', 'aborted'].includes(state.status)) {
    await clearActiveRun(context.dataDir, context.key, active.run_id);
    return { ...context, active: null, state: null };
  }
  return { ...context, active, state };
}

export function structuredDecision(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function sanitizedToolAudit(payload) {
  const toolInput = payload.tool_input ?? {};
  return {
    hook_event_name: String(payload.hook_event_name ?? ''),
    session_id_sha256: payload.session_id ? sha256(String(payload.session_id)) : null,
    tool_name: payload.tool_name ? String(payload.tool_name) : null,
    tool_input_sha256: sha256(canonicalJson(toolInput)),
    tool_response_sha256: payload.tool_response === undefined ? null : sha256(canonicalJson(payload.tool_response)),
    error_sha256: payload.error === undefined ? null : sha256(String(payload.error)),
  };
}

export async function appendHookAudit(payload, type = 'claude.hook') {
  const { dataDir, active } = await getActiveState(payload);
  if (!active) return false;
  const actor = payload.agent_type || payload.agent_name || 'claude-code';
  await withRunTransaction(dataDir, active.run_id, (_next, emit) => {
    emit(type, String(actor).slice(0, 64), sanitizedToolAudit(payload));
  });
  return true;
}

export async function reserveAllowedAgent(payload, agentType) {
  const { dataDir, active } = await getActiveState(payload);
  if (!active) return { allowed: true };
  return reserveAgentSpawn(dataDir, active.run_id, 'claude-code', agentType);
}

export async function reserveAllowedTool(payload, toolName) {
  const { dataDir, active } = await getActiveState(payload);
  if (!active) return { allowed: true };
  await reserveBudget(dataDir, active.run_id, { actor: 'claude-code', operation: `claude:${toolName}` });
  return { allowed: true };
}
