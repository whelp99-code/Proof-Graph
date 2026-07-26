import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyRuntime } from '../../runtime/company/index.mjs';
import { missionProjection } from '../../runtime/observability/index.mjs';
import { renderOperatorSnapshot } from '../../runtime/operator/index.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

test('Intelligence Fabric integrates Context, Routing, Collaboration, Knowledge, Memory, and Verification', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const runtime = new CompanyRuntime({ dataDir: dir });
  let state = await runtime.create({ objective: 'Implement and independently verify an authentication API' });
  state = await runtime.run(state.mission.mission_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.quality_gate_passed, true);
  const intelligence = state.intelligence;
  assert.equal(intelligence.fabric_version, '5.0.0');
  assert.ok(intelligence.context_packets.length >= 4);
  assert.equal(intelligence.route_decisions.length, intelligence.context_packets.length);
  assert.ok(intelligence.route_decisions.every((item) => item.model_id && item.registry_digest));
  assert.equal(intelligence.model_observations.length, intelligence.route_decisions.length);
  assert.ok(intelligence.model_observations.every((item) => item.model_id && item.route_id && item.digest));
  assert.ok(intelligence.contracts.length >= 3);
  assert.ok(intelligence.contracts.every((item) => ['completed', 'cancelled', 'rejected', 'blocked'].includes(item.status)));
  assert.ok(intelligence.knowledge_graph.nodes.length > 0);
  assert.ok(intelligence.memory_captured.length > 0);
  assert.equal(intelligence.verifications.at(-1).scope, 'terminal');
  assert.equal(intelligence.verifications.at(-1).passed, true);
  assert.equal((await runtime.verifyIntegrity(state.mission.mission_id)).ok, true);

  const projection = missionProjection(state);
  assert.equal(projection.intelligence.fabric_version, '5.0.0');
  assert.equal(projection.intelligence.contexts.packets[0].sections instanceof Array, true);
  assert.equal(projection.intelligence.routing.observation_total, intelligence.model_observations.length);
  assert.ok(projection.intelligence.routing.model_summary.length >= 1);
  assert.equal('content' in (projection.intelligence.memory.recalled[0] ?? {}), false);
  for (const [view, heading] of [
    ['context', 'CONTEXT DELIVERY'], ['models', 'MODEL ROUTING'], ['collaboration', 'COLLABORATION'],
    ['knowledge', 'KNOWLEDGE / IMPACT'], ['memory', 'ORGANIZATION MEMORY'], ['verification', 'INTELLIGENCE VERIFICATION'],
  ]) assert.match(renderOperatorSnapshot({ runs: [projection], view, width: 140, height: 40 }), new RegExp(heading.replace('/', '\\/')));
});
