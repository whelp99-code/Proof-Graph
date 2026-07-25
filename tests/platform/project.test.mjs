import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { initializeProject } from '../../runtime/project.mjs';

test('project init creates deterministic config and ignores runtime state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-init-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await initializeProject(root);
  assert.equal(result.ok, true);
  const config = JSON.parse(await fs.readFile(path.join(root, 'proofgraph.config.json'), 'utf8'));
  assert.equal(config.data_dir, '.proofgraph');
  assert.equal(config.default_adapter, 'mock');
  assert.equal(await fs.readFile(path.join(root, '.proofgraph', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  await assert.rejects(() => initializeProject(root), /already exists/);
  const replaced = await initializeProject(root, { force: true });
  assert.equal(replaced.replaced, true);
});
