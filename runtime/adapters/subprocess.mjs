import path from 'node:path';
import { AgentAdapter, AdapterError } from './base.mjs';
import { commandDoctor, runProcess } from './process-utils.mjs';
import { parseAgentResultFromOutput } from './result-parser.mjs';

export class SubprocessAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    this.command = options.command;
    this.versionArgs = options.versionArgs ?? ['--version'];
    this.buildInvocation = options.buildInvocation;
    this.cwd = options.cwd ?? null;
    this.env = options.env ?? {};
    this.enabled = options.enabled ?? true;
    this.liveCanaryRequired = options.liveCanaryRequired ?? true;
    this.hostToolRisk = options.hostToolRisk ?? false;
    this.allowHostTools = options.allowHostTools ?? false;
    this.parser = options.parser ?? parseAgentResultFromOutput;
  }

  async doctor() {
    const availability = await commandDoctor(this.command, this.versionArgs, { cwd: this.cwd, env: this.env });
    return {
      ...availability,
      adapter: this.manifest.adapter,
      agent_id: this.manifest.agent_id,
      mode: 'subprocess',
      enabled: this.enabled,
      live_canary_required: this.liveCanaryRequired,
      host_tool_risk: this.hostToolRisk,
    };
  }

  async invoke(input, signal) {
    if (!this.enabled) throw new AdapterError(`Adapter ${this.manifest.adapter} is disabled; enable it in proofgraph.config.json`);
    const request = this.normalizeRequest(input);
    if (this.hostToolRisk && !this.allowHostTools && request.workspace?.isolated !== true) {
      throw new AdapterError(`Adapter ${this.manifest.adapter} may expose host mutation tools and requires an isolated workspace or adapters.${this.manifest.adapter}.allow_host_tools=true`, {
        adapter: this.manifest.adapter,
      });
    }
    if (typeof this.buildInvocation !== 'function') throw new AdapterError(`Adapter ${this.manifest.adapter} has no invocation builder`);
    const invocation = this.buildInvocation(request, this.manifest);
    if (!invocation || !Array.isArray(invocation.args)) throw new AdapterError('Invocation builder must return {args, stdin?}');
    const result = await runProcess({
      command: this.command,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: path.resolve(invocation.cwd ?? this.cwd ?? request.workspace?.path ?? request.workspace?.project_dir ?? process.cwd()),
      env: { ...this.env, ...(invocation.env ?? {}) },
      timeoutMs: this.manifest.timeout_ms,
      maxStdoutBytes: this.manifest.max_output_bytes * 4,
      maxStderrBytes: 256_000,
      signal,
    });
    const parsed = await this.parser(result.stdout, { source: this.manifest.adapter, request, process: result });
    return this.normalizeResult(parsed.result ?? parsed);
  }
}
