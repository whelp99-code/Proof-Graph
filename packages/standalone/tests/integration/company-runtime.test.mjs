import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileMission, CompanyRuntime, ReferenceGraphKernelPort, HostBridgeGraphPort, ArtifactRuntime, DeliveryRuntime } from '../../runtime/company/index.mjs';
import { PolicyError, IntegrityError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('mission compiler creates Mission → Project → Sprint → WorkItem hierarchy', () => {
  const mission = compileMission({ objective: 'Implement and verify an API feature', signals: { requires_research: true } });
  assert.equal(mission.projects.length, 1);
  assert.equal(mission.sprints.length, 1);
  assert.ok(mission.work_items.some((item) => item.kind === 'develop'));
  assert.ok(mission.work_items.some((item) => item.kind === 'verify'));
  assert.ok(mission.work_items.every((item) => item.project_id === mission.projects[0].project_id));
});

test('company runtime completes a verified mission and promotes artifacts', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Implement and independently verify a bounded API feature' });
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.quality_gate_passed, true);
  assert.ok(state.artifacts.length > 0);
  assert.ok(state.artifacts.every((artifact) => artifact.status === 'verified'));
});

test('high-risk mission waits for external approval then resumes', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Deploy a database migration to production', signals: { risk: 'high', external_effects: true, requires_implementation: true } });
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'waiting_approval');
  const approval = state.approvals[0];
  await assert.rejects(() => runtime.decide(state.mission.mission_id, { approval_id: approval.approval_id, challenge: 'wrong', decision: 'approved' }), /challenge/);
  state = await runtime.decide(state.mission.mission_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'external-human', decision_source: 'operator' });
  assert.equal(state.status, 'active');
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
});

test('model cannot decide a human approval', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Publish a production release', signals: { risk: 'high', external_effects: true } });
  state = await runtime.run(state.mission.mission_id);
  const approval = state.approvals[0];
  await assert.rejects(() => runtime.decide(state.mission.mission_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'model', decision_source: 'operator' }), PolicyError);
});

test('verification implementation failure reroutes to development and then succeeds', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { verify: [{ type: 'implementation_error', retryable: true }] } });
  const runtime = new CompanyRuntime({ dataDir: dir, graphPort: port });
  let state = await runtime.create({ objective: 'Implement a feature with a regression test' });
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
  assert.ok(state.failures.some((failure) => failure.type === 'implementation_error'));
  assert.ok(state.route_history.some((route) => route.failure_type === 'implementation_error'));
  assert.ok(port.invocations.filter((item) => item.kind === 'develop').length >= 2);
});

test('non-retryable failure remains visible and mission is not false-success', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const port = new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false, severity: 'high' }] } });
  const runtime = new CompanyRuntime({ dataDir: dir, graphPort: port });
  let state = await runtime.create({ objective: 'Implement a feature' });
  state = await runtime.run(state.mission.mission_id);
  assert.notEqual(state.status, 'completed');
  assert.equal(state.quality_gate_passed, false);
  assert.ok(state.failures.length >= 1);
});

test('company runtime persists and resumes through a new process object', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const first = new CompanyRuntime({ dataDir: dir });
  let state = await first.create({ objective: 'Research and verify a runtime contract', signals: { requires_research: true } });
  state = await first.tick(state.mission.mission_id);
  const second = new CompanyRuntime({ dataDir: dir });
  state = await second.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
  assert.equal((await second.verifyIntegrity(state.mission.mission_id)).ok, true);
});

test('artifact runtime refuses failed or self-verified promotion', () => {
  const artifacts = new ArtifactRuntime();
  assert.throws(() => artifacts.candidateFromReport({ status: 'failed' }, { assigned_role_id: 'dev' }), PolicyError);
  const candidate = { artifact_id: 'a', status: 'candidate', producer_role_id: 'same' };
  assert.throws(() => artifacts.promote([candidate], { status: 'success', verification: { passed: true, independent: true } }, { assigned_role_id: 'same' }), /cannot verify/);
});

