import { deterministicId, sha256, cloneJson } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';
import { simulationPromotionAllowed } from './execution-mode.mjs';

export class GraphKernelPort {
  constructor({ executionMode = 'simulation' } = {}) { this.executionMode = executionMode; }
  async execute(_request) { throw new Error('GraphKernelPort.execute must be implemented'); }
  async verifyIntegrity(report) { const copy = cloneJson(report); delete copy.integrity; return { ok: report?.integrity?.report_digest === sha256(copy) }; }
}

function reportDigest(report) {
  const copy = cloneJson(report);
  delete copy.integrity;
  return sha256(copy);
}

export class ReferenceGraphKernelPort extends GraphKernelPort {
  constructor({ failurePlan = {}, outputs = {} } = {}) {
    super({ executionMode: 'simulation' });
    this.failurePlan = Object.fromEntries(Object.entries(failurePlan).map(([key, value]) => [key, [...value]]));
    this.outputs = outputs;
    this.invocations = [];
  }

  async execute(request) {
    const compatibilityPromotion = simulationPromotionAllowed();
    const invocation = {
      request_id: request.request_id,
      mission_id: request.mission_id,
      work_item_id: request.work_item.work_item_id,
      kind: request.work_item.kind,
      attempt: request.work_item.attempts + 1,
    };
    this.invocations.push(invocation);
    const plan = this.failurePlan[request.work_item.stage_id] ?? this.failurePlan[request.work_item.kind] ?? [];
    const failure = plan.length ? plan.shift() : null;
    const report = {
      schema_version: 1,
      run_id: deterministicId('run', invocation),
      request_id: request.request_id,
      mission_id: request.mission_id,
      work_item_id: request.work_item.work_item_id,
      stage_id: request.work_item.stage_id,
      kind: request.work_item.kind,
      assigned_role_id: request.work_item.assigned_role_id,
      status: failure ? 'failed' : (compatibilityPromotion ? 'success' : 'simulated'),
      execution: { mode: 'simulation', real_model_invoked: false, real_tools_invoked: false },
      output: failure ? null : cloneJson(this.outputs[request.work_item.stage_id] ?? {
        summary: `${request.work_item.kind} completed for ${request.task.objective}`,
        deliverables: request.work_item.kind === 'verify' ? [] : [{
          name: `${request.work_item.stage_id}-artifact`,
          media_type: 'application/json',
          content: { stage: request.work_item.stage_id, objective: request.task.objective, role: request.work_item.assigned_role_id },
        }],
      }),
      verification: {
        passed: !failure && compatibilityPromotion && request.work_item.kind === 'verify',
        independent: compatibilityPromotion && request.work_item.kind === 'verify',
        evidence: !failure && compatibilityPromotion && request.work_item.kind === 'verify' ? ['reference-kernel compatibility verifier'] : [],
        simulated: true,
      },
      failure: failure ? {
        schema_version: 1,
        type: failure.type ?? 'implementation_error',
        severity: failure.severity ?? 'medium',
        message: failure.message ?? `Injected failure for ${request.work_item.stage_id}`,
        evidence: failure.evidence ?? [],
        retryable: failure.retryable !== false,
        recommended_route: failure.recommended_route ?? null,
      } : null,
      usage: { calls: 1, tokens: 0, cost_micros: 0, wall_time_ms: 1 },
    };
    report.integrity = { report_digest: reportDigest(report) };
    return report;
  }

  async verifyIntegrity(report) {
    return { ok: report?.integrity?.report_digest === reportDigest(report), report_digest: report?.integrity?.report_digest ?? null };
  }
}

