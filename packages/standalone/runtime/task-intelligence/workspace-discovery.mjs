import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { ValidationError } from '../core/errors.mjs';

const IGNORE = new Set(['.git', 'node_modules', '.proofgraph', 'dist', 'build', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv']);
const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.rb': 'ruby',
  '.php': 'php', '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp', '.swift': 'swift',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.sql': 'sql', '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
});

function addCount(record, key, amount = 1) { record[key] = (record[key] ?? 0) + amount; }

export async function discoverWorkspace(root, options = {}) {
  const maxFiles = options.maxFiles ?? 2500;
  const maxDepth = options.maxDepth ?? 8;
  const maxReadBytes = options.maxReadBytes ?? 2_000_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new ValidationError('maxFiles must be 1..100000');
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new ValidationError('maxDepth must be 0..32');
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ValidationError('Workspace root must be a real directory');
  const realRoot = await fs.realpath(absoluteRoot);
  const files = [];
  const languages = Object.create(null);
  const manifests = [];
  const packageManagers = new Set();
  const frameworks = new Set();
  let totalBytes = 0;
  let truncated = false;
  const queue = [{ dir: realRoot, depth: 0 }];

  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(realRoot, absolute).replaceAll('\\', '/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      files.push({ path: relative, bytes: stat.size });
      totalBytes += stat.size;
      const ext = path.extname(entry.name).toLowerCase();
      if (LANGUAGE_BY_EXT[ext]) addCount(languages, LANGUAGE_BY_EXT[ext]);
      if (['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'].includes(entry.name)) manifests.push(relative);
      if (entry.name === 'package-lock.json') packageManagers.add('npm');
      if (entry.name === 'pnpm-lock.yaml') packageManagers.add('pnpm');
      if (entry.name === 'yarn.lock') packageManagers.add('yarn');
      if (entry.name === 'bun.lock' || entry.name === 'bun.lockb') packageManagers.add('bun');
      if (entry.name === 'poetry.lock') packageManagers.add('poetry');
      if (entry.name === 'uv.lock') packageManagers.add('uv');
      if (entry.name === 'Cargo.lock') packageManagers.add('cargo');
      if (files.length >= maxFiles) { truncated = true; break; }
    }
  }

  const readableManifests = Object.create(null);
  let readBytes = 0;
  for (const relative of manifests.slice(0, 30)) {
    const absolute = path.join(realRoot, relative);
    const stat = await fs.stat(absolute);
    if (stat.size > 500_000 || readBytes + stat.size > maxReadBytes) continue;
    const content = await fs.readFile(absolute, 'utf8');
    readableManifests[relative] = content.slice(0, 500_000);
    readBytes += Buffer.byteLength(content);
    const lower = content.toLowerCase();
    for (const [needle, name] of [['next', 'nextjs'], ['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'], ['express', 'express'], ['fastify', 'fastify'], ['django', 'django'], ['flask', 'flask'], ['fastapi', 'fastapi'], ['spring', 'spring'], ['rails', 'rails']]) {
      if (lower.includes(needle)) frameworks.add(name);
    }
  }

  const summary = {
    schema_version: 1,
    root_name: path.basename(realRoot),
    file_count: files.length,
    total_bytes: totalBytes,
    truncated,
    languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    manifests: manifests.sort(),
    package_managers: [...packageManagers].sort(),
    frameworks: [...frameworks].sort(),
    sample_files: files.slice(0, 200),
  };
  summary.digest = sha256(summary);
  return summary;
}
