import { MockAdapter } from './mock.mjs';
import { AdapterRegistry } from './registry.mjs';
import { SubprocessAdapter } from './subprocess.mjs';
import { PiRpcAdapter } from './pi-rpc.mjs';
import { OpenCodeServerAdapter } from './opencode-server.mjs';
import { OrcaAdapter } from './orca.mjs';
import { ConfiguredExtensionAdapter } from './unavailable.mjs';
import { ValidationError } from '../../server/lib/errors.mjs';

const ROLES = ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'];

function manifest(name, overrides = {}) {
  return {
    agent_id: `proofgraph.${name}`,
    adapter: name,
    roles: ROLES,
    capabilities: ['structured_output', 'headless'],
    timeout_ms: 300_000,
    max_output_bytes: 512_000,
    ...overrides,
  };
}

function settings(config, name) {
  const value = config.adapters?.[name] ?? {};
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function modelArgs(request, flag = '--model') {
  const model = request.node?.model ?? request.metadata?.model ?? null;
  return model ? [flag, String(model)] : [];
}

function stringArgs(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Array.isArray(selected) || selected.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new ValidationError(`${label} must be an array of non-empty strings`);
  }
  return [...selected];
}

function booleanSetting(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be a boolean`);
  return value;
}

export function createBuiltInRegistry(config, options = {}) {
  const registry = new AdapterRegistry();
  registry.register('mock', new MockAdapter(manifest('mock', { timeout_ms: 30_000, max_output_bytes: 256_000 })));

  const claude = settings(config, 'claude');
  registry.register('claude', new SubprocessAdapter(manifest('claude', { model_tiers: claude.model_tiers ?? {} }), {
    command: claude.command ?? 'claude', enabled: claude.enabled ?? false, env: claude.env,
    liveCanaryRequired: true, hostToolRisk: false, cwd: config.project_dir,
    buildInvocation: (request) => ({
      args: [
        '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', String(claude.max_turns ?? 12),
        '--disallowedTools', 'Write,Edit,NotebookEdit,Bash', ...modelArgs(request),
        ...stringArgs(claude.extra_args, [], 'adapters.claude.extra_args'), '-p', request.prompt,
      ],
    }),
  }));

  const codex = settings(config, 'codex');
  registry.register('codex', new SubprocessAdapter(manifest('codex', { model_tiers: codex.model_tiers ?? {} }), {
    command: codex.command ?? 'codex', enabled: codex.enabled ?? false, env: codex.env,
    liveCanaryRequired: true, hostToolRisk: false, cwd: config.project_dir,
    buildInvocation: (request) => ({
      args: [
        'exec',
        ...stringArgs(codex.output_args, ['--json'], 'adapters.codex.output_args'),
        '--sandbox', String(codex.sandbox ?? 'read-only'),
        ...(booleanSetting(codex.skip_git_repo_check, true, 'adapters.codex.skip_git_repo_check') ? ['--skip-git-repo-check'] : []),
        ...modelArgs(request, '--model'),
        ...stringArgs(codex.extra_args, [], 'adapters.codex.extra_args'),
        request.prompt,
      ],
    }),
  }));

  const opencode = settings(config, 'opencode');
  const opencodeTransport = opencode.transport ?? (opencode.command ? 'subprocess' : 'server');
  if (!['server', 'subprocess'].includes(opencodeTransport)) {
    throw new ValidationError('adapters.opencode.transport must be server or subprocess');
  }
  const opencodeManifest = manifest('opencode', {
    model_tiers: opencode.model_tiers ?? {},
    capabilities: opencodeTransport === 'server'
      ? ['structured_output', 'headless', 'server_api', 'sse', 'permission_bridge', 'tui_host']
      : ['structured_output', 'headless'],
  });
  if (opencodeTransport === 'server') {
    const passwordEnv = opencode.password_env ?? 'OPENCODE_SERVER_PASSWORD';
    const password = opencode.password ?? process.env[passwordEnv] ?? null;
    registry.register('opencode', new OpenCodeServerAdapter(opencodeManifest, {
      enabled: opencode.enabled ?? false,
      baseUrl: opencode.server_url ?? 'http://127.0.0.1:4096',
      username: opencode.username ?? process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
      password,
      timeoutMs: opencode.timeout_ms ?? 300_000,
      maxResponseBytes: opencode.max_response_bytes ?? 2_000_000,
      allowRemote: opencode.allow_remote ?? false,
      allowInsecureRemote: opencode.allow_insecure_remote ?? false,
      allowHostTools: opencode.allow_host_tools ?? false,
      requireIsolatedWorkspace: opencode.require_isolated_workspace ?? true,
      keepSessions: opencode.keep_sessions ?? true,
      pureWorkerConfirmed: opencode.pure_worker_confirmed ?? false,
      maxMessages: opencode.max_messages ?? 50,
      agentMap: opencode.agent_map ?? {},
      model: opencode.model ?? null,
    }));
  } else {
    registry.register('opencode', new SubprocessAdapter(opencodeManifest, {
      command: opencode.command ?? 'opencode', enabled: opencode.enabled ?? false, env: opencode.env,
      liveCanaryRequired: true, hostToolRisk: true, allowHostTools: opencode.allow_host_tools ?? false, cwd: config.project_dir,
      buildInvocation: (request) => ({
        args: ['run', '--format', 'json', '--agent', opencode.agent ?? 'plan', '--dir', request.workspace?.path ?? config.project_dir, ...modelArgs(request), request.prompt],
      }),
    }));
  }

  const grok = settings(config, 'grok');
  registry.register('grok', new SubprocessAdapter(manifest('grok', { model_tiers: grok.model_tiers ?? {} }), {
    command: grok.command ?? 'grok', enabled: grok.enabled ?? false, env: grok.env,
    liveCanaryRequired: true, hostToolRisk: true, allowHostTools: grok.allow_host_tools ?? false, cwd: config.project_dir,
    buildInvocation: (request) => ({
      args: [
        '--no-auto-update', '--output-format', 'json',
        '--cwd', request.workspace?.path ?? config.project_dir,
        ...modelArgs(request),
        ...stringArgs(grok.extra_args, [], 'adapters.grok.extra_args'),
        '-p', request.prompt,
      ],
    }),
  }));

  const pi = settings(config, 'pi');
  registry.register('pi', new PiRpcAdapter(manifest('pi', { model_tiers: pi.model_tiers ?? {} }), {
    command: pi.command ?? 'pi', args: pi.args, enabled: pi.enabled ?? false,
    allowHostTools: pi.allow_host_tools ?? false,
    safeTools: pi.safe_tools,
    hostTools: pi.host_tools,
    disableDiscovery: pi.disable_discovery ?? true,
    cwd: config.project_dir, env: pi.env,
    uiPolicy: pi.ui_policy ?? 'deny',
  }));

  const orca = settings(config, 'orca');
  registry.register('orca', new OrcaAdapter(manifest('orca', {
    capabilities: ['structured_output', 'orca_host', 'worktree_isolation', 'orchestration_transport', 'human_gate_projection'],
    model_tiers: orca.model_tiers ?? {},
    timeout_ms: orca.timeout_ms ?? 1_200_000,
    max_output_bytes: orca.max_output_bytes ?? 1_000_000,
  }), {
    command: orca.command ?? 'orca', args: stringArgs(orca.args, [], 'adapters.orca.args'), enabled: orca.enabled ?? false, env: orca.env,
    projectDir: config.project_dir, repoSelector: orca.repo_selector ?? null,
    requireExplicitRepoSelector: orca.require_explicit_repo_selector ?? true,
    manualPermissionsConfirmed: orca.manual_permissions_confirmed ?? false,
    setup: orca.setup ?? 'inherit', coordinatorTerminal: orca.coordinator_terminal ?? null,
    agentMap: orca.agent_map ?? {}, allowedAgents: orca.allowed_agents,
    allowNodeAgentOverride: orca.allow_node_agent_override ?? false,
    allowWorkspaceMutation: orca.allow_workspace_mutation ?? false,
    checkTimeoutMs: orca.check_timeout_ms ?? 900_000,
    terminalWaitMs: orca.terminal_wait_ms ?? 60_000,
    maxCheckpoints: orca.max_checkpoints ?? 2,
    maxSpecBytes: orca.max_spec_bytes ?? 60_000,
    maxReportBytes: orca.max_report_bytes ?? 1_000_000,
    reportDir: orca.report_dir ?? '.proofgraph/orca-results',
    allowInlineResult: orca.allow_inline_result ?? false,
  }));


  const gjc = settings(config, 'gjc');
  if (gjc.command && gjc.args != null) {
    const gjcArgs = stringArgs(gjc.args, [], 'adapters.gjc.args');
    registry.register('gjc', new SubprocessAdapter(manifest('gjc'), {
      command: gjc.command, enabled: gjc.enabled ?? false, env: gjc.env,
      liveCanaryRequired: true, hostToolRisk: true, allowHostTools: gjc.allow_host_tools ?? false, cwd: config.project_dir,
      buildInvocation: (request) => ({ args: gjcArgs.map((value) => value === '{prompt}' ? request.prompt : value === '{cwd}' ? (request.workspace?.path ?? config.project_dir) : value) }),
    }));
  } else {
    registry.register('gjc', new ConfiguredExtensionAdapter(manifest('gjc'), {
      integration: 'gajae-sdk-v3-websocket',
      reason: 'Gajae Code v0.11 removed the external --mode rpc, rpc-ui, and bridge CLI ingress and directs machine clients to SDK v3 WebSocket interfaces. Configure a pinned SDK WebSocket bridge or an explicit trusted command profile; live canary is required.',
    }));
  }

  for (const [name, adapter] of Object.entries(options.extraAdapters ?? {})) registry.register(name, adapter);
  return registry;
}

export function adapterConfigExample() {
  return {
    default_adapter: 'mock',
    adapters: {
      claude: { enabled: false, command: 'claude', extra_args: [] },
      codex: { enabled: false, command: 'codex', output_args: ['--json'], sandbox: 'read-only', skip_git_repo_check: true, extra_args: [] },
      opencode: {
        enabled: false,
        transport: 'server',
        server_url: 'http://127.0.0.1:4096',
        username: 'opencode',
        password_env: 'OPENCODE_SERVER_PASSWORD',
        allow_remote: false,
        allow_insecure_remote: false,
        max_response_bytes: 2000000,
        allow_host_tools: false,
        require_isolated_workspace: true,
        keep_sessions: true,
        pure_worker_confirmed: false,
        agent_map: { direct: 'plan', researcher: 'plan', planner: 'plan', developer: 'plan', verifier: 'plan', synthesizer: 'plan' },
      },
      grok: { enabled: false, command: 'grok', allow_host_tools: false, extra_args: [] },
      pi: {
        enabled: false,
        command: 'pi',
        allow_host_tools: false,
        safe_tools: ['read', 'grep', 'find', 'ls'],
        host_tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
        disable_discovery: true,
        ui_policy: 'deny',
      },
      orca: {
        enabled: false, command: 'orca', args: [], repo_selector: null, require_explicit_repo_selector: true, setup: 'inherit', coordinator_terminal: null,
        agent_map: { direct: 'codex', researcher: 'claude', planner: 'claude', developer: 'codex', verifier: 'claude', synthesizer: 'claude' },
        allowed_agents: ['claude', 'codex'], manual_permissions_confirmed: false, allow_node_agent_override: false, allow_workspace_mutation: false,
        check_timeout_ms: 900000, terminal_wait_ms: 60000, max_checkpoints: 2, report_dir: '.proofgraph/orca-results', allow_inline_result: false,
      },
      gjc: { enabled: false, command: null, args: null, allow_host_tools: false },
    },
  };
}
