import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostError } from './base.mjs';
import { HOST_CONTRACT_TARGETS } from './compatibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

const HOST_LAYOUT = Object.freeze({
  opencode: Object.freeze({
    projectRoot: (options) => path.join(path.resolve(options.projectDir ?? process.cwd()), '.opencode'),
    userRoot: (options) => path.join(path.resolve(options.homeDir ?? os.homedir()), '.config', 'opencode'),
  }),
  pi: Object.freeze({
    projectRoot: (options) => path.join(path.resolve(options.projectDir ?? process.cwd()), '.pi'),
    userRoot: (options) => path.join(path.resolve(options.homeDir ?? os.homedir()), '.pi', 'agent'),
  }),
});

function source(...parts) { return path.join(PACKAGE_ROOT, ...parts); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

async function assertNoSymlinkPath(target, stopAt) {
  const root = path.resolve(stopAt);
  let current = path.resolve(target);
  if (current !== root && !current.startsWith(`${root}${path.sep}`)) throw new HostError('Host integration path escapes its installation root');
  const chain = [];
  while (current !== root) { chain.push(current); current = path.dirname(current); }
  chain.push(root);
  for (const item of chain.reverse()) {
    try {
      const stat = await fs.lstat(item);
      if (stat.isSymbolicLink()) throw new HostError(`Refusing host installation through symlink: ${item}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function transformed(file, replacements = []) {
  let content = await fs.readFile(file, 'utf8');
  for (const [from, to] of replacements) content = content.replace(from, to);
  return content;
}

function openCodePackageOperation(root) {
  const dependency = HOST_CONTRACT_TARGETS.opencode.dependency;
  return {
    kind: 'package-json',
    target: path.join(root, 'package.json'),
    dependencies: { [dependency.name]: dependency.version },
  };
}

function managedFiles(host, root) {
  if (host === 'opencode') {
    return [
      openCodePackageOperation(root),
      {
        kind: 'file',
        target: path.join(root, 'plugins', 'proofgraph.ts'),
        source: source('integrations', 'opencode', 'plugin.ts'),
        replacements: [['"./core.mjs"', '"../proofgraph/core.mjs"']],
      },
      { kind: 'file', target: path.join(root, 'proofgraph', 'core.mjs'), source: source('integrations', 'opencode', 'core.mjs') },
      { kind: 'file', target: path.join(root, 'proofgraph', 'bridge-client.mjs'), source: source('integrations', 'opencode', 'bridge-client.mjs') },
      { kind: 'file', target: path.join(root, 'commands', 'pg.md'), source: source('integrations', 'opencode', 'commands', 'pg.md') },
      { kind: 'file', target: path.join(root, 'commands', 'pg-status.md'), source: source('integrations', 'opencode', 'commands', 'pg-status.md') },
      { kind: 'file', target: path.join(root, 'commands', 'pg-report.md'), source: source('integrations', 'opencode', 'commands', 'pg-report.md') },
    ];
  }
  if (host === 'pi') {
    return [
      {
        kind: 'file',
        target: path.join(root, 'extensions', 'proofgraph', 'index.ts'),
        source: source('integrations', 'pi', 'extensions', 'proofgraph', 'index.ts'),
        replacements: [['"../../core.mjs"', '"./core.mjs"']],
      },
      { kind: 'file', target: path.join(root, 'extensions', 'proofgraph', 'core.mjs'), source: source('integrations', 'pi', 'core.mjs') },
      { kind: 'file', target: path.join(root, 'extensions', 'proofgraph', 'bridge-client.mjs'), source: source('integrations', 'pi', 'bridge-client.mjs') },
    ];
  }
  throw new HostError(`Unsupported host: ${host}`);
}

async function targetState(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new HostError(`Refusing to replace host integration symlink: ${target}`);
    if (!stat.isFile()) throw new HostError(`Host integration target is not a regular file: ${target}`);
    return { exists: true, stat, content: await fs.readFile(target, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, stat: null, content: null };
    throw error;
  }
}

function mergePackageJson(existingContent, dependencies, options = {}) {
  let manifest;
  if (existingContent == null) manifest = { private: true, dependencies: {} };
  else {
    try { manifest = JSON.parse(existingContent); }
    catch (error) { throw new HostError(`Cannot parse host package.json: ${error.message}`); }
    if (!plainObject(manifest)) throw new HostError('Host package.json must contain a JSON object');
  }
  if (manifest.dependencies == null) manifest.dependencies = {};
  if (!plainObject(manifest.dependencies)) throw new HostError('Host package.json dependencies must be an object');
  for (const [name, version] of Object.entries(dependencies)) {
    const current = manifest.dependencies[name];
    if (current != null && current !== version && options.force !== true) {
      throw new HostError(`Host package dependency conflict for ${name}: ${current} != ${version}; use --force to replace it`);
    }
    manifest.dependencies[name] = version;
  }
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function prepareOperation(operation, plan, options) {
  await assertNoSymlinkPath(path.dirname(operation.target), plan.root);
  const state = await targetState(operation.target);
  if (operation.kind === 'package-json') {
    const content = mergePackageJson(state.content, operation.dependencies, options);
    return { ...operation, ...state, content, unchanged: state.exists && state.content === content };
  }
  if (state.exists && options.force !== true) throw new HostError(`Host integration already exists: ${operation.target}`);
  const content = await transformed(operation.source, operation.replacements ?? []);
  return { ...operation, ...state, content, unchanged: state.exists && state.content === content };
}

async function stageOperations(prepared) {
  const staged = [];
  try {
    for (const [index, operation] of prepared.entries()) {
      if (operation.unchanged) { staged.push({ ...operation, temp: null }); continue; }
      await fs.mkdir(path.dirname(operation.target), { recursive: true, mode: 0o700 });
      const temp = `${operation.target}.tmp-${process.pid}-${Date.now()}-${index}`;
      const mode = operation.stat ? operation.stat.mode & 0o777 : 0o600;
      await fs.writeFile(temp, operation.content, { mode, flag: 'wx' });
      staged.push({ ...operation, temp });
    }
    return staged;
  } catch (error) {
    await Promise.all(staged.filter((item) => item.temp).map((item) => fs.rm(item.temp, { force: true }).catch(() => null)));
    throw error;
  }
}

async function commitOperations(staged) {
  const committed = [];
  try {
    for (const [index, operation] of staged.entries()) {
      if (operation.unchanged) continue;
      const backup = operation.exists
        ? `${operation.target}.bak-${process.pid}-${Date.now()}-${index}`
        : null;
      if (backup) await fs.rename(operation.target, backup);
      try {
        await fs.rename(operation.temp, operation.target);
      } catch (error) {
        if (backup) await fs.rename(backup, operation.target).catch(() => null);
        throw error;
      }
      committed.push({ ...operation, backup });
    }
  } catch (error) {
    for (const operation of [...committed].reverse()) {
      await fs.rm(operation.target, { force: true }).catch(() => null);
      if (operation.backup) await fs.rename(operation.backup, operation.target).catch(() => null);
    }
    await Promise.all(staged.filter((item) => item.temp).map((item) => fs.rm(item.temp, { force: true }).catch(() => null)));
    throw error;
  }
  await Promise.all(committed.filter((item) => item.backup).map((item) => fs.rm(item.backup, { force: true }).catch(() => null)));
  return committed;
}

export function hostInstallRoot(host, options = {}) {
  const layout = HOST_LAYOUT[host];
  if (!layout) throw new HostError(`Unsupported host: ${host}`);
  const scope = options.scope ?? 'project';
  if (!['project', 'user'].includes(scope)) throw new HostError('Host installation scope must be project or user');
  return { host, scope, root: scope === 'project' ? layout.projectRoot(options) : layout.userRoot(options) };
}

export function hostInstallPath(host, options = {}) {
  const plan = hostInstallPlan(host, options);
  return {
    host: plan.host,
    scope: plan.scope,
    mode: plan.mode,
    root: plan.root,
    target: plan.files.find((item) => item.kind === 'file')?.target ?? plan.root,
    files: plan.files.map((file) => ({ kind: file.kind, source: file.source ?? null, target: file.target })),
  };
}

export function hostInstallPlan(host, options = {}) {
  const { root, scope } = hostInstallRoot(host, options);
  const mode = options.mode ?? 'managed';
  if (mode !== 'managed') throw new HostError('Host installation mode must be managed');
  const files = managedFiles(host, root);
  const unique = new Set(files.map((item) => item.target));
  if (unique.size !== files.length) throw new HostError('Host installation plan contains duplicate targets');
  return { host, scope, mode, root, files: files.map((item) => ({ ...item })) };
}

export async function installHostIntegration(host, options = {}) {
  const plan = hostInstallPlan(host, options);
  await assertNoSymlinkPath(plan.root, plan.root);
  const prepared = [];
  for (const operation of plan.files) prepared.push(await prepareOperation(operation, plan, options));
  const staged = await stageOperations(prepared);
  await commitOperations(staged);
  const updated = staged.filter((item) => !item.unchanged).map((item) => item.target);
  const unchanged = staged.filter((item) => item.unchanged).map((item) => item.target);
  return {
    ok: true,
    host,
    scope: plan.scope,
    mode: plan.mode,
    root: plan.root,
    entry: plan.files.find((item) => item.kind === 'file')?.target ?? plan.root,
    installed: plan.files.map((file) => file.target),
    files: plan.files.map((file) => file.target),
    updated,
    unchanged,
    environment: ['PROOFGRAPH_HOST_URL', 'PROOFGRAPH_HOST_TOKEN'],
    next_steps: host === 'opencode'
      ? ['Start OpenCode once so it can install the pinned local plugin dependency from package.json.']
      : ['Restart Pi or run /reload so the extension is discovered.'],
  };
}

export function listHostIntegrations(options = {}) {
  return Object.keys(HOST_LAYOUT).map((host) => {
    const project = hostInstallRoot(host, { ...options, scope: 'project' });
    const user = hostInstallRoot(host, { ...options, scope: 'user' });
    return { host, project_root: project.root, user_root: user.root, modes: ['managed'] };
  });
}
