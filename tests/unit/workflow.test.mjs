import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  abortRun,
  attachEvidence,
  classifyClaims,
  completeTask,
  finalizeRun,
  getReport,
  getStatus,
  recordVerdicts,
  startRun,
  verifyIntegrity,
} from '../../server/lib/workflow.mjs';
import { readRun, withRunTransaction } from '../../server/lib/store.mjs';
import { addFixture, BASIC_TASKS, cleanupContext, createPlannedClaim, createRun, makeContext } from '../helpers.mjs';
import { registerPlan, registerClaims } from '../../server/lib/workflow.mjs';

async function prepareSupported(context, { sameHost = false, injection = false } = {}) {
  const runId = await createPlannedClaim(context);
  const q1 = 'The sample system supports deterministic evidence validation through exact quotation matching.';
  const q2 = 'Independent documentation confirms deterministic evidence validation using source content hashes.';
  const s1 = (await addFixture(context, runId, { url: 'https://one.example/doc', content: `Header. ${q1} Footer.` })).source.source_id;
  const s2 = (await addFixture(context, runId, {
    actor: 'research-secondary',
    url: sameHost ? 'https://one.example/other' : 'https://two.example/doc',
    content: `Header. ${q2} Footer.`,
    promptInjection: injection,
  })).source.source_id;
  const evidence = await attachEvidence({
    run_id: runId,
    actor: 'research-primary',
    items: [
      { claim_id: 'claim-01', source_id: s1, quote: q1, stance: 'supports' },
      { claim_id: 'claim-01', source_id: s2, quote: q2, stance: 'supports' },
    ],
  }, context);
  await recordVerdicts({
    run_id: runId,
    actor: 'verifier',
    items: [{ claim_id: 'claim-01', verdict: 'supported', rationale: 'Exact source passages support the registered claim.', evidence_ids: evidence.evidence_ids }],
  }, context);
  return { runId, evidence: evidence.evidence_ids };
}

test('supported classification requires distinct hosts and independent verdict', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const { runId } = await prepareSupported(context);
  const state = await readRun(context.dataDir, runId);
  assert.equal(classifyClaims(state)['claim-01'].classification, 'supported');
});

test('two sources on one hostname do not satisfy independence threshold', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const { runId } = await prepareSupported(context, { sameHost: true });
  const state = await readRun(context.dataDir, runId);
  assert.equal(classifyClaims(state)['claim-01'].classification, 'unverified');
});

test('prompt-injection flagged evidence is excluded from automatic support', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const { runId } = await prepareSupported(context, { injection: true });
  const state = await readRun(context.dataDir, runId);
  const result = classifyClaims(state)['claim-01'];
  assert.equal(result.classification, 'unverified');
  assert.equal(result.excluded_injection_evidence_ids.length, 1);
});

test('claim producer cannot record own verdict', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createPlannedClaim(context);
  await assert.rejects(() => recordVerdicts({
    run_id: runId,
    actor: 'planner',
    items: [{ claim_id: 'claim-01', verdict: 'insufficient', rationale: 'There is not enough independent evidence.', evidence_ids: [] }],
  }, context), /not permitted|cannot verify their own claim/);
});

test('finalization is blocked while planned tasks are pending', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createPlannedClaim(context);
  await assert.rejects(() => finalizeRun({ run_id: runId, actor: 'synthesizer' }, context), /tasks are pending/);
});

test('failed tasks remain visible and make the quality gate partial', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createPlannedClaim(context);
  for (const [taskId, outcome] of [['research-primary', 'success'], ['research-secondary', 'failed'], ['verification', 'success']]) {
    await completeTask({ run_id: runId, actor: taskId === 'verification' ? 'verifier' : taskId, task_id: taskId, outcome, summary: `Task ended as ${outcome}.` }, context);
  }
  await recordVerdicts({
    run_id: runId,
    actor: 'verifier',
    items: [{ claim_id: 'claim-01', verdict: 'insufficient', rationale: 'No qualifying exact-match sources were available.', evidence_ids: [] }],
  }, context);
  const finalized = await finalizeRun({ run_id: runId, actor: 'synthesizer' }, context);
  assert.equal(finalized.quality_gate_passed, false);
  const report = await getReport({ run_id: runId, format: 'json' }, context);
  assert.equal(report.report.task_counts.failed, 1);
  assert.equal(report.report.classification_counts.unverified, 1);
});

