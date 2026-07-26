import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTaskSpec } from '../../runtime/task-intelligence/task-spec.mjs';
import { buildOrganization, validateOrganization, DelegationAuthority, DelegationLedger } from '../../runtime/organization/index.mjs';
import { sha256 } from '../../runtime/core/canonical.mjs';
import { PolicyError, ValidationError } from '../../runtime/core/errors.mjs';
import { jsonClone } from '../helpers.mjs';

function featureOrg() {
  return buildOrganization(compileTaskSpec({ objective: 'Implement and verify a secure API', signals: { risk: 'medium', requires_research: true } }));
}

test('organization builder creates executive, engineering, quality, and human governance', () => {
  const org = featureOrg();
  assert.ok(org.departments.some((item) => item.type === 'engineering'));
  assert.ok(org.departments.some((item) => item.type === 'quality'));
  assert.ok(org.roles.some((item) => item.role_type === 'executive'));
  assert.ok(org.roles.some((item) => item.role_type === 'human' && item.model_eligible === false));
});

test('developer and verifier are independently grouped', () => {
  const org = featureOrg();
  const developer = org.roles.find((item) => item.name === 'Developer');
  const verifier = org.roles.find((item) => item.name === 'Independent Verifier');
  assert.notEqual(developer.role_id, verifier.role_id);
  assert.notEqual(developer.independence_group, verifier.independence_group);
  assert.notEqual(verifier.manager_role_id, developer.role_id);
});

test('organization digest is valid and mutation is detected', () => {
  const org = jsonClone(featureOrg());
  assert.equal(validateOrganization(org), true);
  org.roles[0].purpose = 'forged';
  assert.throws(() => validateOrganization(org), /digest mismatch/);
});

test('organization validation rejects reporting cycles', () => {
  const org = jsonClone(featureOrg());
  const [first, second] = org.roles.filter((item) => item.role_type !== 'human').slice(0, 2);
  first.manager_role_id = second.role_id; second.manager_role_id = first.role_id;
  delete org.digest; org.digest = sha256(org);
  assert.throws(() => validateOrganization(org), /cycle/);
});

test('organization validation rejects missing manager', () => {
  const org = jsonClone(featureOrg());
  org.roles.find((item) => item.manager_role_id).manager_role_id = 'missing-role';
  delete org.digest; org.digest = sha256(org);
  assert.throws(() => validateOrganization(org), /missing manager/);
});

test('organization validation rejects capability ceiling bypass', () => {
  const org = jsonClone(featureOrg());
  const developer = org.roles.find((item) => item.name === 'Developer');
  developer.capabilities.push('delivery.execute');
  delete org.digest; org.digest = sha256(org);
  assert.throws(() => validateOrganization(org), /capability ceiling/);
});

test('organization validation rejects human capability on model role', () => {
  const org = jsonClone(featureOrg());
  const developer = org.roles.find((item) => item.name === 'Developer');
  const department = org.departments.find((item) => item.department_id === developer.department_id);
  developer.capabilities.push('approval.decide'); department.capability_ceiling.push('approval.decide');
  delete org.digest; org.digest = sha256(org);
  assert.throws(() => validateOrganization(org), /human\/operator capability/);
});

test('delegation token can be issued and verified with attenuation', () => {
  const org = featureOrg();
  let now = Date.parse('2026-01-01T00:00:00Z');
  const authority = new DelegationAuthority({ secret: 'x'.repeat(64), organization: org, now: () => now });
  const executive = org.roles.find((item) => item.role_type === 'executive');
  const lead = org.roles.find((item) => item.name === 'Engineering Lead');
  const developer = org.roles.find((item) => item.name === 'Developer');
  const parent = authority.issue({ issuer_role_id: executive.role_id, subject_role_id: lead.role_id, run_id: 'run_1', capabilities: ['workspace.read', 'workspace.propose'], budget: { calls: 5, tokens: 10000, cost_micros: 1000, wall_time_ms: 5000 }, expires_at: '2026-01-01T01:00:00Z' });
  assert.equal(authority.verify(parent).subject_role_id, lead.role_id);
  const child = authority.attenuate(parent, { subject_role_id: developer.role_id, capabilities: ['workspace.read'], budget: { calls: 2, tokens: 4000, cost_micros: 500, wall_time_ms: 2000 }, expires_at: '2026-01-01T00:30:00Z' });
  assert.deepEqual(authority.verify(child).capabilities, ['workspace.read']);
});

