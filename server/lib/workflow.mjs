import { randomId, nowIso, sha256 } from './canonical.mjs';
import {
  clearActiveRun,
  createRun,
  projectKey,
  readActiveRun,
  readReport,
  readRun,
  readVerifiedRun,
  readSourceContent,
  reserveBudget,
  resolveDataDir,
  resolveProjectDir,
  setActiveRun,
  sourcePath,
  verifyEventChain,
  withRunTransaction,
  writeReportArtifacts,
  writeSourceContent,
} from './store.mjs';
import { exactQuoteMatch, fetchVerifiedSource, findTextMatches, normalizeText, validateUrlSyntax } from './source.mjs';
import { SecurityError, StateError, ValidationError } from './errors.mjs';
import {
  arrayValue,
  enumValue,
  identifier,
  integerValue,
  rejectUnknownKeys,
  runId as validateRunId,
  stringValue,
  uniqueStrings,
} from './validate.mjs';

export const DEFAULT_POLICY = Object.freeze({
  max_tool_calls: 80,
  max_source_fetches: 24,
  max_claims: 24,
  max_agents: 6,
  max_wall_time_seconds: 1800,
  min_sources_per_supported_claim: 2,
  min_sources_per_refuted_claim: 1,
  allowed_domains: [],
});

const TASK_ROLES = ['research-primary', 'research-secondary', 'verifier'];
const TASK_OUTCOMES = ['success', 'failed', 'blocked'];
const STANCES = ['supports', 'refutes', 'context'];
const VERDICTS = ['supported', 'refuted', 'insufficient', 'mixed'];
const EVIDENCE_ACTORS = new Set(['research-primary', 'research-secondary', 'verifier']);

function requireActor(actor, allowed, operation) {
  const accepted = allowed instanceof Set ? allowed : new Set(allowed);
  if (!accepted.has(actor)) {
    throw new SecurityError(`${operation} is not permitted for actor ${actor}`, {
      actor,
      allowed_actors: [...accepted],
    });
  }
}

function validateDomain(domain, name) {
  const value = stringValue(domain, name, { min: 1, max: 253 }).toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new ValidationError(`${name} is not a valid DNS hostname`);
  }
  return value;
}

export function validatePolicy(input = {}) {
  rejectUnknownKeys(input, Object.keys(DEFAULT_POLICY), 'policy');
  const policy = {
    max_tool_calls: input.max_tool_calls === undefined ? DEFAULT_POLICY.max_tool_calls : integerValue(input.max_tool_calls, 'policy.max_tool_calls', { min: 10, max: 500 }),
    max_source_fetches: input.max_source_fetches === undefined ? DEFAULT_POLICY.max_source_fetches : integerValue(input.max_source_fetches, 'policy.max_source_fetches', { min: 1, max: 100 }),
    max_claims: input.max_claims === undefined ? DEFAULT_POLICY.max_claims : integerValue(input.max_claims, 'policy.max_claims', { min: 1, max: 100 }),
    max_agents: input.max_agents === undefined ? DEFAULT_POLICY.max_agents : integerValue(input.max_agents, 'policy.max_agents', { min: 1, max: 20 }),
    max_wall_time_seconds: input.max_wall_time_seconds === undefined ? DEFAULT_POLICY.max_wall_time_seconds : integerValue(input.max_wall_time_seconds, 'policy.max_wall_time_seconds', { min: 60, max: 14400 }),
    min_sources_per_supported_claim: input.min_sources_per_supported_claim === undefined ? DEFAULT_POLICY.min_sources_per_supported_claim : integerValue(input.min_sources_per_supported_claim, 'policy.min_sources_per_supported_claim', { min: 1, max: 5 }),
    min_sources_per_refuted_claim: input.min_sources_per_refuted_claim === undefined ? DEFAULT_POLICY.min_sources_per_refuted_claim : integerValue(input.min_sources_per_refuted_claim, 'policy.min_sources_per_refuted_claim', { min: 1, max: 5 }),
    allowed_domains: input.allowed_domains === undefined ? [] : uniqueStrings(input.allowed_domains, 'policy.allowed_domains', { max: 100 }).map((domain, index) => validateDomain(domain, `policy.allowed_domains[${index}]`)),
  };
  if (policy.max_source_fetches > policy.max_tool_calls) {
    throw new ValidationError('policy.max_source_fetches cannot exceed policy.max_tool_calls');
  }
  return policy;
}

