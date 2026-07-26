import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileTaskSpec, validateGraphAdequacy, discoverWorkspace } from '../../runtime/task-intelligence/index.mjs';
import { buildOrganization, validateOrganization, DelegationAuthority } from '../../runtime/organization/index.mjs';
import { CompanyRuntime, ReferenceGraphKernelPort, HostBridgeGraphPort, ArtifactRuntime, DeliveryRuntime } from '../../runtime/company/index.mjs';
import { GovernancePolicyEngine, ImprovementEngine, generateSigningKeyPair, signRegistryPackage, verifyRegistryPackage, DurableQueue, AutonomousOrganizationOS, CouncilRuntime } from '../../runtime/os/index.mjs';
import { HashChainStore } from '../../runtime/core/atomic-store.mjs';
import { safeRelativePath } from '../../runtime/core/validate.mjs';
import { sha256 } from '../../runtime/core/canonical.mjs';
import { IntegrityError, PolicyError, ValidationError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup, jsonClone } from '../helpers.mjs';

test('ADVERSARIAL: arbitrary graph and tool signals are rejected', () => {
  assert.throws(() => compileTaskSpec({ objective: 'Implement a feature', signals: { arbitrary_graph: { nodes: [] } } }), /unknown keys/);
  assert.throws(() => compileTaskSpec({ objective: 'Implement a feature', tool_policy: ['shell'] }), /unknown keys/);
});

test('ADVERSARIAL: injected success edge cannot bypass verifier', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Implement a feature' }));
  task.blueprint.edges.push({ from: 'triage', to: 'terminal-success', condition: 'success' });
  assert.throws(() => validateGraphAdequacy(task, task.blueprint), /bypasses_verifier/);
});

test('ADVERSARIAL: unbounded retry edge is rejected', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Implement a feature' }));
  const retry = task.blueprint.edges.find((edge) => edge.condition === 'implementation_error');
  retry.bounded = false;
  assert.throws(() => validateGraphAdequacy(task, task.blueprint), /unbounded_retry/);
});

test('ADVERSARIAL: unknown edge condition is rejected', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Implement a feature' }));
  task.blueprint.edges[0].condition = 'eval(user_code)';
  assert.throws(() => validateGraphAdequacy(task, task.blueprint), /unknown_condition/);
});

test('ADVERSARIAL: reporting-line and capability tampering cannot be re-signed as valid policy', () => {
  const task = compileTaskSpec({ objective: 'Implement and verify a feature' });
  const org = jsonClone(buildOrganization(task));
  const developer = org.roles.find((role) => role.name === 'Developer');
  developer.capabilities.push('approval.decide');
  org.departments.find((dep) => dep.department_id === developer.department_id).capability_ceiling.push('approval.decide');
  delete org.digest; org.digest = sha256(org);
  assert.throws(() => validateOrganization(org), /human\/operator capability/);
});

