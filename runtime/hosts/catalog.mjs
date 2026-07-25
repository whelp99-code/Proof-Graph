import { ValidationError } from '../../server/lib/errors.mjs';
import { identifier } from '../../server/lib/validate.mjs';
import { HOST_CONTRACT_TARGETS } from './compatibility.mjs';

const HOSTS = Object.freeze({
  opencode: Object.freeze({
    name: 'opencode',
    display_name: 'OpenCode',
    priority: 1,
    integration: 'plugin+http+sse',
    install_targets: ['project', 'user'],
    runtime_surfaces: ['plugin', 'server', 'sdk', 'sse', 'custom-tool', 'custom-command'],
    capabilities: [
      'commands', 'custom_tools', 'event_stream', 'permission_projection',
      'session_mapping', 'diff_artifacts', 'tui_projection', 'headless_execution',
    ],
    minimum_version: null,
    contract_target: structuredClone(HOST_CONTRACT_TARGETS.opencode),
    version_policy: 'pin-after-live-canary',
    live_canary_required: true,
  }),
  pi: Object.freeze({
    name: 'pi',
    display_name: 'Pi',
    priority: 2,
    integration: 'extension+jsonl-rpc',
    install_targets: ['project', 'user'],
    runtime_surfaces: ['extension', 'rpc', 'sdk', 'custom-command', 'custom-tool', 'custom-ui'],
    capabilities: [
      'commands', 'custom_tools', 'event_interception', 'session_persistence',
      'jsonl_rpc', 'approval_projection', 'custom_tui', 'headless_execution',
    ],
    minimum_version: null,
    contract_target: structuredClone(HOST_CONTRACT_TARGETS.pi),
    version_policy: 'pin-after-live-canary',
    live_canary_required: true,
  }),
  orca: Object.freeze({
    name: 'orca',
    display_name: 'Orca',
    priority: 3,
    integration: 'cli+custom-agent',
    install_targets: ['project'],
    runtime_surfaces: ['cli', 'worktree', 'terminal'],
    capabilities: ['worktree', 'terminal', 'diff', 'desktop_projection'],
    minimum_version: null,
    version_policy: 'pin-and-canary',
    live_canary_required: true,
  }),
});

export function listHosts() {
  return Object.values(HOSTS)
    .map((host) => structuredClone(host))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

export function getHost(name) {
  const id = identifier(name, 'host name');
  const host = HOSTS[id];
  if (!host) throw new ValidationError(`Unsupported host: ${id}`);
  return structuredClone(host);
}
