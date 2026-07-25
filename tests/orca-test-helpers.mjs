import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrcaAdapter } from '../runtime/adapters/orca.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fakeOrca = path.resolve(here, 'fixtures/fake-orca-cli.mjs');

export const manifest = {
  agent_id: 'proofgraph.orca',
  adapter: 'orca',
  roles: ['direct', 'researcher', 'planner', 'developer', 'verifier', 'synthesizer'],
  capabilities: ['structured_output', 'orca_host', 'worktree_isolation', 'orchestration_transport'],
  timeout_ms: 10_000,
  max_output_bytes: 256_000,
};

export function makeRequest(options = {}) {
  const kind = options.kind ?? 'direct';
  const role = options.role ?? (kind === 'verify' ? 'verifier' : kind === 'develop' ? 'developer' : 'direct');
  return {
    request_id: options.requestId ?? `req_orca_${kind}_123`,
    run_id: options.runId ?? 'run_orca_123',
    node: {
      node_id: options.nodeId ?? kind,
      title: options.title ?? `Execute ${kind}`,
      kind,
      role,
      metadata: options.nodeMetadata ?? {},
    },
    objective: options.objective ?? 'Validate Orca orchestration integration',
    attempt: options.attempt ?? 1,
    model_tier: 'inherit',
    tool_policy: options.toolPolicy ?? ['proofgraph'],
    context: [],
    workspace: options.workspace ?? { enabled: false, isolated: false, project_dir: options.projectDir ?? process.cwd() },
    constraints: { graph_digest: 'a'.repeat(64), graph_revision: 1 },
    prompt: options.prompt ?? `# ProofGraph Agent Contract\nNode: ${kind} (${kind})\nReturn one valid AgentResult JSON object.`,
    metadata: {},
  };
}

export async function setupOrca(behavior = 'success', options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-orca-test-'));
  const project = path.join(base, 'project');
  const stateFile = path.join(base, 'orca-state.json');
  const fakeRoot = path.join(base, 'orca-runtime');
  await fs.mkdir(project, { recursive: true });
  const adapter = new OrcaAdapter(manifest, {
    command: process.execPath,
    args: [fakeOrca],
    projectDir: project,
    repoSelector: options.repoSelector === undefined ? 'id:repo_1' : options.repoSelector,
    requireExplicitRepoSelector: options.requireExplicitRepoSelector ?? true,
    env: {
      FAKE_ORCA_STATE: stateFile,
      FAKE_ORCA_ROOT: fakeRoot,
      FAKE_ORCA_BEHAVIOR: behavior,
      ...(options.env ?? {}),
    },
    enabled: options.enabled ?? true,
    manualPermissionsConfirmed: options.manualPermissionsConfirmed ?? true,
    agentMap: options.agentMap ?? { direct: 'claude', researcher: 'claude', planner: 'claude', developer: 'codex', verifier: 'claude', synthesizer: 'claude' },
    allowedAgents: options.allowedAgents ?? ['claude', 'codex'],
    allowNodeAgentOverride: options.allowNodeAgentOverride ?? false,
    allowWorkspaceMutation: options.allowWorkspaceMutation ?? false,
    allowInlineResult: options.allowInlineResult ?? false,
    checkTimeoutMs: options.checkTimeoutMs ?? 1_000,
    terminalWaitMs: options.terminalWaitMs ?? 1_000,
    maxCheckpoints: options.maxCheckpoints ?? 2,
    maxSpecBytes: options.maxSpecBytes ?? 60_000,
    maxReportBytes: options.maxReportBytes ?? 256_000,
    setup: 'inherit',
  });
  return {
    base,
    project,
    stateFile,
    fakeRoot,
    adapter,
    async state() {
      try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}
