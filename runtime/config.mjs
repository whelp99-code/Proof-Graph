import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from '../server/lib/errors.mjs';
import { assertFiniteJson, assertPlainObject, booleanValue, integerValue, rejectUnknownKeys, stringValue, uniqueStrings } from '../server/lib/validate.mjs';

export const DEFAULT_PLATFORM_CONFIG = Object.freeze({
  schema_version: 1,
  default_adapter: 'mock',
  data_dir: '.proofgraph',
  routing: {
    direct: 'mock',
    researcher: 'mock',
    planner: 'mock',
    developer: 'mock',
    verifier: 'mock',
    synthesizer: 'mock',
  },
  kernel: {
    max_orchestration_rounds: 120,
    max_context_nodes: 24,
    max_context_bytes: 512000,
    fail_fast_on_adapter_error: false,
  },
  workspace: {
    enabled: false,
    backend: 'git-worktree',
    require_approval: true,
    root: null,
    require_clean: true,
    allowed_commands: ['npm', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'bun', 'pnpm', 'yarn'],
    command_timeout_ms: 300000,
    max_command_output_bytes: 1000000,
  },
  debugger: {
    enabled: true,
    event_poll_ms: 250,
  },
  adapters: {},
  templates: {},
});

function clone(value) {
  return structuredClone(value);
}

function merge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return clone(overlay);
  const output = { ...(base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {}) };
  for (const [key, value] of Object.entries(overlay)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(output[key], value)
      : clone(value);
  }
  return output;
}

export function normalizePlatformConfig(input = {}, options = {}) {
  assertPlainObject(input, 'config');
  assertFiniteJson(input);
  rejectUnknownKeys(input, Object.keys(DEFAULT_PLATFORM_CONFIG), 'config');
  const merged = merge(DEFAULT_PLATFORM_CONFIG, input);
  if (merged.schema_version !== 1) throw new ValidationError('config.schema_version must be 1');
  const routing = assertPlainObject(merged.routing, 'config.routing');
  for (const [role, adapter] of Object.entries(routing)) {
    stringValue(role, `config.routing.${role}.key`, { min: 1, max: 80 });
    routing[role] = stringValue(adapter, `config.routing.${role}`, { min: 1, max: 80 });
  }
  const kernel = assertPlainObject(merged.kernel, 'config.kernel');
  kernel.max_orchestration_rounds = integerValue(kernel.max_orchestration_rounds, 'config.kernel.max_orchestration_rounds', { min: 1, max: 5000 });
  kernel.max_context_nodes = integerValue(kernel.max_context_nodes, 'config.kernel.max_context_nodes', { min: 1, max: 500 });
  kernel.max_context_bytes = integerValue(kernel.max_context_bytes, 'config.kernel.max_context_bytes', { min: 1024, max: 50_000_000 });
  kernel.fail_fast_on_adapter_error = booleanValue(kernel.fail_fast_on_adapter_error, 'config.kernel.fail_fast_on_adapter_error');
  const workspace = assertPlainObject(merged.workspace, 'config.workspace');
  workspace.enabled = booleanValue(workspace.enabled, 'config.workspace.enabled');
  workspace.backend = stringValue(workspace.backend, 'config.workspace.backend', { min: 1, max: 80 });
  workspace.require_approval = booleanValue(workspace.require_approval, 'config.workspace.require_approval');
  workspace.require_clean = booleanValue(workspace.require_clean, 'config.workspace.require_clean');
  workspace.root = workspace.root == null ? null : stringValue(workspace.root, 'config.workspace.root', { min: 1, max: 4096 });
  workspace.allowed_commands = uniqueStrings(workspace.allowed_commands, 'config.workspace.allowed_commands', { min: 1, max: 64, itemMax: 128 });
  workspace.command_timeout_ms = integerValue(workspace.command_timeout_ms, 'config.workspace.command_timeout_ms', { min: 100, max: 3600000 });
  workspace.max_command_output_bytes = integerValue(workspace.max_command_output_bytes, 'config.workspace.max_command_output_bytes', { min: 1024, max: 10000000 });
  const debuggerConfig = assertPlainObject(merged.debugger, 'config.debugger');
  debuggerConfig.enabled = booleanValue(debuggerConfig.enabled, 'config.debugger.enabled');
  debuggerConfig.event_poll_ms = integerValue(debuggerConfig.event_poll_ms, 'config.debugger.event_poll_ms', { min: 25, max: 60_000 });
  assertPlainObject(merged.adapters, 'config.adapters');
  assertPlainObject(merged.templates, 'config.templates');
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const dataDir = path.isAbsolute(merged.data_dir)
    ? merged.data_dir
    : path.resolve(projectDir, merged.data_dir);
  workspace.root = workspace.root == null ? path.join(options.homeDir ?? os.homedir(), '.proofgraph', 'workspaces') : (path.isAbsolute(workspace.root) ? workspace.root : path.resolve(projectDir, workspace.root));
  return {
    ...merged,
    default_adapter: stringValue(merged.default_adapter, 'config.default_adapter', { min: 1, max: 80 }),
    data_dir: dataDir,
    project_dir: projectDir,
    home_dir: options.homeDir ?? os.homedir(),
  };
}

export async function loadPlatformConfig(options = {}) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const explicit = options.configPath ? path.resolve(options.configPath) : null;
  const candidates = explicit
    ? [explicit]
    : [path.join(projectDir, 'proofgraph.config.json')];
  let data = {};
  let source = null;
  for (const file of candidates) {
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
      source = file;
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) throw new ValidationError(`Invalid JSON config: ${file}`, { cause: error.message });
      throw error;
    }
  }
  const config = normalizePlatformConfig(data, { projectDir, homeDir: options.homeDir });
  return { config, source };
}

export function mergePlatformConfig(base, overlay, options = {}) {
  assertPlainObject(base, 'base config');
  const source = clone(base);
  const derivedProjectDir = source.project_dir;
  const derivedHomeDir = source.home_dir;
  delete source.project_dir;
  delete source.home_dir;
  return normalizePlatformConfig(merge(source, overlay), {
    ...options,
    projectDir: options.projectDir ?? derivedProjectDir,
    homeDir: options.homeDir ?? derivedHomeDir,
  });
}