function validateTask(task, index) {
  rejectUnknownKeys(task, ['task_id', 'title', 'role'], `tasks[${index}]`);
  return {
    task_id: identifier(task.task_id, `tasks[${index}].task_id`),
    title: stringValue(task.title, `tasks[${index}].title`, { min: 3, max: 300 }),
    role: enumValue(task.role, `tasks[${index}].role`, TASK_ROLES),
    status: 'pending',
    actor: null,
    summary: null,
    completed_at: null,
  };
}

function validateClaim(claim, index) {
  rejectUnknownKeys(claim, ['claim_id', 'text', 'importance'], `claims[${index}]`);
  return {
    claim_id: identifier(claim.claim_id, `claims[${index}].claim_id`),
    text: stringValue(claim.text, `claims[${index}].text`, { min: 8, max: 2000 }),
    importance: claim.importance === undefined ? 'medium' : enumValue(claim.importance, `claims[${index}].importance`, ['high', 'medium', 'low']),
  };
}

export async function startRun(input, context = {}) {
  rejectUnknownKeys(input, ['objective', 'policy'], 'input');
  const objective = stringValue(input.objective, 'objective', { min: 10, max: 10000 });
  const policy = validatePolicy(input.policy ?? {});
  const dataDir = context.dataDir ?? resolveDataDir();
  const projectDir = context.projectDir ?? resolveProjectDir();
  const key = projectKey(projectDir);
  const existing = await readActiveRun(dataDir, key);
  if (existing) throw new StateError('A ProofGraph run is already active for this project', existing);
  const runId = randomId('pg');
  await setActiveRun(dataDir, key, runId);
  const startedAt = nowIso();
  const state = {
    schema_version: 1,
    product: 'proofgraph-claude',
    version: '0.2.0',
    run_id: runId,
    project_key: key,
    project_dir_sha256: sha256(projectDir),
    objective,
    status: 'active',
    quality_gate_passed: false,
    budget_exceeded_reason: null,
    created_at: startedAt,
    updated_at: startedAt,
    deadline_at: new Date(Date.now() + policy.max_wall_time_seconds * 1000).toISOString(),
    policy,
    counters: { tool_calls: 0, source_fetches: 0, agents_spawned: 0 },
    plan_registered: false,
    tasks: {},
    claims: {},
    sources: {},
    evidence: {},
    verdicts: {},
    classifications: {},
    final: null,
    event_head: { seq: 0, hash: '0'.repeat(64) },
  };
  try {
    await createRun(dataDir, state, {
      type: 'run.created',
      actor: 'user',
      data: {
        objective_sha256: sha256(objective),
        project_key: key,
        policy,
      },
    });
  } catch (error) {
    await clearActiveRun(dataDir, key, runId);
    throw error;
  }
  return {
    ok: true,
    run_id: runId,
    status: 'active',
    deadline_at: state.deadline_at,
    policy,
    note: 'Only one active ProofGraph run is allowed per project directory.',
  };
}

export async function registerPlan(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'tasks'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, ['planner'], 'pg_register_plan');
  const tasks = arrayValue(input.tasks, 'tasks', { min: 3, max: 12 }).map(validateTask);
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) throw new ValidationError('task_id values must be unique');
  const roles = new Set(tasks.map((task) => task.role));
  for (const required of TASK_ROLES) {
    if (!roles.has(required)) throw new ValidationError(`Plan must include a ${required} task`);
  }
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_register_plan' });
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    if (next.status !== 'active') throw new StateError(`Run is not active: ${next.status}`);
    if (next.plan_registered) throw new StateError('Plan is already registered');
    next.plan_registered = true;
    for (const task of tasks) next.tasks[task.task_id] = task;
    emit('plan.registered', actor, { task_ids: tasks.map((task) => task.task_id), roles: [...roles] });
  });
  return { ok: true, run_id: runId, tasks: Object.values(state.tasks) };
}

export async function registerClaims(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'claims'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, ['planner'], 'pg_register_claims');
  const claims = arrayValue(input.claims, 'claims', { min: 1, max: 50 }).map(validateClaim);
  if (new Set(claims.map((claim) => claim.claim_id)).size !== claims.length) throw new ValidationError('claim_id values must be unique');
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_register_claims' });
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    if (!next.plan_registered) throw new StateError('Register a plan before claims');
    if (Object.keys(next.claims).length + claims.length > next.policy.max_claims) {
      throw new ValidationError('Claim count exceeds policy.max_claims');
    }
    for (const claim of claims) {
      if (next.claims[claim.claim_id]) throw new StateError(`Claim already exists: ${claim.claim_id}`);
      next.claims[claim.claim_id] = {
        ...claim,
        producer: actor,
        created_at: nowIso(),
        evidence_ids: [],
        verdict_ids: [],
      };
    }
    emit('claims.registered', actor, { claim_ids: claims.map((claim) => claim.claim_id) });
  });
  return { ok: true, run_id: runId, claims: Object.values(state.claims) };
}

