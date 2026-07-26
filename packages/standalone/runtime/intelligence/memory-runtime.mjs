import { HashChainStore } from '../core/atomic-store.mjs';
import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { ConflictError, IntegrityError, PolicyError, ValidationError } from '../core/errors.mjs';
import { arrayValue, boundedJson, enumValue, numberValue, plainObject, stringValue, uniqueStrings } from '../core/validate.mjs';
import { MEMORY_ENTRY_SCHEMA, MEMORY_KINDS, MEMORY_STATUSES } from './domain.mjs';

function tokenize(value) {
  return new Set(String(value ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}_./:-]+/u).filter((token) => token.length >= 2).slice(0, 500));
}

function entryDigest(entry) { const copy = cloneJson(entry); delete copy.digest; delete copy.retrieval_score; return sha256(copy); }
function nowIso() { return new Date().toISOString(); }

function normalizeRefs(refs, label) {
  return arrayValue(refs ?? [], label, { max: 128 }).map((item, index) => {
    plainObject(item, `${label}[${index}]`);
    return {
      type: stringValue(item.type, `${label}[${index}].type`, { max: 80 }),
      id: stringValue(item.id, `${label}[${index}].id`, { max: 256 }),
      digest: item.digest == null ? null : stringValue(item.digest, `${label}[${index}].digest`, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ }),
    };
  });
}

export class OrganizationMemoryRuntime {
  constructor({ dataDir, recordId = 'organization', maxEntries = 20_000 } = {}) {
    if (!dataDir) throw new ValidationError('Memory dataDir is required');
    this.store = new HashChainStore(dataDir, { namespace: 'organization-memory' });
    this.recordId = recordId;
    this.maxEntries = maxEntries;
  }

  async ensure() {
    try { return await this.store.read(this.recordId); }
    catch (error) {
      if (!/ENOENT|no such file|Record/i.test(`${error.code ?? ''} ${error.message}`)) throw error;
      try {
        return await this.store.create(this.recordId, { schema_version: 1, entries: [], created_at: nowIso() }, { type: 'memory.store_created', actor: 'memory-runtime', data: {} });
      } catch (createError) {
        if (createError.code !== 'conflict_error') throw createError;
        return this.store.read(this.recordId);
      }
    }
  }

