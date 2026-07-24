import {
  abortRun,
  activeRunForProject,
  attachEvidence,
  completeTask,
  fetchSource,
  finalizeRun,
  getReport,
  getStatus,
  importFixtureSource,
  recordVerdicts,
  registerClaims,
  registerPlan,
  searchSource,
  startRun,
  verifyIntegrity,
} from './workflow.mjs';
import { ValidationError } from './errors.mjs';

const ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_.:-]{0,63}$' };
const RUN_ID = { type: 'string', pattern: '^pg_[a-f0-9]{24}$' };
const ACTOR = { ...ID };

function objectSchema(properties, required = []) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const COMMON_OUTPUT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
};

const TOOLS = [
  {
    name: 'pg_start_run',
    title: 'Start a ProofGraph research run',
    description: 'Start one read-only evidence-gated research run for the current Claude Code project. Returns a run_id. Only one active run per project is permitted.',
    inputSchema: objectSchema({
      objective: { type: 'string', minLength: 10, maxLength: 10000 },
      policy: objectSchema({
        max_tool_calls: { type: 'integer', minimum: 10, maximum: 500 },
        max_source_fetches: { type: 'integer', minimum: 1, maximum: 100 },
        max_claims: { type: 'integer', minimum: 1, maximum: 100 },
        max_agents: { type: 'integer', minimum: 1, maximum: 20 },
        max_wall_time_seconds: { type: 'integer', minimum: 60, maximum: 14400 },
        min_sources_per_supported_claim: { type: 'integer', minimum: 1, maximum: 5 },
        min_sources_per_refuted_claim: { type: 'integer', minimum: 1, maximum: 5 },
        allowed_domains: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 253 } },
      }),
    }, ['objective']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_get_active_run',
    title: 'Get active ProofGraph run',
    description: 'Return the active ProofGraph run for the current project, if one exists.',
    inputSchema: objectSchema({}),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_register_plan',
    title: 'Register the research plan',
    description: 'Register a fixed task plan. It must include research-primary, research-secondary, and verifier roles.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      tasks: {
        type: 'array', minItems: 3, maxItems: 12,
        items: objectSchema({
          task_id: ID,
          title: { type: 'string', minLength: 3, maxLength: 300 },
          role: { type: 'string', enum: ['research-primary', 'research-secondary', 'verifier'] },
        }, ['task_id', 'title', 'role']),
      },
    }, ['run_id', 'actor', 'tasks']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_register_claims',
    title: 'Register auditable claims',
    description: 'Register atomic, falsifiable claims before collecting evidence. Claims cannot be silently added during final synthesis.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      claims: {
        type: 'array', minItems: 1, maxItems: 50,
        items: objectSchema({
          claim_id: ID,
          text: { type: 'string', minLength: 8, maxLength: 2000 },
          importance: { type: 'string', enum: ['high', 'medium', 'low'] },
        }, ['claim_id', 'text']),
      },
    }, ['run_id', 'actor', 'claims']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_fetch_source',
    title: 'Fetch and hash a public source',
    description: 'Fetch an HTTPS public source through SSRF defenses, strip active HTML, flag prompt-injection text, and persist a content hash. Only server-fetched sources can qualify as evidence.',
    inputSchema: objectSchema({ run_id: RUN_ID, actor: ACTOR, url: { type: 'string', minLength: 8, maxLength: 2048 } }, ['run_id', 'actor', 'url']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'pg_search_source',
    title: 'Search a stored source',
    description: 'Search normalized text from a previously fetched source and return bounded context windows.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      source_id: ID,
      query: { type: 'string', minLength: 2, maxLength: 1000 },
      max_matches: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['run_id', 'actor', 'source_id', 'query']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_attach_evidence',
    title: 'Attach exact-match evidence',
    description: 'Attach quotations to claims only when each normalized quote is an exact substring of a stored, hash-verified source.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      items: {
        type: 'array', minItems: 1, maxItems: 20,
        items: objectSchema({
          claim_id: ID,
          source_id: ID,
          quote: { type: 'string', minLength: 12, maxLength: 5000 },
          stance: { type: 'string', enum: ['supports', 'refutes', 'context'] },
        }, ['claim_id', 'source_id', 'quote', 'stance']),
      },
    }, ['run_id', 'actor', 'items']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_record_verdicts',
    title: 'Record independent verdicts',
    description: 'Record verifier verdicts. The declared verifier actor must differ from the claim producer, and non-insufficient verdicts require attached evidence.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      items: {
        type: 'array', minItems: 1, maxItems: 50,
        items: objectSchema({
          claim_id: ID,
          verdict: { type: 'string', enum: ['supported', 'refuted', 'insufficient', 'mixed'] },
          rationale: { type: 'string', minLength: 12, maxLength: 4000 },
          evidence_ids: { type: 'array', maxItems: 30, uniqueItems: true, items: ID },
        }, ['claim_id', 'verdict', 'rationale', 'evidence_ids']),
      },
    }, ['run_id', 'actor', 'items']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_complete_task',
    title: 'Complete a planned task',
    description: 'Mark a planned task success, failed, or blocked. Failures remain visible and cannot be filtered out.',
    inputSchema: objectSchema({
      run_id: RUN_ID,
      actor: ACTOR,
      task_id: ID,
      outcome: { type: 'string', enum: ['success', 'failed', 'blocked'] },
      summary: { type: 'string', minLength: 3, maxLength: 4000 },
    }, ['run_id', 'actor', 'task_id', 'outcome', 'summary']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_finalize_run',
    title: 'Finalize and classify claims',
    description: 'Deterministically classify claims from stored exact-match evidence and independent verdicts, then generate JSON and Markdown reports. The model cannot directly choose final classifications.',
    inputSchema: objectSchema({ run_id: RUN_ID, actor: ACTOR }, ['run_id', 'actor']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pg_get_status',
    title: 'Inspect run status',
    description: 'Return current tasks, claims, sources, counters, budget state, and classification status.',
    inputSchema: objectSchema({ run_id: RUN_ID }, ['run_id']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_get_report',
    title: 'Get finalized report',
    description: 'Return the server-generated final report in Markdown or JSON. Available only after finalization.',
    inputSchema: objectSchema({ run_id: RUN_ID, format: { type: 'string', enum: ['markdown', 'json'] } }, ['run_id']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_verify_integrity',
    title: 'Verify local run integrity',
    description: 'Recompute the event hash chain, source hashes, exact evidence matches, report hashes, and final classifications. This is local tamper evidence, not external notarization.',
    inputSchema: objectSchema({ run_id: RUN_ID }, ['run_id']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pg_abort_run',
    title: 'Abort a run',
    description: 'Terminate an active or budget-exceeded run and release the project guardrail.',
    inputSchema: objectSchema({ run_id: RUN_ID, actor: ACTOR, reason: { type: 'string', minLength: 3, maxLength: 1000 } }, ['run_id', 'actor', 'reason']),
    outputSchema: COMMON_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

const TEST_TOOL = {
  name: 'pg_test_import_source',
  title: 'Import deterministic test source',
  description: 'TEST MODE ONLY. Import a deterministic HTTPS fixture without network access.',
  inputSchema: objectSchema({
    run_id: RUN_ID,
    actor: ACTOR,
    url: { type: 'string', minLength: 8, maxLength: 2048 },
    content: { type: 'string', minLength: 20, maxLength: 200000 },
    prompt_injection_suspected: { type: 'boolean' },
  }, ['run_id', 'actor', 'url', 'content']),
  outputSchema: COMMON_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const HANDLERS = {
  pg_start_run: startRun,
  pg_get_active_run: async (_input, context) => ({ ok: true, active: await activeRunForProject(context) }),
  pg_register_plan: registerPlan,
  pg_register_claims: registerClaims,
  pg_fetch_source: fetchSource,
  pg_search_source: searchSource,
  pg_attach_evidence: attachEvidence,
  pg_record_verdicts: recordVerdicts,
  pg_complete_task: completeTask,
  pg_finalize_run: finalizeRun,
  pg_get_status: getStatus,
  pg_get_report: getReport,
  pg_verify_integrity: verifyIntegrity,
  pg_abort_run: abortRun,
};

export function listTools({ testMode = process.env.PROOFGRAPH_TEST_MODE === '1' } = {}) {
  return testMode ? [...TOOLS, TEST_TOOL] : [...TOOLS];
}

export async function invokeTool(name, args = {}, context = {}) {
  if (name === 'pg_test_import_source') {
    if (process.env.PROOFGRAPH_TEST_MODE !== '1' && context.testMode !== true) throw new ValidationError('Unknown tool');
    return importFixtureSource(args, { ...context, testMode: true });
  }
  const handler = HANDLERS[name];
  if (!handler) throw new ValidationError(`Unknown tool: ${name}`);
  return handler(args ?? {}, context);
}
