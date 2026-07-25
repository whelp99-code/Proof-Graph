#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createPlatform } from '../runtime/platform.mjs';

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return flags;
}
const flags = parse(process.argv.slice(2));
const adapter = flags.adapter;
if (!adapter) throw new Error('Usage: npm run canary -- --adapter <name> [--project DIR] [--objective TEXT] [--template NAME]');
const projectDir = path.resolve(flags.project ?? process.cwd());
const platform = await createPlatform({ projectDir });
const doctor = await platform.registry.doctor();
const selected = doctor.find((item) => item.name === adapter);
if (!selected) throw new Error(`Unknown adapter: ${adapter}`);
if (!['ready', 'ready_for_canary'].includes(selected.status) || selected.invocable !== true) {
  throw new Error(`Adapter ${adapter} is not invocable for canary: ${selected.status}. Enable, install, and authenticate it in proofgraph.config.json first.`);
}
const objective = flags.objective ?? 'Inspect this repository and return one verified, low-risk engineering observation without modifying files.';
let input = { objective, mode: 'review', signals: { complexity: 20, uncertainty: 20, risk: 'low', requires_research: false, requires_implementation: false, estimated_subtasks: 1 } };
if (flags.template) { const { template: _template, ...applied } = platform.templates.apply(flags.template, input); input = applied; }
const result = await platform.kernel.run(input, { adapter });
const output = { adapter, doctor: selected, result, release_gate: result.status === 'finalized' && result.integrity?.ok ? 'CANARY_PASS' : 'CANARY_FAIL' };
const rendered = `${JSON.stringify(output, null, 2)}\n`;
if (flags.output) {
  const outputPath = path.resolve(flags.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, rendered, { mode: 0o600 });
}
process.stdout.write(rendered);
if (output.release_gate !== 'CANARY_PASS') process.exitCode = 1;
