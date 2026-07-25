import { canonicalJson } from '../server/lib/canonical.mjs';
import { ValidationError } from '../server/lib/errors.mjs';
import {
  arrayValue,
  assertFiniteJson,
  assertPlainObject,
  booleanValue,
  enumValue,
  identifier,
  integerValue,
  rejectUnknownKeys,
  stringValue,
  uniqueStrings,
} from '../server/lib/validate.mjs';

export const AGENT_OUTCOMES = Object.freeze(['success', 'failed', 'blocked']);
export const ADAPTER_KINDS = Object.freeze(['mock', 'subprocess', 'jsonrpc', 'acp']);

function boundedJson(value, name, maxBytes = 256_000) {
  assertFiniteJson(value);
  const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  if (bytes > maxBytes) throw new ValidationError(`${name} exceeds ${maxBytes} bytes`, { bytes });
  return structuredClone(value);
}

export function normalizeAgentManifest(input, name = 'agent') {
  assertPlainObject(input, name);
  rejectUnknownKeys(input, [
    'agent_id', 'adapter', 'roles', 'model', 'model_tiers', 'capabilities',
    'timeout_ms', 'max_output_bytes', 'instructions', 'metadata',
  ], name);
  const modelTiers = input.model_tiers ?? {};
  assertPlainObject(modelTiers, `${name}.model_tiers`);
  for (const [key, value] of Object.entries(modelTiers)) {
    if (!['fast', 'standard', 'deep', 'inherit'].includes(key)) {
      throw new ValidationError(`${name}.model_tiers has unsupported tier: ${key}`);
    }
    stringValue(value, `${name}.model_tiers.${key}`, { min: 1, max: 240 });
  }
  return {
    agent_id: identifier(input.agent_id, `${name}.agent_id`),
    adapter: identifier(input.adapter, `${name}.adapter`),
    roles: uniqueStrings(input.roles ?? [], `${name}.roles`, { min: 1, max: 20, itemMax: 64 }),
    model: input.model == null ? null : stringValue(input.model, `${name}.model`, { min: 1, max: 240 }),
    model_tiers: structuredClone(modelTiers),
    capabilities: uniqueStrings(input.capabilities ?? ['structured_output'], `${name}.capabilities`, { min: 1, max: 30, itemMax: 80 }),
    timeout_ms: input.timeout_ms === undefined ? 300_000 : integerValue(input.timeout_ms, `${name}.timeout_ms`, { min: 1_000, max: 3_600_000 }),
    max_output_bytes: input.max_output_bytes === undefined ? 256_000 : integerValue(input.max_output_bytes, `${name}.max_output_bytes`, { min: 1_024, max: 10_000_000 }),
    instructions: input.instructions == null ? '' : stringValue(input.instructions, `${name}.instructions`, { min: 0, max: 40_000, trim: false }),
    metadata: boundedJson(input.metadata ?? {}, `${name}.metadata`, 64_000),
  };
}

export function normalizeAgentRequest(input, name = 'request') {
  assertPlainObject(input, name);
  rejectUnknownKeys(input, [
    'request_id', 'run_id', 'node', 'objective', 'attempt', 'model_tier',
    'tool_policy', 'context', 'workspace', 'constraints', 'prompt', 'metadata',
  ], name);
  const node = assertPlainObject(input.node, `${name}.node`);
  return {
    request_id: identifier(input.request_id, `${name}.request_id`),
    run_id: stringValue(input.run_id, `${name}.run_id`, { min: 3, max: 100 }),
    node: boundedJson(node, `${name}.node`, 64_000),
    objective: stringValue(input.objective, `${name}.objective`, { min: 1, max: 20_000 }),
    attempt: integerValue(input.attempt, `${name}.attempt`, { min: 1, max: 100 }),
    model_tier: enumValue(input.model_tier ?? 'inherit', `${name}.model_tier`, ['fast', 'standard', 'deep', 'inherit']),
    tool_policy: uniqueStrings(input.tool_policy ?? [], `${name}.tool_policy`, { min: 0, max: 30, itemMax: 80 }),
    context: boundedJson(input.context ?? [], `${name}.context`, 512_000),
    workspace: boundedJson(input.workspace ?? {}, `${name}.workspace`, 128_000),
    constraints: boundedJson(input.constraints ?? {}, `${name}.constraints`, 128_000),
    prompt: stringValue(input.prompt, `${name}.prompt`, { min: 20, max: 200_000, trim: false }),
    metadata: boundedJson(input.metadata ?? {}, `${name}.metadata`, 64_000),
  };
}

