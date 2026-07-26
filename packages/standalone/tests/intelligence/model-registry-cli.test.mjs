import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadModelRegistryFile } from '../../runtime/intelligence/index.mjs';
import { PolicyError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

const exec = promisify(execFile);
const CLI = path.resolve('bin/proofgraph-org.mjs');

function registry(modelId = 'custom/all-capable-v1') {
  return {
    schema: 'proofgraph.model-registry.v1', schema_version: 1, registry_version: 'test-registry-1', entries: [{
      model_id: modelId, provider: 'custom', host: 'opencode', enabled: true,
      capabilities: ['coding', 'general', 'planning', 'reasoning', 'research', 'structured_output', 'verification'],
      data_classifications: ['public', 'internal', 'confidential', 'restricted'], risk_ceiling: 'critical',
      max_context_tokens: 250000, quality: 0.9, reliability: 0.9, health: 1, latency_ms: 10,
      input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, tags: ['test'],
    }],
  };
}

async function cli(args, env = {}) {
  const result = await exec(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, maxBuffer: 20_000_000 });
  return JSON.parse(result.stdout);
}

test('model registry loader is bounded, normalized, and rejects symlinks', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const file = path.join(dir, 'registry.json'); await fs.writeFile(file, JSON.stringify(registry()));
  const loaded = await loadModelRegistryFile(file);
  assert.equal(loaded.registry_version, 'test-registry-1');
  assert.equal(loaded.entries[0].model_id, 'custom/all-capable-v1');
  const link = path.join(dir, 'registry-link.json'); await fs.symlink(file, link);
  await assert.rejects(() => loadModelRegistryFile(link), PolicyError);
});

test('proofgraph-org uses exact configured models and fails closed on registry drift', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const data = path.join(dir, 'data'); const file = path.join(dir, 'registry.json');
  await fs.writeFile(file, JSON.stringify(registry()));
  const state = await cli(['mission-run', 'Implement and independently verify a bounded feature', '--data-dir', data, '--model-registry', file]);
  assert.equal(state.status, 'completed');
  assert.ok(state.intelligence.route_decisions.length > 0);
  assert.ok(state.intelligence.route_decisions.every((route) => route.model_id === 'custom/all-capable-v1'));
  const missionId = state.mission.mission_id;
  const common = ['--data-dir', data, '--model-registry', file];
  const summary = await cli(['mission-intelligence', missionId, 'summary', ...common]);
  assert.ok(summary.counts.contexts > 0); assert.ok(summary.counts.observations > 0);
  const contexts = await cli(['mission-intelligence', missionId, 'contexts', ...common]);
  assert.ok(contexts.every((item) => Number.isInteger(item.stale_source_count) && Number.isInteger(item.unknown_freshness_source_count)));
  const fullContexts = await cli(['mission-intelligence', missionId, 'contexts', '--full', ...common]);
  assert.ok(fullContexts.every((item) => item.schema === 'proofgraph.context-packet.v1'));
  const routes = await cli(['mission-intelligence', missionId, 'routes', ...common]);
  assert.ok(routes.every((item) => item.model_id === 'custom/all-capable-v1'));
  const observations = await cli(['mission-intelligence', missionId, 'observations', ...common]);
  assert.ok(observations.observations.length > 0); assert.ok(observations.model_summary.length > 0);
  const contracts = await cli(['mission-intelligence', missionId, 'contracts', ...common]);
  assert.ok(Array.isArray(contracts.contracts)); assert.ok(Array.isArray(contracts.handoffs));
  const knowledge = await cli(['mission-intelligence', missionId, 'knowledge', ...common]);
  assert.ok(knowledge.nodes > 0); assert.ok(knowledge.edges > 0);
  const fullKnowledge = await cli(['mission-intelligence', missionId, 'knowledge', '--full', ...common]);
  assert.ok(Array.isArray(fullKnowledge.nodes));
  const memory = await cli(['mission-intelligence', missionId, 'memory', ...common]);
  assert.ok(Array.isArray(memory.entries));
  const fullMemory = await cli(['mission-intelligence', missionId, 'memory', '--full', ...common]);
  assert.ok(Array.isArray(fullMemory.entries));
  const verification = await cli(['mission-intelligence', missionId, 'verification', ...common]);
  assert.ok(Array.isArray(verification));
  const impactSource = fullKnowledge.edges[0]?.from ?? fullKnowledge.nodes[0]?.node_id;
  const impact = await cli(['mission-impact', missionId, impactSource, '--depth', '5', ...common]);
  assert.ok(Array.isArray(impact)); assert.ok(impact.length > 0); assert.equal(impact[0].source_id, impactSource);
  const integrity = await cli(['mission-integrity', missionId, ...common]);
  assert.equal(integrity.ok, true);
  await assert.rejects(
    () => exec(process.execPath, [CLI, 'mission-integrity', state.mission.mission_id, '--data-dir', data], { env: process.env, maxBuffer: 20_000_000 }),
    /registry mismatch/i,
  );
});
