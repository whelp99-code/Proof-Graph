#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OperatorClient, readOperatorToken, OperatorTUI, renderOperatorSnapshot } from '../runtime/operator/index.mjs';
import { VERSION, PRODUCT_NAME, RELEASE_GATE } from '../runtime/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function usage() { return `ProofGraph Operator v${VERSION}\n\nUsage:\n  proofgraph start [--new <objective>] [--data-dir <path>] [--model-registry <file.json>] [--provider-url <url> --provider-model <id>]
  proofgraph simulate --new <objective>  # explicit dry-run\n  proofgraph serve [--port 8742] [--data-dir <path>] [--model-registry <file.json>]\n  proofgraph tui [--new <objective>] [--url <url>]\n  proofgraph run <objective> [--type mission|organization_os]\n  proofgraph status [run_id]\n  proofgraph snapshot [--run <id>] [--view graph|org|cycles|timeline|failures|context|models|collaboration|knowledge|memory|verification]\n  proofgraph intelligence <run_id> [intelligence|context|routes|model-observations|contracts|knowledge|memory|verification] [--full]\n  proofgraph approvals\n  proofgraph hosts\n  proofgraph doctor [--opencode-url http://127.0.0.1:4096]\n  proofgraph install-opencode [--project <path>]\n  proofgraph stop\n  proofgraph version\n`; }
function parse(argv) {
  const flags = {}; const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline != null) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]; else flags[key] = true;
  }
  return { flags, positionals };
}
function dataDir(flags) { return path.resolve(flags['data-dir'] ?? process.env.PROOFGRAPH_ORG_DATA ?? '.proofgraph-org'); }
function url(flags) { return flags.url ?? process.env.PROOFGRAPH_CONTROL_URL ?? `http://127.0.0.1:${flags.port ?? 8742}`; }
async function health(baseUrl) { try { const response = await fetch(`${baseUrl}/v1/health`); return response.ok ? response.json() : null; } catch { return null; } }
async function waitHealth(baseUrl, attempts = 80) { for (let i = 0; i < attempts; i += 1) { const value = await health(baseUrl); if (value?.ok) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Control Plane did not start at ${baseUrl}`); }
async function waitStopped(baseUrl, attempts = 80) { for (let i = 0; i < attempts; i += 1) { if (!(await health(baseUrl))) return true; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Control Plane did not stop at ${baseUrl}`); }
async function client(flags) { return new OperatorClient({ url: url(flags), token: flags.token ?? await readOperatorToken(dataDir(flags)) }); }
function appendRuntimeFlags(args, flags) { for (const name of ['bridge-url','bridge-token','runtime-host','model-registry','provider-url','provider-model','provider-name','provider-key-env','provider-timeout-ms','sandbox-root','source-dir']) if (flags[name]) args.push(`--${name}`, String(flags[name])); for (const name of ['allow-remote-bridge','native-local','execute-tools']) if (flags[name] === true) args.push(`--${name}`); }

async function ensureDaemon(flags) {
  const baseUrl = url(flags); if (await health(baseUrl)) return { existing: true, url: baseUrl };
  const dir = dataDir(flags); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const log = fsSync.openSync(path.join(dir, 'proofgraphd.log'), 'a');
  const args = [path.join(ROOT, 'bin/proofgraphd.mjs'), '--data-dir', dir, '--port', String(flags.port ?? 8742)];
  appendRuntimeFlags(args, flags);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env }); child.unref(); fsSync.closeSync(log);
  await waitHealth(baseUrl); return { existing: false, url: baseUrl, pid: child.pid };
}

