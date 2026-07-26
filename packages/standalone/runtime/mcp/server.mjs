#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import { VERSION, PRODUCT_NAME } from '../version.mjs';
import { compileTaskSpec } from '../task-intelligence/task-spec.mjs';
import { buildOrganization } from '../organization/builders.mjs';
import { compileMission } from '../company/mission-compiler.mjs';
import { CompanyRuntime } from '../company/company-runtime.mjs';
import { AutonomousOrganizationOS } from '../os/autonomous-os.mjs';
import { assertFiniteJson } from '../core/canonical.mjs';
import { loadConfiguredModelRegistry } from '../intelligence/registry-loader.mjs';

const DATA_DIR = path.resolve(process.env.PROOFGRAPH_ORG_DATA ?? '.proofgraph-org');
const MODEL_REGISTRY = await loadConfiguredModelRegistry();
const company = new CompanyRuntime({ dataDir: DATA_DIR, modelRegistry: MODEL_REGISTRY });
const osRuntime = new AutonomousOrganizationOS({ dataDir: DATA_DIR, companyRuntime: company });
const MAX_LINE_BYTES = 2_000_000;
let initialized = false;

const tools = [
  ['pg2_compile_task', 'Compile a natural-language goal into a deterministic TaskSpec and verified Graph Blueprint.', { type: 'object', additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, signals: { type: 'object' }, deliverables: { type: 'array', items: { type: 'string' } }, acceptance_criteria: { type: 'array', items: { type: 'string' } } } }],
  ['pg2_build_organization', 'Build a bounded OrganizationSpec from a goal.', { type: 'object', additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, signals: { type: 'object' } } }],
  ['pg2_compile_mission', 'Compile a goal into Mission, Project, Sprint, WorkItem, Organization, and Graph Blueprint state.', { type: 'object', additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, signals: { type: 'object' } } }],
  ['pg2_create_mission', 'Create a persistent AI Company mission.', { type: 'object', additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, signals: { type: 'object' } } }],
  ['pg2_run_mission', 'Run or resume a mission until terminal state or an external approval gate.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' } } }],
  ['pg2_mission_status', 'Read mission state.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' } } }],
  ['pg2_mission_report', 'Read a mission report preserving failure and approval states.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' } } }],
  ['pg2_create_os_run', 'Create a bounded Autonomous Organization OS run.', { type: 'object', additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, signals: { type: 'object' }, max_cycles: { type: 'integer' } } }],
  ['pg2_run_os', 'Run bounded organization cycles until verified completion, failure, or approval.', { type: 'object', additionalProperties: false, required: ['os_run_id'], properties: { os_run_id: { type: 'string' } } }],
  ['pg2_os_report', 'Read an Organization OS report and improvement proposals.', { type: 'object', additionalProperties: false, required: ['os_run_id'], properties: { os_run_id: { type: 'string' } } }],
  ['pg4_intelligence_status', 'Read bounded Context, Model Routing, Collaboration, Knowledge, Memory, and Verification status for a mission.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' } } }],
  ['pg4_context', 'Read role-minimized ContextPacket summaries for a mission or work item.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' }, work_item_id: { type: 'string' }, include_sections: { type: 'boolean' } } }],
  ['pg4_model_routes', 'Read exact model route decisions and fallback chains.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' }, work_item_id: { type: 'string' } } }],
  ['pg4_model_observations', 'Read immutable model execution observations and aggregate health evidence without changing routing policy.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' }, work_item_id: { type: 'string' }, model_id: { type: 'string' } } }],
  ['pg4_contracts', 'Read versioned WorkContract and Handoff status.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' }, status: { type: 'string' } } }],
  ['pg4_impact', 'Run bounded Knowledge Graph impact analysis from explicit source IDs.', { type: 'object', additionalProperties: false, required: ['mission_id', 'source_ids'], properties: { mission_id: { type: 'string' }, source_ids: { type: 'array', items: { type: 'string' } }, max_depth: { type: 'integer' } } }],
  ['pg4_memory', 'Retrieve verified Organization Memory for the current mission.', { type: 'object', additionalProperties: false, required: ['mission_id', 'query'], properties: { mission_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } }],
  ['pg4_intelligence_verification', 'Read Intelligence Fabric verification reports and terminal gate state.', { type: 'object', additionalProperties: false, required: ['mission_id'], properties: { mission_id: { type: 'string' } } }],
  ['pg2_verify_integrity', 'Verify mission or OS state, event chain, and artifacts.', { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { enum: ['mission', 'os'] }, id: { type: 'string' } } }],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function validateTopLevel(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (schema.additionalProperties === false && unknown.length) throw new Error(`Unknown tool arguments: ${unknown.join(', ')}`);
  for (const name of schema.required ?? []) if (!(name in args)) throw new Error(`Missing required argument: ${name}`);
  assertFiniteJson(args);
}

