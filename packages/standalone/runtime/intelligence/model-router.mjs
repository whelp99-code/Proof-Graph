import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { IntegrityError, PolicyError, ValidationError } from '../core/errors.mjs';
import { arrayValue, boundedJson, enumValue, integer, numberValue, plainObject, stringValue, uniqueStrings, unknownKeys } from '../core/validate.mjs';
import { DATA_CLASSIFICATIONS, MODEL_OBSERVATION_SCHEMA, MODEL_REGISTRY_SCHEMA, ROUTE_DECISION_SCHEMA } from './domain.mjs';

const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const REQUIRED_BY_KIND = Object.freeze({
  triage: ['reasoning'], direct: ['general'], research: ['research'], plan: ['reasoning', 'planning'], develop: ['coding'], verify: ['verification', 'reasoning'], synthesize: ['reasoning'], join: [], human_approval: [],
});

export const DEFAULT_MODEL_REGISTRY = Object.freeze({
  schema: MODEL_REGISTRY_SCHEMA,
  schema_version: 1,
  registry_version: 'offline-reference-1',
  entries: [{
    model_id: 'reference/deterministic-v1', provider: 'reference', host: 'reference', enabled: true,
    capabilities: ['general', 'reasoning', 'planning', 'research', 'coding', 'verification', 'structured_output'],
    data_classifications: ['public', 'internal', 'confidential', 'restricted'], risk_ceiling: 'critical', max_context_tokens: 250_000,
    quality: 0.6, reliability: 1, health: 1, latency_ms: 1, input_cost_micros_per_million: 0, output_cost_micros_per_million: 0,
    tags: ['offline', 'deterministic'],
  }],
});

