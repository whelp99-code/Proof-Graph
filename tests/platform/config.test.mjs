import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizePlatformConfig } from '../../runtime/config.mjs';

test('platform config resolves project-relative data directory', () => {
  const config = normalizePlatformConfig({ default_adapter: 'mock', routing: { direct: 'mock' } }, { projectDir: '/tmp/project' });
  assert.equal(config.default_adapter, 'mock');
  assert.equal(config.data_dir, path.resolve('/tmp/project/.proofgraph'));
  assert.equal(config.routing.direct, 'mock');
});
