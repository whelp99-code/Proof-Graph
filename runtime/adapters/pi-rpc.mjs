import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentAdapter, AdapterError } from './base.mjs';
import { commandDoctor, sanitizedEnvironment } from './process-utils.mjs';
import { parseAgentResultFromOutput } from './result-parser.mjs';

const BLOCKING_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
const SAFE_READ_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);
const HOST_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']);

function stringList(value, fallback, label) {
  const selected = value == null ? fallback : value;
  if (!Array.isArray(selected) || selected.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new AdapterError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(selected.map((item) => item.trim()))];
}

function collectCandidateText(value, output, depth = 0, seen = new Set()) {
  if (depth > 16 || value == null) return;
  if (typeof value === 'string') { output.push(value); return; }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) collectCandidateText(item, output, depth + 1, seen); return; }
  if ((value.type === 'text' || value.type === 'text_delta') && typeof value.text === 'string') output.push(value.text);
  if (value.type === 'text_delta' && typeof value.delta === 'string') output.push(value.delta);
  const priority = ['message', 'messages', 'content', 'text', 'delta', 'assistantMessageEvent', 'assistant_message', 'result', 'output', 'data'];
  for (const key of priority) if (key in value) collectCandidateText(value[key], output, depth + 1, seen);
  for (const [key, child] of Object.entries(value)) if (!priority.includes(key) && key !== 'type') collectCandidateText(child, output, depth + 1, seen);
}

function parsePiResult(events, maxBytes) {
  const chunks = [];
  for (const event of events) collectCandidateText(event, chunks);
  const combined = chunks.join('\n');
  if (Buffer.byteLength(combined, 'utf8') > maxBytes * 4) throw new AdapterError('Pi assistant output exceeded parse limit');
  try { return parseAgentResultFromOutput(combined, { source: 'pi-rpc' }); }
  catch {
    return parseAgentResultFromOutput(events.map((entry) => JSON.stringify(entry)).join('\n'), { source: 'pi-rpc' });
  }
}

