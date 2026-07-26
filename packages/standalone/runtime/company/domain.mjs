export const MISSION_SCHEMA_VERSION = 1;
export const MISSION_STATUSES = Object.freeze(['planned', 'active', 'waiting_approval', 'completed', 'simulated', 'partial', 'failed', 'aborted']);
export const WORK_ITEM_STATUSES = Object.freeze(['pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'blocked']);

export function failurePacket({ type, severity = 'medium', message, evidence = [], retryable = true, recommended_route = null, source = null }) {
  return Object.freeze({
    schema_version: 1,
    type,
    severity,
    message,
    evidence,
    retryable,
    recommended_route,
    source,
  });
}