async function persistFetchedSource(dataDir, runId, actor, fetched, sourceId = randomId('src')) {
  const contentInfo = await writeSourceContent(dataDir, runId, sourceId, fetched.text);
  const metadata = {
    source_id: sourceId,
    requested_url: fetched.requested_url,
    final_url: fetched.final_url,
    hostname: fetched.hostname,
    fetched_at: fetched.fetched_at,
    status: fetched.status,
    content_type: fetched.content_type,
    raw_sha256: fetched.raw_sha256,
    text_sha256: contentInfo.sha256,
    bytes: contentInfo.bytes,
    redirect_chain: fetched.redirect_chain,
    prompt_injection_suspected: fetched.prompt_injection_suspected,
    prompt_injection_flags: fetched.prompt_injection_flags,
    fetched_by: actor,
  };
  await withRunTransaction(dataDir, runId, (next, emit) => {
    if (next.status !== 'active') throw new StateError(`Run is not active: ${next.status}`);
    next.sources[sourceId] = metadata;
    emit('source.fetched', actor, {
      source_id: sourceId,
      final_url: metadata.final_url,
      hostname: metadata.hostname,
      text_sha256: metadata.text_sha256,
      prompt_injection_suspected: metadata.prompt_injection_suspected,
    });
  });
  return {
    ...metadata,
    preview: fetched.text.slice(0, 6000),
    preview_truncated: fetched.text.length > 6000,
  };
}

export async function fetchSource(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'url'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, EVIDENCE_ACTORS, 'pg_fetch_source');
  const url = stringValue(input.url, 'url', { min: 8, max: 2048 });
  const dataDir = context.dataDir ?? resolveDataDir();
  const state = await readRun(dataDir, runId);
  validateUrlSyntax(url, state.policy.allowed_domains);
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_fetch_source', sourceFetch: true });
  try {
    const fetched = await fetchVerifiedSource(url, { allowedDomains: state.policy.allowed_domains });
    return { ok: true, run_id: runId, source: await persistFetchedSource(dataDir, runId, actor, fetched) };
  } catch (error) {
    await withRunTransaction(dataDir, runId, (next, emit) => {
      emit('source.fetch_failed', actor, { url_sha256: sha256(url), error: error.message, code: error.code ?? 'FETCH_ERROR' });
    }).catch(() => {});
    throw error;
  }
}

export async function importFixtureSource(input, context = {}) {
  if (process.env.PROOFGRAPH_TEST_MODE !== '1' && context.testMode !== true) {
    throw new SecurityError('Fixture source import is available only in test mode');
  }
  rejectUnknownKeys(input, ['run_id', 'actor', 'url', 'content', 'prompt_injection_suspected'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, EVIDENCE_ACTORS, 'pg_test_import_source');
  const url = validateUrlSyntax(stringValue(input.url, 'url', { min: 8, max: 2048 })).toString();
  const content = normalizeText(stringValue(input.content, 'content', { min: 20, max: 200000, trim: false }));
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_test_import_source', sourceFetch: true });
  const parsed = new URL(url);
  const fetched = {
    requested_url: url,
    final_url: url,
    hostname: parsed.hostname,
    fetched_at: nowIso(),
    status: 200,
    content_type: 'text/plain; charset=utf-8',
    raw_sha256: sha256(content),
    text_sha256: sha256(content),
    text: content,
    redirect_chain: [],
    prompt_injection_suspected: input.prompt_injection_suspected === true,
    prompt_injection_flags: input.prompt_injection_suspected === true ? ['TEST_FIXTURE_FLAG'] : [],
  };
  return { ok: true, run_id: runId, source: await persistFetchedSource(dataDir, runId, actor, fetched) };
}

export async function searchSource(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'source_id', 'query', 'max_matches'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, EVIDENCE_ACTORS, 'pg_search_source');
  const sourceId = identifier(input.source_id, 'source_id');
  const query = stringValue(input.query, 'query', { min: 2, max: 1000 });
  const maxMatches = input.max_matches === undefined ? 5 : integerValue(input.max_matches, 'max_matches', { min: 1, max: 10 });
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_search_source' });
  const state = await readRun(dataDir, runId);
  const source = state.sources[sourceId];
  if (!source) throw new StateError(`Unknown source: ${sourceId}`);
  const text = await readSourceContent(dataDir, runId, sourceId);
  if (sha256(text) !== source.text_sha256) throw new SecurityError('Stored source content hash mismatch');
  const matches = findTextMatches(text, query, maxMatches);
  await withRunTransaction(dataDir, runId, (_next, emit) => {
    emit('source.searched', actor, { source_id: sourceId, query_sha256: sha256(normalizeText(query)), match_count: matches.length });
  });
  return { ok: true, run_id: runId, source_id: sourceId, matches };
}