export function normalizeFailurePacket(input, name = 'failure') {
  const value = assertPlainObject(input, name);
  rejectUnknownKeys(value, [
    'failure_type', 'summary', 'severity', 'retryable', 'evidence',
    'expected', 'observed', 'recommended_route', 'metadata',
  ], name);
  return {
    failure_type: enumValue(value.failure_type ?? 'unknown', `${name}.failure_type`, [
      'implementation_error', 'design_error', 'requirements_error', 'evidence_gap',
      'verification_error', 'security_risk', 'budget_exceeded', 'unknown',
    ]),
    summary: stringValue(value.summary, `${name}.summary`, { min: 3, max: 8_000 }),
    severity: enumValue(value.severity ?? 'medium', `${name}.severity`, ['low', 'medium', 'high', 'critical']),
    retryable: value.retryable === undefined ? true : booleanValue(value.retryable, `${name}.retryable`),
    evidence: arrayValue(value.evidence ?? [], `${name}.evidence`, { min: 0, max: 100 })
      .map((item, index) => stringValue(item, `${name}.evidence[${index}]`, { min: 1, max: 8_000 })),
    expected: value.expected == null ? null : stringValue(value.expected, `${name}.expected`, { min: 1, max: 8_000 }),
    observed: value.observed == null ? null : stringValue(value.observed, `${name}.observed`, { min: 1, max: 8_000 }),
    recommended_route: value.recommended_route == null ? null : enumValue(value.recommended_route, `${name}.recommended_route`, [
      'direct', 'research', 'plan', 'develop', 'verify', 'human', 'synthesize', 'success', 'partial', 'failed',
    ]),
    metadata: boundedJson(value.metadata ?? {}, `${name}.metadata`, 64_000),
  };
}

export function normalizeAgentResult(input, options = {}) {
  const name = options.name ?? 'result';
  const maxOutputBytes = options.maxOutputBytes ?? 256_000;
  const value = assertPlainObject(input, name);
  rejectUnknownKeys(value, [
    'outcome', 'summary', 'output', 'failure', 'usage', 'artifacts',
    'dynamic_tasks', 'workspace_actions', 'metadata',
  ], name);
  const outcome = enumValue(value.outcome, `${name}.outcome`, AGENT_OUTCOMES);
  const failure = outcome === 'failed'
    ? normalizeFailurePacket(value.failure, `${name}.failure`)
    : null;
  if (outcome !== 'failed' && value.failure != null) {
    throw new ValidationError(`${name}.failure is only allowed for failed results`);
  }
  const output = boundedJson(value.output ?? {}, `${name}.output`, maxOutputBytes);
  const usage = boundedJson(value.usage ?? {}, `${name}.usage`, 64_000);
  const artifacts = arrayValue(value.artifacts ?? [], `${name}.artifacts`, { min: 0, max: 100 })
    .map((artifact, index) => boundedJson(assertPlainObject(artifact, `${name}.artifacts[${index}]`), `${name}.artifacts[${index}]`, 64_000));
  const dynamicTasks = arrayValue(value.dynamic_tasks ?? [], `${name}.dynamic_tasks`, { min: 0, max: 64 })
    .map((task, index) => boundedJson(assertPlainObject(task, `${name}.dynamic_tasks[${index}]`), `${name}.dynamic_tasks[${index}]`, 64_000));
  const workspaceActions = arrayValue(value.workspace_actions ?? [], `${name}.workspace_actions`, { min: 0, max: 64 })
    .map((action, index) => boundedJson(assertPlainObject(action, `${name}.workspace_actions[${index}]`), `${name}.workspace_actions[${index}]`, 256_000));
  return {
    outcome,
    summary: stringValue(value.summary, `${name}.summary`, { min: 1, max: 20_000 }),
    output,
    failure,
    usage,
    artifacts,
    dynamic_tasks: dynamicTasks,
    workspace_actions: workspaceActions,
    metadata: boundedJson(value.metadata ?? {}, `${name}.metadata`, 64_000),
  };
}

export function buildAgentPrompt(request, manifest) {
  const contract = {
    outcome: 'success | failed | blocked',
    summary: 'short factual summary',
    output: {
      route: 'optional graph route',
      verification: request.node.kind === 'verify' ? { passed: 'boolean', checks: ['...'] } : 'optional',
      result: 'role-specific structured result',
    },
    failure: request.node.kind === 'verify' ? 'required when outcome=failed; typed Failure Packet' : 'required when outcome=failed',
    artifacts: [],
    dynamic_tasks: [],
    workspace_actions: [],
  };
  const contextJson = JSON.stringify(request.context, null, 2);
  return [
    '# ProofGraph Agent Contract',
    '',
    `Agent: ${manifest.agent_id}`,
    `Role: ${request.node.role}`,
    `Node: ${request.node.node_id} (${request.node.kind})`,
    `Attempt: ${request.attempt}`,
    `Objective: ${request.objective}`,
    '',
    '## Non-negotiable rules',
    '- Work only on this node. Do not claim that another node completed.',
    '- Return one JSON object matching the contract below, without Markdown commentary.',
    '- Never hide failed, blocked, or unverified work.',
    '- A verifier may return success only when output.verification.passed is true.',
    '- recommended_route is advisory; the runtime chooses the actual graph edge.',
    '- Do not perform workspace mutations unless an explicit workspace action is allowed by policy.',
    manifest.instructions ? `- Adapter instructions: ${manifest.instructions}` : '',
    '',
    '## Tool policy',
    JSON.stringify(request.tool_policy),
    '',
    '## Prior verified context',
    contextJson,
    '',
    '## Output contract',
    JSON.stringify(contract, null, 2),
  ].filter(Boolean).join('\n');
}
