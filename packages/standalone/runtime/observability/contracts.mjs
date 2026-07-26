import { cloneJson, sha256 } from '../core/canonical.mjs';

export const OBSERVABILITY_SCHEMA_VERSION = 2;

export const DISPLAY_RUN_STATES = Object.freeze([
  'planned', 'queued', 'active', 'paused', 'waiting_approval',
  'completed_clean', 'completed_with_recovery', 'simulation_complete', 'partial',
  'failed', 'denied', 'aborted',
]);

export const DISPLAY_NODE_STATES = Object.freeze([
  'blocked', 'pending', 'ready', 'running', 'paused',
  'waiting_approval', 'completed', 'failed', 'skipped', 'cancelled',
]);

export const EVENT_TYPES = Object.freeze({
  ROUTE_CHANGED: 'route.changed',
  LOOP_ENTERED: 'loop.entered',
  LOOP_ITERATION: 'loop.iteration',
  LOOP_EXITED: 'loop.exited',
  LOOP_EXHAUSTED: 'loop.exhausted',
  NODE_PROGRESS: 'node.progress',
  NODE_RETRY_SCHEDULED: 'node.retry_scheduled',
  RUN_PAUSED: 'run.paused',
  RUN_RESUMED: 'run.resumed',
  HOST_CONNECTED: 'host.connected',
  HOST_DISCONNECTED: 'host.disconnected',
  FAILURE_RESOLVED: 'failure.resolved',
});

export function failureIdentity(failure) {
  return failure.failure_id ?? sha256({
    work_item_id: failure.work_item_id ?? null,
    attempt: failure.attempt ?? null,
    type: failure.type ?? 'unknown_failure',
    message: failure.message ?? '',
  }).slice(0, 24);
}

export function classifyFailures(state) {
  const byId = new Map((state?.mission?.work_items ?? []).map((item) => [item.work_item_id, item]));
  const historical = (state.failures ?? []).map((failure) => ({ ...cloneJson(failure), failure_id: failureIdentity(failure) }));
  const resolved = [];
  const unresolved = [];
  for (const failure of historical) {
    const item = byId.get(failure.work_item_id);
    const explicitlyResolved = failure.status === 'resolved' || Boolean(failure.resolved_at);
    const recoveredLater = item?.status === 'completed' && Number(item.attempts ?? 0) > Number(failure.attempt ?? 0);
    if (explicitlyResolved || recoveredLater) {
      resolved.push({ ...failure, status: 'resolved' });
    } else {
      unresolved.push({ ...failure, status: failure.status ?? 'unresolved' });
    }
  }
  return { historical, resolved, unresolved };
}

export function displayRunStatus(state) {
  const { historical, unresolved } = classifyFailures(state);
  if (state.operator?.paused === true || state.status === 'paused') return 'paused';
  if (state.status === 'simulated') return 'simulation_complete';
  if (state.status === 'completed') return historical.length ? 'completed_with_recovery' : 'completed_clean';
  if (state.status === 'failed' && (state.approvals ?? []).some((item) => item.status === 'denied')) return 'denied';
  if (state.status === 'failed' && unresolved.some((item) => item.type === 'approval_denied')) return 'denied';
  return DISPLAY_RUN_STATES.includes(state.status) ? state.status : 'failed';
}

export function nodeDisplayStatus(item, state) {
  if (state.operator?.paused && item.status === 'running') return 'paused';
  if (DISPLAY_NODE_STATES.includes(item.status)) return item.status;
  return item.status === 'waiting_approval' ? 'waiting_approval' : 'pending';
}

export function normalizedEvent({ runId, source = 'mission', envelope }) {
  return {
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    event_id: `${source}:${runId}:${envelope.seq}`,
    run_id: runId,
    source,
    seq: envelope.seq,
    at: envelope.at,
    type: envelope.type,
    actor: envelope.actor,
    data: cloneJson(envelope.data ?? {}),
    previous_hash: envelope.previous_hash,
    hash: envelope.hash,
  };
}
