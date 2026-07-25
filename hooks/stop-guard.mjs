#!/usr/bin/env node
import { getActiveState, readHookInput, writeJson } from './hook-lib.mjs';

try {
  const payload = await readHookInput();
  if (payload.stop_hook_active === true) process.exit(0);
  const { active, state } = await getActiveState(payload);
  if (!active || !state) process.exit(0);

  let reason;
  if (state.run_kind === 'graph') {
    const ready = state.graph?.nodes?.filter((node) => state.node_states?.[node.node_id]?.status === 'ready').map((node) => node.node_id) ?? [];
    const running = state.graph?.nodes?.filter((node) => state.node_states?.[node.node_id]?.status === 'running').map((node) => node.node_id) ?? [];
    const approvals = Object.values(state.approvals ?? {}).filter((item) => item.status === 'pending').map((item) => item.approval_id);
    if (state.status === 'budget_exceeded') {
      reason = `ProofGraph graph run ${active.run_id} exceeded ${state.budget_exceeded_reason}. Call pg_graph_get_status, report partial state, then pg_graph_abort if it cannot continue.`;
    } else if (state.status === 'waiting_approval') {
      reason = `ProofGraph graph run ${active.run_id} is waiting for explicit human approval: ${approvals.join(', ') || 'unknown approval'}. Use AskUserQuestion and pg_graph_resolve_approval, or abort.`;
    } else if (state.status === 'failed') {
      reason = `ProofGraph graph run ${active.run_id} entered a failed state: ${state.failure_reason || 'no route matched'}. Inspect pg_graph_get_status and abort explicitly.`;
    } else {
      reason = `ProofGraph graph run ${active.run_id} is still active. Ready: ${ready.join(', ') || 'none'}; running: ${running.join(', ') || 'none'}. Continue the graph until a terminal report is generated, or call pg_graph_abort.`;
    }
  } else {
    const pending = Object.values(state.tasks ?? {}).filter((task) => task.status === 'pending').map((task) => task.task_id);
    if (state.status === 'budget_exceeded') {
      reason = `ProofGraph run ${active.run_id} exceeded ${state.budget_exceeded_reason}. Call pg_get_status, explain the partial result, and call pg_abort_run.`;
    } else {
      reason = `ProofGraph run ${active.run_id} is still active. Pending tasks: ${pending.join(', ') || 'none'}. Complete all tasks and call pg_finalize_run, or explicitly call pg_abort_run if completion is impossible.`;
    }
  }
  writeJson({ decision: 'block', reason });
} catch (error) {
  writeJson({ decision: 'block', reason: `ProofGraph stop guard failed closed: ${error.message}` });
}
