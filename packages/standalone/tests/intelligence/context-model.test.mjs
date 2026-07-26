import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMission } from '../../runtime/company/index.mjs';
import { ContextRuntime, ModelRouter } from '../../runtime/intelligence/index.mjs';
import { IntegrityError, PolicyError } from '../../runtime/core/errors.mjs';
import { sha256 } from '../../runtime/core/canonical.mjs';

function registry() {
  return {
    schema: 'proofgraph.model-registry.v1', schema_version: 1, registry_version: 'test-registry-1',
    entries: [
      {
        model_id: 'open/coder-v1', provider: 'open', host: 'opencode', enabled: true,
        capabilities: ['general', 'coding', 'structured_output'], data_classifications: ['public', 'internal'], risk_ceiling: 'high',
        max_context_tokens: 100000, quality: 0.95, reliability: 0.9, health: 1, latency_ms: 500,
        input_cost_micros_per_million: 100, output_cost_micros_per_million: 200, tags: ['code'],
      },
      {
        model_id: 'verify/reason-v1', provider: 'verify', host: 'claude', enabled: true,
        capabilities: ['general', 'reasoning', 'verification', 'structured_output'], data_classifications: ['public', 'internal', 'confidential'], risk_ceiling: 'critical',
        max_context_tokens: 200000, quality: 0.98, reliability: 0.98, health: 1, latency_ms: 900,
        input_cost_micros_per_million: 200, output_cost_micros_per_million: 400, tags: ['deep'],
      },
      {
        model_id: 'general/cheap-v1', provider: 'general', host: 'pi', enabled: true,
        capabilities: ['general', 'reasoning', 'structured_output'], data_classifications: ['public', 'internal'], risk_ceiling: 'medium',
        max_context_tokens: 32000, quality: 0.6, reliability: 0.8, health: 1, latency_ms: 100,
        input_cost_micros_per_million: 1, output_cost_micros_per_million: 2, tags: ['cheap'],
      },
    ],
  };
}

test('Context Runtime delivers role-minimized, redacted, provenance-bound packets', () => {
  const mission = compileMission({ objective: 'Implement and verify an authentication API' });
  const develop = mission.work_items.find((item) => item.kind === 'develop');
  const verify = mission.work_items.find((item) => item.kind === 'verify');
  const dependency = {
    ...mission.work_items.find((item) => item.kind === 'plan'), status: 'completed', attempts: 1,
    output: { api_key: 'sk-secretsecretsecret', path: '/Users/private-user/project', self_assessment: 'perfect', plan: 'Use bounded contract' },
  };
  const runtime = new ContextRuntime();
  const developerPacket = runtime.compile({ mission, workItem: develop, dependencies: [dependency], memory: [] });
  assert.equal(runtime.verify(developerPacket).ok, true);
  const serialized = JSON.stringify(developerPacket);
  assert.equal(serialized.includes('sk-secretsecretsecret'), false);
  assert.equal(serialized.includes('/Users/private-user'), false);
  assert.ok(developerPacket.redactions.length >= 2);
  assert.ok(developerPacket.sources.every((item) => /^[a-f0-9]{64}$/.test(item.digest)));
  assert.ok(Object.keys(developerPacket.sections).every((name) => developerPacket.policy.sections.includes(name)));

  const verifierPacket = runtime.compile({ mission, workItem: verify, dependencies: [{ ...develop, status: 'completed', attempts: 1, output: dependency.output }] });
  assert.equal(JSON.stringify(verifierPacket.sections).includes('self_assessment'), false);

  const tampered = structuredClone(developerPacket); tampered.sections.objective = 'tampered';
  assert.throws(() => runtime.verify(tampered), IntegrityError);
});