test('ADVERSARIAL: delegation child cannot gain capability absent from parent', () => {
  const org = buildOrganization(compileTaskSpec({ objective: 'Implement a feature' }));
  const authority = new DelegationAuthority({ secret: 's'.repeat(64), organization: org, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const executive = org.roles.find((role) => role.role_type === 'executive');
  const lead = org.roles.find((role) => role.name === 'Engineering Lead');
  const developer = org.roles.find((role) => role.name === 'Developer');
  const parent = authority.issue({ issuer_role_id: executive.role_id, subject_role_id: lead.role_id, run_id: 'r', capabilities: ['workspace.read'], budget: { calls: 3, tokens: 3000, cost_micros: 0, wall_time_ms: 3000 }, expires_at: '2026-01-01T01:00:00Z' });
  assert.throws(() => authority.attenuate(parent, { subject_role_id: developer.role_id, capabilities: ['workspace.read', 'workspace.propose'], budget: { calls: 1, tokens: 1000, cost_micros: 0, wall_time_ms: 1000 }, expires_at: '2026-01-01T00:30:00Z' }), /exceed/);
});

test('ADVERSARIAL: forged delegation signature is rejected', () => {
  const org = buildOrganization(compileTaskSpec({ objective: 'Implement a feature' }));
  const authority = new DelegationAuthority({ secret: 's'.repeat(64), organization: org, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const executive = org.roles.find((role) => role.role_type === 'executive');
  const developer = org.roles.find((role) => role.name === 'Developer');
  const token = authority.issue({ issuer_role_id: executive.role_id, subject_role_id: developer.role_id, run_id: 'r', capabilities: ['workspace.read'], budget: { calls: 1, tokens: 1000, cost_micros: 0, wall_time_ms: 1000 }, expires_at: '2026-01-01T01:00:00Z' });
  token.signature = '0'.repeat(64);
  assert.throws(() => authority.verify(token), /signature/);
});

test('ADVERSARIAL: model cannot approve or abort mission', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Deploy production', signals: { risk: 'high', external_effects: true } });
  state = await runtime.run(state.mission.mission_id);
  const approval = state.approvals[0];
  await assert.rejects(() => runtime.decide(state.mission.mission_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'model', decision_source: 'operator' }), /external human/);
  await assert.rejects(() => runtime.abort(state.mission.mission_id, 'bypass', 'model'), /external human/);
});

test('ADVERSARIAL: interrupted recovery is operator-only', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Implement a feature' });
  await runtime.start(state.mission.mission_id);
  await runtime.claim(state.mission.mission_id);
  await assert.rejects(() => runtime.recoverInterrupted(state.mission.mission_id, { actor: 'model' }), /external operator/);
  state = await runtime.recoverInterrupted(state.mission.mission_id, { actor: 'external-operator' });
  assert.equal(state.last_recovery.recovered, 1);
});

test('ADVERSARIAL: remote insecure Host Bridge is rejected', () => {
  assert.throws(() => new HostBridgeGraphPort({ url: 'http://example.com:8743', token: 'x'.repeat(24) }), /loopback/);
});

test('ADVERSARIAL: Graph Port cannot invoke operator-only Host commands', async () => {
  const port = new HostBridgeGraphPort({ url: 'http://127.0.0.1:8743', token: 'x'.repeat(24), fetchImpl: async () => { throw new Error('should not call'); } });
  await assert.rejects(() => port.command('approve', {}), /operator-only/);
  await assert.rejects(() => port.command('abort', {}), /operator-only/);
});

test('ADVERSARIAL: unverified artifacts cannot enter delivery', () => {
  const delivery = new DeliveryRuntime();
  assert.throws(() => delivery.propose({ mission_id: 'm', artifacts: [{ artifact_id: 'a', status: 'candidate' }] }), /verified/);
});

test('ADVERSARIAL: external adapter is gated before invocation', async () => {
  let calls = 0;
  const delivery = new DeliveryRuntime({ adapter: { manifest: { external_effects: true }, execute: async () => { calls += 1; return { external_effect_observed: true }; } } });
  const proposal = delivery.propose({ mission_id: 'm', artifacts: [{ artifact_id: 'a', status: 'verified', digest: 'd' }], target: 'external' });
  await assert.rejects(() => delivery.execute(proposal), /approval/);
  assert.equal(calls, 0);
});

test('ADVERSARIAL: failed report cannot promote artifact', () => {
  const artifacts = new ArtifactRuntime();
  assert.throws(() => artifacts.candidateFromReport({ status: 'failed' }, { assigned_role_id: 'dev' }), /Failed report/);
});

test('ADVERSARIAL: registry payload modification and wrong key are rejected', () => {
  const keys = generateSigningKeyPair(); const other = generateSigningKeyPair();
  const signed = signRegistryPackage({ manifest: { name: 'policy' }, payload: { allow: false } }, keys.privateKey);
  const modified = jsonClone(signed); modified.envelope.payload.allow = true;
  assert.throws(() => verifyRegistryPackage(modified, keys.publicKey), IntegrityError);
  assert.throws(() => verifyRegistryPackage(signed, other.publicKey), IntegrityError);
});

test('ADVERSARIAL: stale queue worker cannot complete after lease recovery', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir)); let now = 0;
  const queue = new DurableQueue({ dataDir: dir, now: () => now });
  const job = await queue.enqueue({ x: 1 }, { max_attempts: 2 });
  const first = await queue.claim('a', { lease_ms: 100 }); now = 101;
  const second = await queue.claim('b', { lease_ms: 100 });
  await assert.rejects(() => queue.complete(job.job_id, 'a', first.lease_token, {}), /stale|Invalid/);
  await queue.complete(job.job_id, 'b', second.lease_token, { ok: true });
});

