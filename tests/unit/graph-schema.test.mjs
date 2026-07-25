import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRAPH_NODE_KINDS,
  GRAPH_ROLES,
  GRAPH_RISKS,
  GRAPH_MODEL_TIERS,
  GRAPH_TOOLS,
  GRAPH_FAILURE_TYPES,
  GRAPH_ROUTES,
  validateGraphSpec,
} from '../../server/lib/graph-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = path.join(ROOT, 'schemas/graphspec-v1.schema.json');
const EXAMPLE = path.join(ROOT, 'examples/graphs/ai-agent-tui.graph.json');

const enumAt = (schema, pathParts) => pathParts.reduce((value, key) => value[key], schema).enum;

test('GraphSpec interchange schema tracks the runtime bounded vocabulary', async () => {
  const schema = JSON.parse(await fs.readFile(SCHEMA, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema_version.const, 1);
  assert.deepEqual(enumAt(schema, ['$defs', 'node', 'properties', 'kind']), [...GRAPH_NODE_KINDS]);
  assert.deepEqual(enumAt(schema, ['$defs', 'node', 'properties', 'role']), [...GRAPH_ROLES]);
  assert.deepEqual(enumAt(schema, ['$defs', 'node', 'properties', 'risk']), [...GRAPH_RISKS]);
  assert.deepEqual(enumAt(schema, ['$defs', 'node', 'properties', 'model_tier']), [...GRAPH_MODEL_TIERS]);
  assert.deepEqual(enumAt(schema, ['$defs', 'node', 'properties', 'tool_policy', 'items']), [...GRAPH_TOOLS]);
  const conditionVariants = schema.$defs.condition.oneOf;
  const failureVariant = conditionVariants.find((item) => item.properties.type.const === 'failure_type');
  const routeVariant = conditionVariants.find((item) => item.properties.type.const === 'route');
  assert.deepEqual(failureVariant.properties.value.enum, [...GRAPH_FAILURE_TYPES]);
  assert.deepEqual(routeVariant.properties.value.enum, [...GRAPH_ROUTES]);
});

test('AI Agent TUI explicit GraphSpec validates under the authoritative runtime', async () => {
  const graph = JSON.parse(await fs.readFile(EXAMPLE, 'utf8'));
  const validated = validateGraphSpec(graph);
  assert.equal(validated.spec.schema_version, 1);
  assert.equal(validated.analysis.node_count, 14);
  assert.equal(validated.spec.policy.require_verification_for_success, true);
  assert.equal(validated.spec.policy.allow_workspace_mutation, false);
  assert.equal(validated.spec.policy.allow_shell, false);
  assert.match(validated.spec.objective, /approve or deny pending approvals/i);
});
