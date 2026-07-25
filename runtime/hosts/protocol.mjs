import crypto from 'node:crypto';
import { ValidationError } from '../../server/lib/errors.mjs';
import {
  assertFiniteJson,
  assertPlainObject,
  booleanValue,
  enumValue,
  identifier,
  integerValue,
  rejectUnknownKeys,
  stringValue,
} from '../../server/lib/validate.mjs';

export const HOST_PROTOCOL_VERSION = 'proofgraph.host.v1';

export const HOSTS = Object.freeze(['opencode', 'pi', 'orca', 'custom']);

export const HOST_EVENT_TYPES = Object.freeze([
  'host.connected', 'host.disconnected',
  'session.created', 'session.status', 'session.idle', 'session.error',
  'message.updated', 'artifact.created', 'artifact.updated',
  'tool.requested', 'tool.completed', 'tool.failed',
  'permission.requested', 'permission.resolved',
  'run.attached', 'run.detached',
  'ui.command', 'ui.notification',
]);

export const HOST_COMMAND_TYPES = Object.freeze([
  'compile', 'start', 'run', 'resume', 'status', 'report', 'integrity',
  'approve', 'deny', 'abort',
]);

export const TOOL_POLICY_DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);

const DEFAULT_MAX_PAYLOAD_BYTES = 128_000;

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function boundedPayload(value, label, maxBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  assertFiniteJson(value);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw new ValidationError(`${label} exceeds ${maxBytes} bytes`, { bytes, max_bytes: maxBytes });
  return structuredClone(value);
}

function optionalId(value, label) {
  return value == null ? null : identifier(value, label);
}

function optionalText(value, label, options = {}) {
  return value == null ? null : stringValue(value, label, options);
}

function optionalBool(value, fallback, label) {
  return value == null ? fallback : booleanValue(value, label);
}