test('ADVERSARIAL: state and event tampering fail closed', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new HashChainStore(dir); const state = await store.create('record_a', { status: 'safe' });
  const eventFile = store.eventsFile('record_a'); await fs.appendFile(eventFile, '{"forged":true}\n');
  await assert.rejects(() => store.read('record_a'), IntegrityError);
});

test('ADVERSARIAL: unsafe paths and record IDs are rejected', () => {
  assert.throws(() => safeRelativePath('../escape'), /unsafe/);
  assert.throws(() => safeRelativePath('.git/config'), /unsafe/);
  const store = new HashChainStore('/tmp');
  assert.throws(() => store.stateFile('../../escape'), ValidationError);
});

test('ADVERSARIAL: workspace symlink cannot escape root', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'safe.txt'), 'safe');
  try { await fs.symlink('/etc', path.join(dir, 'outside')); } catch { return; }
  const workspace = await discoverWorkspace(dir);
  assert.equal(workspace.sample_files.some((item) => item.path.startsWith('outside/')), false);
});

test('ADVERSARIAL: improvement engine cannot modify runtime directly', () => {
  const engine = new ImprovementEngine();
  const proposal = engine.propose({ source_run_id: 'r', metrics: { quality_gate_passed: false } });
  assert.throws(() => engine.apply(proposal), /cannot self-apply/);
});

test('ADVERSARIAL: autonomous cycles are bounded', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false }, { type: 'implementation_error', retryable: false }] } });
  const company = new CompanyRuntime({ dataDir: dir, graphPort: port });
  const os = new AutonomousOrganizationOS({ dataDir: dir, companyRuntime: company });
  let state = await os.create({ objective: 'Implement a bounded feature', max_cycles: 1 });
  state = await os.run(state.os_run_id);
  assert.equal(state.cycle, 1);
  assert.notEqual(state.status, 'active');
});

test('ADVERSARIAL: OS approval rejects model and wrong challenge', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false }] } });
  const company = new CompanyRuntime({ dataDir: dir, graphPort: port });
  const os = new AutonomousOrganizationOS({ dataDir: dir, companyRuntime: company, governance: new GovernancePolicyEngine({ allow_medium_risk_retry: false }) });
  let state = await os.create({ objective: 'Implement a security feature', signals: { risk: 'medium' }, max_cycles: 2 });
  state = await os.run(state.os_run_id); const approval = state.approvals[0];
  await assert.rejects(() => os.resolveOSApproval(state.os_run_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'model' }), /external human/);
  await assert.rejects(() => os.resolveOSApproval(state.os_run_id, { approval_id: approval.approval_id, challenge: 'wrong', decision: 'approved' }), /challenge/);
});

test('ADVERSARIAL: council without independent verifier remains unresolved', () => {
  const council = new CouncilRuntime().convene({ subject: { x: 1 }, proposals: [
    { role_id: 'a', independence_group: 'engineering', recommendation: 'ship', evidence: ['a'] },
    { role_id: 'b', independence_group: 'product', recommendation: 'ship', evidence: ['b'] },
  ] });
  assert.equal(council.status, 'unresolved');
});

test('ADVERSARIAL: governance denies capability escalation and model operator authority', () => {
  const policy = new GovernancePolicyEngine();
  assert.equal(policy.evaluate({ type: 'delegate', actor_type: 'system', capability_escalation: true, risk: 'low' }).decision, 'deny');
  assert.equal(policy.evaluate({ type: 'abort', actor_type: 'model', risk: 'low' }).decision, 'deny');
});

