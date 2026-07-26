import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyRuntime, ReferenceGraphKernelPort } from '../../runtime/company/index.mjs';
import { missionProjection, readEvents } from '../../runtime/observability/index.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('observability classifies a recovered mission and exposes bounded loop metadata', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir, graphPort: new ReferenceGraphKernelPort({ failurePlan: { verify: [{ type: 'implementation_error', retryable: true }] } }) });
  let state = await runtime.create({ objective: 'Implement an API and independently verify it' });
  state = await runtime.run(state.mission.mission_id);
  const events = await readEvents(dir, state.mission.mission_id, { limit: 500 });
  const view = missionProjection(state, { timeline: events });
  assert.equal(view.status, 'completed_with_recovery');
  assert.equal(view.quality_gate_passed, true);
  assert.equal(view.failures.unresolved.length, 0);
  assert.equal(view.failures.resolved.length, 1);
  assert.equal(view.loops.length, 1);
  assert.equal(view.loops[0].status, 'exited');
  assert.ok(events.some((item) => item.type === 'route.changed'));
  assert.ok(events.some((item) => item.type === 'loop.entered'));
  assert.ok(events.some((item) => item.type === 'loop.exited'));
});

test('observability differentiates clean completion, pause, and denial', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let clean = await runtime.create({ objective: 'Summarize a local architecture note' });
  clean = await runtime.run(clean.mission.mission_id);
  assert.equal(missionProjection(clean).status, 'completed_clean');

  let paused = await runtime.create({ objective: 'Implement a small feature' });
  paused = await runtime.pause(paused.mission.mission_id, { actor: 'external-human' });
  assert.equal(missionProjection(paused).status, 'paused');
  paused = await runtime.resume(paused.mission.mission_id, { actor: 'external-human' });
  assert.equal(missionProjection(paused).status, 'active');

  let risky = await runtime.create({ objective: 'Deploy a production database migration', signals: { risk: 'high', external_effects: true } });
  risky = await runtime.run(risky.mission.mission_id);
  const approval = risky.approvals[0];
  risky = await runtime.decide(risky.mission.mission_id, { approval_id: approval.approval_id, challenge: approval.challenge, decision: 'denied', actor: 'external-human', decision_source: 'operator' });
  const denied = missionProjection(risky);
  assert.equal(denied.status, 'denied');
  assert.equal('challenge' in denied.approvals.decided[0], false);
});

test('operator retry is human-only and bounded', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir, graphPort: new ReferenceGraphKernelPort({ failurePlan: { develop: [{ type: 'implementation_error', retryable: false }] } }) });
  let state = await runtime.create({ objective: 'Implement a bounded feature' });
  state = await runtime.run(state.mission.mission_id);
  const failed = state.mission.work_items.find((item) => item.status === 'failed');
  await assert.rejects(() => runtime.retryWorkItem(state.mission.mission_id, failed.work_item_id, { actor: 'model' }), /external human/);
});
