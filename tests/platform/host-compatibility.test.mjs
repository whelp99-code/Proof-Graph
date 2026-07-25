import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CONTRACT_TARGETS,
  extractSemanticVersion,
  compareSemanticVersions,
  meetsMinimumVersion,
} from '../../runtime/hosts/compatibility.mjs';
import { listHosts } from '../../runtime/hosts/catalog.mjs';

test('host contract targets pin the reviewed OpenCode and Pi integration surfaces', () => {
  assert.equal(HOST_CONTRACT_TARGETS.opencode.cli_version, '1.18.4');
  assert.equal(HOST_CONTRACT_TARGETS.opencode.plugin_version, '1.18.4');
  assert.deepEqual(HOST_CONTRACT_TARGETS.opencode.dependency, { name: '@opencode-ai/plugin', version: '1.18.4' });
  assert.equal(HOST_CONTRACT_TARGETS.pi.cli_version, '0.82.0');
  assert.equal(HOST_CONTRACT_TARGETS.pi.node_minimum, '22.19.0');
});

test('semantic version extraction accepts common CLI output and rejects incomplete values', () => {
  assert.equal(extractSemanticVersion('opencode 1.18.4'), '1.18.4');
  assert.equal(extractSemanticVersion('pi v0.82.0\n'), '0.82.0');
  assert.equal(extractSemanticVersion('version: 1.18.4-beta.1'), '1.18.4');
  assert.equal(extractSemanticVersion('1.18'), null);
  assert.equal(extractSemanticVersion('unknown'), null);
});

test('semantic version comparison and minimum checks are deterministic', () => {
  assert.equal(compareSemanticVersions('1.18.4', '1.18.4'), 0);
  assert.equal(compareSemanticVersions('1.18.6', '1.18.4'), 1);
  assert.equal(compareSemanticVersions('1.17.9', '1.18.4'), -1);
  assert.equal(compareSemanticVersions('invalid', '1.18.4'), null);
  assert.equal(meetsMinimumVersion('v22.19.0', '22.19.0'), true);
  assert.equal(meetsMinimumVersion('v22.18.0', '22.19.0'), false);
});

test('host catalog exposes reviewed contract targets without claiming live certification', () => {
  const hosts = Object.fromEntries(listHosts().map((host) => [host.name, host]));
  assert.equal(hosts.opencode.contract_target.cli_version, '1.18.4');
  assert.equal(hosts.pi.contract_target.cli_version, '0.82.0');
  assert.equal(hosts.opencode.minimum_version, null);
  assert.equal(hosts.pi.minimum_version, null);
  assert.equal(hosts.opencode.live_canary_required, true);
  assert.equal(hosts.pi.live_canary_required, true);
});