test('ADVERSARIAL: user signals cannot downgrade production risk or remove approval', () => {
  const task = compileTaskSpec({ objective: 'Deploy and publish to production', signals: { risk: 'low', reversibility: 'reversible', external_effects: false, requires_implementation: false, complexity: 0 } });
  assert.equal(task.risk, 'high');
  assert.equal(task.external_effects, true);
  assert.notEqual(task.reversibility, 'reversible');
  assert.equal(task.requires_implementation, true);
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'human_approval'));
});

test('ADVERSARIAL: explicit direct archetype cannot downgrade inferred security work', () => {
  const task = compileTaskSpec({ objective: 'Implement secure authentication and permission checks', signals: { archetype: 'direct' } });
  assert.equal(task.archetype, 'security');
  assert.equal(task.requires_implementation, true);
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'develop'));
});

test('ADVERSARIAL: fabricated external delivery approval cannot invoke adapter', async () => {
  let calls = 0;
  const delivery = new DeliveryRuntime({
    adapter: { manifest: { external_effects: true }, execute: async () => { calls += 1; return { external_effect_observed: true }; } },
  });
  const proposal = delivery.propose({
    mission_id: 'm', artifacts: [{ artifact_id: 'a', status: 'verified', digest: 'd' }], target: 'production', external_effect: true,
  });
  await assert.rejects(() => delivery.execute(proposal, {
    approval: { approval_id: 'fake', status: 'approved', actor: 'external-human', delivery_id: 'other', proposal_digest: proposal.digest },
  }), /proposal-bound/);
  await assert.rejects(() => delivery.execute(proposal, {
    approval: { approval_id: 'fake', status: 'approved', actor: 'model', delivery_id: proposal.delivery_id, proposal_digest: proposal.digest },
  }), /proposal-bound/);
  assert.equal(calls, 0);
});

test('ADVERSARIAL: governance security requirements cannot be disabled by policy input', () => {
  assert.throws(() => new GovernancePolicyEngine({ external_effects_require_approval: false }), /cannot be disabled/);
  assert.throws(() => new GovernancePolicyEngine({ policy_changes_require_approval: false }), /cannot be disabled/);
  assert.throws(() => new GovernancePolicyEngine({ runtime_changes_require_approval: false }), /cannot be disabled/);
});

test('ADVERSARIAL: runtime approval secrets are random files rather than shipped constants', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const company = new CompanyRuntime({ dataDir: dir });
  let mission = await company.create({ objective: 'Deploy to production', signals: { risk: 'high', external_effects: true } });
  mission = await company.run(mission.mission.mission_id);
  const missionSecret = (await fs.readFile(path.join(dir, '.mission-approval-secret'), 'utf8')).trim();
  assert.ok(missionSecret.length >= 40);
  assert.doesNotMatch(missionSecret, /change-me|development-only/i);
  const os = new AutonomousOrganizationOS({ dataDir: dir, companyRuntime: company, governance: new GovernancePolicyEngine({ allow_medium_risk_retry: false }) });
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false }] } });
  os.company = new CompanyRuntime({ dataDir: dir, graphPort: port });
  let state = await os.create({ objective: 'Implement security controls', signals: { risk: 'medium' }, max_cycles: 2 });
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'waiting_approval');
  const osSecret = (await fs.readFile(path.join(dir, '.os-approval-secret'), 'utf8')).trim();
  assert.ok(osSecret.length >= 40);
  assert.notEqual(osSecret, missionSecret);
});

test('ADVERSARIAL: model cannot abort Autonomous Organization OS', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  const state = await os.create({ objective: 'Implement a bounded feature' });
  await assert.rejects(() => os.abort(state.os_run_id, 'model bypass', 'model'), /external human/);
  assert.notEqual((await os.status(state.os_run_id)).status, 'aborted');
});

test('ADVERSARIAL: OS creation rejects payload amplification and hidden control fields', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', runtime_override: { approvals: false } }), /unknown keys/);
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', workspace: { snapshot: 'x'.repeat(2_000_100) } }), /workspace exceeds|input exceeds/);
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', max_cycles: Number.MAX_SAFE_INTEGER }), /max_cycles/);
});
