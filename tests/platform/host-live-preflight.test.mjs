import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
async function tempRoot(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

async function fakeVersionCommand(root, name, version) {
  const file = path.join(root, name);
  await fs.writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  await fs.chmod(file, 0o700);
  return file;
}

function runPreflight(env) {
  return spawnSync(process.execPath, ['scripts/hosts-live-preflight.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_SERVER_URL: '', ...env },
    timeout: 30_000,
  });
}

test('host live preflight accepts the reviewed OpenCode target and reports missing Pi as an explicit skip', async (t) => {
  if (process.platform === 'win32') return t.skip('shell fixture is Unix-specific');
  const root = await tempRoot('pg-host-preflight-ok-');
  try {
    const opencode = await fakeVersionCommand(root, 'opencode', 'opencode 1.18.4');
    const result = runPreflight({ OPENCODE_BIN: opencode, PI_BIN: path.join(root, 'missing-pi') });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    const openCodeCheck = body.checks.find((item) => item.name === 'opencode_cli');
    assert.equal(openCodeCheck.detected_version, '1.18.4');
    assert.equal(openCodeCheck.version_matches_contract_target, true);
    assert.equal(body.live_canary_required, true);
    assert.ok(body.checks.some((item) => item.name === 'pi_cli' && item.skipped === true));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('host live preflight fails closed on an unreviewed OpenCode version', async (t) => {
  if (process.platform === 'win32') return t.skip('shell fixture is Unix-specific');
  const root = await tempRoot('pg-host-preflight-version-');
  try {
    const opencode = await fakeVersionCommand(root, 'opencode', 'opencode 1.18.6');
    const result = runPreflight({ OPENCODE_BIN: opencode, PI_BIN: path.join(root, 'missing-pi') });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    const openCodeCheck = body.checks.find((item) => item.name === 'opencode_cli');
    assert.equal(openCodeCheck.detected_version, '1.18.6');
    assert.equal(openCodeCheck.contract_target_version, '1.18.4');
    assert.equal(openCodeCheck.version_matches_contract_target, false);
    assert.equal(body.failed, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
