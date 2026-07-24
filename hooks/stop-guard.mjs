#!/usr/bin/env node
import { getActiveState, readHookInput, writeJson } from './hook-lib.mjs';

try {
  const payload = await readHookInput();
  if (payload.stop_hook_active === true) process.exit(0);
  const { active, state } = await getActiveState(payload);
  if (!active || !state) process.exit(0);
  const pending = Object.values(state.tasks ?? {}).filter((task) => task.status === 'pending').map((task) => task.task_id);
  let reason;
  if (state.status === 'budget_exceeded') {
    reason = `ProofGraph run ${active.run_id} exceeded ${state.budget_exceeded_reason}. Call pg_get_status, explain the partial result, and call pg_abort_run.`;
  } else {
    reason = `ProofGraph run ${active.run_id} is still active. Pending tasks: ${pending.join(', ') || 'none'}. Complete all tasks and call pg_finalize_run, or explicitly call pg_abort_run if completion is impossible.`;
  }
  writeJson({ decision: 'block', reason });
} catch (error) {
  writeJson({ decision: 'block', reason: `ProofGraph stop guard failed closed: ${error.message}` });
}