function validateEvidenceItem(item, index) {
  rejectUnknownKeys(item, ['claim_id', 'source_id', 'quote', 'stance'], `items[${index}]`);
  return {
    claim_id: identifier(item.claim_id, `items[${index}].claim_id`),
    source_id: identifier(item.source_id, `items[${index}].source_id`),
    quote: stringValue(item.quote, `items[${index}].quote`, { min: 12, max: 5000 }),
    stance: enumValue(item.stance, `items[${index}].stance`, STANCES),
  };
}

export async function attachEvidence(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'items'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, EVIDENCE_ACTORS, 'pg_attach_evidence');
  const items = arrayValue(input.items, 'items', { min: 1, max: 20 }).map(validateEvidenceItem);
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_attach_evidence' });
  const snapshot = await readRun(dataDir, runId);
  const prepared = [];
  for (const item of items) {
    const claim = snapshot.claims[item.claim_id];
    const source = snapshot.sources[item.source_id];
    if (!claim) throw new StateError(`Unknown claim: ${item.claim_id}`);
    if (!source) throw new StateError(`Unknown source: ${item.source_id}`);
    const text = await readSourceContent(dataDir, runId, item.source_id);
    if (sha256(text) !== source.text_sha256) throw new SecurityError(`Stored source hash mismatch: ${item.source_id}`);
    const match = exactQuoteMatch(text, item.quote);
    if (!match) throw new ValidationError('Evidence quote is not an exact normalized substring of the stored source', {
      claim_id: item.claim_id,
      source_id: item.source_id,
    });
    prepared.push({ ...item, match, source });
  }
  const { result } = await withRunTransaction(dataDir, runId, (next, emit) => {
    const evidenceIds = [];
    for (const item of prepared) {
      if (!next.claims[item.claim_id] || !next.sources[item.source_id]) throw new StateError('Claim or source changed during evidence attachment');
      const duplicate = Object.values(next.evidence).find((evidence) =>
        evidence.claim_id === item.claim_id &&
        evidence.source_id === item.source_id &&
        evidence.quote_sha256 === sha256(item.match.quote) &&
        evidence.stance === item.stance,
      );
      if (duplicate) {
        evidenceIds.push(duplicate.evidence_id);
        continue;
      }
      const evidenceId = randomId('ev');
      const evidence = {
        evidence_id: evidenceId,
        claim_id: item.claim_id,
        source_id: item.source_id,
        source_hostname: item.source.hostname,
        stance: item.stance,
        quote: item.match.quote,
        quote_sha256: sha256(item.match.quote),
        source_text_sha256: item.source.text_sha256,
        match_start: item.match.start,
        match_end: item.match.end,
        exact_match: true,
        prompt_injection_suspected: item.source.prompt_injection_suspected,
        attached_by: actor,
        attached_at: nowIso(),
      };
      next.evidence[evidenceId] = evidence;
      next.claims[item.claim_id].evidence_ids.push(evidenceId);
      evidenceIds.push(evidenceId);
      emit('evidence.attached', actor, {
        evidence_id: evidenceId,
        claim_id: item.claim_id,
        source_id: item.source_id,
        stance: item.stance,
        quote_sha256: evidence.quote_sha256,
      });
    }
    return evidenceIds;
  });
  return { ok: true, run_id: runId, evidence_ids: result };
}

function validateVerdictItem(item, index) {
  rejectUnknownKeys(item, ['claim_id', 'verdict', 'rationale', 'evidence_ids'], `items[${index}]`);
  return {
    claim_id: identifier(item.claim_id, `items[${index}].claim_id`),
    verdict: enumValue(item.verdict, `items[${index}].verdict`, VERDICTS),
    rationale: stringValue(item.rationale, `items[${index}].rationale`, { min: 12, max: 4000 }),
    evidence_ids: uniqueStrings(item.evidence_ids ?? [], `items[${index}].evidence_ids`, { max: 30, itemMax: 64 }).map((id, idIndex) => identifier(id, `items[${index}].evidence_ids[${idIndex}]`)),
  };
}

