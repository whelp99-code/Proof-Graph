#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_CONTRACT_TARGETS } from '../runtime/hosts/compatibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'hosts');
const HOSTS = [
  {
    directory: path.join(ROOT, 'integrations', 'opencode'),
    packageName: '@proofgraph/host-opencode',
    expectedFiles: [
      'bridge-client.mjs',
      'commands/pg-report.md',
      'commands/pg-status.md',
      'commands/pg.md',
      'core.mjs',
      'package.json',
      'plugin.ts',
    ],
  },
  {
    directory: path.join(ROOT, 'integrations', 'pi'),
    packageName: '@proofgraph/host-pi',
    expectedFiles: [
      'bridge-client.mjs',
      'core.mjs',
      'extensions/proofgraph/index.ts',
      'package.json',
    ],
  },
];

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true, mode: 0o700 });
const rootPackage = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const outputs = [];

for (const host of HOSTS) {
  const manifest = JSON.parse(await fs.readFile(path.join(host.directory, 'package.json'), 'utf8'));
  if (manifest.name !== host.packageName) throw new Error(`Unexpected host package name: ${manifest.name}`);
  if (manifest.version !== rootPackage.version) {
    throw new Error(`Host package version mismatch: ${manifest.name}@${manifest.version} != ${rootPackage.version}`);
  }

  if (manifest.name === '@proofgraph/host-opencode') {
    const dependency = HOST_CONTRACT_TARGETS.opencode.dependency;
    if (manifest.dependencies?.[dependency.name] !== dependency.version) {
      throw new Error(`OpenCode host must pin ${dependency.name}@${dependency.version}`);
    }
    if (manifest.proofgraph?.contract_target?.opencode !== HOST_CONTRACT_TARGETS.opencode.cli_version) {
      throw new Error('OpenCode host contract target is not aligned');
    }
  }
  if (manifest.name === '@proofgraph/host-pi') {
    if (manifest.engines?.node !== `>=${HOST_CONTRACT_TARGETS.pi.node_minimum}`) {
      throw new Error(`Pi host requires Node >=${HOST_CONTRACT_TARGETS.pi.node_minimum}`);
    }
    if (manifest.peerDependencies?.['@earendil-works/pi-coding-agent'] !== '*' || manifest.peerDependencies?.typebox !== '*') {
      throw new Error('Pi core imports must remain peer dependencies supplied by Pi');
    }
    if (manifest.proofgraph?.contract_target?.pi !== HOST_CONTRACT_TARGETS.pi.cli_version) {
      throw new Error('Pi host contract target is not aligned');
    }
  }

  const expectedArchive = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
  const result = spawnSync('npm', ['pack', host.directory, '--pack-destination', DIST, '--ignore-scripts', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.status !== 0) throw new Error(`npm pack failed for ${manifest.name}: ${result.stderr || result.stdout}`);

  let packed;
  try { [packed] = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`Cannot parse npm pack output for ${manifest.name}: ${error.message}`); }
  if (!packed?.filename || packed.filename !== expectedArchive) {
    throw new Error(`Unexpected tarball for ${manifest.name}: ${packed?.filename ?? 'missing'}`);
  }

  const actualFiles = (packed.files ?? []).map(row => row.path).sort();
  const expectedFiles = [...host.expectedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Unexpected package contents for ${manifest.name}: ${JSON.stringify(actualFiles)}`);
  }
  if (packed.entryCount !== expectedFiles.length) {
    throw new Error(`Unexpected package entry count for ${manifest.name}: ${packed.entryCount}`);
  }

  const archivePath = path.join(DIST, packed.filename);
  const stat = await fs.stat(archivePath);
  outputs.push({
    name: manifest.name,
    version: manifest.version,
    file: path.relative(ROOT, archivePath),
    bytes: stat.size,
    shasum: packed.shasum,
    integrity: packed.integrity,
    files: actualFiles,
  });
}

process.stdout.write(`${JSON.stringify({ ok: true, outputs }, null, 2)}\n`);
