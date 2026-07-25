import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SubprocessAdapter } from '../../runtime/adapters/subprocess.mjs';
import { PiRpcAdapter } from '../../runtime/adapters/pi-rpc.mjs';
import { parseAgentResultFromOutput } from '../../runtime/adapters/result-parser.mjs';
import { createBuiltInRegistry } from '../../runtime/adapters/profiles.mjs';
import { normalizePlatformConfig } from '../../runtime/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../fixtures/fake-agent-cli.mjs');
const piFixture = path.resolve(here, '../fixtures/fake-pi-rpc.mjs');
const manifest = {
  agent_id: 'proofgraph.fake', adapter: 'fake', roles: ['direct', 'verifier'],
  capabilities: ['structured_output'], timeout_ms: 2_000, max_output_bytes: 256_000,
};
const request = {
  request_id: 'req_123', run_id: 'run_123', node: { node_id: 'direct', kind: 'direct', role: 'direct' },
  objective: 'test', attempt: 1, model_tier: 'inherit', tool_policy: [], context: [],
  workspace: { isolated: true, project_dir: process.cwd() }, constraints: {},
  prompt: '# ProofGraph Agent Contract\nNode: direct (direct)\nReturn JSON.', metadata: {},
};

test('result parser accepts direct, nested, fenced, and JSONL vendor envelopes', () => {
  const payload = { outcome: 'success', summary: 'ok', output: {} };
  assert.deepEqual(parseAgentResultFromOutput(JSON.stringify(payload)).result, payload);
  assert.deepEqual(parseAgentResultFromOutput(JSON.stringify({ result: JSON.stringify(payload) })).result, payload);
  assert.deepEqual(parseAgentResultFromOutput(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``).result, payload);
  assert.deepEqual(parseAgentResultFromOutput(`${JSON.stringify({ type: 'start' })}\n${JSON.stringify({ item: { text: JSON.stringify(payload) } })}`).result, payload);
});

test('subprocess adapter uses argv without shell and normalizes JSONL output', async () => {
  const adapter = new SubprocessAdapter(manifest, {
    command: process.execPath,
    enabled: true,
    cwd: process.cwd(),
    env: { FAKE_AGENT_SHAPE: 'jsonl' },
    liveCanaryRequired: false,
    buildInvocation: (input) => ({ args: [fixture, '--prompt', input.prompt] }),
  });
  const output = await adapter.invoke(request);
  assert.equal(output.outcome, 'success');
  assert.equal(output.summary, 'fake completed');
  const doctor = await adapter.doctor();
  assert.equal(doctor.ok, true);
});

test('subprocess adapter fails closed on malformed output and host tool risk', async () => {
  const malformed = new SubprocessAdapter(manifest, {
    command: process.execPath, enabled: true, cwd: process.cwd(), env: { FAKE_AGENT_SHAPE: 'malformed' },
    buildInvocation: (input) => ({ args: [fixture, input.prompt] }),
  });
  await assert.rejects(malformed.invoke(request), /No ProofGraph AgentResult/);
  const risky = new SubprocessAdapter(manifest, {
    command: process.execPath, enabled: true, cwd: process.cwd(), hostToolRisk: true, allowHostTools: false,
    buildInvocation: (input) => ({ args: [fixture, input.prompt] }),
  });
  await assert.rejects(risky.invoke({ ...request, workspace: { isolated: false, project_dir: process.cwd() } }), /isolated workspace/);
});

test('subprocess adapter enforces timeout and output cap', async () => {
  const slow = new SubprocessAdapter({ ...manifest, timeout_ms: 1000 }, {
    command: process.execPath, enabled: true, cwd: process.cwd(), env: { FAKE_AGENT_SHAPE: 'sleep' },
    buildInvocation: (input) => ({ args: [fixture, input.prompt] }),
  });
  await assert.rejects(slow.invoke(request), /timed out/);
  const large = new SubprocessAdapter({ ...manifest, max_output_bytes: 1024 }, {
    command: process.execPath, enabled: true, cwd: process.cwd(), env: { FAKE_AGENT_SHAPE: 'oversize' },
    buildInvocation: (input) => ({ args: [fixture, input.prompt] }),
  });
  await assert.rejects(large.invoke(request), /exceeded/);
});

test('Pi JSONL RPC adapter completes only after agent_settled and requires isolation', async () => {
  const adapter = new PiRpcAdapter({ ...manifest, adapter: 'pi', agent_id: 'proofgraph.pi', timeout_ms: 10_000 }, {
    command: process.execPath, args: [piFixture, '--mode', 'rpc', '--no-session'], enabled: true, cwd: process.cwd(),
  });
  const output = await adapter.invoke(request);
  assert.equal(output.outcome, 'success');
  await assert.rejects(adapter.invoke({ ...request, workspace: { isolated: false, project_dir: process.cwd() } }), /isolated workspace/);
});