export async function recordVerdicts(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'items'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, ['verifier'], 'pg_record_verdicts');
  const items = arrayValue(input.items, 'items', { min: 1, max: 50 }).map(validateVerdictItem);
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_record_verdicts' });
  const { result } = await withRunTransaction(dataDir, runId, (next, emit) => {
    const verdictIds = [];
    for (const item of items) {
      const claim = next.claims[item.claim_id];
      if (!claim) throw new StateError(`Unknown claim: ${item.claim_id}`);
      if (actor === claim.producer) throw new SecurityError('A claim producer cannot verify their own claim', { claim_id: item.claim_id });
      if (item.verdict !== 'insufficient' && item.evidence_ids.length === 0) {
        throw new ValidationError(`${item.verdict} verdict requires evidence_ids`);
      }
      for (const evidenceId of item.evidence_ids) {
        const evidence = next.evidence[evidenceId];
        if (!evidence || evidence.claim_id !== item.claim_id) {
          throw new ValidationError(`Evidence ${evidenceId} does not belong to claim ${item.claim_id}`);
        }
      }
      const verdictId = randomId('vd');
      const verdict = {
        verdict_id: verdictId,
        claim_id: item.claim_id,
        verdict: item.verdict,
        rationale: item.rationale,
        rationale_sha256: sha256(item.rationale),
        evidence_ids: item.evidence_ids,
        actor,
        declared_independent: true,
        created_at: nowIso(),
      };
      next.verdicts[verdictId] = verdict;
      claim.verdict_ids.push(verdictId);
      verdictIds.push(verdictId);
      emit('verdict.recorded', actor, {
        verdict_id: verdictId,
        claim_id: item.claim_id,
        verdict: item.verdict,
        evidence_ids: item.evidence_ids,
      });
    }
    return verdictIds;
  });
  return { ok: true, run_id: runId, verdict_ids: result };
}

export async function completeTask(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'task_id', 'outcome', 'summary'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  const taskId = identifier(input.task_id, 'task_id');
  const outcome = enumValue(input.outcome, 'outcome', TASK_OUTCOMES);
  const summary = stringValue(input.summary, 'summary', { min: 3, max: 4000 });
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_complete_task' });
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    const task = next.tasks[taskId];
    if (!task) throw new StateError(`Unknown task: ${taskId}`);
    const actorAllowed = actor === task.role || (actor === 'coordinator' && outcome !== 'success');
    if (!actorAllowed) {
      throw new SecurityError('Task completion actor does not match the planned role', {
        task_id: taskId,
        task_role: task.role,
        actor,
        outcome,
      });
    }
    if (task.status !== 'pending') {
      if (task.status === outcome && task.actor === actor) return;
      throw new StateError(`Task is already terminal: ${taskId}`);
    }
    task.status = outcome;
    task.actor = actor;
    task.summary = summary;
    task.completed_at = nowIso();
    emit('task.completed', actor, { task_id: taskId, outcome, summary_sha256: sha256(summary) });
  });
  return { ok: true, run_id: runId, task: state.tasks[taskId] };
}

function qualifyingEvidence(state, claim, stance) {
  return claim.evidence_ids
    .map((id) => state.evidence[id])
    .filter(Boolean)
    .filter((evidence) => evidence.stance === stance && evidence.exact_match === true)
    .filter((evidence) => !evidence.prompt_injection_suspected)
    .filter((evidence) => state.sources[evidence.source_id]?.text_sha256 === evidence.source_text_sha256);
}

function validVerdicts(state, claim, verdictName, stance) {
  return claim.verdict_ids
    .map((id) => state.verdicts[id])
    .filter(Boolean)
    .filter((verdict) => verdict.verdict === verdictName && verdict.actor !== claim.producer)
    .filter((verdict) => verdict.evidence_ids.some((id) => {
      const evidence = state.evidence[id];
      return evidence?.claim_id === claim.claim_id && evidence.stance === stance && evidence.exact_match && !evidence.prompt_injection_suspected;
    }));
}

async function assertStoredEvidenceIntegrity(dataDir, runId, state) {
  const sourceTexts = new Map();
  for (const source of Object.values(state.sources)) {
    const text = await readSourceContent(dataDir, runId, source.source_id);
    const actualHash = sha256(text);
    if (actualHash !== source.text_sha256) {
      throw new SecurityError('Stored source content hash mismatch during finalization', {
        source_id: source.source_id,
        expected: source.text_sha256,
        actual: actualHash,
      });
    }
    sourceTexts.set(source.source_id, text);
  }
  for (const evidence of Object.values(state.evidence)) {
    const source = state.sources[evidence.source_id];
    const text = sourceTexts.get(evidence.source_id);
    if (!source || text === undefined) {
      throw new SecurityError('Evidence references a missing source during finalization', { evidence_id: evidence.evidence_id });
    }
    const match = exactQuoteMatch(text, evidence.quote);
    if (!match || sha256(evidence.quote) !== evidence.quote_sha256 || source.text_sha256 !== evidence.source_text_sha256) {
      throw new SecurityError('Stored evidence failed exact-match integrity validation during finalization', {
        evidence_id: evidence.evidence_id,
        source_id: evidence.source_id,
      });
    }
  }
}