async function main() {
  const { flags, positionals } = parse(process.argv.slice(2)); const command = positionals.shift();
  if (!command || ['help', '-h', '--help'].includes(command)) { process.stdout.write(usage()); return; }
  if (command === 'version') { process.stdout.write(`${JSON.stringify({ product: PRODUCT_NAME, version: VERSION, release_gate: RELEASE_GATE }, null, 2)}\n`); return; }
  if (command === 'serve') { const args = [path.join(ROOT, 'bin/proofgraphd.mjs'), '--data-dir', dataDir(flags), '--port', String(flags.port ?? 8742)]; appendRuntimeFlags(args, flags); const child = spawn(process.execPath, args, { stdio: 'inherit' }); await new Promise((resolve) => child.on('exit', resolve)); return; }
  if (command === 'simulate') { flags.new ??= positionals.join(' ').trim(); if (!flags.new) throw new Error('simulate requires --new or an objective'); await ensureDaemon(flags); const api = await client(flags); const created = await api.createRun({ objective: String(flags.new), type: 'mission', auto_start: true }); process.stdout.write(`${JSON.stringify({ ...created, warning: 'SIMULATION ONLY — no real model or tools are invoked' }, null, 2)}\n`); return; }
  if (command === 'start' || command === 'tui') {
    if (command === 'start') await ensureDaemon(flags); else await waitHealth(url(flags));
    const api = await client(flags);
    if (flags.new) await api.createRun({ objective: String(flags.new), type: flags.type ?? 'mission', auto_start: true });
    const tui = new OperatorTUI({ client: api }); await tui.start(); return;
  }
  if (command === 'run') {
    await ensureDaemon(flags); const objective = positionals.join(' ').trim(); if (!objective) throw new Error('run requires an objective');
    const created = await (await client(flags)).createRun({ objective, type: flags.type ?? 'mission', auto_start: flags['no-start'] !== true });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`); return;
  }
  if (command === 'status') {
    await waitHealth(url(flags)); const api = await client(flags); const runId = positionals[0] ?? flags.run;
    const value = runId ? await api.run(runId) : await api.runs(); process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return;
  }
  if (command === 'snapshot') {
    await waitHealth(url(flags)); const api = await client(flags); let runs = await api.runs();
    if (flags.run) { const selected = await api.run(flags.run); runs = [selected, ...runs.filter((item) => item.run_id !== selected.run_id)]; }
    process.stdout.write(`${renderOperatorSnapshot({ runs, view: flags.view ?? 'graph', width: Number(flags.width ?? 120), height: Number(flags.height ?? 36) })}\n`); return;
  }
  if (command === 'intelligence') {
    await waitHealth(url(flags)); const runId = positionals.shift(); if (!runId) throw new Error('intelligence requires run_id');
    const section = positionals.shift() ?? 'intelligence'; const value = await (await client(flags)).intelligence(runId, section, { full: flags.full === true || flags.full === 'true' });
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return;
  }
  if (command === 'approvals') { await waitHealth(url(flags)); process.stdout.write(`${JSON.stringify(await (await client(flags)).approvals(), null, 2)}\n`); return; }
  if (command === 'hosts') { await waitHealth(url(flags)); process.stdout.write(`${JSON.stringify(await (await client(flags)).hosts(), null, 2)}\n`); return; }
  if (command === 'doctor') {
    const dir = dataDir(flags); const checks = [];
    checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, value: process.versions.node });
    try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.access(dir, fsSync.constants.R_OK | fsSync.constants.W_OK); checks.push({ name: 'data_dir', ok: true, value: dir }); } catch (error) { checks.push({ name: 'data_dir', ok: false, value: error.message }); }
    checks.push({ name: 'control_plane', ok: Boolean(await health(url(flags))), value: url(flags) });
    if (flags['opencode-url']) { try { const response = await fetch(`${flags['opencode-url'].replace(/\/$/, '')}/global/health`); checks.push({ name: 'opencode', ok: response.ok, value: await response.text() }); } catch (error) { checks.push({ name: 'opencode', ok: false, value: error.message }); } }
    process.stdout.write(`${JSON.stringify({ ok: checks.every((item) => item.ok || item.name === 'control_plane'), checks }, null, 2)}\n`); return;
  }
  if (command === 'install-opencode') {
    const project = path.resolve(flags.project ?? '.'); const source = path.join(ROOT, 'examples/opencode/.opencode'); const target = path.join(project, '.opencode');
    await fs.mkdir(path.join(target, 'plugins'), { recursive: true }); await fs.mkdir(path.join(target, 'commands'), { recursive: true });
    await fs.copyFile(path.join(source, 'plugins/proofgraph-observer.js'), path.join(target, 'plugins/proofgraph-observer.js'));
    for (const name of ['pg-status.md', 'pg-flow.md', 'pg-approvals.md', 'pg-run.md']) await fs.copyFile(path.join(source, 'commands', name), path.join(target, 'commands', name));
    const tokens = { control_url: url(flags), host_token_file: path.join(dataDir(flags), '.host-ingest-token') };
    await fs.writeFile(path.join(target, 'proofgraph.json'), `${JSON.stringify(tokens, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, project, installed: target, environment: { PROOFGRAPH_CONTROL_URL: url(flags), PROOFGRAPH_HOST_TOKEN: `$(cat ${tokens.host_token_file})` } }, null, 2)}\n`); return;
  }
  if (command === 'stop') {
    const baseUrl = url(flags); await waitHealth(baseUrl); const result = await (await client(flags)).shutdown();
    await waitStopped(baseUrl); await fs.rm(path.join(dataDir(flags), '.proofgraphd.json'), { force: true }).catch(() => {});
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); if (process.env.PROOFGRAPH_DEBUG === '1') process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
