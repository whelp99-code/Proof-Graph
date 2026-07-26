import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compileTaskSpec, validateTaskSpec, discoverWorkspace, validateGraphAdequacy } from '../../runtime/task-intelligence/index.mjs';
import { ValidationError } from '../../runtime/core/errors.mjs';
import { tempDir, cleanup, jsonClone } from '../helpers.mjs';

test('simple low-risk objective compiles a direct verified blueprint', () => {
  const task = compileTaskSpec({ objective: 'Summarize this design in Korean' });
  assert.equal(task.archetype, 'direct');
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'direct'));
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'verify'));
});

test('feature objective compiles plan, develop, and verify stages', () => {
  const task = compileTaskSpec({ objective: 'Implement a bounded user authentication feature' });
  assert.equal(task.requires_implementation, true);
  assert.deepEqual(['plan', 'develop', 'verify'].map((kind) => task.blueprint.stages.some((stage) => stage.kind === kind)), [true, true, true]);
});

test('research objective produces bounded fan-out and all join', () => {
  const task = compileTaskSpec({ objective: 'Research and compare five agent orchestration approaches', signals: { estimated_subtasks: 12 } });
  const research = task.blueprint.stages.filter((stage) => stage.kind === 'research');
  assert.ok(research.length >= 2 && research.length <= 6);
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'join' && stage.join === 'all'));
});

test('high-risk external objective includes human approval', () => {
  const task = compileTaskSpec({ objective: 'Deploy a database migration to production', signals: { risk: 'high', external_effects: true } });
  assert.ok(task.blueprint.stages.some((stage) => stage.kind === 'human_approval'));
});

test('TaskSpec is deterministic', () => {
  const input = { objective: '구현 결과를 독립 검증하는 API를 개발하라', constraints: ['외부 배포 금지'] };
  assert.equal(compileTaskSpec(input).digest, compileTaskSpec(input).digest);
  assert.equal(compileTaskSpec(input).task_id, compileTaskSpec(input).task_id);
});

test('Task compiler rejects unknown inputs and invalid signals', () => {
  assert.throws(() => compileTaskSpec({ objective: 'Do something', arbitrary_graph: {} }), /unknown keys/);
  assert.throws(() => compileTaskSpec({ objective: 'Do something', signals: { complexity: 101 } }), /0\.\.100/);
});

test('Task compiler bounds workspace and metadata payloads', () => {
  assert.throws(() => compileTaskSpec({ objective: 'Implement a bounded feature', metadata: { blob: 'x'.repeat(256_100) } }), /metadata exceeds 256000 bytes/);
  assert.throws(() => compileTaskSpec({ objective: 'Implement a bounded feature', workspace: { snapshot: 'x'.repeat(2_000_100) } }), /workspace exceeds 2000000 bytes/);
});

test('TaskSpec digest validation detects mutation', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Research runtime safety controls' }));
  assert.equal(validateTaskSpec(task), true);
  task.risk = 'critical';
  assert.throws(() => validateTaskSpec(task), /digest mismatch/);
});

test('adequacy validator rejects verifier bypass', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Implement a small feature' }));
  task.blueprint.stages = task.blueprint.stages.filter((stage) => stage.kind !== 'verify');
  assert.throws(() => validateGraphAdequacy(task, task.blueprint), /missing_verifier/);
});

test('adequacy validator rejects missing approval for high risk', () => {
  const task = jsonClone(compileTaskSpec({ objective: 'Deploy a production change', signals: { risk: 'high', external_effects: true } }));
  task.blueprint.stages = task.blueprint.stages.filter((stage) => stage.kind !== 'human_approval');
  task.blueprint.edges = task.blueprint.edges.filter((edge) => edge.from !== 'human-approval' && edge.to !== 'human-approval');
  assert.throws(() => validateGraphAdequacy(task, task.blueprint), /approval_required/);
});

test('workspace discovery reports languages and package manager', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"sample","dependencies":{"react":"1"}}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  await fs.mkdir(path.join(dir, 'src')); await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export const x = 1;');
  const workspace = await discoverWorkspace(dir);
  assert.equal(workspace.languages.typescript, 1);
  assert.ok(workspace.package_managers.includes('npm'));
  assert.ok(workspace.frameworks.includes('react'));
});

test('workspace discovery ignores symlinks and excluded directories', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  await fs.mkdir(path.join(dir, 'node_modules')); await fs.writeFile(path.join(dir, 'node_modules', 'bad.js'), 'x');
  await fs.writeFile(path.join(dir, 'safe.js'), 'x');
  try { await fs.symlink('/etc/passwd', path.join(dir, 'escape')); } catch { /* platform may deny symlink */ }
  const workspace = await discoverWorkspace(dir);
  assert.deepEqual(workspace.sample_files.map((item) => item.path), ['safe.js']);
});

test('workspace discovery is bounded and reports truncation', async (t) => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  for (let index = 0; index < 5; index += 1) await fs.writeFile(path.join(dir, `${index}.js`), 'x');
  const workspace = await discoverWorkspace(dir, { maxFiles: 2 });
  assert.equal(workspace.file_count, 2);
  assert.equal(workspace.truncated, true);
});

test('task compiler evaluation harness measures deterministic expected behavior', async () => {
  const { evaluateTaskCompiler } = await import('../../runtime/task-intelligence/evaluation.mjs');
  const result = evaluateTaskCompiler([
    { case_id: 'direct', input: { objective: 'Summarize the document' }, expected: { archetype: 'direct', approval_required: false } },
    { case_id: 'high-risk', input: { objective: 'Deploy to production', signals: { risk: 'high', external_effects: true } }, expected: { approval_required: true } },
    { case_id: 'reject', input: { objective: 'x' }, expected: { reject: true } },
  ]);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
});
