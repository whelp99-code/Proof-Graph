import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernancePolicyEngine } from '../../runtime/os/governance.mjs';
import { CouncilRuntime } from '../../runtime/os/council.mjs';
import { generateSigningKeyPair, signRegistryPackage, verifyRegistryPackage, PackageRegistry } from '../../runtime/os/registry.mjs';
import { ImprovementEngine } from '../../runtime/os/improvement.mjs';
import { PolicyError, IntegrityError } from '../../runtime/core/errors.mjs';
import { jsonClone } from '../helpers.mjs';

test('governance allows low-risk bounded retry', () => {
  const policy = new GovernancePolicyEngine();
  assert.equal(policy.evaluate({ type: 'autonomous_retry', actor_type: 'system', risk: 'low' }).decision, 'allow');
});

test('governance requires approval for high-risk and external actions', () => {
  const policy = new GovernancePolicyEngine();
  assert.equal(policy.evaluate({ type: 'delivery', actor_type: 'system', risk: 'high', external_effect: true }).decision, 'require_approval');
});

test('governance denies model approval authority and capability escalation', () => {
  const policy = new GovernancePolicyEngine();
  assert.equal(policy.evaluate({ type: 'approve', actor_type: 'model', risk: 'low' }).decision, 'deny');
  assert.equal(policy.evaluate({ type: 'delegate', actor_type: 'system', risk: 'low', capability_escalation: true }).decision, 'deny');
});

test('governance cannot enable self-applying improvements', () => {
  assert.throws(() => new GovernancePolicyEngine({ self_apply_improvements: true }), PolicyError);
});

test('council produces evidence-aware decision from independent groups', () => {
  const council = new CouncilRuntime().convene({ subject: { issue: 'retry' }, proposals: [
    { role_id: 'exec', independence_group: 'executive', recommendation: 'retry', evidence: ['failure log'], confidence: 0.7 },
    { role_id: 'verifier', independence_group: 'quality', recommendation: 'retry', evidence: ['test result'], confidence: 0.9 },
    { role_id: 'risk', independence_group: 'risk', recommendation: 'escalate', evidence: ['risk note'], confidence: 0.6 },
  ] });
  assert.equal(council.status, 'decision_proposed');
  assert.equal(council.decision, 'retry');
  assert.equal(council.decision_is_advisory, true);
});

test('council preserves unresolved conflict', () => {
  const council = new CouncilRuntime().convene({ subject: { issue: 'conflict' }, proposals: [
    { role_id: 'exec', independence_group: 'executive', recommendation: 'retry', evidence: ['a'], confidence: 0.8 },
    { role_id: 'verifier', independence_group: 'quality', recommendation: 'stop', evidence: ['b'], confidence: 0.8 },
  ] });
  assert.equal(council.status, 'unresolved');
  assert.equal(council.decision, null);
});

test('signed registry package verifies and publishes', () => {
  const keys = generateSigningKeyPair();
  const signed = signRegistryPackage({ manifest: { name: 'org-policy', version: '1.0.0' }, payload: { rules: ['verify'] } }, keys.privateKey);
  assert.equal(verifyRegistryPackage(signed, keys.publicKey).ok, true);
  const registry = new PackageRegistry();
  assert.equal(registry.publish(signed, keys.publicKey).ok, true);
  assert.equal(registry.list().length, 1);
});

test('registry rejects payload and signature forgery', () => {
  const keys = generateSigningKeyPair();
  const other = generateSigningKeyPair();
  const signed = signRegistryPackage({ manifest: { name: 'org-policy', version: '1.0.0' }, payload: { rules: ['verify'] } }, keys.privateKey);
  const forged = jsonClone(signed); forged.envelope.payload.rules.push('bypass');
  assert.throws(() => verifyRegistryPackage(forged, keys.publicKey), IntegrityError);
  assert.throws(() => verifyRegistryPackage(signed, other.publicKey), IntegrityError);
});

test('improvement engine emits proposal-only artifact', () => {
  const engine = new ImprovementEngine();
  const proposal = engine.propose({ source_run_id: 'run_1', metrics: { quality_gate_passed: false }, failures: [{ type: 'implementation_error' }], evidence: ['test failed'] });
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.auto_apply_allowed, false);
  assert.throws(() => engine.apply(proposal), /cannot self-apply/);
});

test('governance rejects policy relaxation and unknown policy fields', () => {
  assert.throws(() => new GovernancePolicyEngine({ external_effects_require_approval: false }), /cannot be disabled/);
  assert.throws(() => new GovernancePolicyEngine({ runtime_changes_require_approval: false }), /cannot be disabled/);
  assert.throws(() => new GovernancePolicyEngine({ unknown_policy: true }), /unknown keys/i);
  assert.throws(() => new GovernancePolicyEngine({ max_parallel_missions: 0 }), /1\.\.16/);
});
