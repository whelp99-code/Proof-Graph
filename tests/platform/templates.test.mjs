import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDynamicGraph } from '../../server/lib/graph-compiler.mjs';
import { createTemplateRegistry } from '../../runtime/templates/registry.mjs';

test('v1 registry exposes seven built-in software-engineering graphs', () => {
  const registry = createTemplateRegistry();
  assert.deepEqual(registry.list().map((item) => item.name), ['agent-tui', 'bugfix', 'feature', 'migration', 'refactor', 'research', 'security-audit']);
  assert.equal(registry.get('security-audit').signals.risk, 'high');
  assert.equal(registry.get('agent-tui').signals.requires_implementation, true);
  assert.equal(registry.match('AI 에이전트 TUI를 개발하라').name, 'agent-tui');
});

test('template application is deterministic and preserves explicit signal overrides', () => {
  const registry = createTemplateRegistry();
  const first = registry.apply('bugfix', { objective: 'Fix the authorization regression in the API', signals: { complexity: 80 } });
  const second = registry.apply('bugfix', { objective: 'Fix the authorization regression in the API', signals: { complexity: 80 } });
  assert.deepEqual(first, second);
  assert.equal(first.signals.complexity, 80);
  assert.match(first.objective, /Template success contract/);
  const { template, ...input } = first;
  const compiled = compileDynamicGraph(input);
  assert.equal(compiled.ok, true);
  assert.equal(template.name, 'bugfix');
});

test('agent-tui template supplies bounded domain workstreams without injecting graph code', () => {
  const registry = createTemplateRegistry();
  const applied = registry.apply('agent-tui', { objective: 'AI 에이전트 TUI를 개발하라' });
  assert.equal(applied.profile.template_name, 'agent-tui');
  assert.equal(applied.profile.research_workstreams.length, 6);
  assert.equal(applied.profile.implementation_workstreams.length, 6);
  assert.match(applied.objective, /Template acceptance tests/);
  assert.match(applied.objective, /Non-interactive snapshot mode/);
  const { template: _template, ...input } = applied;
  const compiled = compileDynamicGraph(input);
  assert.equal(compiled.assessment.profile.template_name, 'agent-tui');
  assert.equal(compiled.graph.nodes.filter((node) => node.kind === 'research').length, 6);
  assert.equal(compiled.graph.nodes.find((node) => node.node_id === 'plan').metadata.dynamic_join_node_id, 'develop');
  assert.deepEqual(compiled.graph.nodes.find((node) => node.node_id === 'verify').metadata.acceptance_tests, applied.profile.acceptance_tests);
});

test('custom templates reject prototype and unknown fields', () => {
  assert.throws(() => createTemplateRegistry({ unsafe: { title: 'Unsafe', description: 'x', mode: 'auto', evil: true } }), /unknown keys/);
  assert.throws(() => createTemplateRegistry(JSON.parse('{"__proto__":{"title":"bad","description":"bad"}}')), /Template name|Forbidden JSON key/);
});