test('Model Router selects exact capable model, records fallback, and fails closed', () => {
  const router = new ModelRouter({ registry: registry() });
  const coding = router.route({ mission_id: 'mission_1', work_item_id: 'work_1', kind: 'develop', risk: 'medium', classification: 'internal', context_tokens: 12000 });
  assert.equal(coding.model_id, 'open/coder-v1');
  assert.equal(coding.host, 'opencode');
  assert.equal(router.verify(coding).ok, true);

  const verification = router.route({ mission_id: 'mission_1', work_item_id: 'work_2', kind: 'verify', risk: 'critical', classification: 'confidential', context_tokens: 20000, verification_strength: 'deep' });
  assert.equal(verification.model_id, 'verify/reason-v1');
  assert.ok(Array.isArray(verification.fallback_chain));

  assert.throws(() => router.route({ mission_id: 'mission_1', work_item_id: 'work_3', kind: 'develop', risk: 'critical', classification: 'restricted', context_tokens: 1000 }), PolicyError);
  assert.throws(() => router.route({ mission_id: 'mission_1', work_item_id: 'work_4', kind: 'develop', risk: 'low', classification: 'internal', context_tokens: 1000, allowed_hosts: ['forbidden'] }), PolicyError);

  const tampered = structuredClone(coding); tampered.model_id = 'general/cheap-v1';
  assert.throws(() => router.verify(tampered), IntegrityError);
});


test('Context Runtime records source freshness and rejects stale inputs when policy requires it', () => {
  const mission = compileMission({ objective: 'Implement and verify a freshness-aware API' });
  const develop = mission.work_items.find((item) => item.kind === 'develop');
  const oldDependency = {
    ...mission.work_items.find((item) => item.kind === 'plan'),
    status: 'completed', attempts: 1, completed_at: '2020-01-01T00:00:00.000Z', output: { summary: 'old plan' },
  };
  const runtime = new ContextRuntime();
  const packet = runtime.compile({ mission, workItem: develop, dependencies: [oldDependency], policy: { max_source_age_s: 60 } });
  assert.ok(packet.stale_source_count >= 1);
  assert.ok(packet.sources.some((item) => item.stale === true && item.freshness === 'stale' && item.oldest_age_seconds > 60));
  assert.equal(runtime.verify(packet).stale_source_count, packet.stale_source_count);
  assert.throws(() => runtime.compile({ mission, workItem: develop, dependencies: [oldDependency], policy: { max_source_age_s: 60, reject_stale_sources: true } }), PolicyError);

  const inconsistent = structuredClone(packet);
  const stale = inconsistent.sources.find((item) => item.stale);
  stale.stale = false; stale.freshness = 'fresh';
  delete inconsistent.digest; inconsistent.digest = sha256(inconsistent);
  assert.throws(() => runtime.verify(inconsistent), IntegrityError);
});

test('Model Router records immutable execution observations without silently changing registry policy', () => {
  const router = new ModelRouter({ registry: registry() });
  const route = router.route({ mission_id: 'mission_obs', work_item_id: 'work_obs', kind: 'develop', risk: 'medium', classification: 'internal', context_tokens: 12000 });
  const report = {
    run_id: 'run_obs', status: 'success', output: { summary: 'implemented' }, failure: null,
    usage: { calls: 1, tokens: 321, cost_micros: 45, wall_time_ms: 987 },
    integrity: { report_digest: sha256({ run_id: 'run_obs', status: 'success' }) },
  };
  const observation = router.observe({ routeDecision: route, report, attempt: 1 });
  assert.equal(router.verifyObservation(observation).ok, true);
  assert.equal(observation.model_id, route.model_id);
  assert.equal(observation.latency_ms, 987);
  const summary = router.summarizeObservations([observation]);
  assert.equal(summary[0].success_rate, 1);
  assert.equal(summary[0].average_latency_ms, 987);
  assert.equal(router.registry.digest, route.registry_digest);

  const tampered = structuredClone(observation); tampered.tokens += 1;
  assert.throws(() => router.verifyObservation(tampered), IntegrityError);
});