test('full successful lifecycle finalizes, reports, and verifies integrity', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const { runId } = await prepareSupported(context);
  for (const taskId of ['research-primary', 'research-secondary', 'verification']) {
    await completeTask({ run_id: runId, actor: taskId === 'verification' ? 'verifier' : taskId, task_id: taskId, outcome: 'success', summary: 'Completed with exact source evidence.' }, context);
  }
  const finalized = await finalizeRun({ run_id: runId, actor: 'synthesizer' }, context);
  assert.equal(finalized.quality_gate_passed, true);
  const status = await getStatus({ run_id: runId }, context);
  assert.equal(status.claims[0].classification, 'supported');
  const integrity = await verifyIntegrity({ run_id: runId }, context);
  assert.equal(integrity.ok, true, JSON.stringify(integrity.failed_checks));
  const report = await getReport({ run_id: runId, format: 'markdown' }, context);
  assert.match(report.report, /SUPPORTED/);
});

test('tool-call budget is a hard state transition', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context, { max_tool_calls: 10, max_source_fetches: 2 });
  await registerPlan({ run_id: runId, actor: 'planner', tasks: BASIC_TASKS }, context);
  await registerClaims({ run_id: runId, actor: 'planner', claims: [{ claim_id: 'claim-01', text: 'A concrete test claim exists.', importance: 'low' }] }, context);
  // Consume the remaining eight calls with status-mutating task operations that fail validation only after budget reservation.
  for (let i = 0; i < 8; i += 1) {
    await completeTask({ run_id: runId, actor: 'research-primary', task_id: 'research-primary', outcome: 'success', summary: 'Finished once.' }, context).catch(() => {});
  }
  await assert.rejects(() => completeTask({ run_id: runId, actor: 'research-secondary', task_id: 'research-secondary', outcome: 'success', summary: 'Cannot start after budget.' }, context), /budget/i);
  const state = await readRun(context.dataDir, runId);
  assert.equal(state.status, 'budget_exceeded');
  assert.equal(state.budget_exceeded_reason, 'max_tool_calls');
});

test('only one active run is permitted per project and abort releases it', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context);
  await assert.rejects(() => startRun({ objective: 'A second objective must not start in the same project.' }, context), /already active/);
  await abortRun({ run_id: runId, actor: 'coordinator', reason: 'Test cleanup abort.' }, context);
  const second = await startRun({ objective: 'A new run may start after an explicit abort.' }, context);
  assert.match(second.run_id, /^pg_/);
});

test('parallel state transactions serialize without lost updates', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createRun(context);
  await Promise.all(Array.from({ length: 25 }, (_, index) => withRunTransaction(context.dataDir, runId, (state, emit) => {
    state.test_counter = (state.test_counter ?? 0) + 1;
    emit('test.increment', `worker-${index}`, { index });
  })));
  const state = await readRun(context.dataDir, runId);
  assert.equal(state.test_counter, 25);
  const integrity = await verifyIntegrity({ run_id: runId }, context);
  assert.equal(integrity.checks.find((check) => check.check === 'event_chain').ok, true);
});

test('source tampering is detected', async (t) => {
  const context = await makeContext(); t.after(() => cleanupContext(context));
  const runId = await createPlannedClaim(context);
  const fixture = await addFixture(context, runId, { url: 'https://source.example/doc', content: 'A sufficiently long exact source sentence for integrity testing.' });
  const state = await readRun(context.dataDir, runId);
  const source = state.sources[fixture.source.source_id];
  const file = `${context.dataDir}/runs/${runId}/sources/${source.source_id}.txt`;
  await fs.writeFile(file, 'tampered source body');
  const integrity = await verifyIntegrity({ run_id: runId }, context);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.failed_checks.includes(`source:${source.source_id}`));
});
