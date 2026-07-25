#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateGraphSpec } from '../server/lib/graph-spec.mjs';
import { HOST_PROTOCOL_VERSION, hostInstallPath, listHosts } from '../runtime/hosts/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
const checks = [];
let productVersion = 'unknown';

function add(name, ok, details = {}) { checks.push({ ...details, name, ok }); }
async function exists(rel) { try { await fs.access(path.join(ROOT, rel)); return true; } catch { return false; } }
async function json(rel) { return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8')); }
function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) data[match[1]] = match[2].trim();
  }
  return data;
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

class Client {
  async start(env, entry = 'server/index.mjs') {
    this.child = spawn(process.execPath, [path.join(ROOT, entry)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iter = this.reader[Symbol.asyncIterator]();
    this.seq = 0; this.stderr = '';
    this.child.stderr.on('data', c => { this.stderr += c.toString(); });
    return this;
  }
  async request(method, params = {}) {
    const id = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await Promise.race([
      this.iter.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP response timeout')), 5000)),
    ]);
    if (next.done) throw new Error(`MCP server closed: ${this.stderr}`);
    const msg = JSON.parse(next.value);
    if (msg.id !== id) throw new Error(`Unexpected response id ${msg.id}`);
    return msg;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await Promise.race([new Promise(r => this.child.once('exit', r)), new Promise(r => setTimeout(() => { this.child.kill('SIGKILL'); r(); }, 1500))]);
    this.reader.close();
  }
}

try {
  const [manifest, pkg, mcp, hooks] = await Promise.all([
    json('.claude-plugin/plugin.json'), json('package.json'), json('.mcp.json'), json('hooks/hooks.json'),
  ]);
  productVersion = pkg.version;
  add('node_version', Number(process.versions.node.split('.')[0]) >= 20, { actual: process.versions.node, required: '>=20' });
  add('version_alignment', manifest.version === pkg.version, { plugin: manifest.version, package: pkg.version });
  add('package_identity', Boolean(pkg.name === 'proofgraph' && pkg.bin?.proofgraph && pkg.bin?.['proofgraph-mcp']), { name: pkg.name, bin: pkg.bin });
  add('plugin_name', manifest.name === 'proofgraph-claude', { actual: manifest.name });
  const componentPaths = [manifest.skills, manifest.hooks, manifest.mcpServers, ...(manifest.agents ?? [])].filter(Boolean).map(v => String(v).replace(/^\.\//, ''));
  const missing = [];
  for (const rel of componentPaths) if (!await exists(rel)) missing.push(rel);
  add('component_paths', missing.length === 0, { checked: componentPaths, missing });
  const platformPaths = ['bin/proofgraph.mjs', 'runtime/platform.mjs', 'runtime/mcp/server.mjs', 'runtime/templates/registry.mjs', 'runtime/workspace/engine.mjs', 'runtime/debugger/controller.mjs', 'runtime/tui/app.mjs', 'runtime/hosts/base.mjs', 'runtime/hosts/orca-client.mjs', 'runtime/hosts/orca.mjs', 'runtime/adapters/orca.mjs', 'runtime/hosts/protocol.mjs', 'runtime/hosts/bridge-server.mjs', 'runtime/hosts/compatibility.mjs', 'runtime/hosts/catalog.mjs', 'runtime/hosts/install.mjs', 'runtime/hosts/opencode-client.mjs', 'runtime/hosts/opencode.mjs', 'runtime/adapters/opencode-server.mjs', 'runtime/adapters/pi-rpc.mjs', 'integrations/opencode/plugin.ts', 'integrations/opencode/core.mjs', 'integrations/opencode/bridge-client.mjs', 'integrations/pi/extensions/proofgraph/index.ts', 'integrations/pi/core.mjs', 'integrations/pi/bridge-client.mjs', 'scripts/orca-live-preflight.mjs', 'scripts/hosts-live-preflight.mjs', 'scripts/package-hosts.mjs', 'examples/graphs/ai-agent-tui.graph.json', 'examples/orca-bridge.config.json', 'examples/opencode-host.config.json', 'examples/pi-host.config.json', 'schemas/graphspec-v1.schema.json', 'docs/GRAPH_SPEC.md', 'docs/GRAPH_SPEC_KO.md', 'docs/AI_AGENT_TUI.md', 'docs/AI_AGENT_TUI_KO.md', 'docs/ORCA_INTEGRATION.md', 'docs/ORCA_INTEGRATION_KO.md', 'docs/OPENCODE_PI_INTEGRATION.md', 'docs/OPENCODE_PI_INTEGRATION_KO.md', 'docs/HOSTS_OPENCODE_PI.md', 'docs/HOSTS_OPENCODE_PI_KO.md', 'skills/orca-worker/SKILL.md', 'verification/ORCA_INTEGRATION_VERIFICATION_KO.md', 'verification/platform_independent_verifier.mjs', 'verification/tui_independent_verifier.mjs', 'verification/orca_independent_verifier.mjs', 'verification/hosts_independent_verifier.mjs'];
  const platformMissing = []; for (const rel of platformPaths) if (!await exists(rel)) platformMissing.push(rel);
  add('platform_paths', platformMissing.length === 0, { checked: platformPaths, missing: platformMissing });
  const hostCatalog = listHosts();
  add('host_priority', hostCatalog.map((host) => host.name).join(',') === 'opencode,pi,orca'
    && hostCatalog.every((host) => host.live_canary_required === true)
    && hostCatalog.every((host) => String(host.version_policy).startsWith('pin')), {
    hosts: hostCatalog,
    protocol_version: HOST_PROTOCOL_VERSION,
  });
  const openCodeInstall = hostInstallPath('opencode', { projectDir: ROOT, scope: 'project' });
  const piInstall = hostInstallPath('pi', { projectDir: ROOT, scope: 'project' });
  add('host_install_layouts', openCodeInstall.target.endsWith(path.join('.opencode', 'plugins', 'proofgraph.ts'))
    && piInstall.target.endsWith(path.join('.pi', 'extensions', 'proofgraph', 'index.ts'))
    && openCodeInstall.files.length === 7 && piInstall.files.length === 3, {
    opencode: openCodeInstall,
    pi: piInstall,
  });
  const [openCodeExample, piExample, openCodePackage, piPackage] = await Promise.all([
    json('examples/opencode-host.config.json'), json('examples/pi-host.config.json'),
    json('integrations/opencode/package.json'), json('integrations/pi/package.json'),
  ]);
  const openCodeSafe = openCodeExample.default_adapter === 'mock'
    && openCodeExample.workspace?.enabled === false
    && openCodeExample.adapters?.opencode?.enabled === false
    && openCodeExample.adapters?.opencode?.transport === 'server'
    && openCodeExample.adapters?.opencode?.allow_remote === false
    && openCodeExample.adapters?.opencode?.allow_host_tools === false
    && openCodeExample.adapters?.opencode?.require_isolated_workspace === true
    && openCodeExample.adapters?.opencode?.pure_worker_confirmed === false;
  const piSafe = piExample.default_adapter === 'mock'
    && piExample.workspace?.enabled === false
    && piExample.adapters?.pi?.enabled === false
    && piExample.adapters?.pi?.allow_host_tools === false
    && piExample.adapters?.pi?.disable_discovery === true
    && piExample.adapters?.pi?.ui_policy === 'deny';
  add('host_safe_defaults', openCodeSafe && piSafe, { opencode: openCodeExample.adapters?.opencode, pi: piExample.adapters?.pi });
  const openCodeTarget = hostCatalog.find((host) => host.name === 'opencode')?.contract_target;
  const piTarget = hostCatalog.find((host) => host.name === 'pi')?.contract_target;
  add('host_package_versions', openCodePackage.version === pkg.version && piPackage.version === pkg.version
    && openCodePackage.name === '@proofgraph/host-opencode'
    && piPackage.name === '@proofgraph/host-pi'
    && openCodePackage.dependencies?.['@opencode-ai/plugin'] === openCodeTarget?.plugin_version
    && openCodePackage.proofgraph?.contract_target?.opencode === openCodeTarget?.cli_version
    && piPackage.proofgraph?.contract_target?.pi === piTarget?.cli_version
    && piPackage.engines?.node === `>=${piTarget?.node_minimum}`
    && piPackage.peerDependencies?.['@earendil-works/pi-coding-agent'] === '*'
    && piPackage.peerDependencies?.typebox === '*', {
    root: pkg.version,
    opencode: openCodePackage.version,
    pi: piPackage.version,
    opencode_contract: openCodePackage.proofgraph?.contract_target,
    pi_contract: piPackage.proofgraph?.contract_target,
    pi_node: piPackage.engines?.node,
  });
  add('host_verification_scripts', pkg.scripts?.['test:hosts']?.includes('host-bridge-e2e')
    && pkg.scripts?.['verify:hosts']?.includes('hosts_independent_verifier')
    && pkg.scripts?.['hosts:preflight']?.includes('hosts-live-preflight')
    && pkg.scripts?.['release:verify']?.includes('hosts_independent_verifier')
    && pkg.scripts?.['release:verify']?.includes('hosts-live-preflight')
    && pkg.scripts?.['release:verify']?.includes('package-hosts'), {
    test: pkg.scripts?.['test:hosts'], verify: pkg.scripts?.['verify:hosts'], preflight: pkg.scripts?.['hosts:preflight'],
  });
  const orcaExample = await json('examples/orca-bridge.config.json');
  const orcaSafe = orcaExample?.workspace?.enabled === false
    && orcaExample?.adapters?.orca?.enabled === false
    && orcaExample?.adapters?.orca?.manual_permissions_confirmed === false
    && orcaExample?.adapters?.orca?.require_explicit_repo_selector === true
    && orcaExample?.adapters?.orca?.allow_workspace_mutation === false
    && orcaExample?.adapters?.orca?.allow_inline_result === false
    && pkg.scripts?.['orca:preflight'] === 'node scripts/orca-live-preflight.mjs';
  add('orca_bridge_safe_defaults', orcaSafe, {
    workspace_enabled: orcaExample?.workspace?.enabled,
    adapter_enabled: orcaExample?.adapters?.orca?.enabled,
    manual_permissions_confirmed: orcaExample?.adapters?.orca?.manual_permissions_confirmed,
    require_explicit_repo_selector: orcaExample?.adapters?.orca?.require_explicit_repo_selector,
    allow_workspace_mutation: orcaExample?.adapters?.orca?.allow_workspace_mutation,
    allow_inline_result: orcaExample?.adapters?.orca?.allow_inline_result,
    preflight_script: pkg.scripts?.['orca:preflight'],
  });
  const agentTuiGraph = validateGraphSpec(await json('examples/graphs/ai-agent-tui.graph.json'));
  add('agent_tui_graphspec', agentTuiGraph.analysis.node_count === 14 && agentTuiGraph.analysis.cycle_count >= 1, { digest: agentTuiGraph.digest, analysis: agentTuiGraph.analysis });
  const graphSpecSchema = await json('schemas/graphspec-v1.schema.json');
  const schemaKinds = graphSpecSchema?.$defs?.node?.properties?.kind?.enum ?? [];
  add('graphspec_schema', graphSpecSchema?.$schema === 'https://json-schema.org/draft/2020-12/schema' && graphSpecSchema?.properties?.schema_version?.const === 1 && schemaKinds.includes('verify') && schemaKinds.includes('human_approval'), { schema: graphSpecSchema?.$id, node_kinds: schemaKinds });
  const server = mcp?.mcpServers?.proofgraph;
  add('mcp_configuration', server?.type === 'stdio' && server?.command === 'node' && server?.args?.[0]?.includes('${CLAUDE_PLUGIN_ROOT}/server/index.mjs') && server?.env?.PROOFGRAPH_TEST_MODE === '0', { server });
  const hookEvents = Object.keys(hooks?.hooks ?? {});
  add('hook_surface', ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].every(x => hookEvents.includes(x)), { events: hookEvents });
  const componentFailures = [];
  for (const skill of ['research', 'graph']) {
    const rel = `skills/${skill}/SKILL.md`;
    const fm = frontmatter(await fs.readFile(path.join(ROOT, rel), 'utf8'));
    if (!fm || fm.name !== skill || fm['disable-model-invocation'] !== 'true' || !fm['allowed-tools'] || !fm['disallowed-tools']) {
      componentFailures.push({ file: rel, frontmatter: fm });
    }
  }
  for (const expected of [
    'planner', 'researcher', 'verifier', 'synthesizer',
    'graph-direct', 'graph-researcher', 'graph-planner', 'graph-developer',
    'graph-verifier', 'graph-verifier-deep', 'graph-synthesizer',
  ]) {
    const rel = `agents/${expected}.md`;
    const fm = frontmatter(await fs.readFile(path.join(ROOT, rel), 'utf8'));
    if (!fm || fm.name !== expected || !fm.tools || !fm.description || !fm.model) componentFailures.push({ file: rel, frontmatter: fm });
  }
  const orcaWorker = frontmatter(await fs.readFile(path.join(ROOT, 'skills/orca-worker/SKILL.md'), 'utf8'));
  if (!orcaWorker || orcaWorker.name !== 'orca-worker' || orcaWorker['user-invocable'] !== 'false' || orcaWorker['disable-model-invocation'] !== 'true') {
    componentFailures.push({ file: 'skills/orca-worker/SKILL.md', frontmatter: orcaWorker });
  }
  add('component_frontmatter', componentFailures.length === 0, { failures: componentFailures });

  const files = await walk(ROOT);
  const mjs = files.filter(f => f.endsWith('.mjs'));
  const syntaxFailures = [];
  for (const file of mjs) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) syntaxFailures.push({ file: path.relative(ROOT, file), error: r.stderr.trim() });
  }
  add('javascript_syntax', syntaxFailures.length === 0, { files_checked: mjs.length, failures: syntaxFailures });

  const importFailures = [];
  for (const file of mjs) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      const spec = match[2];
      if (!(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'))) importFailures.push({ file: path.relative(ROOT, file), specifier: spec });
    }
  }
  add('no_external_runtime_imports', importFailures.length === 0 && !pkg.dependencies, { failures: importFailures, dependencies: pkg.dependencies ?? null });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-preflight-'));
  const client = await new Client().start({ PROOFGRAPH_DATA_DIR: path.join(tmp, 'data'), PROOFGRAPH_PROJECT_DIR: path.join(tmp, 'project'), PROOFGRAPH_TEST_MODE: '0' });
  try {
    const before = await client.request('tools/list');
    add('mcp_requires_initialize', before.error?.code === -32002, { response: before.error ?? before.result });
    const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'preflight', version: pkg.version } });
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    const names = listed.result?.tools?.map(t => t.name) ?? [];
    add('mcp_initialize', init.result?.serverInfo?.name === 'proofgraph-claude' && init.result?.serverInfo?.version === pkg.version && init.result?.protocolVersion === '2025-11-25', { result: init.result });
    const requiredGraphTools = [
      'pg_graph_preview', 'pg_graph_start', 'pg_graph_get_status', 'pg_graph_claim_node',
      'pg_graph_complete_node', 'pg_graph_resolve_approval', 'pg_graph_expand',
      'pg_graph_get_report', 'pg_graph_verify_integrity', 'pg_graph_abort',
    ];
    add('mcp_tool_surface', names.length === 24 && requiredGraphTools.every(name => names.includes(name)) && !names.includes('pg_test_import_source') && new Set(names).size === names.length, { count: names.length, names });
    add('mcp_tool_schemas', (listed.result?.tools ?? []).every(t => t.inputSchema?.type === 'object' && t.outputSchema?.type === 'object'), {});
    const previewMessage = await client.request('tools/call', {
      name: 'pg_graph_preview',
      arguments: {
        objective: 'Compile a deterministic low-risk graph and verify the result before completion.',
        signals: { complexity: 10, uncertainty: 5, risk: 'low', requires_research: false, requires_implementation: false },
      },
    });
    const preview = previewMessage.result?.structuredContent;
    add('graph_compiler_preview', previewMessage.result?.isError === false && preview?.ok === true && preview?.graph_digest && preview?.assessment?.recommendation?.initial_route === 'direct', { preview });
  } finally { await client.close(); await fs.rm(tmp, { recursive: true, force: true }); }

  const platformTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-platform-preflight-'));
  const platformClient = await new Client().start({ PROOFGRAPH_DATA_DIR: path.join(platformTmp, 'data'), PROOFGRAPH_PROJECT_DIR: path.join(platformTmp, 'project') }, 'runtime/mcp/server.mjs');
  try {
    await fs.mkdir(path.join(platformTmp, 'project'), { recursive: true });
    const init = await platformClient.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'preflight-platform', version: pkg.version } });
    platformClient.notify('notifications/initialized');
    const listed = await platformClient.request('tools/list');
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    const required = ['proofgraph_compile', 'proofgraph_graph_validate', 'proofgraph_graph_start', 'proofgraph_graph_run', 'proofgraph_start', 'proofgraph_run', 'proofgraph_status', 'proofgraph_debug', 'proofgraph_inspect', 'proofgraph_templates', 'proofgraph_workspace_propose'];
    add('platform_mcp_initialize', init.result?.serverInfo?.name === 'proofgraph' && init.result?.serverInfo?.version === pkg.version, { result: init.result });
    add('platform_mcp_tool_surface', required.every((name) => names.includes(name)) && new Set(names).size === names.length, { count: names.length, names });
  } finally { await platformClient.close(); await fs.rm(platformTmp, { recursive: true, force: true }); }

  const hook = spawnSync(process.execPath, [path.join(ROOT, 'hooks/guard.mjs')], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify({ cwd: path.join(os.tmpdir(), 'proofgraph-no-run'), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    env: { ...process.env, PROOFGRAPH_DATA_DIR: path.join(os.tmpdir(), `pg-empty-${process.pid}`), PROOFGRAPH_PROJECT_DIR: path.join(os.tmpdir(), 'proofgraph-no-run') },
  });
  add('hook_no_active_run_is_silent', hook.status === 0 && hook.stdout.trim() === '', { status: hook.status, stdout: hook.stdout.trim(), stderr: hook.stderr.trim() });

  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claudeVersion.error?.code === 'ENOENT') add('claude_cli_plugin_validation', true, { skipped: true, reason: 'claude CLI is not installed in this verification environment' });
  else {
    const validation = spawnSync('claude', ['plugin', 'validate', ROOT, '--strict'], { encoding: 'utf8', timeout: 30000 });
    add('claude_cli_plugin_validation', validation.status === 0, { skipped: false, version: claudeVersion.stdout.trim(), stdout: validation.stdout.trim(), stderr: validation.stderr.trim() });
  }
} catch (error) {
  add('preflight_internal', false, { error: error.stack || error.message });
}

const result = {
  product: 'proofgraph', version: productVersion, generated_at: new Date().toISOString(), root: ROOT,
  node: process.version, platform: `${process.platform}-${process.arch}`,
  passed: checks.filter(c => c.ok && !c.skipped).length,
  failed: checks.filter(c => !c.ok).length,
  skipped: checks.filter(c => c.skipped).length,
  total: checks.length,
  checks,
};
if (outputPath) { await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`); }
for (const check of checks) console.log(`${check.skipped ? 'SKIP' : check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.skipped ? ` — ${check.reason}` : ''}`);
console.log(`\n${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} total)`);
if (result.failed) process.exitCode = 1;
