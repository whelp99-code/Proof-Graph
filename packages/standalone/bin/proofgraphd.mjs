#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createControlPlaneServer, ControlPlane } from '../runtime/control-plane/index.mjs';
import { ReferenceGraphKernelPort, HostBridgeGraphPort, NativeAgentGraphPort } from '../runtime/company/index.mjs';
import { OpenAICompatibleProvider } from '../runtime/providers/index.mjs';
import { SandboxRuntime } from '../runtime/tools/index.mjs';
import { loadConfiguredModelRegistry } from '../runtime/intelligence/index.mjs';

function parse(argv) {
  const flags = {}; const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline != null) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { flags, positionals };
}

async function main() {
  const { flags } = parse(process.argv.slice(2));
  const dataDir = path.resolve(flags['data-dir'] ?? process.env.PROOFGRAPH_ORG_DATA ?? '.proofgraph-org');
  const host = flags.host ?? '127.0.0.1'; const port = Number(flags.port ?? 8742);
  let graphPort;
  if (flags['bridge-url']) {
    graphPort = new HostBridgeGraphPort({
      url: flags['bridge-url'], token: flags['bridge-token'] ?? process.env.PROOFGRAPH_HOST_BRIDGE_TOKEN,
      host: flags['runtime-host'] ?? 'opencode', allowRemote: flags['allow-remote-bridge'] === true,
    });
  } else if (flags['provider-url']) {
    const keyEnv = flags['provider-key-env'] ?? 'PROOFGRAPH_PROVIDER_API_KEY';
    const provider = new OpenAICompatibleProvider({
      baseUrl: flags['provider-url'], apiKey: process.env[keyEnv] ?? null,
      model: flags['provider-model'], provider: flags['provider-name'] ?? 'openai-compatible',
      local: flags['native-local'] === true, timeoutMs: Number(flags['provider-timeout-ms'] ?? 120000),
    });
    const sandbox = flags['execute-tools'] === true ? new SandboxRuntime({ rootDir: flags['sandbox-root'] ? path.resolve(flags['sandbox-root']) : null }) : null;
    graphPort = new NativeAgentGraphPort({ provider, sandbox, sourceDir: flags['source-dir'] ? path.resolve(flags['source-dir']) : null, executeTools: flags['execute-tools'] === true });
  } else {
    graphPort = new ReferenceGraphKernelPort();
  }
  const modelRegistry = await loadConfiguredModelRegistry({ filePath: flags['model-registry'] });
  const controlPlane = new ControlPlane({ dataDir, graphPort, modelRegistry, tickDelayMs: Number(flags['tick-ms'] ?? 75) });
  const app = await createControlPlaneServer({ controlPlane, host, port, allowRemote: flags['allow-remote'] === true });
  const address = await app.listen();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDir, '.proofgraphd.json'), `${JSON.stringify({ pid: process.pid, host: address.host, port: address.port, started_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, execution_mode: graphPort.executionMode, url: `http://${address.host}:${address.port}`, data_dir: dataDir, token_files: controlPlane.tokenFiles() })}\n`);
  const shutdown = async () => { try { await app.close(); } finally { process.exit(0); } };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