export function classifyClaims(state) {
  const classifications = {};
  for (const claim of Object.values(state.claims)) {
    const supportEvidence = qualifyingEvidence(state, claim, 'supports');
    const refuteEvidence = qualifyingEvidence(state, claim, 'refutes');
    const supportHosts = new Set(supportEvidence.map((evidence) => evidence.source_hostname));
    const refuteHosts = new Set(refuteEvidence.map((evidence) => evidence.source_hostname));
    const supportVerdicts = validVerdicts(state, claim, 'supported', 'supports');
    const refuteVerdicts = validVerdicts(state, claim, 'refuted', 'refutes');
    const supportQualified = supportHosts.size >= state.policy.min_sources_per_supported_claim && supportVerdicts.length > 0;
    const refuteQualified = refuteHosts.size >= state.policy.min_sources_per_refuted_claim && refuteVerdicts.length > 0;
    let classification = 'unverified';
    if (supportQualified && refuteQualified) classification = 'mixed';
    else if (supportQualified) classification = 'supported';
    else if (refuteQualified) classification = 'refuted';
    classifications[claim.claim_id] = {
      claim_id: claim.claim_id,
      classification,
      support_source_count: supportHosts.size,
      refute_source_count: refuteHosts.size,
      support_evidence_ids: supportEvidence.map((evidence) => evidence.evidence_id),
      refute_evidence_ids: refuteEvidence.map((evidence) => evidence.evidence_id),
      support_verdict_ids: supportVerdicts.map((verdict) => verdict.verdict_id),
      refute_verdict_ids: refuteVerdicts.map((verdict) => verdict.verdict_id),
      excluded_injection_evidence_ids: claim.evidence_ids.filter((id) => state.evidence[id]?.prompt_injection_suspected),
    };
  }
  return classifications;
}

function markdownEscape(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

export function buildReport(state, classifications, finalizedBy) {
  const tasks = Object.values(state.tasks);
  const taskCounts = Object.fromEntries(TASK_OUTCOMES.map((status) => [status, tasks.filter((task) => task.status === status).length]));
  taskCounts.pending = tasks.filter((task) => task.status === 'pending').length;
  const classCounts = { supported: 0, refuted: 0, mixed: 0, unverified: 0 };
  for (const result of Object.values(classifications)) classCounts[result.classification] += 1;
  const qualityGatePassed = taskCounts.failed === 0 && taskCounts.blocked === 0 && taskCounts.pending === 0 && classCounts.mixed === 0 && classCounts.unverified === 0;
  const report = {
    schema_version: 1,
    run_id: state.run_id,
    objective: state.objective,
    status: 'finalized',
    quality_gate_passed: qualityGatePassed,
    finalized_at: nowIso(),
    finalized_by: finalizedBy,
    task_counts: taskCounts,
    classification_counts: classCounts,
    claims: Object.values(state.claims).map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      importance: claim.importance,
      producer: claim.producer,
      ...classifications[claim.claim_id],
      evidence: claim.evidence_ids.map((id) => {
        const evidence = state.evidence[id];
        const source = evidence ? state.sources[evidence.source_id] : null;
        return evidence ? {
          evidence_id: evidence.evidence_id,
          stance: evidence.stance,
          source_id: evidence.source_id,
          source_url: source?.final_url,
          source_hostname: evidence.source_hostname,
          quote: evidence.quote,
          exact_match: evidence.exact_match,
          prompt_injection_suspected: evidence.prompt_injection_suspected,
        } : null;
      }).filter(Boolean),
      verdicts: claim.verdict_ids.map((id) => state.verdicts[id]).filter(Boolean),
    })),
    limitations: [
      'Verifier independence is declared by actor identity, not cryptographically attested.',
      'Source independence is counted by distinct hostname, not legal ownership or publisher identity.',
      'The event log is tamper-evident only while its head hash is trusted; it is not externally notarized.',
      'This plugin enforces MCP and tool-call budgets, not Claude model token or billing limits.',
    ],
  };
  const lines = [
    `# ProofGraph 검증 보고서`,
    ``,
    `- Run ID: \`${state.run_id}\``,
    `- 품질 게이트: **${qualityGatePassed ? 'PASS' : 'PARTIAL'}**`,
    `- 목표: ${markdownEscape(state.objective)}`,
    `- 작업: 성공 ${taskCounts.success}, 실패 ${taskCounts.failed}, 차단 ${taskCounts.blocked}, 미완료 ${taskCounts.pending}`,
    `- 주장: 지지 ${classCounts.supported}, 반박 ${classCounts.refuted}, 혼재 ${classCounts.mixed}, 미검증 ${classCounts.unverified}`,
    ``,
    `## 주장별 판정`,
    ``,
  ];
  for (const claim of report.claims) {
    lines.push(`### ${claim.claim_id} — ${claim.classification.toUpperCase()}`);
    lines.push(``);
    lines.push(markdownEscape(claim.text));
    lines.push(``);
    lines.push(`- 지지 출처 수: ${claim.support_source_count}`);
    lines.push(`- 반박 출처 수: ${claim.refute_source_count}`);
    if (!claim.evidence.length) lines.push(`- 검증 가능한 근거: 없음`);
    for (const evidence of claim.evidence) {
      lines.push(`- [${evidence.stance}] ${evidence.source_url ?? evidence.source_id}`);
      lines.push(`  - 인용: “${markdownEscape(evidence.quote).slice(0, 500)}”`);
      if (evidence.prompt_injection_suspected) lines.push(`  - 경고: 프롬프트 인젝션 의심 문구가 있어 자동 판정 근거에서 제외됨`);
    }
    lines.push(``);
  }
  lines.push(`## 제한사항`);
  lines.push(``);
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push(``);
  return { report, markdown: `${lines.join('\n')}\n` };
}

