import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_PROTOCOL_VERSION,
  classifyToolRisk,
  hostCapabilities,
  normalizeHostCommand,
  normalizeHostEvent,
  normalizeToolPolicyDecision,
  normalizeToolPolicyRequest,
} from '../../runtime/hosts/protocol.mjs';

test('host protocol normalizes versioned events, commands, and policy requests', () => {
  const event = normalizeHostEvent({ host: 'opencode', type: 'session.created', session_id: 'ses_1', payload: { ok: true } });
  assert.equal(event.protocol_version, HOST_PROTOCOL_VERSION);
  assert.match(event.event_id, /^hevt_/);
  assert.equal(event.session_id, 'ses_1');

  const command = normalizeHostCommand({ host: 'pi', command: 'start', payload: { objective: 'Implement a feature safely' } });
  assert.match(command.request_id, /^hcmd_/);
  assert.equal(command.command, 'start');

  const request = normalizeToolPolicyRequest({ host: 'pi', tool: 'bash', arguments: { command: 'npm test' }, mutation: true });
  assert.equal(request.mutation, true);
  assert.match(request.request_id, /^tpol_/);

  const decision = normalizeToolPolicyDecision({ decision: 'require_approval', reason: 'needs approval', approval: { tool: 'bash' } });
  assert.equal(decision.decision, 'require_approval');
});

test('host protocol rejects unknown keys, hosts, events, and oversized payloads', () => {
  assert.throws(() => normalizeHostEvent({ host: 'unknown', type: 'session.created', payload: {} }), /one of/);
  assert.throws(() => normalizeHostEvent({ host: 'pi', type: 'unknown', payload: {} }), /one of/);
  assert.throws(() => normalizeHostCommand({ host: 'pi', command: 'start', payload: {}, extra: true }), /unknown keys/);
  assert.throws(() => normalizeHostEvent({ host: 'pi', type: 'session.created', payload: { text: 'x'.repeat(140_000) } }), /exceeds/);
});

test('host capability and tool risk classification are explicit', () => {
  assert.ok(hostCapabilities('opencode').capabilities.includes('sse'));
  assert.ok(hostCapabilities('pi').capabilities.includes('tool_interception'));
  assert.deepEqual(classifyToolRisk('read', { path: 'README.md' }), { mutation: false, shell: false, external: false, destructive: false });
  assert.equal(classifyToolRisk('bash', { command: 'rm -rf /tmp/demo' }).destructive, true);
  assert.equal(classifyToolRisk('write', {}).mutation, true);
  assert.equal(classifyToolRisk('deploy', {}).external, true);
});
