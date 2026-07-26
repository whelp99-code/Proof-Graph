#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { VERSION, PRODUCT_NAME, RELEASE_GATE } from '../runtime/version.mjs';
import { discoverWorkspace, compileTaskSpec, validateTaskSpec } from '../runtime/task-intelligence/index.mjs';
import { buildOrganization, validateOrganization } from '../runtime/organization/index.mjs';
import { compileMission, CompanyRuntime, ReferenceGraphKernelPort, HostBridgeGraphPort } from '../runtime/company/index.mjs';
import { AutonomousOrganizationOS } from '../runtime/os/index.mjs';
import { loadConfiguredModelRegistry } from '../runtime/intelligence/index.mjs';

function usage() {
  return `ProofGraph Organization OS v${VERSION}\n\nUsage:\n  proofgraph-org version\n  proofgraph-org workspace <path>\n  proofgraph-org task <objective> [--workspace <path>]\n  proofgraph-org organization <objective> [--workspace <path>]\n  proofgraph-org mission-plan <objective> [--workspace <path>]\n  proofgraph-org mission-create <objective> [--data-dir <path>]\n  proofgraph-org mission-run <objective> [--data-dir <path>]\n  proofgraph-org mission-status <mission_id> [--data-dir <path>]\n  proofgraph-org mission-resume <mission_id> [--data-dir <path>]\n  proofgraph-org mission-report <mission_id> [--data-dir <path>]\n  proofgraph-org mission-intelligence <mission_id> [summary|contexts|routes|observations|contracts|knowledge|memory|verification] [--full] [--data-dir <path>]\n  proofgraph-org mission-impact <mission_id> <source_id...> [--depth <1-5>] [--data-dir <path>]\n  proofgraph-org mission-integrity <mission_id> [--data-dir <path>]\n  proofgraph-org mission-abort <mission_id> [reason] [--data-dir <path>]\n  proofgraph-org mission-recover <mission_id> [--older-than-ms <n>] [--data-dir <path>]\n  proofgraph-org mission-approve <mission_id> <approval_id> <challenge> <approved|denied> [--data-dir <path>]\n  proofgraph-org mission-delivery-propose <mission_id> [--target <name>] [--external] [--irreversible] [--data-dir <path>]\n  proofgraph-org mission-delivery-approve <mission_id> <approval_id> <challenge> <approved|denied> [--data-dir <path>]\n  proofgraph-org mission-delivery-execute <mission_id> <delivery_id> [--data-dir <path>]\n  proofgraph-org os-create <objective> [--data-dir <path>]\n  proofgraph-org os-run <os_run_id> [--data-dir <path>]\n  proofgraph-org os-approve <os_run_id> <approval_id> <challenge> <approved|denied> [--data-dir <path>]\n  proofgraph-org os-mission-approve <os_run_id> <approved|denied> [--data-dir <path>]\n  proofgraph-org os-report <os_run_id> [--data-dir <path>]\n  proofgraph-org os-integrity <os_run_id> [--data-dir <path>]\n  proofgraph-org os-abort <os_run_id> [reason] [--data-dir <path>]\n  proofgraph-org validate-task <file.json>\n  proofgraph-org validate-organization <file.json>\n\nHost Bridge options:\n  --bridge-url <url> --bridge-token <token> --host <opencode|pi|orca|custom>\n\nIntelligence options:\n  --model-registry <file.json> (or PROOFGRAPH_MODEL_REGISTRY)\n`;
}

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    const [name, inline] = item.slice(2).split('=', 2);
    if (inline != null) flags[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[name] = argv[++index];
    else flags[name] = true;
  }
  return { positionals, flags };
}

function dataDir(flags) { return path.resolve(flags['data-dir'] ?? process.env.PROOFGRAPH_ORG_DATA ?? '.proofgraph-org'); }
async function workspace(flags) { return flags.workspace ? discoverWorkspace(path.resolve(flags.workspace)) : null; }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function modelRegistry(flags) { return loadConfiguredModelRegistry({ filePath: flags['model-registry'] }); }

