#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'BUILD_MANIFEST.json');
const writeMode = process.argv.includes('--write');
const excludedExact = new Set(['BUILD_MANIFEST.json']);
const excludedPrefixes = ['.git/', '.proofgraph/', '.opencode/', '.pi/', 'node_modules/', 'packages/', 'verification/tmp/', 'dist/'];

function shouldInclude(rel) {
  const posix = rel.split(path.sep).join('/');
  if (excludedExact.has(posix)) return false;
  if (excludedPrefixes.some(prefix => posix.startsWith(prefix))) return false;
  // Raw test transcripts are transient and excluded. Final JSON evidence is manifested;
  // repeated CI results are written under verification/tmp/, which is excluded above.
  if (posix.startsWith('verification/') && /\.txt$/i.test(posix)) return false;
  return true;
}
async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (!shouldInclude(rel)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not permitted in the release package: ${rel}`);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
async function inventory() {
  const files = (await walk(ROOT)).sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (const file of files) {
    const body = await fs.readFile(file);
    rows.push({ path: path.relative(ROOT, file).split(path.sep).join('/'), bytes: body.length, sha256: hash(body) });
  }
  return rows;
}
function scanSecrets(entries) {
  const findings = [];
  const patterns = [
    { name: 'anthropic_api_key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { name: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
    { name: 'generic_secret_assignment', regex: /(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\s*[:=]\s*['"]?(?!<|\$\{|example|placeholder)[A-Za-z0-9_\-]{16,}/gi },
  ];
  return Promise.all(entries.filter(e => /\.(?:mjs|js|json|md|sh|ps1|txt)$/i.test(e.path)).map(async entry => {
    const text = await fs.readFile(path.join(ROOT, entry.path), 'utf8');
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) findings.push({ path: entry.path, type: pattern.name });
    }
  })).then(() => findings);
}

const entries = await inventory();
if (writeMode) {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    schema_version: 1,
    product: pkg.name,
    version: pkg.version,
    generated_at: new Date().toISOString(),
    file_count: entries.length,
    files: entries,
  };
  await fs.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`WROTE ${path.relative(ROOT, MANIFEST)} (${entries.length} files)`);
  process.exit(0);
}

let stored;
try { stored = JSON.parse(await fs.readFile(MANIFEST, 'utf8')); }
catch (error) { console.error(`FAIL missing or invalid BUILD_MANIFEST.json: ${error.message}`); process.exit(1); }
const expected = new Map(stored.files.map(e => [e.path, e]));
const actual = new Map(entries.map(e => [e.path, e]));
const failures = [];
for (const [name, row] of expected) {
  const got = actual.get(name);
  if (!got) failures.push({ path: name, issue: 'missing' });
  else if (got.sha256 !== row.sha256 || got.bytes !== row.bytes) failures.push({ path: name, issue: 'hash_or_size_mismatch', expected: row, actual: got });
}
for (const name of actual.keys()) if (!expected.has(name)) failures.push({ path: name, issue: 'unexpected' });
const secrets = await scanSecrets(entries);
for (const finding of secrets) failures.push({ ...finding, issue: 'secret_pattern' });
const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const pluginJson = JSON.parse(await fs.readFile(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
if (packageJson.version !== stored.version || pluginJson.version !== stored.version) failures.push({ issue: 'version_mismatch', manifest: stored.version, package: packageJson.version, plugin: pluginJson.version });
const result = { ok: failures.length === 0, expected_files: expected.size, actual_files: actual.size, secret_findings: secrets.length, failures };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
