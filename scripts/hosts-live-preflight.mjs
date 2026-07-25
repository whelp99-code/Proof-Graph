#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOST_CONTRACT_TARGETS,
  extractSemanticVersion,
  meetsMinimumVersion,
} from '../runtime/hosts/compatibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
const checks = [];

function command(name, argv = ['--version']) {
  const result = spawnSync(name, argv, { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
  if (result.error?.code === 'ENOENT') return { installed: false, skipped: true, reason: `${name} is not installed` };
  const stdout = String(result.stdout ?? '').trim().slice(0, 2000);
  const stderr = String(result.stderr ?? '').trim().slice(0, 2000);
  return {
    installed: true,
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
    detected_version: extractSemanticVersion(`${stdout}\n${stderr}`),
  };
}

const cliResults = {};
for (const [host, executable] of [['opencode', process.env.OPENCODE_BIN ?? 'opencode'], ['pi', process.env.PI_BIN ?? 'pi']]) {
  const target = HOST_CONTRACT_TARGETS[host].cli_version;
  const result = command(executable);
  cliResults[host] = result;
  const versionMatches = result.skipped ? null : result.detected_version === target;
  checks.push({
    ...result,
    name: `${host}_cli`,
    host,
    executable,
    contract_target_version: target,
    version_matches_contract_target: versionMatches,
    ok: result.skipped || (result.ok && versionMatches === true),
    ...(result.installed && !result.detected_version ? { reason: `${host} version could not be parsed` } : {}),
  });
}

if (cliResults.pi?.skipped) {
  checks.push({
    name: 'pi_node_runtime',
    host: 'pi',
    ok: true,
    skipped: true,
    reason: 'Pi is not installed; Pi-specific Node runtime gate was not exercised',
    actual: process.versions.node,
    required: HOST_CONTRACT_TARGETS.pi.node_minimum,
  });
} else {
  const supported = meetsMinimumVersion(process.versions.node, HOST_CONTRACT_TARGETS.pi.node_minimum);
  checks.push({
    name: 'pi_node_runtime',
    host: 'pi',
    ok: supported === true,
    skipped: false,
    actual: process.versions.node,
    required: HOST_CONTRACT_TARGETS.pi.node_minimum,
  });
}

const required = [
  'runtime/hosts/protocol.mjs', 'runtime/hosts/bridge-server.mjs', 'runtime/hosts/compatibility.mjs',
  'integrations/opencode/plugin.ts', 'integrations/opencode/core.mjs', 'integrations/opencode/bridge-client.mjs',
  'integrations/pi/extensions/proofgraph/index.ts', 'integrations/pi/core.mjs', 'integrations/pi/bridge-client.mjs',
];
const missing = [];
for (const rel of required) { try { await fs.access(path.join(ROOT, rel)); } catch { missing.push(rel); } }
checks.push({ name: 'host_integration_sources', ok: missing.length === 0, missing });

try {
  const opencodePackage = JSON.parse(await fs.readFile(path.join(ROOT, 'integrations', 'opencode', 'package.json'), 'utf8'));
  const piPackage = JSON.parse(await fs.readFile(path.join(ROOT, 'integrations', 'pi', 'package.json'), 'utf8'));
  const opencodeDependency = HOST_CONTRACT_TARGETS.opencode.dependency;
  checks.push({
    name: 'host_contract_manifests',
    ok: opencodePackage.dependencies?.[opencodeDependency.name] === opencodeDependency.version
      && opencodePackage.proofgraph?.contract_target?.opencode === HOST_CONTRACT_TARGETS.opencode.cli_version
      && piPackage.proofgraph?.contract_target?.pi === HOST_CONTRACT_TARGETS.pi.cli_version
      && piPackage.engines?.node === `>=${HOST_CONTRACT_TARGETS.pi.node_minimum}`
      && piPackage.peerDependencies?.['@earendil-works/pi-coding-agent'] === '*'
      && piPackage.peerDependencies?.typebox === '*',
    opencode_dependency: opencodePackage.dependencies?.[opencodeDependency.name] ?? null,
    opencode_target: opencodePackage.proofgraph?.contract_target ?? null,
    pi_target: piPackage.proofgraph?.contract_target ?? null,
    pi_node: piPackage.engines?.node ?? null,
  });
} catch (error) {
  checks.push({ name: 'host_contract_manifests', ok: false, error: error.message });
}

let server = null;
const serverUrl = process.env.OPENCODE_SERVER_URL;
if (!serverUrl) checks.push({ name: 'opencode_server_health', ok: true, skipped: true, reason: 'OPENCODE_SERVER_URL is not configured' });
else {
  try {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
    const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
    const headers = password ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
    const response = await fetch(new URL('/global/health', serverUrl), { headers, signal: AbortSignal.timeout(10_000) });
    server = await response.json().catch(() => null);
    const detected = extractSemanticVersion(server?.version);
    checks.push({
      name: 'opencode_server_health',
      ok: response.ok && server?.healthy === true && detected === HOST_CONTRACT_TARGETS.opencode.cli_version,
      status: response.status,
      server,
      detected_version: detected,
      contract_target_version: HOST_CONTRACT_TARGETS.opencode.cli_version,
      version_matches_contract_target: detected === HOST_CONTRACT_TARGETS.opencode.cli_version,
    });
  } catch (error) { checks.push({ name: 'opencode_server_health', ok: false, error: error.message }); }
}

const result = {
  product: 'proofgraph',
  check: 'opencode-pi-live-preflight',
  generated_at: new Date().toISOString(),
  contract_targets: HOST_CONTRACT_TARGETS,
  passed: checks.filter((item) => item.ok && !item.skipped).length,
  failed: checks.filter((item) => !item.ok).length,
  skipped: checks.filter((item) => item.skipped).length,
  total: checks.length,
  live_canary_required: checks.some((item) => item.skipped),
  checks,
};
if (outputPath) { await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`); }
console.log(JSON.stringify(result, null, 2));
if (result.failed) process.exitCode = 1;
