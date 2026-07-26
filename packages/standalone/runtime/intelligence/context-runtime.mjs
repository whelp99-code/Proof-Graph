import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { BudgetError, IntegrityError, PolicyError, ValidationError } from '../core/errors.mjs';
import { boundedJson, plainObject, stringValue } from '../core/validate.mjs';
import { CONTEXT_PACKET_SCHEMA, DATA_CLASSIFICATIONS } from './domain.mjs';

const SECRET_KEY = /(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|private[_-]?key|authorization|cookie)(?:$|_)/i;
const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+\/-]{12,})/g;
const PATH_HOME = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/g;
const TIMESTAMP_KEYS = new Set(['updated_at', 'completed_at', 'verified_at', 'valid_at', 'created_at', 'captured_at', 'occurred_at', 'decided_at', 'started_at']);

const DEFAULT_POLICIES = Object.freeze({
  coordinator: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 120_000 },
  executive: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 120_000 },
  researcher: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'impacts', 'memory'], max_bytes: 90_000 },
  planner: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 110_000 },
  developer: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 120_000 },
  verifier: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 120_000, blind_producer_commentary: true },
  synthesizer: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 140_000 },
  direct: { sections: ['objective', 'constraints', 'work_item', 'memory'], max_bytes: 60_000 },
  specialist: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 90_000 },
  manager: { sections: ['objective', 'constraints', 'work_item', 'dependencies', 'artifacts', 'contracts', 'impacts', 'memory'], max_bytes: 110_000 },
});