test('delegation rejects capability escalation', () => {
  const org = featureOrg();
  const authority = new DelegationAuthority({ secret: 'x'.repeat(64), organization: org, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const executive = org.roles.find((item) => item.role_type === 'executive');
  const developer = org.roles.find((item) => item.name === 'Developer');
  assert.throws(() => authority.issue({ issuer_role_id: executive.role_id, subject_role_id: developer.role_id, run_id: 'run_2', capabilities: ['delivery.execute'], budget: { calls: 1, tokens: 1, cost_micros: 0, wall_time_ms: 1 }, expires_at: '2026-01-01T01:00:00Z' }), PolicyError);
});

test('delegation rejects budget escalation and human subject', () => {
  const org = featureOrg();
  const authority = new DelegationAuthority({ secret: 'x'.repeat(64), organization: org, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const executive = org.roles.find((item) => item.role_type === 'executive');
  const developer = org.roles.find((item) => item.name === 'Developer');
  const human = org.roles.find((item) => item.role_type === 'human');
  assert.throws(() => authority.issue({ issuer_role_id: executive.role_id, subject_role_id: developer.role_id, run_id: 'run_3', capabilities: ['workspace.read'], budget: { calls: 99999, tokens: 1, cost_micros: 0, wall_time_ms: 1 }, expires_at: '2026-01-01T01:00:00Z' }), PolicyError);
  assert.throws(() => authority.issue({ issuer_role_id: executive.role_id, subject_role_id: human.role_id, run_id: 'run_3', capabilities: [], budget: { calls: 0, tokens: 0, cost_micros: 0, wall_time_ms: 0 }, expires_at: '2026-01-01T01:00:00Z' }), PolicyError);
});

test('delegation detects forged and expired tokens', () => {
  const org = featureOrg();
  let now = Date.parse('2026-01-01T00:00:00Z');
  const authority = new DelegationAuthority({ secret: 'x'.repeat(64), organization: org, now: () => now });
  const executive = org.roles.find((item) => item.role_type === 'executive');
  const developer = org.roles.find((item) => item.name === 'Developer');
  const token = authority.issue({ issuer_role_id: executive.role_id, subject_role_id: developer.role_id, run_id: 'run_4', capabilities: ['workspace.read'], budget: { calls: 1, tokens: 100, cost_micros: 0, wall_time_ms: 100 }, expires_at: '2026-01-01T00:10:00Z' });
  const forged = jsonClone(token); forged.payload.capabilities.push('workspace.propose');
  assert.throws(() => authority.verify(forged), /signature/);
  now = Date.parse('2026-01-01T00:11:00Z');
  assert.throws(() => authority.verify(token), /expired/);
});

test('delegation ledger detects tampering', () => {
  const org = featureOrg();
  const authority = new DelegationAuthority({ secret: 'x'.repeat(64), organization: org, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const executive = org.roles.find((item) => item.role_type === 'executive');
  const developer = org.roles.find((item) => item.name === 'Developer');
  const token = authority.issue({ issuer_role_id: executive.role_id, subject_role_id: developer.role_id, run_id: 'run_5', capabilities: ['workspace.read'], budget: { calls: 1, tokens: 100, cost_micros: 0, wall_time_ms: 100 }, expires_at: '2026-01-01T00:10:00Z' });
  const ledger = new DelegationLedger(); ledger.append('issued', token, executive.role_id);
  assert.equal(ledger.verify().ok, true);
  ledger.entries[0].actor = 'attacker';
  assert.throws(() => ledger.verify(), /integrity/);
});
