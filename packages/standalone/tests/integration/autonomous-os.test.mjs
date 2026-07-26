import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyRuntime, ReferenceGraphKernelPort } from '../../runtime/company/index.mjs';
import { AutonomousOrganizationOS } from '../../runtime/os/autonomous-os.mjs';
import { GovernancePolicyEngine } from '../../runtime/os/governance.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('Autonomous Organization OS completes a verified low-risk mission', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  let state = await os.create({ objective: 'Implement and verify a bounded API feature', max_cycles: 2 });
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.quality_gate_passed, true);
  assert.equal((await os.verifyIntegrity(state.os_run_id)).ok, true);
});

test('OS performs a bounded second mission after non-retryable low-risk failure', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false, severity: 'medium' }] } });
  const company = new CompanyRuntime({ dataDir: dir, graphPort: port });
  const os = new AutonomousOrganizationOS({ dataDir: dir, companyRuntime: company });
  let state = await os.create({ objective: 'Implement a bounded feature', max_cycles: 2 });
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.cycle, 2);
  assert.ok(state.improvement_proposals.length >= 1);
  assert.ok(state.council_records.length >= 1);
});

test('medium-risk retry escalates to OS approval instead of silently continuing', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false, severity: 'medium' }] } });
  const company = new CompanyRuntime({ dataDir: dir, graphPort: port });
  const governance = new GovernancePolicyEngine({ allow_medium_risk_retry: false });
  const os = new AutonomousOrganizationOS({ dataDir: dir, companyRuntime: company, governance });
  let state = await os.create({ objective: 'Implement a security feature', signals: { risk: 'medium' }, max_cycles: 2 });
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'waiting_approval');
  assert.ok(state.approvals.some((item) => item.status === 'pending'));
  const approval = state.approvals.find((item) => item.status === 'pending');
  state = await os.resolveOSApproval(state.os_run_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved' });
  assert.equal(state.status, 'active');
});

test('OS refuses to self-apply improvement proposal', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  const proposal = os.improvement.propose({ source_run_id: 'run', metrics: { quality_gate_passed: false }, failures: [], evidence: [] });
  assert.throws(() => os.applyImprovement(proposal), /cannot self-apply/);
});


test('OS high-risk mission remains blocked until external mission approval and then completes', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  let state = await os.create({
    objective: 'Deploy a production database migration with rollback verification',
    signals: { risk: 'high', external_effects: true, requires_implementation: true },
    max_cycles: 2,
  });
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'waiting_approval');
  assert.ok(state.current_mission_id);
  state = await os.resolveMissionApproval(state.os_run_id, {
    decision: 'approved', actor: 'external-human', decision_source: 'operator',
  });
  assert.equal(state.status, 'active');
  state = await os.run(state.os_run_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.quality_gate_passed, true);
});

test('OS rejects unknown or invalid creation input before persisting a run', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', arbitrary_runtime: true }), /unknown keys/);
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', max_cycles: 0 }), /max_cycles/);
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', max_cycles: 1.5 }), /max_cycles/);
  await assert.rejects(() => os.create({ objective: 'Implement a bounded feature', metadata: { blob: 'x'.repeat(256_100) } }), /metadata exceeds/);
});

test('OS run identity covers the full validated mission input', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const os = new AutonomousOrganizationOS({ dataDir: dir });
  const first = await os.create({ objective: 'Implement a bounded feature', signals: { complexity: 30 }, max_cycles: 1 });
  const second = await os.create({ objective: 'Implement a bounded feature', signals: { complexity: 80 }, max_cycles: 1 });
  assert.notEqual(first.os_run_id, second.os_run_id);
});
