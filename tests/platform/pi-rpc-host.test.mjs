import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PiRpcAdapter } from '../../runtime/adapters/pi-rpc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'fake-pi-rpc.mjs');
const manifest = {
  agent_id: 'proofgraph.pi', adapter: 'pi', roles: ['direct', 'verifier'],
  capabilities: ['structured_output'], timeout_ms: 10_000, max_output_bytes: 256_000,
};
const request = {
  request_id: 'req_pi', run_id: 'run_pi', node: { node_id: 'direct', kind: 'direct', role: 'direct' },
  objective: 'test pi rpc', attempt: 1, model_tier: 'inherit', tool_policy: [], context: [],
  workspace: { isolated: true, project_dir: ROOT }, constraints: {},
  prompt: '# ProofGraph Agent Contract\nNode: direct (direct)\nReturn JSON.', metadata: {},
};
function adapter(mode, options = {}) {
  return new PiRpcAdapter(manifest, {
    command: process.execPath, args: [FIXTURE, '--mode', 'rpc', '--no-session'], enabled: true, cwd: ROOT,
    env: { FAKE_PI_MODE: mode }, ...options,
  });
}

test('Pi RPC completes on agent_settled and preserves Unicode separators inside JSON strings', async () => {
  const output = await adapter('settled').invoke(request);
  assert.equal(output.outcome, 'success');
  assert.equal(output.output.result.unicode, 'line\u2028separator');
});

test('Pi RPC rejects process exit after agent_end but before agent_settled', async () => {
  await assert.rejects(adapter('agent-end-only').invoke(request), /after agent_end but before agent_settled/);
});
test('Pi RPC denies blocking extension UI in unattended mode', async () => {
  await assert.rejects(adapter('blocking-ui').invoke(request), /interactive UI method confirm/);
});

test('Pi RPC can explicitly cancel blocking extension UI and continue', async () => {
  const output = await adapter('blocking-ui', { uiPolicy: 'cancel' }).invoke(request);
  assert.equal(output.outcome, 'success');
});

test('Pi RPC rejects malformed JSONL and extension failures', async () => {
  await assert.rejects(adapter('malformed').invoke(request), /malformed JSONL/);
  await assert.rejects(adapter('extension-error').invoke(request), /extension error/);
});