function normalizeRevision(value, label) {
  return value == null ? null : integerValue(Number(value), label, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function protocolValue(value, label) {
  return value == null
    ? HOST_PROTOCOL_VERSION
    : enumValue(value, label, [HOST_PROTOCOL_VERSION]);
}

export function normalizeHostEvent(input, label = 'host event') {
  const value = assertPlainObject(input, label);
  rejectUnknownKeys(value, [
    'protocol', 'protocol_version', 'event_id', 'host', 'type', 'run_id', 'session_id',
    'node_id', 'request_id', 'revision', 'timestamp', 'payload',
  ], label);
  const protocolVersion = protocolValue(value.protocol_version ?? value.protocol, `${label}.protocol_version`);
  return {
    protocol_version: protocolVersion,
    event_id: value.event_id == null ? randomId('hevt') : identifier(value.event_id, `${label}.event_id`),
    host: enumValue(value.host, `${label}.host`, HOSTS),
    type: enumValue(value.type, `${label}.type`, HOST_EVENT_TYPES),
    run_id: optionalText(value.run_id, `${label}.run_id`, { min: 3, max: 100 }),
    session_id: optionalText(value.session_id, `${label}.session_id`, { min: 1, max: 240 }),
    node_id: optionalId(value.node_id, `${label}.node_id`),
    request_id: optionalId(value.request_id, `${label}.request_id`),
    revision: normalizeRevision(value.revision, `${label}.revision`),
    timestamp: value.timestamp == null
      ? new Date().toISOString()
      : stringValue(value.timestamp, `${label}.timestamp`, { min: 10, max: 80 }),
    payload: boundedPayload(value.payload ?? {}, `${label}.payload`),
  };
}

export function normalizeHostCommand(input, label = 'host command') {
  const value = assertPlainObject(input, label);
  rejectUnknownKeys(value, [
    'protocol', 'protocol_version', 'command_id', 'request_id', 'host', 'type', 'command',
    'run_id', 'expected_revision', 'payload',
  ], label);
  const command = value.command ?? value.type;
  const requestId = value.request_id ?? value.command_id;
  return {
    protocol_version: protocolValue(value.protocol_version ?? value.protocol, `${label}.protocol_version`),
    request_id: requestId == null ? randomId('hcmd') : identifier(requestId, `${label}.request_id`),
    host: enumValue(value.host, `${label}.host`, HOSTS),
    command: enumValue(command, `${label}.command`, HOST_COMMAND_TYPES),
    run_id: optionalText(value.run_id, `${label}.run_id`, { min: 3, max: 100 }),
    expected_revision: normalizeRevision(value.expected_revision, `${label}.expected_revision`),
    payload: boundedPayload(value.payload ?? {}, `${label}.payload`),
  };
}

export function normalizeToolPolicyRequest(input, label = 'tool policy request') {
  const value = assertPlainObject(input, label);
  rejectUnknownKeys(value, [
    'protocol', 'protocol_version', 'request_id', 'host', 'run_id', 'session_id', 'node_id',
    'tool', 'arguments', 'cwd', 'mutation', 'external_side_effect', 'workspace_isolated', 'timestamp',
  ], label);
  return {
    protocol_version: protocolValue(value.protocol_version ?? value.protocol, `${label}.protocol_version`),
    request_id: value.request_id == null ? randomId('tpol') : identifier(value.request_id, `${label}.request_id`),
    host: enumValue(value.host, `${label}.host`, HOSTS),
    run_id: optionalText(value.run_id, `${label}.run_id`, { min: 3, max: 100 }),
    session_id: optionalText(value.session_id, `${label}.session_id`, { min: 1, max: 240 }),
    node_id: optionalId(value.node_id, `${label}.node_id`),
    tool: stringValue(value.tool, `${label}.tool`, { min: 1, max: 200 }),
    arguments: boundedPayload(value.arguments ?? {}, `${label}.arguments`, 64_000),
    cwd: optionalText(value.cwd, `${label}.cwd`, { min: 1, max: 4096 }),
    mutation: optionalBool(value.mutation, false, `${label}.mutation`),
    external_side_effect: optionalBool(value.external_side_effect, false, `${label}.external_side_effect`),
    workspace_isolated: optionalBool(value.workspace_isolated, false, `${label}.workspace_isolated`),
    timestamp: value.timestamp == null
      ? new Date().toISOString()
      : stringValue(value.timestamp, `${label}.timestamp`, { min: 10, max: 80 }),
  };
}

export function normalizeToolPolicyDecision(input, label = 'tool policy decision') {
  const value = assertPlainObject(input, label);
  rejectUnknownKeys(value, ['decision', 'reason', 'approval', 'policy_revision'], label);
  return {
    decision: enumValue(value.decision, `${label}.decision`, TOOL_POLICY_DECISIONS),
    reason: stringValue(value.reason, `${label}.reason`, { min: 1, max: 4000 }),
    approval: value.approval == null ? null : boundedPayload(value.approval, `${label}.approval`, 32_000),
    policy_revision: value.policy_revision == null
      ? 1
      : integerValue(Number(value.policy_revision), `${label}.policy_revision`, { min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}

const HOST_CAPABILITIES = Object.freeze({
  opencode: Object.freeze([
    'commands', 'plugin_hooks', 'server_api', 'sse', 'permission_bridge',
    'tool_interception', 'session_persistence', 'diff_artifacts', 'tui_host',
  ]),
  pi: Object.freeze([
    'commands', 'extensions', 'rpc', 'tool_interception', 'custom_ui',
    'session_persistence', 'status_widgets', 'tui_host',
  ]),
  orca: Object.freeze([
    'custom_cli', 'worktrees', 'terminal_host', 'diff_view', 'desktop_host',
  ]),
  custom: Object.freeze(['commands', 'events', 'tool_policy']),
});

export function hostCapabilities(host) {
  const selected = enumValue(host, 'host', HOSTS);
  return {
    host: selected,
    protocol_version: HOST_PROTOCOL_VERSION,
    capabilities: [...HOST_CAPABILITIES[selected]],
  };
}

function commandText(args) {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  const values = [];
  for (const key of ['command', 'cmd', 'script', 'input']) {
    if (typeof args[key] === 'string') values.push(args[key]);
  }
  for (const key of ['argv', 'args']) {
    if (Array.isArray(args[key])) values.push(args[key].map(String).join(' '));
  }
  return values.join(' ').toLowerCase();
}

export function classifyToolRisk(tool, args = {}) {
  const name = String(tool ?? '').trim().toLowerCase();
  const text = `${name} ${commandText(args)}`.toLowerCase();
  const shell = /(^|[.:/_-])(bash|shell|terminal|command|exec|powershell)([.:/_-]|$)/.test(name)
    || ['bash', 'shell', 'terminal', 'command', 'exec', 'powershell'].includes(name);
  const mutation = shell
    || /(write|edit|patch|delete|remove|unlink|rename|move|mkdir|create[_-]?file|notebookedit)/.test(name);
  const external = /(deploy|publish|release|push|merge|email|message|notify|upload|post|send|external|webhook|cloud)/.test(name);
  const destructive = /(delete|remove|unlink|destroy|drop|truncate|wipe|reset)/.test(name)
    || /(^|\s)(rm\s+-rf|rm\s+-fr|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+(table|database)|shutdown|reboot)(\s|$)/.test(text);
  return { mutation, shell, external, destructive };
}

export function hostEventId(host = 'custom', type = 'event', seed = '') {
  const digest = crypto.createHash('sha256')
    .update(`${host}\0${type}\0${seed}\0${Date.now()}\0${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 24);
  return `hevt_${digest}`;
}
