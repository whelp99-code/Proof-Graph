import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installHostIntegration, hostInstallPlan } from '../../runtime/hosts/install.mjs';

async function tempRoot(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

const OPENCODE_PLUGIN_VERSION = '1.18.4';

test('managed OpenCode installation writes a pinned dependency manifest, plugin, bridge modules, and commands', async () => {
  const root = await tempRoot('pg-install-opencode-');
  try {
    const result = await installHostIntegration('opencode', { projectDir: root, scope: 'project', mode: 'managed' });
    assert.equal(result.mode, 'managed');
    assert.equal(result.installed.length, 7);
    assert.equal(result.updated.length, 7);
    const configRoot = path.join(root, '.opencode');
    const manifest = await json(path.join(configRoot, 'package.json'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.dependencies['@opencode-ai/plugin'], OPENCODE_PLUGIN_VERSION);
    const plugin = await fs.readFile(path.join(configRoot, 'plugins', 'proofgraph.ts'), 'utf8');
    assert.match(plugin, /\.\.\/proofgraph\/core\.mjs/);
    assert.doesNotMatch(plugin, /"\.\/core\.mjs"/);
    assert.match(await fs.readFile(path.join(configRoot, 'proofgraph', 'core.mjs'), 'utf8'), /\.\/bridge-client\.mjs/);
    assert.match(await fs.readFile(path.join(configRoot, 'commands', 'pg.md'), 'utf8'), /proofgraph_run/);
    await assert.rejects(() => installHostIntegration('opencode', { projectDir: root, scope: 'project', mode: 'managed' }), /already exists/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('OpenCode installation merges package.json without deleting user fields or dependencies', async () => {
  const root = await tempRoot('pg-install-opencode-merge-');
  try {
    const configRoot = path.join(root, '.opencode');
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(path.join(configRoot, 'package.json'), `${JSON.stringify({
      name: 'user-opencode-config',
      private: true,
      scripts: { check: 'echo check' },
      dependencies: { zod: '4.0.0' },
    }, null, 2)}\n`);
    const result = await installHostIntegration('opencode', { projectDir: root, scope: 'project' });
    const manifest = await json(path.join(configRoot, 'package.json'));
    assert.equal(manifest.name, 'user-opencode-config');
    assert.deepEqual(manifest.scripts, { check: 'echo check' });
    assert.equal(manifest.dependencies.zod, '4.0.0');
    assert.equal(manifest.dependencies['@opencode-ai/plugin'], OPENCODE_PLUGIN_VERSION);
    assert.ok(result.updated.includes(path.join(configRoot, 'package.json')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('OpenCode dependency conflicts fail closed and --force replaces only the managed dependency', async () => {
  const root = await tempRoot('pg-install-opencode-dependency-');
  try {
    const configRoot = path.join(root, '.opencode');
    const packageFile = path.join(configRoot, 'package.json');
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(packageFile, `${JSON.stringify({
      private: true,
      custom: { preserved: true },
      dependencies: { '@opencode-ai/plugin': '1.0.0', zod: '4.0.0' },
    }, null, 2)}\n`);
    await assert.rejects(() => installHostIntegration('opencode', { projectDir: root }), /dependency conflict/);
    await assert.rejects(() => fs.access(path.join(configRoot, 'plugins', 'proofgraph.ts')));
    assert.equal((await json(packageFile)).dependencies['@opencode-ai/plugin'], '1.0.0');

    await installHostIntegration('opencode', { projectDir: root, force: true });
    const manifest = await json(packageFile);
    assert.equal(manifest.dependencies['@opencode-ai/plugin'], OPENCODE_PLUGIN_VERSION);
    assert.equal(manifest.dependencies.zod, '4.0.0');
    assert.deepEqual(manifest.custom, { preserved: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('managed Pi installation is self-contained in an extension directory', async () => {
  const root = await tempRoot('pg-install-pi-');
  try {
    const result = await installHostIntegration('pi', { projectDir: root, scope: 'project', mode: 'managed' });
    assert.equal(result.installed.length, 3);
    const extension = path.join(root, '.pi', 'extensions', 'proofgraph');
    assert.match(await fs.readFile(path.join(extension, 'index.ts'), 'utf8'), /"\.\/core\.mjs"/);
    assert.match(await fs.readFile(path.join(extension, 'core.mjs'), 'utf8'), /['"]\.\/bridge-client\.mjs['"]/);
    await fs.access(path.join(extension, 'bridge-client.mjs'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('installation mode and host names are fail-closed', async () => {
  const root = await tempRoot('pg-install-mode-');
  try {
    assert.throws(() => hostInstallPlan('pi', { projectDir: root, mode: 'cli' }), /mode must be managed/);
    assert.throws(() => hostInstallPlan('unknown', { projectDir: root }), /Unsupported host/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('installer refuses symlinked configuration roots', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink permissions vary on Windows');
  const root = await tempRoot('pg-install-link-');
  const outside = await tempRoot('pg-install-outside-');
  try {
    await fs.symlink(outside, path.join(root, '.opencode'));
    await assert.rejects(() => installHostIntegration('opencode', { projectDir: root, mode: 'managed' }), /symlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('installer refuses a symlinked OpenCode package manifest', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink permissions vary on Windows');
  const root = await tempRoot('pg-install-package-link-');
  const outside = await tempRoot('pg-install-package-outside-');
  try {
    const configRoot = path.join(root, '.opencode');
    await fs.mkdir(configRoot, { recursive: true });
    const outsidePackage = path.join(outside, 'package.json');
    await fs.writeFile(outsidePackage, '{}\n');
    await fs.symlink(outsidePackage, path.join(configRoot, 'package.json'));
    await assert.rejects(() => installHostIntegration('opencode', { projectDir: root }), /symlink/);
    assert.equal(await fs.readFile(outsidePackage, 'utf8'), '{}\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('installer preflights all destinations and leaves no partial installation or package mutation', async () => {
  const root = await tempRoot('pg-install-atomic-');
  try {
    const configRoot = path.join(root, '.opencode');
    const packageFile = path.join(configRoot, 'package.json');
    const originalPackage = `${JSON.stringify({ private: true, dependencies: { zod: '4.0.0' } }, null, 2)}\n`;
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(packageFile, originalPackage);
    const conflict = path.join(configRoot, 'commands', 'pg-report.md');
    await fs.mkdir(path.dirname(conflict), { recursive: true });
    await fs.writeFile(conflict, 'existing');
    await assert.rejects(() => installHostIntegration('opencode', { projectDir: root, mode: 'managed' }), /already exists/);
    await assert.rejects(() => fs.access(path.join(configRoot, 'plugins', 'proofgraph.ts')));
    assert.equal(await fs.readFile(conflict, 'utf8'), 'existing');
    assert.equal(await fs.readFile(packageFile, 'utf8'), originalPackage);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
