import { AdapterError } from '../adapters/base.mjs';
import { runProcess } from '../adapters/process-utils.mjs';

function parseJsonOutput(stdout, command) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { values.push(JSON.parse(trimmed)); } catch {}
  }
  if (values.length === 1) return values[0];
  if (values.length > 1) return values;
  throw new AdapterError(`Orca returned non-JSON output for ${command}`, {
    command,
    stdout: text.slice(0, 20_000),
  });
}

export function findFirstField(value, names, options = {}) {
  const wanted = new Set(names);
  const maxDepth = options.maxDepth ?? 10;
  const queue = [{ value, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.value == null || typeof current.value !== 'object' || current.depth > maxDepth) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (!Array.isArray(current.value)) {
      for (const [key, field] of Object.entries(current.value)) {
        if (wanted.has(key) && field != null && (typeof field === 'string' || typeof field === 'number')) return String(field);
      }
    }
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return null;
}

export function collectTypedMessages(value) {
  const output = [];
  const queue = [value];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      const type = current.type ?? current.messageType ?? current.message_type;
      if (typeof type === 'string' && ['worker_done', 'escalation', 'decision_gate', 'heartbeat'].includes(type)) {
        output.push(current);
      }
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return output;
}

export function field(value, ...names) {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    if (value[name] != null) return value[name];
  }
  return null;
}

export class OrcaCliClient {
  constructor(options = {}) {
    this.command = options.command ?? 'orca';
    this.baseArgs = options.args ?? [];
    if (!Array.isArray(this.baseArgs) || this.baseArgs.some((item) => typeof item !== 'string')) {
      throw new AdapterError('Orca CLI prefix args must be strings');
    }
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.trace = typeof options.trace === 'function' ? options.trace : null;
  }

  async call(args, options = {}) {
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw new AdapterError('Orca CLI args must be strings');
    }
    const logicalArgs = args.includes('--json') ? [...args] : [...args, '--json'];
    const argv = [...this.baseArgs, ...logicalArgs];
    this.trace?.({ command: this.command, args: structuredClone(logicalArgs), actual_args: structuredClone(argv) });
    const result = await runProcess({
      command: this.command,
      args: argv,
      cwd: options.cwd ?? this.cwd,
      env: { ...this.env, ...(options.env ?? {}) },
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxStdoutBytes: options.maxOutputBytes ?? this.maxOutputBytes,
      maxStderrBytes: 256_000,
      signal: options.signal,
    });
    return {
      data: parseJsonOutput(result.stdout, argv.slice(0, 3).join(' ')),
      process: result,
    };
  }
}
