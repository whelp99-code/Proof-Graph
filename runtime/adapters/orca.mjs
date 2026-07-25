import { AgentAdapter, AdapterError } from './base.mjs';
import { OrcaExecutionHost } from '../hosts/orca.mjs';

export class OrcaAdapter extends AgentAdapter {
  constructor(manifest, options = {}) {
    super(manifest);
    const defaultAgent = options.defaultAgent ?? 'claude';
    const roleAgents = options.roleAgents ?? {};
    const agentMap = options.agentMap ?? {
      direct: defaultAgent,
      researcher: roleAgents.researcher ?? defaultAgent,
      planner: roleAgents.planner ?? defaultAgent,
      developer: roleAgents.developer ?? defaultAgent,
      verifier: roleAgents.verifier ?? defaultAgent,
      synthesizer: roleAgents.synthesizer ?? defaultAgent,
    };
    this.host = options.host ?? new OrcaExecutionHost({
      ...options,
      projectDir: options.projectDir ?? options.cwd,
      repoSelector: options.repoSelector ?? options.repo,
      requireExplicitRepoSelector: options.requireExplicitRepoSelector,
      agentMap,
      checkTimeoutMs: options.checkTimeoutMs ?? options.pollTimeoutMs ?? options.completionTimeoutMs,
      terminalWaitMs: options.terminalWaitMs ?? options.waitTimeoutMs,
      reportDir: options.reportDir,
      manualPermissionsConfirmed: options.manualPermissionsConfirmed,
    });
    this.enabled = options.enabled ?? false;
  }

  async doctor() {
    const status = await this.host.doctor();
    return {
      ...status,
      adapter: this.manifest.adapter,
      agent_id: this.manifest.agent_id,
      enabled: this.enabled,
      mode: 'orca-orchestration-bridge',
      host_mode: 'execution-host',
      live_canary_required: true,
      host_tool_risk: true,
    };
  }

  async invoke(input, signal) {
    if (!this.enabled) throw new AdapterError('Orca adapter is disabled; enable it only after Orca CLI contract and read-only canary validation');
    const request = this.normalizeRequest(input);
    const result = await this.host.execute(request, signal);
    return this.normalizeResult(result);
  }
}
