#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELEASE_GATE, BASELINE_VERSION, HOST_BASELINE_VERSION } from '../runtime/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_FILES = new Set([
  'BUILD_MANIFEST.json',
  'verification/package-verification.json',
  'verification/preflight-results.json',
  'verification/independent-results.json',
  'verification/operator-independent-results.json',
  'verification/intelligence-independent-results.json',
  'verification/standalone-independent-results.json',
  'verification/coverage.txt',
  'verification/coverage-runtime.txt',
  'verification/COVERAGE_SUMMARY.json',
  'verification/OPERATOR_BENCHMARK.json',
]);
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.proofgraph-org', '__pycache__']);
async function walk(dir) {
  const output = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
    if (EXCLUDED_FILES.has(relative)) continue;
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in build manifest: ${relative}`);
    if (stat.isDirectory()) output.push(...await walk(absolute));
    else if (stat.isFile()) {
      const bytes = await fs.readFile(absolute);
      output.push({ path: relative, bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), executable: Boolean(stat.mode & 0o111) });
    }
  }
  return output;
}
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const entries = await walk(ROOT);
const manifest = {
  schema_version: 2,
  product: pkg.name,
  version: pkg.version,
  baseline: BASELINE_VERSION,
  host_baseline: HOST_BASELINE_VERSION,
  release_gate: RELEASE_GATE,
  file_count: entries.length,
  files: entries,
};
manifest.manifest_digest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
await fs.writeFile(path.join(ROOT, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ file_count: manifest.file_count, manifest_digest: manifest.manifest_digest }, null, 2)}\n`);
