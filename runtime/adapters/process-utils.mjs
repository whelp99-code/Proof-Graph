import { spawn } from 'node:child_process';
import path from 'node:path';
import { AdapterError } from './base.mjs';

const BLOCKED_ENV = new Set([
  'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONSTARTUP', 'RUBYOPT',
]);

export function sanitizedEnvironment(base = process.env, overlay = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value == null || BLOCKED_ENV.has(key)) continue;
    env[key] = String(value);
  }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (BLOCKED_ENV.has(key)) throw new AdapterError(`Refusing dangerous environment override: ${key}`);
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  env.GIT_TERMINAL_PROMPT ??= '0';
  return env;
}

function appendBounded(chunks, chunk, state, cap, streamName, child) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += buffer.length;
  if (state.bytes > cap) {
    child.kill('SIGKILL');
    throw new AdapterError(`${streamName} exceeded ${cap} bytes`, { stream: streamName, max_bytes: cap });
  }
  chunks.push(buffer);
}

export async function runProcess(options) {
  const command = options.command;
  const args = options.args ?? [];
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 1_000_000;
  const maxStderrBytes = options.maxStderrBytes ?? 256_000;
  if (typeof command !== 'string' || !command.trim()) throw new AdapterError('Process command is required');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new AdapterError('Process args must be an array of strings');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AdapterError('Process timeout must be a positive integer');

  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let overflowError = null;
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
      fn(value);
    };
    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnvironment(options.envBase, options.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: controller.signal,
    });
    const terminate = (reason) => {
      if (settled) return;
      try { controller.abort(reason); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => terminate(new AdapterError(`Process timed out after ${timeoutMs}ms`, { timeout_ms: timeoutMs })), timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => terminate(options.signal?.reason ?? new AdapterError('Process aborted'));
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    child.on('error', (error) => {
      const reason = error?.name === 'AbortError' && controller.signal.reason
        ? controller.signal.reason
        : new AdapterError(`Failed to launch ${command}: ${error.message}`, { command, code: error.code });
      finish(reject, reason);
    });
    child.stdout.on('data', (chunk) => {
      try { appendBounded(stdout, chunk, stdoutState, maxStdoutBytes, 'stdout', child); }
      catch (error) { overflowError = error; terminate(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { appendBounded(stderr, chunk, stderrState, maxStderrBytes, 'stderr', child); }
      catch (error) { overflowError = error; terminate(error); }
    });
    child.on('close', (code, signal) => {
      if (overflowError) return finish(reject, overflowError);
      if (controller.signal.aborted) return finish(reject, controller.signal.reason ?? new AdapterError('Process aborted'));
      const result = {
        command,
        args: [...args],
        cwd,
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0) {
        return finish(reject, new AdapterError(`${command} exited with code ${code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 2000)}` : ''}`, {
          command, args, code, signal, stderr: result.stderr.slice(0, 20_000),
        }));
      }
      finish(resolve, result);
    });

    if (options.stdin != null) child.stdin.end(String(options.stdin));
    else child.stdin.end();
  });
}

export async function commandDoctor(command, args = ['--version'], options = {}) {
  try {
    const result = await runProcess({
      command, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs ?? 10_000,
      maxStdoutBytes: 64_000, maxStderrBytes: 64_000,
    });
    return { ok: true, command, version: (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] || 'available' };
  } catch (error) {
    return { ok: false, command, error: error.message, code: error.details?.code ?? null };
  }
}