export async function finalizeRun(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, ['synthesizer'], 'pg_finalize_run');
  const dataDir = context.dataDir ?? resolveDataDir();
  await reserveBudget(dataDir, runId, { actor, operation: 'pg_finalize_run' });
  const { state } = await withRunTransaction(dataDir, runId, async (next, emit) => {
    if (next.status !== 'active') throw new StateError(`Run is not active: ${next.status}`);
    if (!next.plan_registered) throw new StateError('Cannot finalize without a registered plan');
    if (Object.keys(next.claims).length === 0) throw new StateError('Cannot finalize without claims');
    const pending = Object.values(next.tasks).filter((task) => task.status === 'pending');
    if (pending.length) throw new StateError('Cannot finalize while tasks are pending', { task_ids: pending.map((task) => task.task_id) });
    await assertStoredEvidenceIntegrity(dataDir, runId, next);
    const classifications = classifyClaims(next);
    const { report, markdown } = buildReport(next, classifications, actor);
    const hashes = await writeReportArtifacts(dataDir, runId, report, markdown);
    next.classifications = classifications;
    next.final = {
      ...report,
      report_json_sha256: hashes.json_sha256,
      report_markdown_sha256: hashes.markdown_sha256,
    };
    next.quality_gate_passed = report.quality_gate_passed;
    next.status = 'finalized';
    emit('run.finalized', actor, {
      quality_gate_passed: report.quality_gate_passed,
      classification_counts: report.classification_counts,
      report_json_sha256: hashes.json_sha256,
      report_markdown_sha256: hashes.markdown_sha256,
    });
  });
  await clearActiveRun(dataDir, state.project_key, runId);
  return {
    ok: true,
    run_id: runId,
    status: state.status,
    quality_gate_passed: state.quality_gate_passed,
    classification_counts: state.final.classification_counts,
  };
}

export async function getStatus(input, context = {}) {
  rejectUnknownKeys(input, ['run_id'], 'input');
  const runId = validateRunId(input.run_id);
  const dataDir = context.dataDir ?? resolveDataDir();
  const state = await readVerifiedRun(dataDir, runId);
  return {
    ok: true,
    run_id: runId,
    objective: state.objective,
    status: state.status,
    quality_gate_passed: state.quality_gate_passed,
    deadline_at: state.deadline_at,
    budget_exceeded_reason: state.budget_exceeded_reason,
    policy: state.policy,
    counters: state.counters,
    tasks: Object.values(state.tasks),
    claims: Object.values(state.claims).map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      importance: claim.importance,
      producer: claim.producer,
      evidence_ids: claim.evidence_ids,
      verdict_ids: claim.verdict_ids,
      classification: state.classifications[claim.claim_id]?.classification ?? null,
    })),
    sources: Object.values(state.sources).map((source) => ({
      source_id: source.source_id,
      final_url: source.final_url,
      hostname: source.hostname,
      text_sha256: source.text_sha256,
      prompt_injection_suspected: source.prompt_injection_suspected,
    })),
    event_head: state.event_head,
  };
}

