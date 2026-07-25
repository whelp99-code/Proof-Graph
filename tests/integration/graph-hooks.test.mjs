import test from 'node:test';
import assert from 'node:assert/strict';
import { claimGraphNode, startGraphRun } from '../../server/lib/graph-runtime.mjs';
import { cleanupContext, makeContext, runHook } from '../helpers.mjs';

const SIMPLE = {
  objective: 'Produce a short local artifact and verify it.',
  signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
};

function decision(result) {
  return result.json?.hookSpecificOutput?.permissionDecision;
}

test('graph guard permits only the agent type of a ready node', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  await startGraphRun(SIMPLE, context);
  const allowed = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'proofgraph-claude:graph-direct' },
  }, context);
  assert.equal(decision(allowed), 'allow', allowed.stdout);
  const denied = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'proofgraph-claude:graph-researcher' },
  }, context);
  assert.equal(decision(denied), 'deny', denied.stdout);
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /ready graph node/i);
});

test('graph guard authorizes read tools only for the matching running node capability', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await claimGraphNode({ run_id: start.run_id, actor: 'direct', node_id: 'direct' }, context);
  const read = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    agent_type: 'proofgraph-claude:graph-direct',
    tool_input: { file_path: '/tmp/example' },
  }, context);
  assert.equal(decision(read), 'allow', read.stdout);
  const web = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'WebSearch',
    agent_type: 'proofgraph-claude:graph-direct',
    tool_input: { query: 'forbidden for direct node' },
  }, context);
  assert.equal(decision(web), 'deny', web.stdout);
  const spoof = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    agent_type: 'proofgraph-claude:graph-researcher',
    tool_input: { file_path: '/tmp/example' },
  }, context);
  assert.equal(decision(spoof), 'deny', spoof.stdout);
});

test('graph guard always denies write and shell tools', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun(SIMPLE, context);
  await claimGraphNode({ run_id: start.run_id, actor: 'direct', node_id: 'direct' }, context);
  for (const toolName of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch']) {
    const result = await runHook('guard.mjs', {
      hook_event_name: 'PreToolUse', tool_name: toolName,
      agent_type: 'proofgraph-claude:graph-direct', tool_input: {},
    }, context);
    assert.equal(decision(result), 'deny', `${toolName}: ${result.stdout}`);
  }
});

test('research node can use WebSearch only after it is claimed', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const start = await startGraphRun({
    objective: 'Research several independent sources for a complex technical decision.',
    mode: 'research',
    signals: { complexity: 70, uncertainty: 80, risk: 'low', requires_research: true, requires_implementation: false, estimated_subtasks: 4 },
    constraints: { max_parallel_nodes: 2 },
  }, context);
  const nodeId = start.ready_nodes[0].node_id;
  const before = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'WebSearch', agent_type: 'proofgraph-claude:graph-researcher', tool_input: { query: 'before claim' },
  }, context);
  assert.equal(decision(before), 'deny');
  await claimGraphNode({ run_id: start.run_id, actor: 'researcher', node_id: nodeId }, context);
  const after = await runHook('guard.mjs', {
    hook_event_name: 'PreToolUse', tool_name: 'WebSearch', agent_type: 'proofgraph-claude:graph-researcher', tool_input: { query: 'after claim' },
  }, context);
  assert.equal(decision(after), 'allow', after.stdout);
});

test('graph stop guard explains pending human approval', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  await startGraphRun({
    objective: 'Prepare a high-risk production operation that requires approval.',
    signals: { complexity: 50, uncertainty: 30, risk: 'high', external_side_effects: true },
  }, context);
  const result = await runHook('stop-guard.mjs', { hook_event_name: 'Stop', stop_hook_active: false }, context);
  assert.equal(result.json?.decision, 'block');
  assert.match(result.json?.reason, /waiting for explicit human approval/i);
});