  createEntry({ kind, title, content, mission_id = null, project_id = null, task_id = null, role_id = null, status = 'proposed', confidence = 0.5, tags = [], knowledge_node_ids = [], source_refs = [], derived_from = [], valid_at = null, expires_at = null, sensitivity = 'internal', metadata = {}, verified_by = null }) {
    const normalizedKind = enumValue(kind, MEMORY_KINDS, 'memory kind');
    const normalizedStatus = enumValue(status, MEMORY_STATUSES, 'memory status');
    const sources = normalizeRefs(source_refs, 'source_refs');
    if (normalizedStatus === 'verified' && sources.length === 0) throw new PolicyError('Verified memory requires provenance');
    const seed = { kind: normalizedKind, title, content, mission_id, project_id, task_id, source_refs: sources };
    const entry = {
      schema: MEMORY_ENTRY_SCHEMA,
      schema_version: 1,
      memory_id: deterministicId('memory', seed, 24),
      kind: normalizedKind,
      title: stringValue(title, 'memory title', { min: 3, max: 500 }),
      content: cloneJson(content),
      status: normalizedStatus,
      confidence: numberValue(confidence, 'memory confidence', { min: 0, max: 1 }),
      mission_id, project_id, task_id, role_id,
      tags: uniqueStrings([...new Set(tags)], 'memory tags', { max: 64, itemMax: 100 }).sort(),
      knowledge_node_ids: uniqueStrings([...new Set(knowledge_node_ids)], 'knowledge_node_ids', { max: 256, itemMax: 200 }).sort(),
      source_refs: sources,
      derived_from: uniqueStrings([...new Set(derived_from)], 'derived_from', { max: 128, itemMax: 200 }).sort(),
      valid_at: valid_at ?? nowIso(),
      expires_at,
      sensitivity: enumValue(sensitivity, ['public', 'internal', 'confidential', 'restricted'], 'memory sensitivity'),
      metadata: cloneJson(metadata),
      verified_by: normalizedStatus === 'verified' ? stringValue(verified_by, 'verified_by', { max: 200 }) : null,
      verified_at: normalizedStatus === 'verified' ? nowIso() : null,
      superseded_by: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    boundedJson(entry.content, 'memory content', { maxBytes: 500_000 });
    boundedJson(entry.metadata, 'memory metadata', { maxBytes: 100_000 });
    entry.digest = entryDigest(entry);
    return deepFreeze(entry);
  }

  async remember(input, { actor = 'memory-runtime', eventType = 'memory.proposed' } = {}) {
    await this.ensure();
    const entry = this.createEntry(input);
    return this.store.update(this.recordId, ({ state, emit }) => {
      const existing = state.entries.find((item) => item.memory_id === entry.memory_id);
      if (existing) return state;
      if (state.entries.length >= this.maxEntries) throw new PolicyError('Organization memory entry bound exceeded');
      state.entries.push(cloneJson(entry));
      emit(eventType, actor, { memory_id: entry.memory_id, kind: entry.kind, status: entry.status, mission_id: entry.mission_id });
      return state;
    }).then((state) => state.entries.find((item) => item.memory_id === entry.memory_id));
  }

  async promote(memoryId, { verifier_role_id, evidence_refs, confidence = 1 } = {}) {
    const sources = normalizeRefs(evidence_refs, 'evidence_refs');
    if (!sources.length) throw new PolicyError('Memory promotion requires evidence');
    await this.ensure();
    return this.store.update(this.recordId, ({ state, emit }) => {
      const entry = state.entries.find((item) => item.memory_id === memoryId);
      if (!entry) throw new ValidationError('Memory entry not found');
      if (entry.status === 'rejected' || entry.status === 'superseded') throw new ConflictError(`Cannot promote ${entry.status} memory`);
      if (entry.role_id && verifier_role_id === entry.role_id) throw new PolicyError('Memory producer cannot self-verify');
      entry.status = 'verified'; entry.confidence = numberValue(confidence, 'confidence', { min: 0, max: 1 }); entry.source_refs = [...entry.source_refs, ...sources].slice(0, 128); entry.verified_by = stringValue(verifier_role_id, 'verifier_role_id', { max: 200 }); entry.verified_at = nowIso(); entry.updated_at = nowIso();
      delete entry.digest; entry.digest = entryDigest(entry);
      emit('memory.verified', verifier_role_id, { memory_id: entry.memory_id, source_count: entry.source_refs.length });
      return state;
    }).then((state) => state.entries.find((item) => item.memory_id === memoryId));
  }

  async reject(memoryId, { actor_role_id, reason }) {
    await this.ensure();
    return this.store.update(this.recordId, ({ state, emit }) => {
      const entry = state.entries.find((item) => item.memory_id === memoryId);
      if (!entry) throw new ValidationError('Memory entry not found');
      entry.status = 'rejected'; entry.rejection = { actor_role_id, reason: stringValue(reason, 'reason', { max: 2000 }), at: nowIso() }; entry.updated_at = nowIso();
      delete entry.digest; entry.digest = entryDigest(entry);
      emit('memory.rejected', actor_role_id, { memory_id: entry.memory_id });
      return state;
    }).then((state) => state.entries.find((item) => item.memory_id === memoryId));
  }

  async supersede(memoryId, replacementInput, { actor_role_id = 'memory-runtime' } = {}) {
    const replacement = await this.remember({ ...replacementInput, derived_from: [...(replacementInput.derived_from ?? []), memoryId] }, { actor: actor_role_id });
    await this.store.update(this.recordId, ({ state, emit }) => {
      const entry = state.entries.find((item) => item.memory_id === memoryId);
      if (!entry) throw new ValidationError('Memory entry not found');
      entry.status = 'superseded'; entry.superseded_by = replacement.memory_id; entry.updated_at = nowIso(); delete entry.digest; entry.digest = entryDigest(entry);
      emit('memory.superseded', actor_role_id, { memory_id: memoryId, superseded_by: replacement.memory_id });
      return state;
    });
    return replacement;
  }

  async retrieve({ query, role_id = null, role_type = null, mission_id = null, task_id = null, knowledge_node_ids = [], tags = [], classification = 'internal', limit = 12, include_proposed = false, as_of = new Date().toISOString() }) {
    const state = await this.ensure();
    const queryTokens = tokenize(query);
    const wantedTags = new Set(tags);
    const wantedNodes = new Set(knowledge_node_ids);
    const rank = { public: 0, internal: 1, confidential: 2, restricted: 3 };
    const scored = [];
    for (const entry of state.entries) {
      this.verifyEntry(entry);
      if (!include_proposed && entry.status !== 'verified') continue;
      if (entry.status === 'superseded' || entry.status === 'rejected') continue;
      if (entry.expires_at && Date.parse(entry.expires_at) <= Date.parse(as_of)) continue;
      if (rank[entry.sensitivity] > rank[classification]) continue;
      const entryTokens = tokenize(`${entry.title} ${JSON.stringify(entry.content)} ${entry.tags.join(' ')}`);
      let lexical = 0; for (const token of queryTokens) if (entryTokens.has(token)) lexical += 1;
      const tagScore = entry.tags.filter((tag) => wantedTags.has(tag)).length * 3;
      const graphScore = entry.knowledge_node_ids.filter((id) => wantedNodes.has(id)).length * 5;
      const missionScore = mission_id && entry.mission_id === mission_id ? 2 : 0;
      const taskScore = task_id && entry.task_id === task_id ? 2 : 0;
      const roleScore = role_id && entry.role_id === role_id ? 1 : role_type && entry.metadata?.role_type === role_type ? 1 : 0;
      const score = lexical + tagScore + graphScore + missionScore + taskScore + roleScore + entry.confidence;
      if (score > 0 || queryTokens.size === 0) scored.push({ ...cloneJson(entry), retrieval_score: Number(score.toFixed(4)) });
    }
    return scored.sort((a, b) => b.retrieval_score - a.retrieval_score || Date.parse(b.valid_at) - Date.parse(a.valid_at) || a.memory_id.localeCompare(b.memory_id)).slice(0, Math.max(1, Math.min(100, limit)));
  }

  verifyEntry(entry) {
    plainObject(entry, 'memory_entry');
    if (entry.schema !== MEMORY_ENTRY_SCHEMA || !MEMORY_KINDS.includes(entry.kind) || !MEMORY_STATUSES.includes(entry.status)) throw new ValidationError('Unsupported memory entry');
    if (entry.digest !== entryDigest(entry)) throw new IntegrityError('MemoryEntry digest mismatch');
    if (entry.status === 'verified' && (!entry.source_refs?.length || !entry.verified_by)) throw new IntegrityError('Verified memory lacks provenance or verifier');
    return { ok: true, memory_id: entry.memory_id, status: entry.status, digest: entry.digest };
  }

  async verifyIntegrity() {
    const state = await this.ensure();
    for (const entry of state.entries) this.verifyEntry(entry);
    const eventHead = await this.store.verifyEvents(this.recordId, state.event_head);
    return { ok: true, entries: state.entries.length, verified: state.entries.filter((item) => item.status === 'verified').length, event_head: eventHead };
  }
}
