#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { renderExecutionGraph } from '../runtime/operator/graph-layout.mjs';
import { renderOperatorSnapshot } from '../runtime/operator/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'verification', 'OPERATOR_BENCHMARK.json');

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function graph(size = 1000) {
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `node-${String(index).padStart(4, '0')}`,
    label: index % 10 === 0 ? `Verify ${index}` : `Task ${index}`,
    kind: index % 10 === 0 ? 'verify' : 'develop',
    role_id: index % 10 === 0 ? 'independent-verifier' : 'developer',
    status: index < size - 4 ? 'completed' : index === size - 1 ? 'running' : 'ready',
    attempts: index % 83 === 0 ? 2 : 1,
    max_attempts: 3,
    sequence: index,
  }));
  const edges = [];
  for (let index = 1; index < size; index += 1) {
    edges.push({ kind: 'dependency', from: nodes[index - 1].id, to: nodes[index].id });
  }
  edges.push({ kind: 'retry', from: nodes[size - 2].id, to: nodes[size - 4].id, failure_type: 'implementation_error', iteration: 2, max_iterations: 3 });
  return { nodes, edges, active_node_ids: [nodes[size - 1].id], next_node_ids: [] };
}

const largeGraph = graph(1000);
const timeline = Array.from({ length: 10000 }, (_, index) => ({
  seq: index + 1,
  at: new Date(1720000000000 + index * 100).toISOString(),
  type: index % 200 === 0 ? 'route.changed' : 'node.progress',
  data: index % 200 === 0
    ? { from: 'verify', to: 'develop', iteration: 2, max_iterations: 3 }
    : { work_item_id: `node-${index % 1000}`, status: 'running' },
}));
const run = {
  run_id: 'benchmark-run', status: 'active', updated_at: new Date().toISOString(), quality_gate_passed: false,
  progress: { percent: 73 }, host: { name: 'OpenCode', status: 'connected' }, graph: largeGraph,
  current_node_ids: ['node-0999'], next_node_ids: [], timeline,
  failures: { unresolved: [] }, approvals: { pending: [] }, loop_summary: { total: 1 },
  artifacts: { verified: [], candidates: [] },
};

function measure(fn, iterations = 60) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    fn();
    values.push(performance.now() - started);
  }
  return {
    iterations,
    p50_ms: Number(percentile(values.slice(5), 50).toFixed(3)),
    p95_ms: Number(percentile(values.slice(5), 95).toFixed(3)),
    max_ms: Number(Math.max(...values.slice(5)).toFixed(3)),
  };
}

const results = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  cases: {
    graph_1000_nodes: measure(() => renderExecutionGraph(largeGraph, { width: 90, height: 34, maxVisibleNodes: 80 })),
    snapshot_1000_nodes_10000_events: measure(() => renderOperatorSnapshot({ runs: [run], width: 160, height: 48, view: 'graph' })),
    timeline_search_10000_events: measure(() => renderOperatorSnapshot({ runs: [run], width: 160, height: 48, view: 'timeline', query: 'route.changed' })),
  },
  thresholds_ms: { graph_p95: 2000, snapshot_p95: 2000, search_p95: 1000 },
};
results.passed = results.cases.graph_1000_nodes.p95_ms < results.thresholds_ms.graph_p95
  && results.cases.snapshot_1000_nodes_10000_events.p95_ms < results.thresholds_ms.snapshot_p95
  && results.cases.timeline_search_10000_events.p95_ms < results.thresholds_ms.search_p95;
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (!results.passed) process.exitCode = 1;