function graphPort(flags) {
  if (!flags['bridge-url']) return new ReferenceGraphKernelPort();
  return new HostBridgeGraphPort({
    url: flags['bridge-url'],
    token: flags['bridge-token'] ?? process.env.PROOFGRAPH_HOST_TOKEN,
    host: flags.host ?? 'opencode',
  });
}

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const command = positionals.shift();
  if (!command || ['help', '-h', '--help'].includes(command)) { process.stdout.write(usage()); return; }
  if (command === 'version') { print({ product: PRODUCT_NAME, version: VERSION, release_gate: RELEASE_GATE }); return; }
  if (command === 'workspace') { const root = positionals.join(' '); if (!root) throw new Error('workspace requires a path'); print(await discoverWorkspace(root)); return; }
  if (command === 'validate-task') { const value = JSON.parse(await fs.readFile(positionals[0], 'utf8')); print({ ok: validateTaskSpec(value) }); return; }
  if (command === 'validate-organization') { const value = JSON.parse(await fs.readFile(positionals[0], 'utf8')); print({ ok: validateOrganization(value) }); return; }
  const configuredModelRegistry = await modelRegistry(flags);
  if (['task', 'organization', 'mission-plan', 'mission-create', 'mission-run', 'os-create'].includes(command)) {
    const objective = positionals.join(' ').trim();
    if (!objective) throw new Error(`${command} requires an objective`);
    const input = { objective, workspace: await workspace(flags) };
    if (command === 'task') { print(compileTaskSpec(input)); return; }
    if (command === 'organization') { print(buildOrganization(compileTaskSpec(input))); return; }
    if (command === 'mission-plan') { print(compileMission(input)); return; }
    if (command === 'os-create') {
      const os = new AutonomousOrganizationOS({ dataDir: dataDir(flags), companyRuntime: new CompanyRuntime({ dataDir: dataDir(flags), graphPort: graphPort(flags), modelRegistry: configuredModelRegistry }) });
      print(await os.create(input)); return;
    }
    const runtime = new CompanyRuntime({ dataDir: dataDir(flags), graphPort: graphPort(flags), modelRegistry: configuredModelRegistry });
    const created = await runtime.create(input);
    if (command === 'mission-create') { print(created); return; }
    print(await runtime.run(created.mission.mission_id)); return;
  }
  if (command.startsWith('mission-')) {
    const missionId = positionals.shift(); if (!missionId) throw new Error(`${command} requires mission_id`);
    const runtime = new CompanyRuntime({ dataDir: dataDir(flags), graphPort: graphPort(flags), modelRegistry: configuredModelRegistry });
    if (command === 'mission-status') { print(await runtime.status(missionId)); return; }
    if (command === 'mission-resume') { print(await runtime.run(missionId)); return; }
    if (command === 'mission-report') { print(await runtime.report(missionId)); return; }
    if (command === 'mission-intelligence') {
      const section = positionals.shift() ?? 'summary';
      const state = await runtime.status(missionId);
      if (!state.intelligence || !runtime.intelligence) throw new Error('Mission has no Intelligence Fabric state');
      const intelligence = state.intelligence;
      if (section === 'summary') {
        print({
          fabric_version: intelligence.fabric_version,
          model_registry_version: intelligence.model_registry_version,
          stats: intelligence.stats,
          counts: {
            contexts: intelligence.context_packets.length, routes: intelligence.route_decisions.length, observations: intelligence.model_observations?.length ?? 0,
            contracts: intelligence.contracts.length, handoffs: intelligence.handoffs.length,
            impacts: intelligence.impacts.length, recalled_memory: intelligence.memory_recalled.length,
            captured_memory: intelligence.memory_captured.length, verifications: intelligence.verifications.length,
          },
          knowledge: { graph_id: intelligence.knowledge_graph.graph_id, revision: intelligence.knowledge_graph.revision, nodes: intelligence.knowledge_graph.nodes.length, edges: intelligence.knowledge_graph.edges.length, digest: intelligence.knowledge_graph.digest },
          digest: intelligence.digest,
        }); return;
      }
      if (section === 'contexts') { print(flags.full ? intelligence.context_packets : intelligence.context_packets.map((item) => ({ packet_id: item.packet_id, work_item_id: item.work_item_id, role_type: item.role_type, byte_size: item.byte_size, token_estimate: item.token_estimate, sections: Object.keys(item.sections ?? {}), stale_source_count: item.stale_source_count ?? 0, unknown_freshness_source_count: item.unknown_freshness_source_count ?? 0, redactions: item.redactions.length, digest: item.digest }))); return; }
      if (section === 'routes') { print(intelligence.route_decisions); return; }
      if (section === 'observations') { print({ observations: intelligence.model_observations ?? [], model_summary: runtime.intelligence.router.summarizeObservations(intelligence.model_observations ?? []) }); return; }
      if (section === 'contracts') { print({ contracts: intelligence.contracts, handoffs: intelligence.handoffs }); return; }
      if (section === 'knowledge') { print(flags.full ? intelligence.knowledge_graph : { graph_id: intelligence.knowledge_graph.graph_id, revision: intelligence.knowledge_graph.revision, nodes: intelligence.knowledge_graph.nodes.length, edges: intelligence.knowledge_graph.edges.length, impacts: intelligence.impacts, digest: intelligence.knowledge_graph.digest }); return; }
      if (section === 'memory') { const memory = await runtime.intelligence.memory.ensure(); print(flags.full ? memory : { entries: memory.entries.map((item) => ({ memory_id: item.memory_id, kind: item.kind, title: item.title, status: item.status, confidence: item.confidence, verified_by: item.verified_by, valid_at: item.valid_at, digest: item.digest })), recalled: intelligence.memory_recalled, captured: intelligence.memory_captured }); return; }
      if (section === 'verification') { print(intelligence.verifications); return; }
      throw new Error(`Unknown intelligence section: ${section}`);
    }
    if (command === 'mission-impact') {
      const sourceIds = positionals.filter(Boolean); if (!sourceIds.length) throw new Error('mission-impact requires at least one source_id');
      const state = await runtime.status(missionId); if (!state.intelligence || !runtime.intelligence) throw new Error('Mission has no Intelligence Fabric state');
      print(runtime.intelligence.knowledge.impact(state.intelligence.knowledge_graph, { source_ids: sourceIds, max_depth: Math.min(5, Math.max(1, Number(flags.depth ?? 2))) })); return;
    }
    if (command === 'mission-integrity') { print(await runtime.verifyIntegrity(missionId)); return; }
    if (command === 'mission-abort') { print(await runtime.abort(missionId, positionals.join(' ') || 'operator abort', 'external-human')); return; }
    if (command === 'mission-recover') { print(await runtime.recoverInterrupted(missionId, { olderThanMs: Number(flags['older-than-ms'] ?? 0), actor: 'external-operator' })); return; }
    if (command === 'mission-approve') {
      const [approval_id, challenge, decision] = positionals;
      if (!approval_id || !challenge || !decision) throw new Error('mission-approve requires approval_id challenge approved|denied');
      print(await runtime.decide(missionId, { approval_id, challenge, decision, actor: 'external-human', decision_source: 'proofgraph-cli' })); return;
    }
    if (command === 'mission-delivery-propose') {
      print(await runtime.proposeDelivery(missionId, {
        target: flags.target ?? 'local-review',
        external_effect: flags.external === true || flags.external === 'true',
        reversible: !(flags.irreversible === true || flags.irreversible === 'true'),
      })); return;
    }
    if (command === 'mission-delivery-approve') {
      const [approval_id, challenge, decision] = positionals;
      if (!approval_id || !challenge || !decision) throw new Error('mission-delivery-approve requires approval_id challenge approved|denied');
      print(await runtime.decideDelivery(missionId, { approval_id, challenge, decision, actor: 'external-human', decision_source: 'proofgraph-cli' })); return;
    }
    if (command === 'mission-delivery-execute') {
      const [deliveryId] = positionals;
      if (!deliveryId) throw new Error('mission-delivery-execute requires delivery_id');
      print(await runtime.executeDelivery(missionId, deliveryId)); return;
    }
  }
  if (command.startsWith('os-')) {
    const osRunId = positionals.shift(); if (!osRunId) throw new Error(`${command} requires os_run_id`);
    const os = new AutonomousOrganizationOS({ dataDir: dataDir(flags), companyRuntime: new CompanyRuntime({ dataDir: dataDir(flags), graphPort: graphPort(flags), modelRegistry: configuredModelRegistry }) });
    if (command === 'os-run') { print(await os.run(osRunId)); return; }
    if (command === 'os-approve') {
      const [approval_id, challenge, decision] = positionals;
      if (!approval_id || !challenge || !decision) throw new Error('os-approve requires approval_id challenge approved|denied');
      print(await os.resolveOSApproval(osRunId, { approval_id, challenge, decision, actor: 'external-human', decision_source: 'proofgraph-cli' })); return;
    }
    if (command === 'os-mission-approve') {
      const [decision] = positionals;
      if (!decision) throw new Error('os-mission-approve requires approved|denied');
      print(await os.resolveMissionApproval(osRunId, { decision, actor: 'external-human', decision_source: 'proofgraph-cli' })); return;
    }
    if (command === 'os-report') { print(await os.report(osRunId)); return; }
    if (command === 'os-integrity') { print(await os.verifyIntegrity(osRunId)); return; }
    if (command === 'os-abort') { print(await os.abort(osRunId, positionals.join(' ') || 'operator abort', 'external-human')); return; }
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.name ?? 'Error'}: ${error.message}\n`);
  if (process.env.PROOFGRAPH_DEBUG === '1' && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
