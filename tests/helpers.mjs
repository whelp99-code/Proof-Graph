import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startRun, registerPlan, registerClaims, importFixtureSource } from '../server/lib/workflow.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeContext(prefix = 'pg-test-') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  return { base, dataDir, projectDir, testMode: true };
}

export async function cleanupContext(context) {
  await fs.rm(context.base, { recursive: true, force: true });
}

export const BASIC_TASKS = [
  { task_id: 'research-primary', title: 'Primary research', role: 'research-primary' },
  { task_id: 'research-secondary', title: 'Secondary research', role: 'research-secondary' },
  { task_id: 'verification', title: 'Independent verification', role: 'verifier' },
];

export async function createRun(context, policy = {}) {
  const started = await startRun({
    objective: 'Verify a deterministic sample claim against exact source evidence.',
    policy: {
      max_tool_calls: 60,
      max_source_fetches: 10,
      max_claims: 10,
      max_agents: 5,
      max_wall_time_seconds: 300,
      ...policy,
    },
  }, context);
  return started.run_id;
}

export async function createPlannedClaim(context, policy = {}) {
  const runId = await createRun(context, policy);
  await registerPlan({ run_id: runId, actor: 'planner', tasks: BASIC_TASKS }, context);
  await registerClaims({
    run_id: runId,
    actor: 'planner',
    claims: [{ claim_id: 'claim-01', text: 'The sample system supports deterministic evidence validation.', importance: 'high' }],
  }, context);
  return runId;
}

export async function addFixture(context, runId, { actor = 'research-primary', url, content, promptInjection = false }) {
  return importFixtureSource({
    run_id: runId,
    actor,
    url,
    content,
    prompt_injection_suspected: promptInjection,
  }, context);
}

export class McpClient {
  constructor({ dataDir, projectDir, testMode = false } = {}) {
    this.dataDir = dataDir;
    this.projectDir = projectDir;
    this.testMode = testMode;
    this.sequence = 0;
  }

  async start() {
    this.child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROOFGRAPH_DATA_DIR: this.dataDir,
        PROOFGRAPH_PROJECT_DIR: this.projectDir,
        ...(this.testMode ? { PROOFGRAPH_TEST_MODE: '1' } : { PROOFGRAPH_TEST_MODE: '0' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.iterator = this.reader[Symbol.asyncIterator]();
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
    return this;
  }

  async sendRaw(line) {
    this.child.stdin.write(`${line}\n`);
    const next = await this.iterator.next();
    if (next.done) throw new Error(`MCP server closed: ${this.stderr}`);
    return JSON.parse(next.value);
  }

  async request(method, params = {}) {
    this.sequence += 1;
    const id = this.sequence;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await this.iterator.next();
    if (next.done) throw new Error(`MCP server closed: ${this.stderr}`);
    const message = JSON.parse(next.value);
    if (message.id !== id) throw new Error(`Unexpected MCP response id: ${message.id}`);
    return message;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(protocolVersion = '2025-11-25') {
    const response = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'proofgraph-test-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async callTool(name, args = {}) {
    const message = await this.request('tools/call', { name, arguments: args });
    if (message.error) throw Object.assign(new Error(message.error.message), { response: message });
    return message.result;
  }

  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.reader.close();
  }
}

export async function runHook(scriptName, payload, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks', scriptName)], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROOFGRAPH_DATA_DIR: context.dataDir,
        PROOFGRAPH_PROJECT_DIR: context.projectDir,
        CLAUDE_PROJECT_DIR: context.projectDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify({ cwd: context.projectDir, ...payload }));
  });
}
