import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PolicyError, ValidationError } from '../core/errors.mjs';
import { randomId, sha256 } from '../core/canonical.mjs';

const DEFAULT_ALLOWED = new Set(['node', 'npm', 'npx', 'git']);
function inside(root, target) { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }

export class SandboxRuntime {
  constructor({ rootDir = null, allowedCommands = [...DEFAULT_ALLOWED], timeoutMs = 120_000, maxOutputBytes = 2_000_000 } = {}) {
    this.rootDir = rootDir;
    this.allowedCommands = new Set(allowedCommands);
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  async createWorkspace({ sourceDir = null } = {}) {
    const root = this.rootDir ? path.resolve(this.rootDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'proofgraph-sandbox-'));
    await fs.mkdir(root, { recursive: true });
    const workspace = path.join(root, randomId('workspace'));
    await fs.mkdir(workspace, { recursive: true });
    if (sourceDir) await fs.cp(path.resolve(sourceDir), workspace, { recursive: true, dereference: false, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) && !src.includes(`${path.sep}node_modules${path.sep}`) });
    return { workspace_id: path.basename(workspace), path: workspace, created_at: new Date().toISOString() };
  }

  resolve(workspace, relativePath) {
    const root = path.resolve(workspace.path);
    const target = path.resolve(root, relativePath);
    if (!inside(root, target)) throw new PolicyError('Workspace path escape blocked');
    return target;
  }

  async writeFile(workspace, relativePath, content) {
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new ValidationError('content must be string or Buffer');
    const target = this.resolve(workspace, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'w' });
    return { path: relativePath, bytes: Buffer.byteLength(content), digest: sha256(content) };
  }

  async run(workspace, command, args = [], { env = {}, timeoutMs = this.timeoutMs } = {}) {
    if (!this.allowedCommands.has(command)) throw new PolicyError(`Command is not allowed: ${command}`);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new ValidationError('args must be safe strings');
    const cwd = path.resolve(workspace.path);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, HOME: cwd, CI: '1', ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let killed = false;
      const append = (current, chunk) => { const next = Buffer.concat([current, chunk]); if (next.length > this.maxOutputBytes) { killed = true; child.kill('SIGKILL'); return next.subarray(0, this.maxOutputBytes); } return next; };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs); timer.unref?.();
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ command, args, exit_code: code, signal, timed_out_or_limited: killed, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), passed: code === 0 && !killed }); });
    });
  }
}
