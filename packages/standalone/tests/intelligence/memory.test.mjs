import test from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationMemoryRuntime } from '../../runtime/intelligence/index.mjs';
import { IntegrityError, PolicyError } from '../../runtime/core/errors.mjs';
import { sha256 } from '../../runtime/core/canonical.mjs';
import { tempDir, cleanup } from '../helpers.mjs';

const evidence = [{ type: 'report', id: 'report_1', digest: sha256({ verified: true }) }];

test('Organization Memory only recalls verified, provenance-bound entries', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const memory = new OrganizationMemoryRuntime({ dataDir: dir });
  const proposed = await memory.remember({ kind: 'decision', title: 'Choose token rotation policy', content: { decision: 'rotate every 30 days' }, role_id: 'planner', mission_id: 'mission_1', tags: ['auth'] });
  assert.equal((await memory.retrieve({ query: 'token rotation', mission_id: 'mission_1' })).length, 0);
  const verified = await memory.promote(proposed.memory_id, { verifier_role_id: 'verifier', evidence_refs: evidence, confidence: 0.95 });
  assert.equal(verified.status, 'verified');
  const recalled = await memory.retrieve({ query: 'token rotation', mission_id: 'mission_1', tags: ['auth'] });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].memory_id, proposed.memory_id);
  assert.ok(recalled[0].retrieval_score > 0);
  assert.equal(memory.verifyEntry(recalled[0]).ok, true);
  assert.equal((await memory.verifyIntegrity()).ok, true);
});

test('Organization Memory blocks self-verification, oversized content, and tampering', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const memory = new OrganizationMemoryRuntime({ dataDir: dir });
  const proposed = await memory.remember({ kind: 'lesson', title: 'Failed retry lesson', content: { lesson: 'bound retries' }, role_id: 'developer', source_refs: [] });
  await assert.rejects(() => memory.promote(proposed.memory_id, { verifier_role_id: 'developer', evidence_refs: evidence }), PolicyError);
  assert.throws(() => memory.createEntry({ kind: 'artifact', title: 'Oversized content', content: { data: 'x'.repeat(600000) } }), /exceeds 500000 bytes/);
  const verified = memory.createEntry({ kind: 'verification', title: 'Independent verification', content: { passed: true }, status: 'verified', source_refs: evidence, verified_by: 'verifier' });
  const tampered = structuredClone(verified); tampered.content.passed = false;
  assert.throws(() => memory.verifyEntry(tampered), IntegrityError);
});
