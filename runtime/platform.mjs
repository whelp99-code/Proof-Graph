import path from 'node:path';
import { createBuiltInRegistry } from './adapters/profiles.mjs';
import { loadPlatformConfig, mergePlatformConfig } from './config.mjs';
import { DebuggerController } from './debugger/controller.mjs';
import { ProofGraphKernel } from './kernel.mjs';
import { createTemplateRegistry } from './templates/registry.mjs';
import { WorkspaceEngine } from './workspace/engine.mjs';

export async function createPlatform(options = {}) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const loaded = await loadPlatformConfig({ projectDir, configPath: options.configPath });
  const config = mergePlatformConfig(loaded.config, options.overrides ?? {}, { projectDir });
  const registry = createBuiltInRegistry(config, { extraAdapters: options.extraAdapters });
  const workspace = config.workspace.enabled ? new WorkspaceEngine({
    projectDir: config.project_dir,
    dataDir: config.data_dir,
    rootDir: config.workspace.root,
    requireClean: config.workspace.require_clean,
    allowedCommands: config.workspace.allowed_commands,
    defaultCommandTimeoutMs: config.workspace.command_timeout_ms,
    maxCommandOutputBytes: config.workspace.max_command_output_bytes,
  }) : null;
  const debuggerController = new DebuggerController({ dataDir: config.data_dir, enabled: config.debugger.enabled });
  const templates = createTemplateRegistry({ ...(config.templates ?? {}), ...(options.templates ?? {}) });
  const kernel = new ProofGraphKernel({ config, registry, workspace, debuggerController });
  return { config, source: loaded.source, registry, workspace, debuggerController, templates, kernel };
}