export class PiRpcAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    this.command = options.command ?? 'pi';
    this.customArgs = options.args == null ? null : stringList(options.args, [], 'Pi args');
    this.enabled = options.enabled ?? false;
    this.allowHostTools = options.allowHostTools ?? false;
    this.safeTools = stringList(options.safeTools, SAFE_READ_TOOLS, 'Pi safeTools');
    this.hostTools = stringList(options.hostTools, HOST_TOOLS, 'Pi hostTools');
    this.disableDiscovery = options.disableDiscovery ?? true;
    if (typeof this.disableDiscovery !== 'boolean') throw new AdapterError('Pi disableDiscovery must be a boolean');
    this.cwd = options.cwd ?? null;
    this.env = options.env ?? {};
    this.uiPolicy = options.uiPolicy ?? 'deny';
    if (!['deny', 'cancel'].includes(this.uiPolicy)) throw new AdapterError('Pi uiPolicy must be deny or cancel');
  }


  buildArgs(request) {
    if (this.customArgs) return [...this.customArgs];
    const args = ['--mode', 'rpc', '--no-session'];
    if (this.disableDiscovery) {
      args.push('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files');
    }
    const tools = this.allowHostTools ? this.hostTools : this.safeTools;
    if (tools.length) args.push('--tools', tools.join(','));
    else args.push('--no-tools');
    const model = request?.node?.model ?? request?.metadata?.model;
    if (model) args.push('--model', String(model));
    return args;
  }

  async doctor() {
    const result = await commandDoctor(this.command, ['--version'], { cwd: this.cwd, env: this.env });
    return {
      ...result,
      adapter: this.manifest.adapter,
      agent_id: this.manifest.agent_id,
      mode: 'jsonl-rpc',
      enabled: this.enabled,
      live_canary_required: true,
      host_tool_risk: true,
      rpc_contract: 'jsonl-lf',
      extension_discovery_disabled: this.customArgs ? null : this.disableDiscovery,
      default_tools: this.customArgs ? null : (this.allowHostTools ? this.hostTools : this.safeTools),
      custom_args: this.customArgs !== null,
    };
  }

  async invoke(input, externalSignal) {
    if (!this.enabled) throw new AdapterError('Pi adapter is disabled; enable adapters.pi.enabled in proofgraph.config.json');
    const request = this.normalizeRequest(input);
    const isolated = request.workspace?.isolated === true;
    if (this.customArgs && !isolated) {
      throw new AdapterError('Custom Pi RPC args are not safety-verifiable and require an isolated workspace');
    }
    if (this.allowHostTools && !isolated) {
      throw new AdapterError('Pi mutation tools require an isolated ProofGraph workspace');
    }
    const cwd = path.resolve(this.cwd ?? request.workspace?.path ?? request.workspace?.project_dir ?? process.cwd());
    const invocationArgs = this.buildArgs(request);
    return await new Promise((resolve, reject) => {
      const controller = new AbortController();
      const decoder = new StringDecoder('utf8');
      let settled = false;
      let buffer = '';
      let outputBytes = 0;
      let stderr = '';
      let sawAgentEnd = false;
      const events = [];
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abortExternal);
        try { child.stdin.end(); } catch {}
        try { child.kill('SIGTERM'); } catch {}
        fn(value);
      };
      const complete = () => {
        try {
          const parsed = parsePiResult(events, this.manifest.max_output_bytes);
          finish(resolve, this.normalizeResult(parsed.result));
        } catch (error) { finish(reject, error); }
      };
      const child = spawn(this.command, invocationArgs, {
        cwd,
        env: sanitizedEnvironment(process.env, {
          ...this.env,
          PROOFGRAPH_HOST_URL: null,
          PROOFGRAPH_HOST_TOKEN: null,
          PROOFGRAPH_WORKER: '1',
          PROOFGRAPH_ALLOW_HOST_TOOLS: this.allowHostTools ? '1' : '0',
          PROOFGRAPH_RUN_ID: request.run_id,
          PROOFGRAPH_NODE_ID: request.node.node_id,
        }),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: controller.signal,
      });
      const timer = setTimeout(() => {
        const error = new AdapterError(`Pi RPC timed out after ${this.manifest.timeout_ms}ms`);
        try { child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`); } catch {}
        try { controller.abort(error); } catch {}
        finish(reject, error);
      }, this.manifest.timeout_ms);
      timer.unref?.();
      const abortExternal = () => {
        const error = externalSignal?.reason ?? new AdapterError('Pi RPC aborted');
        try { child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`); } catch {}
        try { controller.abort(error); } catch {}
        finish(reject, error);
      };
      externalSignal?.addEventListener('abort', abortExternal, { once: true });
      child.on('error', (error) => finish(reject, new AdapterError(`Failed to launch Pi: ${error.message}`, { code: error.code })));
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr) > 256_000) finish(reject, new AdapterError('Pi stderr exceeded 256000 bytes'));
      });
      const processLine = (raw) => {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line) return;
        let event;
        try { event = JSON.parse(line); }
        catch { return finish(reject, new AdapterError('Pi emitted malformed JSONL', { line: line.slice(0, 2000) })); }
        events.push(event);
        if (event.type === 'response' && event.command === 'prompt' && event.success === false) {
          return finish(reject, new AdapterError(`Pi rejected the prompt: ${event.error ?? 'unknown error'}`, { event }));
        }
        if (event.type === 'extension_error') {
          return finish(reject, new AdapterError(`Pi extension error: ${event.error ?? 'unknown error'}`, { event }));
        }
        if (event.type === 'extension_ui_request' && BLOCKING_UI_METHODS.has(event.method)) {
          if (this.uiPolicy === 'cancel' && typeof event.id === 'string') {
            child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`);
            return;
          }
          return finish(reject, new AdapterError(`Pi requested interactive UI method ${event.method} during a non-interactive ProofGraph run`));
        }
        if (event.type === 'agent_settled') return complete();
        if (event.type === 'agent_end') sawAgentEnd = true;
      };
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > this.manifest.max_output_bytes * 8) return finish(reject, new AdapterError('Pi stdout exceeded output limit'));
        buffer += decoder.write(chunk);
        while (true) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          processLine(line);
          if (settled) break;
        }
      });
      child.stdout.on('end', () => {
        buffer += decoder.end();
        if (buffer && !settled) processLine(buffer);
      });
      child.on('close', (code) => {
        if (settled) return;
        const phase = sawAgentEnd ? 'after agent_end but before agent_settled' : 'before agent_settled';
        finish(reject, new AdapterError(`Pi RPC exited ${phase} with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ''}`));
      });
      child.stdin.write(`${JSON.stringify({ id: request.request_id, type: 'prompt', message: request.prompt })}\n`);
    });
  }
}
