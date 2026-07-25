import fs from 'node:fs/promises';
import path from 'node:path';
import { SecurityError, StateError, ValidationError } from '../server/lib/errors.mjs';

export const PROJECT_CONFIG = Object.freeze({
  schema_version: 1,
  default_adapter: 'mock',
  data_dir: '.proofgraph',
  routing: {
    direct: 'mock', researcher: 'mock', planner: 'mock', developer: 'mock', verifier: 'mock', synthesizer: 'mock',
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
    require_clean: true,
    allowed_commands: ['npm', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'bun', 'pnpm', 'yarn'],
    command_timeout_ms: 300000,
    max_command_output_bytes: 1000000,
  },
  debugger: { enabled: true, event_poll_ms: 250 },
  adapters: {},
  templates: {},
});

export async function initializeProject(target, options = {}) {
  const projectDir = path.resolve(target ?? process.cwd());
  await fs.mkdir(projectDir, { recursive: true });
  const configPath = path.join(projectDir, 'proofgraph.config.json');
  const dataDir = path.join(projectDir, '.proofgraph');
  let existed = false;
  try {
    const stat = await fs.lstat(configPath);
    if (stat.isSymbolicLink()) throw new SecurityError('Refusing to initialize through a symbolic-link proofgraph.config.json');
    existed = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const stat = await fs.lstat(dataDir);
    if (stat.isSymbolicLink()) throw new SecurityError('Refusing to initialize through a symbolic-link .proofgraph directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existed && options.force !== true) throw new StateError('proofgraph.config.json already exists; use --force to replace it');
  if (options.config !== undefined && (!options.config || typeof options.config !== 'object' || Array.isArray(options.config))) throw new ValidationError('init config must be an object');
  const config = options.config ? { ...structuredClone(PROJECT_CONFIG), ...structuredClone(options.config) } : structuredClone(PROJECT_CONFIG);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: options.force === true ? 'w' : 'wx', mode: 0o600 });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDir, '.gitignore'), '*\n!.gitignore\n', { mode: 0o600 });
  return { ok: true, project_dir: projectDir, config_path: configPath, data_dir: dataDir, replaced: existed && options.force === true };
}
