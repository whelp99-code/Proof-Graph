import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { BudgetError, IntegrityError, ValidationError } from '../core/errors.mjs';
import { arrayValue, enumValue, plainObject, stringValue } from '../core/validate.mjs';
import { KNOWLEDGE_EDGE_KINDS, KNOWLEDGE_GRAPH_SCHEMA, KNOWLEDGE_NODE_KINDS } from './domain.mjs';

const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

function graphDigest(graph) { const copy = cloneJson(graph); delete copy.digest; return sha256(copy); }
function nowIso() { return new Date().toISOString(); }

function nodeId(kind, externalId) { return deterministicId('kg', { kind, external_id: externalId }, 24); }
function edgeId(from, to, kind, sourceRef) { return deterministicId('edge', { from, to, kind, source_ref: sourceRef ?? null }, 24); }

function normalizeNode(raw, index) {
  plainObject(raw, `nodes[${index}]`);
  const kind = enumValue(raw.kind, KNOWLEDGE_NODE_KINDS, `nodes[${index}].kind`);
  const externalId = stringValue(raw.external_id ?? raw.id, `nodes[${index}].external_id`, { max: 500 });
  return {
    node_id: raw.node_id ?? nodeId(kind, externalId),
    kind,
    external_id: externalId,
    label: stringValue(raw.label ?? externalId, `nodes[${index}].label`, { max: 500 }),
    criticality: enumValue(raw.criticality ?? 'low', Object.keys(SEVERITY_RANK), `nodes[${index}].criticality`),
    attributes: cloneJson(raw.attributes ?? {}),
    provenance: cloneJson(raw.provenance ?? []),
    updated_at: raw.updated_at ?? nowIso(),
  };
}

function normalizeEdge(raw, index) {
  plainObject(raw, `edges[${index}]`);
  const kind = enumValue(raw.kind, KNOWLEDGE_EDGE_KINDS, `edges[${index}].kind`);
  const from = stringValue(raw.from, `edges[${index}].from`, { max: 200 });
  const to = stringValue(raw.to, `edges[${index}].to`, { max: 200 });
  if (from === to && kind !== 'relates_to') throw new ValidationError('Self edge is not allowed for this relation');
  return {
    edge_id: raw.edge_id ?? edgeId(from, to, kind, raw.source_ref),
    from,
    to,
    kind,
    severity: enumValue(raw.severity ?? 'low', Object.keys(SEVERITY_RANK), `edges[${index}].severity`),
    source_ref: raw.source_ref == null ? null : cloneJson(raw.source_ref),
    attributes: cloneJson(raw.attributes ?? {}),
    created_at: raw.created_at ?? nowIso(),
  };
}

export class KnowledgeGraphRuntime {
  constructor({ maxNodes = 5000, maxEdges = 15000, maxDepth = 5, maxImpactResults = 500 } = {}) {
    this.maxNodes = maxNodes; this.maxEdges = maxEdges; this.maxDepth = maxDepth; this.maxImpactResults = maxImpactResults;
  }