async function invoke(name, args) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateTopLevel(args, tool.inputSchema);
  if (name === 'pg2_compile_task') return compileTaskSpec(args);
  if (name === 'pg2_build_organization') return buildOrganization(compileTaskSpec(args));
  if (name === 'pg2_compile_mission') return compileMission(args);
  if (name === 'pg2_create_mission') return company.create(args);
  if (name === 'pg2_run_mission') return company.run(args.mission_id);
  if (name === 'pg2_mission_status') return company.status(args.mission_id);
  if (name === 'pg2_mission_report') return company.report(args.mission_id);
  if (name === 'pg2_create_os_run') return osRuntime.create(args);
  if (name === 'pg2_run_os') return osRuntime.run(args.os_run_id);
  if (name === 'pg2_os_report') return osRuntime.report(args.os_run_id);
  if (name.startsWith('pg4_')) {
    const state = await company.status(args.mission_id);
    if (!state.intelligence || !company.intelligence) throw new Error('Mission has no Intelligence Fabric state');
    const intelligence = state.intelligence;
    if (name === 'pg4_intelligence_status') return {
      mission_id: args.mission_id,
      fabric_version: intelligence.fabric_version,
      model_registry_version: intelligence.model_registry_version,
      stats: intelligence.stats,
      counts: {
        contexts: intelligence.context_packets.length, routes: intelligence.route_decisions.length, observations: intelligence.model_observations?.length ?? 0,
        contracts: intelligence.contracts.length, handoffs: intelligence.handoffs.length,
        impacts: intelligence.impacts.length, recalled_memory: intelligence.memory_recalled.length,
        captured_memory: intelligence.memory_captured.length, verifications: intelligence.verifications.length,
      },
      current_by_work_item: intelligence.current_by_work_item,
      knowledge: { graph_id: intelligence.knowledge_graph.graph_id, revision: intelligence.knowledge_graph.revision, node_count: intelligence.knowledge_graph.nodes.length, edge_count: intelligence.knowledge_graph.edges.length, digest: intelligence.knowledge_graph.digest },
      digest: intelligence.digest,
    };
    if (name === 'pg4_context') {
      const packets = intelligence.context_packets.filter((item) => !args.work_item_id || item.work_item_id === args.work_item_id).slice(-100);
      return packets.map((item) => ({
        packet_id: item.packet_id, work_item_id: item.work_item_id, role_id: item.role_id, role_type: item.role_type,
        classification: item.classification, byte_size: item.byte_size, token_estimate: item.token_estimate,
        sections: args.include_sections ? item.sections : Object.keys(item.sections ?? {}), source_count: item.sources.length,
        stale_source_count: item.stale_source_count ?? 0, unknown_freshness_source_count: item.unknown_freshness_source_count ?? 0,
        redactions: item.redactions, dropped_sections: item.dropped_sections, digest: item.digest,
      }));
    }
    if (name === 'pg4_model_routes') return intelligence.route_decisions.filter((item) => !args.work_item_id || item.work_item_id === args.work_item_id).slice(-100);
    if (name === 'pg4_model_observations') {
      const observations = (intelligence.model_observations ?? []).filter((item) => (!args.work_item_id || item.work_item_id === args.work_item_id) && (!args.model_id || item.model_id === args.model_id)).slice(-500);
      return { observations, model_summary: company.intelligence.router.summarizeObservations(observations) };
    }
    if (name === 'pg4_contracts') return {
      contracts: intelligence.contracts.filter((item) => !args.status || item.status === args.status).slice(-500),
      handoffs: intelligence.handoffs.slice(-500),
    };
    if (name === 'pg4_impact') return company.intelligence.knowledge.impact(intelligence.knowledge_graph, { source_ids: args.source_ids, max_depth: Math.min(5, Math.max(1, Number(args.max_depth ?? 2))) });
    if (name === 'pg4_memory') return company.intelligence.memory.retrieve({ query: args.query, mission_id: args.mission_id, classification: 'internal', limit: Math.min(50, Math.max(1, Number(args.limit ?? 12))) });
    if (name === 'pg4_intelligence_verification') return intelligence.verifications.slice(-200);
  }
  if (name === 'pg2_verify_integrity') return args.kind === 'mission' ? company.verifyIntegrity(args.id) : osRuntime.verifyIntegrity(args.id);
  throw new Error(`Unhandled tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message, data = null) { send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } }); }

async function handle(message) {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message.id, -32600, 'Invalid Request');
  if (!initialized && message.method !== 'initialize') return error(message.id, -32002, 'Server not initialized');
  if (message.method === 'initialize') {
    initialized = true;
    return result(message.id, { protocolVersion: message.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: PRODUCT_NAME, title: 'ProofGraph Intelligence Fabric', version: VERSION } });
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') return result(message.id, { tools });
  if (message.method === 'tools/call') {
    try {
      const value = await invoke(message.params?.name, message.params?.arguments ?? {});
      return result(message.id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false });
    } catch (err) {
      return result(message.id, { content: [{ type: 'text', text: `${err.name ?? 'Error'}: ${err.message}` }], isError: true });
    }
  }
  if (message.method.startsWith('notifications/')) return;
  return error(message.id, -32601, 'Method not found');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return error(null, -32600, 'Request exceeds maximum line size');
  let message;
  try { message = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
  try { await handle(message); } catch (err) { error(message.id, -32603, err.message); }
});
