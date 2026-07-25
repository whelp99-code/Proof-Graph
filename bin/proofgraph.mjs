#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compileDynamicGraph } from '../server/lib/graph-compiler.mjs';
import { getGraphReport, getGraphStatus, resolveGraphApproval, verifyGraphIntegrity } from '../server/lib/graph-runtime.mjs';
import { validateGraphSpec } from '../server/lib/graph-spec.mjs';
import { adapterConfigExample } from '../runtime/adapters/profiles.mjs';
import { inspectRun, renderInspection, startInspectorServer } from '../runtime/debugger/inspector.mjs';
import { createPlatform } from '../runtime/platform.mjs';
import { startTui } from '../runtime/tui/app.mjs';
import { startHostBridge } from '../runtime/hosts/bridge-server.mjs';
import { HOST_PROTOCOL_VERSION } from '../runtime/hosts/protocol.mjs';
import { getHost, listHosts } from '../runtime/hosts/catalog.mjs';
import { installHostIntegration, listHostIntegrations } from '../runtime/hosts/install.mjs';
import { initializeProject } from '../runtime/project.mjs';
import { PRODUCT_NAME, VERSION } from '../runtime/version.mjs';

function usage() {
  return `ProofGraph — Graph Engineering Runtime for AI Coding

Usage:
  proofgraph version
  proofgraph init [DIR] [--force]
  proofgraph templates [NAME]
  proofgraph compile <objective> [--template NAME] [--mode auto|research|build|review]
  proofgraph graph <validate|start|run> <graph.json> [--adapter NAME]
  proofgraph start <objective> [--template NAME] [--adapter NAME]
  proofgraph run <objective> [--template NAME] [--adapter NAME] [--workspace]
  proofgraph resume <run_id> [--adapter NAME]
  proofgraph status <run_id>
  proofgraph approve <run_id> <approval_id> <challenge> <approve|deny>
  proofgraph report <run_id> [json|markdown]
  proofgraph integrity <run_id>
  proofgraph abort <run_id> [reason]
  proofgraph adapters
  proofgraph doctor
  proofgraph debug <status|pause|resume|step|break|clear|bypass> <run_id> ...
  proofgraph inspect <run_id> [text|json|dot]
  proofgraph serve <run_id> [--host 127.0.0.1] [--port 0]
  proofgraph hosts [NAME]
  proofgraph host list
  proofgraph host paths
  proofgraph host install <opencode|pi> [--scope project|user] [--force]
  proofgraph host serve [opencode|pi|custom] [--bind 127.0.0.1] [--port 0] [--token TOKEN]
  proofgraph tui [run_id] [--snapshot] [--refresh-ms 750]
  proofgraph workspace <create|status|propose|approve|execute|diff|rollback|close> ...
  proofgraph mcp
  proofgraph adapter-config

Vendor adapters are disabled until explicitly enabled in proofgraph.config.json. The mock adapter is the safe default.
`;
}

function parse(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positionals.push(token);
  }
  return { flags, positionals };
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function readGraphFile(file) {
  if (!file) throw new Error('A graph JSON file is required');
  const resolved = path.resolve(file);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(resolved, 'utf8')); }
  catch (error) { throw new Error(`Cannot read graph JSON ${resolved}: ${error.message}`); }
  return { resolved, graph: parsed };
}

function graphInput(templates, objective, flags) {
  const input = { objective, mode: flags.mode ?? 'auto' };
  const matched = flags.template ? null : templates.match(objective);
  const selectedTemplate = flags.template ?? matched?.name;
  if (!selectedTemplate) return input;
  const applied = templates.apply(selectedTemplate, input);
  const { template, ...compileInput } = applied;
  return {
    ...compileInput,
    metadata: {
      template,
      selection: flags.template ? 'explicit' : 'auto',
      ...(matched ? { matched_keyword: matched.keyword } : {}),
    },
  };
}