function redactValue(value, key = '', redactions = []) {
  const leafKey = String(key).split(/[.\[\]]/).filter(Boolean).at(-1) ?? String(key);
  if (SECRET_KEY.test(leafKey)) {
    redactions.push({ path: key, reason: 'secret_key' });
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    let text = value.replace(SECRET_VALUE, (match) => {
      redactions.push({ path: key, reason: 'secret_pattern' });
      return `[REDACTED:${sha256(match).slice(0, 12)}]`;
    });
    text = text.replace(PATH_HOME, (match) => {
      redactions.push({ path: key, reason: 'user_home_path' });
      const separator = match.includes('\\') ? '\\' : '/';
      return `[HOME]${separator}`;
    });
    return text;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${key}[${index}]`, redactions));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = redactValue(child, key ? `${key}.${childKey}` : childKey, redactions);
    return out;
  }
  return value;
}


function finiteContextValue(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => finiteContextValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = finiteContextValue(child);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return value;
}

function boundedSections(sections, maxBytes) {
  const entries = Object.entries(sections);
  const output = {};
  const dropped = [];
  for (const [name, value] of entries) {
    const candidate = { ...output, [name]: value };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) output[name] = value;
    else dropped.push(name);
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > maxBytes) throw new BudgetError('Context packet could not be bounded');
  return { output, dropped };
}

function collectTimestamps(value, output = [], depth = 0, budget = { visited: 0 }) {
  if (value == null || depth > 16 || budget.visited >= 20_000) return output;
  budget.visited += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, output, depth + 1, budget);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (TIMESTAMP_KEYS.has(key) && typeof child === 'string') {
      const timestamp = Date.parse(child);
      if (Number.isFinite(timestamp)) output.push(timestamp);
    }
    if (child && typeof child === 'object') collectTimestamps(child, output, depth + 1, budget);
  }
  return output;
}

function freshnessMetadata(value, observedAt, maxSourceAgeS) {
  const observedMs = Date.parse(observedAt);
  const timestamps = collectTimestamps(value);
  if (!timestamps.length) return {
    observed_at: observedAt, source_updated_at: null, source_oldest_at: null, age_seconds: null, oldest_age_seconds: null, freshness: 'unknown', stale: false,
  };
  const newestMs = Math.max(...timestamps);
  const oldestMs = Math.min(...timestamps);
  const ageSeconds = Math.max(0, Math.floor((observedMs - newestMs) / 1000));
  const oldestAgeSeconds = Math.max(0, Math.floor((observedMs - oldestMs) / 1000));
  const stale = maxSourceAgeS != null && oldestAgeSeconds > maxSourceAgeS;
  return {
    observed_at: observedAt,
    source_updated_at: new Date(newestMs).toISOString(),
    source_oldest_at: new Date(oldestMs).toISOString(),
    age_seconds: ageSeconds,
    oldest_age_seconds: oldestAgeSeconds,
    freshness: stale ? 'stale' : 'fresh',
    stale,
  };
}

function sourceRef(type, id, value, { freshnessValue = value, observedAt, maxSourceAgeS = null, ...extra } = {}) {
  const normalized = finiteContextValue(value);
  return { type, id: String(id), digest: sha256(normalized), ...freshnessMetadata(freshnessValue, observedAt, maxSourceAgeS), ...extra };
}

function rolePolicy(role, workItem, overrides = {}) {
  const type = role?.role_type ?? workItem?.role ?? 'specialist';
  const base = DEFAULT_POLICIES[type] ?? DEFAULT_POLICIES.specialist;
  const policy = { max_source_age_s: null, reject_stale_sources: false, ...base, ...overrides };
  if (!Array.isArray(policy.sections) || !Number.isSafeInteger(policy.max_bytes) || policy.max_bytes < 1 || policy.max_bytes > 500_000) {
    throw new ValidationError('Invalid ContextPolicy');
  }
  if (policy.max_source_age_s != null && (!Number.isSafeInteger(policy.max_source_age_s) || policy.max_source_age_s < 0 || policy.max_source_age_s > 315_360_000)) {
    throw new ValidationError('Invalid ContextPolicy max_source_age_s');
  }
  if (typeof policy.reject_stale_sources !== 'boolean') throw new ValidationError('Invalid ContextPolicy reject_stale_sources');
  return policy;
}

function blindForVerifier(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = cloneJson(value);
  for (const key of ['self_assessment', 'confidence_explanation', 'producer_commentary', 'recommended_verdict']) delete copy[key];
  if (Array.isArray(copy.deliverables)) copy.deliverables = copy.deliverables.map((item) => blindForVerifier(item));
  return copy;
}

export class ContextRuntime {
  constructor({ policies = {}, maxSources = 256 } = {}) {
    this.policies = cloneJson(policies);
    this.maxSources = maxSources;
  }

  compile({ mission, workItem, dependencies = [], artifacts = [], contracts = [], impacts = [], memory = [], classification = 'internal', policy = {} }) {
    plainObject(mission, 'mission');
    plainObject(workItem, 'workItem');
    if (!DATA_CLASSIFICATIONS.includes(classification)) throw new ValidationError(`Unsupported data classification: ${classification}`);
    const role = mission.organization?.roles?.find((item) => item.role_id === workItem.assigned_role_id) ?? null;
    const selectedPolicy = rolePolicy(role, workItem, { ...(this.policies[role?.role_type ?? workItem.role] ?? {}), ...policy });
    const observedAt = new Date().toISOString();
    const sources = [];
    const rawSections = {};
    const add = (name, value, type, id, freshnessValue = value) => {
      if (!selectedPolicy.sections.includes(name) || value == null) return;
      const normalized = finiteContextValue(value);
      if (normalized === undefined) return;
      rawSections[name] = cloneJson(normalized);
      sources.push(sourceRef(type, id, normalized, { freshnessValue, observedAt, maxSourceAgeS: selectedPolicy.max_source_age_s }));
    };
    add('objective', mission.objective, 'mission', mission.mission_id, mission);
    add('constraints', mission.task?.constraints ?? [], 'task', mission.task?.task_id ?? mission.mission_id, mission.task);
    add('work_item', {
      work_item_id: workItem.work_item_id,
      stage_id: workItem.stage_id,
      kind: workItem.kind,
      objective: workItem.objective,
      attempt: workItem.attempts + (workItem.status === 'running' ? 0 : 1),
      acceptance_criteria: mission.task?.acceptance_criteria ?? [],
    }, 'work_item', workItem.work_item_id, workItem);
    add('dependencies', dependencies.map((item) => ({ work_item_id: item.work_item_id, stage_id: item.stage_id, kind: item.kind, status: item.status, output: selectedPolicy.blind_producer_commentary ? blindForVerifier(item.output) : item.output })), 'dependency_set', workItem.work_item_id, dependencies);
    add('artifacts', artifacts.map((item) => ({ artifact_id: item.artifact_id, name: item.name, media_type: item.media_type, digest: item.digest, producer_role_id: item.producer_role_id, content: selectedPolicy.blind_producer_commentary ? blindForVerifier(item.content) : item.content })), 'artifact_set', mission.mission_id, artifacts);
    add('contracts', contracts.map((item) => ({ contract_id: item.contract_id, type: item.type, status: item.status, producer_role_id: item.producer_role_id, consumer_role_ids: item.consumer_role_ids, deliverables: item.deliverables, evidence_requirements: item.evidence_requirements })), 'contract_set', workItem.work_item_id, contracts);
    add('impacts', impacts, 'impact_set', workItem.work_item_id, impacts);
    add('memory', memory.map((item) => ({ memory_id: item.memory_id, kind: item.kind, title: item.title, content: item.content, confidence: item.confidence, valid_at: item.valid_at, provenance: item.provenance })), 'memory_set', mission.mission_id, memory);
    if (sources.length > this.maxSources) throw new BudgetError('Context source count exceeds policy');
    const staleSources = sources.filter((item) => item.stale);
    if (selectedPolicy.reject_stale_sources && staleSources.length) throw new PolicyError('Context contains stale sources', { source_ids: staleSources.map((item) => item.id), max_source_age_s: selectedPolicy.max_source_age_s });
    const redactions = [];
    const redacted = redactValue(rawSections, '', redactions);
    const { output: sections, dropped } = boundedSections(redacted, selectedPolicy.max_bytes);
    const packet = {
      schema: CONTEXT_PACKET_SCHEMA,
      schema_version: 1,
      packet_id: deterministicId('ctx', { mission_id: mission.mission_id, work_item_id: workItem.work_item_id, attempt: workItem.attempts, sources: sources.map((item) => item.digest), policy: selectedPolicy }),
      mission_id: mission.mission_id,
      work_item_id: workItem.work_item_id,
      role_id: workItem.assigned_role_id,
      role_type: role?.role_type ?? workItem.role ?? 'specialist',
      classification,
      policy: { sections: [...selectedPolicy.sections], max_bytes: selectedPolicy.max_bytes, blind_producer_commentary: Boolean(selectedPolicy.blind_producer_commentary), max_source_age_s: selectedPolicy.max_source_age_s, reject_stale_sources: selectedPolicy.reject_stale_sources },
      sections,
      sources: sources.slice(0, this.maxSources),
      redactions,
      dropped_sections: dropped,
      stale_source_count: staleSources.length,
      unknown_freshness_source_count: sources.filter((item) => item.freshness === 'unknown').length,
      byte_size: Buffer.byteLength(JSON.stringify(sections), 'utf8'),
      token_estimate: Math.ceil(Buffer.byteLength(JSON.stringify(sections), 'utf8') / 4),
      created_at: observedAt,
    };
    packet.digest = sha256(packet);
    boundedJson(packet, 'context_packet', { maxBytes: 600_000 });
    return deepFreeze(packet);
  }

  verify(packet) {
    plainObject(packet, 'context_packet');
    const copy = cloneJson(packet);
    const digest = copy.digest;
    delete copy.digest;
    if (digest !== sha256(copy)) throw new IntegrityError('ContextPacket digest mismatch');
    if (packet.schema !== CONTEXT_PACKET_SCHEMA) throw new ValidationError('Unsupported ContextPacket schema');
    if (packet.byte_size > packet.policy.max_bytes) throw new BudgetError('ContextPacket exceeds policy');
    let staleCount = 0;
    let unknownCount = 0;
    for (const source of packet.sources ?? []) {
      stringValue(source.type, 'context source type', { max: 80 });
      stringValue(source.id, 'context source id', { max: 256 });
      stringValue(source.digest, 'context source digest', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
      if (!['unknown', 'fresh', 'stale'].includes(source.freshness)) throw new IntegrityError('Context source freshness is invalid');
      const observedMs = Date.parse(source.observed_at);
      if (!Number.isFinite(observedMs)) throw new IntegrityError('Context source observed_at is invalid');
      if (source.source_updated_at == null) {
        if (source.source_oldest_at != null || source.age_seconds != null || source.oldest_age_seconds != null || source.freshness !== 'unknown' || source.stale !== false) throw new IntegrityError('Unknown source freshness fields are inconsistent');
        unknownCount += 1;
        continue;
      }
      const newestMs = Date.parse(source.source_updated_at);
      const oldestMs = Date.parse(source.source_oldest_at);
      if (!Number.isFinite(newestMs) || !Number.isFinite(oldestMs) || oldestMs > newestMs) throw new IntegrityError('Context source timestamps are invalid');
      const ageSeconds = Math.max(0, Math.floor((observedMs - newestMs) / 1000));
      const oldestAgeSeconds = Math.max(0, Math.floor((observedMs - oldestMs) / 1000));
      if (source.age_seconds !== ageSeconds || source.oldest_age_seconds !== oldestAgeSeconds) throw new IntegrityError('Context source age is inconsistent');
      const expectedStale = packet.policy.max_source_age_s != null && oldestAgeSeconds > packet.policy.max_source_age_s;
      if (source.stale !== expectedStale || source.freshness !== (expectedStale ? 'stale' : 'fresh')) throw new IntegrityError('Context source stale state is inconsistent');
      if (expectedStale) staleCount += 1;
    }
    if (packet.stale_source_count !== staleCount || packet.unknown_freshness_source_count !== unknownCount) throw new IntegrityError('Context source freshness counts mismatch');
    if (packet.policy.reject_stale_sources && staleCount) throw new PolicyError('ContextPacket violates stale source policy');
    return { ok: true, packet_id: packet.packet_id, digest: packet.digest, source_count: packet.sources.length, redaction_count: packet.redactions.length, stale_source_count: staleCount, unknown_freshness_source_count: unknownCount };
  }
}