test('delivery runtime allows verified local dry-run but requires proposal-bound external approval', async () => {
  const delivery = new DeliveryRuntime();
  const artifact = { artifact_id: 'a', status: 'verified', digest: 'd' };
  const local = delivery.propose({ mission_id: 'm', artifacts: [artifact] });
  assert.equal((await delivery.execute(local)).dry_run, true);
  const external = delivery.propose({ mission_id: 'm', artifacts: [artifact], external_effect: true, reversible: false, target: 'production' });
  await assert.rejects(() => delivery.execute(external), /approval/);
  await assert.rejects(() => delivery.execute(external, { approval: { approval_id: 'approval_1', status: 'approved', actor: 'external-human' } }), /proposal-bound/);
  const approval = {
    approval_id: 'approval_1', status: 'approved', actor: 'external-human',
    delivery_id: external.delivery_id, proposal_digest: external.digest,
  };
  const receipt = await delivery.execute(external, { approval });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.approval_id, approval.approval_id);
});

test('company runtime binds external delivery approval to persisted proposal and operator', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Implement and independently verify a bounded delivery feature' });
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
  state = await runtime.proposeDelivery(state.mission.mission_id, { target: 'production', external_effect: true, reversible: false });
  const proposal = state.deliveries.at(-1);
  const approval = state.approvals.find((item) => item.kind === 'delivery' && item.delivery_id === proposal.delivery_id);
  assert.ok(approval);
  await assert.rejects(() => runtime.executeDelivery(state.mission.mission_id, proposal.delivery_id), /persisted.*approval/);
  await assert.rejects(() => runtime.decideDelivery(state.mission.mission_id, {
    approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'model', decision_source: 'operator',
  }), /external human/);
  await assert.rejects(() => runtime.decideDelivery(state.mission.mission_id, {
    approval_id: approval.approval_id, challenge: 'wrong', decision: 'approved', actor: 'external-human', decision_source: 'operator',
  }), /challenge/);
  state = await runtime.decideDelivery(state.mission.mission_id, {
    approval_id: approval.approval_id, challenge: approval.challenge, decision: 'approved', actor: 'external-human', decision_source: 'operator',
  });
  assert.equal(state.approvals.find((item) => item.approval_id === approval.approval_id).status, 'approved');
  state = await runtime.executeDelivery(state.mission.mission_id, proposal.delivery_id);
  assert.equal(state.deliveries.at(-1).status, 'completed');
  assert.equal(state.receipts.length, 1);
  await assert.rejects(() => runtime.executeDelivery(state.mission.mission_id, proposal.delivery_id), /already executed/);
});

test('mission integrity detects state tampering', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  const state = await runtime.create({ objective: 'Implement a small feature' });
  const file = runtime.store.stateFile(state.mission.mission_id);
  const raw = JSON.parse(await fs.readFile(file, 'utf8')); raw.status = 'completed'; raw.quality_gate_passed = true;
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(() => runtime.verifyIntegrity(state.mission.mission_id), IntegrityError);
});


test('Host Bridge Graph Port executes v1.1 run and integrity contracts without operator commands', async () => {
  const calls = [];
  const report = {
    run_id: 'pg_host_run_1', status: 'success', output: { deliverables: [] },
    verification: { passed: true, independent: true, evidence: ['host'] }, usage: { calls: 1 },
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const result = body.command === 'run' ? { report } : body.command === 'integrity' ? { ok: true, run_id: body.run_id } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const port = new HostBridgeGraphPort({
    url: 'http://127.0.0.1:8743', token: 'host-bridge-token-12345678901234567890', host: 'opencode', fetchImpl,
  });
  const result = await port.execute({
    request_id: 'request_1', mission_id: 'mission_1', adapter: 'opencode',
    task: { archetype: 'feature' }, organization: { organization_id: 'org_1' },
    work_item: { work_item_id: 'work_1', objective: 'Implement a host contract', assigned_role_id: 'developer' },
  });
  assert.equal(result.run_id, report.run_id);
  assert.equal((await port.verifyIntegrity(result)).ok, true);
  assert.deepEqual(calls.map((item) => item.command), ['run', 'integrity']);
  assert.ok(calls.every((item) => item.protocol_version === 'proofgraph.host.v1' && item.host === 'opencode'));
});
