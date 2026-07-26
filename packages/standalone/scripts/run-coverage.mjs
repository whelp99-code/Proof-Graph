#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const args = ['--test', '--test-reporter=spec', '--experimental-test-coverage', '--test-coverage-include=runtime/**/*.mjs', '--test-coverage-include=bin/*.mjs', 'tests/**/*.test.mjs'];
const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 80_000_000 });
if (run.status !== 0) { process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? ''); process.exit(run.status ?? 1); }
const text = run.stdout;
const metric = text.match(/all files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/);
const tests = text.match(/ℹ tests\s+(\d+)/); const passed = text.match(/ℹ pass\s+(\d+)/); const failed = text.match(/ℹ fail\s+(\d+)/);
if (!metric || !tests || !passed || !failed) throw new Error('Unable to parse Node coverage output');
const summary = {
  schema_version: 2, version: pkg.version, runner: `node ${process.versions.node}`,
  scope: ['runtime/**/*.mjs', 'bin/*.mjs'], tests: Number(tests[1]), passed: Number(passed[1]), failed: Number(failed[1]),
  coverage: { line_pct: Number(metric[1]), branch_pct: Number(metric[2]), function_pct: Number(metric[3]) },
  thresholds: { line_pct: 90, branch_pct: 75, function_pct: 90 },
};
summary.thresholds_passed = summary.failed === 0 && summary.coverage.line_pct >= summary.thresholds.line_pct && summary.coverage.branch_pct >= summary.thresholds.branch_pct && summary.coverage.function_pct >= summary.thresholds.function_pct;
summary.digest = crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
const output = path.join(ROOT, 'verification', 'COVERAGE_SUMMARY.json');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`); if (!summary.thresholds_passed) process.exitCode = 1;