test('Pi default RPC profile disables discovery and exposes only read tools', () => {
  const adapter = new PiRpcAdapter({ ...manifest, adapter: 'pi', agent_id: 'proofgraph.pi' }, {
    command: 'pi', enabled: true, cwd: process.cwd(),
  });
  const args = adapter.buildArgs({ ...request, workspace: { isolated: false, project_dir: process.cwd() } });
  assert.deepEqual(args.slice(0, 3), ['--mode', 'rpc', '--no-session']);
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-skills'));
  assert.ok(args.includes('--no-prompt-templates'));
  assert.ok(args.includes('--no-context-files'));
  assert.deepEqual(args.slice(-2), ['--tools', 'read,grep,find,ls']);
});

test('Pi mutation tools remain gated by an isolated workspace', () => {
  const adapter = new PiRpcAdapter({ ...manifest, adapter: 'pi', agent_id: 'proofgraph.pi' }, {
    command: 'pi', enabled: true, allowHostTools: true, cwd: process.cwd(),
  });
  assert.throws(() => {
    const normalized = adapter.normalizeRequest({ ...request, workspace: { isolated: false, project_dir: process.cwd() } });
    if (adapter.allowHostTools && normalized.workspace?.isolated !== true) throw new Error('Pi mutation tools require an isolated ProofGraph workspace');
  }, /isolated ProofGraph workspace/);
  const args = adapter.buildArgs(request);
  assert.deepEqual(args.slice(-2), ['--tools', 'read,grep,find,ls,bash,edit,write']);
});

test('built-in registry exposes all target adapters with explicit canary status', async () => {
  const config = normalizePlatformConfig({ default_adapter: 'mock' }, { projectDir: process.cwd() });
  const registry = createBuiltInRegistry(config);
  const names = registry.list().map((entry) => entry.name).sort();
  assert.deepEqual(names, ['claude', 'codex', 'gjc', 'grok', 'mock', 'opencode', 'orca', 'pi']);
  const doctors = await registry.doctor();
  assert.equal(doctors.find((item) => item.name === 'mock').ok, true);
  assert.equal(doctors.find((item) => item.name === 'gjc').live_canary_required, true);
  assert.equal(doctors.find((item) => item.name === 'orca').status, 'disabled');
});

test('built-in adapter invocations match current headless contracts and remain configurable', async () => {
  const config = normalizePlatformConfig({
    default_adapter: 'mock',
    adapters: {
      claude: { enabled: true, command: process.execPath, extra_args: ['--verbose'] },
      codex: {
        enabled: true,
        command: process.execPath,
        output_args: ['--experimental-json'],
        sandbox: 'read-only',
        skip_git_repo_check: false,
        extra_args: ['--ephemeral'],
      },
      opencode: { enabled: true, command: process.execPath, agent: 'plan', allow_host_tools: false },
      grok: { enabled: true, command: process.execPath, allow_host_tools: false, extra_args: ['--no-alt-screen'] },
    },
  }, { projectDir: '/tmp/proofgraph-adapter-project' });
  const registry = createBuiltInRegistry(config);

  const claudeArgs = registry.get('claude').buildInvocation(request).args;
  assert.deepEqual(claudeArgs.slice(0, 4), ['--output-format', 'json', '--permission-mode', 'plan']);
  assert.deepEqual(claudeArgs.slice(-3), ['--verbose', '-p', request.prompt]);

  const codexArgs = registry.get('codex').buildInvocation(request).args;
  assert.deepEqual(codexArgs, [
    'exec', '--experimental-json', '--sandbox', 'read-only', '--ephemeral', request.prompt,
  ]);

  const openCodeArgs = registry.get('opencode').buildInvocation(request).args;
  assert.deepEqual(openCodeArgs.slice(0, 7), ['run', '--format', 'json', '--agent', 'plan', '--dir', '/tmp/proofgraph-adapter-project']);
  assert.equal(openCodeArgs.at(-1), request.prompt);

  const grokArgs = registry.get('grok').buildInvocation(request).args;
  assert.deepEqual(grokArgs.slice(0, 6), ['--no-auto-update', '--output-format', 'json', '--cwd', '/tmp/proofgraph-adapter-project', '--no-alt-screen']);
  assert.deepEqual(grokArgs.slice(-2), ['-p', request.prompt]);
});

test('Gajae Code default profile is a fail-closed SDK v3 WebSocket boundary', async () => {
  const config = normalizePlatformConfig({ default_adapter: 'mock' }, { projectDir: process.cwd() });
  const registry = createBuiltInRegistry(config);
  const result = (await registry.doctor()).find((item) => item.name === 'gjc');
  assert.equal(result.mode, 'gajae-sdk-v3-websocket');
  assert.equal(result.status, 'disabled');
  assert.match(result.error, /SDK v3 WebSocket/);
  assert.match(result.error, /--mode rpc/);
  await assert.rejects(registry.get('gjc').invoke(request), /SDK v3 WebSocket/);
});

test('adapter argument arrays reject non-string entries before process execution', () => {
  const config = normalizePlatformConfig({
    adapters: { codex: { enabled: true, command: process.execPath, output_args: ['--json', 42] } },
  }, { projectDir: process.cwd() });
  const registry = createBuiltInRegistry(config);
  assert.throws(() => registry.get('codex').buildInvocation(request), /array of non-empty strings/);
});