export async function getReport(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'format'], 'input');
  const runId = validateRunId(input.run_id);
  const format = input.format === undefined ? 'markdown' : enumValue(input.format, 'format', ['markdown', 'json']);
  const dataDir = context.dataDir ?? resolveDataDir();
  const state = await readVerifiedRun(dataDir, runId);
  if (state.status !== 'finalized') throw new StateError(`Run is not finalized: ${state.status}`);
  const markdown = await readReport(dataDir, runId, 'md');
  const jsonText = await readReport(dataDir, runId, 'json');
  if (sha256(markdown) !== state.final.report_markdown_sha256 || sha256(jsonText) !== state.final.report_json_sha256) {
    throw new SecurityError('Final report artifact hash mismatch');
  }
  if (format === 'json') return { ok: true, run_id: runId, format, report: state.final };
  return { ok: true, run_id: runId, format, report: markdown };
}

export async function abortRun(input, context = {}) {
  rejectUnknownKeys(input, ['run_id', 'actor', 'reason'], 'input');
  const runId = validateRunId(input.run_id);
  const actor = identifier(input.actor, 'actor');
  requireActor(actor, ['coordinator'], 'pg_abort_run');
  const reason = stringValue(input.reason, 'reason', { min: 3, max: 1000 });
  const dataDir = context.dataDir ?? resolveDataDir();
  const { state } = await withRunTransaction(dataDir, runId, (next, emit) => {
    if (['finalized', 'aborted'].includes(next.status)) throw new StateError(`Run is already terminal: ${next.status}`);
    next.status = 'aborted';
    next.abort_reason = reason;
    emit('run.aborted', actor, { reason_sha256: sha256(reason) });
  });
  await clearActiveRun(dataDir, state.project_key, runId);
  return { ok: true, run_id: runId, status: 'aborted' };
}

export async function verifyIntegrity(input, context = {}) {
  rejectUnknownKeys(input, ['run_id'], 'input');
  const runId = validateRunId(input.run_id);
  const dataDir = context.dataDir ?? resolveDataDir();
  const state = await readRun(dataDir, runId);
  const checks = [];
  const chain = await verifyEventChain(dataDir, runId);
  checks.push({ check: 'event_chain', ok: chain.ok, details: chain });
  for (const source of Object.values(state.sources)) {
    try {
      const text = await readSourceContent(dataDir, runId, source.source_id);
      checks.push({
        check: `source:${source.source_id}`,
        ok: sha256(text) === source.text_sha256,
        expected: source.text_sha256,
        actual: sha256(text),
      });
    } catch (error) {
      checks.push({ check: `source:${source.source_id}`, ok: false, error: error.message });
    }
  }
  for (const evidence of Object.values(state.evidence)) {
    try {
      const text = await readSourceContent(dataDir, runId, evidence.source_id);
      const match = exactQuoteMatch(text, evidence.quote);
      checks.push({
        check: `evidence:${evidence.evidence_id}`,
        ok: Boolean(match) && sha256(evidence.quote) === evidence.quote_sha256 && sha256(text) === evidence.source_text_sha256,
      });
    } catch (error) {
      checks.push({ check: `evidence:${evidence.evidence_id}`, ok: false, error: error.message });
    }
  }
  if (state.status === 'finalized') {
    try {
      const markdown = await readReport(dataDir, runId, 'md');
      const jsonText = await readReport(dataDir, runId, 'json');
      checks.push({ check: 'report_markdown', ok: sha256(markdown) === state.final.report_markdown_sha256 });
      checks.push({ check: 'report_json', ok: sha256(jsonText) === state.final.report_json_sha256 });
      const recomputed = classifyClaims(state);
      checks.push({ check: 'classifications', ok: JSON.stringify(recomputed) === JSON.stringify(state.classifications) });
    } catch (error) {
      checks.push({ check: 'report_artifacts', ok: false, error: error.message });
    }
  }
  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    run_id: runId,
    checks,
    failed_checks: failed.map((check) => check.check),
    event_head: state.event_head,
    warning: 'Integrity hashes are locally recomputable and are not an external signature or notarization.',
  };
}

export async function activeRunForProject(context = {}) {
  const dataDir = context.dataDir ?? resolveDataDir();
  const projectDir = context.projectDir ?? resolveProjectDir();
  return readActiveRun(dataDir, projectKey(projectDir));
}

export const internals = {
  sourcePath,
};