export class HostBridgeGraphPort extends GraphKernelPort {
  constructor({ url, token, host = 'opencode', fetchImpl = globalThis.fetch, timeoutMs = 120_000, allowRemote = false }) {
    super({ executionMode: 'hosted' });
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetch implementation is required');
    const parsed = new URL(url);
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
    if (!allowRemote && (!loopback || parsed.protocol !== 'http:')) throw new PolicyError('v1.1 Host Bridge port requires loopback HTTP unless allowRemote is explicitly enabled');
    if (allowRemote && parsed.protocol !== 'https:' && !loopback) throw new PolicyError('Remote Host Bridge requires HTTPS');
    if (typeof token !== 'string' || token.length < 24) throw new ValidationError('Host Bridge token must contain at least 24 characters');
    this.url = parsed.toString().replace(/\/$/, '');
    this.token = token;
    this.host = host;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async command(command, fields = {}) {
    if (['approve', 'deny', 'abort', 'apply_policy', 'modify_runtime'].includes(command)) throw new PolicyError(`Host Graph Port cannot invoke operator-only command: ${command}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.url}/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ protocol_version: 'proofgraph.host.v1', host: this.host, command, ...fields }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { throw new PolicyError(`Host Bridge returned malformed JSON (${response.status})`); }
      if (!response.ok || body.ok === false) throw new PolicyError(body.message ?? body.error ?? `Host Bridge command failed (${response.status})`, body);
      return body.result ?? body;
    } finally { clearTimeout(timer); }
  }

  async execute(request) {
    const result = await this.command('run', {
      request_id: request.request_id,
      payload: {
        objective: request.work_item.objective,
        template: request.task.archetype,
        adapter: request.adapter ?? this.host,
        model_id: request.model_id ?? request.route_decision?.model_id ?? null,
        context_packet: request.context_packet ?? null,
        collaboration: request.collaboration ?? null,
        knowledge_impacts: request.knowledge_impacts ?? [],
        memory_refs: request.memory_refs ?? [],
        metadata: {
          mission_id: request.mission_id,
          work_item_id: request.work_item.work_item_id,
          assigned_role_id: request.work_item.assigned_role_id,
          organization_id: request.organization.organization_id,
          context_packet_id: request.context_packet?.packet_id ?? null,
          route_id: request.route_decision?.route_id ?? null,
          route_digest: request.route_decision?.digest ?? null,
          intelligence_bundle_digest: request.intelligence?.digest ?? null,
        },
      },
    });
    const report = result.report ?? result;
    if (!report || typeof report !== 'object') throw new PolicyError('Host Bridge did not return a report object');
    return report;
  }

  async verifyIntegrity(report) {
    if (!report?.run_id) return { ok: false, reason: 'missing_run_id' };
    try { return await this.command('integrity', { run_id: report.run_id, payload: {} }); }
    catch (error) { return { ok: false, reason: error.message }; }
  }
}


function parseAgentJson(content) {
  const trimmed = String(content ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try { return JSON.parse(fenced); } catch { throw new PolicyError('Agent response must be one valid JSON object'); }
}

function agentPrompt(request) {
  return [
    'You are a ProofGraph worker. Return ONLY one JSON object.',
    'Required keys: summary (string), deliverables (array), evidence (array), verification (object), file_operations (array), commands (array).',
    'For verifier work, verification must contain passed:boolean, independent:boolean, findings:array.',
    'For non-verifier work, verification.passed must be false.',
    'file_operations items: {path, content}. commands items: {command,args}. Do not include secrets.',
    JSON.stringify({ objective: request.task.objective, work_item: request.work_item, context_packet: request.context_packet, contracts: request.collaboration, impacts: request.knowledge_impacts, memory_refs: request.memory_refs }),
  ].join('\n');
}

export class NativeAgentGraphPort extends GraphKernelPort {
  constructor({ provider, sandbox = null, sourceDir = null, executeTools = false } = {}) {
    super({ executionMode: provider?.local ? 'native_local' : 'native_cloud' });
    if (!provider || typeof provider.invoke !== 'function') throw new ValidationError('NativeAgentGraphPort requires a provider');
    this.provider = provider; this.sandbox = sandbox; this.sourceDir = sourceDir; this.executeTools = executeTools;
  }

  async execute(request) {
    const started = Date.now();
    const response = await this.provider.invoke({
      messages: [
        { role: 'system', content: 'Follow the supplied ProofGraph work contract exactly. Never claim a tool ran unless a tool receipt is supplied.' },
        { role: 'user', content: agentPrompt(request) },
      ],
      responseFormat: { type: 'json_object' },
      metadata: { mission_id: request.mission_id, work_item_id: request.work_item.work_item_id },
    });
    const payload = parseAgentJson(response.content);
    const receipts = [];
    let workspace = null;
    if (this.executeTools) {
      if (!this.sandbox) throw new PolicyError('Tool execution requested without SandboxRuntime');
      workspace = await this.sandbox.createWorkspace({ sourceDir: this.sourceDir });
      for (const operation of payload.file_operations ?? []) receipts.push({ type: 'file_write', ...(await this.sandbox.writeFile(workspace, operation.path, operation.content)) });
      for (const command of payload.commands ?? []) receipts.push({ type: 'command', ...(await this.sandbox.run(workspace, command.command, command.args ?? [])) });
    }
    const isVerify = request.work_item.kind === 'verify';
    const passed = isVerify && payload.verification?.passed === true && payload.verification?.independent === true && (payload.evidence?.length ?? 0) > 0;
    const failedTool = receipts.some((receipt) => receipt.type === 'command' && receipt.passed !== true);
    const status = failedTool || (isVerify && !passed) ? 'failed' : 'success';
    const report = {
      schema_version: 2,
      run_id: deterministicId('run', { request_id: request.request_id, model: response.model_id, content: response.content }),
      request_id: request.request_id, mission_id: request.mission_id, work_item_id: request.work_item.work_item_id,
      stage_id: request.work_item.stage_id, kind: request.work_item.kind, assigned_role_id: request.work_item.assigned_role_id,
      status,
      execution: { mode: this.executionMode, real_model_invoked: true, real_tools_invoked: receipts.length > 0, provider: response.provider, model_id: response.model_id, provider_request_id: response.request_id },
      output: status === 'success' ? { summary: payload.summary ?? '', deliverables: payload.deliverables ?? [], tool_receipts: receipts, workspace: workspace ? { workspace_id: workspace.workspace_id } : null } : null,
      verification: { passed, independent: isVerify && payload.verification?.independent === true, evidence: payload.evidence ?? [], findings: payload.verification?.findings ?? [], tool_receipts: receipts },
      failure: status === 'failed' ? { type: failedTool ? 'tool_failure' : 'verification_failure', severity: 'high', message: failedTool ? 'One or more sandbox commands failed' : 'Independent verification did not pass', evidence: payload.evidence ?? [], retryable: true, recommended_route: failedTool ? 'develop' : null } : null,
      usage: { calls: 1, tokens: response.usage.total_tokens, cost_micros: 0, wall_time_ms: Date.now() - started, prompt_tokens: response.usage.prompt_tokens, completion_tokens: response.usage.completion_tokens },
    };
    report.integrity = { report_digest: reportDigest(report) };
    return report;
  }
}
