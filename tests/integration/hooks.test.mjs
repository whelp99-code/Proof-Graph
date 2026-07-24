import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupContext, createRun, makeContext, runHook } from '../helpers.mjs';
import { readRun } from '../../server/lib/store.mjs';

function decision(result) {
  return result.json?.hookSpecificOutput?.permissionDecision;
}

test('guard is silent when no ProofGraph run is active', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const result = await runHook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, context);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('active guard allows bundled MCP and WebSearch but denies risky and external tools', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  await createRun(context);
  const allowedMcp = await runHook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_proofgraph-claude_proofgraph__pg_get_status', tool_input: {} }, context);
  assert.equal(decision(allowedMcp), 'allow');
  const web = await runHook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'public documentation' } }, context);
  assert.equal(decision(web), 'allow');
  for (const toolName of ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Read', 'Skill', 'ToolSearch', 'Monitor', 'TodoWrite', 'mcp__github__get_issue', 'UnknownTool']) {
    const result = await runHook('guard.mjs', { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {} }, context);
    assert.equal(decision(result), 'deny', toolName);
  }
});

test('guard only permits ProofGraph plugin agents and enforces agent budget', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context, { max_agents: 1 });
  const denied = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' },
  }, context);
  assert.equal(decision(denied), 'deny');
  const first = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'proofgraph-claude:planner' },
  }, context);
  assert.equal(decision(first), 'allow');
  const second = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'proofgraph-claude:researcher' },
  }, context);
  assert.equal(decision(second), 'deny');
  const state = await readRun(context.dataDir, runId);
  assert.equal(state.counters.agents_spawned, 1);
});

test('stop guard blocks an unfinished run and avoids recursive blocking', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  await createRun(context);
  const blocked = await runHook('stop-guard.mjs', { hook_event_name: 'Stop', stop_hook_active: false }, context);
  assert.equal(blocked.json.decision, 'block');
  const recursive = await runHook('stop-guard.mjs', { hook_event_name: 'Stop', stop_hook_active: true }, context);
  assert.equal(recursive.stdout, '');
});

test('audit hook stores hashes instead of raw tool input', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context);
  const secret = 'TOP-SECRET-VALUE-123';
  await runHook('audit.mjs', {
    hook_event_name: 'PostToolUse',
    session_id: 'session-123',
    tool_name: 'WebSearch',
    tool_input: { query: secret },
    tool_response: { result: 'ok' },
  }, context);
  const eventsText = await import('node:fs/promises').then((fs) => fs.readFile(`${context.dataDir}/runs/${runId}/events.jsonl`, 'utf8'));
  assert.equal(eventsText.includes(secret), false);
  assert.match(eventsText, /tool_input_sha256/);
});

test('WebSearch hook reservations enforce the hard tool-call budget', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context, { max_tool_calls: 10 });
  for (let index = 0; index < 10; index += 1) {
    const allowed = await runHook('guard.mjs', {
      hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: `query-${index}` },
    }, context);
    assert.equal(decision(allowed), 'allow');
  }
  const denied = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'over-budget' },
  }, context);
  assert.equal(decision(denied), 'deny');
  const state = await readRun(context.dataDir, runId);
  assert.equal(state.status, 'budget_exceeded');
  assert.equal(state.budget_exceeded_reason, 'max_tool_calls');
  assert.equal(state.counters.tool_calls, 10);
});