async function buildKernel(flags) {
  const projectDir = path.resolve(flags.project ?? process.cwd());
  const overrides = {
    ...(flags['data-dir'] ? { data_dir: path.resolve(flags['data-dir']) } : {}),
    ...(flags.workspace ? { workspace: { enabled: true } } : {}),
    ...(flags.adapter ? { default_adapter: flags.adapter, routing: {
      direct: flags.adapter, researcher: flags.adapter, planner: flags.adapter,
      developer: flags.adapter, verifier: flags.adapter, synthesizer: flags.adapter,
    } } : {}),
  };
  return createPlatform({ projectDir, configPath: flags.config, overrides });
}

async function main() {
  const { flags, positionals } = parse(process.argv.slice(2));
  const command = positionals.shift();
  if (!command || flags.help || command === 'help') { print(usage()); return; }
  if (command === 'version') { print({ product: PRODUCT_NAME, version: VERSION }); return; }
  if (command === 'adapter-config') { print(adapterConfigExample()); return; }
  if (command === 'init') {
    const target = positionals.shift() ?? flags.project ?? process.cwd();
    print(await initializeProject(target, { force: flags.force === true || flags.force === 'true' }));
    return;
  }
  if (command === 'mcp') { await import('../runtime/mcp/server.mjs'); return; }
  if (command === 'host' && positionals[0] === 'list') {
    print({ hosts: listHosts(), installation: listHostIntegrations({ projectDir: flags.project ?? process.cwd() }) });
    return;
  }
  if (command === 'host' && positionals[0] === 'install') {
    positionals.shift();
    const hostName = positionals.shift();
    if (!hostName) throw new Error('host install requires opencode or pi');
    print(await installHostIntegration(hostName, {
      scope: flags.scope ?? 'project',
      mode: flags.mode ?? 'managed',
      force: flags.force === true || flags.force === 'true',
      projectDir: flags.project ?? process.cwd(),
      homeDir: flags.home,
    }));
    return;
  }
  const { kernel, config, registry, workspace, debuggerController, templates, source } = await buildKernel(flags);
  if (command === 'templates') { print(positionals[0] ? templates.get(positionals[0]) : templates.list()); return; }
  if (command === 'hosts') { print(positionals[0] ? getHost(positionals[0]) : listHosts()); return; }
  if (command === 'host') {
    const subcommand = positionals.shift();
    if (subcommand === 'paths') { print(listHostIntegrations({ projectDir: config.project_dir, homeDir: config.home_dir })); return; }
    const hostName = positionals.shift() ?? 'custom';
    if (subcommand !== 'serve') throw new Error('host requires list|install|paths|serve');
    const rawPort = flags.port ?? '0';
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('host serve --port must be 0..65535');
    const providedToken = flags.token ?? process.env.PROOFGRAPH_HOST_TOKEN ?? null;
    const bridge = await startHostBridge({
      platform: { kernel, config, registry, workspace, debuggerController, templates },
      host: hostName,
      bind: flags.bind ?? '127.0.0.1',
      port,
      token: providedToken,
      allowRemote: flags['allow-remote'] === true || flags['allow-remote'] === 'true',
      allowIsolatedMutation: flags['allow-isolated-mutation'] === true || flags['allow-isolated-mutation'] === 'true',
    });
    // Long-running bridge startup is a machine-readable JSONL handshake. Keep it
    // on one line so host launchers can parse the first record without waiting
    // for process termination, and never echo a caller-provided bearer token.
    process.stdout.write(`${JSON.stringify({
      ok: true,
      host: hostName,
      url: bridge.url,
      token_source: providedToken ? 'provided' : 'generated',
      ...(providedToken ? {} : { token: bridge.token }),
      protocol_version: HOST_PROTOCOL_VERSION,
    })}\n`);
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await bridge.close();
    return;
  }
  if (command === 'graph') {
    const subcommand = positionals.shift();
    const file = positionals.shift();
    if (!['validate', 'start', 'run'].includes(subcommand)) throw new Error('graph requires validate|start|run');
    const loaded = await readGraphFile(file);
    const validated = validateGraphSpec(loaded.graph);
    if (subcommand === 'validate') {
      print({ ok: true, file: loaded.resolved, graph_digest: validated.digest, validation: validated.analysis, graph: validated.spec });
      return;
    }
    if (subcommand === 'start') print(await kernel.startGraph(validated.spec));
    else print(await kernel.runGraph(validated.spec, { adapter: flags.adapter ?? config.default_adapter }));
    return;
  }
  if (command === 'compile') {
    const objective = positionals.join(' ');
    if (!objective) throw new Error('compile requires an objective');
    const value = graphInput(templates, objective, flags);
    const { metadata, ...compileInput } = value;
    print({ ...compileDynamicGraph(compileInput), metadata });
    return;
  }
  if (command === 'adapters') { print(await registry.doctor()); return; }
  if (command === 'doctor') {
    print({
      ok: true, product: PRODUCT_NAME, version: VERSION, project_dir: config.project_dir, config_source: source, data_dir: config.data_dir,
      adapters: await registry.doctor(), workspace: await workspace?.describe() ?? { enabled: false },
      debugger: { enabled: config.debugger.enabled }, templates: templates.list().map((item) => item.name),
    });
    return;
  }

  if (command === 'debug') {
    const subcommand = positionals.shift();
    const runId = positionals.shift();
    if (!subcommand || !runId) throw new Error('debug requires a subcommand and run_id');
    if (subcommand === 'status') { print(await debuggerController.read(runId)); return; }
    if (subcommand === 'break') {
      const type = positionals.shift();
      const value = positionals.shift();
      if (!['node', 'kind'].includes(type) || !value) throw new Error('debug break requires node|kind and a value');
      print(await debuggerController.command(runId, 'break', { type, value })); return;
    }
    if (subcommand === 'clear') { print(await debuggerController.command(runId, 'clear', { value: positionals.shift() })); return; }
    if (subcommand === 'bypass') {
      const nodeId = positionals.shift();
      if (!nodeId) throw new Error('debug bypass requires node_id');
      print(await debuggerController.bypassBreakpointOnce(runId, nodeId)); return;
    }
    if (!['pause', 'resume', 'step'].includes(subcommand)) throw new Error(`Unknown debug subcommand: ${subcommand}`);
    print(await debuggerController.command(runId, subcommand, { reason: flags.reason })); return;
  }
  if (command === 'tui') {
    const runId = positionals.shift() ?? null;
    const rawRefresh = flags['refresh-ms'] ?? config.debugger.event_poll_ms ?? 750;
    const refreshMs = Number(rawRefresh);
    if (!Number.isFinite(refreshMs) || refreshMs < 100 || refreshMs > 60_000) throw new Error('tui --refresh-ms must be 100..60000');
    await startTui({
      dataDir: config.data_dir,
      projectDir: config.project_dir,
      runId,
      kernel,
      debuggerController,
      workspace,
      refreshMs,
      snapshot: flags.snapshot === true || flags.snapshot === 'true',
    });
    return;
  }
  if (command === 'inspect' || command === 'serve') {
    const runId = positionals.shift();
    if (!runId) throw new Error(`${command} requires a run_id`);
    const inspect = () => inspectRun({ dataDir: config.data_dir, projectDir: config.project_dir, runId, debuggerController, workspace });
    if (command === 'inspect') {
      const format = positionals.shift() ?? 'text';
      const result = await inspect();
      if (format === 'json') print(result);
      else if (format === 'dot') print(result.dot);
      else if (format === 'text') print(renderInspection(result));
      else throw new Error('inspect format must be text, json, or dot');
      return;
    }
    const rawPort = flags.port ?? '0';
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('serve --port must be 0..65535');
    const started = await startInspectorServer({ host: flags.host ?? '127.0.0.1', port, inspect });
    print({ ok: true, run_id: runId, url: started.url, token: started.token, host: started.host, port: started.port });
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await new Promise((resolve) => started.server.close(resolve));
    return;
  }
  if (command === 'workspace') {
    const subcommand = positionals.shift();
    const runId = positionals.shift();
    if (!subcommand || !runId) throw new Error('workspace requires a subcommand and run_id');
    if (!workspace) throw new Error('Workspace engine is disabled; add --workspace or set workspace.enabled=true');
    if (subcommand === 'create') { print(await workspace.prepare({ run_id: runId })); return; }
    if (subcommand === 'status') { print(await workspace.readState(runId)); return; }
    if (subcommand === 'diff') { print(await workspace.diff(runId)); return; }
    if (subcommand === 'rollback') { print(await workspace.rollback(runId, { reason: 'CLI rollback' })); return; }
    if (subcommand === 'close') { print(await workspace.close(runId, { force: flags.force === true || flags.force === 'true' })); return; }
    if (subcommand === 'propose') {
      const actionFile = positionals.shift();
      if (!actionFile) throw new Error('workspace propose requires an actions JSON file');
      const actions = JSON.parse(await fs.readFile(path.resolve(actionFile), 'utf8'));
      print(await workspace.proposeActions({ run_id: runId, node: { node_id: 'cli', kind: 'develop' }, actions })); return;
    }
    if (subcommand === 'approve') {
      const [challenge, rawDecision] = positionals;
      const decision = rawDecision === 'approve' ? 'approved' : rawDecision === 'deny' ? 'denied' : rawDecision;
      if (!challenge || !decision) throw new Error('workspace approve requires challenge and approve|deny');
      print(await workspace.decide(runId, challenge, decision, 'human-cli')); return;
    }
    if (subcommand === 'execute') { print(await workspace.executeApproved(runId)); return; }
    throw new Error(`Unknown workspace subcommand: ${subcommand}`);
  }

  if (command === 'start' || command === 'run') {
    const objective = positionals.join(' ');
    if (!objective) throw new Error(`${command} requires an objective`);
    const value = graphInput(templates, objective, flags);
    const { metadata: _metadata, ...runInput } = value;
    if (command === 'start') print(await kernel.start(runInput));
    else print(await kernel.run(runInput, { adapter: flags.adapter ?? config.default_adapter }));
    return;
  }
  const runId = positionals.shift();
  if (!runId) throw new Error(`${command} requires a run_id`);
  const context = { dataDir: config.data_dir, projectDir: config.project_dir };
  if (command === 'resume') { print(await kernel.resume(runId, { adapter: flags.adapter ?? config.default_adapter })); return; }
  if (command === 'status') { print(await getGraphStatus({ run_id: runId }, context)); return; }
  if (command === 'report') { print(await getGraphReport({ run_id: runId, format: positionals[0] ?? 'json' }, context)); return; }
  if (command === 'integrity') { print(await verifyGraphIntegrity({ run_id: runId }, context)); return; }
  if (command === 'abort') { print(await kernel.abort(runId, positionals.join(' ') || 'Explicit CLI abort', 'coordinator')); return; }
  if (command === 'approve') {
    const [approvalId, challenge, rawDecision] = positionals;
    if (!approvalId || !challenge || !rawDecision) throw new Error('approve requires approval_id, challenge, and approve|deny');
    const decision = rawDecision === 'approve' ? 'approved' : rawDecision === 'deny' ? 'denied' : rawDecision;
    print(await resolveGraphApproval({ run_id: runId, actor: 'human', approval_id: approvalId, challenge, decision, decision_source: 'external_human', comment: 'Explicit CLI decision' }, context));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.name ?? 'Error'}: ${error.message}\n`);
  if (process.env.PROOFGRAPH_DEBUG === '1' && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
