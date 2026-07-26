#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
const findings = [];
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
    if (stat.isSymbolicLink()) { findings.push({ type: 'symlink', path: relative }); continue; }
    if (stat.isDirectory()) output.push(...await walk(absolute));
    else if (stat.isFile()) {
      const bytes = await fs.readFile(absolute);
      output.push({ path: relative, bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), executable: Boolean(stat.mode & 0o111) });
    }
  }
  return output;
}
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'BUILD_MANIFEST.json'), 'utf8'));
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
if (manifest.version !== pkg.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || manifest.product !== pkg.name) findings.push({ type: 'version_mismatch' });
const copy = structuredClone(manifest); const digest = copy.manifest_digest; delete copy.manifest_digest;
if (digest !== crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')) findings.push({ type: 'manifest_digest_mismatch' });
const actual = await walk(ROOT);
const expectedMap = new Map(manifest.files.map((item) => [item.path, item]));
const actualMap = new Map(actual.map((item) => [item.path, item]));
for (const [file, expected] of expectedMap) {
  const item = actualMap.get(file);
  if (!item) findings.push({ type: 'missing_file', path: file });
  else if (item.sha256 !== expected.sha256 || item.bytes !== expected.bytes || item.executable !== expected.executable) findings.push({ type: 'file_mismatch', path: file, expected, actual: item });
}
for (const file of actualMap.keys()) if (!expectedMap.has(file)) findings.push({ type: 'unexpected_file', path: file });
const secretPatterns = [
  new RegExp('ghp_' + '[A-Za-z0-9]{30,}'), new RegExp('github_pat_' + '[A-Za-z0-9_]{30,}'),
  new RegExp('sk-ant-' + '[A-Za-z0-9_-]{20,}'), new RegExp('sk-proj-' + '[A-Za-z0-9_-]{20,}'),
  new RegExp('AKIA' + '[A-Z0-9]{16}'), new RegExp('xox[baprs]-' + '[A-Za-z0-9-]{20,}'),
  new RegExp('BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY'),
];
for (const item of actual) {
  if (item.bytes > 5_000_000) continue;
  const text = await fs.readFile(path.join(ROOT, item.path), 'utf8').catch(() => null);
  if (text == null) continue;
  for (const pattern of secretPatterns) if (pattern.test(text)) findings.push({ type: 'secret_pattern', path: item.path, pattern: pattern.source });
}
const report = { schema_version: 2, version: pkg.version, manifested_files: manifest.files.length, actual_files: actual.length, findings, passed: findings.length === 0 };
report.digest = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
const output = path.join(ROOT, 'verification', 'package-verification.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ passed: report.passed, manifested_files: report.manifested_files, actual_files: report.actual_files, findings: report.findings.length, output }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
