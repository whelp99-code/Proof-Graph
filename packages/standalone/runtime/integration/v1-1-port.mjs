import { HostBridgeGraphPort } from '../company/graph-port.mjs';

export const V1_1_HOST_PROTOCOL = 'proofgraph.host.v1';

export function createV11HostBridgePort(options) {
  return new HostBridgeGraphPort(options);
}

export function v11CompatibilityManifest() {
  return Object.freeze({
    schema_version: 1,
    baseline: '1.1.0',
    protocol: V1_1_HOST_PROTOCOL,
    required_commands: ['run', 'status', 'report', 'integrity'],
    optional_commands: ['compile', 'start', 'resume'],
    operator_only_commands: ['approve', 'deny', 'abort'],
    invariants: [
      'ProofGraph v1.1 remains authoritative for GraphSpec, routing, verification, approval, workspace policy, and terminal state.',
      'Model-callable Host tools cannot acquire approve, deny, abort, policy-apply, or runtime-modification authority.',
      'Remote bridges require HTTPS; loopback HTTP requires a bearer token.',
    ],
  });
}