function normalizeEntry(raw, index) {
  plainObject(raw, `model_registry.entries[${index}]`);
  unknownKeys(raw, ['model_id', 'provider', 'host', 'enabled', 'capabilities', 'data_classifications', 'risk_ceiling', 'max_context_tokens', 'quality', 'reliability', 'health', 'latency_ms', 'input_cost_micros_per_million', 'output_cost_micros_per_million', 'tags'], `model_registry.entries[${index}]`);
  const entry = {
    model_id: stringValue(raw.model_id, `model_registry.entries[${index}].model_id`, { max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/ }),
    provider: stringValue(raw.provider, `model_registry.entries[${index}].provider`, { max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/ }),
    host: stringValue(raw.host ?? raw.provider, `model_registry.entries[${index}].host`, { max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/ }),
    enabled: raw.enabled !== false,
    capabilities: uniqueStrings(raw.capabilities ?? [], `model_registry.entries[${index}].capabilities`, { max: 64, itemMax: 80 }).sort(),
    data_classifications: arrayValue(raw.data_classifications ?? ['public', 'internal'], `model_registry.entries[${index}].data_classifications`, { min: 1, max: 4 }).map((item) => enumValue(item, DATA_CLASSIFICATIONS, 'data classification')),
    risk_ceiling: enumValue(raw.risk_ceiling ?? 'medium', Object.keys(RISK_RANK), 'risk ceiling'),
    max_context_tokens: integer(raw.max_context_tokens ?? 16_000, 'max_context_tokens', { min: 1000, max: 10_000_000 }),
    quality: numberValue(raw.quality ?? 0.5, 'quality', { min: 0, max: 1 }),
    reliability: numberValue(raw.reliability ?? 0.5, 'reliability', { min: 0, max: 1 }),
    health: numberValue(raw.health ?? 1, 'health', { min: 0, max: 1 }),
    latency_ms: integer(raw.latency_ms ?? 1000, 'latency_ms', { min: 0, max: 3_600_000 }),
    input_cost_micros_per_million: integer(raw.input_cost_micros_per_million ?? 0, 'input_cost_micros_per_million', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    output_cost_micros_per_million: integer(raw.output_cost_micros_per_million ?? 0, 'output_cost_micros_per_million', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    tags: uniqueStrings(raw.tags ?? [], `model_registry.entries[${index}].tags`, { max: 64, itemMax: 80 }).sort(),
  };
  return entry;
}

export function normalizeModelRegistry(raw = DEFAULT_MODEL_REGISTRY) {
  raw ??= DEFAULT_MODEL_REGISTRY;
  plainObject(raw, 'model_registry');
  unknownKeys(raw, ['schema', 'schema_version', 'registry_version', 'entries', 'digest'], 'model_registry');
  const entries = arrayValue(raw.entries, 'model_registry.entries', { min: 1, max: 100 }).map(normalizeEntry);
  const ids = new Set(entries.map((item) => item.model_id));
  if (ids.size !== entries.length) throw new ValidationError('Duplicate model_id in registry');
  const registry = {
    schema: MODEL_REGISTRY_SCHEMA,
    schema_version: 1,
    registry_version: stringValue(raw.registry_version ?? 'registry-1', 'registry_version', { max: 100 }),
    entries,
  };
  registry.digest = sha256(registry);
  if (raw.digest != null && raw.digest !== registry.digest) throw new IntegrityError('Model registry digest mismatch');
  boundedJson(registry, 'model_registry', { maxBytes: 1_000_000 });
  return deepFreeze(registry);
}

function requiredCapabilities(request) {
  return [...new Set([...(REQUIRED_BY_KIND[request.kind] ?? ['general']), ...(request.required_capabilities ?? []), 'structured_output'])].sort();
}

function estimatedCost(entry, inputTokens, outputTokens) {
  return Math.ceil((inputTokens * entry.input_cost_micros_per_million + outputTokens * entry.output_cost_micros_per_million) / 1_000_000);
}

function eligible(entry, request, caps) {
  const reasons = [];
  if (!entry.enabled) reasons.push('disabled');
  if (entry.health < (request.min_health ?? 0.25)) reasons.push('unhealthy');
  if (!entry.data_classifications.includes(request.classification)) reasons.push('classification_not_allowed');
  if (RISK_RANK[entry.risk_ceiling] < RISK_RANK[request.risk]) reasons.push('risk_ceiling');
  if (entry.max_context_tokens < request.context_tokens) reasons.push('context_limit');
  for (const capability of caps) if (!entry.capabilities.includes(capability)) reasons.push(`missing:${capability}`);
  const cost = estimatedCost(entry, request.context_tokens, request.expected_output_tokens);
  if (request.max_cost_micros != null && cost > request.max_cost_micros) reasons.push('cost_budget');
  if (request.allowed_hosts?.length && !request.allowed_hosts.includes(entry.host)) reasons.push('host_not_allowed');
  if (request.allowed_models?.length && !request.allowed_models.includes(entry.model_id)) reasons.push('model_not_allowed');
  return { ok: reasons.length === 0, reasons, estimated_cost_micros: cost };
}


function safeUsageInteger(value, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return 0;
  return integer(value, name, { min: 0, max });
}

function percentile95(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
}

function score(entry, request, cost) {
  const qualityWeight = request.verification_strength === 'deep' || request.risk === 'critical' ? 45 : request.kind === 'develop' || request.kind === 'verify' ? 38 : 30;
  const reliabilityWeight = request.risk === 'critical' ? 30 : 22;
  const healthWeight = 18;
  const costPenalty = Math.min(12, Math.log10(cost + 1) * 2.5);
  const latencyPenalty = Math.min(10, Math.log10(entry.latency_ms + 1) * 2);
  const preferredBonus = request.preferred_hosts?.includes(entry.host) ? 5 : 0;
  const tagBonus = (request.preferred_tags ?? []).filter((tag) => entry.tags.includes(tag)).length * 1.5;
  return Number((entry.quality * qualityWeight + entry.reliability * reliabilityWeight + entry.health * healthWeight + preferredBonus + tagBonus - costPenalty - latencyPenalty).toFixed(6));
}

export class ModelRouter {
  constructor({ registry = DEFAULT_MODEL_REGISTRY } = {}) {
    this.registry = normalizeModelRegistry(registry);
  }

  route(rawRequest) {
    plainObject(rawRequest, 'route_request');
    const request = {
      mission_id: stringValue(rawRequest.mission_id, 'mission_id', { max: 200 }),
      work_item_id: stringValue(rawRequest.work_item_id, 'work_item_id', { max: 200 }),
      kind: stringValue(rawRequest.kind, 'kind', { max: 80 }),
      risk: enumValue(rawRequest.risk ?? 'low', Object.keys(RISK_RANK), 'risk'),
      classification: enumValue(rawRequest.classification ?? 'internal', DATA_CLASSIFICATIONS, 'classification'),
      context_tokens: integer(rawRequest.context_tokens ?? 0, 'context_tokens', { min: 0, max: 10_000_000 }),
      expected_output_tokens: integer(rawRequest.expected_output_tokens ?? 4000, 'expected_output_tokens', { min: 1, max: 1_000_000 }),
      verification_strength: enumValue(rawRequest.verification_strength ?? 'standard', ['lite', 'standard', 'deep'], 'verification_strength'),
      required_capabilities: uniqueStrings(rawRequest.required_capabilities ?? [], 'required_capabilities', { max: 64, itemMax: 80 }),
      max_cost_micros: rawRequest.max_cost_micros == null ? null : integer(rawRequest.max_cost_micros, 'max_cost_micros', { min: 0 }),
      min_health: rawRequest.min_health == null ? 0.25 : numberValue(rawRequest.min_health, 'min_health', { min: 0, max: 1 }),
      preferred_hosts: uniqueStrings(rawRequest.preferred_hosts ?? [], 'preferred_hosts', { max: 20, itemMax: 80 }),
      preferred_tags: uniqueStrings(rawRequest.preferred_tags ?? [], 'preferred_tags', { max: 20, itemMax: 80 }),
      allowed_hosts: uniqueStrings(rawRequest.allowed_hosts ?? [], 'allowed_hosts', { max: 20, itemMax: 80 }),
      allowed_models: uniqueStrings(rawRequest.allowed_models ?? [], 'allowed_models', { max: 100, itemMax: 200 }),
    };
    const caps = requiredCapabilities(request);
    const evaluations = this.registry.entries.map((entry) => {
      const result = eligible(entry, request, caps);
      return { model_id: entry.model_id, provider: entry.provider, host: entry.host, eligible: result.ok, rejection_reasons: result.reasons, estimated_cost_micros: result.estimated_cost_micros, score: result.ok ? score(entry, request, result.estimated_cost_micros) : null, entry };
    });
    const ranked = evaluations.filter((item) => item.eligible).sort((a, b) => b.score - a.score || b.entry.reliability - a.entry.reliability || a.model_id.localeCompare(b.model_id));
    if (ranked.length === 0) throw new PolicyError('No eligible model route', { required_capabilities: caps, evaluations: evaluations.map(({ entry, ...item }) => item) });
    const selected = ranked[0];
    const decision = {
      schema: ROUTE_DECISION_SCHEMA,
      schema_version: 1,
      route_id: deterministicId('route', { registry: this.registry.digest, request, selected: selected.model_id }),
      registry_version: this.registry.registry_version,
      registry_digest: this.registry.digest,
      mission_id: request.mission_id,
      work_item_id: request.work_item_id,
      model_id: selected.model_id,
      provider: selected.provider,
      host: selected.host,
      required_capabilities: caps,
      context_tokens: request.context_tokens,
      estimated_cost_micros: selected.estimated_cost_micros,
      score: selected.score,
      reasons: [`eligible for ${caps.join(', ')}`, `risk ceiling ${selected.entry.risk_ceiling}`, `context ${request.context_tokens}/${selected.entry.max_context_tokens}`, `health ${selected.entry.health}`, `quality ${selected.entry.quality}`, `reliability ${selected.entry.reliability}`],
      fallback_chain: ranked.slice(1, 6).map((item) => ({ model_id: item.model_id, provider: item.provider, host: item.host, score: item.score, estimated_cost_micros: item.estimated_cost_micros })),
      rejected: evaluations.filter((item) => !item.eligible).map(({ entry, ...item }) => item),
      created_at: new Date().toISOString(),
    };
    decision.digest = sha256(decision);
    return deepFreeze(decision);
  }

  verify(decision) {
    plainObject(decision, 'route_decision');
    const copy = cloneJson(decision); const digest = copy.digest; delete copy.digest;
    if (digest !== sha256(copy)) throw new IntegrityError('RouteDecision digest mismatch');
    if (decision.schema !== ROUTE_DECISION_SCHEMA || decision.registry_digest !== this.registry.digest) throw new IntegrityError('RouteDecision registry mismatch');
    const entry = this.registry.entries.find((item) => item.model_id === decision.model_id);
    if (!entry) throw new IntegrityError('RouteDecision references unknown model');
    return { ok: true, route_id: decision.route_id, model_id: decision.model_id, registry_digest: decision.registry_digest };
  }

  observe({ routeDecision, report, attempt = 1 }) {
    this.verify(routeDecision);
    plainObject(report, 'model observation report');
    const status = report.status === 'success' ? 'success' : 'failed';
    const usage = report.usage && typeof report.usage === 'object' ? report.usage : {};
    const observation = {
      schema: MODEL_OBSERVATION_SCHEMA,
      schema_version: 1,
      observation_id: deterministicId('modelobs', {
        route_id: routeDecision.route_id,
        run_id: report.run_id ?? null,
        report_digest: report.integrity?.report_digest ?? sha256(report),
        attempt,
      }),
      route_id: routeDecision.route_id,
      registry_digest: routeDecision.registry_digest,
      mission_id: routeDecision.mission_id,
      work_item_id: routeDecision.work_item_id,
      model_id: routeDecision.model_id,
      provider: routeDecision.provider,
      host: routeDecision.host,
      attempt: integer(attempt, 'model observation attempt', { min: 1, max: 10_000 }),
      status,
      success: status === 'success',
      failure_type: status === 'failed' ? String(report.failure?.type ?? 'unknown_failure').slice(0, 120) : null,
      run_id: report.run_id == null ? null : stringValue(String(report.run_id), 'model observation run_id', { max: 200 }),
      report_digest: report.integrity?.report_digest ?? sha256(report),
      calls: safeUsageInteger(usage.calls ?? 1, 'model observation calls', { max: 1_000_000 }),
      tokens: safeUsageInteger(usage.tokens ?? 0, 'model observation tokens', { max: 10_000_000_000 }),
      cost_micros: safeUsageInteger(usage.cost_micros ?? 0, 'model observation cost_micros'),
      latency_ms: safeUsageInteger(usage.wall_time_ms ?? 0, 'model observation latency_ms', { max: 86_400_000 }),
      observed_at: new Date().toISOString(),
    };
    observation.digest = sha256(observation);
    return deepFreeze(observation);
  }

  verifyObservation(observation) {
    plainObject(observation, 'model_observation');
    const copy = cloneJson(observation); const digest = copy.digest; delete copy.digest;
    if (digest !== sha256(copy)) throw new IntegrityError('ModelObservation digest mismatch');
    if (observation.schema !== MODEL_OBSERVATION_SCHEMA || observation.registry_digest !== this.registry.digest) throw new IntegrityError('ModelObservation registry mismatch');
    const routeModel = this.registry.entries.find((entry) => entry.model_id === observation.model_id);
    if (!routeModel || routeModel.provider !== observation.provider || routeModel.host !== observation.host) throw new IntegrityError('ModelObservation references an unknown route model');
    if (observation.success !== (observation.status === 'success')) throw new IntegrityError('ModelObservation success state mismatch');
    if (!Number.isFinite(Date.parse(observation.observed_at))) throw new IntegrityError('ModelObservation observed_at is invalid');
    return { ok: true, observation_id: observation.observation_id, model_id: observation.model_id, status: observation.status };
  }

  summarizeObservations(observations = []) {
    const grouped = new Map();
    for (const observation of observations) {
      this.verifyObservation(observation);
      const current = grouped.get(observation.model_id) ?? {
        model_id: observation.model_id, provider: observation.provider, host: observation.host, observations: 0, successes: 0, failures: 0,
        latency_values: [], tokens: 0, cost_micros: 0, last_observed_at: null, failure_types: {},
      };
      current.observations += 1;
      current.successes += observation.success ? 1 : 0;
      current.failures += observation.success ? 0 : 1;
      current.latency_values.push(observation.latency_ms);
      current.tokens += observation.tokens;
      current.cost_micros += observation.cost_micros;
      if (!current.last_observed_at || observation.observed_at > current.last_observed_at) current.last_observed_at = observation.observed_at;
      if (observation.failure_type) current.failure_types[observation.failure_type] = (current.failure_types[observation.failure_type] ?? 0) + 1;
      grouped.set(observation.model_id, current);
    }
    return [...grouped.values()].map((item) => {
      const summary = {
        model_id: item.model_id, provider: item.provider, host: item.host, observations: item.observations, successes: item.successes, failures: item.failures,
        success_rate: item.observations ? Number((item.successes / item.observations).toFixed(6)) : null,
        average_latency_ms: item.observations ? Math.round(item.latency_values.reduce((sum, value) => sum + value, 0) / item.observations) : 0,
        p95_latency_ms: percentile95(item.latency_values), tokens: item.tokens, cost_micros: item.cost_micros,
        last_observed_at: item.last_observed_at, failure_types: item.failure_types,
      };
      summary.digest = sha256(summary);
      return deepFreeze(summary);
    }).sort((a, b) => a.model_id.localeCompare(b.model_id));
  }

  withObservations(observations = []) {
    const byModel = new Map(observations.map((item) => [item.model_id, item]));
    const entries = this.registry.entries.map((entry) => {
      const obs = byModel.get(entry.model_id);
      if (!obs) return cloneJson(entry);
      return { ...cloneJson(entry), health: obs.health == null ? entry.health : numberValue(obs.health, 'observation.health', { min: 0, max: 1 }), reliability: obs.reliability == null ? entry.reliability : numberValue(obs.reliability, 'observation.reliability', { min: 0, max: 1 }), latency_ms: obs.latency_ms == null ? entry.latency_ms : integer(obs.latency_ms, 'observation.latency_ms', { min: 0, max: 3_600_000 }) };
    });
    return new ModelRouter({ registry: { schema: MODEL_REGISTRY_SCHEMA, schema_version: 1, registry_version: `${this.registry.registry_version}+observed`, entries } });
  }
}