  create({ mission_id }) {
    const graph = {
      schema: KNOWLEDGE_GRAPH_SCHEMA,
      schema_version: 1,
      graph_id: deterministicId('knowledge', { mission_id }),
      mission_id: stringValue(mission_id, 'mission_id', { max: 200 }),
      revision: 0,
      nodes: [],
      edges: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    graph.digest = graphDigest(graph);
    return deepFreeze(graph);
  }

  update(rawGraph, { nodes = [], edges = [] }) {
    this.verify(rawGraph);
    const graph = cloneJson(rawGraph);
    const byNode = new Map(graph.nodes.map((item) => [item.node_id, item]));
    const byExternal = new Map(graph.nodes.map((item) => [`${item.kind}:${item.external_id}`, item.node_id]));
    for (const raw of arrayValue(nodes, 'nodes', { max: 1000 })) {
      const normalized = normalizeNode(raw, graph.nodes.length);
      const existingId = byExternal.get(`${normalized.kind}:${normalized.external_id}`);
      if (existingId) {
        const existing = byNode.get(existingId);
        existing.label = normalized.label;
        existing.criticality = SEVERITY_RANK[normalized.criticality] > SEVERITY_RANK[existing.criticality] ? normalized.criticality : existing.criticality;
        existing.attributes = { ...existing.attributes, ...normalized.attributes };
        existing.provenance = [...existing.provenance, ...normalized.provenance].slice(-64);
        existing.updated_at = nowIso();
      } else {
        byNode.set(normalized.node_id, normalized); byExternal.set(`${normalized.kind}:${normalized.external_id}`, normalized.node_id); graph.nodes.push(normalized);
      }
    }
    if (graph.nodes.length > this.maxNodes) throw new BudgetError('Knowledge Graph node bound exceeded');
    const knownIds = new Set(graph.nodes.map((item) => item.node_id));
    const byEdge = new Map(graph.edges.map((item) => [item.edge_id, item]));
    for (const raw of arrayValue(edges, 'edges', { max: 3000 })) {
      const normalized = normalizeEdge({ ...raw, from: byExternal.get(raw.from) ?? raw.from, to: byExternal.get(raw.to) ?? raw.to }, graph.edges.length);
      if (!knownIds.has(normalized.from) || !knownIds.has(normalized.to)) throw new ValidationError(`Knowledge edge references unknown node: ${normalized.edge_id}`);
      if (!byEdge.has(normalized.edge_id)) { byEdge.set(normalized.edge_id, normalized); graph.edges.push(normalized); }
    }
    if (graph.edges.length > this.maxEdges) throw new BudgetError('Knowledge Graph edge bound exceeded');
    graph.revision += 1; graph.updated_at = nowIso(); delete graph.digest; graph.digest = graphDigest(graph);
    return deepFreeze(graph);
  }

  ingestMission(rawGraph, mission) {
    const nodes = [
      { kind: 'task', external_id: mission.task.task_id, label: mission.objective, criticality: mission.task.risk === 'critical' ? 'critical' : mission.task.risk === 'high' ? 'high' : 'medium', provenance: [{ type: 'mission', id: mission.mission_id }] },
      ...mission.organization.roles.map((role) => ({ kind: 'role', external_id: role.role_id, label: role.name, criticality: role.role_type === 'human' ? 'high' : 'low', attributes: { role_type: role.role_type, department_id: role.department_id, independence_group: role.independence_group }, provenance: [{ type: 'organization', id: mission.organization.organization_id }] })),
      ...mission.work_items.map((item) => ({ kind: 'work_item', external_id: item.work_item_id, label: item.objective, criticality: item.kind === 'verify' || item.kind === 'human_approval' ? 'high' : 'medium', attributes: { kind: item.kind, stage_id: item.stage_id }, provenance: [{ type: 'mission', id: mission.mission_id }] })),
      ...mission.task.acceptance_criteria.map((criterion, index) => ({ kind: 'requirement', external_id: `${mission.task.task_id}:acceptance:${index + 1}`, label: criterion, criticality: 'medium', provenance: [{ type: 'task', id: mission.task.task_id }] })),
    ];
    let graph = this.update(rawGraph, { nodes });
    const idBy = new Map(graph.nodes.map((node) => [`${node.kind}:${node.external_id}`, node.node_id]));
    const edges = [];
    for (const item of mission.work_items) {
      edges.push({ from: idBy.get(`role:${item.assigned_role_id}`), to: idBy.get(`work_item:${item.work_item_id}`), kind: 'produces', severity: 'low', source_ref: { type: 'assignment', id: item.work_item_id } });
      edges.push({ from: idBy.get(`work_item:${item.work_item_id}`), to: idBy.get(`task:${mission.task.task_id}`), kind: 'relates_to', severity: 'medium', source_ref: { type: 'mission', id: mission.mission_id } });
      for (const dependency of item.dependencies) edges.push({ from: idBy.get(`work_item:${dependency}`), to: idBy.get(`work_item:${item.work_item_id}`), kind: 'depends_on', severity: 'medium', source_ref: { type: 'dependency', id: `${dependency}->${item.work_item_id}` } });
    }
    for (let index = 0; index < mission.task.acceptance_criteria.length; index += 1) edges.push({ from: idBy.get(`task:${mission.task.task_id}`), to: idBy.get(`requirement:${mission.task.task_id}:acceptance:${index + 1}`), kind: 'depends_on', severity: 'high', source_ref: { type: 'task', id: mission.task.task_id } });
    return this.update(graph, { edges });
  }

  ingestReport(rawGraph, { mission, workItem, report, artifacts = [] }) {
    let graph = rawGraph;
    const sourceRef = { type: 'report', id: report.run_id, digest: report.integrity?.report_digest ?? null };
    const nodes = [];
    const edges = [];
    const reportEntities = Array.isArray(report.output?.entities) ? report.output.entities.slice(0, 500) : [];
    for (const [index, entity] of reportEntities.entries()) {
      if (!entity || typeof entity !== 'object') continue;
      nodes.push({ kind: entity.kind, external_id: entity.id ?? entity.external_id, label: entity.label ?? entity.id, criticality: entity.criticality ?? 'low', attributes: entity.attributes ?? {}, provenance: [sourceRef] });
    }
    const addNamed = (kind, values) => {
      for (const value of (Array.isArray(values) ? values : []).slice(0, 500)) {
        const id = typeof value === 'string' ? value : value.id ?? value.path ?? value.name;
        if (typeof id === 'string') nodes.push({ kind, external_id: id, label: typeof value === 'string' ? value : value.label ?? value.name ?? id, criticality: value.criticality ?? 'medium', attributes: typeof value === 'object' ? value : {}, provenance: [sourceRef] });
      }
    };
    addNamed('file', report.output?.changed_files ?? report.output?.files);
    addNamed('api', report.output?.apis);
    addNamed('service', report.output?.services);
    addNamed('test', report.output?.tests);
    for (const artifact of artifacts.slice(0, 500)) nodes.push({ kind: 'artifact', external_id: artifact.artifact_id, label: artifact.name, criticality: workItem.kind === 'verify' ? 'high' : 'medium', attributes: { media_type: artifact.media_type, digest: artifact.digest }, provenance: [sourceRef] });
    graph = this.update(graph, { nodes });
    const idBy = new Map(graph.nodes.map((node) => [`${node.kind}:${node.external_id}`, node.node_id]));
    const workNode = idBy.get(`work_item:${workItem.work_item_id}`);
    for (const artifact of artifacts) {
      const artifactNode = idBy.get(`artifact:${artifact.artifact_id}`);
      if (workNode && artifactNode) edges.push({ from: workNode, to: artifactNode, kind: workItem.kind === 'verify' ? 'verifies' : 'produces', severity: workItem.kind === 'verify' ? 'high' : 'medium', source_ref: sourceRef });
    }
    for (const relation of (Array.isArray(report.output?.relations) ? report.output.relations : []).slice(0, 1000)) {
      if (!relation || typeof relation !== 'object') continue;
      const from = idBy.get(`${relation.from_kind}:${relation.from}`) ?? relation.from;
      const to = idBy.get(`${relation.to_kind}:${relation.to}`) ?? relation.to;
      if (from && to) edges.push({ from, to, kind: relation.kind, severity: relation.severity ?? 'medium', source_ref: sourceRef, attributes: relation.attributes ?? {} });
    }
    for (const node of nodes) {
      const entityNode = idBy.get(`${node.kind}:${node.external_id}`);
      if (workNode && entityNode && entityNode !== workNode && !edges.some((edge) => edge.from === workNode && edge.to === entityNode)) edges.push({ from: workNode, to: entityNode, kind: workItem.kind === 'verify' ? 'verifies' : 'modifies', severity: node.criticality ?? 'medium', source_ref: sourceRef });
    }
    return edges.length ? this.update(graph, { edges }) : graph;
  }

  impact(rawGraph, { source_ids, max_depth = this.maxDepth, include_edge_kinds = KNOWLEDGE_EDGE_KINDS }) {
    this.verify(rawGraph);
    const graph = rawGraph;
    const depthLimit = Math.min(this.maxDepth, Math.max(1, Number(max_depth) || 1));
    const sources = arrayValue(source_ids, 'source_ids', { min: 1, max: 100 }).map((id) => stringValue(id, 'source_id', { max: 500 }));
    const byExternal = new Map(graph.nodes.map((node) => [node.external_id, node.node_id]));
    const start = sources.map((id) => byExternal.get(id) ?? id).filter((id) => graph.nodes.some((node) => node.node_id === id));
    const adjacency = new Map();
    for (const edge of graph.edges) {
      if (!include_edge_kinds.includes(edge.kind)) continue;
      const list = adjacency.get(edge.from) ?? []; list.push(edge); adjacency.set(edge.from, list);
    }
    const queue = start.map((id) => ({ id, depth: 0, path: [id], severity: 'low' }));
    const seen = new Map(start.map((id) => [id, 0]));
    const results = [];
    while (queue.length && results.length < this.maxImpactResults) {
      const current = queue.shift();
      if (current.depth >= depthLimit) continue;
      for (const edge of adjacency.get(current.id) ?? []) {
        const nextDepth = current.depth + 1;
        if ((seen.get(edge.to) ?? Infinity) <= nextDepth) continue;
        seen.set(edge.to, nextDepth);
        const node = graph.nodes.find((item) => item.node_id === edge.to);
        const severity = SEVERITY_RANK[edge.severity] > SEVERITY_RANK[current.severity] ? edge.severity : current.severity;
        const finalSeverity = node && SEVERITY_RANK[node.criticality] > SEVERITY_RANK[severity] ? node.criticality : severity;
        const path = [...current.path, edge.to];
        const impact = {
          impact_id: deterministicId('impact', { graph: graph.digest, source: current.path[0], target: edge.to, path }),
          source_id: current.path[0], target_id: edge.to, target_external_id: node?.external_id ?? null, target_kind: node?.kind ?? 'unknown', depth: nextDepth, severity: finalSeverity, path, via_edge: edge.edge_id,
        };
        impact.digest = sha256(impact); results.push(impact); queue.push({ id: edge.to, depth: nextDepth, path, severity: finalSeverity });
      }
    }
    return results;
  }

  verify(graph) {
    plainObject(graph, 'knowledge_graph');
    if (graph.schema !== KNOWLEDGE_GRAPH_SCHEMA || graph.schema_version !== 1) throw new ValidationError('Unsupported Knowledge Graph schema');
    if (graph.digest !== graphDigest(graph)) throw new IntegrityError('Knowledge Graph digest mismatch');
    if (graph.nodes.length > this.maxNodes || graph.edges.length > this.maxEdges) throw new BudgetError('Knowledge Graph exceeds bound');
    const nodeIds = new Set(graph.nodes.map((item) => item.node_id));
    if (nodeIds.size !== graph.nodes.length) throw new ValidationError('Duplicate Knowledge Graph node');
    const edgeIds = new Set(graph.edges.map((item) => item.edge_id));
    if (edgeIds.size !== graph.edges.length) throw new ValidationError('Duplicate Knowledge Graph edge');
    for (const edge of graph.edges) if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new ValidationError(`Knowledge edge references missing node: ${edge.edge_id}`);
    return { ok: true, graph_id: graph.graph_id, revision: graph.revision, nodes: graph.nodes.length, edges: graph.edges.length, digest: graph.digest };
  }
}
