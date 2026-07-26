import test from 'node:test';
import assert from 'node:assert/strict';
import { failurePacket } from '../../runtime/company/domain.mjs';
import { zeroBudget } from '../../runtime/organization/domain.mjs';

test('domain helper factories return immutable explicit contracts', () => {
  const failure = failurePacket({ type: 'implementation_error', message: 'failed', evidence: ['test'], source: 'verifier' });
  assert.equal(failure.schema_version, 1);
  assert.equal(failure.retryable, true);
  assert.equal(Object.isFrozen(failure), true);
  const budget = zeroBudget();
  assert.deepEqual(budget, { calls: 0, tokens: 0, cost_micros: 0, wall_time_ms: 0 });
  assert.equal(Object.isFrozen(budget), true);
});
